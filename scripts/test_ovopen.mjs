#!/usr/bin/env node
/**
 * 🌅 V78.5.2 總覽「開盤怎麼做」守門(使用者:「依照昨日該股收盤價,今天開高、平、低幾%,建議怎麼買賣」)
 * ⛔ 一條新規則都不准寫 —— 每一列只轉述既有規則:
 *   👑 `_leadWhen`(開盤跌 ≥3% 那條)・🟥 `d.due.rules`(`_LUNEXT_EDGE` 四條)・🔥 出場「收盤確認」・🔥 進場「尾盤 ≥ 觸發價」・ETF 買了放著
 * 釘住:
 *   ⓐ 👑 換倉日要賣(split)→ 開低 ≥3% 那列「09:30~10:00」、其他「開盤就賣」;⭐ 決定性對照:leadTiming=open → 09:30 那列消失、只剩一列
 *   ⓑ 👑 換倉日要買 → 開低 ≥3% 開盤買 / 其他 13:25 / 開盤就漲停 不追
 *   ⓒ 👑 名單日 ≠ 基準那根(舊名單)→ ⛔ 不給換倉時點
 *   ⓓ 👑 續抱 / 🔥 沒觸發價 / ETF → 只有一列「開多少都一樣」(⛔ 不硬切)
 *   ⓔ 🔥 持有:分界價 = 最近的出場線(⭐ 決定性對照:改線價分界跟著移)・線下那列⛔ 不可叫你開盤賣
 *   ⓕ 🔥 鎖漲停隔天:四列文字 == `d.due.rules`(同一份)
 *   ⓖ 🔥 沒持有有觸發價:⭐ 改 trigPx 文字跟著變;漲停那列「不追」
 *   ⓗ 價位都對到跳動單位;要賣的列有元(`_netPL`)
 *   ⓘ 盤中:基準 = 昨收(`_fuglePrevClose`),今天實際開盤那一列有 👉 且只有一列
 *   ⓙ 指數不顯示;切股不殘留;390px 不溢出;⛔ 研究字樣
 * 注入:拿掉 `_leadTiming` 判斷 / 線下改成「開盤賣」/ 價位不對跳動單位 → 各紅
 * 🌅 V78.5.3 開盤卡合一(使用者:「開高、中、開盤機率」+ 機率圖「不是我要呈現的樣子」):
 *   ⓟ 每一列 p(這檔過去一年開在那一段)+ pb(一般股票 `_GAP_BASE`)各自加總 = 100%
 *   ⓟb ⭐ 決定性對照:K 線改成天天開高 2% → 「開低 3% 以內~開高」那列 = 100%;改成天天開低 4% → 第一列 = 100%
 *   ⓟc |跳空| > 11%(分割)剔除;< 120 天 → 不給這檔、只列一般股票並寫原因
 *   ⓟd 只有一列 → 三格 開高 1%↑ / 開平 ±1% / 開低 1%↓
 *   ⓟe 📊 明天收盤那一行 == `_probBox` chip 同一組數字;總覽沒有 #ovProbBox
 *   注入(INJECT=):hard(機率寫死)/ noskip(不剔除 >11%)/ nobase(拿掉一般股票)→ 各紅
 * 🌅 V78.5.4 改版(使用者:「漲停鎖住 / 開高 ?% / 平盤 / 開低 ?% / 跌停,用機率告訴我怎麼出場」):
 *   規則那幾列不再放機率 → 改成「📌 你的規則」;機率改放固定五列「開盤後通常怎麼走」
 *   ⓟ 五列順序 lu/hi/flat/lo/ld、這檔與一般股票各自加總 = 100%
 *   ⓟb ⭐ 決定性對照:天天開高 2% → 平盤列 100%、天天開高 4% → 開高列 100%、天天開低 4% → 開低列 100%、天天開盤漲停 → 漲停列 100%
 *   ⓟg 怎麼走那句只轉述 `_GAP_BASE.after`;⭐ 改 after.hi → 文字跟著翻;|平均| < 0.5% 說差不多
 *   ⓟh 👑 → 「參考,不是你這套的規則」;🔥 → 只有「參考」
 *   注入:noafter(拿掉 after)→ 紅
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let HTML = process.env.INDEX_HTML || path.join(ROOT, 'index.html');
const INJ = process.env.INJECT || '';
if (INJ) {
    let S = fs.readFileSync(HTML, 'utf8'); const O = S;
    if (INJ === 'hard') S = S.replace("p: gs ? this._gapShare(gs, r.lo, r.hi) : null", "p: gs ? 20 : null");
    if (INJ === 'noskip') S = S.replace("if (Math.abs(g) > 11) continue;\n            rows.push({ g, lu: o >= this._floorTick", "rows.push({ g, lu: o >= this._floorTick");
    if (INJ === 'nobase') S = S.replace("pb: this._gapShare(null, r.lo, r.hi), A:", "pb: null, A:");
    if (INJ === 'noafter') S = S.replace("A: AF[r.k] || null", "A: null");
    if (S === O) { console.log('❌ 注入沒有注進去'); process.exit(1); }
    HTML = path.join(ROOT, '.test_ovopen_inj.html'); fs.writeFileSync(HTML, S);
}
const { badOf } = await import(path.join(ROOT, 'scripts/lib_retailbad.mjs'));
const { rwdShim } = await import(path.join(ROOT, 'scripts/lib_rwdshim.mjs'));
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 400)}`}`); if (!c) fails.push(n); };

const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._ovOpenPlan && !!app._renderOvOpen && !!app._netPL, null, { timeout: 30000 });
// 🌅 V78.5.5 #ovOpenBox 搬進 #ovCommandCenter(由 _renderOvCommand 畫);這支測試直接呼叫 _renderOvOpen → 先擺一個同 id 的容器
await page.evaluate(() => { if (!document.getElementById('ovOpenBox')) { const d = document.createElement('div'); d.id = 'ovOpenBox'; d.className = 'hidden w-full'; (document.getElementById('ovCommandCenter') || document.body).appendChild(d); } });

const R = await page.evaluate(() => {
    const out = {};
    const mk = (last = 213.5) => {
        const rows = [];
        for (let i = 0; i < 60; i++) {
            const c = +(last - (59 - i) * 0.5).toFixed(1);
            const dt = new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
            rows.push({ date: dt, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 1000 });
        }
        rows[59].close = last;
        return rows;
    };
    const data = mk();
    const lastDate = data[59].date.replace(/\//g, '-');
    app.currentSymbolId = '5483';
    app.isMarketOpen = () => false;
    app._lastBarIsToday = () => false;
    app._dueWhen = () => ({ late: true, when: '明天', openWhen: '明天', eodWhen: '明天' });
    app.settings = app.settings || {};
    const plan = (d, o = {}) => app._ovOpenPlan(o.data || data, o.sym || '5483', d);
    const lead = (st, extra = {}) => ({ held: st === 'sell' || st === 'keep' || st === 'outwait', state: 'hold', cost: 200, shares: 2, lead: { st, isRebal: true, date: lastDate, left: 3, H: 10, N: 5, ...extra } });
    const acts = P => P ? P.rows.map(r => r.act) : null;
    const lbls = P => P ? P.rows.map(r => r.lbl) : null;

    // ⓐ 👑 賣
    app.settings.leadTiming = 'split';
    const a1 = plan(lead('sell'));
    app.settings.leadTiming = 'open';
    const a2 = plan(lead('sell'));
    app.settings.leadTiming = 'split';
    out.a = { split: { acts: acts(a1), lbls: lbls(a1), amt: a1.rows.map(r => r.amt) }, open: { acts: acts(a2), lbls: lbls(a2) } };
    // ⓑ 👑 買
    const b1 = plan(lead('buy'));
    out.b = { acts: acts(b1), lbls: lbls(b1) };
    // ⓒ 舊名單
    out.c = acts(plan(lead('sell', { date: '2026-01-02' })));
    // ⓓ 一列的
    out.d = {
        keep: lbls(plan(lead('keep'))), keepA: acts(plan(lead('keep'))),
        etf: acts(plan({ state: 'etfhold', held: true })),
        none: acts(plan({ state: 'wait', held: false, badge: '⏳ 觀望・沒有進場價' })),
    };
    // ⓔ 🔥 持有
    const held = v => ({ state: 'hold', held: true, cost: 200, shares: 1, exitDist: { lines: [{ k: 'stop', name: '硬停損', v: 190 }, { k: 'rule', name: '你的出場線', v }] } });
    const e1 = plan(held(205.8)), e2 = plan(held(201.8));
    out.e = { l1: lbls(e1), a1: acts(e1), l2: lbls(e2), amt: e1.rows.map(r => r.amt) };
    // ⓕ 鎖漲停
    const rules = [['開盤就在漲停', '<b>先抱著</b>;收盤沒鎖就尾盤賣'], ['開高 ≥5%', '<b>開盤就賣</b>'], ['開高 0~5%', '<b>09:30 前賣</b>'], ['開平 / 開低', '⛔ 別在開盤殺,<b>尾盤賣</b>']];
    const f1 = plan({ state: 'exit', held: true, cost: 200, shares: 1, due: { lu: true, rules } });
    out.f = { acts: acts(f1), lbls: lbls(f1) };
    out.f2 = acts(plan({ state: 'exit', held: true, cost: 200, shares: 1, due: { lu: false } }));
    // ⓖ 觸發價
    app._keyLevels = { sym: '5483', trigPx: 218 };
    const g1 = plan({ state: 'wait', held: false });
    app._keyLevels = { sym: '5483', trigPx: 222.5 };
    const g2 = plan({ state: 'wait', held: false });
    app._keyLevels = { sym: '9999', trigPx: 222.5 };   // 別檔殘留 ⛔ 不可用
    const g3 = plan({ state: 'wait', held: false, badge: '⏳ 觀望' });
    out.g = { a1: acts(g1), a2: acts(g2), l1: lbls(g1), a3: acts(g3) };
    // ⓗ 價位都在跳動單位上
    const allTxt = [a1, b1, e1, g1].flatMap(P => P.rows.map(r => r.lbl)).join(' ');
    const nums = (allTxt.match(/\d[\d,]*\.?\d*/g) || []).map(s => +s.replace(/,/g, '')).filter(x => x > 100);
    out.h = { nums, bad: nums.filter(x => { const t = app._tickOf(x); return Math.abs(Math.round(x / t) * t - x) > 1e-6; }) };
    // ⓘ 盤中
    app.isMarketOpen = () => true;
    app._lastBarIsToday = () => true;
    app._fuglePrevClose = 213.5;
    const dl = mk(); dl.push({ date: '2026/09/01', open: 206, high: 207, low: 204, close: 205, volume: 10 });
    app._closedTail = d => d.slice(0, -1);
    const i1 = app._ovOpenPlan(dl, '5483', lead('sell'));
    out.i = { base: i1.base, when: i1.when, baseLbl: i1.baseLbl, hits: i1.rows.filter(r => r.hit).map(r => r.lbl) };
    // DOM:盤中渲染
    app._renderOvOpen('5483', dl, lead('sell'));
    const el = document.getElementById('ovOpenBox');
    out.dom = { hidden: el.classList.contains('hidden'), txt: el.innerText, hitN: el.querySelectorAll('[data-ovopen-row][data-ovopen-hit]').length, fiveHit: [...el.querySelectorAll('[data-ovopen-five][data-ovopen-hit]')].map(x => x.getAttribute('data-ovopen-five')), amtN: el.querySelectorAll('[data-ovopen-amt]').length };
    // ⓙ 切股 / 指數
    app._renderOvOpen('2330', dl, lead('sell'));
    out.j = { other: el.classList.contains('hidden') && !el.innerHTML };
    app.currentSymbolId = '^TWII';
    app._renderOvOpen('^TWII', dl, lead('sell'));
    out.j.idx = el.classList.contains('hidden') && !el.innerHTML;
    // 收盤後文字
    app.currentSymbolId = '5483';
    app.isMarketOpen = () => false; app._lastBarIsToday = () => false;
    app._renderOvOpen('5483', data, held(205.8));
    out.closedTxt = el.innerText;
    return out;
});

// ⓐ
ok('ⓐ split 要賣:開低 ≥3% → 09:30~10:00', R.a.split.acts.length === 2 && /09:30~10:00/.test(R.a.split.acts[0]) && /開低 3% 以上/.test(R.a.split.lbls[0]), JSON.stringify(R.a.split));
ok('ⓐb split 其他 → 開盤就賣', /09:00 開盤就賣/.test(R.a.split.acts[1]), JSON.stringify(R.a.split));
ok('ⓐc ⭐ leadTiming=open → 09:30 那列消失、只剩一列', R.a.open.acts.length === 1 && !/09:30/.test(R.a.open.acts.join('')) && R.a.open.lbls[0] === '開多少都一樣', JSON.stringify(R.a.open));
ok('ⓐd 要賣的列有約賺賠多少元', R.a.split.amt.every(a => Array.isArray(a) && a.every(Number.isFinite)), JSON.stringify(R.a.split.amt));
// ⓑ
ok('ⓑ 要買:開低 ≥3% 開盤買 / 其他 13:25 / 漲停不追', R.b.acts.length === 3 && /開盤就買/.test(R.b.acts[0]) && /13:25/.test(R.b.acts[1]) && /不追/.test(R.b.acts[2]) && /開盤就漲停/.test(R.b.lbls[2]), JSON.stringify(R.b));
// ⓒ
ok('ⓒ 舊名單 ⛔ 不給換倉時點', R.c.length === 1 && /還沒更新/.test(R.c[0]) && !/09:00|13:25/.test(R.c[0]), JSON.stringify(R.c));
// ⓓ
ok('ⓓ 👑 續抱一列', R.d.keep.length === 1 && R.d.keep[0] === '開多少都一樣' && /續抱/.test(R.d.keepA[0]), JSON.stringify(R.d));
ok('ⓓb ETF 一列「持續抱著」', R.d.etf.length === 1 && /持續抱著/.test(R.d.etf[0]), JSON.stringify(R.d.etf));
ok('ⓓc 🔥 沒觸發價一列「不買」', R.d.none.length === 1 && /不買/.test(R.d.none[0]), JSON.stringify(R.d.none));
// ⓔ
ok('ⓔ 🔥 持有:分界 = 最近出場線 205.8 → 跳動單位 205.5', R.e.l1.length === 2 && /205\.5 元以下/.test(R.e.l1[0]) && /205\.5 元以上/.test(R.e.l1[1]), JSON.stringify(R.e));
ok('ⓔb ⭐ 改線價 → 分界跟著移(201.5)', /201\.5/.test(R.e.l2.join(' ')) && !/205\.5/.test(R.e.l2.join(' ')), JSON.stringify(R.e.l2));
ok('ⓔc 線下那列 ⛔ 不可叫你開盤賣(收盤確認)', /別開盤殺/.test(R.e.a1[0]) && /尾盤賣/.test(R.e.a1[0]) && !/開盤就賣/.test(R.e.a1[0]), R.e.a1[0]);
ok('ⓔd 線上那列續抱', /續抱/.test(R.e.a1[1]), R.e.a1[1]);
// ⓕ
ok('ⓕ 鎖漲停四列 == d.due.rules(由低到高)', R.f.acts.length === 4 && R.f.acts[0] === '⛔ 別在開盤殺,尾盤賣' && R.f.acts[3] === '先抱著;收盤沒鎖就尾盤賣' && /開盤就漲停/.test(R.f.lbls[3]), JSON.stringify(R.f));
ok('ⓕb 時間到期沒鎖漲停 → 一列尾盤賣', R.f2.length === 1 && /尾盤照收盤價賣/.test(R.f2[0]), JSON.stringify(R.f2));
// ⓖ
ok('ⓖ 觸發價寫進文字', /218/.test(R.g.a1.join(' ')) && R.g.a1.some(a => /不追/.test(a)), JSON.stringify(R.g));
ok('ⓖb ⭐ 改 trigPx → 文字跟著變', /222\.5/.test(R.g.a2.join(' ')) && !/218/.test(R.g.a2.join(' ')), JSON.stringify(R.g.a2));
ok('ⓖc 別檔的觸發價 ⛔ 不可用', R.g.a3.length === 1 && /不買/.test(R.g.a3[0]), JSON.stringify(R.g.a3));
// ⓗ
ok('ⓗ 價位都對到跳動單位', R.h.nums.length >= 6 && R.h.bad.length === 0, JSON.stringify(R.h));
// ⓘ
ok('ⓘ 盤中基準 = 昨收(報價商)、標題「今天」', R.i.base === 213.5 && R.i.when === '今天' && R.i.baseLbl === '昨收', JSON.stringify(R.i));
ok('ⓘb 今天開 206(−3.5%)→ 只有「開低 3% 以上」那列 👉', R.i.hits.length === 1 && /開低 3% 以上/.test(R.i.hits[0]), JSON.stringify(R.i.hits));
ok('ⓘc DOM:規則一列 👉 + 今天開在 206', !R.dom.hidden && R.dom.hitN === 1 && /今天開在 206/.test(R.dom.txt) && R.dom.amtN >= 1, R.dom.txt);
ok('ⓘd 五列也只標「開低 3% 以上」那列', R.dom.fiveHit.length === 1 && R.dom.fiveHit[0] === 'lo', JSON.stringify(R.dom.fiveHit));
// ⓙ
ok('ⓙ 切到別檔 → 清空', R.j.other, '');
ok('ⓙb 指數不顯示', R.j.idx, '');
ok('ⓙc 收盤後標題「明天開盤怎麼做」', /🌅 明天開盤怎麼做/.test(R.closedTxt) && /最近收盤 213\.5/.test(R.closedTxt), R.closedTxt);
const bad = [...badOf(R.dom.txt), ...badOf(R.closedTxt)];
ok('ⓙd ⛔ 研究字樣', bad.length === 0, bad.join(' | '));


// 🌅 V78.5.4 五列「開盤後通常怎麼走」
const Q = await page.evaluate(() => {
    const o = {};
    app._closedTail = d => d; app.isMarketOpen = () => false; app._lastBarIsToday = () => false;
    app.currentSymbolId = '5483'; app.settings.leadTiming = 'split';
    const mkG = (n, gOf, back = 0) => { const a = []; let c = 100; for (let i = 0; i < n; i++) { const o2 = i ? c * (1 + gOf(i) / 100) : c; c = back ? c : o2 * (1 + 0.003 * Math.sin(i)); const dt = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10); a.push({ date: dt, open: +o2.toFixed(4), high: Math.max(o2, c) * 1.01, low: Math.min(o2, c) * 0.99, close: +c.toFixed(4), volume: 1000 }); } return a; };
    const G = [-10, -5, -2.5, -0.4, 0, 0.6, 1.5, 3.5, 6, 10];
    const mix = mkG(300, i => G[i % G.length], 1);
    const lead = (st, extra = {}) => ({ held: st !== 'buy', state: 'hold', cost: 200, shares: 2, lead: { st, isRebal: true, date: mix[mix.length - 1].date, left: 3, H: 10, N: 5, ...extra } });
    const held = { state: 'hold', held: true, cost: 90, shares: 1, exitDist: { lines: [] } };
    const fv = P => P.five.map(r => r.p), sum = (P, k) => P.five.reduce((s, r) => s + (r[k] || 0), 0);
    const P1 = app._ovOpenPlan(mix, '5483', lead('sell'));
    o.p1 = { ks: P1.five.map(r => r.k), p: fv(P1), sp: sum(P1, 'p'), spb: sum(P1, 'pb'), n: P1.gapN, lu: P1.five[0].p, ld: P1.five[4].p };
    o.det = {
        flat: fv(app._ovOpenPlan(mkG(300, () => 2), '5483', held)),
        hi: fv(app._ovOpenPlan(mkG(300, () => 4, 1), '5483', held)),
        lo: fv(app._ovOpenPlan(mkG(300, () => -4, 1), '5483', held)),
        lu: fv(app._ovOpenPlan(mkG(300, () => 10, 1), '5483', held)),
    };
    o.split = app._gapStats(mkG(300, i => i === 200 ? 100 : 0.5)).n;
    const short = mkG(80, () => 0.5);
    const Ps = app._ovOpenPlan(short, '5483', held);
    o.short = { p: Ps.five.map(r => r.p), pb: Ps.five.map(r => r.pb), err: Ps.gapErr };
    app._renderOvOpen('5483', short, held);
    const el = document.getElementById('ovOpenBox');
    o.shortTxt = el.innerText;
    // 怎麼走那句
    const after = k => (el.querySelector(`[data-ovopen-after="${k}"]`) || {}).innerText || '';
    app._renderOvOpen('5483', mix, lead('keep'));
    o.lead = { txt: el.innerText, head: (el.querySelector('[data-ovopen-fivehead]') || {}).innerText || '', rule: (el.querySelector('[data-ovopen-rule]') || {}).innerText || '', af: ['lu', 'hi', 'flat', 'lo', 'ld'].map(after) };
    app._renderOvOpen('5483', mix, held);
    o.held = { head: (el.querySelector('[data-ovopen-fivehead]') || {}).innerText || '', txt: el.innerText };
    const A0 = JSON.parse(JSON.stringify(app._GAP_BASE.after));
    o.A = A0;
    app._GAP_BASE.after.hi = { n: 5000, up: 70, dn: 25, oc: 1.2, lock: null };
    app._GAP_BASE.after.flat = { n: 5000, up: 30, dn: 60, oc: -0.9, lock: null };
    app._renderOvOpen('5483', mix, held);
    o.flip = { hi: after('hi'), flat: after('flat') };
    app._GAP_BASE.after = A0;
    // 📊 明天那一行
    app._renderOvOpen('5483', mix, lead('sell'));
    const tomEl = el.querySelector('[data-probtom]');
    o.tom = tomEl ? tomEl.innerText : '';
    const chip = app._probBox('5483', { mode: 'chip', data: mix, link: false });
    const d = document.createElement('div'); d.innerHTML = chip; o.chip = d.innerText;
    o.noProbBox = !document.getElementById('ovProbBox') && !/_renderOvProb/.test(app._renderOvCommand.toString());
    o.mixTxt = el.innerText;
    o.mixRule = (el.querySelector('[data-ovopen-rule]') || {}).innerText || '';
    const B = app._GAP_BASE; o.base = B ? { syms: B.syms, n: B.n, sum: B.bins.reduce((a, b) => a + b, 0), after: !!B.after } : null;
    return o;
});
const near = (a, b, e = 0.05) => Math.abs(a - b) < e;
ok('ⓟ 五列順序 lu/hi/flat/lo/ld', Q.p1.ks.join() === 'lu,hi,flat,lo,ld', JSON.stringify(Q.p1.ks));
ok('ⓟ2 這檔五列加總 = 100%、漲停 / 跌停兩列各 10%', near(Q.p1.sp, 100) && Q.p1.n >= 240 && near(Q.p1.lu, 10, 1) && near(Q.p1.ld, 10, 1), JSON.stringify(Q.p1));
ok('ⓟ3 一般股票五列加總 = 100%', near(Q.p1.spb, 100, 0.2), JSON.stringify(Q.p1));
ok('ⓟ4 _GAP_BASE 直方圖總和 = n、≥1000 檔、有 after', Q.base && Q.base.sum === Q.base.n && Q.base.syms >= 1000 && Q.base.after, JSON.stringify(Q.base));
ok('ⓟb ⭐ 天天開高 2% → 平盤列 100%', near(Q.det.flat[2], 100), JSON.stringify(Q.det.flat));
ok('ⓟb2 ⭐ 天天開高 4% → 開高列 100%', near(Q.det.hi[1], 100), JSON.stringify(Q.det.hi));
ok('ⓟb3 ⭐ 天天開低 4% → 開低列 100%', near(Q.det.lo[3], 100), JSON.stringify(Q.det.lo));
ok('ⓟb4 ⭐ 天天開盤漲停 → 漲停列 100%、開高列 0', near(Q.det.lu[0], 100) && near(Q.det.lu[1], 0), JSON.stringify(Q.det.lu));
ok('ⓟc 分割(+100%)那天剔除', Q.split === 249, Q.split);
ok('ⓟc2 < 120 天 → 不給這檔、只列一般股票並寫原因', Q.short.p.every(x => x == null) && Q.short.pb.every(x => x >= 0) && /只有 79 天/.test(Q.short.err) && /只列一般股票/.test(Q.shortTxt), JSON.stringify(Q.short) + Q.shortTxt);
const A = Q.A;
ok('ⓟg 怎麼走:漲停 / 開高 / 開低 / 跌停 讀 _GAP_BASE.after', new RegExp(`${Math.round(A.lu.lock)}% 收盤還鎖著`).test(Q.lead.af[0]) && new RegExp(`${Math.round(A.hi.dn)}% 收盤比開盤低`).test(Q.lead.af[1]) && new RegExp(`${Math.round(A.lo.up)}% 收盤比開盤高`).test(Q.lead.af[3]) && /賣不掉/.test(Q.lead.af[4]), JSON.stringify(Q.lead.af));
ok('ⓟg2 平盤 |平均| < 0.5% → 差不多', Math.abs(A.flat.oc) < 0.5 && /差不多/.test(Q.lead.af[2]), Q.lead.af[2]);
ok('ⓟg3 ⭐ 改 after.hi(收盤比開盤高)→ 文字翻成「別在開盤殺」;平盤 −0.9% → 開盤賣多半比較好', /70% 收盤比開盤高/.test(Q.flip.hi) && /別在開盤殺/.test(Q.flip.hi) && /60% 收盤比開盤低/.test(Q.flip.flat), JSON.stringify(Q.flip));
ok('ⓟh 👑 → 「參考,不是你這套的規則」+ 📌 你的規則一行', /不是你這套的規則/.test(Q.lead.head) && /你的規則/.test(Q.lead.rule) && /續抱/.test(Q.lead.rule), Q.lead.head + ' || ' + Q.lead.rule);
ok('ⓟh2 🔥 持有 → 只寫「參考」', /參考/.test(Q.held.head) && !/不是你這套/.test(Q.held.head), Q.held.head);
ok('ⓟh3 多列規則照列(split 兩列)', /09:30~10:00/.test(Q.mixRule) && /09:00 開盤就賣/.test(Q.mixRule), Q.mixRule);
const num = (t, k) => { const m = t.match(new RegExp(k + ' (\\d+\\.\\d)')); return m ? m[1] : null; };
ok('ⓟe 📊 明天收盤一行 == chip 同一組數字 + 完整表連結', !!Q.tom && num(Q.tom, '漲') != null && num(Q.tom, '漲') === num(Q.chip, '漲') && num(Q.tom, '跌') === num(Q.chip, '跌') && /完整表/.test(Q.tom), Q.tom + ' || ' + Q.chip);
ok('ⓟe2 總覽沒有 #ovProbBox 圖', Q.noProbBox);
ok('ⓟf 寫明「不是預測」+ ⛔ 研究字樣', /不是預測/.test(Q.mixTxt) && !badOf(Q.mixTxt + Q.lead.txt + Q.shortTxt + Q.held.txt).length, badOf(Q.mixTxt + Q.lead.txt + Q.shortTxt + Q.held.txt).join('|'));

// 390px 不溢出
await page.evaluate(rwdShim);
const ov = await page.evaluate(() => {
    const el = document.getElementById('ovOpenBox');
    const host = document.createElement('div'); host.style.cssText = 'width:358px;position:absolute;left:16px;top:0';
    host.appendChild(el.cloneNode(true)); document.body.appendChild(host);
    const W = host.getBoundingClientRect(); let worst = 0;
    host.querySelectorAll('*').forEach(x => { const r = x.getBoundingClientRect(); if (r.width) worst = Math.max(worst, r.right - W.right); });
    const w = W.width; host.remove(); return { worst, w };
});
ok('ⓙe 390px 不溢出', ov.w >= 350 && ov.worst <= 1, JSON.stringify(ov));
ok('ⓩ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
if (INJ) { try { fs.unlinkSync(HTML); } catch (_) {} }
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
