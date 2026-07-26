#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏦 集保股權分散「歷史回補」(tdcc_backfill.py) — V69.6.6 一次性補歷史

痛點:TDCC 開放資料 CSV 只給「最新一週」→ 趨勢箭頭要等下週六才有。
解法:FinMind 付費版有集保歷史資料集 TaiwanStockHoldingSharesPer(同源 TDCC),
     用 GitHub Secrets 的 FINMIND_TOKENS 逐檔抓近 100 天(約 13 週)→
     併入 data/tdcc_holders.json 的 h 歷史(既有日期不覆蓋,CSV 版為準)。

用法:tdcc_sweep.yml 手動 Run 時勾 backfill=yes 才跑(一次性;平時週採礦不用)。
節流:0.4s/檔;4000 檔約 30 分,付費額度 6000 req/hr/把,綽綽有餘。
沙盒 403 是 proxy 擋;GitHub Actions 可達(miner.py 每日在用同一 API)。
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

OUT_FILE = 'data/tdcc_holders.json'
KEEP_WEEKS = 13
API = 'https://api.finmindtrade.com/api/v4/data'
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or os.getenv('FINMIND_TOKEN', '')).split(',') if t.strip()]
SLEEP = 0.4
TW_TZ = timezone(timedelta(hours=8))

_tok_i = [0]


def _norm(lv: str) -> str:
    return str(lv).replace(',', '').replace(' ', '').lower()


RETAIL = {'1-999', '1000-5000', '5001-10000'}
BIG400_MID = {'400001-600000', '600001-800000', '800001-1000000'}


def fetch(sym: str, start: str):
    """回 list(rows) 或 None(全 token 失敗)"""
    tried = 0
    while tried <= max(len(TOKENS), 1):
        tok = TOKENS[_tok_i[0] % len(TOKENS)] if TOKENS else ''
        q = {'dataset': 'TaiwanStockHoldingSharesPer', 'data_id': sym, 'start_date': start}
        if tok:
            q['token'] = tok
        url = API + '?' + urllib.parse.urlencode(q)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.loads(r.read().decode('utf-8', errors='replace'))
            return j.get('data') or []
        except urllib.error.HTTPError as e:
            if e.code in (402, 429, 500, 502, 503, 504):
                _tok_i[0] += 1; tried += 1; time.sleep(1.0); continue
            return []          # 4xx 其他(如查無此檔)→ 空
        except Exception:
            _tok_i[0] += 1; tried += 1; time.sleep(1.0)
    return None


def build_rows(rows):
    """FinMind rows → {date8: [date8, big1000, big400, retail_pct, retail_n]}"""
    by_date = {}
    for r in rows:
        d = str(r.get('date') or '')[:10]
        if len(d) != 10:
            continue
        ent = by_date.setdefault(d, {})
        ent[_norm(r.get('HoldingSharesLevel'))] = (
            int(r.get('people') or 0), float(r.get('percent') or 0.0))
    out = {}
    for d, lv in by_date.items():
        d8 = d.replace('-', '')
        big1000 = 0.0; big400 = 0.0; retail = 0.0; retail_n = 0
        for k, (ppl, pct) in lv.items():
            if k == 'total':
                continue
            if 'morethan' in k or '1000001' in k:
                big1000 += pct; big400 += pct
            elif k in BIG400_MID:
                big400 += pct
            elif k in RETAIL:
                retail += pct; retail_n += ppl
        if big1000 <= 0 and big400 <= 0 and retail <= 0:
            continue
        out[d8] = [d8, round(big1000, 2), round(big400, 2), round(retail, 2), retail_n]
    return out


def main():
    if not TOKENS:
        print('❌ 無 FINMIND_TOKENS,回補需要付費 token'); sys.exit(1)
    if not os.path.exists(OUT_FILE):
        print('❌ 找不到現有 tdcc_holders.json(先跑週採礦)'); sys.exit(1)
    with open(OUT_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
    syms = [k for k in data if not k.startswith('_')]
    # 真股票(4碼)優先,特殊證券殿後(FinMind 多半沒有,快速失敗)
    syms.sort(key=lambda s: (0 if (len(s) == 4 and s.isdigit()) else 1, s))
    start = (datetime.now(TW_TZ) - timedelta(days=100)).date().isoformat()
    print(f'🏦 歷史回補開始:{len(syms)} 檔,start={start},tokens={len(TOKENS)} 把')
    added_rows = 0; touched = 0; empty = 0; hard_fail = 0
    for i, sym in enumerate(syms):
        if i and i % 200 == 0:
            print(f'  … {i}/{len(syms)}(補進 {touched} 檔/{added_rows} 週,無資料 {empty},失敗 {hard_fail})')
        rows = fetch(sym, start)
        time.sleep(SLEEP)
        if rows is None:
            hard_fail += 1
            if hard_fail >= 30:
                print('❌ 連續大量失敗(額度/封鎖?)→ 提前收工,已補的保留'); break
            continue
        if not rows:
            empty += 1; continue
        hist_rows = build_rows(rows)
        ent = data.get(sym)
        if not isinstance(ent, dict):
            continue
        hist = [h for h in (ent.get('h') or []) if isinstance(h, list) and len(h) >= 5]
        have = {h[0] for h in hist}
        new = [v for d8, v in hist_rows.items() if d8 not in have]
        if not new:
            continue
        hist.extend(new)
        ent['h'] = sorted(hist, key=lambda h: h[0])[-KEEP_WEEKS:]
        touched += 1; added_rows += len(new)
    print(f'📊 回補結果:{touched} 檔補進 {added_rows} 週歷史;無資料 {empty}、失敗 {hard_fail}')
    if touched < 50:
        print('⚠️ 補到的檔數過少(<50)→ 不改寫檔案(視為回補失敗,原檔保留)'); sys.exit(0)
    meta = data.get('_meta') or {}
    meta['backfilled'] = datetime.now(TW_TZ).strftime('%Y-%m-%d %H:%M')
    data['_meta'] = meta
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print(f'✅ 已寫回 {OUT_FILE}({os.path.getsize(OUT_FILE)//1024} KB)')


if __name__ == '__main__':
    main()
