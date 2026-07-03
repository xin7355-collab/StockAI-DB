#!/usr/bin/env python3
"""🔄 全市場基本面「時間輪動」採礦(Tier B 補強)

痛點:FinMind 免費版「不帶 data_id 的 bulk 財報/營收 = 回 0 筆」,只有觀察清單 ~100 檔
有 rev_yoy/gross_margin → 冷門股的成長因子(f3)恆缺、潛力分卡在 ~64、估值目標價也缺 PE。

解法:每小時 cron 跑一支,每次抓「下一批 N 檔」的**單檔**財報(免費版單檔抓得到),
把 pe / yield_rate / rev_yoy / gross_margin 併進 data/fundamentals_rotation.json(自己的累積檔),
游標滾動,全市場 ~2000 檔約 14 小時輪完一圈,之後持續刷新。

⚠️ 鐵律對齊:
- 只寫**自己的** fundamentals_rotation.json(additive),絕不動 daily_miner 的 fundamentals_cache.json
  → daily_miner orphan force-push 不會蓋掉(前端/potential_miner 讀取時「兩份合併」)。
- 分點(TaiwanStockTradingDailyReport)= 付費牆 402,本檔**不碰**。
- OHLCV+法人 daily_miner 已 bulk,本檔**不碰**。
"""
import os
import re
import json
import time
import random
from pathlib import Path
from datetime import date, datetime, timezone, timedelta

import requests

DATA = Path(__file__).parent / "data"
TPE = timezone(timedelta(hours=8))
BATCH_N = int(os.getenv("ROTATION_BATCH_N", "150"))
OUT = DATA / "fundamentals_rotation.json"

# 非個股 json(建 universe 時跳過)
SKIP = ('broker_names', 'radar', 'top_picks', 'macro_risk', 'bubble_warning', 'attention_',
        'futures_cache', 'margin_cache', 'signal_history', 'strategy_backtest', 'paper_trades',
        'sector_heat', 'walk_forward', 'tier_backtest', 'etf_tracking', 'radar_news', 'radar_matrix',
        'global_news', 'fundamentals_cache', 'fundamentals_rotation', 'industry_pe', 'industry_map',
        'concept_stocks', 'market_stats', 'miner_status', 'delisted', 'risk_history',
        'potential_picks', 'chief_ai')

# ── FinMind Token 輪動(self-contained,對齊 miner.py 精神)─────────────────
_fm_env = os.getenv('FINMIND_TOKENS') or os.getenv('FINMIND_TOKEN', '')
TOKENS = [t.strip() for t in _fm_env.split(',') if t.strip()]
_tok_idx = 0
_BLOCKED = False
_session = requests.Session()

_UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
]


def _hdrs():
    return {'User-Agent': random.choice(_UAS), 'Accept': 'application/json'}


def fm_request(url_base: str, timeout: int = 20):
    """帶 token 輪動的 FinMind GET;429/5xx 換 token 重試,全試過回 None。"""
    global _tok_idx, _BLOCKED
    if _BLOCKED:
        return None
    tried = set()
    while True:
        tok = TOKENS[_tok_idx % len(TOKENS)] if TOKENS else ''
        token_param = f'&token={tok}' if tok else ''
        try:
            res = _session.get(url_base + token_param, headers=_hdrs(), timeout=timeout)
        except Exception as e:
            print(f'  ⚠️ [fm_request] 連線失敗: {e}')
            return None
        if res.status_code in (429, 500, 502, 503, 504):
            if not TOKENS:
                return None
            tried.add(_tok_idx % len(TOKENS))
            _tok_idx = (_tok_idx + 1) % len(TOKENS)
            if len(tried) >= len(TOKENS):
                _BLOCKED = True
                print(f'  🚫 所有 {len(TOKENS)} 組 Token 耗盡,斷路器啟動')
                return None
            time.sleep(1.0)
            continue
        try:
            return res.json()
        except Exception:
            return None


def _flt(v):
    try:
        return float(v) if v not in (None, '', '-') else None
    except Exception:
        return None


def fetch_one(sym: str) -> dict:
    """單檔:pe / yield_rate(PER) + gross_margin(FS) + rev_yoy(MonthRevenue)"""
    today = date.today().strftime('%Y-%m-%d')
    out = {}

    # ① PER → pe / yield_rate
    d14 = (date.today() - timedelta(days=14)).strftime('%Y-%m-%d')
    j = fm_request(f'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPER'
                   f'&data_id={sym}&start_date={d14}&end_date={today}', timeout=15) or {}
    rows = j.get('data') or []
    if rows:
        last = sorted(rows, key=lambda x: x.get('date', ''))[-1]
        pe = _flt(last.get('PER'))
        yr = _flt(last.get('dividend_yield'))
        if pe is not None and pe > 0:
            out['pe'] = round(pe, 2)
        if yr is not None:
            out['yield_rate'] = round(yr, 2)

    # ② 財報 → gross_margin(最新共同季 GrossProfit/Revenue)
    d1095 = (date.today() - timedelta(days=1095)).strftime('%Y-%m-%d')
    j = fm_request(f'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements'
                   f'&data_id={sym}&start_date={d1095}&end_date={today}', timeout=20) or {}
    rows = j.get('data') or []
    if rows:
        rev_by_q = {r['date']: _flt(r.get('value')) for r in rows if r.get('type') == 'Revenue'}
        gp_by_q = {r['date']: _flt(r.get('value')) for r in rows if r.get('type') == 'GrossProfit'}
        common = sorted(q for q in (set(rev_by_q) & set(gp_by_q))
                        if rev_by_q.get(q) and rev_by_q[q] > 0 and gp_by_q.get(q) is not None)
        if common:
            q = common[-1]
            out['gross_margin'] = round(gp_by_q[q] / rev_by_q[q] * 100, 1)

    # ③ 月營收 → rev_yoy
    d730 = (date.today() - timedelta(days=730)).strftime('%Y-%m-%d')
    j = fm_request(f'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue'
                   f'&data_id={sym}&start_date={d730}&end_date={today}', timeout=20) or {}
    rows = sorted(j.get('data') or [], key=lambda x: x.get('date', ''))
    if rows:
        latest = rows[-1]
        yoy = latest.get('revenue_year_growth')
        yoy = _flt(yoy)
        if yoy is None:   # FinMind 沒給就回推去年同月
            try:
                lm = int(latest.get('revenue_month') or 0)
                ly = int(latest.get('revenue_year') or 0)
                cur = _flt(latest.get('revenue')) or 0
                if lm and ly and cur > 0:
                    for r in rows[:-1]:
                        if int(r.get('revenue_month') or 0) == lm and int(r.get('revenue_year') or 0) == ly - 1:
                            prev = _flt(r.get('revenue')) or 0
                            if prev > 0:
                                yoy = (cur - prev) / prev * 100
                            break
            except Exception:
                pass
        if yoy is not None:
            out['rev_yoy'] = round(yoy, 1)

    return out


def main():
    print(f"🔄 rotation_miner 啟動 {datetime.now(TPE).isoformat(timespec='seconds')} ・ batch={BATCH_N} ・ tokens={len(TOKENS)}")

    # universe = data 分支全市場個股(4 碼、非 ETF)
    universe = []
    for f in DATA.glob("*.json"):
        stem = f.stem
        if not re.fullmatch(r"\d{4}", stem):
            continue
        if any(s in stem for s in SKIP) or stem.startswith("00"):
            continue
        universe.append(stem)
    universe.sort(key=lambda s: int(s))
    if not universe:
        print("❌ universe 為空(data/ 沒抓到個股 json),中止")
        return
    N = len(universe)

    # 讀既有累積檔
    acc = {}
    if OUT.exists():
        try:
            acc = json.loads(OUT.read_text(encoding='utf-8')) or {}
        except Exception as e:
            print(f"  ⚠️ 既有 fundamentals_rotation.json parse 失敗,重建:{e}")
            acc = {}
    cursor = int(acc.get('__cursor', 0)) % N

    # 取這批(可跨界 wrap)
    batch = [universe[(cursor + i) % N] for i in range(min(BATCH_N, N))]
    print(f"  universe {N} 檔 ・ 本輪 cursor {cursor} → 抓 {batch[0]}…{batch[-1]}({len(batch)} 檔)")

    hit = 0
    for i, sym in enumerate(batch):
        if _BLOCKED:
            print("  🚫 Token 全耗盡,提前結束本輪(下輪 cursor 不前進,重試同批)")
            break
        try:
            got = fetch_one(sym)
        except Exception as e:
            print(f"    ⚠️ {sym} 抓取失敗:{e}")
            got = {}
        if got:
            rec = acc.get(sym) if isinstance(acc.get(sym), dict) else {}
            rec.update(got)
            rec['updated'] = datetime.now(TPE).strftime('%Y-%m-%d %H:%M')
            acc[sym] = rec
            hit += 1
        if (i + 1) % 25 == 0:
            print(f"    …{i + 1}/{len(batch)}(命中 {hit})")
        time.sleep(random.uniform(0.25, 0.5))   # 禮貌節流

    # 只有真的有跑到才前進 cursor(斷路器提前結束則原地重試)
    if not _BLOCKED:
        cursor = (cursor + len(batch)) % N

    # 診斷 __ 鍵(前端/potential_miner 讀取時 __ 開頭自動略過)
    acc['__cursor'] = cursor
    acc['__updated'] = datetime.now(TPE).isoformat(timespec='seconds')
    acc['__universe'] = N
    stock_keys = [k for k in acc if not str(k).startswith('__')]
    acc['__status'] = {
        'stocks_cached': len(stock_keys),
        'pe_hits': sum(1 for k in stock_keys if isinstance(acc[k], dict) and 'pe' in acc[k]),
        'yoy_hits': sum(1 for k in stock_keys if isinstance(acc[k], dict) and 'rev_yoy' in acc[k]),
        'gm_hits': sum(1 for k in stock_keys if isinstance(acc[k], dict) and 'gross_margin' in acc[k]),
        'coverage_pct': round(len(stock_keys) / N * 100, 1),
        'last_batch_hit': hit,
    }

    DATA.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(acc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    st = acc['__status']
    print(f"✅ 本輪命中 {hit}/{len(batch)} ・ 累積 {st['stocks_cached']}/{N} 檔"
          f"(涵蓋 {st['coverage_pct']}% ・ YoY {st['yoy_hits']} ・ 毛利 {st['gm_hits']})"
          f" ・ 下輪 cursor={cursor} ・ {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
