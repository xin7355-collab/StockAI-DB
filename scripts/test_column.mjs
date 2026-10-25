#!/usr/bin/env node
/**
 * 📰 V78.4.0 產業作戰室「專欄」守門(使用者:「要它那種說明方式,不要只有 AI 看得懂的;
 *    爾後回測有價值的資訊就直接幫我做成專欄」)
 *   ① 有 col 的條目必有 q / do / warn / how / s(問答式五段)
 *   ② ⛔ 只有 AI 看得懂的字:pp / 六關 / p= / n= / 安慰劑 / 樣本外 / 探針 / 檔名 / 函式名
 *   ③ 決定性對照:改條目 `pl[5]` → 專欄的「📊 數字說話」跟著變(⛔ 數字不重抄)
 *   ④ 🔁 爾後規則:`u ≥ 2026-10-03` 的 ✅ 有用條目沒有 col → 紅(擋住「回測完忘了寫專欄」)
 *   ⑤ 🧬 模式也看得到 👑 專欄(V79.1.8 `_labOf` 走 `_labLeadOn`)
 *   ⑥ 第一篇「該選哪一套」金額 == `_PROFIT_BOARD`(決定性對照:改 fin → 畫面跟著變)
 *   ⑦ 搜尋 / 系列篩選真的會篩
 *   ⑧ 破解迷思那幾篇(沒有 pl)要自帶 a / num / mean
 *   🆕 V78.4.1 封面卡版面(照 signova 專欄頁):
 *   ⑩ 每一篇都有 📏 資料範圍(col.range)
 *   ⑪ 封面數字章從「數字說話」抓(決定性對照:改 pl[5] → 封面章跟著變;「100 萬」本金不當封面)
 *   ⑫ 閱讀時間跟著字數變 ・⑬ 分類篇數 == 實際篇數 ・⑭ NEW 只標最新那天 ・⑮ ⛔ 沒有瀏覽 / 按讚 / 留言數(沒有後端,只能編)
 *   ⑯ 👑 模式:多出 👑 領頭羊 分類、也⛔ AI 才懂的字;🧬 模式沒有那個分類
 *   🆕 V79.8.5 數字統一 + 排序(使用者:「專欄沒有排序,而且有些是寫錢,有些寫百分比」):
 *   ⑲ 每一篇都有 col.fig(pct 是數字 + what / rate 是 0~100 + rw / 兩個都沒有就要寫 na 原因)
 *   ⑳ 封面章 == fig(📈 百分比 / 🎲 發生率),⛔ 再從文字抓(決定性對照:把「數字說話」改成「開低 2% 以上 2.4 萬次」→ 封面不變)
 *   ㉑ 金額只由 pct 換算(決定性對照:pct 改 −0.35 → 「−3,500 元」、改 520 → 「+520 萬」)
 *   ㉒ 排序:同一顆再按一次反向、沒有那個數字的不管哪個方向都在最後、⭐ == _starRank、🏆 有用在前
 *   注入:INJECT=badge(封面章寫死)/ INJECT=money(金額寫死)/ INJECT=sortdir(反向不生效)/ INJECT=nofig(拿掉一篇的 fig)
 * 注入(逐一確認會紅):INJECT=nocol(把一篇的 col.warn 拿掉)/ INJECT=pp(在一篇裡塞「+0.9pp」)/ INJECT=copy(數字改成抄 col.num)
 *   / INJECT=range(拿掉一篇的 range)/ INJECT=badge(封面章寫死)
 *   🆕 V78.4.2 觸發式專欄(使用者:「觸發專欄有的條件就跳出來…爾後都記住,不要我想到才做」):
 *   ⑰ 每一篇 col 都寫了 `trig`(條件陣列)或 `'none'` + `trigWhy`;條件 id 都在 index.html `_COL_TRIG_IDS`
 *   ⑱ index.html 的 `_COL_TRIG` 抄本 == pro.html 現在的專欄(scripts/embed_col_trig.mjs)
 *   注入:INJECT=notrig(拿掉一篇的 trig)/ INJECT=nowhy(一篇 'none' 但沒寫為什麼)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'nocol') SRC = SRC.replace(/"warn": "只買 2 檔[^"]*", /, '');
if (INJ === 'pp') SRC = SRC.replace('"q": "一天要買幾檔?"', '"q": "一天要買幾檔?多賺 +0.9pp"');
if (INJ === 'copy') SRC = SRC.replace("const a = C.a || pl[3] || '', num = C.num || pl[5] || ''", "const a = C.a || pl[3] || '', num = C.num || '固定的數字'");
if (INJ === 'range') SRC = SRC.replace(/"range": "36 個月・600 檔", /, '');
if (INJ === 'badge') SRC = SRC.replace("return { pct: this._figPct(f.pct), rate: this._figRate(f.rate) };", "return { pct: '+99%', rate: '' };");
if (INJ === 'money') SRC = SRC.replace("`${sg}${this._figNum(p, 1)} 萬`", "'+1 萬'");
if (INJ === 'sortdir') SRC = SRC.replace('      return c * dir;', '      return -c;');
if (INJ === 'nofig') SRC = SRC.replace(/, "fig": \{"pct": 181, [^}]*\}/, '');
if (INJ === 'notrig') SRC = SRC.replace('"trig": ["lu_held"], ', '');
if (INJ === 'nowhy') SRC = SRC.replace(/"trigWhy": "[^"]*", /, '');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_column.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof PRO !== 'undefined' && typeof PRO.renderCol === 'function', null, { timeout: 60000 });

const R = await page.evaluate(async () => {
    const out = {};
    const all = [];
    for (const c of ['ok', 'trap']) for (const x of (PRO.LAB[c] || [])) if (x && x.col) all.push({ c, k: x.k, u: x.u, col: x.col, pl: x.pl, t: x.t });
    out.items = all.map(x => ({ c: x.c, k: x.k, s: x.col.s, q: x.col.q, has: ['q', 'do', 'warn', 'how', 's'].filter(f => x.col[f] && (!Array.isArray(x.col[f]) || x.col[f].length)), myth: ['a', 'num', 'mean'].filter(f => x.col[f]), pl: Array.isArray(x.pl) }));
    out.newOkNoCol = (PRO.LAB.ok || []).filter(x => String(x.u || '') >= '2026-10-03' && !x.col).map(x => String(x.t).replace(/<[^>]+>/g, '').slice(0, 40));
    out.okU = (PRO.LAB.ok || []).filter(x => String(x.u || '') >= '2026-10-03').length;
    PRO.switchTab('col', true);
    const list = document.getElementById('colList');
    list.querySelectorAll('details').forEach(d => d.open = true);
    out.text = list.innerText;
    out.n = list.querySelectorAll('details.colart').length;
    // ③ 決定性對照:改 pl[5]
    const e = (PRO.LAB.ok || []).find(x => x.k === 'two-a-day');
    if (e) { const keep = e.pl[5]; e.pl[5] = '決定性對照數字 777'; PRO.renderCol(); document.querySelectorAll('#colList details').forEach(d => d.open = true); out.t3 = document.getElementById('colList').innerText; e.pl[5] = keep; PRO.renderCol(); }
    // ⑥ 第一篇讀 _PROFIT_BOARD
    const B = PRO._PROFIT_BOARD, hot = B.wins.ai.rows.find(r => r.k === 'hot');
    out.hotWan = Math.round(hot.fin / 10000).toLocaleString();
    out.pick = (document.querySelector('[data-colk="pick"]') || {}).innerText || '';
    const keep = hot.fin; hot.fin = 12340000; PRO.renderCol(); out.pick2 = (document.querySelector('[data-colk="pick"]') || {}).innerText || ''; hot.fin = keep; PRO.renderCol();
    // 📅 V79.6.2 第一篇的資料範圍要寫起訖(讀看板)
    out.pickIsLink = !!document.querySelector('[data-colk="pick"] [onclick*="navGo(\'pick\')"]');
    out.pickNotArt = !document.querySelector('details.colart[data-colk="pick"]');
    out.allCnt = +((document.querySelector('#colBar [data-colser=""] .c') || {}).textContent || -1);
    out.pickFromL = B.wins.long.from; out.pickFromA = B.wins.ai.from; out.pickTo = B.to;
    // ⑤ 🧬 vs 👑:把一篇假裝成 👑 條目 → 🧬 看不到
    const z = (PRO.LAB.ok || []).find(x => x.k === 'equal-weight'); const kz = z.k; z.k = 'leader-test-col';
    PRO.renderCol(); out.geneHasLead = !!document.querySelector('[data-colk="leader-test-col"]');
    z.k = kz; PRO.renderCol();
    // ⑦ 搜尋 / 系列
    PRO.colSearch('跌停'); out.qN = document.querySelectorAll('#colList details.colart').length; out.qPick = !!document.querySelector('[data-colk="pick"]');
    PRO.colSearch(''); PRO.colSeries('破解迷思'); out.sN = [...document.querySelectorAll('#colList details.colart')].map(d => d.dataset.cols);
    PRO.colSeries('破解迷思');
    PRO.colSeries('破解迷思');
    // ⑩ range
    out.noRange = all.filter(x => !x.col.range).map(x => x.k);
    // ⑲⑳㉑ 封面數字章只讀 fig
    PRO._colS = ''; PRO._colQ = ''; PRO._colSort = 'u'; PRO._colDir = -1;
    out.figBad = all.map(x => {
      const f = x.col.fig;
      if (!f) return x.k + ' 沒有 fig';
      const okP = f.pct == null || (typeof f.pct === 'number' && isFinite(f.pct) && String(f.what || '').trim());
      const okR = f.rate == null || (typeof f.rate === 'number' && f.rate >= 0 && f.rate <= 100 && String(f.rw || '').trim());
      const any = f.pct != null || f.rate != null || String(f.na || '').trim();
      return okP && okR && any ? null : x.k + ' ' + JSON.stringify(f);
    }).filter(Boolean);
    PRO.renderCol();
    out.badgeBad = [...document.querySelectorAll('#colList details.colart')].map(d => {
      const x = all.find(y => y.k === d.dataset.colk), f = (x && x.col.fig) || {};
      const b = (d.querySelector('[data-colbadge]') || {}).textContent || '', r = (d.querySelector('[data-colrate]') || {}).textContent || '';
      const wb = f.pct != null ? '📈 ' + PRO._figPct(f.pct) : '', wr = f.rate != null ? '🎲 ' + PRO._figRate(f.rate) : '';
      return b === wb && r === wr ? null : `${d.dataset.colk} [${b}|${r}] vs [${wb}|${wr}]`;
    }).filter(Boolean);
    out.pctN = all.filter(x => x.col.fig && x.col.fig.pct != null).length;
    out.rateN = all.filter(x => x.col.fig && x.col.fig.rate != null).length;
    const e2 = (PRO.LAB.ok || []).find(x => x.k === 'two-a-day');
    const k5 = e2.pl[5], f0 = e2.col.fig ? { ...e2.col.fig } : null;
    if (!f0) e2.col.fig = {};
    const art2 = () => { PRO.renderCol(); const d = document.querySelector('[data-colk="two-a-day"]'); d.open = true; return { b: (d.querySelector('[data-colbadge]') || {}).textContent || '', m: (d.querySelector('[data-figmoney]') || {}).textContent || '', line: (d.querySelector('[data-figpct]') || {}).textContent || '' }; };
    out.base = art2();
    e2.pl[5] = '開低 2% 以上 2.4 萬次'; out.textOnly = art2(); e2.pl[5] = k5;
    e2.col.fig.pct = -0.35; out.small = art2();
    e2.col.fig.pct = 520; out.big = art2();
    e2.col.fig.pct = 7.77; out.mid = art2();
    e2.col.fig = f0;
    // ㉒ 排序
    const order = () => [...document.querySelectorAll('#colList details.colart')].map(d => d.dataset.colk);
    const figOf = k => (all.find(y => y.k === k) || {}).col.fig || {};
    const sortCase = (key, val) => {
      PRO._colSort = 'u'; PRO._colDir = -1; PRO.colSortBy(key); const a = order(), onA = (document.querySelector('#colSort .colsortb.on') || {}).dataset;
      PRO.colSortBy(key); const b = order();
      const vA = a.map(val), vB = b.map(val);
      const tail = v => { const i = v.findIndex(z => z == null); return i < 0 || v.slice(i).every(z => z == null); };
      const mono = (v, dir) => v.filter(z => z != null).every((z, i, arr) => i === 0 || (dir < 0 ? arr[i - 1] >= z : arr[i - 1] <= z));
      return { on: onA && onA.colsort === key, descOk: mono(vA, -1) && tail(vA), ascOk: mono(vB, 1) && tail(vB), flipped: JSON.stringify(a) !== JSON.stringify(b), n: a.length };
    };
    out.sPct = sortCase('pct', k => figOf(k).pct == null ? null : Math.abs(figOf(k).pct));
    out.sRate = sortCase('rate', k => figOf(k).rate == null ? null : figOf(k).rate);
    PRO._colSort = 'u'; PRO._colDir = -1; PRO.colSortBy('r'); const ro = order();
    out.rOkFirst = ro.findIndex(k => all.find(y => y.k === k).c === 'trap') > ro.findIndex(k => all.find(y => y.k === k).c === 'ok')
      && ro.slice(ro.findIndex(k => all.find(y => y.k === k).c === 'trap')).every(k => all.find(y => y.k === k).c === 'trap');
    PRO._colSort = 'u'; PRO._colDir = -1; PRO.colSortBy('star');
    out.starHd = [...document.querySelectorAll('#colList [data-colstar]')].map(e => e.dataset.colstar);
    out.starWant = PRO._starRank(PRO._colItems()).map(x => x.k);
    out.starAll = order().length;
    PRO.colSortBy('star'); out.starRev = [...document.querySelectorAll('#colList [data-colstar]')].map(e => e.dataset.colstar);
    PRO._colSort = 'u'; PRO._colDir = -1; PRO.renderCol();
    out.uDefault = JSON.stringify(order()) === JSON.stringify(PRO._colItems().map(x => x.k));
    out.pickDefault = !!document.querySelector('[data-colk="pick"]');
    PRO.colSortBy('u'); out.pickRev = !!document.querySelector('[data-colk="pick"]'); out.uRev = JSON.stringify(order()) === JSON.stringify(PRO._colItems().map(x => x.k).reverse());
    PRO._colSort = 'u'; PRO._colDir = -1; PRO.renderCol();
    // ⑫ 閱讀時間
    const kh = e2.col.how; PRO.renderCol();
    const m1 = (document.querySelector('[data-colk="two-a-day"] [data-colmins]') || {}).textContent || '';
    e2.col.how = kh + '多'.repeat(2000); PRO.renderCol();
    const m2 = (document.querySelector('[data-colk="two-a-day"] [data-colmins]') || {}).textContent || '';
    e2.col.how = kh; out.mins = [m1, m2];
    // ⑬ 分類篇數
    PRO.renderCol();
    out.pillBad = [...document.querySelectorAll('#colBar [data-colser]')].filter(b => b.dataset.colser).map(b => {
      const n = +((b.querySelector('[data-colcnt]') || {}).textContent || -1);
      PRO._colS = b.dataset.colser; PRO.renderCol();
      const real = document.querySelectorAll('#colList details.colart').length; PRO._colS = '';
      return n === real ? null : `${b.dataset.colser} ${n}≠${real}`;
    }).filter(Boolean);
    PRO._colS = ''; PRO.renderCol();
    out.serGene = [...document.querySelectorAll('#colBar [data-colser]')].map(b => b.dataset.colser);
    // ⑭ NEW
    const newest = PRO._colItems().reduce((m, x) => { const d = String(x.col.u || x.u || ''); return d > m ? d : m; }, '');
    out.newBad = [...document.querySelectorAll('#colList details.colart')].filter(d => d.querySelector('[data-colnew]') && !d.querySelector('.colmeta').textContent.includes(newest)).length;
    out.newN = document.querySelectorAll('#colList [data-colnew]').length;
    out.allText = document.getElementById('tabCol').innerText;
    // ⑯ 👑 模式
    localStorage.setItem('proTerminalSettings', JSON.stringify({ strategy: 'lead', stratUnlock: 1 }));
    PRO.renderCol(); document.querySelectorAll('#colList details').forEach(d => d.open = true);
    out.leadText = document.getElementById('colList').innerText;
    out.serLead = [...document.querySelectorAll('#colBar [data-colser]')].map(b => b.dataset.colser);
    out.leadN = document.querySelectorAll('#colList details.colart').length;
    localStorage.removeItem('proTerminalSettings'); PRO.renderCol();
    window.scrollTo(80, 0); out.scrollX = window.scrollX;
    return out;
});

ok('① 至少 60 篇有 col(✅ 有用全部 + 迷思前 10)', R.items.length >= 60, R.items.length);
const bad1 = R.items.filter(x => x.has.length < 5);
ok('① 每一篇都有 q / do / warn / how / s', !bad1.length, JSON.stringify(bad1));
const AIW = /(?<![A-Za-z])pp\b|六關|\bp\s*=|\bn\s*=|安慰劑|樣本外|探針|\.mjs|\.py\b|_probe|sham|CACHE|\bWARMUP\b/i;
ok('② ⛔ 只有 AI 看得懂的字(專欄畫面)', !AIW.test(R.text), (R.text.match(AIW) || [])[0]);
ok('③ 決定性對照:改條目 pl[5] → 專欄數字跟著變', /決定性對照數字 777/.test(R.t3 || ''), (R.t3 || '').slice(0, 80));
ok('④ 🔁 u ≥ 2026-10-03 的 ✅ 條目都要有專欄', !R.newOkNoCol.length, JSON.stringify(R.newOkNoCol));
ok('⑤ 🧬 模式(沒解鎖)也看得到 👑 專欄(V79.1.8 實測總表永遠有 👑)', R.geneHasLead);
ok('⑥b 那一行⛔ 算一篇專欄(「全部」篇數 == 實際篇數)', R.pickNotArt && R.allCnt === R.n, `${R.pickNotArt} ${R.allCnt} vs ${R.n}`);
// 💰 V79.8.0 「100 萬放進去,哪一套最後變最多?」看板只留「🏆 選哪一套」那一份 → 專欄只留一行連過去(⛔ 再抄金額)
ok('⑥ 第一篇改成一行連到「選哪一套」(⛔ 再抄一份金額:改看板 → 這一行⛔ 跟著出現數字)', /哪一套最後變最多/.test(R.pick) && /選哪一套/.test(R.pick) && !/萬/.test(R.pick.replace('100 萬', '')) && !/1,234 萬/.test(R.pick2) && R.pickIsLink, `${R.pick.slice(0, 120)} | link=${R.pickIsLink}`);
ok('⑦ 搜尋「跌停」只剩跌停那幾篇、第一篇收起', R.qN >= 2 && R.qN < R.items.length && !R.qPick, `qN=${R.qN}`);
ok('⑦b 系列「破解迷思」只剩那一系列', R.sN.length >= 5 && R.sN.every(s => s === '破解迷思'), JSON.stringify(R.sN));
const badMyth = R.items.filter(x => x.c === 'trap' && (!x.pl) && x.myth.length < 3);
ok('⑧ 破解迷思(沒有 pl)要自帶 a / num / mean', !badMyth.length, JSON.stringify(badMyth));
ok('⑩ 每一篇都有 📏 資料範圍', !R.noRange.length, JSON.stringify(R.noRange));
ok('⑲ 每一篇都有 fig(結果 % + 說明 / 發生率 + 說明 / 都沒有就寫原因)', !R.figBad.length && R.items.length > 0, JSON.stringify(R.figBad.slice(0, 5)));
ok('⑲b 大部分有結果 %、不少有發生率(⛔ 只是空殼)', R.pctN >= 90 && R.rateN >= 40, `pct ${R.pctN} rate ${R.rateN}`);
ok('⑳ 每一篇的封面章 == fig(📈 百分比 / 🎲 發生率)', !R.badgeBad.length, JSON.stringify(R.badgeBad.slice(0, 5)));
ok('⑳b 決定性對照:「數字說話」改成「開低 2% 以上 2.4 萬次」→ 封面章⛔ 跟著變(不再從文字抓條件 / 次數)', R.textOnly.b === R.base.b && /^📈 [+−]/.test(R.base.b), JSON.stringify([R.base.b, R.textOnly.b]));
ok('㉑ 金額只由 pct 換算:−0.35% → −3,500 元、+520% → +520 萬、+7.77% → +7.8 萬(封面章同步)', R.small.m === '−3,500 元' && R.small.b === '📈 −0.35%' && R.big.m === '+520 萬' && R.big.b === '📈 +520%' && R.mid.m === '+7.8 萬' && /每放 100 萬/.test(R.mid.line), JSON.stringify([R.small, R.big, R.mid]));
ok('㉒ 📈 影響大小:由大到小、再按一次反向、沒有數字的都在最後', R.sPct.on && R.sPct.descOk && R.sPct.ascOk && R.sPct.flipped, JSON.stringify(R.sPct));
ok('㉒b 🎲 發生率:由大到小、再按一次反向、沒有發生率的都在最後', R.sRate.on && R.sRate.descOk && R.sRate.ascOk && R.sRate.flipped, JSON.stringify(R.sRate));
ok('㉒c 🏆 名次:有用的在前、破解迷思在後', R.rOkFirst);
ok('㉒d ⭐ 可信度 == _starRank、再按一次整排反過來、沒星的也還在(在最後)', R.starHd.length > 10 && JSON.stringify(R.starHd) === JSON.stringify(R.starWant) && JSON.stringify(R.starRev) === JSON.stringify(R.starWant.slice().reverse()) && R.starAll === R.n, JSON.stringify([R.starHd.length, R.starAll, R.n]));
ok('㉒e 🆕 預設 = 新 → 舊、「選哪一套」那一行只在預設排序出現、反向 = 整排倒過來', R.uDefault && R.pickDefault && !R.pickRev && R.uRev);
ok('⑫ 閱讀時間跟著字數變', R.mins[0] && R.mins[0] !== R.mins[1], JSON.stringify(R.mins));
ok('⑬ 分類篇數 == 實際篇數', !R.pillBad.length, JSON.stringify(R.pillBad));
ok('⑭ NEW 只標最新那一天(而且有標)', R.newN > 0 && R.newBad === 0, `${R.newN} / bad ${R.newBad}`);
ok('⑮ ⛔ 沒有瀏覽 / 按讚 / 留言數', !/瀏覽|按讚|留言|👁|❤️/.test(R.allText), (R.allText.match(/瀏覽|按讚|留言|👁|❤️/) || [])[0]);
ok('⑯ 🧬(沒解鎖)與 👑 模式都有 👑 領頭羊分類、篇數一樣(V79.1.8)', R.serGene.includes('👑 領頭羊') && R.serLead.includes('👑 領頭羊') && R.leadN === R.n, `${R.serLead.join(',')} n=${R.leadN}/${R.n}`);
ok('⑯b 👑 模式也⛔ AI 才懂的字', !AIW.test(R.leadText), (R.leadText.match(AIW) || [])[0]);
ok('⑨ 390px 不橫捲 + 無 pageerror', R.scrollX <= 2 && !errs.length, `scrollX=${R.scrollX} ${errs.join(' | ')}`);
// ⑰⑱ 觸發式專欄(V78.4.2)
{
    const { buildColTrig } = await import('./embed_col_trig.mjs');
    const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const b = buildColTrig(SRC, IDX);
    ok('⑰ 每一篇專欄都寫了觸發條件(或「沒有」+ 為什麼),條件都在 _COL_TRIG_IDS', !b.errs.length && b.obj.cols.length + b.none.length === R.items.length, b.errs.join(' / ') || `${b.obj.cols.length}+${b.none.length} vs ${R.items.length}`);
    const cur = (IDX.match(/^    _COL_TRIG: (\{.*\}),$/m) || [])[1];
    ok('⑱ 散戶 App 的 _COL_TRIG 抄本 == pro.html 專欄(跑 embed_col_trig.mjs)', cur === JSON.stringify(b.obj), cur ? 'index 跟 pro 不一致' : 'index 找不到 _COL_TRIG');
}
await browser.close();
try { fs.unlinkSync(TMP); } catch (_) {}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
