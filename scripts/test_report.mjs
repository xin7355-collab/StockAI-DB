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
// ⏳ V76.3.9 報告頁有好幾份**非同步才到齊**的資料(fund_yoy_gm / _keyLevels / _upsideStash / _lastGauge)。
//   「渲染當下的 HTML」跟「等一下再算一次」因此可能不一樣 → ⑫g/⑫h/§w3 會隨機紅(每次紅的還不同條)。
//   ⭐ 永遠會紅的測試等於沒有測試 → 比對之前先讓它**站定**:重繪到「連續兩次算出來一模一樣」為止。
//   ⛔ 不是放寬斷言(那會把真的壞掉一起放過)。同 page_sweep「等 diag 連續兩次站得住」的做法。
const settle = async (page) => page.evaluate(async () => {
    const A = app, s = A._rpLast && A._rpLast.sym; if (!s) return false;
    let prev = null;
    for (let i = 0; i < 10; i++) {
        await A.renderReportTab(s);
        await new Promise(r => setTimeout(r, 350));
        const cur = A._reportPrompt(s) + '|' + (A._priceRulerHtml() || '');
        if (cur === prev) return true;
        prev = cur;
    }
    return false;
});

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
    ok('⑪a analyze() 切股清單含每一個 rp*(⛔ 少一個 = 那一段顯上一檔;V76.2.5 移除已下架的 rpNum/rpAct)', ['rpLead', 'rpVal', 'rpFund', 'rpInd', 'rpChip', 'rpRisk', 'rpSrc', 'rpQuick', 'rpWalls', 'rpPaste', 'rpImg'].every(id => new RegExp(`'deepBriefCard', 'deepBriefAi',[\\s\\S]{0,400}'${id}'`).test(SRC)));
    ok('⑪a2 🗑️ V76.2.5 `rpNum`/`rpAct` 已下架 → ⛔ 容器與寫入都不可以還在(留著會顯示上一檔的殘留)',
       !/id="rpNum"/.test(SRC) && !/id="rpAct"/.test(SRC) && !/_rpSet\('rpNum'/.test(SRC) && !/_rpSet\('rpAct'/.test(SRC));
    //   🚨 注入驗證抓到:`/this\._regaugeStrip\(sym\)/` 會被**函式定義那一行**救活 = 假綠燈
    //      → 一定要釘「`try { … } catch` 包起來的**呼叫**」那個形狀(CLAUDE.md:斷言被別處救活)。
    ok('⑪a3 ⚠️ 但**產生資料**的那兩行一行都不可以拿掉(同 V76.1.2:卡可以下架,產生者不行)',
       /const dec = \(\(\) => \{ try \{ return this\._ovDecide\(/.test(SRC)
       && /try \{ this\._regaugeStrip\(sym\); \} catch/.test(SRC));
    // ③ 渲染層不可自己寫買賣指令:只掃報告區塊(_rpValHtml ~ _reportAsk),排除轉述 _ovDecide 的那支
    //   ⚠️ V76.2.5 起點從 `_rpNumHtml`(已下架)換成 `_rpValHtml`。
    //   🚨 一度改成 `_rpAnnualEps` —— **那是錯的**:它排在 `renderReportTab` **之前**,
    //      會把 renderReportTab 整支(含 `'FinMind 採礦'` 這個來源標籤)掃進來 → ⑬a 當場紅。
    //      ⭐ 起點一定要挑**渲染函式**,⛔ 不可挑資料組裝函式。
    const a = SRC.indexOf('    _rpValHtml('), b = SRC.indexOf('    _reportAsk(');
    const blk = strip(SRC.slice(a, b));
    //   ⚠️ 做圖提示詞裡有「⛔ 不可…」這種**禁止句** —— 那是在禁止,⛔ 不是在下指令 → 先剝掉再掃。
    const blkNoBan = blk.replace(/⛔[^\n。]*/g, '');
    ok('③a 報告渲染層不可出現新的操作指令動詞(順勢做多/可進場/加碼/追…)', !/(順勢做多|可以進場|可進場|放心做|可加碼|建議買進|建議賣出|追要|可以追)/.test(blkNoBan), (blkNoBan.match(/(順勢做多|可以進場|可進場|放心做|可加碼|建議買進|建議賣出|追要|可以追)/) || [])[0]);
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
        // 🏷️ V76.2.5 改成**按名字取**(⛔ 不再用 `R.html[0]` 這種索引 —— 那是釘住當時的陣列順序,
        //   卡片一下架就整批錯位;CLAUDE.md:斷言要釘用意)。
        html: Object.fromEntries(['rpLead', 'rpQuick', 'rpWalls', 'rpRisk', 'rpVal', 'rpFund', 'rpInd', 'rpChip', 'rpSrc'].map(id => [id, g(id)])),
        txt: Object.fromEntries(['rpLead', 'rpQuick', 'rpWalls', 'rpRisk', 'rpVal', 'rpFund', 'rpInd', 'rpChip', 'rpSrc'].map(id => [id, txt(id)])),
        ctx: (() => { const C = A._rpLast; return C ? { sym: C.sym, eps: C.eps, aeSrc: C.ae && C.ae.src, kind: C.ae && C.ae.kind, pe: C.pe, pC: C.pC, peer: C.peer, indK: C.indK, otc: C.otc, band: C.band, valRows: C.valRows, marginDate: C.s20 && C.s20.marginDate, badge: C.dec && C.dec.badge } : null; })(),
        s20: A._chipPeriodSums(A.rawDailyData, 20),
        // 🚨 V76.1.9 判準換掉 —— `scrollWidth` 被 CLAUDE.md:1550 明文禁用(「會把被 clip 的內容也算進去」),
        //   而 index.html 有 `html,body{overflow-x:hidden}` → 真的溢出會被默默切掉、這條永遠綠(陷阱 #40)。
        //   ⭐ 改成 CLAUDE.md 規定的 `scrollTo(80,0)` + `scrollX`,再加**逐元素跟父層比**(照 rwd_audit.mjs)。
        wide: (() => { window.scrollTo(80, 0); const x = window.scrollX; window.scrollTo(0, 0); return x > 2; })(),
        // 🚨 沙箱沒有 Tailwind → 祖先(`p-3` / `px-2` / flex-col)全部沒寬度,實測父層只剩 **43px**,
        //   量到的「超出 36px」是**假的**。⭐ 照 test_gauge.mjs 的做法:先把容器釘成**已知寬度**再量,
        //   並回報那個寬度(⛔ 寬度是 0/太窄就不可信 → 下面有空過守門)。390 − 頁面 16 − 卡片 16 ≈ 358。
        esc: (() => {
            const src = document.getElementById('subContentReport'); if (!src) return { w: 0, list: [] };
            // ⭐ 原地釘寬度沒用(祖先鏈會把它壓回 200px)→ 照 test_gauge 的做法**複製到固定寬度的容器**再量
            const host = document.createElement('div');
            host.style.cssText = 'position:absolute;left:0;top:0;width:358px;max-width:358px;display:block';
            const box = src.cloneNode(true);
            box.setAttribute('style', 'display:block;width:358px;max-width:358px');
            box.removeAttribute('id');
            host.appendChild(box); document.body.appendChild(host);
            const vis = el => { if (!el.offsetParent && el.tagName !== 'BODY') return false;
                for (let n = el; n && n !== document.body; n = n.parentElement) {
                    const d = n.style && n.style.display; if (d === 'none') return false;
                    if (!d && n.classList && n.classList.contains('hidden')) return false; } return true; };
            const out = [];
            for (const el of box.querySelectorAll('div,span,button,table')) {
                if (!vis(el)) continue;
                const pa = el.parentElement; if (!pa) continue;
                const a = el.getBoundingClientRect(), b = pa.getBoundingClientRect();
                if (b.width < 40 || a.width < 20) continue;
                const ps = getComputedStyle(pa), pcls = String(pa.className || '');
                if (/auto|scroll/.test(ps.overflowX + ps.overflow) || /overflow-x-auto|overflow-auto|overflow-x-scroll/.test(pcls)) continue;
                const over = Math.round(a.right - b.right);
                if (over > 6) out.push({ t: (el.id || el.getAttribute('data-rpq') || el.getAttribute('data-rpwall') || el.className || '').toString().slice(0, 40), over, pw: Math.round(b.width) });
            }
            const w = Math.round(box.getBoundingClientRect().width);
            host.remove();
            return { w, list: out.slice(0, 8) };
        })(),
        tw: (() => { const d = document.createElement('div'); d.className = 'hidden'; document.body.appendChild(d);
            const ok = getComputedStyle(d).display === 'none'; d.remove(); return ok; })(),
        quickSeen: (() => { const q = document.getElementById('rpQuick'); return q ? (q.innerText || '') : ''; })(),
        quickAll: (() => { const q = document.getElementById('rpQuick'); return q ? q.innerHTML : ''; })(),
    };
  }, sym);
};

const R = await render('5483');
ok('① 9 顆 sub-tab 按鈕、切到 report 後只有 subContentReport 是 flex', R.btnCount === 9 && R.disp.every(([t, d]) => (t === 'Report') === (d === 'flex')), JSON.stringify(R.disp));
// ⚠️ V75.3.2 起 `rpLead`(index 1)在**有結論時刻意留空** —— 結論卡已經把同一句話講完了,
//   並存兩個聲音正是使用者最討厭的「邏輯打架 / 資訊爆炸」。它是 hidden 不是空殼。
ok('⓪ 其餘每一段都有內容(⛔ 不留空殼)',
   Object.entries(R.html).filter(([k]) => k !== 'rpLead').every(([, h]) => h && h.length > 40),
   Object.entries(R.html).map(([k, h]) => `${k}=${(h || '').length}`).join(','));
ok('⓪b ⭐ 有結論時 lead 那條整條不顯示(⛔ 不可跟結論卡講同一句話兩次)',
   !R.html.rpLead && !!R.ctx && !!R.ctx.badge, `lead=${(R.html.rpLead || '').length} badge=${R.ctx && R.ctx.badge}`);
const ALL = Object.values(R.txt).join(' ');
const ALLnoDisc = ALL.replace(/⛔ ?這不是目標價,也不是預測/g, '').replace(/⛔ ?不是目標價/g, '');
ok('③c 整頁不出現「目標價」(免責句除外)', !/目標價/.test(ALLnoDisc), (ALLnoDisc.match(/.{20}目標價.{20}/) || [])[0]);
// 🗑️ V76.2.5 結論卡已下架(跟總覽重複)→ 這條改驗「⚡ 快速表仍然轉述 `_ovDecide`,⛔ 不自己判」。
//   ⭐ 那才是原本的用意:報告頁的結論只能是**轉述**。
ok('③d ⚡ 快速表的結論 = _ovDecide.badge(轉述,不是自己判的)',
   R.ctx && R.ctx.badge && R.txt.rpQuick.includes(R.ctx.badge.replace(/<[^>]+>/g, '')), `${R.ctx && R.ctx.badge} | ${R.txt.rpQuick.slice(0, 120)}`);
// 🏪 V77.0.2 這條原本釘「5483 要寫『上櫃無官方產業分類』」—— V76.4.0 把上櫃產業別接上之後,
//   5483 真的有分類了(industry_map → 24 半導體)→ 那句話變成**謊話**,而測試還在逼它說謊。
//   ⭐ 改成釘**用意**:同業那一行**只有兩種合法輸出** —— 給得出中位數(並在上櫃時說明中位數只用上市股算),
//   或誠實說沒有;⛔ 不可留白、⛔ 不可印成 0.0x(陷阱 #28:「資料源沒有」與「條件不成立」是兩件事)。
ok('④a 同業中位那一行只有兩種合法輸出:給得出來(上櫃要標明中位數只用上市股算)或誠實說沒有',
   R.ctx && (R.ctx.peer != null
       ? (/同業中位 PE 來自 industry_pe/.test(R.txt.rpVal) && (!R.ctx.otc || /只用上市股算/.test(R.txt.rpVal)))
       : /本站沒有這一類的中位數|本站沒有這一檔的產業分類/.test(R.txt.rpVal))
   && !/同業中位 PE[^。]*\b0\.0+x/.test(R.txt.rpVal),   // ⚠️ 第一版寫成 `0\.0` → 被「同業中位給法 = 200.0 元」誤判(自己的假失敗)
   `peer=${R.ctx && R.ctx.peer} otc=${R.ctx && R.ctx.otc} :: ` + R.txt.rpVal.slice(0, 300));
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
// 🗑️ V76.2.5 ⑧「數字卡每格都有日期徽章」已隨重點數字搬去基本頁 → 由 📄c 系列在那邊驗。
ok('⑨ 整頁不出現 `--`(缺資料要寫本站沒有/尚未)', !/(^|[^-])--([^-]|$)/.test(ALL), (ALL.match(/.{20}--.{20}/) || [])[0]);
ok('⑩a 風險段只用 ✅⚠️⛔🚨,⛔ 不用 🔴🟢', !/[🔴🟢]/u.test(R.txt.rpRisk) && /[✅⚠️]/u.test(R.txt.rpRisk));
ok('⑩b 估值表的距現價用文字色(紅漲綠跌)、免責用琥珀,⛔ 不用紅綠 emoji', !/[🔴🟢]/u.test(R.txt.rpVal));
ok('⑭ 估值表每一列 % 都配「元」', (R.txt.rpVal.match(/% \/ [+-][\d,]+ 元/g) || []).length >= 5);
ok('⑮a 反查器 UI 存在', /rpRevIn/.test(R.html.rpVal) && /rpRevOut/.test(R.html.rpVal));
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
    // 📐 V76.2.5 使用者指定的新版面:📄 短評報告(圖)→ 📝 你貼上的 → ⚡ 快速表 → 各節照 § 排
    ok('📄a ⭐ 短評報告(圖)是第一眼(rpLead 只在「還在算」時才有字)',
       at('rpImg') >= 0 && at('rpImg') < at('rpPaste') && at('rpPaste') < at('rpQuick'), ord.join(','));
    ok('📄a2 ⭐⭐ 各節**照 § 由小到大**排(使用者問了兩次;他拿外部 AI 的 20 節報告逐節對照)',
       at('rpInd') < at('rpFund') && at('rpFund') < at('rpChip') && at('rpChip') < at('rpWalls')
       && at('rpWalls') < at('rpRisk') && at('rpRisk') < at('rpVal'), ord.join(','));
    ok('📄a2b §0(資料日期)是附錄 → 排最後', at('rpSrc') === ord.length - 1, ord.join(','));

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
    // 📊 V76.2.5 重點數字**已搬到「基本」分頁**(使用者明示)→ 這一組跟著搬過去驗。
    const CN = await page.evaluate(async () => {
        const A = app;
        try { A.switchSubTab('corp'); } catch (_) {}
        await new Promise(r => setTimeout(r, 700));
        const el = document.getElementById('corpNums');
        const hero = document.querySelectorAll('#corpNums .grid.grid-cols-2 > div').length;
        const keys = [...document.querySelectorAll('#corpNums [data-rpk]')].map(d => d.getAttribute('data-rpk'));
        el && el.querySelectorAll('details').forEach(d => { d.open = true; });
        const txt = el ? el.innerText.replace(/\s+/g, ' ') : '';
        try { A.switchSubTab('report'); } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
        return { hidden: el ? el.classList.contains('hidden') : null, hero, keys, txt, len: txt.length };
    });
    ok('📄c ⭐ 重點數字搬到「基本」分頁而且真的畫出來了', CN.hidden === false && CN.len > 40, JSON.stringify(CN).slice(0, 240));
    ok('📄c1 第一眼只有 4 格(其餘收進「其他數字」摺疊)', CN.hero === 4, `hero=${CN.hero} keys=${CN.keys}`);
    ok('📄c2 其餘數字仍在頁面上(⛔ 是收起來不是刪掉)', /其他數字/.test(CN.txt) && CN.keys.length >= 6, `${CN.keys}`);
    // 🚨🚨 這條是這次改版的**核心鐵則**:基本頁 X 光機本來就有本益比/殖利率/股價淨值比/月營收,
    //   搬過來時**刻意不重複放** —— 同一個數字全 App 只能有一份(使用者鐵則「邏輯不打架」)。
    ok('📄c3 ⭐⭐ ⛔ 不重複放 X 光機已有的四項(本益比 / 殖利率 / 股價淨值比 / 最新月營收)',
       !CN.keys.some(k => /本益比|殖利率|股價淨值比|最新月營收/.test(k)), `${CN.keys}`);
    ok('📄c4 ⭐ 而且要主動指路「那四個在下面的完整基本面數據裡」(⛔ 不可讓使用者以為不見了)',
       /完整基本面數據/.test(CN.txt), CN.txt.slice(-200));
    //   ⚠️ ⛔ 別用「innerHTML 含不含 rpNum 這個字串」判 —— DOM 註解裡就提到它,會誤判(實跑踩到)
    ok('📄c5 🗑️ 報告頁**不可以**還有重點數字容器(⛔ 搬走就是搬走,不是複製一份)',
       await page.evaluate(() => !document.getElementById('rpNum') && !document.querySelector('#subContentReport [data-rpk]')));
    ok('📄c6 🗑️ 「📋 複製整份報告」已下架(使用者明示)',
       await page.evaluate(() => typeof app._rpCopyReport !== 'function' && typeof app._rpCopyPlain !== 'function'));

    // 五節標題那句 = 事實 + 數字,⛔ 不下判定詞
    const sums = await page.evaluate(() => [...document.querySelectorAll('#subContentReport details > summary')]
        .map(d => d.textContent.replace(/\s+/g, ' ').trim()));
    ok('📄d 每一節標題都帶一句「這一節的答案」(⛔ 不是只有名詞)',
       sums.length >= 5 && sums.filter(t => t.replace(/展開 ▾/, '').trim().length > 12).length >= 5, JSON.stringify(sums).slice(0, 400));
    ok('📄e 標題那句⛔ 不可出現判定詞(合理/便宜/貴/可以買/該賣)',
       !/合理|便宜|可以買|該買|該賣|值得買/.test(sums.join(' ')), JSON.stringify(sums).slice(0, 300));

    // 🗑️ V76.2.5「📋 複製整份報告」已下架 → 這一組改成上面的 📄c6 驗「真的沒了」。
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
    await settle(page);   // ⏳ 先站定,否則「複製的」跟「等一下再算的」會差一點點(隨機紅)
    const P = await page.evaluate(() => { let cap = null; const real = app._freeAiOpen; app._freeAiOpen = q => { cap = q; }; app._reportAsk('5483'); app._freeAiOpen = real; return cap; });
    await page.evaluate((p) => { window.P0 = p; }, P);
    ok('⑫a 提示詞含 5 條防幻覺關鍵句 + 第 6 條', ['絕對禁止「主觀預測」', '年化EPS × 近3年 P5/中位/P95 PE', '不可腦補', '股價基期」與「估值基期」是兩件事', '循環股獲利頂峰時 PE 最低', '附日期與來源網址'].every(k => P.includes(k)));
    // V76.2.0 提示詞改成使用者那份 22 節骨架:每節 §N、第一行基準日、結尾來源表、本站已算的節⛔ 不要自己算、⛔ 不給評分/星等/機率
    ok('⑫b 提示詞 20 節骨架:§1~§20 每一節都點名、⛔ 不可再出現 §21/§22 當內容節 + 第一行「分析基準日期」+ 結尾「§21 來源表」',
       Array.from({ length: 20 }, (_, i) => `§${i + 1} `).every(k => P.includes(k)) && /分析基準日期/.test(P) && /§21 來源表/.test(P) && !/§22 /.test(P), P.slice(0, 200));
    ok('⑫b2 提示詞明說「本站已經算好⛔ 不要自己算」+ ⛔ 刪掉因子評分/星等 + ⛔ 不給機率 + 本益比要寫「現在的」', /本站已經算好的數字/.test(P) && /不要自己算/.test(P) && /因子評分、§20 星等評等已經刪掉/.test(P) && /不給機率/.test(P) && /本益比一律寫「現在的」/.test(P), '');
    const FACT_KEYS = ['- 均線:', '上方套牢區', '你設的出場線', '股價位階', '財報三表', '集保大戶散戶', '融資追繳壓力區', '下一個事件', '族群名次', '本站結論'];
    ok('⑫b3 客觀數據要有均線 / 套牢區 / 出場線,而且 V76.2.3 補上位階 / 財報三表 / 集保 / 融資追繳 / 事件 / 族群名次 / 本站結論',
       FACT_KEYS.every(k => P.includes(k)), FACT_KEYS.filter(k => !P.includes(k)).join(','));
    // 🚨 這一條才有鑑別力:上一條只看「- 均線:」那幾個字在不在,值印「—」也照樣綠(注入「拿掉 K 線 fallback」時實測沒被抓到)。
    //   `indicators` 是 worker 算的、切到報告頁常常還沒好 → 一定要**自己從 K 線補算**,⛔ 不可留空給外部 AI 自己填。
    const MAF = await page.evaluate(() => {
        const A = app, bak = A.indicators;
        A.indicators = {};                                   // 模擬「worker 還沒算完」
        const line = (A._reportPrompt('5483').match(/- 均線:[^\n]*/) || [''])[0];
        const o = A._rpMaLevels();
        A.indicators = bak;
        return { line, n: Object.keys(o).length };
    });
    ok('⑫b3b 🚨 worker 還沒算完時,均線那行**照樣要有數字**(⛔ 不可印「—」—— 實測外部 AI 會自己算,季線寫 707.4、真值 704.4)',
       MAF.n >= 3 && /月線 \d/.test(MAF.line) && !/^- 均線:—$/.test(MAF.line), MAF.line);
    ok('⑫b4 🚨 提示詞要明寫「看到『—』⛔ 不可以自己算」+「出場線 ≠ 融資追繳線」(實測外部 AI 兩件都犯過)',
       /不可以自己算或自己編/.test(P) && /出場線 ≠ 融資追繳線/.test(P), '');
    ok('⑫d 提示詞 <6,500 字且帶入年化 EPS / 位階', P.length < 6500 && P.includes(R.ctx.eps.toFixed(2)) && /估值基期.*\d+%/.test(P), `len ${P.length}`);
    // 🎨 V76.2.3 做圖提示詞:顏色鐵則要寫死(使用者那張圖把「好」塗綠、「風險」塗紅,跟同圖上的漲跌顏色打架)
    const CH = await page.evaluate(() => { const A = app; return { q: A._reportChartPrompt('5483'), sameFacts: A._reportChartPrompt('5483').includes(A._reportFacts('5483')) }; });
    ok('🎨a 做圖提示詞寫死台股紅漲綠跌 + ⛔ 紅綠不可表示好壞 + 風險用 ✅⚠️⛔ 圖示 + ⛔ 不畫綠牛紅熊',
       /紅色 = 上漲/.test(CH.q) && /綠色 = 下跌/.test(CH.q) && /絕對不可以拿來表示「好 \/ 壞」/.test(CH.q) && /✅ 安全/.test(CH.q) && /不要畫任何動物、吉祥物或擬人角色/.test(CH.q), CH.q.slice(0, 120));
    ok('🎨b 做圖提示詞跟研究提示詞**共用同一份數字**(⛔ 不寫兩份 —— 改一邊會忘另一邊)', CH.sameFacts, '');
    ok('🎨c 🚨 把實測抓到的四個錯寫成規則:數字照抄 / 出場線≠融資追繳線 / 估值尺要照價格排序 / ⛔ 不要評分星等機率 / ⛔ 不要重複字',
       /照抄/.test(CH.q) && /出場線 ≠ 融資追繳線/.test(CH.q) && /按「價格由小到大」排/.test(CH.q) && /★ 星等評分/.test(CH.q) && /不重複的繁體中文/.test(CH.q), '');
    // 💾 V76.2.7 完整報告搬到 IndexedDB(使用者回報「這台裝置存不下來(儲存空間滿了)」)
    //   🚨 真因⛔ 不是報告太大(6.5 KB)—— 實測 `brokerChips_v2_{sym}` **一檔就 108 KB**、無上限累積。
    {
        const ST = await page.evaluate(async () => {
            const A = app, out = {};
            //   ⚠️ ⛔ 別自己 append 一個 rpNoteIn —— 頁面上**已經有一個**(貼上區的),
            //     getElementById 只會抓到 DOM 順序較前的那個(空的)→ 會拿到「先貼進來再存」= 假失敗(實跑踩到)
            let ta = document.getElementById('rpNoteIn'), tmp = false;
            if (!ta) { ta = document.createElement('textarea'); ta.id = 'rpNoteIn'; document.body.appendChild(ta); tmp = true; }
            const prev = ta.value;
            ta.value = '測試報告內容'.repeat(40);
            const rt = A.showToast; let toast = ''; A.showToast = m => { toast += m + '|'; };
            await A._rpNoteSave('9998');
            A.showToast = rt; if (tmp) ta.remove(); else ta.value = prev;
            out.toast = toast;
            out.inIdb = !!(await A.idb.get('rpNote_9998'));
            out.inLs = !!localStorage.getItem('rpNote_9998');
            out.syncRead = !!A._rpNote('9998');
            // prune 的規則是「ts 超過 7 天**或沒有 ts**就刪」→ 使用者自己存的東西一定中
            const rec = await A.idb.get('rpNote_9998');
            await A.idb.put('rpNote_9998', Object.assign({}, rec, { ts: Date.now() - 30 * 864e5 }));
            await A.idb.prune();
            out.survivedPrune = !!(await A.idb.get('rpNote_9998'));
            // 舊版(V76.2.7 前存 localStorage)要自動搬家 **並刪掉舊的**
            localStorage.setItem('rpNote_9997', JSON.stringify({ t: '舊版存的報告', ts: Date.now(), v: 2 }));
            await A._rpNoteLoad('9997');
            out.migrated = !!(await A.idb.get('rpNote_9997')) && !localStorage.getItem('rpNote_9997') && !!A._rpNote('9997');
            await A._rpNoteClear('9998'); await A._rpNoteClear('9997');
            out.cleared = !(await A.idb.get('rpNote_9998')) && !A._rpNote('9998');
            // LRU:語意是「留 keep 筆」,而且留**最新**的
            //   ⚠️ 先清乾淨 —— 真實的 `brokerChips_v2_{sym}` 也會被算進去(實跑量到 5 而不是 7)
            Object.keys(localStorage).forEach(k => { if (k.startsWith('brokerChips_v2_')) localStorage.removeItem(k); });
            for (let i = 0; i < 12; i++) localStorage.setItem('brokerChips_v2_ZZ' + i, JSON.stringify({ ts: 1000 + i, x: 1 }));
            A._lruTrim('brokerChips_v2_', 7);
            out.lruLeft = Object.keys(localStorage).filter(k => k.startsWith('brokerChips_v2_ZZ')).length;
            out.lruNewest = !!localStorage.getItem('brokerChips_v2_ZZ11') && !localStorage.getItem('brokerChips_v2_ZZ0');
            Object.keys(localStorage).forEach(k => { if (k.startsWith('brokerChips_v2_ZZ')) localStorage.removeItem(k); });
            return out;
        });
        ok('💾a ⭐ 完整報告存進 **IndexedDB**,⛔ 不再佔 localStorage(那 5 MB 要留給別人)',
           ST.inIdb && !ST.inLs, JSON.stringify(ST).slice(0, 200));
        ok('💾a2 顯示端仍**同步**讀得到(照 _rpImg 的做法,四個呼叫端一行都不用改)', ST.syncRead, String(ST.syncRead));
        ok('💾a3 🚨 存成功要顯示成功 —— ⛔ 不可存進去了卻跳「存不下來」(idb.put 以前成功回 undefined)',
           /已存成這一檔的報告/.test(ST.toast) && !/存不下來/.test(ST.toast), ST.toast.slice(0, 80));
        ok('💾b 🚨 `idb.prune()` ⛔ 不可清掉(它的規則是「ts 超過 7 天**或沒有 ts**」→ 一定中;注入:拿掉 rpNote_ 白名單 → 這條紅)',
           ST.survivedPrune, String(ST.survivedPrune));
        ok('💾c ⭐ 舊版存在 localStorage 的要自動搬進 IndexedDB **並刪掉舊的**(⛔ 不可只複製 —— 那 30 KB 還佔著)',
           ST.migrated, String(ST.migrated));
        ok('💾d 刪得掉(IndexedDB 與同步快取都要清)', ST.cleared, String(ST.cleared));
        ok('💾e 🧹 `_lruTrim(prefix, keep)` 語意 = 留 keep 筆,而且留**最新**的',
           ST.lruLeft === 7 && ST.lruNewest, JSON.stringify({ left: ST.lruLeft, newest: ST.lruNewest }));
        ok('💾e2 ⭐ `brokerChips_v2_`(實測一檔 108 KB)要接上 LRU —— ⛔ 沒有上限就是配額爆掉的真兇',
           /_lruTrim\('brokerChips_v2_', 7\)/.test(SRC), '');
    }
    // 🗑️ V76.2.7 做圖提示詞的入口全 App 只留一個(使用者:「有何不同?是否保留上方就好」→ 是同一支函式)
    ok('🗑️b 🎨 做圖提示詞只有**短評報告**那張卡有入口(⛔ 完整報告卡那顆已刪 —— 同一支 _reportCopyChart)',
       await page.evaluate(() => {
           const img = document.getElementById('rpImg'), paste = document.getElementById('rpPaste');
           //   ⚠️ ⛔ 別用「innerHTML 含不含字串」—— 說明用的**註解**也會進 innerHTML,會誤判(實跑踩到)
           //     → 數真正的**按鈕**。
           const inImg = img ? img.querySelectorAll('button[onclick*="_reportCopyChart"]').length : 0;
           const inPaste = paste ? paste.querySelectorAll('button[onclick*="_reportCopyChart"]').length : 0;
           return inImg >= 1 && inPaste === 0;
       }));

    ok('🎨d 圖的最下面一定要有免責那一行', /這不是投資建議 ・歷史統計不是保證/.test(CH.q), '');
    // 🚨 V76.2.6 使用者第二張 AI 圖照出來的三個新錯 → 寫成規則(⛔ 不是改文案而已)
    ok('🎨e 🚨 刻度尺/長條⛔ 不可用綠→黃→紅漸層表示「低估→高估」(同一個綠會一邊是跌、一邊是便宜)',
       /不可以做「綠 → 黃 → 紅」那種漸層/.test(CH.q) && /灰階或藍階/.test(CH.q), '');
    ok('🎨f 🚨 估值尺「同業中位」那一格也要照價格排進去(⛔ 不可固定放最後)',
       /同業中位那一格也要一起排進去/.test(CH.q), '');
    ok('🎨g 🚨 ⛔ 不可自己下「位階偏高/偏低」判語(實測:數字 38% 卻寫「位階偏高」)',
       /不可以自己下「位階偏高 \/ 偏低」這種判語/.test(CH.q) && /照抄下面的「本站結論」/.test(CH.q), '');
    // 🚨 V76.2.6 同名不同義:餵給外部 AI 的每一條價位都要用**同一把尺**。
    //   ⚠️ 行為斷言在這份測資上**沒有鑑別力**(它沒有同時產出出場線與追繳線 —— 第一版就印了
    //      「情境不存在」)→ 改成**釘寫法**(同 §g1/§g2 的做法):那一行必須走 `rel(`,⛔ 不可用 `mcs.distPct`。
    //   實測後果:出場線 533.0 標 −2.0%、追繳線 532.3 標 **+2.2%**,兩條都在現價下方卻一正一負。
    {
        const fa = SRC.indexOf('    _reportFacts('), fb = SRC.indexOf('    _reportPrompt(');
        const fseg = SRC.slice(fa, fb);
        const mgLine = (fseg.split('\n').find(l => l.includes('融資追繳壓力區(推估')) || '');
        ok('🎨h 🚨 融資追繳線的「距現價」要跟別條用**同一把尺** `rel()`(⛔ 不可用方向相反的 `mcs.distPct`)',
           /rel\(C\.mcs\.callLine\)/.test(mgLine) && !/mcs\.distPct/.test(mgLine), mgLine.slice(0, 160));
        ok('🎨h2 ⭐ 而且那把尺對**每一條**都一樣(均線 / 套牢區上下緣 / 出場線 / 追繳線 都用 rel)',
           (fseg.match(/rel\(/g) || []).length >= 6, String((fseg.match(/rel\(/g) || []).length));
    }

    // ⚠️ V76.2.3:「目標價」現在出現 2 次 —— 禁令句 + 出場線那列的澄清(「⛔ 不是目標價」),兩個都是**禁止**的語氣。
    //   要釘的用意是「⛔ 不可以有『請給目標價』這種要求」,⛔ 不是釘次數(釘次數 = 釘住當時的實作)。
    ok('⑫e 提示詞的「目標價」只出現在禁止/澄清句,⛔ 沒有任何一句在要 AI 給目標價',
       P.includes('「具體目標價」') && !/(請|要|給出|提供|寫出)[^。\n]{0,8}目標價(?!」)/.test(P.replace('絕對禁止「主觀預測」未來股價或給出「具體目標價」', '')),
       (P.match(/.{0,18}目標價.{0,10}/g) || []).join(' | '));
    // 📋 V76.2.1 使用者實測:點開 Perplexity 輸入框是空的(提示詞 2,400 字 → 網址 1.6 萬字元,App 接手時帶不過去)
    //   → ⭐ 開之前要**先複製**;另外要有一顆手動「複製提示詞」;複製不了要跳手動選取視窗(⛔ 不可靜默失敗)
    ok('⑫f 🚨 提示詞做成網址會超過 1 萬字元 —— 這就是 App 帶不進去的原因(釘住:別再以為縮短一點就好)', encodeURIComponent(P).length > 10000, `enc ${encodeURIComponent(P).length}`);
    const CP = await page.evaluate(() => {
        const A = app, seen = [];
        const realCopy = A._copyText, realOpen = A._freeAiOpen, realModal = A._showRichModal;
        const order = [];
        A._copyText = t => { order.push('copy'); seen.push(t); return true; };
        A._freeAiOpen = () => { order.push('open'); };
        A._reportAsk('5483');
        const askOrder = order.join('>'), askCopied = seen[0];
        // 手動那顆:複製成功 → 只複製不開視窗
        seen.length = 0; order.length = 0;
        A._reportCopyPrompt('5483');
        const manualCopied = seen[0];
        // 複製失敗 → 一定要跳手動選取視窗,而且視窗裡是**完整**提示詞
        let modal = null;
        A._copyText = () => false; A._showRichModal = (t, h) => { modal = { t, h }; };
        A._reportCopyPrompt('5483');
        A._copyText = realCopy; A._freeAiOpen = realOpen; A._showRichModal = realModal;
        const src = A._copyText.toString();
        return { askOrder, askSame: askCopied === P0, manualSame: manualCopied === P0, modal,
                 syncFirst: src.indexOf('execCommand') < src.indexOf('navigator.clipboard') && !/async |await /.test(src),
                 btn: !!document.querySelector('#rpPaste [data-rpcopyprompt]') };
    });
    ok('⑫g ⭐ 「🔎 開 Perplexity」要**先複製再開**(⛔ 反過來就沒意義了)', CP.askOrder === 'copy>open' && CP.askSame, CP.askOrder);
    ok('⑫g2 ⭐ `_copyText` 必須是**同步**、而且 execCommand 排在 clipboard API 之前(await 會讓外連被瀏覽器擋掉)', CP.syncFirst, '');
    ok('⑫h 📋 有「複製提示詞」按鈕,按下去複製的就是完整提示詞', CP.btn && CP.manualSame, JSON.stringify({ btn: CP.btn, same: CP.manualSame }));
    ok('⑫i 🔲 複製失敗⛔ 不可靜默 —— 要跳手動選取視窗,且 textarea 內是完整提示詞(注入:拿掉 else 分支 → 紅)',
       !!CP.modal && /提示詞/.test(CP.modal.t) && CP.modal.h.includes('<textarea') && CP.modal.h.includes('全選'), JSON.stringify(CP.modal && CP.modal.t));
}
// 2330(上市):同業列要有數字
const R2 = await render('2330');
ok('④b 2330(上市)同業列有中位 PE 數字', R2.ctx && Number.isFinite(R2.ctx.peer) && /同業中位 PE [\d.]+x/.test(R2.txt.rpVal), `${R2.ctx && R2.ctx.peer} ${R2.txt.rpVal.slice(0, 120)}`);
ok('④c 2330 每一段有內容、無 --', Object.entries(R2.html).filter(([k]) => k !== 'rpLead').every(([, h]) => h && h.length > 40) && !/(^|[^-])--([^-]|$)/.test(Object.values(R2.txt).join(' ')));
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
        const mid = ['rpLead', 'rpVal', 'rpFund', 'rpInd', 'rpChip', 'rpRisk', 'rpSrc', 'rpQuick', 'rpWalls'].map(id => document.getElementById(id).innerHTML.length);
        await p.catch(() => {});
        // await 回來時 sym 已不同 → ⛔ 不可寫入
        // ⚠️ 用「載入中途切股」重現:第一個 await 回來時 currentSymbolId 已經變了
        //   (⛔ 不是在呼叫前就換 —— 那樣第一行就 return,驗不到 await 之後那幾道守門)
        A.currentSymbolId = '5483';
        const realLoad = A._loadFundCache;
        A._loadFundCache = async function () { A.currentSymbolId = '2330'; return realLoad.call(this); };
        await A.renderReportTab('5483');
        A._loadFundCache = realLoad;
        const after = ['rpVal', 'rpFund', 'rpChip', 'rpRisk', 'rpSrc', 'rpQuick', 'rpWalls'].reduce((n, id) => n + document.getElementById(id).innerHTML.length, 0);
        A._activeSubTab = 'report';
        return { before, mid, after, rpSym: A._rpSym };
    });
    ok('⑪b analyze(別檔) 一開始就清空每一段(⛔ 不等資料回來)', r.before > 40 && r.mid.every(n => n === 0), JSON.stringify(r));
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
console.log(R.tw ? '✅ Tailwind 有載入,class 型版面規則有效'
    : '⚠️⚠️ Tailwind CDN 沒載入(沙箱)→ `min-w-0` / `grid-cols-*` / `truncate` **全部沒生效** →\n'
    + '   下面的 📱 幾何斷言只涵蓋「檔案內 CSS + inline 樣式」;class 型的版面問題要靠 §g 寫法守門擋。');
ok('📱 390px 頁面不可橫向捲動(scrollTo(80,0) 後 scrollX ≤ 2 —— ⛔ 不用 scrollWidth,那個被 overflow-x:hidden 夾死)', !R.wide);
ok('📱e0 🚧 空過守門:量測容器真的有 358px 寬(⛔ 0 或太窄 = 下面那條沒有鑑別力)', R.esc.w >= 350, `w=${R.esc.w}`);
ok('📱e 報告頁沒有元素右緣超出父層 >6px(這條不被 overflow-x:hidden 夾死)', R.esc.list.length === 0, JSON.stringify(R.esc.list));
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
    //   💾 V76.2.7 存的地方從 localStorage 換成 IndexedDB(真因見 💾a 那組)→ 斷言跟著換,
    //     但**用意一字未改**:它只被「存起來」,⛔ 不進 `_ovDecide` 或任何計分。
    ok('🏭d1 🚨 筆記只被存起來(IndexedDB),⛔ 不進 _ovDecide / 任何計分',
       /_rpNoteSave\(sym\)[\s\S]{0,1200}idb\.put/.test(blk) && !/_ovDecide|_calcRiskScore|score \+=/.test(blk));
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
        // 🏪 V77.0.2 原本拿 5483 當「兩種都沒有」的例子 —— V76.4.0 接上上櫃產業別之後它**有**官方分類了,
        //   ⭐ 用意不變但要換做法:把**官方產業對照表也拿掉**,直接測「兩種都沒有」這個情境本身
        //   (⛔ 不依賴「剛好哪一檔沒分類」= 釘當天的資料)。
        const realInd = A._scrData.ind;
        A._scrData = Object.assign({}, A._scrData, { ind: {} });
        const g3 = A._rpPeerGroup('5483');           // 題材 + 官方產業都拿掉 → 什麼都沒有
        A._scrData = Object.assign({}, A._scrData, { ind: realInd });
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
        await A._rpNoteSave(sym);   // 💾 V76.2.7 改存 IndexedDB → 變 async,⛔ 不 await 會抓到還沒寫完
        //   ⚠️ ⛔ 這裡不可用 `innerText` —— 整個產業節裝在**收合的 `<details>`** 裡,
        //     收合時 innerText 回空字串(V75.0.3 踩過)→ 會變成假失敗
        //   🚨🚨 而且範圍要縮到**已存筆記那一塊**(`[data-rpnote]`):第一輪注入驗證抓到
        //     「外部 AI 寫的 ・本站沒有驗證」在**節標題**也有一份 → 把筆記上的標籤整條拿掉,
        //     測試照樣綠 = 假綠燈(V75.1.0 那條教訓的再犯)。
        //   📝 V76.2.0 已存的報告搬到 #rpPaste(⚡ 快速表正下方);產業節 ⑤ 只剩一行指路
        const box = document.querySelector('#rpPaste [data-rpnote]');
        const t = box ? box.innerHTML.replace(/<[^>]+>/g, ' ') : '';
        const dec = JSON.stringify(A._ovDecide(A.activeData, sym) || {}), cp = '';   // 🗑️ V76.2.5 複製功能已下架
        A._rpNoteClear(sym);
        const after = document.querySelector('#rpPaste [data-rpnote]') ? 'still-there' : '';
        return { MARK, shown: t.includes(MARK), label: /外部 AI 寫的/.test(t) && /本站沒有驗證/.test(t), inCopy: cp.includes(MARK), inDec: dec.includes(MARK), gone: !after.includes(MARK) };
    });
    ok('🏭d2 貼進去的筆記存得起來、顯示得出來', note.shown, JSON.stringify(note));
    ok('🏭d3 🚨 顯示時**一定**帶「外部 AI 寫的 ・本站沒有驗證」(注入:拿掉那行 → 這條會紅)', note.label, JSON.stringify(note));
    ok('🏭d4 🚨 筆記⛔ 不可進任何本站產物(V76.2.5 複製功能下架 → 這條由 d5 的 _ovDecide 接手守)', !note.inCopy, JSON.stringify(note));
    ok('🏭d5 🚨 筆記⛔ 不可進 _ovDecide(不參與任何買賣判斷)', !note.inDec, JSON.stringify(note));
    ok('🏭d6 一鍵清除真的清得掉', note.gone, JSON.stringify(note));
    ok('🏭d7 產業節 ⑤ 只剩一行指路、整個文件只有一個 #rpNoteIn(⛔ 兩個同 id 會互相搶)', /已搬到/.test(T) && !/<textarea/.test(R3.html[4] || '') && (await page.evaluate(() => document.querySelectorAll('#rpNoteIn').length)) === 1, T.slice(0, 120));
}
// ── 📝 V76.2.0 你貼上的 AI 報告:用使用者那份 22 節報告的**真實形狀**(鍵帽數字 1️⃣…2️⃣2️⃣、首行基準日、「8月營收…」那種會被誤認成標題的行)──
{
    const KC = n => String(n).split('').map(d => d + '\uFE0F\u20E3').join('');   // 1️⃣ / 2️⃣2️⃣
    const mkReport = (asof, px) => [
        `【國巨／2327.TW】完整投資研究報告`, `分析基準日期:${asof}`,
        `${KC(1)} 一句話投資結論`, `【國巨】目前屬於:等待買點`, `最大原因:受惠AI伺服器需求,但短期籌碼面受法人結帳賣壓影響,需待籌碼沉澱後逢低佈局。`,
        `${KC(2)} 商業模式:公司到底靠什麼賺錢?`, `全球領先的被動元件供應商;利基型產品營收佔比近八成。`,
        `${KC(3)} 產業鏈位置`, `中游製造商;議價能力強。`,
        `${KC(4)} 財報品質分析`, `營收 445 億元 毛利率 38.5% EPS 4.59 元`, `8月營收異常強勁:8月營收達163.32億元(年增51.8%),創下歷史單月新高。`, `9/4 法說會當日漲停 562 元。`,
        `${KC(5)} 盈餘預期差`, `正向預期差。`, `${KC(6)} EPS Revision`, `持續上修。`, `${KC(7)} 管理層與法說會訊號`, `樂觀。`, `${KC(8)} 產業領先指標`, `B/B Ratio。`,
        `${KC(9)} 同業比較`, `村田 / 華新科。`, `${KC(10)} 法人籌碼`, `外資近期連續賣超,9月初曾單日賣超逾1.6萬張。`, `${KC(11)} 技術面`, `跌破20日線。`,
        `${KC(12)} 事件驅動`, `9月營收公布。`, `${KC(13)} 市場可能忽略的風險`, `匯率。`, `${KC(14)} 三情境推演`, `樂觀(機率:20%) 合理股價 687 元`,
        `${KC(15)} 安全邊際`, `以中性合理價 550 元為基準。`, `${KC(16)} 分批進場策略`, `第一買點:530 ~ 540 元。`, `第二買點:500 元。`, `第三買點:450 元以下。`,
        `${KC(17)} 下跌壓力測試`, `下跌10% (約 490 元)`, `${KC(18)} Bear Case反向驗證`, `AI需求被高估。`,
        `${KC(19)} 因子評分`, `總分:77 / 100`, `${KC(20)} 最終投資判斷`, `公司品質:★★★★☆`, `目前股價:${px} 元`, `保守合理價:450 元`, `最適合策略:等拉回`,
        `${KC(21)} 未來30~90天最重要的觀察清單`, `每月營收動能。`,
        `${KC(22)} 最後200字投資筆記`, `買進理由:AI 需求爆發。主要風險:結帳賣壓。停損/基本面失效條件:毛利率跌破35%。==這一句是我自己標的==`,
    ].join('\n');
    const today = new Date();
    const fresh = mkReport(`${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`, '544');
    const stale = mkReport('2026年7月20日', '480');
    // 純函式:切節 / 基準日 / 價位抽取(⛔ 不靠畫面)
    const PF = await page.evaluate((txt) => { const A = app; const P = A._rpPasteParse(txt); return { n: P.secs.length, ns: P.secs.map(s => s.n), asof: A._rpNoteAsof(txt), s4: (P.secs.find(s => s.n === 4) || {}).body, s8: (P.secs.find(s => s.n === 8) || {}).title, prices: A._rpPastePrices(txt), hi: A._rpHi('停損 500 元 ==重點== **粗**') }; }, stale);
    ok('📝a 鍵帽數字 1️⃣…2️⃣2️⃣ 切成 22 節、編號 1~22 依序', PF.n === 22 && PF.ns.join(',') === Array.from({ length: 22 }, (_, i) => i + 1).join(','), JSON.stringify(PF.ns));
    ok('📝a2 「分析基準日期:2026年7月20日」抓成 2026-07-20', PF.asof === '2026-07-20', String(PF.asof));
    ok('📝a3 ⭐ 「8月營收達163.32億元」「9/4 法說會…」那種行**不可**被當成 §8 / §9 標題(留在 §4 裡)', /8月營收達163/.test(PF.s4 || '') && /9\/4 法說/.test(PF.s4 || '') && PF.s8 === '產業領先指標', JSON.stringify([PF.s4, PF.s8]));
    ok('📝a4 價位抽取:第一買點 530~540 / 第二買點 500 / 第三買點 450 / 保守合理價 450', PF.prices.some(x => x.label === '第一買點' && x.lo === 530 && x.hi === 540) && PF.prices.some(x => x.label === '第二買點' && x.lo === 500) && PF.prices.some(x => x.label === '保守合理價' && x.lo === 450), JSON.stringify(PF.prices));
    ok('📝a5 上色:關鍵詞琥珀 mark、==手標==、帶單位數字粗體、**粗**;⛔ mark 裡不可有紅綠 class', /<mark class="rp-hi">停損<\/mark>/.test(PF.hi) && /<mark class="rp-hi">重點<\/mark>/.test(PF.hi) && /<b class="font-mono text-gray-100">500 元<\/b>/.test(PF.hi) && /<b class="text-gray-100">粗<\/b>/.test(PF.hi) && !/text-(red|green)/.test(PF.hi), PF.hi);
    ok('📝a6 上色先跳脫:<script> 進來也只是文字', await page.evaluate(() => !/<script/.test(app._rpHi('<script>x</script> 風險'))), '');
    // 畫面:存 stale 版 → 過期提醒 / 第一眼 / 摺疊 / 對照 / 鐵線
    await render('2327');
    const V = await page.evaluate(async (txt) => {
        const A = app, sym = '2327';
        document.getElementById('rpNoteIn').value = txt; A._rpNoteSave(sym);
        await new Promise(r => setTimeout(r, 200));
        const card = document.getElementById('rpPaste'), box = card.querySelector('[data-rpnote]');
        const seen = (card.innerText || '').replace(/\s+/g, '');
        const all = card.innerHTML;
        const st = A._rpNoteStale(A._rpLast, A._rpNote(sym));
        const q11 = document.querySelector('#rpQuick [data-rpq="§2・§5~§8・§13 質化"]');
        const vs = [...document.querySelectorAll('#rpWalls [data-rpvs]')].map(d => d.getAttribute('data-rpvs'));
        const vsTxt = (document.querySelector('#rpWalls [data-rpvs-say]') || {}).textContent || '';
        const dec = JSON.stringify(A._ovDecide(A.activeData, sym) || {}), cp = '';   // 🗑️ V76.2.5 複製功能已下架
        const ord = [...document.getElementById('subContentReport').children].map(d => d.id);
        return { seen, chars: seen.length, has: { s1: /等待買點/.test(seen), s22: /買進理由/.test(seen), s5: /正向預期差/.test(seen), s4: /8月營收達163/.test(seen) },
                 secs: card.querySelectorAll('details[data-rpsec]').length, first: card.querySelectorAll('[data-rpsec-first]').length,
                 subj: [...card.querySelectorAll('details[data-rpsec="19"] summary, details[data-rpsec="20"] summary, details[data-rpsec="14"] summary')].map(e => /AI 主觀/.test(e.textContent)),
                 marks: box.querySelectorAll('mark.rp-hi').length, markRG: [...box.querySelectorAll('mark')].some(m => /text-(red|green)/.test(m.className)),
                 stale: st, staleShown: /建議重新產出/.test(seen), q11: q11 ? q11.textContent : '', vs, vsTxt,
                 rail: { copy: /等待買點|買進理由|第一買點|Bear Case|其餘 §2~§21/.test(cp), dec: /等待買點|買進理由/.test(dec) }, ord,
                 keyLv: JSON.stringify(A._keyLevels || {}).includes('530') };
    }, stale);
    // ⚠️ V77.0.8 這條原本釘 `V.first === 2`(§1 + **最後一節**)—— 那是釘**當時的實作**。
    //    使用者明示要的是「§19 觀察清單 + §20 投資筆記」,而他那份報告的**最後一節是來源表**
    //    → 規則改成「排除純來源節之後的**最後兩節**」→ 第一眼變成 3 節。
    //    ⭐ 所以斷言改成釘**用意**:結論在、最後那幾節在、§4/§5 這種中段的要在摺疊裡、
    //       而且⛔ 不可失控(第一眼節數要 ≤3)。
    ok('📝b 存完顯示在 #rpPaste;第一眼 = §1 結論 + 最後兩節(⛔ 不含中段的 §4/§5,⛔ 節數不可失控)',
    //    ⭐ 而「摺疊幾節」⛔ 不可寫死(2+20 → 3+19 只是切法變了)→ 改釘**總數沒少**:
    //       第一眼 + 摺疊 = 22 節,也就是**一節都沒有被弄丟**(這才是真正要守的事)。
       V.has.s1 && V.has.s22 && !V.has.s5 && !V.has.s4 && V.first >= 2 && V.first <= 3
       && (V.first + V.secs) === 22,
       JSON.stringify(V.has) + ` first=${V.first} secs=${V.secs} 合計=${V.first + V.secs}`);
    ok('📝b2 貼上區第一眼 ≤ 800 字(⛔ 整份 6k 全攤開就是資訊爆炸)', V.chars <= 800 && V.chars > 150, `${V.chars} 字`);
    ok('📝b3 §19 因子評分 / §20 星等 / §14 機率那三節標「AI 主觀」', V.subj.length === 3 && V.subj.every(Boolean), JSON.stringify(V.subj));
    ok('📝b4 重點詞真的被上色(≥5 個琥珀 mark),而且 ⛔ 不是紅綠', V.marks >= 5 && !V.markRG, `marks=${V.marks}`);
    ok('📝c 🔁 過期判斷(基準日 2026-07-20、報告寫 480 元):8 月營收已公布 + 第 2 季財報法定日已過 + 股價偏離 + 已經 N 天(注入:拿掉月營收那條 → 這條紅)', V.stale.stale && V.stale.reasons.some(r => /8 月營收已公布/.test(r)) && V.stale.reasons.some(r => /第 2 季財報法定公布日/.test(r)) && V.stale.reasons.some(r => /偏離報告寫的 480 元/.test(r)) && V.stale.reasons.some(r => /已經 \d+ 天/.test(r)), JSON.stringify(V.stale));
    ok('📝c2 提醒**在頁內顯示**(「🔁 建議重新產出」)+ 快速表第 11 列標「已有 … 的報告 ・🔁 需更新」', V.staleShown && /已有/.test(V.q11) && /需更新/.test(V.q11), V.q11);
    ok('📝d 🆚 AI 價位對照本站的牆:每個抽到的價位一列(第一買點 / 第二買點 / 第三買點 / 保守合理價)+「AI 說 / 本站說」並排', V.vs.length >= 4 && V.vs.includes('第一買點') && /AI 說/.test(V.vsTxt) && /本站說/.test(V.vsTxt) && /等待買點/.test(V.vsTxt), JSON.stringify(V.vs) + ' ' + V.vsTxt);
    ok('📝e 🚨 鐵線:貼上的報告⛔ 不進「📋 複製整份報告」、⛔ 不進 _ovDecide、AI 的價位⛔ 不進 _keyLevels', !V.rail.copy && !V.rail.dec && !V.keyLv, JSON.stringify(V.rail));
    ok('📝f 版面順序(V76.2.5 使用者指定):📄 短評報告 → 📝 貼上區 → ⚡ 快速表',
       V.ord.indexOf('rpImg') < V.ord.indexOf('rpPaste') && V.ord.indexOf('rpPaste') < V.ord.indexOf('rpQuick'), V.ord.join(','));
    // fresh 版(基準日 = 今天、價 544):不可亮「天數 / 偏離 / 法定日 / 除息」
    const FR = await page.evaluate(async (txt) => { const A = app; document.getElementById('rpNoteIn').value = txt; A._rpNoteSave('2327'); await new Promise(r => setTimeout(r, 150)); return A._rpNoteStale(A._rpLast, A._rpNote('2327')); }, fresh);
    ok('📝c3 fresh 版(基準日今天、價位 = 現價):⛔ 不可亮天數 / 偏離 / 財報法定日 / 除息', !FR.reasons.some(r => /已經 \d+ 天|偏離|法定|除息/.test(r)), JSON.stringify(FR));
    // 舊格式(V76.1.8 存的,沒有 asof)照讀,基準日退回貼上日
    const OLD = await page.evaluate(async () => { const A = app; localStorage.setItem('rpNote_2327', JSON.stringify({ t: '舊格式筆記 沒有節', ts: Date.now() - 3 * 864e5 })); await A.idb.del('rpNote_2327'); await A._rpNoteLoad('2327'); A._rpRefreshPaste('2327'); await new Promise(r => setTimeout(r, 100)); const c = document.getElementById('rpPaste'); return { shown: /舊格式筆記/.test(c.innerText), asof: A._rpNoteAsofOf(A._rpNote('2327')), noSec: /沒切節/.test(c.innerText) }; });
    //   💾 V76.2.7 起讀取走 IndexedDB → 這條同時也驗到「舊版 localStorage 會自動搬家」那條路徑
    ok('📝g 舊格式存檔(沒 asof)照讀:基準日退回貼上日、標「沒切節」(V76.2.7 起同時驗到自動搬家)', OLD.shown && OLD.asof && OLD.noSec, JSON.stringify(OLD));
    // 390px:存了 6k 報告之後仍不可溢出(逐元素跟父層比)
    const R8 = await render('2327');
    ok('📱4 貼了報告之後 390px 仍不可橫向捲動、沒有元素衝出父層', !R8.wide && R8.esc.list.length === 0, JSON.stringify(R8.esc.list));
    // 📐 V76.2.2 版面:已經貼過的時候,輸入框/按鈕/四段操作說明全部收摺疊 —— 第一眼要留給**報告內容**
    const LAY = await page.evaluate(async (txt) => {
        const A = app; document.getElementById('rpNoteIn').value = txt; A._rpNoteSave('2327');
        await new Promise(r => setTimeout(r, 200));
        const card = document.getElementById('rpPaste');
        const seen = (card.innerText || '').replace(/\s+/g, '');
        return { chars: seen.length, seen,
                 panel: !!card.querySelector('details[data-rppanel]'),
                 taInPanel: !!card.querySelector('details[data-rppanel] #rpNoteIn'),
                 btnInPanel: !!card.querySelector('details[data-rppanel] [data-rpcopyprompt]'),
                 //   📋 V76.2.6 使用者:「提示詞加上一鍵複製,這樣我直接貼上來比較方便」
                 //     → 那顆拉到摺疊**外面**常駐(⛔ 不可再收回去 —— 收回去要點兩下才看得到)
                 btnOutside: !!card.querySelector(':scope > div > [data-rpcopyprompt], :scope > [data-rpcopyprompt]')
                             || [...card.querySelectorAll('[data-rpcopyprompt]')].some(b => !b.closest('details')),
                 title: (card.querySelector('.font-black, [class*="font-bold"]') || {}).textContent || '',
                 howtoHidden: !/膨脹到 1 萬 6 千字元/.test(seen),
                 dateOnce: (seen.match(/基準日/g) || []).length };
    }, stale);
    // ⚠️ V77.0.8 上限 450 → 520:使用者**明示**第一眼要留兩節實質內容(§19 觀察清單 + §20 投資筆記),
    //    ⛔ 這不是「放寬斷言去遷就程式」,是**需求變了**(舊的 450 是「§1 + 一節」時代訂的)。
    //    ⭐ 而同一版把每行重複的來源引註剝掉,已經先把字數買回來一截 —— 沒有那個,兩節會爆很多。
    //    ⛔ 上限仍然要有:第一眼失控正是這張卡當初要修的病。
    ok('📐a 已貼過報告時第一眼 ≤ 520 字(⛔ 上限不可拿掉 —— 改版前 655 是操作說明佔一半)',
       LAY.chars <= 520 && LAY.chars > 120, `${LAY.chars} 字`);
    ok('📐b 輸入框 + 「Perplexity 會空白」那段說明收進摺疊(⛔ 收起來不是刪掉)', LAY.panel && LAY.taInPanel && LAY.howtoHidden, JSON.stringify(LAY).slice(0, 200));
    ok('📋b ⭐ V76.2.6「📋 複製提示詞」要在摺疊**外面**常駐(使用者:一鍵複製才方便直接貼;⛔ 不可再收回摺疊)',
       LAY.btnOutside, JSON.stringify({ outside: LAY.btnOutside, inPanel: LAY.btnInPanel }));
    ok('📐c 「基準日」整張卡只講一次(卡頭右邊那個;⛔ 同一個日期講兩次看起來像壞掉)', LAY.dateOnce === 1, `${LAY.dateOnce} 次`);
    await page.evaluate(() => app._rpNoteClear('2327'));
}
// ── 🖼️ V76.2.3 AI 圖 + 🔢 § 排序 + 🗑️ 重複入口 ──
{
    const R = await render('2327');
    // 1×1 透明 PNG(⛔ 不用外部檔 —— 測試不可依賴網路)
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const IMG = await page.evaluate(async (png) => {
        const A = app, sym = '2327';
        const blob = await (await fetch(png)).blob();
        const file = new File([blob], 'x.png', { type: 'image/png' });
        await A._rpImgStore(sym, file);
        await new Promise(r => setTimeout(r, 400));
        const box = document.getElementById('rpImg');
        //   ⚠️ 這三個要**當下**就抓 —— 下面會 `_rpImgClear`,回傳物件是最後才組的(第一版就是這樣量到 false = 假失敗)
        const shown = !!box.querySelector('img');
        //   ⚠️ V76.2.5 說明與按鈕收進 `<details>`(使用者:「開啟報告頁直接顯示圖」)→ 先展開再讀
        box.querySelectorAll('details').forEach(d => { d.open = true; });
        const label = /沒有驗證/.test(box.innerText) && /不參與任何買賣判斷/.test(box.innerText);
        const chartBtn = !!box.querySelector('[data-rpchartbtn]');
        const stored = await A.idb.get(A._rpImgKey(sym));
        const dec = JSON.stringify(A._ovDecide(A.activeData, sym) || {}), cp = '';   // 🗑️ V76.2.5 複製功能已下架
        const ord = [...document.getElementById('subContentReport').children].map(d => d.id);
        // prune 不可以把使用者存的圖清掉(它的規則是「ts 超過 7 天**或沒有 ts**」)
        await A.idb.put(A._rpImgKey(sym), Object.assign({}, stored, { ts: Date.now() - 30 * 864e5 }));
        await A.idb.prune();
        const afterPrune = await A.idb.get(A._rpImgKey(sym));
        await A._rpImgClear(sym);
        await new Promise(r => setTimeout(r, 200));
        const gone = await A.idb.get(A._rpImgKey(sym));
        return { hasImg: !!(stored && stored.d), shown, label, chartBtn,
                 prunedAway: !afterPrune, cleared: !gone,
                 inCopy: /AI 圖/.test(cp), inDec: /rpImg|AI 圖/.test(dec),
                 ord, emptyAfterClear: !document.getElementById('rpImg').querySelector('img') };
    }, PNG);
    ok('🖼️a 圖存得進 IndexedDB、畫得出來,而且一定帶「本站沒有驗證 ・⛔ 不參與任何買賣判斷」', IMG.hasImg && IMG.shown && IMG.label, JSON.stringify(IMG));
    ok('🖼️b 🚨 `idb.prune()` ⛔ 不可清掉使用者存的圖(它的規則是「ts 超過 7 天**或沒有 ts**」→ 圖一定中;注入:拿掉 rpImg_ 白名單 → 這條紅)', !IMG.prunedAway, `prunedAway=${IMG.prunedAway}`);
    ok('🖼️c 🗑️ 刪得掉(⛔ 不可只從畫面消失、資料還在)', IMG.cleared && IMG.emptyAfterClear, JSON.stringify({ cleared: IMG.cleared, empty: IMG.emptyAfterClear }));
    ok('🖼️d 🚨 鐵線:圖⛔ 不進「📋 複製整份報告」、⛔ 不進 _ovDecide', !IMG.inCopy && !IMG.inDec, JSON.stringify({ copy: IMG.inCopy, dec: IMG.inDec }));
    // ⚠️ V76.3.4 這條原本釘死「`rpImg` 必須是第 1 格」—— 但使用者要的是**一開報告頁就看到圖**,
    //   ⛔ 不是「一定要是那一張」。V76.3.4 新增了**本站自己畫的**一頁圖(`rpOwn`)並排在它前面
    //   (主結論最大:外部 AI 畫的不可壓在本站自己的東西上面),而且那張**永遠都有**
    //   (外部 AI 那張常常是「還沒存」)→ 第一眼看到圖的體驗其實更好。
    //   ⭐ 改成釘**用意**:第 1 格必須是一張圖(rpOwn / rpImg 其一),而且兩張都要排在快速表之前。
    ok('🖼️e ⭐ 使用者要「開啟報告頁直接看到圖」→ 第一格就是圖(rpLead 之後),兩張圖都在快速表之前',
       ['rpOwn', 'rpImg'].includes(IMG.ord[1])
       && IMG.ord.indexOf('rpImg') >= 0 && IMG.ord.indexOf('rpImg') < IMG.ord.indexOf('rpQuick')
       && IMG.ord.indexOf('rpOwn') < IMG.ord.indexOf('rpImg'), IMG.ord.join(','));
    // 🔢 § 排序 + 🗑️ 重複入口
    const ORD = await page.evaluate(() => {
        const q = document.getElementById('rpQuick');
        const ks = [...q.querySelectorAll('[data-rpq]')].map(d => d.getAttribute('data-rpq'));
        const no = k => { const m = String(k).match(/§\s*(\d+)/); return m ? +m[1] : 99; };
        return { ks, sorted: ks.every((k, i) => i === 0 || no(ks[i - 1]) <= no(k)),
                 askBtns: document.querySelectorAll('#subContentReport [onclick*="_reportAsk"]').length };
    });
    ok('🔢a ⚡ 快速表按 § 由小到大排(使用者:「§符號有順序,為何排序跳來跳去」)', ORD.sorted, ORD.ks.join(' / '));
    ok('🗑️a 報告頁只剩**一個** 🔎 提示詞入口(以前重點數字卡與 §20 卡各一顆、同一支函式 = 重複)', ORD.askBtns === 1, `${ORD.askBtns} 顆`);
}
// ── 💳 V76.2.2 §13 融資壓力:窗口 60 日 + 分不出上市/上櫃也要給數字 ──
{
    const M = await page.evaluate((k) => {
        const A = app, d = Array.isArray(k) ? k : (k.data || k);
        const cur = A._marginCallState(d, '2327');
        // 注入對照組:吃整條 K 線(舊行為)—— 用同一份資料、只換窗口
        const all = d.filter(r => +r.margin_balance > 0);
        const wide = A._marginCallState(all, '2327');       // slice(-60) 之後還是 60 → 用手算模擬舊版
        let wsum = 0, psum = 0;
        for (let i = 1; i < all.length; i++) { const dq = +all[i].margin_balance - +all[i - 1].margin_balance; if (!(dq > 0)) continue;
            const h = +all[i].high, l = +all[i].low, c = +all[i].close; const px = (h > 0 && l > 0 && c > 0) ? (h + l + c) / 3 : c; wsum += dq; psum += dq * px; }
        const oldCall = (psum / wsum) * 0.78, oldDist = (+all[all.length - 1].close - oldCall) / +all[all.length - 1].close * 100;
        return { cur, oldCall, oldDist, rows: all.length };
    }, FX.k2327);
    ok('💳a 🚨 融資成本只看近 60 個交易日(注入:吃整條 795 根 → 追繳線從 533 掉到 259、距現價 2% 變 52% = 永遠 safe 的常數)',
       M.cur && M.cur.win === 60 && M.cur.winTotal > 300 && Math.abs(M.cur.distPct - M.oldDist) > 20,
       JSON.stringify({ win: M.cur && M.cur.win, dist: M.cur && Math.round(M.cur.distPct), oldDist: Math.round(M.oldDist), rows: M.rows }));
    ok('💳b 分不出上市/上櫃時**照樣給數字**(⛔ 不可再顯「融資資料不足」—— 融資 795 列一列不缺,陷阱 #28)',
       M.cur && M.cur.known === true && M.cur.mktKnown === false && Number.isFinite(+M.cur.callLine), JSON.stringify(M.cur && { known: M.cur.known, mktKnown: M.cur.mktKnown, call: M.cur.callLine }));
    const R9 = await render('2327');
    ok('💳c 快速表 §13 那列有數字,而且標明「以上市六成推」(⛔ 不可靜默用假設值)',
       /§13 融資壓力[^§]*追繳壓力區/.test(R9.txt.rpQuick) && /以上市六成推/.test(R9.txt.rpQuick) && !/融資資料不足/.test(R9.txt.rpQuick), (R9.txt.rpQuick.match(/§13 融資壓力[^§]{0,120}/) || [])[0]);
    ok('💳d 離線名字表要讀第三欄(市場別)—— 下一輪採礦帶上來就自動變準',
       /type: \(Array\.isArray\(v\) && v\[2\]\)/.test(SRC) && /names\[_sy\] = \[_nm, \(industry_map or \{\}\)\.get\(_sy, ''\), _mkt\]/.test(fs.readFileSync(path.join(ROOT, 'miner.py'), 'utf8')), '');
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

    // 🗑️ V76.2.5 這一整組(🎯 結論卡的重複度 / 📍 出場價位摺疊 / 📋 複製整份報告)**隨 rpAct 一起下架** ——
    //   使用者明示「🧭 5 個面向一眼看 及 🎯 結論與操作 刪除,與總覽重複了」。
    //   ⭐ 它原本守的用意(報告頁⛔ 不可自己下指令、只能轉述)由 ③a / ③d 接手。
}

// ── 🔁 V76.0.2 報告分頁換股黑畫面(使用者截圖:009816 那頁整片黑)──────────────────────
{
    const r = await page.evaluate(async () => {
        const A = app;
        A.switchSubTab('report');
        for (const id of ['rpLead', 'rpVal', 'rpFund', 'rpInd', 'rpChip', 'rpRisk', 'rpSrc', 'rpQuick', 'rpWalls']) document.getElementById(id).innerHTML = '';
        await A.analyze('5483').catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
        const act = document.getElementById('rpQuick').innerHTML;   // 🗑️ V76.2.5 rpAct 已下架 → 改看快速表
        return { sub: A._activeSubTab, rpSym: A._rpSym, actLen: act.length, hasBadge: /結論/.test(act.replace(/<[^>]+>/g, '')), sym: A.currentSymbolId };
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
        const pending = A._rpNeedsDec, actWait = document.getElementById('rpLead').innerHTML;   // 🗑️ V76.2.5「還在算」那句住 rpLead
        A._ovDecide = real;
        try { A._renderOvCommand(A.activeData); } catch (_) {}
        await new Promise(r => setTimeout(r, 400));
        return { pending, waiting: /正在計算|還在計算/.test(actWait), after: A._rpNeedsDec, act: document.getElementById('rpQuick').innerHTML.replace(/<[^>]+>/g, ' ').slice(0, 120) };
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
    // ── ⚡ V76.1.9 版面修正(使用者:「版面修正」;選了「收說明 + 字放大」)──────────────
    const QV = await page.evaluate(() => {
        const A = app, q = document.getElementById('rpQuick');
        const seen = (q.innerText || '').replace(/\s+/g, '');          // ⭐ 關起來的 <details> innerText 看不到 → 這就是「第一眼」
        const all = q.innerHTML;
        const d = q.querySelector('details');
        return {
            chars: seen.length, seen, allHasProbe: /_probe|chips_deep|inst_leadlag/.test(all),
            seenHasProbe: /_probe|chips_deep|inst_leadlag/.test(seen),
            // 🚨 V77.1.5 整張收進 details 之後,`q.querySelector('details')` 抓到的是**外層那個**
            //   → `foldOpen` 會變成在驗外層,§q7c「說明摺疊預設收起」就失去鑑別力。
            //   ⭐ 分成兩個:`outerOpen`(整張)與 `foldOpen`(裡面那個「說明」摺疊)。
            outerOpen: d ? d.open : null,
            foldOpen: (() => { const inner = q.querySelector('details details'); return inner ? inner.open : null; })(),
            notes: q.querySelectorAll('[data-rpqnote]').length,
            rows: q.querySelectorAll('[data-rpq]').length,
            // 字級:值那行 13px、說明收進摺疊後用 11px(V74.4.6:⛔ 別再往 10px 以下調)
            small: [...q.querySelectorAll('[class*="text-["]')].map(e => {
                const m = String(e.className).match(/text-\[([\d.]+)px\]/); return m ? +m[1] : null;
            }).filter(x => x != null),
        };
    });
    // 📂 V77.1.5 **整張收起來了**(使用者:「⚡ 快速判別,以下都折疊起來,已經有個股速覽了」)
    //   → 第一眼從 557 掉到約 60 字。下界從 120 改成 20:那是**空過守門**(怕整張沒渲染),
    //   ⛔ 不是「要有多少字」;⭐ 真正的內容守門是下一條(收起來也要看得到面向數與資料日期)
    //   與 §q7b(展開之後 11 列一條不少)。
    ok('§q6 ⚡ 第一眼很短(整張已折疊;⛔ 但不可是空的)', QV.chars <= 120 && QV.chars > 20, `${QV.chars} 字`);
    ok('§q6b ⛔ 收起來也要看得到「幾個面向」與**資料日期**(資料日期鐵則:收起來就看不到日期 = 等於沒標)',
       /\d+個面向/.test(QV.seen) && /📅/.test(QV.seen) && /\d\d\/\d\d/.test(QV.seen), QV.seen.slice(0, 140));
    ok('§q7 ⭐ 第一眼⛔ 不可出現英文探針檔名(禁在 UI 暴露內部函式名)', !QV.seenHasProbe, (QV.seen.match(/.{0,20}_probe.{0,10}/) || [])[0] || '');
    ok('§q7b 🚨 但那些說明**還在**(收起來 ≠ 刪掉;11 條一條不少)', QV.allHasProbe && QV.notes === QV.rows && QV.rows === 11, JSON.stringify({ notes: QV.notes, rows: QV.rows }));
    ok('§q7c 說明摺疊**預設收起**(⛔ 展開就等於沒瘦)', QV.foldOpen === false, String(QV.foldOpen));
    ok('§q7d 整張也是預設收起(V77.1.5 使用者要求)', QV.outerOpen === false, String(QV.outerOpen));
    ok('§q8 ⛔ 快速表裡不可再有 10px 以下的字(V74.4.6:手機上看不清楚)', QV.small.every(x => x >= 10), JSON.stringify([...new Set(QV.small)].sort((a, b) => a - b)));
    // 📍 位階只有一個來源:總覽徽章 vs 報告頁 §11 必須是同一個數字
    const POS = await page.evaluate(() => {
        const A = app, b = A._basePos(A.rawDailyData), r = A._rpPricePos(A.rawDailyData);
        return { badge: b && +b.pos.toFixed(4), rep: r && +r.pos.toFixed(4), shown: Math.round((b || {}).pos) };
    });
    ok('§q9 ⭐⭐ 總覽基期徽章與報告頁 §11 價格位階是**同一個數字**(注入:讓 _rpPricePos 自己用收盤算 → 必紅)',
       POS.badge != null && POS.badge === POS.rep, JSON.stringify(POS));
    // 🧾 單位:法人連 N 賣的張數不可是「股」
    const UNIT = await page.evaluate(() => {
        const a = app.rawDailyData.slice(-3);
        const sum = a.reduce((s, r) => s + (+r.foreign_net || 0) + (+r.trust_net || 0) + (+r.dealer_net || 0), 0);
        return { rawShares: Math.round(sum), lots: Math.round(sum / 1000), lotTxt: [app._lotTxt(2000), app._lotTxt(2350), app._lotTxt(0)] };
    });
    ok('§q10 🚨 `instSum3` 在源頭就換算成張(原始碼斷言;⛔ 不是只改顯示字串 —— 它還餵給 chipSafety)',
       /const instSum3 = [\s\S]{0,120}?\/ 1000;/.test(SRC) && /法人連3賣 \$\{Math\.round\(Math\.abs\(instSum3\)\)\.toLocaleString\(\)\} 張/.test(strip(SRC))
       && UNIT.lots === Math.round(UNIT.rawShares / 1000), JSON.stringify({ rawShares: UNIT.rawShares, lots: UNIT.lots }));
    ok('§q10b `_lotTxt`:整張講「張」、零股直接講「股」(⛔ 不印 2.35 張)',
       UNIT.lotTxt[0] === '2 張' && UNIT.lotTxt[1] === '2,350 股' && UNIT.lotTxt[2] === '0 股', JSON.stringify(UNIT.lotTxt));
    // 📐 寫法守門:真幾何在沙箱量不到(沒有 Tailwind)→ 只能釘寫法(同 test_gauge ⑯s)
    {
        const qa2 = SRC.indexOf('    _rpQuickHtml(C) {'), qb2 = SRC.indexOf('    // 🧮 §14 敏感度');
        const wa2 = SRC.indexOf('    _rpWallsHtml(C) {'), wb2 = SRC.indexOf('    // 🗓️ §12 事件');
        const seg = SRC.slice(qa2, qb2) + SRC.slice(wa2, wb2);
        ok('§g1 📐 快速表/價格牆的版面幾何走 inline style(⛔ 不靠 Tailwind class —— 沙箱沒有 Tailwind,靠 class 量到的是假的)',
           /display:flex;align-items:baseline;gap:8px/.test(seg) && /flex:1 1 0;min-width:0/.test(seg), '');
        ok('§g2 🚨 ⛔ 不可用 `grid-cols-[1fr_auto]`(**任意值** `1fr` = `minmax(auto,1fr)`,不是具名 class 的 `minmax(0,1fr)` → 左欄會被撐開)',
           !/grid-cols-\[1fr_auto\]/.test(strip(seg)) && /grid-template-columns:minmax\(0,1fr\) auto/.test(seg), '');
    }
    ok('§q5 六個節標題帶 § 編號(§4~§6 / §10 / §12… / §14・§15 / §2・§3… / §0)', ['§4~§6', '§10', '§12・§13・§18・§19', '§14・§15', '§2・§3・§7~§9', '§0'].every(k => R5.txt.rpFund.includes(k) || R5.txt.rpChip.includes(k) || R5.txt.rpRisk.includes(k) || R5.txt.rpVal.includes(k) || R5.txt.rpInd.includes(k) || R5.txt.rpSrc.includes(k)), '');
    // 🔠 V76.2.5 使用者:「總量 3.4萬張 及 09/11 那兩行,我用特大字體版面會超過,單獨調整這 2 行就好」。
    //   實測 390px:medium 12px→寬 145px(右緣還有 73px 餘裕);xl 15px→寬 181px、右緣只剩 12px。
    //   ⛔ 它是 `whitespace-nowrap` + `flex-shrink-0`(數字不可斷行)→ 救不了換行,只能不跟著放大。
    //   ⭐ 注入:把那兩條 CSS 拿掉 → 這條會紅。
    {
        const FS = await page.evaluate(async () => {
            const A = app, out = {};
            for (const f of ['medium', 'xl']) {
                try { A.setFontSize(f); } catch (_) {}
                await new Promise(r => setTimeout(r, 250));
                const v = document.getElementById('quoteVolInfo');
                const d = v && v.querySelector('.text-\\[9px\\]');
                out[f] = { fs: v ? parseFloat(getComputedStyle(v).fontSize) : null,
                           sub: d ? parseFloat(getComputedStyle(d).fontSize) : null };
            }
            try { A.setFontSize('medium'); } catch (_) {}
            return out;
        });
        ok('🔠v1 ⭐ 個股頁標題列那兩行(📊 總量 / 📅 資料日期)在「特大字」時**不可以跟著放大**',
           FS.xl.fs === FS.medium.fs && FS.xl.fs > 0, JSON.stringify(FS));
        ok('🔠v2 ⛔ 只鎖那兩行 —— 別處照樣要跟著放大(拿報告頁的 13px 當對照組)',
           await page.evaluate(async () => {
               const A = app, mk = () => { const d = document.createElement('div'); d.className = 'text-[13px]'; d.textContent = 'x';
                   document.body.appendChild(d); const n = parseFloat(getComputedStyle(d).fontSize); d.remove(); return n; };
               try { A.setFontSize('medium'); } catch (_) {} await new Promise(r => setTimeout(r, 200)); const m = mk();
               try { A.setFontSize('xl'); } catch (_) {} await new Promise(r => setTimeout(r, 200)); const x = mk();
               try { A.setFontSize('medium'); } catch (_) {} await new Promise(r => setTimeout(r, 200));
               return x > m;
           }));
    }
    ok('§a1 ⛔ 整頁不給 ★ 評等(V76.2.5 結論卡下架後,這條改掃整個報告頁)',
       !/★{2,}/.test(Object.values(R5.txt).join(' ')), Object.values(R5.txt).join(' ').slice(0, 200));
    // 🧱 §11・§17
    await settle(page);   // ⏳ §w3 要比「畫面上那段」跟「現在再算一次」→ 不站定就會隨機紅
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
    // 📈 V77.0.9 前面補了「往上要看的兩個價位」(轉強/追買)→ 件數會變,⛔ 所以這裡**不釘數字**,
    //   改釘**用意**:每一件都在、而且標題的數字要跟實際列數一致(⛔ 不可寫死;`test_ovrarity` ⓓ 另有專測)。
    ok('§e4 §21 觀察清單:出場線/月營收/財報/法人/族群五件都在,且件數 ≥5',
       E.watch >= 5 && /§21/.test(E.t) && /出場線/.test(E.t) && /月營收/.test(E.t) && /財報/.test(E.t) && /法人/.test(E.t) && /族群/.test(E.t), String(E.watch));
    ok('§e4b §21 標題的件數 = 實際列數(⛔ 不可寫死)',
       new RegExp(`§21 接下來 30~90 天要看的 ${E.watch} 件事`).test(E.t), `watch=${E.watch}`);
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
        ok('§f5 §4 誠實寫「應收帳款天數本站沒有」、§5/§6 寫「本站沒有」分析師共識(⛔ 不編)', /應收帳款天數(本站)?沒有/.test(FD.t) && /沒有免費的分析師共識/.test(FD.t), '');
        ok('§f6 上市股同業表多了「淨值比」欄', FD.pb, '');
        ok('📱3 國巨那頁 390px 仍不可橫向溢出', !R6.wide);
        // 累計 vs 單季:切片裡的 cum_fixed 要含 ocf(注入:切片器不還原 → 這裡的 fixture 就會少這個欄)
        ok('§f7 切片 fixture 標示現金流量表已從累計還原成單季(cum_fixed 含 ocf/capex)', FIN_SLICE['2327'].cum_fixed.includes('ocf') && FIN_SLICE['2327'].cum_fixed.includes('capex'), JSON.stringify(FIN_SLICE['2327'].cum_fixed));
    // 🚨 V76.2.0 面額變更:新切片 2025Q3 起 nm null + nm_error;畫面⛔ 不可再印 5.3% / 4.9%
    ok('§f9 新切片:國巨 2025Q3 起淨利率 null、par_chg_q = 2025-09-30;畫面寫「疑似面額變更」而不是 5.3%', FIN_SLICE['2327'].par_chg_q === '2025-09-30' && /疑似面額變更/.test(R6.txt.rpFund) && !/淨利率\(最新季\)\s*5\.3%/.test(R6.txt.rpFund), R6.txt.rpFund.slice(0, 300));
    // 🚨 gh-pages 上的**舊切片**(V76.1.8 產的:沒有 par_chg_q、nm 還是 5.3)→ 前端那道雙保險要自己判出來(注入:拿掉 _rpFinParQ 的迴圈 → 紅)
    const OLDF = await page.evaluate((F) => { const A = app; const G = JSON.parse(JSON.stringify(F)); delete G.par_chg_q; G.q.forEach(r => { delete r.nm_error; delete r.ni_src; if (r.p >= '2025-09-30') r.nm = 5.3; }); G.roe4 = 4.3;
        const html = A._rpFinDeepHtml(Object.assign({}, A._rpLast, { fin: G })); return { parQ: A._rpFinParQ(G), txt: html.replace(/<[^>]+>/g, ' ') }; }, FIN_SLICE['2327']);
    ok('§f10 ⭐ 舊切片(沒 par_chg_q、nm=5.3、roe4=4.3)→ 前端自己判出 2025-09-30,淨利率/ROE 都不印那個數字', OLDF.parQ === '2025-09-30' && /疑似面額變更/.test(OLDF.txt) && !/5\.3%/.test(OLDF.txt) && !/4\.3%/.test(OLDF.txt), OLDF.txt.slice(0, 300));
    } else console.log('⏭️ 沒有 fin_deep 分支/檔 → §f1~§f7 跳過(git show origin/fin_deep:fin_deep/fin_deep.json > fin_deep/fin_deep.json)');
    // 沒切片的股(5483 不在 fixture)→ 誠實「本站尚未切出」+ 快速表 ⛔
    const R7 = await render('5483');
    ok('§f8 沒有切片的股:§4 寫「本站尚未切出這檔的財報三表」、快速表那列標 ⛔ 本站沒有', /尚未切出/.test(R7.txt.rpFund) && /§4 財報品質[^§]*⛔ 本站沒有/.test(R7.txt.rpQuick), R7.txt.rpQuick.slice(0, 200));
    {
        const ordF = await page.evaluate(() => [...document.getElementById('subContentReport').children].map(d => d.id).filter(Boolean));
        const seq = ['rpImg', 'rpPaste', 'rpQuick', 'rpInd', 'rpFund', 'rpChip', 'rpWalls', 'rpRisk', 'rpVal', 'rpSrc'];
        ok('📄a3 版面順序(V76.2.5):📄 短評 → 📝 貼上 → ⚡ 快速表 → 各節照 § 由小到大 → §0 來源排最後',
           seq.every((id, i) => i === 0 || ordF.indexOf(seq[i - 1]) < ordF.indexOf(id)), ordF.join(','));

        // ═══ 🔁 V76.3.0 展開狀態要撐過重繪(使用者:「📖 完整報告展開會一直跳掉」)═══
        //   ⛔ 這是 `_rpSet` 那個**唯一入口**的行為 → 直接對它下手,⛔ 不挑某一張卡驗
        const R6 = await page.evaluate(() => {
            const A = app, id = 'rpRisk';
            const el = document.getElementById(id);
            const out = {};
            // ① 使用者**自己點**開一節 → 重繪之後要還在
            const d0 = el.querySelector('details[data-dk]');
            out.hasDk = !!d0;
            if (d0) {
                out.k = d0.getAttribute('data-dk');
                // 🚨 這一節**有預警時會自動展開** → 直接判 `if (!open) click()` 等於沒點,
                //    `data-utog` 不會被標記 → 🔁b 量到的是「自動展開沒被記住」(對的行為)而不是它要驗的事。
                //    ⭐ 一律**點兩下**(關→開),確定是「使用者自己開的」。
                const sm = d0.querySelector('summary');
                if (d0.open) sm.click();
                sm.click();
                out.utog = d0.dataset.utog;
                out.openedByClick = d0.open;
                // 🚨 Chrome 把布林屬性序列化成 `open=""` → 只比對 ` open` 的正則**吃不到**,
                //    那次「重繪成全部收起來」根本沒收起來 → 🔁b 會變成**假綠燈**(第一版就是這樣,注入驗證才抓到)。
                const closed = el.innerHTML.replace(/\sopen(="")?(?=[\s>])/g, '');
                out.reallyClosed = !/\sopen(="")?[\s>]/.test(closed);     // 🚧 空過守門:確認真的關掉了才算數
                A._rpSet(id, closed, A.currentSymbolId);
                const d1 = document.getElementById(id).querySelector(`details[data-dk="${out.k}"]`);
                out.survives = !!(d1 && d1.open);
            }
            // ② ⭐ 決定性對照:**程式自動展開**的(沒被點過)⛔ 不可被記住
            const wrap = document.createElement('div'); wrap.id = 'rpTmpDk'; document.body.appendChild(wrap);
            A._rpSet('rpTmpDk', '<details data-dk="auto" open><summary>x</summary>y</details>');
            A._rpSet('rpTmpDk', '<details data-dk="auto"><summary>x</summary>y</details>');
            out.autoNotSticky = !wrap.querySelector('details').open;
            wrap.remove();
            // ③ 捲動位置:卡片在畫面上方時,高度變化⛔ 不可把人推走
            out.hasScrollFix = /window\.scrollTo\(0, Math\.max\(0, sy \+ dh\)\)/.test(A._rpSet.toString());
            out.onlyUtog = /data-utog="1"/.test(A._rpSet.toString());
            return out;
        });
        ok('🔁a 報告頁的 details 都有穩定鍵 data-dk(⛔ 不可用 DOM 順序當鍵)', R6.hasDk, JSON.stringify(R6));
        ok('🔁b0 🚧 空過守門:那次重繪真的把全部收起來了 + 真的是「使用者點開的」(⛔ 否則 🔁b 是假綠燈)',
           R6.reallyClosed && R6.utog === '1' && R6.openedByClick, JSON.stringify(R6));
        ok('🔁b ⭐ 使用者**點開**的那一節,重繪之後仍然是開的(使用者原話:「展開會一直跳掉」)',
           R6.openedByClick && R6.survives, JSON.stringify(R6));
        ok('🔁c ⭐⭐ 決定性對照:**程式自動展開**的(沒被點過)⛔ 不可被記住 —— 否則會蓋掉「有預警才展開」那條規則',
           R6.autoNotSticky, JSON.stringify(R6));
        ok('🔁d 只記 data-utog(使用者點過的)⛔ 不是所有 open 的', R6.onlyUtog);
        ok('🔁e 卡片在畫面上方時要補回捲動差(⛔ 不讓高度變化把人推走)', R6.hasScrollFix);
    }
}

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ test_report 全過');
process.exit(fails.length ? 1 : 0);
