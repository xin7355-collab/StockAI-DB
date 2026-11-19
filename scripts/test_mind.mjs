#!/usr/bin/env node
// 🧠 V82.5.5 產業作戰室「🧠 人性」頁 + 🏠 今天那一格(使用者 11/18:App 太理性 —— 貪婪與恐懼、大戶外資的角度、匯率風向)
//   ⛔ 這支釘的用意:
//     ① mood_build --selftest 全過(心理狀態 == psych_state_probe、排第幾、單位對不上 → miss、累積檔)
//     ② 三段都畫得出來;排序同一顆再點一次反向;每一條都有資料日與歷史起訖;停在舊日期的要標 ⚠️
//     ③ ⛔ 合成總分 / 情緒指數、⛔ 用 🔴🟢 講好壞;位置的尺是灰階
//     ④ 讀不到 ≠ 沒有(檔案不在要明講);🏠 那一句 == 頁頂那一句,⭐ 決定性對照:換假資料的狀態 → 兩邊一起變
//     ⑤ 🏠 / 頁面只轉述 data/mood.json,⛔ 自己排序、⛔ 另寫結論(結論讀 _labByK)
//     ⑥ 390 / 844 不橫捲、無 pageerror;導覽:🏭 產業最後一顆是 🧠 人性、按鈕右緣都在畫面內
//   INJECT=score|color|homecalc|tie → 把對應的壞寫法塞回 pro.html 的複本,必須紅
//     ⑦ 同分:很多天一樣(跌停 0 家)→ 寫「最低(跟 N% 的日子一樣)」,⛔ 寫成「比 N% 的日子高」
//     ⑨ V82.5.7 外資 5 日 / 20 日合計是買賣超 → 跟「今天」那條一樣台股紅買綠賣(方向);今年累計是事實列(⛔ 排第幾、⛔ 尺)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ① 資料腳本自己的測試
let st = '';
try { st = execFileSync(process.execPath, [path.join(ROOT, 'scripts/mood_build.mjs'), '--selftest'], { encoding: 'utf8' }); } catch (e) { st = String(e.stdout || '') + String(e.stderr || ''); }
ok('① mood_build --selftest 全過', /✅ 全部通過/.test(st) && !/❌/.test(st), st.split('\n').filter(l => l.startsWith('❌')).join(' | '));

// 被測的 pro.html(INJECT 時用改壞的複本)
const INJ = process.env.INJECT || '';
let PRO_FILE = path.join(ROOT, 'pro.html');
if (INJ) {
    let s = fs.readFileSync(PRO_FILE, 'utf8');
    const before = s;
    if (INJ === 'score') s = s.replace("return parts.length ? parts.join(' ・ ') : null;", "parts.push(`情緒總分 ${Math.round((j.crowd || []).reduce((a, g) => a + (g.pct || 0), 0) / Math.max(1, (j.crowd || []).length))}`); return parts.length ? parts.join(' ・ ') : null;");
    if (INJ === 'color') s = s.replace('<i style="left:${Math.max(0, Math.min(100, +p))}%"></i>', '<i style="left:${Math.max(0, Math.min(100, +p))}%;background:${p > 50 ? \'#ff5d5d\' : \'#3ddc84\'}"></i>🔴');
    if (INJ === 'homecalc') s = s.replace("const j = await this._mindLoad(), L = this._mindLine(j);", "const j = await this._mindLoad(), L = j && j.state ? `大盤心理狀態 <b>${j.state.zh}</b>` : null;");
    if (INJ === 'tie') s = s.replace('if (g.lo != null && g.hi != null) {   /* mind-tie */', 'if (false) {');
    if (s === before) { console.error(`🚨 INJECT=${INJ} 沒有改到任何東西(注入點對不上)`); process.exit(2); }
    PRO_FILE = path.join(ROOT, `pro_inject_${process.pid}.html`);
    fs.writeFileSync(PRO_FILE, s);
}

// 假資料:兩份(狀態不同)
const g = (k, name, v, unit, d, pct, n, from, to, lab, extra = {}) => ({ k, name, side: 'fear', v, unit, d, pct, n, from, to, lab, ...extra });
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const mk = (stk, zh) => ({
    v: 1, updated: today + ' 20:00 +0800', asof: today, minN: 20, src: 'test',
    state: { k: stk, zh, d: today, since: '2026-11-09', days: 9, D: -22.9, V: 98.4, M: 0.9, vol: 45.2, last250: { PANIC: 63, NEUTRAL: 151, GREED: 30 },
        rules: { panicV: 90, panicD: -10, panicOutV: 75, worryD: -10, backD: -5, greedM: 90, greedD: -3, greedV: 50, greedOutM: 60 }, names: { PANIC: '恐慌', REPAIR: '修復', WORRY: '擔憂', NEUTRAL: '中性', GREED: '貪婪' }, lab: 'psych-state' },
    crowd: [
        g('ld', '跌停家數', 473, '家', today, 100, 250, '2025-11-14', today, 'crash-warn', { hiw: '怕' }),
        g('lu', '漲停家數', 7, '家', today, 3.2, 250, '2025-11-14', today, 'leader-breadth4', { hiw: '貪' }),
        g('mg20', '融資餘額 20 日變化', -23.59, '%', today, 1.15, 5588, '2004-02-09', '2026-10-19', 'margin-call-bounce', { hiw: '貪(加槓桿)', low: '怕(斷頭、降槓桿)' }),
        g('pcr', '選擇權賣權 ÷ 買權(未平倉)', 61.6, '%', '2026-10-19', 0.68, 4115, '2010-01-04', '2026-10-19', 'pcr-largetrader', { stale: true }),
        g('conc', '成交集中在前 10 檔', 35.1, '%', today, null, 1, null, null, null),
    ],
    seats: { fi: [g('fis', '外資現貨買賣超(今天)', -243.12, '億', today, 20.24, 751, '2023-09-14', '2026-10-19', 'fi-outflow'), { k: 'fim', name: '外資本月累計', v: -8303.2, unit: '億', d: today, lab: 'fi-follow', note: '月報' },
        g('fi5', '外資現貨 5 日合計', -1233.4, '億', today, 4.5, 751, '2023-09-12', '2026-11-18', 'fi-outflow', { side: 'both', hiw: '買超大', low: '賣超大', note: '這 5 筆官方每日值加總(上市)' }),
        { k: 'fiy', name: '外資現貨今年累計(2026)', v: -6780.2, unit: '億', d: today, lab: 'fi-follow', note: '214 個交易日的官方每日值加總(上市);今年到現在跟整年不能比 → 不排第幾' },
        { k: 'usdtw', name: '這一波:用台幣算 vs 用美元算', v: -26.5, unit: '%', d: today, lab: null, note: '離近一年高點:用台幣算 −22.87%(高點 2026-10-06)、用美元算 −26.5%(高點 2026-10-06);同一段台幣貶 4.9%' }],
        trust: [], retail: [{ ref: 'mg20' }], insider: [{ k: 'ins', name: '董監 / 大股東申報在市場上賣', v: 9, unit: '家', d: today, lab: 'insider-sell', list: ['某公司 1234'], note: '近 5 個交易日' }],
        gov: [{ k: 'nsf', name: '國安基金', v: null, d: '2026-11-06', lab: 'nsf-entry', note: '還在執行' }] },
    fx: [{ k: 'usdtwd', name: '美元 / 台幣', v: 33, c1: 0.27, c5: 0.42, c20: 1.23, pos: { pct: 80.5, lo: 80, hi: 19, n: 250, from: '2025-11-20', to: '2026-11-19' }, hs: 'FRED DEXTAUS(到 2026-11-14)', d: today, note: '' },
        { k: 'dxy', name: '美元指數', v: 103.82, c1: -0.03, c5: null, c20: null, pos: { pct: null, n: 6, from: '2026-11-13', to: today }, hs: 'App 自己每天存的(5 天)', d: today },
        { k: 'gold_usd', name: '黃金', v: 3691.6, c1: null, c5: null, c20: null, pos: null, hwhy: '還沒有歷史(App 從 11/20 開始每天存)', d: null, upd: today + ' 01:43 +0800' }],
    wind: [{ k: 'upr', name: '上漲家數比例', v: 6.8, unit: '%', d: today, note: '漲 152・跌 2084', lab: null }],
    miss: [{ k: 'credit', name: '美國信用利差', why: '⏳ 第 6 期(FRED)' }],
});
const A = mk('PANIC', '恐慌'), B = mk('GREED', '貪婪');

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
try {
    for (const [W, H] of [[390, 844], [844, 390]]) {
        const page = await browser.newPage({ viewport: { width: W, height: H } });
        const errs = []; page.on('pageerror', e => errs.push(e.message));
        await page.goto('file://' + PRO_FILE, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof PRO !== 'undefined' && PRO._tab, null, { timeout: 30000 });
        await page.waitForTimeout(1500);
        const R = await page.evaluate(async ([A, B]) => {
            const o = {}, T = id => (document.getElementById(id) || {}).innerText || '';
            const sx = () => { window.scrollTo(80, 0); const x = window.scrollX; window.scrollTo(0, 0); return x; };
            // 導覽
            o.nav = PRO.NAV.find(x => x[0] === 'ind')[2];
            PRO.navGo('mind'); await new Promise(r => setTimeout(r, 50));
            o.vw = document.documentElement.clientWidth;
            o.topRight = Math.max(...[...document.querySelectorAll('#navTop [data-g]')].map(b => b.getBoundingClientRect().right));
            const sub = document.getElementById('navSub');
            o.subFits = sub.scrollWidth <= sub.clientWidth + 1; o.subScroll = ['auto', 'scroll'].includes(getComputedStyle(sub).overflowX);
            o.mindBtnOn = !!document.querySelector('#tabBtnMind.on');
            // ④ 讀不到
            PRO._cache['data/mood.json'] = null; await PRO.renderMind();
            o.nofile = T('tabMind'); o.nofileTag = !!document.querySelector('[data-mind="nofile"]');
            await PRO._homeMind(); o.homeNo = T('homeMind');
            // ② 三段
            PRO._cache['data/mood.json'] = A; PRO._mindSeg = 'crowd'; PRO._mindSort = null; await PRO.renderMind();
            o.headLine = (document.querySelector('[data-mind-line]') || {}).innerHTML || '';
            o.crowdTxt = T('tabMind');
            o.rows = [...document.querySelectorAll('[data-mind-list="crowd"] [data-mind-row]')].map(e => e.dataset.mindRow);
            o.dates = [...document.querySelectorAll('[data-mind-list="crowd"] .mind-d')].map(e => e.innerText);
            o.staleN = document.querySelectorAll('[data-mind-list="crowd"] [data-mind-stale]').length;
            o.bars = [...document.querySelectorAll('[data-mind-list="crowd"] [data-mind-bar]')].map(e => getComputedStyle(e).backgroundImage + '|' + getComputedStyle(e.querySelector('i')).backgroundColor);
            document.querySelectorAll('details.mind-row').forEach(d => d.open = true);
            o.openTxt = T('tabMind');
            o.labLines = [...document.querySelectorAll('[data-mind-lab]')].map(e => e.dataset.mindLab);
            o.sx390crowd = sx();
            PRO.mindSortBy('pct'); await new Promise(r => setTimeout(r, 30));
            o.rowsAsc = [...document.querySelectorAll('[data-mind-list="crowd"] [data-mind-row]')].map(e => e.dataset.mindRow);
            o.sortLbl = (document.querySelector('[data-mind-sort="pct"]') || {}).innerText || '';
            PRO.mindSortBy('name'); await new Promise(r => setTimeout(r, 30));
            o.rowsName = [...document.querySelectorAll('[data-mind-list="crowd"] [data-mind-row]')].map(e => e.dataset.mindRow);
            PRO.mindSel('seat'); await new Promise(r => setTimeout(r, 30));
            o.seatTxt = T('tabMind'); o.seats = [...document.querySelectorAll('[data-mind-seat]')].map(e => e.dataset.mindSeat); o.sxSeat = sx();
            o.seatRetail = [...document.querySelectorAll('[data-mind-seat="retail"] [data-mind-row]')].map(e => e.dataset.mindRow);
            const vCol = k => { const e = document.querySelector(`[data-mind-seat="fi"] [data-mind-row="${k}"] .mind-v`); return e ? getComputedStyle(e).color : ''; };
            o.fi5Col = vCol('fi5'); o.fisCol = vCol('fis'); o.fimCol = vCol('fim');
            o.fiyFact = !!document.querySelector('[data-mind-seat="fi"] .mind-fact[data-mind-row="fiy"]') && !document.querySelector('[data-mind-seat="fi"] [data-mind-row="fiy"] [data-mind-bar]');
            o.fi5Bar = !!document.querySelector('[data-mind-seat="fi"] [data-mind-row="fi5"] [data-mind-bar]');
            PRO.mindSel('fx'); await new Promise(r => setTimeout(r, 30));
            o.fxTxt = T('tabMind'); o.fxRows = [...document.querySelectorAll('[data-mind-list="fx"] [data-mind-fx]')].map(e => e.dataset.mindFx); o.sxFx = sx();
            o.fxPos = (document.querySelector('[data-mind-fx="usdtwd"] [data-mind-pos]') || {}).innerText || '';
            o.fxDxyPos = (document.querySelector('[data-mind-fx="dxy"] [data-mind-pos]') || {}).innerText || '';
            o.fxUsd = (document.querySelector('[data-mind-fx="usdtwd"]') || {}).innerText || '';
            o.fxGold = (document.querySelector('[data-mind-fx="gold_usd"]') || {}).innerText || '';
            o.fxBars = [...document.querySelectorAll('[data-mind-list="fx"] [data-mind-bar]')].map(e => getComputedStyle(e).backgroundImage + '|' + getComputedStyle(e.querySelector('i')).backgroundColor);
            PRO.mindFxSortBy('pos'); await new Promise(r => setTimeout(r, 30));
            o.fxPosOrd = [...document.querySelectorAll('[data-mind-list="fx"] [data-mind-fx]')].map(e => e.dataset.mindFx);
            PRO._mindFxSort = null;
            PRO.mindFxSortBy('c1'); await new Promise(r => setTimeout(r, 30));
            o.fxC1 = [...document.querySelectorAll('[data-mind-list="fx"] [data-mind-fx]')].map(e => e.dataset.mindFx);
            PRO.mindFxSortBy('c1'); await new Promise(r => setTimeout(r, 30));
            o.fxC1b = [...document.querySelectorAll('[data-mind-list="fx"] [data-mind-fx]')].map(e => e.dataset.mindFx);
            // ④ 🏠 == 頁頂;決定性對照:換狀態兩邊一起變
            await PRO._homeMind(); o.homeA = (document.querySelector('[data-home-mind="line"]') || {}).innerHTML || '';
            PRO._cache['data/mood.json'] = B; PRO._mindSeg = 'crowd'; await PRO.renderMind(); await PRO._homeMind();
            o.headB = (document.querySelector('[data-mind-line]') || {}).innerHTML || ''; o.homeB = (document.querySelector('[data-home-mind="line"]') || {}).innerHTML || '';
            // ⑤ 原始碼:🏠 只轉述 _mindLine;頁面 / 🏠 ⛔ 自己排序 crowd、⛔ 寫死結論
            o.srcHome = String(PRO._homeMind); o.srcLine = String(PRO._mindLine); o.srcLab = String(PRO._mindLabHtml);
            // ⑦ 同分:15 天 0 家 + 5 天 1 家,今天 0 家(mood_build.rankPct 算的:pct 38.1、lo 0、hi 23.81)
            const yr = { from: '2025-11-20', to: '2026-11-19', n: 21 };
            o.tieLow = PRO._mindPctTxt({ ...yr, pct: 38.1, lo: 0, hi: 23.81 });
            o.tieMid = PRO._mindPctTxt({ ...yr, n: 250, pct: 55, lo: 40, hi: 30 });
            o.noTie = PRO._mindPctTxt({ ...yr, n: 250, pct: 80.2, lo: 80, hi: 19.6 });
            o.oldFmt = PRO._mindPctTxt({ ...yr, n: 250, pct: 80 });
            return o;
        }, [A, B]);
        const tag = `${W}×${H}`;
        ok(`⑥ ${tag} 無 pageerror`, !errs.length, errs.join(' | '));
        ok(`⑥ ${tag} 不橫捲(三段都量)`, R.sx390crowd <= 2 && R.sxSeat <= 2 && R.sxFx <= 2, JSON.stringify([R.sx390crowd, R.sxSeat, R.sxFx]));
        if (W !== 390) { await page.close(); continue; }
        ok('⑥ 🏭 產業最後一顆是 🧠 人性、按了亮起來', R.nav.at(-1) === 'mind' && R.mindBtnOn, JSON.stringify([R.nav, R.mindBtnOn]));
        ok('⑥ 上面五個大類按鈕右緣都在畫面內(⛔ 加第六個大類)', R.topRight <= R.vw + 1, `${R.topRight} > ${R.vw}`);
        ok('⑥ 產業那一排(多了 🧠 人性)放得下,或可以橫滑', R.subFits || R.subScroll, JSON.stringify([R.subFits, R.subScroll]));
        ok('④ 讀不到 data/mood.json → 明講讀不到、⛔ 長得像「今天沒有」', R.nofileTag && /讀不到 data\/mood\.json/.test(R.nofile) && /不代表/.test(R.nofile) && /讀不到/.test(R.homeNo), R.nofile.slice(0, 120));
        ok('② 群眾那一段五條都畫出來(預設照在歷史的位置由高到低,⏳ 排不出來的排最後)', JSON.stringify(R.rows) === '["ld","lu","mg20","pcr","conc"]', JSON.stringify(R.rows));
        ok('② 同一顆再點一次反向(由低到高,⏳ 照樣排最後)', JSON.stringify(R.rowsAsc) === '["pcr","mg20","lu","ld","conc"]' && /▲/.test(R.sortLbl), JSON.stringify([R.rowsAsc, R.sortLbl]));
        ok('② 換照名稱排 → 順序跟著變', JSON.stringify(R.rowsName) !== JSON.stringify(R.rows) && R.rowsName.length === 5, JSON.stringify(R.rowsName));
        ok('② 每一條都有資料日;停在 10/19 的那條標 ⚠️(只有那一條)', R.dates.length === 5 && R.dates.every(x => /\d\d\/\d\d/.test(x)) && R.staleN === 1, JSON.stringify([R.dates, R.staleN]));
        ok('② 點開看得到歷史起訖與「高 = 怕 / 貪」', /📏 歷史 2004-02-09 ~ 2026-10-19/.test(R.openTxt) && /高 = 怕/.test(R.openTxt) && /低 = 怕\(斷頭/.test(R.openTxt), R.openTxt.slice(0, 200));
        ok('⑤ 結論只轉述實測總表(_labByK);沒測過的寫「還沒測過」', R.labLines.includes('psych-state') && R.labLines.includes('crash-warn') && R.labLines.includes('none') && /_labByK\(/.test(R.srcLab), JSON.stringify(R.labLines));
        ok('③ ⛔ 合成總分 / 情緒指數(畫面三段 + 🏠)', !/總分|情緒指數|綜合分數|恐慌指數 \d/.test(R.crowdTxt + R.seatTxt + R.fxTxt + R.homeA), (R.crowdTxt + R.homeA).match(/總分|情緒指數|綜合分數/)?.[0]);
        ok('③ ⛔ 用 🔴🟢 講好壞;位置的尺是灰階(⛔ 紅 / 綠)', !/[🔴🟢]/u.test(R.crowdTxt + R.seatTxt + R.fxTxt) && R.bars.length >= 4 && R.bars.every(b => !/255, 93, 93|61, 220, 132/.test(b)), JSON.stringify(R.bars.slice(0, 2)));
        ok('② 外資與大戶:五個座位 + 風向;散戶那一格轉述群眾的融資那一條', JSON.stringify(R.seats) === '["fi","trust","retail","insider","gov"]' && JSON.stringify(R.seatRetail) === '["mg20"]', JSON.stringify([R.seats, R.seatRetail]));
        ok('② 座位寫出限制;本月累計 ⛔ 寫成「還在累積」', /他的限制/.test(R.seatTxt) && !/外資本月累計[\s\S]{0,40}還在累積/.test(R.seatTxt), R.seatTxt.slice(0, 160));
        ok('② 匯率:三列、沒有自己日期的只寫「檔案」更新時間;20 日 / 一年位置寫 ⏳', JSON.stringify(R.fxRows) === '["usdtwd","dxy","gold_usd"]' && /檔案 \d\d-\d\d/.test(R.fxTxt) && /20 日 ⏳/.test(R.fxTxt) && /一年位置 ⏳/.test(R.fxTxt), R.fxTxt.slice(0, 200));
        ok('⑧ 匯率 20 日 / 一年位置:照 mood.json 印(+1.23%、比近一年 80% 的日子高)、寫出歷史來源、一年位置的尺是灰階', /20 日 \+1\.23%/.test(R.fxUsd) && R.fxPos === '一年位置 比近一年 80% 的日子高'
            && /歷史:FRED DEXTAUS/.test(R.fxUsd) && R.fxBars.length === 1 && !/255, 93, 93|61, 220, 132/.test(R.fxBars[0]), JSON.stringify([R.fxPos, R.fxUsd.slice(0, 160), R.fxBars]));
        ok('⑧ 還在累積寫天數;沒有歷史寫原因(⛔ 空白)', /還在累積\(6 天\)/.test(R.fxDxyPos) && /還沒有歷史/.test(R.fxGold), JSON.stringify([R.fxDxyPos, R.fxGold.slice(0, 160)]));
        ok('⑧ 照一年位置排:有位置的在前、排不出來的排最後', R.fxPosOrd[0] === 'usdtwd' && R.fxPosOrd.length === 3, JSON.stringify(R.fxPosOrd));
        ok('⑨ 外資 5 日合計:有尺(排第幾)、賣超 → 跟「今天」那條同一個方向色(台股綠 = 賣)', R.fi5Bar && R.fi5Col && R.fi5Col === R.fisCol && R.fi5Col !== R.fimCol, JSON.stringify([R.fi5Col, R.fisCol, R.fimCol]));
        ok('⑨ 外資今年累計是事實列(⛔ 尺、⛔ 排第幾)', R.fiyFact && /外資現貨今年累計\(2026\)/.test(R.seatTxt) && /不排第幾/.test(R.seatTxt), R.fiyFact);
        ok('⑧ 外資座位有「用台幣算 vs 用美元算」那一行', /用台幣算 vs 用美元算/.test(R.seatTxt) && /用美元算 −26\.5%/.test(R.seatTxt), R.seatTxt.slice(0, 200));
        ok('② 匯率照 1 日排、再點一次反向(讀不到的排最後)', JSON.stringify(R.fxC1) === '["usdtwd","dxy","gold_usd"]' && JSON.stringify(R.fxC1b) === '["dxy","usdtwd","gold_usd"]', JSON.stringify([R.fxC1, R.fxC1b]));
        ok('⑦ 同分:今天 0 家而且很多天也是 0 → 「近一年最低(跟 76% 的日子一樣)」,⛔「比 76% 的日子高」', R.tieLow === '近一年最低(跟 76% 的日子一樣)' && !/的日子高/.test(R.tieLow), R.tieLow);
        ok('⑦ 中間有同分 → 只講真的比較低的比例 + 跟幾 % 一樣', R.tieMid === '比近一年 40% 的日子高(跟 30% 的日子一樣)', R.tieMid);
        ok('⑦ 沒什麼同分 → 照舊一句、⛔ 多「一樣」那段', R.noTie === '比近一年 80% 的日子高', R.noTie);
        ok('⑦ 舊檔(沒有 lo / hi)→ 照 pct 講', R.oldFmt === '比近一年 80% 的日子高', R.oldFmt);
        ok('④ 🏠 那一句 == 頁頂那一句', R.homeA && R.homeA === R.headLine, JSON.stringify([R.homeA, R.headLine]));
        ok('④ 決定性對照:假資料換成貪婪 → 頁頂與 🏠 一起變、而且還是同一句', /貪婪/.test(R.headB) && R.homeB === R.headB && R.homeB !== R.homeA, JSON.stringify([R.headB, R.homeB]));
        ok('⑤ 🏠 只轉述 _mindLine;_mindLine 的排序只用來挑最極端兩條(⛔ 另讀別的檔)', /this\._mindLine\(/.test(R.srcHome) && !/fetchJson\(/.test(R.srcHome.replace(/_mindLoad/g, '')) && !/fetchJson|_PROFIT_BOARD|LAB\b/.test(R.srcLine), R.srcHome.slice(0, 200));
        await page.close();
    }
} finally {
    await browser.close();
    if (INJ) fs.rmSync(PRO_FILE, { force: true });
}
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
