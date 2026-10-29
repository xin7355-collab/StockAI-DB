#!/usr/bin/env python3
"""🌃 V79.9.8 台指期「夜盤」其實是前一天日盤 —— 採礦端要標清楚是哪一盤、哪一天。

使用者 10/30:「這兩天盤前體檢都寫很高的分數,實際開出來很差」。查下去:
  盤前分數裡「🌙 台指期夜盤」那一項,吃的是 TAIFEX OpenAPI 的期貨每日行情 ——
  那份是**前一個交易日的日盤**(10/29 早上拿到 10/28 日盤 +2.47%,10/27 早上拿到 10/22 日盤),
  而且回傳時 `date: None` → 前端當成夜盤 +1.5 分、分析師那行寫「夜盤走強」= 講錯。

修法:`fetch_taifex_tx_now` 每條路徑都標 `sess`('yf' 盤中 / 'day' 日線或 OpenAPI 日盤)+ 那一列自己的日期;
前端只有 `sess === 'night'`(真的夜盤)才算分(index / pro 同一條,test_premkt_formula ⑥d ⑧)。

⛔ 釘住(走正式入口 `fetch_taifex_tx_now`,只換網路):
  ① yfinance 兩條都失敗 → OpenAPI:sess == 'day'、date == 那一列的 Date(20261028 → 2026-10-28)、est False、漲跌 % 照算
  ② OpenAPI 沒有漲跌欄 → est True,但 sess / date 照樣有
  ③ OpenAPI 那一列沒有 Date → date None(⛔ 不可編一個今天),sess 仍是 'day'
  ④ ⭐ 決定性對照:⛔ 任何一條路徑都不可以回 sess == 'night'(現在沒有真的夜盤來源)
  ⑤ `_taifex_openapi_tx_close_change` 回三個值(收盤, 漲跌 %, 資料日),失敗回三個 None
  INJECT=1:拿掉 sess / 把 date 寫死 None → 必紅
"""
import os
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault('SKIP_GLOBAL', '1')
for _m in ('yfinance',):
    if _m not in sys.modules:
        _s = types.ModuleType(_m)
        _s.Ticker = lambda *a, **k: None
        sys.modules[_m] = _s

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / 'macro_miner.py').read_text(encoding='utf-8')


def load(src):
    """把(可能被注入過的)macro_miner 原始碼當成一個新模組載入。"""
    mod = types.ModuleType('macro_miner_t')
    mod.__file__ = str(ROOT / 'macro_miner.py')
    exec(compile(src, str(ROOT / 'macro_miner.py'), 'exec'), mod.__dict__)
    return mod


def run(src, quiet=False):
    fails = []

    def ok(name, cond, extra=''):
        if not quiet:
            print(f"{'✅' if cond else '❌'} {name}" + (f'  {extra}' if not cond else ''))
        if not cond:
            fails.append(name)

    M = load(src)

    # yfinance 兩條都失敗(盤中 _fetch_yf_future + 日線 Ticker)
    def _yf_fail(*a, **k):
        raise RuntimeError('沙箱沒有 yfinance')
    M._fetch_yf_future = _yf_fail
    _fake_yf = types.ModuleType('yfinance')
    _fake_yf.Ticker = _yf_fail
    sys.modules['yfinance'] = _fake_yf

    ROWS = [
        {'Contract': 'TX', 'ContractMonth(Week)': '202611', 'Date': '20261028',
         'Last': '47,244', 'Change': '1,139', 'OpenInterest': '95000'},
        {'Contract': 'TX', 'ContractMonth(Week)': '202610W5', 'Date': '20261028',
         'Last': '47,200', 'Change': '1,100', 'OpenInterest': '120000'},     # 週契約:要被排除
        {'Contract': 'MTX', 'ContractMonth(Week)': '202611', 'Date': '20261028',
         'Last': '47,240', 'Change': '1,130', 'OpenInterest': '999999'},     # 小台:要被排除
    ]
    M._taifex_openapi = lambda paths: (ROWS, None)
    r1 = M.fetch_taifex_tx_now()
    ok('① OpenAPI 日盤:sess == day、date == 那一列的日期、est False、漲跌 % 照算',
       r1.get('sess') == 'day' and r1.get('date') == '2026-10-28' and r1.get('est') is False
       and abs((r1.get('chg') or 0) - round(1139 / (47244 - 1139) * 100, 2)) < 1e-9 and r1.get('price') == 47244.0, str(r1))

    rows2 = [{k: v for k, v in ROWS[0].items() if k != 'Change'}]
    M._taifex_openapi = lambda paths: (rows2, None)
    r2 = M.fetch_taifex_tx_now()
    ok('② 沒有漲跌欄 → est True,sess / date 照樣有', r2.get('est') is True and r2.get('sess') == 'day' and r2.get('date') == '2026-10-28', str(r2))

    rows3 = [{k: v for k, v in ROWS[0].items() if k != 'Date'}]
    M._taifex_openapi = lambda paths: (rows3, None)
    r3 = M.fetch_taifex_tx_now()
    ok('③ 那一列沒有 Date → date None(⛔ 不可編一個今天),sess 仍是 day', r3.get('date') is None and r3.get('sess') == 'day', str(r3))

    # ④ 盤中那條(yfinance 30 分 K)成功 → sess 'yf';日線那條成功 → sess 'day';⛔ 任何一條都不是 'night'
    M._fetch_yf_future = lambda *a, **k: (47000.0, -0.35, None)
    M._YF_LAST_DATE = {'^TXF=F': '2026-10-29'}
    r4 = M.fetch_taifex_tx_now()
    ok('④ ⭐ 盤中那條:sess == yf(⛔ 不可自稱 night)', r4.get('sess') == 'yf' and r4.get('sess') != 'night', str(r4))
    ok('④b ⛔ 三條路徑沒有一條回 night(現在沒有真的夜盤來源 → 盤前分數這一項不計分)',
       all((x or {}).get('sess') != 'night' for x in (r1, r2, r3, r4)), str([(x or {}).get('sess') for x in (r1, r2, r3, r4)]))

    M._taifex_openapi = lambda paths: (None, '全失敗')
    t = M._taifex_openapi_tx_close_change()
    M._taifex_openapi = lambda paths: (ROWS, None)
    t2 = M._taifex_openapi_tx_close_change()
    ok('⑤ `_taifex_openapi_tx_close_change` 回 (收盤, 漲跌 %, 資料日);失敗回三個 None',
       t == (None, None, None) and len(t2) == 3 and t2[0] == 47244.0 and t2[2] == '2026-10-28', f'{t} / {t2}')
    return fails


if os.environ.get('INJECT'):
    INJ = {
        'nosess': ('"date": off_d, "src": "TAIFEX OpenAPI", "sess": "day", "error": None}',
                   '"date": off_d, "src": "TAIFEX OpenAPI", "error": None}'),
        'nodate': ('return best_close, best_pct, best_date', 'return best_close, best_pct, None'),
        'night':  ('"sess": "yf", "error": None}', '"sess": "night", "error": None}'),
    }
    bad = 0
    for k, (a, b) in INJ.items():
        if a not in SRC:
            print(f'❌ 注入 {k}:找不到要改的那一行(測試過期了)'); bad += 1; continue
        f = run(SRC.replace(a, b, 1), quiet=True)
        print(f"{'✅' if f else '❌'} 注入 {k} → {'紅:' + ' / '.join(f)[:160] if f else '⛔ 全綠(這個注入沒被抓到)'}")
        if not f:
            bad += 1
    print(f'\n❌ {bad} 種注入沒被抓到' if bad else f'\n✅ {len(INJ)} 種注入全部叫得出來')
    sys.exit(1 if bad else 0)

fails = run(SRC)
print(f'\n❌ {len(fails)} 條失敗:{fails}' if fails else '\n✅ TXNIGHT_PASS(全部通過)')
sys.exit(1 if fails else 0)
