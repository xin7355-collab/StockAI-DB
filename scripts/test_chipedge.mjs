#!/usr/bin/env node
/**
 * 📊 籌碼訊號實測成績(V73.3.6)測試
 *
 * 背景:使用者問「分析師常說外資大賣、現在**認錯回補**,這有說錯嗎?」
 *   以前答不了 —— `foreign_net` 只有 60 天且全在同一段行情(CLAUDE.md 明寫「樣本不足以回測」)。
 *   V73.3.6 回補到約 3 年後,`scripts/chip_probe.py` 第一次驗得動:
 *     A 連賣3天↑後轉買 = **−0.04pp**(n=35,242,前半 +0.02 / 後半 −0.05,方向相反)→ **不成立**
 *     G 外資+投信同買   = **+0.99pp**(n=10,761,前半 +0.38 / 後半 +1.59,拿掉最好月份 +0.90)→ 成立
 *
 * ⛔ 這支要擋住三件事(每一件都在 CLAUDE.md 犯過):
 *   ① 把「實測沒用」的訊號寫成看起來有用(⑤⑥)
 *   ② 在這張卡下買賣指令 —— 單一劇本原則,指令只有「現在怎麼做」能下(③)
 *   ③ 空頭時照樣叫人跟(④);以及顯示的數字跟探針對不上(⑦ 交叉驗證)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const txt = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._chipEdgeHtml, null, { timeout: 20000 });

// 造測資:n 根 K,尾端依情境給法人買賣超
const mk = (tail) => {
    const rows = [];
    for (let i = 0; i < 40; i++) {
        rows.push({ date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, open: 100, high: 101, low: 99, close: 100, volume: 1000,
                    foreign_net: 0, trust_net: 0, margin_balance: 1000 });
    }
    tail.forEach((t, k) => Object.assign(rows[rows.length - tail.length + k], t));
    return rows;
};
const run = (rows, bear) => page.evaluate(([rows, bear]) => {
    app.rawDailyData = rows;
    app.currentSymbolId = '9999';
    app._ovTrend = bear ? { sym: '9999', trend: 'bear', txt: '' } : null;
    return { html: app._chipEdgeHtml('9999'), st: app._chipEdgeState('9999') };
}, [rows, bear]);

// ① 沒有法人資料 → 不可假裝有成績
{
    const r = await run(mk([{ foreign_net: null, trust_net: null }]), false);
    ok('① 沒資料時 state 回 null', r.st === null, JSON.stringify(r.st));
    ok('①b 沒資料時要誠實說「沒有出現實測過的型態」', /沒有出現實測過/.test(txt(r.html)), txt(r.html).slice(0, 120));
}

// ② 外資+投信同買 → 命中 both,而且要秀出數字
let bothHtml = '';
{
    const r = await run(mk([{ foreign_net: 500 }, { foreign_net: 500 }, { foreign_net: 1000, trust_net: 500 }]), false);
    bothHtml = r.html; const t = txt(r.html);
    ok('② 外資+投信同買 → 命中', !!r.st && /both/.test(r.st.key), JSON.stringify(r.st && r.st.key));
    ok('②b 要有邊際數字', /\+0\.99pp/.test(t), t.slice(0, 200));
    ok('②c 要有樣本數(⛔ 勝率不可孤零零出現)', /10,761/.test(t), t.slice(0, 200));
    ok('②d 要寫出基準勝率 34.6%(⛔ 不是 50%)', /34\.6%/.test(t), t.slice(0, 240));
    ok('②e 要寫前後半段(穩健性)', /前半段/.test(t) && /後半段/.test(t), t.slice(0, 240));
    ok('②f 要寫拿掉最好月份仍成立', /拿掉貢獻最大/.test(t), t.slice(0, 260));
    ok('②g 要扣掉交易成本後再講一次', /扣掉來回成本/.test(t) && /\+0\.55pp/.test(t), t.slice(0, 300));
}

// ③ ⛔ 這張卡不可下買賣指令(單一劇本原則)
{
    const t = txt(bothHtml);
    // ⚠️ 先 strip 掉否定/免責句,否則自己寫對的「⛔ 別直接當進場理由」會把測試絆倒
    //    (CLAUDE.md 記過:這個坑已經踩過 6 次)
    const stripped = t.replace(/⛔[^。]*。?/g, '').replace(/別[^。]*。?/g, '').replace(/不[是可要能][^。]*。?/g, '');
    ok('③ 不可出現買賣指令', !/(買進|賣出|進場|停損|掛單|目標價|加碼|可以跟)/.test(stripped), stripped.slice(0, 260));
    ok('③b 不可出現價位', !/\d+\s*元(買|賣)/.test(stripped), stripped.slice(0, 200));
}

// ④ 空頭時要收口(但事實數字不可竄改)
{
    const r = await run(mk([{ foreign_net: 500 }, { foreign_net: 500 }, { foreign_net: 1000, trust_net: 500 }]), true);
    const t = txt(r.html);
    ok('④ 空頭時要提醒「籌碼亮不代表會漲」', /中期趨勢是空頭/.test(t), t.slice(0, 260));
    ok('④b 空頭時事實數字不可改(仍是 +0.99pp)', /\+0\.99pp/.test(t), t.slice(0, 200));
}

// ⑤⑥ ⭐ 最重要:「認錯回補」單獨出現時,必須說它實測沒用
{
    const r = await run(mk([{ foreign_net: -500 }, { foreign_net: -500 }, { foreign_net: -500 }, { foreign_net: 1000, trust_net: 0 }]), false);
    const t = txt(r.html);
    ok('⑤ 連賣3天後轉買(無投信) → 命中 re3', !!r.st && r.st.key === 're3', JSON.stringify(r.st && r.st.key));
    ok('⑤b 必須明說「實測沒有用」', /實測沒有用/.test(t), t.slice(0, 260));
    ok('⑤c 必須點出「樣本夠大,不是樣本不足」', /不是樣本不足/.test(t), t.slice(0, 300));
    ok('⑤d 必須點出前後半段方向相反', /方向還相反/.test(t), t.slice(0, 320));
    ok('⑥ ⛔ 不可用 ✅ 或紅色把它包裝成有效', !/✅/.test(t) && !/border-red-500/.test(r.html), t.slice(0, 200));
    ok('⑥b 要指路「得等投信也一起買」', /投信也一起買/.test(t), t.slice(0, 340));
}

// ⑦ 邊際 < 交易成本時,必須標「扣完等於白做」
{
    const r = await run(mk([{ foreign_net: 500 }, { foreign_net: 500 }, { foreign_net: 500 }, { foreign_net: 500 }]), false);
    const t = txt(r.html);
    ok('⑦ 外資連買4天 → 命中 buy4', !!r.st && r.st.all.includes('buy4'), JSON.stringify(r.st && r.st.all));
    ok('⑦b 邊際比成本小 → 要說扣完白做', /扣完等於白做/.test(t) || /比交易成本/.test(t), t.slice(0, 300));
}

// ⑧ 交叉驗證:嵌進去的成績必須跟 chip_probe.py 實測一致
//    ⛔ 這條是防「改了探針卻忘了更新表」——同 `_SIGNAL_EDGE` 的教訓
{
    const E = await page.evaluate(() => app._CHIP_EDGE);
    const M = await page.evaluate(() => app._CHIP_EDGE_META);
    const want = { both: [0.99, 40.3, 10761], bothRe: [1.06, 39.3, 4411], re3: [-0.04, 34.8, 35242],
                   re8: [0.32, 34.3, 6220], buy4: [0.22, 36.4, 26006], marginOut: [0.21, 35.9, 32671] };
    let bad = [];
    for (const [k, [e, w, n]] of Object.entries(want)) {
        if (!E[k] || E[k].e !== e || E[k].w !== w || E[k].n !== n) bad.push(k);
    }
    ok('⑧ _CHIP_EDGE 數字與探針一致', !bad.length, '對不上:' + bad.join(','));
    ok('⑧b 基準勝率必須是實測值 34.6(⛔ 不是 50)', M.base === 34.6, String(M.base));
    ok('⑧c ok 旗標:re3 必須標成不成立(0)', E.re3.ok === 0, String(E.re3.ok));
    ok('⑧d ok 旗標:both 必須標成成立(1)', E.both.ok === 1, String(E.both.ok));
    // 前後半段方向相反的,⛔ 不可標成成立
    const wrong = Object.entries(E).filter(([, v]) => v.ok === 1 && (v.h1 <= 0 || v.h2 <= 0)).map(([k]) => k);
    ok('⑧e ⛔ 前後半段沒同向的不可標成立', !wrong.length, wrong.join(','));
    // 邊際小於成本的,⛔ 不可標成 ok=1
    const cheap = Object.entries(E).filter(([, v]) => v.ok === 1 && v.e <= M.cost).map(([k]) => k);
    ok('⑧f ⛔ 邊際沒超過交易成本的不可標成立', !cheap.length, cheap.join(','));
}

ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ CHIPEDGE_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
