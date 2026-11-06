#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🌏 world_hist_miner.py —— 各國股市指數 + 美國債券 ETF 全部歷史日線 → world_hist 分支 `world_hist.json.gz`(V82.0.0)

為什麼要有這支(使用者 11/06:「需要比對別的國家要挖礦就挖礦」):
  「大跌之後什麼時候開始進場」那些自創招式(scripts/rebound_lab_probe.mjs)要在**別的國家**再驗一次(樣本外),
  台股自己 1990 起只有 20 段修正 —— 樣本太少,一個招式在台股好看可能只是運氣。
  crash_global_probe 只抓了 8 個市場;這支抓 ~40 個指數 + 高收益債 / 公債 ETF(信用利差的替代品)。

設計:
  ① 每一檔自己的交易日(⛔ 對齊美股 —— 各國放假不同天,對齊會把「前一天」算錯;同 us_hist 的 ASIA)
  ② 指數 = 收盤價;ETF = auto_adjust=True(含息,算報酬用)。⛔ 成交量不收(Yahoo 的指數成交量不能用)
  ③ 單日 |報酬| > 25%(指數)→ 記 `jump` 但⛔ 改數字(1987 黑色星期一 −20%、土耳其 2020 年除以 100 這種要探針自己處理,這裡只標)
  ④ 每一檔印第一天 / 最後一天 / 幾天;抓不到的進 errors(⛔ 靜默)
  ⑤ FRED 探路(BAA10Y 公司債利差、BAMLH0A0HYM2 高收益債利差):拿得到就存,拿不到記原因(Actions 常被 FRED 擋)
  ⑥ 空過守門:成功 ≥ 25 檔才寫檔(⛔ 用半套蓋掉上一份)
  ⑦ ⛔ 排程 —— 只能手動派(us_hist.yml group=world);⛔ 進 gh-pages(App 用不到,獨立分支)

用法:
  OUT=/tmp/world_hist.json.gz python3 scripts/world_hist_miner.py
  python3 scripts/world_hist_miner.py --selftest
"""
import gzip
import json
import os
import sys
import time
import datetime as _dt

INDICES = [
    # 美洲
    '^GSPC', '^DJI', '^IXIC', '^RUT', '^GSPTSE', '^BVSP', '^MXX', '^MERV',
    # 歐洲
    '^FTSE', '^GDAXI', '^FCHI', '^STOXX50E', '^AEX', '^IBEX', 'FTSEMIB.MI', '^SSMI', '^OMX', '^BFX', '^ATX', 'XU100.IS',
    # 亞太
    '^N225', '^HSI', '^KS11', '^TWII', '000001.SS', '399001.SZ', '^STI', '^AXJO', '^AORD', '^NZ50', '^BSESN', '^NSEI', '^JKSE', '^KLSE', '^SET.BK', 'PSEI.PS',
    # 中東
    '^TA125.TA',
    # 波動
    '^VIX',
]
BONDS = ['HYG', 'JNK', 'LQD', 'IEF', 'TLT', 'SHY']        # 含息(auto_adjust)→ 高收益債 ÷ 公債 = 信用緊不緊的替代品
FRED = ['BAA10Y', 'BAMLH0A0HYM2']
OUT = os.environ.get('OUT') or '/tmp/world_hist.json.gz'
MIN_OK = int(os.environ.get('MIN_OK') or 25)
JUMP = 0.25


def compact_one(dates, closes):
    """(日期字串, 收盤) → 去掉 NaN / ≤0、照日期排、同一天留最後一筆;回 (d, c, jumps)"""
    m = {}
    for d, c in zip(dates, closes):
        try:
            c = float(c)
        except (TypeError, ValueError):
            continue
        if not (c > 0) or c != c:
            continue
        m[str(d)[:10]] = round(c, 4)
    d = sorted(m)
    c = [m[x] for x in d]
    jumps = [d[i] for i in range(1, len(c)) if abs(c[i] / c[i - 1] - 1) > JUMP]
    return d, c, jumps


def fetch_yf(tickers, adjust):
    import yfinance as yf
    out, errors = {}, {}
    for t in tickers:
        last_err = ''
        for k in range(3):                                # 退避 2 / 4 秒
            try:
                h = yf.Ticker(t).history(period='max', auto_adjust=adjust)
                if h is None or len(h) == 0:
                    last_err = '回空'
                else:
                    d, c, jumps = compact_one([x.strftime('%Y-%m-%d') for x in h.index], list(h['Close']))
                    if len(d) < 250:
                        last_err = f'只有 {len(d)} 天'
                    else:
                        out[t] = {'d': d, 'c': c, 'jumps': jumps[:50]}
                        print(f'  ✅ {t:<12} {d[0]} ~ {d[-1]} ・{len(d):>6} 天' + (f' ・跳 >25% {len(jumps)} 天' if jumps else ''))
                        last_err = ''
                        break
            except Exception as e:  # noqa: BLE001
                last_err = type(e).__name__
            time.sleep(2 * (k + 1))
        if last_err:
            errors[t] = last_err
            print(f'  ⛔ {t:<12} {last_err}')
        time.sleep(0.5)
    return out, errors


def parse_fred_csv(txt):
    """FRED fredgraph.csv → (d, c);'.' = 那天沒有值"""
    lines = [x.strip() for x in str(txt).splitlines() if x.strip()]
    if not lines or not lines[0].lower().startswith(('date', 'observation_date')):
        return None
    dates, vals = [], []
    for ln in lines[1:]:
        parts = ln.split(',')
        if len(parts) < 2 or parts[1] in ('.', ''):
            continue
        try:
            dates.append(parts[0][:10])
            vals.append(float(parts[1]))
        except ValueError:
            continue
    return dates, vals


def fetch_fred(ids):
    import requests
    out, diag = {}, {}
    for s in ids:
        try:
            r = requests.get(f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={s}', timeout=30,
                             headers={'User-Agent': 'Mozilla/5.0 (compatible; StockAI-DB world_hist/1.0; +https://github.com/xin7355-collab/stockai-db)'})
            if r.status_code != 200:
                diag[s] = f'HTTP {r.status_code}'
                continue
            p = parse_fred_csv(r.text)
            if not p or len(p[0]) < 100:
                diag[s] = f'格式不對或太短({(r.text or "")[:40]!r})'
                continue
            out[s] = {'d': p[0], 'c': p[1]}
            diag[s] = f'{p[0][0]} ~ {p[0][-1]} ・{len(p[0])} 天'
        except Exception as e:  # noqa: BLE001
            diag[s] = type(e).__name__
        print(f'  FRED {s}: {diag[s]}')
    return out, diag


def build(idx, bonds, fred, errors, fred_diag, today=None):
    today = today or _dt.date.today().isoformat()
    s = {**idx, **bonds}
    return {'v': 1, 'asof': today, 'meta': {'n': len(s), 'errors': errors, 'fred': fred_diag,
                                             'first': {k: v['d'][0] for k, v in s.items()}},
            's': s, 'fred': fred}


def write(doc, out=OUT):
    if doc['meta']['n'] < MIN_OK:
        print(f'⛔ 只抓到 {doc["meta"]["n"]} 檔(< {MIN_OK})→ ⛔ 寫檔(上一份保留)')
        return False
    raw = json.dumps(doc, separators=(',', ':')).encode('utf-8')
    with gzip.open(out, 'wb') as f:
        f.write(raw)
    print(f'✅ {out}:{doc["meta"]["n"]} 檔 ・{len(raw) / 1e6:.1f} MB(壓縮前)')
    return True


def main():
    print('🌏 各國指數(全部歷史):')
    idx, e1 = fetch_yf(INDICES, adjust=False)
    print('💵 債券 ETF(含息):')
    bonds, e2 = fetch_yf(BONDS, adjust=True)
    print('🏦 FRED 探路:')
    fred, fd = fetch_fred(FRED)
    doc = build(idx, bonds, fred, {**e1, **e2}, fd)
    return 0 if write(doc) else 1


def selftest():
    bad = []

    def ok(name, cond):
        print(('✅ ' if cond else '❌ ') + name)
        if not cond:
            bad.append(name)
    d, c, j = compact_one(['2020-01-03', '2020-01-02', '2020-01-02', '2020-01-06', '2020-01-07'], [101, 100, 99, float('nan'), 140])
    ok('① 照日期排、同一天留最後一筆、NaN 丟掉', d == ['2020-01-02', '2020-01-03', '2020-01-07'] and c == [99.0, 101.0, 140.0])
    ok('① 單日 >25% 只標不改', j == ['2020-01-07'] and c[-1] == 140.0)
    p = parse_fred_csv('observation_date,BAA10Y\n2020-01-02,1.9\n2020-01-03,.\n2020-01-06,2.0\n')
    ok('② FRED csv:「.」= 沒有值', p == (['2020-01-02', '2020-01-06'], [1.9, 2.0]))
    ok('② FRED 回網頁 → None', parse_fred_csv('<html>blocked</html>') is None)
    idx = {f'^T{k}': {'d': ['2020-01-02'], 'c': [1.0], 'jumps': []} for k in range(30)}
    doc = build(idx, {}, {}, {'^X': '回空'}, {'BAA10Y': 'HTTP 403'}, today='2026-11-06')
    ok('③ meta 有 errors / fred 診斷 / 每檔第一天', doc['meta']['errors'] == {'^X': '回空'} and doc['meta']['fred']['BAA10Y'] == 'HTTP 403' and doc['meta']['first']['^T0'] == '2020-01-02')
    import tempfile
    tmp = os.path.join(tempfile.mkdtemp(), 'w.json.gz')
    ok('④ 空過守門:不到 25 檔⛔ 寫檔', not write(build({'^A': idx['^T0']}, {}, {}, {}, {}), tmp) and not os.path.exists(tmp))
    ok('④ 夠了才寫,讀得回來', write(doc, tmp) and json.loads(gzip.open(tmp).read())['meta']['n'] == 30)
    print(f'selftest:{"全過" if not bad else f"{len(bad)} 失敗"}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
