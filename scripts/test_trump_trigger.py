#!/usr/bin/env python3
"""⏰ 川普發文採礦(trump_posts.yml)什麼時候會被帶起來 —— 2026-11-03 新增。

真因(11/03 早上排程驗證):
  開盤前總經採礦跑了兩輪(台北 04:11 / 05:00),但兩輪都是「跟在 Telegram / 當沖熱度排程後面」
  (event = workflow_run)→ 舊守門只放行 host 的 schedule / repository_dispatch → 兩輪都被 skip;
  worker 08:00 因為總經已經是美股收盤後的資料而不叫醒、盤前新聞排程拖到 11:00 才進來
  → 開盤前沒有任何一輪自動抓川普發文。

這支把 job 的 `if:` 從 yaml 讀出來,換成 Python 運算式**實際算**每一種情境(⛔ 只比字串):
  ✅ host 排程 / worker 叫醒 / 總經採礦跟車那輪(成功或失敗)/ 自己的 cron / 手動
  ⛔ host 被 push / 手動帶起來 / 總經採礦那輪整個 skipped
⭐ 決定性對照:同一組情境套舊守門 → 「總經採礦跟車成功」那一格必須是 ⛔(重現 11/03 被 skip)。
INJECT=old:把 yaml 的守門換回舊的 → 必紅。
"""
import os
import re
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF = os.path.join(ROOT, '.github', 'workflows')
fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:240]}'))
    if not cond:
        fails.append(name)


OLD_IF = ("github.event_name != 'workflow_run' || "
          "github.event.workflow_run.event == 'schedule' || "
          "github.event.workflow_run.event == 'repository_dispatch'")


def load(name):
    with open(os.path.join(WF, name), encoding='utf-8') as f:
        return yaml.safe_load(f) or {}


def on_of(d):
    o = d.get(True, d.get('on'))
    return o if isinstance(o, dict) else {}


def to_py(expr):
    """GitHub 運算式 → Python(只認這支會用到的:==、!=、&&、||、括號、單引號字串)。"""
    e = expr.strip()
    if e.startswith('${{') and e.endswith('}}'):
        e = e[3:-2]
    names = {
        'github.event.workflow_run.conclusion': 'wr_conc',
        'github.event.workflow_run.event': 'wr_event',
        'github.event_name': 'ev',
    }
    for k in sorted(names, key=len, reverse=True):
        e = e.replace(k, names[k])
    e = e.replace('&&', ' and ').replace('||', ' or ')
    left = re.sub(r"'[^']*'", '', e)
    bad = set(re.findall(r'[A-Za-z_][\w.]*', left)) - {'wr_conc', 'wr_event', 'ev', 'and', 'or', 'not'}
    if bad:
        raise ValueError(f'運算式裡有沒處理到的名字:{sorted(bad)}')
    return e


def run_if(expr, ev, wr_event=None, wr_conc=None):
    return bool(eval(to_py(expr), {'__builtins__': {}},           # noqa: S307 —— 上面已白名單
                     {'ev': ev, 'wr_event': wr_event, 'wr_conc': wr_conc}))


# 情境:(說明, 事件, host 的 event, host 的 conclusion, 應該跑嗎)
CASES = [
    ('host 排程那輪(盤前新聞 / 總經採礦自己的 cron)', 'workflow_run', 'schedule', 'success', True),
    ('host 排程那輪失敗了也跟(採礦跟 host 產物無關)', 'workflow_run', 'schedule', 'failure', True),
    ('worker 08:00 叫醒總經採礦那輪', 'workflow_run', 'repository_dispatch', 'success', True),
    ('⭐ 總經採礦跟在 Telegram / 當沖熱度排程後面那輪(11/03 被 skip 的)', 'workflow_run', 'workflow_run', 'success', True),
    ('總經採礦跟車那輪自己壞了也跟(不該連累川普)', 'workflow_run', 'workflow_run', 'failure', True),
    ('總經採礦那輪整個 skipped(它的 host 是 push / 手動)', 'workflow_run', 'workflow_run', 'skipped', False),
    ('host 被手動派(workflow_dispatch)', 'workflow_run', 'workflow_dispatch', 'success', False),
    ('host 被 push 帶起來', 'workflow_run', 'push', 'success', False),
    ('自己的 cron 備援', 'schedule', None, None, True),
    ('自己被手動派', 'workflow_dispatch', None, None, True),
]

d = load('trump_posts.yml')
job = (d.get('jobs') or {}).get('posts') or {}
cur_if = str(job.get('if', ''))
if os.environ.get('INJECT') == 'old':
    cur_if = OLD_IF
    print('💉 INJECT=old:守門換回舊的(下面那一格必須紅)')

ok('⓪ 讀得到 trump_posts 的 job 守門', bool(cur_if.strip()), job.keys())
try:
    to_py(cur_if)
    parsed = True
except Exception as e:                                       # noqa: BLE001
    parsed = False
    ok('⓪b 守門運算式看得懂', False, e)

if parsed:
    for desc, ev, we, wc, want in CASES:
        got = run_if(cur_if, ev, we, wc)
        ok(f'① {desc} → {"跑" if want else "不跑"}', got == want, f'實際={"跑" if got else "不跑"}')

# ⭐ 決定性對照:舊守門在同一格一定是「不跑」(= 11/03 實際發生的事);其餘格子新舊一樣
old_res = {c[0]: run_if(OLD_IF, c[1], c[2], c[3]) for c in CASES}
key = CASES[3][0]
ok('② 決定性對照:舊守門遇到「總經採礦跟車那輪」= 不跑(重現 11/03 被 skip)', old_res[key] is False, old_res[key])
if parsed:
    diff = [c[0] for c in CASES if run_if(cur_if, c[1], c[2], c[3]) != old_res[c[0]]]
    ok('②b 新守門只多放行「總經採礦跟車」那兩格(成功 / 失敗),其他跟舊的一樣',
       sorted(diff) == sorted([CASES[3][0], CASES[4][0]]), diff)

# ③ host 名字一字不差(差一字永遠不觸發且零訊息)+ 盤前新聞沒有 workflow_run(新放行那條只對得到總經採礦)
hosts = ((on_of(d).get('workflow_run') or {}).get('workflows') or [])
names = {}
for f in os.listdir(WF):
    if f.endswith('.yml'):
        try:
            nm = (load(f) or {}).get('name')
        except Exception:                                    # noqa: BLE001
            continue
        if nm:
            names[nm] = f
ok('③ 有掛兩支 host', len(hosts) == 2, hosts)
for h in hosts:
    ok(f'③ host「{h}」名字對得上真的 workflow', h in names, sorted(names)[:3])
macro_f = names.get('🌍 總經採礦定時同步 (macro 4hr cron)')
news_f = names.get('🗞️ 盤前新聞晨採 (news_premarket)')
ok('③b host 是總經採礦 + 盤前新聞', macro_f == 'macro_cron.yml' and news_f == 'news_premarket.yml', (macro_f, news_f))
if news_f:
    ok('③c 盤前新聞沒有 workflow_run 觸發(新放行那條只會對到總經採礦)',
       'workflow_run' not in on_of(load(news_f)), list(on_of(load(news_f)).keys()))
if macro_f:
    mon = on_of(load(macro_f))
    mif = str((list((load(macro_f).get('jobs') or {}).values()) or [{}])[0].get('if', ''))
    ok('③d 總經採礦自己只跟 host 的排程(所以它跟車那輪 = 排程鏈;host 是 push 時整輪 skipped)',
       "workflow_run.event == 'schedule'" in mif and "github.event_name != 'workflow_run'" in mif, mif[:120])
    ok('③e 總經採礦還有 worker 叫醒那條(repository_dispatch macro-cron)',
       'macro-cron' in str((mon.get('repository_dispatch') or {}).get('types')), mon.get('repository_dispatch'))

# ④ cron 備援還在、自己的鎖(⛔ 共用 gh-pages-push)
ok('④ cron 備援一行沒刪', bool(on_of(d).get('schedule')), on_of(d).keys())
ok('④b concurrency 是自己的 trump-posts(⛔ 進共用部署鎖)',
   (d.get('concurrency') or {}).get('group') == 'trump-posts', d.get('concurrency'))

print()
print(f'❌ TRUMP_TRIGGER_FAIL({len(fails)}):{fails[:5]}' if fails else '✅ TRUMP_TRIGGER_PASS(全部通過)')
sys.exit(1 if fails else 0)
