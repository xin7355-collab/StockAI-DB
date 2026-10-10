#!/usr/bin/env node
/**
 * 👑🚀 V77.8.5「領頭羊短線輪動」—— 自創一套「AI 時代選股 + 出場」,目標:贏 0050 含息
 *
 * 使用者:「請你自創適合 AI 選股法,還有出場,適合做短線的,我要贏 0050」。
 * 為什麼長這樣(每一條都有本站實測撐著,⛔ 不是憑感覺):
 *   - V77.8.4 逐月:現行預設 12 個月贏 0050 只有 34%,**AI 行情集中在大型權值股、它挑的高波動小型股跟不上**。
 *   - kingpool_probe:「成交額前 50」是唯一六關全過的池子(+0.98pp);外加的六層全部沒用。
 *   - 動能(追強 > 抄底):screener_edge_probe / sector_pick「板塊內最強」/ breakout_exit「砍得越早賺越少」。
 *   - 閒錢停 0050(PARK=idle)是目前最強的一個改動(434 vs 324 萬,17/17)。
 *   → 🧭 規則(驗證後的版本):每 10 個交易日收盤,在**近 20 日平均成交額前 100 大**(⛔ 不含 ETF)裡,挑**近 10 日漲最多**、
 *     而且收盤 > 20 日線 > 60 日線的前 5 檔,隔天開盤等權買;下次換倉還在前 10 名就續抱,掉出去就隔天開盤賣;
 *     ⛔ 不用停損線(吊燈 2/3 倍實測都讓它變差);沒用到的錢停 0050;大盤嚴格空頭(加權 < 60 日線且 20 日線 < 60 日線)不開新倉。
 *   ⚠️ 最初設計是「60 日動能 + 吊燈 2 倍 + 每週換 + 前 50 大」→ 實測輸 0050(17 條 0 條贏),網格之後才落到上面這組。
 *   ⛔ 刻意**不用**「AI 題材名單」:本站那份是 2026 年手選的(後見之明,layer_accel_probe 已寫明),拿它回測等於作弊。
 *     「AI 時代的領頭羊」改用**當時就看得到的**成交額排名來抓。
 *
 * 零前視:第 t 天收盤算分數 → 第 t+1 天**開盤**成交(開盤接近漲停買不到 → 不買);吊燈看收盤、收盤賣(STOPFILL=close)。
 * 成本:買 0.1425%、賣 0.1425% + 0.3%;0050 賣 0.1% 稅。除權息:持有中碰到 → 份數 × (除權息前價 ÷ 參考價)(2021 起才有股利資料)。
 * 資料斷崖:單日(已調除權息)漲跌超過當時漲跌幅限制 + 1.5% → 那一檔 120 天內⛔ 不進池子、持有中碰到就用前一天收盤出場。
 * 對照:0050 含息(同起點、同一天買)・sham = 同一個池子、同樣過濾後**隨機**挑 N 檔(固定種子)・不選股 = 池子等權。
 * 起點穩健:17 條(每 5 個交易日一條)。窗口:AI 時代(2022-09-16 起,同本站其他回測)+ 長歷史 2011~2026(⚠️ 2021 前只有上市、個股沒有股利資料 → 對策略不利)。
 * 跑法:DATA_DIR=$S/d10n DIV=…/dividends_hist.json node --max-old-space-size=8192 scripts/leader_probe.mjs out.json
 *       node scripts/leader_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { trSeries, loadPx } from './lib_totalreturn.mjs';
import { finSeries, finOnAt } from './lib_finaccel.mjs';
import { valuePrep } from './lib_value.mjs';
import { accrualSeries, accrualMonthCut, accrualHiAt } from './lib_accrual.mjs';
import { gates } from './maxim_kbar5_probe.mjs';
import { parseThemes } from './lib_themes.mjs';

const COST_X = +(process.env.COST_X || 1);            // 成本壓力(×2 = 手續費與稅都加倍)
const FEE = 0.001425 * COST_X, TAX = 0.003 * COST_X, ETF_TAX = 0.001 * COST_X;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
const limitOf = d => d < '2015-06-01' ? 0.07 : 0.10;

export function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/** 一檔股票 → 對齊日曆的欄位 + 指標(全部只用 ≤ i 的資料) */
export function prepStock(sym, rows, cal, divs) {
    const n = cal.length, idx = new Map(cal.map((d, i) => [d, i]));
    const O = new Float64Array(n).fill(NaN), H = O.slice(), L = O.slice(), C = O.slice(), V = O.slice();
    for (const r of rows) { const i = idx.get(r.d); if (i === undefined) continue; O[i] = r.o; H[i] = r.h; L[i] = r.l; C[i] = r.c; V[i] = r.v; }
    const F = new Float64Array(n).fill(1);           // 除權息倍數(除權息前價 ÷ 參考價),只在除權息日 ≠ 1
    let divSkip = 0;
    for (const [dt, , , before, after] of (divs || [])) {
        const i = idx.get(String(dt).slice(0, 10)); if (i === undefined || i === 0) continue;
        let p = i - 1; while (p > 0 && !(C[p] > 0)) p--;
        const b = +before, a = +after;
        if (!(b > 0 && a > 0 && b / a > 1 && b / a < 1.6 && C[p] > 0 && Math.abs(b / C[p] - 1) < 0.03)) { divSkip++; continue; }
        F[i] *= b / a;
    }
    const ind = { val20: new Float64Array(n).fill(NaN), ma20: new Float64Array(n).fill(NaN), ma60: new Float64Array(n).fill(NaN), atr: new Float64Array(n).fill(NaN), jump: new Int32Array(n).fill(-1e9) };
    // 調整後收盤(把除權息倍數累乘回去 → 動能不會被除息日誤判成下跌)
    const A = new Float64Array(n).fill(NaN); let k = 1, lastA = NaN;
    for (let i = 0; i < n; i++) { k *= F[i]; if (C[i] > 0) { A[i] = C[i] * k; lastA = A[i]; } }
    let lastJump = -1e9, prevI = -1;
    const vals = [], cls = [], trs = [];
    let sV = 0, s20 = 0, s60 = 0, sTR = 0;
    const cl20 = [], cl60 = [];
    for (let i = 0; i < n; i++) {
        if (!(C[i] > 0)) continue;
        if (prevI >= 0) {
            const r = C[i] * F[i] / C[prevI] - 1;
            if (Math.abs(r) > limitOf(cal[i]) + 0.015) lastJump = i;
            const tr = Math.max(H[i] - L[i], Math.abs(H[i] - C[prevI]), Math.abs(L[i] - C[prevI]));
            trs.push(tr); sTR += tr; if (trs.length > 14) sTR -= trs.shift();
            if (trs.length === 14) ind.atr[i] = sTR / 14;
        }
        const v = C[i] * V[i]; vals.push(v); sV += v; if (vals.length > 20) sV -= vals.shift();
        if (vals.length === 20) ind.val20[i] = sV / 20;
        cl20.push(A[i]); s20 += A[i]; if (cl20.length > 20) s20 -= cl20.shift();
        cl60.push(A[i]); s60 += A[i]; if (cl60.length > 60) s60 -= cl60.shift();
        if (cl20.length === 20) ind.ma20[i] = s20 / 20;
        if (cl60.length === 60) ind.ma60[i] = s60 / 60;
        ind.jump[i] = lastJump;
        prevI = i;
    }
    return { sym, O, H, L, C, V, F, A, ...ind, divSkip };
}

/** 動能:近 L 個「有交易的」日子的調整後報酬(只用 ≤ i) */
function momSkip(S, i, L, k) { let j = i, c = 0; while (j > 0 && c < k) { j--; if (S.A[j] > 0) c++; } return c === k ? mom(S, j, L) : NaN; }
export function mom(S, i, L) { if (!(S.A[i] > 0)) return NaN; let j = i, c = 0; while (j > 0 && c < L) { j--; if (S.A[j] > 0) c++; } return c === L ? S.A[i] / S.A[j] - 1 : NaN; }

// ⭐ 預設 = 兩個窗口網格(216 + 81 + 9 組)驗出來的中心點;⛔ 最初設計的「60 日動能 + 吊燈 2 倍 + 每週換」實測是輸的(見 DECISIONS V77.8.5)
export const DEF = { U: 100, N: 5, R: 10, L: 10, chand: 0, park: true, bear: true, trend: true, hyst: 2, pick: 'mom', core: 0, maExit: 0, tp: 0, skip: 0, riskadj: false, fill: 'open', noAtt: 0, noDisp: 0, sellDisp: false,
    dispNow: false, dispOracle: 0, attSell: 0, attWin: 5, rebuy: 'none', rebuyDrop: 0.15, blockDays: 10, shamSell: 0,
    indCap: 0, wRank: null, posMin: 85, posRaw: true, volUp: 0, finAcc: false, fsync: 0, rankUp: false, shamKeep: 0,
    capital: 0, minFee: 20, add: 0, glide: 0, parkMin: 5000, luExit: '', phase: 0, join: '', limitRepl: false, limitRetry: '', pickFrom: 0,
    dip: 0, hold: 5, dipSort: 'drop', dipMin: 0, bearCore: null, bearN: 0, bearTop: 0, pool: '', themeK: 3, themeL: 20, themeSham: false,
    dRank: 0, stop: 0, trail: 0, shamOut: 0, refill: false, accAvoid: false, accSham: 0 };
// 🛒 V78.2.2 「怎麼買」(使用者:「前 5 名還是 6~10 也可以?開盤買還是 13:00~13:30?漲停要不要換第 6 名?」)⛔ 不設時逐位相同:
//   limitRepl  = 成交價接近漲停買不到 → 換候選名單上的下一名(仍要過位置門檻、沒持有)
//   limitRetry = 'close':開盤接近漲停買不到 → 當天收盤沒鎖就用收盤價買(只在 fill='open' 有意義)
//   fill='sameclose' = 換倉日**當天收盤**就成交(= 13:00 看名單、13:25 下單的近似;⚠️ 名次用收盤算 → 偏樂觀,只當上限)
//   pickFrom   = k:只從候選第 k+1 名起買(pickFrom 5 = 只買第 6~10 名)
// 🕐 V78.2.1 晚進場(使用者:「第一天沒買,後面還可以進嗎?」)⛔ 不設時逐位相同:
//   phase = k:換倉節奏的起點在 s0 之前 k 天(= 你在兩次換倉中間第 k 天才開始)
//   join  = 'now' 當天收盤就照當下名單買(之後跟著換倉日)・'wait' 錢先停 0050、等下一個換倉日才買
// 🎯 V78.3.0 題材輪動(使用者:「題材回測還沒有做過」—— 測過的是「題材層之後 20 天」,沒測過「真的拿錢照題材輪動」)⛔ 不設時逐位相同(selftest ㉟):
//   pool = 'theme':換倉日收盤,每個題材(pro.html THEMES,ctx.themes)算成員 themeL 日動能中位數(≥3 檔算得出才算),
//          取前 themeK 個題材 → 候選 = 那幾個題材的成員(⛔ 不再取成交額前 U 大),之後照原規則(趨勢、位置、名次前 N、掉出前 2N 才賣)
//   themeSham = true:題材隨機挑 themeK 個(另一顆亂數)= 安慰劑
// 🔄 V78.6.3 期中換股(使用者:「換倉第一天買前 5,某隻掉到某個程度、還沒到 10 天就賣掉改買新的前 5」)⛔ 不設時逐位相同(selftest ㊲):
//   每天收盤:dRank = K → 持股今天名次 > K(或掉出趨勢名單)・stop = x → 收盤 < 進場價 ×(1−x)・trail = x → 收盤 < 持有期最高收盤 ×(1−x)
//            ・shamOut = p → 每檔每天以機率 p 隨機賣(安慰劑,另一顆亂數)→ 隔天開盤賣
//   refill = true:同一個收盤用當下名次(同 posMin 等候選濾網)補滿空位、隔天開盤買;嚴格空頭不補;換倉日的空位也算進這些賣掉的
//   refill = false:賣掉的錢停 0050 到下一次換倉(= V77.8.6 maExit 的做法)
//   ⚠️ 題材名單是 2026 年人工整理的 = 事後挑過 → 結果只能當上限
// 🐻 V78.3.0 空頭季節招式(使用者:「空頭那年要改什麼策略,給我自創招式,結束後再改回最強策略」)⛔ 不設時逐位相同(selftest ㉞):
//   空頭 = ctx.bear(嚴格空頭,收盤才知道)→ 一律用「昨天收盤」的空頭狀態決定今天收盤的動作(晚一天 = 保守,⛔ 不用當天)
//   bearCore = x:空頭期間 0050 停車只留「淨值 × x」、其餘放現金(0 = 全部現金;多頭回來那天收盤再停回 0050)
//   bearN    = k:空頭期間最多只抱 k 檔,多的照動能名次最後的先賣(隔天開盤)
//   bearTop  = k:空頭期間仍可買,但只買名次第 1~k 名、總持股最多 k 檔(= 「空頭只追最強的」;現行是空頭完全不買)
// 📉 V78.2.6 dip(使用者:「熱門股跌 3% 那個也幫我做組合回測」)⛔ 不設時逐位相同(selftest ㉝):
//   dip = k → 每天收盤:熱門池(每月第一個交易日,用**前一天為止**的 60 日平均成交值取前 U 大 = kbar5_deep 的母體)裡
//         今天收盤比昨天(除權息調整)跌 ≥k% 的 → 隔天開盤買;抱 hold 天(第 hold 個交易日收盤賣,同 maxim_kbar5_probe 的 c5)
//   空位 = N − 持股數(每格 = 淨值 ÷ N);空頭 bear 開時不開新倉;閒錢照 park 停 0050;⛔ 不跑換倉那一段
//   dipMin = m → 當天熱門池裡至少 m 檔有跌到才買(= 只在「大盤一起跌」的日子;sham 也照同一個條件)
//   dipSort = 'drop' 跌最多先買 / 'sham' 同一天同樣檔數、從熱門池**隨機**挑(⛔ 不管有沒有跌)/ 'shamDip' 有跌的裡面隨機挑
// 🟥 V78.2.0 luExit(使用者:「國巨收盤鎖漲停,隔天要照那四條賣嗎?」—— 那四條是 🔥 的,👑 從來沒測過)⛔ 不設時逐位相同:
//   持股前一天收盤鎖漲停(定義同 dt_daily_probe.lockUp:收盤 ≥ 前收 ×(1+漲跌幅−1%)且收在最高)、今天:
//   開盤一字鎖(開=高=低、仍在漲停)→ 抱 ・'gap5' 開高 ≥5% 開盤賣 ・'gap0' 開高 >0% 開盤賣(09:30 前賣的日 K 代理)
//   ・'all' 照四條:開高開盤賣、開平開低收盤賣 ・賣掉的錢停 0050 到下一次換倉(⛔ 換倉日排名照舊)
// 🌱 V77.9.4 小資金(使用者:「錢沒那麼多是否可以先快速賺到資金」)—— 不設時(capital=0)逐位相同:
//   capital = 真實本金(元):股票一律整數股(零股),每筆手續費 max(minFee, 金額 × 0.1425%)(⛔ 以前是分數股、沒有最低手續費 = 對小錢太樂觀)
//   add     = 每個月第一個交易日再投入幾元(先放現金,下一次換倉日一起處理)
//   glide   = 帳戶市值到「投入總額 × glide」之後,之後新買的部位只用一半錢(另一半停 0050)= 「先衝再穩」
//   parkMin = 小資金時閒錢超過多少元才停 0050(⛔ 幾百元也去買 0050 會被最低手續費吃掉)
// V77.8.9 自動下單接線前的兩個問題:fill = 'open'(隔天開盤成交,回測原設定)| 'nextclose'(隔天收盤成交 = 自動下單尾盤跑、名單是前一晚算的)
//   noAtt = N:決策日之前 N 個交易日內有「注意股」公告就不買 ・noDisp = N:之前 N 個交易日內有「處置」公告就不買 ・sellDisp:持股被公告處置 → 下一個成交點賣
//   ⚠️ 事件一律只認「決策日之前」的公告(官方公告在收盤後,當天收盤決策時還看不到 = ⛔ 前視)
// V78.0.5 使用者:「處置前常被拉抬、快處置時被大賣、出關又拉 → 先跟、處置前賣、大跌再買回?」(⛔ 不設時逐位相同)
//   dispNow   = 持股當天被公告處置(公告在收盤後)→ 隔天開盤賣(舊 sellDisp 晚一天,⛔ 保留不動)
//   dispOracle= d:之後 d 天內「會」被公告處置 → 隔天開盤先賣 ——🔮 偷看未來,⛔ 做不到,只量「猜得準最多能多賺多少」
//   attSell   = k:近 attWin 天(含今天收盤後的公告)被公告注意 ≥k 次 → 隔天開盤賣(= 真的做得到的「處置前賣」)
//   賣掉之後擋住(block):有接到處置就擋到出關那天,沒有就擋 blockDays 天;rebuy='release' 出關隔天開盤若仍在前 2N 名就買回、
//   'drop' 擋住期間收盤比賣價跌 ≥ rebuyDrop 且仍在前 2N 名就買回、'none' 只是擋住(之後照換倉日)
//   shamSell  = p:安慰劑 —— 每天每個持股以機率 p 隨機賣掉、一樣擋 blockDays 天、一樣的買回規則
// V78.0.5 使用者:「領頭羊還能更容易漲嗎?」—— 候選只擋**買進**(續抱名單照舊 = 前 2N 名),濾網一律配 shamKeep 安慰劑:
//   indCap = 同產業最多幾檔 ・wRank = 名次加權(陣列,第 k 名的錢 × w[k])・posMin = 一年位置 ≥ ・volUp = 5 日均額 ÷ 20 日均額 ≥
//   finAcc = 營收年增加速(lib_finaccel,公布日才算知道;沒資料剔除並計數)・fsync = N:外資與投信近 N 天都買超 ・rankUp = 動能名次比 R 天前進步
//   shamKeep = p:每個候選以機率 p 留下(p 對齊真濾網實測的通過率)
//   accAvoid = 💵 V79.0.7 盈餘品質避雷:進場那個月應計比率在全市場最高 40% → 不買(lib_accrual;⭐ 不知道 = 保留,避雷型)
// V77.8.6 穩定度變體:core = 永遠留幾成在 0050 ・maExit = 收盤跌破 N 日線隔天開盤賣 ・tp = 收盤賺 x 就隔天開盤停利 ・skip = 動能不算最近幾天 ・riskadj = 動能 ÷ ATR 排名

/**
 * 模擬一條路徑。ctx = {cal, stocks:[S], etf:{tr:Float64Array (0050 含息指數,對齊 cal)}, bear:Uint8Array}
 * 回 {eq:Float64Array(從 s0 起), trades, turnover, ...}
 */
/** 📉 dip 的熱門池:cal[i] 那個月第一個交易日,用「它前一天為止」近 60 個有交易日的平均成交值(收盤 × 量)取前 U 大(零前視;快取在 ctx) */
export function dipPoolOf(ctx, i, U) {
    const { cal, stocks } = ctx, mon = cal[i].slice(0, 7);
    const C = ctx._dipPools || (ctx._dipPools = new Map()), key = mon + '|' + U;
    if (C.has(key)) return C.get(key);
    let m0 = i; while (m0 > 0 && cal[m0 - 1].slice(0, 7) === mon) m0--;
    const k = m0 - 1, arr = [];
    if (k >= 0) for (const S of stocks) {
        if (!(k - S.jump[k] > 120)) continue;
        let s = 0, c = 0; for (let j = k; j >= 0 && j >= k - 90 && c < 60; j--) if (S.C[j] > 0) { s += S.C[j] * S.V[j]; c++; }
        if (c === 60) arr.push([S, s / 60]);
    }
    arr.sort((a, b) => b[1] - a[1]);
    const pool = arr.slice(0, U).map(x => x[0]); C.set(key, pool); return pool;
}
/** 今天收盤 vs 昨天收盤(除權息調整);昨天沒交易 / 今天是資料斷崖 → NaN */
export function dipRet(S, i) { return i > 0 && S.C[i] > 0 && S.C[i - 1] > 0 && S.jump[i] !== i ? S.C[i] * S.F[i] / S.C[i - 1] - 1 : NaN; }

/** 📉 dip 事件層級(V78.2.6):熱門池裡跌 ≥dip% → 隔天開盤買、第 hold 天收盤賣(扣 0.44%),對照 = 同一天熱門池**全部**用同一個做法
 *  開盤接近漲停買不到 → 剔除並計數。回 {ev:[{d, v, raw}], cnt}(v = 這一筆 − 同一天熱門池平均)→ 直接餵 gates() */
export function dipEvents(ctx, from, P) {
    const { cal } = ctx, n = cal.length, H = P.hold, cnt = { lock: 0, noCtrl: 0 }, ev = [];
    const s0 = Math.max(61, cal.findIndex(d => d >= from));
    const one = (S, i) => {
        const o = S.O[i + 1], c = S.C[i + H];
        if (!(S.C[i] > 0 && o > 0 && c > 0)) return null;
        if (o >= S.C[i] * (1 + limitOf(cal[i + 1]) - 0.003)) return 'lock';
        let f = 1; for (let j = i + 2; j <= i + H; j++) f *= S.F[j];
        return (c * f / o - 1) * 100 - (2 * FEE + TAX) * 100;
    };
    for (let i = s0; i + H < n; i++) {
        const pool = dipPoolOf(ctx, i, P.U), all = [], sig = [];
        for (const S of pool) { const g = one(S, i); if (typeof g !== 'number') { if (g === 'lock' && dipRet(S, i) <= -P.dip / 100) cnt.lock++; continue; } all.push(g); if (dipRet(S, i) <= -P.dip / 100) sig.push(g); }
        if (all.length < 20) { cnt.noCtrl += sig.length; continue; }
        const m = all.reduce((a, b) => a + b, 0) / all.length;
        for (const g of sig) ev.push({ d: cal[i], v: g - m, raw: g });
    }
    return { ev, cnt };
}

export function simulate(ctx, s0, cfg, seed = 1) {
    const { cal, stocks, etf } = ctx;
    const P = { ...DEF, ...cfg };
    const n = cal.length;
    // 📅 V78.0.8 endIdx:跑到這一天收盤就停(逐年成績單:每年 1 月重放 100 萬、年底以市值計)—— 不設 = 跑到最後一天(逐位相同)
    const nEnd = P.endIdx != null ? Math.min(n, P.endIdx + 1) : n;
    const CAP = P.capital > 0;
    let cash = CAP ? P.capital : 1, park = 0;                 // park 用 0050 含息指數的「單位數」
    let contributed = cash, glideAt = null;
    const feeOf = amt => CAP ? Math.max(P.minFee, amt * FEE) : amt * FEE;
    const pos = new Map();                                    // sym → {sh, entry, atr, hc, S}
    const eq = [];
    let trades = 0, wins = 0, sumRet = 0, turnover = 0, skipLimit = 0, jumpExit = 0;
    let sumAmt = 0, worstAmt = null, bestAmt = null;         // V78.0.8 逐筆賺賠(元 / 本金單位)—— 只給逐年成績單用,⛔ 不影響淨值
    const rand = rng(seed);
    let pending = null;                                       // 前一天收盤決定、今天開盤執行的委託
    const dailySell = new Set();
    // V78.0.5 新功能一律用另一顆亂數(⛔ 不可動到 pick='sham' 用的那顆 → 舊結果逐位相同)
    const rand2 = rng(seed * 7919 + 13);
    const blocked = new Map();                                // sym → {S, px, i, rel}
    let retryBuy = null, retryNow = false;
    const st = { accCut: 0, accUnk: 0, accKnown: 0, repl: 0, retried: 0, forced: 0, rebought: 0, fTot: 0, fPass: 0, finMiss: 0, posDays: 0, luOpen: 0, luClose: 0, luHold: 0, luLock: 0 };
    const CAND = P.posMin > 0 || P.volUp > 0 || P.finAcc || P.fsync > 0 || P.rankUp || P.shamKeep > 0 || P.accAvoid;
    const DIP = P.dip > 0;
    const BC = P.bearCore != null;
    let bearMode = false;                                     // 🐻 昨天收盤是不是空頭(只在 bearCore / bearN / bearTop 設了才用)
    const FORCE = P.dispNow || P.dispOracle > 0 || P.attSell > 0 || P.shamSell > 0;
    const rand3 = rng(seed * 104729 + 7);
    const rand4 = rng(seed * 15485863 + 3);                   // 🔄 shamOut 專用(⛔ 不動別人的亂數)
    const MID = P.dRank > 0 || P.stop > 0 || P.trail > 0 || P.shamOut > 0;
    const themeUniv = i => {
        const sc = [];
        for (const T of ctx.themes) {
            const ms = []; for (const sym of T.syms) { const S = ctx.bySym.get(sym); if (!S) continue; const m = mom(S, i, P.themeL); if (Number.isFinite(m)) ms.push(m); }
            if (ms.length < 3) continue;
            ms.sort((a, b) => a - b); sc.push({ T, m: ms[ms.length >> 1], k: rand3() });
        }
        sc.sort(P.themeSham ? (a, b) => a.k - b.k : (a, b) => b.m - a.m);
        const set = new Set(); for (const x of sc.slice(0, P.themeK)) for (const sym of x.T.syms) { const S = ctx.bySym.get(sym); if (S) set.add(S); }
        st.themes = st.themes || []; st.themes.push(sc.slice(0, P.themeK).map(x => x.T.k).join('+'));
        return [...set];
    };
    const rankAt = i => {
        const univ = [];
        const THEME = P.pool === 'theme' && ctx.themes;
        for (const S of (THEME ? themeUniv(i) : stocks)) { if (S.val20[i] > 0 && S.C[i] > 0 && i - S.jump[i] > 120 && S.ma60[i] > 0 && S.atr[i] > 0) univ.push(S); }
        univ.sort((a, b) => b.val20[i] - a.val20[i]);
        const pool = THEME ? univ : univ.slice(0, P.U);
        let ok = pool.filter(S => !P.trend || (S.C[i] > S.ma20[i] && S.ma20[i] > S.ma60[i]));
        if (P.noAtt && ctx.att) ok = ok.filter(S => !evWithin(ctx.att.get(S.sym), i, P.noAtt));
        if (P.noDisp && ctx.disp) ok = ok.filter(S => !evWithin(ctx.disp.get(S.sym), i, P.noDisp));
        let ranked;
        if (P.pick === 'sham') { ranked = ok.map(S => ({ S, k: rand() })).sort((a, b) => a.k - b.k).map(x => x.S); }
        else if (P.pick === 'all') { ranked = ok; }
        else { ranked = ok.map(S => { let m = P.skip ? momSkip(S, i, P.L, P.skip) : mom(S, i, P.L); if (P.riskadj && S.atr[i] > 0) m = m / (S.atr[i] / S.C[i]); return { S, m }; }).filter(x => Number.isFinite(x.m)).sort((a, b) => b.m - a.m).map(x => x.S); }
        return { ranked, ok };
    };
    // 🧪 V78.0.5 買進候選濾網(⛔ 只擋買進,續抱名單照舊)
    const candOk = (S, i, prevRank, rankNow) => {
        if (P.shamKeep > 0) return rand2() < P.shamKeep;
        if (P.posMin > 0) { const v = pos252(S, i, P.posRaw); if (!(v >= P.posMin)) return false; }
        if (P.volUp > 0) { const v5 = val5(S, i); if (!(v5 / S.val20[i] >= P.volUp)) return false; }
        if (P.finAcc) { const ser = ctx.fin ? ctx.fin(S.sym) : null; const on = ser ? finOnAt(ser, cal[i]) : null; if (on === null) { st.finMiss++; return false; } if (!on) return false; }
        if (P.fsync > 0) { if (!S.FN) return false; let c = 0, j = i; while (j >= 0 && c < P.fsync) { if (S.C[j] > 0) { if (!(S.FN[j] > 0 && S.TN[j] > 0)) return false; c++; } j--; } if (c < P.fsync) return false; }
        if (P.rankUp) { const pr = prevRank.get(S.sym); if (pr !== undefined && !(rankNow < pr)) return false; }
        if (P.accAvoid) {   // accAvoid='sham' = 安慰劑:有資料的候選以機率 accSham 隨機剔除(⛔ 跟應計無關;位置等其他濾網照樣先過)
            const hi = ctx.accHi ? ctx.accHi(S.sym, cal[i]) : null;
            if (hi === null) st.accUnk++;
            else { st.accKnown++; const drop = P.accAvoid === 'sham' ? rand2() < P.accSham : hi; if (drop) { st.accCut++; return false; } }
        }
        return true;
    };
    const forceWhy = (S, i) => {
        const per = ctx.dper ? ctx.dper.get(S.sym) : null;
        if (P.dispNow && per && per.some(q => q.a > i - 1 && q.a <= i)) return 'disp';
        if (P.dispOracle > 0 && per && per.some(q => q.a > i && q.a <= i + P.dispOracle)) return 'oracle';
        if (P.attSell > 0 && ctx.att) { const a = ctx.att.get(S.sym); if (a) { let c = 0; for (const e of a) if (e > i - P.attWin && e <= i) c++; if (c >= P.attSell) return 'att'; } }
        if (P.shamSell > 0 && rand2() < P.shamSell) return 'sham';
        return null;
    };
    const value = i => { let v = cash + park * etf.tr[i]; for (const p of pos.values()) { const c = lastC(p.S, i); v += p.sh * c; } return v; };
    // ⏱️ V78.4.4 log / intraPx(⛔ 不設時逐位相同):log = 陣列 → 每一筆成交記 {s, side, d(成交日), dd(決策日), px, why, e(進場日)};
    //   intraPx = Map('代號|日期|S或B' → 盤中成交價):fill='open' 的委託改用這個價(對不到就照開盤並計數)= leader_intraday_probe 的組合驗證
    const LOG = Array.isArray(P.log) ? P.log : null;
    const ipx = (S, i, side, base) => { if (!P.intraPx || P.fill !== 'open' || retryNow) return base; const v = P.intraPx.get(`${S.sym}|${cal[i]}|${side}`); if (v > 0) { st.ipxHit = (st.ipxHit || 0) + 1; return v; } st.ipxMiss = (st.ipxMiss || 0) + 1; return base; };
    const sell = (p, px, i, why) => { if (LOG) LOG.push({ s: p.S.sym, side: 'S', d: cal[i], dd: cal[i - 1], px, why: why || 'other', e: cal[Math.floor(p.entry)], cost: p.cost }); const amt = p.sh * px; const got = CAP ? amt - feeOf(amt) - amt * TAX : amt * (1 - FEE - TAX); cash += got; turnover += amt; const ret = px / p.cost - 1 - 2 * FEE - TAX; trades++; sumRet += ret; if (ret > 0) wins++;
        const pa = got - p.paid; sumAmt += pa; if (worstAmt === null || pa < worstAmt) worstAmt = pa; if (bestAmt === null || pa > bestAmt) bestAmt = pa; pos.delete(p.S.sym); };
    for (let i = s0; i < nEnd; i++) {
        if (P.add > 0 && i > s0 && cal[i].slice(0, 7) !== cal[i - 1].slice(0, 7)) { cash += P.add; contributed += P.add; }   // 🌱 每月投入
        // ① 成交點:執行上一次決策的委託 —— fill='open' 在今天開盤、'nextclose' 在今天收盤(見 ②b)
        const execPending = (PX, ti) => {   // ti = 0050 用哪一天的價(開盤成交 ≈ 昨收;收盤成交 = 今天收盤)
            for (const sym of pending.sell) { const p = pos.get(sym); if (!p) continue; const o = ipx(p.S, i, 'S', PX(p.S, i)); if (o > 0) sell(p, o, i, 'pend'); }
            if (pending.trim) for (const p of pos.values()) {                              // 🌱 先衝再穩:翻倍那天之後的第一個成交點,每一檔賣掉一半
                const o = PX(p.S, i); if (!(o > 0)) continue;
                const shS = CAP ? Math.floor(p.sh / 2) : p.sh / 2; if (!(shS > 0)) continue;
                const amt = shS * o; cash += CAP ? amt - feeOf(amt) - amt * TAX : amt * (1 - FEE - TAX); turnover += amt; p.paid *= (p.sh - shS) / p.sh; p.sh -= shS;
            }
            const eqNow = value(ti);
            const slot = eqNow * (1 - P.core) / P.N;
            const queue = pending.buy.slice(), alt = (pending.alt || []).slice();
            for (let qi = 0; qi < queue.length; qi++) {
                const S = queue[qi];
                if (pos.size >= P.N) break;
                if (pos.has(S.sym)) continue;
                const o = ipx(S, i, 'B', PX(S, i)), pc = lastC(S, i - 1);
                if (!(o > 0 && pc > 0)) continue;
                if (o / pc - 1 > limitOf(cal[i]) - 0.003) {                                  // 成交價接近漲停:買不到(開盤 / 收盤同一條)
                    skipLimit++;
                    if (P.limitRepl) { while (alt.length) { const A = alt.shift(); if (!pos.has(A.sym) && !queue.includes(A)) { queue.push(A); st.repl++; break; } } }
                    else if (P.limitRetry === 'close' && P.fill === 'open') (retryBuy = retryBuy || []).push(S);
                    continue;
                }
                let need = pending.w ? slot * (pending.w.get(S.sym) ?? 1) : slot;
                if (cash < need && P.park && park > 0) {                                   // 賣 0050 補現金
                    const units = Math.min(park, (CAP ? need - cash + P.minFee : need - cash) / (etf.tr[ti] * (1 - FEE - ETF_TAX)));
                    const amt0 = units * etf.tr[ti];
                    cash += CAP ? amt0 - feeOf(amt0) - amt0 * ETF_TAX : units * etf.tr[ti] * (1 - FEE - ETF_TAX); park -= units; turnover += amt0;
                }
                need = Math.min(need, cash); if (need < slot * 0.2) continue;
                let sh, paid;
                if (CAP) {                                                                  // 🌱 整數股 + 最低手續費
                    sh = Math.floor(need / (o * (1 + FEE)));
                    while (sh > 0 && sh * o + feeOf(sh * o) > need) sh--;
                    if (sh < 1) continue;
                    const cost = sh * o + feeOf(sh * o); cash -= cost; turnover += sh * o; paid = cost;
                } else { sh = need / (o * (1 + FEE)); cash -= need; turnover += need; paid = need; }
                pos.set(S.sym, { sh, cost: o, paid, atr: S.atr[i - 1], hc: o, S, entry: (P.fill === 'open' && !retryNow) ? i : i + 0.5 });
                if (LOG) LOG.push({ s: S.sym, side: 'B', d: cal[i], dd: cal[i - 1], px: o, why: retryNow ? 'retry' : 'buy' });   // 收盤成交那天⛔ 不可再跑當天的吊燈 / 出場檢查
            }
            if (P.park && !(BC && bearMode) && cash > 0.01 * value(ti) && (!CAP || cash >= P.parkMin)) { const units = CAP ? (cash - feeOf(cash)) / etf.tr[ti] : cash * (1 - FEE) / etf.tr[ti]; park += units; turnover += cash; cash = 0; }
            pending = null;
        };
        bearMode = i > s0 && ctx.bear[i - 1] === 1;
        if (pending && P.fill === 'open') execPending((S, k) => S.O[k], i - 1);
        // 🟥 V78.2.0 luExit:昨天收盤鎖漲停的持股,今天開盤照規則賣(⛔ 不設時整段不跑)
        const parkCash = ti => { if (P.park && !(BC && bearMode) && cash > 0.01 * value(ti) && (!CAP || cash >= P.parkMin)) { const units = CAP ? (cash - feeOf(cash)) / etf.tr[ti] : cash * (1 - FEE) / etf.tr[ti]; park += units; turnover += cash; cash = 0; } };
        let luClose = null;
        if (P.luExit && i > s0) {
            let sold = 0;
            for (const p of [...pos.values()]) {
                const S = p.S, k = i - 1;
                if (!(p.entry <= k)) continue;                                              // 昨天收盤還沒抱著(今天才買的)
                const c = S.C[k], pc = lastC(S, k - 1), o = S.O[i];
                if (!(c > 0 && pc > 0 && o > 0) || S.F[k] !== 1 || S.F[i] !== 1) continue;  // 除權息日不判(比例會歪)
                if (!(c >= pc * (1 + limitOf(cal[k]) - 0.01) && c >= S.H[k] - 1e-9)) continue;
                st.luLock++;
                const gap = o / c - 1;
                if (gap > limitOf(cal[i]) - 0.01 && S.L[i] >= S.H[i] - 1e-9) { st.luHold++; continue; }   // 一字鎖 → 抱
                if (P.luExit === 'gap5' ? gap >= 0.05 : gap > 0) { sell(p, o, i); st.luOpen++; sold++; }
                else if (P.luExit === 'all') (luClose = luClose || []).push(S.sym);
            }
            if (sold) parkCash(i - 1);
        }
        // ② 收盤:除權息、斷崖、吊燈
        let dipSold = 0;
        let midRank = null;
        if (P.dRank > 0 && pos.size) { midRank = new Map(); rankAt(i).ranked.forEach((S, k) => midRank.set(S.sym, k)); }
        for (const p of [...pos.values()]) {
            const S = p.S;
            if (S.F[i] !== 1 && S.C[i] > 0) p.sh *= S.F[i];
            if (!(S.C[i] > 0)) continue;
            if (S.jump[i] === i && i > p.entry) { const pc = lastC(S, i - 1); sell(p, pc, i); jumpExit++; continue; }   // 資料斷崖:用前一天收盤出場
            if (DIP && i >= p.entry + P.hold - 1) { sell(p, S.C[i], i); dipSold++; continue; }   // 📉 抱滿 hold 天 → 收盤賣
            p.hc = Math.max(p.hc, S.C[i]);
            if (P.chand > 0 && i > p.entry && p.atr > 0 && S.C[i] < p.hc - P.chand * p.atr) sell(p, S.C[i], i);
            else if (P.sellDisp && i > p.entry && ctx.disp && evWithin(ctx.disp.get(S.sym), i, 1)) dailySell.add(S.sym);
            else if (i > p.entry && ((P.maExit === 20 && S.C[i] < S.ma20[i]) || (P.maExit === 60 && S.C[i] < S.ma60[i]) || (P.tp > 0 && S.C[i] >= p.cost * (1 + P.tp)))) dailySell.add(S.sym);
            if (MID && pos.has(S.sym) && i > p.entry && !dailySell.has(S.sym) && i + 1 < n) {
                const k = midRank ? midRank.get(S.sym) : undefined;
                if ((P.dRank > 0 && !(k < P.dRank)) || (P.stop > 0 && S.C[i] < p.cost * (1 - P.stop)) || (P.trail > 0 && S.C[i] < p.hc * (1 - P.trail)) || (P.shamOut > 0 && rand4() < P.shamOut)) { dailySell.add(S.sym); st.midOut = (st.midOut || 0) + 1; }
            }
            if (FORCE && pos.has(S.sym) && i > p.entry && !dailySell.has(S.sym) && i + 1 < n) {
                st.posDays++;
                const why = forceWhy(S, i);
                if (why) { dailySell.add(S.sym); st.forced++; blocked.set(S.sym, { S, px: S.C[i], i, rel: i + P.blockDays, why }); }
            }
        }
        if (DIP && dipSold) parkCash(i);
        if (luClose) { let sold = 0; for (const sym of luClose) { const p = pos.get(sym); if (p && p.S.C[i] > 0) { sell(p, p.S.C[i], i); st.luClose++; sold++; } } if (sold) parkCash(i); }
        // ②b fill='nextclose':今天收盤執行上一次的決策(在今天的決策之前)
        if (pending && P.fill === 'nextclose') execPending((S, k) => S.C[k], i);
        // 🛒 V78.2.2 limitRetry:開盤漲停買不到的,收盤沒鎖就用收盤價買(⛔ 名次不重算)
        if (retryBuy) { const rb = retryBuy; retryBuy = null; const before = pos.size; pending = { sell: [], buy: rb }; retryNow = true; execPending((S, k) => S.C[k], i); retryNow = false; st.retried += pos.size - before; }
        // 🐻 V78.3.0 空頭季節:0050 停車調到目標(今天收盤成交)、多頭回來那天收盤停回 0050
        if (BC && P.park) {
            if (bearMode) {
                const tgt = P.bearCore * value(i), pv = park * etf.tr[i];
                if (pv > tgt * 1.05 + 1e-12) { const units = (pv - tgt) / etf.tr[i], amt = units * etf.tr[i]; cash += CAP ? amt - feeOf(amt) - amt * ETF_TAX : amt * (1 - FEE - ETF_TAX); park -= units; turnover += amt; st.bearSell = (st.bearSell || 0) + 1; }
                else if (pv < tgt * 0.95 && cash > 0) { const amt = Math.min(cash, tgt - pv); park += (CAP ? amt - feeOf(amt) : amt * (1 - FEE)) / etf.tr[i]; cash -= amt; turnover += amt; }
            } else parkCash(i);
        }
        if (P.bearN > 0 && bearMode && pos.size > P.bearN) {
            const ord = [...pos.values()].map(p => ({ s: p.S.sym, m: mom(p.S, i, P.L) })).sort((a, b) => (Number.isFinite(b.m) ? b.m : -1e9) - (Number.isFinite(a.m) ? a.m : -1e9));
            for (const x of ord.slice(P.bearN)) { if (!dailySell.has(x.s)) { dailySell.add(x.s); st.bearCut = (st.bearCut || 0) + 1; } }
        }
        if (dailySell.size && i + 1 < n) { pending = pending || { sell: [], buy: [] }; for (const sym of dailySell) if (!pending.sell.includes(sym)) pending.sell.push(sym); dailySell.clear(); }
        // 🔄 V78.6.3 refill:不是換倉日 → 今天收盤就照當下名次補滿空位(換倉日交給 ③)
        const isReb = !DIP && ((i - s0 + P.phase) % P.R === 0 || (P.join === 'now' && i === s0));
        if (P.refill && !isReb && pending && pending.sell.length && i + 1 < n && !(P.bear && ctx.bear[i])) {
            const room = P.N - (pos.size - pending.sell.filter(s => pos.has(s)).length) - pending.buy.length;
            if (room > 0) {
                const { ranked } = rankAt(i);
                const cand = CAND ? ranked.filter((S, k) => candOk(S, i, new Map(), k)) : ranked;
                const add = cand.filter(S => !pos.has(S.sym) && !pending.buy.includes(S) && !blocked.has(S.sym)).slice(0, room);
                pending.buy.push(...add); st.refill = (st.refill || 0) + add.length;
            }
        }
        eq.push(value(i));
        // ③ 換倉日收盤:決定明天開盤要做什麼
        if (P.join === 'wait' && P.phase > 0 && i === s0 && (i - s0 + P.phase) % P.R !== 0 && i + 1 < n) pending = { sell: [], buy: [] };   // 🕐 等的那幾天錢停 0050
        // 📉 dip:每天收盤挑訊號 → 隔天開盤買(⛔ 不跑下面的換倉)
        if (DIP && i + 1 < n) {
            const pool = dipPoolOf(ctx, i, P.U), sig = [];
            for (const S of pool) { if (pos.has(S.sym)) continue; const r = dipRet(S, i); if (r <= -P.dip / 100) sig.push({ S, r }); }
            st.dipSig = (st.dipSig || 0) + sig.length;
            if (sig.length < P.dipMin) sig.length = 0;
            let list;
            if (P.dipSort === 'sham') list = pool.filter(S => !pos.has(S.sym) && S.C[i] > 0).map(S => ({ S, k: rand2() })).sort((a, b) => a.k - b.k).slice(0, sig.length).map(x => x.S);
            else if (P.dipSort === 'shamDip') list = sig.map(x => ({ S: x.S, k: rand2() })).sort((a, b) => a.k - b.k).map(x => x.S);
            else list = sig.sort((a, b) => a.r - b.r).map(x => x.S);
            const buyL = (P.bear && ctx.bear[i]) ? [] : list.slice(0, Math.max(0, P.N - pos.size));
            if (buyL.length || pending) pending = { sell: pending ? pending.sell : [], buy: buyL };
            else parkCash(i);
        }
        if (!DIP && ((i - s0 + P.phase) % P.R === 0 || (P.join === 'now' && i === s0)) && i + 1 < n) {
            let trimNow = false;
            if (P.glide > 0 && glideAt === null && value(i) >= P.glide * contributed) { glideAt = i; P.core = 0.5; trimNow = pos.size > 0; }   // 🌱 先衝再穩:之後只用一半錢,手上的也砍一半
            const { ranked, ok } = rankAt(i);
            const keepSet = new Set(ranked.slice(0, P.pick === 'all' ? ranked.length : P.N * P.hyst).map(S => S.sym));
            const sellL = [...pos.keys()].filter(s => !keepSet.has(s));
            const bearNow = P.bear && ctx.bear[i];
            const N = P.pick === 'all' ? Math.max(1, ranked.length) : P.N;
            let cand = ranked;
            if (CAND) {
                let prevRank = new Map();
                if (P.rankUp) { const pr = ok.map(S => ({ S, m: mom(S, i - P.R, P.L) })).filter(x => Number.isFinite(x.m)).sort((a, b) => b.m - a.m); pr.forEach((x, k) => prevRank.set(x.S.sym, k)); }
                cand = ranked.filter((S, k) => { const pass = candOk(S, i, prevRank, k); if (k < P.N * 2) { st.fTot++; if (pass) st.fPass++; } return pass; });
            }
            if (blocked.size) cand = cand.filter(S => !blocked.has(S.sym));
            const room = Math.max(0, N - (pos.size - (P.refill ? new Set([...sellL, ...(pending ? pending.sell : [])].filter(s => pos.has(s))).size : sellL.length)));
            let buyL;
            if (bearNow && P.bearTop > 0) buyL = cand.slice(0, P.bearTop).filter(S => !pos.has(S.sym)).slice(0, Math.max(0, P.bearTop - (pos.size - sellL.length)));
            else if (bearNow) buyL = [];
            else if (P.indCap > 0 && ctx.ind) {
                const cnt = new Map(); const sold = new Set(sellL);
                for (const [sym] of pos) if (!sold.has(sym)) { const g = ctx.ind[sym] || '?'; cnt.set(g, (cnt.get(g) || 0) + 1); }
                buyL = [];
                for (const S of cand) { if (buyL.length >= room) break; if (pos.has(S.sym)) continue; const g = ctx.ind[S.sym] || '?'; if ((cnt.get(g) || 0) >= P.indCap) continue; cnt.set(g, (cnt.get(g) || 0) + 1); buyL.push(S); }
            } else buyL = (P.pickFrom > 0 ? cand.slice(P.pickFrom) : cand).filter(S => !pos.has(S.sym)).slice(0, room);
            const altL = (P.limitRepl && !bearNow) ? (P.pickFrom > 0 ? cand.slice(P.pickFrom) : cand).filter(S => !pos.has(S.sym) && !buyL.includes(S)).slice(0, 10) : null;
            if (sellL.length || buyL.length || (P.park && cash > 0) || pending || trimNow) pending = { sell: [...new Set([...(pending ? pending.sell : []), ...sellL])], buy: buyL, trim: trimNow, alt: altL };
            if (P.wRank && pending) { pending.w = new Map(); for (const S of buyL) { const k = ranked.indexOf(S); pending.w.set(S.sym, P.wRank[Math.min(k, P.wRank.length - 1)] ?? 1); } }
            if (P.pick === 'all') P.N = N;
        }
        // ④ V78.0.5 被擋住的(處置前賣掉的)要不要買回:收盤決定、隔天開盤成交;⛔ 只用今天以前看得到的公告
        if (blocked.size && i + 1 < n) {
            let top = null;
            for (const [sym, b] of [...blocked]) {
                const per = ctx.dper ? ctx.dper.get(sym) : null;
                if (per) for (const q of per) if (q.a > b.i - 3 && q.a <= i) b.rel = Math.max(b.rel, q.e);
                if (pos.has(sym)) { if (i > b.i) blocked.delete(sym); continue; }   // 賣出委託還沒成交(當天)→ 先別刪
                const S = b.S;
                const want = (P.rebuy === 'release' && i >= b.rel) || (P.rebuy === 'drop' && i < b.rel && S.C[i] > 0 && S.C[i] <= b.px * (1 - P.rebuyDrop));
                if (!want) { if (i >= b.rel) blocked.delete(sym); continue; }
                top = top || new Set(rankAt(i).ranked.slice(0, P.N * P.hyst).map(x => x.sym));
                blocked.delete(sym);
                if (!top.has(sym) || (P.bear && ctx.bear[i])) continue;
                pending = pending || { sell: [], buy: [] };
                if (!pending.buy.some(x => x.sym === sym) && !pending.sell.includes(sym)) { pending.buy.push(S); st.rebought++; }
            }
        }
        // 🛒 V78.2.2 fill='sameclose':決定完當天收盤就成交(⚠️ 名次用收盤算 = 偏樂觀的上限)
        if (P.fill === 'sameclose' && pending) { execPending((S, k) => S.C[k], i); eq[eq.length - 1] = value(i); }
    }
    return { eq, trades, win: trades ? wins / trades : null, avg: trades ? sumRet / trades : null, turnover, skipLimit, jumpExit, from: cal[s0], contributed, glideAt, st,
        sumAmt, worstAmt, bestAmt, held: pos.size, openPnl: [...pos.values()].reduce((a, p) => a + p.sh * lastC(p.S, nEnd - 1) - p.paid, 0) };
}
/** 一年位置(近 252 個有交易日的調整後收盤,0~100)—— 用到才算(單調佇列 O(n)) */
function pos252(S, i, raw = false) {
    // raw = App / screener_miner 的算法:原始收盤(不還原除息)、不足一年就用現有天數 —— 決策台與 auto_trade 能算得出來的那一個
    const key = raw ? '_posR' : '_pos';
    if (!S[key]) {
        const X = raw ? S.C : S.A, n = X.length, out = new Float64Array(n).fill(NaN), idx = [];
        for (let k = 0; k < n; k++) if (X[k] > 0) idx.push(k);
        const mx = [], mn = [];
        for (let t = 0; t < idx.length; t++) {
            const k = idx[t], v = X[k];
            while (mx.length && X[idx[mx.at(-1)]] <= v) mx.pop(); mx.push(t);
            while (mn.length && X[idx[mn.at(-1)]] >= v) mn.pop(); mn.push(t);
            while (mx[0] <= t - 252) mx.shift(); while (mn[0] <= t - 252) mn.shift();
            if (raw || t >= 251) { const hi = X[idx[mx[0]]], lo = X[idx[mn[0]]]; out[k] = hi > lo ? (v - lo) / (hi - lo) * 100 : (raw ? NaN : 50); }
        }
        S[key] = out;
    }
    return S[key][i];
}
function val5(S, i) {
    let s = 0, c = 0, j = i; while (j >= 0 && c < 5) { if (S.C[j] > 0) { s += S.C[j] * S.V[j]; c++; } j--; }
    return c === 5 ? s / 5 : NaN;
}
/** 決策日 i 之前(⛔ 不含 i)最近 k 個交易日內有沒有公告:arr = 升冪的日曆索引 */
export function evWithin(arr, i, k) { if (!arr || !arr.length) return false; for (let j = arr.length - 1; j >= 0; j--) { const e = arr[j]; if (e >= i) continue; return i - e <= k; } return false; }
function lastC(S, i) { let j = i; while (j >= 0 && !(S.C[j] > 0)) j--; return j >= 0 ? S.C[j] : NaN; }

/** 指標:總報酬、年化、最大回撤、跟 0050 同窗口比 */
export function metrics(eq, trSlice) {
    const n = eq.length, yrs = (n - 1) / 244;
    let rb = 0, rn = 0; for (let i = 244; i < n; i += 5) { rn++; if (eq[i] / eq[i - 244] > trSlice[i] / trSlice[i - 244]) rb++; }
    const roll12 = rn ? rb / rn * 100 : null;
    let peak = -Infinity, mdd = 0; for (const v of eq) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
    let pk2 = -Infinity, mdd0 = 0; for (const v of trSlice) { pk2 = Math.max(pk2, v); mdd0 = Math.min(mdd0, v / pk2 - 1); }
    const tot = eq[n - 1] / eq[0] - 1, b = trSlice[n - 1] / trSlice[0] * (1 - FEE) - 1;
    return { tot: tot * 100, cagr: (Math.pow(eq[n - 1] / eq[0], 1 / yrs) - 1) * 100, mdd: mdd * 100, b0050: b * 100, mdd0050: mdd0 * 100, ex: (tot - b) * 100, roll12 };
}
/** 逐年(日曆年)報酬:策略 vs 0050 */
export function yearly(eq, trSlice, dates) {
    const out = {}; let a = 0;
    for (let i = 1; i <= dates.length; i++) {
        if (i === dates.length || dates[i].slice(0, 4) !== dates[a].slice(0, 4)) {
            const y = dates[a].slice(0, 4), s0 = a === 0 ? 0 : a - 1;
            out[y] = { s: (eq[i - 1] / eq[s0] - 1) * 100, c: (trSlice[i - 1] / trSlice[s0] - 1) * 100 };
            a = i;
        }
    }
    return out;
}

export function loadCtx(DATA, DIV) {
    const tw = loadPx(DATA, '^TWII'); if (!tw) throw new Error('DATA_DIR 沒有 ^TWII.json');
    const cal = tw.map(x => x.d);
    const idx = new Map(cal.map((d, i) => [d, i]));
    // 大盤嚴格空頭(同 portfolio_backtest bear60):收盤 < 60 日線 且 20 日線 < 60 日線
    const bear = new Uint8Array(cal.length);
    for (let i = 59; i < tw.length; i++) { let a = 0, b = 0; for (let j = i - 59; j <= i; j++) { b += tw[j].c; if (j > i - 20) a += tw[j].c; } a /= 20; b /= 60; bear[i] = tw[i].c < b && a < b ? 1 : 0; }
    // 0050 含息
    const b50p = path.join(DATA, '_bench0050.json');
    const bars = fs.existsSync(b50p) ? JSON.parse(fs.readFileSync(b50p, 'utf8')).map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(x => x.c > 0) : loadPx(DATA, '0050');
    const divP = path.join(DATA, '_div0050.json');
    let d50 = [];
    if (fs.existsSync(divP)) { const raw = JSON.parse(fs.readFileSync(divP, 'utf8')); d50 = Array.isArray(raw) ? raw : (raw.h || ((raw.d || raw)['0050'] || {}).h || []); }
    else if (DIV) { const raw = JSON.parse(fs.readFileSync(DIV, 'utf8')); d50 = ((raw.d || raw)['0050'] || {}).h || []; }
    const tr0 = trSeries(bars, d50);
    const tr = new Float64Array(cal.length).fill(NaN); let j = 0, last = NaN;
    for (let i = 0; i < cal.length; i++) { while (j < tr0.d.length && tr0.d[j] <= cal[i]) { last = tr0.v[j]; j++; } tr[i] = last; }
    // 個股
    let DV = {}; if (DIV && fs.existsSync(DIV)) { const raw = JSON.parse(fs.readFileSync(DIV, 'utf8')); DV = raw.d || raw; }
    const stocks = []; let skipped = 0, divSkip = 0;
    for (const f of fs.readdirSync(DATA)) {
        if (!f.endsWith('.json') || f.startsWith('_') || f.startsWith('^') || f.startsWith('00')) continue;
        const sym = f.slice(0, -5); if (!/^\d{4}$/.test(sym)) continue;           // 只收四碼普通股
        let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { skipped++; continue; }
        if (!Array.isArray(raw) || raw.length < 120) { skipped++; continue; }
        const rows = raw.map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume, fn: r.foreign_net, tn: r.trust_net })).filter(r => r.c > 0 && r.o > 0 && idx.has(r.d));
        const S = prepStock(sym, rows, cal, (DV[sym] || {}).h || []);
        if (process.env.FLOWS) {                               // V78.0.5 fsync 才用(外資 / 投信買賣超;null = 沒資料)
            S.FN = new Float64Array(cal.length).fill(NaN); S.TN = new Float64Array(cal.length).fill(NaN);
            for (const r of rows) { const k = idx.get(r.d); if (r.fn != null && r.fn !== '') S.FN[k] = +r.fn; if (r.tn != null && r.tn !== '') S.TN[k] = +r.tn; }
        }
        divSkip += S.divSkip; stocks.push(S);
    }
    const evMap = f => { if (!f || !fs.existsSync(f)) return null; const j = JSON.parse(fs.readFileSync(f, 'utf8')); const m = new Map(); let n = 0;
        for (const [sym, ds] of Object.entries(j)) { const a = []; for (const d of ds) { const d10 = String(d).slice(0, 10); let k = idx.get(d10); if (k === undefined) { k = cal.findIndex(x => x > d10); if (k < 0) continue; k -= 0.5; } a.push(k); n++; } a.sort((x, y) => x - y); m.set(sym, a); } m.n = n; return m; };
    const att = evMap(process.env.ATT_EVENTS), disp = evMap(process.env.DISP_EVENTS);
    // V78.0.5 處置期間 {sym:[[公告日, 開始, 結束]]}(dispo_probe log 的 D| 行)→ 索引;公告日非交易日 = 下一個交易日 − 0.5,結束日 = 那天或之前最近的交易日
    let dper = null, dperN = 0;
    if (process.env.DISP_PERIODS && fs.existsSync(process.env.DISP_PERIODS)) {
        dper = new Map();
        const j = JSON.parse(fs.readFileSync(process.env.DISP_PERIODS, 'utf8'));
        const aIdx = d => { let k = idx.get(d); if (k === undefined) { k = cal.findIndex(x => x > d); if (k < 0) return null; k -= 0.5; } return k; };
        const eIdx = d => { let k = idx.get(d); if (k !== undefined) return k; let z = -1; for (let t = 0; t < cal.length && cal[t] <= d; t++) z = t; return z >= 0 ? z : null; };
        for (const [sym, arr] of Object.entries(j)) { const a = []; for (const [an, s, e] of arr) { const A = aIdx(an), E = eIdx(e); if (A == null || E == null) continue; a.push({ a: A, s: aIdx(s), e: E }); dperN++; } a.sort((x, y) => x.a - y.a); dper.set(sym, a); }
    }
    let themes = null, bySym = null;
    if (process.env.THEMES_SRC && fs.existsSync(process.env.THEMES_SRC)) { themes = parseThemes(fs.readFileSync(process.env.THEMES_SRC, 'utf8')); bySym = new Map(stocks.map(S => [S.sym, S])); }
    let ind = null; if (process.env.IND_MAP && fs.existsSync(process.env.IND_MAP)) ind = JSON.parse(fs.readFileSync(process.env.IND_MAP, 'utf8'));
    let fin = null;
    let accHi = null;
    if (process.env.FIN_DEEP && fs.existsSync(process.env.FIN_DEEP)) {
        const FD = JSON.parse(fs.readFileSync(process.env.FIN_DEEP, 'utf8')); const cache = new Map(); fin = sym => { if (!cache.has(sym)) cache.set(sym, finSeries(FD, sym)); return cache.get(sym); };
        if (ind) {   // 💵 V79.0.7 應計門檻要排除金融股(銀行的營業現金流沒意義)→ 沒有產業表就不建(need() 會擋)
            const P = valuePrep(FD), ACC = new Map();
            for (const S of stocks) { if (String(ind[S.sym] || '') === '17') continue; const a = accrualSeries(FD, S.sym, P); if (a.length) ACC.set(S.sym, a); }
            const cut = accrualMonthCut(ACC, 0.6, 100);
            accHi = (sym, day) => accrualHiAt(ACC, cut, sym, day);
        }
    }
    return { cal, stocks, etf: { tr }, bear, att, disp, dper, ind, fin, accHi, themes, bySym, meta: { themes: themes ? themes.length : 0,  stocks: stocks.length, skipped, divSkip, d50: d50.length, att: att ? att.n : 0, disp: disp ? disp.n : 0, dper: dperN, ind: ind ? Object.keys(ind).length : 0, fin: !!fin, flows: !!process.env.FLOWS } };
}

// ⚠️ 起點間距預設 3(⛔ 不是 5):換倉每 R 天一次,間距 5 碰上 R=10 只會有 2 種換倉相位,17 條其實只有 2 條獨立路徑(實測當場抓到)。
//   3 跟 5、10、20 互質 → 17 條涵蓋所有相位。
const STEP = +(process.env.PATH_STEP || 3);
function runSet(ctx, name, cfg, startDate, paths = 17) {
    const s0 = ctx.cal.findIndex(d => d >= startDate);
    const res = [];
    for (let k = 0; k < paths; k++) {
        const s = s0 + STEP * k;
        const r = simulate(ctx, s, cfg, 1000 + k + (cfg.seedOff || 0) * 100);
        const trS = Array.from(ctx.etf.tr.slice(s, s + r.eq.length));
        res.push({ ...r, m: metrics(r.eq, trS), y: yearly(r.eq, trS, ctx.cal.slice(s, s + r.eq.length)) });
        // 🗓️ V77.8.9 EQ_DIR:逐日淨值吐成 month_probe.mjs 讀的格式({warmup, rows:[{d,cash,park,mv}]},本金 100 萬)
        if (process.env.EQ_DIR) {
            fs.mkdirSync(process.env.EQ_DIR, { recursive: true });
            fs.writeFileSync(`${process.env.EQ_DIR}/eq_${k}.json`, JSON.stringify({ warmup: k, rows: r.eq.map((v, i) => ({ d: ctx.cal[s + i], cash: v * 1e6, park: 0, mv: 0 })) }));
        }
    }
    const med = f => r2(median(res.map(f)));
    const years = Object.keys(res[0].y);
    // 🌱 小資金模式:另外算「同樣的錢、同樣每月投入,全部買 0050 含息」(一樣整數以外的最低手續費)—— 看的是最後剩幾元
    let cap = null;
    if (cfg.capital > 0) {
        const tr = ctx.etf.tr, mf = cfg.minFee ?? DEF.minFee, fee = a => Math.max(mf, a * FEE);
        const bRes = res.map((r, k) => {
            const s = s0 + STEP * k, e = s + r.eq.length - 1;
            let units = (cfg.capital - fee(cfg.capital)) / tr[s];
            for (let i = s + 1; i <= e; i++) if ((cfg.add || 0) > 0 && ctx.cal[i].slice(0, 7) !== ctx.cal[i - 1].slice(0, 7)) units += (cfg.add - fee(cfg.add)) / tr[i];
            return units * tr[e];
        });
        cap = { capital: cfg.capital, add: cfg.add || 0, fin: r2(median(res.map(r => r.eq.at(-1)))), worstFin: r2(Math.min(...res.map(r => r.eq.at(-1)))),
                contrib: r2(median(res.map(r => r.contributed))), b0050fin: r2(median(bRes)), beatFin: res.filter((r, k) => r.eq.at(-1) > bRes[k]).length,
                glided: res.filter(r => r.glideAt !== null).length };
    }
    return { name, cfg, from: startDate, paths, cap,
        tot: med(r => r.m.tot), b0050: med(r => r.m.b0050), ex: med(r => r.m.ex), cagr: med(r => r.m.cagr), mdd: med(r => r.m.mdd), mdd0050: med(r => r.m.mdd0050),
        beat: res.filter(r => r.m.ex > 0).length, worstEx: r2(Math.min(...res.map(r => r.m.ex))), roll12: med(r => r.m.roll12), worstYr: r2(Math.min(...res.map(r => Math.min(...Object.values(r.y).map(v => v.s - v.c))))), yrBeat: med(r => Object.values(r.y).filter(v => v.s > v.c).length),
        forced: med(r => r.st.forced), rebought: med(r => r.st.rebought), sellRate: r2(res.reduce((a, r) => a + r.st.forced, 0) / Math.max(1, res.reduce((a, r) => a + r.st.posDays, 0)) * 1e4),
        passRate: (() => { const T = res.reduce((a, r) => a + r.st.fTot, 0); return T ? r2(res.reduce((a, r) => a + r.st.fPass, 0) / T * 100) : null; })(), finMiss: med(r => r.st.finMiss), accCut: med(r => r.st.accCut), accUnk: med(r => r.st.accUnk), accDropRate: (() => { const K = res.reduce((a, r) => a + r.st.accKnown, 0); return K ? r2(res.reduce((a, r) => a + r.st.accCut, 0) / K * 100) : null; })(),
        eqEnd: res.map(r => r2(r.m.tot)),
        lu: cfg.luExit ? { lock: med(r => r.st.luLock), hold: med(r => r.st.luHold), open: med(r => r.st.luOpen), close: med(r => r.st.luClose) } : null,
        trades: med(r => r.trades), win: med(r => r.win * 100), avg: med(r => r.avg * 100), turnYr: med(r => r.turnover / ((r.eq.length - 1) / 244)),
        years: Object.fromEntries(years.map(y => [y, { s: med(r => r.y[y]?.s ?? NaN), c: med(r => r.y[y]?.c ?? NaN) }])) };
}

/**
 * 📅 V78.0.8 逐年成績單(給 pro.html `_YEARLY_BT`,跟 yearly_bt.mjs 同一組欄位):
 *   每一年 1 月第 0/5/10/15/20 個交易日各放 100 萬(真實股數模式 capital=1e6)、跑到那一年最後一個交易日收盤,
 *   年底還抱著的以**年底收盤市值**算(👑 沒有「抱到出場」這回事 → 跟 🧬 那些列的口徑不同,畫面要寫)。
 *   主數字 = 起點 0;另外 4 個起點只給「換個起點最好 / 最差」。
 */
export function yearlyRuns(ctx, cfg, years, offsets = [0, 5, 10, 15, 20]) {
    const out = {}, yb = {};
    for (const y of years) {
        const first = ctx.cal.findIndex(d => d >= `${y}-01-01`); let last = -1;
        for (let k = ctx.cal.length - 1; k >= 0; k--) if (ctx.cal[k] <= `${y}-12-31`) { last = k; break; }
        if (first < 0 || last < first) { out[y] = null; continue; }
        const rs = offsets.map(o => {
            const s = first + o; if (s > last) return null;
            const r = simulate(ctx, s, { ...cfg, capital: 1e6, endIdx: last }, 1000 + o);
            let pk = -Infinity, dd = 0; for (const v of r.eq) { pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
            const pnl = r.eq.at(-1) - 1e6;
            return { pnl, dd: dd * 100, r, s };
        });
        const r0 = rs[0]; if (!r0) { out[y] = null; continue; }
        const pn = rs.filter(Boolean).map(x => x.pnl), R = r0.r;
        out[y] = { n: R.trades, win: R.win == null ? null : r2(R.win * 100), per: R.avg == null ? null : r2(R.avg * 100), pnl: Math.round(r0.pnl), ret: r2(r0.pnl / 1e4),
            perAmt: R.trades ? Math.round(R.sumAmt / R.trades) : null, worst: R.worstAmt == null ? null : Math.round(R.worstAmt), best: R.bestAmt == null ? null : Math.round(R.bestAmt),
            dd: r2(r0.dd), lo: Math.round(Math.min(...pn)), hi: Math.round(Math.max(...pn)), cross: 0, held: R.held, from: ctx.cal[r0.s], to: ctx.cal[last], paths: pn.length };
        const tr = ctx.etf.tr, s0 = r0.s;
        yb[y] = { e0050tr: r2((tr[last] / tr[s0] - 1) * 100), from: ctx.cal[s0], to: ctx.cal[last] };
    }
    return { y: out, yb };
}
/** 🏦 一個帳戶一路滾(17 條起點,同 runSet 的 STEP)→ 跟 yearly_bt 的 `c` 同一組欄位(賺賠 = 最後市值 − 100 萬) */
export function contRuns(ctx, cfg, from, paths = 17) {
    const s0 = ctx.cal.findIndex(d => d >= from);
    const rs = [];
    for (let k = 0; k < paths; k++) {
        const s = s0 + STEP * k, r = simulate(ctx, s, { ...cfg, capital: 1e6 }, 1000 + k);
        const trS = Array.from(ctx.etf.tr.slice(s, s + r.eq.length));
        rs.push({ fin: r.eq.at(-1) - 1e6, m: metrics(r.eq, trS), win: r.win, n: r.trades });
    }
    const md = a => median(a);
    return { med: Math.round(md(rs.map(x => x.fin))), lo: Math.round(Math.min(...rs.map(x => x.fin))), hi: Math.round(Math.max(...rs.map(x => x.fin))),
        dd: r2(md(rs.map(x => x.m.mdd))), ddw: r2(Math.min(...rs.map(x => x.m.mdd))), win: r2(md(rs.map(x => x.win * 100))), n: Math.round(md(rs.map(x => x.n))),
        paths, from: ctx.cal[s0], to: ctx.cal.at(-1), e0050tr: r2(md(rs.map(x => x.m.b0050))) };
}

/** 🪜 一檔 ETF 在 17 個起點(同 runSet 的 STEP)買了放著到最後一天的含息報酬中位;sym=0050 直接用 ctx.etf.tr(= 策略的 b0050,同一把尺) */
export function etfPaths(ctx, DATA, sym, divs, s0, e, paths = 17) {
    let tr = ctx.etf.tr;
    if (divs !== null) {
        const bars = loadPx(DATA, sym); if (!bars || !bars.length) return { sym, err: '沒有 K 線' };
        const t = trSeries(bars, divs), m = new Map(t.d.map((d, i) => [d, t.v[i]]));
        tr = new Float64Array(ctx.cal.length).fill(NaN); let last = NaN;
        for (let i = 0; i < ctx.cal.length; i++) { if (m.has(ctx.cal[i])) last = m.get(ctx.cal[i]); if (ctx.cal[i] >= bars[0].d) tr[i] = last; }
    }
    const rets = [], dds = [];
    for (let k = 0; k < paths; k++) {
        const s = s0 + STEP * k; if (!(tr[s] > 0)) return { sym, err: '上市晚於窗口起點' };
        let pk = tr[s], dd = 0;
        for (let i = s + 1; i <= e; i++) { const v = tr[i]; if (!(v > 0)) continue; if (tr[i - 1] > 0 && Math.abs(v / tr[i - 1] - 1) > 0.25) return { sym, err: `資料斷崖(${ctx.cal[i]})` }; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
        rets.push((tr[e] / tr[s] * (1 - FEE) - 1) * 100); dds.push(dd * 100);
    }
    return { sym, tot: r2(median(rets)), lo: r2(Math.min(...rets)), hi: r2(Math.max(...rets)), mdd: r2(median(dds)) };
}

function selftest() {
    // ⚠️ V78.0.5 預設加了「一年位置 ≥85 才買」—— 下面是機制測試(合成 K 線湊不出一年位置),先關掉,位置濾網由 ㉖ 單獨測
    DEF.posMin = 0;
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 200, cal = Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(2023, 0, 2 + i)); return d.toISOString().slice(0, 10); });
    const mk = (sym, f) => prepStock(sym, cal.map((d, i) => { const c = f(i); return { d, o: c, h: c * 1.005, l: c * 0.995, c, v: 1e7 }; }), cal, []);
    const flat = { tr: new Float64Array(n).fill(1) };
    // ① 零前視:A 在 i=120 開盤突然 +50%(收盤之前看不到),B 一路緩漲 → 第 119 天收盤決策只能選到 B
    const A = mk('1111', i => 100 + i * 0.05), B = mk('2222', i => 100 + i * 0.3);
    A.O[120] = A.C[119] * 1.5;
    const ctx = { cal, stocks: [A, B], etf: flat, bear: new Uint8Array(n) };
    const r = simulate(ctx, 115, { U: 2, N: 1, R: 5, L: 20, chand: 0, park: false, trend: false });
    t(r.eq.length === n - 115 && r.trades === 0 && Math.abs(r.eq.at(-1) / r.eq[1] - B.C[n - 1] / B.C[116]) < 0.02, '① 決策只用收盤前看得到的:選 B(緩漲最多),不會被 A 隔天的開盤跳空影響');
    // ② 成本:買進後立刻價格不變,一買一賣扣 2×0.1425% + 0.3%
    const C1 = mk('3333', () => 100);
    const ctx2 = { cal, stocks: [C1], etf: flat, bear: new Uint8Array(n) };
    const r2_ = simulate(ctx2, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(Math.abs(r2_.eq[r2_.eq.length - 1] - 1 / (1 + FEE)) < 1e-9, '② 買進成本 0.1425%(持有不賣時淨值 = 1 ÷ 1.001425)');
    // ③ 吊燈:漲到 150 後跌到 140(ATR≈1)→ 賣
    const D = mk('4444', i => i < 100 ? 100 : i < 130 ? 100 + (i - 100) * 1.0 : 130 - (i - 130) * 0.5);   // 緩跌(⛔ 不可觸發斷崖出場,否則替吊燈過關)
    const ctx3 = { cal, stocks: [D], etf: flat, bear: new Uint8Array(n) };
    const r3 = simulate(ctx3, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 2, park: false, trend: false, pick: 'all' });
    const r3b = simulate(ctx3, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(r3.trades === 1 && r3.jumpExit === 0 && r3b.trades === 0 && r3.eq.at(-1) > r3b.eq.at(-1), '③ 吊燈 ATR 2 倍:從最高收盤回落超過 2×ATR 就收盤賣(對照:不用吊燈就一直抱著、淨值比較低)');
    // ④ 除權息:當天份數 × 倍數,淨值不掉
    const E = prepStock('5555', cal.map((d, i) => { const c = i < 150 ? 100 : 95; return { d, o: c, h: c * 1.005, l: c * 0.995, c, v: 1e7 }; }), cal, [[cal[150], 5, '息', 100, 95]]);
    const r4 = simulate({ cal, stocks: [E], etf: flat, bear: new Uint8Array(n) }, 140, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(r4.eq[5] < 0.999 && Math.abs(r4.eq[r4.eq.length - 1] - r4.eq[5]) < 1e-9 && E.F[150] > 1.05, '④ 除息日:份數 × (100/95),淨值不會因為除息假跌(⭐ 先確認真的有買進:淨值扣過買進成本)');
    // ⑤ sham 固定種子可重現
    const many = Array.from({ length: 20 }, (_, k) => mk(String(6000 + k), i => 100 + i * (0.1 + k * 0.01)));
    const ctx5 = { cal, stocks: many, etf: flat, bear: new Uint8Array(n) };
    const a1 = simulate(ctx5, 100, { U: 20, N: 3, R: 5, L: 20, chand: 0, park: false, trend: false, pick: 'sham' }, 7), a2 = simulate(ctx5, 100, { U: 20, N: 3, R: 5, L: 20, chand: 0, park: false, trend: false, pick: 'sham' }, 7);
    t(a1.eq.at(-1) === a2.eq.at(-1), '⑤ 安慰劑固定種子 → 結果一模一樣');
    // ⑥ 動能排名:漲最多的那 3 檔(k=17,18,19)會被選到 → 報酬高於 sham
    const m1 = simulate(ctx5, 100, { U: 20, N: 3, R: 5, L: 20, chand: 0, park: false, trend: false }, 7);
    t(m1.eq.at(-1) > a1.eq.at(-1), '⑥ 動能排名挑到漲最多的,贏安慰劑');
    // ⑦ 開盤接近漲停買不到
    const G = mk('7777', i => 100 + i * 0.5); G.O[101] = G.C[100] * 1.099;
    const r7 = simulate({ cal, stocks: [G], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(r7.skipLimit === 1 && r7.eq.at(-1) === 1, '⑦ 開盤接近漲停 → 不買(跟 portfolio_backtest 同一條)');
    // ⑧ 大盤空頭不開新倉
    const bearAll = new Uint8Array(n).fill(1);
    const r8 = simulate({ cal, stocks: [B], etf: flat, bear: bearAll }, 100, { U: 1, N: 1, R: 5, L: 20, chand: 0, park: false, trend: false });
    t(r8.eq.at(-1) === 1, '⑧ 大盤嚴格空頭 → 一檔都不買');
    // ⑨ 閒錢停 0050:0050 漲 10%,沒股票可買 → 淨值 ≈ +10% 扣成本
    const trUp = new Float64Array(n).map((_, i) => 1 + (i >= 101 ? 0.1 * (i - 100) / 99 : 0));
    const r9 = simulate({ cal, stocks: [], etf: { tr: trUp }, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1, L: 20, chand: 0, park: true, trend: false });
    t(r9.eq.at(-1) > 1.09 && r9.eq.at(-1) < 1.1, '⑨ 閒錢停 0050:0050 漲 10% 時淨值跟著漲(扣買進成本)');
    // ⑩ 資料斷崖:單日 −40% → 用前一天收盤出場
    const J = mk('8888', i => i < 150 ? 100 : 60);
    const r10 = simulate({ cal, stocks: [J], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(r10.jumpExit === 1 && r10.eq.at(-1) > 0.99, '⑩ 單日跳超過漲跌幅限制 = 資料斷崖 → 前一天收盤出場,⛔ 不吃那個假跌幅');
    // ⑪ 停利:漲到 +5% 隔天開盤賣
    const T = mk('9991', i => i < 100 ? 100 : 100 + (i - 100) * 0.4);
    const r11 = simulate({ cal, stocks: [T], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all', tp: 0.05 });
    t(r11.trades === 1 && r11.win === 1 && r11.avg > 0.04 && r11.avg < 0.07, '⑪ 停利 5%:收盤賺到 5% 就隔天開盤賣(每筆約 +5%)');
    // ⑫ 跌破 20 日線隔天賣
    const M = mk('9992', i => i < 130 ? 100 + i * 0.5 : 165 - (i - 130) * 0.8);
    const r12 = simulate({ cal, stocks: [M], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all', maExit: 20 });
    const r12b = simulate({ cal, stocks: [M], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(r12.trades === 1 && r12b.trades === 0 && r12.eq.at(-1) > r12b.eq.at(-1), '⑫ 跌破 20 日線隔天開盤賣(對照:不設就抱到底、淨值較低)');
    // ⑬ core=0.5:一半永遠在 0050 → 0050 漲 10% 股票不動時淨值約 +5%
    const r13 = simulate({ cal, stocks: [C1], etf: { tr: trUp }, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: true, trend: false, pick: 'all', core: 0.5 });
    t(r13.eq.at(-1) > 1.04 && r13.eq.at(-1) < 1.06, '⑬ core 0.5:永遠留一半在 0050(0050 +10%、股票不動 → 淨值約 +5%)');
    // ⑭ 隔天收盤成交:第 100 天收盤決策 → 第 101 天收盤買(不是開盤)
    const Q = mk('9993', i => 100 + i * 0.5); Q.O[101] = Q.C[100] * 0.95;   // 開盤特別低 → 開盤成交會比較便宜
    const q1 = simulate({ cal, stocks: [Q], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all', fill: 'open' });
    const q2 = simulate({ cal, stocks: [Q], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all', fill: 'nextclose' });
    t(q1.eq.at(-1) > q2.eq.at(-1) && Math.abs(q2.eq[1] - 1 / (1 + FEE)) < 1e-9, '⑭ fill=nextclose:隔天收盤才成交(開盤那個便宜價拿不到;成交那天收盤淨值 = 1 ÷ 1.001425)');
    // ⑮ 事件濾網:只認決策日「之前」的公告
    t(evWithin([95], 100, 5) === true && evWithin([100], 100, 5) === false && evWithin([90], 100, 5) === false && evWithin([98, 100], 100, 3) === true, '⑮ evWithin:決策日當天的公告⛔ 不算(收盤後才公告);之前 k 天內才算');
    const ctxE = { cal, stocks: [B], etf: flat, bear: new Uint8Array(n), att: new Map([['2222', [98]]]) };
    const e1 = simulate(ctxE, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, noAtt: 3 });
    const e2 = simulate({ ...ctxE, att: new Map([['2222', [100]]]) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, noAtt: 3 });
    t(e1.eq.at(-1) === 1 && e2.eq.at(-1) !== 1, '⑯ noAtt:兩天前被公告注意 → 不買;決策日當天才公告 → 照買(那時還看不到)');
    // ⑰ 小資金:整數股 + 最低手續費 20 元 → 1 萬本金買 100 元的股票只能買 99 股(不是 99.86 股),手續費 20 元(不是 14.1 元)
    const K = mk('9994', () => 100);
    const k1 = simulate({ cal, stocks: [K], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all', capital: 10000 });
    t(Math.abs(k1.eq.at(-1) - (10000 - 99 * 100 - 20 + 99 * 100)) < 1e-6, `⑰ capital:整數股 99 股 + 手續費 20 元 → 市值 ${k1.eq.at(-1)}(期望 9980)`);
    // ⑱ 每月投入:本金 1 萬、每月 +1,000 → 投入總額要算對;沒買股票時錢在現金
    const k2 = simulate({ cal, stocks: [], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, capital: 10000, add: 1000 });
    const months = new Set(cal.slice(100).map(d => d.slice(0, 7))).size - 1;
    t(k2.contributed === 10000 + 1000 * months && Math.abs(k2.eq.at(-1) - k2.contributed) < 1e-6, `⑱ add:${months} 個月各投入 1,000 → 投入總額 ${k2.contributed}、沒交易時市值 = 投入總額`);
    // ⑲ 先衝再穩:翻倍前全部買股票、翻倍後新買的只用一半(glideAt 有記下來);不設時一律 null
    const U2 = mk('9995', i => 100 * Math.pow(1.01, Math.max(0, i - 100)));
    const g1 = simulate({ cal, stocks: [U2], etf: { tr: new Float64Array(n).fill(1) }, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 5, L: 20, chand: 0, park: true, trend: false, pick: 'all', glide: 1.5, hyst: 0 });
    const g0 = simulate({ cal, stocks: [U2], etf: { tr: new Float64Array(n).fill(1) }, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 5, L: 20, chand: 0, park: true, trend: false, pick: 'all', hyst: 0 });
    t(g1.glideAt !== null && g0.glideAt === null && g1.eq.at(-1) < g0.eq.at(-1), '⑲ glide 1.5:市值到 1.5 倍之後手上的砍一半、之後只用一半錢(持續上漲的股票 → 最後比全攻少賺)');
    // ⑳~㉖ V78.0.5 處置 / 候選濾網
    const base0 = { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' };
    const Dn = mk('9996', () => 100); Dn.O[151] = 80; for (let k = 151; k < n; k++) { Dn.C[k] = 80; Dn.O[k] = 80; }
    Dn.O[151] = 80;
    const cD = a => ({ cal, stocks: [Dn], etf: flat, bear: new Uint8Array(n), dper: new Map([['9996', [{ a, s: a + 1, e: a + 10 }]]]) });
    const dnow = simulate(cD(150), 100, { ...base0, dispNow: true }), dor = simulate(cD(150), 100, { ...base0, dispOracle: 1 }), dnone = simulate(cD(150), 100, base0);
    t(dnow.st.forced === 1 && dor.st.forced === 1 && dor.eq.at(-1) > 0.95 && dnow.eq.at(-1) < 0.85 && dnone.st.forced === 0,
      `⑳ 處置公告在第 150 天收盤後:dispNow 第 151 天開盤才賣得掉(吃到跌 → ${r2(dnow.eq.at(-1))}),🔮 偷看一天的 oracle 第 150 天就賣(${r2(dor.eq.at(-1))});不設 = 不賣`);
    const dlate = simulate(cD(151), 100, { ...base0, dispNow: true });
    t(dlate.eq[51] === dnone.eq[51], '⑳b 零前視:第 151 天才公告 → 第 150 天收盤的決策⛔ 看不到(第 151 天的淨值跟不設時一樣)');
    const At = mk('9997', () => 100);
    const cA = ev => ({ cal, stocks: [At], etf: flat, bear: new Uint8Array(n), att: new Map([['9997', ev]]) });
    const a3 = simulate(cA([148, 149, 150]), 100, { ...base0, attSell: 3 }), a4 = simulate(cA([148, 149, 150]), 100, { ...base0, attSell: 4 }), aOld = simulate(cA([140, 149, 150]), 100, { ...base0, attSell: 3 });
    t(a3.st.forced === 1 && a4.st.forced === 0 && aOld.st.forced === 0 && simulate(cA([130, 149, 150]), 100, { ...base0, attSell: 3 }).st.forced === 0,
      '㉑ attSell 3:近 5 天被公告注意 3 次 → 賣;要 4 次 → 不賣;太早的那次不算(5 天窗)');
    const Rb = mk('9998', () => 100);
    const cR = { cal, stocks: [Rb], etf: flat, bear: new Uint8Array(n), dper: new Map([['9998', [{ a: 150, s: 151, e: 160 }]]]) };
    const rr = simulate(cR, 100, { ...base0, dispNow: true, rebuy: 'release' }), rn = simulate(cR, 100, { ...base0, dispNow: true, rebuy: 'none' });
    t(rr.st.rebought === 1 && rr.trades === 1 && rn.st.rebought === 0 && rr.eq.at(-1) < rn.eq.at(-1),
      '㉒ rebuy=release:第 160 天出關 → 第 161 天開盤買回(多一次買進成本);rebuy=none 就不買回');
    const Dr = mk('9999', i => i <= 150 ? 100 : 100 - (i - 150) * 2);
    const cDr = { cal, stocks: [Dr], etf: flat, bear: new Uint8Array(n), dper: new Map([['9999', [{ a: 150, s: 151, e: 170 }]]]) };
    const rd = simulate(cDr, 100, { ...base0, dispNow: true, rebuy: 'drop', rebuyDrop: 0.15 });
    t(rd.st.rebought === 1, '㉓ rebuy=drop:處置期間從賣掉那天收盤跌 ≥15% → 買回(第 158 天收盤 84 → 隔天開盤買)');
    const k0 = simulate({ cal, stocks: [B], etf: flat, bear: new Uint8Array(n) }, 100, { ...base0, pick: 'mom', shamKeep: 1e-9 });
    const k1b = simulate({ cal, stocks: [B], etf: flat, bear: new Uint8Array(n) }, 100, { ...base0, pick: 'mom', shamKeep: 1 });
    const kb = simulate({ cal, stocks: [B], etf: flat, bear: new Uint8Array(n) }, 100, { ...base0, pick: 'mom' });
    t(k0.eq.at(-1) === 1 && k1b.eq.at(-1) === kb.eq.at(-1) && k0.st.fTot > 0, '㉔ shamKeep:幾乎 0 → 一檔都不買;1 → 跟不設一模一樣(通過率有記)');
    {   // 💵 V79.0.7 accAvoid:判定 false → 跟不設一模一樣;true → 一檔都不買;null(不知道)→ 保留並計數
        const cA = h => ({ cal, stocks: [B], etf: flat, bear: new Uint8Array(n), accHi: () => h });
        const aF = simulate(cA(false), 100, { ...base0, pick: 'mom', accAvoid: true }), aT = simulate(cA(true), 100, { ...base0, pick: 'mom', accAvoid: true }), aN = simulate(cA(null), 100, { ...base0, pick: 'mom', accAvoid: true });
        t(aF.eq.at(-1) === kb.eq.at(-1) && aT.eq.at(-1) === 1 && aT.st.accCut > 0 && aN.eq.at(-1) === kb.eq.at(-1) && aN.st.accUnk > 0,
          '㊳ accAvoid:不在最高 40% → 跟不設一樣;在 → 不買;不知道 → 保留並計數(避雷型)');
    }
    const I1 = mk('1234', i => 100 + i * 0.4), I2 = mk('1235', i => 100 + i * 0.3), I3 = mk('1236', i => 100 + i * 0.2);
    const cI = { cal, stocks: [I1, I2, I3], etf: flat, bear: new Uint8Array(n), ind: { 1234: 'A', 1235: 'A', 1236: 'B' } };
    const ic = simulate(cI, 100, { U: 3, N: 2, R: 1000, L: 20, chand: 0, park: false, trend: false, indCap: 1 }), ic0 = simulate(cI, 100, { U: 3, N: 2, R: 1000, L: 20, chand: 0, park: false, trend: false });
    t(ic.eq.at(-1) < ic0.eq.at(-1), '㉕ indCap 1:同產業只買一檔(第 2 名跟第 1 名同產業 → 改買第 3 名 → 淨值較低)');
    const calL = Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2022, 0, 3 + i)).toISOString().slice(0, 10));
    const mkL = (sym, f) => prepStock(sym, calL.map((d, i) => { const c = f(i); return { d, o: c, h: c, l: c, c, v: 1e7 }; }), calL, []);
    const Up = mkL('1237', i => 100 + i), Dw = mkL('1238', i => 400 - i);
    t(Math.abs(pos252(Up, 299) - 100) < 1e-9 && Math.abs(pos252(Dw, 299)) < 1e-9 && Number.isNaN(pos252(Up, 200)), '㉖ 一年位置:一路漲 = 100、一路跌 = 0、不滿 252 天 = 沒有');
    // ㉗ V78.0.5 新預設「一年位置 ≥85 才買」(App 算法 = 原始收盤、不足一年就用現有天數,同 screener_miner pos252)
    const Cr = mkL('1239', i => i < 280 ? 300 - i * (200 / 280) : 100 + (i - 280) * 4), St = mkL('1240', i => 100 + i * 0.2);
    const cP = { cal: calL, stocks: [Cr, St], etf: { tr: new Float64Array(300).fill(1) }, bear: new Uint8Array(300) };
    const base27 = { U: 2, N: 1, R: 1000, L: 10, chand: 0, park: false, trend: false, bear: false };
    const p0 = simulate(cP, 289, { ...base27, posMin: 0 }), p85 = simulate(cP, 289, { ...base27, posMin: 85, posRaw: true });
    const w = calL.slice(289 - 251, 290).map((_, k) => Cr.C[289 - 251 + k]), exp = (Cr.C[289] - Math.min(...w)) / (Math.max(...w) - Math.min(...w)) * 100;
    t(Math.abs(pos252(Cr, 289, true) - exp) < 1e-9 && Math.abs(pos252(Up, 200, true) - 100) < 1e-9 && p0.eq.at(-1) > 1.2 && p85.eq.at(-1) < 1.05 && p85.st.fTot > 0,
        `㉗ 位置 ≥85(App 算法):動能第 1 名但位置只有 ${r2(pos252(Cr, 289, true))}% → 不買、改買第 2 名(淨值 ${r2(p0.eq.at(-1))} → ${r2(p85.eq.at(-1))});不滿一年用現有天數`);
    // ㉘ V78.0.8 endIdx(逐年成績單):跑到第 e 天就停 → 淨值 = 不停那一條的前 e−s0+1 天(逐位相同)
    const full = simulate(ctx5, 100, { U: 20, N: 3, R: 5, L: 20, chand: 0, park: false, trend: false }, 7);
    const cut = simulate(ctx5, 100, { U: 20, N: 3, R: 5, L: 20, chand: 0, park: false, trend: false, endIdx: 150 }, 7);
    t(cut.eq.length === 51 && cut.eq.every((v, k) => v === full.eq[k]) && full.eq.length === n - 100, `㉘ endIdx:停在第 150 天 → 淨值是完整那一條的前 51 天、一格不差(不設 = 跑到最後)`);
    // ㉙ 逐筆賺賠加起來 = 最後市值 − 本金(全部賣光、閒錢不放 0050 時)
    const cp = simulate(ctx5, 100, { U: 20, N: 3, R: 5, L: 20, chand: 0, park: false, trend: false, capital: 1e6, minFee: 20 }, 7);
    const shift = mk('9999', i => i < 150 ? 100 + i * 2 : 500 - (i - 150) * 3);   // 先漲最多、後面跌 → 一定會被換掉(賣出)
    const cS = { cal, stocks: [...many, shift], etf: flat, bear: new Uint8Array(n) };
    const cp2 = simulate(cS, 100, { U: 21, N: 1, R: 5, L: 20, chand: 0, park: false, trend: false, capital: 1e6, minFee: 20, endIdx: 190 }, 7);
    const gap = cp2.eq.at(-1) - 1e6 - cp2.sumAmt - cp2.openPnl;
    t(cp.trades >= 0 && cp2.trades >= 1 && cp2.worstAmt <= cp2.bestAmt && Math.abs(gap) < 1e-6,
        `㉙ 逐筆賺賠:${cp2.trades} 筆已賣(最差 ${Math.round(cp2.worstAmt)} ≤ 最好 ${Math.round(cp2.bestAmt)})+ 還抱著 ${cp2.held} 檔的帳面 = 最後市值 − 本金(差 ${gap.toExponential(1)})`);
    // ㉚ V78.2.0 luExit:第 130 天收盤鎖漲停 → 第 131 天開高 3%:gap0 開盤賣、gap5 不賣、all 開盤賣;開低 → all 收盤賣、gap0 不賣;一字鎖 → 都不賣
    const luCase = (o131, oneWord) => { const X = mk('5555', i => 100 + i * 0.1); const c129 = X.C[129];
        X.C[130] = c129 * 1.10; X.H[130] = X.C[130]; X.O[130] = c129; X.L[130] = c129;
        X.O[131] = X.C[130] * o131; X.H[131] = oneWord ? X.O[131] : X.O[131] * 1.01; X.L[131] = oneWord ? X.O[131] : X.O[131] * 0.97; X.C[131] = X.O[131] * 0.98;
        return { cal, stocks: [X], etf: flat, bear: new Uint8Array(n) }; };
    const cfgL = { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' };
    const lu = (c, m) => simulate(c, 100, { ...cfgL, luExit: m }).st;
    const u3 = luCase(1.03), a3g5 = lu(u3, 'gap5'), a3g0 = lu(u3, 'gap0'), a3all = lu(u3, 'all');
    const d2 = luCase(0.98), d2g0 = lu(d2, 'gap0'), d2all = lu(d2, 'all');
    const w1 = luCase(1.10, true), w1all = lu(w1, 'all');
    const none = simulate(u3, 100, cfgL);
    t(a3g0.luOpen === 1 && a3g5.luOpen === 0 && a3all.luOpen === 1 && d2g0.luOpen === 0 && d2all.luClose === 1 && w1all.luHold === 1 && w1all.luOpen + w1all.luClose === 0 && none.st.luLock === 0 && a3g0.luLock === 1,
        `㉚ luExit:開高 3% → gap0/all 開盤賣、gap5 不賣;開低 → all 收盤賣;一字鎖 → 抱;不設 → 連判斷都不跑`);
    // ㉛ V78.2.1 晚進場:phase=0 / join 不設 → 逐位相同;phase=3 'wait' 第一筆股票在第 7 天才買(之前錢在 0050);'now' 第 0 天收盤就決定
    const cfgJ = { U: 20, N: 3, R: 10, L: 20, chand: 0, park: true, trend: false };
    const j0 = simulate(ctx5, 100, cfgJ, 7), j00 = simulate(ctx5, 100, { ...cfgJ, phase: 0, join: '' }, 7);
    const jw = simulate(ctx5, 100, { ...cfgJ, phase: 3, join: 'wait' }, 7), jn = simulate(ctx5, 100, { ...cfgJ, phase: 3, join: 'now' }, 7);
    const jx = simulate(ctx5, 100, { ...cfgJ, phase: 3, join: '' }, 7);
    t(j0.eq.every((v, k) => v === j00.eq[k]) && jw.eq.length === j0.eq.length && jn.eq.length === j0.eq.length
        && jn.eq[2] !== jw.eq[2] && jw.eq.slice(0, 8).join() !== jn.eq.slice(0, 8).join() && jx.eq[1] === 1,
        `㉛ 晚進場:不設逐位相同;phase 3 'now' 當天就買、'wait' 前幾天錢停 0050(第 2 天淨值 ${r2(jw.eq[2])} vs ${r2(jn.eq[2])});沒設 join 前幾天是現金`);
    // ㉜ V78.2.2 怎麼買:A 第 1 名、隔天開盤漲停(收盤打開 +3%)、B 第 2 名 —— 預設跳過不補;limitRepl 換買 B;limitRetry 收盤買 A;sameclose 當天收盤買 A;pickFrom 1 只買 B
    const mkB = () => { const A2 = mk('7001', i => 100 + i * 0.6), B2 = mk('7002', i => 100 + i * 0.3); A2.O[116] = A2.C[115] * 1.099; A2.C[116] = A2.C[115] * 1.03; return { cal, stocks: [A2, B2], etf: flat, bear: new Uint8Array(n) }; };
    const cfgB = { U: 2, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false };
    const b0 = simulate(mkB(), 115, cfgB), b00 = simulate(mkB(), 115, { ...cfgB, limitRepl: false, limitRetry: '', pickFrom: 0 });
    const bR = simulate(mkB(), 115, { ...cfgB, limitRepl: true }), bT = simulate(mkB(), 115, { ...cfgB, limitRetry: 'close' });
    const cB = mkB(), bS = simulate(cB, 115, { ...cfgB, fill: 'sameclose' }), bP = simulate(mkB(), 115, { ...cfgB, pickFrom: 1 });
    const A2 = cB.stocks[0], B2 = cB.stocks[1], endR = r => r.eq.at(-1);   // 起點 = 1(sameclose 會在第一天就買,eq[0] 已扣手續費)
    t(b0.skipLimit === 1 && b0.eq.at(-1) === 1 && b0.eq.every((v, k) => v === b00.eq[k])
        && bR.st.repl === 1 && Math.abs(endR(bR) - B2.C[n - 1] / B2.O[116] / (1 + FEE)) < 1e-6
        && bT.st.retried === 1 && Math.abs(endR(bT) - A2.C[n - 1] / A2.C[116] / (1 + FEE)) < 1e-6
        && bS.skipLimit === 0 && Math.abs(endR(bS) - A2.C[n - 1] / A2.C[115] / (1 + FEE)) < 1e-6
        && Math.abs(endR(bP) - B2.C[n - 1] / B2.O[116] / (1 + FEE)) < 1e-6,
        `㉜ 怎麼買:漲停預設跳過不補(不設逐位相同)・換下一名買到 B・等收盤買到 A・當天收盤買 A・只買第 2 名起 = B`);
    // ㉝ V78.2.6 dip:X 第 130 天收盤跌 4% → 第 131 天開盤買、第 135 天收盤賣(hold 5);池子用前一個月的成交值;不設 dip → 逐位相同;sham 檔數 = 訊號檔數
    const mkD = (bump) => { const ss = Array.from({ length: 6 }, (_, k) => mk(String(8000 + k), i => 100 * (6 - k) + i * 0.02));
        const X = ss[0]; for (let i = 130; i < n; i++) { X.C[i] *= 0.96; X.O[i] *= 0.96; X.H[i] *= 0.96; X.L[i] *= 0.96; }
        X.O[131] = X.C[130]; for (let i = 131; i < n; i++) { X.C[i] = X.C[130] * (1 + 0.01 * (i - 130)); if (i > 131) X.O[i] = X.C[i - 1]; }   // 買進後每天 +1%(一直漲 → 晚一天賣會被抓到;⛔ 不可再跌出第二個訊號)
        if (bump) for (let i = 125; i < n; i++) ss[5].V[i] = 1e12;                                           // 改「未來」的成交量
        return { cal, stocks: ss, etf: flat, bear: new Uint8Array(n) }; };
    const cfgD = { U: 3, N: 2, park: false, dip: 3, hold: 5 };
    const cDp = mkD(false), dpA = simulate(cDp, 100, cfgD), Xpp0 = cDp.stocks[0];
    const want = (Xpp0.C[135] / Xpp0.O[131]) * (1 - FEE - TAX) / (1 + FEE);                                     // 只動一格 = 淨值的一半
    const dpB = simulate(mkD(true), 100, cfgD);                                                               // 池子不可看到未來的量
    const pp0 = dipPoolOf(mkD(false), 130, 3).map(S => S.sym).join(), pp1 = dipPoolOf(mkD(true), 130, 3).map(S => S.sym).join();
    const dpS = simulate(mkD(false), 100, { ...cfgD, dipSort: 'sham' }, 3), dpN = simulate(mkD(false), 100, { ...cfgD, dip: 0 }), dpN0 = simulate(mkD(false), 100, { U: 3, N: 2, park: false });
    t(dpA.trades === 1 && Math.abs(dpA.eq.at(-1) - (0.5 + 0.5 * want)) < 1e-9 && dpA.eq.at(-1) === dpB.eq.at(-1) && pp0 === pp1 && pp0.includes('8000')
        && dpS.trades === 1 && dpS.st.dipSig === dpA.st.dipSig && dpN.eq.every((v, k) => v === dpN0.eq[k]),
        `㉝ dip:跌 4% 隔天開盤買、第 5 天收盤賣(淨值 ${r2(dpA.eq.at(-1) * 100)} = 預期)・池子不看未來的量・sham 同檔數・不設 dip 逐位相同`);
    // ㉝b 事件層級:X 那一筆的 v = 它 − 同一天池子平均(池子 3 檔、⛔ 少於 20 檔 → 不算,計 noCtrl)
    const epD = dipEvents(cDp, cal[100], { ...DEF, ...cfgD });
    t(epD.ev.length === 0 && epD.cnt.noCtrl >= 1, `㉝b 事件層級:對照不到 20 檔 → ⛔ 不算(noCtrl ${epD.cnt.noCtrl})`);
    // ㉞ V78.3.0 空頭季節:第 130~160 天是空頭;0050 一路漲(trUp)
    const bearSeg = new Uint8Array(n); for (let i = 130; i <= 160; i++) bearSeg[i] = 1;
    const ctxBe = { cal, stocks: [], etf: { tr: trUp }, bear: bearSeg }, cfgBe = { U: 1, N: 1, R: 1, L: 20, chand: 0, park: true, trend: false };
    const be0 = simulate(ctxBe, 100, cfgBe), be00 = simulate(ctxBe, 100, { ...cfgBe, bearCore: null, bearN: 0, bearTop: 0 });
    const beC = simulate(ctxBe, 100, { ...cfgBe, bearCore: 0 }), beH = simulate(ctxBe, 100, { ...cfgBe, bearCore: 0.5 });
    const E0 = k => beC.eq[k - 100];
    t(be0.eq.every((v, k) => v === be00.eq[k]) && E0(130) > E0(129) && E0(132) === E0(131) && E0(161) === E0(131) && E0(163) > E0(162)
        && beC.eq.at(-1) < be0.eq.at(-1) && beH.eq.at(-1) < be0.eq.at(-1) && beH.eq.at(-1) > beC.eq.at(-1),
        `㉞ bearCore:不設逐位相同・第 130 天變空頭、第 131 天收盤才換現金(晚一天)・空頭期間淨值不動・多頭回來再停回 0050・半防守介於兩者之間(${r2(beC.eq.at(-1))} < ${r2(beH.eq.at(-1))} < ${r2(be0.eq.at(-1))})`);
    const ctxBn = { cal, stocks: many, etf: flat, bear: bearSeg }, cfgBn = { U: 20, N: 3, R: 5, L: 20, chand: 0, park: false, trend: false };
    const bn0 = simulate(ctxBn, 100, cfgBn), bn1 = simulate(ctxBn, 100, { ...cfgBn, bearN: 1 });
    const ctxBt = { cal, stocks: many, etf: flat, bear: bearAll }, bt0 = simulate(ctxBt, 100, cfgBn), bt1 = simulate(ctxBt, 100, { ...cfgBn, bearTop: 1 });
    t(bn1.st.bearCut === 2 && !bn0.st.bearCut && bt0.trades === 0 && bt0.held === 0 && bt1.held === 1,
        `㉞b bearN 1:空頭時 3 檔砍成 1 檔(砍 ${bn1.st.bearCut})・bearTop 1:一路空頭現行不買、只追最強就只抱 1 檔`);
    // ㉟ V78.3.0 題材輪動:3 個題材 × 3 檔;T0 的成員漲最快 → themeK 1 只買得到 T0 的;安慰劑挑到別的;不設逐位相同
    const thS = [0, 1, 2].flatMap(t => [0, 1, 2].map(q => mk(String(9000 + t * 10 + q), i => 100 + i * (t === 0 ? 0.5 : 0.1) + q * 0.01)));
    const ctxT = { cal, stocks: thS, etf: flat, bear: new Uint8Array(n), themes: [0, 1, 2].map(t => ({ k: 'T' + t, syms: [0, 1, 2].map(q => String(9000 + t * 10 + q)) })), bySym: new Map(thS.map(S => [S.sym, S])) };
    const cfgT = { U: 9, N: 2, R: 5, L: 20, chand: 0, park: false, trend: false };
    const tA = simulate(ctxT, 100, { ...cfgT, pool: 'theme', themeK: 1 }), t0 = simulate(ctxT, 100, cfgT), t00 = simulate(ctxT, 100, { ...cfgT, pool: '' });
    const tSh = [1, 2, 3, 4, 5].map(sd => simulate(ctxT, 100, { ...cfgT, pool: 'theme', themeK: 1, themeSham: true }, sd));
    t(tA.st.themes.every(x => x === 'T0') && t0.eq.every((v, k) => v === t00.eq[k]) && !t0.st.themes && tSh.some(r => r.st.themes.some(x => x !== 'T0')) && tSh.every(r => r.eq.at(-1) <= tA.eq.at(-1) + 1e-12),
        `㉟ 題材輪動:動能最強的題材每次都被挑到(T0)・安慰劑會挑到別的題材且不比它好・不設逐位相同`);
    // ㊱ V78.4.4 log / intraPx:不設逐位相同・log 記到買與賣(賣 = 換倉掉出)・intraPx 換成盤中價 → 賣價 +2% 淨值跟著變・對不到退回開盤並計數
    const cfgLg = { U: 20, N: 3, R: 5, L: 20, chand: 0, park: false, trend: false };
    const ctxRot = { cal, stocks: Array.from({ length: 10 }, (_, k) => mk(String(6100 + k), i => 100 * (1 + 0.2 * Math.sin(i / 8 + k)) + i * 0.1)), etf: flat, bear: new Uint8Array(n) };
    const lg = [], l0 = simulate(ctxRot, 100, cfgLg, 7), l1 = simulate(ctxRot, 100, { ...cfgLg, log: lg }, 7);
    const sells = lg.filter(x => x.side === 'S'), buys = lg.filter(x => x.side === 'B');
    const mp = new Map(); for (const x of sells) mp.set(`${x.s}|${x.d}|S`, x.px * 1.02);
    const l2 = simulate(ctxRot, 100, { ...cfgLg, intraPx: mp }, 7), l3 = simulate(ctxRot, 100, { ...cfgLg, intraPx: new Map() }, 7);
    t(l0.eq.every((v, k) => v === l1.eq[k]) && buys.length > 0 && sells.length === l1.trades && sells.every(x => x.why === 'pend' && x.dd < x.d)
        && l2.st.ipxHit === sells.length && l2.eq.at(-1) > l0.eq.at(-1) && l3.st.ipxMiss > 0 && l3.eq.every((v, k) => v === l0.eq[k]),
        `㊱ log / intraPx:不設逐位相同・記到 ${buys.length} 買 ${sells.length} 賣・賣價換成 +2% → 淨值變高・對不到就照開盤(miss ${l3.st.ipxMiss})`);
    // ㊲ V78.6.3 期中換股:A 先漲最快(換倉日買 A),第 125 天起每天跌 3%(連 8 天;⛔ 一天跌 12% 會被當資料斷崖)→ stop 0.08 隔天開盤賣;refill 同一個收盤補 B;沒 refill 錢就空著;不設逐位相同
    const mkM = () => { const A3 = mk('5101', i => i < 125 ? 100 + i * 0.6 : (100 + 124 * 0.6) * Math.pow(0.97, Math.min(i - 124, 8))), B3 = mk('5102', i => 100 + i * 0.2);
        return { cal, stocks: [A3, B3], etf: flat, bear: new Uint8Array(n) }; };
    const cfgM = { U: 2, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false };
    const m0 = simulate(mkM(), 100, cfgM), m00 = simulate(mkM(), 100, { ...cfgM, dRank: 0, stop: 0, trail: 0, shamOut: 0, refill: false });
    const mS = simulate(mkM(), 100, { ...cfgM, stop: 0.08 }), mR = simulate(mkM(), 100, { ...cfgM, stop: 0.08, refill: true });
    const mT = simulate(mkM(), 100, { ...cfgM, trail: 0.08, refill: true }), mD = simulate(mkM(), 100, { ...cfgM, dRank: 1, refill: true });
    const mB = (() => { const c = mkM(); c.bear = new Uint8Array(n).fill(1); c.bear[100] = 0; return simulate(c, 100, { ...cfgM, stop: 0.08, refill: true }); })();
    const lgM = []; simulate(mkM(), 100, { ...cfgM, stop: 0.08, refill: true, log: lgM });
    const sellA = lgM.find(x => x.side === 'S' && x.s === '5101'), buyB = lgM.find(x => x.side === 'B' && x.s === '5102');
    t(m0.eq.every((v, k) => v === m00.eq[k]) && mS.st.midOut === 1 && mS.held === 0 && !mS.st.refill && mR.held === 1 && mR.st.refill === 1
        && sellA && buyB && sellA.d === buyB.d && sellA.d > cal[125] && mT.st.midOut === 1 && mT.held === 1 && mD.held === 1 && mB.held === 0 && mR.eq.at(-1) > mS.eq.at(-1),
        `㊲ 期中換股:不設逐位相同・跌破 8% 隔天開盤賣(${sellA && sellA.d})・refill 同一天開盤補 B・沒 refill 空著・trail / dRank 也觸發・空頭不補`);
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

function main() {
    const out = process.argv[2], DATA = process.env.DATA_DIR, DIV = process.env.DIV;
    if (!DATA) { console.error('要 DATA_DIR'); process.exit(1); }
    const t0 = Date.now();
    const ctx = loadCtx(DATA, DIV);
    console.log(`📅 事件:注意 ${ctx.meta.att} 筆・處置 ${ctx.meta.disp} 筆`);
    console.log(`📂 ${ctx.meta.stocks} 檔・日曆 ${ctx.cal[0]}~${ctx.cal.at(-1)}・0050 股利 ${ctx.meta.d50} 筆・除權息對不上排除 ${ctx.meta.divSkip}・${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (ctx.meta.stocks < 1000) { console.error('🚨 檔數 < 1000,拒跑'); process.exit(1); }
    if (ctx.meta.d50 < 10) { console.error('🚨 0050 股利 < 10 筆 → 對照組不含息會讓策略看起來比較好,拒跑'); process.exit(1); }
    const GRID = process.env.GRID ? JSON.parse(process.env.GRID) : null;   // {L:[..],chand:[..],N:[..],R:[..],U:[..]}
    const gridpSets = GRID ? (() => { const keys = Object.keys(GRID); let out = [{}]; for (const k of keys) out = out.flatMap(o => GRID[k].map(v => ({ ...o, [k]: v }))); return out.map(c => [keys.map(k => `${k}${c[k]}`).join('_'), c]); })() : null;
    const SETS = gridpSets || JSON.parse(process.env.SETS || 'null') || [
        ['★ 領頭羊短線輪動(10 日動能・前 100 大・5 檔・每 10 天)', {}],
        ['安慰劑:同池子同過濾隨機挑', { pick: 'sham' }],
        ['池子等權(不排名)', { pick: 'all' }],
        ['加吊燈 3 倍', { chand: 3 }],
        ['不用空頭守門', { bear: false }],
        ['閒錢放現金', { park: false }],
    ];
    const WINS = (process.env.WINS || '2022-09-16,2011-01-03').split(',');
    // 🚧 V78.0.5 空過守門:要事件 / 產業 / 財報 / 法人的變體,沒給資料 → ⛔ 不跑(否則會安靜地變成「什麼都沒做」= 跟基準一樣)
    const need = (k, has, what) => { if (SETS.some(([, c]) => c[k]) && !has) { console.error(`🚨 有變體用到 ${k} 但沒給 ${what},拒跑`); process.exit(1); } };
    need('dispNow', ctx.dper, 'DISP_PERIODS'); need('dispOracle', ctx.dper, 'DISP_PERIODS'); need('attSell', ctx.att, 'ATT_EVENTS');
    need('indCap', ctx.ind, 'IND_MAP'); need('finAcc', ctx.fin, 'FIN_DEEP'); need('accAvoid', ctx.accHi, 'FIN_DEEP + IND_MAP'); need('fsync', ctx.meta.flows, 'FLOWS=1');
    // 📅 V78.0.8 YEARLY_OUT=檔:只產「逐年成績單」那幾列(👑 四種做法 × 2011~今年 × 5 起點 + 一路滾 17 條)→ embed_yearly_bt.mjs --merge
    if (process.env.YEARLY_OUT) {
        const YS = JSON.parse(process.env.YEARLY_SETS || 'null') || [
            ['lead', '👑 領頭羊短線輪動(全攻):成交額前 100 大 ・10 日動能前 5 檔 ・每 10 天換 ・一年位置 ≥85% ・閒錢放 0050', {}],
            ['lead_stable', '👑 領頭羊・穩定版(一半永遠放 0050)', { core: 0.5 }],
            ['lead_glide', '👑 領頭羊・先衝再穩(帳戶翻倍後改穩定版)', { glide: 2 }],
            ['lead_close', '👑 領頭羊・尾盤成交(= 自動下單的做法)', { fill: 'nextclose' }],
        ];
        const from = process.env.YEARLY_FROM || '2011-01-03';
        const years = []; for (let y = +from.slice(0, 4); y <= +ctx.cal.at(-1).slice(0, 4); y++) years.push(String(y));
        const rows = [];
        for (const [id, t, cfg] of YS) {
            const t1 = Date.now();
            const Yr = yearlyRuns(ctx, cfg, years), c = contRuns(ctx, cfg, from);
            const bc = { from: c.from, to: c.to, e0050tr: c.e0050tr }; delete c.e0050tr;
            rows.push({ id, g: 'lead', t, cfg, c, y: Yr.y, yb: Yr.yb, bc });
            console.log(`📅 ${id}:一路滾中位 ${(c.med / 1e4).toFixed(1)} 萬(最差 ${(c.lo / 1e4).toFixed(1)}・回撤 ${c.dd}%)・` + years.map(y => `${y} ${Yr.y[y] ? Yr.y[y].ret + '%' : '—'}`).join(' ') + `・${((Date.now() - t1) / 1000).toFixed(0)}s`);
        }
        fs.writeFileSync(process.env.YEARLY_OUT, JSON.stringify({ asof: new Date().toISOString().slice(0, 10), data_to: ctx.cal.at(-1), years, rows }));
        return;
    }
    // 📉 V78.2.6 DIP_EVENT=1:熱門股跌 ≥k% 的**事件層級**(對照 = 同一天熱門池全部;六關沿用 maxim_kbar5_probe.gates)→ 不跑組合
    if (process.env.DIP_EVENT) {
        const ths = (process.env.DIP_THS || '2,3,4,5').split(',').map(Number), holds = (process.env.DIP_HOLDS || '5').split(',').map(Number), out2 = {};
        for (const w of WINS) for (const h of holds) for (const th of ths) {
            const { ev, cnt } = dipEvents(ctx, w, { ...DEF, dip: th, hold: h });
            const g = gates(ev, ev.map(e => e.raw), 1); out2[`${w}|${th}|${h}`] = { ...g, cnt };
            console.log(`[${w}] 📉 跌 ≥${th}% 抱 ${h} 天 ・n=${g.n} ・增量 ${g.inc}pp(t=${g.t})・扣成本絕對 ${g.abs}% ・六關 ${g.pass}/6 ・開盤漲停剔除 ${cnt.lock}`);
            console.log(`     逐年 ${JSON.stringify(g.years)} ・沒過:${Object.entries(g.gates || {}).filter(([, v]) => !v).map(([k]) => k).join('、') || '—'}`);
        }
        if (out) fs.writeFileSync(out, JSON.stringify(out2));
        return;
    }
    const res = { asof: new Date().toISOString().slice(0, 10), meta: ctx.meta, def: DEF, sets: [], etf: {} };
    // 🪜 V77.9.4 ETFS=0050,006208,…:每一檔 ETF「買了放著(含息)」用**跟策略同一組 17 個起點**算中位(⛔ 不從窗口第一天單算一次 ——
    //    那就是 0050 同期出現 375 / 342.7 / 349.9 三個數字的原因)。上市晚於起點 → 原因,⛔ 不硬比。
    if (process.env.ETFS) {
        let DV = {}; if (DIV && fs.existsSync(DIV)) { const raw = JSON.parse(fs.readFileSync(DIV, 'utf8')); DV = raw.d || raw; }
        for (const w of WINS) {
            const s0 = ctx.cal.findIndex(d => d >= w), e = ctx.cal.length - 1;
            res.etf[w] = process.env.ETFS.split(',').map(sym => etfPaths(ctx, DATA, sym, sym === '0050' ? null : ((DV[sym] || {}).h || []), s0, e));
            for (const x of res.etf[w]) console.log(`[${w}] 🪜 ${x.sym}:` + (x.err ? `⏳ ${x.err}` : `含息 ${x.tot}%(最差 ${x.lo}~最好 ${x.hi})・回撤 ${x.mdd}%`));
        }
    }
    for (const w of WINS) for (const [name, cfg] of SETS) {
        const R = runSet(ctx, name, cfg, w);
        res.sets.push(R);
        console.log(`[${w}] ${name}:總報酬 ${R.tot}% vs 0050 含息 ${R.b0050}%(超額 ${R.ex}pp,17 條贏 ${R.beat},最差 ${R.worstEx})・年化 ${R.cagr}% ・回撤 ${R.mdd}%(0050 ${R.mdd0050}%)・交易 ${R.trades} 筆 勝率 ${R.win}% 每筆 ${R.avg}% ・年換手 ${r2(R.turnYr)}x ・📈 滾動 12 月贏 0050 ${R.roll12}% ・贏 ${R.yrBeat}/${Object.keys(R.years).length} 年 最差年 ${R.worstYr}pp`);
        if (R.forced || R.passRate != null) console.log(`    🧪 強制賣 ${R.forced} 次(每萬持股日 ${R.sellRate})・買回 ${R.rebought} 次・候選通過率 ${R.passRate}%${R.finMiss ? `・財報沒資料剔除 ${R.finMiss}` : ''}`);
        if (R.lu) console.log(`    🟥 持股鎖漲停 ${R.lu.lock} 次(中位):一字鎖抱 ${R.lu.hold}・開盤賣 ${R.lu.open}・收盤賣 ${R.lu.close}`);
        console.log('    逐年 ' + Object.entries(R.years).map(([y, v]) => `${y} ${r2(v.s)}/${r2(v.c)}`).join(' ・'));
    }
    if (out) fs.writeFileSync(out, JSON.stringify(res));
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// ⭐ 被別的腳本 import(leader_exit_probe)時⛔ 不自己跑 main
const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
else if (_isMain) main();
