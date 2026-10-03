#!/usr/bin/env node
/**
 * 📰 V78.4.0 盤後晚報 / 本週回顧 + 👀 決策台「差一點沒入選」守門(參考 signova)
 *   ① 晚報每一段**只轉述既有**:改來源數字畫面跟著變(決定性對照)—— breadth.idx / 法人 / 板塊名次(`_regimeStats`)/ ETF chg_hist / 持股
 *   ② ⛔ 研究文字(實測 / 回測 / 勝率 / 0050 …)⛔ 🔴🟢 ⛔ 買賣指令
 *   ③ 週報:加權 = 近 5 天 idx 複利、⛔ 不做法人週合計、決策台名單走 `_deckBuyOf`
 *   ④ 👑 選領頭羊時決策台那段⛔ 不印 🧬 名單
 *   ⑤ 差一點沒入選:三種卡關原因、門檻讀 `_geneRank()`(決定性對照:改成 75 → 位階 80 那檔不再「差一點」而是入選)
 *   ⑥ 390px 不橫捲
 * 注入(逐一確認會紅):INJECT=fixed(晚報寫死加權漲跌)/ INJECT=hard85(差一點門檻寫死 85)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const INJ = process.env.INJECT || '';
if (INJ === 'fixed') SRC = SRC.replace('`<div>加權 ${this._evePct(B.idx)} ・ 上漲', '`<div>加權 ${this._evePct(0.5)} ・ 上漲');
if (INJ === 'hard85') SRC = SRC.replace('const G = this._GENE_RULE, R = this._geneRank(), N = this._DECK_TRACK49.picks;', 'const G = this._GENE_RULE, R = 85, N = this._DECK_TRACK49.picks;');
if (INJ && SRC === fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_evening.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._eveHtml === 'function', null, { timeout: 60000 });

const R = await page.evaluate(async () => {
    const out = {};
    const txt = h => { const d = document.createElement('div'); d.innerHTML = h; return d.innerText || d.textContent; };
    // ── 合成資料 ──
    const cols = ['c', 'chg', 'chg5', 'chg20', 'amt'];
    app._scrC = Object.fromEntries(cols.map((c, i) => [c, i]));
    const rows = {}, ind = {};
    for (let i = 0; i < 330; i++) {
        const s = String(1000 + i), k = '產業' + (i % 11);
        // 產業0 今天最強、產業10 最弱;5 日相反
        rows[s] = [100, (i % 11) === 0 ? 5 : (i % 11) === 10 ? -5 : 0.1 * (i % 11), (i % 11) === 0 ? -4 : (i % 11) === 10 ? 6 : 0, 0, 1];
        ind[s] = k;
    }
    app._scrData = { cols, rows, ind, data_date: '2026-10-02' };
    app._regCache = null;
    app._breadthHist = [
        { d: '2026/09/28', idx: 1.0, up: 1500, dn: 500, flat: 100, lu: 50, ld: 2, amt: 10000 },
        { d: '2026/09/29', idx: -2.0, up: 400, dn: 1600, flat: 100, lu: 5, ld: 20, amt: 10000 },
        { d: '2026/09/30', idx: 0.5, up: 1200, dn: 800, flat: 100, lu: 30, ld: 3, amt: 10000 },
        { d: '2026/10/01', idx: 0.86, up: 796, dn: 1008, flat: 234, lu: 49, ld: 7, amt: 10201.8 },
        { d: '2026/10/02', idx: -1.23, up: 700, dn: 1300, flat: 100, lu: 10, ld: 9, amt: 9800 },
    ];
    app._macroRiskCache = { fi_spot_net: 26.22, fi_trust_net: 57.69, fi_dealer_net: 20.26, fi_total_net: 104.17, updated: '2026-10-03 01:00 +0800' };
    app._etfCache = { etfs: [{ symbol: '00981A', chg_hist: [{ d: '2026-10-02', a: ['2330'], r: ['2317'], u: [], w: [] }] }] };
    app.inventory = [{ symbol: '1000', cost: 90, shares: 2 }];
    app._pbEdge = { data_date: '2026-10-02', mkt: { bear60: false }, picks: [
        { s: '2001', rank: 95, vol: 80, bear: 0, k: 'a', lb: 9 }, { s: '2002', rank: 90, vol: 70, bear: 0, k: 'a', lb: 8 },
        { s: '2003', rank: 88, vol: 65, bear: 0, k: 'a', lb: 7 },    // 🧬 但第 3 名
        { s: '2004', rank: 80, vol: 70, bear: 0, k: 'a', lb: 6 },    // 位階差一點(要 ≥85)
        { s: '2005', rank: 90, vol: 55, bear: 0, k: 'a', lb: 5 },    // 波動差一點(要 ≥60)
        { s: '2006', rank: 95, vol: 90, bear: 1, k: 'a', lb: 4 },    // 🧬 但空頭
        { s: '2007', rank: 40, vol: 20, bear: 0, k: 'a', lb: 3 },    // 差很多 → ⛔ 不列
        { s: '2008', rank: 72, vol: 70, bear: 0, k: 'a', lb: 2 },    // 門檻 85 時差 13(⛔ 不列);門檻 75 時差 3(差一點)
    ] };
    try { app.settings.strategy = 'gene'; app.settings.geneRank = 85; } catch (_) {}
    const day = app._eveHtml();
    out.day = txt(day); out.dayHtml = day;
    // ① 決定性對照:改 breadth 最後一天的 idx → 晚報跟著變
    app._breadthHist[4].idx = 3.33;
    out.day2 = txt(app._eveHtml());
    app._breadthHist[4].idx = -1.23;
    // 法人
    app._macroRiskCache.fi_trust_net = -12.3;
    out.day3 = txt(app._eveHtml());
    app._macroRiskCache.fi_trust_net = 57.69;
    // ③ 週報
    app._eveHist = { days: [{ d: '2026-10-01', pb: app._pbEdge.picks, lead: { rows: [{ s: '9999', b: 1 }] } }] };
    const wk = app._weekHtml();
    out.week = txt(wk); out.weekHtml = wk;
    // ④ 👑
    try { app.settings.strategy = 'lead'; app.settings.stratUnlock = true; } catch (_) {}
    out.leadDay = txt(app._eveHtml()); out.leadWeek = txt(app._weekHtml());
    try { app.settings.strategy = 'gene'; } catch (_) {}
    // ⑤ 差一點
    out.near = app._deckNearOf(app._pbEdge).map(o => [String(o.x.s), o.kind, o.why]);
    app.settings.geneRank = 75;
    out.near75 = app._deckNearOf(app._pbEdge).map(o => [String(o.x.s), o.kind, o.why]);
    out.buy75 = app._deckBuyOf(app._pbEdge).buy.map(x => String(x.s));
    app.settings.geneRank = 85;
    out.nearHtml = txt(app._deckNearHtml(app._deckNearOf(app._pbEdge)));
    // ⑥ 版面:真的進子頁籤
    app.switchAppTab('market'); app.switchMarketSubTab('eve');
    await new Promise(r => setTimeout(r, 600));
    out.box = (document.getElementById('eveBox') || {}).innerText || '';
    window.scrollTo(80, 0); out.scrollX = window.scrollX;
    return out;
});

const FORBID = /實測|回測|勝率|期望值|對照組|六關|0050|樣本外|探針|pp\b|贏大盤/;
ok('① 晚報有大盤 / 法人 / 板塊 / ETF / 持股 / 決策台六段', ['🏛️ 大盤', '🏦 三大法人', '💧 今天哪幾族', '🧩 主動式 ETF', '👜 你的持股', '🎯 決策台'].every(s => R.day.includes(s)), R.day.slice(0, 300));
ok('①a 加權漲跌讀 breadth 最後一天(決定性對照:改 idx → 畫面跟著變)', R.day.includes('-1.23%') && R.day2.includes('+3.33%') && !R.day2.includes('-1.23%'), R.day2.slice(0, 120));
ok('①b 漲跌家數 / 漲跌停讀 breadth', /上漲 700 家/.test(R.day) && /下跌 1,300 家/.test(R.day) && /漲停 10/.test(R.day));
ok('①c 法人讀 macro_risk(決定性對照:改投信 → 跟著變)', R.day.includes('+57.7 億') && R.day3.includes('-12.3 億'));
ok('①d 板塊名次讀 _regimeStats(1):最強 = 產業0、最弱 = 產業10', /最強:產業0/.test(R.day) && /最弱:產業10/.test(R.day), R.day.match(/最強[^\n]*/)?.[0]);
ok('①e ETF 讀 chg_hist(新增 / 出清)', /00981A/.test(R.day) && /新增/.test(R.day) && /出清/.test(R.day));
ok('①f 持股:報價沒到 → 用 screener 收盤 × 今日漲跌', /合計/.test(R.day) && R.dayHtml.includes('data-evehold="1000"'));
ok('①g 決策台:轉述 _deckBuyOf 的前 2 名', /2001/.test(R.day) || /明天可以留意/.test(R.day), R.day.match(/🎯 決策台[^]*?$/)?.[0]?.slice(0, 160));
ok('② ⛔ 研究文字(晚報 + 週報 + 差一點)', !FORBID.test(R.day) && !FORBID.test(R.week) && !FORBID.test(R.nearHtml), (R.day + R.week + R.nearHtml).match(FORBID)?.[0]);
ok('②b ⛔ 🔴🟢', !/[🔴🟢]/u.test(R.day + R.week + R.nearHtml));
ok('②c ⛔ 買賣指令(買進 / 賣出 / 加碼 / 減碼)', !/買進|賣出|加碼|減碼|出清持股/.test(R.day.replace(/出清 \S+/g, '') + R.week.replace(/出清 \S+/g, '')));
const comp = ((1.01 * 0.98 * 1.005 * 1.0086 * 0.9877) - 1) * 100;
ok('③ 週報加權 = 近 5 天 idx 複利', R.week.includes((comp > 0 ? '+' : '') + comp.toFixed(2) + '%'), comp.toFixed(2));
ok('③b ⛔ 不做法人週合計(沒有三大法人段,說明有寫原因)', !/🏦/.test(R.week) && /不做週合計/.test(R.week));
ok('③c 板塊用 5 日:最強 = 產業10、最弱 = 產業0', /最強:產業10/.test(R.week) && /最弱:產業0/.test(R.week));
ok('③d 這週決策台名單走 _deckBuyOf(🧬 前 2 名)', R.weekHtml.includes('data-evewdeck="2001"') && R.weekHtml.includes('data-evewdeck="2002"') && !R.weekHtml.includes('data-evewdeck="2003"'));
ok('④ 👑 時決策台那段不印 🧬 名單、週報用領頭羊 b=1', !/2001/.test(R.leadDay.slice(R.leadDay.indexOf('🎯'))) && /領頭羊/.test(R.leadDay) && /9999/.test(R.leadWeek) && !/2001/.test(R.leadWeek.slice(R.leadWeek.indexOf('🎯'))));
const kinds = Object.fromEntries(R.near.map(x => [x[0], x[1]]));
ok('⑤ 差一點:第 3 名 / 位階 / 波動 / 空頭 四種都列、差很多的⛔ 不列', kinds['2003'] === 'rank' && kinds['2004'] === 'pos' && kinds['2005'] === 'vol' && kinds['2006'] === 'bear' && !kinds['2007'], JSON.stringify(R.near));
ok('⑤b 卡關原因寫出門檻(位階 80% 要 ≥85%)', R.near.some(x => x[0] === '2004' && x[2].includes('80%') && x[2].includes('≥85%')), JSON.stringify(R.near));
ok('⑤c 決定性對照:門檻改 75 → 2004 不再「差一點」(變成 🧬)、2008 變成「要 ≥75%」', !R.near75.some(x => x[0] === '2004' && x[1] === 'pos') && R.buy75.length === 2 && R.near75.some(x => x[0] === '2008' && x[2].includes('≥75%')) && !R.near.some(x => x[0] === '2008'), JSON.stringify(R.near75));
ok('⑤d 差一點標「⛔ 今天不買」', /今天不買/.test(R.nearHtml));
ok('⑥ 子頁籤真的畫出來 + 390px 不橫捲', /今天收盤/.test(R.box) && R.scrollX <= 2, `scrollX=${R.scrollX} box=${R.box.slice(0, 80)}`);
ok('⑥b 無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
try { fs.unlinkSync(TMP); } catch (_) {}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
