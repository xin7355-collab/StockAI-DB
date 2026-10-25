// 🎤 V79.7.6 產業作戰室法說會頁「問答重點」(data/cc_qa/{sym}.json,confcall_qa.py 寫的)
//   使用者 2026-10-25:「我要台積電的」→ 最近 4 季 + 放進產業作戰室法說會頁。
//
// ⛔ 釘死的事(注入都要叫得出來):
//   ① 公司清單 pro `_CONF_QA_SYMS` == confcall_qa.COMPANIES(跨檔比對)
//   ② 挑了台積電 → 最新一季照題目分組;機構 / 誰答 / 官方原文連結;改測資畫面跟著變(決定性對照)
//   ③ 最近 4 季對照:同一個題目每一季怎麼答,這季沒人問要寫出來
//   ④ 讀不到檔 ≠ 沒有問答(陷阱 #22);還沒有的季照 todo 寫原因
//   ⑤ 挑別檔 / 讀回來已經換了一檔 → ⛔ 畫(陷阱 #19)
//   ⑥ 法說會卡片:只有財報那一場有 🎤(券商邀請場 ⛔);展開 = 那一季的問答
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
const D_EARN = dOff(-4), D_INV = dOff(-2), D_OLD = dOff(-200);
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
await pg.route('**/*', r => (r.request().url().startsWith('file://') && !/cc_qa/.test(r.request().url()) ? r.continue() : r.abort()));
await pg.goto(pathToFileURL(resolve('pro.html')).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderConf, null, { timeout: 30000 });
await pg.evaluate(({ CONF, QA }) => {
  PRO._cache['data/confcall.json'] = CONF;
  PRO._cache['data/confcall_digest.json'] = { updated: '', days: 60, n: 0, rows: [] };
  PRO._cache['data/cc_qa/2330.json'] = QA;
  window.__QA = QA;
  PRO._cache['data/playbook_edge.json'] = { picks: [] };
  PRO._cache['data/screener.json'] = { rows: [] };
  PRO._names = Object.assign(PRO._names || {}, { 2330: '台積電', 2382: '廣達' });
  PRO.loadNames = async () => PRO._names;
  PRO._confPrep = async () => {};
  try { localStorage.removeItem('proTerminalInv'); } catch (_) {}
}, { CONF, QA });
await pg.evaluate(() => PRO.switchTab('conf'));
await pg.waitForTimeout(700);

// ── ② 挑了台積電 → 最新一季
const R2 = await pg.evaluate(async () => {
  PRO.confPick('2330');
  await new Promise(r => setTimeout(r, 300));
  const el = document.getElementById('confQa');
  const blk = el.querySelector('[data-qa-block]');
  const q = el.querySelector('[data-qa-q]');
  return {
    blk: !!blk, q: q ? q.getAttribute('data-qa-q') : '', head: q ? q.textContent : '',
    tags: [...el.querySelectorAll(':scope [data-qa-block] > .note > [data-qa-tag]')].map(x => x.getAttribute('data-qa-tag')),
    items: [...el.querySelectorAll('[data-qa-block] > .note > [data-qa-tag] [data-qa-item]')].map(x => x.textContent),
    link: (q && q.querySelector('a')) ? q.querySelector('a').getAttribute('href') : '',
    foot: el.querySelector('[data-qa-foot]')?.textContent || '', todo: el.querySelector('[data-qa-todo]')?.textContent || '',
    note: el.querySelector('[data-qa-note]')?.textContent || '', img: !!el.querySelector('img'), xss: !!window.__xss,
    txt: (el.innerText || '').replace(/\s+/g, ' '), boldEl: [...el.querySelectorAll('[data-qa-item] b')].some(x => x.textContent === '粗體'),
  };
});
ok(R2.blk && R2.q === '2026Q3', '② 挑了台積電 → 出現問答重點、預設最新一季(2026Q3)', JSON.stringify(R2).slice(0, 200));
const wantTags = ['資本支出', '毛利率', '先進封裝', '其他'].sort((a, b) => pyTags.indexOf(a) - pyTags.indexOf(b));
ok(JSON.stringify(R2.tags) === JSON.stringify(wantTags), '② 照題目分組、順序照固定分類清單(confcall_qa.TAGS)', JSON.stringify(R2.tags));
ok(R2.items.some(x => /JPMorgan Chase 問:分析師問明年資本支出/.test(x) && /董事長答:公司預期明年資本支出 52 到 56 billion 美元/.test(x)),
   '② 每一句「機構 問 → 誰 答」', R2.items[0]);
ok(/2026 第 3 季法說會/.test(R2.head) && /3 位分析師提問/.test(R2.head) && /整理 4 句/.test(R2.head) && /3Q26%20Transcript/.test(R2.link),
   '② 季別 / 幾位分析師 / 整理幾句(skip ⛔ 算)/ 官方原文連結', R2.head + ' | ' + R2.link);
ok(/還有 1 題 AI 還沒整理/.test(R2.foot) && /整句拿掉 2 句/.test(R2.foot) && /拿掉 1 句/.test(R2.foot), '② 底下寫 AI 沒整理幾題 / 數字對不上丟幾句 / 不是中文丟幾句', R2.foot);
ok(/2026 第 1 季:逐字稿下載不到/.test(R2.todo) && /2025 第 4 季:季度頁上還沒有逐字稿/.test(R2.todo), '④ 還沒有的季照 todo 寫原因', R2.todo);
ok(/以官方原文為準/.test(R2.note) && /不是買賣建議/.test(R2.note) && /版權屬原作者/.test(R2.note) && /換算單位/.test(R2.note), '② 固定說明:AI 整理 / 以原文為準 / 版權 / 不是建議', R2.note);
ok(!R2.img && !R2.xss && !R2.boldEl, '⑦ AI 文字一律跳脫(<img onerror> / <b> ⛔ 變成元素)');
const DIR = /偏多|偏空|利多|利空|看多|看空|加碼|減碼|會漲|會跌|勝率|買進|賣出/;
ok(!DIR.test(R2.txt), '⑦ 整塊⛔ 方向詞 / 勝率 / 買賣', (R2.txt.match(DIR) || [])[0]);

// ── ③ 4 季對照
const R3 = await pg.evaluate(() => {
  const el = document.getElementById('confQa');
  const cmp = el.querySelector('[data-qa-compare]');
  const blk = t => cmp && cmp.querySelector(`[data-qa-cmp="${t}"]`);
  const q = (t, y) => blk(t)?.querySelector(`[data-qa-cmpq="${y}"]`)?.textContent || '';
  return { has: !!cmp, capex3: q('資本支出', '2026Q3'), capex2: q('資本支出', '2026Q2'), os3: q('海外廠', '2026Q3'), os2: q('海外廠', '2026Q2'),
           sum: cmp?.querySelector('summary')?.textContent || '' };
});
ok(R3.has && /最近 2 季/.test(R3.sum), '③ 有「最近 N 季,同一個題目公司怎麼講」(N = 真的有的季數)', R3.sum);
ok(/52 到 56/.test(R3.capex3) && /40 到 42/.test(R3.capex2), '③ 同一個題目(資本支出)列出每一季公司怎麼答', `${R3.capex3} | ${R3.capex2}`);
ok(/這一季沒有人問/.test(R3.os3) && /亞利桑那/.test(R3.os2), '③ 這一季沒人問那個題目 → 寫出來(⛔ 空白)', `${R3.os3} | ${R3.os2}`);

// ── ② 決定性對照:改測資 → 畫面跟著變
const R2b = await pg.evaluate(async () => {
  const J = PRO._cache['data/cc_qa/2330.json'];
  const keep = J.quarters[0].items[0].a;
  J.quarters[0].items[0].a = '公司預期明年資本支出 70 billion 美元';
  PRO._confQaJ = {};
  await PRO._confQaPaint('2330');
  const t = document.getElementById('confQa').innerText;
  J.quarters[0].items[0].a = keep; PRO._confQaJ = {};
  return /70 billion/.test(t) && !/52 到 56/.test(t.split('📈')[0]);
});
ok(R2b, '② ⭐ 決定性對照:測資改成 70 billion → 畫面跟著變(⛔ 寫死)');

// ── ⑤ 挑別檔 → 清掉;讀回來已經換了一檔 → ⛔ 畫
const R5 = await pg.evaluate(async () => {
  PRO.confPick('2382'); await new Promise(r => setTimeout(r, 200));
  const other = document.getElementById('confQa').innerHTML;
  const orig = PRO.fetchJson.bind(PRO);
  PRO._confQaJ = {}; delete PRO._cache['data/cc_qa/2330.json'];
  const J = window.__QA;
  PRO.fetchJson = async (p, t) => (/cc_qa/.test(p) ? new Promise(r => setTimeout(() => r(J), 250)) : orig(p, t));
  PRO.confPick('2330');
  PRO.confPick('2382');
  await new Promise(r => setTimeout(r, 500));
  const late = document.getElementById('confQa').innerHTML;
  PRO.fetchJson = orig;
  PRO._cache['data/cc_qa/2330.json'] = J;
  return { other, late };
});
ok(R5.other === '', '⑤ 挑了沒有逐字稿的公司 → 這一塊整塊不出現', R5.other.slice(0, 80));
ok(R5.late === '', '⑤ ⭐ 讀回來已經換了一檔 → ⛔ 畫上一檔的問答(陷阱 #19)', R5.late.slice(0, 120));

// ── ④ 讀不到檔
const R4 = await pg.evaluate(async () => {
  const J = PRO._cache['data/cc_qa/2330.json'];
  delete PRO._cache['data/cc_qa/2330.json']; PRO._confQaJ = {};
  PRO.confPick('2330'); await new Promise(r => setTimeout(r, 600));
  const t = document.getElementById('confQa').querySelector('[data-qa-nofile]')?.textContent || '';
  PRO._cache['data/cc_qa/2330.json'] = J;
  return t;
});
ok(/讀不到問答重點檔/.test(R4) && /不代表法說會沒有問答/.test(R4), '④ 讀不到檔 → 說「檔案沒產出或網路失敗」(⛔ 說成沒有問答)', R4);

// ── ⑥ 法說會卡片:財報那一場才有 🎤;展開 = 那一季
const R6 = await pg.evaluate(async () => {
  PRO._confQaJ = {};
  PRO.confSel('new');
  PRO._confPaint();
  const cards = [...document.querySelectorAll('#tabConf [data-conf-card][data-conf-row="2330"]')];
  const dets = cards.map(c => c.querySelector('details[data-dk^="ccqa-"]'));
  const q2382 = document.querySelector('#tabConf [data-conf-card][data-conf-row="2382"] details[data-dk^="ccqa-"]');
  const earn = dets.find(Boolean);
  let body = '', q = '';
  if (earn) {
    earn.open = true;
    const d = earn.getAttribute('ontoggle').match(/'(\d{4}-\d\d-\d\d)'/)[1];
    await PRO.confQaOpen(earn, '2330', d);
    const box = earn.querySelector('[data-ccqa-body]');
    body = box.innerText; q = box.querySelector('[data-qa-q]')?.getAttribute('data-qa-q') || '';
  }
  // 那一季沒有整理好的(在 todo 裡)→ 寫原因
  const fake = document.createElement('details'); fake.open = true; fake.innerHTML = '<div data-ccqa-body></div>';
  await PRO.confQaOpen(fake, '2330', '2026-04-16');
  return { n: cards.length, withQa: dets.filter(Boolean).length, q2382: !!q2382, q, body, todoTxt: fake.textContent };
});
ok(R6.n === 2 && R6.withQa === 1, '⑥ 台積電兩場:財報那場有 🎤、券商邀請場 ⛔ 有', JSON.stringify(R6).slice(0, 160));
ok(!R6.q2382, '⑥ 沒有官方逐字稿的公司(廣達)⛔ 有 🎤');
ok(R6.q === '2026Q3' && /資本支出/.test(R6.body), '⑥ 展開財報那場 → 那一季(日期對得上)的問答', R6.q + ' | ' + R6.body.slice(0, 120));
ok(/2026 第 1 季:逐字稿下載不到/.test(R6.todoTxt), '⑥ 那一季還沒有 → 照 todo 寫原因(⛔ 空白)', R6.todoTxt.slice(0, 120));

// ── ⑦ 390px 不溢出(產業作戰室沒有 Tailwind → 量到的就是真的幾何)
const R7 = await pg.evaluate(async () => {
  PRO.confPick('2330'); await new Promise(r => setTimeout(r, 300));
  const src = document.getElementById('confQa');
  src.querySelectorAll('details').forEach(d => { d.open = true; });
  window.scrollTo(80, 0); const wide = window.scrollX > 2; window.scrollTo(0, 0);
  const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:0;top:0;width:358px;max-width:358px;display:block';
  const box = src.cloneNode(true); box.removeAttribute('id'); host.appendChild(box); document.body.appendChild(host);
  const out = [];
  for (const el of box.querySelectorAll('div,span,a,details,summary,b')) {
    if (!el.offsetParent) continue;
    const pa = el.parentElement; if (!pa) continue;
    const a = el.getBoundingClientRect(), p = pa.getBoundingClientRect();
    if (p.width < 40 || a.width < 20) continue;
    const over = Math.round(a.right - p.right);
    if (over > 6) out.push(`${el.tagName}+${over}`);
  }
  const w = Math.round(box.getBoundingClientRect().width), n = box.querySelectorAll('[data-qa-item]').length;
  host.remove();
  return { wide, w, n, out: out.slice(0, 6) };
});
ok(R7.w >= 350 && R7.n >= 4, '⑦ 🚧 空過守門:量測容器 358px 而且裡面真的有問答', JSON.stringify(R7));
ok(!R7.wide && R7.out.length === 0, '⑦ 390px:頁面不橫捲、沒有東西超出父層', JSON.stringify(R7));
ok(errs.length === 0, '⑦ 沒有 pageerror', errs.join(' | '));

await b.close();
console.log(bad ? `\n❌ 失敗 ${bad} 條` : '\n✅ 全部通過');
process.exit(bad ? 1 : 0);
