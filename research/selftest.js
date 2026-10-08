// 本機快速檢查型態外掛：用隨機產生的K線逐日跑過，確認不會出錯、欄位齊全、做空鏡像也正常。
// 用法：node research/selftest.js research/candidates/xxx.js [patterns/yyy.js ...]
//      不給參數就檢查 research/candidates/ 和 patterns/ 全部
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const S = require('../scan.js');

const files = process.argv.slice(2);
const list = files.length ? files.map(f => require(path.resolve(f))) : [...S.loadPatternDir('research/candidates'), ...S.loadPatternDir('patterns')];
if (!list.length) { console.log('沒有要檢查的型態'); process.exit(0); }

let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function fakeBars(n) {
  let p = 50 + rnd() * 200, drift = 0; const d = new Date('2024-01-01'), out = [];
  for (let i = 0; i < n; i++) {
    do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
    if (i % 40 === 0) drift = (rnd() - 0.5) * 0.012;
    const o = p * (1 + (rnd() - 0.5) * 0.02), c = o * (1 + drift + (rnd() - 0.5) * 0.06);
    out.push({ d: d.toISOString().slice(0, 10), o, h: Math.max(o, c) * (1 + rnd() * 0.02), l: Math.min(o, c) * (1 - rnd() * 0.02), c, v: Math.round((800 + rnd() * 3000) * (rnd() < 0.08 ? 3 : 1)) });
    p = c;
  }
  return out;
}

let bad = 0;
for (const p of list) {
  const errs = new Set();
  if (typeof p.key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(p.key)) errs.add('key 要是英文小寫、數字、底線');
  if (!Array.isArray(p.names) || p.names.length !== 2) errs.add('names 要是 [做多名稱, 做空名稱]');
  if (typeof p.detect !== 'function') errs.add('缺少 detect 函式');
  if (S.BUILTIN[p.key]) errs.add('key 和內建型態重複');
  let L = 0, Sh = 0, near = 0, t0 = Date.now();
  if (!errs.size) {
    S.PLUGINS.length = 0; S.PLUGINS.push(p);
    const P = { ...S.DEFAULTS, ...S.DEFAULT_PARAMS, recent: 1 };
    for (let k = 0; k < 30 && errs.size < 3; k++) {
      const b = fakeBars(300);
      for (let s = 80; s < b.length && errs.size < 3; s++) {
        const bars = b.slice(0, s + 1);
        for (const bb of [bars, S.mirrorBars(bars).bars]) {
          try {
            const hs = p.detect(bb, P, S.helpers(bb));
            if (!Array.isArray(hs)) errs.add('detect 要回傳陣列（沒有就回傳 []）');
          } catch (e) { errs.add('detect 出錯：' + e.message); }
        }
        for (const x of S.analyzeAll(bars, P).filter(x => x.type === p.key)) {
          const miss = ['entry', 'stop', 'score', 'risk'].filter(f => !isFinite(x[f]));
          if (!x.checks.length || x.checks.some(c => typeof c.k !== 'string')) miss.push('checks');
          if (miss.length) errs.add('訊號缺欄位或不是數字：' + miss.join(','));
          if (x.dir === 'long' ? !(x.stop < x.entry) : !(x.stop > x.entry)) errs.add('停損方向錯誤');
          if (x.kind === 'near') near++; else if (x.dir === 'long') L++; else Sh++;
        }
      }
    }
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${p.key || '?'}：${errs.size ? '有問題 ✗ ' + [...errs].join('；') : `OK ✓  隨機資料 9000 天裡：做多 ${L}、做空 ${Sh}、差一點 ${near}（${sec} 秒）`}`);
  if (errs.size) bad++;
}
process.exit(bad ? 1 : 0);
