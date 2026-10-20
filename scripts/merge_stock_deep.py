#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🗄️ 把 stock_deep 分支(2010~2021-03 全市場價格 + 除權息 + 融資券)接成回測用的 16 年資料夾 d16(V79.3.8)

為什麼:回測 / 變因研究用的 d10n 在 2010~2020 只有外部 k66(約 1,000 檔、只有上市、只有活到現在的)
→ 上櫃股、下市股整段不在,2011~2020 的橫切面只有 700~1,000 檔 = 倖存者樣本。
stock_deep_backfill.py 把 FinMind 官方日 K(含上櫃、含 2010 後下市)挖回來,這支把它接上去。
⛔ 只寫到**另一個資料夾**(⛔ 不改 data/、不改 d10n);⛔ 不進 App。

接法(照 merge_deep_klines / merge_k66_history 已經走過的路,⛔ 不另訂規則):
  ① 有現成 K 線(dd = data + klines_deep 合併,2021-01 起)的股票:
     用重疊那段(price10 抓到 2021-03 → 重疊約 3 個月)的「現成收盤 ÷ price10 收盤」對齊尺標
     —— 比例要是常數(最大 ÷ 最小 − 1 ≤ 0.5%,跟 stock_deep_backfill 的 check_price 同一個門檻)、
     重疊 ≥ 20 天,才把 price10「比現成最早一天更早」的列乘上比例接到前面;⛔ 不動現成的任何一列。
     接完整條再跑一次 `miner._backadjust_splits`(同一把尺;它只往回調舊的、最新價不動)。
  ② 2021 前就下市(現成沒有)的:price10 單獨成檔,標 `_dl: 1`(≥ 250 根才收)
  ③ 2021 後才下市(klines_deep 標 dl:1、data/ 沒有)的:klines_deep 那段當現成、照 ① 接
  ④ 融資券(stock_deep/margin):只補 `margin_balance` / `short_balance` 是 None 的列(⛔ 實跑寫入優先、⛔ 不補 0)
  ⑤ 除權息(stock_deep/div10)→ 跟 dividends_hist.json 合成一份 `[除權息日, 合計, '權息', 除權息前價, 參考價]`
     (prepStock / factor_panel 只用前價 ÷ 參考價,現金跟配股都涵蓋);同一天兩邊都有 → 以 dividends_hist 為準
  ⑥ 加權 / 0050 / 產業表這些非個股檔 → 從 --base(d10n,真加權 + 0050)原樣複製

⚠️ 沒做的(誠實):減資 / 現增這種「不是整數倍」的斷崖不修(同 data/,⛔ 不猜比例)→ 探針自己有斷崖守門
   (factor_panel 剔除 ±40% 斷崖前後的窗口、leader_probe 的 jump);合併後逐檔數斷崖寫進報告。

跑法:python3 scripts/merge_stock_deep.py --dd $S/dd2 --kd $S/kd/klines_deep --sd $S/sd/stock_deep \\
        --base $S/d10n --out $S/d16 --div-in $S/od/data/dividends_hist.json --div-out $S/d16/_div16.json
      python3 scripts/merge_stock_deep.py --selftest
"""
import argparse
import gzip
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

MIN_OVERLAP = 20
RATIO_TOL = 0.005
MIN_DL_ROWS = 250
CLIFF = (0.67, 1.5)


def _d(s):
    return str(s or '').replace('/', '-')[:10]


def _slash(s):
    return _d(s).replace('-', '/')


def is_stock(sym):
    return len(sym) == 4 and sym.isdigit() and not sym.startswith('0')


def load_gz(p):
    try:
        with gzip.open(p, 'rt', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def p10_rows(pk):
    """price10 / klines_deep 的 {k:[[date,o,h,l,c,v]]} → 日 K 列(date 'YYYY/MM/DD')。"""
    out = []
    for r in (pk or {}).get('k') or []:
        try:
            d, o, h, l, c, v = r[:6]
        except Exception:
            continue
        if c and c > 0 and o and o > 0:
            out.append({'date': _slash(d), 'open': o, 'high': h, 'low': l, 'close': c, 'volume': v or 0})
    return out


def join(base, early, sym):
    """early(2010~2021-03)接到 base 前面。回 (rows, 說明);接不上回 (base, 原因)。"""
    if not base:
        return early, 'only-early'
    bmap = {_d(r['date']): float(r['close']) for r in base if float(r.get('close') or 0) > 0}
    rat = [bmap[_d(r['date'])] / r['close'] for r in early if _d(r['date']) in bmap and r['close'] > 0]
    if len(rat) < MIN_OVERLAP:
        return base, f'overlap={len(rat)}'
    if max(rat) / min(rat) - 1 > RATIO_TOL:
        return base, f'ratio-drift={max(rat) / min(rat) - 1:.4f}'
    k = sorted(rat)[len(rat) // 2]
    first = _d(base[0]['date'])
    pre = [{'date': r['date'], 'open': round(r['open'] * k, 4), 'high': round(r['high'] * k, 4), 'low': round(r['low'] * k, 4),
            'close': round(r['close'] * k, 4), 'volume': round((r['volume'] or 0) / k)} for r in early if _d(r['date']) < first]
    if not pre:
        return base, 'no-earlier'
    import miner
    rows = miner._backadjust_splits(pre + [dict(r) for r in base], sym=sym)
    return rows, f'k={k:.4f}+{len(pre)}'


def cliffs(rows):
    n = 0
    for a, b in zip(rows, rows[1:]):
        c0, c1 = float(a.get('close') or 0), float(b.get('close') or 0)
        if c0 > 0 and c1 > 0 and not (CLIFF[0] <= c1 / c0 <= CLIFF[1]):
            n += 1
    return n


def fill_margin(rows, pk):
    """融資券只補 None 的列(⛔ 實跑寫入優先、⛔ 不補 0)。回補了幾列。"""
    c = (pk or {}).get('c') or []
    if 'MarginPurchaseTodayBalance' not in c:
        return 0
    im, isb = c.index('MarginPurchaseTodayBalance'), (c.index('ShortSaleTodayBalance') if 'ShortSaleTodayBalance' in c else None)
    m = {d: v for d, v in zip(pk.get('d') or [], pk.get('v') or [])}
    n = 0
    for r in rows:
        v = m.get(_d(r.get('date')))
        if not v:
            continue
        hit = False
        if r.get('margin_balance') is None and v[im] is not None:
            r['margin_balance'] = v[im]
            hit = True
        if isb is not None and r.get('short_balance') is None and v[isb] is not None:
            r['short_balance'] = v[isb]
            hit = True
        n += hit
    return n


def div_rows(pk):
    """div10 欄位式 → [[除權息日, 合計, '權息', 前價, 參考價]];前價 / 參考價缺一個就不收(prepStock 要兩個)。"""
    c = (pk or {}).get('c') or []
    if 'before_price' not in c:
        return []
    ib = c.index('before_price')
    ia = c.index('after_price') if 'after_price' in c else (c.index('reference_price') if 'reference_price' in c else None)
    ic = c.index('stock_and_cache_dividend') if 'stock_and_cache_dividend' in c else None
    out = []
    for d, v in zip(pk.get('d') or [], pk.get('v') or []):
        b = v[ib]
        a = v[ia] if ia is not None else None
        if b and a and b > 0 and a > 0:
            out.append([_d(d), (v[ic] if ic is not None else None) or 0, '權息', b, a])
    return out


def merge_divs(old, new):
    """{sym: [[date,...]]} 兩份合一:同一天以 old 為準。"""
    out = {}
    for sym in set(old) | set(new):
        have = {x[0][:10]: x for x in old.get(sym, [])}
        for x in new.get(sym, []):
            have.setdefault(x[0][:10], x)
        out[sym] = [have[k] for k in sorted(have)]
    return out


def build(dd, kd, sd, base, out, div_in=None, div_out=None, verbose=True):
    dd, kd, sd, base, out = Path(dd), Path(kd), Path(sd), Path(base), Path(out)
    out.mkdir(parents=True, exist_ok=True)
    p10_dir, mg_dir, dv_dir = sd / 'price10', sd / 'margin', sd / 'div10'
    syms = set()
    for p in dd.glob('*.json'):
        if is_stock(p.stem):
            syms.add(p.stem)
    for p in p10_dir.glob('*.json.gz'):
        if is_stock(p.name[:4]):
            syms.add(p.name[:4])
    st = {'joined': 0, 'base_only': 0, 'early_only': 0, 'kd_dl': 0, 'skip_short': 0, 'reasons': {}, 'cliffs': 0, 'cliff_syms': 0, 'margin_rows': 0, 'div_syms': 0}
    for sym in sorted(syms):
        bp = dd / f'{sym}.json'
        base_rows, dl = None, 0
        if bp.exists():
            try:
                base_rows = json.loads(bp.read_text(encoding='utf-8'))
            except Exception:
                base_rows = None
        if not base_rows:
            kp = load_gz(kd / f'{sym}.json.gz')
            if kp and kp.get('dl'):
                base_rows, dl = p10_rows(kp), 1
                st['kd_dl'] += 1
        pk = load_gz(p10_dir / f'{sym}.json.gz')
        early = p10_rows(pk) if pk else []
        if pk and pk.get('dl'):
            dl = 1
        if base_rows and early:
            rows, why = join(base_rows, early, sym)
            key = why.split('=')[0] if not why.startswith('k=') else 'joined'
            st['reasons'][key] = st['reasons'].get(key, 0) + 1
            st['joined' if why.startswith('k=') else 'base_only'] += 1
        elif base_rows:
            rows = base_rows
            st['base_only'] += 1
        else:
            if len(early) < MIN_DL_ROWS:
                st['skip_short'] += 1
                continue
            import miner
            rows = miner._backadjust_splits(early, sym=sym)
            st['early_only'] += 1
        mg = load_gz(mg_dir / f'{sym}.json.gz')
        if mg:
            st['margin_rows'] += fill_margin(rows, mg)
        if dl:
            for r in rows:
                r['_dl'] = 1
        c = cliffs(rows)
        st['cliffs'] += c
        st['cliff_syms'] += c > 0
        (out / f'{sym}.json').write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    # 非個股檔(加權 / 0050 / 產業表…)從 base 複製
    for p in base.iterdir():
        if p.is_file() and not is_stock(p.stem) and not (out / p.name).exists():
            shutil.copyfile(p, out / p.name)
    if div_out:
        old = {}
        if div_in and Path(div_in).exists():
            j = json.loads(Path(div_in).read_text(encoding='utf-8'))
            old = {s: (v.get('h') if isinstance(v, dict) else v) or [] for s, v in (j.get('d') or j).items() if isinstance(v, (dict, list))}
        new = {}
        for p in dv_dir.glob('*.json.gz'):
            r = div_rows(load_gz(p))
            if r:
                new[p.name[:4]] = r
        st['div_syms'] = len(new)
        merged = merge_divs(old, new)
        Path(div_out).write_text(json.dumps({'d': {s: {'h': h} for s, h in merged.items()}, 'src': 'dividends_hist + stock_deep/div10'}, ensure_ascii=False), encoding='utf-8')
    if verbose:
        print(f"🗄️ d16:接上 {st['joined']} 檔 ・只有現成 {st['base_only']} ・只有 2010~2021(下市){st['early_only']} ・2021 後下市 {st['kd_dl']} ・太短不收 {st['skip_short']}")
        print(f"   接不上的原因:{st['reasons']} ・融資券補了 {st['margin_rows']:,} 列 ・除權息 {st['div_syms']} 檔 ・斷崖 {st['cliffs']} 次 / {st['cliff_syms']} 檔(探針自己有守門)")
    return st


def selftest():
    import tempfile
    bad = []

    def ok(name, c, x=''):
        print(f"  {'✅' if c else '❌'} {name}{(' ・' + str(x)[:200]) if not c else ''}")
        if not c:
            bad.append(name)
    import datetime as _dt
    days = []
    d0 = _dt.date(2019, 1, 2)
    while d0 <= _dt.date(2021, 6, 30):
        if d0.weekday() < 5:
            days.append(d0.isoformat())
        d0 += _dt.timedelta(days=1)
    early = [d for d in days if d <= '2021-03-31']
    later = [d for d in days if d >= '2021-01-04']
    mk = lambda ds, f, scale=1.0: [[d, 100 * f(i) * scale, 101 * f(i) * scale, 99 * f(i) * scale, 100 * f(i) * scale, 1000] for i, d in enumerate(ds)]
    grow = lambda i: 1 + i * 0.0005
    with tempfile.TemporaryDirectory() as td:
        T = Path(td)
        for sub in ('dd', 'kd', 'sd/price10', 'sd/margin', 'sd/div10', 'base', 'out'):
            (T / sub).mkdir(parents=True)
        gz = lambda p, o: gzip.open(p, 'wt', encoding='utf-8').write(json.dumps(o))
        # A:現成那段是 price10 的一半(分割過)→ 比例 0.5 常數 → 接上;現成列一個都不動
        off = early.index('2021-01-04')
        baseA = [{'date': d.replace('-', '/'), 'open': 50 * grow(i + off), 'high': 50.5 * grow(i + off), 'low': 49.5 * grow(i + off), 'close': 50 * grow(i + off), 'volume': 2000, 'foreign_net': 5} for i, d in enumerate(later)]
        (T / 'dd/1111.json').write_text(json.dumps(baseA))
        gz(T / 'sd/price10/1111.json.gz', {'s': '1111', 'dl': 0, 'k': mk(early, grow)})
        # B:比例一路在變(不是同一把尺)→ ⛔ 不接
        (T / 'dd/2222.json').write_text(json.dumps(baseA))
        gz(T / 'sd/price10/2222.json.gz', {'s': '2222', 'dl': 0, 'k': [[d, 100, 101, 99, 100 * (1 + i * 0.01), 1000] for i, d in enumerate(early)]})
        # C:2021 前下市 → 單獨成檔、標 _dl;D:太短 → 不收
        gz(T / 'sd/price10/3333.json.gz', {'s': '3333', 'dl': 1, 'k': mk(early[:400], grow)})
        gz(T / 'sd/price10/4444.json.gz', {'s': '4444', 'dl': 1, 'k': mk(early[:100], grow)})
        # E:2021 後才下市(klines_deep dl:1、data 沒有)→ klines_deep 當現成 + 接上
        gz(T / 'kd/5555.json.gz', {'s': '5555', 'dl': 1, 'k': mk(later, lambda i: grow(i + off))})
        gz(T / 'sd/price10/5555.json.gz', {'s': '5555', 'dl': 0, 'k': mk(early, grow)})
        # 融資券:只補 None
        baseA2 = [dict(r) for r in baseA]
        baseA2[0]['margin_balance'] = 777
        (T / 'dd/6666.json').write_text(json.dumps(baseA2))
        gz(T / 'sd/margin/6666.json.gz', {'d': [later[0], later[1]], 'c': ['MarginPurchaseTodayBalance', 'ShortSaleTodayBalance'], 'v': [[111, 1], [222, 2]]})
        # 除權息
        gz(T / 'sd/div10/1111.json.gz', {'d': ['2020-07-15', '2021-03-17'], 'c': ['before_price', 'after_price', 'stock_and_cache_dividend'], 'v': [[100, 97, 3], [105, 102, 3]]})
        (T / 'base/^TWII.json').write_text('[]')
        (T / 'div_in.json').write_text(json.dumps({'d': {'1111': {'h': [['2021-03-17', 2.5, '息', 105, 102.5]]}}}))
        st = build(T / 'dd', T / 'kd', T / 'sd', T / 'base', T / 'out', T / 'div_in.json', T / 'out/_div16.json', verbose=False)
        A = json.loads((T / 'out/1111.json').read_text())
        ok('① 比例常數(0.5)→ 接上、2010 那段乘 0.5、日期連續', _d(A[0]['date']) == early[0] and abs(A[0]['close'] - 50) < 0.01 and len(A) == len(set(_d(r['date']) for r in A)), A[0])
        ok('① 現成那段一個字都不動(含籌碼欄)', A[-len(baseA):] == baseA, A[-1])
        B = json.loads((T / 'out/2222.json').read_text())
        ok('② 比例一路在變 → ⛔ 不接、只留現成', B == baseA and st['reasons'].get('ratio-drift') == 1, st['reasons'])
        C = json.loads((T / 'out/3333.json').read_text())
        ok('③ 2021 前下市 → 單獨成檔、每列標 _dl', len(C) == 400 and all(r.get('_dl') == 1 for r in C))
        ok('③ 太短(<250 根)→ 不收', not (T / 'out/4444.json').exists())
        E = json.loads((T / 'out/5555.json').read_text())
        ok('④ 2021 後才下市 → klines_deep 那段 + price10 接上、標 _dl', _d(E[0]['date']) == early[0] and _d(E[-1]['date']) == later[-1] and all(r.get('_dl') == 1 for r in E), (E[0], E[-1]))
        M = json.loads((T / 'out/6666.json').read_text())
        ok('⑤ 融資券只補 None(第一列本來有 777 → 不動;第二列補 222)', M[0]['margin_balance'] == 777 and M[1]['margin_balance'] == 222 and M[1]['short_balance'] == 2 and 'margin_balance' not in M[2])
        dv = json.loads((T / 'out/_div16.json').read_text())['d']['1111']['h']
        ok('⑥ 除權息合併:同一天以 dividends_hist 為準、2020 那筆補進來', [x[0] for x in dv] == ['2020-07-15', '2021-03-17'] and dv[1][1] == 2.5 and dv[0][3:] == [100, 97], dv)
        ok('⑦ 非個股檔從 base 複製', (T / 'out/^TWII.json').exists())
        # ⑧ 決定性對照:把容忍度改成 0 → A 也接不上(⛔ 不是寫死會接)
        global RATIO_TOL
        keep = RATIO_TOL
        RATIO_TOL = -1
        rows, why = join(baseA, p10_rows({'k': mk(early, grow)}), '1111')
        RATIO_TOL = keep
        ok('⑧ 決定性對照:容忍度設成不可能 → 接不上', rows == baseA and why.startswith('ratio-drift'), why)
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


def main():
    ap = argparse.ArgumentParser()
    for k in ('dd', 'kd', 'sd', 'base', 'out'):
        ap.add_argument(f'--{k}', required=True)
    ap.add_argument('--div-in')
    ap.add_argument('--div-out')
    a = ap.parse_args()
    st = build(a.dd, a.kd, a.sd, a.base, a.out, a.div_in, a.div_out)
    if st['joined'] + st['early_only'] < 500:
        print('❌ 接上 + 新增不到 500 檔 → stock_deep 那份可能不完整')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
