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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from miner import _backadjust_splits   # ⭐ 呼叫真的那支,⛔ 不複製判定邏輯

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


def leftover_cliff(rows):
    """⭐ 找「**還殘留在資料裡**的物理不可能跳空」= `_backadjust_splits` 沒修好的地方。

    🚨 這是本探針的**第二次方法論修正**,兩次都值得寫下來:
      ① 第一版**複製了一份判定條件** → 違反「⛔ 不產生第二份真相」。
         後果立刻出現:報「吻合 0.0%」,而那 47 筆裡 40 幾筆日期都是 **2023-06-12**
         —— 那是 `data/*.json` 的資料**起點**,不是分割。
      ② 第二版改成「呼叫真函式再跑一次看它抓什麼」→ **一樣測不到東西**:
         `data` 分支的資料**每天採礦時已經調整過了**,而那支是**冪等**的
         → 再跑一次本來就不該有動作(實測 0050/2330 都回 `[]`)。
         ⭐ 教訓:**驗證一個「已經套用過的修正」,不能再跑一次它** ——
            要去看「**修完之後還剩下什麼**」。

    → 所以這裡改成找**事實**(不是重跑判定):相鄰交易日(日期差 ≤5 天)漲跌超過
      ±12%(台股上限 ±10%,留 2% 緩衝)= 物理上不可能的真實漲跌。
      ⛔ 這不是「第二份判定邏輯」—— 它不做任何調整決策,只回報「這裡還是斷的」。
    """
    out = []
    for i in range(1, len(rows)):
        d0, d1 = _d(rows[i - 1].get('date')), _d(rows[i].get('date'))
        if not d0 or not d1:
            continue
        try:
            from datetime import date as _dt
            y0 = _dt(*map(int, d0.split('-')))
            y1 = _dt(*map(int, d1.split('-')))
            if (y1 - y0).days > 5:      # 中間停牌很久 → 不算(那是缺資料不是分割)
                continue
            a1 = float(rows[i - 1].get('close') or 0)
            b1 = float(rows[i].get('close') or 0)
        except Exception:
            continue
        if a1 <= 0 or b1 <= 0:
            continue
        r = b1 / a1
        if 0.88 <= r <= 1.12:
            continue
        out.append((d1, round(r, 3)))
    return out, None


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
        ev_pairs, err = leftover_cliff(rows)
        ev = [d for d, _ in (ev_pairs or [])]
        ratio = {d: rr for d, rr in (ev_pairs or [])}
        if err:
            stat['detect_fail'] += 1
            continue
        mine = {d: 1 for d in (ev or [])}
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
                extra.append((sym, d, ratio.get(d)))

    print(f'📐 **殘留斷崖** vs 官方減資清單(以 `{used}` 為準)\n   ⭐ 這裡的「我抓到」= **修完之後還剩下的斷崖**,不是重跑判定')
    print(f'   🚨 官方有 + 還是斷的 : {stat["both"]:,}  ← **真漏抓**,最該修')
    print(f'   ✅ 官方有 + 已修平    : {stat["official_only"]:,}  ← 現行函式修好的')
    print(f'   🚨 殘留斷崖、官方沒有: {stat["mine_only"]:,}  ← 可能是除權息/興櫃,要逐筆看')
    if stat['both'] + stat['mine_only']:
        print(f'   → 我抓到的裡面,有官方背書的比例:'
              f'{stat["both"]/(stat["both"]+stat["mine_only"])*100:.1f}%')

    print('\n🚨 我抓到但官方沒有的(前 15 筆,⛔ 要人工讀原始碼驗真偽):')
    for s, d, m in extra[:15]:
        print(f'   {s} {d} 跳空 ×{m}')
    print('\n⚠️ 官方有但我沒抓到的(前 15 筆):')
    for s, d in miss[:15]:
        print(f'   {s} {d}')

    print('\n⛔ 怎麼讀這份報告(⛔ 別看到數字就急著改 `_backadjust_splits`):')
    print('   ・「官方有 + 已修平」越多 = 現行函式**做得越好**(那是好消息不是壞消息)')
    print('   ・「官方有 + 還是斷的」才是**真漏抓** → 這些股票的歷史 K 線目前是歪的')
    print('   ・「殘留斷崖、官方沒有」多半是**除權息**(不該調整,那是真實除權)或興櫃 → 逐筆看')
    print('   ・現行函式冪等且有 20 條測試 → **只有確認真的漏抓**才值得動它')
    return 0


if __name__ == '__main__':
    sys.exit(main())
