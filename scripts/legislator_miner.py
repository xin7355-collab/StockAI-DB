#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏛️ 政治人物持股(V79.2.0,使用者:「新增政治人物持股追蹤,特別是顏寬恒,我要的是他的報酬率」)

來源:https://legislator-wealth.tw/legislator/<slug>/(原始出處 = 監察院財產申報公報)。
⚠️ 沙箱連不到那個網站 → 欄位長相要先在 Actions 用 --probe 抓一次看(陷阱 #23:⛔ 不憑空猜格式)。

模式:
  --probe        只印不寫:狀態碼 / content-type / 標題 / 表格 / 內嵌 JSON / 引用的 .json 與 /api/ 網址,
                 結論分三種:連不上 / 被擋 / 抓到但格式不認得(三種下一步完全不同,V76.4.2)
  --out PATH     解析成 legislator_holdings.json;一個人 0 次申報或 0 筆持股 → ⛔ 不寫檔、exit 1
  --selftest     只測純函式,⛔ 不打網路

  slug 由環境變數 SLUGS(逗號分隔,預設 yan-kuan-heng)決定;SLUGS=all = 先讀 /api/legislators.json 拿全部立委。
"""
import html as _html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone

BASE = 'https://legislator-wealth.tw'
UA = {'User-Agent': 'Mozilla/5.0 (StockAI-DB legislator_miner)', 'Accept-Language': 'zh-TW,zh;q=0.9'}
SLUGS = [s.strip() for s in (os.getenv('SLUGS') or 'yan-kuan-heng').split(',') if s.strip()]


def http_get(url, timeout=40, tries=3):
    """回 (status, content_type, text);連不上回 (None, 錯誤類別, '')。指數退避重試(只對連線錯誤與 5xx/429)"""
    last = (None, 'unknown', '')
    for i in range(tries):
        req = urllib.request.Request(url, headers=UA)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.headers.get('content-type', ''), r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode('utf-8', 'replace')
            except Exception:
                body = ''
            last = (e.code, e.headers.get('content-type', '') if e.headers else '', body)
            if e.code not in (429, 500, 502, 503, 504):
                return last
        except Exception as e:
            last = (None, type(e).__name__ + ': ' + str(e)[:120], '')
        time.sleep(2 * (2 ** i))
    return last


# ───────────── 純函式(selftest 測這些) ─────────────
def roc_to_iso(s):
    """'114/11/01' / '114年11月1日' / '2025-11-01' / '2025/11/1' → '2025-11-01';認不得回 None"""
    if s is None:
        return None
    t = str(s).strip()
    m = re.search(r'(\d{2,4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})', t)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 1911:
        y += 1911
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return f'{y:04d}-{mo:02d}-{d:02d}'


def to_num(x):
    """'1,234' / '1,234.5' / 1234 / '—' → float 或 None"""
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    t = re.sub(r'[,\s股元]', '', str(x))
    try:
        return float(t)
    except ValueError:
        return None


def norm_sym(x):
    """從 '台積電(2330)' / '2330 台積電' / '2330' 抓 4 碼代號;ETF 00xxx 也收;認不得回 None"""
    if x is None:
        return None
    m = re.search(r'(?<!\d)(00\d{2,4}[A-Z]?|[1-9]\d{3})(?!\d)', str(x))
    return m.group(1) if m else None


def owner_of(x):
    t = str(x or '')
    if '配偶' in t:
        return '配偶'
    if '子女' in t or '未成年' in t:
        return '子女'
    return '本人'


def dedup_rows(rows):
    """同一次申報同一 owner 同一檔 → 股數加總(公報偶有同檔分多列)"""
    agg = {}
    for r in rows:
        k = (r['sym'], r.get('owner', '本人'))
        if k in agg:
            agg[k]['shares'] = (agg[k]['shares'] or 0) + (r['shares'] or 0)
        else:
            agg[k] = dict(r)
    return list(agg.values())


def strip_tags(h):
    h = re.sub(r'(?is)<(script|style|noscript)[^>]*>.*?</\1>', ' ', h)
    h = re.sub(r'(?s)<[^>]+>', ' ', h)
    return re.sub(r'\s+', ' ', _html.unescape(h)).strip()


def html_tables(h):
    """回 [[ [cell,…], … ], …](每張表的列)"""
    out = []
    for t in re.findall(r'(?is)<table[^>]*>(.*?)</table>', h):
        rows = []
        for tr in re.findall(r'(?is)<tr[^>]*>(.*?)</tr>', t):
            cells = [strip_tags(c) for c in re.findall(r'(?is)<t[hd][^>]*>(.*?)</t[hd]>', tr)]
            if cells:
                rows.append(cells)
        out.append(rows)
    return out


def embedded_json(h):
    """回 [(來源, 物件)]:__NEXT_DATA__ / application/json / ld+json / Nuxt / Astro props"""
    out = []
    for m in re.finditer(r'(?is)<script([^>]*)>(.*?)</script>', h):
        attrs, body = m.group(1), m.group(2).strip()
        if not body:
            continue
        if 'application/json' in attrs or 'ld+json' in attrs or '__NEXT_DATA__' in attrs:
            try:
                out.append((re.sub(r'\s+', ' ', attrs.strip())[:80], json.loads(body)))
            except Exception:
                pass
    for m in re.finditer(r'(?is)props="([^"]{50,})"', h):   # Astro island
        try:
            out.append(('astro-props', json.loads(_html.unescape(m.group(1)))))
        except Exception:
            pass
    return out


def json_shape(o, depth=0, maxd=4):
    """印物件結構(鍵 + 型別 + 長度),⛔ 不印整份"""
    pad = '  ' * depth
    if depth > maxd:
        return pad + '…'
    if isinstance(o, dict):
        lines = []
        for k, v in list(o.items())[:30]:
            if isinstance(v, (dict, list)):
                lines.append(f'{pad}{k}: {type(v).__name__}({len(v)})')
                lines.append(json_shape(v, depth + 1, maxd))
            else:
                lines.append(f'{pad}{k}: {str(v)[:60]!r}')
        return '\n'.join(lines)
    if isinstance(o, list):
        if not o:
            return pad + '[]'
        return pad + f'[0] of {len(o)}:\n' + json_shape(o[0], depth + 1, maxd)
    return pad + repr(o)[:60]


# ───────────── probe ─────────────
def next_flight(body):
    """Next.js App Router 把資料放在 self.__next_f.push([1,"…"]) 的 JS 字串裡 → 解回來串成一段文字"""
    out = []
    for m in re.finditer(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)', body):
        try:
            out.append(json.loads(m.group(1)))
        except Exception:
            pass
    return ''.join(out)


def probe(slug):
    url = f'{BASE}/legislator/{slug}/'
    st, ct, body = http_get(url)
    print(f'\n━━━━━━━━ 🔎 {url}')
    print(f'HTTP {st} ・ content-type={ct} ・ {len(body)} 字元')
    if st is None:
        print(f'🧭 結論:連不上({ct})→ runner 也到不了這個網站,要換來源')
        return
    if st in (401, 403, 451) or (st == 200 and re.search(r'(?i)cloudflare|captcha|access denied|just a moment', body[:3000])):
        print('🧭 結論:被擋(狀態碼或驗證頁)')
        print(body[:800])
        return
    t = re.search(r'(?is)<title>(.*?)</title>', body)
    print('標題:', strip_tags(t.group(1)) if t else '(沒有)')
    tabs = html_tables(body)
    print(f'表格:{len(tabs)} 張')
    for i, tb in enumerate(tabs[:12]):
        print(f'  ── 表 {i}:{len(tb)} 列')
        for r in tb[:40]:
            print('    |', ' | '.join(c[:40] for c in r))
    js = embedded_json(body)
    print(f'內嵌 JSON:{len(js)} 段')
    for src, o in js[:6]:
        print(f'  ── {src}')
        print(json_shape(o))
    refs = sorted(set(re.findall(r'["\'(]((?:https?://[^"\'()\s]+)?/[^"\'()\s]*(?:\.json|/api/)[^"\'()\s]*)', body)))
    print(f'引用的 .json / /api/:{len(refs)}')
    for r in refs[:40]:
        print('  ', r)
    scripts = re.findall(r'(?is)<script[^>]+src="([^"]+)"', body)
    print(f'外部 script:{len(scripts)}', scripts[:15])
    txt = strip_tags(body)
    print(f'純文字({len(txt)} 字,前 6000):')
    for k in range(0, min(len(txt), 6000), 200):
        print('  ', txt[k:k + 200])
    ok = bool(tabs) or bool(js)
    print('\n━━ 🔌 API 試讀')
    for u in (f'{BASE}/api/legislators/{slug}.json', f'{BASE}/api/documents.json', f'{BASE}/api/stocks/prices.json'):
        o, e = get_json(u)
        print(f'  ↪ {u}', e or '')
        if isinstance(o, list):
            print(f'    list({len(o)}),第一筆:')
            print(json_shape(o[0] if o else None))
        elif isinstance(o, dict):
            ks = list(o.keys())
            print(f'    dict({len(ks)}) 前幾個鍵 {ks[:8]}')
            if 'prices' in u:
                for k in ks[:3]:
                    print('     ', k, o[k])
            else:
                print(json_shape(o))
                for k in ('latestDeclaration', 'changes'):
                    if k in o:
                        print(f'    ── {k} 原始(前 1500 字):', json.dumps(o[k], ensure_ascii=False)[:1500])
        time.sleep(1)
    main(None)
    hrefs = sorted(set(re.findall(r'href="([^"#]+)"', body)))
    print(f'連結:{len(hrefs)}')
    for h in hrefs:
        if 'github' in h or slug in h or h.endswith('.pdf') or '/api' in h or 'trade' in h or 'change' in h:
            print('   ', h)
    fl = next_flight(body)
    print(f'__next_f 資料:{len(fl)} 字元')
    keys = {}
    for k in re.findall(r'"([A-Za-z_][A-Za-z0-9_]{1,30})":', fl):
        keys[k] = keys.get(k, 0) + 1
    print('  鍵(次數):', sorted(keys.items(), key=lambda x: -x[1])[:60])
    for needle in ('3374', '精材', '交易', 'trade', 'Trade', 'date'):
        i = fl.find(needle)
        print(f'  ── 「{needle}」第一次出現 @{i}')
        if i >= 0:
            print('    ', fl[max(0, i - 600):i + 1400].replace('\n', ' '))
    for k in range(0, min(len(fl), 12000), 400):
        print('  F', fl[k:k + 400].replace('\n', ' '))
    print('🧭 結論:' + ('抓到了,但格式還沒對 → 照上面的結構寫 parser' if ok else '抓到網頁但沒有表格也沒有內嵌 JSON → 可能要 JS 渲染(看引用的 .json / /api/)'))
    for r in refs[:8]:
        u = r if r.startswith('http') else BASE + r
        s2, c2, b2 = http_get(u)
        print(f'\n  ↪ {u}\n    HTTP {s2} ・ {c2} ・ {len(b2)} 字元')
        try:
            print(json_shape(json.loads(b2)))
        except Exception:
            print('    (不是 JSON)', b2[:300].replace('\n', ' '))
        time.sleep(1.5)


# ───────────── parse:讀網站自己的公開 JSON API(probe 第二輪查到;網站開源 MIT,README 列了 /api/) ─────────────
#   /api/legislators/{slug}.json → 持股(帶 stockCode)、最新一次申報、全部變動申報(含每一筆成交價/日期)
#   /api/documents.json          → 全部申報文件(拿來找「更早的」那幾次申報)
#   /api/stocks/prices.json      → 股名 → {code, price}(變動申報只有股名,靠它對代號)
def side_of(reason):
    t = str(reason or '')
    if '買' in t or '申購' in t or '增資' in t:
        return 'buy'
    if '賣' in t or '出售' in t:
        return 'sell'
    return None


def owner_rel(owner, person, spouse):
    o = str(owner or '').strip()
    if spouse and o == spouse:
        return '配偶'
    if not o or o == person:
        return '本人'
    return owner_of(o) if ('配偶' in o or '子女' in o) else o


def code_map(leg, prices):
    """股名 → 代號:① 這個人持股自帶的 stockCode ② 網站的股價表 ③ 名字裡本來就有代號"""
    m = {}
    if isinstance(prices, dict):
        for nm, v in prices.items():
            c = norm_sym((v or {}).get('code')) if isinstance(v, dict) else None
            if c:
                m[str(nm).strip()] = c
    for h in (leg or {}).get('holdings') or []:
        c = norm_sym(h.get('stockCode'))
        if c:
            m[str(h.get('name', '')).strip()] = c
    return m


def _nk(x):
    """股名比對用:全形轉半形 + 去空白(公報常寫成「北極星藥業－ K Y」)"""
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(x or '')))


def lookup(m, name):
    n = str(name or '').strip()
    if n in m:
        return m[n]
    n2 = _nk(n)
    for k, v in m.items():
        if _nk(k) == n2:
            return v
    return norm_sym(n)


def build_person(slug, leg, documents, prices):
    """回 {name, party, decls, trades, skipped};認不得回 None"""
    if not isinstance(leg, dict) or not leg.get('name'):
        return None
    name = leg['name']
    meta = leg.get('meta') or {}
    cm = code_map(leg, prices)
    docs = [d for d in (documents or []) if isinstance(d, dict) and d.get('name') == name]
    if leg.get('latestDeclaration'):
        docs.append(leg['latestDeclaration'])
    for c in leg.get('changes') or []:
        docs.append(c)
    decls, trades, skipped, seen_d, seen_t = [], [], [], set(), set()
    for d in docs:
        sp = (d.get('spouse') or {}).get('name')
        if d.get('type') == 'declaration':
            dt = roc_to_iso(d.get('declarationDate'))
            if not dt:
                continue
            items = (((d.get('securities') or {}).get('stocks') or {}).get('items')) or []
            key = (dt, d.get('declarationForm'), len(items))
            if not items or key in seen_d:   # 空的那份(多半是信託申報表)⛔ 不當成「那天什麼都沒有」
                continue
            seen_d.add(key)
            rows = []
            for it in items:
                sh = to_num(it.get('shares'))
                code = lookup(cm, it.get('name'))
                if not code:
                    skipped.append({'d': dt, 'name': it.get('name'), 'why': '找不到上市櫃代號(未上市/興櫃/已下市)', 'val': it.get('ntdTotal')})
                    continue
                if not sh:
                    skipped.append({'d': dt, 'name': it.get('name'), 'why': '股數讀不到'})
                    continue
                rows.append({'sym': code, 'name': it.get('name'), 'shares': sh,
                             'owner': owner_rel(it.get('owner'), name, sp), 'val': to_num(it.get('ntdTotal'))})
            decls.append({'date': dt, 'form': d.get('declarationForm') or '', 'kind': d.get('declarationType') or '',
                          'rows': dedup_rows(rows)})
        elif d.get('type') == 'change':
            per = d.get('changePeriod') or {}
            # ⚠️ 去重以「整份文件」為單位(同一份會從 documents.json 與 changes 各來一次);
            #    ⛔ 不可逐列去重 —— 同一天同價同股數的兩筆,是真的分兩批成交
            k = (roc_to_iso(d.get('declarationDate')), per.get('from'), per.get('to'), len(d.get('stocks') or []))
            if k in seen_t:
                continue
            seen_t.add(k)
            for it in d.get('stocks') or []:
                td = roc_to_iso(it.get('changeDate'))
                trades.append({'d': td, 'sym': lookup(cm, it.get('name')), 'name': it.get('name'),
                               'owner': owner_rel(it.get('owner'), name, sp), 'shares': to_num(it.get('shares')),
                               'px': to_num(it.get('changePrice')), 'why': it.get('changeReason') or '',
                               'side': side_of(it.get('changeReason')), 'broker': it.get('broker') or '',
                               'from': roc_to_iso(per.get('from')), 'to': roc_to_iso(per.get('to'))})
    decls.sort(key=lambda x: x['date'])
    trades.sort(key=lambda x: (x['d'] or ''))
    return {'name': name, 'party': meta.get('party') or leg.get('party') or '', 'decls': decls,
            'trades': trades, 'skipped': skipped}


def slugs_from_list(o):
    """/api/legislators.json → [(slug, name)];形狀容錯(list 或 {results|legislators|items|data: [...]});認不得回 None"""
    if isinstance(o, dict):
        for k in ('results', 'legislators', 'items', 'data'):
            if isinstance(o.get(k), list):
                o = o[k]
                break
    if not isinstance(o, list):
        return None
    out, seen = [], set()
    for x in o:
        if isinstance(x, dict) and x.get('slug') and x['slug'] not in seen:
            seen.add(x['slug'])
            out.append((str(x['slug']), x.get('name') or ''))
    return out or None


def judge(all_mode, n_total, errs, nostock, n_people):
    """回 [] = 可以寫檔;否則回原因清單。
    單一人模式:任何一位抓不到 / 沒持股都算失敗(原本的守門)。
    全部模式:沒有上市櫃持股是正常的(⛔ 不算失敗);抓不到 > 10% 或有持股的人 < 5 → 不寫。"""
    if not all_mode:
        return list(errs) + [f'{s}: 0 次申報或 0 筆持股' for s, _, _ in nostock]
    out = []
    if n_total and len(errs) > 0.1 * n_total:
        out.append(f'{len(errs)}/{n_total} 位抓不到(> 10%):' + ' / '.join(errs[:5]))
    if n_people < 5:
        out.append(f'有上市櫃持股的只有 {n_people} 位(< 5)')
    return out


def get_json(url):
    st, ct, body = http_get(url)
    if st != 200:
        return None, f'HTTP {st} {ct}'
    try:
        return json.loads(body), None
    except Exception:
        return None, f'不是 JSON(content-type={ct},開頭 {body[:80]!r})'


def main(out_path):
    people, skipped, errs, nostock = {}, {}, [], []
    docs, e1 = get_json(f'{BASE}/api/documents.json')
    prices, e2 = get_json(f'{BASE}/api/stocks/prices.json')
    if e1:
        print('⚠️ documents.json 讀不到 → 只有最新一次申報:', e1)
    if e2:
        print('⚠️ prices.json 讀不到 → 代號只靠持股自帶的 stockCode:', e2)
    if isinstance(docs, dict):
        docs = docs.get('documents') or docs.get('items') or []
    all_mode = SLUGS == ['all']
    slugs = SLUGS
    if all_mode:
        L, e = get_json(f'{BASE}/api/legislators.json')
        lst = slugs_from_list(L) if not e else None
        if not lst:
            print('🚧 ⛔ 不寫檔:/api/legislators.json', e or '形狀認不得 →')
            if L is not None:
                print(json_shape(L)[:3000])
            return 1
        slugs = [s for s, _ in lst]
        print(f'📋 立委清單 {len(slugs)} 位')
    for slug in slugs:
        leg, e = get_json(f'{BASE}/api/legislators/{slug}.json')
        time.sleep(1.5)
        if e:
            errs.append(f'{slug}: {e}')
            continue
        p = build_person(slug, leg, docs if isinstance(docs, list) else [], prices)
        if not p:
            errs.append(f'{slug}: 格式認不得')
            continue
        nrow = sum(len(d['rows']) for d in p['decls'])
        print(f'👤 {slug} {p["name"]}:申報 {len(p["decls"])} 次 {[d["date"] for d in p["decls"]]}・持股 {nrow} 列・交易 {len(p["trades"])} 筆・略過 {len(p["skipped"])}')
        if not all_mode:
            for sk in p['skipped']:
                print('   ⏭️', sk)
        if not p['decls'] or not nrow:
            nostock.append((slug, p['name'], '申報裡沒有對得上的上市櫃股票' if p['skipped'] else '申報裡沒有股票'))
            continue
        skipped[slug] = p.pop('skipped')
        people[slug] = p
    fails = judge(all_mode, len(slugs), errs, nostock, len(people))
    if errs and not fails:
        print('⚠️ 抓不到(比例在容許內,照寫):', ' / '.join(errs))
    if fails:
        print('🚧 ⛔ 不寫檔:', ' / '.join(fails))
        return 1
    out = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'src': BASE,
           'note': '財產申報一年一次,只看得到申報日的持股;原始出處監察院財產申報公報',
           'people': people, 'skipped': skipped,
           'nostock': [{'slug': s, 'name': n, 'why': w} for s, n, w in nostock],
           'errs': errs}
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        print(f'✅ 寫入 {out_path}:{len(people)} 人(沒有上市櫃持股 {len(nostock)} 位・抓不到 {len(errs)} 位)')
    else:
        print(json.dumps(out, ensure_ascii=False)[:6000])
    return 0


def selftest():
    n = ok = 0

    def t(c, msg):
        nonlocal n, ok
        n += 1
        ok += bool(c)
        print(('✅' if c else '❌'), msg)
    t(roc_to_iso('114/11/01') == '2025-11-01', '民國 → 西元')
    t(roc_to_iso('113年1月31日') == '2024-01-31', '民國年月日')
    t(roc_to_iso('2025-11-1') == '2025-11-01', '西元補零')
    t(roc_to_iso('沒有日期') is None, '認不得回 None')
    t(to_num('1,234,567股') == 1234567.0, '千分位 + 股')
    t(to_num('—') is None, '破折號回 None')
    t(norm_sym('台積電(2330)') == '2330', '括號代號')
    t(norm_sym('元大台灣50 0050') == '0050', 'ETF 代號')
    t(norm_sym('00878 國泰永續高股息') == '00878', '5 碼 ETF')
    t(norm_sym('某未上市公司') is None, '沒有代號回 None')
    t(norm_sym('20231231') is None, '日期數字不可當代號')
    t(owner_of('配偶 王某') == '配偶' and owner_of('本人') == '本人', '持有人')
    r = dedup_rows([{'sym': '2330', 'owner': '本人', 'shares': 1000}, {'sym': '2330', 'owner': '本人', 'shares': 500},
                    {'sym': '2330', 'owner': '配偶', 'shares': 10}])
    t(len(r) == 2 and [x['shares'] for x in r if x['owner'] == '本人'][0] == 1500, '同檔同人加總、不同人分開')
    tb = html_tables('<table><tr><th>股票</th><th>股數</th></tr><tr><td>台積電(2330)</td><td>1,000</td></tr></table>')
    t(tb == [[['股票', '股數'], ['台積電(2330)', '1,000']]], '表格解析')
    t(strip_tags('<p>a<script>x</script>b</p>') == 'a b', '去標籤去 script')
    leg = {'name': '甲', 'meta': {'party': '某黨'},
           'holdings': [{'name': '精材', 'stockCode': '3374'}],
           'latestDeclaration': {'type': 'declaration', 'declarationDate': '2025/11/01', 'spouse': {'name': '乙'},
                                 'securities': {'stocks': {'items': [
                                     {'name': '精材', 'owner': '甲', 'shares': 1000, 'ntdTotal': 10000},
                                     {'name': '精材', 'owner': '甲', 'shares': 500, 'ntdTotal': 5000},
                                     {'name': '鴻海', 'owner': '乙', 'shares': 10, 'ntdTotal': 100},
                                     {'name': '某未上市', 'owner': '甲', 'shares': 7, 'ntdTotal': 70}]}}},
           'changes': [{'type': 'change', 'changePeriod': {'from': '2024/11/01', 'to': '2025/11/01'},
                        'stocks': [{'name': '鴻海', 'owner': '甲', 'shares': 1000, 'changePrice': 150.5,
                                    'changeDate': '2025/03/04', 'changeReason': '買入', 'broker': 'X'}]}]}
    docs = [{'type': 'declaration', 'name': '甲', 'declarationDate': '2024/11/01',
             'securities': {'stocks': {'items': [{'name': '精材', 'owner': '甲', 'shares': 800}]}}},
            {'type': 'declaration', 'name': '別人', 'declarationDate': '2024/11/01',
             'securities': {'stocks': {'items': [{'name': '精材', 'owner': '別人', 'shares': 1}]}}}]
    P = build_person('x', leg, docs, {'鴻海': {'code': '2317', 'price': 200}})
    t(P and [d['date'] for d in P['decls']] == ['2024-11-01', '2025-11-01'], 'API:兩次申報由舊到新、別人的不收')
    last = P['decls'][-1]['rows'] if P else []
    t(any(r['sym'] == '3374' and r['shares'] == 1500 for r in last), 'API:同檔同人加總 + stockCode 對代號')
    t(any(r['sym'] == '2317' and r['owner'] == '配偶' for r in last), 'API:股價表對代號 + 配偶')
    t(P and len(P['skipped']) == 1 and P['skipped'][0]['name'] == '某未上市', 'API:對不到代號的寫進 skipped(⛔ 不靜默丟)')
    t(P and P['trades'] and P['trades'][0]['sym'] == '2317' and P['trades'][0]['side'] == 'buy' and P['trades'][0]['px'] == 150.5,
      'API:變動申報 → 交易(代號 / 方向 / 價格)')
    t(build_person('x', {}, [], {}) is None, 'API:空的回 None')
    leg2 = dict(leg, changes=[{'type': 'change', 'declarationDate': '2025/11/01', 'stocks': [
        {'name': '鴻海', 'shares': 1000, 'changePrice': 100, 'changeDate': '2025/01/02', 'changeReason': '賣'},
        {'name': '鴻海', 'shares': 1000, 'changePrice': 100, 'changeDate': '2025/01/02', 'changeReason': '賣'}]}])
    docs2 = docs + [leg2['changes'][0]]
    P2 = build_person('x', leg2, docs2, {'鴻海': {'code': '2317'}})
    t(P2 and len(P2['trades']) == 2, 'API:同一份文件兩筆一樣的成交都留(⛔ 逐列去重)、同一份文件來兩次只算一次')
    t(lookup({'北極星藥業 - KY': '6550'}, '北極星藥業－ K Y') == '6550', '股名全形/空白也對得上')
    t(all(d['rows'] for d in P['decls']), 'API:空的申報表不收')
    t(slugs_from_list([{'slug': 'a', 'name': '甲'}, {'slug': 'a'}, {'x': 1}]) == [('a', '甲')], '清單:list 形狀、重複去掉')
    t(slugs_from_list({'results': [{'slug': 'b'}]}) == [('b', '')] and slugs_from_list({'legislators': [{'slug': 'c'}]}) == [('c', '')],
      '清單:{results|legislators: [...]} 形狀')
    t(slugs_from_list({'foo': 1}) is None and slugs_from_list([]) is None, '清單:認不得回 None')
    t(judge(True, 100, [], [('s', 'n', 'w')] * 30, 70) == [], '全部模式:沒有持股的人 ⛔ 不算失敗')
    t(judge(True, 100, ['x'] * 11, [], 80) and not judge(True, 100, ['x'] * 10, [], 80), '全部模式:抓不到 > 10% 才擋')
    t(judge(True, 100, [], [], 4) != [], '全部模式:有持股的 < 5 位擋')
    t(judge(False, 1, [], [('s', 'n', 'w')], 0) != [], '單一人模式:沒持股照舊算失敗')
    print(f'✅ selftest {ok}/{n}' if ok == n else f'❌ selftest {ok}/{n}')
    return 0 if ok == n else 1


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    if '--probe' in sys.argv:
        for s in (SLUGS if SLUGS != ['all'] else ['yan-kuan-heng']):
            probe(s)
        sys.exit(0)
    if '--out' in sys.argv:
        sys.exit(main(sys.argv[sys.argv.index('--out') + 1]))
    print(__doc__)
    sys.exit(2)
