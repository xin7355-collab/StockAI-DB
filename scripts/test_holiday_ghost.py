#!/usr/bin/env python3
"""🎑 V77.9.2 假日幽靈 K 守門

2026-09-25(中秋)、09-28(教師節)沒有開盤,MIS 卻回上一個交易日的成交 →
約 1,240 檔多出兩根收盤 = 前一天的假 K(origin/data 還有 06-19 端午、07-10 颱風)。

釘住:
 ① `_mis_is_today`:MIS 的交易日期欄 d 不是今天 → False;是今天 → True;沒有 d → None
 ② `fetch_mis_closing_snapshot` 真的有用它(假日回應 → 不補)
 ③ `_twii_calendar`:讀不到 / 不到 200 根 → None + 原因
 ④ `_holiday_ghost_dates`:加權沒那天 + 過半收盤同前一天 → 算;
    加權漏一天但個股是真交易(收盤多半不同)→ ⛔ 不算;加權最新那天之後 → ⛔ 不判;樣本 < 20 → ⛔ 不判
 ⑤ export_json 端到端:幽靈那天整天刪掉(含收盤不同的那幾根)、其他列一根不少、加權最新日之後的列不動
 ⑥ 決定性對照:export_json 拿掉「刪幽靈」那段 → ⑤ 必紅(原始碼釘住呼叫)
跑法:python3 scripts/test_holiday_ghost.py
"""
import json, os, re, sys, tempfile, datetime as _dt
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]
os.environ.pop('KLINES_DEEP_DIR', None)
import miner  # noqa: E402

FAIL = []
def ck(c, m):
    print(('✅ ' if c else '❌ ') + m)
    if not c:
        FAIL.append(m)

TW = _dt.timezone(_dt.timedelta(hours=8))
now = _dt.datetime(2026, 9, 25, 14, 0, tzinfo=TW)
# ①
ck(miner._mis_is_today({'d': '20260924', 'z': '2475'}, now) is False, '①a 假日回上一個交易日 → False')
ck(miner._mis_is_today({'d': '20260925'}, now) is True, '①b 今天的成交 → True')
ck(miner._mis_is_today({'z': '2475'}, now) is None and miner._mis_is_today({'d': '-'}, now) is None, '①c 沒有日期欄 → None(判不出來)')

# ② 假回應走真的 fetch
class _R:
    def __init__(s, j): s.j = j
    def json(s): return s.j
class _S:
    def __init__(s, msg): s.msg = msg
    def get(s, *a, **k): return _R({'msgArray': [s.msg]})
_real_sess = miner.http_session
class _FakeDT(_dt.datetime):
    @classmethod
    def now(cls, tz=None): return _dt.datetime(2026, 9, 25, 14, 0, tzinfo=tz)
_real_dt = miner.datetime
try:
    miner.datetime = _FakeDT
    base = {'z': '2475', 'v': '12990', 'o': '2480', 'h': '2490', 'l': '2470', 'y': '2500'}
    miner.http_session = _S(dict(base, d='20260924'))
    ck(miner.fetch_mis_closing_snapshot('2330') == {}, '②a 假日(d=昨天)→ 不補快照')
    miner.http_session = _S(dict(base, d='20260925'))
    snap = miner.fetch_mis_closing_snapshot('2330')
    ck(snap.get('date') == '2026/09/25' and snap.get('close') == 2475.0, '②b 今天的成交 → 照補')
finally:
    miner.datetime = _real_dt
    miner.http_session = _real_sess

# ③
tmp = tempfile.mkdtemp()
p = os.path.join(tmp, '^TWII.json')
ck(miner._twii_calendar(p)[0] is None, '③a 讀不到 → None')
d0 = _dt.date(2025, 1, 2)
days = []
d = d0
while len(days) < 260:
    if d.weekday() < 5:
        days.append(d.strftime('%Y/%m/%d'))
    d += _dt.timedelta(days=1)
json.dump([{'date': x, 'close': 1} for x in days[:150]], open(p, 'w'))
cal, lo, hi, why = miner._twii_calendar(p)
ck(cal is None and '150' in why, '③b 不到 200 根 → None + 寫出根數')

# ④ 合成:days[200] 是假日(加權沒有),days[210] 加權漏了但個股真的有交易
ghost_d, hole_d = days[200], days[210]
twii = [x for x in days[:250] if x not in (ghost_d, hole_d)]
json.dump([{'date': x, 'close': 1} for x in twii], open(p, 'w'))
cal, lo, hi, why = miner._twii_calendar(p)
ck(cal is not None and hi == days[249], '③c 夠長 → 回日期集合與範圍')
stats = {ghost_d: (100, 92), hole_d: (100, 9), days[255]: (100, 100), days[100]: (100, 5)}
g = miner._holiday_ghost_dates(stats, cal, lo, hi)
ck(ghost_d in g, '④a 加權沒開盤 + 92% 收盤同前一天 → 幽靈日')
ck(hole_d not in g, '④b 加權漏一天但個股收盤多半不同(真交易)→ ⛔ 不算')
ck(days[255] not in g, '④c 加權最新那天之後 → ⛔ 不判')
ck(days[100] not in g, '④d 加權有那天 → 不算')
ck(not miner._holiday_ghost_dates({ghost_d: (10, 10)}, cal, lo, hi), '④e 那天不到 20 檔 → ⛔ 不判')

# ⑤ export_json 端到端
db = os.path.join(tmp, 'h.db')
ddir = os.path.join(tmp, 'data'); os.makedirs(ddir)
json.dump([{'date': x, 'close': 1} for x in twii], open(os.path.join(ddir, '^TWII.json'), 'w'))
_real_db, _real_dir = miner.DB_PATH, miner.DATA_DIR
try:
    miner.DB_PATH, miner.DATA_DIR = db, ddir
    miner.init_db()
    conn = miner.get_db_conn()
    stock_days = days[190:258]   # 包含幽靈日 / 加權漏的那天 / 加權最新日之後
    syms = [f'9{i:03d}' for i in range(30)]
    for k, s in enumerate(syms):
        px = 50.0 + k
        for j, x in enumerate(stock_days):
            if x == ghost_d:
                c = px if k < 27 else px + 0.5      # 3 檔幽靈 K 收盤不同(量單位錯的那種)也要刪
            else:
                px = round(px + (0.1 if (j + k) % 2 else -0.05), 2)
                c = px
            conn.execute('INSERT INTO stock_history VALUES (?,?,?,?,?,?,?,0,0,0,0,0)',
                         (s, x.replace('/', '-'), c, c, c, c, 1000))
    conn.commit(); conn.close()
    miner.export_json()
    out = json.load(open(os.path.join(ddir, f'{syms[0]}.json')))
    ds = [r['date'] for r in out]
    ck(ghost_d not in ds, '⑤a 幽靈日被刪')
    oddk = json.load(open(os.path.join(ddir, f'{syms[28]}.json')))
    ck(ghost_d not in [r['date'] for r in oddk], '⑤b 那天收盤不同的那幾檔也一起刪(整天判定)')
    ck(hole_d in ds, '⑤c 加權漏的那天(個股真交易)保留')
    ck(days[255] in ds and days[257] in ds, '⑤d 加權最新日之後的列不動')
    ck(len(ds) == len(stock_days) - 1, f'⑤e 其他列一根不少({len(ds)} = {len(stock_days) - 1})')
finally:
    miner.DB_PATH, miner.DATA_DIR = _real_db, _real_dir

# ⑥ 原始碼釘住(剝掉 # 註解)
src = open(os.path.join(ROOT, 'miner.py'), encoding='utf-8').read()
code = '\n'.join(l.split('#')[0] if not l.strip().startswith('#') else '' for l in src.splitlines())
ex = code[code.index('def export_json'):code.index('def ', code.index('def export_json') + 10)]
ck('_holiday_ghost_dates(' in ex and "not in _ghost" in ex, '⑥a export_json 有判定並刪除幽靈日')
fm = code[code.index('def fetch_mis_closing_snapshot'):code.index('def fetch_market_institutional')]
ck('_mis_is_today(' in fm, '⑥b MIS 快照有看交易日期')

print(f"\n{'❌ ' + str(len(FAIL)) + ' 條失敗' if FAIL else '✅ 全部通過'}")
sys.exit(1 if FAIL else 0)
