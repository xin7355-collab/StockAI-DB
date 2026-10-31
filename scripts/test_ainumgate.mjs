// 🧾 V77.8.1 AI 回答「數字核對」守門(go-stock agent_fact_check 的做法,評估紀錄㊴)
//  ⓐ 抽取:日期 / 時間 / § / 編號 / 年份 / 無單位小整數 ⛔ 不收;帶單位的與小數要收
//  ⓑ 格式變體⛔ 不可誤報(千分位 / 四捨五入 / 兆↔億 / 萬張 / 正負號 / 約)
//  ⓒ 決定性對照(真實資料):2330 的研究提示詞與盤前速報提示詞 → 換格式重述 → 0 個找不到;插一個編的 → 恰好 1 個
//  ⓓ 真實案例(V76.2.3):提示詞 704.4 / 606.9,回答寫 707.4 / 594.5 → 兩個都抓到
//  ⓔ 接線:5 支函式原始碼都呼叫 _aiNumGate;盤前速報 / 總經 / 新聞 / 事件 四處 stub AI 回編造數字 → 畫面出現核對行,忠實回答 → 不出現
//  ⓕ 燈號:核對行⛔ 不可有 🔴🟢;src 空 → null(⛔ 不可假裝核對過)
//  ⓖ ⓗ V80.1.2 對不上的數字在正文遮掉(邊界不誤遮、全形也遮)、原文在「看原文」;忠實回答一個字都不改
//  ⓘ V80.1.2 盤前速報這一輪沒拿到任何新聞 → 提示詞叫它別寫新聞 + 畫面一行灰字(決定性對照:放一則新聞 → 都不見)
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
ok('ⓔs2 總經 / 新聞的重畫函式都會印核對行 + 遮數字 + 看原文(快取重開也看得到)', ['_renderMacroDeep', '_renderNewsDeep'].every(n => { const b = fnBody(n); return /_aiNumGateHtml\(ng, red\.n\)/.test(b) && /_aiNumRedact\(txt, ng\)/.test(b) && /_aiNumRawHtml\(txt, red\.n\)/.test(b) && /_aiNumMaskHtml\(/.test(b); }), '');
ok('ⓔs3 報告頁只對 App 內模型核對 + 遮(offline)⛔ 外部 AI 貼上的不核對也不遮', /n\.offline \? this\._aiNumGateHtml\(n\.ng, redRp\.n\)/.test(SRC) && /\(n\.offline && n\.ng\) \? this\._aiNumRedact\(n\.t, n\.ng\)/.test(SRC), '');
ok('ⓔs4 🧾 V80.1.2 盤前速報 / 事件影響也遮', /_aiNumRedact\(text, ngG\)/.test(fnBody('runGlobalMarketAI')) && /_aiNumRedact\(text \|\| '', ng\)/.test(fnBody('askEventImpactAI')), '');

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
    const gmVis = (() => { const el = document.getElementById('globalAIModalBody') || document.getElementById('globalAIResult'); if (!el) return { vis: '', raw: '' }; const c = el.cloneNode(true); const d = c.querySelector('[data-ainumraw]'); const raw = d ? d.textContent : ''; if (d) d.remove(); c.querySelectorAll('[data-ainumgate]').forEach(x => x.remove()); return { vis: c.textContent, raw, masks: el.querySelectorAll('[data-ainummask]').length }; })();
    // 盤前速報的忠實回答:拿它自己的提示詞重述
    // 🔁 V79.4.3 機器滿載時,總經 / 報價這些非同步資料可能在兩次呼叫之間才到 → 第二次的提示詞數字跟第一次不同,
    //   「拿第一次重述」就會被當成編的(假紅燈,四驗證實際踩到)。⭐ 改成:重述上一次的提示詞,直到這一次的提示詞
    //   跟上一次一模一樣(資料穩定)才算數;⛔ 斷言本身一個字都沒放寬。
    let gmHtml2 = '', prevP = gmPrompt;
    for (let t = 0; t < 4; t++) {
        reply = restate(prevP).slice(0, 1500) || '沒有數字';
        try { await A.runGlobalMarketAI(); } catch (_) {}
        const curP = captured[captured.length - 1] || '';
        gmHtml2 = (document.getElementById('globalAIModalBody') || document.getElementById('globalAIResult') || {}).innerHTML || '';
        if (curP === prevP) break;
        prevP = curP;
    }
    const gmGate = G(gmPrompt, restate(gmPrompt));
    // 總經
    A._macroRiskCache = Object.assign({}, A._macroRiskCache || {}, { upcoming_macro_events: [{ date: '2026-10-01', event: 'FOMC', level: '高', days: 3 }] });
    reply = '要盯的數字:VIX 如果衝到 87.65 就要小心';
    try { localStorage.removeItem(A._macroDeepKey()); } catch (_) {}
    A._macroDeepRunning = false; await A._deepAnalyzeMacro();
    const mcHtml = (document.getElementById('macroDeepBox') || {}).innerHTML || '';
    const visOf = el => { if (!el) return { vis: '', raw: '' }; const c = el.cloneNode(true); const d = c.querySelector('[data-ainumraw]'); const raw = d ? d.textContent : ''; if (d) d.remove(); c.querySelectorAll('[data-ainumgate]').forEach(x => x.remove()); return { vis: c.textContent, raw, masks: el.querySelectorAll('[data-ainummask]').length }; };
    const mcVis = visOf(document.getElementById('macroDeepBox'));
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
    const nwVis = visOf(document.getElementById('newsDeepBox'));
    reply = '法說會偏樂觀,那幾天波動會變大。';
    A._newsDeepRunning = false; await A._deepAnalyzeNews();
    const nwHtml2 = (document.getElementById('newsDeepBox') || {}).innerHTML || '';
    // 事件
    const box = document.createElement('div'); box.id = 'evImpact_zz'; box.className = 'hidden'; document.body.appendChild(box);
    try { localStorage.removeItem('evImpact2_測試事件X'); } catch (_) {}
    reply = '半導體族群波動大,指數可能震盪 543.2 點';
    await A.askEventImpactAI('測試事件X', 'zz', false);
    const evHtml = box.innerHTML;
    const evVis = visOf(box);
    try { localStorage.removeItem('evImpact2_測試事件Y'); } catch (_) {}
    reply = '半導體族群那幾天波動會變大。';
    box.innerHTML = ''; box.classList.add('hidden');   // ⚠️ 手動點第二次 = 收起來(那是它的正常行為)→ 先復位
    await A.askEventImpactAI('測試事件Y', 'zz', false);
    const evHtml2 = box.innerHTML;
    // ⓘ 📰 V80.1.2 這一輪沒拿到任何新聞 → 提示詞叫 AI 別寫新聞 + 畫面最上面一行灰字;決定性對照:放一則新聞 → 兩個都不見
    const _f0 = window.fetch;
    window.fetch = async (u, o) => String(u).includes('tech_giants_news') ? new Response('x', { status: 404 }) : _f0(u, o);
    const gmEl = () => document.getElementById('globalAIModalBody') || document.getElementById('globalAIResult');
    A._globalNewsItems = []; reply = '今天只看數據。';
    try { await A.runGlobalMarketAI(); } catch (_) {}
    const nn = { p: captured[captured.length - 1] || '', line: !!(gmEl() && gmEl().querySelector('[data-ainonews]')), first: gmEl() && gmEl().firstElementChild && gmEl().firstElementChild.hasAttribute('data-ainonews') };
    A._globalNewsItems = [{ title_zh: '美國 CPI 低於預期', impact_level: 'bullish' }];
    try { await A.runGlobalMarketAI(); } catch (_) {}
    const nn2 = { p: captured[captured.length - 1] || '', line: !!(gmEl() && gmEl().querySelector('[data-ainonews]')) };
    window.fetch = _f0;
    return {
        nn: { guard: /這次沒有拿到任何新聞/.test(nn.p) && /不可寫「無重大事件」/.test(nn.p), line: nn.line, first: !!nn.first,
              guard2: /這次沒有拿到任何新聞/.test(nn2.p) || /不可寫「無重大事件」/.test(nn2.p), line2: nn2.line, news2: /美國 CPI 低於預期/.test(nn2.p) },
        ext, vGate: G(src, variants), caseGate: G(caseSrc, caseOut), nullSrc: G('', caseOut), nullSrc2: G(null, caseOut),
        rpLen: rp.length, rpClaims, rpGate, rpGateInj, gmLen: gmPrompt.length, gmGate,
        gm: /data-ainumgate/.test(gmHtml), gm2: /data-ainumgate/.test(gmHtml2), gmSnip: (gmHtml.match(/數字核對[^<]*<b>\d+/) || [''])[0],
        mc: /data-ainumgate/.test(mcHtml), mc2: /data-ainumgate/.test(mcHtml2), mcCacheNg: mcCache && mcCache.ng,
        nw: /data-ainumgate/.test(nwHtml), nw2: /data-ainumgate/.test(nwHtml2),
        ev: /data-ainumgate/.test(evHtml), ev2: /data-ainumgate/.test(evHtml2),
        gateLine: A._aiNumGateHtml({ checked: 3, miss: ['707.4', '12.3%'] }), emptyLine: A._aiNumGateHtml({ checked: 3, miss: [] }),
        // 🧾 V80.1.2 遮數字
        red: (() => {
            const S = A._AI_NUM_SENT, R1 = A._aiNumRedact('季線 707.4 元,半年線 594.5 元,現價 752 元,707.4 元再寫一次', { miss: ['707.4 元', '594.5 元'] });
            const R2 = A._aiNumRedact('收盤 704.43 元、1,704 張、704 元', { miss: ['704 元'] });
            const R3 = A._aiNumRedact('成交 11,200 張、1,200 張', { miss: ['1,200 張'] });
            const R4 = A._aiNumRedact('原文一字不改 707.4 元', { miss: [] }), R5 = A._aiNumRedact('原文 707.4 元', null);
            const R6 = A._aiNumRedact('ＶＩＸ 衝到 ８７.６５', { miss: ['87.65'] });
            return { r1: R1.text.split(S).length - 1, r1n: R1.n, r1keep: R1.text.includes('752 元'), r1gone: !R1.text.includes('707.4') && !R1.text.includes('594.5'),
                     r2: R2.text, r2n: R2.n, r3: R3.text, r3n: R3.n, r4: R4.text === '原文一字不改 707.4 元' && R4.n === 0, r5: R5.text === '原文 707.4 元' && R5.n === 0,
                     r6n: R6.n, maskHtml: A._aiNumMaskHtml('a' + S + 'b'), raw0: A._aiNumRawHtml('x', 0), raw1: A._aiNumRawHtml('<x>707.4 元', 1), S };
        })(),
        mcVis, nwVis, evVis, gmVis,
        noMask2: !/data-ainummask|data-ainumraw/.test(mcHtml2 + nwHtml2 + evHtml2 + gmHtml2),
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
// 🧾 V80.1.2 遮數字
const D = R.red;
ok('ⓖ 對不上的兩個都遮(重複出現的也遮)、對得上的 752 留著', D.r1 === 3 && D.r1n === 3 && D.r1keep && D.r1gone, JSON.stringify(D));
ok('ⓖ2 邊界:704 元 ⛔ 不可遮到 704.43 元 / 1,704 張', D.r2n === 1 && D.r2.includes('704.43 元') && D.r2.includes('1,704 張') && !D.r2.includes(' 704 元'), D.r2);
ok('ⓖ3 邊界:1,200 張 ⛔ 不可遮到 11,200 張的尾巴', D.r3n === 1 && D.r3.includes('11,200 張'), D.r3);
ok('ⓖ4 全部對得上 / 沒有核對結果 → 一個字都不改', D.r4 && D.r5, '');
ok('ⓖ5 全形數字也遮得到(核對時已經轉半形)', D.r6n === 1, D.r6n);
ok('ⓖ6 標記換成〔數字已遮〕、看原文有跳脫、沒遮就沒有看原文', /〔數字已遮〕/.test(D.maskHtml) && !D.maskHtml.includes(D.S) && D.raw0 === '' && /&lt;x&gt;707\.4 元/.test(D.raw1) && /看原文/.test(D.raw1), D.maskHtml + ' | ' + D.raw1);
const fabr = [['總經', R.mcVis, '87.65'], ['新聞', R.nwVis, '1,888'], ['事件', R.evVis, '543.2'], ['盤前速報', R.gmVis, '98,765']];
for (const [nm, v, num] of fabr) ok(`ⓗ ${nm}:編的數字在正文看不到、看原文看得到、正文有〔數字已遮〕`, v && !v.vis.includes(num) && v.raw.includes(num) && v.masks >= 1, JSON.stringify({ vis: (v && v.vis || '').slice(0, 160), raw: (v && v.raw || '').slice(0, 80), masks: v && v.masks }));
ok('ⓗ2 ⭐ 決定性對照:忠實的回答 → 一個都不遮、沒有看原文', R.noMask2, '');
ok('ⓘ 📰 沒拿到任何新聞 → 提示詞明講「這次沒有拿到任何新聞」、巨頭那段⛔ 寫「無重大事件」;畫面最上面一行灰字', R.nn.guard && R.nn.line && R.nn.first, JSON.stringify(R.nn));
ok('ⓘ2 ⭐ 決定性對照:放一則新聞 → 那句與那行都不見、新聞有進提示詞', !R.nn.guard2 && !R.nn.line2 && R.nn.news2, JSON.stringify(R.nn));
ok('⓪ 沒有 pageerror', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
console.log(FAIL.length ? `❌ ${FAIL.length} 條沒過` : '✅ 全部通過');
process.exit(FAIL.length ? 1 : 0);
