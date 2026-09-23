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
DEEP_DIR = 'klines_deep'
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
    got = set(month.get('done') or []) | set(m.split(':')[0] for m in (month.get('miss') or []))
    return [s for s in month['univ'] if s not in got]


def save_month(month, out_dir=OUT_DIR):
    os.makedirs(out_dir, exist_ok=True)
    days = month['d']
    payload = {
        'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'month': month['month'],
        'bar_min': K.BAR_MIN,
        'universe': 'monthly_top100_by_turnover60',
        'bias': ('名單 = 每月第一個交易日、只用「前 60 個交易日平均成交值」取前 100 檔上市櫃個股,整個月固定'
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

    ok('⑤ month_range 跨年正確', month_range('2021-12') == ('2021-12-01', '2021-12-31') and month_range('2024-02')[1] == '2024-02-29')
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
    U = build_universe(tv)
    cur_mon = datetime.now(TW).strftime('%Y-%m')
    mons = sorted([m for m in U if frm <= m <= cur_mon], reverse=True)     # ⭐ 由新到舊
    if floor:
        mons = [m for m in mons if month_range(m)[1] >= floor]
    _line(f'🧭 母體:{len(tv)} 檔有成交值 → {len(U)} 個月有名單;這輪範圍 {mons[-1] if mons else "-"} ~ {mons[0] if mons else "-"}({len(mons)} 個月)')
    if not mons:
        _line('❌ 沒有可以抓的月份(klines_deep 沒還原?)')
        sys.exit(1)

    b_start, lim = _usage(api)
    reason, n_req, n_new_days, last = 'done', 0, 0, 0.0
    for mon in mons:
        month = load_month(mon) or blank_month(mon, U[mon])
        if month.get('univ') != U[mon] and not month.get('done'):
            month['univ'] = U[mon]
        todo = todo_syms(month)
        if not todo:
            continue
        s, e = month_range(mon)
        _line(f'📅 {mon}:名單 {len(month["univ"])} 檔、還要抓 {len(todo)} 檔')
        got_m = 0
        for sym in todo:
            if (time.time() - t0) / 60 > budget_min:
                reason = 'time'
                break
            if n_req % 20 == 0 and lim:
                b, _ = _usage(api)
                if b is not None and b >= lim * USAGE_STOP:
                    reason = 'traffic'
                    _line(f'🛑 流量 {_mb(b)} / {_mb(lim)} ≥ {USAGE_STOP:.0%} → 停(⛔ 不把日流量吃光,盤中報價要用)')
                    break
            try:
                c = api.Contracts.Stocks[sym]
            except Exception:
                c = None
            if c is None:
                month['miss'].append(f'{sym}:no_contract')
                continue
            wait = MIN_GAP_S - (time.time() - last)
            if wait > 0:
                time.sleep(wait)
            last = time.time()
            n_req += 1
            try:
                by, nb, _n5 = K.fetch_k5(api, c, s, e)
            except Exception as ex:
                _line(f'  [{sym}] ❌ {type(ex).__name__}: {str(ex)[:100]} → 這輪先跳過(不記 miss,下輪再試)')
                continue
            if not nb:
                month['miss'].append(f'{sym}:empty')
                continue
            n_new_days += add_sym(month, sym, by)
            got_m += 1
        n_done = len(month['done'])
        if n_done >= MIN_STOCKS or not todo_syms(month):
            p = save_month(month)
            _line(f'  💾 {mon}:{n_done} 檔 / {p["days"]} 天 ・miss {len(month["miss"])} ・'
                  f'{"✅ 完成" if p["complete"] else "⏸ 未完成"} ・{os.path.getsize(_mpath(mon)) / 1024:.0f}KB')
        elif got_m:
            p = save_month(month)
            _line(f'  💾 {mon}:只有 {n_done} 檔(< {MIN_STOCKS}),先存著接續用(complete=False)')
        if reason != 'done':
            break

    b_end, _ = _usage(api)
    try:
        api.logout()
    except Exception:
        pass
    left = sum(len(todo_syms(load_month(m) or blank_month(m, U[m]))) for m in mons)
    allf = sorted(glob.glob(os.path.join(OUT_DIR, '*.json.gz')))
    _line(f'✅ 這輪 {n_req} 次請求、新增 {n_new_days} 個(日×檔)・流量 {_mb(b_start)} → {_mb(b_end)} / {_mb(lim)} ・'
          f'花 {(time.time() - t0) / 60:.1f} 分 ・停下原因 {reason} ・還剩 {left} 個(月×檔)・分支共 {len(allf)} 個月檔')
    if n_req and b_start is not None and b_end is not None:
        _line(f'📏 平均每次請求 {(b_end - b_start) / n_req / 1024:.0f}KB(用來估剩下要幾天)')
    _gh_out(more=1 if left > 0 else 0, reason=reason, left=left)


if __name__ == '__main__':
    main()
