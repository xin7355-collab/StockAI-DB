#!/usr/bin/env python3
"""📊 breadth16_build.py —— 從 d16(2010 起全市場、含已下市)算每天的上漲 / 下跌 / 漲停 / 跌停家數(V81.0.2)

給 stopfall_probe.mjs 用(Lowry 90% 下跌日、Zweig 寬度衝刺、跌停家數)。
定義跟 App 的市場廣度卡一樣:漲跌幅 > +0.05% 算上漲、< −0.05% 算下跌;
漲跌停 = 收盤漲跌幅 ≥ 漲跌幅限制 − 0.6%(2015-06-01 前 7%、之後 10%,同 lib_limit);
只收 4 碼普通股(⛔ ETF);單日漲跌超過限制 + 1.5% = 物理不可能(減資 / 分割沒還原)→ 那一天這檔不算。

跑法:python3 scripts/breadth16_build.py <d16 資料夾> <輸出.json>
      python3 scripts/breadth16_build.py --selftest
"""
import json
import os
import sys


def lim_of(d):
    return 7.0 if d < '2015-06-01' else 10.0


def day_counts(rows_by_sym):
    """rows_by_sym: {sym: [(date, close), ...] 由舊到新} → {date: [up, dn, flat, lu, ld, n]}"""
    out = {}
    for sym, rows in rows_by_sym.items():
        prev = None
        for d, c in rows:
            if prev is not None and prev > 0 and c > 0:
                r = (c / prev - 1) * 100
                L = lim_of(d)
                if abs(r) <= L + 1.5:
                    a = out.setdefault(d, [0, 0, 0, 0, 0, 0])
                    a[5] += 1
                    if r > 0.05:
                        a[0] += 1
                    elif r < -0.05:
                        a[1] += 1
                    else:
                        a[2] += 1
                    if r >= L - 0.6:
                        a[3] += 1
                    elif r <= -(L - 0.6):
                        a[4] += 1
            prev = c if c > 0 else prev
    return out


def load_dir(src):
    rows_by_sym = {}
    for f in sorted(os.listdir(src)):
        if not f.endswith('.json') or f.startswith('_') or f.startswith('^') or f.startswith('00'):
            continue
        sym = f[:-5]
        if not (len(sym) == 4 and sym.isdigit()):
            continue
        try:
            raw = json.load(open(os.path.join(src, f), encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(raw, list):
            continue
        rows = []
        for r in raw:
            try:
                d = str(r['date']).replace('/', '-')[:10]
                c = float(r['close'])
            except Exception:
                continue
            rows.append((d, c))
        rows.sort()
        rows_by_sym[sym] = rows
    return rows_by_sym


def selftest():
    ok = bad = 0

    def t(c, m):
        nonlocal ok, bad
        print(('  ✅ ' if c else '  ❌ ') + m)
        if c:
            ok += 1
        else:
            bad += 1
    rb = {
        '1101': [('2014-01-02', 10), ('2014-01-03', 10.7), ('2014-01-06', 10.0)],     # +7% 漲停(2015 前)、−6.5% 跌停
        '1102': [('2014-01-02', 10), ('2014-01-03', 10), ('2014-01-06', 10.1)],
        '1103': [('2014-01-02', 10), ('2014-01-03', 5), ('2014-01-06', 5)],         # −50% = 斷崖 → 不算
        '2330': [('2016-01-04', 100), ('2016-01-05', 90)],                          # 2015 後 −10% 跌停
    }
    c = day_counts(rb)
    t(c['2014-01-03'] == [1, 0, 1, 1, 0, 2], '① 2014-01-03:+7% 算上漲 + 漲停(2015 前 7%)、平盤 1 檔、斷崖那檔 ⛔ 不算')
    t(c['2014-01-06'][1] == 1 and c['2014-01-06'][4] == 1 and c['2014-01-06'][0] == 1, '② −6.5% 在 2015 前算跌停')
    t(c['2016-01-05'][4] == 1, '③ 2015 後 −10% 算跌停')
    print(f'\n{"❌" if bad else "✅"} selftest {ok}/{ok + bad}')
    return 1 if bad else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    src, dst = sys.argv[1], sys.argv[2]
    cnt = day_counts(load_dir(src))
    days = sorted(cnt)
    json.dump({'src': src, 'cols': ['up', 'dn', 'flat', 'lu', 'ld', 'n'], 'days': days, 'v': [cnt[d] for d in days]},
              open(dst, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'✅ {len(days)} 天 {days[0]} ~ {days[-1]} → {dst}')
