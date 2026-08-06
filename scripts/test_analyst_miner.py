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

# ⚠️ 後面的區塊會 stub 掉這些函式 → 先把**真的**存起來,
#    否則 ⑨ 會測到自己前面塞的 stub(第一版就這樣,測出來永遠是空的)。
_REAL_NEWS = A._resolve_news

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

# ── ⑨ ⭐⭐ Google News 保底的「相關性守門」(2026-08-07 首跑實測抓到的真問題)────
#    搜「兆華艾綸說」回來的是《理財達人秀》《理周飆股列車》—— 完全不是他的節目。
#    ⛔ 那比「沒有資料」更糟:使用者會以為那是他講的。
import xml.etree.ElementTree as _ET   # noqa: E402

_RSS = """<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>郭哲榮:明天輝達財報 再次屠殺台股?</title><link>https://n/1</link>
      <pubDate>Wed, 05 Aug 2026 10:00:00 GMT</pubDate><description>&lt;a&gt;相關報導&lt;/a&gt;</description></item>
<item><title>【理周飆股列車】20260806盤中-許江鎮</title><link>https://n/2</link>
      <pubDate>Thu, 06 Aug 2026 10:00:00 GMT</pubDate></item>
</channel></rss>"""

A._get = lambda url: _RSS.encode('utf-8')
A._resolve_news = _REAL_NEWS          # ⬅️ 換回真的
kept, note = A._resolve_news({'n': '郭哲榮分析師', 'news_kw': '郭哲榮 分析師', 'must': '郭哲榮'})
ok('⑨ ⭐⭐ 標題有提到他的才收', len(kept) == 1 and '郭哲榮' in kept[0]['t'], [k['t'] for k in kept])
ok('⑨ ⭐⭐ 別人的節目要被濾掉(⛔ 不可拿來充數)',
   all('理周' not in k['t'] for k in kept), [k['t'] for k in kept])
kept2, note2 = A._resolve_news({'n': '兆華艾綸說', 'news_kw': '兆華艾綸說', 'must': '艾綸'})
ok('⑨ ⭐ 全部沒提到他 → 回空(⛔ 寧可沒有,也不給錯的)', kept2 == [], kept2)
ok('⑨ ⭐ 而且要寫明原因', '全濾掉' in ''.join(A.RESOLVE_LOG[-3:]) or '沒提到' in ''.join(A.RESOLVE_LOG[-3:]),
   A.RESOLVE_LOG[-2:])
ok('⑨ ⛔ Google News 的 description 是雜訊 → 不可收進 x',
   all(not k.get('x') for k in kept), [k.get('x') for k in kept])

# ── ⑩ 標的抽取要吃「標題 + 內文摘要」(股癌標題就是「EP685 | 🤓」)──────────
A.OUT.unlink(missing_ok=True)
A._resolve_youtube = lambda a: ([{'t': 'EP685 | 🤓', 'u': 'https://y/1', 'd': '2026-08-05',
                                 'kind': 'yt', 'x': '這集聊台積電法說跟鴻海的 AI 伺服器'}], 'YouTube @Gooaye')
A._resolve_podcast = lambda a: ([], 'n/a')
A._resolve_news = lambda a: ([], 'n/a')
A.build()
d4 = json.loads(A.OUT.read_text(encoding='utf-8'))
i0 = d4['analysts'][0]['items'][0]
ok('⑩ ⭐ 標題抽不到,但簡介抽得到', {x['s'] for x in i0['syms']} == {'2330', '2317'}, i0['syms'])
# ⚠️ ⛔ 別用 `'x' not in json.dumps(...)` 判斷 —— `pxd`/`pxnd` 裡面就有字母 x(第一版誤報)。
ok('⑩ ⛔ 簡介本身不可寫進輸出(只當抽取來源,含贊助商文案又佔空間)',
   'x' not in i0, list(i0.keys()))

# ── ⑪ ⭐⭐ 贊助商不可被當成「他提到的標的」(2026-08-07 實測:股癌 EP684 抽到 5903 全家)──
A._name_map = lambda: {'台積電': '2330', '鴻海': '2317', '全家': '5903'}
A.OUT.unlink(missing_ok=True)
A._resolve_youtube = lambda a: ([{'t': 'EP685 | 🤓', 'u': 'https://y/9', 'd': '2026-08-05', 'kind': 'yt',
                                 'x': A._topic_part('這集聊台積電法說跟鴻海 AI 伺服器。本集贊助:全家便利商店,優惠碼 GOOAYE')}], 'YouTube @Gooaye')
A.build()
d5 = json.loads(A.OUT.read_text(encoding='utf-8'))
i5 = d5['analysts'][0]['items'][0]
got = {x['s'] for x in i5['syms']}
ok('⑪ ⭐⭐ 贊助商(全家 5903)必須被切掉', '5903' not in got, i5['syms'])
ok('⑪ ⭐ 大綱裡真正聊到的還是要抽到', got == {'2330', '2317'}, i5['syms'])
ok('⑪ ⭐ 大綱抽到的要標 via="x"(證據比標題弱)',
   all(x.get('via') == 'x' for x in i5['syms']), i5['syms'])
A._resolve_youtube = lambda a: ([{'t': '台積電怎麼看', 'u': 'https://y/10', 'd': '2026-08-05', 'kind': 'yt', 'x': ''}], 'YouTube @x')
A.OUT.unlink(missing_ok=True)
A.build()
i6 = json.loads(A.OUT.read_text(encoding='utf-8'))['analysts'][0]['items'][0]
ok('⑪ ⭐ 標題抽到的要標 via="t"', i6['syms'][0].get('via') == 't', i6['syms'])

# ── ⑫ ⭐ 相關性守門要**連舊資料一起套**(`must` 是後來加的,舊的壞資料會一直留著)──
A.OUT.write_text(json.dumps({'updated': 'x', 'analysts': [
    {'k': A.ANALYSTS[0]['k'], 'items': [
        {'t': '【理周飆股列車】20260806盤中-許江鎮', 'u': 'https://n/old', 'd': '2026-08-06', 'kind': 'news', 'syms': []},
        {'t': '股惑仔談台積電', 'u': 'https://n/keep', 'd': '2026-08-06', 'kind': 'news', 'syms': []},
        {'t': 'EP685 | 🤓', 'u': 'https://y/ep', 'd': '2026-08-06', 'kind': 'yt', 'syms': []},
    ]}]}, ensure_ascii=False), encoding='utf-8')
A._resolve_youtube = lambda a: ([{'t': '新的一集', 'u': 'https://y/new', 'd': '2026-08-07', 'kind': 'yt', 'x': ''}], 'YouTube @x')
A.build()
d7 = json.loads(A.OUT.read_text(encoding='utf-8'))
urls = {i['u'] for i in d7['analysts'][0]['items']}
ok('⑫ ⭐⭐ 舊的「別人的節目」要被清掉', 'https://n/old' not in urls, sorted(urls))
ok('⑫ ⭐ 舊的「真的有提到他」要留著', 'https://n/keep' in urls, sorted(urls))
ok('⑫ ⛔ 原始節目(kind=yt)不可被 must 誤殺(節目標題本來就不會寫自己名字)',
   'https://y/ep' in urls, sorted(urls))

# ── ⑬ ⭐⭐ 規則改了 → 舊資料的抽取結果要**重算**,但價格快照要留著 ──────────
#    🚨 V72.6.4 實測抓到:舊版「已經有 syms 就跳過」→ 加了贊助商過濾之後,
#       先前用舊規則抽出來的 5903(全家)還掛在那裡,而且沒有 via 欄位 →
#       前端把它顯示成「標題抽到的」= 證據最強那一級。
#    ⛔ 冪等要冪等的是**價格快照**(歷史事實),⛔ 不是抽取結果(規則的產物)。
A._name_map = lambda: {'台積電': '2330', '全家': '5903'}
A.OUT.write_text(json.dumps({'updated': 'x', 'analysts': [
    {'k': A.ANALYSTS[0]['k'], 'items': [
        {'t': '台積電怎麼看', 'u': 'https://y/legacy', 'd': '2026-08-05', 'kind': 'yt',
         # 舊規則留下的:5903 是贊助商誤抽,而且沒有 via / sv
         'syms': [{'s': '2330', 'n': '台積電', 'px': 999.0, 'pxd': '2026-08-05', 'mkt': 22222.0},
                  {'s': '5903', 'n': '全家', 'px': 180.0, 'pxd': '2026-08-05', 'mkt': 22222.0}]},
    ]}]}, ensure_ascii=False), encoding='utf-8')
PX.update({'2330': 1234.0, '^TWII': 30000.0})
A._resolve_youtube = lambda a: ([{'t': '新的一集', 'u': 'https://y/n2', 'd': '2026-08-07', 'kind': 'yt', 'x': ''}], 'YouTube @x')
A._resolve_podcast = lambda a: ([], 'n/a')
A._resolve_news = lambda a: ([], 'n/a')
A.build()
d8 = json.loads(A.OUT.read_text(encoding='utf-8'))
leg = [i for i in d8['analysts'][0]['items'] if i['u'] == 'https://y/legacy'][0]
got8 = {x['s'] for x in leg['syms']}
ok('⑬ ⭐⭐ 舊規則誤抽的贊助商要被重算掉', '5903' not in got8, leg['syms'])
ok('⑬ ⭐ 標題真的有的還在', got8 == {'2330'}, leg['syms'])
ok('⑬ ⭐⭐ 但「他講那天的價格」必須留著(⛔ 不可被今天的收盤蓋掉)',
   leg['syms'][0]['px'] == 999.0 and leg['syms'][0]['mkt'] == 22222.0, leg['syms'])
ok('⑬ ⭐ 重算後要補上 via', leg['syms'][0].get('via') == 't', leg['syms'])
ok('⑬ ⭐ 要記下規則版本(下次規則再改才知道要重算)', leg.get('sv') == A.SYMS_V, leg.get('sv'))
# 同一版重跑不可再動(避免每輪都重算)
_snap = json.dumps(leg, sort_keys=True, ensure_ascii=False)
A.build()
leg2 = [i for i in json.loads(A.OUT.read_text(encoding='utf-8'))['analysts'][0]['items'] if i['u'] == 'https://y/legacy'][0]
ok('⑬ ⭐ 同一版重跑,當日快照不變(只有現價會動)',
   json.dumps({k: v for k, v in leg2.items() if k != 'syms'}, sort_keys=True, ensure_ascii=False)
   == json.dumps({k: v for k, v in leg.items() if k != 'syms'}, sort_keys=True, ensure_ascii=False)
   and leg2['syms'][0]['px'] == 999.0, leg2['syms'])

# ── ⑭ ⭐⭐ 猜不到 handle → 讓 YouTube 自己說(搜尋頻道),但頻道名必須含 must ──────
#    🚨 實測:@guhuozai 解得到 channelId,但最新影片是 2025-09-30 = **解到別人的頻道**。
#       ⛔ 拿別人的頻道充數比「沒有」更糟。
_HTML_HIT = ('...{"text":"某某財經頻道","x":1,"browseId":"UCaaaaaaaaaaaaaaaaaaaaaa"}...'
             '{"text":"兆華與股惑仔","y":2,"browseId":"UCbbbbbbbbbbbbbbbbbbbbbb"}...')
_HTML_MISS = '...{"text":"理周TV","browseId":"UCcccccccccccccccccccccc"}...'

A._get = lambda url: _HTML_HIT.encode('utf-8')
cid, cname = A._yt_search_channel({'n': '兆華與股惑仔', 'must': '股惑仔'})
ok('⑭ ⭐⭐ 搜尋結果裡挑「頻道名含 must」那個', cid == 'UCbbbbbbbbbbbbbbbbbbbbbb', (cid, cname))
ok('⑭ ⛔ 不可挑到排在前面但名字不符的', cname == '兆華與股惑仔', (cid, cname))

A._get = lambda url: _HTML_MISS.encode('utf-8')
cid2, _ = A._yt_search_channel({'n': '兆華與股惑仔', 'must': '股惑仔'})
ok('⑭ ⭐⭐ 沒有一個名字符合 → 回 None(⛔ 不硬選第一個)', cid2 is None, cid2)
ok('⑭ ⭐ 而且要把候選寫進 log(下一輪才查得出來)',
   any('不含' in m and '理周TV' in m for m in A.RESOLVE_LOG[-3:]), A.RESOLVE_LOG[-2:])

A._get = lambda url: '<html>沒有任何 browseId</html>'.encode('utf-8')
cid3, _ = A._yt_search_channel({'n': 'x', 'must': 'x'})
ok('⑭ HTML 沒東西 → 回 None 不爆炸', cid3 is None, cid3)

# ── ⑮ ⭐ 保留窗要夠長,而且「太舊」要由排序+顯示處理,不是一刀切掉 ────────────
#    🚨 實測:14 天窗把兆華兩位僅有的內容(3 則 / 9 則,都已通過名字守門)全濾掉 → 畫面 0 則。
ok('⑮ ⭐ KEEP_DAYS 至少 60 天(冷門節目不會天天上媒體)', A.KEEP_DAYS >= 60, A.KEEP_DAYS)
A._name_map = lambda: {'台積電': '2330'}
A.OUT.unlink(missing_ok=True)
from datetime import datetime as _dt, timedelta as _td
_d20 = (_dt.now(A.TPE) - _td(days=20)).strftime('%Y-%m-%d')
_d90 = (_dt.now(A.TPE) - _td(days=90)).strftime('%Y-%m-%d')
A._resolve_youtube = lambda a: ([
    {'t': '20 天前談台積電', 'u': 'https://y/20', 'd': _d20, 'kind': 'yt', 'x': ''},
    {'t': '90 天前的老影片', 'u': 'https://y/90', 'd': _d90, 'kind': 'yt', 'x': ''},
], 'YouTube @x')
A.build()
d9 = json.loads(A.OUT.read_text(encoding='utf-8'))
u9 = [i['u'] for i in d9['analysts'][0]['items']]
ok('⑮ ⭐ 20 天前的要留著(以前會被 14 天窗殺掉)', 'https://y/20' in u9, u9)
ok('⑮ 90 天前的仍要濾掉(檔案不能無限長大)', 'https://y/90' not in u9, u9)
ok('⑮ ⭐ 最新的排最前面(靠排序而不是切掉來表達新舊)', u9[0] == 'https://y/20', u9)

# ⑮b YouTube 搜尋抓不到配對時要留下可辨識的線索(陷阱 #23)
A._get = lambda url: ('<html>' + 'x' * 5000 + 'CONSENT</html>').encode('utf-8')
A._yt_search_channel({'n': 'x', 'must': 'x'})
ok('⑮b ⭐ 拿到 200 但抓不到配對 → 要寫出 HTML 大小與可能原因',
   any('抓不到頻道配對' in m for m in A.RESOLVE_LOG[-2:]), A.RESOLVE_LOG[-1:])

# ── ⑯ 📄 V72.7.0 抓「內容」不是標題 ────────────────────────────────────────
#    使用者原話:「我覺得標題沒有用,用其它的方式」。股癌標題就是「EP685 | 🤓」。
ok('⑯ 正文抽取:剝掉 script/nav,只留夠長的段落',
   A._main_text('<nav><p>回首頁</p></nav><script><p>x</p></script>'
                '<p>台積電法說會釋出樂觀展望,今年資本支出上修,先進封裝продовж滿載。</p><p>短</p>')
   .startswith('台積電法說會'), A._main_text('<p>台積電法說會釋出樂觀展望,今年資本支出上修,先進封裝滿載。</p>'))
ok('⑯ videoId 抽得出來', A._vid_of('https://www.youtube.com/watch?v=abc12345678') == 'abc12345678',
   A._vid_of('https://www.youtube.com/watch?v=abc12345678'))
ok('⑯ 短網址也要吃', A._vid_of('https://youtu.be/abc12345678') == 'abc12345678')
ok('⑯ 不是影片 → 空字串(⛔ 不亂猜)', A._vid_of('https://news.x/1') == '')

# ⭐ 內容抽標的:標題抽不到、逐字稿抽得到
A._name_map = lambda: {'台積電': '2330', '鴻海': '2317'}
A.OUT.unlink(missing_ok=True)
A._get = lambda url: b''
A._yt_transcript = lambda vid: '這集我們先聊台積電的法說會,後面再談鴻海的 AI 伺服器出貨'
A._resolve_youtube = lambda a: ([{'t': 'EP685 | 🤓', 'u': 'https://www.youtube.com/watch?v=abc12345678',
                                 'd': _dt.now(A.TPE).strftime('%Y-%m-%d'), 'kind': 'yt', 'x': ''}], 'YouTube @Gooaye')
A._resolve_podcast = lambda a: ([], 'n/a')
A._resolve_news = lambda a: ([], 'n/a')
A.build()
dA = json.loads(A.OUT.read_text(encoding='utf-8'))
iA = dA['analysts'][0]['items'][0]
ok('⑯ ⭐⭐ 標題「EP685 | 🤓」抽不到,逐字稿抽得到', {x['s'] for x in iA['syms']} == {'2330', '2317'}, iA['syms'])
ok('⑯ ⭐ 要記下內容來源', iA.get('csrc') == 'transcript', iA.get('csrc'))
ok('⑯ ⭐ 要有顯示用摘要(這才是使用者要看的)', '台積電' in (iA.get('sum') or ''), iA.get('sum'))
ok('⑯ ⛔ 全文不可寫進檔案(逐字稿可能上萬字)', '_body' not in iA, list(iA.keys()))
ok('⑯ ⭐ 摘要要夠短(≤120)', len(iA.get('sum') or '') <= 120, len(iA.get('sum') or ''))

# 抓不到內容 → csrc='' 且不假造摘要
A.OUT.unlink(missing_ok=True)
A._yt_transcript = lambda vid: ''
A._resolve_youtube = lambda a: ([{'t': 'EP686', 'u': 'https://www.youtube.com/watch?v=zzz12345678',
                                 'd': _dt.now(A.TPE).strftime('%Y-%m-%d'), 'kind': 'yt', 'x': ''}], 'YouTube @Gooaye')
A.build()
iB = json.loads(A.OUT.read_text(encoding='utf-8'))['analysts'][0]['items'][0]
ok('⑯ ⭐⛔ 抓不到內容 → csrc 空字串(有記錄「試過了」)', iB.get('csrc') == '', iB.get('csrc'))
ok('⑯ ⭐⛔ 而且不可假造摘要', not iB.get('sum'), iB.get('sum'))

# 預算:一輪不可無限抓
ok('⑯ ⭐ 每輪抓取有預算上限(⛔ 別一次打爆對方)', A.FETCH_BUDGET <= 20, A.FETCH_BUDGET)

print()
if FAILS:
    print(f'❌ {len(FAILS)} 條失敗:')
    for f in FAILS:
        print(' - ' + f)
    sys.exit(1)
print('✅ ANALYST_MINER_TEST_PASS')
