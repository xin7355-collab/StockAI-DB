#!/usr/bin/env python3
"""🔥 券資比 / 軋空探針 —— 「券資比高 + 主力在買 = 軋空」有沒有邊際?

來源:逐字稿(權證小哥)多次提到軋空(37 處)。他描述的完整條件是:
  「券資比高」+「主力有在買(分點)」+「股價沿著布林上軌走」→ 軋空行情
  而且他自己也強調:被軋到要**趕快停損**,因為「你不曉得這座山的山頂在哪」。

券資比 = 融券餘額 ÷ 融資餘額 × 100
  ・比值高 = 空方壓力累積,一旦上漲空單要回補 → 助漲(軋空燃料)
  ・比值低 = 沒什麼空單,沒有軋空題材

⛔ 照鐵則「探針先行、實測不猜」。只讀 data/,不打 API、不寫檔。

跑法:
  python3 short_probe.py
  python3 short_probe.py --selftest    # 注入一個必然有效的假訊號,驗 harness

════════════════════════════════════════════════════════════════
📊 2026-08-03 第一次實測:**不做**(V71.9.2 決策紀錄)⛔ 以下一個字都沒改
════════════════════════════════════════════════════════════════
1,002 檔 ・9,893 個事件:

  券資比(自身歷史百分位)  n      3日      5日     10日   10日勝率
  自身最低 25%          5,444  −0.72%  −0.64%  −1.41%   42.8%
  自身 25~75%          3,346  −0.90%  −0.90%  −1.88%   41.8%
  自身最高 25%            540  −0.62%  −0.60%  −1.75%   43.0%
  ⭐ 自身最高 10%          369  −1.38%  −1.76%  −3.07%   33.6%

❌ **方向跟「軋空」相反**:券資比最高那 10% 反而最差(−3.07% vs −1.41%,差 −1.65pp)。

⭐ 而且做了**最關鍵的拆解**(這步不做會得到錯誤結論):
     「外資買」在券資比**不高**時 = −0.86%,在券資比**高**時 = −2.81%
     → 券資比的額外貢獻 **−1.95pp** → 真正有用的是「外資買」,券資比不但沒加分還扣分。
   ⛔ 所以**不為券資比開任何功能**。⚠️ 別被「券資比高 × 外資買 vs × 外資賣 = +0.87pp」
     那個數字騙了 —— 那只證明「外資方向有用」,不證明券資比有用。

⚠️⚠️ 但這個結論有一個**必須講清楚的重大限制**:
   融資券資料(`margin_balance` / `short_balance`)**只回溯到 2026/05/14**(約 55 個交易日),
   而那個窗口大盤是**下跌**的(參 CLAUDE.md broker_habit 那次:窗口內大盤 −8.4%)。
   **空頭段裡「空單多」本來就是對的**,軋空要在多頭段才會發生。
   → 正確說法是「**在我目前唯一有的窗口裡不成立**」,⛔ 不是「軋空這件事是假的」。
   → 融資券資料累積滿 1 年、且涵蓋一段多頭之後,**要重跑這支再決定**。

════════════════════════════════════════════════════════════════
🔧 2026-09-09 升級:重跑條件滿足了,但**舊版的方法學不能直接拿來重跑**
════════════════════════════════════════════════════════════════
實測 `data/` 現況:`margin_balance`/`short_balance` 從 **2023-05-22** 就有
(隨機 200 檔 ・14.7 萬列:2023 年 13,227 列、2024 年 23,185、2025 年 23,380、2026 年 14,159)
→ 2026-08 寫的「只有 55 個交易日、而且那段是跌的」**已經不成立**。

⛔ 但舊版有**四個硬缺陷**,不修就重跑等於用壞尺量新東西:
  ① 🚨 **前視偏誤(百分位)**:`sorted(known)` 拿**整檔含未來**的券資比算「自身百分位」
     → 改成 **expanding(只看當天以前)** 的百分位。
  ② 🚨 **前視偏誤(進場)**:用**當天收盤**進場,但融資券餘額是**收盤後才公布**的
     → 改成 **隔天開盤進場**,並排除隔天開盤鎖漲停(買不到)。
  ③ **六關只做了 1.5 關**:缺前後半 / 逐年 / 去最好年 / 扣成本 0.44% / 疊在 🧬 之上的增量。
  ④ **對照組不夠乾淨**:有融資券的本來就偏熱門股 → 補**格內對照**(位階 × 波動 × 成交金額)。
     附帶 bug:`range(len(cl) - len(known), …)` 假設有值的日子全擠在尾端 —— 那是 55 天時代才成立。
  (方法學樣板照 `scripts/trustvol_probe.mjs`,⛔ 不另立第二套標準。)

⚠️⚠️ **窗口要誠實講**(⛔ 不可寫成「已涵蓋多頭與空頭」):
   當初缺的**多頭段確實補上了**,但 `data/` 的 K 線本身只回溯到 **2023-06**,
   再扣掉位階/波動需要的 250 根暖身 → **事件窗口從 2024 年年中才開始**,
   而 2024 / 2025 / 2026 **三個都是多頭年**(2022 那段空頭不在 `data/` 裡,
   深歷史 `klines_deep` 的籌碼欄位是**刻意留空**的,合併過來也算不出券資比)。
   → 逐年那一關只驗得到 3 個年度、且 3 個都是多頭年。
   ⭐ 反過來說:**若重跑仍然是反向的,這個否定比 2026-08 那次強得多** ——
     「窗口剛好是空頭」這個唯一的辯護理由已經失效。

════════════════════════════════════════════════════════════════
📊 2026-09-09 重跑結果:**還是不做**,但**理由跟 2026-08 講的不一樣**
════════════════════════════════════════════════════════════════
規模:**1,736 檔個股 ・對照組 895,349 個(股·日)・事件 64,820 筆**
(2026-08 那次是 1,002 檔 / 9,893 事件 → 事件數 **×6.5**,確定真的吃到三年窗口了)
窗口 **2024-05-30 ~ 2026-08-11**;加權在窗口內 2024 +7.8% / 2025 +26.9% / 2026 +53.7%
→ ⚠️ **三年全是多頭年**(⛔ 不可寫成「已涵蓋多頭與空頭」)。
對照組本身:10 日超額 **−1.23%** ・勝率 **37.0%**(⛔ 基準不是 0% 也不是 50%)。

① 券資比(自身歷史百分位,expanding)—— **六關 0 過**
     自身最低 25%  n=26,626  10日 −0.39pp
     自身 25~75%   n=20,883  10日 +0.01pp
     自身 75~90%   n= 9,837  10日 +0.10pp
   ⭐ 自身最高 10%  n= 7,474  10日 **+0.04pp**(扣成本 −0.40 ・格內 −0.15 ・前後半不同向)
② 門檻敏感度(P80/85/90/95/99):+0.09 / +0.08 / +0.04 / −0.01 / **−0.22**
   → **越嚴越差、單調**。⛔ 既不是高原也不是孤峰,是**根本沒有山**。
③ 絕對門檻高原檢定(5~20 / 8~25 / 10~30 / 12~35 / 15~40%):**0/5 站得住**。

🚨🚨 **要更正 2026-08 的兩句話**(⛔ 不是補充,是更正):
  (a) 當時寫「**方向跟軋空相反**(最高 10% −3.07% vs 最低 25% −1.41%,差 −1.65pp)」
      → 三年多頭窗口重跑是 **+0.43pp**(正的,但遠低於來回成本 0.44)。
      ⭐ 正確說法是「**不是反向,是零**」;那個 −1.65pp 是 55 天空頭窗口的產物。
  (b) 當時寫「券資比的額外貢獻 **−1.95pp**,不但沒加分還扣分」
      → 重跑是 **+0.38pp**(外資買在券資比不高時 +0.02pp、券資比高時 +0.40pp)。
      ⭐ 結論(不為券資比開功能)不變,但**理由要改**:不是「扣分」,是「**加不到成本**」。

🚨🚨 **這一輪最貴的一課:第一版跑出「D 10~30% 六關全過(+0.97pp)」—— 那是假的。**
  兩個污染源,拿掉之後那一格從 +0.97pp 掉到 +0.36pp、前後半變不同向、逐年 2024 是 −1.0:
  ① **掃到 ETF**:第一版的檔案過濾寫成 `stem[:1].isdigit()`,把 00631L / 00715L 這種
     **槓桿反向 ETF** 也掃進來。⛔ 券資比/軋空是**個股**的事,而槓桿 ETF 一天可以動 ±20%。
  ② **未還原的分割/減資斷崖**:`data/00631L.json` 2024-07-29 收 **10.61** → 2024-08-05 收 **176.9**
     (×16.7)→ 單筆事件算出 **e10 = +1860%**,一根壞棒就把某一格從 −0.8%(中位)
     拉成 **+11.4pp**(平均)。⭐ 平均值對離群值極度敏感,而回測的主判準就是平均。
  → 現已加**斷崖守門**(相鄰收盤比值 >±40% 整檔剔除,同 `etf_switch_probe` 的做法),
     實測全市場個股 **2,367 檔裡有 97 檔中招**(⚠️ 那是 `data/` 本身的資料問題,
     `_backadjust_splits` 只認 2~10 倍,減資/更大倍率的還在)。
  ⭐⭐ **通用鐵則:回測跑出「唯一一格六關全過」時,先去看那一格的中位數跟平均差多少,
     再去看樣本裡最極端的那幾筆是誰。** 這次「最強的那一格」完全是兩個資料問題撐起來的。

🚨 **第二課:切片裡看到的方向,拉到母體會反過來**(多重比較)
  ⑥ 把「券資比 8~35%」再拆成 融券高低 × 融資高低,看起來是「**融資自身低**」的功勞
     (融資低 +1.08pp vs 融資高 +0.04pp)。
  ⑦ 於是把「融資餘額自身百分位」單獨拉出來跑完整六關(用它**自己**那套 20 日去重):
     融資自身最低 25% = **−0.13pp** ・25~75% −0.11 ・75~90% +0.14 ・最高 10% **+0.25pp**
     → **方向整個反過來**,而且四桶都沒過六關。
  ⭐ 所以 ⑥ 那個「融資少才會漲」是切片挑出來的,⛔ 不是真的。

✅ **最終處置:維持「⛔ 不為券資比開功能」,並把它從『資料不夠(blocked)』改成
   『實測沒用(trap)』** —— 資料已經夠了,是這個訊號本身沒有東西。
⚠️ 唯一還沒驗到的是**空頭段**(2022 不在 `data/` 裡)。但要注意:2026-08 那次用的
   55 天窗口**正好就是空頭**,結果也是負的 → 多頭、空頭兩個窗口都沒有東西。
"""
import json
import math
import os
import random
import sys
import tempfile
from bisect import bisect_left, insort
from pathlib import Path

import numpy as np

DATA = Path(os.environ.get('DATA_DIR') or 'data')
SELFTEST = '--selftest' in sys.argv

WARM = int(os.environ.get('WARM') or 250)   # 位階(一年)+ 波動要暖身
DEDUP = 20                                   # 同檔同桶 20 交易日內只算一次
COST = 0.44                                  # 來回交易成本(pp)
MIN_N = 200                                  # 每桶最少事件數
MIN_HIST = 120                               # expanding 百分位至少要 120 個過去值才算數
HOLD = 10                                    # 主判準天期
SENS = (80, 85, 90, 95, 99)                  # 門檻敏感度(左右各挪兩格)

ABS_BUCKETS = (
    ('A <1%', lambda v: v < 1),
    ('B 1~3%', lambda v: 1 <= v < 3),
    ('C 3~10%', lambda v: 3 <= v < 10),
    ('D 10~30%', lambda v: 10 <= v < 30),
    ('E ≥30%', lambda v: v >= 30),
)
PCT_BUCKETS = (
    ('自身最低 25%', lambda p: p < 25),
    ('自身 25~75%', lambda p: 25 <= p < 75),
    ('自身 75~90%', lambda p: 75 <= p < 90),
    ('⭐ 自身最高 10%', lambda p: p >= 90),
)


def nf(x, d=2):
    return '—' if x is None or not np.isfinite(x) else f'{x:.{d}f}'


def sg(x):
    return '' if x is None or not np.isfinite(x) else ('+' if x >= 0 else '')


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


def load_index():
    m = {}
    for r in load(DATA / '^TWII.json') or []:
        try:
            c = float(r.get('close') or 0)
            d = str(r.get('date') or '').replace('/', '-')
            if c > 0 and d:
                m[d] = c
        except (TypeError, ValueError):
            pass
    return m


def collect():
    """回傳 (ctrl, ev, dates_sorted, n_sym)。
    ctrl / ev 都是 dict-of-numpy-array(⛔ 不用 list of dict,幾十萬筆會吃爆記憶體)。"""
    idx = load_index()
    if not idx:
        print('⚠️ 沒有 ^TWII.json')
        return None
    all_dates = sorted(idx)
    dnum = {d: i for i, d in enumerate(all_dates)}

    # ⛔ 只掃「4 碼純數字」= 上市櫃個股。⚠️ 第一版寫成 `stem[:1].isdigit()` 把 ETF
    #    (00631L / 00715L 這種槓桿反向)也掃進來 —— 那是錯的:券資比/軋空是**個股**的事,
    #    而槓桿 ETF 一天可以動 ±20%,會把平均值整個帶走。
    files = sorted(f for f in DATA.glob('*.json') if f.stem.isdigit() and len(f.stem) == 4)
    print(f'📂 掃描 {len(files)} 檔個股(4 碼純數字;⛔ 不含 ETF)'
          f' ・暖身 {WARM} 根 ・去重 {DEDUP} 日 ・進場 = 隔天開盤')

    syms = []
    C = {k: [] for k in ('e5', 'e10', 'e20', 'y', 'dn', 'pos', 'vola', 'amt')}
    E = {k: [] for k in ('e5', 'e10', 'e20', 'y', 'dn', 'pos', 'vola', 'amt',
                         'ab', 'pb', 'pctl', 'sr', 'f5', 'mgp', 'shp', 'si',
                         'mb', 'fp', 'fm')}
    n_sym = 0
    n_cliff = 0

    for f in files:
        rows = load(f) or []
        if len(rows) < WARM + 25:
            continue
        d, op, hi, lo, cl, vol, mg, sh, fn = [], [], [], [], [], [], [], [], []
        for r in rows:
            if not r or r.get('close') is None:
                continue
            try:
                c = float(r['close'])
            except (TypeError, ValueError):
                continue
            d.append(str(r.get('date') or '').replace('/', '-'))
            cl.append(c)
            op.append(float(r.get('open') or c))
            hi.append(float(r.get('high') or c))
            lo.append(float(r.get('low') or c))
            vol.append(float(r.get('volume') or 0))
            mg.append(float(r.get('margin_balance') or 0))
            sh.append(float(r.get('short_balance') or 0))
            fn.append(float(r.get('foreign_net') or 0))
        n = len(cl)
        if n < WARM + 25 or min(cl) <= 0:
            continue
        # 🚨 斷崖守門(同 etf_switch_probe 的做法):相鄰收盤比值超過 ±40% =
        #    未還原的分割/減資或壞 K 棒,⛔ 不是真的漲跌(台股單日上限 ±10%)。
        #    實例:`data/00631L.json` 2024-07-29 收 10.61 → 2024-08-05 收 176.9(×16.7),
        #    一根壞棒就把某一格的平均值從 −0.8% 拉成 +11.4pp。
        #    ⛔ 整檔跳過,不做局部修補 —— 修價格是採礦端的事,探針只負責不被它污染。
        bad = False
        for i in range(1, n):
            r = cl[i] / cl[i - 1]
            if r > 1.4 or r < 0.6:
                bad = True
                break
        if bad:
            n_cliff += 1
            continue
        cl_a = np.asarray(cl)
        # 券資比(融資為 0 的日子算不出來)
        sr = [(sh[i] / mg[i] * 100) if mg[i] > 0 else None for i in range(n)]
        if sum(1 for x in sr if x is not None) < MIN_HIST + 30:
            continue
        n_sym += 1
        syms.append(f.stem)
        si = len(syms) - 1

        # expanding 百分位:只用「當天以前」的值(⛔ 舊版用了含未來的整檔排序)
        # ⭐ 三條都要:券資比 / 融資餘額 / 融券餘額 —— 少了後兩條就沒辦法回答
        #    「賺的是『融券多』還是『融資少』」(券資比是個分數,分子分母都會動)。
        past, pmg, psh = [], [], []
        for i in range(WARM):
            if sr[i] is not None:
                insort(past, sr[i])
            if mg[i] > 0:
                insort(pmg, mg[i])
                insort(psh, sh[i])

        last = {}
        for i in range(WARM, n - 21):
            v = sr[i]
            if v is not None and len(past) >= MIN_HIST:
                pctl = bisect_left(past, v) / len(past) * 100
                mgp = bisect_left(pmg, mg[i]) / len(pmg) * 100
                shp = bisect_left(psh, sh[i]) / len(psh) * 100
            else:
                pctl = mgp = shp = None
            # 走過這一根之後才把它併進「過去」(⛔ 不可先併,那就含當天)
            if v is not None:
                insort(past, v)
            if mg[i] > 0:
                insort(pmg, mg[i])
                insort(psh, sh[i])
            c0 = cl[i]
            o1 = op[i + 1]
            if not (c0 > 0 and o1 > 0):
                continue
            if o1 >= c0 * 1.0995 and hi[i + 1] == lo[i + 1]:
                continue                       # 隔天開盤鎖漲停 → 買不到
            b0 = idx.get(d[i + 1])
            b5 = idx.get(d[i + 5])
            b10 = idx.get(d[i + 10])
            b20 = idx.get(d[i + 20])
            dn_i = dnum.get(d[i])
            if not b0 or not b10 or dn_i is None:
                continue
            e10 = (cl[i + 10] / o1 - 1) * 100 - (b10 / b0 - 1) * 100
            if not np.isfinite(e10):
                continue
            e5 = (cl[i + 5] / o1 - 1) * 100 - (b5 / b0 - 1) * 100 if b5 else np.nan
            e20 = (cl[i + 20] / o1 - 1) * 100 - (b20 / b0 - 1) * 100 if b20 else np.nan
            w = cl_a[i - 249:i + 1] if i >= 249 else cl_a[:i + 1]
            mn, mx = float(w.min()), float(w.max())
            pos = (c0 - mn) / (mx - mn) * 100 if mx > mn else 50.0
            lr = np.diff(np.log(cl_a[i - 20:i + 1]))
            vola = float(lr.std()) * math.sqrt(240) * 100
            amt = c0 * vol[i]
            yr = int(d[i][:4])

            C['e5'].append(e5); C['e10'].append(e10); C['e20'].append(e20)
            C['y'].append(yr); C['dn'].append(dn_i)
            C['pos'].append(pos); C['vola'].append(vola); C['amt'].append(amt)

            if v is None or pctl is None:
                continue
            ab = next((k for k, (_, fnc) in enumerate(ABS_BUCKETS) if fnc(v)), None)
            pb = next((k for k, (_, fnc) in enumerate(PCT_BUCKETS) if fnc(pctl)), None)
            mb = next((k for k, (_, fnc) in enumerate(PCT_BUCKETS) if fnc(mgp)), None)
            if ab is None or pb is None or mb is None:
                continue
            # ⭐ 兩套去重各自算:券資比桶(給 ①②③④⑤⑥ 用)與融資桶(給 ⑦ 用)。
            #    ⛔ 不可共用一把 —— 用券資比的去重去看融資,樣本組成會被別的訊號挑過。
            pv, mv = last.get(('p', pb)), last.get(('m', mb))
            fp = pv is None or dn_i - pv >= DEDUP
            fm = mv is None or dn_i - mv >= DEDUP
            if not fp and not fm:
                continue
            if fp:
                last[('p', pb)] = dn_i
            if fm:
                last[('m', mb)] = dn_i
            E['e5'].append(e5); E['e10'].append(e10); E['e20'].append(e20)
            E['y'].append(yr); E['dn'].append(dn_i)
            E['pos'].append(pos); E['vola'].append(vola); E['amt'].append(amt)
            E['ab'].append(ab); E['pb'].append(pb); E['pctl'].append(pctl); E['sr'].append(v)
            E['mgp'].append(mgp); E['shp'].append(shp); E['si'].append(si)
            E['mb'].append(mb); E['fp'].append(1.0 if fp else 0.0); E['fm'].append(1.0 if fm else 0.0)
            E['f5'].append(sum(fn[max(0, i - 4):i + 1]))

    if n_cliff:
        print(f'   ⚠️ {n_cliff} 檔因為「相鄰收盤跳超過 ±40%」被整檔剔除(未還原分割/壞 K 棒)')
    ctrl = {k: np.asarray(v, dtype=float) for k, v in C.items()}
    ev = {k: np.asarray(v, dtype=float) for k, v in E.items()}
    return ctrl, ev, all_dates, n_sym, syms


# ────────────────────────────────────────────────────────────────
def analyse(ctrl, ev, all_dates, n_sym, syms):
    N = len(ctrl['e10'])
    if N < 5000:
        print(f'❌ 對照組只有 {N} 筆 —— 資料不足,不下結論')
        return [], {}
    print(f'📊 {n_sym} 檔 ・對照組 {N:,} 個(股·日)・事件 {len(ev["e10"]):,} 筆\n')

    FP = ev['fp'] > 0.5      # 券資比那套去重留下來的
    FM = ev['fm'] > 0.5      # 融資那套去重留下來的
    volaP60 = float(np.percentile(ctrl['vola'], 60))
    hq_c = (ctrl['pos'] >= 75) & (ctrl['vola'] >= volaP60)
    hq_e = (ev['pos'] >= 75) & (ev['vola'] >= volaP60)

    c10 = float(np.mean(ctrl['e10']))
    c5 = float(np.nanmean(ctrl['e5']))
    c20 = float(np.nanmean(ctrl['e20']))
    cw = float((ctrl['e10'] > 0).mean() * 100)
    print(f'🆚 對照組(同一批有融資券的股票,全部可交易的股·日):'
          f'5日 {nf(c5)}% ・10日 {nf(c10)}% ・20日 {nf(c20)}% ・勝率 {nf(cw, 1)}%')
    print(f'   🧬 波動 P60 = {nf(volaP60, 1)}%(⛔ 基準不是 0% 也不是 50%)\n')

    dn = np.sort(ctrl['dn'])
    MID = float(dn[len(dn) // 2])
    LO, HI = float(dn[0]), float(dn[-1]) + 1
    print(f'🗓️ 事件窗口 {all_dates[int(LO)]} ~ {all_dates[int(HI) - 1]} ・中點 {all_dates[int(MID)]}')
    years = sorted(set(int(x) for x in ctrl['y']))
    # ⭐ 「窗口裡有沒有空頭年」⛔ 不可寫死 —— 直接用加權自己的年報酬算出來,
    #    以後窗口變了這行會自己跟著變(同 V71.1.6「門檻用自己的歷史位階不寫死」)。
    idx_map = load_index()
    ylab, bear = [], []
    for y in years:
        ds = [all_dates[i] for i in range(int(LO), int(HI)) if all_dates[i][:4] == str(y)]
        if len(ds) < 20:
            ylab.append(f'{y}:樣本太短')
            continue
        r = (idx_map[ds[-1]] / idx_map[ds[0]] - 1) * 100
        ylab.append(f'{y}:{"+" if r >= 0 else ""}{r:.1f}% {"▲多頭" if r > 0 else "▼空頭"}')
        if r <= 0:
            bear.append(y)
    print('   逐年驗得到的年度(加權自己在窗口內那段的報酬):' + ' ・'.join(ylab))
    print(f'   → {"⚠️ 窗口裡**沒有任何一個空頭年**,逐年那一關的說服力有限" if not bear else f"✅ 窗口含空頭年 {bear}"}\n')

    # 格內對照:位階 × 波動 × 成交金額 三分位
    def cuts(a):
        return float(np.percentile(a, 100 / 3)), float(np.percentile(a, 200 / 3))
    cP, cV, cA = cuts(ctrl['pos']), cuts(ctrl['vola']), cuts(ctrl['amt'])

    def cell(m):
        return ((m['pos'] > cP[1]).astype(int) + (m['pos'] > cP[0]).astype(int)) * 9 \
            + ((m['vola'] > cV[1]).astype(int) + (m['vola'] > cV[0]).astype(int)) * 3 \
            + ((m['amt'] > cA[1]).astype(int) + (m['amt'] > cA[0]).astype(int))
    cell_c, cell_e = cell(ctrl), cell(ev)

    def report(name, mask):
        g = int(mask.sum())
        if g < MIN_N:
            print(f'─ {name}:n={g} ⏳ 樣本不足(需 ≥{MIN_N})\n')
            return None
        e10 = ctrl['e10']
        d10 = float(np.mean(ev['e10'][mask])) - c10
        d5 = float(np.nanmean(ev['e5'][mask])) - c5
        d20 = float(np.nanmean(ev['e20'][mask])) - c20
        w = float((ev['e10'][mask] > 0).mean() * 100)
        # 前後半
        def half(a, b):
            em = mask & (ev['dn'] >= a) & (ev['dn'] < b)
            cm = (ctrl['dn'] >= a) & (ctrl['dn'] < b)
            if em.sum() < 60 or cm.sum() < 200:
                return np.nan
            return float(np.mean(ev['e10'][em])) - float(np.mean(e10[cm]))
        q1, q2 = half(LO, MID), half(MID, HI)
        # 逐年
        yr = {}
        for y in years:
            em = mask & (ev['y'] == y)
            cm = ctrl['y'] == y
            yr[y] = (float(np.mean(ev['e10'][em])) - float(np.mean(e10[cm]))) \
                if em.sum() > 40 and cm.sum() > 200 else np.nan
        yv = [v for v in yr.values() if np.isfinite(v)]
        fin = {y: v for y, v in yr.items() if np.isfinite(v)}
        bestY = max(fin, key=fin.get) if fin else None
        if bestY is not None:
            em = mask & (ev['y'] != bestY)
            cm = ctrl['y'] != bestY
            exBest = (float(np.mean(ev['e10'][em])) - float(np.mean(e10[cm]))) \
                if em.sum() > 40 else np.nan
        else:
            exBest = np.nan
        # 格內
        ws = wn = cells = 0.0
        for k in np.unique(cell_e[mask]):
            a = mask & (cell_e == k)
            c = cell_c == k
            if a.sum() < 20 or c.sum() < 200:
                continue
            ws += (float(np.mean(ev['e10'][a])) - float(np.mean(e10[c]))) * a.sum()
            wn += a.sum()
            cells += 1
        dCell = ws / wn if wn else np.nan
        # 疊在 🧬 之上
        a, c = mask & hq_e, hq_c
        dHQ = (float(np.mean(ev['e10'][a])) - float(np.mean(e10[c]))) \
            if a.sum() >= 100 and c.sum() >= 200 else np.nan

        print(f'─ {name}  n={g:,}')
        print(f'   5日 {sg(d5)}{nf(d5)}pp ・10日 {sg(d10)}{nf(d10)}pp ・20日 {sg(d20)}{nf(d20)}pp'
              f' ・勝率 {nf(w, 1)}%(對照 {nf(cw, 1)}%)')
        print(f'   前半 {sg(q1)}{nf(q1)} / 後半 {sg(q2)}{nf(q2)}'
              + ('' if (np.isfinite(q1) and np.isfinite(q2) and (q1 > 0) == (q2 > 0)) else ' 🚨不同向')
              + ' ・逐年 ' + ' '.join(f'{y % 100}:{sg(v)}{nf(v, 1)}' for y, v in yr.items()))
        print(f'   去最好年({bestY}) {sg(exBest)}{nf(exBest)} ・扣成本 {sg(d10 - COST)}{nf(d10 - COST)}'
              f' ・格內({int(cells)}格/{int(wn)}筆) {sg(dCell)}{nf(dCell)}'
              f' ・疊在🧬之上 {sg(dHQ)}{nf(dHQ)}(n={int(a.sum())})')
        passed = bool(d10 > 0 and np.isfinite(q1) and np.isfinite(q2) and (q1 > 0) == (q2 > 0)
                      and yv and all(v > 0 for v in yv) and np.isfinite(exBest) and exBest > 0
                      and d10 - COST > 0 and np.isfinite(dCell) and dCell > COST)
        print(f'   {"✅ 六關全過" if passed else "❌ 沒過"}\n')
        return {'name': name, 'n': g, 'd10': d10, 'dCell': dCell, 'dHQ': dHQ, 'pass': passed}

    out = []
    print('📌 ① 券資比(絕對門檻)—— ⚠️ 權值股融資基數大、小型股小,同一個 % 意義不同')
    print('   ⚠️ 20 日去重是**按百分位桶**做的(⛔ 不是按絕對桶)→ 絕對桶的樣本組成會被它影響,')
    print('      所以絕對門檻的結論一律要配下面 ⑤ 的高原檢定看,⛔ 不可單看某一格。')
    for k, (name, _) in enumerate(ABS_BUCKETS):
        r = report(name, FP & (ev['ab'] == k))
        if r:
            out.append(r)
    print('📌 ② 券資比(⭐ 該股**自己**的歷史百分位 —— expanding,只看當天以前)')
    pct_out = {}
    for k, (name, _) in enumerate(PCT_BUCKETS):
        r = report(name, FP & (ev['pb'] == k))
        if r:
            out.append(r)
            pct_out[name] = r

    # ③ 門檻敏感度(是一片高原,還是一根孤峰?)
    print('📌 ③ 門檻敏感度:「券資比高」的門檻左右各挪兩格')
    print(f'{"門檻":<10}{"n":>8}{"10日":>10}{"扣成本":>10}{"格內":>10}  判定')
    sens = {}
    for t in SENS:
        m = FP & (ev['pctl'] >= t)
        g = int(m.sum())
        if g < MIN_N:
            print(f'{"P" + str(t):<10}{g:>8}   樣本不足')
            continue
        d = float(np.mean(ev['e10'][m])) - c10
        ws = wn = 0.0
        for k in np.unique(cell_e[m]):
            a, c = m & (cell_e == k), cell_c == k
            if a.sum() < 20 or c.sum() < 200:
                continue
            ws += (float(np.mean(ev['e10'][a])) - float(np.mean(ctrl['e10'][c]))) * a.sum()
            wn += a.sum()
        dc = ws / wn if wn else np.nan
        sens[t] = d
        print(f'{"P" + str(t):<10}{g:>8}{sg(d)}{nf(d):>9}{sg(d - COST)}{nf(d - COST):>9}'
              f'{sg(dc)}{nf(dc):>9}  {"✅" if d - COST > 0 and dc > COST else "❌"}')
    print()

    # ⑤ 絕對門檻的高原檢定 —— 🚨 這一段是後來補的,因為第一次跑出來
    #    「D 10~30% 六關全過」而左右鄰居(C 3~10% / E ≥30%)都沒過 = 典型的孤峰。
    #    ⛔ 依 V75.0.9 第 3 條:一個門檻要能用,必須「左右各挪兩格仍然成立」。
    print('📌 ⑤ 絕對門檻的**高原檢定**:把區間上下界各挪幾格,看它是高原還是孤峰')
    print(f'{"區間":<14}{"n":>8}{"10日":>10}{"扣成本":>10}{"格內":>10}{"逐年全正":>10}  判定')
    plateau = {}
    for lo_, hi_ in ((5, 20), (8, 25), (10, 30), (12, 35), (15, 40)):
        m = FP & (ev['sr'] >= lo_) & (ev['sr'] < hi_)
        g = int(m.sum())
        name = f'{lo_}~{hi_}%'
        if g < MIN_N:
            print(f'{name:<14}{g:>8}   樣本不足')
            continue
        d = float(np.mean(ev['e10'][m])) - c10
        ws = wn = 0.0
        for k in np.unique(cell_e[m]):
            a, c = m & (cell_e == k), cell_c == k
            if a.sum() < 20 or c.sum() < 200:
                continue
            ws += (float(np.mean(ev['e10'][a])) - float(np.mean(ctrl['e10'][c]))) * a.sum()
            wn += a.sum()
        dc = ws / wn if wn else np.nan
        yok = True
        for y in years:
            em, cm = m & (ev['y'] == y), ctrl['y'] == y
            if em.sum() > 40 and cm.sum() > 200:
                if float(np.mean(ev['e10'][em])) - float(np.mean(ctrl['e10'][cm])) <= 0:
                    yok = False
        okk = d - COST > 0 and np.isfinite(dc) and dc > COST and yok
        plateau[name] = okk
        print(f'{name:<14}{g:>8}{sg(d)}{nf(d):>9}{sg(d - COST)}{nf(d - COST):>9}'
              f'{sg(dc)}{nf(dc):>9}{("✅" if yok else "❌"):>9}  {"✅" if okk else "❌"}')
    print()

    # ⑥ ⭐⭐ 券資比是個**分數** —— 分子(融券)大跟分母(融資)小長得一模一樣。
    #    ⛔ 不做這個拆解,就會把「散戶融資少」的功勞算到「軋空燃料多」頭上。
    print('📌 ⑥ ⭐⭐ 券資比 8~35% 這一帶,賺的到底是「融券多」還是「融資少」?')
    print('   (兩者都用該股**自己**的 expanding 百分位切,⛔ 不寫死張數)')
    band = FP & (ev['sr'] >= 8) & (ev['sr'] < 35)
    print(f'{"":<30}{"n":>8}{"10日超額":>11}{"中位":>9}{"格內":>10}')
    dec = {}
    for shn, shm in (('融券自身高(≥60%)', ev['shp'] >= 60), ('融券自身低(<60%)', ev['shp'] < 60)):
        for mgn, mgm in (('融資自身低(<40%)', ev['mgp'] < 40), ('融資自身高(≥40%)', ev['mgp'] >= 40)):
            m = band & shm & mgm
            g = int(m.sum())
            key = f'{shn}×{mgn}'
            if g < 300:
                # ⚠️ 這裡刻意比別處嚴(300 而不是 200):第一版用 150,
                #    有一格 n=180、平均 +11.42pp **中位卻是 −0.80%** —— 一根壞 K 棒撐起來的。
                print(f'{key:<30}{g:>8}   樣本不足(<300)')
                continue
            d = float(np.mean(ev['e10'][m])) - c10
            ws = wn = 0.0
            for k in np.unique(cell_e[m]):
                a, c = m & (cell_e == k), cell_c == k
                if a.sum() < 15 or c.sum() < 200:
                    continue
                ws += (float(np.mean(ev['e10'][a])) - float(np.mean(ctrl['e10'][c]))) * a.sum()
                wn += a.sum()
            dcc = ws / wn if wn else np.nan
            dec[key] = d
            md = float(np.median(ev['e10'][m])) - float(np.median(ctrl['e10']))
            print(f'{key:<30}{g:>8}{sg(d)}{nf(d):>10}pp{sg(md)}{nf(md):>8}{sg(dcc)}{nf(dcc):>9}')
    print()

    # ④ ⭐ 最關鍵的拆解:券資比高 × 外資買 —— 不做這步會把「外資有用」誤讀成「券資比有用」
    print('📌 ④ ⭐ 他說的完整條件:券資比高 **且** 主力(外資)在買')
    print('   (⛔ 這一步不做會得到錯誤結論:「高×買 vs 高×賣」只證明外資方向有用)')
    hi_m = FP & (ev['pctl'] >= 90)
    fb = ev['f5'] > 0
    grid = {}
    print(f'{"":<26}{"n":>8}{"10日超額":>11}{"勝率":>9}')
    for hn, hm in (('券資比高(自身前10%)', hi_m), ('其餘', FP & ~hi_m)):
        for fnm, fm in (('外資買', fb), ('外資賣', ~fb)):
            m = hm & fm
            g = int(m.sum())
            key = f'{hn}×{fnm}'
            if g < MIN_N:
                print(f'{key:<26}{g:>8}   樣本不足')
                continue
            v = float(np.mean(ev['e10'][m])) - c10
            grid[key] = v
            print(f'{key:<26}{g:>8}{sg(v)}{nf(v):>10}pp'
                  f'{nf(float((ev["e10"][m] > 0).mean() * 100), 1):>8}%')
    print()

    # ⑦ ⭐ ⑥ 照出來的:兩個為正的格子共同點是「融資自身低」而**不是**融券高
    #    → 把「融資自身百分位」單獨拉出來跑完整六關(用它自己那套 20 日去重)。
    print('📌 ⑦ ⭐ 那把火其實是「融資少」點的?——「融資餘額自身百分位」單獨跑六關')
    print('   (⛔ 這已經不是券資比/軋空了,是「散戶融資多不多」)')
    mg_out = {}
    for k, (name, _) in enumerate(PCT_BUCKETS):
        r = report('融資' + name.replace('⭐ ', ''), FM & (ev['mb'] == k))
        if r:
            mg_out[name] = r
    print()

    print('📊 結論')
    k_hi, k_lo = '⭐ 自身最高 10%', '自身最低 25%'
    if k_hi in pct_out and k_lo in pct_out:
        d = pct_out[k_hi]['d10'] - pct_out[k_lo]['d10']
        print(f'   ② 自身百分位:最高 10% − 最低 25% = {sg(d)}{nf(d)}pp'
              f' → {"✅ 有邊際" if d > COST else "➖ 沒有超過成本" if d > -0.8 else "❌ 方向相反(跟軋空說法反過來)"}')
    if len(sens) >= 3:
        vals = list(sens.values())
        print(f'   ③ 敏感度:五個門檻的 10 日邊際 {" / ".join(sg(v) + nf(v) for v in vals)}'
              f' → {"⚠️ 只有個別門檻成立 = 孤峰" if any(v > COST for v in vals) and not all(v > COST for v in vals) else ("✅ 一片高原" if all(v > COST for v in vals) else "❌ 每一格都沒過")}')
    if plateau:
        okn = sum(1 for v in plateau.values() if v)
        print(f'   ⑤ 絕對門檻高原檢定:{len(plateau)} 個相鄰區間裡只有 {okn} 個站得住'
              f' → {"✅ 一片高原" if okn == len(plateau) else ("❌ 五格全部沒過 = 根本沒有山" if okn == 0 else ("🚨 **孤峰**,⛔ 不可採用" if okn <= 2 else "⚠️ 半高原,證據不足"))}')
    if len(dec) >= 3:
        hi_sh = [v for k, v in dec.items() if k.startswith('融券自身高')]
        lo_mg = [v for k, v in dec.items() if '融資自身低' in k]
        hi_mg = [v for k, v in dec.items() if '融資自身高' in k]
        if lo_mg and hi_mg:
            print(f'   ⑥ 8~35% 這一帶:融資自身**低**時 {sg(np.mean(lo_mg))}{nf(float(np.mean(lo_mg)))}pp'
                  f' vs 融資自身**高**時 {sg(np.mean(hi_mg))}{nf(float(np.mean(hi_mg)))}pp'
                  f' → {"⚠️ 在這個切片裡看起來是「融資少」的功勞 —— ⛔ 但先看 ⑦ 再下結論" if float(np.mean(lo_mg)) - float(np.mean(hi_mg)) > 0.4 else "➖ 融資高低分不出差別"}')
    if '自身最低 25%' in mg_out and '⭐ 自身最高 10%' in mg_out:
        a_, b_ = mg_out['自身最低 25%'], mg_out['⭐ 自身最高 10%']
        print(f'   ⑦ 融資自身最低 25% = {sg(a_["d10"])}{nf(a_["d10"])}pp(格內 {sg(a_["dCell"])}{nf(a_["dCell"])})'
              f' vs 融資自身最高 10% = {sg(b_["d10"])}{nf(b_["d10"])}pp'
              f' → {"✅ 六關全過,值得單獨追" if a_["pass"] else "❌ 沒過六關"}')
        if a_['d10'] < b_['d10']:
            print('       🚨 而且**方向跟 ⑥ 反過來**:⑥ 只是在「券資比 8~35%」那個切片裡看到的,')
            print('          拉到母體就不成立 → 那是**多重比較**挑出來的,⛔ 不是真的訊號。')
    k1, k2 = '券資比高(自身前10%)×外資買', '券資比高(自身前10%)×外資賣'
    o1 = '其餘×外資買'
    if k1 in grid and k2 in grid:
        print(f'   ④a 券資比高時,外資買 vs 外資賣 = {sg(grid[k1] - grid[k2])}{nf(grid[k1] - grid[k2])}pp')
    if k1 in grid and o1 in grid:
        d = grid[k1] - grid[o1]
        print(f'   ④b ⭐ 關鍵對照:「外資買」在券資比**不高**時 = {sg(grid[o1])}{nf(grid[o1])}pp,'
              f'券資比高時 = {sg(grid[k1])}{nf(grid[k1])}pp')
        print(f'       → 券資比帶來的額外貢獻 {sg(d)}{nf(d)}pp'
              f' → {"✅ 券資比是有加分的" if d > COST else "⛔ 賺的其實是「外資買」,券資比沒有加分 → 別為券資比單獨開功能"}')

    print('\n⚠️ 限制(⛔ 引用數字時一定要一起講):')
    print(f'   ・窗口 {all_dates[int(LO)]} ~ {all_dates[int(HI) - 1]},'
          + ('**沒有任何一個空頭年**' if not bear else f'含空頭年 {bear}') + '。')
    print('     `data/` K 線只回溯到 2023-06,2022 那段空頭不在裡面(深歷史的籌碼欄位刻意留空,')
    print('     合併過來也算不出券資比)→ ⛔ 不可寫成「已涵蓋多頭與空頭」。')
    print('   ・分點「主力」無法逐日回測(chips 只有滾動快照)→ 用外資近 5 日淨買代替,')
    print('     跟他講的「特定分點在買」不完全是同一件事。')
    print('   ・「沿布林上軌」那條沒測(那是形態確認,不是選股條件)。')
    print('   ・已下市的不在 `data/` 裡(倖存者偏誤)。成本以來回 0.44% 計。')
    return out, sens


# ── 🧪 selftest:注入「券資比自身前 10% 之後 10 日必漲」的假資料 ──────────
def make_selftest():
    tmp = Path(tempfile.mkdtemp(prefix='shortprobe-'))
    nbar, nsym = 700, 60
    dates = []
    import datetime as dtm
    d = dtm.date(2023, 1, 2)
    while len(dates) < nbar:
        if d.weekday() < 5:
            dates.append(d.isoformat())
        d += dtm.timedelta(days=1)
    (tmp / '^TWII.json').write_text(json.dumps(
        [{'date': x, 'open': 10000, 'high': 10000, 'low': 10000, 'close': 10000, 'volume': 1}
         for x in dates]))
    rnd = random.Random(20260909)
    for s in range(nsym):
        rows = []
        c = 100.0
        # 券資比序列:大多數低,約 5% 的日子突然拉高 → 那些日子就是「自身前 10%」
        ratios = [rnd.uniform(1, 5) for _ in range(nbar)]
        hit = set()
        for i in range(nbar):
            if rnd.random() < 0.05:
                ratios[i] = rnd.uniform(40, 60)
                hit.add(i)
        for i in range(nbar):
            up = (rnd.random() - 0.5) * 2
            for k in range(1, 11):
                if (i - k) in hit:
                    up += 0.4          # 命中日之後 10 天各漲 0.4% = 訊號真的有效
            c = max(1.0, c * (1 + up / 100))
            mgb = 100000.0
            rows.append({
                'date': dates[i], 'open': round(c, 2), 'high': round(c * 1.01, 2),
                'low': round(c * 0.99, 2), 'close': round(c, 2), 'volume': 2_000_000,
                'margin_balance': mgb, 'short_balance': round(mgb * ratios[i] / 100, 1),
                'foreign_net': rnd.randint(-500, 500),
            })
        (tmp / f'{3000 + s}.json').write_text(json.dumps(rows))
    print('🧪 --selftest:注入「券資比自身前 10% → 之後 10 日每天 +0.4%」,那一桶必須明顯領先。')
    print('   ⚠️ 但**量得回來的不會是 +3.6pp** —— 命中率 5% × 影響 10 天,')
    print('      對照組裡有一半的日子也落在某個命中日之後 → 對照組自己被墊高。')
    print('      理論邊際 = b×(9 − 100p) = 0.4×(9−5) ≈ +1.6pp。')
    print('      ⭐ 這一段本身就是「**真訊號會把對照組一起墊高**」的示範:')
    print('        看到「邊際比想像小」時,先問對照組是不是被同一個訊號污染了。\n')
    return tmp


def main():
    got = collect()
    if not got:
        return 2
    out, sens = analyse(*got)
    if SELFTEST:
        top = next((o for o in out if '最高 10%' in o['name']), None)
        bad = []
        # ⚠️ 斷言門檻不是憑感覺訂的,見 make_selftest() 裡的推導:
        #    注入 p=5% 命中 + 之後 10 天各 +b%,對照組**自己也會被墊高**
        #    → 理論邊際 = b × (9 − 100p) ≈ +1.6pp,⛔ 不是 +3.6pp。
        #    而 P95 那格幾乎是純命中日 → 邊際會明顯更大,拿它當「量得準不準」的主斷言。
        if not top:
            bad.append('「自身最高 10%」那桶樣本不足,harness 收不到事件')
        elif not top['d10'] > 1.0:
            bad.append(f'自身最高 10% 那桶沒抓到注入的邊際({nf(top["d10"])}pp,理論 ≈ +1.6)')
        elif not top['pass']:
            bad.append('注入的訊號應該六關全過,卻沒過')
        if sens.get(95) is None or not sens[95] > 2.0:
            bad.append(f'P95(幾乎純命中日)那格應該 > +2pp,實得 {nf(sens.get(95))}')
        elif not (sens.get(80, 9e9) < sens.get(90, -9e9) < sens[95]):
            bad.append(f'門檻越嚴邊際應該越大(注入的是純訊號),實得 '
                       f'P80={nf(sens.get(80))} P90={nf(sens.get(90))} P95={nf(sens[95])}')
        if bad:
            print('\n❌ SELFTEST 失敗:')
            for b in bad:
                print('   - ' + b)
            return 1
        print('\n✅ SHORT_PROBE_SELFTEST_PASS')
    return 0


if __name__ == '__main__':
    if SELFTEST:
        DATA = make_selftest()
        WARM = 250
    raise SystemExit(main())
