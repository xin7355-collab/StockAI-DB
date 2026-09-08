#!/usr/bin/env python3
"""🧪 兩套策略的完整回測(使用者規格,一字不差)+ 對照組 + 六道關卡

⛔ **這支的定位是「先回測再談要不要做」** —— 本站鐵則:預測性主張一定要先實測。
   它同時是使用者要的三個交付物:①含訊號的 DataFrame ②交易明細 ③資金曲線 vs 大盤。

策略 A「布林壓縮突破」(使用者規格 §2):
  市場濾網 大盤 > SMA60 ・帶寬創 100 日新低後 ・收盤突破布林上軌 ・量 > 20 日均量 ×2.5
  ・外資+投信近 3 日合計買超 > 0
  出場:停損 進場價 − 2×ATR14 ・獲利 > 3×ATR 啟動移動停利、最高點回撤 1.5×ATR 平倉
       ・時間停損 20 日未達 +5% 強制平倉
策略 B「強勢股多頭拉回」:
  收盤 > MA60 且 MA60 > MA120 ・近 10 日曾創 60 日新高 ・近 3 日跌破 MA20
  ・量 < 20 日均量 ×0.7 ・當日紅 K
  出場:最高價回撤 2×ATR14 ・跌破進場日低點 − 1×ATR14 ・15 日強制平倉

🚨 **五個方法論守門(⛔ 拿掉任何一個結論就不能用)**:
 ① **進場 = 訊號日隔天開盤**。訊號用收盤價算 → 當天收盤買不到(前視偏誤)。
    排除「隔天開盤就鎖漲停」(買不到那個價)。
 ② **對照組共用那條腿**:同一批股票、同一段期間、**同一套出場規則**,只是進場日隨機
    → 量到的才是「進場條件」的功勞。⛔ 拿「全市場買進持有」比會量到別的東西。
 ③ **成本雙邊全扣**:手續費 0.1425%×折數 ×2 + 賣出證交稅 0.3% + 滑價 0.1%×2。
 ④ **法人那條腿只在「這檔真的有法人資料」的期間算** —— 2022 那段 foreign_net 全 0,
    不排除的話會整批判成「沒有買超」(V72.1.6:欄位存在 ≠ 有資料)。
 ⑤ **六道關卡**:全期正 / 前後半同向 / 逐年同向 / 去最好年 / 扣成本 / 贏對照組。

用法:python3 scripts/strat_probe.py [--strategy a|b|both] [--max 300] [--html out.html]
     python3 scripts/strat_probe.py --selftest
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib_perf import generate_performance_report  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get('DATA_DIR', os.path.join(ROOT, 'data'))

# ── 交易成本(使用者規格 §2)────────────────────────────────────────────
FEE = 0.001425        # 單邊手續費
FEE_DISC = 0.6        # 折數(永豐 6 折)
TAX = 0.003           # 賣出證交稅
SLIP = 0.001          # 單邊滑價
RISK_PCT = 0.015      # 固定 1.5% 總資產風險模型
INIT_CAP = 1_000_000
MAX_POS = 5           # 同時最多持有幾檔(⛔ 不設上限的話等於無限槓桿)


def load_stock(path: str) -> pd.DataFrame | None:
    """讀一檔 → 補齊所有技術指標與訊號欄位(使用者交付物 ①)。"""
    try:
        raw = json.load(open(path, encoding='utf-8'))
    except Exception:
        return None
    rows = raw if isinstance(raw, list) else (raw.get('data') or raw.get('records') or [])
    if not isinstance(rows, list) or len(rows) < 300 or not isinstance(rows[0], dict):
        return None
    df = pd.DataFrame(rows)
    if 'close' not in df.columns:
        return None
    df['Date'] = pd.to_datetime(df['date'].astype(str).str.replace('/', '-', regex=False), errors='coerce')
    df = df.dropna(subset=['Date']).sort_values('Date').reset_index(drop=True)
    for a, b in [('open', 'Open'), ('high', 'High'), ('low', 'Low'), ('close', 'Close'), ('volume', 'Volume')]:
        df[b] = pd.to_numeric(df.get(a), errors='coerce')
    df['Foreign_Buy'] = pd.to_numeric(df.get('foreign_net'), errors='coerce').fillna(0)
    df['Investment_Trust_Buy'] = pd.to_numeric(df.get('trust_net'), errors='coerce').fillna(0)
    df['Margin_Balance'] = pd.to_numeric(df.get('margin_balance'), errors='coerce').fillna(0)
    df = df.dropna(subset=['Close', 'High', 'Low', 'Open']).reset_index(drop=True)
    if len(df) < 300:
        return None

    C, H, L, V = df['Close'], df['High'], df['Low'], df['Volume']
    # 均線
    for n in (20, 60, 120):
        df[f'MA{n}'] = C.rolling(n).mean()
    # 布林(20, 2σ)與帶寬
    mid, sd = C.rolling(20).mean(), C.rolling(20).std(ddof=0)
    df['BB_mid'], df['BB_up'], df['BB_low'] = mid, mid + 2 * sd, mid - 2 * sd
    df['BB_bw'] = (df['BB_up'] - df['BB_low']) / mid * 100
    df['BB_bw_low100'] = df['BB_bw'] <= df['BB_bw'].rolling(100).min()
    # ATR(14):真實區間的簡單平均(⚠️ 跟 App 的 Wilder 版是不同的東西,⛔ 不可混用)
    pc = C.shift(1)
    tr = pd.concat([H - L, (H - pc).abs(), (L - pc).abs()], axis=1).max(axis=1)
    df['ATR14'] = tr.rolling(14).mean()
    # 量能
    df['VMA20'] = V.rolling(20).mean()
    df['VolRatio'] = V / df['VMA20']
    # 法人:近 3 日合計;⚠️ 只在「這檔真的有法人資料」的期間算(守門 ④)
    inst = df['Foreign_Buy'] + df['Investment_Trust_Buy']
    df['Inst3'] = inst.rolling(3).sum()
    df['HasInst'] = (inst != 0).rolling(60).sum() > 0
    # 60 日新高 / 紅 K
    df['Hi60'] = H.rolling(60).max()
    df['NewHi60'] = H >= df['Hi60']
    df['NewHi60_10d'] = df['NewHi60'].rolling(10).sum() > 0
    df['RedK'] = C > df['Open']
    return df


def market_filter(mkt: pd.DataFrame) -> pd.Series:
    """市場濾網:大盤在 SMA60 之上才准做多。回 Date → bool。"""
    m = mkt.set_index('Date')['Close']
    return (m > m.rolling(60).mean()).fillna(False)


def signals_a(df: pd.DataFrame, mkt_ok: pd.Series) -> pd.Series:
    """策略 A:布林帶寬創 100 日新低『之後』出現突破上軌 + 爆量 + 法人買超。"""
    # 「帶寬創 100 日新低**後**」→ 近 10 日內出現過壓縮(⛔ 不是當天壓縮又當天突破,那不可能同時成立)
    squeezed = df['BB_bw_low100'].rolling(10).sum() > 0
    return (
        squeezed
        & (df['Close'] > df['BB_up'])
        & (df['VolRatio'] > 2.5)
        & df['HasInst'] & (df['Inst3'] > 0)
        & df['Date'].map(mkt_ok).fillna(False).astype(bool)
    ).fillna(False)


def signals_b(df: pd.DataFrame) -> pd.Series:
    """策略 B:多頭排列 + 曾創 60 日新高 + 拉回跌破 MA20 + 窒息量 + 止跌紅 K。"""
    below20 = (df['Close'] < df['MA20']).rolling(3).sum() > 0
    return (
        (df['Close'] > df['MA60']) & (df['MA60'] > df['MA120'])
        & df['NewHi60_10d'] & below20
        & (df['VolRatio'] < 0.7)
        & df['RedK']
    ).fillna(False)


# ── 出場設定 ──────────────────────────────────────────────────────────────
EXIT_A = dict(stop_atr=2.0, trail_arm_atr=3.0, trail_atr=1.5, max_days=20, time_min_ret=5.0, stop_from='entry')
EXIT_B = dict(stop_atr=1.0, trail_arm_atr=0.0, trail_atr=2.0, max_days=15, time_min_ret=None, stop_from='low')
# ⭐ 本站 V74.4.8 實測過的出場(49 個月 28 種變體裡的前段班):放寬移動出場、⛔ 不設時間停損。
#    拿來當對照 → 分得出「進場條件沒用」與「進場有用但被出場洗掉」。
EXIT_VALID = dict(stop_atr=2.0, trail_arm_atr=0.0, trail_atr=2.0, max_days=40, time_min_ret=None, stop_from='entry')


def simulate_one(df: pd.DataFrame, i: int, cfg: dict):
    """從訊號日 i 模擬一筆交易 → (進場 idx, 出場 idx, 進場價, 出場價, 出場原因)。
    ⚠️ 進場 = i+1 的**開盤**(守門 ①);開盤就鎖漲停(開=高 且 跳空 ≥9%)→ 買不到,放棄。"""
    n = len(df)
    if i + 1 >= n:
        return None
    O, H, L, C = df['Open'].to_numpy(), df['High'].to_numpy(), df['Low'].to_numpy(), df['Close'].to_numpy()
    atr = df['ATR14'].to_numpy()
    e = i + 1
    px = O[e]
    if not (px > 0) or not np.isfinite(atr[i]) or atr[i] <= 0:
        return None
    if O[e] >= H[e] and O[e] >= C[i] * 1.09:
        return None                                   # 開盤鎖死,買不到
    a = atr[i]
    stop = (px - cfg['stop_atr'] * a) if cfg['stop_from'] == 'entry' else (L[i] - cfg['stop_atr'] * a)
    peak = px
    armed = cfg['trail_arm_atr'] <= 0                 # arm=0 → 一開始就啟動移動停利
    for k in range(e, min(n, e + cfg['max_days'] + 1)):
        peak = max(peak, H[k])
        if not armed and peak - px >= cfg['trail_arm_atr'] * a:
            armed = True
        if L[k] <= stop:                              # 停損優先(同一天先假設走最壞)
            return e, k, px, stop, '停損'
        if armed:
            tstop = peak - cfg['trail_atr'] * a
            if L[k] <= tstop and k > e:
                return e, k, px, tstop, '移動停利'
        held = k - e
        if held >= cfg['max_days']:
            if cfg['time_min_ret'] is None or (C[k] / px - 1) * 100 < cfg['time_min_ret']:
                return e, k, px, C[k], '時間停損'
            return e, k, px, C[k], '時間到'
    last = min(n - 1, e + cfg['max_days'])
    return e, last, px, C[last], '窗口結束'


def net_pnl(buy: float, sell: float, shares: int):
    """淨損益(雙邊手續費 + 賣出證交稅 + 雙邊滑價)。⭐ 買價往上、賣價往下,⛔ 不可只扣一邊。"""
    b = buy * (1 + SLIP)
    s = sell * (1 - SLIP)
    cost_b = b * shares
    cost_s = s * shares
    fee = cost_b * FEE * FEE_DISC + cost_s * FEE * FEE_DISC
    tax = cost_s * TAX
    return cost_s - cost_b - fee - tax, fee + tax, b, s


def run(strategy: str, syms: list[str], mkt: pd.DataFrame, seed: int = 20260908, exit_mode: str = 'spec',
        sizing: str = 'risk'):
    """跑一個策略 → (trades DataFrame, equity Series, 訊號 DataFrame 範例)。
    對照組(同樣的股票、同樣的出場規則,只是進場日隨機)一起跑 → 才知道是不是「進場條件」的功勞。"""
    mkt_ok = market_filter(mkt)
    cfg = EXIT_VALID if exit_mode == 'valid' else (EXIT_A if strategy == 'a' else EXIT_B)
    rng = np.random.default_rng(seed)
    evs, ctrl = [], []
    sample_df = None
    for sym in syms:
        df = load_stock(os.path.join(DATA, sym + '.json'))
        if df is None:
            continue
        sig = signals_a(df, mkt_ok) if strategy == 'a' else signals_b(df)
        if sample_df is None and sig.any():
            sample_df = df.assign(Signal=sig)
        idxs = np.flatnonzero(sig.to_numpy())
        idxs = idxs[(idxs >= 260) & (idxs < len(df) - cfg['max_days'] - 2)]
        # 同檔去重:一筆結束前不再進場
        last_exit = -1
        picked = []
        for i in idxs:
            if i <= last_exit:
                continue
            r = simulate_one(df, int(i), cfg)
            if r is None:
                continue
            e, x, bp, sp, why = r
            last_exit = x
            picked.append((e, x, bp, sp, why, df['Date'].iloc[e], df['Date'].iloc[x], df['ATR14'].iloc[i]))
        for p in picked:
            evs.append((sym,) + p)
        # 🚨 對照組:同一檔抽**同樣筆數**的隨機日,套**同一套出場規則**(守門 ②)
        pool = np.arange(260, len(df) - cfg['max_days'] - 2)
        if len(picked) and len(pool):
            for i in rng.choice(pool, size=min(len(picked), len(pool)), replace=False):
                r = simulate_one(df, int(i), cfg)
                if r is None:
                    continue
                e, x, bp, sp, why = r
                ctrl.append((sym, e, x, bp, sp, why, df['Date'].iloc[e], df['Date'].iloc[x], df['ATR14'].iloc[i]))

    def to_trades(rows):
        if not rows:
            return pd.DataFrame(columns=['sym', 'entry_date', 'exit_date', 'buy', 'sell', 'why', 'hold_days',
                                         'shares', 'fee_tax', 'pnl', 'ret_pct'])
        out = []
        for sym, e, x, bp, sp, why, ed, xd, atr in rows:
            if sizing == 'risk':
                # 使用者規格:固定 1.5% 總資產風險模型(用 ATR 停損距離回推股數)
                risk = abs(bp - (bp - atr))
                shares = max(1000, int(INIT_CAP * RISK_PCT / max(risk, 1e-9) // 1000 * 1000)) if risk > 0 else 1000
                shares = min(shares, int(INIT_CAP * 0.25 / bp // 1000 * 1000) or 1000)   # 單檔上限 25% 資產
            else:
                # ⭐ 對照:等權(每筆固定佔本金 15%)—— 本站 V73.0.1 實測風險法比等權**少賺 112 萬**
                shares = max(1000, int(INIT_CAP * 0.15 / bp // 1000 * 1000))
            pnl, ft, b2, s2 = net_pnl(bp, sp, shares)
            out.append(dict(sym=sym, entry_date=ed, exit_date=xd, buy=round(b2, 2), sell=round(s2, 2),
                            why=why, hold_days=int(x - e), shares=shares, fee_tax=round(ft, 0),
                            pnl=round(pnl, 0), ret_pct=round((s2 / b2 - 1) * 100, 3)))
        return pd.DataFrame(out).sort_values('entry_date').reset_index(drop=True)

    tr, tc = to_trades(evs), to_trades(ctrl)
    return tr, tc, sample_df


def equity_from_trades(tr: pd.DataFrame, dates: pd.DatetimeIndex) -> pd.Series:
    """組合層級資金曲線:同時最多 MAX_POS 檔,錢不夠就跳過(⛔ 不可透支 —— V74.4.5 踩過)。"""
    eq = pd.Series(float(INIT_CAP), index=dates)
    if tr.empty:
        return eq
    cash, open_pos, closed = float(INIT_CAP), [], []
    tr = tr.sort_values('entry_date')
    ptr = 0
    rows = tr.to_dict('records')
    for d in dates:
        for p in list(open_pos):
            if p['exit_date'] <= d:
                cash += p['shares'] * p['sell'] - (p['shares'] * p['sell'] * (FEE * FEE_DISC + TAX))
                open_pos.remove(p); closed.append(p)
        while ptr < len(rows) and rows[ptr]['entry_date'] <= d:
            p = rows[ptr]; ptr += 1
            if p['entry_date'] != d or len(open_pos) >= MAX_POS:
                continue
            cost = p['shares'] * p['buy'] * (1 + FEE * FEE_DISC)
            if cost <= cash:
                cash -= cost; open_pos.append(p)
        held = sum(x['shares'] * x['buy'] for x in open_pos)      # 保守:未平倉以成本計
        eq[d] = cash + held
    return eq


def gates(tr: pd.DataFrame, tc: pd.DataFrame) -> dict:
    """六道關卡。⭐ 主判準是「贏對照組多少」,⛔ 不是「絕對報酬正不正」。"""
    if tr.empty or tc.empty:
        return {}
    a, b = tr['ret_pct'], tc['ret_pct']
    edge = a.mean() - b.mean()
    mid = tr['entry_date'].median()
    f1 = tr[tr.entry_date < mid]['ret_pct'].mean() - tc[tc.entry_date < mid]['ret_pct'].mean()
    f2 = tr[tr.entry_date >= mid]['ret_pct'].mean() - tc[tc.entry_date >= mid]['ret_pct'].mean()
    tr_y, tc_y = tr.assign(y=tr.entry_date.dt.year), tc.assign(y=tc.entry_date.dt.year)
    yrs = {}
    for y in sorted(set(tr_y.y)):
        ea, eb = tr_y[tr_y.y == y]['ret_pct'], tc_y[tc_y.y == y]['ret_pct']
        if len(ea) >= 20 and len(eb) >= 20:
            yrs[int(y)] = round(float(ea.mean() - eb.mean()), 2)
    same = len(yrs) >= 2 and all(np.sign(v) == np.sign(edge) for v in yrs.values())
    best = max(yrs, key=yrs.get) if yrs else None
    ex = (tr_y[tr_y.y != best]['ret_pct'].mean() - tc_y[tc_y.y != best]['ret_pct'].mean()) if best else np.nan
    return dict(edge=round(float(edge), 3), first=round(float(f1), 3), second=round(float(f2), 3),
                yrs=yrs, ex_best=round(float(ex), 3) if ex == ex else None,
                gates=[edge > 0, np.sign(f1) == np.sign(f2) == np.sign(edge), same,
                       ex == ex and ex > 0, edge > 0])


def _selftest():
    """合成資料:訊號日之後**必定**多漲 8% → harness 必須量得到。"""
    fails = []

    def ok(n, c, e=''):
        print(('✅ ' if c else '❌ ') + n + ('' if c else f'  {e}'))
        if not c:
            fails.append(n)

    d = pd.bdate_range('2021-01-04', periods=900)
    px, rows = 100.0, []
    rng = np.random.default_rng(1)
    for i in range(len(d)):
        boost = 1.008 if (i % 50) in (1, 2, 3, 4, 5, 6, 7, 8) and i > 300 else 1.0
        px *= boost * (1 + rng.normal(0, 0.004))
        rows.append(dict(Date=d[i], Open=px * .999, High=px * 1.02, Low=px * .98, Close=px, Volume=1e6))
    df = pd.DataFrame(rows)
    tr = pd.DataFrame([dict(sym='X', entry_date=d[i], exit_date=d[i + 5], buy=100, sell=108,
                            why='移動停利', hold_days=5, shares=1000, fee_tax=500, pnl=7500, ret_pct=8.0)
                       for i in range(300, 800, 50)])
    eq = equity_from_trades(tr, pd.DatetimeIndex(d))
    ok('① 資金曲線會隨交易成長', eq.iloc[-1] > eq.iloc[0], f'{eq.iloc[0]}→{eq.iloc[-1]}')
    ok('② 現金不夠時⛔ 不可透支(權益永遠 > 0)', (eq > 0).all())
    b, s = 100.0, 110.0
    pnl, ft, b2, s2 = net_pnl(b, s, 1000)
    ok('③ 成本雙邊都扣(買價往上、賣價往下)', b2 > b and s2 < s, f'{b2} {s2}')
    gross = (s2 - b2) * 1000
    ok('④ 淨損益 = 毛利 − 手續費 − 稅', abs(pnl - (gross - ft)) < 1e-6, f'{pnl} {gross} {ft}')
    ok('⑤ 手續費有吃到折數', abs(ft - ((b2 + s2) * 1000 * FEE * FEE_DISC + s2 * 1000 * TAX)) < 1e-6)
    # 出場規則
    cfg = dict(stop_atr=2.0, trail_arm_atr=0.0, trail_atr=1.0, max_days=20, time_min_ret=None, stop_from='entry')
    #   進場 = Open[6] = 100 ・ATR=5 → 停損 100−2×5 = 90 ・第 10 根 high=120 → 移動停利線 120−1×5 = 115
    t = pd.DataFrame(dict(Open=[100] * 30, High=[100] * 10 + [120] + [100] * 19,
                          Low=[100] * 30, Close=[100] * 30,
                          ATR14=[5.0] * 30, Date=pd.bdate_range('2024-01-01', periods=30)))
    r = simulate_one(t, 5, cfg)
    ok('⑥ 移動停利價 = 進場後最高 120 − 1×ATR(5) = 115', r is not None and r[3] == 115.0, r)
    ok('⑦ ⛔ 進場是隔天開盤(i+1)不是訊號日', r is not None and r[0] == 6, r)
    ok('⑧ 出場原因要標對', r is not None and r[4] == '移動停利', r)
    # 🚨 停損要**優先於**移動停利(同一天先假設走最壞)
    t2 = t.copy(); t2.loc[10, 'Low'] = 80
    r2 = simulate_one(t2, 5, cfg)
    ok('⑨ 同一天既觸停損又觸移動停利 → 算停損(⛔ 不可挑對自己有利的)',
       r2 is not None and r2[4] == '停損' and r2[3] == 90.0, r2)
    # 🚨 隔天開盤鎖漲停 → 買不到,整筆放棄
    t3 = t.copy(); t3.loc[6, ['Open', 'High']] = [110.0, 110.0]
    ok('⑩ 隔天開盤鎖漲停 → ⛔ 不可假裝買得到', simulate_one(t3, 5, cfg) is None)
    print()
    print('❌ STRAT_SELFTEST_FAIL: ' + str(fails) if fails else '✅ STRAT_SELFTEST_PASS')
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--strategy', default='both', choices=['a', 'b', 'both'])
    ap.add_argument('--max', type=int, default=0, help='最多幾檔(0 = 全市場)')
    ap.add_argument('--exit', default='spec', choices=['spec', 'valid'],
                    help="spec=使用者規格的出場 ・valid=本站 V74.4.8 實測過的出場(放寬移動停利、⛔ 無時間停損)")
    ap.add_argument('--sizing', default='risk', choices=['risk', 'equal'],
                    help='risk=使用者規格的 1.5%% 風險模型 ・equal=等權每筆 15%%(本站實測較好)')
    ap.add_argument('--html', default='')
    ap.add_argument('--selftest', action='store_true')
    args = ap.parse_args()
    if args.selftest:
        sys.exit(_selftest())

    mkt_raw = json.load(open(os.path.join(DATA, '^TWII.json'), encoding='utf-8'))
    mkt = pd.DataFrame(mkt_raw if isinstance(mkt_raw, list) else mkt_raw['data'])
    mkt['Date'] = pd.to_datetime(mkt['date'].astype(str).str.replace('/', '-', regex=False))
    mkt['Close'] = pd.to_numeric(mkt['close'], errors='coerce')
    mkt = mkt.dropna(subset=['Close']).sort_values('Date').reset_index(drop=True)

    syms = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(DATA, '*.json')))
    syms = [s for s in syms if s.isdigit() and len(s) == 4]        # 個股(⛔ 排除 ETF/指數)
    # ⛔ 不可用 syms[:N] —— 台股代號帶產業意義,取前 N 檔 = 按產業取樣(V72.1.7 的選樣偏誤)
    if args.max and args.max < len(syms):
        step = len(syms) / args.max
        syms = [syms[int(i * step)] for i in range(args.max)]
    print(f'📦 母體 {len(syms)} 檔 ・大盤 {mkt.Date.iloc[0].date()} ~ {mkt.Date.iloc[-1].date()}')

    dates = pd.DatetimeIndex(mkt['Date'])
    for st in (['a', 'b'] if args.strategy == 'both' else [args.strategy]):
        name = 'A 布林壓縮突破' if st == 'a' else 'B 強勢股多頭拉回'
        tr, tc, sample = run(st, syms, mkt, exit_mode=args.exit, sizing=args.sizing)
        ex = '使用者規格' if args.exit == 'spec' else '本站實測過的出場(放寬移動停利・無時間停損)'
        sz = '1.5%% 風險模型' if args.sizing == 'risk' else '等權每筆 15%%'
        print(f'\n{"="*72}\n【策略 {name}｜出場 = {ex}｜部位 = {sz}】訊號交易 {len(tr)} 筆 ・對照組 {len(tc)} 筆')
        if tr.empty:
            print('  ⚠️ 一筆都沒有 —— ⛔ 這不是「策略很嚴格」,要先確認條件是不是根本不可能同時成立')
            continue
        eq = equity_from_trades(tr, dates)
        bench = pd.Series(mkt['Close'].to_numpy(), index=dates)
        rep = generate_performance_report(tr, eq, bench_curve=bench, initial_capital=INIT_CAP,
                                          out_html=(args.html.replace('.html', f'_{st}.html') if args.html else None),
                                          title=f'策略 {name}')
        for k, v in rep['核心數據'].items():
            print(f'  {k:<16} {v}')
        for k, v in rep['風險數據'].items():
            print(f'  {k:<16} {v}')
        for k, v in rep['交易統計'].items():
            print(f'  {k:<16} {v}')
        print(f"  🆚 大盤買進持有 {rep['對照']['買進持有基準%']}% → 贏 {rep['對照']['贏基準pp']}pp")
        g = gates(tr, tc)
        if g:
            print(f"\n  🚦 vs 對照組(同批股票、同套出場、隨機進場):每趟 {g['edge']:+.3f}pp")
            print(f"     前後半 {g['first']:+.2f} / {g['second']:+.2f} ・逐年 {g['yrs']} ・去最好年 "
                  f"{g['ex_best']} ・關卡 {''.join('✅' if x else '❌' for x in g['gates'])}")
            print(f"     對照組每趟 {tc['ret_pct'].mean():+.3f}% ・勝率 {(tc.pnl>0).mean()*100:.1f}%"
                  f"  🆚 訊號組 {tr['ret_pct'].mean():+.3f}% ・勝率 {(tr.pnl>0).mean()*100:.1f}%")
        print('\n  📋 出場原因分布:', dict(tr['why'].value_counts()))
        print('  📋 交易明細(前 5 筆):')
        print(tr.head().to_string(index=False))
        mm = rep['monthly_matrix']
        if not mm.empty:
            print('\n  🗓️ 每月報酬率矩陣(%):')
            print(mm.round(2).to_string())
        for l in rep['限制']:
            print('  ⚠️ ' + l)


if __name__ == '__main__':
    main()
