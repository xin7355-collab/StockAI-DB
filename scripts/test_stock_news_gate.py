#!/usr/bin/env python3
"""個股消息面守門重新校準(V71.6.6)測試。

抓到的實況(2026/07/30 news_express log + gh-pages 存檔):
    📇 股名表 上市 +1092 / 上櫃 +890      ← 名單來源完全正常
    ❌ 個股消息面只有 16 檔(<20)→ 不寫檔,保留舊檔
    而被「保留」的舊檔只有 **7 檔**      ← 守門在用更差的資料取代更好的

舊門檻「<20 就不寫」跟實際流程對不起來:輸入是 CAP=25 篇新聞,
25 篇本來就很難命中 20 檔以上不同股票 → stock_news.json 卡了整整 3 天。

新規則守的是「上游有沒有真的壞掉」+「防崩塌(不是防變少)」,這裡把它釘死。
⚠️ V71.6.7 補:V71.6.6 一度寫成「比現有少就不覆蓋」= 只進不退的**棘輪** ——
   檔數衝到 40 之後,正常的清淡日就永遠寫不進去,又會卡死。④ 那組測試就是防這個。
"""
import json
import os
import sys
import types
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('SKIP_MAIN', '1')
for _m in ('feedparser', 'yfinance', 'pandas'):
    if _m not in sys.modules:
        sys.modules[_m] = types.ModuleType(_m)

import universal_radar as U   # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + (f'  {extra}' if not cond else ''))
    if not cond:
        fails.append(name)


TMP = Path(os.environ.get('TMPDIR', '/tmp')) / 'sn_gate_test'
TMP.mkdir(parents=True, exist_ok=True)
U.DATA_DIR = TMP
OUT = TMP / 'stock_news.json'


def run(n_news, names, old=None, old_age_h=0.5):
    """跑一次 build_stock_news,回 (寫出的檔數 or None)。
    old_age_h = 舊檔的年齡(小時),用來測「舊檔太舊一律覆蓋」那條。"""
    if OUT.exists():
        OUT.unlink()
    _ts = None
    if old is not None:
        # ⚠️ 舊檔的 updated 必須是**真的時間戳**(守門要拿它算年齡),
        #    所以不能再用 'old' 這個字串當標記 —— 改記下來事後比對。
        _ts = (datetime.utcnow() - timedelta(hours=old_age_h)).strftime('%Y-%m-%d %H:%M UTC')
        OUT.write_text(json.dumps({'updated': _ts, 'stocks': {
            str(1000 + i): {'items': [{'title': 't'}]} for i in range(old)}}), encoding='utf-8')
    U._fetch_full_name_map = lambda: names
    items = [{'title_zh': f'{nm} 法說會亮眼', 'ai_sentiment': '利多', 'url': f'u{i}'}
             for i, nm in enumerate(list(names)[:n_news])]
    U.build_stock_news(items)
    if not OUT.exists():
        return None
    d = json.loads(OUT.read_text(encoding='utf-8'))
    # updated 還是注入的那個 → 代表守門擋下了、沒覆蓋
    if _ts is not None and d.get('updated') == _ts:
        return None
    return len(d.get('stocks') or {})


# 完整股名表(≥500,模擬正常載入的 1,982 檔)
BIG = {f'測試股{i:04d}': str(1000 + i) for i in range(1982)}

# ── ① 實測情境重現:名單正常、命中 16 檔 → **必須寫得出來**(舊版會擋掉)──
ok('① 名單正常 + 命中 16 檔 → 寫檔(舊版誤擋的正是這個)', run(16, BIG) == 16)

# ── ② 只命中 1 檔也要寫(那就是當天的實況,不是故障)──
ok('② 只命中 1 檔也寫', run(1, BIG) == 1)

# ── ③ 真正該擋的三件事 ────────────────────────────────────────
ok('③ 股名表沒載到(<500)→ 不寫,保留舊檔',
   run(16, {f'少數股{i}': str(i) for i in range(100)}) is None)
ok('③ 完全沒新聞(RSS 全掛)→ 不寫', run(0, BIG) is None)
U._fetch_full_name_map = lambda: BIG
if OUT.exists():
    OUT.unlink()
U.build_stock_news([{'title_zh': '完全沒有任何股名的一則新聞', 'ai_sentiment': '中立', 'url': 'x'}])
ok('③ 有新聞但一檔都沒命中 → 不寫(比對邏輯壞了)', not OUT.exists())

# ── ④ 防「崩塌」而不是防「變少」(V71.6.7 修 V71.6.6 自己種的棘輪)──
#    V71.6.6 寫成「比現有少就不覆蓋」= 只進不退的棘輪:衝到 40 檔之後,
#    正常的清淡日(15、20 檔)全部寫不進去 → 又卡死,跟原本要修的病一樣。
ok('④ 崩塌(2 檔 vs 現有 30)且舊檔新鮮 → 保留舊檔', run(2, BIG, old=30) is None)
ok('④ ⭐ 只是變少(15 檔 vs 現有 30)→ 照樣覆蓋(不可棘輪)', run(15, BIG, old=30) == 15)
ok('④ 算 16 檔 > 現有 7 檔 → 覆蓋(正是 07/30 的實況)', run(16, BIG, old=7) == 16)
ok('④ 算 10 檔 = 現有 10 檔 → 覆蓋(內容較新)', run(10, BIG, old=10) == 10)
ok('④ 舊檔規模太小(<10)不套崩塌規則', run(1, BIG, old=9) == 1)
# ⭐ 舊檔太舊 → 即使崩塌也要覆蓋:一份新鮮的小檔 > 一份三天前的大檔(07/27 卡住的教訓)
ok('④ ⭐ 舊檔 72 小時前 → 即使只有 2 檔也覆蓋(新鮮優先)', run(2, BIG, old=30, old_age_h=72) == 2)
ok('④ 舊檔 13 小時前(剛過 12h 門檻)→ 覆蓋', run(2, BIG, old=30, old_age_h=13) == 2)
ok('④ 舊檔 11 小時前(未過門檻)+ 崩塌 → 保留', run(2, BIG, old=30, old_age_h=11) is None)

# ── ⑤ 舊檔壞掉/不存在不可 throw,要照常寫 ──────────────────────
OUT.write_text('{壞掉的 JSON', encoding='utf-8')
U._fetch_full_name_map = lambda: BIG
items = [{'title_zh': f'{nm} 利多', 'ai_sentiment': '利多', 'url': f'u{i}'}
         for i, nm in enumerate(list(BIG)[:12])]
U.build_stock_news(items)
try:
    got = len(json.loads(OUT.read_text(encoding='utf-8')).get('stocks') or {})
except Exception as e:
    got = f'FAIL {e}'
ok('⑤ 舊檔是壞 JSON → 照常寫新的', got == 12, str(got))

# ── ⑥ 去子字串仍有效(「南亞」⊂「南亞科」不可重複計)──────────
U._fetch_full_name_map = lambda: {**BIG, '南亞': '1303', '南亞科': '2408'}
if OUT.exists():
    OUT.unlink()
U.build_stock_news([{'title_zh': '南亞科報價回升', 'ai_sentiment': '利多', 'url': 'n1'}])
d = json.loads(OUT.read_text(encoding='utf-8'))['stocks'] if OUT.exists() else {}
ok('⑥ 只算南亞科,不誤算南亞', list(d.keys()) == ['2408'], str(list(d.keys())))

print()
if fails:
    print(f'❌ STOCK_NEWS_GATE_FAIL: {fails}')
    sys.exit(1)
print('✅ STOCK_NEWS_GATE_PASS')
