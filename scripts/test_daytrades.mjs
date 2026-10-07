#!/usr/bin/env node
/**
 * 📼 V78.5.7 即時頁「逐筆成交」收錄當日全部
 *
 * 使用者:「目前只能看到 3 分鐘左右,改成完整買賣紀錄,當日買賣都收錄進來」。
 * 沙箱連不到富果 → 用假的 Fugle(fetch 替身)驗翻頁邏輯。
 * ⛔ 釘死:
 *   ① 往回翻頁抓到開盤:5,300 筆、不重複、最舊一筆是 09:00、標「✅ 全日」
 *   ② 每頁大小不寫死(伺服器只回 100 筆也能翻完)
 *   ③ 429 會等一下再試;額度用完要寫「只拿到 X 之後」(⛔ 不可假裝完整)
 *   ④ 第二次只補新的(碰到已有的就停,⛔ 不重抓整天)
 *   ⑤ 即時串流的一筆會出現在最上面
 *   ⑥ 換股清空;畫面一開始只畫 200 列、按「再顯示」才多
 * 注入:DAYT_SRC=<改過的 index.html> 必須紅。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.DAYT_SRC || path.join(ROOT, 'index.html');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails++; };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto('file://' + FILE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const o = {};
    // 假的一天:09:00:00 起每 2 秒一筆,共 N 筆(台北時間 2026-10-07),時間用富果的「微秒」
    const base = Date.parse('2026-10-07T09:00:00+08:00');
    const mk = n => Array.from({ length: n }, (_, i) => ({ time: (base + i * 2000) * 1000, price: 225 + (i % 3) * 0.5, size: (i % 97 === 0) ? 60 : 1 + (i % 5), bid: 225, ask: 225.5, serial: 100000 + i }));
    let DAY = mk(5300);
    let PAGE_CAP = 500, calls = 0, fail429 = 0, quotaAfter = Infinity;
    window.fetch = async (url) => {
        const u = String(url);
        if (!u.includes('/intraday/trades/')) return new Response('{}', { status: 404 });
        calls++;
        if (fail429 > 0) { fail429--; return new Response('{}', { status: 429 }); }
        if (calls > quotaAfter) return new Response('{}', { status: 429 });
        const q = new URL(u).searchParams;
        const lim = Math.min(+q.get('limit') || 50, PAGE_CAP), off = +q.get('offset') || 0;
        const newestFirst = DAY.slice().reverse();
        return new Response(JSON.stringify({ data: newestFirst.slice(off, off + lim) }), { status: 200 });
    };
    A._getFugleKeys = () => ['k1', 'k2'];
    try { await A.idb.del('ticks_5483'); await A.idb.del('ticks_2330'); } catch (_) {}
    const fresh = async () => { clearTimeout(A._dayTradesSaveT); A._dayTrades = null; try { await A.idb.del('ticks_5483'); } catch (_) {} };

    // ① 全日
    await fresh(); calls = 0;
    let D = await A._fetchFugleTradesDay('5483', { gapMs: 0, backoffMs: 5 });
    o.n1 = D.list.length; o.c1 = D.complete; o.calls1 = calls;
    o.uniq1 = new Set(D.list.map(r => r.s)).size;
    o.oldest1 = A._twHms(D.list[D.list.length - 1].t); o.newest1 = A._twHms(D.list[0].t);
    o.sorted1 = D.list.every((r, i) => i === 0 || D.list[i - 1].t >= r.t);

    // ② 伺服器每頁只回 100
    await fresh(); PAGE_CAP = 100;
    D = await A._fetchFugleTradesDay('5483', { gapMs: 0, backoffMs: 5 });
    o.n2 = D.list.length; o.c2 = D.complete; PAGE_CAP = 500;

    // ③ 429 一次會重試
    await fresh(); fail429 = 1;
    D = await A._fetchFugleTradesDay('5483', { gapMs: 0, backoffMs: 5 });
    o.n3 = D.list.length; o.c3 = D.complete;
    // ③b 額度用完(第 3 頁起都 429)
    await fresh(); calls = 0; quotaAfter = 2;
    D = await A._fetchFugleTradesDay('5483', { gapMs: 0, backoffMs: 1 });
    o.n3b = D.list.length; o.c3b = D.complete; o.stop3b = D.stop;
    quotaAfter = Infinity;
    // 畫面
    A.currentSymbolId = '5483'; A._liveTab = 'ticks';
    let body = document.getElementById('liveTabBody');
    if (!body) { body = document.createElement('div'); body.id = 'liveTabBody'; document.body.appendChild(body); }
    A._renderDayTicks();
    o.txt3b = body.innerText.replace(/\s+/g, ' ');

    // ④ 補齊後再來一次:只補新的
    await fresh();
    D = await A._fetchFugleTradesDay('5483', { gapMs: 0, backoffMs: 5 });
    DAY = DAY.concat(mk(5330).slice(5300));   // 新增 30 筆
    calls = 0;
    D = await A._fetchFugleTradesDay('5483', { gapMs: 0, backoffMs: 5 });
    o.n4 = D.list.length; o.calls4 = calls; o.c4 = D.complete;

    // ⑤ 即時串流一筆
    const wsT = (base + 5330 * 2000 + 500) * 1000;
    A._dayTradesPush('5483', { symbol: '5483', time: wsT, price: 226, size: 7, bid: 225.5, ask: 226, serial: 999999 });
    o.top5 = D.list[0].s; o.n5 = D.list.length;
    // 重複推同一筆不會多
    A._dayTradesPush('5483', { symbol: '5483', time: wsT, price: 226, size: 7, bid: 225.5, ask: 226, serial: 999999 });
    o.n5b = D.list.length;

    // ⑥ 畫面:摘要 + 只畫 200 列 + 再顯示
    A._dayTicksSym = null;
    A._renderDayTicks();
    o.txt6 = body.innerText.replace(/\s+/g, ' ');
    o.rows6 = body.querySelectorAll('[data-tickrow]').length;
    A._dayTicksMore();
    o.rows6b = body.querySelectorAll('[data-tickrow]').length;
    A._dayTicksFilter(true);
    o.rows6c = body.querySelectorAll('[data-tickrow]').length;
    o.bigN = D.list.filter(r => r.v >= 50).length;

    // ⑥b 換股清空
    A._dayTradesFor('2330');
    A.currentSymbolId = '2330';
    A._renderDayTicks();
    o.txt6b = body.innerText.replace(/\s+/g, ' ');
    o.sym6b = A._dayTrades.sym; o.n6b = A._dayTrades.list.length;

    // ⑦ IndexedDB 存得進去、讀得回來
    A.currentSymbolId = '5483';
    await fresh();
    D = await A._fetchFugleTradesDay('5483', { gapMs: 0, backoffMs: 5 });
    await sleep(1800);
    const c = await A.idb.get('ticks_5483');
    o.idbN = c && c.rows ? c.rows.length : 0; o.idbTs = !!(c && c.ts);
    clearTimeout(A._dayTradesSaveT); A._dayTrades = null;   // ⛔ 這裡不刪 IDB:要驗讀回來
    const D7 = await A._dayTradesLoad('5483');
    o.n7 = D7.list.length; o.c7 = D7.complete;
    try { await A.idb.del('ticks_5483'); } catch (_) {}
    return o;
});
await browser.close();

ok('① 翻頁抓完全日 5,300 筆', R.n1 === 5300, R.n1);
ok('①b 不重複、新到舊排好', R.uniq1 === 5300 && R.sorted1, `${R.uniq1} ${R.sorted1}`);
ok('①c 最舊一筆是 09:00:00(抓到開盤)、標成全日', R.oldest1 === '09:00:00' && R.c1 === true, `${R.oldest1} ${R.c1}`);
ok('①d 用 500 筆一頁,11~12 次請求(⛔ 不是 53 次)', R.calls1 <= 12, R.calls1);
ok('② ⭐ 伺服器每頁只回 100 也能翻完(每頁大小不寫死)', R.n2 === 5300 && R.c2, `${R.n2} ${R.c2}`);
ok('③ 429 一次會等一下再試,仍拿到全日', R.n3 === 5300 && R.c3, `${R.n3} ${R.c3}`);
ok('③b 額度用完:⛔ 不標全日、記下原因', R.n3b === 1000 && R.c3b === false && R.stop3b === 'quota', `${R.n3b} ${R.c3b} ${R.stop3b}`);
ok('③c 畫面寫「額度用完,只拿到 X 之後」(⛔ 不可假裝完整)', /額度用完/.test(R.txt3b) && /只拿到/.test(R.txt3b) && !/✅ 全日/.test(R.txt3b), R.txt3b.slice(0, 200));
ok('④ 第二次只補新的(1 次請求、多 30 筆)', R.n4 === 5330 && R.calls4 === 1 && R.c4, `${R.n4} calls=${R.calls4}`);
ok('⑤ 即時串流的一筆出現在最上面', R.top5 === 999999 && R.n5 === 5331, `${R.top5} ${R.n5}`);
ok('⑤b 同一筆推兩次不會算兩次', R.n5b === 5331, R.n5b);
ok('⑥ 摘要寫出時間區間、筆數、全日', /09:00:00/.test(R.txt6) && /5,331/.test(R.txt6) && /✅ 全日/.test(R.txt6), R.txt6.slice(0, 220));
ok('⑥b 一開始只畫 200 列,按「再顯示」才多 500', R.rows6 === 200 && R.rows6b === 700, `${R.rows6} → ${R.rows6b}`);
ok('⑥c 篩大單只剩 ≥50 張那幾筆', R.rows6c === Math.min(200, R.bigN) && R.bigN > 0, `${R.rows6c} / ${R.bigN}`);
ok('⑥d 換股清空(⛔ 不顯示上一檔的成交)', R.sym6b === '2330' && R.n6b === 0 && !/5,331/.test(R.txt6b), R.txt6b.slice(0, 120));
ok('⑦ 存進手機(IndexedDB,帶時間戳讓 7 天清理會清)', R.idbN === 5330 && R.idbTs, `${R.idbN} ts=${R.idbTs}`);
ok('⑦b 關掉再開讀得回來(不用整天重抓)', R.n7 === 5330 && R.c7 === true, `${R.n7} ${R.c7}`);
ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ DAYTRADES_PASS(全部通過)');
process.exit(fails ? 1 : 0);
