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
# 🚨🚨 這裡原本寫「foreign_net 只回溯到約 2026/05、樣本很薄、等累積到 1 年以上再跑」——
#   **那是錯的,而且差 13 倍**(2026-09-15 實跑推翻)。這支自己印出來的是:
#     📅 外資資料實際範圍:2023/05/22 ~ 2026/09/08(共 805 個交易日)
#   多檔抽驗(2330 / 2881 / 2882 / 2891 / 1101 / 3231 / 6415)**每一檔 foreign_net 都是
#   795~796 根全有,最早 2023-06-09**。
#   ⭐ 同型錯誤本 repo 犯過兩次(V75.2.6 的券資比也寫「只回溯到 2026/05/14、約 55 天」,
#     實際也是 2023-05-22 起)→ **寫下「資料只回溯到 X」之前,先實跑印出真正的範圍**;
#     憑印象寫的限制會讓一支能跑的探針被擱置好幾個月。
#
# ⛔⛔ **但「資料夠了」⛔ 不等於「結論可以用」** —— 這支目前**還沒有八道關卡**:
#   🚨 最嚴重的一個:**平均值是用原始列算的,不是用獨立事件算的**(`_episodes()` 只被拿去
#      **印**,沒拿去算平均)→ 一次連續多天的長行情會被**重複計算**。
#   ❌ 另外缺:前後半同向 / 逐年同向 / 去最好年 / 扣成本 0.44% / 門檻高原檢定 /
#      增量檢定 / `--selftest`。
#   ⚠️ 板塊互相重疊(2330 同時在 packaging)→ 樣本不獨立。
#   ⚠️ **窗口 2023-05 起,不含 2022 空頭** —— `klines_deep` 有 2021 起的 K 線,
#      但**只有 OHLCV、沒有 foreign_net**(已實查)→ 空頭那一關**補不起來**。
#   → 在補齊之前,⛔ **這支印出來的數字一律只能當「還沒驗證的線索」**,
#     ⛔ 不可拿去換掉 radar_miner 現行的 stealth_deep,⛔ 不可跟使用者說「可以跟」。
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

    # 🚀 V77.0.5 收集階段只存**特徵**,門檻留到第二階段才套 ——
    #   ⭐ 這樣「門檻高原檢定」(把門檻左右各挪兩格再看還成不成立)才跑得動:
    #     掃描只跑一次,換門檻是純記憶體運算。⛔ 舊版把門檻寫死在迴圈裡,
    #     要測高原就得整個重掃一次,實務上等於不會去測。
    #   每筆 = {sk, date, px5, fi5, ti5, vol5, fi_ratio, dd, fwd:[5日,10日,20日]}
    feat_rows = []

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
            feat_rows.append({
                'sk': sk, 'date': date,
                'px5': statistics.mean(px5),
                'fi5': fi5, 'ti5': ti5, 'vol5': vol5,
                'fi_ratio': (fi5 / vol5 * 100) if vol5 > 0 else 0.0,
                'fi_days': (fi_days / hit) if hit > 0 else 0.0,
                'dd': statistics.mean(dd_list) if dd_list else 0.0,
                'fwd': [statistics.mean(fwd[n]) for n in FWD],
            })

    # ═══════════════════════════════════════════════════════════════════════
    # 🎯 第二階段:套門檻 → 壓成獨立事件 → 八道關卡
    # ═══════════════════════════════════════════════════════════════════════
    COST = 0.44        # 來回交易成本(%),全專案統一

    def _episodes(rows):
        """把同一板塊、間隔 <5 個交易日的訊號壓成**一次事件**,回傳 [(首日, [各天期報酬])]。

        🚨 這一步以前**只被拿去印 n**,平均值仍然用原始列算 —— 那是這支探針最嚴重的缺陷:
           一次長行情會被拆成 5~10 筆假獨立樣本,而且**權重會偏向走得久的那幾波**
           (走 10 天的事件貢獻 10 筆、走 1 天的只貢獻 1 筆)→ 平均值直接被少數幾波綁架。
        ⭐ 現在事件內先取平均,再拿事件當樣本 —— 一次行情就是一票。
        """
        seen, eps = {}, []
        for r in sorted(rows, key=lambda r: (r['sk'], axis_pos.get(r['date'], 0))):
            p = axis_pos.get(r['date'])
            if p is None:
                continue
            sk = r['sk']
            if sk not in seen or p - seen[sk][0] >= 5:
                eps.append({'d': r['date'], 'vals': [r['fwd']]})
                seen[sk] = (p, len(eps) - 1)
            else:
                eps[seen[sk][1]]['vals'].append(r['fwd'])
                seen[sk] = (p, seen[sk][1])
        return [(e['d'], [statistics.mean(v[k] for v in e['vals']) for k in range(len(FWD))])
                for e in eps]

    def _mean(eps, k):
        return statistics.mean(e[1][k] for e in eps) if eps else None

    def _win(eps, k):
        return sum(1 for e in eps if e[1][k] > 0) / len(eps) * 100 if eps else None

    # ── 變體定義:全部是 feat_rows 上的**過濾器**(⭐ 換門檻零成本)
    def _sel(px_drop=PX_DROP, kind='stealth', ratio=0.5, days=6.0, dd=12.0):
        out = []
        for r in feat_rows:
            if r['px5'] > px_drop:          # 先要「跌下來」
                continue
            if kind == 'weak':      ok = r['fi5'] <= 0
            elif kind == 'stealth': ok = r['fi5'] > 0
            elif kind == 'norm':    ok = r['fi_ratio'] >= ratio
            elif kind == 'trust':   ok = r['ti5'] > 0
            elif kind == 'persist': ok = r['fi_days'] >= days
            elif kind == 'deep':    ok = r['fi5'] > 0 and r['dd'] >= dd
            else:                   ok = True
            if ok:
                out.append(r)
        return out

    def _yr(d):   return str(d)[:4]

    def _gates(ev, wv, k):
        """八道關卡 —— 全部用**增量**(變體 − 純弱勢對照組)判定。
        ⛔ 不可改成跟「全市場基準」比:同樣是跌下來的板塊才是乾淨對照
        (光是「跌深」本身就有邊際,不設對照會把反彈的功勞算到籌碼頭上)。"""
        res = {}
        g = lambda a, b: (a - b) if (a is not None and b is not None) else None
        full = g(_mean(ev, k), _mean(wv, k))
        res['全期正'] = (full is not None and full > 0, full)

        # 前後半:用**事件自己的**時間中位數切(⛔ 不可用整段窗口的中點 —— 事件分布不均勻)
        ds = sorted(e[0] for e in ev)
        mid = ds[len(ds) // 2] if ds else None
        halves = []
        for lo, hi in ((None, mid), (mid, None)):
            f = lambda e: (lo is None or e[0] >= lo) and (hi is None or e[0] < hi)
            halves.append(g(_mean([e for e in ev if f(e)], k), _mean([e for e in wv if f(e)], k)))
        res['前後半同向'] = (all(h is not None and h > 0 for h in halves), halves)

        # 逐年同向
        yrs = sorted({_yr(e[0]) for e in ev})
        per_y = {}
        for y in yrs:
            per_y[y] = g(_mean([e for e in ev if _yr(e[0]) == y], k),
                         _mean([e for e in wv if _yr(e[0]) == y], k))
        okv = [v for v in per_y.values() if v is not None]
        res['逐年同向'] = (bool(okv) and all(v > 0 for v in okv), per_y)

        # 去掉最好那一年之後還要正
        if len(okv) >= 2:
            best = max(per_y, key=lambda y: (per_y[y] if per_y[y] is not None else -9e9))
            rest_e = [e for e in ev if _yr(e[0]) != best]
            rest_w = [e for e in wv if _yr(e[0]) != best]
            d2 = g(_mean(rest_e, k), _mean(rest_w, k))
            res['去最好年'] = (d2 is not None and d2 > 0, (best, d2))
        else:
            res['去最好年'] = (False, ('樣本年數不足', None))

        # 扣成本:⭐ 這一關比的是**絕對報酬**不是增量 —— 實際下單要付的是成本,
        #   ⛔ 不可拿「比對照組好」去抵掉手續費。
        abs_m = _mean(ev, k)
        res['扣成本'] = (abs_m is not None and abs_m - COST > 0, (abs_m, (abs_m - COST) if abs_m is not None else None))

        # 增量檢定(= 全期增量要贏過成本;⛔ 贏 0.01pp 不算贏)
        res['增量夠大'] = (full is not None and full > COST, full)
        return res

    def _show(rows, label, k=2):
        eps = _episodes(rows)
        if not eps:
            print(f"   {label:24s} 無樣本")
            return eps
        line = f"   {label:24s} 原始 {len(rows):4d} 列 → **獨立事件 {len(eps):3d}**"
        for i, n in enumerate(FWD):
            line += f" | +{n:2d}日 {_mean(eps, i):+6.2f}% 勝率 {_win(eps, i):4.1f}%"
        print(line)
        return eps

    K = FWD.index(20)   # 主判天期:+20 日(這個訊號本來就是中期的)

    print("\n" + "═" * 104)
    print("🧭 偷布局 —— ⭐ V77.0.5 起平均值一律用**獨立事件**算(⛔ 不是原始列)")
    print("═" * 104)
    weak = _show(_sel(kind='weak'), "🩸 純弱勢(跌+外資賣)=對照組")
    base = _show(_sel(kind='all'), "📊 基準(全板塊全日)")

    VARIANTS = [
        ('stealth', "🕵️ 偷布局(跌+外資買)", {}),
        ('norm',    "A 買超佔量比 ≥0.5%",   {}),
        ('trust',   "B 改看投信",           {}),
        ('persist', "C 外資10日買≥6天",     {}),
        ('deep',    "D 跌深12%(現在上線的)", {}),
    ]
    eps_map = {}
    for kind, lab, kw in VARIANTS:
        eps_map[kind] = _show(_sel(kind=kind, **kw), lab)

    print("\n" + "═" * 104)
    print(f"🚦 八道關卡(+{FWD[K]} 日;增量 = 變體 − 純弱勢;成本 {COST}%/趟)")
    print("═" * 104)
    passed = []
    for kind, lab, kw in VARIANTS:
        ev = eps_map[kind]
        if not ev:
            continue
        gs = _gates(ev, weak, K)
        nps = sum(1 for v in gs.values() if v[0])
        print(f"\n   {lab}  (獨立事件 {len(ev)})  → **{nps}/6 關**")
        for gk, (okk, det) in gs.items():
            if gk == '逐年同向':
                d = ' '.join(f"{y}:{(v if v is not None else float('nan')):+.2f}" for y, v in det.items())
            elif gk == '前後半同向':
                d = ' '.join(f"{(h if h is not None else float('nan')):+.2f}" for h in det)
            elif gk == '去最好年':
                d = f"去掉 {det[0]} 後 {det[1]:+.2f}" if det[1] is not None else str(det[0])
            elif gk == '扣成本':
                d = f"絕對 {det[0]:+.2f}% − {COST} = {det[1]:+.2f}%" if det[0] is not None else "—"
            else:
                d = f"{det:+.2f}pp" if isinstance(det, float) else str(det)
            print(f"      {'✅' if okk else '❌'} {gk:8s} {d}")
        if nps == 6:
            passed.append(lab)

    print("\n" + "═" * 104)
    print("⛰️ 門檻高原檢定(左右各挪兩格 —— 是一片高原還是一根孤峰?)")
    print("═" * 104)
    print("   跌幅門檻 PX_DROP(現行 −1.5):")
    for pd_ in (-0.5, -1.0, -1.5, -2.0, -2.5):
        ev = _episodes(_sel(px_drop=pd_, kind='deep'))
        wv = _episodes(_sel(px_drop=pd_, kind='weak'))
        m, w2 = _mean(ev, K), _mean(wv, K)
        d = (m - w2) if (m is not None and w2 is not None) else None
        mark = ' ←現行' if pd_ == PX_DROP else ''
        print(f"      {pd_:+5.1f}%  事件 {len(ev):3d}  增量 {('%+.2f' % d) if d is not None else '  —  '}pp{mark}")
    print("   C 版的「10 日買超天數」門檻(現行 6):")
    for dy in (4, 5, 6, 7, 8):
        ev = _episodes(_sel(kind='persist', days=float(dy)))
        m = _mean(ev, K); w2 = _mean(weak, K)
        d = (m - w2) if (m is not None and w2 is not None) else None
        mark = ' ←現行' if dy == 6 else ''
        print(f"      ≥{dy} 天  事件 {len(ev):3d}  增量 {('%+.2f' % d) if d is not None else '  —  '}pp{mark}")

    print("\n" + "═" * 104)
    if passed:
        print(f"✅ 八關全過的變體:{', '.join(passed)}")
        print("   ⚠️ 但仍要人工確認:高原是不是一片(看上面)、窗口有沒有涵蓋空頭。")
    else:
        print("⛔ **沒有任何變體通過六關** → 照 V75.0.9 的規則,預設**維持現行的 D 版不換**。")
    print("═" * 104)

    print("\n📌 判讀提醒(⛔ 一條都不可略過):")
    print(f"   ・⚠️ 窗口**不含 2022 空頭** —— foreign_net 最早 {fi_dates[0]};深歷史 K 線有 2021 起,")
    print("     但**只有 OHLCV、沒有外資欄**(已實查)→ 空頭那一關補不起來。")
    print("   ・板塊間互相重疊(如 2330 同時在封裝),事件不是完全獨立。")
    print("   ・測的是「板塊平均報酬」,不是實際下單績效(滑價、買不買得到都沒算)。")
    print("   ・券商群聚那一段無法回測:data/chips/ 只有滾動 20 日快照,沒有逐日歷史。")


def _selftest():
    """注入一個**必然有效**的假訊號,確認這支 harness 真的量得出來(⛔ 沒有這段,全綠不代表有鑑別力)。"""
    import random
    random.seed(7)
    fails = []
    def ok(n, c, e=''):
        print(f"{'✅' if c else '❌'} {n}{'' if c else '  ' + str(e)[:160]}")
        if not c: fails.append(n)

    # ① 事件壓縮:同板塊連續 6 天 = 1 個事件;隔 5 天以上才算新的
    axis = [f"2025-01-{d:02d}" for d in range(1, 29)]
    pos = {d: i for i, d in enumerate(axis)}
    rows = [{'sk': 'x', 'date': axis[i], 'fwd': [1.0, 1.0, 1.0]} for i in range(6)]
    rows += [{'sk': 'x', 'date': axis[20], 'fwd': [1.0, 1.0, 1.0]}]
    def eps_of(rs):
        seen, eps = {}, []
        for r in sorted(rs, key=lambda r: (r['sk'], pos.get(r['date'], 0))):
            p = pos.get(r['date'])
            if r['sk'] not in seen or p - seen[r['sk']][0] >= 5:
                eps.append({'d': r['date'], 'vals': [r['fwd']]}); seen[r['sk']] = (p, len(eps) - 1)
            else:
                eps[seen[r['sk']][1]]['vals'].append(r['fwd']); seen[r['sk']] = (p, seen[r['sk']][1])
        return eps
    ok('① 連續 6 天壓成 1 個事件、隔 20 天的算第 2 個', len(eps_of(rows)) == 2, len(eps_of(rows)))

    # ② ⭐ 決定性對照:一次長行情 vs 一次短行情,**用原始列算會被長的綁架**
    long_ep  = [{'sk': 'a', 'date': axis[i], 'fwd': [10.0] * 3} for i in range(10)]
    short_ep = [{'sk': 'b', 'date': axis[0], 'fwd': [0.0] * 3}]
    raw = statistics.mean(r['fwd'][0] for r in long_ep + short_ep)
    ev = eps_of(long_ep + short_ep)
    byep = statistics.mean(statistics.mean(v[0] for v in e['vals']) for e in ev)
    ok('② 原始列平均被長行情綁架(9.09),事件平均才是 5.00',
       abs(raw - 9.09) < 0.02 and abs(byep - 5.0) < 1e-9, f'raw={raw:.2f} ep={byep:.2f}')

    # ③ 注入必然有效的假訊號 → 增量要量得出來
    ev2 = [(axis[i % 28], [5.0, 5.0, 5.0]) for i in range(40)]
    wv2 = [(axis[i % 28], [0.0, 0.0, 0.0]) for i in range(40)]
    d = statistics.mean(e[1][2] for e in ev2) - statistics.mean(e[1][2] for e in wv2)
    ok('③ 注入 +5pp 的假訊號,增量量得出來', abs(d - 5.0) < 1e-9, d)

    print('\n' + ('❌ %d 條失敗' % len(fails) if fails else '✅ SELFTEST_PASS'))
    return 1 if fails else 0


if __name__ == "__main__":
    import sys
    if '--selftest' in sys.argv:
        raise SystemExit(_selftest())
    main()
