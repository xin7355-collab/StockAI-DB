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
           pdf:[檔名…](⚠️ 只有檔名 —— MOPS 用 POST 表單下載,⛔ 沒有可直接開的網址), web, vid, other,
           mv?:"YYYY-MM-DD"(⏸️ V79.6.5 公司備註寫的延期新日期), mvc?:1(延期有條件:如/若停班), mvq?:1(寫了延期但沒寫日期) }
   ⏸️ 「已經開了沒」一律看 `eff_date(row)`(有 mv 且比 d 晚就用 mv)—— upcoming / recent / hist / 行事曆都照它分。

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
PAST = int(os.getenv('CONFCALL_PAST') or 60)
FUTURE = int(os.getenv('CONFCALL_FUTURE') or 45)
# 📚 V78.2.5 補挖模式:>0 = 往回抓這麼多天,只合併進 hist(⛔ 不動 upcoming / recent,否則 confcall.json 會撐到幾 MB,手機每次都要下載)
BACKFILL = int(os.getenv('CONFCALL_BACKFILL') or 0)
HIST_MAX = 40               # 每檔最多留幾場(≈ 5~10 年;一年約 2~4 場)
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


# ⏸️ V79.6.5 公司在「其他應敘明事項」寫延期(颱風假 / 臨時改期)→ 新日期。2026-10-23 颱風「薔琵」實例(逐字):
#   南亞 1303「如台北市政府公告115/10/23停止上班，本說明會將順延至115/10/27 14:00(線上會議)」
#   欣銓 3264「視公司所在地若因薔琵颱風影響，停止上班上課，原訂115/10/23法說會將順延至10/27召開」
#   高興昌 2008「若因薔琵颱風影响,本公司115/10/23原訂法說會延後一個工作日舉辦.」(沒寫日期)
#   泰宗 4169「原10/23法說會，因遇薔琵颱風改期至10/27。…」(場次表的日期已經改成 10/27 → ⛔ 不算延期)
# ⛔ 只認延期動詞**後面**的日期(原訂日期寫在前面,⛔ 不可被當成新日期);⛔ 不維護節日行事曆(「延後一個工作日」只標 mvq)。
_MOVE_VERB = r'(?:順延|延期|改期|延後|延至|改至|移至|延到|改到|挪至)'
_MOVE_RE = re.compile(_MOVE_VERB + r'\s*(?:至|到|於)?\s*(?:(\d{2,4})\s*[/年.\-]\s*)?(\d{1,2})\s*[/月.\-]\s*(\d{1,2})')
_MOVE_ANY = re.compile(_MOVE_VERB)
_MOVE_CTX = re.compile(r'法說|說明會|會議|召開|舉辦|本場|本次')     # 「簡報延後上傳」這種 ⛔ 不是會議延期
_MOVE_IF = re.compile(r'如|若|視|倘')


def parse_move(other, d):
    """公司備註 → {'mv': 'YYYY-MM-DD'} / {'mvq': 1} / {}(有條件再加 'mvc': 1)。
    新日期 ⛔ 不晚於原訂日 → {}(場次表已經改好日期);晚超過 120 天 → 只標 mvq(⛔ 不信)。"""
    t = str(other or '')
    if not t or not _MOVE_ANY.search(t) or not _MOVE_CTX.search(t):
        return {}
    try:
        d0 = date.fromisoformat(str(d)[:10])
    except Exception:
        return {}
    out = {}
    m = _MOVE_RE.search(t)
    if m:
        y, mo, dd = m.group(1), int(m.group(2)), int(m.group(3))
        if y:
            yy = int(y)
            yy = yy + 1911 if yy < 1000 else yy
        else:
            yy = d0.year
        try:
            nd = date(yy, mo, dd)
        except ValueError:
            nd = None
        if nd and not y and nd < d0 - timedelta(days=180):
            nd = date(nd.year + 1, mo, dd)        # 沒寫年份又跨年(12/30 → 1/5)
        if nd is None:
            out['mvq'] = 1
        elif nd <= d0:
            return {}
        elif nd > d0 + timedelta(days=120):
            out['mvq'] = 1
        else:
            out['mv'] = nd.isoformat()
    else:
        out['mvq'] = 1
    if _MOVE_IF.search(t):
        out['mvc'] = 1
    return out


def eff_date(r):
    """⏸️ 這一場「實際」哪天開:公司備註寫了延期、而且新日期比原訂晚 → 新日期;否則原訂日。"""
    d, mv = str((r or {}).get('d') or ''), str((r or {}).get('mv') or '')
    return mv if mv and mv > d else d


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
        out[-1].update(parse_move(out[-1]['other'], d))   # ⏸️ V79.6.5 延期(只在有的時候才多這幾欄)
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
    for r in sorted(rows, key=lambda x: eff_date(x)):
        ed = eff_date(r)                                   # ⏸️ V79.6.5 延期的照新日期
        try:
            d = date.fromisoformat(ed)
        except Exception:
            continue
        if not (today <= d <= end):
            continue
        ev = (f"📞 {r.get('name') or ''}({r['s']}) 法說會" + (f" {r['t']}" if r.get('t') else '')
              + (f"(原訂 {r['d'][5:].replace('-', '/')},公司公告延期)" if ed != r['d'] else ''))
        k = (ed, ev)
        if k in seen:
            continue
        seen.add(k)
        out.append({'date': ed, 'event': ev})
    return out


def merge_hist(old_hist, rows, today):
    """累積型:舊檔的 hist + 這一輪已經開過的場次。⛔ 只收過去日期;每檔最多 HIST_MAX 筆。"""
    hist = {}
    for k, v in (old_hist or {}).items():
        if isinstance(v, list):
            hist[str(k)] = [x for x in v if isinstance(x, str)]
    t = today.isoformat()
    for r in rows:
        ed = eff_date(r)                                   # ⏸️ V79.6.5 延期還沒開的 ⛔ 算進歷年
        if ed < t:
            hist.setdefault(r['s'], [])
            if ed not in hist[r['s']]:
                hist[r['s']].append(ed)
    for k in list(hist):
        hist[k] = sorted(set(hist[k]))[-HIST_MAX:]
        if not hist[k]:
            del hist[k]
    return hist


# ───────────────────────── 📊 會後股價反應(事實統計,⛔ 不是訊號) ─────────────────────────
REACT_H = (1, 5, 20)            # 幾個「交易日」之後
REACT_MIN_BARS = 120            # K 線太短的不算
# 🎲 V79.8.6 法說會「股性」(使用者:「有常常把法說會說成法會的,用發生率告訴使用者」):
#   法說會前一個交易日收盤 → 後一個交易日收盤(2 天),減同期加權;≤ −3% =「法會」、≥ +3% =「大漲」
#   ⭐ 同一檔「平常隨便 2 天」也照同一把尺算一次(= 股性)—— 兩個一定一起給(scripts/confcall_habit_probe.mjs:
#      過去常法會的下一場,猜得沒有比「這檔平常就很會動」準 → 慣性其實就是股性)
HABIT_TH = 3.0
HABIT_DEDUP = 5                 # 同一檔 5 個交易日內的第二場(開兩天 / 中英文各一場)只算一次
HABIT_CLIFF = (0.67, 1.5)       # 相鄰兩根超過這個比例 = 價格斷崖(lib_cliff 同一組)→ 那個窗口不算


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


def _div_adj():
    """{sym: {除權息日: 前收 / 參考價}} —— 除權息落在 2 天窗口裡要把價格接回去(⛔ 不然除息那天會被算成「法會」)。
    讀不到回 ({}, 原因)。"""
    try:
        j = json.loads((DATA / 'dividends_hist.json').read_text(encoding='utf-8'))
    except Exception as e:
        return {}, f'讀不到 dividends_hist.json({type(e).__name__})→ 除權息落在窗口裡的會被多算成「法會」'
    out = {}
    for sym, v in (j.items() if isinstance(j, dict) else []):
        if not isinstance(v, dict):
            continue
        for h in v.get('h') or []:
            try:
                p, r = float(h[3]), float(h[4])
            except Exception:
                continue
            if p > 0 and r > 0 and p / r < 1.6:
                out.setdefault(str(sym), {})[str(h[0])[:10].replace('/', '-')] = p / r
    return out, None


def _habit_x(sc, sd, i, mi, mc, adj):
    """第 i 根是法說會那天:前一天收盤 → 後一天收盤的超額(%);算不出來回 None。"""
    a, b = i - 1, i + 1
    if a < 0 or b >= len(sc):
        return None
    f = 1.0
    for k in (a + 1, b):
        g = adj.get(sd[k], 1.0)
        r = sc[k] * g / sc[k - 1]
        if not (HABIT_CLIFF[0] <= r <= HABIT_CLIFF[1]):
            return None
        f *= g
    ja, jb = mi.get(sd[a]), mi.get(sd[b])
    if ja is None or jb is None:
        return None
    return (sc[b] * f / sc[a] - 1) * 100 - (mc[jb] / mc[ja] - 1) * 100


def _habit_one(sc, sd, si, dates, mi, mc, adj):
    """一檔:回 (事件超額清單, 平常日子 [法會數, 大漲數, 總數])。事件日不是交易日 → 用之後第一個交易日。"""
    import bisect
    ev, last, near = [], -10 ** 9, set()
    for d in sorted({str(x)[:10] for x in dates}):
        i = si.get(d)
        if i is None:
            k = bisect.bisect_left(sd, d)
            i = k if 0 < k < len(sd) else None
        if i is None or i - last < HABIT_DEDUP:
            continue
        x = _habit_x(sc, sd, i, mi, mc, adj)
        if x is None:
            continue
        last = i
        ev.append(x)
        near.update(range(i - 2, i + 3))
    od = ou = on = 0
    for i in range(1, len(sc) - 1):
        if i in near:
            continue
        x = _habit_x(sc, sd, i, mi, mc, adj)
        if x is None:
            continue
        on += 1
        od += x <= -HABIT_TH
        ou += x >= HABIT_TH
    return ev, [od, ou, on]


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
    adj_all, div_err = _div_adj()
    hb, h_ev, h_ord = {}, [0, 0, 0], [0, 0, 0]   # 🎲 [法會, 大漲, 總數]
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
        # 🎲 股性:這一檔每一場法說會(前一天 → 後一天)與「平常隨便 2 天」同一把尺
        sd = sorted(si, key=si.get)
        hev, hord = _habit_one(sc, sd, si, dates, mi, mc, adj_all.get(sym, {}))
        if hev:
            dn, up = sum(1 for x in hev if x <= -HABIT_TH), sum(1 for x in hev if x >= HABIT_TH)
            h_ev[0] += dn; h_ev[1] += up; h_ev[2] += len(hev)
            for k in range(3):
                h_ord[k] += hord[k]
            if hord[2] >= 120:
                hb[sym] = [len(hev), dn, up, round(100 * hord[0] / hord[2], 1), round(100 * hord[1] / hord[2], 1)]
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
        # 🎲 V79.8.6 股性:hb[sym] = [場數, 法會場數, 大漲場數, 這檔平常 2 天法會 %, 大漲 %](平常日子 ≥120 個才給)
        'habit': {
            'th': HABIT_TH,
            'ev': {'n': h_ev[2], 'dn': round(100 * h_ev[0] / h_ev[2], 1) if h_ev[2] else None, 'up': round(100 * h_ev[1] / h_ev[2], 1) if h_ev[2] else None},
            'ord': {'n': h_ord[2], 'dn': round(100 * h_ord[0] / h_ord[2], 1) if h_ord[2] else None, 'up': round(100 * h_ord[1] / h_ord[2], 1) if h_ord[2] else None},
            'how': '法說會前一個交易日收盤 → 後一個交易日收盤,減加權;比大盤差 ≥3% = 法會、好 ≥3% = 大漲;同一檔 5 天內只算一次;平常 = 同一檔其他每一個 2 天',
            'div_error': div_err,
        },
        'hb': hb,
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


def fetch_market(typek, today, session=None, months=None):
    """typek = 'sii'(上市) / 'otc'(上櫃)。回 (rows, err)。⛔ 這裡自己 try,呼叫端⛔ 不需要再包。
    months = [(年, 月)…](📞 V79.6.3 confcall_deck 回補舊簡報清單用);沒給 = 照 PAST / FUTURE 算(原本的行為)。"""
    import requests
    s = session or requests.Session()
    mkt = '上市' if typek == 'sii' else '上櫃'
    rows, errs, got = [], [], 0
    for (y, m) in (months or _months(today)):
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


# 🩺 2026-10-24:上一份讀不讀得出來(build 會把它寫進 hist_error;⛔ 讀不到不可當成「本來就沒有」)
_OLD_STATE = {'status': 'missing', 'msg': ''}


def _load_old():
    """上一份 data/confcall.json(hist 是 5 年累積的,只能靠它延續)。
    🚨 10/24 #647:檔案被寫成「完整 JSON + 舊版的尾巴」→ 舊版 `except: return {}` 把 5 年歷史當成沒有
       → 這一輪只寫得出窗口內那幾百場。→ 一律走 lib_jsonsafe:尾巴多一段就用前面那份完整的;
       真的救不回來才回 {},而且記下原因(build 寫進 hist_error,⛔ 不靜默)。"""
    from lib_jsonsafe import load_json_safe
    j, st, msg = load_json_safe(OUT, None, what='data/confcall.json(上一份)')
    _OLD_STATE.update(status=st, msg=msg)
    return j if isinstance(j, dict) else {}


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
    upcoming = [r for r in rows if eff_date(r) >= t]     # ⏸️ V79.6.5 延期還沒開的算「未來」
    recent = [r for r in rows if eff_date(r) < t]
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
        # 🩺 上一份救不回來 → hist 只剩這一輪的,要說出來(陷阱 #22);補回 = hist_backfill which=confcall
        'hist_error': (f"上一份讀不出來({_OLD_STATE['msg']})→ 歷年只剩這一輪抓到的;"
                       f"要補回請跑 hist_backfill(which=confcall)") if _OLD_STATE['status'] == 'corrupt' else None,
        'n': {'sii': len(rows_sii), 'otc': len(rows_otc), 'upcoming': len(upcoming), 'recent': len(recent),
              'with_sum': sum(1 for r in rows if r['sum']),
              'with_files': sum(1 for r in rows if r['pdf'] or r['vid']),
              'with_ind': sum(1 for r in rows if r.get('ind'))},
        'note': '⛔ 只描述「誰、哪天、講了什麼」;法說會前後波動常變大,但方向實測 0 個成立(calendar_stock_probe),⛔ 不給多空。',
    }


def backfill(days, today=None, fetch=None, old=None):
    """📚 只補 hist:抓 [today−days, today−1] 每個月 → 已開過的場次併進舊檔 hist → 重算 react。
    ⛔ 舊檔不存在 → 不做(補挖是加在既有產物上,⛔ 不可憑空生一份少了 upcoming 的檔)。
    ⛔ 抓到 <100 場 → 不寫(多半是被擋)。回 (out 或 None, 訊息)。"""
    global PAST, FUTURE
    today = today or datetime.now(TW).date()
    old = _load_old() if old is None else old
    if not old or not isinstance(old.get('hist'), dict):
        return None, '❌ 找不到舊的 data/confcall.json(要先還原 data 分支那一份)→ ⛔ 不補'
    PAST, FUTURE = days, 0
    if fetch is None:
        import requests
        s = requests.Session()
        fetch = lambda typek: fetch_market(typek, today, s)
    rs, es = fetch('sii')
    ro, eo = fetch('otc')
    t = today.isoformat()
    rows = [r for r in rs + ro if r.get('d') and r['d'] < t]
    if len(rows) < 100:
        return None, f'❌ 只抓到 {len(rows)} 場(上市 err={es} / 上櫃 err={eo})→ ⛔ 不寫'
    n0 = sum(len(v) for v in old['hist'].values())
    out = dict(old)
    out['hist'] = merge_hist(old.get('hist'), rows, today)
    n1 = sum(len(v) for v in out['hist'].values())
    react = build_react(out['hist'], today)
    if not react.get('error'):
        out['react'] = react
    out['backfill'] = {'days': days, 'rows': len(rows), 'hist_before': n0, 'hist_after': n1,
                       'at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                       'err': {'sii': es, 'otc': eo}}
    return out, f'✅ 補挖 {len(rows)} 場 → hist {n0} → {n1} 筆(⛔ upcoming / recent 沒動)'


def main():
    today = datetime.now(TW).date()
    if BACKFILL > 0:
        print(f"📚 confcall 補挖模式:往回 {BACKFILL} 天(只合併 hist)")
        out, msg = backfill(BACKFILL, today)
        print('  ' + msg)
        if out is None:
            return 1
        OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        R = out.get('react') or {}
        print(f"  📊 會後統計:{R.get('events')} 場 ・+5 日超額中位 {R.get('med5')} vs 對照 {(R.get('base') or {}).get('med5')}"
              f" ・{OUT.stat().st_size / 1024:.1f} KB")
        return 0
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
