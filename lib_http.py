#!/usr/bin/env python3
"""🔌 V80.1.9 共用連線守門:被擋就停打、忙就退避、同一個網站固定間隔、身分寫明。

為什麼要有這支(評估紀錄 52;想法參考 twjackysu/TWSEMCPServer〔MIT〕utils/circuit_breaker.py,程式自己寫):
  每支採礦各寫各的重試,遇到 403 / 429 還照打 = 越打越容易被封;網站掛了還每次等滿 timeout = 白燒時間。
  ① 同一個網站兩次請求至少隔 gap 秒(證交所 www 3 秒 —— 它對短時間大量請求會暫時封 IP)
  ② 連線失敗 / 429 / 5xx → 退避 2 / 4 / 8 / 16 秒再試(最多 4 次)
  ③ 401 / 403、或要 JSON 卻回 HTML 擋頁 → ⛔ 不重試,那個網站這一輪「斷路」:之後再叫它直接回「斷路中」,⛔ 再送出
  ④ 同一個網站連續 trip_after 次(預設 5)都失敗也斷路(網站掛了 → 不要每次都等滿 timeout)
  ⑤ UA 寫明 StockAI-DB(⛔ 不偽裝瀏覽器,V80.1.6 決策);⛔ 被擋就停,不換身分再試
⭐ 新寫的抓取一律走這支(V80.1.9 起:block_deep_fetch.py);舊採礦等改到那支時再換(⛔ 一次全換風險太大)。

跑法:python3 lib_http.py --selftest(離線,網路 / 時間 / 睡眠都換成假的)
"""
import sys
import time
from urllib.parse import urlsplit

UA = 'Mozilla/5.0 (compatible; StockAI-DB/1.0; +https://github.com/xin7355-collab/stockai-db)'
GAPS = {'www.twse.com.tw': 3.0}
BACKOFF = (2, 4, 8, 16)


def page_text(res, n=200):
    """擋頁 / 錯誤頁 → 去掉 script / style / 標籤、壓空白後的開頭 n 字(⛔ 整頁塞進紀錄)。"""
    import re
    raw = getattr(res, 'content', b'') or b''
    t = raw.decode('utf-8', errors='replace') if isinstance(raw, (bytes, bytearray)) else str(raw)
    t = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', t, flags=re.S | re.I)
    t = re.sub(r'<[^>]+>', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()[:n]


def _requests_send(method, url, **kw):
    import requests   # 延後到真的要連網才 import(selftest / 純函式不需要 requests)
    return requests.request(method, url, **kw)


class Gate:
    """一輪採礦共用一個 Gate。request() 回 (response 或 None, 原因);原因空字串 = 成功(HTTP 200)。"""

    def __init__(self, gaps=None, default_gap=1.0, backoff=BACKOFF, trip_after=5, timeout=40,
                 send=None, sleep=time.sleep, clock=time.time, ua=UA):
        self.gaps = dict(GAPS if gaps is None else gaps)
        self.default_gap, self.backoff, self.trip_after, self.timeout = default_gap, tuple(backoff), trip_after, timeout
        self.send, self.sleep, self.clock, self.ua = send or _requests_send, sleep, clock, ua
        self.open = {}      # host → 斷路原因
        self.fails = {}     # host → 連續失敗次數
        self.last = {}      # host → 上一次送出的時間
        self.stats = {'sent': 0, 'retried': 0, 'tripped': 0}
        self.blocked_page = {}   # host → 斷路那一次的回應文字開頭(分得出「暫時封鎖」還是「系統忙碌 / 維護」)

    def _pace(self, host):
        wait = self.gaps.get(host, self.default_gap) - (self.clock() - self.last.get(host, -1e18))
        if wait > 0:
            self.sleep(wait)

    def _trip(self, host, why, res=None):
        if host not in self.open:
            self.stats['tripped'] += 1
        self.open[host] = why
        if res is not None and not isinstance(res, Exception):
            self.blocked_page[host] = page_text(res)
        return None, f'斷路:{why}'

    @staticmethod
    def classify(res, expect='json'):
        """→ ('ok' | 'retry' | 'block' | 'fail', 說明)。純函式。"""
        if isinstance(res, Exception):
            return 'retry', f'連不上 {type(res).__name__}'
        code = getattr(res, 'status_code', 0)
        if code in (401, 403):
            return 'block', f'HTTP {code}'
        if code == 429 or code >= 500:
            return 'retry', f'HTTP {code}'
        if code != 200:
            return 'fail', f'HTTP {code}'
        if expect == 'json':
            head = (getattr(res, 'content', b'') or b'').lstrip()[:20].lower()
            if head.startswith(b'<'):
                return 'block', '要 JSON 卻回 HTML(擋頁)'
        return 'ok', ''

    def request(self, method, url, expect='json', **kw):
        host = urlsplit(url).netloc
        if host in self.open:
            return None, f'斷路中:{self.open[host]}'
        headers = {'User-Agent': self.ua, 'Accept': '*/*', **(kw.pop('headers', None) or {})}
        why = ''
        for i in range(len(self.backoff) + 1):
            self._pace(host)
            try:
                res = self.send(method, url, headers=headers, timeout=self.timeout, **kw)
            except Exception as e:  # noqa: BLE001
                res = e
            self.last[host] = self.clock()
            self.stats['sent'] += 1
            verdict, why = self.classify(res, expect)
            if verdict == 'ok':
                self.fails[host] = 0
                return res, ''
            if verdict == 'block':
                return self._trip(host, why, res)
            if verdict == 'fail':
                return None, why
            self.fails[host] = self.fails.get(host, 0) + 1
            if self.fails[host] >= self.trip_after:
                return self._trip(host, f'連續 {self.fails[host]} 次失敗(最後一次:{why})', res)
            if i < len(self.backoff):
                self.stats['retried'] += 1
                self.sleep(self.backoff[i])
        return None, why

    def get(self, url, **kw):
        return self.request('GET', url, **kw)

    def post(self, url, **kw):
        return self.request('POST', url, **kw)


def selftest():
    fails = []

    def ok(name, cond, got=''):
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {got}'))
        if not cond:
            fails.append(name)

    class R:
        def __init__(self, code, body=b'{}'):
            self.status_code, self.content = code, body

    def make(script):
        """script = 依序要回的東西(R 或 Exception);回 (gate, 呼叫紀錄, 睡了哪些秒數)"""
        calls, slept, t = [], [], [0.0]
        seq = list(script)

        def send(method, url, **kw):
            calls.append((method, url, kw.get('headers', {})))
            x = seq.pop(0)
            if isinstance(x, Exception):
                raise x
            return x

        def sleep(s):
            slept.append(round(s, 3))
            t[0] += s
        g = Gate(send=send, sleep=sleep, clock=lambda: t[0])
        return g, calls, slept

    TW = 'https://www.twse.com.tw/rwd/zh/block/BFIAUU?date=1'
    g, calls, slept = make([R(200)])
    r, why = g.get(TW)
    ok('① 200 → 回 response、原因空字串', r is not None and why == '' and len(calls) == 1)
    ok('①b UA 寫明 StockAI-DB(⛔ 瀏覽器字樣)', 'StockAI-DB' in calls[0][2]['User-Agent']
       and 'Chrome' not in calls[0][2]['User-Agent'] and 'Safari' not in calls[0][2]['User-Agent'])

    g, calls, slept = make([R(503), R(429), ConnectionError('x'), R(200)])
    r, why = g.get(TW)
    # 退避 2 秒之後還差 1 秒才滿證交所的 3 秒間隔 → 會多睡 1 秒(兩條規則都要守)
    ok('② 503 / 429 / 連不上 → 退避 2、4、8 秒再試,第 4 次成功', r is not None and [s for s in slept if s in (2, 4, 8)] == [2, 4, 8]
       and len(calls) == 4 and g.stats['retried'] == 3, (slept, len(calls)))

    g, calls, slept = make([R(403, b'<html>Forbidden</html>'), R(200)])
    r, why = g.get(TW)
    r2, why2 = g.get(TW + '2')
    ok('③ 403 → ⛔ 重試、整個網站斷路;下一個網址 ⛔ 再送出', r is None and '403' in why and len(calls) == 1
       and r2 is None and why2.startswith('斷路中'), (why, why2, len(calls)))
    ok('③b 決定性對照:別的網站不受影響', 'www.twse.com.tw' in g.open and 'www.tpex.org.tw' not in g.open)

    g, calls, slept = make([R(200, b'  <!DOCTYPE html><p>blocked</p>')])
    r, why = g.get(TW)
    ok('④ 要 JSON 卻回 HTML → 當成擋頁、斷路', r is None and 'HTML' in why and g.open)
    ok('④c 斷路那一次的擋頁文字記下來(去標籤 / script / style、壓空白)',
       g.blocked_page.get('www.twse.com.tw') == 'blocked', g.blocked_page)
    g, calls, slept = make([R(403, b'<html><head><style>p{}</style><script>x()</script></head>'
                                  b'<body><h1>Access  Denied</h1>\n your IP</body></html>')])
    g.get(TW)
    g2 = make([R(200, b'{"stat":"OK"}')])[0]
    g2.get(TW)
    ok('④d 403 擋頁 → 文字「Access Denied your IP」;決定性對照:同一個網址回 JSON 的 Gate 什麼都沒記',
       g.blocked_page.get('www.twse.com.tw') == 'Access Denied your IP' and g2.blocked_page == {},
       (g.blocked_page, g2.blocked_page))
    g, calls, slept = make([R(200, b'<!DOCTYPE html>no data')])
    r, why = g.post('https://www.taifex.com.tw/cht/3/x', expect='any')
    ok('④b expect=any(期交所沒資料本來就回 HTML)→ 照常回', r is not None and why == '' and not g.open)

    g, calls, slept = make([R(404), R(200)])
    r, why = g.get(TW)
    ok('⑤ 404 → ⛔ 重試、⛔ 斷路,原因寫 HTTP 404', r is None and why == 'HTTP 404' and len(calls) == 1 and not g.open)

    g, calls, slept = make([R(500)] * 5)
    r, why = g.get(TW)
    ok('⑥ 連續 5 次 5xx → 斷路(網站掛了不要一直等)', r is None and '連續 5 次' in why and g.open, why)

    g, calls, slept = make([R(200), R(200), R(200)])
    g.get(TW)
    g.get(TW)
    g.get('https://www.tpex.org.tw/openapi/v1/x')
    ok('⑦ 同一個網站隔 3 秒(證交所 www)、不同網站不用等', slept == [3.0], slept)

    print(f'\n{"✅ 全過" if not fails else "❌ 失敗 " + str(len(fails)) + " 條"}(共 12 條)')
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    print(__doc__)
