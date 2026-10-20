#!/usr/bin/env python3
"""🗄️ 把 inst_deep(2012~2023-06 個股法人)接進回測用的長 K 線資料夾(V79.3.6)

為什麼:回測用的 d10n(2010 起的日 K)只有 2023-06 之後才有 foreign_net / trust_net / dealer_net
→「外資連買」「外資突然大買」那幾條都沒驗過空頭。inst_backfill.py MODE=deep 把 2012~2023-06 挖回 inst_deep 分支,
這支把兩份接起來,寫到**另一個資料夾**(⛔ 不改原本的 d10n)。

規則:
  ・⛔ 實跑寫入優先:那一列本來就有法人欄位(不是 None)→ 一個字都不動;只補「沒有」的
  ・inst_deep 那一天沒有資料 → 照舊沒有(⛔ 不補 0:0 是「外資沒動」,沒資料是「不知道」)
    🔁 V79.4.3 更正(量過才改):FinMind 這份**沒有法人交易的那天整列不給** —— 2012~2022 有資料的列裡「三大法人全是 0」只佔
       1.0~1.8%,2023 起(證交所 T86,0 照樣列出來)是 14~18%;沒資料的那幾天成交量中位 2.9 萬股 vs 有資料 35 萬股(冷門的日子)。
       → 不補的話,2012~2022 的冷門日整批不見、2023 起卻都在 = **前後兩段母體不一樣**(陷阱 #50 的另一種形式)。
       ⭐ 補 0 只在三個條件都成立時:① 這檔自己已經開始有法人資料 ② 那一天全市場有資料的比例 ≥ 60%(⛔ 整天缺的是資料源的洞,
       例如 2012-01~04、週六補班日)③ 在深歷史範圍內(之後是 T86,本來就有 0)。補上的列標 `_i0: 1`。
  ・沒有 inst_deep 檔的股票 → 原樣複製
  ・^TWII.json / _bench0050.json 這類非個股檔 → 原樣複製

跑法:python3 scripts/merge_inst_deep.py <d10n 資料夾> <inst_deep 資料夾(*.json.gz)> <輸出資料夾>
      python3 scripts/merge_inst_deep.py --selftest
"""
import gzip
import json
import shutil
import sys
from pathlib import Path


def merge_rows(rows, pack):
    """rows = 日 K 列(date 'YYYY/MM/DD' 或 'YYYY-MM-DD');pack = {d,f,t,dl}。回 (rows, 補了幾列)。"""
    m = {d: (f, t, dl) for d, f, t, dl in zip(pack.get('d') or [], pack.get('f') or [], pack.get('t') or [], pack.get('dl') or [])}
    n = 0
    for r in rows:
        d = str(r.get('date') or '').replace('/', '-')[:10]
        v = m.get(d)
        if v is None:
            continue
        hit = False
        sk = r.get('_sk') or 1        # 🔢 merge_stock_deep 標的股數倍數(分割 / 面額變更前那段,成交量已經換過基準)
        for k, x in zip(('foreign_net', 'trust_net', 'dealer_net'), v):
            if r.get(k) is None:
                r[k] = x if (x is None or sk == 1) else round(x * sk)
                hit = True
        n += hit
    return rows, n


INST_F = ('foreign_net', 'trust_net', 'dealer_net')
COVER_MIN = 0.60           # 那一天「已經開始有法人資料的股票」裡至少 60% 有資料,才算資料源那天是完整的
COVER_MIN_N = 50


def _d(r):
    return str(r.get('date') or '').replace('/', '-')[:10]


def _known(r):
    return any(r.get(k) is not None for k in INST_F)


def coverage(stocks, hi):
    """stocks = 合併後的 rows 一檔一檔(list 或 generator,⛔ 不必整包進記憶體)。
    回 (覆蓋完整的日期集合, 每檔第一天有資料的日期 list, 不完整的日期 list)。
    只看 ≤ hi(深歷史範圍)的日子;那天「已開始」的股票 ≥ COVER_MIN_N 檔而且 ≥ COVER_MIN 有資料才算完整。"""
    from collections import defaultdict
    started, known, firsts = defaultdict(int), defaultdict(int), []
    for rows in stocks:
        f0 = next((_d(r) for r in rows if _known(r)), None)
        firsts.append(f0)
        if not f0:
            continue
        for r in rows:
            d = _d(r)
            if d < f0 or d > hi:
                continue
            started[d] += 1
            known[d] += _known(r)
    ok = {d for d, n in started.items() if n >= COVER_MIN_N and known[d] / n >= COVER_MIN}
    gaps = sorted(d for d, n in started.items() if n >= COVER_MIN_N and d not in ok)
    return ok, firsts, gaps


def fill_zero(rows, first, covered, hi):
    """FinMind 沒有法人交易的那天整列不給 → 在「這檔已開始有資料 + 那天資料源完整 + 深歷史範圍內」補 0、標 _i0。回補了幾列。"""
    if not first:
        return 0
    n = 0
    for r in rows:
        d = _d(r)
        if d < first or d > hi or d not in covered or _known(r):
            continue
        for k in INST_F:
            r[k] = 0
        r['_i0'] = 1
        n += 1
    return n


def main(src, deep, dst):
    src, deep, dst = Path(src), Path(deep), Path(dst)
    dst.mkdir(parents=True, exist_ok=True)
    files = sorted(src.glob('*.json'))
    n_f = n_m = n_rows = 0
    merged, hi = [], ''
    for p in files:
        q = deep / f'{p.stem}.json.gz'
        if not q.exists():
            shutil.copyfile(p, dst / p.name)
            continue
        rows = json.loads(p.read_text(encoding='utf-8'))
        with gzip.open(q, 'rt', encoding='utf-8') as f:
            pack = json.load(f)
        if pack.get('d'):
            hi = max(hi, str(pack['d'][-1])[:10])
        rows, k = merge_rows(rows, pack)
        # 先寫一次(合併後),補 0 那一輪再讀回來改 —— ⛔ 不把 2,400 檔整包留在記憶體
        (dst / p.name).write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        merged.append(p.name)
        n_f += 1
        n_m += k > 0
        n_rows += k
    print(f'🗄️ {len(files)} 檔 ・有深歷史 {n_f} ・真的補到 {n_m} 檔 / {n_rows:,} 列 → {dst}')
    # 🔁 V79.4.3 補 0(見檔頭):第一輪只算覆蓋率(逐檔讀、只留日期統計),第二輪改寫
    covered, fl, gaps = coverage((json.loads((dst / name).read_text(encoding='utf-8')) for name in merged), hi)
    firsts = dict(zip(merged, fl))
    n_z = n_zf = 0
    for name in merged:
        rows = json.loads((dst / name).read_text(encoding='utf-8'))
        z = fill_zero(rows, firsts[name], covered, hi)
        if z:
            (dst / name).write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            n_z += z
            n_zf += 1
    print(f'   🔁 沒有法人交易的日子補 0:{n_zf} 檔 / {n_z:,} 列(標 _i0)・資料源完整的日子 {len(covered):,} 天'
          f'(到 {hi})・不完整、⛔ 不補 {len(gaps)} 天:{", ".join(gaps[:8])}{"…" if len(gaps) > 8 else ""}')
    if n_f and not n_rows:
        print('❌ 有深歷史卻一列都沒補到 → 日期格式或檔案對不上,⛔ 別拿去回測')
        return 1
    return 0


def selftest():
    bad = []

    def ok(name, c, extra=''):
        print(f"  {'✅' if c else '❌'} {name}{'' if c else ' ・' + str(extra)}")
        if not c:
            bad.append(name)
    rows = [{'date': '2015/03/02', 'close': 10}, {'date': '2015/03/03', 'close': 11, 'foreign_net': 7, 'trust_net': None},
            {'date': '2015/03/04', 'close': 12}, {'date': '2023/07/03', 'close': 13, 'foreign_net': 0, 'trust_net': 0, 'dealer_net': 0}]
    pack = {'d': ['2015-03-02', '2015-03-03', '2023-07-03'], 'f': [100, 200, 999], 't': [1, 2, 9], 'dl': [-1, -2, -9]}
    out, n = merge_rows([dict(r) for r in rows], pack)
    ok('① 沒有的補上', out[0]['foreign_net'] == 100 and out[0]['trust_net'] == 1 and out[0]['dealer_net'] == -1, out[0])
    ok('② 本來就有的 ⛔ 不動(外資 7 留著、投信 None 才補)', out[1]['foreign_net'] == 7 and out[1]['trust_net'] == 2, out[1])
    ok('③ 深歷史那天沒資料 → 照舊沒有(⛔ 不補 0)', 'foreign_net' not in out[2], out[2])
    ok('④ 本來是 0 的 ⛔ 不覆蓋(0 不是 None)', out[3]['foreign_net'] == 0, out[3])
    ok('⑤ 補到幾列', n == 2, n)
    # ⑥ 分割前那段(merge_stock_deep 標了 _sk=4:成交量已乘 4)→ 補進來的法人也要乘 4,⛔ 不然買超 ÷ 成交量差 4 倍
    out2, _ = merge_rows([{'date': '2015/03/02', 'close': 2.5, 'volume': 4000, '_sk': 4}], pack)
    ok('⑥ 有 _sk 的列 → 法人跟著換基準(100 → 400)', out2[0]['foreign_net'] == 400 and out2[0]['trust_net'] == 4 and out2[0]['dealer_net'] == -4, out2[0])
    # ⑦ 🔁 V79.4.3 補 0:已開始 + 那天資料源完整 + 深歷史範圍內 → 0(標 _i0);其他照舊沒有
    mk = lambda ds, known: [dict({'date': d, 'close': 10}, **({'foreign_net': 5, 'trust_net': 0, 'dealer_net': 0} if k else {})) for d, k in zip(ds, known)]
    days = ['2012-01-03', '2012-05-02', '2012-05-03', '2012-05-04', '2012-05-07', '2023-07-03']
    market = [mk(days, [0, 1, 1, 1, 1, 0]) for _ in range(60)]          # 60 檔:05-02 起都有資料
    for st_ in market[:40]:
        st_[3].pop('foreign_net'); st_[3].pop('trust_net'); st_[3].pop('dealer_net')   # 05-04 只有 20/60 有 → 資料源不完整
    target = mk(days, [0, 1, 0, 1, 1, 0])                                 # 這一檔 05-03 沒資料(冷門日)
    stocks = market + [target]
    cov, firsts, _gaps = coverage(stocks, '2023-05-31')
    ok('⑦ 覆蓋率:05-02 / 05-03 / 05-07 完整,05-04(只有 1/3 有)不完整', {'2012-05-02', '2012-05-03', '2012-05-07'} <= cov and '2012-05-04' not in cov, sorted(cov))
    z = fill_zero(target, firsts[-1], cov, '2023-05-31')
    ok('⑦ 冷門日(05-03)補 0 並標 _i0', target[2].get('foreign_net') == 0 and target[2].get('_i0') == 1 and z == 1, target[2])
    ok('⑦ 開始有資料之前(01-03)⛔ 不補', 'foreign_net' not in target[0], target[0])
    ok('⑦ 深歷史之後(2023-07)⛔ 不補(T86 本來就有 0)', 'foreign_net' not in target[5], target[5])
    ok('⑦ 本來就有的 ⛔ 不動(05-02 = 5)', target[1]['foreign_net'] == 5 and '_i0' not in target[1], target[1])
    m3 = mk(days, [0, 1, 1, 0, 1, 0])
    fill_zero(m3, '2012-05-02', cov, '2023-05-31')
    ok('⑦ 決定性對照:資料源不完整的那天(05-04)⛔ 不補', 'foreign_net' not in m3[3], m3[3])
    print(f"\n{'✅ selftest 全過' if not bad else '❌ ' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    sys.exit(main(*sys.argv[1:4]))
