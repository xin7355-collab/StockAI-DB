/**
 * 📦 「營收 YoY 加速」的唯一一份定義 —— V77.4.2(accel_probe.mjs 與 portfolio_backtest.mjs 的 FIN= 濾網共用)
 *
 *   季 k:yoy_k = rev_k / rev_{k−4} − 1 ・acc_k = yoy_k − yoy_{k−1} ・gmq_k = 毛利率_k − 毛利率_{k−1} ・epsy_k = eps_k − eps_{k−4}(差值,負 EPS 不用比值)
 *   亮 = yoy_k > 0 ∧ acc_k > 0;變體 +gm(gmq ≥ 0)/ +eps(epsy > 0)
 *   「知道」的那一季 = 最後一個 pubDate(p) ≤ 今天(法定截止日 5/15・8/14・11/14・3/31,保守;`lib_fundamentals.pubDate`)
 *
 * ⛔ 陷阱 #37:回測腳本⛔ 不可自己再寫一份(V77.3.3 週轉率是 lib_turnover、這裡同理);改公式兩邊一起變。
 * 資料 = fin_deep 分支的 `fin_deep.json`({q, f, s});⚠️ 不是 data/fin 的切片(那份只有 12 季)。
 */
import { pubDate } from './lib_fundamentals.mjs';

/** fin_deep 一檔 → 依公布日排序的季序列;每季 {p, pub, yoy, acc, gmq, epsy, ok};沒這檔回 null */
export function finSeries(FD, sym) {
    const rec = FD.s[sym]; if (!rec) return null;
    const I = Object.fromEntries(FD.f.map((k, i) => [k, i]));
    const qs = Object.keys(rec).sort();
    const g = (q, k) => { const v = (rec[q] || [])[I[k]]; return (v == null || !Number.isFinite(+v)) ? NaN : +v; };
    const gm = q => { const r = g(q, 'rev'), cg = g(q, 'cogs'); return r > 0 && Number.isFinite(cg) ? (r - cg) / r * 100 : NaN; };
    const out = [];
    for (let k = 0; k < qs.length; k++) {
        const pub = pubDate(qs[k]); if (!pub) continue;
        const rev = g(qs[k], 'rev'), rev4 = k >= 4 ? g(qs[k - 4], 'rev') : NaN, rev1 = k >= 1 ? g(qs[k - 1], 'rev') : NaN, rev5 = k >= 5 ? g(qs[k - 5], 'rev') : NaN;
        const yoy = rev > 0 && rev4 > 0 ? (rev / rev4 - 1) * 100 : NaN;
        const yoyP = rev1 > 0 && rev5 > 0 ? (rev1 / rev5 - 1) * 100 : NaN;
        const acc = yoy - yoyP;
        const gmq = k >= 1 ? gm(qs[k]) - gm(qs[k - 1]) : NaN;
        const eps = g(qs[k], 'eps'), eps4 = k >= 4 ? g(qs[k - 4], 'eps') : NaN;
        out.push({ p: qs[k], pub, yoy, acc, gmq, epsy: eps - eps4, ok: Number.isFinite(yoy) && Number.isFinite(acc) });
    }
    return out.sort((a, b) => a.pub < b.pub ? -1 : 1);
}

/** 給一天(YYYY-MM-DD),回那天「已經公布」的最後一季;沒有回 null。⭐ 回測要用這支,⛔ 不可拿季別當可用日 */
export function finKnownAt(series, day) {
    if (!series || !series.length) return null;
    let best = null;
    for (const q of series) { if (q.pub <= day) best = q; else break; }
    return best;
}

/** 那天 flag 亮不亮:true / false;那天還沒有任何一季可用 → null(呼叫端要「剔除並計數」,⛔ 不可當成通過) */
export function finOnAt(series, day, variant = '') {
    const q = finKnownAt(series, day);
    if (!q || !q.ok) return null;
    const on = q.yoy > 0 && q.acc > 0;
    if (variant === 'gm') return on && q.gmq >= 0;
    if (variant === 'eps') return on && q.epsy > 0;
    return on;
}
