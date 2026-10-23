#!/usr/bin/env python3
"""
🛰️ V79.5.9 新聞來源:科技巨頭每一個來源桶都要真的收得到、前端都要讀得到 + 抓不到的 RSS 要說出「拿到了什麼」

🐛 V73.9.1 在 TECH_GIANTS_SOURCES 加了第 5 桶 `earnings`(巨頭財報),但 fetch_tech_giants_news 的
   `bucket` 還寫死 4 個 → 每一輪 `bucket['earnings']` KeyError(log「⚠️ earnings 失敗: 'earnings'」)
   → tech_giants_news.json 從上線就沒有 earnings,前端 `tg.earnings` 永遠退回關鍵字備援。
   ⛔ 陷阱 #37:加了來源,收的地方沒跟著改。
⛔ 這支走真的 fetch_tech_giants_news(只換掉 RSS 與翻譯):
   ① 每一個來源都有收到東西(含 earnings),輸出檔每一桶都在
   ② 翻譯迴圈每一桶都有跑到(含 earnings)
   ③ ⭐ 決定性對照:臨時多加一個來源 `zzz` → 輸出也要有 `zzz`(桶名跟著來源走;舊寫法會 KeyError)
   ④ 跨檔:index.html 對每一桶都有讀(`tg.<桶名>`)—— 收了沒人讀 = 死資料
   ⑤ 🔎 10/23 實測 11 個 RSS 有 4 個每輪「parse 失敗」整個被丟掉,log 看不出拿到了什麼 →
      兩次都沒有文章時要印出 requests 那次的狀態碼 / 內容類型 / 最後網址 / 開頭;有文章時 ⛔ 不印(決定性對照)
"""
import json
import os
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import universal_radar as U   # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + ('' if cond else f'  {str(extra)[:300]}'))
    if not cond:
        fails.append(name)


_parsed_urls = []


def _fake_parse(url, request_headers=None):
    _parsed_urls.append(url)
    tag = next((k for k, v in U.TECH_GIANTS_SOURCES.items() if v == url), '?')
    return types.SimpleNamespace(entries=[{'title': f'{tag} headline {i}', 'link': f'https://x/{tag}/{i}',
                                           'published': 'Thu, 22 Oct 2026 20:00:00 GMT'} for i in range(5)])


_translated = []


def _fake_groq_json(payload, label=''):
    _translated.append(label)
    return {'title_zh': f'中文 {label}'}, None


def run():
    tmp = Path(tempfile.mkdtemp()) / 'tech_giants_news.json'
    _parsed_urls.clear()
    _translated.clear()
    U.TECH_GIANTS_FILE = tmp
    U.feedparser = types.SimpleNamespace(parse=_fake_parse)
    U._groq_json = _fake_groq_json
    U.GROQ_API_KEYS = ['k']
    U.time = types.SimpleNamespace(sleep=lambda s: None, time=__import__('time').time)
    U.fetch_tech_giants_news()
    return json.loads(tmp.read_text(encoding='utf-8'))


out = run()
keys = list(U.TECH_GIANTS_SOURCES)
ok('① 來源至少 5 桶(含巨頭財報 earnings)', 'earnings' in keys and len(keys) >= 5, keys)
ok('① ⭐ 每一桶都在輸出檔裡、而且有收到東西(⛔ earnings 不可再是空的 / 不存在)',
   all(isinstance(out.get(k), list) and len(out[k]) == 5 for k in keys), {k: len(out.get(k) or []) for k in keys})
ok('② 翻譯每一桶都有跑到(含 earnings,每桶前 3 則)',
   all(sum(lbl == f'tech_giants_{k}' for lbl in _translated) == 3 for k in keys),
   {k: sum(lbl == f'tech_giants_{k}' for lbl in _translated) for k in keys})
ok('② 翻好的字有寫回去', out.get('earnings') and out['earnings'][0].get('title_zh') == '中文 tech_giants_earnings',
   (out.get('earnings') or [{}])[0])

# ③ 決定性對照:多加一個來源 → 輸出也要有(舊的寫死 4 桶 → KeyError → 這一桶不見)
U.TECH_GIANTS_SOURCES['zzz'] = 'https://example.invalid/zzz'
try:
    out2 = run()
    ok('③ 決定性對照:臨時多加來源 zzz → 輸出也要有 zzz(桶名跟著來源走)',
       isinstance(out2.get('zzz'), list) and len(out2['zzz']) == 5, list(out2))
finally:
    U.TECH_GIANTS_SOURCES.pop('zzz', None)

# ④ 跨檔:前端每一桶都有讀
html = (ROOT / 'index.html').read_text(encoding='utf-8')
missing = [k for k in keys if f'tg.{k}' not in html]
ok('④ index.html 對每一桶都有讀 `tg.<桶名>`(收了沒人讀 = 死資料)', not missing, missing)

# ⑤ 抓不到的 RSS 要說出拿到了什麼
import contextlib   # noqa: E402
import io           # noqa: E402
import requests as _req   # noqa: E402


class _Resp:
    def __init__(self, code, text, ctype, url):
        self.status_code, self.text, self.headers, self.url, self.encoding = code, text, {'Content-Type': ctype}, url, None


_real_get = _req.get
_URL = 'https://www.cnyes.com/rss/cat/tw_stock'
try:
    U.feedparser = types.SimpleNamespace(parse=lambda *a, **k: types.SimpleNamespace(
        entries=[], bozo=1, bozo_exception='document declared as us-ascii, but parsed as utf-8'))
    _req.get = lambda url, headers=None, timeout=None: _Resp(
        200, '<!DOCTYPE html>\n<html><head><title>Just a moment...</title></head>', 'text/html; charset=UTF-8',
        'https://www.cnyes.com/blocked')
    U._RSS_DIAG.clear()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        got = U.fetch_feed('鉅亨網台股', _URL)
    log = buf.getvalue()
    ok('⑤ 兩次都沒有文章 → 印出實際拿到的狀態碼 / 類型 / 最後網址 / 開頭',
       got == [] and '🔎 實際拿到:HTTP 200' in log and 'text/html' in log and 'cnyes.com/blocked' in log and 'Just a moment' in log, log)

    def _boom(url, headers=None, timeout=None):
        raise ConnectionError('Max retries exceeded')
    _req.get = _boom
    U._RSS_DIAG.clear()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        U.fetch_feed('鉅亨網台股', _URL)
    ok('⑤ requests 也失敗 → 說出是哪一種失敗', 'requests 也失敗:ConnectionError' in buf.getvalue(), buf.getvalue())

    # 決定性對照:有文章 → ⛔ 不印診斷、⛔ 不記
    U.feedparser = types.SimpleNamespace(parse=lambda *a, **k: types.SimpleNamespace(
        entries=[{'title': '台積電 營收 新高', 'summary': ''}], bozo=0))
    U._RSS_DIAG.clear()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        U.fetch_feed('鉅亨網台股', _URL)
    ok('⑤ 決定性對照:抓得到文章 → 不印診斷、不記', '🔎' not in buf.getvalue() and not U._RSS_DIAG, (buf.getvalue(), U._RSS_DIAG))
finally:
    _req.get = _real_get

# ⑥ V79.6.1 已確認失效的 4 個新聞來源 ⛔ 不可再放回 RSS_SOURCES(10/23 news_express #354 的 🔎 診斷)
_DEAD = {
    'https://www.cnyes.com/rss/cat/tw_stock': '導到 cnyes.com/twstock/error.htm',
    'https://www.cnyes.com/rss/news/realtimenews': '導到 cnyes.com/twstock/error.htm',
    'https://www.moneydj.com/RSS/RSSNews.aspx': '導到 moneydj.com/404.htm',
    'https://ctee.com.tw/feed': 'HTTP 403 Cloudflare 擋機器人',
}
_back = [f'{u}({why})' for u, why in _DEAD.items() if u in U.RSS_SOURCES.values()]
ok('⑥ 已失效的 4 個新聞來源沒有被放回去(要補先確認新網址還活著)', not _back, _back)
ok('⑥ 空過守門:RSS_SOURCES 還有 ≥5 個來源', len(U.RSS_SOURCES) >= 5, len(U.RSS_SOURCES))

print(f"\n{'❌ %d 項未過:' % len(fails) + chr(10) + '  - ' + (chr(10) + '  - ').join(fails) if fails else '✅ 全部通過'}")
sys.exit(1 if fails else 0)
