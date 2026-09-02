#!/usr/bin/env node
/**
 * 💼 「每天挑 3 檔、照 App 的打法進出」組合回測 —— vs 同期 0050 買進持有
 *
 * 使用者的問題:「如果有一筆錢,每天推薦我 3 隻個股,依照你給的打法及離場,
 *                每個月勝率多少?獲利幾%?跟同時段的 0050 比呢?」
 *
 * ⛔⛔ 最關鍵的方法論陷阱:**前視偏誤(look-ahead bias)**
 *    `_SIGNAL_EDGE` / `_patternFitBacktest` 的成績是用**全期間**算出來的。
 *    如果拿「哪個型態期望值高」去選股,等於**用未來的資訊決定今天買什麼** ——
 *    那種回測一定漂亮,而且一定假。
 *    ⭐ 這裡改成 **walk-forward**:第 T 天選股時,只准用「**出場日 < T**」的
 *      已完成交易來算型態成績。暖身期(前 WARMUP 天)只累積、不下單。
 *
 * ⛔ 其他必須遵守的(CLAUDE.md 鐵則):
 *   ・打法與出場**直接呼叫 App 自己的** `_playbookPatternDefs()`,⛔ 不複製一份判定邏輯
 *   ・**扣交易成本**(來回 0.44%:買賣手續費 0.1425%×2×折數 + 賣出證交稅 0.3%)
 *   ・對照組 = **同期 0050 買進持有**(⛔ 不是跟 0 比)
 *   ・倖存者偏誤:`data/` 只有還在市場的股票 → 結果**偏樂觀**,報告要寫明
 *   ・分層抽樣:⛔ 不可用 `files.sort().slice(0,N)`(台股代號帶產業意義,
 *     那等於只測傳產金融 —— V72.1.7 踩過)
 *
 * 跑法:node scripts/portfolio_backtest.mjs [檔數] [每天幾檔]
 *       node scripts/portfolio_backtest.mjs 600 3
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 📂 V74.4.8:深歷史(klines_deep 合併後,2021 起)放在 repo 外 → 用 DATA_DIR 指過去,⛔ 不動 repo 的 data/
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const MAX_SYMS = +(process.argv[2] || 600);
const PICKS_PER_DAY = +(process.argv[3] || 3);
const WARMUP = 240;          // 暖身:前 N 個交易日只累積成績、不下單
// 🚨 V2 改法(600 檔首跑抓到的真問題):第一版用「**全市場**型態平均期望值」排序,
//   結果 576 筆裡有 **479 筆全押同一招**(站上長黑K壓力,每趟只有 +0.30%)——
//   因為同一個型態當天可能 50 檔觸發,而它們的分數**完全一樣**,等於在亂挑。
//   ⭐ 使用者要的是「**每個個股都有最好的打法**」= App 的「打法適配儀」(每檔自己的歷史),
//     ⛔ 不是全市場平均。→ 成績改成 **per-stock × per-pattern**。
const MIN_N = +(process.env.MIN_N || 4);   // **這一檔**在**這個型態**打過幾次才准用
const MIN_MKT_N = 20;                       // 全市場該型態的最低樣本(第二層門檻)
const ENTRY = process.env.ENTRY || 'close';   // close | nextopen | nextclose | nextopen_lim | prevclose_lim(見 page.evaluate 內註解)
// 🧪 V72.9.7 濾網實驗(使用者問「有沒有更好的策略提高勝率」)
//   ⛔ 籌碼濾網做不了 —— 實測 foreign_net 每檔只有中位 28 天有值、trust_net 203/291 檔完全沒有、
//      分點只有 3 天,而回測窗口是 486 天 → 加下去等於做一個無法驗證的東西。
//   ⭐ 下面這三個資料完全足夠(全部來自 K 線 / 加權指數,486 天都在):
//      regime = 大盤(^TWII)收在月線之上才進場
//      liq    = 訊號日成交值 >= LIQ 億(避開流動性差的)
//      conf   = 同一天同一檔至少 CONF 招同時觸發
//   ⚠️ 每一個都可能讓總獲利**下降**(濾掉的可能正是賺最多的)—— 這就是要實測的原因。
// 📅 V73.2.0 行事曆濾網實驗(使用者問「禮拜五容易跌 / 法說會 / 月份 / 結算見轉折」)
//   ⛔ 法說會**沒有資料源**(FinMind 沒有法說會行事曆,MOPS 也沒有結構化免費 API)
//      → 只能用「財報公布截止日」當**近似**,而且必須標明那不是法說會。
//   ⚠️ 月份效應在 13 個月的窗口裡**每個月只有 1 個樣本** —— 驗不了,別假裝驗得了。
//   下面全部是純日期運算,零採礦:
//     nofri/nomon/...  = 那一天不進場(dow 1=一 … 5=五)
//     noset  = 台指期結算日(每月第三個星期三,遇假日順延)不進場
//     nosetw = 結算日那一週都不進場
//     onlyset= **只**在結算日進場(反向檢定 —— 若「結算見轉折」成立,這組應該特別好)
//     norev  = 每月 1~10 日(月營收公布期)不進場
//     nofin  = 財報公布截止日前後 3 個交易日不進場(3/31・5/15・8/14・11/14)
//     nohol  = 長假(休市 >= 4 天)前最後一個交易日不進場
const CAL = (process.env.CAL || '').split('+').filter(Boolean);
// 💾 掃描結果快取:同一組 ENTRY/EXIT/STOP/MAXD/GAPCAP 的交易完全一樣 →
//    存起來重用,後面每試一個行事曆假設就從 3 分鐘變成 3 秒。
//    ⛔ 參數不同一定要重掃(檔案內有 meta,對不上會拒絕載入)。
const TRADES_CACHE = process.env.TRADES_CACHE || '';
// ⚖️ V73.2.2 部位縮放實驗 —— ⭐ 這才是上面 53 種濾網真正指向的方向:
//   實測發現「差的環境」每趟**還是正的**(貼著波段高 +0.86%)→ 砍掉它就是砍獲利,
//   所以該調的是**押多少**不是**做不做**。
//   dd60 = 大盤回檔越深押越大 ・flr = 地板股太少(市場太平靜)就減碼 ・both = 兩者相乘
//   ⚠️ 這些桶是從**同一份資料**看出來的 → 有 in-sample 之嫌,
//      唯一的防線是「前後半段一致」(已檢定)+ 機制講得通,⛔ 不可當成保證。
const SCALE = process.env.SCALE || '';
// 🧬 V73.2.3 **個股自身狀態**濾網(使用者:「每隻股票都有他的特性,要用個股的資料檢測」)
//   ⚠️ 先前 53 種測的全是**大盤**狀態,個股自身狀態從沒當過濾網。
//   探針(26 萬筆)顯示全市場層級差異比大盤狀態大:
//     位階高檔 +0.24% vs 低檔 −0.43% ・高波動 +0.31% vs 低波動 −0.40% ・爆量 −0.01% vs 量縮 −0.37%
//   ⛔ 但同一支探針也證明「每檔股票**各有**偏好」不成立(四種狀態延續性全部 ≈ 0)
//      → 所以只能當**全市場通用**的濾網,⛔ 不可做成「這檔喜歡爆量」那種個股標籤。
const SELF = (process.env.SELF || '').split('+').filter(Boolean);
// 🔬 V73.2.5 偵測器訊號濾網(對照表由 sig_x_playbook_probe.mjs 的 SIGX_OUT 產生)
//   plus  = 只做「命中至少 1 個加分訊號」的
//   minus = 排除「命中任何扣分訊號」的
//   ⚠️ 加分/扣分名單是從**同一份資料**選出來的 → 有 in-sample 之嫌,
//      唯一防線是「前後半段同向」(探針已檢定)+ 這裡再看**賺到的錢**。
const SIGX = (process.env.SIGX || '').split('+').filter(Boolean);
const SIGMAP = process.env.SIGMAP || '';
// ⚠️ 門檻做成可調 —— 防過度配適的關鍵檢定:如果只有某個數字才有效,那就是配適出來的
const RANK_MIN = +(process.env.RANK_MIN || 80);
const VOLAT_MIN = +(process.env.VOLAT_MIN || 60);
const FILTER = (process.env.FILTER || '').split('+').filter(Boolean);
const LIQ = +(process.env.LIQ || 1);       // 億元
const CONF = +(process.env.CONF || 2);     // 共振:同一天同一檔至少幾招同時觸發
// 🚪 V72.9.8 出場方式實驗 —— ⭐ 進場濾網六種全部實測沒用之後,剩下的槓桿就是**出場**。
//   勝率只有 33%、全靠少數大賺 → 「跌破 5MA 就出」很可能把贏家太早洗掉。
//   ma5(現行) | ma10 | ma20 | trailN(最高點回落 N%) | 純看停損+天數
//   ⚠️ 出場一改,**排序用的 per-stock 成績也跟著改**(同一批交易算出來的)→ 是一整套的替換,前後可比。
const EXIT = process.env.EXIT || 'ma5';
const MAXD = +(process.env.MAXD || 20);    // 最長持有幾個交易日
// 🛑 V72.9.9 停損距離實驗 —— ⭐ 這是整套裡**最沒根據**的一個參數:
//   現行 `min(訊號日最低, 進場×0.95)` 的 −5% 是當初拍腦袋定的,從來沒驗過。
//   lo5(現行) | pct3 | pct8 | pct10 | atr2(2倍ATR) | lo(只用訊號日最低,不設 % 底)
const STOP = process.env.STOP || 'lo5';
// 💰 V73.0.1 部位大小 —— ⚠️⚠️ 這是一個**真正的對接落差**,不是新實驗:
//   前面所有回測都用 **等權**(每筆固定 LOT 元),但 App 的 `_lotsForRisk` 用的是
//   **風險法**(單筆最多虧帳戶 RISK_PCT%,再套單檔上限 25% 帳戶)→ 每筆金額會浮動。
//   ⛔ 也就是說:「買 N 張」這個 App 直接叫使用者照做的數字,**從來沒被回測過**。
//   equal(等權,= 前面所有結果) | risk(風險法,= App 實際給的建議)
const SIZING = process.env.SIZING || 'equal';
const RISK_PCT = +(process.env.RISK_PCT || 1);
const POS_CAP_PCT = +(process.env.POS_CAP_PCT || 25);   // 單檔上限:帳戶的幾 %(跟 App 一致)
const GAPCAP = +(process.env.GAPCAP || 1);   // nextopen_lim:跳空開高超過幾 % 就不追
const COST = 0.44;           // 來回交易成本 %(手續費 0.1425%×2 + 證交稅 0.3%,未打折)
const LOT = +(process.env.LOT || 100000);        // 每筆投入(等權)
const CAPITAL = +(process.env.CAPITAL || 1000000); // 💰 你手上的總本金 —— 錢用完就買不了(這才貼近現實)

// ── 分層抽樣:每個代號開頭各取,⛔ 不可只取前 N(那等於只測傳產金融)──────
const files = fs.readdirSync(DATA)
    .filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4)).sort();
const byHead = {};
for (const s of files) (byHead[s[0]] ||= []).push(s);
const syms = [];
{
    const heads = Object.keys(byHead).sort();
    let i = 0;
    while (syms.length < Math.min(MAX_SYMS, files.length)) {
        let added = false;
        for (const h of heads) {
            if (byHead[h][i]) { syms.push(byHead[h][i]); added = true; }
            if (syms.length >= MAX_SYMS) break;
        }
        if (!added) break;
        i++;
    }
}
const cover = {};
for (const s of syms) cover[s[0]] = (cover[s[0]] || 0) + 1;
console.log(`💼 組合回測 ・${syms.length} 檔(分層抽樣,代號開頭分布 ${JSON.stringify(cover)})`);
console.log(`   每天最多挑 ${PICKS_PER_DAY} 檔 ・本金 ${CAPITAL.toLocaleString()} 元 ・每筆 ${LOT.toLocaleString()} 元 ・暖身 ${WARMUP} 日 ・成本 ${COST}%/趟 ・部位=${SIZING}${SIZING === 'risk' ? `(虧${RISK_PCT}%/單檔上限${POS_CAP_PCT}%)` : ''} ・停損=${STOP} ・出場=${EXIT}/${MAXD}日 ・進場=${ENTRY}${FILTER.length ? ` ・濾網=${FILTER.join('+')}` : ''}${ENTRY === 'nextopen_lim' ? `(跳空>${GAPCAP}% 不追)` : ''}\n`);

// 💾 掃描結果快取(只跟這幾個參數有關;行事曆濾網完全不影響掃描結果)
const CACHE_KEY = JSON.stringify({ n: syms.length, ENTRY, EXIT, MAXD, STOP, GAPCAP });
const allTrades = [];        // {sym, key, inD, outD, ret, amt, entry, stop}
let cacheHit = false;
if (TRADES_CACHE && fs.existsSync(TRADES_CACHE)) {
    try {
        const j = JSON.parse(fs.readFileSync(TRADES_CACHE, 'utf8'));
        // ⛔ 參數對不上一定要重掃 —— 拿別組參數的交易來套等於結論全錯
        if (j.key === CACHE_KEY && Array.isArray(j.trades) && j.trades.length) {
            // ⛔ 不可用 push(...arr) —— 20 幾萬筆會直接爆呼叫堆疊,
            //    而且會被下面的 try/catch 吞成「讀不起來」然後默默重掃(白等 3 分鐘)
            for (const t of j.trades) allTrades.push(t);
            cacheHit = true;
            console.log(`💾 載入交易快取:${allTrades.length} 筆(參數相符,跳過掃描)`);
        } else {
            console.log('⚠️ 交易快取參數不符 → 重新掃描');
        }
    } catch (e) { console.log(`⚠️ 交易快取讀不起來(${e.message})→ 重新掃描`); }
}
if (!cacheHit) {
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._playbookPatternDefs, null, { timeout: 25000 });

// ── ① 掃全部候選:每檔每天觸發哪些型態 + 照 App 規則模擬出場 ──────────────
//    ⭐ 出場規則直接抄 App `_patternFitBacktest` 的 `bt()`:
//       停損 = min(訊號日最低, 進場×0.95) ・停利 = 跌破 5MA ・最長 20 日
const t0 = Date.now();
let done = 0;
for (const sym of syms) {
    let rows;
    try {
        rows = JSON.parse(fs.readFileSync(path.join(DATA, `${sym}.json`), 'utf8'));
    } catch (_) { continue; }
    if (!Array.isArray(rows) || rows.length < 120) continue;
    const tr = await page.evaluate(a => {
        const data = a.rows.map(r => ({
            date: String(r.date || '').replace(/\//g, '-').slice(0, 10),
            open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume || 0,
        })).filter(r => r.close > 0);
        if (data.length < 120) return [];
        const last = data.length - 1;
        const C = i => data[i].close, L = i => data[i].low, O = i => data[i].open;
        let P;
        try { P = app._playbookPatternDefs(data); } catch (_) { return []; }
        const out = [];
        for (const p of P) {
            let i = 45;
            while (i < last) {
                let fired = false;
                try { fired = p.test(i); } catch (_) {}
                if (fired) {
                    // 🚪 進場點(ENTRY 決定,⛔ 預設 close 維持既有結果不變)
                    //   close    = 訊號當天收盤買(回測慣例,但**現實中你收盤前不知道訊號會成立**)
                    //   nextopen = 隔天開盤買(⭐ 這才是「每晚推薦 → 隔天買」真正會發生的事)
                    //   nextclose= 隔天收盤買(等一天看穩再買)
                    //   nextopen_lim = 隔天開盤買,**但跳空開高超過 GAPCAP% 就不追**(限價單)
                    const eIdx = a.entry === 'close' ? i : i + 1;
                    if (eIdx > last) { i++; continue; }
                    //   prevclose_lim = 🆕 V74.4.5 使用者提的:**開盤前就掛「訊號日收盤價」的限價買單,
                    //     沒成交就算了**。⛔ 這跟 nextopen(隔天開盤買)是**完全不同的東西** ——
                    //     它只有在隔天「跌回昨收」時才會成交 = 只買回檔,不追高。
                    //     成交規則(保守、貼近真實):開盤就低於掛價 → 成交在**開盤價**(更便宜);
                    //     否則盤中最低有觸及掛價 → 成交在**掛價**;都沒有 → 這筆放棄(回 -1)。
                    let entry = a.entry === 'nextopen' ? (O(eIdx) > 0 ? O(eIdx) : C(eIdx))
                              : a.entry === 'nextclose' ? C(eIdx)
                              : a.entry === 'nextopen_lim' ? (O(eIdx) > 0 ? O(eIdx) : C(eIdx))
                              : a.entry === 'prevclose_lim'
                                  ? (O(eIdx) > 0 && O(eIdx) <= C(i) ? O(eIdx)
                                     : (L(eIdx) > 0 && L(eIdx) <= C(i) ? C(i) : -1))
                              : C(i);
                    // ⛔ 跳空開太高就整筆放棄(= 現實中掛限價單沒成交),⛔ 不可改成「用限價成交」
                    //   那等於假設你買到一個當天沒出現的價格
                    if (a.entry === 'nextopen_lim' && entry > C(i) * (1 + a.gapCap / 100)) { i++; continue; }
                    if (entry > 0) {
                        // ⚠️ 停損基準跟著進場點走 —— ⛔ 不可沿用「訊號當天低點」配「隔天開盤價」
                        //   (跳空開高時那個停損會變成 -10% 以上,等於偷偷放寬風險)
                        // 🛑 停損:⛔ 一律「進場價」為基準(⛔ 不可用訊號日的低點配隔天的進場價)
                        let stop;
                        if (a.stop === 'lo') stop = L(eIdx);
                        else if (/^pct(\d+)$/.test(a.stop)) stop = entry * (1 - +RegExp.$1 / 100);
                        else if (a.stop === 'atr2') {
                            // ATR(14):真實波幅均值 × 2(⚠️ 只用 eIdx 之前的資料,零前視)
                            let tr = 0, k = 0;
                            for (let q = Math.max(1, eIdx - 13); q <= eIdx; q++) {
                                const h = data[q].high, l = data[q].low, pc = C(q - 1);
                                tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); k++;
                            }
                            const atr = k ? tr / k : 0;
                            stop = atr > 0 ? entry - 2 * atr : entry * 0.95;
                        } else stop = Math.min(L(eIdx), entry * 0.95);   // lo5 = 現行
                        if (!(stop > 0) || stop >= entry) stop = entry * 0.95;   // 守門:算壞就退回現行
                        let exitP = C(last), exitIdx = last;
                        const endJ = Math.min(last, eIdx + a.maxD);
                        // 🚪 V74.4.8:出場規則可以**疊加**在 maN 上(ma5be5 / ma5tp15 / ma5rr2 / ma5half10)
                        //   → 底層均線改用前綴解析,⛔ 不再只認 'ma5'/'ma10'/'ma20' 三個字串
                        const maN = /^ma(\d+)/.test(a.exit) ? +RegExp.$1 : 0;
                        const trailPct = /^trail(\d+)$/.test(a.exit) ? +RegExp.$1 : 0;
                        // 🕯️ V74.3.7 Chandelier 出場(twstock-research 的做法):進場後最高收盤 − K×ATR(14)。
                        //   跟 trailN 同族但用「該股自己的波動」當回落幅度,⛔ 不是固定 %。K 用 3(它的預設)。
                        //   ATR 只用進場日之前的資料算一次(零前視;動態逐日更新 ATR 的版本另測)。
                        const chandK = /^chand(\d+(?:\.\d+)?)$/.test(a.exit) ? +RegExp.$1 : 0;   // 允許小數(chand1.5 / chand2.5 做敏感度網格)
                        let chandATR = 0;
                        if (chandK > 0) {
                            let tr = 0, k = 0;
                            for (let q = Math.max(1, eIdx - 13); q <= eIdx; q++) {
                                const h = data[q].high, l = data[q].low, pc = C(q - 1);
                                tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); k++;
                            }
                            chandATR = k ? tr / k : 0;
                        }
                        // ⏱️ V74.2.9 時間停損:進場後 D 天內漲不到 P% 就先出場。
                        //   ⭐ 它針對的是**資金效率**(勝率只有 33%,錯的時候越早離開越好),
                        //   ⛔ 不是方向判斷 —— 所以它跟 ma/trail **疊加**而不是取代。
                        const tm = /^(ma\d+|trail\d+|none)?tm(\d+)_(\d+)$/.exec(a.exit);
                        const tmD = tm ? +tm[2] : 0, tmP = tm ? +tm[3] : 0;
                        const tmBase = tm && tm[1] && tm[1] !== 'none' ? tm[1] : '';
                        const maN2 = tmBase.startsWith('ma') ? +tmBase.slice(2) : maN;
                        const trailPct2 = /^trail(\d+)$/.test(tmBase) ? +RegExp.$1 : trailPct;
                        // ═══ 🚪 V74.4.8 「外面大戶/華爾街在用的出場」全部做成可疊加的規則 ═══
                        //   be{P}   保本停損:漲過 +P% 之後,停損上移到進場價(Van Tharp / 多數 CTA 的標配)
                        //   tp{P}   固定停利:漲到 +P% 就走(散戶最愛,⛔ 但會把贏家砍掉 —— 要實測)
                        //   rr{K}   風報比停利:漲到「K 倍初始風險」就走(Tharp 的 R-multiple)
                        //   half{P} 分批:漲到 +P% 先出一半,剩下照底層規則走(機構常用的 scale-out)
                        //   don{N}  唐奇安/海龜出場:收盤跌破前 N 日最低(Dennis 海龜系統 1 用 10 日)
                        //   plow    跌破昨日最低就走(最激進的 1 根 K 移動停損)
                        //   sar     拋物線 SAR(Wilder;af 0.02 步進、上限 0.2)
                        //   x5_20   5 日線下穿 20 日線才走(比 ma5 慢很多的死亡交叉)
                        //   chandd{K} 動態 Chandelier:ATR 逐日更新(原 chandK 只在進場日算一次)
                        //   atrt{K} ATR 移動停損:停損 = max(舊停損, 收盤 − K×ATR),只升不降
                        //   ⛔ 全部只用「當天為止」的資料(零前視);⛔ 不改 stop 的初始算法
                        const beP = /be(\d+)/.test(a.exit) ? +RegExp.$1 : 0;
                        const tpP = /tp(\d+)/.test(a.exit) ? +RegExp.$1 : 0;
                        const rrK = /rr(\d+(?:\.\d+)?)/.test(a.exit) ? +RegExp.$1 : 0;
                        const halfP = /half(\d+)/.test(a.exit) ? +RegExp.$1 : 0;
                        // 🐢 don{N} = 標準唐奇安(前 N 日最低,**含進場前的 K 棒**,進場隔天就開始看)
                        //    don{N}w = 第一版誤寫的變體:進場後**前 N 天只看停損**、之後才看前 N 日低。
                        //    ⚠️ 兩個都留,因為第一批實跑 don10w 是全表第一 —— 要分得出贏的是
                        //      「唐奇安」還是「別太早砍」(⛔ 不可靜默改掉讓人以為是同一個東西)。
                        const donN = /^don(\d+)w?$/.test(a.exit) ? +RegExp.$1 : 0;
                        const donWait = /^don\d+w$/.test(a.exit);
                        const plow = a.exit === 'plow', sar = a.exit === 'sar', x520 = a.exit === 'x5_20';
                        const chanddK = /^chandd(\d+(?:\.\d+)?)$/.test(a.exit) ? +RegExp.$1 : 0;
                        const atrtK = /^atrt(\d+(?:\.\d+)?)$/.test(a.exit) ? +RegExp.$1 : 0;
                        const stop0 = stop;                       // 初始風險(rr 用)
                        const atrAt = j => {                      // ATR(14) 到第 j 天為止
                            let tr = 0, k = 0;
                            for (let q = Math.max(1, j - 13); q <= j; q++) {
                                const h = data[q].high, l = data[q].low, pc = C(q - 1);
                                tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); k++;
                            }
                            return k ? tr / k : 0;
                        };
                        // SAR 初始:從進場日的最低起算,EP = 進場日最高
                        let sarV = data[eIdx].low, sarEP = data[eIdx].high, sarAF = 0.02;
                        let halfDone = 0, halfRet = 0, dynStop = stop;
                        let peak = entry, tmHit = 0;
                        for (let j = eIdx + 1; j <= endJ; j++) {
                            const c = C(j);
                            if (c > peak) peak = c;
                            // 🛡️ 保本:漲過 +beP% 之後,停損上移到進場價(只升不降)
                            if (beP > 0 && peak >= entry * (1 + beP / 100) && stop < entry) stop = entry;
                            // 📐 ATR 移動停損(只升不降)
                            if (atrtK > 0) { const s2 = c - atrtK * atrAt(j); if (s2 > dynStop) dynStop = s2; if (c <= dynStop) { exitP = c; exitIdx = j; break; } }
                            if (c <= stop) { exitP = stop; exitIdx = j; break; }
                            // 🎯 固定停利 / 風報比停利:達標就走(⚠️ 用收盤價,不假設剛好碰到目標價)
                            if (tpP > 0 && c >= entry * (1 + tpP / 100)) { exitP = c; exitIdx = j; break; }
                            if (rrK > 0 && c >= entry + rrK * (entry - stop0)) { exitP = c; exitIdx = j; break; }
                            // ✂️ 分批:先出一半,剩下照底層規則走
                            if (halfP > 0 && !halfDone && c >= entry * (1 + halfP / 100)) { halfDone = 1; halfRet = (c - entry) / entry * 100; }
                            // 🐢 唐奇安:收盤跌破前 N 日最低(⛔ 不含今天)
                            if (donN > 0 && (!donWait || j - donN >= eIdx)) {
                                let lo = Infinity; for (let q = j - donN; q < j; q++) lo = Math.min(lo, data[q].low);
                                if (c < lo) { exitP = c; exitIdx = j; break; }
                            }
                            if (plow && c < data[j - 1].low) { exitP = c; exitIdx = j; break; }
                            // 🪂 拋物線 SAR(做多):先算今天的 SAR,再比
                            if (sar) {
                                sarV = sarV + sarAF * (sarEP - sarV);
                                sarV = Math.min(sarV, data[j - 1].low, j - 2 >= eIdx ? data[j - 2].low : data[j - 1].low);
                                if (data[j].high > sarEP) { sarEP = data[j].high; sarAF = Math.min(0.2, sarAF + 0.02); }
                                if (c < sarV) { exitP = c; exitIdx = j; break; }
                            }
                            if (x520 && j >= 19) {
                                let s5 = 0, s20 = 0; for (let q = 0; q < 20; q++) { s20 += C(j - q); if (q < 5) s5 += C(j - q); }
                                if (s5 / 5 < s20 / 20) { exitP = c; exitIdx = j; break; }
                            }
                            if (chanddK > 0) { const at = atrAt(j); if (at > 0 && c <= peak - chanddK * at) { exitP = c; exitIdx = j; break; } }
                            // ⏱️ 到了第 tmD 天,若最高點還沒漲過 tmP% → 認賠時間成本先出
                            // 🚨 這裡必須是 `<=` 不是 `<`:`peak` 從 `entry` 起算,
                            //    所以 tmP=0(「完全沒漲就出」)用 `<` 會變成 `entry < entry` = 永遠 false
                            //    → 那個變體**一次都不會觸發**,而輸出跟基準一字不差、看起來只是「沒差別」。
                            //    ⛔ 實測踩過:ma5tm5_0 跑出來跟 ma5/20 每一位數都相同。
                            if (tmD > 0 && j - eIdx >= tmD && peak <= entry * (1 + tmP / 100)) {
                                exitP = c; exitIdx = j; tmHit = 1; break;
                            }
                            if (maN2 > 0 && j >= maN2 - 1) {
                                let s2 = 0; for (let q = 0; q < maN2; q++) s2 += C(j - q);
                                if (c < s2 / maN2) { exitP = c; exitIdx = j; break; }
                            }
                            if (trailPct2 > 0 && c <= peak * (1 - trailPct2 / 100)) { exitP = c; exitIdx = j; break; }
                            if (chandK > 0 && chandATR > 0 && c <= peak - chandK * chandATR) { exitP = c; exitIdx = j; break; }
                            // 🚪 移動停利:從進場後的最高收盤回落 N% 就走(讓贏家跑,輸家照樣被 stop 砍)
                            if (j === endJ) { exitP = c; exitIdx = j; }
                        }
                        // ⚠️ inD 一律記「**訊號日**」—— 選股是那天晚上做的決定,
                        //   實際成交日在 eIdx。⛔ 若記成 eIdx,walk-forward 的時間軸會偏一天。
                        // ✂️ 分批出場:一半在 +halfP% 那天出、一半照底層規則出 → 報酬取平均
                        //    ⚠️ 資金釋放仍以最後出場日計(保守:分批那半的錢其實早一點回來)
                        const retRest = (exitP - entry) / entry * 100;
                        const retAll = halfDone ? 0.5 * halfRet + 0.5 * retRest : retRest;
                        out.push({ key: p.key, inD: data[i].date, outD: data[exitIdx].date,
                                   // 成交值(億):`volume` 是股 → ×收盤÷1e8
                                   amt: data[i].volume * data[i].close / 1e8,
                                   entry, stop: stop0,   // 💰 風險法算張數要用(⛔ 別在外面重算,基準會不一致)
                                   ret: retAll, tm: tmHit, hf: halfDone });
                        i = exitIdx + 1; continue;
                    }
                }
                i++;
            }
        }
        return out;
    }, { rows, entry: ENTRY, gapCap: GAPCAP, exit: EXIT, maxD: MAXD, stop: STOP });
    for (const t of tr) allTrades.push({ ...t, sym });
    if (++done % 50 === 0) {
        const el = (Date.now() - t0) / 1000;
        process.stdout.write(`\r   掃描 ${done}/${syms.length} ・${allTrades.length} 筆交易 ・${el.toFixed(0)}s`);
    }
}
console.log(`\r   ✅ 掃描完成:${done} 檔 ・${allTrades.length} 筆候選交易 ・${((Date.now() - t0) / 1000).toFixed(0)}s      \n`);
await browser.close();
    if (TRADES_CACHE) {
        fs.writeFileSync(TRADES_CACHE, JSON.stringify({ key: CACHE_KEY, trades: allTrades }));
        console.log(`💾 交易已快取:${TRADES_CACHE}`);
    }
}


if (!allTrades.length) { console.log('❌ 一筆交易都沒有 → 回測無效'); process.exit(1); }

// ── ② 時間軸:用加權指數的交易日 ────────────────────────────────────────
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
    .map(r => ({ d: String(r.date || '').replace(/\//g, '-').slice(0, 10), c: +r.close }))
    .filter(r => r.d && r.c > 0);
// 🏛️ 大盤月線(20MA):第 i 天只用 0..i 的資料 → ⛔ 零前視偏誤
const twiiMa20 = twii.map((_, i) => i < 19 ? null
    : twii.slice(i - 19, i + 1).reduce((s2, r) => s2 + r.c, 0) / 20);
const regimeOk = i => twiiMa20[i] != null && twii[i].c > twiiMa20[i];
// 🐻 V74.4.7 嚴格空頭守門(FILTER=bear60):只有「收 < 60 日線 且 20 日線 < 60 日線」才停做。
//   ⭐ 動機:月線版 regime 在含 2022 跌勢的窗口實測**兩頭輸**(少賺 68 萬、回撤還更糟)——
//   因為「跌破月線」大多是**多頭回檔**,而那正是這套打法最賺的時刻(V73.2.2)。
//   嚴格空頭(三態拆解:空頭段每趟淨 −0.29% vs 多頭/盤整 +0.98%)才是真的沒優勢的環境。
const twiiMa60 = twii.map((_, i) => i < 59 ? null
    : twii.slice(i - 59, i + 1).reduce((s2, r) => s2 + r.c, 0) / 60);
const notBear60 = i => !(twiiMa60[i] != null && twii[i].c < twiiMa60[i] && twiiMa20[i] < twiiMa60[i]);
const days = twii.map(r => r.d);
// ── 📅 行事曆特徵(純日期運算,零採礦;⛔ 全部只用「當天以前就知道的事」→ 無前視偏誤)
const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();          // 0=日 1=一 … 5=五
const ym = d => d.slice(0, 7);
// 台指期結算日 = 每月第三個星期三;遇休市則順延到下一個交易日
//   ⚠️ 用「實際有開盤的日子」推,⛔ 不可用日曆硬算(會落在休市日上)
const setDay = new Map();      // 'YYYY-MM' → 結算日(交易日)
{
    const byM = {};
    for (const d of days) (byM[ym(d)] ||= []).push(d);
    for (const m of Object.keys(byM)) {
        const third = `${m}-${String(15 + ((3 - new Date(m + '-01T00:00:00Z').getUTCDay() + 7) % 7)).padStart(2, '0')}`;
        // 第三個星期三的日曆日期 → 取「>= 它」的第一個交易日
        const hit = byM[m].find(d => d >= third);
        if (hit) setDay.set(m, hit);
    }
}
const isSet = d => setDay.get(ym(d)) === d;
const setWeekSet = new Set();  // 結算日所在那一週的所有交易日
for (const [m, sd] of setDay) {
    const i = days.indexOf(sd);
    for (let k = -4; k <= 4; k++) {
        const d2 = days[i + k];
        if (!d2) continue;
        // 同一個 ISO 週:用「距離結算日 <= 4 天且星期幾單調」太脆弱 → 直接比日曆週
        const w = x => { const t = new Date(x + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
        if (w(d2) === w(sd)) setWeekSet.add(d2);
    }
}
// 長假前最後一個交易日(下一個交易日隔了 >= 4 個日曆天)
const preHol = new Set();
for (let i = 0; i < days.length - 1; i++) {
    const gap = (new Date(days[i + 1]) - new Date(days[i])) / 86400000;
    if (gap >= 4) preHol.add(days[i]);
}
// 財報公布截止日前後 3 個交易日(⚠️ 這**不是法說會** —— 法說會沒有免費結構化資料源)
const finNear = new Set();
{
    const dl = ['-03-31', '-05-15', '-08-14', '-11-14'];
    const yrs = [...new Set(days.map(d => d.slice(0, 4)))];
    for (const y of yrs) for (const t of dl) {
        const target = y + t;
        let i = days.findIndex(d => d >= target);
        if (i < 0) continue;
        for (let k = -3; k <= 3; k++) if (days[i + k]) finNear.add(days[i + k]);
    }
}
// ── 📊 市場狀態事件(V73.2.1)——「特別的日子」之外,「特別的盤」才是重點
//    ⛔ 一律用 **i-1(昨天)** 的資料判斷:尾盤 13:00~13:28 掃描時,
//       今天的漲跌家數/地板股家數還沒結算 → 用今天的等於前視偏誤。
const bh = (() => {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(DATA, 'breadth.json'), 'utf8'));
        const m = new Map();
        for (const r of (j.history || [])) m.set(String(r.d || '').replace(/\//g, '-').slice(0, 10), r);
        return m;
    } catch (_) { return new Map(); }
})();
// 大盤 20 日波動率(年化 %)與它在近 250 日的位階
const twiiVol = twii.map((_, i) => {
    if (i < 20) return null;
    let s2 = 0;
    for (let k = i - 19; k <= i; k++) { const r = (twii[k].c - twii[k - 1].c) / twii[k - 1].c; s2 += r * r; }
    return Math.sqrt(s2 / 20) * Math.sqrt(252) * 100;
});
const volPct = i => {                     // 波動率位階(只看 i 之前,⛔ 無前視)
    if (twiiVol[i] == null) return null;
    const w = twiiVol.slice(Math.max(0, i - 249), i + 1).filter(x => x != null);
    if (w.length < 60) return null;
    return w.filter(x => x <= twiiVol[i]).length / w.length * 100;
};
const dd60 = i => {                        // 大盤距近 60 日高點回檔 %
    if (i < 60) return null;
    let hi = 0; for (let k = i - 59; k <= i; k++) hi = Math.max(hi, twii[k].c);
    return (hi - twii[i].c) / hi * 100;
};
const prevRet = i => i < 1 ? null : (twii[i - 1].c - twii[i - 2]?.c) / (twii[i - 2]?.c || 1) * 100;
const yBr = i => i < 1 ? null : bh.get(days[i - 1]) || null;   // 昨天的市場廣度
// 月底/季底最後 N 個交易日
const isMonthEnd = (i, n) => { const m = ym(days[i]); let c = 0; for (let k = i + 1; k < days.length && ym(days[k]) === m; k++) c++; return c < n; };
const isQEnd = (i, n) => ['03', '06', '09', '12'].includes(days[i].slice(5, 7)) && isMonthEnd(i, n);
// 長假後第一個交易日
const postHol = new Set();
for (let i = 1; i < days.length; i++)
    if ((new Date(days[i]) - new Date(days[i - 1])) / 86400000 >= 4) postHol.add(days[i]);

// 🚦 這一天准不准進場(⛔ 只影響「要不要開新倉」,不影響既有部位的出場)
const calOk = (d, i) => {
    for (const c of CAL) {
        if (c === 'nomon' && dow(d) === 1) return false;
        if (c === 'notue' && dow(d) === 2) return false;
        if (c === 'nowed' && dow(d) === 3) return false;
        if (c === 'nothu' && dow(d) === 4) return false;
        if (c === 'nofri' && dow(d) === 5) return false;
        if (c === 'noset' && isSet(d)) return false;
        if (c === 'nosetw' && setWeekSet.has(d)) return false;
        if (c === 'onlyset' && !isSet(d)) return false;
        if (c === 'norev' && +d.slice(8, 10) <= 10) return false;
        if (c === 'nofin' && finNear.has(d)) return false;
        if (c === 'nohol' && preHol.has(d)) return false;
        // 📅 交易層級探針發現「月內位置」是唯一單調的一組(中旬最好、下旬最差)
        if (c === 'nolate' && +d.slice(8, 10) >= 21) return false;      // 下旬不進場
        if (c === 'onlymid') { const n2 = +d.slice(8, 10); if (n2 < 11 || n2 > 20) return false; }
        // ── 📊 市場狀態事件(全部用昨天的資料判斷)
        if (c === 'posthol' && postHol.has(d)) return false;          // 長假後第一天不做
        if (c === 'onlyposthol' && !postHol.has(d)) return false;
        if (c === 'nomend' && isMonthEnd(i, 3)) return false;         // 月底最後 3 日不做
        if (c === 'noqend' && isQEnd(i, 5)) return false;             // 季底最後 5 日不做
        if (c === 'nodrop') { const r = prevRet(i); if (r != null && r < -1.5) return false; }
        if (c === 'onlydrop') { const r = prevRet(i); if (!(r != null && r < -1.5)) return false; }
        if (c === 'nohivol') { const v = volPct(i - 1); if (v != null && v >= 80) return false; }
        if (c === 'onlyhivol') { const v = volPct(i - 1); if (!(v != null && v >= 80)) return false; }
        if (c === 'nochase') { const x = dd60(i - 1); if (x != null && x < 1) return false; }   // 大盤貼著波段高 = 追高
        if (c === 'flr300') { const b2 = yBr(i); if (!(b2 && (b2.flr || 0) >= 300)) return false; }  // 地板股家數(V72.4.9 實測有邊際)
        if (c === 'noweak') { const b2 = yBr(i); if (b2 && b2.total > 0 && (b2.up || 0) / b2.total < 0.3) return false; }
        if (c === 'onlyweak') { const b2 = yBr(i); if (!(b2 && b2.total > 0 && (b2.up || 0) / b2.total < 0.3)) return false; }
        if (c === 'nolag') { const b2 = yBr(i); if (b2 && b2.idx != null && b2.med != null && (b2.idx - b2.med) > 0.5) return false; }
    }
    return true;
};

const dIdx = new Map(days.map((d, i) => [d, i]));

// 🧬 個股自身狀態表(⛔ 只用該日以前的資料 → 無前視偏誤)
const selfFeat = new Map();
if (SELF.length) {
    for (const sym of syms) {
        let rows;
        try { rows = JSON.parse(fs.readFileSync(path.join(DATA, `${sym}.json`), 'utf8')); } catch (_) { continue; }
        const dd = rows.map(r => ({ d: String(r.date || '').replace(/\//g, '-').slice(0, 10), c: +r.close, v: +r.volume || 0 }))
                       .filter(r => r.d && r.c > 0);
        const m = new Map();
        for (let i = 60; i < dd.length; i++) {
            const w = dd.slice(Math.max(0, i - 249), i + 1).map(r => r.c);
            const rank = w.filter(c => c <= dd[i].c).length / w.length * 100;
            let av = 0, cn = 0; for (let k = Math.max(0, i - 19); k <= i; k++) { av += dd[k].v; cn++; }
            let s3 = 0; for (let k = i - 19; k <= i; k++) s3 += Math.pow((dd[k].c - dd[k - 1].c) / dd[k - 1].c, 2);
            // 📐 乖離年線(240MA)—— V72.x 實測:向上穿越 200% 後 60 日邊際 −6.24%(中期壓力)
            //   ⚠️ 它跟「高位階」高度重疊 → 正好用來檢查「追高」策略的盲點
            let b240 = null;
            if (i >= 239) { let sm = 0; for (let k = i - 239; k <= i; k++) sm += dd[k].c; b240 = (dd[i].c / (sm / 240) - 1) * 100; }
            let ma20 = null, ma60 = null;
            { let s20 = 0; for (let k = i - 19; k <= i; k++) s20 += dd[k].c; ma20 = s20 / 20; }
            if (i >= 59) { let s60 = 0; for (let k = i - 59; k <= i; k++) s60 += dd[k].c; ma60 = s60 / 60; }
            m.set(dd[i].d, { ma20, ma60, c: dd[i].c, rank, volr: (cn && av) ? dd[i].v / (av / cn) : null, vol: Math.sqrt(s3 / 20) * Math.sqrt(252) * 100, b240 });
        }
        selfFeat.set(sym, m);
    }
    console.log(`🧬 個股自身狀態表:${selfFeat.size} 檔`);
}
const selfOk = t => {
    if (!SELF.length) return true;
    const f = selfFeat.get(t.sym)?.get(t.inD);
    if (!f) return false;                       // ⛔ 算不出來就不做(⛔ 不可當成通過)
    for (const c of SELF) {
        if (c === 'high' && !(f.rank >= RANK_MIN)) return false;
        if (c === 'low' && !(f.rank < 40)) return false;
        if (c === 'hivolat' && !(f.vol >= VOLAT_MIN)) return false;
        if (c === 'lovolat' && !(f.vol < 35)) return false;
        if (c === 'volup' && !(f.volr != null && f.volr >= 2)) return false;
        if (c === 'novolshrink' && !(f.volr != null && f.volr >= 1)) return false;
        // 📐 乖離年線太大就不做(⛔ 這是**排除**條件,測的是它會不會保護到「追高」策略)
        // 📉 個股自己的趨勢守門(⛔ 先前測的「大盤月線」少賺,個股層級沒測過 → 這次測)
        if (c === 'ma20' && !(f.ma20 != null && f.c > f.ma20)) return false;
        if (c === 'ma60' && !(f.ma60 != null && f.c > f.ma60)) return false;
        if (c === 'ma2060' && !(f.ma20 != null && f.c > f.ma20 && f.ma60 != null && f.c > f.ma60)) return false;
        if (c === 'nobias200' && (f.b240 != null && f.b240 > 200)) return false;
        if (c === 'nobias150' && (f.b240 != null && f.b240 > 150)) return false;
        if (c === 'nobias100' && (f.b240 != null && f.b240 > 100)) return false;
    }
    return true;
};

// 🔬 訊號對照表
let sigNames = [], sigOf = new Map(), plusIdx = new Set(), minusIdx = new Set();
if (SIGX.length && SIGMAP && fs.existsSync(SIGMAP)) {
    const sj = JSON.parse(fs.readFileSync(SIGMAP, 'utf8'));
    sigNames = sj.names || [];
    for (const [k, v] of Object.entries(sj.map || {})) sigOf.set(k, v);
    // ⭐ 名單寫死在這裡(⛔ 不自動從資料重挑,否則就是徹底的 in-sample)
    const PLUS = ['正乖離過大', '負乖離過大', 'W底(雙重底)', '換手量(洗籌續攻)', '多頭但追高',
                  '疑似竭盡缺口(高檔)', 'ABC下降切線突破', '實體長黑棒(最強空壓)',
                  '站上長黑K高點', '連漲過熱停利', '極端超跌・沒量', '站上長黑K平均成本'];
    const MINUS = ['威科夫·出貨段', '群星晨星', '群星夜星', '晨星轉折+爆量', '群星晨星+爆量'];
    sigNames.forEach((n, i) => {
        if (PLUS.some(p => n.includes(p))) plusIdx.add(i);
        if (MINUS.some(p => n.includes(p))) minusIdx.add(i);
    });
    console.log(`🔬 訊號對照表:${sigNames.length} 個訊號 ・加分 ${plusIdx.size} / 扣分 ${minusIdx.size} ・${sigOf.size.toLocaleString()} 個(股,日)`);
    // 🚧 空過守門:名單一個都沒對到 = 訊號改名 → ⛔ 不可讓它靜默變成「不過濾」
    if (!plusIdx.size || !minusIdx.size) { console.log('❌ 加分或扣分名單一個都沒對到 → 中止'); process.exit(1); }
}
const sigOk = t => {
    if (!SIGX.length) return true;
    const v = sigOf.get(`${t.sym}|${t.inD}`) || [];
    if (SIGX.includes('plus') && !v.some(i => plusIdx.has(i))) return false;
    if (SIGX.includes('minus') && v.some(i => minusIdx.has(i))) return false;
    return true;
};

// ── ③ Walk-forward 模擬 ────────────────────────────────────────────────
//    第 T 天選股時,型態成績只用「**出場日 < T**」的已完成交易 ⇒ 零前視偏誤。
const byIn = new Map();      // 進場日 → 候選交易
for (const t of allTrades) { if (dIdx.has(t.inD)) (byIn.get(t.inD) || byIn.set(t.inD, []).get(t.inD)).push(t); }
const byOut = new Map();     // 出場日 → 已完成交易(用來累積成績)
for (const t of allTrades) { if (dIdx.has(t.outD)) (byOut.get(t.outD) || byOut.set(t.outD, []).get(t.outD)).push(t); }

const stat = {};             // 「sym|key」→ {n, sum}(⭐ 每檔自己的打法成績)
const mkt = {};              // key → {n, sum}(全市場該型態,當第二層門檻)
const taken = [];            // 實際成交的交易
const openCnt = [];          // 每天同時持有幾筆
let live = [];               // 目前持有
let skipped = 0;             // 💰 因為錢不夠而錯過的次數(⛔ 一定要報 —— 不然等於假設無限資金)
let cash = CAPITAL;          // 現金
let realized = 0;            // 已實現損益
const equity = [];           // 逐日權益(算最大回撤)
for (let i = 0; i < days.length; i++) {
    const d = days[i];
    // 今天到期的先出場 → 錢回來
    for (const x of live.filter(x => dIdx.get(x.outD) <= i)) {
        // 💰 用**這一筆自己的投入金額**還原(等權時 _amt 就等於 LOT,結果與舊版完全相同)
        const a0 = x._amt || LOT;
        cash += a0 + a0 * (x.ret - COST) / 100;
        realized += a0 * (x.ret - COST) / 100;
    }
    live = live.filter(x => dIdx.get(x.outD) > i);
    // (a) 先把「今天之前已出場」的交易計入成績(⛔ 今天出場的還不能用 —— 那是今天才知道的)
    if (i > 0) for (const t of (byOut.get(days[i - 1]) || [])) {
        const s = (stat[`${t.sym}|${t.key}`] ||= { n: 0, sum: 0 });
        s.n++; s.sum += t.ret;
        const m = (mkt[t.key] ||= { n: 0, sum: 0 });
        m.n++; m.sum += t.ret;
    }
    if (i < WARMUP) continue;
    // (b) 今天觸發的候選,依「當下已知的期望值」排序
    //   ⭐ 兩層門檻(缺一不可):
    //     ① **這一檔**在**這個型態**上,到昨天為止扣成本後仍是賺的(= App 說「這檔適合這招」)
    //     ② 全市場該型態樣本夠(⛔ 擋掉「這檔剛好打中 4 次」的假強)
    //   排序用**這檔自己**的期望值 —— 這才是「每個個股最好的打法」。
    // 🏛️ 大盤環境濾網:大盤自己都在月線之下就整天不進場(⛔ 個股再強也不做)
    if (FILTER.includes('regime') && !regimeOk(i)) { continue; }
    if (FILTER.includes('bear60') && !notBear60(i)) { continue; }
    // 📅 行事曆濾網:這一天不准開新倉(既有部位照原規則出場,⛔ 不受影響)
    if (CAL.length && !calOk(d, i)) { openCnt.push(live.length); equity.push(cash + live.reduce((a2, x) => a2 + (x._amt || LOT), 0)); continue; }
    const todays = byIn.get(d) || [];
    // 🤝 同一檔今天有幾招同時觸發(共振)
    const hitCnt = {};
    for (const t of todays) hitCnt[t.sym] = (hitCnt[t.sym] || 0) + 1;
    const cand = todays
        .map(t => ({ t, s: stat[`${t.sym}|${t.key}`], m: mkt[t.key] }))
        .filter(x => x.s && x.s.n >= MIN_N && (x.s.sum / x.s.n) - COST > 0
                  && x.m && x.m.n >= MIN_MKT_N
                  && (!FILTER.includes('liq') || (x.t.amt || 0) >= LIQ)
                  && (!FILTER.includes('conf') || (hitCnt[x.t.sym] || 0) >= CONF)
                  && selfOk(x.t) && sigOk(x.t))
        .sort((a, b) => (b.s.sum / b.s.n) - (a.s.sum / a.s.n));
    const seen = new Set(live.map(x => x.sym));
    let picked = 0;
    for (const { t } of cand) {
        if (picked >= PICKS_PER_DAY) break;
        if (seen.has(t.sym)) continue;      // 同一檔不重複開倉
        // 💰 這一筆要投入多少?
        //   equal = 固定 LOT(前面所有結果都是這個)
        //   risk  = **App 實際給使用者的算法**:單筆最多虧帳戶 RISK_PCT%,
        //           張數 = 風險金額 ÷(每股風險 × 1000),再套單檔上限 POS_CAP_PCT% 帳戶
        //   ⛔ 這裡一定要用交易自己的 entry/stop,別在外面重算(基準會不一致)
        let amt = LOT;
        if (SCALE) {
            let k = 1;
            const x = dd60(i - 1), b3 = yBr(i);
            if (SCALE === 'dd60' || SCALE === 'both') {
                if (x != null) k *= x > 5 ? 1.5 : x < 1 ? 0.7 : 1;
            }
            if (SCALE === 'flr' || SCALE === 'both') {
                if (b3) k *= (b3.flr || 0) < 50 ? 0.5 : 1;
            }
            amt = Math.round(LOT * k);
        }
        if (SIZING === 'risk') {
            const per = (+t.entry || 0) - (+t.stop || 0);
            if (!(per > 0) || !(+t.entry > 0)) { continue; }
            let lots = Math.floor((CAPITAL * RISK_PCT / 100) / (per * 1000));
            lots = Math.min(lots, Math.floor(CAPITAL * POS_CAP_PCT / 100 / (t.entry * 1000)));
            if (lots <= 0) { continue; }          // 停損太寬 → App 也會顯「算出來 0 張」
            amt = lots * 1000 * t.entry;
        }
        // ⛔ 錢不夠就買不了 —— 這條一定要有,不然等於假設無限資金(那個報酬率是假的)
        if (cash < amt) { skipped++; continue; }
        seen.add(t.sym); cash -= amt;
        t._amt = amt;
        t._d = d; t._i = i;   // 📤 TAKEN_OUT 用:記下實際成交那天(⛔ 事後才標環境會對不上)
        taken.push(t); live.push(t); picked++;
    }
    openCnt.push(live.length);
    equity.push(cash + live.reduce((a, x) => a + (x._amt || LOT), 0));   // 持倉以成本計(保守,不逐日 mark-to-market)
}

if (!taken.length) { console.log('❌ 暖身後一筆都沒進場(門檻太嚴或樣本太小)'); process.exit(1); }

// 📤 把實際成交的交易(含當天市場環境)倒出來 —— 用來算「哪一種盤這套打法比較行」
//    ⛔ 這是**事實統計**不是預測;要當成訊號用之前一定要過穩健性檢定。
if (process.env.TAKEN_OUT) {
    const rows = taken.map(t => {
        const i = t._i, d = t._d, b2 = yBr(i);
        return {
            d, sym: t.sym, key: t.key, ret: t.ret,
            dow: new Date(d + 'T00:00:00Z').getUTCDay(),
            dom: +d.slice(8, 10),
            set: isSet(d) ? 1 : 0,
            vol: volPct(i - 1),                 // 大盤波動率位階
            dd60: dd60(i - 1),                  // 大盤距 60 日高回檔 %
            pret: prevRet(i),                   // 昨天大盤漲跌 %
            up: b2 && b2.total ? (b2.up || 0) / b2.total * 100 : null,   // 昨天上漲家數佔比
            flr: b2 ? (b2.flr || 0) : null,     // 昨天地板股家數
            lag: b2 && b2.idx != null && b2.med != null ? b2.idx - b2.med : null,
        };
    });
    fs.writeFileSync(process.env.TAKEN_OUT, JSON.stringify(rows));
    console.log(`📤 已輸出實際成交交易 ${rows.length} 筆 → ${process.env.TAKEN_OUT}`);
}

// ── ④ 結果:整體 / 每月 / vs 0050 ────────────────────────────────────────
const net = t => t.ret - COST;                       // 扣成本後的單趟報酬 %
const money = t => LOT * net(t) / 100;               // 每筆固定 10 萬 → 實際賺賠元
const totalPnL = taken.reduce((a, t) => a + money(t), 0);
const wins = taken.filter(t => net(t) > 0);
const avgOpen = openCnt.reduce((a, b) => a + b, 0) / openCnt.length;
const maxOpen = Math.max(...openCnt);
const capital = CAPITAL;
// 📉 最大回撤:權益曲線從高點掉下來最多幾 %(使用者最該知道「中途會不會嚇到砍在最低點」)
let peak = -Infinity, mdd = 0;
for (const e of equity) { if (e > peak) peak = e; mdd = Math.min(mdd, (e - peak) / peak * 100); }

// 🚨 V73.2.9 比較基準 bug:`from` 原本寫死 days[WARMUP],但 WARMUP 是從**指數**第 0 天算的。
//   指數補深到 5 年(1,213 筆)之後,days[240] 落在 2022-08 —— 而個股資料 2023-06 才開始
//   → 拿「5 年的大盤漲幅」去比「3 年的策略」,而且 0050 那時還沒資料 → 對照組直接消失
//     (實測輸出「0050 買進持有 (無資料)」「加權指數 +199.29%」)。
//   ⭐ 正解:對照組期間必須跟**實際交易期間**對齊 → 用第一筆成交日。
//   ⛔ 沒有對照組的報酬率沒有意義(本專案鐵則),所以這條不可省。
const _tk = taken.map(t => t._d || t.inD).filter(Boolean).sort();
const from = _tk[0] || days[WARMUP], to = days[days.length - 1];
const i0 = dIdx.get(from), i1 = days.length - 1;
// 0050 買進持有(同一段期間)
const f50 = JSON.parse(fs.readFileSync(path.join(DATA, '0050.json'), 'utf8'))
    .map(r => ({ d: String(r.date || '').replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(r => r.c > 0);
const px50 = d => { let hit = null; for (const r of f50) { if (r.d <= d) hit = r.c; else break; } return hit; };
const b50 = px50(from), e50 = px50(to);
const ret50 = (b50 && e50) ? (e50 - b50) / b50 * 100 - COST : null;
const twiiRet = (twii[i1].c - twii[i0].c) / twii[i0].c * 100;

// 每月
const byMon = {};
for (const t of taken) {
    const m = t.outD.slice(0, 7);
    (byMon[m] ||= { n: 0, w: 0, pnl: 0 });
    byMon[m].n++; if (net(t) > 0) byMon[m].w++; byMon[m].pnl += money(t);
}
const mons = Object.keys(byMon).sort();
const monWin = mons.filter(m => byMon[m].pnl > 0).length;

const nf = n => Math.round(n).toLocaleString('en-US');
const pct = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
console.log('═'.repeat(74));
console.log(`📅 期間:${from} ~ ${to}(${days.length - WARMUP} 個交易日 ・${mons.length} 個月)`);
const yrs = (days.length - WARMUP) / 244;
console.log(`💰 本金 ${nf(CAPITAL)} 元 ・每筆 ${nf(LOT)} 元 ・同時最多持有 ${maxOpen} 筆(平均 ${avgOpen.toFixed(1)} 筆 → 資金使用率 ${(avgOpen * LOT / CAPITAL * 100).toFixed(0)}%)`);
if (skipped) console.log(`⚠️ 有 ${skipped} 次訊號因為**錢已經用完**而錯過(本金再多一點結果會不同)`);
console.log('═'.repeat(74));
console.log(`\n📊 整體(扣掉來回成本 ${COST}%)`);
console.log(`   成交筆數      ${taken.length} 筆`);
console.log(`   勝率          ${(wins.length / taken.length * 100).toFixed(1)}%`);
console.log(`   每趟平均      ${pct(taken.reduce((a, t) => a + net(t), 0) / taken.length)}`);
console.log(`   累積損益      ${totalPnL >= 0 ? '+' : '−'}${nf(Math.abs(totalPnL))} 元`);
console.log(`   對本金報酬    ${pct(totalPnL / capital * 100)}  ${yrs >= 0.5 ? `(年化約 ${pct((Math.pow(1 + totalPnL / capital, 1 / yrs) - 1) * 100)})` : ''}`);
console.log(`   📉 最大回撤    ${mdd.toFixed(2)}%  ← 中途最難熬的時候(⚠️ 這是會不會半路砍在最低點的關鍵)`);
// 🚧 空過守門:設了濾網/出場變體,卻**一次都沒有真的觸發** → 輸出會跟基準一字不差,
//    而那看起來只是「這個變體沒差別」。⛔ 實測踩過(ma5tm5_0 用 `<` 永遠 false)。
{
    if (/half\d+/.test(process.env.EXIT || '')) {
        const hn = taken.filter(t => t.hf).length;
        console.log(hn ? `   ✂️ 分批(先出一半)觸發  ${hn} 筆(佔 ${(hn / taken.length * 100).toFixed(0)}%)`
                       : `   🚨 分批一次都沒觸發 —— 這個變體沒有生效,請先查判斷式`);
    }
    const tmM = /tm(\d+)_(\d+)/.exec(process.env.EXIT || '');
    if (tmM) {
        const tmN = taken.filter(t => t.tm).length;
        console.log(tmN
            ? `   ⏱️ 時間停損出場  ${tmN} 筆(佔 ${(tmN / taken.length * 100).toFixed(0)}%)`
            : `   🚨 時間停損一次都沒觸發 —— 這**不是「沒差別」,是這個變體沒有生效**,請先查判斷式`);
    }
}
console.log(`\n🆚 同期對照`);
console.log(`   0050 買進持有  ${ret50 == null ? '(無資料)' : pct(ret50)}`);
console.log(`   加權指數      ${pct(twiiRet)}`);
if (ret50 != null) {
    const diff = totalPnL / capital * 100 - ret50;
    console.log(`   ⭐ 這套 vs 0050:${diff >= 0 ? '贏' : '輸'} ${Math.abs(diff).toFixed(2)}pp`);
}
console.log(`\n📆 每月(共 ${mons.length} 個月,賺錢的月份 ${monWin}/${mons.length} = ${(monWin / mons.length * 100).toFixed(0)}%)`);
console.log('   月份      筆數   勝率    損益(元)');
for (const m of mons) {
    const b = byMon[m];
    console.log(`   ${m}   ${String(b.n).padStart(4)}  ${(b.w / b.n * 100).toFixed(0).padStart(4)}%  ${(b.pnl >= 0 ? '+' : '−') + nf(Math.abs(b.pnl))}`);
}
console.log(`\n🧩 實際用到的打法(⭐ 選股用「**這一檔自己**在這個型態的歷史成績」,不是全市場平均)`);
const useCnt = {};
for (const t of taken) (useCnt[t.key] ||= { n: 0, w: 0, sum: 0 }), useCnt[t.key].n++, useCnt[t.key].sum += net(t), (net(t) > 0 && useCnt[t.key].w++);
for (const [k, v] of Object.entries(useCnt).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`   ${k.padEnd(16)} ${String(v.n).padStart(4)} 筆 ・勝率 ${(v.w / v.n * 100).toFixed(0)}% ・每趟 ${pct(v.sum / v.n)}`);
}
console.log('\n' + '═'.repeat(74));
console.log('⚠️ 這份回測誠實揭露的限制(⛔ 別把數字當保證):');
console.log(`   ① **倖存者偏誤**:data/ 只有「現在還在市場」的股票 → 結果偏樂觀`);
console.log(`   ② 用收盤價成交,沒有滑價;實際掛單不一定買得到那個價`);
console.log(`   ③ 回測窗口只有這段期間,而這段是什麼行情會決定結果(加權 ${pct(twiiRet)})`);
console.log(`   ④ 每天最多 ${PICKS_PER_DAY} 檔、同一檔不重複開倉、錢用完就跳過(錯過 ${skipped} 次)`);
console.log(`   ⑤ 選股用 walk-forward(只用當下已知的成績)→ **沒有**前視偏誤,但也因此比「事後最佳化」難看`);
console.log('═'.repeat(74));
