#!/usr/bin/env python3
"""🏦 V79.5.4 macro_miner:外資期貨「相對自己」的基準讀不到本機 risk_history 時,改讀已發佈的那份(不打網路)。

踩到的事(2026-10-22 08:13 macro_cron 那輪 log 逐字):
  「⚠️ risk_history 讀不到 → 外資期貨相對狀態待累積:[Errno 2] No such file or directory: 'data/risk_history.json'」
  → macro_cron 是乾淨 checkout(data/ 在 main 是 gitignore),一天 5~6 輪發佈的 macro_risk.json 都寫「外資期貨基準累積中」,
    反攻雷達那行就一直掛著「基準累積中」。同 V79.5.2 _prev_json 那個病(守門只讀本機檔,雲端從來沒有)。

驗 _rh_from_local_or_published(get):
  ① 本機有 → 用本機,⛔ 不打網路
  ② 本機沒有 → 讀 data 分支 raw;那條掛了 → 讀 gh-pages
  ③ 全部拿不到 → 回 None 並印原因(⛔ 不可靜默)
  ④ ⭐ 決定性對照:同一份期現資料,有基準 → judge_fi_complex 給得出結論;沒有基準 → 「基準累積中」
  ⑤ fetch_business_signal ⛔ 不可宣告 br(runner 沒裝 brotli → 回應是壓縮過的亂碼)
"""
import io
import json
import os
import sys
import tempfile
import types
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('SKIP_GLOBAL', '1')
for _m in ('yfinance',):
    if _m not in sys.modules:
        sys.modules[_m] = types.ModuleType(_m)
_cwd = os.getcwd()
_tmp = tempfile.mkdtemp(prefix='rhfb-')
os.chdir(_tmp)                       # macro_miner 匯入時會建 data/ → 放在暫存區
import macro_miner as mm             # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:300]}")
    if not cond:
        fails.append(name)


class R:
    def __init__(self, code, data=None):
        self.status_code, self._d = code, data

    def json(self):
        return self._d


HIST = [{'date': f'2026-10-{d:02d}', 'fi_futures_net': -80000 + d * 100} for d in range(1, 22)]
calls = []


def fake(table):
    def get(url, timeout=None):
        calls.append(url)
        for key, resp in table.items():
            if key in url:
                if isinstance(resp, Exception):
                    raise resp
                return resp
        return R(404)
    return get


mm.DATA_DIR = Path(_tmp) / 'data'
mm.DATA_DIR.mkdir(exist_ok=True)
rh = mm.DATA_DIR / 'risk_history.json'

# ① 本機有
rh.write_text(json.dumps(HIST[:5]), encoding='utf-8')
calls.clear()
got = mm._rh_from_local_or_published(fake({'raw.githubusercontent': R(200, HIST)}))
ok('① 本機有 → 用本機(5 天),⛔ 不打網路', isinstance(got, list) and len(got) == 5 and not calls, (got and len(got), calls))

# ② 本機沒有 → data 分支 raw
rh.unlink()
buf = io.StringIO()
with redirect_stdout(buf):
    got = mm._rh_from_local_or_published(fake({'raw.githubusercontent': R(200, HIST)}))
ok('② 本機沒有 → 讀 data 分支 raw(21 天)', isinstance(got, list) and len(got) == 21 and 'data 分支 raw' in buf.getvalue(), buf.getvalue())
with redirect_stdout(io.StringIO()):
    got = mm._rh_from_local_or_published(fake({'raw.githubusercontent': RuntimeError('boom'), 'github.io': R(200, HIST[:10])}))
ok('②b raw 掛了 → 讀 gh-pages', isinstance(got, list) and len(got) == 10, got and len(got))
with redirect_stdout(io.StringIO()):
    got = mm._rh_from_local_or_published(fake({'raw.githubusercontent': R(200, []), 'github.io': R(200, HIST[:7])}))
ok('②c raw 是空的 → 不算,繼續讀 gh-pages', isinstance(got, list) and len(got) == 7, got and len(got))

# ③ 全部拿不到
buf = io.StringIO()
with redirect_stdout(buf):
    got = mm._rh_from_local_or_published(fake({'raw.githubusercontent': R(500), 'github.io': RuntimeError('dns')}))
ok('③ 全部拿不到 → None,而且印出每一條的原因(⛔ 不可靜默)',
   got is None and '讀不到' in buf.getvalue() and 'HTTP 500' in buf.getvalue() and 'dns' in buf.getvalue(), buf.getvalue())

# ④ 決定性對照:基準有沒有,同一份期現資料的結論不同
hist_vals = [h['fi_futures_net'] for h in HIST]
with_base = mm.judge_fi_complex(-95000, 50, hist_vals)
no_base = mm.judge_fi_complex(-95000, 50, [])
ok('④ ⭐ 決定性對照:有基準 → 給得出結論;沒有基準 → 「基準累積中」',
   '累積中' not in with_base and '累積中' in no_base, (with_base, no_base))

# ⑤ 景氣燈號 ⛔ 不可宣告 br
src = (ROOT / 'macro_miner.py').read_text(encoding='utf-8')
i = src.index('def fetch_business_signal():')
body = src[i:src.index('\ndef ', i + 10)]
enc = [l for l in body.split('\n') if "'Accept-Encoding'" in l and not l.strip().startswith('#')]
ok("⑤ fetch_business_signal 的 Accept-Encoding ⛔ 不可有 br(runner 沒裝 brotli → 亂碼)",
   len(enc) == 1 and 'br' not in enc[0].split(':', 1)[1], enc)
# ⑤b 呼叫端真的接上
main_src = src[src.index('# 🏦 V79.3.5 期貨偏空與否改看「相對自己」'):]
ok('⑤b 外資期貨基準那段走 _rh_from_local_or_published(⛔ 不可再只讀本機檔)',
   '_rh_from_local_or_published()' in main_src[:1500], main_src[:300])

os.chdir(_cwd)
print('\n' + (f'❌ {len(fails)} 條失敗' if fails else '✅ RH_FALLBACK_PASS'))
sys.exit(1 if fails else 0)
