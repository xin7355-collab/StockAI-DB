#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔬 開盤區間突破 (ORB) 分K 回測 — 參數掃描(找正期望設定)
────────────────────────────────────────────────────────────
探針第 2 階段:資料面已確認可行(Shioaji kbars 深度 81 交易日、~3s/檔),
且 naive ORB(+1%/-0.5% 全做)≈ 打平。本輪掃描多組參數 + 過濾,扣當沖成本後
找「淨期望為正」的設定 → 值得才建 orb_miner 正式上線。

掃描維度:
  ・ 停利/停損(target/stop %):(0.5/0.3)(0.7/0.4)(1.0/0.5)(1.0/0.6)
  ・ 量能確認 volK:突破那根量 ≥ volK×開盤區間均量(0=不限 / 2.0=需爆量)
  ・ 開盤區間寬度上限 maxOR:OR 太寬(震盪)不做;固定 2.0%
  ・ 方向:做多 / 做空 分開
成本:當沖來回 ~0.25%(手續費打折×2 + 當沖稅減半),淨損益 = 毛損益 − COST。

⚠️ sandbox 連不到 Shioaji,只能 GitHub Actions 跑。結果印 log + 存 artifact。
"""
import os
import sys
import json
from datetime import datetime, timezone, timedelta

TW = timezone(timedelta(hours=8))
TEST_SYMS = ['2330', '2317', '2454', '2603', '2609', '3661', '3037', '2376']
OR_MINUTES = 15
NO_ENTRY_AFTER = (13, 0)
CLOSE_HHMM = (13, 25)
MAX_OR_PCT = 2.0            # OR 寬度 >2% 視為震盪,不做
COST_PCT = 0.25            # 當沖來回成本估計 %
# 掃描格點
TGT_STOP = [(0.5, 0.3), (0.7, 0.4), (1.0, 0.5), (1.0, 0.6)]
VOLK = [0.0, 2.0]
SIDES = ['long', 'short']


def _line(s):
    print(s, flush=True)


def _t(ts_ns):
    # Shioaji kbars ts 已是台灣牆鐘(naive),用 UTC 讀即得正確 09:00~13:30(勿再套 TW+8)
    return datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc)


def _after(t, hhmm):
    return t.hour > hhmm[0] or (t.hour == hhmm[0] and t.minute >= hhmm[1])


def find_contract(api, code):
    for exch_name in ('TSE', 'OTC'):
        try:
            exch = getattr(api.Contracts.Stocks, exch_name, None)
            if exch is None:
                continue
            try:
                c = exch[code]
            except Exception:
                c = None
            if c is not None:
                return c
        except Exception:
            continue
    try:
        for exch in api.Contracts.Stocks:
            for c in exch:
                if getattr(c, 'code', '') == code:
                    return c
    except Exception:
        pass
    return None


def build_days(bars):
    """把分K 拆成每個交易日的 OR 結構(只算一次,給多組參數共用)。
    回傳 list of {orh, orl, or_vavg, rest:[{t,o,h,l,c,v}]}"""
    by_day = {}
    for b in bars:
        by_day.setdefault(b['t'].strftime('%Y-%m-%d'), []).append(b)
    out = []
    for d in sorted(by_day.keys()):
        db = sorted(by_day[d], key=lambda x: x['t'])
        if len(db) < 20:
            continue
        or_end = db[0]['t'] + timedelta(minutes=OR_MINUTES)
        orb = [b for b in db if b['t'] < or_end]
        rest = [b for b in db if b['t'] >= or_end]
        if len(orb) < 3 or len(rest) < 5:
            continue
        orh = max(b['h'] for b in orb)
        orl = min(b['l'] for b in orb)
        if not (orh > 0 and orl > 0) or orh <= orl:
            continue
        or_vavg = sum(b['v'] for b in orb) / len(orb) if orb else 0
        out.append({'orh': orh, 'orl': orl, 'or_vavg': or_vavg, 'rest': rest})
    return out


def run_config(days, side, tgt, stop, volK):
    """對已拆好的日結構跑一組參數。回傳 (trig, win, gross_sum%)。"""
    trig = win = 0
    gross = 0.0
    for day in days:
        orh, orl, or_vavg, rest = day['orh'], day['orl'], day['or_vavg'], day['rest']
        if orl > 0 and (orh - orl) / orl * 100 > MAX_OR_PCT:   # OR 太寬(震盪)跳過
            continue
        # 進場:收盤突破 + 量能確認 + 不能太晚
        ei = None
        for i, b in enumerate(rest):
            if _after(b['t'], NO_ENTRY_AFTER):
                break
            brk = (b['c'] > orh) if side == 'long' else (b['c'] < orl)
            if brk and (volK <= 0 or (or_vavg > 0 and b['v'] >= volK * or_vavg)):
                ei = i
                break
        if ei is None:
            continue
        trig += 1
        entry = rest[ei]['c']
        seg = rest[ei + 1:]
        if side == 'long':
            target, stp = entry * (1 + tgt / 100), entry * (1 - stop / 100)
        else:
            target, stp = entry * (1 - tgt / 100), entry * (1 + stop / 100)
        got = False
        final = entry
        for b in seg:
            if _after(b['t'], CLOSE_HHMM):
                final = b['c']; break
            if side == 'long':
                if b['h'] >= target: got = True; final = target; break
                if b['l'] <= stp: final = stp; break
            else:
                if b['l'] <= target: got = True; final = target; break
                if b['h'] >= stp: final = stp; break
        else:
            final = seg[-1]['c'] if seg else entry
        if got:
            win += 1
        gross += ((final - entry) if side == 'long' else (entry - final)) / entry * 100
    return trig, win, gross


def main():
    key = os.environ.get('SHIOAJI_API_KEY', '').strip()
    sec = os.environ.get('SHIOAJI_SECRET_KEY', '').strip()
    result = {'ok': False, 'best': None, 'configs': []}
    if not key or not sec:
        _line('❌ 缺 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY'); _save(result); return
    try:
        import shioaji as sj
    except Exception as e:
        _line(f'❌ shioaji 未安裝: {e}'); _save(result); return

    api = sj.Shioaji()
    try:
        try:
            api.login(api_key=key, secret_key=sec, fetch_contract=True)
        except TypeError:
            api.login(api_key=key, secret_key=sec)
            try:
                api.fetch_contracts(contract_download=True)
            except Exception:
                pass
        _line('✅ Shioaji 登入成功')
    except Exception as e:
        _line(f'❌ Shioaji 登入失敗: {e}'); _save(result); return

    today = datetime.now(TW).date()
    start = (today - timedelta(days=120)).strftime('%Y-%m-%d')
    end = today.strftime('%Y-%m-%d')
    _line(f'📅 kbars {start} ~ {end} · 掃描 {len(TGT_STOP)}停損組×{len(VOLK)}量能×{len(SIDES)}方向,扣成本 {COST_PCT}%')
    _line('=' * 70)

    # 抓資料 + 拆日(每檔只做一次)
    days_by_sym = {}
    depth = 0
    for sym in TEST_SYMS:
        c = find_contract(api, sym)
        if c is None:
            _line(f'[{sym}] ⚠️ 無合約'); continue
        try:
            kb = api.kbars(c, start=start, end=end)
            ts = list(kb.ts)
            op, hi, lo, cl = list(kb.Open), list(kb.High), list(kb.Low), list(kb.Close)
            vol = list(getattr(kb, 'Volume', [0] * len(ts)))
            bars = [{'t': _t(ts[i]), 'o': op[i], 'h': hi[i], 'l': lo[i], 'c': cl[i], 'v': vol[i]}
                    for i in range(len(ts))]
            dd = build_days(bars)
            days_by_sym[sym] = dd
            depth = max(depth, len(dd))
            _line(f'[{sym}] {len(bars)} 筆分K · {len(dd)} 可用交易日')
        except Exception as e:
            _line(f'[{sym}] ❌ {type(e).__name__}: {str(e)[:120]}')
    try:
        api.logout()
    except Exception:
        pass

    if not days_by_sym:
        _line('❌ 無任何資料'); _save(result); return

    _line('=' * 70)
    _line('掃描結果(所有測試股 pooled,依「淨期望」排序):')
    rows = []
    for side in SIDES:
        for (tgt, stop) in TGT_STOP:
            for volK in VOLK:
                T = W = 0
                G = 0.0
                for sym, dd in days_by_sym.items():
                    t, w, g = run_config(dd, side, tgt, stop, volK)
                    T += t; W += w; G += g
                if T < 30:
                    continue
                gross_avg = G / T
                net_avg = gross_avg - COST_PCT
                rows.append({
                    'side': side, 'tgt': tgt, 'stop': stop, 'volK': volK,
                    'trig': T, 'win_rate': round(W / T * 100, 1),
                    'gross': round(gross_avg, 3), 'net': round(net_avg, 3),
                })
    rows.sort(key=lambda r: r['net'], reverse=True)
    result['configs'] = rows
    for r in rows:
        tag = '✅' if r['net'] > 0 else '  '
        _line(f"{tag} {r['side']:5s} 停利{r['tgt']}/停損{r['stop']} 量×{r['volK']} · "
              f"觸發{r['trig']:4d} 勝率{r['win_rate']:5.1f}% · 毛{r['gross']:+.3f}% 淨{r['net']:+.3f}%/趟")

    pos = [r for r in rows if r['net'] > 0]
    result['best'] = rows[0] if rows else None
    result['ok'] = len(pos) > 0
    _line('=' * 70)
    if pos:
        b = pos[0]
        _line(f"✅ 找到 {len(pos)} 組淨期望為正。最佳:{b['side']} 停利{b['tgt']}/停損{b['stop']} "
              f"量×{b['volK']} → 勝率 {b['win_rate']}% · 淨 {b['net']:+.3f}%/趟(扣成本後)")
        _line('   → 值得建 orb_miner:用此設定滾動全清單回測,前端候選榜加「ORB淨期望」欄')
    else:
        best = rows[0] if rows else None
        _line(f"⚠️ 沒有任何設定淨期望為正(最佳僅 {best['net'] if best else 'N/A'}%/趟)。")
        _line("   → ORB 在此區間扣成本後不划算;建議先別上,維持日K勝率排序(V68.8.9)。")
    _save(result)


def _save(result):
    try:
        os.makedirs('data', exist_ok=True)
        with open('data/orb_probe_result.json', 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        _line('💾 已存 data/orb_probe_result.json')
    except Exception as e:
        _line(f'⚠️ 存檔失敗: {e}')


if __name__ == '__main__':
    main()
