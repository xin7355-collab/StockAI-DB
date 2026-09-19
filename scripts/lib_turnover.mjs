/** 🔄 週轉率三分位(V77.3.3)—— portfolio_backtest.mjs 的 TURN 濾網與測試共用,⛔ 不在回測腳本裡另寫一份 */
export const turnCuts = (vals) => {
    const a = vals.filter(Number.isFinite).sort((x, y) => x - y);
    if (a.length < 30) return null;                                   // 當天橫斷面不到 30 檔 → 切不出三分位(呼叫端當「沒切點」→ 剔除)
    const q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))];
    return [q(1 / 3), q(2 / 3)];
};
export const turnBucket = (v, cuts) => (v == null || !Number.isFinite(v) || !cuts) ? null : (v < cuts[0] ? 'lo' : v < cuts[1] ? 'mid' : 'hi');
