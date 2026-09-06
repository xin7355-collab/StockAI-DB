// 🧪 文件被截斷時的自我修復(V71.8.2)
// 使用者連續回報「SyntaxError: Unexpected EOF ・ 位置 ?source=pwa:1」,而且版本號顯示 V71.8.0
// → 證明不是舊快取沒更新。加尾端哨兵 __pageComplete 來分辨「文件少一截」vs「程式真的有 bug」。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import fs from 'fs';
import { pathToFileURL } from 'node:url';
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };

const SRC = '/home/user/StockAI-DB/index.html';
const full = fs.readFileSync(SRC, 'utf8');
// 兩種截斷都要能修:
//   A 尾巴斷(使用者的情境:App 功能正常、只跳紅框)→ 砍掉最後 0.15%
//   B 主程式就斷了(整個 App 死掉)→ 砍掉最後 30%
//     ⭐ B 正是為什麼自我修復**必須放在 <head> 的獨立 script**:放主程式裡的話,
//        主程式壞掉時它自己也活不了(第一版就是這樣,實測抓到)。
// A 的切點要精準落在「主 script 已結束、尾端 script 讀到一半」——
//   照比例砍(0.15%≈5KB)會切進主 script(尾巴其實只有 ~1.1KB),那就變成 B 了。
const _tailStart = full.lastIndexOf('</script>', full.lastIndexOf('</script>') - 1) + '</script>'.length;
fs.writeFileSync('/tmp/trunc.html', full.slice(0, _tailStart + 300));
fs.writeFileSync('/tmp/trunc_hard.html', full.slice(0, Math.floor(full.length * 0.70)));

async function run(file, { preLock = false } = {}) {
    const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu'] });
    const pg = await b.newPage();
    // ⚠️ Chromium 不讓你覆寫 location.reload → 真的會重整。改用「導覽次數」觀察,
    //    而快取清除紀錄要存進 sessionStorage(它能撐過重整),不能放 window 變數。
    let navs = 0;
    pg.on('framenavigated', f => { if (f === pg.mainFrame()) navs++; });
    await pg.addInitScript((lock) => {
        const noop = () => inst;
        const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
        Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
        window.__reloaded = 0;
        // 攔截 reload(headless 真的重整會讓斷言拿不到結果)
        try { Object.defineProperty(window.location, 'reload', { configurable: true, value: () => { window.__reloaded++; } }); } catch (_) {}
        // 假的 Cache Storage,記錄有沒有被清
        const _rec = k => { try { const a = JSON.parse(sessionStorage.getItem('__cdel') || '[]'); a.push(k); sessionStorage.setItem('__cdel', JSON.stringify(a)); } catch (_) {} };
        Object.defineProperty(window, 'caches', { configurable: true, value: {
            keys: async () => ['stockai-abc', 'stockai-def'],
            delete: async k => { _rec(k); return true; },
            open: async () => ({ put: async () => {}, match: async () => null, delete: async () => true }),
            match: async () => null,
        } });
        if (lock) { try { sessionStorage.setItem('_healTrunc', '1'); } catch (_) {} }
    }, preLock);
    await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts/i.test(u)) return r.continue(); return r.abort(); });
    await pg.goto(pathToFileURL(file).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pg.waitForTimeout(6000);
    const st = await pg.evaluate(() => ({
        complete: !!window.__pageComplete,
        reloaded: window.__reloaded,
        deleted: (() => { try { return JSON.parse(sessionStorage.getItem('__cdel') || '[]'); } catch (_) { return []; } })(),
        lock: (() => { try { return sessionStorage.getItem('_healTrunc'); } catch (_) { return null; } })(),
        warn: (document.body.innerText || '').includes('這一頁沒有載完整'),
        app: typeof app === 'object' && !!app,
    }));
    await b.close();
    return { ...st, navs };
}

// ① 完整檔:哨兵要亮,不可誤觸發修復
const okFull = await run(SRC);
ok('① 完整檔:哨兵有亮', okFull.complete, JSON.stringify(okFull));
ok('① 完整檔:不可清快取', okFull.deleted.length === 0, JSON.stringify(okFull.deleted));
ok('① 完整檔:不可重整(只有第一次導覽)', okFull.navs === 1, String(okFull.navs));
ok('① 完整檔:不可跳警告', !okFull.warn, '');
ok('① 完整檔:會把上次的鎖清掉(下次還能修)', okFull.lock === null, String(okFull.lock));

// ② 截斷檔(第一次):要清快取 + 重整一次
const t1 = await run('/tmp/trunc.html');
ok('② 截斷檔:哨兵沒亮(偵測得到)', !t1.complete, JSON.stringify({ c: t1.complete, app: t1.app }));
ok('② 截斷檔:App 主體仍在(斷在尾巴,正是使用者的情境)', t1.app, '');
ok('② 截斷檔:有清快取', t1.deleted.length === 2, JSON.stringify(t1.deleted));
ok('② 截斷檔:有重整一次(導覽 2 次)', t1.navs === 2, String(t1.navs));
ok('② 截斷檔:有上鎖(防無限重整)', t1.lock === '1', String(t1.lock));

// ③ 截斷檔(已修過一次):⛔ 不可再重整,改顯提示
const t2 = await run('/tmp/trunc.html', { preLock: true });
ok('③ 修過還是壞:⛔ 不可再重整(不然會無限迴圈)', t2.navs === 1, String(t2.navs));
ok('③ 修過還是壞:不再清快取', t2.deleted.length === 0, JSON.stringify(t2.deleted));
ok('③ 修過還是壞:改跳白話提示叫使用者關 App', t2.warn, '');

// ④ ⭐ 連主程式都斷掉時,自我修復仍要跑得起來(這就是它非得放 <head> 獨立 script 的原因)
const h1 = await run('/tmp/trunc_hard.html');
ok('④ 主程式已死(app 不存在)', !h1.app, String(h1.app));
ok('④ ⭐ 但自我修復照樣執行:有清快取', h1.deleted.length === 2, JSON.stringify(h1.deleted));
ok('④ ⭐ 而且有重整一次', h1.navs === 2, String(h1.navs));

console.log();
if (fails.length) { console.log('❌ SELFHEAL_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ SELFHEAL_TEST_PASS');
