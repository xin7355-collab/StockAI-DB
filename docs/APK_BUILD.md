# 🤖 散戶救星 APK(安卓安裝檔)

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

## ⬇️ 怎麼拿到 APK(按一顆按鈕,約 4 分鐘)

打包在**雲端後台**跑(那邊有安卓打包工具),不用在自己電腦裝任何東西。

1. 開專案的 **Actions** 頁 → 左邊選 **`📦 打包 APK（安卓安裝檔）`**
2. 右上角 **Run workflow** → 分支選 **`main`** → 綠色 Run workflow
3. 等綠燈(約 3~5 分鐘)→ 點進那次 run → 最下面 **Artifacts** 區有
   `stockai-v<版本>-b<編號>.apk` → 下載(會是一個 zip,解開就是 .apk)
4. 把 `.apk` 傳到手機(LINE 傳給自己 / USB / 雲端硬碟)→ 點開安裝
   → 安卓會警告「不明來源」→ 允許(這是你自己打包的)

裝完打開,進 ⚙️ 設定中心看版本號旁邊是不是 **🤖** —— 是就代表 APK 認出自己了。

⛔ **不用上架 Google Play**。自己用直接裝 APK 就好。

### 打包時它自己會檢查什麼

- 圖示 5 種尺寸都產出來了才往下走(不然會打出沒有圖示的 APK)
- **APK 的簽章要跟網站 `.well-known/assetlinks.json` 的 fingerprint 對得起來**,
  對不上直接讓打包失敗 —— 因為那種 APK 裝上去**頂端會多一條瀏覽器網址列**,
  ⛔ 別讓人白裝一次才發現。

---

## 🔑 簽章金鑰(`android/twa-key.jks`)

| | |
|---|---|
| 密碼 / 別名 | `android` / `androiddebugkey`(**故意公開**,跟安卓官方 debug key 同一套做法) |
| SHA-256 | `F8:30:CE:...:24:93`(已填進 `.well-known/assetlinks.json`) |

⭐ **為什麼可以公開**:這支 App 只給自己裝、**不上架 Google Play**,
金鑰的唯一作用是「讓覆蓋安裝認得出是同一個 App」。
它**不能**動錢、不能存取任何資料 —— 跟下單憑證是完全不同的東西
(下單憑證 ⛔ 永遠不進雲端,見 `docs/AUTO_TRADE_SETUP.md`)。

⚠️ **哪天要上架 Play**:那時才需要換一把**保密**的正式金鑰,
並把新的 fingerprint 換進 `assetlinks.json`。

---

## ❓ 常見問題

**Q:以後 App 更新,APK 要重新打包嗎?**
⛔ 不用。TWA 載的就是網站本身 —— 部署完 APK 開起來就是新版。
只有「改圖示 / 改名稱 / 改套件名」這種**外殼**變動才需要重打。

**Q:那我重打一次會怎樣?**
沒問題,直接覆蓋安裝即可(`versionCode` 綁 run 編號,每次都會變大)。
資料存在瀏覽器儲存空間裡,**不會**因為覆蓋安裝不見。

**Q:APK 版的通知為什麼比較可靠?**
PWA 的通知依附在瀏覽器上,安卓的省電機制常把它睡死;TWA 走系統通知欄,存活率高得多。
⚠️ 但兩者一樣:**App 完全沒開過的話,盤中 13:00 的尾盤掃描不會跑**(那段邏輯在頁面裡)。
要完全離線提醒得靠後端推播伺服器,那是另一個工程。

**Q:iPhone 可以裝 APK 嗎?**
❌ 不行,APK 是安卓專用。iPhone 用 PWA(Safari → 分享 → 加入主畫面)。

**Q:`.well-known/assetlinks.json` 放在網站上安全嗎?**
✅ 安全。它只有「網站 ↔ APK 互相認證」的公開 fingerprint,沒有任何祕密;
Google 官方就是要求它**必須公開**才驗得了。

---

## 🧩 這個外殼專案長什麼樣(`android/`)

⛔ **一行 Java 都沒有** —— TWA 的 `LauncherActivity` 由 `androidx.browser` 提供,
整個 App 就是「用哪個網址 + 什麼圖示/顏色」。所以功能永遠只改 `index.html`,不用動這裡。

```
android/
├── settings.gradle / build.gradle / gradle.properties
├── twa-key.jks                       ← 簽章金鑰(故意公開,見上)
└── app/
    ├── build.gradle                  ← 套件名、版本號(版本號從環境變數帶入)
    └── src/main/
        ├── AndroidManifest.xml       ← 指向 LauncherActivity + assetlinks
        └── res/values/
            ├── strings.xml           ← 🌟 launch_url(?source=twa 是 🤖 徽章的依據)
            ├── colors.xml            ← 跟 manifest.json 的 theme/background 一致
            └── styles.xml            ← 深色底,開啟瞬間不白閃
```

⚠️ **改到就要一起改的地方**:
`app/build.gradle` 的 `applicationId` ・ `.well-known/assetlinks.json` 的 `package_name`
—— 兩邊**必須一模一樣**,不一樣就會出現網址列。

目前是 **`io.github.xin7355collab.stockai`**(⛔ 改了要兩邊一起改;`scripts/test_envdetect.mjs` ②b 會比對這份文件與 assetlinks 是否一致)。
