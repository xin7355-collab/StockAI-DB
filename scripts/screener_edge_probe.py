#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔎 選股條件實測探針 —— 只讀 data/,不打網路、不寫產物。

❓ 使用者(2026-08-30):「還有什麼高勝率的訊號嗎?放在選股裡面」

⭐⭐ 先講清楚問題本身:**「高勝率」是錯的目標。**
   本專案 V72.9.7 已實測:加上「只做成交值 ≥1 億」勝率 +3.4pp,**卻少賺 307,528 元**
   —— 濾掉小型股 = 濾掉跑最遠的那幾檔。所以這支問的是**期望值**(超額報酬),
   勝率只當附帶資訊顯示,⛔ 不當判準。

📌 為什麼這支存在:選股頁有 **170 個條件**,使用者勾了就以為那是驗證過的做法,
   但其中**只有 1 個**(5 日週轉率,V73.8.2)有實測數字。其餘全是「聽起來合理」。

⭐ 關鍵設計:**直接呼叫 `screener_miner.build_one(rows[:i+1])`**
   —— 它的 docstring 就寫著「⛔ 只用到當天為止的資料」,所以拿它跑歷史
   ① 天然沒有前視偏誤 ② ⛔ 不會產生第二份欄位定義(避免同名不同義)。
   條件本身從 index.html 的 `_SCR_CONDS` 直接解析出來(那是**資料**不是邏輯)。

📐 六道關卡(跟本專案其他探針一致):
   ・對照組 = 同一個母體、不抽樣          ・報酬扣同期加權指數
   ・前後半段同向(中點對齊**實際樣本**)  ・逐年同向 ・拿掉最好那一年
   ・扣來回成本 0.44%
   ・⭐ **同檔同條件 20 日去重** —— 前瞻 20 日的相鄰窗口有 19 天是重疊的,
     不去重的話 n 會灌水到看起來很可信(本專案 sector_flow 那次記過:47 筆其實只有 18 個獨立事件)。
🚧 空過守門:獨立事件數 < 3 萬 → exit 1;可回測條件 < 60 個 → exit 1。
"""
import json
import math
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import screener_miner as SM  # noqa: E402

DATA = Path(os.environ.get('DATA_DIR') or (ROOT / 'data'))
WARM = 250          # 年位階要 252 根才有意義
FWD = 20            # 前瞻天期(選股是波段用途)
COST = 0.44         # 股票來回成本 %
MIN_AMT = 0.1       # 🚧 可交易性:成交額 ≥ 0.1 億(1,000 萬)
DAY_STRIDE = int(os.environ.get('STRIDE', '1'))

CI = SM.CI

# ── 從 index.html 解析 _SCR_CONDS(只取「單一欄位 + 比較」那種)────────
src = (ROOT / 'index.html').read_text(encoding='utf-8')
i0 = src.index('    _SCR_CONDS: [')
depth, end = 0, None
for k in range(i0 + len('    _SCR_CONDS: ['), len(src)):
    if src[k] == '[':
        depth += 1
    elif src[k] == ']':
        if depth == 0:
            end = k
            break
        depth -= 1
blk = src[i0:end]
CONDS = []
for m in re.finditer(
        r"\{ id: '([A-Za-z0-9_]+)',\s*g: '(\w+)',\s*s: '([^']+)',\s*t: '([^']+)',"
        r"\s*k: '(\w+)',\s*op: '(\w+)',\s*v: (-?[\d.]+)", blk):
    cid, g, sub, title, key, op, val = m.groups()
    if key not in CI:
        continue
    CONDS.append({'id': cid, 'g': g, 's': sub, 't': title, 'k': key, 'op': op, 'v': float(val)})
print(f'📋 index.html 解析到 {len(CONDS)} 個「單一欄位」條件(全部 170 個,其餘 43 個要自訂函式)')
if len(CONDS) < 60:
    sys.exit('🚧 空過守門:解析到的條件太少,regex 可能跟不上 _SCR_CONDS 的寫法了')

OPS = {
    'gt': lambda x, v: x > v, 'gte': lambda x, v: x >= v,
    'lt': lambda x, v: x < v, 'lte': lambda x, v: x <= v,
    'eq': lambda x, v: x == v, 'ne': lambda x, v: x != v,
}
CONDS = [c for c in CONDS if c['op'] in OPS]

# ── 日期軸 + 大盤 ────────────────────────────────────────────────
tw = json.loads((DATA / '^TWII.json').read_text(encoding='utf-8'))
tw = [r for r in (tw if isinstance(tw, list) else tw.get('data') or []) if float(r.get('close') or 0) > 0]
TWC = {str(r['date']).replace('/', '-'): float(r['close']) for r in tw}
TWD = [str(r['date']).replace('/', '-') for r in tw]
TWI = {d: i for i, d in enumerate(TWD)}
TWCH = {}
for i in range(1, len(TWD)):
    a, b = TWC[TWD[i - 1]], TWC[TWD[i]]
    TWCH[TWD[i]] = (b / a - 1) * 100 if a > 0 else 0.0
print(f'📈 日期軸 {len(TWD)} 天({TWD[0]} ~ {TWD[-1]})')

files = sorted(f for f in os.listdir(DATA)
               if re.fullmatch(r'\d{4,6}\.json', f) and not f.startswith('00'))
print(f'📂 掃 {len(files)} 檔(已排除 ETF)・日期取樣間隔 {DAY_STRIDE}')


class St:
    __slots__ = ('n', 'sum', 'win', 'byY', 'h1n', 'h1s', 'h2n', 'h2s')

    def __init__(self):
        self.n = 0
        self.sum = 0.0
        self.win = 0
        self.byY = defaultdict(lambda: [0, 0.0])
        self.h1n = self.h2n = 0
        self.h1s = self.h2s = 0.0

    def add(self, ex, year, h1):
        self.n += 1
        self.sum += ex
        if ex > 0:
            self.win += 1
        y = self.byY[year]
        y[0] += 1
        y[1] += ex
        if h1:
            self.h1n += 1
            self.h1s += ex
        else:
            self.h2n += 1
            self.h2s += ex


STAT = defaultdict(St)
BASE = St()

# 先算出實際樣本的日期範圍中點(🚨 ⛔ 不可用整條日期軸的中點 —— 個股 K 線起點晚很多)
gmin, gmax = 10 ** 9, -1
meta = []
for f in files:
    try:
        rows = json.loads((DATA / f).read_text(encoding='utf-8'))
    except Exception:
        continue
    rows = rows if isinstance(rows, list) else (rows.get('data') or [])
    rows = [r for r in rows if float(r.get('close') or 0) > 0]
    if len(rows) < WARM + FWD + 10:
        continue
    ds = [str(r['date']).replace('/', '-') for r in rows]
    if ds[WARM] in TWI:
        gmin = min(gmin, TWI[ds[WARM]])
    if ds[-1 - FWD] in TWI:
        gmax = max(gmax, TWI[ds[-1 - FWD]])
    meta.append((f[:-5], rows, ds))
MID = (gmin + gmax) // 2
print(f'✅ 可用 {len(meta)} 檔 ・ 實際樣本 {TWD[gmin]} ~ {TWD[gmax]}(中點 {TWD[MID]})')

EV = 0
for si, (sym, rows, ds) in enumerate(meta):
    if si % 300 == 0:
        print(f'  … {si}/{len(meta)}  事件 {EV:,}', flush=True)
    n = len(rows)
    cl = [float(r['close']) for r in rows]
    last, last_base = {}, -10 ** 9      # 去重游標(每檔自己一份)
    for i in range(WARM, n - FWD, DAY_STRIDE):
        d, dF = ds[i], ds[i + FWD]
        gi = TWI.get(d)
        if gi is None or dF not in TWC or d not in TWC:
            continue
        v = SM.build_one(rows[:i + 1], TWCH.get(d))
        if v is None:
            continue
        amt = v[CI['amt']]
        if amt is None or amt < MIN_AMT:
            continue
        ex = (cl[i + FWD] / cl[i] - 1) * 100 - (TWC[dF] / TWC[d] - 1) * 100
        year, h1 = d[:4], gi < MID
        # ⭐ 20 日去重:同一檔、同一個條件,20 個交易日內只算一次
        if i - last_base >= FWD:
            last_base = i
            EV += 1
            BASE.add(ex, year, h1)
        for c in CONDS:
            x = v[CI[c['k']]]
            if x is None:
                continue
            if OPS[c['op']](x, c['v']) and i - last.get(c['id'], -10 ** 9) >= FWD:
                last[c['id']] = i
                STAT[c['id']].add(ex, year, h1)

print(f'\n🔢 事件(股·日)= {EV:,}')
if EV < 30000:
    sys.exit('🚧 空過守門:事件數太少,結論不可信')

b_ex = BASE.sum / BASE.n
b_wr = BASE.win / BASE.n * 100
print(f'📊 對照組(隨便挑一天,成交額 ≥1,000 萬):{FWD} 日超額 平均 {b_ex:+.3f}% ・ 勝率 {b_wr:.1f}% ・ n={BASE.n:,}')
print(f'   ⚠️ 勝率基準不是 50% —— 中位數個股本來就跑輸市值加權的大盤。\n')


def gates(st):
    """回 (扣成本後超額, 前半, 後半, 逐年是否同向, 去最好年後, 六關全過?)"""
    m = st.sum / st.n - COST
    h1 = st.h1s / st.h1n - COST if st.h1n else float('nan')
    h2 = st.h2s / st.h2n - COST if st.h2n else float('nan')
    yv = sorted((y, o[1] / o[0] - COST, o[0]) for y, o in st.byY.items())
    allpos = all(x > 0 for _, x, _ in yv)
    best = max(yv, key=lambda t: t[1])
    rn, rs_ = st.n - best[2], st.sum - st.byY[best[0]][1]
    xb = rs_ / rn - COST if rn else float('nan')
    return m, h1, h2, allpos, xb, yv, best[0], (m > 0 and h1 > 0 and h2 > 0 and allpos and xb > 0)


rows_out = []
for c in CONDS:
    st = STAT.get(c['id'])
    if not st or st.n < 300:
        continue
    m, h1, h2, allpos, xb, yv, by, ok = gates(st)
    rows_out.append((c, st, m, h1, h2, allpos, xb, yv, by, ok))

rows_out.sort(key=lambda t: -t[2])
print(f'{"條件":<26}{"組":<6}{"事件數":>9}{"扣成本":>9}{"勝率":>8}{"前半":>8}{"後半":>8}{"去最好年":>10}{"vs對照":>9}  六關')
print('─' * 104)
for c, st, m, h1, h2, allpos, xb, yv, by, ok in rows_out:
    print(f"{c['t'][:24]:<26}{c['s']:<6}{st.n:>9,}{m:>9.3f}{st.win / st.n * 100:>7.1f}%"
          f"{h1:>8.2f}{h2:>8.2f}{xb:>10.2f}{st.sum / st.n - b_ex:>+9.2f}  {'✅' if ok else '❌'}")

pas = [r for r in rows_out if r[9]]
print(f'\n🏁 {len(rows_out)} 個可回測條件裡,**六關全過 {len(pas)} 個**')
for c, st, m, h1, h2, allpos, xb, yv, by, ok in pas:
    print(f"  ✅ {c['t']}({c['s']})  n={st.n:,} ・ 扣成本 {m:+.3f}% ・ 勝率 {st.win / st.n * 100:.1f}%"
          f" ・ 去最好年({by}) {xb:+.3f}%")
    print(f"     逐年 " + ' '.join(f'{y}:{x:+.2f}({nn})' for y, x, nn in yv))

skipped = [c for c in CONDS if c['id'] not in STAT or STAT[c['id']].n < 300]
if skipped:
    print(f'\n⚠️ 樣本不足或欄位無歷史 → 測不了的 {len(skipped)} 個:'
          + '、'.join(c['t'] for c in skipped[:24]) + ('…' if len(skipped) > 24 else ''))

if os.environ.get('EMIT'):
    out = {
        'win': [TWD[gmin], TWD[gmax]], 'fwd': FWD, 'cost': COST,
        'syms': len(meta), 'n': BASE.n,
        'base': [round(b_ex, 3), round(b_wr, 1)],
        # id → [扣成本後超額%, 勝率%, 樣本數, 六關全過?1:0]
        # id → [扣成本後超額%, 勝率%, 樣本數, 六關全過?, 相對對照組 pp]
        'c': {c['id']: [round(m, 3), round(st.win / st.n * 100, 1), st.n, 1 if ok else 0,
                        round(st.sum / st.n - b_ex, 2)]
              for c, st, m, h1, h2, allpos, xb, yv, by, ok in rows_out},
    }
    print('\n===EMIT_JSON===')
    print(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
