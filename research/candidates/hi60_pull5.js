// 候選型態：強勢股創 60 日新高後，第一次拉回 5 日線的紅K（只做多）
// 白話：股票先大漲（20 天內漲 15% 以上）並創 60 天新高；之後 2～8 天小幅拉回，
// 第一次碰到 5 日線（回檔 3～12%、沒有跌破月線），今天收紅K、收盤高過昨天最高價——「強勢股短回，再攻」。
// 停損：這次拉回的最低點下方。目標：2 倍停損距離。
module.exports = {
  key: 'hi60_pull5',
  names: ['強勢股首次回5日線', '弱勢股首次彈5日線'],
  status: 'candidate',
  dirs: ['long'],
  desc: '創 60 日新高後第一次拉回 5 日線，紅K再攻',
  detect(bars, P, H) {
    const { n, O, C, L, V, sma } = H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 90) break;
      // 找 2～8 天前的波段高點：創 60 日新高、之前 20 天漲 ≥15%
      let p = -1;
      for (let q = s - 2; q >= s - 8; q--) {
        if (H.H[q] >= H.maxH(q - 59, q) && H.H[q] >= H.maxH(q, s) && C[q] >= H.minC(q - 20, q) * 1.15) { p = q; break; }
      }
      if (p < 0) continue;
      // 從高點後，第一次碰 5 日線是昨天或今天
      let touch = -1, early = false;
      for (let k = p + 1; k <= s; k++) {
        if (L[k] <= sma(C, k, 5)) { if (k < s - 1) early = true; touch = k; break; }
      }
      if (early || touch < 0) continue;
      const lo = H.minL(p + 1, s), peak = H.H[p];
      const depth = peak / lo - 1;
      if (!(depth >= 0.03 && depth <= 0.12)) continue;
      if (!(lo > sma(C, s, 20))) continue;                               // 沒跌破月線
      if (!(C[s] > O[s] && C[s] > H.H[s - 1] && C[s] > sma(C, s, 5))) continue; // 紅K過昨高、站回5日線
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
        level: peak, levelLabel: '前波高點', low: lo, volRatio, body, depth: depth * 100,
        desc: `創新高後回檔 ${(depth * 100).toFixed(1)}% 碰5日線，紅K再攻`, descShort: `創新低後反彈 ${(depth * 100).toFixed(1)}% 碰5日線，黑K再跌` }];
    }
    return [];
  }
};
