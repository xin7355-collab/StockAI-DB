#!/usr/bin/env python3
"""🧭 V80.1.1 反攻條件雷達「逐日重建」(研究用,⛔ App 不讀)—— 回答「雷達成形才開新倉 / 雷達加進分數」之前,先把歷史上每一天的雷達算出來。

為什麼要這支:使用者 10/31 問「反攻條件要不要加進分數?等反攻再買?」—— App 的 12 條(`_renderReboundRadar`)
  從來沒有回測過;要回測得先有「歷史上每一天雷達長什麼樣」,而 App 只算今天那一天。

⭐ 每一條都照 App 原始碼的定義(index.html `_renderReboundRadar` / `_twRealizedVol` / `_calcDistributionDays` /
   `_deleverProgress` / `_fiFutState`),只有三條寫死金額的改成比例(跨十幾年才比得了;寫在 SCALE_FREE):
   ・量能「站回 1 兆」→ 成交金額 ≥ 自己前 60 天平均(⛔ 不含那天)
   ・融資「5 日減 ≥30 億」→ 5 日減 ≥ 0.6%(30 億 ÷ 2026 中位 5,235 億)
   ・黑天鵝「逆價差 ≤ −300 點」→ ≤ −0.7%(300 ÷ 2026 加權約 4.5 萬)
⛔ 前視:決策日 D 的雷達只用「D 之前」看得到的 —— 台股 / 台指期 / 融資用前一個交易日 P,
   美股 / 匯率 / 油 / 日圓用「美國日期 < D」最後一天,韓股 / 日經用「當地日期 < D」最後一天(selftest ⑥ 注入偷看當天必紅)。
⛔ 算不出來的條件 = None(⛔ 當成沒過);judged = 算得出來的條數,成形門檻 = max(6, judged − 2)(App 同一個式子)。

輸入(都在 origin/data):data/us_hist.json(美股 + mac 匯率 / 油 / 日圓 + asia 韓日)・data/fi_mkt_hist.json(外資期貨 / 融資 / 價差)
       ・data/idx_long.json(加權 2010 起,含成交金額)+ data/^TWII.json(接到最新)
輸出:JSON {meta, days:[D…], c:{條件:[1/0/null…]}, passN, judged, formed, half, swan}
跑法:python3 scripts/rebound_hist_build.py --us us_hist.json --fi fi_mkt_hist.json --idx idx_long.json --twii ^TWII.json --out rebound_hist.json
      python3 scripts/rebound_hist_build.py --selftest
"""
import argparse
import bisect
import json
import os
import math
import sys

CONDS = ['us', 'twd', 'kr', 'fut', 'oil', 'jpy', 'ma5', 'bs', 'amt', 'vol', 'dist', 'mg']
NAMES = {'us': '美股止穩', 'twd': '台幣止貶', 'kr': '韓股翻紅', 'fut': '外資期貨回補', 'oil': '油價不走極端',
         'jpy': '日圓不急升', 'ma5': '站回 5 日線', 'bs': '價差翻正', 'amt': '量能站回(自己 60 日均)',
         'vol': '台股波動率退燒', 'dist': '機構停止倒貨', 'mg': '融資斷頭宣洩'}
SCALE_FREE = {'amt_ratio': 1.0, 'mg_chg5_pct': -0.6, 'bs_swan_pct': -0.7}


def _ds(s):
    return str(s)[:10].replace('/', '-')


# ── App 原始碼的三支計算(逐字照搬邏輯;⛔ 改了 App 要回來這裡對)─────────────────────
def realized_vol_pct(closes):
    """= index.html `_twRealizedVol`:20 日對數報酬年化;百分位跟自己過去最多 250 個值比。回 (vol, pct) 或 (None, None)。"""
    cl = [c for c in closes if c and c > 0]
    if len(cl) < 40:
        return None, None
    lr = [math.log(cl[i] / cl[i - 1]) for i in range(1, len(cl))]

    def vol_at(end):
        w = lr[max(0, end - 19): end + 1]
        if len(w) < 15:
            return None
        m = sum(w) / len(w)
        v = sum((x - m) ** 2 for x in w) / (len(w) - 1)
        return math.sqrt(v * 252) * 100

    vol = vol_at(len(lr) - 1)
    if vol is None:
        return None, None
    hist = [v for v in (vol_at(i) for i in range(max(19, len(lr) - 250), len(lr))) if v is not None]
    if len(hist) < 30:
        return vol, None
    return vol, sum(1 for v in hist if v < vol) / len(hist) * 100


def distribution_days(rows, lookback=25):
    """= index.html `_calcDistributionDays`(V79.3.5 起比成交金額):rows = [{close, high, amount}]。"""
    if len(rows) < 8:
        return None
    active = []
    for i in range(1, len(rows)):
        c, pc, hi = rows[i]['close'], rows[i - 1]['close'], rows[i]['high']
        v, pv = rows[i].get('amount') or 0, rows[i - 1].get('amount') or 0
        if c > 0 and pc > 0 and v > 0 and pv > 0:
            if (c - pc) / pc * 100 <= -0.2 and v > pv:
                active.append((i, hi))
        active = [a for a in active if not (c > 0 and c > a[1])]
    cutoff = (len(rows) - 1) - lookback
    return sum(1 for a in active if a[0] > cutoff)


def delever(mg_win, tw_on):
    """= index.html `_deleverProgress`:mg_win = [(日期, 融資)](App 用 risk_history 那一段;這裡給前 60 個交易日)。"""
    if len(mg_win) < 4:
        return None
    peak_d, peak = max(mg_win, key=lambda x: x[1])
    now_d, now = mg_win[-1]
    if peak <= 0 or peak_d == now_d:
        return None
    tp, tn = tw_on(peak_d), tw_on(now_d)
    if not tp or not tn:
        return None
    mg_drop = (peak - now) / peak * 100
    idx_drop = (tp - tn) / tp * 100
    if idx_drop < 1:
        return None
    return mg_drop / idx_drop


# ── 序列小工具 ────────────────────────────────────────────────────────────────
class Ser:
    """日期排好的收盤序列;last_before(D) = 日期 < D 的最後一個位置。"""

    def __init__(self, pairs):
        pairs = sorted((d, v) for d, v in pairs if v is not None and v == v and v > 0)
        self.d = [p[0] for p in pairs]
        self.v = [p[1] for p in pairs]

    def last_before(self, D):
        return bisect.bisect_left(self.d, D) - 1

    def chg(self, k, n=1):
        """第 k 個值相對 n 個之前的 %(沒有 → None)"""
        if k - n < 0 or k < 0:
            return None
        return (self.v[k] / self.v[k - n] - 1) * 100


def load_us(us):
    days = us.get('days') or []
    out = {}
    for t, blk in list((us.get('syms') or {}).items()) + list((us.get('mac') or {}).items()):
        c = blk.get('c') or []
        out[t] = Ser(zip(days, c))
    for t, blk in (us.get('asia') or {}).items():
        out[t] = Ser(zip(blk.get('d') or [], blk.get('c') or []))
    return out


def twii_rows(idx, twii_recent):
    """idx_long.twii [日期, o, h, l, c, 成交金額] + ^TWII.json(接 idx_long 最後一天之後)→ [{d, close, high, amount}]"""
    rows = {}
    for r in (idx or {}).get('twii') or []:
        rows[_ds(r[0])] = {'d': _ds(r[0]), 'close': r[4], 'high': r[2], 'amount': r[5] if len(r) > 5 else None}
    last = max(rows) if rows else ''
    for r in twii_recent or []:
        d = _ds(r.get('date'))
        if d > last and r.get('close'):
            rows[d] = {'d': d, 'close': r['close'], 'high': r.get('high') or r['close'], 'amount': r.get('amount')}
    return [rows[k] for k in sorted(rows)]


def build(us, fi, idx, twii_recent, start='2009-01-01'):
    S = load_us(us)
    tw = twii_rows(idx, twii_recent)
    tdays = [r['d'] for r in tw]
    tclose = {r['d']: r['close'] for r in tw}
    fut = fi.get('fut') or {}
    mg = fi.get('mg') or {}
    bs = fi.get('bs') or {}
    out = {'days': [], 'c': {k: [] for k in CONDS}, 'passN': [], 'judged': [], 'formed': [], 'half': [], 'swan': [], 'swanHits': []}

    def tw_on(d):
        k = bisect.bisect_right(tdays, d) - 1
        return tw[k]['close'] if k >= 0 else None

    mg_days = sorted(mg)
    fut_days = sorted(fut)
    for i in range(1, len(tw)):
        D = tw[i]['d']
        if D < start:
            continue
        P = tw[i - 1]['d']              # 前一個交易日(⛔ 用到 D 當天 = 前視)
        c = {}
        # 1 美股:美國日期 < D 的最後一天
        vix, sp = S.get('^VIX'), S.get('^GSPC')
        kv = vix.last_before(D) if vix else -1
        if kv >= 0:
            v = vix.v[kv]
            ks = sp.last_before(D) if sp else -1
            spc = sp.chg(ks) if ks >= 0 else None
            c['us'] = 1 if (v < 25 and (spc is None or spc > -0.5)) else 0
        else:
            v, spc = None, None
            c['us'] = None
        # 2 台幣:TWD=X 5 個美國交易日的變化(正 = 貶)
        twd = S.get('TWD=X')
        k = twd.last_before(D) if twd else -1
        t5 = twd.chg(k, 5) if k >= 0 else None
        c['twd'] = None if t5 is None else (1 if t5 <= 0.1 else 0)
        # 3 韓股(沒有 → 日經)
        kr, nk = S.get('^KS11'), S.get('^N225')
        kk = kr.last_before(D) if kr else -1
        krc = kr.chg(kk) if kk >= 0 else None
        kn = nk.last_before(D) if nk else -1
        nkc = nk.chg(kn) if kn >= 0 else None
        prim = krc if krc is not None else nkc
        c['kr'] = None if prim is None else (1 if prim > 0 else 0)
        # 4 外資期貨 5 日回補 ≥3,000 口(前一個交易日起往回 5 筆)
        kf = bisect.bisect_right(fut_days, P) - 1
        fchg = (fut[fut_days[kf]] - fut[fut_days[kf - 5]]) if kf >= 5 and fut_days[kf] == P else None
        c['fut'] = None if fchg is None else (1 if fchg >= 3000 else 0)
        # 5 油價單日 ±3% 內
        oil = S.get('CL=F')
        ko = oil.last_before(D) if oil else -1
        oc = oil.chg(ko) if ko >= 0 else None
        c['oil'] = None if oc is None else (1 if abs(oc) < 3 else 0)
        # 6 日圓 3 日(美元兌日圓跌 = 日圓升)> −2%
        jp = S.get('JPY=X')
        kj = jp.last_before(D) if jp else -1
        j3 = jp.chg(kj, 3) if kj >= 0 else None
        c['jpy'] = None if j3 is None else (1 if j3 > -2 else 0)
        # 7 加權站回 5 日線(P)
        cl = [r['close'] for r in tw[max(0, i - 5): i]]
        c['ma5'] = 1 if (len(cl) == 5 and cl[-1] >= sum(cl) / 5) else (None if len(cl) < 5 else 0)
        # 8 價差翻正(P)
        b = bs.get(P)
        bsp = (b[0] / b[2] * 100) if (b and b[2]) else None
        c['bs'] = None if b is None else (1 if b[0] >= 0 else 0)
        # 9 量能:P 的成交金額 ≥ 前 60 天平均(⛔ 不含 P)
        am = [r.get('amount') for r in tw[max(0, i - 61): i]]
        if len(am) == 61 and all(a and a > 0 for a in am):
            c['amt'] = 1 if am[-1] >= SCALE_FREE['amt_ratio'] * sum(am[:-1]) / 60 else 0
        else:
            c['amt'] = None
        # 10 波動率位階 ≤70%(到 P 為止)
        _, pct = realized_vol_pct([r['close'] for r in tw[max(0, i - 300): i]])
        c['vol'] = None if pct is None else (1 if pct <= 70 else 0)
        # 11 派發日 ≤2(到 P 為止)
        dd = distribution_days(tw[max(0, i - 80): i], 25)
        c['dist'] = None if dd is None else (1 if dd <= 2 else 0)
        # 12 融資:5 日減 ≥0.6%;去槓桿(前 60 天高點)沒追上指數跌幅 → 不算過
        km = bisect.bisect_right(mg_days, P) - 1
        mchg = ((mg[mg_days[km]] / mg[mg_days[km - 5]] - 1) * 100) if km >= 5 and mg_days[km] == P else None
        mp = None if mchg is None else (mchg <= SCALE_FREE['mg_chg5_pct'])
        win = [(d2, mg[d2]) for d2 in mg_days[max(0, km - 59): km + 1]] if km >= 0 else []
        ratio = delever(win, tw_on)
        if ratio is not None:
            done = ratio >= 0.9
            if mp is True and not done:
                mp = False
            if mp is None:
                mp = done
        c['mg'] = None if mp is None else (1 if mp else 0)
        judged = [c[k] for k in CONDS if c[k] is not None]
        pn = sum(judged)
        need = max(6, len(judged) - 2)
        half = math.ceil(len(judged) / 2) if judged else 0
        # 黑天鵝
        hits = []
        if v is not None and v >= 32:
            hits.append('vix')
        if fchg is not None and fchg <= -8000:
            hits.append('fut')
        if bsp is not None and bsp <= SCALE_FREE['bs_swan_pct']:
            hits.append('bs')
        if j3 is not None and j3 <= -4:
            hits.append('jpy')
        if (krc is not None and krc <= -5) or (nkc is not None and nkc <= -5):
            hits.append('asia')
        if spc is not None and spc <= -3:
            hits.append('sp')
        swan = len(hits) >= 2 or (len(hits) >= 1 and v is not None and v >= 32)
        out['days'].append(D)
        for k in CONDS:
            out['c'][k].append(c[k])
        out['passN'].append(pn)
        out['judged'].append(len(judged))
        out['formed'].append(1 if (len(judged) >= 6 and pn >= need) else 0)
        out['half'].append(1 if (judged and pn >= half) else 0)
        out['swan'].append(1 if swan else 0)
        out['swanHits'].append(hits)
    n = len(out['days'])
    out['meta'] = {
        'from': out['days'][0] if n else None, 'to': out['days'][-1] if n else None, 'n': n,
        'names': NAMES, 'scale_free': SCALE_FREE,
        'cover': {k: sum(1 for x in out['c'][k] if x is not None) for k in CONDS},
        'formed_share': round(sum(out['formed']) / n * 100, 1) if n else None,
        'swan_days': sum(out['swan']),
        'note': '決策日 D 只用 D 之前看得到的(台股 / 期貨 / 融資 = 前一交易日;美股 / 匯率 / 油 / 日圓 = 美國日期 < D;韓日 = 當地日期 < D)',
    }
    return out


# ── 🚦 閘門日期檔(給 portfolio_backtest DAYGATE / leader_probe pauseFile 用)───────────
#   ⭐ D 那天的「大盤狀態」只用 P(D 的前一個交易日)收盤 → 跟雷達同一個時間點,⛔ 不偷看 D 當天收盤
def mkt_state(rows):
    """rows = [(日期, 收盤), …](日期 YYYY-MM-DD,照日期排)→ {D: {'bear', 'below60', 'dd10'}},D 的值只用 D 之前那一天。
    bear = 收 < 60 日線 且 20 日線 < 60 日線(= App / 引擎的嚴格空頭);below60 = 收 < 60 日線;dd10 = 收 ≤ 近 252 日最高 × 0.9。"""
    out, cl = {}, []
    for i, (d, c) in enumerate(rows):
        if len(cl) >= 60:
            p = cl[-1]
            m20 = sum(cl[-20:]) / 20
            m60 = sum(cl[-60:]) / 60
            hi = max(cl[-252:])
            out[d] = {'bear': int(p < m60 and m20 < m60), 'below60': int(p < m60), 'dd10': int(p <= hi * 0.9)}
        cl.append(c)
    return out


def formed_k(passN, judged, k=2, floor=6):
    """雷達「成形」的門檻挪 k 格:過的條數 ≥ max(floor, 算得出來的條數 − k)(App 現行 = k 2、floor 6)。"""
    return [1 if (j >= floor and n >= max(floor, j - k)) else 0 for n, j in zip(passN, judged)]


def make_gates(hist, rows, ks=(1, 2, 3, 4)):
    """hist = build() 的輸出;rows = [(日期, 收盤)] → {名字: [被擋的日期]}(被擋 = 那天 ⛔ 不開新倉)。
    all = 雷達沒成形就不買 ・below60 / bear / dd10 = 大盤轉弱(前一天收盤)而且雷達沒成形才不買
    bearonly / below60only = 只看大盤、不看雷達(對照用)・swan = 黑天鵝那天不買。k ≠ 2 的加上 _k{k}(門檻高原)。"""
    st = mkt_state(rows)
    days = hist['days']
    G = {}
    for k in ks:
        f = formed_k(hist['passN'], hist['judged'], k)
        tg = '' if k == 2 else f'_k{k}'
        G['all' + tg] = [d for d, x in zip(days, f) if not x]
        for w in ('below60', 'bear', 'dd10'):
            G[w + tg] = [d for d, x in zip(days, f) if not x and st.get(d, {}).get(w)]
    for w in ('bear', 'below60'):
        G[w + 'only'] = [d for d in days if st.get(d, {}).get(w)]
    G['swan'] = [d for d, x in zip(days, hist['swan']) if x]
    return G


# ── selftest ───────────────────────────────────────────────────────────────
def _wd(n, start='2015-01-05'):
    import datetime as dt
    d = dt.date.fromisoformat(start)
    out = []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def _synth(n=400, vix_hi_from=None):
    days = _wd(n)
    tw = [[d.replace('-', '/'), 0, 10000 + i * 5 + 50, 0, 10000 + i * 5, 3e11 + (i % 7) * 1e9] for i, d in enumerate(days)]
    us = {'days': days, 'syms': {'^VIX': {'c': [(40 if (vix_hi_from and d >= vix_hi_from) else 15) for d in days]},
                                 '^GSPC': {'c': [3000 + i for i in range(n)]}},
          'mac': {'TWD=X': {'c': [30 - i * 0.001 for i in range(n)]}, 'CL=F': {'c': [70.0] * n},
                  'JPY=X': {'c': [110.0] * n}},
          'asia': {'^KS11': {'d': days, 'c': [2000 + i for i in range(n)]}}}
    fi = {'fut': {d: 1000 + i * 1000 for i, d in enumerate(days)}, 'mg': {d: 3000 - i for i, d in enumerate(days)},
          'bs': {d: [10.0, 0, 10000 + i * 5] for i, d in enumerate(days)}}
    return us, fi, {'twii': tw}, days


def selftest():
    fails = []

    def ok(name, cond, extra=''):
        print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:240]}'))
        if not cond:
            fails.append(name)

    us, fi, idx, days = _synth()
    o = build(us, fi, idx, [], start=days[0])
    ok('① 每個決策日都有 12 條(算不出來是 None)', len(o['days']) == len(days) - 1 and all(len(o['c'][k]) == len(o['days']) for k in CONDS))
    j = o['days'].index(days[300])
    ok('② 平穩上漲的合成盤:美股 / 台幣 / 韓股 / 油 / 日圓 / 5 日線 / 價差 都過', all(o['c'][k][j] == 1 for k in ('us', 'twd', 'kr', 'oil', 'jpy', 'ma5', 'bs')),
       {k: o['c'][k][j] for k in CONDS})
    ok('② 外資期貨每天 +1,000 口 → 5 日 +5,000 ≥3,000 過', o['c']['fut'][j] == 1)
    ok('② 成形門檻 = max(6, judged−2)', o['formed'][j] == (1 if o['passN'][j] >= max(6, o['judged'][j] - 2) else 0))
    # ③ VIX 從某天起 40 → 那天起「美股止穩」不過、而且 VIX ≥32 那天黑天鵝(單條 + VIX)
    us2, fi2, idx2, d2 = _synth(vix_hi_from=_wd(400)[350])
    o2 = build(us2, fi2, idx2, [], start=d2[0])
    k350 = o2['days'].index(d2[351])          # 決策日 351 看的是美國日期 < 351 → 第 350 天(VIX 40)
    ok('③ VIX 40 → 美股止穩不過、黑天鵝成立', o2['c']['us'][k350] == 0 and o2['swan'][k350] == 1, (o2['c']['us'][k350], o2['swanHits'][k350]))
    k349 = o2['days'].index(d2[350])          # 決策日 350 → 美國日期 < 350 → 第 349 天(VIX 15)
    ok('③ ⭐ 決定性對照:前一天還是 15 → 那天照過(⛔ 偷看當天)', o2['c']['us'][k349] == 1, o2['c']['us'][k349])
    # ④ 缺資料 → None(⛔ 當成沒過)
    us3 = json.loads(json.dumps(us)); us3['mac'].pop('JPY=X')
    o3 = build(us3, fi, idx, [], start=days[0])
    ok('④ 沒有日圓 → jpy 全是 None、judged 少 1', all(x is None for x in o3['c']['jpy']) and o3['judged'][j] == o['judged'][j] - 1)
    fi4 = dict(fi); fi4['fut'] = {}
    o4 = build(us, fi4, idx, [], start=days[0])
    ok('④ 外資期貨沒資料(2018-06 以前)→ None', all(x is None for x in o4['c']['fut']))
    # ⑤ App 同一支公式:派發日 / 波動率
    rows = [{'close': 100 - (i % 3), 'high': 101, 'amount': 1e11 + i * 1e9} for i in range(40)]
    ok('⑤ 派發日:量增下跌且沒被收復 → 有算到', (distribution_days(rows, 25) or 0) >= 1, distribution_days(rows, 25))
    v, p = realized_vol_pct([100 * (1.001 ** i) for i in range(300)])
    ok('⑤ 波動率:平穩序列算得出位階', v is not None and p is not None)
    # ⑥ 前視注入:把決策日當天的加權收盤改成暴跌,5 日線那條 ⛔ 不可以跟著變
    idx6 = json.loads(json.dumps(idx)); idx6['twii'][300][4] = 1.0
    o6 = build(us, fi, idx6, [], start=days[0])
    jj = o6['days'].index(days[300])
    ok('⑥ 決策日當天的收盤 ⛔ 影響那天的雷達(只用前一天)', o6['c']['ma5'][jj] == o['c']['ma5'][jj] and o6['c']['dist'][jj] == o['c']['dist'][jj])
    ok('⑥ 隔天的雷達才看得到它(5 日線那條變了)', o6['c']['ma5'][jj + 1] != o['c']['ma5'][jj + 1], (o6['c']['ma5'][jj + 1], o['c']['ma5'][jj + 1]))
    # ⑦ ^TWII.json 接在 idx_long 後面
    rec = [{'date': '2099/01/02', 'close': 1.0, 'high': 1.0, 'amount': 1}]
    ok('⑦ ^TWII.json 只接 idx_long 最後一天之後', twii_rows(idx, rec)[-1]['d'] == '2099-01-02' and len(twii_rows(idx, rec)) == len(days) + 1)
    # ⑧ 閘門日期檔:D 的大盤狀態只用前一天收盤;formed_k(k=2) == build 的 formed;bear 擋的日子一定是空頭日
    rows8 = [(dd, 100.0 + i * 0.1 if i < 200 else 100.0 + 20 - (i - 200) * 0.5) for i, dd in enumerate(days)]
    st8 = mkt_state(rows8)
    dz = days[150]                                            # 上漲段:前一天還不弱
    rows8b = list(rows8); rows8b[150] = (dz, 1.0)              # 把 D 當天收盤改成暴跌
    ok('⑧ D 那天的大盤狀態 ⛔ 看 D 當天收盤(只用前一天)', mkt_state(rows8b)[dz] == st8[dz], (mkt_state(rows8b)[dz], st8[dz]))
    ok('⑧ 隔天才看得到(D+1 的 dd10 / below60 變了)', mkt_state(rows8b)[days[151]]['dd10'] == 1 and st8[days[151]]['dd10'] == 0 and mkt_state(rows8b)[days[151]]['below60'] == 1)
    ok('⑧ 前 60 天沒有狀態(⛔ 不硬算)', days[30] not in st8 and days[60] in st8)
    ok('⑧ formed_k(k=2) == build 算的成形', formed_k(o['passN'], o['judged'], 2) == o['formed'])
    ok('⑧ 門檻放寬(k=4)成形的日子只會更多', sum(formed_k(o['passN'], o['judged'], 4)) >= sum(o['formed']) >= sum(formed_k(o['passN'], o['judged'], 1)))
    G8 = make_gates(o, rows8)
    bear_days = {d for d, v in st8.items() if v['bear']}
    ok('⑧ bear 閘門擋的日子都是空頭日、而且都是雷達沒成形的日子', set(G8['bear']) <= bear_days and set(G8['bear']) <= set(G8['all']), (len(G8['bear']), len(bear_days)))
    ok('⑧ bearonly == 全部空頭日(在雷達的日子裡)', set(G8['bearonly']) == bear_days & set(o['days']))
    ok('⑧ 有 k1 / k3 / k4 三組高原、k2 不帶後綴', all(f'all_k{k}' in G8 for k in (1, 3, 4)) and 'all' in G8 and 'all_k2' not in G8)
    print('\n' + ('❌ ' + str(len(fails)) + ' 條沒過' if fails else '✅ selftest 全部通過'))
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--us'); ap.add_argument('--fi'); ap.add_argument('--idx'); ap.add_argument('--twii')
    ap.add_argument('--out'); ap.add_argument('--start', default='2009-01-01')
    ap.add_argument('--gates', help='寫閘門日期檔的資料夾(配 --hist 已建好的 rebound_hist.json + --gate-twii 引擎用的 ^TWII.json)')
    ap.add_argument('--hist'); ap.add_argument('--gate-twii')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if a.gates:
        hist = json.load(open(a.hist, encoding='utf-8'))
        tw = json.load(open(a.gate_twii, encoding='utf-8'))
        tw = tw if isinstance(tw, list) else tw.get('data', [])
        rows = [(_ds(r.get('date')), float(r['close'])) for r in tw if r.get('close')]
        rows.sort()
        G = make_gates(hist, rows)
        os.makedirs(a.gates, exist_ok=True)
        n = len(hist['days'])
        for k, v in G.items():
            json.dump(v, open(os.path.join(a.gates, f'g_{k}.json'), 'w', encoding='utf-8'))
            print(f'🚦 g_{k}:擋 {len(v)} / {n} 天({len(v) / n * 100:.1f}%)')
        return 0
    us = json.load(open(a.us, encoding='utf-8'))
    fi = json.load(open(a.fi, encoding='utf-8'))
    idx = json.load(open(a.idx, encoding='utf-8'))
    tr = json.load(open(a.twii, encoding='utf-8')) if a.twii else []
    o = build(us, fi, idx, tr, start=a.start)
    m = o['meta']
    print(f"🧭 反攻雷達逐日重建:{m['from']} ~ {m['to']} ・{m['n']} 天 ・成形 {m['formed_share']}% 的日子 ・黑天鵝 {m['swan_days']} 天")
    print('   每一條算得出來的天數:' + '、'.join(f"{NAMES[k]} {m['cover'][k]}" for k in CONDS))
    if not m['n'] or m['n'] < 1000:
        print('⛔ 天數太少 → 不寫檔')
        return 1
    json.dump(o, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'💾 {a.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
