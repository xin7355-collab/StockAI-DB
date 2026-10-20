#!/usr/bin/env python3
"""🏦 外資「真連續」買超 N 天 → 持有 10 日的勝率 / 報酬(+ 投信同步的增量)—— V77.3.1

使用者(2026-09-19):「回測過去,外資連續買超五天以上的個股,持有十天後的勝率跟報酬率。」
「加入投信同步買超的條件。」

⭐ 先查登記表(⛔ 不重探):
  ・`_SCR_EDGE.fdays7`(外資近 7 日淨買天數 ≥5)= **−0.24pp / 勝率 37.8%**(選股頁 127 條之一)
  ・板塊層級 `sector_flow` C 變體(外資 10 日買 ≥6 天)= **孤峰**(≥6 +1.48、≥7 −0.11、≥8 −8.61)
  ・`trustvol_probe` 投信單腿 = **六關 0 過**
  ・`maxim_probe` 檢①(前一日籌碼軌跡 ≥99.5%)= 六關全過但絕對超額仍 −0.48%(只能排序)
  → 這支的**新意只有兩件**:① 「真連續」N 天(⛔ 不是 7 天裡 5 天)的**高原檢定** N=3~7
     ② 「外資連買 ∧ 投信同步」對「外資連買 ∧ 投信沒買」的**增量**(共用外資腿,⛔ 不拿全市場當對照)

方法(照 `short_probe.py` 那套,⛔ 不另立標準):
  ・訊號日 t = 外資連續淨買**剛好到 N 天**的那天(⛔ 不是「≥N 的每一天」—— 那會把同一段連買算好幾次)
  ・法人買賣超**收盤後才公布** → **t+1 開盤**進場;t+1 開盤一價到底鎖漲停(買不到)剔除(2015-06 前 ±7%,lib_limit)
  ・報酬 = 持有到 t+1+h 收盤,扣同期加權(超額);主判準 10 日;來回成本 0.44pp
  ・對照組 = 同一批股票、**同一天**、法人資料已知的可交易股·日(🔁 V79.4.3);同檔同 N 20 日去重;
    斷崖只剔「位階 250 根 + 持有 20 天」碰到的窗口(×1.5 / ×0.67;🔁 V79.4.3 ⛔ 不再整檔剔除)
  ・最後一根 `foreign_net === 0` = **還沒公布**(不是「外資沒動」)→ 那一天不算連買、也不當訊號日
  ・六關:全期正 / 前後半同向 / 逐年同向 / 去最好年 / 扣成本 / 格內對照(位階 × 波動 × 成交金額)
  ・強度互控:N 天外資淨買總股數 ÷ N 天總成交股數 三分位 × N —— 檢驗「是連續在說話,還是量在說話」

⚠️ 限制(⛔ 一定要跟結論一起講):
  ・`foreign_net` 從 **2023-06-09** 才有;扣 250 根暖身 → 事件窗口約 2024 年中起,**不含 2022 空頭**
  ・`klines_deep` 有 2021 起的 K 線但**沒有法人欄**(已實查)→ 逐年那關補不到 2022
  ・單位是**股**(⛔ 不是張);賣方(連續賣超)這一輪沒測

════════════════════════════════════════════════════════════════
📊 2026-09-19 實測(V77.3.1):2,154 檔 ・對照組 1,084,690 ・事件 75,210 ・窗口 2024-05-30 ~ 2026-08-18(三年全多頭)
════════════════════════════════════════════════════════════════
  ① 外資剛好連買 3/4/5/6/7 天:10 日 +0.15 / +0.25 / +0.25 / +0.20 / +0.17pp,扣成本全負 → 六關 0 過(「全正但沒有山」)
     連買 5 天:勝率 38.4%(對照 37.0%)・絕對 10 日 +0.37% / 賺錢機率 44.6%(對照 +0.10% / 43.7%)
  ② ⭐ 外資連買 ∧ 投信 3 日內有買:N=5 +0.91pp / 勝率 43.1% / 絕對 +0.86% / 賺錢機率 48.2% → 六關全過(N=3/7 也全過)
     增量 A−B(對照 = 外資連買但投信沒買):N=3 +0.74 全過、N=5 +0.77 / N=7 +0.64 各 5/6(格內 < 成本)
  ③ 🚨 反向增量:投信剛好連買 5 天之上,外資同步 − 沒外資 = +0.68pp(5/6);投信單腿 ≥5 天 +0.79pp 六關全過
     → **主角是投信,外資是加成**;⛔ 不可寫成「外資連買會漲」
  ④ 強度互控(N=5)佔量比 買得少 +0.67 / 中 +0.18 / 買得多 −0.09pp(單調)→ 外資狂掃 = 已經擠了
  處置:⛔ 不做提醒、不進計分;LAB ok r:44 / trap r:30;走完一次空頭重跑再決定進不進 `_SCR_EDGE`。

════════════════════════════════════════════════════════════════
🆕 V79.3.6 ④ 外資「突然一大筆」(使用者 2026-10-19:「今天大盤這麼差,富喬還能漲停 —— 能先看出來嗎?還是外資炒作?」)
════════════════════════════════════════════════════════════════
  富喬 1815:9/9~10/15 外資 24 天裡 19 天賣,10/16 單日買 35,941 張(約 50 億)+ 收漲停;10/19 再漲停。
  事件 = 外資單日淨買 ≥ 自己過去 250 天(⛔ 不含當天)的第 P 百分位(P = 95 / 98 / 99 / 99.5,高原)
         ・prior = 前 20 天外資合計是賣超(「賣了一陣子,突然一大筆」)
         ・mdown = 那天加權跌 ≥1%(= 今天這種盤)・lu = 那天收盤漲停(lib_limit.up_limit_close,2015-06 前 ±7%;且收在最高)
  ⭐ 一樣隔天開盤買、隔天開盤鎖漲停剔除、同檔同 P 20 日去重、六關、對照 = 同一天、算得出門檻的股·日(🔁 V79.4.3)。
  ⭐ 法人深歷史:DATA_DIR 用「d10n + inst_deep 合併」那份(2012 起;inst_backfill.py MODE=deep → inst_deep 分支),
     逐年那一關才驗得到 2015 / 2018 / 2022。

════════════════════════════════════════════════════════════════
🔁 V79.4.3(16 年全市場 d16 重跑前修好,陷阱 #50 / #52)
════════════════════════════════════════════════════════════════
  ・對照組改**同一天**:每一筆事件(跟對照組的每一個股·日)都先減掉「同一天、同一個母體」的平均再比
    —— ⛔ 不再拿整段平均:d16 的 K 線 2010 起、法人欄 2012 起才有,整段平均會把沒有法人資料的那兩年算進對照
       (陷阱 #50:事件在各年份分布不均時,整段平均會憑空造出「優勢」)。
    母體 = 那個事件需要的資料當天已知(外資連買 / 突然大買看外資、投信連買看投信;突然大買另外要算得出門檻);
    缺值 = 不知道(⛔ 不當 0);那一天不到 MIN_CTRL(30)檔 → 那天的事件不算,印出丟了幾筆。
  ・勝率 / 絕對報酬旁的「對照」= 同一批日子的對照(⛔ 不是整段);前後半照**日期**切(對照組的日期中位數)。
  ・隔天開盤鎖漲停 / 那天收漲停 → lib_limit(2015-06 前 ±7%,⛔ 不再寫死 10%)。
  ・斷崖:只剔碰到的窗口(lib_limit.cliff_*,×1.5 / ×0.67),⛔ 不整檔剔除(整檔丟掉減過資的股票 = 倖存者偏誤)。

跑法:
  python3 scripts/fstreak_probe.py             # 全市場
  python3 scripts/fstreak_probe.py --selftest  # 合成資料驗 harness(訊號數 / 零前視 / 鎖漲停剔除 / 去重 / 同一天對照 / 2012 ±7% / 斷崖窗口)
  DATA_DIR=... 指定資料夾;MAX_SYMS=200 試跑
  LEAD_TRACE=lead_trace_raw.json python3 scripts/fstreak_probe.py   # ⑤ 只跑「👑 本來會買的 × 外資突然一大筆」
      (lead_trace_raw.json = `RK_TRACE=1 RK_TRACE_RAW=… node scripts/leader_probe.mjs` 產的每一筆;約 1 分鐘)
"""
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib_limit as LL  # noqa: E402  🔁 V79.4.3 漲跌幅制度 + 斷崖守門共用(⛔ 不在這裡各寫一份)

DATA = Path(os.environ.get('DATA_DIR') or 'data')
SELFTEST = '--selftest' in sys.argv
WARM = int(os.environ.get('WARM') or 250)
MAX_SYMS = int(os.environ.get('MAX_SYMS') or 0)
DEDUP = 20
COST = 0.44
MIN_N = 200
MIN_CTRL = 30                 # 🔁 V79.4.3 同一天的對照組至少要這麼多檔,不夠 → 那天的事件不算(⛔ 不拿別天湊)
CLIFF_LOOK = 249              # 🔁 V79.4.3 斷崖窗口往回看到位階那 250 根(位階 / 波動碰到斷崖一樣是假的)
FWD_MAX = 20                  # 最長持有天期(e20)
NS = (3, 4, 5, 6, 7)          # 高原檢定
TRUST_WIN = 3                 # 投信「同步」= 訊號日往前 3 天內任一天淨買 >0
BURST_PS = (95, 98, 99, 99.5)  # ④ 外資突然一大筆:單日淨買 ≥ 自己過去 250 天第 P 百分位(高原)
BURST_WIN, BURST_MIN = 250, 120


def burst_thresholds(fn):
    """每一天「過去 BURST_WIN 天(⛔ 不含當天)」外資淨買的各百分位門檻;有資料 < BURST_MIN 天 → nan。回 {P: np.array}"""
    a = np.array([np.nan if v is None else v for v in fn], dtype=float)
    n = len(a)
    out = {P: np.full(n, np.nan) for P in BURST_PS}
    if n <= BURST_WIN:
        return out
    win = np.lib.stride_tricks.sliding_window_view(a, BURST_WIN)[:-1]     # win[k] = a[k .. k+W−1] → 給第 k+W 天用
    cnt = np.sum(~np.isnan(win), axis=1)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', category=RuntimeWarning)
        q = np.nanpercentile(win, list(BURST_PS), axis=1)
    for j, P in enumerate(BURST_PS):
        v = np.where(cnt >= BURST_MIN, q[j], np.nan)
        out[P][BURST_WIN:] = v
    return out


def nf(x, d=2):
    return '—' if x is None or not np.isfinite(x) else f'{x:.{d}f}'


def sg(x):
    return '' if x is None or not np.isfinite(x) else ('+' if x >= 0 else '')


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


def load_index(data=None):
    m = {}
    for r in load((data or DATA) / '^TWII.json') or []:
        try:
            c = float(r.get('close') or 0)
            d = str(r.get('date') or '').replace('/', '-')
            if c > 0 and d:
                m[d] = c
        except (TypeError, ValueError):
            pass
    return m


def streaks(fn):
    """外資連續淨買天數(⭐ None = 沒公布/沒資料 → 連續中斷,而且那天自己也不算)。"""
    out, s = [], 0
    for v in fn:
        s = s + 1 if (v is not None and v > 0) else 0
        out.append(s)
    return out


def clean_unpublished(fn, tn):
    """🚨 最後一根 foreign_net == 0 = **還沒公布**(V77.3.1 實查:2330 最後一根 0 / 0),⛔ 不是「外資沒動」→ 改成 None。
    ⚠️ 事件迴圈只跑到 n−21,所以這條對**回測結果**沒影響;它守的是「拿這份序列去算今天 streak」的呼叫端(⛔ 別把 0 算成連續中斷)。"""
    if fn and fn[-1] == 0:
        fn[-1] = None
        tn[-1] = None
    return fn, tn


def collect(data=None, files=None, verbose=True):
    data = data or DATA
    idx = load_index(data)
    if not idx:
        print('⚠️ 沒有 ^TWII.json')
        return None
    all_dates = sorted(idx)
    dnum = {d: i for i, d in enumerate(all_dates)}
    if files is None:
        files = sorted(f for f in data.glob('*.json') if f.stem.isdigit() and len(f.stem) == 4)
        if MAX_SYMS:
            step = max(1, len(files) // MAX_SYMS)
            files = files[::step][:MAX_SYMS]     # ⭐ 等距抽樣(⛔ 不取前 N 檔 = 按產業取樣,V72.1.7)
    if verbose:
        print(f'📂 掃描 {len(files)} 檔個股(4 碼純數字;⛔ 不含 ETF)・暖身 {WARM} 根 ・去重 {DEDUP} 日 ・進場 = 隔天開盤')
    # 🔁 V79.4.3 對照組多三個旗標 = 那個股·日「外資已知 / 投信已知 / 突然大買的門檻算得出來」→ 每個事件庫只跟自己那個母體比
    C = {k: [] for k in ('e5', 'e10', 'e20', 'y', 'dn', 'pos', 'vola', 'amt', 'r10', 'kf', 'kt', 'kb')}
    E = {k: [] for k in ('e5', 'e10', 'e20', 'y', 'dn', 'pos', 'vola', 'amt', 'st', 'tr', 'trst', 'ratio', 'si', 'r10')}
    # ⭐ 第二個事件庫:**投信**連買剛好到 N 天的那天(另一把去重)→ 給「反向增量」用:投信連買之上,外資有沒有加成?
    ET = {k: [] for k in ('e5', 'e10', 'e20', 'y', 'dn', 'pos', 'vola', 'amt', 'st', 'fs', 'si', 'r10')}
    # ⭐ 第三個事件庫(V79.3.6):外資「突然一大筆」—— 每個百分位 P 各自去重
    EB = {k: [] for k in ('e5', 'e10', 'e20', 'y', 'dn', 'pos', 'vola', 'amt', 'lvl', 'prior', 'mdown', 'lu', 'si', 'r10')}
    n_sym = n_cliff = n_lim = 0
    syms = []
    for f in files:
        rows = load(f) or []
        if len(rows) < WARM + 25:
            continue
        d, op, hi, lo, cl, vol, fn, tn = [], [], [], [], [], [], [], []
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
            fn.append(None if r.get('foreign_net') is None else float(r['foreign_net']))
            tn.append(None if r.get('trust_net') is None else float(r['trust_net']))
        n = len(cl)
        if n < WARM + 25 or min(cl) <= 0:
            continue
        fn, tn = clean_unpublished(fn, tn)
        # 🔁 V79.4.3 斷崖只剔「碰到的窗口」(下面迴圈裡判),⛔ 不整檔剔除 —— 整檔丟掉減過資的股票 = 倖存者偏誤
        pre = LL.cliff_prefix(cl, op)
        if sum(1 for v in fn if v is not None) < 120:
            continue
        n_sym += 1
        syms.append(f.stem)
        si = len(syms) - 1
        cl_a = np.asarray(cl)
        st = streaks(fn)
        stT = streaks(tn)
        bth = burst_thresholds(fn)
        last = {}
        for i in range(WARM, n - 21):
            c0, o1 = cl[i], op[i + 1]
            if not (c0 > 0 and o1 > 0):
                continue
            # 🔁 V79.4.3 隔天開盤一價到底鎖漲停 → 買不到(lib_limit:2015-06 前 ±7%,⛔ 不再寫死 10%)
            if LL.locked_bar(d[i + 1], c0, o1, hi[i + 1], lo[i + 1]) == 1:
                n_lim += 1
                continue
            # 🔁 V79.4.3 位階 250 根 + 持有 20 天這一段碰到價格斷崖 → 這個股·日事件、對照一起不算
            if LL.cliff_in(pre, i - CLIFF_LOOK, i + FWD_MAX):
                n_cliff += 1
                continue
            b0, b5, b10, b20 = idx.get(d[i + 1]), idx.get(d[i + 5]), idx.get(d[i + 10]), idx.get(d[i + 20])
            dn_i = dnum.get(d[i])
            if not b0 or not b10 or dn_i is None:
                continue
            r10 = (cl[i + 10] / o1 - 1) * 100
            e10 = r10 - (b10 / b0 - 1) * 100
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
            C['y'].append(yr); C['dn'].append(dn_i); C['pos'].append(pos); C['vola'].append(vola); C['amt'].append(amt); C['r10'].append(r10)
            # 🔁 V79.4.3 缺值 = 不知道(⛔ 不當 0):這個股·日只進「它的資料已知」的那幾個對照母體
            C['kf'].append(fn[i] is not None)
            C['kt'].append(tn[i] is not None)
            C['kb'].append(fn[i] is not None and bool(np.isfinite(bth[BURST_PS[0]][i])))
            # ④ 外資突然一大筆(收盤後公布 → 隔天開盤買;門檻只用過去 250 天)
            fi_ = fn[i]
            if fi_ is not None and fi_ > 0:
                hit = [P for P in BURST_PS if np.isfinite(bth[P][i]) and fi_ >= bth[P][i] and bth[P][i] > 0]
                if hit:
                    pw = [fn[j] for j in range(max(0, i - 20), i) if fn[j] is not None]
                    prior = 1 if (len(pw) >= 15 and sum(pw) < 0) else (0 if len(pw) >= 15 else -1)
                    bp, bt = idx.get(d[i - 1]), idx.get(d[i])
                    mdown = 1 if (bp and bt and bt / bp - 1 <= -0.01) else 0
                    # 🔁 V79.4.3 收盤漲停改走共用 lib_limit(同一條:2015-06 前 ±7%、差 0.5 個百分點內算)
                    lu = 1 if (LL.up_limit_close(d[i], c0, cl[i - 1]) and c0 >= hi[i] - 1e-9) else 0
                    for P in hit:
                        pvB = last.get(('b', P))
                        if pvB is not None and dn_i - pvB < DEDUP:
                            continue
                        last[('b', P)] = dn_i
                        EB['e5'].append(e5); EB['e10'].append(e10); EB['e20'].append(e20)
                        EB['y'].append(yr); EB['dn'].append(dn_i); EB['pos'].append(pos); EB['vola'].append(vola); EB['amt'].append(amt)
                        EB['lvl'].append(P); EB['prior'].append(prior); EB['mdown'].append(mdown); EB['lu'].append(lu); EB['si'].append(si); EB['r10'].append(r10)
            sT = stT[i]
            if NS[0] <= sT <= NS[-1]:
                pvT = last.get(('t', sT))
                if pvT is None or dn_i - pvT >= DEDUP:
                    last[('t', sT)] = dn_i
                    fw = [fn[j] for j in range(max(0, i - TRUST_WIN + 1), i + 1)]
                    fs_ = -1 if all(v is None for v in fw) else (1 if any(v is not None and v > 0 for v in fw) else 0)
                    ET['e5'].append(e5); ET['e10'].append(e10); ET['e20'].append(e20)
                    ET['y'].append(yr); ET['dn'].append(dn_i); ET['pos'].append(pos); ET['vola'].append(vola); ET['amt'].append(amt)
                    ET['st'].append(sT); ET['fs'].append(fs_); ET['si'].append(si); ET['r10'].append(r10)
            s = st[i]
            if s < NS[0] or s > NS[-1]:
                continue                       # 只記「剛好到 N」那天(s 在 3..7 的每一天各是一個 N 的訊號日)
            pv = last.get(s)
            if pv is not None and dn_i - pv < DEDUP:
                continue
            last[s] = dn_i
            # 投信同步:訊號日往前 TRUST_WIN 天內任一天投信淨買 >0 → 1;全部 ≤0(且有資料)→ 0;沒資料 → -1
            tw = [tn[j] for j in range(max(0, i - TRUST_WIN + 1), i + 1)]
            tr = -1 if all(v is None for v in tw) else (1 if any(v is not None and v > 0 for v in tw) else 0)
            vsum = sum(vol[j] for j in range(i - s + 1, i + 1))
            ratio = (sum(fn[j] for j in range(i - s + 1, i + 1)) / vsum * 100) if vsum > 0 else np.nan
            E['e5'].append(e5); E['e10'].append(e10); E['e20'].append(e20)
            E['y'].append(yr); E['dn'].append(dn_i); E['pos'].append(pos); E['vola'].append(vola); E['amt'].append(amt)
            E['st'].append(s); E['tr'].append(tr); E['trst'].append(stT[i]); E['ratio'].append(ratio); E['si'].append(si); E['r10'].append(r10)
    if verbose and n_cliff:
        print(f'   🧱 {n_cliff:,} 個股·日的「位階 250 根 + 持有 20 天」碰到價格斷崖(×1.5 / ×0.67)→ 事件、對照一起不算(⛔ 不整檔剔除)')
    if verbose:
        print(f'   ⚠️ 隔天開盤鎖漲停(買不到;2015-06 前 ±7%)剔除 {n_lim:,} 個股·日')
    ctrl = {k: np.asarray(v, dtype=float) for k, v in C.items()}
    ev = {k: np.asarray(v, dtype=float) for k, v in E.items()}
    ev['_trust'] = {k: np.asarray(v, dtype=float) for k, v in ET.items()}   # 掛在 ev 底下,呼叫端簽名不變
    ev['_burst'] = {k: np.asarray(v, dtype=float) for k, v in EB.items()}
    return ctrl, ev, all_dates, n_sym, syms


def same_day(ctrl, ev, key):
    """🔁 V79.4.3 同一天對照(陷阱 #50):每一筆都先減掉「同一天、同一個母體」的平均 —— ⛔ 不再減整段平均。
    key = 對照組裡的母體旗標('kf' 外資已知 / 'kt' 投信已知 / 'kb' 突然大買的門檻算得出來;缺值 = 不知道,⛔ 不當 0)。
    回 (ctl, ev2, dropped):
      ctl = 該母體的對照組(只留那天 ≥ MIN_CTRL 檔的日子),多 a5 / a10 / a20 = 減掉同一天平均後的超額
      ev2 = 事件(同上多 a5 / a10 / a20,另外 cw / craw / crawW = 同一天對照組的贏大盤率 / 絕對 10 日 / 賺錢機率)
      dropped = 那天對照組不到 MIN_CTRL 檔、被丟掉的事件數(⛔ 不拿別天的平均湊)"""
    k = np.asarray(ctrl[key]) > 0
    cdn = np.asarray(ctrl['dn'])[k].astype(np.int64)
    edn = np.asarray(ev['dn']).astype(np.int64)
    nd = int(max(cdn.max() if cdn.size else -1, edn.max() if edn.size else -1)) + 1

    def day_mean(vals):
        v = np.asarray(vals, dtype=float)
        f = np.isfinite(v)
        s = np.bincount(cdn[f], weights=v[f], minlength=nd)
        c = np.bincount(cdn[f], minlength=nd)
        return np.where(c > 0, s / np.maximum(c, 1), np.nan), c

    e10c = np.asarray(ctrl['e10'], dtype=float)[k]
    m10, n10 = day_mean(e10c)
    m5, _ = day_mean(np.asarray(ctrl['e5'], dtype=float)[k])
    m20, _ = day_mean(np.asarray(ctrl['e20'], dtype=float)[k])
    w10, _ = day_mean((e10c > 0).astype(float))
    r10c = np.asarray(ctrl['r10'], dtype=float)[k]
    mr, _ = day_mean(r10c)
    wr, _ = day_mean((r10c > 0).astype(float))
    okd = n10 >= MIN_CTRL
    keep = okd[cdn] if cdn.size else np.zeros(0, bool)
    ctl = {kk: np.asarray(v)[k][keep] for kk, v in ctrl.items() if isinstance(v, np.ndarray)}
    dc = ctl['dn'].astype(np.int64)
    ctl['a10'], ctl['a5'], ctl['a20'] = ctl['e10'] - m10[dc], ctl['e5'] - m5[dc], ctl['e20'] - m20[dc]
    eok = okd[edn] if edn.size else np.zeros(0, bool)
    dropped = int((~eok).sum())
    ev2 = {kk: np.asarray(v)[eok] for kk, v in ev.items() if isinstance(v, np.ndarray)}
    de = ev2['dn'].astype(np.int64)
    ev2['a10'], ev2['a5'], ev2['a20'] = ev2['e10'] - m10[de], ev2['e5'] - m5[de], ev2['e20'] - m20[de]
    ev2['cw'], ev2['craw'], ev2['crawW'] = w10[de] * 100, mr[de], wr[de] * 100
    ev2['_fam'] = key
    return ctl, ev2, dropped


def analyse(ctrl, ev, all_dates, n_sym, syms, data=None):
    # 🔁 V79.4.3 三個事件庫各自跟「同一天、自己需要的資料已知」的對照組比(⛔ 不再拿整段平均,陷阱 #50)
    CF, evF, dropF = same_day(ctrl, ev, 'kf')
    CT, evT, dropT = same_day(ctrl, ev['_trust'], 'kt')
    CB, evB, dropB = same_day(ctrl, ev['_burst'], 'kb')
    ctrl, ev = CF, evF
    N = len(ctrl['e10'])
    if N < 5000:
        print(f'❌ 對照組只有 {N} 筆(外資資料已知、那天 ≥{MIN_CTRL} 檔)—— 資料不足,不下結論')
        return []
    print(f'📊 {n_sym} 檔 ・對照組 {N:,} 個(股·日;外資資料已知)・事件 {len(ev["e10"]):,} 筆(N=3~7 各自去重)')
    print(f'🔁 V79.4.3 對照 = **同一天**、同一個母體(資料已知、可交易)的平均;那天不到 {MIN_CTRL} 檔 → 事件不算:'
          f'外資連買丟 {dropF:,} ・投信連買丟 {dropT:,} ・突然大買丟 {dropB:,} 筆\n')
    volaP60 = float(np.percentile(ctrl['vola'], 60))
    hq_c = (ctrl['pos'] >= 75) & (ctrl['vola'] >= volaP60)
    hq_e = (ev['pos'] >= 75) & (ev['vola'] >= volaP60)
    c10, c5, c20 = float(np.mean(ctrl['e10'])), float(np.nanmean(ctrl['e5'])), float(np.nanmean(ctrl['e20']))
    cw = float((ctrl['e10'] > 0).mean() * 100)
    print(f'🆚 對照組(同一批股票、外資已知的可交易股·日;整段平均只當描述):5日 {nf(c5)}% ・10日 {nf(c10)}% ・20日 {nf(c20)}% ・勝率 {nf(cw, 1)}%')
    print('   🔁 V79.4.3 下面每一個「pp」都是**同一天對照**(事件 − 同一天母體平均);勝率旁的「對照」= 同一批日子的對照勝率')
    print(f'   🧬 波動 P60 = {nf(volaP60, 1)}%(⛔ 基準不是 0% 也不是 50%)\n')
    dn = np.sort(ctrl['dn'])
    MID, LO, HI = float(dn[len(dn) // 2]), float(dn[0]), float(dn[-1]) + 1
    print(f'🗓️ 事件窗口 {all_dates[int(LO)]} ~ {all_dates[int(HI) - 1]} ・中點 {all_dates[int(MID)]}')
    years = sorted(set(int(x) for x in ctrl['y']))
    idx_map = load_index(data)
    ylab, bear = [], []
    for y in years:
        ds = [all_dates[i] for i in range(int(LO), int(HI)) if all_dates[i][:4] == str(y)]
        if len(ds) < 20:
            ylab.append(f'{y}:樣本太短'); continue
        r = (idx_map[ds[-1]] / idx_map[ds[0]] - 1) * 100
        ylab.append(f'{y}:{"+" if r >= 0 else ""}{r:.1f}% {"▲多頭" if r > 0 else "▼空頭"}')
        if r <= 0:
            bear.append(y)
    print('   逐年驗得到的年度(加權在窗口內那段):' + ' ・'.join(ylab))
    print(f'   → {"⚠️ 窗口裡**沒有任何一個空頭年**(2022 不在 data/ 裡),逐年那一關的說服力有限" if not bear else f"✅ 窗口含空頭年 {bear}"}\n')

    def cuts(a):
        return float(np.percentile(a, 100 / 3)), float(np.percentile(a, 200 / 3))
    cP, cV, cA = cuts(ctrl['pos']), cuts(ctrl['vola']), cuts(ctrl['amt'])

    def cell(m):
        return ((m['pos'] > cP[1]).astype(int) + (m['pos'] > cP[0]).astype(int)) * 9 \
            + ((m['vola'] > cV[1]).astype(int) + (m['vola'] > cV[0]).astype(int)) * 3 \
            + ((m['amt'] > cA[1]).astype(int) + (m['amt'] > cA[0]).astype(int))
    # 🔁 V79.4.3 每個事件庫配自己的對照母體(同一天、資料已知);格子 / 🧬 也各算一份
    FAM = {'kf': CF, 'kt': CT, 'kb': CB}
    FAMX = {fk: (cell(c_), (c_['pos'] >= 75) & (c_['vola'] >= volaP60)) for fk, c_ in FAM.items()}

    def stats(mask, base_e10=None, base_mask=None, ev=ev):
        """六關數字;base_* 給「增量檢定」用(對照 = 另一群事件,⛔ 不是全市場)。`ev` 可換成投信 / 突然大買那個事件庫。
        🔁 V79.4.3 一律用 a10(= 減掉同一天母體平均的超額)比;勝率仍是「贏大盤」(e10 > 0),旁邊的對照 = 同一批日子的對照勝率。"""
        g = int(mask.sum())
        if g < MIN_N:
            return None
        ctl = FAM[ev['_fam']]
        cell_c, hq_c = FAMX[ev['_fam']]
        cell_e = cell(ev)
        if base_mask is None:
            bE, bM = ctl['a10'], np.ones(len(ctl['a10']), bool)
            bdn, by = ctl['dn'], ctl['y']
        else:
            bE, bM = ev['a10'], base_mask
            bdn, by = ev['dn'], ev['y']
        b10 = float(np.mean(bE[bM]))
        d10 = float(np.mean(ev['a10'][mask])) - b10
        d5 = float(np.nanmean(ev['a5'][mask])) - (float(np.nanmean(ctl['a5'])) if base_mask is None else float(np.nanmean(ev['a5'][bM])))
        d20 = float(np.nanmean(ev['a20'][mask])) - (float(np.nanmean(ctl['a20'])) if base_mask is None else float(np.nanmean(ev['a20'][bM])))
        w = float((ev['e10'][mask] > 0).mean() * 100)
        raw = float(np.mean(ev['r10'][mask])); rawW = float((ev['r10'][mask] > 0).mean() * 100)   # 絕對報酬(⛔ 使用者問的是這個,不只給超額)
        cwm = float(np.mean(ev['cw'][mask]))                                                       # 🔁 V79.4.3 同一批日子的對照
        crw, crwW = float(np.mean(ev['craw'][mask])), float(np.mean(ev['crawW'][mask]))

        def half(a, b):
            em = mask & (ev['dn'] >= a) & (ev['dn'] < b)
            cm = bM & (bdn >= a) & (bdn < b)
            if em.sum() < 60 or cm.sum() < 100:
                return np.nan
            return float(np.mean(ev['a10'][em])) - float(np.mean(bE[cm]))
        q1, q2 = half(LO, MID), half(MID, HI)
        yr = {}
        for y in years:
            em = mask & (ev['y'] == y)
            cm = bM & (by == y)
            yr[y] = (float(np.mean(ev['a10'][em])) - float(np.mean(bE[cm]))) if em.sum() > 40 and cm.sum() > 100 else np.nan
        fin = {y: v for y, v in yr.items() if np.isfinite(v)}
        bestY = max(fin, key=fin.get) if fin else None
        if bestY is not None:
            em, cm = mask & (ev['y'] != bestY), bM & (by != bestY)
            exBest = (float(np.mean(ev['a10'][em])) - float(np.mean(bE[cm]))) if em.sum() > 40 else np.nan
        else:
            exBest = np.nan
        ws = wn = cells = 0.0
        for k in np.unique(cell_e[mask]):
            a = mask & (cell_e == k)
            c = (cell_c == k) if base_mask is None else (bM & (cell_e == k))
            if a.sum() < 20 or c.sum() < (200 if base_mask is None else 50):
                continue
            ws += (float(np.mean(ev['a10'][a])) - float(np.mean(bE[c]))) * a.sum()
            wn += a.sum(); cells += 1
        dCell = ws / wn if wn else np.nan
        hqE = (ev['pos'] >= 75) & (ev['vola'] >= volaP60)
        a = mask & hqE
        c = hq_c if base_mask is None else (bM & hqE)
        dHQ = (float(np.mean(ev['a10'][a])) - float(np.mean(bE[c]))) if a.sum() >= 100 and c.sum() >= 100 else np.nan
        yv = list(fin.values())
        passed = bool(d10 > 0 and np.isfinite(q1) and np.isfinite(q2) and (q1 > 0) == (q2 > 0)
                      and yv and all(v > 0 for v in yv) and np.isfinite(exBest) and exBest > 0
                      and d10 - COST > 0 and np.isfinite(dCell) and dCell > COST)
        gates = sum([d10 > 0, bool(np.isfinite(q1) and np.isfinite(q2) and (q1 > 0) == (q2 > 0)), bool(yv and all(v > 0 for v in yv)),
                     bool(np.isfinite(exBest) and exBest > 0), d10 - COST > 0, bool(np.isfinite(dCell) and dCell > COST)])
        return dict(n=g, d5=d5, d10=d10, d20=d20, w=w, raw=raw, rawW=rawW, cw=cwm, craw=crw, crawW=crwW, q1=q1, q2=q2, yr=yr, bestY=bestY, exBest=exBest, dCell=dCell, cells=cells, wn=wn, dHQ=dHQ, nHQ=int(a.sum()), passed=passed, gates=gates)

    def show(name, r, base_note='對照 = 同一天全市場'):
        if r is None:
            print(f'─ {name}:⏳ 樣本不足(需 ≥{MIN_N})\n'); return
        print(f'─ {name}  n={r["n"]:,}({base_note})')
        print(f'   5日 {sg(r["d5"])}{nf(r["d5"])}pp ・10日 {sg(r["d10"])}{nf(r["d10"])}pp ・20日 {sg(r["d20"])}{nf(r["d20"])}pp ・勝率 {nf(r["w"], 1)}%(對照 {nf(r["cw"], 1)}%)'
              f' ・💰 絕對:10 日 {sg(r["raw"])}{nf(r["raw"])}% ・賺錢機率 {nf(r["rawW"], 1)}%(對照 {nf(r["craw"])}% / {nf(r["crawW"], 1)}%)')
        print(f'   前半 {sg(r["q1"])}{nf(r["q1"])} / 後半 {sg(r["q2"])}{nf(r["q2"])}'
              + ('' if (np.isfinite(r['q1']) and np.isfinite(r['q2']) and (r['q1'] > 0) == (r['q2'] > 0)) else ' 🚨不同向')
              + ' ・逐年 ' + ' '.join(f'{y % 100}:{sg(v)}{nf(v, 1)}' for y, v in r['yr'].items()))
        print(f'   去最好年({r["bestY"]}) {sg(r["exBest"])}{nf(r["exBest"])} ・扣成本 {sg(r["d10"] - COST)}{nf(r["d10"] - COST)}'
              f' ・格內({int(r["cells"])}格/{int(r["wn"])}筆) {sg(r["dCell"])}{nf(r["dCell"])} ・疊在🧬之上 {sg(r["dHQ"])}{nf(r["dHQ"])}(n={r["nHQ"]})')
        verdict = '✅ 六關全過' if r['passed'] else f'❌ 沒過({r["gates"]}/6)'
        print(f'   {verdict}\n')

    out = []
    print('📌 ① 外資「真連續」淨買剛好到 N 天(⭐ 高原檢定 N=3~7;⛔ 不是「7 天裡 5 天」)')
    tbl = []
    for n_ in NS:
        m = ev['st'] == n_
        r = stats(m)
        show(f'連買 {n_} 天', r)
        tbl.append((n_, r))
        out.append({'name': f'fstreak{n_}', 'r': r})
    print('   ⛰️ 高原檢定(10 日增量 pp):' + ' / '.join(f'N={n_} {sg(r["d10"]) + nf(r["d10"]) if r else "—"}' for n_, r in tbl))
    vals = [r['d10'] for _, r in tbl if r]
    if len(vals) >= 3:
        mono = all(vals[i] <= vals[i + 1] for i in range(len(vals) - 1)) or all(vals[i] >= vals[i + 1] for i in range(len(vals) - 1))
        allpos = all(v > 0 for v in vals)
        print(f'   → {"✅ 一片高原(全正且單調)" if (mono and allpos) else ("⚠️ 全正但不單調" if allpos else "❌ 不是高原(有負的格)")}\n')

    print('📌 ② 投信同步(⭐ 增量檢定:對照 = 「外資連買 N 天但投信 3 日內都沒買」,共用外資腿,⛔ 不拿全市場當對照)')
    for n_ in (5, 3, 7):
        A = (ev['st'] == n_) & (ev['tr'] == 1)
        B = (ev['st'] == n_) & (ev['tr'] == 0)
        show(f'N={n_} 外資連買 ∧ 投信同步(A)', stats(A))
        show(f'N={n_} 外資連買 ∧ 投信沒買(B)', stats(B))
        inc = stats(A, base_mask=B)
        show(f'N={n_} ⭐ 增量 A − B', inc, base_note='對照 = B 那群事件')
        out.append({'name': f'trust_inc{n_}', 'r': inc, 'A': stats(A), 'B': stats(B)})
    print('📌 ②b 投信單腿(投信自己連買 N 天,不管外資)—— 只當對照,`trustvol_probe` 早就六關 0 過')
    for n_ in (3, 5):
        show(f'投信連買 ≥{n_} 天', stats(ev['trst'] >= n_))

    print('📌 ②c ⭐ 反向增量:**投信**連買剛好 N 天之上,外資 3 日內有沒有買 —— 分得出「誰在說話」(A′ − B′;對照 = B′ 那群)')
    for n_ in (3, 5):
        A2 = (evT['st'] == n_) & (evT['fs'] == 1)
        B2 = (evT['st'] == n_) & (evT['fs'] == 0)
        show(f'投信剛好連買 {n_} 天 ∧ 外資同步(A′)', stats(A2, ev=evT))
        show(f'投信剛好連買 {n_} 天 ∧ 外資沒買(B′)', stats(B2, ev=evT))
        inc2 = stats(A2, base_mask=B2, ev=evT)
        show(f'N={n_} ⭐ 反向增量 A′ − B′', inc2, base_note='對照 = B′ 那群事件')
        out.append({'name': f'foreign_on_trust{n_}', 'r': inc2})

    print('📌 ③ 強度互控:N 天外資淨買 ÷ N 天成交量(三分位 × N)—— 是「連續」在說話,還是「量」在說話?')
    for n_ in (3, 5, 7):
        m = (ev['st'] == n_) & np.isfinite(ev['ratio'])
        if m.sum() < MIN_N * 3:
            print(f'   N={n_}:樣本不足\n'); continue
        q1_, q2_ = np.percentile(ev['ratio'][m], [100 / 3, 200 / 3])
        for lab, mm in (('買得少', m & (ev['ratio'] < q1_)), ('中', m & (ev['ratio'] >= q1_) & (ev['ratio'] < q2_)), ('買得多', m & (ev['ratio'] >= q2_))):
            r = stats(mm)
            print(f'   N={n_} {lab}(占量比 {"<" + nf(q1_, 1) if lab == "買得少" else ("≥" + nf(q2_, 1) if lab == "買得多" else nf(q1_, 1) + "~" + nf(q2_, 1))}%):'
                  f' n={int(mm.sum()):,} ・10日 {sg(r["d10"]) + nf(r["d10"]) if r else "—"}pp ・勝率 {nf(r["w"], 1) if r else "—"}%')
        print()

    # evB = 突然大買事件庫(🔁 V79.4.3 已在開頭換成「同一天、算得出門檻的股·日」那個對照母體)
    print('📌 ④ 外資「突然一大筆」(單日淨買 ≥ 自己過去 250 天第 P 百分位)—— 富喬那種:賣了一陣子,突然一大筆')
    if len(evB['e10']) == 0:
        print('   ⏳ 沒有事件(法人欄位太短?)\n')
    else:
        tblB = []
        for P in BURST_PS:
            m = (evB['lvl'] == P) & (evB['prior'] == 1)
            r = stats(m, ev=evB)
            show(f'P{P} ∧ 前 20 天外資在賣', r)
            tblB.append((P, r))
            out.append({'name': f'burst{P}', 'r': r})
        print('   ⛰️ 高原(10 日增量 pp):' + ' / '.join(f'P{P} {sg(r["d10"]) + nf(r["d10"]) if r else "—"}' for P, r in tblB))
        show('P99(不管前 20 天)', stats(evB['lvl'] == 99, ev=evB))
        m99 = (evB['lvl'] == 99) & (evB['prior'] == 1)
        r = stats(m99 & (evB['mdown'] == 1), ev=evB); show('P99 ∧ 前 20 天在賣 ∧ 那天加權跌 ≥1%(今天這種盤)', r); out.append({'name': 'burst99_mdown', 'r': r})
        r = stats((evB['lvl'] == 99) & (evB['lu'] == 1), ev=evB); show('P99 ∧ 那天收漲停', r); out.append({'name': 'burst99_lu', 'r': r})
        r = stats(m99 & (evB['lu'] == 1), ev=evB); show('P99 ∧ 前 20 天在賣 ∧ 那天收漲停(富喬 10/16 那種)', r); out.append({'name': 'burst99_prior_lu', 'r': r})
        r = stats(m99 & (evB['lu'] == 1) & (evB['mdown'] == 1), ev=evB); show('P99 ∧ 在賣 ∧ 漲停 ∧ 大盤跌 ≥1%', r)
        r = stats(m99 & (evB['mdown'] == 1), base_mask=m99 & (evB['mdown'] == 0), ev=evB)
        show('⭐ 增量:同樣的外資突然大買,「大盤跌的那天」− 「大盤沒跌的那天」', r, base_note='對照 = 大盤沒跌那幾天的同類事件')

    print('📎 既有對照(登記表;⛔ 這支不重測):`_SCR_EDGE.fdays7`(7 天裡 ≥5 天)−0.24pp / 37.8% ・板塊 C 變體(10 日 ≥6 天)孤峰 ・投信單腿六關 0 過')
    yrs_ev = sorted(set(int(x) for x in ev['y']))
    print(f'⚠️ 限制:事件年份 {yrs_ev[0] if yrs_ev else "—"}~{yrs_ev[-1] if yrs_ev else "—"}(法人欄從哪年起看 DATA_DIR:data/ 是 2023-06 起、d10n + inst_deep 是 2012 起)'
          '・單位股 ・賣方未測 ・最後一根 0 = 未公布已剔除')
    return out


# ── ⑤ 👑 本來會買的 × 外資突然一大筆(V79.3.7)──────────────────
LEAD_K = 5          # 換倉日(含)往前 5 個交易日內有過一次 → 算「剛被外資突然大買」


def burst_days(data=None, P=99):
    """每檔「外資單日淨買 ≥ 自己過去 250 天第 P 百分位」的日子 → {sym: {date: prior}}(prior 1 = 前 20 天外資合計在賣)。
    ⛔ 門檻不含當天(burst_thresholds);只看當天以前的資料。"""
    data = data or DATA
    out = {}
    for f in sorted(data.glob('*.json')):
        if not (f.stem.isdigit() and len(f.stem) == 4):
            continue
        rows = load(f) or []
        d, fn = [], []
        for r in rows:
            if not r or r.get('close') is None:
                continue
            d.append(str(r.get('date') or '').replace('/', '-')[:10])
            fn.append(None if r.get('foreign_net') is None else float(r['foreign_net']))
        if sum(1 for v in fn if v is not None) < BURST_MIN:
            continue
        fn, _ = clean_unpublished(fn, [None] * len(fn))
        bt = burst_thresholds(fn)[P]
        ok0 = next((i for i in range(len(bt)) if np.isfinite(bt[i])), None)
        if ok0 is None:
            continue
        hit = {}
        for i, v in enumerate(fn):
            if v is not None and v > 0 and np.isfinite(bt[i]) and bt[i] > 0 and v >= bt[i]:
                pw = [fn[j] for j in range(max(0, i - 20), i) if fn[j] is not None]
                hit[d[i]] = 1 if (len(pw) >= 15 and sum(pw) < 0) else 0
        out[f.stem] = (d, hit, d[ok0])     # 第三格 = 第一天算得出門檻(那天以前 = 不知道,⛔ 不可當「沒被大買」)
    return out


def lead_split(trace, bdays, k=LEAD_K):
    """trace = leader_probe 的每一筆 {d 換倉日, s, r 隔天開盤→下次換倉日 %, b 0050 同期 %, lock};
    回 {'burst': [...], 'prior': [...], 'none': [...], 'nodata': n}。⛔ 只看換倉日(含)以前 k 個交易日 —— 換倉日之後的大買不算(零前視)。"""
    g = {'burst': [], 'prior': [], 'none': [], 'nodata': 0}
    for x in trace:
        if x.get('lock'):
            continue
        bd = bdays.get(x['s'])
        if not bd:
            g['nodata'] += 1
            continue
        dates, hit = bd[0], bd[1]
        if len(bd) > 2 and x['d'] < bd[2]:
            g['nodata'] += 1                 # 那天還算不出門檻(法人資料不夠 250 天)→ 不知道
            continue
        try:
            i = dates.index(x['d'])
        except ValueError:
            g['nodata'] += 1
            continue
        win = [hit[dd] for dd in dates[max(0, i - k + 1):i + 1] if dd in hit]
        v = x['r'] - x['b']
        if win:
            g['burst'].append((x['d'], v))
            if max(win) == 1:
                g['prior'].append((x['d'], v))
        else:
            g['none'].append((x['d'], v))
    return g


def lead_section(trace_path, data=None):
    raw = load(trace_path)
    if not raw:
        print(f'❌ 讀不到 {trace_path}')
        return 1
    print(f'📌 ⑤ 👑 本來會買的那幾檔 × 換倉日前 {LEAD_K} 天內「外資突然一大筆」(P99)—— 富喬 10/16 那種(當天就在 👑 前 10)')
    bd = burst_days(data)
    print(f'   有法人資料、算得出門檻的 {len(bd):,} 檔')

    def st(a):
        if not a:
            return None
        v = np.array([x[1] for x in a])
        yr = {}
        for dd, x in a:
            yr.setdefault(dd[:4], []).append(x)
        sd = float(v.std(ddof=1)) if len(v) > 1 else 0.0
        return {'n': len(v), 'm': float(v.mean()), 'med': float(np.median(v)), 't': float(v.mean() / (sd / math.sqrt(len(v)))) if sd > 0 else 0.0,
                'yr': {y: (len(q), float(np.mean(q))) for y, q in sorted(yr.items())}}
    rc = 0
    for key, tr in raw.items():
        g = lead_split(tr, bd)
        print(f'   [{key}] 本來會買 {len(tr):,} 筆(開盤就漲停買不到的不算)・查不到法人 {g["nodata"]:,}')
        A, B, C = st(g['burst']), st(g['prior']), st(g['none'])
        for lab, r in (('剛被外資突然大買', A), ('  └ 而且前 20 天外資在賣(富喬那種)', B), ('其他(沒被突然大買)', C)):
            if not r:
                print(f'      {lab}:沒有樣本'); continue
            ys = ' '.join(f'{y}:{m:+.1f}({n})' for y, (n, m) in r['yr'].items())
            print(f'      {lab}:n={r["n"]:,} ・比 0050 平均 {r["m"]:+.2f}pp 中位 {r["med"]:+.2f} t={r["t"]:.1f}\n         逐年 {ys}')
        if A and C:
            yrs = sorted(set(A['yr']) & set(C['yr']))
            pos = sum(1 for y in yrs if A['yr'][y][1] > C['yr'][y][1])
            print(f'      ⭐ 增量(突然大買 − 其他)= {A["m"] - C["m"]:+.2f}pp ・逐年 {pos}/{len(yrs)} 年比較好')
        if B and C:
            yrs = sorted(set(B['yr']) & set(C['yr']))
            pos = sum(1 for y in yrs if B['yr'][y][1] > C['yr'][y][1])
            print(f'      ⭐ 增量(富喬那種 − 其他)= {B["m"] - C["m"]:+.2f}pp ・逐年 {pos}/{len(yrs)} 年比較好')
        if not A and not C:
            rc = 1
    return rc


# ── 🧪 selftest ──────────────────────────────────────────────────
def make_selftest(tmp):
    """合成 3 檔 + 加權:S1 外資連買 5 天一次(第 300~304 天)・S2 連買 7 天(涵蓋 3~7 各一次訊號日)且投信同步
       ・S3 連買 5 天但**隔天開盤鎖漲停**(要被剔除)。⭐ 決定性對照:把 S1 訊號日**之後**的外資改成大買,訊號數不可變(零前視)。"""
    import random
    random.seed(7)
    n = 400
    dates = [f'2024-{1 + i // 28:02d}-{1 + i % 28:02d}' for i in range(n)]      # 假日期(只要能排序、能對上加權)
    dates = [f'2024-{(i // 28) + 1:02d}-{(i % 28) + 1:02d}' if i < 336 else f'2025-{((i - 336) // 28) + 1:02d}-{((i - 336) % 28) + 1:02d}' for i in range(n)]
    twii = [{'date': d, 'close': 20000 + i * 5} for i, d in enumerate(dates)]
    (tmp / '^TWII.json').write_text(json.dumps(twii))

    def mk(sym, fn_of, tn_of, limit_day=None):
        rows, c = [], 100.0
        for i, d in enumerate(dates):
            c = c * (1 + random.uniform(-0.01, 0.01))
            o = c * (1 + random.uniform(-0.005, 0.005))
            h, l = max(o, c) * 1.005, min(o, c) * 0.995
            if limit_day is not None and i == limit_day:
                o = h = l = c = rows[-1]['close'] * 1.1            # 一字漲停(open=high=low)
            rows.append({'date': d, 'open': round(o, 2), 'high': round(h, 2), 'low': round(l, 2), 'close': round(c, 2), 'volume': 1000000,
                         'foreign_net': fn_of(i), 'trust_net': tn_of(i)})
        (tmp / f'{sym}.json').write_text(json.dumps(rows))
    mk('1001', lambda i: 5000 if 300 <= i <= 304 else -1000, lambda i: -100)                  # 連買 5 天 → st=3@302,4@303,5@304
    mk('1002', lambda i: 5000 if 320 <= i <= 326 else -1000, lambda i: 300 if 318 <= i <= 326 else -100)   # 連買 7 天 + 投信同步
    mk('1003', lambda i: 5000 if 340 <= i <= 344 else -1000, lambda i: -100, limit_day=345)  # 連買 5 天但 t+1 一字漲停
    return dates


def _st_days(start, n):
    """🔁 V79.4.3 selftest 用:從 start 起 n 個平日('YYYY-MM-DD')。"""
    import datetime as dt
    d0, out = dt.date.fromisoformat(start), []
    while len(out) < n:
        if d0.weekday() < 5:
            out.append(d0.isoformat())
        d0 += dt.timedelta(days=1)
    return out


def _st_path(n, drift_of, seed):
    """🔁 V79.4.3 selftest 用:每天漂移 drift_of(i) + ±1% 雜訊的 K 線 [(開, 高, 低, 收)]。"""
    import random
    rnd, c, px = random.Random(seed), 100.0, []
    for i in range(n):
        c *= 1 + drift_of(i) + rnd.uniform(-0.01, 0.01)
        o = c * (1 + rnd.uniform(-0.004, 0.004))
        px.append((o, max(o, c) * 1.004, min(o, c) * 0.996, c))
    return px


def _st_write(tmp, sym, dates, px, fn, tn):
    """🔁 V79.4.3 selftest 用:fn / tn 是 None 的那天 → 欄位整個不寫(= d16 的「沒有資料」,⛔ 不是 0)。日期照 d16 寫 YYYY/MM/DD。"""
    rows = []
    for i, d in enumerate(dates):
        o, h, l_, c = px[i]
        r = {'date': d.replace('-', '/'), 'open': round(o, 4), 'high': round(h, 4), 'low': round(l_, 4), 'close': round(c, 4), 'volume': 1000000}
        if fn[i] is not None:
            r['foreign_net'] = fn[i]
        if tn[i] is not None:
            r['trust_net'] = tn[i]
        rows.append(r)
    (tmp / f'{sym}.json').write_text(json.dumps(rows))


def selftest():
    import tempfile
    global WARM
    WARM = 250
    fails = []

    def ok(name, cond, extra=''):
        print(f'{"✅" if cond else "❌"} {name}{"" if cond else "  " + str(extra)}')
        if not cond:
            fails.append(name)
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        dates = make_selftest(tmp)
        res = collect(tmp, verbose=False)
        ctrl, ev, all_dates, n_sym, syms = res
        ok('⓪ 空過守門:3 檔都收到、對照組有東西', n_sym == 3 and len(ctrl['e10']) > 300, f'{n_sym} / {len(ctrl["e10"])}')
        by = {}
        for s, st, si, tr in zip(ev['st'], ev['st'], ev['si'], ev['tr']):
            by.setdefault(syms[int(si)], []).append((int(st), int(tr)))
        ok('① S1 連買 5 天 → 剛好 N=3/4/5 各一個訊號日(⛔ 不是「≥N 的每一天」)', sorted(x[0] for x in by.get('1001', [])) == [3, 4, 5], str(by.get('1001')))
        ok('② S2 連買 7 天 → N=3~7 各一個,而且投信同步旗標 = 1', sorted(x[0] for x in by.get('1002', [])) == [3, 4, 5, 6, 7] and all(x[1] == 1 for x in by.get('1002', [])), str(by.get('1002')))
        ok('③ S1 的投信旗標 = 0(3 日內投信全 ≤0 且有資料;⛔ 不是 −1)', all(x[1] == 0 for x in by.get('1001', [])), str(by.get('1001')))
        ok('④ S3 t+1 一字漲停 → N=5 那個訊號日被剔除(買不到)', 5 not in [x[0] for x in by.get('1003', [])], str(by.get('1003')))
        # ⑤ 零前視:把 S1 訊號日之後的外資全改成大買 → S1 的訊號日集合不可變(dn 相同)
        rows = json.loads((tmp / '1001.json').read_text())
        for r in rows[305:]:
            r['foreign_net'] = 99999
        (tmp / '1001.json').write_text(json.dumps(rows))
        ev2 = collect(tmp, verbose=False)[1]
        dn1 = sorted(float(x) for x, si in zip(ev['dn'], ev['si']) if syms[int(si)] == '1001' and True)
        dn2 = sorted(float(x) for x, si in zip(ev2['dn'], ev2['si']) if int(si) == 0)
        ok('⑤ 零前視:改訊號日**之後**的外資,前面的訊號日一個都不可變(但之後會多出新的連買)', dn2[:3] == dn1[:3] and len(dn2) > len(dn1), f'{dn1[:3]} vs {dn2[:3]}')
        # ⑥ 去重:讓 S1 在第 302 天之後每天都連買到 3 就斷、再連 3 天 → 20 日內只算一次
        rows = json.loads((tmp / '1001.json').read_text())
        for i, r in enumerate(rows):
            r['foreign_net'] = 5000 if (300 <= i < 330 and (i - 300) % 4 != 3) else -1000     # 3 買 1 賣 循環 → st=3 每 4 天一次
        (tmp / '1001.json').write_text(json.dumps(rows))
        ev3 = collect(tmp, verbose=False)[1]
        n3 = sum(1 for st, si in zip(ev3['st'], ev3['si']) if int(si) == 0 and int(st) == 3)
        ok('⑥ 去重:30 天內 st=3 出現 7~8 次,20 日去重後只留 2 次', n3 == 2, str(n3))
        # ⑦ 最後一根 foreign_net=0 = 還沒公布 → 改 None(⚠️ 直接測那支函式 —— 事件窗口碰不到最後一根,走 collect 測不出來)
        f7, t7 = clean_unpublished([5000, 5000, 0], [1, 1, 0])
        ok('⑦ 最後一根 0 → None(還沒公布),前面的不動;最後一根非 0 就不動', f7 == [5000, 5000, None] and t7 == [1, 1, None] and clean_unpublished([1, -5], [0, 0])[0] == [1, -5], f'{f7} {t7}')
        # ⑧ V79.3.6 外資突然一大筆:門檻不含當天、樣本 < 120 不給
        fnT = [float(x % 7) for x in range(400)]
        for k in range(300, 310):
            fnT[k] = 1e6                                   # 第 300~309 天連 10 天一大筆
        bt = burst_thresholds(fnT)
        ok('⑧ 突然大買的門檻:當天那一大筆 ⛔ 不算進自己的門檻(第 300 天門檻仍 ≤6)、之後才會墊高(第 310 天 >6)、前 250 天沒有門檻',
           np.isfinite(bt[99][300]) and bt[99][300] <= 6 and not np.isfinite(bt[99][100]) and bt[99][310] > 6, f'{bt[99][300]} / {bt[99][100]} / {bt[99][310]}')
        fnN = [None] * 200 + [1.0] * 200
        btN = burst_thresholds(fnN)
        ok('⑧b 過去 250 天有資料 < 120 天 → 不給門檻', not np.isfinite(btN[95][300]) and np.isfinite(btN[95][399]), f'{btN[95][300]} / {btN[95][399]}')
        # ⑨ V79.3.7 👑 × 突然大買:換倉日前 k 天內有才算、換倉日之後的 ⛔ 不算(零前視)、開盤就漲停的不算
        dts = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']
        bdT = {'A': (dts, {'d2': 1}, 'd0'), 'B': (dts, {'d6': 0}, 'd0'), 'D': (dts, {}, 'd4')}
        trT = [{'d': 'd5', 's': 'A', 'r': 5, 'b': 1}, {'d': 'd5', 's': 'B', 'r': 2, 'b': 1}, {'d': 'd5', 's': 'C', 'r': 0, 'b': 0},
               {'d': 'd7', 's': 'A', 'r': 9, 'b': 0, 'lock': True}, {'d': 'd1', 's': 'A', 'r': 3, 'b': 0},
               {'d': 'd3', 's': 'D', 'r': 7, 'b': 0}]
        gT = lead_split(trT, bdT, k=5)
        ok('⑨ 👑 × 突然大買:A 換倉日 d5 前 5 天內(d2)有 → 算;B 的大買在 d6(換倉日之後)⛔ 不算;d1 那筆還沒發生 ⛔ 不算;開盤漲停那筆不算;C 查不到;D 那天還算不出門檻 → 不知道(⛔ 不當「沒被大買」)',
           [v for _, v in gT['burst']] == [4] and [v for _, v in gT['prior']] == [4] and sorted(v for _, v in gT['none']) == [1, 3] and gT['nodata'] == 2, str(gT))
        gT2 = lead_split(trT, bdT, k=3)
        ok('⑨b 窗口縮成 3 天(d3~d5)→ A 那次 d2 的大買就不算了', [v for _, v in gT2['burst']] == [], str(gT2))
        st_a = streaks([5000, 5000, 0])
        st_b = streaks([5000, 5000, None])
        ok('⑦b `streaks`:0 或 None 都讓連續中斷(0 = 沒買;最後一根的 0 由 collect 改成 None)', st_a == [1, 2, 0] and st_b == [1, 2, 0], f'{st_a} {st_b}')
        # ⑩c 🔁 V79.4.3 同一天對照組不到 MIN_CTRL 檔 → 那天的事件不算(⛔ 拿別天湊):這組只有 3 檔
        ctrl0, ev0 = res[0], res[1]
        _, evx, dropx = same_day(ctrl0, ev0, 'kf')
        ok(f'⑩c 同一天只有 3 檔(< {MIN_CTRL})→ 事件全部不算、而且數得出丟了幾筆', len(evx['e10']) == 0 and dropx == len(ev0['e10']) > 0, f'{len(evx["e10"])} / {dropx}')

    # ⑩ 🔁 V79.4.3 同一天對照(陷阱 #50)—— ⭐ 決定性對照:事件跟同一天的大家一模一樣 → 新算法 ≈ 0,舊算法憑空量出一截
    #    A 組 40 檔:前 380 天沒有法人資料、每天 +1%;380~559 天有法人、每天 −0.2%(外資每 25 天連買 5 天 = 事件只在這段);560 天起 +0.6%
    #    B 組 20 檔:380~599 天(跟 A 的事件同一批日子)法人資料缺、每天 +1% —— 缺值若被當成「有資料」就會混進同一天的對照
    import contextlib
    import io
    with tempfile.TemporaryDirectory() as t2:
        tmp2 = Path(t2)
        n2, REG, MID2, BREG = 760, 380, 560, 600
        days2 = _st_days('2011-01-03', n2)
        (tmp2 / '^TWII.json').write_text(json.dumps([{'date': d, 'close': 8000} for d in days2]))
        driftA = lambda i: 0.01 if i < REG else (-0.002 if i < MID2 else 0.006)   # noqa: E731
        driftB = lambda i: 0.01 if i < BREG else 0.006                            # noqa: E731
        for s in range(40):
            ph = (s * 3) % 25
            fnA = [None if i < REG else (5000 if (i < MID2 and (i - REG + ph) % 25 < 5) else -1000) for i in range(n2)]
            _st_write(tmp2, str(2001 + s), days2, _st_path(n2, driftA, 100 + s), fnA, [None if i < REG else -100 for i in range(n2)])
        for s in range(20):
            _st_write(tmp2, str(3001 + s), days2, _st_path(n2, driftB, 300 + s),
                      [None if i < BREG else -1000 for i in range(n2)], [None if i < BREG else -100 for i in range(n2)])
        res2 = collect(tmp2, verbose=False)
        ctrl2, ev2b = res2[0], res2[1]
        m5 = ev2b['st'] == 5
        old_all = float(np.mean(ev2b['e10'][m5])) - float(np.mean(ctrl2['e10']))                 # 舊口徑:整段、不管法人資料
        kf2 = ctrl2['kf'] > 0
        old_kf = float(np.mean(ev2b['e10'][m5])) - float(np.mean(ctrl2['e10'][kf2]))             # 整段、但只留法人已知
        c_all = dict(ctrl2)
        c_all['kf'] = np.ones(len(ctrl2['e10']))
        _, ev_all, _ = same_day(c_all, ev2b, 'kf')                                                # 同一天、但缺值也算進對照
        row_all = float(np.mean(ev_all['a10'][ev_all['st'] == 5]))
        with contextlib.redirect_stdout(io.StringIO()):
            out2 = analyse(*res2, data=tmp2)
        r5 = next((o['r'] for o in out2 if o['name'] == 'fstreak5'), None)
        ok(f'⑩ 決定性對照:整段平均(舊)憑空 {old_all:+.2f}pp、整段但只留法人已知 {old_kf:+.2f}pp、同一天但缺值也算 {row_all:+.2f}pp(三個都 < −1)',
           old_all < -1 and old_kf < -1 and row_all < -1, f'{old_all} / {old_kf} / {row_all}')
        ok(f'⑩ 同一天、法人已知的對照 → analyse() 的 N=5 超額 ≈ 0(|{(r5 or {}).get("d10", float("nan")):+.2f}| < 0.5;n = {(r5 or {}).get("n")})',
           r5 is not None and abs(r5['d10']) < 0.5 and r5['n'] >= MIN_N, str(r5 and {k: r5[k] for k in ('n', 'd10', 'q1', 'q2')}))
        cw_whole = float((ctrl2['e10'][kf2] > 0).mean() * 100)
        ok(f'⑩b 勝率旁的「對照」= 同一批日子的對照勝率(事件 {(r5 or {}).get("w", 0):.1f}% vs 同日對照 {(r5 or {}).get("cw", 0):.1f}%;整段的是 {cw_whole:.1f}%)',
           r5 is not None and abs(r5['w'] - r5['cw']) < 10 and abs(r5['w'] - cw_whole) > 20, str(r5 and (r5['w'], r5['cw'], cw_whole)))

    # ⑪ 🔁 V79.4.3 2015-06 前漲跌幅 ±7%:2012 年隔天一價到底 +7% = 鎖漲停(買不到);同一根放到 2020 年(要 +10%)→ 買得到
    with tempfile.TemporaryDirectory() as t3:
        tmp3 = Path(t3)
        n3 = 400
        dA, dB = _st_days('2011-01-03', n3), _st_days('2019-01-01', n3)
        (tmp3 / '^TWII.json').write_text(json.dumps([{'date': d, 'close': 8000} for d in dA + dB]))
        for sym, days_ in (('1011', dA), ('1012', dB)):
            px = _st_path(n3, lambda i: 0.0, 7)
            c4 = px[304][3]
            px = px[:305] + [(c4 * 1.07,) * 4] + [tuple(v * 1.07 for v in p) for p in px[306:]]   # 後面跟著同一個尺標(⛔ 不製造斷崖)
            _st_write(tmp3, sym, days_, px, [5000 if 300 <= i <= 304 else -1000 for i in range(n3)], [-100] * n3)
        _, ev3, _, _, sy3 = collect(tmp3, verbose=False)
        byN = {s: sorted(int(st) for st, si in zip(ev3['st'], ev3['si']) if sy3[int(si)] == s) for s in ('1011', '1012')}
        ok(f'⑪ 2012 年隔天鎖 +7% → N=5 那筆買不到、不算({dA[305]});同一根在 2020 年({dB[305]})→ 照算',
           byN.get('1011') == [3, 4] and byN.get('1012') == [3, 4, 5], str(byN))

    # ⑫ 🔁 V79.4.3 斷崖只剔碰到的窗口(⛔ 不整檔剔除):第 650 根起 ×1.6(減資恢復交易)
    #    事件 A 在第 304 根(窗口 55~324 乾淨)→ 留;事件 B 在第 644 根(持有 20 天會碰到 650)→ 剔;第 630 根起的對照也剔(位階 250 根往回看會碰到)
    with tempfile.TemporaryDirectory() as t4:
        tmp4 = Path(t4)
        n4, KC = 760, 650
        days4 = _st_days('2016-01-04', n4)
        (tmp4 / '^TWII.json').write_text(json.dumps([{'date': d, 'close': 9000} for d in days4]))
        px = _st_path(n4, lambda i: 0.0, 11)
        px = px[:KC] + [tuple(v * 1.6 for v in p) for p in px[KC:]]
        _st_write(tmp4, '1021', days4, px, [5000 if (300 <= i <= 304 or 640 <= i <= 644) else -1000 for i in range(n4)], [-100] * n4)
        ctrl4, ev4, _, ns4, sy4 = collect(tmp4, verbose=False)
        dn5 = sorted(int(x) for x, st in zip(ev4['dn'], ev4['st']) if int(st) == 5)
        cdn4 = ctrl4['dn'].astype(int)
        ok('⑫ 有斷崖的股票 ⛔ 不整檔剔除:窗口乾淨的第 304 根事件照算、碰到斷崖的第 644 根不算',
           ns4 == 1 and sy4 == ['1021'] and dn5 == [304], f'n_sym={ns4} N5={dn5}')
        ok('⑫ 對照組也只剔碰到的窗口(第 250~629 根全留、630 根起全剔)',
           len(cdn4) == 380 and int(cdn4.min()) == 250 and int(cdn4.max()) == KC - 21, f'{len(cdn4)} {cdn4.min() if len(cdn4) else None}~{cdn4.max() if len(cdn4) else None}')
    print(f'\n{"✅ selftest 全過" if not fails else "❌ " + str(len(fails)) + " 條失敗:" + " / ".join(fails)}')
    return 0 if not fails else 1


def main():
    if SELFTEST:
        sys.exit(selftest())
    if os.environ.get('LEAD_TRACE'):
        sys.exit(lead_section(os.environ['LEAD_TRACE']))
    res = collect()
    if not res:
        sys.exit(1)
    analyse(*res)


if __name__ == '__main__':
    main()
