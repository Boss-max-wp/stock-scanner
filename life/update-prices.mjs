// 每次部署網站時執行：從真實網站抓最新價格寫進網站的 prices.json（抓不到的項目沿用 life/prices.json 的數字）
// 用法：node life/update-prices.mjs life/prices.json public/life/prices.json
// 台股、ETF：台灣證券交易所 OpenAPI（每日收盤）
// 美股、黃金、匯率：Yahoo Finance
// 比特幣、以太幣：CoinGecko
import { readFile, writeFile } from "node:fs/promises";

const IN = process.argv[2] || "life/prices.json";
const FILE = process.argv[3] || IN;
const TW = ["2330","2454","2317","2603","2881","2303","2408","6669","2368","1303","2002","2886","2610","1605","2027",
  "0050","0056","00878","00713","00631L","00685L","00927","009816","00981A","00985A","00953B"];
const US = ["VOO","SPY","QQQ","NVDA","AAPL","MSFT","TSLA"];
const UA = { "User-Agent": "Mozilla/5.0 (life-simulator price bot)", "Accept": "application/json" };

let old = {};
try { old = JSON.parse(await readFile(IN, "utf8")); } catch {}
const out = { ...old, tw: { ...(old.tw || {}) }, us: { ...(old.us || {}) }, crypto: { ...(old.crypto || {}) } };
const ok = [];

async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const num = v => { const n = parseFloat(String(v).replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };

// 台股、ETF
try {
  const rows = await getJSON("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
  let n = 0;
  for (const r of rows) if (TW.includes(r.Code)) { const p = num(r.ClosingPrice); if (p) { out.tw[r.Code] = p; n++; } }
  if (rows[0]?.Date) out.twDate = rows[0].Date;
  if (n) ok.push(`台灣證券交易所（${n} 檔）`);
} catch (e) { console.error("TWSE", e.message); }

// Yahoo Finance
async function yahoo(sym) {
  for (const host of ["query1", "query2"]) {
    try {
      const j = await getJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`);
      const p = num(j?.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (p) return p;
    } catch (e) { console.error("Yahoo", sym, e.message); }
  }
  return null;
}
let yn = 0;
for (const s of US) { const p = await yahoo(s); if (p) { out.us[s] = p; yn++; } }
const gold = await yahoo("GC=F"); if (gold) { out.gold = gold; yn++; }
const fx = await yahoo("TWD=X"); if (fx && fx > 20 && fx < 50) { out.usdtwd = fx; yn++; }
if (yn) ok.push("Yahoo Finance");

// 匯率備援
if (!fx) {
  try { const j = await getJSON("https://open.er-api.com/v6/latest/USD"); const t = num(j?.rates?.TWD); if (t) { out.usdtwd = t; ok.push("ExchangeRate-API"); } }
  catch (e) { console.error("FX", e.message); }
}

// 加密貨幣
try {
  const j = await getJSON("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd");
  if (num(j?.bitcoin?.usd)) out.crypto.BTC = j.bitcoin.usd;
  if (num(j?.ethereum?.usd)) out.crypto.ETH = j.ethereum.usd;
  ok.push("CoinGecko");
} catch (e) {
  console.error("CoinGecko", e.message);
  for (const [k, s] of [["BTC", "BTC-USD"], ["ETH", "ETH-USD"]]) { const p = await yahoo(s); if (p) out.crypto[k] = p; }
}

if (!ok.length) console.error("全部來源都抓不到，用舊資料");
else { out.updated = new Date().toISOString(); out.sources = ok; }
await writeFile(FILE, JSON.stringify(out, null, 1) + "\n");
if (ok.length) console.log("更新完成：", ok.join("、"));
