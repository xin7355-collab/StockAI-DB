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
# 🔁 V79.4.3(16 年全市場 d16 重跑前修好,陷阱 #50 / #52):
#   ・對照改**同一天**:每一個板塊·日的報酬先減掉「同一天、所有合格成分股(去重)」的平均報酬 → 再拿偷布局 vs 純弱勢比;
#     ⛔ 不再拿兩群事件的整段平均直接相減(兩群事件落在不同年份時,整段平均會憑空造出「優勢」)。
#     那天合格成分股不到 MIN_CTRL(30)檔 → 那天的板塊·日不算,印出丟了幾列。
#   ・外資 / 投信欄缺 = 不知道(⛔ 不當 0):那檔成分股那天不算(舊寫法 `or 0` 會把沒資料的板塊算成「外資在賣」→ 灌進純弱勢對照組)。
#   ・訊號日收盤停在漲停 → 尾盤買不到(lib_limit,2015-06 前 ±7%):那檔的報酬不算(事件、對照一起)。
#   ・價格斷崖(×1.5 / ×0.67):以前完全沒守 → 「60 日高點 + 持有 20 天」碰到斷崖的成分股·日不算(⛔ 不整檔剔除)。
#   ・「扣成本」那一關照舊看**絕對**報酬(要付的是真的成本),其他關卡一律用同一天對照後的數字。
#
# 用法:python3 sector_flow_probe.py     (只讀 data/,不寫任何檔、不呼叫任何 API)
#       DATA_DIR=… python3 sector_flow_probe.py ・ python3 sector_flow_probe.py --selftest
# ═══════════════════════════════════════════════════════════════════════════
import json
import os
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / 'scripts'))
import lib_limit as LL  # noqa: E402  🔁 V79.4.3 漲跌幅制度 + 斷崖守門共用(⛔ 不在這裡各寫一份)

DATA_DIR = Path(os.environ.get("DATA_DIR") or "data")   # V78.4.7:可指到修好的資料

try:
    from radar_miner import SECTOR_MEMBERS
except Exception:                                    # 獨立執行時的後備
    SECTOR_MEMBERS = {}

FWD = (5, 10, 20)          # 前瞻天數
PX_DROP = -1.5             # 偷布局門檻:板塊近 5 日平均跌幅
MIN_MEMBERS = 2            # 一個板塊至少要幾檔有資料才算數
COST = 0.44                # 來回交易成本(%),全專案統一
MIN_CTRL = 30              # 🔁 V79.4.3 同一天的對照(合格成分股)至少要這麼多檔,不夠 → 那天不算(⛔ 不拿別天湊)
LOOK = 59                  # 🔁 V79.4.3 斷崖窗口往回看到 60 日高點那一段


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


def _num(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _prefix(rows):
    """🔁 V79.4.3 一檔的斷崖前綴和(lib_limit.cliff_prefix;收盤 + 開盤 vs 前收)。"""
    return LL.cliff_prefix([_num(r.get("close")) for r in rows], [_num(r.get("open")) for r in rows])


def _member(rows, i, pre):
    """🔁 V79.4.3 一檔成分股在第 i 根(訊號日)的特徵 + 之後的報酬(從 main 搬出來,selftest 直接測)。
    回 (dict, None) 或 (None, 原因):'short' 資料不夠 / 'bad' 價格壞 / 'cliff' 窗口碰到斷崖 / 'unk' 法人欄缺(⛔ 不當 0)。
    dict['fwd'] = [5日, 10日, 20日] 報酬%;訊號日收盤停在漲停 → lu=True、fwd 全 None(買不到;特徵照算 —— 收盤後就知道)。"""
    if i < 61 or i + max(FWD) >= len(rows):
        return None, 'short'
    c0, c1 = _num(rows[i - 5].get("close")), _num(rows[i].get("close"))
    if not (c0 > 0 and c1 > 0):
        return None, 'bad'
    # 🔁 V79.4.3 60 日高點那一段 + 持有 20 天碰到價格斷崖 → 這檔這天不算(⛔ 不整檔剔除)
    if LL.cliff_in(pre, i - LOOK, i + max(FWD)):
        return None, 'cliff'
    fw = [rows[k].get("foreign_net") for k in range(i - 9, i + 1)]
    tw = [rows[k].get("trust_net") for k in range(i - 4, i + 1)]
    # 🔁 V79.4.3 外資 / 投信欄缺 = 不知道(⛔ 舊寫法 `or 0` 把它算成「外資沒買」→ 灌進純弱勢對照組)
    if any(v is None for v in fw) or any(v is None for v in tw):
        return None, 'unk'
    m = {
        'px5': (c1 - c0) / c0 * 100,
        'fi5': sum(_num(v) for v in fw[-5:]) / 1000.0,
        'ti5': sum(_num(v) for v in tw) / 1000.0,
        'vol5': sum(_num(rows[k].get("volume")) for k in range(i - 4, i + 1)) / 1000.0,
        'fi_days': sum(1 for v in fw if _num(v) > 0),   # 近 10 日外資「買超天數」(持續性)
        'dd': None, 'lu': False, 'fwd': [None] * len(FWD),
    }
    hi60 = max(_num(rows[k].get("high")) for k in range(i - 59, i + 1))
    if hi60 > 0:
        m['dd'] = (hi60 - c1) / hi60 * 100           # 距 60 日高點回檔%
    # 🔁 V79.4.3 訊號日收盤停在漲停(2015-06 前 ±7%,lib_limit)→ 尾盤買不到 → 這檔的報酬不算(事件、對照一起)
    if LL.up_limit_close(rows[i].get("date"), c1, _num(rows[i - 1].get("close"))):
        m['lu'] = True
        return m, None
    for j, n in enumerate(FWD):
        cn = _num(rows[i + n].get("close"))
        if cn > 0:
            m['fwd'][j] = (cn - c1) / c1 * 100
    return m, None


def collect_feats(book, members, axis, fi_set=None):
    """掃描(🔁 V79.4.3 從 main 搬出來,selftest 直接測)。
    回 (feat_rows, univ, skip):
      feat_rows 每筆 = {sk, date, px5, fi5, ti5, vol5, fi_ratio, fi_days, dd, fwd:[5日,10日,20日](原始報酬)}
      univ[date] = ([該天所有合格成分股(去重)的平均報酬 ×3], 檔數) —— 同一天對照用
      skip = 成分股·日被剔除的原因次數(cliff / unk / lu)"""
    # 🚀 V77.0.5 收集階段只存**特徵**,門檻留到第二階段才套 ——
    #   ⭐ 這樣「門檻高原檢定」(把門檻左右各挪兩格再看還成不成立)才跑得動:
    #     掃描只跑一次,換門檻是純記憶體運算。⛔ 舊版把門檻寫死在迴圈裡,
    #     要測高原就得整個重掃一次,實務上等於不會去測。
    pre = {s: _prefix(b["rows"]) for s, b in book.items()}
    feat_rows, univ, skip = [], {}, {'cliff': 0, 'unk': 0, 'lu': 0}
    for t_i in range(20, len(axis) - max(FWD)):
        date = axis[t_i]
        if fi_set is not None and date not in fi_set:
            continue
        cache = {}

        def get(s):
            if s not in cache:
                b = book.get(s)
                if not b or date not in b["idx"]:
                    cache[s] = None
                else:
                    m, why = _member(b["rows"], b["idx"][date], pre[s])
                    if why in skip:
                        skip[why] += 1
                    if m is not None and m['lu']:
                        skip['lu'] += 1
                    cache[s] = m
            return cache[s]
        for sk, syms in members.items():
            ms = [m for m in (get(s) for s in syms) if m is not None]
            hit = len(ms)
            fwd = {n: [m['fwd'][j] for m in ms if m['fwd'][j] is not None] for j, n in enumerate(FWD)}
            if hit < MIN_MEMBERS or not all(fwd[n] for n in FWD):
                continue
            fi5, ti5, vol5 = sum(m['fi5'] for m in ms), sum(m['ti5'] for m in ms), sum(m['vol5'] for m in ms)
            dd_list = [m['dd'] for m in ms if m['dd'] is not None]
            feat_rows.append({
                'sk': sk, 'date': date,
                'px5': statistics.mean(m['px5'] for m in ms),
                'fi5': fi5, 'ti5': ti5, 'vol5': vol5,
                'fi_ratio': (fi5 / vol5 * 100) if vol5 > 0 else 0.0,
                'fi_days': sum(m['fi_days'] for m in ms) / hit,
                'dd': statistics.mean(dd_list) if dd_list else 0.0,
                'fwd': [statistics.mean(fwd[n]) for n in FWD],
            })
        # 🔁 V79.4.3 同一天對照:這一天所有合格成分股(去重;斷崖 / 法人缺 / 收漲停買不到的都不在裡面)
        full = [m['fwd'] for m in cache.values() if m is not None and all(v is not None for v in m['fwd'])]
        if full:
            univ[date] = ([sum(f[k] for f in full) / len(full) for k in range(len(FWD))], len(full))
    return feat_rows, univ, skip


def same_day_adjust(feat_rows, univ):
    """🔁 V79.4.3 同一天對照(陷阱 #50):每一個板塊·日的報酬減掉「同一天、所有合格成分股」的平均 → 'fwda'(原始的 'fwd' 留著給「扣成本」那關)。
    那天合格成分股不到 MIN_CTRL 檔 → 那一列不算(⛔ 拿別天的平均湊)。回 (留下的列, 丟掉幾列)。"""
    out, dropped = [], 0
    for r in feat_rows:
        u = univ.get(r['date'])
        if not u or u[1] < MIN_CTRL:
            dropped += 1
            continue
        r2 = dict(r)
        r2['fwda'] = [r['fwd'][k] - u[0][k] for k in range(len(FWD))]
        out.append(r2)
    return out, dropped


def _episodes(rows, axis_pos):
    """把同一板塊、間隔 <5 個交易日的訊號壓成**一次事件**,回傳 [(首日, [各天期同日對照後報酬], [各天期原始報酬])]。

    🚨 這一步以前**只被拿去印 n**,平均值仍然用原始列算 —— 那是這支探針最嚴重的缺陷:
       一次長行情會被拆成 5~10 筆假獨立樣本,而且**權重會偏向走得久的那幾波**
       (走 10 天的事件貢獻 10 筆、走 1 天的只貢獻 1 筆)→ 平均值直接被少數幾波綁架。
    ⭐ 現在事件內先取平均,再拿事件當樣本 —— 一次行情就是一票。
    🔁 V79.4.3 第二格 = 同一天對照後的報酬('fwda',沒有就用原始);第三格 = 原始報酬(「扣成本」與描述用)。
    """
    seen, eps = {}, []
    for r in sorted(rows, key=lambda r: (r['sk'], axis_pos.get(r['date'], 0))):
        p = axis_pos.get(r['date'])
        if p is None:
            continue
        sk = r['sk']
        v = (r.get('fwda') or r['fwd'], r['fwd'])
        if sk not in seen or p - seen[sk][0] >= 5:
            eps.append({'d': r['date'], 'vals': [v]})
            seen[sk] = (p, len(eps) - 1)
        else:
            eps[seen[sk][1]]['vals'].append(v)
            seen[sk] = (p, seen[sk][1])
    return [(e['d'], [statistics.mean(v[0][k] for v in e['vals']) for k in range(len(FWD))],
             [statistics.mean(v[1][k] for v in e['vals']) for k in range(len(FWD))]) for e in eps]


def _mean(eps, k, raw=False):
    i = 2 if raw else 1
    return statistics.mean(e[i][k] for e in eps) if eps else None


def _win(eps, k, raw=False):
    i = 2 if raw else 1
    return sum(1 for e in eps if e[i][k] > 0) / len(eps) * 100 if eps else None


def _sel(feat_rows, px_drop=PX_DROP, kind='stealth', ratio=0.5, days=6.0, dd=12.0):
    """變體定義:全部是 feat_rows 上的**過濾器**(⭐ 換門檻零成本)"""
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


def _yr(d):
    return str(d)[:4]


def _gates(ev, wv, k):
    """八道關卡 —— 全部用**增量**(變體 − 純弱勢對照組)判定。
    ⛔ 不可改成跟「全市場基準」比:同樣是跌下來的板塊才是乾淨對照
    (光是「跌深」本身就有邊際,不設對照會把反彈的功勞算到籌碼頭上)。
    🔁 V79.4.3 兩邊都先減掉「同一天」的成分股平均再比(⛔ 不再拿兩群的整段平均直接相減)。"""
    res = {}
    g = lambda a, b: (a - b) if (a is not None and b is not None) else None   # noqa: E731
    full = g(_mean(ev, k), _mean(wv, k))
    res['全期正'] = (full is not None and full > 0, full)

    # 前後半:用**事件自己的**時間中位數切(⛔ 不可用整段窗口的中點 —— 事件分布不均勻)
    ds = sorted(e[0] for e in ev)
    mid = ds[len(ds) // 2] if ds else None
    halves = []
    for lo, hi in ((None, mid), (mid, None)):
        f = lambda e: (lo is None or e[0] >= lo) and (hi is None or e[0] < hi)   # noqa: E731
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
    abs_m = _mean(ev, k, raw=True)
    res['扣成本'] = (abs_m is not None and abs_m - COST > 0, (abs_m, (abs_m - COST) if abs_m is not None else None))

    # 增量檢定(= 全期增量要贏過成本;⛔ 贏 0.01pp 不算贏)
    res['增量夠大'] = (full is not None and full > COST, full)
    return res


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

    feat_rows, univ, skip = collect_feats(book, SECTOR_MEMBERS, axis, set(fi_dates))
    print(f"🔁 V79.4.3 成分股·日剔除:窗口碰到斷崖 {skip['cliff']:,} ・法人欄缺(⛔ 不當 0){skip['unk']:,}"
          f" ・訊號日收漲停買不到(只剔報酬,2015-06 前 ±7%){skip['lu']:,}")
    feat_rows, dropped = same_day_adjust(feat_rows, univ)
    okd = sum(1 for u in univ.values() if u[1] >= MIN_CTRL)
    print(f"   同一天對照:{okd:,} / {len(univ):,} 天有 ≥{MIN_CTRL} 檔合格成分股;不夠 → 那天的板塊·日不算:丟 {dropped:,} 列")

    # ═══════════════════════════════════════════════════════════════════════
    # 🎯 第二階段:套門檻 → 壓成獨立事件 → 八道關卡
    # ═══════════════════════════════════════════════════════════════════════
    def _show(rows, label, k=2):
        eps = _episodes(rows, axis_pos)
        if not eps:
            print(f"   {label:24s} 無樣本")
            return eps
        line = f"   {label:24s} 原始 {len(rows):4d} 列 → **獨立事件 {len(eps):3d}**"
        for i, n in enumerate(FWD):
            line += f" | +{n:2d}日 {_mean(eps, i, raw=True):+6.2f}% 勝率 {_win(eps, i, raw=True):4.1f}%"
        print(line)
        # 🔁 V79.4.3 同一天對照後(⭐ 關卡用這個;上一行是原始報酬,只當描述)
        print(f"   {'':24s} └ 同一天對照後:" + " | ".join(f"+{n:2d}日 {_mean(eps, i):+6.2f}pp" for i, n in enumerate(FWD)))
        return eps

    K = FWD.index(20)   # 主判天期:+20 日(這個訊號本來就是中期的)

    print("\n" + "═" * 104)
    print("🧭 偷布局 —— ⭐ V77.0.5 起平均值一律用**獨立事件**算(⛔ 不是原始列);🔁 V79.4.3 關卡一律用同一天對照後的數字")
    print("═" * 104)
    weak = _show(_sel(feat_rows, kind='weak'), "🩸 純弱勢(跌+外資賣)=對照組")
    base = _show(_sel(feat_rows, kind='all'), "📊 基準(全板塊全日)")   # noqa: F841

    VARIANTS = [
        ('stealth', "🕵️ 偷布局(跌+外資買)", {}),
        ('norm',    "A 買超佔量比 ≥0.5%",   {}),
        ('trust',   "B 改看投信",           {}),
        ('persist', "C 外資10日買≥6天",     {}),
        ('deep',    "D 跌深12%(現在上線的)", {}),
    ]
    eps_map = {}
    for kind, lab, kw in VARIANTS:
        eps_map[kind] = _show(_sel(feat_rows, kind=kind, **kw), lab)

    print("\n" + "═" * 104)
    print(f"🚦 八道關卡(+{FWD[K]} 日;增量 = 變體 − 純弱勢,兩邊都先減同一天平均;成本 {COST}%/趟)")
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
        ev = _episodes(_sel(feat_rows, px_drop=pd_, kind='deep'), axis_pos)
        wv = _episodes(_sel(feat_rows, px_drop=pd_, kind='weak'), axis_pos)
        m, w2 = _mean(ev, K), _mean(wv, K)
        d = (m - w2) if (m is not None and w2 is not None) else None
        mark = ' ←現行' if pd_ == PX_DROP else ''
        print(f"      {pd_:+5.1f}%  事件 {len(ev):3d}  增量 {('%+.2f' % d) if d is not None else '  —  '}pp{mark}")
    print("   C 版的「10 日買超天數」門檻(現行 6):")
    for dy in (4, 5, 6, 7, 8):
        ev = _episodes(_sel(feat_rows, kind='persist', days=float(dy)), axis_pos)
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
    if str(fi_dates[0]).replace('/', '-') >= '2022-01-01':
        print(f"   ・⚠️ 窗口**不含 2022 空頭** —— foreign_net 最早 {fi_dates[0]};深歷史 K 線有 2021 起,")
        print("     但**只有 OHLCV、沒有外資欄**(已實查)→ 空頭那一關補不起來。")
    else:
        print(f"   ・窗口從 {fi_dates[0]} 起(外資最早那天),含 2022 空頭。")
    print("   ・板塊間互相重疊(如 2330 同時在封裝),事件不是完全獨立。")
    print("   ・測的是「板塊平均報酬」,不是實際下單績效(滑價都沒算;🔁 V79.4.3 起收漲停買不到的那檔已剔)。")
    print("   ・券商群聚那一段無法回測:data/chips/ 只有滾動 20 日快照,沒有逐日歷史。")


def _selftest():
    """注入一個**必然有效**的假訊號,確認這支 harness 真的量得出來(⛔ 沒有這段,全綠不代表有鑑別力)。
    🔁 V79.4.3 ①~③ 改呼叫真的 _episodes / _gates(⛔ 不在測試裡複製一份邏輯);④~⑦ 是這次三個修正的決定性對照。"""
    import random
    random.seed(7)
    fails = []

    def ok(n, c, e=''):
        print(f"{'✅' if c else '❌'} {n}{'' if c else '  ' + str(e)[:200]}")
        if not c:
            fails.append(n)

    # ① 事件壓縮:同板塊連續 6 天 = 1 個事件;隔 5 天以上才算新的
    axis = [f"2025-01-{d:02d}" for d in range(1, 29)]
    pos = {d: i for i, d in enumerate(axis)}
    rows = [{'sk': 'x', 'date': axis[i], 'fwd': [1.0, 1.0, 1.0]} for i in range(6)]
    rows += [{'sk': 'x', 'date': axis[20], 'fwd': [1.0, 1.0, 1.0]}]
    ok('① 連續 6 天壓成 1 個事件、隔 20 天的算第 2 個', len(_episodes(rows, pos)) == 2, len(_episodes(rows, pos)))

    # ② ⭐ 決定性對照:一次長行情 vs 一次短行情,**用原始列算會被長的綁架**
    long_ep = [{'sk': 'a', 'date': axis[i], 'fwd': [10.0] * 3} for i in range(10)]
    short_ep = [{'sk': 'b', 'date': axis[0], 'fwd': [0.0] * 3}]
    raw = statistics.mean(r['fwd'][0] for r in long_ep + short_ep)
    byep = _mean(_episodes(long_ep + short_ep, pos), 0)
    ok('② 原始列平均被長行情綁架(9.09),事件平均才是 5.00',
       abs(raw - 9.09) < 0.02 and abs(byep - 5.0) < 1e-9, f'raw={raw:.2f} ep={byep:.2f}')

    # ③ 注入必然有效的假訊號 → 增量要量得出來(走真的 _gates)
    ev2 = [(axis[i % 28], [5.0, 5.0, 5.0], [5.0, 5.0, 5.0]) for i in range(40)]
    wv2 = [(axis[i % 28], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]) for i in range(40)]
    d = _gates(ev2, wv2, 2)['全期正'][1]
    ok('③ 注入 +5pp 的假訊號,增量量得出來', d is not None and abs(d - 5.0) < 1e-9, d)

    # ── 🔁 V79.4.3 合成成分股(日期照 d16 寫 YYYY/MM/DD)──
    import datetime as dt

    def days_from(y, m, dd, n):
        t, out = dt.date(y, m, dd), []
        while len(out) < n:
            if t.weekday() < 5:
                out.append(t.strftime('%Y/%m/%d'))
            t += dt.timedelta(days=1)
        return out

    def mk_rows(dates, mkt, drops, fi, seed, mut=None):
        """mkt(i) 大盤漂移;drops = 那幾天起股價 ×0.96(跌下來就停在那);fi(i) 回 None = 那天法人欄整個不寫(= 沒資料,⛔ 不是 0)"""
        rnd, c, out = random.Random(seed), 100.0, []
        dset = set(drops)
        for i, d_ in enumerate(dates):
            c *= (1 + mkt(i) + rnd.uniform(-0.001, 0.001)) * (0.96 if i in dset else 1.0)
            r = {'date': d_, 'open': round(c, 4), 'high': round(c * 1.002, 4), 'low': round(c * 0.998, 4), 'close': round(c, 4), 'volume': 1000000}
            f = fi(i)
            if f is not None:
                r['foreign_net'] = f
                r['trust_net'] = 0
            out.append(r)
        if mut:
            mut(out)
        return out

    def to_book(rows_by_sym):
        return {s_: {'rows': rs, 'idx': {r['date']: i for i, r in enumerate(rs)}} for s_, rs in rows_by_sym.items()}

    # ④ 同一天對照(陷阱 #50)—— ⭐ 決定性對照:每一檔每天都跟大盤一樣漂,只有「跌下來那一下」是自己的
    #    純弱勢(外資賣)只出現在前 300 天(大盤每天 +0.25%)、偷布局(外資買)只出現在後段(大盤每天 −0.15%)
    #    → 舊算法(兩群整段平均直接相減)憑空量出 −8pp 左右;同一天對照 ≈ 0。另外 40 檔「陪跑」的成分股從來不跌。
    dates = days_from(2016, 1, 4, 600)
    mkt = lambda i: 0.0025 if i < 300 else -0.0015        # noqa: E731
    rows_by, members = {}, {}
    for g in range(8):
        drops = [80 + 15 * g + 60 * j for j in range(3)] if g < 4 else [320 + 15 * (g - 4) + 60 * j for j in range(4)]
        sign = -5000 if g < 4 else 5000
        win = set(k for D in drops for k in range(D - 5, D + 6))
        members[f's{g}'] = []
        for m_ in range(5):
            sym = f'9{g}{m_:02d}'
            members[f's{g}'].append(sym)
            rows_by[sym] = mk_rows(dates, mkt, drops, lambda i, w=win, sg=sign, sd=g * 10 + m_: sg if i in w else (100 if (i * 7 + sd) % 3 else -100), 1000 + g * 10 + m_)
    for g in range(4):
        members[f'f{g}'] = []
        for m_ in range(10):
            sym = f'8{g}{m_:02d}'
            members[f'f{g}'].append(sym)
            rows_by[sym] = mk_rows(dates, mkt, [], lambda i, sd=g * 10 + m_: 100 if (i * 5 + sd) % 3 else -100, 2000 + g * 10 + m_)
    book = to_book(rows_by)
    apos = {d_: i for i, d_ in enumerate(dates)}
    feat, univ, skip = collect_feats(book, members, dates, None)
    fa, dropped = same_day_adjust(feat, univ)
    K = FWD.index(20)
    ev = _episodes(_sel(fa, kind='stealth'), apos)
    wv = _episodes(_sel(fa, kind='weak'), apos)
    raw_inc = (_mean(ev, K, raw=True) - _mean(wv, K, raw=True)) if ev and wv else None
    adj_inc = _gates(ev, wv, K)['全期正'][1] if ev and wv else None
    ok(f'④ 事件數對得上(純弱勢 {len(wv)} 次 / 偷布局 {len(ev)} 次)、每天都有 ≥{MIN_CTRL} 檔對照(丟 {dropped} 列)',
       len(wv) == 12 and len(ev) == 16 and dropped == 0, (len(wv), len(ev), dropped))
    ok(f'④ 決定性對照:兩群整段平均直接相減(舊)憑空 {raw_inc if raw_inc is None else round(raw_inc, 2)}pp(< −4);同一天對照 {adj_inc if adj_inc is None else round(adj_inc, 2)}pp(≈ 0)',
       raw_inc is not None and raw_inc < -4 and adj_inc is not None and abs(adj_inc) < 1.0, (raw_inc, adj_inc))

    # ⑤ 法人欄缺 ⛔ 當 0:x 板塊跌下來那幾天外資欄整個沒有、y 板塊外資在賣 → x ⛔ 不可被算成「純弱勢」
    d5 = days_from(2016, 1, 4, 200)
    rb5 = {}
    for m_ in range(3):
        rb5[f'71{m_:02d}'] = mk_rows(d5, lambda i: 0.0, [100], lambda i: None if 90 <= i <= 110 else -100, 3000 + m_)
        rb5[f'72{m_:02d}'] = mk_rows(d5, lambda i: 0.0, [100], lambda i: -5000 if 95 <= i <= 105 else 100, 3100 + m_)
    f5, u5, sk5 = collect_feats(to_book(rb5), {'x': [f'71{m_:02d}' for m_ in range(3)], 'y': [f'72{m_:02d}' for m_ in range(3)]}, d5, None)
    fa5, dr5 = same_day_adjust(f5, u5)
    ok(f'⑤b 同一天合格成分股只有 ≤6 檔(< {MIN_CTRL})→ 板塊·日全部不算、數得出丟了 {dr5} 列(⛔ 拿別天湊)',
       len(fa5) == 0 and dr5 == len(f5) > 0, (len(fa5), dr5, len(f5)))
    wk = _sel(f5, kind='weak')
    xs, ys = [r for r in wk if r['sk'] == 'x'], [r for r in wk if r['sk'] == 'y']
    ok(f'⑤ 法人欄缺的那幾天 → x 板塊一列都不算(舊寫法會塞 {5} 列「外資在賣」);y 照算 {len(ys)} 列;剔除原因 unk {sk5["unk"]}',
       len(xs) == 0 and len(ys) == 5 and sk5['unk'] > 0, (len(xs), len(ys), sk5))

    # ⑥ 2015-06 前漲跌幅 ±7%:2012 年訊號日收 +7% = 收在漲停 → 尾盤買不到(報酬不算);同一根在 2020 年 → 照算
    def lu_case(y):
        dd_ = days_from(y, 1, 2, 120)

        def bump(rs):
            for k in range(90, len(rs)):
                for f_ in ('open', 'high', 'low', 'close'):
                    rs[k][f_] = round(rs[k][f_] * 1.07, 4)
        rs = mk_rows(dd_, lambda i: 0.0, [], lambda i: 100, 4000 + y, mut=bump)
        m, why = _member(rs, 90, _prefix(rs))
        return dd_[90], m, why
    d12, m12, w12 = lu_case(2012)
    d20, m20, w20 = lu_case(2020)
    ok(f'⑥ 2012 年({d12})收 +7% = 收在漲停 → 買不到、報酬不算(特徵照算);同一根在 2020 年({d20})→ 照算',
       w12 is None and m12['lu'] and m12['fwd'] == [None, None, None] and m12['px5'] > 5
       and w20 is None and not m20['lu'] and all(v is not None for v in m20['fwd']), (m12 and m12['lu'], m20 and m20['lu']))

    # ⑦ 斷崖只剔碰到的窗口(⛔ 不整檔剔除):第 150 根起 ×1.6
    d7 = days_from(2016, 1, 4, 300)

    def cliff_mut(rs):
        for k in range(150, len(rs)):
            for f_ in ('open', 'high', 'low', 'close'):
                rs[k][f_] = round(rs[k][f_] * 1.6, 4)
    r7 = mk_rows(d7, lambda i: 0.0, [], lambda i: 100, 5000, mut=cliff_mut)
    p7 = _prefix(r7)
    got = {i: _member(r7, i, p7)[1] for i in (100, 140, 200, 230)}
    ok(f'⑦ 斷崖在第 150 根:第 100 / 230 根照算、第 140(持有會碰到)/ 200(60 日高點那段會碰到)不算 → {got}',
       got == {100: None, 140: 'cliff', 200: 'cliff', 230: None}, got)

    print('\n' + ('❌ %d 條失敗' % len(fails) if fails else '✅ SELFTEST_PASS'))
    return 1 if fails else 0


if __name__ == "__main__":
    if '--selftest' in sys.argv:
        raise SystemExit(_selftest())
    main()
