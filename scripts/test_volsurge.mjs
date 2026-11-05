#!/usr/bin/env node
/**
 * 🔬 V81.0.2 頂端 🤖 泡泡「今天量比昨天大」(原「剛爆量啟動」)守門
 *
 * 使用者 11/06 截圖問「盤中爆量的單可以跟嗎?這些是台股全部爆量的個股嗎?」→ 查證:
 *   ① 定義寫錯:畫面寫「今日投影量 ÷ 5 日均量」,實際是永豐快照 volume_ratio = 今天到現在 ÷ 昨天整天
 *   ② 不是全部爆量股:只收漲 1.5~6%、ETF 不算
 *   ③ scripts/volsurge_probe.mjs(2010 起日 K、比同一天全部股票)照著買 1/5/20 天都比較差、門檻越嚴越差
 *   → 照 V79.0.3「沒過關的盤中方向只放實驗室」:一般模式整個不出現;說明改成真的定義;⛔ 叫人買的字眼
 *
 * 釘住:
 *   ⓪ 靜態:兩支函式(剝掉 // 註解)⛔ 再出現舊說法;說明裡有真的定義與「不是什麼」
 *   ① 一般模式:同一份快照 → 泡泡藏起來、清單 0 檔、點了也不開清單
 *   ② 實驗室模式:同一份快照 → 泡泡出現、清單 = 昨量比 ≥2.5 且漲 1.5~6% 且不是 ETF,照昨量比排
 *      ⭐ 決定性對照:①② 只換模式
 *   ③ 實驗室清單畫面:有定義、有「⛔ 不是買進訊號」、⛔ 舊說法
 *   ④ 沒開盤 → 實驗室也藏起來(原本的行為不變)
 *   注入:INJECT=nogate → 拿掉一般模式那道守門,① 必紅
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let HTML = path.join(ROOT, 'index.html');
let SRC = fs.readFileSync(HTML, 'utf8');
const GATE = "        if (!this._labMode()) { this._volSurgeList = []; hide(); return; }   // 🔬 V81.0.2 一般模式不顯示\n";
if (process.env.INJECT === 'nogate') {
    if (!SRC.includes(GATE)) { console.log('❌ 注入失敗:找不到守門那一行'); process.exit(1); }
    SRC = SRC.replace(GATE, '');
    HTML = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vsg-')), 'index.html');
    fs.writeFileSync(HTML, SRC);
    console.log('💉 INJECT=nogate:拿掉一般模式守門');
}
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails++; };
const strip = s => s.split('\n').map(l => l.replace(/\s\/\/\s.*$/, '').replace(/^\s*\/\/.*$/, '')).join('\n');
const fnSrc = (head, next) => { const a = SRC.indexOf(head); if (a < 0) return ''; const b = SRC.indexOf(next, a + head.length); return SRC.slice(a, b > a ? b : a + 6000); };

// ── 靜態 ──
const radar = strip(fnSrc('    renderVolSurgeRadar() {', '\n    _showVolSurgeSheet() {'));
const sheet = strip(fnSrc('    _showVolSurgeSheet() {', '\n    _startLiveQuotePoll() {'));
ok('⓪ 空過守門:切得到兩支函式', radar.length > 600 && sheet.length > 1500, `${radar.length} / ${sheet.length}`);
const OLD = ['主力剛進場', '主力最積極', '比追高更早', '比追已漲', '該買幾張', '投影量', '5日均量', '5 日均量', '飆股訊號', '卡位'];
for (const w of OLD) ok(`⓪b ⛔「${w}」`, !radar.includes(w) && !sheet.includes(w));
ok('⓪c 說明寫真的定義(今天到現在 ÷ 昨天整天)', /今天到現在的成交量 ÷ 昨天整天的成交量/.test(sheet));
ok('⓪d 說明講「不是什麼」(不是台股全部爆量的股票)', /不是台股全部爆量的股票/.test(sheet));
ok('⓪e 清單底下寫 ⛔ 不是買進訊號', /⛔ 不是買進訊號/.test(sheet));
ok('⓪f 篩選條件沒動(vr ≥ 2.5、漲 1.5~6、ETF 不算)', /vr >= 2\.5 && c >= 1\.5 && c <= 6/.test(radar) && /\/\^00\/\.test\(sym\)/.test(radar));
const bubbleHtml = (() => { const a = SRC.indexOf('<div id="aiRobotBubble"'); return a > 0 ? SRC.slice(a, a + 700) : ''; })();
ok('⓪g 泡泡預設文字⛔ 舊說法', bubbleHtml.length > 100 && !/剛爆量啟動/.test(bubbleHtml), bubbleHtml.slice(0, 200));

// ── 執行期 ──
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderVolSurgeRadar && !!app._showVolSurgeSheet, null, { timeout: 60000 });

const R = await page.evaluate(() => {
    const A = app, out = {};
    const Q = {
        '1101': { c: 3.2, vr: 4.1, p: 30 },      // ✅
        '2330': { c: 1.5, vr: 2.5, p: 1000 },    // ✅ 剛好在門檻上
        '3008': { c: 6.0, vr: 9.9, p: 2000 },    // ✅ 漲 6% 上限
        '2317': { c: 6.1, vr: 8.0, p: 200 },     // ⛔ 漲超過 6%
        '2454': { c: 1.4, vr: 5.0, p: 1300 },    // ⛔ 漲不到 1.5%
        '2603': { c: 3.0, vr: 2.4, p: 180 },     // ⛔ 量比不到 2.5
        '2881': { c: -2.0, vr: 6.0, p: 90 },     // ⛔ 下跌
        '0050': { c: 2.0, vr: 5.0, p: 180 },     // ⛔ ETF
        '9999': { c: 3.0, vr: 3.0, p: 0 },       // ⛔ 沒有價
    };
    A._liveQuotes = Q;
    A._liveFresh = () => true;
    let open = true; A.isMarketOpen = () => open;
    A.showToast = () => {};
    const bub = () => document.getElementById('aiRobotBubble');
    const shown = () => { const b = bub(); return !!b && !b.classList.contains('hidden'); };
    const run = (lab) => {
        document.documentElement.classList.toggle('lab', lab);
        document.getElementById('volSurgeSheet')?.remove();
        A._volSurgeList = null;
        A.renderVolSurgeRadar();
        const list = (A._volSurgeList || []).map(o => o.sym);
        A._showVolSurgeSheet();
        const m = document.getElementById('volSurgeSheet');
        const help = m ? [...m.querySelectorAll('[onclick]')].map(e => e.getAttribute('onclick')).filter(t => /_helpBox\(/.test(t)).join('\n') : '';
        return { shown: shown(), list, sheet: !!m, txt: m ? m.innerText : '', help, bub: document.getElementById('aiRobotBubbleText')?.textContent || '' };
    };
    out.norm = run(false);
    out.lab = run(true);
    open = false; out.closed = run(true); open = true;
    document.documentElement.classList.remove('lab');
    return out;
});
await browser.close();

ok('① 一般模式:泡泡藏起來', !R.norm.shown, JSON.stringify(R.norm));
ok('①b 一般模式:清單 0 檔', R.norm.list.length === 0, R.norm.list);
ok('①c 一般模式:點了也不開清單', !R.norm.sheet);
ok('② 實驗室模式:同一份快照 → 泡泡出現(決定性對照)', R.lab.shown, JSON.stringify(R.lab).slice(0, 200));
ok('②b 實驗室清單 = 條件內的 3 檔,照昨量比排', JSON.stringify(R.lab.list) === JSON.stringify(['3008', '1101', '2330']), R.lab.list);
ok('②c 泡泡文字寫「量比昨天大」⛔ 舊說法', /量比昨天大/.test(R.lab.bub) && !/剛爆量|主力/.test(R.lab.bub), R.lab.bub);
ok('③ 實驗室清單畫面有開', R.lab.sheet);
ok('③b 畫面寫 ⛔ 不是買進訊號', /⛔ 不是買進訊號/.test(R.lab.txt), R.lab.txt.slice(-200));
ok('③c 說明鈕的文字有真的定義', /昨天整天/.test(R.lab.help) && /不是台股全部爆量/.test(R.lab.help), R.lab.help.slice(0, 200));
for (const w of ['主力剛進場', '該買幾張', '比追高更早', '投影量'])
    ok(`③d 畫面與說明⛔「${w}」`, !R.lab.txt.includes(w) && !R.lab.help.includes(w));
ok('④ 沒開盤 → 實驗室也藏起來', !R.closed.shown && R.closed.list.length === 0, JSON.stringify(R.closed).slice(0, 160));
ok('⑤ 沒有 pageerror', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log(fails ? `\n❌ test_volsurge ${fails} 條沒過` : '\n✅ test_volsurge 全部通過');
process.exit(fails ? 1 : 0);
