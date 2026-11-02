#!/usr/bin/env python3
"""🧾 V80.1.9 研究資料的除權息核對(評估紀錄 52:rootSunc/CNEquity〔Apache-2.0〕derive/adj_factors.py 的想法,程式自己寫)。

為什麼要有這支:16 年研究資料(d16)的含息報酬靠 `_div16.json` 的每一筆除權息
  [除權息日, 金額, 權/息, 前收(before), 參考價(ref)] 算還原因子 before ÷ ref。
  CNEquity 的檢查:還原因子要等於「除權息前一天的收盤 ÷ 參考價」—— 換句話說,K 線裡除權息前一天的收盤
  必須等於官方寫的「前收」。對不上 = K 線或除權息日其中一個錯了,回測的含息報酬就跟著錯,而且不會有人發現。
  ① 前一天收盤 vs 前收:差超過一檔升降單位(且 > 0.5%)→ 對不上
  ② 參考價 > 前收、而且金額不是負的 → 不合理(配股配息不會讓價格變高;金額是負的 = 減資,參考價本來就會比前收高)
  ④ 前一天收盤 ÷ 前收剛好是 1/k(k = 2~10,誤差 < 0.3%)→ 歸成「K 線是分割 / 減資後換算過的」:
     含息報酬用的是 前收 ÷ 參考價(比值),⛔ 受影響;但拿「金額 ÷ 收盤」算殖利率會差 k 倍 → 另外列出來
  ③ 除權息日在 K 線裡找不到那天之後的任何一根 → 下市 / 資料斷掉(只計數,不算錯)
⛔ 只讀、不改任何資料;結果印出來(哪幾檔、哪幾天)讓人去查。

跑法:python3 scripts/check_div16.py <d16 資料夾>  [--top 20]
      python3 scripts/check_div16.py --selftest
"""
import json
import os
import sys
from bisect import bisect_left


def tick(p):
    """台股升降單位(跟 index.html `_tickOf` 同一份規則)。"""
    return 0.01 if p < 10 else 0.05 if p < 50 else 0.1 if p < 100 else 0.5 if p < 500 else 1 if p < 1000 else 5


def check_events(bars, events):
    """bars = [{date:'YYYY/MM/DD', close}](依日期排序)、events = [[日, 金額, 種類, 前收, 參考價], ...]
    → (ok, bad, gone, notes)。純函式。"""
    ds = [str(b.get('date') or '').replace('-', '/') for b in bars]
    ok = bad = gone = 0
    notes = []
    for ev in events or []:
        try:
            d, amt, kind, before, ref = ev[0], ev[1], ev[2], float(ev[3]), float(ev[4])
        except (TypeError, ValueError, IndexError):
            continue
        d = str(d).replace('-', '/')
        if not (before > 0 and ref > 0):
            continue
        i = bisect_left(ds, d)          # 第一根 ≥ 除權息日
        if i >= len(ds) or i == 0:
            gone += 1
            continue
        prev = float(bars[i - 1].get('close') or 0)
        why, scaled = [], 0
        try:
            neg = float(amt) < 0
        except (TypeError, ValueError):
            neg = False
        if ref > before + 1e-9 and not neg:
            why.append(f'參考價 {ref} > 前收 {before}')
        if prev > 0 and abs(prev - before) > max(tick(before) + 1e-9, before * 0.005):
            r = prev / before
            scaled = next((k for k in range(2, 11) if abs(r * k - 1) < 0.003), 0)
            why.append(f'前一天收盤 {prev:g}({ds[i - 1]})≠ 前收 {before}' + (f'(剛好 1/{scaled})' if scaled else ''))
        if why:
            bad += 1
            notes.append((d, kind, amt, ';'.join(why), scaled))
        else:
            ok += 1
    return ok, bad, gone, notes


def run(d16, top=20):
    with open(os.path.join(d16, '_div16.json'), encoding='utf-8') as f:
        div = json.load(f).get('d') or {}
    tot = {'ok': 0, 'bad': 0, 'gone': 0, 'syms': 0, 'nokline': 0}
    worst = []
    for sym, rec in sorted(div.items()):
        p = os.path.join(d16, f'{sym}.json')
        if not os.path.exists(p):
            tot['nokline'] += 1
            continue
        with open(p, encoding='utf-8') as f:
            bars = json.load(f)
        bars = sorted((b for b in bars if isinstance(b, dict) and b.get('date')), key=lambda b: str(b['date']).replace('-', '/'))
        ok, bad, gone, notes = check_events(bars, (rec or {}).get('h') or [])
        tot['ok'] += ok
        tot['bad'] += bad
        tot['gone'] += gone
        tot['syms'] += 1
        worst += [(sym, *n) for n in notes]
    n = tot['ok'] + tot['bad']
    scaled = [w for w in worst if w[5]]
    real = [w for w in worst if not w[5]]
    print(f'🧾 除權息核對:{tot["syms"]} 檔、{n} 筆可核對 → 對得上 {tot["ok"]}({tot["ok"] / max(n, 1):.1%})、'
          f'對不上 {tot["bad"]};除權息日之後沒有 K 線 {tot["gone"]} 筆;有除權息但沒有 K 線檔 {tot["nokline"]} 檔')
    print(f'  ④ 其中 {len(scaled)} 筆是 K 線分割 / 減資後換算過(比例剛好 1/k:'
          f'{sorted({w[0] for w in scaled})})→ 含息報酬不受影響,⛔ 拿「金額 ÷ 收盤」算殖利率')
    by = {}
    for w in real:
        k = (w[2], w[1][:4])
        by[k] = by.get(k, 0) + 1
    print(f'  真的對不上 {len(real)} 筆(依種類 × 年):{sorted(by.items(), key=lambda kv: -kv[1])[:12]}')
    for w in real[:top]:
        print(f'  ⚠️ {w[0]} {w[1]} {w[2]} {w[3]}:{w[4]}')
    return tot, worst


def selftest():
    fails = []

    def ok(name, cond, got=''):
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {got}'))
        if not cond:
            fails.append(name)

    bars = [{'date': '2024/07/31', 'close': 57.5}, {'date': '2024/08/01', 'close': 55.3}, {'date': '2024/08/02', 'close': 55.0}]
    r = check_events(bars, [['2024-08-01', 2.2224, '息', 57.5, 55.27]])
    ok('① 前一天收盤 = 前收 → 對得上', r[:3] == (1, 0, 0), r)
    r = check_events(bars, [['2024-08-01', 2.2224, '息', 60.0, 57.77]])
    ok('② 前一天收盤 57.5 ≠ 前收 60 → 對不上、寫出哪一天', r[1] == 1 and '57.5' in r[3][0][3] and '2024/07/31' in r[3][0][3], r)
    r = check_events(bars, [['2024-08-01', 1, '息', 57.55, 56.55]])
    ok('③ 差一檔以內(0.05)→ 算對得上(收盤四捨五入)', r[:2] == (1, 0), r)
    r = check_events(bars, [['2024-08-01', 1, '權', 57.5, 58.0]])
    ok('④ 參考價 > 前收(金額是正的)→ 對不上', r[1] == 1 and '參考價' in r[3][0][3], r)
    r = check_events(bars, [['2024-08-01', -0.16, '權息', 57.5, 58.0]])
    ok('④b 決定性對照:金額是負的(減資)→ 參考價本來就會比前收高,⛔ 算錯', r[:2] == (1, 0), r)
    r = check_events(bars, [['2024-08-01', 3.0, '息', 230.0, 227.0]])
    ok('④c 前一天收盤剛好是前收的 1/4 → 標成「分割後換算過」(k=4)', r[1] == 1 and r[3][0][4] == 4, r)
    r = check_events(bars, [['2024-09-01', 1, '息', 55.0, 54.0], ['2024-07-01', 1, '息', 50, 49]])
    ok('⑤ 除權息日在 K 線範圍外(之後沒有 / 之前沒有)→ 只計數、不算錯', r[:3] == (0, 0, 2), r)
    ok('⑥ 升降單位跟 index.html `_tickOf` 同一份', [tick(x) for x in (9, 10, 49, 50, 99, 100, 499, 500, 999, 1000)]
       == [0.01, 0.05, 0.05, 0.1, 0.1, 0.5, 0.5, 1, 1, 5])
    idx = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'index.html'), encoding='utf-8').read()
    ok('⑥b index.html 的 `_tickOf` 還是同一組門檻(那邊改了這裡要跟著改)',
       "v < 10 ? 0.01 : v < 50 ? 0.05 : v < 100 ? 0.1 : v < 500 ? 0.5 : v < 1000 ? 1 : 5" in idx)
    print(f'\n{"✅ 全過" if not fails else "❌ 失敗 " + str(len(fails)) + " 條"}(共 9 條)')
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    top = int(sys.argv[sys.argv.index('--top') + 1]) if '--top' in sys.argv else 20
    run(sys.argv[1], top)
