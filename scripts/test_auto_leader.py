#!/usr/bin/env python3
"""
👑 V77.8.9 auto_trade.py 領頭羊模組(會動真錢)—— 假券商 API 端到端測試,⛔ 不連網、不下真單
   ① 非換倉日:什麼都不做 ② 換倉日:賣掉掉出前 2N 的、買前 N 還沒有的,最多 N 檔
   ③ ⛔ 只動 st['lead'],上面那套的 st['pos'] 一個字都不動 ④ 大盤嚴格空頭:照賣、不買
   ⑤ 名單不是「今天之前最近的交易日」→ 一單都不送 ⑥ 接近漲停不追、⛔ 不往下補(同回測) ⑦ LEADER_ACCOUNT=0 不買
   ⑧ 一天只做一次 ⑨ DRY_RUN 一單都不送 ⑩ 張數 = (LEADER_ACCOUNT ÷ N) ÷ 價,再被硬煞車壓
"""
import copy, os, sys, tempfile, types
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
# ✂️ V82.0.7 INJECT=halfcap / notrim / nolw / nobeartop / norev → ⑱ 各自必紅(注入驗證:測試真的叫得出來)
INJ = os.environ.get('INJECT', '')
if INJ:
    _r = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    _s0 = open(os.path.join(_r, 'auto_trade.py'), encoding='utf-8').read()
    _P = {
        'halfcap': ("    full = min(int(slot // px), MAX_LOTS_PER_TRADE * 1000, int(MAX_AMT_PER_TRADE // px))\n    w = _wnum(w, 1.0)\n    want = full if w >= 1 else int(full * w + 1e-9)\n",
                    "    w = _wnum(w, 1.0)\n    full = min(int(slot * w // px), MAX_LOTS_PER_TRADE * 1000, int(MAX_AMT_PER_TRADE // px))\n    want = full\n"),
        'notrim': ("    if mode_dd == 'trim':\n        f = 1 - W / WP\n", "    if False:\n        f = 1 - W / WP\n"),
        'nolw': ("        st.setdefault('lead_w', {})[book] = W   #", "        pass   #"),
        'nobeartop': ("    if W > WP and ddtop and (_bear or _lock or LEADER_ACCOUNT <= 0):\n", "    if False:\n"),
        'norev': ("    st.setdefault('lead_w', {})[bk] = wp\n", "    pass\n"),
    }[INJ]
    assert _s0.count(_P[0]) == 1, f'注入點找不到:{INJ}'
    _tmp = tempfile.mkdtemp()
    with open(os.path.join(_tmp, 'auto_trade.py'), 'w', encoding='utf-8') as f:
        f.write(_s0.replace(*_P))
    sys.path.insert(0, _tmp)
import auto_trade as A
# ⏱️ V78.4.4 預設改 split;①~⑮ 測的是「全部開盤」那個模式(換回舊的 LEADER_WINDOW=open 仍要能用)→ 先固定成 open,split 在 ⑯ 另測
A.LEADER_WINDOW = 'open'
# 📚 V79.2.5 預設兩本帳;①~⑯ 測的是一本帳的機制(LEADER_BOOKS=1 換回舊的仍要能用)→ 先固定成 1,兩本帳在 ⑰ 另測
A.LEADER_BOOKS = 1

ok_n = bad_n = 0
def ok(name, c, extra=''):
    global ok_n, bad_n
    print(('✅ ' if c else '❌ ') + name + ('' if c else f'  {extra}'))
    ok_n, bad_n = ok_n + bool(c), bad_n + (not c)

# ── 假資料 ──
cols = ['c', 'chg', 'chg10', 'amt20', 'b20', 'b60', 'lim', 'att', 'etf', 'pos252']
def mkD(date):
    rows = {}
    for i in range(20):
        sym = str(2000 + i)
        rows[sym] = [100.0, 1.0, 30.0 - i, 100.0 - i, 3.0, 8.0, 0, 0, 0, 95.0]    # 全部過趨勢、一年位置 95%;chg10 由大到小 = 2000,2001,…
    return {'data_date': date, 'cols': cols, 'rows': rows}
TW = [{'date': d} for d in ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01',
                            '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']]
# 錨點 09-24 = 第 1 天(換倉日);第 11 個交易日 10-08 = 下一個換倉日
class Snap:
    def __init__(self, px, cr=0.0, op=None, chp=0.0): self.close, self.change_rate, self.open, self.change_price = px, cr, (px if op is None else op), chp
class FakeApi:
    def __init__(self, px=None, cr=None, op=None, chp=None):
        self.orders = []; self.px = px or {}; self.cr = cr or {}; self.op = op or {}; self.chp = chp or {}
        self.stock_account = 'ACC'
        outer = self
        class Stocks(dict):
            def __getitem__(s, k): return k
        self.Contracts = types.SimpleNamespace(Stocks=Stocks())
    def snapshots(self, cs): return [Snap(self.px.get(cs[0], 100.0), self.cr.get(cs[0], 0.0), self.op.get(cs[0]), self.chp.get(cs[0], 0.0))]
    def Order(self, **kw): return kw
    def place_order(self, contract, order): self.orders.append((contract, order)); return f'#{len(self.orders)}'
C = types.SimpleNamespace(Action=types.SimpleNamespace(Buy='B', Sell='S'), StockPriceType=types.SimpleNamespace(LMT='LMT'),
                          OrderType=types.SimpleNamespace(ROD='ROD'), StockOrderLot=types.SimpleNamespace(Common='C', IntradayOdd='O'))
sj = types.SimpleNamespace(constant=C)

def run(today, date, st=None, meta=None, acct=1_000_000, dry=False, px=None, cr=None):
    A.LEADER_ACCOUNT, A.DRY_RUN, A.MAX_LOTS_PER_TRADE, A.MAX_AMT_PER_TRADE = acct, dry, 99, 10**9
    A.save_state = lambda s: None
    A.fetch_json = lambda rel: mkD(date) if 'screener' in rel else TW
    api = FakeApi(px, cr)
    st = st if st is not None else {'pos': {'9999': {'e': 50}}, 'lead': {}}
    A.leader_step(api, sj, st, meta or {'mkt': {'bear60': False}}, today)
    buys = [c for c, o in api.orders if o['action'] == 'B']; sells = [c for c, o in api.orders if o['action'] == 'S']
    return st, buys, sells, api

# ① 名單日 09-25(第 2 天)→ 非換倉日
st, b, s, _ = run('2026-09-28', '2026-09-25')
ok('① 非換倉日(名單日是第 2 天)→ 一單都不送', not b and not s and st['lead'] == {}, (b, s))
# ② 換倉日 09-24 的下一天 09-25 執行:買前 5
st, b, s, api = run('2026-09-25', '2026-09-24')
ok('② 換倉日:買前 5 檔(2000~2004)', sorted(set(b)) == ['2000', '2001', '2002', '2003', '2004'] and sorted(st['lead']) == sorted(set(b)), b)
ok('③ ⛔ 上面那套的 st[pos] 一個字都沒動', st['pos'] == {'9999': {'e': 50}})
ok('⑩ 張數:100 萬 ÷ 5 = 20 萬、價 100 → 2,000 股 = 2 張整股(不拆零股)', all(o['quantity'] == 2 and o['order_lot'] == 'C' for c, o in api.orders), api.orders[:2])
# ② b 下一次換倉(10-08 名單 → 10-09 執行):手上 2000~2004,讓 2003/2004 掉出前 10(把它們 chg10 改成最後)
def mkD2(date):
    D = mkD(date)
    for sym in ('2003', '2004'): D['rows'][sym][2] = -99
    return D
held = {k: {'e': 100, 'd': '2026-09-25', 'sh': 2000} for k in ['2000', '2001', '2002', '2003', '2004']}
st0 = {'pos': {}, 'lead': copy.deepcopy(held)}
A.fetch_json = None
A.LEADER_ACCOUNT, A.DRY_RUN = 1_000_000, False; A.save_state = lambda s: None
A.fetch_json = lambda rel: mkD2('2026-10-08') if 'screener' in rel else TW
api2 = FakeApi(); A.leader_step(api2, sj, st0, {'mkt': {'bear60': False}}, '2026-10-09')
b2 = [c for c, o in api2.orders if o['action'] == 'B']; s2 = [c for c, o in api2.orders if o['action'] == 'S']
ok('②b 下一次換倉:賣掉掉出前 10 的 2003/2004、補買 2 檔(2005/2006),總共仍是 5 檔', sorted(s2) == ['2003', '2004'] and sorted(set(b2)) == ['2005', '2006'] and len(st0['lead']) == 5, (s2, b2, sorted(st0['lead'])))
# ④ 空頭:照賣不買
st0 = {'pos': {}, 'lead': copy.deepcopy(held)}
A.fetch_json = lambda rel: mkD2('2026-10-08') if 'screener' in rel else TW
api3 = FakeApi(); A.leader_step(api3, sj, st0, {'mkt': {'bear60': True}}, '2026-10-09')
ok('④ 大盤嚴格空頭:照賣(2003/2004)、一檔都不買', sorted(c for c, o in api3.orders if o['action'] == 'S') == ['2003', '2004'] and not [c for c, o in api3.orders if o['action'] == 'B'], api3.orders)
# ④b 🐻 V79.4.9 🔥 的空頭守門預設關(BEAR_GATE=False),👑 那一份照擋(LEADER_BEAR_GATE 預設 True)—— ⛔ 不可跟著 🔥 一起關掉
ok('④b0 預設值:🔥 BEAR_GATE 關、👑 LEADER_BEAR_GATE 開', A.BEAR_GATE is False and A.LEADER_BEAR_GATE is True, (A.BEAR_GATE, A.LEADER_BEAR_GATE))
_bg0, _lbg0 = A.BEAR_GATE, A.LEADER_BEAR_GATE
A.BEAR_GATE = False
st0 = {'pos': {}, 'lead': copy.deepcopy(held)}
A.fetch_json = lambda rel: mkD2('2026-10-08') if 'screener' in rel else TW
api3b = FakeApi(); A.leader_step(api3b, sj, st0, {'mkt': {'bear60': True}}, '2026-10-09')
ok('④b 🔥 守門關著,👑 照樣在空頭不買(照賣)', sorted(c for c, o in api3b.orders if o['action'] == 'S') == ['2003', '2004'] and not [c for c, o in api3b.orders if o['action'] == 'B'], api3b.orders)
A.LEADER_BEAR_GATE = False
st0 = {'pos': {}, 'lead': copy.deepcopy(held)}
api3c = FakeApi(); A.leader_step(api3c, sj, st0, {'mkt': {'bear60': True}}, '2026-10-09')
ok('④c 🔬 決定性對照:自己設 LEADER_BEAR_GATE=0 → 空頭也補買', sorted(set(c for c, o in api3c.orders if o['action'] == 'B')) == ['2005', '2006'], api3c.orders)
A.BEAR_GATE, A.LEADER_BEAR_GATE = _bg0, _lbg0
# ⑤ 舊名單
st, b, s, _ = run('2026-09-29', '2026-09-24')
ok('⑤ 名單日 09-24 但今天 09-29(中間還有交易日)→ ⛔ 一單都不送', not b and not s)
# ⑥ 漲停不追
st, b, s, _ = run('2026-09-25', '2026-09-24', cr={'2000': 9.9})
ok('⑥ 2000 已漲 9.9% → 不追,⛔ 也不往下補第 6 名(回測那個名額就是空著:buyL 只取前 N)→ 只買 2001~2004', '2000' not in b and sorted(set(b)) == ['2001', '2002', '2003', '2004'], b)
# ⑦ 沒設 LEADER_ACCOUNT
st, b, s, _ = run('2026-09-25', '2026-09-24', acct=0)
ok('⑦ LEADER_ACCOUNT=0 → 不買(⛔ 不猜金額)', not b)
# ⑧ 一天只做一次
st, b, s, _ = run('2026-09-25', '2026-09-24')
api4 = FakeApi(); A.leader_step(api4, sj, st, {'mkt': {'bear60': False}}, '2026-09-25')
ok('⑧ 同一天第二次呼叫 → 一單都不送', not api4.orders)
# ⑨ DRY_RUN
st, b, s, _ = run('2026-09-25', '2026-09-24', dry=True)
ok('⑨ DRY_RUN → 一單都不送、也不記部位', not b and st['lead'] == {})
# ⑩b 硬煞車
A.MAX_LOTS_PER_TRADE = 1
api5 = FakeApi(); st5 = {'pos': {}, 'lead': {}}
A.fetch_json = lambda rel: mkD('2026-09-24') if 'screener' in rel else TW
A.MAX_LOTS_PER_TRADE, A.MAX_AMT_PER_TRADE, A.LEADER_ACCOUNT, A.DRY_RUN = 1, 10**9, 1_000_000, False
A.leader_step(api5, sj, st5, {'mkt': {'bear60': False}}, '2026-09-25')
ok('⑩b MAX_LOTS_PER_TRADE=1 → 每檔最多 1,000 股(硬煞車優先於等權)', all(st5['lead'][k]['sh'] == 1000 for k in st5['lead']) and len(st5['lead']) == 5, st5['lead'])
# ⑪ V78.0.5 一年位置 ≥85 才買:2001 位置 50% → 跳過、改買第 6 名 2005;LEADER_POS=0 = 舊規則照買
def mkDp(date):
    D = mkD(date); D['rows']['2001'][9] = 50.0; D['rows']['2003'][9] = None; return D
A.MAX_LOTS_PER_TRADE, A.LEADER_ACCOUNT, A.DRY_RUN = 99, 1_000_000, False
A.fetch_json = lambda rel: mkDp('2026-09-24') if 'screener' in rel else TW
api6 = FakeApi(); st6 = {'pos': {}, 'lead': {}}; A.leader_step(api6, sj, st6, {'mkt': {'bear60': False}}, '2026-09-25')
ok('⑪ 位置 50%(2001)與沒有位置資料(2003)→ 不買、往下找 2005/2006', sorted(st6['lead']) == ['2000', '2002', '2004', '2005', '2006'], sorted(st6['lead']))
A.LEADER_POS = 0
api7 = FakeApi(); st7 = {'pos': {}, 'lead': {}}; A.leader_step(api7, sj, st7, {'mkt': {'bear60': False}}, '2026-09-25')
A.LEADER_POS = None
ok('⑫ LEADER_POS=0(換回舊規則)→ 照前 5 名買 2000~2004', sorted(st7['lead']) == ['2000', '2001', '2002', '2003', '2004'], sorted(st7['lead']))
# ⑬ 續抱不看位置:手上 2001(位置 50%)還在前 10 → 續抱不賣
A.fetch_json = lambda rel: mkDp('2026-10-08') if 'screener' in rel else TW
api8 = FakeApi(); st8 = {'pos': {}, 'lead': {'2001': {'e': 100, 'd': '2026-09-25', 'sh': 2000}}}; A.leader_step(api8, sj, st8, {'mkt': {'bear60': False}}, '2026-10-09')
ok('⑬ 續抱⛔ 不看位置:手上 2001 位置只有 50% 但還在前 10 名 → 不賣', '2001' not in [c for c, o in api8.orders if o['action'] == 'S'] and '2001' in st8['lead'], api8.orders)
# ⑭ V78.2.4 預設改成開盤買(使用者點頭;回測隔天開盤 953% / 6,783% vs 尾盤 817% / 3,342%)
import subprocess, datetime as _dt
_env = {k: v for k, v in os.environ.items() if k != 'LEADER_WINDOW'}
_root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
_w = lambda env: subprocess.run([sys.executable, '-c', 'import auto_trade as A; print(A.LEADER_WINDOW)'], cwd=_root, env=env, capture_output=True, text=True).stdout.strip()
ok('⑭a ⏱️ V78.4.4 沒設 LEADER_WINDOW → 預設 split(看開盤情況分時段)', _w(_env) == 'split', _w(_env))
ok('⑭c 設 LEADER_WINDOW=open → 換回舊的全部開盤', _w(dict(_env, LEADER_WINDOW='open')) == 'open')
ok('⑭b 設 LEADER_WINDOW=eod → 照舊尾盤', _w(dict(_env, LEADER_WINDOW='eod')) == 'eod')
# ⑮ 開盤時段:09:00 不下單、09:01 才做;第一次抓不到 → 重試;過 09:10 跳過
def clock(mins_list):
    it = iter(mins_list)
    def f():
        m = next(it); d = _dt.datetime(2026, 9, 25, m // 60, m % 60)
        return d, m, '2026-09-25'
    return f
def open_run(mins_list, fail_first=0):
    A.LEADER_ACCOUNT, A.DRY_RUN, A.MAX_LOTS_PER_TRADE, A.MAX_AMT_PER_TRADE = 1_000_000, False, 99, 10**9
    A.save_state = lambda s: None
    n = {'c': 0, 'sleep': 0}
    def fj(rel):
        if 'screener' in rel:
            n['c'] += 1
            if n['c'] <= fail_first: raise IOError('boom')
            return mkD('2026-09-24')
        return TW
    A.fetch_json = fj
    api = FakeApi(); st = {'pos': {}, 'lead': {}}
    def sl(x): n['sleep'] += 1
    r = A.leader_open_window(api, sj, st, now_fn=clock(mins_list), sleep_fn=sl, picks_fn=lambda: ({'mkt': {'bear60': False}}, []))
    return r, api, st, n
r, api, st, n = open_run([540, 541])
ok('⑮a 09:00 那一分鐘⛔ 不下單(等到 09:01 才做)', r and n['sleep'] == 1 and len(st['lead']) == 5, (r, n, sorted(st['lead'])))
r, api, st, n = open_run([541, 542], fail_first=1)
ok('⑮b ⭐ 第一次抓不到資料 → 09:10 前重試成功(拿掉重試就紅)', r and len(st['lead']) == 5 and n['c'] == 2, (r, n, sorted(st['lead'])))
r, api, st, n = open_run([551])
ok('⑮c 過了 09:10 → 那天跳過、一單都不送', r is False and not api.orders and st['lead'] == {}, (r, api.orders))
r, api, st, n = open_run([541, 542, 543, 551], fail_first=99)
ok('⑮d 一直抓不到 → 09:10 後放棄、⛔ 不下單', r is False and not api.orders, (r, n))
_src = open(os.path.join(_root, 'auto_trade.py'), encoding='utf-8').read()
ok('⑮e 尾盤那段只在 LEADER_WINDOW == eod 時做整套領頭羊(⛔ 開盤錯過不在尾盤補);open / split 都走開盤時段', "if LEADER and LEADER_WINDOW == 'eod':" in _src and "if LEADER and LEADER_WINDOW in ('open', 'split'):" in _src and 'leader_open_window(api, sj, st)' in _src)

# ⑯ ⏱️ V78.4.4 split(預設):賣 = 開盤(開低 ≥3% 延到 09:30~10:00)・買 = 13:25(開低 ≥3% 開盤買)
A.LEADER_WINDOW = 'split'
A.LEADER_ACCOUNT, A.DRY_RUN, A.MAX_LOTS_PER_TRADE, A.MAX_AMT_PER_TRADE = 1_000_000, False, 99, 10**9
A.save_state = lambda s: None
A.fetch_json = lambda rel: mkD('2026-09-24') if 'screener' in rel else TW
# 2000 開盤跌 4%(現價 96、漲跌 −4 → 參考價 100)→ 開盤就買;2001~2004 開高 1% → 延到 13:25
apiA = FakeApi(px={'2000': 96.0}, op={'2000': 96.0, '2001': 101.0, '2002': 101.0, '2003': 101.0, '2004': 101.0}, chp={'2000': -4.0})
stA = {'pos': {}, 'lead': {}}; A.leader_step(apiA, sj, stA, {'mkt': {'bear60': False}}, '2026-09-25')
bA = [c for c, o in apiA.orders if o['action'] == 'B']
ok('⑯a 開盤跌 ≥3% 的 2000 開盤就買,其他 4 檔延到 13:25(⛔ 開盤不買)', sorted(set(bA)) == ['2000'] and [x['sym'] for x in stA['lead_defer']['buy']] == ['2001', '2002', '2003', '2004'], (bA, stA.get('lead_defer')))
# 13:25:2002 接近漲停 → 不追、⛔ 不往下補
apiB = FakeApi(cr={'2002': 9.8})
A.leader_defer_step(apiB, sj, stA, '2026-09-25', 'buy')
ok('⑯b 13:25 買進延後的 2001/2003/2004(2002 接近漲停不追、不往下補),延後清單清空', sorted(set(c for c, o in apiB.orders if o['action'] == 'B')) == ['2001', '2003', '2004'] and sorted(stA['lead']) == ['2000', '2001', '2003', '2004'] and not stA['lead_defer']['buy'], (apiB.orders, stA))
# 隔天才跑到那份延後清單 → ⛔ 不買(舊名單)
stC = {'pos': {}, 'lead': {}, 'lead_defer': {'d': '2026-09-25', 'sell': [], 'buy': [{'sym': '2001', 'rank': 2, 'chg10': 29, 'att': 0}]}}
apiC = FakeApi(); A.leader_defer_step(apiC, sj, stC, '2026-09-26', 'buy')
ok('⑯c 延後的買單是前一天那份 → ⛔ 不買', not apiC.orders and not stC['lead_defer']['buy'], apiC.orders)
# 賣:2003 開低 5% → 延到 09:30;2004 開平 → 開盤就賣
A.fetch_json = lambda rel: mkD2('2026-10-08') if 'screener' in rel else TW
stD = {'pos': {}, 'lead': copy.deepcopy(held)}
apiD = FakeApi(px={'2003': 95.0}, op={'2003': 95.0, '2004': 100.0}, chp={'2003': -5.0})
A.leader_step(apiD, sj, stD, {'mkt': {'bear60': False}}, '2026-10-09')
sD = [c for c, o in apiD.orders if o['action'] == 'S']
ok('⑯d 掉出前 10:開平的 2004 開盤就賣、開低 5% 的 2003 延到 09:30~10:00(還在手上)', sD == ['2004'] and '2003' in stD['lead'] and stD['lead_defer']['sell'] == ['2003'], (sD, stD.get('lead_defer')))
# 09:30~10:00 時段:09:20 先等、09:31 賣掉
def clk(ms):
    it = iter(ms)
    def f():
        m = next(it); return _dt.datetime(2026, 10, 9, m // 60, m % 60), m, '2026-10-09'
    return f
apiE = FakeApi(); sl = []
okE = A.leader_defer_sell_window(apiE, sj, stD, now_fn=clk([560, 571]), sleep_fn=lambda x: sl.append(x))
ok('⑯e 09:20 先等(⛔ 不賣)、09:31 賣掉延後的 2003', okE and [c for c, o in apiE.orders if o['action'] == 'S'] == ['2003'] and '2003' not in stD['lead'] and len(sl) == 1, (apiE.orders, sl))
# 過了 10:00 → ⛔ 不在這段賣,留給尾盤補賣
stF = {'pos': {}, 'lead': {'2003': {'e': 100, 'sh': 1000}}, 'lead_defer': {'d': '2026-10-09', 'sell': ['2003'], 'buy': []}}
apiF = FakeApi(); okF = A.leader_defer_sell_window(apiF, sj, stF, now_fn=clk([605]), sleep_fn=lambda x: None)
ok('⑯f 過了 10:00 還沒賣成 → 這段不賣、清單留著(尾盤補賣)', okF is False and not apiF.orders and stF['lead_defer']['sell'] == ['2003'])
ok('⑯g 尾盤那段會補賣 + 13:25 才買延後的(⛔ 13:25 之前不買)', "leader_defer_step(api, sj, st, day, 'sell')" in _src and "mins >= LEADER_DEFER_BUY_FROM" in _src and "leader_defer_sell_window(api, sj, st)" in _src)
# ⑰ 📚 V79.2.5 兩本帳:第 2 本錨點 10-01(TW 第 6 天)→ 兩本⛔ 不會同一天換倉;各記各的部位、各一半錢;賣只賣自己那一本的股數
A.LEADER_WINDOW, A.LEADER_BOOKS, A.LEADER_ANCHOR2 = 'open', 2, '2026-10-01'
import lib_leader as LLm
_d = [r['date'] for r in TW]
ok('⑰a 時鐘:09-24 = 第 1 本換倉、10-01 = 第 2 本換倉、09-25 都不是;books=1 == leader_clock',
   LLm.leader_books_clock(_d, '2026-09-24', 2, ['2026-09-24', '2026-10-01'])[:3] == ('lead', 1, True)
   and LLm.leader_books_clock(_d, '2026-10-01', 2, ['2026-09-24', '2026-10-01'])[:3] == ('lead2', 1, True)
   and LLm.leader_books_clock(_d, '2026-09-25', 2, ['2026-09-24', '2026-10-01'])[2] is False
   and all(LLm.leader_books_clock(_d, d, 1, ['2026-09-24'])[1:] == LLm.leader_clock(_d, d, '2026-09-24') for d in _d))
stG = {'pos': {}, 'lead': {'2000': {'e': 100, 'sh': 2000}}, 'lead2': {}}
stG, bG, sG, apiG = run('2026-10-02', '2026-10-01', st=stG)
ok('⑰b 第 2 本換倉日:買進記在 lead2(第 1 本的 2000 照留)、每檔 = 100 萬 ÷ 10 = 1,000 股、同一檔兩本都可以有',
   sorted(stG['lead2']) == ['2000', '2001', '2002', '2003', '2004'] and stG['lead'] == {'2000': {'e': 100, 'sh': 2000}}
   and all(o['quantity'] == 1 for c, o in apiG.orders) and not sG, (stG, apiG.orders))
stH = {'pos': {}, 'lead': {'2003': {'e': 100, 'sh': 2000}}, 'lead2': {'2003': {'e': 100, 'sh': 1000}}}
A.fetch_json = lambda rel: mkD2('2026-10-01') if 'screener' in rel else TW
apiH = FakeApi(); A.leader_step(apiH, sj, stH, {'mkt': {'bear60': True}}, '2026-10-02')
sH = [(c, o['quantity'], o['order_lot']) for c, o in apiH.orders if o['action'] == 'S']
ok('⑰c 第 2 本換倉、2003 掉出前 10 → 只賣第 2 本那 1,000 股,第 1 本那 2,000 股照留(等它自己的換倉日)',
   sH == [('2003', 1, 'C')] and '2003' not in stH['lead2'] and stH['lead'] == {'2003': {'e': 100, 'sh': 2000}}, (sH, stH))
stI = {'pos': {}, 'lead': {'2003': {'e': 100, 'sh': 2000}}, 'lead2': {'2003': {'e': 100, 'sh': 1000}},
       'lead_defer': {'d': '2026-10-02', 'sell': ['2003'], 'buy': [], 'book': 'lead2'}}
apiI = FakeApi(); A.leader_defer_step(apiI, sj, stI, '2026-10-02', 'sell')
ok('⑰d 延後要賣的記得是哪一本帳(lead2)→ 只賣那 1,000 股',
   [(c, o['quantity']) for c, o in apiI.orders] == [('2003', 1)] and stI['lead'] == {'2003': {'e': 100, 'sh': 2000}} and '2003' not in stI['lead2'], apiI.orders)
ok('⑰e 每天重置狀態時 lead2 ⛔ 不可被清掉(V79.4.9 改走 reset_day:只清當天的鍵)', A.reset_day({'d': '2026-10-01', 'lead2': {'2003': {'sh': 1}}}, '2026-10-02').get('lead2') == {'2003': {'sh': 1}} and 'st = reset_day(st, today)' in _src)
A.LEADER_BOOKS = 1
A.LEADER_WINDOW = 'open'

# ⑱ ✂️ V82.0.7「跌 20% 收一半」(會動真錢):收一半中 → 留著的每檔賣一半、新買一半;回到最高點 → 補回;讀不到 → 照上一次的比例
import re as _re
_ldd = open(os.path.join(_root, 'scripts', 'lib_leaddd.mjs'), encoding='utf-8').read()
_mlv = _re.search(r"export const LEAD_DD = Object\.freeze\(\{[^}]*live: '(\d{4}-\d{2}-\d{2})'", _ldd)
ok('⑱a 開始照這條規則做的那天:auto_trade.LEADER_DD_LIVE == lib_leaddd.mjs LEAD_DD.live(跨檔比對)',
   _mlv is not None and A.LEADER_DD_LIVE == _mlv.group(1), (_mlv and _mlv.group(1), A.LEADER_DD_LIVE))
_e0 = {k: v for k, v in os.environ.items() if k != 'LEADER_DD_HALF'}
_dh = lambda env: subprocess.run([sys.executable, '-c', 'import auto_trade as A; print(A.LEADER_DD_HALF)'], cwd=_root, env=env, capture_output=True, text=True).stdout.strip()
ok('⑱a2 沒設 LEADER_DD_HALF → 預設開(使用者選的);LEADER_DD_HALF=0 → 關', _dh(_e0) == 'True' and _dh(dict(_e0, LEADER_DD_HALF='0')) == 'False', _dh(_e0))
_LIVE0, _DDH0, _LBG0 = A.LEADER_DD_LIVE, A.LEADER_DD_HALF, A.LEADER_BEAR_GATE
A.LEADER_DD_LIVE = '2026-09-01'      # 這支測試的日期都在 9~10 月
def mkDD(rows, lo=0.5, top=1):
    last = rows[-1]
    return {'v': 1, 'data_date': last[0], 'rule': {'th': 20, 'lo': lo, 'rec': 'hi', 'top': top, 'live': '2026-09-01'},
            'now': {'d': last[0], 'v': last[1], 'dd': -30.0 if last[2] else -5.0}, 'peak': {'d': '2026-07-03', 'v': 3949000},
            'def': last[2], 'since': '2026-09-15' if last[2] else None, 'w': lo if last[2] else 1, 'rot': [], 's': rows}
DD_ON = mkDD([['2026-09-30', 2100000, 1], ['2026-10-01', 2090000, 1], ['2026-10-07', 2080000, 1], ['2026-10-08', 2070000, 1]])
DD_OFF = mkDD([['2026-09-30', 2100000, 0], ['2026-10-01', 2090000, 0], ['2026-10-07', 2080000, 0], ['2026-10-08', 2070000, 0]])
DD_OLD = mkDD([['2026-10-07', 2080000, 1]])     # 檔案只到 10/07(名單日 10/08 查不到)
def sh_of(api, side):
    out = {}
    for c, o in api.orders:
        if o['action'] == side:
            out[c] = out.get(c, 0) + (o['quantity'] * 1000 if o['order_lot'] == 'C' else o['quantity'])
    return out
def ddrun(dd, st=None, bear=False, acct=1_000_000, lots=99, dry=False, half=True, ddfail=False, scr=None,
          px=None, op=None, chp=None, today='2026-10-09', date='2026-10-08'):
    A.LEADER_ACCOUNT, A.DRY_RUN, A.MAX_LOTS_PER_TRADE, A.MAX_AMT_PER_TRADE, A.LEADER_DD_HALF = acct, dry, lots, 10**9, half
    A.save_state = lambda s: None
    def fj(rel):
        if 'screener' in rel:
            return (scr or mkD2)(date)
        if 'lead_dd' in rel:
            if ddfail:
                raise IOError('404(假)')
            return copy.deepcopy(dd)
        return TW
    A.fetch_json = fj
    api = FakeApi(px, None, op, chp)
    st = st if st is not None else {'pos': {}, 'lead': copy.deepcopy(held)}
    A.leader_step(api, sj, st, {'mkt': {'bear60': bear}}, today)
    return st, api
A.LEADER_WINDOW = 'open'
# ⑱b 收一半中(第一次跑新版:之前買的都當全額)
stB, apiB = ddrun(DD_ON)
ok('⑱b 收一半中的換倉:掉出前 10 的 2003/2004 整檔賣(2,000 股)、留著的 2000/2001/2002 每檔賣一半(1,000 股)、新買 2005/2006 每檔只買一半(1,000 股)',
   sh_of(apiB, 'S') == {'2003': 2000, '2004': 2000, '2000': 1000, '2001': 1000, '2002': 1000} and sh_of(apiB, 'B') == {'2005': 1000, '2006': 1000}
   and all(stB['lead'][k]['sh'] == 1000 for k in ('2000', '2001', '2002', '2005', '2006')) and stB.get('lead_w') == {'lead': 0.5},
   (sh_of(apiB, 'S'), sh_of(apiB, 'B'), stB.get('lead_w')))
_tr = sorted(e['sym'] for e in stB.get('ord') or [] if e.get('tr'))
ok('⑱b2 委託紀錄:只有收一半那三筆標 tr(收工對帳沒成交只收回那幾股);整檔賣的 ⛔ 標', _tr == ['2000', '2001', '2002']
   and all(not e.get('tr') for e in stB['ord'] if e['sym'] in ('2003', '2004')), _tr)
# ⑱c 決定性對照:關掉 / 沒在收一半 → 跟以前一模一樣
st0, api0 = ddrun(DD_ON, half=False)
stF, apiF = ddrun(DD_OFF)
ok('⑱c 🔬 對照:LEADER_DD_HALF=0 → 只賣掉出名單的、新買全額(2,000 股),⛔ 賣一半', sh_of(api0, 'S') == {'2003': 2000, '2004': 2000}
   and sh_of(api0, 'B') == {'2005': 2000, '2006': 2000} and st0['lead']['2000']['sh'] == 2000, (sh_of(api0, 'S'), sh_of(api0, 'B')))
ok('⑱c2 🔬 對照:模型帳沒有在收一半 → 送的單跟關掉時一模一樣(逐筆)', apiF.orders == api0.orders and stF.get('lead_w') == {'lead': 1.0}, (apiF.orders, api0.orders))
# ⑱d 讀不到 / 名單那天查不到 → 照上一次的比例(⛔ 不收也不補)
stU, apiU = ddrun(DD_ON, ddfail=True)
stO, apiO = ddrun(DD_OLD)
ok('⑱d 讀不到 data/lead_dd.json / 檔案沒有名單那天 → 照上一次(沒記過 = 全額):送的單跟關掉時一模一樣',
   apiU.orders == api0.orders and apiO.orders == api0.orders and stU.get('lead_w') == {'lead': 1.0}, (sh_of(apiU, 'S'), sh_of(apiO, 'S')))
stU2, apiU2 = ddrun(DD_ON, ddfail=True, st={'pos': {}, 'lead': {k: dict(v, sh=1000) for k, v in held.items()}, 'lead_w': {'lead': 0.5}})
ok('⑱d2 讀不到、上一次是一半 → 新買照一半、⛔ 再賣一半、⛔ 補回、比例維持一半', sh_of(apiU2, 'S') == {'2003': 1000, '2004': 1000}
   and sh_of(apiU2, 'B') == {'2005': 1000, '2006': 1000} and stU2['lead']['2000']['sh'] == 1000 and stU2['lead_w'] == {'lead': 0.5},
   (sh_of(apiU2, 'S'), sh_of(apiU2, 'B')))
# ⑱e 硬煞車壓住時:一半乘在「壓過上限之後」的股數上
stE, apiE = ddrun(DD_ON, lots=1)
ok('⑱e 每筆最多 1 張:全額被壓成 1,000 股 → 一半 = 500 股(零股);⛔ 先乘一半再壓(那樣還是 1,000 股 = 沒收)',
   sh_of(apiE, 'B') == {'2005': 500, '2006': 500} and stE['lead']['2005']['sh'] == 500
   and all(o['order_lot'] == 'O' for c, o in apiE.orders if o['action'] == 'B'), sh_of(apiE, 'B'))
# ⑱f 回到最高點:留著的補回、新買全額、成本照股數加權
halfheld = {k: dict(v, sh=1000) for k, v in held.items()}
stT, apiT = ddrun(DD_OFF, st={'pos': {}, 'lead': copy.deepcopy(halfheld), 'lead_w': {'lead': 0.5}}, px={'2000': 110.0})
_e2000 = round((100 * 1000 + 110.0 * 818) / 1818, 4)
ok('⑱f 回到最高點:掉出的 2003/2004 賣、留著的補到全額(2000 價 110 → 該有 1,818 股、補 818;2001/2002 補 1,000)、新買全額、比例記回全額',
   sh_of(apiT, 'S') == {'2003': 1000, '2004': 1000} and sh_of(apiT, 'B') == {'2000': 818, '2001': 1000, '2002': 1000, '2005': 2000, '2006': 2000}
   and stT['lead']['2000']['sh'] == 1818 and stT['lead']['2000']['e'] == _e2000 and stT['lead']['2000']['d'] == '2026-09-25'
   and stT['lead_w'] == {'lead': 1.0}, (sh_of(apiT, 'B'), stT['lead'].get('2000'), stT.get('lead_w')))
# ⑱g 回到最高點但大盤嚴格空頭 → ⛔ 補、比例維持一半(等下一次換倉);決定性對照:LEADER_BEAR_GATE=0 → 照補
stG2, apiG2 = ddrun(DD_OFF, st={'pos': {}, 'lead': copy.deepcopy(halfheld), 'lead_w': {'lead': 0.5}}, bear=True)
ok('⑱g 空頭那次:照賣掉出名單的、⛔ 補回、⛔ 新買、比例維持一半', sh_of(apiG2, 'S') == {'2003': 1000, '2004': 1000} and not sh_of(apiG2, 'B')
   and stG2['lead_w'] == {'lead': 0.5} and stG2['lead']['2000']['sh'] == 1000, (sh_of(apiG2, 'B'), stG2.get('lead_w')))
A.LEADER_BEAR_GATE = False
stG3, apiG3 = ddrun(DD_OFF, st={'pos': {}, 'lead': copy.deepcopy(halfheld), 'lead_w': {'lead': 0.5}}, bear=True)
A.LEADER_BEAR_GATE = _LBG0
ok('⑱g2 🔬 對照:LEADER_BEAR_GATE=0 → 空頭也補回、比例記回全額', sh_of(apiG3, 'B').get('2001') == 1000 and stG3['lead_w'] == {'lead': 1.0}, sh_of(apiG3, 'B'))
# ⑱h 空頭也照收一半(只擋買)
stH2, apiH2 = ddrun(DD_ON, bear=True)
ok('⑱h 空頭那次換倉:賣一半照做(賣不擋)、⛔ 新買、比例記成一半', sh_of(apiH2, 'S') == {'2003': 2000, '2004': 2000, '2000': 1000, '2001': 1000, '2002': 1000}
   and not sh_of(apiH2, 'B') and stH2['lead_w'] == {'lead': 0.5}, (sh_of(apiH2, 'S'), sh_of(apiH2, 'B')))
# ⑱i split:收一半開盤跌 ≥3% → 09:30 只賣那幾股;新買 / 補回 13:25 照同一個比例
A.LEADER_WINDOW = 'split'
stI2, apiI2 = ddrun(DD_ON, px={'2000': 95.0}, op={'2000': 95.0}, chp={'2000': -5.0})
ok('⑱i split:2000 開盤跌 5% → 收一半的 1,000 股延到 09:30(⛔ 整檔);2001/2002 開盤就賣一半;新買延到 13:25、記比例一半',
   sh_of(apiI2, 'S') == {'2003': 2000, '2004': 2000, '2001': 1000, '2002': 1000} and stI2['lead_defer']['trim'] == [{'sym': '2000', 'sh': 1000}]
   and [x['sym'] for x in stI2['lead_defer']['buy']] == ['2005', '2006'] and stI2['lead_defer']['w'] == 0.5 and stI2['lead']['2000']['sh'] == 2000,
   (sh_of(apiI2, 'S'), stI2.get('lead_defer')))
apiI3 = FakeApi()
A.leader_defer_step(apiI3, sj, stI2, '2026-10-09', 'sell')
ok('⑱i2 09:30 那段:只賣 2000 的 1,000 股(留 1,000 股)、清單清空', sh_of(apiI3, 'S') == {'2000': 1000} and stI2['lead']['2000']['sh'] == 1000
   and not stI2['lead_defer']['trim'] and not A._lead_defer_sells(stI2), (sh_of(apiI3, 'S'), stI2['lead_defer']))
apiI4 = FakeApi()
A.leader_defer_step(apiI4, sj, stI2, '2026-10-09', 'buy')
ok('⑱i3 13:25 那段:新買照一半(1,000 股)', sh_of(apiI4, 'B') == {'2005': 1000, '2006': 1000}, sh_of(apiI4, 'B'))
stI5, apiI5 = ddrun(DD_OFF, st={'pos': {}, 'lead': copy.deepcopy(halfheld), 'lead_w': {'lead': 0.5}})
_top0 = [x['sym'] for x in stI5['lead_defer']['top']]
apiI6 = FakeApi()
A.leader_defer_step(apiI6, sj, stI5, '2026-10-09', 'buy')
ok('⑱i4 split 回到最高點:開盤不補、13:25 補回留著的(各補 1,000 股)+ 新買全額、清單清空',
   not sh_of(apiI5, 'B') and _top0 == ['2000', '2001', '2002'] and not stI5['lead_defer']['top']
   and sh_of(apiI6, 'B') == {'2000': 1000, '2001': 1000, '2002': 1000, '2005': 2000, '2006': 2000}, (sh_of(apiI6, 'B'), _top0))
A.LEADER_WINDOW = 'open'
# ⑱j DRY_RUN:一單都不送、比例 ⛔ 寫
stJ, apiJ = ddrun(DD_ON, dry=True)
ok('⑱j DRY_RUN → 一單都不送、部位不動、比例 ⛔ 記', not apiJ.orders and 'lead_w' not in stJ and stJ['lead']['2000']['sh'] == 2000, (apiJ.orders, stJ.get('lead_w')))
# ⑱k 兩本帳各記各的比例
A.LEADER_BOOKS, A.LEADER_ANCHOR2 = 2, '2026-10-01'
stK, apiK = ddrun(DD_ON, st={'pos': {}, 'lead': {'2000': {'e': 100, 'sh': 2000}}, 'lead2': {'2001': {'e': 100, 'sh': 1000}}, 'lead_w': {'lead': 1.0}},
                  scr=mkD, today='2026-10-02', date='2026-10-01')
ok('⑱k 兩本帳:乙帳換倉只收乙帳的(2001 賣 500 股)、新買一半(每檔 500 股)、只改乙帳的比例;甲帳一股都不動',
   sh_of(apiK, 'S') == {'2001': 500} and set(sh_of(apiK, 'B').values()) == {500} and stK['lead'] == {'2000': {'e': 100, 'sh': 2000}}
   and stK['lead_w'] == {'lead': 1.0, 'lead2': 0.5}, (sh_of(apiK, 'S'), sh_of(apiK, 'B'), stK.get('lead_w')))
A.LEADER_BOOKS = 1
# ⑱l 上次收一半沒賣掉的(rt):這次 ⛔ 再收一次;整檔賣掉 / 回到最高點 → rt 拿掉
rtheld = copy.deepcopy(held); rtheld['2000'] = {'e': 100, 'd': '2026-09-25', 'sh': 1500, 'rt': 500}; rtheld['2003'] = {'e': 100, 'd': '2026-09-25', 'sh': 1500, 'rt': 500}
stL, apiL = ddrun(DD_ON, st={'pos': {}, 'lead': copy.deepcopy(rtheld), 'lead_w': {'lead': 1.0}})
ok('⑱l 收一半中、2000 上次還有 500 股沒賣掉(rt)→ 這次 ⛔ 再收一半(交給補賣);掉出名單的 2003 整檔賣 1,500 股(含那 500)',
   '2000' not in sh_of(apiL, 'S') and sh_of(apiL, 'S').get('2003') == 1500 and '2003' not in stL['lead'] and stL['lead']['2000'].get('rt') == 500,
   (sh_of(apiL, 'S'), stL['lead'].get('2000')))
rth2 = {k: dict(v, sh=1000) for k, v in held.items()}; rth2['2000'] = {'e': 100, 'd': '2026-09-25', 'sh': 1500, 'rt': 500}
stL2, apiL2 = ddrun(DD_OFF, st={'pos': {}, 'lead': rth2, 'lead_w': {'lead': 0.5}})
ok('⑱l2 回到最高點:2000 還沒賣掉的那 500 股 ⛔ 再賣、算進要補的(只補 500)、rt 拿掉', sh_of(apiL2, 'B').get('2000') == 500
   and 'rt' not in stL2['lead']['2000'] and stL2['lead']['2000']['sh'] == 2000, (sh_of(apiL2, 'B'), stL2['lead'].get('2000')))
# ⑱m 補賣 rt:只賣那幾股
stM = {'pos': {}, 'lead': {'2000': {'e': 100, 'sh': 1500, 'rt': 500, 'm': 'sim'}}}
A.LIVE = False
apiM = FakeApi(); A.leader_retry_step(apiM, sj, stM, '2026-10-12', 'rs')
ok('⑱m0 只補賣整檔的(rs)那段 ⛔ 碰收一半的(rt)', not apiM.orders and A._has_rs(stM, ('lead',), 'rt') and not A._has_rs(stM, ('lead',), 'rs'), apiM.orders)
apiM2 = FakeApi(); A.leader_retry_step(apiM2, sj, stM, '2026-10-12', 'rt')
ok('⑱m 補賣 rt:只賣 500 股(⛔ 整檔 1,500)、留 1,000 股、rt 拿掉', sh_of(apiM2, 'S') == {'2000': 500} and stM['lead']['2000']['sh'] == 1000
   and 'rt' not in stM['lead']['2000'] and not A._has_rs(stM, ('lead',), 'all'), (sh_of(apiM2, 'S'), stM['lead']))
# ⑱n 補回沒做成(虧損安全鎖 / 隔天才跑到)→ 比例記回換倉前那個
_LL0, _AS0 = A.LOSS_LOCK_PCT, A.ACCOUNT_SIZE
A.LOSS_LOCK_PCT, A.ACCOUNT_SIZE, A.DRY_RUN, A.LEADER_ACCOUNT = 3.0, 1_000_000, False, 1_000_000
stN = {'pos': {}, 'lead': copy.deepcopy(halfheld), 'lead_w': {'lead': 1.0}, 'pnl': {'2026-10': -9_999_999},
       'lead_defer': {'d': '2026-10-09', 'sell': [], 'buy': [], 'trim': [], 'top': [{'sym': '2000', 'rank': 1, 'chg10': 30, 'att': 0}], 'book': 'lead', 'w': 1.0, 'wp': 0.5}}
apiN = FakeApi(); A.leader_defer_step(apiN, sj, stN, '2026-10-09', 'buy')
A.LOSS_LOCK_PCT, A.ACCOUNT_SIZE = _LL0, _AS0
ok('⑱n 13:25 虧損安全鎖鎖著 → ⛔ 補回、比例記回一半(下一次換倉再補)', not apiN.orders and stN['lead_w'] == {'lead': 0.5}, (apiN.orders, stN.get('lead_w')))
stN2 = {'pos': {}, 'lead': copy.deepcopy(halfheld), 'lead_w': {'lead': 1.0},
        'lead_defer': {'d': '2026-10-09', 'sell': [], 'buy': [], 'trim': [], 'top': [{'sym': '2000', 'rank': 1, 'chg10': 30, 'att': 0}], 'book': 'lead', 'w': 1.0, 'wp': 0.5}}
apiN2 = FakeApi(); A.leader_defer_step(apiN2, sj, stN2, '2026-10-12', 'buy')
ok('⑱n2 補回那份隔天才跑到 → ⛔ 用舊名單補、比例記回一半', not apiN2.orders and stN2['lead_w'] == {'lead': 0.5}, (apiN2.orders, stN2.get('lead_w')))
# ⑱o 規則 top=0(⛔ 上線的是 1):回到最高點 → 新買恢復全額、留著的 ⛔ 補
stO2, apiO2 = ddrun(mkDD(DD_OFF['s'], top=0), st={'pos': {}, 'lead': copy.deepcopy(halfheld), 'lead_w': {'lead': 0.5}})
ok('⑱o 規則 top=0:回到最高點 → 新買全額(2,000 股)、留著的 ⛔ 補、比例記回全額', sh_of(apiO2, 'B') == {'2005': 2000, '2006': 2000}
   and stO2['lead_w'] == {'lead': 1.0}, sh_of(apiO2, 'B'))
# ⑱p 名單日在開始那天之前 → 一律全額(那時候還沒有這個開關)
A.LEADER_DD_LIVE = '2026-12-01'
stP, apiP = ddrun(DD_ON)
ok('⑱p 名單日在開始照規則做的那天之前 → 跟關掉一模一樣', apiP.orders == api0.orders, sh_of(apiP, 'S'))
A.LEADER_DD_LIVE, A.LEADER_DD_HALF = _LIVE0, _DDH0
print(f"\n{'❌' if bad_n else '✅'} AUTO_LEADER {ok_n}/{ok_n + bad_n}" + (f"(INJECT={INJ})" if INJ else ''))
sys.exit(1 if bad_n else 0)
