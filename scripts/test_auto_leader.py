#!/usr/bin/env python3
"""
👑 V77.8.9 auto_trade.py 領頭羊模組(會動真錢)—— 假券商 API 端到端測試,⛔ 不連網、不下真單
   ① 非換倉日:什麼都不做 ② 換倉日:賣掉掉出前 2N 的、買前 N 還沒有的,最多 N 檔
   ③ ⛔ 只動 st['lead'],上面那套的 st['pos'] 一個字都不動 ④ 大盤嚴格空頭:照賣、不買
   ⑤ 名單不是「今天之前最近的交易日」→ 一單都不送 ⑥ 接近漲停不追、⛔ 不往下補(同回測) ⑦ LEADER_ACCOUNT=0 不買
   ⑧ 一天只做一次 ⑨ DRY_RUN 一單都不送 ⑩ 張數 = (LEADER_ACCOUNT ÷ N) ÷ 價,再被硬煞車壓
"""
import copy, os, sys, types
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import auto_trade as A

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
    def __init__(self, px, cr=0.0): self.close, self.change_rate = px, cr
class FakeApi:
    def __init__(self, px=None, cr=None):
        self.orders = []; self.px = px or {}; self.cr = cr or {}
        self.stock_account = 'ACC'
        outer = self
        class Stocks(dict):
            def __getitem__(s, k): return k
        self.Contracts = types.SimpleNamespace(Stocks=Stocks())
    def snapshots(self, cs): return [Snap(self.px.get(cs[0], 100.0), self.cr.get(cs[0], 0.0))]
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
print(f"\n{'❌' if bad_n else '✅'} AUTO_LEADER {ok_n}/{ok_n + bad_n}")
sys.exit(1 if bad_n else 0)
