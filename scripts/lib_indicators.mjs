/**
 * 🧪 指標函式庫 —— `indicator_zoo_probe`(全市場)與 `perstock_indicator_probe`(逐檔)**共用同一份**。
 * ⛔ 不可在任何一支探針裡再寫第二份指標公式(陷阱 #37:同一套規則寫兩份,遲早只改到一邊)。
 *
 * `signalsFor(R)` → { keys, hits, gene }
 *   ・R    = [{d,o,h,l,c,v}, …](已過濾好的日 K)
 *   ・hits = Map<事件名, number[]>(命中的 bar index)
 *   ・gene = boolean[](該 bar 是否符合 🧬 位階≥75 且 20日振幅≥3.2)
 * ⚠️ 只負責「哪一天出現了什麼訊號」;⛔ 報酬計算、去重、對照組留給呼叫端(兩支探針規則不同)。
 */

// ═══ 指標工具(全部純函式)═══
const EMA = (a, n) => { const k = 2 / (n + 1), o = new Array(a.length); let p = a[0];
  for (let i = 0; i < a.length; i++) { p = i ? a[i] * k + p * (1 - k) : a[0]; o[i] = p; } return o; };
const SMA = (a, n) => { const o = new Array(a.length).fill(null); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const WILD = (a, n) => { const o = new Array(a.length).fill(null); let s = 0;   // Wilder 平滑(ADX/RSI 用)
  for (let i = 0; i < a.length; i++) { if (i < n) { s += a[i]; if (i === n - 1) o[i] = s / n; }
    else o[i] = (o[i - 1] * (n - 1) + a[i]) / n; } return o; };
const HH = (a, n, i) => { let m = -Infinity; for (let q = Math.max(0, i - n + 1); q <= i; q++) if (a[q] > m) m = a[q]; return m; };
const LL = (a, n, i) => { let m = Infinity; for (let q = Math.max(0, i - n + 1); q <= i; q++) if (a[q] < m) m = a[q]; return m; };
const xUp = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
const xDn = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i - 1] >= b[i - 1] && a[i] < b[i];


export function signalsFor(R) {
  const N = R.length;
  const C = R.map(r => r.c), H = R.map(r => r.h), L = R.map(r => r.l), V = R.map(r => r.v);
  const TP = R.map(r => (r.h + r.l + r.c) / 3);

  // ── ATR / TR ──
  const tr = R.map((r, i) => i ? Math.max(r.h - r.l, Math.abs(r.h - C[i - 1]), Math.abs(r.l - C[i - 1])) : r.h - r.l);
  const atr14 = WILD(tr, 14), atr10 = WILD(tr, 10);

  // ── ① ADX / DMI(14)──
  const pDM = R.map((r, i) => { if (!i) return 0; const u = r.h - H[i - 1], d = L[i - 1] - r.l; return (u > d && u > 0) ? u : 0; });
  const nDM = R.map((r, i) => { if (!i) return 0; const u = r.h - H[i - 1], d = L[i - 1] - r.l; return (d > u && d > 0) ? d : 0; });
  const sP = WILD(pDM, 14), sN = WILD(nDM, 14);
  const pDI = sP.map((v, i) => (v == null || !atr14[i]) ? null : 100 * v / atr14[i]);
  const nDI = sN.map((v, i) => (v == null || !atr14[i]) ? null : 100 * v / atr14[i]);
  const dx = pDI.map((v, i) => (v == null || nDI[i] == null || v + nDI[i] === 0) ? null : 100 * Math.abs(v - nDI[i]) / (v + nDI[i]));
  const adx = WILD(dx.map(v => v ?? 0), 14);

  // ── ② Supertrend(10, 3)──
  const stDir = new Array(N).fill(0); { let up = 0, dn = 0, dir = 1;
    for (let i = 0; i < N; i++) { const a = atr10[i]; if (a == null) { stDir[i] = 0; continue; }
      const mid = (H[i] + L[i]) / 2; let bu = mid + 3 * a, bd = mid - 3 * a;
      bu = (i && C[i - 1] <= up) ? Math.min(bu, up) : bu;
      bd = (i && C[i - 1] >= dn) ? Math.max(bd, dn) : bd;
      dir = C[i] > up ? 1 : C[i] < dn ? -1 : (dir || 1);
      up = bu; dn = bd; stDir[i] = dir; } }

  // ── ③ Ichimoku(9/26/52)──
  const tenkan = new Array(N).fill(null), kijun = new Array(N).fill(null),
        spanA = new Array(N).fill(null), spanB = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    if (i >= 8) tenkan[i] = (HH(H, 9, i) + LL(L, 9, i)) / 2;
    if (i >= 25) kijun[i] = (HH(H, 26, i) + LL(L, 26, i)) / 2;
    if (i >= 51) { const a26 = i - 26;
      if (a26 >= 25) spanA[i] = (tenkan[a26] + kijun[a26]) / 2;
      spanB[i] = (HH(H, 52, i - 26) + LL(L, 52, i - 26)) / 2; }
  }
  // ── ④ Aroon(25) ⑤ TRIX(15) ⑥ Keltner(20) ⑦ GMMA ──
  const aUp = new Array(N).fill(null), aDn = new Array(N).fill(null);
  for (let i = 25; i < N; i++) { let hi = -Infinity, li = Infinity, hj = i, lj = i;
    for (let q = i - 25; q <= i; q++) { if (H[q] >= hi) { hi = H[q]; hj = q; } if (L[q] <= li) { li = L[q]; lj = q; } }
    aUp[i] = (25 - (i - hj)) / 25 * 100; aDn[i] = (25 - (i - lj)) / 25 * 100; }
  const e1 = EMA(C, 15), e2 = EMA(e1, 15), e3 = EMA(e2, 15);
  const trix = e3.map((v, i) => i ? (v / e3[i - 1] - 1) * 10000 : 0);
  const trixSig = SMA(trix, 9);
  const kMid = EMA(C, 20);
  const kUp = kMid.map((v, i) => atr10[i] == null ? null : v + 2 * atr10[i]);
  const kLo = kMid.map((v, i) => atr10[i] == null ? null : v - 2 * atr10[i]);
  const gS = [3, 5, 8, 10, 12, 15].map(n => EMA(C, n)), gL = [30, 35, 40, 45, 50, 60].map(n => EMA(C, n));

  // ── ⑧ CCI(20) ⑨ %R(14) ⑩ ROC(12) ⑪ StochRSI ⑫ CMO(14) ⑬ UO ⑭ MFI(14) ⑮ Momentum ⑯ KDJ ──
  const tpS = SMA(TP, 20);
  const cci = new Array(N).fill(null);
  for (let i = 19; i < N; i++) { let md = 0; for (let q = i - 19; q <= i; q++) md += Math.abs(TP[q] - tpS[i]);
    md /= 20; cci[i] = md > 0 ? (TP[i] - tpS[i]) / (0.015 * md) : 0; }
  const wr = new Array(N).fill(null);
  for (let i = 13; i < N; i++) { const hi = HH(H, 14, i), li = LL(L, 14, i); wr[i] = hi > li ? (hi - C[i]) / (hi - li) * -100 : -50; }
  const roc = C.map((v, i) => i >= 12 ? (v / C[i - 12] - 1) * 100 : null);
  // RSI(14) → StochRSI ・ CMO(14)
  const rsi = new Array(N).fill(null); { let ag = 0, al = 0;
    for (let i = 1; i < N; i++) { const ch = C[i] - C[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (i <= 14) { ag += g / 14; al += l / 14; if (i === 14) rsi[i] = al > 0 ? 100 - 100 / (1 + ag / al) : 100; }
      else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; rsi[i] = al > 0 ? 100 - 100 / (1 + ag / al) : 100; } } }
  const srsi = new Array(N).fill(null);
  for (let i = 28; i < N; i++) { const w = rsi.slice(i - 13, i + 1).filter(x => x != null);
    if (w.length < 14) continue; const mx = Math.max(...w), mn = Math.min(...w);
    srsi[i] = mx > mn ? (rsi[i] - mn) / (mx - mn) * 100 : 50; }
  const cmo = new Array(N).fill(null);
  for (let i = 14; i < N; i++) { let su = 0, sd = 0;
    for (let q = i - 13; q <= i; q++) { const ch = C[q] - C[q - 1]; if (ch > 0) su += ch; else sd -= ch; }
    cmo[i] = (su + sd) > 0 ? (su - sd) / (su + sd) * 100 : 0; }
  const uo = new Array(N).fill(null);
  { const bp = new Array(N).fill(0), trr = new Array(N).fill(0);
    for (let i = 1; i < N; i++) { const tl = Math.min(L[i], C[i - 1]), th = Math.max(H[i], C[i - 1]);
      bp[i] = C[i] - tl; trr[i] = th - tl; }
    const sum = (a, n, i) => { let s = 0; for (let q = i - n + 1; q <= i; q++) s += a[q]; return s; };
    for (let i = 28; i < N; i++) { const a7 = sum(trr, 7, i), a14 = sum(trr, 14, i), a28 = sum(trr, 28, i);
      if (a7 > 0 && a14 > 0 && a28 > 0) uo[i] = 100 * (4 * sum(bp, 7, i) / a7 + 2 * sum(bp, 14, i) / a14 + sum(bp, 28, i) / a28) / 7; } }
  const mfi = new Array(N).fill(null);
  for (let i = 14; i < N; i++) { let pf = 0, nf = 0;
    for (let q = i - 13; q <= i; q++) { const f = TP[q] * V[q]; if (TP[q] > TP[q - 1]) pf += f; else if (TP[q] < TP[q - 1]) nf += f; }
    mfi[i] = nf > 0 ? 100 - 100 / (1 + pf / nf) : 100; }
  const mom = C.map((v, i) => i >= 10 ? v - C[i - 10] : null);
  const kA = new Array(N).fill(50), dA = new Array(N).fill(50);
  for (let i = 8; i < N; i++) { const hi = HH(H, 9, i), li = LL(L, 9, i);
    const rsv = hi > li ? (C[i] - li) / (hi - li) * 100 : 50;
    kA[i] = kA[i - 1] * 2 / 3 + rsv / 3; dA[i] = dA[i - 1] * 2 / 3 + kA[i] / 3; }
  const jA = kA.map((v, i) => 3 * v - 2 * dA[i]);

  // ── ⑰ 標準差 ⑱ Chaikin Volatility ──
  const ret = C.map((v, i) => i ? (v / C[i - 1] - 1) * 100 : 0);
  const sd20 = new Array(N).fill(null);
  for (let i = 19; i < N; i++) { let m = 0; for (let q = i - 19; q <= i; q++) m += ret[q]; m /= 20;
    let s = 0; for (let q = i - 19; q <= i; q++) s += (ret[q] - m) ** 2; sd20[i] = Math.sqrt(s / 20); }
  const hlE = EMA(R.map(r => r.h - r.l), 10);
  const chvol = hlE.map((v, i) => i >= 10 && hlE[i - 10] > 0 ? (v / hlE[i - 10] - 1) * 100 : null);

  // ── ⑲ OBV ⑳ VWAP(20) ㉑ CMF(20) ㉒ Chaikin Osc ㉓ A/D ㉔ VR ㉕ VROC ㉖ Force ㉗ EOM ──
  const obv = new Array(N).fill(0);
  for (let i = 1; i < N; i++) obv[i] = obv[i - 1] + (C[i] > C[i - 1] ? V[i] : C[i] < C[i - 1] ? -V[i] : 0);
  const vwap20 = new Array(N).fill(null);
  for (let i = 19; i < N; i++) { let a = 0, b = 0; for (let q = i - 19; q <= i; q++) { a += TP[q] * V[q]; b += V[q]; }
    vwap20[i] = b > 0 ? a / b : null; }
  const mfv = R.map(r => (r.h > r.l) ? (((r.c - r.l) - (r.h - r.c)) / (r.h - r.l)) * r.v : 0);
  const cmf = new Array(N).fill(null);
  for (let i = 19; i < N; i++) { let a = 0, b = 0; for (let q = i - 19; q <= i; q++) { a += mfv[q]; b += V[q]; }
    cmf[i] = b > 0 ? a / b : null; }
  const adl = new Array(N).fill(0);
  for (let i = 1; i < N; i++) adl[i] = adl[i - 1] + mfv[i];
  const cho = EMA(adl, 3).map((v, i) => v - EMA(adl, 10)[i]);
  const choE3 = EMA(adl, 3), choE10 = EMA(adl, 10);
  const chaikin = choE3.map((v, i) => v - choE10[i]);
  const vr = new Array(N).fill(null);
  for (let i = 26; i < N; i++) { let uV = 0, dV = 0, eV = 0;
    for (let q = i - 25; q <= i; q++) { if (C[q] > C[q - 1]) uV += V[q]; else if (C[q] < C[q - 1]) dV += V[q]; else eV += V[q]; }
    const den = dV + eV / 2; vr[i] = den > 0 ? (uV + eV / 2) / den * 100 : null; }
  const vroc = V.map((v, i) => i >= 12 && V[i - 12] > 0 ? (v / V[i - 12] - 1) * 100 : null);
  const force = EMA(C.map((v, i) => i ? (v - C[i - 1]) * V[i] : 0), 13);
  const eomRaw = R.map((r, i) => { if (!i) return 0; const dm = ((r.h + r.l) / 2) - ((H[i - 1] + L[i - 1]) / 2);
    const box = (r.h > r.l && r.v > 0) ? (r.v / 1e6) / (r.h - r.l) : 0; return box > 0 ? dm / box : 0; });
  const eom = SMA(eomRaw, 14);

  // ── ㉘ Hurst(R/S,近 100 日)㉙ Kalman ㉚ Z-Score(20) ──
  const hurst = new Array(N).fill(null);
  for (let i = 119; i < N; i += 1) {
    if (i % 5 !== 0) { hurst[i] = hurst[i - 1]; continue; }        // 每 5 根算一次(成本考量)
    const x = ret.slice(i - 99, i + 1); const ns = [10, 20, 50, 100], pts = [];
    for (const n of ns) { let rs = 0, cnt = 0;
      for (let s = 0; s + n <= x.length; s += n) { const seg = x.slice(s, s + n);
        const m = seg.reduce((a, b) => a + b, 0) / n; let cum = 0, mx = -Infinity, mn = Infinity, sq = 0;
        for (const v of seg) { cum += v - m; if (cum > mx) mx = cum; if (cum < mn) mn = cum; sq += (v - m) ** 2; }
        const sd = Math.sqrt(sq / n); if (sd > 0) { rs += (mx - mn) / sd; cnt++; } }
      if (cnt) pts.push([Math.log(n), Math.log(rs / cnt)]); }
    if (pts.length >= 3) { const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length,
        my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      let num = 0, den = 0; for (const [px, py] of pts) { num += (px - mx) * (py - my); den += (px - mx) ** 2; }
      hurst[i] = den > 0 ? num / den : null; }
  }
  const kal = new Array(N).fill(null); { let x = C[0], p = 1; const q = 0.01, r = 1;
    for (let i = 0; i < N; i++) { p += q; const k = p / (p + r); x = x + k * (C[i] - x); p = (1 - k) * p; kal[i] = x; } }
  const z20 = new Array(N).fill(null);
  for (let i = 19; i < N; i++) { let m = 0; for (let q = i - 19; q <= i; q++) m += C[q]; m /= 20;
    let s = 0; for (let q = i - 19; q <= i; q++) s += (C[q] - m) ** 2; s = Math.sqrt(s / 20);
    z20[i] = s > 0 ? (C[i] - m) / s : 0; }


  const hits = new Map();
  const geneArr = new Array(N).fill(false);
  const hit = (k, i) => { if (!hits.has(k)) hits.set(k, []); hits.get(k).push(i); };
  for (let i = 300; i < N - 1; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let q = i - 251; q <= i; q++) { if (C[q] > hi) hi = C[q]; if (C[q] < lo) lo = C[q]; }
    const pos = hi > lo ? (C[i] - lo) / (hi - lo) * 100 : 50;
    let amp = 0; for (let q = i - 19; q <= i; q++) amp += (H[q] - L[q]) / C[q]; amp = amp / 20 * 100;
    const gene = pos >= 75 && amp >= 3.2;
    geneArr[i] = gene;
    hit('對照組(所有交易日)', i, gene);

    // 【趨勢】
    if (adx[i] != null && adx[i - 1] != null) {
      if (xUp(pDI, nDI, i) && adx[i] > 25) hit('📈 ADX>25 且 +DI 上穿 −DI(趨勢啟動)', i, gene);
      if (adx[i - 1] <= 25 && adx[i] > 25) hit('📈 ADX 由下穿過 25(趨勢成形)', i, gene);
      if (adx[i] < 20) hit('📈 ADX<20(無趨勢/盤整)', i, gene);
    }
    if (stDir[i] === 1 && stDir[i - 1] === -1) hit('📈 Supertrend 翻多', i, gene);
    if (stDir[i] === -1 && stDir[i - 1] === 1) hit('📈 Supertrend 翻空', i, gene);
    if (spanA[i] != null && spanB[i] != null) {
      const top = Math.max(spanA[i], spanB[i]), bot = Math.min(spanA[i], spanB[i]);
      const topP = Math.max(spanA[i - 1], spanB[i - 1]);
      if (C[i - 1] <= topP && C[i] > top) hit('📈 一目均衡表:價格上穿雲頂', i, gene);
      if (C[i - 1] >= Math.min(spanA[i - 1], spanB[i - 1]) && C[i] < bot) hit('📈 一目均衡表:價格跌破雲底', i, gene);
      if (xUp(tenkan, kijun, i) && C[i] > top) hit('📈 一目:轉換線上穿基準線(在雲之上)', i, gene);
    }
    if (aUp[i] != null && aUp[i - 1] != null) {
      if (aUp[i - 1] <= aDn[i - 1] && aUp[i] > aDn[i] && aUp[i] > 70) hit('📈 Aroon 上穿(AroonUp>70)', i, gene);
      if (aDn[i] > 70 && aUp[i] < 30) hit('📈 Aroon 空頭(Down>70,Up<30)', i, gene);
    }
    if (trixSig[i] != null && xUp(trix, trixSig, i)) hit('📈 TRIX 上穿訊號線', i, gene);
    if (trix[i - 1] != null && trix[i - 1] <= 0 && trix[i] > 0) hit('📈 TRIX 上穿 0 軸', i, gene);
    if (kUp[i] != null && C[i - 1] <= kUp[i - 1] && C[i] > kUp[i]) hit('📈 突破凱特納上軌', i, gene);
    if (kLo[i] != null && C[i - 1] >= kLo[i - 1] && C[i] < kLo[i]) hit('📈 跌破凱特納下軌', i, gene);
    { const sMin = Math.min(...gS.map(a => a[i])), lMax = Math.max(...gL.map(a => a[i]));
      const sMinP = Math.min(...gS.map(a => a[i - 1])), lMaxP = Math.max(...gL.map(a => a[i - 1]));
      if (sMinP <= lMaxP && sMin > lMax) hit('📈 GMMA 短期組全面上穿長期組', i, gene); }

    // 【動能/擺動】
    if (cci[i] != null && cci[i - 1] != null) {
      if (cci[i - 1] <= -100 && cci[i] > -100) hit('🔄 CCI 由 −100 翻上', i, gene);
      if (cci[i - 1] <= 100 && cci[i] > 100) hit('🔄 CCI 上穿 +100(強勢)', i, gene);
    }
    if (wr[i] != null && wr[i - 1] != null && wr[i - 1] <= -80 && wr[i] > -80) hit('🔄 威廉指標由 −80 翻上', i, gene);
    if (roc[i] != null && roc[i - 1] != null && roc[i - 1] <= 0 && roc[i] > 0) hit('🔄 ROC 上穿 0', i, gene);
    if (srsi[i] != null && srsi[i - 1] != null && srsi[i - 1] <= 20 && srsi[i] > 20) hit('🔄 StochRSI 由 20 以下翻上', i, gene);
    if (cmo[i] != null && cmo[i - 1] != null && cmo[i - 1] <= -50 && cmo[i] > -50) hit('🔄 CMO 由 −50 翻上', i, gene);
    if (uo[i] != null && uo[i - 1] != null && uo[i - 1] <= 30 && uo[i] > 30) hit('🔄 終極擺動由 30 翻上', i, gene);
    if (mfi[i] != null && mfi[i - 1] != null) {
      if (mfi[i - 1] <= 20 && mfi[i] > 20) hit('🔄 MFI 由 20 以下翻上(資金流入)', i, gene);
      if (mfi[i - 1] <= 80 && mfi[i] > 80) hit('🔄 MFI 上穿 80(資金過熱)', i, gene);
    }
    if (mom[i] != null && mom[i - 1] != null && mom[i - 1] <= 0 && mom[i] > 0) hit('🔄 動能指標上穿 0', i, gene);
    if (jA[i - 1] <= 0 && jA[i] > 0) hit('🔄 KDJ 的 J 由 0 以下翻上', i, gene);
    if (jA[i - 1] >= 100 && jA[i] < 100) hit('🔄 KDJ 的 J 由 100 以上翻下', i, gene);

    // 【波動】
    if (sd20[i] != null && i >= 320) { const w = sd20.slice(i - 99, i + 1).filter(x => x != null);
      if (w.length > 50) { const srt = w.slice().sort((a, b) => a - b);
        const p = srt.findIndex(x => x >= sd20[i]) / srt.length * 100;
        if (p >= 90) hit('📊 標準差近百日最高 10%(波動極大)', i, gene);
        if (p <= 10) hit('📊 標準差近百日最低 10%(波動極小)', i, gene); } }
    if (chvol[i] != null && chvol[i - 1] != null && chvol[i - 1] <= 50 && chvol[i] > 50) hit('📊 蔡金波動 >+50%(波動急擴)', i, gene);

    // 【成交量】
    if (i >= 20 && obv[i] >= HH(obv, 20, i) && C[i] < HH(C, 20, i)) hit('💧 OBV 創20日新高但價格沒有(量先價行)', i, gene);
    if (i >= 20 && obv[i] >= HH(obv, 20, i) && C[i] >= HH(C, 20, i)) hit('💧 OBV 與價格同步創20日新高', i, gene);
    if (vwap20[i] != null && C[i - 1] <= vwap20[i - 1] && C[i] > vwap20[i]) hit('💧 上穿 20 日 VWAP', i, gene);
    if (cmf[i] != null && cmf[i - 1] != null) {
      if (cmf[i - 1] <= 0.2 && cmf[i] > 0.2) hit('💧 CMF 上穿 +0.2(買盤強)', i, gene);
      if (cmf[i - 1] >= -0.2 && cmf[i] < -0.2) hit('💧 CMF 跌破 −0.2(賣壓強)', i, gene);
    }
    if (chaikin[i - 1] <= 0 && chaikin[i] > 0) hit('💧 蔡金擺動上穿 0', i, gene);
    if (i >= 20 && adl[i] >= HH(adl, 20, i)) hit('💧 累積/派發線創 20 日新高', i, gene);
    if (vr[i] != null && vr[i - 1] != null) {
      if (vr[i] > 250 && vr[i - 1] <= 250) hit('💧 成交量比率 VR>250(過熱)', i, gene);
      if (vr[i] < 70 && vr[i - 1] >= 70) hit('💧 成交量比率 VR<70(低迷)', i, gene);
    }
    if (vroc[i] != null && vroc[i] > 200) hit('💧 VROC>200%(量能暴增)', i, gene);
    if (force[i - 1] <= 0 && force[i] > 0) hit('💧 強弱指標(Force)上穿 0', i, gene);
    if (eom[i] != null && eom[i - 1] != null && eom[i - 1] <= 0 && eom[i] > 0) hit('💧 輕鬆移動(EOM)上穿 0', i, gene);

    // 【樞紐點 / SMC】
    { const p = (H[i - 1] + L[i - 1] + C[i - 1]) / 3, r1 = 2 * p - L[i - 1], s1 = 2 * p - H[i - 1];
      if (C[i - 1] <= r1 && C[i] > r1) hit('📍 突破古典樞紐 R1', i, gene);
      if (C[i - 1] >= s1 && C[i] < s1) hit('📍 跌破古典樞紐 S1', i, gene);
      const rng = H[i - 1] - L[i - 1], h3 = C[i - 1] + rng * 0.275, l3 = C[i - 1] - rng * 0.275;
      if (C[i] > h3) hit('📍 突破 Camarilla H3', i, gene);
      if (C[i] < l3) hit('📍 跌破 Camarilla L3', i, gene); }
    // SMC:三根 K 的公允價值缺口(FVG)—— 第 1 根高 < 第 3 根低
    if (i >= 2 && H[i - 2] < L[i] && (L[i] / H[i - 2] - 1) * 100 >= 0.5) hit('🧱 SMC 多方公允價值缺口(FVG)', i, gene);
    if (i >= 2 && L[i - 2] > H[i] && (L[i - 2] / H[i] - 1) * 100 >= 0.5) hit('🧱 SMC 空方公允價值缺口(FVG)', i, gene);

    // 【進階:Hurst / Kalman / Z-Score】
    if (hurst[i] != null) {
      if (hurst[i] > 0.58) hit('🧬 Hurst>0.58(趨勢持續性高)', i, gene);
      if (hurst[i] < 0.42) hit('🧬 Hurst<0.42(均值回歸性高)', i, gene);
    }
    if (kal[i - 1] != null && C[i - 1] <= kal[i - 1] && C[i] > kal[i]) hit('🧬 價格上穿卡爾曼濾波估計', i, gene);
    if (z20[i] != null && z20[i - 1] != null) {
      if (z20[i - 1] <= -2 && z20[i] > -2) hit('🧬 Z-Score 由 −2 翻上(均值回歸買點)', i, gene);
      if (z20[i] > 2) hit('🧬 Z-Score > +2(極度偏離均值)', i, gene);
    }
  }
  return { keys: [...hits.keys()], hits, gene: geneArr };
}
