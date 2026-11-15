#!/usr/bin/env python3
"""🔎 Twelve Data 免費方案(Basic)到底給哪些代號?—— 換掉 yfinance 第二階段選「B:要金鑰的免費 API」之前先量。

為什麼要有這支:yfinance 第二階段(docs/DECISIONS.md V82.3.6 那一節「還在 yfinance 的」)使用者 11/15 選了
「推薦的」= B(申請免費金鑰)+ D(比特幣用交易所公開 API)+ C(板塊 ETF 拿掉)。B 要先知道哪一家的免費方案
真的有我們要的那幾格(美股指數 / VIX / ADR / 黃金原油 / 美元指數 / 亞洲指數 / 匯率)—— 第三方網站的說法互相矛盾,
官方文件說每個代號可以用 `show_plan=true` 問「哪個方案才有」→ 在 Actions 實際問一次,log 說了算。
⚠️ 雲端工作階段連不到 api.twelvedata.com(proxy 403)→ 只能在 GitHub Actions 跑。

只讀:⛔ 不寫任何分支 / 資料檔;⛔ 不用使用者的金鑰 —— 用官方文件公開的示範金鑰 `demo`,而且照官方的標頭寫法
(`Authorization: apikey demo`,⛔ 放網址);⛔ 偽裝瀏覽器(UA 寫明是誰);每次間隔 8 秒(免費方案每分鐘 8 次)。
結論分三種(陷阱 #23):連不上 / 被擋(401、403、429、回 HTML)/ 有回但找不到這個代號。

跑法:python3 scripts/twelvedata_plan_probe.py [--selftest]
"""
import json
import sys
import time

UA = 'Mozilla/5.0 (compatible; StockAI-DB twelvedata_plan_probe/1.0; +https://github.com/xin7355-collab/stockai-db)'
BASE = 'https://api.twelvedata.com'
GAP = 8.0

# (要問的字, 我們拿來做什麼, 期望的類型關鍵字)—— 期望類型只用來挑「對的那一筆」(⛔ 同名的別國股票)
WANT = [
    ('SPX', '標普 500(盤前分數 usPct)', 'Index'),
    ('IXIC', '那斯達克綜合', 'Index'),
    ('DJI', '道瓊工業', 'Index'),
    ('SOX', '費城半導體', 'Index'),
    ('VIX', 'VIX 恐慌指數(值本身有門檻)', 'Index'),
    ('N225', '日經 225', 'Index'),
    ('HSI', '恆生指數', 'Index'),
    ('KS11', '韓股 KOSPI', 'Index'),
    ('DXY', '美元指數', 'Index'),
    ('TSM', '台積電 ADR', 'Depositary Receipt'),
    ('ASX', '日月光 ADR', 'Depositary Receipt'),
    ('UMC', '聯電 ADR', 'Depositary Receipt'),
    ('NVDA', '美股 NVDA', 'Common Stock'),
    ('AAPL', '美股 AAPL', 'Common Stock'),
    ('MSFT', '美股 MSFT', 'Common Stock'),
    ('XAU/USD', '黃金', ''),
    ('WTI/USD', 'WTI 原油', ''),
    ('XBR/USD', '布蘭特原油(代號待確認)', ''),
    ('HG1', '銅', ''),
    ('USD/JPY', '日圓', ''),
    ('USD/TWD', '台幣', ''),
    ('USD/KRW', '韓元', ''),
    ('USD/CNY', '人民幣', ''),
    ('BTC/USD', '比特幣(D 方案另走交易所,這裡只對照)', ''),
    ('SPY', '標普 ETF(指數沒有時的替代)', 'ETF'),
    ('QQQ', '那斯達克 100 ETF(替代)', 'ETF'),
    ('SOXX', '半導體 ETF(替代)', 'ETF'),
]


def pick(rows, sym, typ):
    """symbol_search 的結果 → 最像的那一筆(代號完全一樣優先,再看類型、美國優先)。純函式。"""
    rows = [r for r in (rows or []) if isinstance(r, dict)]
    same = [r for r in rows if str(r.get('symbol', '')).upper() == sym.upper()]
    if not same:
        return None
    if typ:
        t = [r for r in same if typ.lower() in str(r.get('instrument_type', '')).lower()]
        same = t or same
    us = [r for r in same if str(r.get('country', '')) in ('United States', '')]
    return (us or same)[0]


def classify(code, body):
    """→ ('ok' | 'block' | 'fail', 說明)。"""
    if code in (401, 403, 429):
        return 'block', f'HTTP {code}'
    if code != 200:
        return 'fail', f'HTTP {code}'
    if body.lstrip()[:1] == '<':
        return 'block', '回 HTML(擋頁 / 改版)'
    try:
        j = json.loads(body)
    except ValueError:
        return 'fail', '不是 JSON'
    if isinstance(j, dict) and j.get('status') == 'error':
        return 'fail', f"API 錯誤 {j.get('code')}:{str(j.get('message'))[:120]}"
    return 'ok', ''


def main():
    import requests
    s = requests.Session()
    H = {'User-Agent': UA, 'Accept': 'application/json', 'Authorization': 'apikey demo'}
    out, blocked = [], 0
    for i, (sym, use, typ) in enumerate(WANT):
        if i:
            time.sleep(GAP)
        try:
            r = s.get(f'{BASE}/symbol_search', params={'symbol': sym, 'show_plan': 'true', 'outputsize': 30}, headers=H, timeout=20)
            st, why = classify(r.status_code, r.text)
        except Exception as e:  # noqa: BLE001
            st, why = 'fail', f'連不上 {type(e).__name__}'
            r = None
        if st == 'block':
            blocked += 1
        hit = pick((r.json().get('data') if (r is not None and st == 'ok') else None), sym, typ) if st == 'ok' else None
        acc = (hit or {}).get('access') or {}
        row = {'q': sym, 'use': use, 'st': st, 'why': why,
               'found': bool(hit), 'type': (hit or {}).get('instrument_type'), 'exchange': (hit or {}).get('exchange'),
               'country': (hit or {}).get('country'), 'plan': acc.get('plan'), 'global': acc.get('global')}
        out.append(row)
        print(f"{'✅' if row['found'] else ('🚫' if st == 'block' else '❔')} {sym:<9} {use:<22} → "
              + (f"{row['type']} / {row['exchange']} / {row['country']} / 方案 {row['plan']}" if row['found'] else (why or '找不到這個代號')),
              flush=True)
        if blocked >= 3:
            print('🛑 連續被擋 3 次 → 停(⛔ 換方式再試)')
            break
    # 布蘭特原油代號在 /commodities 清單裡找(⛔ 猜)
    time.sleep(GAP)
    try:
        r = s.get(f'{BASE}/commodities', headers=H, timeout=20)
        st, why = classify(r.status_code, r.text)
        if st == 'ok':
            brent = [c for c in (r.json().get('data') or []) if 'brent' in json.dumps(c).lower() or 'copper' in json.dumps(c).lower()]
            print('🛢️ commodities 清單裡的 Brent / Copper:', json.dumps(brent, ensure_ascii=False)[:600])
        else:
            print('🛢️ commodities 清單:', why)
    except Exception as e:  # noqa: BLE001
        print('🛢️ commodities 清單 連不上', type(e).__name__)
    basic = [o['q'] for o in out if o['found'] and str(o['plan']).lower() == 'basic']
    paid = [f"{o['q']}({o['plan']})" for o in out if o['found'] and str(o['plan']).lower() != 'basic']
    miss = [o['q'] for o in out if not o['found']]
    print(f"\n📋 免費 Basic 有 {len(basic)} 個:{', '.join(basic)}")
    print(f"💰 要付費方案 {len(paid)} 個:{', '.join(paid)}")
    print(f"❔ 找不到 / 失敗 {len(miss)} 個:{', '.join(miss)}")
    return 0


def selftest():
    bad = []

    def ok(n, c, g=''):
        print(f"{'✅' if c else '❌'} {n}" + ('' if c else f' → {g}'))
        if not c:
            bad.append(n)
    rows = [{'symbol': 'TSM', 'instrument_type': 'Common Stock', 'country': 'Germany', 'access': {'plan': 'Pro'}},
            {'symbol': 'TSM', 'instrument_type': 'Depositary Receipt', 'country': 'United States', 'access': {'plan': 'Basic'}},
            {'symbol': 'TSMX', 'instrument_type': 'ETF', 'country': 'United States'}]
    h = pick(rows, 'TSM', 'Depositary Receipt')
    ok('① 同名的別國股票 ⛔ 挑錯:挑美國的 ADR', h and h['country'] == 'United States' and h['access']['plan'] == 'Basic', h)
    ok('② 代號不完全一樣 ⛔ 算找到', pick(rows, 'TSMXX', '') is None)
    ok('③ 類型對不上就退回同代號', pick([{'symbol': 'VIX', 'instrument_type': 'ETF', 'country': 'United States'}], 'VIX', 'Index')['instrument_type'] == 'ETF')
    ok('④ 403 / 429 = 被擋', classify(403, '')[0] == 'block' and classify(429, '{}')[0] == 'block')
    ok('⑤ 200 但回 HTML = 被擋', classify(200, '  <html>denied</html>')[0] == 'block')
    ok('⑥ 200 + status error = 失敗(寫原因)', classify(200, '{"status":"error","code":401,"message":"bad key"}') == ('fail', 'API 錯誤 401:bad key'))
    ok('⑦ 正常 JSON = ok', classify(200, '{"data":[]}')[0] == 'ok')
    print(f"\n{'✅ 全過' if not bad else '❌ 失敗 ' + str(len(bad)) + ' 條'}")
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
