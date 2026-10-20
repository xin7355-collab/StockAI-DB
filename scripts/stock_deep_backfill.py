#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🗄️ 個股深歷史補挖(V79.3.8,「變因因子」研究的資料底)—— FinMind 免費層「一檔一次」→ 獨立分支 `stock_deep`

使用者(2026-10-20):「我想做的是變因因子…把能測試的都列出來再來執行。要挖礦就挖礦。」
⭐ 盤點時發現:2010~2020 的個股價格只有外部 k66 那份(約 1,000 檔、只有上市、只有活到現在的、沒有除權息)
   → 上櫃與下市股整段不在、inst_deep 2012~2020 有 448 檔法人資料掛不上去。所以第一優先是 price10 + div10。

資料集(登記表 DATASETS;一檔一次呼叫,全部 FinMind 標「Free(w/ data_id)」):
  price10  TaiwanStockPrice              2010-01-01 ~ 2021-03-31  → 跟 klines_deep 重疊 3 個月接縫 + 對表
  div10    TaiwanStockDividendResult     2010-01-01 ~ 2021-03-31  → 含息報酬(⛔ 不動既有 dividends_hist.json)
  margin   TaiwanStockMarginPurchaseShortSale 2010-01-01 ~ 2023-06-30 → 跟 data/*.json 2023-05 起對表
  rev      TaiwanStockMonthRevenue       2009-01-01 ~ 今天
  per      TaiwanStockPER                2010-01-01 ~ 今天
  share    TaiwanStockShareholding       2010-01-01 ~ 今天
  dt       TaiwanStockDayTrading         2014-01-01 ~ 今天
  sbl      TaiwanDailyShortSaleBalances  2010-01-01 ~ 今天
  fis10 / fbs10 / fcf10  綜合損益表 / 資產負債表 / 現金流量表 2010-01-01 ~ 2018-06-30
           → 只留 fin_backfill.WANT 那幾個科目(⛔ 不抄第二份);跟 fin_deep.json 重疊的 2018 前兩季逐欄對表
           (fin_deep 只到 2018 起 → 基本面變因只有 8 年;補完變 16 年,含 2011 / 2015 / 2018 三段跌勢)

⛔ 欄位不憑印象寫:除了 price10 / margin(既有程式已驗過的欄名),其他一律「整份數字欄照存」
   (拿掉字串欄與整段都一樣的欄),每個資料集開工前先抓 2330 印出欄位與最早日期(探路)。

架構(照 klines_backfill / inst_backfill deep 的決定,⛔ 別改回去):
  ① 寫 `stock_deep/{ds}/{代號}.json.gz`,推**獨立 orphan 分支 stock_deep**(⛔ 不進 data / gh-pages,陷阱 #41)
  ② 已有就跳過(冪等,可續跑);那段期間沒資料也寫一個空檔(下次才不會一直重抓)
  ③ token 輪動 / 免費層節流 / 402·429 等額度:**直接用 `inst_backfill.fm`**(⛔ 不抄第二份)
  ④ ⭐ 避開共用金鑰的排程時段(PROTECT;selftest 拿去跟那幾支 workflow 的 cron 比對)
  ⑤ 時間預算用完 → GitHub output `more=1`,workflow 用 workflow_dispatch 接力自己

守門(⛔ 都不可拿掉):探路失敗那個資料集整個跳過並記原因 ・對表 <90% 那個資料集這一輪新寫的全部刪掉不推 ・
  一檔都沒寫 → 那個資料集算失敗 ・收尾把每個資料集的狀態寫進 `stock_deep/_status.json`(只記「第幾把」不記金鑰值)

跑法:python3 scripts/stock_deep_backfill.py           (env:QUEUE / MAX_MIN / LIMIT / UNIVERSE / OUT_DIR / DATA_DIR / KLINES_DIR)
      python3 scripts/stock_deep_backfill.py --selftest
"""
import gzip
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'scripts'))

OUT = Path(os.getenv('OUT_DIR') or 'stock_deep')
DATA_DIR = Path(os.getenv('DATA_DIR') or 'data')
KLINES_DIR = Path(os.getenv('KLINES_DIR') or 'klines_deep')
UNIVERSE = os.getenv('UNIVERSE') or ''
QUEUE = [x.strip() for x in (os.getenv('QUEUE') or 'price10,div10,margin,rev,per,share,dt,sbl,fis10,fbs10,fcf10').split(',') if x.strip()]
FIN_DEEP = Path(os.getenv('FIN_DEEP') or 'fin_deep/fin_deep.json')   # 季報對表用(fin_deep 分支)
MAX_MIN = float(os.getenv('MAX_MIN') or 330)          # 一棒總時間(含等保護時段);job 上限 355
LIMIT = int(os.getenv('LIMIT') or 99999)               # 這一棒每個資料集最多抓幾檔(試跑用)
CHECK_MIN_N = 50                                       # 對表至少要這麼多檔「兩邊都有」才判
CHECK_MIN_RATE = 0.90
TODAY = date.today().isoformat()

DATASETS = {
    'price10': {'ds': 'TaiwanStockPrice', 'start': '2010-01-01', 'end': '2021-03-31', 'kind': 'price', 'check': 'price', 'min_nonempty': 0.5},
    'div10':   {'ds': 'TaiwanStockDividendResult', 'start': '2010-01-01', 'end': '2021-03-31', 'kind': 'generic', 'check': None, 'min_nonempty': 0.2},
    'margin':  {'ds': 'TaiwanStockMarginPurchaseShortSale', 'start': '2010-01-01', 'end': '2023-06-30', 'kind': 'generic', 'check': 'margin', 'min_nonempty': 0.5},
    'rev':     {'ds': 'TaiwanStockMonthRevenue', 'start': '2009-01-01', 'end': TODAY, 'kind': 'generic', 'check': None, 'min_nonempty': 0.5},
    'per':     {'ds': 'TaiwanStockPER', 'start': '2010-01-01', 'end': TODAY, 'kind': 'generic', 'check': None, 'min_nonempty': 0.5},
    'share':   {'ds': 'TaiwanStockShareholding', 'start': '2010-01-01', 'end': TODAY, 'kind': 'generic', 'check': None, 'min_nonempty': 0.5},
    'dt':      {'ds': 'TaiwanStockDayTrading', 'start': '2014-01-01', 'end': TODAY, 'kind': 'generic', 'check': None, 'min_nonempty': 0.3},
    'sbl':     {'ds': 'TaiwanDailyShortSaleBalances', 'start': '2010-01-01', 'end': TODAY, 'kind': 'generic', 'check': None, 'min_nonempty': 0.1},
    # 季報三表:end 刻意壓到 2018-06-30 → 跟 fin_deep.json(2018 起)重疊兩季拿來對表
    'fis10':   {'ds': 'TaiwanStockFinancialStatements', 'start': '2010-01-01', 'end': '2018-06-30', 'kind': 'long', 'check': 'fin', 'min_nonempty': 0.5},
    'fbs10':   {'ds': 'TaiwanStockBalanceSheet', 'start': '2010-01-01', 'end': '2018-06-30', 'kind': 'long', 'check': 'fin', 'min_nonempty': 0.5},
    'fcf10':   {'ds': 'TaiwanStockCashFlowsStatement', 'start': '2010-01-01', 'end': '2018-06-30', 'kind': 'long', 'check': 'fin', 'min_nonempty': 0.5},
}

# ⭐ 共用 FINMIND_TOKENS 的排程(UTC;週一=1 … 週日=7 用 ISO weekday)。每一列 = (星期集合, 開始, 結束)。
#    ⛔ 改了那幾支 workflow 的 cron 要回來改這裡 —— selftest ⑥ 會把 cron 讀出來比對,蓋不到就紅。
WK = {1, 2, 3, 4, 5}
PROTECT = [
    (WK, '08:15', '14:45'),      # daily_miner 08:30 / 12:00(兩輪各 2 小時多)+ worker 17:00 台北叫醒
    (WK, '17:45', '22:00'),      # fund_sweep 18:00 → pe_band(workflow_run 接在後面,cron 19:30 備援)
    (WK, '00:00', '00:12'),      # macro_cron(8 分鐘)
    (WK, '04:00', '04:12'),
    (WK, '16:00', '16:12'),
    ({6}, '21:15', '23:30'),     # dividend_sweep 週六 21:30
    ({5}, '22:45', '23:59'),     # tdcc_sweep 週五 23:00
    ({6}, '00:00', '00:15'),
]
SHORT_WAIT_MIN = 30              # 短的保護時段(macro_cron 那種)就地等;長的停手接力

# ⑨ 🔁 2026-10-20 動態保護:GitHub 排程常常晚好幾小時(fund_sweep cron 18:00 那天 22:12 才跑)→ 只看 cron 時間擋不住,
#    當晚 pe_band 一輪成功 0 檔(402×503)、另一輪只新抓 195 檔(其餘沿用上一輪)。
#    → 每抓一檔前(快取 BUSY_TTL 秒)問 GitHub API:共用 FINMIND_TOKENS 又會自動跑的那幾支有沒有 in_progress / queued → 有就暫停。
#    ⛔ 新增「會自動跑、又吃 FINMIND_TOKENS」的 workflow 要加進 SHARED_WF —— selftest ⑨ 會掃 .github/workflows/ 比對,漏了就紅。
SHARED_WF = ('daily_miner.yml', 'fund_sweep.yml', 'pe_band.yml', 'dividend_sweep.yml', 'tdcc_sweep.yml',
             'macro_cron.yml', 'rotation_probe.yml')
BUSY_TTL = 60                    # 秒:同一分鐘內只問一次 API
BUSY_WAIT_MIN = 5                # 有人在跑 → 每 5 分鐘再看一次
BUSY_FAIL_MAX = 3                # API 連 3 次查不到 → 退回只靠時段表(照舊)並明說
_BUSY = {'t': 0.0, 'v': (False, ''), 'fail': 0, 'said': ''}


def _gh_runs(status):
    import requests
    repo = os.environ.get('GITHUB_REPOSITORY') or 'xin7355-collab/StockAI-DB'
    tok = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN') or ''
    h = {'Accept': 'application/vnd.github+json'}
    if tok:
        h['Authorization'] = f'Bearer {tok}'
    r = requests.get(f'https://api.github.com/repos/{repo}/actions/runs',
                     params={'status': status, 'per_page': 100}, headers=h, timeout=20)
    r.raise_for_status()
    return r.json().get('workflow_runs') or []


def others_busy(fetch=None, now=None):
    """共用金鑰的那幾支 workflow 現在有沒有在跑?回 (True/False, 說明)。
    fetch(status) 可注入(selftest);預設問 GitHub API 並快取 BUSY_TTL 秒。
    API 查不到 → 保守當成「有人在跑」;連 BUSY_FAIL_MAX 次查不到 → 退回只靠時段表,並把原因寫出來(⛔ 不靜默)。"""
    real = fetch is None
    fetch = fetch or _gh_runs
    now = time.time() if now is None else now
    if real and _BUSY['t'] and now - _BUSY['t'] < BUSY_TTL:
        return _BUSY['v']
    try:
        hit = set()
        for st in ('in_progress', 'queued'):
            for r in fetch(st) or []:
                wf = os.path.basename(str(r.get('path') or '').split('@')[0])
                if wf in SHARED_WF:
                    hit.add(f'{wf}({st})')
        _BUSY['fail'] = 0
        v = (bool(hit), '、'.join(sorted(hit)))
    except Exception as e:
        _BUSY['fail'] += 1
        if _BUSY['fail'] >= BUSY_FAIL_MAX:
            v = (False, f'⚠️ 連 {_BUSY["fail"]} 次查不到其他 workflow 的狀態({type(e).__name__})→ 只靠時段表(照舊)')
        else:
            v = (True, f'查不到其他 workflow 的狀態({type(e).__name__})→ 保守先等')
    if real:
        _BUSY.update(t=now, v=v)
    return v


def _hm(s):
    h, m = s.split(':')
    return int(h) * 60 + int(m)


def protect_state(now):
    """回 (在保護時段裡嗎, 還要等幾分鐘, 距下一個保護時段開始還有幾分鐘)。now = aware UTC datetime。"""
    inside, wait = False, 0.0
    cur = now.isoweekday()
    mins = now.hour * 60 + now.minute + now.second / 60
    for days, a, b in PROTECT:
        if cur in days and _hm(a) <= mins < _hm(b) + 1:
            inside = True
            wait = max(wait, _hm(b) + 1 - mins)
    nxt = None
    for k in range(0, 8):                      # 往後找 8 天內最近的一個開始
        d = now + timedelta(days=k)
        for days, a, _b in PROTECT:
            if d.isoweekday() not in days:
                continue
            st = d.replace(hour=_hm(a) // 60, minute=_hm(a) % 60, second=0, microsecond=0)
            if st > now:
                m = (st - now).total_seconds() / 60
                nxt = m if nxt is None else min(nxt, m)
        if nxt is not None and k >= 1:
            break
    return inside, wait, (nxt if nxt is not None else 1e9)


# ── ⑩ 🔁 2026-10-20 第 5 棒實測:額度暫時用完 ≠ 資料集壞掉 ─────────────────
#    那一棒在保護時段等了 255 分,22:01 一開工剛好撞上 pe_band(排程晚 3.5 小時)正在用同一組金鑰 →
#    六個資料集「探路」全部 http402(額度用完)→ 舊版當成「資料集名 / 層級不對」整個跳過 → more=0、接力停了
#    (workflow 全綠、零訊息)。⛔ 兩個病:① 探路前沒問保護時段 / 動態保護(只印了一行)② 暫時用完被當成永久失敗。
#    → 探路前先 `wait_turn`;402 / 429 一律 `fetch_retry` 等 5 分鐘再試,等不到就停手接力(⛔ 不跳過、不寫 probe_err)。
def is_quota(err):
    """FinMind 額度暫時用完(402 / 429)。兩種格式都認:inst_backfill.fm 的 `http402:…`、dispo_probe.fm 的 `第N把/HTTP 402/quota/…`。"""
    e = str(err or '')
    return e.startswith('http402') or e.startswith('http429') or bool(re.search(r'(?i)HTTP 40[29]\b|/quota/|upper limit', e))


def probe_verdict(rows, err):
    """探路結果 → 'ok' / 'quota'(額度暫時用完:⛔ 不跳過,停手接力)/ 'skip'(資料集名 / 層級 / 深度不對:這個資料集跳過)"""
    if rows:
        return 'ok'
    return 'quota' if is_quota(err) else 'skip'


def fetch_retry(fm, ds, sym, start, end, deadline, sleep=time.sleep, clock=time.time, tries=6):
    """抓一檔;額度用完就等 5 分鐘再試(最多 tries 次、⛔ 不等過 deadline)。回 (rows, err, 等了幾次)。"""
    data, err, waits = None, None, 0
    for _ in range(tries):
        data, err = fm(ds, sym, start, end_date=end, timeout=90)
        if data is not None and len(data) > 0 or not is_quota(err):
            break
        if clock() + 300 > deadline - 120:
            break
        waits += 1
        print(f'   ⏳ {sym} 額度用完({str(err)[:60]})→ 等 5 分鐘', flush=True)
        sleep(300)
    return data, err, waits


def wait_turn(deadline, sleep=time.sleep, clock=time.time, now_fn=None, busy=None):
    """保護時段 + 動態保護:輪到我們了回 None;該停手接力就回 'time'。
    短的保護時段就地等、長的停手;共用金鑰的 workflow 在跑就每 BUSY_WAIT_MIN 分看一次。"""
    now_fn = now_fn or (lambda: datetime.now(timezone.utc))
    busy = busy or others_busy
    while True:
        inside, wait, nxt = protect_state(now_fn())
        if inside:
            if wait <= SHORT_WAIT_MIN and clock() + wait * 60 < deadline - 120:
                print(f'   ⏸️ 短的保護時段 → 就地等 {wait:.0f} 分', flush=True)
                sleep(wait * 60)
                continue
            return 'time'
        if nxt < 2:
            sleep(nxt * 60 + 5)
            continue
        b, why = busy()
        if b:
            if clock() + BUSY_WAIT_MIN * 60 < deadline - 120:
                if why != _BUSY['said']:
                    print(f'   ⏸️ 共用金鑰的 {why} 正在跑 → 每 {BUSY_WAIT_MIN} 分看一次(⛔ 不搶它的額度)', flush=True)
                    _BUSY['said'] = why
                sleep(BUSY_WAIT_MIN * 60)
                continue
            return 'time'
        if _BUSY['said']:
            print(f'   ▶️ 它們跑完了({_BUSY["said"]})→ 接著抓', flush=True)
            _BUSY['said'] = ''
        return None


# ── 資料打包 ─────────────────────────────────────────────────────
def _d(x):
    return str(x or '').replace('/', '-')[:10]


def _num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    try:
        s = str(v).replace(',', '').strip()
        return float(s) if s not in ('', '-', '--', 'None', 'nan') else None
    except Exception:
        return None


def pack_generic(rows):
    """FinMind 列 → 欄位式 {d:[日期], c:[欄名], v:[[每一列的值]]}。只留數字欄,拿掉整段都一樣的欄(沒有資訊)。
    同一天多列 → 留最後一列(FinMind 回傳已依日期排序)。⛔ 不猜欄名:欄位是從資料本身讀出來的。"""
    by = {}
    for r in rows or []:
        d = _d(r.get('date'))
        if d:
            by[d] = r
    ds = sorted(by)
    if not ds:
        return {'d': [], 'c': [], 'v': []}
    keys = []
    for r in by.values():
        for k in r:
            if k not in keys and k not in ('date', 'stock_id', 'stock_name'):
                keys.append(k)
    cols = []
    for k in keys:
        vals = [_num(by[d].get(k)) for d in ds]
        nn = [x for x in vals if x is not None]
        if len(nn) < max(1, len(ds) * 0.5):
            continue                                   # 大多不是數字 → 字串欄,不存
        if len(set(nn)) <= 1 and len(ds) > 1:
            continue                                   # 整段一樣 → 沒資訊
        cols.append(k)
    v = [[(lambda x: (int(x) if isinstance(x, float) and x.is_integer() and abs(x) < 9e15 else x))(_num(by[d].get(k))) for k in cols] for d in ds]
    return {'d': ds, 'c': cols, 'v': v}


def pack_price(rows, sym, delisted=False):
    """TaiwanStockPrice → 跟 klines_deep 一樣的格式 {s, dl, k:[[date,o,h,l,c,vol]], m:[成交金額]};寫檔前套 miner._backadjust_splits(共用)。"""
    recs = []
    for r in rows or []:
        try:
            c = float(r['close'])
            if c <= 0:
                continue
            recs.append({'date': _d(r['date']), 'open': float(r['open']), 'high': float(r['max']), 'low': float(r['min']),
                         'close': c, 'volume': int(r.get('Trading_Volume') or 0), 'money': int(r.get('Trading_money') or 0)})
        except (KeyError, TypeError, ValueError):
            continue
    recs.sort(key=lambda x: x['date'])
    if recs:
        import miner                                    # 只在真的要調整時才載(selftest 也走這條)
        miner._backadjust_splits(recs, sym=sym)
    return {'s': sym, 'dl': 1 if delisted else 0,
            'k': [[x['date'], x['open'], x['high'], x['low'], x['close'], x['volume']] for x in recs],
            'm': [x['money'] for x in recs]}


def fin_want(ds):
    """季報資料集 → {FinMind 科目名: fin_deep 欄位};直接讀 fin_backfill.WANT(⛔ 不抄第二份)。"""
    from fin_backfill import WANT
    return {t: f for f, t in (WANT.get(ds) or {}).items()}


def pack_long(rows, want):
    """長表(date, type, value)→ 欄位式 {d:[季別], c:[科目], v:[[值]]};只留 want 那幾個科目。"""
    by = {}
    for r in rows or []:
        d, t = _d(r.get('date')), str(r.get('type') or '')
        if not d or t not in want:
            continue
        v = _num(r.get('value'))
        if v is not None:
            by.setdefault(d, {})[t] = v
    ds = sorted(by)
    cols = [t for t in want if any(t in by[d] for d in ds)]
    return {'d': ds, 'c': cols, 'v': [[by[d].get(t) for t in cols] for d in ds]}


def is_empty(obj):
    return not (obj.get('k') if 'k' in obj else obj.get('d'))


# ── 對表 ─────────────────────────────────────────────────────────
def check_price(obj, kd):
    """price10 跟 klines_deep 重疊那段(2021-01~03):每天收盤比例要是常數(klines_deep 已做過分割回調 → 比例可以 ≠1,但要一樣)。
    回 None(沒得比)/ True / False。"""
    if not kd or not obj.get('k'):
        return None
    mine = {r[0]: r[4] for r in obj['k']}
    rat = [mine[r[0]] / r[4] for r in kd.get('k') or [] if r[0] in mine and r[4] and mine[r[0]]]
    if len(rat) < 20:
        return None
    return max(rat) / min(rat) - 1 <= 0.005


def check_margin(pk, rows):
    """margin 跟 data/*.json 重疊那段(2023-05 起):融資餘額(張)1 張或 1% 以內才算一致。回 (可比天數, 一致天數)。"""
    if not pk.get('c') or 'MarginPurchaseTodayBalance' not in pk['c']:
        return 0, 0
    i = pk['c'].index('MarginPurchaseTodayBalance')
    have = {_d(r.get('date')): r.get('margin_balance') for r in (rows or []) if r.get('margin_balance')}
    n = hit = 0
    for d, row in zip(pk['d'], pk['v']):
        a, b = have.get(d), row[i]
        if not a or b is None:
            continue
        n += 1
        hit += abs(a - b) <= max(1, abs(a) * 0.01)
    return n, hit


def check_fin(obj, rec, fidx, tmap):
    """季報跟 fin_deep.json 重疊那幾季逐欄比:同一個上游 → 值要一樣(0.1% 或 0.01 以內)。
    rec = FD.s[代號](季 → 陣列)、fidx = {欄位: FD.f 的位置}、tmap = {科目: 欄位}。回 (可比格數, 一致格數)。"""
    n = hit = 0
    for d, row in zip(obj.get('d') or [], obj.get('v') or []):
        q = (rec or {}).get(d)
        if not q:
            continue
        for t, v in zip(obj.get('c') or [], row):
            i = fidx.get(tmap.get(t))
            if i is None or i >= len(q) or q[i] is None or v is None:
                continue
            n += 1
            hit += abs(v - q[i]) <= max(0.01, abs(q[i]) * 0.001)
    return n, hit


# ── 母體 ─────────────────────────────────────────────────────────
def read_universe(path):
    out, seen = [], set()
    try:
        toks = Path(path).read_text(encoding='utf-8').split()
    except Exception:
        return []
    for x in toks:
        x = x.strip()
        if len(x) == 4 and x.isdigit() and not x.startswith('0') and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def delisted_since(start):
    """TaiwanStockDelisting(資料集層級,沒有 data_id)→ start 之後下市的 4 碼個股。抓不到回 (set(), 原因)。"""
    from dispo_probe import fm as fm_any                 # 通用版(只有這支能不帶 data_id)
    rows, err = fm_any('TaiwanStockDelisting', {})
    if not rows:
        return set(), err or 'empty'
    out = set()
    for r in rows:
        sid, d = str(r.get('stock_id') or ''), _d(r.get('date'))
        if len(sid) == 4 and sid.isdigit() and not sid.startswith('0') and d >= start:
            out.add(sid)
    return out, None


# ── 主流程 ───────────────────────────────────────────────────────
def gh_out(**kw):
    p = os.getenv('GITHUB_OUTPUT')
    for k, v in kw.items():
        print(f'::notice::{k}={v}')
        if p:
            with open(p, 'a', encoding='utf-8') as f:
                f.write(f'{k}={v}\n')


def main():
    import inst_backfill as IB                          # fm(token 輪動 / 不印金鑰)+ TOKENS
    if not IB.TOKENS:
        print('❌ 沒有 FINMIND_TOKENS → 補挖需要金鑰')
        return 1
    t0 = time.time()
    deadline = t0 + MAX_MIN * 60
    now = datetime.now(timezone.utc)
    inside, wait, _ = protect_state(now)
    if inside:
        w = min(wait, MAX_MIN - 15)
        print(f'⏸️ 現在在共用金鑰的排程時段(UTC {now:%a %H:%M})→ 先等 {w:.0f} 分(⛔ 不搶 daily_miner / fund_sweep 的額度)', flush=True)
        time.sleep(max(0, w) * 60)
    base = read_universe(UNIVERSE)
    dl_quota = False
    if wait_turn(deadline) == 'time':                   # ⑩ 下市名單也吃同一組額度 → 先等輪到我們
        print('⏸️ 開工前就輪不到(保護時段 / 共用金鑰的 workflow 一直在跑)→ 停手接力', flush=True)
        gh_out(more='1', reason='time', queue=','.join(QUEUE), minutes=f'{(time.time() - t0) / 60:.0f}')
        return 0
    for i in range(4):
        dl, dl_err = delisted_since('2010-01-01')
        if not dl_err or not is_quota(dl_err) or time.time() + 300 > deadline - 600:
            break
        print(f'   ⏳ 下市名單:額度用完({str(dl_err)[:60]})→ 等 5 分鐘再試', flush=True)
        time.sleep(300)
    if dl_err:
        dl_quota = is_quota(dl_err)
        print(f'⚠️ 下市名單抓不到({dl_err})→ 這一棒只有現存股(倖存者偏誤還在,誠實記錄)'
              + (';是額度用完 → 收工時照樣接力,下一棒再補下市那幾檔' if dl_quota else ''))
    syms = base + sorted(dl - set(base))
    if len(syms) < 1500:
        print(f'❌ 母體只有 {len(syms)} 檔(< 1,500)→ UNIVERSE 可能沒做好,⛔ 不跑')
        return 1
    pace = max(0.12, 6.2 / max(1, len(IB.TOKENS)))
    print(f'🗄️ 母體 {len(syms)} 檔(現存 {len(base)} + 2010 後下市 {len(dl - set(base))})・token {len(IB.TOKENS)} 把 ・每次間隔 {pace:.1f} 秒 ・預算 {MAX_MIN:.0f} 分 ・排隊 {QUEUE}', flush=True)
    b0, w0 = others_busy()
    print(f'🛡️ 動態保護:共用金鑰的 {len(SHARED_WF)} 支 workflow ' + (f'正在跑 → {w0}(先等它跑完)' if b0 else (w0 or '目前都沒在跑')), flush=True)
    st_path = OUT / '_status.json'
    try:
        status = json.loads(st_path.read_text(encoding='utf-8'))
    except Exception:
        status = {}
    left_q, more, reason = [], False, ''
    for qi, key in enumerate(QUEUE):
        spec = DATASETS.get(key)
        if not spec:
            print(f'⚠️ 認不得的資料集 {key} → 跳過')
            continue
        if time.time() > deadline - 120:
            more, reason = True, 'time'
            left_q = QUEUE[qi:]
            break
        dd = OUT / key
        dd.mkdir(parents=True, exist_ok=True)
        todo = [s for s in syms if not (dd / f'{s}.json.gz').exists()]
        st = status.setdefault(key, {})
        if not todo:
            print(f'✅ {key}:{len(syms)} 檔都有了')
            st.update({'done': True, 'have': len(syms)})
            continue
        # 🚧 探路:2330(⛔ 別 2,000 檔打完才發現資料集名 / 層級 / 深度不對)
        #    ⑩ 探路前先等輪到我們;額度用完(402/429)⛔ 不是資料集壞掉 → 等,等不到就停手接力
        if wait_turn(deadline) == 'time':
            more, reason, left_q = True, 'time', QUEUE[qi:]
            break
        rows, err, _w = fetch_retry(IB.fm, spec['ds'], '2330', spec['start'], spec['end'], deadline)
        pv = probe_verdict(rows, err)
        if pv == 'quota':
            print(f'⏳ {key} 探路:額度一直用完({spec["ds"]}:{str(err)[:80]})→ ⛔ 不跳過,這一棒停手、接力下一棒再試', flush=True)
            st.update({'probe_quota': TODAY})
            # ⚠️ workflow 只對 reason=time 接力(LIMIT 試跑停下來才不會無限接力)→ 額度暫時用完也走 time
            more, reason, left_q = True, 'time', QUEUE[qi:]
            break
        if pv == 'skip':
            print(f'❌ {key} 探路失敗({spec["ds"]}:{err or "0 列"})→ 這個資料集整個跳過')
            st.update({'probe_err': (err or 'empty')[:120], 'at': TODAY})
            continue
        want = fin_want(spec['ds']) if spec['kind'] == 'long' else None
        pk = pack_price(rows, '2330') if spec['kind'] == 'price' else (pack_long(rows, want) if want is not None else pack_generic(rows))
        first = (pk['k'][0][0] if spec['kind'] == 'price' else pk['d'][0]) if not is_empty(pk) else '?'
        cols = ['o', 'h', 'l', 'c', 'v', 'money'] if spec['kind'] == 'price' else pk['c']
        print(f'🔎 {key} 探路 2330:{len(rows)} 列 ・最早 {first} ・欄位 {cols} ・樣本 {json.dumps(rows[0], ensure_ascii=False)[:160]}', flush=True)
        if want is not None:
            # ⚠️ 2013 年前是舊會計準則(ROC GAAP),科目名可能不一樣 → 每個科目最早出現在哪一季要印出來(⛔ 不憑印象)
            fst = {t: next((d for d, row in zip(pk['d'], pk['v']) if row[pk['c'].index(t)] is not None), None) if t in pk['c'] else None for t in want}
            y0 = pk['d'][0][:4] if pk['d'] else ''
            other = sorted({str(r.get('type')) for r in rows if _d(r.get('date'))[:4] == y0} - set(want))[:25]
            print(f'   科目最早一季:{fst} ・{y0} 年有、但不在清單裡的科目(前 25):{other}', flush=True)
            st.update({'first_by_type': fst})
        st.update({'probe_first': first, 'cols': cols})
        wrote_now, empty_now, waits, n_try = [], 0, 0, 0
        chk_n = chk_hit = 0
        fd, fidx = None, {}
        if spec['check'] == 'fin':
            try:
                fd = json.loads(FIN_DEEP.read_text(encoding='utf-8'))
                fidx = {f: i for i, f in enumerate(fd.get('f') or [])}
            except Exception as e:
                print(f'⚠️ {key}:{FIN_DEEP} 讀不到({type(e).__name__})→ 沒得對表 → 這一棒寫了也不推(⛔ 沒對表 ≠ 對過了)', flush=True)
        stop = None
        for s in todo:
            if n_try >= LIMIT:
                stop = 'limit'
                break
            stop = wait_turn(deadline)                    # 保護時段:短的就地等、長的停手接力(⛔ 不搶排程的額度)
            if stop or time.time() > deadline - 120:
                stop = stop or 'time'
                break
            data, err, w = fetch_retry(IB.fm, spec['ds'], s, spec['start'], spec['end'], deadline)
            waits += w
            if data is None and is_quota(err):            # ⑩ 等到 deadline 還是用完 → 停手接力(⛔ 不把這檔記成失敗)
                stop = 'time'
                break
            time.sleep(pace)
            n_try += 1
            if data is None:
                IB._rec(f'{key}_' + (err or '?')[:14])
                continue
            obj = pack_price(data, s, delisted=(s in dl)) if spec['kind'] == 'price' else (pack_long(data, want) if want is not None else pack_generic(data))
            if is_empty(obj):
                empty_now += 1
            with gzip.open(dd / f'{s}.json.gz', 'wt', encoding='utf-8') as f:
                json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
            wrote_now.append(s)
            if spec['check'] == 'price' and not is_empty(obj):
                kp = KLINES_DIR / f'{s}.json.gz'
                if kp.exists():
                    try:
                        with gzip.open(kp, 'rt', encoding='utf-8') as f:
                            r = check_price(obj, json.load(f))
                        if r is not None:
                            chk_n += 1
                            chk_hit += bool(r)
                    except Exception:
                        pass
            elif spec['check'] == 'fin' and fd and not is_empty(obj):
                a, b = check_fin(obj, (fd.get('s') or {}).get(s), fidx, want)
                if a >= 3:
                    chk_n += 1
                    chk_hit += (b / a >= 0.9)
            elif spec['check'] == 'margin' and not is_empty(obj):
                p = DATA_DIR / f'{s}.json'
                if p.exists():
                    try:
                        a, b = check_margin(obj, json.loads(p.read_text(encoding='utf-8')))
                        if a >= 5:
                            chk_n += 1
                            chk_hit += (b / a >= 0.9)
                    except Exception:
                        pass
            if len(wrote_now) % 100 == 0:
                print(f'   … {key} {len(wrote_now)} 檔 ・{(time.time() - t0) / 60:.0f} 分 ・空 {empty_now} ・等額度 {waits} ・對表 {chk_hit}/{chk_n}', flush=True)
        have = sum(1 for s in syms if (dd / f'{s}.json.gz').exists())
        ne = len(wrote_now) - empty_now
        rate = (chk_hit / chk_n) if chk_n else None
        print(f'📊 {key}:這一棒寫 {len(wrote_now)}(空 {empty_now})・等額度 {waits} ・累計 {have}/{len(syms)}'
              + (f' ・對表 {chk_hit}/{chk_n}({rate:.1%})' if chk_n else ''), flush=True)
        bad = None
        if n_try > 0 and not wrote_now:
            bad = '處理了但一檔都沒寫(金鑰 / 額度 / 資料集名)'
        elif spec['check'] and len(wrote_now) - empty_now >= 300 and chk_n < CHECK_MIN_N:
            bad = f'寫了 {len(wrote_now)} 檔、能對表的只有 {chk_n}(< {CHECK_MIN_N})→ 對表的資料沒拿到(⛔ 沒對表 ≠ 對過了)'
        elif spec['check'] and chk_n >= CHECK_MIN_N and rate < CHECK_MIN_RATE:
            bad = f'對表 {rate:.1%} < {CHECK_MIN_RATE:.0%}(單位 / 欄位 / 接縫不對)'
        elif len(wrote_now) >= 200 and ne / len(wrote_now) < spec['min_nonempty']:
            bad = f'有資料的只有 {ne}/{len(wrote_now)}(< {spec["min_nonempty"]:.0%})'
        if bad:
            for s in wrote_now:
                (dd / f'{s}.json.gz').unlink(missing_ok=True)
            print(f'❌ {key}:{bad} → 這一棒新寫的 {len(wrote_now)} 檔全部刪掉不推,⛔ 不接力這個資料集', flush=True)
            st.update({'fail': bad, 'at': TODAY})
            continue
        st.update({'have': have, 'of': len(syms), 'chk': [chk_hit, chk_n], 'at': TODAY, 'done': have >= len(syms)})
        if stop:
            more, reason = True, stop
            left_q = QUEUE[qi:]
            break
    if dl_quota and not more:                           # ⑩ 下市名單是額度用完才沒拿到 → 照樣接力,下一棒補下市那幾檔
        more, reason, left_q = True, 'time', list(QUEUE)
    st_path.parent.mkdir(parents=True, exist_ok=True)
    st_path.write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding='utf-8')
    if IB.REASON:
        print('   失敗分類:' + ' ・'.join(f'{k}×{v}' for k, v in sorted(IB.REASON.items(), key=lambda x: -x[1])[:10]))
    gh_out(more='1' if more else '0', reason=reason, queue=','.join(left_q) if more else '', minutes=f'{(time.time() - t0) / 60:.0f}')
    return 0


# ── 🧪 selftest ───────────────────────────────────────────────────
def selftest():
    bad = []

    def ok(name, cond, extra=''):
        print(f"  {'✅' if cond else '❌'} {name}{(' ・' + str(extra)[:200]) if not cond else ''}")
        if not cond:
            bad.append(name)

    rows = [{'date': '2015-03-03', 'stock_id': '2330', 'PER': 12.5, 'PBR': 3.1, 'dividend_yield': 2.0, 'note': 'x', 'lim': 49.99},
            {'date': '2015/03/02', 'stock_id': '2330', 'PER': 12.0, 'PBR': '3,050', 'dividend_yield': 2.1, 'note': 'y', 'lim': 49.99},
            {'date': '2015-03-03', 'stock_id': '2330', 'PER': 12.6, 'PBR': 3.2, 'dividend_yield': 2.0, 'note': 'z', 'lim': 49.99}]
    pk = pack_generic(rows)
    ok('① 日期排序、斜線日期、同一天留最後一列', pk['d'] == ['2015-03-02', '2015-03-03'] and pk['v'][1][pk['c'].index('PER')] == 12.6, pk)
    ok('① 字串欄不存、整段一樣的欄不存、千分位數字照讀', 'note' not in pk['c'] and 'lim' not in pk['c'] and pk['v'][0][pk['c'].index('PBR')] == 3050, pk)
    ok('① 空的 → 空包', pack_generic([]) == {'d': [], 'c': [], 'v': []} and is_empty(pack_generic([])))
    # ② price:格式跟 klines_deep 一樣 + 分割回調(1:2 → 舊的價格減半)
    pr = []
    c = 100.0
    for i in range(80):
        d = (date(2015, 1, 5) + timedelta(days=i)).isoformat()
        if i == 40:
            c = c / 2                                      # 第 40 天起 1:2 分割(物理上不可能的單日 −50%)
        pr.append({'date': d, 'open': c, 'max': c * 1.01, 'min': c * 0.99, 'close': c, 'Trading_Volume': 1000, 'Trading_money': int(c * 1000)})
    po = pack_price(pr, '9999')
    ok('② price 格式 {s, dl, k:[[date,o,h,l,c,vol]], m}', set(po) == {'s', 'dl', 'k', 'm'} and len(po['k'][0]) == 6 and len(po['m']) == len(po['k']), po.get('k', [None])[0])
    ok('② 分割回調:分割前的收盤被調成分割後的尺(⛔ 不留斷崖)', abs(po['k'][0][4] - 50.0) < 0.6 and abs(po['k'][-1][4] - 50.0) < 0.6, (po['k'][0][4], po['k'][-1][4]))
    # ③ price 對表:比例是常數 → 一致;比例在變 → 不一致;重疊太短 → 沒得比
    obj = {'k': [[f'2021-01-{i:02d}', 0, 0, 0, 100 + i, 0] for i in range(1, 29)]}
    kd = {'k': [[f'2021-01-{i:02d}', 0, 0, 0, (100 + i) / 2, 0] for i in range(1, 29)]}
    ok('③ 接縫比例 2 倍但是常數 → 一致(klines_deep 有做過分割回調)', check_price(obj, kd) is True)
    kd2 = {'k': [[f'2021-01-{i:02d}', 0, 0, 0, (100 + i) * (1 + i / 100), 0] for i in range(1, 29)]}
    ok('③ 比例一路在變 → 不一致', check_price(obj, kd2) is False)
    ok('③ 重疊 < 20 天 → 沒得比', check_price({'k': obj['k'][:10]}, kd) is None)
    # ④ margin 對表:張數一致才算;單位差 1,000 倍 → 對不上
    mp = {'d': ['2023-05-22', '2023-05-23', '2023-05-24'], 'c': ['MarginPurchaseTodayBalance', 'ShortSaleTodayBalance'], 'v': [[1000, 5], [1010, 6], [990, 7]]}
    dr = [{'date': '2023/05/22', 'margin_balance': 1000}, {'date': '2023/05/23', 'margin_balance': 1011}, {'date': '2023/05/24', 'margin_balance': 0}]
    ok('④ 融資對表:兩邊都有才比、1 張或 1% 以內算一致', check_margin(mp, dr) == (2, 2), check_margin(mp, dr))
    mp2 = dict(mp, v=[[x[0] * 1000, x[1]] for x in mp['v']])
    ok('④ 單位差 1,000 倍 → 對不上', check_margin(mp2, dr) == (2, 0), check_margin(mp2, dr))
    # ④b 季報:長表 → 只留清單裡的科目;跟 fin_deep 重疊那幾季逐欄比(同一個上游 → 值要一樣)
    want = fin_want('TaiwanStockFinancialStatements')
    ok('④b 季報科目清單直接讀 fin_backfill.WANT(Revenue → rev、EPS → eps)', want.get('Revenue') == 'rev' and want.get('EPS') == 'eps', want)
    lr = [{'date': '2018-03-31', 'type': 'Revenue', 'value': 1000}, {'date': '2018-03-31', 'type': 'EPS', 'value': 1.5},
          {'date': '2018-03-31', 'type': 'OtherThing', 'value': 9}, {'date': '2017-12-31', 'type': 'Revenue', 'value': '900'},
          {'date': '2018-06-30', 'type': 'Revenue', 'value': 1100}, {'date': '2018-06-30', 'type': 'EPS', 'value': 1.6}]
    lp = pack_long(lr, want)
    ok('④b 長表 → {d, c, v}、清單外的科目不存、字串數字照讀', lp['d'] == ['2017-12-31', '2018-03-31', '2018-06-30'] and 'OtherThing' not in lp['c'] and lp['v'][0][lp['c'].index('Revenue')] == 900, lp)
    fdf = ['inv', 'cogs', 'capex', 'dep', 'ocf', 'rev', 'eq', 'cap', 'eps']
    fidx = {f: i for i, f in enumerate(fdf)}
    rec = {'2018-03-31': [None, None, None, None, None, 1000, None, None, 1.5], '2018-06-30': [None, None, None, None, None, 1100, None, None, 1.6]}
    ok('④b 季報對表:重疊兩季 4 格全對', check_fin(lp, rec, fidx, want) == (4, 4), check_fin(lp, rec, fidx, want))
    lp2 = dict(lp, v=[[x * 1000 if isinstance(x, (int, float)) else x for x in row] for row in lp['v']])
    ok('④b 單位差 1,000 倍 → 對不上', check_fin(lp2, rec, fidx, want)[1] == 0, check_fin(lp2, rec, fidx, want))
    ok('④b 沒有 fin_deep 那一檔 → 沒得比(0, 0)', check_fin(lp, None, fidx, want) == (0, 0))
    # ⑤ 保護時段
    utc = timezone.utc
    ins, w, nx = protect_state(datetime(2026, 10, 20, 9, 0, tzinfo=utc))       # 週二 09:00 = daily_miner
    ok('⑤ 週二 09:00 在保護時段、要等到 14:46', ins and abs(w - (14 * 60 + 46 - 9 * 60)) < 1, (ins, w))
    ins, w, nx = protect_state(datetime(2026, 10, 20, 15, 0, tzinfo=utc))
    ok('⑤ 週二 15:00 不在,下一個是 16:00(macro_cron)', (not ins) and abs(nx - 60) < 1, (ins, nx))
    ins, w, nx = protect_state(datetime(2026, 10, 25, 9, 0, tzinfo=utc))       # 週日
    ok('⑤ 週日 09:00 不在保護時段', not ins, (ins, w))
    ins, w, nx = protect_state(datetime(2026, 10, 24, 21, 40, tzinfo=utc))     # 週六 21:40 dividend_sweep
    ok('⑤ 週六 21:40 在保護時段(dividend_sweep)', ins, (ins, w))
    # ⑥ 每一支共用金鑰的排程 cron 都要落在保護時段裡(⛔ 改了 cron 沒回來改 PROTECT 就紅)
    import re
    wf = ROOT / '.github' / 'workflows'
    miss, seen = [], 0
    for name in ('daily_miner.yml', 'fund_sweep.yml', 'pe_band.yml', 'macro_cron.yml', 'dividend_sweep.yml', 'tdcc_sweep.yml'):
        try:
            txt = (wf / name).read_text(encoding='utf-8')
        except Exception:
            miss.append(f'{name} 讀不到')
            continue
        for m in re.finditer(r"cron:\s*'([^']+)'", txt):
            mi, hr, _dom, _mon, dow = m.group(1).split()[:5]
            dows = set()
            for part in dow.split(','):
                if part == '*':
                    dows |= set(range(1, 8))
                elif '-' in part:
                    a, b = part.split('-')
                    dows |= set(range(int(a), int(b) + 1))
                else:
                    dows.add(7 if int(part) == 0 else int(part))
            for h in hr.split(','):
                for dw in sorted(dows):
                    seen += 1
                    base = datetime(2026, 10, 19, tzinfo=utc) + timedelta(days=dw - 1)   # 2026-10-19 是週一
                    t = base.replace(hour=int(h), minute=int(mi)) + timedelta(minutes=1)
                    if not protect_state(t)[0]:
                        miss.append(f'{name} {m.group(1)} 週{dw} {h}:{mi}')
    ok('⑥ 共用金鑰排程的每一個 cron 都在保護時段裡', seen >= 15 and not miss, f'seen={seen} miss={miss[:6]}')
    # ⑦ 母體
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        u = Path(td) / 'u.txt'
        u.write_text('2330\n0050\n2330\n1101\n00878\nabcd\n 2317 \n6488\n', encoding='utf-8')
        ok('⑦ 母體:只留 4 碼、不收 0 開頭、去重保序', read_universe(u) == ['2330', '1101', '2317', '6488'], read_universe(u))
    # ⑧ 登記表 / workflow 一致
    ok('⑧ 預設排隊都在登記表裡', all(k in DATASETS for k in QUEUE) and {'price10', 'fis10', 'fbs10', 'fcf10'} <= set(QUEUE))
    wtxt = (wf / 'stock_deep_backfill.yml').read_text(encoding='utf-8') if (wf / 'stock_deep_backfill.yml').exists() else ''
    ok('⑧ workflow 存在、接力叫的是自己、有 actions: write', 'gh workflow run stock_deep_backfill.yml' in wtxt and 'actions: write' in wtxt)
    ok('⑧ workflow ⛔ 不加排程(手動 + 接力)', 'schedule:' not in wtxt)
    ok('⑧ workflow 預設排隊 = 程式預設排隊(⛔ 兩邊各寫一份會漏)', ("default: '" + ','.join(QUEUE) + "'") in wtxt or bool(os.getenv('QUEUE')))
    ok('⑧ workflow 有還原 fin_deep(季報對表用)', 'origin fin_deep' in wtxt)
    # ⑨ 動態保護(2026-10-20:GitHub 排程晚 4 小時 → pe_band 撞上補挖)
    import inspect
    _BUSY.update(t=0.0, v=(False, ''), fail=0, said='')
    b, w = others_busy(fetch=lambda st: [{'path': '.github/workflows/pe_band.yml'}] if st == 'in_progress' else [])
    ok('⑨ 共用金鑰的 pe_band 正在跑 → 暫停', b and 'pe_band.yml' in w, (b, w))
    b, w = others_busy(fetch=lambda st: [{'path': '.github/workflows/daily_miner.yml@refs/heads/main'}] if st == 'queued' else [])
    ok('⑨ daily_miner 排隊中(還沒開跑)也算 → 暫停', b and 'daily_miner.yml(queued)' in w, (b, w))
    b, w = others_busy(fetch=lambda st: [{'path': '.github/workflows/deploy_pages.yml'}, {'path': '.github/workflows/stock_deep_backfill.yml'}])
    ok('⑨ 不相干的 workflow(含補挖自己)在跑 → 照抓', not b, (b, w))
    b, w = others_busy(fetch=lambda st: [])
    ok('⑨ 沒人在跑 → 照抓', not b, (b, w))

    def _boom(st):
        raise RuntimeError('api down')
    _BUSY.update(fail=0)
    r1, r2, r3 = others_busy(fetch=_boom), others_busy(fetch=_boom), others_busy(fetch=_boom)
    ok('⑨ 查不到 → 先保守等;連 3 次查不到 → 退回只靠時段表並明說(⛔ 不靜默)',
       r1[0] and r2[0] and not r3[0] and '時段表' in r3[1], (r1, r2, r3))
    _BUSY.update(t=0.0, v=(False, ''), fail=0, said='')
    need = []
    for f in sorted(wf.glob('*.yml')):
        t = f.read_text(encoding='utf-8')
        if f.name != 'stock_deep_backfill.yml' and 'FINMIND_TOKENS' in t \
                and re.search(r'^\s*(schedule|workflow_run|repository_dispatch)\s*:', t, re.M):
            need.append(f.name)
    ok('⑨ 會自動跑又吃 FINMIND_TOKENS 的 workflow 全在動態保護清單(⛔ 新增了沒加就紅)',
       len(need) >= 6 and set(need) <= set(SHARED_WF), (need, SHARED_WF))
    ok('⑨ 抓資料的迴圈真的有問動態保護(⛔ 只寫函式沒接上 = 陷阱 #37)',
       'others_busy' in inspect.getsource(wait_turn) and inspect.getsource(main).count('wait_turn(deadline)') >= 3)
    # ⑩ 2026-10-20 第 5 棒:額度暫時用完 ≠ 資料集壞掉
    ok('⑩a 探路:有資料 → ok;402 / 429(兩種錯誤格式)→ quota(⛔ 不跳過);名字錯 / 0 列 → skip',
       probe_verdict([{'x': 1}], None) == 'ok' and probe_verdict(None, 'http402:Requests reach the upper limit.') == 'quota'
       and probe_verdict([], 'http429:too many') == 'quota' and probe_verdict(None, '第4把/HTTP 402/quota/Requests reach the upper limit.') == 'quota'
       and probe_verdict(None, 'http400:dataset not found') == 'skip' and probe_verdict([], None) == 'skip' and probe_verdict(None, 'empty') == 'skip',
       [probe_verdict(None, 'http402:x'), probe_verdict(None, 'http400:x')])
    seq = [(None, 'http402:limit'), (None, 'http402:limit'), ([{'d': 1}], None)]
    calls, slept = [], []
    def _fm(ds, sym, start, end_date=None, timeout=90):
        calls.append(sym); return seq[min(len(calls) - 1, len(seq) - 1)]
    rr, ee, ww = fetch_retry(_fm, 'X', '2330', 'a', 'b', deadline=1e12, sleep=slept.append, clock=lambda: 0)
    ok('⑩b 額度用完 → 等 5 分鐘再試,第三次拿到(等了 2 次、每次 300 秒)', rr == [{'d': 1}] and ww == 2 and slept == [300, 300] and len(calls) == 3, (rr, ww, slept))
    calls.clear(); slept.clear(); seq[:] = [(None, 'http402:limit')]
    rr, ee, ww = fetch_retry(_fm, 'X', '2330', 'a', 'b', deadline=400, sleep=slept.append, clock=lambda: 0)   # 再等 5 分就過 deadline−2 分
    ok('⑩c 快到 deadline → ⛔ 不再等(交給接力),回 quota 錯誤', rr is None and is_quota(ee) and slept == [] and len(calls) == 1, (ee, slept, calls))
    calls.clear(); slept.clear(); seq[:] = [(None, 'http400:bad dataset')]
    rr, ee, ww = fetch_retry(_fm, 'X', '2330', 'a', 'b', deadline=1e12, sleep=slept.append, clock=lambda: 0)
    ok('⑩d 不是額度問題(400)→ 不等、直接回', rr is None and ee.startswith('http400') and slept == [] and len(calls) == 1, (ee, slept))
    free = datetime(2026, 10, 20, 23, 0, tzinfo=timezone.utc)           # 週二 23:00 UTC:不在任何保護時段
    seqb = [(True, 'pe_band.yml(in_progress)'), (False, '')]
    slept.clear(); _BUSY.update(said='')
    r = wait_turn(1e12, sleep=slept.append, clock=lambda: 0, now_fn=lambda: free, busy=lambda: seqb.pop(0) if len(seqb) > 1 else seqb[0])
    ok('⑩e 共用金鑰的 pe_band 在跑 → 等一輪(5 分)→ 它跑完了 → 輪到我們(None)', r is None and slept == [BUSY_WAIT_MIN * 60], (r, slept))
    inside_long = datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)      # 週二 09:00 UTC:daily_miner 那段長保護
    slept.clear()
    r = wait_turn(1e12, sleep=slept.append, clock=lambda: 0, now_fn=lambda: inside_long, busy=lambda: (False, ''))
    ok('⑩f 在長的保護時段裡 → 回 time(停手接力,⛔ 不硬抓)', r == 'time' and slept == [], (r, slept))
    src = inspect.getsource(main)
    i_wait, i_probe = src.find('wait_turn(deadline)', src.find('探路:2330')), src.find('fetch_retry(IB.fm, spec[\'ds\'], \'2330\'')
    ok('⑩g 探路之前先 wait_turn、探路用 fetch_retry、quota 走接力(⛔ 不寫 probe_err)',
       0 < i_wait < i_probe and "if pv == 'quota'" in src and src.find("probe_err", src.find("if pv == 'quota'")) > src.find("if pv == 'skip'"),
       (i_wait, i_probe))
    ok('⑩h 下市名單額度用完 → 重試 + 收工時照樣接力', 'dl_quota' in src and src.count('is_quota(dl_err)') >= 2)
    ok('⑨ workflow 有把 GH_TOKEN 傳給補挖那一步(沒有就只能退回時段表)', wtxt.count('GH_TOKEN: ${{ github.token }}') >= 2)
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(main())
