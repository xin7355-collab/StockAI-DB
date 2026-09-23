#!/usr/bin/env node
/**
 * 🗑️ V77.5.1 當沖頁「沒有用的刪掉、有用的留下、重新排序」守門(使用者:「當沖頁把沒有用的功能刪除,保留有用的,並且重新排序」)
 *
 * 釘住的用意:
 *   ① 刪掉的那幾塊(實測扣完成本全負的操作指令)⛔ 不可悄悄回來:
 *      掛單計畫/已達進場閃爍 ・VWAP ・開盤定調 ・ORB ・相對大盤強弱 ・量能達標度 ・隔日沖 T+1 ・隔日沖判斷 ・
 *      打開漲停指令 ・族群補漲候選 ・當沖候選掃描(含 09:15 推播)
 *   ② 當沖頁⛔ 不可再有主動推播(`_fireAlert`)—— 被刪的那兩個推播都是實測不成立的方法
 *   ③ 第一眼順序:🚦 今天這檔怎麼做 → 💰 成本關卡 → 📊 當沖實測(data-dtedge)
 *   ④ 留下來的:成本關卡 / 🚦 / 當沖實測 / 損益試算機 都還在(⛔ 不可「刪過頭」)
 * ⚠️ 原始碼斷言一律先剝 // 註解(被自己的註解救活已經七次)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.DTP_FILE || path.join(ROOT, 'index.html');
const SRC = fs.readFileSync(HTML, 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails++; };
const noCmt = t => t.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n').replace(/<!--[\s\S]*?-->/g, '');
const fnSrc = (head) => { const i = SRC.indexOf(head); if (i < 0) return ''; const j = SRC.indexOf('\n    },\n', i); return noCmt(SRC.slice(i, j)); };

const rdt = (() => { const i = SRC.indexOf('    async renderDayTradeTab('); const j = SRC.indexOf('_dtAdvancedHtml = detail', i); return i > 0 && j > i ? noCmt(SRC.slice(i, j + 200)) : ''; })();
const bx = fnSrc('    _dtBattleExtras(');
const sw = (() => { const i = SRC.indexOf("if (tab === 'daytrade' && this.currentSymbolId)"); return i > 0 ? noCmt(SRC.slice(i, i + 3000)) : ''; })();
ok('⓪ 空過守門:切得到 renderDayTradeTab / _dtBattleExtras / switchSubTab 當沖段', rdt.length > 5000 && bx.length > 500 && sw.length > 200 && /_startDtAccel/.test(sw), [rdt.length, bx.length, sw.length]);

const GONE = [['📋 掛單計畫', /掛單計畫/], ['✅ 已達進場', /已達進場/], ['🩸 VWAP 卡', /分時均價線/], ['🔔 開盤定調', /開盤定調/],
              ['🚀 ORB 卡', /🚀 開盤區間突破/], ['⚖️ 相對大盤強弱', /相對大盤強弱/], ['⚡ 量能達標度', /量能達標度/],
              ['⚡ 隔日沖 T+1', /_overnightT1Card\(/], ['量能閘門 1.5×', /volGate/]];
for (const [n, re] of GONE) ok(`① 🗑️ ${n}⛔ 不可回到當沖頁`, !re.test(rdt), (rdt.match(re) || [])[0]);
ok('①b 🗑️ 作戰室⛔ 不可再呼叫隔日沖判斷 / 族群補漲候選,⛔ 不可再有「打開漲停 → 別追」「跟一小張試單」',
   !/_dtOvernightSpec\(|_dtGroupLink\(|打開漲停|一小張試單/.test(bx), (bx.match(/_dtOvernightSpec\(|_dtGroupLink\(|打開漲停|一小張試單/) || [])[0]);
ok('①c 🗑️ 當沖候選掃描卡(dtScanCard)與 09:15 自動掃描⛔ 不可復活', SRC.indexOf('id="dtScanCard"') < 0 && !/_scanDayTradeCandidates\(\)/.test(sw));
ok('② ⛔ 當沖頁與作戰室⛔ 不可再有主動推播(_fireAlert)', !/_fireAlert\(/.test(rdt) && !/_fireAlert\(/.test(bx));
ok('④ 留下來的四樣還在:成本關卡 / 🚦 / 當沖實測 / 損益試算機',
   /_dtCostGateHtml\(price\)/.test(rdt) && /_dtVerdictInner\(sym/.test(rdt) && /_dtEdgeHtml\(sym\)/.test(rdt) && /當沖損益試算機/.test(rdt));
const iV = rdt.indexOf('this._dtVerdictInner(sym'), iC = rdt.indexOf('${this._dtCostGateHtml(price)}'), iE = rdt.indexOf('${this._dtEdgeHtml(sym)}');
ok('③ 原始碼順序:🚦 → 成本關卡 → 當沖實測', iV > 0 && iV < iC && iC < iE, [iV, iC, iE]);

// ── 動態:真的渲染一次 ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(() => {
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }), writable: true, configurable: true });
});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(HTML).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderDayTradeTab, null, { timeout: 25000 });
const R = await page.evaluate(async () => {
    const o = {};
    let fired = 0; const _fa = app._fireAlert; app._fireAlert = function () { fired++; return _fa && _fa.apply(this, arguments); };
    try { app.switchAppTab('diag'); } catch (_) { }
    try { await app.analyze('2330', true, false, true); } catch (e) { return { err: String(e).slice(0, 160) }; }
    await new Promise(r => setTimeout(r, 2200));
    fired = 0;
    try { app.switchSubTab('daytrade'); } catch (_) { }
    await new Promise(r => setTimeout(r, 3000));
    const body = document.getElementById('dayTradeBody');
    const html = body ? body.innerHTML : '';
    o.len = html.length;
    o.hero = /今日當沖作戰指令/.test(html);
    const strip = h => String(h).replace(/<[^>]+>/g, ' ');
    const t = strip(html);
    o.iV = t.indexOf('🚦'); o.iC = t.indexOf('成本關卡'); o.iE = html.indexOf('data-dtedge');
    o.iCh = html.indexOf('成本關卡');
    o.bad = (t.match(/掛單計畫|已達進場|劇本成真度|隔日沖 T\+1/) || [])[0] || '';
    o.adv = strip(app._dtAdvancedHtml || '');
    o.advBad = (o.adv.match(/分時均價|開盤定調|🚀 開盤區間突破|相對大盤強弱|量能達標度/) || [])[0] || '';
    o.fired = fired;
    o.scan = !!document.getElementById('dtScanCard');
    return o;
});
await browser.close();
if (R.err) { console.log('❌ analyze 失敗:' + R.err); process.exit(1); }
ok('⑤0 空過守門:當沖頁真的渲染出作戰指令', R.hero && R.len > 1000, R.len);
ok('⑤ 渲染後第一眼⛔ 沒有掛單計畫 / 已達進場 / 劇本成真度 / 隔日沖 T+1', !R.bad, R.bad);
ok('⑤b 📊 進階視窗⛔ 沒有 VWAP / 開盤定調 / ORB / 相對大盤 / 量能達標度', !R.advBad, R.advBad);
ok('⑤c 渲染後順序:🚦 在成本關卡之前,成本關卡在當沖實測之前', R.iV >= 0 && R.iV < R.iC && R.iCh < R.iE, [R.iV, R.iC, R.iCh, R.iE]);
ok('⑤d 進當沖頁⛔ 不會觸發任何主動推播', R.fired === 0, R.fired);
ok('⑤e 頁面上沒有當沖候選掃描卡', !R.scan);
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ DTPRUNE_PASS(全部通過)');
process.exit(fails ? 1 : 0);
