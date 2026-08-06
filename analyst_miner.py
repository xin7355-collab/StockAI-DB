#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🎙️ 財經分析師焦點採礦(analyst_miner)—— 產出 data/analyst_focus.json

使用者要求(2026-08-06):消息面加一個「財經分析師焦點」,收
兆華與股惑仔 / 兆華艾綸說 / 股癌 / 郭哲榮,只挖最新的,分析標的,
並「關注他們說的時候的價格」。

⚠️⚠️ 先講清楚這支**做得到什麼、做不到什麼**(⛔ 別再花時間往做不到的方向試):
  ✅ 做得到:最新一集的**標題 + 發布時間 + 連結**(YouTube RSS / Podcast RSS,零金鑰)
  ✅ 做得到:從標題抽台股標的 → 記下**發布當天的收盤價**與**當天加權指數**
     → 前端就能算「從他提到至今漲跌幾%、贏不贏大盤」
  ⛔ **做不到:逐字稿**。YouTube 逐字稿端點在 GitHub IP 常被擋,而且沙箱連不到無法驗證。
     所以「他說了什麼」只有**標題**這一層 —— 標題常是釣魚式(「台股崩了嗎?」)→
     輸出一律標 `kind`,前端要誠實顯示這是「標題層級」不是「他的完整論點」。

⛔ **這支不下多空、不計分**。理由跟 `_trustVolRatioNote` 同一條:
   「某某老師說 X」的預測力**從來沒被驗證過**,而且 CLAUDE.md 對郭哲榮那份評估
   已經寫明他「準」的一半是話術結構(條件式預告、雙向皆贏)。
   → 只做**事實描述 + 可回頭驗證的價格快照**。累積滿一年後才談要不要計分。

🔗 來源解析鏈(每位分析師依序試,⛔ 全部失敗才算失敗):
   ① YouTube handle → 抓頻道頁 HTML → regex `"channelId":"UC..."` → RSS
   ② Podcast RSS(直接給)
   ③ Google News RSS 搜尋(保底 —— 一定有東西,但那是「媒體報導他說了什麼」不是原始節目)
⭐ 每一步的成敗都寫進輸出的 `resolve_log`(同 `_taifex_list_endpoints` 的做法)——
   沙箱與 CI 都連不到時,log 只印在 workflow 裡會過期,**寫進 JSON 才查得到**。

exit code:0 = 至少一位分析師有內容;2 = 全部落空(workflow 不部署,保留舊檔)。
"""
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

DATA_DIR = Path('data')
OUT = DATA_DIR / 'analyst_focus.json'

TPE = timezone(timedelta(hours=8))
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'}

# 保留幾天的內容。⭐ 使用者要求「第一次挖礦多挖 3 天前的資訊」——
# YouTube/Podcast RSS 一次就給最近 10~15 集,天然涵蓋好幾天,所以首跑就會有;
# 這個參數只是**保留上限**,避免檔案無限長大。
KEEP_DAYS = int(os.getenv('ANALYST_KEEP_DAYS', '14'))
MAX_ITEMS = int(os.getenv('ANALYST_MAX_ITEMS', '12'))     # 每位最多留幾則
RSS_SLEEP = float(os.getenv('ANALYST_RSS_SLEEP', '1.0'))
TIMEOUT = int(os.getenv('ANALYST_TIMEOUT', '20'))

# ⚠️ handle 是**候選清單**不是定論 —— 沙箱連不到 YouTube,無法在這裡驗證。
#    解析失敗會寫進 resolve_log,下一輪照著改就好(⛔ 別憑猜的把錯的寫死當成功)。
# ⚠️ handle 是**候選清單**不是定論。2026-08-07 首跑實測(resolve_log 有紀錄):
#     ✅ 股癌 @Gooaye → UC23rnlQU_qE3cec9x709peA(通)
#     ❌ 兆華兩位、郭哲榮的候選 handle 全部 404(@moneymoore 解得到 id 但 feed 是空的)
#   → 那三位目前吃 Google News 保底。要接通只要把正確的 @handle 加進 `yt` 就好,
#     ⛔ 別把 `must` 拿掉(那是擋「別人的節目」的唯一防線)。
# `must`:Google News 保底時,標題**必須**出現這個字才收(見 `_resolve_news`)。
ANALYSTS = [
    {'k': 'zhaohua_guhuozai', 'n': '兆華與股惑仔', 'tag': '📺 YouTube',
     'yt': ['@stockmasterTW', '@兆華與股惑仔', '@zhaohuastock', '@guhuozai'],
     'news_kw': '兆華 股惑仔', 'must': '股惑仔'},
    {'k': 'zhaohua_ailun', 'n': '兆華艾綸說', 'tag': '📺 YouTube',
     'yt': ['@兆華艾綸說', '@ailun_talk', '@zhaohua_ailun', '@ailunshuo'],
     'news_kw': '兆華艾綸說', 'must': '艾綸'},
    {'k': 'gooaye', 'n': '股癌 Gooaye', 'tag': '🎧 Podcast',
     'yt': ['@Gooaye', '@gooaye_'],
     'podcast': ['https://feeds.soundon.fm/podcasts/954689a5-3096-43a4-a80b-7810b219cef3.xml'],
     'news_kw': '股癌 謝孟恭', 'must': '股癌'},
    {'k': 'kuo_zhe_rong', 'n': '郭哲榮分析師', 'tag': '📺 YouTube',
     'yt': ['@kuozherong', '@郭哲榮分析師', '@moneymoore', '@kuozherong168'],
     'news_kw': '郭哲榮 分析師', 'must': '郭哲榮'},
]

# 🔢 標的抽取的「規則版本」。⭐ 規則一改就 +1 → 舊資料會被**重新抽一次**。
#   🚨 為什麼需要這個(V72.6.4 實測抓到):舊版把「舊項目已經有 syms 就跳過」當成冪等,
#      結果 V72.6.4 加了贊助商過濾之後,**先前用舊規則抽出來的 5903(全家)還掛在那裡**
#      —— 而且因為沒有 via 欄位,前端還把它顯示成「標題抽到的」(證據最強那一級)。
#   ⛔ 冪等要冪等的是**價格快照**(px/mkt,那是歷史事實),⛔ 不是抽取結果(那是規則的產物)。
SYMS_V = 2

RESOLVE_LOG = []


def _log(msg):
    """同時印到 workflow log 與寫進輸出 JSON。
    ⭐ 只印在 log 沒用 —— job log 會過期,而 `git show origin/gh-pages:data/x.json` 永遠讀得到。"""
    print(f'   {msg}')
    RESOLVE_LOG.append(msg)


def _now_iso():
    return datetime.now(TPE).strftime('%Y-%m-%d %H:%M')


# ── 台股股名 → 代號 ─────────────────────────────────────────────────────────
def _name_map():
    """⭐ 直接用 `universal_radar._fetch_full_name_map`(全市場官方 OpenAPI + 內建熱門表)。
    ⛔ 不在這裡複製一份 —— 股名表複製兩份 = 兩邊會漂移(CLAUDE.md「第二份真相」那條)。
    import 失敗(缺 feedparser 之類)才退回只用內建表。"""
    try:
        from universal_radar import _fetch_full_name_map
        m = _fetch_full_name_map()
        if len(m) >= 500:
            return m
        _log(f'⚠️ 股名表只有 {len(m)} 檔(<500)')
        return m
    except Exception as e:
        _log(f'⚠️ 股名表 import 失敗:{type(e).__name__} → 標的抽取會漏很多')
        return {}


def _pick_syms(title, names_by_len, name_map):
    """標題 → 命中的台股代號。去子字串(「南亞」⊂「南亞科」只留長的),同 build_stock_news。"""
    hits = [nm for nm in names_by_len if nm in title]
    hits = [nm for nm in hits if not any(nm != o and nm in o for o in hits)]
    # 標題直接寫代號(如「2330」)也收
    for code in set(re.findall(r'(?<!\d)(\d{4})(?!\d)', title)):
        if code in name_map.values():
            inv = [n for n, c in name_map.items() if c == code]
            if inv and inv[0] not in hits:
                hits.append(inv[0])
    return [(nm, name_map[nm]) for nm in hits][:6]


# ── 價格快照:他講的**那天**的收盤 ──────────────────────────────────────────
_PX_CACHE = {}


def _close_on(sym, ymd):
    """回 (該日或該日之前最近一個交易日的收盤, 實際日期);拿不到回 (None, None)。
    ⛔ 不可用「現在的收盤」代替 —— 那樣「他說的時候的價格」就失去意義了。"""
    key = str(sym)
    if key not in _PX_CACHE:
        f = DATA_DIR / f'{key}.json'
        rows = []
        if f.exists():
            try:
                raw = json.loads(f.read_text(encoding='utf-8'))
                rows = raw if isinstance(raw, list) else (raw.get('data') or [])
            except Exception:
                rows = []
        _PX_CACHE[key] = [(str(r.get('date', '')).replace('/', '-')[:10], r.get('close')) for r in rows]
    hit = None
    for d, c in _PX_CACHE[key]:
        if d and d <= ymd and c not in (None, ''):
            hit = (d, c)
        elif d and d > ymd:
            break
    if not hit:
        return None, None
    try:
        return round(float(hit[1]), 2), hit[0]
    except Exception:
        return None, None


# ── RSS 解析(YouTube / Podcast / Google News 共用) ─────────────────────────
_NS = {'a': 'http://www.w3.org/2005/Atom', 'yt': 'http://www.youtube.com/xml/schemas/2015'}


# 🚨 V72.6.4 節目簡介裡的**贊助商**會被誤抽成「他提到的標的」——
#   實測股癌 EP684 抽到 5903(全家),那是贊助商不是他聊的股票。
#   ⛔ 把贊助商當成「他提到的標的」= 顯示錯的資料給使用者,比沒有更糟。
#   → 只取「贊助/業配/合作」這類標記**之前**那段(節目大綱通常寫在最前面)。
_SPONSOR_RE = re.compile(r'(贊助|業配|合作|廣告|抽獎|優惠碼|折扣碼|團購|開箱|訂閱|加入頻道|會員|來賓介紹|節目資訊|聯絡我們|免責聲明|風險警語)')


def _strip_html(x):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', x or '')).strip()


def _topic_part(x):
    """簡介 → 只留「可能是節目大綱」的那一段。⛔ 寧可少抽,也不要抽到贊助商。"""
    t = _strip_html(x)
    m = _SPONSOR_RE.search(t)
    if m:
        t = t[:m.start()]
    return t[:300]


def _parse_feed(xml_bytes, kind):
    """回 [{'t','u','d','x'}](d = YYYY-MM-DD 台北;x = 內文摘要,只給抽標的用)。
    ⭐ V72.6.3 加 `x`:實測**股癌的影片標題就是「EP685 | 🤓」** —— 標題完全抽不到標的,
       但節目簡介裡通常會列當集聊到什麼。⛔ `x` 只拿來抽標的,**不顯示給使用者**
       (簡介常含大量贊助商文案,顯示出來只是雜訊)。"""
    out = []
    root = ET.fromstring(xml_bytes)
    # Atom(YouTube)
    for e in root.findall('a:entry', _NS):
        t = (e.findtext('a:title', default='', namespaces=_NS) or '').strip()
        link = e.find('a:link', _NS)
        u = link.get('href') if link is not None else ''
        pub = (e.findtext('a:published', default='', namespaces=_NS) or '')[:10]
        x = ''
        for d_el in e.iter():
            if d_el.tag.endswith('}description'):
                x = _topic_part(d_el.text or '')
                break
        if t:
            out.append({'t': t, 'u': u, 'd': pub, 'kind': kind, 'x': x[:900]})
    if out:
        return out
    # RSS 2.0(Podcast / Google News)
    for it in root.iter('item'):
        t = (it.findtext('title') or '').strip()
        u = (it.findtext('link') or '').strip()
        pub = (it.findtext('pubDate') or '').strip()
        # ⛔ Google News 的 description 是「相關報導清單」= 純雜訊 → 不收
        x = '' if kind == 'news' else _topic_part(
            it.findtext('description') or it.findtext('{http://www.itunes.com/dtds/podcast-1.0.dtd}summary') or '')
        d = ''
        if pub:
            try:
                from email.utils import parsedate_to_datetime
                d = parsedate_to_datetime(pub).astimezone(TPE).strftime('%Y-%m-%d')
            except Exception:
                d = ''
        if t:
            out.append({'t': t, 'u': u, 'd': d, 'kind': kind, 'x': x[:900]})
    return out


def _get(url):
    r = requests.get(url, headers=UA, timeout=TIMEOUT)
    if r.status_code != 200 or not r.content:
        raise RuntimeError(f'HTTP {r.status_code}')
    return r.content


def _yt_search_channel(a):
    """⭐ V72.6.6 猜 handle 猜不到 → **讓 YouTube 自己說**(同 `_taifex_list_endpoints` 的做法)。
    搜尋節目名 → 從搜尋結果 HTML 撈「頻道名 + channelId」配對 →
    ⛔ **頻道名必須含 `must`** 才採用(否則會拿到別人的頻道,同 GNews 那條守門)。
    回 (channelId, 頻道名) 或 (None, None)。"""
    must = (a.get('must') or '').strip()
    if not must:
        return None, None
    try:
        html = _get('https://www.youtube.com/results?search_query='
                    + requests.utils.quote(a['n']) + '&sp=EgIQAg%253D%253D').decode('utf-8', 'ignore')   # sp=只搜頻道
    except Exception as e:
        _log(f'{a["n"]}/YT搜尋:{type(e).__name__} {e}')
        return None, None
    # 「文字 … browseId」成對出現(YouTube 的 ytInitialData 結構)
    pairs = re.findall(r'"text":"([^"]{2,40})"[^{}]{0,400}?"browseId":"(UC[\w-]{20,})"', html)
    seen, cands = set(), []
    for nm, cid in pairs:
        if cid in seen:
            continue
        seen.add(cid)
        cands.append((nm, cid))
    hit = next(((nm, cid) for nm, cid in cands if must in nm), None)
    if hit:
        _log(f'🔎 {a["n"]}/YT搜尋 → 「{hit[0]}」{hit[1]}(頻道名含「{must}」)')
        return hit[1], hit[0]
    # ⛔ 沒有一個頻道名含 must → 不硬選第一個(那正是「解到別人的頻道」的來源)
    _log(f'{a["n"]}/YT搜尋:{len(cands)} 個候選都不含「{must}」→ 不採用'
         + (f'(前 3 個:{", ".join(n for n, _ in cands[:3])})' if cands else ''))
    return None, None


def _resolve_youtube(a):
    """handle → channelId → Atom feed。回 (items, note);失敗回 ([], 原因)。"""
    for h in a.get('yt') or []:
        try:
            html = _get('https://www.youtube.com/' + requests.utils.quote(h)).decode('utf-8', 'ignore')
        except Exception as e:
            _log(f'{a["n"]}/YT {h}:頻道頁 {type(e).__name__} {e}')
            continue
        m = re.search(r'"(?:channelId|externalId)"\s*:\s*"(UC[\w-]{20,})"', html)
        if not m:
            # ⚠️ 拿到 200 但沒有 channelId → 多半是 handle 錯(YouTube 對不存在的 handle 回 404 頁面但仍 200)
            _log(f'{a["n"]}/YT {h}:頁面有回應但找不到 channelId(handle 可能不對)')
            continue
        cid = m.group(1)
        try:
            items = _parse_feed(_get(f'https://www.youtube.com/feeds/videos.xml?channel_id={cid}'), 'yt')
            if items:
                _newest = max((x.get('d') or '') for x in items)
                _stale = _newest and _newest < (datetime.now(TPE) - timedelta(days=KEEP_DAYS)).strftime('%Y-%m-%d')
                # ⚠️ 解得到頻道但**最新一部也超過保留天數** → 多半是解到別人的/停更的頻道。
                #    照樣回傳(下游用日期濾掉),但要留線索,否則下一輪只會看到「0 則」查不出原因。
                _log(f'{"⚠️" if _stale else "✅"} {a["n"]}/YT {h} → {cid}({len(items)} 部,最新 {_newest}'
                     + ('・已超過保留天數,可能解到別人的頻道 → 先試搜尋)' if _stale else ')'))
                # ⚠️ 全是舊片多半是解錯頻道 → ⛔ 不直接採用,先讓搜尋試一次(同 V72.6.6 實測 @guhuozai)
                if not _stale:
                    return items, f'YouTube {h}'
            _log(f'{a["n"]}/YT {h} → {cid}:feed 是空的')
        except Exception as e:
            _log(f'{a["n"]}/YT {h} → {cid}:feed {type(e).__name__} {e}')
        time.sleep(RSS_SLEEP)
    # 候選 handle 全部落空 → 改用「搜尋頻道」自動找(⛔ 頻道名要含 must 才採用)
    cid, cname = _yt_search_channel(a)
    if cid:
        try:
            items = _parse_feed(_get(f'https://www.youtube.com/feeds/videos.xml?channel_id={cid}'), 'yt')
            if items:
                _newest = max((x.get('d') or '') for x in items)
                _log(f'✅ {a["n"]}/YT搜尋命中「{cname}」({len(items)} 部,最新 {_newest})')
                return items, f'YouTube 搜尋命中「{cname}」'
            _log(f'{a["n"]}/YT搜尋「{cname}」:feed 是空的')
        except Exception as e:
            _log(f'{a["n"]}/YT搜尋「{cname}」feed:{type(e).__name__} {e}')
    return [], 'YouTube 全部候選 handle 與搜尋都找不到'


def _resolve_podcast(a):
    for u in a.get('podcast') or []:
        try:
            items = _parse_feed(_get(u), 'podcast')
            if items:
                _log(f'✅ {a["n"]}/Podcast → {len(items)} 集')
                return items, 'Podcast RSS'
        except Exception as e:
            _log(f'{a["n"]}/Podcast:{type(e).__name__} {e}')
        time.sleep(RSS_SLEEP)
    return [], 'Podcast RSS 不通'


def _resolve_news(a):
    """保底:Google News 搜尋。⚠️ 這是「媒體報導他說了什麼」,不是原始節目 → kind='news'。"""
    kw = a.get('news_kw') or a['n']
    url = ('https://news.google.com/rss/search?q=' + requests.utils.quote(kw)
           + '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant')
    try:
        items = _parse_feed(_get(url), 'news')
        # 🚨 V72.6.3 相關性守門(首跑實測抓到的真問題):
        #   搜「兆華艾綸說」回來的是《理財達人秀》《理周飆股列車》—— **完全不是他的節目**,
        #   Google News 是模糊比對,關鍵字冷門時會拿一堆沾邊的東西塞給你。
        #   ⛔ 那比「沒有資料」更糟:使用者會以為那是他講的。
        #   → 標題**必須真的出現他的名字**(取關鍵字第一個詞,如「兆華」「郭哲榮」「股癌」)才收。
        need = (a.get('must') or (kw.split() or [a['n']])[0]).strip()
        kept = [x for x in items if need and need in (x.get('t') or '')]
        drop = len(items) - len(kept)
        if kept:
            _log(f'✅ {a["n"]}/GNews「{kw}」→ {len(kept)} 則(濾掉 {drop} 則沒提到「{need}」的)')
            return kept, f'Google News 搜尋「{kw}」'
        _log(f'{a["n"]}/GNews「{kw}」:{len(items)} 則全部沒提到「{need}」→ 全濾掉(⛔ 不拿別人的節目充數)')
    except Exception as e:
        _log(f'{a["n"]}/GNews:{type(e).__name__} {e}')
    return [], 'Google News 也沒有'


def build():
    name_map = _name_map()
    names_by_len = sorted(name_map.keys(), key=len, reverse=True)
    cutoff = (datetime.now(TPE) - timedelta(days=KEEP_DAYS)).strftime('%Y-%m-%d')
    today = datetime.now(TPE).strftime('%Y-%m-%d')

    # 既有檔案 → 合併(讓歷史累積,首跑就有好幾天)
    old = {}
    if OUT.exists():
        try:
            prev = json.loads(OUT.read_text(encoding='utf-8'))
            for a in prev.get('analysts', []):
                old[a.get('k')] = a.get('items') or []
        except Exception:
            old = {}

    out_analysts, n_ok = [], 0
    for a in ANALYSTS:
        items, note = _resolve_youtube(a)
        if not items:
            items, note = _resolve_podcast(a)
        if not items:
            items, note = _resolve_news(a)
        # 🚨 V72.6.4 相關性守門要**連舊資料一起套**:`must` 是後來才加的,
        #   在那之前存下來的「別人的節目」會一直留到過期(實測 14 天)——
        #   ⛔ 使用者不會知道那是舊規則留下來的,只會以為那就是他講的。
        _must = (a.get('must') or '').strip()
        merged = {}
        for it in (old.get(a['k']) or []) + items:
            u = it.get('u') or it.get('t')
            if not u:
                continue
            d = (it.get('d') or '')[:10]
            if d and d < cutoff:
                continue
            # 只擋 news(媒體報導)—— 原始節目本來就不會在標題寫自己的名字
            if _must and (it.get('kind') == 'news') and _must not in (it.get('t') or ''):
                continue
            merged[u] = {**merged.get(u, {}), **it}
        rows = sorted(merged.values(), key=lambda x: (x.get('d') or ''), reverse=True)[:MAX_ITEMS]

        mkt_now, _ = _close_on('^TWII', today)
        for it in rows:
            d = (it.get('d') or today)[:10]
            if not it.get('syms') or it.get('sv') != SYMS_V:
                # ⭐ 重算時**保留舊的價格快照**(px/mkt 是他講那天的歷史事實,不隨規則變)
                _keep = {x['s']: x for x in (it.get('syms') or []) if x.get('px') is not None}
                syms = []
                # ⭐ 標題 + 節目大綱一起抽(股癌那種「EP685 | 🤓」標題只能靠大綱)
                _ttl = it.get('t') or ''
                _from_title = {c for _, c in _pick_syms(_ttl, names_by_len, name_map)}
                for nm, code in _pick_syms(_ttl + ' ' + (it.get('x') or ''), names_by_len, name_map):
                    _old = _keep.get(code)
                    px, pxd = (_old['px'], _old.get('pxd')) if _old else _close_on(code, d)
                    mkt = _old.get('mkt') if _old else _close_on('^TWII', d)[0]
                    # px/pxd/mkt = **他講的那天**的快照 → ⭐ 一旦寫入就不再重算(冪等),
                    #   否則明天重跑會被明天的收盤蓋掉,「他說的時候的價格」就沒意義了。
                    # via:'t'=標題(證據強) / 'x'=節目大綱(證據弱,前端要標出來)
                    syms.append({'s': code, 'n': nm, 'px': px, 'pxd': pxd, 'mkt': mkt,
                                 'via': 't' if code in _from_title else 'x'})
                it['syms'] = syms
                it['sv'] = SYMS_V
            # ⭐ 現價(pxn)與現在的大盤(mktn)**每輪都刷新** —— 這兩個本來就該是最新的。
            #   ⛔ 刻意放在採礦端算:前端要算就得為每檔各發一次 fetch,而這裡讀檔零成本
            #     (而且「同一個數字只有一個地方算」)。
            for x in it['syms']:
                pxn, pxnd = _close_on(x['s'], today)
                x['pxn'], x['pxnd'], x['mktn'] = pxn, pxnd, mkt_now

        # 🧹 `x`(內文摘要)只在抽標的時用得到 → 寫檔前丟掉。
        #   ⛔ 不可留在輸出裡:它是節目簡介,含大量贊助商文案,既是雜訊又會把檔案撐大。
        for it in rows:
            it.pop('x', None)
        # 🚨 守門要看「**本輪**有沒有抓到新的」,⛔ 不可看合併後的 rows ——
        #   舊檔的內容還在 KEEP_DAYS 內就會被併進來,於是**上游全掛的那天看起來也「成功」**,
        #   還會把 updated 換成今天、error 寫成 None(自我測試當場抓到)。
        #   同 CLAUDE.md 那條:「沒有報錯」不能當成「檢查過了」。
        if items:
            n_ok += 1
        out_analysts.append({
            'k': a['k'], 'n': a['n'], 'tag': a['tag'], 'src': note,
            'items': rows,
            'fresh': len(items),
            # 陷阱 #22:抓不到一定要寫原因,⛔ 不可只留空陣列
            'error': None if items else (f'本輪沒抓到新的({note});以下是先前存下來的 {len(rows)} 則' if rows else note),
        })

    payload = {
        'updated': _now_iso(),
        'keep_days': KEEP_DAYS,
        'analysts': out_analysts,
        'resolve_log': RESOLVE_LOG[-60:],
        # ⛔ 這兩句是給前端顯示用的固定免責,別拿掉
        'disclaimer': '只收得到「標題層級」的資訊(沒有逐字稿);標的是從標題抽的,可能不是他的重點。',
        'no_signal': '⛔ 不下多空、不計分 —— 名嘴說法的預測力從未驗證過,這裡只做事實描述與價格快照。',
    }
    # 🛡️ 守門:全部落空就不寫檔(保留舊檔),⛔ 不可用空檔蓋掉有內容的舊檔
    if n_ok == 0:
        print(f'❌ {len(ANALYSTS)} 位分析師本輪全部落空 → 不寫檔,保留舊檔')
        print('   resolve_log:')
        for m in RESOLVE_LOG[-20:]:
            print('    ' + m)
        return False
    DATA_DIR.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    tot = sum(len(x['items']) for x in out_analysts)
    print(f'✅ analyst_focus.json:{n_ok}/{len(ANALYSTS)} 位有內容,共 {tot} 則')
    for x in out_analysts:
        ns = sum(len(i.get('syms') or []) for i in x['items'])
        print(f'   ・{x["n"]}:{len(x["items"])} 則 / 標的 {ns} 個 ・來源 {x["src"]}')
    return True


# ⚠️ 進入點一律放檔案最後面(陷阱 #9;`scripts/check_main_order.py` 會擋)
def main():
    print('🎙️ 財經分析師焦點採礦')
    try:
        ok = build()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f'❌ 例外:{type(e).__name__} {e}')
        ok = False
    sys.exit(0 if ok else 2)


if __name__ == '__main__':
    main()
