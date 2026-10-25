// 🛰️ V79.7.7 產業作戰室「法說會情報中心」:主題雷達 + 總覽格子 + 日期軸 + 搜尋 + 鍵盤
//   使用者 2026-10-25:「重新設計法說會頁面…用科技感…更厲害可以看到裡面重點或別人看不到的重點」
//   雷達資料 = data/cc_radar.json(confcall_deck.build_radar 算的:每一季幾家公司的簡報提到這個題材 / 第一次提到幾家)
//
// ⛔ 釘死的事(注入都要叫得出來):
//   ① 佔比 = 提到的公司 ÷ 那一季讀到簡報的公司(nco);比一年前同一季;決定性對照:改 nco → 畫面跟著變
//   ② 排序:預設「比一年前」由大到小、同一個鈕再點一次反向;樣本少(<10 家)/ 沒有一年前可比 → 排最後(⛔ 1 家 → 3 家排第一)
//   ③ 總覽那一格「幾個在增加」與上面那排題材鈕 = 同一份計算(⛔ 第二份)
//   ④ 點一列:每一季的數字、第一次提到的公司(點了開那家公司的檔案)、最近 60 天誰在講
//   ⑤ 同一件事的不同寫法:搜 CPO 找得到只寫「共封裝光學」的,反過來也是(決定性對照:拿掉反方向 → 找不到)
//   ⑥ 比對規則剛改(rv)/ 樣本少 要說出來;讀不到檔 ≠ 沒有題材在增加(陷阱 #22)
//   ⑦ ⛔ 方向詞、⛔ 紅綠(雷達講的是「幾家在講」不是漲跌)、390px 不溢出
//   ⑧ 日期軸點一天 = 只看那天;總覽格子 = 切換鈕;桌機:/ 搜尋、j k 上下一場、Esc 關掉;打字中 ⛔ 搶鍵
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : (e ? ' — ' + String(e).slice(0, 300) : '')}`); if (!c) bad++; };

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const dOff = n => { const d = new Date(today + 'T12:00:00+08:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); };
const D1 = dOff(-4), D2 = dOff(-3), D3 = dOff(-5), DF = dOff(3);

// ── 測資:雷達(形狀照 confcall_deck.build_radar 的產物)
const RAD = {
  updated: `${today} 22:10`, v: 1,
  qs: ['2025Q2', '2025Q3', '2025Q4', '2026Q1', '2026Q2', '2026Q3', '2026Q4'],
  nco: [400, 420, 800, 410, 430, 440, 120], part: true, last: '2026Q3', min_co: 300,
  n_deck: 5000, nd: [500, 520, 1000, 505, 540, 550, 150], nold: [0, 0, 0, 0, 0, 80, 10],
  rv: ['AI 伺服器', 'Micro LED', 'Mini LED', 'Wi-Fi 7', 'Wi-Fi 8'], n_co: 1500, from: '2024-01-03', to: dOff(-1), skip: ['量產', '新產品'],
  rows: [
    { t: 'CPO', al: ['共封裝光學'], m: [4, 6, 20, 15, 30, 44, 20], f: [1, 2, 5, 3, 6, 3, 2],
      fl: { '2026Q3': [['3363', '上詮', '2026-08-12', 5], ['4977', '眾達', '2026-08-05', 0]], '2026Q4': [['6442', '光聖', D2, 3]] } },
    { t: 'AI', al: ['人工智慧'], m: [200, 210, 400, 220, 240, 260, 70], f: [5, 6, 9, 4, 3, 2, 1], fl: {} },
    { t: '車用', al: [], m: [100, 105, 180, 90, 85, 84, 20], f: [3, 2, 1, 1, 0, 0, 0], fl: {} },
    { t: '量子電腦', al: [], m: [0, 1, 2, 1, 3, 4, 2], f: [0, 1, 1, 0, 2, 1, 0], fl: {} },
    { t: 'AI 伺服器', al: [], m: [50, 52, 90, 60, 70, 80, 30], f: [2, 2, 3, 2, 3, 4, 1], fl: {} },
    { t: 'GaN', al: ['氮化鎵'], m: [0, 0, 5, 8, 10, 12, 3], f: [0, 0, 5, 3, 2, 1, 0], fl: {} },
  ],
};
// 每個題材的預期(照 ① 的定義在這裡獨立算一次 —— ⛔ 抄 App 的式子)
const L = 5, LY = 1;
const exp = {};
for (const r of RAD.rows) {
  const s = r.m[L] / RAD.nco[L] * 100, sy = r.m[LY] / RAD.nco[LY] * 100;
  exp[r.t] = { s, sy, pp: s - sy, ratio: sy ? s / sy : null, small: r.m[L] < 10 };
  exp[r.t].up = !exp[r.t].small && exp[r.t].pp >= 1;
}
const upList = Object.entries(exp).filter(([, x]) => x.up).sort((a, b) => b[1].pp - a[1].pp).map(([t]) => t);

const row = (s, name, d, sum, pdf) => ({ s, name, mkt: '上市', d, t: '14:00', place: '線上', sum, pdf: pdf || [], web: '', vid: '', other: '' });
const CONF = {
  updated: `${today}T09:00:00Z`, data_date: today, src: { host: 'https://mopsov.twse.com.tw', page: 'x', months: [], file: null }, src_error: {},
  window: { past: 60, future: 45 },
  upcoming: [row('2330', '台積電', DF, '公布第3季財務報告')],
  recent: [row('3363', '上詮', D1, '說明營運概況', ['20261021_3363.pdf']),
           row('6442', '光聖', D2, '說明營運概況', ['20261022_6442.pdf']),
           row('2382', '廣達', D3, '公布第3季財務報告', ['20261020_2382.pdf'])],
  hist: {}, n: { upcoming: 1, recent: 3, with_sum: 4, with_files: 3 },
};
const dg = (f, s, name, d, tm, nw, one) => ({ f, s, name, d, tm, new: nw, new_n: nw.length, prev_d: dOff(-95), one, ol: '' });
const DIG = { updated: `${today} 22:00`, days: 60, n: 3, rows: [
  dg('20261021_3363.pdf', '3363', '上詮', D1, ['共封裝光學', '矽光子'], ['共封裝光學'], '公司說矽光子產品明年量產'),
  dg('20261022_6442.pdf', '6442', '光聖', D2, ['CPO'], ['CPO'], '公司說光通訊出貨增加'),
  dg('20261020_2382.pdf', '2382', '廣達', D3, ['AI 伺服器'], [], '公司說伺服器出貨增加'),
] };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
async function open(w, h) {
  const pg = await b.newPage({ viewport: { width: w, height: h } });
  pg.on('pageerror', e => errs.push(`${w}: ${String(e).slice(0, 160)}`));
  // ⛔ 本機 data/ 不讀:結果不可以看這台機器剛好有什麼檔
  await pg.route('**/*', r => (r.request().url().startsWith('file://') && !/\/data\//.test(r.request().url()) ? r.continue() : r.abort()));
  await pg.goto(pathToFileURL(resolve('pro.html')).href);
  await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderConf, null, { timeout: 30000 });
  await pg.evaluate(({ CONF, RAD, DIG }) => {
    PRO._cache['data/confcall.json'] = CONF;
    PRO._cache['data/confcall_digest.json'] = DIG;
    PRO._cache['data/cc_radar.json'] = RAD;
    for (const s of ['2330', '3363', '6442', '2382', '4977']) PRO._cache[`data/cc/${s}.json`] = { sym: s, decks: [] };
    PRO._cache['data/cc_qa/2330.json'] = null;
    PRO._cache['data/playbook_edge.json'] = { picks: [] };
    PRO._cache['data/screener.json'] = { rows: [] };
    window.__RAD = RAD;
    PRO._names = Object.assign(PRO._names || {}, { 2330: '台積電', 3363: '上詮', 6442: '光聖', 2382: '廣達', 4977: '眾達' });
    PRO.loadNames = async () => PRO._names;
    PRO._confPrep = async () => {};
    try { localStorage.removeItem('proTerminalInv'); } catch (_) {}
  }, { CONF, RAD, DIG });
  await pg.evaluate(() => PRO.switchTab('conf'));
  await pg.waitForFunction(() => document.querySelectorAll('#confKpi .cc-tile').length === 6 && document.querySelector('#confHot [data-conf-hot]'), null, { timeout: 20000 });
  return pg;
}
const pg = await open(390, 844);

// ── ③ 總覽那一格 + 上面那排題材鈕(同一份計算)
const R3 = await pg.evaluate(() => ({
  tile: document.querySelector('#confKpi [data-confsel="radar"]')?.innerText.replace(/\s+/g, ' ') || '',
  hot: [...document.querySelectorAll('#confHot [data-conf-hot]')].map(x => x.getAttribute('data-conf-hot')),
  upN: PRO._radarCalc().upN,
}));
ok(R3.upN === upList.length && new RegExp(`${upList.length}\\s*個在增加`).test(R3.tile) && R3.tile.includes(`${upList[0]} ▲${exp[upList[0]].pp.toFixed(1)}`),
   `③ 總覽「🛰️ 主題雷達」:${upList.length} 個在增加・第一名 ${upList[0]}(樣本少的 ⛔ 算)`, R3.tile);
ok(JSON.stringify(R3.hot) === JSON.stringify(upList), '③ 上面那排題材鈕 = 雷達「在增加」的、照比一年前由大到小', JSON.stringify(R3.hot));

// ── ① ② 雷達本體
const radarRows = () => pg.evaluate(() => [...document.querySelectorAll('[data-radar-row]')].map(x => ({
  t: x.dataset.radarRow, v: x.querySelector('.cr-v b')?.textContent || '', d: x.querySelector('.cr-d')?.textContent || '',
  sub: x.querySelector('.cr-sub')?.textContent || '' })));
await pg.evaluate(() => PRO.confSel('radar'));
const R1 = await radarRows();
const ord = R1.map(x => x.t);
const wantPP = Object.keys(exp).sort((a, b) => {
  const ba = exp[a].small, bb = exp[b].small; if (ba !== bb) return ba ? 1 : -1;
  return exp[b].pp - exp[a].pp;
});
ok(JSON.stringify(ord) === JSON.stringify(wantPP), '② 預設照「比一年前」由大到小;樣本少(<10 家)排最後', `${ord} vs ${wantPP}`);
const cpo = R1.find(x => x.t === 'CPO') || {};
ok(cpo.v === `${exp.CPO.s.toFixed(1)}%` && cpo.d.includes(`▲${exp.CPO.pp.toFixed(1)}`) && /44\/440 家/.test(cpo.sub)
   && cpo.sub.includes(`一年前 ${exp.CPO.sy.toFixed(1)}%`) && /第一次提到 3 家/.test(cpo.sub) && cpo.sub.includes(`${exp.CPO.ratio.toFixed(1)} 倍`) && /26Q4 到目前 20 家/.test(cpo.sub),
   '① 佔比 = 提到的公司 ÷ 那一季讀到簡報的公司;一年前同一季;第一次提到幾家;幾倍;還在進行那一季到目前幾家', JSON.stringify(cpo));
const qz = R1.find(x => x.t === '量子電腦') || {};
ok(/樣本少/.test(qz.sub) && !/倍/.test(qz.sub), '⑥ 不到 10 家在講 → 標「⏳ 樣本少」、⛔ 寫幾倍(1 家 → 4 家 = 4 倍沒有意義)', qz.sub);
const aisv = R1.find(x => x.t === 'AI 伺服器') || {};
ok(/規則剛改/.test(aisv.sub), '⑥ 比對規則剛改、舊簡報還沒重抽的比例 > 10% → 標「🔤 規則剛改」', aisv.sub);

// 同一個鈕再點一次 → 反向(樣本少照樣排最後)
await pg.evaluate(() => PRO.confRadarSort('pp'));
const R1r = (await radarRows()).map(x => x.t);
const wantPPr = Object.keys(exp).sort((a, b) => {
  const ba = exp[a].small, bb = exp[b].small; if (ba !== bb) return ba ? 1 : -1;
  return exp[a].pp - exp[b].pp;
});
const bar = await pg.evaluate(() => document.querySelector('[data-radar-sort="pp"]')?.textContent || '');
ok(JSON.stringify(R1r) === JSON.stringify(wantPPr) && /▲/.test(bar), '② 同一個表頭再點一次 → 反向(按鈕上看得出方向);樣本少照樣排最後', `${R1r} | ${bar}`);
// 幾倍:沒有一年前可比(一年前 0 家)與樣本少都排最後
await pg.evaluate(() => PRO.confRadarSort('ratio'));
const R1x = (await radarRows()).map(x => x.t);
const goodR = Object.keys(exp).filter(t => !exp[t].small && exp[t].ratio != null).sort((a, b) => exp[b].ratio - exp[a].ratio);
ok(JSON.stringify(R1x.slice(0, goodR.length)) === JSON.stringify(goodR) && R1x.slice(goodR.length).every(t => exp[t].small || exp[t].ratio == null),
   '② 照「幾倍」排:一年前 0 家(GaN)與樣本少 ⛔ 排前面', R1x.join(','));
// 名稱 / 佔比 / 第一次提到 都排得動
const R1s = await pg.evaluate(() => { PRO.confRadarSort('s'); return [...document.querySelectorAll('[data-radar-row]')].map(x => x.dataset.radarRow); });
const wantS = Object.keys(exp).sort((a, b) => exp[b].s - exp[a].s);
ok(JSON.stringify(R1s) === JSON.stringify(wantS), '② 照「佔比」排', R1s.join(','));
const R1t = await pg.evaluate(() => { PRO.confRadarSort('t'); const o = [...document.querySelectorAll('[data-radar-row]')].map(x => x.dataset.radarRow);
  return { o, want: o.slice().sort((a, b) => a.localeCompare(b, 'zh-Hant')) }; });
ok(JSON.stringify(R1t.o) === JSON.stringify(R1t.want), '② 照「名稱」排', R1t.o.join(','));
await pg.evaluate(() => { PRO._radSort = 'pp'; PRO._radRev = false; PRO._confPaint(); });

// ① ⭐ 決定性對照:那一季讀到的公司變兩倍 → 佔比減半、在增加的題材跟著變(總覽那一格一起變)
const R1c = await pg.evaluate(() => {
  const J = PRO._confRad;
  const J2 = JSON.parse(JSON.stringify(J)); J2.nco[5] = 880;
  PRO._confRad = J2; PRO._radC = null; PRO._confPaint();
  const v = document.querySelector('[data-radar-row="CPO"] .cr-v b')?.textContent || '';
  const tile = document.querySelector('#confKpi [data-confsel="radar"]')?.innerText.replace(/\s+/g, ' ') || '';
  PRO._confRad = J; PRO._radC = null; PRO._confPaint();
  return { v, tile };
});
const e2 = Object.fromEntries(RAD.rows.map(r => { const s = r.m[L] / 880 * 100, sy = r.m[LY] / RAD.nco[LY] * 100; return [r.t, { s, pp: s - sy, up: r.m[L] >= 10 && s - sy >= 1 }]; }));
const up2 = Object.values(e2).filter(x => x.up).length;
ok(R1c.v === `${e2.CPO.s.toFixed(1)}%` && new RegExp(`${up2}\\s*個在增加`).test(R1c.tile) && up2 !== upList.length,
   `① ⭐ 決定性對照:那一季讀到的公司 440 → 880 → CPO ${e2.CPO.s.toFixed(1)}%、在增加 ${upList.length} → ${up2} 個(⛔ 寫死)`, JSON.stringify(R1c));
// ⑥ 決定性對照:舊規則的簡報只剩 9% → 不再標「規則剛改」
const R6c = await pg.evaluate(() => {
  const J = PRO._confRad, J2 = JSON.parse(JSON.stringify(J)); J2.nold[5] = 50;
  PRO._confRad = J2; PRO._radC = null; PRO._confPaint();
  const t = document.querySelector('[data-radar-row="AI 伺服器"] .cr-sub')?.textContent || '';
  PRO._confRad = J; PRO._radC = null; PRO._confPaint();
  return t;
});
ok(!/規則剛改/.test(R6c), '⑥ ⭐ 決定性對照:舊規則的簡報降到 9%(≤ 10%)→ ⛔ 再標「規則剛改」', R6c);

// ── ④ 點一列 → 每一季 + 第一次提到的公司 + 最近 60 天誰在講
const R4 = await pg.evaluate(async () => {
  document.querySelector('[data-radar-row="CPO"]').click();
  const x = document.querySelector('[data-radar-detail="CPO"]');
  const qs = x ? [...x.querySelectorAll('.cr-q > span')].map(s => ({ c: s.className, t: s.textContent })) : [];
  const f3 = x?.querySelector('[data-radar-first="2026Q3"]'), f4 = x?.querySelector('[data-radar-first="2026Q4"]');
  const chips3 = f3 ? [...f3.querySelectorAll('button[data-s]')].map(b => b.dataset.s + '|' + b.textContent.replace(/\s+/g, ' ')) : [];
  const who = [...(x?.querySelectorAll('button') || [])].find(b => /誰在講/.test(b.textContent))?.textContent.replace(/\s+/g, ' ') || '';
  const res = { open: document.querySelector('[data-radar-row="CPO"]').getAttribute('aria-expanded'), qs, f3: f3?.textContent.replace(/\s+/g, ' ') || '', f4: f4?.textContent.replace(/\s+/g, ' ') || '', chips3, who };
  // 點第一次提到的公司 → 開那家公司的檔案(跟上次比那一頁)
  f3.querySelector('button[data-s="3363"]').click();
  await new Promise(r => setTimeout(r, 200));
  res.dsym = PRO._confDSym; res.dtab = PRO._ccdTab; res.don = document.getElementById('confDossier').classList.contains('on');
  PRO.confCloseD();
  // 再點一次那一列 → 收起來
  document.querySelector('[data-radar-row="CPO"]').click();
  res.closed = !document.querySelector('[data-radar-detail="CPO"]');
  return res;
});
ok(R4.open === 'true' && R4.qs.length === RAD.qs.length && R4.qs.some(q => /cur/.test(q.c) && q.t.includes(`${exp.CPO.s.toFixed(1)}%`) && /44\/440 家/.test(q.t)) && /part/.test(R4.qs[R4.qs.length - 1].c),
   '④ 點一列 → 每一季的佔比與家數;比的那一季標出來、還在進行那一季另外標', JSON.stringify(R4.qs).slice(0, 240));
ok(/第一次在簡報提到:3 家/.test(R4.f3) && /列最近 2 家/.test(R4.f3) && R4.chips3.some(c => /^3363\|上詮 08\/12 第5頁/.test(c)) && R4.chips3.some(c => /^4977\|眾達\S* 08\/05$/.test(c.trim()) && !/頁/.test(c)),
   '④ 第一次提到的公司:名字 + 日期 + 第幾頁(沒有頁碼 ⛔ 印);只列一部分要說出來', `${R4.f3} | ${R4.chips3}`);
ok(/還在進行/.test(R4.f4) && /1 家|2 家/.test(R4.f4), '④ 還在進行那一季也列第一次提到的公司(標「還在進行」)', R4.f4);
ok(/誰在講 2 家/.test(R4.who), '④ 「最近 60 天誰在講」= 簡報重點清單裡提到這個題材(含別的寫法)的公司數', R4.who);
ok(R4.dsym === '3363' && R4.dtab === 'cmp' && R4.don, '④ 點第一次提到的公司 → 開那家公司的檔案、停在「跟上次比」', JSON.stringify({ s: R4.dsym, t: R4.dtab, on: R4.don }));
ok(R4.closed, '④ 同一列再點一次 → 收起來');

// ── ⑤ 同一件事的不同寫法:兩個方向都搜得到
const R5 = await pg.evaluate(() => {
  const hits = q => { PRO.confSearch(q); return [...document.querySelectorAll('#confBody [data-conf-row]')].map(x => x.dataset.confRow).sort().join(','); };
  const a = hits('CPO'), c = hits('共封裝光學');
  // 決定性對照:拿掉「雷達名字 → 別名」那個方向 → 搜「共封裝光學」找不到只寫 CPO 的那一家
  const keep = PRO._radAliasOf; PRO._radAliasOf = {};
  const c0 = hits('共封裝光學');
  PRO._radAliasOf = keep;
  // 題材鈕:點了 = 搜那個詞
  document.querySelector('#confHot [data-conf-hot="CPO"]')?.click();
  const q = PRO._confQ, hb = [...document.querySelectorAll('#confBody [data-conf-row]')].map(x => x.dataset.confRow).sort().join(',');
  const term = document.querySelector('#confBody [data-conf-row="3363"] .cc-term')?.className || '';
  PRO.confSearch('');
  return { a, c, c0, q, hb, term };
});
ok(R5.a === '3363,6442' && R5.c === '3363,6442', '⑤ 搜 CPO / 共封裝光學 都找得到兩家(一家只寫 CPO、一家只寫共封裝光學)', JSON.stringify(R5));
ok(R5.c0 === '3363', '⑤ ⭐ 決定性對照:拿掉反方向 → 搜「共封裝光學」找不到只寫 CPO 的那家', R5.c0);
ok(R5.q === 'CPO' && R5.hb === '3363,6442' && /\bhot\b/.test(R5.term), '⑤ 點上面的題材鈕 = 搜那個詞;清單裡那個詞標成雷達上在增加的(▲)', JSON.stringify(R5));

// ── ⑥ 讀不到檔 / 讀取中
const R6 = await pg.evaluate(() => {
  const J = PRO._confRad;
  PRO._confRad = null; PRO._radC = null; PRO.confSel('radar');
  const nf = document.querySelector('[data-radar-nofile]')?.textContent || '';
  const tile = document.querySelector('#confKpi [data-confsel="radar"]')?.innerText.replace(/\s+/g, ' ') || '';
  PRO.confSel('new');
  const hot = document.getElementById('confHot').innerHTML;
  PRO._confRad = undefined; PRO._radC = null; PRO.confSel('radar');
  const ld = !!document.querySelector('[data-radar-loading]');
  PRO._confRad = J; PRO._radC = null; PRO.confSel('radar');
  return { nf, tile, hot, ld };
});
ok(/讀不到 data\/cc_radar\.json/.test(R6.nf) && /不代表沒有題材在增加/.test(R6.nf) && /還沒產出/.test(R6.tile) && R6.hot === '' && R6.ld,
   '⑥ 讀不到雷達檔 → 說清楚(⛔ 說成沒有題材在增加)、總覽寫「還沒產出」、題材鈕整排不出現;讀取中寫讀取中', JSON.stringify(R6).slice(0, 200));

// ── ⑦ ⛔ 方向詞 / ⛔ 紅綠 / 390px
const R7 = await pg.evaluate(() => {
  PRO.confRadarOpen('CPO');
  const box = document.getElementById('confBody');
  box.querySelectorAll('details').forEach(d => { d.open = true; });
  const txt = box.innerText.replace(/\s+/g, ' ');
  const css = getComputedStyle(document.documentElement);
  const red = css.getPropertyValue('--up').trim(), green = css.getPropertyValue('--dn').trim();
  const rgb = h => { const m = h.replace('#', '').match(/../g); return m ? `rgb(${m.map(x => parseInt(x, 16)).join(', ')})` : ''; };
  const RED = rgb(red), GRN = rgb(green);
  const colored = [...box.querySelectorAll('*')].filter(el => el.getClientRects().length && el.childNodes.length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))
    .map(el => getComputedStyle(el).color).filter(c => c === RED || c === GRN);
  const upc = getComputedStyle(document.querySelector('[data-radar-row] .cr-d.cr-up')).color;
  window.scrollTo(80, 0); const wide = window.scrollX > 2; window.scrollTo(0, 0);
  const out = [];
  for (const el of box.querySelectorAll('div,span,a,button,b,svg,details,summary')) {
    if (!el.getClientRects().length) continue;
    const pa = el.parentElement; if (!pa) continue;
    if (/auto|scroll/.test(getComputedStyle(pa).overflowX)) continue;   // 排序鈕那排自己橫捲
    const a = el.getBoundingClientRect(), p = pa.getBoundingClientRect();
    if (p.width < 40 || a.width < 20) continue;
    const over = Math.round(a.right - p.right); if (over > 6) out.push(`${el.tagName}.${el.getAttribute('class') || ''}+${over}`);
  }
  const w = Math.round(box.getBoundingClientRect().width), n = box.querySelectorAll('[data-radar-row]').length;
  PRO.confRadarOpen('CPO');
  return { txt, colored: colored.length, upc, wide, out: out.slice(0, 6), w, n };
});
const DIR = /偏多|偏空|利多|利空|看多|看空|加碼|減碼|會漲|會跌|勝率|買進|賣出/;
ok(!DIR.test(R7.txt), '⑦ 雷達整頁 ⛔ 方向詞 / 勝率 / 買賣', (R7.txt.match(DIR) || [])[0]);
ok(R7.colored === 0 && R7.upc === 'rgb(34, 211, 238)', '⑦ ⛔ 紅綠(「越多公司在講」不是漲跌)—— 增加用青色', JSON.stringify({ c: R7.colored, up: R7.upc }));
ok(R7.w >= 350 && R7.n === RAD.rows.length, '⑦ 🚧 空過守門:雷達真的畫出來、寬度夠', JSON.stringify({ w: R7.w, n: R7.n }));
ok(!R7.wide && R7.out.length === 0, '⑦ 390px:頁面不橫捲、雷達每一列沒有東西超出父層', JSON.stringify(R7.out));

// ── ⑧ 日期軸 / 總覽格子 = 切換鈕
const R8 = await pg.evaluate(() => {
  PRO.confSel('future');
  const fut = { sel: PRO._confSel, pressed: document.querySelector('#confKpi [data-confsel="future"]')?.getAttribute('aria-pressed') };
  PRO.confSel('all');
  const day = document.querySelector(`#confRail [data-confday="${PRO._confDay(-3)}"]`);
  day.click();
  const rows = [...document.querySelectorAll('#confBody [data-conf-row]')].map(x => x.dataset.confRow);
  const anyOn = !!document.querySelector('#confKpi .cc-tile.on'), dayOn = document.querySelector(`#confRail [data-confday="${PRO._confDay(-3)}"]`)?.classList.contains('on');
  const empty = document.querySelector(`#confRail [data-confday="${PRO._confDay(-1)}"]`);
  const r2 = { fut, rows, anyOn, dayOn, emptyDis: !!(empty && empty.disabled) };
  document.querySelector(`#confRail [data-confday="${PRO._confDay(-3)}"]`).click();
  r2.back = [...document.querySelectorAll('#confBody [data-conf-row]')].length;
  return r2;
});
ok(R8.fut.sel === 'future' && R8.fut.pressed === 'true', '⑧ 總覽格子就是切換鈕(按下去的那一格標出來)', JSON.stringify(R8.fut));
ok(R8.rows.join(',') === '6442' && !R8.anyOn && R8.dayOn && R8.emptyDis, '⑧ 日期軸點一天 = 只看那一天(格子不再標選取);那天沒有場次的 ⛔ 按', JSON.stringify(R8));
ok(R8.back === 4, '⑧ 再點同一天 → 取消,回到原本的範圍', R8.back);

// ── ⑧ 桌機:公司檔案在右邊一欄;/ j k Esc;打字中 ⛔ 搶鍵
const pd = await open(1280, 900);
await pd.evaluate(() => PRO.confSel('all'));
const K = await pd.evaluate(async () => {
  const D = document.getElementById('confDossier'), body = document.getElementById('confBody');
  const r = { empty: !!D.querySelector('[data-ccd-empty]'), side: D.getBoundingClientRect().left > body.getBoundingClientRect().right - 2, lock: false };
  const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const keys = () => [...document.querySelectorAll('#confBody .cc-row')].map(x => x.dataset.confKey);
  const all = keys();
  key('j'); r.j1 = PRO._confSelK === all[0];
  key('j'); r.j2 = PRO._confSelK === all[1];
  key('k'); r.k1 = PRO._confSelK === all[0];
  r.lock = document.body.classList.contains('cc-lock');
  r.selRow = document.querySelector('#confBody .cc-row.sel')?.dataset.confKey === all[0];
  key('Escape'); r.esc = PRO._confSelK === '' && !!D.querySelector('[data-ccd-empty]');
  key('/'); r.slash = document.activeElement && document.activeElement.id === 'confQ';
  const q = document.getElementById('confQ');
  q.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  r.typing = PRO._confSelK === '';
  PRO.confSearch('光'); q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  r.escClear = PRO._confQ === '';
  q.blur();
  return r;
});
ok(K.empty && K.side, '⑧ 桌機:公司檔案固定在右邊一欄,還沒挑公司時是一段操作說明(⛔ 一塊空白)', JSON.stringify(K));
ok(K.j1 && K.j2 && K.k1 && K.selRow && !K.lock, '⑧ j / k 上下一場,清單那一列跟著標選取;桌機 ⛔ 鎖住底下的頁面', JSON.stringify(K));
ok(K.esc && K.slash && K.typing && K.escClear, '⑧ Esc 關掉公司檔案、/ 跳到搜尋;在搜尋框打字 ⛔ 被 j 搶走;搜尋框按 Esc = 清掉', JSON.stringify(K));
ok(errs.length === 0, '⑦ 沒有 pageerror', errs.join(' | '));

await b.close();
console.log(bad ? `\n❌ 失敗 ${bad} 條` : '\n✅ 全部通過');
process.exit(bad ? 1 : 0);
