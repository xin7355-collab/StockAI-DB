#!/usr/bin/env python3
"""
📒 V82.1.2 實盤成交 vs 回測假設(SELF_EVOLVING_AUDIT G5)—— 在**你自己的電腦**跑(成交紀錄只在那裡)

讀 auto_trade.py 收工時寫的 FILLS_LOG(一行一筆:d 日期 / sym / side B·S / fq 成交股數 / avg 成交均價 / close 收盤 /
`vs_close` = 比回測假設的「收盤價成交」差多少 %,正數 = 比回測差:買貴了 / 賣便宜了)。
→ 每個月、買 / 賣分開:幾筆、平均差多少、加起來大約多花多少元。

⚠️ 事先寫死的提醒規則(⛔ 不會自動停用任何東西):某一邊(買或賣)**連 2 個月**、每個月 ≥5 筆、平均 vs_close > +0.30%
   → 「實盤比回測差得比較多,回測的數字要再打折」。0.30% 的由來:回測已經扣了來回 0.44% 的手續費 + 稅,
   沒扣「沒買在收盤價」這一塊;一邊 0.3% ≈ 每一趟再多 0.6%,已經比手續費還大。
⛔ 只讀,不寫任何檔、不碰狀態檔、不連券商。

跑法:python3 scripts/fills_report.py                 → 讀 ~/.stockai_auto_trade.fills.jsonl(真實)與 .sim.fills.jsonl(模擬)
      python3 scripts/fills_report.py <檔案> [<檔案>…]  → 指定檔案
      python3 scripts/fills_report.py --selftest
"""
import json
import os
import sys
from collections import defaultdict

DEFAULT = [os.path.expanduser('~/.stockai_auto_trade.fills.jsonl'), os.path.expanduser('~/.stockai_auto_trade.sim.fills.jsonl')]
WARN_PCT, WARN_MONTHS, WARN_MIN_N = 0.30, 2, 5


def load(path):
    """→ 去重後、有成交、vs_close 算得出來的那幾筆(去重鍵同 auto_trade 寫入那一段)"""
    out, seen, bad = [], set(), 0
    with open(path, encoding='utf-8') as f:
        for line in f:
            try:
                r = json.loads(line)
            except Exception:
                bad += 1
                continue
            k = (r.get('d'), r.get('oid'), r.get('lot'), r.get('fq'), r.get('st'))
            if k in seen:
                continue
            seen.add(k)
            if (r.get('fq') or 0) > 0 and isinstance(r.get('vs_close'), (int, float)) and r.get('side') in ('B', 'S'):
                out.append(r)
    return out, bad


def summarize(rows):
    """→ {(月份, 邊): {n, avg, amt(多花的元)}}"""
    g = defaultdict(list)
    for r in rows:
        g[(str(r['d'])[:7], r['side'])].append(r)
    out = {}
    for k, rs in sorted(g.items()):
        n = len(rs)
        avg = sum(r['vs_close'] for r in rs) / n
        amt = sum(r['vs_close'] / 100 * r['fq'] * (r.get('avg') or 0) for r in rs)
        out[k] = {'n': n, 'avg': avg, 'amt': amt}
    return out


def warnings(S):
    """某一邊連 WARN_MONTHS 個月(每月 ≥ WARN_MIN_N 筆)平均 > WARN_PCT → [(邊, 最後那個月)]"""
    out = []
    for side in ('B', 'S'):
        run = 0
        for m in sorted({k[0] for k in S}):
            x = S.get((m, side))
            run = run + 1 if (x and x['n'] >= WARN_MIN_N and x['avg'] > WARN_PCT) else 0
            if run >= WARN_MONTHS:
                out.append((side, m))
                break
    return out


def report(path):
    if not os.path.exists(path):
        print(f'(沒有 {path} —— 自動下單還沒寫過成交紀錄,或是你用 FILLS_LOG 指定了別的位置)')
        return
    rows, bad = load(path)
    print(f'\n📒 {path}:有成交 {len(rows)} 筆' + (f'(讀不出來的 {bad} 行跳過)' if bad else ''))
    if not rows:
        return
    S = summarize(rows)
    for (m, side), x in S.items():
        print(f'  {m} {"買" if side == "B" else "賣"}:{x["n"]} 筆,平均比回測假設{"差" if x["avg"] > 0 else "好"} {abs(x["avg"]):.2f}%,'
              f'合計大約{"多花" if x["amt"] > 0 else "省下"} {abs(x["amt"]):,.0f} 元')
    W = warnings(S)
    if W:
        for side, m in W:
            print(f'  ⚠️ {"買" if side == "B" else "賣"}那一邊連 {WARN_MONTHS} 個月平均差超過 {WARN_PCT}%(到 {m})—— 實盤比回測差得比較多,看板上的數字要再打折。只是提醒,⛔ 沒有停用任何東西。')
    else:
        print(f'  ✅ 沒有連 {WARN_MONTHS} 個月平均差超過 {WARN_PCT}% 的(每月至少 {WARN_MIN_N} 筆才算)')


def selftest():
    import tempfile
    ok = bad = 0

    def t(c, m):
        nonlocal ok, bad
        print(('  ✅ ' if c else '  ❌ ') + m)
        ok, bad = (ok + 1, bad) if c else (ok, bad + 1)
    rows = []
    for m in ('2026-11', '2026-12'):
        for i in range(6):
            rows.append({'d': f'{m}-{10 + i:02d}', 'sym': '1101', 'side': 'B', 'fq': 1000, 'avg': 100.0, 'vs_close': 0.5, 'oid': f'{m}{i}', 'lot': 0, 'st': 'Filled'})
            rows.append({'d': f'{m}-{10 + i:02d}', 'sym': '1101', 'side': 'S', 'fq': 1000, 'avg': 100.0, 'vs_close': 0.1, 'oid': f'{m}s{i}', 'lot': 0, 'st': 'Filled'})
    with tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False, encoding='utf-8') as f:
        for r in rows + rows[:3]:                                   # 重複寫進去的那幾行要去掉
            f.write(json.dumps(r) + '\n')
        f.write('{壞掉的一行\n')
        f.write(json.dumps({'d': '2026-12-20', 'side': 'B', 'fq': 0, 'vs_close': 9}) + '\n')   # 沒成交的不算
        p = f.name
    try:
        L, nb = load(p)
        t(len(L) == 24 and nb == 1, f'① 去重、壞行跳過、沒成交不算:{len(L)} 筆、壞行 {nb}')
        S = summarize(L)
        x = S[('2026-11', 'B')]
        t(x['n'] == 6 and abs(x['avg'] - 0.5) < 1e-9 and abs(x['amt'] - 6 * 0.005 * 1000 * 100) < 1e-6, f'② 11 月買:6 筆、平均 0.5%、多花 {x["amt"]:.0f} 元')
        W = warnings(S)
        t(W == [('B', '2026-12')], f'③ 買那邊連 2 個月 > 0.3% → 提醒;賣那邊 0.1% 不提醒:{W}')
        S2 = {k: (v if k != ('2026-12', 'B') else {**v, 'avg': 0.2}) for k, v in S.items()}
        t(warnings(S2) == [], '④ 只有一個月超過 → 不提醒(決定性對照)')
    finally:
        os.unlink(p)
    print(f'\n{"❌" if bad else "✅"} selftest {ok}/{ok + bad}')
    return 1 if bad else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    for p in (sys.argv[1:] or DEFAULT):
        report(p)
