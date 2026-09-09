#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏷️ stockname_probe.py —— 「代號 → 中文名」到底哪個來源給得到 ETF 探針(只讀、不寫檔、不碰 gh-pages/data)。

🚨 背景(V75.1.5):使用者截圖庫存頁四檔(009816 / 5483 / 0050 / 2327)**名字全部變成代號**,
   而且大字與小字印同一個代號。逐行查證的根因鏈:
     ① `allStockList` 是全 App 唯一股名來源(index.html:3585,初始 [])
     ② `fetchStockList` 打 FinMind `TaiwanStockInfo`,🚨 **URL 沒帶 token=**(index.html:11549),
        而 safeFetch 的輪動注入條件是 `/[?&]token=/.test(url)`(index.html:10630)→ 永遠匿名發出
     ③ 抓失敗 + cache 空 → **函式靜默結束**,allStockList 維持 []
     ④ `getStockName` 查不到 → 回傳代號本身 → 名字欄印代號
   連帶:新增庫存/自選的搜尋、全域搜尋(`_filterStockList` index.html:9325)**全部失效**。

⭐ 修法是「採礦端出一份離線名字表」,而這支探針要回答的是**唯一還沒定案的那一半:ETF 名字哪裡拿**。
   實測 gh-pages:`data/` 共 **2,718 檔,其中 00 開頭(ETF)361 檔 = 13.3%**,
   而官方公司基本資料(t187ap03)**一檔 ETF 都沒有**、`etf_tracking.json` 只有 45 檔
   → ⛔ 缺約 316 檔,ETF 來源不是補丁而是成敗關鍵。

⛔ 照鐵則:沙箱連不到 TWSE/TPEx/FinMind(proxy 擋)→ 憑猜的端點直接寫進 miner
   = 又一輪「改 → 等 30-60 分 → 看 log」。這支一次試完全部候選。

🚧 三個刻意的設計(⛔ 都別拿掉):
   ① **對照組**:放一個「本專案每天都在用、已知會通」的端點(t187ap03_L)。
      它也掛 = 這台 runner 被擋,⛔ 不可解讀成「端點改名」(同 V73.6.1 櫃買指數卡五輪的教訓)。
   ② **HTTP 200 不等於成功**(陷阱 #23):每一筆印 content-type + 回應前 200 字。
   ③ **試金石**:直接拿使用者庫存那四檔 + 兩檔主動式 ETF 去查,⛔ 不只看「回幾筆」。

用法(GHA 手動 dispatch:finmind_gap_probe.yml → which = stockname):
   python3 scripts/stockname_probe.py
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import requests

# 🎯 試金石:使用者庫存那四檔 + 兩檔主動式 ETF(009816 是較新的,最容易被舊表漏掉)
PROBE = ['0050', '009816', '00981A', '5483', '2327', '2330']

UA = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, text/plain, */*'}


def _get(url, headers=None, timeout=25):
    h = dict(UA)
    if headers:
        h.update(headers)
    return requests.get(url, headers=h, timeout=timeout)


def _show(tag, r):
    ct = (r.headers.get('content-type') or '')[:45]
    body = r.text or ''
    print(f"  {tag:<46} HTTP {r.status_code} ・{ct} ・{len(body)} bytes")
    print(f"     ↳ {body[:200].replace(chr(10), ' ')!r}")


def _report(label, name_map):
    """統一的涵蓋率報告:總數 / ETF 數 / 六檔試金石。⛔ 只看總數會漏掉「有量但沒 ETF」。"""
    if not name_map:
        print(f"  📊 {label}:❌ 0 檔")
        return
    etf = [k for k in name_map if k.startswith('00')]
    print(f"  📊 {label}:✅ {len(name_map)} 檔(其中 00 開頭 {len(etf)} 檔)")
    hit = {s: name_map.get(s) for s in PROBE}
    print(f"     試金石:{hit}")
    miss = [s for s, v in hit.items() if not v]
    if miss:
        print(f"     ⚠️ 漏掉:{miss}")


# ══════════════════════════════════════════════════════════════
# ① 對照組 + 一般股名字:官方公司基本資料
#    ⭐ miner.fetch_industry_map(miner.py:1300)每天都在打這兩支,而且同一份回應裡
#       本來就有「公司簡稱」→ 一般股的名字是**零額外 API**,這裡只是確認欄名沒變。
# ══════════════════════════════════════════════════════════════
def probe_official():
    print("\n" + "=" * 70)
    print("① 官方公司基本資料 t187ap03(⭐ 同時是對照組:它掛 = runner 被擋,不是端點改名)")
    print("=" * 70)
    out = {}
    for url, label in [
        ('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', 'TWSE 上市'),
        ('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O', 'TPEx 上櫃'),
    ]:
        try:
            r = _get(url)
            _show(label, r)
            if r.status_code != 200:
                continue
            data = r.json()
            if not isinstance(data, list) or not data:
                print(f"     ⚠️ 非預期結構:{type(data).__name__}")
                continue
            print(f"     欄名(首列):{sorted(data[0].keys())[:14]}")
            for row in data:
                code = str(row.get('公司代號') or row.get('SecuritiesCompanyCode') or '').strip()
                name = str(row.get('公司簡稱') or row.get('CompanyAbbreviation') or '').strip()
                if code and name and 4 <= len(code) <= 6:
                    out[code] = name
        except Exception as e:
            print(f"  {label:<46} ❌ {type(e).__name__}: {e}")
    _report('官方公司基本資料 合計', out)
    print("  ⭐ 預期:一般股(5483/2327/2330)有、ETF(0050/009816/00981A)全部沒有。")
    print("     若連 5483 都沒有 → 對照組掛掉 = 這台 runner 連不到,⛔ 下面的失敗不可解讀成端點改名。")
    return out


# ══════════════════════════════════════════════════════════════
# ② ETF:mis.twse all_etf.txt
#    🚨 這支 etf_miner.py:582 **已經在打**,但 etf_tracking.json 的 _premium_status 現在是
#       「命中0檔;arr長=24;首筆keys=['msgArray','refURL','userDelay','rtMessage','rtCode']」
#       → 回應結構疑似多包了一層(真資料在每個包的 msgArray 裡)。
#    ⭐ MIS 的 msgArray 標準欄位含 `n`(股票簡稱)/`nf`(全名)/`c`(代號)
#       → 若真是這樣,**修好折溢價的同時就拿到 ETF 名字**,零額外 API。
#    ⛔ 但這裡只負責「把真實結構印出來」,不預設答案。
# ══════════════════════════════════════════════════════════════
def probe_all_etf():
    print("\n" + "=" * 70)
    print("② mis.twse all_etf.txt(ETF 主要候選;順便查 etf_miner『命中 0 檔』的真因)")
    print("=" * 70)
    url = 'https://mis.twse.com.tw/stock/data/all_etf.txt'
    ref = {'Referer': 'https://mis.twse.com.tw/stock/various-areas/etf-price/'
                      'indicator-disclosure-etf?lang=zhHant'}
    out = {}
    try:
        r = _get(url, headers=ref)
        _show('all_etf.txt', r)
        if r.status_code != 200:
            return out
        j = r.json()
        print(f"     頂層型別:{type(j).__name__}"
              + (f" ・keys={sorted(j.keys())[:10]}" if isinstance(j, dict) else f" ・len={len(j)}"))

        # 🔍 把「真資料列」挖出來:同時支援 (a) 直接是列 (b) 多包一層 msgArray
        rows = []

        def _harvest(node, depth=0):
            if depth > 3:
                return
            if isinstance(node, list):
                for x in node:
                    _harvest(x, depth + 1)
            elif isinstance(node, dict):
                inner = node.get('msgArray')
                if isinstance(inner, list) and inner:
                    print(f"     🔎 depth={depth} 找到 msgArray,{len(inner)} 列,"
                          f"首列 keys={sorted(inner[0].keys())[:16]}")
                    rows.extend(x for x in inner if isinstance(x, dict))
                elif any(k in node for k in ('a', 'c', 'ch')):
                    rows.append(node)

        _harvest(j)
        print(f"     🔎 共挖出 {len(rows)} 個資料列")
        if rows:
            print(f"     首列樣本:{json.dumps(rows[0], ensure_ascii=False)[:260]}")

        for it in rows:
            # 代號欄:a(ETF 專用格式)/ c(MIS 標準)
            code = str(it.get('a') or it.get('c') or '').strip()
            # 名字欄:n=簡稱 nf=全名(MIS 標準);b/ETF 格式若有別的名字欄一併試
            name = str(it.get('n') or it.get('nf') or it.get('b') or '').strip()
            if code and name:
                out[code] = name
    except Exception as e:
        print(f"  ❌ {type(e).__name__}: {e}")
    _report('all_etf.txt', out)
    if not out:
        print("  ⚠️ 拿不到名字 → 看上面印的「首列樣本」到底有哪些欄,⛔ 別再猜欄名。")
    return out


# ══════════════════════════════════════════════════════════════
# ③ 備案:每日收盤行情(全市場,含 ETF,回應帶證券名稱)
# ══════════════════════════════════════════════════════════════
def probe_day_all():
    print("\n" + "=" * 70)
    print("③ 備案:每日收盤行情(含 ETF)")
    print("=" * 70)
    out = {}
    for url, label in [
        ('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', 'TWSE STOCK_DAY_ALL'),
        ('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', 'TPEx 上櫃收盤'),
    ]:
        try:
            r = _get(url)
            _show(label, r)
            if r.status_code != 200:
                continue
            data = r.json()
            if not isinstance(data, list) or not data:
                print(f"     ⚠️ 非 list 或空:{type(data).__name__}")
                continue
            print(f"     欄名(首列):{sorted(data[0].keys())[:14]}")
            for row in data:
                code = str(row.get('Code') or row.get('SecuritiesCompanyCode')
                           or row.get('證券代號') or '').strip()
                name = str(row.get('Name') or row.get('CompanyName')
                           or row.get('證券名稱') or '').strip()
                if code and name and 4 <= len(code) <= 6:
                    out[code] = name
        except Exception as e:
            print(f"  {label:<46} ❌ {type(e).__name__}: {e}")
    _report('每日收盤行情 合計', out)
    return out


# ══════════════════════════════════════════════════════════════
# ④ FinMind TaiwanStockInfo:匿名 vs 帶 token
#    🚨 這一組是要**分出前端壞掉的真因**:前端那支 URL 沒帶 token(index.html:11549)。
#       若「匿名失敗、帶 token 成功」→ 證實根因就是匿名層被擋。
# ══════════════════════════════════════════════════════════════
def probe_finmind():
    print("\n" + "=" * 70)
    print("④ FinMind TaiwanStockInfo:匿名 vs 帶 token(分辨前端壞掉的真因)")
    print("=" * 70)
    base = 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo'
    # 🔑 ⛔ 不可用 .strip() —— 那清不掉金鑰**中間**的空白(→ Token is illegal)。
    #    同 miner.py / finmind_check.py 的做法(check_workflow_paths 會擋)。
    toks = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',')]
    toks = [t for t in toks if t]
    print(f"  🔐 可用 token:{len(toks)} 把(⛔ 只印把數,不印內容)")

    def _try(url, label):
        out = {}
        try:
            r = _get(url, timeout=40)
            _show(label, r)
            if r.status_code != 200:
                return out
            j = r.json()
            print(f"     msg={j.get('msg')!r} ・status={j.get('status')!r} ・筆數={len(j.get('data') or [])}")
            for row in (j.get('data') or []):
                code = str(row.get('stock_id') or '').strip()
                name = str(row.get('stock_name') or '').strip()
                if code and name:
                    out[code] = name
        except Exception as e:
            print(f"  {label:<46} ❌ {type(e).__name__}: {e}")
        return out

    anon = _try(base, '匿名(= 前端現在的打法)')
    _report('FinMind 匿名', anon)

    withtok = {}
    if toks:
        for i, t in enumerate(toks, 1):
            withtok = _try(f"{base}&token={t}", f'第 {i} 把 token')
            if withtok:
                _report(f'FinMind 第 {i} 把 token', withtok)
                break
    else:
        print("  ⚠️ 沒有 FINMIND_TOKENS → 帶 token 那組跳過")

    if not anon and withtok:
        print("  ⭐⭐ 匿名失敗、帶 token 成功 → **證實**前端壞掉就是因為那支 URL 沒帶 token。")
    elif not anon and not withtok:
        print("  ⭐ 兩種都失敗 → FinMind 這條路整個不能當名字的主來源(離線表更有必要)。")
    return withtok or anon


def main():
    print("🏷️ 股名來源探針 —— 目標:找出同時涵蓋『一般股 + ETF』的離線名字來源")
    print(f"🎯 試金石:{PROBE}")

    official = probe_official()
    etf = probe_all_etf()
    dayall = probe_day_all()
    fm = probe_finmind()

    print("\n" + "=" * 70)
    print("📋 總結:把各來源疊起來能涵蓋多少")
    print("=" * 70)
    for label, combo in [
        ('官方公司表 單獨', dict(official)),
        ('官方公司表 + all_etf', {**official, **etf}),
        ('官方公司表 + 每日收盤', {**official, **dayall}),
        ('全部疊起來', {**official, **dayall, **etf, **fm}),
    ]:
        _report(label, combo)

    print("\n⏭️ 下一步怎麼判讀:")
    print("  ・對照組(官方公司表)也掛 → 這台 runner 被擋,⛔ 其餘失敗不可解讀成端點改名")
    print("  ・哪一組能同時湊齊 6 檔試金石,就用哪一組寫進 miner")
    print("  ・⛔ 若沒有任何一組湊得齊 → 先看『首列樣本』的實際欄名,別再猜")


if __name__ == '__main__':
    main()
