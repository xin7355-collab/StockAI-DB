#!/usr/bin/env python3
"""🌍 地緣政治突發新聞:關鍵字過濾 + 時間窗(V72.3.3)

⚠️ 釘的是使用者問的那件事:「川普老是說要打伊朗、伊朗打美軍,有時真的影響股價,
   有沒有辦法更快抓到?」——查下來**真因不是抓太慢,是抓到了被丟掉**,而且有兩層:

  ① `TW_RELATED_KEYWORDS` **完全沒有任何地緣政治/軍事/能源詞** →
     「Israel strikes Iran nuclear site」一個字都不命中 → `_is_tw_relevant()` 直接濾掉。
     ⛔ 所以以前不管 cron 跑多密,這類新聞都不可能出現在 App 上。
  ② `fetch_global_news` 的時間窗 `win_end` 寫死成「最近已過的 **05:00**」→
     **今天 05:00 之後的新聞全部丟棄**(舊註解自己寫著「今日盤中 → 丟棄」)。
     而 workflow 叫「即時新聞快訊」、每 4 小時跑,前端卡片寫「盤前+盤中」——
     三邊講同一件事,只有那一行沒跟上。實測落後 17 小時。

⭐ 通用教訓:**「新聞太舊」先查的不是抓取頻率,是「抓到之後有沒有被過濾/丟掉」** ——
   前者看得見(cron 好改),後者是靜默的,而且再怎麼加密頻率都無效。

跑法:python3 scripts/test_geonews.py
"""
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 沙箱沒有 feedparser(採礦機才裝)→ 塞個假的,本測試只驗純函式
if 'feedparser' not in sys.modules:
    _fp = types.ModuleType('feedparser')
    _fp.parse = lambda *a, **k: types.SimpleNamespace(entries=[])
    sys.modules['feedparser'] = _fp

import universal_radar as ur  # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + ('' if cond else f'  {str(extra)[:200]}'))
    if not cond:
        fails.append(name)


# ── ① 地緣政治新聞必須通得過過濾 ────────────────────────────────────
MUST_PASS = [
    "Israel strikes Iran nuclear facility, oil jumps 6%",
    "Iran fires missiles at US base in Iraq",
    "Trump says he will attack Iran if talks fail",
    "Houthi attack shuts Red Sea shipping lane",
    "Oil price surges as Strait of Hormuz tensions rise",
    "China military drills near Taiwan Strait",
    "OPEC agrees output cut, Brent crude above $90",
    "Russia Ukraine ceasefire talks collapse",
    "US imposes new sanctions on Iran oil exports",
]
for t in MUST_PASS:
    ok(f'① 要收到:{t[:52]}', ur._is_tw_relevant(t, ''))

# ── ② 雜訊必須被擋掉(加關鍵字必然放大雜訊,不驗這條等於沒修好)──────
MUST_BLOCK = [
    "Star Wars new series breaks Netflix records",
    "Golden State Warriors win in overtime",
    "Royal wedding recipe goes viral",
    "Best power bank for travel in 2026",
    "Premier League football results this weekend",
]
for t in MUST_BLOCK:
    ok(f'② 要擋掉:{t[:52]}', not ur._is_tw_relevant(t, ''))

# ── ③ 既有的財經新聞不可被我這次改動弄壞(回歸)────────────────────
for t in ["TSMC posts record revenue on AI chip demand",
          "Fed signals rate cut as inflation cools",
          "Nvidia unveils new AI chip"]:
    ok(f'③ 原本就要收的仍要收:{t[:44]}', ur._is_tw_relevant(t, ''))

# ── ④ 關鍵字表真的有地緣政治那一段(防日後被「清理」掉)────────────
kws = set(k.lower() for k in ur.TW_RELATED_KEYWORDS)
for must in ('iran', 'israel', 'war', 'missile', 'sanctions', 'oil price', 'taiwan strait'):
    ok(f'④ 關鍵字表含 `{must}`', must in kws)

# ── ⑤ RSS 來源要有地緣政治那條 ────────────────────────────────────
srcs = ' '.join(ur.GLOBAL_NEWS_SOURCES.values())
ok('⑤ GLOBAL_NEWS_SOURCES 有地緣政治來源(含 Iran/Israel 查詢)',
   'Iran' in srcs and 'Israel' in srcs)
ok('⑤ 地緣來源有限最近 24 小時(when:1d,免撈到舊分析文)', 'when:1d' in srcs)

# ── ⑥ ⭐ 時間窗:今天盤中的新聞**不可以**再被丟掉 ──────────────────
#   直接把 fetch_global_news 的窗口算式複製過來會變成「第二份真相」(CLAUDE.md 明令禁止),
#   所以改成**實跑** fetch_global_news、把 feedparser 換成注入假新聞,看它收不收得到。
TPE = timezone(timedelta(hours=8))
now_tpe = datetime.now(TPE)


def _mk_entry(title, when_tpe):
    return {
        'title': title,
        'link': 'https://example.com/x',
        'published': when_tpe.strftime('%a, %d %b %Y %H:%M:%S %Z') or 'now',
        'published_parsed': when_tpe.astimezone(timezone.utc).timetuple(),
    }


_captured = {'titles': []}
_one_hour_ago = now_tpe - timedelta(hours=1)
_八天前 = now_tpe - timedelta(days=8)
_fake = [
    _mk_entry('Iran fires missiles at US base, oil spikes', _one_hour_ago),   # 1 小時前 → 必須收到
    _mk_entry('Israel strikes Iran nuclear site markets fall', _八天前),      # 8 天前 → 必須丟掉
]
sys.modules['feedparser'].parse = lambda *a, **k: types.SimpleNamespace(entries=list(_fake))
ur.feedparser = sys.modules['feedparser']
ur.GROQ_API_KEYS = []          # ⛔ 不打 AI(沙箱沒網路,也不燒額度)
_orig_write = ur.GLOBAL_NEWS_FILE


class _Sink:
    def write_text(self, s, **k):
        import json as _j
        # ⚠️ 第一版寫死讀 `news` key,但實際輸出是 `items` → 收到 0 則,
        #    而「8 天前的要被丟掉」那條剛好也因此變成假綠燈(⑥ 的空過守門就是為了抓這個)。
        j = _j.loads(s)
        _captured['titles'] = [i.get('title', '') for i in (j.get('items') or j.get('news') or [])]


ur.GLOBAL_NEWS_FILE = _Sink()
try:
    ur.fetch_global_news()
finally:
    ur.GLOBAL_NEWS_FILE = _orig_write

got = ' | '.join(_captured['titles'])
ok('⑥ ⭐⛔ 1 小時前的地緣突發必須收得到(舊版會因「窗口截止 05:00」丟掉)',
   any('Iran fires missiles' in t for t in _captured['titles']), f'實際收到:{got[:200]}')
ok('⑥ 8 天前的舊新聞仍要被丟掉(窗口只放寬 end,不可變成什麼都收)',
   not any('Israel strikes' in t for t in _captured['titles']), f'實際收到:{got[:200]}')
# ⚠️ 空過守門:兩條都靠「有沒有收到」判斷,一則都沒收到時上面第二條會假綠
ok('⑥ ⚠️ 空過守門:至少要收到 1 則(否則上面的斷言是假綠燈)',
   len(_captured['titles']) >= 1, f'收到 {len(_captured["titles"])} 則')

print()
if fails:
    print(f'❌ GEONEWS_TEST_FAIL:{len(fails)} 條')
    raise SystemExit(1)
print('✅ GEONEWS_TEST_PASS')
