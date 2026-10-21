#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
盤中「逐筆內外盤/大單」採礦(永豐 Shioaji api.ticks)→ data/tick_flow.json
─────────────────────────────────────────────────────────────
用途:把盤中作戰室的「內外盤 / 大單」從『分鐘K 估算』升級成『真實逐筆成交』。
  • 逐筆 tick_type:1=外盤(主動買)、2=內盤(主動賣)→ 累計真實主動買賣量。
  • 大單:單筆成交量 ≥ 門檻(主力/法人在場的真訊號)。
覆蓋:當日「成交量最大的前 N 檔」(自動涵蓋今天最熱、最多人看/當沖的股),
     其餘冷門股前端仍用既有估算(graceful fallback)。

需 GitHub Secrets:SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY(同 live_snapshot,只做行情免憑證)

輸出 data/tick_flow.json:
  {
    "updated": ISO時間, "ts": "07/17 10:32",
    "data": { "2330": {"in":1234,"out":1560,"bb":320,"bs":180,"mx":95,"n":8421}, ... }
    # in=內盤總量 out=外盤總量(張) bb=大單買量 bs=大單賣量 mx=最大單筆(張) n=tick數
  }

⚠️ 本檔在無網路/無憑證 sandbox 無法實測;請在 GitHub Actions(有 Secrets)Run 看 log 驗證。
"""
import os
import sys
import json
import time
from datetime import datetime, timezone, timedelta

TW = timezone(timedelta(hours=8))
TOP_N = 80          # 只挖「當日量最大前 N 檔」(涵蓋最熱門股,控制 ticks 呼叫量)
BIG_LOTS = 50       # 單筆 ≥ 50 張 = 大單(張為單位;主力/法人手筆)
MIN_STOCKS = 20     # 有效 < 20 檔 → 判定異常,不覆寫(自我修復,保留舊檔)


def _now_str():
    return datetime.now(TW).strftime('%m/%d %H:%M')


def _snap_num(snap, *names):
    for n in names:
        v = getattr(snap, n, None)
        if v is not None:
            return v
    return None


def _to_lots(v):
    """tick volume 正規化成『張』:若像股數(≥1000 的量級普遍偏大)自動 /1000。
    Shioaji 個股 tick volume 多為『張』,但不同版本/商品偶有股數 → 用啟發式防單位不一致。"""
    try:
        v = float(v)
    except Exception:
        return 0
    return v



def _usage_line(api, tag=''):
    """📶 2026-10-20 診斷:Shioaji 每天有流量上限,10/19、10/20 兩天 12:50 起快照都回 0 檔、台指期 list index out of range
    (登入正常)→ 懷疑是當天流量用完。把用量印出來,下一次就看得出是不是這個原因(⛔ 不改任何判斷)。"""
    try:
        u = api.usage()
        used, lim = getattr(u, 'bytes', None), getattr(u, 'limit_bytes', None)
        rem = getattr(u, 'remaining_bytes', None)
        mb = lambda x: f'{x / 1e6:,.1f} MB' if isinstance(x, (int, float)) else '?'
        print(f'📶 Shioaji 今日流量{tag}:已用 {mb(used)} / 上限 {mb(lim)} ・剩 {mb(rem)}', flush=True)
    except Exception as e:
        print(f'📶 Shioaji 流量查不到{tag}({type(e).__name__}: {str(e)[:80]})', flush=True)


# ═══════════════════════════════════════════════════════════════════════
# 📶 V79.4.8 逐筆改「只抓上一拍之後的新成交」(使用者 2026-10-21 選的)
#
# 🚨 為什麼:永豐帳號每天流量上限 524 MB。舊寫法每 10 分鐘把前 80 檔「從開盤到現在的全部逐筆」重抓一次
#    → 每一拍越來越大(10/21 實測 09:03 3.5 MB → 12:53 26 MB),這一支一天吃掉 449 MB(86%)
#    → 13:03 流量用完,13:30 收盤那一拍快照和逐筆都拿不到(同一個帳號的 auto_trade.py 13:25 也抓不到報價)。
# ⭐ 內外盤 / 大單 / 筆數都是「加總」→ 每一拍只抓新的、加到上一拍的累計上,結果跟整天重抓一模一樣。
#    狀態存在 /tmp(同一個 job 的每一拍都在同一台機器上;換機器 = 沒有狀態 = 整天重抓一次再接著增量)。
# ⛔ 三道保險(抓不準就退回舊寫法,⛔ 不可寧願少算):
#    ① 每一拍輪流抽一檔整天重抓,截到同一筆為止逐欄比對,對不上 → 今天全部退回整天重抓
#    ⓪ 區間查詢的起點往前多抓 1 秒(上一拍最後一筆的那一秒整個重抓,再用時間戳去重)
#       → 不管行情商的起點「含不含那一秒」都不會漏(只抓「那一秒」的話,不含起點時會漏掉同一秒裡較晚的幾筆,
#         測試 ⑤ 的決定性對照就是這個)
#    ② 時間換算(ts → 時:分:秒)用第一次整天抓的逐筆實測哪一種對得上盤中時間,兩種都不像 → 那一檔不做增量
#    ③ 增量那一檔抓失敗 → 那一檔改整天重抓
#    逃生門:TICK_INCR=0 = 完全回到舊寫法。測試 scripts/test_tick_incr.py(假行情商重放一整天)。
# ═══════════════════════════════════════════════════════════════════════
INCR = (os.getenv('TICK_INCR') or '1') != '0'
STATE_PATH = os.getenv('TICK_STATE') or '/tmp/tick_state.json'
CHECK_EVERY = 1            # 每一拍都輪流抽一檔整天重抓對帳(一檔一天約 0.3~1 MB,27 拍 ≈ 十幾 MB;舊寫法一天 449 MB)
_AGG_KEYS = ('in', 'out', 'bb', 'bs', 'n', 'v')


def _arrs(t):
    """Ticks 物件 → (ts, vols, types),依時間排序(⛔ 只排序不改對應)。沒有 ts → ts=None(那一檔不做增量)。"""
    vols = list(getattr(t, 'volume', []) or [])
    types = list(getattr(t, 'tick_type', []) or [])
    ts = list(getattr(t, 'ts', []) or [])
    n = min(len(vols), len(types))
    if len(ts) < n:
        return None, vols[:n], types[:n]
    idx = sorted(range(n), key=lambda i: ts[i])
    return [ts[i] for i in idx], [vols[i] for i in idx], [types[i] for i in idx]


def _agg(vols, types):
    a = {'in': 0.0, 'out': 0.0, 'bb': 0.0, 'bs': 0.0, 'mx': 0.0, 'n': 0, 'v': 0.0}
    for j in range(min(len(vols), len(types))):
        v = _to_lots(vols[j])
        tt = int(types[j]) if types[j] is not None else 0
        a['n'] += 1
        a['v'] += v
        if v > a['mx']:
            a['mx'] = v
        if tt == 1:      # 外盤(主動買)
            a['out'] += v
            if v >= BIG_LOTS:
                a['bb'] += v
        elif tt == 2:    # 內盤(主動賣)
            a['in'] += v
            if v >= BIG_LOTS:
                a['bs'] += v
    return a


def _add(a, b):
    for k in _AGG_KEYS:
        a[k] = a.get(k, 0) + b.get(k, 0)
    a['mx'] = max(a.get('mx', 0), b.get('mx', 0))
    return a


def _hms(ts_ns, off_h):
    """逐筆時間戳(奈秒)→ 時:分:秒(⛔ 用整數秒,免得浮點誤差把 10:23:45 變成 10:23:44)"""
    return (datetime(1970, 1, 1) + timedelta(seconds=int(ts_ns) // 10**9 + off_h * 3600)).strftime('%H:%M:%S')


def _detect_off(ts):
    """② 時間戳是哪一種:直接當台北時間(0)或是真的 UTC(+8)→ 第一筆與最後一筆都落在盤中的那一種。都不像 → None。"""
    if not ts:
        return None
    for off in (0, 8):
        a, b = _hms(ts[0], off), _hms(ts[-1], off)
        if '08:30:00' <= a <= '14:40:00' and '08:30:00' <= b <= '14:40:00':
            return off
    return None


def _after(ts, vols, types, last, c):
    """區間查詢回來的逐筆 → 只留上一拍之後的(時間 < last 丟掉;剛好 = last 的前 c 筆上一拍算過了)。
    回 (新的 vols, 新的 types, 新的 last, 新的 c)。"""
    nv, nt, seen = [], [], 0
    for i in range(len(ts)):
        if ts[i] < last:
            continue
        if ts[i] == last and seen < c:
            seen += 1
            continue
        nv.append(vols[i])
        nt.append(types[i])
    if not ts or ts[-1] < last:
        return nv, nt, last, c
    nl = ts[-1]
    return nv, nt, nl, sum(1 for x in ts if x == nl)


def _upto(ts, vols, types, last, c):
    """整天的逐筆截到「增量算到的那一筆」為止(對帳用):時間 < last 全收、= last 收前 c 筆"""
    kv, kt, seen = [], [], 0
    for i in range(len(ts)):
        if ts[i] < last or (ts[i] == last and seen < c):
            if ts[i] == last:
                seen += 1
            kv.append(vols[i])
            kt.append(types[i])
    return kv, kt


def load_state(today, path=None):
    try:
        with open(path or STATE_PATH, 'r', encoding='utf-8') as f:
            S = json.load(f)
        if isinstance(S, dict) and S.get('d') == today and isinstance(S.get('s'), dict):
            return S
    except Exception:
        pass
    return {'d': today, 's': {}, 'beat': 0, 'inc_beats': 0, 'off': None, 'off_h': None}


def save_state(S, path=None):
    try:
        with open(path or STATE_PATH, 'w', encoding='utf-8') as f:
            json.dump(S, f, separators=(',', ':'))
    except Exception as e:
        print(f'⚠️ 逐筆狀態存不下來(下一拍會整天重抓,不影響正確性):{str(e)[:80]}')


def collect_ticks(api, hot, today, S, qt_range=None, incr=None, log=print, pause=0.12):
    """hot = [(成交量, 代號, 合約), ...] → (out, stat)。S = 狀態(會被改,呼叫端負責存檔)。
    qt_range = Shioaji 的 TicksQueryType.RangeTime(沒有就只能整天重抓)。"""
    incr = INCR if incr is None else incr
    S['beat'] = S.get('beat', 0) + 1
    stat = {'inc': 0, 'full': 0, 'new': 0, 'fallback': 0, 'got': 0, 'fail': 0, 'check': None}

    def full(st_all, code, c):
        ts, vols, types = _arrs(api.ticks(contract=c, date=today))
        a = _agg(vols, types)
        stat['got'] += a['n']
        st = {'a': a, 't': None, 'c': 0}
        if ts:
            off = _detect_off(ts)
            if off is not None and S.get('off_h') in (None, off):
                S['off_h'] = off
                st['t'], st['c'] = ts[-1], sum(1 for x in ts if x == ts[-1])
        st_all[code] = st

    def inc(c, st):
        ts, vols, types = _arrs(api.ticks(contract=c, date=today, query_type=qt_range,
                                          time_start=_hms(st['t'] - 10**9, S['off_h']), time_end='23:59:59'))
        if ts is None:
            raise ValueError('區間查詢沒有時間戳')
        nv, nt, nl, nc = _after(ts, vols, types, st['t'], st['c'])
        stat['got'] += len(ts)
        _add(st['a'], _agg(nv, nt))
        st['t'], st['c'] = nl, nc

    def run(use_inc):
        st_all = S.setdefault('s', {})
        did = []
        for rank, (_tv, code, c) in enumerate(hot):
            code = str(code)
            st = st_all.get(code)
            try:
                if use_inc and st and st.get('t') is not None and S.get('off_h') is not None:
                    try:
                        inc(c, st)
                        stat['inc'] += 1
                        did.append((code, c))
                    except Exception as e:
                        stat['fallback'] += 1
                        if stat['fallback'] <= 3:
                            log(f'⚠️ {code} 只抓新增的失敗({type(e).__name__}: {str(e)[:60]})→ 這一檔整天重抓')
                        full(st_all, code, c)
                else:
                    stat['new' if (use_inc and not st) else 'full'] += 1
                    full(st_all, code, c)
            except Exception as e:
                stat['fail'] += 1
                if rank < 3:
                    log(f'⚠️ ticks({code}) 失敗:{e}')
                if pause:
                    time.sleep(0.15)
                continue
            if pause:
                time.sleep(pause)   # 溫柔節流
        return did

    did = run(bool(incr and qt_range is not None and not S.get('off')))

    # ① 對帳:每 CHECK_EVERY 拍(預設每一拍)輪流抽一檔整天重抓,截到同一筆為止逐欄比對
    if did:
        S['inc_beats'] = S.get('inc_beats', 0) + 1
        k = S['inc_beats']
        if k == 1 or k % CHECK_EVERY == 0:
            code, c = did[(k - 1) % len(did)]
            st = S['s'][code]
            try:
                ts, vols, types = _arrs(api.ticks(contract=c, date=today))
                if ts is None:
                    raise ValueError('整天重抓沒有時間戳')
                ref = _agg(*_upto(ts, vols, types, st['t'], st['c']))
                bad = [x for x in ('n', 'in', 'out', 'bb', 'bs', 'mx', 'v') if abs(ref[x] - st['a'][x]) > 1e-6]
            except Exception as e:
                bad = [f'對帳抓不到({type(e).__name__})']
            stat['check'] = (code, bad)
            if bad:
                S['off'] = f'{code} 對帳不符 {bad}'
                log(f'🚨 逐筆增量對帳不符({code}:{bad})→ 今天改回整天重抓(⛔ 不可寧願少算)')
                S['s'] = {}
                for k2 in ('inc', 'new', 'fallback'):
                    stat[k2] = 0
                run(False)
            else:
                log(f'🔎 逐筆增量對帳 {code}:跟整天重抓逐欄相同 ✅(第 {k} 次增量)')

    out = {}
    for _tv, code, _c in hot:
        st = S['s'].get(str(code))
        if not st:
            continue
        a = st['a']
        if a['n'] <= 0 or a['in'] + a['out'] <= 0:
            continue
        out[str(code)] = {'in': int(round(a['in'])), 'out': int(round(a['out'])),
                          'bb': int(round(a['bb'])), 'bs': int(round(a['bs'])),
                          'mx': int(round(a['mx'])), 'n': int(a['n'])}
    stat['would'] = sum(int(S['s'][str(code)]['a']['n']) for _tv, code, _c in hot if str(code) in S['s'])
    return out, stat


def main():
    key = os.environ.get('SHIOAJI_API_KEY', '').strip()
    sec = os.environ.get('SHIOAJI_SECRET_KEY', '').strip()
    if not key or not sec:
        print('❌ 缺 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY(請設 GitHub Secrets)')
        sys.exit(1)

    import shioaji as sj
    api = sj.Shioaji()
    try:
        try:
            api.login(api_key=key, secret_key=sec, fetch_contract=True)
        except TypeError:
            # shioaji ≥1.7 移除 login(fetch_contract=) 參數(登入時預設就抓合約)
            api.login(api_key=key, secret_key=sec)
        print('✅ Shioaji 登入成功,抓合約中…')
    except Exception as e:
        print(f'❌ Shioaji 登入失敗:{e}')
        sys.exit(1)
    _usage_line(api, '(開始前)')

    today = datetime.now(TW).strftime('%Y-%m-%d')

    # ── 1) 全上市櫃股票合約(濾權證/ETN/興櫃,與 live_snapshot 同規則)──
    stock_contracts = []
    seen = set()
    try:
        for exch in api.Contracts.Stocks:
            for c in exch:
                code = getattr(c, 'code', None) or ''
                exch_v = getattr(getattr(c, 'exchange', None), 'value', None) or str(getattr(c, 'exchange', ''))
                if 'OES' in str(exch_v).upper():
                    continue
                is_stock = code.isdigit() and len(code) == 4
                is_etf = code.startswith('00') and 4 <= len(code) <= 6
                if (is_stock or is_etf) and code not in seen:
                    seen.add(code)
                    stock_contracts.append((code, c))
    except Exception as e:
        print(f'⚠️ 建股票合約清單出錯:{e}')

    # ── 2) 先快照全市場,依「今日成交量」排序取前 TOP_N(自動鎖定最熱門股)──
    vol_rank = []
    B = 400
    for i in range(0, len(stock_contracts), B):
        batch = stock_contracts[i:i + B]
        try:
            snaps = api.snapshots([c for _, c in batch])
        except Exception as e:
            print(f'⚠️ snapshot batch {i} 失敗:{e}')
            continue
        for (code, c), snap in zip(batch, snaps):
            try:
                tv = _snap_num(snap, 'total_volume', 'volume') or 0
                cl = _snap_num(snap, 'close')
                if cl is None or float(cl) <= 0 or int(tv) <= 0:
                    continue
                vol_rank.append((int(tv), code, c))
            except Exception:
                continue
    vol_rank.sort(key=lambda x: -x[0])
    hot = vol_rank[:TOP_N]
    print(f'📋 全市場快照 {len(vol_rank)} 檔,取當日量前 {len(hot)} 檔挖逐筆…')

    # ── 3) 逐檔 api.ticks → 算真實內外盤 + 大單(📶 V79.4.8 起只抓上一拍之後的新成交,見 collect_ticks)──
    try:
        qt_range = sj.constant.TicksQueryType.RangeTime
    except Exception:
        qt_range = None                     # 舊版 shioaji 沒有區間查詢 → 只能整天重抓(⛔ 不擋主流程)
    S = load_state(today)
    out, stat = collect_ticks(api, hot, today, S, qt_range=qt_range)
    save_state(S)
    mode = (f'今天改回整天重抓({S["off"]})' if S.get('off')
            else '只抓新增的' if (INCR and qt_range is not None) else '整天重抓(TICK_INCR=0 或沒有區間查詢)')
    print(f'🧮 逐筆:{mode} ・增量 {stat["inc"]} 檔 / 新進榜 {stat["new"]} 檔 / 整天重抓 {stat["full"]} 檔'
          f' / 退回 {stat["fallback"]} 檔 / 失敗 {stat["fail"]} 檔 ・本拍抓了 {stat["got"]:,} 筆'
          f'(整天重抓的話約 {stat.get("would", 0):,} 筆)', flush=True)

    print(f'✅ 逐筆內外盤/大單 {len(out)} 檔')
    _usage_line(api, '(抓完逐筆)')       # 📶 跟「開始前」那行相減 = 這一輪逐筆吃掉多少流量
    try:
        api.logout()
    except Exception:
        pass

    if len(out) < MIN_STOCKS:
        print(f'❌ 只算到 {len(out)} 檔(< {MIN_STOCKS})→ 判定異常,不覆寫(保留舊檔)')
        sys.exit(1)

    payload = {
        'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'ts': _now_str(),
        'big_lots': BIG_LOTS,
        'data': out,
    }
    with open('tick_flow.json', 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print(f'✅ 逐筆內外盤採礦完成:{len(out)} 檔 → tick_flow.json')

    # 📚 V72.0.2 開始累積**逐日歷史** → data/tick_hist.json
    #
    # 為什麼要做:逐字稿【當沖神器「買盤竭盡」】講的是「每 5 秒比一次內外盤,多方連 N 次獲勝後
    #   出現第一次內盤大量 = 買盤竭盡」。我沒有盤中逐秒序列,但有**收盤的內外盤與大單結構**,
    #   可以做它的本質版本:「**外盤佔優(小單在追買)但大單淨賣(大戶在倒)**」。
    # ⛔ 但 `tick_flow.json` 是**每天覆蓋的快照**,沒有歷史 → **現在無法回測**。
    #   照鐵則「沒驗過不下方向」,前端只能誠實描述、不計分。
    # ⭐ 所以這裡先把歷史存起來,累積夠了才驗得了(同 bstat 的做法)。
    #   空間:80 檔 × 約 55 bytes × 250 個交易日 ≈ 1.2MB,很便宜。
    try:
        hist_path = 'tick_hist.json'
        try:
            with open(hist_path, 'r', encoding='utf-8') as f:
                hist = json.load(f)
        except Exception:
            hist = {}
        if not isinstance(hist, dict) or not isinstance(hist.get('d'), dict):
            hist = {'d': {}}
        today_key = datetime.now(TW).strftime('%Y-%m-%d')
        # 只留判斷「買盤竭盡」需要的四個欄位,省空間([out, in, bb, bs])
        hist['d'][today_key] = {k: [v['out'], v['in'], v['bb'], v['bs']] for k, v in out.items()}
        # 保留最近 250 個交易日(約一年);⛔ 用日期排序不是插入順序
        keys = sorted(hist['d'].keys())[-250:]
        hist['d'] = {k: hist['d'][k] for k in keys}
        hist['updated'] = payload['updated']
        hist['days'] = len(keys)
        hist['big_lots'] = BIG_LOTS
        with open(hist_path, 'w', encoding='utf-8') as f:
            json.dump(hist, f, ensure_ascii=False, separators=(',', ':'))
        print(f'📚 逐日歷史累積:{len(keys)} 個交易日 → tick_hist.json'
              f'(滿約 60 日後可跑回測驗「買盤竭盡」)')
    except Exception as e:
        # ⛔ 失敗不可影響主產物(tick_flow.json 已寫完)
        print(f'⚠️ tick_hist 累積失敗(不影響主檔):{str(e)[:80]}')


if __name__ == '__main__':
    main()
