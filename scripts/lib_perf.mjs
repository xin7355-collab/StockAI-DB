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

/* ───────────────────────────────────────────────────────────────────────────────
 * 📐 V82.1.2 風險調整後指標(SELF_EVOLVING_AUDIT G4)—— Sharpe / Sortino / Calmar / 年化 / 最大回撤 / 滾動 12、24 月贏 0050
 *   輸入:每天收盤的淨值(含現金 + 0050 停車 + 持股市值;⛔ 只算持股)與同一天的 0050 含息指數(可省略)
 *   口徑(寫死,畫面要照講):無風險利率 = 0、一年 244 個交易日、滾動窗口每 5 天取一次(同 leader_probe roll12)
 *   ⛔ 別處不要再寫一份 Sharpe;要用就 import 這支。跑法:node scripts/lib_perf.mjs --selftest
 * ─────────────────────────────────────────────────────────────────────────────── */
const Y = 244;

export function perf(v, bench = null) {
    const n = v.length;
    if (n < 2 || !(v[0] > 0)) return null;
    const r = [];
    for (let i = 1; i < n; i++) if (v[i] > 0 && v[i - 1] > 0) r.push(v[i] / v[i - 1] - 1);
    const m = r.reduce((a, x) => a + x, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, r.length - 1));
    const dn = Math.sqrt(r.reduce((a, x) => a + Math.min(0, x) ** 2, 0) / r.length);
    let pk = -Infinity, mdd = 0; for (const x of v) { pk = Math.max(pk, x); mdd = Math.min(mdd, x / pk - 1); }
    const cagr = Math.pow(v[n - 1] / v[0], Y / (n - 1)) - 1;
    const roll = w => { if (!bench || bench.length !== n) return null; let k = 0, b = 0; for (let i = w; i < n; i += 5) { if (!(bench[i] > 0 && bench[i - w] > 0)) continue; k++; if (v[i] / v[i - w] > bench[i] / bench[i - w]) b++; } return k ? b / k * 100 : null; };
    return { cagr: cagr * 100, mdd: mdd * 100, vol: sd * Math.sqrt(Y) * 100,
        sharpe: sd > 1e-12 ? m / sd * Math.sqrt(Y) : null, sortino: dn > 1e-12 ? m / dn * Math.sqrt(Y) : null, calmar: mdd < 0 ? cagr / -mdd : null,
        roll12: roll(Y), roll24: roll(2 * Y) };
}

export function perfSelftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    // ① 每天 +0.1%、沒有波動 → Sharpe / Sortino 算不出來(null)、回撤 0、年化 = 1.001^244 − 1
    const up = Array.from({ length: 500 }, (_, i) => Math.pow(1.001, i)), P = perf(up);
    t(P.sharpe === null && P.sortino === null && P.mdd === 0 && Math.abs(P.cagr - (Math.pow(1.001, 244) - 1) * 100) < 1e-6, `① 直線上漲:年化 ${P.cagr.toFixed(2)}%、回撤 0、Sharpe 算不出來`);
    // ② 一漲一跌 +2% / −1%:手算 Sharpe;Sortino 只罰往下的 → 比 Sharpe 大
    const zz = [1]; for (let i = 1; i < 401; i++) zz.push(zz[i - 1] * (i % 2 ? 1.02 : 0.99));
    const r = []; for (let i = 1; i < zz.length; i++) r.push(zz[i] / zz[i - 1] - 1);
    const m = r.reduce((a, x) => a + x, 0) / r.length, sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1));
    const Z = perf(zz);
    t(Math.abs(Z.sharpe - m / sd * Math.sqrt(244)) < 1e-9 && Z.sortino > Z.sharpe && Z.mdd < 0, `② 一漲一跌:Sharpe ${Z.sharpe.toFixed(3)} = 手算、Sortino ${Z.sortino.toFixed(3)} 比較大(只罰往下)`);
    // ③ 回撤 / Calmar:漲到 2 跌回 1 再漲到 3
    const v3 = [1, 2, 1, 3], C = perf(v3);
    t(Math.abs(C.mdd + 50) < 1e-9 && Math.abs(C.calmar - C.cagr / 100 / 0.5) < 1e-9, `③ 從 2 跌到 1 → 最大回撤 −50%、Calmar = 年化 ÷ 0.5`);
    // ④ 滾動贏 0050:策略每天多 0.05% → 100%;一樣 → 0%;bench 長度不對 → null
    const b = Array.from({ length: 800 }, (_, i) => Math.pow(1.0005, i)), s = b.map((x, i) => x * Math.pow(1.0005, i));
    const R4 = perf(s, b), R5 = perf(b, b), R6 = perf(s, b.slice(1));
    t(R4.roll12 === 100 && R4.roll24 === 100 && R5.roll24 === 0 && R6.roll24 === null, `④ 滾動 12 / 24 月贏 0050:一直多一點 → ${R4.roll12}% / ${R4.roll24}%、一樣 → ${R5.roll24}%、長度不對 → null`);
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('lib_perf.mjs') && process.argv.includes('--selftest')) process.exit(perfSelftest());
