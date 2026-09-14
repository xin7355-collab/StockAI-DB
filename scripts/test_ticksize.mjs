// 📏 V76.2.9 停損價「掛得出去」守門 —— 台股跳動單位
//
// 🚨 為什麼要這支:使用者截圖裡出場價印成 `222.77499999999998`(= 234.5 × 0.95 的浮點殘值)。
//    查下去發現**不只是顯示難看** —— 實測 `playbook_edge.json` 300 檔裡
//    **257 檔(85.7%)的停損價對不到台股跳動單位**,那種價格**掛不出去**,
//    而 `auto_trade.py` 正是拿這個值去掛**真的**停損單。
//    ⭐ 同一份檔案的**觸發價** 300/300 全部對得到 → 只有停損那一條漏掉 = 陷阱 #37。
//
// 釘住四件事:
//  ① 三個檔的 `tickOf` 階梯**一字不差**(index.html / pro.html / playbook_scan.mjs 沒辦法互相 import)
//  ② 停損價一律落在跳動單位上(走 index.html 與 pro.html 的**真函式**,⛔ 不複製邏輯)
//  ③ 方向是**無條件捨去**,⛔ 不是四捨五入 —— round 會把停損價修到比 −5% 還高 = 提早把人洗出去
//  ④ **觸發價仍然是無條件進位**(⛔ 不可被「順手統一」成捨去 —— 那會叫人在條件沒成立時就買)
//
// 跑法:node scripts/test_ticksize.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL = [];
const ck = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) FAIL.push(m); };
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── ① 三份階梯要一字不差 ───────────────────────────────────────────
console.log('── ① `tickOf` 階梯三個檔要一致(⛔ 不能互相 import,只能靠這條擋)──');
const LADDER = /v\s*<\s*10\s*\?\s*0\.01\s*:\s*v\s*<\s*50\s*\?\s*0\.05\s*:\s*v\s*<\s*100\s*\?\s*0\.1\s*:\s*v\s*<\s*500\s*\?\s*0\.5\s*:\s*v\s*<\s*1000\s*\?\s*1\s*:\s*5/;
for (const f of ['index.html', 'pro.html', 'scripts/playbook_scan.mjs']) {
    const src = rd(f);
    ck(/tickOf/.test(src), `①a ${f} 有 tickOf`);
    ck(LADDER.test(src), `①b ${f} 的階梯 = 0.01/0.05/0.1/0.5/1/5(⛔ 改一邊就會被擋)`);
}

// ── ④ 觸發價的方向(原始碼釘住)────────────────────────────────────
console.log('\n── ④ 觸發價仍然是無條件**進位**(⛔ 不可順手統一成捨去)──');
const pbs = rd('scripts/playbook_scan.mjs');
ck(/let up = Math\.ceil\(\(b2 - 1e-9\) \/ tickOf\(b2\)\) \* tickOf\(b2\)/.test(pbs),
   '④a 觸發價 = Math.ceil —— ⛔ 捨去會叫人在條件還沒成立時就買');
ck(/stop: floorTick\(base \* 0\.95\)/.test(pbs),
   '④b ⭐ 停損價 = floorTick(⛔ 舊寫法 `+(base * 0.95).toFixed(2)` 讓 85.7% 的停損價掛不出去)');
ck(/const floorTick = /.test(pbs) && !/const tickOf = v =>[\s\S]{0,200}const tickOf = v =>/.test(pbs),
   '④c floorTick 抽成模組層共用,⛔ 檔內不留第二份階梯');

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });

// ── ② index.html:走真的 `_floorTick` ───────────────────────────────
console.log('\n── ② index.html `_floorTick`(走真函式,⛔ 不複製邏輯)──');
{
    const pg = await browser.newPage();
    await pg.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load' });
    await pg.waitForTimeout(3500);
    const R = await pg.evaluate(() => {
        const A = app;
        const cases = [
            [222.775, 0.5, 222.5], [740.05, 1, 740], [154.38, 0.5, 154],
            [5177.5, 5, 5175], [96.42, 0.1, 96.4], [41.28, 0.05, 41.25], [9.876, 0.01, 9.87],
        ];
        return {
            has: typeof A._floorTick === 'function',
            got: cases.map(([p, t, want]) => ({ p, t, want, got: A._floorTick(p) })),
            // ⭐ 決定性對照:同一個值用 _roundTick 會**往上**跑 → 證明兩支不可互換
            roundUp: A._roundTick(222.775) > A._floorTick(222.775),
            src: A._floorTick.toString(),
        };
    });
    await pg.close();
    ck(R.has, '②a `app._floorTick` 存在');
    for (const c of R.got) ck(Math.abs(c.got - c.want) < 1e-9, `②b ${c.p} → ${c.want}(跳動 ${c.t};實得 ${c.got})`);
    ck(R.roundUp, '②c ⭐ `_roundTick(222.775)` 會比 `_floorTick` **高** —— 這就是停損價不可用四捨五入的理由');
    ck(/Math\.floor/.test(R.src) && !/Math\.round/.test(R.src), '②d `_floorTick` 裡只能有 Math.floor');
}

// ── ③ pro.html:走真的 `_settleReplay`(停損價要落在跳動單位上)──────
console.log('\n── ③ pro.html 結算(走真的 `_settleReplay`,⛔ 不複製邏輯)──');
{
    const pg = await browser.newPage();
    await pg.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(1500);
    const R = await pg.evaluate(() => {
        const P = PRO;
        // 合成 K:進場日收 234.5(= 使用者截圖那筆南亞),之後一路跌 → 一定會觸發停損
        const rows = [];
        let c = 240;
        for (let i = 0; i < 30; i++) { rows.push({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, close: c, high: c * 1.01, low: c * 0.99 }); c -= 0.5; }
        rows[10].close = 234.5; rows[10].low = 233; rows[10].high = 236;
        for (let i = 11; i < 30; i++) { rows[i].close = 234.5 - (i - 10) * 3; rows[i].low = rows[i].close * 0.99; rows[i].high = rows[i].close * 1.01; }
        const r = P._settleReplay(rows, 10, 'don');
        const tick = v => v < 10 ? 0.01 : v < 50 ? 0.05 : v < 100 ? 0.1 : v < 500 ? 0.5 : v < 1000 ? 1 : 5;
        return {
            has: typeof P._floorTick === 'function' && typeof P._tickOf === 'function',
            stop: r && r.stop, why: r && r.why, exitP: r && r.exitP,
            onTick: r ? Math.abs(r.stop / tick(r.stop) - Math.round(r.stop / tick(r.stop))) < 1e-6 : false,
            raw: 234.5 * 0.95,
            src: P._floorTick.toString(),
        };
    });
    await pg.close();
    ck(R.has, '③a pro.html 有 `_tickOf` / `_floorTick`');
    ck(R.onTick, `③b ⭐ _settleReplay 算出來的停損價落在跳動單位上(實得 ${R.stop})`);
    ck(String(R.stop).length <= 6, `③c ⛔ 不可再出現 222.77499999999998 這種浮點殘值(實得 ${R.stop})`);
    ck(R.stop < R.raw + 1e-9, `③d 方向是**捨去**:${R.raw.toFixed(3)} → ${R.stop}(⛔ 不可比原值高)`);
    ck(/Math\.floor/.test(R.src) && !/Math\.round/.test(R.src), '③e pro.html 的 `_floorTick` 裡只能有 Math.floor');
}

await browser.close();
console.log();
if (FAIL.length) { console.log(`❌ ${FAIL.length} 條失敗:` + FAIL.join(' ・ ')); process.exit(1); }
console.log('✅ TICKSIZE_PASS(全部通過)');
