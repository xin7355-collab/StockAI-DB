#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏛️ 董監事質押 / 內部人持股 採礦(B 案正式版)
資料源:TWSE OpenAPI t187ap11_L「上市公司董監事持股餘額明細」(全市場,每日,穩定 JSON)
  — 探針實測 GitHub Actions 可達(HTTP 200,不被 TWSE IP 擋),欄位含「目前持股/設質股數/設質比例」。
聚合每檔:董監事總持股、總設質股數 → 董監質押比 + 人數 → data/insider.json。
上櫃(tpex)董監資料源另計,先做上市;抓不到就整批保留舊檔(不覆寫)。

質押比 = 董監總設質股數 / 董監總持股 × 100%
  高質押 = 大股東拿股票去借錢,股價跌會被斷頭 → 風險訊號(配合股價位階看,非必然利空)。
"""
import json
import sys
import datetime

try:
    import requests
except Exception:
    print("❌ requests 未安裝")
    sys.exit(0)

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
TWSE_DIR = "https://openapi.twse.com.tw/v1/opendata/t187ap11_L"    # 上市董監持股明細
TPEX_DIR = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap11_O"  # 上櫃(嘗試,無則略)


def _to_int(s):
    try:
        return int(float(str(s).replace(",", "").replace("%", "").strip() or 0))
    except Exception:
        return 0


def fetch(url, desc):
    try:
        r = requests.get(url, timeout=60, headers=UA)
        if r.status_code == 200 and r.text.strip():
            j = r.json()
            if isinstance(j, list) and j:
                print(f"   ✅ {desc}: {len(j)} 筆")
                return j
        print(f"   ⚠️ {desc}: HTTP {r.status_code}, 無資料")
    except Exception as e:
        print(f"   ❌ {desc}: {e}")
    return []


print("🏛️ 採集董監事質押/持股(TWSE OpenAPI t187ap11_L)")
rows = fetch(TWSE_DIR, "上市董監持股明細")
try:
    rows_otc = fetch(TPEX_DIR, "上櫃董監持股明細")
    if rows_otc:
        rows = rows + rows_otc
except Exception:
    pass

if not rows:
    print("❌ 董監持股全無 → 保留舊檔不覆寫")
    sys.exit(0)

# 聚合每檔:董監總持股 / 總設質 / 人數
agg = {}
for r in rows:
    sym = str(r.get("公司代號") or r.get("SecuritiesCompanyCode") or "").strip()
    if not sym or not sym.isdigit():
        continue
    hold = _to_int(r.get("目前持股") or r.get("CurrentShareholding"))
    pledge = _to_int(r.get("設質股數") or r.get("NumberOfShares"))
    a = agg.setdefault(sym, {"hold": 0, "pledge": 0, "people": 0})
    a["hold"] += hold
    a["pledge"] += pledge
    a["people"] += 1

# 出表日期(民國 → 西元)
updated = ""
try:
    raw_d = str(rows[0].get("出表日期") or "").strip()
    if len(raw_d) == 7:  # 1150720
        updated = f"{int(raw_d[:3]) + 1911}-{raw_d[3:5]}-{raw_d[5:7]}"
except Exception:
    pass
if not updated:
    updated = datetime.date.today().isoformat()

out = {"updated": updated, "src": "twse_openapi_t187ap11", "data": {}}
hi = 0
for sym, a in agg.items():
    if a["hold"] <= 0:
        continue
    pct = round(a["pledge"] / a["hold"] * 100, 2)
    out["data"][sym] = {
        "pledge_pct": pct,               # 董監質押比%
        "dir_hold": a["hold"],           # 董監總持股(股)
        "dir_people": a["people"],       # 董監人數
    }
    if pct >= 30:
        hi += 1

print(f"   → 聚合 {len(out['data'])} 檔;質押比≥30% 有 {hi} 檔;資料日 {updated}")
with open("data/insider.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
print("💾 已寫 data/insider.json")
