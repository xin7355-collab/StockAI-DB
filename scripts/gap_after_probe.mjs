#!/usr/bin/env node
/**
 * 🌅 V78.5.4 「開盤落在哪一段 → 那天開盤到收盤怎麼走」—— 這檔自己的歷史穩不穩?
 *
 * 使用者要的開盤卡:漲停鎖住 / 開高 ≥3% / 平盤 ±3% 內 / 開低 ≥3% / 跌停,每一列用「這檔過去」
 * 告訴他「開完之後收盤比開盤高還是低」(拿來決定開盤賣還是收盤賣,只當參考)。
 * ⚠️ 本站多次實測「每一檔挑自己的做法」≈ 隨機(perstock_playbook / perstock_exit / perstock_indicator)
 *   → 先量:拿這檔「前一年」的開→收方向,猜它「下一年」同一桶的方向,有沒有比「一般股票」準。
 *
 * 定義(⛔ 跟 index.html `_gapStats` / `gap_base.mjs` 同一條):
 *   跳空 = 開盤 ÷ 前一根收盤 − 1;|跳空| > 11% 剔除;鎖漲停 = 開盤 ≥ floorTick(前收×1.1);鎖跌停 = 開盤 ≤ ceilTick(前收×0.9)
 *   桶:lu 漲停鎖住 ・hi 開高 ≥3%(不含 lu)・flat ±3% 內 ・lo 開低 ≥3%(不含 ld)・ld 跌停
 *   開→收 = 收盤 ÷ 開盤 − 1(當天,⛔ 只用那一根);lu 另記「收盤還鎖著」= 收盤 ≥ 同一個漲停價
 * 窗口:2015-06-01 之後(漲跌幅 7% → 10%);每檔切成連續 250 根一段,前一段學、下一段驗。
 *
 * 用法:DATA_DIR=<修好的日 K> NAMES=<stock_names.json> node scripts/gap_after_probe.mjs out.json
 *       node scripts/gap_after_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { floorTick, ceilTick } from './gap_base.mjs';

export const TH = 3, MIN_N = 10, SEG = 250, FROM = '2015-06-01';
export const BUCKETS = ['lu', 'hi', 'flat', 'lo', 'ld'];

/** 一根 K(含前一根收盤)→ {b, oc, lock}(⛔ 只用自己與前一根) */
export function classify(prev, bar, th = TH) {
    const p = +prev.close, o = +bar.open, c = +bar.close;
    if (!(p > 0 && o > 0 && c > 0)) return null;
    const g = (o / p - 1) * 100;
    if (Math.abs(g) > 11) return null;
    const up = floorTick(p * 1.1), dn = ceilTick(p * 0.9);
    const lu = o >= up - 1e-9, ld = o <= dn + 1e-9;
    const b = lu ? 'lu' : ld ? 'ld' : g >= th ? 'hi' : g <= -th ? 'lo' : 'flat';
    return { b, g, oc: (c / o - 1) * 100, lock: lu ? c >= up - 1e-9 : ld ? c <= dn + 1e-9 : null };
}

export function rowsOf(bars, from = FROM) {
    const out = [];
    for (let i = 1; i < bars.length; i++) {
        const d = String(bars[i].date || '').replace(/\//g, '-');
        if (d < from) continue;
        const r = classify(bars[i - 1], bars[i]);
        if (r) { r.d = d; out.push(r); }
    }
    return out;
}

/** 一段 → 每桶 {n, up, dn, sum, lock} */
export function agg(rows) {
    const A = {};
    for (const k of BUCKETS) A[k] = { n: 0, up: 0, dn: 0, sum: 0, lock: 0 };
    for (const r of rows) {
        const a = A[r.b]; a.n++; a.sum += r.oc;
        if (r.oc > 0) a.up++; else if (r.oc < 0) a.dn++;
        if (r.lock) a.lock++;
    }
    return A;
}
const mean = a => a.n ? a.sum / a.n : null;
const sgn = x => x > 0 ? 1 : x < 0 ? -1 : 0;

function selftest() {
    const fails = [];
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) fails.push(n); };
    const P = { close: 100 };
    ok('① 開高 4% 收在開盤下 → hi 且 oc<0', (() => { const r = classify(P, { open: 104, close: 101 }); return r.b === 'hi' && r.oc < 0; })());
    ok('② 開盤 110 = 鎖漲停 → lu;收 110 → lock', (() => { const r = classify(P, { open: 110, close: 110 }); return r.b === 'lu' && r.lock === true; })());
    ok('③ 鎖漲停打開收 105 → lock false', classify(P, { open: 110, close: 105 }).lock === false);
    ok('④ 開盤 90 = 跌停 → ld', classify(P, { open: 90, close: 92 }).b === 'ld');
    ok('⑤ ±3% 內 → flat、−3% 整 → lo', classify(P, { open: 102.9, close: 103 }).b === 'flat' && classify(P, { open: 97, close: 97 }).b === 'lo');
    ok('⑥ |跳空| > 11% 剔除', classify(P, { open: 130, close: 130 }) === null);
    // ⑦ 注入固定開高回落:hi 那一桶量到下跌比例 100%
    const bars = [{ date: '2020-01-01', close: 100, open: 100 }];
    for (let i = 0; i < 40; i++) { const p = bars.at(-1).close; bars.push({ date: `2020-02-${String(i + 1).padStart(2, '0')}`, open: +(p * 1.05).toFixed(2), close: +(p * 1.02).toFixed(2) }); }
    const A = agg(rowsOf(bars, '2000-01-01'));
    ok('⑦ 注入開高回落 → hi 桶 100% 收盤比開盤低', A.hi.n === 40 && A.hi.dn === 40, JSON.stringify(A.hi));
    // ⑧ 前視:改最後一根不影響前面分類
    const r1 = rowsOf(bars, '2000-01-01').slice(0, 5).map(r => r.b + r.oc.toFixed(3)).join();
    bars[bars.length - 1].close = 1; const r2 = rowsOf(bars, '2000-01-01').slice(0, 5).map(r => r.b + r.oc.toFixed(3)).join();
    ok('⑧ 每一根只用自己與前一根', r1 === r2);
    ok('⑨ FROM 之前的不算', rowsOf([{ date: '2014-01-01', close: 100 }, { date: '2014-01-02', open: 105, close: 104 }]).length === 0);
    console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ SELFTEST_PASS');
    process.exit(fails.length ? 1 : 0);
}

function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const DIR = process.env.DATA_DIR || 'data';
    const NAMES = process.env.NAMES || path.join(DIR, 'stock_names.json');
    const out = process.argv[2] || 'gap_after.json';
    let names; try { names = JSON.parse(fs.readFileSync(NAMES, 'utf8')).names; } catch (_) { console.error('❌ 讀不到 stock_names.json'); process.exit(1); }
    const pairs = { lu: [], hi: [], flat: [], lo: [], ld: [] };   // 每一對 = {learnMean, testMean, learnN, testN}
    const pool = {};                                                // 每一段的編號(由新到舊 0,1,2…)→ 全市場合計(當「一般股票」)
    const all = agg([]);
    const byYear = {};                                              // 年 → 全市場每桶(看「一般股票」的方向逐年是不是同一邊)
    let syms = 0, lastD = '';
    const segsBySym = [];
    for (const f of fs.readdirSync(DIR)) {
        const m = f.match(/^(\d{4})\.json$/); if (!m || m[1].startsWith('0')) continue;
        const v = names[m[1]]; const mkt = Array.isArray(v) ? String(v[2] || '') : '';
        if (mkt !== 'twse' && mkt !== 'tpex') continue;
        let bars; try { bars = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(bars)) continue;
        const R = rowsOf(bars);
        if (R.length && R[R.length - 1].d > lastD) lastD = R[R.length - 1].d;
        for (const r of R) { const y = r.d.slice(0, 4); const Y = byYear[y] = byYear[y] || agg([]); const a = Y[r.b]; a.n++; a.sum += r.oc; if (r.oc > 0) a.up++; else if (r.oc < 0) a.dn++; if (r.lock) a.lock++; }
        if (R.length < SEG * 2) continue;
        syms++;
        const segs = [];
        for (let e = R.length; e - SEG >= 0; e -= SEG) segs.push(agg(R.slice(e - SEG, e)));   // segs[0] = 最近那段
        segs.forEach((A, k) => { pool[k] = pool[k] || agg([]); for (const b of BUCKETS) for (const x of ['n', 'up', 'dn', 'sum', 'lock']) { pool[k][b][x] += A[b][x]; all[b][x] += A[b][x]; } });
        segsBySym.push(segs);
    }
    if (syms < 500) { console.error(`❌ 只有 ${syms} 檔有兩年以上 —— 樣本不夠`); process.exit(1); }
    // 前一段(k+1)學 → 下一段(k)驗
    const res = {};
    for (const b of BUCKETS) {
        let nPair = 0, ownHit = 0, genHit = 0, ownGain = 0, genGain = 0, sumL = 0, sumT = 0, sumLL = 0, sumTT = 0, sumLT = 0;
        for (const segs of segsBySym) {
            for (let k = 0; k + 1 < segs.length; k++) {
                const L = segs[k + 1][b], T = segs[k][b];
                if (L.n < MIN_N || T.n < MIN_N) continue;
                const mL = mean(L), mT = mean(T);
                // 一般股票 = 同一個「前一段」的全市場合計(⛔ 不拿驗證那段,零前視)
                const G = pool[k + 1][b]; const mG = (G.sum - L.sum) / Math.max(1, G.n - L.n);
                nPair++;
                if (sgn(mL) === sgn(mT)) ownHit++;
                if (sgn(mG) === sgn(mT)) genHit++;
                // 照前一段的方向決定「抱到收盤(+)還是開盤就賣(−)」,下一段實際多賺多少(相對於固定一種)
                ownGain += sgn(mL) * mT; genGain += sgn(mG) * mT;
                sumL += mL; sumT += mT; sumLL += mL * mL; sumTT += mT * mT; sumLT += mL * mT;
            }
        }
        const n = nPair;
        const cov = n ? sumLT / n - (sumL / n) * (sumT / n) : 0;
        const vl = n ? sumLL / n - (sumL / n) ** 2 : 0, vt = n ? sumTT / n - (sumT / n) ** 2 : 0;
        const A = all[b];
        res[b] = {
            n: A.n, upPct: A.n ? +(A.up / A.n * 100).toFixed(1) : null, dnPct: A.n ? +(A.dn / A.n * 100).toFixed(1) : null,
            ocMean: A.n ? +(A.sum / A.n).toFixed(3) : null, lockPct: (b === 'lu' || b === 'ld') && A.n ? +(A.lock / A.n * 100).toFixed(1) : null,
            pairs: n, ownHit: n ? +(ownHit / n * 100).toFixed(1) : null, genHit: n ? +(genHit / n * 100).toFixed(1) : null,
            ownGain: n ? +(ownGain / n).toFixed(3) : null, genGain: n ? +(genGain / n).toFixed(3) : null,
            corr: (vl > 0 && vt > 0) ? +(cov / Math.sqrt(vl * vt)).toFixed(3) : null,
        };
    }
    const years = {};
    for (const y of Object.keys(byYear).sort()) { years[y] = {}; for (const b of BUCKETS) { const a = byYear[y][b]; years[y][b] = a.n ? { n: a.n, up: +(a.up / a.n * 100).toFixed(1), dn: +(a.dn / a.n * 100).toFixed(1), oc: +(a.sum / a.n).toFixed(3), lock: a.n ? +(a.lock / a.n * 100).toFixed(1) : null } : null; } }
    const r = { years, src: 'scripts/gap_after_probe.mjs(V78.5.4)', th: TH, minN: MIN_N, seg: SEG, from: FROM, to: lastD, syms, buckets: res };
    console.log(`✅ ${syms} 檔(兩年以上)・${FROM} 起・每段 ${SEG} 根・每桶 ≥${MIN_N} 天才比`);
    for (const b of BUCKETS) {
        const x = res[b];
        const ys = Object.keys(years).map(y => years[y][b]).filter(Boolean);
        const same = ys.filter(z => z.n >= 30 && Math.sign(z.oc) === Math.sign(x.ocMean)).length, tot = ys.filter(z => z.n >= 30).length;
        x.yearsSame = `${same}/${tot}`;
        console.log(`${b.padEnd(4)} 逐年同方向 ${same}/${tot} 年(n≥30)`);
        console.log(`     n=${String(x.n).padStart(7)} 收>開 ${x.upPct}% 收<開 ${x.dnPct}% 平均開→收 ${x.ocMean}%${x.lockPct != null ? ` 收盤還鎖 ${x.lockPct}%` : ''} | 配對 ${x.pairs} 方向猜中 這檔 ${x.ownHit}% vs 一般 ${x.genHit}% ・照著做多賺 這檔 ${x.ownGain}% vs 一般 ${x.genGain}% ・前後相關 ${x.corr}`);
    }
    fs.writeFileSync(out, JSON.stringify(r, null, 1));
}

main();
