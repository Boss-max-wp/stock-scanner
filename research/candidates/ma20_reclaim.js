// 候選型態：月線假跌破、三天內收復（只做多）
// 白話：月線往上、股價原本一直站在月線上；最近 1～3 天突然收盤跌破月線（但沒有跌太深），
// 今天馬上收紅K、收盤重新站回月線，而且高過跌破那幾天的收盤——「跌破月線是洗盤」。
// 停損：跌破那幾天的最低點下方。目標：2 倍停損距離。
module.exports = {
  key: 'ma20_reclaim',
  names: ['月線假跌破收復', '月線假突破跌回'],
  status: 'candidate',
  dirs: ['long'],
  desc: '月線上彎，跌破月線 1～3 天後紅K收復',
  detect(bars, P, H) {
    const { n, O, C, V, sma } = H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 90) break;
      const m20 = sma(C, s, 20), m60 = sma(C, s, 60);
      if (!(m20 > sma(C, s - 5, 20))) continue;                          // 月線上彎
      if (!(C[s] > m60 && m20 > m60 && m60 > sma(C, s - 10, 60))) continue;  // 第2輪：多頭排列、季線上彎
      if (!(C[s] > m20 && C[s] > O[s])) continue;                        // 今天紅K站回月線
      let k = s - 1, below = 0;
      while (k > s - 5 && C[k] < sma(C, k, 20)) { below++; k--; }
      if (below < 1 || below > 3) continue;
      let above = 0;
      for (let j = k - 14; j <= k; j++) if (C[j] > sma(C, j, 20)) above++;
      if (above < 12) continue;                                          // 跌破前 15 天至少 12 天在月線上
      const lo = H.minL(s - below, s);
      if (!(lo >= m20 * 0.95)) continue;                                 // 跌破不能太深
      if (!(C[s] > H.maxC(s - below, s - 1))) continue;                  // 收盤高過跌破那幾天
      if (C[s] >= C[s - 1] * 1.095 && C[s] >= H.H[s]) continue;          // 鎖漲停買不到
      const volRatio = H.volRatio(s), cs = H.closeStr(s), body = H.body(s);
      const fails = [];
      if (!(V[s] > V[s - 1])) fails.push('量沒有比前一天大');
      if (body < P.minBody * 0.67) fails.push(`紅K實體只有 ${body.toFixed(1)}%（要 ${(P.minBody * 0.67).toFixed(1)}%）`);
      if (cs < 0.6) fails.push('收盤沒有收在當天高檔');
      if (fails.length > 1) continue;
      const stop = lo * 0.995, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.015) continue;
      const pl = H.plan(s, stop, C[s] + 2 * risk0);
      const checks = [
        { k: '量增', ok: V[s] > V[s - 1], pts: V[s] > V[s - 1] ? Math.min(16, 8 + Math.max(0, volRatio - 1) * 6) : 0 },
        { k: '紅K夠長', ok: body >= P.minBody * 0.67, pts: body >= P.minBody * 0.67 ? 10 : 0 },
        { k: '收在高檔', ok: cs >= 0.6, pts: cs >= 0.6 ? 8 : 0 },
        { k: '風險≤6%', ok: pl.risk <= 6, pts: pl.risk <= 6 ? 6 : 0 },
      ];
      return [{ sigIdx: s, ...pl, checks, score: H.score(checks), miss: fails[0] || null,
        level: m20, levelLabel: '月線', low: lo, volRatio, body, depth: (m20 / lo - 1) * 100,
        desc: `跌破月線 ${below} 天後紅K收復`, descShort: `站上月線 ${below} 天後黑K跌回` }];
    }
    return [];
  }
};
