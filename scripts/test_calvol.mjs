#!/usr/bin/env node
/**
 * 📅 「今天這種日子顛不顛」(V73.7.3)測試
 *
 * 來源:`scripts/calendar_stock_probe.mjs` 全市場 2,055 檔 × 757 個交易日實測。
 *
 * ⛔ 這支要釘死的五件事:
 *   ① **只講波動,絕不講方向** —— 波動大 ≠ 會漲也 ≠ 會跌。文案不可出現多空字樣、不可用紅綠。
 *   ② 「休市幾天」要用**真實交易日曆**算(K 線最後兩根 + 台北今天),
 *      ⛔ 不可用「星期一 = 休市 3 天」硬算 —— 週一放假時第一個交易日是週二。
 *   ③ 沒命中 → **整條不顯示**(⛔ 不留空殼、不寫「無」佔版面)。
 *   ④ 必須附**樣本數**與「方向沒有邊際」的免責(否則使用者會拿去賭方向)。
 *   ⑤ 「星期一」與「長假後」⛔ 不可寫成兩個獨立發現 —— 實測是同一個機制(休市累積消息),
 *      所以文案一律用「休市 N 天」表達。
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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._calDayVol, null, { timeout: 25000 });

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── ② 用真實交易日曆,不是「星期一」硬算 ──────────────────────────────
const R = await page.evaluate(() => {
    const mk = ds => ds.map(d => ({ date: d, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    const T = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const today = T();
    const back = n => { const t = new Date(today + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - n); return t.toISOString().slice(0, 10); };
    return {
        today,
        // 最後一根就是今天,前一根是昨天 → 隔天,不該命中「休市」
        gap1: app._calDayVol(mk([back(2), back(1), today])),
        // 最後一根是 3 天前(週末)→ 今天是休市 3 天後
        gap3: app._calDayVol(mk([back(10), back(3)])),
        // 最後一根是 6 天前(長假)
        gap6: app._calDayVol(mk([back(20), back(6)])),
        // 🚨 關鍵:最後一根是「今天」而且前一根是 3 天前 → 仍要判成休市 3 天
        gap3in: app._calDayVol(mk([back(20), back(3), today])),
        // 資料不足
        few: app._calDayVol(mk([today])),
        empty: app._calDayVol([]),
        bad: app._calDayVol(null),
        // 月初 vs 月中(固定日期,⛔ 不依賴今天是幾號)
        dom5: app._calDayVol(mk(['2026-03-04', '2026-03-05'])),
        dom20: app._calDayVol(mk(['2026-03-19', '2026-03-20'])),
        // 🚨 週一放假 → 第一個交易日是「週二」,gap 仍是 4 天(⛔ 不可因為不是星期一就漏掉)
        tueAfterHol: app._calDayVol(mk(['2026-03-19', '2026-03-24'])),
        htmlGap3: app._calDayVolHtml(mk([back(20), back(3)])),
        htmlNone: app._calDayVolHtml(mk([back(20), back(19)])),
        // 🚨 資料過期(最後一根是幾個月前)→ ⛔ 不可算成「休市 151 天」
        stale: app._calDayVol(mk(['2026-03-19', '2026-03-20'])),
        staleHol: app._calDayVol(mk(['2026-03-14', '2026-03-20'])),
    };
});

ok('② 隔天(gap=1)+ 非月初 → ⛔ 不命中「休市」',
   !R.gap1 || !(R.gap1.tags || []).some(t => /休市/.test(t.t)), JSON.stringify(R.gap1));
ok('②b 休市 3 天 → 命中,倍數 1.09x', !!R.gap3 && R.gap3.gap === 3 && R.gap3.tags.some(t => t.mult === 1.09), JSON.stringify(R.gap3 && R.gap3.tags));
ok('②c 休市 6 天(長假)→ 倍數 1.43x(⛔ 比週末大)', !!R.gap6 && R.gap6.tags[0].mult === 1.43, JSON.stringify(R.gap6 && R.gap6.tags));
ok('②d 🚨 最後一根已經是今天時,要用「最後兩根」算間隔', !!R.gap3in && R.gap3in.gap === 3, JSON.stringify(R.gap3in));
ok('②e 🚨 週一放假 → 週二才開市,gap=5 仍要命中(⛔ 不可綁死星期一)',
   !!R.tueAfterHol && R.tueAfterHol.gap >= 4 && R.tueAfterHol.tags[0].mult === 1.43, JSON.stringify(R.tueAfterHol));
ok('②f 月初 1-10 日要命中', !!R.dom5 && R.dom5.tags.some(t => /1-10/.test(t.t)), JSON.stringify(R.dom5 && R.dom5.tags));
ok('②g 月中(20 日)+ 隔天 → ⛔ 完全不命中', R.dom20 === null, JSON.stringify(R.dom20));
ok('②h 🚨 資料過期(最後一根是幾個月前)→ ⛔ 不可算成「休市 N 百天」,改描述資料裡的最後一天',
   R.stale === null, JSON.stringify(R.stale));
ok('②i 🚨 過期時仍要正確描述最後一天(3/14→3/20 間隔 6 天 = 長假)',
   !!R.staleHol && R.staleHol.gap === 6 && R.staleHol.date === '2026-03-20', JSON.stringify(R.staleHol));

// ── ③ 沒命中不留空殼;壞輸入不可 throw ─────────────────────────────
ok('③ 沒命中 → HTML 回空字串', R.htmlNone === '', String(R.htmlNone).slice(0, 80));
ok('③b K 線不足 / 空陣列 / null 一律回 null(⛔ 不可 throw)',
   R.few === null && R.empty === null && R.bad === null, JSON.stringify([R.few, R.empty, R.bad]));

// ── ① 只講波動,不講方向;⛔ 不可用紅綠 ────────────────────────────
{
    const H = R.htmlGap3 || '';
    const txt = H.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    ok('① 有講「波動比平常大 N%」', /波動比平常大/.test(txt) && /\d+%/.test(txt), txt.slice(0, 120));
    // ⚠️ 先 strip 掉否定句再驗(本專案踩過 6 次:正確的免責句本身含有被禁的字)
    const stripped = txt
        .replace(/波動大不等於會漲、也不等於會跌/g, '')
        .replace(/只講顛不顛,不講多空/g, '')
        .replace(/方向沒有邊際/g, '');
    ok('①b ⛔ 不可下多空方向', !/(會漲|會跌|偏多|偏空|做多|放空|買進|賣出|進場|停利)/.test(stripped), stripped.slice(0, 160));
    ok('①c ⭐ 必須明說「波動大 ≠ 會漲也 ≠ 會跌」', /不等於會漲/.test(txt) && /不等於會跌/.test(txt), '');
    ok('①d ⛔ 不可用紅綠(那是漲跌方向專用)',
       !/text-(red|green)-\d|bg-(red|green)-\d|border-(red|green)-\d/.test(H), H.slice(0, 200));
    ok('①e 要給可操作的一句(部位放小)', /部位放小/.test(txt), '');
}

// ── ④ 免責:樣本數 + 方向沒有邊際 + 成本 ───────────────────────────
{
    const txt = (R.htmlGap3 || '').replace(/<[^>]+>/g, ' ');
    ok('④ 要附樣本數(N 天)', /樣本 \d+ 天/.test(txt), txt.slice(-160));
    ok('④b 要明說「方向沒有邊際」+ 測了幾種 + 成本 0.44%',
       /方向沒有邊際/.test(txt) && /37 種/.test(txt) && /0\.44%/.test(txt), txt.slice(-200));
}

// ── ⑤ ⛔ 星期一 / 長假後 不可寫成兩個獨立發現 ──────────────────────
{
    const blk = src.slice(src.indexOf('    _calDayVol(data) {'), src.indexOf('    // 買 buy → 賣 sell'));
    ok('⑤ 文案一律用「休市 N 天」表達(⛔ 原始碼裡不可出現寫死的「星期一」標籤)',
       !/t: *`?[^`\n]*星期一/.test(blk), '');
    ok('⑤b 註解要寫明「這兩個是同一個機制」', /不是兩個發現|同一個(?:機制)?/.test(src.slice(src.indexOf('// 📅 V73.7.3'), src.indexOf('    _calDayVol(data) {'))), '');
    ok('⑤c ⛔ 不可用 toISOString 取台北今天(那是 UTC,晚上會差一天)',
       /Intl\.DateTimeFormat\('en-CA', \{ timeZone: 'Asia\/Taipei' \}\)/.test(blk), '');
}

// ── ⑥ 接線:掛在當沖 hero 的成本關卡下方(⛔ 不新增卡片) ──────────
ok('⑥ 已接到當沖 hero(成本關卡正下方)',
   /\$\{this\._dtCostGateHtml\(price\)\}\s*\n\s*\$\{this\._calDayVolHtml\(this\.rawDailyData\)\}/.test(src), '');
ok('⑥b ⛔ 沒有新增任何卡片 id', !/id="calDayVol/.test(src), '');

ok('⑦ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ CALVOL_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
