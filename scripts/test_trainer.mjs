#!/usr/bin/env node
/**
 * 🎯 V77.3.8 盲測練習守門(`_trainNext` / `_trainDraw` / `_trainReveal` / `_trainStats` / `_trainLogPush`)
 *   ⓪ 空過守門:切得到 `_trainDraw` 且**無 hex 字面**(顏色一律讀 `_RP_STYLE`)
 *   ① 出題合法:200 次 `_trainNext`(stub RNG 掃 0→1)每次 cut ≥ WARM、後面 ≥ FUT 根、最後一根⛔ 不是今天
 *   ② 揭曉前 innerHTML ⛔ 不含股號 / 日期 / 未來任何一根的收盤價
 *   ③ 決定性:未來 20 根 OHLC ×3 之後,揭曉前 toDataURL **逐字相同**;揭曉後必須不同
 *   ④ 右側未來帶揭曉前非背景像素 = 0;揭曉後 > 200
 *   ⑤ 訊號只餵到 T:把未來改成漲停後 `_trainSigsAt` 結果完全不變;每筆都有 `_d`
 *   ⑥ 計分:合成每天 +1% 的股 + 加權每天 +0.5% → r10 = 10.46、x10 ≈ 5.35;對不到日期要印「沒有加權可比」
 *   ⑦ `#trainStats` 有印基準勝率(`_SIGNAL_EDGE_META.base_win`)
 *   ⑧ n<10 不下結論、n≥10 才有判語;門檻等於 `_wrEnough`(⛔ 不是寫死)
 *   ⑨ log 真的修剪:520 筆 → 恰 500 且是最後 500;⛔ 不可有 trainLog_* 散 key
 *   ⑩ 燈號鐵則:揭曉區與統計區 ⛔ 不含 🔴🟢;modal 不在任何 [data-ovpane] 裡
 *   ⑪ `_kbarTryFire` 與 `_trainSigsAt` 共用 `_KBAR_DET_LIST`(⛔ 不可各寫一份)
 * 注入(每條都要叫得出來):`_closedTail` 換成 d=>d → ①;y 軸改用整條 closed → ③;`_trainSigsAt` 吃整條 → ⑤;
 *   門檻寫死 n>=5 → ⑧;改成 `_lruTrim` → ⑨;trainMeta 印股號 → ②
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ── 靜態 ──
const fnDraw = CODE.slice(CODE.indexOf('_trainDraw(reveal) {'), CODE.indexOf('_trainAnswer(a) {'));
ok('⓪ 切得到 _trainDraw(空過守門)', fnDraw.length > 800 && fnDraw.length < 6000, String(fnDraw.length));
ok('⓪b _trainDraw ⛔ 無 hex 字面、顏色讀 _RP_STYLE', !/#[0-9a-f]{6}/i.test(fnDraw) && /_RP_STYLE/.test(fnDraw), '');
const fnSigs = CODE.slice(CODE.indexOf('_trainSigsAt(view) {'), CODE.indexOf('async _trainReveal() {'));
const fnFire = CODE.slice(CODE.indexOf('_kbarTryFire(sym, name, kdata, budget) {'), CODE.indexOf('_kbarTryFire(sym, name, kdata, budget) {') + 2500);
ok('⑪ _trainSigsAt 與 _kbarTryFire 都走 _KBAR_DET_LIST(⛔ 不各寫一份清單)', /this\._KBAR_DET_LIST/.test(fnSigs) && /this\._KBAR_DET_LIST/.test(fnFire) && !/_detectStarPatterns/.test(fnSigs), '');
const fnStats = CODE.slice(CODE.indexOf('_trainStats() {'), CODE.indexOf('_trainStats() {') + 3000);
ok('⑧s 門檻走 _wrEnough(⛔ 不可寫死 n>=10 / 也不可 `n >= _wrEnough()` 那種恆真)', /this\._wrEnough\(n\)/.test(fnStats) && !/_wrEnough\(\)/.test(fnStats) && !/n >= 10|n>=10|n >= 5/.test(fnStats), '');
const fnPush = CODE.slice(CODE.indexOf('_trainLogPush(row) {'), CODE.indexOf('_trainStats() {'));
ok('⑨s 修剪用 slice(-_TRAIN_KEEP) 單一 key(⛔ _lruTrim 對單一 key 是 no-op)', /slice\(-this\._TRAIN_KEEP\)/.test(fnPush) && !/_lruTrim/.test(fnPush), '');

const exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(Object.assign({ args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] }, fs.existsSync(exec) ? { executablePath: exec } : {}));
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => { const m = String(e.message || e); if (!/Request scheme 'file' is unsupported/.test(m)) errs.push(m); });   // 沙箱 file:// 的 Cache.put 例外不算
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._trainNext, null, { timeout: 25000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
    const A = app, out = {};
    const g = id => document.getElementById(id);
    // ── 合成 K 線:每天 +1%、有小影線,最後一根日期 = 今天(讓 _closedTail 有事做)
    const mk = (n, step, wick = 0.004) => {
        const d = []; let c = 100; const day = new Date(Date.UTC(2023, 0, 2));
        for (let i = 0; i < n; i++) {
            const o = c; c = c * (1 + step(i));
            while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
            d.push({ date: day.toISOString().slice(0, 10).replace(/-/g, '/'), open: o, high: Math.max(o, c) * (1 + wick), low: Math.min(o, c) * (1 - wick), close: c, volume: 5e6 });
            day.setUTCDate(day.getUTCDate() + 1);
        }
        return d;
    };
    const K = mk(400, () => 0.01);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).replace(/-/g, '/');
    K[K.length - 1].date = today;                       // 最後一根是「今天」→ 必須被 _closedTail 砍掉
    // 大盤:每天 +0.5%,日期跟 K 同一套
    const TW = K.map((b, i) => ({ date: b.date, close: 10000 * Math.pow(1.005, i) }));
    A._twiiKlineCache = { rows: TW, at: Date.now() };
    A._cbtUniverse = async () => ['9999'];
    A._loadKline = async () => K;
    A.getStockName = () => '合成股';
    try { localStorage.removeItem(A._TRAIN_KEY); } catch (_) {}
    A._openTrainer();
    // ── ① 出題合法(RNG 掃 0→1)
    let bad = 0, lastToday = 0, N = 200;
    for (let i = 0; i < N; i++) {
        const v = i / (N - 1);
        A._trainRnd = () => Math.min(v, 0.999999);
        await A._trainNext();
        const st = A._trainState;
        if (!st) { bad++; continue; }
        if (!(st.cut >= A._TRAIN_WARM) || !(st.closed.length - st.cut - 1 >= A._TRAIN_FUT)) bad++;
        if (String(st.closed[st.closed.length - 1].date) === today) lastToday++;
    }
    out.q = { bad, lastToday, N };
    // ── 固定一題:cut 在中段
    A._trainRnd = () => 0.5;
    await A._trainNext();
    const st = A._trainState;
    const C = b => +b.close;
    const futCloses = st.closed.slice(st.cut + 1, st.cut + 21).map(b => C(b).toFixed(2));
    const html0 = g('trainerBody').innerHTML;
    out.leak = { sym: html0.includes(st.sym), date: html0.includes(st.date), fut: futCloses.some(p => html0.includes(p)) };
    // ── ③④ 像素:未來 ×3 之後揭曉前要一模一樣
    const cv = g('trainCv');
    A._trainDraw(false); const png0 = cv.toDataURL();
    const ctx = cv.getContext('2d');
    const nonBg = () => { const W = cv.width, H = cv.height; const img = ctx.getImageData(Math.round(W * 0.74), 0, Math.round(W * 0.24), H).data; let n = 0; for (let i = 0; i < img.length; i += 4) { if (!(img[i] === 13 && img[i + 1] === 17 && img[i + 2] === 23)) n++; } return n; };
    out.futBefore = nonBg();
    const saved = st.closed.slice(st.cut + 1).map(b => ({ ...b }));
    for (let i = st.cut + 1; i < st.closed.length; i++) for (const f of ['open', 'high', 'low', 'close']) st.closed[i][f] *= 3;
    A._trainDraw(false); const png1 = cv.toDataURL();
    out.pixSame = png0 === png1;
    // ⑤ 訊號只餵到 T —— ⛔ 要走 _trainReveal 這條正式路徑量(直接叫 _trainSigsAt(slice) 的話,
    //    「_trainReveal 改吃整條」那個注入叫不出來,第一版就是這樣)。做法:同一題揭曉兩次,
    //    第二次先把未來 ×1.1,log 裡的 sg(那一根亮了什麼)必須一模一樣。
    const sAll = A._trainSigsAt(st.closed);
    for (let i = st.cut + 1; i < st.closed.length; i++) st.closed[i] = saved[i - st.cut - 1];   // 先還原 ×3
    const snap = JSON.parse(JSON.stringify(st));
    A._trainAnswer('skip'); await new Promise(r => setTimeout(r, 250));
    const sg0 = JSON.stringify((A._lsJson(A._TRAIN_KEY, []).slice(-1)[0] || {}).sg);
    A._trainState = JSON.parse(JSON.stringify(snap));
    // ⛔ 不可整段等比放大(偵測器是尺度不變的,×1.1 之後末端的形狀一模一樣 → 注入叫不出來,第二版就是這樣):
    //    把最後 3 根未來改成崩盤長黑,偵測器若真的讀到未來,末端會亮完全不同的訊號
    { const cl = A._trainState.closed; for (let i = cl.length - 3; i < cl.length; i++) { const c0 = +cl[i].close; cl[i].open = c0 * 1.3; cl[i].high = c0 * 1.36; cl[i].low = c0 * 0.7; cl[i].close = c0 * 0.75; } }
    A._trainAnswer('skip'); await new Promise(r => setTimeout(r, 250));
    const sg1 = JSON.stringify((A._lsJson(A._TRAIN_KEY, []).slice(-1)[0] || {}).sg);
    out.sig = { same: sg0 === sg1, hasD: sAll.every(x => x._d), nAll: sAll.length, n0: sg0.length };
    localStorage.setItem(A._TRAIN_KEY, '[]');
    A._trainState = JSON.parse(JSON.stringify(snap)); st.revealed = false;
    // 把 st 指回新的 state(後面的 ⑥ 用它)
    // ── ⑥ 揭曉:r10 = 1.01^10−1
    const st2 = A._trainState;
    g('trainLine').value = String((C(st2.closed[st2.cut]) * 0.9).toFixed(2));
    A._trainAnswer('buy');
    await new Promise(r => setTimeout(r, 300));
    const png2 = cv.toDataURL();
    out.pixAfterDiff = png2 !== png0; out.futAfter = nonBg();
    const log = A._lsJson(A._TRAIN_KEY, []);
    const row = log[log.length - 1];
    out.row = row;
    out.expect = { r10: (Math.pow(1.01, 10) - 1) * 100, x10: (Math.pow(1.01, 10) - 1) * 100 - (Math.pow(1.005, 10) - 1) * 100 };
    const html1 = g('trainerBody').innerHTML;
    out.reveal = { sym: html1.includes(st2.sym), date: html1.includes(st2.date), hasStats: g('trainStats').innerHTML.length > 50 };
    out.baseTxt = g('trainStats').innerText.includes(A._SIGNAL_EDGE_META.base_win.toFixed(1));
    // 對不到大盤日期 → 印警語、x10 null
    A._twiiKlineCache = { rows: [{ date: '1999/01/01', close: 1 }, { date: '1999/01/02', close: 1 }], at: Date.now() };
    await A._trainNext(); A._trainAnswer('skip'); await new Promise(r => setTimeout(r, 200));
    const log2 = A._lsJson(A._TRAIN_KEY, []); const row2 = log2[log2.length - 1];
    out.noTw = { x10null: row2.x10 == null, r10ok: row2.r10 != null, warn: g('trainReveal').innerText.includes('沒有加權可比') };
    A._twiiKlineCache = { rows: TW, at: Date.now() };
    // ── ⑧ n<10 不下結論
    const mkRows = (n, win) => Array.from({ length: n }, (_, i) => ({ ts: i, sym: '9999', d: '2024-01-01', ans: 'buy', x10: win ? 1 : -1, r10: 1, a: false }));
    localStorage.setItem(A._TRAIN_KEY, JSON.stringify(mkRows(9, true)));
    A._trainStats(); const t9 = g('trainStats').innerText;
    localStorage.setItem(A._TRAIN_KEY, JSON.stringify(mkRows(12, true)));
    A._trainStats(); const t12 = g('trainStats').innerText;
    const minN = [...Array(100).keys()].find(k => A._wrEnough(k));
    localStorage.setItem(A._TRAIN_KEY, JSON.stringify(mkRows(minN, true)));
    A._trainStats(); const tMin = g('trainStats').innerText;
    localStorage.setItem(A._TRAIN_KEY, JSON.stringify(mkRows(minN - 1, true)));
    A._trainStats(); const tMin1 = g('trainStats').innerText;
    out.n = { t9insuff: /樣本不足/.test(t9) && !/vs 隨便挑一天/.test(t9), t12verdict: /vs 隨便挑一天/.test(t12), minN, atMin: /vs 隨便挑一天/.test(tMin), belowMin: /樣本不足/.test(tMin1) };
    // ── ⑨ 修剪
    localStorage.setItem(A._TRAIN_KEY, '[]');
    for (let i = 0; i < 520; i++) A._trainLogPush({ ts: i, ans: 'skip' });
    const L = A._lsJson(A._TRAIN_KEY, []);
    out.trim = { len: L.length, first: L[0] && L[0].ts, last: L[L.length - 1] && L[L.length - 1].ts, scatter: Object.keys(localStorage).filter(k => k.startsWith(A._TRAIN_KEY + '_')).length };
    // ── ⑩ 燈號 / 位置
    localStorage.setItem(A._TRAIN_KEY, JSON.stringify(mkRows(12, true))); A._trainStats();
    const both = g('trainReveal').innerHTML + g('trainStats').innerHTML;
    out.lamp = { noRG: !/🔴|🟢/.test(both), inPane: document.querySelectorAll('[data-ovpane] #trainerModal').length, parentBody: g('trainerModal').parentElement === document.body };
    try { localStorage.removeItem(A._TRAIN_KEY); } catch (_) {}
    return out;
});

ok('① 出題合法:cut ≥ WARM、後面 ≥ FUT 根,而且最後一根⛔ 不是今天(_closedTail 有過)', R.q.bad === 0 && R.q.lastToday === 0, JSON.stringify(R.q));
ok('② 揭曉前 innerHTML ⛔ 不含股號 / 日期 / 未來收盤價', !R.leak.sym && !R.leak.date && !R.leak.fut, JSON.stringify(R.leak));
ok('③ 決定性:未來 OHLC ×3 後揭曉前的畫面逐字相同(y 軸只由可見的算)', R.pixSame === true, '');
ok('③b 揭曉後畫面必須不同', R.pixAfterDiff === true, '');
ok('④ 右側未來帶揭曉前非背景像素 = 0、揭曉後 > 200', R.futBefore === 0 && R.futAfter > 200, `before=${R.futBefore} after=${R.futAfter}`);
ok('⑤ 訊號只餵到 T(走 _trainReveal:未來末端改成崩盤後 log 的 sg 不變)且每筆有 _d', R.sig.same && R.sig.hasD && R.sig.n0 > 2, JSON.stringify(R.sig));
ok('⑥ 計分:r10 = 10.46%、x10 = r10 − 加權同期', R.row && Math.abs(R.row.r10 - R.expect.r10) < 1e-6 && Math.abs(R.row.x10 - R.expect.x10) < 1e-6, JSON.stringify({ r10: R.row && R.row.r10, x10: R.row && R.row.x10, e: R.expect }));
ok('⑥b 揭曉後才印股號與日期、統計有畫', R.reveal.sym && R.reveal.date && R.reveal.hasStats, JSON.stringify(R.reveal));
ok('⑥c 對不到大盤日期 → x10 為 null、r10 照給、畫面要印「沒有加權可比」(陷阱 #22)', R.noTw.x10null && R.noTw.r10ok && R.noTw.warn, JSON.stringify(R.noTw));
ok('⑦ 統計區印出基準勝率 _SIGNAL_EDGE_META.base_win', R.baseTxt === true, '');
ok('⑧ n<門檻「樣本不足」且無判語;n≥門檻才有;門檻 = _wrEnough', R.n.t9insuff && R.n.t12verdict && R.n.atMin && R.n.belowMin, JSON.stringify(R.n));
ok('⑨ log 520 筆 → 恰 500、留最後 500、無散 key', R.trim.len === 500 && R.trim.first === 20 && R.trim.last === 519 && R.trim.scatter === 0, JSON.stringify(R.trim));
ok('⑩ 燈號鐵則:⛔ 無 🔴🟢;modal 掛在 body、不在任何分頁 pane 裡', R.lamp.noRG && R.lamp.inPane === 0 && R.lamp.parentBody, JSON.stringify(R.lamp));
ok('⓪c 無 pageerror', errs.length === 0, errs.slice(0, 2).join(' | '));
await browser.close();
console.log('\n' + (fails.length ? `❌ ${fails.length} 條失敗` : '✅ TRAINER_PASS'));
process.exit(fails.length ? 1 : 0);
