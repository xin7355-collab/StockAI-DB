#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📸 榜單事後驗證快照(V73.4.1)測試 —— 不打網路。

⛔ 這支要擋住五件事:
  ① 空過:兩個來源都讀不到卻寫出空快照假裝有存(①)
  ② 不冪等:同一天重跑變兩筆(③)
  ③ 存了結論/評分 → 那會變成第二份真相(④)
  ④ **累積型檔案沒接還原/沒推出去** → 每天歸零而且零錯誤訊息(⑥,踩過三次)
  ⑤ 累積不夠就顯示績效數字(⑤)
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = []


def ok(n, c, e=''):
    print(f'{"✅" if c else "❌"} {n}{"" if c else "  " + str(e)[:220]}')
    if not c:
        fails.append(n)


def run(d):
    env = dict(os.environ, DATA_DIR=str(d))
    r = subprocess.run([sys.executable, str(ROOT / 'pick_snapshot.py')],
                       capture_output=True, text=True, env=env)
    return r.returncode, r.stdout + r.stderr


def seed(d, date='2026-08-12', n=3):
    (d / 'playbook_edge.json').write_text(json.dumps({
        'data_date': date,
        'picks': [{'s': f'{2330+i}', 'c': 100 + i, 'k': '📦 箱型突破', 'lb': 1.5,
                   'trig': 105 + i, 'exp': 9.9, 'w': 70} for i in range(n)],
    }, ensure_ascii=False), encoding='utf-8')
    (d / 'today_signals.json').write_text(json.dumps({
        'data_date': date,
        'bull': [{'sym': '1101', 'close': 30.5, 'title': '頭肩底'}],
    }, ensure_ascii=False), encoding='utf-8')


# ① 🚧 空過守門:什麼都沒有 → ⛔ 不可寫檔
with tempfile.TemporaryDirectory() as td:
    d = Path(td)
    rc, out = run(d)
    ok('① 兩個來源都讀不到 → exit 1', rc == 1, f'rc={rc} {out[:150]}')
    ok('①b ⛔ 不可寫出空快照', not (d / 'pick_history.json').exists(), '')

# ②③ 正常寫入 + 冪等
with tempfile.TemporaryDirectory() as td:
    d = Path(td)
    seed(d)
    rc, out = run(d)
    ok('② 有資料 → exit 0 且寫檔', rc == 0 and (d / 'pick_history.json').exists(), out[:200])
    j = json.loads((d / 'pick_history.json').read_text(encoding='utf-8'))
    ok('②b 存了明日清單', len(j['days'][0].get('pb') or []) == 3, j['days'][0])
    ok('②c 存了實測訊號', len(j['days'][0].get('sig') or []) == 1, j['days'][0])
    ok('②d 有存當時收盤(⭐ 事後算報酬的基準)',
       all('c' in x for x in j['days'][0]['pb']), j['days'][0]['pb'][:1])
    run(d)
    run(d)
    j2 = json.loads((d / 'pick_history.json').read_text(encoding='utf-8'))
    ok('③ ⭐ 冪等:同一天跑三次仍是 1 天', j2['n_days'] == 1, f"n_days={j2['n_days']}")
    # 換一天 → 應該累加
    seed(d, '2026-08-13')
    run(d)
    j3 = json.loads((d / 'pick_history.json').read_text(encoding='utf-8'))
    ok('③b 換一天 → 累加成 2 天', j3['n_days'] == 2, f"n_days={j3['n_days']}")
    ok('③c 日期要排序', [x['d'] for x in j3['days']] == sorted(x['d'] for x in j3['days']), '')

    # ④ ⛔ 只存事實,不存結論/評分
    keys = set()
    for day in j3['days']:
        for x in day.get('pb') or []:
            keys |= set(x)
    banned = {'exp', 'w', 'verdict', 'score', 'grade', 'advice', 'rank'}
    ok('④ ⛔ 不可存結論/評分(那會變成第二份真相)',
       not (keys & banned), f'存了不該存的:{sorted(keys & banned)}')
    ok('④b 該存的事實都在', {'s', 'c', 'k'} <= keys, f'keys={sorted(keys)}')

# ⑤ 累積不足要明說(⛔ 不可在樣本不夠時給績效)
with tempfile.TemporaryDirectory() as td:
    d = Path(td)
    seed(d)
    _, out = run(d)
    ok('⑤ 累積不足要印「還在累積 N/20」', '還在累積' in out, out[:200])

# ⑥ ⭐⭐ 累積型檔案的佈線(踩過三次:存了但沒推 = 每天歸零,零錯誤訊息)
wf = (ROOT / '.github/workflows/playbook_scan.yml').read_text(encoding='utf-8')
ok('⑥ workflow 有呼叫 pick_snapshot.py', 'python3 pick_snapshot.py' in wf, '')
ok('⑥b ⭐ 快照有被 cp 到 /tmp(切分支前保住)', '/tmp/pick_history.json' in wf, '')
ok('⑥c ⭐ 快照有被 git add(⛔ 漏這步 = 存了推不出去)', 'pick_history.json' in wf.split('git add')[1][:200]
   if 'git add' in wf else False, '')
ok('⑥d ⭐ commit 有帶上快照路徑', 'data/pick_history.json' in wf.split('git commit')[1][:200]
   if 'git commit' in wf else False, '')
ok('⑥e 有還原檢查(印出既有幾天)', 'n_days' in wf, '')

print('\n' + ('❌ %d 條失敗' % len(fails) if fails else '✅ PICKSNAP_PASS(全部通過)'))
sys.exit(1 if fails else 0)
