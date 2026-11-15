# 發佈流程（GitHub＋Chrome Web Store）

本專案每次更新都要：**測過 → 打包 → GitHub Release → Chrome Web Store 更新**。

## 1. 版本號

三個地方要同步（目前手動）：

- `manifest.json` → `version`
- `package.json` → `version`
- `agent/cli.mjs` / `agent/mcp.mjs` 的顯示版本字串

## 2. 本機驗證

```powershell
npm run test:unit        # 單元測試（不需要瀏覽器）
npm run test:e2e         # Playwright e2e（需要 npm i -D playwright）
npm run pack             # 產生 store/full 兩種 zip 到 dist/
```

手動 smoke（建議）：載入未封裝 → 開 acemusic.ai/create/ → 面板載入、抓歌單、下載 1 檔 → 一鍵整理。

## 3. GitHub

```powershell
git add -A
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

- `push`／PR 會跑 `.github/workflows/ci.yml`（單元測試）。
- 推 `v*` tag 會跑 `.github/workflows/release.yml`：單元測試 → `npm run pack` → 建立 GitHub Release 並附上 `dist/*.zip`。

Release notes 會自動生成；可在 GitHub Release 頁面補上使用者看得懂的說明。

## 4. Chrome Web Store

1. 到 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. 選這個擴充功能 → **Package** → 上傳 `dist/acemusic-batch-downloader-<version>-store.zip`
3. 依照 `CHROMEWEBSTORE.md` 更新：
   - Store listing（名稱、short/detailed description）
   - Permissions justification（若有新增權限一定要補）
   - Privacy practices（資料使用表）
   - Screenshots（`store-assets/`，1280×800）
4. 版本歷程新增一列，狀態改成 Submitted
5. 送審 → 通過後把狀態改成 Published

### 自動上傳（可選）

若要自動化，需在 CI secrets 設定 Chrome Web Store API 憑證：

- `CWS_CLIENT_ID`
- `CWS_CLIENT_SECRET`
- `CWS_REFRESH_TOKEN`
- `CWS_EXTENSION_ID`

**不要把憑證 commit 進 repo。** 沒有設定時，維持手動上傳即可。

## 5. 商店審核常见問題

- 權限說明不可寫「需要此權限才能運作」；要寫**哪個使用者功能**用到（見 CHROMEWEBSTORE.md）。
- 隱私政策網址必須公開可讀；本 repo 用 GitHub Pages：`https://<user>.github.io/acemusic-batch-downloader/privacy.html`。
- 截圖必須是 1280×800 或 640×400；`store-assets/` 內已備好。
- zip 只放擴充功能本體（manifest/src/icons），不要把 agent/native/test 打進商店包（`npm run pack` 已分開）。

## 6. 發佈後

- 更新 README 的版本／安裝說明（若商店網址變動）
- GitHub Release 與商店版本號一致
- 回寫 LoopX／交接文件（若有使用）
