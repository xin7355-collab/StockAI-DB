/**
 * 📐 回測共用的「分布 / 獲利因子 / 比例檢定 / 水塘抽樣」—— V77.4.2
 *
 * ⛔ 陷阱 #37:`portfolio_backtest.mjs:985` 的最大回撤、`regime_matrix_probe.mjs:130-135` 的水塘、
 *    `ovtrend_probe.mjs:55` 的 pctl 各自 inline 一份。新探針一律 import 這一支;
 *    ⛔ 但不可盲目把那幾份換掉 —— 要先驗「輸出逐位元組相同」才准換(V74.5.9 規矩)。
 *
 * ⚠️ 這裡只有純函式,沒有任何 I/O;`lib_perf.py` 是 Python 端的同名模組(CAGR/夏普/月報酬矩陣),兩邊功能不重疊。
 */

/** 分位數(0~1),線性內插;空陣列回 null */
export const pctl = (a, p) => {
    const b = a.filter(Number.isFinite).sort((x, y) => x - y);
    if (!b.length) return null;
    const k = (b.length - 1) * p, lo = Math.floor(k), hi = Math.ceil(k);
    return lo === hi ? b[lo] : b[lo] + (b[hi] - b[lo]) * (k - lo);
};

/** 水塘抽樣:對照組動輒幾十萬筆,只留 cap 筆等機率樣本估分布(事件桶 n 小 = 全存) */
export class Reservoir {
    constructor(cap = 20000, seed = 20260921) { this.cap = cap; this.a = []; this.n = 0; let x = seed >>> 0 || 1; this._r = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }
    push(v) { this.n++; if (this.a.length < this.cap) this.a.push(v); else { const j = Math.floor(this._r() * this.n); if (j < this.cap) this.a[j] = v; } }
    pct(ps = [0.1, 0.25, 0.5, 0.75, 0.9]) { return ps.map(p => pctl(this.a, p)); }
}

/** 獲利因子 = Σ贏 ÷ Σ|輸|;沒有輸的一筆回 Infinity、一筆都沒有回 null */
export const profitFactor = (sumWin, sumLoss) => (sumWin == null || sumLoss == null || (!sumWin && !sumLoss)) ? null : (sumLoss > 0 ? sumWin / sumLoss : Infinity);

const erf = x => {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
};
export const pTwoSided = z => 1 - erf(Math.abs(z) / Math.SQRT2);

/** 兩個比例的 z 檢定(合併比例)—— Big Winner Capture / False Positive 這種「幾 % 的事件」要用這條,⛔ 不可用均值檢定 */
export const propZ = (k1, n1, k2, n2) => {
    if (!n1 || !n2) return { d: 0, z: 0, p: 1 };
    const p1 = k1 / n1, p2 = k2 / n2, pp = (k1 + k2) / (n1 + n2);
    const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
    const z = se > 0 ? (p1 - p2) / se : 0;
    return { d: (p1 - p2) * 100, z, p: pTwoSided(z) };
};

/** 隨機亮燈的期望捕捉率:flag 每天以機率 p 亮,連看 k 天至少亮一次的機率 —— ⛔ 沒有這個對照,「捕捉率 60%」毫無意義 */
export const randExpect = (p, k) => 1 - Math.pow(1 - p, k);
