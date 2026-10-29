#!/usr/bin/env python3
"""🌐 V80.0.2 全市場當日 K 線探針 —— 回答「TW_DAILY_ALL 可不可以打開」。

在 GitHub Actions 跑(這個雲端環境連不到證交所/櫃買,只有 runner 連得到):
  ① 抓上市 STOCK_DAY_ALL + 上櫃每日收盤行情:HTTP 狀態、列數、欄位名、日期分布
  ② 用 miner.parse_daily_all(正式採礦會用的同一支)解析,看哪一關擋下
  ③ 抽樣幾百檔,跟網站上 data/{sym}.json **同一天**那根逐欄對拍(開高低收量)
  ④ 順便量逐股端點(STOCK_DAY / st43)現在從 runner 打的 HTTP 狀態 —— 被擋就看得到
⛔ 只讀:不寫任何檔案、不碰任何分支。結果只有數量(+ 前幾個對不上的代號,公開行情,方便查)。

判準(全過才建議打開):
  上市、上櫃都 HTTP 200 + 日期一致 + 過列數門檻;抽樣對拍收盤一致 ≥ 98%、量一致 ≥ 95%。
"""
import json
import os
import random
import statistics
import sys
import time
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
for _m in ('yfinance', 'pandas'):
    if _m not in sys.modules:
        try:
            __import__(_m)
        except ImportError:
            sys.modules[_m] = types.ModuleType(_m)

import requests  # noqa: E402
import miner as M  # noqa: E402

SITE = 'https://xin7355-collab.github.io/StockAI-DB/data/'
N_SAMPLE = int(os.environ.get('PROBE_SAMPLE') or '200')   # 每個市場抽幾檔(⚠️ inputs 沒填時是空字串 → 要 or 預設)
OUT = []


def say(s=''):
    print(s)
    OUT.append(s)


def get(url, **kw):
    t0 = time.time()
    try:
        r = requests.get(url, headers=M._rnd_hdrs(), timeout=40, **kw)
        return r, time.time() - t0
    except Exception as e:  # noqa: BLE001
        return e, time.time() - t0


def main():
    verdict = []
    say('## 🌐 全市場當日 K 線探針')
    raw = {}
    for mkt, (url, fmap) in M._DAILY_ALL_SRC.items():
        r, dt = get(url)
        if isinstance(r, Exception):
            say(f'- {mkt.upper()}:連線失敗 {type(r).__name__}({dt:.1f}s)')
            verdict.append(f'{mkt} 連不上')
            continue
        say(f'- {mkt.upper()}:HTTP {r.status_code}、{len(r.content) // 1024} KB、{dt:.1f}s')
        if r.status_code != 200:
            verdict.append(f'{mkt} HTTP {r.status_code}')
            continue
        try:
            rows = r.json()
        except ValueError:
            say(f'  - 回應不是 JSON(開頭:{r.text[:40]!r})')
            verdict.append(f'{mkt} 不是 JSON')
            continue
        raw[mkt] = rows
        keys = sorted(rows[0].keys()) if isinstance(rows, list) and rows and isinstance(rows[0], dict) else []
        say(f'  - 列數 {len(rows) if isinstance(rows, list) else "?"}、欄位 {keys}')
        miss = [v for v in fmap.values() if v not in keys]
        if miss:
            say(f'  - ⛔ miner 用到但回應沒有的欄位:{miss}')
            verdict.append(f'{mkt} 缺欄位 {miss}')
        dates = {}
        for x in rows if isinstance(rows, list) else []:
            d = M._oapi_date(x.get(fmap['date'])) if isinstance(x, dict) else None
            dates[d] = dates.get(d, 0) + 1
        say(f'  - 日期分布(前 3):{sorted(dates.items(), key=lambda kv: -kv[1])[:3]}')
        _, info = M.parse_daily_all(rows, mkt, None, None)
        say(f'  - parse_daily_all(不濾白名單):收 {info["kept"]}、沒成交 {info["no_trade"]}、'
            f'欄位有問題 {info["bad"]}、日期 {info["date"]}({info["share"]:.1%})→ {info["reason"] or "OK"}')
        if info['reason']:
            verdict.append(f'{mkt} {info["reason"]}')

    # ③ 抽樣對拍
    say('\n## 🔍 跟網站 data/{sym}.json 同一天對拍')
    rnd = random.Random(20261030)
    for mkt, rows in raw.items():
        # 對拍不受列數門檻影響(門檻沒過已記在結論;這裡要看「有的那些」對不對得上)
        _mn, M._DAILY_ALL_MIN[mkt] = M._DAILY_ALL_MIN[mkt], 1
        got, info = M.parse_daily_all(rows, mkt, None, None)
        M._DAILY_ALL_MIN[mkt] = _mn
        if not got:
            continue
        day = info['date']
        codes = sorted(got)
        # 4 碼普通股 + 00 開頭 ETF 優先(權證多半沒有 data 檔,抽到也只是 404)
        pool = [c for c in codes if (len(c) == 4 and c.isdigit()) or c.startswith('00')]
        sample = rnd.sample(pool, min(N_SAMPLE, len(pool)))
        n_file = n_day = 0
        eq = {'open': 0, 'high': 0, 'low': 0, 'close': 0, 'volume': 0}
        vol_ratio, bad = [], {k: [] for k in eq}
        for c in sample:
            r, _ = get(f'{SITE}{c}.json?t={int(time.time())}')
            time.sleep(0.05)
            if isinstance(r, Exception) or r.status_code != 200:
                continue
            n_file += 1
            try:
                bars = r.json()
            except ValueError:
                continue
            mine = next((b for b in reversed(bars) if b.get('date') == day), None)
            if not mine:
                continue
            n_day += 1
            new = got[c]
            for k in eq:
                a, b = mine.get(k), new[k]
                same = a is not None and abs(float(a) - float(b)) <= (0 if k == 'volume' else 1e-6)
                if same:
                    eq[k] += 1
                elif len(bad[k]) < 5:
                    bad[k].append(f'{c}:{a}→{b}')
            if mine.get('volume'):
                vol_ratio.append(new['volume'] / mine['volume'])
        say(f'- {mkt.upper()} {day}:抽 {len(sample)} 檔 → 網站有檔 {n_file}、有這天 {n_day}')
        if not n_day:
            verdict.append(f'{mkt} 網站沒有 {day} 可對拍')
            continue
        for k, v in eq.items():
            say(f'  - {k}:一致 {v}/{n_day}({v / n_day:.1%})' + (f',例:{bad[k]}' if bad[k] else ''))
        if vol_ratio:
            say(f'  - 量的比值中位數 {statistics.median(vol_ratio):.4f}(1 = 單位相同;0.001 = 張 vs 股)')
        if eq['close'] / n_day < 0.98:
            verdict.append(f'{mkt} 收盤一致只有 {eq["close"] / n_day:.1%}')
        if eq['volume'] / n_day < 0.95:
            verdict.append(f'{mkt} 量一致只有 {eq["volume"] / n_day:.1%}')

    # ④ 逐股端點現況
    say('\n## 🧯 逐股端點從 runner 打的狀態')
    ym = time.strftime('%Y%m')
    for c in ('2330', '2317', '0050'):
        r, dt = get(f'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?response=json&date={ym}01&stockNo={c}')
        st = type(r).__name__ if isinstance(r, Exception) else f'HTTP {r.status_code} 開頭 {r.text[:12]!r}'
        say(f'- TWSE STOCK_DAY {c}:{st}({dt:.1f}s)')
        time.sleep(1.5)
    roc = int(ym[:4]) - 1911
    for c in ('6488', '5483', '8069'):
        r, dt = get(f'https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/'
                    f'st43_result.php?l=zh-tw&d={roc}/{ym[4:]}&stkno={c}&o=json')
        st = type(r).__name__ if isinstance(r, Exception) else f'HTTP {r.status_code} 開頭 {r.text[:12]!r}'
        say(f'- TPEx st43 {c}:{st}({dt:.1f}s)')
        time.sleep(1.5)

    say('\n## 結論')
    if verdict:
        say('⛔ 先不要打開 TW_DAILY_ALL:' + ';'.join(verdict))
    else:
        say('✅ 全部過關 → 可以在 daily_miner 設 TW_DAILY_ALL=1')
    sp = os.environ.get('GITHUB_STEP_SUMMARY')
    if sp:
        with open(sp, 'a', encoding='utf-8') as f:
            f.write('\n'.join(OUT) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
