// 📋 V79.6.7 法說會 3.0「公司講的展望 → 做到了沒」的畫面(data/cc/{sym}.json 每份簡報的 g,confcall_guidance 算的)
//   使用者 2026-10-24:「我要的是做一個有研究價值的法說會…最終目的要融到專報裡面,告訴我這些東西有沒有價值或者追個未來展望」
//
// ⛔ 釘死的事(注入都要叫得出來):
//   ① 產業作戰室法說會卡片:可以對答案的每一句 = 公司原話 + 頁碼 + 「本站讀成什麼」+ ✅ / ❌ / ⏳ + 實際數字與來源(月營收加總 / 季報)
//   ② 對不了答案的(只講產品線 / 沒講時間)收進摺疊,⛔ 混在一起;舊的「講到之後」句子 ⛔ 重複列
//   ③ 散戶 App 基本頁那一格:這次講的最多 2 句 + 之前講過、已經有答案的最多 2 句;⛔ 研究字樣 / 方向詞(V78.3.4)
//   ④ 兩邊的判讀文字(_ccPeriod / _ccWhen / _ccWhat / _ccClaim)原始碼一字不差 + 同一批資料輸出一樣
//   ⑤ 公司原話一律跳脫(⛔ 可以塞 HTML);沒有 g → 兩邊都 ⛔ 多一個字(決定性對照)
//   ⑦ 散戶那一格引公司原話太長只引前面一段 → 截掉的一定補「…」(⛔ 讓人以為話講到這裡就完了)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : (e ? ' — ' + String(e).slice(0, 300) : '')}`); if (!c) bad++; };
const PRO_SRC = readFileSync('pro.html', 'utf8');
const IDX_SRC = readFileSync('index.html', 'utf8');

// ── ④ 原始碼:兩份判讀文字一字不差(去掉縮排)
const grab = (src) => {
  const s = src.indexOf('_CC_MN: {'), e = src.indexOf("月營收加總' : '季報'}` };", s);
  return s > 0 && e > s ? src.slice(s, src.indexOf('\n', e)).split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('//')).join('\n') : '';
};
const gP = grab(PRO_SRC), gI = grab(IDX_SRC);
ok(gP && gP === gI, '④ _ccPeriod / _ccWhen / _ccWhat / _ccClaim 兩個檔案一字不差(⛔ 只改一邊)', gP ? `pro ${gP.length} / index ${gI.length}` : '抓不到');
{
  const s = IDX_SRC.indexOf('_CC_MN: {'), e = IDX_SRC.indexOf('// 📊 V76.2.5 畫進「基本」分頁', s);
  const body = IDX_SRC.slice(s, e).replace(/\/\/[^\n]*/g, '');
  const BAD = /實測|回測|勝率|期望值|贏大盤|0050|偏多|偏空|利多|利空|說到做到率/;
  ok(s > 0 && e > s && !BAD.test(body), '③ 散戶那一格的原始碼(含判讀文字)⛔ 研究字樣 / 方向詞', (body.match(BAD) || [])[0]);
}

// ── 測資(格式照 confcall_guidance.deck_claims 的真實輸出)
const XSS = '第四季合併營收將持續攀升<img src=x onerror="window.__xss=1">,整體績效將優於第三季。';
const G_NEW = [
  { p: 13, t: XSS, m: 'rev', dir: 'up', h: '2026Q4', ok: 1, r: { res: 'pending', cur: '2026Q4', base: '2026Q3' } },
  { p: 13, t: '第四季起高階材料進入出貨與驗証併行階段,將帶動電子材料產品業績成長。', m: 'rev', dir: 'up', h: '2026Q4', ok: 0, seg: 1 },
  { p: 12, t: '預期毛利率第四季將持平', m: 'gm', dir: 'flat', h: '2026Q4', ok: 1, r: { res: 'pending', cur: '2026Q4', base: '2026Q3' } },
];
const G_OLD = [
  { p: 9, t: '預期第三季營收將較上季成長', m: 'rev', dir: 'up', h: '2026Q3', ok: 1, cmp: 'QoQ',
    r: { res: 'hit', known: '2026-10-10', cur: '2026Q3', base: '2026Q2', src: 'm', chg: 14.21, a: 955.97, b: 837.07 } },
  { p: 10, t: '今年目標轉虧為盈', m: 'ni', dir: 'pos', h: '2026', ok: 1, r: { res: 'miss', known: '2027-03-31', cur: '2026', base: '2025', src: 'q', a: -3.2 } },
];
const DK_NEW = { d: '2026-10-23', f: '130320261022M001.pdf', st: 'ok', pages: 15, g: G_NEW,
  outlook: [[13, XSS], [13, '年初預期,今年會是亮麗的一年。']], nums: [[7, '前三季EPS達10.07元']] };
const DK_OLD = { d: '2026-07-30', f: '130320260730M001.pdf', st: 'ok', pages: 14, g: G_OLD, outlook: [], nums: [[5, '上半年營收 1,800 億元']] };

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});

const SAMPLE = [...G_NEW, ...G_OLD,
  { p: 1, t: 'x', m: 'om', dir: 'up', h: '2026H2', ok: 1, r: { res: 'miss', cur: '2026H2', base: '2026H1', src: 'q', chg: -0.42, a: 13.1, b: 13.5 } },
  { p: 1, t: 'y', m: 'ni', dir: 'down', h: '2026', ok: 1, r: { res: 'na', cur: '2026', base: '2025' } },
  { p: 1, t: 'z', m: 'demand', dir: 'up', h: null, ok: 0 }];
const fx = (S) => S.map(c => [PRO_OR_APP._ccClaim(c), PRO_OR_APP._ccWhat(c), PRO_OR_APP._ccWhen(c)]);

// ══════════ 產業作戰室 ══════════
let proOut = null;
{
  const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await pg.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
  await pg.goto(pathToFileURL(resolve('pro.html')).href);
  await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._confDetailHtml, null, { timeout: 30000 });
  const R = await pg.evaluate(({ DK_NEW, DK_OLD, SAMPLE, fxs }) => {
    const PRO_OR_APP = PRO;
    const fx = new Function('PRO_OR_APP', 'S', `return (${fxs})(S)`);
    const box = document.createElement('div');
    box.innerHTML = PRO._confDetailHtml(DK_NEW, '1303', DK_NEW.d);
    document.body.appendChild(box);
    const g = box.querySelector('[data-ccd-g]');
    const items = g ? [...g.querySelectorAll('[data-ccd-gi]')].map(x => ({ res: x.getAttribute('data-ccd-gi'), inDet: !!x.closest('details'), txt: x.textContent })) : [];
    const ol = box.querySelector('[data-ccd-ol]')?.textContent || '';
    const box2 = document.createElement('div');
    box2.innerHTML = PRO._confDetailHtml(DK_OLD, '1303', DK_OLD.d);
    const old = [...box2.querySelectorAll('[data-ccd-gi]')].map(x => x.textContent);
    const box3 = document.createElement('div');
    box3.innerHTML = PRO._confDetailHtml(Object.assign({}, DK_NEW, { g: undefined }), '1303', DK_NEW.d);
    return { items, ol, old, noG: !box3.querySelector('[data-ccd-g]'), ol3: box3.querySelector('[data-ccd-ol]')?.textContent || '',
             xss: !!window.__xss || !!box.querySelector('img'), out: fx(PRO_OR_APP, SAMPLE), head: g ? g.firstChild?.textContent + (g.querySelector('b')?.textContent || '') : '' };
  }, { DK_NEW, DK_OLD, SAMPLE, fxs: fx.toString().replace(/^\(S\) => /, '(S) => ') });
  proOut = R.out;
  const main = R.items.filter(x => !x.inDet), det = R.items.filter(x => x.inDet);
  ok(main.length === 2 && main.every(x => x.res === 'pending') && det.length === 1 && det[0].res === 'skip',
     '① 可以對答案的 2 句在外面、只講產品線的那句收進摺疊', JSON.stringify(R.items.map(x => [x.res, x.inDet])));
  ok(/第四季合併營收將持續攀升/.test(main[0].txt) && /第 13 頁/.test(main[0].txt) && /本站讀成:2026 第 4 季營收比 2026 第 3 季比較好/.test(main[0].txt)
     && /⏳/.test(main[0].txt) && /12 月營收出來\(2027\/01\/10 前\)就知道/.test(main[0].txt),
     '① 每一句:公司原話 + 頁碼 + 本站讀成什麼 + ⏳ 什麼時候知道(營收看月營收)', main[0] && main[0].txt);
  ok(/第 4 季財報出來\(2027\/03\/31 前\)就知道/.test(main[1].txt) && /毛利率比 2026 第 3 季差不多/.test(main[1].txt),
     '① 毛利率看季報:第四季財報 3/31 前', main[1] && main[1].txt);
  ok(/只講某個產品線/.test(det[0] ? det[0].txt : ''), '② 摺疊裡寫出為什麼不對答案', det[0] && det[0].txt);
  ok(/其他講到「之後」的句子/.test(R.ol) && /今年會是亮麗的一年/.test(R.ol) && !/第四季合併營收將持續攀升/.test(R.ol),
     '② 舊的「講到之後」句子:已經在上面的 ⛔ 重複列,其他照留', R.ol);
  ok(R.old.length === 2 && /✅/.test(R.old[0]) && /做到了:2026 第 3 季 營收 955\.97 億 vs 2026 第 2 季 837\.07 億\(\+14\.2%\)・月營收加總/.test(R.old[0])
     && /❌/.test(R.old[1]) && /沒做到:2026 全年 稅後淨利 -3\.2 億\(還是虧損\)・季報/.test(R.old[1]),
     '① 已經有答案的:✅ / ❌ + 實際數字 + 來源(月營收加總 / 季報)', JSON.stringify(R.old));
  ok(R.noG && /講到「之後」的句子/.test(R.ol3) && /第四季合併營收將持續攀升/.test(R.ol3),
     '⑤ ⭐ 決定性對照:沒有 g → 沒有「做到了沒」那段、舊句子照舊全部列', R.ol3);
  ok(!R.xss, '⑤ 公司原話一律跳脫(塞 <img onerror> ⛔ 變成元素)');
  ok(!errs.length, '⓪ 產業作戰室沒有 pageerror', errs.join(' | '));
  await pg.close();
}

// ══════════ 散戶 App ══════════
{
  const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await pg.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
  await pg.goto(pathToFileURL(resolve('index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => typeof app !== 'undefined' && !!app._corpConfCallHtml && !!app._ccClaim, null, { timeout: 30000 });
  const R = await pg.evaluate(({ DK_NEW, DK_OLD, SAMPLE, fxs }) => {
    const PRO_OR_APP = app;
    const fx = new Function('PRO_OR_APP', 'S', `return (${fxs})(S)`);
    app._confcallCache = null;
    const mk = (decks) => { const d = document.createElement('div'); d.innerHTML = app._corpConfCallHtml('1303', { s: '1303', name: '南亞', decks }); return d; };
    const a = mk([DK_NEW, DK_OLD]);
    const gNew = a.querySelector('[data-corp-cc-g]')?.textContent || '', gPast = a.querySelector('[data-corp-cc-past]')?.textContent || '';
    const pend = JSON.parse(JSON.stringify(DK_OLD)); pend.g.forEach(c => { c.r = { res: 'pending', cur: c.h, base: '2026Q2' }; });
    const b2 = mk([DK_NEW, pend]);
    const c = mk([Object.assign({}, DK_NEW, { g: undefined })]);
    // 📞 報告頁(專報)§7:跟基本頁同一支 _corpConfCallHtml;還沒載過 → 先回空 + 背景載
    app.currentSymbolId = '1303';
    app._ccCache = { 1303: { s: '1303', name: '南亞', decks: [DK_NEW, DK_OLD] }, 2317: null };
    const rp = document.createElement('div'); rp.innerHTML = app._rpConfHtml({ sym: '1303' });
    const rpT = rp.querySelector('summary')?.textContent || '', rpBody = rp.querySelector('[data-corp-cc-g]')?.textContent || '';
    let loads = 0; const _orig = app._renderCorpConfCall; app._renderCorpConfCall = async () => { loads++; };
    const rpNone = app._rpConfHtml({ sym: '9999' }), rpNull = app._rpConfHtml({ sym: '2317' });
    app._renderCorpConfCall = _orig;
    const order = ['rpFund', 'rpConf', 'rpChip'].map(id => document.getElementById(id));
    const inOrder = order.every(Boolean) && (order[0].compareDocumentPosition(order[1]) & 4) && (order[1].compareDocumentPosition(order[2]) & 4);
    return { rpT, rpBody, rpNone, rpNull, loads, inOrder: !!inOrder,
             gNew, gPast, noPast: !b2.querySelector('[data-corp-cc-past]'), noG: !c.querySelector('[data-corp-cc-g]') && !c.querySelector('[data-corp-cc-past]'),
             xss: !!window.__xss || !!a.querySelector('img'), txt: (a.textContent || '').replace(/\s+/g, ' '), out: fx(PRO_OR_APP, SAMPLE) };
  }, { DK_NEW, DK_OLD, SAMPLE, fxs: fx.toString() });
  ok(/📋 公司講的展望/.test(R.gNew) && (R.gNew.match(/⏳/g) || []).length === 2 && /第四季合併營收將持續攀升/.test(R.gNew) && /第 13 頁/.test(R.gNew)
     && /12 月營收出來\(2027\/01\/10 前\)就知道/.test(R.gNew) && !/電子材料產品業績/.test(R.gNew),
     '③ 這次講的:最多 2 句可以對答案的(⛔ 只講產品線那句)+ 什麼時候知道', R.gNew);
  ok(/之前講的,做到了沒/.test(R.gPast) && /✅/.test(R.gPast) && /07\/30/.test(R.gPast) && /955\.97 億 vs 2026 第 2 季 837\.07 億/.test(R.gPast) && /❌/.test(R.gPast),
     '③ 之前講過、已經有答案的:日期 + 公司原話 + ✅ / ❌ + 數字', R.gPast);
  ok(R.noPast, '③ ⭐ 決定性對照:之前那份還沒到期 → ⛔ 列「之前講的,做到了沒」');
  ok(R.noG, '⑤ ⭐ 決定性對照:沒有 g → 那兩段一個字都沒有');
  ok(/§7 法說會:公司講了什麼、做到了沒/.test(R.rpT) && /📋 公司講了 2 句可以對答案的展望 ・✅ 0 ・❌ 0 ・⏳ 2/.test(R.rpT) && /第四季合併營收將持續攀升/.test(R.rpBody),
     '⑥ 報告頁(專報)§7:標題寫出幾句展望 + ✅ / ❌ / ⏳ 各幾句,內容跟基本頁同一支', R.rpT);
  ok(R.rpNone === '' && R.loads === 1 && R.rpNull === '', '⑥ 還沒載過 → 先回空、背景載一次;讀不到(null)→ 整格不顯', JSON.stringify({ n: R.rpNone, l: R.loads, z: R.rpNull }));
  ok(R.inOrder, '⑥ 報告頁照 § 由小到大:§4~§6 財報 → §7 法說會 → §10 籌碼');
  ok(!R.xss, '⑤ 公司原話一律跳脫');
  const BAD = /實測|回測|勝率|期望值|贏大盤|偏多|偏空|利多|利空|會漲|會跌/;
  ok(!BAD.test(R.txt), '③ 畫面上 ⛔ 研究字樣 / 方向詞', (R.txt.match(BAD) || [])[0]);
  ok(JSON.stringify(R.out) === JSON.stringify(proOut), '④ 同一批資料:散戶 App 與產業作戰室的判讀文字輸出一模一樣',
     JSON.stringify(R.out).slice(0, 200) + ' ≠ ' + JSON.stringify(proOut).slice(0, 200));
  // ✂️ ⑦ 公司原話太長只引前面一段 → 截掉的一定補「…」(10/24 截圖:南亞那句剛好切在「優於第三季,」看起來像話講完了)
  const Q = await pg.evaluate(() => {
    const S = '2026年南亞前三季表現站上歷史新高，第四季合併營收將持續攀升，主要仍受惠於應用在電子科技領域的各項電子材料需求暢旺，整體績效將優於第三季，如同年初預期，今年會是亮麗的一年。';
    const L = S + S;   // 一定超過 90 字
    const card = (t) => { const d = document.createElement('div');
      d.innerHTML = app._corpConfCallHtml('1303', { s: '1303', name: '南亞', decks: [{ d: '2026-10-23', f: 'x.pdf', st: 'ok', pages: 15,
        g: [{ p: 13, t, m: 'rev', dir: 'up', h: '2026Q4', ok: 1, r: { res: 'pending', cur: '2026Q4', base: '2026Q3' } }], outlook: [], nums: [] }] });
      return d.querySelector('[data-corp-cc-g]')?.textContent || ''; };
    return { len: S.length, fit: app._ccQuote(S, 120), cut: app._ccQuote(S, 70), long: card(L), short: card(S) };
  });
  ok(Q.fit.length === Q.len && !/…$/.test(Q.fit), '⑦ 整句放得下 → 原文一個字都不少、⛔ 補「…」', Q.fit.slice(-12));
  ok(/…$/.test(Q.cut) && !/[，,、;；:：]…$/.test(Q.cut) && Q.cut.length <= 71, '⑦ 截短 → 尾巴補「…」、⛔ 留逗號', Q.cut.slice(-12));
  ok(/…」/.test(Q.long) && !/…」/.test(Q.short), '⑦ ⭐ 決定性對照:卡片上太長的那句才有「…」,放得下的照原文', JSON.stringify({ long: Q.long.slice(-40), short: Q.short.slice(-40) }));
  ok(!errs.length, '⓪ 散戶 App 沒有 pageerror', errs.join(' | '));
  await pg.close();
}
await b.close();
console.log(bad ? `\n❌ test_ccguide_ui 失敗 ${bad} 條` : '\n✅ test_ccguide_ui 全過');
process.exit(bad ? 1 : 0);
