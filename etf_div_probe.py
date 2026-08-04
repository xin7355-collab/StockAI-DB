#!/usr/bin/env python3
"""🔍 ETF 配息資料源探針 —— 「主動統一台股增長 季配、殖利率 3.77%」那張卡要的東西

使用者截圖(籌碼K線 00981A「除權息 → 股利政策」)有:
  平均股利(近十年) / 殖利率(近十年) / 最新殖利率 / 配息頻率(季配) / 每年配息明細

本專案目前**完全沒有 ETF 配息資料**(`fundamentals_cache` 的 yield_rate 是個股的,
ETF 那格是空的)。⛔ 照鐵則「沙箱連不到就不准憑猜加欄位」——
這支不是採礦機,是**去問官方到底有哪些端點**,把結果印出來給下一輪定名用
(同 `_taifex_list_endpoints()` / `fetch_business_signal` 的做法,陷阱 #23)。

⚠️ 沙箱連不到 TWSE/TPEX/MOPS,**必須丟到 GitHub Actions 手動跑**才有輸出。

跑法:python3 etf_div_probe.py
"""
import json
import re
import sys

try:
    import requests
except ImportError:
    print("❌ 缺 requests")
    sys.exit(0)

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}
TIMEOUT = 25

# 候選端點(都是猜的 —— 這正是要驗證的事)
CANDIDATES = [
    ("TWSE OpenAPI 端點總表", "https://openapi.twse.com.tw/v1/"),
    ("TWSE ETF 收益分配(猜1)", "https://openapi.twse.com.tw/v1/ETFReport/ETFDivEmg"),
    ("TWSE ETF 定期定額/基本資料(猜2)", "https://openapi.twse.com.tw/v1/ETFReport/ETFRank"),
    ("TWSE 除權除息計算結果表", "https://openapi.twse.com.tw/v1/exchangeReport/TWT49U"),
    ("TPEx OpenAPI 端點總表", "https://www.tpex.org.tw/openapi/v1/"),
    ("FinMind 資料集清單", "https://api.finmindtrade.com/api/v4/datalist?dataset=TaiwanStockDividend"),
]


def probe(name, url):
    print(f"\n── {name}\n   {url}")
    try:
        r = requests.get(url, headers=UA, timeout=TIMEOUT)
    except Exception as e:
        print(f"   ❌ 連不到:{type(e).__name__}: {str(e)[:120]}")
        return None
    ct = (r.headers.get("Content-Type") or "?")[:60]
    print(f"   HTTP {r.status_code} ・ content-type={ct} ・ {len(r.content):,} bytes")
    if r.status_code != 200:
        print(f"   開頭:{r.text[:160]!r}")
        return None
    try:
        j = r.json()
    except Exception as e:
        # ⚠️ 陷阱 #23:站方對不存在的路徑回 200 + HTML → 這裡不是「失敗」,是「名字猜錯」
        print(f"   ⚠️ 不是 JSON({str(e)[:60]})→ 多半是路徑不存在但回了網頁(陷阱 #23)")
        paths = sorted(set(re.findall(r'["\'](/v1/[\w/\-.]+)["\']', r.text)))[:40]
        if paths:
            print(f"   ⭐ 從 HTML 撈到的候選端點({len(paths)} 個):")
            for p in paths:
                print(f"      {p}")
        else:
            print(f"   開頭:{r.text[:200]!r}")
        return None
    # 是 JSON → 印結構
    if isinstance(j, list):
        print(f"   ✅ JSON list,{len(j)} 筆")
        if j:
            print(f"   首筆 keys:{list(j[0].keys()) if isinstance(j[0], dict) else type(j[0]).__name__}")
            print(f"   首筆:{json.dumps(j[0], ensure_ascii=False)[:300]}")
    elif isinstance(j, dict):
        ks = list(j.keys())
        print(f"   ✅ JSON dict,keys={ks[:20]}")
        # 端點總表:把含 etf / div(配息)的路徑挑出來
        hits = [k for k in ks if re.search(r'etf|div|dividend|收益|分配', str(k), re.I)]
        if hits:
            print(f"   ⭐ 疑似 ETF/配息相關的 key:{hits[:20]}")
        paths = j.get("paths")
        if isinstance(paths, dict):
            ph = [p for p in paths if re.search(r'etf|div|dividend', p, re.I)]
            print(f"   ⭐ paths 裡含 etf/div 的({len(ph)} 個):")
            for p in ph[:30]:
                print(f"      {p}")
    return j


print("=" * 68)
print("🔍 ETF 配息資料源探針(⚠️ 沙箱連不到官方站,要丟 Actions 跑)")
print("=" * 68)
for name, url in CANDIDATES:
    probe(name, url)

print("\n" + "=" * 68)
print("📋 下一步怎麼判讀:")
print("  ・任何一條印出「✅ JSON list」且首筆 keys 含 代號/發放日/配息金額 → 就是它,可以接")
print("  ・全部都是「不是 JSON」→ 看上面撈到的候選端點清單,挑名字像的下一輪再試")
print("  ・⛔ 在確定端點之前,**不准在 etf_miner.py 加配息欄位**(憑猜的欄位會永遠是 null,")
print("     而且會躲過資料體檢 —— 那正是 business_signal 踩過的坑)")
print("=" * 68)
