#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏷️ V75.1.4 `miner.build_stock_names` —— 前端股名的離線來源。

🚨 背景:前端 `fetchStockList` 本來**只靠 FinMind 匿名 API**(而且那支 URL 連 token 都沒帶),
   它被擋之後 `allStockList` 變空 → 名字全變代號(使用者截圖:009816 印兩次),
   ⛔ 更嚴重的是 `_filterStockList` 清單空就 return [] → **搜尋整個失效**、零錯誤訊息。

⛔ 釘死六件事:
  ① 官方公司表(`_COMPANY_NAME`,零額外 API)要進表,而且帶產業別
  ② ETF 從 etf_tracking.json 保底,⛔ 只補官方表沒有的(不覆蓋)
  ③ 🚧 <1500 檔 ⛔ 不覆寫舊檔(半份表比沒有更糟)
  ④ 合併舊檔:這輪某來源掛掉,舊名字要留著
  ⑤ `src` 分類統計要誠實(0 檔要說得出為什麼)
  ⑥ ETF 太少要**主動示警**(官方表一檔 ETF 都沒有,這是已知缺口)

⚠️ 測試在暫存目錄跑,⛔ 不可污染 repo 的 data/。
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

fails = 0


def ok(name, cond, extra=''):
    global fails
    print(f"{'✅' if cond else '❌'} {name}" + ('' if cond else f"  {str(extra)[:220]}"))
    if not cond:
        fails += 1


def run(company_names, etf_rows=None, old=None, capture=False):
    """在乾淨的暫存 cwd 裡跑一次 build_stock_names,回 (寫進去的檔數, 產物 dict or None, stdout)."""
    import io
    import contextlib
    import miner

    with tempfile.TemporaryDirectory() as td:
        cwd = os.getcwd()
        try:
            os.chdir(td)
            Path('data').mkdir(exist_ok=True)
            if etf_rows is not None:
                Path('data/etf_tracking.json').write_text(
                    json.dumps({'concentration': etf_rows, 'etfs': []}, ensure_ascii=False), encoding='utf-8')
            if old is not None:
                Path('data/stock_names.json').write_text(
                    json.dumps({'names': old}, ensure_ascii=False), encoding='utf-8')

            miner._COMPANY_NAME = dict(company_names)
            imap = {k: '半導體業' for k in company_names if k.startswith('2')}

            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                n = miner.build_stock_names(imap)
            out = None
            _p = Path('data/stock_names.json')
            if _p.exists():
                out = json.loads(_p.read_text(encoding='utf-8'))
            return n, out, buf.getvalue()
        finally:
            os.chdir(cwd)


# ── 測資:2,000 檔一般股(過門檻)──
BIG = {str(1000 + i): f'股{i}' for i in range(2000)}
BIG['2330'] = '台積電'
BIG['5483'] = '中美晶'

# ══ ① 官方表進表 + 帶產業別 ══
n, out, log = run(BIG)
ok('① 官方公司表的名字有寫進去', n >= 2000 and out and out['names'].get('2330', [None])[0] == '台積電',
   f"n={n} 2330={out and out['names'].get('2330')}")
ok('①b 產業別跟著帶上(前端 industry_category 那 5 個讀取點要用)',
   out and out['names']['2330'][1] == '半導體業', out and out['names'].get('2330'))

# ══ ② ETF 保底 ══
n2, out2, _ = run(BIG, etf_rows=[{'symbol': '0050', 'name': '元大台灣50'},
                                 {'symbol': '2330', 'name': '不可覆蓋官方的'}])
ok('② ETF 從 etf_tracking 保底進來', out2 and out2['names'].get('0050', [None])[0] == '元大台灣50',
   out2 and out2['names'].get('0050'))
ok('②b ⛔ 不可覆蓋官方表已有的(官方為準)',
   out2 and out2['names']['2330'][0] == '台積電', out2 and out2['names'].get('2330'))
ok('②c src 統計要分得出各來源幾檔',
   out2 and out2['src']['official'] >= 2000 and out2['src']['etf_tracking'] == 1, out2 and out2['src'])

# ══ ③ 🚧 <1500 不覆寫(核心守門)══
OLD = {'9999': ['舊股名', ''], '8888': ['另一檔', '']}
n3, out3, log3 = run({'1101': '台泥'}, old=OLD)
ok('③ 🚧 只有 1 檔 → ⛔ 不覆寫,回 0', n3 == 0, f"n={n3}")
ok('③b ⛔ 舊檔要原封不動留著(⛔ 不可被半份表洗掉)',
   out3 and out3['names'] == OLD, out3 and out3.get('names'))
ok('③c 不覆寫時要說出為什麼 + 印來源分佈', '不覆寫' in log3 and 'official' in log3, log3[-200:])

# ══ ④ 合併舊檔 ══
n4, out4, _ = run(BIG, old={'7777': ['老朋友', ''], '2330': ['舊的台積電', '']})
ok('④ 舊檔裡官方沒有的要留著', out4 and out4['names'].get('7777', [None])[0] == '老朋友',
   out4 and out4['names'].get('7777'))
ok('④b ⛔ 舊值不可蓋掉這輪的新值', out4 and out4['names']['2330'][0] == '台積電',
   out4 and out4['names'].get('2330'))
ok('④c merged_old 統計正確', out4 and out4['src']['merged_old'] == 1, out4 and out4['src'])

# ══ ⑤⑥ 誠實揭露 ══
ok('⑤ 產物要標 updated / n / n_etf / caveat',
   out and all(k in out for k in ('updated', 'n', 'n_etf', 'src', 'caveat')), out and list(out.keys()))
ok('⑥ 🚨 ETF 太少要主動示警(官方表一檔 ETF 都沒有,這是已知缺口)',
   'ETF 只有' in log, log[-260:])
ok('⑥b caveat 要講明「官方表沒有 ETF」', out and 'ETF' in out['caveat'], out and out.get('caveat'))

# ══ ⑦ 壞掉的 etf_tracking ⛔ 不可讓整支炸掉 ══
import tempfile as _tf
with _tf.TemporaryDirectory() as td:
    cwd = os.getcwd()
    try:
        os.chdir(td)
        Path('data').mkdir()
        Path('data/etf_tracking.json').write_text('{壞掉的 json', encoding='utf-8')
        import io, contextlib, miner
        miner._COMPANY_NAME = dict(BIG)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            n7 = miner.build_stock_names({})
        ok('⑦ etf_tracking 壞掉 → 照樣產出(只印警告)', n7 >= 2000, f"n={n7}")
        ok('⑦b 而且要把失敗印出來(⛔ 不可靜默)', 'ETF 名字保底讀取失敗' in buf.getvalue(), buf.getvalue()[-200:])
    finally:
        os.chdir(cwd)

print(f"\n{'❌ %d 條失敗' % fails if fails else '✅ 全部通過'}")
sys.exit(1 if fails else 0)
