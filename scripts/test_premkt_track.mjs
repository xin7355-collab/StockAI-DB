// 🌅 V79.5.5 產業作戰室「早上那份準不準」(pro `_premktTrack` / `_premktTrackHtml` / `_renderPremktTrack`)
//   每天開盤前最後一輪採礦的盤前資料(data/premkt_log.json,macro_miner 寫)× 0050 真的開盤
//
// ⛔ 釘住(INJECT=1 注入四種壞寫法,每一種都要叫得出來):
//   ⓐ 跨檔:判準跟回測探針 scripts/premkt_app_probe.mjs 一字不差(分數 ≥3 / ≤−3、開反界線 0.3%)
//   ⓑ 每一天的結果 = 獨立算的答案(對 / 開反 / 開平 / 沒講 / 資料不夠 / 除息日 / 沒開盤 / 還沒有 K)
//   ⓒ ⭐ 決定性對照:改一天的開盤價 → 那一天從「對」變「開反」,統計跟著變
//   ⓓ 講話不到 20 天 → 寫「還在累積」、⛔ 不給百分比;滿 20 天才給(數字 = 獨立算的)
//   ⓔ ADR 比美股指數那天舊 → 那一項不算分(= 上面同一支 _premktScore)、表上寫出來
//   ⓕ 表:最多 10 列、預設日期新到舊、表頭可排序而且同一欄再點反向、⛔ 不用 🔴🟢
//   ⓖ 接線:專欄頁盤前那塊底下真的畫出來;沒有任何紀錄時誠實說「還沒有」;無 pageerror
//   ⓗ 🧊 V82.7.0 有凍結(out = 當天畫面)就用它、⛔ 重算:同一天美股全漲、畫面講開低 → 照畫面算對錯(決定性對照:拿掉 out → 回到重算)
//      當天畫面 / 重算分開統計、表上標出來;發生率校準跟「那天畫面印的」比(⛔ 跟今天的表比);
//      滿 20 天才跟回測比(Wilson 95% 範圍整個低於回測 → 「比回測差」);只看夜盤的對照、資料有缺 vs 齊、公式換版、⛔ 🔴🟢
// 跑法:node scripts/test_premkt_track.mjs ・INJECT=1 node scripts/test_premkt_track.mjs(注入必紅)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const PROBE = fs.readFileSync(path.join(ROOT, 'scripts/premkt_app_probe.mjs'), 'utf8');

const INJ = {
  band: ['_PREMKT_BAND: 0.3,', '_PREMKT_BAND: 0,'],
  exdiv: ["if (ex.has(e.d)) { o.why = '0050 除息日(跳空是除息不是行情)'; return o; }", ''],
  thresh: ["o.call = r.s >= 3 ? 'up' : r.s <= -3 ? 'dn' : 'mid';", "o.call = r.s >= 2 ? 'up' : r.s <= -3 ? 'dn' : 'mid';"],
  sort: ["this._premktTrackSort = S.k === k ? { k, dir: -S.dir } : { k, dir: -1 };", "this._premktTrackSort = { k, dir: -1 };"],
  fzIgnore: ["const F = (e.out && typeof e.out === 'object' && Number.isFinite(+e.out.s) && e.out.call) ? e.out : null;   // 🧊 當天畫面", 'const F = null;'],
  occNow: ['a.map(o => +o.occ[j] / 100)', "a.map(o => +this._PREMKT[k][c === 'flat' ? 'flat' : c] / 100)"],
  wilsonOff: ['const vs = !W ? \'\' : W.hi < P.hit ?', 'const vs = !W ? \'\' : W.lo > P.hit + 99 ?'],
};

// ── 合成資料 ──
const UP = { dji_chg_pct: 1, nasdaq_chg_pct: 1, sp500_chg_pct: 1, sox_chg_pct: 1, tsm_chg_pct: 1, vix: 18, sp500_date: '2026-10-21', tsm_date: '2026-10-21' };   // 7.5
const DN = { dji_chg_pct: -1, nasdaq_chg_pct: -1, sp500_chg_pct: -1, sox_chg_pct: -1, tsm_chg_pct: -1, vix: 26, sp500_date: '2026-10-21', tsm_date: '2026-10-21' };   // −7.5
const MID = { dji_chg_pct: 1, nasdaq_chg_pct: 1, sp500_chg_pct: 1, sox_chg_pct: -1, vix: 18 };   // 2.5(差一點就講開高)
const NA = { dji_chg_pct: 1, nasdaq_chg_pct: 1, sp500_chg_pct: 1 };                                // 只有 3 項
const STALE = { ...UP, tsm_date: '2026-10-20' };                                                   // 台積電 ADR 舊了 → 5.5
const days = [];
for (let t = Date.UTC(2026, 8, 28); t <= Date.UTC(2026, 9, 30); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
const OPEN = { '2026-10-01': 100.5, '2026-10-02': 99.5, '2026-10-05': 99.8, '2026-10-06': 99.4, '2026-10-07': 100.4, '2026-10-08': 100.2, '2026-10-09': 98, '2026-10-14': 100.6 };
const bars = days.filter(d => d !== '2026-10-13').map(d => ({ date: d.replace(/-/g, '/'), open: OPEN[d] || 100, high: 101, low: 99, close: 100, volume: 1 }));
const LOG = { rows: [
  { d: '2026-10-01', at: '08:12', x: UP },     // 對(+0.50%)
  { d: '2026-10-02', at: '08:10', x: UP },     // 開反(−0.50%)
  { d: '2026-10-05', at: '08:05', x: UP },     // 開平(−0.20%,方向錯但沒超過 0.3%)
  { d: '2026-10-06', at: '08:15', x: DN },     // 對(−0.60%)
  { d: '2026-10-07', at: '08:15', x: DN },     // 開反(+0.40%)
  { d: '2026-10-08', at: '08:15', x: MID },    // 沒講(+0.20%)
  { d: '2026-10-09', at: '08:15', x: UP },     // 除息日 → 不算
  { d: '2026-10-12', at: '08:15', x: NA },     // 資料不夠
  { d: '2026-10-13', at: '08:15', x: UP },     // 那天沒開盤(沒有 K)
  { d: '2026-10-14', at: '08:15', x: STALE },  // ADR 舊了一項、對(+0.60%)
  { d: '2026-11-02', at: '08:15', x: UP },     // 還沒有那天的 K
] };
const WANT = { '2026-10-01': 'hit', '2026-10-02': 'wrong', '2026-10-05': 'miss', '2026-10-06': 'hit', '2026-10-07': 'wrong', '2026-10-08': 'quiet',
               '2026-10-09': null, '2026-10-12': null, '2026-10-13': null, '2026-10-14': 'hit', '2026-11-02': null };
const WHY = { '2026-10-09': '除息', '2026-10-12': '沒給分', '2026-10-13': '沒開盤', '2026-11-02': '還沒有那天的 K' };
const DIV = { '0050': { h: [['2026-10-09', 1.0, '息']] } };

async function run(html) {
  const fails = [];
  const ok = (n, c, e = '') => { if (!process.env.QUIET) console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
  // ⓐ 跨檔
  const band = +(html.match(/_PREMKT_BAND: ([\d.]+),/) || [])[1], pband = +(PROBE.match(/const BAND = ([\d.]+);/) || [])[1];
  const pj = PROBE.slice(PROBE.indexOf('export function judge'), PROBE.indexOf('export function judge') + 600);
  ok('ⓐ 跨檔:開反界線 == 回測探針的 BAND,講開高 / 開低的門檻 s ≥3 / ≤−3 兩邊一樣',
     band === pband && /if \(s >= 3\)/.test(pj) && /else if \(s <= -3\)/.test(pj) && html.includes("o.call = r.s >= 3 ? 'up' : r.s <= -3 ? 'dn' : 'mid';"), JSON.stringify({ band, pband }));

  let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pmtrack-')), 'pro.html');
  fs.writeFileSync(tmp, html);
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await page.route('**/*', r => (r.request().url().startsWith('file://') && !/\/data\//.test(r.request().url()) ? r.continue() : r.abort()));
  await page.goto(pathToFileURL(tmp).href);
  await page.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._premktScore, null, { timeout: 30000 });

  // ⓑ 每一天
  const T = await page.evaluate(([log, b, div]) => PRO._premktTrack(log, b, div), [LOG, bars, DIV]);
  const byD = Object.fromEntries((T.rows || []).map(o => [o.d, o]));
  const bad = Object.keys(WANT).filter(d => !byD[d] || byD[d].res !== WANT[d] || (WHY[d] && !String(byD[d].why).includes(WHY[d])));
  ok('ⓑ 每一天的結果 = 獨立算的答案(對 / 開反 / 開平 / 沒講 / 資料不夠 / 除息日 / 沒開盤 / 還沒有 K)', T.n === 11 && !bad.length,
     JSON.stringify(bad.map(d => [d, byD[d] && byD[d].res, byD[d] && byD[d].why])));
  ok('ⓑ2 跳空用 0050 開盤 ÷ 前一天收盤(10/01 +0.50%、10/06 −0.60%)', Math.abs(byD['2026-10-01'].gap - 0.5) < 1e-9 && Math.abs(byD['2026-10-06'].gap + 0.6) < 1e-9, JSON.stringify([byD['2026-10-01'].gap, byD['2026-10-06'].gap]));
  const sA = T.sAll;
  ok('ⓑ3 全部:算得出結果的 7 天、講話 6 天、對 3、開反 2', sA.days === 7 && sA.call === 6 && sA.hit === 3 && sA.wrong === 2, JSON.stringify(sA));

  // ⓒ 決定性對照
  const bars2 = bars.map(x => x.date === '2026/10/01' ? { ...x, open: 99.5 } : x);
  const T2 = await page.evaluate(([log, b, div]) => PRO._premktTrack(log, b, div), [LOG, bars2, DIV]);
  const r2 = T2.rows.find(o => o.d === '2026-10-01');
  ok('ⓒ ⭐ 決定性對照:10/01 開盤改成 99.5 → 那一天變「開反」、全部對 3 → 2、開反 2 → 3', r2.res === 'wrong' && T2.sAll.hit === 2 && T2.sAll.wrong === 3, JSON.stringify([r2, T2.sAll]));

  // ⓓ 不到 20 天 vs 滿 20 天
  const h1 = await page.evaluate(T => PRO._premktTrackHtml(T), T);
  const txt1 = h1.replace(/<[^>]+>/g, '');
  ok('ⓓ 講話不到 20 天 → 「還在累積」、⛔ 不給百分比', /還在累積/.test(txt1) && !/方向猜對\s*\d/.test(txt1.split('📊')[0]), txt1.slice(0, 300));
  const big = { rows: [] }, bigBars = [];
  let t = Date.UTC(2026, 0, 5), k = 0;
  bigBars.push({ date: '2026/01/02', open: 100, close: 100 });
  while (big.rows.length < 30) { const d = new Date(t); t += 864e5; if (!(d.getUTCDay() % 6)) continue; const ds = d.toISOString().slice(0, 10);
    const open = k < 24 ? 100.5 : k < 27 ? 99.5 : 99.9; k++;   // 24 對、3 開反、3 開平
    bigBars.push({ date: ds.replace(/-/g, '/'), open, close: 100 }); big.rows.push({ d: ds, at: '08:10', x: UP }); }
  const TB = await page.evaluate(([log, b]) => PRO._premktTrack(log, b, null), [big, bigBars]);
  const hb = (await page.evaluate(T => PRO._premktTrackHtml(T), TB)).replace(/<[^>]+>/g, '');
  ok('ⓓ2 滿 20 天 → 方向猜對 80.0%、開反 10.0%(= 24 / 30、3 / 30)', TB.sAll.call === 30 && /方向猜對\s*80\.0%/.test(hb) && /開反\s*10\.0%/.test(hb) && !/還在累積/.test(hb.split('📊')[0]), hb.slice(0, 300));

  // ⓔ ADR 舊了
  const st = byD['2026-10-14'];
  const sFresh = await page.evaluate(x => PRO._premktScore(x).s, UP), sStale = await page.evaluate(x => PRO._premktScore(x).s, STALE);
  ok('ⓔ ADR 比美股指數那天舊 → 那一項不算分(7.5 → 5.5)、表上寫「ADR 舊了 1 項」', st.stale === 1 && sFresh === 7.5 && sStale === 5.5 && st.s === 5.5 && /ADR 舊了 1 項/.test(h1), JSON.stringify([st, sFresh, sStale]));

  // ⓕ 表
  await page.evaluate(h => { const d = document.createElement('div'); d.id = 'pmHost'; d.innerHTML = h; document.body.appendChild(d); }, h1);
  const rowsDefault = await page.$$eval('#pmHost [data-pmtrk-row]', els => els.map(e => e.getAttribute('data-pmtrk-row')));
  ok('ⓕ 最多 10 列、預設日期新到舊', rowsDefault.length === 10 && rowsDefault[0] === '2026-11-02' && rowsDefault[9] === '2026-10-02', JSON.stringify(rowsDefault));
  await page.evaluate(() => { PRO._premktTrackLast = PRO._premktTrack.__T || PRO._premktTrackLast; });
  await page.evaluate(T => { PRO._premktTrackLast = T; PRO._premktTrackSort = null; }, T);
  await page.evaluate(() => PRO.premktTrackSort('gap'));
  const gapOrder = await page.$$eval('#premktTrackBox [data-pmtrk-row]', els => els.map(e => e.getAttribute('data-pmtrk-row')));
  await page.evaluate(() => PRO.premktTrackSort('gap'));
  const gapOrder2 = await page.$$eval('#premktTrackBox [data-pmtrk-row]', els => els.map(e => e.getAttribute('data-pmtrk-row')));
  ok('ⓕ2 點「0050 開盤」→ 跳空大到小;同一欄再點 → 小到大(沒有跳空的排最後)',
     gapOrder[0] === '2026-10-14' && gapOrder2[0] === '2026-10-06' && gapOrder[gapOrder.length - 1] !== '2026-10-14' && gapOrder.slice(-4).every(d => ['2026-10-09', '2026-10-12', '2026-10-13', '2026-11-02'].includes(d)),
     JSON.stringify([gapOrder, gapOrder2]));
  ok('ⓕ3 ⛔ 不用 🔴🟢(對錯用 ✅⛔➖)', !/[🔴🟢]/u.test(h1) && /✅ 對/.test(h1) && /⛔ 開反/.test(h1), '');

  // ⓗ 🧊 當天畫面優先
  const OUTDN = { s: -4, sPct: 30, call: '開低偏空', k: 'lo', occ: [8.4, 36.6, 55], ver: 'aaaa1111', intra: [], stale: [], nt: -0.8, n: 9 };
  const LOGF = { rows: LOG.rows.map(r => r.d === '2026-10-01' ? { ...r, out: OUTDN } : r) };
  const TF = await page.evaluate(([log, b, div]) => PRO._premktTrack(log, b, div), [LOGF, bars, DIV]);
  const f1 = TF.rows.find(o => o.d === '2026-10-01');
  ok('ⓗ 有 out → 用當天畫面(美股全漲、畫面講開低 → 開盤 +0.50% = 開反),標 frozen',
     f1.src === 'frozen' && f1.call === 'dn' && f1.res === 'wrong' && f1.sPct === 30 && byD['2026-10-01'].res === 'hit' && byD['2026-10-01'].src === 'rescore', JSON.stringify([f1, byD['2026-10-01'].res]));
  ok('ⓗ2 當天畫面 / 重算分開統計(當天畫面 1 天講話、重算 5 天)', TF.sFz.call === 1 && TF.sRe.call === 5 && TF.sAll.call === 6 && TF.fzFirst === '2026-10-01', JSON.stringify([TF.sFz, TF.sRe]));
  // 表只列最後 10 天 → 用 10/02 那天當「當天畫面」(10/01 那天不在表上)
  const LOGF2 = { rows: LOG.rows.slice(1).map(r => r.d === '2026-10-02' ? { ...r, out: OUTDN } : r) };
  const hF = await page.evaluate(([log, b, div]) => PRO._premktTrackHtml(PRO._premktTrack(log, b, div)), [LOGF2, bars, DIV]);
  ok('ⓗ3 表上標「當天畫面」/「重算」;還不到 20 天 → 當天畫面那行寫「還在累積」', /10\/02[\s\S]{0,80}當天畫面/.test(hF.replace(/<[^>]+>/g, ' ')) && /・重算/.test(hF) && /當天畫面<\/b>[((]2026-10-02 起凍結[))][::]講話 <b>1<\/b> 天 → ⏳ 還在累積/.test(hF), hF.replace(/<[^>]+>/g, '').slice(0, 400));
  const hNone = (await page.evaluate(T => PRO._premktTrackHtml(T), T)).replace(/<[^>]+>/g, '');
  ok('ⓗ4 一天都還沒凍結 → 說明「從 V82.7.0 起凍結」、⛔ 假裝有成績', /V82\.7\.0 起每天早上/.test(hNone) && !/當天畫面(?!.*凍結)/.test(hNone.split('🧊')[0] || ''), hNone.slice(0, 300));
  // 滿 20 天:24 天講開高(10 對、14 開反)→ Wilson 上界 < 回測(V82.7.2 起 76.7)→ 比回測差;occ 用「那天畫面印的」(故意跟今天的表不一樣:開低 10%)
  const OUTUP = { s: 4, sPct: 70, call: '開高偏多', k: 'hi', occ: [40, 50, 10], ver: 'aaaa1111', intra: [], stale: [], nt: 0.5, n: 9 };
  const fzLog = { rows: [] }, fzBars = [{ date: '2026/01/02', open: 100, close: 100 }];
  let tt = Date.UTC(2026, 0, 5), kk = 0;
  while (fzLog.rows.length < 34) { const d = new Date(tt); tt += 864e5; if (!(d.getUTCDay() % 6)) continue; const ds = d.toISOString().slice(0, 10);
    const open = kk < 10 ? 100.5 : kk < 24 ? 99.5 : 99.9; const ver = kk < 17 ? 'aaaa1111' : 'bbbb2222'; kk++;   // 10 對、14 開反(= 開低 14 天)、10 開平
    fzBars.push({ date: ds.replace(/-/g, '/'), open, close: 100 }); fzLog.rows.push({ d: ds, at: '07:40', x: UP, out: { ...OUTUP, ver, intra: kk > 30 ? ['sp500'] : [] } }); }
  const TZ = await page.evaluate(([log, b]) => PRO._premktTrack(log, b, null), [fzLog, fzBars]);
  const hz = (await page.evaluate(T => PRO._premktTrackHtml(T), TZ)).replace(/<[^>]+>/g, '');
  const cH = TZ.fz.calib.hi;
  ok('ⓗ5 發生率校準跟「那天畫面印的」比:說開低 10%(⛔ 今天的表 4.2%)、真的開低 14/34', cH.n === 34 && Math.abs(cH.said - 10) < 1e-9 && Math.abs(cH.got - 14 / 34 * 100) < 1e-9 && cH.z > 2.5, JSON.stringify(cH));
  ok('ⓗ6 畫面寫出來:分數 65 以上 說開低 10.0% → 真的 41.2% ⚠️ 差太多', /分數 65 以上:畫面說開低 10\.0% → 真的 41\.2%[((]34 天[))] ⚠️ 差太多/.test(hz), hz.slice(0, 600));
  ok('ⓗ7 滿 20 天跟回測比:34 天講話、對 29.4% → Wilson 95% 範圍整個低於回測(V82.7.2 起 76.7%)→ ⚠️ 比回測差', TZ.sFz.call === 34 && /當天畫面[^\n]*講話 34 天 → 方向猜對 29\.4%[^\n]*⚠️ 比回測差/.test(hz), hz.slice(0, 600));
  // 對照組:同樣 34 天、對 26 天(76.5%)→ 跟回測差不多(⛔ 說比較差)
  const okLog = { rows: fzLog.rows }, okBars = fzBars.map((b, i) => i >= 1 && i <= 26 ? { ...b, open: 100.5 } : b);
  const TO = await page.evaluate(([log, b]) => PRO._premktTrack(log, b, null), [okLog, okBars]);
  const ho = (await page.evaluate(T => PRO._premktTrackHtml(T), TO)).replace(/<[^>]+>/g, '');
  const PH = await page.evaluate(() => PRO._PREMKT.hit);   // 回測那個數字只讀唯一來源(⛔ 寫死 —— V82.7.2 75.7 → 76.7 就是這條假紅)
  ok('ⓗ7b 決定性對照:同樣 34 天、對 26 天(76.5%)→ ✅ 跟回測差不多(⛔ 說比回測差)', TO.sFz.hit === 26 && new RegExp(`方向猜對 76\\.5%[^\\n]*✅ 跟回測 ${PH}% 差不多`).test(ho) && !/比回測差/.test(ho), ho.slice(0, 500));
  ok('ⓗ8 公式換過 1 次 → 列出換版日', /公式換過 1 次:2026-01-05 起 aaaa1111 → 2026-01-28 起 bbbb2222/.test(hz), (hz.match(/🧾[^\n]*/) || [''])[0]);
  ok('ⓗ9 只看夜盤的對照(同一批日子)、開盤之後(講開高那天平均)、資料有缺 vs 齊 都有一行', /只看夜盤/.test(hz) && /開盤之後[^\n]*講開高那天平均[^\n]*34 天/.test(hz) && /資料有缺的早上[^\n]*講話 4 天/.test(hz), hz.slice(300, 1400));
  ok('ⓗ10 ⛔ 🔴🟢', !/[🔴🟢]/u.test(hz));
  // ⓗ11 🇺🇸 V82.7.2 美國放假那天:凍結的 stale 有 sp500(美股四項 + 三檔 ADR 整組只列出來)→ 表上講美國放假、⛔ 再寫「ADR 舊了 3 項」;
  //      重算那條(沒有 out)看 _premktScore 的 usOld(台股上一個交易日 10/13、美股還是 10/09)
  const HOLX = { ...UP, taiex_date: '2026-10-13', fi_three_date: '2026-10-13', sp500_date: '2026-10-09', tsm_date: '2026-10-09', usdtwd_chg_pct: 0.2, fear_greed: 50, ust10y_chg_pct: 0.1 };
  const OUTHOL = { ...OUTDN, s: 0.5, sPct: 53, call: '中性震盪', k: 'mid', stale: ['asx', 'dji', 'nasdaq', 'sox', 'sp500', 'tsm', 'umc'] };
  const LOGH = { rows: LOG.rows.slice(1).map(r => r.d === '2026-10-14' ? { ...r, out: OUTHOL } : r.d === '2026-10-07' ? { ...r, x: HOLX } : r) };
  const TH = await page.evaluate(([log, b, div]) => PRO._premktTrack(log, b, div), [LOGH, bars, DIV]);
  const hH = (await page.evaluate(T => PRO._premktTrackHtml(T), TH));
  const rowH = d => { const m = hH.match(new RegExp(`data-pmtrk-row="${d}"[\\s\\S]*?</tr>`)); return m ? m[0].replace(/<[^>]+>/g, ' ') : ''; };
  const h14 = TH.rows.find(o => o.d === '2026-10-14'), h07 = TH.rows.find(o => o.d === '2026-10-07');
  ok('ⓗ11 🇺🇸 凍結的那天美國放假 → usOld、表上寫「美國放假:美股 / ADR 只列出來」、⛔「ADR 舊了」',
     h14.usOld === true && h14.stale === 0 && /美國放假/.test(rowH('2026-10-14')) && !/ADR 舊了/.test(rowH('2026-10-14')), JSON.stringify([h14.usOld, h14.stale, rowH('2026-10-14').slice(0, 200)]));
  ok('ⓗ11b 🇺🇸 重算那條也認得(美股 10/09 < 台股上一個交易日 10/13)→ 美股 / ADR 不算、只剩 VIX +1・台幣 −0.5 = 0.5;一般日子那天照常(⛔ 誤標)',
     h07.usOld === true && h07.s === 0.5 && /美國放假/.test(rowH('2026-10-07')) && TH.rows.filter(o => o.usOld).length === 2, JSON.stringify([h07.usOld, h07.s, TH.rows.filter(o => o.usOld).map(o => o.d)]));

  // ⓖ 接線
  const R = await page.evaluate(async ([log, b, div]) => {
    const host = document.getElementById('colPremkt');
    const real = PRO.fetchJson.bind(PRO);
    const mr = { ...{ dji_chg_pct: 0.5, nasdaq_chg_pct: 0.5, sp500_chg_pct: 0.5, sox_chg_pct: 0.5, tsm_chg_pct: 0.5, vix: 18 } };
    const fix = { 'data/macro_risk.json': mr, 'data/premkt_log.json': log, 'data/0050.json': b, 'data/dividends_hist.json': { d: div } };
    PRO.fetchJson = async p => (p in fix ? fix[p] : null);
    PRO._poliDiv = null;
    await PRO._renderColCal();
    const t1 = (document.getElementById('colPremktTrack') || {}).innerText || '';
    fix['data/premkt_log.json'] = null; PRO._poliDiv = null;
    await PRO._renderColCal();
    const t2 = (document.getElementById('colPremktTrack') || {}).innerText || '';
    PRO.fetchJson = real;
    return { has: !!host, t1, t2, rows: document.querySelectorAll('#colPremktTrack [data-pmtrk-row]').length };
  }, [LOG, bars, DIV]);
  ok('ⓖ 專欄頁盤前那塊底下畫出「早上那份準不準」', R.has && /早上那份準不準/.test(R.t1) && /2026-10-01 起全部/.test(R.t1), R.t1.slice(0, 200));
  ok('ⓖ2 沒有任何紀錄 → 誠實說「還沒有任何一天的紀錄」、⛔ 不畫空表', /還沒有任何一天的紀錄/.test(R.t2) && R.rows === 0, R.t2.slice(0, 200));
  ok('ⓖ3 無 pageerror', !errs.length, errs.join(' | '));
  await browser.close();
  return fails;
}

const fails = await run(SRC);
if (process.env.INJECT) {
  let allRed = true;
  for (const [nm, [a, b]] of Object.entries(INJ)) {
    if (!SRC.includes(a)) { console.log(`⚠️ 注入 ${nm}:找不到原句`); allRed = false; continue; }
    process.env.QUIET = '1';
    const f = await run(SRC.replace(a, b));
    delete process.env.QUIET;
    console.log(`${f.length ? '✅' : '❌'} 注入 ${nm} → ${f.length ? '紅(' + f.slice(0, 3).join(' / ') + ')' : '沒叫出來'}`);
    if (!f.length) allRed = false;
  }
  console.log(allRed ? `✅ ${Object.keys(INJ).length} 種注入全部叫得出來` : '❌ 有注入沒叫出來');
  if (!allRed) process.exit(1);
}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ PREMKT_TRACK_PASS');
process.exit(fails.length ? 1 : 0);
