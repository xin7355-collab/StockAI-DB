#!/usr/bin/env node
/**
 * 🧭 V77.3.4 報告頁 §10「籌碼總表」守門 —— 每一列 = 數字 + 本站實測怎麼說
 *   ⓐ 每一列的狀態必須對得到 `_CHIP_VERDICT`,而文案裡的 {key.field} 必須從 `_CHIP_EDGE` / `_FSTREAK_EDGE` 讀到(⛔ 不可有 ?)
 *   ⓑ 狀態文字⛔ 不可出現 看多/看空/偏多/偏空/⚠️(這張表講「能不能預測」,不是方向)
 *   ⓒ 「今天命中」走既有 `_chipEdgeState`(決定性對照:stub 成 both → 要印;stub 成 null → 要印「沒有命中」)
 *   ⓓ 餵給外部 AI 的 facts 也帶同一份實測結論(顯示點永遠多一個)
 *   ⓔ 列上只留標籤 + 數字,完整依據在摺疊裡(§10 在短中線視角是預設攤開的 → 第一眼有上限)
 *   ⓕ 真實資料(2330)至少 6 列、沒有 undefined / NaN
 * 注入:① `_CHIP_VERDICT.both.why` 的 {both.e} 改成 {both.zz} → ⓐ2 紅 ② 狀態加「偏多」→ ⓑ 紅 ③ hitHtml 寫死 → ⓒ 紅 ④ facts 拿掉 `_chipVerdictLine` → ⓓ 紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
if (!fs.existsSync(path.join(ROOT, 'data', '2330.json'))) { console.log('❌ 沒有 data/2330.json —— ⛔ 不跑假測試'); process.exit(1); }

// 靜態
const fn = CODE.slice(CODE.indexOf('_rpChipHtml(C) {'), CODE.indexOf('// G 風險與反轉訊號'));
ok('⓪ 切得到 _rpChipHtml(空過守門)', fn.length > 1500, String(fn.length));
ok('ⓒs 今天命中走既有 `_chipEdgeState`(⛔ 不另寫判定)', /this\._chipEdgeState\(sym\)/.test(fn), '');
ok('ⓓs facts 那行接上 `_chipVerdictLine`', /_chipVerdictLine\(\)/.test(CODE.slice(CODE.indexOf('_reportFacts(sym) {'), CODE.indexOf('_reportFacts(sym) {') + 20000)), '');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
page.on('pageerror', () => {});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 25000 });
await page.waitForTimeout(2000);
await page.evaluate(s => { app.switchAppTab('diag'); return app.analyze(s); }, '2330');
await page.waitForTimeout(8000);
const R = await page.evaluate(async () => {
    const A = app;
    A.switchSubTab('report');
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 600)); if (document.querySelector('[data-chiprow]')) break; }
    const C = A._rpLast;
    const html = A._rpChipHtml(C);
    const div = document.createElement('div'); div.innerHTML = html;
    const rows = [...div.querySelectorAll('[data-chiprow]')].map(e => ({ row: e.dataset.chiprow, st: e.dataset.chipv, txt: e.innerText.replace(/\s+/g, ' ').trim() }));
    const verdicts = Object.keys(A._CHIP_VERDICT).map(k => ({ k, v: A._chipVerdict(k) }));
    const details = div.querySelector('[data-chipwhy]');
    // ⓒ 決定性對照:stub `_chipEdgeState`
    const orig = A._chipEdgeState;
    A._chipEdgeState = () => ({ key: 'both', all: ['both'], ...A._CHIP_EDGE.both });
    const hitOn = A._rpChipHtml(C);
    A._chipEdgeState = () => null;
    const hitOff = A._rpChipHtml(C);
    A._chipEdgeState = orig;
    const hitEl = h => { const d2 = document.createElement('div'); d2.innerHTML = h; const e = d2.querySelector('[data-chiphit]'); return e ? { k: e.dataset.chiphit, t: e.innerText } : { k: null, t: '' }; };
    const HON = hitEl(hitOn), HOFF = hitEl(hitOff);
    const facts = (() => { try { return A._reportFacts('2330'); } catch (_) { return ''; } })();
    return { rows, verdicts, whyN: details ? +details.dataset.chipwhy : -1, whyOpen: details ? details.open : null, whyTxt: details ? details.innerText : '',
             hitOn: HON.k, hitOnTxt: HON.t, hitOff: HOFF.k, hitOffTxt: HOFF.t,
             facts, html, firstEye: div.innerText.length };
});
await browser.close();

ok('ⓕ 真實資料(2330)至少 6 列', R.rows.length >= 6, JSON.stringify(R.rows.map(x => x.row)));
ok('ⓕb 沒有 undefined / NaN / ?pp', !/undefined|NaN|\?pp/.test(R.html), (R.html.match(/.{20}(undefined|NaN|\?pp).{10}/) || [''])[0]);
ok('ⓐ 每一列的狀態都對得到 `_CHIP_VERDICT`(foreign/trust/both/dealer/fen/tdcc/margin)', R.rows.every(x => ['ok', 'no', 'weak', 'na'].includes(x.st)) && ['foreign', 'trust', 'both', 'fen', 'tdcc', 'margin'].every(k => R.rows.some(x => x.row === k)), JSON.stringify(R.rows.map(x => [x.row, x.st])));
ok('ⓐ2 ⭐ 文案裡的 {key.field} 全部從常數讀到(⛔ 一個 ? 都不可以 —— 那是模板對不到欄位)', R.verdicts.every(x => x.v && !/\?/.test(x.v.txt)), JSON.stringify(R.verdicts.filter(x => !x.v || /\?/.test(x.v.txt)).map(x => x.k)));
ok('ⓐ3 both 那列讀到 `_CHIP_EDGE.both.e`(0.99)、trust 那列讀到 `_FSTREAK_EDGE.t5.e`(0.79)', /0\.99pp/.test(R.verdicts.find(x => x.k === 'both').v.txt) && /0\.79pp/.test(R.verdicts.find(x => x.k === 'trust').v.txt), '');
ok('ⓑ 🚦 狀態文字⛔ 不可出現 看多/看空/偏多/偏空/⚠️/🔴/🟢', R.verdicts.every(x => !/看多|看空|偏多|偏空|⚠️|🔴|🟢/.test(x.v.tag + x.v.txt)), JSON.stringify(R.verdicts.filter(x => /看多|看空|偏多|偏空|⚠️|🔴|🟢/.test(x.v.tag + x.v.txt)).map(x => x.k)));
ok('ⓑ2 四種標籤只有 ✅ 實測有效 / △ 證據偏弱 / ❌ 實測無效 / ○ 只描述', R.verdicts.every(x => /^(✅ 實測有效|△ 證據偏弱|❌ 實測無效|○ 只描述)$/.test(x.v.tag)), JSON.stringify(R.verdicts.map(x => x.v.tag)));
ok('ⓒ ⭐ 決定性對照:`_chipEdgeState` 回 both → 印「今天命中」帶 both 的成績;回 null → 印「沒有命中」', R.hitOn === 'both' && /0\.99pp/.test(R.hitOnTxt) && /今天命中/.test(R.hitOnTxt) && R.hitOff === '' && /沒有命中/.test(R.hitOffTxt), JSON.stringify([R.hitOn, R.hitOnTxt.slice(0, 60), R.hitOff, R.hitOffTxt.slice(0, 30)]));
ok('ⓓ 餵外部 AI 的 facts 帶同一份實測結論(+0.99pp / 外資單獨 0 過)', /0\.99pp/.test(R.facts) && /外資單獨連買 ❌/.test(R.facts) && /AI 不可自己判籌碼多空/.test(R.facts), (R.facts.match(/[^\n]*本站實測[^\n]*/) || [''])[0].slice(0, 160));
ok('ⓔ 完整依據收在摺疊裡(預設關)、條數 = 有狀態的列數;列上只留標籤+數字', R.whyN >= 6 && R.whyOpen === false && R.rows.every(x => x.txt.length < 220), JSON.stringify([R.whyN, R.whyOpen, Math.max(...R.rows.map(x => x.txt.length))]));
ok('ⓔ2 摺疊裡真的有那些依據(fstreak_probe / tdcc_probe / broker_burst_probe 都提到)', /fstreak_probe/.test(R.whyTxt) && /tdcc_probe/.test(R.whyTxt) && /broker_burst_probe/.test(R.whyTxt), R.whyTxt.slice(0, 120));

console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ RPCHIP_PASS');
process.exit(fails.length ? 1 : 0);
