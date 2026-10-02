#!/usr/bin/env node
/**
 * 🏆 V78.1.9 策略 / 出場規則「照實測強弱排」+ 👑 停車 0050 選項 + 個股總覽讀決策台名單
 *   使用者:「領頭羊+停車0050 跟 🅿️ 哪個強,記在實測總表(⛔ 不開新卡片,用比較的)、設定裡新增策略、用排序強的優先;
 *            出場規則也要排序強的優先;個股總覽要依照我的策略告訴我怎麼做」
 * 釘住:
 *   ① index `_STRAT_RANK` == pro `_PROFIT_BOARD`(lead→leadpark、leadcash→lead、park、hot→gene、0050)—— ⛔ 兩份數字不可漂移
 *   ② 設定裡的策略順序 == 照看板 16 年 → 近 4 年排(獨立重算,⛔ 不抄 `_stratOrder`)
 *   ③ 出場規則順序 == 照 `_EXIT_EDGE.rob.long` → `rob.rows` 排;靜態按鈕順序也一樣(⛔ 第一次畫面就是排好的)
 *   ④ leadpark:`_strat()` = lead、`_park()` = true;lead:`_park()` = false;舊的 'lead' 搬家一次成 leadpark
 *   ⑤ 個股總覽:這一檔在決策台「今天可以買的」名單上(沒有固定觸發價那種)→ ⛔ 不可寫「觀望」;🅿️ 時講「先從 0050 賣出」
 *   ⑥ 決定性對照:同一檔把決策台名單換掉 → 總覽回到「觀望」
 */
import fs from 'fs';
import path from 'path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = process.env.INDEX_HTML || path.join(ROOT, 'index.html');
const SRC = fs.readFileSync(HTML, 'utf8'), PS = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + String(e).slice(0, 260) : ''}`); } };

// ── 看板(pro.html)──
const bl = PS.match(/^  _PROFIT_BOARD: (\{.*\}),$/m);
ok('🚧 讀得到 pro 的 _PROFIT_BOARD', !!bl);
const B = JSON.parse(bl[1]);
const g = (w, k) => B.wins[w].rows.find(r => r.k === k);
const MAP = { leadpark: 'lead', lead: 'leadcash', park: 'park', gene: 'hot' };

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto('file://' + HTML);
await page.waitForFunction(() => typeof app !== 'undefined' && app._ovDecide && app._deckRankOf, null, { timeout: 30000 });
const R = await page.evaluate(async () => {
    const A = app, o = {};
    o.rank = JSON.parse(JSON.stringify(A._STRAT_RANK));
    A.settings.stratUnlock = true;
    A.settings.strategy = 'gene'; A._renderStratBox();
    o.box = [...document.querySelectorAll('#stratBox [data-stratopt]')].map(x => x.dataset.stratopt);
    o.exitOrd = A._exitOrder();
    o.exitRob = JSON.parse(JSON.stringify(A._EXIT_EDGE.rob));
    o.exitBtns = [...document.querySelectorAll('[id^="btn_exit_"]')].map(b => b.id.replace('btn_exit_', ''));
    A._applyExitRuleUI();
    o.exitBtnsAfter = [...document.querySelectorAll('[id^="btn_exit_"]')].map(b => b.id.replace('btn_exit_', ''));
    A.settings.strategy = 'leadpark'; o.lp = [A._strat(), A._park(), A._stratKey()];
    A.settings.strategy = 'lead'; o.l = [A._strat(), A._park(), A._stratKey()];
    A.settings.strategy = 'park'; o.p = [A._strat(), A._park(), A._stratKey()];
    // ⑤ 個股總覽讀決策台名單(沒有固定觸發價那種 = 使用者截圖 3441)
    const rows = []; for (let i = 0; i < 300; i++) { const c = +(100 + i * 0.35).toFixed(2); rows.push({ date: new Date(Date.UTC(2025, 6, 1) + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '/'), open: c - 0.3, high: c + 0.8, low: c - 0.9, close: c, volume: 5000 }); }
    A._getInventory = () => []; A.inventory = []; A.favGroups = {};
    A.currentSymbolId = '3441'; A.activeData = rows; A.rawDailyData = rows;
    const pk = s => ({ s, c: 202.5, d: '2026-10-01', k: '🕯️ 站上長黑K壓力', w: 76.9, po: 4.6, exp: 4.6, lb: 3, n: 13, trig: null, loose: 1, rank: 100, vol: 90, hq: 1, bear: 0, up: 3, stop: 192 });
    A._pbEdge = { data_date: '2026-10-01', picks: [pk('3441'), pk('4556')], mkt: { bear60: false } };
    A.settings.strategy = 'park';
    let d = A._ovDecide(rows, '3441');
    o.ov = { badge: d && d.badge, why: d && d.why, rank: (A._deckRankOf('3441') || {}).rank };
    A.settings.strategy = 'gene';
    d = A._ovDecide(rows, '3441'); o.ovGene = { why: d && d.why };
    // ⑥ 決定性對照:名單換掉 → 回到觀望
    A._pbEdge = { data_date: '2026-10-01', picks: [pk('4556')], mkt: { bear60: false } };
    d = A._ovDecide(rows, '3441'); o.ovOff = { badge: d && d.badge };
    // 空頭守門:在名單上但大盤嚴格空頭 → ⛔ 不叫你買
    A._pbEdge = { data_date: '2026-10-01', picks: [pk('3441')], mkt: { bear60: true } };
    d = A._ovDecide(rows, '3441'); o.ovBear = { badge: d && d.badge, why: d && d.why };
    return o;
});
await browser.close();

// ① 兩份數字一致
const bad = [];
for (const [k, bk] of Object.entries(MAP)) {
    const r = R.rank.rows[k], a = g('ai', bk), l = g('long', bk);
    if (!r || !a || !l) { bad.push(k + ' 缺'); continue; }
    if (r.a !== Math.round(a.fin / 1e4) || r.l !== Math.round(l.fin / 1e4)) bad.push(`${k} ${r.a}/${r.l} vs 看板 ${Math.round(a.fin / 1e4)}/${Math.round(l.fin / 1e4)}`);
    if (Math.abs(r.mdd - a.mdd) > 0.06 || Math.abs(r.mddL - l.mdd) > 0.06) bad.push(`${k} 回撤 ${r.mdd}/${r.mddL} vs ${a.mdd}/${l.mdd}`);
}
if (R.rank.e50.a !== Math.round(g('ai', '0050').fin / 1e4) || R.rank.e50.l !== Math.round(g('long', '0050').fin / 1e4)) bad.push('0050');
ok('① 設定裡的策略數字 == 實測總表看板(同一組 17 個起點)', bad.length === 0, bad.join(' / '));
// ② 順序(獨立重算)
const want = Object.keys(MAP).sort((x, y) => (g('long', MAP[y]).fin - g('long', MAP[x]).fin) || (g('ai', MAP[y]).fin - g('ai', MAP[x]).fin));
ok('② 設定裡的策略照 16 年 → 近 4 年由強到弱排', JSON.stringify(R.box) === JSON.stringify(want), `${R.box} vs ${want}`);
// ③ 出場規則
const L = (R.exitRob.long || {}).rows || {}, v = k => [L[k] ? L[k].med : -1, R.exitRob.rows[k] ? R.exitRob.rows[k].med : -1];
const wantE = R.exitOrd.slice().sort((x, y) => (v(y)[0] - v(x)[0]) || (v(y)[1] - v(x)[1]));
ok('③ 出場規則照 16 年 → 近 4 年中位由強到弱', JSON.stringify(R.exitOrd) === JSON.stringify(wantE) && R.exitOrd[0] === 'atr2', `${R.exitOrd} vs ${wantE}`);
ok('③b 設定畫面的按鈕一打開就是這個順序(靜態 HTML)', JSON.stringify(R.exitBtns) === JSON.stringify(R.exitOrd) && JSON.stringify(R.exitBtnsAfter) === JSON.stringify(R.exitOrd), `${R.exitBtns} / ${R.exitBtnsAfter}`);
// ④
ok('④ leadpark = 👑 + 停車;lead = 👑 錢放現金;park = 🔥 + 停車', JSON.stringify(R.lp) === '["lead",true,"leadpark"]' && JSON.stringify(R.l) === '["lead",false,"lead"]' && JSON.stringify(R.p) === '["gene",true,"park"]', JSON.stringify([R.lp, R.l, R.p]));
ok('④b 舊的 lead 搬家一次成 leadpark(旗標,⛔ 之後自己選回現金不會被換回去)', /if \(!this\.settings\.stratMigr819\) \{\s*if \(this\.settings\.strategy === 'lead'\) this\.settings\.strategy = 'leadpark';\s*this\.settings\.stratMigr819 = 1;/.test(SRC), '');
ok('④c 👑 決策台會算「今天停多少錢在 0050」(選 leadpark 時)', /_leaderDeckHtml\(\) \{[\s\S]*?this\._parkAmountHtml\(\)/.test(SRC), '');
// ⑤⑥
ok('⑤ 決策台名單第 1 名(沒有固定觸發價)→ 總覽⛔ 不是觀望,寫「今天可以買(決策台第 1 名)」+ 尾盤 + 停損', R.ov.rank === 1 && /今天可以買\(決策台第 1 名\)/.test(R.ov.badge) && /13:00~13:28/.test(R.ov.why) && /還成立/.test(R.ov.why) && /停損/.test(R.ov.why), JSON.stringify(R.ov).slice(0, 300));
ok('⑤b 🅿️ 時講「先從 0050 賣出」;🔥 時⛔ 不講', /先從 0050 賣出/.test(R.ov.why) && !/0050/.test(R.ovGene.why || ''), (R.ovGene.why || '').slice(0, 200));
ok('⑥ 決定性對照:名單換掉 → 回到觀望', /觀望/.test(R.ovOff.badge || ''), R.ovOff.badge);
ok('⑥b 大盤嚴格空頭 → ⛔ 不叫你買', !/今天可以買/.test(R.ovBear.badge || '') && /不開新倉/.test(R.ovBear.badge || ''), JSON.stringify(R.ovBear).slice(0, 200));
ok('無 pageerror', errs.length === 0, errs.join(' | '));
console.log(fails ? `\n❌ STRATRANK_FAIL(${fails})` : '\n✅ STRATRANK_PASS(全部通過)');
process.exit(fails ? 1 : 0);
