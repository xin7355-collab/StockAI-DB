/**
 * 📏 台股漲跌幅限制(全 repo 回測共用;⛔ 別在探針裡各寫一份 9.7 / 1.095 這種寫死的數字)
 *
 * 2015-06-01 起上市櫃漲跌幅由 ±7% 放寬成 ±10%(證交所 / 櫃買同一天)。
 * 16 年的回測(d16:2010 起)如果寫死 ±10%,2010~2015 那五年「開盤就鎖漲停、根本買不到」的那幾筆會被當成買得到
 * → 動能 / 追高類的訊號被灌水(V79.4.1 盤點 25 支探針,12 支有這個問題)。
 */
export const LIMIT_CHANGE = '2015-06-01';

/** 那一天的漲跌幅限制(小數:0.07 / 0.10)。日期 'YYYY-MM-DD' 或 'YYYY/MM/DD' 都收。 */
export const limitOf = d => String(d || '').replace(/\//g, '-').slice(0, 10) < LIMIT_CHANGE ? 0.07 : 0.10;

/** 同上,百分比(7 / 10),給「漲跌幅 %」那種欄位用。 */
export const limitPct = d => limitOf(d) === 0.07 ? 7 : 10;

/**
 * 收盤漲跌幅(%)有沒有到漲跌停:1 / -1 / 0。slackPct 預設 0.4 個百分點(= 舊寫法 ±9.6% 在 ±10% 制度下的寬度)。
 * ⭐ Python 版 lib_limit.limit_flag 同一條(test_lib_limit 跨語言比對)。
 */
export function limitFlag(date, chgPct, slackPct = 0.4) {
    const p = +chgPct;
    if (!Number.isFinite(p)) return 0;
    const lim = limitPct(date) - slackPct;
    return p >= lim ? 1 : (p <= -lim ? -1 : 0);
}

/**
 * 收盤停在漲停價(含排隊沒成交的)→「今天尾盤買」買不到。slack 預設 0.5 個百分點(漲停價有跳動單位捨入)。
 * ⭐ Python 版 lib_limit.up_limit_close 同一條(test_lib_limit 跨語言比對)。
 */
export const upLimitClose = (date, close, prevClose, slack = 0.005) =>
    prevClose > 0 && close > 0 && close >= prevClose * (1 + limitOf(date) - slack);

/**
 * 那一根是不是「一價到底鎖死」(開 = 高 = 低 = 收、跟前收差到接近限制)→ 買不到 / 賣不掉。
 * slack = 離限制多近就算(預設 0.3 個百分點:漲停價有跳動單位捨入)。回 1 = 鎖漲停、-1 = 鎖跌停、0 = 沒鎖。
 */
export function lockedBar(date, prevClose, o, h, l, slack = 0.003) {
    if (!(prevClose > 0 && o > 0) || h !== l) return 0;
    const g = o / prevClose - 1, lim = limitOf(date) - slack;
    return g >= lim ? 1 : (g <= -lim ? -1 : 0);
}
