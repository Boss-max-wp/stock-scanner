// 候選型態：量縮整理後第一根帶量紅K（只做多）
// 白話：股價在季線之上、月線往上，最近 8 天量縮到 40 天來最低、價格在小區間裡盤整（高低差 ≤ 10%），
// 今天突然出量收紅K、收盤站上這 8 天的最高收盤——台股說「量縮價穩，帶量再攻」。
// 停損：整理區最低點下方。目標：1.5 倍停損距離。
module.exports = {
  key: 'dryup_burst',
  names: ['量縮後帶量攻', '量縮後帶量殺'],
  status: 'candidate',
  dirs: ['long'],
  desc: '量縮到 40 日低量、小區間盤整後，第一根帶量紅K站上整理區',
  detect(bars, P, H) {
    const { n, O, C, L, V, sma } = H;
    const W = 8;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 80) break;
      if (!(C[s] > sma(C, s, 60))) continue;                               // 季線之上
      if (!(sma(C, s, 20) > sma(C, s - 5, 20))) continue;                  // 月線上彎
      // 最近 W 天裡有一天量縮到 40 日最低
      let dry = false;
      for (let k = s - W; k <= s - 1 && !dry; k++) {
        let m = Infinity; for (let j = k - 40; j < k; j++) m = Math.min(m, V[j]);
        if (V[k] <= m) dry = true;
      }
      if (!dry) continue;
      const boxHi = H.maxH(s - W, s - 1), boxLo = H.minL(s - W, s - 1);
      if (!(boxHi / boxLo - 1 <= 0.10)) continue;                          // 小區間盤整
      if (!(C[s] > H.maxC(s - W, s - 1) && C[s] > O[s])) continue;         // 紅K、站上整理區最高收盤
      if (C[s] >= C[s - 1] * 1.095 && C[s] >= H.H[s]) continue;            // 鎖漲停買不到
      const volRatio = H.volRatio(s), cs = H.closeStr(s), body = H.body(s);
      const fails = [];
      if (volRatio < P.volMult) fails.push(`量比只有 ${volRatio.toFixed(2)} 倍（要 ${P.volMult} 倍）`);
      if (body < P.minBody) fails.push(`紅K實體只有 ${body.toFixed(1)}%（要 ${P.minBody}%）`);
      if (cs < 0.6) fails.push('收盤沒有收在當天高檔');
      if (fails.length > 1) continue;
      const stop = Math.min(boxLo, L[s]) * 0.995, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.015) continue;
      const pl = H.plan(s, stop, C[s] + 1.5 * risk0);
      const checks = [
        { k: '帶量', ok: volRatio >= P.volMult, pts: volRatio >= P.volMult ? Math.min(20, 10 + (volRatio - P.volMult) * 5) : 0 },
        { k: '長紅K', ok: body >= P.minBody, pts: body >= P.minBody ? 10 : 0 },
        { k: '收在高檔', ok: cs >= 0.6, pts: cs >= 0.6 ? 8 : 0 },
        { k: '風險≤6%', ok: pl.risk <= 6, pts: pl.risk <= 6 ? 6 : 0 },
      ];
      return [{ sigIdx: s, ...pl, checks, score: H.score(checks), miss: fails[0] || null,
        level: boxHi, levelLabel: '整理區上緣', low: boxLo, volRatio, body, depth: (boxHi / boxLo - 1) * 100,
        desc: `量縮盤整 ${W} 天後帶量 ${volRatio.toFixed(1)} 倍紅K`, descShort: `量縮盤整 ${W} 天後帶量 ${volRatio.toFixed(1)} 倍黑K` }];
    }
    return [];
  }
};
