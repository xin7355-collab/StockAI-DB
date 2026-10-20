/**
 * 🧱 價格斷崖守門(全 repo 回測共用;⛔ 別在探針裡各寫一份 1.4 / 0.6 / 整檔剔除)
 *
 * 上市櫃有漲跌幅限制 → 相鄰兩根收盤(或開盤 vs 前收)差超過 ×1.5 / ×0.67 物理上不可能是真漲跌,
 * 是減資 / 停牌後恢復交易 / 資料洞留下的尺標斷層(d16:489 次 / 345 檔)。
 * ⭐ 只剔「碰到斷崖的那幾個窗口」,⛔ 不整檔剔除 —— 整檔剔除會把減過資的困難股整批拿掉 = 倖存者偏誤又回來
 *   (V79.4.1 盤點:6 支探針整檔剔除)。門檻跟 merge_stock_deep / merge_deep_klines / dispo_backtest 同一組。
 */
export const CLIFF_LO = 0.67, CLIFF_HI = 1.5;

/**
 * closes(必填)、opens(可省)→ 前綴和 pre:pre[k+1] = 第 0..k 根裡有幾根「跟前一根之間有斷崖」。
 * 收盤 ≤ 0 / 缺值那根不算斷崖(交給呼叫端自己的缺值處理)。
 */
export function cliffPrefix(closes, opens = null) {
    const n = closes.length, pre = new Int32Array(n + 1);
    for (let k = 0; k < n; k++) {
        let b = 0;
        const c0 = +closes[k - 1], c1 = +closes[k];
        if (k > 0 && c0 > 0 && c1 > 0) {
            const r1 = c1 / c0, o = opens ? +opens[k] : NaN, r2 = o > 0 ? o / c0 : 1;
            if (!(r1 >= CLIFF_LO && r1 <= CLIFF_HI) || !(r2 >= CLIFF_LO && r2 <= CLIFF_HI)) b = 1;
        }
        pre[k + 1] = pre[k] + b;
    }
    return pre;
}

/** 第 a+1 根到第 b 根之間(含兩端的「跟前一根比」)有沒有斷崖;a、b 會被夾到資料範圍內。 */
export const cliffIn = (pre, a, b) => {
    const n = pre.length - 1;
    const hi = Math.min(b, n - 1) + 1, lo = Math.max(a, -1) + 1;
    return hi > lo && pre[hi] - pre[lo] > 0;
};
