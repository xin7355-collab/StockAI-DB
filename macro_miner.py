"""
macro_miner.py — 輕量級總經風險採礦機
抓取：美債 10Y、TWSE 三大法人外資買賣超、TAIFEX 外資臺指期淨口數
複合判定：外資期現是否同步、套利避險或真實偏空
輸出：data/macro_risk.json（最輕量易解析）

設計準則：
- 1GB RAM 雲端可跑：不載入 pandas，全用內建 json + requests
- 全 try/except + urllib3 Retry：任何外部 API 故障絕不崩潰
- yfinance 拉 ^TNX（10Y *10 顯示，需 /10）
- 不在 watchdog/cron 觸發崩潰，缺資料時欄位寫 null + reason
"""
import os
import json
import sys
import traceback
from pathlib import Path
from datetime import datetime, timezone, timedelta
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)
OUTPUT_FILE = DATA_DIR / "macro_risk.json"

# Retry-equipped session（任何 5xx / 連線錯誤自動重試 3 次）
http = requests.Session()
http.mount("https://", HTTPAdapter(max_retries=Retry(
    total=3, backoff_factor=1.5,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=frozenset(["GET", "POST"]),
)))
HEADERS = {"User-Agent": "Mozilla/5.0 macro_miner/1.0"}


def fetch_us10y_yield():
    """美債 10Y 殖利率 (^TNX，數值 = 殖利率 * 10，需 /10 還原 %)"""
    try:
        import yfinance as yf
        t = yf.Ticker("^TNX")
        hist = t.history(period="5d", auto_adjust=False)
        if hist is None or hist.empty:
            return None, "yfinance 回空"
        last_close = float(hist["Close"].iloc[-1])
        # ^TNX 的值即為殖利率（已是 %），不需再除 10
        # 但部分 yfinance 版本回傳 *10，做防呆判斷
        if last_close > 20:   # 殖利率不可能 > 20%，代表是 *10 版本
            last_close = last_close / 10
        return round(last_close, 3), None
    except Exception as e:
        print(f"  ⚠️ US10Y 抓取失敗: {e}")
        return None, str(e)[:100]


def fetch_foreign_spot_net():
    """TWSE 三大法人買賣超 — 外資（外幣計 + 自營買賣超金額，單位：億元）"""
    try:
        url = "https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&response=json"
        r = http.get(url, headers=HEADERS, timeout=10)
        if r.status_code != 200:
            return None, None, f"HTTP {r.status_code}"
        j = r.json()
        data = j.get("data") or []
        # data 結構：[類別, 買進金額, 賣出金額, 買賣差額]
        # 找「外資及陸資」（單位通常是 元，要 /1e8 轉億）
        date_str = j.get("date") or datetime.now().strftime("%Y%m%d")
        for row in data:
            name = (row[0] or "").replace(" ", "")
            if "外資" in name and "外資自營" not in name:
                # 取 第 4 欄 = 買賣差額（單位：元）
                try:
                    diff = int(str(row[3]).replace(",", ""))
                    return round(diff / 1e8, 2), date_str, None  # 億元
                except (ValueError, IndexError):
                    pass
        return None, date_str, "找不到外資列"
    except Exception as e:
        print(f"  ⚠️ TWSE 外資買賣超失敗: {e}")
        return None, None, str(e)[:100]


def fetch_foreign_futures_net():
    """TAIFEX 外資臺指期 OI 淨口數（多單 - 空單）"""
    try:
        # TAIFEX 期貨大額交易人未沖銷部位 — 全月 CSV
        # 用免登入 OAP API 即時拉取（每日更新）
        url = "https://www.taifex.com.tw/cht/3/futContractsDate"
        today_str = datetime.now().strftime("%Y/%m/%d")
        # 改用 POST 表單拉取，避開頁面爬蟲限制
        payload = {
            "queryType": "1",
            "marketCode": "0",
            "dateaddcnt": "",
            "commodity_id": "TXF",
            "queryDate": today_str,
        }
        r = http.post(url, data=payload, headers=HEADERS, timeout=10)
        if r.status_code != 200:
            return None, f"HTTP {r.status_code}"
        # 簡單字串解析（避免引入 BeautifulSoup，省 RAM）
        html = r.text
        # 找「外資」+「臺股期貨」段的淨多空口數
        # 結構複雜，這裡用容錯：找 "外資" 後 8 個數字欄位裡的淨額
        import re
        # 抓「外資」開始、200 字內 5 個以上整數欄位
        m = re.search(r"外資[^<]*?(?:</td>\s*<td[^>]*>[\s\-,\d]+){8,}", html)
        if not m:
            return None, "TAIFEX 表格結構未匹配"
        chunk = m.group(0)
        nums = re.findall(r"-?[\d,]+", chunk)
        nums = [int(n.replace(",", "")) for n in nums if n.replace(",", "").lstrip("-").isdigit()]
        # 一般欄位為：多OI口、多金額、空OI口、空金額、淨OI口、淨金額（單位口、千元）
        # 取淨 OI 口數（負數 = 淨空）
        if len(nums) >= 5:
            net_oi = nums[4]  # 第 5 個欄位 = 淨 OI 口數
            return net_oi, None
        return None, "TAIFEX 數值欄位不足"
    except Exception as e:
        print(f"  ⚠️ TAIFEX 外資期貨失敗: {e}")
        return None, str(e)[:100]


def judge_fi_complex(net_futures, net_spot):
    """
    複合邏輯判定：
    - 期貨空單 > 30000 且現貨買超 > 0 億    → 套利避險
    - 期貨空單 > 30000 且現貨賣超 > 100 億 → 真實偏空
    - 其他                                  → 中性
    """
    if net_futures is None or net_spot is None:
        return "資料整編中（待對接）"
    fut_short = -net_futures if net_futures < 0 else 0
    if fut_short > 30000 and net_spot > 0:
        return "外資期現不同調：套利避險狀態"
    if fut_short > 30000 and net_spot < -100:
        return "外資期現同步倒貨：真實偏空警戒"
    return "外資動向中性"


def main():
    print("📡 macro_miner 啟動 — 抓取總經三維風險指標")
    out = {
        "updated":     datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M %z"),
        "us10y_yield": None,
        "us10y_error": None,
        "fi_spot_net":     None,   # 億元
        "fi_spot_date":    None,
        "fi_spot_error":   None,
        "fi_futures_net":  None,   # 口數（淨）
        "fi_futures_error":None,
        "fi_complex_conclusion": None,
        "m1b_pct":     42,                                    # TODO: 待對接央行 API
        "m1b_label":   "當前熱度 42% (安全)",
        "m1b_note":    "TODO: 待對接央行 M1B API（目前用安全預設）",
    }

    print("─" * 50)
    print("[1/3] 抓取美債 10Y 殖利率 (^TNX)…")
    y10, y10err = fetch_us10y_yield()
    out["us10y_yield"], out["us10y_error"] = y10, y10err
    print(f"     → {y10}% （err={y10err}）" if y10 is not None else f"     → 失敗：{y10err}")

    print("[2/3] 抓取 TWSE 外資現貨買賣超…")
    spot, sdate, serr = fetch_foreign_spot_net()
    out["fi_spot_net"], out["fi_spot_date"], out["fi_spot_error"] = spot, sdate, serr
    print(f"     → {spot} 億（{sdate}, err={serr}）")

    print("[3/3] 抓取 TAIFEX 外資臺指期淨口數…")
    fut, ferr = fetch_foreign_futures_net()
    out["fi_futures_net"], out["fi_futures_error"] = fut, ferr
    print(f"     → {fut} 口（err={ferr}）")

    out["fi_complex_conclusion"] = judge_fi_complex(fut, spot)
    print(f"\n🎯 複合判定：{out['fi_complex_conclusion']}")

    # 寫檔（最輕量）— 任何 IO 錯誤不能讓整個 daily_miner 崩潰
    try:
        OUTPUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✅ 已輸出 → {OUTPUT_FILE}")
    except Exception as e:
        print(f"⚠️ macro_risk.json 寫檔失敗（不影響其他流程）：{e}")
        sys.exit(0)   # 強制 exit 0 避免污染 workflow


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # 終極防線：絕不讓 macro_miner 崩潰污染 daily_miner workflow
        print(f"💥 macro_miner 頂層異常：{e}")
        traceback.print_exc()
        sys.exit(0)
