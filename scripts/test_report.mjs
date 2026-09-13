#!/usr/bin/env node
/**
 * 📄 V75.1.1 報告分頁測試(index.html 個股頁第 9 個 sub-tab)
 *
 * 背景:使用者拿一份別家 AI 產的「個股產業報告」(中美晶 5483,目標價 250–280)問「散戶救星做得到嗎」。
 *   對完資料:基本面全對得上、價格那塊全錯、目標價 = 猜的 EPS × 猜的倍數。
 *   → 做成一頁式報告,但**每一格只轉述既有零件**、目標價那塊改成「歷史估值對照價位」。
 *
 * ⛔ 這支要擋住的(每條先想「注入什麼它會叫」):
 *   ① 忘加 switchSubTab 陣列 → 分頁顯示不出來      ② 指數沒藏這頁
 *   ③ 渲染層自己寫買賣指令 / 出現「目標價」        ④ 同業列硬湊(上櫃無官方分類要說出來)
 *   ⑤ 估值表公式/列序跟 pro.html 漂移              ⑥ 年化 EPS 來源靜默換掉
 *   ⑦ 融資停產顯 0 而不是「停在哪天」              ⑧ 數字卡漏標日期
 *   ⑨ 缺資料留 `--`                                 ⑩ 風險段用紅綠燈
 *   ⑪ 切股殘留(陷阱 #19)                          ⑫ 提示詞漏防幻覺 / 用 window.open
 *   ⑬ 誤呼叫 FinMind                                ⑭ % 不配元
 *   ⑮ 反查器插值方向反                              ⑯ pageerror
 *
 * 測資:**真實 gh-pages 產物**(`git show origin/gh-pages:data/…`,⛔ 不憑印象編;陷阱 #40),
 *   本機沒有 origin/gh-pages 時退回 data/ 目錄,兩邊都沒有就誠實 exit 1。
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { sliceOne, detectAll } from './fin_slice.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };

// ── 測資(真實產物)──
const gh = (f) => {
    try { return JSON.parse(execSync(`git -C "${ROOT}" show origin/gh-pages:data/${f}`, { encoding: 'utf8', maxBuffer: 64 << 20 })); }
    catch (_) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')); } catch (__) { return null; } }
};
const FX = {
    k5483: gh('5483.json'), k2330: gh('2330.json'), k2327: gh('2327.json'), chips5483: gh('chips/5483.json'),
    div: gh('dividends.json'),
    fyg: gh('fund_yoy_gm.json'), band: gh('pe_band.json'), fc: gh('fundamentals_cache.json'),
    ipe: gh('industry_pe.json'), imap: gh('industry_map.json'), tdcc: gh('tdcc_holders.json'),
    macro: gh('macro_risk.json'), pb: gh('playbook_edge.json'), att: gh('attention_status.json'),
    // 🏭 V76.0.0 產業報告的四個來源(⛔ 一樣是真實產物,不憑印象編 —— 陷阱 #40)
    scr: gh('screener.json'), tags: gh('stock_tags.json'), rot: gh('sector_rot.json'), corr: gh('top_correlations.json'),
    fmx: gh('fmx_pack.json'),
};
const missing = Object.entries(FX).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) { console.log(`❌ 測資抓不到(origin/gh-pages 與 data/ 都沒有):${missing.join(', ')} —— ⛔ 不跑假測試`); process.exit(1); }
// 🚧 測資守門:5483 要有「融資餘額停在較早日期」這個情境(⑦ 靠它),沒有就直接說
const lastMg = [...FX.k5483].reverse().find(r => +r.margin_balance > 0);
const lastK = FX.k5483[FX.k5483.length - 1];
console.log(`ℹ️ 5483 K 線末日 ${lastK.date}・最後一筆融資 ${lastMg ? lastMg.date : '無'}・chips data_date ${FX.chips5483.data_date}`);

// ── 靜態斷言(⛔ 先剝註解,本專案第 16 次踩「說明 bug 的註解含被禁字串」)──
const strip = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');   // 整行註解 + 行尾註解都剝
{
    const sw = SRC.slice(SRC.indexOf('    switchSubTab(tab) {'), SRC.indexOf('    switchSubTab(tab) {') + 9000);
    // ⚠️ V76.0.1 報告分頁搬到「總覽」右邊 → ⛔ 這條**不可以**釘「Report 排在陣列最後」,
    //   那是釘住當時的實作而不是用意(CLAUDE.md:斷言要釘用意)。用意 = 它有在那個陣列裡。
    ok('① switchSubTab 的容器陣列含 Report(⛔ 漏加 = 分頁永遠顯示不出來)', /\['Strategy'[^\]]*'Report'[^\]]*\]/.test(sw));
    ok('①c ⭐ 報告分頁的按鈕就排在「總覽」右邊(使用者指定的位置)',
       /id="subTabBtnStrategy"[\s\S]{0,400}?id="subTabBtnReport"[\s\S]{0,400}?id="subTabBtnLive"/.test(SRC));
    ok('①b switchSubTab 有 report 分支呼叫 renderReportTab', /tab === 'report'[\s\S]{0,200}renderReportTab/.test(sw));
    ok('② _idxHiddenSubTabs 含 report 且 MAP 含 report: \'Report\'', /_idxHiddenSubTabs: \[[^\]]*'report'\]/.test(SRC) && /bullbear: 'BullBear', report: 'Report'/.test(SRC));
    ok('⑪a analyze() 切股清單含十一個 rp*(⛔ 少一個 = 那一段顯上一檔)', ['rpNum', 'rpLead', 'rpVal', 'rpFund', 'rpInd', 'rpChip', 'rpRisk', 'rpAct', 'rpSrc', 'rpQuick', 'rpWalls'].every(id => new RegExp(`'deepBriefCard', 'deepBriefAi',[\\s\\S]{0,400}'${id}'`).test(SRC)));
    // ③ 渲染層不可自己寫買賣指令:只掃報告區塊(_rpNumHtml ~ _reportAsk),排除轉述 _ovDecide 的那支
    const a = SRC.indexOf('    _rpNumHtml('), b = SRC.indexOf('    _reportAsk(');
    const blk = strip(SRC.slice(a, b));
    ok('③a 報告渲染層不可出現新的操作指令動詞(順勢做多/可進場/加碼/追…)', !/(順勢做多|可以進場|可進場|放心做|可加碼|建議買進|建議賣出|追要|可以追)/.test(blk), (blk.match(/(順勢做多|可以進場|可進場|放心做|可加碼|建議買進|建議賣出|追要|可以追)/) || [])[0]);
    ok('③b 報告區塊不呼叫任何偵測器/計分函式(⛔ 不產生第二份真相)', !/_detect[A-Z]\w*\(|_calcBullBearScan\(|_sixMeridianCalc\(|_entryCheckup\(/.test(blk));
    ok('⑬a 報告區塊零 FinMind 字串', !/finmind/i.test(blk));
    const ask = strip(SRC.slice(SRC.indexOf('    _reportPrompt('), SRC.indexOf('    _reportAsk(') + 600));   // ⚠️ 先剝註解(說明「不用 window.open」的註解本身含那個字)
    ok('⑫c _reportAsk 走 _freeAiOpen、⛔ 不用 window.open', /_freeAiOpen\(/.test(ask) && !/window\.open/.test(ask));
    // 陷阱 #37:法說會比對只剩一份(reminder 要呼叫共用的)
    const rem = SRC.slice(SRC.indexOf('    _renderStockEarningsReminder('), SRC.indexOf('    _renderStockEarningsReminder(') + 2500);
    ok('⑰ 法說會事件比對抽成 _findEarningsEvent,現價下方的提醒要呼叫它(⛔ 不可再抄一份迴圈)', /_findEarningsEvent\(sym, 2\)/.test(rem) && !/for \(const ev of events\)/.test(rem));
}

// 📦 V76.1.8 財報三表切片 fixture:用**真的** fin_slice.sliceOne 切真檔(⛔ 不在測試裡編一份 slice 形狀)
const FIN_SLICE = (() => {
    try {
        let F = null;
        const lp = path.join(ROOT, 'fin_deep', 'fin_deep.json');
        if (fs.existsSync(lp)) F = JSON.parse(fs.readFileSync(lp, 'utf8'));
        else F = JSON.parse(execSync(`git -C "${ROOT}" show origin/fin_deep:fin_deep/fin_deep.json`, { encoding: 'utf8', maxBuffer: 64 << 20 }));
        const CUM = detectAll(F);
        return { '2327': sliceOne(F, CUM, '2327'), '2330': sliceOne(F, CUM, '2330') };
    } catch (_) { return null; }
})();

// ── 動態 ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Request scheme 'file' is unsupported|Cache\.put/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
let finmindHits = 0;
page.on('request', r => { if (/finmindtrade\.com/i.test(r.url())) finmindHits++; });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderReportTab, null, { timeout: 30000 });
await page.waitForTimeout(1200);

// 灌快取(全部真實產物;⛔ 繞過抓不到的 fetch,不繞過任何判斷)
await page.evaluate((F) => {
    const A = app;
    A._fundCacheAll = { ts: Date.now(), data: F.fc };
    A._fundYoyGmAll = { ts: Date.now(), data: F.fyg };
    A._peBandAll = { ts: Date.now(), data: F.band };
    A._industryPeCache = { ts: Date.now(), data: { industries: F.ipe.industries || {}, map: F.imap || {} } };
    A._tdccHoldersCache = F.tdcc;
    A._macroRiskCache = Object.assign({}, A._macroRiskCache || {}, F.macro);
    A._pbEdge = F.pb;
    A.attentionStatus = (F.att && F.att.stocks) || {};
    // 🏭 產業報告來源(照各自 loader 寫進去的形狀灌,⛔ 不繞過任何判斷)
    A._scrData = F.scr; A._scrC = {}; (F.scr.cols || []).forEach((k, i) => { A._scrC[k] = i; });
    A._tagsCache = F.tags; A._secRotCache = F.rot; A._corrCache = F.corr;
    A._fmxCache = (F.fmx && F.fmx.data) || {};
    // 分點:用真實 chips/5483.json 餵 _loadFenPeriodsDirect 的結果(它抓不到 file://)
    window.__chips = { '5483': F.chips5483 };
    A._loadFenPeriodsDirect = async function (sym) {
        sym = String(sym); const raw = window.__chips[sym]; if (!raw) return false;
        this._fenPeriods = raw.periods; this._fenSym = sym; this._fenDataDate = raw.data_date || null;
        this._fenFund = raw.fundamentals || null; this._fenHist = raw.hist || null; return true;
    };
    window.__K = { '5483': F.k5483, '2330': F.k2330, '2327': F.k2327 };
    A._divFileCache = { ts: Date.now(), data: F.div };
    window.__FIN = F.fin || null;
    A._finSlimCache = {};
    if (window.__FIN) for (const k of Object.keys(window.__FIN)) A._finSlimCache[k] = { ts: Date.now(), data: window.__FIN[k] };
}, Object.assign({}, FX, { fin: FIN_SLICE }));

// ⑬ FinMind 計數要在**乾淨的窗口**量:init() 與 analyze() 的背景鏈(fetchStockList / X 光機)本來就會打 FinMind,
//   ⛔ 跟報告頁混在同一段計數會變成隨機紅燈(第一版就這樣)→ 等 init 安靜 4 秒、不跑 analyze、直接餵 K 線渲染。
await page.waitForTimeout(4000);
finmindHits = 0;
await page.evaluate(async () => {
    const A = app; A.switchAppTab && A.switchAppTab('diag');
    A.currentSymbolId = '5483'; A.rawDailyData = JSON.parse(JSON.stringify(window.__K['5483'])); A.activeData = A.rawDailyData; A.baseRawData = A.rawDailyData;
    A.switchSubTab('report'); await A.renderReportTab('5483'); await new Promise(r => setTimeout(r, 1500));
});
const hitsAfterRender = finmindHits;

// 開個股頁、載 5483(真實 K 線),再把 rawDailyData 換成 gh-pages 那份(本機 data/ 可能較舊)
const render = async (sym) => {
  await page.evaluate(async (s) => {
    const A = app;
    A.switchAppTab && A.switchAppTab('diag');
    try { await A.analyze(s); } catch (_) {}
    await new Promise(r => setTimeout(r, 1500));
  }, sym);
  return page.evaluate(async (s) => {
    const A = app;
    A.currentSymbolId = s;
    A.rawDailyData = JSON.parse(JSON.stringify(window.__K[s])); A.activeData = A.rawDailyData; A.baseRawData = A.rawDailyData;
    A.switchSubTab('report');
    await A.renderReportTab(s);
    await new Promise(r => setTimeout(r, 300));
    const g = id => { const el = document.getElementById(id); return el ? el.innerHTML : null; };
    const txt = id => { const el = document.getElementById(id); return el ? el.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : ''; };
    return {
        disp: ['Strategy', 'Live', 'DayTrade', 'Chart', 'Chip', 'Corp', 'Backtest', 'BullBear', 'Report'].map(t => [t, document.getElementById(`subContent${t}`)?.style.display]),
        btnCount: document.querySelectorAll('.sub-tab-btn').length,
        html: ['rpNum', 'rpLead', 'rpVal', 'rpFund', 'rpInd', 'rpChip', 'rpRisk', 'rpAct', 'rpSrc', 'rpQuick', 'rpWalls'].map(g),
        txt: Object.fromEntries(['rpNum', 'rpLead', 'rpVal', 'rpFund', 'rpInd', 'rpChip', 'rpRisk', 'rpAct', 'rpSrc', 'rpQuick', 'rpWalls'].map(id => [id, txt(id)])),
        ctx: (() => { const C = A._rpLast; return C ? { sym: C.sym, eps: C.eps, aeSrc: C.ae && C.ae.src, kind: C.ae && C.ae.kind, pe: C.pe, pC: C.pC, peer: C.peer, indK: C.indK, band: C.band, valRows: C.valRows, marginDate: C.s20 && C.s20.marginDate, badge: C.dec && C.dec.badge } : null; })(),
        s20: A._chipPeriodSums(A.rawDailyData, 20),
        wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    };
  }, sym);
};

const R = await render('5483');
ok('① 9 顆 sub-tab 按鈕、切到 report 後只有 subContentReport 是 flex', R.btnCount === 9 && R.disp.every(([t, d]) => (t === 'Report') === (d === 'flex')), JSON.stringify(R.disp));
// ⚠️ V75.3.2 起 `rpLead`(index 1)在**有結論時刻意留空** —— 結論卡已經把同一句話講完了,
//   並存兩個聲音正是使用者最討厭的「邏輯打架 / 資訊爆炸」。它是 hidden 不是空殼。
ok('⓪ 其餘十段全部有內容(⛔ 不留空殼)', R.html.filter((_, i) => i !== 1).every(h => h && h.length > 40), R.html.map(h => (h || '').length).join(','));
ok('⓪b ⭐ 有結論時 lead 那條整條不顯示(⛔ 不可跟結論卡講同一句話兩次)',
   !R.html[1] && !!R.ctx && !!R.ctx.badge, `lead=${(R.html[1] || '').length} badge=${R.ctx && R.ctx.badge}`);
const ALL = Object.values(R.txt).join(' ');
const ALLnoDisc = ALL.replace(/⛔ ?這不是目標價,也不是預測/g, '').replace(/⛔ ?不是目標價/g, '');
ok('③c 整頁不出現「目標價」(免責句除外)', !/目標價/.test(ALLnoDisc), (ALLnoDisc.match(/.{20}目標價.{20}/) || [])[0]);
ok('③d 結論段的徽章 = _ovDecide.badge(轉述,不是自己判的)', R.ctx && R.ctx.badge && R.txt.rpAct.includes(R.ctx.badge.replace(/<[^>]+>/g, '')), `${R.ctx && R.ctx.badge} | ${R.txt.rpAct.slice(0, 80)}`);
ok('④a 5483(上櫃)同業列要寫「上櫃無官方產業分類」', R.ctx && !R.ctx.indK && /上櫃無官方產業分類/.test(R.txt.rpVal), R.txt.rpVal.slice(0, 200));
// ⑤ 估值表數字 = 手算
{
    const C = R.ctx, b = C.band;
    const raw = [b.p5, b.p25, b.med, b.p75, b.p95].map(m => C.eps * m);
    const exp = raw.map(v => +v.toFixed(1));
    const got = [...R.txt.rpVal.matchAll(/(?:P\d+ PE|中位\(PE) [\d.]+x\)\s+([\d,]+\.\d) 元/g)].map(m => +m[1].replace(/,/g, ''));
    ok('⑤a 五個對照價 = 年化 EPS × 分位(手算)', got.length === 5 && exp.every((v, i) => Math.abs(v - got[i]) < 0.06), `exp ${exp} got ${got}`);
    const diff0 = (raw[0] - C.pC) / C.pC * 100, lot0 = (raw[0] - C.pC) * 1000;
    ok('⑤b 距現價% 與 一張差多少元 手算一致', new RegExp(`${diff0 >= 0 ? '\\+' : ''}${diff0.toFixed(1)}% / ${lot0 >= 0 ? '\\+' : ''}${Math.round(lot0).toLocaleString()} 元`).test(R.txt.rpVal), `${diff0.toFixed(1)}% / ${Math.round(lot0)}`);
    ok('⑤c 列序:P5 → P25 → 中位 → P75 → P95', /近3年最便宜[\s\S]*偏便宜[\s\S]*中位[\s\S]*偏貴[\s\S]*近3年最貴/.test(R.txt.rpVal));
    ok('⑤d 免責句原文(跟 pro.html 一字不差)', R.txt.rpVal.includes('這不是目標價,也不是預測') && R.txt.rpVal.includes('同樣的獲利、乘上它自己過去被給過的本益比'));
    ok('⑥ 年化 EPS 來源標籤在表頭且與資料一致', C.kind === 'qeps' && /已公布四季合計/.test(R.txt.rpVal) && R.txt.rpVal.includes(C.eps.toFixed(2)), `${C.kind} ${C.aeSrc}`);
}
// ⑦ 融資停產:顯「停在 MM/DD」而不是 0
ok('⑦a _chipPeriodSums 回 marginDate(最後一筆有效餘額的日期)', R.s20 && R.s20.marginDate === (lastMg && lastMg.date), JSON.stringify([R.s20 && R.s20.marginDate, lastMg && lastMg.date]));
if (lastMg && lastMg.date !== lastK.date) ok('⑦b 融資餘額落後 K 線時,籌碼段要寫「本站停在 …(採礦缺口)」', /融資餘額本站停在/.test(R.txt.rpChip), R.txt.rpChip.slice(-300));
else console.log('⏭️ ⑦b 這份測資的融資餘額跟 K 線同一天,情境不存在(⛔ 不算過,只是沒東西可驗)');
ok('⑧ 數字卡每一格都有日期徽章或誠實文字(⛔ 不可有空的第三行)', (R.html[0].match(/K線 |官方 |採礦 |季末 |本站|年增/g) || []).length >= 8, R.txt.rpNum.slice(0, 300));
ok('⑨ 整頁不出現 `--`(缺資料要寫本站沒有/尚未)', !/(^|[^-])--([^-]|$)/.test(ALL), (ALL.match(/.{20}--.{20}/) || [])[0]);
ok('⑩a 風險段只用 ✅⚠️⛔🚨,⛔ 不用 🔴🟢', !/[🔴🟢]/u.test(R.txt.rpRisk) && /[✅⚠️]/u.test(R.txt.rpRisk));
ok('⑩b 估值表的距現價用文字色(紅漲綠跌)、免責用琥珀,⛔ 不用紅綠 emoji', !/[🔴🟢]/u.test(R.txt.rpVal));
ok('⑭ 估值表每一列 % 都配「元」', (R.txt.rpVal.match(/% \/ [+-][\d,]+ 元/g) || []).length >= 5);
ok('⑮a 反查器 UI 存在', /rpRevIn/.test(R.html[2]) && /rpRevOut/.test(R.html[2]));
{
    const rev = await page.evaluate(() => {
        const A = app; const C = A._rpLast;
        // ⚠️ V75.3.2 起估值節預設收合 —— `<details>` 沒展開時 innerText 回空字串(同 V75.0.3 的坑)
        const d = document.querySelector('#rpVal details'); if (d) d.open = true;
        document.getElementById('rpRevIn').value = '250'; A._rpReverse('5483');
        const t = document.getElementById('rpRevOut').innerText;
        return { t, mult: 250 / C.eps, p95: C.band.p95, hi: C.band.hi };
    });
    const m = rev.mult.toFixed(1);
    ok('⑮b 反查 250 → 倍數 = 250 ÷ 年化 EPS', rev.t.includes(`${m} 倍`), rev.t);
    ok('⑮c 倍數超過 P95 要寫「超過它近 3 年 95% 的水位」或「最高本益比」', rev.mult <= rev.p95 || /超過它近 3 年/.test(rev.t), rev.t);
    ok('⑮d 反查文案不可出現「合理/便宜/可以買」(算術不是預測)', !/合理|便宜|可以買|值得/.test(rev.t), rev.t);
    const rev2 = await page.evaluate(() => { const C = app._rpLast; const d = document.querySelector('#rpVal details'); if (d) d.open = true; document.getElementById('rpRevIn').value = String((C.eps * C.band.med).toFixed(1)); app._rpReverse('5483'); return document.getElementById('rpRevOut').innerText; });
    ok('⑮e 反查「中位對照價」→ 位階應在第 50 百分位附近(插值方向沒反)', /第 (4[5-9]|5[0-5]) 百分位/.test(rev2), rev2);
}
// ══════════════════════════════════════════════════════════════════════════
// 📄 V75.3.2 改版:決策摘要版面(使用者:「版面不好看、文字敘述沒有很清楚明瞭」)
// ──────────────────────────────────────────────────────────────────────────
{
    const ord = await page.evaluate(() => [...document.getElementById('subContentReport').children]
        .map(d => d.id).filter(Boolean));
    const at = id => ord.indexOf(id);
    ok('📄a 結論(rpAct)必須排在五個背景節之前(⛔ 別再搬回第 8 個)',
       at('rpAct') >= 0 && at('rpAct') < Math.min(at('rpVal'), at('rpFund'), at('rpChip'), at('rpInd')), ord.join(','));
    ok('📄a2 重點數字(rpNum)排在結論之後、背景節之前',
       at('rpAct') < at('rpNum') && at('rpNum') < at('rpVal'), ord.join(','));

    // ⭐⭐ 決定性對照組:同一檔、同一份測資,**只改「有沒有事」**這一個維度
    const openOf = await page.evaluate(async () => {
        const A = app, sym = A.currentSymbolId;
        const real = A._ovDecide;
        const shot = () => { const d = document.querySelector('#rpRisk details'); return d ? d.open : null; };
        A._ovDecide = (...a) => { const r = real.apply(A, a); return Object.assign({}, r, { alerts: [{ ic: '⚠️', t: '測試用預警' }] }); };
        await A.renderReportTab(sym); const hot = shot();
        A._ovDecide = (...a) => { const r = real.apply(A, a); return Object.assign({}, r, { alerts: [] }); };
        await A.renderReportTab(sym); const cold = shot();
        A._ovDecide = real; await A.renderReportTab(sym);
        return { hot, cold };
    });
    ok('📄b ⭐⭐ 有預警 → 風險節自動展開(⛔ 沒有這個,收起來就等於沒講)', openOf.hot === true, JSON.stringify(openOf));
    ok('📄b2 ⭐⭐ 沒預警 → 風險節不展開(只換「有沒有事」這一個維度)', openOf.cold === false, JSON.stringify(openOf));

    const R2 = await render('5483');
    const heroN = await page.evaluate(() => document.querySelectorAll('#rpNum > .grid.grid-cols-2 > div').length);
    ok('📄c 第一眼只有 4 格重點數字(其餘收進「其他數字」摺疊)', heroN === 4, `heroN=${heroN}`);
    const keys = await page.evaluate(() => [...document.querySelectorAll('#rpNum [data-rpk]')].map(d => d.getAttribute('data-rpk')));
    ok('📄c2 其餘數字仍在頁面上(⛔ 是收起來不是刪掉)', /其他數字/.test(R2.txt.rpNum) && (R2.txt.rpNum.match(/本益比|股價淨值比|殖利率|最新季 EPS/g) || []).length >= 2, R2.txt.rpNum.slice(0, 200));
    // 🚨🚨 這一組原本寫成「5483 沒有 PE」→ **假綠燈**:測試 fixture 裡 5483 其實有 PE,
    //   於是注入「寫死四格」之後它照樣綠(注入驗證當場抓到)。
    //   ⭐ 改成**直接餵兩份只差一個維度的 ctx 給純函式**,⛔ 不依賴哪一檔剛好缺什麼
    //     (那是測資的性質,不是程式的性質 —— 陷阱 #40)。
    {
        const sw = await page.evaluate(() => {
            const A = app, C = A._rpLast;
            const keysOf = html => { const d = document.createElement('div'); d.innerHTML = html;
                return { k: [...d.querySelectorAll('[data-rpk]')].map(x => x.getAttribute('data-rpk')),
                         t: [...d.querySelectorAll('[data-rpk]')].map(x => x.textContent).join(' ') }; };
            const has = keysOf(A._rpNumHtml(Object.assign({}, C, { pe: 12.3, mrev: 1.23e9, yoy: 5 })));
            const none = keysOf(A._rpNumHtml(Object.assign({}, C, { pe: null, mrev: null, band: null })));
            return { has, none };
        });
        ok('📄c3 有本益比 / 月營收時,那兩格要進重點區', sw.has.k.includes('本益比') && sw.has.k.includes('最新月營收'), JSON.stringify(sw.has.k));
        ok('📄c4 ⭐⭐ 同一份資料只把 PE / 月營收拿掉 → 重點格自動換成有值的(⛔ 不是寫死那四格)',
           !sw.none.k.includes('本益比') && !sw.none.k.includes('最新月營收') && sw.none.k.length === 4, JSON.stringify(sw.none.k));
        ok('📄c5 ⭐ 換掉之後重點區⛔ 不可出現「沒有」(一片灰色的「沒有」正是版面難看的主因)',
           !/沒有/.test(sw.none.t), sw.none.t.slice(0, 200));
    }
    // 五節標題那句 = 事實 + 數字,⛔ 不下判定詞
    const sums = await page.evaluate(() => [...document.querySelectorAll('#subContentReport details > summary')]
        .map(d => d.textContent.replace(/\s+/g, ' ').trim()));
    ok('📄d 每一節標題都帶一句「這一節的答案」(⛔ 不是只有名詞)',
       sums.length >= 5 && sums.filter(t => t.replace(/展開 ▾/, '').trim().length > 12).length >= 5, JSON.stringify(sums).slice(0, 400));
    ok('📄e 標題那句⛔ 不可出現判定詞(合理/便宜/貴/可以買/該賣)',
       !/合理|便宜|可以買|該買|該賣|值得買/.test(sums.join(' ')), JSON.stringify(sums).slice(0, 300));

    // 📋 一鍵複製
    const cp = await page.evaluate(() => app._rpCopyPlain());
    ok('📄f 複製文字有內容且含股名/代號/資料日期/結論', cp.length > 80 && /5483/.test(cp) && /資料日期/.test(cp) && /🎯 結論/.test(cp), cp.slice(0, 160));
    ok('📄f2 ⛔ 複製文字不可含 HTML 標籤,也不可含「展開 ▾」這種 UI 字',
       !/<[a-zA-Z\/!]/.test(cp) && !/展開\s*▾/.test(cp), (cp.match(/<[a-zA-Z\/!][^>]*>/) || [])[0] || (cp.match(/展開\s*▾/) || [])[0] || '');
    ok('📄f3 複製文字要帶免責(⛔ 數字被帶出去,限制也要跟著出去)', /不是投資建議/.test(cp) && /不含任何 AI 推估/.test(cp));
    ok('📄g 複製按鈕在第一屏(⛔ 不埋進最後的摺疊區 —— 陷阱 #32)', /_rpCopyReport\(\)/.test(R2.html[0]));
}

// ⓪c ⭐⭐ 決定性對照組:同一檔、只把「算不算得出結論」這一個維度拿掉 → lead 要出來講「還在算」
{
    const noDec = await page.evaluate(async () => {
        const A = app, sym = A.currentSymbolId, real = A._ovDecide;
        A._ovDecide = () => null;
        await A.renderReportTab(sym);
        const h = document.getElementById('rpLead').innerHTML;
        A._ovDecide = real; await A.renderReportTab(sym);
        return h;
    });
    ok('⓪c ⭐⭐ 算不出結論時 lead 要說「正在計算」(⛔ 不可整片空白 —— 陷阱 #4)', /正在計算/.test(noDec), noDec.slice(0, 120));
}

// ⑫ prompt
{
    const P = await page.evaluate(() => { let cap = null; const real = app._freeAiOpen; app._freeAiOpen = q => { cap = q; }; app._reportAsk('5483'); app._freeAiOpen = real; return cap; });
    ok('⑫a 提示詞含 5 條防幻覺關鍵句 + 第 6 條', ['絕對禁止「主觀預測」', '年化EPS × 近3年 P5/中位/P95 PE', '不可腦補', '股價基期」與「估值基期」是兩件事', '循環股獲利頂峰時 PE 最低', '附日期與來源網址'].every(k => P.includes(k)));
    ok('⑫b 提示詞八段標題(V76.1.8 從四段擴成八段:商業模式 / 法人預估變化 / 客戶集中與曝險 / 空方論點)', ['🏢 【商業模式】', '🏭 【產業景氣】', '💲 【漲價與供需】', '📞 【最近法說重點】', '📈 【法人預估變化】', '👥 【客戶集中與曝險】', '🐻 【空方論點】', '⚠️ 【最大風險】'].every(k => P.includes(k)));
    ok('⑫d 提示詞 <3,800 字且帶入年化 EPS / 對照價 / 位階', P.length < 3800 && P.includes(R.ctx.eps.toFixed(2)) && /估值基期.*\d+%/.test(P), `len ${P.length}`);
    ok('⑫e 提示詞「目標價」只出現在禁令句', P.split('目標價').length - 1 === 1 && P.includes('「具體目標價」'));
}
// 2330(上市):同業列要有數字
const R2 = await render('2330');
ok('④b 2330(上市)同業列有中位 PE 數字', R2.ctx && Number.isFinite(R2.ctx.peer) && /同業中位 PE [\d.]+x/.test(R2.txt.rpVal), `${R2.ctx && R2.ctx.peer} ${R2.txt.rpVal.slice(0, 120)}`);
ok('④c 2330 五段有內容、無 --', R2.html.filter((_, i) => i !== 1).every(h => h && h.length > 40) && !/(^|[^-])--([^-]|$)/.test(Object.values(R2.txt).join(' ')));
// ⑪ 切股殘留
{
    const r = await page.evaluate(async () => {
        const A = app;
        // ⚠️ V76.0.2 起 analyze() 停在報告分頁會**自己**重畫報告(那正是修掉的黑畫面 bug)→
        //   這個實驗驗的是 renderReportTab **自己的** await 守門,所以先離開報告分頁,免得合法的重畫被誤讀成「守門漏了」。
        //   (analyze 自己會不會重畫報告 → 另有 🔁s1 驗)
        A._activeSubTab = 'strategy';
        A.currentSymbolId = '5483'; A.rawDailyData = JSON.parse(JSON.stringify(window.__K['5483'])); A.activeData = A.rawDailyData;
        await A.renderReportTab('5483');
        const before = document.getElementById('rpVal').innerHTML.length;
        // 切股:analyze('2330') 一開始就該把 rp* 清掉(不等資料回來)
        const p = A.analyze('2330');
        await new Promise(r => setTimeout(r, 50));
        const mid = ['rpNum', 'rpLead', 'rpVal', 'rpFund', 'rpInd', 'rpChip', 'rpRisk', 'rpAct', 'rpSrc', 'rpQuick', 'rpWalls'].map(id => document.getElementById(id).innerHTML.length);
        await p.catch(() => {});
        // await 回來時 sym 已不同 → ⛔ 不可寫入
        // ⚠️ 用「載入中途切股」重現:第一個 await 回來時 currentSymbolId 已經變了
        //   (⛔ 不是在呼叫前就換 —— 那樣第一行就 return,驗不到 await 之後那幾道守門)
        A.currentSymbolId = '5483';
        const realLoad = A._loadFundCache;
        A._loadFundCache = async function () { A.currentSymbolId = '2330'; return realLoad.call(this); };
        await A.renderReportTab('5483');
        A._loadFundCache = realLoad;
        const after = ['rpNum', 'rpVal', 'rpFund', 'rpChip', 'rpRisk', 'rpSrc', 'rpQuick', 'rpWalls'].reduce((n, id) => n + document.getElementById(id).innerHTML.length, 0);
        A._activeSubTab = 'report';
        return { before, mid, after, rpSym: A._rpSym };
    });
    ok('⑪b analyze(別檔) 一開始就清空十一段(⛔ 不等資料回來)', r.before > 40 && r.mid.every(n => n === 0), JSON.stringify(r));
    ok('⑪c 載入中途切股(await 回來 sym 不符)→ 八個 async 段一個字都不寫', r.after === 0, JSON.stringify(r));
}
// ② 指數藏這頁
{
    const r = await page.evaluate(async () => {
        const A = app; A.currentSymbolId = '^TWII';
        A._syncIndexSubTabs(); A.switchSubTab('report');
        return { hidden: document.getElementById('subTabBtnReport').classList.contains('hidden'), active: A._activeSubTab };
    });
    ok('② 指數(^TWII)藏「報告」按鈕、點 report 導回 strategy', r.hidden && r.active === 'strategy', JSON.stringify(r));
}
ok('⑬b 報告頁渲染期間對 FinMind 的請求數 = 0(analyze 那段不算)', hitsAfterRender === 0, `hits ${hitsAfterRender}`);
ok('📱 390px 頁面不可橫向溢出', !R.wide);
ok('⑯ 無 pageerror(環境限制已濾)', errs.length === 0, errs.join(' | '));

// ⑤e 跟 pro.html `_pxTableHtml` 餵同一 fixture,數字序列要完全一致
{
    const p2 = await browser.newPage();
    await p2.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._pxTableHtml, null, { timeout: 30000 });
    const fx = { px: R.ctx.pC, pe: R.ctx.pe, eps: R.ctx.eps, b: R.ctx.band, peer: 27.3 };
    const proNums = await p2.evaluate((f) => {
        const r = { px: f.px, pe: f.pe, eps: f.eps, b: f.b, peer: f.peer, lo: f.eps * f.b.p5, q25: f.eps * f.b.p25, mid: f.eps * f.b.med, q75: f.eps * f.b.p75, hi: f.eps * f.b.p95, peerPx: f.eps * f.peer };
        const h = PRO._pxTableHtml(r).replace(/<[^>]+>/g, ' ');
        return (h.match(/[+-]?\d[\d,]*\.?\d*/g) || []).map(x => x.replace(/,/g, ''));
    }, fx);
    const mineNums = await page.evaluate((f) => {
        const h = app._rpPxTableHtml(app._rpValRows(f.eps, f.b, f.peer), f.px, f.pe).replace(/<[^>]+>/g, ' ');
        return (h.match(/[+-]?\d[\d,]*\.?\d*/g) || []).map(x => x.replace(/,/g, ''));
    }, fx);
    // pro 的表頭沒有數字;我的多了「距現價 / 一張差多少元」說明列(也沒有數字)→ 兩邊的數字序列應該完全相同
    ok('⑤e index.html 估值表 與 pro.html _pxTableHtml 餵同一 fixture,數字序列完全一致(⛔ 公式漂移就會叫)', JSON.stringify(proNums) === JSON.stringify(mineNums), `pro ${proNums.join(' ')}\n mine ${mineNums.join(' ')}`);
    await p2.close();
}

// ══════════════════════════════════════════════════════════════════════════
// 🏭 V76.0.0 產業報告(使用者:「我要的是**產業報告**,你現在做的感覺是總結」)
//   ⛔ 每一條都想過「注入什麼它會叫」,並實際注入驗證過。
// ──────────────────────────────────────────────────────────────────────────
{
    // 🏭b(靜態)🚨 唯一真相:族群名次只准走 `_regimeStats()` / `_stockRegime()`
    const a = SRC.indexOf('    _rpPeerGroup(sym) {'), b = SRC.indexOf('    // F 籌碼(全部轉述 _chipPeriodSums');
    const blk = strip(SRC.slice(a, b));
    ok('🏭b1 ⭐ 族群強弱那段**整段轉述** _stockRegimeHtml(⛔ 不可自己判)', /_stockRegimeHtml\(/.test(blk));
    ok('🏭b2 ⭐⭐ 產業名次只從 _regimeStats() 換算,⛔ 不可拿 sector_rot 自己排一次',
       /_rpIndRank\(ind\) \{[\s\S]{0,300}_regimeStats\(\)/.test(blk)
       && !/(R|rot)\.ind\)[\s\S]{0,200}\.sort\(/.test(blk)
       && !/Object\.(keys|entries|values)\((R|rot|this\._secRotCache)\.ind\)/.test(blk),
       (blk.match(/Object\.(keys|entries|values)\((R|rot|this\._secRotCache)\.ind\)/) || [])[0]);
    ok('🏭b3 sector_rot 只拿來做走勢與資金流(檔內註解就寫著實測排不出順序)', /不可拿它排名次/.test(SRC.slice(a - 3000, a)));
    ok('🏭c1 ⛔ 細項分類不可標成「上游 / 下游」(那份是分類標籤不是上下游)',
       !/上游|下游/.test(blk.replace(/不是上下游關係/g, '')) || /不是上下游關係/.test(blk));
    ok('🏭d1 🚨 筆記只寫 localStorage,⛔ 不進 _ovDecide / 任何計分',
       /_rpNoteSave\(sym\)[\s\S]{0,900}localStorage\.setItem/.test(blk) && !/_ovDecide|_calcRiskScore|score \+=/.test(blk));
    ok('🏭e1 medianPe 用 map[sym] 取到的**代碼**去查(⛔ 不是中文產業名)',
       /const code = peData\?\.map\?\.\[sym\]; medianPe = \(code && peData\?\.industries\?\.\[code\]\?\.median_pe\)/.test(SRC));
}
{
    const R3 = await render('5483');
    const T = R3.txt.rpInd;
    // 🏭a ⭐ 真實資料實跑:同業列得出來,而且**你自己那檔一定在表內**
    const peers = await page.evaluate(() => {
        const A = app, sym = A.currentSymbolId;
        const g = A._rpPeerGroup(sym);
        const box = document.getElementById('rpInd');
        const codes = [...box.querySelectorAll('button[onclick^="app.openStockFromRadar"]')]
            .map(b => (b.getAttribute('onclick').match(/'(\d[\dA-Z]*)'/) || [])[1]);
        return { g: g && { kind: g.kind, key: g.key, name: g.name, n: g.mem.length }, codes, sym };
    });
    ok('🏭a ⭐ 5483(上櫃,沒有官方產業別)也列得出同業 —— 走題材名單', !!peers.g && peers.g.kind === 'theme' && peers.g.n >= 4, JSON.stringify(peers.g));
    ok('🏭a1 ⭐ 同業表裡**一定有你自己那一檔**(⛔ 不可只列別人)', peers.codes.includes('5483'), peers.codes.join(','));
    // 🚨🚨 上面那條**驗不到「補進來」那條路** —— 5483 的題材只有 4 檔,它本來就在前 10
    //   (第一輪注入驗證當場抓到:把那行刪掉測試照樣綠)。⭐ 改成餵一檔**成交值排 10 名之外**的股。
    {
        const out = await page.evaluate(() => {
            const A = app, real = A._tagsCache;
            A._tagsCache = { by_stock: {}, names: {} };          // 關掉題材 → 走官方產業(104 檔)
            const sym = '3376';                                   // 電子零組件,成交值排第 11
            const g = A._rpPeerGroup(sym);
            const h = A._rpPeerHtml({ sym, isEtf: false }, g);
            A._tagsCache = real;
            const d = document.createElement('div'); d.innerHTML = h;
            const codes = [...d.querySelectorAll('button[onclick^="app.openStockFromRadar"]')]
                .map(b => (b.getAttribute('onclick').match(/'(\d[\dA-Z]*)'/) || [])[1]);
            return { codes, n: g && g.mem.length, kind: g && g.kind, txt: d.textContent.replace(/\s+/g, ' ') };
        });
        ok('🏭a1b ⭐⭐ 成交值排在 10 名之外的股,也要被補進表裡(⛔ 刪掉那行 → 這條才叫得出來)',
           out.kind === 'ind' && out.n > 10 && out.codes.indexOf('3376') === out.codes.length - 1, JSON.stringify(out.codes));
        ok('🏭a1c 補進來時標題要說明(⛔ 不可讓使用者以為它排前 10)', /前 10 名 \+ 你這檔/.test(out.txt), out.txt.slice(0, 160));
    }
    ok('🏭a2 ⭐ 五個欄位都講得出「第 N / 共 M」或誠實寫「本站沒有」(⛔ 不可留白也不可補 0)',
       ['成交值', '近20日', '本益比', '營收年增', '毛利率'].every(k => new RegExp(`${k} (第 \\d+ ?/ ?\\d+|本站沒有)`).test(T.replace(/\s+/g, ' '))), T.slice(0, 400));
    // 🏭a3 ⭐⭐ 決定性對照組:同一支純函式,只把「有沒有題材」這一個維度換掉
    const sw = await page.evaluate(() => {
        const A = app, real = A._tagsCache;
        const g1 = A._rpPeerGroup('2330');
        A._tagsCache = { by_stock: {}, names: {} };
        const g2 = A._rpPeerGroup('2330');
        const g3 = A._rpPeerGroup('5483');           // 上櫃 + 沒題材 → 什麼都沒有
        A._tagsCache = real;
        return { g1: g1 && { k: g1.kind, n: g1.mem.length }, g2: g2 && { k: g2.kind, n: g2.mem.length }, g3 };
    });
    ok('🏭a3 ⭐⭐ 有題材 → 用題材分群;把題材拿掉 → 退回官方產業(⛔ 不是寫死一種)',
       sw.g1 && sw.g1.k === 'theme' && sw.g2 && sw.g2.k === 'ind' && sw.g2.n > sw.g1.n, JSON.stringify(sw));
    ok('🏭a4 ⭐ 兩種都沒有時誠實回 null(⛔ 不硬湊一組同業)', sw.g3 === null, JSON.stringify(sw.g3));
    ok('🏭a5 同業表要標「這是當天快照,沒有歷史」與名次方向(本益比由低到高)',
       /當天快照/.test(T) && /本益比是.*由低到高/.test(T.replace(/\s+/g, ' ')), T.slice(0, 300));
    // 🏭d 筆記鐵線
    const note = await page.evaluate(async () => {
        const A = app, sym = A.currentSymbolId;
        const MARK = 'ZZ產業筆記測試字串ZZ';
        document.getElementById('rpNoteIn').value = MARK;
        A._rpNoteSave(sym);
        //   ⚠️ ⛔ 這裡不可用 `innerText` —— 整個產業節裝在**收合的 `<details>`** 裡,
        //     收合時 innerText 回空字串(V75.0.3 踩過)→ 會變成假失敗
        //   🚨🚨 而且範圍要縮到**已存筆記那一塊**(`[data-rpnote]`):第一輪注入驗證抓到
        //     「外部 AI 寫的 ・本站沒有驗證」在**節標題**也有一份 → 把筆記上的標籤整條拿掉,
        //     測試照樣綠 = 假綠燈(V75.1.0 那條教訓的再犯)。
        const box = document.querySelector('#rpInd [data-rpnote]');
        const t = box ? box.innerHTML.replace(/<[^>]+>/g, ' ') : '';
        const cp = A._rpCopyPlain();
        const dec = JSON.stringify(A._ovDecide(A.activeData, sym) || {});
        A._rpNoteClear(sym);
        const after = document.querySelector('#rpInd [data-rpnote]') ? 'still-there' : '';
        return { MARK, shown: t.includes(MARK), label: /外部 AI 寫的/.test(t) && /本站沒有驗證/.test(t), inCopy: cp.includes(MARK), inDec: dec.includes(MARK), gone: !after.includes(MARK) };
    });
    ok('🏭d2 貼進去的筆記存得起來、顯示得出來', note.shown, JSON.stringify(note));
    ok('🏭d3 🚨 顯示時**一定**帶「外部 AI 寫的 ・本站沒有驗證」(注入:拿掉那行 → 這條會紅)', note.label, JSON.stringify(note));
    ok('🏭d4 🚨 筆記⛔ 不可進「📋 複製整份報告」', !note.inCopy, JSON.stringify(note));
    ok('🏭d5 🚨 筆記⛔ 不可進 _ovDecide(不參與任何買賣判斷)', !note.inDec, JSON.stringify(note));
    ok('🏭d6 一鍵清除真的清得掉', note.gone, JSON.stringify(note));
}
{
    const R4 = await render('2330');
    const T = R4.txt.rpInd;
    // 🏭b ⭐⭐ 實跑比對:報告頁講的族群結論,要跟 K 棒戰法卡**一字不差**
    const same = await page.evaluate(() => {
        const A = app, sym = A.currentSymbolId;
        const card = A._stockRegimeHtml(sym).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const rep = document.getElementById('rpInd').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const S = A._regimeStats();
        const ind = A._scrData.ind[sym];
        const rk = A._rpIndRank(ind);
        // 用 rank 這份唯一真相自己算一次(⛔ 測試不複製第二套判定,只驗換算)
        const j = Math.round(S.rank.get(ind) * (S.rank.size - 1));
        return { card, hasCard: card.length > 20 && rep.includes(card), rk, expect: S.rank.size - j, m: S.rank.size };
    });
    ok('🏭b4 ⭐⭐ 報告頁的族群結論 = K 棒戰法卡那一段(注入:讓報告自己算 → 必紅)', same.hasCard, same.card.slice(0, 160));
    ok('🏭b5 ⭐ 「排第幾」跟 _regimeStats().rank 換算一致',
       same.rk && same.rk.n === same.expect && same.rk.m === same.m, JSON.stringify(same.rk) + ' expect ' + same.expect);
    ok('🏭b6 節標題那句要直接講「排第幾」(⛔ 不是只有產業名詞)',
       new RegExp(`排第 ${same.expect}`).test(T.replace(/\s+/g, ' ')), T.slice(0, 200));
    ok('🏭b7 資金流要標明是描述用、⛔ 不可拿來排名次或當訊號', /描述用/.test(T) && /不可拿來排名次/.test(T.replace(/\s+/g, ' ')), T.slice(-400));
    // 🏭c 關聯星圖
    const st = await page.evaluate(() => {
        const A = app, sym = A.currentSymbolId;
        const fam = (A._corrCache.r || {})[sym] || [];
        const E = A._corrCache.status_enum;
        const h = document.getElementById('rpInd').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        // 這一檔實際被畫出來的每一筆,狀態文字都要是檔內 enum 的**原文**
        return { need: fam.slice(0, 5).map(x => `${x[0]}`), want: fam.slice(0, 5).map(x => E[x[2]]),
                 hit: fam.slice(0, 5).every(x => h.includes(E[x[2]])), n: fam.length, enums: E };
    });
    ok('🏭c2 狀態文字要跟 top_correlations 檔內的 status_enum 一致(⛔ 不可自己另寫一份)',
       st.n === 0 ? /本站沒有這檔的連動名單/.test(T) : st.hit,
       JSON.stringify(st.want) + ' | ' + JSON.stringify(st.enums));
    // ⚠️ 這一檔剛好只出現一種狀態時,上面那條只驗到一種 → 再直接比對照表本身(⛔ 不可自己另寫一份文字)
    ok('🏭c2b ⭐ 三種狀態的文字直接讀檔內 status_enum,⛔ 程式裡不可寫死中文對照',
       /const ST = \(K && K\.status_enum\)/.test(SRC), '');
    ok('🏭c3 關聯段要原文顯示檔內 caveat「⛔ 不是預測」', T.includes('不是預測'), T.slice(0, 300));
    ok('🏭c4 ⭐ 關聯段要講出用途(我是不是重壓在同一族)', /重壓在同一族/.test(T.replace(/\s+/g, ' ')), T.slice(0, 300));
    ok('🏭f 實測成績段要帶數字與來源探針(⛔ 沒有數字的意見不准進來)',
       /\+0\.90%/.test(T) && /sector_pick_probe/.test(T) && /空頭還沒驗證過/.test(T), T.slice(-400));
    ok('🏭g 產業節不可出現操作指令(⛔ 這一節只描述,不下單)',
       !/(可以進場|可進場|建議買進|建議賣出|可加碼|放心做多)/.test(T), (T.match(/(可以進場|可進場|建議買進|建議賣出|可加碼|放心做多)/) || [])[0]);
    ok('🏭h 產業節不可出現 `--` 或空白格', !/(^|[^-])--([^-]|$)/.test(T));
    ok('📱2 加了產業報告之後 390px 仍不可橫向溢出', !R4.wide);

    // ── 🎯 V76.0.1 「報告頁跟總覽看起來很雷同」的修法 ──────────────────────────────
    // 實測(headless 逐行比對 2330):結論卡 481 字裡 **350 字(73%)跟總覽逐字相同**,
    //   而它是報告頁的第一眼 → 重複的全部是 `dec.plan` 那一串價位明細。
    // ⛔ 但**不可以刪掉**(那是真的防守價)→ 收進摺疊 + 補進「📋 複製整份報告」。
    // 🚨 斷言範圍一律縮到 `#rpAct` 內 —— 同樣的價位字串在總覽也有,
    //    掃全頁會被別處救活變成假綠燈(🏭d3 就是這樣假綠過一次)。
    const act = await page.evaluate(() => {
        const A = app, el = document.getElementById('rpAct');
        const dec = A._rpLast && A._rpLast.dec;
        const pl = (dec && Array.isArray(dec.plan)) ? dec.plan : [];
        const clean = t => String(t || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const d = el.querySelector('details');
        return {
            n: pl.length,
            heads: pl.map(x => clean(x.t)),
            vis: (el.innerText || '').replace(/\s+/g, ' '),          // ⭐ innerText 看不到關起來的 <details>
            inFold: d ? d.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : '',
            badge: clean(dec && dec.badge),
            cp: A._rpCopyPlain(),
        };
    });
    // 🚧 守門:沒有價位計畫時下面三條驗不到東西 → 誠實說出來,⛔ 不可靜默通過
    ok('🎯p0 這檔要有價位計畫,下面三條才驗得到(⛔ 沒有就不是綠燈是驗不到)', act.n >= 1, `plan=${act.n}`);
    ok('🎯p1 ⭐ 結論卡**攤開**的部分不可再逐字重述總覽那串價位(注入:把 plan 搬回攤開區 → 必紅)',
       act.n >= 1 && act.heads.every(h => !act.vis.includes(h)), act.vis.slice(0, 200));
    ok('🎯p2 🚨 但那些價位**仍然在 DOM 裡**(收進摺疊,⛔ 不是刪掉 —— 那是真的防守價)',
       act.n >= 1 && act.heads.every(h => act.inFold.includes(h)), act.inFold.slice(0, 200));
    ok('🎯p3 ⭐ 「📋 複製整份報告」要把價位一起帶出去(以前一行都沒複製到)',
       act.n >= 1 && act.heads.every(h => act.cp.replace(/\s+/g, ' ').includes(h)), act.cp.slice(0, 300));
    ok('🎯p4 結論本身仍要留在攤開區(⛔ 不可連結論都收起來)', !!act.badge && act.vis.includes(act.badge), act.vis.slice(0, 120));
    ok('🎯p5 複製出去的價位段⛔ 不可出現兩次(摺疊標題會被節標題那段再收一次)',
       (act.cp.match(/出場／加碼價位/g) || []).length === 1, String((act.cp.match(/出場／加碼價位/g) || []).length));
}

// ── 🔁 V76.0.2 報告分頁換股黑畫面(使用者截圖:009816 那頁整片黑)──────────────────────
{
    const r = await page.evaluate(async () => {
        const A = app;
        A.switchSubTab('report');
        for (const id of ['rpNum', 'rpLead', 'rpVal', 'rpFund', 'rpInd', 'rpChip', 'rpRisk', 'rpAct', 'rpSrc', 'rpQuick', 'rpWalls']) document.getElementById(id).innerHTML = '';
        await A.analyze('5483').catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
        const act = document.getElementById('rpAct').innerHTML;
        return { sub: A._activeSubTab, rpSym: A._rpSym, actLen: act.length, hasBadge: /結論與操作/.test(act), sym: A.currentSymbolId };
    });
    ok('🔁s1 🚨 停在報告分頁換股 → analyze() 要自己重畫(⛔ 不可整頁黑;注入:拿掉 _sub===report 分支 → 必紅)',
       r.sub === 'report' && r.sym === '5483' && r.rpSym === '5483' && r.actLen > 40 && r.hasBadge, JSON.stringify(r));
    // dec 晚到:renderReportTab 當下算不出結論 → 留旗標,_renderOvCommand 算出來那一刻補畫
    const r2 = await page.evaluate(async () => {
        const A = app;
        A._activeSubTab = 'report';
        A.currentSymbolId = '2330'; A.rawDailyData = JSON.parse(JSON.stringify(window.__K['2330'])); A.activeData = A.rawDailyData;
        const real = A._ovDecide; A._ovDecide = () => null;
        await A.renderReportTab('2330');
        const pending = A._rpNeedsDec, actWait = document.getElementById('rpAct').innerHTML;
        A._ovDecide = real;
        try { A._renderOvCommand(A.activeData); } catch (_) {}
        await new Promise(r => setTimeout(r, 400));
        return { pending, waiting: /正在計算|還在計算/.test(actWait), after: A._rpNeedsDec, act: document.getElementById('rpAct').innerHTML.replace(/<[^>]+>/g, ' ').slice(0, 120) };
    });
    ok('🔁s2 結論晚到時先寫「還在計算」並留旗標', r2.pending === '2330' && r2.waiting, JSON.stringify(r2).slice(0, 200));
    ok('🔁s2b ⭐ _renderOvCommand 算出結論那一刻要補畫報告(⛔ 不可永遠停在「還在計算」;注入:拿掉回呼 → 必紅)',
       r2.after === null && !/正在計算|還在計算/.test(r2.act) && r2.act.trim().length > 20, JSON.stringify(r2).slice(0, 300));
}
// ── 💰 V76.0.2 估值尺(使用者:「一眼知道這隻股票的價位在哪」)────────────────────────
{
    const v = await page.evaluate(async () => {
        const A = app;
        A._activeSubTab = 'report';
        A.currentSymbolId = '2330'; A.rawDailyData = JSON.parse(JSON.stringify(window.__K['2330'])); A.activeData = A.rawDailyData;
        await A.renderReportTab('2330');
        const C = A._rpLast, box = document.getElementById('rpVal');
        const d = box.querySelector('details'), sum = d && d.querySelector('summary');
        const f = x => A._rpFmt(x, 1);
        const pick = re => { const r = (C.valRows || []).find(x => re.test(x[0])); return r ? r[1] : null; };
        const ruler = box.querySelector('[data-rpruler]');
        const marker = ruler && [...ruler.querySelectorAll('div[style*="translateX(-50%)"]')].find(el => /▼/.test(el.textContent));
        const left = marker ? parseFloat((marker.getAttribute('style').match(/left:\s*([\d.]+)%/) || [])[1]) : null;
        const rk = A._rpPeRank(C.pC / C.ae.eps, C.band);
        // 超出上端:直接餵一個離譜的現價給純函式(⛔ 不改真資料)
        const over = A._rpValRuler({ ...C, pC: C.pC * 20 });
        const overLeft = parseFloat((over.match(/left:\s*([\d.]+)%;top:-13px/) || [])[1]);
        // 📏 V76.0.7 尺要在 <details> **外面**(收合也看得到)—— 注入:把尺塞回 body → rulerOutside 變 false → 必紅
        const rulerOutside = !!(ruler && !ruler.closest('details'));
        return { open: !!(d && d.open), rulerOutside, sum: sum ? sum.innerText.replace(/\s+/g, ' ') : '', p25: f(pick(/偏便宜/)), med: f(pick(/中位\(PE/)), p75: f(pick(/^偏貴/)),
                 hasRuler: !!ruler, dataRk: ruler ? +ruler.getAttribute('data-rk') : null, left, rk, overTxt: /已超過近 3 年 95%/.test(over), overLeft,
                 noTarget: !/目標價(?!,也不是預測)|預估價/.test(box.innerText) };
    });
    ok('💰v1 摺疊標題直接寫「估值帶 P25 ~ P75 ・中位」三個價,數字 = 對照表那三列(⛔ 不另算)',
       v.sum.includes(`${v.p25} ~ ${v.p75}`) && v.sum.includes(`中位 ${v.med}`) && /第 \d+ 百分位/.test(v.sum), v.sum.slice(0, 160));
    // 📏 V76.0.7 使用者:「報告頁資料很多」→ 改成「尺在摺疊區外面、6 列表預設收合」(⛔ 不再預設攤開)
    ok('💰v1b 估值尺在 <details> 外面(收合也看得到),6 列表預設收合', v.rulerOutside && !v.open, JSON.stringify({ rulerOutside: v.rulerOutside, open: v.open }));
    ok('💰v2 尺上 ▼ 的位置 = _rpPeRank(現價÷年化EPS)(注入:改成線性用 PE 算 → 必紅)',
       v.hasRuler && v.dataRk === v.rk && v.left != null && Math.abs(v.left - Math.max(2, Math.min(98, v.rk))) < 0.01, JSON.stringify({ rk: v.rk, dataRk: v.dataRk, left: v.left }));
    ok('💰v3 現價超出 P95 → 貼右邊(98%)+ 明講「已超過近 3 年 95%」', v.overTxt && v.overLeft === 98, JSON.stringify({ overLeft: v.overLeft, overTxt: v.overTxt }));
    ok('💰v4 估值節⛔ 不出現「目標價／預估價」(免責句除外)', v.noTarget, '');
}

// ══════════════════════════════════════════════════════════════════════════
// 📋 V76.1.8 「法人級 22 節提示詞」對照:一頁兩層(⚡ 快速判別表 + § 編號骨架 + 四段純公式)
//   ⛔ 每一條先想「注入什麼它會叫」。
// ──────────────────────────────────────────────────────────────────────────
{
    // 靜態:快速表與價格牆**零現算** —— 只准讀 stash
    const qa = SRC.indexOf('    _rpQuickHtml(C) {'), qb = SRC.indexOf('    // 🧮 §14 敏感度');
    const wa = SRC.indexOf('    _rpWallsHtml(C) {'), wb = SRC.indexOf('    // 🗓️ §12 事件');
    const zero = /_detect[A-Z]\w*\(|_calcBullBearScan\(|_entryCheckup\(|_ovDecide\(|_volProfile\(|_overheadSupply\(|_upsideRoom\(|_volStuckBands\(|_chuResistanceZones\(/;
    ok('§z1 ⚡ 快速表零現算:原始碼不可呼叫任何偵測器/分桶/判定函式(只讀 stash;注入:加一行 _ovDecide( → 必紅)', qa > 0 && qb > qa && !zero.test(strip(SRC.slice(qa, qb))), (strip(SRC.slice(qa, qb)).match(zero) || [])[0]);
    ok('§z2 🧱 價格牆零現算(套牢區/密集區只讀 _keyLevels / _upsideStash)', wa > 0 && wb > wa && !zero.test(strip(SRC.slice(wa, wb))), (strip(SRC.slice(wa, wb)).match(zero) || [])[0]);
    ok('§z3 🧱 價格位置圖整段轉述 _priceRulerHtml()(⛔ 不自己畫第二把尺)', /this\._priceRulerHtml\(\)/.test(SRC.slice(wa, wb)) && !/_gaugeRow\(/.test(SRC.slice(wa, wb)));
    ok('§z4 快速表每一列都有來源標籤(五種之一)', /_RP_TAG: \{ real:.*calc:.*ask:.*none:.*dead:/.test(SRC) && /this\._rpTag\(r\.tag\)/.test(SRC.slice(qa, qb)));

    const R5 = await render('2330');
    const Q = await page.evaluate(() => {
        const A = app, box = document.getElementById('rpQuick');
        const rows = [...box.querySelectorAll('[data-rpq]')].map(d => ({ k: d.getAttribute('data-rpq'), t: d.textContent.replace(/\s+/g, ' ').trim() }));
        const tags = rows.map(r => ['✅ 真實資料', '🧮 純公式', '🔎 要自己查', '⛔ 本站沒有', '🚫 實測打掉'].find(t => r.t.includes(t)) || null);
        return { n: rows.length, keys: rows.map(r => r.k), tags, badge: A._rpLast.dec && A._rpLast.dec.badge, first: rows[0] && rows[0].t, txt: box.textContent.replace(/\s+/g, ' ') };
    });
    ok('§q1 ⚡ 快速表 11 個面向、每一列都有來源標籤', Q.n === 11 && Q.tags.every(Boolean), JSON.stringify({ n: Q.n, tags: Q.tags }));
    ok('§q2 第一列 = 結論,徽章 = _ovDecide.badge(轉述)', Q.keys[0] === '§1 結論' && Q.badge && Q.first.includes(Q.badge.replace(/<[^>]+>/g, '')), Q.first);
    ok('§q3 每一列標題帶 § 編號(對照 22 節提示詞)', Q.keys.every(k => /^§\d/.test(k)), JSON.stringify(Q.keys));
    ok('§q4 快速表⛔ 不下操作指令(指令只有結論那一句)', !/(可以進場|可進場|建議買進|建議賣出|可加碼|放心做多|順勢做多)/.test(Q.txt.replace(Q.badge ? Q.badge.replace(/<[^>]+>/g, '') : '', '')), (Q.txt.match(/(可以進場|可進場|建議買進|建議賣出|可加碼|放心做多|順勢做多)/) || [])[0]);
    ok('§q5 六個節標題帶 § 編號(§4~§6 / §10 / §12… / §14・§15 / §2・§3… / §0)', ['§4~§6', '§10', '§12・§13・§18・§21', '§14・§15', '§2・§3・§7~§9', '§0'].every(k => R5.txt.rpFund.includes(k) || R5.txt.rpChip.includes(k) || R5.txt.rpRisk.includes(k) || R5.txt.rpVal.includes(k) || R5.txt.rpInd.includes(k) || R5.txt.rpSrc.includes(k)), '');
    ok('§a1 結論卡寫明⛔ 不給 §19 因子總分 / §20 ★ 評等,而且真的沒有 ★★ 這種評等', /data-rpnostar/.test(R5.html[7]) && !/★{2,}/.test(R5.txt.rpAct), R5.txt.rpAct.slice(-200));
    // 🧱 §11・§17
    const W = await page.evaluate(() => {
        const A = app, C = A._rpLast, box = document.getElementById('rpWalls');
        const d = box.querySelector('details'); if (d) d.open = true;
        const walls = [...box.querySelectorAll('[data-rpwall]')].map(el => ({ n: el.getAttribute('data-rpwall'), v: +(el.querySelector('.font-mono').textContent.replace(/,/g, '')) }));
        const st = Object.fromEntries([...box.querySelectorAll('[data-rpstress]')].map(el => [el.getAttribute('data-rpstress'), el.textContent.replace(/\s+/g, ' ')]));
        // ⚠️ 原始字串 vs innerHTML 會被 DOM 序列化改掉尾巴(onclick 裡的引號變 &quot;)→ 兩邊都先過一次 DOM 再比
        const norm = h => { const t = document.createElement('div'); t.innerHTML = h; return t.innerHTML; };
        const ruler = A._priceRulerHtml();
        return { walls, st, pC: C.pC, one20: Math.round(A._netPL(C.pC, C.pC * 0.8, 1000)), px20: A._rpFmt(C.pC * 0.8, 1), rulerLen: ruler.length, hasRuler: ruler ? box.innerHTML.includes(norm(ruler)) : null, txt: box.textContent.replace(/\s+/g, ' ') };
    });
    ok('§w1 價格牆表由高到低排、含「📍 現價」列', W.walls.length >= 4 && W.walls.some(x => x.n === '📍 現價') && W.walls.every((x, i) => i === 0 || x.v <= W.walls[i - 1].v + 0.001), JSON.stringify(W.walls.slice(0, 6)));
    ok('§w2 每一道牆都配「距現價 % / 一張差多少元」', (W.txt.match(/% \/ [+-][\d,]+ 元/g) || []).length >= W.walls.length - 1, W.txt.slice(0, 300));
    if (W.rulerLen) ok('§w3 ⭐ 報告頁的價格位置圖 = 總覽 _priceRulerHtml() 逐字相同(同一支函式;注入:自己畫 → 必紅)', W.hasRuler === true, `rulerLen ${W.rulerLen}`);
    else console.log('⏭️ §w3 這一輪 _keyLevels 還沒算(尺是空的)→ 驗不到逐字相同,不算過');
    ok('§s1 §17 壓力測試:跌 20% 的價位與一張賠多少 = 手算(_netPL(現價, 現價×0.8, 1000))', W.st['20'] && W.st['20'].includes(W.px20) && W.st['20'].includes(`一張 ${W.one20.toLocaleString()} 元`), W.st['20']);
    ok('§s2 四級都在(10/20/30/40)且每級講「途中撞到」或「沒有本站記錄的價位」', ['10', '20', '30', '40'].every(k => W.st[k] && /(途中撞到|沒有本站記錄)/.test(W.st[k])), JSON.stringify(Object.keys(W.st)));
    ok('§s3 壓力測試文案⛔ 不出現「機率」「目標價」', !/機率|目標價/.test(W.txt), (W.txt.match(/.{15}(機率|目標價).{15}/) || [])[0]);
    // 🧮 §14
    const S = await page.evaluate(() => {
        const A = app, C = A._rpLast, box = document.getElementById('rpVal');
        const s = box.querySelector('[data-rpsens]');
        const cells = s ? [...s.querySelectorAll('.font-mono.text-\\[11px\\]')].map(el => +el.textContent.replace(/,/g, '')) : [];
        return { has: !!s, cells, mid: Math.round(C.eps * 1.0 * C.band.med), lo: Math.round(C.eps * 0.8 * C.band.p25), hi: Math.round(C.eps * 1.2 * C.band.p75), txt: s ? s.textContent.replace(/\s+/g, ' ') : '' };
    });
    ok('§v1 §14 敏感度 9 格 = EPS×變動×倍數(左上 = 0.8×P25、中 = 1.0×中位、右下 = 1.2×P75 手算一致)', S.has && S.cells.length === 9 && S.cells[0] === S.lo && S.cells[4] === S.mid && S.cells[8] === S.hi, JSON.stringify({ cells: S.cells, lo: S.lo, mid: S.mid, hi: S.hi }));
    ok('§v2 敏感度⛔ 沒有機率欄、不叫目標價/預估價、要寫「算術不是預測」', S.has && !/樂觀機率|悲觀機率|目標價|預估價/.test(S.txt) && /算術/.test(S.txt) && /不給機率/.test(S.txt), S.txt.slice(0, 200));
    // 🔄 循環股:純函式只換 cyc 這一個維度
    const CY = await page.evaluate(() => { const A = app, C = A._rpLast; return { on: /data-rpcyc/.test(A._rpValHtml(Object.assign({}, C, { cyc: true }))), off: /data-rpcyc/.test(A._rpValHtml(Object.assign({}, C, { cyc: false }))) }; });
    ok('§c1 循環股旗標 → 估值節多一行「位階要反著讀」;非循環股沒有(只換 cyc 一個維度)', CY.on && !CY.off, JSON.stringify(CY));
    // 🗓️ §12・§21
    const E = await page.evaluate(() => {
        const box = document.getElementById('rpRisk'); const d = box.querySelector('details'); if (d) d.open = true;
        const t = box.textContent.replace(/\s+/g, ' ');
        return { t, watch: box.querySelector('[data-rpwatch]') && +box.querySelector('[data-rpwatch]').getAttribute('data-rpwatch') };
    });
    ok('§e1 §12 事件表有財報法定日 / 月營收 / 除權息 / 法說會四列', /財報\s*最晚 \d{2}\/\d{2}/.test(E.t) && /月營收\s*\d{2}\/\d{2}/.test(E.t) && /除權息/.test(E.t) && /法說會/.test(E.t), E.t.slice(0, 300));
    ok('§e2 法說會抓不到時誠實寫「本站沒抓到」+ 🔎(⛔ 不留空)', /法說會 \d{2}\/\d{2}/.test(E.t) || (/本站沒抓到/.test(E.t) && /🔎 查/.test(E.t)), '');
    ok('§e3 事件只講波動⛔ 不講方向(利多/利空/會漲/會跌)', !/利多|利空|會漲|會跌/.test(E.t.slice(E.t.indexOf('§12'))), (E.t.slice(E.t.indexOf('§12')).match(/.{15}(利多|利空|會漲|會跌).{15}/) || [])[0]);
    ok('§e4 §21 觀察清單 5 件事,第一件是你設的出場線', E.watch === 5 && /§21/.test(E.t) && /出場線/.test(E.t), String(E.watch));
    // 📦 §4 財報三表(真檔切片;拿不到就 ⏭️)
    if (FIN_SLICE && FIN_SLICE['2327']) {
        const R6 = await render('2327');
        const FD = await page.evaluate(() => {
            const box = document.getElementById('rpFund'); const d = box.querySelector('details'); if (d) d.open = true;
            const t = box.textContent.replace(/\s+/g, ' ');
            const fl = box.querySelector('[data-rpflags]');
            const q = document.getElementById('rpQuick').textContent.replace(/\s+/g, ' ');
            const src = document.getElementById('rpSrc').textContent.replace(/\s+/g, ' ');
            return { t, flags: fl ? +fl.getAttribute('data-rpflags') : 0, q, src, pb: document.getElementById('rpInd').textContent.includes('淨值比') };
        });
        ok('§f1 📦 國巨:三表段有存貨天數 / 自由現金流 / ROE / 股本', /存貨天數/.test(FD.t) && /自由現金流/.test(FD.t) && /ROE/.test(FD.t) && /股本/.test(FD.t), FD.t.slice(0, 300));
        ok('§f2 🚨 國巨兩道旗標都亮:2025Q3「EPS 崩但營收毛利沒掉 → 業外」+ 2024Q3「股本 +20%」', FD.flags === 2 && /業外/.test(FD.t) && /股本 .* 億元/.test(FD.t), `flags=${FD.flags} ${FD.t.slice(-400)}`);
        ok('§f3 快速表 §4 那列寫「2 個旗標」且標 ✅ 真實資料', /§4 財報品質.*2 個旗標.*✅ 真實資料/.test(FD.q), (FD.q.match(/§4 財報品質.{0,160}/) || [])[0]);
        ok('§f4 來源段列出「財報三表切片」日期', /財報三表切片/.test(FD.src) && !/財報三表切片[^0-9]*本站沒有/.test(FD.src), FD.src.slice(0, 300));
        ok('§f5 §4 誠實寫「應收帳款天數本站沒有」、§5/§6 寫「本站沒有」分析師共識(⛔ 不編)', /應收帳款天數本站沒有/.test(FD.t) && /沒有免費的分析師共識/.test(FD.t), '');
        ok('§f6 上市股同業表多了「淨值比」欄', FD.pb, '');
        ok('📱3 國巨那頁 390px 仍不可橫向溢出', !R6.wide);
        // 累計 vs 單季:切片裡的 cum_fixed 要含 ocf(注入:切片器不還原 → 這裡的 fixture 就會少這個欄)
        ok('§f7 切片 fixture 標示現金流量表已從累計還原成單季(cum_fixed 含 ocf/capex)', FIN_SLICE['2327'].cum_fixed.includes('ocf') && FIN_SLICE['2327'].cum_fixed.includes('capex'), JSON.stringify(FIN_SLICE['2327'].cum_fixed));
    } else console.log('⏭️ 沒有 fin_deep 分支/檔 → §f1~§f7 跳過(git show origin/fin_deep:fin_deep/fin_deep.json > fin_deep/fin_deep.json)');
    // 沒切片的股(5483 不在 fixture)→ 誠實「本站尚未切出」+ 快速表 ⛔
    const R7 = await render('5483');
    ok('§f8 沒有切片的股:§4 寫「本站尚未切出這檔的財報三表」、快速表那列標 ⛔ 本站沒有', /尚未切出/.test(R7.txt.rpFund) && /§4 財報品質[^§]*⛔ 本站沒有/.test(R7.txt.rpQuick), R7.txt.rpQuick.slice(0, 200));
    ok('📄a3 版面順序:結論 → ⚡ 快速表 → 重點數字 → 風險 → 🧱 價格牆 → 估值', (() => { const o = ['rpAct', 'rpQuick', 'rpNum', 'rpRisk', 'rpWalls', 'rpVal']; return true; })() && (await page.evaluate(() => { const ord = [...document.getElementById('subContentReport').children].map(d => d.id); const at = id => ord.indexOf(id); return at('rpAct') < at('rpQuick') && at('rpQuick') < at('rpNum') && at('rpNum') < at('rpRisk') && at('rpRisk') < at('rpWalls') && at('rpWalls') < at('rpVal'); })), '');
}

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ test_report 全過');
process.exit(fails.length ? 1 : 0);
