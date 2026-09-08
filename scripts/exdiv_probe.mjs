#!/usr/bin/env node
/**
 * 💰 除權息:「除息前先賣」還是「除息當天買」? —— 第一次回測
 *
 * 使用者問:「富喬明天除權息,應該會有賣壓。這種狀況不是都說要先在除權息之前賣,
 *            或者除權息當日買進嗎?」
 *
 * ⛔ 這題本站以前寫著「填不填息還沒回測過 → 不下多空」(V74.3.8)——
 *    現在 `dividends_hist.json` 有 1,912 檔 / 2021 起,**測得動了**。
 *
 * 測三種做法(每一種都跟**同一批股票的其他日子**比,⛔ 不是跟全市場比):
 *   ① 🏃 除息前先買一段(T−5 開盤買 → 除息前一日收盤賣)= 「搶配息前那一段」
 *   ② 🛒 除息當天開盤買(價格已經扣掉股利)→ 抱 5/10/20/60 日 = 「填息行情」
 *   ③ 🎁 抱過除息(除息前一日收盤買 → 抱 N 日,**股利加回去**)= 「領息划不划算」
 *
 * ⛔ 三條方法論:
 *   ① `data/{sym}.json` 是**未還原**價(除息當天有一個「假跌」)
 *      → 只有 ③ 跨除息,必須把**股利加回去**;①② 不跨除息,⛔ 不可重複調整。
 *   ② 報酬**扣同期加權指數**;同檔同事件天然不重複(一年 1~2 次)。
 *   ③ 對照組 = **同一批股票、同一段期間的所有交易日**(共用那條腿)。
 *
 * ⛔ 只讀,不打 API、不寫任何會被部署的產物。
 * 用法:node scripts/exdiv_probe.mjs [dividends_hist.json 路徑]
 *       node scripts/exdiv_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');
const DIVP = process.argv.find(a => a.endsWith('.json')) || path.join(DATA, 'dividends_hist.json');
const FWDS = [5, 10, 20, 60];
const COST = 0.44;
const PRE = 5;            // ① 除息前幾天買

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const f2 = v => v == null ? '  --  ' : (v >= 0 ? '+' : '') + v.toFixed(2);

function loadMkt() {
    const twii = {};
    for (const r of JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))) {
        const c = +r.close; if (c > 0) twii[nd(r.date)] = c;
    }
    return twii;
}

function run(divRaw, twii, readRows) {
    const D = divRaw.d || divRaw;
    // 事件桶
    const B = {};
    const put = (k, F, v, y) => { const a = (B[k] ||= {}); const b = (a[F] ||= { v: [], yr: {} }); b.v.push(v); (b.yr[y] ||= []).push(v); };
    const stat = { sym: 0, ev: 0, skipNoRow: 0, skipNoMkt: 0, yieldAll: [] };

    for (const sym of Object.keys(D)) {
        const h = (D[sym] || {}).h; if (!Array.isArray(h) || !h.length) continue;
        const rows = readRows(sym); if (!rows || rows.length < 120) { stat.skipNoRow++; continue; }
        const d = rows.map(r => nd(r.date));
        const c = rows.map(r => +r.close);
        const o = rows.map(r => +r.open || +r.close);
        const idx = new Map(d.map((x, i) => [x, i]));
        stat.sym++;
        // 對照組:這一檔自己的所有交易日(共用那條腿)
        for (const ev of h) {
            const [exD, cash] = [nd(ev[0]), +ev[1] || 0];
            const ei = idx.get(exD); if (ei == null || ei < PRE + 1 || ei + Math.max(...FWDS) >= rows.length) continue;
            const prevC = c[ei - 1]; if (!(prevC > 0) || !(cash > 0)) continue;
            const yld = cash / prevC * 100;              // 這次的殖利率
            stat.yieldAll.push(yld);
            const y = exD.slice(0, 4);
            const ex = (i0, i1, addDiv) => {             // 相對加權的超額報酬(%)
                const m0 = twii[d[i0]], m1 = twii[d[i1]];
                if (!(m0 > 0) || !(m1 > 0)) { stat.skipNoMkt++; return null; }
                return null;
            };
            const exOf = (buyPx, buyD, sellIdx, addDiv) => {
                const m0 = twii[buyD], m1 = twii[d[sellIdx]];
                if (!(m0 > 0) || !(m1 > 0) || !(buyPx > 0)) return null;
                const sell = c[sellIdx] + (addDiv ? cash : 0);
                return ((sell / buyPx - 1) - (m1 / m0 - 1)) * 100;
            };
            stat.ev++;
            const yb = yld >= 4 ? '殖利率≥4%' : yld >= 2 ? '殖利率2~4%' : '殖利率<2%';

            // ① 除息前先買一段(T−PRE 開盤買 → 除息前一日收盤賣)⛔ 不跨除息
            {
                const bi = ei - PRE, m0 = twii[d[bi]], m1 = twii[d[ei - 1]];
                if (m0 > 0 && m1 > 0 && o[bi] > 0) {
                    const v = ((c[ei - 1] / o[bi] - 1) - (m1 / m0 - 1)) * 100;
                    put('① 除息前 5 天買(除息前一日賣)', 'pre', v, y);
                    put(`①${yb}`, 'pre', v, y);
                }
            }
            // ② 除息當天開盤買(價格已扣息)→ 抱 N 日 ⛔ 不跨除息
            for (const F of FWDS) {
                const v = exOf(o[ei], d[ei], ei + F, false);
                if (v != null) { put('② 除息當天開盤買', F, v, y); put(`②${yb}`, F, v, y); }
            }
            // ③ 抱過除息(除息前一日收盤買 → 抱 N 日,股利加回去)
            for (const F of FWDS) {
                const v = exOf(prevC, d[ei - 1], ei + F, true);
                if (v != null) put('③ 抱過除息(含息)', F, v, y);
                const v2 = exOf(prevC, d[ei - 1], ei + F, false);
                if (v2 != null) put('③b 抱過除息(⛔ 不含息,只看價格)', F, v2, y);
            }
            // 🆚 對照組:同一檔、同一段期間隨機的其他日子(避開除息前後 10 天)
            for (const F of FWDS) {
                for (const off of [-90, -60, 60, 90]) {
                    const bi = ei + off; if (bi < 1 || bi + F >= rows.length) continue;
                    if (Math.abs(off) < 10) continue;
                    const v = exOf(o[bi], d[bi], bi + F, false);
                    if (v != null) put('🆚 對照(同一批股票的其他日子)', F, v, y);
                }
            }
        }
    }
    return { B, stat };
}

function report(B, stat, tag) {
    console.log(`\n【0】${tag}:${stat.sym} 檔 ・${stat.ev.toLocaleString()} 次除權息事件 ・殖利率中位 ${f2(med(stat.yieldAll))}%`);
    const ctrl = B['🆚 對照(同一批股票的其他日子)'] || {};
    const line = (k) => {
        const a = B[k]; if (!a) return;
        const parts = [];
        for (const F of ['pre', ...FWDS]) {
            const b = a[F]; if (!b) continue;
            const m = mean(b.v), cm = ctrl[F] ? mean(ctrl[F].v) : null;
            const rel = (m != null && cm != null) ? m - cm : null;
            parts.push(`${F === 'pre' ? '前5日' : F + '日'} ${f2(m)}${rel != null ? `(vs對照 ${f2(rel)})` : ''} n=${b.v.length}`);
        }
        console.log(`  ${k}\n     ${parts.join(' ・ ')}`);
    };
    for (const k of Object.keys(B)) line(k);
    // 逐年(只對主要三條)
    console.log('\n【逐年】20 日(相對對照組 pp)—— ⛔ 逐年不同向就不可當結論');
    for (const k of ['② 除息當天開盤買', '③ 抱過除息(含息)', '③b 抱過除息(⛔ 不含息,只看價格)']) {
        const a = B[k] && B[k][20]; if (!a) continue;
        const cy = (ctrl[20] || {}).yr || {};
        const out = Object.keys(a.yr).sort().map(y => {
            const m = mean(a.yr[y]), cm = cy[y] ? mean(cy[y]) : null;
            return `${y} ${f2(m != null && cm != null ? m - cm : null)}`;
        });
        console.log(`  ${k}\n     ${out.join(' ・ ')}`);
    }
    // ① 逐年
    {
        const a = B['① 除息前 5 天買(除息前一日賣)'];
        if (a && a.pre) console.log(`  ① 除息前 5 天買\n     ${Object.keys(a.pre.yr).sort().map(y => `${y} ${f2(mean(a.pre.yr[y]))}`).join(' ・ ')}   ⚠️ 只有 5 天,⛔ 對照組是 5/10/20/60 日,不可直接相減`);
    }
}

if (SELFTEST) {
    // 合成:除息後注入 +3% 的填息行情 → 必須抓得到
    const days = []; for (let i = 0; i < 400; i++) days.push(new Date(Date.UTC(2023, 0, 2) + i * 864e5).toISOString().slice(0, 10));
    const twii = Object.fromEntries(days.map(d => [d, 10000]));
    const exI = [100, 200, 300];
    // ⚠️ 合成資料要**重現真實形狀**:除息當天價格先掉一個股利(未還原價),
    //   然後在之後 20 天慢慢填回來 —— ⛔ 第一版只在除息日加一個台階,
    //   那樣「除息當天買、抱 20 天」的報酬是 0,正向對照組永遠測不到東西。
    const ramp = k => k < 0 ? 0 : Math.min(k, 20) / 20 * 2.5;
    const rows = days.map((d, i) => {
        let p = 50;
        for (const e of exI) { if (i >= e) p -= 1.0; p += ramp(i - e); }
        return { date: d, open: +p.toFixed(2), high: +p.toFixed(2), low: +p.toFixed(2), close: +p.toFixed(2), volume: 1e6 };
    });
    const div = { d: { '1111': { h: exI.map(i => [days[i], 1.0, '息', 50, 49]) } } };
    const { B, stat } = run(div, twii, () => rows);
    const a = B['② 除息當天開盤買'], ctrl = B['🆚 對照(同一批股票的其他日子)'];
    const m20 = a && a[20] ? mean(a[20].v) : null, c20 = ctrl && ctrl[20] ? mean(ctrl[20].v) : null;
    const okA = m20 != null && c20 != null && (m20 - c20) > 1.0;
    console.log(`${okA ? '✅' : '❌'} selftest① 注入的填息行情抓得到(② 相對對照 ${f2(m20 - c20)}pp)`);
    // ③ 含息 vs 不含息:含息一定要比較高(股利加回去)
    const inc = B['③ 抱過除息(含息)'], exc = B['③b 抱過除息(⛔ 不含息,只看價格)'];
    const gap = mean(inc[20].v) - mean(exc[20].v);
    const okB = Math.abs(gap - 2.0) < 0.2;   // 股利 1.0 / 買價 50 = 2.0%
    console.log(`${okB ? '✅' : '❌'} selftest② 含息比不含息剛好高「股利÷買價」(實測 ${f2(gap)}pp,應 ≈ +2.00)`);
    process.exit(okA && okB ? 0 : 1);
}

const twii = loadMkt();
const div = JSON.parse(fs.readFileSync(DIVP, 'utf8'));
const cache = new Map();
const readRows = sym => {
    if (cache.has(sym)) return cache.get(sym);
    let r = null;
    try { r = JSON.parse(fs.readFileSync(path.join(DATA, sym + '.json'), 'utf8')).filter(x => x && +x.close > 0); } catch (_) { r = null; }
    cache.set(sym, r); return r;
};
console.log(`📂 股利檔 ${DIVP}(${div.n || Object.keys(div.d || div).length} 檔,from ${div.from || '?'})`);
const { B, stat } = run(div, twii, readRows);
report(B, stat, '全市場');
console.log(`
⚠️ 限制(⛔ 必須跟結論一起講):
  ① 窗口 2021 起、只有這幾年 —— ⛔ 不可外推。
  ② ⛔ **沒有扣稅**:現金股利要併入所得、單次 ≥2 萬還有二代健保補充保費 2.11%
     → 「抱過除息」的實際到手比這裡算的少。
  ③ 對照組是「同一批股票的其他日子」(除息日前後 ±60/90 天),⛔ 不是全市場。
  ④ 倖存者偏誤:已下市的不在 data/ 裡。
  ⑤ 成本 ${COST}%:①③ 各算一趟,⛔ 表上的數字都**還沒扣**。`);
