// 型態研究：在 GitHub Actions 上抓約兩年資料，回測「現有型態 + research/candidates/ 裡的候選型態」，
// 結果寫到 research/results/latest.json 和 latest.md。
// 用法：node research/run.js        （本機沒有 FinMind 網路時，用 node research/selftest.js 檢查語法）
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const S = require('../scan.js');

const DAYS = +process.env.DAYS || 730;
// 候選型態通過門檻（寫死在這裡，避免每次判斷標準不一樣）
const RULE = { minN: 40, minAvgR: 0.15, minHalfN: 15, maxOverlap: 0.5 };

(async () => {
  const prev = await S.loadPrev().catch(() => null);
  const params = { ...S.DEFAULTS, ...((prev && prev.params) || S.DEFAULT_PARAMS) };
  const liveKeys = new Set(S.PLUGINS.map(p => p.key));
  const cands = [];
  for (const c of S.loadPatternDir(path.join(__dirname, 'candidates'))) {
    if (liveKeys.has(c.key)) { console.log('候選型態 key 和現有型態重複，略過：', c.key); continue; }
    c.status = 'candidate';
    S.PLUGINS.push(c); cands.push(c);
  }
  const role = k => S.BUILTIN[k] ? 'builtin' : cands.find(c => c.key === k) ? 'candidate' : (S.PLUGINS.find(p => p.key === k) || {}).status || 'unknown';
  const nameOf = k => (S.BUILTIN[k] || (S.PLUGINS.find(p => p.key === k) || {}).names || [k, k]).join(' / ');

  const IDS = Object.keys(S.NAMES);
  const t0 = Date.now();
  const { D, err } = await S.fetchAll(IDS, DAYS);
  console.log('fetched', Object.keys(D).length, '/', IDS.length, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (Object.keys(D).length < IDS.length * 0.8) { console.error('資料抓取失敗太多', JSON.stringify(err).slice(0, 500)); process.exit(1); }
  S.cleanD(D, IDS);

  // 每一天只看當天以前的資料，找出當天的訊號，再看之後 HORIZON 天的結果
  const sig = [];
  for (const [id, b] of Object.entries(D)) {
    for (let s = 80; s <= b.length - 1 - S.HORIZON; s++) {
      for (const x of S.signalsOnDay(b, s, params)) {
        const risk = Math.abs(x.entry - x.stop) / x.entry;
        if (!(risk > 0)) continue;
        const e = S.evaluate({ dir: x.dir, entry: x.entry, stop: x.stop, target: x.target }, b, s);
        if (e.st === 'open' || e.st === 'unknown') continue;
        sig.push({ type: x.type, dir: x.dir, d: x.date, id, st: e.st, R: e.ret / risk, ret: e.ret });
      }
    }
  }
  console.log('signals', sig.length, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const dates = sig.map(x => x.d).sort();
  const mid = dates[Math.floor(dates.length / 2)] || '';
  const recentFrom = dates.length ? new Date(Date.parse(dates[dates.length - 1]) - 180 * 864e5).toISOString().slice(0, 10) : '';
  // 同一天、同一檔、同方向已經有「別的型態」訊號 → 算重疊
  const byKey = {};
  for (const x of sig) (byKey[`${x.id}|${x.d}|${x.dir}`] = byKey[`${x.id}|${x.d}|${x.dir}`] || new Set()).add(x.type);

  const agg = list => {
    const n = list.length, sumR = list.reduce((t, x) => t + x.R, 0);
    return { n, avgR: n ? sumR / n : 0, target: n ? list.filter(x => x.st === 'target').length / n : 0, stop: n ? list.filter(x => x.st === 'stop').length / n : 0, avgRet: n ? list.reduce((t, x) => t + x.ret, 0) / n : 0 };
  };
  const groups = {};
  for (const x of sig) for (const k of [x.type, `${x.type}|${x.dir}`]) (groups[k] = groups[k] || []).push(x);
  const builtinAll = agg(sig.filter(x => S.BUILTIN[x.type]));
  const rows = Object.entries(groups).map(([k, list]) => {
    const [type, dir] = k.split('|');
    const a = agg(list), h1 = agg(list.filter(x => x.d < mid)), h2 = agg(list.filter(x => x.d >= mid)), rc = agg(list.filter(x => x.d >= recentFrom));
    const overlap = list.length ? list.filter(x => byKey[`${x.id}|${x.d}|${x.dir}`].size > 1).length / list.length : 0;
    const r = { key: k, type, dir: dir || 'both', name: nameOf(type), role: role(type), ...a, first: h1, second: h2, recent: rc, overlap };
    if (!dir && r.role === 'candidate') {
      const why = [];
      if (a.n < RULE.minN) why.push(`筆數 ${a.n} < ${RULE.minN}`);
      if (a.avgR < RULE.minAvgR) why.push(`平均 ${a.avgR.toFixed(2)}R < ${RULE.minAvgR}R`);
      if (a.avgR < builtinAll.avgR) why.push(`沒有比現有型態平均 ${builtinAll.avgR.toFixed(2)}R 好`);
      if (h1.n < RULE.minHalfN || h2.n < RULE.minHalfN) why.push(`前後半段筆數不足（${h1.n}/${h2.n}，各要 ${RULE.minHalfN}）`);
      if (!(h1.avgR > 0 && h2.avgR > 0)) why.push(`前後半段不是都賺（${h1.avgR.toFixed(2)}R / ${h2.avgR.toFixed(2)}R）`);
      if (overlap > RULE.maxOverlap) why.push(`和現有型態重疊 ${(overlap * 100).toFixed(0)}% > ${RULE.maxOverlap * 100}%`);
      r.verdict = why.length ? 'reject' : 'pass'; r.why = why;
    }
    if (!dir && r.role === 'experimental') {
      // 實驗中的型態：最近半年明顯虧損就建議停用
      r.verdict = rc.n >= 20 && rc.avgR < 0 && a.avgR < 0.05 ? 'retire' : 'keep';
    }
    return r;
  }).sort((a, b) => (a.dir === 'both' ? 0 : 1) - (b.dir === 'both' ? 0 : 1) || b.avgR - a.avgR);

  const out = { date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), days: DAYS, horizon: S.HORIZON, params, rule: RULE,
    range: [dates[0], dates[dates.length - 1]], mid, recentFrom, stocks: Object.keys(D).length, builtinAll, candidates: cands.map(c => c.key), rows };
  fs.mkdirSync('research/results', { recursive: true });
  fs.writeFileSync('research/results/latest.json', JSON.stringify(out, null, 1));
  const pct = v => (v * 100).toFixed(0) + '%', R = v => (v >= 0 ? '+' : '') + v.toFixed(2) + 'R';
  let md = `# 型態研究結果 ${out.date}\n\n資料 ${out.range[0]} ～ ${out.range[1]}，${out.stocks} 檔，訊號後追蹤 ${S.HORIZON} 個交易日。前半／後半以 ${mid} 分界；「近半年」從 ${recentFrom} 起。\n` +
    `參數：量比 ${params.volMult}、實體 ${params.minBody}%。現有型態整體平均 ${R(builtinAll.avgR)}（${builtinAll.n} 筆）。\n\n` +
    `通過門檻：筆數 ≥ ${RULE.minN}、平均 ≥ ${RULE.minAvgR}R 且不低於現有型態平均、前後半段各 ≥ ${RULE.minHalfN} 筆且都 > 0R、與現有型態重疊 ≤ ${RULE.maxOverlap * 100}%。\n\n` +
    `| 型態 | 方向 | 身分 | 筆數 | 達標 | 停損 | 平均 | 前半 | 後半 | 近半年 | 重疊 | 判定 |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n` +
    rows.map(r => `| ${r.name} (${r.type}) | ${r.dir} | ${r.role} | ${r.n} | ${pct(r.target)} | ${pct(r.stop)} | ${R(r.avgR)} | ${R(r.first.avgR)} (${r.first.n}) | ${R(r.second.avgR)} (${r.second.n}) | ${R(r.recent.avgR)} (${r.recent.n}) | ${pct(r.overlap)} | ${r.verdict || ''}${r.why && r.why.length ? '：' + r.why.join('；') : ''} |`).join('\n') + '\n';
  fs.writeFileSync('research/results/latest.md', md);
  console.log(md);
})().catch(e => { console.error(e); process.exit(1); });
