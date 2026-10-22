#!/usr/bin/env python3
"""
🔥 V79.4.9 auto_trade.py `hot_step`(尾盤買進,會動真錢)—— 假永豐 API,⛔ 不連網、不下真單
   ① 🐛 已經持有的 ⛔ 不再買,原本的持倉紀錄一個字都不動(以前會重買而且蓋掉停損 / 買進日)
   ② 🐻 空頭守門預設關(BEAR_GATE=0):大盤嚴格空頭也照買 ③ 🔬 決定性對照:BEAR_GATE=1 → 一檔都不買
   ④ 沒到觸發價不買 ⑤ 今天買的金額記進 hot_buy_amt(🅿️ 收盤前要賣 0050 湊交割款)
   ⑥ DRY_RUN 不送單 ⑦ 一天最多 MAX_PICKS 檔、同一檔一天只買一次
   ⑧ fetch_picks 照 HOT_RULE 篩列 + 排序(mean 只留 r>0 照平均;lb 只留 o>0 照下界;舊格式不篩、照下界排)
   ①c 模擬帳戶買的部位擋不住真實帳戶(只認同一個模式)
"""
import copy, io, json, os, sys, types
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
import auto_trade as A

ok_n = bad_n = 0
def ok(name, c, extra=''):
    global ok_n, bad_n
    print(('✅ ' if c else '❌ ') + name + ('' if c else f'  {extra}'))
    ok_n, bad_n = ok_n + bool(c), bad_n + (not c)

class Snap:
    def __init__(self, px): self.close = px
class FakeApi:
    def __init__(self, px=None):
        self.orders = []; self.px = px or {}; self.stock_account = 'ACC'
        class Stocks(dict):
            def __getitem__(s, k): return k
        self.Contracts = types.SimpleNamespace(Stocks=Stocks())
    def snapshots(self, cs): return [Snap(self.px.get(cs[0], 100.0))]
    def Order(self, **kw): return kw
    def place_order(self, contract, order): self.orders.append((contract, order)); return f'#{len(self.orders)}'
C = types.SimpleNamespace(Action=types.SimpleNamespace(Buy='B', Sell='S'), StockPriceType=types.SimpleNamespace(LMT='LMT'),
                          OrderType=types.SimpleNamespace(ROD='ROD'), StockOrderLot=types.SimpleNamespace(Common='C', IntradayOdd='O'))
sj = types.SimpleNamespace(constant=C)
DEF = dict(BEAR_GATE=A.BEAR_GATE, DRY_RUN=A.DRY_RUN, LIVE=A.LIVE, ACCOUNT_SIZE=A.ACCOUNT_SIZE, MAX_LOTS_PER_TRADE=A.MAX_LOTS_PER_TRADE, MAX_AMT_PER_TRADE=A.MAX_AMT_PER_TRADE, MAX_PICKS=A.MAX_PICKS)
A.save_state = lambda s: None
def setv(**kw):
    for k, v in {**DEF, 'ACCOUNT_SIZE': 1_000_000, 'MAX_LOTS_PER_TRADE': 99, 'MAX_AMT_PER_TRADE': 10**9, **kw}.items():
        setattr(A, k, v)
bought = lambda api: sorted({c for c, o in api.orders if o['action'] == 'B'})
PICKS = [{'s': '2330', 'trig': 100.0, 'stop': 95.0}, {'s': '2454', 'trig': 100.0, 'stop': 95.0}, {'s': '3008', 'trig': 100.0, 'stop': 95.0}]
BULL = {'mkt': {'bear60': False}}; BEAR = {'mkt': {'bear60': True, 'd': '2026-10-21', 'c': 1, 'ma20': 2, 'ma60': 3}}

ok('⓪ 預設:🔥 空頭守門關(BEAR_GATE=0)', A.BEAR_GATE is False)
# ① 持有中不再買
setv()
api = FakeApi({'2330': 101.0, '2454': 101.0})
old = {'e': 88.0, 'sl': 80.0, 'd': '2026-10-01', 'sh': 1500, 'k': 'atr2', 'mh': 20}
st = {'done': [], 'pos': {'2330': copy.deepcopy(old)}}
A.hot_step(api, sj, st, BULL, PICKS, '2026-10-22')
ok('① 🐛 2330 已經持有 → ⛔ 不再買、原本的持倉紀錄一個字都不動;名單第 2 名照買', bought(api) == ['2454'] and st['pos']['2330'] == old and '2330' in st['done'], (bought(api), st))
ok('①b ⛔ 不往下補第 3 名(名單那一格空著,同回測)', '3008' not in bought(api))
# ①c 模擬帳戶買的部位 ⛔ 擋不住真實帳戶(反之亦然):紀錄標了 m,只認同一個模式的(10/22 檢查代理順帶;沒標的舊紀錄照舊擋)
setv(LIVE=True)
api = FakeApi({'2330': 101.0, '2454': 101.0}); st = {'done': [], 'pos': {'2330': dict(old, m='sim')}}
A.hot_step(api, sj, st, BULL, PICKS, '2026-10-22')
ok('①c 2330 那筆是模擬帳戶買的 → 真實帳戶照名單買,新紀錄標成 live', '2330' in bought(api) and st['pos']['2330'].get('m') == 'live', (bought(api), st['pos'].get('2330')))
api = FakeApi({'2330': 101.0, '2454': 101.0}); st = {'done': [], 'pos': {'2330': dict(old, m='live')}}
A.hot_step(api, sj, st, BULL, PICKS, '2026-10-22')
ok('①d 🔬 對照:同一筆標成真實帳戶買的 → 不再買', '2330' not in bought(api), bought(api))
setv(LIVE=False)
# ② 空頭照買(預設)
setv()
api = FakeApi({'2330': 101.0, '2454': 101.0}); st = {'done': [], 'pos': {}}
A.hot_step(api, sj, st, BEAR, PICKS, '2026-10-22')
ok('② 大盤嚴格空頭 + 預設 → 照買前 2 檔', bought(api) == ['2330', '2454'], bought(api))
# ③ 決定性對照
setv(BEAR_GATE=True)
api = FakeApi({'2330': 101.0, '2454': 101.0}); st = {'done': [], 'pos': {}}
A.hot_step(api, sj, st, BEAR, PICKS, '2026-10-22')
ok('③ 🔬 決定性對照:BEAR_GATE=1 → 一檔都不買', not api.orders and st.get('bear_logged') == 1, api.orders)
# ④ 沒到觸發價
setv()
api = FakeApi({'2330': 99.0, '2454': 101.0}); st = {'done': [], 'pos': {}}
A.hot_step(api, sj, st, BULL, PICKS, '2026-10-22')
ok('④ 2330 還沒漲過觸發價 → 不買;2454 照買', bought(api) == ['2454'], bought(api))
# ⑤ hot_buy_amt
setv()
api = FakeApi({'2330': 101.0, '2454': 101.0}); st = {'done': [], 'pos': {}}
A.hot_step(api, sj, st, BULL, PICKS, '2026-10-22')
exp = sum(o['quantity'] * (1000 if o['order_lot'] == 'C' else 1) * o['price'] for c, o in api.orders)
ok('⑤ 今天買的金額記進 hot_buy_amt(🅿️ 收盤前要靠它賣 0050 湊交割款)', abs(st.get('hot_buy_amt', 0) - exp) < 1e-6 and exp > 0, (st.get('hot_buy_amt'), exp))
# ⑥ DRY_RUN
setv(DRY_RUN=True)
api = FakeApi({'2330': 101.0, '2454': 101.0}); st = {'done': [], 'pos': {}}
A.hot_step(api, sj, st, BULL, PICKS, '2026-10-22')
ok('⑥ DRY_RUN:一單都不送、⛔ 不記部位', not api.orders and st['pos'] == {} and sorted(st['done']) == ['2330', '2454'], (api.orders, st))
# ⑦ 同一檔一天只買一次
setv()
api = FakeApi({'2330': 101.0, '2454': 101.0}); st = {'done': [], 'pos': {}}
A.hot_step(api, sj, st, BULL, PICKS, '2026-10-22'); n1 = len(api.orders)
A.hot_step(api, sj, st, BULL, PICKS, '2026-10-22')
ok('⑦ 第二輪(下一分鐘)⛔ 不重複下單', len(api.orders) == n1 and n1 > 0, (n1, len(api.orders)))

# ⑧ fetch_picks 照 HOT_RULE
pb = {'data_date': '2026-10-21', 'rule': 'mean', 'picks': [
    {'s': '1111', 'k': 'a', 'exp': 1.0, 'lb': 0.9, 'r': 1, 'o': 1, 'rank': 95, 'vol': 90, 'trig': 10},
    {'s': '2222', 'k': 'b', 'exp': 5.0, 'lb': 0.1, 'r': 1, 'o': 0, 'rank': 95, 'vol': 90, 'trig': 10},
    {'s': '3333', 'k': 'c', 'exp': 3.0, 'lb': 2.0, 'r': 0, 'o': 1, 'rank': 95, 'vol': 90, 'trig': 10},
]}
class R:
    def __init__(self, b): self.b = b
    def read(self): return self.b
    def __enter__(self): return self
    def __exit__(self, *a): return False
_uo = A.urllib.request.urlopen
A.urllib.request.urlopen = lambda url, timeout=20: R(json.dumps(pb).encode())
try:
    A.HOT_RULE = 'mean'; _, pm = A.fetch_picks()
    A.HOT_RULE = 'lb'; _, pl = A.fetch_picks()
    pb2 = copy.deepcopy(pb); pb2.pop('rule')
    for p in pb2['picks']: p.pop('r'); p.pop('o')
    A.urllib.request.urlopen = lambda url, timeout=20: R(json.dumps(pb2).encode())
    A.HOT_RULE = 'mean'; _, po = A.fetch_picks()
finally:
    A.urllib.request.urlopen = _uo; A.HOT_RULE = 'mean'
ok('⑧ mean:只留 r>0、照平均排(2222 5% > 1111 1%)', [p['s'] for p in pm] == ['2222', '1111'], [p['s'] for p in pm])
ok('⑧b 🔬 lb:只留 o>0、照下界排(3333 2.0 > 1111 0.9)', [p['s'] for p in pl] == ['3333', '1111'], [p['s'] for p in pl])
ok('⑧c 舊格式名單(沒有 r / o)→ 不篩', len(po) == 3, [p['s'] for p in po])
# ⑧d 🔬 舊格式名單一定照 lb 排(= 舊排法)—— 照平均會是 2222 → 3333 → 1111(兩套都不是的順序;檢查代理 10/22 抓到)
ok('⑧d 🔬 舊格式名單(沒有 r / o)在 HOT_RULE=mean 下也照 lb 排(3333 2.0 > 1111 0.9 > 2222 0.1)',
   [p['s'] for p in po] == ['3333', '1111', '2222'], [p['s'] for p in po])

for k, v in DEF.items(): setattr(A, k, v)
print(f"\n{'✅' if not bad_n else '❌'} AUTO_HOT {ok_n}/{ok_n + bad_n}")
sys.exit(1 if bad_n else 0)
