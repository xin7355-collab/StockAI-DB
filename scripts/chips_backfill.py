#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📚 分點「一年全市場逐日」回算 —— 一天一個檔,存 data 分支,⛔ 不上 gh-pages。

❓ 使用者(2026-08-30):「1年全市場逐日要怎麼做」

⭐⭐ 為什麼做得到:V71.2.6 的「單日全市場批次」——
   FinMind 分點端點**省略 `data_id`、只給日期 → 回該日全市場**。
   所以一年 ≈ **245 次呼叫**(一天一次),對 6,000 req/hr 是零負擔。
   ⛔ **不是** 245 × 2,653 次 —— 這是整件事成立的關鍵。

📐 為什麼「照現在的存法」不行,以及改了什麼(數字都是實測的):
   | 存法 | 1 年體積 |
   |---|---|
   | 現在的(券商**名稱** + 未壓縮 + 塞進 2,653 個個股檔) | **666 MB** ⛔ |
   | 改存券商**代號**(名稱平均 19.5 bytes → 代號 4 bytes,佔總體積 51%) | 397 MB |
   | ⭐ **代號 + gzip(實測 4.4×)** | **90 MB** ✅ |

🏛️ 三個架構決定(⛔ 別改回去):
   ① **一天一個檔**(`chips_deep/YYYY-MM-DD.json.gz`),⛔ 不是塞進 2,653 個個股檔。
      每天只新增 1 個檔(~370 KB)→ git 只存一顆新 blob;
      塞進個股檔的話**每天要改寫 2,653 個檔**,diff 會爆炸。
   ② **只推 data 分支,⛔ 不上 gh-pages**。前端維持現在的 20 天輕量版,
      下載量**完全不變**。先例:`tdcc_deep.json`(V72.5.1,104 週只推 data)、
      `inst_cache_stock.json`(V69.9.6 移出 gh-pages)。
   ③ **每側只留前 K 家**(預設 15,跟現有 `hist` 一致)。全部分點留著會大好幾倍,
      而排在 16 名之後的淨額對判斷沒有幫助。

🚧 守門(每一條都刻意留著):
   ・**沒有付費層直接 exit 1** —— 2026-08-30 實測 4 把金鑰全部
     `Your level is register`(帳號掉回免費層),那時候跑這支只會產出一堆空檔。
   ・單日回來的股票數 < `MIN_SYMS` → **那天不寫檔**(⛔ 不可寫半份進去,
     之後 `--skip-done` 會以為那天做過了)。
   ・**已存在的日期預設跳過**(冪等)→ 中途失敗可以直接再跑一次接續。
   ・欄位污染防呆沿用 miner 的規則(broker_id 必須 1~5 位數字)。
   ・收尾印**分類統計**(⛔ 沒有它,「0 天成功」會查不出原因,同 V72.5.3 集保的教訓)。

用法:
    python3 scripts/chips_backfill.py --days 245          # 回算最近 245 個日曆天
    python3 scripts/chips_backfill.py --from 2025-09-01 --to 2026-08-29
    python3 scripts/chips_backfill.py --days 30 --dry-run # 只看要抓哪些天,不打 API
"""
import argparse
import gzip
import json
import os
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

OUT_DIR = Path(os.environ.get('CHIPS_DEEP_DIR') or (ROOT / 'data' / 'chips_deep'))
TOP_K = int(os.environ.get('CHIPS_DEEP_TOPK', '15'))     # 每側留幾家
MIN_SYMS = int(os.environ.get('CHIPS_DEEP_MIN_SYMS', '200'))
REASON: dict = defaultdict(int)


def _note(r: str):
    REASON[r] += 1


def compact_day(rows, top_k=TOP_K):
    """把 FinMind 單日全市場的原始列壓成 {stock_id: [[券商代號, 淨股數, 均價], ...]}。

    ⭐ 彙總規則刻意跟 `miner.py` 的逐檔路徑一致(broker_id 防呆、均價 = Σ(價×量)/Σ量),
       ⛔ 不另立一套 —— 同名不同義是本專案犯過最多次的錯。
    回 (compact, broker_names, 看到幾檔股票)。
    """
    by_sym: dict = defaultdict(dict)
    names: dict = {}
    for r in rows or []:
        sid = str(r.get('stock_id') or '').strip()
        bid = str(r.get('secBrokerId') or r.get('securities_trader_id')
                  or r.get('broker_id') or '').strip()
        # 🛡️ 污染防呆(沿用 miner):broker_id 必須是 1~5 位數字,否則是金額欄被誤映射
        if not sid or not bid or ',' in bid or len(bid) > 5:
            continue
        if not bid.replace('A', '').replace('a', '').isdigit():
            continue
        nm = str(r.get('secBrokerName') or r.get('securities_trader')
                 or r.get('broker_name') or '').strip()
        if nm and ',' not in nm and not nm.isdigit():
            names[bid] = nm
        try:
            buy, sel = int(r.get('buy') or 0), int(r.get('sell') or 0)
            price = float(r.get('price') or 0)
        except (TypeError, ValueError):
            continue
        e = by_sym[sid].setdefault(bid, [0, 0.0, 0])      # [net, Σ(價×量), Σ量]
        e[0] += buy - sel
        if price > 0:
            e[1] += price * (buy + sel)
            e[2] += buy + sel

    out: dict = {}
    for sid, brs in by_sym.items():
        lst = []
        for bid, (net, pv, vol) in brs.items():
            if not net:
                continue
            lst.append([bid, net, round(pv / vol, 2) if vol > 0 else 0])
        if not lst:
            continue
        lst.sort(key=lambda x: -x[1])
        # 每側前 K 家(⛔ 不是「前 2K 名」—— 買賣兩側要各自留滿)
        keep = lst[:top_k] + [x for x in lst[-top_k:] if x[1] < 0]
        seen = set()
        uniq = []
        for x in keep:
            if x[0] in seen:
                continue
            seen.add(x[0])
            uniq.append(x)
        out[sid] = uniq
    return out, names, len(by_sym)


def day_path(d: str) -> Path:
    return OUT_DIR / f'{d}.json.gz'


def write_day(d: str, compact: dict, names: dict):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {'d': d, 'n': len(compact), 'k': TOP_K, 'nm': names, 's': compact}
    blob = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    with gzip.open(day_path(d), 'wb', compresslevel=9) as f:
        f.write(blob)
    return len(blob), day_path(d).stat().st_size


def read_day(d: str):
    p = day_path(d)
    if not p.exists():
        return None
    with gzip.open(p, 'rb') as f:
        return json.loads(f.read().decode('utf-8'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=0, help='回算最近 N 個日曆天')
    ap.add_argument('--from', dest='d_from', default='')
    ap.add_argument('--to', dest='d_to', default='')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--redo', action='store_true', help='已存在的日期也重抓(⛔ 預設跳過)')
    a = ap.parse_args()

    if a.d_from and a.d_to:
        d0 = date.fromisoformat(a.d_from)
        d1 = date.fromisoformat(a.d_to)
    else:
        n = a.days or 245
        d1 = date.today()
        d0 = d1 - timedelta(days=n)
    dates = []
    dd = d1
    while dd >= d0:
        if dd.weekday() < 5:                    # ⛔ 週末不用打(台股不開)
            dates.append(dd.isoformat())
        dd -= timedelta(days=1)
    print(f'📚 分點深歷史回算:{d0} ~ {d1} → {len(dates)} 個平日 ・ 輸出 {OUT_DIR}')

    todo = dates if a.redo else [d for d in dates if not day_path(d).exists()]
    have = len(dates) - len(todo)
    print(f'   已經有的 {have} 天 → 這次要抓 {len(todo)} 天(每天 1 次 API 呼叫)')
    if a.dry_run:
        print('   --dry-run:不打 API。前 5 天 =', todo[:5])
        return 0
    if not todo:
        print('   ✅ 全部都有了,沒事可做')
        return 0

    import miner  # noqa: E402  (匯入才會讀 Secrets;--dry-run 不需要)
    if not miner.detect_finmind_paid():
        print('🚨 FinMind 不是付費層 → ⛔ 直接停手,不產出任何檔案。')
        print('   (2026-08-30 實測:4 把金鑰全部回 `Your level is register` = 帳號掉回免費層。')
        print('    分點的單日全市場批次是 Sponsor 專屬,免費層拿不到 → 硬跑只會產出一堆空檔。)')
        return 1

    all_names: dict = {}
    okd = 0
    for i, d in enumerate(todo, 1):
        j = miner.fm_paid_get('taiwan_stock_trading_daily_report', f'date={d}', timeout=180) or {}
        st, rows = j.get('status'), (j.get('data') or [])
        if st != 200 or not rows:
            _note(f'http_{st}' if st != 200 else 'empty(非交易日?)')
            continue
        compact, names, nsym = compact_day(rows)
        # 🚧 空過守門:不像「全市場」就整天丟掉,⛔ 不可寫半份(不然下次會以為這天做過了)
        if nsym < MIN_SYMS:
            _note(f'too_few_syms({nsym}<{MIN_SYMS})')
            print(f'  ⚠️ {d} 只回 {nsym} 檔股票 → ⛔ 不寫檔')
            continue
        raw, gz = write_day(d, compact, names)
        all_names.update(names)
        okd += 1
        _note('ok')
        if okd <= 3 or okd % 20 == 0:
            print(f'  ✅ [{i}/{len(todo)}] {d}:{nsym:,} 檔 ・ {raw / 1048576:.2f} MB → gz {gz / 1024:.0f} KB')

    tot = sum(p.stat().st_size for p in OUT_DIR.glob('*.json.gz')) if OUT_DIR.exists() else 0
    print(f'\n📊 完成:新增 {okd} 天 ・ 目錄現有 {len(list(OUT_DIR.glob("*.json.gz")))} 天 '
          f'・ 合計 {tot / 1048576:.0f} MB')
    if REASON:
        print('   分類統計:' + ' ・ '.join(f'{k}×{v}' for k, v in sorted(REASON.items(), key=lambda kv: -kv[1])))
    if not okd:
        print('🚨 一天都沒抓到 —— 先看上面的分類統計,⛔ 別直接改 timeout。')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
