#!/usr/bin/env python3
"""🏦 V80.1.4 🔥 實際成交的每一筆,照「進場前 5 天借券賣出佔成交量」分組,看每筆淨報酬(研究用,⛔ 不改 App)

為什麼要這支:factor_zoo 第一層量到「借券賣出最多的 1/5 之後比較弱」(16 年 13/14 年同方向),但那是全市場;
  🔥 真的會買的是 🧬 高檔高波動那一小群 → 要問的是「🔥 本來會買的裡面,借券多的有沒有比較差」—— 用回測引擎的 TAKEN_OUT 直接分組。

⛔ 前視:借券賣出收盤後才公布 → 進場那天(收盤買)看不到當天的 → 只用進場前 5 個交易日(⛔ 含進場那天)。
⛔ 那 5 天有任何一天沒有借券資料 → 「不知道」一組(⛔ 當 0;上櫃 / 早年常常沒有)。
淨報酬 = ret + dv − 0.44(同 corr_bucket_probe 的 COST)。借券讀法 = factor_panel.load_sbl(⛔ 第二份)。

跑法:python3 scripts/sbl_bucket_probe.py '<taken 檔名樣式含 {W}>' <W 清單逗號> <DATA_DIR> <SBL_DIR>
      python3 scripts/sbl_bucket_probe.py --selftest
"""
import json
import os
import statistics as st
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factor_panel import load_sbl  # noqa: E402

COST = 0.44
BUCKETS = [('0(沒有借券賣出)', lambda x: x == 0), ('< 1%', lambda x: 0 < x < 1), ('1~3%', lambda x: 1 <= x < 3),
           ('3~6%', lambda x: 3 <= x < 6), ('≥ 6%', lambda x: x >= 6)]
UNKNOWN = '不知道'


class Src:
    def __init__(self, data_dir, sbl_dir):
        self.D, self.SB, self.kc, self.sc = Path(data_dir), sbl_dir, {}, {}

    def kl(self, sym):
        if sym not in self.kc:
            try:
                rows = json.loads((self.D / f'{sym}.json').read_text())
                self.kc[sym] = ([str(r['date'])[:10].replace('/', '-') for r in rows], [float(r.get('volume') or 0) for r in rows])
            except Exception:
                self.kc[sym] = None
        return self.kc[sym]

    def ratio(self, sym, d):
        """進場前 5 個交易日借券賣出 ÷ 成交量(%);算不出 → None"""
        if sym not in self.sc:
            self.sc[sym] = load_sbl(self.SB, sym)
        s, k = self.sc[sym], self.kl(sym)
        if s is None or k is None:
            return None
        ds, vs = k
        try:
            i = ds.index(d)
        except ValueError:
            return None
        if i < 5:
            return None
        win = range(i - 5, i)
        if any(ds[j] not in s for j in win):
            return None
        v = sum(vs[j] for j in win)
        return sum(s[ds[j]][0] for j in win) / v * 100 if v > 0 else None


def bucket_of(x):
    if x is None:
        return UNKNOWN
    for n, fn in BUCKETS:
        if fn(x):
            return n
    return UNKNOWN


def one_start(trades, src):
    by = {n: [] for n, _ in BUCKETS}
    by[UNKNOWN] = []
    tot = 0.0
    for t in trades:
        net = (t.get('ret') or 0) + (t.get('dv') or 0) - COST
        tot += net
        by[bucket_of(src.ratio(t['sym'], t['d']))].append(net)
    return by, tot


def summarize(per):
    out = {}
    for n in [b for b, _ in BUCKETS] + [UNKNOWN]:
        ms = [st.mean(b[n]) for b, _ in per if b[n]]
        ws = [sum(1 for x in b[n] if x > 0) / len(b[n]) for b, _ in per if b[n]]
        sh = [sum(b[n]) / tot for b, tot in per if tot]
        out[n] = {'n': st.median([len(b[n]) for b, _ in per]) if per else 0,
                  'mean': st.median(ms) if ms else None, 'win': st.median(ws) if ws else None,
                  'share': st.median(sh) if sh else None, 'pos': sum(1 for b, _ in per if b[n] and sum(b[n]) > 0), 'starts': len(per)}
    return out


def main(argv):
    if len(argv) < 5:
        print(__doc__)
        return 1
    pat, ws, D, SB = argv[1], argv[2].split(','), argv[3], argv[4]
    src, per = Src(D, SB), []
    for w in ws:
        f = pat.replace('{W}', w)
        if os.path.exists(f):
            per.append(one_start(json.load(open(f)), src))
    if not per:
        print('🚨 一個 taken 檔都沒讀到')
        return 1
    S = summarize(per)
    print(f'📦 {len(per)} 個起點 ・每起點平均 {st.mean(sum(len(v) for v in b.values()) for b, _ in per):.0f} 筆')
    for n, o in S.items():
        mean = '—' if o['mean'] is None else '%+.2f%%' % o['mean']
        win = '—' if o['win'] is None else '%.0f%%' % (o['win'] * 100)
        share = '—' if o['share'] is None else '%+.0f%%' % (o['share'] * 100)
        print(f"  {n:<14} 每起點 {o['n']:5.0f} 筆 ・每筆平均(各起點中位){mean} ・勝率 {win} ・佔總獲利 {share} ・{o['pos']}/{o['starts']} 個起點這組是賺的")
    out = next((a for a in argv[5:] if a.endswith('.json')), None)
    if out:
        json.dump(S, open(out, 'w'), ensure_ascii=False)
    return 0


def _selftest():
    import gzip
    import tempfile
    ok_n = [0]
    fails = []

    def ok(name, c):
        print(('✅ ' if c else '❌ ') + name)
        ok_n[0] += 1
        if not c:
            fails.append(name)

    tmp = Path(tempfile.mkdtemp())
    D, SB = tmp / 'd', tmp / 'sbl'
    D.mkdir()
    SB.mkdir()
    dates = [f'2020-01-{i:02d}' for i in range(1, 21)]
    (D / '1111.json').write_text(json.dumps([{'date': d, 'volume': 1000} for d in dates]))
    (D / '2222.json').write_text(json.dumps([{'date': d, 'volume': 1000} for d in dates]))

    def put(sym, ss, missing=()):
        rows = [[0, 0, 0, 0, 0, 0, 0, ss.get(d, 0), 0, 0, 500] for d in dates if d not in missing]
        cols = ['c%d' % i for i in range(11)]
        cols[7], cols[10] = 'SBLShortSalesShortSales', 'SBLShortSalesCurrentDayBalance'
        (SB / f'{sym}.json.gz').write_bytes(gzip.compress(json.dumps({'d': [d for d in dates if d not in missing], 'c': cols, 'v': rows}).encode()))

    put('1111', {d: 20 for d in dates})                      # 每天 20 / 1000 = 2%
    put('2222', {}, missing=('2020-01-07',))                 # 有一天沒資料
    src = Src(D, SB)
    ok('① 進場前 5 天 2% → 1~3% 那組', bucket_of(src.ratio('1111', '2020-01-10')) == '1~3%')
    # 零前視:進場那天自己的借券改成很大,比例不變;前一天改大,比例變
    put('1111', {**{d: 20 for d in dates}, '2020-01-10': 900})
    r_same = Src(D, SB).ratio('1111', '2020-01-10')
    put('1111', {**{d: 20 for d in dates}, '2020-01-09': 900})
    r_prev = Src(D, SB).ratio('1111', '2020-01-10')
    ok('② 零前視:進場那天的借券不算進去(改大 → 不變)', abs(r_same - 2.0) < 1e-9)
    ok('② 決定性對照:前一天改大 → 比例變', r_prev > 2.0)
    ok('③ 那 5 天有一天沒資料 → 不知道(⛔ 當 0)', bucket_of(src.ratio('2222', '2020-01-10')) == UNKNOWN and bucket_of(src.ratio('2222', '2020-01-15')) == '0(沒有借券賣出)')
    ok('④ 太早(前面不到 5 天)→ 不知道', src.ratio('1111', '2020-01-03') is None)
    put('1111', {d: 20 for d in dates})                      # 換回每天 2%
    by, tot = one_start([{'sym': '1111', 'd': '2020-01-12', 'ret': 10, 'dv': 0}, {'sym': '2222', 'd': '2020-01-15', 'ret': -5, 'dv': 1}], Src(D, SB))
    ok('⑤ 淨報酬 = ret + dv − 0.44', abs(by['1~3%'][0] - 9.56) < 1e-9 and abs(by['0(沒有借券賣出)'][0] - (-4.44)) < 1e-9 and abs(tot - 5.12) < 1e-9)
    print(f'\n{"✅ SBL_BUCKET_SELFTEST_PASS" if not fails else "❌ " + str(len(fails)) + " 條失敗"}({ok_n[0]} 條)')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(_selftest() if '--selftest' in sys.argv else main(sys.argv))
