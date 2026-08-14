#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔧 減資 / 分割「官方值 vs 我猜的整數倍」交叉驗證探針(V73.3.9)—— 只讀,不改任何東西。

🚨 陷阱 #21:`data/{sym}.json` 用 `auto_adjust=False`(原始價,**刻意的**,才對得上官方收盤),
   副作用是分割/減資當天會永久斷崖。`miner.py::_backadjust_splits()` 的修法是
   **從價格跳空「猜」整數倍**(2~10 或其倒數,殘差要落在漲跌停範圍內)。

⭐ FinMind 缺口探針找到官方值:`CapitalReductionReferencePrice`(減資參考價)、
   `TaiwanStockSplitPrice`(分割)、`TaiwanStockDividend` 的除權息。
   → 可以**回頭驗證我猜的對不對**。

⛔ **這支刻意只驗、不改**:`_backadjust_splits` 已上線、冪等、有 20 條測試。
   ⭐ 只有實測發現「漏抓」或「猜錯倍率」才值得動它 —— 沒問題就別動(改它的風險遠大於收益)。

📐 三種可能的結果,對應三種處置:
   ① 官方有、我也抓到,倍率一致        → ✅ 現行做法可信,⛔ 不用改
   ② 官方有、我**沒抓到**(漏)         → ⚠️ 真缺口 → 值得補(那些股票的歷史 K 線是歪的)
   ③ 我抓到、官方**沒有**(誤報)       → 🚨 最危險 —— 我把正常漲跌當成分割去「調整」了

⛔ 安全:只記「第幾把 token」,絕不印金鑰值。
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

API = 'https://api.finmindtrade.com/api/v4/data'
DATA = Path(os.getenv('DATA_DIR', 'data'))
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
CANDS = ['TaiwanStockCapitalReductionReferencePrice', 'CapitalReductionReferencePrice',
         'TaiwanStockSplitPrice', 'TaiwanStockParValueChange']


def fm(dataset, start='2015-01-01', data_id=None):
    for i in range(max(1, len(TOKENS))):
        q = {'dataset': dataset, 'start_date': start}
        if data_id:
            q['data_id'] = data_id
        if TOKENS:
            q['token'] = TOKENS[i]
        try:
            with urllib.request.urlopen(API + '?' + urllib.parse.urlencode(q), timeout=60) as r:
                j = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode('utf-8', 'replace'))
                msg = str(body.get('msg') or '')[:70]
            except Exception:
                msg = ''
            last = f'http{e.code}:{msg}'
            continue
        except Exception as e:
            last = type(e).__name__
            continue
        rows = (j or {}).get('data') or []
        if rows:
            return rows, i + 1, None
        last = 'empty'
    return None, None, locals().get('last', 'no-token')


def _d(x):
    return str(x or '').replace('/', '-')[:10]


def my_guess(rows):
    """複製 `_backadjust_splits` 的**偵測條件**(⛔ 只偵測不調整)→ 回 [(日期, 倍率)]。"""
    out = []
    for i in range(1, len(rows)):
        try:
            a = float(rows[i - 1].get('close') or 0)
            b = float(rows[i].get('close') or 0)
        except Exception:
            continue
        if a <= 0 or b <= 0:
            continue
        r = b / a
        if 0.88 <= r <= 1.12:          # 漲跌停範圍內 → 正常波動
            continue
        for m in (2, 3, 4, 5, 10):
            for cand in (m, 1.0 / m):
                if abs(r / cand - 1) < 0.12:   # 整數倍(殘差落在漲跌停內)
                    out.append((_d(rows[i].get('date')), round(cand, 4)))
                    break
            else:
                continue
            break
    return out


def main():
    if not TOKENS:
        print('❌ 沒有 FINMIND_TOKENS')
        return 1

    print('🔎 先確認官方 dataset 哪個名字是對的(⛔ 不猜,實測)')
    official = {}
    used = None
    for ds in CANDS:
        rows, tok, err = fm(ds)
        if rows:
            print(f'  ✅ {ds}:{len(rows):,} 列(第 {tok} 把)・欄位 {sorted(rows[0].keys())}')
            used = used or ds
            for r in rows:
                sid = str(r.get('stock_id') or '')
                d = _d(r.get('date'))
                if sid and d:
                    official.setdefault(sid, {})[d] = r
        else:
            print(f'  ❌ {ds}:{err}')
    if not official:
        print('❌ 一個官方 dataset 都拿不到 → 這一輪無效(⛔ 不可當成「我猜的都對」)')
        return 1
    print(f'\n📊 官方事件:{len(official)} 檔 ・共 {sum(len(v) for v in official.values()):,} 筆\n')

    files = sorted(p for p in DATA.glob('*.json') if p.stem.isdigit() and len(p.stem) == 4)
    if not files:
        print('❌ data/ 沒有個股 JSON → 中止')
        return 1

    stat = Counter()
    miss, extra, mismatch = [], [], []
    for p in files:
        try:
            rows = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(rows, list) or len(rows) < 60:
            continue
        sym = p.stem
        dates = {_d(r.get('date')) for r in rows}
        mine = {d: m for d, m in my_guess(rows)}
        off = {d: r for d, r in (official.get(sym) or {}).items() if d in dates}

        for d in off:
            if d in mine:
                stat['both'] += 1
            else:
                # ⚠️ 官方有事件、我沒偵測到 —— 但小幅減資本來就不會造成 2 倍以上跳空,
                #    所以要看**實際跳空幅度**才知道是不是真的漏(⛔ 不可一律當成漏)
                stat['official_only'] += 1
                miss.append((sym, d))
        for d in mine:
            if d not in off:
                stat['mine_only'] += 1
                extra.append((sym, d, mine[d]))

    print(f'📐 比對結果(以官方 `{used}` 為準)')
    print(f'   ✅ 兩邊都有        : {stat["both"]:,}')
    print(f'   ⚠️ 官方有、我沒抓到 : {stat["official_only"]:,}')
    print(f'   🚨 我抓到、官方沒有 : {stat["mine_only"]:,}  ← 最危險(可能把正常漲跌當分割調整了)')
    if stat['both'] + stat['mine_only']:
        print(f'   → 我抓到的裡面,有官方背書的比例:'
              f'{stat["both"]/(stat["both"]+stat["mine_only"])*100:.1f}%')

    print('\n🚨 我抓到但官方沒有的(前 15 筆,⛔ 要人工讀原始碼驗真偽):')
    for s, d, m in extra[:15]:
        print(f'   {s} {d} 倍率 {m}')
    print('\n⚠️ 官方有但我沒抓到的(前 15 筆):')
    for s, d in miss[:15]:
        print(f'   {s} {d}')

    print('\n⛔ 處置原則(⛔ 別看到數字就急著改 `_backadjust_splits`):')
    print('   ・「我抓到、官方沒有」多半是**除權息**或**興櫃無漲跌停**造成的大跳空 —— 要逐筆看')
    print('   ・「官方有、我沒抓到」要先看**實際跳空幅度**:小幅減資不會造成 2 倍跳空,那不算漏')
    print('   ・現行函式冪等且有 20 條測試 → **只有確認真的漏抓/猜錯**才值得動它')
    return 0


if __name__ == '__main__':
    sys.exit(main())
