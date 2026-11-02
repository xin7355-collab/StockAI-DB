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


def reason_cls(why):
    """停券原因 → 'agm'(股東會:開會日、停止過戶日幾個月前就公告 → 前 10 天一定知道)/
    'div'(除權 / 除息:除權息日通常前一兩個月公告,⚠️ 沒逐筆驗公告日)/ 'other'(現金增資、減資…)。"""
    w = why or ''
    if '股東' in w:
        return 'agm'
    if '息' in w or '權' in w:
        return 'div'
    return 'other'


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


MIN_CTRL = 10           # 對照組少於 10 檔 ⛔ 不算(V80.1.8:股東會停券擠在同幾天,「沒停券又融券多」只剩 2~3 檔 → 被一兩檔暴漲股拉走)


def study(stocks, cal, events_by_sym, windows=WINDOWS, top=TOP):
    """stocks = {代號: (K, 日期→位置, 發行股數, 股利)};events_by_sym = {代號: [(開始日, 結束日, 原因)]}。
    回 res[(窗口, 組別, 對照)] = [(年, 異常報酬)]。組別:hi(事件股裡、當天融券比例在全部股票前 top% 的)/ all(全部事件股),
    再照停券原因分一次(hi@agm …)。對照(⭐ 都是同一天、同一個窗口):
      all = 全部股票平均
      hi  = 前後 QUIET 天沒有停券、融券同樣在前 top% 的股票(⚠️ 少於 MIN_CTRL 檔不算)
      lo  = ⭐ 同一天也被停券、但融券比例在中位數以下的股票(⚠️ 少於 MIN_CTRL 檔不算)—— 分開「被逼著回補」跟「停券那個季節本身」;
            配安慰劑(整段挪 SHIFT 天,同一批股票)扣掉「融券多的本來就比融券少的會漲」:效果 = lo_real − lo_sham。"""
    ev_days = {}                         # 代號 → [事件位置](對照 hi 要排掉)
    ev_at = {'real': {}, 'sham': {}}     # 事件位置 → [代號](對照 lo 用)
    for s, evs in events_by_sym.items():
        seen = set()
        for d, _, _ in evs:
            i = event_index(cal, d)
            if i is None:
                continue
            ev_days.setdefault(s, []).append(i)
            if i in seen or s not in stocks:
                continue
            seen.add(i)
            ev_at['real'].setdefault(i, []).append(s)
            ev_at['sham'].setdefault(i + SHIFT, []).append(s)
    res = {}
    cache = {}

    def day(base, w):
        """同一天同一窗口 → (全部平均, 融券門檻 cut, 對照 hi, {tag: 對照 lo});算不出 → None。"""
        key = (base, w)
        if key in cache:
            return cache[key]
        ra, a, b = cal[base + RANK_AT] if base + RANK_AT >= 0 else None, base + w[0], base + w[1]
        if ra is None or a < 1 or b >= len(cal):
            cache[key] = None
            return None
        all_x, qx = [], {}
        for s, (K, ki, sh, dv) in stocks.items():
            ia, ib, jr = ki.get(cal[a]), ki.get(cal[b]), ki.get(ra)
            if ia is None or ib is None:
                continue
            x = win_ret(K, ia, ib, dv)
            if x is None:
                continue
            all_x.append(x)
            q = short_ratio(K, jr, sh)
            if q is not None:
                qx[s] = (q, x)
        if len(all_x) < 30 or len(qx) < 30:
            cache[key] = None
            return None
        qs = sorted((q for q, _ in qx.values()), reverse=True)
        cut = qs[max(1, int(len(qs) * top)) - 1]
        med = qs[len(qs) // 2]
        hi_x = [x for s, (q, x) in qx.items() if q >= cut and all(abs(i - base) > QUIET for i in ev_days.get(s, []))]
        lo = {}
        for tag in ('real', 'sham'):
            lx = [qx[s][1] for s in ev_at[tag].get(base, []) if s in qx and qx[s][0] <= med]
            lo[tag] = mean(lx) if len(lx) >= MIN_CTRL else None
        cache[key] = (mean(all_x), cut, mean(hi_x) if len(hi_x) >= MIN_CTRL else None, lo)
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
            rc = reason_cls(why)
            for tag, base in (('real', ie), ('sham', ie + SHIFT)):
                if base + RANK_AT < 0:
                    continue
                jr = ki.get(cal[base + RANK_AT])
                q = short_ratio(K, jr, sh)
                for w, wd in windows.items():
                    c = day(base, wd)
                    a, b = base + wd[0], base + wd[1]
                    if c is None or a < 1 or b >= len(cal):
                        continue
                    ia, ib = ki.get(cal[a]), ki.get(cal[b])
                    if ia is None or ib is None:
                        continue
                    x = win_ret(K, ia, ib, dv)
                    if x is None:
                        continue
                    ca, cut, chi, lo = c
                    y = cal[base][:4]
                    grp = ['all'] + (['hi'] if (q is not None and q >= cut) else [])
                    for g0 in grp:
                        for g in (g0, g0 + '@' + rc):           # 再照停券原因分一次(股東會 / 除權息 / 其他)
                            res.setdefault((w, g, 'all_' + tag), []).append((y, x - ca))
                            if chi is not None:
                                res.setdefault((w, g, 'hi_' + tag), []).append((y, x - chi))
                            if lo.get(tag) is not None:
                                res.setdefault((w, g, 'lo_' + tag), []).append((y, x - lo[tag]))
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
        for g, lab in (('hi', f'融券前 {int(TOP * 100)}%'), ('all', '全部停券股'),
                       ('hi@agm', f'融券前 {int(TOP * 100)}%・股東會'), ('hi@div', f'融券前 {int(TOP * 100)}%・除權息'),
                       ('all@agm', '全部・股東會'), ('all@div', '全部・除權息')):
            line = []
            for c, clab in (('lo_real', '⭐比同一天融券少的停券股'), ('lo_sham', '安慰劑(挪 60 天)'),
                            ('all_real', '比全部'), ('all_sham', '安慰劑'), ('hi_real', '比同樣融券多、沒停券')):
                j = judge(res.get((w, g, c), []))
                summary[f'{w}_{g}_{c}'] = j
                if j.get('n'):
                    line.append(f'{clab} {j["m"]:+.2f}%(n={j["n"]},t={j["t"]:.1f})')
            jm = summary.get(f'{w}_{g}_lo_real') or {}
            js = summary.get(f'{w}_{g}_lo_sham') or {}
            extra = (f' ・扣安慰劑 {jm["m"] - js.get("m", 0):+.2f} ・前後半 {jm["h1"]:+.2f}/{jm["h2"]:+.2f} ・逐年 {jm["yr"][0]}/{jm["yr"][1]}'
                     f' ・中位 {jm["med"]:+.2f} ・贏的比例 {jm["pos"] * 100:.0f}%' if jm.get('n') else '')
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

    def synth(ev_boost, hi_boost, seed=5, crowd=False):
        rnd = random.Random(seed)
        n_day = 1600
        cal_ = [(date(2016, 1, 4) + timedelta(days=k)).isoformat() for k in range(n_day)]
        stocks, events = {}, {}
        ev_at = list(range(150, 1500, 70))
        for k in range(200):
            sym = str(1000 + k)
            hi = k < 40                                    # 前 40 檔融券多(比例 5%)、其他 0.5%
            evs = [i for i in ev_at if (k % 5 == 0)] if k < 120 else []   # 每 5 檔有一檔有停券事件
            if crowd:                                       # 股東會那種擠在同一天:融券多的 40 檔裡 35 檔都在停券 → 沒停券的只剩 5 檔
                evs = list(ev_at) if (k < 35 or (k < 120 and k % 5 == 0)) else []
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
    ok('② 停券原因分類:股東常會 / 除息・除權息・除權、息・現增除權 / 現金增資・減資',
       [reason_cls(x) for x in ('股東常會', '股東臨時會', '除息', '除權息', '除權、息', '現增除權', '現金增資', '減資', '')]
       == ['agm', 'agm', 'div', 'div', 'div', 'div', 'other', 'other', 'other'])
    r = synth(True, False)
    ok('② 照原因分組:事件全是股東常會 → 「股東會」那組 == 全部那組(逐筆相同)、除權息那組沒有',
       r[('pre10', 'hi@agm', 'hi_real')] == r[('pre10', 'hi', 'hi_real')] and ('pre10', 'hi@div', 'hi_real') not in r)
    m = mean([x for _, x in r[('pre10', 'hi', 'hi_real')]])
    ms = mean([x for _, x in r[('pre10', 'hi', 'hi_sham')]])
    ok('③ 注入「停券前 10 天融券多的有回補買盤」→ 量得到(≈ +4%)、安慰劑 ≈ 0', 2.5 < m < 5.5 and abs(ms) < 1.5, (m, ms))
    r2 = synth(False, True)
    m_all = mean([x for _, x in r2[('pre10', 'hi', 'all_real')]])
    m_hi = mean([x for _, x in r2[('pre10', 'hi', 'hi_real')]])
    ok('④ 決定性對照:融券多本身就會漲、跟停券無關 → 比全部 > 0、比同樣融券多 ≈ 0', m_all > 1.0 and abs(m_hi) < 1.0, (m_all, m_hi))
    ml, mls = mean([x for _, x in r[('pre10', 'hi', 'lo_real')]]), mean([x for _, x in r[('pre10', 'hi', 'lo_sham')]])
    ok('⑤ ⭐ 新對照「同一天也停券、融券少的」:注入回補買盤 → 量得到(≈ +4%)、安慰劑 ≈ 0', 2.5 < ml < 5.5 and abs(mls) < 1.5, (ml, mls))
    l2, l2s = mean([x for _, x in r2[('pre10', 'hi', 'lo_real')]]), mean([x for _, x in r2[('pre10', 'hi', 'lo_sham')]])
    ok('⑤ ⭐ 決定性對照:融券多本身就會漲 → 比融券少的停券股是正的(≈ +2%),但挪 60 天的安慰劑一樣多 → 扣掉 ≈ 0',
       l2 > 1.0 and abs(l2 - l2s) < 1.0, (l2, l2s))
    r3 = synth(True, False, crowd=True)
    ok('⑥ 對照組少於 10 檔 ⛔ 不算(股東會那種擠在同一天:沒停券、融券又多的只剩 5 檔 → 「比同樣融券多、沒停券」整組不出現)',
       ('pre10', 'hi', 'hi_real') not in r3 and ('pre10', 'hi', 'lo_real') in r3, sorted(k for k in r3 if k[0] == 'pre10' and k[1] == 'hi'))
    print(('\n❌ selftest 失敗 ' + str(bad)) if bad else '\n✅ selftest 全過')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
