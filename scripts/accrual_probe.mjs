#!/usr/bin/env node
/**
 * 💵 盈餘品質(應計項目)有沒有用 —— V79.0.6(外部評估㊾ mjib007/taiwan-stock-cashflow-api 的現金流規則)
 *
 * 那個 repo 把 6 條現金流規則加成一個分數 → ⛔ 本站不做分數(陷阱 #38)。
 * 但它背後的**現象**本站沒測過:「帳上賺的錢,有沒有變成現金」。
 *   應計比率 = (近 4 季稅後淨利 − 近 4 季營業現金流)÷ 股東權益
 *   ・很低(現金比帳上賺的還多)= 盈餘品質好
 *   ・很高(帳上賺很多、現金沒進來)= 盈餘品質差(學術上叫 Sloan 應計異常)
 *
 * 口徑:
 *   ・每月第一個交易日重新排一次(⛔ 法定截止日全市場同一天 → 用公布日當事件會擠成一年 4 個點)
 *   ・那一天只用**已經公布**的季報(可用日 = 法定截止日 5/15・8/14・11/14・3/31,而且要**嚴格早於**排名日)
 *   ・營業現金流是**累計**欄 → `lib_fundamentals.quarterValue` 還原單季(⛔ 不憑印象)
 *   ・淨利走 `lib_value.valueSeries`(官方淨利優先、面額變更那一季起不給)
 *   ・近 4 季要**連續**(缺一季就不算)・股東權益 ≤0 不算 ・金融保險(產業 17)排除(營業現金流對銀行沒意義)
 *   ・隔天開盤買,抱 20 / 60 天;隔天開在漲停附近剔除
 *   ・對照 = **同一天有排名的全部股票**(⛔ 不是全市場:量的是「排序」本身)
 *   ・和 value_probe 的「四項同升」(earn)比:是不是同一件事
 *
 * 用法:DATA_DIR=<日K> FIN_DEEP=<fin_deep.json> AUX_DIR=<有 industry_map.json> node scripts/accrual_probe.mjs [out.json]
 *       node scripts/accrual_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { quarterValue } from './lib_fundamentals.mjs';
import { valuePrep, valueSeries } from './lib_value.mjs';
import { baseAdd, increments, gates, negate, fmtG } from './lib_evgate.mjs';

const HOLDS = [20, 60], HI = 0, NQ = 5, MINY = 6;
const D = s => String(s || '').slice(0, 10).replace(/\//g, '-');

/** 一檔 → 依公布日排序的 [{p, pub, acc, earn}](acc 算不出來就不放) */
export function accrualSeries(FD, sym, P) {
    const ser = valueSeries(FD, sym, P); if (!ser) return [];
    const byP = new Map(ser.map(q => [q.p, q]));
    const qs = FD.q, iEq = P.I.eq, rec = FD.s[sym] || {};
    const out = [];
    for (const q of ser) {
        const k = qs.indexOf(q.p); if (k < 3) continue;
        let ni = 0, ocf = 0, ok = true;
        for (let j = k - 3; j <= k; j++) {
            const r = byP.get(qs[j]);
            const o = quarterValue(FD, sym, qs[j], 'ocf', P.CUM);
            if (!r || !Number.isFinite(r.ni) || o == null || !Number.isFinite(+o)) { ok = false; break; }
            ni += r.ni; ocf += +o;
        }
        const eq = +((rec[q.p] || [])[iEq]);
        if (!ok || !(eq > 0)) continue;
        out.push({ p: q.p, pub: q.pub, acc: (ni - ocf) / eq * 100, earn: Number.isFinite(q.nImp) ? q.nImp >= 1 : null });
    }
    return out.sort((a, b) => a.pub < b.pub ? -1 : 1);
}

/** 排名日那天「已經公布」的最後一季(⛔ 公布日要嚴格早於排名日) */
export const knownBefore = (ser, day) => { let best = null; for (const x of ser) { if (x.pub < day) best = x; else break; } return best; };

/** universe: [{sym, rows}];ACC: Map sym → accrualSeries → {Q: [[{d,r}] per hold] × NQ, base, earnShare, qNoEarn, months} */
export function run(universe, ACC) {
    const cal = [...new Set(universe.flatMap(u => u.rows.map(r => D(r.date))))].sort();
    const reb = cal.filter((d, i) => i > 0 && d.slice(0, 7) !== cal[i - 1].slice(0, 7));
    const idx = new Map(universe.map(u => [u.sym, new Map(u.rows.map((r, i) => [D(r.date), i]))]));
    const base = HOLDS.map(() => new Map()), Q = Array.from({ length: NQ }, () => HOLDS.map(() => [])), QNE = HOLDS.map(() => []);
    const earnCnt = Array.from({ length: NQ }, () => ({ y: 0, n: 0 }));
    const skip = { lock: 0, noAcc: 0 };
    let months = 0;
    for (const g of reb) {
        const pool = [];
        for (const u of universe) {
            const i = idx.get(u.sym).get(g); if (i == null || i + 1 >= u.rows.length) continue;
            const x = knownBefore(ACC.get(u.sym) || [], g); if (!x) { skip.noAcc++; continue; }
            const c0 = +u.rows[i].close, e = +u.rows[i + 1].open;
            if (!(c0 > 0) || !(e > 0)) continue;
            if (e >= c0 * 1.095) { skip.lock++; continue; }
            const rets = HOLDS.map(H => { const r = u.rows[i + H]; return r && +r.close > 0 ? (+r.close / e - 1) * 100 : null; });
            pool.push({ acc: x.acc, earn: x.earn, rets });
        }
        if (pool.length < NQ * 20) continue;
        months++;
        pool.sort((a, b) => a.acc - b.acc);
        pool.forEach((x, k) => {
            const qi = Math.min(NQ - 1, Math.floor(k * NQ / pool.length));
            x.rets.forEach((r, h) => { if (r == null) return; baseAdd(base[h], g, r); Q[qi][h].push({ d: g, r }); if (qi === 0 && x.earn === false) QNE[h].push({ d: g, r }); });
            if (x.earn != null) { earnCnt[qi].n++; if (x.earn) earnCnt[qi].y++; }
        });
    }
    return { Q, QNE, base, earnCnt, skip, months };
}

function main() {
    const DIR = process.env.DATA_DIR || 'data', FIN = process.env.FIN_DEEP, AUX = process.env.AUX_DIR || DIR;
    let FD; try { FD = JSON.parse(fs.readFileSync(FIN, 'utf8')); } catch (e) { console.log(`❌ 讀不到 FIN_DEEP(${FIN}):${e.message}`); process.exit(1); }
    let IND = {}; try { IND = JSON.parse(fs.readFileSync(path.join(AUX, 'industry_map.json'), 'utf8')); } catch (e) { console.log(`⚠️ 讀不到 industry_map.json → 金融股沒排除(${e.message})`); }
    const P = valuePrep(FD);
    const U = [], ACC = new Map(); let nFin = 0;
    for (const f of fs.readdirSync(DIR).filter(f => /^[1-9]\d{3}\.json$/.test(f))) {
        const sym = f.slice(0, 4);
        if (String(IND[sym] || '') === '17') { nFin++; continue; }
        if (!FD.s[sym]) continue;
        let rows; try { const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); rows = Array.isArray(j) ? j : (j.data || []); } catch { continue; }
        if (rows.length < 260) continue;
        const a = accrualSeries(FD, sym, P); if (!a.length) continue;
        U.push({ sym, rows }); ACC.set(sym, a);
    }
    if (U.length < 300) { console.log(`❌ 有財報又有 K 線的只有 ${U.length} 檔(<300),停`); process.exit(1); }
    const t0 = Date.now();
    const R = run(U, ACC);
    const accs = [...ACC.values()].flatMap(a => a.map(x => x.acc)).sort((a, b) => a - b);
    const pct = q => accs[Math.floor(q * (accs.length - 1))];
    console.log(`📦 ${U.length} 檔(排除金融 ${nFin} 檔)・每月排一次 ${R.months} 個月 ・營業現金流累計欄已還原單季`);
    console.log(`   應計比率分布(% of 權益):P10 ${pct(0.1).toFixed(1)} ・P50 ${pct(0.5).toFixed(1)} ・P90 ${pct(0.9).toFixed(1)} ・漲停買不到剔除 ${R.skip.lock}`);
    const out = { meta: { syms: U.length, months: R.months, holds: HOLDS, nq: NQ, secs: 0 }, q: [] };
    console.log(`\n💵 五等分(1 = 現金比帳上多 … 5 = 帳上賺、現金沒進來);增量 = 比同一天有排名的全部股票多幾 %`);
    for (const h of [0, 1]) {
        console.log(`  ── 抱 ${HOLDS[h]} 天 ──`);
        for (let k = 0; k < NQ; k++) {
            const g = gates(increments(R.Q[k][h], R.base[h]), undefined, MINY);
            if (h === 0) out.q.push({ k: k + 1, d: g.d, p: g.p, nPass: g.nPass, YR: g.YR, H: g.H, earnShare: R.earnCnt[k].n ? R.earnCnt[k].y / R.earnCnt[k].n : null });
            else out.q[k].d60 = g.d;
            console.log('  ' + fmtG(`第 ${k + 1} 等分` + (k === 0 ? '(品質好)' : k === NQ - 1 ? '(品質差)' : ''), g));
        }
    }
    console.log(`\n🔻 當避雷(之後比較差 → 增量取負號再過六關;⑤ 要差到超過成本 0.44 才算數)`);
    out.avoid = {};
    for (const [nm, ks] of [['第 4 等分', [3]], ['第 5 等分', [4]], ['第 4+5 等分(應計最高 40%)', [3, 4]]]) {
        for (const h of [0, 1]) {
            const ev = ks.flatMap(k => R.Q[k][h]);
            const gn = gates(negate(increments(ev, R.base[h])), undefined, MINY);
            out.avoid[`${nm}|${HOLDS[h]}`] = { d: -gn.d, nPass: gn.nPass, YR: gn.YR.map(y => ({ y: y.y, d: -y.d })) };
            console.log(`  ${(nm + ' 抱 ' + HOLDS[h] + ' 天').padEnd(28)} 之後少 ${(-gn.d).toFixed(2)}pp ・當避雷 ${gn.nPass}/6 ・逐年 ${gn.YR.map(y => y.y.slice(2) + ':' + (-y.d).toFixed(2)).join(' ')}`);
        }
    }
    // ⚠️ 每月排一次、抱 60 天 → 相鄰三個月的持有期重疊,t 檢定會被灌水 → 改用「每三個月取一次」的三組各自檢定(互不重疊)
    console.log(`\n🧮 去掉重疊:抱 60 天只取每 3 個月一次(三種起點各自算,互不重疊)`);
    out.noOverlap = [];
    { const ds = [...R.base[1].keys()].sort();
      for (const ph of [0, 1, 2]) {
          const keep = new Set(ds.filter((_, i) => i % 3 === ph));
          const pick = arr => arr.filter(e => keep.has(e.d));
          const base = new Map([...R.base[1]].filter(([d]) => keep.has(d)));
          const gA = gates(negate(increments(pick([...R.Q[3][1], ...R.Q[4][1]]), base)), undefined, 2);
          const gL = gates(increments(pick(R.Q[0][1]), base), undefined, 2);
          out.noOverlap.push({ ph, avoid: { d: -gA.d, p: gA.p, nPass: gA.nPass }, lo: { d: gL.d, p: gL.p, nPass: gL.nPass } });
          console.log(`  起點 ${ph}:應計最高 40% 之後少 ${(-gA.d).toFixed(2)}pp p=${gA.p.toFixed(3)} ・品質好那組 ${gL.d >= 0 ? '+' : ''}${gL.d.toFixed(2)}pp p=${gL.p.toFixed(3)}(${gA.nDays} 個月)`);
      } }
    const lo = gates(increments(R.Q[0][HI], R.base[HI]), undefined, MINY);
    const hiNeg = gates(negate(increments(R.Q[NQ - 1][HI], R.base[HI])), undefined, MINY);
    const loNE = gates(increments(R.QNE[HI], R.base[HI]), undefined, MINY);
    const mono = out.q.every((x, i) => i === 0 || x.d <= out.q[i - 1].d + 0.05);
    console.log(`\n🔁 跟「四項同升」(value_probe earn)是不是同一件事:`);
    out.q.forEach(x => console.log(`   第 ${x.k} 等分 有四項同升的比例 ${x.earnShare == null ? '—' : (x.earnShare * 100).toFixed(1) + '%'}`));
    console.log('   ' + fmtG('第 1 等分・扣掉四項同升的', loNE));
    out.lo = { d: lo.d, nPass: lo.nPass }; out.hiAvoid = { d: -hiNeg.d, nPass: hiNeg.nPass }; out.loNoEarn = { d: loNE.d, nPass: loNE.nPass }; out.mono = mono;
    out.meta.secs = Math.round((Date.now() - t0) / 1000);
    console.log('\n' + '═'.repeat(90));
    console.log(`⭐ 品質好(第 1 等分)抱 ${HOLDS[HI]} 天:增量 ${lo.d.toFixed(2)}pp ・${lo.nPass}/6 ・品質差(第 5 等分)當避雷 ${hiNeg.nPass}/6(增量 ${(-hiNeg.d).toFixed(2)}pp)・五等分${mono ? '' : '⛔ 不'}單調`);
    console.log('⚠️ 限制:財報 2018 起、日K 2021 起 ・可用日用法定截止日(保守)・倖存者偏誤 ・不含息 ・金融股排除');
    const f = process.argv.slice(2).find(a => a.endsWith('.json'));
    if (f) { fs.writeFileSync(f, JSON.stringify(out, null, 1)); console.log(`💾 ${f}`); }
}

// ═══════════ 自我測試 ═══════════
function selftest() {
    let bad = 0;
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) bad++; };
    const F = ['inv', 'cogs', 'capex', 'dep', 'ocf', 'rev', 'eq', 'cap', 'eps', 'ni', 'opi'];
    const QS = []; for (let y = 2019; y <= 2026; y++) for (const m of ['03-31', '06-30', '09-30', '12-31']) QS.push(`${y}-${m}`);
    // ocf 是累計(Q1 單季,Q2 = Q1+Q2 …)
    const mkSym = (niQ, ocfQ) => { const s = {}; let cum = 0; for (const q of QS) { if (q.slice(5, 7) === '03') cum = 0; cum += ocfQ; s[q] = [0, 60, -1, 1, cum, 100, 1000, 100, niQ / 10, niQ, niQ]; } return s; };
    const FD = { q: QS, f: F, s: {} };
    for (let k = 0; k < 150; k++) FD.s[String(1100 + k)] = mkSym(10, 10 + (k % 5) * 5 - 10);   // ni 10/季,ocf 0~20/季
    const P = valuePrep(FD);
    const a = accrualSeries(FD, '1104', P), x = a.find(q => q.p === '2022-06-30');
    ok('① 累計的營業現金流有還原成單季(ni 40 − ocf 80)÷1000 = −4%', x && Math.abs(x.acc + 4) < 1e-9, x && x.acc);
    ok('② 第 4 季之前湊不滿 4 季 → 不算', !a.some(q => q.p < '2019-12-31'));
    const kb = knownBefore(a, '2022-08-14'), kb2 = knownBefore(a, '2022-08-15');
    ok('③ 法定截止日當天 ⛔ 還不能用(要嚴格早於)', kb && kb.p === '2022-03-31' && kb2 && kb2.p === '2022-06-30', `${kb && kb.p} / ${kb2 && kb2.p}`);
    // 市場:每檔每月開盤都在 100 附近隨機,注入:應計最低那組(k%5==4 → ocf 20 → acc 最低)每天多漲 0.1%
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const days = []; { const d = new Date(Date.UTC(2021, 0, 4)); while (days.length < 1200) { if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } }
    const mkU = edge => Object.keys(FD.s).map((sym, k) => { let p = 100; return { sym, rows: days.map(d => { const op = p * (1 + (rnd() - 0.5) * 0.004); p = op * (1 + (rnd() - 0.5) * 0.03 + (edge && k % 5 === 4 ? edge : 0)); return { date: d, open: op, high: Math.max(op, p), low: Math.min(op, p), close: p, volume: 1000 }; }) }; });
    const ACC = new Map(Object.keys(FD.s).map(s => [s, accrualSeries(FD, s, P)]));
    const R1 = run(mkU(0.001), ACC), g1 = gates(increments(R1.Q[0][0], R1.base[0]), undefined, MINY);
    ok('④ 注入「現金比帳上多」那組每天多 0.1% → 第 1 等分量到明顯正的增量', g1.d > 1 && g1.p < 0.01, `${g1.d.toFixed(2)} p=${g1.p}`);
    const R0 = run(mkU(0), ACC), g0 = gates(increments(R0.Q[0][0], R0.base[0]), undefined, MINY);
    ok('⑤ 純隨機 → ⛔ 不可六關全過', g0.nPass < 6 && Math.abs(g0.d) < 1, `${g0.d.toFixed(2)} ${g0.nPass}`);
    console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ SELFTEST_PASS');
    process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest(); else main();
