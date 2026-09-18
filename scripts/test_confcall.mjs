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
ok(empty.e && /這個篩選下沒有法說會/.test(empty.t) && !/讀不到 data\/confcall\.json/.test(empty.t), '②d 篩到 0 場 → 寫「這個篩選下沒有」,⛔ 不可跟「讀不到檔案」同一句');
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
