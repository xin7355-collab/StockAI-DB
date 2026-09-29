#!/usr/bin/env python3
"""🎣 V78.0.0 screener 新欄 `mcap`(億元)= 收盤 × 集保總股數 ÷ 1e8 —— 股海釣手魚的大小。
⛔ 沒有總股數 / 收盤 → None(不硬湊);欄位必須排在最後(前端與其它測試吃的是欄名,但舊產物的欄序不可被打亂)。
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import screener_miner as S

fails = []
def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else '  ' + str(extra)))
    if not cond: fails.append(name)

f = S._mcap_of
ok('① 台積電級:1,000 元 × 259.3 億股 → 259,300 億', f(1000, 25_930_000_000) == 259300.0, f(1000, 25_930_000_000))
ok('② 小型股:25 元 × 5,000 萬股 → 12.5 億', f(25, 50_000_000) == 12.5, f(25, 50_000_000))
ok('③ 沒有總股數 → None', f(100, 0) is None and f(100, None) is None)
ok('④ 沒有收盤 / 壞值 → None', f(None, 1e9) is None and f('x', 1e9) is None and f(float('nan'), 1e9) is None)
ok('⑤ 欄位排在最後(⛔ 不打亂既有欄序)', S.COLS[-1] == 'mcap', S.COLS[-3:])
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'screener_miner.py'), encoding='utf8').read()
ok('⑥ main 裡真的有寫進 mcap(只寫 helper 不接 = 沒做)', "v[CI['mcap']] = _mcap_of(" in src)
print('\n❌ %d 條失敗' % len(fails) if fails else '\n✅ SCREENER_MCAP_PASS')
sys.exit(1 if fails else 0)
