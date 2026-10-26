#!/usr/bin/env node
/**
 * 📦 V79.8.2 營收加速 16 年版:把 stock_deep 分支的月營收(2009 起)湊成季營收 → 跟 fin_deep.json 同一個形狀({q, f: ['rev'], s, meta})
 *   給 lib_finaccel.finSeries(它只用 rev 算 yoy / acc;⛔ 這裡不寫第二份公式)
 *
 *   ⛔ 三個月都有、而且都 > 0 才算那一季(缺一個月 = 那一季不知道,⛔ 不可拿兩個月推)
 *   ⏳ 可用日照 finSeries 的 pubDate(季報法定截止日 5/15・8/14・11/14・3/31)—— 比月營收實際公布(隔月 10 日)晚,
 *      保守,而且跟 fin_deep 版同一把尺(⛔ 換成月營收公布日 = 兩個版本的「知道」不是同一天)
 *   🧾 同一個月出現兩次(公司更正)→ 用後面那一筆
 *   🔎 對表:2018 起跟 fin_deep 比「營收加速」旗標(回測用的就是它),一致 < 95% → exit 1(⛔ 對不上就不可拿來回測);季營收差幾 % 只印出來
 *
 * 📑 V79.9.1 `--fin` 模式:季報三表接成 16 年(使用者 10/26「4 年與 16 年中間缺少的補齊」)
 *   stock_deep/fis10・fbs10・fcf10(2010 ~ 2018-06)+ fin_deep.json(2018 起)→ 跟 fin_deep 同一個形狀({q, f, s, meta})
 *   ・科目名 → 欄位一律讀 fin_backfill.py 的 WANT(⛔ 這裡不抄第二份對照表)
 *   ・值照原樣(現金流量表是累計 → 交給 lib_fundamentals.detectCumulative / quarterValue 還原,⛔ 這裡不先減)
 *   ・重疊那兩季(2018Q1 / Q2)逐欄對表,差 ≤ 0.5% 算一致;fin_deep 有的欄位一致 < 95% → exit 1(⛔ 不寫檔)
 *   ・重疊季一律用 fin_deep 的值(較新);stock_deep 只補 2018-01-01 之前
 *   ・每張表實際從哪一季開始印出來(資產負債表 2013 起是資料源本身,⛔ 不是漏抓)
 *
 * 用法:node scripts/fin16_build.mjs <rev 目錄(stock_deep/rev/*.json.gz)> <fin_deep.json> <輸出>
 *       node scripts/fin16_build.mjs --fin <stock_deep 目錄(含 fis10/fbs10/fcf10)> <fin_deep.json> <輸出>
 *       node scripts/fin16_build.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { finSeries, finOnAt } from './lib_finaccel.mjs';

const QEND = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' };

/** 一檔月營收({d, c, v})→ {季底: 季營收};⛔ 缺月 / ≤ 0 的那一季不收 */
export function quartersOf(j) {
    const c = j && Array.isArray(j.c) ? j.c : [];
    const ir = c.indexOf('revenue'), im = c.indexOf('revenue_month'), iy = c.indexOf('revenue_year');
    if (ir < 0 || im < 0 || iy < 0 || !Array.isArray(j.v)) return {};
    const mon = new Map();
    for (const r of j.v) {
        const y = +r[iy], m = +r[im], v = +r[ir];
        if (!(y > 1990 && m >= 1 && m <= 12)) continue;
        mon.set(`${y}-${m}`, v);   // 同一個月第二次出現(更正)→ 後面那一筆蓋掉
    }
    const out = {};
    const ys = [...new Set([...mon.keys()].map(k => +k.split('-')[0]))].sort((a, b) => a - b);
    for (const y of ys) for (let q = 1; q <= 4; q++) {
        let s = 0, okq = true;
        for (let m = 3 * q - 2; m <= 3 * q; m++) { const v = mon.get(`${y}-${m}`); if (!(v > 0)) { okq = false; break; } s += v; }
        if (okq) out[`${y}-${QEND[q]}`] = s;
    }
    return out;
}

/** 對表:2018 起兩邊都有的季,季營收差 ≤ tol 的比例 + 「營收加速」旗標(每一季公布日那天 finOnAt)兩邊一致的比例
 *  ⭐ 真正要對的是旗標(回測用的是它):月營收加總跟財報營收有會計口徑差(實測差 ≤ 2% 91%、≤ 10% 94%),但旗標一致 98.7% */
export function crossCheck(F16, FD, from = '2018-01-01', tol = 0.02) {
    const ir = FD.f.indexOf('rev');
    let n = 0, agree = 0, fBoth = 0, fSame = 0; const worst = [];
    const flagFrom = `${+from.slice(0, 4) + 1}${from.slice(4)}`;   // 加速要前 5 季 → 往後一年才比得到
    for (const [sym, rec] of Object.entries(FD.s)) {
        const mine = F16.s[sym]; if (!mine) continue;
        for (const [q, row] of Object.entries(rec)) {
            if (q < from) continue;
            const fd = +(row || [])[ir], me = (mine[q] || [])[0];
            if (!(fd > 0) || !(me > 0)) continue;
            n++;
            const d = me / fd - 1;
            if (Math.abs(d) <= tol) agree++; else if (worst.length < 8) worst.push([sym, q, +(d * 100).toFixed(1)]);
        }
        const a = finSeries(FD, sym), b = finSeries(F16, sym);
        if (a && b) for (const x of a) { if (x.pub < flagFrom) continue; const va = finOnAt(a, x.pub), vb = finOnAt(b, x.pub); if (va === null || vb === null) continue; fBoth++; if (va === vb) fSame++; }
    }
    return { n, agree, pct: n ? agree / n * 100 : 0, worst, fBoth, flagPct: fBoth ? fSame / fBoth * 100 : 0 };
}


/** fin_backfill.py 的 WANT → {FinMind 科目名: 欄位}(⛔ 不抄第二份) */
export function wantMap(src) {
    const txt = src ?? fs.readFileSync(new URL('./fin_backfill.py', import.meta.url), 'utf8');
    const a = txt.indexOf('WANT = {'), b = txt.indexOf('\n}', a);
    if (a < 0 || b < 0) return {};
    const out = {};
    for (const m of txt.slice(a, b).matchAll(/'(\w+)':\s*'(\w+)'/g)) if (!/^Taiwan/.test(m[2])) out[m[2]] = m[1];
    return out;
}

const SPLIT = '2018-01-01';   // fin_deep 從這一天起(meta.start)
/** 三張表({tbl: {sym: {d, c, v}}})+ fin_deep → 16 年 F + 對表 */
export function mergeFin(tables, FD, want, tol = 0.005) {
    const f = FD.f.slice(), S = {}, Q = new Set(FD.q), first = {};
    const agree = {}, both = {}, worst = [];
    for (const [tbl, bySym] of Object.entries(tables)) {
        for (const [sym, j] of Object.entries(bySym)) {
            if (!j || !Array.isArray(j.d) || !Array.isArray(j.c) || !Array.isArray(j.v)) continue;
            const col = j.c.map(c => f.indexOf(want[c]));
            j.d.forEach((q, r) => {
                const row = j.v[r] || [];
                col.forEach((k, ci) => {
                    if (k < 0) return;
                    const v = row[ci];
                    if (v == null || !Number.isFinite(+v)) return;
                    const fd = FD.s[sym] && FD.s[sym][q];
                    if (fd) {                                        // 重疊季 → 對表(fin_deep 有值才比)
                        const x = fd[k];
                        if (x != null) {
                            both[f[k]] = (both[f[k]] || 0) + 1;
                            const d = x === 0 ? Math.abs(+v) : Math.abs(+v / x - 1);
                            if (d <= tol || Math.abs(+v - x) < 0.005) agree[f[k]] = (agree[f[k]] || 0) + 1;
                            else if (worst.length < 8) worst.push([sym, q, f[k], +v, x]);
                        }
                    }
                    if (q >= SPLIT) return;                          // 2018 起一律用 fin_deep
                    const rr = ((S[sym] ||= {})[q] ||= Array(f.length).fill(null));
                    rr[k] = +v; Q.add(q);
                    if (!first[f[k]] || q < first[f[k]]) first[f[k]] = q;
                });
            });
        }
    }
    for (const [sym, rec] of Object.entries(FD.s)) {
        const o = (S[sym] ||= {});
        for (const [q, row] of Object.entries(rec)) o[q] = f.map((_, k) => row[k] ?? null);
    }
    const chk = Object.fromEntries(Object.keys(both).map(k => [k, { n: both[k], pct: +((agree[k] || 0) / both[k] * 100).toFixed(1) }]));
    return { F: { q: [...Q].sort(), f, s: S }, chk, first, worst };
}

const MAIN = import.meta.url === `file://${process.argv[1]}`;   // 被 import 時(對表工具)⛔ 跑主程式
if (MAIN && process.argv.includes('--selftest')) {
    let bad = 0;
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + JSON.stringify(e)}`); if (!c) bad++; };
    // 2019-01 ~ 2020-12,每月營收 = 月份 × 10;2020-05 缺;2019-07 出現兩次(更正:第二筆 999)
    const v = [];
    for (const y of [2019, 2020]) for (let m = 1; m <= 12; m++) { if (y === 2020 && m === 5) continue; v.push([m * 10, m, y]); }
    v.push([999, 7, 2019]);
    const q = quartersOf({ d: [], c: ['revenue', 'revenue_month', 'revenue_year'], v });
    ok('① 季營收 = 三個月加總(2019Q1 = 10+20+30)', q['2019-03-31'] === 60, q);
    ok('② 同一個月出現兩次 → 用後面那一筆(2019Q3 = 999+80+90)', q['2019-09-30'] === 999 + 80 + 90, q);
    ok('③ 缺一個月的那一季不收(2020Q2 沒有)', !('2020-06-30' in q) && q['2020-03-31'] === 60, q);
    ok('④ 欄位名對不上 → 空的(⛔ 猜欄位)', Object.keys(quartersOf({ c: ['a', 'b', 'c'], v })).length === 0);
    // ⑤ 接 finSeries:形狀對得上、公布日照法定截止日、加速判斷照 lib_finaccel
    const F = { q: Object.keys(q).sort(), f: ['rev'], s: { X: Object.fromEntries(Object.entries(q).map(([k, x]) => [k, [x]])) } };
    const ser = finSeries(F, 'X');
    const q4 = ser && ser.find(x => x.p === '2020-12-31');
    ok('⑤ finSeries 讀得懂(2020Q4 公布日 2021-03-31、yoy = 0%)', q4 && q4.pub === '2021-03-31' && Math.abs(q4.yoy) < 1e-9, q4);
    ok('⑤b 公布日之前 ⛔ 知道那一季(2021-03-30 那天最新的是 2020Q3)', finOnAt(ser, '2021-03-30') === finOnAt(ser, '2020-11-15'));
    // ⑥ 對表:決定性對照 —— 一樣 → 100%;差 5% → 0%
    const FD = { f: ['x', 'rev'], s: { X: { '2019-03-31': [0, 60], '2019-06-30': [0, 150] } } };
    const c1 = crossCheck(F, FD, '2019-01-01');
    const FD2 = { f: ['x', 'rev'], s: { X: { '2019-03-31': [0, 63], '2019-06-30': [0, 157.5] } } };
    const c2 = crossCheck(F, FD2, '2019-01-01');
    ok('⑥ 對表:一樣 → 100%;都差 5% → 0%(對表有鑑別力)', c1.n === 2 && c1.pct === 100 && c2.n === 2 && c2.pct === 0, [c1, c2]);
    ok('⑥b 對表也回旗標一致率(欄位在,季數不夠時 0 次)', 'flagPct' in c1 && c1.fBoth === 0, c1);
    // ⑦ --fin:科目名讀 fin_backfill.WANT
    const W = wantMap();
    ok('⑦ 科目名讀 fin_backfill.WANT(Revenue → rev・Liabilities → li・CashFlowsFromOperatingActivities → ocf)', W.Revenue === 'rev' && W.Liabilities === 'li' && W.CashFlowsFromOperatingActivities === 'ocf' && !('TaiwanStockBalanceSheet' in W), W);
    // ⑧ 接起來:2018 前用 stock_deep、2018 起用 fin_deep;重疊季對表
    const FDx = { q: ['2018-03-31', '2018-06-30'], f: ['ocf', 'rev', 'li'], s: { A: { '2018-03-31': [5, 100, null], '2018-06-30': [12, 110, 50] } } };
    const T = { fis10: { A: { d: ['2017-12-31', '2018-03-31', '2018-06-30'], c: ['Revenue', 'EPS'], v: [[90, 1], [100, 1.1], [110, 1.2]] } },
        fcf10: { A: { d: ['2017-09-30', '2018-03-31', '2018-06-30'], c: ['CashFlowsFromOperatingActivities'], v: [[30], [5], [12]] } },
        fbs10: { A: { d: ['2017-12-31', '2018-06-30'], c: ['Liabilities'], v: [[40], [50]] } } };
    const m = mergeFin(T, FDx, W);
    ok('⑧ 2017 季接上(rev 90 ・ocf 30 ・li 40)、2018 季沿用 fin_deep', m.F.s.A['2017-12-31'][1] === 90 && m.F.s.A['2017-09-30'][0] === 30 && m.F.s.A['2017-12-31'][2] === 40 && m.F.s.A['2018-03-31'][1] === 100 && m.F.q[0] === '2017-09-30', m.F.s.A);
    ok('⑧b fin_deep 沒有的欄位(eps)⛔ 硬塞;fin_deep 那一格是 null 的不算進對表', m.F.f.length === 3 && m.chk.li.n === 1 && m.chk.rev.n === 2 && m.chk.ocf.n === 2, m.chk);
    ok('⑧c 對表一樣 → 100%', m.chk.rev.pct === 100 && m.chk.ocf.pct === 100 && m.chk.li.pct === 100, m.chk);
    const T2 = JSON.parse(JSON.stringify(T)); T2.fis10.A.v[1][0] = 103; T2.fis10.A.v[2][0] = 113.3;
    const m2 = mergeFin(T2, FDx, W);
    ok('⑧d 決定性對照:重疊季差 3% → 營收一致 0%(對表有鑑別力)', m2.chk.rev.pct === 0 && m2.worst.length === 2, m2.chk);
    ok('⑧e 每個欄位實際從哪一季開始(資產負債表 2017-12-31、現金流量表 2017-09-30)', m.first.li === '2017-12-31' && m.first.ocf === '2017-09-30', m.first);
    console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ FIN16_BUILD_SELFTEST_PASS');
    process.exit(bad ? 1 : 0);
}

if (MAIN && process.argv[2] === '--fin') mainFin();
else if (MAIN) main();
function main() {
const [DIR, FDP, OUT] = process.argv.slice(2);
if (!DIR || !FDP || !OUT) { console.error('用法:node scripts/fin16_build.mjs <rev 目錄> <fin_deep.json> <輸出>'); process.exit(1); }
const files = fs.readdirSync(DIR).filter(f => /^\w+\.json\.gz$/.test(f)).sort();
if (files.length < 500) { console.error(`❌ ${DIR} 只有 ${files.length} 檔月營收 → ⛔ 不建`); process.exit(1); }
const S = {}, Q = new Set();
let bad = 0;
for (const f of files) {
    let j; try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))).toString('utf8')); } catch (_) { bad++; continue; }
    const q = quartersOf(j);
    const ks = Object.keys(q); if (!ks.length) continue;
    S[f.replace(/\.json\.gz$/, '')] = Object.fromEntries(ks.map(k => { Q.add(k); return [k, [q[k]]]; }));
}
const F16 = { q: [...Q].sort(), f: ['rev'], s: S, meta: { built: new Date().toISOString().slice(0, 10), src: 'stock_deep/rev(FinMind TaiwanStockMonthRevenue)三個月加總', n: Object.keys(S).length, caveat: '可用日照季報法定截止日(保守);缺月的季不收' } };
const FD = JSON.parse(fs.readFileSync(FDP, 'utf8'));
const c = crossCheck(F16, FD);
console.log(`📦 ${files.length} 檔月營收(讀不成 ${bad})→ ${F16.meta.n} 檔有季營收 ・${F16.q[0]} ~ ${F16.q[F16.q.length - 1]}(${F16.q.length} 季)`);
console.log(`🔎 2018 起跟 fin_deep 對表:${c.n.toLocaleString()} 個(股·季)・季營收差 ≤ 2% 的 ${c.pct.toFixed(1)}%(差最多的幾個 ${JSON.stringify(c.worst)})・「營收加速」旗標兩邊都有答案 ${c.fBoth.toLocaleString()} 次、一致 ${c.flagPct.toFixed(1)}%`);
if (c.n < 10000 || c.fBoth < 10000 || c.flagPct < 95) { console.error(`❌ 旗標一致只有 ${c.flagPct.toFixed(1)}%(${c.fBoth} 次)→ ⛔ 不寫檔(拿對不上的資料回測 = 結論全錯)`); process.exit(1); }
fs.writeFileSync(OUT, JSON.stringify(F16));
console.log(`💾 ${OUT}`);
}

function mainFin() {
    const [, DIR, FDP, OUT] = process.argv.slice(2);
    if (!DIR || !FDP || !OUT) { console.error('用法:node scripts/fin16_build.mjs --fin <stock_deep 目錄> <fin_deep.json> <輸出>'); process.exit(1); }
    const want = wantMap(), tables = {}, cnt = {};
    for (const t of ['fis10', 'fbs10', 'fcf10']) {
        const d = path.join(DIR, t); tables[t] = {}; cnt[t] = { files: 0, data: 0, bad: 0 };
        if (!fs.existsSync(d)) continue;
        for (const fn of fs.readdirSync(d).filter(x => /^\w+\.json\.gz$/.test(x))) {
            cnt[t].files++;
            let j; try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(d, fn))).toString('utf8')); } catch (_) { cnt[t].bad++; continue; }
            if (j && Array.isArray(j.d) && j.d.length) { tables[t][fn.replace(/\.json\.gz$/, '')] = j; cnt[t].data++; }
        }
    }
    const FD = JSON.parse(fs.readFileSync(FDP, 'utf8'));
    const { F, chk, first, worst } = mergeFin(tables, FD, want);
    for (const [t, c] of Object.entries(cnt)) console.log(`📂 ${t}:${c.files} 檔(有資料 ${c.data}、讀不成 ${c.bad})`);
    console.log(`📅 每個欄位最早:${JSON.stringify(first)}`);
    console.log(`🔎 重疊季對表(差 ≤ 0.5%):${Object.entries(chk).map(([k, v]) => `${k} ${v.pct}%(${v.n})`).join(' ・')}`);
    if (worst.length) console.log(`   差最多的幾個 [代號, 季, 欄位, stock_deep, fin_deep]:${JSON.stringify(worst)}`);
    const n = Object.keys(F.s).length;
    console.log(`📦 ${n} 檔 ・${F.q[0]} ~ ${F.q[F.q.length - 1]}(${F.q.length} 季)・欄位 ${F.f.join(',')}`);
    const low = Object.entries(chk).filter(([, v]) => v.n >= 200 && v.pct < 95);
    if (!Object.keys(chk).length || low.length) { console.error(`❌ 對表沒過(${low.map(([k, v]) => `${k} ${v.pct}%`).join('、') || '一格都沒得比'})→ ⛔ 不寫檔`); process.exit(1); }
    F.meta = { built: new Date().toISOString().slice(0, 10), n, start: F.q[0], first, chk,
        src: 'stock_deep fis10/fbs10/fcf10(2010~2017)+ fin_deep(2018 起)', fd_updated: FD.meta && FD.meta.updated,
        caveat: '值照 FinMind 原樣(現金流量表累計,用 lib_fundamentals 還原單季);資產負債表 2013 前資料源沒有;可用日照季報法定截止日' };
    fs.writeFileSync(OUT, JSON.stringify(F));
    console.log(`💾 ${OUT}`);
}
