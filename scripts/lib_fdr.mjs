/**
 * 📊 多重比較校正 —— Benjamini-Hochberg(控制偽發現率 FDR)(V77.5.5)
 *
 * 為什麼:`_SIGNAL_EDGE` 一次檢定 129 個訊號,每個都用「p ≤ 0.05 就算 A」→
 *   就算全部都是雜訊,也會有約 129 × 0.05 ≈ 6 個被評成 A。實測套 BH 後 A 從 54 → 48,
 *   掉下來的 6 個 p 都在 0.022~0.043 之間 —— 剛好就是「運氣也拿得到」的那一段。
 * ⭐ 期望值為正的 8 個 A 全部存活 → 「值得參考的進場訊號」一個都沒變;變的只有徽章與看多計分的權重。
 *
 * ⛔ 全 repo 只有這一份(signal_backtest 分級 / embed_signal_edge 嵌入 / 測試共用)。
 * ⛔ 只校正「A 級」那道門檻;B(p ≤ 0.25)本來就寫「證據偏弱」,不另外校正。
 */

/** 回傳與輸入同順序的 BH q 值(單調、≤ 1)。非數字的 p 當成 1。 */
export function bhQ(pvals) {
    const m = pvals.length;
    if (!m) return [];
    const idx = pvals.map((p, i) => [Number.isFinite(+p) ? +p : 1, i]).sort((a, b) => a[0] - b[0]);
    const q = new Array(m);
    let run = 1;
    for (let r = m - 1; r >= 0; r--) {
        const [p, i] = idx[r];
        run = Math.min(run, (p * m) / (r + 1));
        q[i] = Math.min(1, run);
    }
    return q;
}

/** 分級規則(唯一一份):A = q ≤ 0.05 ・B = p ≤ 0.25 ・C = 其他。 */
export const FDR_A = 0.05;
export const P_B = 0.25;
export function gradeOf(p, q) {
    if (q <= FDR_A) return 'A';
    if (p <= P_B) return 'B';
    return 'C';
}

/** 對一組 {p} 物件就地加上 q 與 grade,回傳 {A,B,C} 計數。 */
export function regrade(rows) {
    const q = bhQ(rows.map(r => r.p));
    const cnt = { A: 0, B: 0, C: 0 };
    rows.forEach((r, i) => {
        r.q = +q[i].toFixed(4);
        r.grade = gradeOf(+r.p, q[i]);
        cnt[r.grade]++;
    });
    return cnt;
}
