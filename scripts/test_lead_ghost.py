#!/usr/bin/env python3
"""🎑 V77.9.5 領頭羊快照 ⛔ 不可把「被假日幽靈 K 墊歪的 screener」當實跑存下來

背景:09-25 中秋、09-28 教師節,data 分支的 K 線還留著假 K(收盤 = 前一天),而 screener.json
是拿整條 K 線算的 → 近 10 日漲幅 / 20 日均額被墊歪(實測 09-24 前 5 名錯 3 檔)。
`pick_snapshot.py --leader` 對實跑寫過的日子**永遠不覆蓋** → 存進去就永遠錯。

  ① `_ghost_ahead`:K 線跑到加權最新日之後 → 回那些日子;沒有 → ''
  ② 真資料(origin/data)+ 注入一根幽靈 K → 最後一個交易日必須是 K 線回補(bf:1),⛔ 不是實跑
  ③ ⭐ 決定性對照:把守門拿掉(_ghost_ahead 回 '')→ 同一份資料會被當實跑存(沒有 bf)
  ④ 每一天的 lead 都在加權日曆上
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
bad = 0


def ok(name, cond, extra=''):
    global bad
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else '  ' + str(extra)[:200]))
    if not cond:
        bad += 1


import pick_snapshot as PS  # noqa: E402


def _rows(p):
    d = json.loads(p.read_text(encoding='utf-8'))
    return d if isinstance(d, list) else d.get('data', [])


# ① 合成
with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    PS.DATA = t
    (t / '2330.json').write_text(json.dumps([{'date': '2026/09/23', 'close': 1}, {'date': '2026/09/24', 'close': 1}]))
    ok('① K 線沒有跑到加權前面 → 空字串', PS._ghost_ahead(['2026-09-23', '2026-09-24']) == '')
    (t / '2330.json').write_text(json.dumps([{'date': '2026/09/24', 'close': 1}, {'date': '2026/09/25', 'close': 1}]))
    ok('①b 多一根 09-25 → 回 2026-09-25', PS._ghost_ahead(['2026-09-23', '2026-09-24']) == '2026-09-25')
    ok('①c 沒有加權日曆 → 空字串(⛔ 不猜)', PS._ghost_ahead([]) == '')

# ②③④ 真資料
tmp = Path(tempfile.mkdtemp())
try:
    r = subprocess.run(f'git -C "{ROOT}" archive origin/data data | tar -x -C "{tmp}"', shell=True, capture_output=True)
    D = tmp / 'data'
    if r.returncode or not (D / 'screener.json').exists() or not (D / '^TWII.json').exists():
        print('❌ 拿不到 origin/data(先 git fetch origin data)—— ⛔ 不跑假測試')
        sys.exit(1)
    tw = sorted({PS._dnorm(x.get('date')) for x in _rows(D / '^TWII.json')})
    last = tw[-1]
    ghost = '2099-01-01'
    for sym in PS.GHOST_PROBE:
        p = D / f'{sym}.json'
        if not p.exists():
            continue
        rows = [x for x in _rows(p) if PS._dnorm(x.get('date')) <= last]   # 先清掉本來就在的
        rows.append(dict(rows[-1], date=ghost.replace('-', '/')))
        p.write_text(json.dumps(rows))
    base = D / 'pick_history.json'
    h = json.loads(base.read_text(encoding='utf-8')) if base.exists() else {'days': []}
    for day in h.get('days', []):
        day.pop('lead', None)
    clean = json.dumps(h)

    def run(guard=True):
        base.write_text(clean)
        PS.DATA, PS.OUT = D, base
        keep = PS._ghost_ahead
        if not guard:
            PS._ghost_ahead = lambda tdays: ''
        try:
            rc = PS.leader_main()
        finally:
            PS._ghost_ahead = keep
        return rc, {x['d']: x['lead'] for x in json.loads(base.read_text())['days'] if x.get('lead')}

    scr_d = PS._dnorm(json.loads((D / 'screener.json').read_text()).get('data_date'))
    ok('②0 🚧 測資:screener 的日子在加權日曆上', scr_d in tw, f'{scr_d} / {last}')
    rc, L = run(True)
    ok('② 有幽靈 K → 那一天是 K 線回補(bf:1),⛔ 不是實跑', rc == 0 and scr_d in L and L[scr_d].get('bf') == 1,
       f'rc={rc} {scr_d}: {L.get(scr_d, {}).get("bf")}')
    ok('④ 每一天的 lead 都在加權日曆上', all(d in set(tw) for d in L), sorted(L))
    rc2, L2 = run(False)
    ok('③ ⭐ 決定性對照:拿掉守門 → 同一天被當實跑存(沒有 bf)', rc2 == 0 and scr_d in L2 and not L2[scr_d].get('bf'),
       f'{L2.get(scr_d, {}).get("bf")}')
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print('\n❌ %d 條沒過' % bad if bad else '\n✅ LEAD_GHOST_PASS')
sys.exit(1 if bad else 0)
