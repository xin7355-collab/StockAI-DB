// 📞 V79.6.3 法說會「簡報重點」畫面:產業作戰室法說會分頁(重做)+ 散戶 App 個股「基本」頁那一格
//   使用者 2026-10-23:「法說會的最新不是很重要嗎?如何快速提取裡面重點,還有之前沒有做的項目,突然開始要做…
//                     目前的介面我覺得很沒有用,請重新設計」
//   資料:confcall_deck.py → data/confcall_digest.json(最近 60 天每場一列)+ data/cc/{sym}.json(每檔最近 4 份)
//
// ⛔ 釘死的事(注入都要叫得出來):
//   ① 預設 = 🆕 剛開完(7 天);👜 我的排最前,其餘照「第一次提到的東西」多寡排
//   ② 每張卡的標籤跟資料一致(新東西 N / 第一次收錄 / 沿用舊簡報 / 沒有新的詞 / 還沒讀到)
//   ③ 展開才讀 data/cc/{sym}.json;數字、頁碼、跟上一份比、開完到現在的股價都來自資料(⛔ 寫死)
//   ④ 讀不到 digest / cc 檔 ≠ 簡報沒內容 ≠ 沒有法說會(陷阱 #22)
//   ⑤ 簡報裡的詞搜得到(誰在講 CPO);決定性對照:拿掉 tm → 搜不到
//   ⑥ 全頁⛔ 不可出現方向詞;AI 文字一律跳脫(⛔ 可以塞 HTML)
//   ⑦ 390px 不溢出
//   ⑧ 散戶 App:有資料才顯示、綁 sym(await 回來切走 ⛔ 畫上一檔)、⛔ 研究數字、連結用採礦給的樣板
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : (e ? ' — ' + String(e).slice(0, 260) : '')}`); if (!c) bad++; };

// ── 原始碼守門
const PRO_SRC = readFileSync('pro.html', 'utf8');
const IDX_SRC = readFileSync('index.html', 'utf8');
ok(/_confSel: 'new'/.test(PRO_SRC) && /_CONF_SEL: \[\['new', '🆕 剛開完'\], \['mine', '👜 我的'\], \['future', '📅 接下來 14 天'\], \['radar', '🛰️ 主題雷達'\], \['all', '🗂️ 全部'\]\]/.test(PRO_SRC),
  'ⓐ 法說會分頁預設 = 🆕 剛開完,範圍五個(剛開完 / 我的 / 接下來 14 天 / 主題雷達 / 全部;V79.7.7 加雷達)');
ok(/'corpConfCall',/.test(IDX_SRC.slice(IDX_SRC.indexOf("'ovOpenBox', 'ovColBox'"), IDX_SRC.indexOf("'ovOpenBox', 'ovColBox'") + 400)),
  'ⓑ 散戶 App 那一格在切股清空清單裡(陷阱 #19)');
{
  const s = IDX_SRC.indexOf('_corpConfCallHtml(sym, J) {'), e = IDX_SRC.indexOf('// 📊 V76.2.5 畫進「基本」分頁', s);
  const body = IDX_SRC.slice(s, e).replace(/\/\/[^\n]*/g, '');
  ok(s > 0 && e > s && !/實測|回測|勝率|期望值|贏大盤|0050|偏多|偏空|利多|利空/.test(body), 'ⓒ 散戶 App 那一格的原始碼⛔ 研究字樣 / 方向詞(V78.3.4)',
     (body.match(/實測|回測|勝率|期望值|贏大盤|0050|偏多|偏空|利多|利空/) || [])[0]);
}

// ── 測資(格式照真實產物:digest 的 new 是詞的陣列、cc 檔的 new 是 [詞, 頁] 的陣列、nums / outlook 是 [頁, 句])
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const dOff = n => { const d = new Date(today + 'T12:00:00+08:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); };
const ymd = d => d.replace(/-/g, '');
const fOf = (s, d) => `${s}${ymd(d)}M001.pdf`;
const row = (s, name, d, t, sum, pdf) => ({ s, name, mkt: '上市', d, t, place: '線上', sum, pdf, web: '', vid: '', other: '' });
const D2382 = dOff(-2), D3231 = dOff(-3), D6488 = dOff(-1), D2330 = dOff(-4), D2603 = dOff(-20), D2454 = dOff(-5);
const CONF = {
  updated: `${today}T09:00:00Z`, data_date: today,
  src: { host: 'https://mopsov.twse.com.tw', page: 'ajax_t100sb02_1', months: [],
         file: { host: 'https://mopsov.twse.com.tw', path: '/server-java/FileDownLoad', q: { step: '9', filePath: '/home/html/nas/STR/', functionName: 't100sb02_1' }, arg: 'fileName', how: 'GET', from: 'form' } },
  src_error: {}, window: { past: 60, future: 45 },
  upcoming: [row('1101', '台泥', dOff(3), '15:00', '', [])],
  recent: [
    row('2382', '廣達', D2382, '14:30', '本公司說明 AI 伺服器出貨。', [fOf('2382', D2382)]),
    row('3231', '緯創', D3231, '16:00', '受邀參加某證券投資論壇', [fOf('3231', D3231)]),
    row('6488', '環球晶', D6488, '10:00', '', []),
    row('2330', '台積電', D2330, '14:00', '', [fOf('2330', D2330)]),
    row('2454', '聯發科', D2454, '14:00', '', [fOf('2454', D2454)]),
    row('2603', '長榮', D2603, '14:00', '', [fOf('2603', D2603)]),
  ],
  hist: {}, n: { upcoming: 1, recent: 6, with_sum: 2, with_files: 5 },
};
const dg = (s, d, x) => Object.assign({ s, name: s, d, t: '', inv: 0, f: fOf(s, d), one: '', ol: '', new: [], new_n: 0, first: false, prev_d: '', reuse: '', n_nums: 0, pages: 20, tm: [] }, x);
const DIGEST = { updated: `${today}T18:00`, days: 60, n: 5, rows: [
  dg('2382', D2382, { one: '第四季 AI 伺服器出貨續增,毛利率維持 12.5% 左右', new: ['CPO', '機器人', '矽光子'], new_n: 3, prev_d: dOff(-95), n_nums: 4, tm: ['AI 伺服器', 'CPO', '機器人', '矽光子'] }),
  dg('3231', D3231, { first: true, ol: '預期明年產能擴充至 2 倍', inv: 1, tm: ['AI 伺服器'] }),
  dg('2330', D2330, { prev_d: dOff(-94), ol: '預期第四季營收季增 8%', tm: ['CoWoS'] }),
  dg('2454', D2454, { reuse: dOff(-30), one: '<img src=x onerror="window.__xss=1">沿用', tm: [] }),
  dg('2603', D2603, { new: ['氫能'], new_n: 1, prev_d: dOff(-110), tm: ['氫能'] }),
] };
const CC2382 = { s: '2382', name: '廣達', decks: [{
  d: D2382, f: fOf('2382', D2382), st: 'ok', pages: 20, kind: 'pdf',
  outlook: [[5, '預期第四季營收季增 5%~8%']], nums: [[3, '毛利率 12.5%'], [4, '資本支出 120 億元'], [6, '出貨量季增 15%'], [9, '營益率 6.1%']],
  titles: [[1, '營運概況']], tone: [3, 1], new: [['CPO', 7], ['機器人', 8], ['矽光子', 9]], n_new: 3, prev_d: dOff(-95), dropped: ['HBM'],
  ai: { one: '第四季 AI 伺服器出貨續增', outlook: [{ t: '第四季營收季增 5%~8%', p: 5 }], new: [{ t: '切入 CPO 交換器', p: 7 }], risk: [{ t: '零組件缺料', p: 11 }] },
  model: 'qwen/qwen3.8-27b', gate_drop: 1 }] };
// K 線:法說會那天收 100 → 最新 110(+10.0%);0050 同期 50 → 51(+2.0%)
const kl = (d0, c0, c1) => [{ date: dOff(-30).replace(/-/g, '/'), close: c0 * 0.9 }, { date: d0.replace(/-/g, '/'), close: c0 }, { date: dOff(-1).replace(/-/g, '/'), close: c1 }];

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});

// ══════════ 產業作戰室 ══════════
{
  const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await pg.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
  await pg.goto(pathToFileURL(resolve('pro.html')).href);
  await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderConf, null, { timeout: 30000 });
  await pg.evaluate(() => { try { localStorage.setItem('proTerminalInv', JSON.stringify([{ symbol: '2330', cost: 900, shares: 1 }])); localStorage.removeItem('proTerminalFavGroups'); } catch (_) {} });
  await pg.evaluate(({ CONF, DIGEST, CC2382, K2382, K0050 }) => {
    PRO._cache['data/confcall.json'] = CONF;
    PRO._cache['data/confcall_digest.json'] = DIGEST;
    PRO._cache['data/cc/2382.json'] = CC2382;
    PRO._cache['data/2382.json'] = K2382;
    PRO._cache['data/0050.json'] = K0050;
    PRO._cache['data/playbook_edge.json'] = { picks: [] };
    PRO._cache['data/screener.json'] = { rows: [] };
    PRO._names = Object.assign(PRO._names || {}, { 2330: '台積電', 2382: '廣達', 3231: '緯創', 6488: '環球晶', 2454: '聯發科', 2603: '長榮', 1101: '台泥' });
    PRO.loadNames = async () => PRO._names;
  }, { CONF, DIGEST, CC2382, K2382: kl(D2382, 100, 110), K0050: kl(D2382, 50, 51) });
  await pg.evaluate(() => PRO.switchTab('conf'));
  await pg.waitForTimeout(900);

  const R1 = await pg.evaluate(() => {
    const tab = document.getElementById('tabConf');
    const cards = [...tab.querySelectorAll('[data-conf-card]')].map(c => c.getAttribute('data-conf-row'));
    const card = s => tab.querySelector(`[data-conf-card][data-conf-row="${s}"]`);
    const has = (s, sel) => !!(card(s) && card(s).querySelector(sel));
    return {
      cards, sel: PRO._confSel,
      new2382: card('2382') && (card('2382').querySelector('[data-cc-new]') || {}).getAttribute?.('data-cc-new'),
      first3231: has('3231', '[data-cc-first]'), host3231: (card('3231')?.querySelector('[data-cc-host]')?.textContent || ''),
      host2382: (card('2382')?.querySelector('[data-cc-host]')?.textContent || ''),
      zero2330: (card('2330')?.querySelector('[data-cc-new]') || {}).getAttribute?.('data-cc-new'),
      reuse2454: has('2454', '[data-cc-reuse]'), none6488: has('6488', '[data-cc-none]'),
      one2382: card('2382')?.querySelector('[data-cc-one]')?.textContent || '',
      ol3231: card('3231')?.querySelector('[data-cc-ol]')?.textContent || '',
      newlist: card('2382')?.querySelector('[data-cc-newlist]')?.textContent || '',
      xssImg: !!(card('2454') && card('2454').querySelector('img')), xss: !!window.__xss,
      txt: (tab.innerText || '').replace(/\s+/g, ' '),
      meta: document.getElementById('confMeta')?.innerText || '',
      past: tab.querySelector('[data-conf-sec="past"]')?.textContent || '',
    };
  });
  ok(R1.sel === 'new', '① 一進來就是 🆕 剛開完', R1.sel);
  ok(R1.cards.length === 5 && !R1.cards.includes('2603') && !R1.cards.includes('1101'),
     '① 只列 7 天內已開完的(20 天前的長榮、還沒開的台泥 ⛔ 不在這一頁)', JSON.stringify(R1.cards));
  ok(R1.cards[0] === '2330', '① 👜 我的(庫存 2330)排最前', JSON.stringify(R1.cards));
  ok(R1.cards[1] === '2382', '① 其餘照「第一次提到的東西」多寡排(新東西 3 個的廣達排第二)', JSON.stringify(R1.cards));
  ok(R1.new2382 === '3' && /CPO/.test(R1.newlist) && /機器人/.test(R1.newlist) && /跟 \d\d\/\d\d 那份比/.test(R1.newlist),
     '② 新東西 N 跟資料一致,列出詞 + 跟哪一份比', `${R1.new2382} | ${R1.newlist}`);
  ok(R1.first3231 && R1.zero2330 === '0' && R1.reuse2454 && R1.none6488,
     '② 第一次收錄 / 沒有新的詞 / 沿用舊簡報 / 還沒有簡報 四種標籤各自對上', JSON.stringify({ f: R1.first3231, z: R1.zero2330, r: R1.reuse2454, n: R1.none6488 }));
  ok(/券商邀請/.test(R1.host3231) && /自辦/.test(R1.host2382), '② 券商邀請(擇要寫「受邀參加…論壇」)vs 公司自辦', `${R1.host3231} | ${R1.host2382}`);
  // 📞 V79.7.7 一列一場:「AI 只讀簡報句子、數字都對過原文」寫在那一段的標頭(⛔ 每一列重複一次)
  ok(/毛利率維持 12\.5%/.test(R1.one2382) && /🤖/.test(R1.one2382) && /AI 只讀簡報抽出來的句子/.test(R1.past) && /數字都對過原文/.test(R1.past),
     '② 一句話讀 digest 的 one,並寫明 AI 只讀簡報句子(段落標頭)', `${R1.one2382} | ${R1.past}`);
  ok(/預期明年產能擴充至 2 倍/.test(R1.ol3231), '② 沒有 AI 一句話 → 退回簡報原文那句「講到之後」', R1.ol3231);
  ok(!R1.xssImg && !R1.xss, '⑥ AI 文字一律跳脫(塞 <img onerror> ⛔ 變成元素)');
  ok(/簡報重點:最近 60 天讀到 5 份/.test(R1.meta), '④ 頁頭寫出簡報讀到幾份 + 更新時間', R1.meta.slice(0, 200));
  const DIR = /偏多|偏空|利多|利空|看多|看空|加碼|減碼|會漲|會跌|勝率/;
  ok(!DIR.test(R1.txt), '⑥ 整頁⛔ 方向詞 / 勝率', (R1.txt.match(DIR) || [])[0]);

  // ③ 點那一場 → 公司檔案(📞 V79.7.7 取代舊的「展開 ▾」)讀 data/cc/2382.json → 數字 / 頁碼 / 跟上一份比 / 開完到現在
  //    分頁:重點(AI 整理 / 講到之後 / 開完到現在)・數字(做到了沒 / 公司給的數字)・跟上次比(第一次提到 / 上一份有這次沒講)
  const R2 = await pg.evaluate(async () => {
    const row = document.querySelector('[data-conf-card][data-conf-row="2382"]');
    row.click();
    const wait = async (sel) => { for (let i = 0; i < 40; i++) { if (document.querySelector('#confDossier ' + sel)) return; await new Promise(r => setTimeout(r, 50)); } };
    await wait('[data-ccd-ai]');
    await new Promise(r => setTimeout(r, 300));
    const g = s => document.querySelector('#confDossier ' + s)?.textContent || '';
    const o = { sel: row.classList.contains('sel'), key: document.querySelector('#confDossier [data-ccd-body]')?.getAttribute('data-ccd-tab'),
                ol: g('[data-ccd-ol]'), ai: g('[data-ccd-ai]'), px: g('[data-ccd-px]'), head: g('[data-ccd-head]') };
    PRO.confDTab('num'); o.nums = g('[data-ccd-nums]');
    PRO.confDTab('cmp'); o.nw = g('[data-ccd-new]'); o.dropped = g('[data-ccd-dropped]');
    o.tabs = [...document.querySelectorAll('#confDossier [data-ccdtab]')].map(b => b.getAttribute('data-ccdtab'));
    return o;
  });
  ok(R2.sel && R2.key === 'key' && /廣達/.test(R2.head) && R2.tabs.join(',') === 'key,num,cmp,info',
     '③ 點一場 → 那一列亮起來、公司檔案先停在「重點」、分頁 = 重點 / 數字 / 跟上次比 / 公司說明(不是台積電 ⛔ 問答)', JSON.stringify({ sel: R2.sel, key: R2.key, tabs: R2.tabs }));
  ok(/毛利率 12\.5%/.test(R2.nums) && /第 3 頁/.test(R2.nums) && /資本支出 120 億元/.test(R2.nums) && /第 4 頁/.test(R2.nums),
     '③ 公司給的數字照抄原文 + 頁碼', R2.nums);
  ok(/預期第四季營收季增 5%~8%/.test(R2.ol) && /第 5 頁/.test(R2.ol), '③ 講到「之後」的句子 + 頁碼', R2.ol);
  ok(/CPO/.test(R2.nw) && /第 7 頁/.test(R2.nw) && /HBM/.test(R2.dropped), '③ 跟上一份比:這次第一次提到(頁碼)+ 上一份有、這次沒講', `${R2.nw} | ${R2.dropped}`);
  ok(/qwen/.test(R2.ai) && /拿掉 1 點/.test(R2.ai) && /零組件缺料/.test(R2.ai) && /第 11 頁/.test(R2.ai),
     '③ AI 整理標模型 + 核對丟掉幾點 + 每點頁碼', R2.ai.slice(0, 200));
  ok(/\+10\.0%/.test(R2.px) && /0050 \+2\.0%/.test(R2.px) && /不是之後會怎麼走/.test(R2.px),
     '③ 開完到現在:這檔 +10.0% / 同期 0050 +2.0%(從 K 線算,寫明只是事實)', R2.px);

  // ③ 決定性對照:K 線換一組 → 數字跟著變(⛔ 寫死)
  const px2 = await pg.evaluate(async ({ K }) => {
    PRO._cache['data/2382.json'] = K;
    return PRO._confPxHtml(await PRO._confPxSince('2382', K[1].date.replace(/\//g, '-')));
  }, { K: kl(D2382, 100, 93) });
  ok(/-7\.0%/.test(px2), '③ ⭐ 決定性對照:最新收盤改成 93 → 變 -7.0%', px2);
  // ③b 法說會今天才開、K 線還沒有那天之後的 → 說「還沒有開完之後的股價」(⛔ 說成讀不到 K 線)
  const px3 = await pg.evaluate(async ({ K, d }) => { PRO._cache['data/2382.json'] = K; return PRO._confPxHtml(await PRO._confPxSince('2382', d)); },
    { K: kl(D2382, 100, 110), d: today });
  ok(/還沒有開完之後的股價/.test(px3) && !/讀不到 K 線/.test(px3), '③b 法說會比最新 K 線還新 → 寫「還沒有開完之後的股價」(⛔ 讀不到 K 線)', px3);

  // ④ cc 檔讀不到 → 說「檔案沒產出或網路失敗」,⛔ 說成簡報沒內容
  const R4 = await pg.evaluate(async () => {
    PRO._cache['data/cc/3231.json'] = undefined; PRO._confCC['3231'] = undefined;
    PRO.fetchJson = (orig => async (p, t) => (p === 'data/cc/3231.json' ? null : orig.call(PRO, p, t)))(PRO.fetchJson);
    document.querySelector('[data-conf-card][data-conf-row="3231"]').click();
    for (let i = 0; i < 40 && !document.querySelector('#confDossier [data-ccd-nofile]'); i++) await new Promise(r => setTimeout(r, 50));
    return document.querySelector('#confDossier [data-ccd-body]')?.textContent || '';
  });
  ok(/讀不到這一檔的簡報重點檔/.test(R4) && /不代表簡報沒內容/.test(R4), '④ cc 檔讀不到 ≠ 簡報沒內容', R4);

  // ⑤ 搜尋簡報裡的詞:CPO → 廣達;決定性對照:拿掉 tm / new / one 之後搜不到
  const R5 = await pg.evaluate(() => {
    PRO.confSearch('CPO');
    const a = [...document.querySelectorAll('#tabConf [data-conf-card]')].map(c => c.getAttribute('data-conf-row'));
    const D = PRO._confDig; const keep = JSON.stringify(D);
    for (const r of D.rows) { r.tm = []; r.new = []; r.one = ''; }
    PRO._confDigM = null;
    PRO.confSearch(''); PRO.confSearch('CPO');
    const b2 = [...document.querySelectorAll('#tabConf [data-conf-card]')].map(c => c.getAttribute('data-conf-row'));
    const empty = !!document.querySelector('#tabConf [data-conf-empty]');
    PRO._confDig = JSON.parse(keep); PRO._confDigM = null; PRO.confSearch('');
    return { a, b2, empty };
  });
  ok(R5.a.includes('2382') && !R5.a.includes('3231'), '⑤ 搜 CPO 找得到在簡報裡講 CPO 的廣達(緯創沒講 ⛔ 出現)', JSON.stringify(R5.a));
  ok(!R5.b2.includes('2382') && R5.empty, '⑤ ⭐ 決定性對照:拿掉簡報的詞 → 搜不到(證明是簡報內容在被搜)', JSON.stringify(R5));

  // ⑦ 390px 不溢出 —— 產業作戰室**不用 Tailwind**(樣式全寫在自己的 <style>)→ 沙箱量到的就是真的幾何,⛔ 不需要版面 shim
  //    (shim 只認 index.html 的 Tailwind class;拿去量 pro.html 自我檢查一定失敗 = 假紅燈)
  ok(!/tailwindcss/.test(PRO_SRC), '⑦ 🚧 產業作戰室沒有載 Tailwind(⛔ 有的話沙箱量到的幾何是假的,要改用版面 shim)');
  const R7 = await pg.evaluate(() => {
    window.scrollTo(80, 0); const wide = window.scrollX > 2; window.scrollTo(0, 0);
    const src = document.getElementById('tabConf');
    const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:0;top:0;width:358px;max-width:358px;display:block';
    const box = src.cloneNode(true); box.removeAttribute('id'); box.classList.remove('hidden'); box.setAttribute('style', 'display:block;width:358px;max-width:358px');
    host.appendChild(box); document.body.appendChild(host);
    const out = [];
    for (const el of box.querySelectorAll('div,span,button,a,details,summary')) {
      if (!el.offsetParent) continue;
      const pa = el.parentElement; if (!pa) continue;
      const a = el.getBoundingClientRect(), p = pa.getBoundingClientRect();
      if (p.width < 40 || a.width < 20) continue;
      const ps = getComputedStyle(pa);
      if (/auto|scroll/.test(ps.overflowX + ps.overflow)) continue;
      const over = Math.round(a.right - p.right);
      if (over > 6) out.push(`${(el.className || el.tagName).toString().slice(0, 30)}+${over}`);
    }
    const w = Math.round(box.getBoundingClientRect().width), n = box.querySelectorAll('[data-conf-card]').length;
    host.remove();
    return { wide, w, n, out: out.slice(0, 6) };
  });
  ok(R7.w >= 350 && R7.n >= 4, '⑦ 🚧 空過守門:量測容器 358px 而且裡面真的有卡片', JSON.stringify({ w: R7.w, n: R7.n }));
  ok(!R7.wide && R7.out.length === 0, '⑦ 390px:頁面不橫捲、卡片裡沒有東西超出父層', JSON.stringify(R7));

  // ④ digest 整份讀不到 → 頁頭說「還沒產出、⛔ 不代表簡報沒內容」,卡片說「還沒讀到」(⛔ 說成沒有法說會)
  const R8 = await pg.evaluate(async () => {
    PRO._confDig = null; PRO._confDigM = null;
    PRO._cache['data/confcall_digest.json'] = null;
    PRO._confData = undefined; PRO._confDig = undefined;
    delete PRO._cache['data/confcall_digest.json'];
    await PRO.renderConf();
    await new Promise(r => setTimeout(r, 300));
    const meta = document.getElementById('confMeta');
    const nod = meta && meta.querySelector('[data-conf-nodigest]');
    const card = document.querySelector('[data-conf-card][data-conf-row="2382"]');
    return { nod: nod ? nod.textContent : '', none: card?.querySelector('[data-cc-none]')?.textContent || '',
             empty: !!document.querySelector('#tabConf [data-conf-empty]') };
  });
  ok(/還沒產出/.test(R8.nod) && /不代表簡報沒內容/.test(R8.nod), '④ digest 讀不到:頁頭寫「還沒產出」⛔ 不代表簡報沒內容', R8.nod);
  ok(/還沒讀到/.test(R8.none) && !R8.empty, '④ 場次照列、卡片寫「還沒讀到」(⛔ 不可變成「沒有法說會」)', JSON.stringify(R8));
  ok(errs.length === 0, '產業作戰室 0 個 pageerror', errs.join(' | '));
  await pg.close();
}

// ══════════ V79.6.4 巡邏:清單也列「讀不成的」+ 拿舊簡報重講的那一場 ══════════
{
  const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await pg.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
  await pg.goto(pathToFileURL(resolve('pro.html')).href);
  await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderConf, null, { timeout: 30000 });
  await pg.evaluate(() => { try { localStorage.removeItem('proTerminalInv'); localStorage.removeItem('proTerminalFavGroups'); } catch (_) {} });
  const DR = dOff(-3), D0 = dOff(-40);
  const CONF2 = Object.assign({}, CONF, { upcoming: [], recent: [
    row('1301', '台塑', dOff(-2), '14:00', '', [fOf('1301', dOff(-2))]),
    row('1303', '南亞', dOff(-3), '14:00', '', [fOf('1303', dOff(-3))]),
    row('1326', '台化', dOff(-4), '14:00', '', [fOf('1326', dOff(-4))]),
    row('2002', '中鋼', dOff(-5), '14:00', '', [fOf('2002', dOff(-5))]),
    row('2412', '中華電', DR, '15:00', '受邀參加某證券論壇', [fOf('2412', D0)]),       // 拿 40 天前那份重講
    row('2412', '中華電', D0, '14:00', '', [fOf('2412', D0)]),
    row('2881', '富邦金', dOff(-2), '14:00', '', [fOf('2881', dOff(-2))]),
  ] });
  const stRow = (s, d, st, x) => Object.assign({ s, name: s, d, t: '', f: fOf(s, d), st, new_n: 0, inv: 0 }, x);
  const DIG2 = { updated: `${today}T18:00`, days: 60, n: 6, n_ok: 2, rows: [
    stRow('1301', dOff(-2), 'no_text'), stRow('1303', dOff(-3), 'dl_fail', { tries: 1, gave_up: 0 }),
    stRow('1326', dOff(-4), 'dl_fail', { tries: 3, gave_up: 1 }), stRow('2002', dOff(-5), 'bad_file'),
    dg('2412', D0, { st: 'ok', one: '5G 用戶數成長', new: ['低軌衛星', 'AI', '資料中心', '雲端'], new_n: 4, prev_d: dOff(-130) }),
    dg('2881', dOff(-2), { st: 'ok', ol: '預期明年獲利成長', new: ['新興市場'], new_n: 1, prev_d: dOff(-95) }),
  ] };
  const CC2412 = { s: '2412', name: '中華電', decks: [{ d: D0, f: fOf('2412', D0), st: 'ok', pages: 20, outlook: [[3, '預期明年獲利成長 5%']],
    nums: [[4, '資本支出 300 億元']], new: [['低軌衛星', 5]], n_new: 4, prev_d: dOff(-130) }] };
  const K2412 = [{ date: D0.replace(/-/g, '/'), close: 100 }, { date: DR.replace(/-/g, '/'), close: 110 }, { date: dOff(-1).replace(/-/g, '/'), close: 121 }];
  await pg.evaluate(({ CONF2, DIG2, CC2412, K2412, K0050 }) => {
    PRO._cache['data/confcall.json'] = CONF2;
    PRO._cache['data/confcall_digest.json'] = DIG2;
    PRO._cache['data/cc/2412.json'] = CC2412;
    PRO._cache['data/2412.json'] = K2412;
    PRO._cache['data/0050.json'] = K0050;
    PRO._cache['data/playbook_edge.json'] = { picks: [] };
    PRO._cache['data/screener.json'] = { rows: [] };
    PRO._names = Object.assign(PRO._names || {}, { 1301: '台塑', 1303: '南亞', 1326: '台化', 2002: '中鋼', 2412: '中華電', 2881: '富邦金' });
    PRO.loadNames = async () => PRO._names;
  }, { CONF2, DIG2, CC2412, K2412, K0050: [{ date: D0.replace(/-/g, '/'), close: 50 }, { date: dOff(-1).replace(/-/g, '/'), close: 51 }] });
  await pg.evaluate(() => PRO.switchTab('conf'));
  await pg.waitForTimeout(900);
  const R = await pg.evaluate(async ({ DR }) => {
    const tab = document.getElementById('tabConf');
    const card = s => tab.querySelector(`[data-conf-card][data-conf-row="${s}"]`);
    const o = { cards: [...tab.querySelectorAll('[data-conf-card]')].map(c => c.getAttribute('data-conf-row')),
                past: tab.querySelector('[data-conf-sec="past"]')?.textContent || '', meta: document.getElementById('confMeta')?.innerText || '' };
    for (const s of ['1301', '1303', '1326', '2002']) {
      const c = card(s);
      o[s] = { st: c?.querySelector('[data-cc-st]')?.getAttribute('data-cc-st') || '', line: c?.querySelector('[data-cc-stline]')?.textContent || '',
               none: !!c?.querySelector('[data-cc-none]'), det: !!c?.querySelector('details[data-dk^="ccd-"]'), newTag: !!c?.querySelector('[data-cc-new],[data-cc-first]') };
    }
    const c2 = card('2412');
    o.r2412 = { reuse: c2?.querySelector('[data-cc-reuse]')?.textContent || '', newTag: !!c2?.querySelector('[data-cc-new]'),
                newlist: !!c2?.querySelector('[data-cc-newlist]'), note: c2?.querySelector('[data-cc-reusenote]')?.textContent || '' };
    // 📞 V79.7.7 點那一場 → 公司檔案(重點分頁):說明用的是哪一場的簡報 + 開完到現在從「這一場」算
    if (c2) {
      c2.click();
      for (let i = 0; i < 40 && !/[+-]\d+\.\d%/.test(document.querySelector('#confDossier [data-ccd-px]')?.textContent || ''); i++) await new Promise(r => setTimeout(r, 50));
      o.det = (document.querySelector('#confDossier [data-ccd-body]')?.textContent || '').replace(/\s+/g, ' ');
    }
    return o;
  }, { DR });
  const md = d => d.slice(5).replace('-', '/');
  ok(R['1301'].line.includes('圖片') && R['1303'].line.includes('之後每天會再試') && R['1326'].line.includes('連續 3 天') && R['2002'].line.includes('找不到'),
     '⑨ 讀不成的四種各自寫原因(只有圖片 / 下載失敗還會再試 / 試了 3 天 / 檔案不在)', JSON.stringify([R['1301'].line, R['1303'].line, R['1326'].line, R['2002'].line]));
  ok(['1301', '1303', '1326', '2002'].every(s => R[s].st && !R[s].none && !R[s].det && !R[s].newTag),
     '⑨ 讀不成的 ⛔ 寫「還沒讀到」、⛔ 有「看重點」、⛔ 標新東西 / 第一次收錄(標「📄 讀不到」)', JSON.stringify(['1301', '1303', '1326', '2002'].map(s => R[s])));
  ok(/已經開完 6 場・簡報讀到 2 份/.test(R.past) && /最近 60 天讀到 2 份\(另 4 份讀不到或還在試\)/.test(R.meta),
     '⑨b「簡報讀到 N 份」只算讀成功的,讀不成的另外寫(場次那一行 + 頁頭那一行都是)', `${R.past} | ${R.meta}`);
  ok(R.r2412.reuse.includes(`沿用 ${md(D0)} 那場的簡報`) && !R.r2412.newTag && !R.r2412.newlist && R.r2412.note.includes(md(D0)),
     '⑩ 拿 40 天前那份重講的那一場 → 🔁 沿用那場的簡報,⛔ 標「🆕 新東西」(那是 40 天前的新東西)', JSON.stringify(R.r2412));
  ok(R.cards.indexOf('2881') >= 0 && R.cards.indexOf('2881') < R.cards.indexOf('2412'),
     '⑩b 排序:真的有 1 個新東西的富邦金,排在重講的中華電前面(重講的新東西算 0)', JSON.stringify(R.cards));
  ok(/用的是 \d\d\/\d\d 那場的同一份簡報/.test(R.det || '') && /\+10\.0%/.test(R.det || '') && !/\+21\.0%/.test(R.det || ''),
     '⑩c 展開重講那場:說明用的是哪一場的簡報;開完到現在從「這一場」算(+10.0%,⛔ 從第一次用那份的日子算 +21.0%)', (R.det || '').slice(0, 300));
  ok(errs.length === 0, '產業作戰室(讀不成 / 重講)0 個 pageerror', errs.join(' | '));
  await pg.close();
}

// ══════════ 散戶 App 個股「基本」頁 ══════════
{
  const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await pg.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
  await pg.goto(pathToFileURL(resolve('index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => typeof app !== 'undefined' && !!app._renderCorpConfCall, null, { timeout: 30000 });
  const cc = (s, d, one) => ({ s, name: s, decks: [
    { d, f: fOf(s, d), st: 'ok', inv: 0, outlook: [[5, '預期第四季營收季增 5%']], nums: [[3, '毛利率 12.5%'], [4, '資本支出 120 億元'], [6, '出貨量季增 15%'], [9, '營益率 6.1%']],
      new: [['CPO', 7], ['機器人', 8]], prev_d: dOff(-95), ai: { one } }] });
  const R = await pg.evaluate(async ({ C2330, C2454, CONF }) => {
    const o = {};
    app._confcallCache = CONF;
    app._ccCache = { 2330: C2330, 2317: null };
    const el = document.getElementById('corpConfCall');
    // 有資料 → 顯示
    app.currentSymbolId = '2330';
    await app._renderCorpConfCall('2330');
    o.shown = !el.classList.contains('hidden') && el.querySelector('[data-corp-cc="2330"]') != null;
    o.txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ');
    o.html = el.innerHTML;
    o.link = el.querySelector('a[href*="FileDownLoad"]')?.getAttribute('href') || '';
    o.xss = !!window.__xss || !!el.querySelector('img');
    // 沒資料 → 整格不顯(⛔ 留空殼)
    app.currentSymbolId = '2317';
    await app._renderCorpConfCall('2317');
    o.hiddenWhenNone = el.classList.contains('hidden') && el.innerHTML === '';
    // 🔁 await 回來已經切走 → ⛔ 畫上一檔(陷阱 #19)
    const realFetch = window.fetch;
    let release; const gate = new Promise(r => { release = r; });
    window.fetch = async (u, opt) => {
      if (String(u).includes('data/cc/2454.json')) { await gate; return new Response(JSON.stringify(C2454), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      return realFetch(u, opt);
    };
    app.currentSymbolId = '2454';
    const p = app._renderCorpConfCall('2454');         // ⛔ 不 await:模擬網路很慢
    app.currentSymbolId = '2330';
    await app._renderCorpConfCall('2330');
    release(); await p;
    o.raceSym = el.querySelector('[data-corp-cc]')?.getAttribute('data-corp-cc');
    // ⭐ 決定性對照:沒有切走 → 同一個慢回應照常畫出來(證明擋下來的是「切走」那個判斷)
    app.currentSymbolId = '2454';
    await app._renderCorpConfCall('2454');
    o.stay = el.querySelector('[data-corp-cc]')?.getAttribute('data-corp-cc');
    window.fetch = realFetch;
    return o;
  }, { C2330: cc('2330', D2330, '<img src=x onerror="window.__xss=1">第四季營收季增 5%'), C2454: cc('2454', D2454, '聯發科那一份'), CONF });
  ok(R.shown, '⑧ 有讀到簡報 → 基本頁顯示「最近一次法說會說了什麼」', R.html.slice(0, 200));
  ok(/第 7 頁/.test(R.txt) && /CPO/.test(R.txt) && /毛利率 12\.5%/.test(R.txt) && /第 3 頁/.test(R.txt), '⑧ 第一次提到 + 公司給的數字都帶頁碼', R.txt.slice(0, 260));
  ok(/毛利率 12\.5%/.test(R.txt) && /資本支出 120 億元/.test(R.txt) && /出貨量季增 15%/.test(R.txt) && !/營益率 6\.1%/.test(R.txt),
     '⑧ 數字只列前 3 句(第 4 句收起來 ⛔ 資訊爆炸)');
  ok(/fileName=2330\d{8}M001\.pdf/.test(R.link) && /mopsov\.twse\.com\.tw\/server-java\/FileDownLoad/.test(R.link), '⑧ 簡報連結用採礦給的下載樣板(⛔ 前端寫死網址)', R.link);
  ok(!R.xss, '⑧ AI 一句話跳脫(⛔ 可以塞 HTML)');
  ok(!/實測|回測|勝率|期望值|贏大盤|偏多|偏空|利多|利空/.test(R.txt) && /不是買賣建議/.test(R.txt), '⑧ ⛔ 研究字樣 / 方向詞,並寫明不是買賣建議', R.txt);
  ok(R.hiddenWhenNone, '⑧ 沒有讀到簡報 → 整格不顯示(⛔ 留空殼)');
  ok(R.raceSym === '2330', '⑧ 🔁 慢回應回來時已經切到 2330 → ⛔ 畫成 2454', R.raceSym);
  ok(R.stay === '2454', '⑧ ⭐ 決定性對照:沒有切走 → 同一份資料照常畫出 2454', R.stay);
  ok(errs.length === 0, '散戶 App 0 個 pageerror', errs.join(' | '));
  await pg.close();
}
// ══════════ V79.6.4 巡邏:散戶 App 那一格(最新那份讀不到 / 之後還有一場 / 日期帶年份)+ 切股重畫 + 快取 ══════════
{
  const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await pg.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
  await pg.goto(pathToFileURL(resolve('index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => typeof app !== 'undefined' && !!app._renderCorpConfCall && !!app._corpTabLoad, null, { timeout: 30000 });
  const okDeck = (s, d, ol) => ({ d, f: fOf(s, d), st: 'ok', inv: 0, outlook: [[5, ol]], nums: [[3, '毛利率 30%']] });
  const imgDeck = (s, d) => ({ d, f: fOf(s, d), st: 'no_text', inv: 0, pages: 12 });
  const DOLD = dOff(-100), DIMG = dOff(-2);
  const conf = (s, pdf) => Object.assign({}, CONF, { upcoming: [], recent: [row(s, s, dOff(-1), '14:00', '', pdf)] });
  const R = await pg.evaluate(async ({ T }) => {
    const o = {};
    const el = document.getElementById('corpConfCall');
    const show = async (sym, J, cf) => {
      app._confcallCache = cf; app._ccCache = { [sym]: J }; app.currentSymbolId = sym;
      await app._renderCorpConfCall(sym);
      return { hidden: el.classList.contains('hidden'), txt: (el.innerText || el.textContent || '').replace(/\s+/g, ' '), html: el.innerHTML };
    };
    o.img = await show('1301', T.img, T.base);
    o.onlyImg = await show('1303', T.onlyImg, T.base);
    o.yr = await show('1326', T.yr, T.base);
    o.laterNew = await show('2884', T.c2884, T.l2884);
    o.laterNone = await show('2885', T.c2885, T.l2885);
    o.laterSame = await show('2886', T.c2886, T.l2886);
    o.laterNoConf = await show('2884', T.c2884, null);
    o.imgUsed = await show('1301', T.img, T.l1301);
    // _corpTabLoad:xray:false ⛔ 叫 X 光機(切股時 _autoLoadFundamentals 已經在抓),其他照畫
    const calls = [], keep = {};
    for (const k of ['applyXrayCache', '_renderCorpNums', '_renderCorpConfCall', 'showIndustryReportCache', '_retryResizeXrayCharts']) { keep[k] = app[k]; app[k] = () => { calls.push(k); }; }
    app._corpTabLoad('2330', { xray: false }); o.callsNoX = calls.splice(0);
    app._corpTabLoad('2330'); o.callsX = calls.splice(0);
    Object.assign(app, keep);
    // 快取只留最近 40 檔:先看 9999(代號最大)、再看 1001~1040 → 該刪的是 9999(最早看的)⛔ 1001(代號最小的)
    const realFetch = window.fetch;
    window.fetch = async () => new Response('nf', { status: 404 });
    app._ccCache = {}; app._ccOrder = [];
    for (const sym of ['9999', ...Array.from({ length: 40 }, (_, i) => String(1001 + i))]) { app.currentSymbolId = sym; await app._renderCorpConfCall(sym); }
    o.evict = { has9999: '9999' in app._ccCache, has1001: '1001' in app._ccCache, n: Object.keys(app._ccCache).length };
    window.fetch = realFetch;
    return o;
  }, { T: {
    img: { s: '1301', decks: [imgDeck('1301', DIMG), okDeck('1301', DOLD, '預期明年營收成長 8%')] },
    onlyImg: { s: '1303', decks: [imgDeck('1303', DIMG)] },
    yr: { s: '1326', decks: [okDeck('1326', '2025-03-10', '預期今年產能擴充')] },
    c2884: { s: '2884', decks: [okDeck('2884', DOLD, '預期放款成長')] }, l2884: conf('2884', [fOf('2884', dOff(-1))]),
    c2885: { s: '2885', decks: [okDeck('2885', DOLD, '預期手續費成長')] }, l2885: conf('2885', []),
    c2886: { s: '2886', decks: [okDeck('2886', DOLD, '預期利差擴大')] }, l2886: conf('2886', [fOf('2886', DOLD)]),
    l1301: conf('1301', [fOf('1301', DIMG)]), base: Object.assign({}, CONF, { upcoming: [], recent: [] }),
  } });
  const mdY = d => (d.slice(0, 4) !== today.slice(0, 4) ? d.slice(0, 4) + '/' : '') + d.slice(5).replace('-', '/');
  ok(/data-corp-cc-img/.test(R.img.html) && R.img.txt.includes(`${mdY(DIMG)}`) && /那一場的簡報是圖片做的/.test(R.img.txt)
     && /預期明年營收成長 8%/.test(R.img.txt) && R.img.txt.includes(mdY(DOLD)),
     '⑪ 最新那份是圖片做的 → 講出來,下面是更早那一份(日期 + 內容都是那一份的)', R.img.txt.slice(0, 300));
  ok(!R.onlyImg.hidden && /抽不出字/.test(R.onlyImg.txt) && /data-corp-cc-noimg/.test(R.onlyImg.html),
     '⑪b 只有圖片做的那份 → 照樣顯示並說抽不出字(⛔ 整格不見,看起來像沒有法說會)', R.onlyImg.txt.slice(0, 200));
  ok(R.yr.txt.includes('2025/03/10'), '⑪c 不是今年的日期帶年份(⛔ 只寫 03/10 被讀成今年)', R.yr.txt.slice(0, 200));
  ok(/還沒讀到/.test(R.laterNew.txt) && /沒有上傳簡報/.test(R.laterNone.txt) && /同一份簡報/.test(R.laterSame.txt)
     && ![R.laterNew, R.laterNone, R.laterSame].some(x => /最近一次/.test(x.txt)),
     '⑫ 之後還有一場:簡報還沒讀到 / 公司沒上傳 / 用同一份 三種說法各自對上,標題 ⛔ 再寫「最近一次」',
     JSON.stringify([R.laterNew.txt.slice(0, 120), R.laterNone.txt.slice(0, 120), R.laterSame.txt.slice(0, 120)]));
  ok(!/還有一場/.test(R.laterNoConf.txt) && /最近一次/.test(R.laterNoConf.txt), '⑫b ⭐ 決定性對照:沒有場次表 → 不講「還有一場」、標題照寫「最近一次」', R.laterNoConf.txt.slice(0, 160));
  ok(/data-corp-cc-img/.test(R.imgUsed.html) && !/data-corp-cc-later/.test(R.imgUsed.html), '⑫c 之後那場用的就是「圖片做的那份」→ ⛔ 再講一次「還有一場」', R.imgUsed.txt.slice(0, 200));
  ok(!R.callsNoX.includes('applyXrayCache') && ['_renderCorpNums', '_renderCorpConfCall', 'showIndustryReportCache'].every(k => R.callsNoX.includes(k)) && R.callsX.includes('applyXrayCache'),
     '⑬ _corpTabLoad:切股那次 ⛔ 叫 X 光機(⛔ 多打額度)、重點數字 / 法說會 / 產業報告照畫;進分頁那次才叫 X 光機', JSON.stringify([R.callsNoX, R.callsX]));
  {
    const a0 = IDX_SRC.indexOf("const _sub = this._activeSubTab || 'strategy';"), a1 = IDX_SRC.indexOf('if(!silent) {', a0);
    const blk = IDX_SRC.slice(a0, a1), cl = IDX_SRC.slice(IDX_SRC.indexOf("'ovOpenBox', 'ovColBox'"), IDX_SRC.indexOf("'ovOpenBox', 'ovColBox'") + 600);
    ok(a0 > 0 && /_sub === 'corp'[\s\S]{0,400}_corpTabLoad\(targetSym, \{ xray: false \}\)/.test(blk) && /'corpNums',/.test(cl)
       && /tab === 'corp' && this\.currentSymbolId\) this\._corpTabLoad\(this\.currentSymbolId\)/.test(IDX_SRC),
       '⑬b 停在「基本」分頁換股 → 清掉重點數字 + 重畫(analyze 尾端補跑 corp;進分頁走同一支 _corpTabLoad)');
  }
  ok(!R.evict.has9999 && R.evict.has1001 && R.evict.n === 40, '⑭ 簡報快取只留最近 40 檔,刪的是最早看的(⛔ 代號最小的)', JSON.stringify(R.evict));
  ok(errs.length === 0, '散戶 App(V79.6.4)0 個 pageerror', errs.join(' | '));
  await pg.close();
}
// ══════════ ⏸️ V79.6.5 法說會延期(2026-10-23 颱風:南亞「如台北市停班,順延至 10/27」)—— 散戶 App 的卡片與提醒 ══════════
{
  const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await pg.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
  await pg.goto(pathToFileURL(resolve('index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => typeof app !== 'undefined' && !!app._renderCorpConfCall && !!app._findEarningsEvent, null, { timeout: 30000 });
  const D0 = dOff(-1), MV = dOff(3);
  const deck = { s: '1303', decks: [{ d: D0, f: fOf('1303', D0), st: 'ok', inv: 1, outlook: [[12, '第四季合併營收將持續攀升']], nums: [[7, '第3季EPS達4.90元']] }] };
  const rowMv = Object.assign(row('1303', '南亞', D0, '14:00', '本公司受邀參加台新證券舉辦之法人說明會', [fOf('1303', D0)]),
    { other: '如台北市政府公告115/10/23停止上班，本說明會將順延至115/10/27 14:00(線上會議)', mv: MV, mvc: 1 });
  const rowPlain = Object.assign({}, rowMv); delete rowPlain.mv; delete rowPlain.mvc;
  const R = await pg.evaluate(async ({ deck, rowMv, rowPlain, CONF, MV, D0 }) => {
    const o = {};
    const el = document.getElementById('corpConfCall');
    const show = async (r) => {
      app._confcallCache = Object.assign({}, CONF, { upcoming: [r], recent: [] }); app._ccCache = { 1303: deck }; app.currentSymbolId = '1303';
      await app._renderCorpConfCall('1303');
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ');
    };
    o.mv = await show(rowMv); o.mvHtml = el.innerHTML;
    o.plain = await show(rowPlain);
    // 提醒:照新日期算(把「還有幾個交易日」釘住,⛔ 讓測試跟今天星期幾有關)
    const keep = app._tradingDaysUntil;
    app._tradingDaysUntil = d => (d === MV ? 1 : d === D0 ? -1 : 9);
    app._confcallCache = Object.assign({}, CONF, { upcoming: [rowMv], recent: [] });
    o.ev = app._findEarningsEvent('1303', 2);
    app._renderStockEarningsReminder('1303');
    o.rem = ((document.getElementById('stockEarningsReminder') || {}).innerText || '').replace(/\s+/g, ' ');
    app._confcallCache = Object.assign({}, CONF, { upcoming: [], recent: [rowPlain] });
    o.evPlain = app._findEarningsEvent('1303', 2);
    o.list = await app._loadEarningsCalls.call(Object.assign(Object.create(app), { _earnCallCache: null, _confcallCache: Object.assign({}, CONF, { upcoming: [rowMv], recent: [] }) }), '1303');
    app._tradingDaysUntil = keep;
    return o;
  }, { deck, rowMv, rowPlain, CONF, MV, D0 });
  ok(/data-corp-cc-moved/.test(R.mvHtml) && /⏸️ 公司公告:法說會遇停班就延到/.test(R.mv) && /法說會簡報\(會議還沒開\)/.test(R.mv) && !/最近一次法說會說了什麼/.test(R.mv),
     '⏸️⑮ 簡報先上傳、會議延期還沒開 → ⛔ 寫成「最近一次法說會說了什麼」,要講延到哪天、問答要開完才有', R.mv.slice(0, 220));
  ok(/最近一次法說會說了什麼/.test(R.plain) && !/延到/.test(R.plain), '⏸️⑮b 決定性對照:同一場拿掉延期 → 照舊「最近一次法說會說了什麼」', R.plain.slice(0, 120));
  ok(R.ev && R.ev.date === MV && R.ev.moved && R.ev.moved.from === D0 && /原訂/.test(R.ev.text) && /⏸️ 原訂/.test(R.rem),
     '⏸️⑯ 法說會提醒照延後的日期算,並寫出原訂日期(週一就會跳 10/27 那場)', JSON.stringify(R.ev) + ' | ' + R.rem.slice(0, 160));
  ok(R.evPlain === null, '⏸️⑯b 決定性對照:沒有延期 → 那場已經過了,⛔ 提醒', JSON.stringify(R.evPlain));
  ok(Array.isArray(R.list) && R.list.some(x => x.date === MV.replace(/-/g, '/')) && !R.list.some(x => x.date === D0.replace(/-/g, '/')),
     '⏸️⑯c 報告頁用的法說會日期清單也是延後那天(⛔ 原訂那天)', JSON.stringify(R.list));
  ok(errs.length === 0, '散戶 App(V79.6.5 延期)0 個 pageerror', errs.join(' | '));
  await pg.close();
}
await b.close();
console.log(bad ? `❌ test_confcall_ui 失敗 ${bad} 條` : '✅ CONFCALL_UI_PASS(全部通過)');
process.exit(bad ? 1 : 0);
