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
/** 四個法定截止日(月-日)—— 行事曆類探針用它找「財報截止日 ±N 個交易日」。
 *  ⚠️ 這不是法說會(法說會沒有免費結構化來源),文案不可混稱。 */
export const DEADLINES = ['-03-31', '-05-15', '-08-14', '-11-14'];

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

/** 📐 「這個流量欄位是累計還是單季?」—— ⛔ 不憑印象假設,用 Q4 ÷ Q1 的比值中位數判
 *  (⛔ 不用「是不是遞增」:某一季虧損/負值會打亂它,實測 ocf 明明是累計卻只有 43% 遞增)。
 *  累計 → Q4 ≈ 4×Q1(比值 2.5~6);單季 → 0.5~2。
 *  🚨 實測 FinMind 三表是**混的**:損益表(cogs/rev)單季、現金流量表(capex/dep/ocf)累計 → ⛔ 不可整批當同一種。
 *  F = fin_deep.json 整份({q, f, s});回 true = 累計。log=true 時印判斷依據(探針用)。 */
export const detectCumulative = (F, field, log = false) => {
    const j = F.f.indexOf(field), ratios = [];
    if (j < 0) return false;
    for (const qs of Object.values(F.s)) {
        const byY = {};
        for (const [q, v] of Object.entries(qs)) {
            if (v[j] != null) (byY[q.slice(0, 4)] ||= {})[q.slice(5, 7)] = Math.abs(v[j]);
        }
        for (const mm of Object.values(byY)) {
            if (mm['03'] > 0 && mm['12'] > 0) ratios.push(mm['12'] / mm['03']);
        }
    }
    ratios.sort((a, b) => a - b);
    const med = ratios.length ? ratios[ratios.length >> 1] : 1;
    const cum = med >= 2.5;
    if (log) console.log(`   📐 ${field}: Q4÷Q1 中位 ${med.toFixed(2)}(${ratios.length} 個年度)→ ` +
        (cum ? '🚨 累計 → 自動相減還原成單季' : med <= 2.0 ? '✅ 單季' : '⚠️ 看不出來,當單季處理'));
    return cum;
};

/** 取某一檔某一季的**單季**值:累計欄位就跟同一年的前一季相減(Q1 本來就是單季);
 *  找不到前一季 → 回 null(⛔ 不硬算)。CUM = {field: bool}(detectCumulative 的結果)。 */
export const quarterValue = (F, sym, q, field, CUM) => {
    const j = F.f.indexOf(field), row = F.s[sym] && F.s[sym][q];
    if (j < 0 || !row || row[j] == null) return null;
    const v = row[j];
    if (!CUM[field] || q.slice(5, 7) === '03') return v;
    const i = F.q.indexOf(q);
    for (let k = i - 1; k >= 0; k--) {                       // 找同一年的前一季
        const p = F.q[k];
        if (p.slice(0, 4) !== q.slice(0, 4)) break;
        const pr = F.s[sym][p];
        if (pr && pr[j] != null) return v - pr[j];
    }
    return null;
};
