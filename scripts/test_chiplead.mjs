#!/usr/bin/env node
/**
 * 🧭 V74.2.3 籌碼頁「總覽邏輯」(使用者:「依照之前邏輯做籌碼頁面」)
 *
 * 為什麼要做:card_inventory 實測籌碼頁攤開 **2,538 字**(全 App 最重)——
 * 主結論卡 1,489 + 明日劇本 613。⭐ 第一眼只留「結論 + 評分 + 一句操作 + 其他指標 + 風險」,
 * 完整卡片收進「📖 更多解讀」(⛔ 一張卡、一個字都沒刪,同 K線頁 V74.2.2 / 總覽 V72.4.7)。
 *
 * ⛔ 釘死的七件事(⑤⑥⑦ 已用注入缺陷自我驗證):
 *   ① 摺疊存在且**預設收起**(⛔ 不可掛 open);三張卡真的在裡面
 *   ② 頁首由 `renderChipVerdict` **同步**渲染、只轉述(⛔ 不重算 = 不產生第二份真相)
 *   ③ 頁首要有:大字結論 + 評分 + 💡操作(缺一就等於沒把結論搬上來)
 *   ④ 沒資料/切股時頁首要收掉(⛔ 不殘留上一檔)
 *   ⑤ 🚨 融資追繳風險要露在頁首 —— 它原本埋在「分頁 + 兩層收合」裡(陷阱 #32)
 *   ⑥ 「其他籌碼指標怎麼說」(方向分歧提醒)要在頁首
 *   ⑦ 頁首⛔ 不給買賣價位、要指路總覽(單一劇本原則)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 220)}`}`); if (!c) fails++; };

// ── 靜態 ──
{
    const m = SRC.match(/<details id="chipMoreWrap"[^>]*>/);
    ok('① 摺疊存在且**預設收起**(⛔ 不可掛 open)', !!m && !/\bopen\b/.test(m[0]), m && m[0]);
    const s = SRC.indexOf('<details id="chipMoreWrap"');
    const e = SRC.indexOf('</details>', s);
    const seg = SRC.slice(s, e);
    ok('① 主結論卡/明日劇本/乾淨度 都在摺疊裡',
        ['id="chipVerdictCard"', 'id="chipScenarioSlot"', 'id="chipCleanCard"'].every(x => seg.includes(x)));
    ok('① 頁首(#chipLead)在摺疊**外**', SRC.indexOf('id="chipLead"') < s);
    // ② 只轉述不重算:_renderChipLead 收 renderChipVerdict 傳進來的值
    const f = SRC.indexOf('_renderChipLead(sym, o) {');
    const fseg = SRC.slice(f, f + 4200);
    ok('② ⭐ 頁首只轉述(大字/評分/操作全部來自傳入的 o.*,⛔ 不自己再算一次)',
        /\$\{o\.big\}/.test(fseg) && /\$\{o\.score100\}/.test(fseg) && /\$\{o\.act\}/.test(fseg)
        && !/_chipPeriodSums/.test(fseg), '');
    ok('② 由 renderChipVerdict 同步呼叫(同一批變數)',
        /this\._renderChipLead\(sym, \{ big, bigCls, bcls, score100, scoreCls, scoreLbl, act, sc,/.test(SRC));
    // ⚠️ 第一版寫 `length >= 3` —— 但定義那行是 `_leadOff = ()`(不含 `_leadOff()`)→ 實際只有 2 個呼叫點。
    //    ⭐ 那是**測資/計數自己錯**,不是程式錯(CLAUDE.md:斷言前先確認實際輸出長什麼樣)。
    ok('④ 兩個早退分支(沒 sym/資料太少、沒有法人資料)都要把頁首收掉(⛔ 不殘留上一檔)',
        /_leadOff\(\); return; \}/.test(SRC) && (SRC.match(/_leadOff\(\)/g) || []).length === 2,
        (SRC.match(/_leadOff\(\)/g) || []).length);
}

// ── 動態 ──
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(() => {
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }),
        writable: true, configurable: true,
    });
});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderChipVerdict, null, { timeout: 25000 });

const R = await page.evaluate(async () => {
    const o = {};
    try { app.switchAppTab('diag'); } catch (_) { }
    try { await app.analyze('2330', true, false, true); } catch (e) { return { err: String(e).slice(0, 160) }; }
    try { app.switchSubTab('chip'); } catch (_) { }
    await new Promise(r => setTimeout(r, 1800));
    const lead = document.getElementById('chipLead');
    o.shown = !!lead && !lead.classList.contains('hidden');
    o.txt = lead ? lead.innerText.replace(/\s+/g, ' ') : '';
    const wrap = document.getElementById('chipMoreWrap');
    o.closed = !!wrap && wrap.open === false;
    o.cardInside = !!wrap && !!wrap.querySelector('#chipVerdictCard');
    // ⛔ 收起 ≠ 刪除:完整卡片內容還在(未來要加回來只是把它搬出去)
    o.cardLen = (document.getElementById('chipVerdictCard') || { innerHTML: '' }).innerHTML.length;

    // ⑤ 融資追繳風險:stub 一個 near → 頁首必須露(⛔ 不 stub 的話這條會依當天資料時有時無 = 空過)
    const realMc = app._marginCallState;
    app._marginCallState = () => ({ cost: 100, callLine: 78, price: 82, distPct: 4.9, level: 'near',
        isOtc: false, known: true, marginLots: 12345, mgChg: -3.2, perLot: 4000, days: 60, date: '2026-08-29' });
    app.renderChipVerdict('2330');
    o.riskTxt = (document.getElementById('chipLead') || { innerText: '' }).innerText.replace(/\s+/g, ' ');
    o.riskShown = /逼近融資追繳區/.test(o.riskTxt) && /78\.00/.test(o.riskTxt);
    // safe → ⛔ 不可顯示(條件觸發,別留噪音)
    app._marginCallState = () => ({ level: 'safe', callLine: 1, distPct: 90, perLot: 1, price: 1, cost: 1 });
    app.renderChipVerdict('2330');
    o.riskGone = !/融資追繳區|融資賣壓區|融資壓力區/.test((document.getElementById('chipLead') || { innerText: '' }).innerText);
    app._marginCallState = realMc;

    // ⑥ 其他籌碼指標怎麼說:stub 一組「方向分歧」→ 頁首要點出來
    const realCons = app._chipConsensusLine;
    app._chipConsensusLine = () => '<div id="__consProbe">🧭 其他籌碼指標怎麼說 ⚠️ 籌碼面分歧:1 項偏多、1 項偏空</div>';
    app.renderChipVerdict('2330');
    o.consInLead = !!document.querySelector('#chipLead #__consProbe');
    app._chipConsensusLine = realCons;

    // ④ 沒有資料 → 頁首收掉
    //   ⚠️ 第一版寫 `renderChipVerdict('9999')` —— **測資前提是錯的**:這支讀的是
    //      `this.rawDailyData`(還是 2330 的),換 sym 不會讓它沒資料 → 那條等於沒驗到。
    //   ⭐ 正解:把資料本身清掉,走真正的早退分支。
    const realRaw = app.rawDailyData;
    app.rawDailyData = [];
    app.renderChipVerdict('2330');
    o.goneNoData = (document.getElementById('chipLead') || { classList: { contains: () => false } }).classList.contains('hidden');
    // 🚧 空過守門:資料還原後要能再顯示回來(⛔ 否則「收掉」可能只是它壞了)
    app.rawDailyData = realRaw;
    app.renderChipVerdict('2330');
    o.backAgain = !(document.getElementById('chipLead') || { classList: { contains: () => true } }).classList.contains('hidden');
    return o;
});
await browser.close();
if (R.err) { console.log(`❌ analyze 失敗:${R.err}`); process.exit(1); }

ok('③ 頁首真的顯示(真實 2330)', R.shown && R.txt.length > 30, R.txt.slice(0, 100));
ok('③ ⭐ 頁首要有 大字結論 + 評分 + 💡操作(缺一等於沒把結論搬上來)',
    /大戶/.test(R.txt) && /籌碼綜合評分/.test(R.txt) && /💡 操作/.test(R.txt), R.txt.slice(0, 200));
ok('① 摺疊實跑也是收起的、完整卡片在裡面', R.closed && R.cardInside, JSON.stringify({ c: R.closed, i: R.cardInside }));
ok('① ⛔ 收起 ≠ 刪除:完整卡片內容還在', R.cardLen > 500, R.cardLen);
ok('⑤ 🚨 融資追繳風險要露在頁首(⛔ 不可只埋在分頁+兩層收合裡)', R.riskShown, R.riskTxt.slice(0, 220));
ok('⑤b 安全時⛔ 不顯示(條件觸發,別留噪音)', R.riskGone === true, '');
ok('⑥ ⭐ 「其他籌碼指標怎麼說」要在頁首(方向分歧才看得到)', R.consInLead === true, '');
ok('⑦ ⛔ 頁首不給買賣價位、要指路總覽(單一劇本原則)',
    !/進場價|掛單|停損 \d|目標價 \d/.test(R.txt) && /總覽/.test(R.txt), R.txt.slice(-160));
ok('④ 沒有資料時頁首收掉(⛔ 不殘留上一檔)', R.goneNoData === true, '');
ok('④b 🚧 空過守門:資料回來要能再顯示(⛔ 否則「收掉」可能只是它壞了)', R.backAgain === true, '');

console.log(fails ? `❌ ${fails} 條失敗` : '✅ CHIPLEAD_PASS(全部通過)');
process.exit(fails ? 1 : 0);
