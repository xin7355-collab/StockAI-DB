#!/usr/bin/env python3
"""🏛️ 官方免費來源的抓取 + 解析 —— 換掉 yfinance 第一階段(docs/DECISIONS.md 的 V82.3.6 那一節)

為什麼要有這支:
  yfinance 1.x 要靠 curl_cffi 冒充 Chrome 瀏覽器(`impersonate="chrome"`)才連得到 Yahoo
  → 違反本專案「⛔ 偽裝瀏覽器、⛔ 繞過封鎖」;workflow 裝的又是沒鎖版本,哪天壞掉都不奇怪。
  「有官方免費來源、而且趕得上早上 8 點那一輪」的那幾格先換掉:
    ① 美債殖利率(10 年 / 2 年 / 3 個月)→ 美國財政部每日殖利率曲線(官方說美東 18:00 前公布)
       → FRED 備援(聯準會 H.15 轉載,同一組數字,但通常晚一天才上 FRED)
    ② 加權指數日 K → 證交所 MI_5MINS_HIST(本來就是主來源;現在連「長歷史」都不再靠 Yahoo)
  ⛔ 美股指數 / VIX 這一階段**不換**:FRED 的標普 500 約美中 19:00、那斯達克更晚、VIX 隔天早上才更新,
     都趕不上台北 08:00 那一輪盤前體檢(換了會讓盤前分數拿前一天的美股算)→ 理由與選項寫在 DECISIONS。

⭐ 每次抓取回三種結果之一(⛔ 混在一起 —— 「還沒有」跟「真的壞掉」下一步完全不同):
   ('ok',   資料, 附註)  拿到了;附註寫「部分月份失敗 / 改用備援」這種要交代的事(空字串 = 沒事)
   ('none', None, 原因)  官方有回應、格式也對,只是那段期間沒有值(休市 / 還沒公布)→ 安靜等,⛔ 當成壞掉
   ('fail', None, 原因)  連不上 / 被擋 / 回網頁 / 欄位改名 → 真的壞掉,原因要寫得出下一步
⛔ 連線一律走 lib_http.Gate:UA 寫明身分、⛔ 冒充瀏覽器、⛔ Referer、被擋(403 / 回網頁)就斷路 ⛔ 換身分重試、
   忙(429 / 5xx / 連不上)退避 2/4/8/16 秒、同一個網站固定間隔(證交所 3 秒)。
⛔ 三個來源都不需要金鑰;以後真的要加金鑰,只能放 Secrets → 環境變數 → HTTP 標頭(⛔ 網址、⛔ log)。

跑法:python3 lib_official.py --selftest(離線:網路 / 時間 / 睡眠全換假的)
"""
import csv
import io
import re
import sys
from datetime import date, timedelta

UA = 'Mozilla/5.0 (compatible; StockAI-DB/1.0; +https://github.com/xin7355-collab/stockai-db)'
# 財政部 / FRED 一輪只問一兩次,間隔 1 秒就夠;證交所 www 對短時間大量請求會暫時封 IP → 3 秒(同 lib_http)
GAPS = {'www.twse.com.tw': 3.0, 'home.treasury.gov': 1.0, 'fred.stlouisfed.org': 1.0}

TREASURY_URL = ('https://home.treasury.gov/resource-center/data-chart-center/interest-rates/'
                'daily-treasury-rates.csv/{y}/all?type=daily_treasury_yield_curve'
                '&field_tdr_date_value={y}&page&_format=csv')
FRED_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd={start}'
TAIEX_URL = 'https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?response=json&date={y:04d}{m:02d}01'

# 天期 → (財政部欄名, FRED 代號)。FRED 的 DGS* 就是 H.15 轉載財政部那條曲線 → 同一組數字
UST = {'10y': ('10 Yr', 'DGS10'), '2y': ('2 Yr', 'DGS2'), '3m': ('3 Mo', 'DGS3MO')}

_CACHE = {}   # 網址 → (status, 解析結果, 原因):同一輪 10 年 / 2 年 / 漲跌 共用一次財政部請求

# ⏱️ 財政部整年殖利率 CSV 是現做的、回得慢:2026-11-13 正式上線第一輪 —— 總經採礦(守門逾時 12 秒)退避重試共 3 次都失敗(最後一次 ReadTimeout)
#    → 掉到 FRED(晚一天;那天 FRED 最新還停在 11/10),同一輪籌碼採礦(逾時 20 秒)卻拿到財政部 11/12 的值。
#    → 只放寬這一個網址(⛔ 調慢整個守門:其他網站壞掉時每次都要白等)。失敗也進快取,一輪最多等這一次。
TREASURY_TIMEOUT = 30


def make_gate(send=None, sleep=None, clock=None, timeout=20, backoff=(2, 4, 8, 16)):
    """一輪共用一個(斷路狀態才會跨請求生效)。send / sleep / clock 只給測試換成假的。
    ⏱️ 有時限的 job(macro_cron 整個 job 只有 8 分)傳短一點的 timeout / backoff:
       同一個網址失敗也會進快取 → 一輪最多只等一次。"""
    from lib_http import Gate
    kw = {k: v for k, v in (('send', send), ('sleep', sleep), ('clock', clock)) if v is not None}
    return Gate(gaps=GAPS, backoff=tuple(backoff), timeout=timeout, ua=UA, **kw)


def clear_cache():
    _CACHE.clear()


def _head(t, n=60):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', str(t or '')))[:n].strip()


def _num(v):
    s = str(v if v is not None else '').strip().strip('"').replace(',', '')
    if s in ('', '.', '-', '--', 'N/A', 'NA', '#N/A', 'null', 'None'):
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f if f == f else None


def _iso(s):
    """'11/12/2026' / '2026-11-12' / '2026/11/12' → '2026-11-12';解不出回 None(財政部 CSV 的日期格式沒有官方說明,兩種都收)。"""
    s = str(s or '').strip().strip('"')
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', s)
    if m:
        mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = re.match(r'^(\d{4})[-/](\d{1,2})[-/](\d{1,2})', s)
        if not m:
            return None
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


def _roc(s):
    """民國 '115/11/02' / '1151102' → '2026/11/02'(跟 miner._roc_to_iso 同一種寫法:斜線)。"""
    m = re.match(r'^\s*(\d{2,3})[/\-]?(\d{1,2})[/\-]?(\d{1,2})\s*$', str(s or ''))
    if not m:
        return None
    y, mo, d = int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3))
    try:
        date(y, mo, d)
    except ValueError:
        return None
    return f'{y:04d}/{mo:02d}/{d:02d}'


def _norm(h):
    return re.sub(r'\s+', '', str(h or '')).lower()


# ───────────────────────── 美國財政部每日殖利率曲線 ─────────────────────────
def parse_treasury_csv(text):
    """財政部 CSV → ('ok', {iso日期: {欄名(去空白小寫): 值}}, '') / ('none', {}, 原因) / ('fail', None, 原因)。
    ⭐ 欄位一律照名字找(2025 起多了 1.5 Mo / 4 Mo,⛔ 寫死第幾欄);空格 / N/A = 那天那個天期沒有值。"""
    t = str(text or '').lstrip('﻿').strip()
    if not t:
        return 'fail', None, '財政部回空白內容'
    if t[:1] == '<':
        return 'fail', None, f'財政部回網頁不是 CSV(擋頁或改版):{_head(t)}'
    rows = list(csv.reader(io.StringIO(t)))
    head = [_norm(h) for h in rows[0]]
    if not head or head[0] != 'date':
        return 'fail', None, f'財政部 CSV 格式變了(第一欄不是 Date:{rows[0][:3]})'
    out, bad = {}, 0
    for r in rows[1:]:
        if not r or not str(r[0]).strip():
            continue
        d = _iso(r[0])
        if not d:
            bad += 1
            continue
        vals = {h: _num(v) for h, v in zip(head[1:], r[1:])}
        vals = {h: v for h, v in vals.items() if v is not None}
        if vals:
            out[d] = vals
    if not out:
        if bad:
            return 'fail', None, f'財政部 CSV 有 {bad} 列但日期一個都看不懂(格式變了?)'
        return 'none', {}, '財政部這段期間沒有殖利率(那年還沒開市 / 還沒公布)'
    return 'ok', out, ''


def _get_text(gate, url, expect, **kw):
    """→ (status, 文字, 原因)。HTTP 層的失敗(被擋 / 404 / 5xx 退避完)一律是 'fail'。"""
    res, why = gate.get(url, expect=expect, **kw)
    if res is None:
        return 'fail', None, why
    raw = getattr(res, 'content', None)
    if raw is None:
        raw = str(getattr(res, 'text', '') or '').encode('utf-8')
    return 'ok', raw.decode('utf-8', errors='replace') if isinstance(raw, (bytes, bytearray)) else str(raw), ''


def treasury_curve(gate, year):
    """某一年的整條曲線(有快取)→ (status, {iso: {欄: 值}}, 原因)。"""
    url = TREASURY_URL.format(y=year)
    if url not in _CACHE:
        st, txt, why = _get_text(gate, url, 'csv', timeout=max(TREASURY_TIMEOUT, getattr(gate, 'timeout', 0) or 0))
        _CACHE[url] = parse_treasury_csv(txt) if st == 'ok' else ('fail', None, why)   # 來源名由呼叫端加(⛔ 重複)
    return _CACHE[url]


def treasury_series(gate, col, today=None, min_points=2):
    """某個天期(如 '10 Yr')→ (status, [(iso, 值), …] 由舊到新, 原因)。
    先抓今年;點數不夠(1 月初 / 今年還沒開市)再補去年。欄位找不到 = 'fail'(改版,⛔ 當成沒資料)。"""
    today = today or date.today()
    key = _norm(col)
    pts, notes, years_seen_col = {}, [], False
    for y in (today.year, today.year - 1):
        st, curve, why = treasury_curve(gate, y)
        if st == 'fail':
            # 今年就失敗 → 斷路多半已經開了,⛔ 再問去年;去年失敗但今年夠 → 不影響
            if y == today.year or len(pts) < min_points:
                return 'fail', None, why
            break
        if st == 'ok':
            hit = {d: v[key] for d, v in curve.items() if key in v}
            if hit:
                years_seen_col = True
            elif not years_seen_col and curve:
                return 'fail', None, f'財政部 CSV 找不到「{col}」這一欄(欄名改了?有:{sorted(next(iter(curve.values())))[:8]})'
            pts.update(hit)
        else:
            notes.append(why)
        if len(pts) >= min_points:
            break
    if not pts:
        return 'none', None, ' ・'.join(notes) or f'財政部 {col} 沒有值'
    return 'ok', sorted(pts.items()), ''


# ───────────────────────── FRED(聖路易聯準銀行,免金鑰 graph CSV)─────────────────────────
def parse_fred_csv(text):
    """FRED fredgraph.csv → ('ok', [(iso, 值)…] 由舊到新, '') / ('none', [], 原因) / ('fail', None, 原因)。
    表頭 2024 起是 observation_date(以前是 DATE);沒有值的那天是「.」或空白 → 跳過(⛔ 當成 0)。"""
    t = str(text or '').lstrip('﻿').strip()
    if not t:
        return 'fail', None, 'FRED 回空白內容'
    if t[:1] == '<':
        return 'fail', None, f'FRED 回網頁不是 CSV(擋頁或改版):{_head(t)}'
    rows = list(csv.reader(io.StringIO(t)))
    if not rows[0] or _norm(rows[0][0]) not in ('observation_date', 'date') or len(rows[0]) < 2:
        return 'fail', None, f'FRED CSV 格式變了(表頭 {rows[0][:2]})'
    pts = []
    for r in rows[1:]:
        if len(r) < 2:
            continue
        d, v = _iso(r[0]), _num(r[1])
        if d and v is not None:
            pts.append((d, v))
    if not pts:
        return 'none', [], 'FRED 這段期間沒有值(休市 / 還沒更新)'
    return 'ok', sorted(pts), ''


def fred_series(gate, sid, days=20, today=None):
    """→ (status, [(iso, 值)…], 原因)。只要最近 days 天(cosd)→ 回應很小。"""
    today = today or date.today()
    url = FRED_URL.format(sid=sid, start=(today - timedelta(days=days)).isoformat())
    if url not in _CACHE:
        st, txt, why = _get_text(gate, url, 'csv')
        _CACHE[url] = parse_fred_csv(txt) if st == 'ok' else ('fail', None, why)
    return _CACHE[url]


def ust_series(gate, tenor, today=None):
    """美債殖利率 → (status, [(iso, 值)…], 來源, 附註)。① 財政部(當天公布)② FRED(備援,通常晚一天)。
    附註非空 = 有事要交代(用了備援 / 兩條都失敗的原因);用了備援時附註一定含「備援」(data_audit 看這個字
    判斷「值在、error 也在」是有交代的降級,⛔ 當成矛盾)。"""
    col, sid = UST[tenor]
    st, pts, why = treasury_series(gate, col, today=today)
    if st == 'ok':
        return 'ok', pts, '美國財政部', ''
    st2, pts2, why2 = fred_series(gate, sid, today=today)
    if st2 == 'ok':
        return 'ok', pts2, f'FRED {sid}', (f'財政部{"抓不到" if st == "fail" else "還沒有值"}({why})'
                                         f'→ 改用 FRED {sid}(備援;H.15 通常晚一天,看日期)')
    status = 'fail' if 'fail' in (st, st2) else 'none'
    return status, None, '', f'財政部:{why} ・FRED {sid}:{why2}'


def last_change(pts):
    """[(iso, 值)…] → (最新值, 跟前一筆比的漲跌%, 最新日期);只有一筆 → 漲跌 None(⛔ 硬算成 0%)。"""
    if not pts:
        return None, None, None
    d, v = pts[-1]
    chg = None
    if len(pts) >= 2 and pts[-2][1]:
        chg = round((v - pts[-2][1]) / pts[-2][1] * 100, 2)
    return v, chg, d


# ───────────────────────── 證交所加權指數(MI_5MINS_HIST,一個月一份)─────────────────────────
def parse_taiex_month(j):
    """一個月 → ('ok', [{'date':'YYYY/MM/DD','open','high','low','close','volume':0}…], '')
                / ('none', [], 原因) / ('fail', None, 原因)。
    欄位有名字就照名字找(⛔ 寫死第幾欄);沒給 fields 才照舊順序(日期, 開, 高, 低, 收)。
    ⚠️ volume 一律 0:這個端點沒有成交量(官方量能另外走 FMTQIK 寫 mkt_vol / amount,陷阱 #17)。"""
    if not isinstance(j, dict):
        return 'fail', None, f'證交所回的不是 JSON 物件({type(j).__name__})'
    stat = str(j.get('stat') or '')
    if stat and stat.upper() != 'OK':
        if '沒有符合' in stat or '查無' in stat:
            return 'none', [], f'證交所:{stat[:40]}'
        return 'fail', None, f'證交所回 stat={stat[:60]}'
    fields = [_norm(f) for f in (j.get('fields') or [])]

    def fi(*kws):
        for i, f in enumerate(fields):
            if any(k in f for k in kws):
                return i
        return None
    if fields:
        i_d, i_o, i_h, i_l, i_c = fi('日期'), fi('開盤'), fi('最高'), fi('最低'), fi('收盤')
        if i_d is None or i_c is None:
            return 'fail', None, f'證交所欄位改名了(fields={(j.get("fields") or [])[:6]})'
    else:
        i_d, i_o, i_h, i_l, i_c = 0, 1, 2, 3, 4
    data = j.get('data') or []
    if not data:
        return 'none', [], '證交所這個月沒有資料(還沒開市 / 休市)'
    rows = []
    for r in data:
        try:
            d, c = _roc(r[i_d]), _num(r[i_c])
        except (IndexError, TypeError):
            continue
        if not d or not c or c <= 0:
            continue

        def px(i):
            v = _num(r[i]) if i is not None and i < len(r) else None
            return round(v, 2) if v and v > 0 else round(c, 2)
        rows.append({'date': d, 'open': px(i_o), 'high': px(i_h), 'low': px(i_l), 'close': round(c, 2), 'volume': 0})
    if not rows:
        return 'fail', None, f'證交所有 {len(data)} 列但一列都解析不出來(格式變了?)'
    return 'ok', rows, ''


def recent_months(n, today=None):
    """往回 n 個月(含這個月)→ [(y, m)…] 由舊到新。"""
    today = today or date.today()
    y, m, out = today.year, today.month, []
    for _ in range(max(1, n)):
        out.append((y, m))
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    return out[::-1]


def taiex_months(gate, months):
    """[(y, m)…] → (status, rows 由舊到新(同一天只留一列), 附註)。
    部分月份失敗 → 還是 'ok',附註寫「N 個月份抓不到(哪幾個)」(⛔ 不可默默少幾個月);
    全部沒資料 → 'none';全部失敗(或一部分沒資料、其餘失敗)→ 'fail'。"""
    by, bad, empty = {}, [], []
    for y, m in months:
        res, why = gate.get(TAIEX_URL.format(y=y, m=m))
        tag = f'{y}/{m:02d}'
        if res is None:
            bad.append(f'{tag} {why}')
            continue
        try:
            j = res.json()
        except Exception as e:  # noqa: BLE001
            bad.append(f'{tag} 不是 JSON({type(e).__name__})')
            continue
        st, rows, why = parse_taiex_month(j)
        if st == 'fail':
            bad.append(f'{tag} {why}')
        elif st == 'none':
            empty.append(tag)
        else:
            for r in rows:
                by[r['date']] = r
    out = [by[d] for d in sorted(by)]
    notes = []
    if bad:
        notes.append(f'{len(bad)} 個月份抓不到({"; ".join(bad[:3])})')
    if empty:
        notes.append(f'{len(empty)} 個月份證交所沒有資料({", ".join(empty[:3])})')
    if out:
        return 'ok', out, ' ・'.join(notes)
    if bad:
        return 'fail', None, ' ・'.join(notes)
    return 'none', None, ' ・'.join(notes) or '證交所這幾個月都沒有資料'


# ───────────────────────── selftest ─────────────────────────
def selftest():
    fails, n = [], [0]

    def ok(name, cond, got=''):
        n[0] += 1
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {got}'))
        if not cond:
            fails.append(name)

    class R:
        def __init__(self, code, body):
            self.status_code = code
            self.content = body.encode('utf-8') if isinstance(body, str) else body

        def json(self):
            import json
            return json.loads(self.content.decode('utf-8'))

    def fake(routes):
        """routes:網址片段 → 回應(R / Exception / 依序回的 list)。回 (gate, 呼叫紀錄)。"""
        calls, t = [], [0.0]

        def send(method, url, **kw):
            calls.append((url, kw.get('headers') or {}))
            for frag, v in routes.items():
                if frag in url:
                    x = v.pop(0) if isinstance(v, list) else v
                    if isinstance(x, Exception):
                        raise x
                    return x
            return R(404, 'not found')

        def sleep(s):
            t[0] += s
        clear_cache()
        return make_gate(send=send, sleep=sleep, clock=lambda: t[0]), calls

    CSV26 = ('Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"\n'
             '11/12/2026,4.30,4.29,4.28,4.25,4.22,4.10,3.95,4.38,4.40,4.55,4.75,4.98,5.30,5.25\n'
             '11/11/2026,4.31,4.30,4.29,4.24,4.21,4.11,3.96,4.36,4.39,4.53,4.72,4.90,5.25,5.20\n'
             '11/10/2026,4.31,,4.29,4.26,N/A,4.11,3.96,4.35,4.39,4.52,4.71,4.88,5.22,5.18\n')
    st, curve, why = parse_treasury_csv(CSV26)
    ok('① 財政部 CSV:照欄名找(含新天期 1.5 Month / 4 Mo)、MM/DD/YYYY → ISO',
       st == 'ok' and curve['2026-11-12']['10yr'] == 4.98 and curve['2026-11-11']['2yr'] == 4.36
       and curve['2026-11-12']['3mo'] == 4.25, (st, why))
    ok('①b 空格 / N/A = 那天那個天期沒有值(⛔ 當成 0)', '4mo' not in curve['2026-11-10'] and '1.5month' not in curve['2026-11-10'])
    ok('①c 日期寫成 YYYY-MM-DD 也收', parse_treasury_csv('Date,10 Yr\n2026-11-12,4.98\n')[1] == {'2026-11-12': {'10yr': 4.98}})
    ok('② 回網頁 → fail(擋頁 / 改版,⛔ 當成沒資料)', parse_treasury_csv('<!DOCTYPE html><p>Access Denied</p>')[0] == 'fail')
    ok('②b 第一欄不是 Date → fail(格式變了)', parse_treasury_csv('Day,10 Yr\n11/12/2026,4.98\n')[0] == 'fail')
    ok('②c 只有表頭 → none(那年還沒開市,安靜等)', parse_treasury_csv('Date,10 Yr\n')[0] == 'none')
    ok('②d 有列但日期一個都看不懂 → fail(⛔ 說成沒資料)', parse_treasury_csv('Date,10 Yr\nxx,4.9\n')[0] == 'fail')

    g, calls = fake({'daily-treasury-rates.csv/2026': R(200, CSV26)})
    st, pts, why = treasury_series(g, '10 Yr', today=date(2026, 11, 13))
    st2, pts2, _ = treasury_series(g, '2 Yr', today=date(2026, 11, 13))
    ok('③ 10 年 / 2 年 同一輪只問財政部一次(快取),由舊到新',
       st == 'ok' and pts[-1] == ('2026-11-12', 4.98) and pts[0][0] == '2026-11-10' and st2 == 'ok' and len(calls) == 1,
       (st, pts, len(calls)))
    ua = calls[0][1].get('User-Agent', '')
    ok('③b UA 寫明 StockAI-DB、⛔ 冒充瀏覽器、⛔ Referer',
       'StockAI-DB' in ua and not re.search(r'Chrome|Safari|Firefox|Edg', ua) and 'Referer' not in calls[0][1], calls[0][1])

    seen_t = []

    def send_t(method, url, **kw):
        seen_t.append(('treasury' if 'treasury' in url else 'fred', kw.get('timeout')))
        return R(200, CSV26) if 'treasury' in url else R(200, 'observation_date,DGS10\n2026-11-11,4.90\n2026-11-12,4.98\n')
    clear_cache()
    gt = make_gate(send=send_t, sleep=lambda s: None, clock=lambda: 0.0, timeout=12, backoff=(2, 4))
    treasury_series(gt, '10 Yr', today=date(2026, 11, 13))
    fred_series(gt, 'DGS10', today=date(2026, 11, 13))
    ok('③c 財政部那一個請求等 30 秒(11/13 正式第一輪:12 秒 3 次都沒拿到、20 秒拿得到),FRED 照守門的 12 秒',
       seen_t == [('treasury', TREASURY_TIMEOUT), ('fred', 12)] and TREASURY_TIMEOUT >= 30, seen_t)
    clear_cache()

    JAN = 'Date,10 Yr\n01/02/2027,5.01\n'
    g, calls = fake({'csv/2027': R(200, JAN), 'csv/2026': R(200, CSV26)})
    st, pts, why = treasury_series(g, '10 Yr', today=date(2027, 1, 2))
    ok('④ 1 月初今年只有 1 天 → 補問去年,漲跌算得出來', st == 'ok' and pts[-2:] == [('2026-11-12', 4.98), ('2027-01-02', 5.01)]
       and len(calls) == 2, (st, pts))
    g, calls = fake({'csv/2026': R(200, 'Date,1 Mo,2 Yr\n11/12/2026,4.3,4.38\n')})
    ok('④b 欄位找不到(改名)→ fail,原因寫出有哪些欄', treasury_series(g, '10 Yr', today=date(2026, 11, 13))[0] == 'fail')
    g, calls = fake({'csv/2026': R(403, '<html>denied</html>'), 'fredgraph': R(200, 'observation_date,DGS10\n2026-11-11,4.90\n')})
    st, pts, src, note = ust_series(g, '10y', today=date(2026, 11, 13))
    ok('⑤ 財政部 403 → 斷路、改用 FRED;附註寫「備援」+ 原因(data_audit 才分得出是有交代的降級)',
       st == 'ok' and src == 'FRED DGS10' and pts == [('2026-11-11', 4.9)] and '備援' in note and '403' in note
       and sum(1 for c in calls if 'treasury' in c[0]) == 1, (st, src, note, len(calls)))
    g, calls = fake({'csv/2026': ConnectionError('x'), 'fredgraph': ConnectionError('y')})
    st, pts, src, note = ust_series(g, '2y', today=date(2026, 11, 13))
    ok('⑤b 兩條都連不上 → fail、兩個原因都寫(退避 2/4/8/16 後才放棄)',
       st == 'fail' and pts is None and '財政部' in note and 'FRED DGS2' in note, (st, note))
    g, calls = fake({'csv/2026': R(200, 'Date,10 Yr\n'), 'csv/2025': R(200, 'Date,10 Yr\n'),
                     'fredgraph': R(200, 'observation_date,DGS10\n2026-11-11,.\n2026-11-12,\n')})
    st, pts, src, note = ust_series(g, '10y', today=date(2026, 11, 13))
    ok('⑤c 兩條都「有回應但沒有值」→ none(安靜等,⛔ 紅燈)', st == 'none', (st, note))

    st, pts, why = parse_fred_csv('observation_date,DGS2\n2026-11-10,4.35\n2026-11-11,.\n2026-11-12,\n2026-11-13,4.40\n')
    ok('⑥ FRED:「.」/ 空白 = 那天沒有值(⛔ 當成 0)', st == 'ok' and pts == [('2026-11-10', 4.35), ('2026-11-13', 4.4)], pts)
    ok('⑥b 舊表頭 DATE 也收', parse_fred_csv('DATE,DGS2\n2020-01-02,1.58\n')[0] == 'ok')
    ok('⑥c FRED 回網頁 → fail', parse_fred_csv('<html>blocked</html>')[0] == 'fail')
    ok('⑥d 全部沒有值 → none', parse_fred_csv('observation_date,DGS2\n2026-11-11,.\n')[0] == 'none')
    ok('⑦ 漲跌% = (今天 − 前一筆) ÷ 前一筆(跟以前 ^TNX 同一個算法);只有一筆 → None',
       last_change([('a', 4.90), ('b', 5.0)]) == (5.0, 2.04, 'b') and last_change([('a', 4.9)]) == (4.9, None, 'a')
       and last_change([]) == (None, None, None))

    J = {'stat': 'OK', 'title': '115年11月 發行量加權股價指數歷史資料',
         'fields': ['日期', '開盤指數', '最高指數', '最低指數', '收盤指數'],
         'data': [['115/11/02', '43,000.12', '43,500.00', '42,900.50', '43,091.87'],
                  ['115/11/03', '43,100.00', '43,600.00', '43,000.00', '43,555.55']]}
    st, rows, why = parse_taiex_month(J)
    ok('⑧ 證交所:照欄名找、民國 → 西元(斜線)、千分位、volume 0',
       st == 'ok' and rows[0] == {'date': '2026/11/02', 'open': 43000.12, 'high': 43500.0, 'low': 42900.5,
                                  'close': 43091.87, 'volume': 0}, rows)
    J2 = {'stat': 'OK', 'fields': ['收盤指數', '日期', '開盤指數', '最高指數', '最低指數'],
          'data': [['43,091.87', '115/11/02', '43,000.12', '43,500.00', '42,900.50']]}
    ok('⑧b 欄序換了照樣對(⛔ 寫死第幾欄)', parse_taiex_month(J2)[1][0]['close'] == 43091.87
       and parse_taiex_month(J2)[1][0]['open'] == 43000.12)
    ok('⑧c 沒給 fields → 照舊順序(日期, 開, 高, 低, 收)',
       parse_taiex_month({'stat': 'OK', 'data': [['115/11/02', '1', '2', '0.5', '1.5']]})[1][0]['close'] == 1.5)
    ok('⑨ 「很抱歉，沒有符合條件的資料!」→ none', parse_taiex_month({'stat': '很抱歉，沒有符合條件的資料!'})[0] == 'none')
    ok('⑨b 其他 stat → fail(寫出原文)', parse_taiex_month({'stat': '系統忙碌中'}) [0] == 'fail')
    ok('⑨c 欄位改名(找不到收盤)→ fail', parse_taiex_month({'stat': 'OK', 'fields': ['日期', 'X'], 'data': [['115/11/02', '1']]})[0] == 'fail')
    ok('⑩ 往回 3 個月跨年', recent_months(3, date(2027, 1, 15)) == [(2026, 11), (2026, 12), (2027, 1)])

    OK10 = '{"stat":"OK","data":[["115/10/01","1","1","1","42000"]]}'
    OK11 = '{"stat":"OK","data":[["115/11/02","1","1","1","43000"]]}'
    g, calls = fake({'date=20261001': R(200, OK10), 'date=20261101': R(200, OK11), 'date=20260901': R(404, 'x')})
    st, rows, note = taiex_months(g, [(2026, 9), (2026, 10), (2026, 11)])
    ok('⑪ 一個月份失敗(404,不重試不斷路)→ 其他照收、附註寫「1 個月份抓不到」+ 哪個月(⛔ 默默少一個月)',
       st == 'ok' and [r['date'] for r in rows] == ['2026/10/01', '2026/11/02'] and '1 個月份抓不到' in note
       and '2026/09' in note and '404' in note, (st, note))
    g, calls = fake({'date=20260901': [R(500, 'x')] * 5, 'date=20261001': R(200, OK10)})
    st, rows, note = taiex_months(g, [(2026, 9), (2026, 10)])
    ok('⑪c 連續 5 次 5xx → 網站掛了、整個斷路:後面的月份 ⛔ 再送出,回 fail(lib_http 的設計)',
       st == 'fail' and len(calls) == 5 and '斷路中' in note, (st, note, len(calls)))
    gaps = []
    t0 = [0.0]

    def send2(method, url, **kw):
        gaps.append(t0[0])
        return R(200, '{"stat":"OK","data":[["115/11/02","1","1","1","43000"]]}')

    def sleep2(s):
        t0[0] += s
    clear_cache()
    g2 = make_gate(send=send2, sleep=sleep2, clock=lambda: t0[0])
    taiex_months(g2, [(2026, 10), (2026, 11)])
    ok('⑪b 證交所兩次請求至少隔 3 秒', len(gaps) == 2 and gaps[1] - gaps[0] >= 3.0, gaps)
    g, calls = fake({'MI_5MINS_HIST': R(200, '{"stat":"很抱歉，沒有符合條件的資料!"}')})
    ok('⑫ 全部月份都沒資料 → none', taiex_months(g, [(2030, 1)])[0] == 'none')
    g, calls = fake({'MI_5MINS_HIST': R(200, '<html>請稍後再試</html>')})
    st, rows, note = taiex_months(g, [(2026, 10), (2026, 11)])
    ok('⑫b 回擋頁 → fail、整個網站斷路(第二個月 ⛔ 再送出)', st == 'fail' and len(calls) == 1 and '斷路' in note, (st, note, len(calls)))

    print(f'\n{"✅ 全過" if not fails else "❌ 失敗 " + str(len(fails)) + " 條"}(共 {n[0]} 條)')
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    print(__doc__)
