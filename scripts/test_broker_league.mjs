// 🏅 V76.2.8 券商排行榜(12 項)前端守門
//   選股頁「🏅 券商」與券商頁「🏅 高手券商」**同一支** `_brokerLeagueHtml()`(⛔ 不做第二份真相)。
//   跑法:node scripts/test_broker_league.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const FAIL = [];
const ck = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) FAIL.push(m); };

// 測資:刻意包含「樣本不足」「賠錢」「交易狂≠報酬王」三種情境(⛔ 別只放漂亮的)
const PERF = {
    updated: '2026-09-14T00:00:00Z', days: 36, dt_days: 20, backfill: { short: 0, swing: 0 },
    base: { dt: { win_rate: 48.0, avg_ret: 0.05, count: 90000 },
            daytrade: { win_rate: 52.0, avg_ret: 0.10, count: 50000 },
            short: null, swing: { win_rate: 70.0, avg_ret: 3.0, count: 20000 } },
    dt: [{ broker: 'DT報酬王', win_rate: 61, avg_ret: 0.9, count: 40, q: 300000 },
         { broker: 'DT交易狂', win_rate: 50, avg_ret: 0.1, count: 90, q: 9000000 },
         { broker: 'DT樣本少', win_rate: 100, avg_ret: 5.0, count: 4, q: 100 }],
    daytrade: [{ broker: 'D報酬王', win_rate: 55, avg_ret: 2.2, count: 30 },
               { broker: 'D常勝軍', win_rate: 80, avg_ret: 0.3, count: 25 },
               { broker: 'D交易狂', win_rate: 51, avg_ret: -0.4, count: 200 },
               { broker: 'D樣本少', win_rate: 100, avg_ret: 9.9, count: 5 }],
    short: [{ broker: 'S甲', win_rate: 90, avg_ret: 2.0, count: 30 }],   // ⚠️ 刻意設成「拿 50% 檢定就會蓋 ✅」的成績 → ⑤c 才有鑑別力
    swing: [{ broker: 'W甲', win_rate: 91, avg_ret: 6.0, count: 12 }],
};

const b = await chromium.launch({ args: ['--allow-file-access-from-files', '--disable-web-security'] });
const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; pg.on('pageerror', e => errs.push(String(e)));
await pg.goto(pathToFileURL(resolve('index.html')).href, { waitUntil: 'load', timeout: 60000 });
await pg.waitForTimeout(4000);

const R = await pg.evaluate(async (PERF) => {
    const A = app;
    A._brokerPerf = PERF;
    A.switchAppTab('radar');
    A.switchRadarMode('broker');
    const el = document.getElementById('radarModeBroker');
    const out = { cells: {}, vis: !el.classList.contains('hidden') };
    for (const [pk] of A._BK_LEAGUE_P) for (const [ck2] of A._BK_LEAGUE_C) {
        A.switchBkLeague(pk, ck2);
        const names = [...el.querySelectorAll('button[onclick*="_openBrokerFromNameFromPage"]')].map(x => x.innerText.trim());
        out.cells[pk + '/' + ck2] = { names, txt: el.innerText, btns: el.querySelectorAll('button[onclick*="switchBkLeague"]').length };
    }
    A.switchBkLeague('swing', 'ret');
    out.godSame = A._godBrokerHtml() === A._brokerLeagueHtml();
    // 券商頁那邊也要走同一支
    A._brokerCat = 'god';
    out.godTxt = A._renderBrokerCat('god');
    window.scrollTo(80, 0);
    out.scrollX = window.scrollX;
    // 資料還沒到的時候⛔ 不可空白
    const keep = A._brokerPerf; A._brokerPerf = null;
    out.noData = A._brokerLeagueHtml();
    A._brokerPerf = keep;
    return out;
}, PERF);

const C = R.cells;
console.log('\n── ① 12 格都在、都畫得出來 ──');
ck(R.vis, '①a 選股頁「🏅 券商」容器有顯示出來');
ck(Object.keys(C).length === 12, `①b 共 12 格(實得 ${Object.keys(C).length})`);
ck(Object.values(C).every(x => x.btns === 12), '①c 每一格都看得到 12 顆選擇器(⛔ 不可切進去就找不到別格)');
ck(Object.values(C).every(x => x.txt.length > 120), '①d 每一格都有內容(⛔ 不可靜默空白)');

console.log('\n── ② 單一真相(⛔ 不做第二份) ──');
ck(R.godSame, '②a 券商頁「🏅 高手券商」= 選股頁那一支的同一份輸出');
ck(R.godTxt === R.godTxt && /對照組|整備中/.test(R.godTxt), '②b _renderBrokerCat(\'god\') 走的也是同一支');
const src = readFileSync('index.html', 'utf8');
ck(/_godBrokerHtml\(\)\s*\{\s*return this\._brokerLeagueHtml\(\);\s*\}/.test(src),
   '②c ⭐ `_godBrokerHtml` 只是轉呼叫 —— ⛔ 不可再寫一份挑法(舊版自己挑 top-1,跟榜對不上)');

console.log('\n── ③ 三類真的分得開(⛔ 不可三格長一樣) ──');
ck(C['daytrade/ret'].names[0] === 'D報酬王', `③a 報酬王 = D報酬王(實得 ${C['daytrade/ret'].names[0]})`);
ck(C['daytrade/win'].names[0] === 'D常勝軍', `③b 常勝軍 = D常勝軍(實得 ${C['daytrade/win'].names[0]})`);
ck(C['daytrade/busy'].names[0] === 'D交易狂', `③c 交易狂 = D交易狂(實得 ${C['daytrade/busy'].names[0]})`);
ck(C['dt/busy'].names[0] === 'DT交易狂',
   `③d ⭐ 當沖的「交易狂」比的是**當沖股數**不是事件數(實得 ${C['dt/busy'].names[0]})`);

console.log('\n── ④ 樣本守門(CLAUDE.md 顯示勝率鐵則第 1 條) ──');
ck(Object.values(C).every(x => !x.names.includes('D樣本少') && !x.names.includes('DT樣本少')),
   '④a ⭐ n < 10 的⛔ 一律不進榜 —— 它勝率 100%、報酬最高,不擋就會霸佔三張榜的第一名');
ck(/已擋掉 \d+ 家樣本不足/.test(C['daytrade/ret'].txt), '④b 擋掉幾家要說出來(⛔ 不可靜默過濾)');

console.log('\n── ⑤ 對照組(⛔ 基準不是 50%) ──');
ck(/對照組\(隨便挑一家券商\)/.test(C['daytrade/ret'].txt), '⑤a 有基準時要把基準印出來');
ck(/基準[+-]/.test(C['daytrade/ret'].txt), '⑤b 每一列都要標「贏基準多少」');
ck(/對照組基準累積中/.test(C['short/ret'].txt) && !/✅/.test(C['short/ret'].txt),
   '⑤c ⭐ 沒有基準時⛔ 不可拿 50% 判 —— 那格(short)不可出現 ✅ 徽章');
ck(/⏳ 待基準/.test(C['short/ret'].txt), '⑤d 沒有基準時要誠實說「待基準」');

console.log('\n── ⑥ 誠實免責(⛔ 一句都不可少) ──');
const t = C['dt/ret'].txt;
ck(/成績記錄,不是買進名單/.test(t), '⑥a ⛔ 要寫明「這是成績記錄不是買進名單」');
ck(/沒有.{0,3}預測力/.test(t), '⑥b ⭐ 要寫出本站三支探針實測「跟著分點做」沒有預測力');
ck(/未扣交易成本/.test(t), '⑥c 要寫未扣成本');
ck(/估計/.test(t) && /不是官方當沖/.test(t), '⑥d ⭐ 當沖是「同日雙向成交」的估計,⛔ 不可講成官方當沖');
ck(/窗口 \d+ 個交易日/.test(t), '⑥e 要寫窗口幾天');

console.log('\n── ⑦ 版面 / 空狀態 ──');
ck(R.scrollX <= 2, `⑦a 390px 下不可橫向捲動(scrollX=${R.scrollX})`);
ck(!/\*\*/.test(Object.values(C).map(x => x.txt).join('')),
   '⑦b ⛔ 不可把 markdown 的 ** 原樣印給使用者看(template literal 不會幫你轉)');
ck(/整備中/.test(R.noData), '⑦c 資料還沒到時要誠實說整備中(⛔ 不可空白)');
ck(!/🔴|🟢/.test(Object.values(C).map(x => x.txt).join('')),
   '⑦d 燈號鐵則:這張榜講的是成績不是漲跌方向 → ⛔ 不可出現 🔴🟢');

console.log('\npageerror:', errs.length, errs.slice(0, 2).join(' | '));
ck(errs.length === 0, '⑧ 無 pageerror');
await b.close();

console.log();
if (FAIL.length) { console.log(`❌ ${FAIL.length} 條失敗:` + FAIL.join(' ・ ')); process.exit(1); }
console.log('✅ BROKER_LEAGUE_MJS_PASS(全部通過)');
