#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📊 short_cover_probe.py —— 融券強制回補:停止融券賣出(股東會 / 除權息前)那幾天前後,融券多的股票漲跌(V80.1.7,計畫 B2)

使用者(2026-11-01):「早知道先機」→ 換一個問題:**誰被規則逼著一定要買,時間事先公開**。
股東會、除權息之前,證交所規定融券要在最後回補日前買回來 → 融券很多的股票,那幾天會有人「一定要買」。
外部研究(2000~2019,Airiti)說回補日前 10 天有正報酬、之後反轉 —— 這支用本站 16 年資料重測。

事件:stock_deep/ssusp(FinMind TaiwanStockMarginShortSaleSuspension,2015-04 起,每一列 = 一段停止融券賣出 date ~ end_date + 原因)
  事件日 C = 停券開始日那天(或之後第一個交易日)。⚠️ 確切的「最後回補日」跟停券開始日差 1~2 個營業日(依當年規則),
  所以窗口拉寬:前 10 天(C−10 開盤買 → C−1 收盤賣)・C 那天起 5 / 10 天 ・之後 20 天。
融券多寡(停券前第 11 個交易日、⛔ 用窗口裡的):融券餘額(張)× 1000 ÷ 發行股數(%)、券資比(融券 ÷ 融資)。
對照組(兩個,都是同一天、同一個窗口):
  ① 全部股票平均
  ② ⭐ 同樣「融券很多」但前後 30 天沒有停券的股票 —— 分開「融券多本身」跟「被逼著回補」(⛔ 只比 ① 會把軋空題材算成回補效應)
安慰劑:同一批事件股、整個時間軸往前挪 60 個交易日(那時候沒有停券)。
鎖漲跌停買不到(lib_limit.locked_bar)、價格斷崖(lib_limit.cliff_in)的窗口剔除;股利照 _div16 補回。

資料:SSUSP_DIR(stock_deep/ssusp 解開)・DATA_DIR(d16m_fi:K 線 + short_balance / margin_balance)・SHARE_DIR(stock_deep/share)
--selftest:事件解析、事件日、窗口、注入效果量得到、決定性對照(融券多本身就會漲 → 比 ② ≈ 0)。
"""
import gzip
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib_limit as LL                                                         # noqa: E402
from window_dress_probe import load_shares, shares_on, div_factor, mean, tstat  # noqa: E402

COST = 0.44
WINDOWS = {'pre10': (-10, -1), 'post5': (0, 4), 'post10': (0, 9), 'after20': (10, 29)}
RANK_AT = -11          # 融券多寡用停券前第 11 個交易日(⛔ 用到窗口裡)
QUIET = 30             # 對照 ②:前後 30 個交易日沒有停券
SHIFT = -60            # 安慰劑:往前挪 60 個交易日
TOP = float(os.getenv('TOP') or '0.10')     # 「融券很多」= 當天融券比例前 10%


# ───────────────────────── 純函式(--selftest) ─────────────────────────
def parse_ssusp(j):
    """stock_deep/ssusp 一檔(pack_events 格式 {d, c, v})→ [(開始日, 結束日, 原因)];欄名照檔案裡的(⛔ 寫死位置)。"""
    if not j or not j.get('d'):
        return []
    c = j.get('c') or []
    ie = c.index('end_date') if 'end_date' in c else None
    ir = c.index('reason') if 'reason' in c else None
    out = []
    for d, row in zip(j['d'], j['v']):
        out.append((d, (row[ie] if ie is not None else None) or d, (row[ir] if ir is not None else '') or ''))
    return sorted(set(out))


def event_index(cal, d):
    """事件日 = d 那天或之後第一個交易日;日曆外 → None。"""
    lo, hi = 0, len(cal)
    while lo < hi:
        md = (lo + hi) // 2
        if cal[md] < d:
            lo = md + 1
        else:
            hi = md
    return lo if lo < len(cal) else None


def load_kx(path):
    """K 線 + 融資券(張);⛔ 開盤 / 收盤不合法的列不收。"""
    try:
        rows = json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return None
    rows = rows if isinstance(rows, list) else (rows.get('data') or [])
    K = {'d': [], 'o': [], 'h': [], 'l': [], 'c': [], 'sb': [], 'mb': []}
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
        sb, mb = r.get('short_balance'), r.get('margin_balance')
        K['sb'].append(float(sb) if sb is not None else None)
        K['mb'].append(float(mb) if mb is not None else None)
    return K if len(K['d']) > 120 else None


def win_ret(K, ia, ib, divs):
    """K 線位置 ia 開盤買 → ib 收盤賣(含股利)%;買不到 / 斷崖 / 資料不夠 → None。"""
    if ia < 1 or ib >= len(K['d']) or ib < ia:
        return None
    if LL.locked_bar(K['d'][ia], K['c'][ia - 1], K['o'][ia], K['h'][ia], K['l'][ia]) != 0:
        return None
    pre = K.get('_cliff')
    if pre is None:
        pre = K['_cliff'] = LL.cliff_prefix(K['c'], K['o'])
    if LL.cliff_in(pre, ia - 1, ib):
        return None
    f = div_factor(divs, K['d'][ia], K['d'][ib])
    return (K['c'][ib] * f / K['o'][ia] - 1) * 100


def short_ratio(K, j, sh):
    """K 線第 j 根:融券餘額(張)× 1000 ÷ 發行股數 × 100(%);任一個不知道 → None。"""
    if j is None or j < 0 or K['sb'][j] is None or not sh:
        return None
    n = shares_on(sh, K['d'][j])
    return K['sb'][j] * 1000 / n * 100 if n else None


def study(stocks, cal, events_by_sym, windows=WINDOWS, top=TOP):
    """stocks = {代號: (K, 日期→位置, 發行股數, 股利)};events_by_sym = {代號: [(開始日, 結束日, 原因)]}。
    回 res[(窗口, 組別, 對照)] = [(年, 異常報酬)]。組別:hi(事件股融券前 top%)/ all(全部事件股)。"""
    # 每一天:誰在 ±QUIET 內有停券(對照 ② 要排掉)
    ev_days = {}
    for s, evs in events_by_sym.items():
        for d, _, _ in evs:
            i = event_index(cal, d)
            if i is not None:
                ev_days.setdefault(s, []).append(i)
    res = {}
    cache = {}

    def ctrl(base, w):
        key = (base, w)
        if key in cache:
            return cache[key]
        ra, a, b = cal[base + RANK_AT] if base + RANK_AT >= 0 else None, base + w[0], base + w[1]
        if ra is None or a < 1 or b >= len(cal):
            cache[key] = None
            return None
        all_x, srt = [], []
        for s, (K, ki, sh, dv) in stocks.items():
            ia, ib, jr = ki.get(cal[a]), ki.get(cal[b]), ki.get(ra)
            if ia is None or ib is None:
                continue
            x = win_ret(K, ia, ib, dv)
            if x is None:
                continue
            all_x.append(x)
            q = short_ratio(K, jr, sh)
            quiet = all(abs(i - base) > QUIET for i in ev_days.get(s, []))
            if q is not None and quiet:
                srt.append((q, x))
        if len(all_x) < 30:
            cache[key] = None
            return None
        srt.sort(reverse=True)
        k = max(1, int(len(srt) * top))
        hi_ctrl = mean([x for _, x in srt[:k]]) if srt else None
        cut = srt[k - 1][0] if srt else None
        cache[key] = (mean(all_x), hi_ctrl, cut)
        return cache[key]

    for s, evs in events_by_sym.items():
        if s not in stocks:
            continue
        K, ki, sh, dv = stocks[s]
        seen = set()
        for d, _, why in evs:
            ie = event_index(cal, d)
            if ie is None or ie in seen:
                continue
            seen.add(ie)
            for tag, base in (('real', ie), ('sham', ie + SHIFT)):
                if base + RANK_AT < 0:
                    continue
                jr = ki.get(cal[base + RANK_AT])
                q = short_ratio(K, jr, sh)
                for w, wd in windows.items():
                    c = ctrl(base, wd)
                    a, b = base + wd[0], base + wd[1]
                    if c is None or a < 1 or b >= len(cal):
                        continue
                    ia, ib = ki.get(cal[a]), ki.get(cal[b])
                    if ia is None or ib is None:
                        continue
                    x = win_ret(K, ia, ib, dv)
                    if x is None:
                        continue
                    ca, chi, cut = c
                    y = cal[base][:4]
                    grp = ['all'] + (['hi'] if (q is not None and cut is not None and q >= cut) else [])
                    for g in grp:
                        res.setdefault((w, g, 'all_' + tag), []).append((y, x - ca))
                        if chi is not None:
                            res.setdefault((w, g, 'hi_' + tag), []).append((y, x - chi))
    return res


def judge(xs, cost=COST):
    v = [x for _, x in xs]
    if not v:
        return {'n': 0}
    yrs = sorted({y for y, _ in xs})
    half = yrs[len(yrs) // 2]
    by = {}
    for y, x in xs:
        by.setdefault(y, []).append(x)
    m = mean(v)
    sv = sorted(v)
    return {'n': len(v), 'm': m, 't': tstat(v), 'h1': mean([x for y, x in xs if y < half]), 'h2': mean([x for y, x in xs if y >= half]),
            'yr': (sum(1 for y in by if (mean(by[y]) > 0) == (m > 0)), len(by)), 'med': sv[len(sv) // 2],
            'pos': sum(1 for x in v if x > 0) / len(v), 'after_cost': m - cost}


# ───────────────────────── 主程式 ─────────────────────────
def main():
    data = Path(os.getenv('DATA_DIR') or 'd16m_fi')
    ss_dir = Path(os.getenv('SSUSP_DIR') or 'stock_deep/ssusp')
    share_dir = Path(os.getenv('SHARE_DIR') or 'stock_deep/share')
    out_path = os.getenv('OUT') or ''
    cal = (load_kx(data / '^TWII.json') or {}).get('d')
    if not cal:
        print('❌ 讀不到交易日曆')
        return 1
    divj = json.loads((data / '_div16.json').read_text(encoding='utf-8'))['d']
    events, n_files, reasons = {}, 0, {}
    for p in sorted(ss_dir.glob('*.json.gz')):
        n_files += 1
        try:
            with gzip.open(p, 'rt', encoding='utf-8') as f:
                ev = parse_ssusp(json.load(f))
        except Exception:
            continue
        if ev:
            events[p.name.split('.')[0]] = ev
            for _, _, r in ev:
                reasons[r] = reasons.get(r, 0) + 1
    n_ev = sum(len(v) for v in events.values())
    print(f'📦 停券檔 {n_files} 個 ・有事件 {len(events)} 檔 ・{n_ev} 段 ・原因 {sorted(reasons.items(), key=lambda t: -t[1])[:8]}', flush=True)
    if n_ev < 200:
        print('❌ 事件太少(< 200)→ ⛔ 不判(回補還沒完成?)')
        return 1
    stocks = {}
    for p in sorted(data.glob('*.json')):
        if not re.match(r'^\d{4}$', p.stem):
            continue
        K = load_kx(p)
        if not K:
            continue
        stocks[p.stem] = (K, {d: i for i, d in enumerate(K['d'])}, load_shares(share_dir, p.stem),
                          [(r[0], r[3], r[4]) for r in (divj.get(p.stem) or {}).get('h', []) if len(r) >= 5])
    print(f'📦 個股 {len(stocks)} 檔', flush=True)
    res = study(stocks, cal, events)
    summary = {}
    for w in WINDOWS:
        for g, lab in (('hi', f'融券前 {int(TOP * 100)}%'), ('all', '全部停券股')):
            line = []
            for c, clab in (('all_real', '比全部'), ('hi_real', '比同樣融券多、沒停券'), ('all_sham', '安慰劑(挪 60 天)')):
                j = judge(res.get((w, g, c), []))
                summary[f'{w}_{g}_{c}'] = j
                if j.get('n'):
                    line.append(f'{clab} {j["m"]:+.2f}%(n={j["n"]},t={j["t"]:.1f})')
            jm = summary[f'{w}_{g}_hi_real']
            extra = (f' ・前後半 {jm["h1"]:+.2f}/{jm["h2"]:+.2f} ・逐年 {jm["yr"][0]}/{jm["yr"][1]} ・中位 {jm["med"]:+.2f} ・贏的比例 {jm["pos"] * 100:.0f}%'
                     if jm.get('n') else '')
            print(f'{w:<8} {lab}:' + ' ・'.join(line) + extra, flush=True)
    if out_path:
        Path(out_path).write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=float), encoding='utf-8')
    return 0


def selftest():
    import random
    from datetime import date, timedelta
    bad = []

    def ok(n, c, e=''):
        print(('✅ ' if c else '❌ ') + n + ('' if c else '  ' + str(e)[:200]))
        if not c:
            bad.append(n)
    j = {'d': ['2015-04-01', '2016-03-31', '2015-04-01'], 'c': ['end_date', 'reason'],
         'v': [['2015-04-08', '股東常會'], ['2016-04-08', '股東常會'], ['2015-04-08', '股東常會']]}
    ok('① 停券事件解析:欄名照檔案、重複的只留一筆、照日期排', parse_ssusp(j) == [('2015-04-01', '2015-04-08', '股東常會'), ('2016-03-31', '2016-04-08', '股東常會')], parse_ssusp(j))
    ok('① 沒資料 → []', parse_ssusp({'d': [], 'c': [], 'v': []}) == [])
    cal = ['2015-03-30', '2015-03-31', '2015-04-01', '2015-04-02', '2015-04-07']
    ok('② 事件日 = 那天或之後第一個交易日(4/4 → 4/7)', event_index(cal, '2015-04-04') == 4 and event_index(cal, '2015-04-01') == 2 and event_index(cal, '2015-05-01') is None)

    def synth(ev_boost, hi_boost, seed=5):
        rnd = random.Random(seed)
        n_day = 1600
        cal_ = [(date(2016, 1, 4) + timedelta(days=k)).isoformat() for k in range(n_day)]
        stocks, events = {}, {}
        ev_at = list(range(150, 1500, 70))
        for k in range(200):
            sym = str(1000 + k)
            hi = k < 40                                    # 前 40 檔融券多(比例 5%)、其他 0.5%
            evs = [i for i in ev_at if (k % 5 == 0)] if k < 120 else []   # 每 5 檔有一檔有停券事件
            c, cs, os_ = 50.0, [], []
            for t in range(n_day):
                r = rnd.gauss(0, 0.005)
                if hi and hi_boost:
                    r += 0.002                              # 融券多本身就會漲(軋空題材)→ 對照 ② 要抵掉
                if ev_boost and any(i - 10 <= t <= i - 1 for i in evs) and hi:
                    r += 0.004                              # 停券前 10 天回補買盤(只有融券多的才有)
                o = c
                c *= 1 + r
                os_.append(o)
                cs.append(c)
            K = {'d': cal_, 'o': os_, 'c': cs, 'h': [max(a, b) for a, b in zip(os_, cs)], 'l': [min(a, b) for a, b in zip(os_, cs)],
                 'sb': [(5000.0 if hi else 500.0)] * n_day, 'mb': [10000.0] * n_day}
            stocks[sym] = (K, {d: i for i, d in enumerate(cal_)}, [(cal_[0], 100_000_000)], [])
            if evs:
                events[sym] = [(cal_[i], cal_[i + 5], '股東常會') for i in evs]
        return study(stocks, cal_, events, top=0.15)            # 32 檔融券多的沒有停券 → 前 15% 的門檻剛好落在融券多那一群
    r = synth(True, False)
    m = mean([x for _, x in r[('pre10', 'hi', 'hi_real')]])
    ms = mean([x for _, x in r[('pre10', 'hi', 'hi_sham')]])
    ok('③ 注入「停券前 10 天融券多的有回補買盤」→ 量得到(≈ +4%)、安慰劑 ≈ 0', 2.5 < m < 5.5 and abs(ms) < 1.5, (m, ms))
    r2 = synth(False, True)
    m_all = mean([x for _, x in r2[('pre10', 'hi', 'all_real')]])
    m_hi = mean([x for _, x in r2[('pre10', 'hi', 'hi_real')]])
    ok('④ 決定性對照:融券多本身就會漲、跟停券無關 → 比全部 > 0、比同樣融券多 ≈ 0', m_all > 1.0 and abs(m_hi) < 1.0, (m_all, m_hi))
    print(('\n❌ selftest 失敗 ' + str(bad)) if bad else '\n✅ selftest 全過')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
