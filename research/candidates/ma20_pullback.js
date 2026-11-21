// 候選型態：多頭回檔月線（只做多，第 1 週版本 + 季線上彎、月線上彎過濾）
// 白話：月線、季線都往上，月線在季線之上；股價先漲一大段（15% 以上），
// 3～15 天前做出高點後拉回 5～18%、碰到月線附近，今天收紅K、收盤站上昨天最高點——「回檔到月線，重新轉強」。
// 停損：回檔低點下方。目標：前波高點（至少 1.5 倍停損距離）。
module.exports = {
  key: 'ma20_pullback',
  names: ['多頭回檔月線', '空頭反彈月線'],
  status: 'candidate',
  dirs: ['long'],
  desc: '先漲一段、拉回碰月線，紅K站上昨高',
  detect(bars, P, H) {
    const { n, O, C, L, V, sma } = H;
    const Hi = H.H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 90) break;
      const m20 = sma(C, s, 20), m60 = sma(C, s, 60);
      if (!(m20 > m60)) continue;
      if (!(m20 > sma(C, s - 5, 20) && m60 > sma(C, s - 10, 60))) continue; // 月線、季線都上彎
      if (!(C[s] > O[s] && C[s] > Hi[s - 1] && C[s] > m20)) continue;       // 紅K站上昨高、在月線上
      // 前波高點：3～15 天前
      let p = s - 3;
      for (let j = s - 15; j <= s - 3; j++) if (Hi[j] > Hi[p]) p = j;
      if (H.maxH(p + 1, s) > Hi[p]) continue;                                // 之後不能再創高
      const runLow = H.minL(p - 20, p);
      if (!(Hi[p] / runLow >= 1.15)) continue;                               // 先漲 15% 以上
      const lo = H.minL(p + 1, s);
      const drop = (Hi[p] - lo) / Hi[p];
      if (!(drop >= 0.05 && drop <= 0.18)) continue;                         // 拉回 5～18%
      const loIdx = (() => { let q = p + 1; for (let j = p + 1; j <= s; j++) if (L[j] < L[q]) q = j; return q; })();
      const ma20AtLo = sma(C, loIdx, 20);
      if (!(lo <= ma20AtLo * 1.02 && lo >= ma20AtLo * 0.95)) continue;       // 低點碰到月線附近
      if (C[s] >= C[s - 1] * 1.095 && C[s] >= Hi[s]) continue;               // 鎖漲停買不到
      const volRatio = H.volRatio(s), cs = H.closeStr(s), body = H.body(s);
      const fails = [];
      if (!(V[s] > V[s - 1])) fails.push('量沒有比前一天大');
      if (body < P.minBody * 0.5) fails.push(`紅K實體只有 ${body.toFixed(1)}%（要 ${(P.minBody * 0.5).toFixed(1)}%）`);
      if (cs < 0.6) fails.push('收盤沒有收在當天高檔');
      if (fails.length > 1) continue;
      const stop = lo * 0.995, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.015) continue;
      if (!((Hi[p] - C[s]) / risk0 >= 1.5)) continue;                         // 到前高至少 1.5R
      const pl = H.plan(s, stop, Hi[p]);
      const checks = [
        { k: '量增', ok: V[s] > V[s - 1], pts: V[s] > V[s - 1] ? Math.min(16, 8 + Math.max(0, volRatio - 1) * 6) : 0 },
        { k: '紅K夠長', ok: body >= P.minBody * 0.5, pts: body >= P.minBody * 0.5 ? 10 : 0 },
        { k: '收在高檔', ok: cs >= 0.6, pts: cs >= 0.6 ? 8 : 0 },
        { k: '風險≤6%', ok: pl.risk <= 6, pts: pl.risk <= 6 ? 6 : 0 },
      ];
      return [{ sigIdx: s, ...pl, checks, score: H.score(checks), miss: fails[0] || null,
        level: ma20AtLo, levelLabel: '月線', low: lo, volRatio, body, depth: drop * 100,
        desc: `前高拉回 ${(drop * 100).toFixed(0)}% 碰月線後轉強`, descShort: `前低反彈 ${(drop * 100).toFixed(0)}% 碰月線後轉弱` }];
    }
    return [];
  }
};
