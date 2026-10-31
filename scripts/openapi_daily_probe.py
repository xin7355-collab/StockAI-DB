#!/usr/bin/env python3
"""🌐 V80.0.2 全市場當日 K 線探針 —— 回答「TW_DAILY_ALL 可不可以打開」。

在 GitHub Actions 跑(這個雲端環境連不到證交所/櫃買,只有 runner 連得到):
  ① 抓上市 STOCK_DAY_ALL + 上櫃每日收盤行情:HTTP 狀態、列數、欄位名、日期分布
  ② 用 miner.parse_daily_all(正式採礦會用的同一支)解析,看哪一關擋下
  ③ 抽樣幾百檔,跟網站上 data/{sym}.json **同一天**那根逐欄對拍(開高低收量)
  ④ 順便量逐股端點(STOCK_DAY / st43)現在從 runner 打的 HTTP 狀態 —— 被擋就看得到
⛔ 只讀:不寫任何檔案、不碰任何分支。結果只有數量(+ 前幾個對不上的代號,公開行情,方便查)。

🗓️ V80.1.0 追加三段(只量、不判):
  ⑤ 三大法人回應「是哪一天」:最新一天 + 往前 5 個交易日,上市 T86 / 上櫃三條候選各打一次,
     印出 date / title / tables[].date 與 miner._resp_date_check 的判斷 —— 用來決定 _OTC_INST_DATE_STRICT 能不能打開
  ⑥ 上櫃新站逐股月資料 tradingStock:HTTP 狀態、欄位、前兩列、日期欄有沒有星號(要不要換掉已失效的 st43)
  ⑦ ISIN 代號表(上市 / 上櫃 / 興櫃):HTTP 狀態、編碼、表格列數(要不要拿它補市場別)

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

    # ⑤ 三大法人回應的日期欄位(V80.1.0)
    say('\n## 🗓️ 三大法人回應「是哪一天」')
    days = []
    r, _ = get(f'{SITE}%5ETWII.json?t={int(time.time())}')
    try:
        tw = r.json() if not isinstance(r, Exception) and r.status_code == 200 else []
        days = [str(x.get('date'))[:10] for x in tw if isinstance(x, dict)][-6:]
    except ValueError:
        days = []
    if len(days) < 6:
        say('- 讀不到網站的加權日 K,跳過這段')
    else:
        import datetime as _dt
        for ds in (days[-1], days[0]):
            dd = _dt.date(*map(int, ds.replace('-', '/').split('/')))
            roc = f"{dd.year - 1911}/{dd.strftime('%m/%d')}"
            urls = [('T86', f"https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date={dd.strftime('%Y%m%d')}&selectType=ALL"),
                    ('上櫃新站(西元)', f"https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date={dd.strftime('%Y/%m/%d')}&response=json"),
                    ('上櫃新站(民國)', f"https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date={roc}&response=json"),
                    ('上櫃舊站', f"https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&se=EW&t=D&d={roc}")]
            for tag, u in urls:
                r, dt = get(u)
                time.sleep(2.0)
                if isinstance(r, Exception):
                    say(f'- {ds} {tag}:{type(r).__name__}'); continue
                try:
                    j = r.json()
                except ValueError:
                    say(f'- {ds} {tag}:HTTP {r.status_code} 不是 JSON(開頭 {r.text[:30]!r})'); continue
                tabs = j.get('tables') if isinstance(j, dict) else None
                t0 = tabs[0] if isinstance(tabs, list) and tabs and isinstance(tabs[0], dict) else {}
                nrow = len((t0.get('data') if t0 else None) or (j.get('data') if isinstance(j, dict) else None) or (j.get('aaData') if isinstance(j, dict) else None) or [])
                ok, why = M._resp_date_check(j, dd)
                say(f"- {ds} {tag}:HTTP {r.status_code}・最上層欄位 {sorted(j.keys())[:12] if isinstance(j, dict) else type(j).__name__}"
                    f"・date={j.get('date') if isinstance(j, dict) else None!r}・reportDate={j.get('reportDate') if isinstance(j, dict) else None!r}"
                    f"・title={str(j.get('title') if isinstance(j, dict) else '')[:30]!r}・tables[0].date={t0.get('date')!r}"
                    f"・tables[0].title={str(t0.get('title') or '')[:30]!r}・列數 {nrow}・判斷 {'✅' if ok else '⛔'} {why or '日期對得上'}")

    # ⑥ 上櫃新站逐股月資料(V80.1.0;st43 已回網頁)
    say('\n## 🏪 上櫃新站逐股月資料 tradingStock')
    ym = time.strftime('%Y/%m')
    for c in ('6488', '5483'):
        for tag, u in (('西元月', f'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code={c}&date={ym}/01&response=json'),
                       ('民國月', f"https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code={c}&date={int(ym[:4]) - 1911}/{ym[5:]}/01&response=json")):
            r, dt = get(u)
            time.sleep(2.0)
            if isinstance(r, Exception):
                say(f'- {c} {tag}:{type(r).__name__}'); continue
            try:
                j = r.json()
            except ValueError:
                say(f'- {c} {tag}:HTTP {r.status_code} 不是 JSON(開頭 {r.text[:30]!r})'); continue
            tabs = j.get('tables') if isinstance(j, dict) else None
            t0 = tabs[0] if isinstance(tabs, list) and tabs and isinstance(tabs[0], dict) else {}
            rows = t0.get('data') or []
            star = sum(1 for x in rows if x and '*' in str(x[0]))
            say(f"- {c} {tag}:HTTP {r.status_code}・欄位 {t0.get('fields')}・列數 {len(rows)}・日期有星號 {star}・前兩列 {rows[:2]}")

    # ⑦ ISIN 代號表(V80.1.0)
    say('\n## 🏷️ ISIN 代號表')
    for mode, tag in ((2, '上市'), (4, '上櫃'), (5, '興櫃')):
        r, dt = get(f'https://isin.twse.com.tw/isin/C_public.jsp?strMode={mode}')
        time.sleep(2.0)
        if isinstance(r, Exception):
            say(f'- {tag}:{type(r).__name__}'); continue
        raw_b = r.content or b''
        txt = None
        for enc in ('cp950', 'big5', 'utf-8'):
            try:
                txt = raw_b.decode(enc); used = enc; break
            except UnicodeDecodeError:
                continue
        ntr = (txt or '').count('<tr')
        say(f"- {tag}:HTTP {r.status_code}・{len(raw_b):,} bytes・content-type {r.headers.get('content-type')!r}・"
            f"解得開的編碼 {used if txt is not None else '沒有'}・表格列數 {ntr}・有「2330」{'2330' in (txt or '')}・有「6488」{'6488' in (txt or '')}")

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
