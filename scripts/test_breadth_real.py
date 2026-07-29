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
