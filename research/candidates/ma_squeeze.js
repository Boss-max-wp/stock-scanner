// 候選型態：均線糾結突破
// 想法：5、10、20 日均線黏在一起（籌碼沉澱、多空平衡），之後一根帶量長紅突破整理區高點並站上所有均線，常是新一段行情的起點。
module.exports = {
  key: 'ma_squeeze',
  names: ['均線糾結突破', '均線糾結跌破'],
  status: 'candidate',
  desc: '5/10/20 日均線糾結後帶量突破',
  detect(bars, P, H) {
    const { n, O, C, V, sma, maxH, minL, closeStr, plan, score } = H;
    const out = [];
    const ma = (end, len) => sma(C, end, len);
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 60 || !(C[s] > O[s])) continue;
      // 前 5 天三條均線的最大差距都在 3% 以內
      let tight = true, spreadMax = 0;
      for (let k = s - 5; k <= s - 1; k++) {
        const m = [ma(k, 5), ma(k, 10), ma(k, 20)], sp = (Math.max(...m) - Math.min(...m)) / Math.min(...m);
        spreadMax = Math.max(spreadMax, sp);
        if (sp > 0.03) { tight = false; break; }
      }
      if (!tight) continue;
      const boxHi = maxH(s - 10, s - 1), boxLo = minL(s - 10, s - 1);
      if (!(C[s] > boxHi && C[s] > Math.max(ma(s, 5), ma(s, 10), ma(s, 20)))) continue;
      if (!(ma(s, 20) >= ma(s - 5, 20) * 0.99)) continue;                  // 月線不能還在明顯下彎
      const volRatio = V[s] / sma(V, s - 1, 20), body = (C[s] - O[s]) / C[s - 1] * 100;
      const fails = [];
      if (volRatio < P.volMult) fails.push(`量比只有 ${volRatio.toFixed(2)} 倍（要 ${P.volMult} 倍）`);
      if (body < P.minBody * 0.7) fails.push(`實體只有 ${body.toFixed(1)}%（要 ${(P.minBody * 0.7).toFixed(1)}%）`);
      if (fails.length > 1) continue;
      const stop = Math.max(boxLo, ma(s, 20) * 0.97);
      if (!(stop < C[s]) || (C[s] - stop) / C[s] > 0.1) continue;          // 風險超過 10% 不做
      const pl = plan(s, stop, C[s] + 2 * (C[s] - stop));
      const ma60up = ma(s, 60) <= ma(s, 20);
      const checks = [
        { k: '帶量突破', ok: volRatio >= P.volMult, pts: volRatio >= P.volMult ? Math.min(18, 10 + (volRatio - P.volMult) * 5) : 0 },
        { k: '均線很緊(≤1.5%)', ok: spreadMax <= 0.015, pts: spreadMax <= 0.015 ? 10 : 0 },
        { k: '季線在下', ok: ma60up, pts: ma60up ? 8 : 0 },
        { k: '收在高檔', ok: closeStr(s) >= 0.75, pts: closeStr(s) >= 0.75 ? 8 : 0 },
        { k: '風險≤7%', ok: pl.risk <= 7, pts: pl.risk <= 7 ? 6 : 0 },
      ];
      out.push({
        sigIdx: s, level: boxHi, low: boxLo, volRatio, body, depth: (C[s] - boxHi) / boxHi * 100,
        levelLabel: '整理區高點', desc: `均線糾結 ${(spreadMax * 100).toFixed(1)}% 後帶量突破整理區`, descShort: `均線糾結 ${(spreadMax * 100).toFixed(1)}% 後帶量跌破整理區`,
        checks, score: score(checks), miss: fails[0] || null, ...pl,
      });
      break;
    }
    return out;
  },
};
