/**
 * 📅 財報「什麼時候才知道」的共用規則 —— ⛔ 這一步錯了整份回測就是前視偏誤
 *
 * 🚨 本站目前有 **6 份**各自 inline 的同一條規則
 * (pe_probe / broker_cross_probe / calendar_probe / calendar_stack_probe /
 *  limitup_probe / portfolio_backtest)—— 那是陷阱 #37。
 * ⭐ 新的一律用這一支;⛔ 但**不可盲目把那 6 份換掉** ——
 *   它們的寫法各不相同(md5 全不一樣),照本站規矩要先驗「輸出逐位元組相同」才准換
 *   (V74.5.9 抽 lib_indicators 就是那樣做的)。已記進 LAB 的推薦欄。
 */

/** 季別(季末日) → 這份財報**最晚**什麼時候公布(台股法定期限)。
 *  Q1→5/15 ・ Q2→8/14 ・ Q3→11/14 ・ Q4(全年)→ 隔年 3/31
 *  ⚠️ 這是**法定上限**不是實際公布日:多數公司會提早 → 用它是**保守**的
 *     (寧可晚一點才「知道」,⛔ 不可早一天 —— 早一天就是前視)。 */
export const pubDate = period => {
    const p = String(period || '');
    const y = +p.slice(0, 4), m = p.slice(5, 7);
    if (!(y > 1990)) return null;
    if (m === '03') return `${y}-05-15`;
    if (m === '06') return `${y}-08-14`;
    if (m === '09') return `${y}-11-14`;
    if (m === '12') return `${y + 1}-03-31`;
    return null;
};

/** 給一個日期,回「那一天**已經公布**的最後一季是哪一季」。
 *  ⭐ 回測要用這支,⛔ 不可直接拿季別當可用日。 */
export const knownAsOf = (periods, day) => {
    let best = null;
    for (const p of periods) {
        const d = pubDate(p);
        if (d && d <= day && (!best || p > best)) best = p;
    }
    return best;
};

/** 存貨週轉天數:存貨 ÷ 單季營業成本 × 90。
 *  🚨 `cogs` 必須是**單季**;FinMind 若給的是累計就要先相減 —— ⛔ 拿累計直接算,
 *     DOI 會從 Q1 到 Q4 一路變小,看起來像「庫存一直在去化」,其實只是分母在累加。 */
export const doi = (inv, cogsQuarter) =>
    (inv > 0 && cogsQuarter > 0) ? inv / cogsQuarter * 90 : null;
