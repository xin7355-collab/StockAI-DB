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
    """TWSE 三大法人買賣超 — 外資（買賣差額，單位：億元）

    BFI82U schema 過去曾把外資拆成「外資及陸資（不含外資自營商）」+「外資自營商」兩列；
    某些日期合併、某些拆開。改成 regex 寬鬆比對「外資」字頭、累加所有外資相關列，
    並印 raw response 供 log 直接看欄位。
    """
    try:
        url = "https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&response=json"
        r = http.get(url, headers=HEADERS, timeout=10)
        if r.status_code != 200:
            return None, None, f"HTTP {r.status_code}"
        j = r.json()
        data = j.get("data") or []
        date_str = j.get("date") or datetime.now().strftime("%Y%m%d")
        print(f"  [BFI82U] stat={j.get('stat')} rows={len(data)} fields={j.get('fields', [])[:6]}")
        if not data:
            return None, date_str, "BFI82U 回 0 列"
        import re
        matched_rows = []
        diff_idx = None
        # diff 欄位：找「買賣差額」「買賣超」其中一個（schema 變化）
        fields = j.get("fields") or []
        for i, f in enumerate(fields):
            f = (f or "").replace(" ", "")
            if "差額" in f or "買賣超" in f:
                diff_idx = i
                break
        if diff_idx is None:
            # 退一步：固定取最後一個數值欄（通常就是差額）
            diff_idx = len(data[0]) - 1 if data and len(data[0]) > 1 else None
        total_net_yuan = 0
        for row in data:
            name = (row[0] or "").replace(" ", "")
            # 寬鬆比對：任何外資相關列都納入（包含「外資及陸資」「外資自營商」等）
            if re.search(r"外資", name):
                try:
                    val = int(str(row[diff_idx]).replace(",", ""))
                    total_net_yuan += val
                    matched_rows.append((name, val))
                except (ValueError, IndexError, TypeError):
                    pass
        if not matched_rows:
            print(f"  [BFI82U] 找不到外資列，全部 names={[(row[0] or '').replace(' ', '') for row in data]}")
            return None, date_str, "找不到外資列"
        print(f"  [BFI82U] 命中：{matched_rows}（合計 {total_net_yuan / 1e8:.2f} 億）")
        return round(total_net_yuan / 1e8, 2), date_str, None  # 億元
    except Exception as e:
        print(f"  ⚠️ TWSE 外資買賣超失敗: {e}")
        return None, None, str(e)[:100]


def fetch_foreign_futures_net():
    """TAIFEX 外資臺指期 OI 淨口數（多單 - 空單）

    改用 CSV 端點（/cht/3/futContractsDateDown），徹底繞開 HTML 表格結構變動。
    CSV 欄位：日期/契約/身份別/多OI口/多OI金額/空OI口/空OI金額/淨OI口/淨OI金額…
    """
    try:
        import csv
        import io
        import re
        url = "https://www.taifex.com.tw/cht/3/futContractsDateDown"
        today_str = datetime.now().strftime("%Y/%m/%d")
        payload = {
            "queryType": "1",
            "marketCode": "0",
            "dateaddcnt": "",
            "commodity_id": "TXF",
            "queryDate": today_str,
        }
        r = http.post(url, data=payload, headers=HEADERS, timeout=10)
        if r.status_code != 200:
            return None, f"CSV HTTP {r.status_code}"
        text = r.text
        # CSV 可能是 BIG5；嘗試 BIG5 / UTF-8 兩個編碼
        try:
            r.encoding = "big5"
            text = r.text
        except Exception:
            pass
        if "外資" not in text and "Foreign" not in text:
            # fallback：原 HTML parser，保留向下相容
            print(f"  [TAIFEX] CSV 無外資資料，前 200 字：{text[:200]}")
            return _fetch_taifex_html_fallback()
        rows = list(csv.reader(io.StringIO(text)))
        if not rows:
            return None, "CSV 空白"
        print(f"  [TAIFEX] CSV header={rows[0][:6]} rows={len(rows)}")
        # 找「外資」+「臺股期貨/TX」交集列
        for row in rows[1:]:
            if len(row) < 8:
                continue
            joined = "".join(row[:4])
            if "外資" in joined and ("臺股期貨" in joined or "TX" in joined.upper()):
                # 淨 OI 口數通常在第 8 欄附近（不同版本欄位有偏移），用 regex 找第 5 個數字
                nums = []
                for c in row:
                    s = str(c).replace(",", "").strip()
                    if re.fullmatch(r"-?\d+", s):
                        nums.append(int(s))
                if len(nums) >= 5:
                    # 慣例：[多OI口, 多金額, 空OI口, 空金額, 淨OI口, 淨金額]
                    # 取最後一個合理區間內的淨值 — 第 5 個整數通常就是淨 OI 口數
                    net_oi = nums[4]
                    print(f"  [TAIFEX] 命中外資臺指期，淨OI={net_oi} 口")
                    return net_oi, None
        return None, "CSV 找不到外資+TXF 列"
    except Exception as e:
        print(f"  ⚠️ TAIFEX 外資期貨失敗: {e}")
        return None, str(e)[:100]


def _fetch_taifex_html_fallback():
    """舊版 HTML parser fallback（CSV 失敗時用），保留原本 regex 邏輯"""
    try:
        import re
        url = "https://www.taifex.com.tw/cht/3/futContractsDate"
        today_str = datetime.now().strftime("%Y/%m/%d")
        payload = {
            "queryType": "1",
            "marketCode": "0",
            "dateaddcnt": "",
            "commodity_id": "TXF",
            "queryDate": today_str,
        }
        r = http.post(url, data=payload, headers=HEADERS, timeout=10)
        if r.status_code != 200:
            return None, f"HTML fallback HTTP {r.status_code}"
        html = r.text
        m = re.search(r"外資[^<]*?(?:</td>\s*<td[^>]*>[\s\-,\d]+){8,}", html)
        if not m:
            return None, "TAIFEX 表格結構未匹配"
        chunk = m.group(0)
        nums = re.findall(r"-?[\d,]+", chunk)
        nums = [int(n.replace(",", "")) for n in nums if n.replace(",", "").lstrip("-").isdigit()]
        if len(nums) >= 5:
            return nums[4], None
        return None, "HTML fallback 數值欄位不足"
    except Exception as e:
        return None, str(e)[:100]


def fetch_us2y_yield():
    """美債 2Y — FRED DGS2 CSV；HTTPS 偶爾逾時，3 次 exponential backoff + 鏡像 endpoint 重試"""
    import csv as _csv
    import io as _io
    import time as _t
    urls = [
        "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2",
        "https://fred.stlouisfed.org/data/DGS2.csv",  # 鏡像 endpoint（fallback）
    ]
    ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "text/csv,text/plain,*/*"}
    last_err = "FRED DGS2 全失敗"
    for attempt in range(3):
        for url in urls:
            try:
                r = http.get(url, headers=ua, timeout=20)  # 從 10s 拉到 20s
                if r.status_code != 200:
                    last_err = f"HTTP {r.status_code} @ {url[:60]}"
                    continue
                rows = list(_csv.reader(_io.StringIO(r.text)))
                for row in reversed(rows[1:]):
                    if len(row) >= 2 and row[1] not in (".", "", None):
                        try:
                            return round(float(row[1]), 3), None
                        except ValueError:
                            continue
                last_err = "FRED DGS2 無有效值"
            except Exception as e:
                last_err = str(e)[:100]
        if attempt < 2:
            _t.sleep(2 ** attempt)  # 1s → 2s 之間 backoff
    print(f"  ⚠️ US2Y 三次嘗試皆失敗: {last_err}")
    return None, last_err


def fetch_usdtwd():
    """新台幣匯率 USD/TWD — yfinance TWD=X"""
    try:
        import yfinance as yf
        hist = yf.Ticker("TWD=X").history(period="5d", auto_adjust=False)
        if hist is None or hist.empty:
            return None, "yfinance 回空"
        return round(float(hist["Close"].iloc[-1]), 3), None
    except Exception as e:
        print(f"  ⚠️ USD/TWD 抓取失敗: {e}")
        return None, str(e)[:100]


def fetch_fear_greed():
    """CNN 恐懼與貪婪指數（0-100，需瀏覽器 UA 否則 418）"""
    try:
        url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
        ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
              "Accept": "application/json"}
        r = http.get(url, headers=ua, timeout=10)
        if r.status_code != 200:
            return None, None, f"HTTP {r.status_code}"
        fg = (r.json() or {}).get("fear_and_greed") or {}
        score = fg.get("score")
        rating = fg.get("rating")
        if score is None:
            return None, None, "回應無 score"
        label_map = {"extreme fear": "極度恐懼", "fear": "恐懼", "neutral": "中性",
                     "greed": "貪婪", "extreme greed": "極度貪婪"}
        label = label_map.get((rating or "").lower(), rating or "")
        return round(float(score), 1), label, None
    except Exception as e:
        print(f"  ⚠️ 恐懼貪婪指數抓取失敗: {e}")
        return None, None, str(e)[:100]


def _taifex_oi_rows(commodity_id: str):
    """共用：抓 TAIFEX 三大法人某商品的未平倉 CSV（沿用 fetch_foreign_futures_net 的端點/編碼防呆）"""
    import csv
    import io
    url = "https://www.taifex.com.tw/cht/3/futContractsDateDown"
    payload = {"queryType": "1", "marketCode": "0", "dateaddcnt": "",
               "commodity_id": commodity_id,
               "queryDate": datetime.now().strftime("%Y/%m/%d")}
    r = http.post(url, data=payload, headers=HEADERS, timeout=10)
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}"
    try:
        r.encoding = "big5"
        text = r.text
    except Exception:
        text = r.text
    rows = list(csv.reader(io.StringIO(text)))
    return (rows or None), (None if rows else "CSV 空白")


def fetch_retail_long_short():
    """散戶多空比 — 用小型臺指期(MTX) 三大法人淨未平倉推算
    散戶多空比 ≈ -(三大法人 MTX 淨未平倉口數) / 全市場 MTX 未平倉量 ×100%（負值＝散戶偏多）

    TODO(下輪): TAIFEX「小型臺指期」CSV 欄位 2026/02 後變動，目前匹配規則失效回 null。
    需重新爬 TAIFEX OptionsAndFutureDailyMarketReport API 取代 historical CSV。
    """
    try:
        import re
        rows, err = _taifex_oi_rows("MTX")
        if not rows:
            return None, f"MTX OI 取得失敗：{err}"
        inst_net = 0
        total_oi = 0
        matched = 0
        # 診斷用：收集所有不重複的「商品名稱」欄，幫助找出真實 commodity 字串
        product_names = set()
        for row in rows[1:]:
            if len(row) < 8:
                continue
            joined = "".join(row[:4])
            # 收集所有非空商品名（前 4 欄拼起來）方便比對
            if joined.strip():
                product_names.add(joined[:30])
            if "小型臺指" not in joined and "MTX" not in joined.upper():
                continue
            ints = []
            for c in row:
                s = str(c).replace(",", "").strip()
                if re.fullmatch(r"-?\d+", s):
                    ints.append(int(s))
            if len(ints) < 6:
                continue
            # 慣例尾端欄：… 多方未平倉口, 多方未平倉額, 空方未平倉口, 空方未平倉額, 淨額未平倉口, 淨額未平倉額
            net_oi = ints[-2]
            long_oi = ints[-6]
            short_oi = ints[-4]
            inst_net += net_oi
            total_oi = max(total_oi, long_oi + short_oi)  # 任一法人 long+short 近似全市場上限，取最大較穩
            matched += 1
        if matched == 0 or total_oi <= 0:
            # 印出實際 TAIFEX CSV 看到的商品名稱，方便下次 grep 出真實字串
            print(f"  [散戶多空比] 全部不重複商品名（前 30 個）: {sorted(product_names)[:30]}")
            return None, "MTX 三大法人列未匹配或總 OI 為 0"
        # 全市場 MTX 未平倉量：三大法人 long 合計 + 散戶；此處用三大法人 long+short 總和近似分母
        retail_pct = round(-(inst_net) / total_oi * 100, 1)
        print(f"  [散戶多空比] inst_net={inst_net} 近似總OI={total_oi} → {retail_pct}%")
        return retail_pct, None
    except Exception as e:
        print(f"  ⚠️ 散戶多空比推算失敗: {e}")
        return None, str(e)[:100]


def fetch_taifex_backwardation():
    """台指逆價差 = 臺股期貨(TX)近月收盤 − 加權指數(^TWII)現貨收盤（負值＝逆價差）

    ① 優先用 yfinance ^TXF=F（穩定）；失敗才退到 TAIFEX HTML regex（脆弱）

    TODO(下輪): yfinance ^TXF=F 2026 起無回應 + TAIFEX HTML regex 失效，需改抓官方
    DailyMarketReport CSV（與 retail_long_short 同源），下輪一起修。
    """
    try:
        import re
        # 1) ^TWII 現貨收盤
        spot = None
        try:
            import yfinance as yf
            hist = yf.Ticker("^TWII").history(period="5d", auto_adjust=False)
            if hist is not None and not hist.empty:
                spot = float(hist["Close"].iloc[-1])
        except Exception as e:
            return None, f"^TWII 取得失敗：{str(e)[:60]}"
        if spot is None:
            return None, "^TWII 無現貨收盤"
        # 2) 期貨收盤：先試 yfinance（^TXF=F），失敗才走 TAIFEX HTML
        fut_close = None
        try:
            import yfinance as yf
            fut_hist = yf.Ticker("^TXF=F").history(period="5d", auto_adjust=False)
            if fut_hist is not None and not fut_hist.empty:
                fut_close = float(fut_hist["Close"].iloc[-1])
                print(f"  [台指逆價差] yfinance ^TXF=F 期貨收盤 = {fut_close}")
        except Exception as e:
            print(f"  [台指逆價差] yfinance 期貨失敗，退到 TAIFEX HTML：{str(e)[:60]}")
        if fut_close is None:
            url = "https://www.taifex.com.tw/cht/3/futDailyMarketReport"
            payload = {"queryType": "2", "marketCode": "0", "commodity_id": "TX",
                       "queryDate": datetime.now().strftime("%Y/%m/%d"), "MarketCode": "0",
                       "commodity_idt": "TX"}
            r = http.post(url, data=payload, headers=HEADERS, timeout=10)
            if r.status_code != 200:
                return None, f"TAIFEX HTTP {r.status_code}"
            html = r.text
            m = re.search(r"TX[^0-9]{0,40}?([1-2]\d{4})", html)
            if not m:
                return None, "TX 近月收盤未匹配（yfinance + TAIFEX 雙失敗）"
            fut_close = float(m.group(1))
        back = round(fut_close - spot, 0)
        print(f"  [台指逆價差] 期貨{fut_close} − 現貨{spot:.0f} = {back:+.0f} 點")
        return back, None
    except Exception as e:
        print(f"  ⚠️ 台指逆價差抓取失敗: {e}")
        return None, str(e)[:100]


def judge_fi_complex(net_futures, net_spot):
    """
    複合邏輯判定（補完死區後）：
    - 期貨空單 > 30000 且現貨買超 > 0 億          → 套利避險
    - 期貨空單 > 30000 且現貨賣超 > 100 億        → 真實偏空警戒
    - 期貨空單 > 30000 且現貨 -100~0 億（接近持平）→ 暗流湧動，持續觀察
    - 其他                                         → 中性
    """
    if net_futures is None or net_spot is None:
        return "資料整編中（待對接）"
    fut_short = -net_futures if net_futures < 0 else 0
    if fut_short > 30000 and net_spot > 0:
        return "外資期現不同調：套利避險狀態"
    if fut_short > 30000 and net_spot < -100:
        return "外資期現同步倒貨：真實偏空警戒"
    if fut_short > 30000 and -100 <= net_spot <= 0:
        return "外資期貨大量布空、現貨持平：暗流湧動觀察"
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
        # ── 頂部戰略指揮部新增六大宏觀指標 ──
        "us2y_yield":   None,
        "us2y_error":   None,
        "usdtwd":       None,
        "usdtwd_error": None,
        "fear_greed":       None,
        "fear_greed_label": None,
        "fear_greed_error": None,
        "retail_ls_pct":   None,   # 散戶多空比 %（負值＝散戶偏多）
        "retail_ls_error": None,
        "taifex_backwardation":       None,   # 台指逆價差（點，負值＝逆價差）
        "taifex_backwardation_error": None,
        "m1b_pct":     42,                                    # TODO: 待對接央行 API
        "m1b_label":   "當前熱度 42% (安全)",
        "m1b_note":    "TODO: 待對接央行 M1B API（目前用安全預設）",
    }

    print("─" * 50)
    print("[1/8] 抓取美債 10Y 殖利率 (^TNX)…")
    y10, y10err = fetch_us10y_yield()
    out["us10y_yield"], out["us10y_error"] = y10, y10err
    print(f"     → {y10}% （err={y10err}）" if y10 is not None else f"     → 失敗：{y10err}")

    print("[2/8] 抓取美債 2Y 殖利率 (FRED DGS2)…")
    y2, y2err = fetch_us2y_yield()
    out["us2y_yield"], out["us2y_error"] = y2, y2err
    print(f"     → {y2}% （err={y2err}）")

    print("[3/8] 抓取 TWSE 外資現貨買賣超…")
    spot, sdate, serr = fetch_foreign_spot_net()
    out["fi_spot_net"], out["fi_spot_date"], out["fi_spot_error"] = spot, sdate, serr
    print(f"     → {spot} 億（{sdate}, err={serr}）")

    print("[4/8] 抓取 TAIFEX 外資臺指期淨口數…")
    fut, ferr = fetch_foreign_futures_net()
    out["fi_futures_net"], out["fi_futures_error"] = fut, ferr
    print(f"     → {fut} 口（err={ferr}）")

    print("[5/8] 抓取新台幣匯率 (USD/TWD)…")
    twd, twderr = fetch_usdtwd()
    out["usdtwd"], out["usdtwd_error"] = twd, twderr
    print(f"     → {twd}（err={twderr}）")

    print("[6/8] 抓取 CNN 恐懼與貪婪指數…")
    fg, fglabel, fgerr = fetch_fear_greed()
    out["fear_greed"], out["fear_greed_label"], out["fear_greed_error"] = fg, fglabel, fgerr
    print(f"     → {fg}（{fglabel}, err={fgerr}）")

    print("[7/8] 推算散戶多空比 (TAIFEX 小型臺指期)…")
    rls, rlserr = fetch_retail_long_short()
    out["retail_ls_pct"], out["retail_ls_error"] = rls, rlserr
    print(f"     → {rls}%（err={rlserr}）")

    print("[8/8] 抓取台指逆價差 (TX − ^TWII)…")
    back, backerr = fetch_taifex_backwardation()
    out["taifex_backwardation"], out["taifex_backwardation_error"] = back, backerr
    print(f"     → {back} 點（err={backerr}）")

    out["fi_complex_conclusion"] = judge_fi_complex(fut, spot)
    print(f"\n🎯 複合判定：{out['fi_complex_conclusion']}")

    # 🛡️ 斷崖防護：對每個 None 欄位，用昨天 macro_risk.json 的值補上，
    # 並標記 _from_cache_yesterday=True；避免單日 API 抽風就讓使用者看到大片「整編」
    try:
        if OUTPUT_FILE.exists():
            prev = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
            patched = []
            for key in ("us10y_yield", "us2y_yield", "fi_spot_net", "fi_futures_net",
                        "usdtwd", "fear_greed", "fear_greed_label",
                        "retail_ls_pct", "taifex_backwardation"):
                if out.get(key) is None and prev.get(key) is not None:
                    out[key] = prev[key]
                    patched.append(key)
            if patched:
                out["_from_cache_yesterday"] = patched
                print(f"  🛡️ 斷崖防護：{len(patched)} 個欄位用昨天 cache 補值 → {patched}")
    except Exception as e:
        print(f"  ⚠️ 斷崖防護讀舊檔失敗：{e}（不影響本次寫檔）")

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
