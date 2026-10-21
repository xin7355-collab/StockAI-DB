#!/usr/bin/env python3
"""📶 V79.4.8 逐筆「只抓上一拍之後的新成交」守門(tick_flow_miner.collect_ticks)

🚨 為什麼要這支:永豐帳號每天流量 524 MB,舊寫法每 10 分鐘把前 80 檔「開盤到現在的全部逐筆」重抓一次,
   2026-10-21 13:03 就用完 → 13:30 收盤那一拍快照與逐筆都沒有。改成增量之後,⛔ 數字必須跟整天重抓一模一樣
   (內外盤 / 大單 / 最大單筆 / 筆數),而沙箱連不到永豐 → 用假行情商重放一整天。

釘住:
  ① 一整天 27 拍(09:03~13:23),每一拍的輸出 == 同一時刻整天重抓(逐欄相同);抓的筆數 < 整天重抓的 25%
  ② 邊界:同一個時間戳有好幾筆、拍子切在同一秒中間 → 不重複算、不漏算(_after / _upto 直接測)
  ③ 某一檔區間查詢丟例外 → 那一檔改整天重抓,輸出照樣正確
  ④ 時間戳是真的 UTC(差 8 小時)→ 自己判得出來,輸出正確、照樣省流量
  ⑤ ⭐ 行情商的區間查詢「不含起點那一秒」→ 起點往前多抓 1 秒,照樣每一拍都正確;
     決定性對照:拿掉那 1 秒 → 一定會漏算(而且每一拍都對帳 → 當天就改回整天重抓)
  ⑥ 區間查詢每 10 筆漏 1 筆 → 對帳抓得到
  ⑦ 換一天 → 狀態歸零;新進榜的那一檔先整天抓一次再接著增量
  ⑧ 對照組:TICK_INCR 關掉 → 抓的筆數 ≈ 整天重抓(證明 ① 那個 25% 有鑑別力)
  ⑨ 沒有時間戳(舊版 shioaji)→ 每拍整天重抓,輸出正確
  ⑩ main 有接上:載入 / 存檔狀態、區間查詢常數、TICK_INCR 逃生門;舊的「每拍整天重抓」迴圈不可復活

跑法:python3 scripts/test_tick_incr.py
"""
import os
import random
import sys
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import tick_flow_miner as M  # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond or not extra else f'  ・{str(extra)[:300]}'))
    if not cond:
        fails.append(name)


RANGE = object()          # 假的 TicksQueryType.RangeTime
DAY = '2026-10-21'
E9 = 10 ** 9


def tw_ns(h, m, s=0, frac=0.0):
    """台北時間 → 「直接當台北時間」那種時間戳(奈秒)"""
    return int((datetime(2026, 10, 21, h, m, s) - datetime(1970, 1, 1)).total_seconds() * E9 + frac * E9)


class T:
    def __init__(self, ts, vol, typ):
        self.ts, self.volume, self.tick_type = ts, vol, typ


class C:
    def __init__(self, code):
        self.code = code


class FakeApi:
    """一整天的逐筆(每檔固定種子),now_ns 之前的才看得到。
    conv='wall':時間戳直接是台北時間;'epoch':真的 UTC(少 8 小時)。
    bad:'exclusive' 區間不含起點那一秒 / 'drop' 每 10 筆漏 1 筆 / 'raise:<code>' 那一檔區間查詢丟例外 / 'nots' 沒有時間戳"""

    def __init__(self, codes, conv='wall', bad=None, dense=('2330',)):
        self.conv, self.bad, self.now = conv, bad or '', 0
        self.got = 0
        self.day = {}
        for code in codes:
            rnd = random.Random(int(code))
            t, rows = tw_ns(9, 0, 0, 0.05), []
            step = 0.4 if code in dense else 9.0          # 2330 一秒好幾筆(拍子一定切在同一秒中間)
            while t < tw_ns(13, 30):
                k = 3 if rnd.random() < 0.08 else 1        # 8% 的時間戳有 3 筆一模一樣的
                for _ in range(k):
                    v = rnd.choice([1, 1, 2, 3, 5, 10, 20, 60, 120]) if rnd.random() < 0.97 else 300
                    rows.append((t, v, rnd.choice([0, 1, 1, 2, 2])))
                t += int(rnd.expovariate(1 / step) * E9) + 1
            self.day[code] = rows

    def _shift(self, ts):
        return ts - 8 * 3600 * E9 if self.conv == 'epoch' else ts

    def _hms_wall(self, ts_wall):
        return (datetime(1970, 1, 1) + timedelta(seconds=ts_wall // E9)).strftime('%H:%M:%S')

    def ticks(self, contract, date, query_type=None, time_start=None, time_end=None):
        code = contract.code
        rows = [r for r in self.day[code] if r[0] <= self.now]
        if query_type is RANGE:
            if self.bad == f'raise:{code}':
                raise RuntimeError('假的行情商:區間查詢壞掉')
            if self.bad == 'exclusive':
                rows = [r for r in rows if time_start < self._hms_wall(r[0]) <= time_end]
            else:
                rows = [r for r in rows if time_start <= self._hms_wall(r[0]) <= time_end]
            if self.bad == 'drop':
                rows = [r for i, r in enumerate(rows) if i % 10 != 9]
        self.got += len(rows)
        ts = [] if self.bad == 'nots' else [self._shift(r[0]) for r in rows]
        return T(ts, [r[1] for r in rows], [r[2] for r in rows])


def ref_out(api, codes):
    """同一時刻整天重抓的答案(用舊寫法的那一套加總)"""
    out = {}
    for code in codes:
        rows = [r for r in api.day[code] if r[0] <= api.now]
        a = M._agg([r[1] for r in rows], [r[2] for r in rows])
        if a['n'] <= 0 or a['in'] + a['out'] <= 0:
            continue
        out[code] = {'in': int(round(a['in'])), 'out': int(round(a['out'])), 'bb': int(round(a['bb'])),
                     'bs': int(round(a['bs'])), 'mx': int(round(a['mx'])), 'n': int(a['n'])}
    return out


BEATS = [tw_ns(9, 3, 0, 0.5) + i * 600 * E9 for i in range(27)]     # 09:03:00.5 起每 10 分(切在一秒中間)
CODES = ['2330', '2317', '2454', '3231', '2603']
BIG = CODES + [str(1101 + 7 * i) for i in range(25)]          # 30 檔(2 檔一秒好幾筆)—— 量流量用,比較接近真實的 80 檔


BADS = {}


def day_run(api, codes_at=None, incr=True, qt=RANGE, S=None, logs=None, codes=None):
    """跑一整天,回 (每一拍都一致?, 不一致的第一拍, 最後的狀態, 抓的筆數);BADS['last'] = 每一拍對不對的清單"""
    S = S or M.load_state(DAY, path='/nonexistent/x')
    bad_beat, good = None, []
    for bi, now in enumerate(BEATS):
        api.now = now
        cs = codes_at(bi) if codes_at else (codes or CODES)
        hot = [(0, c, C(c)) for c in cs]
        out, _st = M.collect_ticks(api, hot, DAY, S, qt_range=qt, incr=incr,
                                   log=(logs.append if logs is not None else (lambda *_: None)), pause=0)
        ref = ref_out(api, cs)
        good.append(out == ref)
        if out != ref and bad_beat is None:
            bad_beat = (bi, sorted(set(out) ^ set(ref)) or [c for c in out if out[c] != ref.get(c)][:3])
    BADS['last'] = good
    return bad_beat is None, bad_beat, S, api.got


# ── ①⑧ 一整天:每一拍都跟整天重抓一樣,而且省流量(對照組:關掉增量)──
full_api = FakeApi(CODES)
okF, badF, _, got_full = day_run(full_api, incr=False)
ok('⑧ 對照組:關掉增量 → 每一拍都跟整天重抓一樣(這是舊寫法)', okF, badF)
api = FakeApi(CODES)
logs = []
ok1, bad1, S1, got_inc = day_run(api, logs=logs)
ok('① 只抓新增的:一整天 27 拍,每一拍的內外盤 / 大單 / 最大單筆 / 筆數都跟整天重抓一模一樣', ok1, bad1)
# 流量:30 檔(比較接近真實的 80 檔)—— 含每一拍的對帳 / 不含對帳 分開量
_, _, _, gF = day_run(FakeApi(BIG), incr=False, codes=BIG)
okB, badB, _, gI = day_run(FakeApi(BIG), codes=BIG)
ok('① 30 檔一整天也是每一拍都一模一樣', okB, badB)
ratio = gI / max(gF, 1)
ok(f'① 含每一拍對帳,抓的筆數只有整天重抓的 {ratio:.1%}(< 25%;⭐ 對照組那邊是 100%)', ratio < 0.25, (gI, gF))
_sv = M.CHECK_EVERY
M.CHECK_EVERY = 10 ** 9
_, _, _, gN = day_run(FakeApi(BIG), codes=BIG)
M.CHECK_EVERY = _sv
ok(f'① 不含對帳只有 {gN / max(gF, 1):.1%}(< 15%;對帳一拍只抽一檔)', gN / max(gF, 1) < 0.15, (gN, gF))
ok('① 對帳每一拍都有跑(26 次增量拍)而且都相同', sum('對帳' in x and '✅' in x for x in logs) >= 26 and not S1.get('off'),
   [x for x in logs if '對帳' in x][:3])

# ── ② 邊界(直接測)──
ts = [100, 200, 200, 200, 300]
v = [1, 2, 3, 4, 5]
ty = [1, 1, 2, 1, 2]
nv, nt, nl, nc = M._after(ts, v, ty, 200, 2)        # 上一拍算到 200 的前 2 筆 → 這一拍要拿 200 的第 3 筆 + 300
ok('② 同一個時間戳有 3 筆、上一拍只算到前 2 筆 → 這一拍只拿第 3 筆和之後的', nv == [4, 5] and (nl, nc) == (300, 1), (nv, nl, nc))
nv, nt, nl, nc = M._after([200, 200], [2, 3], [1, 2], 200, 2)
ok('② 沒有新的 → 什麼都不加、狀態不變', nv == [] and (nl, nc) == (200, 2), (nv, nl, nc))
kv, kt = M._upto(ts, v, ty, 200, 2)
ok('② 對帳截斷:時間 < 200 全收、= 200 只收前 2 筆', kv == [1, 2, 3], kv)
ok('② 時間換算用整數秒(⛔ 浮點把 10:23:45 算成 10:23:44)', M._hms(tw_ns(10, 23, 45, 0.999999), 0) == '10:23:45')

# ── ③ 某一檔區間查詢壞掉 ──
api3 = FakeApi(CODES, bad='raise:2454')
logs3 = []
ok3, bad3, S3, _ = day_run(api3, logs=logs3)
ok('③ 2454 區間查詢丟例外 → 那一檔整天重抓,每一拍輸出照樣正確', ok3, bad3)
ok('③ log 有說哪一檔退回整天重抓(⛔ 不可靜默)', any('2454' in x and '整天重抓' in x for x in logs3), logs3[:3])

# ── ④ 時間戳是真的 UTC ──
api4 = FakeApi(CODES, conv='epoch')
ok4, bad4, S4, got4 = day_run(api4)
ok('④ 時間戳差 8 小時 → 自己判出來(off_h=8),每一拍輸出正確', ok4 and S4.get('off_h') == 8, (bad4, S4.get('off_h')))
_, _, _, g4 = day_run(FakeApi(BIG, conv='epoch'), codes=BIG)
ok('④ 而且照樣省流量(30 檔 < 25%)', g4 / max(gF, 1) < 0.25, (g4, gF))

# ── ⑤ 區間查詢不含起點那一秒 ──
api5 = FakeApi(CODES, bad='exclusive')
logs5 = []
ok5, bad5, S5, _ = day_run(api5, logs=logs5)
ok('⑤ 區間查詢不含起點那一秒 → 起點往前多抓 1 秒,每一拍輸出照樣正確、不用退回整天重抓', ok5 and not S5.get('off'), (bad5, S5.get('off')))
# ⭐ 決定性對照:拿掉那 1 秒(只從最後一筆那一秒開始抓)→ 一定漏算;每一拍都對帳 → 當天就抓到、改回整天重抓
src_t = open(os.path.join(ROOT, 'tick_flow_miner.py'), encoding='utf-8').read()
ok('⑤ 起點往前多抓 1 秒那一行還在', "time_start=_hms(st['t'] - 10**9, S['off_h'])" in src_t)
orig_hms = M._hms
M._hms = lambda ts_ns, off_h: orig_hms(ts_ns + 10 ** 9, off_h)     # 注入:把多抓的那 1 秒加回去 = 舊寫法
api5b = FakeApi(CODES, bad='exclusive')
logs5b = []
ok5b, bad5b, S5b, _ = day_run(api5b, logs=logs5b)
M._hms = orig_hms
ok('⑤ 對照:拿掉多抓的 1 秒 → 對帳抓到、當天改回整天重抓(對帳有鑑別力)', bool(S5b.get('off')) and any('🚨' in x for x in logs5b), (S5b.get('off'), logs5b[:2]))
g5 = BADS['last']
ok('⑤ 對照:就算那樣,改回整天重抓之後的每一拍都要正確(漏算那拍到被抽到那拍之間會錯 = 為什麼要多抓那 1 秒)',
   any(not x for x in g5) and g5[-1] and all(g5[g5.index(False) + 1:][-10:]), g5)
saved = M.CHECK_EVERY
M.CHECK_EVERY = 10 ** 9
M._hms = lambda ts_ns, off_h: orig_hms(ts_ns + 10 ** 9, off_h)
orig_collect = M.collect_ticks


def _no_check(api, hot, today, S, **kw):
    S['inc_beats'] = 10 ** 6 + 1          # 讓 k 永遠不是 1、也不是 CHECK_EVERY 的倍數
    return orig_collect(api, hot, today, S, **kw)


M.collect_ticks = _no_check
api5c = FakeApi(CODES, bad='exclusive')
ok5c, _, _, _ = day_run(api5c)
M.collect_ticks = orig_collect
M.CHECK_EVERY = saved
M._hms = orig_hms
ok('⑤ 對照:拿掉多抓的 1 秒、也拿掉對帳 → 一定算錯(兩道保險各自有作用)', not ok5c)

# ── ⑥ 每 10 筆漏 1 筆 ──
api6 = FakeApi(CODES, bad='drop')
ok6, bad6, S6, _ = day_run(api6)
ok('⑥ 區間查詢每 10 筆漏 1 筆 → 對帳抓到、改回整天重抓,輸出正確', ok6 and bool(S6.get('off')), (bad6, S6.get('off')))

# ── ⑦ 換一天、新進榜 ──
S7 = M.load_state(DAY, path='/nonexistent/x')
S7['s'] = {'2330': {'a': {}, 't': 1, 'c': 1}}
p = os.path.join(os.environ.get('TMPDIR', '/tmp'), f'tick_state_test_{os.getpid()}.json')
M.save_state(S7, path=p)
ok('⑦ 同一天 → 讀回狀態', M.load_state(DAY, path=p).get('s', {}).get('2330') is not None)
ok('⑦ 換一天 → 狀態歸零(⛔ 不可把昨天的累計加到今天)', M.load_state('2026-10-22', path=p).get('s') == {})
os.remove(p)
api7 = FakeApi(CODES + ['6669'])
ok7, bad7, _, _ = day_run(api7, codes_at=lambda bi: CODES + (['6669'] if bi >= 10 else []))
ok('⑦ 第 10 拍才進榜的那一檔:先整天抓一次、之後增量,每一拍輸出正確', ok7, bad7)

# ── ⑨ 沒有時間戳 ──
api9 = FakeApi(CODES, bad='nots')
ok9, bad9, S9, got9 = day_run(api9)
ok('⑨ 舊版沒有時間戳 → 每拍整天重抓,輸出正確', ok9 and got9 >= got_full * 0.95, (bad9, got9, got_full))
ok('⑨ 沒有區間查詢常數(qt=None)→ 每拍整天重抓,輸出正確', day_run(FakeApi(CODES), qt=None)[0])

# ── ⑩ main 有接上 ──
src = open(os.path.join(ROOT, 'tick_flow_miner.py'), encoding='utf-8').read()
main_src = src[src.index('def main():'):]
ok('⑩ main 用 collect_ticks + load_state / save_state', all(x in main_src for x in ('collect_ticks(', 'load_state(', 'save_state(')))
ok('⑩ 區間查詢常數走 sj.constant.TicksQueryType.RangeTime(抓不到就整天重抓)', 'TicksQueryType.RangeTime' in main_src and 'qt_range = None' in main_src)
ok('⑩ 逃生門 TICK_INCR=0 還在', "os.getenv('TICK_INCR')" in src)
ok('⑩ ⛔ 舊的「每拍整天重抓」迴圈不可復活在 main 裡', 'api.ticks(contract=c, date=today)' not in main_src)
ok('⑩ 對帳一定比到最大單筆與總量(⛔ 只比筆數會放過「量對不上」)', "('n', 'in', 'out', 'bb', 'bs', 'mx', 'v')" in src)

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ TICK_INCR_PASS(全部通過)')
sys.exit(1 if fails else 0)
