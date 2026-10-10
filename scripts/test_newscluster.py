#!/usr/bin/env python3
"""🧩 V79.0.6 新聞「同一事件」歸群守門(外部評估㊾,使用者核准)

釘住的用意:
  ① universal_radar --selftest 全過(三條合併規則 / 不同事件不併 / 不同天不併 / 中性被取代 / 歷史第 4 欄)
  ② 決定性對照:門檻 1.0(退回只擋幾乎一模一樣)→ 自我測試**必須**紅(否則那些斷言沒有鑑別力)
  ③ 走正式入口 build_stock_news:fetch_feed 的欄位(source_name / published_time / ai_reason)
     要讀得到(🐛 以前來源、日期、理由永遠是空的),同一件事要併成一則並帶 dup / also
  ④ 用真的 news_hist.json(git 讀 data 分支)量:合併要有,但 ⛔ 不可把台積電一天十幾件事併成一兩則
"""
import json
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
for _m in ('feedparser', 'yfinance', 'pandas'):
    if _m not in sys.modules:
        sys.modules[_m] = types.ModuleType(_m)
import universal_radar as U  # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:240]}'))
    if not cond:
        fails.append(name)


# ① 自我測試
r = subprocess.run([sys.executable, str(ROOT / 'universal_radar.py'), '--selftest'], capture_output=True, text=True, cwd=tempfile.mkdtemp())
ok('① universal_radar --selftest 全過', r.returncode == 0, r.stdout[-400:] + r.stderr[-400:])

# ② 決定性對照:門檻 1.0 → 自我測試要紅
import io, contextlib  # noqa: E401,E402
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    n_bad = U._selftest(th=1.0)
ok('② 門檻 1.0(只擋幾乎一模一樣)→ 自我測試必須紅', n_bad >= 2, f'{n_bad} 條失敗')

# ③ 正式入口
tmp = Path(tempfile.mkdtemp(prefix='ncl3_'))
U.DATA_DIR = tmp
U._fetch_full_name_map = lambda: {**{f'假公司{i:03d}': str(9000 + i) for i in range(600)}, '華邦電': '2344', '台積電': '2330'}
pub = 'Thu, 08 Oct 2026 01:30:00 GMT'
feed = [
    {'title': '華邦電8月營收衝上273億元 連續13個月創新高 - 經濟日報', 'source_name': 'Google TW', 'published_time': pub,
     'link': 'https://a', 'ai_sentiment': '中立', 'ai_reason': '月營收公布'},
    {'title': '華邦電8月營收273.09 億元 - 鉅亨網', 'source_name': 'Google TW', 'published_time': pub,
     'link': 'https://b', 'ai_sentiment': '利多', 'ai_reason': '創新高'},
    {'title': '台積電法說會10/15登場 分析師最想知道的事 - 工商時報', 'source_name': 'Google TW', 'published_time': pub,
     'link': 'https://c', 'ai_sentiment': '中立', 'ai_reason': ''},
    {'title': '台積電明除息 每股配發7元股利創歷史新高 - 自由財經', 'source_name': 'Google TW', 'published_time': pub,
     'link': 'https://d', 'ai_sentiment': '利多', 'ai_reason': ''},
]
out = U.build_stock_news(feed) or {}
w = (out.get('2344') or {}).get('items') or []
ok('③ 華邦電兩則同一件事 → 一則', len(w) == 1, w)
if w:
    ok('③ 併進來的那則有方向 → 取代中性,dup = 1', w[0].get('tone') == 'pos' and w[0].get('dup') == 1, w[0])
    ok('③ 來源 / 日期 / 理由讀得到(⛔ 不可是空的)', w[0].get('source') and w[0].get('date') == '2026-10-08 09:30' and w[0].get('reason'), w[0])
    ok('③ 標題換成鉅亨網那則 → 來源也是鉅亨網,經濟日報記進 also', w[0].get('source') == '鉅亨網' and w[0].get('also') == ['經濟日報'], w[0])
    ok('③ 內部欄位 _alt ⛔ 不寫進檔案', '_alt' not in w[0])
t = (out.get('2330') or {}).get('items') or []
ok('③ 台積電兩件不同的事 → 兩則都留', len(t) == 2, t)

# ④ 真資料(讀 data 分支;拿不到就誠實說,⛔ 不假裝過)
try:
    raw = subprocess.run(['git', 'show', 'origin/data:data/news_hist.json'], capture_output=True, cwd=ROOT, timeout=60)
    H = json.loads(raw.stdout.decode('utf-8')) if raw.returncode == 0 else None
except Exception:
    H = None
if not H or not H.get('days'):
    print('⏭️ ④ 讀不到 origin/data:data/news_hist.json → 這一段沒跑(先 git fetch origin data)')
else:
    n_in = n_cl = 0
    worst = 1.0
    tsmc_in = tsmc_cl = 0
    for day, ss in H['days'].items():
        for sym, arr in ss.items():
            titles = [x[0] for x in arr if isinstance(x, list) and x]
            b = []
            for ti in titles:
                rec = {'title': ti, 'date': day, 'tone': 'neu', 'source': ''}
                if not U._merge_into(b, rec):
                    b.append(rec)
            n_in += len(titles); n_cl += len(b)
            if sym == '2330':
                tsmc_in += len(titles); tsmc_cl += len(b)
            if len(titles) >= 6:
                worst = min(worst, len(b) / len(titles))
    ok('④ 真資料:有合併到東西', n_in - n_cl >= 10, f'{n_in} → {n_cl}')
    ok('④ 真資料:⛔ 不可併過頭(標題 ≥6 則的那幾天,剩下的事件數 ≥ 一半)', worst >= 0.5, f'最差剩 {worst:.0%}')
    ok('④ 真資料:台積電(一天很多件不同的事)幾乎不可被併(剩 ≥ 90%)', tsmc_in and tsmc_cl / tsmc_in >= 0.9, f'{tsmc_in} → {tsmc_cl}')
    print(f'   📊 真資料 {len(H["days"])} 天:{n_in} 則 → {n_cl} 個事件(併掉 {n_in - n_cl} 則)・最擠那天剩 {worst:.0%}')

print(f"\n{'❌ ' + str(len(fails)) + ' 條失敗' if fails else '✅ test_newscluster 全過'}")
sys.exit(1 if fails else 0)
