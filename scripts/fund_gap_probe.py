#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📊 基本面缺漏探針(V73.4.2)—— 只讀、手動觸發、不寫產物。

🚨 使用者截圖(2327 國巨・基本面頁):殖利率 / 發配率 / 每股股利 全是 `--`,
   填息機率 / 平均填息天數 顯示「採礦更新中」。

📐 **先量再下結論**(⛔ 沒量的話會誤以為是 2327 個案):實測 gh-pages 2,074 檔:
     `total_dividend` 只有 **46 檔(2.2%)**・`quarterly_dividends` **50 檔**
     而且 **2330 / 2317 / 2327 連 `eps` 都是 None**,2454 卻有(eps 15.28、6 筆股利)
   → **不是股利單獨壞,是整包 FinMind 財報對某些股票回空**;
     而且快取是昨天的、`miner_version` 也是當前版 → ⛔ **不是快取沒更新**,是**抓取本身失敗**。

❓ 這支要回答(⛔ 全部實測,沙箱連不到 FinMind,只能雲端跑):
   ① 三支 dataset 對 **2330 / 2327 / 2454**(一個有值、兩個沒值)各回什麼
   ② 是**權限**問題(402/403/level is register)還是**真的沒資料**(200 + 空)
   ③ 換不同 `start_date` 會不會有差(現行是近 3 年 = 1095 天)
   ④ 有沒有**別的 dataset** 拿得到同樣的東西

⛔ 安全:只記「第幾把 token」,絕不印金鑰值。
🚧 空過守門:一個都問不到 → exit 1。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.finmindtrade.com/api/v4/data'
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
# ⭐ 刻意挑「有值」與「沒值」各半 —— 只測沒值的那幾檔會分不出「權限」還是「這檔就是沒有」
SYMS = ['2330', '2317', '2327', '2454', '1303']
DS = ['TaiwanStockDividend', 'TaiwanStockFinancialStatements', 'TaiwanStockMonthRevenue']
ALT = ['TaiwanStockDividendResult', 'TaiwanStockPER', 'TaiwanStockBalanceSheet',
       'TaiwanStockCashFlowsStatement']


def fm(dataset, data_id, start):
    """回 (列數, 第幾把, 錯誤, 第一列)。每一把 token 都試過才放棄。"""
    last = 'no-token'
    for i in range(max(1, len(TOKENS))):
        q = {'dataset': dataset, 'data_id': data_id, 'start_date': start}
        if TOKENS:
            q['token'] = TOKENS[i]
        try:
            with urllib.request.urlopen(API + '?' + urllib.parse.urlencode(q), timeout=45) as r:
                j = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode('utf-8', 'replace'))
                msg = str(body.get('msg') or '')[:70]
            except Exception:
                msg = ''
            last = f'http{e.code}:{msg}'
            continue
        except Exception as e:
            last = type(e).__name__
            continue
        rows = (j or {}).get('data') or []
        if rows:
            return len(rows), i + 1, None, rows[-1]
        last = 'empty(200)'
    return 0, None, last, None


def main():
    if not TOKENS:
        print('❌ 沒有 FINMIND_TOKENS')
        return 1
    y3 = time.strftime('%Y-%m-%d', time.gmtime(time.time() - 1095 * 86400))
    y10 = time.strftime('%Y-%m-%d', time.gmtime(time.time() - 3650 * 86400))
    found = 0

    print('═══ ① 三支 dataset × 5 檔(⭐ 2454/1303 是「有值」的對照組)═══')
    print(f'   現行採礦用的 start_date = {y3}(近 3 年)\n')
    hdr = f'{"dataset":<34}' + ''.join(f'{s:>14}' for s in SYMS)
    print(hdr); print('─' * len(hdr))
    for ds in DS:
        cells = ''
        for s in SYMS:
            n, tok, err, _ = fm(ds, s, y3)
            cells += f'{(str(n) + " 列") if n else (err or "?")[:13]:>14}'
            if n:
                found += 1
        print(f'{ds:<34}{cells}')

    print(f'\n═══ ② 換成 10 年({y10})會不會有差 ═══')
    print('   ⭐ 如果 10 年有、3 年沒有 → 那些股票**近 3 年真的沒配息/沒財報**,不是抓取壞掉')
    print(hdr); print('─' * len(hdr))
    for ds in DS:
        cells = ''
        for s in SYMS:
            n, tok, err, _ = fm(ds, s, y10)
            cells += f'{(str(n) + " 列") if n else (err or "?")[:13]:>14}'
        print(f'{ds:<34}{cells}')

    print('\n═══ ③ 2330 的股利原始列(看欄位名對不對)═══')
    n, tok, err, last = fm('TaiwanStockDividend', '2330', y10)
    if last:
        print(f'  ✅ {n} 列(第 {tok} 把)・最新一列:')
        print(f'     {json.dumps(last, ensure_ascii=False)[:400]}')
        # ⭐ 採礦端用的欄位名對不對(V15.7 曾經因為欄名錯而永遠抓 0)
        keys = sorted(last.keys())
        cash = [k for k in keys if 'cash' in k.lower() and 'earning' in k.lower() or k == 'CashEarningsDistribution']
        print(f'     欄位:{keys}')
        print(f'     ⭐ 現金股利候選欄:{cash or "⚠️ 找不到 → 採礦端的欄名可能又錯了(V15.7 踩過)"}')
    else:
        print(f'  ❌ {err}')

    print('\n═══ ④ 有沒有別的 dataset 拿得到同樣的東西 ═══')
    for ds in ALT:
        n, tok, err, last = fm(ds, '2330', y3)
        if n:
            found += 1
            print(f'  ✅ {ds}:{n} 列 ・欄位 {sorted(last.keys())[:12]}')
        else:
            print(f'  ❌ {ds}:{err}')

    print('\n⛔ 怎麼讀:')
    print('   ・全部 `level is register` / 402 → **權限**問題,⛔ 不是程式問題')
    print('   ・2330 空但 2454 有 → 那幾檔**真的沒有**(可能配息時間不在窗口內)→ 拉長窗口即可')
    print('   ・10 年有、3 年沒有 → **窗口太短**,改 `start_div` 就好')
    print('   ・全部 200+空 → 欄名/參數問題,看 ③ 的原始列')
    if found == 0:
        print('\n❌ 一筆都沒拿到 → 這一輪無效,⛔ 不可當成「FinMind 沒有這些資料」')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
