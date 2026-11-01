#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📦 出口(按主要貨品)/ 景氣指標(含外銷訂單動向指數)—— 政府資料開放平臺原檔下載 → trade_deep 分支(研究用)

為什麼有這支(評估紀錄 51,2026-11-01 使用者貼外部 AI「全球景氣 → 產業需求 → 公司獲利 → 股價」領先指標,回「做」):
  本站有 2009 起的月營收(stock_deep/rev),但**沒有**出口與外銷訂單的歷史 →
  「出口 / 訂單能不能比月營收更早找到強勢產業」這題量不到。
  雲端工作階段連不到 data.gov.tw → 在 GitHub Actions 抓,原檔(gzip)+ 摘要推到獨立 orphan 分支 trade_deep
  (⛔ 不進 data / gh-pages,陷阱 #41)。回測在本機讀這個分支(`trade_lead_probe.mjs`)。

做法(⛔ 不憑印象寫欄位名 / 網址):
  ① 已知資料集 id(搜尋結果查到的)先抓詮釋資料 `api/v2/rest/dataset/{id}`,整份 JSON 走一遍找下載網址
  ② 財政部統計資料庫的查詢網址(8380 的下載網址)另外全勾 37 類抓一份(EXTRA)
     ⛔ 外銷訂單「按貨品」那 10 份在經濟部 service.moea.gov.tw,第一輪(run 41357292838)全部 403
       → 照它的意思不抓、⛔ 不偽裝瀏覽器繞過;改用國發會 6099 ZIP 裡的「外銷訂單動向指數」(全體、不分貨品)
  ③ 每份下載檔:原檔 gzip 存起來(⛔ 不在這裡解析成定案格式 —— 先看到真的長相再寫回測的讀法),
     摘要記編碼、前幾行、列數、看得出來的資料期起訖
  ④ 一份都沒抓到 → exit 1(workflow 不推、紅燈);抓到部分 → 摘要寫清楚哪幾份失敗

限流:每個請求間隔 ≥1 秒;429 / 5xx / 連線錯誤照 2 / 4 / 8 / 16 秒退避(最多 5 次);整輪時間上限 MAX_MIN 分。
⛔ 不用任何金鑰。

跑法:OUT_DIR=trade_deep python3 scripts/trade_deep_fetch.py
      python3 scripts/trade_deep_fetch.py --selftest
"""
import csv
import gzip
import io
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

API = 'https://data.gov.tw/api/v2/rest/dataset/'
UA = {'User-Agent': 'Mozilla/5.0 (compatible; stockai-research/1.0)', 'Accept': 'application/json, text/csv, */*'}

# 搜尋結果查到的 id(2026-11-01;⛔ 標題以詮釋資料為準,這裡的名字只是方便讀 log)
KNOWN = {
    '8378': '進出口貿易值',
    '8380': '出口值_按主要貨品分',
    '8382': '進出口貿易值_按國際貿易標準(SITC)分',
    '6099': '景氣指標及燈號(國發會;順便看本站 macro_miner「欄位太長」那個錯)',
}
# 財政部統計資料庫的查詢網址(8380 的下載網址本身就是這個)只勾了 37 類裡的 24 類(沒有光學器材 / 電機 / 運輸工具 / 化學品)
# → 同一個查詢全部勾起來另抓一份(⛔ 不猜別的參數,只把 codlst0 改成全 1)
EXTRA = {
    '8380all': ('出口值_按主要貨品分(37 類全勾)',
                'https://web02.mof.gov.tw/njswww/webMain.aspx?sys=220&ym=9000&kind=21&type=4&funid=i8121&cycle=41'
                '&outmode=12&compmode=00&outkind=1&fld0=1&codlst0=' + '1' * 37 + '&utf=1'),
}


def _now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')


class Fetcher:
    """全部請求走這裡:間隔 ≥ gap 秒、429/5xx/連線錯誤指數退避。get / sleep 可換成假的(selftest)。"""

    def __init__(self, get=None, sleep=time.sleep, gap=1.0, tries=5, deadline=None):
        if get is None:
            import requests
            sess = requests.Session()
            get = lambda u: sess.get(u, headers=UA, timeout=40)   # noqa: E731
        self.get, self.sleep, self.gap, self.tries = get, sleep, gap, tries
        self.deadline = deadline
        self.n = 0

    def fetch(self, url):
        """回 (status, content bytes, content-type, 錯誤字串)。⛔ 不拋例外 —— 失敗要記下來,不是讓整輪停掉。"""
        err = ''
        for k in range(self.tries):
            if self.deadline and time.time() > self.deadline:
                return (0, b'', '', '時間到,沒抓')
            if self.n:
                self.sleep(self.gap)
            self.n += 1
            try:
                r = self.get(url)
                st = int(getattr(r, 'status_code', 0) or 0)
                body = getattr(r, 'content', b'') or b''
                ct = (getattr(r, 'headers', {}) or {}).get('Content-Type', '') or ''
                if st == 429 or st >= 500:
                    err = f'HTTP {st}'
                elif st == 200:
                    return (st, body, ct, '')
                else:   # 403 / 404:把回應開頭(去掉標籤)記下來,錯誤訊息才看得出原因
                    txt = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', body[:3000].decode('utf-8', 'replace'))).strip()
                    return (st, body, ct, f'HTTP {st}' + (f'({txt[:160]})' if txt else ''))
            except Exception as e:   # 連線錯誤 / 逾時 → 退避重試
                err = f'{type(e).__name__}: {str(e)[:120]}'
            if k < self.tries - 1:
                self.sleep(2 ** (k + 1))   # 2 / 4 / 8 / 16 秒
        return (0, b'', '', err or '重試用完')


def walk_meta(o, found=None, fmt_hint=''):
    """整份詮釋資料 JSON 走一遍 → [(格式, 網址)]。⛔ 不假設欄位名(本站 V80 景氣燈號就是被欄位名改過坑過)。"""
    if found is None:
        found = []
    if isinstance(o, dict):
        fm = next((str(v) for k, v in o.items() if 'format' in str(k).lower() and isinstance(v, str)), fmt_hint)
        for k, v in o.items():
            if isinstance(v, str) and v.startswith('http') and ('url' in str(k).lower() or 'download' in str(k).lower()):
                found.append((fm, v))
        for v in o.values():
            walk_meta(v, found, fm)
    elif isinstance(o, list):
        for v in o:
            walk_meta(v, found, fmt_hint)
    return found


def downloads(meta):
    """下載網址去重,CSV 優先、JSON 次之;資料集介紹頁(data.gov.tw/dataset/…)不是檔案 → 不收。"""
    seen, out = set(), []
    order = lambda x: (0 if 'csv' in x[0].lower() else 1 if 'json' in x[0].lower() else 2)   # noqa: E731
    for fm, u in sorted(walk_meta(meta), key=order):
        if u in seen or 'data.gov.tw/dataset' in u:
            continue
        seen.add(u)
        out.append((fm, u))
    return out


def title_of(meta):
    """標題:鍵名含 title / 名稱 的第一個字串(⛔ 不寫死鍵名)。"""
    stack = [meta]
    while stack:
        o = stack.pop(0)
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(v, str) and ('title' in str(k).lower() or '名稱' in str(k)) and v.strip():
                    return v.strip()
            stack.extend(v for v in o.values() if isinstance(v, (dict, list)))
        elif isinstance(o, list):
            stack.extend(o)
    return ''


def decode(b):
    """政府 CSV 常見 UTF-8(含 BOM)或 Big5 / cp950 → (文字, 編碼)。⛔ 解不開不硬猜,回 (None, 原因)。"""
    for enc in ('utf-8-sig', 'cp950', 'big5'):
        try:
            return b.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return None, '不是 UTF-8 / Big5'


_ROC = re.compile(r'^\s*(\d{2,3})\s*年\s*(\d{1,2})\s*月')
_ROCN = re.compile(r'^\s*(\d{3})(\d{2})\s*$')
_AD = re.compile(r'^\s*((?:19|20)\d{2})\s*[-/年.]?\s*(\d{1,2})(?!\d)')


def ym_of(s):
    """一格文字 → 'YYYY-MM'(民國 115年9月 / 11509 / 2026-09 / 2026/9 / 2026年9月);看不出來回 None。"""
    s = str(s or '')
    m = _ROC.match(s) or _ROCN.match(s)
    if m:
        y, mo = int(m.group(1)) + 1911, int(m.group(2))
    else:
        m = _AD.match(s)
        if not m:
            return None
        y, mo = int(m.group(1)), int(m.group(2))
    return f'{y:04d}-{mo:02d}' if 1 <= mo <= 12 and 1950 <= y <= 2100 else None


def summarize(b, fmt=''):
    """一份下載檔的摘要:編碼、前幾行、列數、哪一欄像資料期、起訖。⛔ 只描述,不轉檔。"""
    out = {'bytes': len(b)}
    if b[:4] == b'PK\x03\x04':   # ⭐ 國發會 6099 給的是 ZIP(本站 macro_miner 當成 CSV 讀 → 「欄位太長」)
        import zipfile
        try:
            z = zipfile.ZipFile(io.BytesIO(b))
        except zipfile.BadZipFile as e:
            out['err'] = f'zip: {e}'
            return out
        names = []
        for zi in z.infolist():
            nm = zi.filename
            if not zi.flag_bits & 0x800:   # 沒標 UTF-8 的檔名是 cp437 編碼的原始位元組
                try:
                    nm = nm.encode('cp437').decode('utf-8')
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass
            names.append([nm, zi.file_size])
        out['kind'] = 'zip'
        out['files'] = names
        csvs = [zi for zi in z.infolist() if zi.filename.lower().endswith('.csv') and 'schema' not in zi.filename.lower()]
        if csvs:
            out['inner'] = summarize(z.read(max(csvs, key=lambda zi: zi.file_size)))
        return out
    txt, enc = decode(b)
    if txt is None:
        out['err'] = enc
        return out
    out['enc'] = enc
    head = txt.lstrip()[:1]
    if head in '{[':
        out['kind'] = 'json'
        out['head'] = txt[:600]
        return out
    if head == '<':
        out['kind'] = 'html/xml'
        out['head'] = txt[:600]
        return out
    out['kind'] = 'csv'
    csv.field_size_limit(1 << 30)   # ⭐ 本站 macro_miner 讀 6099 就死在預設 131072 的上限 —— 先看到長相再說
    try:
        rows = list(csv.reader(io.StringIO(txt)))
    except csv.Error as e:
        out['err'] = f'csv: {e}'
        out['head'] = txt[:600]
        return out
    out['n_rows'] = max(0, len(rows) - 1)
    out['header'] = rows[0][:40] if rows else []
    out['first'] = rows[1:4]
    out['last'] = rows[-2:] if len(rows) > 3 else []
    out['max_cell'] = max((len(c) for r in rows for c in r), default=0)
    best = None   # 哪一欄最像資料期:看得出年月的格子最多
    for j in range(min(len(out['header']), 40)):
        yms = [ym_of(r[j]) for r in rows[1:] if j < len(r)]
        ok = [x for x in yms if x]
        if ok and (best is None or len(ok) > best[1]):
            best = (j, len(ok), min(ok), max(ok))
    if best:
        out['period_col'] = out['header'][best[0]] if best[0] < len(out['header']) else best[0]
        out['period'] = [best[2], best[3]]
        out['period_n'] = best[1]
    return out


def save_gz(path, b):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, 'wb') as f:
        f.write(b)


def run(out_dir, F, known=KNOWN, log=print, extra=None):
    """一整輪:詮釋資料 → 下載 → 摘要 → _status.json。回 (status dict, 抓到幾份檔)。"""
    st = {'at': _now(), 'src': 'data.gov.tw api/v2/rest/dataset + 財政部統計資料庫', 'sets': {}}
    ids = list(known)

    def meta_of(i):
        code, body, ct, err = F.fetch(API + str(i))
        if code != 200:
            return None, err or f'HTTP {code}'
        try:
            return json.loads(body.decode('utf-8-sig')), ''
        except Exception as e:
            return None, f'詮釋資料不是 JSON({type(e).__name__};開頭 {body[:80]!r})'

    metas = {}
    for i in ids:
        m, err = meta_of(i)
        if m is None:
            st['sets'][i] = {'name': known.get(i, ''), 'err': err}
            log(f'❌ {i} {known.get(i, "")}:{err}')
            continue
        metas[i] = m
    n_files = 0
    for i, (nm, u) in (extra or {}).items():   # 不經詮釋資料、直接給網址的那幾份
        metas[i] = {'result': {'title': nm, 'distribution': [{'resourceFormat': 'CSV', 'resourceDownloadUrl': u}]}}
    for i, m in metas.items():
        t = title_of(m)
        os.makedirs(os.path.join(out_dir, 'meta'), exist_ok=True)
        with open(os.path.join(out_dir, 'meta', f'{i}.json'), 'w', encoding='utf-8') as f:
            json.dump(m, f, ensure_ascii=False, indent=1)
        rec = {'name': t or known.get(i, ''), 'files': []}
        dl = downloads(m)
        if not dl:
            rec['err'] = '詮釋資料裡沒有下載網址'
        for k, (fm, u) in enumerate(dl[:4]):   # 同一份資料集最多 4 個格式就夠
            code, body, ct, err = F.fetch(u)
            fr = {'fmt': fm, 'url': u, 'ct': ct[:60]}
            if code != 200 or not body:
                fr['err'] = err or f'HTTP {code} / 空檔'
            else:
                ext = 'csv' if 'csv' in fm.lower() else 'json' if 'json' in fm.lower() else 'xml' if 'xml' in fm.lower() else 'bin'
                name = f'raw/{i}_{k}.{ext}.gz'
                save_gz(os.path.join(out_dir, name), body)
                fr['file'] = name
                fr.update(summarize(body, fm))
                n_files += 1
            rec['files'].append(fr)
        st['sets'][i] = rec
        for fr in rec['files']:
            p = fr.get('period')
            log(f'{"✅" if fr.get("file") else "❌"} {i} {rec["name"][:28]} [{fr["fmt"]}] '
                + (f'{fr.get("n_rows", "?")} 列 {fr.get("enc", "")} 資料期 {p[0]}~{p[1]}({fr.get("period_col")})' if p
                   else f'{fr.get("kind", "")} {fr.get("err", "")}'))
    st['n_files'] = n_files
    st['n_sets'] = sum(1 for r in st['sets'].values() if any(f.get('file') for f in r.get('files', [])))
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, '_status.json'), 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    return st, n_files


def selftest():
    bad = 0

    def ok(c, m):
        nonlocal bad
        print(('✅ ' if c else '❌ ') + m)
        bad += 0 if c else 1

    meta = {'success': True, 'result': {'title': '外銷訂單_光學器材', 'distribution': [
        {'resourceFormat': 'JSON', 'resourceDownloadUrl': 'https://x/a.json'},
        {'resourceFormat': 'CSV', 'resourceDownloadUrl': 'https://x/a.csv'},
        {'resourceFormat': 'CSV', 'resourceDownloadUrl': 'https://x/a.csv'}],
        'note': '相關:https://data.gov.tw/dataset/88818 與 https://data.gov.tw/dataset/88817'}}
    ok(downloads(meta) == [('CSV', 'https://x/a.csv'), ('JSON', 'https://x/a.json')], '① 詮釋資料:找得到下載網址、去重、CSV 排前面、介紹頁不收')
    ok(title_of(meta) == '外銷訂單_光學器材', '② 標題(⛔ 寫死鍵名)')
    ok([ym_of(x) for x in ('115年9月', '11509', '2026-09', '2026/9', '2026年10月', '98年1月', 'abc', '2026-13')]
       == ['2026-09', '2026-09', '2026-09', '2026-09', '2026-10', '2009-01', None, None], '③ 資料期:民國 / 民國數字 / 西元三種寫法,13 月不算')
    big5 = '資料期,貨品別,統計值\n115年8月,光學器材,100\n115年9月,光學器材,120\n'.encode('cp950')
    s = summarize(big5)
    ok(s.get('enc') == 'cp950' and s.get('n_rows') == 2 and s.get('period') == ['2026-08', '2026-09'] and s.get('period_col') == '資料期',
       f'④ Big5 CSV 解得開、看得出資料期起訖({s.get("period")})')
    longf = ('a,b\n"' + 'x' * 200000 + '",1\n').encode('utf-8')
    s2 = summarize(longf)
    ok(s2.get('kind') == 'csv' and s2.get('max_cell') == 200000, '⑤ 超過 131072 字的欄位照讀(本站 6099 就死在這)、記下最長一格')
    ok(summarize(b'<!DOCTYPE html><html>').get('kind') == 'html/xml', '⑥ 回網頁 → 標 html/xml,⛔ 當成 CSV')

    class R:
        def __init__(s, code, body=b'', ct=''):
            s.status_code, s.content, s.headers = code, body, {'Content-Type': ct}
    calls, naps = [], []
    seq = [R(429), R(503), R(200, b'ok')]
    F = Fetcher(get=lambda u: (calls.append(u), seq.pop(0))[1], sleep=naps.append, gap=1.0)
    code, body, _, err = F.fetch('https://x/y')
    ok(code == 200 and body == b'ok' and 2 in naps and 4 in naps, f'⑦ 429 / 503 → 退避 2、4 秒後成功(睡了 {naps})')
    F2 = Fetcher(get=lambda u: (_ for _ in ()).throw(ConnectionError('boom')), sleep=lambda s: None, tries=3)
    ok(F2.fetch('https://x/z')[0] == 0 and 'ConnectionError' in F2.fetch('https://x/z')[3], '⑧ 連線一直失敗 → 回錯誤字串,⛔ 拋例外讓整輪停掉')

    # ⑨ 正式入口 run():假網路 —— 一份抓得到 + 一份下載失敗
    import tempfile
    pages = {
        API + '8380': R(200, json.dumps({'result': {'title': '出口值_按主要貨品分', 'distribution': [{'resourceFormat': 'CSV', 'resourceDownloadUrl': 'https://f/8380.csv'}]}}).encode()),
        'https://f/8380.csv': R(200, '年月,電子零組件\n2026-08,1\n2026-09,2\n'.encode('utf-8-sig')),
        API + '88819': R(200, json.dumps({'result': {'title': '外銷訂單_資訊通信產品', 'distribution': [{'resourceFormat': 'CSV', 'resourceDownloadUrl': 'https://f/88819.csv'}]}}, ensure_ascii=False).encode()),
        'https://f/88819.csv': R(500),
    }
    F3 = Fetcher(get=lambda u: pages.get(u, R(404)), sleep=lambda s: None, tries=2)
    with tempfile.TemporaryDirectory() as td:
        st, n = run(td, F3, known={'8380': '出口值', '88819': ''}, log=lambda *_: None)
        ok(n == 1 and os.path.exists(os.path.join(td, 'raw', '8380_0.csv.gz')) and os.path.exists(os.path.join(td, '_status.json')),
           '⑨ run():抓到的原檔 gzip 存起來、寫 _status.json')
        f19 = st['sets']['88819']['files'][0]
        ok('err' in f19 and 'file' not in f19 and st['n_sets'] == 1, '⑩ 下載失敗那份記錯誤、⛔ 算進「抓到幾份」')
    with tempfile.TemporaryDirectory() as td:
        st, n = run(td, Fetcher(get=lambda u: R(404), sleep=lambda s: None, tries=1), known={'8380': ''}, log=lambda *_: None)
        ok(n == 0 and st['n_sets'] == 0 and 'err' in st['sets']['8380'], '⑪ 全部抓不到 → 0 份(主程式據此 exit 1,⛔ 交出空分支)')
    # ⑫ ZIP(國發會 6099 的真實長相):列出檔名、挑最大的 CSV(跳過 schema)摘要
    zb = io.BytesIO()
    import zipfile
    with zipfile.ZipFile(zb, 'w') as z:
        z.writestr('schema-景氣指標與燈號.csv', 'name,title\n')
        z.writestr('景氣指標與燈號.csv', 'Date,景氣對策信號綜合分數\n202608,40\n202609,41\n')
    sz = summarize(zb.getvalue())
    ok(sz.get('kind') == 'zip' and len(sz.get('files', [])) == 2 and sz.get('inner', {}).get('period') == ['2026-08', '2026-09'],
       f'⑫ ZIP:列出 2 個檔、讀裡面那份 CSV 的資料期({sz.get("inner", {}).get("period")})')
    # ⑬ 直接查詢的網址(EXTRA)也走同一條下載 + 摘要;⑭ 403 的回應開頭記進錯誤
    pages2 = {'https://f/all.csv': R(200, '幣別,總計\n115年 9月,1\n'.encode('utf-8-sig')),
              'https://f/x.csv': R(403, b'<html><body><h1>Forbidden</h1> request blocked</body></html>')}
    F4 = Fetcher(get=lambda u: pages2.get(u, R(404)), sleep=lambda s: None, tries=1)
    with tempfile.TemporaryDirectory() as td:
        st, n = run(td, F4, known={}, log=lambda *_: None, extra={'all': ('全勾', 'https://f/all.csv'), 'blk': ('被擋', 'https://f/x.csv')})
        e = st['sets']['blk']['files'][0].get('err', '')
        ok(n == 1 and st['sets']['all']['files'][0].get('period') == ['2026-09', '2026-09'], '⑬ 直接查詢的網址照樣下載 + 摘要')
        ok(e.startswith('HTTP 403') and 'Forbidden request blocked' in e, f'⑭ 403 記下回應開頭({e[:50]})')
    print('✅ 全過' if not bad else f'❌ {bad} 條沒過')
    return bad


def main():
    if '--selftest' in sys.argv:
        sys.exit(1 if selftest() else 0)
    if '--help' in sys.argv or '-h' in sys.argv:
        print(__doc__)
        return
    out_dir = os.getenv('OUT_DIR') or 'trade_deep'
    max_min = float(os.getenv('MAX_MIN') or 20)
    F = Fetcher(deadline=time.time() + max_min * 60)
    print(f'📦 政府資料開放平臺 {len(KNOWN)} 份 + 財政部直接查詢 {len(EXTRA)} 份 → {out_dir}/')
    st, n = run(out_dir, F, extra=EXTRA)
    print(f'\n📊 抓到 {st["n_sets"]} 份資料集、{n} 個檔;請求 {F.n} 次')
    bad = [f'{i} {r.get("name", "")}' for i, r in st['sets'].items() if not any(f.get('file') for f in r.get('files', []))]
    if bad:
        print(f'⚠️ 沒抓到 {len(bad)} 份:' + ';'.join(bad))
    if n == 0:
        print('::error::一份都沒抓到 → 不推(看上面每一份的錯誤:HTTP 403 = 被擋、時間到 = 調 MAX_MIN)')
        sys.exit(1)


if __name__ == '__main__':
    main()
