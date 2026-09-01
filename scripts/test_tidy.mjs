#!/usr/bin/env node
/**
 * 🗂️ V74.1.7 精簡檢視(`_TIDY` / `_initTidy` / `_tidyToggle`)
 *
 * 使用者:「資料呈現太多,看的人不知道到底要看誰,把沒有用的雜訊清洗,
 *          先使用折疊或隱藏還是刪除…未來如果我有驗到有用的雜訊再加回來」。
 *
 * ⛔ 釘死的五件事(每一條都用注入缺陷驗過):
 *   ① 清單裡的卡**預設收起**,而且原地留一行「收了什麼、為什麼」(⛔ 靜默消失 = 陷阱 #22)
 *   ② 點開/收回要真的動(render 會 classList.remove('hidden') 自己開卡 → 必須壓得住)
 *   ③ **收起 ≠ 刪除**:卡還在 DOM、render 照跑(未來一行就能加回來)
 *   ④ 清單裡的 id 必須真的存在(打錯字 = 那張卡靜默沒收,零錯誤訊息)
 *   ⑤ 每一行都要有「為什麼」(⛔ 不寫依據的收起跟亂砍沒兩樣);⛔ 風險提醒類的卡不可入清單
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${e}`}`); if (!c) fails++; };

// ── 靜態 ──
ok('⓪ CSS 用屬性 + !important(⛔ class 壓不住 render 的 classList.remove)',
    /\[data-tidy="1"\]\{display:none !important\}/.test(SRC));
{
    const seg = SRC.slice(SRC.indexOf('_TIDY: ['), SRC.indexOf('_initTidy('));
    const entries = [...seg.matchAll(/\['([A-Za-z]+)', '([^']+)', '([^']+)'\]/g)];
    ok('⓪b 清單每一行都要有名稱與「為什麼」(⛔ 不寫依據的收起跟亂砍沒兩樣)',
        entries.length >= 4 && entries.every(m => m[2].length >= 4 && m[3].length >= 10), entries.length);
    // 🚨 風險提醒類⛔ 不可入清單 —— 忽略風險的代價遠大於多看一眼(多空不對稱那條鐵則)
    ok('⓪c ⛔ 風險提醒/官方處置類的卡不可被收起',
        !/attentionDetailCard|marginCallCard|disposition|riskAlert/i.test(seg));
}

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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 25000 });
await page.waitForTimeout(5000);

const R = await page.evaluate(async () => {
    const o = {};
    try { app.switchAppTab('diag'); } catch (_) { }
    try { await app.analyze('2330', true, false, true); } catch (e) { return { err: String(e).slice(0, 160) }; }
    await new Promise(r => setTimeout(r, 2500));
    const seen = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; };
    // ④ 清單 id 都要真的存在(打錯字 = 靜默沒收)
    o.missing = app._TIDY.filter(([id]) => !document.getElementById(id)).map(([id]) => id);
    o.n = app._TIDY.length;
    // ① 每一張:預設收起 + 原地有提示列
    o.cards = {};
    for (const [tab, pane, id] of [['strategy', 'now', 'etfFollowCard'], ['chart', null, 'sixMeridianCard'],
                                   ['bullbear', null, 'bullBearCategoryCards'], ['backtest', null, 'predictionAuditCard']]) {
        try { app.switchSubTab(tab); } catch (_) { }
        if (pane) { try { app.switchOvTab(pane); } catch (_) { } }
        await new Promise(r => setTimeout(r, 1100));
        const row = document.querySelector(`.tidyrow[data-tidyfor="${id}"]`);
        o.cards[id] = {
            hidden: !seen(id),
            row: !!row && getComputedStyle(row).display !== 'none',
            rowTxt: row ? row.innerText.replace(/\s+/g, ' ') : '',
        };
    }
    // ② 點開/收回(render 已經跑過、classList 已被它動過 → 這裡驗的是「壓得住」)
    app._tidyToggle('sixMeridianCard'); o.open = seen('sixMeridianCard');
    // ⚠️ 防禦性讀取 —— 注入「提示列沒插進去」時要讓斷言乾淨地紅,⛔ 不是整包炸掉
    o.btnOpen = (document.querySelector('.tidyrow[data-tidyfor="sixMeridianCard"] button') || { textContent: '(沒有提示列)' }).textContent;
    app._tidyToggle('sixMeridianCard'); o.close = seen('sixMeridianCard');
    // ③ 收起 ≠ 刪除:卡還在 DOM、render 照跑(有內容)
    o.domLen = (document.getElementById('sixMeridianCard') || { innerHTML: '' }).innerHTML.length;
    return o;
});
await browser.close();
if (R.err) { console.log(`❌ analyze 失敗:${R.err}`); process.exit(1); }

ok('④ 清單裡的 id 全部真的存在(⛔ 打錯字 = 那張卡靜默沒收)', R.missing.length === 0, R.missing);
ok('🚧 空過守門:清單至少 4 張(⛔ 清單被清空這些測試就全是假通過)', R.n >= 4, R.n);
for (const [id, c] of Object.entries(R.cards)) {
    ok(`① ${id} 預設收起`, c.hidden);
    ok(`①b ${id} 原地要有一行「收了什麼、為什麼」`, c.row && /已收起/.test(c.rowTxt) && /——/.test(c.rowTxt),
        c.rowTxt.slice(0, 80));
}
ok('①c 提示列要講「為什麼」的依據(未驗證/取代/明細),⛔ 不可只寫「已收起」',
    /驗證/.test(R.cards.etfFollowCard.rowTxt) && /沒回測過/.test(R.cards.sixMeridianCard.rowTxt)
    && /計分條/.test(R.cards.bullBearCategoryCards.rowTxt) && /取代/.test(R.cards.predictionAuditCard.rowTxt));
ok('② 點開要真的顯示、再點要收回(⛔ render 的 classList 不可壓過它)',
    R.open === true && R.close === false && R.btnOpen === '收起', [R.open, R.close, R.btnOpen]);
ok('③ ⛔ 收起 ≠ 刪除:卡還在 DOM、render 照跑(未來一行就能加回來)', R.domLen > 50, R.domLen);

console.log(fails ? `❌ ${fails} 條失敗` : '✅ TIDY_PASS(全部通過)');
process.exit(fails ? 1 : 0);
