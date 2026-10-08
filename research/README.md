# 型態研究（每週自動）

使用者希望選股器能自己研究新型態；**每次真的加進選股器，都要傳訊息告訴他**。

## 檔案

| 位置 | 用途 |
|---|---|
| `patterns/*.js` | 已加入選股器的外掛型態。`node scan.js` 每天自動載入，做多做空都會掃、會記錄成績、出現在網頁上。 |
| `research/candidates/*.js` | 正在測試的候選型態，不會出現在網頁。 |
| `research/run.js` | 回測（只能在 GitHub Actions 跑，要抓 FinMind 資料）。由 `.github/workflows/research.yml` 執行，結果自動 commit 到 `research/results/latest.md` / `latest.json`。 |
| `research/selftest.js` | 本機用假資料檢查外掛會不會出錯：`node research/selftest.js research/candidates/xxx.js` |
| `research/log.md` | 每週研究紀錄：試過什麼、結果、有沒有加入。**設計新型態前先看，不要重複試已經失敗的點子。** |
| `scan.js` | 主程式（引擎＋網頁）。**每週研究不要改它**，新型態一律用外掛檔。 |

## 外掛型態格式

```js
module.exports = {
  key: 'ma_squeeze',                       // 英文小寫/數字/底線，不能和 fake/base/retest 重複
  names: ['均線糾結突破', '均線糾結跌破'],   // [做多名稱, 做空名稱]
  status: 'experimental',                  // candidate（研究中）| experimental（實驗中，網頁會標示）| active | off（停用）
  dirs: ['long'],                          // 選填：只做多 ['long'] 或只做空 ['short']；不寫＝兩邊都做
  desc: '一句話說明',
  added: '2026-10-10',                     // 加入選股器的日期（patterns/ 裡才需要）
  backtest: '...',                         // 加入時的回測摘要（patterns/ 裡才需要）
  detect(bars, P, H) { ... return [hit]; }
};
```

- `detect` **只寫做多邏輯**；做空會自動把價格取倒數（鏡像）再跑一次。
- 只看最後 `P.recent` 根K棒（`s` 從 `H.n - 1` 往回到 `H.n - P.recent`），每檔最多回傳一個 hit。
- 不能偷看未來：只能用 `bars[0..s]`。
- `P`：`volMult`（量比門檻，自動優化會調）、`minBody`（實體 %）、`minLots` 等，見 scan.js 的 DEFAULTS。成交量單位是「張」，20 日均量 < `P.minLots` 的股票會自動略過。
- `H`（輔助）：`n, O, H, L, C, V`（陣列）、`sma(arr, end, len)`、`maxH(a,b)`、`minL(a,b)`、`maxC(a,b)`、`minC(a,b)`（含頭尾）、`avgV(end,len)`、`closeStr(s)`（收盤在當天區間的位置 0～1）、`body(s)`、`volRatio(s)`、`plan(s, stop, target)` → `{entry, stop, target, risk, rr}`、`score(checks, base=40)`。
- hit 必要欄位：`sigIdx`、`entry`、`stop`（做多要低於 entry）、`target`、`risk`、`rr`（用 `...H.plan()` 帶入）、`checks: [{k:'條件名', ok:true/false, pts:分數}]`、`score`、`miss`（全部符合填 `null`；只差一個條件填那個條件的說明，會出現在「觀察中」）。
- 建議欄位：`level`（關鍵價，畫在圖上）、`levelLabel`、`low`、`volRatio`、`body`、`depth`、`desc` / `descShort`（卡片上的一句說明，做多 / 做空用詞）。
- 結果表會分 both / long / short 三列。判定看 both 列；如果只有一邊好（例如 long 列明顯好、short 列虧），可以加 `dirs: ['long']` 當成新候選再測一次（判定會以只做多的結果為準）。
- 停損一定要是圖上合理的位置（整理區低點、突破點下方等），風險超過 10% 的不要出訊號。

## 每週流程（排程任務照做）

1. 讀 `research/log.md`、`patterns/` 現有型態、上次的 `research/results/latest.md`。
2. 設計 1～2 個**新的**候選型態（台股常見、規則能寫清楚、和現有型態不同）。放到 `research/candidates/`，`node research/selftest.js` 要 OK。
3. commit + push，用 REST API 觸發：`gh api -X POST repos/Boss-max-wp/stock-scanner/actions/workflows/research.yml/dispatches -f ref=main`（`gh workflow run` 會因為 GraphQL 被擋而失敗），再用 `gh run list -R Boss-max-wp/stock-scanner -L 3` 找到這次的 run id，`gh run watch <id> -R Boss-max-wp/stock-scanner` 等它跑完（約 5～20 分鐘），`git pull` 讀 `research/results/latest.md`。
4. `latest.json` 的 `verdict`：
   - 候選 `pass` → 可以加入。**一週最多加 1 個**，實驗中的型態總數最多 4 個。把檔案移到 `patterns/`，`status: 'experimental'`、填 `added`、`backtest`（筆數、達標率、平均R、前後半段）。
   - 候選 `reject` → 刪掉候選檔，在 log 記原因。可以小改一次再測（同一週最多再跑一輪），不要為了過關一直調參數（過度擬合）。
   - 實驗中型態 `retire` → 把 `status` 改成 `'off'`（保留檔案與紀錄），通知使用者。
5. 更新 `research/log.md`，清空 `research/candidates/`，commit + push（`patterns/` 有變動會自動重建網頁）。
6. 用 SendUserMessage 告訴使用者結果；**有加入或停用型態時一定要講清楚**：名稱、白話規則、回測數字、提醒是「實驗中」、想移除跟 Claude 說即可。

## 通過門檻（寫在 run.js 的 RULE）

筆數 ≥ 40、平均 ≥ 0.15R 且不低於現有型態平均、資料前半與後半各 ≥ 15 筆且都 > 0R、和現有型態同日同檔重疊 ≤ 50%。R＝停損距離；訊號後追蹤 10 個交易日，同一天碰到停損和目標算停損。
