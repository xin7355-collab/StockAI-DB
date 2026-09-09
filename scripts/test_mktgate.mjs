#!/usr/bin/env node
/**
 * 🌡️ V75.1.6 大盤守門 `_mktGate()` —— 個股卡的「進場/加碼」指令要跟頂端跑馬燈一致
 *
 * 🚨 為什麼有這支(`scripts/page_sweep.mjs` 掃出來的):
 *    同一畫面頂端跑馬燈寫「多頭(過熱)・**絕不追高**;嚴設停損、分批停利」,
 *    底下「打法適配儀」卻寫「→ **可依紀律進場**」、多空計分卡寫「**可順勢操作**」。
 *    ⛔ 這正是使用者講最多次的那句「邏輯不打架」。
 *
 * ⭐ 這不是新規則 —— V73.2.9 早就為「明日劇本」做過(大盤過熱時改講「別追高加碼」),
 *    但**只接了那一處**(陷阱 #37:共用工具寫好了卻只接了一處)。
 *
 * ⛔ 釘死的五件事:
 *   ① 只有「健康多頭(建議 8 成)」不守門;過熱/轉弱/盤整/空頭都要守
 *   ② ⛔ 全 App 只能有**一份**判斷式(明日劇本那份複製品已改走共用入口)
 *   ③ 三個呼叫點都要在(明日劇本 / 打法適配儀 / 多空計分卡)
 *   ④ 守門觸發時措辭要降級成「別追高 / 別重押」,而且要**講出大盤是什麼狀況**
 *      (⛔ 只寫「留意大盤」四個字太輕,使用者看不出跟跑馬燈是同一件事)
 *   ⑤ ⛔ 只改「叫人怎麼做」那句,不動任何數字(數字是事實)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails++; };

// ── 靜態 ──
ok('② ⛔ 判斷式全 App 只能有一份(⛔ 不可再出現複製品)',
   (SRC.match(/regime === 'bull' && \/\^8 成\//g) || []).length === 1,
   `找到 ${(SRC.match(/regime === 'bull' && \/\^8 成\//g) || []).length} 份`);
ok('③ 三個呼叫點都在(明日劇本 / 打法適配儀 / 多空計分卡)',
   (SRC.match(/_mktGate\?\.\(\)|this\._mktGate\(\)/g) || []).length >= 3,
   `${(SRC.match(/_mktGate\?\.\(\)|this\._mktGate\(\)/g) || []).length} 處`);
ok('③b 明日劇本已改走共用入口(⛔ 不留自己那份)',
   /_mktCap = this\._mktGate\(\)/.test(SRC), '');

// ── 動態 ──
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(() => {
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }),
        writable: true, configurable: true,
    });
});
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._mktGate, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const real = app._chuPositionAdvice;
    const stub = v => { app._chuPositionAdvice = () => v; };
    const o = {};
    // ① 各種大盤狀態下守不守門
    stub({ regime: 'bull', regimeLabel: '多頭', pct: '8 成', advice: 'x' });        o.healthy = app._mktGate();
    stub({ regime: 'bull', regimeLabel: '多頭(過熱)', pct: '3~5 成(只留強勢股)' }); o.hot = app._mktGate();
    stub({ regime: 'flat', regimeLabel: '盤整', pct: '5 成以下' });                  o.flat = app._mktGate();
    stub({ regime: 'bear', regimeLabel: '空頭', pct: '3 成以下 或 空手' });          o.bear = app._mktGate();
    app._chuPositionAdvice = () => { throw new Error('boom'); };                     o.throws = app._mktGate();
    app._chuPositionAdvice = real;
    return o;
});
ok('① 健康多頭(8 成)⛔ 不守門(別把正常情境弄壞)', R.healthy === null, JSON.stringify(R.healthy));
ok('① 大盤過熱 → 守門,而且帶得出 regimeLabel / pct',
   !!R.hot && /過熱/.test(R.hot.regimeLabel) && !!R.hot.pct, JSON.stringify(R.hot));
ok('① 盤整 / 空頭也要守門', !!R.flat && !!R.bear, JSON.stringify({ f: R.flat, b: R.bear }));
ok('① ⛔ 算不出來時回 null,不可 throw(守門壞掉不該把整張卡帶走)', R.throws === null, String(R.throws));

// ④ 兩張卡的措辭
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2330.json'), 'utf8'));
const W = await page.evaluate(async (r) => {
    const real = app._chuPositionAdvice, realBear = app._bearGate;
    app._bearGate = () => false;                       // 個股空頭守門另有測試,這裡要驗的是大盤那道
    const out = {};
    // ⭐ 先真的 analyze 一次 —— `_calcBullBearScan` 要吃籌碼/基本面快取,
    //   只塞 rawDailyData 會落到「局部優勢」那條(命中數不夠)= 驗不到要驗的分支。
    try { await app.analyze('2330'); await new Promise(r2 => setTimeout(r2, 2500)); } catch (_) {}
    const run = async (adv) => {
        app._chuPositionAdvice = () => adv;
        app.currentSymbolId = '2330';
        let bb = '';
        try { bb = (app._calcBullBearScan('2330') || {}).oneLiner || ''; } catch (e) { bb = 'THROW:' + e.message; }
        return { bb };
    };
    out.hot = await run({ regime: 'bull', regimeLabel: '多頭(過熱)', pct: '3~5 成(只留強勢股)' });
    out.ok = await run({ regime: 'bull', regimeLabel: '多頭', pct: '8 成' });
    app._chuPositionAdvice = real; app._bearGate = realBear;
    return out;
}, rows);
const strip = h => String(h).replace(/<[^>]+>/g, '');
// 🚧 空過守門:這檔今天要真的落在「多方優勢」那條,否則下面在驗一個沒走到的分支
const bbHot = strip(W.hot.bb), bbOk = strip(W.ok.bb);
ok('🚧 空過守門:多空計分卡真的給出「多方優勢」那句(⛔ 否則下面空過)',
   /同步攻擊|局部優勢/.test(bbHot), bbHot.slice(0, 200));
if (/同步攻擊/.test(bbHot)) {
    ok('④ ⭐ 大盤過熱時,多空計分卡要講出大盤狀況 + 「空手的別追高」',
       /過熱/.test(bbHot) && /別追高/.test(bbHot), bbHot.slice(0, 200));
    ok('④b ⭐ 大盤健康時維持原文案(⛔ 別把正常情境弄壞)',
       /可順勢操作/.test(bbOk) && !/別追高/.test(bbOk), bbOk.slice(0, 200));
} else {
    // ⚠️ 「四面向同步攻擊」要 4 個面向裡 3 個同向 **且** 命中 ≥8 條 —— 那取決於當天的籌碼/基本面
    //    有沒有到齊(實測今天 2330 只有 6 條)。⛔ 不可為了讓測試好過就放寬那個門檻。
    //    ⭐ 改用原始碼釘住措辭(跟 ④c 同做法),動態那半只保證「不炸、數字不變」。
    console.log('   ⏭️ 今天 2330 命中數不到 8 → 落在「局部優勢」分支,措辭改用原始碼驗');
}
ok('④ ⭐ 大盤過熱時,多空計分卡的那句要講出大盤狀況 +「空手的別追高」(原始碼)',
   /_mg \? `四面向同步攻擊,<b>但大盤\$\{_mg\.regimeLabel\}、建議總部位 \$\{_mg\.pct\}<\/b> → 有貨的續抱,<b>空手的別追高<\/b>`/.test(SRC),
   (SRC.match(/四面向同步攻擊[^\n]{0,160}/) || [''])[0]);
ok('④b ⭐ 大盤健康時維持原文案(⛔ 別把正常情境弄壞)',
   /: '四面向同步攻擊,可順勢操作\(留意大盤\)'/.test(SRC), '');
// ⑤ 數字不可被守門動到
ok('⑤ ⛔ 守門只改指令、不改數字(命中數兩種情境要一樣)',
   (bbHot.match(/命中 \d+/) || [''])[0] === (bbOk.match(/命中 \d+/) || [''])[0],
   `${(bbHot.match(/命中 \d+/) || [''])[0]} vs ${(bbOk.match(/命中 \d+/) || [''])[0]}`);
// ④c 打法適配儀那句(原始碼層級 —— 它要真實回測資料才渲染得出來)
// ⚠️ V75.1.9:⛔ 守門觸發時**不可留下完整的「可依紀律進場」那句指令** ——
//   第一版只在後面補「但大盤…別追高」,前半仍是完整指令 → 使用者只讀粗體那半就會照做,
//   巡邏工具也照樣判定跟頂端跑馬燈打架。⭐ 改成把指令本身換掉。
{
    // ⚠️ `_mktGate?.()` 有多個呼叫點 → 錨要用**打法適配儀自己那一段**的特徵
    //   (⛔ 用第一個 indexOf 會抓到多空計分卡那段 = 驗錯地方)
    const _a = SRC.indexOf('const _en = this._wrEnough(r0.count);');
    ok('🚧 空過守門:抓得到打法適配儀那一段', _a > 0, _a);
    const _seg = SRC.slice(_a, _a + 2200);
    ok('④c 打法適配儀:守門觸發時要改成「條件到了 + 只能小量、別追高」',
       /條件是到了[\s\S]{0,120}只能小量,⛔ 別追高/.test(_seg), _seg.slice(0, 300));
    ok('④c2 ⛔ 守門那條分支裡不可再出現完整的「可依紀律進場」指令',
       !/\? `→ [^`]*可依紀律進場/.test(_seg), (_seg.match(/\? `→ [^`]{0,120}/) || [''])[0]);
    ok('④c3 ⭐ 沒守門時維持原文案(⛔ 別把正常情境弄壞)',
       /: `→ 可依紀律進場。`/.test(_seg), '');
}

await browser.close();
console.log(fails ? `❌ ${fails} 條失敗` : '✅ MKTGATE_PASS(全部通過)');
process.exit(fails ? 1 : 0);
