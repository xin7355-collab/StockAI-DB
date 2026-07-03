#!/usr/bin/env python3
"""💎 長線潛力股採礦(Tier B — 全市場)

把前端「_calcPotentialScore」7 因子純公式(禁 AI 算數)搬到 Python,
對 data/*.json(全市場 OHLCV+法人)一次算完,輸出 data/potential_picks.json。
前端 💎 潛力頁優先讀這份(快、涵蓋 ~700-1800 檔),沒有才退回前端掃清單。

因子:①位階低 ②估值便宜 ③成長轉機 ④籌碼默默吸 ⑤技術打底翻揚 ⑥題材主流 ⑦翻倍空間 - 風控扣分

資料源(皆為既有採礦檔):
- data/{sym}.json           每檔 OHLCV+法人+融資(array of bars)
- data/fundamentals_cache.json  {sym:{pe,yield_rate,rev_yoy?,gross_margin?}}
- data/industry_pe.json     {industries:{code:{median_pe}}}
- data/industry_map.json    {sym: industry_code}
- data/concept_stocks.json  {by_stock:{sym:[concepts]}}
- data/attention_status.json 處置/注意(風控扣分,選讀)
"""
import re
import json
import math
from pathlib import Path
from datetime import datetime, timezone, timedelta

DATA = Path(__file__).parent / "data"
TPE = timezone(timedelta(hours=8))
TOP_N = 250

HOT_THEMES = ['AI', 'CoWoS', '矽光子', '記憶體', 'HBM', '重電', '軍工', '低軌衛星', '散熱', 'ABF',
              'PCB', '機器人', '矽智財', '光通訊', '先進封裝', '半導體', '電動車', '工業4.0', '5G', '伺服器', '光學']

# 非個股 json(掃描時跳過)
SKIP = ('broker_names', 'radar', 'top_picks', 'macro_risk', 'bubble_warning', 'attention_',
        'futures_cache', 'margin_cache', 'signal_history', 'strategy_backtest', 'paper_trades',
        'sector_heat', 'walk_forward', 'tier_backtest', 'etf_tracking', 'radar_news', 'radar_matrix',
        'global_news', 'fundamentals_cache', 'industry_pe', 'industry_map', 'concept_stocks',
        'market_stats', 'miner_status', 'delisted', 'risk_history', 'potential_picks', 'chief_ai')


def load(name, default=None):
    f = DATA / name
    if not f.exists():
        return default
    try:
        return json.loads(f.read_text(encoding='utf-8'))
    except Exception as e:
        print(f"   ⚠️ {name} parse 失敗:{e}")
        return default


def avg(a):
    return sum(a) / len(a) if a else 0.0


def score_stock(sym, bars, fund, median_pe, concepts, att):
    try:
        closes = [float(b.get('close') or 0) for b in bars]
        highs = [float(b.get('high') or 0) for b in bars]
        lows = [float(b.get('low') or 0) for b in bars]
        vols = [float(b.get('volume') or 0) for b in bars]
        n = len(closes)
        if n < 60:
            return None
        price = closes[-1]
        if price <= 0:
            return None

        def ma(k, i):
            s = closes[i - k + 1:i + 1]
            return avg(s) if len(s) == k else None

        # ① 位階低(0-20)
        look = min(250, n)
        win_hi = max([v for v in highs[-look:] if v > 0] or [price])
        win_lo = min([v for v in lows[-look:] if v > 0] or [price])
        pos52 = (price - win_lo) / (win_hi - win_lo) if win_hi > win_lo else 0.5
        f1 = 20 if pos52 <= 0.15 else 17 if pos52 <= 0.25 else 13 if pos52 <= 0.40 else 8 if pos52 <= 0.55 else 4 if pos52 <= 0.70 else 0

        # ② 估值便宜(0-15)
        f2 = 0
        pe = fund.get('pe') if fund else None
        yld = fund.get('yield_rate') if fund else None
        pe = float(pe) if isinstance(pe, (int, float)) else None
        yld = float(yld) if isinstance(yld, (int, float)) else None
        if pe is not None and pe > 0:
            if median_pe and median_pe > 0:
                r = pe / median_pe
                f2 += 8 if r <= 0.6 else 6 if r <= 0.8 else 4 if r <= 1.0 else 2 if r <= 1.3 else 0
            else:
                f2 += 7 if pe <= 10 else 5 if pe <= 15 else 3 if pe <= 20 else 0
        if yld is not None:
            f2 += 7 if yld >= 6 else 5 if yld >= 4 else 3 if yld >= 2.5 else 0
        f2 = min(15, f2)

        # ③ 成長轉機(0-20)
        f3 = 0
        yoy = fund.get('rev_yoy') if fund else None
        yoy = float(yoy) if isinstance(yoy, (int, float)) else None
        gm = fund.get('gross_margin') if fund else None
        gm = float(gm) if isinstance(gm, (int, float)) else None
        if yoy is not None:
            f3 += 14 if yoy >= 30 else 10 if yoy >= 15 else 7 if yoy >= 5 else 3 if yoy >= 0 else 0
        if gm is not None:
            f3 += 6 if gm >= 40 else 4 if gm >= 25 else 2 if gm >= 15 else 0
        f3 = min(20, f3)

        # ④ 籌碼默默吸(0-15)
        last20 = bars[-20:]
        inst_lots = sum((float(b.get('foreign_net') or 0) + float(b.get('trust_net') or 0)) for b in last20) / 1000.0
        base = closes[max(0, n - 21)]
        chg20 = (price / base - 1) if base > 0 else 0
        f4 = 0
        if inst_lots > 0:
            f4 += 7 if inst_lots >= 3000 else 5 if inst_lots >= 800 else 3 if inst_lots >= 100 else 1
        if inst_lots > 0 and chg20 < 0.10:
            f4 += 4
        v5, v60 = avg(vols[-5:]), avg(vols[-60:])
        if v60 > 0 and v5 / v60 < 0.9:
            f4 += 4
        f4 = min(15, f4)

        # ⑤ 技術打底翻揚(0-15)
        ma20n, ma20p, ma60n, ma60p = ma(20, n - 1), ma(20, n - 6), ma(60, n - 1), ma(60, n - 6)
        f5 = 0
        if ma20n and ma20p:
            f5 += 5 if ma20n > ma20p else 3 if ma20n >= ma20p * 0.997 else 0
        if ma60n and price > ma60n:
            f5 += 4
        if ma60n and ma60p and ma60n >= ma60p:
            f5 += 2
        lo_r = min([v for v in lows[-30:] if v > 0] or [0])
        lo_p = min([v for v in lows[-60:-30] if v > 0] or [0])
        if lo_r > 0 and lo_p > 0 and lo_r > lo_p:
            f5 += 4
        f5 = min(15, f5)

        # ⑥ 題材主流(0-10)
        conc = concepts or []
        hits = [c for c in conc if any(t in str(c) for t in HOT_THEMES)]
        f6 = (10 if len(hits) >= 2 else 7 if len(hits) == 1 else 4) if conc else 0

        # ⑦ 翻倍空間(0-5)
        hi5 = max([v for v in highs if v > 0] or [price])
        upside = (hi5 - price) / price if hi5 > price else 0
        f7 = 5 if upside >= 1.0 else 4 if upside >= 0.5 else 3 if upside >= 0.3 else 2 if upside >= 0.15 else 1 if upside > 0 else 0

        # 風控扣分 + 🚩
        risk = []
        st = (att or {}).get('status', '') if att else ''
        if st.startswith('🚨'):
            risk.append('🚩處置中')
        elif '注意' in st:
            risk.append('🚩注意股')
        if pe is not None and pe > 60:
            risk.append('🚩本益比偏高')
        mb = [float(b.get('margin_balance') or 0) for b in bars]
        if len(mb) >= 6 and mb[-6] > 0 and (mb[-1] - mb[-6]) / mb[-6] > 0.3:
            risk.append('🚩融資爆增')
        penalty = min(15, len(risk) * 6)
        score = max(0, round(f1 + f2 + f3 + f4 + f5 + f6 + f7 - penalty))

        tags = []
        if f1 >= 13 and upside >= 0.5:
            tags.append('lowbase')
        if f2 >= 8 and f3 >= 9:
            tags.append('valgrow')
        if f4 >= 9:
            tags.append('chips')
        if f5 >= 9:
            tags.append('tech')
        if yld is not None and yld >= 4:
            tags.append('yield')

        prev_low = lo_p if lo_p > 0 else (lo_r if lo_r > 0 else price * 0.9)
        entry = min(price, max(ma60n, prev_low)) if ma60n else prev_low
        plan = {"entry": round(entry, 1), "add": round(prev_low, 1), "stop": round(prev_low * 0.95, 1)}

        bits = []
        if f1 >= 13:
            bits.append(f"位階僅 {round(pos52 * 100)}%(低基期)")
        if f4 >= 9:
            bits.append(f"法人默默買 {round(inst_lots)} 張" if inst_lots > 0 else "籌碼沉澱")
        if f5 >= 9:
            bits.append("技術剛打底翻揚")
        if f2 >= 8:
            bits.append(f"PE {pe:.0f} 偏便宜" if pe is not None else "估值便宜")
        if f3 >= 9:
            bits.append(f"營收 YoY +{yoy:.0f}%" if yoy is not None else "成長轉機")
        if f6 >= 7:
            bits.append("搭主流題材")
        if upside >= 0.5:
            bits.append(f"距 5 年高還有 +{round(upside * 100)}% 空間")
        reason = "、".join(bits[:3]) or "各因子中庸,綜合觀察"

        # 🎯 估值目標價(純公式):年化EPS(≈price/PE) × 產業中位PE = price × median_pe/pe
        val_target = round(price * median_pe / pe, 1) if (pe is not None and pe > 0 and median_pe and median_pe > 0) else None

        return {
            "sym": sym, "score": score, "valTarget": val_target,
            "f": {"f1": f1, "f2": f2, "f3": f3, "f4": f4, "f5": f5, "f6": f6, "f7": f7},
            "pos52": round(pos52, 3), "upside": round(upside, 3), "instLots": round(inst_lots),
            "pe": round(pe, 2) if pe is not None else None,
            "yld": round(yld, 2) if yld is not None else None,
            "yoy": round(yoy, 1) if yoy is not None else None,
            "conc": conc[:4], "tags": tags, "price": round(price, 2),
            "plan": plan, "riskFlags": risk, "reason": reason,
        }
    except Exception as e:
        print(f"   ⚠️ {sym} 評分失敗:{e}")
        return None


def main():
    print(f"💎 potential_miner 啟動 {datetime.now(TPE).isoformat(timespec='seconds')}")
    fund_all = load("fundamentals_cache.json", {}) or {}
    ind_pe = (load("industry_pe.json", {}) or {}).get("industries", {}) or {}
    ind_map = load("industry_map.json", {}) or {}
    concept = (load("concept_stocks.json", {}) or {}).get("by_stock", {}) or {}
    att_all = (load("attention_status.json", {}) or {}).get("stocks", {}) or {}

    rows = []
    scanned = 0
    for f in sorted(DATA.glob("*.json")):
        stem = f.stem
        if not re.fullmatch(r"\d{4}", stem):
            continue
        if any(s in stem for s in SKIP) or stem.startswith("00"):   # 跳 ETF(00 開頭)+ 非個股
            continue
        try:
            bars = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(bars, list) or len(bars) < 60:
            continue
        scanned += 1
        code = ind_map.get(stem)
        median_pe = (ind_pe.get(code, {}) or {}).get("median_pe") if code else None
        r = score_stock(stem, bars, fund_all.get(stem), median_pe, concept.get(stem), att_all.get(stem))
        if r:
            rows.append(r)

    rows.sort(key=lambda x: -x["score"])
    top = rows[:TOP_N]
    payload = {
        "updated": datetime.now(TPE).isoformat(timespec="seconds"),
        "source": "potential_miner",
        "scanned": scanned,
        "count": len(top),
        "rows": top,
    }
    out = DATA / "potential_picks.json"
    DATA.mkdir(exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"✅ 掃描 {scanned} 檔 → 潛力榜前 {len(top)} 檔  ({out.stat().st_size} bytes)")
    for r in top[:10]:
        print(f"   {r['sym']} 分{r['score']} 位階{round(r['pos52']*100)}% 上檔+{round(r['upside']*100)}% tags={r['tags']}")


if __name__ == "__main__":
    main()
