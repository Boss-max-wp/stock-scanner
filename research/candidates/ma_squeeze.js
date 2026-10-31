// 候選型態：均線糾結突破（只做多）
// 白話：5 日、10 日、20 日均線連續 5 天擠在 3% 以內（均線糾結＝大家成本差不多、方向還沒決定），
// 而且股價在季線之上；今天紅K收盤同時站上三條均線、突破近 10 天最高收盤——台股說「均線糾結，帶量表態」。
// 停損：近 10 天最低點下方。目標：2 倍停損距離。
module.exports = {
  key: 'ma_squeeze',
  names: ['均線糾結突破', '均線糾結跌破'],
  status: 'candidate',
  dirs: ['long'],
  desc: '5/10/20 日線糾結 5 天後，紅K站上三線並突破 10 日高',
  detect(bars, P, H) {
    const { n, O, C, L, sma } = H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 80) break;
      // 前 5 天（s-5 ～ s-1）三條均線都糾結在 3% 以內
      let tight = true, maxSpread = 0;
      for (let k = s - 5; k <= s - 1 && tight; k++) {
        const a = sma(C, k, 5), b = sma(C, k, 10), c = sma(C, k, 20);
        const sp = Math.max(a, b, c) / Math.min(a, b, c) - 1;
        maxSpread = Math.max(maxSpread, sp);
        if (sp > 0.03) tight = false;
      }
      if (!tight) continue;
      const m5 = sma(C, s, 5), m10 = sma(C, s, 10), m20 = sma(C, s, 20), m60 = sma(C, s, 60);
      if (!(C[s] > m60)) continue;                                          // 季線之上
      if (!(m20 >= sma(C, s - 5, 20))) continue;                            // 月線沒有往下
      if (!(C[s] > Math.max(m5, m10, m20) && C[s] > O[s])) continue;        // 紅K站上三線
      const hi10 = H.maxC(s - 10, s - 1);
      if (!(C[s] > hi10)) continue;                                         // 突破 10 日最高收盤
      if (C[s] >= C[s - 1] * 1.095 && C[s] >= H.H[s]) continue;             // 鎖漲停買不到
      const volRatio = H.volRatio(s), cs = H.closeStr(s), body = H.body(s);
      const fails = [];
      if (volRatio < P.volMult) fails.push(`量比只有 ${volRatio.toFixed(2)} 倍（要 ${P.volMult} 倍）`);
      if (body < P.minBody) fails.push(`紅K實體只有 ${body.toFixed(1)}%（要 ${P.minBody}%）`);
      if (cs < 0.6) fails.push('收盤沒有收在當天高檔');
      if (fails.length > 1) continue;
      const lo = H.minL(s - 10, s);
      const stop = lo * 0.995, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.015) continue;
      const pl = H.plan(s, stop, C[s] + 2 * risk0);
      const checks = [
        { k: '帶量', ok: volRatio >= P.volMult, pts: volRatio >= P.volMult ? Math.min(20, 10 + (volRatio - P.volMult) * 5) : 0 },
        { k: '長紅K', ok: body >= P.minBody, pts: body >= P.minBody ? 10 : 0 },
        { k: '收在高檔', ok: cs >= 0.6, pts: cs >= 0.6 ? 8 : 0 },
        { k: '風險≤6%', ok: pl.risk <= 6, pts: pl.risk <= 6 ? 6 : 0 },
      ];
      return [{ sigIdx: s, ...pl, checks, score: H.score(checks), miss: fails[0] || null,
        level: hi10, levelLabel: '10日最高收盤', low: lo, volRatio, body, depth: maxSpread * 100,
        desc: `均線糾結 ${(maxSpread * 100).toFixed(1)}% 後紅K突破`, descShort: `均線糾結 ${(maxSpread * 100).toFixed(1)}% 後黑K跌破` }];
    }
    return [];
  }
};
