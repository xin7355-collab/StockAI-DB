// 🎤 V79.7.6 產業作戰室法說會頁「問答重點」(data/cc_qa/{sym}.json,confcall_qa.py 寫的)
//   使用者 2026-10-25:「我要台積電的」→ 最近 4 季 + 放進產業作戰室法說會頁。
//   📞 V79.7.7 改版「法說會情報中心」:問答搬進「公司檔案」的 🎤 問答分頁 + 總覽那一格「🎤 台積電問答」(點了直接開)
//
// ⛔ 釘死的事(注入都要叫得出來):
//   ① 公司清單 pro `_CONF_QA_SYMS` == confcall_qa.COMPANIES(跨檔比對)
//   ② 點「🎤 台積電問答」那一格 → 公司檔案停在問答分頁、最新一季照題目分組;機構 / 誰答 / 官方原文連結;
//      改測資畫面跟著變(決定性對照);總覽那一格的句數讀檔(決定性對照)
//   ③ 最近 N 季對照:同一個題目每一季怎麼答,這季沒人問要寫出來
//   ④ 讀不到檔 ≠ 沒有問答(陷阱 #22);失敗 ⛔ 記住(再點一次會重試);還沒有的季照 todo 寫原因
//   ⑤ 讀取中換了一檔 / 換了分頁 → ⛔ 畫上一檔的問答(陷阱 #19);讀取中重畫幾次只發一個請求
//   ⑥ 清單:只有財報那一場有 🎤(券商邀請場 ⛔);券商邀請場打開問答要說清楚是最近一季;沒有逐字稿的公司 ⛔ 有問答分頁
//   ⑦ AI 文字跳脫、skip 的不顯示、⛔ 方向詞、390px 不溢出
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : (e ? ' — ' + String(e).slice(0, 300) : '')}`); if (!c) bad++; };

// ── ① 跨檔:公司清單一字不差
const PRO_SRC = readFileSync('pro.html', 'utf8');
const pySyms = JSON.parse(execFileSync('python3', ['-c', 'import json, confcall_qa as Q; print(json.dumps(sorted(Q.COMPANIES)))'], { encoding: 'utf8' }).trim());
const m = PRO_SRC.match(/_CONF_QA_SYMS: \[([^\]]*)\]/);
const proSyms = m ? JSON.parse('[' + m[1].replace(/'/g, '"') + ']').sort() : null;
ok(proSyms && JSON.stringify(proSyms) === JSON.stringify(pySyms), '① 公司清單 pro `_CONF_QA_SYMS` == confcall_qa.COMPANIES', `${JSON.stringify(proSyms)} vs ${JSON.stringify(pySyms)}`);
const pyTags = JSON.parse(execFileSync('python3', ['-c', 'import json, confcall_qa as Q; print(json.dumps(Q.TAGS, ensure_ascii=False))'], { encoding: 'utf8' }).trim());

// ── 測資(形狀照 confcall_qa.run 的產物)
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const dOff = n => { const d = new Date(today + 'T12:00:00+08:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); };
const D_EARN = dOff(-4), D_INV = dOff(-2);
const it = (i, tag, org, by, q, a, extra) => Object.assign({ i, k: 0, tag, org, by, q, a }, extra || {});
const QA = {
  sym: '2330', name: '台積電', updated: `${today} 08:00`, src: '公司官方法說會逐字稿', tags: pyTags, show: 4,
  quarters: [
    { yq: '2026Q3', y: 2026, q: 3, d: D_EARN, url: 'https://investor.tsmc.com/english/encrypt/files/x/TSMC%203Q26%20Transcript.pdf', q_n: 3,
      items: [it(0, '資本支出', 'JPMorgan Chase', '董事長', '分析師問明年資本支出', '公司預期明年資本支出 52 到 56 billion 美元'),
              it(0, '毛利率', 'JPMorgan Chase', '財務長', '分析師問長期毛利率', '公司說長期毛利率 56% 以上做得到', { k: 1 }),
              it(1, '先進封裝', 'Morgan Stanley', '董事長', '分析師問 CoWoS 產能', '公司說 CoWoS 產能明年會再倍增'),
              it(2, '其他', 'UBS', '董事長', '<img src=x onerror="window.__xss=1">分析師問', '公司回答<b>粗體</b>'),
              { i: 3, k: 0, skip: 1 }],
      drop: 2, lang: 1, miss: 1, model: 'qwen/qwen3.8-27b', parse: { an: 9, co: 20 }, at: today, tries: 1 },
    { yq: '2026Q2', y: 2026, q: 2, d: '2026-07-16', url: 'https://investor.tsmc.com/english/encrypt/files/x/TSMC%202Q26%20Transcript.pdf', q_n: 2,
      items: [it(0, '資本支出', 'Citi', '財務長', '分析師問今年資本支出', '公司說今年資本支出維持 40 到 42 billion 美元'),
              it(1, '海外廠', 'Goldman Sachs', '董事長', '分析師問美國廠進度', '公司說亞利桑那第二座廠提前量產')],
      drop: 0, lang: 0, miss: 0, model: 'qwen/qwen3.8-27b', parse: { an: 7, co: 15 }, at: today, tries: 1 },
  ],
  todo: [{ yq: '2026Q1', why: '逐字稿下載不到(HTTP 503)' }, { yq: '2025Q4', why: '季度頁上還沒有逐字稿(法說會還沒開,或官方還沒放上來)' }],
  ai: { calls: 6, ok: 6, fail: 0 },
};
const row = (s, name, d, sum) => ({ s, name, mkt: '上市', d, t: '14:00', place: '線上', sum, pdf: [], web: '', vid: '', other: '' });
const CONF = {
  updated: `${today}T09:00:00Z`, data_date: today, src: { host: 'https://mopsov.twse.com.tw', page: 'x', months: [], file: null }, src_error: {},
  window: { past: 60, future: 45 }, upcoming: [],
  recent: [row('2330', '台積電', D_EARN, '(1)公布本公司2026年第3季財務報告及2026年第4季業績展望。'),
           row('2330', '台積電', D_INV, '本公司受邀參加某證券舉辦之投資論壇,就本公司第3季財務報告進行說明。'),
           row('2382', '廣達', D_EARN, '公布第3季財務報告')],
  hist: {}, n: { upcoming: 0, recent: 3, with_sum: 3, with_files: 0 },
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
// ⛔ 本機 data/ 不讀(結果不可以看這台機器剛好有什麼檔):只放行 pro.html 本身,其他一律走下面塞好的快取
await pg.route('**/*', r => (r.request().url().startsWith('file://') && !/\/data\//.test(r.request().url()) ? r.continue() : r.abort()));
await pg.goto(pathToFileURL(resolve('pro.html')).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderConf, null, { timeout: 30000 });
await pg.evaluate(({ CONF, QA }) => {
  PRO._cache['data/confcall.json'] = CONF;
  PRO._cache['data/confcall_digest.json'] = { updated: '', days: 60, n: 0, rows: [] };
  PRO._cache['data/cc_qa/2330.json'] = QA;
  PRO._cache['data/cc/2330.json'] = { sym: '2330', decks: [] };
  PRO._cache['data/cc/2382.json'] = { sym: '2382', decks: [] };
  PRO._cache['data/cc_radar.json'] = null;
  window.__QA = QA;
  PRO._cache['data/playbook_edge.json'] = { picks: [] };
  PRO._cache['data/screener.json'] = { rows: [] };
  PRO._names = Object.assign(PRO._names || {}, { 2330: '台積電', 2382: '廣達' });
  PRO.loadNames = async () => PRO._names;
  PRO._confPrep = async () => {};
  try { localStorage.removeItem('proTerminalInv'); } catch (_) {}
}, { CONF, QA });
await pg.evaluate(() => PRO.switchTab('conf'));
await pg.waitForFunction(() => document.querySelector('#confKpi [data-conf-qa]'), null, { timeout: 20000 });
await pg.waitForTimeout(500);

// ── ② 總覽那一格:讀檔(背景讀到就更新)+ 決定性對照
const R0 = await pg.evaluate(() => {
  const t = document.querySelector('#confKpi [data-conf-qa="2330"]')?.innerText.replace(/\s+/g, ' ') || '';
  const J = PRO._confQaJ['2330'];
  const J2 = JSON.parse(JSON.stringify(J)); J2.quarters[0].items = J2.quarters[0].items.slice(0, 2); J2.quarters[0].yq = '2026Q9';
  PRO._confQaJ['2330'] = J2;
  const box = document.createElement('div'); box.innerHTML = PRO._confKpiHtml();
  const t2 = box.querySelector('[data-conf-qa]')?.innerText.replace(/\s+/g, ' ') || '';
  PRO._confQaJ['2330'] = J;
  return { t, t2 };
});
ok(/台積電問答/.test(R0.t) && /4\s*句/.test(R0.t) && /2026Q3/.test(R0.t), '② 總覽「🎤 台積電問答」那一格:開頁就背景讀檔 → 最新一季幾句(skip ⛔ 算)', R0.t);
ok(/2\s*句/.test(R0.t2) && /2026Q9/.test(R0.t2), '② ⭐ 決定性對照:檔案少兩句、換一季 → 那一格跟著變(⛔ 寫死)', R0.t2);

// ── ② 點那一格 → 公司檔案停在問答分頁、最新一季
const R2 = await pg.evaluate(async () => {
  document.querySelector('#confKpi [data-conf-qa="2330"]').click();
  await new Promise(r => setTimeout(r, 300));
  const D = document.getElementById('confDossier');
  const blk = D.querySelector('[data-qa-block]');
  const q = blk && blk.querySelector('[data-qa-q]');
  return {
    on: D.classList.contains('on'), lock: document.body.classList.contains('cc-lock'),
    tab: PRO._ccdTab, tabs: [...D.querySelectorAll('[data-ccdtab]')].map(x => x.dataset.ccdtab),
    qaTabTxt: D.querySelector('[data-ccdtab="qa"]')?.innerText.replace(/\s+/g, '') || '',
    blk: !!blk, q: q ? q.getAttribute('data-qa-q') : '', head: q ? q.textContent : '',
    tags: blk ? [...blk.querySelectorAll(':scope > [data-qa-tag]')].map(x => x.getAttribute('data-qa-tag')) : [],
    items: blk ? [...blk.querySelectorAll(':scope > [data-qa-tag] [data-qa-item]')].map(x => x.textContent) : [],
    link: (q && q.querySelector('a')) ? q.querySelector('a').getAttribute('href') : '',
    foot: blk?.querySelector('[data-qa-foot]')?.textContent || '', todo: blk?.querySelector('[data-qa-todo]')?.textContent || '',
    note: blk?.querySelector('[data-qa-note]')?.textContent || '', img: !!D.querySelector('img'), xss: !!window.__xss,
    warn: !!blk?.querySelector('[data-qa-notearn],[data-qa-datediff]'),
    txt: (blk?.innerText || '').replace(/\s+/g, ' '), boldEl: blk ? [...blk.querySelectorAll('[data-qa-item] b')].some(x => x.textContent === '粗體') : false,
    sel: document.querySelector('#confBody .cc-row.sel')?.dataset.confKey || '',
  };
});
ok(R2.on && R2.lock && R2.tab === 'qa' && R2.blk && R2.q === '2026Q3', '② 點那一格 → 手機上公司檔案整頁蓋上來、停在問答分頁、最新一季(2026Q3)', JSON.stringify(R2).slice(0, 220));
ok(R2.tabs.join(',') === 'key,num,cmp,qa,info' && /問答4/.test(R2.qaTabTxt), '② 台積電的公司檔案有「🎤 問答」分頁,分頁上寫幾句', `${R2.tabs} | ${R2.qaTabTxt}`);
ok(R2.sel.startsWith(`2330|${'' + (await pg.evaluate(() => PRO._confAll().find(r => r.s === '2330' && PRO._confQaEarn(r)).d))}`) && !R2.warn,
   '② 開的是財報那一場(⛔ 券商邀請場),清單那一列標成選取;日期對得上 → ⛔ 多一句提醒', R2.sel);
const wantTags = ['資本支出', '毛利率', '先進封裝', '其他'].sort((a, b) => pyTags.indexOf(a) - pyTags.indexOf(b));
ok(JSON.stringify(R2.tags) === JSON.stringify(wantTags), '② 照題目分組、順序照固定分類清單(confcall_qa.TAGS)', JSON.stringify(R2.tags));
ok(R2.items.some(x => /JPMorgan Chase 問:分析師問明年資本支出/.test(x) && /董事長答:公司預期明年資本支出 52 到 56 billion 美元/.test(x)),
   '② 每一句「機構 問 → 誰 答」', R2.items[0]);
ok(/2026 第 3 季法說會/.test(R2.head) && /3 位分析師提問/.test(R2.head) && /整理 4 句/.test(R2.head) && /3Q26%20Transcript/.test(R2.link),
   '② 季別 / 幾位分析師 / 整理幾句(skip ⛔ 算)/ 官方原文連結', R2.head + ' | ' + R2.link);
ok(/還有 1 題 AI 還沒整理/.test(R2.foot) && /整句拿掉 2 句/.test(R2.foot) && /拿掉 1 句/.test(R2.foot), '② 底下寫 AI 沒整理幾題 / 數字對不上丟幾句 / 不是中文丟幾句', R2.foot);
ok(/2026 第 1 季:逐字稿下載不到/.test(R2.todo) && /2025 第 4 季:季度頁上還沒有逐字稿/.test(R2.todo), '④ 還沒有的季照 todo 寫原因(公司檔案打開哪一季都列)', R2.todo);
ok(/以官方原文為準/.test(R2.note) && /不是買賣建議/.test(R2.note) && /版權屬原作者/.test(R2.note) && /換算單位/.test(R2.note), '② 固定說明:AI 整理 / 以原文為準 / 版權 / 不是建議', R2.note);
ok(!R2.img && !R2.xss && !R2.boldEl, '⑦ AI 文字一律跳脫(<img onerror> / <b> ⛔ 變成元素)');
const DIR = /偏多|偏空|利多|利空|看多|看空|加碼|減碼|會漲|會跌|勝率|買進|賣出/;
ok(!DIR.test(R2.txt), '⑦ 整塊⛔ 方向詞 / 勝率 / 買賣', (R2.txt.match(DIR) || [])[0]);

// ── ③ 最近 N 季對照
const R3 = await pg.evaluate(() => {
  const cmp = document.querySelector('#confDossier [data-qa-block] [data-qa-compare]');
  const blk = t => cmp && cmp.querySelector(`[data-qa-cmp="${t}"]`);
  const q = (t, y) => blk(t)?.querySelector(`[data-qa-cmpq="${y}"]`)?.textContent || '';
  return { has: !!cmp, capex3: q('資本支出', '2026Q3'), capex2: q('資本支出', '2026Q2'), os3: q('海外廠', '2026Q3'), os2: q('海外廠', '2026Q2'),
           sum: cmp?.querySelector('summary')?.textContent || '' };
});
ok(R3.has && /最近 2 季/.test(R3.sum), '③ 有「最近 N 季,同一個題目公司怎麼講」(N = 真的有的季數)', R3.sum);
ok(/52 到 56/.test(R3.capex3) && /40 到 42/.test(R3.capex2), '③ 同一個題目(資本支出)列出每一季公司怎麼答', `${R3.capex3} | ${R3.capex2}`);
ok(/這一季沒有人問/.test(R3.os3) && /亞利桑那/.test(R3.os2), '③ 這一季沒人問那個題目 → 寫出來(⛔ 空白)', `${R3.os3} | ${R3.os2}`);

// ── ② 決定性對照:改測資 → 畫面跟著變
const R2b = await pg.evaluate(() => {
  const J = PRO._confQaJ['2330'];
  const keep = J.quarters[0].items[0].a;
  J.quarters[0].items[0].a = '公司預期明年資本支出 70 billion 美元';
  PRO._confDossierPaint();
  const t = [...document.querySelectorAll('#confDossier [data-qa-block] > [data-qa-tag]')].map(x => x.innerText).join(' ');
  J.quarters[0].items[0].a = keep;
  PRO._confDossierPaint();
  return /70 billion/.test(t) && !/52 到 56/.test(t);
});
ok(R2b, '② ⭐ 決定性對照:測資改成 70 billion → 畫面跟著變(⛔ 寫死)');

// ── ⑤ 讀取中換了一檔 / 換了分頁 → ⛔ 畫上一檔;讀取中重畫幾次只發一個請求
const R5 = await pg.evaluate(async () => {
  const orig = PRO.fetchJson.bind(PRO);
  const J = window.__QA;
  let calls = 0;
  PRO.fetchJson = async (p, t) => (/cc_qa/.test(p) ? (calls++, new Promise(r => setTimeout(() => r(J), 300))) : orig(p, t));
  const reset = () => { PRO._confQaJ = {}; delete PRO._cache['data/cc_qa/2330.json']; };
  // (a) 讀取中換到廣達
  reset();
  PRO.confOpenSym('2330', 'qa');
  const loading = !!document.querySelector('#confDossier [data-qa-loading]');
  PRO._confDossierPaint(); PRO._confDossierPaint();           // 讀取中又重畫兩次(例:簡報檔先回來)
  const k2382 = PRO._confKey(PRO._confAll().find(r => r.s === '2382'));
  PRO.confOpenD(k2382);
  await new Promise(r => setTimeout(r, 600));
  const D = document.getElementById('confDossier');
  const a = { loading, calls, sym: PRO._confDSym, qaBlk: !!D.querySelector('[data-qa-block]'), tabs: [...D.querySelectorAll('[data-ccdtab]')].map(x => x.dataset.ccdtab).join(','),
              headQa: /有問答重點/.test(D.querySelector('.ccd-head,[data-ccd-head]')?.innerText || D.innerText.split('\n').slice(0, 4).join(' ')) };
  // (b) 讀取中換到「重點」分頁
  reset(); calls = 0;
  PRO.confOpenSym('2330', 'qa');
  PRO.confDTab('key');
  await new Promise(r => setTimeout(r, 600));
  const bb = { tab: PRO._ccdTab, qaBlk: !!document.querySelector('#confDossier [data-qa-block]'), calls };
  PRO.fetchJson = orig;
  PRO._cache['data/cc_qa/2330.json'] = J; PRO._confQaJ = {};
  return { a, b: bb };
});
ok(R5.a.loading && R5.a.calls === 1, '⑤ 讀取中先顯示「讀取中」;讀取中重畫三次 → 只發 1 個請求(⛔ 重畫幾次發幾次)', JSON.stringify(R5.a));
ok(R5.a.sym === '2382' && !R5.a.qaBlk && R5.a.tabs === 'key,num,cmp,info' && !R5.a.headQa,
   '⑤ ⭐ 讀回來已經換了一檔 → ⛔ 畫上一檔的問答;沒有逐字稿的公司 ⛔ 有問答分頁(陷阱 #19)', JSON.stringify(R5.a));
ok(R5.b.tab === 'key' && !R5.b.qaBlk, '⑤ 讀取中換到別的分頁 → 讀回來 ⛔ 跳回問答', JSON.stringify(R5.b));

// ── ④ 讀不到檔 → 說清楚;⛔ 記住失敗(再點一次會重試)
const R4 = await pg.evaluate(async () => {
  const orig = PRO.fetchJson.bind(PRO);
  const J = window.__QA;
  let fail = true;
  PRO.fetchJson = async (p, t) => (/cc_qa/.test(p) ? (fail ? null : J) : orig(p, t));
  delete PRO._cache['data/cc_qa/2330.json']; PRO._confQaJ = {};
  PRO.confOpenSym('2330', 'qa');
  await new Promise(r => setTimeout(r, 200));
  const t = document.querySelector('#confDossier [data-qa-nofile]')?.textContent || '';
  const kpi = document.querySelector('#confKpi [data-conf-qa]')?.innerText || '';
  fail = false;
  PRO.confOpenSym('2330', 'qa');
  await new Promise(r => setTimeout(r, 200));
  const again = document.querySelector('#confDossier [data-qa-q]')?.getAttribute('data-qa-q') || '';
  PRO.fetchJson = orig; PRO._cache['data/cc_qa/2330.json'] = J;
  return { t, again, kpi };
});
ok(/讀不到問答重點檔/.test(R4.t) && /不代表法說會沒有問答/.test(R4.t), '④ 讀不到檔 → 說「檔案沒產出或網路失敗」(⛔ 說成沒有問答)', R4.t);
ok(R4.again === '2026Q3', '④ 讀不到 ⛔ 記住失敗:再點一次會重新讀(這次讀到就照常畫)', R4.again);

// ── ⑥ 清單:財報那一場才有 🎤;券商邀請場打開問答要說清楚
const R6 = await pg.evaluate(async () => {
  PRO.confCloseD();
  PRO.confSel('new');
  const rows = [...document.querySelectorAll('#confBody [data-conf-card][data-conf-row="2330"]')];
  const withQa = rows.filter(c => c.querySelector('[data-cc-qa]'));
  const q2382 = !!document.querySelector('#confBody [data-conf-row="2382"] [data-cc-qa]');
  const all = PRO._confAll();
  const earn = all.find(r => r.s === '2330' && PRO._confQaEarn(r)), inv = all.find(r => r.s === '2330' && !PRO._confQaEarn(r));
  const qaKey = withQa[0] ? withQa[0].dataset.confKey : '';
  PRO.confOpenD(PRO._confKey(inv), 'qa');
  await new Promise(r => setTimeout(r, 200));
  const D = document.getElementById('confDossier');
  const invTxt = D.querySelector('[data-qa-notearn]')?.textContent || '', invQ = D.querySelector('[data-qa-q]')?.getAttribute('data-qa-q') || '';
  // 那一季在 todo(還沒整理)→ 寫原因;財報那一場的日期跟檔案差一天 → 標出是哪一天那場
  const box = document.createElement('div');
  box.innerHTML = PRO._ccdQaHtml({ s: '2330', d: '2026-04-16', t: '14:00', sum: '公布本公司2026年第1季財務報告' }, '2330', 'x');
  const todoTxt = box.textContent;
  box.innerHTML = PRO._ccdQaHtml({ s: '2330', d: '2026-07-17', t: '14:00', sum: '公布本公司2026年第2季財務報告' }, '2330', 'x');
  const diffTxt = box.querySelector('[data-qa-datediff]')?.textContent || '', diffQ = box.querySelector('[data-qa-q]')?.getAttribute('data-qa-q') || '';
  return { n: rows.length, withQa: withQa.length, qaKey, earnKey: PRO._confKey(earn), q2382, invTxt, invQ, todoTxt, diffTxt, diffQ };
});
ok(R6.n === 2 && R6.withQa === 1 && R6.qaKey === R6.earnKey, '⑥ 台積電兩場:財報那場有 🎤、券商邀請場 ⛔ 有', JSON.stringify(R6).slice(0, 200));
ok(!R6.q2382, '⑥ 沒有官方逐字稿的公司(廣達)⛔ 有 🎤');
ok(/不是每季財報那一場/.test(R6.invTxt) && R6.invQ === '2026Q3', '⑥ 打開券商邀請場的問答 → 寫清楚「下面是最近一季」(⛔ 假裝是這一場的)', R6.invTxt);
ok(/2026 第 1 季:逐字稿下載不到/.test(R6.todoTxt), '⑥ 那一季還沒整理 → 照 todo 寫原因(⛔ 空白)', R6.todoTxt.slice(0, 160));
ok(/07\/16 那場財報法說會/.test(R6.diffTxt) && R6.diffQ === '2026Q2', '⑥ 財報那一場的日期跟檔案不同天 → 標出是哪一天那場的問答', R6.diffTxt);

// ── ⑦ 390px 不溢出(產業作戰室沒有 Tailwind → 量到的就是真的幾何)
const R7 = await pg.evaluate(async () => {
  PRO.confOpenSym('2330', 'qa'); await new Promise(r => setTimeout(r, 300));
  const D = document.getElementById('confDossier');
  D.querySelectorAll('details').forEach(d => { d.open = true; });
  window.scrollTo(80, 0); const wide = window.scrollX > 2; window.scrollTo(0, 0);
  const dr = D.getBoundingClientRect();
  const out = [];
  for (const el of D.querySelectorAll('div,span,a,details,summary,b,button')) {
    if (!el.getClientRects().length) continue;
    const pa = el.parentElement; if (!pa || pa === document.body) continue;
    const a = el.getBoundingClientRect(), p = pa.getBoundingClientRect();
    if (p.width < 40 || a.width < 20) continue;
    if (pa.scrollWidth > pa.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(pa).overflowX)) continue;   // 分頁列那種自己橫捲的
    const over = Math.round(a.right - p.right);
    if (over > 6) out.push(`${el.tagName}.${el.className}+${over}`);
  }
  return { wide, w: Math.round(dr.width), right: Math.round(dr.right), n: D.querySelectorAll('[data-qa-item]').length, cmp: D.querySelectorAll('[data-qa-cmpq]').length, out: out.slice(0, 6) };
});
ok(R7.w >= 350 && R7.n >= 4 && R7.cmp >= 4, '⑦ 🚧 空過守門:公司檔案真的有 350px 寬,而且裡面真的有問答 + 季對照', JSON.stringify(R7));
ok(!R7.wide && R7.right <= 390 && R7.out.length === 0, '⑦ 390px:頁面不橫捲、公司檔案不超出畫面、沒有東西超出父層', JSON.stringify(R7));
ok(errs.length === 0, '⑦ 沒有 pageerror', errs.join(' | '));

await b.close();
console.log(bad ? `\n❌ 失敗 ${bad} 條` : '\n✅ 全部通過');
process.exit(bad ? 1 : 0);
