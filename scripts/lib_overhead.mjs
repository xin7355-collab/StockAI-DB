/**
 * 🧱 上方套牢層(量價分布)—— `index.html:_overheadSupply` 的 Node 版,**全 repo 探針共用這一份**
 * 用的人:overhead_probe.mjs(V76.0.6)、trap_compare_probe.mjs(V79.0.2)
 * ⛔ 改 index.html 那支要同步這裡,並重跑兩支探針。
 */
export const NB = 40;                              // 價格分 40 格(同 _overheadSupply)
// ═══ 判定邏輯(搬自 index.html:_overheadSupply,⛔ 改那邊要同步)═══
//  回傳:由近到遠最多 3 層 {lo, hi, mid, pct, dist}
//  ⭐ buckets 只算一次,所有 MIN_SHARE 門檻共用(⛔ 否則敏感度掃描要跑 5 遍)
export function buildBuckets(win) {
  const w2 = [];
  for (const b of win) if (b.c > 0 && b.v > 0) w2.push(b);
  if (w2.length < 40) return null;
  let mn = Infinity, mx = -Infinity;
  for (const b of w2) { const p = (b.h + b.l + b.c) / 3; if (p < mn) mn = p; if (p > mx) mx = p; }
  if (!(mx > mn)) return null;
  const w = (mx - mn) / NB, bk = new Float64Array(NB);
  for (const b of w2) bk[Math.min(NB - 1, Math.floor(((b.h + b.l + b.c) / 3 - mn) / w))] += b.v;
  let tot = 0; for (let i = 0; i < NB; i++) tot += bk[i];
  return tot > 0 ? { mn, w, bk, tot } : null;
}
export function layersFrom(B, pC, minShare) {
  if (!B) return [];
  const hot = [];
  for (let i = 0; i < NB; i++) {
    const lo = B.mn + i * B.w;
    if (lo <= pC * 1.01) continue;                      // 只看現價上方(留 1% 緩衝)
    if (B.bk[i] / B.tot >= minShare) hot.push({ i, lo, hi: lo + B.w, v: B.bk[i] });
  }
  if (!hot.length) return [];
  const L = [];
  for (const b of hot) {                                 // 相鄰併層(最多容忍隔 1 格)
    const t = L[L.length - 1];
    if (t && b.i - t.iEnd <= 2) { t.hi = b.hi; t.v += b.v; t.iEnd = b.i; }
    else L.push({ lo: b.lo, hi: b.hi, v: b.v, iEnd: b.i });
  }
  return L.map(x => ({ lo: x.lo, hi: x.hi, mid: (x.lo + x.hi) / 2, pct: x.v / B.tot * 100 }))
          .sort((a, b) => a.lo - b.lo).slice(0, 3);
}

