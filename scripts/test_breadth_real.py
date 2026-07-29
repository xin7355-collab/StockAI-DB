#!/usr/bin/env python3
"""直接呼叫 miner.py 真正的 build_breadth_history() 測(不再複製一份規則)。

為什麼要另外寫這支(V71.4.8):
  舊的 scripts/test_breadth.py 是在測試檔裡**重寫一份統計規則**再驗自己,
  真正跑的那份 miner.py 程式碼一行都沒被執行到 —— 規則寫錯它抓不到。
  V71.4.8 把那段抽成獨立函式 build_breadth_history() 之後,它變成
  「只讀本地 data/*.json、零 API、零 SQLite」,可以直接餵假資料真的跑一遍。

  這也是把它抽出來的主因:原本它埋在 build_bubble_warning 裡、而 build_bubble_warning
  排在 ONLY_CHIPS 流程的最後面(前面是 ~35 分的分點採礦)。分點那步一被砍,
  廣度歷史就整晚寫不出來 —— 2026-07-29 實測就是這樣(20:00 排程延遲到 22:01 觸發,
  把 21:00 那輪 cancel 在分點中途)。現在改排在最前面,幾秒就寫完。

驗:
  ① 真函式的統計數字正確(漲/跌/平/漲停/跌停/強/弱),且回傳值 = 漲停家數
  ② 同一天重跑 → 覆蓋不重複(跑兩次無害,這是「早跑一次 + 後面再跑一次」的前提)
  ③ 檔數 <500 → 不寫檔(避免資料還沒鋪好記到髒點)
  ④ 非 4 碼純數字的檔(ETF/雜檔)不列入統計
  ⑤ 舊 breadth.json 壞掉 → 不炸,當空的重建
  ⑥ 滾動上限 250 筆
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault('SKIP_GLOBAL', '1')
os.environ.setdefault('ONLY_CHIPS', '0')

import miner  # noqa: E402


def seed(tmp, chgs, extra_files=None, d='2026/07/29'):
    """造 len(chgs) 檔假 K 線(漲跌幅由 chgs 指定),回傳 data 目錄。"""
    dd = Path(tmp) / 'data'
    dd.mkdir(parents=True, exist_ok=True)
    for i, chg in enumerate(chgs):
        sym = str(2000 + i)
        rows = [{'date': '2026/07/28', 'close': 100.0},
                {'date': d, 'close': round(100.0 * (1 + chg / 100), 4)}]
        (dd / f'{sym}.json').write_text(json.dumps(rows), encoding='utf-8')
    for name, content in (extra_files or {}).items():
        (dd / name).write_text(content, encoding='utf-8')
    return dd


def run(dd):
    miner.DATA_DIR = str(dd)
    return miner.build_breadth_history()


def load(dd):
    p = Path(dd) / 'breadth.json'
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else None


# ── ① 真函式統計正確 ────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    # 10 漲停 + 5 跌停 + 200 小漲 + 300 小跌 + 20 平盤(±0.02 在 ±0.05 帶內算平)
    chgs = [9.8] * 10 + [-9.8] * 5 + [1.2] * 200 + [-1.1] * 300 + [0.02] * 20
    dd = seed(tmp, chgs)
    lu = run(dd)
    h = load(dd)['history'][-1]
    assert lu == 10, f'① 回傳值應為漲停家數 10,實際 {lu}'
    assert h['lu'] == 10 and h['ld'] == 5, f"① 漲停/跌停錯:{h['lu']}/{h['ld']}"
    assert h['up'] == 210 and h['dn'] == 305, f"① 漲/跌錯:{h['up']}/{h['dn']}"   # 漲停也算上漲
    assert h['flat'] == 20, f"① 平盤錯:{h['flat']}"
    assert h['st'] == 10 and h['wk'] == 5, f"① 強/弱勢錯:{h['st']}/{h['wk']}"
    assert h['total'] == 535 == h['up'] + h['dn'] + h['flat']
    assert h['d'] == '2026/07/29', f"① 日期錯:{h['d']}"
    print(f"✅ ① 真函式統計正確(漲 {h['up']} / 跌 {h['dn']} / 平 {h['flat']} / "
          f"漲停 {h['lu']} / 跌停 {h['ld']}),回傳漲停家數 {lu}")

# ── ② 同一天重跑 → 覆蓋不重複(「早跑一次+晚跑一次」的正確性前提)──────
with tempfile.TemporaryDirectory() as tmp:
    dd = seed(tmp, [1.0] * 600)
    run(dd); run(dd); run(dd)
    hist = load(dd)['history']
    assert len(hist) == 1, f'② 同一天跑 3 次應只留 1 筆,實際 {len(hist)} 筆'
    print('✅ ② 同一天重跑 3 次 → 只留 1 筆(早跑一次、build_bubble_warning 再跑一次都不會灌歪 ADL)')

# ── ③ 檔數不足不寫 ─────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    dd = seed(tmp, [1.0] * 499)
    run(dd)
    assert load(dd) is None, '③ 只有 499 檔就不該寫入'
    dd2 = seed(tmp, [1.0] * 500)
    run(dd2)
    assert load(dd2) is not None, '③ 剛好 500 檔應該要寫'
    print('✅ ③ 499 檔不寫、500 檔才寫(資料沒鋪好時不記髒點)')

# ── ④ 非 4 碼純數字檔不列入 ─────────────────────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    extra = {
        '0050.json': json.dumps([{'date': 'a', 'close': 100.0}, {'date': 'b', 'close': 200.0}]),
        '^TWII.json': json.dumps([{'date': 'a', 'close': 100.0}, {'date': 'b', 'close': 200.0}]),
        'radar.json': json.dumps({'not': 'a kline'}),
    }
    dd = seed(tmp, [1.0] * 600, extra_files=extra)
    run(dd)
    h = load(dd)['history'][-1]
    assert h['total'] == 600, f"④ ETF/指數/雜檔不該被算進去,實際 total={h['total']}"
    print('✅ ④ 0050 / ^TWII / radar.json 都沒被誤算進廣度(只收 4 碼純數字個股)')

# ── ⑤ 舊檔壞掉照樣重建 ─────────────────────────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    dd = seed(tmp, [1.0] * 600)
    (Path(dd) / 'breadth.json').write_text('{壞掉的 json', encoding='utf-8')
    run(dd)
    assert load(dd) and len(load(dd)['history']) == 1, '⑤ 舊檔壞掉應重建而非炸掉'
    print('✅ ⑤ 舊 breadth.json 壞掉 → 不炸,當空的重建')

# ── ⑥ 滾動 250 筆上限 ──────────────────────────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    dd = seed(tmp, [1.0] * 600)
    old = [{'d': f'2025/{m:02d}/{day:02d}', 'up': 1, 'dn': 1, 'flat': 0,
            'lu': 0, 'ld': 0, 'st': 0, 'wk': 0, 'total': 2}
           for m in range(1, 13) for day in range(1, 26)]        # 300 筆
    (Path(dd) / 'breadth.json').write_text(
        json.dumps({'updated': 'x', 'history': old}), encoding='utf-8')
    run(dd)
    hist = load(dd)['history']
    assert len(hist) == 250, f'⑥ 應裁到 250 筆,實際 {len(hist)}'
    assert hist[-1]['d'] == '2026/07/29', '⑥ 最新一筆應排在最後(排序後裁尾)'
    print('✅ ⑥ 超過 250 筆自動裁掉最舊的,最新一筆仍在尾端')

print('\n🎉 build_breadth_history() 真函式 六項測試全過')

# ══════════════════════════════════════════════════════════════════
# V71.5.5 回算歷史(backfill)—— 使用者明示「要馬上能用,不是等好幾天」
#   data/{sym}.json 本身就有 2~3 年日 K,每個過去交易日的漲跌家數都算得出來。
#   實測 origin/data:可回算 303 個交易日(2025/05/07 ~ 2026/07/29)。
# ══════════════════════════════════════════════════════════════════

def seed_hist(tmp, days, n_stocks=600, pattern=None):
    """造 n_stocks 檔、各 days+1 根 K 線的假資料。pattern(i, day) → 當日漲跌幅%。"""
    dd = Path(tmp) / 'data'
    dd.mkdir(parents=True, exist_ok=True)
    for i in range(n_stocks):
        sym = str(2000 + i)
        rows, px = [], 100.0
        for k in range(days + 1):
            if k:
                px *= (1 + (pattern(i, k) if pattern else 1.0) / 100)
            rows.append({'date': f'2026/01/{k+1:02d}' if k < 30 else f'2026/02/{k-29:02d}',
                         'close': round(px, 4)})
        (dd / f'{sym}.json').write_text(json.dumps(rows), encoding='utf-8')
    return dd


# ⑦ 一次就回算出多天歷史(不是只有今天一筆)
with tempfile.TemporaryDirectory() as tmp:
    dd = seed_hist(tmp, days=12, pattern=lambda i, k: 1.0 if i % 3 else -1.0)
    run(dd)
    h = load(dd)['history']
    assert len(h) == 12, f'⑦ 12 個交易日都該回算出來,實際 {len(h)} 筆'
    assert sum(1 for x in h if x.get('bf')) == 11, '⑦ 除了最新那天,其餘應標記 bf=1(回算)'
    assert not h[-1].get('bf'), '⑦ 最新那天是實算,不該標 bf'
    print(f'✅ ⑦ 一次回算出 {len(h)} 個交易日(11 筆標記為回算 bf=1、最新那筆是實算)')

# ⑧ ADL 立刻算得出來,而且方向正確(2/3 漲、1/3 跌 → 應為正)
with tempfile.TemporaryDirectory() as tmp:
    dd = seed_hist(tmp, days=12, pattern=lambda i, k: 1.0 if i % 3 else -1.0)
    run(dd)
    h = load(dd)['history']
    adl = sum(x['up'] - x['dn'] for x in h)
    assert h[0]['up'] == 400 and h[0]['dn'] == 200, f"⑧ 每日應 400 漲 / 200 跌,實際 {h[0]}"
    assert adl == 12 * 200, f'⑧ ADL 應為 12×200,實際 {adl}'
    print(f'✅ ⑧ 回算完 ADL 立刻可用 = {adl:+,}(每日 漲400/跌200,方向正確)')

# ⑨ 既有的實算資料不可被回算覆蓋(live 優先)
with tempfile.TemporaryDirectory() as tmp:
    dd = seed_hist(tmp, days=6, pattern=lambda i, k: 1.0)
    (Path(dd) / 'breadth.json').write_text(json.dumps({'updated': 'x', 'history': [
        {'d': '2026/01/03', 'up': 999, 'dn': 1, 'flat': 0, 'lu': 0, 'ld': 0, 'st': 0, 'wk': 0, 'total': 1000},
    ]}), encoding='utf-8')
    run(dd)
    h = {x['d']: x for x in load(dd)['history']}
    assert h['2026/01/03']['up'] == 999, '⑨ 既有實算值被回算蓋掉了'
    assert 'bf' not in h['2026/01/03'], '⑨ 既有實算值不該被標成回算'
    print('✅ ⑨ 既有實算(live)那幾天不會被回算覆蓋,只補歷史上缺的日子')

# ⑩ 檔數不足的歷史日子不記(避免早期資料稀疏汙染 ADL)
with tempfile.TemporaryDirectory() as tmp:
    dd = Path(tmp) / 'data'; dd.mkdir(parents=True)
    # 600 檔只有最後 3 天有資料;另外 40 檔有 10 天 → 早期只有 40 檔 <500
    for i in range(600):
        rows = [{'date': f'2026/01/{k:02d}', 'close': 100.0 + k} for k in (8, 9, 10, 11)]
        (dd / f'{2000+i}.json').write_text(json.dumps(rows), encoding='utf-8')
    for i in range(40):
        rows = [{'date': f'2026/01/{k:02d}', 'close': 100.0 + k} for k in range(1, 12)]
        (dd / f'{5000+i}.json').write_text(json.dumps(rows), encoding='utf-8')
    run(dd)
    h = load(dd)['history']
    assert all(x['total'] >= 500 for x in h), f'⑩ 有檔數 <500 的日子被記進去:{[x for x in h if x["total"]<500]}'
    assert len(h) == 3, f'⑩ 只有 3 天檔數夠,實際記了 {len(h)} 天'
    print('✅ ⑩ 早期只有 40 檔的日子自動略過(檔數 <500 不記,不讓稀疏資料汙染 ADL)')

print('\n🎉 回算歷史 四項測試全過(合計 10 項)')

