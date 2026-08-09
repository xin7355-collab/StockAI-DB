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
const ENTRY = process.env.ENTRY || 'close';   // close | nextopen | nextclose | nextopen_lim(見 page.evaluate 內註解)
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
const files = fs.readdirSync(path.join(ROOT, 'data'))
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
        rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${sym}.json`), 'utf8'));
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
                    let entry = a.entry === 'nextopen' ? (O(eIdx) > 0 ? O(eIdx) : C(eIdx))
                              : a.entry === 'nextclose' ? C(eIdx)
                              : a.entry === 'nextopen_lim' ? (O(eIdx) > 0 ? O(eIdx) : C(eIdx))
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
                        const maN = a.exit === 'ma10' ? 10 : a.exit === 'ma20' ? 20 : a.exit === 'ma5' ? 5 : 0;
                        const trailPct = /^trail(\d+)$/.test(a.exit) ? +RegExp.$1 : 0;
                        let peak = entry;
                        for (let j = eIdx + 1; j <= endJ; j++) {
                            const c = C(j);
                            if (c > peak) peak = c;
                            if (c <= stop) { exitP = stop; exitIdx = j; break; }
                            // 🚪 移動停利:從進場後的最高收盤回落 N% 就走(讓贏家跑,輸家照樣被 stop 砍)
                            if (trailPct > 0 && c <= peak * (1 - trailPct / 100)) { exitP = c; exitIdx = j; break; }
                            if (maN > 0 && j >= maN - 1) {
                                let sum = 0; for (let q = 0; q < maN; q++) sum += C(j - q);
                                if (c < sum / maN) { exitP = c; exitIdx = j; break; }
                            }
                            if (j === endJ) { exitP = c; exitIdx = j; }
                        }
                        // ⚠️ inD 一律記「**訊號日**」—— 選股是那天晚上做的決定,
                        //   實際成交日在 eIdx。⛔ 若記成 eIdx,walk-forward 的時間軸會偏一天。
                        out.push({ key: p.key, inD: data[i].date, outD: data[exitIdx].date,
                                   // 成交值(億):`volume` 是股 → ×收盤÷1e8
                                   amt: data[i].volume * data[i].close / 1e8,
                                   entry, stop,   // 💰 風險法算張數要用(⛔ 別在外面重算,基準會不一致)
                                   ret: (exitP - entry) / entry * 100 });
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
const twii = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '^TWII.json'), 'utf8'))
    .map(r => ({ d: String(r.date || '').replace(/\//g, '-').slice(0, 10), c: +r.close }))
    .filter(r => r.d && r.c > 0);
// 🏛️ 大盤月線(20MA):第 i 天只用 0..i 的資料 → ⛔ 零前視偏誤
const twiiMa20 = twii.map((_, i) => i < 19 ? null
    : twii.slice(i - 19, i + 1).reduce((s2, r) => s2 + r.c, 0) / 20);
const regimeOk = i => twiiMa20[i] != null && twii[i].c > twiiMa20[i];
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
        const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'breadth.json'), 'utf8'));
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
                  && (!FILTER.includes('conf') || (hitCnt[x.t.sym] || 0) >= CONF))
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

const from = days[WARMUP], to = days[days.length - 1];
const i0 = dIdx.get(from), i1 = days.length - 1;
// 0050 買進持有(同一段期間)
const f50 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '0050.json'), 'utf8'))
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
