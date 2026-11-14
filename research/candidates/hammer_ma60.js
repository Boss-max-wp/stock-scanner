// 候選型態：拉回季線的長下影線（只做多）
// 白話：季線往上，股價從高點拉回 5% 以上，今天盤中殺到季線附近、尾盤被買回來，
// 留下長長的下影線（下影線至少是實體的 2 倍、佔當天高低差一半以上），收盤站在季線上、收在當天高檔——
// 「季線有人接」。停損：今天最低點下方。目標：2 倍停損距離。
module.exports = {
  key: 'hammer_ma60',
  names: ['季線長下影線', '季線長上影線'],
  status: 'candidate',
  dirs: ['long'],
  desc: '拉回季線，盤中殺低被買回留長下影線',
  detect(bars, P, H) {
    const { n, O, C, L, sma } = H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 90) break;
      const m60 = sma(C, s, 60);
      if (!(m60 > sma(C, s - 10, 60))) continue;                         // 季線上彎
      if (!(L[s] <= m60 * 1.02 && L[s] >= m60 * 0.96 && C[s] > m60)) continue; // 盤中碰季線、收在季線上
      if (!(H.maxH(s - 15, s - 1) >= C[s] * 1.04)) continue;             // 是拉回，不是在高點
      const rng = H.H[s] - L[s];
      if (!(rng / C[s - 1] >= 0.025)) continue;                           // 當天振幅夠大
      const bodyAbs = Math.abs(C[s] - O[s]), lowerShadow = Math.min(O[s], C[s]) - L[s];
      if (!(lowerShadow >= 1.5 * bodyAbs && lowerShadow >= 0.4 * rng)) continue; // 長下影線
      if (C[s] >= C[s - 1] * 1.095) continue;
      const volRatio = H.volRatio(s), cs = H.closeStr(s);
      const fails = [];
      if (volRatio < 1) fails.push(`量比只有 ${volRatio.toFixed(2)} 倍（要比 20 日均量大）`);
      if (cs < 0.7) fails.push('收盤沒有收在當天高檔');
      if (!(C[s] >= C[s - 1])) fails.push('收盤比昨天低');
      if (fails.length > 1) continue;
      const stop = L[s] * 0.995, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.015) continue;
      const pl = H.plan(s, stop, C[s] + 2 * risk0);
      const checks = [
        { k: '量放大', ok: volRatio >= 1, pts: volRatio >= 1 ? Math.min(16, 8 + (volRatio - 1) * 6) : 0 },
        { k: '收在高檔', ok: cs >= 0.7, pts: cs >= 0.7 ? 10 : 0 },
        { k: '收平盤以上', ok: C[s] >= C[s - 1], pts: C[s] >= C[s - 1] ? 8 : 0 },
        { k: '風險≤6%', ok: pl.risk <= 6, pts: pl.risk <= 6 ? 6 : 0 },
      ];
      return [{ sigIdx: s, ...pl, checks, score: H.score(checks), miss: fails[0] || null,
        level: m60, levelLabel: '季線', low: L[s], volRatio, body: H.body(s), depth: (H.maxH(s - 15, s - 1) / L[s] - 1) * 100,
        desc: `拉回季線留 ${(lowerShadow / C[s - 1] * 100).toFixed(1)}% 下影線`, descShort: `反彈季線留 ${(lowerShadow / C[s - 1] * 100).toFixed(1)}% 上影線` }];
    }
    return [];
  }
};
