#!/usr/bin/env python3
"""🔎 2026-11-25 川普新 301 關稅追蹤:美國官方來源在 GitHub Actions 上拿不拿得到、什麼格式(macro_probe which=tariff_src)

為什麼要有這支:使用者 11/25「川普新 301 關稅請持續追蹤」→ 選「App 每天自動收官方公告 + 有新的推 Telegram」。
  沙箱連不到 federalregister.gov / ustr.gov(proxy 擋)→ 只能在 Actions 跑,log 說了算。
 ① 聯邦公報 API(免金鑰 JSON):美國貿易代表署最近的公告 / 總統文件(關稅)/ 232 —— 欄位、型別、日期
 ② 聯邦公報「明天要刊登」那份(public inspection):有沒有 USTR / 關稅
 ③ 2018-01 ~ 2026-11-06 的「總統關稅文件」+「美國貿易代表署 301 行動公告」全部標題(EXP-A 事件名單 ⛔ 先看價格)
 ④ 美國貿易代表署新聞稿頁 / RSS 候選:回不回得來、有沒有固定格式(有才接)

只讀:⛔ 寫任何分支 / 資料檔;⛔ 用金鑰;走 lib_http.Gate(UA 寫明 StockAI-DB、⛔ 偽裝瀏覽器、被擋就停)。
結論分三種(陷阱 #23):連不上 / 被擋(401、403、429、回 HTML)/ 有回但格式不同。

跑法:python3 scripts/tariff_src_probe.py [--selftest]
"""
import json
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FR = 'https://www.federalregister.gov/api/v1/documents.json'
FR_PI = 'https://www.federalregister.gov/api/v1/public-inspection-documents/current.json'
USTR_AGENCY = 'trade-representative-office-of-united-states'
FIELDS = ['title', 'type', 'abstract', 'document_number', 'html_url', 'publication_date', 'agencies',
          'effective_on', 'comments_close_on', 'dates', 'action', 'signing_date', 'subtype',
          'proclamation_number', 'executive_order_number']   # ⚠️ 2026-11-25 ⓪ 實測:presidential_document_type → HTTP 400(已拿掉)
USTR_PAGES = [
    'https://ustr.gov/about-us/policy-offices/press-office/press-releases',
    'https://ustr.gov/rss.xml',
    'https://ustr.gov/about-us/policy-offices/press-office/press-releases/rss.xml',
    'https://ustr.gov/issue-areas/enforcement/section-301-investigations',
]


def fr_params(per_page=20, page=1, order='newest', agencies=(), types=(), term=None, gte=None, lte=None, fields=FIELDS):
    """聯邦公報 API 查詢參數(list of tuples,requests 會照順序編)。純函式。"""
    p = [('per_page', str(per_page)), ('page', str(page)), ('order', order)]
    p += [('fields[]', f) for f in fields]
    p += [('conditions[agencies][]', a) for a in agencies]
    p += [('conditions[type][]', t) for t in types]
    if term:
        p.append(('conditions[term]', term))
    if gte:
        p.append(('conditions[publication_date][gte]', gte))
    if lte:
        p.append(('conditions[publication_date][lte]', lte))
    return p


def fr_line(r):
    """一筆聯邦公報 → 一行(日期|型別|文件號|生效|截止|標題)。純函式。"""
    if not isinstance(r, dict):
        return '(不是 dict)'
    t = re.sub(r'\s+', ' ', str(r.get('title') or '')).strip()
    extra = []
    for k in ('effective_on', 'comments_close_on', 'signing_date', 'subtype'):
        if r.get(k):
            extra.append(f'{k}={r[k]}')
    return f"{r.get('publication_date')}|{r.get('type')}|{r.get('document_number')}|{' '.join(extra)}|{t[:170]}"


def ustr_links(html):
    """新聞稿頁 → [(連結, 標題)](/press-releases/YYYY/月份/xxx 那種)。純函式。"""
    out = []
    for m in re.finditer(r'<a[^>]+href="([^"]*/press-releases/20\d\d/[^"]+)"[^>]*>(.*?)</a>', html or '', flags=re.S | re.I):
        txt = re.sub(r'<[^>]+>', ' ', m.group(2))
        txt = re.sub(r'\s+', ' ', txt).strip()
        if txt:
            out.append((m.group(1), txt))
    return out


def selftest():
    fails = []

    def ok(n, c, x=''):
        print(f"{'✅' if c else '❌'} {n}" + ('' if c else f'  → {x}'))
        if not c:
            fails.append(n)
    p = fr_params(per_page=5, agencies=[USTR_AGENCY], types=['NOTICE'], term='section 301', gte='2026-01-01')
    d = dict(p)
    ok('① 查詢參數:機關 / 型別 / 關鍵字 / 日期 / 欄位都有', d.get('conditions[agencies][]') == USTR_AGENCY and d.get('conditions[type][]') == 'NOTICE'
       and d.get('conditions[term]') == 'section 301' and d.get('conditions[publication_date][gte]') == '2026-01-01'
       and sum(1 for k, _ in p if k == 'fields[]') == len(FIELDS), p[:6])
    ln = fr_line({'publication_date': '2026-11-24', 'type': 'Notice', 'document_number': '2026-12345', 'effective_on': '2026-12-01',
                  'title': 'Notice of Action:\n  Section 301 Investigation'})
    ok('② 一行:日期 / 型別 / 文件號 / 生效日 / 標題(換行壓成空白)', ln == '2026-11-24|Notice|2026-12345|effective_on=2026-12-01|Notice of Action: Section 301 Investigation', ln)
    html = '<ul><li><a href="/about-us/policy-offices/press-office/press-releases/2026/november/ustr-announces-x">USTR <b>Announces</b> X</a></li>' \
           '<li><a href="/about-us/other">別的</a></li></ul>'
    ok('③ 新聞稿頁:只收 /press-releases/YYYY/ 那種連結、去標籤', ustr_links(html) == [('/about-us/policy-offices/press-office/press-releases/2026/november/ustr-announces-x', 'USTR Announces X')], ustr_links(html))
    print(f"\n{'❌ ' + str(len(fails)) + ' 條失敗' if fails else '✅ TARIFF_SRC_PROBE_SELFTEST_PASS'}")
    return not fails


def main():
    import lib_http
    g = lib_http.Gate(default_gap=1.5, timeout=40)

    def fr(label, params, show=10):
        res, why = g.get(FR, params=params, expect='json')
        if res is None:
            print(f'❌ {label}:{why}' + (f" ・擋頁開頭:{g.blocked_page.get('www.federalregister.gov', '')[:160]}" if '斷路' in why else ''))
            return None
        try:
            j = res.json()
        except ValueError:
            print(f'❌ {label}:回應不是 JSON(開頭 {lib_http.page_text(res, 160)})')
            return None
        rs = j.get('results') or []
        print(f"\n📜 {label}:count={j.get('count')} total_pages={j.get('total_pages')} 這頁 {len(rs)} 筆;第一筆欄位 = {sorted((rs[0] or {}).keys()) if rs else '—'}")
        for r in rs[:show]:
            print('   ' + fr_line(r))
        return j

    print('═══ ⓪ 聯邦公報 API 診斷(2026-11-25 第一輪全部 HTTP 400 → 一個一個加參數找是哪一個不收)═══')
    host = 'www.federalregister.gov'

    def try_(label, params):
        res, why = g.get(FR, params=params, expect='json')
        if res is None:
            print(f"   ❌ {label}:{why} ・回應開頭:{g.fail_page.get(host, '')[:300]}")
            return None
        try:
            j = res.json()
            print(f"   ✅ {label}:count={j.get('count')} 第一筆欄位 = {sorted(((j.get('results') or [{}])[0] or {}).keys())[:20]}")
            return j
        except ValueError:
            print(f'   ❌ {label}:不是 JSON')
            return None
    try_('只有 per_page', [('per_page', '2')])
    try_('+ order=newest', [('per_page', '2'), ('order', 'newest')])
    try_('+ 機關 USTR', [('per_page', '2'), ('conditions[agencies][]', USTR_AGENCY)])
    try_('+ 型別 PRESDOCU', [('per_page', '2'), ('conditions[type][]', 'PRESDOCU')])
    try_('+ 關鍵字 tariff', [('per_page', '2'), ('conditions[term]', 'tariff')])
    try_('+ 刊登日 ≥ 2026-01-01', [('per_page', '2'), ('conditions[publication_date][gte]', '2026-01-01')])
    for f in FIELDS + ['subtype', 'president', 'citation', 'excerpts']:
        try_(f'欄位 {f}', [('per_page', '1'), ('fields[]', f)])

    print('═══ ① 聯邦公報 API:最近的 ═══')
    fr('美國貿易代表署 2026 起(新到舊)', fr_params(per_page=25, agencies=[USTR_AGENCY], gte='2026-01-01'), show=25)
    fr('總統文件 + 關鍵字 tariff,2025 起', fr_params(per_page=25, types=['PRESDOCU'], term='tariff', gte='2025-01-01'), show=25)
    fr('關鍵字 "section 232",2025 起', fr_params(per_page=15, term='"section 232"', gte='2025-01-01'), show=15)
    j = fr('關鍵字 "excess capacity" + 301,2026 起', fr_params(per_page=15, term='"excess capacity"', gte='2026-01-01'), show=15)
    if j and (j.get('results') or []):
        r0 = j['results'][0]
        print('   第一筆 abstract:', re.sub(r'\s+', ' ', str(r0.get('abstract') or ''))[:600])
        print('   第一筆 dates:', re.sub(r'\s+', ' ', str(r0.get('dates') or ''))[:400])
        print('   第一筆 action:', r0.get('action'), '・agencies:', [a.get('name') for a in (r0.get('agencies') or []) if isinstance(a, dict)])

    print('\n═══ ② 明天要刊登的(public inspection)═══')
    res, why = g.get(FR_PI, expect='json')
    if res is None:
        print(f'❌ public inspection:{why}')
    else:
        try:
            pj = res.json()
            rs = pj.get('results') or []
            hit = [r for r in rs if re.search(r'tariff|301|232|trade representative|duties', json.dumps(r, ensure_ascii=False), re.I)]
            print(f'   共 {len(rs)} 筆,跟關稅 / USTR 有關 {len(hit)} 筆;第一筆欄位 = {sorted((rs[0] or {}).keys()) if rs else "—"}')
            for r in hit[:10]:
                print(f"   {r.get('filing_type')}|{r.get('publication_date')}|{r.get('document_number')}|{[a.get('name') for a in (r.get('agencies') or []) if isinstance(a, dict)]}|{str(r.get('title'))[:150]}")
        except ValueError:
            print(f'❌ public inspection 不是 JSON:{lib_http.page_text(res, 160)}')

    print('\n═══ ③ EXP-A 事件名單候選(2018-01-01 ~ 2026-11-06,⛔ 看價格)═══')
    for label, kw in (('總統文件 + tariff', dict(types=['PRESDOCU'], term='tariff')),
                      ('總統文件 + duties', dict(types=['PRESDOCU'], term='duties')),
                      ('美國貿易代表署 + 301', dict(agencies=[USTR_AGENCY], term='301'))):
        allr, page = [], 1
        while page <= 12:
            res, why = g.get(FR, params=fr_params(per_page=200, page=page, order='oldest', gte='2018-01-01', lte='2026-11-06', **kw), expect='json')
            if res is None:
                print(f'❌ {label} 第 {page} 頁:{why}')
                break
            try:
                j = res.json()
            except ValueError:
                print(f'❌ {label} 第 {page} 頁不是 JSON')
                break
            allr += j.get('results') or []
            if page >= int(j.get('total_pages') or 1):
                break
            page += 1
        by_y = Counter(str(r.get('publication_date'))[:4] for r in allr)
        print(f"\n🗂️ {label}:共 {len(allr)} 筆;每年 {dict(sorted(by_y.items()))}")
        for r in allr:
            t = str(r.get('title') or '')
            # USTR 那份很多是「排除清單延長」→ 只印「行動 / 修改 / 加徵 / 調查 / 聽證」那幾種,其他只算數
            if label.startswith('美國貿易代表署') and not re.search(r'action|modif|increase|imposition|initiation|hearing|determination|tariff', t, re.I):
                continue
            print('   ' + fr_line(r))

    print('\n═══ ④ 美國貿易代表署新聞稿頁 / RSS 候選 ═══')
    for u in USTR_PAGES:
        res, why = g.get(u, expect='html')
        if res is None:
            print(f"❌ {u}:{why}" + (f" ・擋頁開頭:{g.blocked_page.get('ustr.gov', '') or g.fail_page.get('ustr.gov', '')}"[:260]))
            continue
        body = res.content.decode('utf-8', errors='replace') if isinstance(res.content, (bytes, bytearray)) else str(res.content)
        ct = res.headers.get('Content-Type') if hasattr(res, 'headers') else '?'
        links = ustr_links(body)
        print(f'✅ {u}:HTTP 200 {ct} {len(body):,} 字;新聞稿連結 {len(links)} 個;開頭 {lib_http.page_text(res, 160)}')
        for h, t in links[:10]:
            print(f'   {h} | {t[:120]}')
        if 'xml' in str(ct) or body.lstrip().startswith('<?xml'):
            k0 = body.find('<item>')
            print('   第一個 item 原文:', re.sub(r'\s+', ' ', body[k0:k0 + 900]) if k0 >= 0 else '(沒有 <item>)')
            # 每個 <item> 自己切開再找(舊寫法結尾的 (?:<pubDate>…)? 是懶惰比對 → 永遠抓到空字串,看不出有沒有日期)
            blocks = re.findall(r'<item>(.*?)</item>', body, flags=re.S)
            tags = Counter(t for b in blocks for t in set(re.findall(r'<([A-Za-z][\w:]*)[\s>]', b)))
            print(f'   RSS item {len(blocks)} 個;item 裡的標籤(出現在幾個 item)= {dict(tags)}')
            for b in blocks[:8]:
                f = lambda t: (re.search(rf'<{t}>(.*?)</{t}>', b, flags=re.S) or [None, ''])[1].strip()[:120]
                print('    ', (f('title'), f('link'), f('pubDate') or f('dc:date') or '(沒有日期)'))
    print(f"\n📊 連線統計:{g.stats};斷路 = {g.open}")


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(0 if selftest() else 1)
    main()
