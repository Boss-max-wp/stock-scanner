// 實驗中型態：季線假跌破、三天內收復（只做多）
// 白話：季線往上、股價原本一直站在季線上；最近 1～3 天突然收盤跌破季線（但沒有跌太深），
// 今天馬上收紅K、收盤重新站回季線，而且高過跌破那幾天的收盤——「跌破季線是假的，主力洗盤」。
// 停損：跌破那幾天的最低點下方。目標：2 倍停損距離。
module.exports = {
  key: 'ma60_reclaim',
  names: ['季線假跌破收復', '季線假突破跌回'],
  status: 'experimental',
  added: '2026-11-07',
  backtest: '2025-02～2026-10 回測 225 筆（只做多），達標率 28%、停損率 36%，平均 +0.29R；前半 +0.16R（87 筆）、後半 +0.37R（138 筆）、近半年 +0.35R（73 筆）；與現有型態重疊 1%',
  dirs: ['long'],
  desc: '季線上彎，跌破季線 1～3 天後紅K收復',
  detect(bars, P, H) {
    const { n, O, C, L, V, sma } = H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 90) break;
      const m60 = sma(C, s, 60);
      if (!(m60 > sma(C, s - 10, 60))) continue;                         // 季線上彎
      if (!(C[s] > m60 && C[s] > O[s])) continue;                        // 今天紅K站回季線
      // 往回找連續收在季線下的天數（1～3 天）
      let k = s - 1, below = 0;
      while (k > s - 5 && C[k] < sma(C, k, 60)) { below++; k--; }
      if (below < 1 || below > 3) continue;
      // 跌破前 20 天至少 15 天收在季線上（原本是守住季線的股票）
      let above = 0;
      for (let j = k - 19; j <= k; j++) if (C[j] > sma(C, j, 60)) above++;
      if (above < 15) continue;
      const lo = H.minL(s - below, s);
      if (!(lo >= m60 * 0.93)) continue;                                 // 跌破不能太深
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
        level: m60, levelLabel: '季線', low: lo, volRatio, body, depth: (m60 / lo - 1) * 100,
        desc: `跌破季線 ${below} 天後紅K收復`, descShort: `站上季線 ${below} 天後黑K跌回` }];
    }
    return [];
  }
};
