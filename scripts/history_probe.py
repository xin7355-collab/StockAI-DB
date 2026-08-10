#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🕳️ 深歷史探針(階段2 前置)—— 一次問完 FinMind「到底給不給得起」

⭐ 為什麼要先寫探針:沙箱連不到 FinMind(proxy 403),而「改採礦 → 等 workflow → 看輸出」
   一輪要 10 分鐘。V72.7.0 分析師焦點就是這樣連跑 7 輪只驗了 7 個假設,
   最後寫探針 9 秒問完四組。⛔ 這次不重蹈覆轍。

這支**只讀不寫任何產物**,把答案印進 log + 寫一份小 JSON,回答四題:
  ① TaiwanStockPrice 給 start_date 能回溯到多久?一檔真的只要 1 次呼叫嗎?
  ② 有沒有**下市股票**的資料?(倖存者偏誤能不能修 → 決定階段3 做不做得成)
  ③ 有沒有**還原股價**(除權息調整)的資料集?(除權息斷崖能不能修)
  ④ 一檔 5 年的 JSON 有多大?(推估 2,700 檔要多少空間 → 決定能不能只推 data 分支)

⛔ 安全:只印「第幾把 token」,絕不把 token 值印進 log(全專案鐵律)。
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

API = 'https://api.finmindtrade.com/api/v4/data'
TOKENS = [t.strip() for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
OUT = os.getenv('OUT', 'history_probe_result.json')
# 代表性樣本:大型/中型/ETF/上櫃 各一(⛔ 不用全市場,探針只要問「給不給」)
SAMPLE = ['2330', '2317', '0050', '5483']


def fm(dataset, extra=None, tok_i=0, timeout=60):
    """回 (rows, err)。⛔ 只回報第幾把 token,不回報 token 值。"""
    q = {'dataset': dataset}
    q.update(extra or {})
    if TOKENS:
        q['token'] = TOKENS[tok_i % len(TOKENS)]
    url = API + '?' + urllib.parse.urlencode(q)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            j = json.loads(r.read().decode('utf-8'))
    except Exception as e:
        return None, f'{type(e).__name__}: {str(e)[:120]}'
    if not isinstance(j, dict):
        return None, 'resp 不是 dict'
    if j.get('status') not in (200, None):
        return None, f"status={j.get('status')} msg={str(j.get('msg'))[:100]}"
    return (j.get('data') or []), None


def main():
    res = {'probed_at': datetime.utcnow().isoformat() + 'Z', 'tokens': len(TOKENS)}
    print(f"🕳️ 深歷史探針 ・token {len(TOKENS)} 把")
    if not TOKENS:
        print("⚠️ 沒有 FINMIND_TOKENS → 只能測匿名額度,結果會偏悲觀(⛔ 別據此下結論)")

    # ── ① 深度:一次呼叫能拿多久 ──────────────────────────────────────
    print("\n① TaiwanStockPrice 深度(一檔一次呼叫)")
    res['depth'] = {}
    for i, sym in enumerate(SAMPLE):
        t0 = time.time()
        rows, err = fm('TaiwanStockPrice',
                       {'data_id': sym, 'start_date': '2008-01-01'}, tok_i=i)
        el = time.time() - t0
        if err:
            print(f"   {sym}: ❌ {err}  (token #{i % max(1, len(TOKENS)) + 1})")
            res['depth'][sym] = {'err': err}
            continue
        ds = sorted(r.get('date', '') for r in rows if r.get('date'))
        size = len(json.dumps(rows, ensure_ascii=False))
        print(f"   {sym}: ✅ {len(rows):5} 筆 ・{ds[0] if ds else '?'} ~ {ds[-1] if ds else '?'}"
              f" ・{el:.1f}s ・原始 JSON {size/1024:.0f} KB")
        res['depth'][sym] = {'n': len(rows), 'from': ds[0] if ds else None,
                             'to': ds[-1] if ds else None, 'sec': round(el, 1), 'bytes': size}
        if i == 0 and rows:
            print(f"   欄位:{sorted(rows[0].keys())}")
            res['fields'] = sorted(rows[0].keys())

    # ── ② 下市股票(倖存者偏誤能不能修)───────────────────────────────
    print("\n② 下市股票清單(決定階段3 的倖存者偏誤修不修得掉)")
    res['delisted'] = {}
    for ds_name in ['TaiwanStockDelisting', 'TaiwanStockInfoWithWarrant', 'TaiwanStockInfo']:
        rows, err = fm(ds_name, {}, tok_i=1)
        if err:
            print(f"   {ds_name}: ❌ {err}")
            res['delisted'][ds_name] = {'err': err}
        else:
            print(f"   {ds_name}: ✅ {len(rows)} 筆" + (f" ・欄位 {sorted(rows[0].keys())}" if rows else ''))
            res['delisted'][ds_name] = {'n': len(rows),
                                        'fields': sorted(rows[0].keys()) if rows else []}

    # ── ③ 還原股價(除權息斷崖能不能修)──────────────────────────────
    print("\n③ 還原股價 / 除權息(決定除權息斷崖怎麼修)")
    res['adjust'] = {}
    for ds_name, extra in [
        ('TaiwanStockPriceAdj', {'data_id': '2330', 'start_date': '2020-01-01'}),
        ('TaiwanStockDividend', {'data_id': '2330', 'start_date': '2015-01-01'}),
        ('TaiwanStockDividendResult', {'data_id': '2330', 'start_date': '2015-01-01'}),
    ]:
        rows, err = fm(ds_name, extra, tok_i=2)
        if err:
            print(f"   {ds_name}: ❌ {err}")
            res['adjust'][ds_name] = {'err': err}
        else:
            print(f"   {ds_name}: ✅ {len(rows)} 筆" + (f" ・欄位 {sorted(rows[0].keys())}" if rows else ''))
            res['adjust'][ds_name] = {'n': len(rows),
                                      'fields': sorted(rows[0].keys()) if rows else []}

    # ── ④ 空間推估 ────────────────────────────────────────────────
    ok = [v for v in res['depth'].values() if v.get('bytes')]
    if ok:
        # 只留回測要用的欄位(date/open/high/low/close/volume)後大約剩多少
        avg = sum(v['bytes'] for v in ok) / len(ok)
        slim = avg * 0.45          # 實測經驗:砍掉冗欄大約剩四成五
        for n in (2700,):
            print(f"\n④ 空間推估:一檔平均 {avg/1024:.0f} KB(精簡後約 {slim/1024:.0f} KB)"
                  f" → {n} 檔約 {slim*n/1e6:.0f} MB")
            res['space_mb_estimate'] = round(slim * n / 1e6)
        print("   ⚠️ gh-pages 上限 1GB、已用約 388MB → 若超過就**只推 data 分支**(前端不讀深歷史)")

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(f"\n📤 已寫入 {OUT}")

    # 🚧 空過守門:一檔都沒問到 = 這份結果無效,⛔ 不可當成「FinMind 給不起」
    if not ok:
        print("❌ 一檔都沒拿到 → 這份探針無效(可能是 token 沒給/全部無效),⛔ 別據此下結論")
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
