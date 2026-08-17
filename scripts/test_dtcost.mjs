#!/usr/bin/env node
/**
 * 💰 當沖成本關卡(V73.6.0)測試
 *
 * ⭐ 來源:使用者上傳的 53 份當沖逐字稿裡,**唯一不需要驗證就成立**的一條 ——
 *    它不是「會不會漲」的預測,而是**算術**:
 *    股價跳一檔賺幾 % vs 當沖來回成本 → 這檔至少要跳幾檔才回本。
 *
 * ⛔ 這支要釘死的:
 *  ① 數字要跟逐字稿的實例對得上(105→1檔 / 91→3檔 / 60→2檔 / 45→3檔)
 *  ② 跳動單位階梯**只有一份**(⛔ `_roundTick` 不可再 inline 一份 —— 陷阱 #37)
 *  ③ 要吃使用者設定的手續費折數(⛔ 不可寫死)
 *  ④ ⛔ 不可講成預測/方向(它是成本事實,不是「會漲」)
 *  ⑤ 「連量偵測」必須降級到摺疊區並標明實測不成立(⛔ 不可再放常顯區下多空)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._dtCostGate, null, { timeout: 25000 });

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── ① 對上逐字稿的實例 ──
const R = await page.evaluate(() => {
    app.settings = app.settings || {};
    app.settings.feeDiscount = 0.28;                 // 3 折(逐字稿用的假設)
    const g = p => app._dtCostGate(p);
    return {
        cost: +(g(100).cost).toFixed(3),
        n105: g(105).need, p105: +(g(105).tickPct).toFixed(2),
        n91:  g(91).need,  p91:  +(g(91).tickPct).toFixed(2),
        n60:  g(60).need,  p60:  +(g(60).tickPct).toFixed(2),
        n45:  g(45).need,  p45:  +(g(45).tickPct).toFixed(2),
        t9: app._tickOf(9), t45: app._tickOf(45), t91: app._tickOf(91),
        t300: app._tickOf(300), t700: app._tickOf(700), t2205: app._tickOf(2205),
        bad: g(91).lvl, okk: g(105).lvl, mid: g(60).lvl,
        nullish: app._dtCostGate(0),
        // ③ 折數要吃設定
        cheap: (() => { app.settings.feeDiscount = 0.1; const c = app._dtCostGate(100).cost; app.settings.feeDiscount = 0.28; return +c.toFixed(3); })(),
        html: app._dtCostGateHtml(91),
        htmlOk: app._dtCostGateHtml(105),
        // ② _roundTick 要走同一份階梯
        rt: [app._roundTick(91.03), app._roundTick(300.2), app._roundTick(9.994)],
    };
});

ok('① 來回成本 = 0.230%(手續費 3 折 ×2 + 當沖稅減半)', R.cost === 0.230, `${R.cost}`);
ok('①a 105 元:跳一檔 0.48% → 1 檔回本', R.n105 === 1 && R.p105 === 0.48, `${R.p105}% / ${R.n105}檔`);
ok('①b 91 元:跳一檔 0.11% → 3 檔回本', R.n91 === 3 && R.p91 === 0.11, `${R.p91}% / ${R.n91}檔`);
ok('①c 60 元:跳一檔 0.17% → 2 檔回本', R.n60 === 2 && R.p60 === 0.17, `${R.p60}% / ${R.n60}檔`);
ok('①d 45 元:跳一檔 0.11% → 3 檔回本', R.n45 === 3 && R.p45 === 0.11, `${R.p45}% / ${R.n45}檔`);
ok('①e 跳動單位階梯正確(10/50/100/500/1000 五段)',
   R.t9 === 0.01 && R.t45 === 0.05 && R.t91 === 0.1 && R.t300 === 0.5 && R.t700 === 1 && R.t2205 === 5,
   JSON.stringify([R.t9, R.t45, R.t91, R.t300, R.t700, R.t2205]));
ok('①f 分級:105=好 / 60=普通 / 91=差', R.okk === 'ok' && R.mid === 'mid' && R.bad === 'bad', `${R.okk}/${R.mid}/${R.bad}`);
ok('①g ⛔ 價格無效要回 null(不可硬給一個數字)', R.nullish === null, String(R.nullish));

// ── ② 階梯只有一份 ──
{
    const ladders = src.match(/< ?10 \? 0\.01 ?: ?\w+ ?< ?50 \? 0\.05/g) || [];
    ok('② ⛔ 跳動單位階梯全 App 只有一份(⛔ _roundTick 不可再 inline)',
       ladders.length === 1, `找到 ${ladders.length} 份`);
    ok('②b _roundTick 走 _tickOf', /const t = this\._tickOf\(p\);/.test(src), '');
    ok('②c _roundTick 行為不變', R.rt[0] === 91 && R.rt[1] === 300 && R.rt[2] === 9.99, JSON.stringify(R.rt));
}

// ── ③ 折數要吃設定 ──
ok('③ 手續費折數改 1 折 → 成本要跟著降', R.cheap < 0.20 && R.cheap > 0.17, `${R.cheap}`);

// ── ④ ⛔ 不可講成預測 ──
{
    const t = R.html.replace(/<[^>]+>/g, '');
    ok('④ 差的價位要明說「效率差」+ 給替代做法', /效率差/.test(t) && /股票期貨|換一檔/.test(t), t.slice(0, 120));
    ok('④b ⛔ 不可出現預測性字眼(會漲/看多/買進訊號)',
       !/會漲|看多|買進訊號|勝率/.test(t), t.slice(0, 160));
    ok('④c 好的價位也要講清楚是「成本」不是「該買」',
       /回本/.test(R.htmlOk.replace(/<[^>]+>/g, '')) && !/該買|進場/.test(R.htmlOk.replace(/<[^>]+>/g, '')), '');
    ok('④d 要把成本數字攤開(⛔ 不可只給結論)', /來回成本/.test(t) && /折/.test(t), '');
}

// ── ⑤ 連量偵測降級 ──
{
    // ⚠️ '🔴 盤中連量偵測' 在檔案裡出現多次(註解也有)→ 要定位到**真正渲染的那一段**
    const i = src.indexOf('// ── 卡:🔴 盤中連量偵測');
    const blk = src.slice(i, i + 2200);
    ok('⑤ 連量偵測改推進 detail(摺疊區),⛔ 不再進 cards', /detail\.push\(`[\s\S]{0,200}🔴 盤中連量偵測/.test(blk), '');
    ok('⑤b 要標「本站實測不成立」', /⛔ 本站實測不成立/.test(blk), '');
    ok('⑤c 要引用兩次實測的數字(⛔ 不可只寫「沒用」)',
       /\+0\.14pp/.test(blk) && /18~32%/.test(blk) && /49~52%/.test(blk), '');
    ok('⑤d ⛔ 降級後不可再用紅綠下方向', !/border-red-500|text-red-300/.test(blk.slice(blk.indexOf('detail.push'))), '');
    ok('⑤e ⛔ 不可留下沒人用的 _vst 變數', !/_vst/.test(src), '');
}

ok('⑥ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ DTCOST_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
