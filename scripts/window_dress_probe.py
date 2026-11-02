#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🗓️ window_dress_probe.py —— 投信季底作帳:季底前「投信重押」的股票會不會先漲、季底後會不會回吐?(V80.1.7)

使用者(2026-11-01):「有沒有沒人想到的領先指標,早知道先機,贏多一點少輸一點」→ 計畫 B1。
理由:投信每季要交成績(3 / 6 / 9 / 12 月,6 月與 12 月最重要),外面一直流傳「季底拉抬持股、季底後結帳賣壓」。
⭐ 網路上很多說法,沒找到學術實證 → 本站資料在手(2012 起個股投信買賣超 + 發行股數 + 16 年含下市 K 線),直接量。

方法(⛔ 用到未來的資料一律不行):
  ① 月底 T0 = 那個月最後一個交易日;排名日 R = T0 往前 11 個交易日(收盤後才知道 → 隔天開盤才能買)。
  ② 「投信重押」分數 = R 那天往前 60 個交易日的投信買賣超加總 ÷ R 那天的發行股數(⛔ 用到 R 之後的不算);
     只看 4 碼個股、近 20 日平均成交金額 ≥ 1,000 萬、60 天裡至少 50 天有法人資料。分數最高 10% = 重押、最低 10% = 倒貨。
  ③ 四個窗口(都是「開盤買 → 收盤賣」,含息):季底前 10 天(T0−10 開盤 → T0 收盤)、季底前 5 天、
     季底後 10 天(T0+1 開盤 → T0+10 收盤)、季底後 20 天。
  ④ 每一筆 = 那一組的平均 − 同一個月底、同樣窗口的「全部合格股票」平均(⛔ 不拿整段平均,陷阱 #50)。
  ⑤ 對照:同樣的做法套在**不是季底**的月底(1 / 2 / 4 / 5 / 7 / 8 / 10 / 11 月)—— 作帳是真的,季底要比平常月底明顯。
  ⑥ 關卡:季底那組的平均扣成本(0.44%)後同方向 ・前後半同方向 ・逐年 ≥70% 同方向 ・季底 − 非季底的差 t ≥ 2 ・
     門檻高原(前 5 / 10 / 20%、回看 20 / 60 / 120 天都同方向)。⛔ 一關沒過就只寫「沒用」。
  ⑦ 開盤一價到底鎖死買不到 → 那一筆不算(lib_limit,2015-06 前 ±7%);窗口裡有價格斷崖(減資 / 分割沒還原)→ 不算。

資料:DATA_DIR(預設 d16m_fi:含下市 + 2012 起法人)每檔 K 線 + _div16.json(除權息,前價 ÷ 參考價)
      SHARE_DIR(stock_deep/share 解開的資料夾:NumberOfSharesIssued)
跑法:DATA_DIR=... SHARE_DIR=... OUT=wd.json python3 scripts/window_dress_probe.py
      python3 scripts/window_dress_probe.py --selftest
"""
import bisect
import gzip
import json
import math
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib_limit as LL  # noqa: E402  漲跌幅制度 + 斷崖守門共用(⛔ 不在這裡各寫一份)

COST = 0.44
LIQ_MIN = 1e7                    # 近 20 日平均成交金額(元)
QE_MONTHS = (3, 6, 9, 12)
WINDOWS = ('pre10', 'pre5', 'post10', 'post20')
YR_MIN = 2


# ───────────────────────── 純函式 ─────────────────────────
def month_ends(cal):
    """交易日曆 → [(T0 索引, 'YYYY-MM')]:每個月最後一個交易日。"""
    out = []
    for i, d in enumerate(cal):
        if i + 1 == len(cal) or cal[i + 1][:7] != d[:7]:
            out.append((i, d[:7]))
    return out


def anchors(t0, pre=10, post=(10, 20), rank_gap=1):
    """T0(日曆索引)→ 各窗口的 (進場索引, 出場索引) 與排名日索引。開盤進、收盤出。"""
    r = t0 - pre - rank_gap
    return {'rank': r,
            'pre10': (t0 - pre, t0), 'pre5': (t0 - 5, t0),
            'post10': (t0 + 1, t0 + post[0]), 'post20': (t0 + 1, t0 + post[1])}


def div_factor(divs, d_in, d_out):
    """進場那天之後(⛔ 含進場那天:開盤價已經除過了)到出場那天(含)之間的除權息 → 收盤要乘回去的倍數(前價 ÷ 參考價)。"""
    f = 1.0
    for d, prev, ref in divs:
        if d_in < d <= d_out and prev and ref and ref > 0:
            f *= prev / ref
    return f


def score_at(trust, shares, i, look=60, need=None):
    """排名日 i 的投信重押分數 = 前 look 個交易日(含 i)投信買賣超加總 ÷ i 那天的發行股數。
    ⛔ 只用 ≤ i 的資料;有法人資料的天數 < need 或股數不知道 → None。"""
    need = need if need is not None else min(50, max(10, int(look * 0.8)))   # 回看 20 天時要 16 天有資料(⛔ 寫死 50 = 永遠 None)
    if i - look + 1 < 0 or not shares or shares <= 0:
        return None
    w = trust[i - look + 1:i + 1]
    vals = [x for x in w if x is not None]
    if len(vals) < need:
        return None
    return sum(vals) / shares


def mean(a):
    return sum(a) / len(a) if a else float('nan')


def tstat(a):
    n = len(a)
    if n < 3:
        return float('nan')
    m = mean(a)
    v = sum((x - m) ** 2 for x in a) / (n - 1)
    return m / math.sqrt(v / n) if v > 0 else float('nan')


def welch_t(a, b):
    if len(a) < 3 or len(b) < 3:
        return float('nan')
    ma, mb = mean(a), mean(b)
    va = sum((x - ma) ** 2 for x in a) / (len(a) - 1)
    vb = sum((x - mb) ** 2 for x in b) / (len(b) - 1)
    se = math.sqrt(va / len(a) + vb / len(b))
    return (ma - mb) / se if se > 0 else float('nan')


def judge(qe, pl, cost=COST):
    """qe / pl = [(月份 'YYYY-MM', 超額 %)]。回判定 dict(⛔ 一關沒過就 False)。"""
    v = [x for _, x in qe]
    m = mean(v)
    sg = 1 if m >= 0 else -1
    half = len(v) // 2
    h1, h2 = mean(v[:half]), mean(v[half:])
    yrs = {}
    for ym, x in qe:
        yrs.setdefault(ym[:4], []).append(x)
    ym_ = {y: mean(a) for y, a in yrs.items() if len(a) >= YR_MIN}
    same = sum(1 for x in ym_.values() if x * sg > 0)
    pv = [x for _, x in pl]
    tdiff = welch_t(v, pv)
    out = {'n': len(v), 'm': m, 't': tstat(v), 'h1': h1, 'h2': h2, 'yr': [same, len(ym_)],
           'plac': mean(pv), 'n_plac': len(pv), 'diff': m - mean(pv), 't_diff': tdiff}
    out['gates'] = {
        'after_cost': abs(m) - cost > 0,
        'halves': h1 * sg > 0 and h2 * sg > 0,
        'yearly': len(ym_) >= 5 and same >= 0.7 * len(ym_),
        'vs_placebo': tdiff == tdiff and abs(tdiff) >= 2 and (m - mean(pv)) * sg > 0,
    }
    out['pass'] = all(out['gates'].values())
    return out


# ───────────────────────── 讀資料 ─────────────────────────
def load_k(path):
    try:
        rows = json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return None
    rows = rows if isinstance(rows, list) else (rows.get('data') or [])
    K = {'d': [], 'o': [], 'h': [], 'l': [], 'c': [], 'v': [], 't': []}
    for r in rows:
        try:
            op, cl = float(r['open']), float(r['close'])
        except Exception:
            continue
        if op <= 0 or cl <= 0:
            continue
        K['d'].append(str(r['date']).replace('/', '-')[:10])
        K['o'].append(op)
        K['c'].append(cl)
        K['h'].append(float(r.get('high') or cl))
        K['l'].append(float(r.get('low') or cl))
        K['v'].append(float(r.get('volume') or 0))
        tn = r.get('trust_net')
        K['t'].append(float(tn) if tn is not None else None)
    return K if len(K['d']) > 120 else None


def load_shares(share_dir, sym):
    p = Path(share_dir) / f'{sym}.json.gz'
    if not p.exists():
        return None
    try:
        with gzip.open(p, 'rt', encoding='utf-8') as f:
            j = json.load(f)
        k = j['c'].index('NumberOfSharesIssued')
        return [(d, row[k]) for d, row in zip(j['d'], j['v']) if row[k]]
    except Exception:
        return None


def shares_on(sh, d):
    """d 那天(含)以前最近一筆發行股數(⛔ 不用之後的)。"""
    if not sh:
        return None
    i = bisect.bisect_right([x[0] for x in sh], d) - 1
    return sh[i][1] if i >= 0 else None


def stock_records(sym, K, sh, divs, cal, ends, look=60):
    """一檔 → {月份: {'s': 分數, 'liq': bool, 'pre10': 報酬%, …}}。只讀這一檔(串流,⛔ 全部載進記憶體)。"""
    pos = {d: i for i, d in enumerate(K['d'])}
    shd = [x[0] for x in sh] if sh else []
    out = {}
    for t0, ym in ends:
        a = anchors(t0)
        if a['rank'] < 0 or a['post20'][1] >= len(cal):
            continue
        rd = cal[a['rank']]
        ri = pos.get(rd)
        if ri is None or ri < look:
            continue
        si = bisect.bisect_right(shd, rd) - 1
        shares = sh[si][1] if si >= 0 else None
        s = score_at(K['t'], shares, ri, look)
        liq = mean([K['c'][j] * K['v'][j] for j in range(max(0, ri - 19), ri + 1)]) >= LIQ_MIN
        rec = {'s': s, 'liq': liq}
        for w in WINDOWS:
            ei, xi = a[w]
            de, dx = cal[ei], cal[xi]
            i, j = pos.get(de), pos.get(dx)
            if i is None or j is None or j < i or i < 1:
                continue
            if LL.locked_bar(K['d'][i], K['c'][i - 1], K['o'][i], K['h'][i], K['l'][i]) != 0:
                continue
            pre = K.get('_cl')
            if pre is None:
                pre = K['_cl'] = LL.cliff_prefix(K['c'], K['o'])
            if LL.cliff_in(pre, i, j):
                continue
            rec[w] = (K['c'][j] * div_factor(divs, de, dx) / K['o'][i] - 1) * 100
        out[ym] = rec
    return out


def aggregate(recs_by_sym, top=0.10, liq_only=True):
    """recs_by_sym = {代號: {月份: rec}} → {月份: {w: (重押 − 全部, 倒貨 − 全部, 重押 n)}}。"""
    months = sorted({m for r in recs_by_sym.values() for m in r})
    res = {}
    for ym in months:
        rows = [r[ym] for r in recs_by_sym.values() if ym in r and (r[ym]['liq'] or not liq_only)]
        sc = [x for x in rows if x['s'] is not None]
        if len(sc) < 100:
            continue
        sc.sort(key=lambda x: x['s'])
        k = max(1, int(len(sc) * top))
        lo, hi = sc[:k], sc[-k:]
        res[ym] = {}
        for w in WINDOWS:
            base = [x[w] for x in rows if w in x]
            if len(base) < 100:
                continue
            b = mean(base)
            hv = [x[w] for x in hi if w in x]
            lv = [x[w] for x in lo if w in x]
            if len(hv) >= 10 and len(lv) >= 10:
                res[ym][w] = (mean(hv) - b, mean(lv) - b, len(hv))
    return res


def split_qe(res, w, side=0, months=QE_MONTHS):
    qe, pl = [], []
    for ym, r in sorted(res.items()):
        if w not in r:
            continue
        (qe if int(ym[5:7]) in months else pl).append((ym, r[w][side]))
    return qe, pl


# ───────────────────────── 主程式 ─────────────────────────
def main():
    data = Path(os.getenv('DATA_DIR') or 'd16m_fi')
    share_dir = Path(os.getenv('SHARE_DIR') or 'stock_deep/share')
    out_path = os.getenv('OUT') or ''
    cal = load_k(data / '^TWII.json')
    if not cal:
        print('❌ 讀不到加權指數(交易日曆)')
        return 1
    cal = cal['d']
    ends = [(t0, ym) for t0, ym in month_ends(cal) if ym >= '2012-07']
    divj = json.loads((data / '_div16.json').read_text(encoding='utf-8'))['d']
    print(f'📅 日曆 {cal[0]} ~ {cal[-1]} ・月底 {len(ends)} 個(2012-07 起)', flush=True)
    recs = {}
    files = sorted(p for p in data.glob('*.json') if re.match(r'^\d{4}$', p.stem))
    n_sh = 0
    for n, p in enumerate(files):
        K = load_k(p)
        if not K:
            continue
        sh = load_shares(share_dir, p.stem)
        if sh:
            n_sh += 1
        divs = [(r[0], r[3], r[4]) for r in (divj.get(p.stem) or {}).get('h', []) if len(r) >= 5]
        r = stock_records(p.stem, K, sh, divs, cal, ends)
        if r:
            recs[p.stem] = r
        if n % 500 == 0:
            print(f'   … {n}/{len(files)}', flush=True)
    print(f'📦 個股 {len(recs)} 檔(有發行股數 {n_sh} 檔)', flush=True)
    summary = {}
    for top in (0.05, 0.10, 0.20):
        res = aggregate(recs, top)
        for w in WINDOWS:
            for side, lab in ((0, '重押'), (1, '倒貨')):
                qe, pl = split_qe(res, w, side)
                j = judge(qe, pl)
                qe6, _ = split_qe(res, w, side, (6, 12))
                key = f'top{int(top * 100)}_{w}_{lab}'
                j['m_jun_dec'] = mean([x for _, x in qe6])
                summary[key] = j
                if top == 0.10 or j['pass']:
                    g = ''.join('✅' if v else '❌' for v in j['gates'].values())
                    print(f'{key:<22} 季底 {j["m"]:+.2f}%(n={j["n"]},t={j["t"]:.1f}) 非季底 {j["plac"]:+.2f}% 差 {j["diff"]:+.2f}(t={j["t_diff"]:.1f}) '
                          f'6/12月 {j["m_jun_dec"]:+.2f} 前後半 {j["h1"]:+.2f}/{j["h2"]:+.2f} 逐年 {j["yr"][0]}/{j["yr"][1]} 關卡 {g}', flush=True)
    # 回看天數高原(只看前 10%)
    for look in (20, 120):
        recs2 = {}
        for p in files:
            K = load_k(p)
            if not K:
                continue
            sh = load_shares(share_dir, p.stem)
            divs = [(r[0], r[3], r[4]) for r in (divj.get(p.stem) or {}).get('h', []) if len(r) >= 5]
            r = stock_records(p.stem, K, sh, divs, cal, ends, look=look)
            if r:
                recs2[p.stem] = r
        res = aggregate(recs2, 0.10)
        for w in WINDOWS:
            qe, pl = split_qe(res, w, 0)
            j = judge(qe, pl)
            summary[f'look{look}_{w}_重押'] = j
            print(f'回看 {look} 天 {w:<6} 重押 季底 {j["m"]:+.2f}% 非季底 {j["plac"]:+.2f}% 差 {j["diff"]:+.2f}(t={j["t_diff"]:.1f})', flush=True)
    if out_path:
        Path(out_path).write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=float), encoding='utf-8')
    passed = [k for k, v in summary.items() if v.get('pass')]
    print(f'📋 六關全過的組合:{passed or "沒有"}', flush=True)
    return 0


def selftest():
    import random
    bad = []

    def ok(n, c, e=''):
        print(('✅ ' if c else '❌ ') + n + ('' if c else '  ' + str(e)[:200]))
        if not c:
            bad.append(n)
    cal = []
    import datetime as dt
    d = dt.date(2013, 1, 1)
    while len(cal) < 900:
        if d.weekday() < 5:
            cal.append(d.isoformat())
        d += dt.timedelta(days=1)
    ends = [(t0, ym) for t0, ym in month_ends(cal) if ym >= '2013-04']
    ok('① 月底 = 每個月最後一個交易日', all(cal[t][:7] != cal[t + 1][:7] for t, _ in ends if t + 1 < len(cal)))
    a = anchors(100)
    ok('② 排名日在季底前 10 天進場之前(收盤後才知道 → 隔天開盤買)', a['rank'] < a['pre10'][0] and a['pre10'] == (90, 100) and a['post10'] == (101, 110))
    ok('③ 除權息:進場那天除息 ⛔ 補(開盤已經除過)、窗口內除息要補', div_factor([('2015-07-01', 10, 9)], '2015-07-01', '2015-07-10') == 1.0
       and abs(div_factor([('2015-07-02', 10, 9)], '2015-07-01', '2015-07-10') - 10 / 9) < 1e-9)
    tr = [0.0] * 100 + [1e6] * 10
    ok('④ 分數只用排名日以前的(⛔ 偷看之後的法人買賣超)', score_at(tr, 1e8, 99) == 0.0 and score_at(tr, 1e8, 109) > 0)
    ok('④ 法人資料不夠 / 股數不知道 → None', score_at([None] * 100, 1e8, 99) is None and score_at(tr, None, 99) is None)
    ok('④ 回看 20 天:要 16 天有資料就算(⛔ 跟 60 天同一個門檻 = 永遠算不出來)', score_at([1.0] * 30, 1e2, 29, look=20) == 0.2 and score_at([None] * 10 + [1.0] * 20, 1e2, 29, look=20) is not None)

    def synth(effect_months, seed=7, n=300):
        rnd = random.Random(seed)
        recs = {}
        qe_end = {t0 for t0, ym in ends if int(ym[5:7]) in effect_months}
        for k in range(n):
            sym = f'{1000 + k}'
            heavy = k < n // 10
            c, K = 50.0, {'d': [], 'o': [], 'h': [], 'l': [], 'c': [], 'v': [], 't': []}
            for i, dd in enumerate(cal):
                drift = 0.0
                for t0 in qe_end:
                    if heavy and t0 - 10 <= i <= t0:
                        drift = 0.002          # 季底前每天多漲 0.2%
                    elif heavy and t0 < i <= t0 + 10:
                        drift = -0.002         # 季底後每天多跌 0.2%
                o = c
                c = c * (1 + drift + rnd.gauss(0, 0.01))
                K['d'].append(dd); K['o'].append(o); K['c'].append(c); K['h'].append(max(o, c)); K['l'].append(min(o, c))
                K['v'].append(1e6)
                K['t'].append((3e5 if heavy else -1e4) + rnd.gauss(0, 1e3))
            sh = [(cal[0], 1e8)]
            recs[sym] = stock_records(sym, K, sh, [], cal, ends)
        return aggregate(recs, 0.10)
    res = synth(QE_MONTHS)
    qe, pl = split_qe(res, 'pre10', 0)
    j = judge(qe, pl, cost=0.0)
    ok('⑤ 注入「季底前重押股多漲」→ 量得到、而且季底比非季底大', j['m'] > 1.0 and j['diff'] > 1.0 and j['t_diff'] > 2, j)
    qe, pl = split_qe(res, 'post10', 0)
    j2 = judge(qe, pl, cost=0.0)
    ok('⑤ 注入「季底後回吐」→ 季底後是負的', j2['m'] < -1.0 and j2['diff'] < -1.0, j2)
    res_all = synth(tuple(range(1, 13)))
    qe, pl = split_qe(res_all, 'pre10', 0)
    j3 = judge(qe, pl, cost=0.0)
    ok('⑥ 決定性對照:每個月底都一樣 → 季底 − 非季底 ≈ 0(⛔ 不是季底特有就不算)', abs(j3['diff']) < 0.6 and not j3['gates']['vs_placebo'], j3)
    res0 = synth(())
    qe, pl = split_qe(res0, 'pre10', 0)
    j4 = judge(qe, pl, cost=0.0)
    ok('⑦ 沒有效果 → 平均 ≈ 0、不過關', abs(j4['m']) < 0.6 and not j4['pass'], j4)
    print(('\n❌ selftest 失敗 ' + str(bad)) if bad else '\n✅ selftest 全過')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
