#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
💳 otc_margin_probe.py —— 上櫃融資券「到底哪個端點還活著」探針(只讀、不寫檔、不碰 gh-pages/data)。

🚨 背景(V75.1.3):`data/5483.json` 的 `margin_balance` 從 **2026-08-12 起全 0**。
   `miner.fetch_market_margin` 的上櫃那段只打 TPEx **舊站** `margin_bal_result.php`,
   而 TPEx 整站對 GitHub runner 早就 403(V73.6.1 實測);FinMind 備援又只在
   「TWSE+TPEx **全部**失敗」或「融券全 0」才啟動 → **TWSE 上市成功就永遠不會為上櫃補**。
   → 上櫃 800 多檔的融資券全部停在 08/11,前端顯 0、零錯誤訊息。

⭐ 照鐵則:⛔ 憑猜的端點直接上 = 又一輪「改 → 等 workflow → 看 log」。這支一次試完全部候選,
   每一筆印 HTTP 狀態 + content-type + 回應前 200 字(陷阱 #23:不存在的路徑常回 200 + HTML)。
   並且**放一個已知會通的對照組**(TWSE MI_MARGN)—— 對照組也掛 = 這台機器被擋,⛔ 不是端點改名。

用法(GHA 手動 dispatch:finmind_gap_probe.yml → which = otcmargin):
   python3 scripts/otc_margin_probe.py [YYYY-MM-DD]
"""
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import miner  # noqa: E402


def _last_trading_day(d):
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _show(tag, r):
    ct = (r.headers.get('content-type') or '')[:40]
    body = (r.text or '')
    print(f"  {tag:<52} HTTP {r.status_code} ・{ct} ・{len(body)} bytes")
    print(f"     ↳ {body[:200].replace(chr(10), ' ')!r}")
    if r.status_code == 200 and 'json' in ct.lower():
        try:
            j = r.json()
            if isinstance(j, dict):
                print(f"     ↳ keys={list(j.keys())[:8]} stat={j.get('stat')!r} tables={len(j.get('tables') or [])} aaData={len(j.get('aaData') or [])} data={len(j.get('data') or [])}")
                for t in (j.get('tables') or [])[:3]:
                    print(f"        table title={str(t.get('title'))[:40]!r} fields={(t.get('fields') or [])[:10]} rows={len(t.get('data') or [])}")
            elif isinstance(j, list):
                print(f"     ↳ list[{len(j)}] first={str(j[0])[:160] if j else ''}")
        except Exception as e:
            print(f"     ↳ JSON 解析失敗:{e}")


def main():
    d = _last_trading_day(date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else date.today() - timedelta(days=1))
    roc = f"{d.year - 1911}/{d.strftime('%m/%d')}"
    ce = d.strftime('%Y/%m/%d')
    ce8 = d.strftime('%Y%m%d')
    print(f"💳 上櫃融資券端點探針 ・日期 {d}(民國 {roc})・runner={os.getenv('GITHUB_ACTIONS', '本機')}")
    H = miner._rnd_hdrs()
    S = miner.http_session

    print("\n🆚 對照組(已知會通;這組掛了 = 機器被擋,下面全部失敗不可解讀成端點改名)")
    for tag, url in [
        ('TWSE MI_MARGN(上市融資券)', f"https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date={ce8}&selectType=ALL"),
        ('TPEx st41(本站在用的上櫃日成交,同一台主機)', f"https://www.tpex.org.tw/www/zh-tw/afterTrading/otc/st41?date={ce}&response=json"),
    ]:
        try:
            _show(tag, S.get(url, headers=H, timeout=15))
        except Exception as e:
            print(f"  {tag:<52} EXC {str(e)[:120]}")

    print("\n🔎 候選端點(上櫃融資券餘額)")
    cands = [
        ('www 新站 margin/balance ce', f"https://www.tpex.org.tw/www/zh-tw/margin/balance?date={ce}&response=json"),
        ('www 新站 margin/balance roc', f"https://www.tpex.org.tw/www/zh-tw/margin/balance?date={roc}&response=json"),
        ('www 新站 margin/balance ce8', f"https://www.tpex.org.tw/www/zh-tw/margin/balance?date={ce8}&response=json"),
        ('rwd margin/balance', f"https://www.tpex.org.tw/rwd/zh/margin/balance?date={ce}&response=json"),
        ('www marginTrading/balance', f"https://www.tpex.org.tw/www/zh-tw/marginTrading/balance?date={ce}&response=json"),
        ('www margin/marginBalance', f"https://www.tpex.org.tw/www/zh-tw/margin/marginBalance?date={ce}&response=json"),
        ('舊站 margin_bal_result.php(本站現在打的)', f"https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d={roc}"),
        ('openapi tpex_mainboard_margin_trading', "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_trading"),
        ('openapi tpex_margin_trading', "https://www.tpex.org.tw/openapi/v1/tpex_margin_trading"),
        ('openapi tpex_mainboard_daily_margin', "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_margin_transactions"),
        ('openapi 清單(讓官方自己說有哪些)', "https://www.tpex.org.tw/openapi/"),
    ]
    for tag, url in cands:
        try:
            _show(tag, S.get(url, headers=H, timeout=15))
        except Exception as e:
            print(f"  {tag:<52} EXC {str(e)[:120]}")

    print("\n🔎 FinMind 備援(bulk,省略 data_id)—— 只看回幾列、有沒有上櫃股(5483 / 6488 / 3105)")
    try:
        url_fm = (f"https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMarginPurchaseShortSale"
                  f"&start_date={d.isoformat()}&end_date={d.isoformat()}")
        j = miner.fm_request(url_fm, timeout=30) or {}
        rows = j.get('data') or []
        ids = {str(r.get('stock_id')) for r in rows}
        print(f"  列數 {len(rows)} ・含 5483={('5483' in ids)} 6488={('6488' in ids)} 3105={('3105' in ids)} 2330={('2330' in ids)} ・msg={j.get('msg')!r}")
        print(f"  _FINMIND_BLOCKED={miner._FINMIND_BLOCKED} ・tokens={len(miner.FINMIND_TOKENS)} 把(⛔ 只印數量)")
        if rows:
            print(f"  首筆 keys={list(rows[0].keys())}")
    except Exception as e:
        print(f"  FinMind EXC {str(e)[:160]}")
    print("\n📋 判讀:對照組通 + 候選全 HTML/403 → TPEx 上櫃融資券對 runner 沒有活的端點,備援只能走 FinMind bulk;"
          "\n        對照組也掛 → 這台 runner 被擋,結論不可用,換時間再跑。")


if __name__ == '__main__':
    main()
