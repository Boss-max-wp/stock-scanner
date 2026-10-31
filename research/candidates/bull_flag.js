// 候選型態：多頭旗形再攻（只做多）
// 白話：股價先在 10 天內急漲 12% 以上（旗竿），之後 2～8 天小幅拉回整理、量縮（旗面），
// 拉回不超過漲幅的一半、也沒跌破月線；今天帶量紅K突破整理期間的最高點——台股說「強勢股休息完再攻」。
// 停損：整理期間最低點下方。目標：1.5 倍停損距離（第二輪：原本 2 倍達標率太低）。
module.exports = {
  key: 'bull_flag',
  names: ['旗形整理再攻', '旗形整理再跌'],
  status: 'candidate',
  dirs: ['long'],
  desc: '急漲後量縮小回檔整理，帶量突破整理區高點',
  detect(bars, P, H) {
    const { n, O, C, L, V, sma } = H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 80) break;
      // 旗竿頂：s-9 ～ s-3 之間的最高點
      let p = s - 3;
      for (let k = s - 9; k <= s - 3; k++) if (H.H[k] > H.H[p]) p = k;
      if (H.H[p] < H.maxH(s - 9, s - 1)) continue;                        // 旗面期間不能再創高
      const poleLo = H.minL(p - 10, p), poleHi = H.H[p];
      if (!(poleHi / poleLo - 1 >= 0.12)) continue;                        // 旗竿：10 天內漲 12% 以上
      const flagLo = H.minL(p + 1, s - 1), flagHi = H.maxH(p + 1, s - 1);
      if (!(poleHi / flagLo - 1 >= 0.03)) continue;                        // 真的有拉回
      if (!(flagLo >= poleHi - 0.5 * (poleHi - poleLo))) continue;         // 回檔不超過漲幅一半
      const m20 = sma(C, s, 20);
      if (!(flagLo > m20 * 0.98 && C[s] > m20 && C[s] > sma(C, s, 60))) continue; // 守住月線、在季線上
      const flagN = s - 1 - p;
      const flagV = H.avgV(s - 1, flagN), poleV = H.avgV(p, 5);
      if (!(flagV < poleV * 0.8)) continue;                                // 整理量縮
      if (!(C[s] > flagHi && C[s] > O[s])) continue;                       // 紅K突破整理區高點
      if (C[s] >= C[s - 1] * 1.095 && C[s] >= H.H[s]) continue;            // 鎖漲停買不到
      const volRatio = H.volRatio(s), cs = H.closeStr(s), body = H.body(s);
      const fails = [];
      if (volRatio < P.volMult) fails.push(`量比只有 ${volRatio.toFixed(2)} 倍（要 ${P.volMult} 倍）`);
      if (body < P.minBody) fails.push(`紅K實體只有 ${body.toFixed(1)}%（要 ${P.minBody}%）`);
      if (cs < 0.6) fails.push('收盤沒有收在當天高檔');
      if (fails.length > 1) continue;
      const stop = flagLo * 0.995, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.015) continue;
      const pl = H.plan(s, stop, C[s] + 1.5 * risk0);
      const checks = [
        { k: '帶量', ok: volRatio >= P.volMult, pts: volRatio >= P.volMult ? Math.min(20, 10 + (volRatio - P.volMult) * 5) : 0 },
        { k: '長紅K', ok: body >= P.minBody, pts: body >= P.minBody ? 10 : 0 },
        { k: '收在高檔', ok: cs >= 0.6, pts: cs >= 0.6 ? 8 : 0 },
        { k: '風險≤6%', ok: pl.risk <= 6, pts: pl.risk <= 6 ? 6 : 0 },
      ];
      const pole = (poleHi / poleLo - 1) * 100;
      return [{ sigIdx: s, ...pl, checks, score: H.score(checks), miss: fails[0] || null,
        level: flagHi, levelLabel: '旗面高點', low: flagLo, volRatio, body, depth: (poleHi / flagLo - 1) * 100,
        desc: `急漲 ${pole.toFixed(0)}% 後整理 ${flagN} 天，帶量突破`, descShort: `急跌 ${pole.toFixed(0)}% 後整理 ${flagN} 天，帶量跌破` }];
    }
    return [];
  }
};
