// 出場方式研究：達標就全賣，會不會常常賣在起漲點？比較「達標後續抱」的各種做法。
// 只看做多。在 GitHub Actions 跑（analyze.yml，script=exits），結果寫到 research/results/exits.md
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const S = require('../scan.js');

const MAXD = 30;   // 最多抱幾個交易日
const mean = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : 0;
const pct = v => (v * 100).toFixed(0) + '%';
const Rf = v => (v >= 0 ? '+' : '') + v.toFixed(2) + 'R';

// 各種出場方式。進場＝訊號日收盤；達標前一律：碰停損出場（跳空低開就用開盤價）、第 10 天還沒達標就收盤出場。
// 差別只在「碰到目標之後」怎麼處理。回傳 { R, days, hit }，R 以整筆部位計。
function run(b, s, e, stop0, target, mode) {
  const risk = e - stop0; if (!(risk > 0) || !(target > e)) return null;
  const ma = (i, n) => { if (i - n + 1 < 0) return NaN; let t = 0; for (let k = i - n + 1; k <= i; k++) t += b[k].c; return t / n; };
  const atr = i => { let t = 0; for (let k = i - 13; k <= i; k++) t += Math.max(b[k].h - b[k].l, Math.abs(b[k].h - b[k - 1].c), Math.abs(b[k].l - b[k - 1].c)); return t / 14; };
  let stop = stop0, hitDay = 0, half = 0, hh = e;   // half：已經在目標價先賣掉的部位比例
  const R = px => (px - e) / risk;
  for (let k = 1; k <= MAXD; k++) {
    const x = b[s + k]; if (!x) return null;
    hh = Math.max(hh, x.h);
    // 1) 停損（含移動停損）
    if (x.l <= stop) { const px = Math.min(x.o, stop); return { R: half * R(target) + (1 - half) * R(px), days: k, hit: !!hitDay }; }
    // 2) 第一次碰到目標
    if (!hitDay && x.h >= target) {
      const px = Math.max(x.o, target);
      if (mode === 'base' || mode === 'base20') return { R: R(px), days: k, hit: true };
      hitDay = k;
      if (mode.startsWith('half')) half = 0.5;
      if (mode === 'strong') {   // 達標當天收在高檔、而且收盤還在目標之上才續抱，否則全賣
        const cs = x.h > x.l ? (x.c - x.l) / (x.h - x.l) : 0;
        if (!(x.c >= target && cs >= 0.7)) return { R: R(px), days: k, hit: true };
      }
      // 達標後停損至少拉到成本；lock 版拉到目標和成本的中間
      stop = Math.max(stop, mode.endsWith('lock') || mode === 'strong' ? e + (target - e) * 0.5 : e);
    }
    // 3) 達標後的移動出場（收盤判斷）
    if (hitDay) {
      let out = false;
      if (mode === 'half_ma5' || mode === 'hold_ma5' || mode === 'hold_ma5_lock' || mode === 'strong') out = x.c < ma(s + k, 5);
      if (mode === 'half_ma10' || mode === 'hold_ma10') out = x.c < ma(s + k, 10);
      if (mode === 'hold_atr') { stop = Math.max(stop, hh - 2.5 * atr(s + k)); }
      if (mode === 'half_atr') { stop = Math.max(stop, hh - 2.5 * atr(s + k)); }
      if (mode === 'hold_low3') out = x.c < Math.min(b[s + k - 1].l, b[s + k - 2].l, b[s + k - 3].l);
      if (out) return { R: half * R(target) + (1 - half) * R(x.c), days: k, hit: true };
    } else if (k === (mode === 'base20' ? 20 : 10)) {
      return { R: R(x.c), days: k, hit: false };   // 時間到還沒達標
    }
  }
  const last = b[s + MAXD];
  return { R: half * R(target) + (1 - half) * R(last.c), days: MAXD, hit: !!hitDay };
}

const MODES = [
  ['base', '現在：碰到目標全賣（10 天）'],
  ['base20', '碰到目標全賣，但等 20 天'],
  ['half_ma5', '目標先賣一半，剩下跌破 5 日線再賣'],
  ['half_ma10', '目標先賣一半，剩下跌破 10 日線再賣'],
  ['half_atr', '目標先賣一半，剩下用移動停損（最高價 − 2.5 倍 ATR）'],
  ['hold_ma5', '達標不賣，停損拉到成本，跌破 5 日線全賣'],
  ['hold_ma5_lock', '達標不賣，停損拉到半路，跌破 5 日線全賣'],
  ['hold_ma10', '達標不賣，停損拉到成本，跌破 10 日線全賣'],
  ['hold_low3', '達標不賣，收盤跌破前 3 天最低點全賣'],
  ['hold_atr', '達標不賣，移動停損（最高價 − 2.5 倍 ATR）'],
  ['strong', '達標當天收強（收在高檔且站穩目標）才續抱，跌破 5 日線賣；否則全賣'],
];

(async () => {
  const t0 = Date.now();
  const prev = await S.loadPrev().catch(() => null);
  const params = { ...S.DEFAULTS, ...((prev && prev.params) || S.DEFAULT_PARAMS) };
  const { D, names } = await S.loadData();
  S.cleanD(D, Object.keys(names));
  const sig = [];
  for (const [id, b] of Object.entries(D)) {
    for (let s = 80; s <= b.length - 1 - MAXD; s++) {
      for (const x of S.signalsOnDay(b, s, params)) {
        if (x.dir !== 'long') continue;
        const o = { id, d: b[s].d, type: x.type, hq: S.isHQ ? S.isHQ('long', x.entry, x.stop, x.target) : false, res: {} };
        for (const [m] of MODES) o.res[m] = run(b, s, x.entry, x.stop, x.target, m);
        if (!o.res.base) continue;
        // 賣飛程度：現在的做法達標賣出後，之後 10 天最高還多漲了幾 R
        if (o.res.base.hit) {
          const k = o.res.base.days, risk = x.entry - x.stop;
          let mx = -Infinity; for (let j = s + k + 1; j <= s + k + 10 && b[j]; j++) mx = Math.max(mx, b[j].h);
          o.after = (mx - Math.max(b[s + k].o, x.target)) / risk;
        }
        sig.push(o);
      }
    }
  }
  sig.sort((a, b) => a.d < b.d ? -1 : 1);
  const cut = sig[Math.floor(sig.length * 0.6)].d;
  console.log('long signals', sig.length, ((Date.now() - t0) / 1000).toFixed(0) + 's');

  const stat = (list, m) => {
    const r = list.map(x => x.res[m]).filter(Boolean), R = r.map(x => x.R).sort((a, b) => a - b);
    return { n: r.length, R: mean(R), pos: mean(r.map(x => x.R > 0 ? 1 : 0)), hit: mean(r.map(x => x.hit ? 1 : 0)), days: mean(r.map(x => x.days)), big: mean(r.map(x => x.R >= 3 ? 1 : 0)), p90: R[Math.floor(R.length * 0.9)] || 0, worst: R[Math.floor(R.length * 0.1)] || 0 };
  };
  let md = `# 出場方式研究 ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')}\n\n`;
  md += `只看做多，${sig.length} 筆（${sig[0].d} ～ ${sig[sig.length - 1].d}）。訓練：${cut} 以前；驗證：${cut} 以後。最多抱 ${MAXD} 個交易日。\n`;
  md += `R＝停損距離；「賺錢比例」＝整筆出場時是賺的；「≥3R」＝賺到停損距離 3 倍以上的比例（抓到大波段）；停損遇到跳空低開用開盤價。\n\n`;

  const hit = sig.filter(x => x.res.base.hit && x.after != null);
  md += `## 1. 現在的賣法會不會賣飛？\n\n達標賣出的 ${hit.length} 筆裡，之後 10 天最高價：\n\n`;
  for (const t of [0.5, 1, 2, 3]) md += `- 再多漲 ${t} R 以上：${pct(mean(hit.map(x => x.after >= t ? 1 : 0)))}\n`;
  md += `- 賣完就沒再更高：${pct(mean(hit.map(x => x.after <= 0 ? 1 : 0)))}\n\n`;

  for (const [label, filt] of [['全部做多', x => true], ['★ 高勝率', x => x.hq]]) {
    md += `## ${label}\n\n| 出場方式 | 訓練平均 | 訓練賺錢比例 | 驗證筆數 | 驗證平均 | 驗證賺錢比例 | 驗證 ≥3R | 驗證前10%最好 | 驗證最差10% | 平均抱幾天 |\n|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const [m, name] of MODES) {
      const a = stat(sig.filter(x => x.d < cut && filt(x)), m), b2 = stat(sig.filter(x => x.d >= cut && filt(x)), m);
      md += `| ${name} | ${Rf(a.R)} | ${pct(a.pos)} | ${b2.n} | ${Rf(b2.R)} | ${pct(b2.pos)} | ${pct(b2.big)} | ${Rf(b2.p90)} | ${Rf(b2.worst)} | ${b2.days.toFixed(1)} |\n`;
    }
    md += '\n';
  }
  // 每月穩定度：最好的兩種 vs 現在
  const byM = {}; for (const x of sig) (byM[x.d.slice(0, 7)] = byM[x.d.slice(0, 7)] || []).push(x);
  const top = MODES.slice(2).map(([m]) => [m, stat(sig.filter(x => x.d < cut), m).R]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
  md += `## 每月比較（全部做多；訓練期最好的 3 種 vs 現在）\n\n| 月 | 筆數 | 現在 | ${top.map(m => MODES.find(x => x[0] === m)[1]).join(' | ')} |\n|---|---|---|${top.map(() => '---').join('|')}|\n`;
  for (const [m, l] of Object.entries(byM).sort()) md += `| ${m} | ${l.length} | ${Rf(stat(l, 'base').R)} | ${top.map(k => Rf(stat(l, k).R)).join(' | ')} |\n`;
  fs.mkdirSync('research/results', { recursive: true });
  fs.writeFileSync('research/results/exits.md', md);
  console.log(md.slice(0, 2500));
})().catch(e => { console.error(e); process.exit(1); });
