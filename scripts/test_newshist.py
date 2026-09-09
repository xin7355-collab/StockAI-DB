#!/usr/bin/env python3
"""🗞️ V74.2.8 消息面歷史累積(使用者:「消息面歷史也一樣,我就是要看到」)

⭐ 為什麼要有這支測試:`news_hist.json` 是**累積型**檔案,而累積型檔案最典型的死法是
   「還原失敗 → 從零重寫 → 歷史全沒了」,而且**完全不會報錯**
   (chips_deep / tick_hist / mgr_hist 全都踩過)。所以守門一定要用注入實測釘住。

⛔ 釘死的七件事(①③④ 已用注入缺陷自我驗證):
  ① 🚧 守門沒過(out_stocks 為 None/空)→ ⛔ 不可寫檔(壞資料混進歷史就永遠分不出來)
  ② 同一天同一檔同一標題只留一次(一天跑 6~10 輪,不去重會把同一則算很多次)
  ③ 🚧 天數比現有檔少 → ⛔ 拒絕覆蓋(這條就是在防「還原失敗」)
  ④ 超過保留天數的舊日期要被丟掉(⛔ 不然檔案會無限長大)
  ⑤ 日期用**台北**(⛔ 不可用 UTC —— 台北晚上會差一天)
  ⑥ ⛔ 不存股價(價格從 K 線回推就好;存了只會多一份可能對不上的真相)
  ⑦ workflow 要有「還原」步驟,而且 `git add` 要含這個檔(漏了 = 每天被洗掉且零錯誤訊息)
"""
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:200]}'))
    if not cond:
        fails.append(name)


# ── 在暫存目錄裡跑(⛔ 不可污染真正的 data/)──
tmp = tempfile.mkdtemp(prefix='newshist_')
os.chdir(tmp)
Path('data').mkdir(exist_ok=True)
import universal_radar as U  # noqa: E402

U.DATA_DIR = Path(tmp) / 'data'
U.NEWS_HIST_FILE = U.DATA_DIR / 'news_hist.json'
HF = U.NEWS_HIST_FILE

TPE_TODAY = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime('%Y-%m-%d')


def mk(n=3, title_prefix='台積電法說會樂觀'):
    return {str(2330 + i): {'items': [
        {'title': f'{title_prefix}{i}', 'tone': 'pos', 'cat': '供需價格'},
        {'title': f'另一則新聞{i}', 'tone': 'neu', 'cat': ''},
    ]} for i in range(n)}


def read():
    return json.loads(HF.read_text(encoding='utf-8')) if HF.exists() else None


# ── ① 守門:沒通過就不寫 ──
U.build_news_history(None)
ok('① 🚧 out_stocks=None(守門沒過)→ ⛔ 不寫檔', not HF.exists())
U.build_news_history({})
ok('①b 🚧 out_stocks 是空的 → ⛔ 不寫檔', not HF.exists())

# ── 正常寫入 ──
U.build_news_history(mk(3))
d = read()
ok('🚧 空過守門:正常情況真的寫得出檔案', bool(d) and bool(d.get('days')), d)
ok('⑤ 日期用台北(⛔ 不是 UTC)', TPE_TODAY in (d.get('days') or {}), list((d or {}).get('days', {})))
today = (d.get('days') or {}).get(TPE_TODAY, {})
ok('🚧 空過守門:今天真的有三檔', len(today) == 3, list(today))

# ── ⑥ ⛔ 不存股價 ──
one = next(iter(today.values()))
ok('⑥ ⛔ 一則只有 [標題, 情緒, 分類] 三個欄位(⛔ 不存股價)',
   isinstance(one, list) and all(isinstance(x, list) and len(x) == 3 for x in one), one)

# ── ② 同一輪再跑一次 → ⛔ 不可重複 ──
n_before = sum(len(v) for v in today.values())
U.build_news_history(mk(3))
d2 = read()
n_after = sum(len(v) for v in (d2.get('days') or {}).get(TPE_TODAY, {}).values())
ok('② 同一天同一檔同一標題只留一次(⛔ 一天跑 6~10 輪不可累加)',
   n_after == n_before, f'{n_before} → {n_after}')

# ── ②b 新標題要進得來 ──
U.build_news_history(mk(3, title_prefix='完全不同的新標題'))
d3 = read()
n3 = sum(len(v) for v in (d3.get('days') or {}).get(TPE_TODAY, {}).values())
ok('②b ⭐ 但**新的**標題要進得來(⛔ 不可整輪跳過)', n3 > n_after, f'{n_after} → {n3}')

# ── ③ 天數變少 → 拒絕覆蓋(注入「還原失敗」的情境)──
old = read()
old_days = dict(old['days'])
for k in range(1, 6):
    old_days[(datetime.now(timezone.utc) + timedelta(hours=8) - timedelta(days=k)).strftime('%Y-%m-%d')] = {'1101': [['x', 'neu', '']]}
HF.write_text(json.dumps({'updated': 'x', 'days': old_days}, ensure_ascii=False), encoding='utf-8')
n_days_before = len(old_days)
# 模擬「還原失敗」:檔案被換成只有今天那一份
HF.write_text(json.dumps({'updated': 'x', 'days': old_days}, ensure_ascii=False), encoding='utf-8')
U.build_news_history(mk(2))       # 正常追加 → 天數不會變少 → 應該寫得進去
ok('③a 正常追加(天數沒變少)→ 寫得進去', len(read()['days']) == n_days_before, len(read()['days']))

# 🚨 「還原失敗」這種情境**腳本自己擋不住**(它只看得到本機那份;還原失敗 = 本機沒有檔)
#    → 那一層守門在 workflow 的 `news_hist_guard.py`。這裡直接跑那支驗它。
import subprocess  # noqa: E402
_new_p, _prev_p = os.path.join(tmp, 'n.json'), os.path.join(tmp, 'p.json')
json.dump({'days': {'2026-09-01': {}}}, open(_new_p, 'w'))                       # 只有 1 天(還原失敗的樣子)
json.dump({'days': {f'2026-0{i//28+1}-{i%28+1:02d}': {} for i in range(50)}}, open(_prev_p, 'w'))  # gh-pages 上有 50 天
_r = subprocess.run([sys.executable, str(ROOT / 'scripts/news_hist_guard.py'), _new_p, _prev_p],
                    capture_output=True, text=True)
ok('③b 🚧 還原失敗(只剩 1 天)→ 守門要把 gh-pages 上那份 50 天的還回去',
   len(json.load(open(_new_p)).get('days') or {}) == 50 and '拒絕覆蓋' in _r.stdout, _r.stdout.strip())
# 正常成長 → ⛔ 不可誤擋
json.dump({'days': {f'2026-0{i//28+1}-{i%28+1:02d}': {} for i in range(51)}}, open(_new_p, 'w'))
_r2 = subprocess.run([sys.executable, str(ROOT / 'scripts/news_hist_guard.py'), _new_p, _prev_p],
                     capture_output=True, text=True)
ok('③c ⛔ 正常成長(51 > 50)不可被誤擋',
   len(json.load(open(_new_p)).get('days') or {}) == 51 and '拒絕覆蓋' not in _r2.stdout, _r2.stdout.strip())

# ── ④ 超過保留天數的要被裁掉 ──
far = (datetime.now(timezone.utc) + timedelta(hours=8) - timedelta(days=U.NEWS_HIST_DAYS + 30)).strftime('%Y-%m-%d')
cur = read()
cur['days'][far] = {'1101': [['很久以前', 'neu', '']]}
# 多塞幾天,讓裁掉一天之後總天數仍然不少於原本(⛔ 否則會被 ③ 的守門擋下)
for k in range(10, 20):
    cur['days'][(datetime.now(timezone.utc) + timedelta(hours=8) - timedelta(days=k)).strftime('%Y-%m-%d')] = {'1102': [['y', 'neu', '']]}
HF.write_text(json.dumps(cur, ensure_ascii=False), encoding='utf-8')
U.build_news_history(mk(2))
ok('④ 超過保留天數的舊日期要被丟掉(⛔ 不然檔案無限長大)', far not in read()['days'], far)

# ── ⑦ workflow 佈線 ──
wf = (ROOT / '.github/workflows/news_express.yml').read_text(encoding='utf-8')
ok('⑦d 🚨 守門腳本要先複製到 /tmp(gh-pages 分支上沒有 scripts/)',
   '/tmp/news/news_hist_guard.py' in wf and 'cp scripts/news_hist_guard.py /tmp/news/' in wf)
ok('⑦a workflow 有「還原消息面歷史」的步驟(⛔ 少了就每輪從零重寫)',
   'news_hist.json' in wf and re.search(r'git show origin/gh-pages:data/news_hist\.json', wf) is not None)
ok('⑦b 🚨 `git add` 要含 news_hist.json(漏了 = 複製回去卻沒 commit,每天被洗掉且零錯誤訊息)',
   re.search(r'git add [^\n]*data/news_hist\.json', wf) is not None,
   (re.search(r'git add [^\n]*', wf) or [''])[0])
ok('⑦c 還原步驟要排在跑 universal_radar **之前**(⛔ 否則還原到的是自己剛寫的)',
   wf.index('還原消息面歷史') < wf.index('執行 universal_radar.py'))

# ── ⑧ 接線:main 真的有呼叫 ──
src = (ROOT / 'universal_radar.py').read_text(encoding='utf-8')
ok('⑧ main 有把 build_stock_news 的結果餵給 build_news_history',
   re.search(r'_sn = build_stock_news\(results\)\s*\n\s*build_news_history\(_sn\)', src) is not None)
ok('⑧b build_stock_news 被守門擋掉時要回 None(⛔ 不可回半套資料)',
   'return None' in src and 'return out_stocks' in src)

print(('❌ %d 條失敗' % len(fails)) if fails else '✅ NEWSHIST_PASS(全部通過)')
sys.exit(1 if fails else 0)
