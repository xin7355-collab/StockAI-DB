#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📝 insider_event_probe.py —— 大股東 / 董監 / 經理人「申報轉讓」之後,那檔股票會不會比較弱(V80.1.7,計畫 B4「少輸那一半」)

使用者(2026-11-01):「早知道先機,贏多一點少輸一點」→ 換一個問題:**法律逼人提早說的事**。
內部人在市場上賣股票之前,一定要先到公開資訊觀測站申報(股權轉讓事前申報,有效期間一個月)。
外部研究(Airiti / 政大)說申報之後有負報酬 —— 這支用本站 16 年全市場資料重測。

事件:insider_deep/{YYYY-MM}.json.gz(scripts/insider_backfill.py 回補的日報表;每列原文 + parse_cells 解析,⛔ 第二份解析)
  同一檔同一天多筆 → 合成一件(股數加總、方式 / 身分取聯集);同一檔 20 個交易日內只算第一件(⛔ 一波賣壓算很多次)。
進場:申報那天是交易日 → **隔天開盤**(申報當天什麼時候公開不確定,⛔ 用當天收盤);不是交易日 → 下一個交易日開盤。
  抱 5 / 10 / 20 / 40 天(開盤 → 第 H 天收盤,含股利);鎖漲跌停買不到 / 價格斷崖的窗口剔除(lib_limit)。
對照(都是同一天、同一個窗口):
  ① 全部股票平均
  ② ⭐ 動能配對:同一天「前 20 天漲跌」同一個十分位的股票(扣掉窗口前後也有申報的)—— 內部人常在漲多了之後才賣,
     只比 ① 會把「漲多了本來就會回」算成申報的效果(selftest ⑥ 決定性對照)
安慰劑:同一批事件整段往前挪 120 個交易日(那時候還沒申報)。
分組:方式(市場賣出 = 一般交易 / 鉅額 / 盤後定價;信託・贈與;洽特定人・私募)× 申報股數 ÷ 發行股數(全部 / ≥0.1 / ≥0.3 / ≥1%)
      × 身分(大股東 / 董事・監察人・法人董事代表人 / 經理人)。
判讀(避雷型訊號):比動能配對 < 0、t ≤ −2、前後半同號、逐年 ≥70% 同號、5 / 10 / 20 / 40 天同號(高原)、安慰劑 ≈ 0。

跑法:INSIDER_DIR=<insider_deep> DATA_DIR=<d16m_fi> SHARE_DIR=<stock_deep/share> OUT=ins.json python3 scripts/insider_event_probe.py
      python3 scripts/insider_event_probe.py --selftest
      🧾 V80.2.0 EVENTS_OUT=<檔> [EV_M=mkt EV_T=0 EV_R=all]:不跑研究,只把那一組的 {代號:[進場日]} 寫出來
         (跟研究同一份去重 + 同一條分組;日期 = 申報隔天的交易日,⛔ 申報當天)→ 給回測引擎 CCWIN(CCWIN_PRE=0 CCWIN_POST=19
         = 進場那天起 20 個交易日先不買)或拿去跟 🔥 / 👑 實際買進的股票數重疊。
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
from insider_backfill import parse_cells                                       # noqa: E402  ⭐ 解析只有一份
from short_cover_probe import load_kx, win_ret, event_index                     # noqa: E402  ⭐ 讀 K 線 / 窗口報酬 / 事件日只有一份
from window_dress_probe import load_shares, shares_on, mean, tstat              # noqa: E402

COST = 0.44
HOLD = (5, 10, 20, 40)
DEDUP = 20             # 同一檔 20 個交易日內只算第一件
MOM_LB = 20            # 動能配對:前 20 天漲跌
SHAM = -120            # 安慰劑:往前挪 120 個交易日
TIERS = (0.0, 0.1, 0.3, 1.0)
MKT_RE = re.compile(r'一般交易|鉅額|盤後定價')
GIFT_RE = re.compile(r'信託|贈與')
SPEC_RE = re.compile(r'洽特定人|私募')


# ───────────────────────── 純函式(--selftest) ─────────────────────────
def method_cls(m):
    m = m or ''
    if MKT_RE.search(m):
        return 'mkt'
    if GIFT_RE.search(m):
        return 'gift'
    if SPEC_RE.search(m):
        return 'spec'
    return 'other'


def role_cls(r):
    r = r or ''
    if '大股東' in r:
        return 'big'
    if '董事' in r or '監察人' in r:
        return 'dir'
    if '經理人' in r:
        return 'mgr'
    return 'other'


def load_events(rows_by_month):
    """[[市場, 原文欄位…], …](可以多個月)→ {代號: {日期: {'sh': 預定轉讓股數, 'm': {方式}, 'r': {身分}, 'n': 筆數}}}。
    ⛔ 恆等式對不上的列不收(欄位錯位);只收 4 碼個股。"""
    ev = {}
    for row in rows_by_month:
        r = parse_cells(row[1:] if row and row[0] in ('sii', 'otc') else row)
        if not r or not r.get('ok') or not re.fullmatch(r'\d{4}', r.get('code') or ''):
            continue
        sh = (r.get('plan_own_n') or 0) + (r.get('plan_trust_n') or 0)
        e = ev.setdefault(r['code'], {}).setdefault(r['date'], {'sh': 0, 'm': set(), 'r': set(), 'n': 0})
        e['sh'] += sh
        e['m'].add(method_cls(r.get('method')))
        e['r'].add(role_cls(r.get('role')))
        e['n'] += 1
    return ev


def entry_index(cal, d):
    """申報日 d → 進場位置(⛔ 用申報當天):d 是交易日 → 隔天;不是 → 下一個交易日。"""
    i = event_index(cal, d)
    if i is None:
        return None
    if cal[i] == d:
        i += 1
    return i if i < len(cal) else None


def dedup_events(ev_sym, cal, gap=DEDUP):
    """同一檔:進場位置 → 事件(20 個交易日內只留第一件)。回 [(進場位置, 申報日, 事件)]。"""
    out, last = [], None
    for d in sorted(ev_sym):
        e = entry_index(cal, d)
        if e is None:
            continue
        if last is not None and e - last < gap:
            continue
        out.append((e, d, ev_sym[d]))
        last = e
    return out


METHODS = ('all', 'mkt', 'gift', 'spec')
ROLES = ('all', 'big', 'dir', 'mgr')


def in_group(ev, pct, m='mkt', t=0.0, r='all'):
    """這一件屬不屬於 (方式 m, 申報股數 ÷ 發行股數 ≥ t%, 身分 r) 那一組 —— 跟 study 的分組同一條(selftest ⑦ 逐筆比對)。"""
    return ((m == 'all' or m in ev['m']) and (t == 0.0 or (pct is not None and pct >= t))
            and (r == 'all' or r in ev['r']))


def group_events(stocks, cal, events, m='mkt', t=0.0, r='all'):
    """→ {代號: [進場日]}:跟 study 同一份去重(dedup_events,同一檔 20 個交易日內只算第一件)與同一條分組(in_group)。
    日期 = 進場那天(申報隔天的交易日),⛔ 申報當天 —— 申報當天什麼時候公開不確定,拿它擋當天收盤的買進 = 偷看。"""
    out = {}
    for s, v in events.items():
        if s not in stocks:
            continue
        sh = stocks[s][2]
        for e, d, ev in dedup_events(v, cal):
            n_sh = shares_on(sh, d) if sh else None
            pct = ev['sh'] / n_sh * 100 if n_sh else None
            if in_group(ev, pct, m, t, r):
                out.setdefault(s, []).append(cal[e])
    return out


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
    k = max(1, len(sv) // 20)
    trim = sv[k:-k] if len(sv) > 2 * k + 2 else sv
    return {'n': len(v), 'm': m, 't': tstat(v), 'h1': mean([x for y, x in xs if y < half]),
            'h2': mean([x for y, x in xs if y >= half]),
            'yr': (sum(1 for y in by if (mean(by[y]) > 0) == (m > 0)), len(by)), 'med': sv[len(sv) // 2],
            'pos': sum(1 for x in v if x > 0) / len(v), 'trim': mean(trim), 'after_cost': m - cost}


def study(stocks, cal, events, holds=HOLD, track=None):
    """stocks = {代號: (K, 日期→位置, 發行股數, 股利)};events = {代號: {日期: 事件}}。
    回 res[(H, 方式, 級距, 身分, 對照)] = [(年, 異常報酬)];對照 ∈ all_real / mom_real / mom_sham。
    track(dict,selftest 用)= 每組實際算進 all_real 的 (代號, 進場日),拿來跟 group_events 逐筆比。"""
    evl = {s: dedup_events(v, cal) for s, v in events.items() if s in stocks}
    ev_pos = {s: [e for e, _, _ in lst] for s, lst in evl.items()}   # 每檔的進場位置(已排序)
    cache = {}

    def busy(s, a, b):
        """這檔在 [a, b] 之間有沒有申報(對照組要排掉 —— 別檔申報後的漲跌 ⛔ 混進對照,selftest ⑤ 跳空那條)。"""
        lst = ev_pos.get(s)
        if not lst:
            return False
        k = bisect.bisect_left(lst, a)
        return k < len(lst) and lst[k] <= b

    def ctrl(e, h):
        """同一天(進場 e、抱 h 天)全部股票:平均、每個動能十分位的 (總和, 筆數)、每檔的十分位。"""
        key = (e, h)
        if key in cache:
            return cache[key]
        a, b, p0, p1 = e, e + h - 1, e - 1, e - 1 - MOM_LB
        if p1 < 0 or b >= len(cal):
            cache[key] = None
            return None
        rows = []
        for s, (K, ki, _, dv) in stocks.items():
            ia, ib, j0, j1 = ki.get(cal[a]), ki.get(cal[b]), ki.get(cal[p0]), ki.get(cal[p1])
            if ia is None or ib is None or j0 is None or j1 is None:
                continue
            x = win_ret(K, ia, ib, dv)
            if x is None:
                continue
            rows.append((K['c'][j0] / K['c'][j1] - 1, x, s))
        if len(rows) < 50:
            cache[key] = None
            return None
        rows.sort()
        n = len(rows)
        dec = {}
        sums = [[0.0, 0] for _ in range(10)]
        clean = []
        for k, (_, x, s) in enumerate(rows):
            q = min(9, k * 10 // n)
            dec[s] = q
            if not busy(s, e - h, e + h):                 # 窗口前後 h 天內有申報的 ⛔ 進對照
                sums[q][0] += x
                sums[q][1] += 1
                clean.append(x)
        allm = mean(clean)
        cache[key] = (allm, sums, dec)
        return cache[key]

    def mom_of(K, ki, e):
        p0, p1 = e - 1, e - 1 - MOM_LB
        if p1 < 0:
            return None
        j0, j1 = ki.get(cal[p0]), ki.get(cal[p1])
        return None if j0 is None or j1 is None else K['c'][j0] / K['c'][j1] - 1

    res = {}
    for s, lst in evl.items():
        K, ki, sh, dv = stocks[s]
        for e, d, ev in lst:
            n_sh = shares_on(sh, d) if sh else None
            pct = ev['sh'] / n_sh * 100 if n_sh else None
            meths = ['all'] + sorted(ev['m'] - {'other'})
            roles = ['all'] + sorted(ev['r'] - {'other'})
            tiers = [t for t in TIERS if t == 0.0 or (pct is not None and pct >= t)]
            for tag, base in (('real', e), ('sham', e + SHAM)):
                if base - 1 - MOM_LB < 0:
                    continue
                for h in holds:
                    c = ctrl(base, h)
                    if c is None:
                        continue
                    ia, ib = ki.get(cal[base]), ki.get(cal[base + h - 1]) if base + h - 1 < len(cal) else None
                    if ia is None or ib is None:
                        continue
                    x = win_ret(K, ia, ib, dv)
                    if x is None:
                        continue
                    allm, sums, dec = c
                    q = dec.get(s)
                    if q is None:
                        continue
                    sm, cn = sums[q]
                    momc = sm / cn if cn else None
                    y = cal[base][:4]
                    for m in meths:
                        for t in tiers:
                            for r in roles:
                                if tag == 'real':
                                    res.setdefault((h, m, t, r, 'all_real'), []).append((y, x - allm))
                                    if track is not None:
                                        track.setdefault((h, m, t, r), []).append((s, cal[base]))
                                if momc is not None:
                                    res.setdefault((h, m, t, r, 'mom_' + tag), []).append((y, x - momc))
    return res


# ───────────────────────── 主程式 ─────────────────────────
def main():
    S = os.getenv
    ins = Path(S('INSIDER_DIR') or 'insider_deep')
    data = Path(S('DATA_DIR') or 'd16m_fi')
    share_dir = Path(S('SHARE_DIR') or 'stock_deep/share')
    out_path = S('OUT') or ''
    rows, months = [], []
    for p in sorted(ins.glob('*.json.gz')):
        try:
            with gzip.open(p, 'rt', encoding='utf-8') as f:
                j = json.load(f)
        except Exception:
            continue
        months.append(j.get('m') or p.name[:7])
        rows += j.get('rows') or []
    events = load_events(rows)
    n_ev = sum(len(v) for v in events.values())
    print(f'📦 申報轉讓 {len(months)} 個月({months[0] if months else "-"} ~ {months[-1] if months else "-"})・{len(rows)} 列 ・'
          f'合成 {n_ev} 件(同檔同日一件)・{len(events)} 檔', flush=True)
    min_ev = int(S('MIN_EV') or 300)            # ⛔ 正式判讀一律 300;只有拿部分資料試跑正式入口時才調低
    if n_ev < min_ev:
        print(f'❌ 事件太少(< {min_ev})→ ⛔ 不判(回補還沒完成?)')
        return 1
    if min_ev < 300:
        print(f'⚠️ MIN_EV={min_ev}:試跑(資料還沒補完),⛔ 數字不可當結論')
    cal = (load_kx(data / '^TWII.json') or {}).get('d')
    if not cal:
        print('❌ 讀不到交易日曆')
        return 1
    divj = json.loads((data / '_div16.json').read_text(encoding='utf-8'))['d']
    stocks = {}
    for p in sorted(data.glob('*.json')):
        if not re.match(r'^\d{4}$', p.stem):
            continue
        K = load_kx(p)
        if not K:
            continue
        stocks[p.stem] = (K, {d: i for i, d in enumerate(K['d'])}, load_shares(share_dir, p.stem),
                          [(r[0], r[3], r[4]) for r in (divj.get(p.stem) or {}).get('h', []) if len(r) >= 5])
    print(f'📦 個股 {len(stocks)} 檔(K 線 {cal[0]} ~ {cal[-1]})', flush=True)
    ev_out = S('EVENTS_OUT') or ''
    if ev_out:                                       # 只輸出那一組的進場日(給引擎 CCWIN / 重疊計數),不跑研究
        gm, gr = (S('EV_M') or 'mkt').strip(), (S('EV_R') or 'all').strip()
        try:
            gt = float(S('EV_T') or 0)
        except ValueError:
            gt = -1.0
        if gm not in METHODS or gr not in ROLES or gt < 0:
            print(f'❌ EV_M 要是 {METHODS}、EV_R 要是 {ROLES}、EV_T 要是 ≥0 的數字(拿到 {gm} / {gr} / {S("EV_T")})')
            return 1
        ge = group_events(stocks, cal, events, gm, gt, gr)
        Path(ev_out).write_text(json.dumps(ge, ensure_ascii=False), encoding='utf-8')
        n = sum(len(v) for v in ge.values())
        allv = sorted(x for v in ge.values() for x in v)
        print(f'📝 EVENTS_OUT:{gm}・≥{gt}%・{gr} → {n} 件 / {len(ge)} 檔'
              f'{f"({allv[0]} ~ {allv[-1]})" if allv else ""} → {ev_out}')
        return 0 if n else 1
    res = study(stocks, cal, events)
    summary = {'months': [months[0], months[-1]] if months else None, 'events': n_ev, 'rows': {}}
    names = {'all': '全部', 'mkt': '市場賣出', 'gift': '信託・贈與', 'spec': '洽特定人・私募'}
    rnames = {'all': '', 'big': '・大股東', 'dir': '・董監', 'mgr': '・經理人'}
    for m in ('all', 'mkt', 'gift', 'spec'):
        for t in TIERS:
            for r in ('all', 'big', 'dir', 'mgr'):
                if r != 'all' and t != 0.0:
                    continue
                parts = []
                for h in HOLD:
                    jm = judge(res.get((h, m, t, r, 'mom_real'), []))
                    ja = judge(res.get((h, m, t, r, 'all_real'), []))
                    js = judge(res.get((h, m, t, r, 'mom_sham'), []))
                    summary['rows'][f'{h}_{m}_{t}_{r}'] = {'mom': jm, 'all': ja, 'sham': js}
                    if jm.get('n'):
                        parts.append(f'{h} 天 {jm["m"]:+.2f}(t {jm["t"]:.1f},n {jm["n"]},前後半 {jm["h1"]:+.2f}/{jm["h2"]:+.2f},'
                                     f'逐年 {jm["yr"][0]}/{jm["yr"][1]},全部 {ja.get("m", float("nan")):+.2f},安慰劑 {js.get("m", float("nan")):+.2f})')
                if parts:
                    lab = f'{names[m]}{"" if t == 0 else f"・≥{t}%"}{rnames[r]}'
                    print(f'{lab:<16} ' + ' ・'.join(parts), flush=True)
    if out_path:
        Path(out_path).write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding='utf-8')
    return 0


# ───────────────────────── selftest ─────────────────────────
def selftest():
    import random
    bad = []

    def ok(name, cond, info=''):
        print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {info}'))
        if not cond:
            bad.append(name)

    # ① 解析 + 分類(原文格式跟探路那兩列一樣)
    r_ok = ['sii', '', '115/10/01', '6499', '益安', '經理人本人', '翁育詩', '一般交易(每日得轉讓股數限制)', '', '', '',
            '1,000,000', '0', '150,000', '0', '850,000', '0', '115/10/01 ~ 115/10/31']
    r_bad = list(r_ok)
    r_bad[16] = '900,000'                                   # 恆等式對不上(欄位錯位)
    r_gift = ['otc', '', '115/10/01', '6499', '益安', '大股東本人', 'X', '贈與', '', '', 'Y',
              '500,000', '0', '50,000', '0', '450,000', '0', '115/10/01 ~ 115/10/03']
    ev = load_events([r_ok, r_bad, r_gift])
    e1 = ev.get('6499', {}).get('2026-10-01')
    ok('① 恆等式對不上的列不收、同檔同日合成一件(股數加總、方式 / 身分取聯集)',
       e1 is not None and e1['n'] == 2 and e1['sh'] == 200000 and e1['m'] == {'mkt', 'gift'} and e1['r'] == {'mgr', 'big'}, e1)
    ok('② 方式分類:一般交易 / 鉅額 / 盤後定價 = 市場、信託 / 贈與、洽特定人 / 私募',
       [method_cls(x) for x in ('一般交易(每日得轉讓股數限制)', '鉅額逐筆交易', '盤後定價交易', '信託', '贈與', '洽特定人', '轉讓私募股票')]
       == ['mkt', 'mkt', 'mkt', 'gift', 'gift', 'spec', 'spec'])
    ok('② 身分分類:法人董事代表人 = 董監、大股東利用他人名義 = 大股東、子公司經理人 = 經理人',
       [role_cls(x) for x in ('法人董事代表人本人', '大股東利用他人名義持有者', '子公司經理人本人', '監察人本人')] == ['dir', 'big', 'mgr', 'dir'])
    # ③ 進場位置
    cal = ['2020-01-%02d' % d for d in (2, 3, 6, 7, 8)]
    ok('③ 申報日是交易日 → 隔天開盤;不是交易日 → 下一個交易日開盤', entry_index(cal, '2020-01-03') == 2 and entry_index(cal, '2020-01-04') == 2
       and entry_index(cal, '2020-01-08') is None)
    # ④ 去重
    cal = ['D%04d' % i for i in range(200)]
    evs = {'D0010': {'sh': 1, 'm': {'mkt'}, 'r': {'dir'}, 'n': 1}, 'D0025': {'sh': 1, 'm': {'mkt'}, 'r': {'dir'}, 'n': 1},
           'D0040': {'sh': 1, 'm': {'mkt'}, 'r': {'dir'}, 'n': 1}}
    dd = dedup_events(evs, cal)
    ok('④ 同一檔 20 個交易日內只算第一件', [x[1] for x in dd] == ['D0010', 'D0040'], dd)

    # ⑤ 合成市場:注入「申報後 10 天 −3%」→ 量得到;安慰劑 ≈ 0;⭐ 申報當天收盤到隔天開盤的跳空 ⛔ 算進去
    def mk(n_days=900, n_stk=100, seed=7, drift_ev=-3.0, gap_ev=0.0, mom_rev=0.0, ev_pick='rand', vol=0.005):
        rnd = random.Random(seed)
        cal = ['2010-%02d-%02d' % (1 + i // 28 % 12, 1 + i % 28) for i in range(n_days)]
        cal = ['%04d-%s' % (2010 + i // 336, c[5:]) for i, c in enumerate(cal)]
        stocks, events = {}, {}
        evd = {}
        for k in range(n_stk):
            s = '%04d' % (1000 + k)
            c = [100.0]
            for i in range(1, n_days):
                c.append(c[-1] * (1 + rnd.gauss(0, vol)))
            o = [c[0]] + [c[i - 1] for i in range(1, n_days)]
            if k < 30:
                for j in range(5):
                    d0 = 150 + j * 80 + k
                    evd.setdefault(s, []).append(d0)
            stocks[s] = [o, c]
        # 動能反轉(所有股票:前 20 天漲最多的那 10%,之後 10 天 mom_rev%)—— 先算好再改價
        for s, (o, c) in stocks.items():
            for d0 in evd.get(s, []):
                e = d0 + 1
                if gap_ev:
                    for i in range(e, n_days):           # 申報當天收盤 → 隔天開盤的跳空(進場前就發生)
                        o[i] *= 1 + gap_ev / 100
                        c[i] *= 1 + gap_ev / 100
                    o[e] = c[e - 1] * (1 + gap_ev / 100)
                if drift_ev:
                    step = (1 + drift_ev / 100) ** (1 / 10)
                    for i in range(e, n_days):
                        f = step ** min(10, i - e + 1)
                        c[i] *= f
                        if i > e:
                            o[i] *= step ** min(10, i - e)
        if mom_rev:
            for i in range(21, n_days - 11, 10):
                moms = sorted(((st[1][i - 1] / st[1][i - 21] - 1, s) for s, st in stocks.items()), reverse=True)
                for _, s in moms[:len(moms) // 10]:
                    o, c = stocks[s]
                    step = (1 + mom_rev / 100) ** (1 / 10)
                    for j in range(i, n_days):
                        c[j] *= step ** min(10, j - i + 1)
                        if j > i:
                            o[j] *= step ** min(10, j - i)
        if ev_pick == 'mom':                              # 事件改挑「前 20 天漲最多」的那幾檔(內部人漲多了才賣)
            evd = {}
            for i in range(150, n_days - 60, 20):
                if (i + 1) % 10 != 1:
                    continue
                moms = sorted(((stocks[s][1][i] / stocks[s][1][i - 20] - 1, s) for s in stocks), reverse=True)
                for _, s in moms[:4]:
                    evd.setdefault(s, []).append(i)
        out = {}
        for s, (o, c) in stocks.items():
            K = {'d': cal, 'o': o, 'c': c, 'h': [max(a, b) for a, b in zip(o, c)], 'l': [min(a, b) for a, b in zip(o, c)],
                 'sb': [None] * n_days, 'mb': [None] * n_days}
            out[s] = (K, {d: i for i, d in enumerate(cal)}, [(cal[0], 10_000_000)], [])
        for s, ds in evd.items():
            for d0 in ds:
                events.setdefault(s, {})[cal[d0]] = {'sh': 50_000, 'm': {'mkt'}, 'r': {'dir'}, 'n': 1}
        return out, cal, events

    st, cal, evs = mk()
    res = study(st, cal, evs, holds=(10,))
    jm = judge(res.get((10, 'all', 0.0, 'all', 'mom_real'), []))
    js = judge(res.get((10, 'all', 0.0, 'all', 'mom_sham'), []))
    ok('⑤ 注入「申報後 10 天 −3%」→ 比動能配對量到約 −3', jm.get('n', 0) > 50 and -3.6 < jm['m'] < -2.4, jm)
    ok('⑤ 安慰劑(往前挪 120 天)≈ 0', js.get('n', 0) > 30 and abs(js['m']) < 0.6, js)
    ok('⑤ 級距:申報 50,000 股 ÷ 1,000 萬股 = 0.5% → 進 ≥0.1 / ≥0.3、⛔ 進 ≥1%',
       bool(res.get((10, 'all', 0.3, 'all', 'mom_real'))) and not res.get((10, 'all', 1.0, 'all', 'mom_real')))
    st, cal, evs = mk(drift_ev=0.0, gap_ev=-5.0, seed=11)
    jg = judge(study(st, cal, evs, holds=(10,)).get((10, 'all', 0.0, 'all', 'mom_real'), []))
    ok('⑤ ⭐ 決定性對照:申報當晚的跳空(−5%,隔天開盤前就發生)⛔ 算進去 → ≈ 0', jg.get('n', 0) > 50 and abs(jg['m']) < 0.35, jg)
    # ⑥ ⭐ 動能配對:「漲多了本來就會回」不可以算成申報的效果
    st, cal, evs = mk(drift_ev=0.0, mom_rev=-2.0, ev_pick='mom', seed=5)
    res = study(st, cal, evs, holds=(10,))
    ja = judge(res.get((10, 'all', 0.0, 'all', 'all_real'), []))
    jm = judge(res.get((10, 'all', 0.0, 'all', 'mom_real'), []))
    ok('⑥ ⭐ 決定性對照:事件都挑漲最多的、漲多了本來就會回 −2% → 比全部股票是負的、比動能配對 ≈ 0',
       ja.get('n', 0) > 60 and ja['m'] < -1.0 and abs(jm.get('m', 9)) < 0.5, (ja, jm))

    # ⑦ EVENTS_OUT 給引擎的清單 == 研究裡同一組實際算進去的那幾件(同一份去重 + 同一條分組)
    st, cal, evs = mk(seed=3)
    k = 0
    for s in sorted(evs):
        for d in sorted(evs[s]):
            v = evs[s][d]
            if k % 3 == 0:
                v['m'] = {'gift'}                          # 信託・贈與
            elif k % 3 == 2:
                v['sh'] = 5_000                            # 0.05%(⛔ 進 ≥0.1%)
            v['r'] = {'big'} if k % 2 else {'dir'}
            k += 1
    dup = []                                               # 同一檔 5 天後又申報一次(市場賣出)→ 去重要擋掉
    for s in sorted(evs)[:6]:
        i0 = cal.index(min(evs[s])) + 5
        evs[s][cal[i0]] = {'sh': 50_000, 'm': {'mkt'}, 'r': {'dir'}, 'n': 1}
        dup.append((s, cal[i0 + 1]))
    trk = {}
    study(st, cal, evs, holds=(10,), track=trk)
    same = True
    for g in (('mkt', 0.0, 'all'), ('mkt', 0.1, 'all'), ('gift', 0.0, 'all'), ('mkt', 0.0, 'big'), ('all', 0.3, 'dir')):
        ge = group_events(st, cal, evs, *g)
        a = {(s, d) for s, ds in ge.items() for d in ds}
        b = set(trk.get((10,) + g, []))
        if a != b or not a:
            same = False
            print('   ⑦ 對不上', g, len(a), len(b))
    ok('⑦ 給引擎的清單 == 研究那一組實際算進去的 (代號, 進場日),五組逐筆相同', same)
    g0 = {(s, d) for s, ds in group_events(st, cal, evs, 'mkt', 0.0, 'all').items() for d in ds}
    g1 = {(s, d) for s, ds in group_events(st, cal, evs, 'mkt', 0.1, 'all').items() for d in ds}
    gg = {(s, d) for s, ds in group_events(st, cal, evs, 'gift', 0.0, 'all').items() for d in ds}
    ok('⑦ ⭐ 決定性對照:≥0.1% 那組比全部少(0.05% 的被擋)、贈與跟市場賣出不重疊', g1 and g1 < g0 and not (gg & g0), (len(g0), len(g1), len(gg & g0)))
    late = all(any(f < d for f in evs[s]) and d not in evs[s] for s, d in g0)
    ok('⑦ 清單日期是進場那天(申報隔天的交易日),⛔ 申報當天', late)
    ok('⑦ ⭐ 決定性對照:同一檔 20 個交易日內的第二件 ⛔ 進清單(跟研究同一份去重)', not (set(dup) & g0), sorted(set(dup) & g0)[:3])

    print('\n' + ('✅ selftest 全過' if not bad else f'❌ {len(bad)} 條沒過'))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
