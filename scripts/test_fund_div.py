#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
💰 V75.1.2 股利 TTM + 月營收累計年增(miner._div_ttm / miner._calc_revenue_ytd)

🚨 背景:`miner.py` 原本 `total_dividend_4q = sum(qdivs[-4:])` = 「近 4 **筆**」。
   季配公司剛好是一年;**半年配**的中美晶 5483 被算成兩年(12.8 元 / 配息率 174%),
   **年配**公司算成四年 → X 光機誤標「吃老本」。TWSE 官方殖利率 1.94% 反證:近一年是 1.0 + 2.5 = 3.5。
⭐ 通用:**近 N 筆 ≠ 近 N 季** —— 配息頻率不同的公司會差 2~4 倍。

⛔ 這支要擋:① 改回 `[-4:]`(半年配那組必紅)② 用公告日不用除息日 ③ 累計年增拿不完整的分母硬算
   ④ 近一年沒配息就直接回 0(年配公司資料稍舊時要退回最後一筆並標 'last')
"""
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import miner  # noqa: E402

fails = 0
def ok(name, cond, extra=''):
    global fails
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:200]}")
    if not cond:
        fails += 1

ASOF = date(2026, 9, 9)
Q = lambda ex, cash, stock=0.0, date_=None: {'date': date_ or ex, 'ex_date': ex, 'cash': cash, 'stock': stock}

# ① 季配(近 8 筆,一年 4 筆各 1.0)→ 近一年 = 4.0(⛔ 不是 8 筆 = 8.0)
q4 = [Q('2024-10-15', 1.0), Q('2025-01-15', 1.0), Q('2025-04-15', 1.0), Q('2025-07-15', 1.0),
      Q('2025-10-15', 1.0), Q('2026-01-15', 1.0), Q('2026-04-15', 1.0), Q('2026-07-15', 1.0)]
t, m = miner._div_ttm(q4, ASOF)
ok('① 季配:近一年 4 筆 = 4.0、method 12m', abs(t - 4.0) < 1e-9 and m == '12m', (t, m))

# ② 半年配(中美晶 5483 真實紀錄):近一年 = 1.0 + 2.5 = 3.5(⛔ 舊算法 [-4:] 會給 3.0+3.5+1.0+2.5 = 10.0)
q5483 = [Q('2024-01-25', 3.5, date_='2024-02-02'), Q('2024-07-25', 5.3, date_='2024-07-31'), Q('2025-01-20', 3.0, date_='2025-01-26'),
         Q('2025-07-23', 3.5, date_='2025-07-29'), Q('2026-01-08', 1.0, date_='2026-01-14'), Q('2026-07-23', 2.5, date_='2026-07-29')]
t, m = miner._div_ttm(q5483, ASOF)
ok('② 半年配(5483 真實紀錄):近一年 = 3.5(TWSE 殖利率 1.94% × 180 元 ≈ 3.5 反證)', abs(t - 3.5) < 1e-9 and m == '12m', (t, m))
ok('②b ⛔ 不可等於舊算法的 10.0', abs(t - 10.0) > 1e-9, t)

# ③ 年配:只有 1 筆在近一年
qy = [Q('2023-07-10', 2.0), Q('2024-07-10', 2.2), Q('2025-07-10', 2.4), Q('2026-07-10', 2.6)]
t, m = miner._div_ttm(qy, ASOF)
ok('③ 年配:近一年只算最後 1 筆 = 2.6', abs(t - 2.6) < 1e-9 and m == '12m', (t, m))

# ④ 年配但資料稍舊(最後一筆 2025-07,今天 2026-09 → 近 365 天沒有)→ 退回最後一筆並標 'last'(⛔ 不可回 0 顯示成「沒配息」)
qold = [Q('2024-07-10', 2.2), Q('2025-07-10', 2.4)]
t, m = miner._div_ttm(qold, ASOF)
ok("④ 近一年沒有、550 天內有最後一筆 → 退回 2.4 並標 'last'", abs(t - 2.4) < 1e-9 and m == 'last', (t, m))
t, m = miner._div_ttm([Q('2023-07-10', 2.2)], ASOF)
ok('④b 太舊(>550 天)→ 0 且 method None', t == 0.0 and m is None, (t, m))
ok('④c 沒紀錄 → (0, None)', miner._div_ttm([], ASOF) == (0.0, None))

# ⑤ 用除息日不用公告日:公告 2025-09-20(近一年內)、除息 2025-08-20(一年前)→ ⛔ 不算
qx = [Q('2025-08-20', 5.0, date_='2025-09-20'), Q('2026-03-01', 1.0)]
t, m = miner._div_ttm(qx, ASOF)
ok('⑤ 判斷用除息日(公告日在窗內但除息日在窗外的那筆不算)', abs(t - 1.0) < 1e-9, (t, m))
# ⑤b 除息日還沒到但已公告(30 天內)→ 算進去
qf = [Q('2026-09-25', 1.5)]
t, m = miner._div_ttm(qf, ASOF)
ok('⑤b 已公告、除息日在 30 天內 → 算進近一年', abs(t - 1.5) < 1e-9 and m == '12m', (t, m))

# ⑥ 累計年增
R = lambda y, mth, v: {'revenue_year': y, 'revenue_month': mth, 'revenue': v}
rows = [R(2025, k, 100.0) for k in range(1, 13)] + [R(2026, k, 110.0) for k in range(1, 9)]
ytd, months = miner._calc_revenue_ytd(rows)
ok('⑥ 2026 1~8 月合計 880 vs 2025 同段 800 → +10.0%、8 個月', ytd == 10.0 and months == 8, (ytd, months))
rows2 = [R(2025, k, 100.0) for k in range(3, 13)] + [R(2026, k, 110.0) for k in range(1, 9)]   # 去年 1、2 月缺
ok('⑥b 去年同段缺月 → None(⛔ 不可拿不完整的分母硬算)', miner._calc_revenue_ytd(rows2) == (None, 0), miner._calc_revenue_ytd(rows2))
ok('⑥c 順序不拘(倒著餵也一樣)', miner._calc_revenue_ytd(list(reversed(rows))) == (10.0, 8))
ok('⑥d 空的 → (None, 0)', miner._calc_revenue_ytd([]) == (None, 0))

# ⑦ 接線:fetch_finmind_fundamentals 裡真的改用 _div_ttm(⛔ 不可還留著 [-4:])
src = (ROOT / 'miner.py').read_text(encoding='utf-8')
seg = src[src.index('def fetch_finmind_fundamentals'):src.index('def fetch_finmind_fundamentals') + 20000]
seg_nc = '\n'.join(l.split('#', 1)[0] for l in seg.splitlines())
ok('⑦ fetch_finmind_fundamentals 用 _div_ttm(qdivs) 算 total_dividend_4q、不再 sum(qdivs[-4:])',
   '_div_ttm(qdivs)' in seg_nc and 'qdivs[-4:]' not in seg_nc)
ok('⑦b 寫入 div_win 與 revenue_ytd_yoy', "result['div_win']" in seg_nc and "result['revenue_ytd_yoy']" in seg_nc)
fs = (ROOT / 'fund_sweep.py').read_text(encoding='utf-8')
ok('⑧ fund_sweep 存 mrh / mrev / ytd / fd / div_win 且 __status 標 mrh_unit',
   all(k in fs for k in ["entry['mrh']", "entry['mrev']", "entry['ytd']", "entry['fd']", "entry['div_win']", "'mrh_unit': '百萬'"]))

print('\n✅ FUND_DIV_PASS' if not fails else f'\n❌ FUND_DIV_FAIL {fails}')
sys.exit(1 if fails else 0)
