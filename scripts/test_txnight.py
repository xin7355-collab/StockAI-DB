#!/usr/bin/env python3
"""🌃 V79.9.8 台指期「夜盤」其實是前一天日盤 —— 採礦端要標清楚是哪一盤、哪一天。

使用者 10/30:「這兩天盤前體檢都寫很高的分數,實際開出來很差」。查下去:
  盤前分數裡「🌙 台指期夜盤」那一項,吃的是 TAIFEX OpenAPI 的期貨每日行情 ——
  那份是**前一個交易日的日盤**(10/29 早上拿到 10/28 日盤 +2.47%,10/27 早上拿到 10/22 日盤),
  而且回傳時 `date: None` → 前端當成夜盤 +1.5 分、分析師那行寫「夜盤走強」= 講錯。

修法:`fetch_taifex_tx_now` 每條路徑都標 `sess` + 那一列自己的日期;前端只有 `sess === 'night'`(真的夜盤)才算分
(index / pro 同一條,test_premkt_formula ⑥d ⑧)。
💱 V82.4.0 換掉 yfinance ^TXF=F → 期交所行情網(官方行情系統):日盤時段(台北 08:45~15:00,週一~五)問日盤 →
'live'(13:45 前)/ 'day'(當天收盤);其他時間問盤後 → 'night' = 真的夜盤,但 **score: False**
(V42.0 那條計分沒回測過 → 只顯示、⛔ 算分,等使用者決定;test_premkt_formula ⑥f)。

⛔ 釘住(走正式入口 `fetch_taifex_tx_now`,只換網路):
  ① 行情網拿不到 → OpenAPI:sess == 'day'、date == 那一列的 Date(20261028 → 2026-10-28)、est False、漲跌 % 照算
  ② OpenAPI 沒有漲跌欄 → est True,但 sess / date 照樣有
  ③ OpenAPI 那一列沒有 Date → date None(⛔ 不可編一個今天),sess 仍是 'day'
  ④ 夜間(台北 08:00)行情網盤後 → sess 'night'、score False、date = 夜盤結束那天;④b 日盤時段 → 'live' / 'day'(⛔ night);
     ④c 日盤時段但行情網停在前一天(休市)→ 退 OpenAPI;④d ⭐ 只有行情網盤後那條會回 night,而且一定 score False
  ⑤ `_taifex_openapi_tx_close_change` 回三個值(收盤, 漲跌 %, 資料日),失敗回三個 None
  INJECT=1:拿掉 sess / 把 date 寫死 None / 夜盤拿掉 score False / 日盤時段也標 night → 必紅
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
    from datetime import datetime as _RealDT, timezone as _tz, timedelta as _td

    def at(y, mo, d, hh, mm):
        """凍結「現在」(台北時間)—— fetch_taifex_tx_now 用 datetime.now(台北) 決定問日盤還是盤後。"""
        class _DT(_RealDT):
            @classmethod
            def now(cls, tz=None):
                t = _RealDT(y, mo, d, hh, mm, tzinfo=_tz(_td(hours=8)))
                return t.astimezone(tz) if tz else t.replace(tzinfo=None)
        M.datetime = _DT

    asked = []

    def mis_fail(gate, market='1'):
        asked.append(market)
        return None, '期交所行情網 斷路:HTTP 403'
    M._LQ.taifex_mis = mis_fail
    M._q_gate = lambda: None
    at(2026, 10, 29, 8, 0)

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

    # ④ 期交所行情網(盤後)= 真的夜盤 → sess 'night',但 score False(計分沒回測過,只顯示)
    NIGHT = {'price': 47000.0, 'chg': -0.35, 'ref': 47165.0, 'date': '2026-11-17', 'time': '04:59:59', 'contract': '臺指期116'}
    asked.clear()
    M._LQ.taifex_mis = lambda gate, market='1': (asked.append(market), (dict(NIGHT), ''))[1]
    at(2026, 11, 17, 8, 0)
    r4 = M.fetch_taifex_tx_now()
    ok('④ 台北 08:00 → 問盤後(MarketType 1)、sess night、score False、日期 = 夜盤結束那天',
       asked == ['1'] and r4.get('sess') == 'night' and r4.get('score') is False and r4.get('date') == '2026-11-17'
       and r4.get('chg') == -0.35 and '盤後' in str(r4.get('src')), str(r4))
    DAYQ = dict(NIGHT, date='2026-11-17', time='12:05:00', chg=0.4)
    asked.clear()
    M._LQ.taifex_mis = lambda gate, market='1': (asked.append(market), (dict(DAYQ), ''))[1]
    at(2026, 11, 17, 12, 5)
    r5 = M.fetch_taifex_tx_now()
    at(2026, 11, 17, 14, 10)
    r6 = M.fetch_taifex_tx_now()
    ok('④b 日盤時段 → 問日盤(MarketType 0):13:45 前 live、之後 day(今天收盤);⛔ 標 night、⛔ 帶 score',
       asked == ['0', '0'] and r5.get('sess') == 'live' and r6.get('sess') == 'day' and 'score' not in r5 and 'score' not in r6, f'{asked} {r5} {r6}')
    M._LQ.taifex_mis = lambda gate, market='1': (dict(DAYQ, date='2026-11-16'), '')
    M._taifex_openapi = lambda paths: (ROWS, None)
    at(2026, 11, 17, 9, 30)
    r7 = M.fetch_taifex_tx_now()
    ok('④c 日盤時段但行情網停在前一天(休市 / 還沒開)→ 退 OpenAPI 日盤(⛔ 拿昨天當盤中)',
       r7.get('sess') == 'day' and r7.get('src') == 'TAIFEX OpenAPI', str(r7))
    ok('④d ⭐ 只有行情網盤後那條會回 night,而且一定 score False(OpenAPI 三條 ⛔ night)',
       all((x or {}).get('sess') != 'night' for x in (r1, r2, r3, r5, r6, r7)) and r4.get('sess') == 'night' and r4.get('score') is False,
       str([(x or {}).get('sess') for x in (r1, r2, r3, r4, r5, r6, r7)]))

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
        'scoreon': ('**({"score": False} if sess == \'night\' else {}), ', ''),
        'allnight': ("sess = 'night' if not _day_hours else ('live' if _hm < '1345' else 'day')", "sess = 'night'"),
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
