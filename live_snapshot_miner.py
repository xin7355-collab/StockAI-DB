#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全市場即時快照採礦(永豐 Shioaji)→ data/live_quotes.json
─────────────────────────────────────────────────────────────
用途:一次抓「全上市櫃股票 + 台指期(大台TXF/小台MXF)」的即時價/漲跌%/量,
     一個 JSON 供前端:
       ① 🎯 當沖作戰室「全市場當沖強勢榜」(漲幅+量排序,全市場掃)
       ② 💼 庫存 / ⭐ 自選 清單「現價即時基準」(一次讀全市場,免每檔打 Fugle 撞 429)
       ③ 🌙 大盤風向「即時台指期報價」

需 GitHub Secrets(絕不硬編):
  SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY(只做行情不下單 → 免憑證 CA.pfx)

輸出 data/live_quotes.json:
  {
    "updated": ISO時間,
    "ts": "07/13 10:32",
    "idx": { "txf": {"p":23150,"c":0.85,"v":12345}, "mxf": {...} },
    "data": { "2330": {"p":1085.0,"c":1.2,"v":18342}, ... }   # p=價 c=漲跌% v=量
  }

⚠️ 本檔在無網路/無憑證 sandbox 無法實測;請在 GitHub Actions(有 Secrets)Run 看 log 驗證。
"""
import os
import sys
import json
from datetime import datetime, timezone, timedelta

TW = timezone(timedelta(hours=8))
MIN_STOCKS = 300   # 抓到 < 300 檔 = 登入/行情異常 → 不覆寫、不部署(自我修復,保留舊檔)


def _now_str():
    return datetime.now(TW).strftime('%m/%d %H:%M')


def _snap_num(snap, *names):
    """從 snapshot 取第一個非 None 的欄位(不同版本欄名略有差異時容錯)。"""
    for n in names:
        v = getattr(snap, n, None)
        if v is not None:
            return v
    return None


def _near_month(cat):
    """一個期貨類別(如 TXF)取近月(交割日最近且未過期)合約。"""
    today = datetime.now(TW).strftime('%Y/%m/%d')
    best = None
    for c in cat:
        dd = str(getattr(c, 'delivery_date', '') or '')
        if not dd or dd < today:   # 🐛 空交割日的占位/連續合約也要跳過(否則 '' < 任何日期 → 被誤選成近月)
            continue
        if best is None or dd < str(getattr(best, 'delivery_date', '') or '9999'):
            best = c
    return best


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

    # ── 1) 全上市櫃股票合約 ──
    stock_contracts = []
    seen = set()
    try:
        for exch in api.Contracts.Stocks:          # TSE(上市)/ OTC(上櫃)/ OES(興櫃)
            for c in exch:
                code = getattr(c, 'code', None) or ''
                # 🚫 興櫃(OES)排除:無漲跌幅限制,單日可 ±30%↑ 汙染當沖強勢榜,且流動性差不好當沖
                exch_v = getattr(getattr(c, 'exchange', None), 'value', None) or str(getattr(c, 'exchange', ''))
                if 'OES' in str(exch_v).upper():
                    continue
                # ⚠️ 台股權證/ETN 也是 6 碼「純數字」→ 舊版全掃進來(~3 萬檔,爆檔+汙染強勢榜)。
                #    只留:① 一般個股 = 4 碼純數字(1101~9958)② ETF/槓桿反向 = 00 開頭(0050/00878/00632R)
                is_stock = code.isdigit() and len(code) == 4
                is_etf = code.startswith('00') and 4 <= len(code) <= 6
                if (is_stock or is_etf) and code not in seen:
                    seen.add(code)
                    stock_contracts.append((code, c))
    except Exception as e:
        print(f'⚠️ 建股票合約清單出錯:{e}')
    print(f'📋 股票/ETF 合約 {len(stock_contracts)} 檔(已濾除權證/ETN),批次抓快照中…')

    data = {}
    B = 400
    for i in range(0, len(stock_contracts), B):
        batch = stock_contracts[i:i + B]
        try:
            snaps = api.snapshots([c for _, c in batch])
        except Exception as e:
            print(f'⚠️ 股票 snapshot batch {i} 失敗:{e}')
            continue
        for (code, _c), snap in zip(batch, snaps):
            try:
                cl = _snap_num(snap, 'close')
                cr = _snap_num(snap, 'change_rate')
                tv = _snap_num(snap, 'total_volume', 'volume') or 0
                if cl is None or float(cl) <= 0:
                    continue          # 未成交(停牌/無量)→ 略過,不塞 0 汙染前端
                rec = {'p': round(float(cl), 2), 'v': int(tv or 0)}
                if cr is not None:
                    rec['c'] = round(float(cr), 2)
                data[str(code)] = rec
            except Exception:
                continue
    print(f'✅ 股票快照 {len(data)} 檔')

    # ── 2) 台指期(大台 TXF / 小台 MXF)近月 ──
    idx = {}
    for tag, sym in (('txf', 'TXF'), ('mxf', 'MXF')):
        try:
            cat = getattr(api.Contracts.Futures, sym, None)
            if cat is None:
                continue
            c = _near_month(cat)
            if c is None:
                continue
            snap = api.snapshots([c])[0]
            cl = _snap_num(snap, 'close')
            cr = _snap_num(snap, 'change_rate')
            tv = _snap_num(snap, 'total_volume', 'volume') or 0
            if cl is not None and float(cl) > 0:
                idx[tag] = {
                    'p': round(float(cl), 2),
                    'c': round(float(cr), 2) if cr is not None else None,
                    'v': int(tv or 0),
                }
        except Exception as e:
            print(f'⚠️ 台指期 {sym} 抓取失敗:{e}')
    print(f'✅ 台指期 idx:{list(idx.keys())}')

    try:
        api.logout()
    except Exception:
        pass

    # ── 自我修復:抓太少不覆寫(保留舊檔,下次再補)──
    if len(data) < MIN_STOCKS:
        print(f'❌ 只抓到 {len(data)} 檔(< {MIN_STOCKS})→ 判定行情異常,不產出 JSON(保留舊快照)')
        sys.exit(1)

    payload = {
        'updated': datetime.now(TW).isoformat(),
        'ts': _now_str(),
        'idx': idx,
        'data': data,
    }
    with open('live_quotes.json', 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print(f'✅ 全市場即時快照完成:{len(data)} 檔股票 + 台指期 {len(idx)} → live_quotes.json')


if __name__ == '__main__':
    main()
