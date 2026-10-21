/**
 * 🎯 V79.4.7 保守下界 lb(全 repo 回測共用;⛔ 別在引擎裡各寫一份)
 *
 * App 的 🔥 選股(`playbook_scan.mjs` V72.9.2 起)= 這檔這招的期望值 − z × 標準差 ÷ √n(z = 1.28,約 90% 信心下緣)
 *   ・標準差 = 樣本標準差(除以 n − 1)= `index.html` `_patternFitBacktest` 的 `sd`;n = 1 時標準差當 0
 *   ・樣本越少罰得越重 → 前段班不會被「樣本少但剛好很賺」佔滿(陷阱 #27 的大規模版)
 * 這裡用「n、總和、平方和」算(回測引擎每天累加 / 扣回,⛔ 不存每一筆)→ 跟逐筆算的結果一致(test_pbgate 跨檔比對)。
 * z = 0 時回傳 sum / n(⛔ 不做任何其他運算 → 跟舊的「平均」排序逐位相同)。
 */
export function lbOf(n, sum, sq, z) {
    const mu = sum / n;
    if (!z || n < 2) return mu;
    const v = Math.max(0, (sq - n * mu * mu) / (n - 1));
    return mu - z * Math.sqrt(v) / Math.sqrt(n);
}
