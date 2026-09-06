#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔬 籌碼訊號探針(V73.3.8)—— 只讀 data/,不打 API、不寫任何產物。

🚨 為什麼現在才做得了:`foreign_net` 以前只有 60 天(全落在同一段下跌行情)→
   CLAUDE.md 明寫「樣本不足以回測」。V73.3.6 回補之後變成 **765~786 天(約 3 年)**,
   才第一次有辦法驗。

❓ 主要要回答使用者問的那句:
   「分析師常說外資大賣、現在**認錯回買** —— 這有說錯嗎?」

📐 方法(照 CLAUDE.md 的回測鐵則,⛔ 少一條結論就不算數):
   ① 報酬**扣同期加權指數**(不扣會把大盤漲跌算成訊號的功勞)
   ② **對照組用同一個母體**(所有交易日),⛔ 不抽樣(V72.4.4 踩過:抽樣讓每種型態都「贏 9~15pp」)
   ③ 同檔同事件 **20 日去重**(連續觸發是同一件事,不去重等於灌水)
   ④ **前後半段各自檢定** —— 只有兩段同向才算數
   ⑤ **反向檢定** —— 反過來的條件要得到相反的結果,不然只是「有事件 vs 沒事件」的活躍度代理
   ⑥ 未扣交易成本(來回約 0.44%)→ 邊際小於 0.44pp 的一律不能當進場理由

⛔ 這支不產生任何前端資料。有沒有邊際是它說了算,⛔ 不是我想做就做。
"""
import json
import os
import statistics
import sys
from collections import defaultdict
from pathlib import Path

DATA = Path(os.getenv('DATA_DIR', 'data'))
HORIZONS = (5, 10, 20)
DEDUP = 20          # 同檔同事件幾天內只算一次
MIN_BARS = 200


def _d(x):
    return str(x or '').replace('/', '-')[:10]


def load_index():
    """加權指數:{日期: 收盤} —— 超額報酬要扣它。"""
    p = DATA / '^TWII.json'
    if not p.exists():
        print('❌ 沒有 ^TWII.json,算不了超額報酬')
        sys.exit(1)
    rows = json.loads(p.read_text(encoding='utf-8'))
    return {_d(r.get('date')): float(r.get('close') or 0) for r in rows if r.get('close')}


def fwd(closes, i, h):
    if i + h >= len(closes):
        return None
    a, b = closes[i], closes[i + h]
    if not a or not b:
        return None
    return (b - a) / a * 100.0


def main():
    idx = load_index()
    files = sorted(p for p in DATA.glob('*.json')
                   if p.stem.isdigit() and len(p.stem) == 4)
    print(f'🔬 籌碼訊號探針 ・{len(files)} 檔 ・對照組=所有交易日(同母體)・報酬扣同期加權\n')

    # 事件桶:{名稱: {天期: [超額報酬]}},另存 (日期, 報酬) 供前後半段檢定
    buckets = defaultdict(lambda: defaultdict(list))
    dated = defaultdict(lambda: defaultdict(list))
    nfile = 0

    for p in files:
        try:
            rows = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(rows, list) or len(rows) < MIN_BARS:
            continue
        dates = [_d(r.get('date')) for r in rows]
        closes = [float(r.get('close') or 0) for r in rows]
        fn = [r.get('foreign_net') for r in rows]
        tn = [r.get('trust_net') for r in rows]
        mb = [r.get('margin_balance') for r in rows]
        # 這一檔到底有沒有法人資料(⛔ 沒有就整檔跳過,不要拿 None 當 0)
        if sum(1 for x in fn if x) < 200:
            continue
        nfile += 1

        last_fire = defaultdict(lambda: -999)

        def fire(name, i):
            if i - last_fire[name] < DEDUP:
                return
            last_fire[name] = i
            for h in HORIZONS:
                r = fwd(closes, i, h)
                if r is None:
                    continue
                d0, d1 = dates[i], dates[i + h]
                if d0 not in idx or d1 not in idx or not idx[d0]:
                    continue
                mr = (idx[d1] - idx[d0]) / idx[d0] * 100.0
                buckets[name][h].append(r - mr)
                dated[name][h].append((d0, r - mr))

        for i in range(60, len(rows) - max(HORIZONS)):
            # ── 對照組:每一個交易日(⛔ 不抽樣)──
            fire('(對照)所有交易日', i)

            f0 = fn[i]
            if f0 is None:
                continue

            # 連賣天數(往前數,⛔ 用 i-1 起算,不含今天)
            sell_run = 0
            for k in range(i - 1, max(i - 15, 0), -1):
                v = fn[k]
                if v is not None and v < 0:
                    sell_run += 1
                else:
                    break
            buy_run = 0
            for k in range(i - 1, max(i - 15, 0), -1):
                v = fn[k]
                if v is not None and v > 0:
                    buy_run += 1
                else:
                    break

            # ── A/B:外資「認錯回補」= 連賣 N 天之後第一天轉買 ──
            if f0 > 0 and sell_run >= 3:
                fire('A 外資連賣3天↑後轉買', i)
            if f0 > 0 and sell_run >= 5:
                fire('B 外資連賣5天↑後轉買', i)
            if f0 > 0 and sell_run >= 8:
                fire('C 外資連賣8天↑後轉買', i)

            # ── D:反向檢定(連買之後轉賣)—— 要得到相反結果才算真訊號 ──
            if f0 < 0 and buy_run >= 3:
                fire('D 反向·外資連買3天↑後轉賣', i)

            # ── E/F:順勢 ──
            if f0 > 0 and buy_run >= 3:
                fire('E 外資連買4天(含今天)', i)
            if f0 < 0 and sell_run >= 3:
                fire('F 外資連賣4天(含今天)', i)

            # ── G:雙法人同買 ──
            t0 = tn[i]
            if f0 > 0 and t0 is not None and t0 > 0:
                fire('G 外資+投信同買', i)
            if f0 > 0 and t0 is not None and t0 > 0 and sell_run >= 3:
                fire('H 連賣後轉買 且 投信也買', i)

            # ── I:散戶退場(融資減)+ 外資買 ──
            if f0 > 0 and mb[i] and mb[i - 5]:
                if mb[i] < mb[i - 5] * 0.97:
                    fire('I 外資買 且 融資5日減3%↑', i)

    # ── 輸出 ──
    base = {h: statistics.median(buckets['(對照)所有交易日'][h] or [0]) for h in HORIZONS}
    bn = len(buckets['(對照)所有交易日'][HORIZONS[0]])
    print(f'📊 實測 {nfile} 檔(有法人資料的)・對照組 {bn:,} 筆')
    print(f'   對照組中位超額:' + ' ・'.join(f'{h}日 {base[h]:+.2f}%' for h in HORIZONS))
    print()
    hdr = f'{"訊號":<28}{"n":>8}' + ''.join(f'{str(h)+"日邊際":>12}' for h in HORIZONS) + f'{"20日勝率":>10}'
    print(hdr)
    print('─' * len(hdr))
    for name in sorted(buckets):
        if name.startswith('(對照)'):
            continue
        v = buckets[name]
        n = len(v[HORIZONS[0]])
        if n < 300:
            continue
        cells = ''
        for h in HORIZONS:
            m = statistics.median(v[h]) - base[h] if v[h] else 0
            cells += f'{m:>+11.2f}pp'
        w20 = sum(1 for x in v[20] if x > 0) / max(len(v[20]), 1) * 100
        print(f'{name:<28}{n:>8,}{cells}{w20:>9.1f}%')
    bw = sum(1 for x in buckets['(對照)所有交易日'][20] if x > 0) / max(bn, 1) * 100
    print(f'{"(對照)所有交易日":<28}{bn:>8,}{"":>36}{bw:>9.1f}%   ⭐ 基準勝率(⛔ 不是 50%)')

    # ── 前後半段檢定:只有兩段同向才算數 ──
    print('\n🔬 前後半段各自檢定(20 日邊際;⛔ 兩段不同向 = 不成立)')
    mid = None
    alld = sorted(d for d, _ in dated['(對照)所有交易日'][20])
    if alld:
        mid = alld[len(alld) // 2]
    print(f'   分界日:{mid}')
    for name in sorted(dated):
        if name.startswith('(對照)') or len(buckets[name][20]) < 300:
            continue
        out = []
        for lo, hi, tag in ((None, mid, '前半'), (mid, None, '後半')):
            ev = [r for d, r in dated[name][20] if (lo is None or d >= lo) and (hi is None or d < hi)]
            bs = [r for d, r in dated['(對照)所有交易日'][20]
                  if (lo is None or d >= lo) and (hi is None or d < hi)]
            if len(ev) < 60 or not bs:
                out.append(f'{tag} 樣本不足')
            else:
                out.append(f'{tag} {statistics.median(ev)-statistics.median(bs):+.2f}pp(n={len(ev)})')
        print(f'   {name:<28}' + ' ・'.join(out))

    # ── 拿掉「邊際最大的那一個月」還贏嗎 ──
    # ⭐ V73.2.0 的教訓:五個「贏家」的 edge 全部集中在同一個月(2026-04),
    #    拿掉就由正轉負 —— 那不是各自有效,是同一件事被數了五次。
    print('\n🔬 拿掉「貢獻最大的那一個月」之後(20 日邊際;⛔ 由正轉負 = 靠單一月份)')
    bmon = defaultdict(list)
    for d, r in dated['(對照)所有交易日'][20]:
        bmon[d[:7]].append(r)
    for name in sorted(dated):
        if name.startswith('(對照)') or len(buckets[name][20]) < 300:
            continue
        emon = defaultdict(list)
        for d, r in dated[name][20]:
            emon[d[:7]].append(r)
        # 每個月的邊際 × 該月樣本數 = 那個月對總邊際的貢獻
        contrib = {m: (statistics.median(v) - statistics.median(bmon.get(m) or [0])) * len(v)
                   for m, v in emon.items() if len(v) >= 20 and bmon.get(m)}
        if not contrib:
            continue
        worst = max(contrib, key=contrib.get)
        rest_ev = [r for d, r in dated[name][20] if d[:7] != worst]
        rest_bs = [r for d, r in dated['(對照)所有交易日'][20] if d[:7] != worst]
        if not rest_ev or not rest_bs:
            continue
        full = statistics.median(buckets[name][20]) - base[20]
        rest = statistics.median(rest_ev) - statistics.median(rest_bs)
        flag = '⛔ 靠那個月' if (full > 0 and rest <= 0) else ('✅ 仍成立' if rest > 0 else '➖')
        print(f'   {name:<28}整段 {full:+.2f}pp → 拿掉 {worst} 後 {rest:+.2f}pp   {flag}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
