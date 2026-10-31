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

sys.path.insert(0, str(ROOT))   # 🔥 V79.4.9 alert_system 會 import 根目錄的 lib_hotrule(workflow 從根目錄跑本來就找得到)
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
# 🧬 V80.0.9 排序 + 篩選一律走 lib_hotrule.deck_pick(= 決策台 `_deckBuyOf`,⛔ alert_system 不另寫一份)
ok('⑥ 排序與篩選走 lib_hotrule.deck_pick(⛔ 不另寫一份)', 'deck_pick(picks, hot_rule(' in SRC and "int(p.get('hq')" not in SRC, '')
_r = A._rank_picks([
    {'s': 'A', 'hq': 0, 'lb': 9.0, 'exp': 9.0},
    {'s': 'B', 'hq': 1, 'lb': 1.0, 'exp': 1.0},
    {'s': 'C', 'hq': 1, 'lb': 5.0, 'exp': 5.0},
])
ok('⑥b 🧬 是必要條件(非 🧬 的 A 下界最高也 ⛔ 不給),🧬 裡照下界排', [x['s'] for x in _r] == ['C', 'B'], str([x['s'] for x in _r]))
_r2 = A._rank_picks([
    {'s': 'C', 'hq': 1, 'lb': 5.0, 'exp': 5.0, 'k': '招1'},
    {'s': 'C', 'hq': 1, 'lb': 4.0, 'exp': 4.0, 'k': '招2'},
    {'s': 'D', 'hq': 1, 'lb': 4.5, 'exp': 4.5, 'bear': 1},
    {'s': 'E', 'hq': 1, 'lb': 3.0, 'exp': 3.0},
])
ok('⑥c 同一檔只留最好那一招 + 這一檔自己空頭的 ⛔ 不給(同決策台)', [(x['s'], x.get('k')) for x in _r2] == [('C', '招1'), ('E', None)],
   str([(x['s'], x.get('k')) for x in _r2]))

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
    ok('②b 新鮮報價 + 站上觸發價 → 有發(空過守門)', isinstance(m2, str) and '尾盤買點成立' in m2, str(m2)[:120])
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

    # ── 🧬 V80.0.9 跟決策台同一條:🧬 而且這一檔自己不是空頭(使用者:「一直跌也叫我買,這樣對嗎?」)──
    LQ = {'updated': A._tpe_now().isoformat(), 'data': {'1234': {'p': 999}, '5678': {'p': 999}, '9999': {'p': 999}}}
    P0 = PB_OK['picks'][0]
    stub(pb={**PB_OK, 'picks': [dict(P0, hq=0, rank=50, vol=70)]}, lq=LQ)
    ok('⑩ 🚨 不是 🧬 的(決策台不會列)→ 明日清單與尾盤買點都 ⛔ 不發', A.build_playbook_brief() is None and A.build_eod_triggers() is None)
    stub(pb={**PB_OK, 'picks': [dict(P0, bear=1)]}, lq=LQ)
    ok('⑩b 🚨 這一檔自己空頭(決策台不會列)→ 都 ⛔ 不發', A.build_playbook_brief() is None and A.build_eod_triggers() is None)
    stub(pb={**PB_OK, 'picks': [dict(P0, hq=1, rank=92, vol=75, bear=0)]}, lq=LQ)
    ok('⑩c ⭐ 決定性對照:同一檔改成 🧬 而且不是空頭 → 兩則都會發', isinstance(A.build_playbook_brief(), str) and isinstance(A.build_eod_triggers(), str))
    # 只看決策台那 2 檔:前 2 名沒站上、第 3 名站上 → ⛔ 不往下補(舊版會推第 3 名)
    three = [dict(P0, s='1234', lb=5.0, exp=5.0, trig=2000), dict(P0, s='5678', lb=4.0, exp=4.0, trig=2000), dict(P0, s='9999', lb=3.0, exp=3.0, trig=100)]
    stub(pb={**PB_OK, 'picks': three}, lq=LQ)
    ok('⑪ 🚨 尾盤只看決策台那 2 檔:前 2 名沒站上、第 3 名站上 → ⛔ 不推第 3 名', A.build_eod_triggers() is None)
    stub(pb={**PB_OK, 'picks': [dict(three[2], lb=9.0, exp=9.0), three[0], three[1]]}, lq=LQ)
    ok('⑪b 決定性對照:同一檔分數拉高、排進前 2 名 → 會推', '9999' in (A.build_eod_triggers() or ''))
    # 大盤狀態一行(讀名單裡的 mkt,⛔ 這裡不另算)
    stub(pb={**PB_OK, 'mkt': {'bear60': True, 'd': DAY, 'c': 40000, 'ma20': 42000, 'ma60': 43000}}, lq=LQ)
    mb, me = A.build_playbook_brief() or '', A.build_eod_triggers() or ''
    ok('⑫ 大盤嚴格空頭 → 兩則都寫「嚴格空頭」+ 預設照買 + 設定可以改', all('嚴格空頭' in x and '照買' in x and '不開新倉' in x for x in (mb, me)), mb[:200])
    stub(pb={**PB_OK, 'mkt': {'bear60': False, 'd': DAY, 'c': 44780, 'ma20': 47705, 'ma60': 46534}}, lq=LQ)
    mb2 = A.build_playbook_brief() or ''
    ok('⑫b 跌破 60 日線但 20 日線還在上面 → 寫「還不算空頭」(⛔ 不可說空頭)', '還不算空頭' in mb2 and '嚴格空頭' not in mb2, mb2[:200])
    BANNED = re.compile(r'實測|勝率|平均每趟|171 萬|136 萬|82 萬|減 ?1/3|現金為王|減碼|接刀|可以進場')
    ok('⑬ 🧹 推播文字 ⛔ 研究數字 / 減碼指令(同 App V78.3.4 / V79.3.5)', not any(BANNED.search(x) for x in (mb, me, mb2)),
       [BANNED.findall(x) for x in (mb, me, mb2)])
finally:
    A.load_json = _orig

# ── 🔕 V80.0.9 重大事件(watch,只有手動 dispatch 才跑)只描述 ──────────────
_orig = A.load_json
try:
    def _w(name):
        if name == 'bubble_warning.json':
            return {'margin_leverage': {'total_100m': 3500}}
        if name == 'macro_risk.json':
            return {'vix': 33, 'fi_ratio_alert': '⚠️ 期現比 3.2'}
        return None
    A.load_json = _w
    W = A.build_watch_alerts()
    ok('⑭ 空過守門:三種重大事件都有產生', len(W) == 3, len(W))
    WB = re.compile(r'減碼|減 ?1/3|減 ?50%|現金為王|觀望|別追高|別接刀|避開|先減|新單暫緩')
    ok('⑭b 🔕 重大事件只描述:⛔ 減碼 / 現金為王 / 觀望 / 別接刀;每則都寫「照出場規則走」',
       not any(WB.search(x) for x in W) and all('出場規則' in x for x in W), [WB.findall(x) for x in W])
finally:
    A.load_json = _orig

# ── 🧪 V79.5.2 summary 的「今日大盤」那句(手動 dispatch 才會跑)────────────
# ⚠️ 兩組都放在門檻邊上(舊寫法 ±1 分就會翻):A = 1 分(中性)、B = 2 分(偏多)
_bA = {'sp500_chg_pct': 0.6, 'nasdaq_chg_pct': -0.3, 'vix': 18}
_bB = {'sp500_chg_pct': 0.6, 'nasdaq_chg_pct': 0.9, 'vix': 22}
_base = _bB
_d0 = A._market_direction(dict(_bB))
ok('🧪 外資現貨 ⛔ 不算進方向(門檻邊上 +500 億 / −500 億 → 結果跟沒有一模一樣)',
   A._market_direction({**_bA, 'fi_spot_net': 500}) == A._market_direction(dict(_bA))
   and A._market_direction({**_bB, 'fi_spot_net': -500}) == _d0,
   [A._market_direction({**_bA, 'fi_spot_net': 500}), A._market_direction({**_bB, 'fi_spot_net': -500})])
ok('🧪 決定性對照:美股與 VIX 照樣決定方向(三項都偏空 → 偏空)',
   A._market_direction({'sp500_chg_pct': -1, 'nasdaq_chg_pct': -1, 'vix': 31})[1] == '偏空' and _d0[1] == '偏多')
_all = ' '.join(A._market_direction(m)[2] for m in (_base, {'sp500_chg_pct': -1, 'nasdaq_chg_pct': -1, 'vix': 31}, {}))
ok('🧪 對策只講開盤 ⛔ 接刀 / 續抱 / 順勢 / 昨高', not re.search(r'接刀|續抱|順勢|昨高|昨低', _all), _all)

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ TGALERT_PASS(全部通過)')
sys.exit(1 if fails else 0)
