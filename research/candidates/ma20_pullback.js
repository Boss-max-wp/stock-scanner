// 候選型態：多頭回檔月線（只做多）
// 白話：股票原本一路漲（月線往上、在季線之上、前面漲了 15% 以上），
// 最近 3～15 天從高點拉回 5～18%，低點剛好碰到月線附近（月線上下 2～4%）沒跌破，
// 今天收紅K、而且收盤站上昨天高點 → 回檔結束、重新上攻。
// 停損：這段回檔的最低點。目標：前波高點（至少 1.5 倍停損距離）。
module.exports = {
  key: 'ma20_pullback',
  names: ['多頭回檔月線', '空頭反彈月線'],
  status: 'candidate',
  dirs: ['long'],
  desc: '多頭股拉回月線附近止跌，紅K站上前一天高點',
  detect(bars, P, H) {
    const { n, O, C, L, sma } = H;
    for (let s = n - 1; s >= n - P.recent; s--) {
      if (s < 80) break;
      const ma20 = sma(C, s, 20), ma20p = sma(C, s - 5, 20), ma60 = sma(C, s, 60);
      if (!(ma20 > ma20p && ma20 > ma60)) continue;                 // 月線上彎、在季線之上
      // 前波高點：3～15 天前
      let hi = -Infinity, hiIdx = -1;
      for (let i = s - 15; i <= s - 3; i++) if (H.H[i] > hi) { hi = H.H[i]; hiIdx = i; }
      if (hi < H.maxH(s - 2, s)) continue;                         // 最近兩天又創高就不是回檔
      const before = H.minC(s - 60, hiIdx - 10);
      if (!(hi >= before * 1.15)) continue;                        // 之前有一段漲幅
      const pl = H.minL(hiIdx + 1, s);
      const depth = (hi - pl) / hi * 100;
      if (depth < 5 || depth > 18) continue;
      if (!(pl <= ma20 * 1.02 && pl >= ma20 * 0.96)) continue;      // 低點碰到月線附近
      let broke = false; for (let i = hiIdx + 1; i <= s; i++) if (C[i] < sma(C, i, 20) * 0.97) broke = true;
      if (broke) continue;                                          // 收盤沒有明顯跌破月線
      if (!(C[s] > O[s] && C[s] > H.H[s - 1] && C[s] > ma20)) continue; // 今天紅K站上昨天高點
      const volRatio = H.volRatio(s), body = H.body(s), cs = H.closeStr(s);
      const fails = [];
      if (volRatio < 1) fails.push(`量比只有 ${volRatio.toFixed(2)} 倍（要 1 倍以上）`);
      if (cs < 0.6) fails.push('收盤不夠接近當天高點');
      if (fails.length > 1) continue;
      const stop = pl, risk0 = C[s] - stop;
      if (!(risk0 > 0) || risk0 / C[s] > 0.10 || risk0 / C[s] < 0.01) continue;
      const pl2 = H.plan(s, stop, Math.max(hi, C[s] + 1.5 * risk0));
      const checks = [
        { k: '量比≥1', ok: volRatio >= 1, pts: volRatio >= 1 ? Math.min(15, 8 + (volRatio - 1) * 6) : 0 },
        { k: '收在高檔', ok: cs >= 0.6, pts: cs >= 0.6 ? 10 : 0 },
        { k: '回檔量縮', ok: H.avgV(s - 1, 3) < H.avgV(hiIdx, 5), pts: H.avgV(s - 1, 3) < H.avgV(hiIdx, 5) ? 8 : 0 },
        { k: '風險≤6%', ok: pl2.risk <= 6, pts: pl2.risk <= 6 ? 8 : 0 },
        { k: '風報比≥2', ok: pl2.rr >= 2, pts: pl2.rr >= 2 ? 6 : 0 },
      ];
      return [{ sigIdx: s, ...pl2, checks, score: H.score(checks), miss: fails[0] || null,
        level: ma20, levelLabel: '月線', low: pl, volRatio, body, depth,
        desc: `從前高回檔 ${depth.toFixed(0)}% 碰月線後紅K站上前日高點`, descShort: `反彈 ${depth.toFixed(0)}% 碰月線後黑K跌破前日低點` }];
    }
    return [];
  }
};
