// 實驗中型態：月線附近的長紅吞噬（只做多）
// 白話：多頭排列（月線在季線之上、季線往上），股價拉回到月線附近；前一天收黑K，
// 今天開低走高收長紅K，整根實體把昨天黑K完全包住，而且收在月線之上——「長紅吞噬，支撐有守」。
// 停損：這兩天的最低點下方。目標：2 倍停損距離。
module.exports = {
  key: 'engulf_ma20',
  names: ['月線長紅吞噬', '月線長黑吞噬'],
  status: 'experimental',
  added: '2026-10-17',
  backtest: '2025-01～2026-10 回測 102 筆（只做多），達標率 38%、停損率 50%，平均 +0.28R；前半 +0.17R（42 筆）、後半 +0.37R（60 筆）、近半年 +0.62R（38 筆）；與現有型態重疊 2%',
  dirs: ['long'],
  desc: '多頭拉回月線，長紅K吞掉前一天黑K',
  detect(bars, P, H) {
    const { n, O, C, L, sma } = H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 80) break;
      const m20 = sma(C, s, 20), m60 = sma(C, s, 60);
      if (!(m20 > m60 && m60 > sma(C, s - 5, 60))) continue;                // 多頭排列、季線上彎
      if (!(C[s - 1] < O[s - 1] && (O[s - 1] - C[s - 1]) / C[s - 2] >= 0.01)) continue; // 前一天明顯黑K
      if (!(O[s] <= C[s - 1] && C[s] > O[s - 1] && C[s] > O[s])) continue;  // 長紅實體吞噬
      const lo = Math.min(L[s - 1], L[s]);
      if (!(lo <= m20 * 1.02 && lo >= m20 * 0.96 && C[s] > m20)) continue;  // 在月線附近守住
      if (!(H.maxH(s - 15, s - 1) >= C[s] * 1.03)) continue;                // 是拉回，不是在高點
      if (C[s] >= C[s - 1] * 1.095 && C[s] >= H.H[s]) continue;             // 鎖漲停買不到
      const volRatio = H.volRatio(s), cs = H.closeStr(s), body = H.body(s);
      const fails = [];
      if (body < P.minBody) fails.push(`紅K實體只有 ${body.toFixed(1)}%（要 ${P.minBody}%）`);
      if (!(H.V[s] > H.V[s - 1])) fails.push('量沒有比前一天大');
      if (cs < 0.6) fails.push('收盤沒有收在當天高檔');
      if (fails.length > 1) continue;
      const stop = lo * 0.995, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.015) continue;
      const pl = H.plan(s, stop, C[s] + 2 * risk0);
      const checks = [
        { k: '長紅K', ok: body >= P.minBody, pts: body >= P.minBody ? 12 : 0 },
        { k: '量增', ok: H.V[s] > H.V[s - 1], pts: H.V[s] > H.V[s - 1] ? Math.min(16, 8 + Math.max(0, volRatio - 1) * 6) : 0 },
        { k: '收在高檔', ok: cs >= 0.6, pts: cs >= 0.6 ? 8 : 0 },
        { k: '風險≤6%', ok: pl.risk <= 6, pts: pl.risk <= 6 ? 6 : 0 },
      ];
      return [{ sigIdx: s, ...pl, checks, score: H.score(checks), miss: fails[0] || null,
        level: m20, levelLabel: '月線', low: lo, volRatio, body, depth: (H.maxH(s - 15, s - 1) / lo - 1) * 100,
        desc: `拉回月線長紅吞噬（實體 ${body.toFixed(1)}%）`, descShort: `反彈月線長黑吞噬（實體 ${body.toFixed(1)}%）` }];
    }
    return [];
  }
};
