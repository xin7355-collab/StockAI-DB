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
    print(f"  class-quote 連結 {len(uniq)} 個;前 40 個名字:{[n for _, n in uniq[:40]]}")
    out['n_links'] = len(uniq)
    for u, n in uniq[:3] + [x for x in uniq if any(k in x[1] for k in ('玻纖', '散熱', 'CPO', '矽光', '機器人'))][:4]:
        code2, ct2, b2, s2 = get('https://tw.stock.yahoo.com' + u.replace('&amp;', '&'))
        syms = sorted(set(re.findall(r'/quote/(\d{4,6})\.TWO?\b', b2)))
        print(f"    {n}: HTTP {code2} ・{len(syms)} 檔 ・{syms[:12]}")
        time.sleep(1.5)
    # 鉅亨概念股(備援)
    code, ct, body, sec = get('https://www.cnyes.com/twstock/concept')
    print(f"  鉅亨 /twstock/concept: HTTP {code} {ct[:30]} ・{len(body)} 字 ・概念連結 {len(set(re.findall(r'/twstock/concept/[^\"\\s]+', body)))} 個")
    return out


def main():
    if '--selftest' in sys.argv:
        xml = ('<rss><channel><item><title><![CDATA[富喬 玻纖布漲]]></title><pubDate>Mon, 26 Oct 2026 08:00:00 GMT</pubDate>'
               '<source url="x">工商時報</source></item><item><title>b</title></item></channel></rss>')
        it = rss_items(xml)
        ok = len(it) == 2 and it[0]['t'] == '富喬 玻纖布漲' and it[0]['s'] == '工商時報' and it[0]['d'].day == 26 and it[1]['d'] is None
        print('✅ NEWS_SRC_SELFTEST_PASS' if ok else f'❌ selftest {it}')
        return 0 if ok else 1
    probe_news()
    probe_concepts()
    print('\n(只量測,⛔ 沒寫任何檔)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
