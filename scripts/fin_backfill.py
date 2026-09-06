#!/usr/bin/env python3
"""
📦 財報三表深歷史回算 —— 存貨週轉天數(DOI)/ 資本支出 / 自由現金流

使用者(2026-09-06)看完評估紀錄㉑ 說「開」。

⭐⭐ 這**不是**「從今天開始累積」那一類 —— 上游本來就給 34 季(實測回溯 2018-03-31),
   所以是**一次回算**,跑完當天就驗得動,⛔ 不用等好幾季。
   (本站鐵則:做任何「從今天開始累積」的功能之前,先問能不能回算。)

🚨 成本(實測,⛔ 不憑印象):三個資料集**都不給省略 data_id**
   (回 `start_date parameter is missing` 或 200 但 0 列)→ 只能逐檔:
   3 次請求 × 約 2,300 檔 ≈ **6,900 次**。付費層 6,000/hr,實際受回應延遲支配 ≈ 1~2 小時。
   ⭐ 之後每季只要補新的那一季(⛔ 不用重抓歷史,冪等會跳過)。

⛔ 六個守門(⛔ 都不可拿掉):
 ① **2330 探路**:欄位名對不上就把候選印出來並 exit 1
    —— ⛔ 不可跑一小時才發現 `CostOfGoodsSold` 改名了(V71.3.4 的做法)。
 ② **時間預算**(`FIN_BUDGET_MIN`,預設 150):超過就把手上的**寫出去** exit 0。
    ⛔ 不可把停手交給 job timeout —— 那會連 deploy 一起砍掉,幾小時的成果整批丟掉(V74.3.8 的教訓)。
 ③ **冪等**:已經有那一檔的資料就跳過 → 中途失敗直接再跑一次接續。
 ④ **合併舊檔**:這輪失敗的保留舊值(⛔ 不可整批歸零)。
 ⑤ **成功檔數 < 500 不覆寫**(自我保護,同 fund_sweep)。
 ⑥ **收尾印分類統計**(⛔「0 檔成功」要說得出為什麼 —— V72.5.3 的教訓)。

🔐 只印「第幾把 token」,⛔ 絕不印 token 片段(repo 是 public)。

產物 `fin_deep/fin_deep.json`(推 orphan 分支 `fin_deep`,⛔ 不碰 data 也不碰 gh-pages):
  {"q":[季別…], "f":[欄位名…], "s":{股號:{季別:[數值…]}}, "meta":{…}}
⛔ 前端目前**不讀**它 —— 還沒驗證過的東西不上前端。
"""
import json
import os
import sys
import time
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# ⛔ token 輪動共用 dispo_probe 那一支,⛔ 不在這裡再寫一份(陷阱 #37)
# 🚨 它回的是 **(rows, err) 兩元組**,⛔ 不是 rows ——
#    第一版當成 rows 直接用 → 雲端實跑 `AttributeError: 'list' object has no attribute 'get'`,
#    而**本機測試 15 條全綠**(因為我的 stub 也回錯的形狀)。
#    ⭐ 通用:用別人寫的函式之前,先確認它到底回什麼(同 dividends_hist 的 `d`、diff_holdings 的 `dw`)。
from dispo_probe import fm, TOKENS, TOK_STAT           # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
# 🏛️ 放**頂層 `fin_deep/`**,⛔ 不是 `data/` ——
#   gh-pages 那步是 `git add -f index.html data/`(**整個 data/ 都收**)→ 放進 data/ 會推上前端。
#   照 chips_deep / klines_deep 的先例:推**獨立 orphan 分支**,前端不讀,只給探針/回測。
OUTDIR = os.path.join(ROOT, 'fin_deep')
OUT = os.path.join(OUTDIR, 'fin_deep.json')

START = os.environ.get('FIN_START') or '2018-01-01'
BUDGET_MIN = int(os.environ.get('FIN_BUDGET_MIN') or 150)
LIMIT = int(os.environ.get('FIN_LIMIT') or 0)          # 試跑用(⭐ 先驗管線再排長工作)
MIN_OK = int(os.environ.get('FIN_MIN_OK') or 500)
SLEEP = float(os.environ.get('FIN_SLEEP') or 0.05)

# 🚨 欄位名一律**寫出來**並在探路時驗證,⛔ 不憑印象猜(實測 2330 的 type 名稱)
WANT = {
    'TaiwanStockBalanceSheet':        {'inv': 'Inventories'},
    'TaiwanStockCashFlowsStatement':  {'capex': 'PropertyAndPlantAndEquipment',
                                       'dep': 'Depreciation',
                                       'ocf': 'CashFlowsFromOperatingActivities'},
    'TaiwanStockFinancialStatements': {'cogs': 'CostOfGoodsSold',
                                       'rev': 'Revenue'},
}
FIELDS = ['inv', 'cogs', 'capex', 'dep', 'ocf', 'rev']
REASON = {}


def bump(k):
    REASON[k] = REASON.get(k, 0) + 1


def fetch_one(sym):
    """回 {季別: {欄位: 值}};任何一個資料集失敗就記原因(⛔ 不靜默)。"""
    out = {}
    for ds, want in WANT.items():
        rows, err = fm(ds, {'data_id': sym, 'start_date': START})
        if rows is None:
            bump(f'{ds}:{(err or "失敗").split("/")[-1][:40]}')     # ⭐ 用分類過的原因,⛔ 不只寫「失敗」
            continue
        if not rows:
            bump(f'{ds}:空')
            continue
        rev = {v: k for k, v in want.items()}
        for r in rows:
            t = rev.get(r.get('type'))
            if not t:
                continue
            d = r.get('date')
            v = r.get('value')
            if not d or v is None:
                continue
            out.setdefault(d, {})[t] = float(v)
    return out


def probe():
    """① 探路:欄位名對不上就把候選印出來,⛔ 不可跑一小時才發現。"""
    print('🔎 探路 2330(驗欄位名 + 驗付費層)…')
    bad = []
    for ds, want in WANT.items():
        rows, err = fm(ds, {'data_id': '2330', 'start_date': START})
        if not rows:
            print(f'   ❌ {ds}: 回空或失敗 → {err or "(回 200 但沒有資料)"}')
            bad.append(ds)
            continue
        types = {r.get('type') for r in rows}
        miss = [f'{k}({v})' for k, v in want.items() if v not in types]
        qs = len({r.get('date') for r in rows})
        print(f'   ✅ {ds}: {len(rows)} 列 ・{qs} 季' + (f' ・🚨 缺 {miss}' if miss else ''))
        if miss:
            import re
            key = '|'.join(v[:6] for v in want.values())
            cand = sorted(t for t in types if re.search(key, t or '', re.I))
            print(f'      🔎 候選 type:{cand[:15]}')
            print(f'      🔎 (全部 {len(types)} 個 type,前 30:{sorted(types)[:30]})')
            bad.append(ds)
    return not bad


def stock_list():
    syms = []
    for f in sorted(os.listdir(DATA)):
        if f.endswith('.json') and f[:-5].isdigit() and 4 <= len(f) - 5 <= 6:
            syms.append(f[:-5])
    return syms


def main():
    if not TOKENS:
        print('🚨 沒有 FINMIND_TOKENS → 直接停(⛔ 不空跑)')
        sys.exit(1)
    if not probe():
        print('🚨 探路失敗 → 停手。⛔ 不要在欄位名沒確認之前跑一小時。')
        sys.exit(1)

    old = {}
    if os.path.exists(OUT):
        try:
            old = (json.load(open(OUT, encoding='utf-8')) or {}).get('s') or {}
            print(f'📂 舊檔:{len(old)} 檔(冪等會跳過)')
        except Exception as e:
            print(f'⚠️ 舊檔讀不起來({str(e)[:60]}),當成沒有')

    syms = stock_list()
    min_ok = MIN_OK
    if LIMIT:
        syms = syms[:LIMIT]
        # 🚨 試跑模式下檔數守門要跟著縮,⛔ 否則 30 檔一定撞到 500 的門檻 → job 紅燈,
        #    看起來像「管線壞掉」其實是守門在工作(那種假紅燈會讓人養成忽略的習慣)。
        #    ⭐ 但要**印出來**,⛔ 不可靜默放寬。
        min_ok = max(1, LIMIT // 2)
        print(f'🧪 試跑模式:只抓 {LIMIT} 檔 ・檔數守門放寬到 {min_ok}'
              f'(⛔ 正式跑仍是 {MIN_OK})・⛔ 不推分支')
    # ③ 冪等:已經有的排後面(⛔ 不是直接丟掉 —— 預算沒用完時可以順便刷新最新一季)
    todo = [s for s in syms if s not in old] + [s for s in syms if s in old]
    print(f'📋 {len(syms)} 檔(其中 {len(syms) - len([s for s in syms if s not in old])} 檔已有)'
          f' ・預算 {BUDGET_MIN} 分 ・回溯 {START}')

    res = dict(old)
    t0 = time.time()
    okn = newn = 0
    for i, sym in enumerate(todo, 1):
        if (time.time() - t0) / 60 > BUDGET_MIN:
            print(f'⏱️ 預算用完(第 {i} 檔)→ 把手上的寫出去,下一輪接續')
            break
        if sym in old and okn > 0:
            continue                                     # 這一輪只補沒有的
        d = fetch_one(sym)
        if d:
            res[sym] = {k: [v.get(f) for f in FIELDS] for k, v in sorted(d.items())}
            okn += 1
            if sym not in old:
                newn += 1
        else:
            bump('整檔空')
        if SLEEP:
            time.sleep(SLEEP)
        if i % 200 == 0:
            print(f'   … {i}/{len(todo)} ・成功 {okn} ・{(time.time()-t0)/60:.1f} 分')

    # ⑤ 自我保護
    if len(res) < min_ok:
        print(f'🚨 只有 {len(res)} 檔(門檻 {min_ok})→ ⛔ 不覆寫舊檔')
        print(f'   原因統計:{REASON}')
        sys.exit(1)

    qs = sorted({q for v in res.values() for q in v})
    payload = {
        'q': qs, 'f': FIELDS, 's': res,
        'meta': {'updated': date.today().isoformat(), 'n': len(res), 'quarters': len(qs),
                 'start': START, 'src': 'FinMind BalanceSheet/CashFlows/FinancialStatements',
                 'caveat': '季報有公布時間差(Q1→5/15・Q2→8/14・Q3→11/14・Q4→隔年3/31),'
                           '回測要用公布日,⛔ 不可用季別當可用日'},
    }
    os.makedirs(OUTDIR, exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    # 🧪 試跑模式:把 2330 的實際內容印出來 —— ⭐ 試跑不推分支,不印的話**看不到資料長什麼樣**,
    #    而「營業成本是單季還是累計」這種問題只有看真實數字才分得出來(⛔ 不可憑印象假設)。
    if LIMIT and '2330' in res:
        print('\n🧪 2330 實際內容(⭐ 用來判斷單季 vs 累計):')
        print(f'   欄位順序:{FIELDS}')
        for q in sorted(res['2330'])[:9]:
            v = res['2330'][q]
            fmt = ' ・'.join(f'{f}={"-" if v[i] is None else round(v[i]/1e8, 1)}億'
                             for i, f in enumerate(FIELDS))
            print(f'   {q}  {fmt}')
        print('   ⭐ 判準:同一年 Q1<Q2<Q3<Q4 然後隔年 Q1 掉回去 = **累計**,要自己相減才是單季')

    mb = os.path.getsize(OUT) / 1e6
    print(f'\n✅ 寫出 {OUT}:{len(res)} 檔 ・{len(qs)} 季 ・{mb:.1f} MB'
          f'(這輪新增 {newn} 檔 ・耗時 {(time.time()-t0)/60:.1f} 分)')
    print(f'   季別範圍:{qs[0] if qs else "-"} ~ {qs[-1] if qs else "-"}')
    print(f'   原因統計:{REASON or "(沒有失敗)"}')
    print(f'   🔐 token 狀況(只印第幾把):{TOK_STAT or "(全部成功)"}')


if __name__ == '__main__':
    main()
