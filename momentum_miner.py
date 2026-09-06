#!/usr/bin/env python3
"""🐎 中線黑馬採礦(Tier B — 全市場)

把前端「_calcMomentumScore」6 因子純公式(禁 AI 算數)搬到 Python,
對 data/*.json(全市場 OHLCV+法人)一次算完,輸出 data/momentum_picks.json。
前端 🐎 中線黑馬(潛力頁模式切換)優先讀這份。

邏輯(逐字稿:全面漲價→獲利跳→法人評價跳→主升段):
①主升段技術(已啟動) ②獲利跳(YoY/毛利) ③法人卡位 ④中位階 ⑤漲價族群 ⑥量增表態 - 風控

資料源(皆既有採礦檔):
- data/{sym}.json           OHLCV+法人+融資(array of bars)
- data/fundamentals_cache.json / fundamentals_rotation.json  {sym:{pe,yield_rate,rev_yoy?,gross_margin?}}
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

from common import avg, is_finite_num   # 🧩 共用工具(單一真相來源,見 common.py)

DATA = Path(__file__).parent / "data"
TPE = timezone(timedelta(hours=8))
TOP_N = 250

# 🐎 漲價循環族群(與 index.html _hotPriceThemes 同步)
HOT_PRICE_THEMES = ['漲價', '被動元件', 'MLCC', '電容', '電阻', '記憶體', 'DRAM', 'HBM', 'NAND', '矽晶圓',
                    '晶圓', '面板', '導線架', '銅箔基板', 'ABF', '散熱', '矽智財', 'CoWoS', '先進封裝',
                    '伺服器', 'AI', '矽光子', '光通訊', '重電', '軍工']

SKIP = ('broker_names', 'radar', 'top_picks', 'macro_risk', 'bubble_warning', 'attention_',
        'futures_cache', 'margin_cache', 'signal_history', 'strategy_backtest', 'paper_trades',
        'sector_heat', 'walk_forward', 'tier_backtest', 'etf_tracking', 'radar_news', 'radar_matrix',
        'global_news', 'fundamentals_cache', 'fundamentals_rotation', 'industry_pe', 'industry_map',
        'concept_stocks', 'market_stats', 'miner_status', 'delisted', 'risk_history', 'potential_picks',
        'momentum_picks', 'chief_ai')


def load(name, default=None):
    f = DATA / name
    if not f.exists():
        return default
    try:
        return json.loads(f.read_text(encoding='utf-8'))
    except Exception as e:
        print(f"   ⚠️ {name} parse 失敗:{e}")
        return default


def score_stock(sym, bars, fund, median_pe, concepts, att):
    try:
        fund = fund or {}
        closes = [float(b.get('close') or 0) for b in bars]
        highs = [float(b.get('high') or 0) for b in bars]
        lows = [float(b.get('low') or 0) for b in bars]
        opens = [float(b.get('open') or 0) for b in bars]
        vols = [float(b.get('volume') or 0) for b in bars]
        n = len(closes)
        if n < 60:
            return None
        price = closes[-1]
        if price <= 0:
            return None

        def ma(k, i):
            s = closes[i - k + 1:i + 1]
            if len(s) != k:
                return None
            r = avg(s)
            # 🛡️ 視窗含 NaN/±Inf 會讓均線變非有限值 → 回 None(呼叫端已用 is not None 判斷)
            return r if is_finite_num(r) else None

        def inst(b):
            return float(b.get('foreign_net') or 0) + float(b.get('trust_net') or 0)

        ma5 = ma(5, n - 1); ma10 = ma(10, n - 1)
        ma20n = ma(20, n - 1); ma20p = ma(20, n - 6); ma60n = ma(60, n - 1)

        # ① 主升段技術(0-30)
        ma_bull = (ma5 is not None and ma10 is not None and ma20n is not None and ma60n is not None
                   and ma5 >= ma10 >= ma20n >= ma60n)
        ma20_up = ma20n is not None and ma20p is not None and ma20n >= ma20p
        above_ma60 = ma60n is not None and price > ma60n
        win = min(60, n - 1); frm = n - 1 - win
        path = sum(abs(closes[j] - closes[j - 1]) for j in range(frm + 1, n))
        eff = abs(closes[n - 1] - closes[frm]) / path if path > 0 else 0.0
        prior_his = [v for v in highs[-21:-1] if v > 0]
        prig_hi = max(prior_his) if prior_his else 0
        o1 = opens[-1]
        body = (price - o1) / o1 * 100 if o1 > 0 else 0
        breakout = prig_hi > 0 and price > prig_hi and body >= 1.5
        m1 = 0
        if ma_bull:
            m1 += 10
        elif ma20n is not None and ma60n is not None and price > ma20n and price > ma60n:
            m1 += 5
        if ma20_up:
            m1 += 4
        if above_ma60:
            m1 += 4
        m1 += 8 if eff >= 0.35 else 5 if eff >= 0.25 else 2 if eff >= 0.18 else 0
        if breakout:
            m1 += 4
        m1 = min(30, m1)

        # ② 獲利跳(0-25)
        yoy = fund.get('rev_yoy', fund.get('revenue_yoy'))
        yoy = float(yoy) if isinstance(yoy, (int, float)) else None
        gm = fund.get('gross_margin')
        gm = float(gm) if isinstance(gm, (int, float)) else None
        m2 = 0
        if yoy is not None:
            m2 += 12 if yoy >= 30 else 9 if yoy >= 15 else 6 if yoy >= 5 else 2 if yoy >= 0 else 0
        if gm is not None:
            m2 += 7 if gm >= 40 else 5 if gm >= 25 else 2 if gm >= 15 else 0
        gmt = fund.get('gross_margin_trend') if isinstance(fund.get('gross_margin_trend'), str) else ''
        if '↑' in gmt:
            m2 += 6
        m2 = min(25, m2)

        # ③ 法人卡位(0-20)
        last20 = bars[-20:]; last10 = bars[-10:]
        inst_lots = sum(inst(b) for b in last20) / 1000.0
        inst_days10 = sum(1 for b in last10 if inst(b) > 0)
        i5 = sum(inst(b) for b in bars[-5:]); i5p = sum(inst(b) for b in bars[-10:-5])
        m3 = 0
        if inst_lots > 0:
            m3 += 10 if inst_lots >= 3000 else 7 if inst_lots >= 800 else 4 if inst_lots >= 100 else 1
        m3 += 5 if inst_days10 >= 6 else 3 if inst_days10 >= 4 else 0
        if i5 > 0 and i5 > i5p:
            m3 += 5
        m3 = min(20, m3)

        # ④ 中位階(0-10)
        look = min(250, n)
        win_hi = max([v for v in highs[-look:] if v > 0] or [price])
        win_lo = min([v for v in lows[-look:] if v > 0] or [price])
        pos52 = (price - win_lo) / (win_hi - win_lo) if win_hi > win_lo else 0.5
        m4 = 10 if 0.30 <= pos52 <= 0.65 else 6 if 0.20 <= pos52 <= 0.80 else 2

        # ⑤ 漲價族群(0-10)
        conc = concepts or []
        hits = [c for c in conc if any(t in str(c) for t in HOT_PRICE_THEMES)]
        m5 = (10 if len(hits) >= 2 else 6 if len(hits) == 1 else 2) if conc else 0

        # ⑥ 量增表態(0-5)
        v5, v60 = avg(vols[-5:]), avg(vols[-60:])
        m6 = 5 if (v60 > 0 and v5 / v60 >= 1.5) else 3 if (v60 > 0 and v5 / v60 >= 1.1) else 0

        hi5 = max([v for v in highs if v > 0] or [price])
        upside = (hi5 - price) / price if hi5 > price else 0
        bias_ma20 = (price - ma20n) / ma20n * 100 if (ma20n and ma20n > 0) else 0

        # 風控
        risk = []
        st = (att or {}).get('status', '') if att else ''
        if st.startswith('🚨'):
            risk.append('🚩處置中')
        elif '注意' in st:
            risk.append('🚩注意股')
        if pos52 >= 0.92 and bias_ma20 >= 18:
            risk.append('🚩末升段過熱')
        pe = fund.get('pe')
        pe = float(pe) if isinstance(pe, (int, float)) else None
        yld = fund.get('yield_rate')
        yld = float(yld) if isinstance(yld, (int, float)) else None
        if pe is not None and pe > 80:
            risk.append('🚩本益比過高')
        penalty = min(18, len(risk) * 6)
        score = max(0, round(m1 + m2 + m3 + m4 + m5 + m6 - penalty))

        # 階段
        if pos52 >= 0.92 and bias_ma20 >= 18:
            stage = '⚠️末升段'
        elif ma_bull and eff >= 0.30:
            stage = '🔥主升段'
        elif breakout or (above_ma60 and ma20_up and pos52 <= 0.55):
            stage = '🚀初升段'
        elif eff < 0.22:
            stage = '🟡盤整'
        else:
            stage = '⚪中性'

        tags = []
        if m1 >= 22:
            tags.append('mainrise')
        if breakout or (above_ma60 and ma20_up and pos52 <= 0.55):
            tags.append('launch')
        if m2 >= 15:
            tags.append('fuel')
        if m3 >= 10:
            tags.append('inst')
        if m5 >= 6:
            tags.append('hotprice')

        lo_p = min([v for v in lows[-30:] if v > 0] or [0])
        prev_low = lo_p if lo_p > 0 else price * 0.93
        entry = min(price, max(ma60n, prev_low)) if ma60n else prev_low
        plan = {"entry": round(entry, 1), "add": round(prev_low, 1), "stop": round(prev_low * 0.95, 1)}

        bits = []
        if stage == '🔥主升段':
            bits.append('主升段進行中(順勢抱)')
        elif stage == '🚀初升段':
            bits.append('初升段剛啟動')
        if yoy is not None and yoy >= 15:
            bits.append(f"營收YoY +{yoy:.0f}%")
        if '↑' in gmt:
            bits.append('毛利向上(獲利跳)')
        if m3 >= 10:
            bits.append(f"法人買超 {round(inst_lots)} 張" if inst_lots > 0 else '法人卡位')
        if m5 >= 6:
            bits.append('搭漲價族群')
        if eff >= 0.30:
            bits.append(f"趨勢效率 {round(eff * 100)}%")
        reason = "、".join(bits[:3]) or "中線動能中庸,綜合觀察"

        val_target = round(price * median_pe / pe, 1) if (pe is not None and pe > 0 and median_pe and median_pe > 0) else None

        return {
            "sym": sym, "score": score, "stage": stage, "valTarget": val_target,
            "f": {"f1": m1, "f2": m2, "f3": m3, "f4": m4, "f5": m5, "f6": m6, "f7": 0},
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
    print(f"🐎 momentum_miner 啟動 {datetime.now(TPE).isoformat(timespec='seconds')}")
    # 合併 daily + 輪動基本面(輪動當底、daily 覆蓋在上)
    fund_all = {}
    _rot = load("fundamentals_rotation.json", {}) or {}
    for k, v in _rot.items():
        if not str(k).startswith("__") and isinstance(v, dict):
            fund_all[k] = dict(v)
    _daily = load("fundamentals_cache.json", {}) or {}
    for k, v in _daily.items():
        if not str(k).startswith("__") and isinstance(v, dict):
            fund_all[k] = {**fund_all.get(k, {}), **v}

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
        if any(s in stem for s in SKIP) or stem.startswith("00"):
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
        "source": "momentum_miner",
        "scanned": scanned,
        "count": len(top),
        "rows": top,
    }
    # 🛡️ V69.8.4 P0-8 鐵律守門:掃到 0-9 檔=上游 K 線資料不完整,不寫檔保留舊榜
    if len(top) < 10:
        print(f"❌ 中線黑馬只掃到 {len(top)} 檔(<10,疑似上游資料不完整)→ 不寫檔,保留舊榜")
        return
    out = DATA / "momentum_picks.json"
    DATA.mkdir(exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"✅ 掃描 {scanned} 檔 → 中線黑馬榜前 {len(top)} 檔  ({out.stat().st_size} bytes)")
    for r in top[:10]:
        print(f"   {r['sym']} 分{r['score']} {r['stage']} 位階{round(r['pos52']*100)}% tags={r['tags']}")


if __name__ == "__main__":
    main()
