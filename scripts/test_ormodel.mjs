#!/usr/bin/env node
/**
 * 🚀 OpenRouter 模型解析 + 404 自我修復(V73.8.0)測試
 *
 * 🐛 使用者截圖:財經行事曆每一列都顯「⚠️ AI 例外:OpenRouter HTTP 404」。
 *    404 = **那個模型名字在 OpenRouter 上已經不存在**(免費模型 slug 會改版/下架),
 *    ⛔ 不是金鑰壞掉、不是額度用完 —— 但畫面只寫「HTTP 404」,看不出是哪一種。
 *
 * ⛔ 這支要釘死的六件事:
 *   ① ⛔ **不可再寫死 slug** —— 全 App 只准 `_OR_MODEL_LEGACY` 那一個保底常數;
 *      實際用哪個模型要去問官方 `/api/v1/models`(同 taifex / FinMind 那兩次「讓官方自己說」)。
 *   ② **改版要自動跟上**:官方只剩 `deepseek-r1-0528:free` 也要挑得到(靠樣式,不比對固定字串)。
 *   ③ **絕不能比改版前更糟**:清單問不到 → 退回上次成功過的 → 再退回舊 slug,⛔ 不可 throw/回 undefined。
 *   ④ ⭐ **404 要自我修復**:清快取 → 重新解析 → **換一個模型再打一次**(⛔ 不是直接放棄)。
 *   ⑤ **錯誤訊息要人話**(V26.18):⛔ 不可只丟 `HTTP 404`;各狀態碼要能分辨。
 *   ⑥ ⛔ **不可有第二處自己 fetch** openrouter chat/completions(陷阱 #37:寫死的 slug 一改就漏一處)。
 *
 * ⚠️ 沙箱連不到 openrouter.ai(proxy 403)→ 一律 **stub `safeFetch`**,
 *    並且每組都有**空過守門**(斷言 stub 真的被呼叫到),⛔ 免得「沒報錯」被當成「驗過了」。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── ⑥ 靜態:不可有第二處自己打 openrouter chat ────────────────────────
// ⚠️ `_orChat` 自己有 2 次 fetch(原本那次 + 404 換模型重試那次)是正常的;
//    要釘的是「⛔ 不可有**別的函式**自己打」→ 斷言所有出現位置都落在 `_orChat` 的區塊內。
{
    const A = src.indexOf('async _orChat(');
    const B = src.indexOf('_orErr(status) {');
    const hits = [];
    const re = /safeFetch\('https:\/\/openrouter\.ai\/api\/v1\/chat\/completions'/g;
    let m; while ((m = re.exec(src))) hits.push(m.index);
    const outside = hits.filter(i => !(A > 0 && B > A && i > A && i < B));
    ok('⑥ 🚨 openrouter chat 只准在 `_orChat` 裡面打(陷阱 #37:寫死 slug 一改就漏一處)',
        A > 0 && B > A && outside.length === 0 && hits.length === 2,
        `共 ${hits.length} 處,其中 ${outside.length} 處在 _orChat 之外`);
}
const hardSlugs = (src.match(/deepseek\/deepseek-r1:free/g) || []).length;
ok('① 🚨 寫死的 slug 只准剩保底常數那一個', hardSlugs === 1, `找到 ${hardSlugs} 處`);
ok('①b 保底常數存在(⛔ 解析失敗時不可回 undefined)', /_OR_MODEL_LEGACY:\s*'/.test(src));
ok('①c 偏好清單是**樣式**不是固定字串', /_OR_MODEL_PREFS:\s*\[\s*\/\^deepseek/.test(src));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._orModel && !!app._orChat, null, { timeout: 25000 });

const R = await page.evaluate(async () => {
    const out = { calls: {} };
    const real = app.safeFetch;
    const reset = () => { app._orModelClear(); };

    // models 清單 stub 產生器(⛔ 記下被呼叫幾次,當空過守門)
    const stub = (modelIds, chatHandler) => {
        const log = { models: 0, chat: [] };
        app.safeFetch = async (url, opt) => {
            if (String(url).includes('/v1/models')) {
                log.models++;
                if (modelIds === null) throw new Error('stub: 清單掛掉');
                return { ok: true, status: 200, json: async () => ({ data: modelIds.map(id => ({ id })) }) };
            }
            const body = JSON.parse(opt.body);
            log.chat.push(body.model);
            return chatHandler ? chatHandler(body, log) : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
        };
        return log;
    };

    // ── ② 官方只剩新版 slug,也要挑得到 ──────────────────────────
    reset();
    let lg = stub(['openai/gpt-4o', 'deepseek/deepseek-r1-0528:free', 'deepseek/deepseek-chat']);
    out.pickNew = await app._orModel('k');
    out.calls.pickNew = lg.models;

    // ── ②b 有免費版就優先免費版(⛔ 不可挑到付費那個)────────────
    reset();
    lg = stub(['deepseek/deepseek-r1', 'deepseek/deepseek-r1-0528:free']);
    out.pickFree = await app._orModel('k');

    // ── ②c 完全沒有免費版 → 退而求其次挑付費 R1 ─────────────────
    reset();
    lg = stub(['deepseek/deepseek-r1', 'openai/gpt-4o']);
    out.pickPaid = await app._orModel('k');

    // ── ③ 一個 deepseek 都沒有 → 回保底,⛔ 不可 throw / undefined ─
    reset();
    lg = stub(['openai/gpt-4o', 'meta-llama/llama-3.1-8b-instruct:free']);
    try { out.pickNone = await app._orModel('k'); } catch (e) { out.pickNone = 'THREW:' + e.message; }

    // ── ③b 清單端點掛掉,但上次成功過 → 退回上次那個 ─────────────
    reset();
    lg = stub(['deepseek/deepseek-r1-0528:free']);
    await app._orModel('k');                 // 先成功一次,寫進 localStorage
    app._orModelMem = null;                  // 只清記憶體,保留 localStorage
    lg = stub(null);                         // 清單端點掛掉
    out.pickStale = await app._orModel('k', { force: true });
    out.calls.pickStale = lg.models;

    // ── ③c 什麼都沒有(清單掛掉 + 沒有快取)→ 保底 slug ───────────
    reset();
    lg = stub(null);
    try { out.pickBare = await app._orModel('k', { force: true }); } catch (e) { out.pickBare = 'THREW:' + e.message; }

    // ── ④ 404 自我修復:清快取 → 重挑 → 換模型再打一次 ────────────
    reset();
    // 先讓它快取到「舊的」那個
    lg = stub(['deepseek/deepseek-r1:free']);
    await app._orModel('k');
    // 之後官方清單換成新的,而舊模型會回 404
    lg = stub(['deepseek/deepseek-r1-0528:free'], (body) => {
        if (body.model === 'deepseek/deepseek-r1:free') return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
    });
    const res = await app._orChat('k', { messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }, {});
    out.healOk = !!res.ok;
    out.healTried = lg.chat.slice();          // 應該有兩個,而且不同

    // ── ④b 換了新模型仍 404 → 誠實回失敗,⛔ 不可無限重試 ─────────
    reset();
    lg = stub(['deepseek/deepseek-r1-0528:free'], () => ({ ok: false, status: 404, json: async () => ({}) }));
    const res2 = await app._orChat('k', { messages: [], max_tokens: 5 }, {});
    out.hardFail = { ok: res2.ok, status: res2.status, tries: lg.chat.length };

    // ── ⑤ 錯誤訊息要人話 ────────────────────────────────────────
    out.err = { 404: app._orErr(404), 401: app._orErr(401), 402: app._orErr(402), 429: app._orErr(429), 500: app._orErr(500), 418: app._orErr(418) };

    app.safeFetch = real;
    return out;
});
await browser.close();

// ── 斷言 ──────────────────────────────────────────────────────────
ok('⑨ 空過守門:models 端點真的被呼叫到(否則下面全是假綠)', R.calls.pickNew >= 1, JSON.stringify(R.calls));

ok('② 官方改版成 `-0528:free` 也挑得到', R.pickNew === 'deepseek/deepseek-r1-0528:free', R.pickNew);
ok('②b 有免費版時優先免費版(⛔ 不可挑到要付錢的)', R.pickFree === 'deepseek/deepseek-r1-0528:free', R.pickFree);
ok('②c 沒有免費版才退而挑付費 R1', R.pickPaid === 'deepseek/deepseek-r1', R.pickPaid);

ok('③ 🚨 一個 deepseek 都沒有 → 回保底 slug,⛔ 不可 throw',
    R.pickNone === 'deepseek/deepseek-r1:free', R.pickNone);
ok('③b 清單端點掛掉 → 退回「上次成功過的」而不是保底',
    R.pickStale === 'deepseek/deepseek-r1-0528:free', R.pickStale);
ok('③c 什麼都沒有 → 保底 slug(⛔ 絕不能比改版前更糟)',
    R.pickBare === 'deepseek/deepseek-r1:free', R.pickBare);

ok('④ 🚨 404 會自動換模型再試一次', R.healOk === true, JSON.stringify(R.healTried));
ok('④b 而且真的打了兩次、用**不同**模型(⛔ 不是原封不動重打)',
    R.healTried.length === 2 && R.healTried[0] !== R.healTried[1], JSON.stringify(R.healTried));
ok('④c 換了還是 404 → 誠實回失敗,⛔ 不可無限重試(最多 2 次)',
    R.hardFail.ok === false && R.hardFail.status === 404 && R.hardFail.tries <= 2, JSON.stringify(R.hardFail));

const noJargon = s => !/HTTP\s*\d|status\s*\d|\bAPI\b/i.test(s);
ok('⑤ 404 的訊息要講「模型被下架」而不是 `HTTP 404`',
    /下架/.test(R.err[404]) && noJargon(R.err[404]), R.err[404]);
ok('⑤b 401 要指向設定中心', /設定中心/.test(R.err[401]) && noJargon(R.err[401]), R.err[401]);
ok('⑤c 402 要講額度用完', /額度/.test(R.err[402]) && noJargon(R.err[402]), R.err[402]);
ok('⑤d 429 要講用量上限', /上限/.test(R.err[429]) && noJargon(R.err[429]), R.err[429]);
ok('⑤e 5xx 要講對方忙碌', /忙碌/.test(R.err[500]) && noJargon(R.err[500]), R.err[500]);
ok('⑤f 各狀態碼訊息要**不一樣**(⛔ 不可全部同一句)',
    new Set([R.err[404], R.err[401], R.err[402], R.err[429], R.err[500]]).size === 5, JSON.stringify(R.err));

ok('⑦ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ ORMODEL_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
