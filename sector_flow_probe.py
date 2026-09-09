#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# 🧪 板塊籌碼輪動「偷布局」策略探針(V71.0.5)
#
# 為什麼要有這支:
#   使用者問「我新增的板塊籌碼輪動策略有沒有用?」——
#   照本專案鐵則(見 CLAUDE.md「ORB 探針」那段教訓):**探針先行、實測不猜**,
#   不准憑感覺說「應該有用」。這支就是拿真實資料回測那個訊號。
#
# 測什麼:
#   對每個交易日 t、每個板塊,算
#     px5 = 板塊成分股近 5 日平均漲跌%
#     fi5 = 板塊成分股近 5 日外資買賣超合計(張)
#     stealth(偷布局) = px5 <= -1.5%  且  fi5 > 0     ← 價在跌、外資還在買
#   然後量「訊號日之後 5 / 10 / 20 個交易日」該板塊的平均報酬,
#   跟「同期所有板塊所有日子」的基準比較。
#
# ⚠️ 已知資料限制(這支會自己印出來,別忽略):
#   data/{sym}.json 的 foreign_net 只回溯到約 2026/05,不是 5 年。
#   樣本很薄 → 結果只能當「方向性參考」,**不足以下結論**。
#   等外資資料累積到 1 年以上再跑一次才有統計意義。
#
# 用法:python3 sector_flow_probe.py     (只讀 data/,不寫任何檔、不呼叫任何 API)
# ═══════════════════════════════════════════════════════════════════════════
import json
import statistics
from pathlib import Path

DATA_DIR = Path("data")

try:
    from radar_miner import SECTOR_MEMBERS
except Exception:                                    # 獨立執行時的後備
    SECTOR_MEMBERS = {}

FWD = (5, 10, 20)          # 前瞻天數
PX_DROP = -1.5             # 偷布局門檻:板塊近 5 日平均跌幅
MIN_MEMBERS = 2            # 一個板塊至少要幾檔有資料才算數


def _load(sym):
    p = DATA_DIR / f"{sym}.json"
    if not p.exists():
        return None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    rows = raw if isinstance(raw, list) else (raw.get("data") or [])
    return rows if isinstance(rows, list) and len(rows) > 40 else None


def main():
    if not SECTOR_MEMBERS:
        print("❌ 讀不到 SECTOR_MEMBERS(需與 radar_miner.py 同目錄)")
        return

    # ── 讀檔 + 建立「日期 → index」對照 ──────────────────────────────
    book = {}
    for syms in SECTOR_MEMBERS.values():
        for s in syms:
            if s not in book:
                rows = _load(s)
                if rows:
                    book[s] = {"rows": rows, "idx": {r.get("date"): i for i, r in enumerate(rows)}}
    if not book:
        print("❌ data/ 下讀不到任何成分股 K 線")
        return

    # 外資資料實際覆蓋範圍(誠實揭露樣本厚度)
    fi_dates = set()
    for b in book.values():
        for r in b["rows"]:
            if (r.get("foreign_net") or 0) != 0:
                fi_dates.add(r.get("date"))
    fi_dates = sorted(d for d in fi_dates if d)
    print(f"📦 成分股讀到 {len(book)} 檔")
    if not fi_dates:
        print("❌ 完全沒有外資資料,無法測")
        return
    print(f"📅 外資資料實際範圍:{fi_dates[0]} ~ {fi_dates[-1]}(共 {len(fi_dates)} 個交易日)")
    if len(fi_dates) < 120:
        print(f"⚠️ 只有 {len(fi_dates)} 天外資資料(不到半年)→ 以下數字**只能當方向參考,不足以下結論**")

    # 用最長那檔的日期序當時間軸
    axis = max((b["rows"] for b in book.values()), key=len)
    axis = [r.get("date") for r in axis]
    axis_pos = {d: i for i, d in enumerate(axis)}

    # 每筆 = (板塊, 日期, fwd5, fwd10, fwd20)
    stealth_rows = []      # 跌下來 + 外資買 = 偷布局(目前上線的版本)
    weak_rows = []         # 跌下來 + 外資也賣 = 純弱勢(對照組)
    base_rows = []         # 全部(基準)
    # ── 變體(測「有沒有更強的作法」)──
    norm_rows = []         # 變體A:買超「佔成交量比重」而非絕對張數(避免大板塊天生佔便宜)
    trust_rows = []        # 變體B:改看投信(台股投信短線帶動力常強於外資)
    persist_rows = []      # 變體C:看「連續買超天數」而非 5 日合計(持續性 > 單日大單)
    deep_rows = []         # 變體D:偷布局 + 板塊本身已跌深(距 60 日高點 ≥12%)

    for t_i in range(20, len(axis) - max(FWD)):
        date = axis[t_i]
        if date not in fi_dates:
            continue
        for sk, syms in SECTOR_MEMBERS.items():
            px5, fwd = [], {n: [] for n in FWD}
            fi5 = ti5 = vol5 = 0.0
            fi_days = 0          # 近 10 日外資「買超天數」(持續性)
            dd_list = []         # 距 60 日高點回檔%
            hit = 0
            for s in syms:
                b = book.get(s)
                if not b or date not in b["idx"]:
                    continue
                i = b["idx"][date]
                rows = b["rows"]
                if i < 61 or i + max(FWD) >= len(rows):
                    continue
                try:
                    c0, c1 = float(rows[i - 5]["close"]), float(rows[i]["close"])
                    if not (c0 > 0 and c1 > 0):
                        continue
                    px5.append((c1 - c0) / c0 * 100)
                    fi5 += sum(float(rows[k].get("foreign_net") or 0) for k in range(i - 4, i + 1)) / 1000.0
                    ti5 += sum(float(rows[k].get("trust_net") or 0) for k in range(i - 4, i + 1)) / 1000.0
                    vol5 += sum(float(rows[k].get("volume") or 0) for k in range(i - 4, i + 1)) / 1000.0
                    fi_days += sum(1 for k in range(i - 9, i + 1)
                                   if float(rows[k].get("foreign_net") or 0) > 0)
                    hi60 = max(float(rows[k].get("high") or 0) for k in range(i - 59, i + 1))
                    if hi60 > 0:
                        dd_list.append((hi60 - c1) / hi60 * 100)
                    for n in FWD:
                        cn = float(rows[i + n]["close"])
                        if cn > 0:
                            fwd[n].append((cn - c1) / c1 * 100)
                    hit += 1
                except Exception:
                    continue
            if hit < MIN_MEMBERS or not all(fwd[n] for n in FWD):
                continue
            avg_px5 = statistics.mean(px5)
            rec = (sk, date, *[statistics.mean(fwd[n]) for n in FWD])
            base_rows.append(rec)
            if avg_px5 <= PX_DROP:
                # 同樣是「跌下來的板塊」,只差外資買 or 賣 → 這才是乾淨的對照
                (stealth_rows if fi5 > 0 else weak_rows).append(rec)
                # 變體A:買超佔成交量比重 ≥0.5%(排除「大板塊隨便買都是大數字」)
                if vol5 > 0 and fi5 / vol5 * 100 >= 0.5:
                    norm_rows.append(rec)
                # 變體B:投信買超(不看外資)
                if ti5 > 0:
                    trust_rows.append(rec)
                # 變體C:外資近 10 日至少 6 天在買(持續性,而非一天大單灌出來的)
                if hit > 0 and fi_days / hit >= 6:
                    persist_rows.append(rec)
                # 變體D:偷布局 + 板塊已跌深(距 60 日高點 ≥12%)
                if fi5 > 0 and dd_list and statistics.mean(dd_list) >= 12:
                    deep_rows.append(rec)

    def _episodes(rows):
        """同一板塊連續(或間隔 <5 交易日)的訊號算「同一次事件」。
        不做這個去重,一次行情會被拆成 5-10 筆假獨立樣本,n 看起來很大其實全是同一件事。"""
        seen, eps = {}, 0
        for sk, date, *_ in sorted(rows, key=lambda r: (r[0], axis_pos.get(r[1], 0))):
            p = axis_pos.get(date)
            if p is None:
                continue
            if sk not in seen or p - seen[sk] >= 5:
                eps += 1
            seen[sk] = p
        return eps

    def _sm(rows, label):
        if not rows:
            print(f"   {label}: 無樣本")
            return None
        out = [label, len(rows)]
        line = f"   {label:22s} n={len(rows):4d}(獨立事件 {_episodes(rows):3d})"
        for k, n in enumerate(FWD):
            vals = [r[2 + k] for r in rows]
            m = statistics.mean(vals)
            win = sum(1 for v in vals if v > 0) / len(vals) * 100
            line += f" | +{n:2d}日 {m:+6.2f}% 勝率 {win:4.1f}%"
            out += [m, win]
        print(line)
        return out

    print("\n" + "═" * 96)
    print("🧭 偷布局(板塊近5日跌 ≥1.5% 但外資合計買超)vs 全體基準")
    print("═" * 96)
    s = _sm(stealth_rows, "🕵️ 偷布局(跌+外資買)")
    w = _sm(weak_rows, "🩸 純弱勢(跌+外資賣)")
    b = _sm(base_rows, "📊 基準(全板塊全日)")

    def _delta(a, ref, title):
        if not (a and ref):
            return
        print(f"\n📐 {title}:")
        for k, n in enumerate(FWD):
            d_ret = a[2 + k * 2] - ref[2 + k * 2]
            d_win = a[3 + k * 2] - ref[3 + k * 2]
            verdict = "✅ 有邊際" if d_ret > 0.5 else ("➖ 差不多" if d_ret > -0.5 else "❌ 反效果")
            print(f"   +{n:2d} 日:報酬 {d_ret:+6.2f} 個百分點 / 勝率 {d_win:+5.1f} 個百分點  → {verdict}")

    _delta(s, b, "偷布局 − 基準(這個訊號值不值得看)")
    # ⭐ 這組才是關鍵:同樣都是跌下來的板塊,「外資買」比「外資賣」好在哪?
    #    如果兩者差不多 → 代表賺的是「跌深反彈」,跟外資籌碼無關,那這訊號就是假的。
    _delta(s, w, "偷布局 − 純弱勢(「外資買」這個條件本身有沒有加分)")

    print("\n" + "═" * 96)
    print("🔬 變體比較:有沒有比現在上線的版本更強的作法?(全部同樣以「純弱勢」為對照)")
    print("═" * 96)
    variants = [
        (norm_rows,    "A 買超佔量比≥0.5%"),
        (trust_rows,   "B 改看投信買超"),
        (persist_rows, "C 外資10日買≥6天"),
        (deep_rows,    "D 偷布局+已跌深12%"),
    ]
    vs = [(_sm(rows, lab), lab) for rows, lab in variants]
    for v, lab in vs:
        _delta(v, w, f"變體{lab} − 純弱勢")

    print("\n📌 判讀提醒:")
    print("   ・樣本 < 120 個交易日時,單一大盤走勢就能左右結果,別當定論。")
    print("   ・板塊間互相重疊(如 2330 同時在封裝),樣本不是完全獨立。")
    print("   ・這裡測的是「板塊平均報酬」,不是實際下單績效(未扣手續費/滑價)。")
    print("   ・券商群聚那一段無法回測:data/chips/ 只有滾動 20 日快照,沒有逐日歷史。")


if __name__ == "__main__":
    main()
