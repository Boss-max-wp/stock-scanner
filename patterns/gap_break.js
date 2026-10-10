// 實驗中型態：跳空缺口突破（只做多）
// 白話：股價在季線之上，今天開高「跳空」——整天最低價都比昨天最高價還高（留下缺口），
// 而且收盤創 20 日新高、量放大。台股常說「缺口不補，續攻」。
// 停損：缺口被回補（跌回昨天最高價下方）。目標：2 倍停損距離。
// 收在鎖漲停的不算（實際上很難買到）。
module.exports = {
  key: 'gap_break',
  names: ['跳空突破', '跳空跌破'],
  status: 'experimental',
  added: '2026-10-10',
  backtest: '2025-01～2026-09 回測 584 筆（只做多），達標率 31%、停損率 49%，平均 +0.19R；前半 +0.19R（260 筆）、後半 +0.20R（324 筆）、近半年 +0.29R；與現有型態重疊 13%',
  dirs: ['long'],
  desc: '向上跳空留缺口並收在 20 日新高，缺口不補就續抱',
  detect(bars, P, H) {
    const { n, O, C, L, sma } = H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 80) break;
      const gapBottom = H.H[s - 1];
      if (!(L[s] > gapBottom * 1.003)) continue;                     // 真正的跳空缺口
      if (!(C[s] >= H.maxH(s - 20, s - 1))) continue;                // 收盤創 20 日新高
      if (!(C[s] > sma(C, s, 60))) continue;                         // 在季線之上
      if (C[s] >= C[s - 1] * 1.095 && C[s] >= H.H[s]) continue;      // 鎖漲停買不到，不算
      const volRatio = H.volRatio(s), cs = H.closeStr(s);
      const fails = [];
      if (volRatio < P.volMult) fails.push(`量比只有 ${volRatio.toFixed(2)} 倍（要 ${P.volMult} 倍）`);
      if (cs < 0.5) fails.push('收盤在當天下半部（追價力道弱）');
      if (fails.length > 1) continue;
      const stop = gapBottom * 0.995, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.015) continue;
      const pl = H.plan(s, stop, C[s] + 2 * risk0);
      const gap = (L[s] / gapBottom - 1) * 100;
      const checks = [
        { k: '帶量跳空', ok: volRatio >= P.volMult, pts: volRatio >= P.volMult ? Math.min(20, 10 + (volRatio - P.volMult) * 5) : 0 },
        { k: '收在高檔', ok: cs >= 0.5, pts: cs >= 0.5 ? 10 : 0 },
        { k: '紅K', ok: C[s] > O[s], pts: C[s] > O[s] ? 6 : 0 },
        { k: '風險≤6%', ok: pl.risk <= 6, pts: pl.risk <= 6 ? 8 : 0 },
      ];
      return [{ sigIdx: s, ...pl, checks, score: H.score(checks), miss: fails[0] || null,
        level: gapBottom, levelLabel: '缺口下緣', low: L[s], volRatio, body: H.body(s), depth: gap,
        desc: `跳空 ${gap.toFixed(1)}% 留缺口、收 20 日新高`, descShort: `跳空 ${gap.toFixed(1)}% 向下留缺口、收 20 日新低` }];
    }
    return [];
  }
};
