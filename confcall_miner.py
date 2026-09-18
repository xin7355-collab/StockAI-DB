#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🎤 confcall_miner.py —— 法說會(法人說明會)時間表 + 官方擇要 → `data/confcall.json`(V77.2.7)

🚨 為什麼要有這一支(2026-09-18 探針 Actions #35294351143 / #35294467879 定案):
   ・舊的 `macro_miner.fetch_earnings_calls` 打 TWSE OpenAPI `t187ap02_L` —— 探針實跑證實那是
     「**大股東名稱**」表,`t187ap38_L` 是股東會/股利表;TWSE 與 TPEx 的 OpenAPI 目錄**都沒有**法人說明會資料集。
     → 三個月來每天「📞 法說會 上市: 0 場」不是配額也不是網路,是**打錯資料集**(陷阱 #23 的變形)。
   ・⭐ 真正給得到的是公開資訊觀測站 **mopsov.twse.com.tw** 的 `ajax_t100sb02_1`(POST,按月查):
     欄位 = 代號 / 名稱 / 日期 / 時間 / 地點 / 擇要訊息 / 中文簡報檔 / 英文簡報檔 / 公司網站 / 影音連結 / 其他 / 歷年
     上市 9 月 301 列、上櫃 112 列。⚠️ `mops.twse.com.tw` 主機對 runner 回「因為安全性考量…」,⛔ 只有 mopsov 通。

📐 產物 `data/confcall.json`:
   { updated, data_date, src:{host, months:[…]}, src_error:{sii:null|str, otc:null|str},
     window:{past:60, future:45},
     upcoming:[row…]   // d >= data_date
     recent:[row…]     // d <  data_date(有擇要/簡報的多半在這裡 —— 會後才貼)
     hist:{ "2330":["2026-07-17", …] }   // 只存過去日期,每檔 ≤ HIST_MAX 筆,從舊檔合併(累積型)
     n:{sii, otc, upcoming, recent, with_sum, with_files} }
   row = { s, name, mkt:"上市"|"上櫃", d:"YYYY-MM-DD", t:"HH:MM", place, sum(≤400 字),
           pdf:[檔名…](⚠️ 只有檔名 —— MOPS 用 POST 表單下載,⛔ 沒有可直接開的網址), web, vid }

⛔ 四條不可改掉:
   ① **每個市場各自 try/except**(陷阱 #44)—— 上櫃掛掉⛔ 不可拖累上市;掛的那邊要寫 `src_error`(陷阱 #22)。
   ② **空過守門**:兩個市場加起來 0 列而舊檔有列 → ⛔ 不覆寫(印原因、exit 0)。
   ③ `hist` 是**累積型**:要先讀舊檔合併再寫,⛔ 不可每輪重建(playbook_scan 跑之前已還原 data/)。
   ④ 進入點放檔尾(陷阱 #9)。
"""
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DATA = Path(os.getenv('DATA_DIR', 'data'))
OUT = DATA / 'confcall.json'
HOST = os.getenv('CONFCALL_HOST', 'https://mopsov.twse.com.tw')
PAST = int(os.getenv('CONFCALL_PAST', '60'))
FUTURE = int(os.getenv('CONFCALL_FUTURE', '45'))
HIST_MAX = 40               # 每檔最多留幾場(≈ 3 年)
SUM_MAX = 400
UA = {'User-Agent': 'Mozilla/5.0 confcall_miner/1.0',
      'Accept': 'text/html, */*', 'Content-Type': 'application/x-www-form-urlencoded'}
TW = timezone(timedelta(hours=8))


# ───────────────────────── 解析(純函式,測試直接打這幾支) ─────────────────────────
def parse_roc_date(s):
    """'115/09/15' → '2026-09-15';失敗回 None。"""
    m = re.match(r'^\s*(\d{2,3})/(\d{1,2})/(\d{1,2})\s*$', str(s or ''))
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 1911:
        y += 1911
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


def _strip(html):
    """去標籤 + HTML 實體 + 壓空白。"""
    t = re.sub(r'<br\s*/?>', '\n', html or '', flags=re.I)
    t = re.sub(r'<[^>]+>', '', t)
    t = (t.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<')
          .replace('&gt;', '>').replace('&quot;', '"').replace('&#39;', "'"))
    t = re.sub(r'&#(\d+);', lambda m: chr(int(m.group(1))), t)
    return re.sub(r'\s+', ' ', t).strip()


def parse_rows(html, mkt):
    """把 ajax_t100sb02_1 回的 HTML 表格 → [row]。⛔ 只認 12 欄的資料列(表頭與空表不算)。"""
    out = []
    for tr in re.findall(r'<tr[^>]*>.*?</tr>', html or '', flags=re.S | re.I):
        tds = re.findall(r'<td[^>]*>(.*?)</td>', tr, flags=re.S | re.I)
        if len(tds) < 11:
            continue
        code = _strip(tds[0])
        if not re.match(r'^\d{4,6}[A-Z]?$', code):
            continue
        d = parse_roc_date(_strip(tds[2]))
        if not d:
            continue
        pdf = re.findall(r'fileName\.value="([^"]+)"', tds[6] + tds[7])
        web = re.findall(r'href=[\'"](https?://[^\'"]+)[\'"]', tds[8])
        vid = re.findall(r'href=[\'"](https?://[^\'"]+)[\'"]', tds[9])
        sum_ = _strip(tds[5])
        other = _strip(tds[10]) if len(tds) > 10 else ''
        out.append({
            's': code, 'name': _strip(tds[1]), 'mkt': mkt, 'd': d,
            't': _strip(tds[3]), 'place': _strip(tds[4])[:120],
            'sum': sum_[:SUM_MAX],
            'pdf': sorted(set(pdf)),
            'web': web[0] if web else '',
            'vid': vid[0] if vid else '',
            'other': '' if other in ('無', '無。', '') else other[:160],
        })
    return out


# ───────────────────────── 📄 簡報下載網址(V77.2.8) ─────────────────────────
# ⭐ 探針 Actions #35406340327 定案:官方 <form name='fm_fileDownload'> 逐字是
#      action='/server-java/FileDownLoad' ・step=9 ・filePath='/home/html/nas/STR/'
#      ・fileName='' ・functionName='t100sb02_1'
#    拿真實檔名實測:**GET 跟 POST 都回真 PDF**(HTTP 200 ・application/pdf ・2.67 MB ・%PDF-1.5)
#    → 前端可以直接 <a href> 一鍵開,外部 AI 也讀得到那個網址。
# 🚨 上一輪(#35406155112)的結論是「GET 不行」——**那是錯的**:官方寫 `name = 'step'`
#    (等號兩邊有空白),探針的 regex 吃不到 → 靜默退回我自己猜的 filePath → 四筆全「下載失敗」。
#    ⭐ 通用:「讓官方自己說」那一步**自己要先驗有沒有解析到**,⛔ 不可靜默退回猜測(陷阱 #40)。
#
# ⛔ 兩條:
#   ① **每輪從 HTML 重新解析**那個 form → 官方哪天改 filePath 我們自動跟上,⛔ 不寫死。
#      解析不到才退回這裡的常數,並標 `from:'fallback'`(⛔ 不靜默,陷阱 #22)。
#   ② 產物只存**一份樣板**(~200 bytes),⛔ 不存 918×2 條完整網址(那要 +240KB)。
#      前端照 `url + '?' + q + '&' + arg + '=' + 檔名` 組,⛔ 前端不可自己寫死網址。
FILE_FALLBACK = {'host': 'https://mopsov.twse.com.tw', 'path': '/server-java/FileDownLoad',
                 'q': {'step': '9', 'filePath': '/home/html/nas/STR/', 'functionName': 't100sb02_1'},
                 'arg': 'fileName', 'how': 'GET', 'from': 'fallback'}


def parse_file_form(html, host=None):
    """從 ajax 回應裡的 <form name='fm_fileDownload'> 抄出下載樣板。解析不到回 None。
    ⚠️ 官方的寫法是 `name = 'step'`(等號兩邊有空白)→ regex 一律 `\\s*=\\s*`。"""
    m = re.search(r"<form[^>]*fm_fileDownload[^>]*>.*?</form>", html or '', flags=re.S | re.I)
    if not m:
        return None
    f = m.group(0)
    ac = re.search(r"action\s*=\s*['\"]([^'\"]+)", f)
    if not ac:
        return None
    q = {}
    for tag in re.findall(r'<input[^>]*>', f, flags=re.I):
        n = re.search(r"name\s*=\s*['\"]([^'\"]*)", tag)
        v = re.search(r"value\s*=\s*['\"]([^'\"]*)", tag)
        if n and n.group(1):
            q[n.group(1)] = v.group(1) if v else ''
    if 'fileName' not in q or 'step' not in q:
        return None
    q.pop('fileName', None)
    path = ac.group(1)
    if not path.startswith('/'):
        path = '/' + path
    return {'host': host or HOST, 'path': path, 'q': q, 'arg': 'fileName', 'how': 'GET', 'from': 'form'}


def to_macro_events(rows, today, window_days=14):
    """給 macro_miner 用:未來 window 天內 → [{date, event}]。
    ⭐ 文字一律 `📞 {name}({code}) 法說會 {time}` —— index.html `_findEarningsEvent` 靠「事件文字含股名或代號」比對,
       ⛔ 改格式會讓報告頁 §12 / 個股頁提醒整個對不到(陷阱 #37)。"""
    end = today + timedelta(days=window_days)
    seen, out = set(), []
    for r in sorted(rows, key=lambda x: x['d']):
        try:
            d = date.fromisoformat(r['d'])
        except Exception:
            continue
        if not (today <= d <= end):
            continue
        ev = f"📞 {r.get('name') or ''}({r['s']}) 法說會" + (f" {r['t']}" if r.get('t') else '')
        k = (r['d'], ev)
        if k in seen:
            continue
        seen.add(k)
        out.append({'date': r['d'], 'event': ev})
    return out


def merge_hist(old_hist, rows, today):
    """累積型:舊檔的 hist + 這一輪已經開過的場次。⛔ 只收過去日期;每檔最多 HIST_MAX 筆。"""
    hist = {}
    for k, v in (old_hist or {}).items():
        if isinstance(v, list):
            hist[str(k)] = [x for x in v if isinstance(x, str)]
    t = today.isoformat()
    for r in rows:
        if r['d'] < t:
            hist.setdefault(r['s'], [])
            if r['d'] not in hist[r['s']]:
                hist[r['s']].append(r['d'])
    for k in list(hist):
        hist[k] = sorted(set(hist[k]))[-HIST_MAX:]
        if not hist[k]:
            del hist[k]
    return hist


# ───────────────────────── 📊 會後股價反應(事實統計,⛔ 不是訊號) ─────────────────────────
REACT_H = (1, 5, 20)            # 幾個「交易日」之後
REACT_MIN_BARS = 120            # K 線太短的不算


def _names_table():
    """🏭 `data/stock_names.json` → {代號: 產業碼}。讀不到回 ({}, 原因)。
    ⛔ 讀不到就留空 + 寫 `src_error.names`(陷阱 #22),⛔ 不猜產業。"""
    p = DATA / 'stock_names.json'
    try:
        j = json.loads(p.read_text(encoding='utf-8'))
        nm = (j or {}).get('names') or {}
        out = {}
        for k, v in nm.items():
            if isinstance(v, list) and len(v) > 1 and v[1]:
                out[str(k)] = str(v[1])
        if len(nm) < 500:
            return {}, f'股名表只有 {len(nm)} 檔(<500 不採用)'
        return out, None
    except Exception as e:
        return {}, f'讀不到 {p.name}:{type(e).__name__}'


def _closes(sym):
    """回 ({'YYYY-MM-DD': i}, [close…]);讀不到回 (None, None)。"""
    try:
        rows = json.loads((DATA / f'{sym}.json').read_text(encoding='utf-8'))
    except Exception:
        return None, None
    if not isinstance(rows, list) or len(rows) < REACT_MIN_BARS:
        return None, None
    idx, cl = {}, []
    for r in rows:
        if not isinstance(r, dict):
            continue
        d = str(r.get('date') or '').replace('/', '-')
        c = r.get('close')
        if len(d) != 10 or not isinstance(c, (int, float)) or c <= 0:
            continue
        idx[d] = len(cl)
        cl.append(float(c))
    return (idx, cl) if len(cl) >= REACT_MIN_BARS else (None, None)


def _med(a):
    if not a:
        return None
    b = sorted(a)
    n = len(b)
    return round(b[n // 2] if n % 2 else (b[n // 2 - 1] + b[n // 2]) / 2, 3)


def build_react(hist, today, mkt_sym='^TWII'):
    """對每一場**已經開過**的法說會,算 +1/+5/+20 個交易日的報酬 **減同期加權** = 超額(pp)。

    ⛔ 這**不是回測**:沒有扣交易成本、沒有過六道關卡、沒有門檻高原檢定 → 產物與畫面都要標明。
    ⭐ **對照組 = 同一批股票的所有交易日**(陷阱 #36:沒有對照組的統計,0% 也能當冠軍)。
    ⭐ 基準用**法說會當天的收盤**(資訊當天就公開了)→ ⛔ 不是隔天開盤,所以它只回答
       「那幾天的走勢長什麼樣」,⛔ 不回答「照這個做賺不賺得到」。
    ⚠️ 本站實測 37 種財經行事曆日**方向 0 個成立**(calendar_stock_probe)→ ⛔ 不可解讀成訊號。
    """
    from array import array
    mi, mc = _closes(mkt_sym)
    if not mi:
        return {'error': f'讀不到 {mkt_sym}.json → ⛔ 算不出超額(不拿絕對報酬充數)'}
    ev = {h: [] for h in REACT_H}
    base = {h: array('f') for h in REACT_H}
    by, n_ev, n_sym = {}, 0, 0
    for sym, dates in sorted((hist or {}).items()):
        if not isinstance(dates, list) or not dates:
            continue
        si, sc = _closes(sym)
        if not si:
            continue
        n_sym += 1
        # ① 對照組:這一檔的每一個交易日(⛔ 不抽樣 —— 用 float32 存,570k×3 也才 ~7MB)
        for d, i in si.items():
            j = mi.get(d)
            if j is None:
                continue
            for h in REACT_H:
                if i + h < len(sc) and j + h < len(mc):
                    base[h].append((sc[i + h] / sc[i] - 1) * 100 - (mc[j + h] / mc[j] - 1) * 100)
        # ② 事件組
        hit = {h: [] for h in REACT_H}
        for d in dates:
            i, j = si.get(d), mi.get(d)
            if i is None or j is None:
                continue
            n_ev += 1
            for h in REACT_H:
                if i + h < len(sc) and j + h < len(mc):
                    x = (sc[i + h] / sc[i] - 1) * 100 - (mc[j + h] / mc[j] - 1) * 100
                    ev[h].append(x)
                    hit[h].append(x)
        if len(hit[5]) >= 2:
            by[sym] = {'n': len(hit[5]), 'med5': _med(hit[5])}
    if not ev[5]:
        return {'error': '一場都對不到 K 線(data/ 還沒還原?)→ ⛔ 不給統計'}
    def pack(src, cnt):
        o = {'n': cnt}
        for h in REACT_H:
            o[f'med{h}'] = _med(list(src[h]))
        o['win5'] = round(100 * sum(1 for x in src[5] if x > 0) / len(src[5]), 1) if len(src[5]) else None
        return o
    return {
        **pack(ev, len(ev[5])),
        'syms': n_sym, 'events': n_ev,
        'base': pack(base, len(base[5])),
        'byStock': by,
        'how': '法說會當天收盤 → +N 個交易日收盤,減同期加權;對照組 = 同一批股票的每一個交易日',
        'caveat': '⛔ 不是回測:沒扣交易成本、沒過六道關卡。本站實測 37 種財經行事曆日方向 0 個成立 → ⛔ 不是買賣訊號。',
    }


# ───────────────────────── 抓取 ─────────────────────────
def _months(today):
    """涵蓋 [today−PAST, today+FUTURE] 的 (year, month) 清單。"""
    lo, hi = today - timedelta(days=PAST), today + timedelta(days=FUTURE)
    out, y, m = [], lo.year, lo.month
    while (y, m) <= (hi.year, hi.month):
        out.append((y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


_FILE_TPL = None            # 📄 這一輪從官方 form 抄到的下載樣板(fetch_market 會填;⛔ 模組層級,不改函式簽名)


def fetch_market(typek, today, session=None):
    """typek = 'sii'(上市) / 'otc'(上櫃)。回 (rows, err)。⛔ 這裡自己 try,呼叫端⛔ 不需要再包。"""
    import requests
    s = session or requests.Session()
    mkt = '上市' if typek == 'sii' else '上櫃'
    rows, errs, got = [], [], 0
    for (y, m) in _months(today):
        form = {'encodeURIComponent': '1', 'step': '1', 'firstin': '1', 'off': '1',
                'TYPEK': typek, 'year': str(y - 1911), 'month': f'{m:02d}'}
        last = None
        for attempt in range(3):
            try:
                r = s.post(f'{HOST}/mops/web/ajax_t100sb02_1', data=form,
                           headers={**UA, 'Referer': f'{HOST}/mops/web/t100sb02_1'}, timeout=30)
                if r.status_code != 200:
                    last = f'{y}/{m:02d} HTTP {r.status_code}'
                elif '因為安全性考量' in (r.text or '') or 'CAN NOT BE ACCESSED' in (r.text or ''):
                    last = f'{y}/{m:02d} 被主機擋(安全性考量)'
                else:
                    # 📄 每輪從官方 HTML 重新抄下載樣板(⛔ 不寫死;抄到一次就夠)
                    global _FILE_TPL
                    if _FILE_TPL is None or _FILE_TPL.get('from') != 'form':
                        t = parse_file_form(r.text, HOST)
                        if t:
                            _FILE_TPL = t
                    part = parse_rows(r.text, mkt)
                    rows.extend(part)
                    got += 1
                    print(f"  🎤 {mkt} {y}/{m:02d}:{len(part)} 場")
                    last = None
                    break
            except Exception as e:
                last = f'{y}/{m:02d} {type(e).__name__}: {str(e)[:80]}'
            time.sleep(1.5 * (attempt + 1))     # 指數退避(MOPS 對機器人敏感)
        if last:
            errs.append(last)
            print(f"  ⚠️ {mkt} {last}")
        time.sleep(0.8)
    err = None if got else ('; '.join(errs)[:300] or '沒有任何一個月查到')
    if got and errs:
        err = '部分月份失敗:' + '; '.join(errs)[:220]
    # 同一檔同一天只留一筆(MOPS 偶爾重複列)
    seen, uniq = set(), []
    for r in rows:
        k = (r['s'], r['d'], r['t'])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)
    return uniq, err


def _load_old():
    try:
        j = json.loads(OUT.read_text(encoding='utf-8'))
        return j if isinstance(j, dict) else {}
    except Exception:
        return {}


def build(rows_sii, err_sii, rows_otc, err_otc, today, old=None):
    """組出產物 dict;回 None = 空過守門擋下(⛔ 不覆寫)。"""
    old = old or {}
    rows = rows_sii + rows_otc
    lo, hi = (today - timedelta(days=PAST)).isoformat(), (today + timedelta(days=FUTURE)).isoformat()
    rows = [r for r in rows if lo <= r['d'] <= hi]
    old_n = len(old.get('upcoming') or []) + len(old.get('recent') or [])
    if not rows and old_n:
        print(f"❌ 兩個市場都 0 場而舊檔有 {old_n} 場 → 🚧 空過守門,⛔ 不覆寫 confcall.json"
              f"(上市:{err_sii} / 上櫃:{err_otc})")
        return None
    t = today.isoformat()
    rows.sort(key=lambda r: (r['d'], r['t'], r['s']))
    # 🏭 產業碼(V77.2.8):來源 `data/stock_names.json`(playbook_scan 在這一步之前已還原 data/)
    ind_map, ind_err = _names_table()
    # 📄 下載樣板:這一輪抄到就用抄到的,沒抄到退回常數並標 from='fallback'(⛔ 不靜默)
    file_tpl = _FILE_TPL or dict(FILE_FALLBACK)
    if file_tpl.get('from') != 'form':
        print("  ⚠️ 這一輪沒從官方 <form name='fm_fileDownload'> 抄到下載樣板 → 用內建常數"
              "(⛔ 若官方改過 filePath,簡報鈕會開不起來,要重跑 confcall_probe ⑦)")
    for r in rows:
        c = ind_map.get(r['s'])
        # ⚠️ 查不到要**把舊的拿掉**,⛔ 不是「有就寫、沒有就不動」——
        #    後者會讓 build() 不冪等(同一批 rows 跑第二次會帶著上一次的 ind),
        #    而「查不到卻還有一個碼」正是使用者最怕的那種「看起來有答案」。
        if c:
            r['ind'] = c
        else:
            r.pop('ind', None)
    upcoming = [r for r in rows if r['d'] >= t]
    recent = [r for r in rows if r['d'] < t]
    hist = merge_hist(old.get('hist'), rows, today)
    # 📊 會後股價反應(V77.2.8;⛔ 事實統計不是訊號)——算不出來就沿用舊的,⛔ 不編一組
    react = build_react(hist, today)
    if react.get('error'):
        old_react = old.get('react')
        print(f"  ⚠️ 會後股價統計算不出來:{react['error']}"
              + (f" → 沿用舊的({(old_react or {}).get('n')} 場)" if old_react and not old_react.get('error') else ''))
        if old_react and not old_react.get('error'):
            react = dict(old_react, stale=1)
    return {
        'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'data_date': t,
        'src': {'host': HOST, 'page': 'ajax_t100sb02_1', 'months': [f'{y}-{m:02d}' for y, m in _months(today)],
                'file': file_tpl},
        'src_error': {'sii': err_sii, 'otc': err_otc, 'names': ind_err},
        'window': {'past': PAST, 'future': FUTURE},
        'upcoming': upcoming, 'recent': recent, 'hist': hist, 'react': react,
        'n': {'sii': len(rows_sii), 'otc': len(rows_otc), 'upcoming': len(upcoming), 'recent': len(recent),
              'with_sum': sum(1 for r in rows if r['sum']),
              'with_files': sum(1 for r in rows if r['pdf'] or r['vid']),
              'with_ind': sum(1 for r in rows if r.get('ind'))},
        'note': '⛔ 只描述「誰、哪天、講了什麼」;法說會前後波動常變大,但方向實測 0 個成立(calendar_stock_probe),⛔ 不給多空。',
    }


def main():
    today = datetime.now(TW).date()
    print(f"🎤 confcall_miner 開跑(台北 {today},窗口 −{PAST}~+{FUTURE} 天,主機 {HOST})")
    import requests
    s = requests.Session()
    # ① 每個市場各自失敗各自記(陷阱 #44 / #22)
    rows_sii, err_sii = fetch_market('sii', today, s)
    rows_otc, err_otc = fetch_market('otc', today, s)
    print(f"  📊 上市 {len(rows_sii)} 場(err={err_sii}) ・上櫃 {len(rows_otc)} 場(err={err_otc})")
    old = _load_old()
    out = build(rows_sii, err_sii, rows_otc, err_otc, today, old)
    if out is None:
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    n = out['n']
    print(f"✅ data/confcall.json:未來 {n['upcoming']} 場 ・已開 {n['recent']} 場 ・有擇要 {n['with_sum']} ・"
          f"有簡報/影音 {n['with_files']} ・有產業碼 {n.get('with_ind')} ・hist {len(out['hist'])} 檔 ・{OUT.stat().st_size / 1024:.1f} KB")
    R = out.get('react') or {}
    if R.get('error'):
        print(f"  📊 會後股價統計:❌ {R['error']}")
    else:
        print(f"  📊 會後股價統計(⛔ 事實不是訊號):{R.get('events')} 場 / {R.get('syms')} 檔 ・"
              f"+5 日超額中位 {R.get('med5')} pp vs 對照組 {(R.get('base') or {}).get('med5')} pp "
              f"(對照 n={(R.get('base') or {}).get('n')})")
    if out['src_error'].get('names'):
        print(f"  ⚠️ 產業碼:{out['src_error']['names']} → 🏭 分組那一排會少掉,⛔ 不猜")
    if not out['upcoming'] and not out['recent']:
        print("  ⚠️ 兩邊都 0 場(舊檔也沒有)—— 前端會顯示「這幾天沒有」,先確認上面的 err 是不是被擋")
    return 0


if __name__ == '__main__':
    sys.exit(main())
