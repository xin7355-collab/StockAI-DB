/**
 * 📊 條件式機率引擎 —— 分桶與三分類的**唯一一份定義**(V77.4.6)
 *
 * 使用者:「我目前有那麼多種回測,我想你用機率計算每個個股他的預判上漲、平盤、下跌機率,
 *          機率我還是想要,幫我做」。
 *
 * ⭐⭐ 它是**歷史頻率查表**,⛔ **不是預測模型**:
 *   「歷史上處在同一個狀態的股·日,後來 N 天漲/平/跌各佔幾 %」——
 *   ⛔ 沒有權重、沒有分數、沒有模型(陷阱 #38:顯示給使用者的統計量⛔ 不可被沒驗證過的權重調整過)。
 *
 * ⛔ 六條不可改掉的設計:
 *   ① **平盤 = 扣掉來回成本還是等於沒賺沒賠**(使用者選的口徑):|毛報酬| ≤ 0.44%。
 *      → 「漲」的意思是「**扣完成本真的有賺**」,⛔ 不是「收紅」。
 *   ② **零前視**:進場 = **t+1 開盤**(訊號當天收盤才知道特徵,隔天才買得到);
 *      「創新高」的基準區間⛔ **不含今天**(陷阱 #43)。
 *      ⚠️ 位階 / 振幅 / 大盤 regime **含今天是對的** —— 那是「位置」不是「突破」。
 *   ③ **一定要有全市場基準率**:實測 20 日「漲 43.5 / 平 5.2 / 跌 51.3」——
 *      隨便買一檔台股扣完成本,**跌本來就比漲多**。⛔ 沒有基準率,44% 會被讀成「這檔很差」。
 *   ④ **樣本不足要說「樣本不足」**,⛔ 不補值、⛔ 不外插、⛔ 不跟隔壁格借。
 *   ⑤ **鎖漲停那天買不到** → 剔除(同本 repo 其他探針)。
 *   ⑥ **分桶公式改了,整張表就要重跑** —— 它跟程式碼綁(同 `_SIGNAL_EDGE`)。
 */

export const FLAT_BAND = 0.44;                 // ① 平盤帶(= 來回成本)
export const HORIZONS = [1, 3, 5, 10, 20];     // 幾個交易日之後
export const LIMIT_UP = 1.095;                 // ⑤ 鎖漲停判準(收盤 ≥ 昨收 ×1.095)

// ── 桶的定義(⛔ 改任何一個門檻都要重跑) ──
export const POS_CUTS  = [25, 50, 75];         // 一年位階(含今天,那是「位置」)
export const VOL_CUTS  = [33, 67];             // 20 日振幅在自己近一年的位階
export const POS_NAME  = ['谷底 (0~25%)', '偏低 (25~50%)', '偏高 (50~75%)', '高檔 (75~100%)'];
export const VOL_NAME  = ['溫吞', '普通', '很會跳'];
export const NH_NAME   = ['沒有創新高', '創 20~60 日新高', '創 120 日以上新高'];
export const MKT_NAME  = ['大盤在年線之上', '大盤在年線之下'];
export const LABELS    = ['漲', '平', '跌'];

/** 桶 id:pos(4) × vol(3) × nh(3) × mkt(2) = 72 格 */
export const N_CELLS = 4 * 3 * 3 * 2;
export const cellId = (pos, vol, nh, mkt) => ((pos * 3 + vol) * 3 + nh) * 2 + mkt;
export const cellParts = id => ({ mkt: id % 2, nh: (id / 2 | 0) % 3, vol: (id / 6 | 0) % 3, pos: (id / 18 | 0) % 4 });
export const cellName = id => {
    const p = cellParts(id);
    return `${POS_NAME[p.pos]} ・ ${VOL_NAME[p.vol]} ・ ${NH_NAME[p.nh]} ・ ${MKT_NAME[p.mkt]}`;
};

const bucket = (v, cuts) => { let b = 0; for (const c of cuts) if (v >= c) b++; return b; };

/**
 * 算出第 i 根 K 的特徵(⛔ 只吃到 i 為止的資料)。
 * @param {Array} R   [{o,h,l,c,v}]
 * @param {number} i
 * @param {number} mkt 0 = 大盤在年線之上 / 1 = 之下(呼叫端算好傳進來)
 * @returns {{pos,vol,nh,mkt,cell,posPct,volPct,nhN}|null}
 */
export function featuresAt(R, i, mkt) {
    if (!R || i < 250) return null;
    const c = R[i].c; if (!(c > 0)) return null;
    // ② 位階:一年高低(含今天 —— 那是「位置」不是「突破」)
    let hi = -Infinity, lo = Infinity;
    for (let q = i - 249; q <= i; q++) { if (R[q].h > hi) hi = R[q].h; if (R[q].l < lo) lo = R[q].l; }
    if (!(hi > lo)) return null;
    const posPct = (c - lo) / (hi - lo) * 100;
    // 20 日振幅 → 它在近一年(每 1 根一個樣本)裡的百分位
    const amp = j => { let s = 0, m = 0; for (let q = j - 19; q <= j; q++) { const cc = R[q].c; if (cc > 0) { s += (R[q].h - R[q].l) / cc; m++; } } return m ? s / m * 100 : null; };
    const a0 = amp(i); if (a0 == null) return null;
    //   ⚠️ 起點要 `max(19, …)` —— 振幅本身要往回看 20 根,i=250 時 i−249=1 會讀到負索引
    //      (⛔ 這個在 300 根的合成測資上測不出來,是實跑全市場當場炸掉才發現的)
    let below = 0, tot = 0;
    for (let q = Math.max(19, i - 249); q <= i; q++) { const a = amp(q); if (a == null) continue; tot++; if (a <= a0) below++; }
    if (tot < 100) return null;
    const volPct = below / tot * 100;
    // ② 創新高:基準區間⛔ 不含今天(陷阱 #43)
    let nh = 0, nhN = 0;
    for (const N of [120, 60, 20]) {
        let mx = -Infinity; for (let q = i - N; q < i; q++) if (R[q].h > mx) mx = R[q].h;
        if (isFinite(mx) && c > mx) { nhN = N; break; }
    }
    if (nhN >= 120) nh = 2; else if (nhN >= 20) nh = 1;
    const pos = bucket(posPct, POS_CUTS), vol = bucket(volPct, VOL_CUTS);
    return { pos, vol, nh, mkt, cell: cellId(pos, vol, nh, mkt), posPct, volPct, nhN };
}

/** ① 三分類:0=漲 1=平 2=跌(毛報酬,平盤帶 = 來回成本) */
export const labelOf = ret => (ret > FLAT_BAND ? 0 : (ret < -FLAT_BAND ? 2 : 1));

/**
 * ② 進場 = t+1 開盤;出場 = t+1+h 收盤。回 null = 這一根不能用(鎖漲停 / 資料不夠)。
 * @returns {{ret,mae,mfe}|null}
 */
export function outcomeAt(R, i, h) {
    const n = R.length;
    if (i + 1 + h >= n) return null;
    // ⑤ 訊號當天鎖漲停 → 隔天開盤多半跳空,那個價買不到 → 剔除
    if (i > 0 && R[i - 1].c > 0 && R[i].c >= R[i - 1].c * LIMIT_UP) return null;
    const e = R[i + 1].o; if (!(e > 0)) return null;
    const x = R[i + 1 + h].c; if (!(x > 0)) return null;
    let mn = Infinity, mx = -Infinity;
    for (let q = i + 1; q <= i + 1 + h; q++) { if (R[q].l < mn) mn = R[q].l; if (R[q].h > mx) mx = R[q].h; }
    return { ret: (x - e) / e * 100, mae: (mn - e) / e * 100, mfe: (mx - e) / e * 100 };
}
