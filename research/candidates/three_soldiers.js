// 候選型態：紅三兵站上月線（只做多）
// 白話：季線往上的股票，連續三天收紅K、一天比一天收得高（第 2 輪：開盤不低於前一根開盤），
// 第一根還在月線下方或附近，第三根收盤站上月線——「連三紅把股價推回月線上」。
// 停損：三根紅K的最低點下方。目標：2 倍停損距離。
module.exports = {
  key: 'three_soldiers',
  names: ['紅三兵站上月線', '黑三兵跌破月線'],
  status: 'candidate',
  dirs: ['long'],
  desc: '連續三根紅K一路收高，第三根站上月線',
  detect(bars, P, H) {
    const { n, O, C, L, V, sma } = H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 80) break;
      const m60 = sma(C, s, 60);
      if (!(m60 >= sma(C, s - 10, 60) && C[s] > m60)) continue;              // 季線沒往下、收在季線上
      const a = s - 2, b = s - 1;
      let ok = true;
      for (const i of [a, b, s]) {
        if (!(C[i] > O[i] && (C[i] - O[i]) / C[i - 1] >= 0.008)) ok = false; // 三根都是實體 ≥0.8% 的紅K
      }
      if (!ok) continue;
      if (!(C[b] > C[a] && C[s] > C[b])) continue;                            // 一天比一天收高
      if (!(O[b] >= O[a] && O[s] >= O[b])) continue;                          // 第 2 輪：只要求開盤不低於前一根開盤（允許小跳空）
      const m20a = sma(C, a, 20), m20 = sma(C, s, 20);
      if (!(O[a] <= m20a * 1.01 && C[s] > m20)) continue;                     // 從月線下方/附近，第三根站上月線
      if (C[s] >= C[s - 1] * 1.095 && C[s] >= H.H[s]) continue;               // 鎖漲停買不到
      const rise = (C[s] / O[a] - 1) * 100;
      if (rise < 3 || rise > 15) continue;                                    // 三天漲 3%～15%
      const volRatio = H.volRatio(s), cs = H.closeStr(s), body = H.body(s);
      const volUp = (V[a] + V[b] + V[s]) / 3 > H.avgV(a - 1, 20);
      const fails = [];
      if (!volUp) fails.push('三天均量沒有比之前 20 日均量大');
      if (cs < 0.6) fails.push('第三根沒有收在當天高檔');
      if (!(V[s] >= V[a])) fails.push('第三根量比第一根小');
      if (fails.length > 1) continue;
      const lo = Math.min(L[a], L[b], L[s]);
      const stop = lo * 0.995, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.015) continue;
      const pl = H.plan(s, stop, C[s] + 2 * risk0);
      const checks = [
        { k: '三天量增', ok: volUp, pts: volUp ? Math.min(16, 8 + Math.max(0, volRatio - 1) * 6) : 0 },
        { k: '收在高檔', ok: cs >= 0.6, pts: cs >= 0.6 ? 10 : 0 },
        { k: '量越來越大', ok: V[s] >= V[a], pts: V[s] >= V[a] ? 8 : 0 },
        { k: '風險≤6%', ok: pl.risk <= 6, pts: pl.risk <= 6 ? 6 : 0 },
      ];
      return [{ sigIdx: s, ...pl, checks, score: H.score(checks), miss: fails[0] || null,
        level: m20, levelLabel: '月線', low: lo, volRatio, body, depth: rise,
        desc: `紅三兵站上月線（三天漲 ${rise.toFixed(1)}%）`, descShort: `黑三兵跌破月線（三天跌 ${rise.toFixed(1)}%）` }];
    }
    return [];
  }
};
