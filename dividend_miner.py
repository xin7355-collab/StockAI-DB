#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
💰 除權息採礦(V74.3.8)—— data/dividends.json(前端用,精簡)+ data/dividends_hist.json(回測用,只推 data 分支)

❓ 為什麼:本站一直沒有配息紀錄 —— 0050 七種買法那次「含息」是用 3% 殖利率**估**的,
   而 twstock-research(使用者 2026-09-01 上傳)有除權息行事曆與含息回測,那是它有、本站沒有的真缺口。
🧪 資料源已用 scripts/div_probe.py 在 Actions 實跑驗過(2026-09-01):
   ・FinMind `TaiwanStockDividendResult`(除權息**結果**:除息日/前後價/股利/參考價)逐檔可抓、2020 起有
   ・FinMind `TaiwanStockDividend`(股利**政策**:含**未來**的除息日 CashExDividendTradingDate)逐檔可抓
   ・🚨 兩個都要**付費層**(第 1 把 OK);省略 data_id 的全市場寫法回 0 列(跟分點一樣不通)
   ・TWSE OpenAPI 只有股利分派決議(t187ap45_L),沒有除息日 → 不用

⛔ 六個守門(每一個都不會報錯,只會讓資料安靜地變壞 —— ⛔ 別拿掉):
 ① 先用 2330 探路:第一把能用的金鑰不是付費層 → exit 1(⛔ 不可硬跑出一堆空檔蓋掉舊檔)
 ② 有效檔數 < MIN_OK(500)→ ⛔ 不覆寫舊檔(同 fund_sweep / tdcc_sweep)
 ③ **合併舊檔**:這輪抓失敗的股票保留舊資料(⛔ 不可因為一次 timeout 就把那檔清掉)
 ④ 每 200 檔寫一次 checkpoint(中途被砍還留一半)
 ⑤ 🔐 只印「第幾把」,⛔ 絕不印金鑰(repo 是 public)
 ⑥ 收尾印分類統計(成功/空/失敗原因)—— V72.5.3 的教訓:先加分類統計再下結論

格式(⛔ 前端 pro.html/index.html 讀的就是這個,改格式要一起改):
  dividends.json      = {updated, data_date, from, n, d: {sym: {h: [[除息日, 現金股利, 類型, 除息前價, 參考價], …最近 12 筆], up: [[未來除息日, 現金股利], …]}}}
  dividends_hist.json = 同結構但 h 不截斷(2021 起全部),只推 data 分支(⛔ 不上 gh-pages)
用法:FINMIND_TOKENS=... python3 dividend_miner.py [--limit N] [--since 2021-01-01]
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = 'https://api.finmindtrade.com/api/v4/data'
DATA = Path(os.getenv('DATA_DIR') or 'data')
OUT = DATA / 'dividends.json'
OUT_HIST = DATA / 'dividends_hist.json'
SINCE = os.getenv('DIV_SINCE') or '2021-01-01'
MIN_OK = int(os.getenv('DIV_MIN_OK') or 500)
KEEP = 12                      # 前端檔每檔最多留幾筆歷史
SLEEP = float(os.getenv('DIV_SLEEP') or 0.65)   # FinMind 100 req/min → ~92/min
TW = timezone(timedelta(hours=8))
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
STAT = {'ok': 0, 'empty': 0, 'fail': 0, 'kept_old': 0, 'reasons': {}}
_paid_k = None                 # 探路時找到的付費金鑰索引(之後只用它,別每檔都輪 4 把)


def _classify(raw):
    r = (raw or '').lower()
    if 'level' in r and 'register' in r:
        return '帳號等級是免費層'
    if 'illegal' in r or 'invalid' in r:
        return '金鑰無效'
    if 'rate' in r or 'limit' in r or '429' in r:
        return '限流'
    return 'http_' + (r[:24] or '?')


def fm(dataset, data_id, start, fetch=None):
    """回 (rows | None, note)。⭐ 探路後鎖定那一把;探路階段每一把都試(V72.5.3 教訓)。"""
    global _paid_k
    fetch = fetch or _http
    ks = [_paid_k] if _paid_k is not None else list(range(max(1, len(TOKENS))))
    last = 'no-token'
    for k in ks:
        q = {'dataset': dataset, 'data_id': data_id, 'start_date': start}
        if TOKENS:
            q['token'] = TOKENS[k]
        rows, err = fetch(API + '?' + urllib.parse.urlencode(q))
        if rows is not None:
            if _paid_k is None:
                _paid_k = k
                print(f'🔑 用第 {k+1} 把金鑰(付費層)')
            return rows, f'第{k+1}把 OK'
        last = f'第{k+1}把/{err}'
        cls = _classify(err)
        STAT['reasons'][cls] = STAT['reasons'].get(cls, 0) + 1
    return None, last


def _http(url):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            j = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')[:200]
        try:
            raw = str((json.loads(raw) or {}).get('msg') or raw)
        except Exception:
            pass
        return None, f'HTTP {e.code} {raw[:80]}'
    except Exception as e:
        return None, type(e).__name__
    if not isinstance(j, dict) or j.get('status') not in (200, None):
        return None, str((j or {}).get('msg'))[:80]
    return j.get('data') or [], ''


def compact(res_rows, pol_rows, today):
    """FinMind 兩個資料集 → {h:[...], up:[...]}。⛔ 純函式,測試直接餵假列。"""
    h = []
    for r in res_rows or []:
        d = str(r.get('date') or '')[:10]
        cash = r.get('stock_and_cache_dividend')
        if not d or cash is None:
            continue
        typ = str(r.get('stock_or_cache_dividend') or '')[:1]      # 息 / 權
        h.append([d, round(float(cash), 4), typ, _f(r.get('before_price')), _f(r.get('reference_price'))])
    h.sort()
    seen, up = set(x[0] for x in h), []
    for r in pol_rows or []:
        d = str(r.get('CashExDividendTradingDate') or '')[:10]
        cash = r.get('CashEarningsDistribution')
        if not d or d < today or d in seen or cash is None:
            continue
        try:
            up.append([d, round(float(cash) + float(r.get('CashStatutorySurplus') or 0), 4)])
        except Exception:
            continue
    up = sorted({u[0]: u for u in up}.values())
    return {'h': h, 'up': up}


def _f(x):
    try:
        return round(float(x), 2) if x is not None else None
    except Exception:
        return None


def load_old(path):
    try:
        j = json.loads(path.read_text(encoding='utf-8'))
        return j.get('d') or {} if isinstance(j, dict) else {}
    except Exception:
        return {}


def merge(old, new):
    """③ 這輪失敗的股票保留舊資料;成功的以新為準。"""
    out = dict(old)
    out.update(new)
    return out


def write(d_full, today, syms_n):
    payload = {'updated': datetime.now(TW).strftime('%Y-%m-%dT%H:%M:%S+08:00'), 'data_date': today,
               'from': SINCE, 'n': len(d_full), 'syms_scanned': syms_n,
               'caveat': '除息日/股利來自 FinMind;up 是公司公告的未來除息日(可能變更)。⛔ 不是投資建議。'}
    hist = dict(payload); hist['d'] = d_full
    lite = dict(payload); lite['d'] = {s: {'h': v['h'][-KEEP:], 'up': v['up']} for s, v in d_full.items()}
    DATA.mkdir(parents=True, exist_ok=True)
    OUT_HIST.write_text(json.dumps(hist, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    OUT.write_text(json.dumps(lite, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def main(argv=None):
    argv = argv or sys.argv[1:]
    limit = int(argv[argv.index('--limit') + 1]) if '--limit' in argv else 0
    today = datetime.now(TW).strftime('%Y-%m-%d')
    syms = sorted(p.stem for p in DATA.glob('*.json') if p.stem.isdigit() and 4 <= len(p.stem) <= 6)
    if limit:
        syms = syms[:limit]
    print(f'📂 {len(syms)} 檔(含 ETF —— 0050/0056 的配息正是要的)・自 {SINCE} ・金鑰 {len(TOKENS)} 把')
    # ① 探路:2330 一定有除息紀錄;拿不到 = 金鑰/層級問題,⛔ 不硬跑
    probe, note = fm('TaiwanStockDividendResult', '2330', SINCE)
    if probe is None or len(probe) < 3:
        print(f'❌ 探路失敗(2330 除權息拿不到:{note})→ 需要付費層金鑰,⛔ 不覆寫舊檔。原因統計:{STAT["reasons"]}')
        return 1
    old = load_old(OUT_HIST)
    new, t0 = {}, time.time()
    for i, s in enumerate(syms):
        res, n1 = fm('TaiwanStockDividendResult', s, SINCE); time.sleep(SLEEP)
        pol, n2 = fm('TaiwanStockDividend', s, SINCE); time.sleep(SLEEP)
        if res is None and pol is None:
            STAT['fail'] += 1
            if s in old:
                STAT['kept_old'] += 1
            continue
        c = compact(res, pol, today)
        if not c['h'] and not c['up']:
            STAT['empty'] += 1
            continue
        new[s] = c; STAT['ok'] += 1
        if (i + 1) % 200 == 0:
            write(merge(old, new), today, len(syms))
            print(f'  … {i+1}/{len(syms)} ・有紀錄 {STAT["ok"]} ・{(time.time()-t0)/60:.1f} 分', flush=True)
    full = merge(old, new)
    print(f'📊 成功 {STAT["ok"]} ・沒有配息紀錄 {STAT["empty"]} ・失敗 {STAT["fail"]}(保留舊資料 {STAT["kept_old"]})・原因 {STAT["reasons"]} ・{(time.time()-t0)/60:.1f} 分')
    if len(full) < MIN_OK:
        print(f'❌ 只有 {len(full)} 檔有紀錄(門檻 {MIN_OK})→ ⛔ 拒絕覆寫舊檔')
        return 1
    write(full, today, len(syms))
    print(f'✅ 已寫出 {OUT}({OUT.stat().st_size/1024:.0f} KB)與 {OUT_HIST}({OUT_HIST.stat().st_size/1024:.0f} KB)・{len(full)} 檔・未來除息 {sum(1 for v in full.values() if v["up"])} 檔')
    return 0


if __name__ == '__main__':
    sys.exit(main())
