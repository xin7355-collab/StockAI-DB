#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
💳 V79.6.6 上市融資融券(證交所帶日期那份 rwd MI_MARGN)真實格式探針 —— 只讀、只印、⛔ 不寫檔、⛔ 不需要金鑰

為什麼要有這支:沙箱連不到證交所(403),新的解析(miner._twse_margin_parse)只能用測資驗;
真實回應長怎樣,只有在 Actions 上看得到 → `macro_probe.yml` 選 which=twse_margin 手動跑(約 1 分鐘)。

印出來的東西(⭐ 走正式入口,⛔ 這裡不抄一份解析邏輯):
  ① 每一天:stat / 回應日期 / 表名 / 個股表的 fields・groups・前兩列 → miner._twse_margin_parse 收不收、收了幾檔、為什麼不收
  ② 相鄰兩天:後一天的「前日餘額」== 前一天的「今日餘額」幾 %(每一天真的是那一天,鏈才接得起來)
  ③ OpenAPI(沒有日期參數):miner._twse_oapi_check 拿「前一個交易日」帶日期那份驗它收不收;
     它的「今日餘額」跟最近一天帶日期那份一樣幾 %
  ④ 最後一行判定;一天都解不出來(而證交所有回)→ exit 1(⛔ 全綠卻沒驗到)
"""
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('FINMIND_TOKENS', '')
import miner  # noqa: E402

TPE = timezone(timedelta(hours=8))
OAPI = 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN'
WATCH = ('2330', '1303', '2317', '2454')
# 固定抽樣:錯位期中間(2026-06)、凍結那一個月(2026-05-20)、錯位前(2026-03)、更早兩年 —— 看舊格式還解不解得出來
FIXED = [date(2026, 6, 15), date(2026, 5, 20), date(2026, 3, 16), date(2025, 10, 1), date(2024, 6, 3)]


def recent_weekdays(n, today=None):
    d = today or datetime.now(TPE).date()
    out = []
    while len(out) < n:
        d -= timedelta(days=1)
        if d.weekday() < 5:
            out.append(d)
    return out


def get_json(url):
    try:
        r = miner.http_session.get(url, headers=miner._rnd_hdrs(), timeout=20)
        return r.status_code, r.json()
    except Exception as e:
        return None, f'{type(e).__name__}: {str(e)[:120]}'


def stock_table(j):
    for t in (j.get('tables') or []):
        if isinstance(t, dict) and '融資融券彙總' in str(t.get('title') or ''):
            return t
    return None


def main():
    days = recent_weekdays(int(os.environ.get('PROBE_DAYS') or 8)) + FIXED
    got, stat_ok, parsed = {}, 0, 0
    print(f'💳 證交所 rwd MI_MARGN 格式探針:{len(days)} 天({days[0]} ~ {days[-1]})')
    for d in days:
        url = f'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date={d.strftime("%Y%m%d")}&selectType=ALL'
        code, j = get_json(url)
        time.sleep(3)                                   # 🐢 證交所限流:一次一個、間隔 3 秒
        if not isinstance(j, dict):
            print(f'\n── {d} ❌ HTTP {code} 回應不是 JSON:{str(j)[:120]}')
            continue
        st = j.get('stat')
        print(f'\n── {d}({"一二三四五六日"[d.weekday()]})stat={str(st)[:40]} date={j.get("date")} '
              f'表名={[str(t.get("title"))[:26] for t in (j.get("tables") or []) if isinstance(t, dict)]}')
        if st != 'OK':
            continue
        stat_ok += 1
        t = stock_table(j)
        if t:
            print(f'   fields={t.get("fields")}')
            print(f'   groups={t.get("groups")}')
            for r in (t.get('data') or [])[:2]:
                print(f'   列={r[:16]}')
        res, prev, why = miner._twse_margin_parse(j, d)
        if res:
            parsed += 1
            got[d] = (res, prev)
            w = ' '.join(f'{s}:融資{res[s]["margin_balance"]:,}/融券{res[s]["short_balance"]:,}' for s in WATCH if s in res)
            print(f'   ✅ 收:{len(res):,} 檔 ・{w}')
        else:
            print(f'   ⛔ 不收:{why}')

    # ② 鏈:後一天的前日餘額 == 前一天的今日餘額
    ds = sorted(got)
    print('\n── ② 相鄰兩天接不接得起來(後一天的「前日餘額」== 前一天的「今日餘額」)')
    for a, b in zip(ds, ds[1:]):
        if (b - a).days > 5:
            continue
        ra, pb = got[a][0], got[b][1]
        com = [s for s in pb if s in ra]
        eq = sum(1 for s in com if pb[s] == ra[s]['margin_balance'])
        print(f'   {a} → {b}:{eq:,}/{len(com):,} 檔一致({(eq / len(com) * 100) if com else 0:.1f}%)')

    # ③ OpenAPI
    print('\n── ③ OpenAPI(沒有日期參數)')
    code, rows = get_json(OAPI)
    if isinstance(rows, list) and rows:
        print(f'   {len(rows):,} 列・首列 keys={list(rows[0].keys())[:14]}')
        # 三欄各有幾列是空字串 / 不是數字(V79.6.6 第一次實跑:1,302 列只有 736 列三欄都解得出數字)
        for k in ('融資今日餘額', '融資前日餘額', '融券今日餘額'):
            vals = [r.get(k) for r in rows if isinstance(r, dict)]
            emp = [v for v in vals if not str(v if v is not None else '').strip()]
            bad = [v for v in vals if str(v if v is not None else '').strip() and miner._num_tw(v) is None]
            print(f'   {k}:空的 {len(emp):,} 列・不是數字 {len(bad):,} 列' + (f'(例:{bad[:3]})' if bad else ''))
        ex = [r for r in rows if isinstance(r, dict) and any(not str(r.get(k) if r.get(k) is not None else '').strip()
                                                             for k in ('融資今日餘額', '融券今日餘額'))][:2]
        for r in ex:
            print(f'   空值的例子:{ {k: r.get(k) for k in list(r.keys())[:14]} }')
        if len(ds) >= 2:
            last, before = ds[-1], ds[-2]
            if not (0 < (last - before).days <= 5):
                last, before = ds[0], None
            # 正常(證交所已更新):拿最近一天的「前一天」當基準 → 收;拿最近一天自己當基準 → 不收(它跟基準一樣 = 看起來像舊的)
            print(f'   (正常:拿 {before} 當前一天 → 收;拿 {last} 自己當前一天 → 不收)' if before else '')
            for pv_day in (before, last):
                if pv_day is None:
                    continue
                pv = {s: v['margin_balance'] for s, v in got[pv_day][0].items()}
                ores, why = miner._twse_oapi_check(rows, pv)
                print(f'   拿 {pv_day} 當前一天驗:{"✅ 收 " + format(len(ores), ",") + " 檔" if ores else "⛔ 不收:" + why}')
            rl = got[last][0]
            com = [str(r.get('股票代號') or '').strip() for r in rows if isinstance(r, dict)]
            com = [s for s in com if s in rl]
            eqt = sum(1 for r in rows if isinstance(r, dict) and str(r.get('股票代號') or '').strip() in rl
                      and miner._num_tw(r.get('融資今日餘額')) == rl[str(r.get('股票代號')).strip()]['margin_balance'])
            print(f'   它的今日餘額 == {last} 帶日期那份:{eqt:,}/{len(com):,} 檔')
    else:
        print(f'   ❌ HTTP {code} 讀不到:{str(rows)[:120]}')

    print(f'\n判定:證交所有回 {stat_ok}/{len(days)} 天・新解析收下 {parsed} 天')
    if stat_ok and not parsed:
        print('❌ 證交所有回,但新解析一天都收不下來 → 真實格式跟測資不一樣,要修 _twse_margin_cols / _twse_margin_parse')
        return 1
    if not stat_ok:
        print('⚠️ 證交所一天都沒回 OK(被擋?)→ 這一輪驗不到,換時間再跑')
    return 0


if __name__ == '__main__':
    sys.exit(main())
