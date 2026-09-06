#!/usr/bin/env python3
"""
📦 財報三表深歷史回算的守門測試(V74.8.4)

⛔ 這支釘住的是「為什麼要這樣做」,不是當時的寫法:
 ① **探路失敗要停手** —— ⛔ 不可跑一小時才發現 `CostOfGoodsSold` 改名了。
 ② **時間預算到了要把手上的寫出去** —— ⛔ 交給 job timeout 會連 deploy 一起砍掉(V74.3.8)。
 ③ **冪等**:已有的跳過(中斷可續跑)。
 ④ **合併舊檔**:這輪失敗的保留舊值(⛔ 不可整批歸零)。
 ⑤ **<500 檔不覆寫**(自我保護)。
 ⑥ **收尾要印分類統計**(⛔「0 檔成功」要說得出為什麼)。
 ⑦ 🔐 ⛔ 不可印 token。
 ⑧ 🚨 產物放**頂層 fin_deep/**,⛔ 不是 data/(gh-pages 會把整個 data/ 收走)。
 ⑨ token 輪動**共用 dispo_probe.fm**,⛔ 不寫第二份(陷阱 #37)。

⚠️ 網路一律 stub(沙箱連不到 FinMind),每組都有**空過守門**確認 stub 真的被呼叫到。
"""
import io
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
os.environ.setdefault('FINMIND_TOKENS', 'dummy')

import fin_backfill as FB                                    # noqa: E402

fails = []
def ok(n, c, x=''):
    print(('✅ ' if c else '❌ ') + n + ('' if c else f'   {x}'))
    if not c:
        fails.append(n)

SRC = io.open(os.path.join(HERE, 'fin_backfill.py'), encoding='utf-8').read()
# ⛔ 掃原始碼前先剝註解 —— 說明用的句子裡就含著被禁的寫法(本專案踩過 13 次)
CODE = '\n'.join(l for l in SRC.split('\n') if not l.strip().startswith('#'))

# ── 靜態 ──
ok('⑧ 🚨 產物放頂層 fin_deep/,⛔ 不是 data/(否則會被推上 gh-pages)',
   "OUTDIR = os.path.join(ROOT, 'fin_deep')" in CODE and "os.path.join(DATA, 'fin_deep.json')" not in CODE)
ok('⑨ token 輪動共用 dispo_probe.fm(⛔ 不寫第二份)',
   'from dispo_probe import fm' in CODE and 'urlopen' not in CODE)
ok('⑦ 🔐 ⛔ 不可印 token 片段', 'TOKENS[' not in CODE.replace("q['token'] = TOKENS[k]", ''))
ok('⑩ 欄位名要寫出來(⛔ 不憑印象猜)',
   all(k in CODE for k in ('Inventories', 'CostOfGoodsSold', 'PropertyAndPlantAndEquipment')))

# 🚨 ⓪a 先釘住 `dispo_probe.fm` 的**回傳契約** ——
#    第一版就是因為 stub 跟真的函式形狀不同(它回 (rows, err) 兩元組),
#    本機 15 條全綠、雲端實跑當場 AttributeError。⛔ stub 錯了的話所有斷言一起錯(陷阱 #40)。
import dispo_probe as _DP                                    # noqa: E402
_keep_tok = list(_DP.TOKENS)
_DP.TOKENS.clear()
try:
    _r = _DP.fm('__nonexistent__', {'data_id': '0000'}, timeout=3)
    ok('⓪a 🚨 共用的 fm() 必須回 (rows, err) 兩元組(⛔ 不是 rows)',
       isinstance(_r, tuple) and len(_r) == 2, repr(_r)[:120])
except Exception as _e:
    ok('⓪a 🚨 共用的 fm() 必須回 (rows, err) 兩元組(⛔ 不是 rows)', False, f'例外 {_e}')
finally:
    _DP.TOKENS.extend(_keep_tok)
ok('⓪b ⭐ 而且這支要真的解開兩元組(⛔ 當成 rows 用 = 雲端才會炸)',
   'rows, err = fm(' in CODE and 'rows = fm(' not in CODE)

# ── 動態:stub 網路 ──
CALLS = {'n': 0}
QS = ['2018-03-31', '2018-06-30', '2018-09-30']
def make_fm(good=True, only=None):
    def _fm(ds, extra=None, timeout=90):
        CALLS['n'] += 1
        sym = (extra or {}).get('data_id')
        if only is not None and sym not in only and sym != '2330':
            return [], None
        want = FB.WANT[ds]
        if not good and ds == 'TaiwanStockFinancialStatements':
            return [{'date': q, 'type': 'SomethingElse', 'value': 1} for q in QS], None
        return ([{'date': q, 'type': t, 'value': 100.0 + i}
                 for q in QS for i, t in enumerate(want.values())], None)
    return _fm

def run(tmp, **env):
    """把輸出導到暫存目錄跑一次 main(),回 (rc, stdout, payload)"""
    CALLS['n'] = 0
    FB.OUTDIR = tmp
    FB.OUT = os.path.join(tmp, 'fin_deep.json')
    for k, v in env.items():
        setattr(FB, k, v)
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    rc = 0
    try:
        FB.main()
    except SystemExit as e:
        rc = e.code or 0
    finally:
        sys.stdout = old
    p = None
    if os.path.exists(FB.OUT):
        p = json.load(open(FB.OUT, encoding='utf-8'))
    return rc, buf.getvalue(), p

SYMS = [str(1000 + i) for i in range(600)]
FB.stock_list = lambda: SYMS

# ① 探路失敗 → exit 1
with tempfile.TemporaryDirectory() as tmp:
    FB.fm = make_fm(good=False)
    FB.REASON = {}
    rc, out, p = run(tmp, LIMIT=0, MIN_OK=500, SLEEP=0, BUDGET_MIN=99)
    ok('⓪ 空過守門:stub 真的被呼叫到', CALLS['n'] > 0, f"calls={CALLS['n']}")
    ok('① 🚨 探路發現欄位名對不上 → 要 exit 1 並印出候選(⛔ 不可跑一小時才發現)',
       rc == 1 and '候選 type' in out and p is None, f'rc={rc} out={out[-300:]}')

# ③④⑤⑥ 正常跑
with tempfile.TemporaryDirectory() as tmp:
    FB.fm = make_fm(); FB.REASON = {}
    rc, out, p = run(tmp, LIMIT=0, MIN_OK=500, SLEEP=0, BUDGET_MIN=99)
    ok('② 正常跑得完並寫出產物', rc == 0 and p is not None and p['meta']['n'] == 600, f'rc={rc}')
    ok('③ 產物含季別、欄位名與免責(公布時間差)',
       p and p['q'] == QS and p['f'] == FB.FIELDS and '公布' in p['meta']['caveat'])
    ok('⑥ 收尾要印分類統計與 token 狀況(⛔ 0 檔成功要說得出為什麼)',
       '原因統計' in out and 'token 狀況' in out, out[-200:])
    ok('⑦b 🔐 輸出裡不可出現 token 內容', 'dummy' not in out)
    # 冪等:再跑一次應該幾乎不打網路
    before = CALLS['n']; CALLS['n'] = 0
    FB.REASON = {}
    rc2, out2, p2 = run(tmp, LIMIT=0, MIN_OK=500, SLEEP=0, BUDGET_MIN=99)
    ok('④ 冪等:第二輪不可重抓全部(⛔ 否則中斷續跑等於從頭來)',
       CALLS['n'] < before / 5 and p2['meta']['n'] == 600, f'第一輪 {before} 次 / 第二輪 {CALLS["n"]} 次')

# ⑤ 檔數不足 → 不覆寫
with tempfile.TemporaryDirectory() as tmp:
    FB.fm = make_fm(only=set(SYMS[:10])); FB.REASON = {}
    rc, out, p = run(tmp, LIMIT=0, MIN_OK=500, SLEEP=0, BUDGET_MIN=99)
    ok('⑤ 🚨 成功檔數不足 → exit 1 且⛔ 不可寫出半份',
       rc == 1 and p is None and '不覆寫' in out, f'rc={rc}')
    ok('⑤b 而且要印出原因統計(⛔ 不可只說「不夠」)', '原因統計' in out)

# ② 時間預算 —— ⭐ 情境要真實:**已經抓到一批**、還有剩的沒抓完時預算到期
#    (⛔ 不可用「一檔都沒抓到」測 —— 那時候本來就該走「檔數不足不覆寫」那條)
with tempfile.TemporaryDirectory() as tmp:
    FB.fm = make_fm(); FB.REASON = {}
    run(tmp, LIMIT=0, MIN_OK=500, SLEEP=0, BUDGET_MIN=99)          # 先跑滿
    doneN = json.load(open(os.path.join(tmp, 'fin_deep.json')))['meta']['n']
    d = json.load(open(os.path.join(tmp, 'fin_deep.json')))
    for k in list(d['s'])[:5]:                                      # 挖掉 5 檔製造「還有剩的」
        d['s'].pop(k)
    json.dump(d, open(os.path.join(tmp, 'fin_deep.json'), 'w'))
    FB.REASON = {}
    rc, out, p = run(tmp, LIMIT=0, MIN_OK=500, SLEEP=0, BUDGET_MIN=0)
    ok('⑦ 🚨 預算用完要把手上的**寫出去**並 exit 0(⛔ 不可交給 job timeout)',
       rc == 0 and '預算用完' in out and p is not None and p['meta']['n'] == doneN - 5,
       f'rc={rc} n={p and p["meta"]["n"]} out={out[:200]}')
    ok('⑦c ⭐ 而且已經抓到的那些⛔ 不可掉(合併舊檔)', p and p['meta']['n'] >= 500)

# 🧪 試跑模式:檔數守門要跟著縮,⛔ 但不可靜默(否則正式跑也被放寬就沒人發現)
with tempfile.TemporaryDirectory() as tmp:
    FB.fm = make_fm(); FB.REASON = {}
    rc, out, p = run(tmp, LIMIT=30, MIN_OK=500, SLEEP=0, BUDGET_MIN=99)
    ok('⑧b 🧪 試跑 30 檔⛔ 不可撞到 500 的門檻(那會變成看起來像管線壞掉的假紅燈)',
       rc == 0 and p is not None and p['meta']['n'] == 30, f'rc={rc}')
    ok('⑧c ⭐ 而且放寬要**印出來**,並講明正式跑仍是 500(⛔ 不可靜默放寬)',
       '試跑模式' in out and '正式跑仍是 500' in out, out[:200])

print('\n' + ('❌ FIN_BACKFILL_FAIL(%d)' % len(fails) if fails else '✅ FIN_BACKFILL_PASS(全部通過)'))
sys.exit(1 if fails else 0)
