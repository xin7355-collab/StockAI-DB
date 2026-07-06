#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
⚡ 當沖熱度採礦 (daytrade_probe.py)

用途:抓 TWSE 官方「每日當日沖銷交易標的及成交量值」(TWTB4U OpenAPI),
      算每檔「當沖比重 = 當沖成交股數 ÷ 當日總成交股數」,輸出獨立檔
      data/daytrade_stats.json,前端當沖頁顯「這檔市場當沖多不多 = 適不適合沖」。

設計(對齊 fund_sweep 低風險原則):
  - 全市場一次 OpenAPI 呼叫,不逐檔迴圈、不吃 FinMind 額度(純 TWSE 免費 OpenAPI)。
  - 輸出獨立檔,不動 daily_miner 重建的任何快取;daily deploy 的 git archive origin/data 自動保留。
  - 帶 __debug 自我診斷欄:第一次跑把原始欄位名 + 樣本列一起存進 json,
    跑完看真實欄位再校準(TWSE OpenAPI 欄位名可能與預期不同,不靠猜)。
  - 自我守門:命中檔數 < DT_MIN_HITS(預設 30)不覆寫、rc=1 不部署,保留線上舊檔。

環境變數:
  DT_MIN_HITS   最少命中檔數才覆寫(預設 30)
  DT_OUT        輸出路徑(預設 data/daytrade_stats.json)
"""
import os
import sys
import json
import time
import datetime

try:
    import requests
except ImportError:
    print("需要 requests:pip install requests", file=sys.stderr)
    sys.exit(2)

TWSE_DAYTRADE_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/TWTB4U'        # 每日當日沖銷交易標的及成交量值(上市,逐檔)
TWSE_STOCKDAY_ALL = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'  # 每日收盤行情-全部(上市,逐檔含 TradeVolume 總成交股數)
TPEX_DAYTRADE_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_daytrading_trans'     # 上櫃當沖(best-effort,欄位不確定→__debug 觀察)

HEADERS = {'User-Agent': 'Mozilla/5.0 (compatible; StockAI-daytrade-probe/1.0)', 'Accept': 'application/json'}

OUT = os.environ.get('DT_OUT', 'data/daytrade_stats.json')
MIN_HITS = int(os.environ.get('DT_MIN_HITS', '30'))


def _num(v):
    """把 '1,234,000' / '1234000' / 1234000 → float;非數字回 None"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(',', '').replace('　', '').replace(' ', '')
    if s in ('', '--', '---', 'N/A', 'null', '除權', '除息'):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _pick(row, keys):
    """從一列 dict 依序找第一個存在且非空的 key 值"""
    for k in keys:
        if k in row and str(row[k]).strip() not in ('', 'null', 'None'):
            return row[k]
    return None


def _pick_code(row):
    return _pick(row, ['Code', 'code', 'SecuritiesCode', 'StockNo', '證券代號', '股票代號', '代號'])


def fetch_json(url, tag, retries=3):
    for i in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=25)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list) and data:
                    print(f"  ✅ {tag}:{len(data)} 列")
                    return data
                print(f"  ⚠️ {tag}:回應非預期(type={type(data).__name__} len={len(data) if hasattr(data,'__len__') else '?'})")
                return data if isinstance(data, list) else []
            print(f"  ⚠️ {tag}:HTTP {r.status_code}(第 {i+1} 次)")
        except Exception as e:
            print(f"  ⚠️ {tag}:{e}(第 {i+1} 次)")
        time.sleep(2 * (i + 1))
    return []


def main():
    print("⚡ 當沖熱度採礦開始")
    debug = {}

    # ── 1. TWSE 逐檔當沖量 ──────────────────────────────
    dt_rows = fetch_json(TWSE_DAYTRADE_URL, 'TWSE TWTB4U 當沖')
    if dt_rows:
        debug['twtb4u_keys'] = list(dt_rows[0].keys())
        debug['twtb4u_sample'] = dt_rows[0]

    # ── 2. TWSE 逐檔總成交股數(算比重的分母)────────────
    sd_rows = fetch_json(TWSE_STOCKDAY_ALL, 'TWSE STOCK_DAY_ALL 收盤')
    if sd_rows:
        debug['stockday_keys'] = list(sd_rows[0].keys())
        debug['stockday_sample'] = sd_rows[0]
    tot_vol = {}
    for row in sd_rows:
        code = _pick_code(row)
        if not code:
            continue
        v = _num(_pick(row, ['TradeVolume', 'Trade_Volume', 'tradeVolume', '成交股數', 'Volume']))
        if v and v > 0:
            tot_vol[str(code).strip()] = v

    # ── 3. 上櫃當沖(best-effort,先觀察欄位)──────────────
    tpex_rows = fetch_json(TPEX_DAYTRADE_URL, 'TPEX 上櫃當沖', retries=2)
    if tpex_rows and isinstance(tpex_rows, list) and tpex_rows:
        debug['tpex_keys'] = list(tpex_rows[0].keys())
        debug['tpex_sample'] = tpex_rows[0]

    # ── 4. 組裝 {code: {v, tot, r}} ─────────────────────
    stats = {}
    for row in dt_rows:
        code = _pick_code(row)
        if not code:
            continue
        code = str(code).strip()
        # 當沖成交股數:TWTB4U 常見欄名(不確定→多候選 + __debug 校準)
        dv = _num(_pick(row, ['Volume', 'TradeVolume', 'DayTradingVolume', '成交股數', '當日沖銷交易成交股數', '成交量']))
        if dv is None or dv <= 0:
            continue
        entry = {'v': int(dv)}
        tv = tot_vol.get(code)
        if tv and tv > 0:
            entry['tot'] = int(tv)
            entry['r'] = round(dv / tv * 100, 1)   # 當沖比重 %
        stats[code] = entry

    hits = len(stats)
    with_ratio = sum(1 for e in stats.values() if 'r' in e)
    print(f"  📊 當沖命中 {hits} 檔,其中 {with_ratio} 檔有比重(配對到總量)")

    # ── 5. 守門:命中太少不覆寫(保留線上舊檔)────────────
    if hits < MIN_HITS:
        print(f"❌ 命中 {hits} < DT_MIN_HITS({MIN_HITS}) → 不覆寫、rc=1 不部署(保留舊檔)")
        # 仍把 debug 落地到暫存,方便看失敗原因(不覆寫正式輸出)
        try:
            os.makedirs('data', exist_ok=True)
            with open('data/daytrade_stats.debug.json', 'w', encoding='utf-8') as f:
                json.dump({'__debug': debug, 'hits': hits}, f, ensure_ascii=False, indent=1)
            print("  ℹ️ 已寫 data/daytrade_stats.debug.json 供診斷")
        except Exception as e:
            print(f"  ⚠️ 寫 debug 失敗:{e}")
        return 1

    # 日期:TWTB4U 樣本若有 Date 就用它,否則今天
    dt_date = None
    if dt_rows:
        dt_date = _pick(dt_rows[0], ['Date', 'date', '日期'])
    out = {
        '__meta': {
            'date': dt_date or datetime.datetime.utcnow().strftime('%Y%m%d'),
            'updated_utc': datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M'),
            'hits': hits,
            'with_ratio': with_ratio,
            'source': 'TWSE OpenAPI TWTB4U + STOCK_DAY_ALL',
        },
        '__debug': debug,   # 首跑觀察真實欄位;校準穩定後可精簡
    }
    out.update(stats)

    os.makedirs(os.path.dirname(OUT) or '.', exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f"✅ 已寫 {OUT}({hits} 檔,含比重 {with_ratio} 檔)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
