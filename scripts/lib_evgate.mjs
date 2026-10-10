/**
 * 🚦 事件探針共用:同一天全部股票當對照 + 六關(V79.0.6,bestfour_probe / accrual_probe 共用)
 *
 * ⭐ 對照 = **同一天**全部股票(同一個持有天數)的平均報酬 → 大盤漲跌自動抵銷,⛔ 不用另扣加權。
 * ⭐ 檢定一律先**每天平均**再做(同一天的事件會一起漲跌,逐筆當獨立樣本 = 灌水)。
 * 六關(同 value_probe / accel_probe):①全期增量 >0 ②前後半同向 ③逐年同向(≥3 年、每年 ≥20 筆)
 *   ④拿掉最好那年仍 >0 ⑤增量 − 成本 0.44 >0 ⑥每日平均的 t 檢定 p ≤0.05
 */
export const COST = 0.44;

const erf = x => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
export const pTwo = z => 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));

/** 同一天的對照平均:base = Map(day → {s, n}) */
export const baseAdd = (base, day, r) => { const b = base.get(day) || { s: 0, n: 0 }; b.s += r; b.n++; base.set(day, b); };
export const baseMean = (base, day) => { const b = base.get(day); return b && b.n ? b.s / b.n : null; };

/** events: [{d, r}](r = 報酬 %)→ 增量(減同一天對照)後,依日期收成每天一個平均 */
export function increments(events, base) {
    const byDay = new Map(); let n = 0;
    for (const e of events) {
        const m = baseMean(base, e.d); if (m == null) continue;
        const a = byDay.get(e.d) || []; a.push(e.r - m); byDay.set(e.d, a); n++;
    }
    const days = [...byDay.keys()].sort();
    return { n, days, dm: days.map(d => { const a = byDay.get(d); return a.reduce((s, x) => s + x, 0) / a.length; }), all: days.flatMap(d => byDay.get(d)) };
}

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const tstat = a => { if (a.length < 3) return 0; const m = mean(a), v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); return v > 0 ? m / Math.sqrt(v / a.length) : 0; };

/** 六關。回 {d, n, nDays, p, H:[前半,後半], YR:[{y,n,d}], dropBest, pass, nPass} */
export function gates(inc, cost = COST, minPerYear = 20) {   // minPerYear:每月一次的訊號一年只有 12 個點 → 呼叫端給 6
    // ⭐ 增量 = **每天平均**的平均(跟檢定、前後半、逐年同一個口徑;⛔ 逐筆平均會讓事件多的那幾天說了算)
    const d = mean(inc.dm), z = tstat(inc.dm), p = pTwo(z);
    const mid = inc.days[Math.floor(inc.days.length / 2)] || '';
    const halfOf = k => { const a = []; inc.days.forEach((dd, i) => { if ((dd < mid) === (k === 0)) a.push(inc.dm[i]); }); return mean(a); };
    const H = [halfOf(0), halfOf(1)];
    const byY = new Map();
    inc.days.forEach((dd, i) => { const y = dd.slice(0, 4); const o = byY.get(y) || { s: 0, n: 0 }; o.s += inc.dm[i]; o.n++; byY.set(y, o); });
    const YR = [...byY.entries()].sort().map(([y, o]) => ({ y, n: o.n, d: o.s / o.n })).filter(x => x.n >= minPerYear);
    let dropBest = NaN;
    if (YR.length >= 3) { const bi = YR.reduce((b, x, i) => x.d > YR[b].d ? i : b, 0); const rest = YR.filter((_, i) => i !== bi); const t = rest.reduce((s, x) => s + x.n, 0); dropBest = rest.reduce((s, x) => s + x.d * x.n, 0) / t; }
    const pass = {
        '①全期': d > 0, '②前後半': H.every(x => x > 0), '③逐年': YR.length >= 3 && YR.every(x => x.d > 0),
        '④去最好年': dropBest > 0, '⑤扣成本': d - cost > 0, '⑥檢定': d > 0 && p <= 0.05,
    };
    return { d, n: inc.n, nDays: inc.days.length, p, H, YR, dropBest, pass, nPass: Object.values(pass).filter(Boolean).length };
}

/** 方向反過來(避雷型訊號):把增量取負號再過六關 —— 「這個訊號之後比較差」要過的是同一套關卡 */
export const negate = inc => ({ ...inc, dm: inc.dm.map(x => -x), all: inc.all.map(x => -x) });

export const fmtG = (name, g) => {
    const s = x => (x >= 0 ? '+' : '') + (Number.isFinite(x) ? x.toFixed(2) : '—');
    return `${name.padEnd(26)} 增量 ${s(g.d).padStart(6)}pp  n=${String(g.n).padStart(6)}(${g.nDays} 天)p=${g.p.toFixed(3)}  前後半 ${s(g.H[0])}/${s(g.H[1])}  逐年 ${g.YR.map(x => x.y.slice(2) + ':' + s(x.d)).join(' ')}  → ${g.nPass}/6`;
};
