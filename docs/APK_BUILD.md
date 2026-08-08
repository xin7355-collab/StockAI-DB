# 🤖 把散戶救星做成 APK(安卓安裝檔)—— 免寫程式

> 📦 **先搞懂三種版本的關係**:網頁 / PWA / APK 載入的是**同一份 index.html、同一份資料**,
> 更新也同步(push 後 ~1 分鐘部署,開著的頁面 10 分鐘內自動換新版)。
> APK 只是把 PWA「包」成安卓安裝檔(技術上叫 **TWA,Trusted Web Activity**)——
> ⛔ **不是**另外維護一套程式,以後也**不需要**重新打包才能更新(內容永遠跟網站同步)。

| | 🌐 網頁 | 📱 PWA | 🤖 APK |
|---|---|---|---|
| 安裝方式 | 開網址 | 瀏覽器「加入主畫面」 | 安裝 .apk 檔 |
| 圖示/全螢幕 | ❌ | ✅ | ✅ |
| 通知可靠度 | 最差(分頁關了就沒) | 中(iOS 要 16.4+ 且從主畫面開) | **最好**(走系統通知欄) |
| iOS 能用嗎 | ✅ | ✅(唯一選擇) | ❌(APK 是安卓專用) |
| 更新 | 自動 | 自動 | **自動**(內容跟網站同步) |

App 內「⚙️ 設定中心」版本號旁邊會顯示你目前用的是哪一種(🌐/📱/🤖),點它看說明。

---

## 🛠️ 打包步驟(用 PWABuilder,約 15 分鐘)

### 第 1 步:產生 APK

1. 開 <https://www.pwabuilder.com>
2. 貼上網址:`https://xin7355-collab.github.io/StockAI-DB/`
3. 按 **Start** → 等它分析完 → 選 **Android** → **Download Package**
4. 選項建議:
   - **Package ID**:`io.github.xin7355collab.stockai`
     (⚠️ 要跟 repo 裡 `.well-known/assetlinks.json` 的 `package_name` **一模一樣**)
   - **Start URL**:`./?source=twa`
     (⭐ 這是 App 用來「認得自己是 APK」的記號 —— 設定中心的 🤖 徽章靠它)
   - Signing key:選「讓 PWABuilder 產生」→ **把下載包裡的 signing key 檔案收好**
     (以後要更新 APK 上架必須用同一把;弄丟就只能換 Package ID 重來)

### 第 2 步:填 assetlinks(讓 APK 能全螢幕)

下載包裡有一個 `assetlinks.json`(或安裝說明裡有 **SHA-256 fingerprint**)。

1. 打開 repo 的 `.well-known/assetlinks.json`
2. 把 `REPLACE_WITH_SHA256_FINGERPRINT_FROM_PWABUILDER` 換成 PWABuilder 給你的那串
   (長得像 `AB:CD:12:...`,冒號分隔 32 組)
3. push 到 main → `deploy_pages` 會自動部署(~1 分鐘)
4. 驗證:開 `https://xin7355-collab.github.io/StockAI-DB/.well-known/assetlinks.json`
   看得到你的 fingerprint 就完成

⚠️ **沒做第 2 步會怎樣**:APK 照樣能裝能用,但**頂端會多一條瀏覽器網址列**
(安卓確認不了「這個 APK 跟這個網站是同一個人」)。填對 fingerprint 就消失。

### 第 3 步:安裝

- 把下載包裡的 `.apk` 傳到手機(LINE 傳自己 / USB / 雲端硬碟)
- 點開安裝 → 安卓會警告「不明來源」→ 允許(這是你自己打包的,沒問題)
- ⛔ **不用上架 Google Play** —— 自己用的話直接裝 APK 就好;
  要上架才需要 Play Console 帳號(25 美金)+ 用下載包裡的 `.aab` 檔

---

## ❓ 常見問題

**Q:以後 App 更新,APK 要重新打包嗎?**
⛔ 不用。TWA 載的就是網站本身 —— push 到 main 部署完,APK 開起來就是新版。
只有「改圖示 / 改名稱 / 改 Package ID」這種**外殼**變動才需要重新打包。

**Q:APK 版的通知為什麼比較可靠?**
PWA 的通知依附在瀏覽器上,安卓的省電機制常把它睡死;
TWA 的通知走系統通知欄,存活率高得多。
⚠️ 但兩者都一樣:**App 完全沒開過的話,盤中 13:00 的尾盤掃描不會跑**
(那段邏輯在頁面裡)。要完全離線提醒得靠後端推播伺服器,那是另一個工程。

**Q:iPhone 可以裝 APK 嗎?**
❌ 不行,APK 是安卓專用。iPhone 用 PWA(Safari → 分享 → 加入主畫面)。

**Q:`.well-known/assetlinks.json` 放在 repo 安全嗎?**
✅ 安全。它只有「網站 ↔ APK 互相認證」的公開 fingerprint,沒有任何祕密;
Google 官方就是要求它**必須公開**才驗得了。
