// 👀 V80.1.2 自選清單只刷「畫面上看得到」的列(19 個專案評估 3-2)
//  ⓐ 40 檔自選、每列 300px 高 → 一輪只對看得到的那 3 列打即時報價(⛔ 舊寫法每輪打 10 檔,看不到的也打)
//  ⓑ 打的每一檔都是看得到的;間隔照看得到幾列算(_favVisN)
//  ⓒ ⭐ 決定性對照:同一份清單改成每列 10px 高(40 列都看得到)→ 一輪打滿 10 檔(每輪上限)
//  ⓓ 自選頁沒在顯示 / 沒開盤 → 一檔都不打
//  ⓔ 靜態:庫存頁 ⛔ 不套(總損益要每一檔的現價)—— refreshInventoryPrices 照舊全部刷
// 跑法:node scripts/test_favvisible.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) FAIL.push(n); };

const inv = (SRC.match(/async refreshInventoryPrices\(\) \{[\s\S]*?\n    \},/) || [''])[0];
ok('ⓔ 庫存頁照舊每一檔都刷(⛔ 不套只刷看得到的)', inv && /\(this\.inventory \|\| \[\]\)\.map/.test(inv) && !/_favVisibleSyms|getBoundingClientRect/.test(inv));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS|echarts|Cache\.put|file' is unsupported/i.test(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._favPollOnce, null, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
    const A = app;
    const syms = Array.from({ length: 40 }, (_, i) => String(1101 + i));
    A.favGroups = { T: syms }; A.activeGroupName = 'T';
    A.isMarketOpen = () => true; A._fugleKeyCount = () => 1; A._patchFavPrices = () => {}; A._applyFavPrice = () => {};
    const calls = [];
    A.fetchFugleData = async (sym) => { calls.push(sym); return { price: 100, prevClose: 99 }; };
    // 自選頁:蓋一個乾淨的版面(⛔ 不靠 Tailwind)
    const tab = document.getElementById('tabContentFav') || Object.assign(document.createElement('div'), { id: 'tabContentFav' });
    if (!tab.parentNode) document.body.appendChild(tab);
    document.querySelectorAll('[id^="tabContent"]').forEach(x => { x.style.display = 'none'; });
    tab.style.display = 'block'; tab.style.position = 'fixed'; tab.style.inset = '0'; tab.style.overflow = 'auto'; tab.style.zIndex = '99999'; tab.style.background = '#000';
    let box = document.getElementById('favListContainer');
    if (!box) { box = document.createElement('div'); box.id = 'favListContainer'; }
    tab.innerHTML = ''; tab.appendChild(box);
    const build = h => { box.innerHTML = syms.map(s => `<div data-fav-row="${s}" style="height:${h}px;display:block">${s}</div>`).join(''); tab.scrollTop = 0; };
    const run = async () => { calls.length = 0; A._favRRCursor = 0; await A._favPollOnce(); return { calls: [...calls], visN: A._favVisN, ms: A._favPollMs() }; };
    build(300);
    const vis300 = A._favVisibleSyms(syms, box);
    const a = await run();
    build(10);
    const c = await run();
    // ⓓ 自選頁沒顯示 / 沒開盤
    build(300); tab.style.display = 'none';
    const d1 = await run();
    tab.style.display = 'block'; A.isMarketOpen = () => false;
    const d2 = await run();
    return { vis300, a, c, d1: d1.calls.length, d2: d2.calls.length };
});
ok('ⓐ 每列 300px:一輪只對看得到的 3~4 列打即時報價(⛔ 不是 10 檔)', R.a.calls.length >= 2 && R.a.calls.length <= 4 && R.a.calls.length < 10, JSON.stringify(R.a));
ok('ⓑ 打的每一檔都是看得到的、間隔照看得到幾列算(3 列 × 1.1 秒 = 3.3 秒;全部 40 列會是 12 秒)', R.a.calls.every(s => R.vis300.includes(s)) && R.a.visN === R.vis300.length && R.a.ms === Math.min(12000, Math.max(1500, Math.ceil(R.vis300.length * 1100))) && R.a.ms < 12000, JSON.stringify({ vis: R.vis300, a: R.a }));
ok('ⓒ ⭐ 決定性對照:每列 10px(40 列都看得到)→ 打滿每輪上限 10 檔', R.c.calls.length === 10 && R.c.visN === 40, JSON.stringify(R.c));
ok('ⓓ 自選頁沒在顯示 / 沒開盤 → 一檔都不打', R.d1 === 0 && R.d2 === 0, JSON.stringify([R.d1, R.d2]));
ok('⓪ 沒有 pageerror', errs.length === 0, errs.slice(0, 2).join(' | '));
await browser.close();
console.log(FAIL.length ? `❌ ${FAIL.length} 條沒過` : '✅ 全部通過');
process.exit(FAIL.length ? 1 : 0);
