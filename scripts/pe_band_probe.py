#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📐 「PE / PB 在它自己歷史的哪個位階」探針(V73.3.9)—— 只讀、手動觸發、不寫產物。

🚨 CLAUDE.md 對這件事的原始判定是**不要做**:
     「歷史 P/E 價格帶:我只有**當前** PE、沒有歷史 EPS → 用現在的 EPS 回推歷史 PE,
       算出來只是把價格區間換個名字(等於位階溫度計),**是假的河流圖**,不要做。」
   ⭐ 那個理由現在**不成立了** —— FinMind 缺口探針實測 `TaiwanStockPER` 有
      **2015 起 2,828 天**、每一天當時的**真實** PE/PB(不是回推的)。

❓ 要回答的問題:「這檔現在的 PE 在它自己 11 年的哪個位階」有沒有預測力?
   ⭐ 這跟現有的 `industry_pe.json`(跟**同業**比)是**不同的問題**,
      ⛔ 不可互相取代:同業比回答「跟別人比貴不貴」,自身位階回答「跟自己以前比貴不貴」。

📐 六道關卡(照 CLAUDE.md 回測鐵則):
   ① 對照組 = **同一批股票的所有交易日**,⛔ 不抽樣
   ② 報酬扣同期加權指數  ③ 同檔同型態 20 日去重
   ④ 前後半段各自檢定    ⑤ 拿掉貢獻最大的那一年
   ⑥ ⭐ **反向檢定**:位階高那格要得到相反結果,否則只是「有 PE 資料的股票」的選樣效應

⚠️ 選樣偏誤守門(V72.1.7 的教訓:`files.sort()[:N]` 讓「500 檔」實際只涵蓋 1xxx~2xxx):
   ⛔ 不取排序前 N,改**跨代號段均勻抽樣**,並印出實際涵蓋分布。
⚠️ 倖存者偏誤:只掃現在還在 `data/` 的股票,已下市的不算 → 結論偏樂觀,已寫進輸出。

⛔ 安全:只記「第幾把 token」,絕不印金鑰值。
"""
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

API = 'https://api.finmindtrade.com/api/v4/data'
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
DATA = Path(os.getenv('DATA_DIR', 'data'))
N_SYMS = int(os.getenv('N_SYMS', '300'))
START = '2015-01-01'
HORIZONS = (20, 60, 120)
DEDUP = 20
MIN_HIST = 500          # 這檔至少要有幾天 PE 才算得出位階
WIN = 750               # 位階看「近 3 年」(⛔ 不用全期,否則早期樣本沒有可比基準)

_ti = 0


def fm(dataset, data_id, start=START):
    global _ti
    last = 'no-token'
    for k in range(max(1, len(TOKENS))):
        i = (_ti + k) % max(1, len(TOKENS))
        q = {'dataset': dataset, 'data_id': data_id, 'start_date': start}
        if TOKENS:
            q['token'] = TOKENS[i]
        try:
            with urllib.request.urlopen(API + '?' + urllib.parse.urlencode(q), timeout=60) as r:
                j = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            last = f'http{e.code}'
            continue
        except Exception as e:
            last = type(e).__name__
            continue
        rows = (j or {}).get('data') or []
        if rows:
            _ti = (i + 1) % max(1, len(TOKENS))
            return rows, None
    return None, last


def _d(x):
    return str(x or '').replace('/', '-')[:10]


def pick_syms():
    """⛔ 不取排序前 N(那會變成按產業取樣)—— 跨代號段均勻抽。"""
    all_s = sorted(p.stem for p in DATA.glob('*.json') if p.stem.isdigit() and len(p.stem) == 4)
    by = defaultdict(list)
    for s in all_s:
        by[s[0]].append(s)
    out = []
    per = max(1, N_SYMS // max(1, len(by)))
    for k in sorted(by):
        g = by[k]
        step = max(1, len(g) // per)
        out.extend(g[::step][:per])
    return sorted(set(out))[:N_SYMS]


def main():
    if not TOKENS:
        print('❌ 沒有 FINMIND_TOKENS')
        return 1
    idx_rows, err = fm('TaiwanStockPrice', 'TAIEX')
    if not idx_rows:
        print(f'❌ 加權指數抓不到:{err}')
        return 1
    IDX = {_d(r['date']): float(r['close']) for r in idx_rows if r.get('close')}
    print(f'✅ 加權指數 {len(IDX):,} 天')

    syms = pick_syms()
    cover = defaultdict(int)
    for s in syms:
        cover[s[0]] += 1
    print(f'📐 抽樣 {len(syms)} 檔 ・涵蓋分布 {dict(sorted(cover.items()))}')
    print('   ⭐ 跨代號段均勻抽(⛔ 不取排序前 N —— 那會變成按產業取樣,V72.1.7 踩過)\n')

    buckets = defaultdict(lambda: defaultdict(list))
    dated = defaultdict(lambda: defaultdict(list))
    okn = failn = thin = 0
    t0 = time.time()

    for n, sym in enumerate(syms, 1):
        per, e1 = fm('TaiwanStockPER', sym)
        if not per:
            failn += 1
            continue
        px, e2 = fm('TaiwanStockPrice', sym)
        if not px:
            failn += 1
            continue
        P = {_d(r['date']): float(r['close']) for r in px if r.get('close')}
        rows = []
        for r in per:
            d = _d(r.get('date'))
            if d and d in P and d in IDX:
                rows.append((d, r.get('PER'), r.get('PBR')))
        rows.sort()
        if len(rows) < MIN_HIST:
            thin += 1
            continue
        okn += 1
        days = [x[0] for x in rows]
        di = {d: i for i, d in enumerate(days)}

        def fwd(i, h):
            if i + h >= len(days):
                return None
            a, b = P[days[i]], P[days[i + h]]
            ia, ib = IDX[days[i]], IDX[days[i + h]]
            if not a or not ia:
                return None
            return (b - a) / a * 100.0 - (ib - ia) / ia * 100.0

        last = defaultdict(lambda: -999)

        def fire(name, i):
            if i - last[name] < DEDUP:
                return
            last[name] = i
            for h in HORIZONS:
                v = fwd(i, h)
                if v is not None:
                    buckets[name][h].append(v)
                    dated[name][h].append((days[i], v))

        for fld, tag in ((1, 'PE'), (2, 'PB')):
            vals = [x[fld] for x in rows]
            for i in range(250, len(rows) - max(HORIZONS)):
                v = vals[i]
                if not isinstance(v, (int, float)) or v <= 0:
                    continue
                w = [x for x in vals[max(0, i - WIN):i + 1] if isinstance(x, (int, float)) and x > 0]
                if len(w) < 200:
                    continue
                pc = sum(1 for x in w if x <= v) / len(w) * 100
                if fld == 1:
                    fire('(對照)有 PE 的所有交易日', i)
                for lo, hi, lab in ((0, 10, '最低 10%'), (0, 25, '最低 25%'),
                                    (40, 60, '中間'), (75, 101, '最高 25%'), (90, 101, '最高 10%')):
                    if lo <= pc < hi:
                        fire(f'{tag} {lab}', i)
        if n % 50 == 0:
            print(f'   … {n}/{len(syms)} 檔 ・{(time.time()-t0)/60:.1f} 分 ・成功 {okn} ・歷史太短 {thin} ・失敗 {failn}')

    print(f'\n📊 有效 {okn} 檔 ・歷史太短 {thin} ・抓不到 {failn} ・{(time.time()-t0)/60:.1f} 分')
    ctrl = buckets['(對照)有 PE 的所有交易日']
    if not ctrl[HORIZONS[0]]:
        print('❌ 對照組是空的 → 這一輪無效(⛔ 不可當成「沒有邊際」)')
        return 1
    bm = {h: statistics.median(ctrl[h]) for h in HORIZONS}
    print(f'📐 對照組 {len(ctrl[HORIZONS[0]]):,} 筆(**同一批股票的所有交易日**,⛔ 不抽樣)')
    print('   基準中位超額:' + ' ・'.join(f'{h}日 {bm[h]:+.2f}%' for h in HORIZONS) + '\n')

    hdr = f'{"位階":<16}{"n":>8}' + ''.join(f'{str(h)+"日邊際":>13}' for h in HORIZONS)
    print(hdr); print('─' * len(hdr))
    for name in sorted(buckets):
        if name.startswith('(對照)'):
            continue
        v = buckets[name]
        nn = len(v[HORIZONS[0]])
        if nn < 300:
            continue
        cells = ''.join(f'{statistics.median(v[h]) - bm[h]:>+12.2f}pp' for h in HORIZONS)
        print(f'{name:<16}{nn:>8,}{cells}')

    mid = sorted(d for d, _ in dated['(對照)有 PE 的所有交易日'][HORIZONS[1]])
    mid = mid[len(mid) // 2] if mid else None
    print(f'\n🔬 穩健性({HORIZONS[1]} 日;分界 {mid})—— ⛔ 兩段不同向 / 拿掉某年由正轉負 = 不成立')
    H = HORIZONS[1]
    bl = dated['(對照)有 PE 的所有交易日'][H]
    for name in sorted(dated):
        if name.startswith('(對照)') or len(buckets[name][H]) < 300:
            continue
        ev = dated[name][H]
        full = statistics.median([v for _, v in ev]) - statistics.median([v for _, v in bl])
        parts = []
        for lo, hi, tag in ((None, mid, '前半'), (mid, None, '後半')):
            e = [v for d, v in ev if (lo is None or d >= lo) and (hi is None or d < hi)]
            b = [v for d, v in bl if (lo is None or d >= lo) and (hi is None or d < hi)]
            parts.append(f'{tag} {statistics.median(e)-statistics.median(b):+.2f}pp(n={len(e)})' if len(e) >= 30 and b else f'{tag} n={len(e)} 不足')
        yrs = defaultdict(list)
        for d, v in ev:
            yrs[d[:4]].append(v)
        contrib = {y: (statistics.median(x) - statistics.median([v for _, v in bl])) * len(x) for y, x in yrs.items() if len(x) >= 20}
        drop = ''
        if contrib:
            w = max(contrib, key=contrib.get)
            re_ = [v for d, v in ev if d[:4] != w]
            rb = [v for d, v in bl if d[:4] != w]
            if len(re_) >= 30 and rb:
                r = statistics.median(re_) - statistics.median(rb)
                flag = '⛔ 靠那一年' if (full > 0 and r <= 0) else ('✅ 仍成立' if r > 0 else '➖')
                drop = f' ・拿掉 {w} 後 {r:+.2f}pp {flag}'
        print(f'   {name:<16} 整段 {full:+.2f}pp ・' + ' ・'.join(parts) + drop)

    print('\n⚠️ 已知偏誤(⛔ 不可略過):① **倖存者偏誤** —— 只掃現在還在的股票,已下市的不算,結論偏樂觀')
    print('   ② 這是「這檔 vs 它自己的歷史」,跟現有 industry_pe(跟同業比)是**不同的問題**,⛔ 不可互相取代')
    print('   ③ 未扣交易成本(來回約 0.44%)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
