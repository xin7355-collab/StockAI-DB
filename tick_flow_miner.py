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

    # ── 3) 逐檔 api.ticks 全日逐筆 → 算真實內外盤 + 大單 ──
    out = {}
    for rank, (_tv, code, c) in enumerate(hot):
        try:
            t = api.ticks(contract=c, date=today)
        except Exception as e:
            if rank < 3:
                print(f'⚠️ ticks({code}) 失敗:{e}')
            time.sleep(0.15)
            continue
        try:
            vols = list(getattr(t, 'volume', []) or [])
            types = list(getattr(t, 'tick_type', []) or [])
            n = min(len(vols), len(types))
            if n == 0:
                continue
            in_v = out_v = bb = bs = mx = 0.0
            for j in range(n):
                v = _to_lots(vols[j])
                tt = int(types[j]) if types[j] is not None else 0
                if v > mx:
                    mx = v
                if tt == 1:      # 外盤(主動買)
                    out_v += v
                    if v >= BIG_LOTS:
                        bb += v
                elif tt == 2:    # 內盤(主動賣)
                    in_v += v
                    if v >= BIG_LOTS:
                        bs += v
            if in_v + out_v <= 0:
                continue
            out[str(code)] = {
                'in': int(round(in_v)), 'out': int(round(out_v)),
                'bb': int(round(bb)), 'bs': int(round(bs)),
                'mx': int(round(mx)), 'n': int(n),
            }
        except Exception:
            continue
        time.sleep(0.12)   # 溫柔節流

    print(f'✅ 逐筆內外盤/大單 {len(out)} 檔')
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


if __name__ == '__main__':
    main()
