#!/usr/bin/env python3
"""📅 V75.2.0 排程配額:餓死的採礦改「跟車」(`workflow_run`),⛔ 不再多開 cron

🚨 實測(2026-09-09,`actions_list` 近 9 天全 repo 的 schedule run):
   總共只有 **100 筆**進得來,而所有 cron 加起來要求約 **250 筆** → 六成被丟掉,
   而且被丟掉的是**固定那幾支**:`macro_cron` / `news_express` / `rotation_probe` /
   `stock_futures` / `insider_cron` **五支全部 0 筆**(不是隨機掉)。

⛔ **CLAUDE.md 舊寫的「每天 1~3 次在這個 repo 100% 可靠」被反例推翻**:
   `insider_cron` 一天只要 1 次 → **0 筆**;`fund_sweep` 同樣一天 1 次 → 正常跑。
   ⭐ 所以判準⛔ 不是「頻率低就安全」,而是「**這一支實測進不進得來**」。

⭐ 修法:掛 `workflow_run`(⛔ 不是 schedule → 不吃排程配額),
   跟在**實測跑得到**的 host 後面。這個做法在本 repo 已經有前例並且**驗證過**:
   `playbook_scan` ← `daily_miner`,實測 **66 筆** workflow_run 觸發的 run。

⛔ 釘死的五件事:
  ① 五支餓死的都要有 `workflow_run`,而且 host 名字要跟 host 檔的 `name:` **完全一致**
     (⛔ 差一個字 = 永遠不會觸發,而且**完全沒有錯誤訊息**)
  ② host 必須是「實測跑得到」的那幾支(⛔ 不可掛在另一支同樣餓死的上面)
  ③ 原本的 cron ⛔ 一行都不刪(配額鬆了它自己會跑;`workflow_run` 只是多一條路)
  ④ job 要有守門:只跟 host 的**排程**那一輪(⛔ 否則手動 dispatch host 會把它們全帶跑)
  ⑤ 🚨 `stock_futures` 的 host **必須落在夜盤時段** —— 白天跑會把日盤資料寫成「夜盤」
"""
import glob
import sys

import yaml

fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:220]}'))
    if not cond:
        fails.append(name)


WF = {}
for f in glob.glob('.github/workflows/*.yml'):
    try:
        WF[f] = yaml.safe_load(open(f, encoding='utf-8')) or {}
    except Exception as e:                                   # noqa: BLE001
        fails.append(f'{f} 解析失敗:{e}')

NAMES = {d.get('name'): f for f, d in WF.items() if d.get('name')}


def on_of(d):
    o = d.get(True, d.get('on'))
    return o if isinstance(o, dict) else {}


# 實測「排程進得來」的 host(2026-09-09 近 9 天;⚠️ 之後要重新量再改這份)
GOOD_HOSTS = {
    '🌙 夜間全市場基本面補齊 (fund_sweep)', '📲 Telegram 警報系統',
    '🔥 夜間情報採礦 (theme_news)', '⚡ 當沖熱度採礦 (daytrade_probe)',
    '🤖 每日籌碼採礦機 (平行宇宙版)', '📸 全市場即時快照 (Shioaji)',
    '🗞️ 盤前新聞晨採 (news_premarket)', '🎯 明日作戰清單 (playbook_scan)',
}
STARVED = ['insider_cron.yml', 'rotation_probe.yml', 'macro_cron.yml',
           'news_express.yml', 'stock_futures.yml']

for base in STARVED:
    f = f'.github/workflows/{base}'
    d = WF.get(f)
    if not d:
        ok(f'① {base} 存在', False, '找不到這個檔')
        continue
    on = on_of(d)
    wr = on.get('workflow_run') or {}
    hosts = wr.get('workflows') or []
    ok(f'① {base} 有掛 workflow_run', bool(hosts), on.keys())
    for h in hosts:
        ok(f'① {base} ← 「{h}」名字對得上真的 workflow(⛔ 差一字就永遠不觸發)',
           h in NAMES, sorted(NAMES)[:3])
        ok(f'② {base} ← 「{h}」是實測跑得到的 host(⛔ 不可掛在另一支餓死的上面)',
           h in GOOD_HOSTS, h)
    ok(f'③ {base} 原本的 cron ⛔ 不可被刪掉(配額鬆了它自己會跑)',
       bool(on.get('schedule')), on.keys())
    job = list((d.get('jobs') or {}).values())
    cond = str(job[0].get('if', '')) if job else ''
    ok(f'④ {base} job 要守門:只跟 host 的排程那一輪',
       "workflow_run.event == 'schedule'" in cond and "github.event_name != 'workflow_run'" in cond,
       cond[:120])

# ⑤ 夜盤那支的 host 一定要在夜盤時段(台北 15:00 ~ 次日 05:00 = UTC 07:00 ~ 21:00)
sf = WF.get('.github/workflows/stock_futures.yml') or {}
for h in ((on_of(sf).get('workflow_run') or {}).get('workflows') or []):
    hf = NAMES.get(h)
    crons = []
    if hf:
        sch = on_of(WF[hf]).get('schedule') or []
        crons = [c.get('cron') for c in sch if isinstance(c, dict)]
    night = []
    for c in crons:
        p = str(c).split()
        if len(p) >= 2 and p[1].isdigit():
            night.append(7 <= int(p[1]) <= 21)      # UTC 07~21 = 台北 15:00~次日 05:00
    ok(f'⑤ 🚨 stock_futures 的 host「{h}」至少有一輪在夜盤時段(⛔ 白天跑會把日盤寫成夜盤)',
       any(night), f'crons={crons}')
ok('⑤b 🚧 空過守門:真的抓到 stock_futures 的 host(⛔ 否則上面那條沒驗到東西)',
   bool((on_of(sf).get('workflow_run') or {}).get('workflows')), '')

print()
print(f'❌ WF_QUOTA_FAIL({len(fails)}):{fails[:6]}' if fails else '✅ WF_QUOTA_PASS(全部通過)')
sys.exit(1 if fails else 0)
