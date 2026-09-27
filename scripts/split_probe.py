#!/usr/bin/env python3
"""✂️ 股票分割(面額變更)之後比較會漲嗎? —— V77.7.1(使用者:「分割後特別是 0050 等是不是比較會漲」)

⭐ 偵測方法(⛔ 價格與成交量都已經還原過分割,看不出來):
   分割要**停止買賣幾天**(成交量 0),復牌那天**融資餘額(張)沒有還原** → 會跳成約整數倍。
   規則:連續 ≥3 天成交量 0,復牌日融資餘額 ÷ 停牌前 ≈ 2~10 的整數(±25%),停牌前 ≥50 張。
   ⚠️ 倍數本身不準(0050 實際 1:4,融資比 4.59 → 判成 5;有人趁停牌前後加碼)→ 只用「日期」不用倍數。
   ⚠️ 抓不到:沒有融資的(槓桿/反向 ETF、很多新 ETF)、停牌不到 3 天的。
量:復牌日收盤 → 之後 5/20/60/120 個交易日的報酬,扣同期加權(⛔ 只有復牌日,沒有公告日 → 公告效應量不到)。
用法:python3 scripts/split_probe.py <data 目錄(已修還原價)> [--selftest]
"""
import json, os, sys, statistics as st


def find_splits(rows, min_halt=3, min_margin=50):
    ev = []
    i = 1
    while i < len(rows):
        if (rows[i].get('volume') or 0) == 0:
            j = i
            while j < len(rows) and (rows[j].get('volume') or 0) == 0:
                j += 1
            if j - i >= min_halt and j < len(rows):
                a = rows[i - 1].get('margin_balance') or 0
                b = rows[j].get('margin_balance') or 0
                if a >= min_margin and b > 0:
                    r = b / a; n = round(r)
                    if 2 <= n <= 10 and abs(r / n - 1) < 0.25:
                        ev.append((j, n, round(r, 2), j - i))
            i = j
        i += 1
    return ev


def selftest():
    bad = 0
    def ck(ok, m):
        nonlocal bad
        print(('✅ ' if ok else '❌ ') + m); bad += (not ok)
    rows = [{'date': f'd{k}', 'volume': 100, 'margin_balance': 1000} for k in range(20)]
    for k in range(8, 13): rows[k]['volume'] = 0
    for k in range(13, 20): rows[k]['margin_balance'] = 4000
    ev = find_splits(rows)
    ck(len(ev) == 1 and ev[0][0] == 13 and ev[0][1] == 4, f'① 停牌 5 天 + 融資 ×4 → 抓到復牌那天({ev})')
    rows2 = [dict(r) for r in rows]
    for k in range(13, 20): rows2[k]['margin_balance'] = 1100
    ck(find_splits(rows2) == [], '② 停牌但融資沒跳倍數(一般停牌)→ ⛔ 不算分割')
    rows3 = [dict(r, volume=100) for r in rows]
    for k in range(13, 20): rows3[k]['margin_balance'] = 4000
    ck(find_splits(rows3) == [], '③ 融資翻倍但沒停牌(搶買)→ ⛔ 不算分割')
    print('✅ 全過' if not bad else f'❌ {bad} 條沒過'); sys.exit(1 if bad else 0)


if '--selftest' in sys.argv:
    selftest()
D = sys.argv[1]
tw = {r['date']: r['close'] for r in json.load(open(os.path.join(D, '^TWII.json')))}
out = {h: [] for h in (5, 20, 60, 120)}
rows_out = []
for f in sorted(os.listdir(D)):
    s = f[:-5]
    if not f.endswith('.json') or not s[:1].isdigit(): continue
    try: R = json.load(open(os.path.join(D, f)))
    except Exception: continue
    if not isinstance(R, list) or not R or not isinstance(R[0], dict): continue
    for j, n, r, halt in find_splits(R):
        d = R[j]['date']; line = [s, d, f'停牌{halt}天']
        for h in (5, 20, 60, 120):
            if j + h < len(R) and R[j + h]['date'] in tw and d in tw and R[j]['close']:
                x = (R[j + h]['close'] / R[j]['close'] - 1) * 100 - (tw[R[j + h]['date']] / tw[d] - 1) * 100
                out[h].append(x); line.append(f'{h}日 {x:+.1f}')
        rows_out.append(line); print(' '.join(line))
print()
for h, v in out.items():
    if v: print(f'{h:>3} 日:n={len(v):>2} 平均超額 {st.mean(v):+.2f}pp 中位 {st.median(v):+.2f} 贏大盤 {sum(x > 0 for x in v)}/{len(v)}')
print('⚠️ 樣本很少(2024~2026 只抓到十幾次)、只有復牌日沒有公告日 → 只能看方向,⛔ 不能下結論')
