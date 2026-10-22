#!/usr/bin/env python3
"""
🅿️ V79.4.9 auto_trade.py「沒用到的錢停 0050」(會動真錢)—— 假永豐 API 端到端測試,⛔ 不連網、不下真單
   使用者 10/21:「改預設,自動下單也幫我買」+「全部停 0050,分 3 天買滿」
   ① 沒設 ACCOUNT_SIZE → 一單都不送  ② 第一天:一天最多 30 萬、整張 + 零股拆單、限價 = 現價 +1% 對到 ETF 跳動單位
   ③ 分幾天買滿(之後只補差額)④ 一天只做一次 ⑤ 只賣「自己買的」0050、賣的限價 = 現價 −1%
   ⑥ 保留現金 % ⑦ DRY_RUN 不送單也不改狀態 ⑧ ⛔ 不碰 👑(lead 的部位不算進個股市值、不下 👑 的單)
   ⑨ 每天重置狀態保留 park ⑩ 🔬 決定性對照:拿掉每日上限 → 一天買滿
   ⑪ 今天有買 🔥 → 現金不夠一定賣 0050 補(查得到 / 查不到現金兩種)⑫ 真實模式查不到現金 → 那天不買
   ⑬ 買的金額 ⛔ 超過現金 ⑭ 帳戶總資金過期(股票 + 0050 > 1.1 倍)→ 不動
   ⑮ 真實模式:狀態檔記的 0050 比永豐庫存多 → 以永豐為準 ⑯ 漲停 / 跌停夾住限價
   ⑰ 跟 App `_parkPlan` 同一個算法(跨檔比對:抽 index.html 那支用 node 跑)
   —— 🛠️ 10/22 檢查代理找到 6 條(都確認是真的),以下每條都有「舊寫法必紅」的對照 ——
   ⑲ 🚨 帳戶總資金「過期」/ PARK=0 / 沒設帳戶,只要手上有它買的 0050、今天有買股票 → 一定湊交割款
   ⑳ 0050 沒報價 → retry(⛔ 不標做完)、下一輪補;重試 3 次  ㉑ 真實帳戶 0050 買單隔天用永豐庫存差對帳(全成交 / 退單 / 部分 / 查不到庫存不買)
   ㉒ 🛡️ PARK_LIVE_OK 沒開 → 真實帳戶只預覽 ㉓ 真實帳戶的 DRY_RUN 也查現金 ㉔ 👑 要留的錢不拿去停、湊交割款也算進去
   ㉕ DRY_RUN ⛔ 不寫狀態檔 ㉖ 模擬帳戶買的 0050 ⛔ 不在真實帳戶賣 ㉗ 湊不到交割款 → 🚨 講清楚要你做什麼
"""
import copy, json, math, os, re, subprocess, sys, types
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
import auto_trade as A

ok_n = bad_n = 0
def ok(name, c, extra=''):
    global ok_n, bad_n
    print(('✅ ' if c else '❌ ') + name + ('' if c else f'  {extra}'))
    ok_n, bad_n = ok_n + bool(c), bad_n + (not c)

class Snap:
    def __init__(self, px, chp=0.0): self.close, self.change_price = px, chp
class Pos:
    def __init__(self, code, q): self.code, self.quantity = code, q
class Bal:
    def __init__(self, v, err=''): self.acc_balance, self.errmsg = v, err
class Sett:
    def __init__(self, t=0.0, t1=0.0, t2=0.0): self.t_money, self.t1_money, self.t2_money = t, t1, t2
class FakeApi:
    def __init__(self, px=None, chp=None, cash=None, sett=None, real0050=None, bal_err=False, fail_quote=0, pos_err=False):
        self.orders = []; self.px = px or {}; self.chp = chp or {}
        self.cash, self.sett, self.real0050, self.bal_err = cash, sett or [], real0050, bal_err
        self.fail_quote, self.pos_err = fail_quote, pos_err
        self.stock_account = 'ACC'
        class Stocks(dict):
            def __getitem__(s, k): return k
        self.Contracts = types.SimpleNamespace(Stocks=Stocks())
    def snapshots(self, cs):
        if cs[0] == '0050' and self.fail_quote > 0:
            self.fail_quote -= 1; raise RuntimeError('no quote')
        return [Snap(self.px.get(cs[0], 100.0), self.chp.get(cs[0], 0.0))]
    def Order(self, **kw): return kw
    def place_order(self, contract, order): self.orders.append((contract, order)); return f'#{len(self.orders)}'
    def account_balance(self):
        if self.bal_err or self.cash is None: raise RuntimeError('no balance')
        return Bal(self.cash)
    def settlements(self, acc): return self.sett
    def list_positions(self, acc, unit=None):
        if self.pos_err: raise RuntimeError('no positions')
        return [Pos('0050', self.real0050)] if self.real0050 is not None else []
C = types.SimpleNamespace(Action=types.SimpleNamespace(Buy='B', Sell='S'), StockPriceType=types.SimpleNamespace(LMT='LMT'),
                          OrderType=types.SimpleNamespace(ROD='ROD'), StockOrderLot=types.SimpleNamespace(Common='C', IntradayOdd='O'),
                          Unit=types.SimpleNamespace(Share='Share', Common='Common'))
sj = types.SimpleNamespace(constant=C)

DEF = dict(ACCOUNT_SIZE=A.ACCOUNT_SIZE, PARK=A.PARK, PARK_RESERVE_PCT=A.PARK_RESERVE_PCT, PARK_MAX_AMT_PER_DAY=A.PARK_MAX_AMT_PER_DAY,
           PARK_MIN_TRADE_PCT=A.PARK_MIN_TRADE_PCT, DRY_RUN=A.DRY_RUN, LIVE=A.LIVE, PARK_LIVE_OK=A.PARK_LIVE_OK,
           LEADER=A.LEADER, LEADER_ACCOUNT=A.LEADER_ACCOUNT)
ok('⓪ 預設值:PARK 開、保留 0%、一天最多 30 萬、差距 2%、13:27、ETF 0050', A.PARK is True and A.PARK_RESERVE_PCT == 0 and A.PARK_MAX_AMT_PER_DAY == 300000
   and A.PARK_MIN_TRADE_PCT == 2 and A.PARK_AT == 13 * 60 + 27 and A.PARK_SYM == '0050', DEF)

def setv(**kw):
    for k, v in {**DEF, 'ACCOUNT_SIZE': 1_000_000, 'LIVE': False, 'DRY_RUN': False, **kw}.items():
        setattr(A, k, v)
_REAL_SAVE = A.save_state   # ㉕ 用:真的寫檔那一支
A.save_state = lambda s: None
LOGS = []
A.log = lambda *a, **k: LOGS.append(' '.join(str(x) for x in a))
def qty(api, act=None):
    return [(c, o['quantity'], o['order_lot'], o['price'], o['action']) for c, o in api.orders if act is None or o['action'] == act]
def shares(api, act):
    return sum(q * (1000 if lot == 'C' else 1) for c, q, lot, p, a in qty(api, act))

# ① 沒設帳戶
setv(ACCOUNT_SIZE=0)
api = FakeApi({'0050': 200.0}); st = {'pos': {}, 'park': {}}
r = A.park_step(api, sj, st, '2026-10-22')
ok('① 沒設 ACCOUNT_SIZE → 一單都不送(⛔ 不猜你有多少錢)', r == 'none' and not api.orders, (r, api.orders))

# ② 第一天:一天最多 30 萬
setv()
api = FakeApi({'0050': 200.0}, cash=2_000_000); st = {'pos': {}, 'park': {}}
r = A.park_step(api, sj, st, '2026-10-22')
bp = A._park_limits(200.0, 200.0)[0]
ok('② 第一天:買 30 萬以內、整張一筆 + 零股一筆、限價 = 現價 +1% 進位到 0.05', r == 'buy' and bp == 202.0
   and qty(api) == [('0050', 1, 'C', 202.0, 'B'), ('0050', 485, 'O', 202.0, 'B')] and st['park']['sh'] == 1485, (r, qty(api), st))
# ③ 分幾天買滿
days = ['2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28']
st = {'pos': {}, 'park': {}}; log_sh = []
for d in days:
    api = FakeApi({'0050': 200.0}, cash=2_000_000)
    A.park_step(api, sj, st, d); log_sh.append(st['park'].get('sh', 0))
ok('③ 分幾天買滿:每天最多 30 萬,之後只補差額;差距 < 2% 就不再動', log_sh[:3] == [1485, 2970, 4455] and log_sh[3] > 4455 and log_sh[4] == log_sh[3]
   and abs(1_000_000 - log_sh[3] * 200) < 20_000, log_sh)
# ④ 一天一次
api = FakeApi({'0050': 200.0}, cash=2_000_000); st = {'pos': {}, 'park': {}}
A.park_step(api, sj, st, '2026-10-22'); n1 = len(api.orders)
r2 = A.park_step(api, sj, st, '2026-10-22')
ok('④ 同一天第二次 → ⛔ 不再動', r2 == 'done' and len(api.orders) == n1, (r2, len(api.orders)))

# ⑤ 只賣自己買的(帳戶 100 萬、自己的 0050 4,000 股、今天以前買的個股市值 30 萬 → 目標 70 萬 → 賣約 10 萬)
setv()
api = FakeApi({'0050': 200.0, '2330': 1000.0}, cash=0)
st = {'pos': {'2330': {'sh': 300, 'e': 900}}, 'park': {'sh': 4000}}
r = A.park_step(api, sj, st, '2026-10-22')
sp = A._park_limits(200.0, 200.0)[1]
ok('⑤ 賣:只賣多出來的(約 10 萬)、限價 = 現價 −1% 捨去到 0.05、⛔ 只賣 0050', r == 'sell' and sp == 198.0 and shares(api, 'S') == math.ceil(100000 / 198.0)
   and all(c == '0050' for c, *_ in qty(api)) and st['park']['sh'] == 4000 - math.ceil(100000 / 198.0), (r, qty(api), st))
#  帳戶 100 萬、個股已經 100 萬(目標 0)、自己的 0050 只有 100 股(2 萬)→ 算出來要賣 102 股,但只賣得到自己的 100 股
st = {'pos': {'2330': {'sh': 1000, 'e': 900}}, 'park': {'sh': 100}}
api = FakeApi({'0050': 200.0, '2330': 1000.0}, cash=0)
A.park_step(api, sj, st, '2026-10-22')
ok('⑤b 自己的 0050 只剩 100 股 → 最多賣 100 股(⛔ 不碰手動買的)', shares(api, 'S') == 100 and st['park']['sh'] == 0, (qty(api), st))

# ⑥ 保留現金 %
setv(PARK_RESERVE_PCT=10, PARK_MAX_AMT_PER_DAY=10**9)
api = FakeApi({'0050': 200.0}, cash=2_000_000); st = {'pos': {}, 'park': {}}
A.park_step(api, sj, st, '2026-10-22')
ok('⑥ 保留 10% → 只停約 90 萬', abs(shares(api, 'B') * 202.0 - 900_000) < 202, shares(api, 'B'))

# ⑦ DRY_RUN
setv(DRY_RUN=True)
api = FakeApi({'0050': 200.0}, cash=2_000_000); st = {'pos': {}, 'park': {'sh': 7}}
r = A.park_step(api, sj, st, '2026-10-22')
ok('⑦ DRY_RUN:一單都不送、⛔ 不改自己的 0050 股數', r == 'buy' and not api.orders and st['park']['sh'] == 7, (r, api.orders, st))

# ⑧ ⛔ 不碰 👑
setv()
api = FakeApi({'0050': 200.0, '2001': 100.0}, cash=2_000_000)
st = {'pos': {}, 'lead': {'2001': {'sh': 5000, 'e': 100}}, 'park': {}}
A.park_step(api, sj, st, '2026-10-22')
ok('⑧ 👑 的部位(lead)⛔ 不算進個股市值、⛔ 不下 👑 的單', all(c == '0050' for c, *_ in qty(api)) and shares(api, 'B') == 1485 and st['lead'] == {'2001': {'sh': 5000, 'e': 100}}, (qty(api), st))

# ⑨ 每天重置狀態保留 park
st0 = {'d': '2026-10-21', 'done': ['2330'], 'pos': {'2330': {'sh': 1}}, 'park': {'sh': 4455}, 'park_day': '2026-10-21', 'hot_buy_amt': 5, 'lead_day': '2026-10-20', 'future_key': {'x': 1}}
st1 = A.reset_day(copy.deepcopy(st0), '2026-10-22')
ok('⑨ 每天重置:清掉 done / park_day / hot_buy_amt,保留 pos / park / lead_day / 之後新加的鍵', st1['done'] == [] and 'park_day' not in st1 and 'hot_buy_amt' not in st1
   and st1['park'] == {'sh': 4455} and st1['pos'] == st0['pos'] and st1['lead_day'] == '2026-10-20' and st1['future_key'] == {'x': 1} and st1['d'] == '2026-10-22', st1)
ok('⑨b 同一天再呼叫 → 原封不動', A.reset_day(st0, '2026-10-21') is st0)
_src = open(os.path.join(ROOT, 'auto_trade.py'), encoding='utf-8').read()
ok('⑨c main() 每天重置一律走 reset_day(⛔ 不可再手寫一份「要留哪些鍵」)', 'st = reset_day(st, today)' in _src and "st = {'d': today, 'done': []" not in _src)

# ⑩ 決定性對照:拿掉每日上限
setv(PARK_MAX_AMT_PER_DAY=10**9)
api = FakeApi({'0050': 200.0}, cash=2_000_000); st = {'pos': {}, 'park': {}}
A.park_step(api, sj, st, '2026-10-22')
ok('⑩ 🔬 決定性對照:拿掉每日上限 → 一天就買滿(證明 ② 的 30 萬真的是上限在擋)', shares(api, 'B') == int((1_000_000 - 10_000) // 202.0) or shares(api, 'B') == int(1_000_000 // 202.0) - 0, shares(api, 'B'))

# ⑪ 今天有買 🔥 → 現金不夠一定賣 0050 補交割款
setv()
#  帳戶 100 萬:0050 4,950 股(99 萬)+ 今天買的個股 1.5 萬 → 目標 98.5 萬,差 5 千(< 2%,本來不動)
st = {'pos': {'2330': {'sh': 15, 'e': 1000}}, 'park': {'sh': 4950}, 'hot_buy_amt': 15000.0}
api = FakeApi({'0050': 200.0, '2330': 1000.0}, cash=10_000)
r = A.park_step(api, sj, st, '2026-10-22')
ok('⑪ 差距在 2% 內,但現金 1 萬 < 今天買的 1.5 萬 + 緩衝 1 萬 → 一定賣 0050 補到還剩 1% 緩衝(約 1.5 萬;手續費從緩衝付)',
   r == 'sell' and shares(api, 'S') == math.ceil(15000 / 198.0), (r, qty(api)))
st = {'pos': {'2330': {'sh': 15, 'e': 1000}}, 'park': {'sh': 4950}, 'hot_buy_amt': 15000.0}
api = FakeApi({'0050': 200.0, '2330': 1000.0}, bal_err=True)
r = A.park_step(api, sj, st, '2026-10-22')
ok('⑪b 查不到現金 → 今天買的全部用賣 0050 支應(保守)', r == 'sell' and shares(api, 'S') == math.ceil(15000 / 198.0), (r, qty(api)))
st = {'pos': {'2330': {'sh': 15, 'e': 1000}}, 'park': {'sh': 4950}, 'hot_buy_amt': 15000.0}
api = FakeApi({'0050': 200.0, '2330': 1000.0}, cash=50_000)
r = A.park_step(api, sj, st, '2026-10-22')
ok('⑪c 🔬 對照:現金夠付 → 不賣', r == 'ok' and not api.orders, (r, qty(api)))
st = {'pos': {'2330': {'sh': 15, 'e': 1000}}, 'park': {'sh': 4950}, 'hot_buy_amt': 15000.0}
api = FakeApi({'0050': 200.0, '2330': 1000.0}, cash=50_000, sett=[Sett(t=0, t1=-30_000, t2=-25_000)])
r = A.park_step(api, sj, st, '2026-10-22')
ok('⑪d 還沒付的交割款要扣(5 萬 − 5.5 萬 = −5 千 → 要付 1.5 萬 + 緩衝 1 萬 → 賣約 3 萬)', r == 'sell' and shares(api, 'S') == math.ceil(30000 / 198.0), (r, qty(api)))

# ⑫ 真實模式查不到現金 → 那天不買
setv(LIVE=True)
api = FakeApi({'0050': 200.0}, bal_err=True); st = {'pos': {}, 'park': {}}
r = A.park_step(api, sj, st, '2026-10-22')
ok('⑫ 真實模式查不到交割戶現金 → 今天⛔ 不買 0050', r == 'nocash' and not api.orders, (r, api.orders))

# ⑬ 買的金額不超過現金(留帳戶 1% 緩衝)
setv()
api = FakeApi({'0050': 200.0}, cash=100_000); st = {'pos': {}, 'park': {}}
A.park_step(api, sj, st, '2026-10-22')
ok('⑬ 現金只有 10 萬 → 只買 (10 萬 − 1 萬緩衝) ÷ 202 股', shares(api, 'B') == int(90_000 // 202.0), shares(api, 'B'))
st = {'pos': {}, 'park': {}, 'lead_buy_amt': 50_000.0}
api = FakeApi({'0050': 200.0}, cash=100_000)
A.park_step(api, sj, st, '2026-10-22')
ok('⑬b 今天 👑 也花了 5 萬 → 現金再扣掉', shares(api, 'B') == int(40_000 // 202.0), shares(api, 'B'))

# ⑭ 帳戶總資金過期
api = FakeApi({'0050': 200.0, '2330': 1000.0}, cash=2_000_000)
st = {'pos': {'2330': {'sh': 800, 'e': 900}}, 'park': {'sh': 2000}}
r = A.park_step(api, sj, st, '2026-10-22')
ok('⑭ 股票 80 萬 + 0050 40 萬 > 帳戶 100 萬 ×1.1 → 帳戶總資金過期,⛔ 不買也不賣', r == 'stale' and not api.orders, (r, api.orders))

# ⑮ 真實模式:永豐庫存比狀態檔少 → 以永豐為準
setv(LIVE=True)
api = FakeApi({'0050': 200.0, '2330': 1000.0}, cash=0, real0050=1000)
st = {'pos': {'2330': {'sh': 300, 'e': 900}}, 'park': {'sh': 4000}}
r = A.park_step(api, sj, st, '2026-10-22')
ok('⑮ 狀態檔 4,000 股、永豐只有 1,000 股 → 最多賣 1,000 股、狀態檔改成實際', shares(api, 'S') <= 1000 and st['park']['sh'] == 1000 - shares(api, 'S'), (qty(api), st))

# ⑯ 漲停 / 跌停夾住
b, s = A._park_limits(220.0, 200.0)
ok('⑯ 限價不超過漲停(200×1.1=220)、不低於跌停(180)', b == 220.0 and A._park_limits(181.0, 200.0)[1] == 180.0, (b, A._park_limits(181.0, 200.0)))
ok('⑯b ETF 跳動單位:未滿 50 元 0.01、50 元以上 0.05', A._etf_tick(49.99) == 0.01 and A._etf_tick(50) == 0.05 and A._park_limits(30.0, 30.0) == (30.3, 29.7))

# ⑰ 跟 App `_parkPlan` 同一個算法(抽 index.html 那支用 node 跑)
setv()
IDX = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
m = re.search(r"\n    _parkPlan\(S\) \{\n([\s\S]*?)\n    \},", IDX)
ok('⑰0 抽得到 App 的 `_parkPlan`', bool(m))
if m:
    body = m.group(1)
    cases = [(1_000_000, 0, 0), (1_000_000, 300_000, 800_000), (1_000_000, 150_000, 840_000), (1_000_000, 500_000, 495_000), (2_500_000, 1_200_000, 100_000)]
    js = "const f = function(S){" + body.replace('S = S || this._leadSlot();', '') + "};\n" \
         + "console.log(JSON.stringify(" + json.dumps([{'acc': a, 'stock': b, 'park': c} for a, b, c in cases]) + ".map(S => f(S))));"
    out = json.loads(subprocess.check_output(['node', '-e', js], encoding='utf-8'))
    py = [A.park_plan(a, b, c, 0, 2) for a, b, c in cases]
    same = all(abs(o['target'] - p[0]) < 1e-6 and abs(o['diff'] - p[1]) < 1e-6 and o['act'] == p[2] for o, p in zip(out, py))
    ok('⑰ App `_parkPlan` == auto_trade `park_plan`(目標 / 差額 / 買賣不動 五組)', same, (out, py))

# ═══ 🛠️ 10/22 檢查代理找到的 6 條(每條都有舊寫法必紅的對照)═══
D = '2026-10-22'
# ⑲ 🚨 過期 + 一天買兩檔:舊寫法回 'stale'、⛔ 一股都沒賣 → T+2 交割款差約 19 萬(違約交割)
setv()
def st19(): return {'pos': {'2330': {'sh': 300, 'e': 1000}, '1111': {'sh': 1000, 'e': 100, 'd': D}, '2222': {'sh': 1000, 'e': 100, 'd': D}},
                    'park': {'sh': 3450}, 'hot_buy_amt': 200_000.0}
P19 = {'0050': 200.0, '2330': 1000.0, '1111': 100.0, '2222': 100.0}
st = st19(); api = FakeApi(P19, cash=10_000)
r = A.park_step(api, sj, st, D)
ok('⑲ 🚨 股票 50 萬 + 0050 69 萬 > 帳戶 1.1 倍(看起來「過期」),今天買了 20 萬 → 一定賣 0050 湊交割款(20 萬 + 緩衝 1 萬 − 現金 1 萬)',
   r == 'sell' and shares(api, 'S') == math.ceil(200_000 / 198.0) and st['park']['sh'] == 3450 - math.ceil(200_000 / 198.0), (r, qty(api), st['park']))
setv(PARK=False)
st = st19(); api = FakeApi(P19, cash=10_000)
r = A.park_step(api, sj, st, D)
ok('⑲b PARK=0 但手上還有它買的 0050 → 今天有買股票照樣湊交割款(⛔ 只是不再補買)', r == 'sell' and shares(api, 'S') == math.ceil(200_000 / 198.0), (r, qty(api)))
st = {'pos': {}, 'park': {}, 'hot_buy_amt': 50_000.0}; api = FakeApi({'0050': 200.0}, cash=0)
r = A.park_step(api, sj, st, D)
ok('⑲c PARK=0、手上沒有它買的 0050 → 完全不動', r == 'off' and not api.orders, (r, api.orders))
setv(ACCOUNT_SIZE=0)
st = {'pos': {'1111': {'sh': 1000, 'e': 100}}, 'park': {'sh': 1000}, 'hot_buy_amt': 100_000.0}
api = FakeApi({'0050': 200.0, '1111': 100.0}, cash=20_000)
r = A.park_step(api, sj, st, D)
ok('⑲d 沒設 ACCOUNT_SIZE 但手上有它買的 0050 → 照樣湊交割款(差 8 萬)', r == 'sell' and shares(api, 'S') == math.ceil(80_000 / 198.0), (r, qty(api)))
setv()
st = {'pos': {'1111': {'sh': 1000, 'e': 100}}, 'park': {'sh': 4000}}
api = FakeApi({'0050': 200.0, '1111': 100.0}, cash=5_000)
r = A.park_step(api, sj, st, D)
ok('⑲e 今天沒買東西、現金略低於緩衝 → ⛔ 不賣(不然會天天小額來回)', not [x for x in qty(api) if x[4] == 'S'], qty(api))

# ⑳ 0050 沒報價 → retry、⛔ 不標做完;下一輪補
st = {'pos': {'1111': {'sh': 1000, 'e': 100}}, 'park': {'sh': 3000}, 'hot_buy_amt': 100_000.0}
api = FakeApi({'0050': 200.0, '1111': 100.0}, cash=10_000, fail_quote=99)
r = A.park_step(api, sj, st, D, sleep_fn=lambda s: None)
ok('⑳ 0050 一直沒報價 → 回 retry、⛔ 不標今天做完、⛔ 不送單', r == 'retry' and st.get('park_day') != D and not api.orders, (r, st.get('park_day'), api.orders))
api.fail_quote = 0
r = A.park_step(api, sj, st, D, sleep_fn=lambda s: None)
ok('⑳b 下一輪報價回來 → 照樣湊交割款', r == 'sell' and shares(api, 'S') == math.ceil(100_000 / 198.0), (r, qty(api)))
st = {'pos': {'1111': {'sh': 1000, 'e': 100}}, 'park': {'sh': 3000}, 'hot_buy_amt': 100_000.0}
api = FakeApi({'0050': 200.0, '1111': 100.0}, cash=10_000, fail_quote=2)
r = A.park_step(api, sj, st, D, sleep_fn=lambda s: None)
ok('⑳c 前兩次失敗、第三次有報價 → 同一輪就做完(重試 3 次)', r == 'sell', r)

# ㉑ 真實帳戶:0050 買單「送出 ≠ 成交」→ 隔天用永豐庫存差對帳
setv(LIVE=True, PARK_LIVE_OK=True)
st = {'pos': {}, 'park': {}}
api = FakeApi({'0050': 200.0}, cash=2_000_000, real0050=5000)
r = A.park_step(api, sj, st, D)
ok('㉑ 真實帳戶(開關打開):買單送出後 ⛔ 先不算自己的(記下送出前的永豐庫存 5000)', r == 'buy' and shares(api, 'B') == 1485
   and int(st['park'].get('sh') or 0) == 0 and st['park'].get('pend') == {'d': D, 'sh': 1485, 'b': 5000} and st['park'].get('m') == 'live', st)
D2 = '2026-10-23'
def nxt(real, **kw):
    s2 = copy.deepcopy(st); a2 = FakeApi({'0050': 200.0}, cash=kw.get('cash', 0), real0050=real); A.park_step(a2, sj, s2, D2); return s2, a2
s_full, _ = nxt(6485)
ok('㉑b 隔天永豐 0050 5000 → 6485 → 算成交 1485 股', s_full['park'].get('sh') == 1485 and 'pend' not in s_full['park'], s_full['park'])
s_rej, _ = nxt(5000)
ok('㉑c 🔬 隔天永豐 0050 還是 5000(颱風假 / 退單)→ 一股都不算自己的(舊寫法會記成 1485 → 之後賣到你手動的)', int(s_rej['park'].get('sh') or 0) == 0, s_rej['park'])
s_part, _ = nxt(5500)
ok('㉑d 部分成交(5000 → 5500)→ 只算 500 股', s_part['park'].get('sh') == 500, s_part['park'])
st = {'pos': {}, 'park': {}}; api = FakeApi({'0050': 200.0}, cash=2_000_000, pos_err=True)
r = A.park_step(api, sj, st, D)
ok('㉑e 查不到永豐庫存 → 今天⛔ 不買(買了沒辦法對帳哪些是自己的)', r == 'nocash' and not api.orders, (r, api.orders))
#  檢查代理的情境:買單沒成交 + 你手動有 5000 股 + 今天買了 15 萬、現金 1 萬 → 舊寫法賣 708 股(全是你的)
st = {'pos': {'1111': {'sh': 1500, 'e': 100}}, 'park': {'pend': {'d': D, 'sh': 1485, 'b': 5000}, 'm': 'live'}, 'hot_buy_amt': 150_000.0}
api = FakeApi({'0050': 200.0, '1111': 100.0}, cash=10_000, real0050=5000)
LOGS.clear(); r = A.park_step(api, sj, st, D2)
ok('㉑f 🔬 買單沒成交 + 你手動有 5000 股 + 今天買了 15 萬 → ⛔ 一股都不賣(不是它的),並 🚨 提醒交割款不夠',
   not [x for x in qty(api) if x[4] == 'S'] and any('🚨' in x and '還差' in x for x in LOGS), (qty(api), LOGS[-3:]))

# ㉒ 🛡️ 開關沒開 → 真實帳戶只預覽
setv(LIVE=True)
LOGS.clear(); st = {'pos': {}, 'park': {}}; api = FakeApi({'0050': 200.0}, cash=2_000_000, real0050=0)
r = A.park_step(api, sj, st, D)
ok('㉒ 🛡️ 真實帳戶、PARK_LIVE_OK 還沒開 → 只預覽(⛔ 一單都不送),印出「今天會買 1485 股」+ 永豐原始資料',
   r == 'preview' and not api.orders and any('預覽' in x and '1485' in x for x in LOGS) and any('原始資料' in x and '餘額 2,000,000' in x for x in LOGS), (r, LOGS[-4:]))
setv(LIVE=True, PARK_LIVE_OK=True); st = {'pos': {}, 'park': {}}; api = FakeApi({'0050': 200.0}, cash=2_000_000, real0050=0)
r = A.park_step(api, sj, st, D)
ok('㉒b 🔬 對照:開關打開 → 真的送單', r == 'buy' and shares(api, 'B') == 1485, (r, qty(api)))
ok('㉒c 預設值:PARK_LIVE_OK = False(等 Claude 對過交割款正負號才改)', DEF['PARK_LIVE_OK'] is False, DEF['PARK_LIVE_OK'])
setv(LIVE=False); st = {'pos': {}, 'park': {}}; api = FakeApi({'0050': 200.0}, cash=2_000_000)
r = A.park_step(api, sj, st, D)
ok('㉒d 模擬帳戶照常買(不動真錢),紀錄標成模擬', r == 'buy' and shares(api, 'B') == 1485 and st['park'].get('m') == 'sim' and st['park'].get('sh') == 1485, (r, st['park']))

# ㉓ 真實帳戶的 DRY_RUN 也查現金(以前一律「查不到現金 → 不買」,預覽沒有用)
setv(LIVE=True, DRY_RUN=True)
LOGS.clear(); st = {'pos': {}, 'park': {}}; api = FakeApi({'0050': 200.0}, cash=2_000_000)
r = A.park_step(api, sj, st, D)
ok('㉓ 真實帳戶 DRY_RUN:會查現金(唯讀)→ 預覽「今天會買 1485 股」、⛔ 不送單', r == 'preview' and not api.orders and any('1485' in x for x in LOGS), (r, LOGS[-3:]))

# ㉔ 👑 要留的錢:⛔ 拿去停 0050、湊交割款也要算進去
setv(LEADER=True, LEADER_ACCOUNT=500_000)
st = {'pos': {}, 'park': {}, 'lead': {'2001': {'sh': 2000, 'e': 100}}}   # 👑 成本 20 萬 → 留 30 萬
api = FakeApi({'0050': 200.0, '2001': 100.0}, cash=500_000)
A.park_step(api, sj, st, D)
ok('㉔ 👑 分到 50 萬、持股成本 20 萬 → 留 30 萬給 👑:0050 只買 (50 − 30 − 1) 萬', shares(api, 'B') == int(190_000 // 202.0), shares(api, 'B'))
setv(LEADER=False)
st = {'pos': {}, 'park': {}, 'lead': {'2001': {'sh': 2000, 'e': 100}}}; api = FakeApi({'0050': 200.0, '2001': 100.0}, cash=500_000)
A.park_step(api, sj, st, D)
ok('㉔b 🔬 對照:沒開 👑 → 照常買到一天上限 30 萬', shares(api, 'B') == 1485, shares(api, 'B'))
setv(LEADER=True, LEADER_ACCOUNT=500_000)
st = {'pos': {'1111': {'sh': 1000, 'e': 100}}, 'park': {'sh': 3000}, 'lead': {'2001': {'sh': 2000, 'e': 100}}, 'hot_buy_amt': 100_000.0}
api = FakeApi({'0050': 200.0, '1111': 100.0, '2001': 100.0}, cash=350_000)
A.park_step(api, sj, st, D)
ok('㉔c 湊交割款也扣掉 👑 要留的 30 萬(現金 35 萬看起來夠付 10 萬,其實只有 5 萬能用 → 賣 6 萬)', shares(api, 'S') == math.ceil(60_000 / 198.0), qty(api))

# ㉕ DRY_RUN ⛔ 不寫狀態檔
import tempfile
_tf = tempfile.NamedTemporaryFile('w', delete=False, suffix='.json'); _tf.write('{"x": 1}'); _tf.close()
_sp = A.STATE_PATH; A.STATE_PATH = _tf.name
setv(DRY_RUN=True); _REAL_SAVE({'y': 2}); _same = open(_tf.name, encoding='utf-8').read() == '{"x": 1}'
setv(DRY_RUN=False); _REAL_SAVE({'y': 2}); _changed = json.load(open(_tf.name, encoding='utf-8')) == {'y': 2}
A.STATE_PATH = _sp; os.unlink(_tf.name)
ok('㉕ DRY_RUN ⛔ 不寫狀態檔(之後同一天真的跑才不會以為做過了);🔬 對照:不是 DRY_RUN 就會寫', _same and _changed, (_same, _changed))

# ㉖ 模擬帳戶買的 0050 ⛔ 不在真實帳戶賣
setv(LIVE=True)
def st26(m): return {'pos': {'2330': {'sh': 300, 'e': 1000, 'm': 'live'}}, 'park': {'sh': 4000, 'm': m}}   # 個股 30 萬 + 0050 80 萬 → 該停 70 萬、多 10 萬
st = st26('sim'); api = FakeApi({'0050': 200.0, '2330': 1000.0}, cash=0, real0050=4000)
A.park_step(api, sj, st, D)
ok('㉖ 狀態檔裡那 4000 股是模擬帳戶買的 → 真實帳戶⛔ 不賣(你手上那 4000 股可能是自己買的)', not [x for x in qty(api) if x[4] == 'S'] and int(st['park'].get('sh') or 0) == 0, (qty(api), st['park']))
st = st26('live'); api = FakeApi({'0050': 200.0, '2330': 1000.0}, cash=0, real0050=4000)
A.park_step(api, sj, st, D)
ok('㉖b 🔬 對照:同一份資料標成真實帳戶買的 → 照規則賣多出來的 10 萬', shares(api, 'S') == math.ceil(100_000 / 198.0), qty(api))

# ㉗ 湊不到交割款 → 🚨 講清楚
LOGS.clear(); A._park_manual_alert({'hot_buy_amt': 150_000.0, 'park': {'sh': 3000}})
ok('㉗ 湊交割款做不到 → 🚨 寫出金額、要你做什麼(盤後定價)、最多能賣幾股', any('🚨' in x and '150,000' in x and '盤後定價' in x and '3000' in x for x in LOGS), LOGS)
setv()

# 主迴圈:🔥 買完才停 0050,停完今天就收工
mm = re.search(r"\ndef main\(\):[\s\S]*", _src)
mb = mm.group(0) if mm else ''
ok('⑱ 主迴圈:hot_step 之後才 park_step;0050 沒報價(retry)⛔ 不收工,其他結果才 break(⛔ 之後不再買 🔥)',
   re.search(r"hot_step\(api, sj, st, meta, picks, day\)\n[\s\S]{0,400}if \(PARK or _park_has_own\(st\)\) and mins >= PARK_AT:\n\s+if park_step\(api, sj, st, day\) != 'retry':[\s\S]{0,200}break", mb) is not None)
ok('⑱b 收盤前補做一次、還是 retry → 🚨 _park_manual_alert;程式 13:30 後才啟動也會提醒(兩處)',
   mb.count('_park_manual_alert(st)') >= 2 and "if r == 'retry'" in mb and 'PARK or _park_has_own(st)) and st.get(\'park_day\') != day' in mb)

for k, v in DEF.items(): setattr(A, k, v)
print(f"\n{'✅' if not bad_n else '❌'} AUTO_PARK {ok_n}/{ok_n + bad_n}")
sys.exit(1 if bad_n else 0)
