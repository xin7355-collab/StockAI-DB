#!/usr/bin/env node
/**
 * 📡 V82.7.0 產業作戰室「反攻條件雷達準不準」(pro `_radarTrack` / `_radarTrackHtml` / `_renderRadarTrack`)
 *   資料 = data/premkt_log.json 每一列的 radar(macro_cron 早上凍結的 App 燈號)× 加權(^TWII)之後真的怎麼走
 *  ① 同一級連續的日子算「一段」(⛔ 逐日算):bear×4 → base×3 → bear×3 = 3 段(bear 2 段、base 1 段)
 *  ② 基準 = 那一段第一天的「前一天」收盤(⭐ 決定性對照:第一天那根收盤故意跳 +10%,用當天收盤算出來會差很多)
 *  ③ 20 / 60 天後漲跌、60 天內最深回檔、60 天內收盤比基準再低 5% 以上 = 獨立算的答案;還沒滿 60 天 → 彙總不收
 *  ④ 每一級 < 5 段 → ⏳ 累積中(⛔ 給數字);滿 5 段才給、而且數字 = 獨立算的
 *  ⑤ 條件健康檢查:滿 40 天才看;照「名字」對(條件換版順序會變):一直亮 / 一半以上沒資料 → 標出來
 *  ⑥ 畫面:⛔ 🔴🟢;四種燈號字樣跟 App 一樣;390px 不溢出
 *  ⑦ 接線:專欄頁盤前那塊底下畫出來;沒有紀錄 → 誠實說還沒有、⛔ 抓 ^TWII;雷達那塊壞了 ⛔ 拖垮除權息行事曆
 *  INJECT=1:逐日算 / 用當天收盤 / 健康檢查照位置對 / 還沒滿 60 天也收進彙總 —— 四種都要紅
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const INJ = {
  perDay: ['if (L && L.lvl === x.lvl) { L.to = x.d; L.days++; continue; }', 'if (false) { continue; }'],
  sameDay: ['if (bars[m].d < d) { k = m; lo = m + 1; }', 'if (bars[m].d <= d) { k = m; lo = m + 1; }'],
  healthPos: ['h = H[nm] || (H[nm] = { nm, n: 0, on: 0, off: 0, na: 0 });', 'h = H[j] || (H[j] = { nm, n: 0, on: 0, off: 0, na: 0 });'],
  partial: ['a60 = fs.filter(f => f && f.full)', 'a60 = fs.filter(f => f && f.dn5 != null)'],
};

// ── 合成資料:120 個交易日的加權 ──
const days = [];
for (let t = Date.UTC(2026, 5, 1); days.length < 120; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
const C = days.map((_, i) => 100 + i * 0.5);       // 平常每天 +0.5
C[10] = 110;                                        // ② 第一段第一天(d10)那根故意跳到 110(基準要用 d9 的 104.5)
C[40] = 90;                                         // ③ 一次深回檔(d9 / d13 / d16 起算的 60 天內都碰到)
C[110] = 80;                                        // ③b 最後那段(d99 起算)還沒滿 60 天就先跌破 5% → 彙總照樣 ⛔ 收
const TW = days.map((d, i) => ({ date: d.replace(/-/g, '/'), open: C[i], high: C[i], low: C[i], close: C[i] }));
const NM = '美股止穩|台幣止貶|韓股翻紅|外資期貨回補|油價不走極端|站回 5 日線|價差翻正|量能站回 1 兆|台指 VIX 退燒|機構停止倒貨|融資斷頭宣洩';
const R = (lvl, passN, lit = '11110000000', nm = NM) => ({ ver: 'r0000001', lvl, passN, judged: 11, need: 9, lit, nm, swan: 0 });
const LOG = { rows: [
  ...[10, 11, 12, 13].map(i => ({ d: days[i], at: '07:40', x: {}, radar: R('bear', 4) })),
  ...[14, 15, 16].map(i => ({ d: days[i], at: '07:40', x: {}, radar: R('base', 6, '11111100000') })),
  ...[17, 18, 19].map(i => ({ d: days[i], at: '07:40', x: {}, radar: R('bear', 5, '11111000000') })),
  ...[100, 101].map(i => ({ d: days[i], at: '07:40', x: {}, radar: R('formed', 9, '11111111100') })),   // 還沒滿 60 天
  { d: days[102], at: '07:40', x: {}, radar: { na: 'App 那張卡藏起來' } },                               // na 不算
  { d: days[103], at: '07:40', x: {} },                                                                     // 舊列沒有 radar
] };
const pct = (a, b) => (a / b - 1) * 100;
const minIn = (i, n = 60) => Math.min(...C.slice(i + 1, Math.min(C.length, i + n + 1)));

async function run(html) {
  const fails = [];
  const ok = (n, c, e = '') => { if (!process.env.QUIET) console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
  let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rdtrack-')), 'pro.html');
  fs.writeFileSync(tmp, html);
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await page.route('**/*', r => (r.request().url().startsWith('file://') && !/\/data\//.test(r.request().url()) ? r.continue() : r.abort()));
  await page.goto(pathToFileURL(tmp).href);
  await page.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._radarTrack, null, { timeout: 30000 });

  const T = await page.evaluate(([l, t]) => PRO._radarTrack(l, t), [LOG, TW]);
  // ① 一段一段
  ok('① 同一級連續的日子算一段:bear 2 段(7 天)、base 1 段(3 天)、formed 1 段;na / 沒有 radar 的列不算', T.n === 12 && T.runs.length === 4 && T.byLvl.bear.n === 2 && T.dayCnt.bear === 7
     && T.byLvl.base.n === 1 && T.dayCnt.base === 3 && T.byLvl.formed.n === 1, JSON.stringify({ n: T.n, runs: T.runs.map(r => [r.lvl, r.from, r.days]) }));
  ok('①b 現在 = 最後一天那一級、同一級連續幾天', T.last && T.last.lvl === 'formed' && T.streak === 2, JSON.stringify([T.last && T.last.lvl, T.streak]));
  // ② 基準 = 前一天收盤
  const r0 = T.runs[0].f, want20 = pct(C[29], C[9]);
  ok(`② ⭐ 基準 = 第一天的「前一天」收盤(d9 = 104.5,⛔ d10 那根 110):20 天後 = ${want20.toFixed(2)}%`,
     r0.base === C[9] && Math.abs(r0.r20 - want20) < 1e-9 && Math.abs(r0.r20 - pct(C[30], C[10])) > 1, JSON.stringify(r0));
  // ③ 數字 = 獨立算的
  const want60 = pct(C[69], C[9]), wantDd = pct(minIn(9), C[9]);
  ok(`③ 60 天後 ${want60.toFixed(2)}%、最深回檔 ${wantDd.toFixed(2)}%、再跌 5% 以上 = 是`, Math.abs(r0.r60 - want60) < 1e-9 && Math.abs(r0.dd60 - wantDd) < 1e-9 && r0.dn5 === true && r0.full, JSON.stringify(r0));
  const rF = T.runs[3].f;
  ok('③b 還沒滿 60 天(最後那段,已經先跌破 5%)→ 那一段標「已經跌破」、但彙總 ⛔ 收(偏向跌);20 天的照算', rF && rF.r20 != null && rF.r60 === null && rF.dd60 === null && rF.full === false && rF.dn5 === true
     && T.byLvl.formed.n60 === 0 && T.byLvl.formed.dn5 === null && T.byLvl.formed.n20 === 1, JSON.stringify([rF, T.byLvl.formed]));
  const bearR60 = (pct(C[69], C[9]) + pct(C[76], C[16])) / 2;
  ok('③c 彙總 = 每一段平均(bear:兩段 60 天後的平均)', Math.abs(T.byLvl.bear.r60 - bearR60) < 1e-9 && T.byLvl.bear.dn5 === 100, JSON.stringify(T.byLvl.bear));
  const i0 = 9, i1 = 100; let s20 = 0, n20 = 0; for (let i = i0; i <= i1; i++) if (i + 20 < C.length) { s20 += pct(C[i + 20], C[i]); n20++; }
  ok('③d 對照 = 同一段期間每一個交易日(從加權現算)', T.baseN === i1 - i0 + 1 && T.base.n20 === n20 && Math.abs(T.base.r20 - s20 / n20) < 1e-9, JSON.stringify([T.baseN, T.base.n20, T.base.r20, s20 / n20]));

  // ④ 不到 5 段 vs 滿 5 段
  const h1 = await page.evaluate(T => PRO._radarTrackHtml(T), T);
  const t1 = h1.replace(/<[^>]+>/g, '');
  ok('④ 每一級 < 5 段 → ⏳ 累積中、⛔ 給 20 天後的數字', /⛔ 空方主控:7 天 ・2 段 → ⏳ 累積中/.test(t1) && !/空方主控[^\n]*20 天後平均/.test(t1), t1.slice(0, 500));
  const alt = { rows: [] };
  for (let i = 10; i < 22; i++) alt.rows.push({ d: days[i], at: '07:40', x: {}, radar: R(i % 2 ? 'bear' : 'base', i % 2 ? 4 : 6) });
  const TA = await page.evaluate(([l, t]) => PRO._radarTrack(l, t), [alt, TW]);
  const hA = (await page.evaluate(T => PRO._radarTrackHtml(T), TA)).replace(/<[^>]+>/g, '');
  const bearRuns = [11, 13, 15, 17, 19, 21].map(i => i - 1), w20 = bearRuns.reduce((s, i) => s + pct(C[i + 20], C[i]), 0) / bearRuns.length;
  ok(`④b 滿 5 段(bear 6 段)→ 給 20 天後平均 ${w20 >= 0 ? '+' : ''}${w20.toFixed(1)}%(= 獨立算的)`, TA.byLvl.bear.n === 6 && new RegExp(`空方主控:6 天 ・6 段 → 20 天後平均 \\+${w20.toFixed(1)}%`).test(hA), hA.slice(0, 600));

  // ⑤ 健康檢查
  ok('⑤ 不到 40 天 → 「滿 40 天才看」、⛔ 下結論', T.health === null && T.hN === 12 && /滿 40 天才看[((]目前 12 天[))]/.test(t1), (t1.match(/🩺[^\n]*/) || [''])[0]);
  const NM2 = NM.split('|'), sw = [NM2[1], NM2[0], ...NM2.slice(2)].join('|');   // 換版:前兩條對調
  const hl = { rows: [] };
  for (let i = 0; i < 45; i++) {
    const lit = NM2.map((n, j) => j === 0 ? '1' : j === 1 ? (i < 30 ? 'x' : '0') : (i + j) % 2 ? '1' : '0');
    const swapped = i >= 25;   // 後 20 天條件順序換了(名字跟著換)
    const L = swapped ? [lit[1], lit[0], ...lit.slice(2)].join('') : lit.join('');
    hl.rows.push({ d: days[i], at: '07:40', x: {}, radar: R('bear', 4, L, swapped ? sw : NM) });
  }
  const TH = await page.evaluate(([l, t]) => PRO._radarTrack(l, t), [hl, TW]);
  const flags = Object.fromEntries((TH.health || []).filter(h => h.flag).map(h => [h.nm, h.flag]));
  ok('⑤b 滿 40 天:照名字對(條件順序換過也一樣)→「美股止穩」一直亮、「台幣止貶」一半以上沒資料,其他正常',
     TH.hN === 45 && flags['美股止穩'] === 'on' && flags['台幣止貶'] === 'na' && Object.keys(flags).length === 2, JSON.stringify(flags));
  const hH = (await page.evaluate(T => PRO._radarTrackHtml(T), TH)).replace(/<[^>]+>/g, '');
  ok('⑤c 畫面寫出來:哪一條、為什麼(⚠️ 從頭到尾都亮 / ⏳ 一半以上沒資料)', /美股止穩 ⚠️ 從頭到尾都亮/.test(hH) && /台幣止貶 ⏳ 一半以上沒資料/.test(hH), (hH.match(/🩺[^\n]*/) || [''])[0]);

  // ⑥ 畫面
  const LBL = { formed: '反攻條件成形', base: '打底觀察中', bear: '空方主控', swan: '外面壓力很大' };
  const lv = await page.evaluate(() => PRO._RADAR_LV);
  ok('⑥ 四種燈號字樣跟 App 一樣(✅ 成形 / ⚠️ 打底 / ⛔ 空方主控 / 🚨 外面壓力很大)', Object.entries(LBL).every(([k, t]) => lv[k] && lv[k].endsWith(t) && IDX.includes(`heroTxt = '${t}'`))
     && lv.formed.startsWith('✅') && lv.base.startsWith('⚠️') && lv.bear.startsWith('⛔') && lv.swan.startsWith('🚨'), JSON.stringify(lv));
  ok('⑥b ⛔ 🔴🟢', !/[🔴🟢]/u.test(h1 + hH));
  const W = await page.evaluate(h => {
    const box = document.createElement('div'); box.style.cssText = 'width:358px;position:absolute;left:16px;top:0'; box.innerHTML = h; document.body.appendChild(box);
    box.querySelectorAll('details').forEach(d => { d.open = true; });
    const R0 = box.getBoundingClientRect(); let worst = 0;
    const walk = n => { for (const c of n.childNodes) { let r = null;
      if (c.nodeType === 1) r = c.getBoundingClientRect(); else if (c.nodeType === 3 && c.textContent.trim()) { const g = document.createRange(); g.selectNodeContents(c); r = g.getBoundingClientRect(); }
      if (r && r.width) worst = Math.max(worst, r.right - R0.right); if (c.nodeType === 1) walk(c); } };
    walk(box); const w = R0.width; box.remove(); return { worst, w };
  }, h1);
  ok('⑥c 390px:358px 寬的容器裡沒有任何字或元素超出右邊', W.w >= 350 && W.worst <= 1, JSON.stringify(W));

  // ⑦ 接線
  const X = await page.evaluate(async ([l, t]) => {
    const real = PRO.fetchJson.bind(PRO), realDiv = PRO._renderDivCal.bind(PRO), realRT = PRO._radarTrack;
    const asked = [];
    const fix = { 'data/macro_risk.json': {}, 'data/premkt_log.json': l, 'data/0050.json': [], 'data/dividends_hist.json': { d: {} }, 'data/^TWII.json': t };
    PRO.fetchJson = async p => { asked.push(p); return p in fix ? fix[p] : null; };
    let divCalled = 0; PRO._renderDivCal = async () => { divCalled++; };
    PRO._poliDiv = null;
    await PRO._renderColCal();
    const t1 = (document.getElementById('colRadarTrack') || {}).innerText || '';
    asked.length = 0; fix['data/premkt_log.json'] = { rows: [{ d: '2026-10-01', at: '07:40', x: {} }] }; PRO._poliDiv = null;
    await PRO._renderColCal();
    const t2 = (document.getElementById('colRadarTrack') || {}).innerText || '', twii2 = asked.includes('data/^TWII.json');
    PRO._radarTrack = () => { throw new Error('boom'); };
    const d0 = divCalled; fix['data/premkt_log.json'] = l;
    await PRO._renderColCal();
    const t3 = (document.getElementById('colRadarTrack') || {}).innerText || '', div3 = divCalled > d0;
    PRO._radarTrack = realRT; PRO.fetchJson = real; PRO._renderDivCal = realDiv;
    return { t1, t2, twii2, t3, div3 };
  }, [LOG, TW]);
  ok('⑦ 專欄頁盤前那塊底下畫出「反攻條件雷達準不準」', /反攻條件雷達準不準/.test(X.t1) && /共 12 天/.test(X.t1), X.t1.slice(0, 200));
  ok('⑦b 沒有任何雷達紀錄 → 「還沒有任何一天的紀錄」、⛔ 抓加權(176KB)', /還沒有任何一天的紀錄/.test(X.t2) && !X.twii2, JSON.stringify([X.t2.slice(0, 120), X.twii2]));
  ok('⑦c 雷達那塊壞了 → 那塊說讀不到、除權息行事曆照畫(⛔ 一起不見)', /讀不到/.test(X.t3) && X.div3, JSON.stringify([X.t3.slice(0, 120), X.div3]));
  ok('⑦d 無 pageerror', !errs.length, errs.join(' | '));
  await browser.close();
  return fails;
}

const fails = await run(SRC);
if (process.env.INJECT) {
  let allRed = true;
  for (const [nm, [a, b]] of Object.entries(INJ)) {
    if (!SRC.includes(a)) { console.log(`❌ 注入 ${nm}:找不到原句`); allRed = false; continue; }
    process.env.QUIET = '1';
    const f = await run(SRC.replace(a, b));
    delete process.env.QUIET;
    console.log(`${f.length ? '✅' : '❌'} 注入 ${nm} → ${f.length ? '紅(' + f.slice(0, 2).join(' / ') + ')' : '沒叫出來'}`);
    if (!f.length) allRed = false;
  }
  console.log(allRed ? `✅ ${Object.keys(INJ).length} 種注入全部叫得出來` : '❌ 有注入沒叫出來');
  if (!allRed) process.exit(1);
}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ RADAR_TRACK_PASS');
process.exit(fails.length ? 1 : 0);
