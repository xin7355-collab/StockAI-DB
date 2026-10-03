#!/usr/bin/env node
/**
 * 🧹 V78.3.4 散戶救星(index.html)畫面上⛔ 不可出現實測 / 回測研究文字
 *   使用者:「散戶 app 裡面太多實測資訊、還有 xx 版本實測資料,不想給別人看到」
 *   → 散戶 App 只留「怎麼做」;數字、勝率、期望值、對照組、贏 0050、探針名、版本號字樣一律在產業作戰室。
 *   ⭐ 判斷邏輯一行不改:這支只看「畫面上的字」。
 *
 *   跑法:node scripts/test_retail_clean.mjs            → 全部頁面都要乾淨(SCOPE 沒設 = 全部)
 *         SCOPE=desk,ov node scripts/test_retail_clean.mjs  → 只驗某幾區(分批做的時候用)
 *         REPORT=1 …                                    → 只列出每頁的違規行,不判紅綠
 *   注入驗證:INJECT=1 → 在決策台塞一句「實測 17 條起點」,必須紅。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// ⛔ 研究字樣(交易術語「回測月線 / 回測不破」那種是「股價回頭測試」,不是回測研究 → 白名單)
const BAD = [
    /實測/, /(?<!測試\s?\/\s?)探針(?!卡)/, /六關/, /六道關卡/, /起點中位/, /\d+\s*條起點/, /對照組/, /安慰劑/, /樣本外/, /_probe\b/, /\.mjs\b/,
    /\bV\d{2}\.\d\.\d\b/, /含息/, /贏\s*0050/, /輸\s*0050/, /勝率\s*[\d.]+\s*%/, /期望值?\s*[+\-−]?[\d.]+\s*%/,
    /回測(?!月線|季線|年線|半年線|支撐|不破|頸線|均線|\d+\s*日線|前高|前低|缺口|低點|高點|底部|守住|成功|失敗|5MA|10MA|20MA|60MA|突破點|平台)/,
    /逐年(?:同向|全正|全負)/, /模擬(?:成績|帳|買賣)/, /前後半/, /基準勝率/, /條路徑/,
    // ⚠️ 不收裸的「pp」—— 毛利率 ↑5.4pp、大戶 +0.05pp 是財報 / 集保的事實變化,⛔ 不是研究數字
];
const ALLOW_LINE = [/^⚙️ 設定中心/];      // 版本徽章那一行
const badOf = s => BAD.filter(r => r.test(s)).map(r => String(r));

const STRATS = (process.env.STRATS || 'gene,lead').split(',');
const SCOPE = process.env.SCOPE ? new Set(process.env.SCOPE.split(',')) : null;
const REPORT = !!process.env.REPORT;
const AREA = k => k === 'desk' ? 'desk' : k.startsWith('ov_') ? 'ov' : k.startsWith('diag_report') ? 'report' : k === 'pa' ? 'diag'
    : k.startsWith('diag_') ? 'diag' : k.startsWith('help_') ? 'help' : k === 'settings' ? 'settings' : k === 'jargon' ? 'help' : 'pages';

const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const all = {};          // key → [{line, bad}]
for (const strat of STRATS) {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    page.on('pageerror', e => errs.push(`${strat}: ${e.message}`));
    await page.addInitScript((st) => {
        try {
            const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}');
            s.strategy = st; s.stratUnlock = st !== 'gene';
            localStorage.setItem('proTerminalSettings', JSON.stringify(s));
            localStorage.setItem('inventory', JSON.stringify([{ symbol: '2330', cost: 900, shares: 1000, date: '2026-09-01' }, { symbol: '0050', cost: 150, shares: 1000 }]));
        } catch (_) {}
    }, strat);
    await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && typeof app.renderDeck === 'function', null, { timeout: 60000 });
    await page.waitForTimeout(8000);
    // ⚠️ 沙箱沒有 Tailwind → whitespace-pre-wrap 不生效,整個說明會擠成一行(看不出是哪一句違規)
    await page.addStyleTag({ content: '.whitespace-pre-wrap{white-space:pre-wrap!important}.whitespace-pre-line{white-space:pre-line!important}' });
    if (process.env.INJECT) await page.evaluate(() => { const o = app._leaderDeckHtml, o2 = app.renderDeck; app.renderDeck = async function (...a) { const r = await o2.apply(this, a); const b = document.getElementById('tabContentDesk') || document.body; b.insertAdjacentHTML('afterbegin', '<div>實測 17 條起點中位 +953%</div>'); return r; }; });
    const grab = async (key, fn, arg, wait = 3000) => {
        const skip = SCOPE && !SCOPE.has(AREA(key));
        if (skip && key !== 'ov_now') return;          // ⚠️ ov_now 負責 analyze('2330') —— 報告 / 個股分頁都靠它,範圍外也要跑(只是不收)
        try { await page.evaluate(fn, arg); } catch (e) { all[`${strat}:${key}`] = [{ line: 'ERR ' + e.message, bad: ['ERR'] }]; return; }
        await page.waitForTimeout(wait);
        if (skip) return;
        // ⭐ 滑鼠停上去才看得到的 title 也算畫面(使用者:「整份資料我都要查」)
        const txt = await page.evaluate(() => { document.querySelectorAll('details').forEach(d => { d.open = true; });
            const tt = [...document.querySelectorAll('[title]')].filter(e => e.offsetParent !== null).map(e => '[title] ' + e.getAttribute('title').replace(/\n/g, ' '));
            // ⭐ 按了才跳出來的說明(onclick 裡直接寫 alert / _helpBox 的文字)也算畫面
            const oc = [...document.querySelectorAll('[onclick]')].filter(e => e.offsetParent !== null)
                .map(e => e.getAttribute('onclick')).filter(t => /alert\(|_helpBox\(|_showRichModal\(/.test(t))
                .flatMap(t => t.split(/\\n|\n/)).map(t => '[onclick] ' + t.slice(0, 300));
            return document.body.innerText + '\n' + tt.join('\n') + '\n' + oc.join('\n'); });
        const hits = [];
        for (const raw of txt.split('\n')) { const s = raw.trim(); if (!s || ALLOW_LINE.some(r => r.test(s))) continue; const b = badOf(s); if (b.length) hits.push({ line: s.slice(0, 200), bad: b }); }
        all[`${strat}:${key}`] = hits;
    };
    const closeAll = () => { document.querySelectorAll('#richHelpModal,#jargonModal,#updateLogModal,#settingsModal').forEach(m => { m.classList.add('hidden'); m.style.display = ''; }); };
    await grab('desk', () => app.switchAppTab('desk'));
    for (const t of ['inv', 'fav', 'market', 'radar', 'etf', 'broker', 'potential', 'hunt']) await grab(t, t => app.switchAppTab(t), t);
    // ⭐ 每一頁的子分頁也要走過(只掃預設那一格 = 其他格的文字永遠看不到)
    for (const t of ['global', 'tw', 'idx', 'rot', 'advice', 'eve']) await grab('mkt_' + t, async t => { app.switchAppTab('market'); app.switchMarketSubTab(t); }, t, 2500);
    for (const t of ['strategy', 'etf', 'custom', 'broker']) await grab('radarmode_' + t, async t => { app.switchAppTab('radar'); app.switchRadarMode(t); }, t, 2500);
    // 🏦 V78.3.9 券商頁每一個左欄分類 + 分點榜每一個小分頁都要走過(以前只掃預設那一格)
    const BC = await page.evaluate(() => (app._BROKER_CATS || []).map(c => c[0]));
    for (const k of BC) await grab('bcat_' + k, async k => { app.switchAppTab('broker'); app.switchBrokerCat(k); }, k, 1500);
    for (const k of ['buy_today', 'sell_today', 'win', 'mystery', 'daytrade_fire']) await grab('brank_' + k, async k => {
        app.switchAppTab('broker'); app._brokerRankMode = k; app.switchBrokerCat('ranks'); }, k, 1200);
    // 🧪 條件式卡片:畫面巡邏不一定觸發得到 → 直接餵條件(大盤風險偏高)
    await grab('cond_riskline', async () => { app._calcRiskScore = () => 80; const h = await app._tomorrowWatchHtml();
        const d = document.createElement('div'); d.innerHTML = h || ''; document.body.appendChild(d); }, null, 300);
    const RK = await page.evaluate(() => Object.keys(app._RADAR_TABS || {}));
    for (const k of RK) await grab('radar_' + k, async k => { app.switchAppTab('radar'); app.switchRadarMode('strategy'); app.switchRadarStrategy(k); }, k, 2000);
    const CK = await page.evaluate(() => Object.keys(app._CHU_TABS || {}));
    for (const k of CK) await grab('chu_' + k, async k => { try { await app.openChuMasterModal(); } catch (_) {} app.switchChuTab(k); }, k, 1200);
    await page.evaluate(() => { document.getElementById('chuMasterModal')?.classList.add('hidden'); });
    await grab('ov_now', async () => { app.switchAppTab('diag'); await app.analyze('2330', true, false, true); app.switchSubTab('strategy'); app.switchOvTab('now'); }, null, 6000);
    await grab('ov_entry', () => app.switchOvTab('entry'));
    await grab('ov_exit', () => app.switchOvTab('exit'));
    for (const st of ['report', 'live', 'daytrade', 'chart', 'chip', 'corp', 'backtest', 'bullbear']) await grab('diag_' + st, st => app.switchSubTab(st), st);
    for (const t of ['broker', 'dist']) await grab('diag_chip_' + t, async t => { app.switchSubTab('chip'); app.switchChipTab(t); }, t, 2500);
    await grab('pa', async () => { app.openPriceAlertModal('2330'); }, null, 2500);
    await page.evaluate(() => { const m = document.getElementById('priceAlertModal'); if (m) m.classList.add('hidden'); });
    await grab('settings', () => { app.openSettings(); });
    await page.evaluate(closeAll);
    // 📖 說明彈窗(每一支都呼叫一次,讀 richHelpModal / jargon / updateLog)
    const HELPS = ['_leaderHelp', '_rulerHelp', '_showEdgeHelp', '_showPbHelp', '_showTodaySigHelp', '_showScrHelp', 'showScrEdgeHelp', 'showPlaybookPatternHelp',
        'showPlaybookConceptHelp', '_showFloorCountHelp', '_helpOvernight', '_dtBeginnerGuide', '_showDtGuide', '_showDtAdvanced', '_showExitHelp', '_showMarginHelp',
        '_showMedGapHelp', '_showPeBandHelp', '_showTrendCommandHelp', '_showTradeMirror', 'showKbarSignalHelp', 'showKbarTacticsHelp', 'showLuOddsHelp', 'showGuardianHelp',
        '_showAttentionRulesHelp', '_showChuPlanFull', '_showIdxWhy', 'showGranvilleFull', '_showVolSurgeSheet', '_showEnvInfo', 'showMinerInfoPopup'];
    for (const h of HELPS) await grab('help_' + h, async h => {
        // ⚠️ 只加 hidden、⛔ 不可設 style.display='none' —— 開彈窗的函式只拿掉 hidden,inline none 會讓後面每一個說明都量成看不見(假綠燈)
        document.querySelectorAll('#richHelpModal,#jargonModal').forEach(m => { m.classList.add('hidden'); m.style.display = ''; });
        const f = app[h]; if (typeof f !== 'function') return; const r = f.call(app); if (r && r.then) await r;
        const vis = [...document.querySelectorAll('#richHelpModal,#jargonModal')].some(m => !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none');
        if (!vis && !document.querySelector('[id$="Modal"]:not(.hidden)')) window.__helpNoModal = (window.__helpNoModal || []).concat(h);
    }, h, 800);
    await grab('jargon', () => { const d = document.createElement('div'); d.id = '__jg'; d.style.whiteSpace = 'pre-line'; d.textContent = Object.values(app.jargonDict || {}).join('\n'); document.body.appendChild(d); }, null, 200);
    // 🔎 V78.3.9 靜態段:條件式卡片的原始碼裡,研究字只能出現在有 _labMode 判斷的那一行
    //   (分點集中 ≥40% / 夜盤先漲 / 分點檔案勝率 —— 巡邏時剛好沒觸發就看不到,所以直接讀函式本身)
    if (!SCOPE || SCOPE.has('pages')) {
        const COND_FNS = ['_renderBrokerFenDian', '_tomorrowWatchHtml', '_dtBattleExtras', '_brokerProfileHtml', '_brokerBookExtraHtml', '_brokerRanksHtml', '_brokerRankListHtml', '_brokerGodTag'];
        const srcs = await page.evaluate(fs => fs.map(f => [f, typeof app[f] === 'function' ? app[f].toString() : '']), COND_FNS);
        if (process.env.INJECT) srcs.push(['__inject', "x = `<div>實測 20 日 +1.2pp</div>`;"]);
        for (const [f, src] of srcs) {
            if (!src) { all[`${strat}:src_${f}`] = [{ line: `找不到函式 ${f}(空過守門)`, bad: ['MISSING'] }]; continue; }
            const hits = [];
            // ⚠️ template 裡的 HTML 註解不會畫在畫面上(同原始碼註解)→ 先整段剝掉
            for (const raw of src.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
                const s = raw.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, '');
                if (!s.trim() || /_labMode/.test(s)) continue;
                const b = badOf(s); if (b.length) hits.push({ line: `[src ${f}] ` + s.trim().slice(0, 180), bad: b });
            }
            all[`${strat}:src_${f}`] = hits;
        }
    }
    await page.close();
}
await browser.close();

let total = 0; const seenLine = new Set();
for (const [k, hits0] of Object.entries(all)) {
    const hits = hits0.filter(h => !seenLine.has(h.line)); hits.forEach(h => seenLine.add(h.line));
    if (!hits.length) continue;
    total += hits.length;
    console.log(`\n=== ${k}  (${hits.length})`);
    for (const h of hits.slice(0, REPORT ? 400 : 12)) console.log(`  ${h.line}   ⟵ ${h.bad.join(' ')}`);
}
console.log(`\n頁面數 ${Object.keys(all).length} ・違規行 ${total} ・pageerror ${errs.length}`);
if (errs.length) console.log(errs.slice(0, 5).join('\n'));
if (Object.keys(all).length < (SCOPE ? 1 : 5)) { console.log('❌ 掃到的頁面太少(空過守門)'); process.exit(1); }
if (REPORT) process.exit(0);
if (total || errs.length) { console.log('❌ RETAIL_CLEAN_FAIL'); process.exit(1); }
console.log('✅ RETAIL_CLEAN_PASS');
