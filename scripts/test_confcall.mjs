// 🎤 V77.2.7 產業作戰室「法說會」分頁 + 深度查詢(外部網頁深連結)
//   使用者:「把法說會資訊收集起來,在產業作戰室新增一個頁面;另外做深度查詢,貼關鍵字讓 AI 去搜;要有 Meta / Gemini / GPT」
//   選項確認:收集 = 時間表 + 內容;深度查詢 = 只要外部網頁(⛔ 不叫 App 內 AI);Meta/Gemini/GPT = 外部網站。
//
// ⛔ 六條不可違反(注入都要叫得出來,清單在檔尾):
//   ① 分頁真的註冊(TABS / switchTab lazy render / 容器在 .wrap 裡 / 鈕文字無 emoji)
//   ② 「檔案沒產出」與「這幾天真的沒有」⛔ 不可長得一樣(陷阱 #22)
//   ③ 篩選「👜 我的」= 庫存 ∪ 自選 ∪ 決策台今天名單,⛔ 不多不少
//   ④ 全頁⛔ 不可出現方向/部位詞(行事曆日方向實測 0 個成立)
//   ⑤ 深度查詢:先複製再點(⛔ 順序不可反)、href 對應引擎、Gemini/Meta 開根網址、⛔ 不可 window.open
//   ⑥ 資料日要標出來;採礦端 src_error 要顯示(⛔ 不可靜默)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); if (!c) bad++; };

const SRC = readFileSync('pro.html', 'utf8');
const SRC_NC = SRC.replace(/<!--[\s\S]*?-->/g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

// ── 原始碼守門 ①
const tabs = (SRC.match(/<div class="tabs">[\s\S]*?<\/div>/) || [''])[0].replace(/<!--[\s\S]*?-->/g, '');
ok(/\['conf', 'Conf'\]/.test(SRC_NC), '①a PRO.TABS 有 [conf, Conf]');
ok(/if \(t === 'conf'\) this\.renderConf\(\);/.test(SRC_NC), '①b switchTab 有 lazy render 那一行');
const btn = (tabs.match(/<button[^>]*id="tabBtnConf"[^>]*>([^<]*)<\/button>/) || [])[1] || '';
ok(btn === '法說會', '①c 分頁鈕文字 = 「法說會」(⛔ 無 emoji)', JSON.stringify(btn));
// ⚠️ 誠實紀錄:①d 第一版用「原始碼位置在 .wrap 開頭之後、stkSheet 之前」判 —— 注入「把容器搬到 .wrap 收尾之後」
//    照樣綠(它仍在那兩個錨點之間)= **沒有鑑別力**。改成真的問 DOM `.wrap #tabConf`(見下面 ①d)。
ok(!/window\.open\(/.test(SRC_NC), '⑤a ⛔ 不可 window.open(iOS PWA 會留空白分頁)');
ok(/proWar_confEng/.test(SRC_NC) && !/localStorage\.setItem\('proWar_ai'/.test(SRC_NC.slice(SRC_NC.indexOf('_CONF_ENG'))),
  '⑤b 深度查詢的引擎存自己的 key(⛔ 不共用 proWar_ai —— 免得改到產業估值頁的問 AI)');

// ── 真實渲染
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const dOff = n => { const d = new Date(today + 'T12:00:00+08:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); };
const row = (s, name, mkt, d, t, place, sum, pdf, web, vid) => ({ s, name, mkt, d, t, place, sum, pdf, web, vid, other: '' });
const FIX = {
  updated: `${today}T09:00:00Z`, data_date: today,
  src: { host: 'https://mopsov.twse.com.tw', page: 'ajax_t100sb02_1', months: [] },
  src_error: { sii: null, otc: '2026/10 被主機擋(安全性考量)' },
  window: { past: 60, future: 45 },
  upcoming: [
    row('2330', '台積電', '上市', today, '14:00', '線上法說會', '', [], 'https://investor.tsmc.com', ''),
    row('1101', '台泥', '上市', dOff(3), '15:00', '證券交易所一樓資訊展示中心', '', [], '', ''),
  ],
  recent: [
    row('2382', '廣達', '上市', dOff(-2), '14:30', '台北市', '本公司說明 AI 伺服器出貨與毛利率展望,資本支出上修。', ['238220260916M001.pdf'], 'https://www.quantatw.com', 'https://youtu.be/abc'),
    row('3231', '緯創', '上市', dOff(-5), '16:00', '線上法說會', '', [], '', ''),
    row('6488', '環球晶', '上櫃', dOff(-1), '10:00', '線上法說會', '矽晶圓長約與 HBM 需求說明。', [], '', ''),
  ],
  hist: { '2382': [dOff(-2)] },
  n: { sii: 4, otc: 1, upcoming: 2, recent: 3, with_sum: 2, with_files: 1 },
};

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const pg = await b.newPage();
const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
await pg.goto(pathToFileURL(resolve('pro.html')).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderConf, null, { timeout: 30000 });
await pg.evaluate(() => { try { localStorage.setItem('proTerminalInv', JSON.stringify([{ symbol: '2330', cost: 900, shares: 1 }])); localStorage.setItem('proTerminalFavGroups', JSON.stringify({ '自選清單': ['2382'] })); localStorage.removeItem('proWar_confEng'); localStorage.removeItem('proWar_confQ'); } catch (_) {} });
await pg.evaluate((F) => {
  PRO._cache['data/confcall.json'] = F;
  PRO._cache['data/playbook_edge.json'] = { picks: [{ s: '3231', hq: 1, bear: 0 }] };
  PRO._names = Object.assign(PRO._names || {}, { '2330': '台積電', '2382': '廣達', '3231': '緯創', '1101': '台泥', '6488': '環球晶' });
  PRO.loadNames = async () => PRO._names;
}, FIX);
await pg.evaluate(() => PRO.switchTab('conf'));
await pg.waitForTimeout(1200);

const R = await pg.evaluate(() => {
  const tab = document.getElementById('tabConf');
  const txt = (tab.innerText || '').replace(/\s+/g, ' ');
  return {
    inWrap: !!document.querySelector('.wrap #tabConf'),
    vis: getComputedStyle(tab).display !== 'none',
    rows: [...tab.querySelectorAll('[data-conf-row]')].map(e => e.dataset.confRow),
    txt, meta: (document.getElementById('confMeta').innerText || '').replace(/\s+/g, ' '),
    srcerr: !!tab.querySelector('[data-conf-srcerr]'),
    nofile: !!tab.querySelector('[data-conf-nofile]'),
    engs: [...tab.querySelectorAll('[data-confeng]')].map(e => e.dataset.confeng),
    sels: [...tab.querySelectorAll('[data-confsel]')].map(e => e.dataset.confsel),
    details: [...tab.querySelectorAll('[data-conf-row] details')].map(d => d.open),
  };
});
ok(R.inWrap, '①d 容器在 .wrap 裡面(DOM 查得到 `.wrap #tabConf`;⛔ 留在外面會吃到 80px 底部 padding = 一大塊空白,V74.4.3)');
ok(R.vis && errs.length === 0, '② 分頁切得過去、無 pageerror', errs.join(' | '));
ok(R.rows.length === 5 && R.rows.includes('2330') && R.rows.includes('6488'), '②a 五場全部列出(上市 + 上櫃)', R.rows.join(','));
ok(/資料日/.test(R.meta) && R.meta.includes(today), '⑥a 資料日有標出來', R.meta.slice(0, 80));
ok(R.srcerr && /上櫃這輪抓不到/.test(R.meta), '⑥b 採礦端 src_error 要顯示(⛔ 不可靜默 —— 那一邊的場次是舊的或缺的)');
ok(R.engs.join(',') === 'perplexity,chatgpt,google,gemini,meta', '⑤c 引擎 chips = Perplexity / ChatGPT / Google / Gemini / Meta AI', R.engs.join(','));
ok(R.sels.join(',') === 'all,mine,today,future,sum', '③a 篩選 chips 五個都在', R.sels.join(','));
ok(R.details.length === 2 && R.details.every(o => !o), '②b 擇要訊息預設折疊(第一眼乾淨)', String(R.details));
ok(/公司尚未提供/.test(R.txt), '②c 沒擇要的場次要說「公司尚未提供」,⛔ 不留空');
const DIR = /建議買進|建議賣出|利多|利空|看漲|看跌|偏多|偏空|加碼|減碼|出清|會漲|會跌/;
ok(!DIR.test(R.txt), '④ 全頁⛔ 不可出現方向/部位詞', (R.txt.match(DIR) || [])[0]);

// ③ 「我的」= 庫存(2330)∪ 自選(2382)∪ 決策台(3231);⛔ 1101 / 6488 不可進來
const mine = await pg.evaluate(() => { PRO.confSel('mine'); return [...document.querySelectorAll('#tabConf [data-conf-row]')].map(e => e.dataset.confRow).sort(); });
ok(mine.join(',') === '2330,2382,3231', '③b 「👜 我的」= 庫存 ∪ 自選 ∪ 決策台名單,不多不少', mine.join(','));
const todayRows = await pg.evaluate(() => { PRO.confSel('today'); return [...document.querySelectorAll('#tabConf [data-conf-row]')].map(e => e.dataset.confRow); });
ok(todayRows.join(',') === '2330', '③c 「今天」只剩今天那一場', todayRows.join(','));
const sumRows = await pg.evaluate(() => { PRO.confSel('sum'); return [...document.querySelectorAll('#tabConf [data-conf-row]')].map(e => e.dataset.confRow).sort(); });
ok(sumRows.join(',') === '2382,6488', '③d 「已開・有內容」只剩有擇要/簡報的已開場次', sumRows.join(','));
const srch = await pg.evaluate(() => { PRO.confSel('all'); PRO.confSearch('HBM'); const el = document.getElementById('tabConf'); return { rows: [...el.querySelectorAll('[data-conf-row]')].map(e => e.dataset.confRow), mark: el.querySelectorAll('[data-conf-row] mark').length }; });
ok(srch.rows.join(',') === '6488' && srch.mark >= 1, '③e 關鍵字搜尋會篩到擇要,而且有 <mark> 高亮', JSON.stringify(srch));
const empty = await pg.evaluate(() => { PRO.confSearch('不存在的關鍵字zzz'); const el = document.getElementById('tabConf'); return { e: !!el.querySelector('[data-conf-empty]'), t: (el.innerText || '').replace(/\s+/g, ' ') }; });
// ⚠️ V77.2.8 起空狀態有**兩種**(搜不到 vs 篩不到)—— 斷言釘的是「⛔ 不可跟『讀不到檔案』同一句」這個用意,
//    ⛔ 不是釘某一句的字面(改字面就紅 = 釘實作不是釘用意)。
ok(empty.e && /整份名單裡搜不到/.test(empty.t) && !/讀不到 data\/confcall\.json/.test(empty.t), '②d 搜不到 → 要說「整份名單裡搜不到」,⛔ 不可跟「讀不到檔案」同一句', empty.t.slice(0, 90));
const emptyFilter = await pg.evaluate((F) => {
  PRO.confSearch('');
  PRO._confData = Object.assign({}, F, { upcoming: [], recent: [] });   // 沒有關鍵字、但這個範圍真的一場都沒有
  PRO.confSel('today');
  const el = document.getElementById('tabConf');
  // 🚨 量測要**全部做完**再還原 —— 第一版把 `e` 寫在 return 裡(還原之後才算)→ 永遠 false = 假失敗。
  const got = { e: !!el.querySelector('[data-conf-empty]'), t: (el.innerText || '').replace(/\s+/g, ' ') };
  PRO._confData = F; PRO.confSel('all');                                // ⭐ 量完立刻還原(⛔ 別把後面的斷言弄髒)
  return got;
}, FIX);
ok(emptyFilter.e && /這個篩選下沒有法說會/.test(emptyFilter.t) && !/讀不到 data\/confcall\.json/.test(emptyFilter.t), '②d2 篩到 0 場 → 「這個篩選下沒有」(跟搜不到是兩句話)', emptyFilter.t.slice(0, 90));
await pg.evaluate(() => PRO.confSearch(''));

// ⑤ 深度查詢:先複製再點、href 對應引擎
const ask = await pg.evaluate(() => {
  const log = [];
  const oc = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { log.push('click:' + this.href); };
  const oe = document.execCommand;
  document.execCommand = function (cmd) { log.push('exec:' + cmd); return true; };
  document.getElementById('confDeepQ').value = 'HBM 產能 2027';
  PRO.confPick('2382');
  const out = {};
  for (const eng of ['perplexity', 'chatgpt', 'google', 'gemini', 'meta']) {
    log.length = 0; PRO.confEng(eng);
    const r = PRO.confAsk();
    out[eng] = { log: log.slice(), r };
  }
  HTMLAnchorElement.prototype.click = oc; document.execCommand = oe;
  return out;
});
const order = e => ask[e].log.findIndex(x => x.startsWith('exec:copy')) < ask[e].log.findIndex(x => x.startsWith('click:'));
ok(['perplexity', 'chatgpt', 'google', 'gemini', 'meta'].every(order), '⑤d ⭐ 每一個引擎都是「先複製、再點連結」(⛔ 順序反過來 = 長問題帶不過去還沒複製到)',
  JSON.stringify(ask.gemini.log));
const href = e => (ask[e].log.find(x => x.startsWith('click:')) || '').slice(6);
ok(href('perplexity').startsWith('https://www.perplexity.ai/search?q=') && href('perplexity').includes(encodeURIComponent('HBM 產能 2027')) && href('perplexity').includes(encodeURIComponent('廣達(2382)')),
  '⑤e Perplexity 網址帶了關鍵字 + 帶上的那一檔', href('perplexity').slice(0, 120));
ok(href('chatgpt').startsWith('https://chatgpt.com/') && href('google').startsWith('https://www.google.com/search?q='), '⑤f ChatGPT / Google 網址對');
ok(href('gemini') === 'https://gemini.google.com/app' && href('meta') === 'https://www.meta.ai/', '⑤g Gemini / Meta AI 只開根網址(不吃帶字,⛔ 不可假裝帶得過去)', href('gemini') + ' ' + href('meta'));
ok(ask.gemini.r && ask.gemini.r.carried === false && ask.perplexity.r && ask.perplexity.r.carried === true, '⑤h 回傳 carried 讓 toast 講清楚「要自己貼上」');
ok(ask.meta.r && ask.meta.r.copied === true, '⑤i 複製要真的成功(execCommand 回 true)');

// ═══════════ V77.2.8:搜尋跨範圍 / 📄 簡報 / 🏭 產業 / 🔔 倒數 / 📜 歷年 / 📊 統計 / 🔎 提示詞 ═══════════
// 先把 fixture 升級成「有 src.file 樣板 + ind 產業碼 + react 統計 + 多筆 hist」的形狀
// ⭐ src.file 逐字抄自探針 Actions #35406340327 印的官方 <form name='fm_fileDownload'>。
const FIX2 = JSON.parse(JSON.stringify(FIX));
FIX2.src.file = { host: 'https://mopsov.twse.com.tw', path: '/server-java/FileDownLoad',
  q: { step: '9', filePath: '/home/html/nas/STR/', functionName: 't100sb02_1' }, arg: 'fileName', how: 'GET', from: 'form' };
FIX2.src_error.names = null;
FIX2.upcoming[0].ind = '24'; FIX2.upcoming[1].ind = '01';
FIX2.recent[0].ind = '25'; FIX2.recent[0].pdf = ['238220260916M001.pdf', '238220260916E001.pdf'];
FIX2.recent[1].ind = '25'; FIX2.recent[2].ind = '24';
FIX2.hist = { '2382': [dOff(-2), '2026-03-14', '2025-11-08'], '6488': [dOff(-1)] };
FIX2.react = { n: 700, med1: -0.31, med5: -1.26, med20: -4.25, win5: 41.0, syms: 677, events: 844,
  base: { n: 522732, med1: -0.2, med5: -0.73, med20: -2.64, win5: 42.3 },
  byStock: { '2382': { n: 3, med5: 1.8 } },
  how: '法說會當天收盤 → +N 個交易日收盤,減同期加權;對照組 = 同一批股票的每一個交易日',
  caveat: '⛔ 不是回測:沒扣交易成本、沒過六道關卡。本站實測 37 種財經行事曆日方向 0 個成立 → ⛔ 不是買賣訊號。' };
await pg.evaluate((F) => {
  PRO._cache['data/confcall.json'] = F; PRO._confData = undefined; PRO._confSel = 'all'; PRO._confQ = ''; PRO._confInd = ''; PRO._confSym = null; PRO._confHist = null;
  PRO._cache['data/screener.json'] = { cols: ['c', 'chg', 'chg20', 'pos252', 'amp20', 'pe', 'yld', 'yoy', 'gm'],
    rows: { '2382': [312.5, 1.2, 8.4, 88.0, 5.1, 21.3, 2.4, 36.0, 11.2] } };
  return PRO.renderConf();
}, FIX2);
await pg.waitForTimeout(400);

// ── 🔎 搜尋跨範圍(使用者選「打字就搜全部」)
const cross = await pg.evaluate(() => {
  PRO.confSel('mine');                      // 停在「👜 我的」(只有 2330/2382/3231)
  PRO.confSearch('環球晶');                  // 6488 **不在**我的清單裡
  const el = document.getElementById('tabConf');
  return { rows: [...el.querySelectorAll('[data-conf-row]')].map(e => e.dataset.confRow),
           scope: !!el.querySelector('[data-conf-scope="all"]'),
           t: (el.innerText || '').replace(/\s+/g, ' ') };
});
ok(cross.rows.join(',') === '6488', '🔎⑭ 停在「👜 我的」打字,照樣搜得到不屬於我的那一檔(⛔ 不可鎖在目前篩選裡)', cross.rows.join(','));
ok(cross.scope && /已跨所有範圍/.test(cross.t), '🔎⑭b 要明說「已跨所有範圍」+ 給一顆回去的鈕(⛔ 不可讓人以為篩選還在作用)');
const byCode = await pg.evaluate(() => { PRO.confSearch('6488'); return [...document.querySelectorAll('#tabConf [data-conf-row]')].map(e => e.dataset.confRow); });
ok(byCode.join(',') === '6488', '🔎⑭c 用代號也搜得到', byCode.join(','));
const fullw = await pg.evaluate(() => { PRO.confSearch('６４８８'); return [...document.querySelectorAll('#tabConf [data-conf-row]')].map(e => e.dataset.confRow); });
ok(fullw.join(',') === '6488', '🔎⑭d 全形數字也搜得到(⛔ 手機注音鍵盤打出來的就是全形)', fullw.join(','));
// 🏷️ 名字表整個載不到時,列表**仍然要有中文名**(confcall 自帶官方簡稱)
// 🚨 這裡**必須**用 1101 —— 2330/2382/3231/6488 都在 `PRO.CHAIN.stocks` 裡,`nameOf` 有第二個來源,
//    拿它們做「名字表載不到」根本重現不了(第一版用 6488,注入「拿掉保底」照樣綠 = 沒有鑑別力)。
const noName = await pg.evaluate(() => {
  const bak = PRO._names; PRO._names = {};
  PRO.confSearch('1101');
  const t = (document.querySelector('#tabConf [data-conf-row] .bkhd').innerText || '').replace(/\s+/g, ' ');
  PRO._names = bak; PRO.confSearch('');
  return t;
});
ok(/台泥/.test(noName) && !/1101 1101/.test(noName), '🏷️⑭e 名字表載不到時,列表仍有中文名(⛔ 不可變成「1101 1101」)', noName);

// ── 📄 一鍵開簡報(⛔ 網址一律從採礦樣板組,前端不可寫死)
const pdf = await pg.evaluate(() => {
  PRO.confSearch('廣達');
  const a = [...document.querySelectorAll('#tabConf a.conf-pdf')];
  return { n: a.length, href: a.map(x => x.getAttribute('href')), txt: a.map(x => x.innerText.trim()), tgt: a.map(x => x.target) };
});
ok(pdf.n === 2 && pdf.tgt.every(t => t === '_blank'), '📄⑮ 中文/英文簡報各一顆,開新分頁', JSON.stringify(pdf.txt));
ok(pdf.href.every(h => h.startsWith('https://mopsov.twse.com.tw/server-java/FileDownLoad?'))
   && pdf.href[0].includes('filePath=') && pdf.href[0].includes('fileName=238220260916M001.pdf'),
  '📄⑮b 網址照官方樣板組(step/filePath/functionName + fileName)', pdf.href[0]);
ok(pdf.txt.join(',') === '📄 中文簡報,📄 英文簡報', '📄⑮c M/E 要分得出中文版英文版', pdf.txt.join(','));
// ⭐ 決定性對照:改採礦樣板 → href 必須跟著變(⛔ 前端寫死的話不會變)
const pdfMoved = await pg.evaluate(() => {
  PRO._confData.src.file.host = 'https://example.invalid'; PRO._confData.src.file.q.filePath = '/ZZZ/';
  PRO._confPaint();
  const h = document.querySelector('#tabConf a.conf-pdf').getAttribute('href');
  PRO._confData.src.file.host = 'https://mopsov.twse.com.tw'; PRO._confData.src.file.q.filePath = '/home/html/nas/STR/'; PRO._confPaint();
  return h;
});
ok(pdfMoved.startsWith('https://example.invalid/') && pdfMoved.includes('%2FZZZ%2F'), '📄⑮d ⭐ 決定性對照:改採礦端樣板,前端網址要跟著變(⛔ 不可寫死)', pdfMoved);
// 樣板缺了 → 退回只印檔名,⛔ 不硬湊網址
const noTpl = await pg.evaluate(() => {
  const bak = PRO._confData.src.file; delete PRO._confData.src.file; PRO._confPaint();
  const r = { a: document.querySelectorAll('#tabConf a.conf-pdf').length, t: (document.getElementById('confBody').innerText || '') };
  PRO._confData.src.file = bak; PRO._confPaint(); return r;
});
ok(noTpl.a === 0 && /238220260916M001\.pdf/.test(noTpl.t), '📄⑮e 採礦沒給樣板 → 只印檔名,⛔ 不可自己湊一個網址出來');

// ── 🏭 產業分組
const ind = await pg.evaluate(() => {
  PRO.confSearch(''); PRO.confSel('all');
  const chips = [...document.querySelectorAll('#confInd [data-confind]')].map(e => e.dataset.confind);
  PRO.confInd('24');
  const rows = [...document.querySelectorAll('#tabConf [data-conf-row]')].map(e => e.dataset.confRow).sort();
  PRO.confInd('');
  return { chips, rows };
});
ok(ind.chips.includes('24') && ind.chips.includes('25') && ind.chips.includes('01') && !ind.chips.includes('99'),
  '🏭⑯ chips 只列**結果裡真的有**的產業(⛔ 不列空的)', ind.chips.join(','));
ok(ind.rows.join(',') === '2330,6488', '🏭⑯b 點半導體只剩那兩場', ind.rows.join(','));
const indNone = await pg.evaluate(() => {
  PRO._confData.upcoming[1] = Object.assign({}, PRO._confData.upcoming[1]); delete PRO._confData.upcoming[1].ind;
  PRO._confPaint();
  const t = (document.getElementById('confInd').innerText || '');
  PRO._confData.upcoming[1].ind = '01'; PRO._confPaint(); return t;
});
ok(/未分類/.test(indNone), '🏭⑯c 沒有產業碼的要歸「未分類」並顯示出來(⛔ 不猜一個產業)', indNone);

// ── 🔔 我的倒數提醒(2330 今天有一場)
const alert = await pg.evaluate(() => {
  const el = document.querySelector('#confAlert [data-conf-alert]');
  return { n: el ? el.dataset.confAlert : null, t: el ? (el.innerText || '').replace(/\s+/g, ' ') : '' };
});
ok(alert.n === '1' && /台積電/.test(alert.t), '🔔⑰ 「你的清單裡未來 N 天有 M 場」只算庫存/自選/決策台', JSON.stringify(alert));
ok(/波動/.test(alert.t) && !DIR.test(alert.t) && !/成部位|留倉|全出清/.test(alert.t),
  '🔔⑰b 只講「波動會變大」,⛔ 不給方向、不給部位(行事曆日方向實測 0 個成立)', (alert.t.match(DIR) || [])[0]);

// ── 📜 歷年法說會
const hist = await pg.evaluate(() => {
  PRO.confSearch('廣達');
  const btn = document.querySelector('#tabConf [data-conf-hist="2382"]');
  const label = btn ? btn.innerText.trim() : '';
  PRO.confHist('2382');
  const box = document.querySelector('#tabConf [data-conf-histbox="2382"]');
  return { label, t: box ? (box.innerText || '').replace(/\s+/g, ' ') : '' };
});
ok(/2 場/.test(hist.label), '📜⑱ 「歷年」只算**這一場以外**的(⛔ 不可把今天這場也算進去)', hist.label);
ok(/2026-03-14/.test(hist.t) && /2025-11-08/.test(hist.t) && /從本站開始採集/.test(hist.t),
  '📜⑱b 展開列出歷年日期,並誠實說「不是公司的完整歷史」', hist.t.slice(0, 120));

// ── 📊 會後股價統計(事實,⛔ 不是訊號)
const react = await pg.evaluate(() => {
  PRO.confSearch(''); PRO.confPick('2382');
  const el = document.querySelector('#confReact [data-conf-react]');
  if (el) el.open = true;
  return (el ? el.innerText : '').replace(/\s+/g, ' ');
});
ok(/-1\.26 pp/.test(react) && /對照組/.test(react) && /-0\.73 pp/.test(react) && /522,732/.test(react),
  '📊⑲ 事件組**與對照組**的數字都要印(⛔ 沒有對照組的統計不可用,陷阱 #36)', react.slice(0, 160));
ok(/不是回測/.test(react) && /0 個成立/.test(react), '📊⑲b 固定免責:不是回測 + 37 種行事曆日方向 0 個成立');
ok(/樣本不足/.test(react) && /3 場/.test(react), '📊⑲c 這一檔 n<10 要標「樣本不足,⛔ 不能當結論」(`_wrEnough` 同一把尺)', react.slice(-120));
ok(!DIR.test(react), '📊⑲d 統計段⛔ 不可出現方向詞', (react.match(DIR) || [])[0]);

// ── 🔎 法人視角提示詞
const pr = await pg.evaluate(() => {
  PRO.confPick('2382');
  const ta = document.getElementById('confDeepQ'); ta.value = 'HBM 出貨';
  return { full: PRO._confDeepPrompt('2382', 'HBM 出貨', false), short: PRO._confDeepPrompt('2382', 'HBM 出貨', true) };
});
for (const [k, re] of [['未來展望/財測', /未來展望\/財測/], ['產能與資本支出', /產能與資本支出/], ['訂單能見度', /訂單能見度/],
                       ['價格與成本', /價格與成本/], ['量產時間表', /量產時間表/], ['庫存', /庫存水位/],
                       ['Q&A 閃避', /管理層對哪些問題講得保守或避開/], ['風險', /公司自己講的風險/]])
  ok(re.test(pr.full), `🔎⑳ 提示詞要有「${k}」這一項`);
ok(/跟上一次法說會比,說法變了什麼/.test(pr.full), '🔎⑳b ⭐「跟上一次比說法變了什麼」是法人真正在看的那一句');
ok(/⛔ 不要給買賣建議/.test(pr.full) && /⛔ 不要評分或星等/.test(pr.full) && /⛔ 不要講幾成部位/.test(pr.full),
  '🔎⑳c ⛔ 不可叫外部 AI 給買賣建議/評分/部位');
ok(/查不到就寫「查不到」/.test(pr.full) && /⛔ 不要留模板空格/.test(pr.full),
  '🔎⑳d 查不到要寫查不到(⛔ 留空格給 AI 填,它就會編 —— V76.3.7 的教訓)');
ok(/現價 312\.50/.test(pr.full) && /一年位階 88\.00%/.test(pr.full) && /⛔ 不要自己重算/.test(pr.full),
  '🔎⑳e 本站算好的數字要塞進去(禁 AI 算數學鐵律)', pr.full.slice(0, 200));
ok(/mopsov\.twse\.com\.tw\/server-java\/FileDownLoad/.test(pr.full),
  '🔎⑳f 簡報 PDF 網址要附上去(探針實測 GET 就開得了 → 外部 AI 讀得到)');
ok(pr.short.length < 200 && pr.full.length > 500, '🔎⑳g 精簡版給網址、完整版給剪貼簿(⛔ 完整版塞網址會在 iOS 交棒時帶不過去,V76.2.1)',
  `short=${pr.short.length} full=${pr.full.length}`);
// ⭐ 先複製(完整版)再開(精簡版)—— 順序反過來就白做了
const promptOrder = await pg.evaluate(() => {
  // 🚨 前面 ⑤g 把引擎切成 meta 並存進 localStorage → 不切回來的話,網址永遠是 meta 的根網址(20 字元),
  //    ⑳j「網址帶的是精簡版」就變成**永遠會過**的假綠燈。一定要用會帶字的引擎量。
  PRO.confEng('perplexity');
  const seq = []; let copied = '';
  const oc = document.execCommand; document.execCommand = function (c) { const ta = document.querySelector('textarea[readonly]'); copied = ta ? ta.value : ''; seq.push('copy'); return true; };
  const ac = HTMLAnchorElement.prototype.click;
  let href = '';
  HTMLAnchorElement.prototype.click = function () { seq.push('click'); href = this.href; };
  PRO.confAsk();
  document.execCommand = oc; HTMLAnchorElement.prototype.click = ac;
  return { seq, copiedLen: copied.length, hasEight: /管理層對哪些問題講得保守或避開/.test(copied), hrefLen: href.length };
});
ok(promptOrder.seq.join(',') === 'copy,click', '🔎⑳h 先複製再開(⛔ 順序反過來 = 還沒複製就跳走)', promptOrder.seq.join(','));
ok(promptOrder.hasEight && promptOrder.copiedLen > 500, '🔎⑳i 剪貼簿拿到的是**完整版**(八個面向)', String(promptOrder.copiedLen));
ok(promptOrder.hrefLen < 1500, '🔎⑳j 網址帶的是精簡版(⛔ 完整版編碼後上萬字元,iOS 帶不過去)', String(promptOrder.hrefLen));

// ② 檔案沒產出 → 專屬文案(⛔ 不可跟「沒有法說會」一樣)
const nofile = await pg.evaluate(() => { PRO._cache['data/confcall.json'] = null; PRO._confData = undefined; return PRO.renderConf().then(() => { const el = document.getElementById('tabConf'); return { nf: !!el.querySelector('[data-conf-nofile]'), t: (el.innerText || '').replace(/\s+/g, ' ') }; }); });
ok(nofile.nf && /讀不到 data\/confcall\.json/.test(nofile.t) && /不代表這幾天真的沒有法說會/.test(nofile.t), '②e 檔案沒產出 → 「讀不到 …」+「不代表真的沒有」', nofile.t.slice(0, 120));

// pro.html 的 id 唯一性(check_dom_ids.py 只掃 index.html)
const ids = [...SRC.matchAll(/ id="([A-Za-z_][\w-]*)"/g)].map(m => m[1]);
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
ok(dup.length === 0, '①e pro.html DOM id 唯一', dup.join(','));

await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ CONFCALL_MJS_PASS(全部通過)');
process.exit(bad ? 1 : 0);

// 🧪 注入清單(每一條都要紅):
//   A. TABS 拿掉 ['conf','Conf'] → ①a(且 switchTab 會 throw → ②)
//   B. 容器移到 .wrap 外 → ①d
//   C. _askAi 把 _copySync 移到 a.click() 之後 → ⑤d
//   D. _confHtml 某一列塞「建議買進」→ ④
//   E. renderConf 的 !D 分支改成印「這幾天沒有法說會」→ ②e
//   F. _confMine 拿掉自選那一段 → ③b
//   G. gemini 改成帶 ?q= → ⑤g
