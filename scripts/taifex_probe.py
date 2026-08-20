#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📐 台指期「順逆價差」探針 —— 為什麼一半的日子是空的?

使用者:「新增期貨,因為期貨比現股早開盤,我覺得可以用來比對」
→ 順逆價差(台指期近月 − 加權指數)正是「期現比對」的核心指標,
  但實測 `risk_history.json` 36 天裡**只有 18 天有值**。

🚨 已知症狀(2026-08-19 18:32 的 `macro_risk.json`):
     taifex_near        = 46033.0
     taifex_fut_date    = 2026-08-17   ← **落後 2 天**
     taifex_tx_now.date = null
     taifex_backwardation       = None
     taifex_backwardation_error = "期貨(2026-08-17)與現貨(2026-08-19)不同交易日,不計價差"
   → V71.4.9 的「兩條腿必須同一天」守門**判斷正確**(差一天的價差是假的),
     真正的問題是**期貨那條腿的日期為什麼落後**。
   ⚠️ V71.8.0 已經修過「OpenAPI 沒設日期」那條,程式**有**從回應抓日期
      → 所以 08-17 很可能是**官方 API 真的回這一天**,不是程式 bug。這支就是來確認的。

⛔ 這支只讀、不寫任何產物、不碰 gh-pages。沙箱連不到 TAIFEX → **必須在雲端後台跑**。

⭐⭐ 三個刻意的設計(⛔ 別拿掉):
  ① **對照組**:清單裡放兩個「本專案一直在用、已知會通」的端點。
     它們也失敗 = 這台機器被擋(IP/網路),⛔ 不是端點改名 —— 沒有對照組會往「再猜一次欄位名」走
     (V73.6.1 櫃買指數卡了五輪就是因為沒有對照組)。
  ② **HTTP 200 不等於成功**(陷阱 #23):TAIFEX 對不存在的路徑會回 200 + HTML。
     所以每一筆都印 content-type + 回應開頭,⛔ 不可只看 status code。
  ③ **把端點清單撈出來**:JSON parse 失敗時從 HTML regex 撈 `/v1/<Name>`,
     讓官方自己說有哪些端點,⛔ 不要一輪一輪猜名字。
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import requests

TW = timezone(timedelta(hours=8))
BASE = "https://openapi.taifex.com.tw/v1/"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "application/json"}
TIMEOUT = 20

# ⭐ 對照組:本專案正在用、已知會通的端點(它們也掛 = 這台機器被擋,不是端點問題)
CONTROLS = [
    ("DailyForeignExchangeRates", "對照組①(匯率,已知會通)"),
    ("MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsByDate", "對照組②(三大法人期貨,已知會通)"),
]

# 期貨每日行情:目前主線用的兩個名字 + 幾個合理候選
DAILY_FUT = [
    ("DailyMarketReportFut", "主線①(目前 macro_miner 第一順位)"),
    ("DailyMarketReportFutures", "主線②(目前 macro_miner 第二順位)"),
    ("DailyMarketReportFutAndOpt", "候選(期權合併)"),
    ("MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsByDate", "(同對照組②,順便看它的日期)"),
]

# 盤中/即時類候選 —— `taifex_tx_now` 拿得到價卻沒有日期,想知道有沒有帶日期的端點
INTRADAY = [
    ("DailyMarketReportFutOpt", "候選(期權每日)"),
    ("FutContractsDate", "候選(期貨契約日期)"),
    ("OptionsDailyMarketReport", "候選(選擇權每日)"),
]


def _get(path):
    """回 (ok, info) —— ⛔ 不可只看 status code(陷阱 #23:不存在的路徑回 200 + HTML)。"""
    url = BASE + path
    try:
        r = requests.get(url, headers=UA, timeout=TIMEOUT)
    except Exception as e:
        return False, {"err": f"連線失敗:{str(e)[:80]}"}
    ct = (r.headers.get("content-type") or "").split(";")[0]
    head = (r.text or "")[:120].replace("\n", " ").replace("\r", " ")
    info = {"status": r.status_code, "ct": ct, "bytes": len(r.content or b""), "head": head}
    if r.status_code != 200:
        return False, info
    try:
        data = r.json()
    except Exception as e:
        info["err"] = f"不是 JSON({str(e)[:50]})"
        return False, info
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
        info["err"] = f"不是非空 list({type(data).__name__})"
        return False, info
    info["rows"] = len(data)
    info["keys"] = list(data[0].keys())
    info["data"] = data
    return True, info


def _dates_in(data):
    """把這份資料裡出現的日期值收集起來(不管欄位叫什麼)。"""
    out = set()
    for row in data[:800]:
        if not isinstance(row, dict):
            continue
        for k, v in row.items():
            if not re.search(r"date|日期", str(k), re.I):
                continue
            s = str(v).strip().replace("/", "-")
            if len(s) == 8 and s.isdigit():
                s = f"{s[:4]}-{s[4:6]}-{s[6:]}"
            if re.match(r"^\d{4}-\d{2}-\d{2}", s):
                out.add(s[:10])
    return sorted(out)


def _tx_rows(data):
    """挑出臺股期貨(TX)非週契約的列。"""
    got = []
    for row in data:
        if not isinstance(row, dict):
            continue
        c = None
        for k, v in row.items():
            if re.search(r"contract|契約|商品|commodity", str(k), re.I):
                c = str(v).strip()
                break
        if c not in ("TX", "TXF", "臺股期貨"):
            continue
        exp = None
        for k, v in row.items():
            if re.search(r"contractmonth|到期|契約月|月份|delivery", str(k), re.I):
                exp = str(v)
                break
        if exp and ("週" in exp or "W" in exp.upper()):
            continue
        got.append(row)
    return got


def sec(t):
    print("\n" + "═" * 84)
    print(t)
    print("═" * 84)


def show(path, label, ok_, info):
    tag = "✅" if ok_ else "❌"
    print(f"{tag} {path}  ({label})")
    print(f"     HTTP {info.get('status')} ・ {info.get('ct')} ・ {info.get('bytes')} bytes"
          + (f" ・ {info['rows']} 列" if info.get("rows") else ""))
    if info.get("err"):
        print(f"     ⚠️ {info['err']}")
    if not ok_:
        print(f"     回應開頭:{info.get('head', '')[:110]}")
    return ok_


def main():
    now = datetime.now(TW)
    print("📐 台指期順逆價差探針")
    print(f"執行時間(台北):{now:%Y-%m-%d %H:%M:%S}(週{'一二三四五六日'[now.weekday()]})")
    print("⚠️ 台指期日盤 08:45~13:45、夜盤 15:00~次日 05:00;官方『每日行情』通常收盤後才更新")
    print("⛔ 這支只讀、不寫任何產物")

    # ── ① 對照組(先確認這台機器連得到 TAIFEX)──
    sec("【①】對照組 —— 已知會通的端點(⭐ 它們也失敗 = 這台機器被擋,不是端點改名)")
    ctrl_ok = 0
    for p, lab in CONTROLS:
        ok_, info = _get(p)
        if show(p, lab, ok_, info) and info.get("data"):
            ctrl_ok += 1
            ds = _dates_in(info["data"])
            print(f"     📅 這份資料裡的日期:{ds[-5:] if ds else '(沒有日期欄)'}")
    if ctrl_ok == 0:
        print("\n🚨 對照組全掛 → **這台機器連不到 TAIFEX**(IP/網路被擋)")
        print("   ⛔ 下面的失敗都不能解讀成「端點改名」。先解決連線再說。")

    # ── ② 期貨每日行情:到底回哪一天 ──
    sec("【②】期貨每日行情 —— 🚨 核心問題:它回的是哪一天?")
    best = None
    for p, lab in DAILY_FUT:
        ok_, info = _get(p)
        if not show(p, lab, ok_, info):
            continue
        data = info["data"]
        ds = _dates_in(data)
        print(f"     📅 日期值:{ds[-6:] if ds else '(⚠️ 這份資料沒有日期欄!)'}")
        print(f"     🔑 第一列欄位:{info['keys']}")
        tx = _tx_rows(data)
        print(f"     📊 臺股期貨(TX,排除週契約)共 {len(tx)} 列")
        if tx:
            print(f"     第一列:{json.dumps(tx[0], ensure_ascii=False)[:220]}")
        if ds and (best is None or ds[-1] > best[1]):
            best = (p, ds[-1])

    today = f"{now:%Y-%m-%d}"
    sec("【③】判定:期貨那條腿的日期,跟今天差幾天?")
    if best:
        p, d = best
        try:
            lag = (datetime.strptime(today, "%Y-%m-%d") - datetime.strptime(d, "%Y-%m-%d")).days
        except Exception:
            lag = None
        print(f"  最新的一份是 `{p}`,日期 = {d}(今天 {today},落後 {lag} 天)")
        if lag is not None and lag <= 0:
            print("  ✅ **沒有落後** → 那 `taifex_fut_date=08-17` 是當時那一輪的暫時現象(可能跑太早),")
            print("     修法是把採礦時間往後挪或加重試,⛔ 不必改端點。")
        elif lag == 1 and now.hour < 15:
            print("  ⚠️ 落後 1 天而且現在還沒到 15:00 → **正常**(官方每日行情要收盤後才出)。")
            print("     ⭐ 那守門就該拿『昨天的期貨 vs 昨天的現貨』比,⛔ 不是拿昨天期貨配今天現貨。")
        else:
            print(f"  🚨 落後 {lag} 天 → 這個端點**本來就不即時**,⛔ 不適合當『今天的價差』的來源。")
            print("     ⭐ 修法方向:改用即時報價那條腿(兩邊都用即時,同一時刻比才對),")
            print("        或把價差改標成『最後一個兩邊都有的交易日』而不是今天。")
    else:
        print("  ❌ 沒有任何一個端點給得出日期 → 見下面的端點清單,可能要換名字。")

    # ── ④ 即時/其他候選 ──
    sec("【④】其他候選端點(想找『有日期的即時價』)")
    for p, lab in INTRADAY:
        ok_, info = _get(p)
        if show(p, lab, ok_, info):
            print(f"     🔑 欄位:{info['keys']}")
            ds = _dates_in(info["data"])
            print(f"     📅 日期值:{ds[-4:] if ds else '(沒有日期欄)'}")

    # ── ⑤ 讓官方自己說有哪些端點(⛔ 不要一輪一輪猜) ──
    sec("【⑤】官方端點清單 —— ⛔ 別猜名字,讓它自己說")
    found = set()
    for u in (BASE, "https://openapi.taifex.com.tw/", "https://openapi.taifex.com.tw/swagger/v1/swagger.json"):
        try:
            r = requests.get(u, headers=UA, timeout=TIMEOUT)
            txt = r.text or ""
            print(f"  {u} → HTTP {r.status_code} ・ {(r.headers.get('content-type') or '').split(';')[0]} ・ {len(txt)} bytes")
            for m in re.finditer(r"/v1/([A-Za-z][A-Za-z0-9_]{3,60})", txt):
                found.add(m.group(1))
        except Exception as e:
            print(f"  {u} → 連線失敗:{str(e)[:70]}")
    if found:
        names = sorted(found)
        print(f"\n  📋 撈到 {len(names)} 個端點名稱:")
        for i in range(0, len(names), 3):
            print("     " + " ・ ".join(names[i:i + 3]))
        hit = [n for n in names if re.search(r"fut", n, re.I)]
        if hit:
            print(f"\n  ⭐ 其中含 'Fut' 的:{hit}")
    else:
        print("  ⚠️ 一個都沒撈到(可能是 JS 前端頁面)→ 只能沿用已知名字。")

    sec("⛔ 讀這份報告的規則")
    print("  ① 對照組全掛 → 是這台機器被擋,⛔ 不是端點改名(⛔ 別再去猜欄位名)。")
    print("  ② HTTP 200 不等於成功 —— 看 content-type;text/html = 那個路徑不存在(陷阱 #23)。")
    print("  ③ 若期貨每日行情本來就落後,⛔ 不要放寬『兩條腿同一天』守門 ——")
    print("     差一天的價差是假的(V71.4.9 記過:期貨 41,613 配現貨 40,039 算出 +1,574 點假正價差)。")
    print("     ⭐ 正解是改標成『最後一個兩邊都有的交易日』,或兩邊都改用即時價。")
    return 0


if __name__ == '__main__':
    sys.exit(main())
