#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔎 index_rebal_src_probe.py —— 「臺灣 50 / MSCI 成分股調整」的歷史公告去哪裡拿(V80.1.7 探路)

使用者(2026-11-01):「早知道先機」→ 計畫 B3:ETF 一定要照指數規則買賣,規則公開、公告前猜得到誰會進出。
本站算得出「市值排名」(stock_deep/share 每天的發行股數 × 收盤),但要**對答案**就得有正式公告的歷史
(哪一季、誰進誰出、哪天公告、哪天生效)—— 本站一份都沒有。

⛔ 這不是採礦:只印不寫、⛔ 不碰任何分支、⛔ 不需要金鑰。沙箱連不到這些網站 → 只能在 Actions 跑
   (`macro_probe.yml` which=index_rebal)。
⛔ 陷阱 #23:⛔ 猜 API 網址 —— 只從各家**首頁**出發,列出頁面上真的有的連結(連結文字或網址有關鍵字的),
   再往下點一層:列出檔案連結(pdf / xls / csv …)與「有納入 / 刪除字樣」的表格(印前幾列 + 最早年份)。

🔁 第二輪(預設;REBAL_MODE=discover 跑回第一輪)——第一輪(2026-11-02 job 125024681464)找到兩個來源,直接拿:
  · 維基百科「臺灣50指數」的調整表(日期 / 納入指數 / 剔除指數,72 列、2003 年起)→ **每一列整列印出來**
    (`WIKI\t` 開頭一行一列,格子裡的換行換成「 | 」),拿回來當對答案用的歷史(⚠️ 群眾編輯,要另外對官方公告)
  · 臺灣指數公司「技術通知」→ 列出標題有臺灣50 / 定審的通知(日期 + 標題 + 連結),往後翻頁看最早到哪一年
  · 🆕 維基的成分股表(`WIKIMn\t` 開頭)→ 拿目前 50 檔倒推每一季的成分(模擬「誰會被納入」要用)

--selftest:連結抽取、關鍵字挑選、檔案連結、表格、維基表格整列、通知清單(不用網路)。
"""
import os
import re
import sys
import time
from urllib.parse import urljoin, urlparse

ROOTS = [
    ('臺灣指數公司', 'https://taiwanindex.com.tw/'),
    ('證交所', 'https://www.twse.com.tw/zh/index.html'),
    ('FTSE Russell(LSEG)', 'https://www.lseg.com/en/ftse-russell'),
    ('元大投信 ETF', 'https://www.yuantaetfs.com/'),
    ('維基百科 臺灣50指數', 'https://zh.wikipedia.org/wiki/%E8%87%BA%E7%81%A350%E6%8C%87%E6%95%B8'),
    ('MSCI', 'https://www.msci.com/'),
]
KEYS = ('臺灣50', '台灣50', '成分股', '成份股', '定期審核', '審核', '調整', '異動', '指數公告',
        'Taiwan 50', 'TW50', 'onstituent', 'eview', 'otice', 'nnouncement', '0050')
TABLE_KEYS = ('納入', '刪除', '剔除', '新增', '成分股', '成份股', '調整')
FILE_EXT = ('.pdf', '.xls', '.xlsx', '.csv', '.json', '.zip')
FOLLOW = int(os.getenv('FOLLOW') or '6')
SLEEP = float(os.getenv('PROBE_SLEEP') or '1.0')
UA = {'User-Agent': 'Mozilla/5.0 (StockAI-DB index_rebal_src_probe; research)'}


def strip(h):
    t = re.sub(r'<br\s*/?>', ' ', h or '', flags=re.I)
    t = re.sub(r'<[^>]+>', '', t)
    t = t.replace('&nbsp;', ' ').replace('&amp;', '&')
    return re.sub(r'\s+', ' ', t).strip()


def links(html, base):
    """回 [(絕對網址, 連結文字)](去重,保留順序)。"""
    out, seen = [], set()
    for m in re.finditer(r'<a\b[^>]*href\s*=\s*["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', html or '', flags=re.S | re.I):
        u = urljoin(base, m.group(1).strip())
        if not u.startswith('http') or u in seen:
            continue
        seen.add(u)
        out.append((u, strip(m.group(2))[:80]))
    return out


def hit(url, text, keys=KEYS):
    s = f'{url} {text}'
    return any(k in s for k in keys)


def file_links(lk):
    return [(u, t) for u, t in lk if urlparse(u).path.lower().endswith(FILE_EXT)]


def tables_with(html, keys=TABLE_KEYS):
    """回 [(列數, 前 4 列, 出現的最早年份)] —— 只收表格文字裡有納入 / 刪除那類字的表。"""
    out = []
    for tb in re.findall(r'<table\b.*?</table>', html or '', flags=re.S | re.I):
        txt = strip(tb)
        if not any(k in txt for k in keys):
            continue
        rows = []
        for tr in re.findall(r'<tr\b.*?</tr>', tb, flags=re.S | re.I):
            cells = [strip(c) for c in re.findall(r'<t[dh]\b[^>]*>(.*?)</t[dh]>', tr, flags=re.S | re.I)]
            if cells:
                rows.append(cells[:8])
        yrs = [int(y) for y in re.findall(r'(?<!\d)(19[89]\d|20[0-3]\d)(?!\d)', txt)]
        out.append((len(rows), rows[:4], min(yrs) if yrs else None))
    return out


def fetch(session, url):
    time.sleep(SLEEP)
    try:
        r = session.get(url, headers=UA, timeout=30, allow_redirects=True)
        r.encoding = r.encoding or r.apparent_encoding or 'utf-8'
        return r
    except Exception as e:
        print(f'   ❌ {url} 連不上 {type(e).__name__}: {str(e)[:100]}', flush=True)
        return None


def title_of(html):
    m = re.search(r'<title[^>]*>(.*?)</title>', html or '', flags=re.S | re.I)
    return strip(m.group(1))[:60] if m else ''


WIKI = 'https://zh.wikipedia.org/wiki/%E8%87%BA%E7%81%A350%E6%8C%87%E6%95%B8'
TIP_NOTICE = 'https://taiwanindex.com.tw/downloads/technical_notice'
TIP_PAGES = int(os.getenv('TIP_PAGES') or '12')
TW50_KEYS = ('臺灣50', '台灣50', 'Taiwan 50', '定審', '定期審核')


def cell_text(h):
    """格子文字:換行 / <br> / <li> 換成「 | 」,其他標籤拿掉、註腳 [1] 拿掉。"""
    t = re.sub(r'<br\s*/?>|</li>|</p>', ' | ', h or '', flags=re.I)
    t = re.sub(r'<sup[^>]*>.*?</sup>', '', t, flags=re.S | re.I)
    t = strip(t)
    t = re.sub(r'(\s*\|\s*)+', ' | ', t).strip(' |')
    return t


def wiki_rows(html, keys=('納入', '剔除', '刪除')):
    """維基的調整表:表頭有納入 / 剔除那幾張表,每一列整列回傳 [[格子…]](含表頭列)。"""
    out = []
    for tb in re.findall(r'<table\b.*?</table>', html or '', flags=re.S | re.I):
        if not any(k in strip(tb[:4000]) for k in keys):
            continue
        for tr in re.findall(r'<tr\b.*?</tr>', tb, flags=re.S | re.I):
            cells = [cell_text(c) for c in re.findall(r'<t[dh]\b[^>]*>(.*?)</t[dh]>', tr, flags=re.S | re.I)]
            if cells:
                out.append(cells)
    return out


def member_tables(html, min_codes=30):
    """成分股表:表格文字裡不重複的 4 碼代號 ≥ min_codes 的表,整列回傳(含表頭)。⛔ 不用調整表(那張有納入 / 剔除)。"""
    out = []
    for tb in re.findall(r'<table\b.*?</table>', html or '', flags=re.S | re.I):
        txt = re.sub(r'<[^>]+>', ' ', tb)          # ⛔ 用 strip:相鄰格子黏在一起(「甲0」+「1001」→ 01001)會漏算
        if len(set(re.findall(r'(?<!\d)(\d{4})(?!\d)', txt))) < min_codes or '納入' in txt[:3000]:
            continue
        rows = []
        for tr in re.findall(r'<tr\b.*?</tr>', tb, flags=re.S | re.I):
            cells = [cell_text(c) for c in re.findall(r'<t[dh]\b[^>]*>(.*?)</t[dh]>', tr, flags=re.S | re.I)]
            if cells:
                rows.append(cells)
        out.append(rows)
    return out


def notice_items(html, base, keys=TW50_KEYS):
    """通知清單:連結文字有臺灣50 / 定審的 → [(日期或 None, 文字, 網址)];日期抓連結前 300 字內最後一個 YYYY/MM/DD 或 YYYY-MM-DD。"""
    out = []
    for m in re.finditer(r'<a\b[^>]*href\s*=\s*["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', html or '', flags=re.S | re.I):
        txt = strip(m.group(2))
        if not any(k in txt for k in keys):
            continue
        before = strip(html[max(0, m.start() - 300):m.start()])
        ds = re.findall(r'(20\d{2})[/-](\d{1,2})[/-](\d{1,2})', before + ' ' + txt)
        d = f'{ds[-1][0]}-{int(ds[-1][1]):02d}-{int(ds[-1][2]):02d}' if ds else None
        out.append((d, txt[:90], urljoin(base, m.group(1).strip())))
    return out


def page_links(html, base):
    """翻頁連結(網址有 page= 的),照頁碼排。"""
    out = {}
    for u, _ in links(html, base):
        m = re.search(r'[?&]page=(\d+)', u)
        if m:
            out[int(m.group(1))] = u
    return [out[k] for k in sorted(out)]


def main_r2():
    import requests
    s = requests.Session()
    r = fetch(s, WIKI)
    if r is None:
        print('❌ 維基連不上(⛔ 不等於沒有)', flush=True)
    else:
        rows = wiki_rows(r.text or '')
        print(f'=== 維基 臺灣50指數 HTTP {r.status_code} ・調整表 {len(rows)} 列(含表頭)', flush=True)
        for row in rows:
            print('WIKI\t' + '\t'.join(row), flush=True)
        mts = member_tables(r.text or '')
        print(f'=== 維基 成分股表 {len(mts)} 張(不重複代號 ≥30 的表)', flush=True)
        for k, tb in enumerate(mts):
            for row in tb:
                print(f'WIKIM{k}\t' + '\t'.join(row), flush=True)
    seen, items, pages = set(), [], [TIP_NOTICE]
    i = 0
    while i < len(pages) and i < TIP_PAGES:
        u = pages[i]
        i += 1
        r2 = fetch(s, u)
        if r2 is None:
            continue
        h = r2.text or ''
        its = notice_items(h, r2.url)
        print(f'=== 技術通知 第 {i} 頁 {u} HTTP {r2.status_code} ・{len(h)} 字 ・臺灣50 / 定審 {len(its)} 則', flush=True)
        for it in its:
            if it[2] not in seen:
                seen.add(it[2])
                items.append(it)
                print(f'TIP\t{it[0]}\t{it[1]}\t{it[2]}', flush=True)
        for pu in page_links(h, r2.url):
            if pu not in pages:
                pages.append(pu)
    ds = sorted(d for d, _, _ in items if d)
    print(f'📋 技術通知 臺灣50 / 定審 共 {len(items)} 則 ・最早 {ds[0] if ds else None} ・最晚 {ds[-1] if ds else None} ・翻了 {i} 頁', flush=True)
    # 最新兩則臺灣50 通知:往下點一層,印檔案連結與內文開頭(看公告日 / 生效日怎麼寫)
    tw = [it for it in items if any(k in it[1] for k in ('臺灣50', '台灣50'))][:2]
    for d, t, u in tw:
        r3 = fetch(s, u)
        if r3 is None:
            continue
        ct = r3.headers.get('Content-Type', '')
        print(f'   ↳ {d} {t[:40]} HTTP {r3.status_code} ・{ct[:40]} ・{len(r3.content)} bytes', flush=True)
        if 'html' in ct.lower():
            print(f'      內文:{strip(r3.text)[:600]}', flush=True)
            for fu, ft in file_links(links(r3.text, r3.url))[:6]:
                print(f'      📄 {ft[:40]} → {fu}', flush=True)
    return 0


def main():
    import requests
    s = requests.Session()
    summary = []
    for name, root in ROOTS:
        r = fetch(s, root)
        if r is None:
            summary.append((name, '連不上'))
            continue
        html = r.text or ''
        lk = links(html, r.url)
        cand = [(u, t) for u, t in lk if hit(u, t)]
        print(f'\n=== {name} {root} → HTTP {r.status_code} ・{r.headers.get("Content-Type", "")[:40]} ・{len(html)} 字 ・'
              f'標題「{title_of(html)}」・連結 {len(lk)} 個、有關鍵字 {len(cand)} 個', flush=True)
        for u, t in cand[:25]:
            print(f'   · {t[:40]} → {u}', flush=True)
        for n_tb, rows, y0 in tables_with(html):
            print(f'   📋 首頁表格 {n_tb} 列 ・最早年份 {y0} ・前幾列 {rows}', flush=True)
        dom = urlparse(r.url).netloc
        files_all, tbl_all = 0, 0
        for u, t in [c for c in cand if urlparse(c[0]).netloc == dom][:FOLLOW]:
            r2 = fetch(s, u)
            if r2 is None:
                continue
            h2 = r2.text or ''
            fl = [x for x in file_links(links(h2, r2.url)) if hit(*x) or hit(x[0], x[1], TABLE_KEYS)]
            tb = tables_with(h2)
            files_all += len(fl)
            tbl_all += len(tb)
            print(f'   ↳ {t[:30]} HTTP {r2.status_code} ・{len(h2)} 字 ・標題「{title_of(h2)}」・相關檔案 {len(fl)} ・相關表格 {len(tb)}', flush=True)
            for fu, ft in fl[:12]:
                print(f'      📄 {ft[:40]} → {fu}', flush=True)
            for n_tb, rows, y0 in tb[:3]:
                print(f'      📋 表格 {n_tb} 列 ・最早年份 {y0} ・前幾列 {rows}', flush=True)
        summary.append((name, f'HTTP {r.status_code}、關鍵字連結 {len(cand)}、下一層相關檔案 {files_all}、表格 {tbl_all}'))
    print('\n📋 結論(看哪一家有「歷年調整」的表格或檔案;全部 0 = 這一輪沒找到,⛔ 不等於沒有):', flush=True)
    for name, msg in summary:
        print(f'   {name}:{msg}', flush=True)
    return 0


def selftest():
    bad = []

    def ok(n, c, e=''):
        print(('✅ ' if c else '❌ ') + n + ('' if c else '  ' + str(e)[:200]))
        if not c:
            bad.append(n)
    page = ('<a href="/news/123">臺灣50指數成分股定期審核結果</a><a href="https://x.com/a">天氣</a>'
            '<a href="files/2015Q2.pdf">2015 年第二季調整公告</a><a href="/news/123">重複</a>')
    lk = links(page, 'https://taiwanindex.com.tw/')
    ok('① 連結轉絕對網址、去重', lk[0][0] == 'https://taiwanindex.com.tw/news/123' and len(lk) == 3, lk)
    ok('② 關鍵字挑選(審核 / 調整 收、天氣不收)', [hit(u, t) for u, t in lk] == [True, False, True], lk)
    ok('③ 檔案連結', file_links(lk) == [('https://taiwanindex.com.tw/files/2015Q2.pdf', '2015 年第二季調整公告')], file_links(lk))
    tb = tables_with('<table><tr><th>日期</th><th>納入</th><th>刪除</th></tr><tr><td>2011/06</td><td>1301</td><td>2002</td></tr></table>'
                     '<table><tr><td>股價</td><td>100</td></tr></table>')
    ok('④ 只收有納入 / 刪除字樣的表格,印最早年份', len(tb) == 1 and tb[0][0] == 2 and tb[0][2] == 2011, tb)
    wk = ('<table class="wikitable"><tr><th>日期</th><th>納入指數</th><th>剔除指數</th></tr>'
          '<tr><td>2003年1月</td><td>2603 長榮<br/>2888 新光金<sup>[1]</sup></td><td>2331 精英</td></tr></table>'
          '<table><tr><td>股價</td><td>1</td></tr></table>')
    wr = wiki_rows(wk)
    ok('⑤ 維基調整表:整列、換行變「 | 」、註腳拿掉、別的表不收',
       wr == [['日期', '納入指數', '剔除指數'], ['2003年1月', '2603 長榮 | 2888 新光金', '2331 精英']], wr)
    nt = ('<li><span>2026/09/02</span><a href="/n/1">臺灣50指數定期審核結果</a></li>'
          '<li><span>2026/09/01</span><a href="/n/2">高股息指數定審</a></li><li>2026/08/30<a href="/n/3">系統維護</a></li>'
          '<a href="?page=3">3</a><a href="?page=2">2</a>')
    ni = notice_items(nt, 'https://taiwanindex.com.tw/downloads/technical_notice')
    ok('⑥ 通知清單:臺灣50 / 定審才收、日期取連結前面那個',
       [(d, u.rsplit('/', 1)[-1]) for d, _, u in ni] == [('2026-09-02', '1'), ('2026-09-01', '2')], ni)
    ok('⑥ 翻頁連結照頁碼排', [u[-1] for u in page_links(nt, 'https://taiwanindex.com.tw/downloads/technical_notice')] == ['2', '3'])
    big = '<table><tr><th>代號</th><th>名稱</th></tr>' + ''.join(f'<tr><td>{1000 + k}</td><td>甲{k}</td></tr>' for k in range(35)) + '</table>'
    mt = member_tables(big + wk)
    ok('⑦ 成分股表:≥30 檔的表整列收、調整表不收', len(mt) == 1 and len(mt[0]) == 36 and mt[0][1] == ['1000', '甲0'], [len(x) for x in mt])
    print(('\n❌ selftest 失敗 ' + str(bad)) if bad else '\n✅ selftest 全過')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else (main() if os.getenv('REBAL_MODE') == 'discover' else main_r2()))
