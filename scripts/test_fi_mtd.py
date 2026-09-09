#!/usr/bin/env python3
"""外資「當月累計」買賣超(V71.6.1)離線單元測試。

沙箱連不到 twse.com.tw,所以把「解析」與「累計判斷」抽成純函式
(_bfi82u_parse_rwd / _foreign_net_100m / _month_weekdays)在這裡測。
網路層只負責取資料 + 全程 fallback,取不到就回 None(不給半套假累計)。
"""
import os
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault('SKIP_GLOBAL', '1')
for _m in ('yfinance',):
    if _m not in sys.modules:
        _s = types.ModuleType(_m)
        _s.Ticker = lambda *a, **k: None
        sys.modules[_m] = _s

import macro_miner as M   # noqa: E402

TW = timezone(timedelta(hours=8))
fails = []


def eq(name, got, want):
    ok = got == want
    print(f"{'✅' if ok else '❌'} {name}: {got!r}" + ('' if ok else f' (期望 {want!r})'))
    if not ok:
        fails.append(name)


# ── ① rwd 解析:正常 payload ──────────────────────────────────────
J_OK = {
    "stat": "OK",
    "date": "20260729",
    "fields": ["單位名稱", "買進金額", "賣出金額", "買賣差額"],
    "data": [
        ["自營商(自行買賣)", "5,000,000,000", "4,000,000,000", "1,000,000,000"],
        ["自營商(避險)", "3,000,000,000", "3,500,000,000", "-500,000,000"],
        ["投資信託", "8,000,000,000", "9,000,000,000", "-1,000,000,000"],
        ["外資及陸資(不含外資自營商)", "100,000,000,000", "122,000,000,000", "-22,000,000,000"],
        ["外資自營商", "1,000,000,000", "1,252,000,000", "-252,000,000"],
        ["合計", "117,000,000,000", "139,752,000,000", "-22,752,000,000"],
    ],
}
rows = M._bfi82u_parse_rwd(J_OK)
eq("① 解析列數", len(rows), 6)
eq("① 第 1 列", rows[0], ("自營商(自行買賣)", 1_000_000_000))

# 外資 = 外資及陸資 + 外資自營商 = -22,252,000,000 元 = -222.52 億
net, hit = M._foreign_net_100m(rows)
eq("② 外資合計(億)", net, -222.52)
eq("② 命中兩列(含外資自營商)", len(hit), 2)

# ── ③ 欄位順序不同 / 欄名寫「買賣超」也要吃 ──────────────────────
J_ALT = {
    "fields": ["單位名稱", "買賣超", "買進金額"],
    "data": [["外資及陸資", "-7,582,000,000,000", "1"]],
}
eq("③ 換欄名+換位置", M._foreign_net_100m(M._bfi82u_parse_rwd(J_ALT))[0], -75820.0)

# ── ④ 沒有 fields 時退回「最後一欄」 ────────────────────────────
J_NOF = {"data": [["外資及陸資", "1", "2", "-500,000,000"]]}
eq("④ 無 fields 退最後一欄", M._foreign_net_100m(M._bfi82u_parse_rwd(J_NOF))[0], -5.0)

# ── ⑤ 空/壞 payload 不能 throw,要回空 ──────────────────────────
eq("⑤ None", M._bfi82u_parse_rwd(None), [])
eq("⑤ 休市(data 空)", M._bfi82u_parse_rwd({"stat": "很抱歉，沒有符合條件的資料!", "data": []}), [])
eq("⑤ 找不到外資列 → None", M._foreign_net_100m([("投資信託", 100)])[0], None)
eq("⑤ 髒值那列跳過不整批失敗",
   M._foreign_net_100m(M._bfi82u_parse_rwd({
       "fields": ["單位名稱", "買賣差額"],
       "data": [["外資及陸資", "--"], ["外資自營商", "-100,000,000"]]}))[0], -1.0)

# ── ⑥ _month_weekdays:只含平日、含當天、從 1 號起 ───────────────
d = datetime(2026, 7, 30, 16, 0, tzinfo=TW)   # 2026-07-30 是週四
wd = M._month_weekdays(d)
eq("⑥ 起於 1 號", wd[0], "20260701")
eq("⑥ 迄於當天", wd[-1], "20260730")
eq("⑥ 平日數(2026/07/01~30)", len(wd), 22)
eq("⑥ 不含週末", [x for x in wd if x in ("20260704", "20260705")], [])

# 1 號就是週末的月份:第一個平日要往後推
d2 = datetime(2026, 8, 3, 9, 0, tzinfo=TW)    # 2026-08-01 是週六
eq("⑥ 1號逢週末", M._month_weekdays(d2)[0], "20260803")

# 當月第 1 天跑 → 只有那天(或空,若逢週末)
eq("⑥ 1號當天(週三)", M._month_weekdays(datetime(2026, 7, 1, 9, tzinfo=TW)), ["20260701"])

# ── ⑦ 實證:risk_history 逐日加總「不可用」的理由(重複值) ────────
#    這是本功能改走官方月報的根本原因,寫成測試免得日後有人「優化」成本地加總。
snap = [("2026-07-09", -472.53), ("2026-07-10", -472.53), ("2026-07-13", -472.53)]
eq("⑦ 快照有連續重複值(不可加總)",
   len({v for _, v in snap}) == 1 and len(snap) == 3, True)

print()
if fails:
    print(f"❌ FI_MTD_TEST_FAIL: {fails}")
    sys.exit(1)
print("✅ FI_MTD_TEST_PASS")
