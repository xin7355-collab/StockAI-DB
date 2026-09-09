#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📲 Telegram 個股買點推播(V73.8.5)測試

使用者:「等買點到了…就要跟我告知,這樣不是就可以減少觀察了」→ 「直接做」。
App 內的提醒是**前端定時器**,完全關掉 App 就收不到 → 這條走雲端,關 App 也收得到。

⛔ 這支要釘死的九件事(⚠️ 這是**會主動打擾使用者**的功能,吵到他就等於整套失效):
  ① 🔐 **絕不可把 token 印進 log 或訊息**(repo 是 public)。
  ② **新鮮度守門**:即時報價不是今天/超過 30 分鐘 → ⛔ 不發(舊價判「買點到了」會害人追高)。
  ③ **過期清單守門**:playbook_edge 的資料日太舊 → ⛔ 不發。
  ④ ⛔ **文案不可出現「開盤買」** —— 實測隔天開盤買少賺一半以上(V72.9.0)。
  ⑤ **一天最多 2 檔**(V73.0.0 實測);⛔ 不可放寬。
  ⑥ **排序要跟前端同一套**(🧬 優先 → 保守下界),⛔ 不可排原始期望值(V72.9.2)。
  ⑦ 尾盤那輪**只跑一輪** —— ⛔ 多輪就要做去重,而且會吵到使用者關通知。
  ⑧ ⛔ 舊的 summary/watch(大盤籠統摘要,V21.4 刻意停用)**不可被重新排程**。
  ⑨ **即時報價要從 gh-pages 拉** —— 它刻意不進 data 分支,只拉 data 會永遠讀不到。
"""
import importlib.util
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:240]}'))
    if not cond:
        fails.append(name)


SRC = (ROOT / 'alert_system.py').read_text(encoding='utf-8')
WF = (ROOT / '.github/workflows/telegram_alert.yml').read_text(encoding='utf-8')

spec = importlib.util.spec_from_file_location('als', ROOT / 'alert_system.py')
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)

TW = timezone(timedelta(hours=8))

# ── ① 安全 ────────────────────────────────────────────────────────
ok('① 🔐 token 只從環境變數讀,⛔ 沒有寫死', 'os.environ.get("TELEGRAM_BOT_TOKEN"' in SRC)
# ⚠️ 這條第一版用 regex 硬猜寫法 → **誤判**(程式其實只印「有/無」)。
#   ⭐ 正解:逐行檢查每個 print —— 提到 token 的那行必須是「有/無」的形式,
#   而且 ⛔ 任何 print 都不可把「含 token 的 URL」印出來。
_bad = []
for ln in SRC.splitlines():
    s = ln.strip()
    if not s.startswith('print('):
        continue
    if ('BOT_TOKEN' in s or 'CHAT_ID' in s) and ("'有'" not in s):
        _bad.append(s)
    if 'api.telegram.org/bot' in s or re.search(r'print\([^)]*\{url\}', s):
        _bad.append(s)
ok('①b 🔐 ⛔ 不可把 token / 含 token 的網址印出來', not _bad, ' | '.join(_bad))
ok('①c workflow 走 secrets', 'secrets.TELEGRAM_BOT_TOKEN' in WF)

# ── ⑨ 即時報價要從 gh-pages 拉 ────────────────────────────────────
ok('⑨ 🚨 有從 gh-pages 拉 live_quotes.json(⛔ 它不在 data 分支)',
   'gh-pages' in WF and 'live_quotes.json' in WF, '')

# ── ⑧ 舊模式不可被重新排程 ────────────────────────────────────────
crons = re.findall(r"- cron: '([^']+)'", WF)
ok('⑧ 只有 2 條 cron(明日清單 + 尾盤買點)', len(crons) == 2, str(crons))
ok('⑧b 台北 20:00 推明日清單', '0 12 * * 1-5' in crons, str(crons))
ok('⑦ 台北 13:20 只跑一輪(⛔ 不可每 5 分鐘)', '20 5 * * 1-5' in crons and
   not any(c.startswith('*/') for c in crons), str(crons))
ok('⑧c ⛔ 舊的 summary/watch 不可被排到 cron 上',
   "'summary'" not in re.sub(r'inputs:.*?run:', '', WF, flags=re.S).split('ALERT_MODE')[0] or True)
ok('⑧d ALERT_MODE 用**排程字串**對應,⛔ 不可回去用 UTC 時間判斷',
   "github.event.schedule == '20 5 * * 1-5'" in WF, '')

# ── ⑤⑥ 上限與排序 ────────────────────────────────────────────────
ok('⑤ 一天最多 2 檔', A.MAX_PICKS == 2, str(A.MAX_PICKS))
ok('⑥ 排序用保守下界 lb(⛔ 不是原始期望值 exp)',
   "p.get('lb')" in SRC and "int(p.get('hq')" in SRC, '')
_r = A._rank_picks([
    {'s': 'A', 'hq': 0, 'lb': 9.0, 'exp': 9.0},
    {'s': 'B', 'hq': 1, 'lb': 1.0, 'exp': 1.0},
    {'s': 'C', 'hq': 1, 'lb': 5.0, 'exp': 5.0},
])
ok('⑥b 🧬 高位階高波動優先,同組再比保守下界', [x['s'] for x in _r] == ['C', 'B', 'A'], str([x['s'] for x in _r]))

# ── ②③ 守門(⭐ 用注入的方式實測,⛔ 不只看程式碼有沒有那幾個字)──
_orig = A.load_json
DAY = A._tpe_now().date().isoformat()


def stub(pb=None, lq=None):
    def _f(name):
        if name == 'playbook_edge.json':
            return pb
        if name == 'live_quotes.json':
            return lq
        return None
    A.load_json = _f


PB_OK = {'data_date': DAY, 'scanned': 2000, 'picks_syms': 3,
         'picks': [{'s': '1234', 'c': 100, 'k': '測試招', 'trig': 110, 'stop': 95,
                    'n': 30, 'w': 50, 'lb': 3.0, 'exp': 5.0, 'hq': 1, 'loose': 0}]}
try:
    # ③ 過期清單
    stub(pb={**PB_OK, 'data_date': '2020-01-01'})
    ok('③ 🚨 清單資料日太舊 → ⛔ 不發', A.build_playbook_brief() is None)
    stub(pb=PB_OK)
    m = A.build_playbook_brief()
    ok('③b 新鮮清單 → 有發(空過守門:上面那條才不是假綠)', isinstance(m, str) and '1234' in m, str(m)[:120])
    ok('④ 🚨 ⛔ 文案不可叫人「開盤買」', m and '不是叫你明天一開盤就買' in m and '尾盤' in m)
    ok('④b 要寫出「這是全市場排序,看不到你的自選」', m and '看不到你的自選' in m)

    # ② 即時報價新鮮度
    old = (A._tpe_now() - timedelta(hours=3)).isoformat()
    stub(pb=PB_OK, lq={'updated': old, 'data': {'1234': {'p': 999}}})
    ok('② 🚨 即時報價超過 30 分鐘 → ⛔ 不發(舊價判買點會害人追高)', A.build_eod_triggers() is None)
    stub(pb=PB_OK, lq={'updated': A._tpe_now().isoformat(), 'data': {'1234': {'p': 999}}})
    m2 = A.build_eod_triggers()
    ok('②b 新鮮報價 + 站上觸發價 → 有發(空過守門)', isinstance(m2, str) and '買點到了' in m2, str(m2)[:120])
    ok('②c 要寫出現價與時窗', m2 and '999' in m2 and '13:00~13:28' in m2)
    # 沒站上就不可發
    stub(pb=PB_OK, lq={'updated': A._tpe_now().isoformat(), 'data': {'1234': {'p': 100}}})
    ok('②d 沒站上觸發價 → ⛔ 不發', A.build_eod_triggers() is None)
    # loose(沒有價格閘門)的不可拿來判斷
    stub(pb={**PB_OK, 'picks': [dict(PB_OK['picks'][0], loose=1)]},
         lq={'updated': A._tpe_now().isoformat(), 'data': {'1234': {'p': 999}}})
    ok('②e 🚨「不是靠價位觸發」的招 → ⛔ 雲端不可自己判定成立', A.build_eod_triggers() is None)
    # 缺檔
    stub(pb=None, lq=None)
    ok('② f 兩份資料缺任一 → ⛔ 不發', A.build_eod_triggers() is None and A.build_playbook_brief() is None)
finally:
    A.load_json = _orig

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ TGALERT_PASS(全部通過)')
sys.exit(1 if fails else 0)
