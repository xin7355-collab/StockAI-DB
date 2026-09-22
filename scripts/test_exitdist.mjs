#!/usr/bin/env node
/**
 * 🚪 V77.4.9 「距離出場線還剩多遠、今天會不會碰到、一鍵智慧單」守門(`app._exitDistance` 全 App 唯一一份)
 *
 * 使用者:「我要明顯地方告訴我距離我設定的策略還剩下多遠要賣出,當天價格會到就應該要顯示出來,讓我直接掛智慧單賣出」。
 * 截圖抓到:主卡「守住 511」(唐奇安)vs 價格位置圖「停損 533」(硬停損),文案卻寫死「(與上方一致)」。
 *
 * 釘住的用意:
 *   ① 三條線(硬停損 / 你設定的線 / 抱滿 20 天)**讀既有函式**的值(⛔ 不複製公式)
 *   ② nearest = 現價下方最近的那條 ③ ATR 用**今天**那根(⛔ 不是 `_exitLines.atr` 那個進場日的)
 *   ④ 門檻 1 / 2 倍今天振幅(讀 `_EXIT_DIST`)⑤ 智慧單觸發價 = `_floorTick`(無條件捨去)
 *   ⑥ 算不出來的那條要寫原因(陷阱 #22)⑦ 抱滿 / 已跌破 ⑧ 決策台:有要盯的就⛔ 不可寫「沒有」、⛔ 不可寫「今天不用做」
 *   ⑨ 「與上方一致」這種寫死的一致性宣稱 0 處 ⑩ 價格位置圖兩條線都畫、名字不同
 * 注入(逐一確認會紅):拿掉硬停損那條 / ATR 退回固定 % / 觸發價改 `_roundTick` / 「與上方一致」復活 / near 有東西仍寫「沒有」
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.INDEX_HTML || path.join(ROOT, 'index.html');
const src = fs.readFileSync(HTML, 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

// ── ⑨ 靜態 ──
ok('⑨ ⛔ 「與上方一致」這種寫死的一致性宣稱:0 處(兩條不同的線,不可說它們一致)', !src.includes('與上方一致'), (src.match(/.{30}與上方一致.{10}/) || [''])[0]);
{
    const i = src.indexOf('    _exitDistance(data, sym, opts) {');
    const blk = i > 0 ? src.slice(i, src.indexOf('\n    },', i)) : '';
    ok('🚧 空過守門:抓得到 _exitDistance', blk.length > 1500, blk.length);
    ok('①s 硬停損讀 `_unifiedExitPlan`、設定線讀 `_exitPrimary`(⛔ 不自己算)', /this\._unifiedExitPlan\(/.test(blk) && /this\._exitPrimary\(/.test(blk) && !/\*\s*0\.95/.test(blk.replace(/x\.cost \* 0\.95/, '')), '');
    ok('③s ATR 用今天那根(`_atrTR14(data, n)`)', /this\._atrTR14\(data, n\)/.test(blk), '');
    ok('⑤s 觸發價用 `_floorTick`(⛔ 不可四捨五入 —— 會提早把你洗出去)', /this\._floorTick\(tgt\.v\)/.test(blk) && !/_roundTick/.test(blk), '');
}

const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._exitDistance && !!app.renderDeck, null, { timeout: 30000 });

const R = await page.evaluate(async () => {
    const out = {};
    // 60 根:前 40 根 90~100 盤整,後 20 根緩漲到 110;日內振幅 ±1
    const rows = [];
    for (let i = 0; i < 60; i++) {
        const c = i < 40 ? 95 + (i % 5) : 100 + (i - 39) * 0.5;
        const d = new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
        rows.push({ date: d, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 });
    }
    const sym = '9999';
    app.currentSymbolId = '0000';               // ⚠️ 刻意不是這檔 → 驗 `ind` 走 {} 那條(陷阱 #19)
    const setInv = inv => { app._getInventory = () => inv; };
    const buyDate = rows[45].date.replace(/\//g, '-');
    setInv([{ symbol: sym, cost: 100, shares: 2, buyDate }]);
    const ed = app._exitDistance(rows, sym);
    out.ed = ed;
    const plan = app._unifiedExitPlan(rows, 100, buyDate, {});
    out.hardRef = plan && plan.stopFinal;
    const ep = app._exitPrimary(rows, sym); out.ruleRef = ep && ep.v;
    out.atrRef = app._atrTR14(rows, rows.length - 1);
    // ③ 把 `_exitLines.atr` 改成 999 不可影響「今天的振幅」
    const _el = app._exitLines.bind(app);
    app._exitLines = (d, s) => { const x = _el(d, s); return x ? { ...x, atr: 999 } : x; };
    out.edAtr999 = app._exitDistance(rows, sym);
    app._exitLines = _el;
    // ④ 門檻:控制今天振幅,距離 0.5 / 1.5 / 5 倍
    const _atr = app._atrTR14.bind(app);
    const gap = ed.nearest ? ed.pC - ed.nearest.v : null;
    const lvAt = k => { app._atrTR14 = () => gap / k; const r = app._exitDistance(rows, sym); app._atrTR14 = _atr; return r && r.level; };
    out.lv = { half: lvAt(0.5), onehalf: lvAt(1.5), five: lvAt(5), exact1: lvAt(1), exact2: lvAt(2) };
    // ⑤ 觸發價:設定線 = 87.68(tick 0.1 → 捨去 87.6、四捨五入 87.7)
    setInv([]);
    const _ep = app._exitPrimary.bind(app);
    app._exitPrimary = () => ({ k: 'don', v: 87.68, name: '唐奇安 20 日低點' });
    out.edTick = app._exitDistance(rows, sym);
    app._exitPrimary = _ep;
    // ⑥ 沒庫存 → 硬停損、抱滿都要寫原因
    out.edNoInv = app._exitDistance(rows, sym);
    // ⑦ 抱滿:買在第 20 根 → 已抱 39 根
    setInv([{ symbol: sym, cost: 90, shares: 1, buyDate: rows[20].date.replace(/\//g, '-') }]);
    out.edDue = app._exitDistance(rows, sym);
    // ⑦b 已跌破:最後一根收在 80
    const brk = rows.map(r => ({ ...r })); brk[59] = { ...brk[59], close: 80, low: 79, open: 80, high: 81 };
    setInv([{ symbol: sym, cost: 100, shares: 1, buyDate }]);
    out.edBroken = app._exitDistance(brk, sym);

    // ⑧ 決策台:造一檔「今天可能碰到」
    const nearRows = rows.map(r => ({ ...r }));
    setInv([{ symbol: sym, cost: 100, shares: 3, buyDate }]);
    app.idb = { get: async () => ({ data: nearRows }), put: async () => true };
    app._invExitAt = 0;
    app._atrTR14 = () => (gap != null ? gap / 0.6 : 1);   // 距離 0.6 倍 → 🚨 今天可能碰到
    await app._invExitScan();
    out.near = (app._invExitNear || []).map(x => ({ sym: x.sym, level: x.ed.level }));
    out.flags = (app._invExitFlags || []).length;
    // 直接餵 st 渲染(⛔ 不打網路)
    const st = { sell: app._invExitFlags || [], skip: [], invN: 1, buy: [], pbNull: true, hqN: 0, total: 0, bearN: 0, fit: null, finOn: false, finBlocked: [], finUnknown: [] };
    app._deckState = async () => st;
    app._deckBusy = false;
    try { await app.renderDeck(); } catch (e) { out.deckErr = String(e && e.message || e); }
    const sellEl = document.getElementById('deckSell'), idleEl = document.getElementById('deckIdle');
    out.sellHtml = sellEl ? sellEl.innerHTML : null;
    out.sellTxt = sellEl ? sellEl.innerText : '';
    out.idleTxt = idleEl ? idleEl.innerText : '';
    // 📋 複製內容
    let copied = null; const _ct = app._copyText; app._copyText = t => { copied = t; return true; };
    app._exitDistCopy(sym); app._copyText = _ct; out.copied = copied;
    // ⑧b 全部都遠 → 「沒有」+ 最近那檔差幾倍
    app._atrTR14 = () => (gap != null ? gap / 6 : 1);
    app._invExitAt = 0; await app._invExitScan();
    st.sell = app._invExitFlags || [];
    app._deckBusy = false; await app.renderDeck();
    out.farTxt = sellEl ? sellEl.innerText : '';
    out.farIdle = idleEl ? idleEl.innerText : '';
    app._atrTR14 = _atr;
    // ⑩ 價格位置圖:硬停損與出場線兩條都畫
    app._keyLevels = { sym: '0000', C: 571, exitMode: false, buyPx: 548.6, buyLb: 'x', addPx: 605, slPx: 533, slLb: '硬停損(成本−5% / 發動K低)', exitRulePx: 511, exitRuleLb: '你設定的出場線(唐奇安 20 日低點)', pocLo: 0, pocHi: 0, bull: true, stuck: [] };
    app._bearGate = () => false;
    out.ruler = app._priceRulerHtml ? app._priceRulerHtml() : '';
    return out;
});
await browser.close();

const E = R.ed;
ok('①0 空過守門:算得出來', !!E && Array.isArray(E.lines) && E.lines.length >= 2, JSON.stringify(E).slice(0, 200));
const hard = E && E.lines.find(l => l.k === 'hard'), rule = E && E.lines.find(l => l.k === 'rule');
ok('① 硬停損 = `_unifiedExitPlan().stopFinal`(同一個數字)', hard && Math.abs(hard.v - R.hardRef) < 0.005, `${hard && hard.v} vs ${R.hardRef}`);
ok('①b 你設定的線 = `_exitPrimary().v`', rule && Math.abs(rule.v - R.ruleRef) < 0.005, `${rule && rule.v} vs ${R.ruleRef}`);
ok('①c 兩條都在(⛔ 不可只剩一條 —— 決策台以前只看設定線)', !!hard && !!rule, '');
ok('②  nearest = 現價下方最近的那條', E && E.nearest && E.nearest.v === Math.max(...E.lines.filter(l => l.v <= E.pC).map(l => l.v)), JSON.stringify(E && E.nearest));
ok('③  今天的振幅 = `_atrTR14(data, 今天)`', E && Math.abs(E.atrToday - R.atrRef) < 0.01, `${E && E.atrToday} vs ${R.atrRef}`);
ok('③b 把 `_exitLines.atr`(進場日)改成 999 ⛔ 不可影響', R.edAtr999 && R.edAtr999.atrToday === E.atrToday && R.edAtr999.dist === E.dist, `${R.edAtr999 && R.edAtr999.atrToday}`);
ok('④  0.5 倍 → today、1.5 倍 → watch、5 倍 → far', R.lv.half === 'today' && R.lv.onehalf === 'watch' && R.lv.five === 'far', JSON.stringify(R.lv));
ok('④b 邊界:剛好 1 倍 → today、剛好 2 倍 → watch', R.lv.exact1 === 'today' && R.lv.exact2 === 'watch', JSON.stringify(R.lv));
ok('⑤  觸發價 87.68 → 87.60(無條件捨去,⛔ 不是 87.70)', R.edTick && R.edTick.smart && R.edTick.smart.trigger === 87.6, JSON.stringify(R.edTick && R.edTick.smart));
const miss = R.edNoInv && R.edNoInv.missing || [];
ok('⑥  沒庫存:硬停損寫原因(⛔ 不靜默、不用代理值)', miss.some(m => m.k === 'hard' && /成本/.test(m.why)) && !R.edNoInv.lines.some(l => l.k === 'hard'), JSON.stringify(miss));
ok('⑥b 沒買進日:抱滿那條寫原因', miss.some(m => m.k === 'maxd' && /買進日/.test(m.why)), JSON.stringify(miss));
ok('⑦  抱滿 20 個交易日 → level=due', R.edDue && R.edDue.level === 'due' && R.edDue.maxd && R.edDue.maxd.due, JSON.stringify(R.edDue && R.edDue.maxd));
ok('⑦b 收盤跌破 → level=broken', R.edBroken && R.edBroken.level === 'broken' && R.edBroken.broken.length > 0, R.edBroken && R.edBroken.level);
ok('⑧0 決策台掃描:那一檔進了「今天要盯的」', R.near.length === 1 && R.near[0].level === 'today' && R.flags === 0, JSON.stringify(R.near));
ok('⑧  決策台:列出「今天要盯的」+ 🚨 今天可能碰到', /今天要盯的/.test(R.sellTxt) && /今天可能碰到/.test(R.sellTxt), R.sellTxt.slice(0, 200));
ok('⑧b ⛔ 有要盯的就不可寫「今天要賣的:沒有」', !/今天要賣的:\s*沒有/.test(R.sellTxt) && !/data-exitnone/.test(R.sellHtml || ''), R.sellTxt.slice(0, 200));
ok('⑧c ⛔ 也不可同時說「今天不用做」', !/今天不用做/.test(R.idleTxt), R.idleTxt.slice(0, 120));
ok('⑧d 每一列有智慧單觸發價 + 📋 複製 + 🔔 到價提醒', /智慧單觸發價/.test(R.sellTxt) && /📋 複製/.test(R.sellTxt) && /到價提醒/.test(R.sellTxt), '');
ok('⑧e 複製內容:觸發價 + 市價賣出 + 張數', R.copied && /觸發價 \d+\.\d\d/.test(R.copied) && /市價賣出/.test(R.copied) && /3 張/.test(R.copied), R.copied);
ok('⑧f 全部都遠 → 「沒有」+ 講最近那檔差幾倍', /今天要賣的:\s*沒有/.test(R.farTxt) && /倍今天的振幅/.test(R.farTxt), R.farTxt.slice(0, 240));
ok('⑩  價格位置圖:硬停損與你設定的出場線兩條都畫、名字不同', /硬停損/.test(R.ruler) && /出場線/.test(R.ruler) && /511/.test(R.ruler) && /533/.test(R.ruler), R.ruler.replace(/<[^>]+>/g, ' ').slice(0, 300));
ok('⑪  決策台渲染沒丟例外', !R.deckErr, R.deckErr);
ok('⑫  載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ EXITDIST_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
