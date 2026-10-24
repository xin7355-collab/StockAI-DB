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
   ⑧ 🔐 真實帳戶第一次跑新版:沒標模式的舊部位一律當成以前模擬帳戶留下的 → 搬到 legacy
      (⛔ 不查永豐庫存、⛔ 不自動賣、⛔ 不擋買;使用者 10/22:沒用真實帳戶跑過、模擬是拿來參考的)
      📒 模擬帳戶第一次跑新版(.sim.json 還不存在)→ 接著用以前那個檔的紀錄(⛔ 舊檔一個位元組都不動)
   ⑨ 👑 換倉日賣單只送出一部分 → 剩下的放進今天延後要賣的(split / open 都一樣;舊寫法要等到下次換倉)
   ⑩ 🅿️ 湊交割款的提醒看 🔥 + 👑 今天買的(⛔ 只看 🔥 會漏掉只有 👑 買的日子)
   ⑪ 👑 買進標模式(模擬 / 真實)、另一個模式的紀錄 ⛔ 不賣
"""
import copy, inspect, json, os, re, subprocess, sys, tempfile, types
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

# ⑧ 🔐 真實帳戶第一次跑新版:沒標模式的舊部位一律當成以前模擬帳戶留下的 → 搬到 legacy
def st8(): return {'pos': {'2330': {'e': 900.0, 'sl': 850.0, 'd': '2026-10-01', 'sh': 1485}, '2454': {'e': 1000.0, 'sl': 950.0, 'd': '2026-10-01', 'sh': 150, 'm': 'live'}},
                   'lead': {'2001': {'e': 100.0, 'd': '2026-10-01', 'sh': 2000}}, 'lead2': {}}
setv(LIVE=True)
st = st8(); LOGS.clear(); A._legacy_check(st)
ok('⑧ 真實帳戶:沒標模式的 2330(🔥)與 2001(👑)一律搬到 legacy、🚨 列出來;已標 live 的 2454 照舊管',
   '2330' not in st['pos'] and '2001' not in st['lead'] and st.get('legacy', {}).get('pos', {}).get('2330') == st8()['pos']['2330']
   and st['legacy'].get('lead', {}).get('2001') == st8()['lead']['2001'] and st['pos'].get('2454') == st8()['pos']['2454'] and st.get('mv') == 1
   and any('🚨' in x and '2330' in x and '2001' in x for x in LOGS), (st, LOGS[-1:]))
ok('⑧a 🔬 ⛔ 不查永豐庫存(舊寫法:庫存夠就當成它買的 → 你手動買的同一檔停損時被賣掉)',
   list(inspect.signature(A._legacy_check).parameters) == ['st'] and 'list_positions' not in inspect.getsource(A._legacy_check))
api = FakeApi({'2330': 800.0, '2454': 1001.0}); A.fetch_klines = lambda sym: []
A.exit_step(api, sj, st)
ok('⑧b 🔬 搬走之後跌破那筆紀錄的停損 → exit_step ⛔ 不賣 2330', not [o for c, o in api.orders if c == '2330'], api.orders)
api = FakeApi({'2330': 101.0}); st['done'] = []
A.hot_step(api, sj, st, BULL, PICKS, D)
ok('⑧c ⛔ 不擋買:2330 今天在 🔥 名單上觸發 → 照買、新紀錄標 live(搬走的那筆照留在 legacy)',
   shares(api, 'B') == 1485 and st['pos'].get('2330', {}).get('m') == 'live' and st['legacy']['pos']['2330']['sh'] == 1485, (api.orders, st))
st2 = copy.deepcopy(st); LOGS.clear(); A._legacy_check(st2)
ok('⑧d 做過一次(mv=1)→ 之後不再做(新買的 live 紀錄 ⛔ 不會被搬)', st2 == st and not any('🚨' in x for x in LOGS), st2)
setv(LIVE=False)
st = st8(); A._legacy_check(st)
ok('⑧e 模擬帳戶 → 不做(以前模擬的部位照常管)', st == st8(), st)
setv(LIVE=True)
st = {'pos': {'2454': {'e': 1, 'sh': 1, 'm': 'live'}}, 'lead': {}}; LOGS.clear(); A._legacy_check(st)
ok('⑧f 沒有舊部位 → 只記 mv=1、⛔ 不吵', st.get('mv') == 1 and 'legacy' not in st and not any('🚨' in x for x in LOGS), (st, LOGS))
setv()
# 📒 模擬帳戶第一次跑新版:接著用以前那個檔的紀錄(子程序 + 暫存 HOME,⛔ 碰不到你真的狀態檔)
LOAD = "import json, auto_trade as A; st = A.load_state(); print('@@' + json.dumps(st, ensure_ascii=False))"
def run_sub(home, code, **env):
    e = {k: v for k, v in os.environ.items() if k not in ('LIVE', 'STATE_PATH', 'DRY_RUN')}
    e.update(HOME=home, **env)
    return subprocess.check_output([sys.executable, '-c', code], cwd=ROOT, env=e, encoding='utf-8')
def loaded(out):
    return json.loads([l for l in out.splitlines() if l.startswith('@@')][-1][2:])
OLD = {'d': '2026-10-21', 'done': [], 'pos': {'2330': {'e': 900.0, 'sl': 850.0, 'd': '2026-10-01', 'sh': 1485},
                                              '2454': {'e': 1000.0, 'sl': 950.0, 'd': '2026-10-21', 'sh': 150, 'm': 'live'}},
       'lead': {}, 'legacy': {'lead': {'2001': {'e': 100.0, 'd': '2026-10-01', 'sh': 2000}}}, 'mv': 1,
       'park': {'sh': 3000, 'm': 'live'}}
with tempfile.TemporaryDirectory() as home:
    oldp, simp = os.path.join(home, '.stockai_auto_trade.json'), os.path.join(home, '.stockai_auto_trade.sim.json')
    with open(oldp, 'w', encoding='utf-8') as f:
        json.dump(OLD, f, ensure_ascii=False)
    before = open(oldp, 'rb').read()
    out = run_sub(home, LOAD); got = loaded(out)
    ok('⑧g 📒 模擬帳戶第一次跑新版(.sim.json 還不存在)→ 接著用以前那個檔的部位(以前模擬買的 ⛔ 不會一夜之間不見)',
       got.get('pos', {}).get('2330', {}).get('sh') == 1485 and '📒' in out, (got, out[-300:]))
    ok('⑧g2 真實帳戶跑過時搬到 legacy 的(= 模擬留下的)→ 放回原本那本帳;legacy / mv 拿掉',
       got.get('lead', {}).get('2001', {}).get('sh') == 2000 and 'legacy' not in got and 'mv' not in got, got)
    ok('⑧g3 標 live 的部位與 0050(真實帳戶自己買的)⛔ 不搬進模擬帳戶', '2454' not in got.get('pos', {}) and 'park' not in got, got)
    ok('⑧g4 🔬 舊檔一個位元組都沒動、只讀的時候 ⛔ 不寫任何檔', open(oldp, 'rb').read() == before and not os.path.exists(simp))
    run_sub(home, LOAD + "; A.save_state(st)")
    ok('⑧g5 之後寫進 .sim.json(舊檔照樣一個位元組都沒動)', os.path.exists(simp) and open(oldp, 'rb').read() == before
       and json.load(open(simp, encoding='utf-8')).get('pos', {}).get('2330', {}).get('sh') == 1485)
    with open(simp, 'w', encoding='utf-8') as f:
        json.dump({'pos': {'2603': {'e': 1, 'sh': 1000}}}, f)
    got = loaded(run_sub(home, LOAD))
    ok('⑧g6 .sim.json 已經有了 → 只讀它(⛔ 不再去讀舊檔)', list(got.get('pos', {})) == ['2603'], got)
    os.unlink(simp)
    got = loaded(run_sub(home, LOAD, LIVE='1'))
    ok('⑧g7 🔬 真實帳戶 → 讀原本那個檔、⛔ 不搬(legacy 照留)', 'legacy' in got and got.get('mv') == 1 and '2454' in got.get('pos', {}), got)
    got = loaded(run_sub(home, LOAD, STATE_PATH=os.path.join(home, 'my.json')))
    ok('⑧g8 自己設了 STATE_PATH → 照你設的(那個檔不存在就是空的,⛔ 不偷讀舊檔)', got == {}, got)
    ok('⑧g9 舊檔從頭到尾一個位元組都沒動', open(oldp, 'rb').read() == before)
_ms = open(os.path.join(ROOT, 'auto_trade.py'), encoding='utf-8').read()
ok('⑧h main() 每天重置之後就做(要在任何買賣之前)', re.search(r"st = reset_day\(st, today\)\n\s+_legacy_check\(st\)", _ms) is not None)
# ⑧i 🩺 10/24 巡邏:狀態檔讀不出來 ⛔ 當成空手(舊寫法回 {} → 該賣的不賣、已經有的再買一次)
with tempfile.TemporaryDirectory() as home:
    simp = os.path.join(home, '.stockai_auto_trade.sim.json')
    full = json.dumps({'pos': {'2330': {'e': 900.0, 'sl': 850.0, 'd': '2026-10-01', 'sh': 1485}}}, ensure_ascii=False)
    for name, raw in (('截斷', full[:len(full) // 2]), ('0 bytes(清空之後還沒寫進去就被關掉)', ''),
                      ('尾巴多一段', full + '}"x"}'), ('不是一份紀錄', '[1, 2]')):
        with open(simp, 'w', encoding='utf-8') as f:
            f.write(raw)
        before = open(simp, 'rb').read()
        out = run_sub(home, LOAD)
        ok(f'⑧i {name} → load_state 回 None(⛔ 回空手)、印 🚨 + 怎麼修、壞檔一個位元組都沒動',
           loaded(out) is None and '🚨' in out and '改名' in out and open(simp, 'rb').read() == before, out[-300:])
    with open(simp, 'w', encoding='utf-8') as f:
        f.write(full)
    ok('⑧i2 ⭐ 決定性對照:同一份內容完整 → 讀得到 2330(⛔ 被當成壞檔)',
       loaded(run_sub(home, LOAD)).get('pos', {}).get('2330', {}).get('sh') == 1485)
    os.unlink(simp)
    ok('⑧i3 檔案不在(第一次跑)→ 照舊空手開始', loaded(run_sub(home, LOAD)) == {})
    oldp = os.path.join(home, '.stockai_auto_trade.json')
    with open(oldp, 'w', encoding='utf-8') as f:
        f.write(full[:10])
    out = run_sub(home, LOAD)
    ok('⑧i4 模擬帳戶第一次跑新版、要接著用的以前那個檔壞了 → 一樣回 None、⛔ 寫任何檔',
       loaded(out) is None and not os.path.exists(simp) and open(oldp, encoding='utf-8').read() == full[:10], out[-300:])
    os.unlink(oldp)
    run_sub(home, "import auto_trade as A; A.save_state({'pos': {'2454': {'sh': 150}}})")
    ok('⑧j 寫狀態檔:先寫暫存檔再整個換過去(讀回來一樣、⛔ 留下 .tmp)',
       json.load(open(simp, encoding='utf-8')) == {'pos': {'2454': {'sh': 150}}} and not os.path.exists(simp + '.tmp'))
    out = run_sub(home, "import os, auto_trade as A\ndef _bad(*a, **k):\n    raise OSError('locked')\n"
                        "os.replace = _bad\nA.save_state({'pos': {'2603': {'sh': 1000}}})")
    ok('⑧j2 換名失敗(別的程式開著那個檔)→ 退回直接寫、⛔ 留下 .tmp、log 講出來',
       json.load(open(simp, encoding='utf-8')) == {'pos': {'2603': {'sh': 1000}}} and not os.path.exists(simp + '.tmp')
       and '換名失敗' in out, out[-300:])
ok('⑧k main() 讀到 None → 任何買賣之前就結束(return 1)',
   re.search(r"st = load_state\(\)\n\s+if st is None:[^\n]*\n\s+return 1", _ms) is not None)

# ⑨ 👑 換倉日賣單只送出一部分 → 剩下的今天就賣完(⛔ 等到下次換倉)
COLS = ['c', 'chg', 'chg10', 'amt20', 'b20', 'b60', 'lim', 'att', 'etf', 'pos252']
def mkD(date, out=()):
    rows = {str(2000 + i): [100.0, 1.0, (-99 if str(2000 + i) in out else 30.0 - i), 100.0 - i, 3.0, 8.0, 0, 0, 0, 95.0] for i in range(20)}
    return {'data_date': date, 'cols': COLS, 'rows': rows}
TWD = [{'date': d} for d in ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01',
                             '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']]
_LW = (A.LEADER_WINDOW, A.LEADER_BOOKS, A.LEADER_ANCHOR, A.LEADER_ACCOUNT, A.fetch_json)
A.LEADER_BOOKS, A.LEADER_ANCHOR, A.LEADER_ACCOUNT = 1, '2026-09-24', 0   # 錨點 09-24 → 10-08 名單 = 換倉日;不買(只看賣)
A.fetch_json = lambda rel: mkD('2026-10-08', out=('2003',)) if 'screener' in rel else TWD
def lead9(window, fail_lot='O', m=None):
    A.LEADER_WINDOW = window
    p3 = {'e': 100.0, 'd': '2026-09-25', 'sh': 1500, **({'m': m} if m else {})}
    st = {'pos': {}, 'lead': {'2000': {'e': 100.0, 'd': '2026-09-25', 'sh': 2000}, '2003': p3}}
    api = FakeApi({'2003': 100.0}, fail_lot=fail_lot)
    LOGS.clear(); A.leader_step(api, sj, st, BULL, '2026-10-09')
    return st, api
setv()
for w in ('split', 'open'):
    st, api = lead9(w)
    ok(f'⑨ {w}:2003 掉出前 10、賣 1500 股時零股出錯 → 已賣的 1000 股扣掉、剩 500 股放進今天延後要賣的、🚨 叫你不要自己手動賣',
       shares(api, 'S') == 1000 and st['lead'].get('2003', {}).get('sh') == 500 and (st.get('lead_defer') or {}).get('sell') == ['2003']
       and '2000' in st['lead'] and any('🚨' in x and '請不要自己手動賣' in x for x in LOGS), (w, api.orders, st, LOGS[-2:]))
    api.fail_lot = None
    A.leader_defer_step(api, sj, st, '2026-10-09', 'sell')
    ok(f'⑨b {w}:延後那段只賣剩下的 500 股(兩次合計 = 原本 1500 股)、賣完從紀錄與清單移除',
       shares(api, 'S') == 1500 and '2003' not in st['lead'] and (st.get('lead_defer') or {}).get('sell') == [], (w, api.orders, st))
st, api = lead9('split', fail_lot=None)
ok('⑨c 🔬 對照:整筆賣成功 → 不留延後要賣的', shares(api, 'S') == 1500 and '2003' not in st['lead'] and not (st.get('lead_defer') or {}).get('sell'), st)
ok('⑨d 尾盤那段不分時段都會補賣延後要賣的(延後買只有 split)',
   re.search(r"if LEADER:\n\s+_df = st\.get\('lead_defer'\) or \{\}\n\s+if _df\.get\('sell'\):", _ms) is not None
   and "if LEADER_WINDOW == 'split' and _df.get('buy') and mins >= LEADER_DEFER_BUY_FROM:" in _ms)

# ⑩ 🅿️ 只有 👑 有買的日子也要提醒湊交割款
setv()
ok('⑩ 今天花掉的錢 = 🔥 + 👑', A._today_buy({'hot_buy_amt': 100.0, 'lead_buy_amt': 50.0}) == 150.0 and A._today_buy({}) == 0)
st = {'pos': {}, 'lead_buy_amt': 200_000.0, 'park': {'sh': 3000, 'm': 'sim'}}
api = FakeApi({'0050': 0.0}); LOGS.clear()
r = A.park_step(api, sj, st, D, sleep_fn=lambda x: None)
ok('⑩b 🔬 只有 👑 買、0050 一直沒報價 → 🚨(舊寫法只看 🔥 → 只印 ⚠️)', r == 'retry' and any('🚨' in x and '湊' in x for x in LOGS), (r, LOGS))
ok('⑩c main() 兩處「程式太晚 / 收盤前還湊不到」的提醒都看 🔥 + 👑', _ms.count('_today_buy(st) > 0 and _park_has_own(st)') == 2
   and not re.search(r"float\(st\.get\('hot_buy_amt'\) or 0\) > 0 and _park_has_own", _ms))

# ⑪ 👑 買進標模式;另一個模式的紀錄 ⛔ 不賣(自己把兩個模式設成同一個狀態檔時才會遇到)
setv()
st = {'lead': {}}
A._buy_one(FakeApi({'2001': 100.0}), sj, st, st['lead'], {'sym': '2001', 'rank': 1, 'chg10': 9.0, 'att': 0}, 100.0, 150_000.0, D)
setv(LIVE=True)
A._buy_one(FakeApi({'2002': 100.0}), sj, st, st['lead'], {'sym': '2002', 'rank': 2, 'chg10': 8.0, 'att': 0}, 100.0, 150_000.0, D)
ok('⑪ 👑 買進的紀錄標模擬 / 真實(舊寫法沒標 → 兩個模式共用一個檔時互相賣)',
   st['lead']['2001'].get('m') == 'sim' and st['lead']['2002'].get('m') == 'live', st)
setv()
st, api = lead9('split', fail_lot=None, m='live')
ok('⑪b 模擬帳戶跑到換倉日、2003 掉出前 10 但那筆是真實帳戶的紀錄 → ⛔ 不賣',
   not api.orders and st['lead']['2003']['sh'] == 1500 and any('⏭️' in x and '2003' in x for x in LOGS), (api.orders, LOGS[-3:]))
st['lead_defer'] = {'d': '2026-10-09', 'sell': ['2003'], 'buy': [], 'book': 'lead'}
A.leader_defer_step(api, sj, st, '2026-10-09', 'sell')
ok('⑪c 延後要賣的那段也一樣 ⛔ 不賣另一個模式的(從清單拿掉,⛔ 不會一直重試)',
   not api.orders and st['lead']['2003']['sh'] == 1500 and st['lead_defer']['sell'] == [], (api.orders, st))
st, api = lead9('split', fail_lot=None, m='sim')
ok('⑪d 🔬 對照:同一筆標的是模擬 → 照賣', shares(api, 'S') == 1500 and '2003' not in st['lead'], (api.orders, st))
A.LEADER_WINDOW, A.LEADER_BOOKS, A.LEADER_ANCHOR, A.LEADER_ACCOUNT, A.fetch_json = _LW
setv()

for k, v in DEF.items(): setattr(A, k, v)
print(f"\n{'✅' if not bad_n else '❌'} AUTO_SEND {ok_n}/{ok_n + bad_n}")
sys.exit(1 if bad_n else 0)
