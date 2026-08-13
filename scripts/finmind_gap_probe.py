#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔎 FinMind「缺資料源」探針(V73.3.8)—— 只讀、手動觸發、不寫任何產物。

🚨 為什麼寫這支:使用者上傳 FinMind 官方 SDK。比對後發現它有 **94 個 dataset,我只用了 21 個**。
   而沒用到的那些裡面,有一批**正好對應 CLAUDE.md 白紙黑字寫著「缺資料源 / 做不到 / 靠推估」**的缺口。

⭐ 照鐵則「先問我需要的是它的**哪一個函式**,不是要不要裝它」——
   ⛔ 不裝 FinMind SDK(它拉 pandas 等一堆依賴,而我只需要「打哪個 dataset」這個知識)。
   ⛔ 也不為了補齊清單全接:只測「能解掉已知缺口」的那些。

⭐ 照鐵則「會需要改→等 workflow→看結果超過兩輪的事,先寫探針」——
   一次測完全部候選,⛔ 不要一輪試一個。

⛔ 安全:只記「第幾把 token」,**絕不把金鑰值印進 log 或寫進 JSON**。
⚠️ 沙箱連不到 FinMind(proxy 403,已實測)→ 這支只能在雲端後台跑。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.finmindtrade.com/api/v4/data'
# ⚠️ ⛔ 不可用 .strip() —— 金鑰中間常夾空白(V73.2.7 實測 4 把有 3 把中招)
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]

# (dataset, 額外參數, 這一條能解掉 CLAUDE.md 的哪個缺口)
CAND = [
    # ── 🚨 第一優先:CLAUDE.md 明寫「靠推估 / 抓不到」的 ──
    ('TaiwanTotalExchangeMarginMaintenance', {}, '大盤融資維持率:V72.0.3 我是**自己推估**的(四條免責)'),
    ('TaiwanStockMarginMaintenance', {'data_id': '2330'}, '個股融資維持率(Sponsor)⚠️ 官方說明也是估算,但有 2001 起的歷史'),
    ('TaiwanStockMarketValueWeight', {'data_id': '2330'}, '台積電權重:V72.0.4 明寫「推估是錯的路,別走」'),
    ('TaiwanBusinessIndicator', {}, '景氣對策信號:V72.3.2 抓不到(陷阱 #23,站方回 HTML)'),
    ('TaiwanStockConvertibleBondInfo', {}, 'CB 總覽'),
    ('TaiwanStockConvertibleBondDaily', {'data_id': '24481'}, 'CB **市價**:權證小哥那節寫「無 CB 市價」'),
    ('TaiwanStockConvertibleBondPutProvision', {'data_id': '24481'}, 'CB **賣回權**:明寫「無賣回價/到期日」'),
    ('TaiwanStockDayTradingBorrowingFeeRate', {'data_id': '2330'}, '借券費率:明寫「借券/券差成本無資料源」'),
    ('TaiwanStockCapitalReductionReferencePrice', {}, '減資參考價:陷阱 #21 我是**猜整數倍**回推的'),
    ('TaiwanStockSplitPrice', {}, '分割參考價:同上'),
    ('TaiwanStockParValueChange', {}, '面額變更參考價:同上'),
    # ── ⭐ 第二優先:能讓既有功能更準 ──
    ('TaiwanStockPER', {'data_id': '5483'}, '上櫃 PE/PB:V72.4.3 實測「上櫃一檔都沒有」(5483 是上櫃)'),
    ('TaiwanStockTotalReturnIndex', {'data_id': 'TAIEX'}, '報酬指數(含息):回測基準用不含息的加權指數會低估'),
    ('TaiwanSecuritiesTraderInfo', {}, '券商分點**地址**:地緣分點目前靠解析名稱、歧義地名不對照'),
    ('TaiwanStockTotalMarginPurchaseShortSale', {}, '全市場融資券'),
    ('TaiwanStockMarketValue', {'data_id': '2330'}, '個股市值'),
    ('TaiwanFuturesOpenInterestLargeTraders', {'data_id': 'TX'}, '期貨大額交易人未平倉(比單看外資口數更細)'),
    ('TaiwanStockActiveETFHolding', {'data_id': '00981A'}, '主動 ETF 持股(Sponsor):V72.9.8 我才剛「開始自己存」'),
    ('TaiwanStockActiveETFHoldingChange', {'data_id': '00981A'}, '主動 ETF 持股**異動**(Sponsor)⭐ 若有歷史就不用等 3 個月'),
    ('TaiwanStockMarginShortSaleSuspension', {'data_id': '2330'}, '融券回補日(軋空前提)'),
    ('TaiwanStockDayTradingSuspension', {}, '暫停當沖預告'),
    ('TaiwanStockTradingDailyReportSecIdAgg', {'data_id': '2330'}, '分點**總公司聚合**'),
    ('TaiwanStockIndustryChain', {'data_id': '2330'}, '所屬產業鏈'),
    ('CnnFearGreedIndex', {}, '恐懼貪婪指數(macro 已自己抓,比對是否更穩)'),
    ('TaiwanStockPriceLimit', {}, '每日漲跌停價'),
    ('TaiwanStockTradingDate', {}, 'official 交易日曆(算「N 個交易日後」不用自己推)'),
    # ── ⏳ 第三:CLAUDE.md 說「無逐筆歷史」的 ──
    ('TaiwanStockStatisticsOfOrderBookAndTrade', {'date': '2026-08-11'}, '每 5 秒委託成交統計:明寫「盤前試撮無逐筆歷史」'),
    ('TaiwanStockEvery5SecondsIndex', {'date': '2026-08-11'}, '每 5 秒指數'),
    ('TaiwanStockKBar', {'data_id': '2330', 'date': '2026-08-11'}, '分K:ORB 目前靠 Shioaji(要釘版本、要登入)'),
]


def classify(msg):
    m = (msg or '').lower()
    if 'illegal' in m or 'unauthorized' in m:
        return 'bad_token'
    if 'level' in m and 'register' in m:
        return 'free_tier'
    if 'level' in m:
        return 'need_upgrade'
    if 'limit' in m or 'requests' in m:
        return 'quota'
    return 'other'


def call(dataset, extra, start='2015-01-01'):
    """每一把 token 都試過才放棄(V72.5.3:403/400 要換 token,⛔ 不可當成沒資料)。"""
    last = 'no-token'
    for i in range(max(1, len(TOKENS))):
        q = {'dataset': dataset}
        q.update(extra)
        if 'date' not in extra:
            q['start_date'] = start
        if TOKENS:
            q['token'] = TOKENS[i]
        try:
            with urllib.request.urlopen(API + '?' + urllib.parse.urlencode(q), timeout=45) as r:
                j = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                raw = e.read().decode('utf-8', 'replace')[:300]
                msg = str((json.loads(raw) or {}).get('msg') or raw)[:110]
            except Exception:
                msg = ''
            last = f'http{e.code}／{classify(msg)}／{msg[:70]}'
            continue
        except Exception as e:
            last = f'{type(e).__name__}'
            continue
        rows = (j or {}).get('data') or []
        if rows:
            return rows, i + 1, None
        last = f"空(status={j.get('status')} msg={str(j.get('msg') or '')[:50]})"
    return None, None, last


def main():
    if not TOKENS:
        print('❌ 沒有 FINMIND_TOKENS')
        return 1
    print(f'🔎 FinMind 缺口探針 ・{len(CAND)} 個候選 ・token {len(TOKENS)} 把')
    print('⛔ 安全:只記「第幾把」,不印金鑰值\n')
    good, bad = [], []
    for ds, extra, why in CAND:
        t0 = time.time()
        rows, tok, err = call(ds, extra)
        el = time.time() - t0
        if rows:
            dates = sorted({str(r.get('date') or '')[:10] for r in rows if r.get('date')})
            cols = sorted(rows[0].keys())
            span = f'{dates[0]}~{dates[-1]} / {len(dates)} 天' if dates else '(無 date 欄)'
            print(f'✅ {ds}')
            print(f'   {len(rows):>7,} 列 ・{span} ・{el:.1f}s ・用第 {tok} 把')
            print(f'   欄位:{", ".join(cols[:14])}{" …" if len(cols) > 14 else ""}')
            print(f'   💡 {why}')
            good.append((ds, len(rows), dates[0] if dates else '-', why))
        else:
            print(f'❌ {ds}  →  {err}')
            print(f'   💡 (本來想解:{why})')
            bad.append((ds, err, why))
        print()
        time.sleep(0.15)

    print('=' * 78)
    print(f'📊 拿得到 {len(good)} 個 ・拿不到 {len(bad)} 個\n')
    print('── ✅ 可用(依歷史起點排序)──')
    for ds, n, d0, why in sorted(good, key=lambda x: x[2]):
        print(f'  {d0}  {ds:<46} {n:>7,} 列')
    if bad:
        print('\n── ❌ 拿不到 ──')
        for ds, err, why in bad:
            print(f'  {ds:<46} {err}')
    # 🚧 空過守門:一個都拿不到 = 這輪無效(金鑰或網路問題),⛔ 別讓綠燈騙人
    if not good:
        print('\n❌ 一個 dataset 都拿不到 → 這一輪無效,⛔ 不可當成「FinMind 沒有這些資料」')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
