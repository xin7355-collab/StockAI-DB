#!/usr/bin/env python3
"""
🏃 「連買 ≥3 天 + 5 日已漲 ≥8%」的**兩份實作必須一致**(V77.0.7)

本站唯一通過六關的分點訊號(20 日 +1.36pp、n=34,505),現在有**兩份實作**:
  ・前端 `index.html` 的 `app._chipRunBuy(sym, hist)`  —— 單檔籌碼頁在用
  ・採礦 `miner.py` 的 `build_broker_radar()` 裡那段 —— 全市場榜在用

⛔ 兩個檔沒辦法互相 import → 只能各存一份(同 `_tickOf` 的三份、出場公式的三份)。
⭐ 所以靠這支**跨檔比對**擋住「只改一邊」—— ⛔ 沒有它,兩邊會慢慢漂開而且零錯誤訊息。

⚠️ 斷言先剝掉註解再比(本 repo 已踩過 6 次「被自己寫的註解救活」)。
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
fails = []
def ok(n, c, e=''):
    print(f"{'✅' if c else '❌'} {n}{'' if c else '  ' + str(e)[:200]}")
    if not c: fails.append(n)

py_raw = (ROOT / 'miner.py').read_text(encoding='utf-8')
py = re.sub(r'(?m)^\s*#[^\n]*$', '', py_raw)
js_raw = (ROOT / 'index.html').read_text(encoding='utf-8')
i = js_raw.find('_chipRunBuy(sym, hist)')
js = js_raw[i:i + 3500] if i > 0 else ''
js = '\n'.join(l.split('//')[0] for l in js.split('\n'))

ok('⓪ 兩份實作都找得到', i > 0 and 'RUNBUY_DAYS' in py)

# ── ① 三個門檻的**數字**必須一樣
def pynum(name):
    m = re.search(r'RUNBUY_DAYS,\s*RUNBUY_RATIO,\s*RUNBUY_CHG5\s*=\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)', py)
    return dict(zip(('days', 'ratio', 'chg5'), m.groups())) if m else {}
P = pynum('')
ok('① 採礦端讀得到三個門檻', set(P) == {'days', 'ratio', 'chg5'}, P)
if P:
    ok('①a 連買天數一致(3)', P['days'] == '3' and re.search(r'hist\.slice\(-3\)', js) is not None, P.get('days'))
    ok('①b 佔量比門檻一致(0.5%)', float(P['ratio']) == 0.5 and re.search(r'>=\s*0\.5', js) is not None, P.get('ratio'))
    ok('①c 5 日漲幅門檻一致(8%)', float(P['chg5']) == 8.0 and re.search(r'chg5\s*<\s*8', js) is not None, P.get('chg5'))

# ── ② 兩邊都要求「**連續**交易日」(⛔ 缺席不算連買)
ok('② 採礦端要求連續交易日', re.search(r'ii\[k \+ 1\] != ii\[k\] \+ 1', py) is not None)
ok('②b 前端要求連續交易日', re.search(r'ii\[1\] !== ii\[0\] \+ 1', js) is not None)

# ── ③ 兩邊都要「同名先加總再比門檻」(V77.0.5 的修法,⛔ 不可只修一邊)
ok('③ 採礦端同名先加總', re.search(r'agg\[nm\]\s*=\s*agg\.get\(nm,\s*0\.0\)\s*\+\s*net', py) is not None)
ok('③b 前端同名先加總', re.search(r'sum\.set\([^)]*sum\.get\(', js) is not None)

# ── ④ 5 日漲幅的基準都是「往回第 5 根」(⛔ 不可一邊用 5 根、一邊用 6 根)
ok('④ 採礦端用 iL-5', re.search(r'krows\[iL - 5\]', py) is not None)
ok('④b 前端用 iL-5', re.search(r'data\[iL - 5\]', js) is not None)

# ── ⑤ 全市場榜要有**新鮮度守門**(⛔ 19 天前結束的連買不可當今天的訊號)
ok('⑤ 全市場榜有訊號日新鮮度守門', '_base_d' in py and re.search(r"x\['date'\] >= _base_d", py) is not None)
ok('⑤b 而且用 P95 不用 max(單一髒檔的未來日期會把全部濾掉)', '0.95' in py)

# ── ⑥ 產物要誠實:空的時候也要寫出來 + 帶實測數字
ok('⑥ payload 有 runbuy 這個 key', re.search(r"'runbuy':\s*runbuy", py) is not None)
ok('⑥b 而且附實測成績(⛔ 沒有數字的榜不可上)', re.search(r"'runbuy_edge'", py) is not None and '1.36' in py)

# ── ⑦ 前端顯示層:⛔ 不新增卡片、沒中就整段不顯、三句免責不可省
js2 = js_raw[js_raw.find('_runBuyHtml()'): js_raw.find('_runBuyHtml()') + 3000]
js2c = '\n'.join(l.split('//')[0] for l in js2.split('\n'))
ok('⑦ 前端有 _runBuyHtml', '_runBuyHtml()' in js_raw)
ok('⑦a 舊產物沒有這個欄位 → 整段不顯(⛔ 不可謊報「今天沒有」)',
   re.search(r'!Array\.isArray\(d\.runbuy\)', js2c) is not None and "return ''" in js2c)
ok('⑦b 今天沒中 → 不留空殼', re.search(r'rb\.length\)?\s*return', js2c) is not None or '!rb.length' in js2c)
for w, lab in (('未扣成本', '未扣成本'), ('窗口偏多頭', '窗口偏多頭'), ('不是保證', '不是保證')):
    ok(f'⑦c 免責「{lab}」在卡上', w in js2c)
ok('⑦d 而且要寫出**方向**(已經發動才跟)', '已經發動才跟' in js2c)
ok('⑦e 數字讀採礦端的 runbuy_edge(⛔ 不寫死)', 'runbuy_edge' in js2c and 'E.d20' in js2c)
# ⛔ 不可新增卡片 —— 它必須掛在既有的「全市場主力買賣排行」裡面
ok('⑦f ⛔ 不新增卡片:掛在既有的主力買賣排行卡內',
   re.search(r'\$\{this\._runBuyHtml\(\)\}', js_raw) is not None
   and js_raw.find('${this._runBuyHtml()}') > js_raw.find('_brokerStockRankHtml()'))

print('\n' + ('❌ %d 條失敗' % len(fails) if fails else '✅ RUNBUY_PARITY_PASS'))
sys.exit(1 if fails else 0)
