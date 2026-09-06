#!/usr/bin/env python3
"""市場廣度歷史(breadth.json)寫入邏輯單元測試 —— 不打網路,用假的 data/*.json。

背景:使用者問「市場廣度要不要跟前一天比對才有用」。
      查證後:廣度目前是前端從即時快照算的**當下數字**,完全沒有存歷史,
      所以算不出累積騰落線(ADL)、也做不出「指數創新高但廣度沒跟上」的背離判斷。
      V71.3.8 在 miner.py 既有的「漲停家數」迴圈裡順便統計並存成滾動 250 日歷史。

驗:
  ① 正常統計:漲/跌/平/漲停/跌停/強勢/弱勢 數字正確
  ② 同一天重跑 → 覆蓋不重複(不會一天記兩筆把 ADL 灌歪)
  ③ 檔數不足(<500)→ 不寫入(避免資料還沒鋪好時記到髒點)
  ④ 累積 250 筆上限
  ⑤ 舊檔壞掉 → 不炸,當成空的重建
"""
import json
import sys
import tempfile
from pathlib import Path


def compute(rows_by_sym):
    """複製 miner.py 的統計規則(門檻必須與 miner.py 一致)。"""
    limit_up = up = dn = flat = limdn = strong = weak = 0
    bdate = ''
    for sym, raw in rows_by_sym.items():
        if not (len(sym) == 4 and sym.isdigit()):
            continue
        if not isinstance(raw, list) or len(raw) < 2:
            continue
        c, pc = float(raw[-1]['close']), float(raw[-2]['close'])
        if pc <= 0:
            continue
        chg = (c - pc) / pc * 100
        if chg >= 9.0:
            limit_up += 1
        elif chg <= -9.0:
            limdn += 1
        if chg > 0.05:
            up += 1
        elif chg < -0.05:
            dn += 1
        else:
            flat += 1
        if chg >= 3:
            strong += 1
        elif chg <= -3:
            weak += 1
        if not bdate:
            bdate = str(raw[-1].get('date') or '')
    return dict(lu=limit_up, up=up, dn=dn, flat=flat, ld=limdn, st=strong, wk=weak,
                total=up + dn + flat, d=bdate)


def mk(sym_n, chg_list, d='2026/07/29'):
    """造 chg_list 指定漲跌幅的假 K 線"""
    out = {}
    for i, chg in enumerate(chg_list):
        sym = str(2000 + i)
        out[sym] = [{'date': '2026/07/28', 'close': 100.0},
                    {'date': d, 'close': round(100.0 * (1 + chg / 100), 4)}]
    return out


def append_hist(path, row, total, hist_cap=250, min_total=500):
    """複製 miner.py 的寫入規則"""
    if total < min_total:
        return None
    bd = {}
    if path.exists():
        try:
            bd = json.loads(path.read_text(encoding='utf-8')) or {}
        except Exception:
            bd = {}
    hist = bd.get('history')
    if not isinstance(hist, list):
        hist = []
    hist = [h for h in hist if isinstance(h, dict) and h.get('d') != row['d']]
    hist.append(row)
    hist.sort(key=lambda x: str(x.get('d') or ''))
    hist = hist[-hist_cap:]
    path.write_text(json.dumps({'updated': 'x', 'history': hist}, ensure_ascii=False), encoding='utf-8')
    return hist


# ── ① 統計正確 ──────────────────────────────────────────────────────────
chgs = [10.0, 9.5, 5.0, 3.0, 0.5, 0.0, -0.02, -1.0, -3.0, -9.5, -10.0]
r = compute(mk(0, chgs))
assert r['lu'] == 2, f"漲停應 2(10.0/9.5),實際 {r['lu']}"
assert r['ld'] == 2, f"跌停應 2(-9.5/-10.0),實際 {r['ld']}"
assert r['up'] == 5, f"上漲應 5(10/9.5/5/3/0.5),實際 {r['up']}"
# ⚠️ 這裡我第一版自己算錯:-0.02% 沒有 < -0.05,屬「平盤」不算下跌;
#    -3% 有到 <=-3 算弱勢,但 -0.02 不算。門檻是 ±0.05(平盤帶)與 ±3(強弱勢)。
assert r['dn'] == 4, f"下跌應 4(-1/-3/-9.5/-10),實際 {r['dn']}"
assert r['flat'] == 2, f"平盤應 2(0.0/-0.02,落在 ±0.05 平盤帶),實際 {r['flat']}"
assert r['st'] == 4, f"強勢(>=3%)應 4,實際 {r['st']}"
assert r['wk'] == 3, f"弱勢(<=-3%)應 3(-3/-9.5/-10),實際 {r['wk']}"
assert r['total'] == 11
print(f"✅ ① 統計正確:漲{r['up']} 跌{r['dn']} 平{r['flat']} 漲停{r['lu']} 跌停{r['ld']} 強{r['st']} 弱{r['wk']}")

with tempfile.TemporaryDirectory() as td:
    p = Path(td) / 'breadth.json'
    # ── ② 同日重跑覆蓋不重複 ────────────────────────────────────────────
    row = {'d': '2026/07/29', 'up': 511, 'dn': 1706}
    append_hist(p, row, 600)
    append_hist(p, {**row, 'up': 520}, 600)          # 同一天再跑一次
    h = json.loads(p.read_text())['history']
    assert len(h) == 1, f"② 同日應只留 1 筆,實際 {len(h)}"
    assert h[0]['up'] == 520, "② 應該是後蓋前(取較新的那次)"
    print("✅ ② 同一天重跑 → 覆蓋不重複(ADL 不會被灌歪)")

    # ── ③ 檔數不足不寫入 ────────────────────────────────────────────────
    before = p.read_text()
    got = append_hist(p, {'d': '2026/07/30', 'up': 1}, 120)
    assert got is None and p.read_text() == before, "③ 檔數<500 不該寫入"
    print("✅ ③ 全市場只算到 120 檔 → 不記錄(避免資料沒鋪好時汙染累積線)")

    # ── ④ 250 筆上限 ────────────────────────────────────────────────────
    for i in range(300):
        append_hist(p, {'d': f'2025/{(i % 12) + 1:02d}/{(i % 28) + 1:02d}_{i}', 'up': i}, 600)
    h = json.loads(p.read_text())['history']
    assert len(h) == 250, f"④ 應上限 250,實際 {len(h)}"
    print("✅ ④ 滾動上限 250 個交易日(約一年)")

    # ── ⑤ 舊檔壞掉不炸 ──────────────────────────────────────────────────
    p.write_text('{壞掉的 json', encoding='utf-8')
    got = append_hist(p, {'d': '2026/08/01', 'up': 9}, 600)
    assert got and len(got) == 1, "⑤ 壞檔應視為空的重建"
    print("✅ ⑤ 舊檔壞掉 → 當成空的重建,不會整支採礦掛掉")

# ── ⑥ ADL 累積 + 背離的算法可行性(用假歷史驗證觀念正確)────────────────
hist = [{'d': f'2026/07/{d:02d}', 'up': u, 'dn': dn} for d, u, dn in
        [(20, 1200, 900), (21, 1300, 800), (22, 1100, 1000), (23, 900, 1200), (24, 700, 1400)]]
adl, cum = [], 0
for h in hist:
    cum += h['up'] - h['dn']
    adl.append(cum)
assert adl == [300, 800, 900, 600, -100], adl   # 700-1400=-700 → 600-700=-100(我第二次又手算錯,以程式為準)
# 指數創新高但 ADL 沒創新高 = 背離
idx = [46000, 46500, 47000, 47200, 47500]     # 指數一路新高
assert idx[-1] == max(idx) and adl[-1] < max(adl), "應偵測到背離"
print(f"✅ ⑥ ADL 累積線 {adl} + 背離判斷可行(指數創新高但 ADL 反轉向下)")

print("\n🎉 市場廣度歷史 六項測試全過")
