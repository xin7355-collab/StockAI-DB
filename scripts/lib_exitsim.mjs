/**
 * 🚪 出場模擬 —— 「固定同一批進場點,只換出場」的**唯一一份**模擬器(V77.4.6 抽出)
 *
 * ⭐ 為什麼要抽出來:`perstock_exit_probe.mjs`(V74.6.1)裡本來就有一份寫得很乾淨的
 *   `simExits`,而 V77.4.6 要回答「突破之後哪種出場賺最多」時需要**完全一樣**的模擬器。
 *   ⛔ 複製第二份 = 出場公式在本 repo 會變成**第五份**實作
 *   (`index.html._exitLevelAt` / `auto_trade.py` / `pro.html` / `portfolio_backtest.mjs` / 這裡)。
 *   → 抽成 lib,兩支探針共用;⛔ 改這裡要同步去看那四處。
 *
 * ⛔ 三條不可改掉的設計(`--selftest` 在兩支探針裡都釘著):
 *   ① **零前視** —— peak / atr / 前 N 日低 一律只吃「到 j 為止」的 K,
 *      而且「前 N 日最低」**不含 j 自己**(陷阱 #43:基準區間⛔ 不可包含被判斷的那幾根)。
 *   ② **停損優先** —— 跟 App 一致:`min(進場那根的低點, 進場價×(1−HOLD_STOP%))`,
 *      每一種出場規則都先過這一關(否則「哪種出場好」會被停損的差異污染)。
 *   ③ **最長 MAXD 個交易日封頂** —— 到期用收盤價平掉,⛔ 不讓某些規則無限期抱下去
 *      (那會變成在比「誰抱得久」而不是在比出場規則)。
 *
 * 📐 規則字串(⛔ 認不得的 key 一律 throw —— 打錯字安靜地不出場是最糟的失敗):
 *   ・`ma{N}`     跌破 N 日均線(收盤 < MA_N)        例:ma5 / ma10 / ma20
 *   ・`don{N}`    跌破**前 N 日最低**(唐奇安/海龜)   例:don10 / don20 / don55
 *   ・`donmid{N}` 跌破**前 N 日最高最低的中點**(唐奇安中軌,V77.5.6)例:donmid20
 *                 ⭐ 比 `don{N}`(下軌)鬆、出場更早;來自「增強版唐奇安通道策略」逐字稿(評估紀錄㉝),
 *                 本站首次測 —— ⛔ 高低點同樣**不含 j 自己**(陷阱 #43)
 *   ・`atr{K}`    進場後最高收盤 − K×ATR14           例:atr2 / atr3(K 可小數 atr2.5)
 *   ・`trail{N}`  進場後最高收盤回落 N%              例:trail8 / trail15
 *   ・`hold`      ⛔ 不設出場,只有停損 + MAXD 封頂 —— **對照組**,
 *                 ⭐ 少了它就不知道「有出場」到底比「不出場」好多少。
 */

export const EXIT_NAME = {
    ma5: '跌破 5 日線', ma10: '跌破 10 日線', ma20: '跌破 20 日線(月線)',
    don10: '唐奇安 10 日', don20: '唐奇安 20 日', don55: '唐奇安 55 日',
    donmid20: '唐奇安 20 日中軌',
    atr2: 'ATR 追蹤 K=2', atr3: 'ATR 追蹤 K=3',
    trail8: '移動停利 8%', trail15: '移動停利 15%',
    hold: '⛔ 不出場(只有停損+封頂)',
};
export const exitName = k => EXIT_NAME[k] || k;

/** 把規則字串解析成一個判斷函式的參數;⛔ 認不得就 throw(打錯字不可以安靜地變成「永不出場」)。 */
export function parseRule(rule) {
    let m;
    if (rule === 'hold') return { kind: 'hold' };
    if ((m = /^ma(\d+)$/.exec(rule))) return { kind: 'ma', n: +m[1] };
    if ((m = /^donmid(\d+)$/.exec(rule))) return { kind: 'donmid', n: +m[1] };
    if ((m = /^don(\d+)$/.exec(rule))) return { kind: 'don', n: +m[1] };
    if ((m = /^atr(\d+(?:\.\d+)?)$/.exec(rule))) return { kind: 'atr', k: +m[1] };
    if ((m = /^trail(\d+(?:\.\d+)?)$/.exec(rule))) return { kind: 'trail', p: +m[1] };
    throw new Error(`lib_exitsim: 認不得的出場規則 '${rule}'`);
}

/**
 * 同一個進場點 → 每一種出場各自的報酬(⛔ 毛報酬,成本由呼叫端扣)。
 * @param {Array} R      K 線陣列,每根要有 {o,h,l,c}
 * @param {number} eIdx  進場那一根的 index(進場價 = 該根收盤 —— 訊號日尾盤進場,V72.9.0)
 * @param {object} opt   { rules, maxD, holdStop, stopFill }
 *   stopFill(V77.5.9,停損的**成交價**):
 *     'close' 收盤跌破 → 用收盤價(= auto_trade.py 的做法)⭐ V77.6.0 起預設
 *     'stop'  收盤跌破 → 用停損價算(V77.5.9 以前;⚠️ 收盤已經在停損下面,這個價其實賣不到 —— 只留給重現舊數字)
 *     'touch' 盤中最低碰到 → min(開盤, 停損價)(= App 複製的觸價智慧單)
 * @returns {object|null} { [rule]: { ret, outIdx, why } }
 */
export function simExits(R, eIdx, opt = {}) {
    const rules = opt.rules || ['ma5', 'don20', 'atr2', 'trail8'];
    const MAXD = opt.maxD ?? 20;
    const HOLD_STOP = opt.holdStop ?? 5;
    const FILL = opt.stopFill || 'close';   // ⭐ V77.6.0 起預設收盤成交(⛔ 停損價那天其實賣不到)
    if (!['stop', 'close', 'touch'].includes(FILL)) throw new Error(`lib_exitsim: 認不得的 stopFill '${FILL}'`);

    const n = R.length, entry = R[eIdx].c;
    if (!(entry > 0)) return null;
    // ② 停損:App 同款 —— 前一根低點與 −HOLD_STOP% 取較近的那個
    const stop0 = Math.min(R[eIdx].l, entry * (1 - HOLD_STOP / 100));
    const endJ = Math.min(n - 1, eIdx + MAXD);
    if (endJ <= eIdx) return null;

    // ① ATR14:只吃到 j 為止的 K
    const atrAt = j => {
        let s = 0, m = 0;
        for (let q = Math.max(1, j - 13); q <= j; q++) {
            const pc = R[q - 1].c; if (!(pc > 0)) continue;
            s += Math.max(R[q].h - R[q].l, Math.abs(R[q].h - pc), Math.abs(R[q].l - pc)); m++;
        }
        return m ? s / m : 0;
    };

    const out = {};
    for (const rule of rules) {
        const P = parseRule(rule);
        let peak = entry, exitP = null, exitIdx = endJ, why = '封頂';
        for (let j = eIdx + 1; j <= endJ; j++) {
            const c = R[j].c;
            if (c > peak) peak = c;
            // ② 停損優先(成交價三種口徑,V77.5.9)
            if (FILL === 'touch' ? (R[j].l > 0 && R[j].l <= stop0) : c <= stop0) {
                exitP = FILL === 'close' ? c : FILL === 'touch' ? Math.min(R[j].o > 0 ? R[j].o : stop0, stop0) : stop0;
                exitIdx = j; why = '停損'; break;
            }
            let hit = false;
            if (P.kind === 'ma' && j >= P.n - 1) {
                let s = 0; for (let q = j - (P.n - 1); q <= j; q++) s += R[q].c;
                hit = c < s / P.n;
            } else if (P.kind === 'don') {
                //   ① 前 N 日最低 **不含 j 自己**(陷阱 #43)
                let lo = Infinity; for (let q = Math.max(0, j - P.n); q < j; q++) lo = Math.min(lo, R[q].l);
                hit = isFinite(lo) && c < lo;
            } else if (P.kind === 'donmid') {
                //   唐奇安中軌 = 前 N 日最高與最低的平均值(同樣不含 j 自己,陷阱 #43)
                let hi = -Infinity, lo = Infinity;
                for (let q = Math.max(0, j - P.n); q < j; q++) { hi = Math.max(hi, R[q].h); lo = Math.min(lo, R[q].l); }
                hit = isFinite(hi) && isFinite(lo) && c < (hi + lo) / 2;
            } else if (P.kind === 'atr') {
                const at = atrAt(j); hit = at > 0 && c <= peak - P.k * at;
            } else if (P.kind === 'trail') {
                hit = c <= peak * (1 - P.p / 100);
            }   // 'hold' → 永遠不 hit,只靠停損與封頂
            if (hit) { exitP = c; exitIdx = j; why = '規則'; break; }
            if (j === endJ) { exitP = c; exitIdx = j; why = '封頂'; }
        }
        if (exitP == null) { exitP = R[endJ].c; exitIdx = endJ; why = '封頂'; }
        out[rule] = { ret: (exitP - entry) / entry * 100, outIdx: exitIdx, why };
    }
    return out;
}
