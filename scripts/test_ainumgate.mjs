// 🧾 V77.8.1 AI 回答「數字核對」守門(go-stock agent_fact_check 的做法,評估紀錄㊴)
//  ⓐ 抽取:日期 / 時間 / § / 編號 / 年份 / 無單位小整數 ⛔ 不收;帶單位的與小數要收
//  ⓑ 格式變體⛔ 不可誤報(千分位 / 四捨五入 / 兆↔億 / 萬張 / 正負號 / 約)
//  ⓒ 決定性對照(真實資料):2330 的研究提示詞與盤前速報提示詞 → 換格式重述 → 0 個找不到;插一個編的 → 恰好 1 個
//  ⓓ 真實案例(V76.2.3):提示詞 704.4 / 606.9,回答寫 707.4 / 594.5 → 兩個都抓到
//  ⓔ 接線:5 支函式原始碼都呼叫 _aiNumGate;盤前速報 / 總經 / 新聞 / 事件 四處 stub AI 回編造數字 → 畫面出現核對行,忠實回答 → 不出現
//  ⓕ 燈號:核對行⛔ 不可有 🔴🟢;src 空 → null(⛔ 不可假裝核對過)
// 跑法:node scripts/test_ainumgate.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 260)}`); if (!c) FAIL.push(n); };

// ── ⓔs 靜態:五支函式都接上(先剝掉 // 註解,⛔ 不可被註解救活)──
const fnBody = (name) => {
    const i = SRC.search(new RegExp(`\\n    (async )?${name}\\(`)); if (i < 0) return '';
    const j = SRC.slice(i + 10).search(/\n    (async )?[_a-zA-Z0-9]+\([^)]*\) *\{/);
    return SRC.slice(i, i + 10 + (j < 0 ? 20000 : j)).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
};
const sites = ['runGlobalMarketAI', '_deepAnalyzeMacro', '_deepAnalyzeNews', 'askEventImpactAI', '_rpGenRun'];
const unwired = sites.filter(n => !/_aiNumGate\(/.test(fnBody(n)));
ok('ⓔs 五支 App 內 AI 文字輸出都呼叫 _aiNumGate', unwired.length === 0, unwired.join(','));
ok('ⓔs2 總經 / 新聞的重畫函式都會印核對行(快取重開也看得到)', ['_renderMacroDeep', '_renderNewsDeep'].every(n => /_aiNumGateHtml\(ng\)/.test(fnBody(n))), '');
ok('ⓔs3 報告頁只對 App 內模型核對(offline)⛔ 外部 AI 貼上的不核對', /n\.offline \? this\._aiNumGateHtml\(n\.ng\)/.test(SRC), '');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS|echarts|Cache\.put|file' is unsupported/i.test(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._aiNumGate, null, { timeout: 30000 });
await page.waitForTimeout(1500);

const K2330 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2330.json'), 'utf8'));

const R = await page.evaluate(async (K) => {
    const A = app, G = (s, o) => A._aiNumGate(s, o);
    const toks = s => A._aiNumTokens(s, true).map(x => x.s);
    // ⓐ 抽取
    const ext = toks('2026-09-27 13:30 §3 第2 1. 首先 2025年 9月27日 20 日線 3 檔 T+20 Q3 ・收盤 704.4 元,漲 1.23%,成交 1,149 億,放大 1.5 倍,本益比 36.6');
    // ⓑ 變體
    const src = '收盤 704.43 元,月線 606.9,成交金額 1,149.18 億,外資賣超 −12,345 張,集中市場成交值 1.2 兆,漲跌 -1.25%,位階 38%';
    const variants = '收盤約 704.4 元,月線 607,成交 1149 億,外資賣 12,345 張(約 1.2 萬張),成交值 12,000 億,跌 1.25%,位階 38.0%,大約 700 元左右';
    // ⓓ 真實案例
    const caseSrc = '季線 704.4 ・半年線 606.9 ・現價 752';
    const caseOut = '季線 707.4 元、半年線 594.5 元,現價 752 元';
    // ⓒ 真實資料:2330 研究提示詞(走正式入口)
    A.switchAppTab && A.switchAppTab('diag');
    A.currentSymbolId = '2330'; A.rawDailyData = JSON.parse(JSON.stringify(K)); A.activeData = A.rawDailyData; A.baseRawData = A.rawDailyData;
    try { A.switchSubTab('report'); await A.renderReportTab('2330'); } catch (_) {}
    await new Promise(r => setTimeout(r, 800));
    let rp = ''; try { rp = A._reportPrompt('2330') || ''; } catch (e) { rp = ''; }
    const restate = (s) => A._aiNumTokens(s, true).map((x, i) => {
        // 換格式:少一位小數、千分位、有時加「約」
        const d = (String(x.raw).split('.')[1] || '').length;
        const v = d > 0 ? x.raw.toFixed(Math.max(0, d - 1)) : String(Math.round(x.raw));
        const withSep = Math.abs(+v) >= 1000 ? (+v).toLocaleString('en-US', { maximumFractionDigits: 6 }) : v;
        const unit = (x.s.match(/(兆|億|萬|%|pp|個百分點|倍|元|張|口|點)$/) || [''])[0];
        return `${i % 3 === 0 ? '約 ' : ''}${withSep} ${unit}`;
    }).join(',');
    const rpRe = restate(rp);
    const rpClaims = A._aiNumTokens(rpRe, true).length;
    const rpGate = G(rp, rpRe), rpGateInj = G(rp, rpRe + ',另外季線 707.4 元');
    // ⓔ 接線(headless):stub AI
    let reply = 'X';
    const captured = [];
    A._hasAnyAIKey = () => true;
    A._callDeepAI = async (o) => { captured.push(o.prompt || (o.prompts && o.prompts.full) || ''); return reply; };
    A._callAI = A._callDeepAI;
    A.showToast = () => {}; A.vibrate = () => {};
    // 盤前速報
    reply = '今日重點:外資賣超 98,765 張,季線 12,345.6 點';
    try { await A.runGlobalMarketAI(); } catch (_) {}
    const gmPrompt = captured[captured.length - 1] || '';
    const gmHtml = (document.getElementById('globalAIModalBody') || document.getElementById('globalAIResult') || {}).innerHTML || '';
    // 盤前速報的忠實回答:拿它自己的提示詞重述
    reply = restate(gmPrompt).slice(0, 1500) || '沒有數字';
    try { await A.runGlobalMarketAI(); } catch (_) {}
    const gmHtml2 = (document.getElementById('globalAIModalBody') || document.getElementById('globalAIResult') || {}).innerHTML || '';
    const gmGate = G(gmPrompt, restate(gmPrompt));
    // 總經
    A._macroRiskCache = Object.assign({}, A._macroRiskCache || {}, { upcoming_macro_events: [{ date: '2026-10-01', event: 'FOMC', level: '高', days: 3 }] });
    reply = '要盯的數字:VIX 如果衝到 87.65 就要小心';
    try { localStorage.removeItem(A._macroDeepKey()); } catch (_) {}
    A._macroDeepRunning = false; await A._deepAnalyzeMacro();
    const mcHtml = (document.getElementById('macroDeepBox') || {}).innerHTML || '';
    const mcCache = JSON.parse(localStorage.getItem(A._macroDeepKey()) || 'null');
    reply = 'FOMC 那幾天波動會變大,盯利率決議。';
    A._macroDeepRunning = false; await A._deepAnalyzeMacro();
    const mcHtml2 = (document.getElementById('macroDeepBox') || {}).innerHTML || '';
    // 新聞
    A._globalNewsItems = [{ title_zh: '台積電法說會釋出樂觀展望', impact_level: 'bullish' }];
    reply = '法說會後外資目標價上調到 1,888 元';
    try { localStorage.removeItem(A._newsDeepKey()); } catch (_) {}
    A._newsDeepRunning = false; await A._deepAnalyzeNews();
    const nwHtml = (document.getElementById('newsDeepBox') || {}).innerHTML || '';
    reply = '法說會偏樂觀,那幾天波動會變大。';
    A._newsDeepRunning = false; await A._deepAnalyzeNews();
    const nwHtml2 = (document.getElementById('newsDeepBox') || {}).innerHTML || '';
    // 事件
    const box = document.createElement('div'); box.id = 'evImpact_zz'; box.className = 'hidden'; document.body.appendChild(box);
    try { localStorage.removeItem('evImpact2_測試事件X'); } catch (_) {}
    reply = '半導體族群波動大,指數可能震盪 543.2 點';
    await A.askEventImpactAI('測試事件X', 'zz', false);
    const evHtml = box.innerHTML;
    try { localStorage.removeItem('evImpact2_測試事件Y'); } catch (_) {}
    reply = '半導體族群那幾天波動會變大。';
    box.innerHTML = ''; box.classList.add('hidden');   // ⚠️ 手動點第二次 = 收起來(那是它的正常行為)→ 先復位
    await A.askEventImpactAI('測試事件Y', 'zz', false);
    const evHtml2 = box.innerHTML;
    return {
        ext, vGate: G(src, variants), caseGate: G(caseSrc, caseOut), nullSrc: G('', caseOut), nullSrc2: G(null, caseOut),
        rpLen: rp.length, rpClaims, rpGate, rpGateInj, gmLen: gmPrompt.length, gmGate,
        gm: /data-ainumgate/.test(gmHtml), gm2: /data-ainumgate/.test(gmHtml2), gmSnip: (gmHtml.match(/數字核對[^<]*<b>\d+/) || [''])[0],
        mc: /data-ainumgate/.test(mcHtml), mc2: /data-ainumgate/.test(mcHtml2), mcCacheNg: mcCache && mcCache.ng,
        nw: /data-ainumgate/.test(nwHtml), nw2: /data-ainumgate/.test(nwHtml2),
        ev: /data-ainumgate/.test(evHtml), ev2: /data-ainumgate/.test(evHtml2),
        gateLine: A._aiNumGateHtml({ checked: 3, miss: ['707.4', '12.3%'] }), emptyLine: A._aiNumGateHtml({ checked: 3, miss: [] }),
    };
}, K2330);

const has = (arr, s) => arr.some(x => x.includes(s));
ok('ⓐ 日期 / 時間 / § / 第N / 編號 / 年份 / 月日 / 天數 / T+N / Q3 ⛔ 不收', !['2026', '09', '13', '30', '27', '20 日'].some(s => R.ext.includes(s)) && !has(R.ext, '2025') && !R.ext.some(x => /^3$|^2$|^1$/.test(x)), R.ext.join(' | '));
ok('ⓐ2 帶單位的與小數要收(704.4 元 / 1.23% / 1,149 億 / 1.5 倍 / 36.6)', ['704.4 元', '1.23%', '1,149 億', '1.5 倍', '36.6'].every(s => R.ext.includes(s)), R.ext.join(' | '));
ok('ⓑ 格式變體⛔ 不誤報(四捨五入 / 千分位 / 兆↔億 / 萬張 / 正負號 / 約 700)', R.vGate && R.vGate.miss.length === 0 && R.vGate.checked >= 8, JSON.stringify(R.vGate));
ok('ⓓ 真實案例:707.4 / 594.5 都抓到,752 不誤報', R.caseGate && R.caseGate.miss.includes('707.4 元') && R.caseGate.miss.includes('594.5 元') && R.caseGate.miss.length === 2, JSON.stringify(R.caseGate));
ok('ⓒ0 空過守門:2330 研究提示詞真的產出來、而且重述後有 ≥20 個數字可核對', R.rpLen > 1500 && R.rpClaims >= 20, `len=${R.rpLen} claims=${R.rpClaims}`);
ok('ⓒ 決定性對照(真實資料):研究提示詞重述 → 0 個找不到(= 在真實事實上量誤報)', R.rpGate && R.rpGate.miss.length === 0, JSON.stringify(R.rpGate && R.rpGate.miss.slice(0, 8)));
ok('ⓒ2 同一段插一個編的(季線 707.4 元)→ 恰好 1 個', R.rpGateInj && R.rpGateInj.miss.length === 1 && R.rpGateInj.miss[0] === '707.4 元', JSON.stringify(R.rpGateInj && R.rpGateInj.miss));
ok('ⓒ3 盤前速報提示詞(真的組出來的)重述 → 0 個找不到', R.gmLen > 500 && R.gmGate && R.gmGate.checked >= 5 && R.gmGate.miss.length === 0, `len=${R.gmLen} ${JSON.stringify(R.gmGate && { c: R.gmGate.checked, m: R.gmGate.miss.slice(0, 8) })}`);
ok('ⓔ 盤前速報:編造數字 → 核對行出現;忠實重述 → 不出現', R.gm && !R.gm2, `${R.gm} ${R.gm2} ${R.gmSnip}`);
ok('ⓔ2 總經深度分析:編造 → 出現;忠實 → 不出現;快取有存 ng', R.mc && !R.mc2 && R.mcCacheNg && Array.isArray(R.mcCacheNg.miss), `${R.mc} ${R.mc2} ${JSON.stringify(R.mcCacheNg)}`);
ok('ⓔ3 新聞綜合分析:編造 → 出現;忠實 → 不出現', R.nw && !R.nw2, `${R.nw} ${R.nw2}`);
ok('ⓔ4 事件影響:編造 → 出現;忠實 → 不出現', R.ev && !R.ev2, `${R.ev} ${R.ev2}`);
ok('ⓕ 核對行⛔ 不可有 🔴🟢、要有 ⚠️ 與「別拿來下單」;全部對得上 → 空字串', !/[🔴🟢]/u.test(R.gateLine) && /⚠️/.test(R.gateLine) && /別拿來下單/.test(R.gateLine) && R.emptyLine === '', R.gateLine);
ok('ⓕ2 沒有提示詞 → null(⛔ 不可假裝核對過)', R.nullSrc === null && R.nullSrc2 === null, JSON.stringify([R.nullSrc, R.nullSrc2]));
ok('⓪ 沒有 pageerror', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
console.log(FAIL.length ? `❌ ${FAIL.length} 條沒過` : '✅ 全部通過');
process.exit(FAIL.length ? 1 : 0);
