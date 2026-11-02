#!/usr/bin/env node
/**
 * 🗽 V80.2.1 散戶 App「消息面 › 🗽 川普」那一格(_trumpPaneHtml / _trumpWin / _loadTrumpPane)
 *   ① 窗口:台北平日 09:00~13:30(含)= 盤中 → 前一個平日 13:30 ~ 今天 09:00;13:31 以後 → 今天 13:30 ~ 現在;開盤前 / 週末 → 前一個平日 13:30 ~ 現在
 *      (跟 lib_trump.tw_day 同一條規則 —— 用 python 跑 lib_trump 逐點比)
 *   ② 第一行:窗口裡發了幾則(原創)/ 轉貼幾則 / 講到哪幾類(類別一律來自採礦端,⛔ 前端另判)
 *   ③ 🎲 發生率只讀 `_TRUMP_OCC`(⭐ 決定性對照:改裡面的數字畫面跟著變;窗口沒講到任何一類 → 不印);n < 5 寫次數太少
 *   ④ 每一則:有中文顯示中文;翻譯數字對不上(ze)/ 沒翻 → 原文 + 標籤;文字跳脫;網址只收 http(s)、⛔ 引號
 *   ⑤ 讀不到檔 ≠ 沒發文;資料超過 30 小時沒更新要說
 *   ⑥ 畫面⛔ 研究字樣 / 🔴🟢 / 買賣指令(只描述)
 *   ⑦ `_TRUMP_OCC` 類別 == lib_trump.CLS + any(⛔ 兩份分類)
 *   ⑧ 接線:第三顆分頁鈕 + 切到才讀 + ghBase + ?t= ;AI 提示詞的 `_trumpRaw` 照舊讀新聞(⛔ 改成餵發文)
 *   ⑨ 真的載入 index.html(假網路):切到 🗽 → 畫出來、點一下展開、390px 不橫捲、5 分鐘內切回來⛔ 再打網路
 *   INJECT=tz → 窗口不轉台北時間 → ① 必紅;INJECT=occ → 發生率寫死 → ③ 決定性對照必紅
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { extractMember } from './col_rate_base.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let HTML = path.join(ROOT, 'index.html');
const SRC0 = fs.readFileSync(HTML, 'utf8');
const inj = (a, b, tag) => {
    if (!SRC0.includes(a)) { console.error('❌ 注入點找不到:' + tag); process.exit(1); }
    HTML = path.join(os.tmpdir(), `trump_pane_${tag}.html`);
    fs.writeFileSync(HTML, SRC0.replace(a, b));
    console.log(`🧪 INJECT=${tag}`);
};
if (process.env.INJECT === 'tz') inj('const H8 = 8 * 3600e3, t = new Date(nowMs + H8)', 'const H8 = 0, t = new Date(nowMs + H8)', 'tz');
if (process.env.INJECT === 'occ') inj("${c.k} 次${c.n ?", "54 次${c.n ?", 'occ');
const SRC = fs.readFileSync(HTML, 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails++; };

// ── 純函式(node 直接跑 index.html 抽出來的那幾支)──
const NEED = ['_TRUMP_OCC', '_TRUMP_CLS_ORDER', '_TRUMP_CLS_ZH', '_trumpUrl', '_trumpTpe', '_trumpWin', '_trumpOccLine', '_trumpPaneHtml', '_escHtml', '_dW', '_occPct', '_fmtNewsTime'];
const arrMember = (src, name) => { const m = src.match(new RegExp(`\\n    ${name}: (\\[[^\\n]*\\]),\\n`)); if (!m) throw new Error('找不到 ' + name); return `${name}: ${m[1]}`; };
/** 預設參數裡有 {} 的方法(_dW(raw, opt = {}))—— extractMember 會停在預設參數,這裡從 ") {" 開始配對 */
const methodMember = (src, name) => {
    const st = src.indexOf(`\n    ${name}(`); if (st < 0) throw new Error('找不到 ' + name);
    let i = src.indexOf(') {', st) + 2, depth = 0, q = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return src.slice(st + 1, i + 1).trim();
    }
    throw new Error('大括號對不上:' + name);
};
const body = NEED.map(n => (n === '_TRUMP_CLS_ORDER' ? arrMember(SRC, n) : n === '_dW' ? methodMember(SRC, n) : extractMember(SRC, n))).join(',\n') + ',\n' + arrMember(SRC, '_WD');
const A = (0, eval)(`({${body}})`);
const Z = s => Date.parse(s);

// ① 窗口
{
    const w1 = A._trumpWin(Z('2026-11-01T23:00:00Z'));          // 台北 11/02(一)07:00
    ok('① 週一開盤前 → 上週五 13:30 ~ 現在', w1.mode === 'pre' && w1.from === Z('2026-10-30T05:30:00Z') && w1.to === Z('2026-11-01T23:00:00Z'), JSON.stringify(w1));
    const w2 = A._trumpWin(Z('2026-11-03T02:00:00Z'));          // 台北 11/03(二)10:00
    ok('① 盤中 → 前一個平日 13:30 ~ 今天 09:00', w2.mode === 'in' && w2.from === Z('2026-11-02T05:30:00Z') && w2.to === Z('2026-11-03T01:00:00Z'), JSON.stringify(w2));
    const w3 = A._trumpWin(Z('2026-11-03T05:30:00Z'));          // 13:30 整 = 還算盤中
    const w4 = A._trumpWin(Z('2026-11-03T05:31:00Z'));          // 13:31 → 收盤後
    ok('① 13:30 整還算盤中、13:31 起算收盤後(同 lib_trump)', w3.mode === 'in' && w4.mode === 'post' && w4.from === Z('2026-11-03T05:30:00Z'), `${w3.mode}/${w4.mode}`);
    const w5 = A._trumpWin(Z('2026-11-07T04:00:00Z'));          // 台北 11/07(六)12:00
    ok('① 週末 → 週五 13:30 ~ 現在', w5.mode === 'pre' && w5.from === Z('2026-11-06T05:30:00Z'), JSON.stringify(w5));
    // 跨檔:窗口裡的發文,lib_trump.tw_day 對到的台股日都是同一天(收盤後 → 下一個交易日)
    const py = execFileSync('python3', ['-c', `import json, lib_trump
days = ['2026-10-30','2026-11-02','2026-11-03','2026-11-04']
print(json.dumps([lib_trump.tw_day(t, days) for t in ['2026-10-30T05:31:00Z','2026-11-01T22:59:00Z','2026-11-02T05:30:00Z','2026-11-02T05:31:00Z']]))`], { cwd: ROOT, encoding: 'utf8' });
    const td = JSON.parse(py);
    ok('① 跨檔 lib_trump:週五 13:31 / 週一 06:59 → 週一;週一 13:30 盤中(None);13:31 → 週二', JSON.stringify(td) === JSON.stringify(['2026-11-02', '2026-11-02', null, '2026-11-03']), py);
}

// fixture(跟 trump_posts_miner.build_app 輸出同形狀)
const mk = (now) => ({
    v: 1, updated: new Date(now - 2 * 3600e3).toISOString(), latest: '2026-11-01T20:00:00Z', cls: ['tariff', 'taiwan', 'chip', 'china', 'deal'],
    src: { cnn: { ok: true }, rss: { ok: true } },
    posts: [
        { id: '1', t: '2026-11-01T20:00:00Z', cls: ['china', 'deal'], en: 'China will make a DEAL with us, $500 Billion!', zh: '中國會跟我們達成協議,5000 億美元!', url: 'https://truthsocial.com/@realDonaldTrump/1' },
        { id: '2', t: '2026-10-31T15:00:00Z', cls: ['tariff'], en: 'TARIFFS of 25% on <script>alert(1)</script> imports', zh: '進口關稅 30%', ze: '數字對不上(30)→ 顯示原文', url: 'javascript:alert(1)' },
        { id: '3', t: '2026-10-25T15:00:00Z', cls: ['chip'], en: 'TSMC chips "made here"', url: 'https://x.com/a"onmouseover="alert(1)' },
    ],
    recent: [
        ['2026-11-01T20:00:00Z', 0, 'china,deal'], ['2026-11-01T19:00:00Z', 1, ''], ['2026-11-01T10:00:00Z', 0, 'china'],
        ['2026-10-31T15:00:00Z', 0, 'tariff'], ['2026-10-30T06:00:00Z', 0, ''], ['2026-10-30T05:00:00Z', 0, 'taiwan'],   // 最後一則 = 週五 13:00(盤中)⛔ 算進窗口
    ],
    days: {},
});
const NOW = Z('2026-11-01T23:00:00Z');   // 台北 11/02(一)07:00
const NEWS = [{ title: 'Trump tariffs', title_zh: '川普關稅新聞', url: 'https://news.example.com/a', published: 'Fri, 30 Oct 2026 13:55:34 GMT' }, { title: 'x', url: 'javascript:1' }];
const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// ② 第一行
const H = A._trumpPaneHtml(mk(NOW), A._TRUMP_OCC, NEWS, NOW, '');
const top = (H.match(/<div data-trump-top[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
ok('② 窗口標起點日期(10/30(五) 13:30)', /10\/30\(五\) 13:30 收盤後到現在/.test(strip(top)), strip(top));
ok('② 原創 4 則(週五盤中那則⛔ 算)・轉貼 1 則', /發了 4 則/.test(strip(top)) && /另外轉貼 1 則/.test(strip(top)), strip(top));
ok('② 講到 中國 2 ・關稅 1 ・協議 1(多的排前面,同數照 台灣>晶片>中國>關稅>協議)', /講到 中國 2 ・關稅 1 ・協議 1/.test(strip(top)) && !/台灣/.test(strip(top)), strip(top));

// ③ 發生率
const occs = H.match(/<div data-occ="trump"[^>]*>[\s\S]*?<\/div>/g) || [];
const O = A._TRUMP_OCC, ch = O.cls.china, tr = O.cls.tariff;
ok('③ 最多兩行、先講最多的那一類(中國),再講第二(關稅)', occs.length === 2 && /「中國」/.test(occs[0]) && /「關稅」/.test(occs[1]), occs.map(strip).join(' | '));
ok('③ 數字讀 _TRUMP_OCC(中國 n / k、平常 k/n)+ ⛔ 不是會漲或會跌', occs[0] && occs[0].includes(`${ch.n} 個交易日`) && occs[0].includes(`${ch.k} 次`) && occs[0].includes(`${O.base.k}/${O.base.n}`) && /⛔ 不是會漲或會跌/.test(occs[0]), strip(occs[0] || ''));
{
    const O2 = JSON.parse(JSON.stringify(O)); O2.cls.china = { n: 77, k: 11, zh: '中國' }; O2.base = { n: 500, k: 100 };
    const h2 = A._trumpPaneHtml(mk(NOW), O2, null, NOW, '');
    ok('③ ⭐ 決定性對照:改 _TRUMP_OCC 的數字 → 畫面跟著變', /77 個交易日/.test(h2) && /11 次/.test(h2) && /100\/500/.test(h2), strip((h2.match(/<div data-occ="trump"[^>]*>[\s\S]*?<\/div>/) || [''])[0]));
    O2.cls.tariff = { n: 3, k: 1, zh: '關稅' };
    const h3 = A._trumpPaneHtml(mk(NOW), O2, null, NOW, '');
    ok('③ 次數少於 5 → 寫「次數太少,先看平常那個比例」', /關稅[\s\S]*?次數太少,先看平常那個比例/.test(strip(h3)), strip(h3).slice(0, 600));
    const d0 = mk(NOW); d0.recent = d0.recent.map(r => [r[0], r[1], '']);
    const h4 = A._trumpPaneHtml(d0, O, null, NOW, '');
    ok('③ 窗口裡沒講到任何一類 → ⛔ 印發生率,第一行寫「五類都沒講到」', !/data-occ="trump"/.test(h4) && strip(h4).includes('五類(關稅・台灣・晶片・中國・協議)都沒講到'), strip(h4).slice(0, 300));
}

// ④ 每一則
{
    const posts = H.match(/<div data-trump-post[\s\S]*?<\/div>\s*<\/div>/g) || [];
    ok('④ 三則都畫出來、新的在上面', posts.length === 3 && posts[0].includes('中國會跟我們達成協議') && posts[2].includes('TSMC'), posts.length);
    ok('④ 窗口裡的標 🆕、窗口外的不標', posts[0].includes('🆕') && posts[1].includes('🆕') && !posts[2].includes('🆕'));
    ok('④ 翻譯數字對不上 → 顯示原文 + 標籤', /數字對不上,顯示原文/.test(posts[1]) && posts[1].includes('TARIFFS of 25%') && !posts[1].includes('進口關稅 30%'), strip(posts[1]));
    ok('④ 沒有翻譯 → 原文 + 標籤', /原文<\/span>/.test(posts[2]) && posts[2].includes('TSMC chips'), strip(posts[2]));
    ok('④ 文字跳脫(<script> ⛔ 變成標籤)', !/<script>/.test(H) && /&lt;script&gt;/.test(H));
    ok('④ 網址只收 http(s):javascript: / 帶引號的 ⛔ 變成連結', !/href="javascript/i.test(H) && !/onmouseover/.test(H) && /href="https:\/\/truthsocial\.com\/@realDonaldTrump\/1"/.test(H));
    ok('④ 類別小標用中文、⛔ 紅綠', posts[0].includes('>中國<') && posts[0].includes('>協議<') && !/text-red|text-green|bg-red|bg-green/.test(H));
    ok('④ 📰 新聞怎麼說(只收 http(s) 網址)', /📰 新聞怎麼說/.test(H) && H.includes('川普關稅新聞') && H.includes('href="https://news.example.com/a"'));
}

// ⑤ 讀不到 / 過期
{
    const h = A._trumpPaneHtml(null, O, null, NOW, 'HTTP 404');
    ok('⑤ 讀不到檔 → 說讀不到 + ⛔ 不代表他沒發文', strip(h).includes('讀不到川普發文的資料(HTTP 404)') && /⛔ 這不代表他沒發文/.test(h) && !/發了 0 則/.test(h));
    const d = mk(NOW); d.updated = new Date(NOW - 40 * 3600e3).toISOString();
    const h2 = A._trumpPaneHtml(d, O, null, NOW, '');
    ok('⑤ 超過 30 小時沒更新 → 說停在哪個時間', /⚠️ 發文資料停在 .*\(40 小時前\)/.test(strip(h2)), strip(h2).slice(0, 400));
    const h3 = A._trumpPaneHtml(mk(NOW), O, null, NOW, '');
    ok('⑤ 剛更新 → ⛔ 跳過期提醒', !/發文資料停在/.test(h3));
}

// ⑥ 只描述
{
    const all = strip(H + A._trumpPaneHtml(null, O, null, NOW, 'x'));
    const bad = all.match(/勝率|期望值|\bpp\b|回測|實測|探針|六關|安慰劑|買進|賣出|減碼|加碼|進場|出清|🔴|🟢/g);
    ok('⑥ 畫面⛔ 研究字樣 / 方向燈 / 買賣指令', !bad, bad && bad.join(','));
    ok('⑥ 一定寫「⛔ 不是買賣訊號」+ 手上的照出場規則走', /⛔ 不是買賣訊號/.test(all) && /手上的照你的出場規則走/.test(all));
}

// ⑦ 類別跨檔
{
    const CLS = JSON.parse(execFileSync('python3', ['-c', 'import json, lib_trump; print(json.dumps(list(lib_trump.CLS)))'], { cwd: ROOT, encoding: 'utf8' }));
    const k = Object.keys(O.cls || {});
    ok('⑦ _TRUMP_OCC 類別 == lib_trump.CLS + any', k.length === CLS.length + 1 && [...CLS, 'any'].every(x => k.includes(x)), k.join(','));
    ok('⑦ 前端排序 / 中文名的類別 == lib_trump.CLS', A._TRUMP_CLS_ORDER.slice().sort().join() === CLS.slice().sort().join() && Object.keys(A._TRUMP_CLS_ZH).sort().join() === CLS.slice().sort().join());
    ok('⑦ 平常日子 ≥ 200 天、門檻 1%、就任日起算', O.base.n >= 200 && O.th === 1 && O.from === '2025-01-20');
}

// ⑧ 接線(靜態)
{
    ok('⑧ 第三顆分頁鈕 + 第三格', /data-newspane="trump" onclick="app\.switchNewsPane\('trump'\)"/.test(SRC) && /data-newspane-body="trump"/.test(SRC) && /id="trumpPaneBody"/.test(SRC));
    const sw = SRC.slice(SRC.indexOf('    switchNewsPane(k) {'), SRC.indexOf('    switchNewsPane(k) {') + 1200);
    ok('⑧ 切到 🗽 才讀(switchNewsPane 叫 _loadTrumpPane)', /if \(k === 'trump'\) \{ try \{ this\._loadTrumpPane\(\); \} catch/.test(sw));
    const ld = (() => { const i = SRC.indexOf('    async _loadTrumpPane('); return i < 0 ? '' : SRC.slice(i, SRC.indexOf('\n    },', i)); })();
    ok('⑧ 讀檔用 ghBase + ?t=(⛔ 寫死網址)', /new URL\('data\/trump_posts\.json', ghBase\)\.href \+ `\?t=\$\{Date\.now\(\)\}`/.test(ld) && !/github\.io/.test(ld));
    ok('⑧ AI 提示詞的 _trumpRaw 照舊讀新聞(⛔ 改成餵發文)', /_trumpRaw = join\(tg\.trump\)/.test(SRC) && !/_trumpRaw[^\n]*trump_posts/.test(SRC));
}

// ⑨ 真的載入(假網路)
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(HTML).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._loadTrumpPane === 'function', null, { timeout: 60000 });
await page.waitForTimeout(2000);
const FIX = mk(Date.now());
const R = await page.evaluate(async ({ FIX, NEWS }) => {
    const out = {}; let hits = 0;
    const real = window.fetch;
    window.fetch = (u, o) => {
        const s = String(u);
        if (/data\/trump_posts\.json\?t=/.test(s)) { hits++; return Promise.resolve(new Response(JSON.stringify(FIX), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
        if (/data\/tech_giants_news\.json/.test(s)) return Promise.resolve(new Response(JSON.stringify({ trump: NEWS }), { status: 200 }));
        return real(u, o);
    };
    app._trumpCache = null;
    app.switchAppTab('market'); try { app.switchMarketSubTab('global'); } catch (_) {}
    app.switchNewsPane('trump');
    for (let i = 0; i < 40 && !document.querySelector('#trumpPaneBody [data-trump-top]'); i++) await new Promise(r => setTimeout(r, 100));
    const body = document.getElementById('trumpPaneBody');
    out.top = !!body.querySelector('[data-trump-top]');
    out.posts = body.querySelectorAll('[data-trump-post]').length;
    out.paneShown = getComputedStyle(document.querySelector('[data-newspane-body="trump"]')).display !== 'none';
    out.newsHidden = getComputedStyle(document.querySelector('[data-newspane-body="news"]')).display === 'none';
    out.saved = localStorage.getItem('newsPane');
    out.ts = document.getElementById('trumpPaneTs').textContent;
    const p0 = body.querySelector('[data-trump-post]'), tx = p0 && p0.querySelector('.tp-txt');
    out.clampBefore = tx ? getComputedStyle(tx).webkitLineClamp : null;
    if (p0) p0.click();
    out.clampAfter = tx ? getComputedStyle(tx).webkitLineClamp : null;
    out.openCls = p0 ? p0.classList.contains('tp-open') : false;
    window.scrollTo(80, 0); out.scrollX = window.scrollX;
    out.hits1 = hits;
    app.switchNewsPane('news'); app.switchNewsPane('trump');
    await new Promise(r => setTimeout(r, 300));
    out.hits2 = hits;
    out.postsAgain = document.querySelectorAll('#trumpPaneBody [data-trump-post]').length;
    window.fetch = real;
    return out;
}, { FIX, NEWS });
ok('⑨ 切到 🗽 → 畫出第一行 + 3 則、這一格顯示、新聞那格藏起來', R.top && R.posts === 3 && R.paneShown && R.newsHidden, JSON.stringify(R));
ok('⑨ 記住停在 🗽(下次開消息面直接讀)', R.saved === 'trump');
ok('⑨ 右上角標更新時間', /^\d{2}\/\d{2}\(.\) \d{2}:\d{2}$/.test(R.ts), R.ts);
ok('⑨ 每則先收成 4 行、點一下展開', String(R.clampBefore) === '4' && R.openCls && String(R.clampAfter) !== '4', `${R.clampBefore} → ${R.clampAfter}`);
ok('⑨ 390px ⛔ 橫捲', R.scrollX <= 2, R.scrollX);
ok('⑨ 5 分鐘內切回來⛔ 再打網路(照樣畫得出來)', R.hits1 === 1 && R.hits2 === 1 && R.postsAgain === 3, `${R.hits1} → ${R.hits2}`);
ok('⑨ 沒有 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();

console.log(fails ? `\n❌ ${fails} 條沒過` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
