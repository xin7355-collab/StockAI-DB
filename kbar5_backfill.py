#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📼⏪ 5 分 K **歷史回補**(永豐 Shioaji api.kbars)→ 獨立分支 `kbar5_deep` 的 kbar5_deep/{YYYY-MM}.json.gz
──────────────────────────────────────────────────────────────────────────
為什麼要有這支(V77.5.1,使用者:「5分k資料歷史挖礦,我要馬上就能測試的」):
  `kbar5` 分支從 2026-05-18 才開始,只有 ~90 天 → 當沖規則的「逐年同向 / 去最好年」天生過不了,
  原本要等到 2027-02。🚨 而那個「只能回溯 81~120 天」**從來沒有被量過** —— 它等於我們自己
  要的窗口(orb_probe / intraday_probe / kbar5_miner 全部是 `today - 120 天`),
  跟「集保 13 週」「融資只有 55 天」是同一個錯(第三次)。→ `--depth` 模式先量真正的地板。

⛔ 五個刻意的設計(改之前先讀):
  ① **獨立分支 `kbar5_deep`**,⛔ 不寫進 `kbar5`:
     - `kbar5_miner.KEEP_MONTHS=12` 的滾動修剪會把一年以前的月檔刪掉
     - 每日累積跟回補不搶同一個分支(兩支都 push 就要處理衝突)
     - 兩份各存各的分支 → ⛔ 誰都不會覆蓋誰(回算鐵則第 2 條「實跑寫入優先」自動成立);
       探針讀的時候 `KBAR5_DIR=<kbar5_deep>:<kbar5>`(同一種母體優先,每日那份只補 deep 沒有的日子)
  ② 🧭 **母體 = 每月初重選一次**(使用者選的):月初第一個交易日,**只用前 60 個交易日**的
     平均成交值(收盤 × 量)取前 100 檔上市櫃個股,整個月固定。
     → 同一檔整個月天天都有分 K(測得動「昨天分K趨勢 × 今天開盤」這類規則);
     → 用 klines_deep(含 2021 後**下市股**)算,⛔ 沒有偷看未來(selftest ① 釘住)。
     名單寫進每個月檔的 `univ`,探針才算得出「這檔在窗口內有幾天」。
  ③ **重用 kbar5_miner 的 fetch_k5 / agg5 / split_days / pack**,⛔ 不複製第二份(兩份實作一定會漂移)。
  ④ **可中斷、可接續**:每個月檔記 `done`(抓過的)與 `miss`(找不到合約/沒資料的)。
     月 × 檔 是最小單位;重跑時跳過已完成的。由新到舊抓 → 最近一年最先可測。
  ⑤ **兩道預算**:時間(`KBAR5B_BUDGET_MIN`,到了就寫檔、exit 0,同 fin_backfill)
     + 流量(`api.usage()` 超過 85% 就停;⛔ 不可把使用者的日流量吃光,盤中 live_snapshot 要用)。
     停下來的原因寫進 $GITHUB_OUTPUT(time → workflow 自己接力;traffic → 等隔天)。

⚠️ 母體的偏誤(必須誠實揭露,寫在每個月檔的 `bias`):
  「前 60 日成交值前 100」= 只收**夠熱**的股票;名單每月變 → 某檔在歷史上會斷斷續續(以月為單位)。
  下市股若 Shioaji 已沒有合約就抓不到 → 殘留一部分倖存者偏誤(每月的 miss 清單記著)。

需 GitHub Secrets:SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY(只做行情,⛔ 不需憑證、⛔ 不下單)
本機:`python3 kbar5_backfill.py --selftest`(純函式,不打網路)
"""
import os
import sys
import json
import gzip
import glob
import time
from datetime import datetime, timezone, timedelta, date

import kbar5_miner as K   # ⛔ fetch_k5 / agg5 / split_days / pack 只有一份

TW = timezone(timedelta(hours=8))
OUT_DIR = 'kbar5_deep'
LEAD_DIR = 'kbar5_lead'  # V78.4.6 領頭羊母體(top100 沒收到的那幾檔)→ 另一個分支
LEAD_N, LEAD_LB, LEAD_PRE = 100, 20, 40   # 每天 20 日平均成交額前 100 的聯集;往前多含 40 個交易日
DEEP_DIR = 'klines_deep'
LU_DIR = 'kbar5_lu'      # V78.6.6 漲停隔天的 5 分 K(lu_split_probe 驗 09:05 進場用)→ 另一個分支
DATA_K_DIR = 'data'      # origin/data 的 data/{sym}.json(每天更新;klines_deep 只到最後一次回算)
LU_FROM = '2021-05-01'   # 同 kbar5_deep 的地板(2021-04 前面不夠 60 天算不出名單,這裡對齊)
LU_GAP = -1.0            # 隔天開低 ≤ −1% 的先抓(lu_split_probe 唯一站得住的那一桶)
TOP_N = 100
LOOKBACK = 60           # 月初之前幾個交易日的平均成交值
MIN_STOCKS = 20         # 一個月抓到 < 20 檔 → 不寫(自我修復)
USAGE_STOP = 0.85       # 流量用到 85% 就停
MIN_GAP_S = 0.12        # 兩次 kbars 之間至少隔幾秒(Shioaji 行情查詢 5 秒 50 次)
DEPTH_DAYS = [30, 180, 365, 730, 1095, 1460, 1825, 2190, 2600]


def _line(s):
    print(s, flush=True)


def _is_stock(code):
    return len(code) == 4 and code.isdigit()


# ── ② 母體:每月初、只用前 60 個交易日 ──────────────────────────────
def load_turnover(deep_dir=DEEP_DIR):
    """{sym: {date: 成交值}}(只收 4 位數個股;ETF 不收,同 dt 探針)。
    klines_deep/{sym}.json.gz = {s, dl, k:[[YYYY-MM-DD, o, h, l, c, v], …]}"""
    tv = {}
    for p in sorted(glob.glob(os.path.join(deep_dir, '*.json.gz'))):
        sym = os.path.basename(p).split('.')[0]
        if not _is_stock(sym):
            continue
        try:
            with gzip.open(p, 'rt', encoding='utf-8') as f:
                j = json.load(f)
        except Exception as e:
            _line(f'  ⚠️ {p} 讀不起來({type(e).__name__})→ 當成沒有這檔')
            continue
        m = {}
        for r in j.get('k') or []:
            try:
                d, c, v = str(r[0])[:10].replace('/', '-'), float(r[4]), float(r[5])
            except Exception:
                continue
            if c > 0 and v > 0:
                m[d] = c * v
        if m:
            tv[sym] = m
    return tv


def build_universe(tv, n=TOP_N, lookback=LOOKBACK):
    """{YYYY-MM: [sym…]}。交易日曆 = 所有股票出現過的日期聯集。
    ⛔ 月初那一天**不算進去**(它就是被判斷的那一天之後 —— 陷阱 #43 的時間版)。"""
    cal = sorted({d for m in tv.values() for d in m})
    first = {}
    for i, d in enumerate(cal):
        first.setdefault(d[:7], i)
    out = {}
    for mon, i0 in sorted(first.items()):
        if i0 < lookback:
            continue                          # 前面不夠 60 天 → 這個月不選(⛔ 不拿更短的湊)
        win = cal[i0 - lookback:i0]
        score = []
        for sym, m in tv.items():
            s = sum(m.get(d, 0.0) for d in win)
            if s > 0:
                score.append((s / lookback, sym))
        score.sort(key=lambda x: (-x[0], x[1]))
        out[mon] = [s for _, s in score[:n]]
    return out


def build_universe_lead(tv, base_u, n=LEAD_N, lb=LEAD_LB, pre=LEAD_PRE):
    """V78.4.6 {YYYY-MM: [sym…]} = 該月每個交易日「前 lb 日(含當天)平均成交額前 n」的聯集,
    再往前多含 pre 個交易日(池內買進、掉出池後才賣的那幾檔),⛔ 減掉 base_u(kbar5_deep 那個月已有的)。
    ⚠️ 這是**事後聯集**(同一個月後面的日子也算進來)→ 只拿來替領頭羊**既有成交**取 5 分 K 價,
    ⛔ 不可當母體做選股回測(bias 寫在月檔)。只算 base_u 有的月份(klines_deep 之前算不出來)。"""
    cal = sorted({d for m in tv.values() for d in m})
    idx = {d: i for i, d in enumerate(cal)}
    syms = sorted(tv)
    top = [None] * len(cal)
    run = {s: 0.0 for s in syms}
    for i, d in enumerate(cal):
        for s in syms:
            m = tv[s]
            run[s] += m.get(d, 0.0)
            if i >= lb:
                run[s] -= m.get(cal[i - lb], 0.0)
        if i >= lb - 1:
            sc = sorted(((v, s) for s, v in run.items() if v > 0), key=lambda x: (-x[0], x[1]))
            top[i] = {s for _, s in sc[:n]}
    out = {}
    for mon, base in sorted(base_u.items()):
        a, b = month_range(mon)
        ins = [i for i, d in enumerate(cal) if a <= d <= b]
        if not ins:
            continue
        u = set()
        for i in range(max(0, ins[0] - pre), ins[-1] + 1):
            if top[i]:
                u |= top[i]
        extra = sorted(u - set(base))
        if extra:
            out[mon] = extra
    return out


def month_range(mon):
    y, m = int(mon[:4]), int(mon[5:7])
    a = date(y, m, 1)
    b = date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)
    return a.isoformat(), b.isoformat()


# ── 月檔(同 kbar5 格式:d[date] = {syms, k, bf:1})────────────────────
def _mpath(mon, out_dir=OUT_DIR):
    return os.path.join(out_dir, f'{mon}.json.gz')


def load_month(mon, out_dir=OUT_DIR):
    p = _mpath(mon, out_dir)
    if not os.path.exists(p):
        return None
    with gzip.open(p, 'rt', encoding='utf-8') as f:     # ⛔ 壞檔不可靜默當成沒有(陷阱 #18)→ 直接炸
        j = json.load(f)
    if not isinstance(j, dict) or not isinstance(j.get('d'), dict):
        raise ValueError(f'{p} 格式不對')
    return j


def blank_month(mon, univ):
    return {'month': mon, 'univ': list(univ), 'done': [], 'miss': [], 'd': {}}


def add_sym(month, sym, by_date):
    """把一檔一個月的 5 分 K 塞進月檔。⛔ 已經有的 (日, 檔) 不覆蓋(冪等,重跑不會變)。
    回傳這次新增幾天。"""
    n = 0
    for d, packed in sorted(by_date.items()):
        if d[:7] != month['month'] or not packed:
            continue
        day = month['d'].setdefault(d, {'syms': [], 'k': {}, 'bf': 1})
        if sym in day['k']:
            continue
        day['k'][sym] = packed
        day['syms'] = sorted(day['k'].keys())
        n += 1
    if sym not in month['done']:
        month['done'].append(sym)
    return n


def todo_syms(month):
    got = set(month.get('done') or []) | set(m.rsplit(':', 1)[0] for m in (month.get('miss') or []))   # V78.6.6 rsplit:lu 的單位是 'D|sym'
    return [s for s in month['univ'] if s not in got]


def save_month(month, out_dir=OUT_DIR):
    os.makedirs(out_dir, exist_ok=True)
    days = month['d']
    payload = {
        'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'month': month['month'],
        'bar_min': K.BAR_MIN,
        'universe': month.get('universe') or 'monthly_top100_by_turnover60',
        'bias': month.get('bias') or ('名單 = 每月第一個交易日、只用「前 60 個交易日平均成交值」取前 100 檔上市櫃個股,整個月固定'
                 '(⛔ 沒有偷看未來)。⚠️ 只收夠熱的股票;名單每月變;Shioaji 已沒有合約的下市股抓不到'
                 '(清單在 miss)→ 殘留一部分倖存者偏誤。回測時一律先算「這檔在窗口內有幾天」。'),
        'fmt': 'k[sym] = [[hm(台北牆鐘分鐘,09:00=540), open, high, low, close, volume], …];bf=1 = 歷史回補',
        'univ': month['univ'],
        'done': sorted(month['done']),
        'miss': sorted(month['miss']),
        'complete': not todo_syms(month),
        'days': len(days),
        'd': days,
    }
    with gzip.open(_mpath(month['month'], out_dir), 'wt', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    return payload


# ── V78.6.6 🟥 漲停隔天(lu)母體 ─────────────────────────────────────
#   使用者 2026-10-08:「挖礦」—— lu_split_probe 的 09:05 進場只驗得到熱門股(kbar5_deep 母體),
#   而「昨天鎖漲停、今天開低」那一桶大多不是熱門股 → 補「每一次鎖漲停的隔天」那一天的 5 分 K。
#   ⛔ 單位是 (隔天日期, 檔),⛔ 不是 (月, 檔) —— 一次只抓一天(整個月抓 21 倍流量,只用到 1 天)。
#   ⛔ 兩個 K 線來源**各自**判鎖漲停再取聯集(klines_deep 是 FinMind 原始價、data 是官方價;
#      混成一條會在接縫製造假漲停,陷阱 #46)。
def _lim_of(d):
    return 0.07 if d < '2015-06-01' else 0.10


def _lock_up(pc, h, c, d):
    """收盤鎖漲停:收盤 ≥ 前收 ×(1+漲跌幅−1%)且收在最高(同 downday_lu_probe.lockUp)。
    ⛔ 上限 1+漲跌幅+1%:比值更大的是分割 / 減資 / 資料斷崖,不是漲停。"""
    lim = _lim_of(d)
    return pc > 0 and c >= pc * (1 + lim - 0.01) and c <= pc * (1 + lim + 0.01) and c >= h - 1e-9


def load_kseries(deep_dir=DEEP_DIR, data_dir=DATA_K_DIR):
    """[{sym: [(d, o, h, c), …]}, …] —— 每個來源一份(⛔ 不混)。只收 4 位數個股。"""
    out = []
    a = {}
    for p in sorted(glob.glob(os.path.join(deep_dir, '*.json.gz'))):
        sym = os.path.basename(p).split('.')[0]
        if not _is_stock(sym):
            continue
        try:
            with gzip.open(p, 'rt', encoding='utf-8') as f:
                j = json.load(f)
            rows = [(str(r[0])[:10].replace('/', '-'), float(r[1]), float(r[2]), float(r[4])) for r in (j.get('k') or []) if r and float(r[4]) > 0]
        except Exception:
            continue
        if rows:
            a[sym] = sorted(rows)
    out.append(a)
    b = {}
    for p in sorted(glob.glob(os.path.join(data_dir, '*.json'))):
        sym = os.path.basename(p)[:-5]
        if not _is_stock(sym):
            continue
        try:
            j = json.load(open(p, encoding='utf-8'))
            rows = [(str(r['date'])[:10].replace('/', '-'), float(r['open']), float(r['high']), float(r['close']))
                    for r in j if isinstance(r, dict) and r.get('close') and float(r['close']) > 0]
        except Exception:
            continue
        if rows:
            b[sym] = sorted(rows)
    out.append(b)
    return out


def lu_units(series_list, frm=LU_FROM, today=None, after_close=True):
    """{(隔天日期, sym): 隔天開盤跳空 %}。條件:第 i 天收盤鎖漲停、第 i+1 根就是**下一個交易日**(停牌的不算)。
    交易日曆 = 所有來源所有股票日期的聯集。today 那一天收盤前 ⛔ 不收(盤中抓到的半天 K 會被冪等鎖死)。"""
    cal = sorted({r[0] for ser in series_list for rows in ser.values() for r in rows})
    nxt = {d: cal[i + 1] for i, d in enumerate(cal[:-1])}
    out = {}
    for ser in series_list:
        for sym, rows in ser.items():
            for i in range(1, len(rows) - 1):
                d, o, h, c = rows[i]
                if d < frm or not _lock_up(rows[i - 1][3], h, c, d):
                    continue
                nd, no = rows[i + 1][0], rows[i + 1][1]
                if nxt.get(d) != nd:
                    continue
                if today and (nd > today or (nd == today and not after_close)):
                    continue
                out.setdefault((nd, sym), round((no / c - 1) * 100, 2) if no > 0 else None)
    return out


def lu_jobs(units, have):
    """排序好的待抓清單 [(D, sym, gap)]:⭐ 隔天開低 ≤ LU_GAP 的先抓,其餘在後;同一組由新到舊。
    ⛔ have(kbar5_deep / kbar5_lead / kbar5 已經有的 (日, 檔))不重抓。"""
    js = [(d, s, g) for (d, s), g in units.items() if (d, s) not in have]
    return sorted(js, key=lambda x: (0 if (x[2] is not None and x[2] <= LU_GAP) else 1, -int(x[0].replace('-', '')), x[1]))


def load_have(dirs):
    """{(日, 檔)} —— 這幾個分支已經有的 5 分 K。"""
    have = set()
    for dd in dirs:
        for p in glob.glob(os.path.join(dd, '*.json.gz')):
            try:
                with gzip.open(p, 'rt', encoding='utf-8') as f:
                    j = json.load(f)
            except Exception:
                continue
            for d, v in (j.get('d') or {}).items():
                for sym in (v.get('k') or {}):
                    have.add((d, sym))
    return have


def add_unit(month, d, sym, packed):
    """lu:只塞那一天那一檔。冪等(已有就不覆蓋)。單位記在 done('D|sym')。回傳 1/0。"""
    u = f'{d}|{sym}'
    n = 0
    if packed and d[:7] == month['month']:
        day = month['d'].setdefault(d, {'syms': [], 'k': {}, 'bf': 1})
        if sym not in day['k']:
            day['k'][sym] = packed
            day['syms'] = sorted(day['k'].keys())
            n = 1
    if u not in month['done']:
        month['done'].append(u)
    if u not in month['univ']:
        month['univ'].append(u)
    return n


LU_BIAS = ('名單 = 每一次「收盤鎖漲停」(收盤 ≥ 前收 ×1.09 且收在最高;2015-06 前 ×1.06)的**隔天**那一檔那一天,'
           '⛔ 扣掉 kbar5_deep / kbar5_lead / kbar5 已經有的(探針讀的時候要 mergeSyms 合併)。'
           '事件用 klines_deep 與 data 分支各自判、取聯集。⚠️ 只有那一天,⛔ 不是連續序列;'
           'Shioaji 已沒有合約的下市股抓不到(miss)。')


# ── selftest(純函式,⛔ 不打網路)──────────────────────────────────
def _selftest():
    import tempfile
    fails = 0

    def ok(n, c, e=''):
        nonlocal fails
        print(f"{'✅' if c else '❌'} {n}{'' if c else '  ' + str(e)[:200]}")
        if not c:
            fails += 1

    # 交易日曆:2021-01-04 起 90 個平日
    cal, d = [], date(2021, 1, 4)
    while len(cal) < 90:
        if d.weekday() < 5:
            cal.append(d.isoformat())
        d += timedelta(days=1)
    tv = {f'{1000 + i}': {x: float(1000 - i) for x in cal} for i in range(150)}
    # ① 🔮 前視:某檔只在「月初那一天」爆天量 → ⛔ 不可進那個月的名單
    mon_first = next(x for x in cal if x[:7] == '2021-04')
    tv['9998'] = {mon_first: 1e15}
    # ①b 對照:同樣的天量放在月初**前一天** → 一定要進(否則「不進」只是因為它沒資料,沒有鑑別力)
    prev = cal[cal.index(mon_first) - 1]
    tv['9997'] = {prev: 1e15}
    U = build_universe(tv, n=100, lookback=60)
    ok('⓪ 空過守門:算得出 2021-04 的名單', '2021-04' in U and len(U['2021-04']) == 100, list(U)[:5])
    ok('① 🔮 月初那一天的天量 ⛔ 不可進名單(零前視)', '9998' not in U.get('2021-04', []))
    ok('①b 決定性對照:同樣的天量在月初前一天 → 一定進', '9997' in U.get('2021-04', []))
    ok('①c 前面不夠 60 天的月份不選(⛔ 不拿更短的湊)', '2021-01' not in U and '2021-02' not in U)
    ok('①d 只收 4 位數個股', all(len(s) == 4 for s in U['2021-04']))
    tv2 = dict(tv); tv2['00631'] = {x: 1e18 for x in cal}
    ok('①e ETF 不進母體(load_turnover 端就擋;這裡驗 build 端也不會出現 5 碼)',
       all(len(s) == 4 for s in build_universe({k: v for k, v in tv2.items() if _is_stock(k)}, 100, 60)['2021-04']))

    # ② 冪等 + bf + 月份切分
    m = blank_month('2021-04', ['1000', '1001', '1002'])
    bars = {'2021-04-01': [[540, 1, 1, 1, 1, 10]], '2021-04-06': [[540, 2, 2, 2, 2, 20]],
            '2021-05-03': [[540, 9, 9, 9, 9, 90]]}
    n1 = add_sym(m, '1000', bars)
    ok('② 只收這個月的日子(5 月那天 ⛔ 不可混進 4 月檔)', n1 == 2 and '2021-05-03' not in m['d'], n1)
    ok('②b 每一天都標 bf:1', all(v.get('bf') == 1 for v in m['d'].values()))
    n2 = add_sym(m, '1000', {'2021-04-01': [[540, 7, 7, 7, 7, 70]]})
    ok('②c 冪等:同一 (日, 檔) 再塞一次 ⛔ 不覆蓋', n2 == 0 and m['d']['2021-04-01']['k']['1000'][0][1] == 1)
    ok('②d syms 跟 k 的鍵一致', m['d']['2021-04-01']['syms'] == ['1000'])

    # ③ 接續:done / miss 都算處理過
    m['miss'].append('1001:no_contract')
    ok('③ 接續:done 與 miss 都跳過,只剩沒做的', todo_syms(m) == ['1002'], todo_syms(m))

    # ④ 寫檔 → 讀回 → complete 旗標
    with tempfile.TemporaryDirectory() as td:
        p = save_month(m, td)
        ok('④ 還沒做完 → complete=False', p['complete'] is False)
        add_sym(m, '1002', {'2021-04-01': [[540, 3, 3, 3, 3, 30]]})
        p = save_month(m, td)
        back = load_month('2021-04', td)
        ok('④b 做完 → complete=True,讀回一致', p['complete'] is True and back['d']['2021-04-01']['syms'] == ['1000', '1002'])
        ok('④c 檔頭一定帶 bias 與 univ(探針要算「這檔幾天」)', 'bias' in back and back['univ'] == ['1000', '1001', '1002'])
        ok('④d 檔名是 YYYY-MM.json.gz(探針只認這個)', os.path.basename(_mpath('2021-04', td)) == '2021-04.json.gz')
        # 壞檔 ⛔ 不可靜默當成沒有
        with open(_mpath('2021-05', td), 'wb') as f:
            f.write(b'not gzip')
        try:
            load_month('2021-05', td)
            bad_ok = False
        except Exception:
            bad_ok = True
        ok('④e 壞檔要炸,⛔ 不可靜默當成沒有(陷阱 #18)', bad_ok)

    # ⑥ V78.4.6 lead 母體(每天前 n 的聯集 + 往前 pre 天,減掉 top100 已有的)
    cal6, d = [], date(2021, 1, 4)
    while len(cal6) < 120:
        if d.weekday() < 5:
            cal6.append(d.isoformat())
        d += timedelta(days=1)
    tv6 = {f'{2000 + i}': {x: float(100 - i) for x in cal6} for i in range(10)}   # 常駐前段
    m5 = [x for x in cal6 if x[:7] == '2021-05']
    pre_day = cal6[cal6.index(m5[0]) - 10]           # 月初前 10 天(在 pre=40 內)
    far_day = cal6[cal6.index(m5[0]) - 70]           # 月初前 70 天(在 pre 外)
    tv6['3001'] = {pre_day: 1e9}                      # 只在月初前爆量 → 要進(池內買進、掉出池後才賣)
    tv6['3002'] = {far_day: 1e9}                      # 很久以前爆量 → ⛔ 不進
    tv6['3003'] = {m5[-1]: 1e9}                       # 月底才進池 → 要進(事後聯集)
    L6 = build_universe_lead(tv6, {'2021-05': ['2000', '2001']}, n=5, lb=3, pre=40)
    got = set(L6.get('2021-05', []))
    ok('⑥ lead:月初前 40 天內進過池的要收', '3001' in got, sorted(got))
    ok('⑥b lead:pre 窗口外的 ⛔ 不收(決定性對照)', '3002' not in got, sorted(got))
    ok('⑥c lead:top100 已有的要扣掉(⛔ 重抓浪費流量)', '2000' not in got and '2001' not in got and '2002' in got, sorted(got))
    ok('⑥d lead:同月後面才進池的也收(事後聯集)', '3003' in got)
    ok('⑥e lead:base 沒有的月份不算', set(L6) <= {'2021-05'}, list(L6))
    mL = blank_month('2021-05', ['3001']); mL['universe'], mL['bias'] = 'lead_union_amt20', 'X'
    with tempfile.TemporaryDirectory() as td:
        pL = save_month(mL, td)
    ok('⑥f lead 月檔標 universe / bias(⛔ 不可沿用 top100 的說明)', pL['universe'] == 'lead_union_amt20' and pL['bias'] == 'X')

    ok('⑤ month_range 跨年正確', month_range('2021-12') == ('2021-12-01', '2021-12-31') and month_range('2024-02')[1] == '2024-02-29')
    # ⑦ V78.6.6 lu(漲停隔天)
    days7, d = [], date(2024, 1, 2)
    while len(days7) < 12:
        if d.weekday() < 5:
            days7.append(d.isoformat())
        d += timedelta(days=1)
    def ser(closes, highs=None, opens=None, skip=()):
        rows = []
        for i, c in enumerate(closes):
            if i in skip:
                continue
            h = (highs or {}).get(i, c)
            o = (opens or {}).get(i, c)
            rows.append((days7[i], o, h, c))
        return rows
    base = [100.0] * 12
    A = list(base); A[3] = 110.0; A[4] = 108.0          # 第 3 天鎖漲停 → 隔天(第 4 天)要收,開 105 = −4.55%
    B = list(base); B[3] = 110.0                          # 收在 110 但最高 112 → 沒鎖住 ⛔ 不收
    C = list(base); C[3] = 200.0                          # ×2 = 分割 / 斷崖 ⛔ 不收
    Dd = list(base); Dd[3] = 110.0                        # 鎖住但隔天停牌(第 4 天沒有 K)⛔ 不收
    src1 = {'1001': ser(A, opens={4: 105.0}), '1002': ser(B, highs={3: 112.0}), '1003': ser(C), '1004': ser(Dd, skip=(4,)),
            '1005': ser(base)}
    U7 = lu_units([src1], frm='2024-01-01')
    ok('⑦ lu:鎖漲停的隔天要收(單位是隔天日期)', (days7[4], '1001') in U7, sorted(U7))
    ok('⑦b lu:隔天開盤跳空算對(105 vs 110 = −4.55%)', U7.get((days7[4], '1001')) == -4.55, U7.get((days7[4], '1001')))
    ok('⑦c lu:收盤不在最高(沒鎖住)⛔ 不收', not any(s_ == '1002' for _, s_ in U7))
    ok('⑦d lu:×2 斷崖 ⛔ 不是漲停', not any(s_ == '1003' for _, s_ in U7))
    ok('⑦e lu:隔天停牌(下一根不是下一個交易日)⛔ 不收', not any(s_ == '1004' for _, s_ in U7))
    ok('⑦f lu:FROM 之前 ⛔ 不收', not lu_units([src1], frm='2024-02-01'))
    ok('⑦g lu:今天收盤前 ⛔ 不收(盤中半天 K 會被冪等鎖死)', not lu_units([src1], frm='2024-01-01', today=days7[4], after_close=False)
       and (days7[4], '1001') in lu_units([src1], frm='2024-01-01', today=days7[4], after_close=True))
    src2 = {'1001': ser(base)}                             # 另一個來源沒有那次漲停 → 聯集仍要收
    ok('⑦h lu:兩個來源各自判、取聯集', (days7[4], '1001') in lu_units([src2, src1], frm='2024-01-01'))
    E = list(base); E[6] = 110.0; E[7] = 112.0
    src3 = {'1006': ser(E, opens={7: 111.0})}
    U8 = lu_units([src1, src3], frm='2024-01-01')
    J = lu_jobs(U8, have={(days7[4], '1001')})
    ok('⑦i lu:已經有的 (日, 檔) ⛔ 不重抓', all(not (x[0] == days7[4] and x[1] == '1001') for x in J), J)
    J2 = lu_jobs(U8, have=set())
    ok('⑦j lu:開低 ≤ −1% 的先抓(就算日期比較舊)', [x[1] for x in J2][:1] == ['1001'], J2)
    mm = blank_month(days7[4][:7], [])
    n_a = add_unit(mm, days7[4], '1001', [[540, 1, 1, 1, 1, 1]])
    n_b = add_unit(mm, days7[4], '1001', [[540, 9, 9, 9, 9, 9]])
    mm['miss'].append(f'{days7[7]}|1006:empty'); mm['univ'].append(f'{days7[7]}|1006')
    ok('⑦k lu:add_unit 冪等、只塞那一天;done/miss 都算做過(todo 是空的)',
       n_a == 1 and n_b == 0 and mm['d'][days7[4]]['k']['1001'][0][1] == 1 and todo_syms(mm) == [], todo_syms(mm))
    ok('⑦l top100 的 miss 格式(sym:reason)rsplit 後仍對', todo_syms({'univ': ['1', '2'], 'done': [], 'miss': ['1:no_contract']}) == ['2'])

    print('✅ SELFTEST_PASS' if not fails else f'❌ {fails} 條失敗')
    return 1 if fails else 0


# ── 網路部分 ──────────────────────────────────────────────────────
def _usage(api):
    """回 (bytes, limit_bytes) 或 (None, None)。⛔ 拿不到就明說(不猜)。"""
    try:
        u = api.usage()
        b = getattr(u, 'bytes', None)
        lim = getattr(u, 'limit_bytes', None)
        if b is None and isinstance(u, dict):
            b, lim = u.get('bytes'), u.get('limit_bytes')
        return (int(b) if b is not None else None, int(lim) if lim else None)
    except Exception as e:
        _line(f'  ⚠️ api.usage() 讀不到({type(e).__name__}: {str(e)[:80]})')
        return (None, None)


def _mb(b):
    return '?' if b is None else f'{b / 1048576:.1f}MB'


def _gh_out(**kv):
    p = os.environ.get('GITHUB_OUTPUT')
    if not p:
        return
    with open(p, 'a', encoding='utf-8') as f:
        for k, v in kv.items():
            f.write(f'{k}={v}\n')


def depth_probe(api):
    """🔎 量真正的地板:同一檔(2330)往回每一個距離各抓 **3 天** 的 1 分 K,印根數 + 流量。
    ⛔ 只印不寫。"""
    c = api.Contracts.Stocks['2330']
    today = datetime.now(TW).date()
    b0, lim = _usage(api)
    _line(f'🔎 深度探測(2330)流量起點 {_mb(b0)} / 上限 {_mb(lim)}')
    floor = None
    for dd in DEPTH_DAYS:
        a = today - timedelta(days=dd)
        s, e = a.isoformat(), (a + timedelta(days=6)).isoformat()
        try:
            kb = api.kbars(c, start=s, end=e)
            n = len(list(kb.ts))
            days = sorted({K._t(t).strftime('%Y-%m-%d') for t in kb.ts})
        except Exception as ex:
            n, days = -1, [f'{type(ex).__name__}: {str(ex)[:80]}']
        b1, _ = _usage(api)
        _line(f'  往回 {dd:>4} 天({s}~{e}):{n} 根 1 分K ・{len(days) if n >= 0 else 0} 天 ・'
              f'{days[:1]}…{days[-1:]} ・流量累計 {_mb(b1)}')
        if n > 0:
            floor = s
        time.sleep(MIN_GAP_S)
    _line(f'📌 有資料的最早一段:{floor or "(全部回空)"} —— ⭐ 這才是真的地板,⛔ 不是 81~120 天')
    return floor


def main():
    if '--selftest' in sys.argv:
        sys.exit(_selftest())
    key = os.environ.get('SHIOAJI_API_KEY', '').strip()
    sec = os.environ.get('SHIOAJI_SECRET_KEY', '').strip()
    if not key or not sec:
        print('❌ 缺 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY')
        sys.exit(1)
    # 🔧 inputs.* 在某些觸發下是空字串 → 一律 `or 預設`(check_env_default.py)
    frm = (os.environ.get('KBAR5B_FROM') or '2021-04').strip()
    univ_mode = (os.environ.get('KBAR5B_UNIV') or 'auto').strip().lower()
    if univ_mode not in ('auto', 'top100', 'lead', 'lu'):
        print(f'❌ KBAR5B_UNIV 認不得:{univ_mode}(auto / top100 / lead / lu)')
        sys.exit(1)
    budget_min = float(os.environ.get('KBAR5B_BUDGET_MIN') or 300)
    depth_only = (os.environ.get('KBAR5B_DEPTH_ONLY') or '0').strip() in ('1', 'true', 'yes')
    t0 = time.time()

    import shioaji as sj
    api = sj.Shioaji()
    try:
        try:
            api.login(api_key=key, secret_key=sec, fetch_contract=True)
        except TypeError:
            api.login(api_key=key, secret_key=sec)
        _line('✅ Shioaji 登入成功')
    except Exception as e:
        print(f'❌ Shioaji 登入失敗:{e}')
        sys.exit(1)

    # 🔎 地板只量一次(存 _meta.json;⛔ 不是 .json.gz → 探針不會把它當月檔讀)
    meta_p = os.path.join(OUT_DIR, '_meta.json')
    meta = {}
    if os.path.exists(meta_p):
        try:
            meta = json.load(open(meta_p, encoding='utf-8'))
        except Exception:
            meta = {}
    if depth_only or not meta.get('floor_checked'):
        floor = depth_probe(api)
        os.makedirs(OUT_DIR, exist_ok=True)
        meta.update({'floor': floor, 'floor_checked': datetime.now(TW).strftime('%Y-%m-%d'),
                     'note': 'floor = api.kbars 實測有資料的最早一段(2330);⛔ 不是寫死的 81~120 天'})
        json.dump(meta, open(meta_p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    else:
        floor = meta.get('floor')
        _line(f'🔎 地板沿用 {meta.get("floor_checked")} 量到的:{floor}')
    if depth_only:
        _gh_out(more=0, reason='depth_only')
        api.logout()
        return

    # ── 母體 ──
    tv = load_turnover()
    U_top = build_universe(tv)
    cur_mon = datetime.now(TW).strftime('%Y-%m')

    def _mons(UU):
        ms = sorted([m for m in UU if frm <= m <= cur_mon], reverse=True)     # ⭐ 由新到舊
        return [m for m in ms if month_range(m)[1] >= floor] if floor else ms
    # 🧭 母體模式:top100(舊)/ lead(領頭羊池子裡 top100 沒收到的)/ lu(V78.6.6 漲停隔天)
    #    auto = top100 還沒補完就只做 top100;補完之後 lu → lead 依序做(lu 每天都會長新的,⛔ 不可讓它擋住 lead)
    if univ_mode == 'auto':
        left0 = sum(len(todo_syms(load_month(m) or blank_month(m, U_top[m]))) for m in _mons(U_top))
        modes = ['top100'] if left0 else ['lu', 'lead']
        _line(f'🧭 auto:top100 還剩 {left0} 個(月×檔)→ 這輪依序做 {" → ".join(modes)}')
    else:
        modes = [univ_mode]

    st = {'t0': t0, 'n_req': 0, 'last': 0.0}
    b_start, lim = _usage(api)

    def _gate():
        """回 None = 可以繼續;否則回停下原因。"""
        if (time.time() - st['t0']) / 60 > budget_min:
            return 'time'
        if st['n_req'] % 20 == 0 and lim:
            b, _ = _usage(api)
            if b is not None and b >= lim * USAGE_STOP:
                _line(f'🛑 流量 {_mb(b)} / {_mb(lim)} ≥ {USAGE_STOP:.0%} → 停(⛔ 不把日流量吃光,盤中報價要用)')
                return 'traffic'
        return None

    def _contract(sym):
        try:
            return api.Contracts.Stocks[sym]
        except Exception:
            return None

    def _pace():
        wait = MIN_GAP_S - (time.time() - st['last'])
        if wait > 0:
            time.sleep(wait)
        st['last'] = time.time()
        st['n_req'] += 1

    def run_months(mode):
        U = U_top
        out_dir, univ_name, bias = OUT_DIR, None, None
        if mode == 'lead':
            U = build_universe_lead(tv, U_top)
            out_dir, univ_name = LEAD_DIR, 'lead_union_amt20'
            bias = ('名單 = 該月每個交易日「前 20 日平均成交額前 100」的聯集,再往前多含 40 個交易日,'
                    '⛔ 減掉 kbar5_deep 那個月已有的。⚠️ 事後聯集(同月後面的日子也算進來)→ 只拿來替'
                    '領頭羊既有成交取 5 分 K 價,⛔ 不可當母體做選股回測。')
            _line(f'👑 lead 母體:{len(U)} 個月、共 {sum(len(v) for v in U.values())} 個(月×檔)')
        mons = _mons(U)
        _line(f'🧭 [{mode}] {len(U)} 個月有名單;這輪範圍 {mons[-1] if mons else "-"} ~ {mons[0] if mons else "-"}({len(mons)} 個月)')
        if not mons:
            return 'empty', 0, 0
        reason, n_new = 'done', 0
        for mon in mons:
            month = load_month(mon, out_dir) or blank_month(mon, U[mon])
            if univ_name:
                month['universe'], month['bias'] = univ_name, bias
                if month.get('univ') != U[mon]:      # 聯集只會變大(新的日子)→ 加上去,⛔ 不丟已抓的
                    month['univ'] = sorted(set(month.get('univ') or []) | set(U[mon]))
            elif month.get('univ') != U[mon] and not month.get('done'):
                month['univ'] = U[mon]
            todo = todo_syms(month)
            if not todo:
                continue
            s_, e_ = month_range(mon)
            _line(f'📅 {mon}:名單 {len(month["univ"])} 檔、還要抓 {len(todo)} 檔')
            got_m = 0
            for sym in todo:
                g = _gate()
                if g:
                    reason = g
                    break
                c = _contract(sym)
                if c is None:
                    month['miss'].append(f'{sym}:no_contract')
                    continue
                _pace()
                try:
                    by, nb, _n5 = K.fetch_k5(api, c, s_, e_)
                except Exception as ex:
                    _line(f'  [{sym}] ❌ {type(ex).__name__}: {str(ex)[:100]} → 這輪先跳過(不記 miss,下輪再試)')
                    continue
                if not nb:
                    month['miss'].append(f'{sym}:empty')
                    continue
                n_new += add_sym(month, sym, by)
                got_m += 1
            n_done = len(month['done'])
            if n_done >= MIN_STOCKS or not todo_syms(month):
                p = save_month(month, out_dir)
                _line(f'  💾 {mon}:{n_done} 檔 / {p["days"]} 天 ・miss {len(month["miss"])} ・'
                      f'{"✅ 完成" if p["complete"] else "⏸ 未完成"} ・{os.path.getsize(_mpath(mon, out_dir)) / 1024:.0f}KB')
            elif got_m:
                save_month(month, out_dir)
                _line(f'  💾 {mon}:只有 {n_done} 檔(< {MIN_STOCKS}),先存著接續用(complete=False)')
            if reason != 'done':
                break
        left = sum(len(todo_syms(load_month(m, out_dir) or blank_month(m, U[m]))) for m in mons)
        return reason, n_new, left

    def run_lu():
        """V78.6.6 漲停隔天:單位 (D, sym),一次只抓那一天。⭐ 開低 ≤ −1% 的先抓,同一組由新到舊。"""
        now = datetime.now(TW)
        today = now.strftime('%Y-%m-%d')
        after_close = now.hour * 60 + now.minute >= 14 * 60      # 13:30 收盤,留 30 分鐘給報價商結算
        series = load_kseries()
        if sum(len(x) for x in series) < 500:
            _line(f'❌ [lu] K 線只讀到 {[len(x) for x in series]} 檔(klines_deep / data)→ 算不出漲停事件,⛔ 不拿半份湊')
            return 'empty', 0, 0
        units = lu_units(series, frm=max(LU_FROM, frm + '-01'), today=today, after_close=after_close)
        have = load_have([OUT_DIR, LEAD_DIR, 'kbar5'])
        months = {}
        for (d, sym) in units:
            mon = d[:7]
            if mon not in months:
                months[mon] = load_month(mon, LU_DIR) or blank_month(mon, [])
        done_u = {u for m in months.values() for u in m['done']} | {x.rsplit(':', 1)[0] for m in months.values() for x in m['miss']}
        jobs = [j_ for j_ in lu_jobs(units, have) if f'{j_[0]}|{j_[1]}' not in done_u]
        n_gd = sum(1 for j_ in jobs if j_[2] is not None and j_[2] <= LU_GAP)
        _line(f'🟥 [lu] 漲停隔天 {len(units)} 個(日×檔)・已在 kbar5_deep/lead/kbar5 {sum(1 for u in units if u in have)} 個 ・'
              f'這輪還要抓 {len(jobs)} 個(其中開低 ≤ {LU_GAP}% {n_gd} 個,先抓)')
        reason, n_new, n_retry, n_retry_ok, touched = 'done', 0, 0, 0, set()
        for k_, (d, sym, gap) in enumerate(jobs):
            g = _gate()
            if g:
                reason = g
                break
            month = months[d[:7]]
            touched.add(d[:7])
            if f'{d}|{sym}' not in month['univ']:
                month['univ'].append(f'{d}|{sym}')
            c = _contract(sym)
            if c is None:
                month['miss'].append(f'{d}|{sym}:no_contract')
                continue
            _pace()
            try:
                by, nb, _n5 = K.fetch_k5(api, c, d, d)
                if not by.get(d):
                    # ⚠️ start == end 在 Shioaji 是否含當天沒在沙箱驗過 → 回空就用隔天當 end 再試一次,只留那一天
                    n_retry += 1
                    _pace()
                    nd = (date.fromisoformat(d) + timedelta(days=1)).isoformat()
                    by, nb, _n5 = K.fetch_k5(api, c, d, nd)
                    if by.get(d):
                        n_retry_ok += 1
            except Exception as ex:
                _line(f'  [{d} {sym}] ❌ {type(ex).__name__}: {str(ex)[:100]} → 這輪先跳過(不記 miss,下輪再試)')
                continue
            if not by.get(d):
                month['miss'].append(f'{d}|{sym}:empty')
                continue
            n_new += add_unit(month, d, sym, by[d])
            if k_ < 3 or (k_ + 1) % 500 == 0:
                _line(f'  [{d} {sym}] 開盤跳空 {gap}% → {len(by[d])} 根 5 分K ・進度 {k_ + 1}/{len(jobs)}')
            if (k_ + 1) % 2000 == 0:                  # 長跑中途存一次(⛔ 被砍掉時不要整輪白做)
                for mon in touched:
                    _lu_save(months[mon])
        for mon in touched:
            p_ = _lu_save(months[mon])
            _line(f'  💾 {LU_DIR}/{mon}:{p_["days"]} 天 ・done {len(p_["done"])} ・miss {len(p_["miss"])} ・{os.path.getsize(_mpath(mon, LU_DIR)) / 1024:.0f}KB')
        if n_retry:
            _line(f'🔎 [lu] start==end 回空 {n_retry} 次,改用 end=隔天 救回 {n_retry_ok} 次(⭐ 這兩個數字決定以後要不要直接用 end=隔天)')
        done_after = {u for m in months.values() for u in m['done']} | {x.rsplit(':', 1)[0] for m in months.values() for x in m['miss']}
        left = sum(1 for j_ in jobs if f'{j_[0]}|{j_[1]}' not in done_after)
        return reason, n_new, left

    def _lu_save(month):
        month['universe'], month['bias'] = 'lu_next_day', LU_BIAS
        return save_month(month, LU_DIR)

    reason, n_new_days, left, ran = 'done', 0, 0, []
    for mode in modes:
        r, nn, lf = run_lu() if mode == 'lu' else run_months(mode)
        ran.append(f'{mode}:{r}/新增{nn}/剩{lf}')
        n_new_days += nn
        left += lf or 0
        if r in ('time', 'traffic'):
            reason = r
            break

    b_end, _ = _usage(api)
    try:
        api.logout()
    except Exception:
        pass
    n_req = st['n_req']
    _line(f'✅ 這輪 {n_req} 次請求、新增 {n_new_days} 個(日×檔)・流量 {_mb(b_start)} → {_mb(b_end)} / {_mb(lim)} ・'
          f'花 {(time.time() - t0) / 60:.1f} 分 ・停下原因 {reason} ・{" | ".join(ran)}')
    if n_req and b_start is not None and b_end is not None:
        _line(f'📏 平均每次請求 {(b_end - b_start) / n_req / 1024:.0f}KB(用來估剩下要幾天)')
    _gh_out(more=1 if left > 0 else 0, reason=reason, left=left, univ=univ_mode)


if __name__ == '__main__':
    main()
