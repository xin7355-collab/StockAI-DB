#!/usr/bin/env node
/**
 * 📅 分點週期「實際天數」誠實標示(V73.3.7)測試
 *
 * 🚨 使用者問:「分點是到 20 天了嗎?最遠幾天?為何有些還是只有 10 天?」
 *    查下去是真 bug:`miner.py::_agg_period(n)` 用 `sorted(by_date)[-n:]`,
 *    **天數不足時給幾天算幾天**,而外面照樣把它標成 `20d`。
 *    實測 gh-pages:**246 檔標「20 日」,沒有一檔真的有 20 天**(最多 15、最少 4)。
 *
 * ⛔ 兩邊都要釘(只驗一邊會做出過度修正):
 *    ① 不足時**一定要**講出真實天數(②③)
 *    ② 足額 / 舊檔沒有 days 欄位時**不可誤傷**(④⑤)—— ⛔ 舊檔不可假裝知道天數
 *    ③ ⛔ 不可因為天數不足就把資料藏起來(⑥)
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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderBrokerFenDian, null, { timeout: 20000 });

// 造分點測資:days 可控
const mkP = (days) => {
    const one = { buy: [{ broker_id: '9200', broker_name: '凱基', net: 5000, buy: 6000, sel: 1000, avg: 100 }],
                  sell: [{ broker_id: '1440', broker_name: '美林', net: -4000, buy: 0, sel: 4000, avg: 101 }] };
    const P = {};
    for (const k of ['1d', '3d', '5d', '10d', '20d']) {
        P[k] = { ...one };
        if (days !== undefined) { P[k].days = Math.min(days, +k.replace('d', '')); P[k].want = +k.replace('d', ''); }
    }
    return P;
};
const render = (days, period) => page.evaluate(([days, period]) => {
    app.currentSymbolId = '2330';
    app._fenSym = '2330';
    app._fenPeriods = (() => {
        const one = { buy: [{ broker_id: '9200', broker_name: '凱基', net: 5000, buy: 6000, sel: 1000, avg: 100 }],
                      sell: [{ broker_id: '1440', broker_name: '美林', net: -4000, buy: 0, sel: 4000, avg: 101 }] };
        const P = {};
        for (const k of ['1d', '3d', '5d', '10d', '20d']) {
            P[k] = JSON.parse(JSON.stringify(one));
            if (days !== null) { P[k].days = Math.min(days, +k.replace('d', '')); P[k].want = +k.replace('d', ''); }
        }
        return P;
    })();
    app._chipSym = null; app._chipPeriods = null;
    let box = document.getElementById('chipPaneBroker');
    if (!box) { box = document.createElement('div'); box.id = 'chipPaneBroker'; document.body.appendChild(box); }
    box.innerHTML = '';
    app._renderBrokerFenDian(period);
    return box.innerHTML;
}, [days, period]);

// 🚧 空過守門:box 空的話「不可跳警示」那幾條會**全部假綠**(第一版就踩到:
//    容器 id 猜成 chipBrokerFenDian,結果什麼都沒渲染,④⑤ 照樣顯示通過)。
const must = async (days, period) => {
    const h = await render(days, period);
    if (!/凱基|美林/.test(txt(h))) {
        console.log('❌ 🚧 空過守門:renderBrokerFenDian 什麼都沒渲染 → 後面的斷言全部無效');
        console.log('   實際 innerHTML:', String(h).slice(0, 300));
        await browser.close(); process.exit(1);
    }
    return h;
};

// ① 基本:能渲染出來
{
    const h = await must(20, '20d');
    ok('① 足額時渲染正常', /凱基|美林/.test(txt(h)), txt(h).slice(0, 160));
}

// ②③ ⭐ 不足時必須講出真實天數
{
    const h = await must(15, '20d');
    const t = txt(h);
    ok('② 只有 15 天卻選 20 日 → 必須警示', /實際只加總了/.test(t), t.slice(0, 260));
    ok('②b 必須寫出真實天數 15', /只加總了 15 個交易日/.test(t), t.slice(0, 260));
    ok('②c 必須寫還差幾天(20-15=5)', /再過 5 個交易日/.test(t), t.slice(0, 300));
    ok('③ ⛔ 不可暗示數字是錯的(數字是真的,只是期間短)', /數字是真的/.test(t), t.slice(0, 320));
    ok('③b ⛔ 不可把資料藏起來', /凱基|美林/.test(t), t.slice(0, 200));
}

// ④ ⛔ 足額時不可誤傷
{
    const h = await must(20, '20d');
    ok('④ ⛔ 足額時不可跳警示', !/實際只加總了/.test(txt(h)), txt(h).slice(0, 200));
    const h3 = await must(20, '3d');
    ok('④b ⛔ 3 日(本來就只要 3 天)不可跳警示', !/實際只加總了/.test(txt(h3)), txt(h3).slice(0, 200));
}

// ⑤ ⛔ 舊檔沒有 days 欄位 → 不可假裝知道
{
    const h = await must(null, '20d');
    ok('⑤ ⛔ 舊檔(無 days 欄位)不可顯示天數警示', !/實際只加總了/.test(txt(h)), txt(h).slice(0, 200));
    ok('⑤b 舊檔仍要正常顯示資料', /凱基|美林/.test(txt(h)), txt(h).slice(0, 160));
}

// ⑥ 極端:只有 4 天卻選 20 日(實測真的有 2 檔長這樣)
{
    const h = await must(4, '20d');
    const t = txt(h);
    ok('⑥ 只有 4 天 → 警示且寫出 4', /只加總了 4 個交易日/.test(t), t.slice(0, 260));
    ok('⑥b 還差 16 天', /再過 16 個交易日/.test(t), t.slice(0, 300));
}

// ⑦ 採礦端必須真的回傳 days/want(⛔ 否則前端永遠等不到)
{
    const fs = await import('fs');
    const src = fs.readFileSync(path.join(ROOT, 'miner.py'), 'utf8');
    ok('⑦ miner.py 的 _agg_period 要回傳 days', /'days': len\(wdates\)/.test(src), '');
    ok('⑦b 也要回傳 want(標籤上那個數字)', /'want': n/.test(src), '');
}

ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ CHIPDAYS_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
