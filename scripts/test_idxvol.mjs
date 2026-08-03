// 🧪 指數的「量」改用成交金額(V71.8.4)—— 使用者:「k線部分有問題」
// 實測 data/^TWII.json:486 根裡最近 44 根 volume=0,但 amount(證交所官方成交值)486 根全有。
// → 量柱、量能判斷、六脈「量能」對指數全部失效。改成整條序列換成 amount(⛔ 不可只補缺的那幾根)。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import fs from 'fs';
import { pathToFileURL } from 'node:url';
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };
// 用**真的** gh-pages 上那份 ^TWII.json 當測資(沒有就從 git 撈)
import { execSync } from 'node:child_process';
const CACHE = '/tmp/twii_real.json';
if (!fs.existsSync(CACHE)) {
    execSync(`git -C /home/user/StockAI-DB show origin/gh-pages:data/^TWII.json > ${CACHE}`, { shell: '/bin/bash' });
}
const REAL = JSON.parse(fs.readFileSync(CACHE, 'utf8'));

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu'] });
const pg = await b.newPage();
await pg.addInitScript(() => {
  const noop = () => inst;
  const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
  Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|ERR_FAILED|ERR_ABORTED|CORS|Cross origin|vibrate|chromestatus|Access to fetch/i.test(t);
pg.on('pageerror', e => { const t = e && e.message ? e.message : String(e); if (!benign(t)) errs.push(t); });
await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts/i.test(u)) return r.continue(); return r.abort(); });
await pg.goto(pathToFileURL('/home/user/StockAI-DB/index.html').href, { waitUntil: 'domcontentloaded', timeout: 45000 });
await pg.waitForTimeout(2500);

const R = await pg.evaluate((real) => {
    const out = {};
    const run = (sym) => {
        app.currentSymbolId = sym;
        app.baseRawData = JSON.parse(JSON.stringify(real));
        app.applyLatestPrice(null, null);
        const v = app.rawDailyData.map(r => Number(r.volume) || 0);
        return {
            n: app.rawDailyData.length,
            zero: v.filter(x => !(x > 0)).length,
            volIsAmount: !!app._volIsAmount,
            last: v.slice(-3),
            six: app._sixMeridianCalc(app.rawDailyData),
        };
    };
    out.idx = run('^TWII');
    out.stock = run('2330');            // 同一份資料但當成個股 → ⛔ 不可換
    return out;
}, REAL);
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
const I = R.idx, S = R.stock;
console.log(`   指數: ${I.n} 根 ・零量 ${I.zero} 根 ・volIsAmount=${I.volIsAmount} ・最後3根量 ${JSON.stringify(I.last)}`);
console.log(`   個股: ${S.n} 根 ・零量 ${S.zero} 根 ・volIsAmount=${S.volIsAmount}`);
ok('① K線根數沒有被砍(幽靈棒守門仍有效)', I.n === 486, String(I.n));
ok('② 指數的量已改用成交金額,零量根數歸零', I.zero === 0, `還有 ${I.zero} 根零量`);
ok('② 有標記 _volIsAmount(顯示端才知道要叫「成交金額」)', I.volIsAmount === true, '');
ok('③ ⛔ 整條序列一次換完,不可只補缺的那幾根(否則兩種尺標)',
   I.last.every(v => v > 1e10), JSON.stringify(I.last));
ok('④ 六脈的「量能」不再是 na(算得出來了)',
   I.six.cond.find(c => c.k === '量能')?.na !== true, JSON.stringify(I.six.cond.find(c => c.k === '量能')));
ok('④ 六脈分母跟著變大(量能回來了)', I.six.applicable === 4, String(I.six.applicable));
ok('⑤ ⛔ 同一份資料當成個股時不可換(個股的 volume 是張數,不能被金額蓋掉)',
   S.volIsAmount === false && S.zero > 0, `volIsAmount=${S.volIsAmount} zero=${S.zero}`);

console.log();
if (fails.length) { console.log('❌ IDXVOL_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ IDXVOL_TEST_PASS');
