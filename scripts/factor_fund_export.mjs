#!/usr/bin/env node
/**
 * 📦 變因研究的「基本面那幾欄」匯出器(V79.3.8)—— 只是把既有的唯一定義攤平成每季一列,⛔ 不重新定義任何公式
 *
 * 為什麼要有這支:變因面板 `factor_panel.py` 是 Python,而基本面公式住在 JS 的
 *   `lib_value.valueSeries`(ROE4 / 營收・毛利・EPS・自由現金流 年增 / 每股淨值 / 面額變更守門)、
 *   `lib_finaccel.finSeries`(營收年增加速)、`lib_accrual.accrualSeries`(應計比率)
 *   → 在 Python 再寫一份 = 兩份真相(陷阱 #37)。所以這裡只呼叫它們、照公布日(法定截止日)排序輸出。
 *
 * 輸出:{asof, cols:[...], s:{代號:[[pub, p, ...cols]]}} —— pub = 那一季「可以用」的日子(lib_fundamentals.pubDate);
 *   面板照「pub 嚴格早於使用日」取最後一季(跟 accrual 的 knownBefore 同一個規則,⛔ 不可 ≤)。
 *
 * 跑法:FIN_DEEP=…/fin_deep.json node scripts/factor_fund_export.mjs out.json
 *       node scripts/factor_fund_export.mjs --selftest
 */
import fs from 'node:fs';
import { valuePrep, valueSeries } from './lib_value.mjs';
import { finSeries } from './lib_finaccel.mjs';
import { accrualSeries } from './lib_accrual.mjs';

export const COLS = ['roe4', 'revY', 'gmY', 'epsY', 'fcfY', 'revQ', 'gmQ', 'ttmPos12', 'nImp', 'nDet', 'bvps', 'eps', 'ni', 'rev', 'gm', 'fcf', 'acc', 'yoyAcc', 'eps4'];
const fin = v => (v == null || !Number.isFinite(+v)) ? null : Math.round(+v * 1e4) / 1e4;

/** 一檔 → [[pub, p, ...COLS]];沒有回 []。eps4 = 近 4 季 EPS 加總(本益比要用;面額變更那一季起 = null,同 valueSeries 的 par 守門) */
export function exportOne(FD, sym, P) {
    const ser = valueSeries(FD, sym, P); if (!ser || !ser.length) return [];
    const fa = new Map((finSeries(FD, sym) || []).map(q => [q.p, q]));
    const ac = new Map((accrualSeries(FD, sym, P) || []).map(q => [q.p, q]));
    const I = P.I, rec = FD.s[sym] || {};
    const qs = Object.keys(rec).sort();
    const epsOf = q => { const v = (rec[q] || [])[I.eps]; return (v == null || !Number.isFinite(+v)) ? NaN : +v; };
    const out = [];
    for (const q of ser) {
        const k = qs.indexOf(q.p);
        let eps4 = NaN;
        if (k >= 3 && !q.par) { let s = 0, ok = true; for (let j = k - 3; j <= k; j++) { const e = epsOf(qs[j]); if (!Number.isFinite(e)) { ok = false; break; } s += e; } if (ok) eps4 = s; }
        const f = fa.get(q.p), a = ac.get(q.p);
        const row = { ...q, eps: q.par ? NaN : epsOf(q.p), acc: a ? a.acc : NaN, yoyAcc: f ? f.acc : NaN, eps4 };
        out.push([q.pub, q.p, ...COLS.map(c => fin(row[c]))]);
    }
    return out;
}

function selftest() {
    const bad = [];
    const ok = (name, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${name}${c ? '' : ' ・' + JSON.stringify(x).slice(0, 200)}`); if (!c) bad.push(name); };
    // 合成 fin_deep:9 季、營收每季 +10%、EPS 每季 1、ocf/capex 是累計欄(年內累加)
    const q = ['2018-03-31', '2018-06-30', '2018-09-30', '2018-12-31', '2019-03-31', '2019-06-30', '2019-09-30', '2019-12-31', '2020-03-31'];
    const f = ['inv', 'cogs', 'capex', 'dep', 'ocf', 'rev', 'eq', 'cap', 'eps', 'ni', 'opi'];
    const s = { '9999': {} };
    let cumO = 0, cumC = 0;
    q.forEach((p, i) => {
        if (p.endsWith('03-31')) { cumO = 0; cumC = 0; }
        cumO += 50; cumC += -20;
        const rev = 1000 * Math.pow(1.1, i);
        s['9999'][p] = [0, rev * 0.6, cumC, 0, cumO, rev, 10000, 1000, 1, 100, 0];
    });
    const FD = { q, f, s };
    const P = valuePrep(FD);
    const rows = exportOne(FD, '9999', P);
    ok('① 每一季一列、依公布日排序、pub 是法定截止日(⛔ 不是季底)', rows.length === q.length && rows[0][0] === '2018-05-15' && rows.every((r, i) => !i || r[0] >= rows[i - 1][0]), rows.map(r => r[0]));
    const C = Object.fromEntries(COLS.map((c, i) => [c, i + 2]));
    const last = rows[rows.length - 1];
    ok('② 營收年增 = valueSeries 的 revY(+46.41%)', Math.abs(last[C.revY] - 46.41) < 0.01, last[C.revY]);
    ok('② 近 4 季 EPS 加總 = 4', last[C.eps4] === 4, last[C.eps4]);
    ok('② ROE4 = 近 4 季淨利 400 ÷ 權益 10000 = 4%', Math.abs(last[C.roe4] - 4) < 1e-6, last[C.roe4]);
    ok('② 應計 = (淨利 400 − 營業現金流 200)÷ 10000 = 2%(累計欄有還原成單季)', Math.abs(last[C.acc] - 2) < 1e-6, last[C.acc]);
    ok('② 前 3 季算不出近 4 季 → null(⛔ 不補 0)', rows[0][C.eps4] === null && rows[0][C.roe4] === null, rows[0]);
    // ③ 決定性對照:改來源 → 輸出跟著變(⛔ 不是寫死)
    s['9999']['2020-03-31'][8] = 3;
    const rows2 = exportOne(FD, '9999', P);
    ok('③ 改最後一季 EPS → 近 4 季加總跟著變(6)', rows2[rows2.length - 1][C.eps4] === 6, rows2[rows2.length - 1][C.eps4]);
    console.log(bad.length ? `❌ ${bad.length} 條失敗` : '✅ selftest 全過');
    process.exit(bad.length ? 1 : 0);
}

function main() {
    const out = process.argv[2], src = process.env.FIN_DEEP;
    if (!out || !src) { console.error('用法:FIN_DEEP=fin_deep.json node scripts/factor_fund_export.mjs out.json'); process.exit(1); }
    const FD = JSON.parse(fs.readFileSync(src, 'utf8'));
    const P = valuePrep(FD);
    const res = { asof: new Date().toISOString().slice(0, 10), cols: COLS, s: {} };
    let n = 0, nq = 0;
    for (const sym of Object.keys(FD.s)) { const r = exportOne(FD, sym, P); if (r.length) { res.s[sym] = r; n++; nq += r.length; } }
    if (n < 500) { console.error(`❌ 只匯出 ${n} 檔(< 500)→ fin_deep 讀錯了,⛔ 不寫`); process.exit(1); }
    fs.writeFileSync(out, JSON.stringify(res));
    console.log(`📦 ${n} 檔 ・${nq} 季 → ${out}`);
}

if (process.argv.includes('--selftest')) selftest(); else main();
