#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔬 開盤區間突破 (ORB) 分K 回測 — 可行性探針
────────────────────────────────────────────────────────────
目的(在正式建 orb_miner 前先實測,同董監質押 B 案的「探針先行」節奏):
  1. Shioaji api.kbars() 到底能抓多深的「歷史 1 分K」?(ORB 回測要 ≥30 交易日才有意義)
  2. 抓 N 檔要多久 / 會不會撞限流?
  3. 真的跑一遍 ORB 回測,看勝率有沒有「鑑別度」(每檔不同、合理),值不值得正式上線。

策略(ORB, 開盤區間突破,當沖經典):
  ・ 開盤區間 = 09:00–09:15(前 15 分)的最高(ORH)/最低(ORL)
  ・ 做多:09:15 後價格突破 ORH → 以 ORH 進場;停利 +1.0%,停損跌回 ORL,13:25 前未觸發則收盤結清
  ・ 勝 = 先到停利(+1%)才算贏;另記 MFE(盤中最大有利幅度)與收盤損益
  ・ 做空:鏡像(跌破 ORL 進場)

⚠️ sandbox 連不到 Shioaji,只能在 GitHub Actions(有 SHIOAJI_API_KEY/SECRET_KEY)跑。
   結果印 log + 存 data/orb_probe_result.json 上傳 artifact。不部署、不碰 data/gh-pages。
"""
import os
import sys
import json
from datetime import datetime, timezone, timedelta

TW = timezone(timedelta(hours=8))

# 測試標的:高量、當沖熱門(權值 + 中小型飆股 + 航運),涵蓋不同性格
TEST_SYMS = ['2330', '2317', '2454', '2603', '2609', '3661', '3037', '2376']

# ORB 參數
OR_MINUTES = 15         # 開盤區間長度(分)
TARGET_PCT = 1.0        # 停利 %
CLOSE_HHMM = (13, 25)   # 當沖強制平倉時間


def _line(s):
    print(s, flush=True)


def _t(ts_ns):
    """Shioaji ts(奈秒 epoch)→ 台北時間 datetime"""
    return datetime.fromtimestamp(ts_ns / 1e9, tz=TW)


def find_contract(api, code):
    """在 TSE/OTC 找股票合約"""
    for exch_name in ('TSE', 'OTC'):
        try:
            exch = getattr(api.Contracts.Stocks, exch_name, None)
            if exch is None:
                continue
            c = exch.get(code) if hasattr(exch, 'get') else None
            if c is None:
                try:
                    c = exch[code]
                except Exception:
                    c = None
            if c is not None:
                return c
        except Exception:
            continue
    # 保底:整包掃
    try:
        for exch in api.Contracts.Stocks:
            for c in exch:
                if getattr(c, 'code', '') == code:
                    return c
    except Exception:
        pass
    return None


STOP_PCT = 0.5           # 停損 %(固定百分比,比用 ORL/ORH 當停損穩定)
NO_ENTRY_AFTER = (13, 0)  # 這時間後才突破就不進(當沖收尾沒空間)


def _after(t, hhmm):
    return t.hour > hhmm[0] or (t.hour == hhmm[0] and t.minute >= hhmm[1])


def backtest_orb(bars, side='long', debug_tag=None):
    """
    bars: list of dict {t,o,h,l,c,v}  單一標的多日 1 分K
    ORB 正解:開盤前 OR_MINUTES 分定 ORH/ORL;做多=某分K「收盤」突破 ORH 才進場(進場價=該K收盤,
    非只觸到最高→避免從最高量 MFE 退化成 0);停利 +TARGET_PCT%、停損 -STOP_PCT%、13:25 平倉。
    回傳 {days, trig, win, win_rate, avg_mfe, avg_pnl}
    """
    days = {}
    for b in bars:
        days.setdefault(b['t'].strftime('%Y-%m-%d'), []).append(b)

    trig = win = 0
    mfe_sum = pnl_sum = 0.0
    dbg_done = False
    for d in sorted(days.keys()):
        day_bars = sorted(days[d], key=lambda x: x['t'])
        if not day_bars:
            continue
        open_t = day_bars[0]['t']
        or_end = open_t + timedelta(minutes=OR_MINUTES)
        or_bars = [b for b in day_bars if b['t'] < or_end]
        rest = [b for b in day_bars if b['t'] >= or_end]
        if len(or_bars) < 3 or len(rest) < 5:
            continue
        orh = max(b['h'] for b in or_bars)
        orl = min(b['l'] for b in or_bars)
        if not (orh > 0 and orl > 0) or orh <= orl:
            continue

        # 找「收盤突破」進場點(且不能太晚)
        ei = None
        for i, b in enumerate(rest):
            if _after(b['t'], NO_ENTRY_AFTER):
                break
            if (side == 'long' and b['c'] > orh) or (side == 'short' and b['c'] < orl):
                ei = i
                break
        if ei is None:
            continue
        trig += 1
        entry = rest[ei]['c']
        seg = rest[ei + 1:]   # 進場後的 K 才算損益(進場那根已用收盤成交)
        if side == 'long':
            target, stop = entry * (1 + TARGET_PCT / 100), entry * (1 - STOP_PCT / 100)
        else:
            target, stop = entry * (1 - TARGET_PCT / 100), entry * (1 + STOP_PCT / 100)

        got_win = False
        mfe = 0.0
        final = entry
        for b in seg:
            if _after(b['t'], CLOSE_HHMM):
                final = b['c']
                break
            if side == 'long':
                mfe = max(mfe, (b['h'] - entry) / entry * 100)
                if b['h'] >= target:
                    got_win = True; final = target; break
                if b['l'] <= stop:
                    final = stop; break
            else:
                mfe = max(mfe, (entry - b['l']) / entry * 100)
                if b['l'] <= target:
                    got_win = True; final = target; break
                if b['h'] >= stop:
                    final = stop; break
        else:
            final = seg[-1]['c'] if seg else entry

        if got_win:
            win += 1
        mfe_sum += mfe
        pnl_sum += ((final - entry) if side == 'long' else (entry - final)) / entry * 100

        if debug_tag and not dbg_done:
            _line(f'    🐞[{debug_tag} {d}] ORH={orh:.2f} ORL={orl:.2f} entry={entry:.2f} '
                  f'tgt={target:.2f} stop={stop:.2f} win={got_win} mfe={mfe:.2f}% seg={len(seg)}')
            dbg_done = True

    return {
        'days': len(days),
        'trig': trig,
        'win': win,
        'win_rate': round(win / trig * 100, 1) if trig else None,
        'avg_mfe': round(mfe_sum / trig, 2) if trig else None,
        'avg_pnl': round(pnl_sum / trig, 2) if trig else None,
    }


def main():
    key = os.environ.get('SHIOAJI_API_KEY', '').strip()
    sec = os.environ.get('SHIOAJI_SECRET_KEY', '').strip()
    result = {'ok': False, 'depth': None, 'stocks': {}, 'note': ''}
    if not key or not sec:
        _line('❌ 缺 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY(GitHub Secrets)')
        _save(result)
        return

    try:
        import shioaji as sj
    except Exception as e:
        _line(f'❌ shioaji 未安裝: {e}')
        _save(result)
        return

    api = sj.Shioaji()
    try:
        try:
            api.login(api_key=key, secret_key=sec, fetch_contract=True)   # shioaji <1.7
        except TypeError:
            api.login(api_key=key, secret_key=sec)                        # shioaji >=1.7(移除 fetch_contract)
            try:
                api.fetch_contracts(contract_download=True)
            except Exception:
                pass
        _line('✅ Shioaji 登入成功')
    except Exception as e:
        _line(f'❌ Shioaji 登入失敗: {e}')
        _save(result)
        return

    # 抓最近 ~120 天(看實際能回多深)
    today = datetime.now(TW).date()
    start = (today - timedelta(days=120)).strftime('%Y-%m-%d')
    end = today.strftime('%Y-%m-%d')
    _line(f'📅 kbars 請求區間: {start} ~ {end}(實測能回多深)')
    _line('=' * 64)

    t0 = datetime.now(TW)
    for sym in TEST_SYMS:
        c = find_contract(api, sym)
        if c is None:
            _line(f'[{sym}] ⚠️ 找不到合約,略過')
            result['stocks'][sym] = {'error': 'no_contract'}
            continue
        try:
            kb = api.kbars(c, start=start, end=end)
            ts = list(kb.ts)
            op, hi, lo, cl = list(kb.Open), list(kb.High), list(kb.Low), list(kb.Close)
            vol = list(getattr(kb, 'Volume', [0] * len(ts)))
            n = len(ts)
            if n == 0:
                _line(f'[{sym}] ⚠️ kbars 回 0 筆')
                result['stocks'][sym] = {'bars': 0}
                continue
            bars = []
            for i in range(n):
                bars.append({'t': _t(ts[i]), 'o': op[i], 'h': hi[i], 'l': lo[i], 'c': cl[i], 'v': vol[i]})
            first_d = bars[0]['t'].strftime('%Y-%m-%d')
            last_d = bars[-1]['t'].strftime('%Y-%m-%d')
            n_days = len(set(b['t'].strftime('%Y-%m-%d') for b in bars))
            lng = backtest_orb(bars, 'long', debug_tag=(f'{sym}多' if sym == TEST_SYMS[0] else None))
            sht = backtest_orb(bars, 'short')
            result['stocks'][sym] = {'bars': n, 'days': n_days, 'first': first_d, 'last': last_d,
                                     'long': lng, 'short': sht}
            _line(f'[{sym}] {n} 筆分K · {n_days} 交易日({first_d}~{last_d})')
            _line(f'    📈 做多ORB: 觸發 {lng["trig"]}/{lng["days"]} 日 · 勝率 {lng["win_rate"]}% · 均MFE {lng["avg_mfe"]}% · 均損益 {lng["avg_pnl"]}%')
            _line(f'    📉 做空ORB: 觸發 {sht["trig"]}/{sht["days"]} 日 · 勝率 {sht["win_rate"]}% · 均MFE {sht["avg_mfe"]}% · 均損益 {sht["avg_pnl"]}%')
        except Exception as e:
            _line(f'[{sym}] ❌ kbars/回測失敗: {type(e).__name__}: {str(e)[:160]}')
            result['stocks'][sym] = {'error': str(e)[:160]}

    elapsed = (datetime.now(TW) - t0).total_seconds()
    # 判定可行性:至少一檔有 ≥30 交易日 + 觸發數合理
    depths = [v.get('days', 0) for v in result['stocks'].values() if isinstance(v, dict)]
    max_days = max(depths) if depths else 0
    result['depth'] = max_days
    result['elapsed_sec'] = round(elapsed, 1)
    result['ok'] = max_days >= 30
    _line('=' * 64)
    _line(f'⏱️ {len(TEST_SYMS)} 檔耗時 {elapsed:.1f}s · 最深 {max_days} 交易日')
    if result['ok']:
        _line('✅ 可行:分K 深度足夠(≥30 交易日)→ 可正式建 orb_miner(滾動全清單回測 → data/orb_stats.json)')
        result['note'] = f'depth={max_days}d, {elapsed:.0f}s/{len(TEST_SYMS)}檔 → 全清單~100檔估 {elapsed/len(TEST_SYMS)*100:.0f}s'
    else:
        _line(f'⚠️ 深度不足(最深僅 {max_days} 交易日)→ Shioaji 免費 kbars 回溯有限,ORB 回測樣本太少,建議改用日K open→high 近似(免挖礦,已在前端)')
        result['note'] = f'depth不足 {max_days}d'

    try:
        api.logout()
    except Exception:
        pass
    _save(result)


def _save(result):
    try:
        os.makedirs('data', exist_ok=True)
        with open('data/orb_probe_result.json', 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        _line('💾 已存 data/orb_probe_result.json')
    except Exception as e:
        _line(f'⚠️ 存檔失敗(不影響 log): {e}')


if __name__ == '__main__':
    main()
