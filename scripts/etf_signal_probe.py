#!/usr/bin/env python3
"""🐢🏁 ETF 買賣訊號擂台(V77.5.7)

使用者:「回測 ETF 買賣,請告訴我要用什麼訊號買賣策略最強」。

⭐ 先查登記表 —— 大半早就測過,而且結論一致「擇時少賺」:
   `etf0050_probe`(一次買滿最多錢)・`hold_switch_probe`(跌破均線就賣 → 換手越多越少賺、單調)・
   `etf_switch_probe`(大跌換高彈性 ETF 的輪動不成立)・V75.0.8(空頭改抱 0050 三關全滅)。
   → 這支只測**真的還沒測過**的三類,並且把兩個舊缺陷一起補掉:
     A1 唐奇安/海龜突破(進場 + 出場)用在 ETF 上
     A2 絕對動能(過去 N 個月報酬 > 0 才持有,否則現金)
     B1/B2 跨 ETF 相對動能輪動(每月持有最強前 N 檔)/ 雙動能(再加「自己 12 個月 > 0」)
     🩹 舊缺陷 ①:以前的 ETF 數字**都不含配息**(高股息被系統性低估)→ 這支一律**含息**
     🩹 舊缺陷 ②:以前沒有「換起點」的多路徑檢定(V77.4.9 教訓)→ 12 條路徑配對

⛔ 不可簡化的設計(`--selftest` 釘住):
  ① **零前視**:訊號用 t 日收盤判斷,**t+1 開盤**成交(⛔ 不可用 t 日收盤成交)
  ② **含息規則跟 `lib_totalreturn.mjs` 一字不差**:除息日前一天收盤還抱著的人才領到;
     有持股就在除息日收盤再投入;股利要跟還原過分割的價格同尺(`before_price` 換算,對不上排除)
  ③ **成本**:手續費 0.1425% × 6 折(買賣都收)+ ETF 證交稅 0.1%(⛔ 不是股票的 0.3%)
  ④ **安慰劑**:輪動 = 每月隨機挑同樣 N 檔;擇時 = 同樣的「在市場月數比例」隨機進出
     (V77.3.3:少做一點本身就會改變結果,增量一律跟安慰劑比)
  ⑤ **斷崖守門**:相鄰兩根 ±40% 且間隔 ≤10 天 → 整檔排除(0052 / 00631L 那批壞資料)
  ⑥ 月度換倉在**每月第一個交易日開盤**(訊號在上個月最後一個交易日收盤)

⚠️ 限制(一律印在報告裡):窗口約 4.5 年(2022-03 起,要留 13 個月暖身),只含一次空頭;
   ETF 倖存者偏誤小但存在;槓桿/反向/債券/期貨型不在母體(資料壞或性質不同)。
⛔ 這支只回答「哪種訊號在 ETF 上贏不贏買了放著」,⛔ 不下買賣建議、⛔ 不改 App。

用法:DATA_DIR=<合併過 klines_deep 的目錄> DIV=<dividends_hist.json> NAMES=<stock_names.json> \
      python3 scripts/etf_signal_probe.py [out.json]
     python3 scripts/etf_signal_probe.py --selftest
"""
from __future__ import annotations

import json
import math
import os
import random
import re
import subprocess
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib_perf import generate_performance_report  # noqa: E402  ⛔ 報表只用這一份

FEE = 0.001425 * 0.6
TAX = 0.001
START = os.environ.get('START') or '2022-03-01'
ETF_RE = re.compile(r'^00\d{2,4}$')
M = 21   # 一個月 ≈ 21 個交易日


# ═══ 含息工具(⛔ 規則跟 scripts/lib_totalreturn.mjs 一字不差;selftest ⑦ 跨語言對表)═══
def num(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def d10(s):
    return str(s or '').replace('/', '-')[:10]


def scale_for(before, close_on):
    """股利尺標對齊:回 (k, why);k=None → 排除(⛔ 說不出來的一律不硬算)。"""
    if not (before and before > 0) or not (close_on and close_on > 0):
        return 1, 'no-before'
    ratio = close_on / before
    if 0.9 < ratio < 1.1:
        return 1, 'same'
    for m in (2, 3, 4, 5, 6, 8, 10):
        if abs(ratio - 1 / m) / (1 / m) < 0.08:
            return 1 / m, f'split1:{m}'
        if abs(ratio - m) / m < 0.08:
            return m, f'merge{m}:1'
    return None, f'ratio={ratio:.3f}'


def load_bars(ddir, sym):
    p = os.path.join(ddir, f'{sym}.json')
    try:
        rows = json.load(open(p, encoding='utf-8'))
    except Exception:
        return None
    out = []
    for r in rows if isinstance(rows, list) else []:
        c = num(r.get('close'))
        if not (c and c > 0):
            continue
        o = num(r.get('open')) or c
        h = num(r.get('high')) or c
        lo = num(r.get('low')) or c
        out.append({'d': d10(r.get('date')), 'o': o, 'h': h, 'l': lo, 'c': c})
    out.sort(key=lambda b: b['d'])
    return out or None


def tail_segment(bars, gap_days=40):
    """只取最後一段連續資料(⛔ 2017 孤兒段 → 2023 那種洞不可跨過去算)。"""
    k = 0
    for i in range(1, len(bars)):
        g = (pd.Timestamp(bars[i]['d']) - pd.Timestamp(bars[i - 1]['d'])).days
        if g > gap_days:
            k = i
    return bars[k:]


def has_cliff(bars):
    """相鄰兩根 ±40% 且間隔 ≤10 天 = 物理上不可能的尺標斷層(⛔ 隔很久的洞不算)。"""
    for i in range(1, len(bars)):
        r = bars[i]['c'] / bars[i - 1]['c']
        g = (pd.Timestamp(bars[i]['d']) - pd.Timestamp(bars[i - 1]['d'])).days
        if (r > 1.4 or r < 0.6) and g <= 10:
            return True
    return False


# ═══ 對齊到主日曆 ═══
class Panel:
    """所有 ETF 對齊到同一條交易日曆;沒上市的日子是 nan(⛔ 不可 ffill 成「有價」)。"""

    def __init__(self, dates, series, divs):
        self.dates = dates
        self.idx = {d: i for i, d in enumerate(dates)}
        self.syms = list(series)
        n = len(dates)
        self.o, self.h, self.l, self.c, self.dv = {}, {}, {}, {}, {}
        self.first = {}
        for s, bars in series.items():
            o = np.full(n, np.nan); h = o.copy(); lo = o.copy(); c = o.copy()
            for b in bars:
                i = self.idx.get(b['d'])
                if i is None:
                    continue
                o[i], h[i], lo[i], c[i] = b['o'], b['h'], b['l'], b['c']
            # 上市後的停牌/缺漏日:價格沿用前一天(⛔ 上市前維持 nan)
            first = int(np.argmax(~np.isnan(c))) if (~np.isnan(c)).any() else n
            for arr in (o, h, lo, c):
                for i in range(first + 1, n):
                    if np.isnan(arr[i]):
                        arr[i] = c[i - 1] if not np.isnan(c[i - 1]) else arr[i - 1]
            self.o[s], self.h[s], self.l[s], self.c[s] = o, h, lo, c
            self.first[s] = first
            d = np.zeros(n)
            for dt, amt, typ, before, *_ in (divs.get(s) or []):
                if typ == '權':
                    continue
                cash = num(amt)
                if not (cash and cash > 0):
                    continue
                i = self.idx.get(d10(dt))
                if i is None or np.isnan(c[i]):
                    continue
                k, _why = scale_for(num(before), c[i])
                if k is None:
                    continue
                d[i] += cash * k
            self.dv[s] = d

    def month_end(self, i):
        return i + 1 < len(self.dates) and self.dates[i][:7] != self.dates[i + 1][:7]


# ═══ 模擬器(唯一一份)═══
def simulate(P, start_i, end_i, decide, slots=1, cost=True):
    """decide(i, held) → None(不動)或 目標代號 list(在 i 收盤決定,i+1 開盤執行)。
    slots = 每檔目標佔權益 1/slots(輪動 N 檔;單檔擇時 = 1)。
    回:{eq: pd.Series, exposure: 平均曝險比例, trades: 交易次數}"""
    fee = FEE if cost else 0.0
    tax = TAX if cost else 0.0
    cash, sh = 1.0, {}
    pending = decide(start_i - 1, dict(sh))
    eq, expo, trades = [], [], 0
    for i in range(start_i, end_i + 1):
        # ① 除息:前一天收盤還抱著的人才領得到(開盤前就確定)
        divcash = {s: n * P.dv[s][i] for s, n in sh.items() if P.dv[s][i] > 0}
        # ② 開盤執行昨天收盤的決定
        if pending is not None:
            tgt = [s for s in pending if not np.isnan(P.o[s][i])]
            for s in list(sh):
                if s not in tgt:
                    cash += sh.pop(s) * P.o[s][i] * (1 - fee - tax)
                    trades += 1
            new = [s for s in tgt if s not in sh]
            if new:
                equity = cash + sum(n * P.o[s][i] for s, n in sh.items())
                per = equity / slots
                for s in new:
                    amt = min(per, cash)
                    if amt <= 1e-12:
                        continue
                    sh[s] = amt * (1 - fee) / P.o[s][i]
                    cash -= amt
                    trades += 1
        # ③ 股利:還抱著 → 收盤再投入;已賣掉 → 進現金
        for s, dc in divcash.items():
            if s in sh:
                sh[s] += dc / P.c[s][i]
            else:
                cash += dc
        val = sum(n * P.c[s][i] for s, n in sh.items())
        eq.append(cash + val)
        expo.append(val / (cash + val) if cash + val > 0 else 0)
        pending = decide(i, dict(sh)) if i < end_i else None
    return {'eq': pd.Series(eq, index=pd.to_datetime(P.dates[start_i:end_i + 1])),
            'exposure': float(np.mean(expo)), 'trades': trades}


# ═══ 策略(全部只用 ≤ i 的資料)═══
def s_hold(P, sym):
    return lambda i, held: [sym] if not held else None


def s_ma(P, sym, n):
    c = P.c[sym]

    def f(i, held):
        if i - n + 1 < P.first[sym]:
            return []
        return [sym] if c[i] > np.mean(c[i - n + 1:i + 1]) else []
    return f


def s_don(P, sym, en, ex):
    c, h, lo = P.c[sym], P.h[sym], P.l[sym]

    def f(i, held):
        if i - en < P.first[sym]:
            return []
        if held:
            return [] if c[i] < np.min(lo[i - ex:i]) else None     # ⛔ 基準不含今天(陷阱 #43)
        return [sym] if c[i] > np.max(h[i - en:i]) else None
    return f


def s_mkt(P, sym, n=200, mkt='0050'):
    """大盤濾網:0050 收盤站上自己的 n 日線才持有 sym(⛔ 暖身不足 = 空手)。"""
    mc = P.c[mkt]

    def f(i, held):
        if i - (n - 1) < P.first[mkt]:
            return []
        return [sym] if mc[i] > np.mean(mc[i - n + 1:i + 1]) else []
    return f


def s_mkt200(P, sym, mkt='0050'):
    return s_mkt(P, sym, 200, mkt)


def s_absmom(P, sym, months):
    c, L = P.c[sym], months * M

    def f(i, held):
        if not P.month_end(i) and held is not None and i >= 0 and f.inited:
            return None
        f.inited = True
        if i - L < P.first[sym]:
            return []
        return [sym] if c[i] / c[i - L] - 1 > 0 else []
    f.inited = False
    return f


def s_rot(P, uni, months, n, dual=False, rng=None):
    """每月最後一個交易日收盤排名 → 下個月第一天開盤換倉。
    分數 = 略過最近 1 個月的 N 個月報酬(skip-month momentum)。rng ≠ None → 安慰劑隨機挑。"""
    L = months * M

    def f(i, held):
        if f.inited and not P.month_end(i):
            return None
        f.inited = True
        elig = [s for s in uni if i - M - L >= P.first[s] and i - 12 * M >= P.first[s]]
        if rng is not None:
            pick = rng.sample(elig, min(n, len(elig)))
        else:
            sc = sorted(elig, key=lambda s: P.c[s][i - M] / P.c[s][i - M - L], reverse=True)
            pick = sc[:n]
        if dual:
            pick = [s for s in pick if P.c[s][i] / P.c[s][i - 12 * M] - 1 > 0]
        return pick
    f.inited = False
    return f


def s_sham_timing(P, sym, frac, rng):
    """擇時安慰劑:每月以同樣比例隨機決定在不在市場。"""
    def f(i, held):
        if f.inited and not P.month_end(i):
            return None
        f.inited = True
        return [sym] if rng.random() < frac else []
    f.inited = False
    return f


# ═══ 量測 ═══
def cagr(eq):
    yrs = (eq.index[-1] - eq.index[0]).days / 365.25
    return (eq.iloc[-1] / eq.iloc[0]) ** (1 / yrs) - 1 if yrs > 0 else float('nan')


def mdd(eq):
    return float((eq / eq.cummax() - 1).min())


def yearly(eq):
    out = {}
    for y, s in eq.groupby(eq.index.year):
        prev = eq[eq.index < s.index[0]]
        base = prev.iloc[-1] if len(prev) else s.iloc[0]
        out[int(y)] = s.iloc[-1] / base - 1
    return out


def halves(eq):
    m = len(eq) // 2
    return eq.iloc[m] / eq.iloc[0] - 1, eq.iloc[-1] / eq.iloc[m] - 1


def gates(st, bh, sham_eqs, st_gross):
    """六關:①毛報酬勝 ②前後半都勝 ③逐年都勝 ④拿掉最好一年仍勝 ⑤扣成本仍勝 ⑥勝過安慰劑平均"""
    g1 = cagr(st_gross) > cagr(bh)
    h_s, h_b = halves(st), halves(bh)
    g2 = h_s[0] > h_b[0] and h_s[1] > h_b[1]
    ys, yb = yearly(st), yearly(bh)
    diff = {y: ys[y] - yb[y] for y in ys if y in yb}
    g3 = bool(diff) and all(v > 0 for v in diff.values())
    if diff:
        best = max(diff, key=diff.get)
        rest = [v for y, v in diff.items() if y != best]
        g4 = bool(rest) and sum(rest) > 0
    else:
        g4 = False
    g5 = cagr(st) > cagr(bh)
    sham_c = [cagr(e) for e in sham_eqs] if sham_eqs else []
    g6 = bool(sham_c) and cagr(st) > float(np.mean(sham_c))
    return [g1, g2, g3, g4, g5, g6], diff


# ═══ 主程式 ═══
def build_panel(ddir, divpath, uni_cut='2021-02-28'):
    DV = json.load(open(divpath, encoding='utf-8'))
    D = DV.get('d', DV)
    base = load_bars(ddir, '0050')
    dates = [b['d'] for b in base]
    series, excluded = {}, []
    for fn in sorted(os.listdir(ddir)):
        sym = fn[:-5]
        if not fn.endswith('.json') or not ETF_RE.match(sym):
            continue
        bars = load_bars(ddir, sym)
        if not bars:
            continue
        bars = tail_segment(bars)
        if bars[0]['d'] > uni_cut or bars[-1]['d'] < dates[-1][:8] + '01':
            continue
        if has_cliff(bars):
            excluded.append(sym)
            continue
        series[sym] = bars
    divs = {s: (D.get(s) or {}).get('h') or [] for s in series}
    return Panel(dates, series, divs), excluded, DV


def cat_of(name):
    if re.search(r'高息|高股息|股利|優息|息|收益', name):
        return '高股息'
    if re.search(r'美|歐|日|中國|中證|恒生|全球|亞|印度|越南|S&P|標普|NASDAQ|那斯達克|費城|滬|深|上証|A50|韓', name):
        return '海外'
    if re.search(r'半導體|科技|5G|電動|AI|電子|網通|雲端|IC|晶片|資訊', name):
        return '科技主題'
    return '市值/其他'


def main(argv):
    ddir = os.environ.get('DATA_DIR', 'data')
    divp = os.environ.get('DIV') or os.path.join(ddir, 'dividends_hist.json')
    namep = os.environ.get('NAMES') or os.path.join(ddir, 'stock_names.json')
    out_json = next((a for a in argv if a.endswith('.json')), None)
    P, excluded, DV = build_panel(ddir, divp)
    try:
        NM = json.load(open(namep, encoding='utf-8')).get('names', {})
    except Exception:
        NM = {}
    name = lambda s: (NM.get(s) or [s])[0]
    uni = sorted(P.syms)
    si = next(i for i, d in enumerate(P.dates) if d >= START)
    ei = len(P.dates) - 1
    print(f'🐢🏁 ETF 買賣訊號擂台 —— 母體 {len(uni)} 檔(2021-02 前上市的股票型 ETF)'
          f' ・🚧 斷崖排除 {len(excluded)} 檔 {excluded}')
    print(f'   窗口 {P.dates[si]} ~ {P.dates[ei]}({ei - si + 1} 個交易日)・含息(股利檔 {DV.get("from")} 起)'
          f' ・成本 手續費 {FEE*100:.4f}%×2 + 證交稅 {TAX*100:.1f}% ・t+1 開盤成交\n')
    res = {'window': [P.dates[si], P.dates[ei]], 'uni': uni, 'excluded': excluded}

    # ── A:單檔擇時(每一檔跟「同一檔買了放著」比)──
    A_STRATS = {
        'A1 唐奇安20進/10出': lambda s: s_don(P, s, 20, 10),
        'A1 唐奇安55進/20出': lambda s: s_don(P, s, 55, 20),
        'A1 唐奇安40進/15出': lambda s: s_don(P, s, 40, 15),
        'A1 唐奇安70進/25出': lambda s: s_don(P, s, 70, 25),
        'A2 絕對動能 6個月': lambda s: s_absmom(P, s, 6),
        'A2 絕對動能 9個月': lambda s: s_absmom(P, s, 9),
        'A2 絕對動能 12個月': lambda s: s_absmom(P, s, 12),
        'A3 0050站上200日線才持有': lambda s: s_mkt200(P, s),
        'A4 站上60日線': lambda s: s_ma(P, s, 60),
        'A4 站上120日線': lambda s: s_ma(P, s, 120),
        'A4 站上240日線': lambda s: s_ma(P, s, 240),
    }
    bh = {s: simulate(P, si, ei, s_hold(P, s)) for s in uni}
    rowsA = []
    print('【A 單檔擇時】每一檔跟「同一檔買了放著(含息)」比 —— 年化差 = 策略 − 買了放著')
    print(f'{"策略":<20} 贏的檔數   年化差中位  2022差中位  曝險中位  換手中位  六關(全市場中位)')
    for nm, mk in A_STRATS.items():
        dC, d22, ex, tr, win = [], [], [], [], 0
        gcount = np.zeros(6)
        for s in uni:
            r = simulate(P, si, ei, mk(s))
            rg = simulate(P, si, ei, mk(s), cost=False)
            frac = r['exposure']
            rng = random.Random(hash((s, nm)) & 0xffff)
            shams = [simulate(P, si, ei, s_sham_timing(P, s, frac, rng))['eq'] for _ in range(5)]
            g, diff = gates(r['eq'], bh[s]['eq'], shams, rg['eq'])
            gcount += np.array(g, dtype=float)
            dc = cagr(r['eq']) - cagr(bh[s]['eq'])
            dC.append(dc); win += dc > 0
            d22.append(diff.get(2022, np.nan)); ex.append(frac); tr.append(r['trades'])
        row = {'k': nm, 'win': win, 'n': len(uni), 'dcagr_med': float(np.median(dC)),
               'd2022_med': float(np.nanmedian(d22)), 'expo_med': float(np.median(ex)),
               'trades_med': float(np.median(tr)), 'gate_rate': (gcount / len(uni)).round(2).tolist()}
        rowsA.append(row)
        print(f'{nm:<20} {win:>3}/{len(uni):<4} {row["dcagr_med"]*100:>+9.2f}pp {row["d2022_med"]*100:>+9.2f}pp'
              f' {row["expo_med"]*100:>7.0f}% {row["trades_med"]:>7.0f}   '
              + ' '.join(f'{x*100:.0f}%' for x in row['gate_rate']))
    res['A'] = rowsA

    # A 的 0050 專表(用 lib_perf 出報表數字)
    print('\n【A-0050】只看 0050(本金 100 萬試算,含息、已扣成本)')
    bh50 = generate_performance_report(None, bh['0050']['eq'])
    base_final = bh['0050']['eq'].iloc[-1]
    print(f'   買了放著:年化 {bh50["核心數據"]["年化報酬率CAGR%"]:+.2f}% ・最大回撤 {bh50["風險數據"]["最大回撤%"]:.1f}%'
          f' ・100 萬 → {base_final*1e6:,.0f}')
    res['A0050'] = [{'k': 'A0 買了放著', 'cagr': bh50['核心數據']['年化報酬率CAGR%'],
                     'mdd': bh50['風險數據']['最大回撤%'], 'final': base_final * 1e6, 'y2022': yearly(bh['0050']['eq']).get(2022)}]
    for nm, mk in A_STRATS.items():
        r = simulate(P, si, ei, mk('0050'))
        rep = generate_performance_report(None, r['eq'])
        y22 = yearly(r['eq']).get(2022)
        print(f'   {nm:<20} 年化 {rep["核心數據"]["年化報酬率CAGR%"]:+6.2f}% ・回撤 {rep["風險數據"]["最大回撤%"]:6.1f}%'
              f' ・2022 {y22*100:+6.1f}% ・曝險 {r["exposure"]*100:3.0f}% ・換手 {r["trades"]:3d}'
              f' ・100 萬 → {r["eq"].iloc[-1]*1e6:>10,.0f}(vs 買放 {(r["eq"].iloc[-1]-base_final)*1e6:+,.0f})')
        res['A0050'].append({'k': nm, 'cagr': rep['核心數據']['年化報酬率CAGR%'], 'mdd': rep['風險數據']['最大回撤%'],
                             'final': r['eq'].iloc[-1] * 1e6, 'y2022': y22, 'expo': r['exposure'], 'trades': r['trades']})

    # ── A3 追查:唯一中位數為正的那列,要先過「高原 + 換起點」才算數 ──
    # ⚠️ 起點從 2022-01(空頭開始之前)每月挪一次 —— 從 2022-03 起跑的話,策略一開場就在場外,天生佔便宜
    print('\n【A3 追查】0050 站上 n 日線才持有(用在 0050 自己身上)—— 高原 × 12 條起點(2022-01 ~ 2022-12)')
    print(f'{"n 日線":<8} {"全窗口年化差":>12} {"逐年差(策略−買放)":<46} {"12路徑勝場":>10} {"路徑差中位":>10}')
    rowsA3 = []
    for n in (150, 175, 200, 225, 250):
        r = simulate(P, si, ei, s_mkt(P, '0050', n))
        diff = {y: v - yearly(bh['0050']['eq']).get(y, np.nan) for y, v in yearly(r['eq']).items()}
        pw, pdiff = 0, []
        for k in range(12):
            sk = next(i for i, d in enumerate(P.dates)
                      if d >= (pd.Timestamp('2022-01-17') + pd.DateOffset(months=k)).strftime('%Y-%m-%d'))
            a = simulate(P, sk, ei, s_mkt(P, '0050', n))['eq']
            b = simulate(P, sk, ei, s_hold(P, '0050'))['eq']
            ca, cb = cagr(a), cagr(b)
            pw += ca > cb; pdiff.append(ca - cb)
        dc = cagr(r['eq']) - cagr(bh['0050']['eq'])
        rowsA3.append({'n': n, 'dcagr': dc, 'yearly_diff': diff, 'paths_win': int(pw),
                       'paths_dcagr_med': float(np.median(pdiff)), 'mdd': mdd(r['eq'])})
        print(f'{n:>5} 日  {dc*100:>+10.2f}pp  ' + ' '.join(f'{y}:{v*100:+5.1f}' for y, v in sorted(diff.items()))
              + f'  {pw:>6}/12  {np.median(pdiff)*100:>+8.2f}pp')
    res['A3_check'] = rowsA3

    # ── B:跨 ETF 輪動(跟 0050 買了放著 與 等權買了放著 比)──
    print('\n【B 跨 ETF 輪動】每月最後一個交易日收盤排名 → 下月第一天開盤換倉(略過最近 1 個月)')

    def ew_hold():
        # 等權買了放著:一開始把全部母體等權買進,之後不動
        live = [s for s in uni if P.first[s] <= si - 1]
        return lambda i, held: live if not held else None, len(live)

    ewf, ewn = ew_hold()
    ew = simulate(P, si, ei, ewf, slots=ewn)
    ref = bh['0050']['eq']
    print(f'   對照:0050 買了放著 年化 {cagr(ref)*100:+.2f}% ・回撤 {mdd(ref)*100:.1f}%'
          f' ・等權 {ewn} 檔買了放著 年化 {cagr(ew["eq"])*100:+.2f}% ・回撤 {mdd(ew["eq"])*100:.1f}%')
    rowsB = []
    print(f'{"策略":<22} 年化    回撤    2022    曝險  換手   vs0050年化  vs安慰劑  12路徑勝0050  六關')
    grid = {}
    for dual in (False, True):
        for L in (3, 6, 12):
            for n in (1, 3, 5):
                nm = f'{"B2 雙動能" if dual else "B1 相對動能"} {L}月 前{n}'
                r = simulate(P, si, ei, s_rot(P, uni, L, n, dual), slots=n)
                rg = simulate(P, si, ei, s_rot(P, uni, L, n, dual), slots=n, cost=False)
                shams = [simulate(P, si, ei, s_rot(P, uni, L, n, dual, rng=random.Random(k)), slots=n)['eq']
                         for k in range(20)]
                g, diff = gates(r['eq'], ref, shams, rg['eq'])
                sham_c = float(np.mean([cagr(e) for e in shams]))
                # 12 條路徑:起點每次往後挪 1 個月
                pw = 0
                for k in range(12):
                    sk = next(i for i, d in enumerate(P.dates) if d >= (pd.Timestamp(START) + pd.DateOffset(months=k)).strftime('%Y-%m-%d'))
                    a = simulate(P, sk, ei, s_rot(P, uni, L, n, dual), slots=n)['eq']
                    b = simulate(P, sk, ei, s_hold(P, '0050'))['eq']
                    pw += a.iloc[-1] / a.iloc[0] > b.iloc[-1] / b.iloc[0]
                y22 = yearly(r['eq']).get(2022)
                row = {'k': nm, 'L': L, 'n': n, 'dual': dual, 'cagr': cagr(r['eq']), 'mdd': mdd(r['eq']),
                       'y2022': y22, 'expo': r['exposure'], 'trades': r['trades'],
                       'vs0050': cagr(r['eq']) - cagr(ref), 'vs_sham': cagr(r['eq']) - sham_c,
                       'paths_win': int(pw), 'gates': [bool(x) for x in g], 'final': r['eq'].iloc[-1] * 1e6}
                rowsB.append(row)
                grid[(dual, L, n)] = row['vs0050']
                print(f'{nm:<22} {row["cagr"]*100:+6.2f}% {row["mdd"]*100:6.1f}% {y22*100:+6.1f}% {row["expo"]*100:4.0f}%'
                      f' {r["trades"]:4d}   {row["vs0050"]*100:+7.2f}pp  {row["vs_sham"]*100:+6.2f}pp   {pw:>2}/12'
                      f'    {sum(g)}/6')
    res['B'] = rowsB
    res['B_ref'] = {'0050': {'cagr': cagr(ref), 'mdd': mdd(ref), 'final': ref.iloc[-1] * 1e6},
                    'ew': {'n': ewn, 'cagr': cagr(ew['eq']), 'mdd': mdd(ew['eq']), 'final': ew['eq'].iloc[-1] * 1e6}}
    print('\n⛰️ 高原(vs 0050 年化 pp,列 = 回看月數,欄 = 前 N 檔)')
    for dual in (False, True):
        print('  ' + ('B2 雙動能' if dual else 'B1 相對動能'))
        for L in (3, 6, 12):
            print(f'    {L:>2} 月  ' + '  '.join(f'{grid[(dual, L, n)]*100:+6.2f}' for n in (1, 3, 5)))

    # 各檔買了放著的年化(含息)排行 —— 當背景
    print('\n📋 背景:各檔「買了放著」含息年化(前 10 / 後 5)')
    rk = sorted(uni, key=lambda s: cagr(bh[s]['eq']), reverse=True)
    for s in rk[:10] + ['…'] + rk[-5:]:
        if s == '…':
            print('   …'); continue
        e = bh[s]['eq']
        print(f'   {s:<7} {name(s)[:10]:<10} {cat_of(name(s)):<6} 年化 {cagr(e)*100:+6.2f}% ・回撤 {mdd(e)*100:6.1f}%'
              f' ・2022 {yearly(e).get(2022, float("nan"))*100:+6.1f}%')
    res['bh_rank'] = [{'s': s, 'name': name(s), 'cat': cat_of(name(s)), 'cagr': cagr(bh[s]['eq']),
                       'mdd': mdd(bh[s]['eq'])} for s in rk]

    print('\n⚠️ 限制:窗口約 4.5 年只含一次空頭(2022-03 起;要留 13 個月暖身給 12 個月動能)・ETF 倖存者偏誤小但存在'
          ' ・槓桿/反向/債券/期貨型不在母體 ・股利以除息日收盤再投入、⛔ 沒扣二代健保與所得稅')
    print('⛔ 這是「哪種訊號在 ETF 上贏不贏買了放著」的事實,⛔ 不是買賣建議')
    if out_json:
        json.dump(res, open(out_json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=float)
        print(f'💾 {out_json}')
    return 0


# ═══ 自我驗證 ═══
def _synth(prices, start='2022-01-03', opens=None, divs=None, sym='T'):
    dates = list(pd.bdate_range(start, periods=len(prices)).strftime('%Y-%m-%d'))
    bars = [{'d': d, 'o': (opens[i] if opens else p), 'h': p, 'l': p, 'c': p} for i, (d, p) in enumerate(zip(dates, prices))]
    return Panel(dates, {sym: bars}, {sym: divs or []}), dates


def selftest():
    bad = 0

    def ok(nm, cond, got=None):
        nonlocal bad
        bad += (not cond)
        print(('✅ ' if cond else '❌ ') + nm + ('' if cond else f'  → {got}'))

    # ① 零前視:第 5 天收盤出訊號,第 6 天開盤跳空 +10% —— 進場價必須是第 6 天開盤(吃不到跳空)
    pr = [100] * 5 + [110] * 5
    op = [100] * 5 + [110] * 5
    P, _ = _synth(pr, opens=op)
    dec = lambda i, held: ['T'] if i == 4 and not held else None
    r = simulate(P, 0, 9, dec, cost=False)
    ok('① 訊號在 t 收盤、t+1 開盤成交(吃不到跳空)', abs(r['eq'].iloc[-1] - 1.0) < 1e-9, r['eq'].iloc[-1])

    # ② 含息:除息日前一天抱著才領;除息日開盤才買的領不到
    pr = [100.0] * 10
    P, dates = _synth(pr, divs=[[None, 5, '息', 100, 95]])
    P.dv['T'][:] = 0; P.dv['T'][5] = 5.0
    held_all = simulate(P, 0, 9, lambda i, h: ['T'] if not h else None, cost=False)
    ok('② 前一天收盤抱著 → 領到股利並再投入', abs(held_all['eq'].iloc[-1] - 1.05) < 1e-9, held_all['eq'].iloc[-1])
    late = simulate(P, 0, 9, lambda i, h: ['T'] if i == 4 and not h else None, cost=False)
    ok('②b 除息日當天開盤才買 → 領不到', abs(late['eq'].iloc[-1] - 1.0) < 1e-9, late['eq'].iloc[-1])

    # ③ 成本:買一次賣一次 = (1−fee)(1−fee−tax)
    P, _ = _synth([100.0] * 6)
    rt = simulate(P, 0, 5, lambda i, h: (['T'] if i == 0 else ([] if i == 2 else None)))
    want = (1 - FEE) * (1 - FEE - TAX)
    ok('③ 來回成本有扣(手續費×2 + ETF 證交稅)', abs(rt['eq'].iloc[-1] - want) < 1e-12, (rt['eq'].iloc[-1], want))

    # ④ 安慰劑挑的檔數 = N
    dates = list(pd.bdate_range('2020-01-01', periods=400).strftime('%Y-%m-%d'))
    ser = {f'S{k}': [{'d': d, 'o': 100 + k, 'h': 100 + k, 'l': 100 + k, 'c': 100 + k} for d in dates] for k in range(8)}
    P = Panel(dates, ser, {})
    f = s_rot(P, list(ser), 3, 3, rng=random.Random(1))
    pick = f(390, {})
    ok('④ 安慰劑每次挑剛好 N 檔、不重複', len(pick) == 3 and len(set(pick)) == 3, pick)

    # ⑤ 斷崖:3 天內 ×2 → 排除;隔 400 天的洞 → tail 只取後段、不算斷崖
    b1 = [{'d': '2022-01-03', 'c': 100}, {'d': '2022-01-04', 'c': 200}]
    ok('⑤ 相鄰 ×2(≤10 天)= 斷崖', has_cliff(b1))
    b2 = [{'d': '2017-01-03', 'c': 20}, {'d': '2023-06-12', 'c': 60}, {'d': '2023-06-13', 'c': 61}]
    ok('⑤b 隔五年的洞 → tail 只留後段且不算斷崖', len(tail_segment(b2)) == 2 and not has_cliff(tail_segment(b2)))

    # ⑥ 月度換倉在「下個月第一個交易日開盤」
    dates = list(pd.bdate_range('2022-01-03', periods=60).strftime('%Y-%m-%d'))
    ser = {'A': [{'d': d, 'o': 100 + i, 'h': 100 + i, 'l': 100 + i, 'c': 100 + i} for i, d in enumerate(dates)]}
    P = Panel(dates, ser, {})
    ends = [i for i in range(len(dates)) if P.month_end(i)]
    ok('⑥ 月底判定 = 下一個交易日是新的月份', all(dates[i][:7] != dates[i + 1][:7] for i in ends) and len(ends) >= 2, ends)
    calls = []
    f = s_absmom(P, 'A', 1)
    for i in range(len(dates)):
        if f(i, {'A': 1}) is not None:
            calls.append(i)
    ok('⑥b 絕對動能只在月底(與第一次)做決定', calls[1:] == ends[:len(calls) - 1], (calls, ends))

    # ⑦ 股利尺標規則跟 JS 版一字不差(有 node 才跑)
    try:
        js = ("import {scaleFor} from './scripts/lib_totalreturn.mjs';"
              "const r=[[100,100],[100,25],[100,26.5],[100,400],[100,170],[0,50],[100,33.4]];"
              "console.log(JSON.stringify(r.map(([b,c])=>scaleFor(b,c).k)));")
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
        out = subprocess.run(['node', '--input-type=module', '-e', js], cwd=root, capture_output=True, text=True, timeout=30)
        jk = json.loads(out.stdout.strip())
        pk = [scale_for(b, c)[0] for b, c in [(100, 100), (100, 25), (100, 26.5), (100, 400), (100, 170), (0, 50), (100, 33.4)]]
        ok('⑦ scale_for 跟 lib_totalreturn.mjs 逐格相同', [None if x is None else round(x, 9) for x in jk] ==
           [None if x is None else round(x, 9) for x in pk], (jk, pk))
    except FileNotFoundError:
        print('⏭️ ⑦ 沒有 node,跳過跨語言對表')

    print('\n' + ('✅ ETF_SIGNAL_SELFTEST_PASS' if not bad else f'❌ ETF_SIGNAL_SELFTEST_FAIL {bad} 條'))
    return 1 if bad else 0


if __name__ == '__main__':
    a = sys.argv[1:]
    sys.exit(selftest() if '--selftest' in a else main(a))
