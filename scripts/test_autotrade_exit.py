#!/usr/bin/env python3
"""🚪 V74.5.4 自動下單的「出場」—— auto_trade.py 的四條規則必須跟 App/回測一字不差。

⛔ 這是**同一條公式的第二份實作**(App 是 JS、這裡是 Python)——
   CLAUDE.md 陷阱 #37 的已知妥協:語言不同沒辦法共用,所以改用測試把定義釘死。
   ⚠️ 改任何一邊都要改另一邊,而且要重跑這支。

釘住六件事:
  ① don    = 前 20 個交易日最低(⛔ 不含今天)
  ② ma5    = 近 5 日收盤均價
  ③ trail8 = 進場後最高收盤 × 0.92
  ④ atr2   = 進場後最高收盤 − 2×ATR14,ATR 用**簡單平均**(⛔ 不是 Wilder)
  ⑤ 只賣「自己買的、記在狀態檔裡的部位」(⛔ 不碰手動庫存)
  ⑥ 跨日時 `pos` ⛔ 不可跟 `done` 一起被清掉
"""
import importlib.util
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('at', ROOT / 'auto_trade.py')
at = importlib.util.module_from_spec(spec)
spec.loader.exec_module(at)
SRC = (ROOT / 'auto_trade.py').read_text(encoding='utf-8')

fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {extra}'))
    if not cond:
        fails.append(name)


# 測資自己算得出唯一答案(⛔ 別讓斷言去猜):收盤 100..139、高=收+1、低=收−1 → 每日 TR = 2
rows = [{'date': f'2026-01-{i + 1:02d}', 'open': 100 + i, 'close': 100 + i,
         'high': 101 + i, 'low': 99 + i} for i in range(40)]
n = len(rows) - 1

# 🚨 「含不含今天」要另一組測資才驗得到 —— 一路上漲時兩種算法答案一樣(陷阱 #40,
#    test_exitlines 也踩過同一個坑)→ 最後一根故意破底。
dip = [dict(r) for r in rows]
dip[-1]['low'] = 50
ok('① 唐奇安 = 前 20 個交易日最低(⛔ 不含今天)',
   at.exit_line(rows, 'don', '2026-01-01') == rows[n - 20]['low']
   and at.exit_line(dip, 'don', '2026-01-01') == rows[n - 20]['low'],
   (at.exit_line(rows, 'don', '2026-01-01'), at.exit_line(dip, 'don', '2026-01-01')))
ok('② 5 日線 = 近 5 日收盤均價',
   abs(at.exit_line(rows, 'ma5', '2026-01-01') - sum(r['close'] for r in rows[-5:]) / 5) < 1e-9)
ok('③ 移動停利 = 進場後最高收盤 × 0.92',
   abs(at.exit_line(rows, 'trail8', '2026-01-01') - 139 * 0.92) < 1e-9)
ok('④ ATR 用「近 14 日 TR 簡單平均」(⛔ 不是 Wilder)', abs(at._atr_tr14(rows, n) - 2.0) < 1e-9,
   at._atr_tr14(rows, n))
# 🚨 i=n 時剛好湊滿 14 筆 → 除以 n 與除以 14 結果相同、分不出來;
#    要用**樣本不滿 14 筆**的位置(i=8 只有 8 筆)才驗得到是不是真的取平均。
ok('④a2 樣本不滿 14 筆時要除以「實際筆數」(⛔ 不可寫死 /14)',
   abs(at._atr_tr14(rows, 8) - 2.0) < 1e-9, at._atr_tr14(rows, 8))
ok('④b ATR 追蹤 = 最高收盤 − 2×ATR', abs(at.exit_line(rows, 'atr2', '2026-01-30') - (139 - 4)) < 1e-9,
   at.exit_line(rows, 'atr2', '2026-01-30'))
ok('④c 進場日之後才算「進場後最高收盤」(⛔ 不可從頭算)',
   at.exit_line(rows, 'trail8', '2026-01-30') == at.exit_line(rows, 'trail8', '2026-01-01'),
   '一路上漲時兩者相同是對的(最高收盤都是今天)')
ok('⑤a 抱了幾個交易日用 K 棒根數算(⛔ 不用日曆天)',
   at.held_trading_days(rows, '2026-01-30') == 10, at.held_trading_days(rows, '2026-01-30'))
ok('⑤b 資料太短 → 回 None(⛔ 不硬給一個價)', at.exit_line(rows[:10], 'atr2', '2026-01-01') is None)

# ⑤ 只賣自己買的
ok('⑤c 🚨 只賣狀態檔裡的部位(⛔ 不碰手動庫存)',
   "st.get('pos')" in SRC and re.search(r"for sym, pos in list\(st\['pos'\]\.items\(\)\)", SRC) is not None)
ok('⑤d 🚨 賣單送出後立刻從狀態檔移除(⛔ 不可重複送)',
   re.search(r"st\['pos'\]\.pop\(sym, None\); save_state\(st\)", SRC) is not None)
ok('⑤e 買進時要把部位記下來(否則出場那段永遠沒東西可賣)',
   re.search(r"st\.setdefault\('pos', \{\}\)\[sym\]", SRC) is not None)
ok('⑥ 🚨 跨日時 `pos` 不可跟 `done` 一起清掉',
   re.search(r"'pos': st\.get\('pos'\) or \{\}", SRC) is not None)
ok('⑦ 出場排在買進之前(錢先回來才買得起下一檔)',
   SRC.index('先處理出場') < SRC.index('for p in picks[:MAX_PICKS]'))
ok('⑧ 停損與最長天數⛔ 不隨出場規則變(回測沒動過那兩條)',
   'MAX_HOLD_DAYS' in SRC and "pos.get('sl')" in SRC)
ok('⑨ 🔐 賣單一樣要過 DRY_RUN 煞車',
   re.search(r"if DRY_RUN:\s*\n\s*log\(\"   🧪 DRY_RUN:不送單\"\); continue", SRC) is not None)

print('\n' + ('❌ %d 條失敗' % len(fails) if fails else '✅ AUTOTRADE_EXIT_PASS(全部通過)'))
sys.exit(1 if fails else 0)
