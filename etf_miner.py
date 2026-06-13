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
from pathlib import Path
from datetime import datetime, timezone, timedelta

import requests

DATA_DIR = "data"
OUT = Path(DATA_DIR) / "etf_tracking.json"

TOP_N = 10            # 前段班檔數
HOLD_TOP = 15         # 每檔顯示前幾大持股
PERF_LOOKBACK = 120   # 績效回看交易日(近似半年)
MIN_HISTORY = 15      # 最少價格筆數才納入排名(主動 ETF 2025/5 才上市)
WEIGHT_DELTA = 0.3    # 加減碼判定門檻(權重變動 %)

# 被動式基準(當對照組，不參與「主動前段班」排名)
BENCHMARKS = ["0050", "0056", "00878"]

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

# 中文名對照(已知者填入；未知顯示代碼，上雲迭代時補)
ETF_NAMES = {
    "0050": "元大台灣50", "0056": "元大高股息", "00878": "國泰永續高股息",
    "00981A": "主動統一台股增長", "00982A": "主動群益台灣強棒",
    "00984A": "主動安聯台灣高息", "00988A": "主動中信ARK創新",
    "00992A": "主動群益台灣科技創新", "00980A": "主動野村臺灣智慧優選",
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


def _rank_value(m):
    v = m.get("ret_120d")
    return v if v is not None else (m.get("ret_incep") if m.get("ret_incep") is not None else -9999)


# ── 持股抓取(Tier 2，best-effort、容錯；上雲後依 log 迭代解析器) ──────────────
def fetch_holdings(sym):
    """回傳 [{'sym','name','weight'}...]，依市值/權重排序；任何失敗回 []。"""
    for src in (_holdings_twse, _holdings_issuer):
        try:
            h = src(sym)
            if h:
                h.sort(key=lambda x: (x.get("weight") or 0), reverse=True)
                return h
        except Exception as e:
            print(f"  ⚠️ holdings {sym} via {src.__name__}: {e}")
    return []


def _holdings_twse(sym):
    """best-effort TWSE/集保 每日 PCF。佔位實作，上雲後用真實回應修正欄位對應。"""
    return []


# 投信代碼前綴 → PCF 來源(上雲後逐家補正)
_ISSUER_PCF = {
    # 'capitalfund': 'https://www.capitalfund.com.tw/.../portfolio?fund=...',
}


def _holdings_issuer(sym):
    """best-effort 逐家投信 PCF。佔位實作，上雲後依各家真實 JSON/HTML 補解析。"""
    return []


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
                up.append({**cm[s], "dw": dw})
            elif dw <= -WEIGHT_DELTA:
                down.append({**cm[s], "dw": dw})
    return {"added": added, "removed": removed, "weight_up": up, "weight_down": down}


def load_prev_tracking():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


# ── 主流程 ──────────────────────────────────────────────────────────────────
def main():
    prev = load_prev_tracking() or {}
    prev_hold = {e["symbol"]: e.get("holdings", []) for e in prev.get("etfs", [])}
    today = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")

    actives = list_active_etfs()
    print(f"📋 主動式 ETF 候選 {len(actives)} 檔")

    ranked = []
    for s in actives:
        m = perf_metrics(load_prices(s))
        if m:
            ranked.append((s, m))
    ranked.sort(key=lambda t: _rank_value(t[1]), reverse=True)
    top = ranked[:TOP_N]
    print(f"🏆 績效前段班取前 {len(top)} 檔")

    etfs, by_stock, hot = [], {}, {}
    got_holdings = 0
    for s, m in top:
        curr_h = fetch_holdings(s)
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

        etfs.append({
            "symbol": s,
            "name": etf_name(s),
            "perf": m,
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

    out = {
        "updated": today,
        "top_n": TOP_N,
        "note": "主動式 ETF 2025/5 才上市，績效史短勿過度解讀；持股來自每日 PCF，"
                "顯示『—』代表該檔持股抓取尚在調校中。",
        "etfs": etfs,
        "cross_ref": {
            "by_stock": by_stock,
            "hot_adds": sorted(
                [{"sym": k, "count": v} for k, v in hot.items() if v >= 2],
                key=lambda x: -x["count"]),
        },
        "benchmarks": [
            {"symbol": b, "name": etf_name(b), "perf": perf_metrics(load_prices(b))}
            for b in BENCHMARKS
        ],
    }
    Path(DATA_DIR).mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"✅ etf_tracking.json：前段班 {len(etfs)} 檔、持股抓到 {got_holdings} 檔、"
          f"換股 {sum(1 for e in etfs if e['changed_today'])} 檔")


if __name__ == "__main__":
    main()
