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


def main():
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
    contracts = list(fut_by_stock.items())   # [(stock_id, contract), ...]
    out = {}
    # 分批 snapshot(避免單次過多);snapshots 回傳與傳入同序
    B = 400
    for i in range(0, len(contracts), B):
        batch = contracts[i:i + B]
        try:
            snaps = api.snapshots([c for _, c in batch])
        except Exception as e:
            print(f'⚠️ snapshot batch {i} 失敗:{e}')
            continue
        for (sid, _c), snap in zip(batch, snaps):
            try:
                cr = getattr(snap, 'change_rate', None)     # 漲跌%
                cl = getattr(snap, 'close', None)           # 最新價
                tv = getattr(snap, 'total_volume', 0)       # 累計量(口)
                if cr is None:
                    continue
                out[str(sid)] = {
                    'nightChgPct': round(float(cr), 2),
                    'price': round(float(cl), 2) if cl is not None else None,
                    'vol': int(tv or 0),
                    'ts': _now_str(),
                }
            except Exception:
                continue

    try:
        api.logout()
    except Exception:
        pass

    # 🐛 自我修復:抓太少(如深夜多數無成交 change_rate=None)不覆寫,不寫檔 → workflow 略過部署,
    #    保留上一輪(22:00)的好資料,避免用空 {} 洗掉夜盤補漲卡。
    MIN_FUT = 30
    if len(out) < MIN_FUT:
        print(f'❌ 只抓到 {len(out)} 檔(< {MIN_FUT},夜盤多數無成交)→ 不產出 JSON,保留上一輪資料')
        sys.exit(1)

    payload = {'updated': datetime.now(TW).isoformat(), 'data': out}
    with open('stock_futures_night.json', 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f'✅ 個股期貨夜盤採礦完成:{len(out)} 檔 → stock_futures_night.json')


if __name__ == '__main__':
    main()
