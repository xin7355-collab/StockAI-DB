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
import yfinance
import ta

DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)
OUTPUT_FILE = DATA_DIR / "macro_risk.json"

# ══════════════════════════════════════════════════════════════════
# 📅 全球重大財經事件日曆(純演算法,零外部依賴,絕不崩潰)
# ── 跨年提醒:FOMC/BOJ 排程硬編碼 2026 場次,2026 年底前需手動補 2027 排程 ──
# ══════════════════════════════════════════════════════════════════
FOMC_SCHEDULE = [
    # 2026 FOMC 排程(federalreserve.gov 公開),需於 2026/Q4 更新 2027 排程
    "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
    "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-16",
]
BOJ_SCHEDULE = [
    # 2026 BOJ 排程(boj.or.jp 公開),需於 2026/Q4 更新 2027 排程
    "2026-01-22", "2026-03-19", "2026-04-30", "2026-06-17",
    "2026-07-31", "2026-09-18", "2026-10-30", "2026-12-18",
]


def _compute_upcoming_macro_events(today, window_days=7):
    """演算法計算未來 N 天的全球重大財經事件,純函式無 IO,絕對不會拋例外。"""
    from datetime import date, timedelta
    if not isinstance(today, date):
        today = date.today()
    end = today + timedelta(days=window_days)
    events = []

    # ── 月度規律事件:第三個週三(台指結算)、第三個週五(四巫日,只 3/6/9/12)、
    #    每月 10-14 日首個工作日(CPI)、CPI+1 工作日(PPI)──
    for m_offset in (0, 1):
        year = today.year
        month = today.month + m_offset
        if month > 12:
            year += 1
            month -= 12
        first = date(year, month, 1)

        # 第三個週三 = 該月首個週三 + 14 天 (weekday: Mon=0..Sun=6, Wed=2)
        third_wed = first + timedelta(days=((2 - first.weekday()) % 7) + 14)
        if today < third_wed <= end:
            events.append({"date": third_wed.isoformat(),
                           "event": "🇹🇼 台指期貨大結算 (提防外資結算洗盤)"})

        # 第三個週五,僅 3/6/9/12 月 → 四巫日 (weekday: Fri=4)
        if month in (3, 6, 9, 12):
            third_fri = first + timedelta(days=((4 - first.weekday()) % 7) + 14)
            if today < third_fri <= end:
                events.append({"date": third_fri.isoformat(),
                               "event": "🇺🇸 美股四巫日 (選擇權結算,波動激增)"})

        # CPI:每月 10-14 日首個工作日(週一~週五);PPI = CPI + 1 工作日
        cpi_d = None
        for day in range(10, 15):
            try:
                cand = date(year, month, day)
            except ValueError:
                continue
            if cand.weekday() < 5:
                cpi_d = cand
                break
        if cpi_d is not None:
            if today < cpi_d <= end:
                events.append({"date": cpi_d.isoformat(),
                               "event": "🇺🇸 美國 CPI 通膨數據公布 (Fed 政策風向球)"})
            ppi_d = cpi_d + timedelta(days=1)
            while ppi_d.weekday() >= 5:
                ppi_d += timedelta(days=1)
            if today < ppi_d <= end:
                events.append({"date": ppi_d.isoformat(),
                               "event": "🇺🇸 美國 PPI 生產者物價指數"})

    # ── 預編排事件:FOMC、BOJ 利率決議 ──
    for d_str in FOMC_SCHEDULE:
        try:
            dd = date.fromisoformat(d_str)
        except ValueError:
            continue
        if today < dd <= end:
            events.append({"date": d_str,
                           "event": "🇺🇸 FOMC 聯準會利率決議 (終極利空/利多)"})
    for d_str in BOJ_SCHEDULE:
        try:
            dd = date.fromisoformat(d_str)
        except ValueError:
            continue
        if today < dd <= end:
            events.append({"date": d_str,
                           "event": "🇯🇵 日銀 BOJ 利率決議 (套息交易風向球)"})

    # ── 一次性事件:讀 data/manual_events.json(Claude 代為更新)──
    try:
        manual_file = Path(__file__).parent / 'data' / 'manual_events.json'
        if manual_file.exists():
            manual_data = json.loads(manual_file.read_text(encoding='utf-8'))
            for e in manual_data.get('events', []):
                try:
                    ev_date = date.fromisoformat(e['date'])
                except (ValueError, KeyError):
                    continue
                if today < ev_date <= end:
                    events.append({"date": e['date'], "event": e['event']})
    except Exception as _e:
        print(f"   ⚠️ manual_events.json 讀取失敗(不影響其他):{_e}")

    # 去重 + 依日期升冪排序
    seen = set()
    uniq = []
    for e in sorted(events, key=lambda x: (x["date"], x["event"])):
        sig = (e["date"], e["event"])
        if sig in seen:
            continue
        seen.add(sig)
        uniq.append(e)
    return uniq

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


# ════════ TAIFEX 官方 OpenAPI JSON（schema 具名、穩定，取代易碎的 CSV/HTML 爬蟲）════════
# 本機沙箱無法直連 taifex（Host not in allowlist），只有 GitHub Actions 可達；
# 故採「多候選端點 + 中/英 key 模糊比對 + 失敗 dump 全部 key」設計，讓 CI log 必能揭露真實 schema。
TAIFEX_OPENAPI_BASE = "https://openapi.taifex.com.tw/v1/"
_TAIFEX_OPENAPI_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json",
}
# 三大法人-區分各期貨契約-依日期 OpenAPI 端點（probe swagger 已確認正確名）
# 實測 keys: Date / ContractCode(商品中文名) / Item(身份別) / OpenInterest(Net|Long|Short) …
_TAIFEX_INST_ENDPOINTS = [
    "MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate",
]


def _taifex_openapi(paths):
    """依序試候選 OpenAPI 端點，回傳 (list_of_dicts, None)；全失敗回 (None, 診斷字串)。
    任一端點 200 且 body 為非空 list 即採用，並印出第一列 keys 供 schema 確認。"""
    diag = []
    for p in paths:
        url = TAIFEX_OPENAPI_BASE + p
        try:
            r = http.get(url, headers=_TAIFEX_OPENAPI_UA, timeout=20)
            if r.status_code != 200:
                diag.append(f"{p}:HTTP{r.status_code}")
                continue
            data = r.json()
            if isinstance(data, list) and data and isinstance(data[0], dict):
                print(f"  [TAIFEX OpenAPI] ✅ {p} 回 {len(data)} 列；keys={list(data[0].keys())}")
                return data, None
            diag.append(f"{p}:非list/空({type(data).__name__})")
        except Exception as e:
            diag.append(f"{p}:{str(e)[:40]}")
    return None, "OpenAPI 全失敗 → " + " | ".join(diag)


def _find_key(row, candidates):
    """回 row 中第一個『key 含任一 candidate 子字串』的 (key, value)；找不到回 (None, None)。"""
    for k in row.keys():
        kk = str(k)
        for c in candidates:
            if c in kk:
                return k, row[k]
    return None, None


def _row_pick(row, *substrs):
    """在 dict row 的 key 裡找『同時包含全部 substrs』的第一個鍵，回值轉 float（去逗號）；否則 None。"""
    for k, v in row.items():
        kk = str(k)
        if all(s in kk for s in substrs):
            try:
                return float(str(v).replace(",", "").strip())
            except (ValueError, AttributeError, TypeError):
                return None
    return None


# 實測 OpenAPI 欄位（英文）：商品=ContractCode、身份=Item、淨/多/空未平倉口數=OpenInterest(Net|Long|Short)
_PROD_KEYS = ['ContractCode', '商品名稱', '商品', '契約', 'ContractName', 'Commodity']
_IDENT_KEYS = ['Item', '身份別', '身分別', 'Identity', 'InstitutionalInvestor', 'Investors', '法人']


def _taifex_sum_net_oi(rows, product_match, want_identity=None):
    """三大法人 OpenAPI rows → 加總『多空淨額未平倉口數』OpenInterest(Net)。
    product_match(prod_str)->bool 決定該列商品是否納入；want_identity=None 表加總全部身份別
    （外資身份實際字串為「外資及陸資」，故用子字串 '外資' 比對即可命中）。
    回 (net_total, long_short_sum, 命中列數, 全部商品名集合)。"""
    net_total = 0.0
    ls_sum = 0.0
    matched = 0
    seen_products = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        _, prod = _find_key(row, _PROD_KEYS)
        if prod is not None and str(prod).strip():
            seen_products.add(str(prod).strip()[:24])
        if prod is None or not product_match(str(prod)):
            continue
        if want_identity is not None:
            _, ident = _find_key(row, _IDENT_KEYS)
            if ident is None or want_identity not in str(ident):
                continue
        # 淨未平倉口數：實測英文 'OpenInterest(Net)'（dict 順序在 ContractValueof… 之前，子字串首匹配即正確）
        net = _row_pick(row, 'OpenInterest(Net)')
        if net is None:
            net = _row_pick(row, '多空淨額', '未平倉', '口數')  # 中文 fallback
        if net is None:
            continue
        net_total += net
        long_oi = _row_pick(row, 'OpenInterest(Long)') or _row_pick(row, '多方', '未平倉', '口數') or 0
        short_oi = _row_pick(row, 'OpenInterest(Short)') or _row_pick(row, '空方', '未平倉', '口數') or 0
        ls_sum += (long_oi + short_oi)
        matched += 1
    return net_total, ls_sum, matched, seen_products


def fetch_foreign_futures_net():
    """TAIFEX 外資臺指期 OI 淨口數（多空淨額未平倉口數）
    ① 優先官方 OpenAPI JSON（schema 穩定）② 失敗退 CSV 端點 ③ 再退 HTML regex
    """
    # ── ① 官方 OpenAPI JSON ──
    data, err = _taifex_openapi(_TAIFEX_INST_ENDPOINTS)
    if data:
        net, _ls, matched, seen = _taifex_sum_net_oi(
            data, lambda p: "臺股期貨" in p, want_identity="外資")
        if matched > 0:
            print(f"  [TAIFEX OpenAPI] 外資臺指期 淨未平倉={int(net)} 口")
            return int(net), None
        print(f"  [TAIFEX OpenAPI] 外資臺指期未匹配；keys={list(data[0].keys())}；商品名={sorted(seen)[:20]}")
    else:
        print(f"  [TAIFEX OpenAPI] 外資期貨端點失敗：{err}")

    # ── ② 原 CSV 端點（保留為 fallback）──
    return _fetch_foreign_futures_net_csv()


def _fetch_foreign_futures_net_csv():
    """原本的 CSV 端點解析（/cht/3/futContractsDateDown）→ 保留為 OpenAPI 失敗時 fallback。"""
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
    """美債 2Y — FRED DGS2 CSV；HTTPS 偶爾逾時，3 次 exponential backoff + 鏡像 endpoint 重試
    雙層 fallback：FRED 全敗時退到 yfinance ^IRX(13W) 與 ^FVX(5Y) 內插近似 2Y
    """
    import csv as _csv
    import io as _io
    import requests as _rq
    urls = [
        "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2",
        "https://fred.stlouisfed.org/data/DGS2.csv",  # 鏡像 endpoint（fallback）
    ]
    ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "text/csv,text/plain,*/*"}
    last_err = "FRED DGS2 全失敗"
    # 單發 GET（不走帶 urllib3 Retry 的 http session）→ FRED 在 GH Actions IP 常被封，
    # 用裸 requests + 8s timeout 快速放棄（省下原本最多 ~120s 的重試空轉），直接走 yfinance fallback。
    for url in urls:
        try:
            r = _rq.get(url, headers=ua, timeout=8)
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
    # Fallback：yfinance ^IRX(13W) + ^FVX(5Y) 內插近似 2Y（FRED IP 被 GH Actions 阻斷時的救命管道）
    try:
        import yfinance as yf
        irx = yf.Ticker("^IRX").history(period="5d", auto_adjust=False)
        fvx = yf.Ticker("^FVX").history(period="5d", auto_adjust=False)
        if irx is not None and not irx.empty and fvx is not None and not fvx.empty:
            irx_v = float(irx["Close"].iloc[-1])
            fvx_v = float(fvx["Close"].iloc[-1])
            # ^IRX 13週、^FVX 5Y — 2Y 介於其中，用簡單時間距離權重
            # 13週=0.25Y、2Y=2Y、5Y=5Y → 線性內插：w_irx = (5-2)/(5-0.25) = 3/4.75
            approx_2y = round(irx_v * (3 / 4.75) + fvx_v * (1 - 3 / 4.75), 3)
            print(f"  [US2Y fallback] ^IRX={irx_v} ^FVX={fvx_v} → 近似 2Y={approx_2y}")
            return approx_2y, f"FRED 失敗，yfinance 內插（IRX+FVX）"
    except Exception as e:
        last_err = f"FRED+yfinance 全敗：{str(e)[:80]}"
    print(f"  ⚠️ US2Y 三次嘗試皆失敗: {last_err}")
    return None, last_err


# ════════ 🌍 全球巨頭脈動採集（8 大國際資金真實流向）════════
def _fetch_yf_close(ticker, name):
    """通用 yfinance 收盤 + 日漲幅%（取 5 日內最新 close vs 前一日 close）
    含防 429 限流：本輪 yfinance 連續呼叫達 ~14 次，呼叫前小睡 0.4s，回空再重試 1 次（睡 1s）。"""
    import time
    last_err = f"{name} 重試後仍失敗"
    for attempt in range(2):
        try:
            time.sleep(0.4 if attempt == 0 else 1.0)
            import yfinance as yf
            hist = yf.Ticker(ticker).history(period="5d", auto_adjust=False)
            if hist is None or hist.empty or len(hist) < 2:
                last_err = f"{name} yfinance 回空或 <2 日"
                continue
            last = float(hist["Close"].iloc[-1])
            prev = float(hist["Close"].iloc[-2])
            chg_pct = round((last - prev) / prev * 100, 2) if prev > 0 else 0
            return round(last, 2), chg_pct, None
        except Exception as e:
            last_err = str(e)[:100]
            continue
    return None, None, last_err


def fetch_gold():     return _fetch_yf_close("GC=F",     "黃金")        # 期貨 close usd/oz
def fetch_wti_oil():  return _fetch_yf_close("CL=F",     "WTI 原油")    # usd/barrel
def fetch_dxy():      return _fetch_yf_close("DX-Y.NYB", "美元指數")    # 美元指數
def fetch_btc():      return _fetch_yf_close("BTC-USD",  "比特幣")      # usd
def fetch_vix():      return _fetch_yf_close("^VIX",     "VIX 恐慌指數")
def fetch_nikkei():   return _fetch_yf_close("^N225",    "日經 225")
def fetch_hsi():      return _fetch_yf_close("^HSI",     "恆生指數")
def fetch_kospi():    return _fetch_yf_close("^KS11",    "韓股 KOSPI")


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
    ① 優先官方 OpenAPI JSON（schema 穩定）② 失敗退原 CSV 解析
    """
    # ── ① 官方 OpenAPI JSON ──
    data, err = _taifex_openapi(_TAIFEX_INST_ENDPOINTS)
    if data:
        # MTX 商品名為「小型臺指期貨」；加總三大法人淨未平倉
        net, ls_max, matched, seen = _taifex_sum_net_oi(
            data, lambda p: ("小型臺指" in p) or ("小型台指" in p), want_identity=None)
        if matched > 0 and ls_max > 0:
            retail_pct = round(-(net) / ls_max * 100, 1)
            print(f"  [散戶多空比 OpenAPI] inst_net={int(net)} 近似總OI={int(ls_max)} → {retail_pct}%")
            return retail_pct, None
        print(f"  [散戶多空比 OpenAPI] 未匹配；keys={list(data[0].keys())}；商品名={sorted(seen)[:20]}")
    else:
        print(f"  [散戶多空比 OpenAPI] 端點失敗：{err}")

    # ── ② 原 CSV 解析（保留為 fallback）──
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


def _taifex_openapi_tx_fut_close():
    """官方 OpenAPI『期貨每日交易行情』→ 取 TX 近月收盤（排除週契約；以未沖銷量最大者當近月）。
    回 float 收盤價；失敗回 None。"""
    data, err = _taifex_openapi(["DailyMarketReportFut", "DailyMarketReportFutures"])
    if not data:
        print(f"  [台指逆價差 OpenAPI] 期貨行情端點失敗：{err}")
        return None
    best_close, best_oi = None, -1.0
    seen = set()
    for row in data:
        if not isinstance(row, dict):
            continue
        # 契約欄：實測 OpenAPI key 為英文 'Contract'（值如 TX/MTX/TE…）
        _, contract = _find_key(row, ['Contract', '契約', '商品', 'Commodity'])
        cstr = str(contract).strip() if contract is not None else ""
        if cstr:
            seen.add(cstr[:12])
        # TX 精確比對（避免誤抓 MTX / 電子 / 金融）
        if cstr not in ("TX", "TXF", "臺股期貨"):
            continue
        # 到期月份欄：實測英文 'ContractMonth(Week)'，週契約含 'W'
        _, exp = _find_key(row, ['ContractMonth', '到期', '契約月', '月份', 'Delivery'])
        if exp is not None and ("週" in str(exp) or "W" in str(exp).upper()):
            continue  # 排除週期貨
        # 收盤：實測英文 'Last'(最後成交) / 'SettlementPrice'(結算)；'-' 會被 _row_pick 視為 None
        close = (_row_pick(row, 'Last') or _row_pick(row, '收盤')
                 or _row_pick(row, 'SettlementPrice') or _row_pick(row, '結算')
                 or _row_pick(row, '最後成交'))
        if close is None or close <= 0:
            continue
        oi = (_row_pick(row, 'OpenInterest') or _row_pick(row, '未沖銷')
              or _row_pick(row, '未平倉') or 0)
        if oi >= best_oi:
            best_oi, best_close = oi, close
    if best_close is None:
        print(f"  [台指逆價差 OpenAPI] 未匹配 TX 列；keys={list(data[0].keys())}；契約={sorted(seen)[:20]}")
    return best_close


def fetch_taifex_backwardation():
    """台指逆價差 = 臺股期貨(TX)近月收盤 − 加權指數(^TWII)現貨收盤（負值＝逆價差）
    期貨收盤：① 官方 OpenAPI JSON ② yfinance ^TXF=F ③ TAIFEX HTML regex
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
        # 2) 期貨收盤：① 官方 OpenAPI JSON ② yfinance ^TXF=F ③ TAIFEX HTML
        fut_close = _taifex_openapi_tx_fut_close()
        if fut_close is not None:
            print(f"  [台指逆價差] OpenAPI TX 近月收盤 = {fut_close}")
        if fut_close is None:
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
        # ── 🌍 全球巨頭脈動（8 大國際指標，yfinance）──
        "gold_usd":       None, "gold_chg_pct":   None, "gold_error":   None,
        "wti_oil":        None, "wti_chg_pct":    None, "wti_error":    None,
        "dxy":            None, "dxy_chg_pct":    None, "dxy_error":    None,
        "btc_usd":        None, "btc_chg_pct":    None, "btc_error":    None,
        "vix":            None, "vix_chg_pct":    None, "vix_error":    None,
        "nikkei":         None, "nikkei_chg_pct": None, "nikkei_error": None,
        "hsi":            None, "hsi_chg_pct":    None, "hsi_error":    None,
        "kospi":          None, "kospi_chg_pct":  None, "kospi_error":  None,
        # ── 📅 未來 7 日核彈事件(純演算法,主流程結尾計算填入)──
        "upcoming_macro_events": [],
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

    print("[8/16] 抓取台指逆價差 (TX − ^TWII)…")
    back, backerr = fetch_taifex_backwardation()
    out["taifex_backwardation"], out["taifex_backwardation_error"] = back, backerr
    print(f"     → {back} 點（err={backerr}）")

    # ── 🌍 全球巨頭脈動（8 大國際指標）──
    print("─" * 50)
    print("🌍 採集全球巨頭脈動（黃金 / 原油 / 美元 / BTC / VIX / 日經 / 恆指 / 韓股）")
    big_player_fns = [
        ("黃金",         "gold",   fetch_gold),
        ("WTI原油",       "wti",    fetch_wti_oil),
        ("美元指數DXY",    "dxy",    fetch_dxy),
        ("比特幣BTC",     "btc",    fetch_btc),
        ("VIX恐慌",       "vix",    fetch_vix),
        ("日經225",       "nikkei", fetch_nikkei),
        ("恆生指數",       "hsi",    fetch_hsi),
        ("韓股KOSPI",     "kospi",  fetch_kospi),
    ]
    key_alias = {"gold": "gold_usd", "wti": "wti_oil", "dxy": "dxy",
                 "btc": "btc_usd", "vix": "vix", "nikkei": "nikkei",
                 "hsi": "hsi", "kospi": "kospi"}
    for i, (name, key, fn) in enumerate(big_player_fns, 9):
        print(f"[{i}/16] {name}…")
        val, chg, err = fn()
        out[key_alias[key]]      = val
        out[f"{key}_chg_pct"]    = chg
        out[f"{key}_error"]      = err
        if val is not None:
            sign = "+" if (chg or 0) > 0 else ""
            print(f"     → {val} ({sign}{chg}%)")
        else:
            print(f"     → 失敗：{err}")

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
                        "retail_ls_pct", "taifex_backwardation",
                        # 🌍 全球巨頭脈動 8 指標斷崖防護
                        "gold_usd", "gold_chg_pct", "wti_oil", "wti_chg_pct",
                        "dxy", "dxy_chg_pct", "btc_usd", "btc_chg_pct",
                        "vix", "vix_chg_pct", "nikkei", "nikkei_chg_pct",
                        "hsi", "hsi_chg_pct", "kospi", "kospi_chg_pct"):
                if out.get(key) is None and prev.get(key) is not None:
                    out[key] = prev[key]
                    patched.append(key)
            if patched:
                out["_from_cache_yesterday"] = patched
                print(f"  🛡️ 斷崖防護：{len(patched)} 個欄位用昨天 cache 補值 → {patched}")
    except Exception as e:
        print(f"  ⚠️ 斷崖防護讀舊檔失敗：{e}（不影響本次寫檔）")

    # ── 📅 全球重大財經事件日曆(純演算法,絕不拋例外)──
    try:
        from datetime import date as _date
        out["upcoming_macro_events"] = _compute_upcoming_macro_events(_date.today())
        print(f"📅 未來 7 日核彈事件:{len(out['upcoming_macro_events'])} 場")
        for ev in out["upcoming_macro_events"]:
            print(f"     · {ev['date']}  {ev['event']}")
    except Exception as e:
        print(f"  ⚠️ 事件日曆演算法失敗(不影響主流程):{e}")
        out["upcoming_macro_events"] = []

    # 寫檔（最輕量）— 任何 IO 錯誤不能讓整個 daily_miner 崩潰
    try:
        OUTPUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✅ 已輸出 → {OUTPUT_FILE}")
    except Exception as e:
        print(f"⚠️ macro_risk.json 寫檔失敗（不影響其他流程）：{e}")
        sys.exit(0)   # 強制 exit 0 避免污染 workflow


def generate_bubble_warning():
    """抓取台灣證交所「全市場融資餘額」，生成泡沫預警 JSON"""
    try:
        print("\n" + "─" * 50)
        print("📊 開始抓取大盤融資餘額 (TWSE MI_MARGN)...")
        url = "https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&selectType=MS"
        # 使用系統內建帶有重試機制的 http session
        res = http.get(url, headers=HEADERS, timeout=10).json()

        # 擷取全市場融資餘額 (單位: 仟元)
        margin_str = res['tables'][0]['data'][2][5]
        margin_value_k = int(margin_str.replace(',', ''))
        margin_value_100m = margin_value_k / 100000  # 轉換為億元

        status = "🟢 健康 (散戶槓桿安定)"
        if margin_value_100m > 3200:
            status = "🔴 極度危險 (融資餘額破3200億，散戶槓桿過熱，提防多殺多斷頭潮)"
        elif margin_value_100m > 2800:
            status = "🟡 警戒 (融資水位偏高，盤勢易震盪)"

        bubble_data = {
            "大盤融資餘額_億元": round(margin_value_100m, 2),
            "融資槓桿水位狀態": status,
            "警報說明": "融資餘額代表散戶借錢炒股的金額。水位過高代表市場泡沫化，下跌時容易引發斷頭賣壓。"
        }

        # 確保檔案存放在 data 資料夾，這樣才能被 GitHub 同步到網頁端！
        bubble_path = DATA_DIR / "bubble_warning.json"
        with open(bubble_path, 'w', encoding='utf-8') as f:
            json.dump(bubble_data, f, ensure_ascii=False, indent=4)

        print(f"✅ 成功生成 {bubble_path}: 目前融資餘額 {margin_value_100m:.2f} 億元")

    except Exception as e:
        print(f"❌ 抓取大盤融資餘額失敗: {e}")

# ==========================================
# 🚀 程式執行起點 (雙引擎同時發動)
# ==========================================
if __name__ == "__main__":
    try:
        # 第一引擎：抓取總經三大指標
        main()
        
        # 第二引擎：抓取大盤融資槓桿 (就在這裡被呼叫！)
        generate_bubble_warning()
        
    except Exception as e:
        print(f"💥 macro_miner 頂層異常：{e}")
        traceback.print_exc()
        sys.exit(0)
