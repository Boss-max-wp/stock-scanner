// 勝率診斷：為什麼勝率下降？哪些條件能提高勝率？
// 在 GitHub Actions 上跑（.github/workflows/analyze.yml），結果寫到 research/results/analysis.md / analysis.json
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const S = require('../scan.js');
const H = S.HORIZON;

const mean = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : 0;
const pct = v => (v * 100).toFixed(0) + '%';
const Rf = v => (v >= 0 ? '+' : '') + v.toFixed(2) + 'R';

// 依同樣規則模擬一筆交易：碰停損（同日兩者都碰算停損）→ 停損；碰目標 → 達標；都沒碰 → 第 hz 天收盤
function sim(b, s, dir, entry, stop, target, hz, opt = {}) {
  const L = dir === 'long', sg = L ? 1 : -1, risk = Math.abs(entry - stop) / entry;
  if (!(risk > 0) || !b[s + hz]) return null;
  let st = stop;
  for (let k = 1; k <= hz; k++) {
    const x = b[s + k];
    const hitS = L ? x.l <= st : x.h >= st;
    const hitT = target && (L ? x.h >= target : x.l <= target);
    if (hitS) return { st: st === stop ? 'stop' : 'be', R: sg * (st / entry - 1) / risk };
    if (hitT) return { st: 'target', R: sg * (target / entry - 1) / risk };
    if (opt.be && (L ? x.h >= entry * (1 + risk * opt.be) : x.l <= entry * (1 - risk * opt.be))) st = entry;   // 賺到 be 倍風險後停損移到成本
  }
  return { st: 'expire', R: sg * (b[s + hz].c / entry - 1) / risk };
}

(async () => {
  const t0 = Date.now();
  const prev = await S.loadPrev().catch(() => null);
  const params = { ...S.DEFAULTS, ...((prev && prev.params) || S.DEFAULT_PARAMS) };
  const { D, names } = await S.loadData();
  S.cleanD(D, Object.keys(names));
  console.log('stocks', Object.keys(D).length, 'plugins', S.PLUGINS.map(p => p.key).join(','));

  // ---- 大盤（500 檔等權指數）與市場寬度 ----
  const byDate = {};
  for (const b of Object.values(D)) {
    let s20 = 0;
    for (let i = 0; i < b.length; i++) {
      s20 += b[i].c; if (i >= 20) s20 -= b[i - 20].c;
      const o = byDate[b[i].d] = byDate[b[i].d] || { r: [], up: 0, n: 0 };
      if (i >= 1) o.r.push(Math.max(-0.11, Math.min(0.11, b[i].c / b[i - 1].c - 1)));
      if (i >= 19) { o.n++; if (b[i].c > s20 / 20) o.up++; }
    }
  }
  const dates = Object.keys(byDate).filter(d => byDate[d].r.length > 50).sort();
  const M = {}; let lvl = 100; const lv = [];
  dates.forEach((d, i) => {
    lvl *= 1 + mean(byDate[d].r); lv.push(lvl);
    const ma = n => i >= n - 1 ? mean(lv.slice(i - n + 1, i + 1)) : NaN;
    M[d] = { lvl, ma20: ma(20), ma60: ma(60), ret5: i >= 5 ? lvl / lv[i - 5] - 1 : 0, ret20: i >= 20 ? lvl / lv[i - 20] - 1 : 0, breadth: byDate[d].n ? byDate[d].up / byDate[d].n : 0.5 };
  });

  // ---- 所有歷史訊號 + 特徵 + 不同出場方式的結果 ----
  const sig = [];
  for (const [id, b] of Object.entries(D)) {
    const C = b.map(x => x.c), V = b.map(x => x.v);
    const sma = (arr, e, n) => { let t = 0; for (let i = e - n + 1; i <= e; i++) t += arr[i]; return t / n; };
    for (let s = 80; s <= b.length - 1 - H; s++) {
      const xs = S.signalsOnDay(b, s, params);
      if (!xs.length) continue;
      const ma20 = sma(C, s, 20), ma60 = sma(C, s, 60), ma20p = sma(C, s - 5, 20);
      const rets = []; for (let i = s - 19; i <= s; i++) rets.push(C[i] / C[i - 1] - 1);
      const vol = Math.sqrt(mean(rets.map(r => r * r)));
      const val20 = sma(C.map((c, i) => c * V[i]), s, 20) / 1e5;   // 20 日均成交金額（億）
      const m = M[b[s].d] || {};
      for (const x of xs) {
        const L = x.dir === 'long', sg = L ? 1 : -1;
        const risk = Math.abs(x.entry - x.stop) / x.entry;
        if (!(risk > 0)) continue;
        const base = S.evaluate({ dir: x.dir, entry: x.entry, stop: x.stop, target: x.target }, b, s);
        if (base.st === 'open' || base.st === 'unknown') continue;
        const ok = {}; for (const c of x.checks || []) ok[c.k.replace('雙重頂', '雙重底').replace('收在低檔', '收在高檔').replace('黑K吞噬', '紅K吞噬')] = !!c.ok;
        const T = k => x.entry * (1 + sg * risk * k);
        const nx = b[s + 1];
        const alt = {
          base: { st: base.st, R: base.ret / risk },
          t1: sim(b, s, x.dir, x.entry, x.stop, T(1), H),
          t15: sim(b, s, x.dir, x.entry, x.stop, T(1.5), H),
          t2: sim(b, s, x.dir, x.entry, x.stop, T(2), H),
          be1: sim(b, s, x.dir, x.entry, x.stop, x.target, H, { be: 1 }),
          h20: sim(b, s, x.dir, x.entry, x.stop, x.target, 20),
          // 隔天開盤才進場（開盤已經跳過停損或目標就不進）
          nextOpen: nx && (L ? nx.o > x.stop && (!x.target || nx.o < x.target) : nx.o < x.stop && (!x.target || nx.o > x.target))
            ? sim(b, s + 1, x.dir, nx.o, x.stop, x.target, H - 1) : null,
        };
        sig.push({
          id, d: b[s].d, type: x.type, dir: x.dir, score: x.score, vr: x.volRatio || 0, body: Math.abs(x.body || 0), risk: risk * 100, rr: x.rr || 0, ok,
          trend60: sg * (C[s] / ma60 - 1) * 100, ma20slope: sg * (ma20 / ma20p - 1) * 100, ext20: sg * (C[s] / ma20 - 1) * 100,
          ret60: sg * (C[s] / C[s - 60] - 1) * 100, vol: vol * 100, val20, price: C[s],
          mTrend: m.ma20 ? sg * (m.lvl / m.ma20 - 1) * 100 : 0, mTrend60: m.ma60 ? sg * (m.lvl / m.ma60 - 1) * 100 : 0,
          mRet5: sg * (m.ret5 || 0) * 100, mRet20: sg * (m.ret20 || 0) * 100, breadth: L ? m.breadth : 1 - m.breadth,
          alt,
        });
      }
    }
  }
  sig.sort((a, b) => a.d < b.d ? -1 : 1);
  console.log('signals', sig.length, ((Date.now() - t0) / 1000).toFixed(0) + 's');
  const cut = sig[Math.floor(sig.length * 0.6)].d;             // 前 60% 訓練、後 40% 驗證
  const train = sig.filter(x => x.d < cut), test = sig.filter(x => x.d >= cut);
  const st = (list, k = 'base') => {
    const r = list.map(x => x.alt[k]).filter(Boolean);
    return { n: r.length, win: mean(r.map(x => x.st === 'target' ? 1 : 0)), pos: mean(r.map(x => x.R > 0 ? 1 : 0)), stop: mean(r.map(x => x.st === 'stop' ? 1 : 0)), R: mean(r.map(x => x.R)) };
  };
  const row = (label, list, k) => { const a = st(list, k); return `| ${label} | ${a.n} | ${pct(a.win)} | ${pct(a.pos)} | ${pct(a.stop)} | ${Rf(a.R)} |`; };
  const HDR = '| | 筆數 | 達標率 | 賺錢比例 | 停損率 | 平均 |\n|---|---|---|---|---|---|';
  const out = { cut, n: sig.length };
  let md = `# 勝率診斷 ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')}\n\n`;
  md += `資料 ${sig[0].d} ～ ${sig[sig.length - 1].d}，${Object.keys(D).length} 檔，${sig.length} 筆已結束的訊號（追蹤 ${H} 個交易日）。訓練：${cut} 以前；驗證：${cut} 以後。\n`;
  md += `「達標率」＝先碰到目標價的比例（成績單上的勝率）；「賺錢比例」＝出場時是賺的；R＝停損距離。\n\n`;

  // 1. 實際推送的紀錄（live）隨時間的變化
  if (prev && prev.records) {
    const ev = prev.records.map(r => {
      const b = D[r.id]; const i = b ? b.findIndex(x => x.d === r.d) : -1;
      const e = b ? S.evaluate(r, b, i) : { st: 'unknown' };
      const risk = Math.abs(r.entry - r.stop) / r.entry;
      return { ...r, st: e.st, R: risk > 0 && e.ret != null ? e.ret / risk : null };
    }).filter(r => ['target', 'stop', 'expire'].includes(r.st));
    const wk = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - (t.getUTCDay() + 6) % 7); return t.toISOString().slice(0, 10); };
    const g = {}; for (const r of ev) (g[wk(r.d)] = g[wk(r.d)] || []).push(r);
    md += `## 1. 選股器實際紀錄（每週，依訊號日期）\n\n| 週 | 筆數 | 達標率 | 停損率 | 平均 | 做多/做空 |\n|---|---|---|---|---|---|\n`;
    for (const [w, l] of Object.entries(g).sort()) md += `| ${w} | ${l.length} | ${pct(mean(l.map(x => x.st === 'target' ? 1 : 0)))} | ${pct(mean(l.map(x => x.st === 'stop' ? 1 : 0)))} | ${Rf(mean(l.filter(x => x.R != null).map(x => x.R)))} | ${l.filter(x => x.dir === 'long').length}/${l.filter(x => x.dir === 'short').length} |\n`;
    const gt = {}; for (const r of ev) (gt[`${r.type}|${r.dir}`] = gt[`${r.type}|${r.dir}`] || []).push(r);
    md += `\n| 型態 | 筆數 | 達標率 | 停損率 | 平均 |\n|---|---|---|---|---|\n`;
    for (const [k, l] of Object.entries(gt).sort((a, b) => b[1].length - a[1].length)) md += `| ${k} | ${l.length} | ${pct(mean(l.map(x => x.st === 'target' ? 1 : 0)))} | ${pct(mean(l.map(x => x.st === 'stop' ? 1 : 0)))} | ${Rf(mean(l.filter(x => x.R != null).map(x => x.R)))} |\n`;
    out.live = { n: ev.length };
    md += '\n';
  }

  // 2. 回測：每月 + 大盤
  const mon = {}; for (const x of sig) (mon[x.d.slice(0, 7)] = mon[x.d.slice(0, 7)] || []).push(x);
  md += `## 2. 回測每月表現 vs 大盤（500 檔等權指數當月漲跌）\n\n| 月 | 筆數 | 達標率 | 停損率 | 平均 | 做多平均 | 做空平均 | 大盤 |\n|---|---|---|---|---|---|---|---|\n`;
  for (const [m, l] of Object.entries(mon).sort()) {
    const ds = dates.filter(d => d.startsWith(m)); const mr = ds.length ? M[ds[ds.length - 1]].lvl / (M[dates[dates.indexOf(ds[0]) - 1]] || M[ds[0]]).lvl - 1 : 0;
    const a = st(l), al = st(l.filter(x => x.dir === 'long')), as = st(l.filter(x => x.dir === 'short'));
    md += `| ${m} | ${a.n} | ${pct(a.win)} | ${pct(a.stop)} | ${Rf(a.R)} | ${Rf(al.R)} (${al.n}) | ${Rf(as.R)} (${as.n}) | ${(mr * 100).toFixed(1)}% |\n`;
  }

  // 3. 各型態
  const types = {}; for (const x of sig) (types[`${x.type}|${x.dir}`] = types[`${x.type}|${x.dir}`] || []).push(x);
  md += `\n## 3. 各型態（訓練 → 驗證）\n\n| 型態 | 訓練筆數 | 訓練達標 | 訓練平均 | 驗證筆數 | 驗證達標 | 驗證平均 |\n|---|---|---|---|---|---|---|\n`;
  for (const [k, l] of Object.entries(types).sort((a, b) => b[1].length - a[1].length)) {
    const a = st(l.filter(x => x.d < cut)), b2 = st(l.filter(x => x.d >= cut));
    md += `| ${k} | ${a.n} | ${pct(a.win)} | ${Rf(a.R)} | ${b2.n} | ${pct(b2.win)} | ${Rf(b2.R)} |\n`;
  }

  // 4. 單一條件分組
  const q = (key, list) => { const v = list.map(x => x[key]).filter(isFinite).sort((a, b) => a - b); return [0.25, 0.5, 0.75].map(p => v[Math.floor(v.length * p)]); };
  const feats = [
    ['score', '分數'], ['vr', '量比'], ['body', 'K棒實體%'], ['risk', '停損距離%'], ['rr', '風報比'],
    ['trend60', '個股離季線%(順勢為正)'], ['ma20slope', '月線斜率%(順勢為正)'], ['ext20', '離月線%(順勢為正)'], ['ret60', '近60日漲跌%(順勢為正)'],
    ['vol', '日波動%'], ['val20', '20日均成交額(億)'], ['price', '股價'],
    ['mTrend', '大盤離月線%(順勢為正)'], ['mTrend60', '大盤離季線%(順勢為正)'], ['mRet5', '大盤5日%(順勢為正)'], ['mRet20', '大盤20日%(順勢為正)'], ['breadth', '市場寬度(順勢)'],
  ];
  md += `\n## 4. 單一條件：四等分（訓練期切點；顯示 訓練／驗證）\n\n`;
  out.feat = {};
  for (const [k, label] of feats) {
    const cuts = q(k, train);
    const bin = v => v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : 3;
    md += `**${label}**（切點 ${cuts.map(c => +c.toFixed(2)).join(' / ')}）\n\n| 組 | 訓練筆數 | 訓練達標 | 訓練平均 | 驗證筆數 | 驗證達標 | 驗證平均 |\n|---|---|---|---|---|---|---|\n`;
    out.feat[k] = { cuts, bins: [] };
    for (let i = 0; i < 4; i++) {
      const a = st(train.filter(x => bin(x[k]) === i)), b2 = st(test.filter(x => bin(x[k]) === i));
      out.feat[k].bins.push({ a, b: b2 });
      md += `| ${['最低', '偏低', '偏高', '最高'][i]} | ${a.n} | ${pct(a.win)} | ${Rf(a.R)} | ${b2.n} | ${pct(b2.win)} | ${Rf(b2.R)} |\n`;
    }
    md += '\n';
  }
  const okKeys = [...new Set(sig.flatMap(x => Object.keys(x.ok)))];
  md += `**檢查項目有沒有符合**\n\n| 項目 | 符合：訓練達標/平均 | 不符合：訓練達標/平均 | 符合：驗證達標/平均 | 不符合：驗證達標/平均 |\n|---|---|---|---|---|\n`;
  for (const k of okKeys) {
    const f = (l, v) => { const a = st(l.filter(x => k in x.ok && x.ok[k] === v)); return `${pct(a.win)} / ${Rf(a.R)} (${a.n})`; };
    md += `| ${k} | ${f(train, true)} | ${f(train, false)} | ${f(test, true)} | ${f(test, false)} |\n`;
  }

  // 5. 出場方式
  const alts = [['base', '現在：原目標、10 天'], ['t1', '目標＝1 倍停損距離'], ['t15', '目標＝1.5 倍'], ['t2', '目標＝2 倍'], ['be1', '賺 1 倍後停損移到成本'], ['h20', '原目標、追蹤 20 天'], ['nextOpen', '隔天開盤才進場']];
  md += `\n## 5. 不同出場／進場方式（全部訊號）\n\n| 方式 | 訓練達標 | 訓練賺錢比例 | 訓練平均 | 驗證達標 | 驗證賺錢比例 | 驗證平均 |\n|---|---|---|---|---|---|---|\n`;
  out.alts = {};
  for (const [k, label] of alts) { const a = st(train, k), b2 = st(test, k); out.alts[k] = { a, b: b2 }; md += `| ${label} | ${pct(a.win)} | ${pct(a.pos)} | ${Rf(a.R)} | ${pct(b2.win)} | ${pct(b2.pos)} | ${Rf(b2.R)} |\n`; }

  // 6. 規則搜尋：只用訓練期挑條件，驗證期檢查
  const F = [];
  for (const [k, label] of feats) { const c = q(k, train); for (let i = 0; i < 3; i++) { F.push({ name: `${label} > ${+c[i].toFixed(2)}`, f: x => x[k] > c[i] }); F.push({ name: `${label} ≤ ${+c[i].toFixed(2)}`, f: x => x[k] <= c[i] }); } }
  for (const [k] of [['mTrend'], ['mTrend60'], ['trend60'], ['ma20slope']]) F.push({ name: `${feats.find(f => f[0] === k)[1]} > 0`, f: x => x[k] > 0 });
  for (const k of okKeys) F.push({ name: `符合「${k}」`, f: x => x.ok[k] === true || !(k in x.ok) });
  F.push({ name: '只做多', f: x => x.dir === 'long' });
  for (const t of Object.keys(types)) F.push({ name: `排除 ${t}`, f: x => `${x.type}|${x.dir}` !== t });
  const search = (objective, alt, minKeep) => {
    let cur = train, chosen = [];
    const base = st(train, alt);
    for (let step = 0; step < 3; step++) {
      let best = null;
      for (const c of F) {
        if (chosen.includes(c)) continue;
        const l = cur.filter(c.f), a = st(l, alt);
        if (a.n < train.length * minKeep || a.R < base.R) continue;
        const sc = objective(a);
        if (!best || sc > best.sc) best = { c, sc, l };
      }
      if (!best || best.sc <= objective(st(cur, alt)) + 0.005) break;
      chosen.push(best.c); cur = best.l;
    }
    const fx = x => chosen.every(c => c.f(x));
    return { rules: chosen.map(c => c.name), alt, train: st(train.filter(fx), alt), test: st(test.filter(fx), alt), testAll: st(test, alt), fx };
  };
  const plans = [];
  for (const [alt] of alts.filter(a => a[0] !== 'nextOpen' && a[0] !== 'h20')) {
    plans.push({ goal: '提高達標率', ...search(a => a.win, alt, 0.3) });
    plans.push({ goal: '提高賺錢比例', ...search(a => a.pos, alt, 0.3) });
    plans.push({ goal: '提高平均報酬', ...search(a => a.R, alt, 0.3) });
  }
  md += `\n## 6. 自動找出的過濾規則（訓練期挑，驗證期檢查；最多 3 條、至少保留 30% 訊號、平均報酬不能變差）\n\n| 目標 | 出場 | 規則 | 訓練筆數 | 訓練達標 | 訓練賺錢 | 訓練平均 | 驗證筆數 | 驗證達標 | 驗證賺錢 | 驗證平均 | 驗證期不過濾 |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const p of plans) md += `| ${p.goal} | ${alts.find(a => a[0] === p.alt)[1]} | ${p.rules.join('；') || '（無）'} | ${p.train.n} | ${pct(p.train.win)} | ${pct(p.train.pos)} | ${Rf(p.train.R)} | ${p.test.n} | ${pct(p.test.win)} | ${pct(p.test.pos)} | ${Rf(p.test.R)} | ${pct(p.testAll.win)} / ${Rf(p.testAll.R)} |\n`;
  out.plans = plans.map(({ fx, ...p }) => p);

  // 7. 最近 3 個月：哪裡變差
  const rc = sig.filter(x => x.d >= new Date(Date.parse(sig[sig.length - 1].d) - 90 * 864e5).toISOString().slice(0, 10));
  md += `\n## 7. 最近 3 個月 vs 之前\n\n${HDR}\n${row('之前', sig.filter(x => !rc.includes(x)))}\n${row('最近 3 個月', rc)}\n${row('最近 3 個月・做多', rc.filter(x => x.dir === 'long'))}\n${row('最近 3 個月・做空', rc.filter(x => x.dir === 'short'))}\n`;

  // 8. 深入檢查
  {
    const cR = q('risk', train)[1], cRR = q('rr', train)[1];
    const A = x => x.dir === 'long' && x.risk > cR && x.rr <= cRR;
    md += `\n## 8. 深入檢查\n\n規則 A＝只做多、停損距離 > ${cR.toFixed(2)}%、風報比 ≤ ${cRR.toFixed(2)}\n\n${HDR}\n`;
    const L = sig.filter(x => x.dir === 'long');
    md += [
      row('全部（訓練）', train), row('全部（驗證）', test),
      row('只做多（訓練）', train.filter(x => x.dir === 'long')), row('只做多（驗證）', test.filter(x => x.dir === 'long')),
      row(`只做多＋停損距離>${cR.toFixed(1)}%（驗證）`, test.filter(x => x.dir === 'long' && x.risk > cR)),
      row(`只做多＋風報比≤${cRR.toFixed(2)}（驗證）`, test.filter(x => x.dir === 'long' && x.rr <= cRR)),
      row('規則 A（訓練）', train.filter(A)), row('規則 A（驗證）', test.filter(A)),
      row('規則 A＋大盤在季線上（驗證）', test.filter(x => A(x) && x.mTrend60 > 0)),
      row('規則 A＋大盤在季線下（驗證）', test.filter(x => A(x) && x.mTrend60 <= 0)),
      row('只做多・大盤在季線上（全期）', L.filter(x => x.mTrend60 > 0)), row('只做多・大盤在季線下（全期）', L.filter(x => x.mTrend60 <= 0)),
      row('只做多・大盤20日漲幅≤1.2%（全期）', L.filter(x => x.mRet20 <= 1.2)), row('只做多・大盤20日漲幅>1.2%（全期）', L.filter(x => x.mRet20 > 1.2)),
      row('做空・大盤在季線下（全期）', sig.filter(x => x.dir === 'short' && x.mTrend60 > 0)), row('做空・大盤在季線上（全期）', sig.filter(x => x.dir === 'short' && x.mTrend60 <= 0)),
      row('做空・大盤20日跌>4%（全期）', sig.filter(x => x.dir === 'short' && x.mRet20 > 4)),
    ].join('\n') + '\n';
    md += `\n**規則 A 各型態（全期）**\n\n${HDR}\n` + Object.keys(types).filter(t => t.endsWith('long')).map(t => row(t, sig.filter(x => A(x) && `${x.type}|${x.dir}` === t))).join('\n') + '\n';
    md += `\n**每月：全部做多 vs 規則 A**\n\n| 月 | 做多筆數 | 做多達標 | 做多平均 | A 筆數 | A 達標 | A 平均 |\n|---|---|---|---|---|---|---|\n`;
    for (const [m, l] of Object.entries(mon).sort()) { const a = st(l.filter(x => x.dir === 'long')), b2 = st(l.filter(A)); md += `| ${m} | ${a.n} | ${pct(a.win)} | ${Rf(a.R)} | ${b2.n} | ${pct(b2.win)} | ${Rf(b2.R)} |\n`; }
    const sc = {}; for (const x of L) { const k = Math.min(9, Math.floor(x.score / 10)); (sc[k] = sc[k] || []).push(x); }
    md += `\n**分數 vs 結果（只做多）**\n\n${HDR}\n` + Object.keys(sc).sort().map(k => row(`${k * 10}～${k * 10 + 9}`, sc[k])).join('\n') + '\n';
    out.ruleA = { cR, cRR, train: st(train.filter(A)), test: st(test.filter(A)) };
  }
  // 9. 實際紀錄：還沒結束的比例（最近幾週只算到已結束的，會偏向停損）
  if (prev && prev.records) {
    const g = {};
    for (const r of prev.records) {
      const b = D[r.id]; const i = b ? b.findIndex(x => x.d === r.d) : -1; const e = b ? S.evaluate(r, b, i) : { st: 'unknown' };
      const t = new Date(r.d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - (t.getUTCDay() + 6) % 7); const w = t.toISOString().slice(0, 10);
      const o = g[w] = g[w] || { target: 0, stop: 0, expire: 0, open: 0, unknown: 0, ret: [] }; o[e.st] = (o[e.st] || 0) + 1;
      if (e.st === 'open') o.ret.push(e.ret);
    }
    md += `\n## 9. 實際紀錄：每週還沒結束的筆數\n\n| 週 | 達標 | 停損 | 到期 | 進行中 | 進行中平均報酬 |\n|---|---|---|---|---|---|\n`;
    for (const [w, o] of Object.entries(g).sort()) md += `| ${w} | ${o.target} | ${o.stop} | ${o.expire} | ${o.open} | ${o.ret.length ? (mean(o.ret) * 100).toFixed(1) + '%' : ''} |\n`;
  }
  fs.mkdirSync('research/results', { recursive: true });
  fs.writeFileSync('research/results/analysis.md', md);
  fs.writeFileSync('research/results/analysis.json', JSON.stringify(out, null, 1));
  console.log(md.slice(0, 3000));
  console.log('done', ((Date.now() - t0) / 1000).toFixed(0) + 's');
})().catch(e => { console.error(e); process.exit(1); });
