# cronsupabaseabuhg17

定時把 Supabase 資料表匯出成 JSON，寫入本 repo 的 `data/`，方便版本控管、備份與離線查閱。

## 運作原理

```
┌─────────────────┐     schedule / dispatch      ┌──────────────────────┐
│ GitHub Actions  │ ───────────────────────────► │ hourly-sync.yml      │
│ 或外部 cron     │                              │ checkout + node 20   │
└─────────────────┘                              └──────────┬───────────┘
                                                           │
                           ┌───────────────────────────────┤
                           ▼                               ▼
              ┌────────────────────────┐     ┌────────────────────────┐
              │ toggle-cron-routine    │     │ sync-supabase-tables   │
              │ 奇數時：INSERT routine │     │ 匯出全部表 → data/*.json│
              │ 偶數時：DELETE 標記列  │     └──────────┬─────────────┘
              └──────────┬─────────────┘                │
                           │  先寫入 Supabase              │ 再備份到 Git
                           └──────────────┬───────────────┘
                                          ▼
                              ┌────────────────────────┐
                              │ Supabase project       │
                              └────────────────────────┘
                                          │
                                          ▼
                              git commit + push (若有變更)
```

### 0. Routine 奇偶小時切換

時區預設 **Asia/Taipei**（`ROUTINE_TZ` 可改）。

| 台北時間 | 行為 |
|----------|------|
| **單數小時**（1, 3, 5, …, 23） | 在 `routine` **新增**一筆標記列（若已存在則略過，避免同小時跑兩次重複插入） |
| **雙數小時**（0, 2, 4, …, 22） | **刪除**先前由 cron 新增的標記列 |

標記列特徵（請勿手動占用）：

- `note` = `__CRON_ROUTINE_TOGGLE__`（用來查詢 / 刪除）
- `name` ≈ `[cron] 奇數小時標記 HH:00`

需要 **可寫入** `routine` 的金鑰（建議 `SUPABASE_SERVICE_ROLE_KEY`）。

本機測試：

```bash
$env:SUPABASE_URL="https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-key"
$env:ROUTINE_TZ="Asia/Taipei"
node scripts/toggle-cron-routine.mjs
```

### 1. 觸發（Trigger）

| 來源 | 用途 |
|------|------|
| `schedule` cron `37`、`57` 分 | 每小時主跑 + 備援時段（GitHub 排程可能延遲） |
| `workflow_dispatch` | Actions 頁面手動跑 |
| `repository_dispatch` (`external-sync`) | 外部 cron（如 cron-job.org）備援觸發 |

同一時間只會跑一個 sync job（`concurrency.group`），且不取消進行中的 run，避免寫半套資料。

### 2. 認證與發現表（Discovery）

腳本優先使用 **service role key**（繞過 RLS，可讀 OpenAPI 自動列全部表）：

1. `GET {SUPABASE_URL}/rest/v1/` + `Accept: application/openapi+json`
2. 從 OpenAPI `paths` 取出表名（略過 `rpc/*`、帶 `{param}` 的路徑）

若只有 **anon key**：

- 必須設定 `SUPABASE_TABLES=table1,table2,...`
- 只匯出該清單（且受 RLS 限制）

### 3. 分頁拉取（PostgREST Range）

每張表：

```
GET /rest/v1/{table}?select=*
Range: 0-999
Prefer: count=exact
```

- 預設每頁 `1000` 列（`SYNC_PAGE_SIZE` 可調）
- 依 `Content-Range` 與頁長判斷是否還有下一頁
- 多張表以 `SYNC_CONCURRENCY`（預設 4）並行匯出，縮短總時間

### 4. 脫敏（Redaction）

寫入 git 前會處理：

- **欄位名**像 `api_key`、`secret`、`token`、`password`… → 整段改為 `[REDACTED SECRET]`
- **字串內容**像 `sk-...`、JWT (`eyJ...`) → 同樣遮蔽

避免 service role 匯出時把密鑰寫進公開歷史。

### 5. 落地與清理

| 產物 | 說明 |
|------|------|
| `data/<table>.json` | 該表全部列（pretty JSON） |
| `data/_manifest.json` | 同步時間、模式、各表列數、耗時、失敗資訊 |
| prune | 只刪「本次發現清單裡已不存在」的 `.json`；**本次失敗的表會保留舊檔**，避免一次 API 錯誤清掉備份 |

### 6. 提交

Workflow 只 `git add data`；有 diff 才 commit / push。commit message 會帶 table 數量。

---

## 需要的 GitHub Secrets

| Secret | 說明 |
|--------|------|
| `SUPABASE_URL` | 例如 `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | 自動匯出全部表（建議） |
| `SUPABASE_ANON_KEY` | 僅 anon 時使用 |
| `SUPABASE_TABLES` | 僅 anon 時必填，逗號分隔表名 |

**切勿**把 service role / anon key commit 進 repo。

### 選哪種設定？

- **全部表自動**：設 `SUPABASE_SERVICE_ROLE_KEY`
- **不要 service role**：設 `SUPABASE_ANON_KEY` + `SUPABASE_TABLES`

### 可選環境變數（進階）

| 變數 | 預設 | 說明 |
|------|------|------|
| `SYNC_CONCURRENCY` | `4` | 同時匯出幾張表 |
| `SYNC_PAGE_SIZE` | `1000` | 每頁列數 |
| `SYNC_MAX_RETRIES` | `3` | 429/5xx/網路重試次數 |
| `SYNC_RETRY_BASE_MS` | `500` | 指數退避基底毫秒 |
| `ROUTINE_TZ` | `Asia/Taipei` | 判斷奇/偶小時的時區 |
| `ROUTINE_TABLE` | `routine` | 要切換的資料表名 |

---

## 外部觸發備援

建議保留 GitHub schedule，再用外部排程呼叫 `repository_dispatch`：

```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_TOKEN" \
  https://api.github.com/repos/abuhg17/cronsupabaseabuhg17/dispatches \
  -d "{\"event_type\":\"external-sync\"}"
```

建議外部在每小時約 `42` 分觸發（介於兩個內建 cron 之間當備援）。

---

## 本機執行

需要 Node.js 20+：

```bash
# Windows PowerShell 範例
$env:SUPABASE_URL="https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-key"
node scripts/sync-supabase-tables.mjs
```

---

## 檔案結構

```
.github/workflows/hourly-sync.yml   # 排程、toggle、同步、commit
scripts/toggle-cron-routine.mjs     # 奇數寫入 / 偶數刪除 routine
scripts/sync-supabase-tables.mjs    # 表匯出核心
data/
  _manifest.json                    # 本次同步摘要
  article.json, bank.json, ...      # 各表匯出
```
