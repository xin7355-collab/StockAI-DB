"""
ETF 順風車採礦機 — 自動追蹤「績效前段班」主動式 ETF + 每日持股換股偵測
═══════════════════════════════════════════════════════════════════════════════
產出 data/etf_tracking.json：
  • 績效排行(Tier 1)：用已採礦的 data/{etf}.json 收盤價計算 → 零外部依賴、保證可動
  • 每檔前 N 大持股+權重(Tier 2)：盡力抓投信/TWSE 每日 PCF(申購買回清單)，逐檔容錯
  • 換股偵測：讀「上一版 etf_tracking.json」的持股 vs 今日 → added/removed/加減碼
  • 跟單交叉：stock → [持有它的 ETF]、今日多檔 ETF 同時新增的人氣股

執行時機：daily_miner.yml deploy 階段(此時 data/ 已由 origin/data 鋪好，含上一版 tracking)。
誠實前提：開發沙箱無外網 → holdings 抓取的解析器需在 GitHub Actions 首跑後依 log 迭代；
          perf 排行本機即可驗。holdings 抓不到時自動沿用上一版、不誤判成「全部換掉」。
"""
import json
import re
import random
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta

import requests
try:
    import yfinance as yf   # V33.6 — 含息總報酬(還原息)用;跑 etf_miner 的 job 已裝(daily_miner.yml)
except Exception:
    yf = None

DATA_DIR = "data"
OUT = Path(DATA_DIR) / "etf_tracking.json"

TOP_N = 10            # 前段班檔數
HOLD_TOP = 15         # 每檔顯示前幾大持股
PERF_LOOKBACK = 120   # 績效回看交易日(近似半年)
MIN_HISTORY = 15      # 最少價格筆數才納入排名(主動 ETF 2025/5 才上市)
WEIGHT_DELTA = 0.3    # 加減碼判定門檻(權重變動 %)

# 被動式基準(當對照組，不參與「主動前段班」排名)
BENCHMARKS = ["0050", "0056", "00878"]

# 🆕 缺口7(12-3 市值型集中度):市值型 ETF 單一成分股集中度對照。
#   逐字稿核心例:0050 台積電佔約 5 成(買 0050 等於買半個台積電)vs 00922 等權重降到約 1 成。
#   抓這幾檔的 holdings 算 top1 集中度,讓使用者一眼看出「集中 vs 分散」。
CONC_WATCH = ["0050", "006208", "00922", "00923"]

# 🆕 缺口4(12-5 資產配置分層):ETF 類型。只標「可確定」的,未知不標(避免誤分類)。
#   主動型由代號規則(00\d{3}A)判定;其餘查此已知字典。
ETF_CATEGORY = {
    "0050": "市值型", "006208": "市值型", "00922": "市值型(等權)", "00923": "市值型(等權)",
    "0056": "高息", "00878": "高息", "00919": "高息", "00929": "高息", "00713": "高息低波", "00701": "高息低波",
}


def etf_category(sym):
    """回 ETF 類型字串或 None(未知不猜)。主動型:00\\d{3}A;其餘查 ETF_CATEGORY。"""
    if re.fullmatch(r"00\d{3}[A-Z]", str(sym)):
        return "主動型"
    return ETF_CATEGORY.get(str(sym))

session = requests.Session()
_UA = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
]


def _hdrs():
    return {"User-Agent": random.choice(_UA)}


# 已知主動式 ETF 種子清單(防 data/ 尚未含；上雲後 list_active_etfs 會自動補新檔)
SEED_ACTIVE = [
    "00980A", "00981A", "00982A", "00983A", "00984A", "00985A", "00986A",
    "00987A", "00988A", "00989A", "00990A", "00991A", "00992A", "00993A",
    "00994A", "00995A", "00996A", "00997A", "00999A",
    "00400A", "00401A", "00402A", "00403A", "00404A", "00405A", "00406A",
]

# 中文名對照(已查證者填入；未知顯示代碼，上雲迭代時補)
ETF_NAMES = {
    "0050": "元大台灣50", "0056": "元大高股息", "00878": "國泰永續高股息",
    "00980A": "主動野村臺灣優選", "00981A": "主動統一台股增長",
    "00982A": "主動群益台灣強棒", "00984A": "主動安聯台灣高息",
    "00985A": "主動野村台灣50", "00987A": "主動台新優勢成長",
    "00988A": "主動統一全球創新", "00990A": "主動元大AI新經濟",
    "00991A": "主動復華未來50", "00992A": "主動群益科技創新",
    "00994A": "主動第一金台股優", "00995A": "主動中信台灣卓越",
    "00400A": "主動國泰動能高息",
}


def etf_name(sym):
    return ETF_NAMES.get(sym, sym)


# ── ETF 清單發現 ───────────────────────────────────────────────────────────
def list_active_etfs():
    """主動式 ETF 清單 = ① 既有 data/ 裡的 00\\d{3}A 代碼 ② 已知種子 ③ best-effort TWSE/TPEX 補充。"""
    syms = set(SEED_ACTIVE)
    for f in Path(DATA_DIR).glob("00*A.json"):
        s = f.stem
        if re.fullmatch(r"00\d{3}A", s):
            syms.add(s)
    try:
        syms |= _fetch_active_list_remote()
    except Exception as e:
        print(f"  ⚠️ 遠端主動清單抓取略過: {e}")
    # 只保留實際有價格資料的(才排得了名)
    return sorted(s for s in syms if (Path(DATA_DIR) / f"{s}.json").exists())


def _fetch_active_list_remote():
    """best-effort：TWSE 主動式 ETF 清單(JSON)。上雲後若格式不符再修。"""
    out = set()
    url = "https://openapi.twse.com.tw/v1/exchangeReport/TWT49U"  # 候選端點，可能需調整
    r = session.get(url, headers=_hdrs(), timeout=15)
    for row in (r.json() or []):
        for v in (row.values() if isinstance(row, dict) else []):
            m = re.fullmatch(r"00\d{3}A", str(v).strip())
            if m:
                out.add(str(v).strip())
    return out


# ── 價格與績效(Tier 1，零外部依賴) ────────────────────────────────────────
def load_prices(sym):
    p = Path(DATA_DIR) / f"{sym}.json"
    if not p.exists():
        return []
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, list) else []
    except Exception:
        return []


def _ret(closes, n):
    if not closes:
        return None
    base = closes[-(n + 1)] if len(closes) > n else closes[0]
    return round((closes[-1] / base - 1) * 100, 1) if base else None


def perf_metrics(rows):
    """近 120 日 / 近 20 日 / 上市以來 報酬(用收盤價)。資料太短回 None。"""
    closes = [r.get("close") for r in rows if r.get("close")]
    if len(closes) < MIN_HISTORY:
        return None
    return {
        "last": round(closes[-1], 2),
        "ret_120d": _ret(closes, min(PERF_LOOKBACK, len(closes) - 1)),
        "ret_20d": _ret(closes, min(20, len(closes) - 1)),
        "ret_incep": round((closes[-1] / closes[0] - 1) * 100, 1) if closes[0] else None,
        "bars": len(closes),
        "last_date": (rows[-1].get("date") if rows else None),
    }


def total_return_metrics(sym):
    """含息總報酬(還原息):yfinance auto_adjust=True(配息+拆股還原)算近120/近20日。
    高股息 ETF 配息多,市價未還原息會低估真實報酬,此函式補真實含息總報酬。
    台股 ETF 多上市→ .TW;抓不到再試 .TWO。失敗回 None(前端 fallback 市價報酬)。"""
    if yf is None or not sym:
        return None
    for suffix in (".TW", ".TWO"):
        try:
            h = yf.Ticker(sym + suffix).history(period="220d", auto_adjust=True)
            if h is None or h.empty:
                continue
            closes = [float(c) for c in h["Close"].tolist() if c and c > 0]
            if len(closes) < MIN_HISTORY:
                continue
            return {
                "tr_120d": _ret(closes, min(PERF_LOOKBACK, len(closes) - 1)),
                "tr_20d": _ret(closes, min(20, len(closes) - 1)),
            }
        except Exception:
            continue
    return None


def dividend_fill_metrics(sym, max_divs=6, fill_window=120):
    """🆕 缺口3(12-3):ETF 填息力。近 max_divs 次配息,每次除息後多少天內「填息」
    (收盤回到除息前一日收盤 = 填息目標)。回 {fill_rate(%), avg_fill_days, samples} 或 None。
    用 yfinance 原始(未還原)收盤 + 配息序列;全程容錯,任何失敗回 None(前端自動隱藏)。
    填息力是高息 ETF 的硬指標(逐字稿:填息越快越強;配息頻率只是心理安慰)。"""
    if yf is None or not sym:
        return None
    for suffix in (".TW", ".TWO"):
        try:
            t = yf.Ticker(sym + suffix)
            h = t.history(period="2y", auto_adjust=False)
            if h is None or h.empty:
                continue
            divs = t.dividends
            if divs is None or len(divs) == 0:
                continue
            closes = h["Close"]
            idx = list(closes.index)
            filled = total = days_sum = 0
            for exdate, amt in list(divs.items())[-max_divs:]:
                if not amt or amt <= 0:
                    continue
                pos = next((i for i, dt in enumerate(idx) if dt.date() >= exdate.date()), None)
                if not pos:            # None 或 0(除息前一日無資料)都跳過
                    continue
                pre_close = float(closes.iloc[pos - 1])
                if pre_close <= 0:
                    continue
                total += 1
                for j in range(pos, min(len(idx), pos + fill_window)):
                    if float(closes.iloc[j]) >= pre_close:
                        filled += 1
                        days_sum += (j - pos + 1)
                        break
            if total == 0:
                return None
            res = {"fill_rate": round(filled / total * 100, 0),
                   "avg_fill_days": round(days_sum / filled, 0) if filled else None,
                   "samples": total}
            print(f"  ✓ [填息] {sym}: 填息率 {res['fill_rate']}% / 平均 {res['avg_fill_days']} 天 / {total} 次")
            return res
        except Exception as _fe:
            print(f"  · [填息] {sym}{suffix}: {type(_fe).__name__}: {str(_fe)[:60]}")
            continue
    return None


def perf_with_tr(sym, rows):
    """市價報酬 + 含息總報酬合併(含息抓失敗就只有市價,前端自會 fallback)。"""
    m = perf_metrics(rows)
    if m:
        tr = total_return_metrics(sym)
        if tr:
            m["tr_120d"] = tr.get("tr_120d")
            m["tr_20d"] = tr.get("tr_20d")
    return m


def _rank_value(m):
    v = m.get("ret_120d")
    return v if v is not None else (m.get("ret_incep") if m.get("ret_incep") is not None else -9999)


# ── 持股抓取(Tier 2)：泛用解析器(JSON / HTML 表格皆可) + 多來源容錯 ──────────
# 設計成「格式無關」：不論 etfinfo / 投信 JSON / HTML 表格，皆能抽出 {sym,name,weight}。
# 確切端點上雲探針確認後填入 HOLDINGS_SOURCES，解析器本身已本機單元測試。
_CODE_KEYS = ("code", "stockcode", "stock_id", "stockno", "stockId", "symbol",
              "證券代號", "股票代號", "代號", "成分股代號", "個股代號")
_NAME_KEYS = ("name", "stockname", "stock_name", "stockName", "證券名稱",
              "股票名稱", "名稱", "成分股名稱", "個股名稱")
_WEIGHT_KEYS = ("weight", "weights", "ratio", "percent", "percentage", "pct",
                "權重", "比例", "投資比例", "持股權重", "比重", "佔淨值比例")


def _to_float(v):
    try:
        return float(str(v).replace("%", "").replace(",", "").strip())
    except Exception:
        return None


def _pick(d, keys):
    low = {str(k).lower(): k for k in d.keys()}
    for k in keys:
        if k in d:
            return d[k]
        if k.lower() in low:
            return d[low[k.lower()]]
    return None


def _normalize_holdings(items):
    """list[dict] → [{sym,name,weight}]，抽代號/名稱/權重，去重(同代號留權重大者)。"""
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        code = _pick(it, _CODE_KEYS)
        if code is None:
            continue
        m = re.search(r"\d{4,6}[A-Z]?", str(code))
        if not m:
            continue
        out.append({"sym": m.group(0),
                    "name": (str(_pick(it, _NAME_KEYS)).strip() if _pick(it, _NAME_KEYS) else ""),
                    "weight": _to_float(_pick(it, _WEIGHT_KEYS))})
    best = {}
    for h in out:
        if h["sym"] not in best or (h["weight"] or 0) > (best[h["sym"]]["weight"] or 0):
            best[h["sym"]] = h
    return list(best.values())


def _looks_like_holdings(lst):
    return (isinstance(lst, list) and len(lst) >= 3 and isinstance(lst[0], dict)
            and _pick(lst[0], _CODE_KEYS) is not None and _pick(lst[0], _WEIGHT_KEYS) is not None)


def _deep_find_holdings(obj, depth=0):
    """遞迴在任意 JSON 中找出「看起來像持股清單」的 list。"""
    if depth > 6:
        return None
    if isinstance(obj, list):
        if _looks_like_holdings(obj):
            return obj
        for x in obj:
            r = _deep_find_holdings(x, depth + 1)
            if r:
                return r
    elif isinstance(obj, dict):
        for v in obj.values():
            r = _deep_find_holdings(v, depth + 1)
            if r:
                return r
    return None


def _holdings_from_json(text):
    lst = _deep_find_holdings(json.loads(text))
    return _normalize_holdings(lst) if lst else []


_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_CELL_RE = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S | re.I)
_TAG_RE = re.compile(r"<[^>]+>")


def _holdings_from_html(html):
    """從 HTML 表格列抽出 持股(代號 + 中文名 + 含% 的權重)。無 bs4 依賴。"""
    rows = []
    for rm in _ROW_RE.findall(html):
        cells = [_TAG_RE.sub("", c).strip() for c in _CELL_RE.findall(rm)]
        if len(cells) < 2:
            continue
        code = next((c for c in cells if re.fullmatch(r"\d{4,6}[A-Z]?", c)), None)
        if not code:
            continue
        weight = next((_to_float(c) for c in cells if "%" in c and re.search(r"\d", c)), None)
        chin = [c for c in cells if re.search(r"[一-鿿]", c)]
        rows.append({"code": code, "name": (max(chin, key=len) if chin else ""), "weight": weight})
    return _normalize_holdings(rows)


# 持股+名稱來源:etfinfo.tw 官方 API(每日同步,回 info.name 與成分股 code/name/weight)
ETFINFO_API = "https://www.etfinfo.tw/api/etf/{s}"

# 基金規模(NAV/AUM)候選 key — 用於「估算共識買賣超張數」
_FUND_SIZE_KEYS = ("fund_size", "fundSize", "total_nav", "totalNav", "nav_total",
                   "totalAsset", "total_asset", "aum", "scale", "fundScale",
                   "資產規模", "基金規模", "淨資產", "總資產", "受益權單位淨資產")

# 🆕 缺口1(12-3):總費用率(內扣)。etfinfo 可能有 expense/fee 欄,best-effort 抓,抓不到回 None。
_FEE_KEYS = ("expense_ratio", "expenseRatio", "expense", "totalExpense", "total_expense",
             "ter", "totalExpenseRatio", "managementFee", "management_fee", "fee",
             "內扣", "總費用率", "總開銷", "經理費", "管理費", "費用率")


def _norm_expense(v):
    """把抓到的費用值正規化成「%」。TW ETF 內扣多在 0.3~1.5%。
    只在「可信格式」才回值,無法判定格式(避免顯示錯誤數字)一律回 None(誠實優先)。
      0.0005~0.03 = 小數格式(0.004→0.4%);0.05~3 = 已是百分比;其餘 → None。"""
    v = _to_float(v)
    if not v or v <= 0:
        return None
    if 0.0005 <= v <= 0.03:
        return round(v * 100, 3)
    if 0.05 <= v <= 3:
        return round(v, 3)
    return None


def _deep_find_scalar(obj, keys, depth=0):
    """遞迴在 JSON 中找含 keys 之一的純量(數字字串),回傳 float 或 None"""
    if depth > 6 or obj is None:
        return None
    if isinstance(obj, dict):
        # 直接命中
        for k in keys:
            if k in obj:
                v = _to_float(obj[k])
                if v and v > 0:
                    return v
            # 大小寫不敏感比對
            for ok in obj.keys():
                if str(ok).lower() == str(k).lower():
                    v = _to_float(obj[ok])
                    if v and v > 0:
                        return v
        for v in obj.values():
            r = _deep_find_scalar(v, keys, depth + 1)
            if r:
                return r
    elif isinstance(obj, list):
        for x in obj:
            r = _deep_find_scalar(x, keys, depth + 1)
            if r:
                return r
    return None


def fetch_etf_detail(sym):
    """回傳 (name, holdings[{sym,name,weight}], fund_size_or_None, expense_ratio_or_None)。
    用 etfinfo /api/etf/{code};失敗回 (None, [], None, None)。
    fund_size:基金規模(元),估算共識買賣超張數。expense_ratio:總費用率(%,缺口1,best-effort)。"""
    try:
        time.sleep(0.4)  # 對 etfinfo 禮貌節流(10+ 檔序列抓取,避免被限流)
        r = session.get(ETFINFO_API.format(s=sym), headers=_hdrs(), timeout=15)
        if r.status_code != 200 or not r.text:
            print(f"  · etfinfo {sym} status={r.status_code}")
            return None, [], None, None
        d = r.json()
        name = ((d.get("info") or {}).get("name")) if isinstance(d, dict) else None
        lst = _deep_find_holdings(d)
        holds = _normalize_holdings(lst) if lst else []
        holds.sort(key=lambda x: (x.get("weight") or 0), reverse=True)
        fund_size = _deep_find_scalar(d, _FUND_SIZE_KEYS)
        _fee_raw = _deep_find_scalar(d, _FEE_KEYS)   # 缺口1:best-effort,首跑 log 出原始值供迭代
        expense_ratio = _norm_expense(_fee_raw)
        if holds:
            print(f"  ✓ etfinfo {sym}: name={name} holdings={len(holds)} fund_size={fund_size} fee_raw={_fee_raw}→{expense_ratio}%")
        return name, holds, fund_size, expense_ratio
    except Exception as e:
        print(f"  ⚠️ etfinfo {sym}: {type(e).__name__}: {e}")
        return None, [], None, None


def _latest_close(stock_sym):
    """讀 data/{sym}.json 最後一筆 close,沒檔案回 None"""
    p = Path(DATA_DIR) / f"{stock_sym}.json"
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(d, list) and d:
            last = d[-1] if isinstance(d[-1], dict) else None
            return _to_float(last.get("close")) if last else None
    except Exception:
        pass
    return None


def _attach_est_shares(holdings, fund_size, price_cache):
    """為每檔持股加 est_shares = (weight%/100 × fund_size) ÷ 股價。
    無 fund_size 或無股價就跳過(保持 None)。價格走 price_cache 共用 — 同一支股票
    在多檔 ETF 內共用 close,避免重讀 JSON。
    """
    if not fund_size or fund_size <= 0:
        return
    for h in holdings:
        w = h.get("weight")
        if not w or w <= 0:
            continue
        s = h.get("sym")
        if not s:
            continue
        if s not in price_cache:
            price_cache[s] = _latest_close(s)
        px = price_cache[s]
        if px and px > 0:
            # est_shares 單位「張」(1 張 = 1000 股)
            est = (w / 100.0) * fund_size / px / 1000.0
            h["est_shares"] = round(est, 1)


# ── 換股 diff ──────────────────────────────────────────────────────────────
EMPTY_CHANGES = {"added": [], "removed": [], "weight_up": [], "weight_down": []}


def diff_holdings(prev, curr):
    pm = {h["sym"]: h for h in prev if h.get("sym")}
    cm = {h["sym"]: h for h in curr if h.get("sym")}
    added = [cm[s] for s in cm if s not in pm]
    removed = [pm[s] for s in pm if s not in cm]
    up, down = [], []
    for s in cm:
        if s in pm:
            dw = round((cm[s].get("weight") or 0) - (pm[s].get("weight") or 0), 2)
            if dw >= WEIGHT_DELTA:
                # est_shares_delta = 新 est_shares - 舊 est_shares(同 ETF 規模下)
                eds = None
                ec = cm[s].get("est_shares"); ep = pm[s].get("est_shares")
                if ec is not None and ep is not None:
                    eds = round(ec - ep, 1)
                up.append({**cm[s], "dw": dw, **({"est_shares_delta": eds} if eds is not None else {})})
            elif dw <= -WEIGHT_DELTA:
                eds = None
                ec = cm[s].get("est_shares"); ep = pm[s].get("est_shares")
                if ec is not None and ep is not None:
                    eds = round(ec - ep, 1)
                down.append({**cm[s], "dw": dw, **({"est_shares_delta": eds} if eds is not None else {})})
    return {"added": added, "removed": removed, "weight_up": up, "weight_down": down}


def load_prev_tracking():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


# ── 主流程 ──────────────────────────────────────────────────────────────────
_PREMIUM_STATUS = "(未執行)"


def fetch_etf_premium():
    """抓證交所 mis.twse all_etf.txt:全市場 ETF 即時淨值與折溢價。回 {sym: premium_float}(正=溢價/負=折價)。
    欄位(官方介接格式 ver1.5):a=代號 e=成交價 f=預估淨值 g=預估折溢價幅度(%) h=前日淨值。取 g 欄。
    成敗原因寫進全域 _PREMIUM_STATUS,main 塞進 etf_tracking.json 方便直接從資料驗(免啃 log)。"""
    global _PREMIUM_STATUS
    out = {}
    url = "https://mis.twse.com.tw/stock/data/all_etf.txt"
    try:
        r = session.get(url, timeout=20, headers={
            "User-Agent": random.choice(_UA),
            "Referer": "https://mis.twse.com.tw/stock/various-areas/etf-price/indicator-disclosure-etf?lang=zhHant",
            "Accept": "application/json, text/plain, */*",
        })
        if r.status_code != 200:
            _PREMIUM_STATUS = f"mis.twse HTTP {r.status_code}(可能擋雲端IP)"
            print(f"  ⚠️ [折溢價] {_PREMIUM_STATUS}")
            return out
        j = r.json()
        arr = None
        if isinstance(j, list):
            arr = j
        elif isinstance(j, dict):
            for k in ("a1", "msgArray", "data", "aaData"):
                if isinstance(j.get(k), list):
                    arr = j[k]; break
            if arr is None:
                arr = next((v for v in j.values() if isinstance(v, list)), None)
        if arr is None:
            _PREMIUM_STATUS = f"結構不符(外層={list(j.keys())[:6] if isinstance(j,dict) else type(j).__name__})"
            print(f"  ⚠️ [折溢價] {_PREMIUM_STATUS}")
            return out
        for it in arr:
            if not isinstance(it, dict):
                continue
            sym = str(it.get("a", "")).strip()
            g = it.get("g")
            if sym and g not in (None, "", "-", "未結出"):
                f = _to_float(str(g).replace("%", "").replace(",", "").strip())
                if f is not None:
                    out[sym] = round(f, 2)
        if out:
            _PREMIUM_STATUS = f"命中 {len(out)} 檔(例:{list(out.items())[:3]})"
        else:
            sample = arr[0] if arr else None
            _PREMIUM_STATUS = f"命中0檔;arr長={len(arr)};首筆keys={list(sample.keys()) if isinstance(sample,dict) else sample}"
        print(f"  {'✓' if out else '⚠️'} [折溢價] {_PREMIUM_STATUS}")
    except Exception as e:
        _PREMIUM_STATUS = f"失敗 {type(e).__name__}: {str(e)[:120]}"
        print(f"  ⚠️ [折溢價] all_etf {_PREMIUM_STATUS}")
    return out


def main():
    prev = load_prev_tracking() or {}
    prev_hold = {e["symbol"]: e.get("holdings", []) for e in prev.get("etfs", [])}
    # 🆕 缺口8(12-4 主動靈活度):換股頻率 EWMA(decay 0.9)。日日換≈10、週換≈2,越高越常調整持股。
    prev_turnover = {e["symbol"]: (e.get("turnover_score") or 0) for e in prev.get("etfs", [])}
    today = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")

    actives = list_active_etfs()
    print(f"📋 主動式 ETF 候選 {len(actives)} 檔")

    ranked = []
    for s in actives:
        m = perf_with_tr(s, load_prices(s))   # V34.3 — 主動 ETF 也算含息(tr_120d/tr_20d),與被動同基礎可比
        if m:
            ranked.append((s, m))
    ranked.sort(key=lambda t: _rank_value(t[1]), reverse=True)
    top = ranked[:TOP_N]
    print(f"🏆 績效前段班取前 {len(top)} 檔")

    etfs, by_stock, hot = [], {}, {}
    got_holdings = 0
    price_cache = {}  # 個股最新 close 共用 cache(估算張數時避免重讀 JSON)
    for s, m in top:
        api_name, curr_h, fund_size, expense_ratio = fetch_etf_detail(s)
        # 估算每檔持股張數(必須在 diff 之前算,讓 diff 拿得到 est_shares 算 delta)
        if curr_h and fund_size:
            _attach_est_shares(curr_h, fund_size, price_cache)
        prev_h = prev_hold.get(s, [])
        if not curr_h:
            # 抓不到 → 沿用上一版持股，不誤判換股
            curr_h, changes, changed = prev_h, dict(EMPTY_CHANGES), False
        elif not prev_h:
            # 首次建立基準 → 不算換股
            changes, changed = dict(EMPTY_CHANGES), False
            got_holdings += 1
        else:
            changes = diff_holdings(prev_h, curr_h)
            changed = bool(changes["added"] or changes["removed"])
            got_holdings += 1

        # 🆕 缺口6(12-4 主動式空頭防禦):現金水位 ≈ 100% − Σ(全部成分股權重)。
        #    主動 ETF 經理人可提高現金避險 → 現金水位上升 = 轉守訊號。用「完整」curr_h(截斷前)算,
        #    權重覆蓋不足(<70%,多為 PCF 抓取不全)則回 None 不誤判成假高現金。
        _wsum = sum((h.get("weight") or 0) for h in curr_h)
        cash_ratio = round(max(0.0, 100.0 - _wsum), 1) if _wsum >= 70 else None
        # 🆕 缺口7:單一成分股集中度(用現成 curr_h[0],零額外網路)。>40% 前端標「集中度過高」。
        _t1 = curr_h[0] if curr_h else None
        top1 = {"sym": _t1.get("sym"), "name": _t1.get("name"), "weight": _t1.get("weight")} if _t1 else None
        # 🆕 缺口8:換股靈活度 EWMA(今日有換股 +1,舊值衰減 0.9)。
        turnover_score = round(prev_turnover.get(s, 0) * 0.9 + (1 if changed else 0), 2)

        etfs.append({
            "symbol": s,
            "name": api_name or etf_name(s),
            "perf": m,
            "fund_size": fund_size,
            "expense_ratio": expense_ratio,
            "cash_ratio": cash_ratio,
            "top1": top1,
            "category": etf_category(s),          # 🆕 缺口4
            "turnover_score": turnover_score,      # 🆕 缺口8
            "holdings": curr_h[:HOLD_TOP],
            "holdings_count": len(curr_h),
            "changes": changes,
            "changed_today": changed,
        })
        for h in curr_h:
            if h.get("sym"):
                by_stock.setdefault(h["sym"], []).append(s)
        for h in changes["added"]:
            if h.get("sym"):
                hot[h["sym"]] = hot.get(h["sym"], 0) + 1

    # V17.15 — per-stock 聚合:被多少檔 ETF 持有 + 持股變化合計 + 市值變化
    #         前端「個股加減碼」表格用,讓使用者一眼看出「N 檔同步加減碼」共識訊號
    consensus_stocks = []
    all_syms = set()
    for e in etfs:
        for h in (e.get("holdings") or []):
            if h.get("sym"):
                all_syms.add(h["sym"])

    for sym in all_syms:
        etfs_holding = [e for e in etfs if any(h.get("sym") == sym for h in (e.get("holdings") or []))]
        total_shares = 0
        stock_name = ""
        for e in etfs_holding:
            for h in (e.get("holdings") or []):
                if h.get("sym") == sym:
                    total_shares += int(h.get("est_shares", 0) or 0)
                    if not stock_name:
                        stock_name = h.get("name") or ""
        # 持股變化合計(從各 ETF changes 聚合)
        # V17.17 修 bug:added/removed 元素只有 est_shares 沒 est_shares_delta(那欄只在
        # diff_holdings 的 weight_up/down 才掛),原版 added/removed 永遠貢獻 0 → 改用 est_shares
        shares_delta = 0
        for e in etfs_holding:
            ch = e.get("changes", {}) or {}
            for ad in (ch.get("added") or []):
                if ad.get("sym") == sym:
                    shares_delta += int(ad.get("est_shares", 0) or 0)        # 新買進整批 +
            for wu in (ch.get("weight_up") or []):
                if wu.get("sym") == sym:
                    shares_delta += int(wu.get("est_shares_delta", 0) or 0)  # 加倉 delta
            for wd in (ch.get("weight_down") or []):
                if wd.get("sym") == sym:
                    shares_delta += int(wd.get("est_shares_delta", 0) or 0)  # 減倉 delta(負)
            for rm in (ch.get("removed") or []):
                if rm.get("sym") == sym:
                    shares_delta -= int(rm.get("est_shares", 0) or 0)        # 全清整批 -
        # 市值變化(億):shares_delta × 最新 close × 1000(張→股) / 1e8
        # V17.17 修 bug:load_prices 回傳 list[dict],原版 float(prices[-1]) 對 dict 會丟 TypeError
        prices = load_prices(sym)
        latest_close = 0
        if prices:
            last = prices[-1] if isinstance(prices[-1], dict) else None
            try:
                latest_close = float(last.get("close")) if last else 0
            except (TypeError, ValueError):
                latest_close = 0
        market_val_delta_e = round(shares_delta * latest_close * 1000 / 1e8, 2) if latest_close else 0
        consensus_stocks.append({
            "sym": sym,
            "name": stock_name,
            "etf_count": len(etfs_holding),
            "shares_delta": shares_delta,
            "market_val_delta_e": market_val_delta_e,
            "total_shares": total_shares,
        })

    # 預設按持股變化排序(降序),前端可二次排
    consensus_stocks.sort(key=lambda x: x["shares_delta"], reverse=True)

    # 🪙 V34.1 — 折溢價(best-effort TWSE;抓不到自動略過,前端 graceful)
    try:
        premiums = fetch_etf_premium()
        for _e in etfs:
            if _e.get("symbol") in premiums:
                _e["premium"] = premiums[_e["symbol"]]
    except Exception as _pe:
        premiums = {}
        print(f"  ⚠️ 折溢價附加失敗: {_pe}")

    # 🆕 缺口7(12-3):市值型 ETF 單一持股集中度對照(0050 集中 vs 00922/00923 等權重分散)。
    #   用既有 fetch_etf_detail(CI 有網路),抓不到就略過該檔(不誤判)。
    concentration = []
    for cs in CONC_WATCH:
        try:
            c_name, c_holds, _cfs, _cfee = fetch_etf_detail(cs)
            if not c_holds:
                continue
            c_holds.sort(key=lambda x: (x.get("weight") or 0), reverse=True)
            t1 = c_holds[0]
            top5w = round(sum((h.get("weight") or 0) for h in c_holds[:5]), 1)
            concentration.append({
                "symbol": cs,
                "name": c_name or etf_name(cs),
                "top1": {"sym": t1.get("sym"), "name": t1.get("name"), "weight": t1.get("weight")},
                "top5_weight": top5w,
                "holdings_count": len(c_holds),
            })
            print(f"  ✓ [集中度] {cs}: top1={t1.get('sym')} {t1.get('weight')}% / top5={top5w}%")
        except Exception as _ce:
            print(f"  ⚠️ [集中度] {cs}: {type(_ce).__name__}: {str(_ce)[:80]}")

    out = {
        "updated": today,
        "_premium_status": _PREMIUM_STATUS,
        "top_n": TOP_N,
        "concentration": concentration,
        "note": "主動式 ETF 2025/5 才上市，績效史短勿過度解讀；持股來自每日 PCF，"
                "顯示『—』代表該檔持股抓取尚在調校中。",
        "etfs": etfs,
        "cross_ref": {
            "by_stock": by_stock,
            "hot_adds": sorted(
                [{"sym": k, "count": v} for k, v in hot.items() if v >= 2],
                key=lambda x: -x["count"]),
        },
        "consensus_stocks": consensus_stocks[:200],   # V17.15 — 前 200 檔給前端
        "benchmarks": [
            {"symbol": b, "name": etf_name(b), "perf": perf_with_tr(b, load_prices(b)),
             "fill": dividend_fill_metrics(b),   # 🆕 缺口3:填息力(高息 ETF 硬指標)
             **({"premium": premiums[b]} if b in premiums else {})}
            for b in BENCHMARKS
        ],
    }
    Path(DATA_DIR).mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"✅ etf_tracking.json：前段班 {len(etfs)} 檔、持股抓到 {got_holdings} 檔、"
          f"換股 {sum(1 for e in etfs if e['changed_today'])} 檔")


if __name__ == "__main__":
    main()
