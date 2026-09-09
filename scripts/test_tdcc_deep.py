#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""🕳️ 集保「深歷史」(V72.5.1)測試 —— tdcc_backfill.py 的雙檔輸出

背景:CLAUDE.md 有四、五條功能長期卡在「`tdcc_holders.json` 只有 13 週 → 樣本不足以驗證」
      (兩上兩下 V71.9.0・散戶結構 V72.4.5・千張大戶連週增減 C7・大戶 ±3% 門檻・集保戶數)。
      查下去才發現 **13 週是當初隨手設的上限,不是資料的限制** —— FinMind 同源資料集
      給得出更長,而且**加深的 API 成本是零**(一檔仍然只打一個請求)。

⛔ 這支釘住五件事(每一條都對應一個會讓它安靜失效的坑):
  ① `tdcc_holders.json` **行為完全不變**(仍是 13 週)—— 前端每次開 App 會整份下載,變大就是災難
  ② `tdcc_deep.json` 要真的更深,而且**同一份 rows 寫兩個檔**(⛔ 不可多打一次 API)
  ③ **跳過條件要綁「夠不夠深」不是「有沒有做過」** —— 舊版 `len(h) < 2` 一旦跑過就永遠跳過,
     這正是深度卡在 13 週的真因(陷阱 #10 的同型)
  ④ **冪等**:重跑不可重複塞同一週(`seed_db_from_json` 那次的教訓)
  ⑤ **空的深檔不可覆寫舊檔**(fund_sweep「命中不足不覆寫」的自我保護)

⚠️ 沙箱連不到 FinMind(proxy 403)→ 這裡 **stub 掉 `fetch`**,只驗合併/保留/跳過邏輯,
   ⛔ 不驗網路層(那要靠 Actions 實跑,log 會印「深歷史:N 檔有資料,週數中位 M」)。
"""
import json
import os
import sys
import tempfile
import importlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FAILS = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:220]}'))
    if not cond:
        FAILS.append(name)


def fm_rows(dates):
    """造 FinMind 格式的 rows(每個日期 4 個級距:散戶兩級 + 400張中段 + 千張以上)"""
    out = []
    for d in dates:
        out += [
            {'date': d, 'HoldingSharesLevel': '1-999', 'people': 1000, 'percent': 3.0},
            {'date': d, 'HoldingSharesLevel': '1,000-5,000', 'people': 500, 'percent': 2.0},
            {'date': d, 'HoldingSharesLevel': '400,001-600,000', 'people': 5, 'percent': 8.0},
            {'date': d, 'HoldingSharesLevel': 'more than 1,000,001', 'people': 3, 'percent': 60.0},
            {'date': d, 'HoldingSharesLevel': 'total', 'people': 1508, 'percent': 100.0},
        ]
    return out


tb = importlib.import_module('tdcc_backfill')

# ── ① 常數:淺檔 13 週不可動,深檔要明顯更深 ─────────────────────────
ok('① 淺檔仍是 13 週(⛔ 前端檔不可變大)', tb.KEEP_WEEKS == 13, tb.KEEP_WEEKS)
ok('① 深檔預設 ≥ 52 週(至少一年才驗得動)', tb.DEEP_WEEKS >= 52, tb.DEEP_WEEKS)
ok('① 回補天數要蓋得住深檔週數', tb.BACKFILL_DAYS >= tb.DEEP_WEEKS * 7 - 14,
   f'{tb.BACKFILL_DAYS} vs {tb.DEEP_WEEKS * 7}')
ok('① 兩個檔名不同(⛔ 不可共用一個檔)', tb.DEEP_FILE != tb.OUT_FILE, tb.DEEP_FILE)

# ── ② 同一份 rows 寫兩個檔,保留長度不同 ────────────────────────────
# ⚠️ 用 set 去重後再排序 —— 第一版直接用 list comprehension 造出**重複日期**,
#    斷言「應該有 60 週」卻只拿到 36,看起來像程式 bug,其實是測資自己造錯。
DATES = sorted({f'2024-{m:02d}-{d:02d}' for m in range(1, 13) for d in (1, 8, 15, 22)})   # 48 個不同日期
data = {'2330': {'t': 1, 'n': 1, 'h': []}}
deep = {}
n = tb.merge_one(data, '2330', fm_rows(DATES), deep)
ok('② 有回傳補進幾週', n > 0, n)
ok('② ⛔ 淺檔被截到 KEEP_WEEKS', len(data['2330']['h']) == tb.KEEP_WEEKS, len(data['2330']['h']))
ok(f'② ⭐ 深檔保留全部({len(DATES)} 週 < 上限,所以全留)',
   len(deep['2330']['h']) == len(DATES), len(deep['2330']['h']))
ok('② 深檔比淺檔深', len(deep['2330']['h']) > len(data['2330']['h']))
ok('② 兩邊都是由舊到新排序',
   data['2330']['h'] == sorted(data['2330']['h']) and deep['2330']['h'] == sorted(deep['2330']['h']))
ok('② 淺檔留的是**最新**那 13 週', data['2330']['h'][-1][0] == deep['2330']['h'][-1][0],
   f"{data['2330']['h'][-1][0]} vs {deep['2330']['h'][-1][0]}")
# 欄位換算:千張 60、400張 = 60+8 = 68、散戶 3+2 = 5、散戶人數 1500
row = deep['2330']['h'][-1]
ok('② 千張大戶 = 100萬股以上那級', abs(row[1] - 60.0) < 1e-6, row)
ok('② 400張大戶 = 含千張(60+8=68)', abs(row[2] - 68.0) < 1e-6, row)
ok('② 散戶 = 10張以下兩級相加(3+2=5)', abs(row[3] - 5.0) < 1e-6, row)
ok('② 散戶人數 = 兩級人數相加(1500)', row[4] == 1500, row)

# ── ③ 冪等:同一份 rows 再跑一次,不可重複塞 ──────────────────────
before_deep, before_shallow = len(deep['2330']['h']), len(data['2330']['h'])
tb.merge_one(data, '2330', fm_rows(DATES), deep)
ok('③ ⭐ 重跑不可重複(深)', len(deep['2330']['h']) == before_deep, len(deep['2330']['h']))
ok('③ ⭐ 重跑不可重複(淺)', len(data['2330']['h']) == before_shallow, len(data['2330']['h']))

# ── ④ 深檔超過上限要截尾,而且截掉的是**最舊**的 ───────────────────
many = [f'20{y:02d}-{m:02d}-01' for y in range(18, 26) for m in range(1, 13)]   # 96 個月
d2, dp2 = {'2317': {'h': []}}, {}
tb.merge_one(d2, '2317', fm_rows(many), dp2)
ok('④ 深檔不超過上限', len(dp2['2317']['h']) <= tb.DEEP_WEEKS, len(dp2['2317']['h']))
if len(many) > tb.DEEP_WEEKS:
    ok('④ ⭐ 截掉的是最舊的(留最新)', dp2['2317']['h'][-1][0] == many[-1].replace('-', ''),
       dp2['2317']['h'][-1][0])

# ── ⑤ 跳過條件:必須綁「夠不夠深」而不是「有沒有做過」 ───────────────
src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        'tdcc_backfill.py'), encoding='utf-8').read()
ok('⑤ ⭐⛔ 跳過條件要看深檔深度(DEEP_ENOUGH),⛔ 不可只看「淺檔 ≥2 週」',
   'DEEP_ENOUGH' in src and 'def _need' in src, '')
ok('⑤ ⛔ 舊的「只看 len(h) < 2」寫法不可留著當唯一條件',
   src.count("len((data[k] or {}).get('h') or []) < 2") == 0, '')

# ── ⑥ 自我保護:深檔太少不可覆寫舊檔 ────────────────────────────
with tempfile.TemporaryDirectory() as td:
    cwd = os.getcwd()
    try:
        os.chdir(td)
        os.makedirs('data', exist_ok=True)
        with open(tb.DEEP_FILE, 'w', encoding='utf-8') as f:
            json.dump({'OLD': {'h': [['20200101', 1, 2, 3, 4]]}, '_meta': {'symbols': 1}}, f)
        old = open(tb.DEEP_FILE, encoding='utf-8').read()
        tb.save({'_meta': {}}, 0, 'test', {'2330': {'h': [['20260101', 1, 2, 3, 4]]}})   # 只有 1 檔
        ok('⑥ ⭐⛔ 深檔只有 1 檔(<200)→ 不可覆寫舊檔', open(tb.DEEP_FILE, encoding='utf-8').read() == old, '')
        big = {f'{i:04d}': {'h': [['20260101', 1, 2, 3, 4]]} for i in range(1000, 1300)}
        tb.save({'_meta': {}}, 0, 'test', big)
        w = json.load(open(tb.DEEP_FILE, encoding='utf-8'))
        ok('⑥ 檔數夠(300)→ 才寫檔', len(w) == 301, len(w))
        ok('⑥ 要寫 _meta(週數/檔數/用途)', isinstance(w.get('_meta'), dict)
           and w['_meta'].get('weeks_kept') == tb.DEEP_WEEKS, w.get('_meta'))
        ok('⑥ ⭐ _meta 要寫明「前端不 fetch」(免得有人接上去害 App 下載 16MB)',
           '前端' in str(w['_meta'].get('note', '')), w['_meta'].get('note'))
        ok('⑥ 沒有 h 的殼不可寫進去(⛔ 不留空殼)',
           all((v or {}).get('h') for k, v in w.items() if k != '_meta'), '')
    finally:
        os.chdir(cwd)

# ── ⑦ workflow 接線:還原 + 只推 data 分支 ─────────────────────────
wf = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       '.github/workflows/tdcc_sweep.yml'), encoding='utf-8').read()
ok('⑦ ⭐ 跑之前要從 data 分支還原深檔(否則每次都從頭抓,永遠加不深)',
   'origin/data:data/tdcc_deep.json' in wf, '')
ok('⑦ ⭐ 還原後要驗非空(git show 失敗會留 0 byte 檔)',
   '-s data/tdcc_deep.json' in wf, '')
ok('⑦ ⭐⛔ 深檔只推 data 分支(gh-pages 有 1GB 上限,而且前端不讀它)',
   '[ "$BR" = "data" ]' in wf, '')
ok('⑦ add 與 commit 用同一份路徑清單(⛔ 兩處分歧會 commit 不到)',
   wf.count('$PATHS') >= 3, wf.count('$PATHS'))

# ── ⑧ 探針要優先吃深檔 ───────────────────────────────────────
pb = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'tdcc_probe.py'), encoding='utf-8').read()
ok('⑧ ⭐ tdcc_probe 要優先讀深檔,讀不到才退回淺檔',
   "tdcc_deep.json" in pb and "tdcc_holders.json" in pb, '')

print()
if FAILS:
    print(f'❌ TDCC_DEEP_TEST_FAIL:{FAILS}')
    sys.exit(1)
print('✅ TDCC_DEEP_TEST_PASS')
