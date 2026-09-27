#!/usr/bin/env python3
"""🧱 V77.7.0 陷阱 #46:日 K 還原價修復守門

釘住:
 ① `_on_tick` / `_tick_of`(上市櫃與 ETF 兩張階梯、float32 殘差容忍)
 ② `_repair_from_deep` 整段換:兩列合法列之間的還原價段**整段**換成深歷史 —— 包含剛好落在格上的那幾列
    (⭐ 決定性對照:第一版逐列挑「不在格上才換」,實測製造 3,900 個假跳空)
 ③ 深歷史那天沒資料的列 → 用段內最近一列的比例縮放(⛔ 不可留原值 = 斷崖)
 ④ 籌碼欄一個都不動
 ⑤ 分割尺標不同(r = 1/4)是合法列,⛔ 不換;兩端倍數不同 → 整段不動
 ⑥ 冪等:跑第二次零變動
 ⑦ yfinance 守門:不在格上的列 ⛔ 不寫(原始碼釘住)
 ⑧ export_json 有呼叫,而且排在 _backadjust_splits **之前**
跑法:python3 scripts/test_kline_repair.py
"""
import copy, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]
import miner  # noqa: E402

FAIL = []
def ck(c, m):
    print(('✅ ' if c else '❌ ') + m)
    if not c:
        FAIL.append(m)

# ① 跳動單位
ck(miner._on_tick(98.1) and miner._on_tick(98.0999984741) and not miner._on_tick(98.14), '①a 50~100 元 0.1 一格,容忍 float32 殘差')
ck(miner._on_tick(1090) and not miner._on_tick(1092), '①b 1000 元以上 5 元一格')
ck(miner._on_tick(23.45) and not miner._on_tick(23.47), '①c 10~50 元 0.05 一格')
ck(miner._on_tick(52.37, etf=True) is False and miner._on_tick(52.35, etf=True), '①d ETF ≥50 元 0.05 一格')
ck(not miner._on_tick(None) and not miner._on_tick(0), '①e 空值/0 不算在格上')

# 合成:官方價 deep(每天 100 → 緩漲),我們的資料中間一段被 ×0.898 然後 ×0.914 還原
def mk():
    deep = []; ours = []
    p = 100.0
    for i in range(40):
        d = f'2024-01-{i+1:02d}' if i < 31 else f'2024-02-{i-30:02d}'
        p = round(p * (1.004 if i % 3 else 0.997), 1)
        deep.append([d, p, p + 1, p - 1, p, 1000 + i])
        c = p
        if 10 <= i < 20: c = round(p * 0.898, 2)
        elif 20 <= i < 26: c = round(p * 0.914, 2)
        ours.append({'date': d.replace('-', '/'), 'open': c, 'high': c + 1, 'low': c - 1, 'close': c,
                     'volume': 999, 'foreign_net': i * 7, 'margin_balance': 50 + i})
    return deep, ours

deep, ours = mk()
# 讓段內有一列剛好在格上(還原價湊巧落在 0.5 格)、一列深歷史沒資料
ours[12]['close'] = 90.5; ours[12]['open'] = 90.5
deep_missing = [r for r in deep if r[0] != deep[15][0]]
rec, n, why = miner._repair_from_deep(copy.deepcopy(ours), 'T1', deep_missing)
ck(n >= 16, f'②a 還原價兩段共 16 列都換了(換了 {n})')
ck(all(abs(rec[i]['close'] - deep[i][4]) < 1e-6 for i in range(40) if i != 15), '②b 換完每一列 = 官方價(含剛好在格上的第 12 列)')
ck(abs(rec[15]['close'] / deep[15][4] - 1) < 0.01, f'③ 深歷史沒資料那列用鄰列比例縮放({rec[15]["close"]} vs 官方 {deep[15][4]})')
ck(all(rec[i]['foreign_net'] == ours[i]['foreign_net'] and rec[i]['margin_balance'] == ours[i]['margin_balance'] for i in range(40)),
   '④ 籌碼欄一個都沒動')
jumps = sum(1 for a, b in zip(rec, rec[1:]) if not (0.9 < b['close'] / a['close'] < 1.1))
ck(jumps == 0, f'②c 換完沒有任何假跳空({jumps})')

# ⑤ 分割尺標:我們整段是深歷史的 1/4(兩邊還原時點不同)→ 合法,不動
deep2 = [[r[0], r[1] * 4, r[2] * 4, r[3] * 4, r[4] * 4, r[5]] for r in deep]
ours2 = [dict(r, close=r['close']) for r in mk()[1]]
for i in range(40):
    ours2[i]['close'] = deep[i][4]; ours2[i]['open'] = deep[i][1]
rec2, n2, _ = miner._repair_from_deep(copy.deepcopy(ours2), 'T2', deep2)
ck(n2 == 0, f'⑤a 整檔差 1/4(分割尺標不同)= 合法,⛔ 不換(換了 {n2})')
# 兩端倍數不同:前段 r=1、後段 r=1/4、中間夾一段還原價 → 整段不動
ours3 = copy.deepcopy(ours2)
deep3 = [list(r) for r in deep]
for i in range(25, 40):
    deep3[i] = [deep[i][0]] + [x * 4 for x in deep[i][1:5]] + [deep[i][5]]
for i in range(18, 25):
    ours3[i]['close'] = round(deep[i][4] * 0.9, 2)
rec3, n3, why3 = miner._repair_from_deep(copy.deepcopy(ours3), 'T3', deep3)
ck(n3 == 0 and why3 and '分割邊界' in why3, f'⑤b 夾在兩種倍數中間的段 ⛔ 不動並說原因({why3})')

# ⑥ 冪等
rec4, n4, _ = miner._repair_from_deep(copy.deepcopy(rec), 'T1', deep_missing)
ck(n4 == 0 or all(abs(a['close'] - b['close']) < 1e-6 for a, b in zip(rec, rec4)), '⑥ 跑第二次零變動')

# 決定性對照:逐列挑「不在格上才換」的寫法會留下第 12 列 → 假跳空
alt = copy.deepcopy(ours)
for i, r in enumerate(alt):
    if i != 15 and not miner._on_tick(r['close']) and abs(r['close'] / deep[i][4] - 1) > 0.005:
        r['close'] = deep[i][4]
alt_j = sum(1 for a, b in zip(alt, alt[1:]) if not (0.9 < b['close'] / a['close'] < 1.1))
ck(alt_j > 0, f'⭐ 決定性對照:逐列挑的舊寫法會留下假跳空({alt_j} 個)—— 整段換才是對的')

# ⑦⑧ 原始碼
src = open(os.path.join(ROOT, 'miner.py'), encoding='utf-8').read()
fb = src[src.index('def yfinance_ohlcv_fallback'):src.index('def needs_price_fix')]
ck('if not _on_tick(cls, _etf):' in fb and 'continue' in fb.split('if not _on_tick(cls, _etf):')[1][:200],
   '⑦ yfinance 不在格上的列 ⛔ 不寫')
ex = src[src.index('def export_json'):src.index('def seed_db_from_json')]
ia, ib = ex.find('_repair_from_deep(records, sym)'), ex.find('_backadjust_splits(records, sym, verbose=True)')
ck(ia > 0 and ib > ia, '⑧ export_json 先修還原價、再做分割還原(兩邊才是同一把尺)')
wf = open(os.path.join(ROOT, '.github/workflows/daily_miner.yml'), encoding='utf-8').read()
ck('KLINES_DEEP_DIR' in wf and 'git archive origin/klines_deep' in wf, '⑧b daily_miner 有把 klines_deep 解給採礦節點')

print(f"\n{'✅ 全部通過' if not FAIL else '❌ ' + str(len(FAIL)) + ' 條沒過'}")
sys.exit(1 if FAIL else 0)
