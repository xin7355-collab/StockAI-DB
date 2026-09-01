#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
💰 除權息資料源探針(V74.3.7)—— 只讀、不寫產物、不碰分支。

❓ 為什麼:本站**沒有配息紀錄**(0050 七種買法那次「含息」是用 3% 殖利率估的;
   twstock-research 有除權息行事曆 + 除權息回測,那是它有、我沒有的真缺口)。
   ⛔ 照鐵則:確定端點之前不准在採礦端加欄位(憑猜的欄位會永遠 null 還躲過體檢)。

要回答的三個問題(每個都印**列數 + 日期範圍 + 一列樣本 + 失敗原因**):
 ① FinMind `TaiwanStockDividend`(股利政策)/ `TaiwanStockDividendResult`(除權息結果:除息日、參考價)
    —— 免費層拿不拿得到?回溯多深?(4 把金鑰逐把試,V72.5.3 教訓)
 ② TWSE OpenAPI(免金鑰):`/v1/exchangeReport/TWT48U`(除權息計算結果)/ `TWT49U`(預告)
    /`t187ap45_L`(股利分派)—— ⚠️ 對不存在的路徑回 200+HTML(陷阱 #23),要印 content-type。
 ③ 對照組:`TaiwanStockPrice` 2330 近 5 天 —— 它也失敗 = 這台機器連不到,別解讀成端點改名。
用法:FINMIND_TOKENS=... python3 scripts/div_probe.py
"""
import json
import os
import sys
import urllib.parse
import urllib.request

API = 'https://api.finmindtrade.com/api/v4/data'
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
print(f'🔑 金鑰 {len(TOKENS)} 把(只印第幾把,⛔ 不印內容)')


def fm(dataset, extra):
    """每一把都試;回 (rows, note)。"""
    last = 'no-token'
    for k in range(max(1, len(TOKENS))):
        q = {'dataset': dataset, **extra}
        if TOKENS:
            q['token'] = TOKENS[k]
        try:
            with urllib.request.urlopen(API + '?' + urllib.parse.urlencode(q), timeout=60) as r:
                j = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            raw = e.read().decode('utf-8', 'replace')[:200]
            try:
                raw = str((json.loads(raw) or {}).get('msg') or raw)[:120]
            except Exception:
                pass
            last = f'第{k+1}把/HTTP {e.code}/{raw}'
            continue
        except Exception as e:
            last = f'第{k+1}把/{type(e).__name__}'
            continue
        if not isinstance(j, dict) or j.get('status') not in (200, None):
            last = f'第{k+1}把/status {j.get("status") if isinstance(j, dict) else "?"}/{str((j or {}).get("msg"))[:100]}'
            continue
        return j.get('data') or [], f'第{k+1}把 OK'
    return None, last


def show(name, rows, note, datekeys=('date', 'CashExDividendTradingDate', 'ex_date')):
    if rows is None:
        print(f'❌ {name}:{note}')
        return
    ds = []
    for r in rows:
        for k in datekeys:
            if r.get(k):
                ds.append(str(r[k]))
                break
    ds.sort()
    print(f'✅ {name}:{len(rows):,} 列({note})' + (f' ・{ds[0]} ~ {ds[-1]}' if ds else ' ・沒有日期欄'))
    if rows:
        print('   欄位:', list(rows[0].keys())[:14])
        print('   樣本:', json.dumps(rows[-1], ensure_ascii=False)[:300])


print('\n═══ ③ 對照組(已知會通的端點)═══')
rows, note = fm('TaiwanStockPrice', {'data_id': '2330', 'start_date': '2026-08-25'})
show('TaiwanStockPrice 2330', rows, note)
CTRL_OK = rows is not None

print('\n═══ ① FinMind 除權息 ═══')
for ds, extra in [('TaiwanStockDividend', {'data_id': '2330', 'start_date': '2020-01-01'}),
                  ('TaiwanStockDividendResult', {'data_id': '2330', 'start_date': '2020-01-01'}),
                  ('TaiwanStockDividendResult', {'data_id': '0050', 'start_date': '2020-01-01'}),
                  ('TaiwanStockDividendResult', {'start_date': '2026-08-01'}),   # 省略 data_id 的全市場寫法(分點那次不通,這裡再驗一次)
                  ('TaiwanStockDividend', {'data_id': '0056', 'start_date': '2020-01-01'})]:
    rows, note = fm(ds, extra)
    show(f'{ds} {extra}', rows, note)

print('\n═══ ② TWSE OpenAPI(免金鑰)═══')
for path in ['/v1/exchangeReport/TWT48U', '/v1/exchangeReport/TWT49U', '/v1/opendata/t187ap45_L',
             '/v1/opendata/t187ap45_O', '/v1/exchangeReport/TWT49UDetail']:
    url = 'https://openapi.twse.com.tw' + path
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as r:
            ct = r.headers.get('content-type', '')
            body = r.read().decode('utf-8', 'replace')
        try:
            j = json.loads(body)
            print(f'✅ {path}:{len(j):,} 列 ・ct={ct[:30]}')
            if j:
                print('   欄位:', list(j[0].keys())[:12]); print('   樣本:', json.dumps(j[0], ensure_ascii=False)[:260])
        except Exception:
            print(f'❌ {path}:HTTP 200 但不是 JSON(ct={ct[:30]},開頭 {body[:60]!r})← 陷阱 #23:路徑不存在')
    except Exception as e:
        print(f'❌ {path}:{type(e).__name__} {str(e)[:80]}')

print('\n🧾 結論怎麼讀:對照組 ❌ → 機器連不到,下面全部不可解讀;對照組 ✅ 而某個資料集 ❌ → 那是層級/名稱問題。')
if not CTRL_OK:
    sys.exit(2)
