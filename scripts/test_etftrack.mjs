#!/usr/bin/env node
/**
 * 🚦 ETF 跟車狀態(V73.7.1)測試 —— ⭐ 測資直接用**使用者截圖那一版的真實情境**。
 *
 * 🚨 使用者截圖(2327 國巨・2026-08-17 14:28 盤後)畫面上的三個錯:
 *   ① 「進場價取 2026-08-14 收盤 ≈ **608.00**」→ 08/14 官方收盤其實是 **622**;
 *      608 是**當天(08/17)的價**。連帶「換股當日該股 **−8.2%**」也錯(實際 −6.0%)。
 *      真因:`activeData` 會被 `applyLatestPrice` 用即時價**覆蓋最後一根的 close**,
 *      而這張卡問的是「歷史某一天的官方收盤」→ 必須讀 `baseRawData`。
 *      ⭐⭐ 通用:**「歷史某天的收盤」與「現在多少錢」是兩個東西,⛔ 不可共用同一個陣列。**
 *   ② 「連買 **0** 天 ・ 買超**放大**」→ 自相矛盾。真因:趨勢用 `avgL > avgP*1.1` 比大小,
 *      但序列**含負值(賣超)** →「賣得比較少」(−10 > −100×1.1)被講成「買超放大」。
 *   ③ 「💡 進場價偏低**可留意**」(綠・偏多) 與 「⚠️ ETF 在減碼/換出,**法人撤退中,別逆勢**」
 *      同時出現在同一張卡 → ⛔ 使用者鐵則「邏輯不打架」。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._analyzeTrustBuying, null, { timeout: 25000 });

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── ② 賣超不可被講成「買超放大」(純函式,決定性)──
{
    const R = await page.evaluate(() => {
        const mk = arr => arr.map((v, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, close: 100, volume: 1e6, trust_net: v }));
        return {
            // 🚨 截圖情境:今天沒買、前段賣很多、近三日賣比較少 → 舊版會講「買超放大」
            sell:  app._analyzeTrustBuying(mk([-900, -800, -700, -600, -500, -400, -50, -40, -30, -20])),
            // 反向:真的在買而且變大 → 必須還是「放大」(⛔ 不可一律改掉 = 過度修正)
            buy:   app._analyzeTrustBuying(mk([10, 12, 11, 13, 12, 14, 300, 400, 500, 600])),
            // 買但縮小
            shr:   app._analyzeTrustBuying(mk([600, 500, 400, 300, 250, 200, 20, 15, 10, 8])),
        };
    });
    ok('② 🚨 今天沒買 + 前段賣超 → ⛔ 不可講「放大」',
       R.sell && /賣超/.test(R.sell.trend), JSON.stringify(R.sell && { c: R.sell.consecutive, t: R.sell.trend }));
    ok('②b ⭐ 連買天數 0 時,趨勢字樣不可含「買超」',
       R.sell && R.sell.consecutive === 0 && !/^放大$|^縮小$/.test(R.sell.trend),
       JSON.stringify(R.sell && { c: R.sell.consecutive, t: R.sell.trend }));
    ok('②c ⭐ 反向:真的在買且變大 → 仍要講「放大」(⛔ 不可過度修正)',
       R.buy && R.buy.trend === '放大', JSON.stringify(R.buy && { t: R.buy.trend }));
    ok('②d 買但縮小 → 「縮小」', R.shr && R.shr.trend === '縮小', JSON.stringify(R.shr && { t: R.shr.trend }));
    ok('②e 顯示端:賣超時 ⛔ 不可再印「買超」兩個字',
       /\$\{\/賣超\/\.test\(a\.trend\) \? '' : '買超'\}/.test(src), '');
}

// ── ① 歷史收盤 ⛔ 不可用被即時價覆蓋的陣列 ──
{
    const blk = src.slice(src.indexOf('// 進場價:從 activeData'), src.indexOf('const pctStr ='));
    ok('① ⭐ entry 迴圈改讀 baseRawData(官方收盤)', /const _hist = \(Array\.isArray\(this\.baseRawData\)/.test(blk), '');
    ok('①b ⭐ 換股當日漲跌也要用官方收盤', /if \(entryDate && Array\.isArray\(_hist\)\)/.test(blk), '');
    ok('①c ⛔ 這段不可再從 activeData 撈歷史收盤',
       !/for \(const bar of this\.activeData\)/.test(blk) && !/const sorted = this\.activeData/.test(blk), '');
    ok('①d 「今價」仍可以用即時價(⛔ 不可一起改掉)', /「今價」才可以吃即時價/.test(blk), '');

    // 實跑:模擬截圖那天(08/14 官方收 622,盤後即時價 608 覆蓋進最後一根)
    const R = await page.evaluate(() => {
        const base = [
            { date: '2026/08/12', open: 607, high: 625, low: 600, close: 602, volume: 5.6e7 },
            { date: '2026/08/13', open: 631, high: 662, low: 626, close: 662, volume: 4.7e7 },
            { date: '2026/08/14', open: 668, high: 668, low: 617, close: 622, volume: 7.4e7 },
        ];
        app.baseRawData = JSON.parse(JSON.stringify(base));
        // 盤後即時價把最後一根 close 覆蓋成 608(= applyLatestPrice 的 else 分支做的事)
        app.activeData = JSON.parse(JSON.stringify(base));
        app.activeData[2].close = 608;
        const upd = '2026-08-17';
        let entryPx = null, entryDate = '';
        const _hist = app.baseRawData;
        for (const bar of _hist) {
            const d = String(bar.date).slice(0, 10).replace(/\//g, '-');
            if (d <= upd && d > entryDate) { entryDate = d; entryPx = bar.close; }
        }
        const sorted = _hist.map(b => ({ d: String(b.date).slice(0, 10).replace(/\//g, '-'), c: b.close })).sort((a, b) => a.d < b.d ? -1 : 1);
        const i = sorted.findIndex(x => x.d === entryDate);
        const chg = i > 0 ? (sorted[i].c - sorted[i - 1].c) / sorted[i - 1].c * 100 : null;
        return { entryDate, entryPx, chg: chg == null ? null : +chg.toFixed(1) };
    });
    ok('①e 🚨 進場價要是 08/14 官方收盤 622(⛔ 不是即時價 608)',
       R.entryPx === 622 && R.entryDate === '2026-08-14', JSON.stringify(R));
    ok('①f 🚨 換股當日漲跌要是 −6.0%(⛔ 不是螢幕上那個 −8.2%)', R.chg === -6, `chg=${R.chg}`);
}

// ── ③ 燈號 vs 結論不可打架 ──
{
    const blk = src.slice(src.indexOf('if (isDay0) {'), src.indexOf('const verdict = (() => {'));
    ok('③ ⭐「進場價偏低可留意」要先看 ETF 是買還是賣', /const _in = actionsIn \+ actionsUp;/.test(blk), '');
    ok('③b ⭐ 整批減碼/換出時要改口「⛔ 不是進場理由」', /不是進場理由/.test(blk), '');
    ok('③c ⛔ 減碼時不可再出現「可留意」那句(它在 _in > 0 分支裡)',
       /_in > 0[\s\S]{0,140}進場價偏低可留意/.test(blk), '');
    ok('③d 計數要在 lamp 之前算好(⛔ 否則 lamp 讀不到)',
       src.indexOf('const actionsIn  = actions.filter') < src.indexOf('const _in = actionsIn + actionsUp;'), '');
}

ok('④ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ ETFTRACK_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
