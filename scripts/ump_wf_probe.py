#!/usr/bin/env python3
"""
🤖 V80.1.3 機器學習擋單(abu 的 UMP 裁判)改成「照時間切」(19 個專案評估 4-4;先驗低)

abu 的做法有兩個漏洞(評估報告 ㊾):交叉驗證把股票打散、訓練和測試是同一段時間;標準化用到要預測的那一天。
這裡照時間切:
  - 每一年 Y 當測試年:只拿「出場日早於 Y 年 1 月 1 日」的交易訓練(⛔ 進場在去年、出場在今年的那筆,
    年初還不知道結果 → 不能拿來訓練)。
  - 標準化的平均 / 標準差只用訓練資料(⛔ 用到測試年)。
  - 特徵只用進場日「前一天」以前的資料(股價 / 量 / 跟大盤的相關);大盤特徵用引擎 TAKEN_OUT 已算好的(都是昨天以前)。
兩種裁判:① 邏輯斯迴歸(猜「這筆會不會賺」)② k-means 分群(訓練期平均賠錢的那幾群擋掉)。
每年擋掉分數最差的 BLOCK%(預設 30%),比:留下的平均每趟 vs 全部;對照 = 同一年隨機擋掉一樣多筆(20 組)。

跑法:DATA_DIR=<d16> python3 scripts/ump_wf_probe.py '<taken 檔名樣式,含 {W}>' [out.json]
⚠️ 母體 = 🔥 實際成交的交易(17 個起點聯集去重);這是事件層的初篩 —— 過了才值得接進引擎做整套資金回測。
"""
import glob
import json
import math
import os
import re
import sys

import numpy as np

COST = 0.44
BLOCK = float(os.environ.get('BLOCK') or 0.3)
MIN_TRAIN_Y = 3          # 至少 3 年的訓練資料才開始測
K_CLUST = 12
SHAMS = 20
FEATS_STK = ['r5', 'r20', 'r60', 'vol20', 'pos250', 'ma20gap', 'ma60gap', 'vr', 'corr']
FEATS_MKT = ['vol', 'dd60', 'pret', 'up', 'flr', 'lag']


def _d(s):
    return str(s or '')[:10].replace('/', '-')


def stock_feats(rows, mkt_ret, d):
    """rows = 這檔 K 線(由舊到新);d = 進場日 → 只用 d 的前一天以前。回 dict 或 None(歷史不夠)。"""
    dates = [_d(r.get('date')) for r in rows]
    i = next((k for k, x in enumerate(dates) if x >= d), len(dates))   # 第一根 ≥ d
    j = i - 1                                                            # 前一天
    if j < 260:
        return None
    c = [float(rows[k].get('close') or 0) for k in range(j - 259, j + 1)]
    v = [float(rows[k].get('volume') or 0) for k in range(j - 21, j + 1)]
    if min(c) <= 0:
        return None
    cj = c[-1]
    rets = [c[k] / c[k - 1] - 1 for k in range(len(c) - 20, len(c))]
    ma20 = sum(c[-20:]) / 20
    ma60 = sum(c[-60:]) / 60
    base = sum(v[:20]) / 20                         # 前一天之前的 20 天(⛔ 含被判斷的那一天,陷阱 #43)
    # 跟大盤 250 天相關
    xs, ys = [], []
    for k in range(j, max(0, j - 250), -1):
        a = rows[k].get('close'); b = rows[k - 1].get('close')
        m = mkt_ret.get(dates[k])
        if a and b and float(b) > 0 and m is not None:
            x = float(a) / float(b) - 1
            if abs(x) < 0.5:
                xs.append(x); ys.append(m)
    corr = float(np.corrcoef(xs, ys)[0, 1]) if len(xs) >= 120 and np.std(xs) > 0 and np.std(ys) > 0 else None
    return {
        'r5': cj / c[-6] - 1, 'r20': cj / c[-21] - 1, 'r60': cj / c[-61] - 1,
        'vol20': float(np.std(rets)) * math.sqrt(252), 'pos250': sum(1 for x in c if x <= cj) / len(c),
        'ma20gap': cj / ma20 - 1, 'ma60gap': cj / ma60 - 1, 'vr': (v[-1] / base) if base > 0 else None, 'corr': corr,
    }


def logit_fit(X, y, l2=1.0, it=400, lr=0.1):
    n, p = X.shape
    w = np.zeros(p); b = 0.0
    for _ in range(it):
        z = X @ w + b
        pr = 1 / (1 + np.exp(-np.clip(z, -30, 30)))
        g = pr - y
        w -= lr * (X.T @ g / n + l2 * w / n)
        b -= lr * g.mean()
    return w, b


def kmeans(X, k, seed=7, it=50):
    rng = np.random.default_rng(seed)
    C = X[rng.choice(len(X), size=min(k, len(X)), replace=False)].copy()
    for _ in range(it):
        lab = np.argmin(((X[:, None, :] - C[None, :, :]) ** 2).sum(-1), axis=1)
        for q in range(len(C)):
            m = lab == q
            if m.any():
                C[q] = X[m].mean(0)
    return C


def walk_forward(T, block=BLOCK, shams=SHAMS, seed=11):
    """T = [{d, outD, net, f: [特徵…]}](特徵已補好、缺值 = nan)→ 每一年的結果"""
    years = sorted({t['d'][:4] for t in T})
    out = []
    rng = np.random.default_rng(seed)
    for y in years:
        cut = f'{y}-01-01'
        tr = [t for t in T if t['outD'] < cut]                       # ⛔ 出場在測試年以後的不能拿來訓練
        te = [t for t in T if t['d'][:4] == y]
        if len({t['d'][:4] for t in tr}) < MIN_TRAIN_Y or len(te) < 30 or len(tr) < 200:
            continue
        Xtr = np.array([t['f'] for t in tr], dtype=float); Xte = np.array([t['f'] for t in te], dtype=float)
        mu = np.nanmean(Xtr, 0); sd = np.nanstd(Xtr, 0); sd[sd == 0] = 1
        Xtr = np.nan_to_num((Xtr - mu) / sd); Xte = np.nan_to_num((Xte - mu) / sd)   # ⛔ 只用訓練期的平均 / 標準差
        ytr = np.array([1.0 if t['net'] > 0 else 0.0 for t in tr])
        nte = np.array([t['net'] for t in te])
        w, b = logit_fit(Xtr, ytr)
        s_log = Xte @ w + b
        C = kmeans(Xtr, K_CLUST)
        lab_tr = np.argmin(((Xtr[:, None, :] - C[None]) ** 2).sum(-1), 1)
        cm = np.array([np.mean([t['net'] for t, l in zip(tr, lab_tr) if l == q]) if (lab_tr == q).any() else 0 for q in range(len(C))])
        s_km = cm[np.argmin(((Xte[:, None, :] - C[None]) ** 2).sum(-1), 1)]
        nb = int(round(len(te) * block))
        row = {'y': y, 'n': len(te), 'ntrain': len(tr), 'all': float(nte.mean())}
        for nm, s in (('log', s_log), ('km', s_km)):
            keep = np.argsort(s)[nb:]                                  # 擋掉分數最差的 nb 筆
            row[nm] = float(nte[keep].mean()) - row['all']
        sh = [float(nte[rng.permutation(len(te))[nb:]].mean()) - row['all'] for _ in range(shams)]
        row['sham'] = float(np.mean(sh)); row['shamSd'] = float(np.std(sh))
        out.append(row)
    return out


def summarize(rows):
    S = {}
    for nm in ('log', 'km'):
        xs = [r[nm] for r in rows]
        S[nm] = {'mean': float(np.mean(xs)) if xs else None, 'pos': sum(1 for x in xs if x > 0), 'years': len(xs),
                 'beatSham': sum(1 for r in rows if r[nm] > r['sham'] + 2 * r['shamSd'])}
    return S


def main():
    pat = sys.argv[1] if len(sys.argv) > 1 else ''
    if '{W}' not in pat:
        print("用法:DATA_DIR=<d16> python3 scripts/ump_wf_probe.py '<含 {W} 的 taken 檔名樣式>' [out.json]"); return 1
    files = sorted(glob.glob(pat.replace('{W}', '*')))
    if len(files) < 5:
        print(f'❌ 只找到 {len(files)} 個起點的成交明細'); return 1
    D = os.environ.get('DATA_DIR') or 'data'
    mrows = json.load(open(os.path.join(D, '^TWII.json')))
    mrows = mrows if isinstance(mrows, list) else mrows.get('data')
    mret = {}
    for k in range(1, len(mrows)):
        a, b = float(mrows[k]['close']), float(mrows[k - 1]['close'])
        if b > 0:
            mret[_d(mrows[k]['date'])] = a / b - 1
    uniq = {}
    for f in files:
        for t in json.load(open(f)):
            uniq[(t['sym'], t['d'], t['key'])] = t
    keys = {}
    for t in uniq.values():
        keys[t['key']] = keys.get(t['key'], 0) + 1
    top = [k for k, _ in sorted(keys.items(), key=lambda x: -x[1])[:8]]
    cache, T = {}, []
    for (sym, d, key), t in sorted(uniq.items(), key=lambda x: x[0][1]):
        if sym not in cache:
            try:
                j = json.load(open(os.path.join(D, sym + '.json')))
                cache[sym] = j if isinstance(j, list) else j.get('data')
            except Exception:
                cache[sym] = None
        rows = cache[sym]
        sf = stock_feats(rows, mret, d) if rows else None
        if not sf:
            continue
        f = [sf[k] if sf[k] is not None else float('nan') for k in FEATS_STK]
        f += [float(t[k]) if t.get(k) is not None else float('nan') for k in FEATS_MKT]
        f += [1.0 if key == k2 else 0.0 for k2 in top]
        T.append({'d': d, 'outD': t['outD'], 'net': float(t['ret']) + float(t.get('dv') or 0) - COST, 'f': f})
    rows = walk_forward(T)
    S = summarize(rows)
    print(f'📦 {len(files)} 個起點 → 去重後 {len(uniq):,} 筆、有特徵 {len(T):,} 筆 ・每年擋掉分數最差的 {BLOCK:.0%}(對照 = 隨機擋一樣多,{SHAMS} 組)')
    for r in rows:
        print(f"  {r['y']} 測 {r['n']:4d} 筆(訓練 {r['ntrain']:5d})全部每趟 {r['all']:+.2f}% ・邏輯斯 {r['log']:+.2f} ・分群 {r['km']:+.2f} ・隨機 {r['sham']:+.2f}±{r['shamSd']:.2f}")
    for nm, lab in (('log', '邏輯斯迴歸'), ('km', 'k-means 分群')):
        s = S[nm]
        print(f"⭐ {lab}:留下的比全部平均多 {s['mean']:+.3f}pp ・{s['pos']}/{s['years']} 年是正的 ・{s['beatSham']}/{s['years']} 年贏隨機擋(超過 2 個標準差)")
    out = {'meta': {'files': len(files), 'uniq': len(uniq), 'n': len(T), 'block': BLOCK, 'feats': FEATS_STK + FEATS_MKT + ['key:' + k for k in top]}, 'years': rows, 'sum': S}
    f = next((a for a in sys.argv[2:] if a.endswith('.json')), None)
    if f:
        json.dump(out, open(f, 'w'), ensure_ascii=False, indent=1)
        print(f'💾 {f}')
    return 0


def _selftest():
    bad = []

    def ok(m, c, x=None):
        print(('✅ ' if c else '❌ ') + m + ('' if c else f'  {x}'))
        if not c:
            bad.append(m)

    rng = np.random.default_rng(3)

    def mk(signal):
        T = []
        for y in range(2012, 2024):
            for k in range(400):
                f = rng.normal(size=6).tolist()
                net = (1.5 * f[0] if signal else 0) + rng.normal() * 4
                d = f'{y}-{1 + k % 12:02d}-{1 + k % 27:02d}'
                T.append({'d': d, 'outD': d, 'net': net, 'f': f})
        return T

    S1 = summarize(walk_forward(mk(True)))
    ok(f"① 第一個特徵真的能猜 → 邏輯斯留下的比較好({S1['log']['mean']:+.2f})、多數年份贏隨機", S1['log']['mean'] > 0.5 and S1['log']['beatSham'] >= S1['log']['years'] * 0.6, S1)
    S0 = summarize(walk_forward(mk(False)))
    ok(f"② 特徵都是亂數 → 留下的跟全部差不多({S0['log']['mean']:+.2f})、幾乎不贏隨機", abs(S0['log']['mean']) < 0.4 and S0['log']['beatSham'] <= 2, S0)
    # ③ ⛔ 前視:出場在測試年以後的那筆不能進訓練 → 注入「明年才知道結果」的交易,看它有沒有被拿去訓練
    T = mk(True)
    for t in T:
        if t['d'][:4] == '2016':
            t['outD'] = '2017-01-05'
    yrs = {r['y']: r['ntrain'] for r in walk_forward(T)}
    yrs0 = {r['y']: r['ntrain'] for r in walk_forward(mk(True))}
    ok('③ ⛔ 前視:2016 年進場、2017 才出場 → 2017 年的訓練少了那些筆', yrs.get('2017', 0) < yrs0.get('2017', 0), (yrs.get('2017'), yrs0.get('2017')))
    # ④ 股票特徵只用前一天以前:進場日當天之後的價改掉,特徵不變
    rows = [{'date': f'2020-{1 + k // 28 % 12:02d}-{1 + k % 28:02d}', 'close': 100 + (k % 13), 'volume': 1000 + k} for k in range(400)]
    rows.sort(key=lambda r: r['date'])
    for k, r in enumerate(rows):
        r['date'] = f'2019-01-01' if False else r['date']
    dates = sorted({r['date'] for r in rows})
    rows = [{'date': d, 'close': 100 + (k % 13) + k * 0.01, 'volume': 1000 + k} for k, d in enumerate(dates)]
    mret = {r['date']: 0.001 * ((k % 5) - 2) for k, r in enumerate(rows)}
    d = rows[300]['date']
    f1 = stock_feats(rows, mret, d)
    rows2 = [dict(r) for r in rows]
    for r in rows2[300:]:
        r['close'] = 1.0
    f2 = stock_feats(rows2, mret, d)
    ok('④ ⛔ 前視:進場日當天與之後的價改掉 → 股票特徵一個都不變', f1 == f2, (f1, f2))
    print('\n✅ UMP_WF_SELFTEST_PASS' if not bad else f'\n❌ UMP_WF_SELFTEST_FAIL {len(bad)}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(_selftest() if '--selftest' in sys.argv else main())
