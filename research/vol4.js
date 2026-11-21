// 使用者三條量能規則研究（2026-11-22）；架構同 vdiv.js：第一個高點帶量，第二個高點更高但沒量 → 做空？
// 在 GitHub Actions 上跑：勝率診斷 workflow，script = vdiv。結果寫到 research/results/vol4.md
// 資料：先試 Bybit 永續；被擋就用 Binance 現貨（data-api.binance.vision）1 小時K，自己合成 4 小時、日線
// 成本：手續費 0.055% ＋ 滑價 0.05%（每邊）；另外再給「每筆扣 0.2R」的保守版
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const DESIGN = ['ETH', 'UNI', 'ETC', 'SOL', 'XMR', 'AAVE', 'BTC', 'LTC', 'CRV', 'DOT', 'ADA', 'TRX', 'XLM', 'HBAR', 'BNB', 'ZEC', 'LINK', 'NEAR', 'DOGE', 'ATOM', 'XRP', 'BCH', 'ICP', 'FIL', 'AVAX'];
const VALID = ['SUI', 'INJ', 'APT', 'ARB', 'OP', 'QNT', 'DASH', 'SHIB', 'GALA', 'STX', 'ALGO', 'SAND', 'BLUR', 'LDO', 'AR', 'APE', 'ZIL', 'ORDI', 'EGLD', 'COTI', 'DYDX', 'AXS', 'KAVA', 'JASMY', 'BICO', 'WAVES', 'THETA', 'CVX'];
const START = Date.UTC(2021, 0, 1), H = 36e5;
const COST = 0.00105; // 每邊
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(url); if (r.status === 403 || r.status === 451) return { blocked: r.status }; if (!r.ok) throw new Error(r.status); return await r.json(); }
    catch (e) { await sleep(1000 * (a + 1)); }
  }
  return null;
}
let SRC = null, PATH_STEP = 1;
async function fetch1h(coin) {
  const cache = `.cache/vdiv_${coin}.json`;
  if (fs.existsSync(cache)) { const c = JSON.parse(fs.readFileSync(cache)); if (c.bars.length && Date.now() - c.at < 6 * H) return c.bars; }
  const out = new Map(); const now = Date.now();
  if (SRC === 'bybit') {
    const sym = coin === 'SHIB' ? 'SHIB1000USDT' : coin + 'USDT';
    for (let end = now; end > START;) {
      const j = await getJSON(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=60&end=${end}&limit=1000`);
      const L = j && j.result && j.result.list; if (!L || !L.length) break;
      for (const x of L) out.set(+x[0], { t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6] });
      const mn = Math.min(...L.map(x => +x[0])); if (mn >= end) break; end = mn - 1; await sleep(60);
    }
  } else {
    const sym = coin + 'USDT';
    for (let st = START; st < now;) {
      const j = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1h&startTime=${st}&limit=1000`);
      if (!Array.isArray(j) || !j.length) break;
      for (const x of j) out.set(x[0], { t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[7] });
      st = j[j.length - 1][0] + H; if (j.length < 1000) break; await sleep(40);
    }
  }
  const bars = [...out.values()].filter(b => b.t >= START && b.t + H <= now).sort((a, b) => a.t - b.t);
  fs.mkdirSync('.cache', { recursive: true }); fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), bars }));
  return bars;
}
function agg(b1, ms, minN) {
  const g = new Map();
  for (const b of b1) { const k = Math.floor(b.t / ms) * ms; const x = g.get(k); if (!x) g.set(k, { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: 1 }); else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; x.v += b.v; x.n++; } }
  return [...g.values()].filter(x => x.n >= minN).sort((a, b) => a.t - b.t);
}
function atrOf(b) { const A = []; let s = 0; for (let i = 0; i < b.length; i++) { const p = b[i - 1], x = b[i]; const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c)) : x.h - x.l; if (i < 14) { s += tr; A[i] = s / (i + 1); } else A[i] = (A[i - 1] * 13 + tr) / 14; } return A; }
function emaArr(a, len) { const e = [], k = 2 / (len + 1); for (let i = 0; i < a.length; i++) e[i] = i ? a[i] * k + e[i - 1] * (1 - k) : a[i]; return e; }

// ── 訊號：① 有量跌不破／漲不破（2026-11-22 使用者補充：位置＝支撐壓力線或 EMA50；停利抓前低／前高，或慢慢移停損）──
// 先寫「做空」版（漲不破壓力）；做多＝價格上下翻過來
function flip(b) { return b.map(x => ({ t: x.t, o: -x.o, h: -x.l, l: -x.h, c: -x.c, v: x.v })); }
function signals(bRaw, d) {
  const b = d < 0 ? bRaw : flip(bRaw), n = b.length, A = atrOf(bRaw), E = emaArr(b.map(x => x.c), 50);
  const out = { H: [], Hc: [], Hw: [], H2: [], H2c: [], E: [], Ec: [], Ew: [] };
  const vavg = i => { let s = 0; for (let j = i - 20; j < i; j++) s += b[j].v; return s / 20; };
  const real = x => d < 0 ? x : -x;
  const piv = []; // 轉折高點（左右各 3 根）＝壓力線
  for (let i = 110; i < n; i++) {
    const j0 = i - 3; let ok = true; for (let q = j0 - 3; q <= j0 + 3; q++) if (q !== j0 && b[q].h > b[j0].h) { ok = false; break; } if (ok) piv.push(j0);
    while (piv.length && piv[0] < i - 100) piv.shift();
    const x = b[i], p = b[i - 1], a = A[i], vr = x.v / vavg(i);
    let lo20 = Infinity; for (let j = i - 20; j < i; j++) lo20 = Math.min(lo20, b[j].l);
    const mk = () => ({ i, stop: real(Math.max(x.h + 0.1 * a, x.c + 0.5 * a)), tgt: real(lo20) }); // 停損至少 0.5 ATR，太近會被手續費吃掉
    // 水平壓力：前面（5～100 根前）的轉折高點，這根碰到（差 0.2 ATR 內或刺穿）但收盤在下面，前一根也在下面
    let best = null;
    for (const j of piv) { if (j > i - 5) continue; const L = b[j].h; if (x.h >= L - 0.2 * a && x.h <= L + 1.0 * a && x.c < L && p.c < L) { if (!best || Math.abs(x.h - L) < Math.abs(x.h - best.L)) best = { L, j }; } }
    if (best) {
      const s = mk(); out.Hc.push(s); if (vr >= 2) out.H.push(s); if (vr < 1) out.Hw.push(s);
      const tests = piv.filter(j => j <= i - 5 && Math.abs(b[j].h - best.L) <= 0.3 * a).length;
      if (tests >= 2) { out.H2c.push(s); if (vr >= 2) out.H2.push(s); }
    }
    // EMA50：從下面反彈上來碰到 EMA50（差 0.1 ATR 內或刺穿）但收盤在 EMA50 下面
    if (p.c < E[i - 1] && x.h >= E[i] - 0.1 * a && x.c < E[i]) { const s = mk(); out.Ec.push(s); if (vr >= 2) out.E.push(s); if (vr < 1) out.Ew.push(s); }
  }
  return out;
}

// ── 出場 ── X1：停損跟著波段高點移（左右各 5 根），不設停利；X2：固定 2R 停利
function simTrade(b, s, d, exitMode) {
  const e = s.px != null ? s.px : b[s.i].c, risk = (s.stop - e) * (d < 0 ? 1 : -1); if (!(risk > 0)) return null;
  let st = s.stop; const path = [];
  if (s.px != null && (d < 0 ? b[s.i].h >= st : b[s.i].l <= st)) return fin(st, s.i); // 掛單成交的同一根就打到停損（保守算）
  const tgt = exitMode === 'X2' ? e + d * 2 * risk : exitMode === 'X3' ? s.tgt : null;
  if (exitMode === 'X3' && !((tgt - e) * d >= 0.5 * risk)) return null; // 前低離進場不到 0.5R 就不做
  const maxBars = exitMode === 'X1' ? 300 : 100;
  for (let k = s.i + 1; k < b.length; k++) {
    const x = b[k];
    const hitS = d < 0 ? x.h >= st : x.l <= st;
    if (hitS) { const px = d < 0 ? Math.max(st, x.o) : Math.min(st, x.o); return fin(px, k); }
    if (tgt !== null && (d < 0 ? x.l <= tgt : x.h >= tgt)) return fin(d < 0 ? Math.min(tgt, x.o) : Math.max(tgt, x.o), k);
    if ((k - s.i) % PATH_STEP === 0) path.push([x.t, (x.c - e) * d / risk]); // 浮動盈虧（1 小時每 4 根記一次，省記憶體）
    if (k - s.i >= maxBars) return fin(x.c, k);
    if (exitMode === 'X1' && k >= 10) { // 剛確認的波段高點（做多是低點）
      const j = k - 5; let ok = true;
      for (let q = j - 5; q <= j + 5; q++) if (q !== j && (d < 0 ? b[q].h >= b[j].h : b[q].l <= b[j].l)) { ok = false; break; }
      if (ok) { const pv = d < 0 ? b[j].h : b[j].l; if (d < 0 ? pv < st : pv > st) st = pv; }
    }
  }
  return null;
  function fin(px, k) { const R = (px - e) * d / risk - COST * (e + px) / risk; return { R, inT: b[s.i].t, outT: b[k].t, bars: k - s.i, path, i: s.i, k }; }
}

// ── 統計 ──
const mean = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : NaN;
function stats(T, weeks) {
  const n = T.length; if (!n) return null;
  const Rs = T.map(t => t.R), w = Rs.filter(r => r > 0), l = Rs.filter(r => r <= 0);
  let st = 0, mx = 0; for (const t of [...T].sort((a, b) => a.outT - b.outT)) { if (t.R <= 0) { st++; mx = Math.max(mx, st); } else st = 0; }
  const srt = [...Rs].sort((a, b) => b - a), mid = START + (Date.now() - START) / 2;
  const yr = {}; for (const t of T) { const y = new Date(t.inT).getUTCFullYear(); yr[y] = (yr[y] || 0) + t.R; }
  return { n, perWeek: n / weeks, win: w.length / n, avgW: mean(w), avgL: mean(l), avg: mean(Rs), tot: Rs.reduce((a, x) => a + x, 0), noTop3: mean(srt.slice(3)), h1: mean(T.filter(t => t.inT < mid).map(t => t.R)), h2: mean(T.filter(t => t.inT >= mid).map(t => t.R)), streak: mx, yr };
}
// 嚴格組合模擬：進場當下的總資產（含浮動）× 1% 當風險；最多 10 張；同一個幣同時只有一張；浮虧算進回撤
function portfolio(T, adj = 0) {
  const ev = []; T.forEach((t, k) => { ev.push({ t: t.inT, k, type: 1 }); for (const [tt, r] of t.path) ev.push({ t: tt, k, type: 2, r }); ev.push({ t: t.outT, k, type: 3 }); });
  ev.sort((a, b) => a.t - b.t || a.type - b.type);
  let cash = 1, peak = 1, dd = 0; const open = new Map(); // k -> {risk, r}
  const eq = () => { let s = cash; for (const o of open.values()) s += o.risk * o.r; return s; };
  for (const e of ev) {
    const t = T[e.k];
    if (e.type === 1) { if (open.size >= 10 || [...open.keys()].some(k => T[k].coin === t.coin)) continue; open.set(e.k, { risk: 0.01 * eq(), r: 0 }); }
    else if (!open.has(e.k)) continue;
    else if (e.type === 2) open.get(e.k).r = e.r;
    else { const o = open.get(e.k); cash += o.risk * (t.R - adj); open.delete(e.k); }
    const q = eq(); peak = Math.max(peak, q); dd = Math.min(dd, q / peak - 1); if (q <= 0.01) return { mult: 0, cagr: -1, dd: -1 };
  }
  const yrs = (Date.now() - START) / (365.25 * 24 * H);
  return { mult: cash, cagr: Math.pow(Math.max(cash, 0), 1 / yrs) - 1, dd };
}

(async () => {
  const t0 = Date.now();
  const test = await getJSON('https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=2');
  SRC = test && test.result && test.result.list ? 'bybit' : 'binance';
  console.log('資料來源', SRC);
  const data = {}; const missing = [];
  for (const c of [...DESIGN, ...VALID]) { const b = await fetch1h(c); if (b.length < 24 * 200) { missing.push(c); continue; } data[c] = b; console.log(c, b.length); }
  const TF = { '1小時': [H, 1], '4小時': [4 * H, 3], '日線': [24 * H, 20] };
  const VARS = [['H', -1, '壓力線 有量漲不破 → 空'], ['Hw', -1, '壓力線 沒量漲不破（對照）'], ['Hc', -1, '壓力線 不看量（對照）'], ['H2', -1, '被測過 2 次以上的壓力 有量漲不破 → 空'], ['H2c', -1, '測過 2 次以上的壓力 不看量（對照）'],
    ['E', -1, 'EMA50 有量漲不破 → 空'], ['Ew', -1, 'EMA50 沒量漲不破（對照）'], ['Ec', -1, 'EMA50 不看量（對照）'],
    ['H', 1, '支撐線 有量跌不破 → 多'], ['Hw', 1, '支撐線 沒量跌不破（對照）'], ['Hc', 1, '支撐線 不看量（對照）'], ['H2', 1, '被測過 2 次以上的支撐 有量跌不破 → 多'], ['H2c', 1, '測過 2 次以上的支撐 不看量（對照）'],
    ['E', 1, 'EMA50 有量跌不破 → 多'], ['Ew', 1, 'EMA50 沒量跌不破（對照）'], ['Ec', 1, 'EMA50 不看量（對照）']];
  const MAIN = new Set(['H', 'H2', 'E']);
  const weeks = (Date.now() - START) / (7 * 24 * H);
  let md = `# ① 有量跌不破／漲不破（支撐壓力線、EMA50）（${new Date(Date.now() + 8 * H).toISOString().slice(0, 16).replace('T', ' ')}）\n\n資料來源：${SRC === 'bybit' ? 'Bybit 永續' : 'Binance 現貨（Bybit 從 GitHub 伺服器連不上）'}，2021-01～現在；設計組 ${DESIGN.filter(c => data[c]).length} 幣、驗證組 ${VALID.filter(c => data[c]).length} 幣${missing.length ? '；抓不到：' + missing.join(' ') : ''}\n成本：每邊 0.055% 手續費＋0.05% 滑價。X1＝慢慢移停損（跟波段高點移）、不設停利；X3＝停利抓前 20 根的低點（做多是高點），不到 0.5R 遠就不做\n\n`;
  const rows = [], json = {};
  for (const [tfName, [ms, minN]] of Object.entries(TF)) {
    PATH_STEP = ms === H ? 4 : 1;
    const B = {}; for (const c in data) B[c] = ms === H ? data[c] : agg(data[c], ms, minN);
    const TRD = {}; for (const c in B) { const b = B[c], e = emaArr(b.map(x => x.c), 50), A = atrOf(b); TRD[c] = b.map((x, i) => i < 60 ? '盤整' : x.c > e[i] && e[i] - e[i - 10] > 0.3 * A[i] ? '多頭' : x.c < e[i] && e[i] - e[i - 10] < -0.3 * A[i] ? '空頭' : '盤整'); }
    const sig = {}; for (const c in B) sig[c] = { '-1': signals(B[c], -1), '1': signals(B[c], 1) };
    md += `## ${tfName}\n\n| 版本 | 出場 | 幣組 | 筆數 | 一週 | 勝率 | 賺/賠平均 | 平均 | 拿掉最賺3筆 | 前段/後段 | 最長連虧 | 組合年化 | 回撤 | 扣0.2R年化 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const [v, d, name] of VARS) for (const X of ['X1', 'X3']) {
      const all = [];
      for (const c in B) { let busy = -1; for (const s of sig[c][d][v]) { if (s.i <= busy) continue; const t = simTrade(B[c], s, d, X); if (!t) continue; busy = t.k; t.coin = c; t.set = DESIGN.includes(c) ? 'D' : 'V'; all.push(t); } }
      for (const [setName, T] of [['設計', all.filter(t => t.set === 'D')], ['驗證', all.filter(t => t.set === 'V')], ['全部', all]]) {
        const S = stats(T, weeks); if (!S) { md += `| ${name}${d > 0 ? '' : ''} | ${X} | ${setName} | 0 |||||||||||\n`; continue; }
        const P = setName === '全部' ? portfolio(T) : null, P2 = setName === '全部' ? portfolio(T, 0.2) : null;
        const f = x => (x >= 0 ? '+' : '') + x.toFixed(2) + 'R', pc = x => (x * 100).toFixed(0) + '%';
        md += `| ${name} | ${X} | ${setName} | ${S.n} | ${S.perWeek.toFixed(2)} | ${pc(S.win)} | ${f(S.avgW)}/${f(S.avgL)} | **${f(S.avg)}** | ${f(S.noTop3)} | ${f(S.h1)}/${f(S.h2)} | ${S.streak} | ${P ? pc(P.cagr) : ''} | ${P ? pc(P.dd) : ''} | ${P2 ? pc(P2.cagr) : ''} |\n`;
        json[`${tfName}|${v}|${d}|${X}|${setName}`] = { ...S, P, P2 };
      }
      // 依趨勢（EMA50）分開看，只看主角
      if (MAIN.has(v)) {
        const tr = {}; for (const t of all) { const k = TRD[t.coin][t.i]; (tr[k] = tr[k] || []).push(t.R); }
        json[`${tfName}|trend|${v}|${d}|${X}`] = Object.fromEntries(Object.entries(tr).map(([k, a]) => [k, { n: a.length, avg: mean(a) }]));
        md += `| ↳ 依 EMA50 趨勢 | ${X} | 全部 | ${Object.entries(tr).map(([k, a]) => `${k} ${a.length} 筆 ${(mean(a) >= 0 ? '+' : '') + mean(a).toFixed(2)}R`).join('；')} |||||||||||\n`;
        const y = (stats(all, weeks) || { yr: {} }).yr; md += `| ↳ 每年 | ${X} | 全部 | ${Object.entries(y).map(([k, r]) => `${k}: ${r >= 0 ? '+' : ''}${r.toFixed(0)}R`).join(' ')} |||||||||||\n`;
      }
    }
    md += '\n';
  }
  md += `\n跑了 ${((Date.now() - t0) / 60000).toFixed(1)} 分鐘\n`;
  fs.mkdirSync('research/results', { recursive: true });
  fs.writeFileSync('research/results/vol4.md', md);
  fs.writeFileSync('research/results/vol4.json', JSON.stringify(json));
  console.log(md);
})();
