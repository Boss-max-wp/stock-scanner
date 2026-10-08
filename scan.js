// 台股選股器：每天由 GitHub Actions 執行。抓 FinMind 日K、跑型態分析、追蹤歷史訊號成績、自動優化參數，產生 public/index.html
// 不需要修改這個檔案。想改條件或股票清單，回到 Claude 對話請它給你新版本。
const fs = require('fs');
// ===== 破底翻 / 假突破 偵測核心 =====
const DEFAULTS = {
  trendDays: 20,     // 趨勢判斷期間（交易日，約4週）
  trendPct: 8,       // 期間內至少跌(漲)幾%
  lookback: 45,      // 往回找前波低(高)點的範圍
  breakWindow: 5,    // 跌破後幾天內必須翻回
  maxDepth: 8,       // 假跌破最大深度%，超過視為真破
  volMult: 1.5,      // 訊號K量 ≥ 20日均量 × 倍數
  minBody: 3,        // 訊號K實體 ≥ 前收的 %
  recent: 3,         // 只看最近幾根K的訊號
  minLots: 500,      // 20日均量至少幾張
  needReclaim: true, // 收盤需收復支撐(跌回壓力)
  baseMin: 12,       // 打底區至少幾天
  baseMax: 40,       // 打底區最多幾天
  baseRange: 18,     // 打底區高低差 ≤ %
  priorDrop: 15,     // 打底前至少從高點跌了幾%
  retestBody: 2,     // 回測後紅K實體 ≥ %
  retestWithin: 8    // 突破後幾天內回測
};

function sma(arr, end, n) { // mean of arr[end-n+1..end]
  if (end - n + 1 < 0) return NaN;
  let s = 0; for (let i = end - n + 1; i <= end; i++) s += arr[i]; return s / n;
}

// bars: [{d,o,h,l,c,v}] v = 張
function analyze(bars, P, dir) {
  const L = dir === 'long';
  const n = bars.length;
  const O = bars.map(b => b.o), H = bars.map(b => b.h), Lo = bars.map(b => b.l), C = bars.map(b => b.c), V = bars.map(b => b.v);
  const need = P.lookback + P.trendDays + 8;
  if (n < Math.max(need, 45)) return null;
  const avgLots = sma(V, n - 1, 20);
  if (avgLots < P.minLots) return null;

  let best = null, near = null;
  for (let s = n - 1; s >= n - P.recent; s--) {
    const r = check(s, true);
    if (!r) continue;
    if (!r.miss) { if (!best || r.score > best.score) best = r; }
    else if (!near || r.score > near.score) near = r;
  }
  if (best) return { kind: 'signal', ...best };
  if (near) return { kind: 'near', ...near };
  const w = check(n - 1, false);
  return w ? { kind: 'wait', ...w } : null;

  // 往回找最近一個「之前沒被跌破、在最近 breakWindow 天內才被跌破」的波段低點
  function findLevel(s, needBreak) {
    for (let i = s - 4; i >= Math.max(5, s - P.lookback); i--) {
      const lv = L ? Lo[i] : H[i];
      let ok = true;
      for (let k = i - 5; k <= i + 3; k++) {          // 左5右3確認轉折
        if (k === i || k < 0) continue;
        if (L ? Lo[k] < lv : H[k] > lv) { ok = false; break; }
      }
      if (!ok) continue;
      let brk = -1;                                    // 第一次跌破的那根
      for (let k = i + 1; k <= s; k++) if (L ? Lo[k] < lv * 0.997 : H[k] > lv * 1.003) { brk = k; break; }
      if (brk < 0) { if (needBreak) continue; else continue; }
      if (brk < s - P.breakWindow + 1) continue;       // 太早就破了，不算假跌破
      return { piv: i, lvl: lv, brk };
    }
    return null;
  }

  function check(s, needSignal) {
    // 1. 趨勢：s-1 往前 trendDays
    const a = s - 1, b = a - P.trendDays;
    if (b < 0) return null;
    const move = (C[a] - C[b]) / C[b] * 100;
    if (L ? move > -P.trendPct : move < P.trendPct) return null;
    const ma20now = sma(C, a, 20), ma20prev = sma(C, a - 5, 20);
    if (L ? !(ma20now < ma20prev) : !(ma20now > ma20prev)) return null;

    // 2. 前波低(高)點與跌破
    const f = findLevel(s, true);
    if (!f) return null;
    const { piv, lvl, brk } = f;

    // 3. 假跌破深度
    let ext = L ? Infinity : -Infinity, extIdx = -1;
    for (let k = brk; k <= s; k++) if (L ? Lo[k] < ext : H[k] > ext) { ext = L ? Lo[k] : H[k]; extIdx = k; }
    const depth = L ? (lvl - ext) / lvl * 100 : (ext - lvl) / lvl * 100;
    if (depth > P.maxDepth) return null;

    const avgV = sma(V, s - 1, 20);
    let bv = 0, bc = 0;
    for (let k = brk; k < s; k++) { bv += V[k]; bc++; }
    const breakVolRatio = bc ? (bv / bc) / avgV : V[s] / avgV;
    let tgt = L ? -Infinity : Infinity;
    for (let k = piv; k < brk; k++) tgt = L ? Math.max(tgt, H[k]) : Math.min(tgt, Lo[k]);

    const base = { level: lvl, pivIdx: piv, extIdx, depth, move, breakVolRatio, avgLots };

    if (!needSignal) {
      if (L ? C[s] >= lvl : C[s] <= lvl) return null;   // 已跌破、尚未翻回
      return { ...base, sigIdx: -1, score: 0, date: bars[s].d, close: C[s] };
    }

    // 4. 吞噬K（顏色必須對；其餘條件允許差一項，列為「接近訊號」）
    const pO = O[s - 1], pC = C[s - 1];
    const prevOk = L ? pC < pO : pC > pO;
    const curOk = L ? C[s] > O[s] : C[s] < O[s];
    if (!(prevOk && curOk)) return null;
    const engulf = L ? (O[s] <= pC * 1.003 && C[s] >= pO) : (O[s] >= pC * 0.997 && C[s] <= pO);
    const body = Math.abs(C[s] - O[s]) / pC * 100;
    const volRatio = V[s] / avgV;
    const reclaim = L ? C[s] > lvl : C[s] < lvl;
    const fails = [];
    if (!engulf) fails.push(L ? '紅K沒有完整包住前一根黑K' : '黑K沒有完整包住前一根紅K');
    if (body < P.minBody) fails.push(`實體只有 ${body.toFixed(1)}%（要 ${P.minBody}%）`);
    if (volRatio < P.volMult) fails.push(`量比只有 ${volRatio.toFixed(2)} 倍（要 ${P.volMult} 倍）`);
    if (P.needReclaim && !reclaim) fails.push(L ? '收盤還沒收回支撐' : '收盤還沒跌回壓力下');
    if (fails.length > 1) return null;

    // 5. 交易計畫
    const entry = C[s], stop = ext;
    const risk = Math.abs(entry - stop) / entry * 100;
    const reward = L ? (tgt - entry) : (entry - tgt);
    const rr = reward > 0 ? reward / Math.abs(entry - stop) : 0;
    const range = H[s] - Lo[s];
    const closeStrength = range > 0 ? (L ? (C[s] - Lo[s]) / range : (H[s] - C[s]) / range) : 0;
    const prevBody = Math.abs(pC - pO);
    const bodyMult = prevBody > 0 ? Math.abs(C[s] - O[s]) / prevBody : 9;

    // 6. 評分
    const volOk = volRatio >= P.volMult;
    const checks = [
      { k: '帶量', ok: volOk, pts: volOk ? Math.min(20, 10 + (volRatio - P.volMult) * 8) : 0 },
      { k: L ? '收復支撐' : '跌回壓力', ok: reclaim, pts: reclaim ? 12 : 0 },
      { k: L ? '破底量縮' : '突破量縮', ok: breakVolRatio < 1, pts: breakVolRatio < 1 ? 10 : 0 },
      { k: L ? '收在高檔' : '收在低檔', ok: closeStrength >= 0.75, pts: closeStrength >= 0.75 ? 8 : 0 },
      { k: '實體≥前K 1.5倍', ok: bodyMult >= 1.5, pts: bodyMult >= 1.5 ? 5 : 0 },
      { k: '風險≤7%', ok: risk <= 7, pts: risk <= 7 ? 5 : 0 },
    ];
    const score = Math.round(Math.min(100, 40 + checks.reduce((t, c) => t + c.pts, 0)));
    return { ...base, sigIdx: s, date: bars[s].d, close: entry, volRatio, body, reclaim, entry, stop, risk, target: tgt, rr, checks, score, miss: fails[0] || null };
  }
}


// ===== 打底突破 / 突破回測（做多邏輯；做空用價格倒數鏡像）=====
function mirrorBars(bars) {
  const K = bars[bars.length - 1].c ** 2;
  return { K, bars: bars.map(b => ({ d: b.d, o: K / b.o, h: K / b.l, l: K / b.h, c: K / b.c, v: b.v })) };
}
function patternsLong(bars, P) {
  const n = bars.length, out = [];
  const O = bars.map(b => b.o), H = bars.map(b => b.h), Lo = bars.map(b => b.l), C = bars.map(b => b.c), V = bars.map(b => b.v);
  if (n < 70 || sma(V, n - 1, 20) < P.minLots) return out;
  const maxH = (a, b) => { let m = -Infinity; for (let i = Math.max(0, a); i <= b; i++) m = Math.max(m, H[i]); return m; };
  const minL = (a, b) => { let m = Infinity; for (let i = Math.max(0, a); i <= b; i++) m = Math.min(m, Lo[i]); return m; };
  const maxC = (a, b) => { let m = -Infinity; for (let i = Math.max(0, a); i <= b; i++) m = Math.max(m, C[i]); return m; };
  const plan = (s, stop, target) => {
    const entry = C[s], risk = (entry - stop) / entry * 100, rr = target > entry && entry > stop ? (target - entry) / (entry - stop) : 0;
    return { entry, stop, target, risk, rr };
  };
  const closeStr = s => { const r = H[s] - Lo[s]; return r > 0 ? (C[s] - Lo[s]) / r : 0; };

  // --- 打底突破 / 雙重底 ---
  let base = null;
  for (let s = n - 1; s >= n - P.recent && !base; s--) {
    if (!(C[s] > O[s])) continue;
    let len = 0, hi = 0, lo = 0;
    for (let L = P.baseMax; L >= P.baseMin; L--) {
      const h = maxH(s - L, s - 1), l = minL(s - L, s - 1);
      if ((h - l) / l * 100 <= P.baseRange) { len = L; hi = h; lo = l; break; }
    }
    if (!len) continue;
    if (!(C[s] > hi && C[s - 1] <= hi)) continue;           // 當天第一次收在區間上緣之上
    const prior = maxC(s - len - 40, s - len - 1);
    if (!(prior >= lo * (1 + P.priorDrop / 100))) continue;   // 打底前有一段跌勢
    const avgV = sma(V, s - 1, 20), volRatio = V[s] / avgV, body = (C[s] - O[s]) / C[s - 1] * 100;
    const fails = [];
    if (volRatio < P.volMult) fails.push(`量比只有 ${volRatio.toFixed(2)} 倍（要 ${P.volMult} 倍）`);
    if (body < P.minBody) fails.push(`實體只有 ${body.toFixed(1)}%（要 ${P.minBody}%）`);
    if (fails.length > 1) continue;
    // 雙重底：區間內兩個相距 ≥5 天、都在最低點 3% 內的轉折低點
    const lows = [];
    for (let i = s - len + 2; i <= s - 3; i++) if (Lo[i] <= lo * 1.03 && Lo[i] <= Lo[i - 1] && Lo[i] <= Lo[i - 2] && Lo[i] <= Lo[i + 1] && Lo[i] <= Lo[i + 2]) lows.push(i);
    const dbl = lows.length >= 2 && lows[lows.length - 1] - lows[0] >= 5;
    const pl = plan(s, Math.max(Lo[s], lo), hi + (hi - lo));
    const checks = [
      { k: '帶量突破', ok: volRatio >= P.volMult, pts: volRatio >= P.volMult ? Math.min(20, 10 + (volRatio - P.volMult) * 6) : 0 },
      { k: '雙重底', ok: dbl, pts: dbl ? 12 : 0 },
      { k: '收在高檔', ok: closeStr(s) >= 0.75, pts: closeStr(s) >= 0.75 ? 8 : 0 },
      { k: '區間夠緊(≤12%)', ok: (hi - lo) / lo <= 0.12, pts: (hi - lo) / lo <= 0.12 ? 8 : 0 },
      { k: '風險≤7%', ok: pl.risk <= 7, pts: pl.risk <= 7 ? 6 : 0 },
      { k: '風報比≥2', ok: pl.rr >= 2, pts: pl.rr >= 2 ? 6 : 0 },
    ];
    base = { type: 'base', sigIdx: s, date: bars[s].d, close: C[s], level: hi, low: lo, baseStart: s - len, baseLen: len, dbl, volRatio, body,
      depth: (hi - lo) / lo * 100, checks, score: Math.round(Math.min(100, 40 + checks.reduce((t, c) => t + c.pts, 0))), miss: fails[0] || null, ...pl };
  }
  if (base) out.push(base);

  // --- 突破回測 ---
  let rt = null;
  for (let s = n - 1; s >= n - P.recent && !rt; s--) {
    for (let b = s - P.retestWithin; b <= s - 2; b++) {
      const R = maxH(b - 40, b - 1);
      if (!(C[b] > R && C[b - 1] <= R)) continue;
      const bv = V[b] / sma(V, b - 1, 20);
      if (bv < P.volMult) continue;
      const pullLow = minL(b + 1, s);
      if (pullLow < R * 0.97 || pullLow > R * 1.05) continue;   // 要回到突破點附近（-3%～+5%）才算回測
      let below = false; for (let k = b + 1; k <= s; k++) if (C[k] < R * 0.98) below = true;
      if (below) continue;
      if (!(C[s - 1] < C[s - 2] || C[s - 1] < O[s - 1])) continue; // 前一天有拉回
      if (!(C[s] > O[s])) continue;
      const body = (C[s] - O[s]) / C[s - 1] * 100, volRatio = V[s] / sma(V, s - 1, 20);
      const fails = [];
      if (body < P.retestBody) fails.push(`紅K實體只有 ${body.toFixed(1)}%（要 ${P.retestBody}%）`);
      if (!(C[s] > C[s - 1])) fails.push('收盤沒有高過前一天');
      if (volRatio < 1) fails.push(`量比只有 ${volRatio.toFixed(2)} 倍（要 1 倍以上）`);
      if (fails.length > 1) continue;
      const prevHigh = maxH(b, s - 1);
      const pl = plan(s, pullLow, Math.max(prevHigh, C[s]) + (R - minL(b - 20, b - 1)) * 0.5);
      const engulf = O[s] <= C[s - 1] && C[s] >= O[s - 1];
      const checks = [
        { k: '突破帶量', ok: true, pts: Math.min(15, 8 + (bv - P.volMult) * 4) },
        { k: '回測不破', ok: pullLow >= R, pts: pullLow >= R ? 10 : 4 },
        { k: '回測量縮', ok: V[s - 1] < V[b], pts: V[s - 1] < V[b] ? 8 : 0 },
        { k: '紅K吞噬', ok: engulf, pts: engulf ? 8 : 0 },
        { k: '收在高檔', ok: closeStr(s) >= 0.75, pts: closeStr(s) >= 0.75 ? 6 : 0 },
        { k: '風險≤7%', ok: pl.risk <= 7, pts: pl.risk <= 7 ? 6 : 0 },
      ];
      rt = { type: 'retest', sigIdx: s, brkIdx: b, date: bars[s].d, brkDate: bars[b].d, close: C[s], level: R, volRatio, brkVol: bv, body,
        depth: (C[s] - R) / R * 100, checks, score: Math.round(Math.min(100, 40 + checks.reduce((t, c) => t + c.pts, 0))), miss: fails[0] || null, ...pl };
      break;
    }
  }
  if (rt) out.push(rt);
  return out;
}
// 回傳所有型態：[{type:'fake'|'base'|'retest', dir, kind:'signal'|'near'|'wait', ...}]
function analyzeAll(bars, P) {
  const res = [];
  for (const dir of ['long', 'short']) {
    const r = analyze(bars, P, dir);
    if (r) res.push({ type: 'fake', dir, ...r });
  }
  for (const h of patternsLong(bars, P)) res.push({ dir: 'long', kind: h.miss ? 'near' : 'signal', ...h });
  const m = mirrorBars(bars);
  for (const h of patternsLong(m.bars, P)) {
    const back = v => (v == null || !isFinite(v) || v === 0) ? v : m.K / v;
    res.push({ ...h, dir: 'short', kind: h.miss ? 'near' : 'signal', close: back(h.close), level: back(h.level), low: back(h.low),
      entry: back(h.entry), stop: back(h.stop), target: back(h.target),
      checks: h.checks.map(c => ({ ...c, k: c.k.replace('雙重底', '雙重頂').replace('收在高檔', '收在低檔').replace('紅K吞噬', '黑K吞噬') })),
      miss: h.miss && h.miss.replace('紅K', '黑K').replace('高過', '低於') });
  }
  return res;
}

const NAMES = {"1101":"台泥","1216":"統一","1301":"台塑","1303":"南亞","1326":"台化","1503":"士電","1504":"東元","1513":"中興電","1519":"華城","1590":"亞德客-KY","2002":"中鋼","2006":"東和鋼鐵","2049":"上銀","2059":"川湖","2105":"正新","2207":"和泰車","2301":"光寶科","2303":"聯電","2305":"全友","2308":"台達電","2313":"華通","2316":"楠梓電","2317":"鴻海","2324":"仁寶","2327":"國巨","2330":"台積電","2337":"旺宏","2340":"台亞","2342":"茂矽","2344":"華邦電","2345":"智邦","2351":"順德","2353":"宏碁","2356":"英業達","2357":"華碩","2360":"致茂","2367":"燿華","2368":"金像電","2375":"凱美","2376":"技嘉","2377":"微星","2379":"瑞昱","2382":"廣達","2383":"台光電","2385":"群光","2393":"億光","2395":"研華","2402":"毅嘉","2404":"漢唐","2408":"南亞科","2409":"友達","2412":"中華電","2421":"建準","2428":"興勤","2441":"超豐","2449":"京元電子","2451":"創見","2454":"聯發科","2455":"全新","2456":"奇力新","2458":"義隆","2468":"華經","2472":"立隆電","2474":"可成","2481":"強茂","2483":"百容","2486":"一詮","2489":"瑞軒","2492":"華新科","2603":"長榮","2609":"陽明","2610":"華航","2615":"萬海","2618":"長榮航","2801":"彰銀","2880":"華南金","2881":"富邦金","2882":"國泰金","2883":"凱基金","2884":"玉山金","2885":"元大金","2886":"兆豐金","2887":"台新金","2890":"永豐金","2891":"中信金","2892":"第一金","2912":"統一超","3006":"晶豪科","3008":"大立光","3013":"晟銘電","3014":"聯陽","3015":"全漢","3016":"嘉晶","3017":"奇鋐","3019":"亞光","3026":"禾伸堂","3034":"聯詠","3035":"智原","3037":"欣興","3044":"健鼎","3045":"台灣大","3055":"蔚華科","3081":"聯亞","3094":"聯傑","3105":"穩懋","3131":"弘塑","3149":"正達","3163":"波若威","3189":"景碩","3211":"順達","3227":"原相","3231":"緯創","3260":"威剛","3264":"欣銓","3293":"鈊象","3323":"加百裕","3324":"雙鴻","3338":"泰碩","3357":"臺慶科","3363":"上詮","3374":"精材","3406":"玉晶光","3443":"創意","3450":"聯鈞","3481":"群創","3529":"力旺","3533":"嘉澤","3545":"敦泰","3583":"辛耘","3592":"瑞鼎","3605":"宏致","3615":"安可","3653":"健策","3661":"世芯-KY","3665":"貿聯-KY","3673":"TPK-KY","3680":"家登","3698":"隆達","3707":"漢磊","3711":"日月光投控","3714":"富采","4904":"遠傳","4915":"致伸","4919":"新唐","4938":"和碩","4956":"光鋐","4958":"臻鼎-KY","4961":"天鈺","4966":"譜瑞-KY","4977":"眾達-KY","4979":"華星光","5269":"祥碩","5274":"信驊","5289":"宜鼎","5347":"世界","5351":"鈺創","5425":"台半","5483":"中美晶","5536":"聖暉*","5871":"中租-KY","5880":"合庫金","6121":"新普","6147":"頎邦","6153":"嘉聯益","6173":"信昌電","6176":"瑞儀","6182":"合晶","6187":"萬潤","6191":"精成科","6202":"盛群","6213":"聯茂","6223":"旺矽","6226":"光鼎","6239":"力成","6271":"同欣電","6274":"台燿","6412":"群電","6415":"矽力*-KY","6426":"統新","6442":"光聖","6446":"藥華藥","6451":"訊芯-KY","6456":"GIS-KY","6488":"環球晶","6505":"台塑化","6510":"精測","6531":"愛普","6640":"均華","6643":"M31","6668":"中揚光","6706":"惠特","8016":"矽創","8046":"南電","8069":"元太","8086":"宏捷科","8150":"南茂","8261":"富鼎","8299":"群聯"};
const HEAD = "<title>破底翻選股器</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@900&family=JetBrains+Mono:wght@500;700&display=swap\">\n<style>\n/* Layout: 單欄看盤清單 — 頂部掃描列，訊號卡片可展開K線圖，規則與設定收在下方 */\n:root{\n  --bg:#eef0f3; --surface:#ffffff; --ink:#191d25; --muted:#5b6372; --line:#d8dce3;\n  --accent:#2b49c9; --accent-ink:#ffffff; --up:#d22f27; --down:#0f8446; --warn:#a86a10;\n  --up-soft:#fbe7e5; --down-soft:#e2f3ea; --grid:#e6e9ee;\n  --f-display:\"Noto Serif TC\",\"Songti TC\",serif;\n  --f-body:\"Noto Sans TC\",\"PingFang TC\",\"Microsoft JhengHei\",system-ui,sans-serif;\n  --f-num:\"JetBrains Mono\",ui-monospace,Menlo,monospace;\n}\n@media (prefers-color-scheme:dark){:root:not([data-theme=\"light\"]){\n  --bg:#11141a; --surface:#1a1e26; --ink:#e7e9ee; --muted:#9aa2b1; --line:#2b313c;\n  --accent:#8097ff; --accent-ink:#0d1020; --up:#ff5b50; --down:#2fc274; --warn:#e2a443;\n  --up-soft:#3a1d1c; --down-soft:#15301f; --grid:#232833; color-scheme:dark}}\n:root[data-theme=\"dark\"]{\n  --bg:#11141a; --surface:#1a1e26; --ink:#e7e9ee; --muted:#9aa2b1; --line:#2b313c;\n  --accent:#8097ff; --accent-ink:#0d1020; --up:#ff5b50; --down:#2fc274; --warn:#e2a443;\n  --up-soft:#3a1d1c; --down-soft:#15301f; --grid:#232833; color-scheme:dark}\n*{box-sizing:border-box}\nbody{background:var(--bg);color:var(--ink);font-family:var(--f-body);font-size:15px;line-height:1.6}\n.wrap{max-width:720px;margin:0 auto;padding-inline:16px;padding-block:20px 48px;display:flex;flex-direction:column;gap:18px}\nheader h1{font-family:var(--f-display);font-weight:900;font-size:clamp(28px,8vw,40px);line-height:1.15;margin:0;letter-spacing:.02em;text-wrap:balance}\nheader h1 .u{color:var(--up)} header h1 .d{color:var(--down)}\nheader p{margin:6px 0 0;color:var(--muted);max-width:60ch}\n.num{font-family:var(--f-num);font-variant-numeric:tabular-nums}\n.seg{display:grid;grid-template-columns:repeat(4,1fr);background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:4px;gap:4px}\n.seg button{all:unset;cursor:pointer;text-align:center;padding:9px 4px;border-radius:9px;font-weight:700;font-size:14px;color:var(--muted)}\n.seg button[aria-pressed=\"true\"]{background:var(--ink);color:var(--bg)}\n.seg button:focus-visible,.btn:focus-visible,.card summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n.seg small{display:block;font-weight:500;font-size:11px;opacity:.8}\n.scan{display:flex;flex-wrap:wrap;gap:8px;align-items:center}\nselect,input,textarea{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:9px 10px}\n.scan select{flex:1;min-width:0}\n.btn{all:unset;cursor:pointer;background:var(--accent);color:var(--accent-ink);font-weight:700;padding:10px 18px;border-radius:10px;text-align:center}\n.btn[disabled]{opacity:.5;cursor:default}\n.status{font-size:13px;color:var(--muted);display:flex;flex-direction:column;gap:6px}\n.bar{height:4px;background:var(--line);border-radius:4px;overflow:hidden}\n.bar i{display:block;height:100%;background:var(--accent);width:0;transition:width .2s}\n.banner{font-size:13px;padding:10px 12px;border-radius:10px;border:1px dashed var(--warn);color:var(--warn)}\n.banner.err{border-style:solid}\n.list{display:flex;flex-direction:column;gap:10px}\n.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}\n.card summary{list-style:none;cursor:pointer;padding:14px;display:grid;grid-template-columns:1fr auto;gap:4px 12px}\n.card summary::-webkit-details-marker{display:none}\n.nm{font-weight:700;font-size:17px}\n.nm .num{font-weight:500;color:var(--muted);font-size:14px;margin-right:6px}\n.meta{grid-column:1/-1;font-size:12.5px;color:var(--muted)}\n.score{align-self:start;font-family:var(--f-num);font-weight:700;font-size:20px;line-height:1;padding:8px 10px;border-radius:10px;text-align:center;min-width:56px}\n.score small{display:block;font-size:10px;font-weight:500;font-family:var(--f-body);margin-top:3px}\n.long .score{background:var(--up-soft);color:var(--up)} .short .score{background:var(--down-soft);color:var(--down)}\n.wait .score{background:var(--bg);color:var(--muted)}\n.stats{grid-column:1/-1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:6px}\n.stats div{font-size:11px;color:var(--muted);line-height:1.3}\n.stats b{display:block;font-family:var(--f-num);font-size:14px;color:var(--ink);font-weight:700}\n.body{padding:0 14px 14px;display:flex;flex-direction:column;gap:10px}\n.chart{overflow-x:auto;border-top:1px solid var(--line);padding-top:10px}\n.chart svg{display:block;width:100%;height:auto;min-width:320px}\n.chips{display:flex;flex-wrap:wrap;gap:6px}\n.chip{font-size:12px;padding:3px 9px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}\n.chip.ok{border-color:transparent;background:var(--ink);color:var(--bg)}\n.plan{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;font-size:12px;color:var(--muted)}\n.plan b{display:block;font-family:var(--f-num);font-size:15px;color:var(--ink)}\n.empty{padding:24px 16px;text-align:center;color:var(--muted);background:var(--surface);border:1px dashed var(--line);border-radius:14px;font-size:14px}\nsection.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px}\nsection.panel>summary{cursor:pointer;padding:14px;font-weight:700}\n.panel .in{padding:0 14px 16px;display:flex;flex-direction:column;gap:12px;font-size:14px}\n.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}\n.grid2 label,.in>label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--muted)}\n.grid2 input{width:100%}\n.in textarea{width:100%;min-height:70px;font-family:var(--f-num);font-size:13px}\n.check{flex-direction:row!important;align-items:center;gap:8px!important}\n.rules{margin:0;padding-left:1.2em;display:flex;flex-direction:column;gap:8px}\n.rules b{color:var(--ink)}\n.tag{font-size:11px;font-weight:700;color:var(--accent);letter-spacing:.06em}\n.foot{font-size:12px;color:var(--muted);max-width:60ch}\n@media (max-width:420px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}\n@media (prefers-reduced-motion:reduce){.bar i{transition:none}}\n</style>\n\n<style>\n.hstat{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px}\n.hstat h3{margin:0;font-size:15px}\n.htable{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}\n.htable th{text-align:left;font-weight:500;color:var(--muted);font-size:11.5px;padding:4px 6px;border-bottom:1px solid var(--line)}\n.htable td{padding:6px;border-bottom:1px solid var(--grid)}\n.htable td.n{text-align:right;font-family:var(--f-num)}\n.tw{overflow-x:auto}\n.hday{font-weight:700;font-size:14px;margin-top:6px}\n.hrow{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:13px}\n.hrow .t{grid-column:1/-1;color:var(--muted);font-size:12px}\n.badge{font-size:12px;font-weight:700;padding:3px 8px;border-radius:99px;align-self:start;white-space:nowrap}\n.b-target{background:var(--up-soft);color:var(--up)} .b-stop{background:var(--down-soft);color:var(--down)}\n.b-open{background:var(--bg);color:var(--muted);border:1px solid var(--line)} .b-expire{background:var(--bg);color:var(--ink);border:1px solid var(--line)}\n.dir-short .b-target{background:var(--down-soft);color:var(--down)} .dir-short .b-stop{background:var(--up-soft);color:var(--up)}\n.src{font-size:10.5px;color:var(--warn);border:1px solid var(--warn);border-radius:4px;padding:0 4px;margin-left:4px}\n.log{font-size:12.5px;color:var(--muted);display:flex;flex-direction:column;gap:4px}\n</style>\n\n<style>\n.newslink{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:12px;padding:12px 14px;color:var(--ink);text-decoration:none}\n.newslink small{display:block;color:var(--muted);font-size:12.5px;margin-top:2px}\n.newslink .arrow{font-size:20px;color:var(--accent);font-weight:700}\n.newslink:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}\n.summary div{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 8px;font-size:11.5px;color:var(--muted);line-height:1.3}\n.summary b{display:block;font-family:var(--f-num);font-size:20px;color:var(--ink)}\n.asof{font-size:13px;color:var(--muted)}\n.asof b{color:var(--ink)}\n.near .score{background:var(--bg);color:var(--warn);border:1px dashed var(--warn)}\n.miss{font-size:13px;color:var(--warn);border-left:3px solid var(--warn);padding-left:8px}\n.update{font-size:13px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}\n.update code{font-family:var(--f-body);font-weight:700;color:var(--accent)}\n.uni{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12.5px;color:var(--muted)}\n.uni span .num{color:var(--ink)}\n@media (max-width:420px){.summary{grid-template-columns:repeat(2,minmax(0,1fr))}}\n</style>\n";
const BODY = "\n<div class=\"wrap\">\n  <header>\n    <h1><span class=\"u\">破底翻</span> · 打底 · <span class=\"d\">回測</span></h1>\n    <p>掃描台股的破底翻、打底突破、突破回測三種型態，做多做空都找，附停損、目標和K線圖。</p>\n  </header>\n\n  <a class=\"newslink\" href=\"https://claude.ai/artifact/Bj8Zk1JKiUHFmewRu9JxTY\" target=\"_blank\" rel=\"noopener\">\n    <span><b>台股每日重點</b><small>今天發生什麼、接下來要注意什麼和原因・每個交易日 5:45 更新</small></span><span class=\"arrow\" aria-hidden=\"true\">→</span>\n  </a>\n\n  <div class=\"asof\" id=\"asof\"></div>\n  <div class=\"summary\" id=\"summary\"></div>\n\n  <div class=\"seg\" role=\"group\" aria-label=\"訊號類型\">\n    <button id=\"t-long\" data-tab=\"long\" aria-pressed=\"false\">做多<small>訊號</small></button>\n    <button id=\"t-short\" data-tab=\"short\" aria-pressed=\"false\">做空<small>訊號</small></button>\n    <button id=\"t-watch\" data-tab=\"watch\" aria-pressed=\"false\">觀察中<small>接近/待翻</small></button>\n    <button id=\"t-hist\" data-tab=\"hist\" aria-pressed=\"false\">紀錄<small>成績單</small></button>\n  </div>\n\n  <div class=\"list\" id=\"list\"></div>\n\n  <div class=\"update\">\n    <span>每個交易日下午 5:30 左右由 GitHub 自動重新掃描、更新這一頁，不需要開電腦。</span>\n    <span>想馬上更新：在 GitHub App 打開 stock-scanner → Actions → 每日選股 → Run workflow。想改條件或加股票，回到 Claude 對話直接說。</span>\n  </div>\n\n  <details class=\"panel\">\n    <summary>判斷規則與我加的改良</summary>\n    <div class=\"in\">\n      <ol class=\"rules\">\n        <li><b>下跌趨勢</b>：訊號前 20 個交易日（約四週）跌幅 ≥ 8%，且 20 日均線還在往下。</li>\n        <li><b>前波低點＝支撐</b>：往前 45 天找「左邊 5 天、右邊 3 天都比它高」的轉折低點，而且之前沒被跌破過。</li>\n        <li><b>假跌破</b>：最近 5 天內才第一次跌破支撐，深度不超過 8%，太深就當成真的破了。</li>\n        <li><b>陽包陰</b>：前一根是黑K，訊號K是紅K，開盤 ≤ 前收、收盤 ≥ 前開，實體 ≥ 3%。</li>\n        <li><b>帶量</b>：訊號K成交量 ≥ 20 日均量 1.5 倍。</li>\n      </ol>\n      <span class=\"tag\">新增型態</span>\n      <ol class=\"rules\">\n        <li><b>打底突破／雙重底</b>：先從高點跌超過 15%，接著 12～40 天在 18% 以內的區間盤整打底，然後帶量（≥1.5 倍）長紅（≥3%）第一次收在區間上緣之上。區間內出現兩次差不多的低點會標成「雙重底」加分。停損放在突破K低點或區間下緣，目標是區間高度往上量一倍。</li>\n        <li><b>突破回測</b>：最近 8 天內帶量突破前 40 天的高點，之後拉回但沒有跌破突破點 3% 以上，再出現收高的紅K（實體 ≥2%、量 ≥ 均量）。停損放在回測低點或突破點。</li>\n        <li><b>做空鏡像</b>：做頭跌破（漲多後在區間做頭、帶量長黑跌破下緣）與跌破反彈（跌破前低後反彈不過、再出黑K）。</li>\n      </ol>\n      <span class=\"tag\">改良項目</span>\n      <ol class=\"rules\">\n        <li><b>收盤要收復支撐</b>：紅K收在支撐線之上才算真的翻回來，否則只是跌深反彈。</li>\n        <li><b>破底量縮加分</b>：跌破那幾天如果量縮，比較像洗盤；帶大量跌破比較像主力真的在出貨。</li>\n        <li><b>收在高檔加分</b>：收盤位在當天振幅上緣 25% 內，代表買盤撐到收盤。</li>\n        <li><b>吞噬力道</b>：紅K實體是前一根黑K的 1.5 倍以上加分。</li>\n        <li><b>自動算停損與目標</b>：停損放在假跌破的最低點，目標是前波反彈高點，並算出風險報酬比。</li>\n        <li><b>流動性過濾</b>：20 日均量低於 500 張的股票不看。</li>\n        <li><b>接近訊號</b>：型態都對、只差一個條件（例如量不夠）的股票，放在「觀察中」，隔天補量就可能成立。</li>\n        <li><b>等待翻轉</b>：已經跌破支撐、還沒出現長紅的股票，也放在「觀察中」。</li>\n        <li><b>做空鏡像</b>：上漲趨勢中突破前波高點後，被帶量「陰包陽」打回壓力之下。</li>\n      </ol>\n      <p class=\"foot\">分數：符合基本型態給 40 分，其餘依量比、收復、量縮、收盤位置、吞噬力道、風險加分，滿分 100。</p>\n    </div>\n  </details>\n\n  <details class=\"panel\">\n    <summary id=\"uniTitle\">這次掃描的股票</summary>\n    <div class=\"in\"><div class=\"uni\" id=\"uni\"></div><p class=\"foot\" id=\"uniNote\"></p></div>\n  </details>\n\n  <p class=\"foot\">資料來源：FinMind 台股日K（未還原權息），由 GitHub Actions 每日抓取。這是型態篩選工具，不是投資建議；進場前請自己看圖確認、設好停損。</p>\n</div>\n\n<script>\nconst SNAP = /*SNAP*/;\nconst $ = id => document.getElementById(id);\nconst f2 = v => v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2);\n\nconst res = { long: [], short: [], watch: [] };\nconst BARS = {};\nfor (const [id, raw] of Object.entries(SNAP.bars)) BARS[id] = raw.map(r => ({ d: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));\nfor (const r of SNAP.results) {\n  const x = { id: r.id, name: SNAP.names[r.id] || '', bars: BARS[r.id], r, dir: r.dir };\n  if (r.kind === 'signal') res[r.dir].push(x); else res.watch.push(x);\n}\nres.long.sort((a, b) => b.r.score - a.r.score); res.short.sort((a, b) => b.r.score - a.r.score);\nres.watch.sort((a, b) => (a.r.kind === 'near' ? 0 : 1) - (b.r.kind === 'near' ? 0 : 1) || b.r.score - a.r.score);\nconst TYPE = { fake: ['破底翻', '假突破'], base: ['打底突破', '做頭跌破'], retest: ['突破回測', '跌破反彈'] };\nconst tname = x => TYPE[x.r.type][x.dir === 'long' ? 0 : 1] + (x.r.type === 'base' && x.r.dbl ? (x.dir === 'long' ? '・雙重底' : '・雙重頂') : '');\nconst nNear = res.watch.filter(x => x.r.kind === 'near').length, nWait = res.watch.length - nNear;\n\n$('asof').innerHTML = `資料日期 <b>${SNAP.asOf}</b> 收盤 · 更新於 ${SNAP.updated}`;\n$('summary').innerHTML = `<div>已檢查<b>${SNAP.checked}</b>檔</div><div>做多訊號<b style=\"color:var(--up)\">${res.long.length}</b>個</div><div>做空訊號<b style=\"color:var(--down)\">${res.short.length}</b>個</div><div>觀察中<b>${res.watch.length}</b>個</div>`;\n$('t-long').querySelector('small').textContent = `訊號 · ${res.long.length}`;\n$('t-short').querySelector('small').textContent = `訊號 · ${res.short.length}`;\n$('t-watch').querySelector('small').textContent = `接近/待翻 · ${res.watch.length}`;\n$('t-hist').querySelector('small').textContent = `成績單 · ${(SNAP.hist && SNAP.hist.records.length) || 0}`;\n$('uniTitle').textContent = `這次掃描的 ${SNAP.checked} 檔股票`;\n$('uni').innerHTML = SNAP.universe.map(([id, n]) => `<span><span class=\"num\">${id}</span> ${n}</span>`).join('');\n$('uniNote').textContent = SNAP.note;\n\nlet tab = res.long.length ? 'long' : res.short.length ? 'short' : 'watch';\ndocument.querySelectorAll('.seg button').forEach(b => {\n  b.setAttribute('aria-pressed', b.dataset.tab === tab);\n  b.addEventListener('click', () => { tab = b.dataset.tab; document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', x === b)); render(); });\n});\n\nfunction chart(bars, r, dir) {\n  const N = Math.min(70, bars.length), B = bars.slice(-N), off = bars.length - N;\n  const W = 700, PH = 200, VH = 50, G = 8, LP = 8, RP = 56, TP = 12;\n  let hi = Math.max(...B.map(b => b.h)), lo = Math.min(...B.map(b => b.l));\n  for (const v of [r.level, r.low, r.stop, r.sigIdx >= 0 ? r.target : null]) if (v != null && isFinite(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); }\n  const pad = (hi - lo) * .06; hi += pad; lo -= pad;\n  const cw = (W - LP - RP) / N, y = v => TP + (hi - v) / (hi - lo) * PH, x = i => LP + i * cw + cw / 2;\n  const vmax = Math.max(...B.map(b => b.v)), vy0 = TP + PH + G + VH;\n  let s = `<svg viewBox=\"0 0 ${W} ${TP + PH + G + VH + 18}\" role=\"img\" aria-label=\"近${N}日K線\">`;\n  for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; s += `<line x1=\"${LP}\" x2=\"${W - RP}\" y1=\"${y(v)}\" y2=\"${y(v)}\" stroke=\"var(--grid)\"/><text x=\"${W - RP + 6}\" y=\"${y(v) + 4}\" font-size=\"11\" fill=\"var(--muted)\" font-family=\"JetBrains Mono,monospace\">${f2(v)}</text>`; }\n  if (r.type === 'base' && r.baseStart - off >= 0) { s += `<rect x=\"${x(r.baseStart - off) - cw / 2}\" y=\"${TP}\" width=\"${(r.sigIdx - r.baseStart) * cw}\" height=\"${PH}\" fill=\"var(--ink)\" opacity=\".05\"/>`; }\n  if (r.type === 'retest') { const i = r.brkIdx - off; if (i >= 0) s += `<rect x=\"${x(i) - cw / 2}\" y=\"${TP}\" width=\"${cw}\" height=\"${PH + G + VH}\" fill=\"var(--warn)\" opacity=\".14\"/>`; }\n  if (r.sigIdx >= 0) { const i = r.sigIdx - off; s += `<rect x=\"${x(i) - cw / 2}\" y=\"${TP}\" width=\"${cw}\" height=\"${PH + G + VH}\" fill=\"var(--accent)\" opacity=\".14\"/>`; }\n  B.forEach((b, i) => {\n    const up = b.c >= b.o, col = up ? 'var(--up)' : 'var(--down)', bw = Math.max(1.5, cw * .62);\n    s += `<line x1=\"${x(i)}\" x2=\"${x(i)}\" y1=\"${y(b.h)}\" y2=\"${y(b.l)}\" stroke=\"${col}\"/>`;\n    s += `<rect x=\"${x(i) - bw / 2}\" y=\"${y(Math.max(b.o, b.c))}\" width=\"${bw}\" height=\"${Math.max(1, Math.abs(y(b.o) - y(b.c)))}\" fill=\"${col}\"/>`;\n    const vh = b.v / vmax * VH; s += `<rect x=\"${x(i) - bw / 2}\" y=\"${vy0 - vh}\" width=\"${bw}\" height=\"${vh}\" fill=\"${col}\" opacity=\".45\"/>`;\n  });\n  const hl = (v, col, lab) => `<line x1=\"${LP}\" x2=\"${W - RP}\" y1=\"${y(v)}\" y2=\"${y(v)}\" stroke=\"${col}\" stroke-width=\"1.5\" stroke-dasharray=\"6 4\"/><text x=\"${LP + 4}\" y=\"${y(v) - 5}\" font-size=\"12\" font-weight=\"700\" fill=\"${col}\">${lab} ${f2(v)}</text>`;\n  if (r.level) s += hl(r.level, 'var(--ink)', r.type === 'base' ? (dir === 'long' ? '區間上緣' : '區間下緣') : r.type === 'retest' ? (dir === 'long' ? '突破點' : '跌破點') : (dir === 'long' ? '支撐' : '壓力'));\n  if (r.type === 'base' && r.low) s += hl(r.low, 'var(--muted)', dir === 'long' ? '區間下緣' : '區間上緣');\n  if (r.stop) s += hl(r.stop, 'var(--warn)', '停損');\n  if (r.sigIdx >= 0 && isFinite(r.target)) s += hl(r.target, 'var(--accent)', '目標');\n  if (r.pivIdx != null && r.pivIdx - off >= 0) { const i = r.pivIdx - off, v = dir === 'long' ? B[i].l : B[i].h; s += `<circle cx=\"${x(i)}\" cy=\"${y(v)}\" r=\"5\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"1.5\"/>`; }\n  s += `<text x=\"${LP}\" y=\"${vy0 + 15}\" font-size=\"11\" fill=\"var(--muted)\">${B[0].d}</text><text x=\"${W - RP}\" y=\"${vy0 + 15}\" font-size=\"11\" fill=\"var(--muted)\" text-anchor=\"end\">${B[N - 1].d}</text>`;\n  return s + '</svg>';\n}\n\nfunction metaText(x) {\n  const r = x.r, L = x.dir === 'long';\n  if (r.type === 'fake') return `${L ? '假跌破' : '假突破'} ${r.depth.toFixed(1)}% 後${r.reclaim ? (L ? '收復支撐' : '跌回壓力下') : '尚未收復'}`;\n  if (r.type === 'base') return `盤整 ${r.baseLen} 天後${L ? '突破上緣' : '跌破下緣'} ${f2(r.level)}`;\n  return `${r.brkDate.slice(5)} ${L ? '突破' : '跌破'} ${f2(r.level)}，回測後${L ? '再上攻' : '再轉弱'}`;\n}\nfunction sigCard(x, open) {\n  const r = x.r, L = x.dir === 'long', near = r.kind === 'near';\n  return `<details class=\"card ${near ? 'near' : x.dir}\" ${open ? 'open' : ''}><summary>\n    <div class=\"nm\"><span class=\"num\">${x.id}</span>${x.name}</div>\n    <div class=\"score\">${r.score}<small>${near ? '差一點' : '分'}</small></div>\n    <div class=\"meta\"><b>${tname(x)}</b>・${r.date}・${metaText(x)}</div>\n    <div class=\"stats\"><div>最新收盤<b>${f2(x.bars[x.bars.length-1].c)}</b></div><div>量比<b>${r.volRatio.toFixed(1)}×</b></div><div>${L ? '紅' : '黑'}K實體<b>${Math.abs(r.body).toFixed(1)}%</b></div><div>風報比<b>${r.rr ? r.rr.toFixed(1) : '—'}</b></div></div>\n  </summary><div class=\"body\">\n    ${near ? `<div class=\"miss\">還差：${r.miss}</div>` : ''}\n    <div class=\"chips\">${r.checks.map(c => `<span class=\"chip ${c.ok ? 'ok' : ''}\">${c.ok ? '✓ ' : ''}${c.k}</span>`).join('')}</div>\n    <div class=\"plan\"><div>${L ? '進場參考' : '放空參考'}<b>${f2(r.entry)}</b></div><div>停損（${r.risk.toFixed(1)}%）<b>${f2(r.stop)}</b></div><div>目標<b>${isFinite(r.target) ? f2(r.target) : '—'}</b></div></div>\n    <div class=\"chart\">${chart(x.bars, r, x.dir)}</div>\n  </div></details>`;\n}\nfunction waitCard(x) {\n  const r = x.r, L = x.dir === 'long';\n  return `<details class=\"card wait\"><summary>\n    <div class=\"nm\"><span class=\"num\">${x.id}</span>${x.name}</div>\n    <div class=\"score\">${r.depth.toFixed(1)}%<small>${L ? '破底深度' : '突破幅度'}</small></div>\n    <div class=\"meta\"><b>${L ? '破底待翻' : '突破待回落'}</b>・${r.date} 收 ${f2(r.close)}，仍在${L ? '支撐' : '壓力'} ${f2(r.level)} ${L ? '之下，等帶量長紅收回' : '之上，等帶量長黑跌回'}。</div>\n    <div class=\"stats\"><div>最新收盤<b>${f2(x.bars[x.bars.length-1].c)}</b></div><div>${L ? '支撐' : '壓力'}<b>${f2(r.level)}</b></div><div>四週${L ? '跌' : '漲'}幅<b>${r.move.toFixed(1)}%</b></div><div>${L ? '破底' : '突破'}量比<b>${r.breakVolRatio.toFixed(2)}</b></div></div>\n  </summary><div class=\"body\"><div class=\"chart\">${chart(x.bars, r, x.dir)}</div></div></details>`;\n}\nconst H = SNAP.hist || { records: [], stats: [], params: {}, log: [] };\nconst TN = (type, dir) => TYPE[type][dir === 'long' ? 0 : 1];\nconst pct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';\nconst ST = { target: '達標', stop: '停損', open: '進行中', expire: '到期', unknown: '無資料' };\nfunction histView() {\n  const s = H.stats;\n  let h = `<div class=\"hstat\"><h3>成績單（訊號後 ${H.horizon || 10} 個交易日內）</h3>`;\n  if (!s.length) h += `<p class=\"foot\">還沒有已結束的紀錄。訊號出現後最多 ${H.horizon || 10} 個交易日就會有結果。</p>`;\n  else h += `<div class=\"tw\"><table class=\"htable\"><thead><tr><th>型態</th><th class=\"n\">筆數</th><th class=\"n\">達標</th><th class=\"n\">停損</th><th class=\"n\">平均報酬</th></tr></thead><tbody>` +\n    s.map(r => `<tr><td>${r.label}</td><td class=\"n\">${r.n}</td><td class=\"n\">${(r.target / r.n * 100).toFixed(0)}%</td><td class=\"n\">${(r.stop / r.n * 100).toFixed(0)}%</td><td class=\"n\">${pct(r.avg)}</td></tr>`).join('') + `</tbody></table></div>`;\n  h += `<p class=\"foot\">達標＝先碰到目標價；停損＝先碰到停損價；都沒碰到就看第 ${H.horizon || 10} 天收盤（到期）。同一天兩個都碰到算停損。進場價用訊號當天收盤。標「回測」的是用同樣規則往回算的補登紀錄，不是當天實際推送的。</p></div>`;\n  h += `<div class=\"hstat\"><h3>自動優化</h3><div class=\"log\"><span>目前使用：量比 ≥ <b>${H.params.volMult}</b> 倍、K棒實體 ≥ <b>${H.params.minBody}%</b></span>` +\n    (H.bt ? `<span>最近一次檢討（${H.bt.date}）：用過去約 ${H.bt.days} 個交易日回測 ${H.bt.n} 筆訊號，平均每筆 ${H.bt.avgR >= 0 ? '+' : ''}${H.bt.avgR.toFixed(2)}R（R＝停損距離）。</span>` : '') +\n    (H.log.length ? H.log.slice().reverse().map(l => `<span>${l.date}：${l.text}</span>`).join('') : '<span>還沒有調整過參數。</span>') +\n    `<span>規則：每週檢討一次，至少要有 30 筆已結束的回測訊號，而且新參數要比現在明顯好（每筆多 0.1R 以上）才會換，避免只是運氣。</span></div></div>`;\n  const byDay = {};\n  for (const r of H.records) (byDay[r.d] = byDay[r.d] || []).push(r);\n  const days = Object.keys(byDay).sort().reverse();\n  if (!days.length) return h + '<div class=\"empty\">還沒有歷史紀錄。</div>';\n  for (const d of days) {\n    h += `<div class=\"hday\">${d}</div>`;\n    h += byDay[d].sort((a, b) => b.score - a.score).map(r => `<div class=\"hrow dir-${r.dir}\">\n      <div><span class=\"num\">${r.id}</span> <b>${r.name}</b>${r.src === 'backfill' ? '<span class=\"src\">回測</span>' : ''}</div>\n      <span class=\"badge b-${r.st}\">${ST[r.st]}${r.st === 'open' ? ' 第' + r.days + '天' : ''} ${r.ret != null ? pct(r.ret) : ''}</span>\n      <div class=\"t\">${r.dir === 'long' ? '做多' : '做空'}・${TN(r.type, r.dir)}・${r.score}分・進場 ${f2(r.entry)}／停損 ${f2(r.stop)}／目標 ${r.target ? f2(r.target) : '—'}</div>\n    </div>`).join('');\n  }\n  return h;\n}\nfunction render() {\n  if (tab === 'hist') { $('list').innerHTML = histView(); return; }\n  const rows = res[tab], list = $('list');\n  if (!rows.length) {\n    const msg = { long: `這次 ${SNAP.checked} 檔裡沒有完全符合的做多訊號。`, short: `這次 ${SNAP.checked} 檔裡沒有完全符合的做空訊號。`, watch: '目前沒有接近訊號或等待翻轉的股票。' }[tab];\n    list.innerHTML = `<div class=\"empty\">${msg}${tab !== 'watch' && res.watch.length ? '<br>可以看看「觀察中」，有只差一個條件的股票。' : ''}</div>`;\n    return;\n  }\n  list.innerHTML = rows.map((x, i) => tab === 'watch' && x.r.kind === 'wait' ? waitCard(x) : sigCard(x, i === 0)).join('');\n}\nrender();\n</script>\n";
const HORIZON = 10;            // 訊號後追蹤幾個交易日
const KEEP = 45;               // 網頁K線顯示天數
const GRID = [                 // 自動優化會比較的參數組合
  { volMult: 1.3, minBody: 2 }, { volMult: 1.3, minBody: 3 },
  { volMult: 1.5, minBody: 2 }, { volMult: 1.5, minBody: 3 },
  { volMult: 2.0, minBody: 3 }, { volMult: 2.0, minBody: 4 }];
const DEFAULT_PARAMS = { volMult: 1.5, minBody: 3 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tw = () => new Date(Date.now() + 8 * 3600e3);
const r2 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : v;
const r4 = v => Math.round(v * 1e4) / 1e4;

// 讀上一次發布的紀錄（第一次執行時不存在）
async function loadPrev() {
  const repo = process.env.GITHUB_REPOSITORY || '';
  const [owner, name] = repo.split('/');
  if (!owner) return null;
  const url = `https://${owner.toLowerCase()}.github.io/${name}/history.json?t=${Date.now()}`;
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(3000);
  }
  throw new Error('讀不到上一版的 history.json，為了不覆蓋掉歷史紀錄，這次先停止。');
}

// 判斷一筆訊號之後的結果
function evaluate(rec, b, idx) {
  if (idx < 0) return { st: 'unknown', ret: null, days: 0 };
  const L = rec.dir === 'long', sign = L ? 1 : -1;
  const validT = rec.target && (L ? rec.target > rec.entry : rec.target < rec.entry);
  for (let k = 1; k <= HORIZON; k++) {
    const bar = b[idx + k];
    if (!bar) {
      const last = b[b.length - 1];
      return { st: 'open', ret: r4(sign * (last.c / rec.entry - 1)), days: k - 1 };
    }
    const hitStop = L ? bar.l <= rec.stop : bar.h >= rec.stop;
    const hitT = validT && (L ? bar.h >= rec.target : bar.l <= rec.target);
    if (hitStop) return { st: 'stop', ret: r4(sign * (rec.stop / rec.entry - 1)), days: k };
    if (hitT) return { st: 'target', ret: r4(sign * (rec.target / rec.entry - 1)), days: k };
  }
  return { st: 'expire', ret: r4(sign * (b[idx + HORIZON].c / rec.entry - 1)), days: HORIZON };
}

// 用指定參數，在每一天「只看當天」重算一次，得到當天會出現的訊號
function signalsOnDay(b, s, P) {
  const out = [];
  for (const x of analyzeAll(b.slice(0, s + 1), { ...P, recent: 1 })) {
    if (x.kind !== 'signal' || x.date !== b[s].d) continue;
    out.push(x);
  }
  return out;
}

function backtest(D, P, fromIdxBack, toIdxBack) {
  let n = 0, sumR = 0, target = 0;
  for (const b of Object.values(D)) {
    const n0 = b.length;
    for (let s = Math.max(80, n0 - fromIdxBack); s <= n0 - 1 - toIdxBack; s++) {
      for (const x of signalsOnDay(b, s, P)) {
        const risk = Math.abs(x.entry - x.stop) / x.entry;
        if (!(risk > 0)) continue;
        const e = evaluate({ dir: x.dir, entry: x.entry, stop: x.stop, target: x.target }, b, s);
        if (e.st === 'open' || e.st === 'unknown') continue;
        n++; sumR += e.ret / risk; if (e.st === 'target') target++;
      }
    }
  }
  return { n, avgR: n ? sumR / n : 0, target };
}

async function main() {
  const IDS = Object.keys(NAMES);
  const prev = await loadPrev();
  const today = tw().toISOString().slice(0, 10);
  let params = (prev && prev.params) || { ...DEFAULT_PARAMS };
  let log = (prev && prev.log) || [];
  let bt = (prev && prev.bt) || null;
  let lastOpt = (prev && prev.lastOpt) || '';

  // 1. 抓資料（約 400 天，給回測用）
  const start = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const token = process.env.FINMIND_TOKEN || '';
  const D = {}, err = {}, q = [...IDS];
  async function get(id) {
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch('https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=' + id + '&start_date=' + start + (token ? '&token=' + token : '')).then(r => r.json());
        if (r.status === 200 || r.status === 402) return r;
      } catch (e) {}
      await sleep(2000);
    }
    return { status: 0, msg: 'network' };
  }
  async function worker() {
    while (q.length) {
      const id = q.shift(); const r = await get(id);
      if (r.status !== 200) { err[id] = r.status + ' ' + r.msg; if (r.status === 402) q.length = 0; continue; }
      D[id] = r.data.filter(x => x.stock_id === id && x.open > 0 && x.Trading_Volume > 0)
        .map(x => ({ d: x.date, o: x.open, h: x.max, l: x.min, c: x.close, v: Math.round(x.Trading_Volume / 1000) }));
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  console.log('fetched', Object.keys(D).length, '/', IDS.length);
  if (Object.keys(D).length < IDS.length * 0.8) { console.error('Too many failures', JSON.stringify(err).slice(0, 500)); process.exit(1); }

  const skip = [], split = [];
  for (const id of IDS) {
    const b = D[id];
    if (!b || !b.length) { skip.push(id); delete D[id]; continue; }
    // 只看最近 160 天有沒有分割或異常跳動；更早的資料切掉不用
    let cut = 0;
    for (let i = 1; i < b.length; i++) { const k = b[i].c / b[i - 1].c; if (k < 0.75 || k > 1.3) cut = i; }
    if (cut > b.length - 160) { split.push(id); delete D[id]; continue; }
    if (cut) D[id] = b.slice(cut);
  }

  // 2. 自動優化：每 5 天檢討一次
  const daysSince = lastOpt ? (Date.parse(today) - Date.parse(lastOpt)) / 864e5 : 999;
  if (daysSince >= 5) {
    const W = 120;  // 回測最近 120 個交易日（扣掉最後 10 天還沒有結果）
    const results = GRID.map(g => ({ g, ...backtest(D, { ...DEFAULTS, ...g }, W, HORIZON) }));
    const cur = results.find(x => x.g.volMult === params.volMult && x.g.minBody === params.minBody) || backtest(D, { ...DEFAULTS, ...params }, W, HORIZON);
    const best = results.filter(x => x.n >= 30).sort((a, b) => b.avgR - a.avgR)[0];
    console.log('backtest', results.map(x => `${x.g.volMult}/${x.g.minBody}: n=${x.n} avgR=${x.avgR.toFixed(3)}`).join(' | '));
    if (best && (best.g.volMult !== params.volMult || best.g.minBody !== params.minBody) && best.avgR > cur.avgR + 0.1 && best.avgR > 0) {
      log.push({ date: today, text: `參數從「量比 ${params.volMult} 倍、實體 ${params.minBody}%」改成「量比 ${best.g.volMult} 倍、實體 ${best.g.minBody}%」。回測 ${best.n} 筆平均 ${best.avgR.toFixed(2)}R，舊參數 ${cur.n} 筆平均 ${cur.avgR.toFixed(2)}R。` });
      params = { ...best.g };
      bt = { date: today, days: W - HORIZON, n: best.n, avgR: best.avgR };
    } else {
      log.push({ date: today, text: `檢討後維持原參數（回測 ${cur.n} 筆，平均 ${cur.avgR.toFixed(2)}R${best ? `；最好的組合 ${best.g.volMult} 倍/${best.g.minBody}% 為 ${best.avgR.toFixed(2)}R，差距不夠大` : '；樣本不足 30 筆'}）。` });
      bt = { date: today, days: W - HORIZON, n: cur.n, avgR: cur.avgR };
    }
    log = log.slice(-12);
    lastOpt = today;
  }
  const P = { ...DEFAULTS, ...params };

  // 3. 今天的掃描
  const results = [], bars = {}; let asOf = '';
  for (const id of Object.keys(D)) {
    const b = D[id];
    if (b[b.length - 1].d > asOf) asOf = b[b.length - 1].d;
    const off = b.length - KEEP; let hit = false;
    for (const x of analyzeAll(b, P)) {
      if (x.dir === 'short' && x.kind === 'wait') continue;
      const y = {}; for (const [k, v] of Object.entries(x)) y[k] = Array.isArray(v) ? v.map(c => ({ k: c.k, ok: c.ok })) : r2(v);
      for (const k of ['sigIdx', 'pivIdx', 'extIdx', 'baseStart', 'brkIdx']) if (typeof y[k] === 'number' && y[k] >= 0) y[k] = Math.max(0, y[k] - off);
      delete y.avgLots; y.id = id; results.push(y); hit = true;
    }
    if (hit) bars[id] = b.slice(-KEEP).map(r => [r.d, r.o, r.h, r.l, r.c, r.v]);
  }

  // 4. 歷史紀錄：把今天的訊號存起來；第一次執行時用回測補登最近 20 個交易日
  let records = (prev && prev.records) || [];
  const key = r => `${r.d}|${r.id}|${r.type}|${r.dir}`;
  const have = new Set(records.map(key));
  const add = (x, id, src) => {
    const rec = { d: x.date, id, type: x.type, dir: x.dir, score: x.score, entry: r2(x.entry), stop: r2(x.stop), target: r2(x.target), src };
    if (!have.has(key(rec))) { have.add(key(rec)); records.push(rec); }
  };
  if (!prev) {
    for (const [id, b] of Object.entries(D))
      for (let s = b.length - 20; s < b.length; s++) for (const x of signalsOnDay(b, s, P)) add(x, id, 'backfill');
  }
  for (const y of results) if (y.kind === 'signal') add(y, y.id, 'live');
  records.sort((a, b) => a.d < b.d ? -1 : 1);
  const cutoff = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
  records = records.filter(r => r.d >= cutoff);

  // 5. 每筆紀錄的結果與成績單
  const evald = records.map(r => {
    const b = D[r.id]; const idx = b ? b.findIndex(x => x.d === r.d) : -1;
    return { ...r, name: NAMES[r.id] || '', ...(b ? evaluate(r, b, idx) : { st: 'unknown', ret: null, days: 0 }) };
  });
  const groups = {};
  for (const r of evald) {
    if (!['target', 'stop', 'expire'].includes(r.st)) continue;
    for (const k of [`${r.type}|${r.dir}`, 'all']) {
      const g = groups[k] = groups[k] || { n: 0, target: 0, stop: 0, sum: 0 };
      g.n++; g.sum += r.ret; if (r.st === 'target') g.target++; if (r.st === 'stop') g.stop++;
    }
  }
  const TYPE = { fake: ['破底翻', '假突破'], base: ['打底突破', '做頭跌破'], retest: ['突破回測', '跌破反彈'] };
  const stats = Object.entries(groups).map(([k, g]) => {
    if (k === 'all') return { label: '全部', n: g.n, target: g.target, stop: g.stop, avg: g.sum / g.n, all: 1 };
    const [t, d] = k.split('|');
    return { label: `${d === 'long' ? '多' : '空'}・${TYPE[t][d === 'long' ? 0 : 1]}`, n: g.n, target: g.target, stop: g.stop, avg: g.sum / g.n };
  }).sort((a, b) => (b.all || 0) - (a.all || 0) || b.n - a.n);

  // 6. 輸出
  const nm = id => (id + ' ' + (NAMES[id] || '')).trim();
  let note = '資料來自 FinMind，由 GitHub 每日自動抓取。';
  if (skip.length) note += '沒有資料而略過：' + skip.map(nm).join('、') + '。';
  if (split.length) note += '近期股價有分割或異常跳動、略過：' + split.map(nm).join('、') + '。';
  const allSkip = [...skip, ...split];
  const snap = { asOf, updated: tw().toISOString().slice(0, 16).replace('T', ' '), checked: IDS.length - allSkip.length, names: NAMES, results, bars,
    universe: Object.entries(NAMES).filter(([id]) => !allSkip.includes(id)), note,
    hist: { records: evald.filter(r => r.d >= new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)), stats, params, log, bt, horizon: HORIZON } };
  fs.mkdirSync('public', { recursive: true });
  fs.writeFileSync('public/index.html', '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body style="margin:0">' + HEAD + BODY.replace('/*SNAP*/', JSON.stringify(snap)) + '</body></html>');
  fs.writeFileSync('public/history.json', JSON.stringify({ version: 1, updated: snap.updated, params, log, bt, lastOpt, records }));
  const Lc = results.filter(r => r.kind === 'signal' && r.dir === 'long').length, Sc = results.filter(r => r.kind === 'signal' && r.dir === 'short').length;
  console.log('asOf', asOf, '做多', Lc, '做空', Sc, '紀錄', records.length, '參數', JSON.stringify(params));
}
main().catch(e => { console.error(e); process.exit(1); });
