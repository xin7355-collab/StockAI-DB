#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏪 櫃買指數歷史 K 線探針(V73.6.1)—— 只讀、手動觸發、不寫產物。

❓ 背景:`data/^TWOII.json` **從上線到現在一次都沒產出過**。
   `miner.py` 的診斷已經把範圍縮到很小(V71.2.5 ~ V71.6.8 五輪):
     ・`/rwd/zh/...` 與 `/web/...st41_result.php` → 回 HTML(2024 改版後死透)
     ・`/www/zh-tw/afterTrading/otc/st41` → **HTTP 200 且是 JSON**,tables 有 `data` 欄
       但一直判成「無資料」→ 卡在「那一列到底長什麼樣」。
   ⭐ 但那五輪都是「改 miner → 等 workflow → 看 log」,每輪 30-60 分。
   ⛔ 違反本專案自己的「探針先行」鐵則(同 analyst 那次犯了 7 輪才想起來)。
   → 這支**一次把所有候選試完並把原始回應印出來**,包含使用者 2026-08-17 提供的三個方案。

⚠️ 沙箱連不到 tpex(實測 HTTP 000,gateway 擋)→ 只能在 Actions 跑。
⛔ 安全:只記「第幾把 token」,絕不印金鑰值。
🚧 空過守門:一個候選都問不到 → exit 1(⛔ 不可當成「櫃買資料不存在」)。
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]


def get(url, timeout=20, headers=None):
    """回 (status, content_type, body 前 400 字, 解析後的 json 或 None)。"""
    req = urllib.request.Request(url, headers=headers or UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            ct = r.headers.get('Content-Type', '')
            txt = raw.decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Content-Type', '') if e.headers else '', (e.read()[:400].decode('utf-8', 'replace') if e.fp else ''), None
    except Exception as e:
        return 0, '', f'{type(e).__name__}: {e}'[:200], None
    j = None
    try:
        j = json.loads(txt)
    except Exception:
        pass
    return 200, ct, txt[:400], j


def shape(j):
    """把 JSON 的「長相」壓成一行(⭐ 這正是前五輪一直缺的線索)。"""
    if j is None:
        return 'not-json'
    if isinstance(j, list):
        return f'list({len(j)})' + (f' 首列={json.dumps(j[0], ensure_ascii=False)[:160]}' if j else '')
    if not isinstance(j, dict):
        return type(j).__name__
    out = f'dict keys={list(j.keys())[:9]}'
    if isinstance(j.get('tables'), list) and j['tables']:
        t = j['tables'][0]
        if isinstance(t, dict):
            d = t.get('data')
            out += f" | tables[0] keys={list(t.keys())[:9]} totalCount={t.get('totalCount')}"
            if isinstance(d, list):
                out += f" data={len(d)} 列"
                if d:
                    out += f" 首列型別={type(d[0]).__name__} 首列={json.dumps(d[0], ensure_ascii=False)[:180]}"
            else:
                out += f" data={type(d).__name__}"
            if t.get('fields'):
                out += f" fields={json.dumps(t['fields'], ensure_ascii=False)[:140]}"
    for k in ('aaData', 'data'):
        if isinstance(j.get(k), list) and j[k]:
            out += f" | {k}={len(j[k])} 列 首列={json.dumps(j[k][0], ensure_ascii=False)[:160]}"
    if j.get('stat'):
        out += f" | stat={str(j['stat'])[:40]!r}"
    if j.get('msg'):
        out += f" | msg={str(j['msg'])[:60]!r}"
    return out[:520]


def main():
    y, m, d = time.gmtime().tm_year, time.gmtime().tm_mon, time.gmtime().tm_mday
    roc = f'{y - 1911}/{m:02d}/{d:02d}'
    roc_m = f'{y - 1911}/{m:02d}'
    ce = f'{y:04d}/{m:02d}/{d:02d}'
    ce_first = f'{y:04d}{m:02d}01'
    hits = 0
    asked = 0

    print('═' * 78)
    print('① TPEx OpenAPI(⭐ 本專案 fetch_tpex_fundamentals 已證實這台是活的、免金鑰)')
    print('═' * 78)
    for name in ['tpex_mainboard_daily_close_quotes',   # 個股(對照用,確認這台真的通)
                 't187ap03_O',                          # 公司基本資料(已在用)
                 'tpex_otc_index_daily',                # 以下是猜的名字
                 'tpex_index_daily', 'tpex_daily_index', 'tpex_otc_index',
                 'tpex_mainboard_daily_index']:
        asked += 1
        st, ct, body, j = get(f'https://www.tpex.org.tw/openapi/v1/{name}')
        okk = bool(j) and (isinstance(j, list) and len(j) > 0)
        if okk:
            hits += 1
        print(f'  {"✅" if okk else "❌"} /openapi/v1/{name:<34} {st} {ct[:24]:<24} {shape(j) if j is not None else body[:90]!r}')

    print('\n' + '═' * 78)
    print('② TPEx 網站端點(含**使用者 2026-08-17 提供的方案二**)')
    print('═' * 78)
    cands = [
        ('使用者方案二 idx_summary(民國日)', f'https://www.tpex.org.tw/web/stock/aftertrading/index_summary/idx_summary_result.php?l=zh-tw&d={roc}'),
        ('使用者方案二(民國到月)', f'https://www.tpex.org.tw/web/stock/aftertrading/index_summary/idx_summary_result.php?l=zh-tw&d={roc_m}'),
        ('www/zh-tw st41(西元無分隔)', f'https://www.tpex.org.tw/www/zh-tw/afterTrading/otc/st41?date={ce_first}&response=json'),
        ('www/zh-tw st41(民國到日)', f'https://www.tpex.org.tw/www/zh-tw/afterTrading/otc/st41?date={roc}&response=json'),
        ('www/zh-tw otc(不帶 st41)', f'https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date={ce}&response=json'),
        ('www/zh-tw indexSummary', f'https://www.tpex.org.tw/www/zh-tw/afterTrading/indexSummary?date={ce}&response=json'),
        ('rwd/zh st41(舊)', f'https://www.tpex.org.tw/rwd/zh/afterTrading/otc/st41?date={ce_first}&response=json'),
    ]
    for label, url in cands:
        asked += 1
        st, ct, body, j = get(url)
        okk = bool(j) and ('html' not in ct.lower())
        if okk and ('tables' in str(j)[:200] or 'aaData' in str(j)[:200] or isinstance(j, list)):
            hits += 1
        print(f'  {"✅" if okk else "❌"} {label:<32} {st} {ct[:22]:<22} {shape(j) if j is not None else body[:110]!r}')

    print('\n' + '═' * 78)
    print('③ FinMind(**使用者方案三**;每一把 token 都試過才放棄)')
    print('═' * 78)
    start = time.strftime('%Y-%m-%d', time.gmtime(time.time() - 60 * 86400))
    fm_try = [
        ('TaiwanStockPrice', 'OTC'),          # 使用者說的
        ('TaiwanStockPrice', 'TPEx'),
        ('TaiwanStockPrice', 'TAIEX'),        # 對照:加權能不能拿到
        ('TaiwanStockTotalReturnIndex', 'TPEx'),
        ('TaiwanStockTotalReturnIndex', 'TAIEX'),
        ('TaiwanVariousIndicators5Seconds', 'TPEx'),
    ]
    if not TOKENS:
        print('  ⚠️ 沒有 FINMIND_TOKENS → 這一組跳過(⛔ 不可據此說 FinMind 沒有)')
    for ds, did in fm_try:
        asked += 1
        best = None
        for i in range(max(1, len(TOKENS))):
            q = {'dataset': ds, 'data_id': did, 'start_date': start}
            if TOKENS:
                q['token'] = TOKENS[i]
            st, ct, body, j = get('https://api.finmindtrade.com/api/v4/data?' + urllib.parse.urlencode(q), 30)
            rows = ((j or {}).get('data') or []) if isinstance(j, dict) else []
            if rows:
                best = (i + 1, len(rows), json.dumps(rows[-1], ensure_ascii=False)[:170])
                break
            if best is None:
                best = (None, 0, (str((j or {}).get('msg')) if isinstance(j, dict) else body)[:110])
        tok, n, note = best
        if n:
            hits += 1
        print(f'  {"✅" if n else "❌"} {ds:<32}{did:<8} ' + (f'{n} 列(第 {tok} 把)・{note}' if n else f'{note}'))

    print('\n' + '═' * 78)
    print('④ 其他免費來源(對照組)')
    print('═' * 78)
    for label, url in [
        ('Yahoo ^TWO', 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWO?range=3mo&interval=1d'),
        ('Yahoo ^TWOII', 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWOII?range=3mo&interval=1d'),
    ]:
        asked += 1
        st, ct, body, j = get(url)
        n = 0
        try:
            n = len(j['chart']['result'][0]['timestamp'])
        except Exception:
            pass
        if n:
            hits += 1
        print(f'  {"✅" if n else "❌"} {label:<24} {st} {("%d 根" % n) if n else body[:110]!r}')

    print('\n⛔ 怎麼讀:')
    print('   ・✅ 的那條就直接拿去改 miner.py 的 `twoii` 來源;')
    print('   ・②③ 全 ❌ 而 ①「已在用的那兩個」是 ✅ → 代表站是通的,是**端點名字**的問題;')
    print('   ・全部 ❌(連已在用的也失敗)→ 是這台 runner 被擋,⛔ 不是端點死了,換時間重跑。')
    print('   ⭐ 重點看「首列長什麼樣」——前五輪一直卡住就是因為 log 只印欄位名,')
    print('     分不出「那個月真的沒資料」跟「有資料但格式不同」。')
    print(f'\n📊 問了 {asked} 個候選,成功 {hits} 個')
    if hits == 0:
        print('❌ 一個都沒成功 → 這一輪無效,⛔ 不可當成「櫃買歷史資料拿不到」')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
