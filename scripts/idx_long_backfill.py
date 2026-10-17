#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📚 V77.6.3 真的加權指數 + 0050(2010 起)—— 給長歷史回測用(`merge_k66_history.py --idx-long`)

背景:V77.6.2 把回測拉到 2011~2026,但 2021-09 以前的「大盤」是**等權代理**,
而「嚴格空頭不做」(`FILTER=bear60`)正是吃大盤判斷的;2022 以前也沒有 0050 可比。
→ 這支只抓 **5 次** FinMind(一次呼叫可回 18 年,history_probe 實測):
    ① TaiwanStockPrice              TAIEX  (加權指數 OHLC + 成交金額)
    ② TaiwanStockTotalReturnIndex   TAIEX  (報酬指數;拿不到只寫 *_error,⛔ 不擋)
    ③ TaiwanStockPrice              0050   (原始價 → 錨在本站那份第一天換成同一把尺;2025 的 1:4 分割在錨點之後)
    ④ TaiwanStockDividendResult     0050   (除息日 / 現金股利 / 除息前價 / 參考價)
    ⑤ TaiwanStockPrice              TPEx   (🏪 V79.2.4 櫃買指數;`miner._fetch_otc_history_finmind` 已驗 **`TPEx` 才對、`OTC` 回空**;
                                           拿不到 / 不夠深 / 對不上本站 → 只寫 `twoii_error`,⛔ 不擋前四份 —— 它只給「空頭守門改看櫃買」的回測用)
輸出**一個**檔 data/idx_long.json(前端不讀,只給回測)。

守門(⛔ 都不可拿掉;任一不過 → exit 1、⛔ 不寫檔):
  ・加權 / 0050 第一根 ≤ 2010-01-15、加權 ≥ 3,800 根
  ・⭐ 重疊期對表:跟本站 data/^TWII.json、data/0050.json 同日收盤差 < 0.5% 的比例 ≥ 95%
    (抓錯日期 / 漏還原分割 → 這一關一定叫得出來,`--selftest` 有注入)
  ・對表用的參考檔不在 / 是空的 → exit 1(⛔ 沒驗過的資料不寫)

⛔ 安全:只印「第幾把 token」,絕不印 token 值(dispo_probe.fm 已照做)。
🕰️ 早期模式(V79.3.5,`IDX_START` 早於 2010-01-01 時自動切換;使用者:「要,補抓 2000 年起」):
  ・⛔ 只要指數(① 加權 ② 報酬指數 ⑤ 櫃買),⛔ 不抓 0050 / 除息 —— 0050 2003 才上市,早期回測只拿指數用
  ・只抓到 **2010 年底**:跟回測用那份 `idx_long.json` 重疊一整年,拿那一年對表(⛔ 沒有重疊就沒辦法驗)
  ・守門跟著起點走:第一根 ≤ 起點 + 14 天、根數 ≥ 起點~終點平日數 × 0.88、重疊年 ≥95% 在 0.5% 內
  ・FinMind 不夠深 → 備援**證交所官方** `MI_5MINS_HIST`(1999 起,每月一份)+ 成交金額走 `miner._fetch_fmtqik_months`
    (⛔ 不改 miner.py —— 改它會觸發 30~60 分的 daily_miner)
  ・寫**另一個檔**(workflow 決定檔名 `data/idx_long_early.json`)→ 既有回測讀的 `idx_long.json` 一個字都不動
用法:python3 scripts/idx_long_backfill.py [--ref-dir DIR] [--out FILE] | --selftest
"""
import json
import os
import random
import sys
import time
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

START = os.getenv('IDX_START') or '2010-01-01'
DEFAULT_START = '2010-01-01'      # 回測用那份(idx_long.json)的起點;早於它 = 早期模式
FIRST_MAX = '2010-01-15'
MIN_TWII = 3800
EARLY_END = '2010-12-31'          # 早期檔只到 2010 年底:跟 idx_long.json 重疊一整年拿來對表
EARLY_FRAC = 0.88                 # 早期守門:根數 ≥ 平日數 × 0.88(台股一年約 245 個交易日 / 261 個平日;2000 年還有週六盤)
TWSE_TRIES = 3
TOL = 0.005
MIN_RATIO = 0.95
MIN_OVERLAP = 200


def d_slash(s):
    return str(s)[:10].replace('-', '/')


def load_ref(path):
    """本站那份(list of {date, close})→ {YYYY/MM/DD: close};壞的 / 空的回 None。"""
    try:
        with open(path) as f:
            rows = json.load(f)
    except Exception:
        return None
    if not isinstance(rows, list) or not rows:
        return None
    out = {d_slash(r.get('date')): float(r['close']) for r in rows
           if isinstance(r, dict) and r.get('close')}
    return out or None


def overlap_check(new, ref, tol=TOL, min_ratio=MIN_RATIO, min_n=MIN_OVERLAP):
    """new / ref 都是 {date: close}。回 (ok, ratio, n)。"""
    common = [d for d in new if d in ref and ref[d] > 0]
    n = len(common)
    if n < min_n:
        return False, 0.0, n
    good = sum(1 for d in common if abs(new[d] / ref[d] - 1) < tol)
    ratio = good / n
    return ratio >= min_ratio, ratio, n


def anchor_scale(rows, ref, n_chk=20, tol=TOL, jump=0.115):
    """rows(原始價,舊→新)錨到 ref 的第一個共同日期:回 {rows(≤錨點那天、已乘倍率), d, k, n} 或 {err}。
    守門:① 前 n_chk 個共同日期的倍率都跟中位數差 <tol ② 輸出那段不可有單日 >11.5% 的跳動(= 還有沒還原的公司行動)"""
    common = [x['date'] for x in rows if x['date'] in ref and ref[x['date']] > 0]
    if len(common) < n_chk:
        return {'err': f'跟本站那份只有 {len(common)} 個共同日期(<{n_chk}),錨不起來'}
    bym = {x['date']: x['close'] for x in rows}
    ks = sorted(ref[d] / bym[d] for d in common[:n_chk])
    k = ks[len(ks) // 2]
    bad = [d for d in common[:n_chk] if abs(ref[d] / bym[d] / k - 1) >= tol]
    if bad:
        return {'err': f'錨點倍率不一致({len(bad)}/{n_chk} 天偏離中位數 ≥{tol:.1%},例:{bad[0]})'}
    d0 = common[0]
    out = [dict(x, open=x['open'] * k, high=x['high'] * k, low=x['low'] * k, close=x['close'] * k,
                volume=int(round(x['volume'] / k))) for x in rows if x['date'] <= d0]
    for a, b in zip(out, out[1:]):
        r = b['close'] / a['close']
        if r > 1 + jump or r < 1 - jump:
            return {'err': f'錨點之前還有沒還原的跳動:{a["date"]} {a["close"]:.2f} → {b["date"]} {b["close"]:.2f}'}
    return {'rows': out, 'd': d0, 'k': k, 'n': n_chk}


def to_price_rows(rows):
    out = []
    for r in rows or []:
        try:
            out.append({'date': d_slash(r['date']), 'open': float(r['open']), 'high': float(r['max']),
                        'low': float(r['min']), 'close': float(r['close']),
                        'volume': int(r.get('Trading_Volume') or 0), 'amount': int(r.get('Trading_money') or 0)})
        except (KeyError, TypeError, ValueError):
            continue
    out = [x for x in out if x['close'] > 0]
    out.sort(key=lambda x: x['date'])
    return out


def build(fm, ref_twii, ref_0050, today=None, ref_twoii=None):
    """純邏輯(fm 可注入)→ (obj, errors)。errors 非空 = 不可寫檔。"""
    errs = []
    end = today or date.today().isoformat()
    obj = {'updated': end, 'from': START, 'src': 'FinMind',
           'caveat': '回測專用(前端不讀)。0050 已還原分割;股利未再投入(要含息請自己用 div0050 算)。'}

    tw_raw, e = fm('TaiwanStockPrice', {'data_id': 'TAIEX', 'start_date': START, 'end_date': end})
    tw = to_price_rows(tw_raw)
    print(f'① 加權:{len(tw)} 根 ・{tw[0]["date"] if tw else "—"} ~ {tw[-1]["date"] if tw else "—"}' + (f' ・{e}' if e else ''))
    if not tw or tw[0]['date'] > d_slash(FIRST_MAX) or len(tw) < MIN_TWII:
        errs.append(f'加權不夠深({len(tw)} 根,第一根 {tw[0]["date"] if tw else "—"};{e or ""})')
    else:
        ok, ratio, n = overlap_check({x['date']: x['close'] for x in tw}, ref_twii)
        print(f'   對表 data/^TWII.json:{n} 天重疊,差 <0.5% 的 {ratio:.1%}')
        if not ok:
            errs.append(f'加權對不上本站(重疊 {n} 天、只有 {ratio:.1%} 在 0.5% 內)')
    obj['twii'] = [[x['date'], x['open'], x['high'], x['low'], x['close'], x['amount']] for x in tw]

    tr_raw, e = fm('TaiwanStockTotalReturnIndex', {'data_id': 'TAIEX', 'start_date': START, 'end_date': end})
    tr = sorted([[d_slash(r['date']), float(r['price'])] for r in (tr_raw or [])
                 if r.get('price') not in (None, '', 0)], key=lambda x: x[0])
    print(f'② 報酬指數:{len(tr)} 根' + (f' ・{e}' if e else ''))
    obj['twii_tr'] = tr
    if not tr:
        obj['twii_tr_error'] = f'報酬指數拿不到({e or "回空"})—— 不影響其他三份'

    e5_raw, e = fm('TaiwanStockPrice', {'data_id': '0050', 'start_date': START, 'end_date': end})
    e5 = to_price_rows(e5_raw)
    print(f'③ 0050:{len(e5)} 根 ・{e5[0]["date"] if e5 else "—"} ~ {e5[-1]["date"] if e5 else "—"}' + (f' ・{e}' if e else ''))
    # 🚨 第一次實跑(run #1)抓到:FinMind 的 0050 是**原始價**,2025-06 那次 1:4 分割中間停牌 7 天
    #   → `miner._backadjust_splits` 的 `gap > 5` 守門(刻意的,見它的註解)不會動它 → 整段對不上(39.3%)。
    #   ⭐ 改法:⛔ 不去放寬那道守門,改成**錨在本站那份的第一個共同日期**:
    #     只輸出「本站那份第一天(含)以前」的部分,乘上那一天的倍率;而且前 20 個共同日期的倍率要一致(<0.5%)。
    #     之後那一段本站自己就有(而且已經還原過),⛔ 不用 FinMind 的。
    out5 = []
    if not e5 or e5[0]['date'] > d_slash(FIRST_MAX):
        errs.append(f'0050 不夠深({len(e5)} 根;{e or ""})')
    else:
        a = anchor_scale(e5, ref_0050)
        if a.get('err'):
            errs.append('0050 ' + a['err'])
        else:
            out5 = a['rows']
            obj['e0050_anchor'] = {'d': a['d'], 'k': a['k'], 'n': a['n']}
            print(f'   錨在 {a["d"]}:倍率 {a["k"]:.6f}(前 {a["n"]} 個共同日期一致)・輸出 {len(out5)} 根(本站那份之前)')
    obj['e0050'] = [[x['date'], x['open'], x['high'], x['low'], x['close'], x['volume']] for x in out5]

    dv_raw, e = fm('TaiwanStockDividendResult', {'data_id': '0050', 'start_date': START, 'end_date': end})
    dv = []
    for r in dv_raw or []:
        try:
            dv.append([d_slash(r['date']), float(r.get('stock_and_cache_dividend') or 0),
                       str(r.get('stock_or_cache_dividend') or ''), float(r.get('before_price') or 0),
                       float(r.get('after_price') or 0)])
        except (TypeError, ValueError):
            continue
    dv.sort(key=lambda x: x[0])
    print(f'④ 0050 除息:{len(dv)} 筆' + (f' ・{e}' if e else ''))
    obj['div0050'] = dv
    if not dv:
        obj['div0050_error'] = f'除息紀錄拿不到({e or "回空"})—— 0050 含息報酬算不了'

    # ⑤ 🏪 V79.2.4 櫃買指數(給 leader_probe `bearIdx` 回測用)—— ⛔ 不進 errs:本站那份 ^TWOII 只從 2024-10 起,
    #   對表用現有重疊;重疊不足 / 對不上 / 回空 → 一律只寫 twoii_error(陷阱 #22:None 一定要有原因)
    ot_raw, e = fm('TaiwanStockPrice', {'data_id': 'TPEx', 'start_date': START, 'end_date': end})
    ot = to_price_rows(ot_raw)
    print(f'⑤ 櫃買:{len(ot)} 根 ・{ot[0]["date"] if ot else "—"} ~ {ot[-1]["date"] if ot else "—"}' + (f' ・{e}' if e else ''))
    obj['twoii'] = [[x['date'], x['open'], x['high'], x['low'], x['close'], x['amount']] for x in ot]
    if not ot:
        obj['twoii_error'] = f'櫃買指數拿不到({e or "回空"})—— bearIdx 回測只能用本站那份(2024-10 起)'
    else:
        if ref_twoii:
            ok, ratio, n = overlap_check({x['date']: x['close'] for x in ot}, ref_twoii, min_n=min(MIN_OVERLAP, max(50, len(ref_twoii) // 2)))
            print(f'   對表 data/^TWOII.json:{n} 天重疊,差 <0.5% 的 {ratio:.1%}')
            if not ok:
                obj['twoii_error'] = f'櫃買對不上本站(重疊 {n} 天、只有 {ratio:.1%} 在 0.5% 內)—— ⛔ 不可接到 ^TWOII 前面'
        else:
            obj['twoii_error'] = '沒有本站 ^TWOII.json 可對表 —— 資料照存,接之前先人工看一眼'
        if ot[0]['date'] > d_slash(FIRST_MAX):
            obj['twoii_note'] = f'第一根 {ot[0]["date"]},比加權晚(2011 起的回測前面那段沒有櫃買可看)'
    return obj, errs


# ── 🕰️ 早期模式(V79.3.5)──────────────────────────────────────────────────────
def first_max(start):
    """第一根要落在起點 14 天內(預設起點 → '2010-01-15',跟 FIRST_MAX 一字不差 —— selftest ⑩ 釘住)。"""
    return (date.fromisoformat(start) + timedelta(days=14)).isoformat()


def min_bars(start, end, frac=EARLY_FRAC):
    """起點~終點的平日數 × frac = 早期守門的最少根數。"""
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    n = sum(1 for k in range((d1 - d0).days + 1) if (d0 + timedelta(days=k)).weekday() < 5)
    return int(n * frac)


def month_list(start, end):
    """起點~終點涵蓋的 (年, 月),由舊到新。"""
    y, m, y1, m1 = int(start[:4]), int(start[5:7]), int(end[:4]), int(end[5:7])
    out = []
    while (y, m) <= (y1, m1):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def twse_index_rows(start, end, _get=None, _sleep=None):
    """🏛️ 證交所官方加權指數(MI_5MINS_HIST,1999 起每月一份)+ 成交金額(FMTQIK)→ 跟 to_price_rows 同形狀。
    回 (rows, err)。只在 FinMind 不夠深時才叫;抓不到的月份 / 沒有成交金額的天數一律寫進 err(陷阱 #22)。
    ⛔ 不改 miner.py:只借它現成的 `_roc_to_iso` / `HEADERS` / `_rnd_hdrs` / `_fetch_fmtqik_months`。
    `_get` / `_sleep` 只給 selftest 注入(沙箱連不到證交所)。"""
    import miner
    get = _get or (lambda url: __import__('requests').get(
        url, headers={**miner.HEADERS, **miner._rnd_hdrs()}, timeout=15, allow_redirects=True))
    sleep = _sleep or time.sleep
    months = month_list(start, end)
    rows, bad, empty = {}, [], []
    num = lambda x: float(str(x).replace(',', ''))
    for i, (y, m) in enumerate(months):
        if i:
            sleep(random.uniform(0.3, 0.5))      # ⛔ 證交所對連續快速請求會擋(同 miner FMTQIK 的理由)
        url = f'https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?response=json&date={y:04d}{m:02d}01'
        got = None
        for t in range(1, TWSE_TRIES + 1):
            try:
                r = get(url)
                if r.status_code != 200:
                    raise RuntimeError(f'HTTP {r.status_code}')
                j = r.json()
                got = []
                if j.get('stat') and j.get('stat') != 'OK':
                    break                          # 官方明講沒資料 → 重試也沒用
                for row in j.get('data') or []:
                    d = miner._roc_to_iso(row[0])
                    try:
                        o, h, lo, c = num(row[1]), num(row[2]), num(row[3]), num(row[4])
                    except (IndexError, ValueError):
                        continue
                    if d and c > 0:
                        got.append({'date': d, 'open': o, 'high': h, 'low': lo, 'close': c, 'volume': 0, 'amount': 0})
                break
            except Exception as e:
                if t < TWSE_TRIES:
                    sleep(t * 1.5)                 # 307 / 403 多半是間歇 WAF,退避後換 UA 再試
                else:
                    bad.append(f'{y}/{m:02d} {str(e)[:40]}')
        if got == []:
            empty.append(f'{y}/{m:02d}')
        for x in got or []:
            rows[x['date']] = x
    try:
        vol = miner._fetch_fmtqik_months(months, _get=_get)
    except Exception as e:
        vol, _ = {}, bad.append(f'FMTQIK {str(e)[:40]}')
    n_amt = 0
    for d, x in rows.items():
        va = vol.get(d)
        if va and va[1]:
            x['amount'] = int(va[1])
            n_amt += 1
    out = sorted(rows.values(), key=lambda x: x['date'])
    notes = []
    if bad:
        notes.append(f'{len(bad)} 個月份抓不到(例:{bad[0]})')
    if empty:
        notes.append(f'{len(empty)} 個月份官方回空(例:{empty[0]})')
    if out and n_amt < len(out):
        notes.append(f'成交金額 {len(out) - n_amt}/{len(out)} 天沒有(FMTQIK)')
    return out, (' ・'.join(notes) or None)


def load_long_ref(path):
    """回測用那份 idx_long.json → {'twii': {d: close}, 'twoii': {d: close}};讀不到 / 沒有 twii → None。"""
    try:
        with open(path) as f:
            j = json.load(f)
    except Exception:
        return None
    if not isinstance(j, dict):
        return None
    out = {k: {d_slash(r[0]): float(r[4]) for r in (j.get(k) or []) if isinstance(r, list) and len(r) >= 5 and r[4]}
           for k in ('twii', 'twoii')}
    return out if out['twii'] else None


def build_early(fm, ref_long, today=None, start=None, twse=None):
    """🕰️ 早期模式(起點 < 2010):⛔ 只要指數、只抓到 2010 年底。→ (obj, errors);errors 非空 = 不可寫檔。"""
    errs = []
    st = start or START
    upd = today or date.today().isoformat()
    end = min(EARLY_END, upd)
    fmax, nmin = first_max(st), min_bars(st, end)
    obj = {'updated': upd, 'from': st, 'to': end, 'mode': 'early', 'src': {},
           'caveat': f'回測專用(前端不讀)。只有指數。{EARLY_END[:4]} 那一年跟 idx_long.json 重疊、拿來對表 —— '
                     '接起來時用 idx_long.json 第一天「以前」的列,重疊那段以 idx_long.json 為準。'}

    tw_raw, e = fm('TaiwanStockPrice', {'data_id': 'TAIEX', 'start_date': st, 'end_date': end})
    tw, src = to_price_rows(tw_raw), 'FinMind'
    print(f'① 加權(FinMind):{len(tw)} 根 ・{tw[0]["date"] if tw else "—"} ~ {tw[-1]["date"] if tw else "—"}' + (f' ・{e}' if e else ''))
    deep = bool(tw) and tw[0]['date'] <= d_slash(fmax) and len(tw) >= nmin
    if not deep and twse:
        print(f'   FinMind 不夠深(要第一根 ≤ {fmax}、≥ {nmin} 根)→ 改抓證交所官方月份檔')
        tw2, e2 = twse(st, end)
        print(f'   證交所:{len(tw2)} 根 ・{tw2[0]["date"] if tw2 else "—"} ~ {tw2[-1]["date"] if tw2 else "—"}' + (f' ・{e2}' if e2 else ''))
        if tw2 and (not tw or tw2[0]['date'] < tw[0]['date'] or len(tw2) > len(tw)):
            tw, src, e = tw2, 'TWSE', e2
            if e2:
                obj['twii_note'] = e2
    if not tw or tw[0]['date'] > d_slash(fmax) or len(tw) < nmin:
        errs.append(f'加權不夠深({len(tw)} 根、第一根 {tw[0]["date"] if tw else "—"};要 ≤ {fmax} 且 ≥ {nmin} 根;{e or ""})')
    else:
        ok, ratio, n = overlap_check({x['date']: x['close'] for x in tw}, ref_long['twii'])
        print(f'   對表 idx_long.json(重疊那一年):{n} 天重疊,差 <0.5% 的 {ratio:.1%}')
        if not ok:
            errs.append(f'加權對不上 idx_long.json(重疊 {n} 天、只有 {ratio:.1%} 在 0.5% 內)')
    obj['src']['twii'] = src
    obj['twii'] = [[x['date'], x['open'], x['high'], x['low'], x['close'], x['amount']] for x in tw]

    tr_raw, e = fm('TaiwanStockTotalReturnIndex', {'data_id': 'TAIEX', 'start_date': st, 'end_date': end})
    tr = sorted([[d_slash(r['date']), float(r['price'])] for r in (tr_raw or [])
                 if r.get('price') not in (None, '', 0)], key=lambda x: x[0])
    print(f'② 報酬指數:{len(tr)} 根 ・{tr[0][0] if tr else "—"} 起' + (f' ・{e}' if e else ''))
    obj['twii_tr'] = tr
    if not tr:
        obj['twii_tr_error'] = f'報酬指數拿不到({e or "回空"})—— 早期只能用價格指數'
    elif tr[0][0] > d_slash(fmax):
        obj['twii_tr_note'] = f'報酬指數第一根 {tr[0][0]}(證交所報酬指數較晚才編)—— 更早只能用價格指數'

    ot_raw, e = fm('TaiwanStockPrice', {'data_id': 'TPEx', 'start_date': st, 'end_date': end})
    ot = to_price_rows(ot_raw)
    print(f'⑤ 櫃買:{len(ot)} 根 ・{ot[0]["date"] if ot else "—"} ~ {ot[-1]["date"] if ot else "—"}' + (f' ・{e}' if e else ''))
    obj['twoii'] = [[x['date'], x['open'], x['high'], x['low'], x['close'], x['amount']] for x in ot]
    if not ot:
        obj['twoii_error'] = f'櫃買指數拿不到({e or "回空"})'
    elif not ref_long.get('twoii'):
        obj['twoii_error'] = 'idx_long.json 沒有 twoii 可對表 —— 資料照存,接之前先人工看一眼'
    else:
        ok, ratio, n = overlap_check({x['date']: x['close'] for x in ot}, ref_long['twoii'])
        if not ok:
            obj['twoii_error'] = f'櫃買對不上 idx_long.json(重疊 {n} 天、只有 {ratio:.1%} 在 0.5% 內)—— ⛔ 不可接'
    return obj, errs


def selftest():
    fails = []
    ok = lambda name, c: (print(('✅ ' if c else '❌ ') + name), c or fails.append(name))
    days = [f'2023/{m:02d}/{d:02d}' for m in range(1, 13) for d in range(1, 29)]
    ref = {d: 100 + i * 0.3 for i, d in enumerate(days)}
    ok('① 同一份 → 過', overlap_check(dict(ref), ref)[0])
    shifted = {days[i]: ref[days[i + 1]] for i in range(len(days) - 1)}
    ok('② 注入「差 1 天」→ 叫得出來', not overlap_check(shifted, ref, tol=0.001)[0])
    half = {d: (ref[d] * 4 if i < len(days) // 2 else ref[d]) for i, d in enumerate(days)}
    ok('③ 注入「前半段漏還原 1:4 分割」→ 叫得出來', not overlap_check(half, ref)[0])
    ok('④ 重疊太少(<200 天)→ 不算過', not overlap_check({d: ref[d] for d in days[:50]}, ref)[0])

    # build():合成 FinMind(整條 build 走一次,含 miner 分割還原)
    from datetime import timedelta
    d0 = date(2010, 1, 4)
    base = [x.isoformat() for x in (d0 + timedelta(days=k) for k in range(6100)) if x.weekday() < 5][:4200]
    px = [10000 + 300 * ((i * 7) % 11 - 5) for i in range(len(base))]   # 每天 ±1~3% 在跳(差一天才量得到)
    tw = [{'date': d, 'open': px[i], 'max': px[i] + 50, 'min': px[i] - 50, 'close': px[i], 'Trading_money': 1} for i, d in enumerate(base)]
    ref_tw = {d_slash(r['date']): r['close'] for r in tw[-400:]}
    e5 = [{'date': d, 'open': p, 'max': p, 'min': p, 'close': p, 'Trading_Volume': 1}
          for i, d in enumerate(base) for p in [(40 + i * 0.01) * (4 if d < '2025-06-18' else 1)]]
    ref_05 = {d_slash(r['date']): (40 + i * 0.01) for i, r in enumerate(e5) if r['date'] >= '2023-06-01'}

    def fake_fm(shift=False):
        def f(ds, q):
            if ds == 'TaiwanStockPrice' and q['data_id'] == 'TAIEX':
                return ([dict(r, close=tw[min(i + 1, len(tw) - 1)]['close']) for i, r in enumerate(tw)] if shift else tw), None
            if ds == 'TaiwanStockPrice' and q['data_id'] == 'TPEx':
                return ([] if f.no_otc else [dict(r, close=r['close'] / 50) for r in tw]), None
            if ds == 'TaiwanStockPrice':
                return [dict(r) for r in e5], None
            if ds == 'TaiwanStockTotalReturnIndex':
                return [{'date': r['date'], 'price': r['close'] * 2} for r in tw], None
            return [{'date': '2024-07-16', 'stock_and_cache_dividend': 1.0, 'stock_or_cache_dividend': '息',
                     'before_price': 190, 'after_price': 189}], None
        f.no_otc = False
        return f
    o, errs = build(fake_fm(), ref_tw, ref_05, today='2026-09-25')
    ok('⑤ 正常資料 → 沒有錯誤、錨點之前的 0050 已換成本站的尺', not errs and abs(o['e0050'][0][4] - 40) < 1e-6)
    _, errs = build(fake_fm(shift=True), ref_tw, ref_05, today='2026-09-25')
    ok('⑥ 加權日期錯一格 → build 報錯(⛔ 不寫檔)', any('加權' in x for x in errs))
    # ⑦ 錨點倍率不一致(本站那份前 20 天裡有一半是別的尺)→ 必須報錯
    ref_bad = dict(ref_05); ks_ = sorted(ref_bad)[:10]
    for d in ks_: ref_bad[d] *= 2
    _, errs = build(fake_fm(), ref_tw, ref_bad, today='2026-09-25')
    ok('⑦ 注入「錨點倍率不一致」→ build 報錯', any('0050' in x and '錨點' in x for x in errs))
    # ⑦b 錨點之前還有沒還原的 1:2 跳動 → 必須報錯
    e5_keep = list(e5)
    for i_ in range(0, 1000): e5[i_] = dict(e5[i_], close=e5[i_]['close'] * 2)
    _, errs = build(fake_fm(), ref_tw, ref_05, today='2026-09-25')
    e5[:] = e5_keep
    ok('⑦b 注入「錨點之前有沒還原的跳動」→ build 報錯', any('跳動' in x for x in errs))
    # ⑦c 真實情境:原始價在錨點**之後**才分割(2025-06)→ 仍要能錨(⛔ 不可因為後面有分割就放棄)
    o, errs = build(fake_fm(), ref_tw, ref_05, today='2026-09-25')
    ok('⑦c 分割發生在錨點之後 → 照樣錨得起來、第一根 = 還原後的價', not errs and abs(o['e0050'][0][4] - 40) < 1e-6 and o['e0050_anchor']['k'] == 0.25)
    ok('⑧ 參考檔不在 → load_ref 回 None', load_ref('/nonexistent/x.json') is None)
    # ⑨ 🏪 櫃買:有本站那份(只有 276 天)→ 用現有重疊對表、過了就沒有 twoii_error;對不上 → 只寫 twoii_error、⛔ 不進 errs;回空 → 只寫 twoii_error
    ref_ot = {d_slash(r['date']): r['close'] / 50 for r in tw[-276:]}
    o9, errs9 = build(fake_fm(), ref_tw, ref_05, today='2026-09-25', ref_twoii=ref_ot)
    ok('⑨ 櫃買對得上本站 276 天 → 有 twoii、沒有 twoii_error、不影響 errs', not errs9 and len(o9['twoii']) == len(tw) and 'twoii_error' not in o9)
    ref_bad_ot = {d: v * 1.3 for d, v in ref_ot.items()}
    o9b, errs9b = build(fake_fm(), ref_tw, ref_05, today='2026-09-25', ref_twoii=ref_bad_ot)
    ok('⑨b 櫃買對不上 → 只寫 twoii_error(⛔ 不擋前四份)', not errs9b and '對不上' in o9b.get('twoii_error', ''))
    f9 = fake_fm(); f9.no_otc = True
    o9c, errs9c = build(f9, ref_tw, ref_05, today='2026-09-25', ref_twoii=ref_ot)
    ok('⑨c 櫃買回空 → twoii 空陣列 + twoii_error', not errs9c and o9c['twoii'] == [] and '拿不到' in o9c.get('twoii_error', ''))

    # ⑩~⑮ 🕰️ 早期模式(V79.3.5)
    ok('⑩ 預設起點的守門跟舊的一樣(first_max(2010-01-01) == FIRST_MAX)', first_max(DEFAULT_START) == FIRST_MAX)
    ed = [x.isoformat() for x in (date(2000, 1, 3) + timedelta(days=k) for k in range(4200))
          if x.weekday() < 5 and x <= date(2010, 12, 31)]
    epx = [6000 + 400 * ((i * 7) % 11 - 5) for i in range(len(ed))]
    erows = [{'date': d, 'open': epx[i], 'max': epx[i] + 30, 'min': epx[i] - 30, 'close': epx[i], 'Trading_money': 5}
             for i, d in enumerate(ed)]
    ref_long = {'twii': {d_slash(r['date']): r['close'] for r in erows if r['date'] >= '2010-01-01'}, 'twoii': {}}
    calls = []

    def fm_e(depth_from='2000-01-03'):
        def f(ds, q):
            calls.append((ds, q.get('data_id')))
            if ds == 'TaiwanStockPrice' and q['data_id'] == 'TAIEX':
                return [r for r in erows if r['date'] >= depth_from], None
            if ds == 'TaiwanStockTotalReturnIndex':
                return [{'date': r['date'], 'price': r['close'] * 2} for r in erows if r['date'] >= '2003-01-02'], None
            if ds == 'TaiwanStockPrice' and q['data_id'] == 'TPEx':
                return [], None
            return [{'date': '2004-01-01', 'close': 1}], None      # 0050 / 除息:早期模式⛔ 不該叫到(⑫ 檢查)
        return f
    o10, errs10 = build_early(fm_e(), ref_long, today='2026-10-17', start='2000-01-01')
    ok('⑪ 早期:FinMind 夠深 → 過、src=FinMind、只到 2010 年底、報酬指數晚編要寫 note',
       not errs10 and o10['src']['twii'] == 'FinMind' and o10['twii'][0][0] == '2000/01/03'
       and o10['twii'][-1][0] <= '2010/12/31' and 'twii_tr_note' in o10 and o10['mode'] == 'early')
    ok('⑫ 早期:⛔ 不碰 0050 / 除息', not any(c[1] == '0050' or c[0] == 'TaiwanStockDividendResult' for c in calls))
    tw_twse = [{'date': d_slash(r['date']), 'open': r['open'], 'high': r['max'], 'low': r['min'], 'close': r['close'],
                'volume': 0, 'amount': 7} for r in erows]
    o13, errs13 = build_early(fm_e('2005-01-03'), ref_long, today='2026-10-17', start='2000-01-01',
                              twse=lambda a, b: (tw_twse, None))
    ok('⑬ 早期:FinMind 只到 2005 → 改用證交所、過關、src=TWSE',
       not errs13 and o13['src']['twii'] == 'TWSE' and o13['twii'][0][0] == '2000/01/03')
    _, errs13b = build_early(fm_e('2005-01-03'), ref_long, today='2026-10-17', start='2000-01-01',
                             twse=lambda a, b: ([], '連不到'))
    ok('⑬b 早期:兩邊都不夠深 → 報錯(⛔ 不寫檔)', any('不夠深' in x for x in errs13b))
    bad_ref = {'twii': {d: c * 1.02 for d, c in ref_long['twii'].items()}, 'twoii': {}}
    _, errs14 = build_early(fm_e(), bad_ref, today='2026-10-17', start='2000-01-01')
    ok('⑭ 早期:重疊那一年對不上 idx_long.json → 報錯', any('對不上' in x for x in errs14))

    class _R:
        def __init__(self, j, code=200):
            self.j, self.status_code = j, code

        def json(self):
            return self.j

    def fake_get(url):
        ym = url.split('date=')[1][:6]
        y, m = int(ym[:4]) - 1911, int(ym[4:])
        if 'MI_5MINS_HIST' in url:
            return _R({'stat': 'OK', 'data': [[f'{y}/{m:02d}/{d:02d}', '8,000.10', '8,100.00', '7,900.00', f'8,0{d:02d}.00']
                                              for d in (3, 4)]})
        if 'FMTQIK' in url:
            return _R({'stat': 'OK', 'fields': ['日期', '成交股數', '成交金額', '成交筆數', '發行量加權股價指數', '漲跌點數'],
                       'data': [[f'{y}/{m:02d}/03', '1,000', '123,456,789', '1', '8,003.00', '1']]})
        return _R({}, 404)
    rr, ee = twse_index_rows('2000-01-01', '2000-02-28', _get=fake_get, _sleep=lambda s: None)
    ok('⑮ 證交所月份檔:民國→西元、千分位、成交金額併上、缺金額的天數寫進 err',
       len(rr) == 4 and rr[0]['date'] == '2000/01/03' and rr[0]['close'] == 8003.0
       and rr[0]['amount'] == 123456789 and rr[1]['amount'] == 0 and bool(ee) and '成交金額' in ee)
    print(f'\n{"❌ " + str(len(fails)) + " 條沒過" if fails else "✅ IDX_LONG_SELFTEST_PASS"}')
    return 1 if fails else 0


def main():
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    arg = lambda k, dflt: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else dflt
    ref_dir = arg('--ref-dir', os.getenv('IDX_REF_DIR') or 'data')
    out = arg('--out', os.getenv('IDX_OUT') or 'data/idx_long.json')
    if START < DEFAULT_START:
        # 🕰️ 早期模式:只要指數,拿回測用那份 idx_long.json 重疊的那一年對表
        try:
            date.fromisoformat(START)
        except ValueError:
            print(f'❌ IDX_START 格式要 YYYY-MM-DD(收到 {START!r})')
            sys.exit(1)
        ref_long = load_long_ref(os.path.join(ref_dir, 'idx_long.json'))
        if not ref_long:
            print(f'❌ 早期模式要拿 {ref_dir}/idx_long.json(2010 起那份)的重疊年對表,讀不到 → 不抓(⛔ 沒驗過的資料不寫)')
            sys.exit(1)
        from dispo_probe import fm, TOKENS
        print(f'🔑 token:{len(TOKENS)} 把 ・🕰️ 早期模式 {START} ~ {EARLY_END}(只有指數)')
        obj, errs = build_early(fm, ref_long, twse=twse_index_rows)
    else:
        ref_tw = load_ref(os.path.join(ref_dir, '^TWII.json'))
        ref_05 = load_ref(os.path.join(ref_dir, '0050.json'))
        ref_ot = load_ref(os.path.join(ref_dir, '^TWOII.json'))   # 🏪 選用:沒有就只存不對表(twoii_error 會寫原因)
        if not ref_tw or not ref_05:
            print(f'❌ 對表用的參考檔讀不到({ref_dir}/^TWII.json={bool(ref_tw)}、0050.json={bool(ref_05)})→ 不抓(⛔ 沒驗過的資料不寫)')
            sys.exit(1)
        from dispo_probe import fm, TOKENS
        print(f'🔑 token:{len(TOKENS)} 把 ・起點 {START}')
        obj, errs = build(fm, ref_tw, ref_05, ref_twoii=ref_ot)
    if errs:
        print('❌ 守門沒過 → 不寫檔:\n  ' + '\n  '.join(errs))
        sys.exit(1)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    with open(out, 'w') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    print(f'✅ 寫出 {out}({os.path.getsize(out) / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
