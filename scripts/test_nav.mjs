// 🧭 V79.8.0 產業作戰室導覽:五大類 + 子頁(使用者 10/25:「版面可以重新設計,很多我還是覺得不好用」→ 選「5 大類 + 🏠 今天首頁」)
//   ⛔ 這支釘的用意:
//     ① 開頁先到 🏠 今天(時效性的東西在那);大類一排、子頁一排,登記表 = PRO.NAV(⛔ 再平鋪按鈕)
//     ② 每個子頁都進得去、只顯示一頁、大類 / 子頁的「目前在哪」看得出來;只有一頁的大類⛔ 不顯示子頁那排
//     ③ 舊書籤 / 深連結 / 別頁按鈕照樣進得來(calc / pick / noise 別名、?noise=1 / ?log=1 / ?tab=)
//     ④ 左右滑只在同一大類裡(⛔ 滑進沒有按鈕的釣魚頁);股海釣手模式不滑
//     ⑤ 固定的那條很矮(手機直立:有子頁 ≤ 96px、只有一頁 ≤ 60px;橫拿 / 桌機 ≤ 60px);--hdr = 那條的高度
//     ⑥ 每個大類記得上次看的子頁;下拉重整對 🏠 / 更新紀錄 / 雜訊清單有作用
//     ⑦ 每一頁 390 / 844 寬都不橫捲、無 pageerror
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

ok('⓪ ⛔ 雜訊清單不再是自己一個分頁(容器 / 按鈕都拿掉了,內容在實測總表「沒用」最下面)', !/id="tabNoise"/.test(SRC) && !/id="tabBtnNoise"/.test(SRC) && /id="labNoiseWrap"/.test(SRC));

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const open = async (w, h, q = '', init) => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', e => errs.push(`${w}x${h}${q}: ${e.message}`));
  if (init) await page.addInitScript(init);
  await page.goto('file://' + path.join(ROOT, 'pro.html') + q, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof PRO !== 'undefined' && PRO._tab, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  return page;
};

// ① ~ ⑥(手機直立)
{
  const page = await open(390, 844);
  const R = await page.evaluate(async () => {
    const o = {};
    const vis = () => PRO.TABS.filter(([k, C]) => !document.getElementById('tab' + C).classList.contains('hidden')).map(([k]) => k);
    const gOn = () => [...document.querySelectorAll('#navTop [data-g]')].filter(b => b.classList.contains('on')).map(b => b.dataset.g);
    const sOn = () => [...document.querySelectorAll('#navSub [data-sub]')].filter(b => b.classList.contains('on')).map(b => b.dataset.sub);
    const sShown = () => [...document.querySelectorAll('#navSub [data-sub]')].filter(b => !b.classList.contains('hidden')).map(b => b.dataset.sub);
    const subRow = () => !document.getElementById('navSub').classList.contains('hidden');
    const barH = () => Math.round(document.querySelector('.topbar').getBoundingClientRect().height);
    o.start = { tab: PRO._tab, vis: vis(), g: gOn(), subRow: subRow() };
    o.nav = PRO.NAV.map(g => [g[0], g[2].slice()]);
    o.topBtns = [...document.querySelectorAll('#navTop [data-g]')].map(b => b.dataset.g);
    o.subBtns = [...document.querySelectorAll('#navSub [data-sub]')].map(b => b.id + ':' + b.dataset.g + ':' + b.dataset.sub);
    o.tabsKeys = PRO.TABS.map(x => x[0]);
    // ② 每個子頁
    o.pages = [];
    for (const [g, subs] of PRO.NAV.map(x => [x[0], x[2]])) for (const s of subs) {
      PRO.navGo(s); await new Promise(r => setTimeout(r, 120));
      window.scrollTo(80, 0);
      o.pages.push({ s, g, cur: PRO._navCur(), vis: vis(), gOn: gOn(), sOn: sOn(), shown: sShown(), subRow: subRow(), h: barH(),
        hdr: parseInt(getComputedStyle(document.documentElement).getPropertyValue('--hdr')) || 0, sx: window.scrollX });
    }
    // ③ 別名
    PRO.switchTab('calc'); o.calc = { tab: PRO._tab, sel: PRO._labSel, cur: PRO._navCur() };
    PRO.switchTab('pick'); o.pick = { tab: PRO._tab, sel: PRO._labSel, cur: PRO._navCur(), hd: document.getElementById('labHdT').textContent, sOn: sOn() };
    PRO.switchTab('noise'); await new Promise(r => setTimeout(r, 50));
    { const nw = document.getElementById('labNoiseWrap'); o.noise = { tab: PRO._tab, sel: PRO._labSel, wrapShown: !nw.classList.contains('hidden'), open: nw.open, sOn: sOn() }; }
    PRO.navGo('lab'); o.labFromPick = PRO._labSel;      // 從選哪一套按「實測總表」要換到結論那一層(⛔ 停在 pick = 按了沒反應)
    PRO.selLab('bt'); { const nw = document.getElementById('labNoiseWrap'); o.noiseOnlyTrap = nw.classList.contains('hidden'); }
    PRO.switchTab('bogus'); o.bogus = PRO._tab;
    // ④ 滑動
    PRO.navGo('rot'); o.swRot = PRO._swipeKeys();
    PRO.navGo('home'); o.swHome = PRO._swipeKeys();
    PRO.navGo('pick'); o.swPick = PRO._swipeKeys();
    o.rodInNav = PRO.NAV.some(g => g[2].includes('rod'));
    PRO._appFish = true; o.swFish = PRO._swipeKeys(); PRO._appFish = false;
    // ⑥ 記住子頁
    PRO.navGo('star'); PRO.switchGroup('res'); o.resBack = PRO._navCur(); PRO.switchGroup('ind'); o.indBack = PRO._navCur();
    try { o.navLast = JSON.parse(localStorage.getItem('proWar_navLast') || '{}'); } catch (_) { o.navLast = null; }
    // ⑥b 下拉重整:🏠 / 更新紀錄 / 雜訊清單都有作用(把要呼叫的函式換成記錄器)
    const spy = {}; const keep = {};
    for (const f of ['renderHome', 'renderLog', 'renderNoise', '_recoReset', '_confReset']) { keep[f] = PRO[f]; PRO[f] = function () { spy[f] = (spy[f] || 0) + 1; return Promise.resolve(); }; }
    PRO.navGo('home'); for (const k in spy) delete spy[k]; await PRO.hardRefresh(); o.prHome = { ...spy };
    PRO.navGo('log'); for (const k in spy) delete spy[k]; await PRO.hardRefresh(); o.prLog = { ...spy };
    PRO.switchTab('noise'); document.getElementById('labNoiseWrap').open = true; for (const k in spy) delete spy[k]; await PRO.hardRefresh(); o.prNoise = { ...spy };
    for (const f in keep) PRO[f] = keep[f];
    return o;
  });
  ok('① 開頁先到 🏠 今天、大類「🏠 今天」亮、⛔ 沒有子頁那排', R.start.tab === 'home' && JSON.stringify(R.start.vis) === '["home"]' && JSON.stringify(R.start.g) === '["home"]' && !R.start.subRow, JSON.stringify(R.start));
  ok('①b 五個大類(🏠 / 🏭 / 📞 / 📒 / 🔬)、按鈕跟登記表一致', JSON.stringify(R.topBtns) === '["home","ind","conf","reco","res"]' && JSON.stringify(R.nav.map(x => x[0])) === JSON.stringify(R.topBtns), JSON.stringify(R.nav));
  { const subs = R.nav.flatMap(x => x[1]); const tabK = R.tabsKeys.filter(k => k !== 'rod');
    ok('①c 每個分頁(⛔ 釣魚除外)都在剛好一個大類裡;選哪一套(pick)是實測總表的別名', tabK.every(k => subs.filter(s => s === k).length === 1) && subs.includes('pick') && !subs.includes('rod') && !subs.includes('noise'), JSON.stringify(subs) + ' vs ' + JSON.stringify(tabK)); }
  ok('①d 子頁按鈕 id 照舊(tabBtnXxx),data-g 對到所屬大類', R.subBtns.every(x => { const [id, g, s] = x.split(':'); const G = R.nav.find(n => n[1].includes(s)); return G && G[0] === g && /^tabBtn[A-Z]/.test(id); }) && R.subBtns.some(x => x.startsWith('tabBtnConf:')) && R.subBtns.some(x => x.startsWith('tabBtnFish:')) && R.subBtns.some(x => x.startsWith('tabBtnPoli:')), JSON.stringify(R.subBtns));
  const P = R.pages, multi = new Set(R.nav.filter(x => x[1].length > 1).map(x => x[0]));
  const badPg = P.filter(p => p.cur !== p.s || p.vis.length !== 1 || p.vis[0] !== (p.s === 'pick' ? 'lab' : p.s) || JSON.stringify(p.gOn) !== JSON.stringify([p.g]));
  ok('② 每個子頁都進得去、畫面上只顯示那一頁、所屬大類亮', !badPg.length, JSON.stringify(badPg.slice(0, 3)));
  const badSub = P.filter(p => p.subRow !== multi.has(p.g) || (multi.has(p.g) && (JSON.stringify(p.sOn) !== JSON.stringify([p.s]) || JSON.stringify(p.shown) !== JSON.stringify(R.nav.find(n => n[0] === p.g)[1]))));
  ok('②b 有好幾頁的大類才顯示子頁那排、只列那一類的子頁、目前那頁亮', !badSub.length, JSON.stringify(badSub.slice(0, 3)));
  const badH = P.filter(p => p.h > (multi.has(p.g) ? 96 : 60));
  ok('⑤ 📱 手機直立:固定那條 有子頁 ≤ 96px、只有一頁 ≤ 60px(以前 192px)', !badH.length, JSON.stringify(P.map(p => p.s + ':' + p.h)));
  const badHdr = P.filter(p => Math.abs(p.hdr - p.h) > 1);
  ok('⑤b --hdr 跟著固定那條的高度(子頁那排出現 / 消失都要重量)', !badHdr.length, JSON.stringify(badHdr.map(p => `${p.s}:${p.hdr}/${p.h}`)));
  ok('⑦ 390 寬每一頁都不橫捲', P.every(p => p.sx <= 2), JSON.stringify(P.filter(p => p.sx > 2).map(p => p.s + ':' + p.sx)));
  ok('③ 舊入口 switchTab(\'calc\') → 實測總表的回測數字', R.calc.tab === 'lab' && R.calc.sel === 'bt' && R.calc.cur === 'lab', JSON.stringify(R.calc));
  ok('③b switchTab(\'pick\') → 🏆 選哪一套(標題換、子頁那顆亮)', R.pick.tab === 'lab' && R.pick.sel === 'pick' && R.pick.cur === 'pick' && R.pick.hd === '🏆 選哪一套' && JSON.stringify(R.pick.sOn) === '["pick"]', JSON.stringify(R.pick));
  ok('③c switchTab(\'noise\') → 實測總表「沒用」+ 雜訊清單那段打開', R.noise.tab === 'lab' && R.noise.sel === 'trap' && R.noise.wrapShown && R.noise.open && JSON.stringify(R.noise.sOn) === '["lab"]', JSON.stringify(R.noise));
  ok('③d 從選哪一套按「🔬 實測總表」→ 換到結論那一層(⛔ 停在選哪一套)', R.labFromPick !== 'pick', R.labFromPick);
  ok('③e 雜訊清單只在「沒用」那一頁出現', R.noiseOnlyTrap);
  ok('③f 不認得的分頁代號 → 🏠 今天(⛔ 整頁空白)', R.bogus === 'home', R.bogus);
  ok('④ 左右滑只在同一大類裡(產業那類四頁;只有一頁的大類不滑)', JSON.stringify(R.swRot) === '["rot","chain","star","val"]' && JSON.stringify(R.swHome) === '["home"]' && JSON.stringify(R.swPick) === '["pick","col","lab","log"]', JSON.stringify([R.swRot, R.swHome, R.swPick]));
  ok('④b 釣魚頁(rod)不在任何大類 → 滑不進去;股海釣手模式不滑', !R.rodInNav && JSON.stringify(R.swFish) === '[]', JSON.stringify([R.rodInNav, R.swFish]));
  ok('⑥ 每個大類記得上次看的子頁(產業 → 關聯星圖 → 研究 → 回到產業還是關聯星圖)', R.indBack === 'star' && R.navLast && R.navLast.ind === 'star', JSON.stringify([R.resBack, R.indBack, R.navLast]));
  ok('⑥b 下拉重整:🏠 會重算(成績單 / 法說會先丟掉再重畫)', R.prHome.renderHome === 1 && R.prHome._recoReset >= 1 && R.prHome._confReset >= 1, JSON.stringify(R.prHome));
  ok('⑥c 下拉重整:更新紀錄 / 打開的雜訊清單會重讀', R.prLog.renderLog === 1 && R.prNoise.renderNoise === 1, JSON.stringify([R.prLog, R.prNoise]));
  await page.close();
}
// ⑤ 橫拿 / 桌機:合成一排
for (const [w, h] of [[844, 390], [1280, 800]]) {
  const page = await open(w, h);
  const R = await page.evaluate(async () => {
    const out = [];
    for (const s of ['home', 'rot', 'conf', 'fish', 'lab']) { PRO.navGo(s); await new Promise(r => setTimeout(r, 120)); window.scrollTo(80, 0);
      out.push({ s, h: Math.round(document.querySelector('.topbar').getBoundingClientRect().height), sx: window.scrollX }); }
    return out;
  });
  ok(`⑤c ${w}×${h}:固定那條 ≤ 60px(大類與子頁同一排)、不橫捲`, R.every(p => p.h <= 60 && p.sx <= 2), JSON.stringify(R));
  await page.close();
}
// ③ 深連結
for (const [q, want] of [['?noise=1', 'lab|trap|open'], ['?log=1', 'log'], ['?tab=rot', 'rot'], ['?tab=pick', 'lab|pick'], ['?tab=zzz', 'home']]) {
  const page = await open(390, 844, q);
  const got = await page.evaluate(() => { const nw = document.getElementById('labNoiseWrap'); return PRO._tab === 'lab' ? `lab|${PRO._labSel}${PRO._labSel === 'trap' && nw && nw.open ? '|open' : ''}` : PRO._tab; });
  ok(`③g 深連結 ${q} → ${want}`, got === want, got);
  await page.close();
}
// ① 從散戶救星按返回回來(30 分鐘內)→ 回到上次那一頁(⛔ 被「先到 🏠」蓋掉)
{
  const page = await open(390, 844, '', () => { try { sessionStorage.setItem('proWar_nav', JSON.stringify({ tab: 'chain', y: 0, at: Date.now() })); } catch (_) {} });
  const got = await page.evaluate(() => PRO._tab);
  ok('①e 從散戶救星回來 → 回到上次那一頁(sessionStorage,30 分鐘內)', got === 'chain', got);
  await page.close();
}
ok('⑦b 無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_nav 全過');
process.exit(fails.length ? 1 : 0);
