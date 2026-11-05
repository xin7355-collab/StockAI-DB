#!/usr/bin/env python3
"""🏦 V81.0.2 反攻雷達「外資期貨回補」那一格:⛔ 不可再印「資料整編中（待對接）」+ 外資期貨抓不到時改讀每日採礦那份

使用者 11/06 截圖(盤前反攻雷達)那一格寫「資料整編中（待對接）」。查下去是兩件事:
  ① judge_fi_complex 缺一條腿時回那個佔位字串 → 前端把它當成「結論」印出來
  ② 缺的那條腿是外資期貨:11/05~11/06 那幾輪 macro_miner 的 TAIFEX 查詢回「表格結構未匹配」
     → fi_futures_net 被斷崖防護一路沿用 11/04 的 −91,812(risk_history 11/05、11/06 都是它)
     → 而 miner.py 同一天抓到 11/05 −95,651(futures_cache.json)= 5 日增減用的是舊數字

釘住(全部走 main() 會呼叫的那幾支:_fi_futures_pick / _fi_complex_pick / _futures_cache_fallback):
  ① judge_fi_complex 缺腿 → None(⛔ 佔位字串);原始碼裡⛔ 再有那個字串
  ② _futures_cache_fallback:本機新的 → 用本機、⛔ 打網路;本機沒有 → gh-pages;超過 7 天 / 欄位不齊 → ⛔ 收並寫原因
  ③ _fi_futures_pick:TAIFEX 抓到 → src=taifex、⛔ 叫備援;抓不到 → 備援的值 + 日期、⛔ 寫 error;兩邊都沒有 → None + 兩個原因
  ④ _fi_complex_pick:缺腿 / 跨日 → (None, 原因);同一天 → 有結論
  ⑤ ⭐ 決定性對照(重播 11/06 03:13 那輪):有備援 → 期貨 = 11/05 那份、結論有一句話;拿掉備援 → 期貨 None、結論 None + 原因(⛔ 佔位字串)
  ⑥ 接線:main() 用這兩支(⛔ 再直接呼叫 judge_fi_complex)
"""
import io
import json
import os
import sys
import tempfile
import types
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('SKIP_GLOBAL', '1')
for _m in ('yfinance',):
    if _m not in sys.modules:
        sys.modules[_m] = types.ModuleType(_m)
_tmp = tempfile.mkdtemp(prefix='fic-')
os.chdir(_tmp)                       # macro_miner 匯入時會建 data/ → 放在暫存區
import macro_miner as mm             # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:300]}")
    if not cond:
        fails.append(name)


class _Res:
    def __init__(self, code, obj=None):
        self.status_code, self._obj = code, obj

    def json(self):
        return self._obj


def fake_get(code, obj=None, calls=None):
    def g(url, timeout=None):
        if calls is not None:
            calls.append(url)
        return _Res(code, obj)
    return g


TODAY = date(2026, 11, 6)
SRC = (ROOT / 'macro_miner.py').read_text(encoding='utf-8')

# ① 佔位字串
ok('① 缺期貨 → None', mm.judge_fi_complex(None, -1024.61, [-90000] * 10) is None)
ok('① 缺現貨 → None', mm.judge_fi_complex(-95651, None, [-90000] * 10) is None)
ok('① 原始碼⛔ 再有「資料整編中（待對接）」', '資料整編中（待對接）' not in SRC and '資料整編中(待對接)' not in SRC)

# ② 備援讀 futures_cache.json
d = Path(tempfile.mkdtemp(prefix='fc-'))
fresh = {"date": "2026-11-05", "fi_net": -95651, "long": 13388, "short": 109039, "generated": "2026-11-05"}
(d / 'futures_cache.json').write_text(json.dumps(fresh), encoding='utf-8')
calls = []
with redirect_stdout(io.StringIO()):
    r = mm._futures_cache_fallback(get=fake_get(200, {"date": "2026-11-04", "fi_net": -1}, calls), local_path=d / 'futures_cache.json', today=TODAY)
ok('② 本機新的 → 用本機那份', r[:3] == (-95651, '2026-11-05', '本機 futures_cache.json'), r)
ok('② 本機新的 → ⛔ 打網路', calls == [], calls)
calls = []
with redirect_stdout(io.StringIO()):
    r = mm._futures_cache_fallback(get=fake_get(200, fresh, calls), local_path=d / 'nope.json', today=TODAY)
ok('② 本機沒有 → 讀 gh-pages 那份', r[:3] == (-95651, '2026-11-05', 'gh-pages futures_cache.json') and len(calls) == 1, (r, calls))
(d / 'old.json').write_text(json.dumps({**fresh, "date": "2026-10-20"}), encoding='utf-8')
with redirect_stdout(io.StringIO()):
    r = mm._futures_cache_fallback(get=fake_get(404), local_path=d / 'old.json', today=TODAY)
ok('② 本機的超過 7 天 + gh-pages 404 → None,原因兩個都寫', r[0] is None and '不在 7 天內' in (r[3] or '') and 'HTTP 404' in (r[3] or ''), r)
(d / 'bad.json').write_text(json.dumps({"date": "2026-11-05", "fi_net": True}), encoding='utf-8')
with redirect_stdout(io.StringIO()):
    r = mm._futures_cache_fallback(get=fake_get(200, {"date": "2026-11-05"}), local_path=d / 'bad.json', today=TODAY)
ok('② fi_net 是布林 / 少欄位 → ⛔ 收', r[0] is None and '欄位不齊' in (r[3] or ''), r)

# ③ _fi_futures_pick
n_fb = []
def fb_val():
    n_fb.append(1)
    return (-95651, '2026-11-05', '本機 futures_cache.json', None)
with redirect_stdout(io.StringIO()):
    p = mm._fi_futures_pick((-91812, None), fb_val)
ok('③ TAIFEX 抓到 → src=taifex、⛔ 叫備援', p['fi_futures_net'] == -91812 and p['fi_futures_src'] == 'taifex' and p['fi_futures_date'] is None and n_fb == [], (p, n_fb))
with redirect_stdout(io.StringIO()):
    p = mm._fi_futures_pick((None, 'TAIFEX 表格結構未匹配'), fb_val)
ok('③ TAIFEX 沒抓到 → 用備援的值 + 日期、⛔ 寫 error', p['fi_futures_net'] == -95651 and p['fi_futures_date'] == '2026-11-05' and p['fi_futures_src'] == '本機 futures_cache.json' and p['fi_futures_error'] is None, p)
with redirect_stdout(io.StringIO()):
    p = mm._fi_futures_pick((None, 'TAIFEX 表格結構未匹配'), lambda: (None, None, None, 'gh-pages HTTP 404'))
ok('③ 兩邊都沒有 → None + 兩個原因', p['fi_futures_net'] is None and 'TAIFEX 表格結構未匹配' in p['fi_futures_error'] and 'HTTP 404' in p['fi_futures_error'], p)

# ④ _fi_complex_pick
hist = [-86000, -87000, -86500, -88000, -89000, -90000, -89500, -91000, -91500, -92000]
c, e = mm._fi_complex_pick(None, None, -1024.61, '20261105', hist)
ok('④ 缺期貨 → (None, 原因)', c is None and e == '外資期貨這一輪沒抓到', (c, e))
c, e = mm._fi_complex_pick(-95651, '2026-11-05', None, None, hist)
ok('④ 缺現貨 → (None, 原因)', c is None and e == '外資現貨這一輪沒抓到', (c, e))
c, e = mm._fi_complex_pick(-95651, '2026-11-04', -1024.61, '20261105', hist)
ok('④ 期貨 11/04 vs 現貨 11/05 → ⛔ 湊一句話', c is None and '不是同一天' in (e or ''), (c, e))
c, e = mm._fi_complex_pick(-95651, '2026-11-05', -1024.61, '20261105', hist)
ok('④ 同一天 → 有結論、沒有原因', isinstance(c, str) and c and e is None, (c, e))
c2, e2 = mm._fi_complex_pick(-95651, None, -1024.61, '20261105', hist)
ok('④ TAIFEX 那條沒日期 → 照舊給結論(⛔ 因為沒日期就擋)', c2 == c and e2 is None, (c2, e2))

# ⑤ 決定性對照:重播 11/06 03:13 那輪
with redirect_stdout(io.StringIO()):
    with_fb = mm._fi_futures_pick((None, 'TAIFEX 表格結構未匹配'),
                                  lambda: mm._futures_cache_fallback(get=fake_get(404), local_path=d / 'futures_cache.json', today=TODAY))
    no_fb = mm._fi_futures_pick((None, 'TAIFEX 表格結構未匹配'), lambda: (None, None, None, '沒有備援'))
cw = mm._fi_complex_pick(with_fb['fi_futures_net'], with_fb['fi_futures_date'], -1024.61, '20261105', hist)
cn = mm._fi_complex_pick(no_fb['fi_futures_net'], no_fb['fi_futures_date'], -1024.61, '20261105', hist)
ok('⑤ 有備援 → 期貨 = 11/05 那份 −95,651,結論有一句話', with_fb['fi_futures_net'] == -95651 and isinstance(cw[0], str) and cw[0], (with_fb, cw))
ok('⑤ 拿掉備援 → 期貨 None、結論 None + 原因(⛔ 佔位字串)', no_fb['fi_futures_net'] is None and cn[0] is None and cn[1] == '外資期貨這一輪沒抓到', (no_fb, cn))

# ⑥ 接線
_a = SRC.index('\ndef main():')
_b = SRC.find('\ndef ', _a + 10)
run_src = SRC[_a:_b if _b > _a else len(SRC)]
ok('⑥ 空過守門:切得到 main()', len(run_src) > 5000, len(run_src))
ok('⑥ main() 用 _fi_futures_pick(fetch_foreign_futures_net(), _futures_cache_fallback)', 'out.update(_fi_futures_pick(fetch_foreign_futures_net(), _futures_cache_fallback))' in run_src)
ok('⑥ main() 期現結論走 _fi_complex_pick', 'out["fi_complex_conclusion"], out["fi_complex_error"] = _fi_complex_pick(' in run_src)
ok('⑥ main() ⛔ 再直接 judge_fi_complex(…)', 'judge_fi_complex(' not in run_src)
ok('⑥ 新欄位有初始值(fi_futures_src / fi_futures_date / fi_complex_error)',
   all(f'"{k}"' in SRC for k in ('fi_futures_src', 'fi_futures_date', 'fi_complex_error')))

print(f"\n{'❌ ' + str(len(fails)) + ' 條沒過' if fails else '✅ test_fi_complex 全部通過'}")
sys.exit(1 if fails else 0)
