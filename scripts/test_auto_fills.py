#!/usr/bin/env python3
"""
📒 V80.1.3 auto_trade.py 實際成交價自動記錄(19 個專案評估 1-6)—— 假永豐 API,⛔ 不連網、不下真單
   ① 整張兩筆成交(1 張 @100、1 張 @101)→ 2,000 股、均價 100.5;零股 485 股照股數算;賣單照記
   ② 收盤價比較:正數 = 比回測假設的收盤價成交差(買貴了 / 賣便宜了)
   ③ 平日還沒到 13:31 → 等到 13:31 再問一次(拿到收盤競價成交完的那份)⭐ 決定性對照:13:40 / 週六 → ⛔ 等
   ④ 今天沒有委託 → ⛔ 等、⛔ 寫檔
   ⑤ 同一天跑兩次 → ⛔ 重複寫;同一筆後來成交更多 → 再記一行
   ⑥ DRY_RUN / FILLS_LOG=0 → ⛔ 查、⛔ 寫;永豐查不到 → 回 None、⛔ 丟例外、⛔ 寫檔
   ⑦ 程式這一次送的單標 own(`_send` 記編號);別的單照記但標 ⛔ own
   ⑧ 總成交量跟逐筆加總對不上 → 印出來(⛔ 靜默)
   ⑨ 靜態:成交回報那幾支 ⛔ 下單 / 刪單 / 改狀態檔;main 在登出前呼叫;`_note_sent` 在送單的 try 外面
"""
import ast, inspect, json, os, sys, tempfile, types
from datetime import datetime
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
AT_DIR = os.environ.get('AT_DIR') or ROOT   # 注入驗證用:指到一份改過的 auto_trade.py
sys.path.insert(0, ROOT)
sys.path.insert(0, AT_DIR)
import auto_trade as A

ok_n = bad_n = 0
def ok(name, c, extra=''):
    global ok_n, bad_n
    print(('✅ ' if c else '❌ ') + name + ('' if c else f'  {extra}'))
    ok_n, bad_n = ok_n + bool(c), bad_n + (not c)

C = types.SimpleNamespace(Action=types.SimpleNamespace(Buy='B', Sell='S'), StockPriceType=types.SimpleNamespace(LMT='LMT'),
                          OrderType=types.SimpleNamespace(ROD='ROD'), StockOrderLot=types.SimpleNamespace(Common='C', IntradayOdd='O'))
sj = types.SimpleNamespace(constant=C)
NS = types.SimpleNamespace

def deal(px, q): return NS(price=px, quantity=q)
def trade(oid, code, act, px, q, lot, status, deals, api_dq='auto'):
    dq = sum(d.quantity for d in deals) if api_dq == 'auto' else api_dq
    return NS(order=NS(id=oid, action=act, price=px, quantity=q, order_lot=lot),
              status=NS(status=f'Status.{status}', deals=deals, deal_quantity=dq), contract=NS(code=code))

class FakeApi:
    def __init__(self, batches, closes=None, boom=False):
        self.batches = list(batches); self.calls = 0; self.closes = closes or {}; self.boom = boom
        self.stock_account = 'ACC'; self.placed = 0; self.upd = 0
        class Stocks(dict):
            def __getitem__(s, k): return k
        self.Contracts = NS(Stocks=Stocks())
    def update_status(self, acc=None): self.upd += 1
    def list_trades(self):
        if self.boom: raise RuntimeError('查不到(假)')
        b = self.batches[min(self.calls, len(self.batches) - 1)]; self.calls += 1
        return b
    def snapshots(self, cs): return [NS(close=self.closes.get(cs[0], 0))]
    def place_order(self, *a, **k): self.placed += 1; raise AssertionError('⛔ 成交回報不可下單')
    def cancel_order(self, *a, **k): raise AssertionError('⛔ 成交回報不可刪單')

LOGS = []
A.log = lambda *a, **k: LOGS.append(' '.join(str(x) for x in a))
TMP = tempfile.mkdtemp()
def setv(**kw):
    A.DRY_RUN = kw.get('DRY_RUN', False); A.LIVE = False
    A.FILLS_LOG = kw.get('FILLS_LOG', os.path.join(TMP, 'f.jsonl'))
def clk(h, m, wd=2):   # wd 0 = 週一
    d = datetime(2026, 10, 26 + wd, h, m)   # 2026-10-26 是週一
    return lambda: (d, h * 60 + m, d.strftime('%Y-%m-%d'))
def lines(p):
    if not p or not os.path.exists(p): return []
    return [json.loads(x) for x in open(p, encoding='utf-8') if x.strip()]
SLEPT = []
D = '2026-10-28'

# ① ② ③ 平日 13:27 → 等到 13:31;等完那一份才有收盤競價的成交
setv(); A._SENT_IDS.clear(); A._SENT_IDS.update({'o1', 'o3'})
pend = [trade('o1', '2330', 'B', 101.0, 2, 'C', 'Submitted', []), trade('o2', '2330', 'B', 100.5, 485, 'O', 'Submitted', []),
        trade('o3', '2454', 'S', 98.0, 1, 'C', 'Submitted', [])]
done = [trade('o1', '2330', 'B', 101.0, 2, 'C', 'Filled', [deal(100.0, 1), deal(101.0, 1)]),
        trade('o2', '2330', 'B', 100.5, 485, 'O', 'Filled', [deal(100.5, 485)]),
        trade('o3', '2454', 'S', 98.0, 1, 'C', 'Filled', [deal(98.2, 1)])]
api = FakeApi([pend, done], closes={'2330': 101.0, '2454': 98.4})
SLEPT.clear(); t = {'k': 0}
def now_seq():
    t['k'] += 1
    return clk(13, 27)() if t['k'] == 1 else clk(13, 31)()
n1 = A.fills_report(api, sj, D, now_fn=now_seq, sleep_fn=lambda s: SLEPT.append(s))
L = {r['oid']: r for r in lines(A.FILLS_LOG)}
ok('③ 平日 13:27 → 等 4 分鐘到 13:31 再問一次(第二次才拿到收盤競價的成交)', SLEPT == [240] and api.calls == 2, (SLEPT, api.calls))
ok('① 整張兩筆成交 → 2,000 股、均價 100.5;零股 485 股;賣單 1,000 股 @98.2', n1 == 3 and L['o1']['fq'] == 2000 and L['o1']['avg'] == 100.5
   and L['o1']['q'] == 2000 and L['o2']['fq'] == 485 and L['o2']['lot'] == 'O' and L['o3']['side'] == 'S' and L['o3']['fq'] == 1000, L)
ok('② 收盤價比較:買均價 100.5 vs 收盤 101 → −0.495%(比回測少付);賣 98.2 vs 98.4 → +0.203%(賣便宜了)',
   L['o1']['vs_close'] == -0.495 and L['o3']['vs_close'] == 0.203 and L['o1']['close'] == 101.0, (L['o1'], L['o3']))
ok('②b 跟掛單價比:100.5 vs 101 → −0.495%', L['o1']['vs_px'] == -0.495, L['o1'])
ok('⑦ 程式送的單標 own,另一筆(o2)標 ⛔ own 並印出來', L['o1']['own'] and L['o3']['own'] and not L['o2']['own']
   and any('不是這一次程式送的' in x and '2330' in x for x in LOGS), [x for x in LOGS if '📒' in x][:6])
ok('⑦b 模式照記(sim)', all(r['m'] == 'sim' for r in L.values()), L)

# ③ 決定性對照:13:40 / 週六 → ⛔ 等
for nm, cf in (('13:40', clk(13, 40)), ('週六 13:20', clk(13, 20, wd=5))):
    setv(FILLS_LOG=os.path.join(TMP, f'g_{nm[:2]}.jsonl')); SLEPT.clear()
    api2 = FakeApi([done], closes={'2330': 101.0, '2454': 98.4})
    A.fills_report(api2, sj, D, now_fn=cf, sleep_fn=lambda s: SLEPT.append(s))
    ok(f'③ ⭐ 決定性對照:{nm} → ⛔ 等、只問一次', SLEPT == [] and api2.calls == 1, (SLEPT, api2.calls))

# ④ 沒有委託 → ⛔ 等、⛔ 寫
setv(FILLS_LOG=os.path.join(TMP, 'empty.jsonl')); SLEPT.clear()
r4 = A.fills_report(FakeApi([[]]), sj, D, now_fn=clk(13, 20), sleep_fn=lambda s: SLEPT.append(s))
ok('④ 今天沒有委託 → ⛔ 等、⛔ 寫檔', r4 == 0 and SLEPT == [] and not os.path.exists(A.FILLS_LOG), (r4, SLEPT))

# ⑤ 同一天跑兩次 → ⛔ 重複;後來成交更多 → 再記一行
setv(FILLS_LOG=os.path.join(TMP, 'dup.jsonl'))
part = [trade('p1', '3008', 'B', 2000.0, 2, 'C', 'PartFilled', [deal(2000.0, 1)])]
full = [trade('p1', '3008', 'B', 2000.0, 2, 'C', 'Filled', [deal(2000.0, 1), deal(1995.0, 1)])]
a = A.fills_report(FakeApi([part]), sj, D, now_fn=clk(13, 40))
b = A.fills_report(FakeApi([part]), sj, D, now_fn=clk(13, 40))
c = A.fills_report(FakeApi([full]), sj, D, now_fn=clk(13, 40))
LL = lines(A.FILLS_LOG)
ok('⑤ 同一份跑兩次 → 第二次 0 筆(⛔ 重複);成交變多 → 多記一行(新的那行 2,000 股、均價 1,997.5)',
   (a, b, c) == (1, 0, 1) and len(LL) == 2 and LL[-1]['fq'] == 2000 and LL[-1]['avg'] == 1997.5 and LL[0]['fq'] == 1000, ((a, b, c), LL))
ok('⑤b 只成交一部分 → 寫出「只成交 1,000 / 2,000 股」', any('只成交 1,000 / 2,000 股' in x for x in LOGS), '')

# ⑥ DRY_RUN / FILLS_LOG=0 / 查不到
setv(DRY_RUN=True, FILLS_LOG=os.path.join(TMP, 'dry.jsonl')); apiD = FakeApi([done])
r6 = A.fills_report(apiD, sj, D, now_fn=clk(13, 40))
ok('⑥ DRY_RUN → ⛔ 查成交回報、⛔ 寫檔', r6 == 0 and apiD.calls == 0 and apiD.upd == 0 and not os.path.exists(A.FILLS_LOG), (r6, apiD.calls))
setv(FILLS_LOG=None); apiN = FakeApi([done])
ok('⑥b FILLS_LOG=0(關掉)→ ⛔ 查', A.fills_report(apiN, sj, D, now_fn=clk(13, 40)) == 0 and apiN.calls == 0, apiN.calls)
setv(FILLS_LOG=os.path.join(TMP, 'boom.jsonl'))
try:
    r6c = A.fills_report(FakeApi([done], boom=True), sj, D, now_fn=clk(13, 40)); thrown = False
except Exception:
    r6c = 'raised'; thrown = True
ok('⑥c 永豐查不到 → 回 None、⛔ 丟例外、⛔ 寫檔、印一行', r6c is None and not thrown and not os.path.exists(A.FILLS_LOG)
   and any('查不到今天的成交回報' in x for x in LOGS), r6c)
setv(FILLS_LOG=os.path.join(TMP, 'nodir', 'x', 'f.jsonl'))
try:
    r6d = A.fills_report(FakeApi([done]), sj, D, now_fn=clk(13, 40)); thrown = False
except Exception:
    thrown = True; r6d = 'raised'
ok('⑥d 寫不進去(資料夾不在)→ 回 None、⛔ 丟例外', r6d is None and not thrown, r6d)

# ⑦ _send 記編號(假的 place_order 回帶 order.id 的東西)
class SendApi(FakeApi):
    def __init__(self): super().__init__([[]]); self.k = 0
    def Order(self, **kw): return kw
    def place_order(self, contract, order):
        self.k += 1; return NS(order=NS(id=f'S{self.k}'))
A._SENT_IDS.clear()
A._send(SendApi(), sj, '2330', 100.0, 1485, True)
ok('⑦c `_send` 整張 + 零股兩筆都記下委託編號(只在記憶體)', A._SENT_IDS == {'S1', 'S2'}, A._SENT_IDS)
class OddFail(SendApi):
    def place_order(self, contract, order):
        if order['order_lot'] == 'O': raise RuntimeError('零股出錯(假)')
        return super().place_order(contract, order)
A._SENT_IDS.clear(); err = None
try:
    A._send(OddFail(), sj, '2330', 100.0, 1485, True)
except A.SendError as e:
    err = e
ok('⑦d 零股那筆出錯 → 照舊丟 SendError(已送出 1,000 股)、整張那筆的編號有記', err is not None and err.sent_sh == 1000 and A._SENT_IDS == {'S1'}, (err, A._SENT_IDS))
class BadTrade(SendApi):
    def place_order(self, contract, order):
        self.k += 1
        class Weird:
            @property
            def order(self): raise ValueError('讀不到編號(假)')
        return Weird()
A._SENT_IDS.clear(); err2 = None
try:
    A._send(BadTrade(), sj, '2330', 100.0, 2000, True)
except Exception as e:
    err2 = e
ok('⑦e 回來的東西讀不到編號 → ⛔ 被當成送單失敗(記編號 ⛔ 丟例外)', err2 is None, err2)

# ⑧ 總成交量對不上 → 印出來
setv(FILLS_LOG=os.path.join(TMP, 'mis.jsonl')); LOGS.clear()
A.fills_report(FakeApi([[trade('m1', '2317', 'B', 200.0, 1, 'C', 'Filled', [deal(200.0, 1)], api_dq=1000)]]), sj, D, now_fn=clk(13, 40))
ok('⑧ 總成交量 1000 跟逐筆加總 1 對不上 → 印出來(⛔ 靜默),照逐筆記 1,000 股', any('對不上' in x and '2317' in x for x in LOGS)
   and lines(A.FILLS_LOG)[0]['fq'] == 1000, LOGS[:4])

# ⑨ 靜態
src = open(os.path.join(AT_DIR, 'auto_trade.py'), encoding='utf-8').read()
tree = ast.parse(src)
fn = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
def calls(n):
    out = set()
    for x in ast.walk(n):
        if isinstance(x, ast.Call):
            f = x.func
            out.add(f.attr if isinstance(f, ast.Attribute) else getattr(f, 'id', ''))
    return out
bad = {'place_order', 'cancel_order', 'update_order', 'save_state', '_send'}
used = set().union(*(calls(fn[k]) for k in ('_fill_rows', '_fill_closes', 'fills_report')))
ok('⑨ 成交回報那三支 ⛔ 下單 / 刪單 / 改單 / 存狀態檔', not (used & bad), used & bad)
ok('⑨b fills_report 的參數沒有狀態檔(⛔ 碰得到部位 / 停損)', 'st' not in inspect.signature(A.fills_report).parameters, inspect.signature(A.fills_report))
m = fn['main']; ms = ast.get_source_segment(src, m)
ok('⑨c main 收工前呼叫 fills_report,而且在 logout 之前、包在 try 裡', 'fills_report(api, sj, today)' in ms
   and ms.index('fills_report(api, sj, today)') < ms.index('api.logout()'), '')
se = ast.get_source_segment(src, fn['_send'])
ok('⑨d `_note_sent` 排在送單的 try 外面(記不到編號 ⛔ 變成 SendError)', '_note_sent(sent[-1])' in se
   and se.index('_note_sent(sent[-1])') > se.index('raise SendError(done_sh, e)'), '')

print(f"{'✅' if not bad_n else '❌'} test_auto_fills:{ok_n} 過 / {bad_n} 沒過")
sys.exit(1 if bad_n else 0)
