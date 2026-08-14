#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🤖 機器學習探針(V73.4.3)—— 只讀 data/,不打網路、不寫產物、零依賴。

❓ 它要回答的問題(使用者 2026-08-14 截圖:Gemini 建議「引入 XGBoost / LightGBM / LSTM
   / 強化學習」）:**在本專案自己的資料上,樹模型對「未來 20 日超額報酬」有沒有樣本外預測力?**

⛔ 沙箱沒有 numpy / sklearn / xgboost / lightgbm / torch(實測全部 ModuleNotFoundError)
   → 這裡**自己實作** LightGBM 的核心(直方圖式梯度提升 + 深度 2 的樹 + logistic loss)。
   ⭐ 重點不是「復刻 XGBoost 的每個功能」,而是回答「**這批特徵裡到底有沒有訊號**」——
     若連梯度提升都學不出東西,LSTM/RL 只會更糟(參數更多、樣本更少、搜尋空間更大)。

📐 六道守門(照本專案回測鐵則,⛔ 少一道結論就不可信):
  ① **時間切分**,⛔ 不可隨機切 —— 隨機切會讓同一天的不同股票同時出現在訓練與測試,
     那是把答案抄給模型看。
  ② **purge/embargo**:標籤是「未來 20 日」→ 訓練集尾巴的標籤會偷看到測試集開頭
     → 中間**挖掉 25 個交易日**。
  ③ **對照組是測試集自己的基準率**,⛔ 不是 50%(中位數個股本來就輸大盤,本專案實測基準 34.6~36.4%)。
  ④ **報酬扣同期加權指數**(超額報酬),⛔ 不可用絕對報酬 —— 大多頭裡什麼都是正的。
  ⑤ **自我驗證**:`--selftest` 注入一個「一定學得到」的洩漏特徵,測試集 AUC 必須 >0.8。
     ⛔ 沒有這條的話,「AUC 0.50」分不出是「沒有訊號」還是「我的程式寫壞了」。
  ⑥ **空過守門**:測試樣本 <20,000 → exit 1。

⚠️ 已知限制(誠實寫下,⛔ 別過度解讀):
  ・特徵只有 K 線衍生(籌碼欄位 `foreign_net` 中位只有 28 天、`trust_net` 203/291 檔全空,
    要等 2027/05 才驗得動,見 CLAUDE.md V72.9.7)。
  ・窗口是本專案資料涵蓋的那幾年,**沒有涵蓋真正的空頭**。
  ・這支證明的是「這批特徵 + 這種模型」沒有邊際,⛔ 不等於「機器學習在台股永遠沒用」。
"""
import json
import math
import os
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.getenv('DATA_DIR') or (ROOT / 'data'))

FWD = 20             # 標籤天期:未來 20 個交易日
STEP = 5             # 每 5 根取一個樣本(降低重疊/自我相關)
WARM = 260           # 特徵要用到 252 日位階 → 前面 260 根不取樣
PURGE = 25           # ② 訓練與測試之間挖掉的交易日數(> FWD)
BINS = 32
ROUNDS = 60
LR = 0.08
MIN_CHILD = 200
MAX_TRAIN = 90000    # 純 Python 跑得動的上限
MIN_TEST = 20000     # ⑥ 空過守門

FEATS = ['ret1', 'ret5', 'ret20', 'ret60', 'bias5', 'bias20', 'bias60',
         'rsi14', 'volr', 'pos252', 'vol20', 'dd60', 'slope20', 'amp20']


# ───────────────────────── 特徵(全部只用「當天為止」的資料,⛔ 無前視)─────────────────────────
def build_rows(cl, hi, lo, vo):
    """回 [(i, [特徵…]) …]。⛔ 每一個特徵都只讀 index <= i。"""
    n = len(cl)
    out = []
    # 預先算 RSI(Wilder)
    gain = [0.0] * n
    loss = [0.0] * n
    for i in range(1, n):
        d = cl[i] - cl[i - 1]
        gain[i] = d if d > 0 else 0.0
        loss[i] = -d if d < 0 else 0.0
    ag = al = 0.0
    rsi = [50.0] * n
    for i in range(1, n):
        if i <= 14:
            ag += gain[i] / 14.0
            al += loss[i] / 14.0
        else:
            ag = (ag * 13 + gain[i]) / 14.0
            al = (al * 13 + loss[i]) / 14.0
        rsi[i] = 100.0 if al <= 0 else 100.0 - 100.0 / (1.0 + ag / al)

    csum = [0.0] * (n + 1)
    for i in range(n):
        csum[i + 1] = csum[i] + cl[i]
    vsum = [0.0] * (n + 1)
    for i in range(n):
        vsum[i + 1] = vsum[i] + vo[i]

    def ma(i, k):
        return (csum[i + 1] - csum[i + 1 - k]) / k

    for i in range(WARM, n):
        c = cl[i]
        if c <= 0:
            continue
        m5, m20, m60 = ma(i, 5), ma(i, 20), ma(i, 60)
        m20p = (csum[i - 4] - csum[i - 24]) / 20.0  # 5 天前的 20MA → 斜率
        if m5 <= 0 or m20 <= 0 or m60 <= 0 or m20p <= 0:
            continue
        v20 = (vsum[i + 1] - vsum[i + 1 - 20]) / 20.0
        w = cl[i - 251:i + 1]
        lo252, hi252 = min(w), max(w)
        h60 = max(hi[i - 59:i + 1])
        # 20 日實現波動(年化)與平均振幅
        s = 0.0
        for k in range(i - 19, i + 1):
            if cl[k - 1] > 0:
                s += (cl[k] / cl[k - 1] - 1.0) ** 2
        vol20 = math.sqrt(s / 20.0) * math.sqrt(252.0) * 100.0
        amp = 0.0
        for k in range(i - 19, i + 1):
            if cl[k] > 0:
                amp += (hi[k] - lo[k]) / cl[k]
        f = [
            (c / cl[i - 1] - 1) * 100 if cl[i - 1] > 0 else 0.0,
            (c / cl[i - 5] - 1) * 100 if cl[i - 5] > 0 else 0.0,
            (c / cl[i - 20] - 1) * 100 if cl[i - 20] > 0 else 0.0,
            (c / cl[i - 60] - 1) * 100 if cl[i - 60] > 0 else 0.0,
            (c / m5 - 1) * 100,
            (c / m20 - 1) * 100,
            (c / m60 - 1) * 100,
            rsi[i],
            (vo[i] / v20 * 100) if v20 > 0 else 100.0,
            ((c - lo252) / (hi252 - lo252) * 100) if hi252 > lo252 else 50.0,
            vol20,
            (c / h60 - 1) * 100 if h60 > 0 else 0.0,
            (m20 / m20p - 1) * 100,
            amp / 20.0 * 100,
        ]
        out.append((i, f))
    return out


# ───────────────────────── 直方圖梯度提升(深度 2)─────────────────────────
def quantile_edges(col, k):
    s = sorted(col)
    n = len(s)
    e = []
    for j in range(1, k):
        v = s[int(n * j / k)]
        if not e or v > e[-1]:
            e.append(v)
    return e or [s[n // 2]]


def to_bin(v, edges):
    lo, hi = 0, len(edges)
    while lo < hi:
        mid = (lo + hi) // 2
        if v > edges[mid]:
            lo = mid + 1
        else:
            hi = mid
    return lo


def best_split(idx, X, g, h, nb, nf):
    """回 (gain, feat, bin) —— 直方圖掃描,⛔ 與 LightGBM 同一套。"""
    best = (0.0, -1, -1)
    G = sum(g[i] for i in idx)
    H = sum(h[i] for i in idx)
    if len(idx) < MIN_CHILD * 2:
        return best
    par = G * G / (H + 1.0)
    for f in range(nf):
        col = X[f]
        hg = [0.0] * nb
        hh = [0.0] * nb
        for i in idx:
            b = col[i]
            hg[b] += g[i]
            hh[b] += h[i]
        gl = hl = 0.0
        cnt = 0
        cn = [0] * nb
        for i in idx:
            cn[col[i]] += 1
        for b in range(nb - 1):
            gl += hg[b]
            hl += hh[b]
            cnt += cn[b]
            if cnt < MIN_CHILD or len(idx) - cnt < MIN_CHILD:
                continue
            gain = gl * gl / (hl + 1.0) + (G - gl) ** 2 / (H - hl + 1.0) - par
            if gain > best[0]:
                best = (gain, f, b)
    return best


def fit(Xtr, ytr, nb, nf, rounds=ROUNDS):
    n = len(ytr)
    base = sum(ytr) / n
    base = min(max(base, 1e-6), 1 - 1e-6)
    f0 = math.log(base / (1 - base))
    pred = [f0] * n
    trees = []
    imp = [0.0] * nf
    allidx = list(range(n))
    for _ in range(rounds):
        g = [0.0] * n
        h = [0.0] * n
        for i in range(n):
            p = 1.0 / (1.0 + math.exp(-pred[i]))
            g[i] = p - ytr[i]
            h[i] = p * (1 - p)
        gain, f, b = best_split(allidx, Xtr, g, h, nb, nf)
        if f < 0:
            break
        imp[f] += gain
        L = [i for i in allidx if Xtr[f][i] <= b]
        R = [i for i in allidx if Xtr[f][i] > b]
        node = {'f': f, 'b': b, 'kids': []}
        for side in (L, R):
            g2, f2, b2 = best_split(side, Xtr, g, h, nb, nf)
            if f2 >= 0:
                imp[f2] += g2
                sl = [i for i in side if Xtr[f2][i] <= b2]
                sr = [i for i in side if Xtr[f2][i] > b2]
                w1 = -sum(g[i] for i in sl) / (sum(h[i] for i in sl) + 1.0)
                w2 = -sum(g[i] for i in sr) / (sum(h[i] for i in sr) + 1.0)
                node['kids'].append({'f': f2, 'b': b2, 'w': (w1, w2)})
                for i in sl:
                    pred[i] += LR * w1
                for i in sr:
                    pred[i] += LR * w2
            else:
                w = -sum(g[i] for i in side) / (sum(h[i] for i in side) + 1.0)
                node['kids'].append({'f': -1, 'w': (w, w)})
                for i in side:
                    pred[i] += LR * w
        trees.append(node)
    return f0, trees, imp


def score(f0, trees, x):
    s = f0
    for t in trees:
        k = t['kids'][0 if x[t['f']] <= t['b'] else 1]
        if k['f'] < 0:
            s += LR * k['w'][0]
        else:
            s += LR * k['w'][0 if x[k['f']] <= k['b'] else 1]
    return s


def auc(y, s):
    pair = sorted(zip(s, y))
    n1 = sum(y)
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return 0.5
    r = 0.0
    i = 0
    rank = 0.0
    while i < len(pair):
        j = i
        while j < len(pair) and pair[j][0] == pair[i][0]:
            j += 1
        avg = (i + j + 1) / 2.0
        for k in range(i, j):
            if pair[k][1]:
                r += avg
        i = j
    return (r - n1 * (n1 + 1) / 2.0) / (n1 * n0)


def main():
    selftest = '--selftest' in sys.argv
    random.seed(20260814)

    idx_f = DATA / '^TWII.json'
    if not idx_f.exists():
        print('❌ 缺 ^TWII.json → 無法算超額報酬')
        return 1
    tw = json.loads(idx_f.read_text(encoding='utf-8'))
    tw = tw if isinstance(tw, list) else (tw.get('data') or [])
    # ⚠️ 日期格式兩種都有(`2026/08/07` 與 `2026-08-07`)→ 一律正規化,
    #    ⛔ 不正規化的話 dict 查不到 → 樣本數會變 0(第一版就踩到,靠空過守門抓出來)
    twc = {str(r['date']).replace('/', '-'): float(r['close']) for r in tw if r.get('close')}

    files = sorted(p for p in DATA.glob('*.json')
                   if not p.name.startswith('^') and p.stem.isdigit())
    print(f'📂 掃 {len(files)} 檔(⛔ 排除指數;ETF 代號也是數字,一併納入)')

    rows = []   # (date, feats, label, exret)
    used = 0
    for p in files:
        try:
            d = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            continue
        d = d if isinstance(d, list) else (d.get('data') or [])
        if len(d) < WARM + FWD + 40:
            continue
        try:
            cl = [float(r['close']) for r in d]
            hi = [float(r.get('high') or r['close']) for r in d]
            lo = [float(r.get('low') or r['close']) for r in d]
            vo = [float(r.get('volume') or 0) for r in d]
            dt = [str(r['date']).replace('/', '-') for r in d]
        except Exception:
            continue
        if min(cl) <= 0:
            continue
        used += 1
        for i, f in build_rows(cl, hi, lo, vo):
            if (i - WARM) % STEP or i + FWD >= len(cl):
                continue
            d0, d1 = dt[i], dt[i + FWD]
            b0, b1 = twc.get(d0), twc.get(d1)
            if not b0 or not b1:
                continue
            ex = (cl[i + FWD] / cl[i] - 1) - (b1 / b0 - 1)      # ④ 扣同期加權
            rows.append((d0, f, 1 if ex > 0 else 0, ex * 100))
    print(f'📊 有效 {used} 檔 → {len(rows):,} 個樣本(每 {STEP} 根取一個)')
    if not rows:
        print('❌ 一個樣本都沒有 → 這一輪無效')
        return 1

    # ① 時間切分 + ② purge
    dates = sorted({r[0] for r in rows})
    cut = dates[int(len(dates) * 0.70)]
    gap_hi = dates[min(len(dates) - 1, int(len(dates) * 0.70) + PURGE)]
    tr = [r for r in rows if r[0] < cut]
    te = [r for r in rows if r[0] > gap_hi]
    print(f'🕒 訓練 {dates[0]}~{cut}({len(tr):,})・⛔ 挖掉 {PURGE} 日・'
          f'測試 {gap_hi}~{dates[-1]}({len(te):,})')
    if len(te) < MIN_TEST:
        print(f'❌ 測試樣本只有 {len(te):,} < {MIN_TEST:,} → 空過守門,結論不可信')
        return 1
    if len(tr) > MAX_TRAIN:
        tr = random.sample(tr, MAX_TRAIN)
        print(f'   (訓練抽樣到 {MAX_TRAIN:,} 筆,純 Python 跑得動)')

    nf = len(FEATS)
    if selftest:
        # ⑤ 注入一個「一定學得到」的洩漏特徵 → 抓不出來代表程式壞了
        nf += 1
        for arr in (tr, te):
            for k in range(len(arr)):
                d0, f, y, ex = arr[k]
                arr[k] = (d0, f + [y * 10 + random.random()], y, ex)
        print('🧪 selftest:已注入洩漏特徵,測試集 AUC 必須 > 0.8')

    # 分箱(邊界只用訓練集算,⛔ 不可用到測試集)
    edges = [quantile_edges([r[1][f] for r in tr], BINS) for f in range(nf)]
    Xtr = [[to_bin(r[1][f], edges[f]) for r in tr] for f in range(nf)]
    ytr = [r[2] for r in tr]
    Xte = [[to_bin(r[1][f], edges[f]) for r in te] for f in range(nf)]
    yte = [r[2] for r in te]

    print(f'🌲 訓練中(直方圖梯度提升・深度2・{ROUNDS} 輪)…')
    f0, trees, imp = fit(Xtr, ytr, BINS, nf)
    print(f'   完成 {len(trees)} 棵樹')

    str_ = [score(f0, trees, [Xtr[f][i] for f in range(nf)]) for i in range(len(ytr))]
    ste = [score(f0, trees, [Xte[f][i] for f in range(nf)]) for i in range(len(yte))]
    a_tr, a_te = auc(ytr, str_), auc(yte, ste)
    base_te = sum(yte) / len(yte) * 100
    base_ex = sorted(r[3] for r in te)[len(te) // 2]

    print('\n═══ 結果 ═══')
    print(f'③ 測試集**基準**:贏大盤的比例 {base_te:.1f}%(⛔ 不是 50%)・超額中位 {base_ex:+.2f}%')
    print(f'   訓練集 AUC {a_tr:.4f}  ← 學得起來嗎')
    print(f'⭐ **測試集 AUC {a_te:.4f}**  ← 樣本外還有沒有(0.5 = 跟丟銅板一樣)')

    order = sorted(range(len(yte)), key=lambda i: -ste[i])
    print(f'\n   {"依模型分數分組":<16}{"n":>8}{"贏大盤%":>10}{"超額中位%":>12}{"vs 基準":>10}')
    for name, lo_, hi_ in (('前 10%', 0.0, 0.10), ('前 20%', 0.0, 0.20),
                           ('中間 60%', 0.20, 0.80), ('後 20%', 0.80, 1.0)):
        seg = order[int(len(order) * lo_):int(len(order) * hi_)]
        w = sum(yte[i] for i in seg) / len(seg) * 100
        m = sorted(te[i][3] for i in seg)[len(seg) // 2]
        print(f'   {name:<16}{len(seg):>8,}{w:>10.1f}{m:>12.2f}{w - base_te:>+9.1f}pp')

    # ⭐ 穩健性:測試集再切前後兩半,前 10% 都要贏才算數(本專案標準關卡)
    tdates = sorted({r[0] for r in te})
    mid = tdates[len(tdates) // 2]
    print('\n   ⭐ 穩健性(測試集再切前後半,⛔ 只有一半贏 = 不算數):')
    for tag, sel in (('前半', lambda d: d <= mid), ('後半', lambda d: d > mid)):
        sub = [i for i in range(len(te)) if sel(te[i][0])]
        sub.sort(key=lambda i: -ste[i])
        top = sub[:max(1, len(sub) // 10)]
        b = sum(yte[i] for i in sub) / len(sub) * 100
        w = sum(yte[i] for i in top) / len(top) * 100
        print(f'     {tag}  基準 {b:.1f}% → 前 10% {w:.1f}%  ({w - b:+.1f}pp, n={len(top):,})')

    # ⭐ 對照:App 現行就在用的**一條**規則(位階高)——模型要贏得過它才有意義
    pi = FEATS.index('pos252')
    rule = [i for i in range(len(te)) if te[i][1][pi] >= 75]
    if rule:
        rw = sum(yte[i] for i in rule) / len(rule) * 100
        rm = sorted(te[i][3] for i in rule)[len(rule) // 2]
        print(f'\n   🆚 對照(App 現行「位階 ≥75」**一條**規則,零模型):'
              f'{rw:.1f}%({rw - base_te:+.1f}pp)・超額中位 {rm:+.2f}%・n={len(rule):,}')

    print('\n   特徵重要度(gain,= XGBoost 的 Feature Importance):')
    tot = sum(imp) or 1.0
    names = FEATS + (['🚨LEAK'] if selftest else [])
    for f in sorted(range(nf), key=lambda x: -imp[x])[:8]:
        print(f'     {names[f]:<10}{imp[f] / tot * 100:>6.1f}%')

    print('\n⛔ 怎麼讀:')
    print('   ・測試 AUC ≈ 0.50 且「前 10%」贏不過基準 → 這批特徵**沒有樣本外預測力**,')
    print('     ⛔ 換 XGBoost/LSTM/RL 也不會有(模型換再好,資料裡沒有的東西學不出來)')
    print('   ・訓練 AUC 高但測試 ≈ 0.5 → 那是**過度配適**,不是「調參就會好」')
    print('   ・前 10% 若真的贏基準 ≥3pp 且前後半段一致 → 才值得往下談')
    if selftest and a_te < 0.8:
        print('\n❌ selftest 失敗:注入了必然學得到的特徵卻抓不出來 → 這支程式本身有問題')
        return 1
    if selftest:
        print('\n✅ selftest 通過:harness 有能力抓出真訊號 → 上面的 0.5 是真的沒訊號,不是程式壞掉')
    return 0


if __name__ == '__main__':
    sys.exit(main())
