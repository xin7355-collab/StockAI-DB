#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# 🧪 機構因子探針(V71.0.8)— 「法人 / 華爾街在用、散戶少看」的因子,拿台股實測
#
# 為什麼有這支:
#   使用者問「有沒有付費 / 券商 / 華爾街偷偷在用、沒公開的東西?」
#   誠實前提:**沒有什麼秘密公式**。真正的機構優勢多半是
#     (a) 基礎建設(速度、資料權限、融資成本)— 散戶複製不了
#     (b) 學術上早就公開、但散戶懶得看的因子 — 這個可以複製
#     (c) 一公開就失效的東西 — 那本來就留不住
#   所以這支只測 (b):學界/法人長期在用、台股散戶幾乎不看、
#   而且**我們現有的 OHLCV 就算得出來**的因子。
#
# 資料底氣(跟 sector_flow_probe 的薄樣本不同):
#   data/*.json 的 OHLCV 中位數約 761 根日K(≈3 年)、2,600+ 檔 → 真的能測。
#   (外資 foreign_net 只有 60 天,所以這裡**刻意不用法人資料**,純價量。)
#
# 方法:每 20 個交易日換股一次,把全市場依因子分 5 等份(Q1 最低 ~ Q5 最高),
#      量各組「之後 20 個交易日」的平均報酬,看 Q5−Q1 價差有沒有穩定的邊際。
#
# 用法:python3 edge_probe.py     (只讀 data/,不寫檔、不打 API)
# ═══════════════════════════════════════════════════════════════════════════
import json
import statistics
from pathlib import Path

DATA_DIR = Path("data")
MIN_BARS = 400          # 至少要這麼多根才納入
WARMUP = 260            # 前面留給因子計算的暖身
STEP = 20               # 每 20 個交易日換股一次
FWD = 20                # 前瞻 20 個交易日
NQ = 5                  # 分 5 等份
MIN_UNIVERSE = 150      # 一次換股至少要這麼多檔才算數


def load_all():
    book = {}
    for p in sorted(DATA_DIR.glob("*.json")):
        sym = p.stem
        if not sym.isdigit() or len(sym) < 4:
            continue
        try:
            rows = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(rows, list) or len(rows) < MIN_BARS:
            continue
        try:
            o = [float(r["open"]) for r in rows]
            h = [float(r["high"]) for r in rows]
            c = [float(r["close"]) for r in rows]
            v = [float(r.get("volume") or 0) for r in rows]
            d = [r["date"] for r in rows]
        except Exception:
            continue
        if min(c) <= 0 or min(o) <= 0:
            continue
        book[sym] = {"o": o, "h": h, "c": c, "v": v, "idx": {dt: i for i, dt in enumerate(d)}}
    return book


# ── 因子(全部只吃 OHLCV;回傳值一律「越大越看多」)────────────────────────
def factors(b, i):
    o, h, c, v = b["o"], b["h"], b["c"], b["v"]
    out = {}
    # ① 隔夜 vs 盤中報酬拆解(Lou/Polk/Skouras "A Tug of War")
    #    隔夜(收→隔日開)被視為「機構/資訊交易」的痕跡,盤中(開→收)偏散戶當沖。
    #    台股散戶幾乎沒人拆這兩段看,但它是完全免費的資訊。
    on = sum((o[k] - c[k - 1]) / c[k - 1] for k in range(i - 59, i + 1)) * 100
    idr = sum((c[k] - o[k]) / o[k] for k in range(i - 59, i + 1)) * 100
    out["隔夜報酬60日"] = on
    out["盤中報酬60日"] = idr
    out["隔夜減盤中"] = on - idr          # ⭐ 核心:夜漲日跌 = 機構在收、散戶在倒
    # ② 距 52 週高點的位置(George & Hwang 錨定效應;比純動能更穩)
    hi250 = max(h[max(0, i - 249): i + 1])
    out["逼近52週高"] = (c[i] / hi250 * 100) if hi250 > 0 else 0
    # ③ 短期反轉(近 20 日輸家隔月常反彈)
    out["短期反轉"] = -(c[i] - c[i - 20]) / c[i - 20] * 100
    # ④ 12-1 動能(排除最近 1 個月,避開反轉汙染)
    out["動能12-1"] = (c[i - 20] - c[i - 250]) / c[i - 250] * 100
    # ⑤ 低波動異常(低波動股長期風險調整後報酬反而較好)
    rets = [(c[k] - c[k - 1]) / c[k - 1] for k in range(i - 59, i + 1)]
    out["低波動"] = -statistics.pstdev(rets) * 100
    # ⑥ Amihud 非流動性(越不流動溢酬越高;台股要小心,量太小根本買不到)
    amt = [abs(rets[j]) / max(1e-9, v[i - 59 + j] * c[i - 59 + j]) for j in range(60)]
    out["非流動性"] = statistics.mean(amt) * 1e9
    return out


def main():
    print("📦 載入 data/*.json …")
    book = load_all()
    if len(book) < MIN_UNIVERSE:
        print(f"❌ 只讀到 {len(book)} 檔(需 ≥{MIN_UNIVERSE})")
        return
    axis = max(book.values(), key=lambda b: len(b["c"]))
    axis_dates = [d for d, _ in sorted(axis["idx"].items(), key=lambda kv: kv[1])]
    print(f"✅ {len(book)} 檔納入(每檔 ≥{MIN_BARS} 根日K);時間軸 {len(axis_dates)} 個交易日")

    names = list(factors(next(iter(book.values())), WARMUP).keys())
    # 因子 → 各分位的前瞻報酬清單
    buckets = {n: [[] for _ in range(NQ)] for n in names}
    rebalances = 0

    for t in range(WARMUP, len(axis_dates) - FWD, STEP):
        date = axis_dates[t]
        snap = []
        for sym, b in book.items():
            i = b["idx"].get(date)
            if i is None or i < WARMUP or i + FWD >= len(b["c"]):
                continue
            try:
                f = factors(b, i)
                fwd = (b["c"][i + FWD] - b["c"][i]) / b["c"][i] * 100
            except Exception:
                continue
            snap.append((f, fwd))
        if len(snap) < MIN_UNIVERSE:
            continue
        rebalances += 1
        for n in names:
            snap.sort(key=lambda x: x[0][n])
            m = len(snap)
            for q in range(NQ):
                seg = snap[q * m // NQ:(q + 1) * m // NQ]
                for _, fwd in seg:
                    buckets[n][q].append(fwd)

    print(f"📅 有效換股次數:{rebalances}(每 {STEP} 個交易日一次,前瞻 {FWD} 日)\n")
    if rebalances < 5:
        print("⚠️ 換股次數太少,不列結果")
        return

    print("═" * 100)
    print(f"{'因子':<16}{'Q1(最低)':>11}{'Q2':>9}{'Q3':>9}{'Q4':>9}{'Q5(最高)':>11}"
          f"{'Q5−Q1':>10}{'Q5勝率':>9}")
    print("═" * 100)
    rows = []
    for n in names:
        ms = [statistics.mean(q) if q else 0 for q in buckets[n]]
        spread = ms[-1] - ms[0]
        win = (sum(1 for x in buckets[n][-1] if x > 0) / len(buckets[n][-1]) * 100) if buckets[n][-1] else 0
        rows.append((spread, n, ms, win))
        print(f"{n:<16}{ms[0]:>10.2f}%{ms[1]:>8.2f}%{ms[2]:>8.2f}%{ms[3]:>8.2f}%{ms[4]:>10.2f}%"
              f"{spread:>9.2f}%{win:>8.1f}%")

    rows.sort(reverse=True)
    print("\n📊 依 Q5−Q1 價差排序(越大代表這個因子越能分出強弱):")
    for spread, n, ms, win in rows:
        mono = all(ms[k] <= ms[k + 1] for k in range(NQ - 1))   # 單調遞增 = 因子行為乾淨
        tag = ("✅ 有效" if spread > 1.5 else "➖ 微弱" if spread > 0.3 else "❌ 無效")
        print(f"   {n:<16} Q5−Q1 {spread:+6.2f}%  {tag}{'  ・單調遞增(乾淨)' if mono else ''}")

    print("\n📌 判讀提醒(別過度解讀):")
    print("   ・這是「全市場等權分位」的統計,不是可直接下單的策略(未扣手續費/稅/滑價,")
    print("     台股來回成本約 0.4%,Q5−Q1 沒超過它就沒有實作價值)。")
    print("   ・只涵蓋約 3 年、單一市場、單一制度環境,不保證未來續效。")
    print("   ・Q5−Q1 大不等於能賺:要看 Q5 自己的絕對報酬,做多只吃得到 Q5(台股放空成本高)。")
    print("   ・低流動性因子在台股要特別小心:量太小的股票你根本買不到那個價。")


if __name__ == "__main__":
    main()
