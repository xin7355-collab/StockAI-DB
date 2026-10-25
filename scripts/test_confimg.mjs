// 🎨 V79.8.1 法說會「一頁戰報」做圖:提示詞(給會畫圖的外部 AI)+ 本站自己畫一張(canvas)
//   使用者 2026-10-25:「給我法說會做成圖的提示詞,要厲害點的」→ 選「提示詞 + 本站自己畫一張」
//
// ⛔ 釘死的事(注入都要叫得出來):
//   ① 複製提示詞是同步的(⛔ async / await —— iOS 會擋剪貼簿,V76.2.1);數字還沒讀好 → 先讀、請再按一次;複製不了 → 文字框
//   ② 提示詞與畫布讀同一份資料(_confImgFacts)、同一組顏色(_CC_IMG_STYLE)、同一句頁尾 / 實測那句
//   ③ ⛔ 本站 AI 摘要(dk.ai)進來(換掉 AI 文字 → 提示詞與畫布一個像素都不變)
//   ④ 本站對帳 = _confFacts().lines 原樣(⛔ 第二份);改一個數字畫布要跟著變
//   ⑤ 紅綠只出現在「開完到現在」那兩個漲跌數字,而且方向對(紅漲綠跌)
//   ⑥ ⛔ 方向 / 分數 / 買賣字眼;缺資料寫「本站沒有」⛔ undefined / NaN / null
//   ⑦ 法人問答只有台積電、而且是那一場的那一季;延期還沒開 → 會前準備、⛔ 問答、⛔ 把原訂日期當「上一場」
//   ⑧ 畫布 ⛔ emoji;390 / 844 不橫捲;存圖那支跟散戶 App 的 _saveBlob 一字不差
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : (e ? ' — ' + String(e).slice(0, 300) : '')}`); if (!c) bad++; };

// ── 原始碼守門
const PRO_SRC = readFileSync('pro.html', 'utf8');
const IDX_SRC = readFileSync('index.html', 'utf8');
const fnBody = (src, sig) => { const i = src.indexOf(sig); if (i < 0) return ''; let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } return ''; };
{
  const cp = fnBody(PRO_SRC, '  confImgCopy(sym) {');
  ok(cp && !/\bawait\b/.test(cp) && !/async\s+confImgCopy/.test(PRO_SRC) && /this\._copySync\(txt\)/.test(cp),
     'ⓐ 複製提示詞是同步的(⛔ async / await)、走 _copySync', cp.slice(0, 120));
  const pr = fnBody(PRO_SRC, '  _confImgPrompt(sym) {'), dr = fnBody(PRO_SRC, '  _confDrawOwn(sym) {');
  ok(/this\._confImgFacts\(sym\)/.test(pr) && /this\._confImgFacts\(sym\)/.test(dr) && /this\._CC_IMG_FOOT/.test(pr) && /this\._CC_IMG_FOOT/.test(dr)
     && /this\._CC_IMG_PXNOTE/.test(pr) && /this\._CC_IMG_PXNOTE/.test(dr) && /this\._CC_IMG_STYLE/.test(pr) && /this\._CC_IMG_STYLE/.test(dr),
     'ⓑ 提示詞與畫布讀同一份資料 / 顏色 / 頁尾 / 實測那句(⛔ 各寫一份)');
  const fx = fnBody(PRO_SRC, '  _confImgFacts(sym, r) {');
  ok(fx && !/\.ai\b/.test(fx.replace(/\/\/[^\n]*/g, '')), 'ⓒ _confImgFacts ⛔ 讀本站 AI 摘要(dk.ai)');
  ok(/const pxCol = v => \(v >= 0 \? S\.up : S\.dn\)/.test(dr) && (dr.match(/S\.up|S\.dn/g) || []).length === 2,
     'ⓓ 畫布裡紅綠只出現在 pxCol 那一支', (dr.match(/S\.up|S\.dn/g) || []).length);
  // 存圖:跟散戶 App 一字不差(註解 / 空白除外)
  const norm = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
  const a = norm(fnBody(PRO_SRC, '  async _saveBlob(blob, fileName, opts = {}) {')), b = norm(fnBody(IDX_SRC, '    async _saveBlob(blob, fileName, opts = {}) {'));
  ok(a && a === b, 'ⓔ 存圖 _saveBlob 跟散戶 App 一字不差(LINE 內建瀏覽器 / 先分享 / 200ms 清理)', a.slice(0, 80) + ' ≠ ' + b.slice(0, 80));
  const sp = fnBody(PRO_SRC, '  _savePng(cv, fileName) {');
  ok(/cv\.toBlob/.test(sp) && /this\._saveBlob\(b, fileName/.test(sp), 'ⓔ2 _savePng = toBlob → _saveBlob(⛔ toDataURL + a.click)');
}

// ── 測資(格式照真實產物:cc 檔 nums / outlook / titles 是 [頁, 句]、new 是 [詞, 頁]、g 是 confcall_guidance 的句子)
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const dOff = n => { const d = new Date(today + 'T12:00:00+08:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); };
const ymd = d => d.replace(/-/g, '');
const fOf = (s, d) => `${s}${ymd(d)}M001.pdf`;
const row = (s, name, d, t, sum, pdf, x) => Object.assign({ s, name, mkt: '上市', d, t, place: '線上', sum, pdf, web: '', vid: '', other: '' }, x || {});
const D2382 = dOff(-2), D2330 = dOff(-4), D6488 = dOff(-1), D1303 = dOff(-1), MV1303 = dOff(2), PREV2382 = dOff(-95);
const CONF = {
  updated: `${today}T09:00:00Z`, data_date: today,
  src: { host: 'https://mopsov.twse.com.tw', page: 'ajax_t100sb02_1', months: [], file: null },
  src_error: {}, window: { past: 60, future: 45 },
  upcoming: [],
  recent: [
    row('2382', '廣達', D2382, '14:30', '本公司說明營運概況。', [fOf('2382', D2382)]),
    row('2330', '台積電', D2330, '14:00', '本公司財務報告說明', [fOf('2330', D2330)]),
    row('6488', '環球晶', D6488, '10:00', '', []),
    row('9998', '測試股', D6488, '10:00', '', []),      // 本機 data/ 沒有這一檔的任何檔 → 讀了也讀不到(fetchJson 失敗不快取)
    row('1303', '南亞', D1303, '14:00', '', [], { mv: MV1303, mvc: 1, other: '如台北市政府公告停止上班,本說明會將順延至新日期(線上會議)' }),
  ],
  hist: { 2382: [PREV2382, D2382], 1303: [dOff(-12), D1303] }, n: { upcoming: 0, recent: 4, with_sum: 2, with_files: 2 },
};
const dg = (s, d, x) => Object.assign({ s, name: s, d, t: '', inv: 0, f: fOf(s, d), one: '', ol: '', new: [], new_n: 0, first: false, prev_d: '', reuse: '', n_nums: 0, pages: 20, tm: [] }, x);
const DIGEST = { updated: `${today}T18:00`, days: 60, n: 2, rows: [
  dg('2382', D2382, { new: ['CPO', '機器人', '矽光子'], new_n: 3, prev_d: PREV2382, n_nums: 4, tm: ['CPO'] }),
  dg('2330', D2330, { prev_d: dOff(-94), tm: [] }),
] };
const AI_SECRET = '__本站AI摘要不可以出現__';
const deck2382 = () => ({
  d: D2382, f: fOf('2382', D2382), st: 'ok', pages: 20, kind: 'pdf',
  titles: [[3, '營運概況'], [9, '第四季營運展望']],
  outlook: [[9, '基於目前的假設,公司預期:'], [12, '持續投資 AI 相關產能']],
  nums: [[3, '毛利率 12.5%'], [9, '營收季增 5% 到 8%'], [9, '毛利率介於 11% 到 12%']],
  g: [{ p: 9, t: '第四季營收將季增', m: 'rev', dir: 'up', h: dOff(0).slice(0, 4) + 'Q4', ok: 1, r: { res: 'pending', cur: dOff(0).slice(0, 4) + 'Q4', base: dOff(0).slice(0, 4) + 'Q3' } }],
  new: [['CPO', 7], ['機器人', 8], ['矽光子', 9]], n_new: 3, prev_d: PREV2382, dropped: ['HBM'],
  ai: { one: AI_SECRET, outlook: [{ t: AI_SECRET + '展望', p: 5 }], new: [], risk: [{ t: AI_SECRET + '風險', p: 11 }] }, model: 'qwen', gate_drop: 0 });
const oldDeck = { d: PREV2382, f: fOf('2382', PREV2382), st: 'ok', pages: 18, outlook: [], nums: [], titles: [],
  g: [{ p: 4, t: '第三季毛利率將優於第二季', m: 'gm', dir: 'up', h: '2026Q3', ok: 1, r: { res: 'hit', cur: '2026Q3', base: '2026Q2', a: 12.6, b: 12.1, chg: 0.5, src: 'q' } },
      { p: 5, t: '第三季營收將季增', m: 'rev', dir: 'up', h: '2026Q3', ok: 1, r: { res: 'miss', cur: '2026Q3', base: '2026Q2', a: 300, b: 310, chg: -3.2, src: 'm' } }],
  new: [], dropped: [] };
const CC2382 = () => ({ s: '2382', name: '廣達', decks: [deck2382(), oldDeck] });
const CC2330 = { s: '2330', name: '台積電', decks: [{ d: D2330, f: fOf('2330', D2330), st: 'ok', pages: 12, titles: [], outlook: [], nums: [], g: [], new: [], dropped: [], first: true }] };
const QA2330 = { updated: today, show: 4, tags: ['AI'], quarters: [
  { yq: '2026Q3', d: D2330, q_n: 2, items: [{ tag: 'AI', org: '某證券', q: '今年 AI 需求如何?', by: '董事長', a: '需求很強,供給仍緊。' }, { tag: 'AI', org: '某投信', q: '資本支出?', by: '財務長', a: '維持先前區間。' }] },
  { yq: '2026Q2', d: dOff(-100), q_n: 1, items: [{ tag: 'AI', org: '舊的', q: '上一季的問題', by: '董事長', a: '上一季的回答' }] }] };
const RADAR = { qs: ['2025Q3', '2025Q4', '2026Q1', '2026Q2', '2026Q3'], nco: [1000, 1000, 1000, 1000, 1000], last: '2026Q3', part: false,
  rows: [{ t: 'CPO', al: [], m: [10, 20, 30, 40, 80] }, { t: '機器人', al: [], m: [5, 5, 5, 5, 6] }] };
const kl = (d0, c0, c1) => [{ date: dOff(-30).replace(/-/g, '/'), close: c0 * 0.9, volume: 1000 }, { date: d0.replace(/-/g, '/'), close: c0, volume: 1000 }, { date: dOff(-1).replace(/-/g, '/'), close: c1, volume: 1000 }];
// 每檔基本面 / 財報切片(格式照 data/chips/{sym}.json 的 fundamentals、data/fin/{sym}.json 的 q)→ _confFacts 才有句子可以比
const CHIPS2382 = { fundamentals: { quarterly_eps: [{ period: '2025-09', eps: 3.1 }, { period: '2025-12', eps: 3.5 }, { period: '2026-03', eps: 4.0 }, { period: '2026-06', eps: 4.2 }],
  monthly_revenue_history: [{ ym: '2026-07', rev: 1.5e11 }, { ym: '2026-08', rev: 1.6e11 }, { ym: '2026-09', rev: 1.7e11 }], revenue_yoy: 12.3, total_dividend: 15, quarterly_dividends: [{ ex_date: '2026-07-10' }] } };
const FIN2382 = { q: [{ p: '2025-12', gm: 7.9 }, { p: '2026-03', gm: 8.1 }, { p: '2026-06', gm: 8.4, oim: 4.5, opi: 2.0e10, ni: 1.8e10, ocf: 1.5e10, doi: 55, pub: '2026-08-14' }], ni4: 7e10, fcf4: 3e10 };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await pg.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await pg.goto(pathToFileURL(resolve('pro.html')).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._confImgFacts, null, { timeout: 30000 });
const plant = async (x = {}) => pg.evaluate(async ({ CONF, DIGEST, CC2382, CC2330, QA2330, RADAR, CHIPS2382, FIN2382, K2382, K0050, K2330, x }) => {
  PRO._confReset();
  const C = PRO._cache;
  Object.assign(C, {
    'data/confcall.json': CONF, 'data/confcall_digest.json': DIGEST, 'data/cc_radar.json': RADAR,
    'data/playbook_edge.json': { picks: [] }, 'data/screener.json': { rows: [] },
    'data/cc/2382.json': CC2382, 'data/cc/2330.json': CC2330, 'data/cc/6488.json': null, 'data/cc/1303.json': null,
    'data/cc_qa/2330.json': QA2330,
    'data/2382.json': K2382, 'data/2330.json': K2330, 'data/6488.json': null, 'data/1303.json': null, 'data/0050.json': K0050,
  });
  for (const s of ['2330', '6488', '1303']) { C[`data/chips/${s}.json`] = null; C[`data/fin/${s}.json`] = null; }
  C['data/chips/2382.json'] = CHIPS2382; C['data/fin/2382.json'] = FIN2382;
  Object.assign(C, x);
  PRO._names = Object.assign(PRO._names || {}, { 2330: '台積電', 2382: '廣達', 6488: '環球晶', 1303: '南亞' });
  PRO.loadNames = async () => PRO._names;
  await PRO._confEnsure();
}, { CONF, DIGEST, CC2382: CC2382(), CC2330, QA2330, RADAR, CHIPS2382, FIN2382, K2382: kl(D2382, 100, 110), K0050: kl(D2382, 50, 51), K2330: kl(D2330, 1000, 980), x });
await plant();
await pg.evaluate(() => PRO.switchTab('conf'));
await pg.waitForTimeout(600);

// ── ① 數字還沒讀好 → ⛔ 複製、先讀、請再按一次;讀好 → 複製出來的就是 _confImgPrompt
const R1 = await pg.evaluate(async () => {
  const got = []; const real = PRO._copySync; PRO._copySync = t => { got.push(t); return true; };
  PRO._confPrepAt = {};
  PRO.confImgCopy('2382');
  const toast1 = document.getElementById('toast').textContent, n1 = got.length, st1 = PRO._confPrepAt['2382'];
  await PRO._confPrep('2382');
  PRO.confImgCopy('2382');
  const toast2 = document.getElementById('toast').textContent;
  const out = { toast1, n1, st1, n2: got.length, same: got[0] === PRO._confImgPrompt('2382'), toast2, prompt: got[0] || '' };
  // 複製不了 → 文字框自己選(⛔ 靜默失敗)
  PRO._copySync = () => false; PRO.confImgCopy('2382');
  const ta = document.querySelector('#proModal [data-ccimg-ta]');
  out.ta = !!ta && ta.value === PRO._confImgPrompt('2382');
  PRO.closeModal(); PRO._copySync = real;
  return out;
});
ok(R1.n1 === 0 && /還在讀/.test(R1.toast1) && ['loading', 'ok'].includes(R1.st1), '① 數字還沒讀好 → ⛔ 複製、先開始讀、提示再按一次', JSON.stringify({ n1: R1.n1, t: R1.toast1, st: R1.st1 }));
ok(R1.n2 === 1 && R1.same && /已複製/.test(R1.toast2), '① 讀好再按 → 複製出來的 == _confImgPrompt(同一份)', JSON.stringify({ n2: R1.n2, same: R1.same }));
ok(R1.ta, '① 複製不了 → 跳文字框(內容 = 提示詞)');

// ── ② 提示詞:顏色 / 頁尾 / 實測那句 = 常數;【資料】⛔ 方向 / 分數 / AI 摘要
const P = await pg.evaluate(() => ({ S: PRO._CC_IMG_STYLE, FOOT: PRO._CC_IMG_FOOT, PXN: PRO._CC_IMG_PXNOTE, F: PRO._confImgFacts('2382'), lines: PRO._confFacts('2382', PRO._confPickRow('2382')).lines, prompt: PRO._confImgPrompt('2382') }));
const data = P.prompt.slice(P.prompt.indexOf('【資料】\n') + 5);
ok(['bg', 'up', 'dn', 'amber', 'cyan', 'line', 'txt', 'dim'].every(k => P.prompt.includes(P.S[k])), '② 提示詞的顏色值都從 _CC_IMG_STYLE 帶入(跟畫布同一組)');
ok(P.prompt.includes(`「${P.FOOT}」`) && P.prompt.includes(`「${P.PXN}」`), '② 頁尾與「本站實測」那句逐字帶入');
ok(/紅 #ff5d5d = 上漲、綠 #3ddc84 = 下跌/.test(P.prompt) && /⛔ 紅綠不可以表示好壞/.test(P.prompt), '② 台股紅漲綠跌 + 紅綠不可以表示好壞(燈號鐵則)寫進提示詞');
ok(!P.prompt.includes('__本站AI摘要'), '② ⛔ 本站 AI 摘要(dk.ai)進提示詞');
const DIR = /利多|利空|會漲|會跌|買進|賣出|目標價|評等|星等|分數|值得布局|偏多|偏空|看多|看空/;
ok(data.length > 200 && !DIR.test(data), '② 【資料】⛔ 方向 / 分數 / 買賣字眼', (data.match(DIR) || [])[0]);
ok(!/undefined|NaN|\bnull\b|\[object/.test(P.prompt), '② 提示詞沒有 undefined / NaN / null');
ok(JSON.stringify(P.F.facts) === JSON.stringify(P.lines) && P.lines.length >= 3 && P.lines.every(l => P.prompt.includes('- ' + l)),
   '④ 【本站算好的數字】= _confFacts().lines 原樣(⛔ 第二份)', P.lines.length);
// 02 公司給的數字:可以對答案的先;展望頁(頁名有「展望」)的數字;⛔ 一般頁面的數字(p3 營運概況)
const gd = P.F.guide;
ok(gd[0] && gd[0].t === '第四季營收將季增' && /營收比/.test(gd[0].what) && gd.some(x => x.t === '營收季增 5% 到 8%' && x.ttl === '第四季營運展望')
   && gd.some(x => x.t === '毛利率介於 11% 到 12%') && !gd.some(x => x.t === '毛利率 12.5%'),
   '② 公司給的數字:可以對答案的排第一、展望頁的數字帶頁名、⛔ 一般頁面的數字', JSON.stringify(gd.map(x => [x.t, x.ttl, x.what])));
ok(/〔第四季營運展望〕「營收季增 5% 到 8%」 p9/.test(P.prompt), '② 提示詞每一句帶〔頁名〕+「原話」+ 頁碼');
// 03 說到做到(兩份簡報;同一件事只算一次)
ok(P.F.track && P.F.track.hit === 1 && P.F.track.miss === 1 && P.F.track.pend === 1 && P.F.claims.length === 2 && /做到 1・沒做到 1・還沒到期 1/.test(P.prompt),
   '② 說到做到 = _ccTrack(做到 1・沒做到 1・還沒到期 1)', JSON.stringify(P.F.track));
// 05 雷達:有的詞才列(CPO 8.0% / 一年前 1.0%)
ok(P.F.radar.length === 2 && /CPO:2026 年 7~9 月有 8\.0% 的公司簡報提到\(一年前 1\.0%\)/.test(P.prompt) && !P.F.radar.some(x => x.t === '矽光子'),
   '② 全市場佔比讀主題雷達(雷達上沒有的詞不列)', JSON.stringify(P.F.radar));
// 08 時間軸照日期排、上一場 = hist 裡這一場之前的最後一場
ok(P.F.tl.map(x => x.d).join() === [...P.F.tl.map(x => x.d)].sort().join() && P.F.tl[0].k === 'prev' && P.F.tl[0].d === PREV2382 && P.F.tl.some(x => x.k === 'cur' && x.d === D2382),
   '② 時間軸照日期排(上一場 → 這一場 → 月營收 → 財報期限)', JSON.stringify(P.F.tl));
ok(/這檔 \+10\.0% ・0050 \+2\.0%/.test(P.prompt), '② 開完到現在 = 法說會那天收盤 → 最新收盤(這檔 +10.0%・0050 +2.0%)');
ok(!/【法人問答】/.test(data), '⑦ 不是台積電 → 【資料】⛔ 法人問答');

// ── ③ 畫布:同一份資料、⛔ AI 摘要、紅綠只在漲跌數字、改數字跟著變
const fp = () => pg.evaluate(() => { const d = document.getElementById('ccImgCv').toDataURL('image/png'); let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d.charCodeAt(i)) | 0; return { h, len: d.length, dbg: PRO._ccImgDbg }; });
await pg.evaluate(() => PRO.confImgOpen('2382'));
await pg.waitForTimeout(150);
const C1 = await fp();
const T1 = C1.dbg.texts.join('');
const noEmo = t => String(t).replace(/⚠️\s*/g, '注意:');
ok(C1.dbg.sym === '2382' && C1.dbg.secs.join() === '01,02,03,04,05,07,08' && C1.len > 20000, '③ 畫了 8 段(不是台積電 ⛔ 06 問答)、而且真的有畫', JSON.stringify({ secs: C1.dbg.secs, len: C1.len }));
ok(T1.includes(P.FOOT.split(' ・ ')[0]) && T1.includes('這不是投資建議') && T1.includes(P.PXN), '③ 畫布頁尾 + 「本站實測」那句 = 同一組常數');
ok(P.lines.every(l => T1.includes(noEmo('・' + l).replace(/\s+/g, ' ')) || T1.replace(/\s+/g, '').includes(noEmo(l).replace(/\s+/g, ''))), '③ 畫布「本站對帳」= _confFacts().lines');
ok(!T1.includes('__本站AI摘要'), '③ ⛔ 本站 AI 摘要上畫布');
const EMO = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️]/u;
ok(!C1.dbg.texts.some(t => EMO.test(t)), '⑧ 畫布 ⛔ emoji(沙箱 / 各家字型寬度不一)', C1.dbg.texts.find(t => EMO.test(t)));
ok(!C1.dbg.texts.some(t => /undefined|NaN|\bnull\b|\[object/.test(t)), '⑥ 畫布沒有 undefined / NaN / null');
ok(!DIR.test(T1), '⑥ 畫布 ⛔ 方向 / 分數 / 買賣字眼', (T1.match(DIR) || [])[0]);
const redGreen = C1.dbg.fills.filter(f => [P.S.up, P.S.dn].includes(f.col));
ok(redGreen.length === 2 && redGreen.every(f => /^[+-]\d+\.\d%$/.test(f.t)) && redGreen.every(f => f.col === (f.t.startsWith('-') ? P.S.dn : P.S.up)),
   '⑤ 紅綠只出現在「開完到現在」兩個漲跌數字、而且紅漲綠跌', JSON.stringify(redGreen));
ok(C1.dbg.dpr <= 2 && 780 * C1.dbg.H * C1.dbg.dpr * C1.dbg.dpr <= 16.1e6, '⑧ 畫布像素數在 iOS 上限內(太長自動降解析度)', JSON.stringify({ H: C1.dbg.H, dpr: C1.dbg.dpr }));
// 換掉 AI 摘要 → 一個像素都不變
await pg.evaluate(() => { const J = PRO._confCC['2382']; J.decks[0].ai.one = '換一句完全不一樣的 AI 摘要'; PRO._confDrawOwn('2382'); });
const C2 = await fp();
ok(C2.h === C1.h && C2.dbg.texts.join('') === T1, '③ 換掉本站 AI 摘要 → 畫布一個像素都不變(決定性對照)');
// 改一個數字 → 畫布跟著變:K 線最新收盤 110 → 90(+10% → −10%,紅變綠)
await pg.evaluate(K => { PRO._cache['data/2382.json'] = K; PRO._confDrawOwn('2382'); }, kl(D2382, 100, 90));
const C3 = await fp();
const rg3 = C3.dbg.fills.filter(f => [P.S.up, P.S.dn].includes(f.col));
ok(C3.h !== C1.h && rg3.some(f => f.t === '-10.0%' && f.col === P.S.dn) && rg3.some(f => f.t === '+2.0%' && f.col === P.S.up),
   '④ 改 K 線(+10% → −10%)→ 畫布跟著變、跌的那個變綠', JSON.stringify(rg3));
// 改簡報裡一個數字 → 提示詞與畫布都跟著變
const R4 = await pg.evaluate(() => { const J = PRO._confCC['2382']; J.decks[0].nums[1][1] = '營收季增 6% 到 9%'; PRO._confDrawOwn('2382'); return { p: PRO._confImgPrompt('2382'), t: PRO._ccImgDbg.texts.join('') }; });
ok(/「營收季增 6% 到 9%」/.test(R4.p) && R4.t.includes('營收季增 6% 到 9%') && !R4.t.includes('營收季增 5% 到 8%'), '④ 改簡報裡的數字 → 提示詞與畫布一起變(⛔ 寫死)');
await pg.evaluate(() => PRO.closeModal());

// ── ⑥ 缺資料:沒有簡報 / 讀不到 K 線 → 「本站沒有」⛔ undefined
await plant();
const R6 = await pg.evaluate(async () => { await PRO._confPrep('6488'); PRO.confImgOpen('6488'); const d = PRO._ccImgDbg; return { p: PRO._confImgPrompt('6488'), F: PRO._confImgFacts('6488'), t: d.texts.join('|') }; });
ok((R6.p.match(/本站沒有這一段/g) || []).length >= 4 && !/undefined|NaN|\bnull\b/.test(R6.p) && !/undefined|NaN|\bnull\b/.test(R6.t),
   '⑥ 沒有簡報 → 每段寫「本站沒有這一段」、⛔ undefined / NaN / null', (R6.p.match(/undefined|NaN|\bnull\b/) || [])[0]);
ok(R6.F.px === null && R6.F.miss.some(x => /讀不到 K 線/.test(x)) && /簡報重點/.test(R6.F.miss.join()), '⑥ K 線讀到是空的 → 寫「讀不到」', JSON.stringify(R6.F.miss));
const R6b = await pg.evaluate(async () => {
  const before = PRO._confImgFacts('9998');                 // 還沒讀 → 還在讀
  await PRO._confPrep('9998');
  const after = PRO._confImgFacts('9998');                  // 讀過了、檔案不在(快取裡還是 undefined)→ 讀不到
  return { b: before.miss, a: after.miss, bpx: before.px, apx: after.px, cached: PRO._cache['data/9998.json'] === undefined };
});
ok(R6b.cached && R6b.bpx && R6b.bpx.wait && R6b.b.some(x => /K 線還在讀/.test(x)) && R6b.apx === null && R6b.a.some(x => /讀不到 K 線/.test(x)) && !R6b.a.some(x => /還在讀\)/.test(x) && /K 線/.test(x)),
   '⑥ 還沒讀 → 「還在讀」;讀過但檔案不在 → 「讀不到」(⛔ 混為一談)', JSON.stringify(R6b));
await pg.evaluate(() => PRO.closeModal());

// ── ⑦ 台積電:有問答(而且是這一場那一季);延期還沒開 → 會前準備
const R7 = await pg.evaluate(async () => {
  await PRO._confPrep('2330'); PRO.confImgOpen('2330'); const d1 = PRO._ccImgDbg;
  const o = { p: PRO._confImgPrompt('2330'), secs: d1.secs.slice(), t: d1.texts.join('') };
  PRO.closeModal();
  await PRO._confPrep('1303'); PRO.confImgOpen('1303'); const d2 = PRO._ccImgDbg;
  o.F13 = PRO._confImgFacts('1303'); o.p13 = PRO._confImgPrompt('1303'); o.t13 = d2.texts.join('|'); o.secs13 = d2.secs.slice();
  PRO.closeModal();
  return o;
});
ok(R7.secs.includes('06') && /【法人問答】2026 第 3 季/.test(R7.p) && /某證券 問:今年 AI 需求如何\?/.test(R7.p) && !/上一季的問題/.test(R7.p) && R7.t.includes('某證券 問:'),
   '⑦ 台積電:法人問答 = 這一場那一季(⛔ 拿上一季)、畫布有 06 段', JSON.stringify(R7.secs));
ok(R7.F13.kind === '延期・還沒開' && /^原訂 \d\d\/\d\d,公司公告可能延到/.test(R7.F13.three[0]) && /【開完到現在】還沒開/.test(R7.p13)
   && R7.t13.includes('法說會・會前準備') && !R7.secs13.includes('06'),
   '⑦ 延期還沒開:標籤 / 第一句 / 開完到現在 / 標題改「會前準備」', JSON.stringify({ k: R7.F13.kind, t: R7.F13.three[0] }));
ok(R7.F13.tl[0].k === 'prev' && R7.F13.tl[0].d === dOff(-12) && !R7.F13.tl.some(x => x.k === 'prev' && x.d === D1303),
   '⑦ 延期那一場的原訂日期 ⛔ 被當成「上一場」', JSON.stringify(R7.F13.tl));
ok(R7.t13.includes('公司備註:如台北市政府公告停止上班') && !R7.t13.includes('⛔'), '⑦ 畫布的公司備註只放公司原文(⛔ 給 AI 的指令)');

// ── ⑧ 公司檔案按鈕 + 手機上提示蓋得過公司檔案 + 390 / 844 不橫捲
await plant();
await pg.evaluate(() => PRO.switchTab('conf'));
await pg.waitForTimeout(500);
const R8b = await pg.evaluate(async () => {
  const row = document.querySelector('[data-conf-row="2382"]'); if (row) row.click();
  for (let i = 0; i < 40 && !document.querySelector('#confDossier [data-ccimg="prompt"]'); i++) await new Promise(r => setTimeout(r, 50));
  const bp = document.querySelector('#confDossier [data-ccimg="prompt"]'), bo = document.querySelector('#confDossier [data-ccimg="own"]');
  const zT = +getComputedStyle(document.getElementById('toast')).zIndex, zD = +getComputedStyle(document.getElementById('confDossier')).zIndex;
  if (bo) bo.click();
  await new Promise(r => setTimeout(r, 200));
  const cv = document.querySelector('#proModal [data-ccimg-cv]');
  window.scrollTo(80, 0);
  return { bp: !!bp, bo: !!bo, zT, zD, cv: !!cv, cvW: cv ? cv.getBoundingClientRect().width : 0, vw: innerWidth, sx: scrollX, sym: PRO._ccImgDbg && PRO._ccImgDbg.sym };
});
ok(R8b.bp && R8b.bo && R8b.cv && R8b.sym === '2382', '⑧ 公司檔案有「🎨 做圖提示詞」「🖼️ 本站畫的圖」;點了開視窗畫這一檔', JSON.stringify(R8b));
ok(R8b.zT > R8b.zD && R8b.zT > 98, '⑧ 提示(toast)蓋得過手機上的公司檔案與視窗(以前 90 < 96,按了看不到「已複製」)', JSON.stringify({ zT: R8b.zT, zD: R8b.zD }));
ok(R8b.sx <= 2 && R8b.cvW <= R8b.vw, '⑧ 390px:視窗裡的圖不撐寬頁面', JSON.stringify(R8b));
await pg.setViewportSize({ width: 844, height: 390 });
await pg.waitForTimeout(200);
const R8c = await pg.evaluate(() => { window.scrollTo(80, 0); const cv = document.querySelector('#proModal [data-ccimg-cv]'); return { sx: scrollX, cvW: cv ? cv.getBoundingClientRect().width : 0, vw: innerWidth }; });
ok(R8c.sx <= 2 && R8c.cvW > 0 && R8c.cvW <= R8c.vw, '⑧ 844×390 橫拿也不橫捲', JSON.stringify(R8c));
ok(!errs.length, '沒有 pageerror', errs.join(' | '));
await b.close();
console.log(bad ? `\n❌ CONFIMG_FAIL ${bad}` : '\n✅ CONFIMG_PASS');
process.exit(bad ? 1 : 0);
