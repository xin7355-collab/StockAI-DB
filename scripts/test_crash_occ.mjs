#!/usr/bin/env node
/**
 * 🌪️🎲 V81.0.3 反攻雷達底下「25 天內跌 ≥15%」那一行發生率
 *   (index.html `_crashFastState` / `_CRASH_OCC` / `_crashOccHtml`;使用者 11/06:「把何時台股反攻給找出來」)
 *
 *  ① 判斷跟探針同一份定義:加權日 K(gh-pages data/^TWII.json)每一天的前綴丟 App,
 *     跟 scripts/lib_crash.mjs corrLegs + crash_cycle_probe.fastEvents + firstPerLeg 逐日比(亮不亮 + 第一次是哪天)
 *  ② 有亮 → data-occ="crash"、台股 / 修正中隨便一天 / 8 個市場三個比例都在、「⛔ 不是會漲或會跌」;
 *     ⭐ 決定性對照:同一份資料切在平靜的日子 → 一個字都沒有
 *  ③ 數字讀 _CRASH_OCC(改常數畫面跟著變)
 *  ④ ⛔ 研究字樣(lib_retailbad)、⛔ 🔴🟢、⛔ 叫人買賣
 *  ⑤ 今天那根在台北 13:30 前還沒收盤 → 先不算;收盤後照算
 *  ⑥ 真的接進反攻雷達(瀏覽器實跑 `_renderReboundRadar`,有亮 / 沒亮各一次)
 *  注入:INJECT=th(跌 14% 就算)/ INJECT=end(回到高點 6% 以內就算修正結束)/ INJECT=noleg(不看修正段)→ 必紅
 *  ⚠️ 兩種注入⛔ 拿來用(實測沒有鑑別力,不是測試壞了):「前 25 天最高含當天」(當天若是最高,c ≤ 0.85c 本來就不成立)、
 *     「前 24 天最高」(App 只看每一段第一次急跌,少看一天在真資料與合成資料 6,100 天裡一天都沒變)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { badOf } from './lib_retailbad.mjs';
import { ghJsonOrDie } from './lib_ghdata.mjs';
import { corrLegs, firstPerLeg } from './lib_crash.mjs';
import { fastEvents } from './crash_cycle_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ORIG = SRC, INJ = process.env.INJECT || '';
if (INJ === 'end') SRC = SRC.replace('else if (x > -0.05) { cur = null; legNo++; continue; }', 'else if (x > -0.06) { cur = null; legNo++; continue; }');
if (INJ === 'th') SRC = SRC.replace('if (c[i] <= mx * 0.85) { first = i; break; }', 'if (c[i] <= mx * 0.86) { first = i; break; }');
if (INJ === 'noleg') SRC = SRC.replace('if (corr[k] < 0) return { on: false, d: d[k] };', '').replace('if (corr[i] !== corr[k]) continue;', '');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }

const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ── 從 index.html 原文抽出那幾支(⛔ 測試裡另寫一份)
const grab = (k, isObj) => {
    const m = new RegExp(`\\n    ${k}${isObj ? ': ' : '\\('}`).exec(SRC);
    if (!m) throw new Error('找不到 ' + k);
    const s = SRC.indexOf('{', m.index + 5); let d = 0, i = s;
    for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && --d === 0) break; }
    return (0, eval)('({' + SRC.slice(m.index + 5, i + 1) + '})')[k];
};
const A = {
    _crashFastState: grab('_crashFastState'), _crashOccHtml: grab('_crashOccHtml'), _CRASH_OCC: grab('_CRASH_OCC', true),
    _occPct: grab('_occPct'), _dW: v => String(v).slice(5).replace('-', '/'),
    _lastBarIsToday: () => false, _tpeMinutes: () => ({ min: 15 * 60 }), _renderReboundRadar() {}, _getTwiiRows: async () => null,
};

const rows = ghJsonOrDie('data/^TWII.json');
const c = rows.map(r => +r.close), dd = rows.map(r => String(r.date).replace(/\//g, '-').slice(0, 10));
ok('⓪ 測資:加權日 K 夠長(≥ 600 根)', Array.isArray(rows) && rows.length >= 600, rows && rows.length);

// ① 逐日比:探針那一份(整段一次算;corrLegs / fastEvents / firstPerLeg 都只用 ≤ 那天的資料)
const CL = corrLegs(c), first = firstPerLeg(fastEvents(c, 15, 25), CL.corr);
const firstOfLeg = new Map(first.map(i => [CL.corr[i], i]));
let nDay = 0, nOn = 0, nBad = 0; const bad = [];
for (let k = 275; k < c.length; k++) {
    const leg = CL.corr[k], fi = leg >= 0 ? firstOfLeg.get(leg) : undefined;
    const truth = fi !== undefined && fi <= k;
    const s = A._crashFastState(rows.slice(0, k + 1));
    nDay++; if (truth) nOn++;
    const same = s && s.on === truth && (!truth || s.d === dd[fi]);
    if (!same && ++nBad <= 5) bad.push(`${dd[k]} 探針 ${truth ? '亮(' + dd[fi] + ')' : '不亮'} vs App ${s ? (s.on ? '亮(' + s.d + ')' : '不亮') : 'null'}`);
}
ok(`① 每一天都跟探針一樣(${nDay} 天,其中 ${nOn} 天在「有急跌的修正段」裡)`, nBad === 0, `${nBad} 天不一樣:` + bad.join(' ・'));
ok('① 空過守門:這段期間真的有亮過(≥ 20 天)也有不亮(≥ 200 天)', nOn >= 20 && nDay - nOn >= 200, [nOn, nDay]);
// ①b 合成走勢(同 test_crash_global 的產生器:固定種子、埋好幾段急跌)—— 真資料 2021 起急跌太少,少看一天(INJECT=w)在真資料上看不出來
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function synth(seed, n = 1800) {
    const R = rng(seed), out = []; let c = 1000, crash = 0, t = Date.UTC(2001, 0, 2);
    for (let i = 0; i < n; i++) {
        if (i) {
            if (!crash && R() < 0.004) crash = 10 + Math.floor(R() * 25);
            const g = (R() + R() + R() - 1.5) * 0.02, drift = crash ? -0.012 - R() * 0.01 : 0.0004;
            if (crash) crash--;
            c = +(c * (1 + drift + g)).toFixed(2);
            do { t += 864e5; } while ([0, 6].includes(new Date(t).getUTCDay()));
        }
        out.push({ date: new Date(t).toISOString().slice(0, 10).replace(/-/g, '/'), close: c });
    }
    return out;
}
let sDay = 0, sOn = 0, sBad = 0; const sMsg = [];
for (const seed of [1, 7, 42, 2026]) {
    const R = synth(seed), cc = R.map(r => r.close), dz = R.map(r => r.date.replace(/\//g, '-'));
    const L = corrLegs(cc), F = new Map(firstPerLeg(fastEvents(cc, 15, 25), L.corr).map(i => [L.corr[i], i]));
    for (let k = 275; k < cc.length; k++) {
        const fi = L.corr[k] >= 0 ? F.get(L.corr[k]) : undefined, truth = fi !== undefined && fi <= k;
        const s = A._crashFastState(R.slice(0, k + 1)); sDay++; if (truth) sOn++;
        if (!(s && s.on === truth && (!truth || s.d === dz[fi])) && ++sBad <= 3) sMsg.push(`#${seed} ${dz[k]} 探針 ${truth ? dz[fi] : '不亮'} vs App ${s && s.on ? s.d : '不亮'}`);
    }
}
ok(`①b 合成走勢 4 組也每一天都一樣(${sDay} 天,其中 ${sOn} 天亮)`, sBad === 0 && sOn >= 200, `${sBad} 天不一樣:` + sMsg.join(' ・'));

// ② 有亮 vs 沒亮(同一份資料切在不同天)
const onK = (() => { for (let k = c.length - 1; k >= 275; k--) { const leg = CL.corr[k], fi = leg >= 0 ? firstOfLeg.get(leg) : undefined; if (fi !== undefined && fi <= k) return k; } return -1; })();
const offK = (() => { for (let k = c.length - 1; k >= 275; k--) if (CL.corr[k] < 0) return k; return -1; })();
const html = k => { A._twiiKlineCache = { rows: rows.slice(0, k + 1) }; return A._crashOccHtml(); };
const hOn = onK > 0 ? html(onK) : '', hOff = offK > 0 ? html(offK) : 'x';
const txt = h => h.replace(/<[^>]+>/g, ' ');
ok(`② 有亮那天(${dd[onK]})→ 有 data-occ="crash" 那一行`, /data-occ="crash"/.test(hOn), hOn.slice(0, 200));
ok(`② ⭐ 決定性對照:沒在修正段的那天(${dd[offK]})→ 一個字都沒有`, hOff === '', hOff.slice(0, 200));
const O = A._CRASH_OCC;
ok('② 三個比例:台股 x/y、台股修正中隨便一天、8 個市場合計', new RegExp(`台股 ${O.tw.re}/${O.tw.reN} 次`).test(hOn) && /修正中隨便一天 57%/.test(hOn) && new RegExp(`${O.all.mk} 個市場合計 ${O.all.re}/${O.all.reN} 次`).test(hOn), txt(hOn));
ok('② 那一段的最低點什麼時候到(一週內 / 一週到半年 / 半年以上)', new RegExp(`一週內就到 ${O.tw.wk} 次 ・一週到半年 ${O.tw.mo} 次 ・半年以上 ${O.tw.half} 次`).test(hOn), txt(hOn));
ok('② 一定寫「過去發生過的比例,⛔ 不是會漲或會跌」', /過去發生過的比例,⛔ 不是會漲或會跌/.test(hOn), txt(hOn));
ok('② 第一次急跌那天要寫出來', hOn.includes(A._dW(A._crashFastState(rows.slice(0, onK + 1)).d)), txt(hOn));
ok('② 常數自己對得上(一週內 + 一週到半年 + 半年以上 = 已走完的次數)', O.tw.wk + O.tw.mo + O.tw.half === O.tw.leg && O.all.wk + O.all.mo + O.all.half === O.all.leg && O.tw.leg <= O.tw.n && O.all.leg <= O.all.n, JSON.stringify(O));

// ③ 決定性對照:改常數 → 畫面跟著變
const save = JSON.parse(JSON.stringify(A._CRASH_OCC));
A._CRASH_OCC.tw.re = 3; A._CRASH_OCC.tw.reN = 19; A._CRASH_OCC.base = 41;
const hMod = html(onK);
ok('③ 改 _CRASH_OCC → 畫面跟著變(⛔ 寫死)', /台股 3\/19 次/.test(hMod) && /修正中隨便一天 41%/.test(hMod) && !/台股 12\/19 次/.test(hMod), txt(hMod));
A._CRASH_OCC = save;

// ④ 措辭
ok('④ ⛔ 研究字樣(lib_retailbad)', badOf(txt(hOn)).length === 0, badOf(txt(hOn)));
ok('④ ⛔ 🔴🟢(這是發生率,不是漲跌方向)', !/🔴|🟢/.test(hOn), hOn);
ok('④ ⛔ 叫人買賣 / 抄底 / 反攻訊號', !/買進|賣出|抄底|加碼|減碼|進場|出場|可以買|該賣|反攻訊號|底部確認/.test(txt(hOn)), txt(hOn));

// ⑤ 今天那根還沒收盤
const today = String(rows[onK].date);
A._lastBarIsToday = r => String(r[r.length - 1].date) === today;
A._tpeMinutes = () => ({ min: 10 * 60 });
const sOpen = A._crashFastState(rows.slice(0, onK + 1)), sPrev = A._crashFastState(rows.slice(0, onK));
ok('⑤ 台北 10:00 → 今天那根先不算(= 只看到昨天)', JSON.stringify(sOpen) === JSON.stringify(sPrev), [JSON.stringify(sOpen), JSON.stringify(sPrev)]);
A._tpeMinutes = () => ({ min: 13 * 60 + 31 });
const sClose = A._crashFastState(rows.slice(0, onK + 1));
ok('⑤ 台北 13:31 → 今天那根照算', sClose && sClose.last === dd[onK], JSON.stringify(sClose));
A._lastBarIsToday = () => false;
ok('⑤ 資料不夠(< 275 根)→ null,⛔ 硬給', A._crashFastState(rows.slice(0, 200)) === null);

// ⑥ 瀏覽器:真的接進反攻雷達
if (!INJ) {
    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
    const page = await browser.newPage();
    const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
    const errs = [];
    page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
    await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app._crashOccHtml && !!document.getElementById('reboundRadarCard'), null, { timeout: 20000 });
    const radar = k => page.evaluate(r => {
        app._lastBarIsToday = () => false;
        app._twiiKlineCache = { rows: r, at: Date.now() };
        app._macroRiskCache = Object.assign({}, app._macroRiskCache || {}, { vix: 28, fi_futures_net: -60000 });
        app.usMacroCache = Object.assign({}, app.usMacroCache || {}, { twii_history: r.slice(-120) });
        app._renderReboundRadar();
        const el = document.getElementById('reboundRadarCard');
        return el ? el.innerHTML : '';
    }, rows.slice(0, k + 1));
    const rOn = await radar(onK), rOff = await radar(offK);
    ok('⑥ 反攻雷達(有急跌那天)真的畫出 data-occ="crash"', /data-occ="crash"/.test(rOn), rOn.slice(-600));
    ok('⑥ 反攻雷達(平靜那天)沒有那一行(決定性對照)', !/data-occ="crash"/.test(rOff) && /反攻條件雷達/.test(rOff), rOff.slice(-300));
    ok('⑥ 那一行排在空頭守門之後、0050 那行之前', rOn.indexOf('data-occ="crash"') < rOn.indexOf('data-dip0050'), '');
    ok('⑥ 無 pageerror', errs.length === 0, errs.join(' | '));
    await browser.close();
}

console.log(fails.length ? `\n❌ test_crash_occ ${fails.length} 條沒過` : '\n✅ test_crash_occ 全部通過');
process.exit(fails.length ? 1 : 0);
