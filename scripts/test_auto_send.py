#!/usr/bin/env python3
"""
🧾 V79.4.9 auto_trade.py「送單出錯 ⛔ 不重送」+ 真實 / 模擬帳戶分開(會動真錢)—— 假永豐 API,⛔ 不連網、不下真單
   10/22 第二輪檢查代理找到的,每條都有「舊寫法必紅」的對照:
   ① `_send` 整張送出、零股出錯 → 丟 SendError 並帶著已送出的股數(整張先失敗 → 0)
   ② 🔥 hot_step:零股出錯 → 只記已送出的整張、記進今天做過的 → 下一輪 ⛔ 不再送整張(舊寫法:下一輪整筆重送 = 重複買)
   ③ 👑 _buy_one:同上(舊寫法回 fail、什麼都沒記)
   ④ 🚪 exit_step:賣單零股出錯 → 已賣出的那段從紀錄扣掉、下一輪只賣剩下的(舊寫法:下一輪整筆再賣 = 多賣);
      一股都沒送出 → 紀錄不動、下一輪再試;成功 → 紀錄移除;另一個模式買的 ⛔ 不賣
   ⑤ 👑 延後的賣單(leader_defer_step)同 ④
   ⑥ 🅿️ 今天的 0050 已經處理過 → hot_step ⛔ 不再買(再買就沒有人湊交割款)
   ⑦ 🔐 真實 / 模擬帳戶用不同的狀態檔(舊寫法同一個檔 → 互相蓋掉);自己設 STATE_PATH 就照設的
   ⑧ 🔐 真實帳戶第一次跑新版:沒標模式的舊部位跟永豐庫存對一次,對不上的搬到 legacy(⛔ 不自動賣 = 不會賣到你手動買的)
"""
import copy, os, re, subprocess, sys, types
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
import auto_trade as A

ok_n = bad_n = 0
def ok(name, c, extra=''):
    global ok_n, bad_n
    print(('✅ ' if c else '❌ ') + name + ('' if c else f'  {extra}'))
    ok_n, bad_n = ok_n + bool(c), bad_n + (not c)

class Snap:
    def __init__(self, px): self.close, self.change_rate, self.open, self.change_price = px, 0.0, px, 0.0
class Pos:
    def __init__(self, code, q): self.code, self.quantity = code, q
class FakeApi:
    """fail_lot = 'C'(整張那筆出錯)/ 'O'(零股那筆出錯)/ None;fail_n = 出錯幾次(之後就正常);inv = 永豐庫存 {代號: 股數}(None = 查不到)"""
    def __init__(self, px=None, fail_lot=None, fail_n=99, inv=None):
        self.orders = []; self.px = px or {}; self.fail_lot, self.fail_n = fail_lot, fail_n; self.inv = inv
        self.stock_account = 'ACC'
        class Stocks(dict):
            def __getitem__(s, k): return k
        self.Contracts = types.SimpleNamespace(Stocks=Stocks())
    def snapshots(self, cs): return [Snap(self.px.get(cs[0], 100.0))]
    def Order(self, **kw): return kw
    def list_positions(self, acc, unit=None):
        if self.inv is None: raise RuntimeError('查不到庫存(假)')
        return [Pos(k, v) for k, v in self.inv.items()]
    def place_order(self, contract, order):
        if self.fail_lot and order['order_lot'] == self.fail_lot and self.fail_n > 0:
            self.fail_n -= 1
            raise RuntimeError('委託失敗(假)')
        self.orders.append((contract, order)); return f'#{len(self.orders)}'
C = types.SimpleNamespace(Action=types.SimpleNamespace(Buy='B', Sell='S'), StockPriceType=types.SimpleNamespace(LMT='LMT'),
                          OrderType=types.SimpleNamespace(ROD='ROD'), StockOrderLot=types.SimpleNamespace(Common='C', IntradayOdd='O'),
                          Unit=types.SimpleNamespace(Share='Share'))
sj = types.SimpleNamespace(constant=C)
DEF = dict(DRY_RUN=A.DRY_RUN, LIVE=A.LIVE, PARK=A.PARK, ACCOUNT_SIZE=A.ACCOUNT_SIZE, POS_PCT=A.POS_PCT, MAX_LOTS_PER_TRADE=A.MAX_LOTS_PER_TRADE,
           MAX_AMT_PER_TRADE=A.MAX_AMT_PER_TRADE, MAX_PICKS=A.MAX_PICKS, BEAR_GATE=A.BEAR_GATE, LEADER_ACCOUNT=A.LEADER_ACCOUNT, fetch_klines=A.fetch_klines)
A.save_state = lambda s: None
LOGS = []
A.log = lambda *a, **k: LOGS.append(' '.join(str(x) for x in a))
def setv(**kw):
    for k, v in {**DEF, 'ACCOUNT_SIZE': 1_000_000, 'POS_PCT': 15, 'MAX_LOTS_PER_TRADE': 99, 'MAX_AMT_PER_TRADE': 10**9, 'LIVE': False, 'DRY_RUN': False, **kw}.items():
        setattr(A, k, v)
def shares(api, act):
    return sum(o['quantity'] * (1000 if o['order_lot'] == 'C' else 1) for c, o in api.orders if o['action'] == act)
D = '2026-10-22'

# ① _send
setv()
api = FakeApi(fail_lot='O'); e1 = None
try:
    A._send(api, sj, '2330', 100.0, 1485, True)
except A.SendError as e:
    e1 = e
ok('① 整張送出、零股那筆出錯 → 丟 SendError、帶著已送出 1000 股(整張那筆真的送出去了)', e1 is not None and e1.sent_sh == 1000 and shares(api, 'B') == 1000, (e1, api.orders))
api = FakeApi(fail_lot='C'); e2 = None
try:
    A._send(api, sj, '2330', 100.0, 1485, True)
except A.SendError as e:
    e2 = e
ok('①b 整張那筆就出錯 → sent_sh = 0、零股那筆 ⛔ 不送', e2 is not None and e2.sent_sh == 0 and not api.orders, (e2, api.orders))
ok('①c 全部成功 → 回兩筆委託', len(A._send(FakeApi(), sj, '2330', 100.0, 1485, True)) == 2)

# ② 🔥 hot_step:零股出錯
PICKS = [{'s': '2330', 'trig': 100.0, 'stop': 95.0}]
BULL = {'mkt': {'bear60': False}}
setv()
api = FakeApi({'2330': 101.0}, fail_lot='O'); st = {'done': [], 'pos': {}}
LOGS.clear(); A.hot_step(api, sj, st, BULL, PICKS, D)
ok('② 🔥 買 1485 股、零股那筆出錯 → 記成已買 1000 股、記進今天做過的、🚨 請到永豐 App 確認',
   shares(api, 'B') == 1000 and st['pos'].get('2330', {}).get('sh') == 1000 and '2330' in st['done']
   and abs(st.get('hot_buy_amt', 0) - 1000 * 101.0) < 1e-6 and any('🚨' in x and '1000' in x for x in LOGS), (api.orders, st, LOGS[-2:]))
A.hot_step(api, sj, st, BULL, PICKS, D)
ok('②b 🔬 下一輪 ⛔ 不再送(舊寫法:例外 → continue、沒記 done → 下一輪把整張再買一次)', shares(api, 'B') == 1000, api.orders)
api = FakeApi({'2330': 101.0}, fail_lot='C', fail_n=1); st = {'done': [], 'pos': {}}
A.hot_step(api, sj, st, BULL, PICKS, D)
ok('②c 一股都沒送出 → ⛔ 不記部位、⛔ 不記做過(下一輪可以再試)', not api.orders and st['pos'] == {} and '2330' not in st['done'], st)
A.hot_step(api, sj, st, BULL, PICKS, D)
ok('②d 下一輪再試 → 整筆買到(1485 股)', shares(api, 'B') == 1485 and st['pos']['2330']['sh'] == 1485, (api.orders, st))

# ③ 👑 _buy_one:零股出錯
setv()
api = FakeApi({'2001': 100.0}, fail_lot='O'); st = {'lead': {}}; held = st['lead']
r = A._buy_one(api, sj, st, held, {'sym': '2001', 'rank': 1, 'chg10': 9.0, 'att': 0}, 100.0, 150_500.0, D)
ok('③ 👑 買 1505 股、零股出錯 → 回 ok、記已送出的 1000 股(舊寫法回 fail 什麼都沒記 → 之後再買一次)',
   r == 'ok' and held.get('2001', {}).get('sh') == 1000 and abs(st.get('lead_buy_amt', 0) - 100_000) < 1e-6, (r, st))
api = FakeApi({'2001': 100.0}, fail_lot='C'); st = {'lead': {}}; held = st['lead']
r = A._buy_one(api, sj, st, held, {'sym': '2001', 'rank': 1, 'chg10': 9.0, 'att': 0}, 100.0, 150_500.0, D)
ok('③b 一股都沒送出 → 回 fail、⛔ 不記', r == 'fail' and held == {} and not st.get('lead_buy_amt'), (r, st))

# ④ 🚪 exit_step:停損賣出時零股出錯
setv(SELL_ENABLE=True)
A.fetch_klines = lambda sym: []   # 沒有 K 線 → 只看停損(⛔ 不連網)
POS = {'e': 100.0, 'sl': 95.0, 'd': '2026-10-01', 'sh': 1500, 'k': 'don40', 'mh': 40}
api = FakeApi({'2330': 90.0}, fail_lot='O'); st = {'pos': {'2330': dict(POS)}}
LOGS.clear(); A.exit_step(api, sj, st)
ok('④ 跌破停損、賣 1500 股時零股出錯 → 已賣的 1000 股從紀錄扣掉、剩 500 股、🚨',
   shares(api, 'S') == 1000 and st['pos'].get('2330', {}).get('sh') == 500 and any('🚨' in x and '1000' in x for x in LOGS), (api.orders, st))
api.fail_lot = None
A.exit_step(api, sj, st)
ok('④b 🔬 下一輪只賣剩下的 500 股(舊寫法:紀錄沒動 → 再賣 1500 = 多賣 1000 股),賣完紀錄移除',
   shares(api, 'S') == 1500 and '2330' not in st['pos'], (api.orders, st))
api = FakeApi({'2330': 90.0}, fail_lot='C'); st = {'pos': {'2330': dict(POS)}}
A.exit_step(api, sj, st)
ok('④c 一股都沒送出 → 紀錄原封不動(下一輪再試)', not api.orders and st['pos']['2330']['sh'] == 1500, st)
api = FakeApi({'2330': 90.0}); st = {'pos': {'2330': dict(POS)}}
A.exit_step(api, sj, st)
ok('④d 成功 → 整筆賣出、紀錄移除', shares(api, 'S') == 1500 and st['pos'] == {}, (api.orders, st))
api = FakeApi({'2330': 101.0}); st = {'pos': {'2330': dict(POS)}}
A.exit_step(api, sj, st)
ok('④e 🔬 對照:還沒到停損 → 不賣、續抱', not api.orders and st['pos']['2330']['sh'] == 1500, st)
api = FakeApi({'2330': 90.0}); st = {'pos': {'2330': dict(POS, m='live')}}
A.exit_step(api, sj, st)
ok('④f 狀態檔裡這筆是真實帳戶買的、這次是模擬 → ⛔ 不賣(反之亦然)', not api.orders and st['pos']['2330']['sh'] == 1500, st)

# ⑤ 👑 延後的賣單
setv()
st = {'lead': {'2001': {'e': 100.0, 'd': '2026-10-01', 'sh': 2500}}, 'lead_defer': {'d': D, 'sell': ['2001'], 'buy': [], 'book': 'lead'}}
api = FakeApi({'2001': 95.0}, fail_lot='O')
A.leader_defer_step(api, sj, st, D, 'sell')
ok('⑤ 👑 延後的賣單 2500 股、零股出錯 → 已賣 2000 股扣掉、剩 500 股還在「要賣」清單',
   shares(api, 'S') == 2000 and st['lead']['2001']['sh'] == 500 and st['lead_defer']['sell'] == ['2001'], (api.orders, st))
api.fail_lot = None
A.leader_defer_step(api, sj, st, D, 'sell')
ok('⑤b 🔬 下一輪只賣剩下的 500 股(兩輪合計 = 原本的 2500 股),賣完從紀錄與清單移除', shares(api, 'S') == 2500 and st['lead'] == {} and st['lead_defer']['sell'] == [], (api.orders, st))

# ⑥ 🅿️ 今天的 0050 已經處理過 → 不再買 🔥
setv()
api = FakeApi({'2330': 101.0}); st = {'done': [], 'pos': {}, 'park_day': D}
LOGS.clear(); A.hot_step(api, sj, st, BULL, PICKS, D); A.hot_step(api, sj, st, BULL, PICKS, D)
ok('⑥ 今天的 0050 已經處理過 → ⛔ 不再買 🔥(這一行只印一次)', not api.orders and sum('已經處理過' in x for x in LOGS) == 1, (api.orders, LOGS))
api = FakeApi({'2330': 101.0}); st = {'done': [], 'pos': {}, 'park_day': '2026-10-21'}
A.hot_step(api, sj, st, BULL, PICKS, D)
ok('⑥b 🔬 對照:0050 是昨天處理的 → 照買', shares(api, 'B') == 1485, api.orders)
setv(PARK=False)
api = FakeApi({'2330': 101.0}); st = {'done': [], 'pos': {}, 'park_day': D}
A.hot_step(api, sj, st, BULL, PICKS, D)
ok('⑥c PARK=0、手上沒有它買的 0050 → 不受這道擋(沒有交割款要湊)', shares(api, 'B') == 1485, api.orders)
ok('⑥d 每天第一次開要清掉「已經處理過」那行的旗標', 'hot_after_park_logged' in A.DAILY_KEYS and 'park_day' in A.DAILY_KEYS)

# ⑦ 🔐 真實 / 模擬帳戶的狀態檔
def state_path(**env):
    e = {k: v for k, v in os.environ.items() if k not in ('LIVE', 'STATE_PATH', 'DRY_RUN')}
    e.update(HOME='/tmp/fakehome', **env)
    return subprocess.check_output([sys.executable, '-c', 'import auto_trade as A; print(A.STATE_PATH)'], cwd=ROOT, env=e, encoding='utf-8').strip()
p_live, p_sim, p_own = state_path(LIVE='1'), state_path(), state_path(STATE_PATH='/x/my.json')
ok('⑦ 真實帳戶沿用原本的檔名(已經在跑的不受影響)', p_live == '/tmp/fakehome/.stockai_auto_trade.json', p_live)
ok('⑦b 🔬 模擬帳戶改用另一個檔(舊寫法兩個一樣 → 模擬買的被當成真的去賣)', p_sim == '/tmp/fakehome/.stockai_auto_trade.sim.json' and p_sim != p_live, p_sim)
ok('⑦c 自己設了 STATE_PATH → 照你設的', p_own == '/x/my.json', p_own)

# ⑧ 🔐 真實帳戶第一次跑新版:舊部位(沒標模式)跟永豐庫存對一次
def st8(): return {'pos': {'2330': {'e': 900.0, 'sl': 850.0, 'd': '2026-10-01', 'sh': 1485}, '2454': {'e': 1000.0, 'sl': 950.0, 'd': '2026-10-01', 'sh': 150, 'm': 'live'}},
                   'lead': {'2001': {'e': 100.0, 'd': '2026-10-01', 'sh': 2000}}}
setv(LIVE=True)
st = st8(); LOGS.clear(); A._legacy_check(FakeApi(inv={'2330': 0, '2001': 2000}), sj, st)
ok('⑧ 2330 紀錄 1485 股、永豐庫存 0 股 → 當成以前模擬帳戶留下的:搬到 legacy(⛔ 不自動賣)、🚨 寫出來;2001 對得上 → 標成真實照舊管',
   '2330' not in st['pos'] and st.get('legacy', {}).get('pos', {}).get('2330', {}).get('sh') == 1485 and st['lead']['2001'].get('m') == 'live'
   and st['pos']['2454'] == st8()['pos']['2454'] and st.get('mv') == 1 and any('🚨' in x and '2330' in x for x in LOGS), (st, LOGS[-1:]))
api = FakeApi({'2330': 800.0}); A.fetch_klines = lambda sym: []
A.exit_step(api, sj, st)
ok('⑧b 🔬 搬走之後 exit_step ⛔ 不賣 2330(舊寫法:跌破那筆紀錄的停損就賣 1485 股 → 賣到你手動買的)', not [o for c, o in api.orders if c == '2330'], api.orders)
st = st8(); A._legacy_check(FakeApi(inv={'2330': 3000, '2001': 2000}), sj, st)
ok('⑧c 對照:永豐庫存夠(3000 ≥ 1485)→ 標成真實、照舊管', st['pos']['2330'].get('m') == 'live' and 'legacy' not in st, st)
st = st8(); LOGS.clear(); A._legacy_check(FakeApi(inv=None), sj, st)
ok('⑧d 查不到庫存 → 這次照舊(⛔ 不搬、⛔ 不記已對過,下次再對)', st == st8() and any('查不到' in x for x in LOGS), (st, LOGS))
st = st8(); st['mv'] = 1; A._legacy_check(FakeApi(inv={}), sj, st)
ok('⑧e 對過一次(mv=1)→ 之後不再做', '2330' in st['pos'] and 'legacy' not in st, st)
setv(LIVE=False)
st = st8(); A._legacy_check(FakeApi(inv={}), sj, st)
ok('⑧f 模擬帳戶 → 不做(不動真錢)', st == st8(), st)
st = {'pos': {'2330': {'e': 1, 'sh': 1000}}, 'lead': {'2330': {'e': 1, 'sh': 1000}}}; setv(LIVE=True)
A._legacy_check(FakeApi(inv={'2330': 1500}), sj, st)
ok('⑧g 同一檔兩邊都有紀錄(合計 2000 股)、永豐只有 1500 → 兩筆都 ⛔ 不算(合計要對得上)', st['pos'] == {} and st['lead'] == {} and len(st['legacy']['pos']) == 1, st)
_ms = open(os.path.join(ROOT, 'auto_trade.py'), encoding='utf-8').read()
ok('⑧h main() 每天重置之後就對一次(要在任何買賣之前)', re.search(r"st = reset_day\(st, today\)\n\s+_legacy_check\(api, sj, st\)", _ms) is not None)
setv()

for k, v in DEF.items(): setattr(A, k, v)
print(f"\n{'✅' if not bad_n else '❌'} AUTO_SEND {ok_n}/{ok_n + bad_n}")
sys.exit(1 if bad_n else 0)
