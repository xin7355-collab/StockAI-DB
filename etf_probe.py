"""
ETF 持股來源探針 — 在 GitHub Actions(有外網)跑，dump 各候選端點的真實回應，
供開發者寫對解析器。純診斷：不部署、不寫檔、不碰 gh-pages/data。
本機開發沙箱無外網 → 必須靠這支在雲端看真實 HTTP 回應(狀態/content-type/前段內容)。
"""
import os
import requests

session = requests.Session()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
FM = (os.getenv("FINMIND_TOKENS") or os.getenv("FINMIND_TOKEN") or "").split(",")[0].strip()

SAMPLES = ["00981A", "00982A", "00988A", "00992A", "0050"]


def dump(label, url, method="GET", limit=1500, **kw):
    print(f"\n{'=' * 74}\n[{label}] {method} {url}")
    try:
        r = session.request(method, url, headers={"User-Agent": UA}, timeout=20, **kw)
        ct = r.headers.get("content-type", "")
        print(f"  → status={r.status_code}  content-type={ct}  len={len(r.text)}")
        print((r.text or "").strip()[:limit])
    except Exception as e:
        print(f"  ✗ ERR {type(e).__name__}: {e}")


def main():
    print(f"FinMind token present: {bool(FM)}")

    # ── ① 探索:列出可用的 dataset / endpoint(最高資訊量) ──
    dump("TWSE-OpenAPI-index", "https://openapi.twse.com.tw/v1/", limit=2500)
    dump("FinMind-datalist", f"https://api.finmindtrade.com/api/v4/datalist?token={FM}", limit=2500)

    # ── ② TWSE OpenAPI 候選 ETF/持股端點(依命名猜測,看哪個回 200+JSON) ──
    for ep in [
        "exchangeReport/TWT44U",   # 投信買賣超彙總?
        "exchangeReport/TWT54U",
        "fund/T86",
        "ETFReport/ETFRank",
    ]:
        dump(f"TWSE-OpenAPI-{ep}", f"https://openapi.twse.com.tw/v1/{ep}", limit=600)

    # ── ③ FinMind:該檔 ETF 基本資訊 + 嘗試持股類 dataset ──
    dump("FinMind-TaiwanStockInfo-00981A",
         f"https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&data_id=00981A&token={FM}",
         limit=800)
    for ds in ["TaiwanStockHoldingSharesPer", "TaiwanStockMarketValue", "ETFHolding", "TaiwanETFHolding"]:
        dump(f"FinMind-{ds}-00981A",
             f"https://api.finmindtrade.com/api/v4/data?dataset={ds}&data_id=00981A"
             f"&start_date=2026-05-01&token={FM}", limit=500)

    # ── ④ 投信官網 PCF(從 web search 取得的真實頁面,看是 HTML 還是有 XHR/JSON) ──
    dump("capital-00992A-portfolio", "https://www.capitalfund.com.tw/etf/product/detail/500/portfolio")
    dump("fubon-pcf", "https://websys.fsit.com.tw/FubonETF/Trade/Pcf.aspx")
    dump("ftft-pcf", "https://www.ftft.com.tw/etf/Transaction/PCF")
    dump("megafunds-pcf", "https://www.megafunds.com.tw/MEGA/etf/trade_pcf.aspx")

    # ── ⑤ TPEX 主動式 ETF 清單頁 ──
    dump("tpex-active-etf", "https://www.tpex.org.tw/web/etf/serial_active_etf.php?l=zh-tw", limit=800)

    print("\n✅ probe done")


if __name__ == "__main__":
    main()
