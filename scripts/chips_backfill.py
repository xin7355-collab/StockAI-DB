#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📚 分點「一年全市場逐日」回算 —— 一天一個檔,存 data 分支,⛔ 不上 gh-pages。

❓ 使用者(2026-08-30):「1年全市場逐日要怎麼做」

🚨🚨 **原本的計畫假設被實測推翻了(2026-08-30,付費恢復後才驗得到)**:
   我原本寫「省略 `data_id` → 回該日全市場,一年只要 245 次呼叫」。
   ⛔ **那條路不通** —— A~F 六種寫法(專用端點/dataset 形式/start_date/start+end/SecIdAgg)
   全部回 `parameter data_id can't be none on TaiwanStockTradingDailyReport dataset`。
   ⭐ 而**對照組(八大行庫)同樣省略 data_id 卻回 13,392 列** →
     所以**不是帳號等級不夠**,是**這個 dataset 就是不給省略 data_id**,升級也沒用。

⭐⭐ **正解:換一個軸 —— 按「券商」抓,不是按「股票」抓。**
   `?securities_trader_id=9200&date=X` 實測 200 / 4,005 列
   = 那家券商當天在**全市場**的所有交易。
   而分點淨額**極度集中**(400 檔抽樣、809 家分點實測):
   | 前 N 家券商 | 覆蓋 |淨額| | 1 年呼叫數 | 時數(6,000/hr) |
   |---|---|---|---|
   | 30 | 86.2% | 7,350 | 1.2 h |
   | 100 | 94.7% | 24,500 | 4.1 h |
   | ⭐ **200** | **98.0%** | 49,000 | **8.2 h** |
   | (按股票抓) | 100% | **650,285** | ⛔ **108 h** |
   → 按券商抓比按股票抓**省 13 倍**,而且前 200 家就有 98% 覆蓋。
   ⚠️ GitHub Actions 單 job 上限 6 小時 → 用 `--from/--to` 分段跑(這支是冪等的)。

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
    python3 scripts/chips_backfill.py --days 245                 # 回算最近 245 個日曆天
    python3 scripts/chips_backfill.py --days 245 --brokers 100   # 只要 94.7% 覆蓋、時間減半
    python3 scripts/chips_backfill.py --from 2026-06-01 --to 2026-08-29   # 分段跑(冪等)
    python3 scripts/chips_backfill.py --days 30 --dry-run        # 只看要抓哪些天,不打 API
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


def top_brokers(n: int, chips_dir: Path = None) -> list:
    """從現有 `data/chips/*.json` 算出「依 |淨額| 排序的前 n 家券商**代號**」。

    ⭐ 讀的是 `chips[].buyers/sellers[].bid` —— 那裡**本來就存了券商代號**。
    ⚠️ 第一版改讀 `hist` 再用名稱反查 `broker_names.json`,實測 **906 個反查不到、
       只湊出 18 家**(hist 只存名稱,而且會帶戰術標籤)→ ⛔ 別再走反查那條路。
    ⭐ 刻意**在執行時算**而不是寫死清單 —— 券商合併/改名/新開分點會自動跟上。
    """
    chips_dir = chips_dir or (ROOT / 'data' / 'chips')
    score: dict = defaultdict(float)
    scanned = 0
    for p in sorted(chips_dir.glob('*.json')):
        try:
            j = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(j, dict):
            continue
        scanned += 1
        for day in (j.get('chips') or []):
            for side in ('buyers', 'sellers'):
                for e in (day.get(side) or []):
                    bid = str(e.get('bid') or e.get('broker_id') or '').strip()
                    # 沿用 miner 的防呆:代號必須 1~5 位數字(⛔ 名稱不能當 API 參數)
                    if not bid or len(bid) > 5 or not bid.replace('A', '').replace('a', '').isdigit():
                        continue
                    try:
                        score[bid] += abs(int(e.get('net') or 0))
                    except (TypeError, ValueError):
                        pass
    ranked = [b for b, _ in sorted(score.items(), key=lambda kv: -kv[1])]
    tot = sum(score.values()) or 1
    cov = sum(score[b] for b in ranked[:n]) / tot * 100
    print(f'   🏦 掃 {scanned:,} 個分點檔 → 出現過 {len(ranked):,} 家券商;'
          f'取前 {min(n, len(ranked))} 家(覆蓋 |淨額| 的 {cov:.1f}%)')
    return ranked[:n]


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
    ap.add_argument('--brokers', type=int, default=200,
                    help='取前幾家券商(實測:30→86.2%% ・100→94.7%% ・200→98.0%% 覆蓋率)')
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
    print(f'   已經有的 {have} 天 → 這次要抓 {len(todo)} 天(每天要打「前 N 家券商」次)')
    if a.dry_run:
        print('   --dry-run:不打 API。前 5 天 =', todo[:5])
        return 0
    if not todo:
        print('   ✅ 全部都有了,沒事可做')
        return 0

    import miner  # noqa: E402  (匯入才會讀 Secrets;--dry-run 不需要)
    brokers = top_brokers(a.brokers)
    if len(brokers) < 10:
        print(f'🚨 只取得 {len(brokers)} 家券商代號(要 ≥10)→ ⛔ 停手,不產出半份資料。')
        print('   通常是 data/chips/ 是空的(先跑一次 daily_miner),或 broker_names.json 沒有。')
        return 1
    print(f'   🏦 依現有分點資料排出前 {len(brokers)} 家券商 → 每天要打 {len(brokers)} 次')
    print(f'   ⏱️ 預估 {len(todo) * len(brokers):,} 次呼叫 ≈ {len(todo) * len(brokers) / 6000:.1f} 小時'
          f'(⚠️ GitHub Actions 單 job 上限 6 小時 → 超過就用 --from/--to 分段跑,這支是冪等的)')
    if not miner.detect_finmind_paid():
        print('🚨 FinMind 不是付費層 → ⛔ 直接停手,不產出任何檔案。')
        print('   (2026-08-30 實測:4 把金鑰全部回 `Your level is register` = 帳號掉回免費層。')
        print('    分點的單日全市場批次是 Sponsor 專屬,免費層拿不到 → 硬跑只會產出一堆空檔。)')
        return 1

    all_names: dict = {}
    okd = 0
    for i, d in enumerate(todo, 1):
        # ⭐ 按**券商**抓:一家券商一次呼叫 = 那家當天在全市場的所有交易。
        #   ⛔ 不是按股票抓(那要 2,653 次/天 = 13 倍成本)。
        rows, hit = [], 0
        for bid in brokers:
            j = miner.fm_paid_get('taiwan_stock_trading_daily_report',
                                  f'securities_trader_id={bid}&date={d}', timeout=120) or {}
            if j.get('status') == 200 and (j.get('data') or []):
                rows.extend(j['data'])
                hit += 1
            elif j.get('status') != 200:
                _note(f"http_{j.get('status')}")
        if not rows:
            _note('empty(非交易日?)')
            continue
        if hit < len(brokers) * 0.5:
            # 🚧 一半以上的券商沒回 → 多半是限流或當天資料還沒出,⛔ 不可寫半份
            _note(f'partial({hit}/{len(brokers)} 家有回)')
            print(f'  ⚠️ {d} 只有 {hit}/{len(brokers)} 家券商有回 → ⛔ 不寫檔(下次再補)')
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
            print(f'  ✅ [{i}/{len(todo)}] {d}:{hit} 家券商 → {nsym:,} 檔 ・ '
                  f'{raw / 1048576:.2f} MB → gz {gz / 1024:.0f} KB')

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
