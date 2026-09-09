#!/usr/bin/env python3
"""
📊 美股巨頭財報日 + 巨頭新聞桶(V73.9.1)測試

使用者:「輝達財報還有重點新聞,還有 google 等等巨頭的,沒有抓到資料」。

🔍 查證結果(⛔ 三件事都屬實,不是誤會):
  ① `TECH_GIANTS_SOURCES` **只有 4 個桶**(trump / 黃仁勳 / SpaceX / Kuiper)
     —— 沒有 Google、微軟、Meta、博通,也**完全沒有「財報」桶**。
  ② `GLOBAL_NEWS_SOURCES` 全是「公司/人名」導向,**沒有一條是財報導向**
     → 財報當晚的結果撈不到。
  ③ 行事曆 742 筆**全是台股法說會**,⛔ 一場美股財報都沒有。

⭐ ③ 是價值最高的缺口,而且是使用者沒說到的角度:
   **新聞是發生後才知道,財報日是可以提前知道的。**
   輝達財報當晚台股 AI 鏈整條會跳 —— 提前兩天知道才來得及調部位。

⛔ 這支要釘死的七件事:
  ① 財報事件要帶 `us_earn` 旗標(⛔ 前端靠它決定不摺疊)。
  ② 事件文字要帶**台股對應族群**(只寫「NVDA 財報」沒有可操作性)。
  ③ 🚨 前端 ⛔ 不可用關鍵字比對決定摺疊 —— 文案改個字就失效。
  ④ 拿不到資料時要回 `[]` **而且印出原因**(⛔ 不可靜默,分不出 API 改了還是連不到)。
  ⑤ 視窗外的財報日不可混進來。
  ⑥ 巨頭新聞桶要真的補上(財報 / 雲端巨頭),而且**前端要接**(⛔ 不接 = 死資料)。
  ⑦ 財報關鍵字要進白名單與分類,否則會被 `_is_tw_relevant()` 整條濾掉。
"""
import os
import re
import sys
import types
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:230]}")
    if not cond:
        fails.append(name)


# ── 用假的 yfinance 實跑(沙箱連不到 Yahoo)────────────────────────
TODAY = date.today()


class _Cal:
    def __init__(self, d):
        self.d = d

    @property
    def calendar(self):
        return {'Earnings Date': [self.d]}

    def get_earnings_dates(self, limit=12):
        raise RuntimeError('should not be needed')


class _Boom:
    @property
    def calendar(self):
        raise RuntimeError('yahoo down')

    def get_earnings_dates(self, limit=12):
        raise RuntimeError('yahoo down')


def install_yf(mapping):
    m = types.ModuleType('yfinance')
    m.Ticker = lambda t: mapping.get(t, _Boom())
    sys.modules['yfinance'] = m


import macro_miner as M  # noqa: E402

# ① ② ⑤ 正常路徑
install_yf({
    'NVDA': _Cal(TODAY + timedelta(days=3)),
    'GOOGL': _Cal(TODAY + timedelta(days=5)),
    'MU': _Cal(TODAY + timedelta(days=99)),      # ⑤ 視窗外
})
evs = M.fetch_us_earnings(window_days=21)
names = ' '.join(e['event'] for e in evs)
ok('① 抓得到財報日', len(evs) == 2, [e['event'] for e in evs])
ok('①b 🚨 每一筆都要帶 us_earn 旗標(前端靠它決定不摺疊)',
   all(e.get('us_earn') is True for e in evs), evs)
ok('②  事件文字要帶**台股對應族群**(⛔ 只寫「NVDA 財報」沒有可操作性)',
   '2382' in names or '廣達' in names, names)
ok('②b 輝達/台積電ADR/博通/美光要標 high(對台股是宏觀等級)',
   [e for e in evs if 'NVDA' in e['event']][0]['severity'] == 'high', evs)
ok('⑤ ⛔ 視窗外(99 天後)的不可混進來', 'MU' not in names and '美光' not in names, names)
ok('⑤b 依日期排序', [e['date'] for e in evs] == sorted(e['date'] for e in evs), evs)

# ④ 全掛掉:要回 [] 而且印出原因
install_yf({})
import io
import contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    evs2 = M.fetch_us_earnings()
ok('④ 全部拿不到 → 回 [](⛔ 不可 throw)', evs2 == [], evs2)
ok('④b 🚨 但要印出原因(⛔ 靜默的話分不出「API 改了」還是「這台機器連不到」)',
   '失敗' in buf.getvalue() and 'NVDA' in buf.getvalue(), buf.getvalue()[:200])

# 沒有 yfinance 也不可炸
sys.modules['yfinance'] = None
_real_import = __builtins__['__import__'] if isinstance(__builtins__, dict) else __builtins__.__import__
sys.modules.pop('yfinance')
sys.modules['yfinance'] = types.ModuleType('broken')
del sys.modules['yfinance']
with contextlib.redirect_stdout(io.StringIO()):
    try:
        import builtins
        _o = builtins.__import__

        def _bad(name, *a, **k):
            if name == 'yfinance':
                raise ImportError('nope')
            return _o(name, *a, **k)
        builtins.__import__ = _bad
        evs3 = M.fetch_us_earnings()
    finally:
        builtins.__import__ = _o
ok('④c 連 yfinance 都沒有也要回 [](⛔ 不可讓整個行事曆掛掉)', evs3 == [], evs3)

# ── ③ 前端:⛔ 不可用關鍵字決定摺疊 ───────────────────────────────
IDX = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
m = re.search(r'const isEarnings = ev => (.+?);', IDX)
ok('③ 🚨 前端摺疊判斷要吃 us_earn 旗標(⛔ 不可只靠關鍵字比對)',
   m is not None and 'us_earn' in m.group(1), m.group(1) if m else 'not found')

# ── ⑥ 巨頭新聞桶 ─────────────────────────────────────────────────
UR = open(os.path.join(ROOT, 'universal_radar.py'), encoding='utf-8').read()
ok('⑥ 巨頭情報有「財報」桶', re.search(r'"earnings":\s*"https', UR) is not None)
ok('⑥b 全球新聞有財報導向來源', '巨頭財報' in UR)
ok('⑥c 🚨 補上 Google/微軟/Meta(舊來源完全沒有涵蓋)',
   '雲端巨頭' in UR and 'Alphabet' in UR and 'Microsoft' in UR)
ok('⑥d 財報類來源要掛 when:1d(⛔ 財報是當日事件,不然會撈到一堆舊分析文)',
   UR.count('when:1d') >= 4, UR.count('when:1d'))
ok('⑥e 🚨 前端要真的接上第 5 桶(⛔ 採礦加了桶卻不接 = 死資料,陷阱 #32)',
   'tg.earnings' in IDX and '_earnRaw' in IDX)
ok('⑥f 兩個 AI 提示詞模板都要帶到(⛔ 只改一個 = 又一次只修到一邊)',
   IDX.count('${_earnRaw}') >= 2, IDX.count('${_earnRaw}'))

# ── ⑦ 關鍵字/分類 ────────────────────────────────────────────────
ok('⑦ 英文白名單有財報詞(⛔ 沒有的話「chipmaker beats estimates」會被整條濾掉)',
   "'earnings'" in UR and "'guidance'" in UR and "'alphabet'" in UR)
ok('⑦b 中文分類「財務事件」要收得到「輝達財報」「優於預期」',
   '"財報"' in UR and '"優於預期"' in UR)
# ⛔ 關鍵字不可跨類重複(重複會讓分類結果取決於 dict 順序)
sys.modules.pop('universal_radar', None)
os.environ.setdefault('GROQ_API_KEYS', '')
import universal_radar as U  # noqa: E402
seen, dup = {}, []
for cat, kws in U.NEWS_CATEGORIES.items():
    for k in kws:
        if k in seen:
            dup.append(f'{k}({seen[k]} vs {cat})')
        seen[k] = cat
ok('⑦c ⛔ 關鍵字不可跨類重複(重複會讓分類取決於 dict 順序)', not dup, dup[:5])

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ USEARNINGS_PASS(全部通過)')
sys.exit(1 if fails else 0)
