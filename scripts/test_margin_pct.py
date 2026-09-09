#!/usr/bin/env python3
"""🔢 三率「實際數值」輸出測試(V71.8.5)。

背景:使用者提供的「台股 AI 投資評價模型」文件點出一件我原本沒做的事 ——
**同一條門檻不能量所有產業**(封測毛利 20% 是正常、IC 設計 20% 是警訊)。
要做「同業比較」就得先有**數值**,但 miner 本來只存趨勢箭頭字串
(如「62.1%→64.3%→66.2%（↑4.1pp）」),數值算完就丟掉了。

這支釘住:趨勢字串照舊不變(不可破壞既有前端),同時多存三個純數字。
"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
for _m in ('yfinance', 'pandas', 'requests'):
    if _m not in sys.modules:
        try:
            __import__(_m)
        except ImportError:
            sys.modules[_m] = types.ModuleType(_m)

import miner as M   # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + (f'  {extra}' if not cond else ''))
    if not cond:
        fails.append(name)


# ── 用**真的** fetch_finmind_fundamentals 跑,只把「打 API」那一步換成假資料 ──
#   ⛔ 不在測試裡複製一份計算邏輯(那會變成第二份真相,程式改了測試還是綠的)。
D = ['2025-09-30', '2025-12-31', '2026-03-31']
REV = [1000.0, 1000.0, 1000.0]


def rows_payload(rev, gp, op, net, dates):
    data = []
    for i, d in enumerate(dates):
        data += [
            {'date': d, 'type': 'Revenue',          'value': rev[i]},
            {'date': d, 'type': 'GrossProfit',      'value': gp[i]},
            {'date': d, 'type': 'OperatingIncome',  'value': op[i]},
            {'date': d, 'type': 'IncomeAfterTaxes', 'value': net[i]},
            {'date': d, 'type': 'EPS',              'value': 10.0 + i},
        ]
    return {'data': data}


def run(gp, op, net):
    calls = {'n': 0}

    def fake(url, timeout=20):
        calls['n'] += 1
        if 'FinancialStatements' in url:
            return rows_payload(REV, gp, op, net, D)
        return {'data': []}          # 月營收 / 股利:這支測試不管

    orig_req, orig_sleep = M.fm_request, M.time.sleep
    M.fm_request = fake
    M.time.sleep = lambda *a, **k: None
    try:
        return M.fetch_finmind_fundamentals('2330')
    finally:
        M.fm_request, M.time.sleep = orig_req, orig_sleep


# 台積電型:毛利 60→64→66.2、營益 48→52→54、淨利 40→43→45
res = run([600, 640, 662], [480, 520, 540], [400, 430, 450])
print('實際輸出:', {k: v for k, v in res.items() if 'margin' in k})
ok('① 毛利率數值 = 最新一季 66.2', abs((res.get('gross_margin_pct') or 0) - 66.2) < 0.05, str(res.get('gross_margin_pct')))
ok('① 營益率數值 = 最新一季 54.0', abs((res.get('op_margin_pct') or 0) - 54.0) < 0.05, str(res.get('op_margin_pct')))
ok('① 淨利率數值 = 最新一季 45.0', abs((res.get('net_margin_pct') or 0) - 45.0) < 0.05, str(res.get('net_margin_pct')))
ok('② 趨勢字串照舊(不可破壞既有前端與多空 F 系列因子)',
   '↑' in str(res.get('gross_margin_trend')) and '↑' in str(res.get('op_margin_trend'))
   and '↑' in str(res.get('net_margin_trend')),
   f"{res.get('gross_margin_trend')} / {res.get('op_margin_trend')}")

# 下滑型:數值要跟著變、箭頭要翻成 ↓
res2 = run([600, 560, 520], [480, 430, 380], [400, 350, 300])
ok('③ 下滑時數值正確(毛利 52.0)', abs((res2.get('gross_margin_pct') or 0) - 52.0) < 0.05, str(res2.get('gross_margin_pct')))
ok('③ 下滑時箭頭是 ↓', '↓' in str(res2.get('gross_margin_trend')), str(res2.get('gross_margin_trend')))

# 資料不足(只有 1 季)→ 不可硬寫數字,也不可 throw
res3 = run([600], [480], [400])
_r3 = run.__doc__  # noqa
ok('④ 只有 1 季時不 throw', isinstance(res3, dict))
ok('④ 只有 1 季時不可產生趨勢字串(樣本不足)', res3.get('gross_margin_trend') is None, str(res3.get('gross_margin_trend')))

print()
if fails:
    print(f'❌ MARGIN_PCT_TEST_FAIL: {fails}')
    sys.exit(1)
print('✅ MARGIN_PCT_TEST_PASS')
