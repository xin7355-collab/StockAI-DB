#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🇹🇼 把 tw_deep04(證交所 2004~2009 全市場日 K + 除權息 + 加權指數)接到 d16 前面 → d04(研究用,V82.1.2 B9)

為什麼:2011 年起的每一年都已經拿來挑過規則(LAB method `oos-seal`);2004~2009 是唯一「沒挑過規則」的舊年份,
而且有 2008 那種一路跌一整年的空頭 → 👑 / 📉 / 0050 拿來當一段樣本外。
⛔ 只寫到另一個資料夾(⛔ 不改 d16、不改 data/);⛔ 不進 App。

接法(照 merge_stock_deep 走過的路,⛔ 不另訂規則):
  ① 個股:d16 那一檔 2010 起的價格 = stock_deep price10(官方原始價)× k(分割 / 面額變更往回調過)
     → k 用「d16 ÷ price10」在接縫那一端(最早 60 個重疊日)算(merge_stock_deep._scale(win=60),要 ≥20 天、漂移 ≤0.5%)
     → tw04 的原始價 × k、成交量 ÷ k 接到前面(⛔ 不動 d16 的任何一列),再跑一次 miner._backadjust_splits。
     接縫守門:tw04 最後一天要在 2010 第一個交易日前 5 個交易日內,而且 price10 第一天開盤 / 收盤跟它比 ≤ 7.5%(當時漲跌幅 ±7%);
     不過就不接(記原因)。
  ② 2010 前就下市(d16 沒有)的:tw04 單獨成檔、每列標 `_dl: 1`(≥ 250 根才收)
  ③ 除權息(TWT49U):每檔照 ① 的 k 換尺標(合計 / 前價 / 參考價一起乘,比例不變)併進 `_div16.json`(同一天以 d16 為準)
  ④ 加權(^TWII):FMTQIK 每天的收盤(⚠️ 只有收盤 → 開高低都填收盤;引擎只用收盤算大盤空頭)+ 成交金額接到前面;
     接縫守門 ≤ 7.5%
  ⑤ 0050 含息:tw04 的 0050 原始價 × k(k = d16 _bench0050 第一天 ÷ tw04 最後一天,貼到 1/10~10 的整數倍,誤差 ≤ 7.5%)接到
     `_bench0050.json` 前面;0050 的除權息照 k 換尺標接到 `_div0050.json` 前面
⚠️ 沒做的(誠實):① 只有上市(⛔ 上櫃 2004~2009 沒抓)→ 那幾年的池子比 2010 起小 ② 減資 / 現增這種非整數倍斷崖不修(同 d16)
   ③ 沒有法人 / 融資券 ④ 加權沒有開高低。

跑法:python3 scripts/tw04_merge.py --tw <tw_deep04 資料夾> --d16 <d16> --sd <stock_deep 資料夾> --out <d04>
      python3 scripts/tw04_merge.py --selftest
"""
import argparse
import gzip
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'scripts'))

from merge_stock_deep import _d, _slash, _scale, _pre, is_stock, load_gz, p10_rows, MIN_DL_ROWS  # noqa: E402

SEAM_WIN = 60
SEAM_GAP = 5          # tw04 最後一天到 2010 第一天之間最多幾個交易日
SEAM_TOL = 0.075      # 2015-06 前漲跌幅 ±7%(+ 跳動單位四捨五入)
SNAP = sorted({float(m) for m in range(1, 11)} | {1.0 / m for m in range(2, 11)})


def load_tw(tw):
    """tw_deep04 → (每檔 {日期: [o,h,l,c,v]}, 加權 [(日期, 收盤, 成交金額)], 除權息 [[日期, 代號, 前收, 參考價, 權值+息值, 權/息]])"""
    tw = Path(tw)
    px = {}
    for p in sorted(tw.glob('[0-9][0-9][0-9][0-9]-[0-9][0-9].json.gz')):
        with gzip.open(p, 'rt', encoding='utf-8') as f:
            j = json.load(f)
        for ds, rows in (j.get('days') or {}).items():
            d = f'{ds[:4]}-{ds[4:6]}-{ds[6:8]}'
            for r in rows:
                code, o, h, l, c, v = r[:6]
                if not (o and h and l and c) or c <= 0 or o <= 0:
                    continue
                px.setdefault(code, {})[d] = [o, h, l, c, v or 0]
    idx = []
    for p in sorted((tw / 'idx').glob('*.json')):
        for r in json.loads(p.read_text(encoding='utf-8')).get('rows') or []:
            if r[3] and r[3] > 0:
                idx.append((r[0], float(r[3]), r[2]))
    divs = []
    for p in sorted((tw / 'div').glob('*.json')):
        divs += json.loads(p.read_text(encoding='utf-8')).get('rows') or []
    return px, sorted(set(idx)), divs


def tw_rows(d2r, cal):
    """{日期: [o,h,l,c,v]} → d16 格式的列(只收加權那幾天)"""
    return [{'date': _slash(d), 'open': d2r[d][0], 'high': d2r[d][1], 'low': d2r[d][2], 'close': d2r[d][3], 'volume': d2r[d][4]}
            for d in sorted(d2r) if d in cal]


def seam_ok(early_tw, first_p10, cal_list):
    """tw04 最後一列 vs price10 第一列:中間 ≤ SEAM_GAP 個交易日、開盤 / 收盤跟前收比 ≤ SEAM_TOL → (True, '') / (False, 原因)"""
    if not early_tw or not first_p10:
        return False, 'no-data'
    last = early_tw[-1]
    ld, fd = _d(last['date']), _d(first_p10['date'])
    gap = sum(1 for d in cal_list if ld < d < fd)
    if gap > SEAM_GAP:
        return False, f'gap={gap}'
    pc = float(last['close'])
    jump = max(abs(float(first_p10['open']) / pc - 1), abs(float(first_p10['close']) / pc - 1))
    if jump > SEAM_TOL:
        return False, f'jump={jump:.3f}'
    return True, ''


def snap(r):
    """比例貼到最近的 1/10~10 整數倍;差超過 SEAM_TOL → None"""
    best = min(SNAP, key=lambda s: abs(r / s - 1))
    return best if abs(r / best - 1) <= SEAM_TOL else None


def div_scaled(rows, k):
    """TWT49U 一列 → d16 除權息格式 [日期, 合計, 權/息, 前價, 參考價](價格 × k)"""
    out = []
    for d, _code, pc, ref, val, kind in rows:
        if pc and ref and pc > 0 and ref > 0:
            out.append([d, round((val or 0) * k, 4), kind or '權息', round(pc * k, 4), round(ref * k, 4)])
    return out


def build(tw, d16, sd, out, verbose=True):
    tw, d16, sd, out = Path(tw), Path(d16), Path(sd), Path(out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(d16, out)
    (out / 'MANIFEST.json').unlink(missing_ok=True)
    px, idx, divs = load_tw(tw)
    if len(idx) < 250:
        raise SystemExit(f'🚨 加權指數只有 {len(idx)} 天(tw_deep04/idx 還沒抓齊?)')
    st = {'joined': 0, 'dl_only': 0, 'skip_short': 0, 'no_p10': 0, 'reasons': {}, 'div_rows': 0, 'rows_added': 0}
    # ④ 加權
    tw_old = json.loads((out / '^TWII.json').read_text(encoding='utf-8'))
    first16 = _d(tw_old[0]['date'])
    pre_idx = [x for x in idx if x[0] < first16]
    j = abs(float(tw_old[0]['close']) / pre_idx[-1][1] - 1)
    if j > SEAM_TOL:
        raise SystemExit(f'🚨 加權接縫跳 {j:.1%}({pre_idx[-1][0]} → {first16})')
    tw_new = [{'date': _slash(d), 'open': c, 'high': c, 'low': c, 'close': c, 'volume': 0, 'amount': a, '_c': 1} for d, c, a in pre_idx] + tw_old
    (out / '^TWII.json').write_text(json.dumps(tw_new, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    cal = {d for d, _, _ in pre_idx}
    cal_list = sorted(cal) + [_d(r['date']) for r in tw_old[:SEAM_GAP + 5]]
    st['idx'] = (pre_idx[0][0], pre_idx[-1][0], len(pre_idx))
    # 除權息依代號分
    dv = {}
    for r in divs:
        dv.setdefault(r[1], []).append(r)
    D16p = out / '_div16.json'
    D16 = json.loads(D16p.read_text(encoding='utf-8'))
    dmap = D16.get('d') or {}
    # ①② 個股
    import miner
    for code in sorted(px):
        if not is_stock(code):
            continue
        early = tw_rows(px[code], cal)
        p = out / f'{code}.json'
        if p.exists():
            base = json.loads(p.read_text(encoding='utf-8'))
            pk = load_gz(sd / 'price10' / f'{code}.json.gz')
            p10 = p10_rows(pk) if pk else []
            if not p10:
                st['no_p10'] += 1
                continue
            k, why = _scale(base, p10, win=SEAM_WIN)
            if k is None:
                st['reasons'][why.split('=')[0]] = st['reasons'].get(why.split('=')[0], 0) + 1
                continue
            okk, why2 = seam_ok(early, p10[0], cal_list)
            if not okk:
                st['reasons'][why2.split('=')[0]] = st['reasons'].get(why2.split('=')[0], 0) + 1
                continue
            pre = _pre(early, k, _d(base[0]['date']))
            if not pre:
                continue
            rows = miner._backadjust_splits(pre + [dict(r) for r in base], sym=code)
            st['joined'] += 1
            st['rows_added'] += len(pre)
        else:
            if len(early) < MIN_DL_ROWS:
                st['skip_short'] += 1
                continue
            k = 1.0
            rows = miner._backadjust_splits(early, sym=code)
            for r in rows:
                r['_dl'] = 1
            st['dl_only'] += 1
            st['rows_added'] += len(rows)
        p.write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        add = [x for x in div_scaled(dv.get(code, []), k) if x[0] < first16]
        if add:
            have = {e[0][:10]: e for e in ((dmap.get(code) or {}).get('h') or [])}
            for e in add:
                have.setdefault(e[0], e)
            dmap[code] = {'h': [have[d] for d in sorted(have)]}
            st['div_rows'] += len(add)
    D16['d'] = dmap
    D16['src'] = str(D16.get('src') or '') + ' + tw_deep04 TWT49U(2004~2009)'
    D16p.write_text(json.dumps(D16, ensure_ascii=False), encoding='utf-8')
    # ⑤ 0050
    b = json.loads((out / '_bench0050.json').read_text(encoding='utf-8'))
    e50 = tw_rows(px.get('0050', {}), cal)
    e50 = [r for r in e50 if _d(r['date']) < _d(b[0]['date'])]
    if not e50:
        raise SystemExit('🚨 tw_deep04 裡沒有 0050')
    k50 = snap(float(b[0]['close']) / float(e50[-1]['close']))
    if k50 is None:
        raise SystemExit(f'🚨 0050 接縫對不上({e50[-1]["date"]} {e50[-1]["close"]} → {b[0]["date"]} {b[0]["close"]})')
    pre50 = _pre(e50, k50, _d(b[0]['date']))
    (out / '_bench0050.json').write_text(json.dumps(pre50 + b, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    D50p = out / '_div0050.json'
    D50 = json.loads(D50p.read_text(encoding='utf-8'))
    h50 = ((D50.get('d') or {}).get('0050') or {}).get('h') or []
    add50 = [x for x in div_scaled(dv.get('0050', []), k50) if x[0] < first16]
    D50.setdefault('d', {})['0050'] = {'h': sorted(add50 + h50, key=lambda e: e[0])}
    D50p.write_text(json.dumps(D50, ensure_ascii=False), encoding='utf-8')
    st['k50'], st['div50'] = k50, len(add50)
    if verbose:
        print(f"🇹🇼 d04:加權 {st['idx'][0]}~{st['idx'][1]}({st['idx'][2]} 天)・接上 {st['joined']} 檔・2010 前下市 {st['dl_only']} 檔"
              f"・太短不收 {st['skip_short']}・沒有 price10 {st['no_p10']}・接不上 {st['reasons']}")
        print(f"   新增 {st['rows_added']:,} 列・除權息 {st['div_rows']} 筆・0050 尺標 ×{k50:g}、除權息 {len(add50)} 筆")
    return st


def selftest():
    import tempfile
    fails = []

    def ok(n, c, g=''):
        print(f'{"✅" if c else "❌"} {n}' + ('' if c else f' → {str(g)[:300]}'))
        if not c:
            fails.append(n)
    T = Path(tempfile.mkdtemp())
    tw, d16, sd, out = T / 'tw', T / 'd16', T / 'sd', T / 'out'
    for d in (tw / 'idx', tw / 'div', d16, sd / 'price10'):
        d.mkdir(parents=True)
    from datetime import date, timedelta

    def wd(a, z):
        x, out_ = a, []
        while x <= z:
            if x.weekday() < 5:
                out_.append(x.isoformat())
            x += timedelta(days=1)
        return out_
    old, new = wd(date(2008, 10, 1), date(2009, 12, 31)), wd(date(2010, 1, 4), date(2010, 6, 30))
    # 加權:2009 收 100、2010 接 101
    (tw / 'idx' / '2009-12.json').write_text(json.dumps({'rows': [[d, 1, 1e9, 100.0] for d in old], 'complete': True}))
    (d16 / '^TWII.json').write_text(json.dumps([{'date': _slash(d), 'open': 101, 'high': 101, 'low': 101, 'close': 101.0, 'volume': 0} for d in new]))
    # A:分割過(d16 = 原始 ÷ 4)、接縫正常 ;B:接縫跳 30%(不接);C:2010 前下市(300 天);D:0050
    days = {}
    for i, d in enumerate(old):
        ds = d.replace('-', '')
        days.setdefault(d[:7], {})[ds] = [['1101', 40.0, 41.0, 39.0, 40.0, 4000, 0, '', 0],
                                           ['1102', 10.0, 10.0, 10.0, 10.0, 100, 0, '', 0],
                                           ['1103', 5.0, 5.0, 5.0, 5.0 + i * 0.001, 100, 0, '', 0],
                                           ['0050', 60.0, 60.0, 60.0, 60.0, 100, 0, '', 0]]
    for ym, dd in days.items():
        with gzip.open(tw / f'{ym}.json.gz', 'wt', encoding='utf-8') as f:
            json.dump({'days': dd, 'none': [], 'complete': True}, f)
    (tw / 'div' / '2009.json').write_text(json.dumps({'y': 2009, 'rows': [[old[5], '1101', 40.0, 38.0, 2.0, '息'], [old[6], '0050', 60.0, 58.0, 2.0, '息']]}))
    (d16 / '1101.json').write_text(json.dumps([{'date': _slash(d), 'open': 10.2, 'high': 10.3, 'low': 10.1, 'close': 10.2, 'volume': 16000} for d in new]))
    (d16 / '1102.json').write_text(json.dumps([{'date': _slash(d), 'open': 13.0, 'high': 13.0, 'low': 13.0, 'close': 13.0, 'volume': 100} for d in new]))
    for code, c in (('1101', 40.8), ('1102', 13.0)):
        with gzip.open(sd / 'price10' / f'{code}.json.gz', 'wt', encoding='utf-8') as f:
            json.dump({'k': [[d, c, c, c, c, 100] for d in new]}, f)
    (d16 / '_bench0050.json').write_text(json.dumps([{'date': _slash(d), 'open': 15.1, 'high': 15.1, 'low': 15.1, 'close': 15.1, 'volume': 1} for d in new]))
    (d16 / '_div0050.json').write_text(json.dumps({'d': {'0050': {'h': [['2010-10-25', 2.2, '息', 57.1, 54.9]]}}}))
    (d16 / '_div16.json').write_text(json.dumps({'d': {'1101': {'h': [['2011-01-05', 1.0, '息', 10.0, 9.0]]}}, 'src': 'x'}))
    (d16 / 'MANIFEST.json').write_text('{}')
    st = build(tw, d16, sd, out, verbose=False)
    A = json.loads((out / '1101.json').read_text())
    ok('① 分割過的:2009 那段 × k(0.25)、成交量 ÷ k、2010 那段一列都沒動',
       abs(A[0]['close'] - 10.0) < 1e-9 and A[0]['volume'] == 16000 and A[-1] == json.loads((d16 / '1101.json').read_text())[-1] and len(A) == len(old) + len(new), A[:1])
    ok('② 接縫跳 30% → 不接、記原因', len(json.loads((out / '1102.json').read_text())) == len(new) and st['reasons'].get('jump') == 1, st)
    C = json.loads((out / '1103.json').read_text())
    ok('③ 2010 前就下市 → 單獨成檔、每列 _dl', len(C) == len(old) and all(r.get('_dl') == 1 for r in C) and st['dl_only'] == 1, st)
    T2 = json.loads((out / '^TWII.json').read_text())
    ok('④ 加權接到前面、只有收盤(開高低 = 收盤、標 _c)', len(T2) == len(old) + len(new) and T2[0]['close'] == 100.0 and T2[0]['_c'] == 1 and T2[-1]['close'] == 101.0, T2[:1])
    D = json.loads((out / '_div16.json').read_text())['d']['1101']['h']
    ok('⑤ 除權息照 k 換尺標、併進去、d16 原本那筆還在', D[0] == [old[5], 0.5, '息', 10.0, 9.5] and D[-1][0] == '2011-01-05', D)
    B = json.loads((out / '_bench0050.json').read_text())
    D5 = json.loads((out / '_div0050.json').read_text())['d']['0050']['h']
    ok('⑥ 0050 尺標貼到 1/4、除權息一起換', st['k50'] == 0.25 and B[0]['close'] == 15.0 and D5[0] == [old[6], 0.5, '息', 15.0, 14.5] and len(D5) == 2, (st['k50'], B[:1], D5))
    ok('⑦ ⛔ 動 d16 原本的資料夾、MANIFEST 不帶過去', len(json.loads((d16 / '1101.json').read_text())) == len(new) and not (out / 'MANIFEST.json').exists())
    ok('⑧ 尺標貼法:0.26 → 1/4、0.6 → 對不上', snap(0.26) == 0.25 and snap(0.6) is None and snap(1.03) == 1.0)
    cl = sorted(old)
    ok('⑨ 接縫守門:中間空太多天 → gap', seam_ok([{'date': cl[-10], 'close': 10}], {'date': new[0], 'open': 10, 'close': 10}, cl + new)[1].startswith('gap'))
    (tw / 'idx' / '2009-12.json').write_text(json.dumps({'rows': [[d, 1, 1e9, 100.0] for d in old[:100]], 'complete': True}))
    try:
        build(tw, d16, sd, T / 'out2', verbose=False)
        ok('⑩ 加權不到 250 天 → 停', False)
    except SystemExit as e:
        ok('⑩ 加權不到 250 天 → 停', '加權指數只有' in str(e), e)
    print(f'\n{"✅ 全過" if not fails else "❌ 失敗 " + str(len(fails)) + " 條"}(共 10 條)')
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tw', required=True)
    ap.add_argument('--d16', required=True)
    ap.add_argument('--sd', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    build(a.tw, a.d16, a.sd, a.out)


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    main()
