"""
首席 AI 司令部 — 雲端籌碼採礦機
策略：每天只需 3 次 FinMind batch API 呼叫，即可更新全台 2000+ 檔
      OHLCV + 法人三大買賣超 + 融資融券，省流量、不被 Ban。
"""
import os
import json
import requests
import time
from datetime import date, timedelta
from pathlib import Path

DATA_DIR = "data"
FINMIND_TOKEN = os.environ.get('FINMIND_TOKEN', '')
BASE_URL = 'https://api.finmindtrade.com/api/v4/data'

Path(DATA_DIR).mkdir(exist_ok=True)


def fm_get(dataset, **params):
    """FinMind API wrapper — returns data list or [] on failure."""
    p = {'dataset': dataset, **params}
    if FINMIND_TOKEN:
        p['token'] = FINMIND_TOKEN
    for attempt in range(3):
        try:
            res = requests.get(BASE_URL, params=p, timeout=60)
            j = res.json()
            if j.get('status') == 200:
                return j.get('data', [])
            print(f"  ⚠️  FinMind {dataset} status={j.get('status')} msg={j.get('msg')}")
            return []
        except Exception as e:
            print(f"  ⚠️  FinMind {dataset} attempt {attempt+1} failed: {e}")
            time.sleep(5 * (attempt + 1))
    return []


def load_json(symbol):
    p = Path(DATA_DIR) / f"{symbol}.json"
    if p.exists():
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    return []


def save_json(symbol, records):
    p = Path(DATA_DIR) / f"{symbol}.json"
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False, separators=(',', ':'))


def run():
    today = date.today()
    # Fetch a rolling 15-day window so we catch any delayed settlement data
    start = (today - timedelta(days=15)).strftime('%Y-%m-%d')
    end = today.strftime('%Y-%m-%d')

    # ── 1. OHLCV (全台股，一次拿完) ──────────────────────────────────
    print(f"📊 [1/3] TaiwanStockPrice {start}~{end} ...")
    prices = fm_get('TaiwanStockPrice', start_date=start, end_date=end)
    print(f"       {len(prices)} 筆")

    # ── 2. 法人三大買賣超 ──────────────────────────────────────────────
    print(f"🏦 [2/3] TaiwanStockInstitutionalInvestors {start}~{end} ...")
    inst_raw = fm_get('TaiwanStockInstitutionalInvestors', start_date=start, end_date=end)
    print(f"       {len(inst_raw)} 筆")

    # ── 3. 融資融券 ────────────────────────────────────────────────────
    print(f"💳 [3/3] TaiwanStockMarginPurchaseShortSale {start}~{end} ...")
    margin_raw = fm_get('TaiwanStockMarginPurchaseShortSale', start_date=start, end_date=end)
    print(f"       {len(margin_raw)} 筆")

    # ── Build lookup: (date_str, stock_id) ───────────────────────────
    inst = {}
    for r in inst_raw:
        k = (r['date'], r['stock_id'])
        if k not in inst:
            inst[k] = {'foreign_net': 0, 'trust_net': 0, 'dealer_net': 0}
        net = int(r.get('buy', 0)) - int(r.get('sell', 0))
        name = r.get('name', '')
        if '外資' in name:
            inst[k]['foreign_net'] = net
        elif '投信' in name:
            inst[k]['trust_net'] = net
        elif '自營' in name:
            inst[k]['dealer_net'] = net

    margin = {}
    for r in margin_raw:
        margin[(r['date'], r['stock_id'])] = {
            'margin_balance': int(r.get('MarginPurchaseToday', 0)),
            'short_balance':  int(r.get('ShortSaleToday', 0))
        }

    # ── Group prices by symbol ────────────────────────────────────────
    by_sym = {}
    for r in prices:
        sym = r['stock_id']
        by_sym.setdefault(sym, []).append(r)

    # ── Merge & save each symbol ──────────────────────────────────────
    print(f"\n💾 合併寫入 {len(by_sym)} 檔股票...")
    updated = 0
    for sym, rows in by_sym.items():
        existing = load_json(sym)
        existing_dates = {rec['date'] for rec in existing}

        new_recs = []
        for r in rows:
            raw_date = r['date']                         # "2024-01-02"
            fmt_date = raw_date.replace('-', '/')        # "2024/01/02"
            if fmt_date in existing_dates:
                continue

            close = float(r.get('close', 0))
            if close == 0:
                continue

            rec = {
                'date':   fmt_date,
                'open':   float(r.get('open', close)),
                'high':   float(r.get('max',  close)),
                'low':    float(r.get('min',  close)),
                'close':  close,
                'volume': int(r.get('Trading_Volume', 0)),
                # 法人籌碼
                'foreign_net': inst.get((raw_date, sym), {}).get('foreign_net', 0),
                'trust_net':   inst.get((raw_date, sym), {}).get('trust_net',   0),
                'dealer_net':  inst.get((raw_date, sym), {}).get('dealer_net',  0),
                # 融資融券
                'margin_balance': margin.get((raw_date, sym), {}).get('margin_balance', 0),
                'short_balance':  margin.get((raw_date, sym), {}).get('short_balance',  0),
            }
            new_recs.append(rec)

        if new_recs:
            combined = sorted(existing + new_recs, key=lambda x: x['date'])
            combined = combined[-800:]   # 保留約 3 年 (800 個交易日)
            save_json(sym, combined)
            updated += 1

    print(f"\n🎉 採礦完成！更新 {updated} 檔，略過 {len(by_sym)-updated} 檔（已是最新）。")


if __name__ == '__main__':
    print("🚀 首席 AI 司令部 — 雲端籌碼採礦機")
    print(f"🔑 FinMind Token: {'✅ 有（完整模式）' if FINMIND_TOKEN else '⚠️  無（限速模式）'}\n")
    run()
