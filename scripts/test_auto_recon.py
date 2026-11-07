#!/usr/bin/env python3
"""
🧾 V82.0.4 auto_trade.py 送單安全 + 收工對帳 + 虧損安全鎖(會動真錢)—— 假永豐 API,⛔ 不連網、不下真單
   外部健檢 11/07 查到三個真缺口(使用者:真實帳戶在跑、四個安全機制都要),每一條都有「該發生 / 不該發生」的決定性對照:
   ① 送單時連線出錯、但永豐其實已經收單 → 下一輪先問永豐、認成程式的單,⛔ 再送一次(對照:舊寫法重複買)
   ② 永豐確定沒收到 → 只重送一次  ③ 問不到永豐 → ⛔ 送  ④ 同一檔同方向但對不上的(你手動下的)→ ⛔ 認、⛔ 送
   ⑤ 重開機:送出前已經先記「?」→ ⛔ 重買;送單前一定先存檔  ⑥ 出錯不到 55 秒 → 先等、⛔ 問也 ⛔ 送
   ⑦ 同一本帳同一段成功過 → ⛔ 再送  ⑧ 決定性對照:沒出錯時送出去的單跟 `_send` 一模一樣、⛔ 多問永豐一次
   ⑨ 收工對帳:買單只成交一部分 → 紀錄改成實際股數(真實帳戶成交回報 + 永豐庫存兩邊都對得上才改;模擬 / RECON_APPLY=0 / 庫存對不上只報告)
   ⑩ 賣單沒成交(跌停)→ 收回來標 rs → 隔天 🔥 先補賣(⛔ 再看出場線)  ⑪ 👑 非換倉日補賣、換倉那段 ⛔ 另外再賣
   ⑫ 13:36 前 / 週六 → 只報告  ⑬ 跑兩次結果一樣  ⑭ 同一檔在 🔥 和 👑 兩本帳(庫存夠才一起收回)
   ⑮ 庫存不夠 → ⛔ 補賣  ⑯ 30 天成交紀錄掃描只報一次  ⑰ 出錯照樣收工記成交 + 對帳 + 登出、回傳 1
   ⑱ 虧損安全鎖邊界(−3.0% 鎖、−2.9% 不鎖、0 = 關、換月解鎖)+ 已實現損益算法 + 跑兩次不重複算
   ⑲ 狀態沒定案 / 成交回報對不上 / 兩次查的不一樣 → 只報告  ⑳ 程式當成沒送出、永豐其實有 → 🚨
   ㉑ 委託紀錄只留 14 天  ㉒ 每筆記規則版本  ㉓ 兩個以前會讓整支停下來的呼叫  ㉔ 👑 換倉日一股都沒送出 → 今天稍後再試
   ㉕ 靜態:對帳 ⛔ 下單 / 刪單;每筆上限 / PARK_LIVE_OK 沒變;8 個送單點都走 _send_j
   ㉖ 以前那幾天沒對到帳的單 → 開工時列出來(只報告、只列一次)
   ㉗ ✂️ V82.0.7 收一半那筆沒成交 → 只收回那幾股、標 rt(⛔ 標 rs 隔天整檔賣)・隔天只補賣那幾股・你取消的 ⛔ 補賣・只成交一部分只收回剩下的
   INJECT=nogate / noinv / nors / nolock / nocrash / nowait / nosave / notimefb / noprev / notr / nort → 各自必紅(注入驗證)
"""
import ast, copy, json, os, sys, tempfile, types
from datetime import datetime

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
INJ = os.environ.get('INJECT', '')
if INJ:
    _src = open(os.path.join(ROOT, 'auto_trade.py'), encoding='utf-8').read()
    _P = {
        'nogate': ("        g, why = _send_gate(api, sj, st, sym, side, lot, q, px, book, day)\n", "        g, why = 'go', ''\n"),
        'noinv': ("                if real < after:\n", "                if False:\n"),
        'nors': ("            if pos.get('rs'):\n                # 🧾 V82.0.4 之前那筆賣單送了但沒成交", "            if False:\n                # 🧾 V82.0.4 之前那筆賣單送了但沒成交"),
        'nolock': ("    pnl = float((st.get('pnl') or {}).get(str(day)[:7]) or 0)\n", "    pnl = 0.0\n"),
        'nocrash': ("    except Exception as e:\n        crash = e\n", "    except ZeroDivisionError as e:\n        crash = e\n"),
        'nowait': ("    if ago < GATE_WAIT_SEC:\n", "    if False:\n"),
        'nosave': ("        save_state(st)   # ⚠️ 先存「?」再送\n", "        pass\n"),
        'noprev': ("        if not old:\n            return 0\n        for e in sorted(old,", "        if True:\n            return 0\n        for e in sorted(old,"),
        'notimefb': ("            i = next((j for j, r in enumerate(rows2) if j not in used2 and _strong(r, e, use_time=False)), None)\n", "            pass\n"),
        'notr': ("        kind = 'T' if side == 'S' and e.get('tr') else side", "        kind = side"),
        'nort': ("    tsh = min(rt, sh)\n", "    tsh = sh\n"),
    }[INJ]
    assert _src.count(_P[0]) == 1, f'注入點找不到:{INJ}'
    _tmp = tempfile.mkdtemp()
    with open(os.path.join(_tmp, 'auto_trade.py'), 'w', encoding='utf-8') as f:
        f.write(_src.replace(*_P))
    sys.path.insert(0, _tmp)
import auto_trade as A

ok_n = bad_n = 0
def ok(name, c, extra=''):
    global ok_n, bad_n
    print(('✅ ' if c else '❌ ') + name + ('' if c else f'  {str(extra)[:600]}'))
    ok_n, bad_n = ok_n + bool(c), bad_n + (not c)

NS = types.SimpleNamespace
C = NS(Action=NS(Buy='B', Sell='S'), StockPriceType=NS(LMT='LMT'), OrderType=NS(ROD='ROD'),
       StockOrderLot=NS(Common='C', IntradayOdd='O'), Unit=NS(Share='Share', Common='Common'))
sj = NS(constant=C)
CLK = [1_790_000_000.0]
A._now_ts = lambda: CLK[0]
def nxt(sec=60):   # 下一輪(主迴圈每輪隔 60 秒)
    CLK[0] += sec


class Broker:
    """假永豐:每一筆委託都記下來(編號 / 時間 / 成交);可設「收單後才丟例外」(att)、「沒收單就丟例外」(rej 次數)、
    「查不到」(query_fail)、庫存(inv:{代號: (現在, 昨天)},None = 查不到)"""
    def __init__(self, px=None, att=(), rej=None, query_fail=False, inv=None):
        self.trades, self.px, self.att, self.rej = [], dict(px or {}), set(att), dict(rej or {})
        self.query_fail, self.inv = query_fail, inv
        self.tries, self.q_calls, self.snap_calls, self.on_place = {}, 0, {}, None
        self.stock_account = 'ACC'
        class Stocks(dict):
            def __getitem__(s, k): return k
        self.Contracts = NS(Stocks=Stocks())
    def snapshots(self, cs):
        self.snap_calls[cs[0]] = self.snap_calls.get(cs[0], 0) + 1
        return [NS(close=self.px.get(cs[0], 100.0), change_rate=0.0, open=self.px.get(cs[0], 100.0), change_price=0.0)]
    def Order(self, **kw): return kw
    def place_order(self, contract, order):
        key = (contract, order['order_lot'])
        self.tries[key] = self.tries.get(key, 0) + 1
        if self.on_place:
            self.on_place(contract, order)
        if self.rej.get(key, 0) > 0:
            self.rej[key] -= 1
            raise RuntimeError('永豐沒收到(假)')
        oid = f'O{len(self.trades) + 1}'
        self.trades.append({'oid': oid, 'sym': contract, 'side': order['action'], 'lot': order['order_lot'],
                            'q': order['quantity'], 'px': order['price'], 'ot': CLK[0], 'st': 'Submitted', 'deals': []})
        if key in self.att:
            self.att.discard(key)
            raise TimeoutError('永豐收到了、但回應逾時(假)')
        return NS(order=NS(id=oid))
    def manual(self, sym, side, lot, q, px):   # 你自己在永豐 App 下的單
        self.trades.append({'oid': f'M{len(self.trades) + 1}', 'sym': sym, 'side': side, 'lot': lot, 'q': q, 'px': px,
                            'ot': CLK[0], 'st': 'Submitted', 'deals': []})
    def fill(self, i, q, px, st='Filled'):
        self.trades[i]['deals'].append((px, q)); self.trades[i]['st'] = st
    def update_status(self, acc=None):
        self.q_calls += 1
        if self.query_fail:
            raise RuntimeError('查不到(假)')
    def list_trades(self):
        if self.query_fail:
            raise RuntimeError('查不到(假)')
        return [NS(order=NS(id=t['oid'], action=t['side'], price=t['px'], quantity=t['q'], order_lot=t['lot']),
                   status=NS(status='Status.' + t['st'], deals=[NS(price=p, quantity=q) for p, q in t['deals']],
                             deal_quantity=t.get('dq', sum(q for _, q in t['deals'])), order_datetime=t['ot']),
                   contract=NS(code=t['sym'])) for t in self.trades]
    def list_positions(self, acc, unit=None):
        if self.inv is None:
            raise RuntimeError('查不到庫存(假)')
        return [NS(code=k, quantity=v[0], yd_quantity=v[1]) for k, v in self.inv.items()]
    def n(self, sym=None, side=None, lot=None):
        return len([t for t in self.trades if (sym is None or t['sym'] == sym) and (side is None or t['side'] == side)
                    and (lot is None or t['lot'] == lot) and t['oid'].startswith('O')])


LOGS, SAVES = [], []
A.log = lambda *a, **k: LOGS.append(' '.join(str(x) for x in a))
A.save_state = lambda st: SAVES.append(copy.deepcopy(st))
DEF = {k: getattr(A, k) for k in ('LIVE', 'DRY_RUN', 'ACCOUNT_SIZE', 'POS_PCT', 'MAX_LOTS_PER_TRADE', 'MAX_AMT_PER_TRADE', 'MAX_PICKS',
                                  'BEAR_GATE', 'PARK', 'LEADER', 'LEADER_ACCOUNT', 'RECON_APPLY', 'LOSS_LOCK_PCT', 'FILLS_LOG',
                                  'LEADER_WINDOW', 'LEADER_BOOKS', 'LEADER_ANCHOR', 'fetch_klines', 'fetch_json')}
def setv(**kw):
    base = {**DEF, 'LIVE': False, 'DRY_RUN': False, 'ACCOUNT_SIZE': 1_000_000, 'POS_PCT': 15, 'MAX_LOTS_PER_TRADE': 99,
            'MAX_AMT_PER_TRADE': 10**9, 'MAX_PICKS': 2, 'BEAR_GATE': False, 'PARK': False, 'LEADER': False, 'LEADER_ACCOUNT': 0,
            'RECON_APPLY': True, 'LOSS_LOCK_PCT': 0.0, 'FILLS_LOG': None}
    for k, v in {**base, **kw}.items():
        setattr(A, k, v)
def fresh(**kw):
    A._ONCE.clear(); A._SENT_IDS.clear(); LOGS.clear(); SAVES.clear(); setv(**kw)
def clk(h, m, day=9):   # 2026-11-09 = 週一;day=14 = 週六
    d = datetime(2026, 11, day, h, m)
    return lambda: (d, h * 60 + m, d.strftime('%Y-%m-%d'))
NOSLEEP = lambda s: None
D, D2 = '2026-11-09', '2026-11-10'
PICKS = [{'s': '2330', 'trig': 100.0, 'stop': 95.0}]
BULL = {'mkt': {'bear60': False}, 'data_date': '2026-11-06'}
has = lambda frag: sum(frag in x for x in LOGS)

# ① 收單後才出錯 → 先問永豐、認成程式的單
fresh()
b = Broker({'2330': 101.0}, att={('2330', 'C')})
st = {'done': [], 'pos': {}, 'd': D}
A.hot_step(b, sj, st, BULL, PICKS, D)
ok('①a 第一次:整張那筆永豐收到了、但回應逾時 → 程式當成沒送出(⛔ 記部位)', b.n('2330', 'B', 'C') == 1 and st['pos'] == {}, (b.trades, st))
nxt(); A.hot_step(b, sj, st, BULL, PICKS, D)
ok('① 下一輪先問永豐:找到完全對得上的那筆 → 認成程式的單、⛔ 再送整張;零股照送、部位記 1485 股',
   b.n('2330', 'B', 'C') == 1 and b.n('2330', 'B', 'O') == 1 and st['pos'].get('2330', {}).get('sh') == 1485
   and any(e.get('st') == 'adopt' for e in st['ord']), (b.trades, st.get('pos'), LOGS[-4:]))
ok('①b 認走的那筆委託編號記進 _SENT_IDS(收工時算程式的單)', 'O1' in A._SENT_IDS, A._SENT_IDS)
b2 = Broker({'2330': 101.0}, att={('2330', 'C')})
for _ in range(2):
    try:
        A._send(b2, sj, '2330', 101.0, 1485, True)
    except A.SendError:
        pass
ok('①c 🔬 對照:舊寫法(出錯就直接再 _send 一次)→ 永豐收到 2 筆整張 = 重複買', b2.n('2330', 'B', 'C') == 2, b2.trades)

# ② 永豐確定沒收到 → 只重送一次
fresh()
b = Broker({'2330': 101.0}, rej={('2330', 'C'): 99})
st = {'done': [], 'pos': {}, 'd': D}
for _ in range(4):
    A.hot_step(b, sj, st, BULL, PICKS, D); nxt()
ok('② 查過永豐確定沒收到 → 只重送一次(整張總共試 2 次),之後 ⛔ 再送、🚨 只講一次',
   b.tries.get(('2330', 'C')) == 2 and not b.trades and st['pos'] == {} and has('重送過一次還是沒成') == 1, (b.tries, LOGS[-6:]))
fresh()
b = Broker({'2330': 101.0}, rej={('2330', 'C'): 1})
st = {'done': [], 'pos': {}, 'd': D}
A.hot_step(b, sj, st, BULL, PICKS, D); nxt(); A.hot_step(b, sj, st, BULL, PICKS, D)
ok('②b 🔬 對照:只失敗一次 → 第二次送成功、部位 1485 股', st['pos'].get('2330', {}).get('sh') == 1485 and b.n() == 2, (b.trades, st))

# ③ 問不到永豐 → ⛔ 送
fresh()
b = Broker({'2330': 101.0}, rej={('2330', 'C'): 1}, query_fail=True)
st = {'done': [], 'pos': {}, 'd': D}
for _ in range(3):
    A.hot_step(b, sj, st, BULL, PICKS, D); nxt()
ok('③ 送單出錯後問不到永豐 → ⛔ 重送(可能其實已經收到)、🚨 只講一次', b.tries.get(('2330', 'C')) == 1 and st['pos'] == {}
   and has('問不到永豐今天的委託') == 1, (b.tries, LOGS[-5:]))

# ④ 你手動下的單 ⛔ 認也 ⛔ 送
fresh()
b = Broker({'2330': 101.0}, rej={('2330', 'C'): 1})
b.manual('2330', 'B', 'C', 3, 99.0)
st = {'done': [], 'pos': {}, 'd': D}
A.hot_step(b, sj, st, BULL, PICKS, D); nxt(); A.hot_step(b, sj, st, BULL, PICKS, D)
ok('④ 永豐有同一檔、同方向但對不上的委託(你手動下的)→ ⛔ 認成程式的、⛔ 再送', b.tries.get(('2330', 'C')) == 1 and st['pos'] == {}
   and not any(e.get('st') == 'adopt' for e in st['ord']) and has('可能是你手動下的') == 1, (b.tries, LOGS[-4:]))
fresh()
b = Broker({'2330': 101.0}, rej={('2330', 'C'): 1})
b.manual('2454', 'B', 'C', 3, 99.0)
st = {'done': [], 'pos': {}, 'd': D}
A.hot_step(b, sj, st, BULL, PICKS, D); nxt(); A.hot_step(b, sj, st, BULL, PICKS, D)
ok('④b 🔬 對照:手動單是別檔 → 照常重送一次、部位 1485 股', st['pos'].get('2330', {}).get('sh') == 1485, (b.trades, st))

# ⑤ 重開機:送出前已經先記「?」
fresh()
b = Broker({'2330': 101.0})
st = {'done': [], 'pos': {}, 'd': D}
A._ord_add(st, D, '2330', 'B', 'C', 1000, 101.0, 'pos')                       # 上一次:先記「?」→ 送出 → 還沒存回來就當掉
b.place_order('2330', {'action': 'B', 'price': 101.0, 'quantity': 1, 'order_lot': 'C'})
A._SENT_IDS.clear()
nxt(); A.hot_step(b, sj, st, BULL, PICKS, D)
ok('⑤ 重開機:紀錄裡有「?」、永豐其實收到了 → 認成程式的單,⛔ 重買整張;零股照送', b.n('2330', 'B', 'C') == 1 and b.n('2330', 'B', 'O') == 1
   and st['pos'].get('2330', {}).get('sh') == 1485, (b.trades, st.get('pos')))
fresh()
b = Broker({'2330': 101.0})
st = {'done': [], 'pos': {}, 'd': D}
A._ord_add(st, D, '2330', 'B', 'C', 1000, 101.0, 'pos')
nxt(); A.hot_step(b, sj, st, BULL, PICKS, D)
ok('⑤b 🔬 對照:「?」那筆其實沒送到 → 查過確定沒有 → 送一次(整張 1 筆)', b.n('2330', 'B', 'C') == 1 and st['pos'].get('2330', {}).get('sh') == 1485, b.trades)
fresh()
b = Broker({'2330': 101.0})
seen = []
b.on_place = lambda c, o: seen.append([e.get('st') for e in (SAVES[-1].get('ord') or []) if e.get('sym') == c and e.get('lot') == o['order_lot']])
st = {'done': [], 'pos': {}, 'd': D}
A.hot_step(b, sj, st, BULL, PICKS, D)
ok('⑤c 每一筆送出去之前,存檔的狀態檔裡已經有那一筆「?」(送出後、存檔前當掉 → 下次開機查得到)', seen == [['?'], ['?']], seen)
st = {'d': D, 'ord': [{'d': D, 'sym': '2330', 'oid': 'O7', 'st': 'ok'}, {'d': '2026-11-06', 'sym': '2454', 'oid': 'O8', 'st': 'ok'}]}
A._SENT_IDS.clear(); A._sent_ids_restore(st, D)
ok('⑤d 重開機把今天送過的委託編號補回 _SENT_IDS(⛔ 補別天的)', A._SENT_IDS == {'O7'}, A._SENT_IDS)

# ⑥ 出錯不到 55 秒 → 先等
fresh()
b = Broker({'2330': 101.0}, rej={('2330', 'C'): 1})
st = {'done': [], 'pos': {}, 'd': D}
A.hot_step(b, sj, st, BULL, PICKS, D)
nxt(30); A.hot_step(b, sj, st, BULL, PICKS, D)
ok('⑥ 出錯才 30 秒 → 先等:⛔ 問永豐、⛔ 再送', b.q_calls == 0 and b.tries.get(('2330', 'C')) == 1 and st['pos'] == {}, (b.q_calls, b.tries))
nxt(30); A.hot_step(b, sj, st, BULL, PICKS, D)
ok('⑥b 到了 60 秒 → 問過永豐確定沒收到 → 送成功', b.q_calls >= 1 and st['pos'].get('2330', {}).get('sh') == 1485, (b.q_calls, st))

# ⑦ 同一本帳同一段成功過 → ⛔ 再送
fresh()
b = Broker(); st = {'d': D}
A._send_j(b, sj, st, '2330', 100.0, 1000, True, 'pos', '2330', D)
err = None
try:
    A._send_j(b, sj, st, '2330', 100.0, 1000, True, 'pos', '2330', D)
except A.SendError as e:
    err = e
ok('⑦ 同一本帳、同一檔、同一段今天已經成功送過 → 再叫一次 ⛔ 送(防呆)', b.n() == 1 and err is not None and isinstance(err.err, A.GateHold), (b.trades, err))
A._send_j(b, sj, st, '2330', 100.0, 1000, True, 'lead', '2330', D)
ok('⑦b 🔬 對照:另一本帳(👑)同一檔 → 照送', b.n() == 2, b.trades)

# ⑧ 決定性對照:沒出錯時跟以前一模一樣
class Plain:
    def __init__(self): self.orders, self.q = [], 0; self.stock_account = 'ACC'
    def Order(self, **kw): return kw
    def place_order(self, c, o): self.orders.append((c, dict(o))); return NS(order=NS(id=f'P{len(self.orders)}'))
    def update_status(self, *a): self.q += 1
    def list_trades(self): self.q += 1; return []
fresh()
p1, p2 = Plain(), Plain()
A._send(p1, sj, '2330', 101.0, 1485, True)
A._send_j(p2, sj, {'d': D}, '2330', 101.0, 1485, True, 'pos', '2330', D)
ok('⑧ 🔬 沒出錯時送出去的單跟以前的 _send 一模一樣(整張 + 零股、價格、數量、順序)、⛔ 多問永豐一次', p1.orders == p2.orders and p2.q == 0,
   (p1.orders, p2.orders, p2.q))


# ⑨ 收工對帳:買單只成交一部分
def bought(live=True, fill_c=True, fill_o=False, inv=(1000, 0), apply=True):
    fresh(LIVE=live, RECON_APPLY=apply)
    b = Broker({'2330': 101.0})
    st = {'done': [], 'pos': {}, 'd': D}
    A.hot_step(b, sj, st, BULL, PICKS, D)
    if fill_c:
        b.fill(0, 1, 101.0)
    if fill_o:
        b.fill(1, 485, 101.0)
    b.inv = None if inv is None else {'2330': inv}
    rep = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
    return st, rep, b
st, rep, _ = bought()
ok('⑨ 真實帳戶:買 1485 股只成交 1000 股(成交回報 + 永豐庫存都說 1000)→ 紀錄改成 1000 股', st['pos'].get('2330', {}).get('sh') == 1000
   and rep['applied'] == ['2330'], (st.get('pos'), rep, LOGS[-4:]))
st, rep, _ = bought(live=False)
ok('⑨b 模擬帳戶 → 只報告、⛔ 改紀錄(1485 股)', st['pos']['2330']['sh'] == 1485 and '2330' in rep['reported'] and not rep['applied'], rep)
st, rep, _ = bought(apply=False)
ok('⑨c RECON_APPLY=0 → 只報告、⛔ 改紀錄', st['pos']['2330']['sh'] == 1485 and not rep['applied'] and has('RECON_APPLY=0') >= 1, rep)
st, rep, _ = bought(inv=(500, 0))
ok('⑨d 🔬 永豐庫存只有 500 股(跟成交回報的 1000 對不上)→ 只報告、⛔ 改紀錄', st['pos']['2330']['sh'] == 1485 and not rep['applied']
   and has('兩邊對不上') >= 1, (st['pos'], LOGS[-3:]))
st, rep, _ = bought(inv=None)
ok('⑨e 查不到永豐庫存 → 只報告、⛔ 改紀錄', st['pos']['2330']['sh'] == 1485 and not rep['applied'], rep)
st, rep, _ = bought(fill_c=False, inv=(0, 0))
ok('⑨f 整筆都沒成交(0 股)→ 紀錄移除', '2330' not in st['pos'] and rep['applied'] == ['2330'], (st['pos'], rep))
st, rep, _ = bought(fill_o=True, inv=(1485, 0))
ok('⑨g 🔬 對照:全部成交 → 紀錄一個字都不改(1485 股)、標對過了', st['pos']['2330']['sh'] == 1485 and not rep['applied'] and not rep['reported']
   and all(e.get('rc') == 'a' for e in st['ord']), (rep, st['ord']))


# ⑩ 🔥 賣單沒成交 → 收回來 → 隔天補賣
POS = {'e': 100.0, 'sl': 95.0, 'd': '2026-10-01', 'sh': 1000, 'k': 'atr2', 'mh': 20, 'm': 'live'}
fresh(LIVE=True)
A.fetch_klines = lambda s: []
b = Broker({'2330': 90.0})
st = {'pos': {'2330': dict(POS)}, 'd': D}
A.exit_step(b, sj, st)
ok('⑩a 跌破停損送出賣單 → 照舊送出就從紀錄移除(⛔ 重複送)', b.n('2330', 'S') == 1 and '2330' not in st['pos'], (b.trades, st['pos']))
b.inv = {'2330': (1000, 1000)}
rep = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
ok('⑩ 跌停沒賣掉(0 股成交)→ 收回來、標 rs、原本的停損 / 進場價 / 規則都還在', st['pos'].get('2330', {}).get('sh') == 1000
   and st['pos']['2330'].get('rs') == D and st['pos']['2330'].get('sl') == 95.0 and st['pos']['2330'].get('e') == 100.0, (st['pos'], rep))
st = A.reset_day(st, D2)
def boom(sym):
    raise AssertionError('補賣 ⛔ 去看出場線')
A.fetch_klines = boom
b2 = Broker({'2330': 98.0}, inv={'2330': (1000, 1000)})
A.exit_step(b2, sj, st)
ok('⑩b 隔天 🔥 先補賣(⛔ 再看出場線、⛔ 抓 K 線)、送出後紀錄移除', b2.n('2330', 'S') == 1 and '2330' not in st['pos'], (b2.trades, st['pos'], LOGS[-3:]))
fresh(LIVE=True)
A.fetch_klines = lambda s: []
st = {'pos': {'2330': dict(POS)}, 'd': D2}
b3 = Broker({'2330': 98.0}, inv={'2330': (1000, 1000)})
A.exit_step(b3, sj, st)
ok('⑩c 🔬 對照:同一筆沒有 rs、還沒到停損 → 不賣、續抱', b3.n() == 0 and st['pos']['2330']['sh'] == 1000, b3.trades)
fresh(LIVE=True)
A.fetch_klines = lambda s: []
b = Broker({'2330': 90.0})
st = {'pos': {'2330': dict(POS)}, 'd': D}
A.exit_step(b, sj, st)
b.fill(0, 1, 90.0)
b.inv = {'2330': (0, 1000)}
rep = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
ok('⑩d 🔬 對照:賣單全部成交 → ⛔ 收回來(紀錄維持沒有)', '2330' not in st['pos'] and not rep['applied'], (st['pos'], rep))
fresh(LIVE=True)
A.fetch_klines = lambda s: []
b = Broker({'2330': 90.0})
st = {'pos': {'2330': dict(POS)}, 'd': D}
A.exit_step(b, sj, st)
b.trades[0]['st'] = 'Cancelled'                 # 你在永豐 App 把程式的賣單取消了(程式自己從來不取消單)
b.inv = {'2330': (1000, 1000)}
rep = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
ok('⑩e 賣單在永豐是「已取消」(多半是你自己取消的)→ 收回來(⛔ 變成沒人管),但 ⛔ 標補賣、講清楚',
   st['pos'].get('2330', {}).get('sh') == 1000 and not st['pos']['2330'].get('rs') and has('已取消') >= 1, (st['pos'], LOGS[-3:]))
st = A.reset_day(st, D2)
b2 = Broker({'2330': 98.0}, inv={'2330': (1000, 1000)})
A.exit_step(b2, sj, st)
ok('⑩f 隔天照原本的出場規則走:還沒到停損 → 不賣(⛔ 硬賣你取消的那筆)', b2.n() == 0 and st['pos']['2330']['sh'] == 1000, b2.trades)


# ⑪ 👑 補賣:非換倉日也賣;換倉那段 ⛔ 另外再賣
fresh(LIVE=True, LEADER=True)
st = {'lead': {'2001': {'e': 100.0, 'd': '2026-10-01', 'sh': 2000, 'm': 'live', 'rs': D}}, 'd': D2}
b = Broker({'2001': 99.0}, inv={'2001': (2000, 2000)})
A.leader_retry_step(b, sj, st, D2)
ok('⑪ 👑 補賣:不是換倉日也賣 rs 那筆(2000 股)、送出後移除', b.n('2001', 'S') == 2 - 1 and sum(t['q'] for t in b.trades) == 2 and st['lead'] == {},
   (b.trades, st))
fresh(LIVE=True, LEADER=True)
st = {'lead': {'2001': {'e': 100.0, 'd': '2026-10-01', 'sh': 2000, 'm': 'live'}}, 'd': D2}
b = Broker({'2001': 99.0}, inv={'2001': (2000, 2000)})
A.leader_retry_step(b, sj, st, D2)
ok('⑪b 🔬 對照:沒有 rs → 補賣 ⛔ 動', b.n() == 0 and st['lead']['2001']['sh'] == 2000, b.trades)
COLS = ['c', 'chg', 'chg10', 'amt20', 'b20', 'b60', 'lim', 'att', 'etf', 'pos252']
def mkD(date, out=()):
    rows = {str(2000 + i): [100.0, 1.0, (-99 if str(2000 + i) in out else 30.0 - i), 100.0 - i, 3.0, 8.0, 0, 0, 0, 95.0] for i in range(20)}
    return {'data_date': date, 'cols': COLS, 'rows': rows}
TWD = [{'date': d} for d in ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01',
                             '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']]
def lead_rebal(lead, acct=0, window='open', rej=None, px=None):
    setv(LEADER=True, LEADER_WINDOW=window, LEADER_BOOKS=1, LEADER_ANCHOR='2026-09-24', LEADER_ACCOUNT=acct)
    A.fetch_json = lambda rel: mkD('2026-10-08', out=('2003',)) if 'screener' in rel else TWD
    b = Broker(px or {}, rej=rej)
    st = {'pos': {}, 'lead': lead, 'd': '2026-10-09'}
    A.leader_step(b, sj, st, BULL, '2026-10-09')
    return st, b
fresh()
st, b = lead_rebal({'2003': {'e': 100.0, 'd': '2026-09-25', 'sh': 1500, 'm': 'sim', 'rs': '2026-10-08'}})
ok('⑪c 換倉日:掉出前 10 的那檔標了 rs → 換倉那段 ⛔ 另外再賣(交給補賣)', b.n('2003', 'S') == 0 and st['lead']['2003']['sh'] == 1500
   and has('交給補賣') == 1, (b.trades, LOGS[-4:]))
fresh()
st, b = lead_rebal({'2003': {'e': 100.0, 'd': '2026-09-25', 'sh': 1500, 'm': 'sim'}})
ok('⑪d 🔬 對照:同一檔沒有 rs → 換倉照賣', b.n('2003', 'S') >= 1 and '2003' not in st['lead'], b.trades)


# ⑫ 13:36 前 / 週六 → 只報告
for nm, cf in (('平日 13:31(等到上限還是 13:31)', clk(13, 31)), ('週六 13:40', clk(13, 40, day=14))):
    fresh(LIVE=True)
    b = Broker({'2330': 101.0})
    st = {'done': [], 'pos': {}, 'd': D}
    A.hot_step(b, sj, st, BULL, PICKS, D)
    b.fill(0, 1, 101.0); b.inv = {'2330': (1000, 0)}
    rep = A.reconcile_day(b, sj, st, D, now_fn=cf, sleep_fn=NOSLEEP)
    ok(f'⑫ {nm} → 只報告、⛔ 改紀錄(還是 1485 股)', st['pos']['2330']['sh'] == 1485 and not rep['applied'] and not rep['final'], rep)


# ⑬ 跑兩次結果一樣
st, rep, b = bought()
snap = copy.deepcopy(st)
rep2 = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
ok('⑬ 同一天收工對帳跑兩次 → 第二次什麼都不改(紀錄一個字都一樣)', st == snap and not rep2['applied'] and not rep2['reported'], (rep2, st == snap))


# ⑭ 同一檔在 🔥 和 👑 兩本帳
def two_books(inv):
    fresh(LIVE=True, LEADER=True)
    b = Broker({'2330': 90.0})
    st = {'pos': {}, 'lead': {}, 'd': D}
    A._send_j(b, sj, st, '2330', 90.0, 1000, False, 'pos', '2330', D, p=dict(POS))
    A._send_j(b, sj, st, '2330', 90.0, 2000, False, 'lead', '2330', D, p={'e': 80.0, 'd': '2026-10-01', 'sh': 2000, 'm': 'live'})
    b.inv = {'2330': inv}
    rep = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
    return st, rep
st, rep = two_books((3000, 3000))
ok('⑭ 同一檔 🔥 賣 1000 + 👑 賣 2000 都沒成交、永豐庫存 3000 → 兩本帳各自收回(各標 rs)', st['pos'].get('2330', {}).get('sh') == 1000
   and st['lead'].get('2330', {}).get('sh') == 2000 and st['pos']['2330'].get('rs') and st['lead']['2330'].get('rs'), (st, rep))
st, rep = two_books((2000, 3000))
ok('⑭b 🔬 永豐庫存只剩 2000(你可能手動賣了 1000)→ 兩本帳都 ⛔ 收回、只報告(⛔ 猜是哪一本)', '2330' not in st['pos'] and '2330' not in st['lead']
   and '2330' in rep['reported'] and not rep['applied'], (st, rep))


# ⑮ 庫存不夠 → ⛔ 補賣
fresh(LIVE=True, LEADER=True)
st = {'lead': {'2001': {'e': 100.0, 'd': '2026-10-01', 'sh': 2000, 'm': 'live', 'rs': D}}, 'pos': {}, 'd': D2}
b = Broker({'2001': 99.0}, inv={'2001': (500, 2000)})
A.leader_retry_step(b, sj, st, D2); nxt(); A.leader_retry_step(b, sj, st, D2)
ok('⑮ 👑 補賣前永豐庫存只有 500 股(程式記 2000)→ ⛔ 送、紀錄不動、🚨 只講一次', b.n() == 0 and st['lead']['2001']['sh'] == 2000
   and has('永豐庫存只有 500 股') == 1, (b.trades, LOGS[-3:]))
fresh(LIVE=True)
A.fetch_klines = boom
st = {'pos': {'2330': dict(POS, rs=D)}, 'd': D2}
b = Broker({'2330': 98.0}, inv=None)
A.exit_step(b, sj, st)
ok('⑮b 🔥 補賣前查不到永豐庫存 → 這一輪 ⛔ 送', b.n() == 0 and st['pos']['2330']['sh'] == 1000, b.trades)
fresh(LIVE=False, LEADER=True)
st = {'lead': {'2001': {'e': 100.0, 'd': '2026-10-01', 'sh': 2000, 'm': 'sim', 'rs': D}}, 'd': D2}
b = Broker({'2001': 99.0}, inv=None)
A.leader_retry_step(b, sj, st, D2)
ok('⑮c 模擬帳戶補賣 ⛔ 查庫存(模擬帳戶的庫存不準)→ 照賣', sum(t['q'] for t in b.trades) == 2 and st['lead'] == {}, b.trades)


# ⑯ 30 天成交紀錄掃描只報一次
fresh(LIVE=True)
fl = os.path.join(tempfile.mkdtemp(), 'f.jsonl')
with open(fl, 'w', encoding='utf-8') as f:
    for r in ({'d': '2026-10-30', 'oid': 'X1', 'lot': 'C', 'sym': '3008', 'side': 'S', 'q': 2000, 'fq': 0, 'own': True, 'm': 'live'},
              {'d': '2026-10-30', 'oid': 'X2', 'lot': 'C', 'sym': '2454', 'side': 'S', 'q': 1000, 'fq': 1000, 'own': True, 'm': 'live'},
              {'d': '2026-10-30', 'oid': 'X3', 'lot': 'C', 'sym': '1101', 'side': 'S', 'q': 1000, 'fq': 0, 'own': False, 'm': 'live'},
              {'d': '2026-09-01', 'oid': 'X4', 'lot': 'C', 'sym': '2603', 'side': 'S', 'q': 1000, 'fq': 0, 'own': True, 'm': 'live'}):
        f.write(json.dumps(r) + '\n')
A.FILLS_LOG = fl
st = {'d': D, 'pos': {}}
A.reconcile_day(Broker(), sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
first = has('以前程式送的賣單沒賣完')
A.reconcile_day(Broker(), sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
ok('⑯ 第一次跑新版:30 天內程式自己送、沒賣完的賣單列出來(只有 3008;全部成交 / 你手動的 / 30 天前的都不列)、第二次 ⛔ 再列',
   first == 1 and has('3008') >= 1 and not has('2603') and not has('1101') and has('以前程式送的賣單沒賣完') == 1 and st.get('recon_v') == 1, LOGS[-6:])


# ⑰ 出錯照樣收工、回傳 1
def run_main(raise_in_hot):
    fresh()
    tmp = tempfile.mkdtemp()
    A.STATE_PATH, A._STATE_LIVE = os.path.join(tmp, 's.json'), os.path.join(tmp, 'live.json')
    calls = []
    b = Broker({'2330': 101.0})
    b.login = lambda **k: calls.append('login')
    b.logout = lambda: calls.append('logout')
    sys.modules['shioaji'] = NS(Shioaji=lambda simulation=True: b, constant=C)
    os.environ['SHIOAJI_API_KEY'], os.environ['SHIOAJI_SECRET_KEY'] = 'x', 'y'
    seq = [clk(13, 5)(), clk(13, 5)(), clk(13, 5)(), clk(13, 29)()]
    A.tpe_now = lambda: seq.pop(0) if len(seq) > 1 else seq[0]
    A.fetch_picks = lambda: (BULL, PICKS)
    def hot(*a, **k):
        calls.append('hot')
        if raise_in_hot:
            raise KeyError('名單少一個欄位(假)')
    A.hot_step = hot
    A.fills_report = lambda *a, **k: calls.append('fills')
    A.reconcile_day = lambda *a, **k: calls.append('recon')
    orig = A.time.sleep
    A.time.sleep = lambda s: None
    try:
        rc = A.main()
    except Exception as e:     # 沒接住 = 整支停下來(收工、對帳、登出都沒做)
        rc = f'沒接住:{type(e).__name__}'
    finally:
        A.time.sleep = orig
    return rc, calls
_keep = (A.tpe_now, A.fetch_picks, A.hot_step, A.fills_report, A.reconcile_day, A.STATE_PATH, A._STATE_LIVE)
rc, calls = run_main(True)
ok('⑰ 主迴圈出錯 → 🚨 + 錯誤訊息進 log、⛔ 再跑下一輪,照樣收工記成交 + 對帳 + 登出、回傳 1',
   rc == 1 and calls == ['login', 'hot', 'fills', 'recon', 'logout'] and has('程式出錯停下來了') == 1 and has('KeyError') >= 1, (rc, calls, LOGS[-5:]))
rc, calls = run_main(False)
ok('⑰b 🔬 對照:沒出錯 → 跑到收盤時間收工、回傳 0', rc == 0 and calls == ['login', 'hot', 'fills', 'recon', 'logout'], (rc, calls))
A.tpe_now, A.fetch_picks, A.hot_step, A.fills_report, A.reconcile_day, A.STATE_PATH, A._STATE_LIVE = _keep
sys.modules.pop('shioaji', None)


# ⑱ 虧損安全鎖
ok('⑱a 已實現損益:進場 100、賣 1000 股均價 90 → −10,000 − 手續費 270.75 − 證交稅 270 = −10,541 元',
   A._realized({'sym': '2330', 'p': {'e': 100.0}}, 1000, 90.0) == -10541)
ok('⑱a2 ETF 證交稅 0.1%;讀不到進場價 → None(⛔ 猜)', A._realized({'sym': '0050', 'p': {'e': 100.0}}, 1000, 110.0) == round(10000 - 210 * 1.425 - 110)
   and A._realized({'sym': '2330', 'p': {}}, 1000, 90.0) is None)
fresh(LIVE=True)
A.fetch_klines = lambda s: []
b = Broker({'2330': 90.0})
st = {'pos': {'2330': dict(POS)}, 'd': D}
A.exit_step(b, sj, st)
b.fill(0, 1, 90.0); b.inv = {'2330': (0, 1000)}
A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
p1 = (st.get('pnl') or {}).get('2026-11')
A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
ok('⑱b 收工對帳把程式自己賣掉的算成本月已實現損益(−10,541),跑兩次 ⛔ 重複算', p1 == -10541 and st['pnl']['2026-11'] == -10541, st.get('pnl'))
def lock_case(pnl, pct=3.0, day=D, acct=1_000_000):
    fresh(LOSS_LOCK_PCT=pct, ACCOUNT_SIZE=acct)
    b = Broker({'2330': 101.0})
    st = {'done': [], 'pos': {}, 'd': day, 'pnl': {'2026-11': pnl}}
    A.hot_step(b, sj, st, BULL, PICKS, day)
    return b.n()
_n30 = lock_case(-30000)
ok('⑱ 本月已實現 −30,000(= 本金 100 萬的 3.0%)→ 🔒 鎖住:⛔ 買新的 🔥、講一次為什麼', _n30 == 0 and has('本月已實現虧損') == 1, (_n30, LOGS[-3:]))
ok('⑱c 🔬 −29,000(2.9%)→ 不鎖、照買', lock_case(-29000) == 2)
ok('⑱d 🔬 LOSS_LOCK_PCT=0(預設)→ 關:虧再多都照買', lock_case(-500000, pct=0) == 2)
ok('⑱e 🔬 換月(12 月)→ 自動解開', lock_case(-30000, day='2026-12-01') == 2)
ok('⑱f 沒設本金 → 鎖沒作用(照買)而且講出來', lock_case(-30000, acct=0) >= 1 and has('虧損安全鎖沒作用') == 1)
ok('⑱g 預設值:LOSS_LOCK_PCT 0、RECON_APPLY 開、13:36 對帳、出錯等 55 秒', DEF['LOSS_LOCK_PCT'] == 0 and DEF['RECON_APPLY'] is True
   and A.RECON_FROM == 13 * 60 + 36 and A.GATE_WAIT_SEC == 55)
fresh(LOSS_LOCK_PCT=3.0, LEADER=True, LEADER_ACCOUNT=1_000_000, ACCOUNT_SIZE=0)
ok('⑱h 👑 的錢也算進本金(只開 👑:100 萬的 3% = 3 萬)', A._loss_locked({'pnl': {'2026-11': -30000}}, D) is True
   and A._loss_locked({'pnl': {'2026-11': -29000}}, D) is False)


# ⑲ 狀態沒定案 / 成交回報對不上 / 兩次查的不一樣 → 只報告
def odd_case(mut):
    fresh(LIVE=True)
    b = Broker({'2330': 101.0})
    st = {'done': [], 'pos': {}, 'd': D}
    A.hot_step(b, sj, st, BULL, PICKS, D)
    b.inv = {'2330': (1000, 0)}
    sl = mut(b)
    rep = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=sl or NOSLEEP)
    return st, rep
def m_pending(b):
    b.fill(0, 1, 101.0); b.trades[1]['st'] = 'PendingSubmit'
st, rep = odd_case(m_pending)
ok('⑲ 零股那筆永豐還是「PendingSubmit」(沒定案)→ 那檔只報告、⛔ 改紀錄', st['pos']['2330']['sh'] == 1485 and not rep['applied'], rep)
def m_nodeal(b):
    b.trades[0]['st'] = 'Filled'; b.trades[0]['dq'] = 1; b.fill(1, 0, 101.0, 'Cancelled')
st, rep = odd_case(m_nodeal)
ok('⑲b 永豐說「全部成交」但沒有逐筆成交 → 成交回報自己對不上 → 只報告', st['pos']['2330']['sh'] == 1485 and not rep['applied']
   and has('成交回報自己對不上') >= 1, (rep, LOGS[-3:]))
def m_change(b):
    b.fill(0, 1, 101.0)
    return lambda s: b.fill(1, 100, 101.0, 'PartFilled')
st, rep = odd_case(m_change)
ok('⑲c 隔 60 秒查兩次、零股那筆成交數變了(永豐還在更新)→ 那筆只報告、⛔ 改紀錄', st['pos']['2330']['sh'] == 1485 and not rep['applied']
   and has('查兩次結果不一樣') >= 1, (rep, LOGS[-3:]))


# ⑳ 程式當成沒送出、永豐其實有 → 🚨
fresh(LIVE=True)
b = Broker({'2330': 101.0}, att={('2330', 'C')})
st = {'done': [], 'pos': {}, 'd': D}
A.hot_step(b, sj, st, BULL, PICKS, D)          # 收單後逾時 → 程式以為沒送出;之後沒有下一輪了(收盤)
b.fill(0, 1, 101.0); b.inv = {'2330': (1000, 0)}
rep = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
ok('⑳ 收工時:程式當成沒送出的那筆其實在永豐、還成交了 → 🚨 講出來(⛔ 自己補紀錄)', '2330' in rep['reported'] and st['pos'] == {}
   and has('程式當成沒送出,但永豐其實有這筆') == 1, (rep, LOGS[-3:]))
# ⑳b 永豐給的委託時間跟我們想的時區不一樣(差 8 小時)→ 送單守門照樣保守(⛔ 認、⛔ 重送),收工照樣講出來
fresh(LIVE=True)
b = Broker({'2330': 101.0}, att={('2330', 'C')})
st = {'done': [], 'pos': {}, 'd': D}
A.hot_step(b, sj, st, BULL, PICKS, D)
b.trades[0]['ot'] = CLK[0] - 8 * 3600          # 永豐的時間被讀成早 8 小時
nxt(); A.hot_step(b, sj, st, BULL, PICKS, D)   # 下一輪:時間對不上 → 當成「可能是你手動下的」→ ⛔ 重送
_c1 = b.n('2330', 'B', 'C')
b.fill(0, 1, 101.0); b.inv = {'2330': (1000, 0)}
rep = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
ok('⑳b 永豐的委託時間跟我們差 8 小時(時區讀錯)→ 下一輪 ⛔ 認也 ⛔ 重送(整張只有 1 筆)、收工照樣 🚨 講出來',
   _c1 == 1 and '2330' in rep['reported'] and st['pos'] == {} and has('程式當成沒送出,但永豐其實有這筆') == 1, (_c1, rep, LOGS[-4:]))


# ㉑ 委託紀錄只留 14 天
st = A.reset_day({'d': '2026-11-06', 'ord': [{'d': '2026-10-25', 'k': 1}, {'d': '2026-10-26', 'k': 2}, {'d': '2026-11-06', 'k': 3}],
                  'pnl': {f'2024-{m:02d}': 1 for m in range(1, 13)} | {f'2025-{m:02d}': 1 for m in range(1, 13)} | {'2026-11': -5}}, D)
ok('㉑ 每天重置:委託紀錄只留 14 天(11/09 起算:10/25 刪掉、10/26 留著)、已實現損益只留 24 個月、⛔ 動其他欄位', [e['k'] for e in st['ord']] == [2, 3]
   and len(st['pnl']) == 24 and st['pnl'].get('2026-11') == -5 and '2024-01' not in st['pnl'], st)


# ㉒ 每筆記規則版本
fresh()
b = Broker({'2330': 101.0})
st = {'done': [], 'pos': {}, 'd': D}
A.hot_step(b, sj, st, BULL, PICKS, D)
p = st['pos']['2330']
ok('㉒ 🔥 每筆記照哪一版規則買的:排法 / 名單日期 / 位階門檻 / 空頭守門', p.get('hr') == A.HOT_RULE and p.get('dd') == '2026-11-06'
   and p.get('gr') == A.GENE_RANK and p.get('bg') == 0, p)
fresh()
st, b = lead_rebal({}, acct=1_000_000, px={str(2000 + i): 100.0 for i in range(20)})
lp = st['lead'].get('2000') or {}
ok('㉒b 👑 每筆記錨點 / 哪本帳 / 規則 / 名單日期', lp.get('an') == '2026-09-24' and lp.get('bk') == 'lead' and lp.get('ld') == '2026-10-08'
   and str(lp.get('lr', '')).startswith('U100N5'), lp)


# ㉓ 兩個以前會讓整支停下來的呼叫
fresh()
st, b = lead_rebal({'2003': {'e': 100.0, 'd': '2026-09-25', 'sh': 1500, 'm': 'sim'}}, window='split')
ok('㉓ 👑 split 換倉:要賣的那檔報價只抓一次(以前在 try 外面再抓一次,出錯整支停下來)', b.snap_calls.get('2003') == 1, b.snap_calls)
fresh()
b = Broker({'2330': 101.0})
st = {'done': [], 'pos': {}, 'd': D}
err = None
try:
    A.hot_step(b, sj, st, BULL, [{'s': '2330', 'trig': 100.0, 'stop': None}], D)
except Exception as e:
    err = e
ok('㉓b 🔥 名單上的停損價是空的 → 跳過那檔、⛔ 整支停下來(以前 float(None) 丟例外)、⛔ 沒有停損就不買', err is None and b.n() == 0
   and '2330' in st['done'], (err, b.trades))


# ㉔ 👑 換倉日一股都沒送出 → 今天稍後再試
fresh()
st, b = lead_rebal({'2003': {'e': 100.0, 'd': '2026-09-25', 'sh': 1500, 'm': 'sim'}}, rej={('2003', 'C'): 1})
ok('㉔ 👑 換倉日賣單一股都沒送出 → 放進今天稍後要賣的(以前要等到下次換倉 = 10 個交易日沒人管)', (st.get('lead_defer') or {}).get('sell') == ['2003']
   and st['lead']['2003']['sh'] == 1500, (st.get('lead_defer'), b.trades))
nxt(); A.leader_defer_step(b, sj, st, '2026-10-09', 'sell')
ok('㉔b 稍後那一輪:先問永豐確定沒收到 → 賣出、從紀錄與清單移除', b.n('2003', 'S') == 2 and '2003' not in st['lead']
   and st['lead_defer']['sell'] == [], (b.trades, st.get('lead')))


# ㉖ 以前那幾天沒對到帳的單(那天電腦 13:36 前就關了 / 程式中途停下來)→ 開工時列出來(⛔ 只報告、只列一次)
fresh()
D0 = '2026-11-06'
def oe(**kw):
    e = {'d': D0, 'ts': 1.0, 'book': 'pos', 'sym': '2330', 'side': 'S', 'lot': 'C', 'q': 1000, 'px': 100.0, 'st': 'ok', 'oid': 'X1', 'm': 'sim'}
    e.update(kw); return e
st = {'d': D, 'done': [], 'pos': {}, 'ord': [
    oe(),                                              # 送出的賣單、那天沒對帳 → 列
    oe(sym='2603', side='B', st='?', oid=''),          # 送單出錯、也沒對帳 → 列
    oe(sym='1101', rc='a'),                            # 對過了 → ⛔ 列
    oe(sym='2317', st='gone', oid=''),                 # 查過確定沒收到 → ⛔ 列
    oe(sym='2454', d=D),                               # 今天的 → 收工對帳管,⛔ 這裡列
    oe(sym='3008', m='live'),                          # 另一個帳戶(真實)的 → ⛔ 列
]}
n1 = A._recon_prev_days(st, D)
n2 = A._recon_prev_days(st, D)
ok('㉖ 以前沒對到帳的單開工時列出來(只有 2330 賣 / 2603 買那兩筆;對過的 / 查過確定沒收到的 / 今天的 / 另一個帳戶的都不列)、第二次 ⛔ 再列',
   n1 == 2 and n2 == 0 and has('2330') >= 1 and has('2603') >= 1 and not has('1101') and not has('2317') and not has('2454') and not has('3008')
   and has('沒人管') == 1 and has('只列這一次') == 1 and [e.get('rc') for e in st['ord']] == ['p', 'p', 'a', None, None, None], (n1, n2, LOGS[-4:]))
ok('㉖b ⛔ 改部位紀錄(只報告)', st['pos'] == {}, st['pos'])
fresh()
st = {'d': D, 'done': [], 'pos': {}, 'ord': [oe(rc='a'), oe(sym='2317', st='gone')]}
ok('㉖c 🔬 對照:以前的都對過了 → 一行都不印', A._recon_prev_days(st, D) == 0 and LOGS == [], LOGS)
# 中途出錯(10:00)→ 收工對帳 ⛔ 乾等到 13:36、只報告;隔天開工列出來
fresh(LIVE=True)
b = Broker({'2330': 101.0})
st = {'done': [], 'pos': {}, 'd': D}
A.hot_step(b, sj, st, BULL, PICKS, D)
slept = []
rep = A.reconcile_day(b, sj, st, D, now_fn=clk(10, 0), sleep_fn=lambda s: slept.append(s))
ok('㉖d 程式 10:00 就停下來 → 收工對帳 ⛔ 乾等 3 小時(只等兩次查詢中間那 60 秒)、只報告、⛔ 改紀錄',
   slept == [A.RECON_GAP_SEC] and not rep['final'] and not rep['applied'] and st['pos']['2330']['sh'] == 1485
   and has('下一次開工會把今天沒對到的單列出來') == 1, (slept, rep))
st2 = A.reset_day(st, D2)
n = A._recon_prev_days(st2, D2)
ok('㉖e 隔天開工:前一天沒對到帳的那 2 筆(整張 + 零股)列出來', n == 2 and has('沒對到帳') >= 2, (n, LOGS[-3:]))



# ㉗ ✂️ V82.0.7 收一半那筆沒成交:只收回那幾股、標 rt(⛔ 標 rs —— 那會隔天整檔賣光)
LPOS = {'e': 100.0, 'd': '2026-10-01', 'sh': 2000, 'm': 'live'}
def trimmed(inv, fill=None, st_=None):
    fresh(LIVE=True, LEADER=True)
    b = Broker({'2001': 90.0})
    st = {'pos': {}, 'lead': {'2001': dict(LPOS, sh=1000)}, 'd': D}
    A._send_j(b, sj, st, '2001', 90.0, 1000, False, 'lead', '2001', D, p=dict(LPOS), tr=1)   # 收一半:賣 1,000 股(紀錄已先扣成 1,000)
    if fill:
        b.fill(0, *fill)
    if st_:
        b.trades[0]['st'] = st_
    b.inv = {'2001': inv}
    rep = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
    return st, rep
st, rep = trimmed((2000, 2000))
ok('㉗a 收一半那 1,000 股沒成交(跌停)、永豐庫存 2,000 → 收回來(2,000 股)、標 rt=1,000、⛔ 標 rs(⛔ 隔天整檔賣)',
   st['lead']['2001']['sh'] == 2000 and st['lead']['2001'].get('rt') == 1000 and not st['lead']['2001'].get('rs')
   and '2001' in rep['applied'] and has('只補賣這 1,000 股') == 1, (st['lead'], rep, LOGS[-3:]))
ok('㉗a2 收工對帳那一行也列出「收一半 1,000 股」要補賣', has('收一半 1,000 股') >= 1, LOGS[-2:])
fresh(LIVE=True, LEADER=True)
b = Broker({'2001': 90.0})
st = {'pos': {}, 'lead': {'2001': dict(LPOS, sh=1000)}, 'd': D}
A._send_j(b, sj, st, '2001', 90.0, 1000, False, 'lead', '2001', D, p=dict(LPOS))          # 🔬 對照:同一筆不標 tr
b.inv = {'2001': (2000, 2000)}
A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
ok('㉗b 🔬 對照:同一筆不標 tr → 舊規則(標 rs = 隔天整檔賣)—— 證明是 tr 在決定', st['lead']['2001'].get('rs') == D and not st['lead']['2001'].get('rt'), st['lead'])
st, rep = trimmed((2000, 2000))
st = A.reset_day(st, D2)
b2 = Broker({'2001': 88.0}, inv={'2001': (2000, 2000)})
ok('㉗c0 隔天:有要補賣的 rt(⛔ 算成 rs)', A._has_rs(st, ('lead',), 'rt') and not A._has_rs(st, ('lead',), 'rs'))
A.leader_retry_step(b2, sj, st, D2, 'rs')
n_rs = len(b2.trades)
A.leader_retry_step(b2, sj, st, D2, 'rt')
ok('㉗c 隔天補賣:只賣那 1,000 股(⛔ 整檔 2,000)、留 1,000 股、rt 拿掉、委託標 tr',
   n_rs == 0 and sum(t['q'] for t in b2.trades) == 1 and b2.trades[0]['lot'] == 'C' and st['lead']['2001']['sh'] == 1000
   and 'rt' not in st['lead']['2001'] and [e.get('tr') for e in A._ord_today(st, D2)] == [1], (b2.trades, st['lead']))
st, rep = trimmed((2000, 2000))
st = A.reset_day(st, D2)
b3 = Broker({'2001': 88.0}, inv={'2001': (1500, 2000)})
A.leader_retry_step(b3, sj, st, D2, 'rt')
ok('㉗c2 補賣前永豐庫存只有 1,500 股(程式記 2,000)→ ⛔ 送、紀錄不動', b3.n() == 0 and st['lead']['2001']['sh'] == 2000 and st['lead']['2001'].get('rt') == 1000, b3.trades)
fresh(LIVE=True, LEADER=True)
b = Broker({'2001': 90.0})
st = {'pos': {}, 'lead': {'2001': dict(LPOS, sh=600)}, 'd': D}
A._send_j(b, sj, st, '2001', 90.0, 600, False, 'lead', '2001', D, p=dict(LPOS, sh=1200), tr=1)   # 收一半:1,200 股賣 600 股(零股)
b.fill(0, 400, 90.0, 'PartFilled')
b.inv = {'2001': (800, 1200)}
rep = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
ok('㉗d 收一半 600 股只成交 400 股 → 只收回沒賣掉的 200 股(800 股)、rt=200', st['lead']['2001']['sh'] == 800 and st['lead']['2001'].get('rt') == 200,
   (st['lead'], rep))
st, rep = trimmed((2000, 2000), st_='Cancelled')
ok('㉗e 收一半那筆在永豐是「已取消」(多半是你取消的)→ 收回來、⛔ 標補賣(⛔ 硬賣)', st['lead']['2001']['sh'] == 2000 and not st['lead']['2001'].get('rt')
   and not st['lead']['2001'].get('rs') and has('已取消') >= 1, (st['lead'], LOGS[-3:]))
fresh(LIVE=True, LEADER=True)
b = Broker({'2001': 90.0})
st = {'pos': {}, 'lead': {}, 'd': D}
A._send_j(b, sj, st, '2001', 90.0, 1000, False, 'lead', '2001', D, p=dict(LPOS), tr=1)
b.inv = {'2001': (2000, 2000)}
rep = A.reconcile_day(b, sj, st, D, now_fn=clk(13, 40), sleep_fn=NOSLEEP)
ok('㉗f 收一半沒成交、但程式已經沒有這一檔的紀錄 → ⛔ 改紀錄、只報告', st['lead'] == {} and '2001' in rep['reported'] and not rep['applied'], (st['lead'], rep))
st, rep = trimmed((2000, 2000))
ok('㉗g 已實現損益:收一半那筆沒成交 → 0 元(⛔ 算成賠或賺)', (st.get('pnl') or {}).get('2026-11') in (None, 0), st.get('pnl'))


# ㉕ 靜態
src = open(A.__file__, encoding='utf-8').read()
tree = ast.parse(src)
fn = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
def calls_of(n):
    out = set()
    for x in ast.walk(n):
        if isinstance(x, ast.Call):
            f = x.func
            out.add(f.attr if isinstance(f, ast.Attribute) else getattr(f, 'id', ''))
    return out
bad = {'place_order', 'cancel_order', 'update_order', '_send', '_send_j'}
used = set().union(*(calls_of(fn[k]) for k in ('reconcile_day', '_recon_scan_old', '_recon_prev_days', '_row_of', '_realized', '_broker_inv', '_send_gate', '_claim_rows')))
ok('㉕ 收工對帳 / 送單守門那幾支 ⛔ 下單 / 刪單 / 改單(只讀永豐)', not (used & bad), used & bad)
ok('㉕b 每筆上限 1 張 / 10 萬、真實帳戶 0050 只預覽(PARK_LIVE_OK)一個字都沒改',
   "MAX_LOTS_PER_TRADE = int(os.getenv('MAX_LOTS_PER_TRADE', '1'))" in src and "MAX_AMT_PER_TRADE = int(os.getenv('MAX_AMT_PER_TRADE', '100000'))" in src
   and '\nPARK_LIVE_OK = False\n' in src)
senders = [k for k in ('leader_step', '_buy_one', 'leader_defer_step', 'exit_step', 'hot_step', 'park_step', 'leader_retry_step', '_trim_one')
           if '_send_j' in calls_of(fn[k])]
direct = [k for k, n in fn.items() if k != '_send_j' and '_send' in calls_of(n)]
ok('㉕c 8 個送單點(含 ✂️ 收一半 _trim_one)都走 _send_j(先記紀錄、出錯先問永豐);直接叫 _send 的只剩 _send_j 自己', len(senders) == 8 and direct == [], (senders, direct))
ok('㉕e ✂️ 收一半補賣(_retry_trim)只透過 _trim_one 送單(⛔ 自己另寫一份)', '_trim_one' in calls_of(fn['_retry_trim']) and '_send_j' not in calls_of(fn['_retry_trim']))
ok('㉕d park_step 買賣兩處都走 _send_j', ast.get_source_segment(src, fn['park_step']).count('_send_j(') == 2)

for k, v in DEF.items():
    setattr(A, k, v)
print(f"\n{'✅' if not bad_n else '❌'} AUTO_RECON {ok_n}/{ok_n + bad_n}" + (f"(INJECT={INJ})" if INJ else ''))
sys.exit(1 if bad_n else 0)
