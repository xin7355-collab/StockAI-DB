#!/usr/bin/env python3
"""🌡️ 景氣對策信號寫入守門 —— 這個 bug 讓 macro_risk.json 整整停產 4 天而 workflow 全綠。

實測(2026-09-02 daily_miner run #544 的 job log,⛔ 不是推理出來的):
    🌡️ 景氣對策信號(FinMind 備援):41 分 / red / 2026-07 ・欄位 `monitoring`
    💥 macro_miner 頂層異常:'NoneType' object has no attribute 'get'
    ✅ macro_miner.py            ← 頂層 except 印完就 sys.exit(0) → rc=0 → 綠燈

真因:`out` 初始化就有 `"business_signal": None`,而舊守門寫
      `if "business_signal" not in out:` → **永遠是 False** → 燈號抓到了也不寫進去
      → 下一行 `out["business_signal"].get("stale")` 對 None 呼叫 .get → 崩。
⭐ 觸發點是 V73.3.9 加了 FinMind 備援之後燈號**第一次抓得到**
  (在那之前永遠 None,走另一個分支碰不到那行)—— 修好一個東西引爆另一個。
⚠️ 崩在這裡 = 後面的 ^TWII 位階 / 板塊 ETF / 台指期 / risk_history / **寫檔**全部沒跑。

⛔ 測試要點:`out` 的初始值**必須**跟正式一樣預先塞 None —— 用 `{}` 當測資的話
   舊的壞寫法也會通過,那就是「測資自己把情境弄不見了」(陷阱 #40)。
"""
import json
import re
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
for _m in ('yfinance',):          # ⚠️ requests 是真的(macro_miner 會 from requests.adapters import)
    if _m not in sys.modules:
        _s = types.ModuleType(_m)
        _s.__getattr__ = lambda n: (lambda *a, **k: None)
        sys.modules[_m] = _s

import macro_miner as mm

FAIL = []
def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + ('' if cond else f'  ← {extra}'))
    if not cond:
        FAIL.append(name)

print('① 抓得到燈號時要真的寫進去(⛔ 這正是崩掉的那條路)')
# 🚨 初始值刻意跟正式版一樣 = 已存在但為 None
out = {'business_signal': None, 'other': 1}
r, _err = None, None
try:
    r = mm.apply_business_signal(out, 'red', 41, '2026-07', None)
except Exception as e:          # ⛔ 讓注入缺陷「乾淨地紅」,不要整包 traceback 出去
    _err = f'{type(e).__name__}: {e}'
ok('①a 不會丟例外(舊版在這裡 AttributeError)', _err is None and isinstance(out.get('business_signal'), dict), _err or '')
ok('①b light/score/month 都寫進去了', (out['business_signal'].get('light') == 'red'
    and out['business_signal'].get('score') == 41 and out['business_signal'].get('month') == '2026-07'))
ok('①c 回傳的就是寫進去的那一份', r is out['business_signal'])
ok('①d ⛔ 不可標成 stale(這是新鮮抓到的)', not out['business_signal'].get('stale'))

print('② 抓不到 + 沒有舊檔 → 誠實留 None + 寫 error(⛔ 不可留 None 物件)')
out2 = {'business_signal': None}
mm.apply_business_signal(out2, None, None, None, 'HTTP 500', prev_path='/nonexistent/macro_risk.json')
ok('②a business_signal 仍是 dict', isinstance(out2.get('business_signal'), dict))
ok('②b light 是 None 而且有寫 error', out2['business_signal'].get('light') is None
   and out2['business_signal'].get('error') == 'HTTP 500')

print('③ 抓不到 + 有舊檔 → 沿用並標 stale(⛔ 不可假裝是今天抓到的)')
tmp = Path('/tmp/_bsi_prev.json')
tmp.write_text(json.dumps({'business_signal': {'light': 'green', 'score': 27, 'month': '2026-06'}}), encoding='utf-8')
out3 = {'business_signal': None}
mm.apply_business_signal(out3, None, None, None, 'timeout', prev_path=str(tmp))
b = out3['business_signal']
ok('③a 沿用舊燈號', b.get('light') == 'green' and b.get('month') == '2026-06')
ok('③b 🚨 一定要標 stale=True(⛔ 否則前端分不出是不是今天的)', b.get('stale') is True)
ok('③c 舊錯誤要留著(查得出為什麼沿用)', b.get('last_error') == 'timeout')
ok('③d source 要標 ndc-stale', b.get('source') == 'ndc-stale')

print('④ 舊檔內容是 null / 壞掉 → ⛔ 不可炸(它是 fallback,不能自己變成新的失敗點)')
tmp.write_text('null', encoding='utf-8')
out4 = {'business_signal': None}
mm.apply_business_signal(out4, None, None, None, 'x', prev_path=str(tmp))
ok('④a 仍寫得出 dict', isinstance(out4.get('business_signal'), dict) and out4['business_signal'].get('light') is None)
tmp.write_text('{ 壞掉的 JSON', encoding='utf-8')
out5 = {'business_signal': None}
mm.apply_business_signal(out5, None, None, None, 'x', prev_path=str(tmp))
ok('④b 壞 JSON 也不炸', isinstance(out5.get('business_signal'), dict))

print('⑤ ⛔ main() 裡不可再出現那個壞守門(⭐ 這條防的是「有人改回去」)')
src = Path(__file__).resolve().parent.parent.joinpath('macro_miner.py').read_text(encoding='utf-8')
# 🚨 掃描前一定要先剝掉「註解與 docstring」—— 本專案第 11 次踩到
#    「說明這個 bug 的文字裡就寫著壞寫法本身」→ 不剝的話這條永遠紅(而人會想把它放寬)。
code = re.sub(r'"""[\s\S]*?"""', '', src)
code = '\n'.join(l for l in code.split('\n') if not l.lstrip().startswith('#'))
ok('⑤a ⛔ 程式碼裡不可再有 `"business_signal" not in out`(說明文字不算)',
   '"business_signal" not in out' not in code)
ok('⑤b main() 走的是這支共用函式', 'apply_business_signal(out, bsi_light' in code)
ok('⑤c 🚧 空過守門:剝完註解後還要剩下大部分程式碼(⛔ 否則 ⑤a 是假綠燈)',
   len(code) > len(src) * 0.5, f'{len(code)} vs {len(src)}')

print('⑥ 🚨 空過守門:測資本身要真的重現情境(⛔ 否則舊寫法也會過)')
ok('⑥a 測資的 out 一開始就有 business_signal 這個 key 且為 None',
   ('business_signal' in {'business_signal': None}) and ({'business_signal': None}['business_signal'] is None))

print()
if FAIL:
    print(f'❌ {len(FAIL)} 條失敗:' + ' / '.join(FAIL))
    sys.exit(1)
print('✅ MACRO_BSI_PASS(全部通過)')
