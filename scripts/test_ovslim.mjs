#!/usr/bin/env node
/**
 * 🧹 V77.5.2 總覽只留最強策略 + 精簡摺疊 ・ 基本面全展開 + X 光機刪評分留事實
 *
 * 使用者 2026-09-23:「檢視總覽頁面…把過時的策略移除,保留最強策略及必要看到的資訊…折疊部分需要嗎?」
 *   「基本面全部展開,另外把沒有用的 X 光機功能刪除」→ 選「精簡折疊」「刪評分留事實」「硬停損跟回測一樣」。
 *
 * 釘住的用意:
 *   ① 總覽看得到的地方(第一眼 + 打開摺疊)⛔ 不可再出現舊朱家泓劇本的字眼
 *   ② 有庫存時摺疊區要有三條出場(你設定的線 / 抱滿 20 天 / 硬停損),數字 = `_exitDistance`
 *   ③ `_exitMode.on` ⛔ 不可因為「跌破 5 日線」翻成出場;決定性對照:硬停損被跌破時必須翻
 *   ④ 🔔 一鍵盯價只盯三條出場線裡的價格線(有庫存)——⛔ 不可有 5 日線 / 前高 / 月線
 *   ⑤ 產生者還活著(舊卡搬進 #ovLegacyHold 照算不顯示):_keyLevels / _upsideStash / _lastGauge
 *   ⑥ 基本頁 0 個關起來的 <details>、看不到體質分 / 投資屬性 / 市場預期 / 🟢便宜 標籤
 *   ⑦ 事實數字還在(本益比 / 殖利率 / 自己的本益比位階)
 * ⚠️ 原始碼斷言一律先剝 // 註解(被自己的註解救活已經七次)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.OVS_FILE || path.join(ROOT, 'index.html');
const SRC = fs.readFileSync(HTML, 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails++; };
const noCmt = t => t.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fnSrc = head => { const i = SRC.indexOf(head); if (i < 0) return ''; return noCmt(SRC.slice(i, SRC.indexOf('\n    },\n', i))); };

// ── 靜態 ──
const gauge = fnSrc('    _overallGaugeHtml(');
ok('⓪ 緊急列⛔ 不再推「高檔爆量收黑 → 明天不漲快跑」與舊卡 big 字串的出場警示',
   gauge.length > 1000 && !/明天不漲快跑/.test(gauge) && !/立刻出場」鐵律/.test(gauge), gauge.length);
const dec = fnSrc('    _ovDecide(');
ok('⓪b 主卡⛔ 不再列「另一條出場線也破了」', dec.length > 3000 && !/另一條出場線也破了/.test(dec), '');
ok('⓪c 主卡⛔ 不再叫你「反彈先出一半」(回測沒有分批出場)', !/先出一半/.test(dec), '');
// 📈 V77.5.3 觸發價只算一次(`_ovKeyLevelsHtml` 存進 `_keyLevels.trigPx`),價格尺 ⛔ 不可自己再呼叫 _pbEdgeOf(第二份真相)
const ruler = fnSrc('    _priceRulerHtml(');
const klv = fnSrc('    _ovKeyLevelsHtml(');
ok('⓪d 價格尺的觸發價讀 _keyLevels.trigPx(⛔ 不可自己呼叫 _pbEdgeOf)',
   ruler.length > 2000 && /K\.trigPx/.test(ruler) && !/_pbEdgeOf\(/.test(ruler), ruler.length);
ok('⓪e _keyLevels 的觸發價跟主卡同一個條件:⛔ 空頭不給、⛔ loose 不給、持有不給',
   /trigPx = \+_pb\.trig/.test(klv) && /!_pb\.loose/.test(klv) && /!this\._bearGate\(/.test(klv) && /if \(!\(cost > 0\)\)/.test(klv), '');

const B = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const run = async (sym, inv) => {
    const page = await B.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(() => {
        const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
        Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }), writable: true, configurable: true });
    });
    await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
    await page.goto(pathToFileURL(HTML).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 30000 });
    const r = await page.evaluate(async ([sym, inv]) => {
        try { app.switchAppTab('diag'); } catch (_) { }
        if (inv) app.inventory = [inv];
        await app.analyze(sym, true, false, true);
        await new Promise(r => setTimeout(r, 3500));
        // ⚠️ init() 尾端會在幾秒後把頁面切回庫存頁(page_sweep 踩過)→ 量之前再切一次
        try { app.switchAppTab('diag'); } catch (_) { }
        try { app.switchSubTab('strategy'); } catch (_) { }
        await new Promise(r => setTimeout(r, 2000));
        try { app.switchAppTab('diag'); app.switchSubTab('strategy'); } catch (_) { }
        const vis = el => { for (let e = el; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).display === 'none') return false; return true; };
        const wrap = document.getElementById('ovMoreWrap');
        if (wrap) wrap.classList.remove('hidden');
        const root = document.getElementById('subContentStrategy');
        root.querySelectorAll('details').forEach(d => d.open = true);
        const seen = [...root.querySelectorAll('*')].filter(e => e.children.length === 0 && vis(e)).map(e => e.textContent).join(' ');
        const hold = document.getElementById('ovLegacyHold');
        const o = {
            seen, fold: (wrap && wrap.innerText) || '',
            holdHasLegacy: !!(hold && hold.querySelector('#trendCommandCard') && hold.querySelector('#chuExitSopCard')),
            holdHidden: hold ? getComputedStyle(hold).display === 'none' : false,
            exitOn: app._exitMode ? app._exitMode.on : null,
            trig: (app._armTrigStash && app._armTrigStash.triggers) || [],
            ed: (() => { try { const e = app._exitDistance(app.rawDailyData, sym); return e && { lines: e.lines.map(l => ({ k: l.k, v: l.v, name: l.name })), maxd: e.maxd }; } catch (_) { return null; } })(),
            kl: !!(app._keyLevels && String(app._keyLevels.sym) === sym),
            up: !!(app._upsideStash),
            gauge: !!(app._lastGauge),
            ma5: (() => { try { const a = app.indicators.ma5; return +a[a.length - 1]; } catch (_) { return null; } })(),
            C: +app.rawDailyData[app.rawDailyData.length - 1].close,
        };
        // ⑥ 基本頁
        try { app.switchAppTab('diag'); app.switchSubTab('corp'); } catch (_) { }
        await new Promise(r => setTimeout(r, 2500));
        try { app.switchAppTab('diag'); app.switchSubTab('corp'); } catch (_) { }
        // X 光機的數字是非同步填的(先吐「…」)→ 等到本益比有數字再量(最多 10 秒)
        for (let i = 0; i < 20 && !/\d/.test((document.getElementById('xrayPe') || {}).textContent || ''); i++) await new Promise(r => setTimeout(r, 500));
        const corp = document.getElementById('subContentCorp');
        o.corpClosed = [...corp.querySelectorAll('details')].filter(d => !d.open).map(d => d.id || (d.querySelector('summary') || {}).textContent || '?');
        o.corpSeen = [...corp.querySelectorAll('*')].filter(e => e.children.length === 0 && vis(e)).map(e => e.textContent).join(' ');
        o.radar = !!document.getElementById('xrayInvRadar');
        o.pe = (document.getElementById('xrayPe') || {}).textContent || '';
        o.peBand = !!document.getElementById('xrayPeBand');
        o.yld = (document.getElementById('xrayYield') || {}).textContent || '';
        return o;
    }, [sym, inv]);
    await page.close();
    return r;
};

const BAD = /交易風格|主守 ?5 ?日線|20MA 保衛|逃命價|等距一倍|等距二倍|四關通關|進場友善度|明日劇本|分批進場|另一條出場線|回後買上漲|先出一半|🛒|追買|綜合信心|立刻出場/;
const A = await run('2330', null);
ok('①0 空過守門:總覽真的有畫出東西', A.seen.length > 300, A.seen.length);
ok('① 空手:總覽看得到的地方⛔ 沒有舊劇本字眼', !BAD.test(A.seen), (A.seen.match(BAD) || [])[0]);
ok('①b 舊卡搬進 #ovLegacyHold 而且那一格永遠不顯示', A.holdHasLegacy && A.holdHidden, JSON.stringify([A.holdHasLegacy, A.holdHidden]));
ok('⑤ 產生者還活著(_keyLevels / _upsideStash / _lastGauge)', A.kl && A.up && A.gauge, JSON.stringify([A.kl, A.up, A.gauge]));
ok('⑥ 基本頁 0 個關起來的 <details>(使用者:「全部展開」)', A.corpSeen.length > 200 && A.corpClosed.length === 0, JSON.stringify(A.corpClosed));
ok('⑥b 基本頁⛔ 看不到體質分 / 投資屬性 / 市場預期 / 便宜昂貴標籤',
   !/體質分|投資屬性|市場預期|超預期空間|🟢 便宜|🔴 昂貴|🟢 同業便宜|同業偏貴|✅ 比同業便宜|⚠️ 比同業貴|體質強勁|體質穩健/.test(A.corpSeen) && !A.radar,
   (A.corpSeen.match(/體質分|投資屬性|市場預期|超預期空間|🟢 便宜|🔴 昂貴|🟢 同業便宜|同業偏貴|✅ 比同業便宜|⚠️ 比同業貴|體質強勁|體質穩健/) || [])[0] || (A.radar ? 'radar' : ''));
ok('⑦ 事實數字還在(本益比 / 殖利率 / 自己的本益比位階)', /\d/.test(A.pe) && /\d/.test(A.yld) && A.peBand, JSON.stringify([A.pe, A.yld, A.peBand]));

// ── 有庫存:現價在 5 日線下、但三條都沒破 ──
const C0 = A.C;
const bd = '2026-08-26';
const H = await run('2330', { symbol: '2330', cost: +(C0 * 0.97).toFixed(2), shares: 2, buyDate: bd });
ok('②0 測資守門:現價真的在 5 日線下(⛔ 否則 ③ 空過)', H.ma5 > 0 && H.C < H.ma5, JSON.stringify([H.C, H.ma5]));
ok('② 有庫存:總覽看得到的地方⛔ 沒有舊劇本字眼', H.seen.length > 300 && !BAD.test(H.seen), (H.seen.match(BAD) || [])[0]);
const hard = H.ed && H.ed.lines.find(l => l.k === 'hard'), rule = H.ed && H.ed.lines.find(l => l.k === 'rule');
ok('②b 摺疊區列出三條出場:你設定的線 / 抱滿 20 天 / 硬停損(數字 = _exitDistance)',
   hard && rule && H.fold.includes(hard.v.toFixed(2)) && H.fold.includes(rule.v.toFixed(2)) && /抱滿 20 個交易日/.test(H.fold),
   JSON.stringify({ hard: hard && hard.v, rule: rule && rule.v, fold: H.fold.slice(0, 400) }));
ok('③ ⭐ 跌破 5 日線 ⛔ 不可讓 _exitMode.on 翻成出場', H.exitOn === false, H.exitOn);
ok('④ 🔔 盯價只盯三條出場的價格線(⛔ 沒有 5 日線 / 前高 / 月線)',
   H.trig.length >= 1 && H.trig.every(t => /硬停損|唐奇安|ATR|回落|出場線|日線/.test(t.label) && !/5 日線|前高|月線/.test(t.label)),
   JSON.stringify(H.trig));
// ⚠️ 不給買進日 → 硬停損 = 成本 × 0.95(給了的話會取買進當天低,可能反而在現價下面 = 對照組失效)
const HB = await run('2330', { symbol: '2330', cost: +(C0 * 1.2).toFixed(2), shares: 2, buyDate: '' });
ok('③b ⭐ 決定性對照:硬停損被跌破時 _exitMode.on 必須是 true', HB.exitOn === true, HB.exitOn);

await B.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ OVSLIM_PASS(全部通過)');
process.exit(fails ? 1 : 0);
