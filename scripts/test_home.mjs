// 🏠 V79.8.0 產業作戰室「🏠 今天」—— ⛔ 一個新算法都沒有,每一格只轉述別頁本來就有的那一支
//   ⛔ 這支釘的用意:
//     ① 每一格的數字 == 被呼叫的那一支算出來的(換來源資料 → 🏠 跟著變)
//     ② ⭐ 決定性對照:把被呼叫的函式換掉,🏠 也跟著變 = 證明是轉述,⛔ 自己另算一份
//     ③ 🏠 的函式裡⛔ 自己排序、⛔ 直接讀 _ROT / _PROFIT_BOARD / LAB(那是第二份真相)
//     ④ 讀不到要說「讀不到」,⛔ 長得像「今天沒有」(陷阱 #22)
//     ⑤ 「100 萬同一天起跑」🏠 與 📒 成績單共用同一次計算(⛔ 算兩次)
//     ⑥ 開頁⛔ 讀 index.html(2.8MB);390 / 844 不橫捲;無 pageerror
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [], reqs = [];
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', e => errs.push(e.message));
page.on('request', r => reqs.push(r.url()));
await page.addInitScript(() => { try { localStorage.setItem('proTerminalInv', JSON.stringify([{ symbol: '2330' }])); localStorage.setItem('proTerminalFavGroups', '{}'); } catch (_) {} });
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof PRO !== 'undefined' && PRO._tab, null, { timeout: 30000 });
await page.waitForTimeout(4000);
ok('⑥ 開頁⛔ 讀 index.html(🏠 的每一格都不需要它)', !reqs.some(u => /\/index\.html/.test(u)), reqs.filter(u => /index\.html/.test(u)).join(' '));

const R = await page.evaluate(async () => {
  const o = {};
  const T = id => (document.getElementById(id) || {}).innerText || '';
  o.tab = PRO._tab;
  // ── ③ 靜態:🏠 的函式只轉述 ──
  const srcOf = f => String(PRO[f] || '');
  o.src = { home: srcOf('renderHome'), conf: srcOf('_homeConf'), rot: srcOf('_homeRot'), race: srcOf('_homeRace') };
  o.alertSrc = srcOf('_confAlertHtml'); o.pickBarSrc = srcOf('_rotPickBar') + srcOf('rotPickTop'); o.rotVerdictSrc = srcOf('_rotVerdict'); o.raceRenderSrc = srcOf('_raceRender');
  // ── 🌅 開盤前:= _renderColCal(_premktHtml)──
  const mr1 = { nasdaq_chg_pct: 1.2, sp500_chg_pct: 0.8, sox_chg_pct: 2.1, tsm_chg_pct: 1.5, vix_chg_pct: -3.0, nikkei_chg_pct: 0.9, kospi_chg_pct: 1.1, usdtwd_chg_pct: -0.2 };
  PRO._cache['data/macro_risk.json'] = mr1; await PRO._renderColCal();
  o.pre1 = document.getElementById('colPremkt').textContent; o.s1 = PRO._premktScore(mr1).sPct;
  o.preInHome = !!document.querySelector('#tabHome #colPremkt') && !!document.querySelector('#tabHome #sigDiv') && !!document.querySelector('#tabHome #colPremktTrack');
  const mr2 = { ...mr1, nasdaq_chg_pct: -2.5, sp500_chg_pct: -2.0, sox_chg_pct: -3.5, tsm_chg_pct: -3.0 };
  PRO._cache['data/macro_risk.json'] = mr2; await PRO._renderColCal();
  o.pre2 = document.getElementById('colPremkt').textContent; o.s2 = PRO._premktScore(mr2).sPct;
  // ── 📞 你清單上的法說會:= _confMineRows ──
  const today = PRO._confToday(), add = n => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  PRO._cache['data/playbook_edge.json'] = { picks: [] };
  PRO._confEnsP = null;
  PRO._confData = { data_date: today, upcoming: [{ s: '2330', d: add(3), t: '財報' }, { s: '9999', d: add(2), t: '財報' }, { s: '2330', d: add(40), t: '太遠' }], recent: [] };
  PRO._confRad = null; PRO._radC = null;
  await PRO._homeConf();
  o.conf1 = T('homeConf'); o.confRows = [...document.querySelectorAll('#homeConf [data-home-conf-row]')].map(e => e.dataset.homeConfRow);
  o.mine = PRO._confMineRows(14); o.mine = { mine: o.mine.mine, hits: o.mine.hits.map(r => r.s + '@' + r.d) };
  o.radNo = (document.querySelector('#homeRad [data-home-rad]') || {}).dataset?.homeRad || ''; o.radNoTxt = T('homeRad');
  // ② 決定性對照:把 _confMineRows 換掉 → 🏠 跟著變
  { const keep = PRO._confMineRows; PRO._confMineRows = () => ({ mine: 3, hits: [{ s: '2603', d: add(7), t: 'x' }], today, dd: () => 7 });
    await PRO._homeConf(); o.confStub = T('homeConf'); o.confStubRows = [...document.querySelectorAll('#homeConf [data-home-conf-row]')].map(e => e.dataset.homeConfRow);
    PRO._confMineRows = () => null; await PRO._homeConf(); o.confNoFile = T('homeConf');
    PRO._confMineRows = () => ({ mine: 0, hits: [], today, dd: () => 0 }); await PRO._homeConf(); o.confEmpty = T('homeConf');
    PRO._confMineRows = keep; }
  // 🛰️ 主題雷達:= _radarCalc + _confHotHtml
  { const keep = PRO._radarCalc;
    PRO._radarCalc = () => ({ upN: 7, qs: ['2026Q2'], li: 0, part: false, rows: [{ t: 'CPO', up: true, pp: 3.2 }, { t: '矽光子', up: true, pp: 1.5 }, { t: '機器人', up: false, pp: 0.2 }] });
    await PRO._homeConf(); o.rad = T('homeRad'); o.radN = (document.querySelector('#homeRad [data-home-rad]') || {}).dataset?.homeRad || '';
    o.radChips = [...document.querySelectorAll('#homeRad [data-conf-hot]')].map(e => e.dataset.confHot);
    o.radChipGo = (document.querySelector('#homeRad [data-conf-hot]') || { getAttribute: () => '' }).getAttribute('onclick');
    PRO._radarCalc = keep; }
  // ── 🏭 板塊:= _rotRankAt + _rotVerdictHtml(官方產業)──
  const codes = Object.keys(PRO.IND_NAME).slice(0, 6);
  const J = { days: ['2026-10-20', '2026-10-21'], ind: {} };
  codes.forEach((c, i) => { J.ind[c] = { r20: [0, [5, -3, 2, -1, 8, -6][i]], n: 10 }; });
  PRO._cache['data/sector_rot.json'] = J;
  await PRO._homeRot();
  o.rot = T('homeRot'); o.rotList = PRO._rotRankAt(1, PRO._rotSetOf('ind', J)).map(x => PRO.IND_NAME[x.c]);
  { const keep = PRO._rotRankAt; PRO._rotRankAt = (k, G) => keep.call(PRO, k, G).reverse();
    await PRO._homeRot(); o.rotRev = T('homeRot'); PRO._rotRankAt = keep; }
  { const keep = PRO.fetchJson; PRO.fetchJson = async p => (p === 'data/sector_rot.json' ? null : keep.call(PRO, p));
    await PRO._homeRot(); o.rotNo = T('homeRot'); o.rotNoTag = (document.querySelector('#homeRot [data-home-rot]') || {}).dataset?.homeRot || ''; PRO.fetchJson = keep; }
  // ── 📒 你的策略今天:= _raceEnsure(🏠 與成績單共用同一次計算)──
  PRO._recoReset();
  let calls = 0;
  const keepL = PRO._raceLoad;
  PRO._raceLoad = async () => { calls++; return { S: '2026-10-22', days: 3, rows: [
      { k: 'park', name: '🅿️ 測試停車', v: 1012345, pnl: 12345, vs50: 5000, cur: true },
      { k: 'hot', name: '🔥 測試', v: 990000, pnl: -10000, vs50: -17345 },
      { k: '0050', name: '📏 0050 測試', v: 1007345, pnl: 7345 } ],
    lastList: ['2026-10-23', [{ s: '2330', trig: 1234.5 }, { s: '2317', trig: 0 }]] }; };
  await PRO._homeRace();
  o.race = T('homeRace');
  o.raceRows = [...document.querySelectorAll('#homeRace [data-home-race-row]')].map(e => e.dataset.homeRaceRow);
  o.raceVals = [...document.querySelectorAll('#homeRace [data-home-race-v]')].map(e => e.dataset.homeRaceV);
  // 成績單那一頁(#recoRace 是 _recoLedgerRender 第一次才建的)→ 切過去讓它自己畫,⛔ 再算一次
  PRO.navGo('fish'); await new Promise(r => setTimeout(r, 1500));
  o.recoRace = (document.getElementById('recoRace') || {}).textContent || '';
  o.same = (await PRO._raceEnsure()) === PRO._race;
  o.calls = calls;
  PRO.navGo('home');
  PRO._raceLoad = async () => ({ S: '2026-10-22', days: 0, rows: [] }); PRO._recoReset(); await PRO._homeRace(); o.raceWait = T('homeRace');
  PRO._raceLoad = async () => { throw new Error('測試爆掉'); }; PRO._recoReset(); await PRO._homeRace(); o.raceErr = T('homeRace');
  PRO._raceLoad = keepL;
  window.scrollTo(80, 0); o.sx = window.scrollX;
  return o;
});

ok('① 開頁停在 🏠', R.tab === 'home', R.tab);
const noOwn = s => !/\.sort\(/.test(s) && !/_ROT\.|_PROFIT_BOARD|\bLAB\./.test(s);
ok('③ 🏠 的四支函式⛔ 自己排序、⛔ 直接讀 _ROT / _PROFIT_BOARD / LAB', Object.values(R.src).every(noOwn), JSON.stringify(Object.fromEntries(Object.entries(R.src).map(([k, s]) => [k, noOwn(s)]))));
ok('③b 每一格都呼叫既有那一支(_renderColCal / _confMineRows / _confHotHtml / _rotRankAt / _rotVerdictHtml / _raceEnsure)',
  /_renderColCal\(/.test(R.src.home) && /_confMineRows\(/.test(R.src.conf) && /_confHotHtml\(/.test(R.src.conf) && /_radarCalc\(/.test(R.src.conf)
  && /_rotRankAt\(/.test(R.src.rot) && /_rotVerdictHtml\(/.test(R.src.rot) && /_raceEnsure\(/.test(R.src.race));
ok('③c 共用那幾支真的被原本的地方用著(🔔 提醒 / 勾選列與前 8 強 / 板塊頁那三行 / 成績單起跑)⛔ 各寫一份',
  /_confMineRows\(/.test(R.alertSrc) && (R.pickBarSrc.match(/_rotRankAt\(/g) || []).length >= 2 && /_rotVerdictHtml\(/.test(R.rotVerdictSrc) && /_raceEnsure\(/.test(R.raceRenderSrc));
ok('① 🌅 開盤前那塊住在 🏠(id 照舊:colPremkt / colPremktTrack / sigDiv)', R.preInHome);
ok('①b 🌅 分數 == _premktScore(換資料 → 跟著變)', R.pre1.includes(`盤前分數:${R.s1}`) && R.pre2.includes(`盤前分數:${R.s2}`) && R.s1 !== R.s2, `${R.s1} / ${R.s2} | ${R.pre1.slice(0, 60)}`);
ok('① 📞 你清單上的法說會 == _confMineRows(只列清單裡的、14 天內、照日期)', JSON.stringify(R.confRows) === JSON.stringify(R.mine.hits.map(h => h.split('@')[0])) && JSON.stringify(R.confRows) === '["2330"]' && /還有 3 天/.test(R.conf1), JSON.stringify([R.confRows, R.mine, R.conf1.slice(0, 120)]));
ok('② 決定性對照:_confMineRows 換掉 → 🏠 跟著變', JSON.stringify(R.confStubRows) === '["2603"]' && /還有 7 天/.test(R.confStub), R.confStub.slice(0, 120));
ok('④ 法說會讀不到 → 說「讀不到」⛔ 長得像「沒有法說會」;清單空 → 說清單是空的', /讀不到/.test(R.confNoFile) && /不代表/.test(R.confNoFile) && /是空的/.test(R.confEmpty), JSON.stringify([R.confNoFile.slice(0, 60), R.confEmpty.slice(0, 60)]));
ok('④b 雷達讀不到 → 說「讀不到 / 還沒產出」⛔ 長得像「沒有題材」', R.radNo === 'nofile' && /讀不到|還沒產出/.test(R.radNoTxt) && /不是沒有/.test(R.radNoTxt), R.radNoTxt.slice(0, 80));
ok('① 🛰️ 雷達 == _radarCalc(數量 / 只列變多的 / 點了先切到法說會頁)', R.radN === '7' && JSON.stringify(R.radChips) === '["CPO","矽光子"]' && /_homeConfGo/.test(R.radChipGo || ''), JSON.stringify([R.radN, R.radChips, R.radChipGo]));
const top3 = R.rotList.slice(0, 3), bot3 = R.rotList.slice(-3);
ok('① 🏭 板塊最強 / 最弱 == _rotRankAt(官方產業、近 20 日)', top3.every(n => R.rot.includes(n)) && R.rot.indexOf(top3[0]) < R.rot.indexOf('最弱') && bot3.every(n => R.rot.includes(n)), JSON.stringify([top3, bot3, R.rot.slice(0, 160)]));
ok('② 決定性對照:_rotRankAt 倒過來 → 🏠「最強」第一個變成原本最弱的', R.rotRev.indexOf(R.rotList[R.rotList.length - 1]) > -1 && R.rotRev.indexOf(R.rotList[R.rotList.length - 1]) < R.rotRev.indexOf('最弱'), R.rotRev.slice(0, 160));
ok('④c 板塊檔讀不到 → 說「讀不到」⛔ 長得像「今天沒有輪動」', R.rotNoTag === 'nofile' && /不是今天沒有輪動/.test(R.rotNo), R.rotNo.slice(0, 80));
ok('① 📒 你的策略今天 == 起跑那份(每一套一列、金額照抄、你現在用的標出來)', JSON.stringify(R.raceRows) === '["park","hot","0050"]' && JSON.stringify(R.raceVals) === '["1012345","990000","1007345"]' && /你現在用的/.test(R.race) && /1,012,345 元/.test(R.race), JSON.stringify([R.raceRows, R.raceVals]));
ok('①c 明天要看的 = 最後一晚的名單(有觸發價寫觸發價、沒有寫「沒有觸發價」)', /觸發價 1234\.5/.test(R.race) && /沒有觸發價/.test(R.race), R.race.slice(-160));
ok('⑤ 🏠 與 📒 成績單共用同一次計算(_raceLoad 只跑 1 次,成績單直接畫同一份)', R.calls === 1 && R.same && /1,012,345 元/.test(R.recoRace), `${R.calls} ${R.same} | ${R.recoRace.slice(0, 120)}`);
ok('④d 起跑還沒收盤 / 算爆了 → 誠實講(⛔ 不是 0 元)', /還沒有收盤資料/.test(R.raceWait) && /不是 0 元/.test(R.raceErr), JSON.stringify([R.raceWait.slice(0, 50), R.raceErr.slice(0, 50)]));
ok('⑥b 390 寬不橫捲', R.sx <= 2, R.sx);
await page.close();
{ const p2 = await browser.newPage({ viewport: { width: 844, height: 390 } }); p2.on('pageerror', e => errs.push(e.message));
  await p2.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(() => typeof PRO !== 'undefined' && PRO._tab, null, { timeout: 30000 });
  await p2.waitForTimeout(3000);
  const sx = await p2.evaluate(() => { window.scrollTo(80, 0); return window.scrollX; });
  ok('⑥c 844×390 不橫捲', sx <= 2, sx); await p2.close(); }
ok('⑥d 無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_home 全過');
process.exit(fails.length ? 1 : 0);
