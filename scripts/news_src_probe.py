#!/usr/bin/env python3
"""🔬 新聞逐檔來源 + 概念股分類頁 探路(V79.9.4,只量測、⛔ 不寫任何檔)

使用者 10/27:「富喬最近分析師、新聞都在講這一檔,又連跌好幾天 → 該賣」—— 想測得先有「每一檔每天幾則新聞」。
本站 news_hist.json 只從 12 個大盤新聞 RSS 的標題比對股名(48 天 667 則、富喬 2 則)→ 從來沒有逐檔問過。
這支在 Actions 上問幾個「逐檔」來源,印出:一次幾則、日期跨多久、能不能指定月份(回補用)、被擋 / 限流訊號。
順便問 Yahoo 股市的「概念股」分類頁(板塊輪動要改成概念股,現有 megatime 名單停在 2021 年左右)。

沙箱連不到這些網站 → 只能在 Actions 跑(news_src_probe.yml)。
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
STOCKS = [('1815', '富喬'), ('2330', '台積電'), ('3231', '緯創'), ('2382', '廣達'), ('6213', '聯茂')]


def get(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9'})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return r.status, r.headers.get('content-type', ''), body.decode('utf-8', 'replace'), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('content-type', '') if e.headers else '', '', time.time() - t0
    except Exception as e:
        return None, type(e).__name__, str(e)[:200], time.time() - t0


def rss_items(xml):
    out = []
    for it in re.findall(r'<item>(.*?)</item>', xml, re.S):
        t = re.search(r'<title>(.*?)</title>', it, re.S)
        d = re.search(r'<pubDate>(.*?)</pubDate>', it, re.S)
        s = re.search(r'<source[^>]*>(.*?)</source>', it, re.S)
        title = re.sub(r'<!\[CDATA\[|\]\]>', '', t.group(1)).strip() if t else ''
        dt = None
        if d:
            try:
                dt = parsedate_to_datetime(d.group(1).strip()).astimezone(timezone.utc)
            except Exception:
                dt = None
        out.append({'t': title, 'd': dt, 's': (s.group(1).strip() if s else '')})
    return out


def summarize(label, url, items, code, ct, sec):
    ds = sorted(x['d'] for x in items if x['d'])
    span = f"{ds[0]:%Y-%m-%d} ~ {ds[-1]:%Y-%m-%d}" if ds else '—'
    srcs = len({x['s'] for x in items if x['s']})
    print(f"  {label}: HTTP {code} {ct[:30]} {sec:.1f}s ・{len(items)} 則 ・日期 {span} ・{srcs} 家媒體")
    for x in items[:3]:
        print(f"      · {x['d']:%m-%d} [{x['s'][:8]}] {x['t'][:60]}" if x['d'] else f"      · [{x['s'][:8]}] {x['t'][:60]}")
    return {'n': len(items), 'span': span, 'srcs': srcs, 'code': code}


def google_news(q):
    return 'https://news.google.com/rss/search?' + urllib.parse.urlencode({'q': q, 'hl': 'zh-TW', 'gl': 'TW', 'ceid': 'TW:zh-Hant'})


def probe_news():
    res = {}
    for sym, nm in STOCKS:
        print(f"\n📰 {sym} {nm}")
        r = res[sym] = {}
        tests = [
            ('G 名字', google_news(nm)),
            ('G 名字+代號', google_news(f'{nm} {sym}')),
            ('G 近 7 天', google_news(f'{nm} {sym} when:7d')),
            ('G 指定 2025-03', google_news(f'{nm} {sym} after:2025-03-01 before:2025-04-01')),
            ('G 指定 2024-06', google_news(f'{nm} {sym} after:2024-06-01 before:2024-07-01')),
            ('Yahoo 個股 RSS', f'https://tw.stock.yahoo.com/rss?s={sym}'),
        ]
        for lab, url in tests:
            code, ct, body, sec = get(url)
            items = rss_items(body) if code == 200 else []
            r[lab] = summarize(lab, url, items, code, ct, sec)
            time.sleep(1.5)
        # 鉅亨關鍵字搜尋(有翻頁 → 可能回補得到)
        url = 'https://ess.api.cnyes.com/ess/api/v1/news/keyword?' + urllib.parse.urlencode({'q': nm, 'limit': 100, 'page': 1})
        code, ct, body, sec = get(url)
        n, span = 0, '—'
        try:
            j = json.loads(body)
            items = ((j.get('data') or {}).get('items')) or []
            n = len(items)
            ts = sorted(int(x.get('publishAt') or 0) for x in items if x.get('publishAt'))
            if ts:
                span = f"{datetime.fromtimestamp(ts[0], timezone.utc):%Y-%m-%d} ~ {datetime.fromtimestamp(ts[-1], timezone.utc):%Y-%m-%d}"
            tot = (j.get('data') or {}).get('total')
            last = (j.get('data') or {}).get('last_page')
            print(f"  鉅亨搜尋: HTTP {code} {sec:.1f}s ・這頁 {n} 則 ・{span} ・總共 {tot} 則 / {last} 頁")
            for x in items[:3]:
                print(f"      · {datetime.fromtimestamp(int(x.get('publishAt') or 0), timezone.utc):%m-%d} {str(x.get('title'))[:60]}")
            r['cnyes'] = {'n': n, 'span': span, 'total': tot, 'pages': last, 'code': code}
        except Exception as e:
            print(f"  鉅亨搜尋: HTTP {code} {ct[:30]} 讀不出 JSON({type(e).__name__})開頭 {body[:120]!r}")
            r['cnyes'] = {'n': 0, 'code': code, 'err': type(e).__name__}
        time.sleep(1.5)
    return res


def probe_cnyes_depth():
    """鉅亨關鍵字搜尋能翻到多舊(回補用):富喬 / 聯茂 翻第 2、4、8、16 頁看最舊那則的日期"""
    print('\n📚 鉅亨搜尋翻頁深度')
    for nm in ('富喬', '聯茂'):
        for pg in (2, 4, 8, 16, 40):
            url = 'https://ess.api.cnyes.com/ess/api/v1/news/keyword?' + urllib.parse.urlencode({'q': nm, 'limit': 100, 'page': pg})
            code, ct, body, sec = get(url)
            try:
                j = json.loads(body); d = j.get('data') or {}
                ts = sorted(int(x.get('publishAt') or 0) for x in (d.get('items') or []) if x.get('publishAt'))
                rng = f"{datetime.fromtimestamp(ts[0], timezone.utc):%Y-%m-%d} ~ {datetime.fromtimestamp(ts[-1], timezone.utc):%Y-%m-%d}" if ts else '—'
                print(f"  {nm} page {pg}: HTTP {code} ・{len(d.get('items') or [])} 則 ・{rng} ・keys {sorted(d.keys())[:8]}")
            except Exception as e:
                print(f"  {nm} page {pg}: HTTP {code} {type(e).__name__} {body[:100]!r}")
            time.sleep(1.2)
    # 鉅亨個股新聞(以代號)
    for sym in ('1815', '6213'):
        for url in (f'https://api.cnyes.com/media/api/v1/newslist/TWS:{sym}:STOCK/symbolNews?limit=100&page=1',
                    f'https://ess.api.cnyes.com/ess/api/v1/news/stock/TWS:{sym}:STOCK?limit=100&page=1'):
            code, ct, body, sec = get(url)
            print(f"  個股 {sym} {url.split('/api/')[1][:50]}: HTTP {code} {ct[:25]} 開頭 {body[:160]!r}")
            time.sleep(1.2)


def probe_concepts():
    print('\n🎯 Yahoo 股市 概念股分類頁')
    out = {}
    code, ct, body, sec = get('https://tw.stock.yahoo.com/class')
    print(f"  /class: HTTP {code} {ct[:30]} {sec:.1f}s ・{len(body)} 字")
    links = re.findall(r'href="(/class-quote\?[^"]+)"[^>]*>(?:<[^>]+>)*([^<]{1,30})<', body)
    concept = [(u, n.strip()) for u, n in links if 'sectorId' in u]
    seen, uniq = set(), []
    for u, n in concept:
        if u not in seen:
            seen.add(u)
            uniq.append((u, n))
    print(f"  class-quote 連結 {len(uniq)} 個;全部名字:{[n for _, n in uniq]}")
    print(f"  連結樣本:{[u for u, _ in uniq[40:50]]}")
    out['n_links'] = len(uniq)
    for u, n in uniq[40:46] + [x for x in uniq if any(k in x[1] for k in ('玻纖', '散熱', 'CPO', '矽光', '機器人', '記憶體', 'AI'))][:6]:
        code2, ct2, b2, s2 = get('https://tw.stock.yahoo.com' + u.replace('&amp;', '&'))
        syms = sorted(set(re.findall(r'/quote/(\d{4,6})\.TWO?\b', b2)))
        print(f"    {n}: HTTP {code2} ・{len(syms)} 檔 ・{syms[:12]}")
        time.sleep(1.5)
    # 鉅亨概念股(備援)
    code, ct, body, sec = get('https://www.cnyes.com/twstock/concept')
    n_cn = len(set(re.findall(r'/twstock/concept/[^"\s]+', body)))
    print(f"  鉅亨 /twstock/concept: HTTP {code} {ct[:30]} ・{len(body)} 字 ・概念連結 {n_cn} 個")
    return out


def _cnyes_items(body):
    """鉅亨 API 回應 → (items, data dict);讀不出 → ([], {})"""
    try:
        j = json.loads(body)
    except Exception:
        return [], {}
    d = j.get('data') if isinstance(j.get('data'), dict) else (j.get('items') if isinstance(j.get('items'), dict) else j)
    d = d if isinstance(d, dict) else {}
    items = d.get('data') if isinstance(d.get('data'), list) else (d.get('items') if isinstance(d.get('items'), list) else [])
    return items or [], d


def _span(items):
    ts = sorted(int(x.get('publishAt') or 0) for x in items if isinstance(x, dict) and x.get('publishAt'))
    return (f"{datetime.fromtimestamp(ts[0], timezone.utc):%Y-%m-%d} ~ {datetime.fromtimestamp(ts[-1], timezone.utc):%Y-%m-%d}" if ts else '—'), (ts[0] if ts else None)


def probe_hist():
    """📚 V80.1.2 新聞「回補得到多舊」(19 個專案之外:使用者 10/31「新聞抓法沒有很完整,補齊後再做多因子回測」)
    ① 鉅亨個股新聞(symbolNews)翻頁:第 1 / 2 / 5 / 10 / 20 / 50 頁還有沒有、最舊到哪天、總共幾頁
    ② 鉅亨分類新聞 + 日期區間(台股新聞 tw_stock):2012 / 2015 / 2018 / 2021 / 2024 各一週 → 有沒有、幾則、總共幾頁
    ③ 鉅亨關鍵字搜尋第 5 / 6 / 8 頁:「約 4 頁」是不是硬上限
    ④ Google 新聞 每週一個窗口 vs 一整月(富喬 2025-03)+ 越舊越少:2019 / 2021 / 2023 / 2025 同一個月
    ⛔ 只印數量 / 日期 / HTTP 狀態,⛔ 寫任何檔"""
    print('\n📚 ① 鉅亨個股新聞(symbolNews)翻頁深度')
    for sym in ('1815', '2330'):
        for pg in (1, 2, 5, 10, 20, 50):
            url = f'https://api.cnyes.com/media/api/v1/newslist/TWS:{sym}:STOCK/symbolNews?limit=30&page={pg}'
            code, ct, body, sec = get(url)
            items, d = _cnyes_items(body)
            span, _ = _span(items)
            print(f"  {sym} page {pg}: HTTP {code} ・{len(items)} 則 ・{span} ・total {d.get('total')} ・last_page {d.get('last_page')}")
            time.sleep(1.2)
            if code == 200 and not items:
                break
    print('\n📚 ② 鉅亨分類新聞 + 日期區間(台股新聞)')
    for y in (2012, 2015, 2018, 2021, 2024):
        a = int(datetime(y, 3, 4, tzinfo=timezone.utc).timestamp()); b = a + 7 * 86400
        for cat in ('tw_stock', 'tw_stock_news'):
            url = f'https://api.cnyes.com/media/api/v1/newslist/category/{cat}?startAt={a}&endAt={b}&limit=30&page=1'
            code, ct, body, sec = get(url)
            items, d = _cnyes_items(body)
            span, _ = _span(items)
            print(f"  {y}-03 一週 [{cat}]: HTTP {code} ・{len(items)} 則 ・{span} ・total {d.get('total')} ・last_page {d.get('last_page')}")
            time.sleep(1.2)
    print('\n📚 ③ 鉅亨關鍵字搜尋:第 4 頁之後還有沒有')
    for nm in ('台積電', '富喬'):
        for pg in (4, 5, 6, 8):
            url = 'https://ess.api.cnyes.com/ess/api/v1/news/keyword?' + urllib.parse.urlencode({'q': nm, 'limit': 100, 'page': pg})
            code, ct, body, sec = get(url)
            items, d = _cnyes_items(body)
            span, _ = _span(items)
            print(f"  {nm} page {pg}: HTTP {code} ・{len(items)} 則 ・{span} ・total {d.get('total')} ・last_page {d.get('last_page')}")
            time.sleep(1.2)
    print('\n📚 ④ Google 新聞:每週窗口 vs 一整月、越舊越少')
    for nm, sym in (('富喬', '1815'), ('台積電', '2330')):
        code, ct, body, sec = get(google_news(f'{nm} {sym} after:2025-03-01 before:2025-04-01'))
        print(f"  {nm} 2025-03 一整月: HTTP {code} ・{len(rss_items(body)) if code == 200 else 0} 則")
        time.sleep(1.5)
        tot = 0
        for a, b in (('2025-03-01', '2025-03-08'), ('2025-03-08', '2025-03-15'), ('2025-03-15', '2025-03-22'), ('2025-03-22', '2025-04-01')):
            code, ct, body, sec = get(google_news(f'{nm} {sym} after:{a} before:{b}'))
            n = len(rss_items(body)) if code == 200 else 0
            tot += n
            print(f"    {a} ~ {b}: HTTP {code} ・{n} 則")
            time.sleep(1.5)
        print(f"  {nm} 2025-03 四週加起來 {tot} 則")
        for y in (2019, 2021, 2023, 2025):
            code, ct, body, sec = get(google_news(f'{nm} {sym} after:{y}-06-01 before:{y}-06-08'))
            it = rss_items(body) if code == 200 else []
            ds = sorted(x['d'] for x in it if x['d'])
            print(f"    {y}-06 第一週: HTTP {code} ・{len(it)} 則" + (f" ・{ds[0]:%Y-%m-%d} ~ {ds[-1]:%Y-%m-%d}" if ds else ''))
            time.sleep(1.5)


def _codes(item):
    """鉅亨一則新聞標了哪些台股代號(market[].code / stock[] / market[].symbol 'TWS:2330:STOCK')→ 排好的 list;沒有 → []"""
    out = set()
    if not isinstance(item, dict):
        return []
    for m in item.get('market') or []:
        if isinstance(m, dict):
            c = str(m.get('code') or '')
            sym = str(m.get('symbol') or '')
            if sym.startswith('TWS:') or sym.startswith('TWG:'):
                c = sym.split(':')[1]
            if re.fullmatch(r'\d{4,6}[A-Z]?', c):
                out.add(c)
        elif isinstance(m, str) and re.fullmatch(r'\d{4,6}[A-Z]?', m):
            out.add(m)
    for c in item.get('stock') or []:
        c = str(c.get('code') if isinstance(c, dict) else c)
        if re.fullmatch(r'\d{4,6}[A-Z]?', c):
            out.add(c)
    return sorted(out)


def probe_fields():
    """📚 V80.1.3 鉅亨分類新聞的每一則有沒有標股票代號(要回補 2015 起逐檔新聞,得靠這個 —— 不然只能拿標題比對股名):
    ① 2015 / 2021 / 2024 各一週的 tw_stock 第 1 頁:第一則有哪些欄位、跟股票有關的欄位長怎樣、這一頁幾則帶代號、子分類分布
    ② limit=100 一頁給不給 100 則(回補要打幾次)
    ⛔ 只印,⛔ 寫任何檔"""
    print('\n🏷️ ① 鉅亨分類新聞的欄位 / 有沒有標股票代號')
    for y in (2015, 2021, 2024):
        a = int(datetime(y, 3, 4, tzinfo=timezone.utc).timestamp()); b = a + 7 * 86400
        url = f'https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?startAt={a}&endAt={b}&limit=30&page=1'
        code, ct, body, sec = get(url)
        items, d = _cnyes_items(body)
        print(f"  {y}-03 一週 tw_stock page 1: HTTP {code} ・{len(items)} 則 ・total {d.get('total')}")
        if not items:
            time.sleep(1.2); continue
        it0 = items[0]
        print(f"    欄位:{sorted(it0.keys()) if isinstance(it0, dict) else type(it0).__name__}")
        for k in ('market', 'stock', 'otherProduct', 'keyword', 'categoryName', 'categoryId', 'summary'):
            if isinstance(it0, dict) and k in it0:
                v = it0[k]
                print(f"    {k} = {json.dumps(v, ensure_ascii=False)[:160]}")
        tagged = [x for x in items if _codes(x)]
        cats = {}
        for x in items:
            if isinstance(x, dict):
                cats[x.get('categoryName')] = cats.get(x.get('categoryName'), 0) + 1
        print(f"    這一頁 {len(tagged)}/{len(items)} 則帶台股代號 ・子分類 {cats}")
        for x in tagged[:3]:
            print(f"      {str(x.get('title'))[:40]} → {_codes(x)}")
        for x in [x for x in items if not _codes(x)][:2]:
            print(f"      (沒帶代號){str(x.get('title'))[:40]}")
        time.sleep(1.2)
    print('\n🏷️ ② 一頁可以拿幾則(limit=100)')
    a = int(datetime(2018, 3, 4, tzinfo=timezone.utc).timestamp()); b = a + 7 * 86400
    for lim in (30, 100):
        code, ct, body, sec = get(f'https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?startAt={a}&endAt={b}&limit={lim}&page=1')
        items, d = _cnyes_items(body)
        print(f"  limit={lim}: HTTP {code} ・{len(items)} 則 ・total {d.get('total')} ・last_page {d.get('last_page')} ・{sec:.1f} 秒")
        time.sleep(1.2)


def main():
    if '--selftest' in sys.argv:
        xml = ('<rss><channel><item><title><![CDATA[富喬 玻纖布漲]]></title><pubDate>Mon, 26 Oct 2026 08:00:00 GMT</pubDate>'
               '<source url="x">工商時報</source></item><item><title>b</title></item></channel></rss>')
        it = rss_items(xml)
        ok = len(it) == 2 and it[0]['t'] == '富喬 玻纖布漲' and it[0]['s'] == '工商時報' and it[0]['d'].day == 26 and it[1]['d'] is None
        its, dd = _cnyes_items(json.dumps({'items': {'data': [{'publishAt': 1700000000, 'title': 'x'}], 'total': 5, 'last_page': 1}}))
        ok2 = len(its) == 1 and dd.get('total') == 5 and _span(its)[0].startswith('2023-11-14')
        its3, _ = _cnyes_items('<html>')
        # 🏷️ _codes:market[].code / market[].symbol / stock[];權證、海外代號、空的都不收
        c1 = _codes({'market': [{'code': '2330', 'symbol': 'TWS:2330:STOCK'}, {'code': 'AAPL', 'symbol': 'USS:AAPL:STOCK'}],
                     'stock': ['3231', {'code': '6213'}, '']})
        c2 = _codes({'market': [{'symbol': 'TWG:8299:STOCK'}], 'stock': None})
        c3 = _codes({'title': 'x'})
        ok3 = c1 == ['2330', '3231', '6213'] and c2 == ['8299'] and c3 == [] and _codes('x') == []
        ok = ok and ok2 and its3 == [] and ok3
        print('✅ NEWS_SRC_SELFTEST_PASS' if ok else f'❌ selftest {it} {its} {dd} codes={c1} {c2} {c3}')
        return 0 if ok else 1
    if '--fields' in sys.argv:
        probe_fields()
        print('\n(只量測,⛔ 沒寫任何檔)')
        return 0
    if '--hist' in sys.argv:
        probe_hist()
        print('\n(只量測,⛔ 沒寫任何檔)')
        return 0
    if '--quick' not in sys.argv:
        probe_news()
    probe_cnyes_depth()
    probe_concepts()
    print('\n(只量測,⛔ 沒寫任何檔)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
