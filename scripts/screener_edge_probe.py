#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔎 選股條件實測探針 —— 只讀 data/,不打網路、不寫產物。

❓ 使用者(2026-08-30):「還有什麼高勝率的訊號嗎?放在選股裡面」

⭐⭐ 先講清楚問題本身:**「高勝率」是錯的目標。**
   本專案 V72.9.7 已實測:加上「只做成交值 ≥1 億」勝率 +3.4pp,**卻少賺 307,528 元**
   —— 濾掉小型股 = 濾掉跑最遠的那幾檔。所以這支問的是**期望值**(超額報酬),
   勝率只當附帶資訊顯示,⛔ 不當判準。

📌 為什麼這支存在:選股頁有 **170 個條件**,使用者勾了就以為那是驗證過的做法,
   但其中**只有 1 個**(5 日週轉率,V73.8.2)有實測數字。其餘全是「聽起來合理」。

⭐ 關鍵設計:**直接呼叫 `screener_miner.build_one(rows[...:i+1])`**
   —— 它的 docstring 就寫著「⛔ 只用到當天為止的資料」,所以拿它跑歷史
   ① 天然沒有前視偏誤 ② ⛔ 不會產生第二份欄位定義(避免同名不同義)。
   條件本身從 index.html 的 `_SCR_CONDS` 直接解析出來(那是**資料**不是邏輯)。

📐 六道關卡(跟本專案其他探針一致):
   ・報酬扣同期加權指數 ・前後半段同向(中點對齊**實際樣本**)・逐年同向 ・拿掉最好那一年
   ・扣來回成本 0.44%
   ・⭐ **同檔同條件 20 日去重** —— 前瞻 20 日的相鄰窗口有 19 天是重疊的,
     不去重的話 n 會灌水到看起來很可信(本專案 sector_flow 那次記過:47 筆其實只有 18 個獨立事件)。

🔁 V79.4.3(16 年全市場重跑前修好,陷阱 #50 / #52):
   ・「vs 對照」改**同一天**:每一筆事件減掉同一天所有可交易股票(成交額 ≥1,000 萬)的平均 ——
     ⛔ 不再減整段平均(法人 / 融資欄位只有某幾年才有,整段平均會憑空造出「領先」)
   ・**進場 = 隔天開盤**(`ENTRY=open1`,預設):選股結果是收盤後才算出來的,當天收盤價其實買不到;
     隔天開盤一價到底鎖漲停 → 買不到,剔除(2015-06 前 ±7%,lib_limit)。`ENTRY=close` = 舊口徑(當天收盤,收盤停在漲停剔除)
   ・持有窗口碰到價格斷崖(×1.5 / ×0.67,lib_limit.cliff_*)→ 那一筆不算(⛔ 不整檔剔除)
   ・逐檔串流(⛔ 整包進記憶體)+ 每天只餵 build_one 最近 420 根(它最多往回看 401 根;selftest 逐值比對相同)
   ・`WORKERS=3` 多行程平行;`--selftest` 不需要資料

🚧 空過守門:獨立事件數 < 3 萬 → exit 1;可回測條件 < 60 個 → exit 1。
"""
import json
import math
import os
import re
import sys
from collections import defaultdict
from multiprocessing import Pool
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'scripts'))
import screener_miner as SM  # noqa: E402
import lib_limit as LL  # noqa: E402

DATA = Path(os.environ.get('DATA_DIR') or (ROOT / 'data'))
WARM = 250          # 年位階要 252 根才有意義
FWD = 20            # 前瞻天期(選股是波段用途)
COST = 0.44         # 股票來回成本 %
MIN_AMT = 0.1       # 🚧 可交易性:成交額 ≥ 0.1 億(1,000 萬)
DAY_STRIDE = int(os.environ.get('STRIDE', '1'))
ENTRY = os.environ.get('ENTRY', 'open1')
BO_WIN = 420        # build_one 最多往回看 401 根(RSI 那段)→ 餵 420 根結果逐值相同
MIN_CTRL = 30       # 同一天的對照組至少要這麼多檔
WORKERS = max(1, int(os.environ.get('WORKERS', '3')))
SELFTEST = '--selftest' in sys.argv

CI = SM.CI
OPS = {
    'gt': lambda x, v: x > v, 'gte': lambda x, v: x >= v,
    'lt': lambda x, v: x < v, 'lte': lambda x, v: x <= v,
    'eq': lambda x, v: x == v, 'ne': lambda x, v: x != v,
}


def parse_conds():
    """從 index.html 解析 _SCR_CONDS(只取「單一欄位 + 比較」那種)。"""
    src = (ROOT / 'index.html').read_text(encoding='utf-8')
    i0 = src.index('    _SCR_CONDS: [')
    depth, end = 0, None
    for k in range(i0 + len('    _SCR_CONDS: ['), len(src)):
        if src[k] == '[':
            depth += 1
        elif src[k] == ']':
            if depth == 0:
                end = k
                break
            depth -= 1
    blk = src[i0:end]
    out = []
    for m in re.finditer(
            r"\{ id: '([A-Za-z0-9_]+)',\s*g: '(\w+)',\s*s: '([^']+)',\s*t: '([^']+)',"
            r"\s*k: '(\w+)',\s*op: '(\w+)',\s*v: (-?[\d.]+)", blk):
        cid, g, sub, title, key, op, val = m.groups()
        if key not in CI or op not in OPS:
            continue
        out.append({'id': cid, 'g': g, 's': sub, 't': title, 'k': key, 'op': op, 'v': float(val)})
    return out


def load_rows(p):
    try:
        rows = json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None
    rows = rows if isinstance(rows, list) else (rows.get('data') or [])
    return [r for r in rows if float(r.get('close') or 0) > 0]


def entry_px(rows, i, ds, cl):
    """進場價;買不到回 None。open1 = 隔天開盤(一價到底鎖漲停 → 買不到);close = 當天收盤(收盤停在漲停 → 買不到)。"""
    if ENTRY == 'close':
        if i > 0 and LL.up_limit_close(ds[i], cl[i], cl[i - 1]):
            return None
        return cl[i]
    if i + 1 >= len(rows):
        return None
    r1 = rows[i + 1]
    o, h, l_ = float(r1.get('open') or 0), float(r1.get('high') or 0), float(r1.get('low') or 0)
    if not (o > 0):
        return None
    if LL.locked_bar(ds[i + 1], cl[i], o, h, l_) == 1:
        return None
    return o


def stock_events(rows, conds, twc, twi, mid, cl_pre=None, twch=None):
    """一檔的全部事件(純函式,selftest 直接測)。
    回 dict:base_d {日期: [和, 數]}(同一天對照:所有可交易「股·日」)/ base_dd(整段去重,舊口徑只留著比)/
    c {條件 id: [事件 (日期, 超額%) ...]}(20 日去重)/ skip {lock, cliff}"""
    n = len(rows)
    ds = [str(r['date']).replace('/', '-') for r in rows]
    cl = [float(r['close']) for r in rows]
    op = [float(r.get('open') or r['close']) for r in rows]
    pre = cl_pre if cl_pre is not None else LL.cliff_prefix(cl, op)
    out = {'base_d': {}, 'base_dd': [], 'c': defaultdict(list), 'skip': {'lock': 0, 'cliff': 0}}
    last, last_base = {}, -10 ** 9
    for i in range(WARM, n - FWD, DAY_STRIDE):
        d, dF = ds[i], ds[i + FWD]
        if d not in twi or dF not in twc or d not in twc:
            continue
        # ⭐ 大盤當天漲跌要傳進去(「優於大盤」rs 靠它;⛔ V79.4.3 第一版傳 None → 那一條整欄空、測不到)
        v = SM.build_one(rows[max(0, i + 1 - BO_WIN):i + 1], (twch or {}).get(d))
        if v is None:
            continue
        amt = v[CI['amt']]
        if amt is None or amt < MIN_AMT:
            continue
        px = entry_px(rows, i, ds, cl)
        if px is None:
            out['skip']['lock'] += 1
            continue
        if LL.cliff_in(pre, i, i + FWD):
            out['skip']['cliff'] += 1
            continue
        ex = (cl[i + FWD] / px - 1) * 100 - (twc[dF] / twc[d] - 1) * 100
        b = out['base_d'].setdefault(d, [0.0, 0])
        b[0] += ex
        b[1] += 1
        if i - last_base >= FWD:
            last_base = i
            out['base_dd'].append((d, ex))
        for c in conds:
            x = v[CI[c['k']]]
            if x is None:
                continue
            if OPS[c['op']](x, c['v']) and i - last.get(c['id'], -10 ** 9) >= FWD:
                last[c['id']] = i
                out['c'][c['id']].append((d, ex))
    out['c'] = dict(out['c'])
    return out


class St:
    """一個條件的統計。raw = 對加權的超額(描述 + 「扣成本後還賺不賺」);rel = 減掉同一天所有可交易股票的平均(關卡一律用這個)。"""
    __slots__ = ('n', 'sum', 'win', 'byY', 'h1n', 'h1s', 'h2n', 'h2s', 'bsum', 'bn', 'rY', 'r1n', 'r1s', 'r2n', 'r2s')

    def __init__(self):
        self.n = 0
        self.sum = 0.0
        self.win = 0
        self.byY = defaultdict(lambda: [0, 0.0])
        self.h1n = self.h2n = 0
        self.h1s = self.h2s = 0.0
        self.bsum = 0.0        # 同一天對照組平均的加總(算「vs 對照」用)
        self.bn = 0
        self.rY = defaultdict(lambda: [0, 0.0])   # 🔁 V79.4.3 逐年 / 前後半也用同一天對照後的超額(⛔ 用 raw 會把各年行情差當成條件的效應,陷阱 #50)
        self.r1n = self.r2n = 0
        self.r1s = self.r2s = 0.0

    def add(self, ex, year, h1, bmean=None):
        self.n += 1
        self.sum += ex
        if ex > 0:
            self.win += 1
        y = self.byY[year]
        y[0] += 1
        y[1] += ex
        if h1:
            self.h1n += 1
            self.h1s += ex
        else:
            self.h2n += 1
            self.h2s += ex
        if bmean is not None:
            a = ex - bmean
            self.bsum += a
            self.bn += 1
            ry = self.rY[year]
            ry[0] += 1
            ry[1] += a
            if h1:
                self.r1n += 1
                self.r1s += a
            else:
                self.r2n += 1
                self.r2s += a


MIN_YEARS = 5        # 🔁 V79.4.3 逐年那關至少要有 5 個年份才判得出來(融資券那幾欄只有 2023 起 4 年 → ⛔ 不算過關;同 mops_event_probe)
MIN_YEAR_DAYS = 60   # 🔁 V79.4.3 那一年在樣本裡不到 60 個交易日(例:2010 只有 12/31 那 1 天)→ ⛔ 不進逐年那關(1 天的「年」是雜訊)


def gates(st, valid=None):
    """回 (扣成本後超額[對加權], 前半, 後半, 逐年是否同向, 去最好年後, 逐年, 最好年, 關卡全過?)
    🔁 V79.4.3 關卡全部用「同一天對照後」的超額(rel):全期 > 0 ・前後半都 > 0 ・逐年都 > 0 ・去最好年 > 0 ・扣成本(rel − 0.44)> 0。
    ⛔ 舊版拿「對加權的超額 − 成本」判逐年 → 2024~2026 大型股獨強那幾年,幾乎每個條件都被大盤拖成負的(跟條件本身無關)。
    第一個回傳值仍是「對加權、扣成本後」(App 拿它講『扣掉成本還賺不賺』),⛔ 不拿來判關卡。"""
    m = st.sum / st.n - COST
    if not st.bn:
        return m, float('nan'), float('nan'), False, float('nan'), [], '', False
    rel = st.bsum / st.bn
    h1 = st.r1s / st.r1n if st.r1n else float('nan')
    h2 = st.r2s / st.r2n if st.r2n else float('nan')
    yv = sorted((y, o[1] / o[0], o[0]) for y, o in st.rY.items() if valid is None or y in valid)
    if not yv:
        return m, h1, h2, False, float('nan'), [], '', False
    allpos = all(x > 0 for _, x, _ in yv)
    best = max(yv, key=lambda t: t[1])
    rn, rs_ = st.bn - best[2], st.bsum - st.rY[best[0]][1]
    xb = rs_ / rn if rn else float('nan')
    ok = rel > 0 and h1 > 0 and h2 > 0 and allpos and len(yv) >= MIN_YEARS and xb > 0 and rel - COST > 0
    return m, h1, h2, allpos, xb, yv, best[0], ok


_G = {}


def _init(conds, twc, twi, mid, twch=None):
    _G.update(conds=conds, twc=twc, twi=twi, mid=mid, twch=twch)


def _work(f):
    rows = load_rows(DATA / f)
    if not rows or len(rows) < WARM + FWD + 10:
        return None
    return stock_events(rows, _G['conds'], _G['twc'], _G['twi'], _G['mid'], twch=_G.get('twch'))


def _selftest():
    bad = 0

    def ok(name, c, x=''):
        nonlocal bad
        print(('✅ ' if c else '❌ ') + name + ('' if c else ' ・' + repr(x)[:300]))
        if not c:
            bad += 1

    import random
    # ① 決定性對照(同一天 vs 整段):前段大家每 20 天輸大盤 3%、後段贏 1%;條件只在前段成立、報酬跟大家一樣
    random.seed(3)
    st_new, st_old_sum, st_old_n, all_sum, all_n = St(), 0.0, 0, 0.0, 0
    for t in range(400):
        d = '2013-%04d' % t
        mu = -3.0 if t < 200 else 1.0
        xs = [mu + (random.random() - 0.5) * 8 for _ in range(60)]
        bmean = sum(xs) / len(xs)
        all_sum += sum(xs)
        all_n += len(xs)
        if t < 200 and t % 3 == 0:
            ex = xs[t % 60]
            st_new.add(ex, d[:4], True, bmean)
            st_old_sum += ex
            st_old_n += 1
    old = st_old_sum / st_old_n - all_sum / all_n
    new = st_new.bsum / st_new.bn
    ok(f'① 決定性對照:整段平均憑空 {old:+.2f}pp(< −1)、同一天對照 {new:+.2f}pp(≈ 0)', old < -1 and abs(new) < 0.5, (old, new))

    # ①b 關卡也要用同一天對照:2013 / 2015 / 2017 年大家都輸大盤 3%、雙數年贏 1%;條件每年都比同一天的其他股票多 1pp
    #     → 新關卡逐年都是 +1、全過;⛔ 舊寫法(對加權 − 成本)單數年是負的 → 誤判成「逐年沒過」
    def six_years(edge, extra=None):
        st = St()
        for t in range(600):
            y = str(2013 + t // 100)
            mu = -3.0 if int(y) % 2 else 1.0
            xs = [mu + (random.random() - 0.5) * 4 for _ in range(50)]
            bm = sum(xs) / len(xs)
            st.add(bm + edge, y, t < 300, bm)
        if extra:
            st.add(*extra)
        return st
    st_g = six_years(1.0)
    gm, gh1, gh2, gallpos, gxb, gyv, gby, gok = gates(st_g)
    raw13 = st_g.byY['2013'][1] / st_g.byY['2013'][0] - COST
    ok(f'①b 關卡用同一天對照:逐年 {", ".join(f"{y}:{x:+.1f}" for y, x, _ in gyv)} 全過 ✅;舊寫法 2013 年是 {raw13:+.2f}(會誤判)',
       gok and all(abs(x - 1.0) < 1e-9 for _, x, _ in gyv) and raw13 < -1, (gok, gyv, raw13))
    st_z = six_years(0.3)
    ok('①b 決定性對照:每年只多 0.3pp(< 成本 0.44)→ 扣成本那關擋下來', not gates(st_z)[7] and gates(st_z)[3], gates(st_z)[7])
    st_1 = six_years(1.0, (-5.0, '2012', True, 0.0))          # 2012 只有 1 天、而且是負的
    v6 = {str(y) for y in range(2013, 2019)}
    ok('①c 樣本不到 60 天的年份不進逐年那關(valid 不含它 → 過;含它 → 擋)',
       gates(st_1, v6)[7] and not gates(st_1)[7], (gates(st_1, v6)[7], gates(st_1)[7]))
    st_4 = St()
    for t in range(400):
        y = str(2023 + t // 100)
        xs = [(random.random() - 0.5) * 4 for _ in range(50)]
        bm = sum(xs) / len(xs)
        st_4.add(bm + 1.0, y, t < 200, bm)
    ok('①d 只有 4 個年份(每年都贏)→ ⛔ 不算過關(逐年那關至少 5 年)', not gates(st_4)[7] and gates(st_4)[3], gates(st_4)[7])

    # ② build_one 只餵最近 420 根 → 逐值跟整段相同(合成 600 根,含法人 / 融資欄位)
    rows = []
    p = 100.0
    for k in range(600):
        p *= 1 + (random.random() - 0.5) * 0.06
        hi_, lo_ = p * (1 + random.random() * 0.02), p * (1 - random.random() * 0.02)
        rows.append({'date': '2016-%04d' % k, 'open': p, 'high': hi_, 'low': lo_, 'close': p,
                     'volume': 1e6 * (1 + random.random()), 'foreign_net': random.randint(-5000, 5000),
                     'trust_net': random.randint(-500, 500), 'dealer_net': random.randint(-500, 500),
                     'margin_balance': 1000 + k, 'short_balance': 100 + (k % 7)})
    same = all(SM.build_one(rows[:i + 1]) == SM.build_one(rows[max(0, i + 1 - BO_WIN):i + 1]) for i in range(BO_WIN, 600, 7))
    ok(f'② build_one 餵最近 {BO_WIN} 根 == 餵整段(逐值相同)', same)
    shorter = any(SM.build_one(rows[:i + 1]) != SM.build_one(rows[i + 1 - 240:i + 1]) for i in range(BO_WIN, 600, 7))
    ok('② 決定性對照:只餵 240 根 → 會不一樣(一年位階要 252 根)', shorter)

    # ③ 進場:隔天一價到底鎖漲停 → 買不到;2012 年 +7% 算鎖、2020 年要 +10%
    global ENTRY
    ENTRY = 'open1'
    mk = lambda d0, o1: [{'date': d0 + '-01', 'open': 100, 'high': 100, 'low': 100, 'close': 100},
                         {'date': d0 + '-02', 'open': o1, 'high': o1, 'low': o1, 'close': o1}]
    r12, r20 = mk('2012-03', 107.0), mk('2020-03', 107.0)
    ok('③ 2012 年隔天一價到底 +7% = 鎖漲停 → 買不到;2020 年同一根 = 買得到(開盤價)',
       entry_px(r12, 0, ['2012-03-01', '2012-03-02'], [100, 107]) is None
       and entry_px(r20, 0, ['2020-03-01', '2020-03-02'], [100, 107]) == 107.0)
    ENTRY = 'close'
    r = [{'date': '2012-03-01', 'close': 100}, {'date': '2012-03-02', 'close': 106.8}]
    ok('③ ENTRY=close:2012 年收盤 +6.8% 停在漲停 → 尾盤買不到', entry_px(r, 1, ['2012-03-01', '2012-03-02'], [100, 106.8]) is None)
    ENTRY = 'open1'

    # ④ 斷崖:事件窗口碰到斷崖 → 不算(用真的 stock_events 跑)
    rows2 = [dict(r_) for r_ in rows]
    for k in range(480, 600):
        for f_ in ('open', 'high', 'low', 'close'):
            rows2[k][f_] *= 1.8
    ds2 = [r_['date'] for r_ in rows2]
    twc = {d: 100.0 for d in ds2}
    twi = {d: k for k, d in enumerate(ds2)}
    conds = [{'id': 'all', 'k': 'c', 'op': 'gt', 'v': 0}]
    ev = stock_events(rows2, conds, twc, twi, 300)
    near = [d for d, _ in ev['c'].get('all', []) if 460 <= int(d[-4:]) < 480]
    ok('④ 斷崖前 20 天內進場的事件全部剔除、其他照算', ev['skip']['cliff'] > 0 and not near and len(ev['c'].get('all', [])) > 5,
       (ev['skip'], near[:3]))
    ev0 = stock_events(rows, conds, {r_['date']: 100.0 for r_ in rows}, {r_['date']: k for k, r_ in enumerate(rows)}, 300)
    ok('④ 沒有斷崖的同一段 → 一筆都不剔除', ev0['skip']['cliff'] == 0, ev0['skip'])
    # ⑤ 「優於大盤」rs:大盤當天漲跌有傳進去才算得出來(⛔ 第一版漏傳 → 整欄空)
    cr = [{'id': 'beat', 'k': 'rs', 'op': 'gt', 'v': 0}]
    tw0 = {r_['date']: 100.0 for r_ in rows}
    ti0 = {r_['date']: k for k, r_ in enumerate(rows)}
    e_no = stock_events(rows, cr, tw0, ti0, 300)
    e_yes = stock_events(rows, cr, tw0, ti0, 300, twch={r_['date']: -50.0 for r_ in rows})
    ok('⑤ 「優於大盤」:有傳大盤漲跌 → 有事件;沒傳 → 0 筆(決定性對照)', len(e_yes['c'].get('beat', [])) > 5 and not e_no['c'].get('beat'),
       (len(e_yes['c'].get('beat', [])), len(e_no['c'].get('beat', []))))
    print(f'\n❌ {bad} 條失敗' if bad else '\n✅ SCREENER_EDGE_SELFTEST_PASS')
    sys.exit(1 if bad else 0)


def main():
    conds = parse_conds()
    print(f'📋 index.html 解析到 {len(conds)} 個「單一欄位」條件(全部 170 個,其餘要自訂函式)')
    if len(conds) < 60:
        sys.exit('🚧 空過守門:解析到的條件太少,regex 可能跟不上 _SCR_CONDS 的寫法了')

    # ── 日期軸 + 大盤 ────────────────────────────────────────────────
    tw = json.loads((DATA / '^TWII.json').read_text(encoding='utf-8'))
    tw = [r for r in (tw if isinstance(tw, list) else tw.get('data') or []) if float(r.get('close') or 0) > 0]
    twc = {str(r['date']).replace('/', '-'): float(r['close']) for r in tw}
    twd = [str(r['date']).replace('/', '-') for r in tw]
    twi = {d: i for i, d in enumerate(twd)}
    print(f'📈 日期軸 {len(twd)} 天({twd[0]} ~ {twd[-1]})・進場 {"隔天開盤" if ENTRY == "open1" else "當天收盤"} ・{WORKERS} 個行程')

    files = sorted(f for f in os.listdir(DATA)
                   if re.fullmatch(r'\d{4,6}\.json', f) and not f.startswith('00'))
    print(f'📂 掃 {len(files)} 檔(已排除 ETF)・日期取樣間隔 {DAY_STRIDE}')

    # 第一輪:只讀日期,算實際樣本的中點(🚨 ⛔ 不可用整條日期軸的中點 —— 個股 K 線起點晚很多)
    gmin, gmax = 10 ** 9, -1
    keep = []
    for f in files:
        rows = load_rows(DATA / f)
        if not rows or len(rows) < WARM + FWD + 10:
            continue
        a, b = str(rows[WARM]['date']).replace('/', '-'), str(rows[-1 - FWD]['date']).replace('/', '-')
        if a in twi:
            gmin = min(gmin, twi[a])
        if b in twi:
            gmax = max(gmax, twi[b])
        keep.append(f)
    mid = (gmin + gmax) // 2
    print(f'✅ 可用 {len(keep)} 檔 ・ 實際樣本 {twd[gmin]} ~ {twd[gmax]}(中點 {twd[mid]})')

    # 第二輪:逐檔(多行程)→ 每檔回壓縮過的事件,父行程合併
    base_d = defaultdict(lambda: [0.0, 0])
    base_dd, cev = [], defaultdict(list)
    skip = {'lock': 0, 'cliff': 0}
    used = 0
    # 大盤當天漲跌%(同 screener_miner 的 twii_by_date)
    twch = {twd[i]: (twc[twd[i]] / twc[twd[i - 1]] - 1) * 100 for i in range(1, len(twd)) if twc[twd[i - 1]] > 0}
    with Pool(WORKERS, initializer=_init, initargs=(conds, twc, twi, mid, twch)) as pool:
        for k, r in enumerate(pool.imap_unordered(_work, keep, chunksize=4)):
            if k % 300 == 0:
                print(f'  … {k}/{len(keep)}', flush=True)
            if not r:
                continue
            used += 1
            for d, (s, c) in r['base_d'].items():
                b = base_d[d]
                b[0] += s
                b[1] += c
            base_dd.extend(r['base_dd'])
            for cid, evs in r['c'].items():
                cev[cid].extend(evs)
            for kk in skip:
                skip[kk] += r['skip'][kk]

    bmean = {d: s / c for d, (s, c) in base_d.items() if c >= MIN_CTRL}
    BASE = St()
    for d, ex in base_dd:
        BASE.add(ex, d[:4], twi[d] < mid)
    print(f'\n🔢 事件(股·日,20 日去重)= {BASE.n:,} ・同一天對照 {len(bmean):,} 天(每天 ≥{MIN_CTRL} 檔)'
          f' ・剔除 買不到 {skip["lock"]:,} / 碰到斷崖 {skip["cliff"]:,}')
    if BASE.n < 30000:
        sys.exit('🚧 空過守門:事件數太少,結論不可信')
    b_ex = BASE.sum / BASE.n
    b_wr = BASE.win / BASE.n * 100
    print(f'📊 對照組(隨便挑一天,成交額 ≥1,000 萬):{FWD} 日超額 平均 {b_ex:+.3f}% ・ 勝率 {b_wr:.1f}% ・ n={BASE.n:,}')
    print('   ⚠️ 勝率基準不是 50% —— 中位數個股本來就跑輸市值加權的大盤。')
    print('   ⭐ V79.4.3「vs 對照」= 每一筆減掉**同一天**所有可交易股票的平均(⛔ 不再減整段平均,陷阱 #50)\n')

    # 🔁 V79.4.3 逐年那關只看「樣本裡 ≥60 個交易日」的年份;前後半照**每個條件自己的**日期範圍切
    #   (融資券那幾欄 2023 才有 → 用整段中點會永遠沒有前半 = 那一關恆不過,跟條件本身無關)
    from collections import Counter
    ydays = Counter(d[:4] for d in bmean)
    valid = {y for y, k in ydays.items() if k >= MIN_YEAR_DAYS}
    print(f'📅 逐年那關的年份(樣本 ≥{MIN_YEAR_DAYS} 個交易日):{",".join(sorted(valid))}'
          + (f' ・不算:{",".join(f"{y}({ydays[y]} 天)" for y in sorted(set(ydays) - valid))}' if set(ydays) - valid else ''))
    STAT = {}
    dropped = 0
    for cid, evs in cev.items():
        st = St()
        ix = [twi[d] for d, _ in evs if d in bmean]
        cmid = (min(ix) + max(ix)) // 2 if ix else mid
        for d, ex in evs:
            bm = bmean.get(d)
            if bm is None:
                dropped += 1
                continue
            st.add(ex, d[:4], twi[d] < cmid, bm)
        STAT[cid] = st

    rows_out = []
    for c in conds:
        st = STAT.get(c['id'])
        if not st or st.n < 300:
            continue
        m, h1, h2, allpos, xb, yv, by, ok = gates(st, valid)
        vs = st.bsum / st.bn if st.bn else float('nan')
        vs_all = st.sum / st.n - b_ex
        rows_out.append((c, st, m, h1, h2, allpos, xb, yv, by, ok, vs, vs_all))

    rows_out.sort(key=lambda t: -t[10])
    flips = sum(1 for t in rows_out if (t[10] > 0) != (t[11] > 0) and abs(t[10] - t[11]) > 0.2)
    print(f'{"條件":<26}{"組":<6}{"事件數":>9}{"扣成本":>9}{"勝率":>8}{"前半":>8}{"後半":>8}{"去最好年":>10}{"vs對照":>9}{"(舊)":>8}  六關')
    print('─' * 112)
    for c, st, m, h1, h2, allpos, xb, yv, by, ok, vs, vs_all in rows_out:
        print(f"{c['t'][:24]:<26}{c['s']:<6}{st.n:>9,}{m:>9.3f}{st.win / st.n * 100:>7.1f}%"
              f"{h1:>8.2f}{h2:>8.2f}{xb:>10.2f}{vs:>+9.2f}{vs_all:>+8.2f}  {'✅' if ok else '❌'}")
    print(f'\n🔁 新舊口徑(同一天 vs 整段)方向相反的條件 {flips} 個 ・對照組不夠被丟掉的事件 {dropped:,}')

    # ⭐ 前 12 名一律印逐年明細 —— ⛔ 不可只印「六關全過」的那些
    print('\n📅 前 12 名(依 vs 對照)的逐年明細(同一天對照後的超額 pp;關卡:每年都要 > 0)')
    for c, st, m, h1, h2, allpos, xb, yv, by, ok, vs, vs_all in rows_out[:12]:
        print(f"  {c['t']:<22} " + ' '.join(f'{y}:{x:+.2f}({nn})' for y, x, nn in yv)
              + f"   去最好年({by}) {xb:+.2f}  {'逐年同向 ✅' if allpos else '逐年 ❌'}")

    pas = [r for r in rows_out if r[9]]
    print(f'\n🏁 {len(rows_out)} 個可回測條件裡,**六關全過 {len(pas)} 個**')
    for c, st, m, h1, h2, allpos, xb, yv, by, ok, vs, vs_all in pas:
        print(f"  ✅ {c['t']}({c['s']})  n={st.n:,} ・ 扣成本 {m:+.3f}% ・ 勝率 {st.win / st.n * 100:.1f}%"
              f" ・ 去最好年({by}) {xb:+.3f}% ・ vs 對照 {vs:+.2f}pp")

    skipped = [c for c in conds if c['id'] not in STAT or STAT[c['id']].n < 300]
    if skipped:
        print(f'\n⚠️ 樣本不足或欄位無歷史 → 測不了的 {len(skipped)} 個:'
              + '、'.join(c['t'] for c in skipped[:24]) + ('…' if len(skipped) > 24 else ''))

    if os.environ.get('EMIT'):
        out = {
            'win': [twd[gmin], twd[gmax]], 'fwd': FWD, 'cost': COST, 'entry': ENTRY, 'match': 'same-day',
            'syms': used, 'n': BASE.n,
            'base': [round(b_ex, 3), round(b_wr, 1)],
            # id → [扣成本後超額%, 勝率%, 樣本數, 六關全過?, 相對對照組 pp(同一天)]
            'c': {c['id']: [round(m, 3), round(st.win / st.n * 100, 1), st.n, 1 if ok else 0, round(vs, 2)]
                  for c, st, m, h1, h2, allpos, xb, yv, by, ok, vs, vs_all in rows_out},
            # 🔁 V79.4.3 逐年 = 同一天對照後的超額(pp,⛔ 不扣成本、⛔ 不是對加權)給 decay 表用
            'yrs': {c['id']: {y: round(x, 2) for y, x, nn in yv} for c, st, m, h1, h2, allpos, xb, yv, by, ok, vs, vs_all in rows_out},
        }
        print('\n===EMIT_JSON===')
        print(json.dumps(out, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    if SELFTEST:
        _selftest()
    main()
