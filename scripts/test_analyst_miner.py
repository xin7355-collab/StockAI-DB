#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""🎙️ analyst_miner 離線測試(stub 掉網路,只釘合併/去重/價格快照/守門/冪等)。

⛔ 最重要的兩條:
  ① **守門要看「本輪有沒有抓到新的」** —— 舊檔的內容還在 KEEP_DAYS 內就會被併進來,
     若拿合併後的結果當守門依據,**上游全掛的那天看起來也會「成功」**,
     還會把 updated 換成今天、error 寫成 None。(第一版就是這樣寫的,自我測試當場抓到。)
  ② **「他說的時候的價格」必須冪等** —— 寫入後不可被之後的收盤蓋掉,否則整個功能失去意義。

跑法:python3 scripts/test_analyst_miner.py
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import analyst_miner as A   # noqa: E402

FAILS = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:200]}'))
    if not cond:
        FAILS.append(name)


TMP = Path(tempfile.mkdtemp())
A.OUT = TMP / 'analyst_focus.json'
A.DATA_DIR = TMP
A._name_map = lambda: {'台積電': '2330', '鴻海': '2317', '南亞': '1303', '南亞科': '2408'}

FEED = [
    {'t': '台積電還能不能追?順便聊鴻海', 'u': 'https://x/1', 'd': '2026-08-04', 'kind': 'yt'},
    {'t': '大盤到底崩不崩', 'u': 'https://x/2', 'd': '2026-08-03', 'kind': 'yt'},
    {'t': '南亞科要噴了', 'u': 'https://x/3', 'd': '2026-08-02', 'kind': 'yt'},
]
PX = {'2330': 1000.0, '2317': 250.0, '2408': 60.0, '1303': 40.0, '^TWII': 23000.0}


def net_on():
    A._resolve_youtube = lambda a: (list(FEED), 'YouTube @x')
    A._resolve_podcast = lambda a: ([], 'n/a')
    A._resolve_news = lambda a: ([], 'n/a')


def net_off():
    A._resolve_youtube = lambda a: ([], 'YT 不通')
    A._resolve_podcast = lambda a: ([], 'Podcast 不通')
    A._resolve_news = lambda a: ([], 'GNews 也沒有')


A._close_on = lambda sym, ymd: (PX.get(sym), ymd)

# ── ① 正常跑 ────────────────────────────────────────────────────────────
net_on()
ok('① 有內容 → 回 True', A.build() is True)
d = json.loads(A.OUT.read_text(encoding='utf-8'))
ok('① 4 位分析師都在輸出裡', len(d['analysts']) == len(A.ANALYSTS), len(d['analysts']))
it = d['analysts'][0]['items'][0]
ok('① 最新的排最前面', it['d'] == '2026-08-04', it['d'])

# ── ② 標的抽取 + 去子字串 ────────────────────────────────────────────────
ok('② 一則標題抽到兩檔', len(it['syms']) == 2, it['syms'])
ok('② 代號正確', {x['s'] for x in it['syms']} == {'2330', '2317'}, it['syms'])
nan = [x for x in d['analysts'][0]['items'] if x['t'].startswith('南亞科')][0]
ok('② ⭐ 去子字串:「南亞科」不可同時命中「南亞」',
   [x['s'] for x in nan['syms']] == ['2408'], nan['syms'])
ok('② 標題沒股票 → 空陣列(⛔ 不可 None)',
   [x for x in d['analysts'][0]['items'] if x['t'].startswith('大盤')][0]['syms'] == [])

# ── ③ 價格快照:當日 + 現價分開 ─────────────────────────────────────────
s0 = it['syms'][0]
ok('③ 有「他講那天」的價格 px', s0['px'] == 1000.0, s0)
ok('③ 有當天的大盤 mkt', s0['mkt'] == 23000.0, s0)
ok('③ 有現價 pxn / 現在大盤 mktn', s0.get('pxn') == 1000.0 and s0.get('mktn') == 23000.0, s0)

# ── ④ ⭐⭐ 冪等:重跑不可覆蓋「他講那天」的價格,但現價要更新 ─────────────
PX.update({'2330': 1100.0, '^TWII': 24150.0})
A.build()
d2 = json.loads(A.OUT.read_text(encoding='utf-8'))
s1 = d2['analysts'][0]['items'][0]['syms'][0]
ok('④ ⭐⭐ 當日價 px 不可被今天的收盤蓋掉', s1['px'] == 1000.0, s1)
ok('④ ⭐ 當日大盤 mkt 也不可被蓋掉', s1['mkt'] == 23000.0, s1)
ok('④ ⭐ 但現價 pxn 要跟著更新', s1['pxn'] == 1100.0, s1)
ok('④ ⭐ 現在的大盤 mktn 也要更新', s1['mktn'] == 24150.0, s1)

# ── ⑤ ⭐⭐ 守門:本輪全落空 → 不寫檔(⛔ 不可因為舊檔還在就當成功)───────
before = A.OUT.read_text(encoding='utf-8')
net_off()
ok('⑤ ⭐⭐ 本輪全落空 → 回 False', A.build() is False)
ok('⑤ ⭐⭐ 而且舊檔一個位元組都不能動', A.OUT.read_text(encoding='utf-8') == before)

# ── ⑥ 部分落空:有的抓到有的沒抓到 → 照寫,但沒抓到的要留原因 ───────────
_cnt = {'i': 0}


def _mixed(a):
    _cnt['i'] += 1
    return (list(FEED), 'YouTube @x') if _cnt['i'] % 2 else ([], 'YT 不通')


A._resolve_youtube = _mixed
ok('⑥ 部分成功 → 仍寫檔', A.build() is True)
d3 = json.loads(A.OUT.read_text(encoding='utf-8'))
noFresh = [x for x in d3['analysts'] if x.get('fresh') == 0]
ok('⑥ ⭐ 沒抓到新的那幾位要有 error(陷阱 #22)',
   bool(noFresh) and all(x['error'] for x in noFresh), [x.get('error') for x in noFresh])
ok('⑥ ⭐ 但舊內容仍保留給使用者看(⛔ 不清空)',
   all(x['items'] for x in noFresh), [len(x['items']) for x in noFresh])

# ── ⑦ 固定免責必須在輸出裡(前端要顯示)────────────────────────────────
ok('⑦ ⭐ 輸出要帶「不下多空不計分」免責',
   '不下多空' in d3.get('no_signal', '') and '不計分' in d3.get('no_signal', ''), d3.get('no_signal'))
ok('⑦ ⭐ 輸出要帶「沒有逐字稿」免責', '逐字稿' in d3.get('disclaimer', ''), d3.get('disclaimer'))
ok('⑦ ⭐ resolve_log 要寫進 JSON(job log 會過期,JSON 才查得到)',
   isinstance(d3.get('resolve_log'), list), type(d3.get('resolve_log')))

# ── ⑧ 名單:四位、名字正確(使用者寫「艾倫」,正確是「艾綸」)────────────
names = [a['n'] for a in A.ANALYSTS]
ok('⑧ 四位都在', len(A.ANALYSTS) == 4, names)
ok('⑧ ⭐ 是「兆華艾綸說」不是「艾倫」', any('艾綸' in n for n in names) and not any('艾倫' in n for n in names), names)
ok('⑧ 每位都有保底的 Google News 關鍵字(⛔ 不可只靠 YouTube)',
   all(a.get('news_kw') for a in A.ANALYSTS), [a.get('news_kw') for a in A.ANALYSTS])

print()
if FAILS:
    print(f'❌ {len(FAILS)} 條失敗:')
    for f in FAILS:
        print(' - ' + f)
    sys.exit(1)
print('✅ ANALYST_MINER_TEST_PASS')
