#!/usr/bin/env python3
"""🗄️ 把 inst_deep(2012~2023-06 個股法人)接進回測用的長 K 線資料夾(V79.3.6)

為什麼:回測用的 d10n(2010 起的日 K)只有 2023-06 之後才有 foreign_net / trust_net / dealer_net
→「外資連買」「外資突然大買」那幾條都沒驗過空頭。inst_backfill.py MODE=deep 把 2012~2023-06 挖回 inst_deep 分支,
這支把兩份接起來,寫到**另一個資料夾**(⛔ 不改原本的 d10n)。

規則:
  ・⛔ 實跑寫入優先:那一列本來就有法人欄位(不是 None)→ 一個字都不動;只補「沒有」的
  ・inst_deep 那一天沒有資料 → 照舊沒有(⛔ 不補 0:0 是「外資沒動」,沒資料是「不知道」)
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


def main(src, deep, dst):
    src, deep, dst = Path(src), Path(deep), Path(dst)
    dst.mkdir(parents=True, exist_ok=True)
    files = sorted(src.glob('*.json'))
    n_f = n_m = n_rows = 0
    for p in files:
        q = deep / f'{p.stem}.json.gz'
        if not q.exists():
            shutil.copyfile(p, dst / p.name)
            continue
        rows = json.loads(p.read_text(encoding='utf-8'))
        with gzip.open(q, 'rt', encoding='utf-8') as f:
            pack = json.load(f)
        rows, k = merge_rows(rows, pack)
        (dst / p.name).write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        n_f += 1
        n_m += k > 0
        n_rows += k
    print(f'🗄️ {len(files)} 檔 ・有深歷史 {n_f} ・真的補到 {n_m} 檔 / {n_rows:,} 列 → {dst}')
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
    print(f"\n{'✅ selftest 全過' if not bad else '❌ ' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    sys.exit(main(*sys.argv[1:4]))
