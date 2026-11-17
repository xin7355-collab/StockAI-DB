#!/usr/bin/env python3
"""
📅 財經行事曆(macro_miner._compute_upcoming_macro_events)的日期與文字(2026-11-17,docs/PLAN_day_list.md A1 / A2)

背景:加權 2000~2026 實測(research/daytype_20261117),結算日 / 四巫日 / 聯準會 / CPI / 非農的方向全部不成立,
只有「休市 ≥4 天後的第一個交易日」比平常顛。行事曆以前每一列都掛一句聽起來很有道理的警語
(提防外資結算洗盤 / 波動激增 / 終極利空利多…),而且日期有錯(聯準會 2026-12-16 應為 12-09、2027 整排是預填的)。

⛔ 這支要釘死的五件事(離線、不連網):
  ① 行事曆用到的聯準會日期 == research/us_cal.json 的 `fomc`(兩邊任何一邊改了另一邊沒跟上 → 紅)。
  ② 照規則湊 / 預填的日期,事件文字一定帶「日期大約」;定義上就確定的(台指期第三個星期三、美股四巫日、聯準會)⛔ 帶。
  ③ 文字只講是什麼:⛔ 舊警語、⛔ 方向 / 買賣 / 部位字、⛔ 研究字樣(過 scripts/lib_retailbad.mjs 的 badOf)。
  ④ 分級(severity)這一階段 ⛔ 變:App 紅色橫幅、風險分數、Worker 盤前簡報都還在讀;`direction` 已拿掉(沒人讀)。
  ⑤ 休市那幾筆要留「休市」兩個字(index.html `_colTrigEval` 靠它判斷休市前最後一個交易日),12/31 ⛔ 算休市。

用法:python3 scripts/test_macro_calendar.py
"""
import json
import os
import re
import subprocess
import sys
import types
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)   # macro_miner 在 import 時會建 data/(相對路徑)
fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:260]}")
    if not cond:
        fails.append(name)


# macro_miner 在模組層 import yfinance,測試機沒裝 → 塞最小的假模組(本測試不碰行情)
for _m in ('yfinance',):
    if _m not in sys.modules:
        _stub = types.ModuleType(_m)
        _stub.Ticker = lambda *a, **k: None
        sys.modules[_m] = _stub
import macro_miner as mm  # noqa: E402

US_CAL = json.load(open(os.path.join(ROOT, 'research', 'us_cal.json'), encoding='utf-8'))

# 掃 2026-01-01 ~ 2027-12-31 每一天當「今天」(14 天視窗)→ 所有出現過的事件
SWEEP = {}
_d = date(2026, 1, 1)
while _d <= date(2027, 12, 31):
    for e in mm._compute_upcoming_macro_events(_d, 14):
        SWEEP[(e['date'], e['event'])] = e
    _d += timedelta(days=1)
EVS = list(SWEEP.values())
ok('⓪ 掃得到事件(⛔ 空掃算綠)', len(EVS) > 200, len(EVS))

# ── ① 聯準會日期 ──────────────────────────────────────────────
fomc_cal = set(US_CAL.get('fomc') or [])
ok('①a us_cal.json 有 fomc 清單', len(fomc_cal) > 100, len(fomc_cal))
sched = set(mm.FOMC_SCHEDULE)
ok('①b FOMC_SCHEDULE 每一天都在 us_cal.json 的 fomc 裡', sched <= fomc_cal, sorted(sched - fomc_cal))
first = min(mm.FOMC_SCHEDULE)
newer = {d for d in fomc_cal if d >= first}
ok('①c us_cal.json 從 FOMC_SCHEDULE 第一天起的每一場都在 FOMC_SCHEDULE 裡(us_cal 更新了就要跟著改)',
   newer <= sched, sorted(newer - sched))
fomc_used = {e['date'] for e in EVS if 'FOMC' in e['event']}
ok('①d 行事曆實際排出來的聯準會日期全部在 us_cal.json 裡', fomc_used and fomc_used <= fomc_cal,
   sorted(fomc_used - fomc_cal))
ok('①e 2026-12 那場排在 12-09(官方 12/8~9),⛔ 12-16',
   '2026-12-09' in fomc_used and '2026-12-16' not in fomc_used, sorted(d for d in fomc_used if d.startswith('2026-12')))

# ── ② 日期大約 ────────────────────────────────────────────────
APPROX = '日期大約'
MUST_APPROX = {   # 照規則湊 / 預填 → 一定要標
    'CPI': r'CPI', 'PPI': r'PPI', '非農': r'非農', 'ISM': r'ISM', 'MSCI': r'MSCI',
    '台積電法說': r'台積電\(2330\).*法說會', '央行理監事會': r'央行理監事', '清明': r'清明',
}
NO_APPROX = {     # 定義上就確定 / 對過官方原文 → ⛔ 標
    '台指期月結算': r'台指期月結算', '美股四巫日': r'四巫', '聯準會': r'FOMC', '元旦': r'元旦', '國慶': r'國慶',
}
for k, rx in MUST_APPROX.items():
    hit = [e for e in EVS if re.search(rx, e['event'])]
    bad = [e['event'] for e in hit if APPROX not in e['event']]
    ok(f'②a {k}:日期是湊的 → 文字帶「{APPROX}」', hit and not bad, bad[:2] or '一筆都沒掃到')
for k, rx in NO_APPROX.items():
    hit = [e for e in EVS if re.search(rx, e['event'])]
    bad = [e['event'] for e in hit if APPROX in e['event']]
    ok(f'②b {k}:日期是確定的 → ⛔「{APPROX}」', hit and not bad, bad[:2] or '一筆都沒掃到')
boj = [e for e in EVS if '日銀' in e['event']]
boj_bad = [(e['date'], e['event']) for e in boj if (e['date'] in mm.BOJ_PREFILL) != (APPROX in e['event'])]
ok('②c 日銀:2027 預填那排標大約、2026 那排不標', boj and not boj_bad and any(e['date'] in mm.BOJ_PREFILL for e in boj),
   boj_bad[:3])

# ── ③ 文字只講是什麼 ──────────────────────────────────────────
OLD_WARN = ['提防外資結算洗盤', '波動激增', '被動資金流向', '終極利空', '終極利多', '連假前後流動性低', '前後波動大',
            '風向球', '套息交易', '蒸發指數點', '留意異動', '注意股風險', '填息/貼息', '錯過視同違規', 'Fed 政策參考']
texts = sorted({e['event'] for e in EVS})
old_hit = [t for t in texts if any(w in t for w in OLD_WARN)]
ok('③a 舊警語一句都不留', not old_hit, old_hit[:3])
# 方向 / 買賣 / 部位 / 情緒字(⛔ 暗示會漲會跌)
DIRECTIVE = re.compile(r'利多|利空|漲|跌|買|賣|部位|減碼|加碼|出場|進場|洗盤|激增|波動|風向|風險|提防|留意|小心|注意|暫緩|軋空|殺盤|恐慌')
dir_hit = [t for t in texts if DIRECTIVE.search(t)]
ok('③b ⛔ 方向 / 買賣 / 部位 / 警示字', not dir_hit, dir_hit[:3])
# badOf(散戶 App 研究字樣)—— 全 repo 只有 scripts/lib_retailbad.mjs 一份,直接叫 node 跑那一份
js = ("import { badOf } from './scripts/lib_retailbad.mjs';"
      "const xs = JSON.parse(process.argv[1]); const bad = xs.filter(s => badOf(s).length);"
      "console.log(JSON.stringify({ n: xs.length, bad }));")
try:
    r = subprocess.run(['node', '--input-type=module', '-e', js, json.dumps(texts, ensure_ascii=False)],
                       cwd=ROOT, capture_output=True, text=True, timeout=60)
    res = json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 and r.stdout.strip() else None
except Exception as ex:   # ⛔ node 跑不起來 ≠ 通過
    res, r = None, types.SimpleNamespace(stderr=str(ex))
ok('③c 每一句都過 lib_retailbad.badOf(實際叫 node 跑)', res is not None and res['n'] == len(texts) and not res['bad'],
   (res and res['bad'][:3]) or getattr(r, 'stderr', '')[:200])
# 實際能抓:同一支 badOf 對一句研究字樣必須抓到(⛔ node 那邊其實沒在跑卻全綠)
try:
    r2 = subprocess.run(['node', '--input-type=module', '-e', js, json.dumps(['結算日實測勝率 58%'], ensure_ascii=False)],
                        cwd=ROOT, capture_output=True, text=True, timeout=60)
    res2 = json.loads(r2.stdout.strip().splitlines()[-1])
except Exception:
    res2 = None
ok('③d 對照:badOf 對研究字樣真的會抓(③c 不是空跑)', bool(res2 and res2['bad']), res2)

# ── ④ 分級不變、direction 拿掉 ────────────────────────────────
SEV = [   # (那一種事件, 規則, 2026-11-17 改字前的分級)
    ('台指期月結算', r'台指期月結算', 'high'), ('美股四巫日', r'四巫', 'high'), ('CPI', r'CPI', 'high'),
    ('非農', r'非農', 'high'), ('聯準會', r'FOMC', 'high'), ('日銀', r'日銀', 'high'), ('MSCI', r'MSCI', 'high'),
    ('央行理監事會', r'央行理監事', 'high'), ('股東會法定截止', r'股東會法定截止', 'high'),
    ('PPI', r'PPI', 'mid'), ('ISM', r'ISM', 'mid'), ('季報法定截止', r'季報法定截止', 'mid'),
    ('法說旺季', r'法說旺季', 'mid'), ('股東會旺季', r'股東會旺季', 'mid'), ('除權息高峰', r'除權息高峰', 'mid'),
    ('台積電法說', r'台積電\(2330\)', 'low'), ('月營收旺季', r'月營收公布旺季', 'low'),
    ('除權息旺季開跑', r'除權息旺季開跑', 'low'), ('除權息旺季收尾', r'除權息旺季收尾', 'low'),
    ('元旦', r'元旦', 'low'), ('清明', r'清明', 'low'), ('國慶', r'國慶', 'low'),
]
for k, rx, want in SEV:
    hit = [e for e in EVS if re.search(rx, e['event'])]
    bad = sorted({e['severity'] for e in hit if e.get('severity') != want})
    ok(f'④a 分級不變:{k} = {want}', hit and not bad, bad or '一筆都沒掃到')
# data/manual_events.json 的一次性事件照關鍵字分級,不在上表(③ 一樣會掃它們的文字)
try:
    MANUAL = {e.get('event') for e in json.load(open(os.path.join(ROOT, 'data', 'manual_events.json'), encoding='utf-8')).get('events', [])}
except Exception:
    MANUAL = set()
covered = [e['event'] for e in EVS if e['event'] not in MANUAL and not any(re.search(rx, e['event']) for _, rx, _ in SEV)]
ok('④b 每一種演算法事件都有釘分級(新增事件要補進上表)', not covered, sorted(set(covered))[:3])
with_dir = [e['event'] for e in EVS if 'direction' in e]
ok('④c `direction` 已拿掉(關鍵字湊的、沒人讀)', not with_dir, with_dir[:2])
src = open(os.path.join(ROOT, 'macro_miner.py'), encoding='utf-8').read()
ok('④d macro_miner 沒有殘留 BEARISH_KW / BULLISH_KW / direction 欄位',
   not re.search(r"BEARISH_KW|BULLISH_KW|\['direction'\]", src))

# ── ⑤ 休市 ────────────────────────────────────────────────────
hol = [e for e in EVS if re.search(r'元旦|清明|國慶', e['event'])]
ok('⑤a 休市那幾筆留著「休市」(index.html _colTrigEval 靠 /休市/ 判斷)', hol and all('休市' in e['event'] for e in hol),
   [e['event'] for e in hol if '休市' not in e['event']][:2])
dec31 = [e['event'] for e in EVS if e['date'].endswith('-12-31') and '休市' in e['event']]
ok('⑤b 12/31 ⛔ 算休市(平常有開盤:^TWII 2024-12-31、2025-12-31 都有收盤)', not dec31, dec31[:2])

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ MACRO_CALENDAR_PASS(全部通過)')
sys.exit(1 if fails else 0)
