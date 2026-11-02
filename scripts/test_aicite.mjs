#!/usr/bin/env node
/**
 * 🗂️🔎 App 內 AI 回答底下兩行:「這段用到哪些資料」+「引用核對」(數字核對 _aiNumGate 的延伸)
 *
 *  Ⓐ 純函式(node 直接跑;函式原文從 index.html 抽出來):
 *   ① _aiCodeHits:「台積電(2330)」「錩新 2415」「代號 2415」「00878」「00631L」「全形２３３０」算代號;股價剛好是某檔代號(「台積電收 2415」)⛔ 算;
 *      「2025 年」「1085 元」「2330 張」「12330」「2330.5」「2,330」⛔ 算;清單沒載入時只認括號裡 / 00 開頭的
 *   ② _aiQuoteGate:提示詞裡沒有的代號 / 3 個字以上的公司名 / 「引號裡的話」→ 未核對;有的 → 過;
 *      2 個字的股名、常用詞股名(台灣大…)、只有數字的引號 ⛔ 核對;沒有提示詞 → null(⛔ 假裝核對過)
 *      本站股名表對得上的算過(提示詞寫台積電、回答寫 2330);決定性對照:名字代號都不在提示詞 → 照報
 *   ③ 跟數字核對的分工:代號⛔ 算成「數字」、⛔ 被遮成〔數字已遮〕(遮只給數字);數字照遮
 *   ④ _aiNumGate(…, used):用到的資料去重存進結果;_aiNumGateHtml 三行(用到 → 數字 → 引用);
 *      全部對得上又沒有 used → 一個字都不印(舊行為)
 *  Ⓑ 畫面(Playwright;AI 換成假的,回答裡塞一個提示詞沒有的代號 + 引號):
 *   ⑤ 盤前速報 / 新聞綜合 / 總經深度 / 事件影響 / 報告頁 App 內模型 五處都有「🗂️ 這段用到」,而且只列提示詞裡真的有的
 *      (新聞那支寫「新聞 1 則」、事件那支寫「只有事件名稱」、報告頁有「K 線到 …」)
 *   ⑥ 五處都有 🔎 未核對那一行、代號在正文看得到(⛔ 遮);決定性對照:回答只用提示詞裡的 → ⛔ 出現
 *   ⑦ 快取重開(新聞 / 總經)兩行還在
 *   ⑧ 新的字 ⛔ 🔴🟢、⛔ 研究字樣;⓪ 沒有 pageerror
 * 跑法:node scripts/test_aicite.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractMember } from './col_rate_base.mjs';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) FAIL.push(n); };

// ── Ⓐ ──
const lit = (n, re) => { const m = re.exec(SRC); if (!m) throw new Error('index.html 找不到 ' + n); return `${n}: ${m[1]}`; };
const NEED = ['_escHtml', '_AI_NUM_SCALE', '_aiNumTokens', '_aiNumGate', '_aiNumGateHtml', '_aiSrcHtml', '_aiStockRef', '_aiCodeHits', '_aiCodeBlank', '_aiQuoteGate', '_aiQuoteGateHtml', '_aiNumRedact', '_aiNumMaskHtml'];
const A = (0, eval)(`({${[lit('_AI_NAME_SKIP', /\n    _AI_NAME_SKIP: (\[[^\]]*\]),/), lit('_AI_NUM_SENT', /\n    _AI_NUM_SENT: ('[^']*'),/), ...NEED.map(n => extractMember(SRC, n))].join(',\n')}})`);
const LIST = [['2330', '台積電'], ['2454', '聯發科'], ['2317', '鴻海'], ['0050', '元大台灣50'], ['00878', '國泰永續高股息'], ['00631L', '元大台灣50正2'], ['2025', '千興'], ['3045', '台灣大'], ['3711', '日月光投控'], ['2415', '錩新']];
A.allStockList = LIST.map(([stock_id, stock_name]) => ({ stock_id, stock_name }));
const ids = A._aiStockRef().ids;
const H = (t, s = ids) => A._aiCodeHits(t, s, s === ids ? A._aiStockRef().nameOf : undefined).map(h => h.s);
ok('① 「台積電(2330)」「00878 國泰永續高股息」「00631L」算代號', JSON.stringify(H('台積電(2330)、00878 國泰永續高股息、00631L')) === '["2330","00878","00631L"]', H('台積電(2330)、00878 國泰永續高股息、00631L'));
ok('① 「2025 年」「1085 元」「2330 張」⛔ 算代號(後面接單位)', !H('2025 年、1085 元、成交 2330 張、漲 2330 點').length, H('2025 年、1085 元、成交 2330 張、漲 2330 點'));
ok('① 「12330」「2330.5」「2,330」「2026/10/30」「13:30」⛔ 算代號', !H('12330、2330.5、2,330、2026/10/30、13:30、-2330').length, H('12330、2330.5、2,330、2026/10/30、13:30、-2330'));
ok('① 「代號名稱:2330 台積電」(半形冒號後面)要認得(報告頁提示詞就是這樣寫的)', JSON.stringify(H('代號名稱:2330 台積電')) === '["2330"]', H('代號名稱:2330 台積電'));
ok('① 緊貼自己的股名 / 「代號」後面算代號:「錩新 2415」「2415錩新」「代號 2415」', JSON.stringify(H('錩新 2415、2415錩新、代號 2415')) === '["2415","2415","2415"]', H('錩新 2415、2415錩新、代號 2415'));
ok('① ⭐ 股價剛好是某檔代號 ⛔ 算代號:「台積電收 2415」「站上 2415」的 2415 是價錢(錩新的代號也是 2415)', !H('台積電收 2415(+1.2%),站上 2415 之後').length, H('台積電收 2415(+1.2%),站上 2415 之後'));
ok('① 全形數字「２３３０」也認得', JSON.stringify(H('台積電（２３３０）')) === '["2330"]');
ok('① 不在全市場清單裡的四位數 ⛔ 算(清單有載入時)', !H('門檻 9999 那一檔').length);
const none = new Set();
ok('① 清單沒載入 → 只認括號裡 / 00 開頭的(⛔ 每個四位數都當代號)', JSON.stringify(H('台積電(2330)、0050、加權 2330 那一段', none)) === '["2330","0050"]', H('台積電(2330)、0050、加權 2330 那一段', none));
const ref = A._aiStockRef();
const src = '代號名稱:2330 台積電;雷達:2317鴻海;注意「拉積盤」效應;成交 1,149 億';
const out = '台積電(2330)跟聯發科(2454)、0050、日月光投控都有提到「拉積盤」,也有人說「史上最強」;鴻海那檔照舊,台灣大盤今天偏弱;「12.3%」';
const q = A._aiQuoteGate(src, out, ref);
const has = (k, s) => q.miss.some(x => x.k === k && x.s === s);
ok('② 提示詞沒有的 → 未核對:代號 2454、0050、公司名 聯發科、日月光投控、引號「史上最強」', has('code', '2454') && has('code', '0050') && has('name', '聯發科') && has('name', '日月光投控') && has('quote', '史上最強'), JSON.stringify(q));
ok('② 提示詞有的 → 過(2330、台積電、「拉積盤」)', !has('code', '2330') && !has('name', '台積電') && !has('quote', '拉積盤'), JSON.stringify(q.miss));
ok('② 2 個字的股名(鴻海)、常用詞股名(台灣大 ← 台灣大盤)、只有數字的引號 ⛔ 核對', !q.miss.some(x => /鴻海|台灣大|12\.3/.test(x.s)) && q.miss.length === 5, JSON.stringify(q.miss));
ok('② 共核對幾個要誠實(⛔ 只報錯的)', q.checked === 8, q.checked);
// 本站股名表也對得上的算過(提示詞寫名字、回答寫代號,或反過來);名字跟代號對不起來的照報
const q2 = A._aiQuoteGate('今天新聞:台積電法說會;雷達:3711', '台積電(2330)、日月光投控(3711)、聯發科(2330)', ref);
ok('② 提示詞寫「台積電」、回答寫 2330 → 用本站股名表對得上(⛔ 每次都報成未核對,那一行天天出現就沒人看)', !q2.miss.some(x => x.s === '2330' || x.s === '台積電' || x.s === '日月光投控' || x.s === '3711'), JSON.stringify(q2.miss));
ok('② 決定性對照:名字跟代號都不在提示詞(聯發科)→ 照報', q2.miss.some(x => x.k === 'name' && x.s === '聯發科') && q2.miss.length === 1, JSON.stringify(q2.miss));
const q3 = A._aiQuoteGate('外資買超 2330 張', '台積電(2330)', ref);
ok('② 提示詞裡「2330 張」是數量 ⛔ 算出現過代號 2330(⛔ 回答亂寫的代號因此過關)', q3.miss.some(x => x.k === 'code' && x.s === '2330'), JSON.stringify(q3.miss));
ok('② 沒有提示詞 / 沒有回答 → null(⛔ 假裝核對過)', A._aiQuoteGate('', out, ref) === null && A._aiQuoteGate(src, '', ref) === null);
ok('② 引號裡多了空白也算同一句(⛔ 一個空白就誤報)', A._aiQuoteGate('他說「拉 積盤」', '「拉積盤」', ref).miss.length === 0);
// ③ 分工
const ng = A._aiNumGate('代號名稱:2330 台積電,收盤 704.4 元', '聯發科(2454)目標價 1,888 元,台積電(2330)收盤 704.4 元');
ok('③ 代號⛔ 算成數字(數字核對只報 1,888 元)、引用核對報 2454', JSON.stringify(ng.miss) === '["1,888 元"]' && ng.q && ng.q.miss.some(x => x.s === '2454'), JSON.stringify(ng));
const red = A._aiNumRedact('聯發科(2454)目標價 1,888 元', ng);
ok('③ ⭐ 遮只給數字:1,888 元遮掉、2454 ⛔ 遮', red.n === 1 && red.text.includes('2454') && !red.text.includes('1,888'), red.text);
const ng3 = A._aiNumGate('台積電收盤 2,380 元', '台積電收 2415,比昨天高');
ok('③ 決定性對照:股價剛好是代號(2415)→ 還是數字核對在管(對不上照遮),⛔ 被當成代號放過', ng3.miss.includes('2415') && !(ng3.q && ng3.q.miss.some(x => x.k === 'code')) && A._aiNumRedact('台積電收 2415,比昨天高', ng3).n === 1, JSON.stringify(ng3));
// ④ used + HTML
const ng2 = A._aiNumGate('收盤 704.4 元', '收盤 704.4 元', ['K 線到 10/30(五)', '三大法人', '三大法人', '', null]);
ok('④ 用到的資料去重、空的不收', JSON.stringify(ng2.used) === '["K 線到 10/30(五)","三大法人"]', JSON.stringify(ng2.used));
const h3 = A._aiNumGateHtml({ ...ng, used: ['K 線到 10/30(五)'] }, 1);
ok('④ 三行的順序:🗂️ 用到 → ⚠️ 數字核對 → 🔎 引用核對', h3.indexOf('data-aisrc') >= 0 && h3.indexOf('data-aisrc') < h3.indexOf('data-ainumgate') && h3.indexOf('data-ainumgate') < h3.indexOf('data-aiquote'), h3);
ok('④ 「這段用到:K 線到 10/30(五)」', /🗂️ 這段用到:K 線到 10\/30\(五\)/.test(h3));
ok('④ 未核對那一行:列出來、⛔ 說遮掉、標「未核對」', /未核對/.test(h3) && /2454/.test(h3) && !/data-aiquote[^>]*>[^<]*〔/.test(h3));
ok('④ 舊行為不變:全部對得上又沒有 used → 一個字都不印', A._aiNumGateHtml({ checked: 3, miss: [] }) === '' && A._aiNumGateHtml(null) === '');

// ── Ⓑ ──
const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS|echarts|Cache\.put|file' is unsupported/i.test(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._aiQuoteGate, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const K2330 = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2330.json'), 'utf8')); } catch (_) { return null; } })();
const NAMES = (() => { try { const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stock_names.json'), 'utf8')); return Object.entries(j.names || {}).map(([k, v]) => ({ stock_id: k, stock_name: Array.isArray(v) ? v[0] : v })); } catch (_) { return null; } })();
const R = await page.evaluate(async ({ K, NAMES, LIST }) => {
    const A = app, o = {};
    A.allStockList = NAMES && NAMES.length > 500 ? NAMES : LIST.map(([stock_id, stock_name]) => ({ stock_id, stock_name }));
    A._aiRefCache = null;
    o.nList = A.allStockList.length;
    const FAKE = '9958';   // 世紀鋼(真的有這一檔)—— 提示詞裡一定沒有
    let reply = '';
    const captured = [];
    A._hasAnyAIKey = () => true; A._hasDeepAIKey = () => true;
    A._callDeepAI = async (x) => { captured.push(x.prompt || (x.prompts && x.prompts.full) || ''); return reply; };
    A._callAI = A._callDeepAI; A.showToast = () => {}; A.vibrate = () => {};
    const grab = el => el ? { html: el.innerHTML, src: el.querySelector('[data-aisrc]')?.textContent || '', quote: el.querySelector('[data-aiquote]')?.textContent || '', vis: el.textContent } : { html: '', src: '', quote: '', vis: '' };
    const fake = `世紀鋼(${FAKE})值得留意,有人說「史上最強」`;
    // 盤前速報
    reply = fake;
    try { await A.runGlobalMarketAI(); } catch (_) {}
    const gmEl = () => document.getElementById('globalAIModalBody') || document.getElementById('globalAIResult');
    o.gm = grab(gmEl()); o.gmPrompt = captured[captured.length - 1] || '';
    reply = '今天只看數據。';
    try { await A.runGlobalMarketAI(); } catch (_) {}
    o.gm2 = grab(gmEl());
    // 新聞
    A._globalNewsItems = [{ title_zh: '台積電法說會釋出樂觀展望', impact_level: 'bullish' }];
    try { localStorage.removeItem(A._newsDeepKey()); } catch (_) {}
    reply = fake; A._newsDeepRunning = false; await A._deepAnalyzeNews();
    o.nw = grab(document.getElementById('newsDeepBox'));
    document.getElementById('newsDeepBox').innerHTML = ''; A._restoreNewsDeep();
    o.nwCache = grab(document.getElementById('newsDeepBox'));
    reply = '台積電法說會偏樂觀,那幾天波動會變大。'; A._newsDeepRunning = false; await A._deepAnalyzeNews();
    o.nw2 = grab(document.getElementById('newsDeepBox'));
    // 總經
    A._macroRiskCache = Object.assign({}, A._macroRiskCache || {}, { upcoming_macro_events: [{ date: '2026-11-05', event: 'FOMC', level: '高', days: 3 }] });
    try { localStorage.removeItem(A._macroDeepKey()); } catch (_) {}
    reply = fake; A._macroDeepRunning = false; await A._deepAnalyzeMacro();
    o.mc = grab(document.getElementById('macroDeepBox'));
    document.getElementById('macroDeepBox').innerHTML = ''; A._restoreMacroDeep();
    o.mcCache = grab(document.getElementById('macroDeepBox'));
    // 事件
    const box = document.createElement('div'); box.id = 'evImpact_zz'; box.className = 'hidden'; document.body.appendChild(box);
    try { localStorage.removeItem('evImpact2_測試事件Q'); } catch (_) {}
    reply = fake; await A.askEventImpactAI('測試事件Q', 'zz', false);
    o.ev = grab(box);
    // 報告頁(App 內模型)
    if (K) {
        A.switchAppTab && A.switchAppTab('diag');
        A.currentSymbolId = '2330'; A.rawDailyData = JSON.parse(JSON.stringify(K)); A.activeData = A.rawDailyData; A.baseRawData = A.rawDailyData;
        try { A.switchSubTab('report'); await A.renderReportTab('2330'); } catch (_) {}
        await new Promise(r => setTimeout(r, 800));
        A._rpGenPick = () => 'gemini';
        A.idb.put = async () => true;
        reply = '§1 結論\n台積電(2330)與' + fake;
        try { await A._rpGenRun('2330'); } catch (e) { o.rpErr = String(e); }
        const rec = (A._rpNoteCache || {})['2330'];
        o.rpUsed = rec && rec.ng ? rec.ng.used : null;
        o.rpQ = rec && rec.ng && rec.ng.q ? rec.ng.q.miss : null;
        o.rpHtml = A._aiNumGateHtml(rec && rec.ng, 0);
    }
    return o;
}, { K: K2330, NAMES, LIST });

const T = h => String(h || '').replace(/<[^>]+>/g, ' ');
ok('Ⓑ⓪ 全市場股名清單有載入(⛔ 只拿 9 檔假清單在驗)', R.nList > 500, R.nList);
ok('⑤ 盤前速報:「🗂️ 這段用到」列出提示詞裡真的有的(加權 / 雷達…至少一類)', /這段用到:/.test(R.gm.src) && R.gm.src.split('、').length >= 1, R.gm.src);
ok('⑤ 新聞綜合:寫「新聞 1 則」', /新聞 1 則/.test(R.nw.src), R.nw.src);
ok('⑤ 總經深度:寫「財經行事曆 1 件」', /財經行事曆 1 件/.test(R.mc.src), R.mc.src);
ok('⑤ 事件影響:提示詞只有事件名稱 → 照實寫', /只有事件名稱/.test(R.ev.src), R.ev.src);
if (K2330) {
    ok('⑤ 報告頁(App 內模型):存下來的結果帶「K 線到 …」等用到的資料', Array.isArray(R.rpUsed) && R.rpUsed.some(x => /^K 線到 /.test(x)), JSON.stringify(R.rpUsed) + (R.rpErr || ''));
    ok('⑥ 報告頁:9958 未核對、2330 ⛔ 被報(提示詞裡有)', Array.isArray(R.rpQ) && R.rpQ.some(x => x.s === '9958') && !R.rpQ.some(x => x.s === '2330'), JSON.stringify(R.rpQ));
    ok('⑤ 報告頁那三行畫得出來(🗂️ + 🔎)', /data-aisrc/.test(R.rpHtml) && /data-aiquote/.test(R.rpHtml), R.rpHtml.slice(0, 200));
} else ok('⑤ 報告頁:data/2330.json 不在(先跑 bash scripts/fetch_testdata.sh)—— ⛔ 不假裝測過', false);
for (const [nm, g] of [['盤前速報', R.gm], ['新聞綜合', R.nw], ['總經深度', R.mc], ['事件影響', R.ev]]) {
    ok(`⑥ ${nm}:🔎 未核對列出 9958、「史上最強」,而且 9958 在正文看得到(⛔ 遮)`, /9958/.test(g.quote) && /史上最強/.test(g.quote) && /未核對/.test(g.quote) && T(g.html.replace(/<div data-aiquote[\s\S]*?<\/div>/, '')).includes('9958'), g.quote + ' | ' + T(g.html).slice(0, 160));
}
ok('⑥ ⭐ 決定性對照:回答只用提示詞裡的 → 🔎 那一行 ⛔ 出現(盤前 / 新聞)', !R.gm2.quote && !R.nw2.quote && /這段用到/.test(R.nw2.src), `${R.gm2.quote} | ${R.nw2.quote}`);
ok('⑦ 快取重開(新聞 / 總經):🗂️ 與 🔎 兩行還在', /新聞 1 則/.test(R.nwCache.src) && /9958/.test(R.nwCache.quote) && /財經行事曆/.test(R.mcCache.src) && /9958/.test(R.mcCache.quote));
const ALL = [R.gm.html, R.nw.html, R.mc.html, R.ev.html, R.rpHtml || ''].join('\n');
const pick = h => (h.match(/<div data-ai(?:src|quote)[\s\S]*?<\/div>/g) || []).join('\n');
ok('⑧ 新的兩行 ⛔ 🔴🟢', !/[🔴🟢]/u.test(pick(ALL)), pick(ALL).slice(0, 200));
const bad = badOf(T(pick(ALL)));
ok('⑧ 新的兩行 ⛔ 研究字樣', !bad.length, bad.join(' '));
ok('⓪ 沒有 pageerror', !errs.length, errs.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${FAIL.length ? '❌ ' + FAIL.length + ' 項失敗' : '✅ 全部通過'}`);
process.exit(FAIL.length ? 1 : 0);
