// 候選型態：跌深後第一次站回 10 日線（只做多）
// 白話：季線還往上的股票，短線從 20 天內高點跌了 10%～25%，而且已經連續 5 天以上收在 10 日線下；
// 今天收紅K、收盤站回 10 日線並高過昨天最高價——「跌深後第一次站回短均線」。
// 停損：這波下跌的最低點下方。目標：2 倍停損距離。
module.exports = {
  key: 'ma10_first_reclaim',
  names: ['跌深站回10日線', '漲多跌破10日線'],
  status: 'candidate',
  dirs: ['long'],
  desc: '短線跌深後第一次帶量站回 10 日線',
  detect(bars, P, H) {
    const { n, O, C, L, H: Hi, V, sma } = H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 90) break;
      const m60 = sma(C, s, 60);
      if (!(m60 > sma(C, s - 10, 60))) continue;                              // 季線上彎（長期還是多頭）
      // 昨天往前連續收在 10 日線下的天數
      let below = 0;
      for (let i = s - 1; i >= s - 20; i--) { if (C[i] < sma(C, i, 10)) below++; else break; }
      if (below < 5) continue;
      const m10 = sma(C, s, 10);
      if (!(C[s] > O[s] && C[s] > m10 && C[s] > Hi[s - 1])) continue;          // 紅K站回 10 日線、過昨高
      const hi = H.maxH(s - 20, s - 1), lo = H.minL(s - below - 1, s);
      const drop = (1 - lo / hi) * 100;
      if (drop < 10 || drop > 25) continue;                                   // 跌深 10%～25%
      if (C[s] >= C[s - 1] * 1.095 && C[s] >= Hi[s]) continue;                // 鎖漲停買不到
      const volRatio = H.volRatio(s), cs = H.closeStr(s), body = H.body(s);
      const fails = [];
      if (volRatio < 1.2) fails.push(`量比只有 ${volRatio.toFixed(2)}（要 1.2）`);
      if (body < 2) fails.push(`紅K實體只有 ${body.toFixed(1)}%（要 2%）`);
      if (cs < 0.6) fails.push('收盤沒有收在當天高檔');
      if (fails.length > 1) continue;
      const stop = lo * 0.995, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.015) continue;
      const pl = H.plan(s, stop, C[s] + 2 * risk0);
      const checks = [
        { k: '量增', ok: volRatio >= 1.2, pts: volRatio >= 1.2 ? Math.min(16, 8 + (volRatio - 1) * 6) : 0 },
        { k: '長紅K', ok: body >= 2, pts: body >= 2 ? 10 : 0 },
        { k: '收在高檔', ok: cs >= 0.6, pts: cs >= 0.6 ? 8 : 0 },
        { k: '風險≤6%', ok: pl.risk <= 6, pts: pl.risk <= 6 ? 6 : 0 },
      ];
      return [{ sigIdx: s, ...pl, checks, score: H.score(checks), miss: fails[0] || null,
        level: m10, levelLabel: '10日線', low: lo, volRatio, body, depth: drop,
        desc: `跌深 ${drop.toFixed(0)}% 後站回 10 日線`, descShort: `漲多 ${drop.toFixed(0)}% 後跌破 10 日線` }];
    }
    return [];
  }
};
