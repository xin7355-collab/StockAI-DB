// 🏠 V77.9.9 帶回家養(使用者:「新增帶回家養的功能,其實是匯出到散戶 app 裡面新增魚池,還有裡面數值」)
//   ⛔ 這支釘的用意:
//     ① 同一個瀏覽器:有 fishHome_v1 → 散戶救星自選頁自動出現「🎣 魚池」群組,每列有「釣起日 / 釣起價 → 現價 / % / 一張賺賠」
//     ② ⭐ 賺賠用全 App 唯一那份 _netPL(⛔ 不自己算一份)—— 決定性對照:把 _netPL 換掉,畫面數字要跟著變
//     ③ 讀不到同步資料時:貼匯入碼也能建池;亂貼 ⛔ 不可建出假魚
//     ④ ⛔ 不碰庫存;每一筆只搬一次(你從群組刪掉就不會自己跑回來)
//     ⑤ ⛔ 散戶救星沒有任何連去股海釣手的連結
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.addInitScript(() => {
  if (sessionStorage.getItem('fh_seeded')) return; sessionStorage.setItem('fh_seeded', '1');
  localStorage.setItem('fishHome_v1', JSON.stringify([{ sym: '2330', px: 1000, d: '2026-09-29' }]));
  localStorage.setItem('proTerminalInventory', JSON.stringify([]));
});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && app._fishHomeSync && app.renderFavList, null, { timeout: 60000 });

const R = await page.evaluate(async () => {
  const o = {};
  const inv0 = JSON.stringify(app.inventory || []);
  app._liveQuote = sym => (sym === '2330' ? { p: 1100, c: 2 } : null);
  app.fetchHistoricalData = async () => null; app.fetchFugleData = async () => null;
  app.activeGroupName = app._FISH_POND;
  await app.renderFavList(); await new Promise(r => setTimeout(r, 300));
  o.groups = Object.keys(app.favGroups);
  o.pond = (app.favGroups[app._FISH_POND] || []).slice();
  const row = document.querySelector('[data-fav-row="2330"] [data-fav-fish]');
  o.row = row ? row.innerText : '';
  o.bar = !!document.querySelector('#favListContainer button[onclick*="fishHomeImport"]');
  o.pl = app._netPL(1000, 1100, 1000);
  // ② 決定性對照:換掉 _netPL,畫面跟著變
  const saved = app._netPL; app._netPL = () => 4321;
  o.rowSwap = app._fishRowTxt('2330', 1100); app._netPL = saved;
  // ④ 刪掉之後不會自己跑回來
  app.favGroups[app._FISH_POND] = app.favGroups[app._FISH_POND].filter(s => s !== '2330');
  o.again = app._fishHomeSync(); o.pondAfterDel = app.favGroups[app._FISH_POND].slice();
  // ③ 匯入碼
  const code = 'SJFISH1.' + btoa(unescape(encodeURIComponent(JSON.stringify([['2317', 150.5, '2026-09-30'], ['bad!', 1, 'x']]))));
  o.imp = app.fishHomeImport('複製的文字 ' + code + ' 結尾');
  o.pondAfterImp = app.favGroups[app._FISH_POND].slice();
  o.home = JSON.parse(localStorage.getItem('fishHome_v1'));
  o.junk = app.fishHomeImport('亂貼的東西');
  o.inv = JSON.stringify(app.inventory || []) === inv0;
  return o;
});
ok(R.groups.includes('🎣 魚池') && R.pond.includes('2330'), '① 有 fishHome_v1 → 自選多一個「🎣 魚池」群組', JSON.stringify(R));
ok(/09\/29 釣起 1000/.test(R.row) && /1100/.test(R.row) && /\+10\.0%/.test(R.row) && R.row.includes(R.pl.toLocaleString() + ' 元'),
  '① 每列有 釣起日 / 釣起價 → 現價 / % / 一張賺賠', JSON.stringify([R.row, R.pl]));
ok(R.bar, '③ 魚池群組有「📥 貼上匯入碼」');
ok(/4,321 元/.test(R.rowSwap) && !/4,321/.test(R.row), '② ⭐ 賺賠讀 _netPL(換掉它畫面跟著變)', R.rowSwap);
ok(R.again === 0 && !R.pondAfterDel.includes('2330'), '④ 你從魚池刪掉的魚⛔ 不會自己跑回來', JSON.stringify(R));
ok(R.imp === 1 && R.pondAfterImp.includes('2317') && R.home.some(h => h.sym === '2317' && h.px === 150.5) && !R.home.some(h => h.sym === 'bad!'),
  '③ 貼匯入碼 → 建進魚池(壞的那筆⛔ 不收)', JSON.stringify(R));
ok(R.junk === 0, '③ 亂貼 ⛔ 不會建出假魚');
ok(R.inv, '④ ⛔ 庫存一筆都沒動');
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok(!/app=fish/.test(IDX) && !/pro\.html\?app/.test(IDX), '⑤ 散戶救星沒有任何連去股海釣手的連結');
ok(!errs.length, '無 pageerror', errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ FISHHOME_PASS');
process.exit(fails.length ? 1 : 0);
