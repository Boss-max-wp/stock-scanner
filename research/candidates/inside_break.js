// 候選型態：多頭母子線突破（只做多）
// 白話：多頭排列（月線在季線之上、季線往上、股價在月線上）。先出現一根比較大的K線（母線），
// 接下來 1～3 天都縮在母線的高低點範圍裡面（子線，代表多空暫停、在整理），
// 今天收紅K、收盤突破母線最高點——「整理完，往上選方向」。
// 停損：母線最低點下方。目標：2 倍停損距離。
module.exports = {
  key: 'inside_break',
  names: ['多頭母子線突破', '空頭母子線跌破'],
  status: 'candidate',
  dirs: ['long'],
  desc: '多頭裡大K線後縮 1～3 天，紅K收盤突破母線高點',
  detect(bars, P, H) {
    const { n, O, C, L, V, sma } = H;
    const Hi = H.H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 90) break;
      const m20 = sma(C, s, 20), m60 = sma(C, s, 60);
      if (!(m20 > m60 && m60 > sma(C, s - 10, 60) && C[s] > m20)) continue; // 多頭排列
      if (!(C[s] > O[s])) continue;                                         // 今天紅K
      // 找母線：s-1..s-k 都是子線（高點不超過母線、低點不低於母線），k = 1～3
      let found = -1;
      for (let k = 1; k <= 3; k++) {
        const m = s - k - 1;
        let ok = true;
        for (let j = m + 1; j <= s - 1; j++) if (Hi[j] > Hi[m] || L[j] < L[m]) { ok = false; break; }
        if (!ok) break;                                                     // 再往前也不可能成立
        // 母線要夠大（振幅 3%～9%），母線前一天不能也包住它（取最外層）
        const rng = (Hi[m] - L[m]) / C[m - 1];
        if (rng >= 0.03 && rng <= 0.09) { found = m; }
      }
      if (found < 0) continue;
      const m = found, k = s - m - 1;
      if (!(C[s] > Hi[m])) continue;                                        // 收盤突破母線高點
      if (C[s] >= C[s - 1] * 1.095 && C[s] >= Hi[s]) continue;              // 鎖漲停買不到
      const volRatio = H.volRatio(s), cs = H.closeStr(s), body = H.body(s);
      const fails = [];
      if (volRatio < 1.2) fails.push(`量比只有 ${volRatio.toFixed(2)} 倍（要 1.2 倍）`);
      if (body < P.minBody * 0.67) fails.push(`紅K實體只有 ${body.toFixed(1)}%（要 ${(P.minBody * 0.67).toFixed(1)}%）`);
      if (cs < 0.6) fails.push('收盤沒有收在當天高檔');
      if (fails.length > 1) continue;
      const lo = L[m];
      const stop = lo * 0.995, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.015) continue;
      const pl = H.plan(s, stop, C[s] + 2 * risk0);
      const checks = [
        { k: '量放大', ok: volRatio >= 1.2, pts: volRatio >= 1.2 ? Math.min(16, 8 + (volRatio - 1) * 6) : 0 },
        { k: '紅K夠長', ok: body >= P.minBody * 0.67, pts: body >= P.minBody * 0.67 ? 10 : 0 },
        { k: '收在高檔', ok: cs >= 0.6, pts: cs >= 0.6 ? 8 : 0 },
        { k: '風險≤6%', ok: pl.risk <= 6, pts: pl.risk <= 6 ? 6 : 0 },
      ];
      return [{ sigIdx: s, ...pl, checks, score: H.score(checks), miss: fails[0] || null,
        level: Hi[m], levelLabel: '母線高點', low: lo, volRatio, body, depth: (Hi[m] / lo - 1) * 100,
        desc: `母線後縮 ${k} 天，紅K突破母線高點`, descShort: `母線後縮 ${k} 天，黑K跌破母線低點` }];
    }
    return [];
  }
};
