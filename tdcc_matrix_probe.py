#!/usr/bin/env python3
"""🧭 集保「四象限矩陣」+「隱藏大戶扣抵」探針(使用者 2026-08-05 提供的 Gemini 說明)

要驗兩個**預測性主張**(⛔ 沒實測前不准做成卡片下方向):

【① 四象限矩陣】千張大戶比例 × 股東人數,兩兩交叉:
   大戶↑ 人數↓ = 主力吸籌(它說偏多)   ・大戶↓ 人數↑ = 籌碼渙散(它說偏空)
   大戶↑ 人數↑ = 共識追捧             ・大戶↓ 人數↓ = 冷門退場
⭐ 為什麼值得測:這兩條腿我**都已經單獨測過**,而且都有小邊際 ——
   大戶方向(V71.9.0 兩上兩下)、股東人數(V71.9.7,人數↓ 比 人數↑ 好 +0.88pp);
   但**兩者交叉**從來沒測過。四象限如果只是把兩個小邊際相加,那就沒有新資訊,
   ⛔ 不值得為它做一張卡;要有**交互作用**(某一格明顯超過兩腿相加)才有意義。
⚠️ `h[i][4]` 是「持股 ≤10 張的股東人數」,不是總股東人數(集保 CSV 的總人數沒存每週值)。
   散戶佔人數 95% 以上,所以是很好的代理,⛔ 但 UI 文案不可寫成「總股東人數」。

【② 隱藏大戶扣抵】它給的公式:
   千張大戶本週異動張數 − 三大法人本週買賣超張數 = 公司派/在地大戶異動張數
⭐ 這是**算術事實**(不是預測),所以「算出來」本身不需要實測;
   但「隱藏大戶買很多 → 會漲」**是預測**,要驗。
⚠️ 已知偏誤:千張大戶也包含**被動 ETF**(高股息 ETF 納入成分股會拉高大戶比例),
   Gemini 自己也有提醒 → 扣完法人剩下的那部分**不等於**公司派。

方法論(照 CLAUDE.md):乾淨對照組(所有掃到的週,⛔ 不抽樣)、報酬扣同期加權、每檔每週最多算一次。

只讀 data/,不打 API、不寫檔。跑法:python3 tdcc_matrix_probe.py
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

DATA = Path('data')
HORIZONS = (5, 10, 20, 60)      # 交易日
MIN_BUCKET = 150


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


# ── 深歷史優先(V72.5.1 起採礦端會產出),沒有就退回 13 週淺檔 ──
tdcc = load(DATA / 'tdcc_deep.json')
SRC = 'tdcc_deep.json(深歷史)'
if not isinstance(tdcc, dict) or len(tdcc) < 100:
    tdcc = load(DATA / 'tdcc_holders.json')
    SRC = 'tdcc_holders.json(13 週淺檔)'
if not isinstance(tdcc, dict):
    raise SystemExit('❌ 找不到集保資料')
# ⚠️ 深檔早期版本沒存 `t`(總發行股數)→ 從淺檔補回來,否則「隱藏大戶」那段會靜默拿到 0 筆
_shallow = load(DATA / 'tdcc_holders.json') or {}
for _k, _v in tdcc.items():
    if isinstance(_v, dict) and not _v.get('t'):
        _v['t'] = (_shallow.get(_k) or {}).get('t') or 0

tw_rows = load(DATA / '^TWII.json') or []
tw = {}
for r in tw_rows:
    try:
        c = float(r['close'])
        if c > 0:
            tw[r['date'].replace('/', '-')] = c
    except Exception:
        continue
tw_days = sorted(tw)
tw_idx = {d: i for i, d in enumerate(tw_days)}

weeks_max = max((len((v or {}).get('h') or []) for v in tdcc.values() if isinstance(v, dict)), default=0)
print(f'📥 資料源:{SRC} ・{len(tdcc)} 檔 ・最長 {weeks_max} 週\n')

QUAD = {
    (1, -1): '⭐ 大戶↑ 人數↓(它說:主力吸籌·偏多)',
    (-1, 1): '⚠️ 大戶↓ 人數↑(它說:籌碼渙散·偏空)',
    (1, 1):  '➖ 大戶↑ 人數↑(它說:共識追捧)',
    (-1, -1): '➖ 大戶↓ 人數↓(它說:冷門退場)',
}
quad_ev = {k: {h: [] for h in HORIZONS} for k in QUAD}
leg_big = {1: {h: [] for h in HORIZONS}, -1: {h: [] for h in HORIZONS}}     # 只看大戶那條腿
leg_ppl = {1: {h: [] for h in HORIZONS}, -1: {h: [] for h in HORIZONS}}     # 只看人數那條腿
HID = [(-1e18, -3000, '隱藏大戶 賣 >3,000 張'), (-3000, -300, '賣 300~3,000'),
       (-300, 300, '±300 內(沒動)'), (300, 3000, '買 300~3,000'),
       (3000, 1e18, '⭐ 隱藏大戶 買 >3,000 張')]
hid_ev = {b[2]: {h: [] for h in HORIZONS} for b in HID}
base = {h: [] for h in HORIZONS}
n_sym = n_evt = n_hid = 0


def fwd(px_map, days, d0, hz):
    """個股 hz 個交易日後的超額報酬(扣同期加權)"""
    i = days.get(d0)
    if i is None:
        return None
    j = i + hz
    if j >= len(px_map['ord']):
        return None
    d1 = px_map['ord'][j]
    if d0 not in tw or d1 not in tw:
        return None
    return (px_map['c'][d1] / px_map['c'][d0] - 1) * 100 - (tw[d1] / tw[d0] - 1) * 100


for sym, v in tdcc.items():
    if sym.startswith('_') or not isinstance(v, dict):
        continue
    h = [x for x in (v.get('h') or []) if isinstance(x, list) and len(x) >= 5]
    if len(h) < 4:
        continue
    tot = float(v.get('t') or 0)
    rows = load(DATA / f'{sym}.json')
    if not isinstance(rows, list) or len(rows) < 60:
        continue
    px = {}
    order = []
    inst = {}
    for r in rows:
        try:
            c = float(r['close'])
            d = r['date'].replace('/', '-')
        except Exception:
            continue
        if c <= 0:
            continue
        px[d] = c
        order.append(d)
        inst[d] = (float(r.get('foreign_net') or 0) + float(r.get('trust_net') or 0)
                   + float(r.get('dealer_net') or 0))
    order = sorted(set(order))
    dmap = {d: i for i, d in enumerate(order)}
    pxm = {'c': px, 'ord': order}
    n_sym += 1

    for k in range(1, len(h)):
        prev, cur = h[k - 1], h[k]
        d8 = str(cur[0])
        d0 = f'{d8[:4]}-{d8[4:6]}-{d8[6:]}'
        # 集保日通常是週五(有時休市)→ 取「≤ 該日的最後一個交易日」當進場基準
        cand = [d for d in order if d <= d0]
        if not cand:
            continue
        d0 = cand[-1]
        # ⚠️ 每個天期**各自獨立**收 —— ⛔ 不可「有一個算不出來就整筆丟掉」。
        #   第一版寫成「四個天期缺一就 break」→ 集保最新那幾週後面根本沒有 60 個交易日,
        #   於是**幾乎每一筆都被丟掉**(實測只剩 1 筆事件),看起來像沒資料,其實是自己濾掉的。
        rets = {}
        for hz in HORIZONS:
            r = fwd(pxm, dmap, d0, hz)
            if r is not None:
                rets[hz] = r
        if not rets:
            continue
        for hz, r in rets.items():
            base[hz].append(r)
        dbig = float(cur[1]) - float(prev[1])          # 千張大戶 % 變化
        dppl = int(cur[4]) - int(prev[4])              # 散戶人數變化
        if abs(dbig) < 0.05 or dppl == 0:              # 幾乎沒動 → 不算事件(避免雜訊灌樣本)
            continue
        sb, sp = (1 if dbig > 0 else -1), (1 if dppl > 0 else -1)
        n_evt += 1
        for hz, r in rets.items():
            quad_ev[(sb, sp)][hz].append(r)
            leg_big[sb][hz].append(r)
            leg_ppl[sp][hz].append(r)
        # ② 隱藏大戶扣抵:大戶異動張數 − 該週法人買賣超
        if tot > 0:
            big_lots = dbig / 100 * tot / 1000                  # % → 股 → 張
            pd8 = str(prev[0]); pd0 = f'{pd8[:4]}-{pd8[4:6]}-{pd8[6:]}'
            wk = [d for d in order if pd0 < d <= d0]
            if wk:
                inst_lots = sum(inst.get(d, 0) for d in wk)     # 法人週淨買超(張)
                hidden = big_lots - inst_lots
                n_hid += 1
                for lo, hi, name in HID:
                    if lo <= hidden < hi:
                        for hz, r in rets.items():
                            hid_ev[name][hz].append(r)
                        break

med = statistics.median
print(f'掃 {n_sym} 檔 ・四象限事件 {n_evt:,} 筆 ・隱藏大戶事件 {n_hid:,} 筆\n')
if not base[HORIZONS[0]]:
    raise SystemExit('❌ 沒有可用樣本')
print('對照組(同批股票所有集保週,扣同期加權後):')
for hz in HORIZONS:
    b = base[hz]
    print(f'  {hz:>3} 日:中位 {med(b):+6.2f}% ・勝率 {sum(1 for x in b if x>0)/len(b)*100:4.1f}% ・n={len(b):,}')


def show(name, arr, pad=34):
    line = f'  {name:<{pad}}'
    for hz in HORIZONS:
        e = arr[hz]
        if len(e) < MIN_BUCKET:
            line += f'  {hz:>2}日:n={len(e)}不足'
            continue
        edge = med(e) - med(base[hz])
        w = sum(1 for x in e if x > 0) / len(e) * 100
        line += f'  {hz:>2}日 {edge:+5.2f}pp/勝{w:4.1f}%'
    line += f'  n={len(arr[HORIZONS[0]]):,}'
    print(line)
    return {hz: (med(arr[hz]) - med(base[hz])) if len(arr[hz]) >= MIN_BUCKET else None for hz in HORIZONS}


print(f'\n{"═"*118}\n① 兩條腿分開看(先建立基準,才知道四象限有沒有「交互作用」)\n{"═"*118}')
lb = {s: show(f'千張大戶 {"↑" if s > 0 else "↓"}', leg_big[s]) for s in (1, -1)}
lp = {s: show(f'散戶人數 {"↑" if s > 0 else "↓"}', leg_ppl[s]) for s in (1, -1)}

print(f'\n{"═"*118}\n② 四象限(⭐ 關鍵:有沒有超過「兩條腿相加」)\n{"═"*118}')
for key, name in QUAD.items():
    got = show(name, quad_ev[key], pad=34)
    sb, sp = key
    add = {hz: (None if lb[sb][hz] is None or lp[sp][hz] is None else lb[sb][hz] + lp[sp][hz])
           for hz in HORIZONS}
    parts = [f'{hz}日 兩腿相加 {add[hz]:+5.2f}pp → 交互作用 {got[hz]-add[hz]:+5.2f}pp'
             for hz in HORIZONS if got[hz] is not None and add[hz] is not None]
    if parts:
        print('       ↳ ' + ' ・ '.join(parts))

print(f'\n{"═"*118}\n③ 隱藏大戶扣抵(千張大戶異動張數 − 該週三大法人買賣超)\n{"═"*118}')
for _, _, name in HID:
    show(name, hid_ev[name], pad=24)

print('\n⚠️ 判讀限制:')
print(f'  ・集保只有 {weeks_max} 週 → 全部落在同一段行情,⛔ 不可外推')
print('  ・邊際 ±0.5pp 內視為雜訊;未扣交易成本(來回約 0.44%)')
print('  ・`h[4]` 是「≤10 張股東人數」不是總股東人數(代理指標)')
print('  ・千張大戶含**被動 ETF**;扣掉法人剩下的⛔不等於公司派')
print('  ・法人欄位(foreign/trust/dealer)只回溯到 2026/05 → 隱藏大戶那段樣本更薄')
