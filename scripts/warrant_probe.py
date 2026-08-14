#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🎫 權證資料探針(V73.4.0)—— 只讀、手動觸發、不寫產物。

🚨 CLAUDE.md 目前有**三處**白紙黑字寫著權證做不到:
   ・「⛔ 缺資料源,別再評估:**權證波段大戶(無權證分點)**」
   ・處置股 8 款規則第 8 款「權證溢價率 | **無資料源** | 待採礦補(無公開 API)」
   ・「冷門股…**全市場分點** → 需 FinMind Sponsor」
⭐ 使用者上傳的 `warrants-main` 專案證明 FinMind **有一支專用端點**:
     GET /api/v4/taiwan_stock_warrant_trading_daily_report
         ?securities_trader_id=<分點代號>&date=<YYYY-MM-DD>&token=<>
   ⚠️ 注意它**不是** `/api/v4/data` + dataset,所以我先前的缺口探針(只掃 dataset)
      **掃不到它** —— 這正是「先問我需要它的哪一個函式」比「要不要裝它」重要的實例。

❓ 這支要回答四個問題(⛔ 全部實測,不猜):
   ① 我的金鑰**開不開得了**這支端點(可能要 Sponsor)
   ② 回應長什麼樣、有哪些欄位
   ③ 歷史能回溯多深(能不能回測)
   ④ 有沒有「權證**溢價率 / 基本資料**」的 dataset(第 8 款規則缺的那個)

⛔ 安全:只記「第幾把 token」,絕不印金鑰值。
🚧 空過守門:四個問題全部拿不到答案 → exit 1(⛔ 不可當成「FinMind 沒有權證資料」)。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://api.finmindtrade.com/api/v4'
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
# 幾個常見大分點(⛔ 只用來測端點通不通,不是觀察名單)
TRADERS = ['9200', '1440', '9800', '1020', '5920']
DS_CANDS = ['TaiwanStockWarrantTradingDailyReport', 'TaiwanWarrantPrice',
            'TaiwanStockWarrant', 'TaiwanStockWarrantInfo', 'TaiwanOptionDaily',
            'TaiwanStockWarrantDaily', 'TaiwanFuturesDaily']


def call(path, params, timeout=45):
    """回 (json, 第幾把, 錯誤)。每一把 token 都試過才放棄(V72.5.3)。"""
    last = 'no-token'
    for i in range(max(1, len(TOKENS))):
        q = dict(params)
        if TOKENS:
            q['token'] = TOKENS[i]
        url = f'{BASE}/{path}?' + urllib.parse.urlencode(q)
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8')), i + 1, None
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode('utf-8', 'replace'))
                msg = str(body.get('msg') or '')[:90]
            except Exception:
                msg = ''
            last = f'http{e.code}:{msg}'
            continue
        except Exception as e:
            last = type(e).__name__
            continue
    return None, None, last


def recent_days(n=8):
    out, t = [], time.time()
    while len(out) < n:
        d = time.gmtime(t)
        if d.tm_wday < 5:
            out.append(time.strftime('%Y-%m-%d', d))
        t -= 86400
    return out


def main():
    if not TOKENS:
        print('❌ 沒有 FINMIND_TOKENS')
        return 1
    found = 0

    # ── ① 權證分點端點通不通 ──
    print('═══ ① 權證分點端點 `taiwan_stock_warrant_trading_daily_report` ═══')
    days = recent_days(6)
    hit = None
    for tid in TRADERS:
        for d in days[:3]:
            j, tok, err = call('taiwan_stock_warrant_trading_daily_report',
                               {'securities_trader_id': tid, 'date': d})
            if j is None:
                print(f'  ❌ 分點 {tid} / {d}:{err}')
                continue
            rows = (j or {}).get('data') or []
            print(f'  {"✅" if rows else "➖"} 分點 {tid} / {d}:{len(rows)} 列(第 {tok} 把)'
                  f'{"" if rows else " —— 端點通但當天沒資料"}')
            if rows:
                hit = (tid, d, rows)
                break
        if hit:
            break
    if hit:
        found += 1
        tid, d, rows = hit
        print(f'\n  ⭐ 欄位:{sorted(rows[0].keys())}')
        print(f'  ⭐ 範例前 2 列:{json.dumps(rows[:2], ensure_ascii=False)[:400]}')
        # ── ③ 歷史深度:往回試,看最早能拿到哪一天 ──
        print('\n═══ ③ 歷史深度(往回試,⛔ 不假設它跟股票分點一樣深)═══')
        for back in (30, 90, 180, 365, 730):
            t = time.time() - back * 86400
            while time.gmtime(t).tm_wday >= 5:
                t -= 86400
            dd = time.strftime('%Y-%m-%d', time.gmtime(t))
            j2, _, e2 = call('taiwan_stock_warrant_trading_daily_report',
                             {'securities_trader_id': tid, 'date': dd})
            n2 = len((j2 or {}).get('data') or []) if j2 else 0
            print(f'  {back:>4} 天前({dd}):{n2} 列{"" if j2 else " ・" + str(e2)}')
    else:
        print('  ⛔ 這支端點拿不到任何資料 —— 但**不可**就此斷定「沒有權證分點」:'
              '\n     可能是 ① 分點代號格式不同 ② 需要 Sponsor 層級 ③ 參數名不同。'
              '\n     上面每一筆的錯誤碼就是線索(402/403=權限;200+空=真的沒資料)。')

    # ── ② / ④ dataset 形式的權證資料(溢價率/基本資料)──
    print('\n═══ ②④ dataset 形式:權證價格 / 溢價率 / 基本資料 ═══')
    print('   ⭐ 處置股第 8 款「權證溢價率」缺的就是這個')
    for ds in DS_CANDS:
        j, tok, err = call('data', {'dataset': ds, 'start_date': days[-1]})
        if j is None:
            print(f'  ❌ {ds}:{err}')
            continue
        rows = (j or {}).get('data') or []
        if rows:
            found += 1
            print(f'  ✅ {ds}:{len(rows):,} 列(第 {tok} 把)・欄位 {sorted(rows[0].keys())[:14]}')
        else:
            print(f'  ➖ {ds}:端點通但回空(可能名字對、當期無資料,或名字錯)')

    # ── 權證清單:能不能知道「哪些權證對應哪一檔標的」──
    print('\n═══ ⑤ 權證 ↔ 標的股 對照(要做「權證大戶」必須有這個)═══')
    for ds in ('TaiwanStockInfo',):
        j, tok, err = call('data', {'dataset': ds})
        rows = (j or {}).get('data') or [] if j else []
        if rows:
            w = [r for r in rows if str(r.get('industry_category') or '') in ('權證', 'Warrant')
                 or len(str(r.get('stock_id') or '')) >= 6]
            print(f'  ✅ {ds}:{len(rows):,} 列 ・其中疑似權證 {len(w):,} 檔')
            if w:
                found += 1
                print(f'     範例:{json.dumps(w[:3], ensure_ascii=False)[:300]}')
        else:
            print(f'  ❌ {ds}:{err}')

    print('\n⛔ 怎麼讀這份報告:')
    print('   ・`402` / `403` / 「level is register」= **權限**問題 → 換金鑰或升級,⛔ 不是程式問題')
    print('   ・HTTP 200 但 `data` 是空的 = 端點對、當期沒資料 或 參數名錯 → 看欄位提示')
    print('   ・⛔ 拿到資料**不等於**可以做功能 —— 還要回測有沒有邊際(同 ARBR/連次量那幾次)')
    # 🚧 空過守門
    if found == 0:
        print('\n❌ 四個問題全部沒有拿到答案 → 這一輪無效,⛔ 不可寫成「FinMind 沒有權證資料」')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
