#!/usr/bin/env node
/**
 * 🚨 V77.1.4 「同一畫面兩個數字 / 文案跟實測打架」—— 測試(使用者截圖 6894 衛司特)
 *
 *   A 今日漲跌幅     頂端 −3.16%(報價商前收 364)vs 海報 −4.2%(K線前一根 368)
 *   B 緊急警示       拿行事曆下「部位先收、別裸壓」(⛔ 實測 37 種行事曆日方向 0 個成立)
 *   C 毛利率/自由現金流  同一張卡兩個值、而且沒標期間(自由現金流那組是 V77.1.3 自己造成的)
 *   D 產業別         印代碼「35」,而同一張卡第 3 行印得出「綠能環保」
 *   E 全市場統計     寫「今天」,其實是 09/14 的掃描結果,而且整句沒標日期
 *   F 技術 98 分     是 clamp 的天花板,畫面上沒說(V77.1.0 那條規則只接了盤前體檢)
 *
 * ⛔ 每一條先想「注入什麼它會叫」:
 *   ⓐ 把 ctx 的前收改回 data[n-1].close ・ⓑ 把「部位先收、別裸壓」寫回去
 *   ⓒ 趨勢那條改回「自由現金流」/ 毛利率改回讀 C.gm ・ⓓ ind 改回吃 sector.name 的純數字
 *   ⓔ 把日期拿掉改寫「今天」・ⓕ 把 raw/clamped 拿掉
 *
 * 測資:本機 data/6894(沒有就誠實 exit 1,⛔ 不跑假測試)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// ⚠️ 原始碼斷言一律**先剝掉註解**再比 —— 本 repo 已經被「自己寫的註解救活斷言」騙過 6 次
const strip = x => x.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 320)}`}`); if (!c) fails.push(n); };
const seg = (a, b) => { const i = SRC.indexOf(a); const j = SRC.indexOf(b, i + 1); return (i < 0 || j < 0) ? '' : strip(SRC.slice(i, j)); };
const SYM = '6894';
if (!fs.existsSync(path.join(ROOT, 'data', `${SYM}.json`))) { console.log(`❌ 沒有 data/${SYM}.json(跑 bash scripts/fetch_testdata.sh)`); process.exit(1); }

// ─────────────────────────── 靜態 ───────────────────────────
{   // ⓐs 報告頁組 ctx 的前收要走報價商,⛔ 不可只拿 K 線前一根
    const s = seg('    async renderReportTab(sym) {', '        this._rpLast = ctx;');
    ok('ⓐs 空過守門:抓得到報告頁組 ctx 那一段', s.length > 2000, `len=${s.length}`);
    ok('ⓐs2 今日漲跌幅的前收優先用報價商 `_fuglePrevClose`(⛔ 不可只拿 data[n-1].close)',
       /_fuglePrevClose/.test(s) && /const chg = \(pC > 0 && pP > 0\)/.test(s)
       && !/const pP = \+prev\.close \|\| 0/.test(s), s.match(/const pP[^\n]*/)?.[0] || '');
    ok('ⓐs3 ctx 要把來源與前收一起帶出去(⛔ 只給結果查不出是哪一邊算的)',
       /chgSrc/.test(s) && /prevC: pP/.test(seg('        const ctx = { sym,', '        this._rpLast = ctx;')), '');
}
{   // ⓑs 緊急警示⛔ 不可因為行事曆給部位/方向指令
    const s = seg('        const emg = [];\n        const emgNote = [];', '        const nCol = dims.length;');
    ok('ⓑs 空過守門:抓得到緊急警示那一段', s.length > 800, `len=${s.length}`);
    // ⚠️ 斷言範圍只框「行事曆那一則」—— 同一段裡的 `riskS >= 68`(本站自己的風險指數)與
    //   「反彈減碼」(你自己的停損紀律)**是合法的**,⛔ 不可因為含「減碼」兩個字就一起擋掉。
    const one = (s.match(/_hasImminentMacroEvent\(\)\)[\s\S]{0,400}?\);/) || [''])[0];
    ok('ⓑs2a 空過守門:抓得到行事曆那一則的 push', /重大事件迫近/.test(one), one.slice(0, 120));
    const bad = (one.match(/部位先收|裸壓|減碼|出清|留倉|加碼|偏多|偏空/g) || []);
    ok('ⓑs2 行事曆那一則⛔ 不可出現部位/方向指令(實測行事曆方向 0 個成立)', bad.length === 0, bad.join(','));
    ok('ⓑs3 行事曆那則⛔ 不可放在 `emg` 紅框(它不是今天已經發生的事)→ 要走 `emgNote`',
       /emgNote\.push\('📅/.test(s) && !/emg\.push\('📅/.test(s), '');
    ok('ⓑs4 那則要明講「本站不預設漲跌」', /不預設漲跌/.test(s) && /方向 0 個成立/.test(s), '');
}
{   // ⓒs 毛利率 / 自由現金流
    const g = seg('    _gmLatest(C) {', '    _rpIndustryFacts(sym) {');
    ok('ⓒs 有唯一那份 `_gmLatest`,且以財報切片為主、採礦快取為備援',
       /C\.fin\.q/.test(g) && /src: 'fin'/.test(g) && /src: 'cache'/.test(g) && /p: String/.test(g), '');
    // 顯示端⛔ 不可再自己讀 C.gm(那是採礦快取,期間跟財報不同 → 同名不同值)
    // ⛔ 範圍要**扣掉 `_gmLatest` 自己**(它就是那個唯一讀 `C.gm` 當備援的地方);
    //   ⭐ 但**一定要含 `_reportFacts`** —— 那份是餵給外部 AI 的提示詞,漏掉就是陷阱 #37 的第二個出口。
    const rp = seg('    async renderReportTab(sym) {', '    _rpIndustryFacts(sym) {').replace(g, '');
    ok('ⓒs2a 空過守門:範圍要含餵給外部 AI 的 `_reportFacts`', /- 產業別/.test(rp) && /最新月營收/.test(rp), '');
    const raw = (rp.match(/[^_a-zA-Z0-9.]C\.gm\b/g) || []);
    ok('ⓒs2 顯示端與提示詞⛔ 不可再直接讀 `C.gm`(一律走 `_gmLatest`)', raw.length === 0, `還有 ${raw.length} 處`);
    const cv = seg("            card('基本面'", "            card('籌碼'");
    ok('ⓒs3 空過守門:抓得到海報的基本面卡', cv.length > 600, `len=${cv.length}`);
    ok('ⓒs4 海報的毛利率也走 `_gmLatest`(⛔ 不可讀 C.gm)', /_gmLatest\(C\)/.test(cv) && !/C\.gm/.test(cv), '');
    // 自由現金流:同一張卡有「近4季」與「單季」兩個,⛔ 名字不可一樣
    ok('ⓒs5 海報的自由現金流兩格要分得出來(近4季 vs 單季)',
       /自由現金流近4季/.test(cv) && /'自由現金流\(單季\)'/.test(cv), '');
    const tr = seg('    _rpTrendHtml(C) {', '    _rpHiBold(t)');
    ok('ⓒs6 報告頁 §4 的趨勢那條也要標「單季」(⛔ 兩處不可一個標一個不標)',
       /自由現金流\(單季\)/.test(tr), '');
}
{   // ⓓs 產業別
    const s = seg('    _rpIndustryFacts(sym) {', '    _rpNextLines(sym) {');
    ok('ⓓs 空過守門:抓得到 `_rpIndustryFacts`', s.length > 400, `len=${s.length}`);
    ok('ⓓs2 產業別⛔ 不可把純數字代碼直接印出去(要擋掉)', /!\/\^\\d\+\$\/\.test\(_sec\)/.test(s), '');
    ok('ⓓs3 先用 screener 的中文產業名(`ind0`),它才是族群名次那行用的同一份',
       /const ind = ind0 \? ind0/.test(s), '');
    ok('ⓓs4 都沒有時要誠實說「本站沒有」(⛔ 不可留空白或印代碼)', /本站沒有它的官方產業分類/.test(s), '');
}
{   // ⓔs 全市場統計要標日期
    const s = seg('    _ovRarityNote() {', '    _ovDecide(data, sym) {');
    ok('ⓔs 那句要帶產物的 `data_date` 且走既有的 `_dW`(⛔ 禁止自己拼日期字串)',
       /data_date/.test(s) && /this\._dW\(dd\)/.test(s), '');
    ok('ⓔs2 ⛔ 不可再寫「今天」(產物實測比行情舊一天)', !/今天/.test(s), '');
}
{   // ⓕs 技術分夾到要說出來
    const s = seg('            this._lastTechScore = {', '\n');
    ok('ⓕs 技術分要把「沒夾過的原始分」跟「有沒有夾到」一起存下來',
       /raw: _tRaw/.test(s) && /clamped: _tRaw !== _tScore/.test(s), s.slice(0, 200));
    const d = seg("        if (okScore(this._lastTechScore)) dims.push(", '\n        if (okScore(this._lastChipScore))');
    ok('ⓕs2 那兩個欄位要傳進儀表列的 dims', /raw: this\._lastTechScore\.raw/.test(d) && /clamped: !!this\._lastTechScore\.clamped/.test(d), '');
    const g = seg('    _gaugeStripHtml(sym) {', '        if (!rows) return');
    ok('ⓕs3 夾到時那一列要講出來(含原始分)', /d\.clamped/.test(g) && /已到量表上限/.test(g) && /Math\.round\(\+d\.raw\)/.test(g), '');
}

// ─────────────────────────── 實跑 ───────────────────────────
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => { const m = String(e); if (!/Cache|file' is unsupported/.test(m)) errs.push(m.slice(0, 160)); });
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 25000 });
await page.waitForTimeout(2500);
await page.evaluate(s => { app.switchAppTab('diag'); return app.analyze(s); }, SYM);
await page.waitForTimeout(11000);
await page.evaluate(() => { app.switchSubTab && app.switchSubTab('report'); });
await page.waitForTimeout(2500);

// ⓐ2 頂端與報告頁**同一個前收**(⭐ 決定性對照:改報價商前收 → 兩邊一起變)
{
    const r = await page.evaluate(async () => {
        const o = { ref0: app._liveRefClose, prev0: app._rpLast ? app._rpLast.prevC : null, chg0: app._rpLast ? app._rpLast.chg : null };
        app._fuglePrevClose = 999;                       // ← 注入一個不可能巧合的前收
        // ⚠️ `renderReportTab` 是 **async** —— 不 await 的話讀到的還是上一輪的 `_rpLast`(注入等於沒生效)
        await app.renderReportTab(app.currentSymbolId);
        o.prev1 = app._rpLast ? app._rpLast.prevC : null;
        o.chg1 = app._rpLast ? app._rpLast.chg : null;
        o.pC = app._rpLast ? app._rpLast.pC : null;
        app._fuglePrevClose = null; await app.renderReportTab(app.currentSymbolId);
        return o;
    });
    ok('ⓐ2 空過守門:報告頁真的有算出前收與今日漲跌幅', r.prev0 > 0 && Number.isFinite(r.chg0), JSON.stringify(r));
    ok('ⓐ2b 沒有即時報價時,兩條路的前收一致(頂端 `_liveRefClose` == 報告 `prevC`)',
       r.ref0 > 0 && Math.abs(+r.ref0 - +r.prev0) < 0.005, `頂端 ${r.ref0} vs 報告 ${r.prev0}`);
    ok('ⓐ2c ⭐ 決定性對照:改掉報價商前收 → 報告頁的前收與漲跌幅要跟著變(⛔ 證明不是各算各的)',
       r.prev1 === 999 && Number.isFinite(r.chg1) && Math.abs(r.chg1 - ((r.pC - 999) / 999 * 100)) < 0.01,
       JSON.stringify(r));
}

// ⓑ2 行事曆那則:⛔ 不可進紅框 `emg`,而且文字只講波動
{
    const r = await page.evaluate(() => {
        const keep = app._hasImminentMacroEvent;
        app._hasImminentMacroEvent = () => true;         // 強迫觸發那一則
        // ⛔ 這裡刻意走 `_regaugeStrip` 的同一條路(用存下來的參數重算),⛔ 不另寫一份呼叫
        const a = app._gaugeArgs;
        if (a && String(a.sym) === String(app.currentSymbolId)) app._overallGaugeHtml(a.ind, a.last, a.C, a.trend, a.big, a.cost);
        const html = app._ovEmergencyBar();
        const emg = (app._lastGauge && Array.isArray(app._lastGauge.emg)) ? app._lastGauge.emg.slice() : null;
        app._hasImminentMacroEvent = keep;
        const d = document.createElement('div'); d.innerHTML = html;
        const note = d.querySelector('[data-emgnote]');
        const red = d.querySelector('.animate-pulse');
        return { emg, noteTxt: note ? (note.innerText || '').replace(/\s+/g, ' ') : null,
                 redTxt: red ? (red.innerText || '').replace(/\s+/g, ' ') : '' };
    });
    ok('ⓑ2 空過守門:那一則真的渲染得出來(而且是在「只講波動」那一區)',
       !!r.noteTxt && /重大事件迫近/.test(r.noteTxt), JSON.stringify(r).slice(0, 220));
    ok('ⓑ2b 畫面上⛔ 不可出現部位/方向指令', !!r.noteTxt && !/部位先收|裸壓|減碼|出清|留倉/.test(r.noteTxt), String(r.noteTxt).slice(0, 200));
    ok('ⓑ2c 它只講「波動會變大」+「本站不預設漲跌」', !!r.noteTxt && /波動會變大/.test(r.noteTxt) && /不預設漲跌/.test(r.noteTxt), String(r.noteTxt).slice(0, 200));
    ok('ⓑ2d ⭐ 決定性:⛔ 不可進 `_lastGauge.emg`,也⛔ 不可出現在 🚨 紅框裡',
       Array.isArray(r.emg) && !r.emg.some(x => /重大事件迫近/.test(x)) && !/重大事件迫近/.test(r.redTxt),
       JSON.stringify(r.emg));
}

// ⓒ2 同一張海報卡⛔ 不可有兩個同名不同值的標籤
{
    const r = await page.evaluate(() => {
        const o = app._rpOwnFacts ? null : null;
        const lab = [];
        try {
            const C = app._rpLast;
            const G = app._gmLatest(C);
            return { g: G, fcf4: (C.fin && C.fin.fcf4 != null) ? C.fin.fcf4 : null,
                     tr: (() => { try { const T = app._finTrend(C); return T ? T.n : 0; } catch (_) { return 0; } })() };
        } catch (e) { return { err: String(e) }; }
    });
    ok('ⓒ2 `_gmLatest` 對真實資料回得出值,而且**一定帶季別**', r.g && Number.isFinite(+r.g.v) && !!r.g.p, JSON.stringify(r.g));
    const snap = await page.evaluate(() => new Promise(res => {
        // 海報只畫在 canvas 上 → 改讀它畫進去的那份標籤清單(`_rpOwnDbg`)
        app._rpDrawOwn(app.currentSymbolId);
        setTimeout(() => res(app._rpOwnDbg || null), 2000);
    }));
    if (!snap || !Array.isArray(snap.labels)) {
        ok('ⓒ2b 海報要把畫出來的標籤存進 `_rpOwnDbg.labels`(⛔ 沒有就查不出同名不同值)', false, JSON.stringify(snap).slice(0, 200));
    } else {
        const m = new Map();
        for (const [k, v] of snap.labels) { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(String(v)); }
        const dup = [...m].filter(([k, s]) => s.size > 1).map(([k, s]) => `${k}=${[...s].join('/')}`);
        ok('ⓒ2b 空過守門:海報真的畫出一批標籤(含 12 季趨勢那幾條)', snap.labels.length >= 14, `n=${snap.labels.length}`);
        ok('ⓒ2c 同一張海報⛔ 不可有兩個同名不同值的標籤', dup.length === 0, dup.join(' | '));
        // ⭐⭐ 真正的病是**前綴撞名**:「自由現金流」與「自由現金流近4季」不是同一個字串,
        //   但使用者讀起來就是「兩個自由現金流,值還不一樣」。
        //   ⚠️ 值**相同**時不算(如趨勢「毛利率 37.1%」vs 格子「毛利率(2026-06 季) 37.1%」——
        //   那是同一件事的兩種寫法);任一邊是「—」也不比(資料沒有 ≠ 打架)。
        const L = snap.labels.filter(([, v]) => v && v !== '—');
        const clash = [];
        for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
            const [a, av] = L[i], [b, bv] = L[j];
            if (a === b) continue;
            if ((a.startsWith(b) || b.startsWith(a)) && av !== bv) clash.push(`${a}=${av} vs ${b}=${bv}`);
        }
        ok('ⓒ2d ⭐ 前綴撞名也不行(「自由現金流」vs「自由現金流近4季」值還不一樣)', clash.length === 0, clash.join(' | '));
    }
}

// ⓓ2 產業別⛔ 不可是純數字代碼
{
    const r = await page.evaluate(sym => {
        const a = app._rpIndustryFacts(sym);
        const keep = app._scrData;
        app._scrData = null;                                   // ← 注入:screener 沒載到,只剩 sector 代碼
        const b = app._rpIndustryFacts(sym);
        app._scrData = keep;
        return { a, b, facts: (app._reportFacts ? app._reportFacts(sym) : '').slice(0, 4000) };
    }, SYM);
    ok('ⓓ2 產業別⛔ 不可是純數字代碼', !!r.a.ind && !/^\d+$/.test(String(r.a.ind)), JSON.stringify(r.a.ind));
    ok('ⓓ2b ⭐ 決定性對照:連 screener 都沒載到時也⛔ 不可退化成代碼', !/^\d+$/.test(String(r.b.ind)), JSON.stringify(r.b.ind));
    ok('ⓓ2c 餵給外部 AI 的提示詞裡也⛔ 不可出現「產業別:數字」',
       !/產業別:\s*\d+\s/.test(r.facts), (r.facts.match(/產業別:[^\n・]*/) || [''])[0]);
}

// ⓔ2 全市場統計要帶日期
{
    const r = await page.evaluate(() => {
        const keepP = app._pbEdge, keepT = app._todaySig;
        app._pbEdge = { scanned: 2320, picks_syms: 6, data_date: '2026-09-14' };
        app._todaySig = { scanned: 2320, bull_syms: 30, data_date: '2026-09-14' };
        const withD = app._ovRarityNote();
        app._pbEdge = { scanned: 2320, picks_syms: 6 };        // ← 產物沒有日期時
        app._todaySig = { scanned: 2320, bull_syms: 30 };
        const noD = app._ovRarityNote();
        app._pbEdge = keepP; app._todaySig = keepT;
        return { withD, noD };
    });
    ok('ⓔ2 有 data_date 時整句要帶日期', /09\/14/.test(r.withD), r.withD.slice(0, 160));
    ok('ⓔ2b ⛔ 不可再出現「今天」兩個字', !/今天/.test(r.withD) && !/今天/.test(r.noD), `${r.withD} | ${r.noD}`);
    ok('ⓔ2c 產物沒有日期時⛔ 不謊報日期(但數字照給)', !/\d\d\/\d\d/.test(r.noD) && /2,320/.test(r.noD), r.noD.slice(0, 160));
}

// ⓕ2 技術分夾到天花板時畫面要說
{
    const r = await page.evaluate(() => {
        const keep = app._lastGauge;
        const mk = (score, raw, clamped) => ({ sym: app.currentSymbolId, dims: [
            { icon: '📈', name: '技術', score, weight: 34, raw, clamped },
            { icon: '🧊', name: '籌碼', score: 50, weight: 33 }] });
        app._lastGauge = mk(98, 116, true);
        const d = document.createElement('div'); d.innerHTML = app._gaugeStripHtml(app.currentSymbolId);
        const hit = (d.innerText || '').replace(/\s+/g, ' ');
        app._lastGauge = mk(72, 72, false);
        const d2 = document.createElement('div'); d2.innerHTML = app._gaugeStripHtml(app.currentSymbolId);
        const miss = (d2.innerText || '').replace(/\s+/g, ' ');
        app._lastGauge = keep;
        return { hit, miss };
    });
    ok('ⓕ2 空過守門:儀表列真的畫得出來', /技術/.test(r.hit) && /技術/.test(r.miss), r.hit.slice(0, 120));
    ok('ⓕ2b 夾到上限時要寫出「已到量表上限 + 原始分」', /已到量表上限/.test(r.hit) && /116/.test(r.hit), r.hit.slice(0, 260));
    ok('ⓕ2c ⭐ 對照:沒夾到時⛔ 不可亂寫(不可出現那句)', !/已到量表上限/.test(r.miss), r.miss.slice(0, 200));
}

// ─────────── V77.1.5 使用者四點 ───────────
// ⓖ 海報徽章:⛔ 不可再用 emoji(度量與繪製不一致 → 對齊不了),一律兩個中文字
{
    const r = await page.evaluate(() => new Promise(res => {
        app._rpDrawOwn(app.currentSymbolId);
        setTimeout(() => {
            const D = app._rpOwnDbg || {};
            res({ b: (D.badges || []).map(x => ({ n: x.name, k: x.kind, x: +(+x.x).toFixed(2), adv: x.adv, w: x.word })) });
        }, 2000);
    }));
    ok('ⓖ 空過守門:海報畫得出 ≥3 個面向徽章', r.b.length >= 3, JSON.stringify(r.b));
    ok('ⓖ2 ⛔ 徽章不可是 emoji(要兩個中文字)',
       r.b.length >= 3 && r.b.every(x => /^[\u4e00-\u9fff]{2}$/.test(String(x.w || ''))), JSON.stringify(r.b.map(x => x.w)));
    // ⭐ 這條才是使用者那句「沒有排列整齊」的真正判準:**每一格的實際字寬要一樣**。
    //   🚨 emoji 版在沙箱量起來也「一樣」(六個全是 27.45)但畫出來不一樣 → 所以還要 ⓖ2 一起釘。
    ok('ⓖ3 每一格的字寬完全相同(⛔ 不可有一格比別人寬)',
       r.b.length >= 3 && new Set(r.b.map(x => x.adv)).size === 1, JSON.stringify(r.b.map(x => [x.w, x.adv])));
    ok('ⓖ4 每一格的水平中心相同', r.b.length >= 3 && new Set(r.b.map(x => x.x)).size === 1, JSON.stringify(r.b.map(x => x.x)));
}
// ⓗ 總覽的五面向已下架,⛔ 但 `_lastGauge` 這個產生者一個字都不可拿掉
{
    const r = await page.evaluate(() => {
        app.switchAppTab('diag');
        return { strip: !!document.querySelector('[data-gaugestrip]'),
                 gauge: !!(app._lastGauge && Array.isArray(app._lastGauge.dims) && app._lastGauge.dims.length >= 2),
                 emg: !!(app._lastGauge && Array.isArray(app._lastGauge.emg)) };
    });
    ok('ⓗ 總覽⛔ 不可再有五面向儀表列(使用者:跟報告頁重複)', !r.strip, '');
    ok('ⓗ2 ⭐ 但 `_lastGauge.dims` 必須還在(海報/緊急列/`_riskHot` 全靠它)', r.gauge && r.emg, JSON.stringify(r));
}
// ⓘ ⚡ 快速判別表整張折疊,⛔ 但資料日期要留在第一眼
{
    const r = await page.evaluate(() => new Promise(res => {
        app.switchSubTab && app.switchSubTab('report');
        setTimeout(() => {
            const q = document.getElementById('rpQuick');
            const det = q && q.querySelector('details');
            res({ txt: (q && q.innerText || '').replace(/\s+/g, ' '), open: det ? det.open : null,
                  rows: q && q.querySelector('[data-rpquick]') ? +q.querySelector('[data-rpquick]').dataset.rpquick : 0 });
        }, 2200);
    }));
    ok('ⓘ 快速判別表預設是收起來的', r.open === false, JSON.stringify(r).slice(0, 160));
    ok('ⓘ2 第一眼字數 ≤ 120(收起來之前是 557)', r.txt.replace(/\s/g, '').length <= 120, `${r.txt.replace(/\s/g, '').length} 字`);
    ok('ⓘ3 ⛔ 收起來也要看得到「幾個面向」與**資料日期**(資料日期鐵則)',
       /\d+ 個面向/.test(r.txt) && /📅/.test(r.txt) && /\d\d\/\d\d/.test(r.txt), r.txt.slice(0, 140));
    ok('ⓘ4 ⛔ 一列都沒少(折疊 ≠ 刪掉)', r.rows >= 10, `rows=${r.rows}`);
}
// ⓙ 非上市櫃(多為興櫃):⛔ 清單沒載好時不可亂標
{
    const r = await page.evaluate(() => {
        const keep = app.allStockList;
        app.allStockList = [];                                  // ① 清單沒載好 → 不知道
        const none = app._offListed('9999');
        app.allStockList = Array.from({ length: 1200 }, (_, i) => ({ stock_id: String(1000 + i) }));
        const inList = app._offListed('1000');                  // ② 在名單裡、但**沒有市場別** → 不知道
        const off = app._offListed('9999');                     // ③ 連名單都沒有
        // 🏷️ V77.2.0 ⭐ 決定性對照:採礦補了名字之後,「有名字」不再等於「買得到」——
        //   同一份名單只換 `type`,興櫃那一檔必須**照樣**被標出來。
        app._listedSetN = -1;
        app.allStockList = Array.from({ length: 1200 }, (_, i) => ({
            stock_id: String(1000 + i), type: i === 0 ? 'twse' : (i === 1 ? 'tpex' : 'emerging') }));
        const twse = app._offListed('1000'), tpex = app._offListed('1001');
        const emg = app._offListed('1002');                     // ④ 有名字、但市場別不是上市櫃
        app.allStockList = keep; app._listedSetN = -1;
        return { none, inList, off: off && off.off, twse, tpex, emg: emg && emg.off, emgMkt: emg && emg.mkt };
    });
    ok('ⓙ 清單沒載好時回 null(⛔ 不可說「它不在名單裡」)', r.none === null, JSON.stringify(r));
    ok('ⓙ2 在名單裡但沒有市場別 → null(⛔ 分不出來時不可硬說非上市櫃)', r.inList === null, JSON.stringify(r));
    ok('ⓙ3 連名單都沒有 → 標出來', r.off === true, JSON.stringify(r));
    ok('ⓙ4 上市 / 上櫃 → ⛔ 不標', r.twse === null && r.tpex === null, JSON.stringify(r));
    ok('ⓙ5 🚨 有名字但市場別不是上市櫃(興櫃)→ **照樣標**,而且要帶出市場別',
       r.emg === true && r.emgMkt === 'emerging', JSON.stringify(r));
}

// ─────────── V77.1.6 外部 AI 建議的四個「真缺口」 ───────────
// ⓚ 📊 §11 現在的盤面狀態(相對大盤 / 量能倍數 / 20 日振幅 / 距一年高)
{
    const r = await page.evaluate(() => new Promise(res => {
        app.switchSubTab && app.switchSubTab('report');
        setTimeout(() => {
            const C = app._rpLast;
            // 🧪 決定性對照:注入一條假的加權序列 → 相對大盤那一格一定要跟著出現而且算得對
            const keep = app._macroTaiexSeries;
            app._macroTaiexSeries = Array.from({ length: 30 }, (_, i) => ({ close: 10000 + i * 10 }));   // 20 日 +2.0%
            const T2 = app._rpTapeFacts(C);
            app._macroTaiexSeries = keep;
            const T = app._rpTapeFacts(C);
            document.querySelectorAll('#rpWalls details').forEach(d => { d.open = true; });
            const el = document.querySelector('[data-rptapen]');
            const D = app.rawDailyData, n = D.length;
            // 手算量比基準(⛔ 不含今日)
            let s2 = 0, k = 0;
            for (let i = n - 6; i < n - 1; i++) { const v = +D[i].volume || 0; if (v > 0) { s2 += v; k++; } }
            res({ has: !!el, n: el ? +el.dataset.rptapen : 0,
                  txt: (el ? el.parentElement.innerText : '').replace(/\s+/g, ' '),
                  rs2: T2 && T2.rs ? +T2.rs.mkt.toFixed(4) : null,
                  rsWant: +(((10000 + 29 * 10) / (10000 + 9 * 10) - 1) * 100).toFixed(4),
                  vr: T && T.vr ? +T.vr.x.toFixed(4) : null,
                  want: k >= 3 ? +((+D[n - 1].volume || 0) / (s2 / k)).toFixed(4) : null,
                  dd: T && T.dd != null ? +T.dd.toFixed(3) : null,
                  bdd: (() => { const b = app._basePos(D); return b ? +b.dd.toFixed(3) : null; })() });
        }, 2200);
    }));
    ok('ⓚ 空過守門:報告頁畫得出「現在的盤面狀態」而且 ≥2 格', r.has && r.n >= 2, JSON.stringify(r).slice(0, 200));
    // ⭐ 期望值**當場算**(⛔ 不寫死 2.0 —— 等差序列的 20 日報酬不是 2.0%,我第一版就寫錯了)
    ok('ⓚ2 ⭐ 決定性對照:換一條假的加權序列,相對大盤那一格要跟著算對',
       r.rs2 != null && r.rsWant != null && Math.abs(r.rs2 - r.rsWant) < 0.001, `mkt=${r.rs2} want=${r.rsWant}`);
    // 🚨 陷阱 #43:基準⛔ 不可把被判斷的那一根自己算進去
    ok('ⓚ3 量能倍數的基準是「前 5 日」,⛔ 不含今日', r.vr != null && r.want != null && Math.abs(r.vr - r.want) < 1e-6,
       `畫面 ${r.vr} vs 手算 ${r.want}`);
    ok('ⓚ4 距一年高⛔ 不可自己算一份,要等於 `_basePos().dd`', r.dd != null && r.dd === r.bdd, `${r.dd} vs ${r.bdd}`);
    ok('ⓚ5 距一年高是**位置**⛔ 不可用紅綠(燈號鐵則)→ 要有 ▼ 且該格是灰字',
       /▼/.test(r.txt) && !/text-red|text-green/.test(r.txt), r.txt.slice(0, 120));
    ok('ⓚ6 ⛔ 一定要寫「只描述、沒回測過」(⛔ 不可看起來像買賣訊號)',
       /沒有回測過/.test(r.txt) && /不是買賣訊號/.test(r.txt), r.txt.slice(-180));
    // 🚨 V75.1.0 那個坑:template literal ⛔ 不會幫你把 markdown 轉成 HTML
    ok('ⓚ7 ⛔ 畫面上不可印出 markdown 的 `**`', !/\*\*/.test(r.txt), (r.txt.match(/\*\*[^*]{0,20}/) || [''])[0]);
}
// ⓛ 財報結構分歧(淨利 ↑ 但自由現金流 ↓)—— ⛔ 純事實 + 一定要附全市場基準率
{
    const s = seg('    _finTrend(C) {', '    _sparkSvg(vals, o = {}) {');
    ok('ⓛs 空過守門:抓得到 `_finTrend`', s.length > 1500, `len=${s.length}`);
    ok('ⓛs2 用**稅後淨利** `ni4`(⛔ 不可用 EPS —— 面額變更會讓 EPS ÷4,V76.2.0 的教訓)',
       /T0\.ni4/.test(s) && /_finTtmAt/.test(s) && !/\.eps\b[^\n]*struct/.test(s), '');
    ok('ⓛs3 跨越零⛔ 不給(去年賠今年賺算出來的 % 沒有意義)',
       /\(T0\.ni4 > 0\) === \(T4\.ni4 > 0\)/.test(s) && /\(T0\.fcf4 > 0\) === \(T4\.fcf4 > 0\)/.test(s), '');
    ok('ⓛs4 門檻讀 `_FIN_STRUCT_BASE.t`(⛔ 不可 inline 寫死數字)', /const B = this\._FIN_STRUCT_BASE, TH = B\.t/.test(s), '');
    const r = await page.evaluate(() => {
        const mk = (ni, fcf) => ({ p: '2026-06-30', ni, fcf, eq: 1e10, rev: 1e9, gm: 30, eps: 1, nm: 10, capex: -1e8 });
        // 8 季:前 4 季 ni=100 fcf=100;後 4 季 ni=200(+100%)fcf=50(−50%) → 一定要亮
        const q = [...Array(4)].map(() => mk(1e8, 1e8)).concat([...Array(4)].map(() => mk(2e8, 5e7)));
        const T = app._finTrend({ fin: { q, updated: '2026-09-15' } });
        // 同號守門:去年賠(−)今年賺(+)→ ⛔ 不可亮
        const q2 = [...Array(4)].map(() => mk(-1e8, 1e8)).concat([...Array(4)].map(() => mk(2e8, 5e7)));
        const T2 = app._finTrend({ fin: { q: q2, updated: '2026-09-15' } });
        // 只差 10%(< 門檻 20%)→ ⛔ 不可亮
        const q3 = [...Array(4)].map(() => mk(1e8, 1e8)).concat([...Array(4)].map(() => mk(1.1e8, 9e7)));
        const T3 = app._finTrend({ fin: { q: q3, updated: '2026-09-15' } });
        return { k: T && T.struct ? T.struct.key : null, cross: T2 && T2.struct ? T2.struct.key : null,
                 small: T3 && T3.struct ? T3.struct.key : null, base: app._FIN_STRUCT_BASE };
    });
    ok('ⓛ 淨利 +100% / 自由現金流 −50% → 亮「賺的錢在成長,但現金在縮」', r.k === 'ni_up_fcf_dn', JSON.stringify(r));
    ok('ⓛ2 ⛔ 跨越零(去年賠今年賺)不可亮', r.cross === null, JSON.stringify(r));
    ok('ⓛ3 ⛔ 只差 10%(未達 ±20% 門檻)不可亮', r.small === null, JSON.stringify(r));
    ok('ⓛ4 基準率常數要有 實測日期 + 分母(⭐ 陷阱 #36:沒有對照組不知道算不算異常)',
       r.base && r.base.n > 500 && r.base.hit > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(r.base.d)), JSON.stringify(r.base));
    const h = seg("        const st = T.struct ? (() => {", "        return `<div class=\"text-[10px] font-bold text-gray-300 mt-2 mb-0.5\">📈 近 ${T.n} 季趨勢");
    ok('ⓛ5 畫面上⛔ 不可做成 ⚠️ 警示(23% 的股票都會亮),而且**一定要印出基準率**',
       /這不是罕見事件/.test(h) && /data-rpstructbase/.test(h) && !/text-amber-200/.test(h) && /沒有回測過/.test(h), h.slice(0, 200));
}
// ⓜ 出貨徵兆:亮的攤開、沒亮的收摺疊(⛔ 一個字都沒刪)
{
    const r = await page.evaluate(() => new Promise(res => {
        app.switchSubTab && app.switchSubTab('report');
        setTimeout(() => {
            const box = document.getElementById('rpRisk');
            // 🚨 V77.1.7 起這張卡**預設收起來** → 關著的 <details> 讀不到 innerText
            //   (⛔ 不是內容不見了)→ 量之前要先把外層打開。
            const outer = box && box.querySelector('details');
            if (outer) outer.open = true;
            const det = box && box.querySelector('[data-rpdistoff]');
            const before = det ? det.innerText.replace(/\s+/g, ' ') : '';
            if (det) det.open = true;
            res({ off: det ? +det.dataset.rpdistoff : 0, folded: before.length,
                  opened: det ? det.innerText.replace(/\s+/g, ' ').length : 0,
                  warn: box ? (box.innerText.match(/⚠️/g) || []).length : 0,
                  hasWhy: det ? /張|%|沒有/.test(det.innerText) : false });
        }, 2400);
    }));
    ok('ⓜ 空過守門:抓得到「沒亮的那幾條」摺疊', r.off >= 3, JSON.stringify(r));
    ok('ⓜ2 收起來時比攤開短很多(這是去重的目的)', r.folded > 0 && r.opened > r.folded * 1.5, JSON.stringify(r));
    ok('ⓜ3 ⛔ 一個字都沒刪:攤開後每一條的數字(why)還在', r.hasWhy, JSON.stringify(r));
    const s = seg('    _rpRiskHtml(C) {', '        const distHead = C.dist');
    ok('ⓜ4 ⛔ 亮的那幾條一律攤開不打折(使用者鐵則:警示寧可多提醒)',
       /const on = C\.dist\.items\.filter\(x => x\.on\)/.test(s) && /items\.push\(on\.map\(_distRow\)\.join\(''\)\)/.test(s), s.slice(-300));
}
// ⓝ 「跟上次看的時候比」快照
{
    const r = await page.evaluate(() => {
        const C = app._rpLast, key = app._rpSnapKey(C.sym);
        const keep = localStorage.getItem(key);
        try { localStorage.removeItem(key); } catch (_) {}
        const first = app._rpSnapDiff(C);                       // ① 第一次看 → ⛔ 不可編一個「跟上次比」
        const stored = app._lsJson(key, null);
        // ② 同一個資料日期再開一次 → ⛔ 不可覆寫(否則上次的基準就沒了)
        //   🚨 ⛔ 不可只比字串 —— 重寫出來的內容**幾乎一樣**(同一毫秒連 ts 都一樣)= 假綠燈。
        //   ⭐ 蓋一個哨兵進去:被覆寫的話哨兵會消失。
        const stamped = JSON.parse(localStorage.getItem(key));
        stamped.__probe = 'v77_1_6';
        try { localStorage.setItem(key, JSON.stringify(stamped)); } catch (_) {}
        const before = localStorage.getItem(key);
        app._rpSnapDiff(C);
        const after = app._lsJson(key, {});
        const sameDay = after.__probe === 'v77_1_6' && localStorage.getItem(key) === before;
        // ③ 換一個資料日期 + 改幾個值 → 要列出來
        const old = JSON.parse(before);
        old.d = '2000/01/01'; old.v['收盤價'] = (+old.v['收盤價'] || 100) * 0.5;
        try { localStorage.setItem(key, JSON.stringify(old)); } catch (_) {}
        const diff = app._rpSnapDiff(C);
        // 🚨 `_rpSnapDiff` 成功比完就**寫回**新快照 → 想量 HTML 要再擺一次舊的,
        //   否則第二次呼叫變成「同一個資料日期」= 空字串(我第一版就這樣寫出假失敗)
        try { localStorage.setItem(key, JSON.stringify(old)); } catch (_) {}
        const html = app._rpSnapHtml(C);
        if (keep != null) { try { localStorage.setItem(key, keep); } catch (_) {} } else { try { localStorage.removeItem(key); } catch (_) {} }
        return { first, wrote: !!(stored && stored.d), sameDay,
                 rows: diff && diff.rows ? diff.rows.map(x => x.k) : [], html: String(html).slice(0, 2500) };
    });
    ok('ⓝ 第一次看這一檔 → ⛔ 不編「跟上次比」,但要把快照存下來', r.first === null && r.wrote, JSON.stringify(r).slice(0, 200));
    ok('ⓝ2 ⭐ 同一個資料日期再開 → ⛔ 不可覆寫(不然上次的基準就沒了)', r.sameDay === true, JSON.stringify(r.sameDay));
    ok('ⓝ3 資料日期換了 + 收盤價改一半 → 要列出「收盤價」變了', r.rows.includes('收盤價'), JSON.stringify(r.rows));
    ok('ⓝ4 ⛔ 要明講「不是訊號、不進評分」', /不是訊號/.test(r.html) && /不進任何評分/.test(r.html), r.html.slice(0, 200));
    const s = seg('    _rpSnapDiff(C) {', '    _rpSnapRows(a, b) {');
    ok('ⓝ5 快照綁**資料日期**不綁開啟時間(⛔ 綁時間這一格永遠是空的)',
       /String\(old\.d\) === String\(now\.d\)/.test(s), '');
    ok('ⓝ6 ⛔ 每檔一份的 localStorage 必接 `_lruTrim`(V76.2.7)', /_lruTrim\('rpSnap_'/.test(s), '');
}

// ─────────── V77.1.7 使用者三點 ───────────
// ⓞ 月營收:「基本頁即時抓到的」要排第一(⛔ 否則同一個 App 兩個年增)
{
    const src = seg('    _revYoY(fy, fc, fen) {', "return { v: null, month: null, src: null };");
    ok('ⓞs 空過守門:抓得到 `_revYoY`', src.length > 300, `len=${src.length}`);
    ok('ⓞs2 即時那條(`_revLive`)排在採礦快取**之前**',
       src.indexOf('_revLive') > 0 && src.indexOf('_revLive') < src.indexOf('fy?.yoy'), '');
    const r = await page.evaluate(() => new Promise(res => {
        const sym = app.currentSymbolId, keep = app._revLive;
        // 🧪 決定性對照:餵一組不可能巧合的數字 → 報告頁三個欄位要**一起**變
        app._revLive = { sym, ym: '2099-12', mrev: 8.88e8, yoy: 77.7, ytd: 66.6, ts: Date.now() };
        app.renderReportTab(sym).then(() => setTimeout(() => {
            const C = app._rpLast || {};
            const got = { mrev: C.mrev, yoy: C.yoy, ytd: C.ytd, ym: C.yoyM };
            app._revLive = keep;
            res(got);
        }, 900));
    }));
    ok('ⓞ 注入即時月營收 → 報告頁的 最新月營收 / 年增 / 累計年增 三個一起換',
       r.mrev === 8.88e8 && Math.abs(r.yoy - 77.7) < 0.01 && Math.abs(r.ytd - 66.6) < 0.01, JSON.stringify(r));
    ok('ⓞ2 而且要帶出「是哪一個月」(⛔ 沒有月份的年增查不出對不對)', r.ym === '2099-12', JSON.stringify(r));
    const st = seg('    async fetchFundamentalAnalysis(', '        // YoY — FinMind 仍空就用採礦值。');
    ok('ⓞ3 基本頁抓到之後要存成 `_revLive`(⛔ 報告頁不可自己再打一次 API)',
       /this\._revLive = \{/.test(st) && /ytd/.test(st), '');
    ok('ⓞ4 ⛔ 累計年增月份不齊就不給(不硬算)', /rows\.length === _mMax/.test(st), '');
}
// ⓟ canvas 結論徽章:⛔ 不可是 emoji ・要畫在 pill 的真中心
{
    const r = await page.evaluate(() => new Promise(res => {
        app._rpDrawOwn(app.currentSymbolId);
        setTimeout(() => res({ h: (app._rpOwnDbg || {}).headBadge || null,
                               t1: app._rpBadgeText('🛡️ 持股續抱'), t2: app._rpBadgeText('➖ 觀望'),
                               t3: app._rpBadgeText('🔴 別碰') }), 1800);
    }));
    ok('ⓟ 空過守門:海報畫得出結論徽章', !!(r.h && r.h.word), JSON.stringify(r));
    ok('ⓟ2 ⛔ 徽章不可含 emoji(canvas 上量不準也對不齊,V77.1.5 同一個病)',
       r.h && /^[一-鿿0-9A-Za-z%．.\-+／/ ·]+$/.test(r.h.word), JSON.stringify(r));
    ok('ⓟ3 文字畫在 pill 的**垂直真中心**(⛔ 不是 alphabetic 基線)',
       r.h && Math.abs(r.h.cy - (r.h.top + r.h.h / 2)) < 0.51, JSON.stringify(r.h));
    ok('ⓟ4 `_rpBadgeText` 只剝符號、⛔ 一個中文字都不改',
       r.t1 === '持股續抱' && r.t2 === '觀望' && r.t3 === '別碰', JSON.stringify(r));
    const d = seg('        const txt = (t, x, yy, size, col,', '        const mt = (t, size,');
    ok('ⓟ5 改過的 `textBaseline` 一定要復原(⛔ 不然後面每一行字都會跑掉)',
       /textBaseline = 'alphabetic'/.test(d), d.slice(0, 200));
}
// ⓠ 報告頁全部折疊(使用者:「§12…折疊起來,下方要折疊的都折疊」)
{
    const r = await page.evaluate(() => new Promise(res => {
        app.switchSubTab && app.switchSubTab('report');
        setTimeout(() => {
            const box = document.getElementById('subContentReport'), out = [];
            box.querySelectorAll(':scope > div').forEach(c => {
                const d = c.querySelector('details');
                out.push({ id: c.id || '', open: d ? d.open : null, chars: (c.innerText || '').replace(/\s/g, '').length });
            });
            res({ cards: out, total: out.reduce((a, x) => a + x.chars, 0),
                  riskSum: (document.querySelector('#rpRisk summary') || { innerText: '' }).innerText.replace(/\s+/g, ' ') });
        }, 2400);
    }));
    ok('ⓠ 空過守門:報告頁畫得出 ≥8 張卡', r.cards.length >= 8, JSON.stringify(r.cards.map(x => x.id)));
    const opened = r.cards.filter(x => x.open === true).map(x => x.id);
    ok('ⓠ2 ⛔ 一張都不可預設展開(含 §12・§13・§18・§19)', opened.length === 0, opened.join(','));
    ok('ⓠ3 第一眼字數 ≤ 1,100(折疊前實測 2,575)', r.total <= 1100, `${r.total} 字`);
    // ⛔ 折疊 ≠ 把提醒藏起來:summary 仍然要寫幾則預警
    ok('ⓠ4 ⭐ 風險那節收起來時,標題列仍要寫「N 則預警 / 出貨徵兆」', /預警|出貨徵兆/.test(r.riskSum), r.riskSum.slice(0, 120));
}
// ⓡ 板塊輪動:新增「概念股」分頁且**預設**是它;⛔ 官方產業的實測數字不可套到題材
{
    const r = await page.evaluate(async () => {
        try { app.switchAppTab('market'); } catch (_) { }
        try { app.switchMarketTab('rot'); } catch (_) { }
        await new Promise(r => setTimeout(r, 900));
        try { localStorage.removeItem('rotView'); } catch (_) { }
        await app._renderRotTab();
        await new Promise(r => setTimeout(r, 400));
        const S = app._regimeStats(), card = document.getElementById('rotRankCard');
        const th = { view: app._rotView(), lead: (document.getElementById('rotLead').innerText || '').replace(/\s+/g, ' '),
                     n: card.querySelectorAll('[data-rotrank]').length,
                     btns: [...card.querySelectorAll('[data-rotviewbtn]')].map(b => b.dataset.rotviewbtn) };
        app.switchRotView('ind');
        await new Promise(r => setTimeout(r, 700));
        const ind = { view: app._rotView(), lead: (document.getElementById('rotLead').innerText || '').replace(/\s+/g, ' '),
                      n: card.querySelectorAll('[data-rotrank]').length };
        app.switchRotView('theme');
        await new Promise(r => setTimeout(r, 700));
        return { th, ind, themes: S ? S.tmed.size : 0, inds: S ? S.imed.size : 0,
                 tcnt: S ? [...S.tcnt.values()] : [] };
    });
    ok('ⓡ 空過守門:題材與產業都算得出來', r.themes >= 10 && r.inds >= 20, JSON.stringify({ t: r.themes, i: r.inds }));
    ok('ⓡ2 ⭐ 預設就是「概念股」那一頁(使用者:以概念股為首要)', r.th.view === 'theme', r.th.view);
    ok('ⓡ3 兩個分頁鈕都在', r.th.btns.includes('theme') && r.th.btns.includes('ind'), JSON.stringify(r.th.btns));
    ok('ⓡ4 列數 = 該視角的組數(⛔ 切換要真的換一批)', r.th.n === r.themes && r.ind.n === r.inds, JSON.stringify({ t: r.th.n, i: r.ind.n }));
    // 🚨 這條最重要:官方產業那套實測背書⛔ 不可出現在題材頁
    // ⚠️ 斷言釘**用意**不是釘字串:那個 +1.44pp 出現在題材頁是**刻意的**
    //   —— 它是用來說「那是官方產業測的,⛔ 不可以套到題材上」。
    //   要擋的是「拿它當題材的背書」,所以同一句一定要有「沒有回測過」+「不可以套到題材上」。
    ok('ⓡ5 ⛔ 題材頁要明說「沒有回測過」且「不可以套到題材上」',
       /沒有回測過/.test(r.th.lead) && /不可以套到題材上/.test(r.th.lead)
       && !/避開最弱那幾族/.test(r.th.lead), r.th.lead.slice(0, 200));
    ok('ⓡ6 ⭐ 官方產業頁**照舊**引用那組實測數字(⛔ 不可一起拿掉)',
       /1\.44pp/.test(r.ind.lead), r.ind.lead.slice(0, 160));
    ok('ⓡ7 ⛔ 畫面上不可印出 markdown 的 `**`', !/\*\*/.test(r.th.lead) && !/\*\*/.test(r.ind.lead), '');
    // 陷阱 #27:樣本少的不進前 3 / 後 3
    ok('ⓡ8 ⭐ 樣本少(<5 檔)的題材⛔ 不可進最強/最弱那一句',
       (() => { const m = r.th.lead.match(/最強 ([^／]+)／/); if (!m) return false;
                return !/樣本少/.test(m[1]); })(), r.th.lead.slice(0, 160));
}

// ─────── 💸📚📖 V77.1.8 省 AI 次數 / 多模型比較 / 法人級提示詞 ───────
{   // 🗑️ ⓢ V77.2.0 使用者明示刪掉的六個 AI 功能/卡片 —— ⛔ 不可復活
    //   ⭐ 刪之前**先量過**誰是「唯一產生者」(CLAUDE.md 兩次教訓:V76.1.2 `_overallGaugeHtml`、
    //     V76.2.5 `_ovDecide`)→ 四個本來就是死碼、兩個是活的;而 `fetchFundamentalAnalysis`
    //     **不可刪**(它產生 `_xrayMetrics` 與 `_revLive`)。
    const DEAD = ['renderDeepBrief', 'analyzeStockDeep', '_deepBriefFacts', '_deepBriefQuality',
                  'analyzeStockPredict', 'triggerTechAI', 'closeTechAIModal'];
    //   🚨 斷言一律先剝掉註解(JS 的 `//` **與 HTML 的 `<!-- -->`**)—— 第一版就被我自己寫在
    //     HTML 註解裡的「`triggerTechAI()` 全檔沒有任何呼叫端」救活了(本 repo 第 7 次)。
    const CODE = strip(SRC).replace(/<!--[\s\S]*?-->/g, '');
    for (const d of DEAD) {
        ok(`ⓢ ⛔ \`${d}\` 不可再出現(使用者明示刪除)`,
           !new RegExp(`(^|\\W)${d}\\s*[(:]`, 'm').test(CODE), '');
    }
    ok('ⓢ2 ⛔ 這幾個容器也不可再出現',
       !/id="(deepBriefCard|deepBriefAi|stockPredictResult|techAIModal)"/.test(CODE), '');
    // 🚨 但下面這幾個**留著是對的** —— 刪掉會靜默弄壞別的東西
    ok('ⓢ3 🚨 `fetchFundamentalAnalysis` 必須留著(它是 `_xrayMetrics` / `_revLive` 的唯一產生者)',
       /fetchFundamentalAnalysis\(sym, \{ skipAI: true \}\)/.test(SRC)
       && /this\._xrayMetrics = \{ sym \}/.test(SRC), '');
    ok('ⓢ4 🚨 `xrayAIBox` / `xrayAIResult` 容器要留著(ETF 的「不適用本益比」說明在用)',
       /id="xrayAIBox"/.test(SRC) && /這是 ETF/.test(SRC), '');
    ok('ⓢ5 🚨 `globalAIModal` 要留著(盤前速報 `runGlobalMarketAI` 在用)',
       /id="globalAIModal"/.test(SRC) && /runGlobalMarketAI/.test(SRC), '');
    ok('ⓢ6 🚨 `aiTranslatorCard` / `geminiResultBox` 要留著(`updateAITranslator` 在寫)',
       /id="aiTranslatorCard"/.test(SRC) && /id="geminiResultBox"/.test(SRC)
       && /this\.updateAITranslator\(/.test(SRC), '');
    // ⭐ 已經存在使用者手機上的孤兒快取還是要清得掉 → 配額防爆的前綴清單⛔ 不可跟著刪
    ok('ⓢ7 ⭐ 配額防爆的舊快取前綴要留著,而且要補上剛刪掉那支的',
       /'aiCache_stockPredict_'/.test(SRC) && /'aiCache_dispExit_'/.test(SRC)
       && /'aiCache_deepBrief_'/.test(SRC), '');
}
{   // ⓣ 多模型:下拉 + 同欄位 + ⛔ 不給綜合品質分數
    const g = seg('    _RP_GEN: [', '    _rpNoteKey(sym) {');
    ok('ⓣs 空過守門:抓得到多模型那一段', g.length > 1500, `len=${g.length}`);
    ok('ⓣs2 選單要同時有「會查網路」的外部與「App 內」的模型,而且 App 內的⛔ 要標明不會上網',
       /web: 1/.test(g) && /chain: 'gemini-openrouter'/.test(g) && /chain: 'openrouter-gemini'/.test(g)
       && /chain: 'groq-only'/.test(g) && /不會上網/.test(g), '');
    ok('ⓣs3 ⛔ 不給綜合品質分數(陷阱 #38)—— 只列數得出來的東西',
       /⛔ \*\*刻意不給「綜合品質分數」\*\*/.test(SRC) && /_rpQualBits/.test(g)
       && !/qualScore|品質分數 *[:=] *\d/.test(g), '');
    ok('ⓣs4 App 內模型的提示詞要**額外**告訴它「你不能上網,那幾節寫查不到」',
       /沒有上網能力/.test(g) && /一個網址都不准寫/.test(g), '');
    // 🆓 免費模型清單⛔ 不可寫死(V73.8.0:OpenRouter 會下架 slug)
    const f = seg('    async _rpFreeModels() {', '    _rpNoteKey(sym) {');
    ok('ⓣs5 🆓 免費模型是**當場問官方**拿的,⛔ 不是寫死的清單',
       /openrouter\.ai\/api\/v1\/models/.test(f) && /pricing\?\.prompt/.test(f)
       && !/':free'\s*,\s*'/.test(f), '');
}
{   // ⓤ 法人級提示詞:他規格裡真正新增的四件 + 我改掉的兩條
    const P = seg('    _reportPrompt(sym) {', '    // 🎨 V76.2.3 做圖提示詞');
    ok('ⓤs 空過守門:抓得到提示詞', P.length > 4000, `len=${P.length}`);
    ok('ⓤ1 來源優先順序四級 + 第四級只能當線索',
       /第四級只能當線索/.test(P) && /公開資訊觀測站/.test(P) && /Reuters/.test(P), '');
    ok('ⓤ2 五關自我複查,而且⛔ 不可把複查過程印出來',
       /五關自我複查/.test(P) && /不要把複查過程寫出來/.test(P), '');
    ok('ⓤ3 A 事實 / B 合理推論 / C 未知 三級,C ⛔ 不可寫成 A',
       /A 事實/.test(P) && /B 合理推論/.test(P) && /C 未知/.test(P) && /C 不可寫成 A/.test(P), '');
    ok('ⓤ4 新聞敘事與管理層說法⛔ 不可改寫成事實(要保留誰在什麼時候說的)',
       /保留來源屬性/.test(P) && /管理層說法同理/.test(P), '');
    // 🚨 我**刻意改掉**他規格的兩條 —— 照抄會讓本站自己的實測成績被刪掉 / 免責消失
    ok('ⓤ5 🚨 「禁止勝率」要限縮成「⛔ 你不可以**自己產生**」(⛔ 不可把本站實測成績也禁掉)',
       /本站實測的勝率或期望值/.test(P) && /照抄即可/.test(P), '');
    ok('ⓤ6 🚨 免責由本站自己印 → 提示詞叫 AI 別寫套話免責',
       /不要寫「以上僅供參考/.test(P) && /免責由本站自己印/.test(P), '');
    ok('ⓤ7 🚨 12 季那一組**沒有營益率**要明寫(資料源沒有營業費用,⛔ 不可叫它自己算)',
       /12 季那一組\*\*沒有營益率\*\*/.test(P), '');
    ok('ⓤ8 ⭐ 補上他規格沒有的「篇幅不夠時先保證哪幾節」(21 節會被 token 上限截斷)',
       /篇幅不夠時/.test(P) && /節號一個都不可跳/.test(P), '');
    ok('ⓤ9 行事曆那條實測結論照舊寫在提示詞裡(⛔ 不可因為改版掉了)',
       /方向 0 個成立/.test(P) && /波動可能變大/.test(P), '');
    ok('ⓤ10 ⛔ 綜合分數 / 星等 / 因子評分一個都不要',
       /因子評分、§20 星等評等已經刪掉/.test(P) && /不給機率/.test(P), '');
}

{   // ⓥ **執行期**(⛔ 光靠原始碼斷言不夠):多模型下拉真的在畫面上
    const v = await page.evaluate(async () => {
        const A = app;
        await A.renderReportTab('6894').catch(() => {});
        await new Promise(r => setTimeout(r, 300));
        const sel = document.querySelector('#rpPaste #rpGenSel');
        return {
            opts: sel ? [...sel.options].map(o => o.value) : [],
            genBtn: !!document.querySelector('#rpPaste [data-rpgenrun]'),
            free:   !!document.querySelector('#rpPaste [data-rpfreebtn]'),
        };
    });
    ok('ⓥs 空過守門:報告頁真的渲染出來了', v.opts.length > 0, JSON.stringify(v.opts));
    ok('ⓥ5 下拉真的在畫面上,而且五個模型都在', v.opts.length === 5 && v.opts.includes('px') && v.opts.includes('or'), JSON.stringify(v.opts));
    ok('ⓥ6 「產出」與「🆓 免費模型」兩顆按鈕都在這張卡裡', v.genBtn && v.free, JSON.stringify({ g: v.genBtn, f: v.free }));
}

{   // ⓦ 🚨 盤中的「量能倍數」是**口徑錯了**(分子半天、分母整天)→ ⛔ 不給數字
    //   ⭐ 決定性對照:**同一批資料**只換 `_lastBarIsToday` 的回答,兩邊必須不一樣。
    const w = await page.evaluate(() => {
        const A = app, real = A._lastBarIsToday;
        const C = A._rpLast || { sym: A.currentSymbolId };
        const grab = (open) => {
            A._lastBarIsToday = () => open;
            const T = A._rpTapeFacts(C);
            const h = A._rpTapeHtml(C), f = A._reportFacts(String(C.sym));
            const d = document.createElement('div'); d.innerHTML = h;
            const cell = [...d.querySelectorAll('[data-rptape]')].find(x => x.dataset.rptape === '量能倍數');
            return { x: T && T.vr ? T.vr.x : undefined, lots: T && T.vr ? T.vr.lots : null,
                     txt: (cell?.innerText || '').replace(/\s+/g, ' '),
                     fact: (f.match(/量能倍數[^\n]*/) || [''])[0] };
        };
        const closed = grab(false), open = grab(true);
        A._lastBarIsToday = real;
        return { closed, open };
    });
    ok('ⓦ 空過守門:兩種情境都抓得到「量能倍數」那一格', !!w.closed.txt && !!w.open.txt && w.closed.lots > 0,
       JSON.stringify(w).slice(0, 260));
    ok('ⓦ2 收盤後照樣給倍數(⛔ 不是整個功能拿掉)', typeof w.closed.x === 'number' && /×/.test(w.closed.txt), w.closed.txt);
    ok('ⓦ3 🚨 盤中⛔ 不給倍數(分子是半天的量、分母是整天的均量)', w.open.x === null && !/\d×/.test(w.open.txt), w.open.txt);
    ok('ⓦ4 ⭐ 而且要講出「為什麼不給」(⛔ 不可只留空白 —— 陷阱 #22)',
       /還沒收盤/.test(w.open.txt) && /(期間|整天)/.test(w.open.txt), w.open.txt);
    // 🚨 提示詞那一份是**第二個出口**(V77.1.4 的教訓:顯示點永遠比你以為的多一個)
    ok('ⓦ5 🚨 餵給外部 AI 的提示詞也要一起改口,而且要明講⛔ 不可自己算',
       /量能倍數 —/.test(w.open.fact) && /不可以自己算/.test(w.open.fact)
       && /量能倍數 [\d.]+×/.test(w.closed.fact), `${w.open.fact} || ${w.closed.fact}`);
    ok('ⓦ6 ⭐ 決定性對照:同一批資料只換情境,兩邊必須不同', w.open.txt !== w.closed.txt && w.open.fact !== w.closed.fact, '');
}

ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
