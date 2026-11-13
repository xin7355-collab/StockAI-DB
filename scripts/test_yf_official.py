#!/usr/bin/env python3
"""🏛️ 換掉 yfinance 第一階段:走正式入口、網路全換假的(⛔ 真的連網)。

換掉的那幾格(docs/DECISIONS.md 的 V82.3.6 那一節):
  macro_miner  美債 10 年 / 2 年 / ust10y(含日漲跌與日期)→ 美國財政部 → FRED 備援;加權 60 日位階最後一層 → 證交所
  radar_miner  RS 大盤基準 → 本機官方 ^TWII.json → 證交所
  miner        macro_cache 的 us02y → 財政部 3 個月期;加權 / 櫃買長歷史的底 → 磁碟 / 已發佈那份(⛔ Yahoo 5 年)
驗:
  ① miner.fetch_us_macro_cache:Yahoo 只被問「還沒有官方替代」的 13 格(⛔ ^TWII / ^TWOII / ^IRX)
  ② 長歷史:磁碟舊列原封不動(含舊 volume / amount)、近 3 個月換官方、超過 5 年的裁掉;FMTQIK 只補 3 個月
     ⭐ 決定性對照:同一份磁碟檔拿掉 amount → 要補的月份 > 3(= 以前每輪拿 Yahoo 當底的情況)
  ③ macro_cache 形狀跟以前一樣(twii / us02y = {date, close, prev, chg_pct};twii_history 120 根)
  ④ yfinance 整個載入失敗 → 加權 / 櫃買 / us02y 照常,美股那 13 格各有 *_error(⛔ 整支跳過)
  ⑤ 磁碟沒有 → 讀已發佈那份;都沒有 → 冷啟動跟證交所要 61 個月;湊不到一年 → ⛔ 寫檔 + 寫原因
  ⑥ macro_miner 10 年 / 2 年 / ust10y 同一輪只問財政部一次;漲跌% 算法同 ^TNX;日期進「不可倒退」守門
  ⑦ 財政部被擋 → FRED 備援,error 含「備援」(跟 data_audit 的白名單跨檔比對);兩條都壞 → 「抓不到」、值 None
  ⑧ macro_miner 不在模組層 import yfinance(⭐ 注入:把那行加回去、yfinance 壞掉 → 整支 import 失敗)
  ⑨ 加權 60 日位階 / radar RS:本機有就 ⛔ 連網;沒有才問證交所;都沒有 → 空 / None + 原因
  ⑩ 靜態:換掉的函式裡沒有 yfinance、沒有假瀏覽器 UA
跑法:python3 scripts/test_yf_official.py
"""
import inspect
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import types
from contextlib import redirect_stdout
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('SKIP_GLOBAL', '1')
for _m in ('shioaji',):
    if _m not in sys.modules:
        sys.modules[_m] = types.ModuleType(_m)

YF_CALLS = []


def _install_fake_yf():
    """假 yfinance:記下被問了哪些 ticker,回兩根假日線(不需要 pandas)。"""
    class _TS:
        def __init__(self, d):
            self.d = d

        def date(self):
            return self.d

    class _Row(dict):
        def __init__(self, d, c):
            super().__init__(Close=c)
            self.name = _TS(d)

    class _Hist:
        def __init__(self, rows):
            self.iloc, self.empty = rows, not rows

        def __len__(self):
            return len(self.iloc)

    class _Ticker:
        def __init__(self, t):
            self.t = t
            YF_CALLS.append(t)

        def history(self, **kw):
            return _Hist([_Row(date(2026, 11, 11), 100.0), _Row(date(2026, 11, 12), 101.0)])
    mod = types.ModuleType('yfinance')
    mod.Ticker = _Ticker
    sys.modules['yfinance'] = mod


_install_fake_yf()
import lib_official as LO   # noqa: E402
import macro_miner as mm    # noqa: E402
import miner as M           # noqa: E402
import radar_miner as rm    # noqa: E402

fails = []


def ok(name, cond, got=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + ('' if cond else f'  → 實際:{str(got)[:300]}'))
    if not cond:
        fails.append(name)


def quiet(fn, *a, **k):
    buf = io.StringIO()
    with redirect_stdout(buf):
        r = fn(*a, **k)
    return r, buf.getvalue()


T = date.today()


def wdays(a, b):
    d, out = a, []
    while d <= b:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def roc(d):
    return f'{d.year - 1911}/{d.month:02d}/{d.day:02d}'


def off_close(d):
    return float(40000 + d.toordinal() % 1000)


class R:
    def __init__(self, code, body):
        self.status_code = code
        self.content = body.encode('utf-8') if isinstance(body, str) else body

    def json(self):
        return json.loads(self.content.decode('utf-8'))


UST_DAYS = wdays(T - timedelta(days=9), T - timedelta(days=1))[-3:]
UST_CSV = ('Date,"1 Mo","3 Mo","2 Yr","10 Yr"\n'
           + ''.join(f'{d.month:02d}/{d.day:02d}/{d.year},4.30,{v3},{v2},{v10}\n'
                     for d, v3, v2, v10 in zip(reversed(UST_DAYS), (4.25, 4.24, 4.26), (4.38, 4.36, 4.35), (4.98, 4.90, 4.88))))


def make_fake_gate(twse_months_with_data=None, treasury=None, fred=None):
    """回 (gate, 呼叫紀錄)。twse_months_with_data:有資料的 (y, m) 集合(None = 每個月都有)。"""
    calls = []
    t = [0.0]

    def send(method, url, **kw):
        calls.append(url)
        if 'MI_5MINS_HIST' in url:
            ym = re.search(r'date=(\d{4})(\d{2})01', url)
            y, m = int(ym.group(1)), int(ym.group(2))
            if twse_months_with_data is not None and (y, m) not in twse_months_with_data:
                return R(200, '{"stat":"很抱歉，沒有符合條件的資料!"}')
            first = date(y, m, 1)
            last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))
            rows = [[roc(d), '1', '1', '1', f'{off_close(d):,.2f}'] for d in wdays(first, min(last, T))]
            return R(200, json.dumps({'stat': 'OK', 'fields': ['日期', '開盤指數', '最高指數', '最低指數', '收盤指數'],
                                      'data': rows}))
        if 'daily-treasury-rates.csv' in url:
            return treasury if treasury is not None else R(200, UST_CSV)
        if 'fredgraph' in url:
            return fred if fred is not None else R(404, 'no')
        return R(404, 'unknown')

    def sleep(s):
        t[0] += s
    LO.clear_cache()
    return LO.make_gate(send=send, sleep=sleep, clock=lambda: t[0]), calls


# ═══════════════════════ miner.fetch_us_macro_cache ═══════════════════════
print('🏛️ miner.fetch_us_macro_cache(走正式入口,網路全假)')
FMTQIK_ASKED = []


def _fake_fmtqik(months, _get=None):
    FMTQIK_ASKED.append(list(months))
    return {}


TWOII_FM = [{'date': d.isoformat(), 'open': 300.0, 'high': 301.0, 'low': 299.0, 'close': 300.0 + i % 7,
             'volume': 0, 'amount': 1} for i, d in enumerate(wdays(T - timedelta(days=400), T - timedelta(days=1)))]
M._fetch_fmtqik_months = _fake_fmtqik
M._fetch_otc_history_finmind = lambda days_back=400: [dict(r) for r in TWOII_FM]
M._fetch_otc_history_official = lambda months_back=2: None
M.time.sleep = lambda *_a, **_k: None


def disk_twii(with_amount=True):
    rows = []
    for i, d in enumerate(wdays(T - timedelta(days=6 * 365), T - timedelta(days=1))):
        r = {'date': d.strftime('%Y/%m/%d'), 'open': 1.0, 'high': 1.0, 'low': 1.0, 'close': 10000.0 + i, 'volume': 555}
        if with_amount:
            r.update(mkt_vol=1, amount=777)
        rows.append(r)
    return rows


def run_macro_cache(tmp, gate, get=None):
    cwd = os.getcwd()
    os.chdir(tmp)
    try:
        _, log = quiet(M.fetch_us_macro_cache, _gate=gate, _get=get)
    finally:
        os.chdir(cwd)
    mc = json.loads((Path(tmp) / 'macro_cache.json').read_text(encoding='utf-8'))
    p = Path(tmp) / 'data' / '^TWII.json'
    tw = json.loads(p.read_text(encoding='utf-8')) if p.exists() else None
    return mc, tw, log


def no_get(u):
    raise AssertionError(f'⛔ 不該讀已發佈那份:{u}')


tmp = tempfile.mkdtemp(prefix='yfoff_')
(Path(tmp) / 'data').mkdir()
DISK = disk_twii()
(Path(tmp) / 'data' / '^TWII.json').write_text(json.dumps(DISK), encoding='utf-8')
(Path(tmp) / 'data' / '^TWOII.json').write_text(json.dumps(TWOII_FM[:50]), encoding='utf-8')
YF_CALLS.clear()
FMTQIK_ASKED.clear()
gate, calls = make_fake_gate()
mc, tw, log = run_macro_cache(tmp, gate, get=no_get)
_off_months = LO.recent_months(3)
_cut = (T.replace(year=T.year - 5)).isoformat() if not (T.month == 2 and T.day == 29) else T.replace(year=T.year - 5, day=28).isoformat()
ok('① Yahoo 只被問 13 格(⛔ ^TWII / ^TWOII / ^IRX)',
   sorted(YF_CALLS) == sorted(M._YF_MACRO_SYMBOLS.values()) and not {'^TWII', '^TWOII', '^IRX'} & set(YF_CALLS), YF_CALLS)
ok('①b 證交所只問最近 3 個月、財政部 1 次,而且全部走 lib_official(UA 寫明身分)',
   sum('MI_5MINS_HIST' in c for c in calls) == 3 and sum('treasury' in c for c in calls) == 1, calls)
_by = {r['date']: r for r in tw}
_old = [r for r in DISK if r['date'].replace('/', '-') >= _cut and (int(r['date'][:4]), int(r['date'][5:7])) < _off_months[0]]
ok('② 磁碟舊列原封不動(含舊 volume / amount)', _old and all(_by.get(r['date']) == r for r in _old), len(_old))
_recent = [r for r in tw if (int(r['date'][:4]), int(r['date'][5:7])) >= _off_months[0]]
ok('②b 近 3 個月換成證交所的收盤(volume 0)',
   _recent and all(r['close'] == off_close(date(int(r['date'][:4]), int(r['date'][5:7]), int(r['date'][8:10])))
                   and r['volume'] == 0 for r in _recent), _recent[:2])
ok('②c 超過 5 年的裁掉(跟以前 Yahoo period=5y 一樣長)',
   min(r['date'].replace('/', '-') for r in tw) >= _cut and DISK[0]['date'] not in _by, (tw[0]['date'], _cut))
ok('②d FMTQIK 只補 3 個月(底本來就有 amount)', FMTQIK_ASKED and max(len(x) for x in FMTQIK_ASKED) <= 3, FMTQIK_ASKED)
ok('③ macro_cache.twii = {date, close, prev, chg_pct}(跟以前同形狀,日期用 -)',
   set(mc['twii']) == {'date', 'close', 'prev', 'chg_pct'} and mc['twii']['date'] == tw[-1]['date'].replace('/', '-')
   and len(mc['twii_history']) == 120, mc.get('twii'))
_v3, _p3 = 4.25, 4.24
ok('③b us02y = 財政部 3 個月期,{date, close, prev, chg_pct} 形狀照舊',
   mc.get('us02y') == {'date': UST_DAYS[-1].isoformat(), 'close': _v3, 'prev': _p3,
                       'chg_pct': round((_v3 - _p3) / _p3 * 100, 2)}, mc.get('us02y'))
ok('③c 美股那幾格照舊(sp500 = 假 Yahoo 的 101 / +1%)', mc.get('sp500', {}).get('close') == 101.0
   and mc['sp500']['chg_pct'] == 1.0 and 'twii_error' not in mc and 'us02y_error' not in mc, mc.get('sp500'))
ok('③d 櫃買走 FinMind(免費層)疊在磁碟上,⛔ Yahoo', mc.get('twoii', {}).get('date') == TWOII_FM[-1]['date']
   and len(mc.get('twoii_history') or []) == 120, mc.get('twoii'))

print('⭐ 決定性對照:底沒有 amount(= 以前每輪拿 Yahoo 5 年當底)→ FMTQIK 要補的月份遠多於 3')
tmp2 = tempfile.mkdtemp(prefix='yfoff2_')
(Path(tmp2) / 'data').mkdir()
(Path(tmp2) / 'data' / '^TWII.json').write_text(json.dumps(disk_twii(with_amount=False)), encoding='utf-8')
(Path(tmp2) / 'data' / '^TWOII.json').write_text(json.dumps(TWOII_FM), encoding='utf-8')
FMTQIK_ASKED.clear()
gate, calls = make_fake_gate()
run_macro_cache(tmp2, gate, get=no_get)
ok('②e 對照組:同樣流程、底沒有 amount → 要補 ≥ 50 個月份(以前每輪都這樣打證交所)',
   FMTQIK_ASKED and max(len(x) for x in FMTQIK_ASKED) >= 50, [len(x) for x in FMTQIK_ASKED])

print('🧯 yfinance 整個載入失敗')
_saved = sys.modules.get('yfinance')
sys.modules['yfinance'] = None      # → import yfinance 丟 ImportError
try:
    gate, calls = make_fake_gate()
    mc4, tw4, log4 = run_macro_cache(tmp, gate, get=no_get)
finally:
    sys.modules['yfinance'] = _saved
ok('④ 加權 / 櫃買 / us02y 照常(官方),⛔ 整支跳過', all(k in mc4 for k in ('twii', 'twoii', 'us02y', 'twii_history'))
   and tw4 and len(tw4) >= 240, sorted(mc4))
ok('④b 美股那 13 格各寫 *_error(data_audit D3 才分得出「有交代」),⛔ 默默不見',
   all(f'{k}_error' in mc4 and 'yfinance 載入失敗' in mc4[f'{k}_error'] and k not in mc4 for k in M._YF_MACRO_SYMBOLS),
   [k for k in mc4 if k.endswith('_error')])

print('📦 磁碟沒有 → 已發佈那份;都沒有 → 冷啟動')
tmp5 = tempfile.mkdtemp(prefix='yfoff5_')
(Path(tmp5) / 'data').mkdir()
GOT = []


def pub_get(u):
    GOT.append(u)
    if 'raw.githubusercontent.com' in u and '%5ETWII.json' in u:
        return R(200, json.dumps(DISK))
    if '%5ETWOII.json' in u:
        return R(200, json.dumps(TWOII_FM))
    return R(404, 'x')


gate, calls = make_fake_gate()
mc5, tw5, log5 = run_macro_cache(tmp5, gate, get=pub_get)
ok('⑤ 磁碟沒有 → 讀 data 分支 raw 那份當底(網址把 ^ 編成 %5E)、照常寫檔',
   any('%5ETWII.json' in u for u in GOT) and tw5 and len(tw5) >= 1000 and sum('MI_5MINS_HIST' in c for c in calls) == 3,
   (GOT[:2], len(tw5 or [])))
tmp6 = tempfile.mkdtemp(prefix='yfoff6_')
(Path(tmp6) / 'data').mkdir()
gate, calls = make_fake_gate(twse_months_with_data=set(LO.recent_months(3)))
mc6, tw6, log6 = run_macro_cache(tmp6, gate, get=lambda u: R(404, 'x'))
_DA = (ROOT / 'scripts' / 'data_audit.py').read_text(encoding='utf-8')
_WL = re.findall(r"'([^']+)'", re.search(r"_intentional = \(([^)]*)\)", _DA, re.S).group(1))
ok('⑤b 磁碟、已發佈都沒有 → 冷啟動跟證交所要 61 個月', sum('MI_5MINS_HIST' in c for c in calls) == M.INDEX_COLD_MONTHS,
   sum('MI_5MINS_HIST' in c for c in calls))
ok('⑤c 只湊到 3 個月(< 240 根)→ ⛔ 寫 ^TWII.json(⛔ 短蓋長)+ twii_error 寫原因(⛔ 含 data_audit 的「刻意降級」字眼)',
   tw6 is None and 'twii_error' in mc6 and '⛔ 寫' in mc6['twii_error'] and not [w for w in _WL if w in mc6['twii_error']],
   mc6.get('twii_error'))

print('🚧 13 週美債:財政部 / FRED 都被擋')
gate, calls = make_fake_gate(treasury=R(403, '<html>denied</html>'), fred=R(200, '<html>blocked</html>'))
_res = {}
quiet(M._us02y_official, _res, gate)
ok('⑤d 兩條都擋 → 沒有 us02y、us02y_error 寫「都抓不到」+ 兩個原因', 'us02y' not in _res
   and '都抓不到' in _res.get('us02y_error', '') and '403' in _res['us02y_error'] and 'FRED' in _res['us02y_error'], _res)

# ═══════════════════════ macro_miner ═══════════════════════
print('\n🏛️ macro_miner 美債(財政部 → FRED)')
gate, calls = make_fake_gate()
mm._OFF_GATE = gate
mm._YF_LAST_DATE.clear()
YF_CALLS.clear()
(y10, e10), _ = quiet(mm.fetch_us10y_yield)
(y2, e2), _ = quiet(mm.fetch_us2y_yield)
(v, c, e), _ = quiet(mm.fetch_ust10y)
ok('⑥ 10 年 4.98 / 2 年 4.38、沒有 error', (y10, e10, y2, e2) == (4.98, None, 4.38, None), (y10, e10, y2, e2))
ok('⑥b ust10y 漲跌% = (4.98 − 4.90) ÷ 4.90 × 100(跟以前 ^TNX 同一個算法)',
   (v, c, e) == (4.98, round((4.98 - 4.90) / 4.90 * 100, 2), None), (v, c, e))
ok('⑥c 三個地方同一輪只問財政部 1 次,Yahoo 0 次', sum('treasury' in u for u in calls) == 1 and not YF_CALLS,
   (calls, YF_CALLS))
ok('⑥d 資料日期寫進 _YF_LAST_DATE[UST10Y_SRC](「日期不可倒退」守門靠它)',
   mm._YF_LAST_DATE.get(mm.UST10Y_SRC) == UST_DAYS[-1].isoformat(), mm._YF_LAST_DATE)
_SRC = (ROOT / 'macro_miner.py').read_text(encoding='utf-8')
ok('⑥e 守門的對照表 ust10y → UST10Y_SRC(對不上守門會靜默失效)', '"ust10y": UST10Y_SRC' in _SRC)
_kept = mm._apply_big_player(_o := {}, 'ust10y', {'ust10y': 'ust10y'}, 4.9, 1.0, None, '2026-11-11',
                             {'ust10y': 4.98, 'ust10y_chg_pct': 1.63, 'ust10y_date': '2026-11-12'})
ok('⑥f 備援 FRED 晚一天 → 守門保留已發佈較新的那筆', _kept is True and _o['ust10y'] == 4.98, _o)

gate, calls = make_fake_gate(treasury=R(403, '<html>Access Denied</html>'),
                             fred=R(200, 'observation_date,DGS10\n2026-11-09,4.80\n2026-11-10,4.85\n'))
mm._OFF_GATE = gate
(y10b, e10b), _ = quiet(mm.fetch_us10y_yield)
(vb, cb, eb), _ = quiet(mm.fetch_ust10y)
_tok = [w for w in _WL if w in (e10b or '')]
ok('⑦ 財政部被擋 → FRED 4.85、error 交代「備援」+ 原因(403)', y10b == 4.85 and '備援' in (e10b or '') and '403' in e10b, e10b)
ok('⑦b 那個字在 data_audit 的「有交代的降級」白名單裡(跨檔約定:值在、error 也在 ⛔ 被報成矛盾)', '備援' in _WL and _tok, _WL)
ok('⑦c 斷路:被擋之後 ⛔ 再打財政部(ust10y 用快取)', sum('treasury' in u for u in calls) == 1 and vb == 4.85 and cb == 1.04,
   (calls, vb, cb))
gate, calls = make_fake_gate(treasury=R(500, 'x'), fred=R(503, 'y'))
mm._OFF_GATE = gate
mm._YF_LAST_DATE.clear()
(y2c, e2c), _ = quiet(mm.fetch_us2y_yield)
(vc, cc, ec), _ = quiet(mm.fetch_ust10y)
ok('⑦d 兩條都壞 → 值 None、error 寫「都抓不到」+ 下一步(⛔ 混成「沒資料」)',
   y2c is None and '都抓不到' in e2c and '下一輪' in e2c and vc is None and cc is None and '都抓不到' in ec, (e2c, ec))
ok('⑦e 抓不到那輪 _YF_LAST_DATE 不留舊日期', mm.UST10Y_SRC not in mm._YF_LAST_DATE, mm._YF_LAST_DATE)
gate, calls = make_fake_gate(treasury=R(200, 'Date,"10 Yr"\n'), fred=R(200, 'observation_date,DGS10\n2026-11-12,.\n'))
mm._OFF_GATE = gate
(y10n, e10n), _ = quiet(mm.fetch_us10y_yield)
ok('⑦f 兩條都「有回應但沒有值」→ 「官方還沒有值」(安靜等,⛔ 說成抓不到)',
   y10n is None and '還沒有值' in e10n and '抓不到' not in e10n.split('・')[0], e10n)

print('⑧ macro_miner 不在模組層 import yfinance')
_probe = ('import sys, os; sys.modules["yfinance"] = None; sys.path.insert(0, sys.argv[1]); '
          'os.environ["SKIP_GLOBAL"] = "1"; import importlib.util as u; '
          's = u.spec_from_file_location("mm_probe", sys.argv[2]); m = u.module_from_spec(s); s.loader.exec_module(m); '
          'print("IMPORT_OK", callable(m.fetch_us10y_yield))')
_wd = tempfile.mkdtemp(prefix='mmimp_')
r1 = subprocess.run([sys.executable, '-c', _probe, str(ROOT), str(ROOT / 'macro_miner.py')],
                    cwd=_wd, capture_output=True, text=True, timeout=120)
ok('⑧ yfinance 載入失敗 → macro_miner 照樣 import 得起來(官方那幾格不受影響)', 'IMPORT_OK True' in r1.stdout,
   (r1.stdout[-200:], r1.stderr[-300:]))
_inj = Path(_wd) / 'macro_miner_inj.py'
_inj.write_text(_SRC.replace('import lib_official as _LO', 'import yfinance\nimport lib_official as _LO', 1), encoding='utf-8')
r2 = subprocess.run([sys.executable, '-c', _probe, str(ROOT), str(_inj)], cwd=_wd, capture_output=True, text=True, timeout=120)
ok('⑧b ⭐ 注入:把模組層 import yfinance 加回去 → 整支 import 失敗(這條測試抓得到退化)',
   'IMPORT_OK' not in r2.stdout and 'yfinance' in r2.stderr, (r2.stdout[-100:], r2.stderr[-200:]))

print('\n📊 加權 60 日位階 / radar RS 大盤基準')
mm._twii_rows = lambda get=None: ([], '本機沒有 ^TWII.json;線上都讀不到(測試)')
gate, calls = make_fake_gate()
mm._OFF_GATE = gate
YF_CALLS.clear()
pos, _ = quiet(mm.fetch_twii_position)
ok('⑨ 本機 / 已發佈都不夠 → 問證交所 4 個月,形狀 {price, pos_60d, hi_60d, lo_60d, date, src}、⛔ Yahoo',
   set(pos) == {'price', 'pos_60d', 'hi_60d', 'lo_60d', 'date', 'src'} and '證交所' in pos['src'] and not YF_CALLS
   and sum('MI_5MINS_HIST' in u for u in calls) == 4 and '/' not in pos['date'], pos)
gate, calls = make_fake_gate(twse_months_with_data=set())
mm._OFF_GATE = gate
pos2, log2 = quiet(mm.fetch_twii_position)
ok('⑨b 證交所也沒有 → {} + 印原因(⛔ Yahoo)', pos2 == {} and '證交所這幾個月沒有資料' in log2 and not YF_CALLS, log2[-200:])

tmp9 = tempfile.mkdtemp(prefix='yfoff9_')
(Path(tmp9) / 'data').mkdir()
_loc = [{'date': (T - timedelta(days=40 - i)).strftime('%Y/%m/%d'), 'close': 100.0 + i} for i in range(30)]
(Path(tmp9) / 'data' / '^TWII.json').write_text(json.dumps(_loc), encoding='utf-8')
_cwd = os.getcwd()
os.chdir(tmp9)
try:
    gate, calls = make_fake_gate()
    r9, log9 = quiet(rm._fetch_twii_ret20, _gate=gate)
    os.remove(Path('data') / '^TWII.json')
    gate2, calls2 = make_fake_gate()
    r9b, log9b = quiet(rm._fetch_twii_ret20, _gate=gate2)
    gate3, calls3 = make_fake_gate(twse_months_with_data=set())
    r9c, log9c = quiet(rm._fetch_twii_ret20, _gate=gate3)
finally:
    os.chdir(_cwd)
_c = [x['close'] for x in _loc]
ok('⑨c radar RS:本機官方 ^TWII.json 夠 → 直接算、⛔ 連網', r9 == (_c[-1] - _c[-21]) / _c[-21] * 100 and not calls, (r9, calls))
_off = sorted([(d, off_close(d)) for (y, m) in LO.recent_months(3)
               for d in wdays(date(y, m, 1), min(T, date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)))])
_oc = [x[1] for x in _off]
ok('⑨d 本機沒有 → 證交所最近 3 個月;印出用了哪一份',
   len(_oc) >= 21 and abs(r9b - (_oc[-1] - _oc[-21]) / _oc[-21] * 100) < 1e-9 and '證交所' in log9b and not YF_CALLS,
   (r9b, log9b[-200:]))
ok('⑨e 都沒有 → None + 印原因(RS 榜這輪略過)', r9c is None and '拿不到' in log9c and '證交所' in log9c, log9c[-200:])

print('\n🔍 靜態:換掉的函式裡沒有 yfinance、沒有假瀏覽器 UA')


def code_only(fn):
    s = inspect.getsource(fn)
    s = re.sub(r'"""[\s\S]*?"""', '', s)
    return re.sub(r'(?m)#.*$', '', s)


_bad = {}
for _f in (mm.fetch_us10y_yield, mm.fetch_us2y_yield, mm.fetch_ust10y, mm.fetch_twii_position, mm._off_gate,
           rm._fetch_twii_ret20, M.fetch_us_macro_cache, M._index_long_official, M._us02y_official,
           M._fetch_twii_history_official, M._index_base_rows):
    _s = code_only(_f)
    _hit = [w for w in ('yfinance', 'yf.Ticker', 'Chrome/', 'Safari/', 'HEADERS', '_rnd_hdrs', 'Referer') if w in _s]
    if _hit:
        _bad[_f.__name__] = _hit
ok('⑩ 換掉的 11 個函式:⛔ yfinance、⛔ 假瀏覽器 UA / Referer(只有 fetch_us_macro_cache 還有 yfinance —— 美股那 13 格)',
   set(_bad) <= {'fetch_us_macro_cache'} and set(_bad.get('fetch_us_macro_cache', [])) <= {'yfinance', 'yf.Ticker'}, _bad)
ok('⑩b miner 的 yfinance 清單裡 ⛔ 指數 / 13 週美債', not {'^TWII', '^TWOII', '^IRX', '^TNX'} & set(M._YF_MACRO_SYMBOLS.values()),
   M._YF_MACRO_SYMBOLS)
ok('⑩c macro_miner 模組層 ⛔ import yfinance', not re.search(r'(?m)^import yfinance|^from yfinance', _SRC))

print()
if fails:
    print(f'❌ YF_OFFICIAL_TEST_FAIL: {len(fails)} 條 → {fails}')
    sys.exit(1)
print('✅ YF_OFFICIAL_TEST_PASS')
