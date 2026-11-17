#!/usr/bin/env python3
"""
📅 財經行事曆(macro_miner._compute_upcoming_macro_events)的日期與文字(2026-11-17,docs/DECISIONS.md V82.5.0)

背景:加權 2000~2026 實測(research/daytype_20261117),結算日 / 四巫日 / 聯準會 / CPI / 非農的方向全部不成立,
只有「休市 ≥4 天後的第一個交易日」比平常顛。行事曆以前每一列都掛一句聽起來很有道理的警語
(提防外資結算洗盤 / 波動激增 / 終極利空利多…),而且日期有錯(聯準會 2026-12-16 應為 12-09、2027 整排是預填的)。

⛔ 這支要釘死的五件事(離線、不連網):
  ① 行事曆用到的聯準會日期 == research/us_cal.json 的 `fomc`(兩邊任何一邊改了另一邊沒跟上 → 紅)。
  ② 照規則湊 / 預填的日期,事件文字一定帶「日期大約」;定義上就確定的(台指期第三個星期三、美股四巫日、聯準會)⛔ 帶。
     事件的 `approx: true` 跟文字一致;`kind`(App `_DAY_FACTS` 的鍵)照種類給、手寫事件用關鍵字推(第二階段)。
  ③ 文字只講是什麼:⛔ 舊警語、⛔ 方向 / 買賣 / 部位字、⛔ 研究字樣(過 scripts/lib_retailbad.mjs 的 badOf)。
  ④ 分級(severity)這一階段 ⛔ 變:App 紅色橫幅、風險分數、Worker 盤前簡報都還在讀;`direction` 已拿掉(沒人讀)。
  ⑤ 休市那幾筆要留「休市」兩個字(index.html `_colTrigEval` 靠它判斷休市前最後一個交易日),12/31 ⛔ 算休市。
  ⑥ (第三階段)算出來的日子(calc:連休前後、月營收公布期,今天那一筆也算)+ 每個事件的 fact == day_facts.json 的 line
     (還沒測過的只給重要度高的)。三邊休市定義一致另外在 scripts/test_dayfacts.mjs ②c。
  ⑦ (第四階段)證交所官方休市表 tw_closed:解析(有開盤的兩種 ⛔ 算休市)、抓失敗分類、表上有 / 沒有那一年的切換;
     (上線後)官方表只給一個年度、11 月中換年 → 按年份跟上一份合併、抓不到沿用、2026-12-25 靠 manual_events。

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
ALL = list(SWEEP.values())
# 算出來的日子(calc)另外驗(⑥);①~⑤ 只看行事曆事件本身
CALC = [e for e in ALL if e.get('calc')]
EVS = [e for e in ALL if not e.get('calc')]
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
MUST_APPROX = {   # 照規則湊 / 預填 / 沒對過官方 → 一定要標
    'CPI': r'CPI', 'PPI': r'PPI', '非農': r'非農', 'ISM': r'ISM', 'MSCI': r'MSCI', '日銀': r'日銀',
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
# ②c `approx` 欄位跟文字一致(App 靠欄位決定能不能說「明天」;只印文字的地方靠文字)
mis = [(e['date'], e['event']) for e in EVS if bool(e.get('approx')) != (APPROX in e['event'])]
ok('②c `approx: true` ⇔ 文字帶「日期大約」(兩者必須一致)', not mis and any(e.get('approx') for e in EVS), mis[:3])
ok('②d `approx` 只有 true 或不給(⛔ false 混進來讓 App 退回看文字的路走不到)',
   all(e.get('approx', True) is True for e in EVS))

# ── ②k 日子種類 kind(App `_DAY_FACTS` 的鍵)──────────────────
KIND = [   # (規則, kind)
    (r'台指期月結算', 'settle'), (r'四巫', 'wit'), (r'FOMC', 'fomc'), (r'日銀', 'boj'), (r'CPI', 'cpi'), (r'PPI', 'ppi'),
    (r'非農', 'nfp'), (r'ISM', 'ism'), (r'央行理監事', 'cbc'), (r'MSCI', 'msci'), (r'法說', 'earn'),
]
for rx, want in KIND:
    hit = [e for e in EVS if re.search(rx, e['event'])]
    bad = sorted({str(e.get('kind')) for e in hit if e.get('kind') != want})
    ok(f'②k kind:{rx} → {want}', hit and not bad, bad or '一筆都沒掃到')
nokind = [e['event'] for e in EVS if not any(re.search(rx, e['event']) for rx, _ in KIND) and 'kind' in e]
ok('②k2 其他事件 ⛔ 亂給 kind(月營收旺季 5 日那筆不是 9~11 日那個定義、休市本身不是一種日子)', not nokind, nokind[:3])
KINDS = {'post45', 'post6', 'pre45', 'pre6', 'settle', 'wit', 'opx', 'fomc', 'cpi', 'nfp', 'rev',
         'msci', 'boj', 'cbc', 'ism', 'ppi', 'earn'}
ok('②k3 kind 都是 _DAY_FACTS 認得的鍵', {e['kind'] for e in EVS if 'kind' in e} <= KINDS)
# 手寫事件:採礦端用同一份關鍵字推(⛔ 手寫的就沒有 kind)
ok('②k4 手寫事件的 kind 用關鍵字推', mm._kind_of_text('🔮 美股四巫日 (期權結算)') == 'wit'
   and mm._kind_of_text('台指期貨大結算') == 'settle' and mm._kind_of_text('🚀 SpaceX IPO 上市') is None
   and mm._kind_of_text('美國 PPI') == 'ppi' and mm._kind_of_text('美國CPI通膨') == 'cpi')

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

# ── ⑥ 算出來的日子(calc)與 fact ───────────────────────────────
DF = json.load(open(os.path.join(ROOT, 'data', 'day_facts.json'), encoding='utf-8'))['kinds']
ok('⑥a 空過守門:掃得到算出來的日子(連休前 / 後、月營收公布期都有;6 天以上的長假要靠手寫的春節,見 ⑥i)',
   {'rev', 'pre45', 'post45'} <= {e['kind'] for e in CALC}, sorted({e['kind'] for e in CALC}))
bad_c = [e for e in CALC if e.get('kind') not in ('post45', 'post6', 'pre45', 'pre6', 'rev') or e.get('approx') or e.get('severity') != 'low']
ok('⑥b calc 事件:kind 只有連休前後 / 月營收、⛔ 日期大約、重要度低', not bad_c, bad_c[:2])
ok('⑥c calc 的文字 ⛔ 含「休市」(App `_colTrigEval` 靠 /休市/ 判斷哪天不開盤,算出來的日子不是休市日)',
   not any('休市' in e['event'] for e in CALC))
rev_bad = [e['date'] for e in CALC if e['kind'] == 'rev' and not (9 <= int(e['date'][8:10]) <= 11)]
ok('⑥d 月營收公布期落在 9~11 日', not rev_bad, rev_bad[:3])
# fact == day_facts.json 的 line(⛔ 採礦端再組一次字串);還沒測過的只給重要度高的
fbad = []
for e in ALL:
    f = DF.get(e.get('kind') or '')
    want = None if not f else (None if (f['type'] == 'untested' and e.get('severity') != 'high') else f['line'])
    if e.get('fact') != want:
        fbad.append((e['date'], e['event'], e.get('fact'), want))
ok('⑥e 每個事件的 fact == day_facts.json 那種日子的 line(還沒測過的只給重要度高的;沒有 kind 不給)', not fbad, fbad[:2])
ok('⑥f 空過守門:有 vol 的 fact、也有還沒測過的 fact', any('比平常顛' in str(e.get('fact')) for e in ALL) and any('還沒測過' in str(e.get('fact')) for e in ALL))
# 決定性對照:2026-12-28 那天看出去 → 12/31(四)連休前最後一天(元旦 + 週末 = 休 3 天)、2027-01-04(一)連休後第一天
c28 = {(e['date'], e['kind']) for e in mm._compute_upcoming_macro_events(date(2026, 12, 28), 14) if e.get('calc')}
ok('⑥g 元旦:12/31 連休前最後一天、1/4 連休後第一天(post45)', ('2026-12-31', 'pre45') in c28 and ('2027-01-04', 'post45') in c28, sorted(c28))
# 今天那一筆也算得出來(往回看得到休市日):2027-01-04 當天跑 → 今天就是連休後第一天
c04 = {(e['date'], e['kind']) for e in mm._compute_upcoming_macro_events(date(2027, 1, 4), 14) if e.get('calc')}
ok('⑥h 今天是連休後第一天 → 今天那一筆也列出來(往回看得到元旦)', ('2027-01-04', 'post45') in c04, sorted(c04))
# 手寫的休市(manual_events.json)也算進去:用暫時的手寫清單餵一次
_orig = mm._manual_events
mm._manual_events = lambda: [(date(2027, 2, d), '🧧 春節 (台股休市)') for d in (5, 8, 9, 10, 11, 12)]
cny = {(e['date'], e['kind']) for e in mm._compute_upcoming_macro_events(date(2027, 2, 1), 14) if e.get('calc')}
mm._manual_events = _orig
ok('⑥i 手寫的春節休市 → 2/4 連休前(休 10 天,pre6)、2/15 連休後(post6)', ('2027-02-04', 'pre6') in cny and ('2027-02-15', 'post6') in cny, sorted(cny))

# ── ⑦ 證交所官方休市表(tw_closed)──────────────────────────────
import lib_twclosed as LT  # noqa: E402
ROWS = [{'Name': '中華民國開國紀念日', 'Date': '1160101', 'Weekday': '五'},
        {'Name': '國曆新年開始交易日', 'Date': '1160104', 'Weekday': '一'},          # 有開盤 → ⛔ 算休市
        {'Name': '農曆春節前最後交易日', 'Date': '1160204', 'Weekday': '四'},        # 有開盤 → ⛔ 算休市
        {'Name': '市場無交易，僅辦理結算交割作業', 'Date': '1160205', 'Weekday': '五'},
        ] + [{'Name': '農曆春節', 'Date': f'11602{d:02d}', 'Weekday': ''} for d in (8, 9, 10, 11, 12)] + [
        {'Name': '兒童節及民族掃墓節', 'Date': '1160405', 'Weekday': '一'},
        {'Name': '壞列', 'Date': '116/10/10'}, 'not a dict']
named = LT.parse_official_closed_named(ROWS)
ok('⑦a 解析:放假 / 無交易收、「開始交易」「最後交易」那兩種有開盤的 ⛔ 收、壞列跳過',
   '2027-01-04' not in named and '2027-02-04' not in named and '2027-02-05' in named and '2027-01-01' in named and len(named) == 8, sorted(named))
ok('⑦b miner.py 用的是同一份解析(lib_twclosed;⛔ 兩邊各寫一份)',
   'from lib_twclosed import' in open(os.path.join(ROOT, 'miner.py'), encoding='utf-8').read()
   and 'def parse_official_closed' not in open(os.path.join(ROOT, 'miner.py'), encoding='utf-8').read()
   and LT.parse_official_closed(ROWS) == {d.replace('-', '/') for d in named})


class _R:
    def __init__(self, st, body=None, bad=False):
        self.status_code, self._b, self._bad = st, body, bad

    def json(self):
        if self._bad:
            raise ValueError('not json')
        return self._b


def _fetch(resp):
    keep = mm.http

    class H:
        sent = []

        def get(self, url, headers=None, timeout=None):
            H.sent.append((url, headers))
            if isinstance(resp, Exception):
                raise resp
            return resp
    mm.http = H()
    try:
        return mm.fetch_tw_closed(), H.sent
    finally:
        mm.http = keep


(tc, why), sent = _fetch(_R(200, ROWS))
ok('⑦c 抓得到 → tw_closed = {src, fetched, years, days, names}', tc and tc['years'] == [2027] and tc['days'][0] == '2027-01-01'
   and '2027-02-05' in tc['days'] and tc['src'].startswith('https://openapi.twse.com.tw/') and why == '', (tc, why))
ok('⑦d 寫明身分的 UA(⛔ 假冒瀏覽器)', sent and 'StockAI-DB' in sent[0][1].get('User-Agent', '') and 'Chrome/' not in sent[0][1].get('User-Agent', ''), sent)
import requests  # noqa: E402
r1 = _fetch(_R(403))[0]; r2 = _fetch(requests.exceptions.ConnectTimeout('x'))[0]; r3 = _fetch(_R(200, bad=True))[0]; r4 = _fetch(_R(200, []))[0]
ok('⑦e 失敗分清楚:被擋(HTTP)/ 連不上 / 回網頁 / 回應裡沒有休市日,而且都回 None(⛔ 沿用舊的)',
   r1[0] is None and '被擋' in r1[1] and r2[0] is None and '連不上' in r2[1] and r3[0] is None and 'JSON' in r3[1] and r4[0] is None and '沒有休市日' in r4[1],
   [r1, r2, r3, r4])
src_mm = open(os.path.join(ROOT, 'macro_miner.py'), encoding='utf-8').read()
_carry = src_mm[src_mm.index('for key in ("us10y_yield"'):src_mm.index('"macro_events_ai"):')]
# ⑦f 2026-11-18 改:官方表只給一個年度、11 月中就換成隔年 → 每一輪跟上一份(_load_prev_macro 那份)按年份合併;
#     抓不到 → 上一份 ≥ 今年的年份整份沿用(各年時間照舊)。tw_closed 仍 ⛔ 進斷崖防護清單(那條會整份照抄、不分年份)。
ok('⑦f 主程式:抓到的跟上一份按年份合併(merge_tw_closed),合併結果才寫進 out;⛔ 走斷崖防護整份照抄',
   'tw_closed' not in _carry and 'merge_tw_closed(_twc_new, (_prev_json or {}).get("tw_closed")' in src_mm
   and 'if _twc:\n            out["tw_closed"] = _twc' in src_mm and 'tw_closed=_twc)' in src_mm)
_ys = lambda tc: sorted({int(d[:4]) for d in (tc or {}).get('days') or []})
P26 = {'src': 'x', 'fetched': '2026-06-01 08:00', 'years': [2026], 'days': ['2026-01-01', '2026-10-09', '2026-10-26'],
       'names': {'2026-01-01': '開國紀念日', '2026-10-09': '國慶日補假', '2026-10-26': '光復節補假'}}
N27, _ = (lambda r: (r[0][0], r[1]))(_fetch(_R(200, ROWS)))
M1, n1 = mm.merge_tw_closed(N27, P26, 2026)
ok('⑦m 換年:上一份有 2026、這一輪回 2027 → 兩年都在;2026 那年的時間照舊、2027 是這一輪的',
   M1 and M1['years'] == [2026, 2027] and _ys(M1) == [2026, 2027] and '2026-10-26' in M1['days'] and '2027-02-05' in M1['days']
   and M1['fetched_by_year'] == {'2026': '2026-06-01 08:00', '2027': N27['fetched']} and M1['names']['2026-10-26'] == '光復節補假', (M1, n1))
M2, n2 = mm.merge_tw_closed(N27, M1, 2027)
ok('⑦n 隔年 1 月:上一份有 2026 + 2027 → 已過的 2026 丟掉(⛔ 無限長大)', M2 and M2['years'] == [2027] and _ys(M2) == [2027] and '已過' in n2, (M2 and M2['years'], n2))
M3, n3 = mm.merge_tw_closed(None, M1, 2026)
ok('⑦o 這一輪抓不到 → 上一份整份沿用,各年時間 ⛔ 被改成新的', M3 and M3['years'] == [2026, 2027] and M3['fetched_by_year'] == M1['fetched_by_year']
   and M3['days'] == M1['days'] and '抓不到' in n3, (M3 and M3['fetched_by_year'], n3))
M4, n4 = mm.merge_tw_closed(None, None, 2026)
ok('⑦p 沒有上一份又抓不到 → 沒有 tw_closed(退回固定連假 + manual_events)', M4 is None, n4)
bad_prev = [{'days': 'x'}, 'garbage', {'years': ['a'], 'days': [1, None, '2026-13-99x']}, {'days': ['2026-12-25'], 'years': None}, 123]
okb = all(mm.merge_tw_closed(None, bp, 2026)[0] is None and mm.merge_tw_closed(N27, bp, 2026)[0]['years'] == [2027] for bp in bad_prev)
ok('⑦q 上一份格式壞掉 → 當作沒有,⛔ 讓採礦當掉', okb)
ok('⑦r 官方名稱結尾的句號拿掉(⛔「…交割作業。 (台股休市)」)',
   LT.parse_official_closed_named([{'Name': '市場無交易，僅辦理結算交割作業。', 'Date': '1160202'}]) == {'2027-02-02': '市場無交易，僅辦理結算交割作業'})
# 2026-12-25 行憲紀念日:官方表只剩 2027 → 靠 manual_events.json 那一筆
X = mm._compute_upcoming_macro_events(date(2026, 12, 15), 14, N27)
xs = {(e['date'], e.get('kind'), e['event']) for e in X}
f45 = [e for e in X if e['date'] == '2026-12-28' and e.get('kind') == 'post45']
ok('⑦s 12/25(五)行憲紀念日休市 → 12/24 連休前最後一個交易日、12/28 連休 3 天後的第一個交易日(帶 fact)',
   any(d == '2026-12-25' and '休市' in t for d, k, t in xs) and ('2026-12-24', 'pre45') in {(d, k) for d, k, t in xs}
   and len(f45) == 1 and f45[0]['event'] == '🗓️ 連休 3 天後的第一個交易日' and '1.39 倍' in str(f45[0].get('fact')), sorted(xs)[:20])
_me = json.load(open(os.path.join(ROOT, 'data', 'manual_events.json'), encoding='utf-8'))
_e25 = [e for e in _me['events'] if e.get('date') == '2026-12-25']
ok('⑦t manual_events.json 那一筆:不標日期大約、有寫依據(why),而且 _manual_events 只讀 date / event 不受多一個欄位影響',
   len(_e25) == 1 and '日期大約' not in _e25[0]['event'] and _e25[0].get('why') and (date(2026, 12, 25), '🗓️ 行憲紀念日 (台股休市)') in mm._manual_events(), _e25)

# 表上有 / 沒有那一年的切換
EV_OFF = {(e['date'], e['event']) for e in mm._compute_upcoming_macro_events(date(2027, 2, 1), 14, tc)}
CALC_OFF = {(e['date'], e['kind']) for e in mm._compute_upcoming_macro_events(date(2027, 2, 1), 14, tc) if e.get('calc')}
ok('⑦g 官方表有那一年 → 春節出事件「🗓️ 農曆春節 (台股休市)」,連休前 / 後照官方日子算(2/4 → 2/15)',
   ('2027-02-08', '🗓️ 農曆春節 (台股休市)') in EV_OFF and ('2027-02-04', 'pre6') in CALC_OFF and ('2027-02-15', 'post6') in CALC_OFF, sorted(CALC_OFF))
ok('⑦h 決定性對照:同一天沒有官方表 → 不知道春節(⛔ 連休前後)', not any(k in ('pre6', 'post6') for _, k in
   {(e['date'], e['kind']) for e in mm._compute_upcoming_macro_events(date(2027, 2, 1), 14) if e.get('calc')}))
Q = [e['event'] for e in mm._compute_upcoming_macro_events(date(2027, 3, 30), 14, tc) if e['date'].startswith('2027-04-0')]
ok('⑦i 官方表有那一年 → ⛔ 再湊固定連假(清明 4/4 那筆不出現),用官方的日子(4/5,⛔ 標大約)',
   not any('清明' in t for t in Q) and '🗓️ 兒童節及民族掃墓節 (台股休市)' in Q, Q)
Q26 = [e['event'] for e in mm._compute_upcoming_macro_events(date(2026, 3, 30), 14, tc) if e['date'].startswith('2026-04-0')]
ok('⑦j 官方表沒有那一年(2026)→ 照舊固定連假(清明 4/4 標大約)', any('清明' in t and '日期大約' in t for t in Q26), Q26)
Q0 = [e['event'] for e in mm._compute_upcoming_macro_events(date(2027, 3, 30), 14) if e['date'].startswith('2027-04-0')]
ok('⑦k 抓不到(沒有 tw_closed)→ 退回舊做法(2027 清明照湊)', any('清明' in t for t in Q0), Q0)
_orig = mm._manual_events
mm._manual_events = lambda: [(date(2027, 2, 8), '🧧 春節 (台股休市)')]
dup = [e['event'] for e in mm._compute_upcoming_macro_events(date(2027, 2, 1), 14, tc) if e['date'] == '2027-02-08']
mm._manual_events = _orig
ok('⑦l 同一天官方表跟手寫都說休市 → 只列官方那一筆(⛔ 重複)', dup == ['🗓️ 農曆春節 (台股休市)'], dup)

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ MACRO_CALENDAR_PASS(全部通過)')
sys.exit(1 if fails else 0)
