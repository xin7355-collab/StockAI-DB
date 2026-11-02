#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📊 index_rebal_probe.py —— 臺灣 50 成分股調整:被納入 / 被剔除的股票,公告前後與生效後漲跌(V80.1.7,計畫 B3)

使用者(2026-11-01):「早知道先機,贏多一點少輸一點」→ 換一個問題:**誰被規則逼著一定要買或賣,時間事先公開**。
追蹤臺灣 50 的 ETF(0050 / 006208)一定要在生效那天收盤照指數買賣 → 看三段:
  pre   公告前 20 天(生效日前第 29 ~ 第 10 個交易日)—— 「事先猜中」的上限(用事後的名單 = 完美預知,⛔ 不是做得到的成績)
  ann   公告後到生效(第 9 個交易日前開盤買 → 生效那天收盤賣)—— 公告是公開的,誰都做得到
  post  生效後 5 / 20 天(生效隔天開盤買)—— 被動買盤走了之後會不會回吐
對照組:同一個窗口、**同一段市值**(生效前 30 天市值排名 31~100,扣掉這一次被調整的)的股票平均 —— ⛔ 只比全部股票會把「大型股效應」
  算成指數效應(主動式 ETF 那次的教訓);另外也印「全部股票」當參考。
安慰劑:同一批股票、整個時間軸往後挪 6 個月(那時候沒有調整)—— 量的是這些股票自己的動能,⛔ 不是調整。

資料:
  TW50_TSV  維基「臺灣50指數」調整表(macro_probe.yml which=index_rebal 印出來的,2003 起 71 次;⚠️ 群眾編輯,
            2026-09 那次對過新聞:藥華藥納入 / 世芯-KY 刪除、9/4 公告、9/18 收盤後生效)
  DATA_DIR  d16m_fi(含下市,K 線 2010 起;^TWII.json 當交易日曆;_div16.json 股利)
  SHARE_DIR stock_deep/share 解開的資料夾(NumberOfSharesIssued,2010 起)→ 市值 = 收盤 × 發行股數
規則(富時羅素 / 臺灣指數公司,新聞對過三次):審核月第三個星期五收盤後生效(那天休市 → 往前一個交易日,例 2026-06-18 週四);
  公告約在生效前 2 週(2026-09-04 → 9-18)→ 這裡用「生效日前第 10 個交易日收盤後公告」,第 9 個交易日開盤才買得到。
  ⚠️ 2010 以前的公告日沒有逐次查;K 線也只從 2010 起 → 2010 年 1 月以前的不算。
鎖漲跌停買不到(lib_limit.locked_bar,2015-06 前 ±7%)、價格斷崖(lib_limit.cliff_in)的窗口剔除;股利照 _div16 補回。

--selftest:解析維基表、第三個星期五、窗口、對照組、安慰劑方向(不用網路、不用資料)。
"""
import json
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib_limit as LL                       # noqa: E402  ⭐ 漲跌停 / 斷崖只有一份
from window_dress_probe import load_k, load_shares, shares_on, div_factor, mean, tstat   # noqa: E402  ⭐ 讀檔與統計只有一份

COST = 0.44
WINDOWS = {'pre': (-29, -10), 'ann': (-9, 0), 'post5': (1, 5), 'post20': (1, 20)}
# 🧪 WINS='名字:a:b[:c],…' 換一組窗口(高原檢定用);第 4 欄 c = 前一天收盤買(⛔ 預設開盤買)
if os.getenv('WINS'):
    WINDOWS = {}
    for _w in os.getenv('WINS').split(','):
        _p = _w.split(':')
        WINDOWS[_p[0]] = (int(_p[1]), int(_p[2])) + ((_p[3],) if len(_p) > 3 else ())
BAND = (31, 100)          # 對照組:市值排名 31~100
RANK_AT = -30             # 市值排名用生效前第 30 個交易日收盤(⛔ 用到窗口裡的價格)
SHIFT = 126               # 安慰劑:往後挪 126 個交易日(約 6 個月)


# ───────────────────────── 純函式(--selftest) ─────────────────────────
def parse_wiki(text):
    """維基調整表(TSV:日期 / 納入 / 剔除)→ [{'ym','add','rm'}];代號 = 格子裡每一段開頭的 4~6 碼,「?」不算。"""
    out = []
    for line in (text or '').splitlines():
        parts = line.split('\t')
        if len(parts) < 3:
            continue
        m = re.match(r'(\d{4})年(\d{1,2})月', parts[0].strip())
        if not m:
            continue
        codes = lambda cell: [c for c in (re.match(r'\s*(\d{4,6}[A-Z]?)\b', seg).group(1) for seg in cell.split('|')
                                          if re.match(r'\s*(\d{4,6}[A-Z]?)\b', seg))]
        out.append({'ym': f'{int(m.group(1)):04d}-{int(m.group(2)):02d}', 'add': codes(parts[1]), 'rm': codes(parts[2])})
    return out


def third_friday(y, m):
    d = date(y, m, 1)
    d += timedelta(days=(4 - d.weekday()) % 7)      # 第一個星期五
    return d + timedelta(days=14)


def eff_index(cal, ym):
    """生效日在交易日曆裡的位置 = 那個月第三個星期五(含)以前最後一個交易日;同一個月裡找不到 → None。"""
    y, m = int(ym[:4]), int(ym[5:7])
    tf = third_friday(y, m).isoformat()
    lo, hi = 0, len(cal) - 1
    best = None
    while lo <= hi:
        md = (lo + hi) // 2
        if cal[md] <= tf:
            best = md
            lo = md + 1
        else:
            hi = md - 1
    if best is None or cal[best][:7] != ym:
        return None
    return best


def win_ret(K, ki, ia, ib, divs, mode='o'):
    """K 線位置 ia 開盤買(mode='c':ia 前一天收盤買)→ ib 收盤賣(含股利),% ;資料不夠 / 買不到 / 斷崖 → None。"""
    if ia < 1 or ib >= len(K['d']) or ib < ia:
        return None
    if mode == 'c':
        if ia < 2 or LL.up_limit_close(K['d'][ia - 1], K['c'][ia - 1], K['c'][ia - 2]):
            return None                       # 收盤停在漲停價 → 收盤買不到
    elif LL.locked_bar(K['d'][ia], K['c'][ia - 1], K['o'][ia], K['h'][ia], K['l'][ia]) != 0:
        return None
    pre = K.get('_cliff')
    if pre is None:
        pre = K['_cliff'] = LL.cliff_prefix(K['c'], K['o'])
    if LL.cliff_in(pre, ia - 1, ib):
        return None
    if mode == 'c':
        f = div_factor(divs, K['d'][ia - 1], K['d'][ib])
        return (K['c'][ib] * f / K['c'][ia - 1] - 1) * 100
    f = div_factor(divs, K['d'][ia], K['d'][ib])
    return (K['c'][ib] * f / K['o'][ia] - 1) * 100


def map_window(K, ki, cal, ie, w):
    """日曆上的窗口(相對生效日 ie)→ 這一檔 K 線的位置;那幾天這一檔沒交易 → None(⛔ 用別天湊)。"""
    a, b = ie + w[0], ie + w[1]
    if a < 0 or b >= len(cal):
        return None
    ia, ib = ki.get(cal[a]), ki.get(cal[b])
    if ia is None or ib is None:
        return None
    return ia, ib


def judge(xs, cost=COST, side='add'):
    """xs = [(年, 異常報酬)];回 {'n','m','t','h1','h2','yr','after_cost'}。after_cost:被納入那邊扣一買一賣成本後還 > 0。"""
    v = [x for _, x in xs]
    if not v:
        return {'n': 0}
    yrs = sorted({y for y, _ in xs})
    half = yrs[len(yrs) // 2] if yrs else ''
    h1 = mean([x for y, x in xs if y < half]) if half else float('nan')
    h2 = mean([x for y, x in xs if y >= half]) if half else float('nan')
    by = {}
    for y, x in xs:
        by.setdefault(y, []).append(x)
    m = mean(v)
    same = sum(1 for y in by if (mean(by[y]) > 0) == (m > 0))
    sv = sorted(v)
    k = int(len(sv) * 0.05)
    trim = mean(sv[k:len(sv) - k]) if len(sv) - 2 * k > 0 else m
    return {'n': len(v), 'm': m, 't': tstat(v), 'h1': h1, 'h2': h2, 'yr': (same, len(by)),
            'med': sv[len(sv) // 2], 'pos': sum(1 for x in v if x > 0) / len(v), 'trim': trim,
            'after_cost': (m - cost) if side == 'add' else None}


def study(stocks, cal, reviews):
    """核心:每一次調整 × 每個窗口,被調整的股票報酬 − 同市值對照組平均(另算全部股票、安慰劑)。
    stocks = {代號: (K, 日期→位置, 發行股數, 股利)};回 (res, per_review, ranks_seen)。⭐ selftest 直接打這一支。"""
    def rank_at(i):
        caps = []
        d = cal[i]
        for s, (K, ki, sh, _) in stocks.items():
            j = ki.get(d)
            if j is None or not sh:
                continue
            n = shares_on(sh, d)
            if n:
                caps.append((K['c'][j] * n, s))
        caps.sort(reverse=True)
        return {s: k + 1 for k, (_, s) in enumerate(caps)}

    res = {(w, side, kind): [] for w in WINDOWS for side in ('add', 'rm') for kind in ('band', 'all', 'sham')}
    per_review = {(w, side): [] for w in WINDOWS for side in ('add', 'rm')}
    ranks_seen = {'add': [], 'rm': []}
    for r in reviews:
        ie = r['ie']
        rk = rank_at(ie + RANK_AT)
        evs = set(r['add'] + r['rm'])
        band = [s for s, k in rk.items() if BAND[0] <= k <= BAND[1] and s not in evs]
        for side in ('add', 'rm'):
            for s in r[side]:
                if s in rk:
                    ranks_seen[side].append(rk[s])
        for w, wd in WINDOWS.items():
            for shift_tag, base in (('real', ie), ('sham', ie + SHIFT)):
                if base + wd[1] >= len(cal):
                    continue
                ctrl_b, ctrl_a = [], []
                for s in band:
                    K, ki, _, dv = stocks[s]
                    mp = map_window(K, ki, cal, base, wd)
                    x = win_ret(K, ki, *mp, dv, wd[2] if len(wd) > 2 else 'o') if mp else None
                    if x is not None:
                        ctrl_b.append(x)
                for s, (K, ki, _, dv) in stocks.items():
                    mp = map_window(K, ki, cal, base, wd)
                    x = win_ret(K, ki, *mp, dv, wd[2] if len(wd) > 2 else 'o') if mp else None
                    if x is not None:
                        ctrl_a.append(x)
                if len(ctrl_b) < 10:
                    continue
                cb, ca = mean(ctrl_b), mean(ctrl_a)
                for side in ('add', 'rm'):
                    xs = []
                    for s in r[side]:
                        if s not in stocks:
                            continue
                        K, ki, _, dv = stocks[s]
                        mp = map_window(K, ki, cal, base, wd)
                        x = win_ret(K, ki, *mp, dv, wd[2] if len(wd) > 2 else 'o') if mp else None
                        if x is None:
                            continue
                        if shift_tag == 'real':
                            res[(w, side, 'band')].append((r['ym'][:4], x - cb))
                            res[(w, side, 'all')].append((r['ym'][:4], x - ca))
                            xs.append(x - cb)
                        else:
                            res[(w, side, 'sham')].append((r['ym'][:4], x - cb))
                    if xs and shift_tag == 'real':
                        per_review[(w, side)].append(mean(xs))
    return res, per_review, ranks_seen


# 🔮 「事先猜得到嗎」:成分倒推 + 市值排名規則(富時:非成分 ≤ 40 名納入、成分 ≥ 61 名剔除)
ALIAS = (('3711', '2311', '2018-04-30'), ('5880', '5854', '2011-12-01'))   # 代號換過:這一天以前用舊代號(日月光投控、合庫金)
CUT_AT = -19            # 審核資料日 ≈ 生效前第 19 個交易日(2026-09:8/24 → 9/18)
SIM_WINDOWS = {'ant_ann': (-18, -10), 'ant_eff': (-18, 0)}   # 資料日隔天開盤買 → 公告那天收盤 / 生效那天收盤賣


def members_before(current, reviews):
    """從目前的成分往回推:每次調整「之前」的成分 = 之後 − 納入 + 剔除(reviews 任意順序,照 ym 由新到舊推)。
    回 {ym: 調整前成分 set};另回 [(ym, 檔數)] 不是 50 檔的(維基漏記 / 代號換過 → 印出來,⛔ 硬補)。"""
    cur = set(current)
    out, odd = {}, []
    for r in sorted(reviews, key=lambda x: x['ym'], reverse=True):
        before = (cur - set(r['add'])) | set(r['rm'])
        out[r['ym']] = before
        if len(before) != 50:
            odd.append((r['ym'], len(before)))
        cur = before
    return out, odd


def alias_set(ms, d):
    """日期 d 以前,把新代號換回舊代號(那時候 K 線 / 發行股數用的是舊代號)。"""
    ms = set(ms)
    for new, old, since in ALIAS:
        if d < since and new in ms:
            ms.discard(new)
            ms.add(old)
    return ms


def cap_rank(stocks, cal, i):
    caps = []
    d = cal[i]
    for s, (K, ki, sh, _) in stocks.items():
        j = ki.get(d)
        if j is None or not sh:
            continue
        n = shares_on(sh, d)
        if n:
            caps.append((K['c'][j] * n, s))
    caps.sort(reverse=True)
    return {s: k + 1 for k, (_, s) in enumerate(caps)}


def predict(rank, members, add_at=40, rm_at=61):
    """照排名規則猜:非成分排名 ≤ add_at → 納入;成分排名 ≥ rm_at(或排不到)→ 剔除。"""
    add = sorted(s for s, k in rank.items() if k <= add_at and s not in members)
    rm = sorted(s for s in members if rank.get(s, 10 ** 6) >= rm_at)
    return add, rm


def simulate(stocks, cal, reviews, mb, windows=SIM_WINDOWS):
    """每次調整:審核資料日排名 → 猜誰進誰出 → 命中率 + 照猜的買(資料日隔天開盤)比同市值。"""
    hits = []
    res = {}
    for r in reviews:
        ie = r['ie']
        ic = ie + CUT_AT
        if ic < 1 or r['ym'] not in mb:
            continue
        d = cal[ic]
        mem = alias_set(mb[r['ym']], d)
        act_add = alias_set(r['add'], d)
        act_rm = alias_set(r['rm'], d)
        rk = cap_rank(stocks, cal, ic)
        p_add, p_rm = predict(rk, mem)
        hits.append({'ym': r['ym'], 'p_add': p_add, 'a_add': sorted(act_add), 'p_rm': p_rm, 'a_rm': sorted(act_rm)})
        band = [s for s, k in rk.items() if BAND[0] <= k <= BAND[1] and s not in set(p_add) | act_add | set(p_rm) | act_rm]
        for w, wd in windows.items():
            cb = []
            for s in band:
                K, ki, _, dv = stocks[s]
                mp = map_window(K, ki, cal, ie, wd)
                x = win_ret(K, ki, *mp, dv) if mp else None
                if x is not None:
                    cb.append(x)
            if len(cb) < 10:
                continue
            c = mean(cb)
            for tag, group in (('pred_add', p_add), ('pred_add_hit', [x for x in p_add if x in act_add]),
                               ('pred_add_miss', [x for x in p_add if x not in act_add]), ('pred_rm', p_rm)):
                for s in group:
                    if s not in stocks:
                        continue
                    K, ki, _, dv = stocks[s]
                    mp = map_window(K, ki, cal, ie, wd)
                    x = win_ret(K, ki, *mp, dv) if mp else None
                    if x is not None:
                        res.setdefault((w, tag), []).append((r['ym'][:4], x - c))
    return hits, res


# ───────────────────────── 主程式 ─────────────────────────
def main():
    S = os.getenv
    data = Path(S('DATA_DIR') or 'd16m_fi')
    share_dir = Path(S('SHARE_DIR') or 'stock_deep/share')
    tsv = Path(S('TW50_TSV') or 'tw50_wiki.tsv')
    out_path = S('OUT') or ''
    ev = parse_wiki(tsv.read_text(encoding='utf-8'))
    calK = load_k(data / '^TWII.json')
    if not calK or not ev:
        print('❌ 讀不到交易日曆或調整表')
        return 1
    cal = calK['d']
    divj = json.loads((data / '_div16.json').read_text(encoding='utf-8'))['d']
    reviews = []
    for e in ev:
        ie = eff_index(cal, e['ym'])
        if ie is None or ie + RANK_AT < 1:          # ⛔ 每組窗口都用同一批調整(排名日要在資料裡)
            continue
        reviews.append(dict(e, ie=ie))
    print(f'📅 日曆 {cal[0]} ~ {cal[-1]} ・維基調整 {len(ev)} 次 ・K 線涵蓋得到的 {len(reviews)} 次'
          f'(納入 {sum(len(r["add"]) for r in reviews)} / 剔除 {sum(len(r["rm"]) for r in reviews)})', flush=True)
    # 讀全部個股(含下市)+ 發行股數
    stocks = {}
    for p in sorted(data.glob('*.json')):
        if not re.match(r'^\d{4}$', p.stem):
            continue
        K = load_k(p)
        if not K:
            continue
        stocks[p.stem] = (K, {d: i for i, d in enumerate(K['d'])}, load_shares(share_dir, p.stem),
                          [(r[0], r[3], r[4]) for r in (divj.get(p.stem) or {}).get('h', []) if len(r) >= 5])
    print(f'📦 個股 {len(stocks)} 檔(有發行股數 {sum(1 for v in stocks.values() if v[2])} 檔)', flush=True)
    miss = sorted({c for r in reviews for c in r['add'] + r['rm'] if c not in stocks})
    if miss:
        print(f'⚠️ 調整表裡有 {len(miss)} 檔 K 線沒有(那幾筆不算):{miss}', flush=True)

    res, per_review, ranks_seen = study(stocks, cal, reviews)
    for side in ('add', 'rm'):
        v = sorted(ranks_seen[side])
        if v:
            print(f'🏷️ {"納入" if side == "add" else "剔除"}的股票在生效前 30 天的市值排名:中位 {v[len(v) // 2]} ・最小 {v[0]} ・最大 {v[-1]}(n={len(v)})', flush=True)
    summary = {}
    for w in WINDOWS:
        for side in ('add', 'rm'):
            jb = judge(res[(w, side, 'band')], side=side)
            ja = judge(res[(w, side, 'all')], side=side)
            js = judge(res[(w, side, 'sham')], side=side)
            pr = per_review[(w, side)]
            key = f'{w}_{side}'
            summary[key] = {'band': jb, 'all': ja, 'sham': js, 'review_m': mean(pr) if pr else None,
                            'review_t': tstat(pr) if len(pr) > 2 else None, 'reviews': len(pr)}
            if not jb.get('n'):
                continue
            lab = '納入' if side == 'add' else '剔除'
            ac = f' ・扣成本 {jb["after_cost"]:+.2f}' if jb.get('after_cost') is not None else ''
            print(f'{w:<6} {lab}:比同市值 {jb["m"]:+.2f}%(n={jb["n"]},t={jb["t"]:.1f}{ac})・比全部股票 {ja["m"]:+.2f}%'
                  f' ・每次調整平均 {summary[key]["review_m"]:+.2f}%(t={(summary[key]["review_t"] or 0):.1f},{len(pr)} 次)'
                  f' ・前後半 {jb["h1"]:+.2f}/{jb["h2"]:+.2f} ・逐年 {jb["yr"][0]}/{jb["yr"][1]}'
                  f' ・安慰劑(挪 6 個月){js.get("m", float("nan")):+.2f}%(n={js.get("n", 0)})'
                  f' ・中位 {jb["med"]:+.2f} ・贏的比例 {jb["pos"] * 100:.0f}% ・去頭尾 5% {jb["trim"]:+.2f}', flush=True)
    mem_path = S('TW50_MEMBERS') or ''
    if mem_path:
        cur = re.findall(r'(?<!\d)(\d{4})(?!\d)', re.sub(r'#[^\n]*', '', Path(mem_path).read_text(encoding='utf-8')))
        mb, odd = members_before(cur, reviews)
        print(f'\n🔮 事先猜得到嗎(目前成分 {len(set(cur))} 檔往回推;不是 50 檔的調整:{odd[:8] or "沒有"})', flush=True)
        hits, sres = simulate(stocks, cal, reviews, mb)
        pa = sum(len(h['p_add']) for h in hits)
        aa = sum(len(h['a_add']) for h in hits)
        ha = sum(len(set(h['p_add']) & set(h['a_add'])) for h in hits)
        pr_ = sum(len(h['p_rm']) for h in hits)
        ar = sum(len(h['a_rm']) for h in hits)
        hr = sum(len(set(h['p_rm']) & set(h['a_rm'])) for h in hits)
        print(f'   納入:猜 {pa} 檔、真的 {aa} 檔、猜中 {ha} 檔(猜的裡面 {ha / max(pa, 1) * 100:.0f}% 對、真的裡面 {ha / max(aa, 1) * 100:.0f}% 猜得到)', flush=True)
        print(f'   剔除:猜 {pr_} 檔、真的 {ar} 檔、猜中 {hr} 檔(猜的裡面 {hr / max(pr_, 1) * 100:.0f}% 對、真的裡面 {hr / max(ar, 1) * 100:.0f}% 猜得到)', flush=True)
        for h in hits[-6:]:
            print(f'   {h["ym"]}:猜進 {h["p_add"]} / 真進 {h["a_add"]} ・猜出 {h["p_rm"]} / 真出 {h["a_rm"]}', flush=True)
        for (w, tag), xs in sorted(sres.items()):
            j = judge(xs)
            if j.get('n'):
                summary[f'sim_{w}_{tag}'] = j
                print(f'   {w:<8} {tag:<14}:比同市值 {j["m"]:+.2f}%(n={j["n"]},t={j["t"]:.1f},扣成本 {j["after_cost"]:+.2f})'
                      f' ・前後半 {j["h1"]:+.2f}/{j["h2"]:+.2f} ・逐年 {j["yr"][0]}/{j["yr"][1]} ・中位 {j["med"]:+.2f} ・贏的比例 {j["pos"] * 100:.0f}%', flush=True)
        summary['sim_hits'] = {'pred_add': pa, 'act_add': aa, 'hit_add': ha, 'pred_rm': pr_, 'act_rm': ar, 'hit_rm': hr, 'odd': odd}
    if out_path:
        Path(out_path).write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=float), encoding='utf-8')
    return 0


def selftest():
    bad = []

    def ok(n, c, e=''):
        print(('✅ ' if c else '❌ ') + n + ('' if c else '  ' + str(e)[:200]))
        if not c:
            bad.append(n)
    t = ('日期\t納入指數\t剔除指數\n2003年4月\t?\t2363 矽統 | 2376 技嘉\n'
         '2026年6月\t3443 創意 | 4958 臻鼎KY\t1301 台塑 | 6919 康霈*\n2020年9月\t6415 矽力*-KY\t2888 新光金(已下市)\n')
    ev = parse_wiki(t)
    ok('① 維基表:「?」不算、代號取每一段開頭、月份補零',
       ev == [{'ym': '2003-04', 'add': [], 'rm': ['2363', '2376']},
              {'ym': '2026-06', 'add': ['3443', '4958'], 'rm': ['1301', '6919']},
              {'ym': '2020-09', 'add': ['6415'], 'rm': ['2888']}], ev)
    ok('② 第三個星期五(2026-09-18 / 2023-12-15 / 2026-06-19)',
       (third_friday(2026, 9), third_friday(2023, 12), third_friday(2026, 6)) == (date(2026, 9, 18), date(2023, 12, 15), date(2026, 6, 19)))
    cal = ['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-22', '2026-09-17', '2026-09-18', '2026-09-21']
    ok('② 生效日:那天休市 → 往前一個交易日(2026-06-18 週四,新聞對得上)', cal[eff_index(cal, '2026-06')] == '2026-06-18')
    ok('② 生效日:2026-09-18', cal[eff_index(cal, '2026-09')] == '2026-09-18')
    ok('② 那個月沒有交易日 → None', eff_index(cal, '2026-07') is None)
    K = {'d': ['2015-07-01', '2015-07-02', '2015-07-03', '2015-07-06'], 'o': [10, 10, 11, 11.5], 'h': [10, 10.5, 11.2, 12],
         'l': [10, 9.9, 10.8, 11.4], 'c': [10, 10.2, 11, 12], 'v': [1] * 4, 't': [None] * 4}
    ki = {d: i for i, d in enumerate(K['d'])}
    ok('③ 窗口報酬 = 開盤買 → 收盤賣', abs(win_ret(K, ki, 1, 3, []) - 20.0) < 1e-9, win_ret(K, ki, 1, 3, []))
    ok('③ 窗口裡除息要補回(2015-07-03 除息 前價 11 參考價 10)', abs(win_ret(K, ki, 1, 3, [('2015-07-03', 11, 10)]) - 32.0) < 1e-9)
    K2 = dict(K, o=[10, 11, 11, 11.5], h=[10, 11, 11.2, 12], l=[10, 11, 10.8, 11.4])
    K2.pop('_cliff', None)
    ok('④ 進場那天開盤鎖漲停(買不到)→ None', win_ret(K2, ki, 1, 3, []) is None)
    K3 = dict(K, c=[10, 10.2, 20, 21], o=[10, 10, 20, 20.5], h=[10, 10.5, 20, 21], l=[10, 9.9, 19, 20])
    K3.pop('_cliff', None)
    ok('④ 窗口裡有價格斷崖(×1.96)→ None', win_ret(K3, ki, 1, 3, []) is None)
    calx = ['d0', 'd1', 'd2', 'd3']
    Kx = {'d': ['d0', 'd1', 'd3'], 'o': [1, 1, 1], 'c': [1, 1, 1]}
    ok('⑤ 那幾天這一檔沒交易 → None(⛔ 用別天湊)', map_window(Kx, {d: i for i, d in enumerate(Kx['d'])}, calx, 2, (0, 1)) is None)
    j = judge([('2012', 2.0), ('2013', 1.0), ('2020', 3.0), ('2021', -1.0)])
    ok('⑥ 判定:平均 / 前後半 / 逐年同向 / 扣成本', abs(j['m'] - 1.25) < 1e-9 and j['yr'] == (3, 4) and abs(j['after_cost'] - 0.81) < 1e-9
       and abs(j['h1'] - 1.5) < 1e-9 and abs(j['h2'] - 1.0) < 1e-9, j)
    ok('⑥ 剔除那邊不算扣成本(散戶放空不實際)', judge([('2012', -1.0)], side='rm')['after_cost'] is None)
    import random

    def synth(boost_events, boost_all, seed=11):
        rnd = random.Random(seed)
        ie_list = list(range(300, 300 + 20 * 150, 150))          # 20 次調整、每次隔 150 天(安慰劑挪 126 天不會撞到下一次)
        n_day = ie_list[-1] + 200
        cal_ = [(date(2012, 1, 2) + timedelta(days=k)).isoformat() for k in range(n_day)]
        reviews_ = []
        st = {}
        evs = {ie: ([f'{9000 + 4 * j + q}' for q in range(4)], [f'{9500 + 2 * j + q}' for q in range(2)]) for j, ie in enumerate(ie_list)}
        syms = [str(1000 + k) for k in range(130)] + [c for a, r in evs.values() for c in a + r]
        for k, sym in enumerate(syms):
            c, cs, os_ = 100.0, [], []
            for t in range(n_day):
                r = rnd.gauss(0, 0.006)
                for ie in ie_list:
                    a, b = ie + WINDOWS['ann'][0], ie + WINDOWS['ann'][1]
                    if a <= t <= b:
                        if boost_all:
                            r += 0.03 / (b - a + 1)
                        if boost_events and sym in evs[ie][0]:
                            r += 0.03 / (b - a + 1)
                o = c
                c = c * (1 + r)
                cs.append(c)
                os_.append(o)
            K_ = {'d': cal_, 'o': os_, 'h': [max(a_, b_) for a_, b_ in zip(os_, cs)], 'l': [min(a_, b_) for a_, b_ in zip(os_, cs)],
                  'c': cs, 'v': [1] * n_day, 't': [None] * n_day}
            # 市值:讓對照組落在 31~100、被調整的股票也有排名
            st[sym] = (K_, {d: i for i, d in enumerate(cal_)}, [(cal_[0], 1e6 * (200 - k))], [])
        for ie in ie_list:
            reviews_.append({'ym': cal_[ie][:7], 'add': evs[ie][0], 'rm': evs[ie][1], 'ie': ie})
        return study(st, cal_, reviews_)
    r1, _, _ = synth(True, False)
    m_ann = mean([x for _, x in r1[('ann', 'add', 'band')]])
    m_pre = mean([x for _, x in r1[('pre', 'add', 'band')]])
    ok('⑦ 注入「公告後被納入的股票多漲 3%」→ 量得到(ann ≈ +3)、公告前 ≈ 0', 2.0 < m_ann < 4.0 and abs(m_pre) < 1.5, (m_ann, m_pre))
    m_sh = mean([x for _, x in r1[('ann', 'add', 'sham')]])
    ok('⑦ 安慰劑(挪 6 個月,那時沒調整)≈ 0', abs(m_sh) < 1.5, m_sh)
    r2, _, _ = synth(False, True)
    m_all = mean([x for _, x in r2[('ann', 'add', 'band')]])
    ok('⑧ 決定性對照:那幾天全部股票都漲 3%(不是指數效應)→ 比同市值 ≈ 0', abs(m_all) < 1.0, m_all)
    cur = [str(1000 + k) for k in range(50)]
    rv = [{'ym': '2026-09', 'add': ['1000'], 'rm': ['9999']}, {'ym': '2026-06', 'add': ['1001', '1002'], 'rm': ['8888', '7777']}]
    mb, odd = members_before(cur, rv)
    ok('⑨ 成分倒推:調整前 = 之後 − 納入 + 剔除(由新到舊推)', '1000' not in mb['2026-09'] and '9999' in mb['2026-09']
       and '1001' not in mb['2026-06'] and {'8888', '7777', '9999'} <= mb['2026-06'] and not odd, (sorted(mb['2026-06'])[:5], odd))
    ok('⑨ 代號換過:2018-04-30 以前 3711 → 2311', alias_set({'3711', '2330'}, '2018-01-02') == {'2311', '2330'} and alias_set({'3711'}, '2019-01-02') == {'3711'})
    p_add, p_rm = predict({'A': 3, 'B': 41, 'C': 40, 'D': 61, 'E': 60}, {'A', 'D', 'E', 'F'})
    ok('⑩ 排名規則:非成分 ≤40 才納入(41 不算)、成分 ≥61 或排不到才剔除', p_add == ['C'] and p_rm == ['D', 'F'], (p_add, p_rm))
    print(('\n❌ selftest 失敗 ' + str(bad)) if bad else '\n✅ selftest 全過')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
