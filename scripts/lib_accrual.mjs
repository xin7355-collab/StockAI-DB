/**
 * 💵 盈餘品質(應計比率)—— 全 repo 唯一一份公式(V79.0.7 從 accrual_probe 搬出來)
 *   應計比率 = (近 4 季稅後淨利 − 近 4 季營業現金流)÷ 股東權益 × 100
 *   ・營業現金流是累計欄 → lib_fundamentals.quarterValue 還原單季
 *   ・淨利走 lib_value.valueSeries(官方淨利優先、面額變更那一季起不給)
 *   ・近 4 季要連續、權益 ≤0 不算
 *   ・可用日 = 法定截止日,而且要**嚴格早於**使用日(knownBefore)
 * 用的人:accrual_probe.mjs(事件層級)・portfolio_backtest.mjs ACCR=(🔥 組合層)・leader_probe.mjs accAvoid(👑 組合層)
 */
import { quarterValue } from './lib_fundamentals.mjs';
import { valueSeries } from './lib_value.mjs';

/** 一檔 → 依公布日排序的 [{p, pub, acc, earn}](acc 算不出來就不放);P = valuePrep(FD) */
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

/** 使用日那天「已經公布」的最後一季(⛔ 公布日要嚴格早於使用日) */
export const knownBefore = (ser, day) => { let best = null; for (const x of ser || []) { if (x.pub < day) best = x; else break; } return best; };

/**
 * 「應計最高 X%」的月門檻(跟 accrual_probe 的五等分同一個切法:排序後第 k 名,k ≥ q·n 屬於最高那段)
 * ACC: Map sym → accrualSeries(呼叫端先排除金融股)。回 (day) → {cut, n} | null(那個月有資料的不到 minN 檔)
 * ⭐ 用每個月 1 號當使用日:法定截止日(3/31・5/15・8/14・11/14)不會落在 1~3 號 → 跟「月初第一個交易日」完全等價
 */
export function accrualMonthCut(ACC, q = 0.6, minN = 100) {
    const memo = new Map();
    return day => {
        const m = String(day).slice(0, 7) + '-01';
        if (!memo.has(m)) {
            const v = [];
            for (const ser of ACC.values()) { const x = knownBefore(ser, m); if (x) v.push(x.acc); }
            v.sort((a, b) => a - b);
            memo.set(m, v.length >= minN ? { cut: v[Math.ceil(q * v.length)] ?? Infinity, n: v.length, m } : null);
        }
        return memo.get(m);
    };
}

/** 這一檔在 day 那個月是不是「應計最高 X%」:true / false / null(不知道:沒有季報或那個月樣本不足) */
export function accrualHiAt(ACC, cutFn, sym, day) {
    const c = cutFn(day); if (!c) return null;
    const x = knownBefore(ACC.get(sym), c.m); if (!x) return null;
    return x.acc >= c.cut;
}
