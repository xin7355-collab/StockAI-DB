#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏦 集保股權分散「歷史回補」(tdcc_backfill.py) — V69.6.7(修 50 分超時白跑)

痛點:TDCC 開放資料 CSV 只給「最新一週」→ 趨勢箭頭要等下週六才有。
解法:FinMind 付費版集保歷史資料集 TaiwanStockHoldingSharesPer(同源 TDCC),
     逐檔抓近 100 天(約 13 週)併入 data/tdcc_holders.json 的 h 歷史。

V69.6.7 修正(首跑 50 分超時、跑完才寫檔 → 全白跑):
  ① 並行 3 工人 + 自適應限速(撞 429 全域放慢),4014 檔約 10-25 分
  ② 每 400 檔 checkpoint 寫檔 → 中途被砍也保留,重跑冪等接續(同日期不重複)
  ③ 40 分軟時限自我收工寫檔(留 10 分給部署),不再被 timeout 砍到白工
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

OUT_FILE = 'data/tdcc_holders.json'
KEEP_WEEKS = 13
API = 'https://api.finmindtrade.com/api/v4/data'
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or os.getenv('FINMIND_TOKEN', '')).split(',') if t.strip()]
WORKERS = 3
SOFT_DEADLINE_SEC = 40 * 60      # 40 分軟時限(step timeout 50 分,留 10 分緩衝+部署)
CHECKPOINT_EVERY = 400
TW_TZ = timezone(timedelta(hours=8))

_lock = threading.Lock()
_tok_i = 0
_min_interval = 0.25             # 全域限速:每請求最小間隔(撞 429 自動加大)
_last_req_ts = 0.0


def _norm(lv: str) -> str:
    return str(lv).replace(',', '').replace(' ', '').lower()


RETAIL = {'1-999', '1000-5000', '5001-10000'}
BIG400_MID = {'400001-600000', '600001-800000', '800001-1000000'}


def _throttle():
    """全域節流(執行緒安全):維持 _min_interval 的請求間隔"""
    global _last_req_ts
    with _lock:
        wait = _last_req_ts + _min_interval - time.time()
        _last_req_ts = max(time.time(), _last_req_ts + _min_interval)
    if wait > 0:
        time.sleep(wait)


def _slow_down():
    global _min_interval
    with _lock:
        _min_interval = min(_min_interval * 1.5 + 0.05, 1.5)


def _next_token():
    global _tok_i
    with _lock:
        tok = TOKENS[_tok_i % len(TOKENS)] if TOKENS else ''
        _tok_i += 1
    return tok


def fetch(sym: str, start: str):
    """回 list(rows)/[](查無)/None(全 token 失敗)"""
    for _ in range(max(len(TOKENS), 1) + 1):
        _throttle()
        tok = _next_token()
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
            if e.code in (402, 429):
                _slow_down(); continue
            if e.code in (500, 502, 503, 504):
                continue
            return []
        except Exception:
            continue
    return None


def build_rows(rows):
    """FinMind rows → {date8: [date8, big1000, big400, retail_pct, retail_n]}"""
    by_date = {}
    for r in rows:
        d = str(r.get('date') or '')[:10]
        if len(d) != 10:
            continue
        by_date.setdefault(d, {})[_norm(r.get('HoldingSharesLevel'))] = (
            int(r.get('people') or 0), float(r.get('percent') or 0.0))
    out = {}
    for d, lv in by_date.items():
        d8 = d.replace('-', '')
        big1000 = big400 = retail = 0.0
        retail_n = 0
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


def merge_one(data, sym, rows):
    """把 FinMind 歷史併入該股 h(既有日期為準,不覆蓋);回補進幾週"""
    ent = data.get(sym)
    if not isinstance(ent, dict):
        return 0
    hist = [h for h in (ent.get('h') or []) if isinstance(h, list) and len(h) >= 5]
    have = {h[0] for h in hist}
    new = [v for d8, v in build_rows(rows).items() if d8 not in have]
    if not new:
        return 0
    hist.extend(new)
    ent['h'] = sorted(hist, key=lambda h: h[0])[-KEEP_WEEKS:]
    return len(new)


def save(data, touched, note=''):
    meta = data.get('_meta') or {}
    if touched >= 50:
        meta['backfilled'] = datetime.now(TW_TZ).strftime('%Y-%m-%d %H:%M')
    data['_meta'] = meta
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print(f'  💾 checkpoint 寫檔 {note}({os.path.getsize(OUT_FILE)//1024} KB)', flush=True)


def main():
    t0 = time.time()
    if not TOKENS:
        print('❌ 無 FINMIND_TOKENS,回補需要付費 token'); sys.exit(1)
    if not os.path.exists(OUT_FILE):
        print('❌ 找不到現有 tdcc_holders.json(先跑週採礦)'); sys.exit(1)
    with open(OUT_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
    # 已有 ≥2 週歷史的跳過(重跑接續);真股票(4碼)優先
    syms = [k for k in data if not k.startswith('_')
            and len((data[k] or {}).get('h') or []) < 2]
    syms.sort(key=lambda s: (0 if (len(s) == 4 and s.isdigit()) else 1, s))
    start = (datetime.now(TW_TZ) - timedelta(days=100)).date().isoformat()
    print(f'🏦 歷史回補:{len(syms)} 檔待補,start={start},tokens={len(TOKENS)} 把,workers={WORKERS}', flush=True)
    touched = added = empty = hard_fail = done = 0
    stop = False
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fetch, s, start): s for s in syms}
        for fu in as_completed(futs):
            sym = futs[fu]; done += 1
            try:
                rows = fu.result()
            except Exception:
                rows = None
            if rows is None:
                hard_fail += 1
            elif not rows:
                empty += 1
            else:
                n = merge_one(data, sym, rows)
                if n:
                    touched += 1; added += n
            if done % 200 == 0:
                el = int(time.time() - t0)
                print(f'  … {done}/{len(syms)}({el}s)補 {touched} 檔/{added} 週,空 {empty},敗 {hard_fail},限速 {_min_interval:.2f}s', flush=True)
            if done % CHECKPOINT_EVERY == 0:
                save(data, touched, f'{done}/{len(syms)}')
            if time.time() - t0 > SOFT_DEADLINE_SEC and not stop:
                stop = True
                print('⏰ 40 分軟時限到 → 停止排程,收尾寫檔(剩的下次重跑自動接續)', flush=True)
                for f2 in futs:
                    f2.cancel()
    print(f'📊 回補結果:{touched} 檔補進 {added} 週;空 {empty}、敗 {hard_fail}、共處理 {done}', flush=True)
    if touched == 0:
        print('⚠️ 沒補到任何歷史(API 失敗或已全補過)→ 不改寫檔案'); return
    save(data, touched, 'final')
    print(f'✅ 完成,耗時 {int(time.time()-t0)}s', flush=True)


if __name__ == '__main__':
    main()
