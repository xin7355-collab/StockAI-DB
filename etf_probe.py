"""
ETF 持股來源探針 ROUND 2 — 直攻 etfinfo.tw(Nuxt SSR)。
Round1 發現:TWSE封IP、FinMind無免費ETF持股、投信官網是JS殼;etfinfo /etf/{sym} 是含資料的 SSR HTML。
本輪:① 試 Nuxt _payload.json(最乾淨) ② 解析 /etf/{sym} HTML 找持股(__NUXT_DATA__ / 表格 / 代號權重)
③ 確認 FinMind TaiwanStockInfo 可批量取名稱。
"""
import os
import re
import requests

session = requests.Session()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
FM = (os.getenv("FINMIND_TOKENS") or os.getenv("FINMIND_TOKEN") or "").split(",")[0].strip()


def get(label, url, **kw):
    print(f"\n{'=' * 74}\n[{label}] GET {url}")
    try:
        r = session.get(url, headers={"User-Agent": UA}, timeout=20, **kw)
        print(f"  → status={r.status_code} ct={r.headers.get('content-type','')} len={len(r.text)}")
        return r
    except Exception as e:
        print(f"  ✗ ERR {type(e).__name__}: {e}")
        return None


def main():
    SYM = "00981A"

    # ① Nuxt 3 payload(各種可能路徑)
    for u in [
        f"https://www.etfinfo.tw/etf/{SYM}/_payload.json",
        f"https://www.etfinfo.tw/_payload.json?path=/etf/{SYM}",
        f"https://www.etfinfo.tw/etf/{SYM}.json",
        f"https://www.etfinfo.tw/api/etf/{SYM}",
    ]:
        r = get("nuxt-payload", u)
        if r is not None and r.status_code == 200:
            print(r.text[:2000])

    # ② /etf/{sym} HTML：定位持股資料所在
    r = get("etfinfo-html", f"https://www.etfinfo.tw/etf/{SYM}")
    if r is not None and r.status_code == 200:
        html = r.text
        # __NUXT_DATA__ (Nuxt3 SSR 扁平序列化)
        m = re.search(r'id="__NUXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
        if m:
            blob = m.group(1)
            print(f"\n-- __NUXT_DATA__ 長度 {len(blob)} --")
            # 找含台股代號的片段
            for code in ("2330", "2454", "2317"):
                i = blob.find(code)
                if i > 0:
                    print(f"  __NUXT_DATA__ 含 {code} @ {i}: ...{blob[max(0,i-120):i+200]}...")
                    break
            else:
                print("  __NUXT_DATA__ 前 1500:", blob[:1500])
        else:
            print("  (無 __NUXT_DATA__)")
        # 直接在整頁找持股關鍵字與代號上下文
        for kw in ("持股", "權重", "成分", "個股", "weight", "holdings"):
            i = html.find(kw)
            if i > 0:
                print(f"\n-- 頁面含「{kw}」@ {i}: ...{html[max(0,i-150):i+350]}...")
        i = html.find("2330")
        if i > 0:
            print(f"\n-- 頁面含 2330 @ {i}: ...{html[max(0,i-200):i+400]}...")

    # ③ FinMind TaiwanStockInfo:能否一次列出所有(批量取名稱)
    r = get("finmind-info-all", f"https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&token={FM}")
    if r is not None and r.status_code == 200:
        txt = r.text
        print("  len", len(txt), "| 含00981A:", "00981A" in txt, "| 前200:", txt[:200])

    print("\n✅ probe round2 done")


if __name__ == "__main__":
    main()
