#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
個股期貨夜盤採礦(永豐 Shioaji)→ data/stock_futures_night.json
─────────────────────────────────────────────────────────────
用途:抓「個股期貨近月合約」的即時漲跌%(含夜盤 15:00~次日 05:00),
     給前端「🎯 當沖作戰室 → 🏀 個股期貨夜盤補漲」卡使用(夜盤期貨領先現貨=補漲訊號)。

需 GitHub Secrets(絕不硬編進程式):
  SHIOAJI_API_KEY      永豐 e-Leader 產生的 API Key
  SHIOAJI_SECRET_KEY   對應 Secret Key
  (只要「行情」不下單 → 不需憑證 CA.pfx)

輸出 data/stock_futures_night.json:
  { "updated": ISO時間, "data": { "2408": {"nightChgPct": 1.8, "price": 235.0, "vol": 1234, "ts":"07/13 22:30"}, ... } }

前端 _stockFutureNight(sym) 會讀 this._stockFutureCache[sym] → 卡片自動生效。
⚠️ 本檔在無網路/無憑證的 sandbox 無法實測;請在 GitHub Actions(有 Secrets)手動 Run 一次看 log 驗證。
"""
import os
import sys
import json
from datetime import datetime, timezone, timedelta

TW = timezone(timedelta(hours=8))


def _now_str():
    return datetime.now(TW).strftime('%m/%d %H:%M')


def _is_day_session(dt=None):
    """🚨 V78.1.4 平日台北 08:45~15:00 = 日盤(含 13:45~15:00 收盤後到夜盤開始前)。
    這段時間抓到的漲跌是**日盤**的,⛔ 不可寫成「夜盤」。
    實例(2026-10-01):這支跟在 theme_news 後面,而 theme_news 排程被延遲到台北 09:26 才跑
    → stock_futures_night.json 的 ts 寫成「10/01 09:30」= 日盤資料標成夜盤(CLAUDE.md 早就警告過)。
    週六日沒有日盤 → 不擋(最後一筆成交是週五夜盤)。"""
    dt = dt or datetime.now(TW)
    if dt.weekday() >= 5:
        return False
    hm = dt.hour * 60 + dt.minute
    return 8 * 60 + 45 <= hm < 15 * 60


def _usage_line(api, tag=''):
    """📶 V79.5.2 同 tick_flow_miner / live_snapshot_miner 那支:把永豐今天的流量印出來(⛔ 不改任何判斷)。
    🚨 10/20 起連 9 輪「找到 271 檔合約、報價 0 檔」而且沒有任何例外 —— 同一段時間白天的快照也在 12:50 之後回 0 檔
    (那兩支查到是當天流量用完)。夜盤這支要靠 log 才分得出是不是同一件事。"""
    try:
        u = api.usage()
        used, lim = getattr(u, 'bytes', None), getattr(u, 'limit_bytes', None)
        rem = getattr(u, 'remaining_bytes', None)
        mb = lambda x: f'{x / 1e6:,.1f} MB' if isinstance(x, (int, float)) else '?'
        print(f'📶 Shioaji 今日流量{tag}:已用 {mb(used)} / 上限 {mb(lim)} ・剩 {mb(rem)}', flush=True)
    except Exception as e:
        print(f'📶 Shioaji 流量查不到{tag}({type(e).__name__}: {str(e)[:80]})', flush=True)


def main():
    if _is_day_session():
        print(f'⏭️ 現在台北 {_now_str()} 是日盤時段(08:45~15:00)→ ⛔ 不可寫成夜盤,不登入、不產出(保留上一輪夜盤資料)')
        sys.exit(1)
    key = os.environ.get('SHIOAJI_API_KEY', '').strip()
    sec = os.environ.get('SHIOAJI_SECRET_KEY', '').strip()
    if not key or not sec:
        print('❌ 缺 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY(請設 GitHub Secrets)')
        sys.exit(1)

    import shioaji as sj
    api = sj.Shioaji()
    try:
        api.login(api_key=key, secret_key=sec, fetch_contract=True)
        print('✅ Shioaji 登入成功,抓合約中…')
    except Exception as e:
        print(f'❌ Shioaji 登入失敗:{e}')
        sys.exit(1)

    # 建「標的股票代號 → 近月個股期貨合約」對照(個股期貨合約帶 underlying_code)
    fut_by_stock = {}
    try:
        for cat in api.Contracts.Futures:
            for c in cat:
                uc = getattr(c, 'underlying_code', None)   # 個股期貨=標的股票代號;指數期貨無此欄
                if not uc:
                    continue
                dd = str(getattr(c, 'delivery_date', '') or '')
                prev = fut_by_stock.get(uc)
                # 取交割日最近且未過期(> 今日)的近月合約
                today = datetime.now(TW).strftime('%Y/%m/%d')
                if not dd or dd < today:   # 🐛 空交割日占位合約也跳過(否則 '' < 任何日期 → 被誤選成近月)
                    continue
                if prev is None or dd < str(getattr(prev, 'delivery_date', '') or '9999'):
                    fut_by_stock[uc] = c
    except Exception as e:
        print(f'⚠️ 建合約對照出錯:{e}')

    print(f'📋 找到 {len(fut_by_stock)} 檔個股期貨(近月)')
    _usage_line(api, '(開始)')
    contracts = list(fut_by_stock.items())   # [(stock_id, contract), ...]
    out = {}
    # 🔎 V79.5.2 「0 檔」時要分得出是哪一種:快照整批沒回來 / 回來了但漲跌是空的 / 每筆都丟例外(以前三種都只印「0 檔」)
    diag = {'sent': 0, 'got': 0, 'cr_none': 0, 'exc': [], 'sample': []}
    # 分批 snapshot(避免單次過多);snapshots 回傳與傳入同序
    B = 400
    for i in range(0, len(contracts), B):
        batch = contracts[i:i + B]
        diag['sent'] += len(batch)
        try:
            snaps = api.snapshots([c for _, c in batch])
        except Exception as e:
            print(f'⚠️ snapshot batch {i} 失敗:{e}')
            if len(diag['exc']) < 3:
                diag['exc'].append(f'batch {i}: {type(e).__name__}: {str(e)[:200]}')
            continue
        diag['got'] += len(snaps or [])
        for (sid, _c), snap in zip(batch, snaps or []):
            try:
                if len(diag['sample']) < 3:
                    diag['sample'].append({k: getattr(snap, k, '—') for k in
                                           ('code', 'ts', 'close', 'change_rate', 'change_price', 'total_volume')})
                cr = getattr(snap, 'change_rate', None)     # 漲跌%
                cl = getattr(snap, 'close', None)           # 最新價
                tv = getattr(snap, 'total_volume', 0)       # 累計量(口)
                if cr is None:
                    diag['cr_none'] += 1
                    continue
                out[str(sid)] = {
                    'nightChgPct': round(float(cr), 2),
                    'price': round(float(cl), 2) if cl is not None else None,
                    'vol': int(tv or 0),
                    'ts': _now_str(),
                }
            except Exception as e:
                if len(diag['exc']) < 3:
                    diag['exc'].append(f'{sid}: {type(e).__name__}: {str(e)[:200]}')
                continue

    # 🐛 自我修復:抓太少(如深夜多數無成交 change_rate=None)不覆寫,不寫檔 → workflow 略過部署,
    #    保留上一輪(22:00)的好資料,避免用空 {} 洗掉夜盤補漲卡。
    MIN_FUT = 30
    if len(out) < MIN_FUT:
        print(f'❌ 只抓到 {len(out)} 檔(< {MIN_FUT},夜盤多數無成交)→ 不產出 JSON,保留上一輪資料')
        print(f'   🔎 送出 {diag["sent"]} 檔 ・快照回來 {diag["got"]} 筆 ・漲跌是空的 {diag["cr_none"]} 筆 ・例外 {len(diag["exc"])} 則')
        for x in diag['sample']:
            print(f'   🔎 快照樣本:{x}')
        for x in diag['exc']:
            print(f'   🔎 例外原文:{x}')
        _usage_line(api, '(結束)')
        try:
            api.logout()
        except Exception:
            pass
        sys.exit(1)

    try:
        api.logout()
    except Exception:
        pass

    payload = {'updated': datetime.now(TW).isoformat(), 'data': out}
    with open('stock_futures_night.json', 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f'✅ 個股期貨夜盤採礦完成:{len(out)} 檔 → stock_futures_night.json')


if __name__ == '__main__':
    main()
