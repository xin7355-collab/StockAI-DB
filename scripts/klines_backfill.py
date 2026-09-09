#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
⭐⭐ K 線補深到 2021(V74.4.4)—— LAB next 欄的最高價值項:
「目前個股只有 2023-06 起 → 所有結論都來自一段偏多頭的行情」。
補到 2021-01 就涵蓋 **2022 那次 −32% 空頭** → 十幾支「走完空頭要重跑」的探針
不用等真的走完空頭,現在就能在空頭窗口重驗(尤其 🧬 追高+高波動)。

架構(照 chips_backfill 的三個決定,⛔ 別改回去):
  ① 推**獨立 orphan 分支 `klines_deep`**,⛔ 不碰 data 也不碰 gh-pages
     (那兩個是 daily_miner orphan force-push 重建的,長工作一定互相覆蓋)。
  ② 檔案放頂層 `klines_deep/{sym}.json.gz`,⛔ 不是 data/(gh-pages 那步 git add -f data/ 整包收)。
  ③ 前端**不讀**(只給探針/回測);讀法 `git archive origin/klines_deep`。

資料:FinMind TaiwanStockPrice 一檔**一次呼叫**(start_date=2021-01-01;
history_probe 實測一次能回 18 年)。含**下市股**(TaiwanStockDelisting,修倖存者偏誤)。
⭐ 寫檔前套 miner._backadjust_splits(⛔ 不另寫一份 —— 分割斷崖那套已有 20 條測試)。

守門(⛔ 都不可拿掉):
  ・探路:先抓 2330 驗「真的回溯得到 2021」,不行就 exit 1(⛔ 別 2,700 檔打完才發現)
  ・已在分支上的 sym 跳過(冪等 → 中斷再跑一次接續)
  ・完成 < MIN_OK 檔不推;分支檔數**只增不減**(orphan force-push 會整個取代)
  ・收尾印分類統計(V72.5.3 教訓:0 檔成功要說得出為什麼)

用法:python3 scripts/klines_backfill.py [--dry N](只抓 N 檔不推,驗管線)
"""
import gzip
import json
import os
import subprocess
import sys
import time
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dispo_probe import fm, TOKENS, classify   # noqa: E402  token 輪動共用(⛔ 不寫第二份)
import miner                                    # noqa: E402  _backadjust_splits 共用

START = os.getenv('KLB_START', '2021-01-01')
OUT_DIR = 'klines_deep'
MIN_OK = int(os.getenv('KLB_MIN_OK', '500'))
SLEEP = float(os.getenv('KLB_SLEEP', '0.65'))   # ~5,500 req/hr < 付費 6,000
BRANCH = 'klines_deep'
REASON = {}


def _bump(k):
    REASON[k] = REASON.get(k, 0) + 1


def sh(*args, ok_fail=False):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0 and not ok_fail:
        # ⛔ capture_output 而不看 returncode = 主動把錯誤丟掉(V74.3.1 的教訓)
        print(f'  ⚠️ {" ".join(args[:4])} rc={r.returncode}: {r.stderr[:160]}')
    return r


def universe():
    """上市上櫃現存股(gh-pages data/ 的檔名)+ 2021 後下市股(修倖存者偏誤)。"""
    sh('git', 'fetch', 'origin', 'gh-pages', '--depth=1')
    r = sh('git', 'ls-tree', '--name-only', 'origin/gh-pages', 'data/')
    live = [os.path.basename(x)[:-5] for x in r.stdout.split()
            if x.endswith('.json') and os.path.basename(x)[:-5].replace('^', '').isdigit()]
    rows, err = fm('TaiwanStockDelisting', {})
    dl = []
    if rows:
        for x in rows:
            sid = str(x.get('stock_id') or '')
            d = str(x.get('date') or '')[:10]
            if sid.isdigit() and 4 <= len(sid) <= 6 and d >= START:
                dl.append(sid)
    else:
        print(f'  ⚠️ 下市清單抓不到({err})→ 這輪只補現存股(倖存者偏誤仍在,誠實記錄)')
    print(f'📋 母體:現存 {len(live)} 檔 + 2021 後下市 {len(dl)} 檔')
    return sorted(set(live)), sorted(set(dl) - set(live))


def existing_on_branch():
    sh('git', 'fetch', 'origin', BRANCH, '--depth=1', ok_fail=True)
    r = sh('git', 'ls-tree', '--name-only', f'origin/{BRANCH}', f'{OUT_DIR}/', ok_fail=True)
    if r.returncode != 0:
        return set()
    return {os.path.basename(x)[:-8] for x in r.stdout.split() if x.endswith('.json.gz')}


def fetch_one(sym, delisted=False):
    rows, err = fm('TaiwanStockPrice', {
        'data_id': sym, 'start_date': START, 'end_date': date.today().isoformat()}, timeout=90)
    if rows is None:
        _bump('fail_' + classify(err or ''))
        return None
    if len(rows) < 60:
        _bump('too_short')
        return None
    recs = []
    for r in rows:
        try:
            recs.append({'date': str(r['date'])[:10],
                         'open': float(r['open']), 'high': float(r['max']), 'low': float(r['min']),
                         'close': float(r['close']), 'volume': int(r.get('Trading_Volume') or 0)})
        except (KeyError, TypeError, ValueError):
            continue
    if len(recs) < 60:
        _bump('bad_rows')
        return None
    recs = [x for x in recs if x['close'] > 0]
    miner._backadjust_splits(recs, sym=sym)     # 分割/減資斷崖回調(共用,20 條測試釘過)
    _bump('ok')
    return {'s': sym, 'dl': 1 if delisted else 0,
            'k': [[x['date'], x['open'], x['high'], x['low'], x['close'], x['volume']] for x in recs]}


def write_one(obj):
    os.makedirs(OUT_DIR, exist_ok=True)
    with gzip.open(os.path.join(OUT_DIR, obj['s'] + '.json.gz'), 'wt', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))


def main():
    dry = 0
    if '--dry' in sys.argv:
        dry = int(sys.argv[sys.argv.index('--dry') + 1])
    print(f'🔑 token:{len(TOKENS)} 把 ・起點 {START} ・dry={dry or "no"}')

    # 🚧 探路:2330 一定要回溯得到 2021(⛔ 別 2,700 檔打完才發現層級/深度不對)
    probe = fetch_one('2330')
    if not probe or probe['k'][0][0] > '2021-03-01':
        print(f'❌ 探路失敗:2330 {"抓不到" if not probe else "最早只到 " + probe["k"][0][0]} → 不開火')
        print(f'   分類統計:{REASON}')
        sys.exit(1)
    print(f'✅ 探路:2330 {len(probe["k"])} 根 ・最早 {probe["k"][0][0]}')
    write_one(probe)

    live, dl = universe()
    done = existing_on_branch()
    print(f'♻️ 分支上已有 {len(done)} 檔 → 跳過(冪等接續)')
    todo = [(s, False) for s in live if s not in done and s != '2330'] + \
           [(s, True) for s in dl if s not in done]
    if dry:
        todo = todo[:dry]
    t0 = time.time()
    for i, (sym, is_dl) in enumerate(todo):
        obj = fetch_one(sym, delisted=is_dl)
        if obj:
            write_one(obj)
        if i % 100 == 0:
            el = time.time() - t0
            print(f'  [{i}/{len(todo)}] {sym} ・{el/60:.1f} 分 ・{REASON}', flush=True)
        time.sleep(SLEEP)
    n_ok = REASON.get('ok', 0)
    print(f'\n📊 完成:{REASON} ・耗時 {(time.time()-t0)/60:.1f} 分')

    if dry:
        print('🧪 dry run:不推分支')
        return
    # 🚧 空過/只增不減守門
    files = [f for f in os.listdir(OUT_DIR)] if os.path.isdir(OUT_DIR) else []
    total_after = len(set(f[:-8] for f in files if f.endswith('.json.gz')) | done)
    if n_ok < MIN_OK and len(done) == 0:
        print(f'❌ 只成功 {n_ok} 檔(< {MIN_OK})且分支還沒建立 → 拒推')
        sys.exit(1)
    if total_after < len(done):
        print(f'❌ 推完會比分支上少({total_after} < {len(done)})→ 拒推(orphan force-push 會整個取代)')
        sys.exit(1)
    # ⚠️ 分支既有檔的**還原**在 workflow 的 shell 做(git archive | tar -x)——
    #    ⛔ Python subprocess text=True 會弄壞二進位 tar(這裡只驗數字不搬檔)。
    print(f'🚀 準備推 {BRANCH}:合計 {total_after} 檔(還原+push 都在 workflow 那步)')


if __name__ == '__main__':
    main()
