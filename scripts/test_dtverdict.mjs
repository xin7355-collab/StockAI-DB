#!/usr/bin/env node
/**
 * 🚦 當沖「今天這檔怎麼做」勝率誠實性測試(V72.5.6)
 *
 * 🚨 修的是什麼:`_dtVerdictInner` 舊版把回測勝率加上一串**憑空編的係數**
 *    (大盤分數×3、部位訊號±8、族群×4、量比+3,最多搬動 ±15pp),
 *    然後把那個數字標成「勝率約 57%」。三個致命問題:
 *      ① 使用者看到的「勝率」有一半不是統計出來的
 *      ② 沒有對照組,門檻寫死 55/45(陷阱 #36「0% 也能當冠軍」)
 *      ③ 沒有 `_wrEnough` / `_wrTag`(`b.n < 8` 比全 App 統一門檻 10 還鬆)
 *    ⭐ 同一頁的 `_dtWinRateBacktest` 早就做對了 → 這支測試釘住「兩支判準一致」。
 *
 * ⛔ 這支最重要的一條是 ④:**環境訊號改了,勝率數字不可以跟著動**。
 *    那正是舊版的病灶,而且它不會報錯、只會安靜地給出一個不存在的勝率。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };
const txt = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._dtVerdictInner, null, { timeout: 20000 });

// ── 合成日K:每一天自己指定「開盤相對昨收幾%」與「開盤→收盤幾%」──────────
//    ⛔ 刻意不用真實資料 —— 這裡要驗的是**判準**,真實資料哪天有優勢會隨時間變(V72.1.8 的教訓)。
const mkBars = spec => page.evaluate(s => {
    const bars = []; let pc = 100;
    for (let i = 0; i < s.length; i++) {
        const [gapPct, ocPct] = s[i];
        const o = pc * (1 + gapPct / 100), c = o * (1 + ocPct / 100);
        bars.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: o, high: Math.max(o, c) * 1.005, low: Math.min(o, c) * 0.995, close: c, volume: 10000 });
        pc = c;
    }
    return bars;
}, spec);

const run = (bars, openP, env = {}) => page.evaluate(a => {
    app.fiShortQty = a.env.fi != null ? a.env.fi : null;
    app._daytradePack = a.env.pack || null;
    app._liveQuotes = null;
    app._ovTrend = a.env.bear ? { sym: 'T1', trend: 'bear', txt: '' } : null;
    const pc = a.bars[a.bars.length - 1].close;
    return app._dtVerdictInner('T1', a.openP * 1.001, pc, 0, a.openP * 1.01, a.openP * 0.99, a.openP, a.bars);
}, { bars, openP, env });

// ① 開高做多明顯有賺(每趟 +2%,遠大於成本 0.25%)→ 要敢說「可以做多」
const specA = [];
for (let i = 0; i < 80; i++) specA.push(i % 2 === 0 ? [2.0, 2.0] : [0, -0.1]);
const barsA = await mkBars(specA);
const lastPcA = await page.evaluate(b => b[b.length - 1].close, barsA);
const hA = await run(barsA, lastPcA * 1.02);
const tA = txt(hA);
ok('① 開高有優勢 → 給「做多」', /可以「做多」/.test(tA), tA.slice(0, 200));
ok('① ⭐ 要顯示對照組基準(不是只給一個勝率)', /基準/.test(tA), tA.slice(0, 260));
ok('① ⭐ 要顯示「扣成本後每趟」', /扣成本後每趟/.test(tA), tA.slice(0, 260));

// ② 每天小賠(−0.1%,扣成本後多空都負)→ ⛔ 不准給任何方向
const barsB = await mkBars(Array.from({ length: 80 }, () => [0, -0.1]));
const lastPcB = await page.evaluate(b => b[b.length - 1].close, barsB);
const hB = await run(barsB, lastPcB);
const tB = txt(hB);
ok('② 扣成本後都是負的 → 「不值得當沖」', /不值得當沖/.test(tB), tB.slice(0, 200));
ok('② ⛔ 不可出現「可以做多 / 偏做空」', !/可以「做多」|偏「做空」/.test(tB), tB.slice(0, 200));
ok('② ⭐ 要講出成本這個原因', /扣掉當沖來回成本/.test(tB), tB.slice(0, 260));

// ③ 每天開盤買收盤賣穩賠 1%(= 做空穩賺)→ 要給「做空」
const barsC = await mkBars(Array.from({ length: 80 }, () => [0, -1.0]));
const lastPcC = await page.evaluate(b => b[b.length - 1].close, barsC);
const tC = txt(await run(barsC, lastPcC));
ok('③ 做空有優勢 → 給「做空」', /偏「做空」/.test(tC), tC.slice(0, 200));
// ⭐ 關卡那句要跟著結論走(實測 2317 出現過「偏做空」配「站上壓可續」= 自己跟自己打架)
ok('③ ⭐ 做空時關卡改講回補,⛔ 不可寫做多口吻', /站回壓就回補/.test(tC) && !/站上壓可續抱/.test(tC), tC.slice(-200));
ok('③ ⭐ 「不值得當沖」時關卡只描述、不下停損指令', /不是叫你進場/.test(tB) && !/就跑=停損/.test(tB), tB.slice(-200));

// ── ④ ⭐⭐ 核心回歸:環境訊號改了,勝率數字**不可以**跟著動 ──────────────
//    舊版 `adj = macroScore*3 + posSig*±8 + groupSig*4 + 量比+3` 會讓同一份歷史
//    在「外資大買」與「外資大空」兩種情境下顯示不同的勝率 —— 那個差額是**編出來的**。
const grab = t => (t.match(/\d+%/g) || []).join(',');
const tBull = txt(await run(barsA, lastPcA * 1.02, { fi: 60000, pack: { largeTrader: { all: { top10Net: 9000 } } } }));
const tBear = txt(await run(barsA, lastPcA * 1.02, { fi: -60000, pack: { largeTrader: { all: { top10Net: -9000 } } } }));
ok('④ ⭐⭐ 外資/大額訊號相反時,勝率數字必須完全一樣', grab(tBull) === grab(tBear), `多:${grab(tBull)} / 空:${grab(tBear)}`);
ok('④ ⭐ 而且要明講「這些訊號沒有計入勝率」', /沒有計入上面的勝率/.test(tBull), tBull.slice(-400));
ok('④ ⛔ 不可再出現「得出此建議」那種被加工過的說法', !/得出此建議/.test(tBull), '');

// ── ⑤ 空頭守門(當沖頁在 V72.5.6 之前整頁都沒接 `_bearGate`)────────────
const tBear2 = txt(await run(barsA, lastPcA * 1.02, { bear: true }));
ok('⑤ ⭐ 空頭時做多要加「不要凹成波段留倉」', /不要凹成波段留倉/.test(tBear2), tBear2.slice(0, 320));
ok('⑤ ⚠️ 但事實不變 —— 做多結論仍在(當沖當天平倉,⛔ 不是整個擋掉)', /可以「做多」/.test(tBear2), tBear2.slice(0, 200));
ok('⑤ ⭐ 非空頭時不可誤傷(不該出現那句)', !/不要凹成波段留倉/.test(tA), tA.slice(0, 200));

// ── ⑥ 燈號鐵則:風險/資格不可用 🔴🟡🟢 ────────────────────────────────
//    ⚠️ emoji 一律用 \u{...} 寫,⛔ 別寫成字元類 `[🔴🟢]` —— 沒有 u flag 會拆代理對,
//       本專案已踩過兩次(一次在測試、一次在正式碼)。
const RISK_EMOJI = /(\u{1F534}|\u{1F7E1}|\u{1F7E2}|\u{1F7E0})/u;
const srcSpec = await page.evaluate(() => app._dtOvernightSpec.toString());
ok('⑥ 隔日沖風險等級改用 ⛔/⚠️/✅', /⛔ 高/.test(srcSpec) && /⚠️ 中/.test(srcSpec) && /✅ 低/.test(srcSpec), '');
const srcHero = await page.evaluate(() => app.renderDayTradeTab.toString());
ok('⑥ 當沖資格燈改用 ⛔/⚠️/✅', /⛔ 今天不要當沖/.test(srcHero) && /✅ 具備當沖條件/.test(srcHero), srcHero.slice(0, 80));
// 主結論那行(方向)可以用 🔴🟢,但「不值得當沖」那行不可以
ok('⑥ ⭐「不值得當沖」用中性 ➖ 不用顏色燈', /➖ 這檔今天不值得當沖/.test(tB) && !RISK_EMOJI.test(tB.split('不值得當沖')[0].slice(-12)), tB.slice(0, 120));

// ── ⑦ 期望值為負一律灰字(⛔ 不可綠色 —— 綠在台股是「跌」)──────────────
const negCls = /扣成本後每趟\s*<b class="([^"]+)">-/.exec(hB.replace(/\s+/g, ' '));
ok('⑦ 負期望值用灰字', !!negCls && /text-gray-500/.test(negCls[1]), negCls ? negCls[1] : '沒抓到');

// ── ⑧ 判準要用全 App 共用那套(_wrEnough/_wrTag/_bearGate,⛔ 同一頁不可兩套標準)──
//    ⚠️ 原本的對照對象 `_dtWinRateBacktest` 已於 V74.2.0 刪除(dtflip_probe 實測賺不到),
//       但「共用門檻」的要求不因它刪除而消失 → 斷言照舊釘 `_dtVerdictInner` 自己。
const src = await page.evaluate(() => app._dtVerdictInner.toString());
ok('⑧ 有用共用樣本門檻 `_wrEnough`', /_wrEnough\(/.test(src), '');
ok('⑧ 有配共用樣本徽章 `_wrTag`', /_wrTag\(/.test(src), '');
ok('⑧ 有呼叫共用空頭守門 `_bearGate`', /_bearGate\(/.test(src), '');
ok('⑧ ⛔ 憑空係數 adj 已移除', !/const adj\s*=/.test(src), '');
ok('⑧ ⛔ 寫死門檻 55/45 已移除', !/>=\s*55\b/.test(src) && !/<=\s*45\b/.test(src), '');

// ── ⑨ `_dtLongStats` 要有 sumR(期望值要含平盤日)────────────────────────
const st = await page.evaluate(b => { const s = app._dtLongStats(b); return { has: 'sumR' in s.all, n: s.all.n, exp: s.all.sumR / s.all.n }; }, barsB);
ok('⑨ _dtLongStats 有 sumR', st.has, JSON.stringify(st));
ok('⑨ 期望值算對(每天 −0.1%)', Math.abs(st.exp - (-0.1)) < 0.01, JSON.stringify(st));

// ── ⑩ 隔日沖:只靠分點佔比觸發時,⛔ 不可謊稱「今天大漲爆量」────────────
const hOv = await page.evaluate(b => {
    app._fenSym = 'T1';
    app._fenPeriods = {
        '1d': { buy: [{ broker_id: 'X', broker_name: '甲券商', net: 900000 }], sell: [] },
        '5d': { buy: [{ broker_id: 'X', broker_name: '甲券商', net: 1000 }], sell: [] },
    };
    return app._dtOvernightSpec('T1', 0.3, 100, 99.7, b);
}, barsB);
const tOv = txt(hOv);
ok('⑩ 有觸發(分點隔日沖佔比高)', /隔日沖判斷/.test(tOv), tOv.slice(0, 160));
ok('⑩ ⭐ 今天只漲 0.3% → ⛔ 不可寫「今天大漲爆量」', !/今天大漲爆量/.test(tOv), tOv.slice(0, 220));

ok('⑪ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:\n - ${fails.join('\n - ')}` : '\n✅ DTVERDICT_TEST_PASS');
process.exit(fails.length ? 1 : 0);
