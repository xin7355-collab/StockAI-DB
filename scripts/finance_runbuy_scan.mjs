#!/usr/bin/env node
/**
 * 🏦 「哪幾檔金融股現在亮著『唯一有實測背書的分點訊號』?」—— 一次性掃描
 *
 * 使用者 2026-09-15:「最近盤面都很差,只有金融比較好,我想了解的是
 *   有沒有關鍵分點已經偷偷佈局,我是不是跟著他做就可以了」
 *
 * ⭐ 先把問題拆對(這是這支存在的理由):
 *   🚨 「**偷偷**佈局」那個方向,本站已經測到底了 = **不成立**:
 *      ・分點集中度(chips_deep_probe,467 天・106 萬股·日):買 −0.60pp / 賣 −0.68pp,
 *        **每一桶、每一年都輸對照組**;買賣兩端同號 → 那是**活躍度**不是方向
 *      ・分點同盟集團(broker_ally_probe):兩段學到的名單**重疊率 0%**
 *      ・券商 × 產業(broker_ind_probe,546 萬筆):重疊率 4.7% ≈ 隨機 5.3%
 *      ・地緣分點(broker_skill_probe,377 萬筆買超事件):**+0.01pp**
 *      ・🚨 **「隱形吃貨」= 連買但股價還沒動(這正是「偷偷佈局」)**:**+0.06pp ≈ 零**
 *   ✅ 全站唯一通過六關的分點訊號是 `app._chipRunBuy`(index.html):
 *      **同一分點連買 ≥3 個連續交易日 且 5 日已漲 ≥8%**
 *      → 10 日 **+0.85pp** / 20 日 **+1.36pp**、n=**34,505**、前後半同向
 *        (broker_cross_probe,對照組 = **同漲幅**的單日買超)
 *   ⭐⭐ 方向剛好跟直覺相反:有用的是「**已經發動才跟**」,⛔ 不是「趁還沒動偷偷跟」。
 *      而金融現在正好處在「已發動」狀態(近 20 日 +6.45%,33 個產業第 1)→ 這條規則正好適用。
 *
 * ⛔ 三條不可違反:
 *   ① **呼叫真正的 `app._chipRunBuy`**(headless 載入 index.html),
 *      ⛔ 不可在這裡自己寫一份等價邏輯 —— 那樣量到的是那份等價邏輯,不是產品(陷阱 #40 第六例)。
 *   ② 母體 = **官方產業代碼 17「金融保險」**(`data/industry_map.json`,實測 40 檔),
 *      ⛔ 不是 `common.py:SECTOR_MEMBERS.finance` 那 5 檔 —— 那是**題材分群**,兩套體系不可混用。
 *   ③ 輸出**必須**印出三句限制(未扣成本 / 窗口偏多頭 / 那是 20 日平均不是保證)。
 *
 * 🚨🚨 **2026-09-15 實跑當場撞到:它吃的那個欄位目前是髒的 —— 輸出的張數⛔ 不可信**
 *   `data/chips/{sym}.json` 的 `hist[].b/.s` 與 `periods` 的 `net` 欄位被汙染:
 *     ・**99.9%** 的股票(2,696/2,700)的 `hist` 裡有**同名分點重複**(一筆對、一筆被灌大)
 *     ・**85.3%** 的 `periods` 記錄 `|net| > max(buy, sel)` —— **算術上不可能**(net = 買 − 賣 ≤ 買)
 *     ・Σ(買方正淨額) ÷ 當日量 中位 **160~410%**(>100% 物理不可能),全 tier、全流動性級距皆然
 *     ・跟 `chips_deep`(官方原值、也是回測用的那份)逐日比,倍率 **2.3x ~ 16.4x 亂跳**
 *       實例 6021 · 2026-09-10(當日量 737,985 股):`hist` 寫 永豐金 **2,393,000**(324% 量),
 *       深歷史是 **484,000**(65.6%)—— 而同一天 `hist` 裡還有第二筆也叫「永豐金」,值剛好就是 484,000
 *   🔍 真因(`miner.py`):還原舊資料那條路徑用**券商名**當 key(約 L5272-5288,`_e['net'] += _nt`)、
 *      抓新資料那條用**券商代號**當 key(約 L5325)→ 同一家變成兩筆,而名稱那筆**每輪把自己
 *      上一輪的輸出再加一次**(它讀的就是自己寫出去的 `hist`)。還原路徑⛔ 不寫 buy/sel → net > buy。
 *   💥 後果兩層:① 整個券商分點頁的張數都可能是錯的
 *      ② **`_chipRunBuy` 的「單日淨買 ≥ 當日量 0.5%」門檻實際上鬆了數倍**
 *         → 前端跳出來的訊號 **≠ `broker_cross_probe` 驗過的那條規則**(那支用的是乾淨的 chips_deep)
 *   ⏭️ **修好之前,這支的命中清單只能當「有沒有東西」的粗篩,⛔ 張數與命中與否都別當真。**
 *      修法與佐證見 `docs/DECISIONS.md`。
 *
 * ⛔ 這是**巡邏/查詢工具**:exit 0、不進四驗證、不寫任何檔、不打網路。
 * 跑法:node scripts/finance_runbuy_scan.mjs [產業代碼,預設 17]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const IND = String(process.argv[2] || '17');

const log = (...a) => console.log(...a);
const nf = n => (n == null || !isFinite(n)) ? '—' : n.toLocaleString('en-US');

// ── 母體:官方產業對照表 ───────────────────────────────────────────
let mapRaw;
try { mapRaw = JSON.parse(fs.readFileSync(path.join(DATA, 'industry_map.json'), 'utf-8')); }
catch (e) { console.error('❌ 讀不到 data/industry_map.json —— 先跑 bash scripts/fetch_testdata.sh'); process.exit(0); }
const MAP = mapRaw['2330'] ? mapRaw : (mapRaw.map || mapRaw);
const syms = Object.keys(MAP).filter(k => String(MAP[k]) === IND).sort();

// 🚧 空過守門:母體抓不到就直接說,⛔ 不可印一張空表讓人以為「沒有人在買」
if (syms.length < 5) {
    console.error(`❌ 產業代碼 ${IND} 只對到 ${syms.length} 檔(<5)→ 母體不可信,不掃。`);
    console.error('   ⛔ 別把這個讀成「沒有訊號」—— 是清單本身有問題。');
    process.exit(0);
}
log(`🏦 母體:官方產業代碼 ${IND} ・ ${syms.length} 檔`);

// ── 讀 K 線 + 分點 hist ───────────────────────────────────────────
const pack = {};
let noChip = 0, noK = 0;
for (const s of syms) {
    let rows = null, hist = null, dataDate = null, tier = null;
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(DATA, `${s}.json`), 'utf-8'));
        if (Array.isArray(raw)) {
            rows = raw.filter(r => +r.close > 0 && r.date)
                .map(r => ({ date: String(r.date).replace(/\//g, '-'), open: +(r.open || r.close), high: +(r.high || r.close), low: +(r.low || r.close), close: +r.close, volume: +(r.volume || 0) }));
        }
    } catch (_) { }
    try {
        const c = JSON.parse(fs.readFileSync(path.join(DATA, 'chips', `${s}.json`), 'utf-8'));
        hist = Array.isArray(c.hist) ? c.hist : null;
        dataDate = c.data_date || null;
        tier = c.tier || null;
    } catch (_) { }
    if (!rows || rows.length < 10) { noK++; continue; }
    if (!hist || hist.length < 3) { noChip++; continue; }
    pack[s] = { rows, hist, dataDate, tier };
}
const scanned = Object.keys(pack);
log(`📂 有 K 線 + 分點歷史可掃:${scanned.length} 檔(缺 K 線 ${noK} ・缺分點 ${noChip})`);
if (!scanned.length) { console.error('❌ 一檔都掃不了'); process.exit(0); }

// ── headless:呼叫**真正的** app._chipRunBuy ────────────────────────
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
page.on('pageerror', () => { });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._chipRunBuy === 'function', null, { timeout: 30000 });

// 🚧 空過守門 ②:確認抓到的真的是那支函式(⛔ 不是同名的別的東西)
const srcOk = await page.evaluate(() => {
    const s = String(app._chipRunBuy);
    return { has8: /chg5 < 8/.test(s), has05: />= 0\.5/.test(s), len: s.length };
});
if (!srcOk.has8 || !srcOk.has05) {
    console.error('❌ `_chipRunBuy` 的判定條件跟預期對不上(找不到「5 日 ≥8%」或「單日 ≥0.5% 量」)');
    console.error('   ⛔ 條件改過的話,這支的說明與引用的實測數字也要一起更新,先別讀它的輸出。');
    await browser.close(); process.exit(0);
}

const hits = [];
for (const s of scanned) {
    const { rows, hist } = pack[s];
    const r = await page.evaluate(a => {
        app.currentSymbolId = a.sym;
        app._fenSym = a.sym;                 // `_chipRunBuy` 第一道就是比對這個
        app.rawDailyData = a.rows;
        try { return app._chipRunBuy(a.sym, a.hist); } catch (e) { return { __err: String(e && e.message || e) }; }
    }, { sym: s, rows, hist });
    if (r && r.__err) { log(`   ⚠️ ${s} 丟例外:${r.__err}`); continue; }
    if (r) hits.push({ s, ...r, last: rows[rows.length - 1], dataDate: pack[s].dataDate, tier: pack[s].tier });
}
await browser.close();

// ── 🚨 資料健檢:它吃的那個欄位現在是不是髒的 ─────────────────────
// ⛔ 只把警告寫在檔頭註解沒有用 —— 跑的人看不到。這裡**每次實測一遍**再報,
//    而且⛔ 不是印個警告繼續裝沒事:命中清單會整段標成不可信。
let dupDays = 0, dayN = 0, overVol = 0, volN = 0;
for (const s of scanned) {
    const { rows, hist } = pack[s];
    const kmap = new Map(rows.map(r => [r.date, r]));
    for (const h of hist) {
        dayN++;
        const nms = [...(h.b || []), ...(h.s || [])].map(x => String(x[0]));
        if (new Set(nms).size !== nms.length) dupDays++;
        const row = kmap.get(String(h.d || '').replace(/\//g, '-'));
        const vol = row ? row.volume : 0;
        if (vol > 0) {
            volN++;
            const tot = (h.b || []).reduce((a, x) => a + Math.max(0, +x[1] || 0), 0);
            if (tot > vol) overVol++;
        }
    }
}
const dirty = dayN > 0 && (dupDays / dayN > 0.2 || (volN > 0 && overVol / volN > 0.2));

// ── 輸出 ──────────────────────────────────────────────────────────
if (dirty) {
    log('');
    log('🚨'.repeat(30));
    log('🚨 分點淨額欄位目前是**髒的** → 下面的張數與命中與否 ⛔ 都不可當真');
    log(`   ・同一天出現**同名分點重複**:${dupDays}/${dayN} 天(${(dupDays / dayN * 100).toFixed(1)}%)`);
    log(`   ・買方淨額合計 > 當日總量(物理不可能):${overVol}/${volN} 天(${(overVol / volN * 100).toFixed(1)}%)`);
    log('   ・真因**兩個**(V77.0.5 查到底):① 批次模式沒擋「本地已有這天」→ 同一天被抓一次又還原一次,\n     而兩條路一個用券商名、一個用代號當 key → 逃過覆蓋、加倍,又寫回 hist → **每輪再滾一次**\n     ② 同名分行沒先併就進 top-15 → 41% 的格是重複名字。詳見 docs/DECISIONS.md V77.0.5');
    log('🚨'.repeat(30));
}
log('');
log('═'.repeat(88));
log('✅ 唯一有實測背書的分點訊號:同一分點「連買 ≥3 個連續交易日」+「5 日已漲 ≥8%」');
log('═'.repeat(88));

if (!hits.length) {
    log(`\n🔍 ${scanned.length} 檔金融股裡,**一檔都沒有命中**。`);
    log('');
    log('   ⭐ 這不是「掃描壞掉」,而且它跟「金融很強」完全不衝突 —— 兩件事:');
    log('     ① 「5 日已漲 ≥8%」是**個股**級的急拉門檻。金融是**整族慢慢墊高**');
    log('        (近 20 日 +6.45% 是 20 日累積,不是 5 日噴 8%)。');
    log('     ② 沒有任何一家分點連三天都買到當日量的 0.5% 以上。');
    log('   → 也就是說:金融這一波**沒有「單一分點連續進貨」的痕跡**,');
    log('     它是**外資整體**在買(20 日 +223,889 張,全板塊第一、第二名差 10 倍),');
    log('     那是「一大群人一起買」,⛔ 不是「某個關鍵分點在偷偷卡位」。');
} else {
    hits.sort((a, b) => b.chg5 - a.chg5);
    log('');
    for (const h of hits) {
        const bs = h.brokers.map(b => `${b.nm} ${nf(b.lots)} 張`).join(' ・ ');
        log(`  🔴 ${h.s}  5 日 +${h.chg5.toFixed(1)}%  收 ${h.last.close}  (分點資料日 ${h.dataDate || '—'}${h.tier ? ' / ' + h.tier : ''})`);
        log(`      連買 ${h.days} 天的分點:${bs}`);
    }
}

log('');
log('─'.repeat(88));
log('⚠️ 這串數字要怎麼讀(⛔ 三句都不可略過):');
log('   ① **未扣交易成本** —— 來回約 0.44%,而這條訊號的 20 日邊際是 +1.36pp。');
log('   ② **窗口偏多頭** —— 回測窗口 467 個交易日(2024-08~2026-08),那段大盤是漲的。');
log('   ③ **+1.36pp 是 20 日平均,不是保證** —— 它是「比同樣漲幅的單日買超好 1.36 個百分點」,');
log('      ⛔ 不是「會漲 1.36%」,更不是「一定賺」。n=34,505、前後半同向。');
log('');
log('🚨 而「跟著關鍵分點偷偷佈局」那個方向,本站已經測到底了 = **不成立**:');
log('   ・分點集中度 106 萬(股·日):買 −0.60pp / 賣 −0.68pp,每一桶每一年都輸對照組');
log('   ・分點同盟名單重疊率 **0%** ・券商×產業 4.7% ≈ 隨機 5.3% ・地緣分點 +0.01pp');
log('   ・**連買但股價還沒動(= 隱形吃貨,就是「偷偷佈局」)= +0.06pp ≈ 零**');
log('   ⭐ 分點的資訊在「動能確認」與「擁擠警訊」兩端,**不在「提前潛伏」端**。');
