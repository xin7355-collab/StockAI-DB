#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""🧪 分點「單日全市場」批次(V74.0.6 改成按券商抓)—— 把六個設計釘死。

❓ 為什麼要有這支:2026-08-30 付費恢復後,daily_miner 一輪只更新 **88 檔**(全市場 2,653)。
   真因是 `_fetch_chips_bulk` 走的是**已經被官方擋掉**的「省略 data_id」那條路
   → 每次浪費 1 次呼叫後回 None → 退回逐檔,而逐檔補 22 天要 58,000 次呼叫 ≈ 10 小時。
   ⛔ workflow 全綠、零錯誤訊息(陷阱 #9 的又一次)。

🚧 這支釘住的六件事(每一條都用「注入缺陷」驗過會叫):
   ① ⛔ 不可再用「只給 date、不給 data_id」的寫法(官方對這個 dataset 永遠回 400)
   ② 必須按 `securities_trader_id` 抓
   ③ **先探路再開火**(探路失敗只能花掉個位數呼叫,⛔ 不可整批打完才發現)
   ④ 單日股票數不足 → 那天不採用(⛔ 不可寫半份)
   ⑤ `have_dates` 的日期不重買,但要算進 need_days
   ⑥ 🚨 批次模式**不可再 `time.sleep`**(零 HTTP 卻睡 1~2 小時 = 批次白做)
"""
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
SRC = (ROOT / 'miner.py').read_text(encoding='utf-8')

FAIL = []


def ck(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + ('' if cond else f'  ← {extra}'))
    if not cond:
        FAIL.append(name)


def _func_src(name):
    """只取那支函式自己的區塊(⛔ 別掃全檔 —— 說明用的註解會在別處配到,本專案已踩 8 次)。"""
    m = re.search(rf'^def {re.escape(name)}\(', SRC, re.M)
    assert m, f'找不到 {name}'
    rest = SRC[m.start():]
    nxt = re.search(r'^(def |class )', rest[1:], re.M)
    return rest[:nxt.start() + 1] if nxt else rest


def _strip_comments(s):
    """⛔ 掃「不可出現的寫法」之前一定要先拿掉註解 —— 說明 bug 的註解裡就寫著壞寫法本身
    (本專案第 8 次踩到,V74.2.1 記過)。"""
    out = []
    for ln in s.split('\n'):
        t = ln.split('#')[0]
        out.append(t)
    body = '\n'.join(out)
    # 三引號 docstring 也要拿掉
    return re.sub(r'"""[\s\S]*?"""', '', body)


BULK = _func_src('_fetch_chips_bulk')
BULK_CODE = _strip_comments(BULK)
# 🚧 空過守門:拿掉註解之後還要剩下夠多程式碼,否則下面每一條都會變成假綠燈
ck('⓪ 空過守門:_fetch_chips_bulk 去註解後仍有 >1500 字元程式碼',
   len(BULK_CODE) > 1500, f'只剩 {len(BULK_CODE)} 字元')

# ── ① ⛔ 不可再用「只給 date」的寫法 ────────────────────────────────
bad_date_only = re.findall(r"f'date=\{[^']*\}'|\"date=\{[^\"]*\}\"", BULK_CODE)
ck('① ⛔ 不可出現只給 date 不給 data_id 的參數字串(官方對這個 dataset 永遠回 400)',
   not bad_date_only, f'找到 {bad_date_only}')

# ── ② 必須按券商抓 ───────────────────────────────────────────────
ck('② 必須用 securities_trader_id 當抓取軸',
   'securities_trader_id=' in BULK_CODE, '沒有按券商抓')
ck('②b 券商清單要跟 chips_backfill 共用同一支(⛔ 不可再寫第二份)',
   'from chips_backfill import top_brokers' in SRC
   and SRC.count('def top_brokers') == 0,
   '要嘛沒共用、要嘛 miner 自己又寫了一份')

# ── ③ 先探路再開火 ──────────────────────────────────────────────
probe_at = BULK_CODE.find('probe_ok')
fire_at = BULK_CODE.find('ThreadPoolExecutor')
ck('③ 探路(probe_ok)必須排在整批開火(ThreadPoolExecutor)之前',
   0 <= probe_at < fire_at, f'probe={probe_at} fire={fire_at}')
ck('③b 探路只能試少數幾天(切片上限 ≤5)',
   re.search(r'\[:5\]', BULK_CODE) is not None, '沒看到探路的天數上限')
ck('③c 探路遇到 400/401/402/403 要直接回 None',
   re.search(r'in \(400, 401, 402, 403\)[\s\S]{0,300}?return None', BULK_CODE) is not None,
   '權限/參數錯誤沒有立刻收手')

# ── ④ 單日股票數不足 → 那天不採用 ───────────────────────────────
m = re.search(r"if len\(bucket\) < min_syms:[\s\S]{0,300}?\n\s*(continue|return 'skip'|return|break)", BULK_CODE)
ck('④ 單日股票數 < min_syms 要跳過那天(⛔ 不可寫半份進去)',
   m is not None and m.group(1) in ('continue', "return 'skip'"),
   f'實際是 {m.group(1) if m else "沒有守門"}')
ck('④b 欄位污染防呆還在',
   "'secBrokerId'" in BULK_CODE and 'return None' in BULK_CODE, '污染防呆不見了')

# ── ④c 歷史天要先從 chips_deep 分支還原(V74.0.9:每天 API 固定 126 秒,
#      22 天會把迴圈餓死;分支還原 = 零呼叫)──────────────────────
ck('④c 批次要先呼叫 _load_chips_deep_local(歷史天零 API)',
   '_load_chips_deep_local(' in BULK_CODE and 'def _load_chips_deep_local' in SRC,
   '分支還原路徑不見了')
_local_at = BULK_CODE.find('_load_chips_deep_local(')
_api_at = BULK_CODE.find('ThreadPoolExecutor')
ck('④d 分支還原要排在整批 API 開火之前', 0 <= _local_at < _api_at,
   f'local={_local_at} api={_api_at}')

# ── ⑤ have_dates 不重買但要算進 need_days ───────────────────────
m5 = re.search(r'if d in have:\s*\n\s*got \+= 1\s*\n[\s\S]{0,200}?continue', BULK_CODE)
ck('⑤ have_dates 裡的日期要 got+=1 之後 continue(不重買、但算進 need_days)',
   m5 is not None, '沒有這個分支 → 每天都會把 22 天整個重抓')

# ── ⑥ 🚨 批次模式不可再 sleep ───────────────────────────────────
CHIPS = _func_src('fetch_broker_chips')
m6 = re.search(r'if _bulk_idx is None:\s*\n\s*time\.sleep\(3 if _is_hot else 1\)', CHIPS)
ck('⑥ 🚨 批次模式(_bulk_idx 有值)⛔ 不可再 time.sleep —— 零 HTTP 卻睡 1~2 小時 = 批次白做',
   m6 is not None, '那行 sleep 沒有被 _bulk_idx is None 包住')

# ── ⑦ have_dates 的抽樣必須跨全市場,⛔ 不可只抽熱門股 ──────────
m7 = re.search(r"_all_files = sorted\(chips_dir\.glob\('\*\.json'\)\)[\s\S]{0,1500}?_have_bulk = \{", CHIPS)
ck('⑦ _have_bulk 要從 chips_dir 全部檔案等距抽樣(⛔ 只抽熱門股會讓冷門股永遠補不到)',
   m7 is not None, '抽樣沒有走全市場')
ck('⑦b 抽樣數不足時不可下結論(至少 20 檔才算)',
   'len(_samp) >= 20' in CHIPS, '樣本不足也照判 → 會誤判成「全都有」')

# ── ⑧ 沒抓到的檔數要印出來,⛔ 不可靜默 ─────────────────────────
ck('⑧ 前 N 家券商完全沒碰到的股票數要有計數並印出(⛔ 不可靜默)',
   '_bulk_miss' in CHIPS and 'CHIPS_BULK_BROKERS' in CHIPS, '沒有 _bulk_miss 統計')

# ── ⑨ 實跑:stub 掉網路,驗真的按券商打、且 have_dates 真的省下呼叫 ──
os.environ.setdefault('FINMIND_TOKENS', 'x')
# ⚠️ 測試必須隔離 chips_deep 還原 —— 不設的話 fallback 會真的 git archive
#    把 155MB 解到工作區(踩過),而且真資料會讓 API 呼叫數的斷言失真。
import tempfile
os.environ['CHIPS_DEEP_DIR'] = tempfile.mkdtemp(prefix='no_deep_')
import miner  # noqa: E402

CALLS = []


def _fake_get(endpoint, params, timeout=15):
    CALLS.append(params)
    m = re.search(r'securities_trader_id=([^&]+)&date=(\S+)', params)
    if not m:
        return {'status': 400, 'msg': "parameter data_id can't be none", 'data': []}
    bid, d = m.group(1), m.group(2)
    if d in ('2026-08-23', '2026-08-24'):      # 週末:回 200 但空
        return {'status': 200, 'data': []}
    rows = [{'stock_id': f'{1000 + i}', 'securities_trader_id': bid,
             'securities_trader': f'券商{bid}', 'date': d,
             'price': 10.0, 'buy': 1000 + i, 'sell': 500} for i in range(300)]
    return {'status': 200, 'data': rows}


miner.fm_paid_get = _fake_get
miner._chips_broker_ids = lambda n=None: [f'{9000 + i}' for i in range(40)]
miner.FINMIND_PAID_TOKENS = ['x']

dates = [f'2026-08-{d:02d}' for d in range(28, 17, -1)]
CALLS.clear()
idx = miner._fetch_chips_bulk(dates, need_days=3, min_syms=200)
ck('⑨ 實跑:批次真的回得到索引', bool(idx), f'回 {type(idx)}')
ck('⑨b 實跑:每一次呼叫都帶 securities_trader_id',
   bool(CALLS) and all('securities_trader_id=' in c for c in CALLS),
   f'{len(CALLS)} 次呼叫,有 {sum(1 for c in CALLS if "securities_trader_id=" not in c)} 次不是')
_n_days = len({re.search(r'date=(\S+)', c).group(1) for c in CALLS})
ck('⑨c 實跑:湊滿 need_days=3 就停(⛔ 不可把 11 天全打完)',
   _n_days <= 3 + 2, f'打了 {_n_days} 天(上限 5:3 天 + 探路最多碰到 2 個非交易日)')

# have_dates 省呼叫
CALLS.clear()
idx2 = miner._fetch_chips_bulk(dates, need_days=3, min_syms=200,
                               have_dates={'2026-08-28', '2026-08-27'})
n_days2 = len({re.search(r'date=(\S+)', c).group(1) for c in CALLS})
ck('⑨d 實跑:have_dates 有 2 天 → 只需要再抓 1 天(探路那幾次除外)',
   n_days2 <= 3, f'還是打了 {n_days2} 天')
ck('⑨e 實跑:have_dates 的那兩天⛔ 完全沒有被打',
   not any('date=2026-08-28' in c or 'date=2026-08-27' in c for c in CALLS),
   '已經有的日期還是重買了')
# 🚨 V74.2.6 但「不重買」⛔ 不等於「不要那幾天的資料」——
#   分支還原是**零 API** 的,have 只該擋掉花錢重抓。
#   排除掉的話那些天永遠進不了 idx → 每檔只拿得到新抓的 1 天 →
#   hist 每輪只長 1 天,要 1 個月才填滿(#530 實跑 hist 中位卡在 2 天就是這樣)。
_d_have = set()
for _rs in (idx2 or {}).values():
    for _r in _rs:
        _d_have.add(str(_r.get('date') or ''))
ck('⑨e2 🚨 have_dates 的那幾天仍要從 chips_deep **還原進 idx**(零 API,⛔ 不可整天丟掉)',
   {'2026-08-28', '2026-08-27'} <= _d_have, f'idx 只有這些日期:{sorted(_d_have)}')
ck('⑨e3 🚧 空過守門:idx 至少要拿到 need_days 天(⛔ 不可只有 1 天還算通過)',
   len(_d_have) >= 3, f'只有 {len(_d_have)} 天')

# 探路失敗要早退
CALLS.clear()
miner.fm_paid_get = lambda e, p, timeout=15: (CALLS.append(p) or
                                              {'status': 400, 'msg': 'x', 'data': []})
r = miner._fetch_chips_bulk(dates, need_days=3, min_syms=200)
ck('⑨f 實跑:探路回 400 → 立刻回 None', r is None, f'回了 {type(r)}')
ck('⑨g 實跑:探路失敗只能花掉個位數呼叫(⛔ 不可整批 1,000 次打完才發現)',
   len(CALLS) <= 5, f'花掉 {len(CALLS)} 次')

print()
if FAIL:
    print(f'❌ {len(FAIL)} 條沒過:')
    for f in FAIL:
        print('   -', f)
    sys.exit(1)
print('✅ CHIPS_BULK_PASS(全部通過)')
