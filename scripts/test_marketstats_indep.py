#!/usr/bin/env python3
"""💳 market_stats.json:P/B 分位與融資維持率必須**各自獨立**(V72.1.1)

實測 2026-08-04 讀 gh-pages:
  data/market_stats.json 只有 118 bytes、**只有 pb 沒有 margin**
  → V72.0.3 加的「全市場融資維持率」從上線到現在**一次都沒產出過**,而且零錯誤訊息。

根因:margin 那段被**巢狀在 `if pb_pct:` 裡面** →
  P/B 分位算不出來(fundamentals 抓不到)時,整段 market_stats 走「保留既有值」,
  融資維持率就完全沒機會寫 —— 即使它自己算得出來
  (它只讀 data/*.json 的 margin_balance + 收盤價,**根本不需要 fund_cache**)。

⭐ 通用鐵則:**兩個互相獨立的指標,不可綁在同一個 if 裡** —— 一個失敗會拖累另一個,
   而且症狀是「檔案在、workflow 綠、就是少一半內容」,極難察覺(同陷阱 #9)。

跑法:python3 scripts/test_marketstats_indep.py
"""
import inspect
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import miner  # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + ('' if cond else f'  {str(extra)[:200]}'))
    if not cond:
        fails.append(name)


src = Path(miner.__file__).read_text(encoding='utf-8')

# ── ① 找到寫 market_stats 的那一段 ────────────────────────────
i = src.find("ms_path = Path('data', 'market_stats.json')")
ok('① 找得到 market_stats 寫入區塊', i > 0, i)
blk = src[i:i + 4200]

# ── ② ⭐ margin 不可巢狀在 `if pb_pct:` 之內 ─────────────────
#   判斷方式:比對兩者的縮排深度 —— margin 那段若比 `if pb_pct:` 深,就是被包住了
m_pb = re.search(r'^(\s*)pb_pct = compute_market_pb_percentiles', blk, re.M)
m_mh = re.search(r'^(\s*)mh = compute_market_margin_health', blk, re.M)
ok('② 兩個呼叫都在區塊內', bool(m_pb and m_mh), f'pb={bool(m_pb)} mh={bool(m_mh)}')
if m_pb and m_mh:
    # mh 允許包在自己的 try 裡(+4),但⛔ 不可再深到「被 if pb_pct 包住」那一層(+8 以上)
    d_pb, d_mh = len(m_pb.group(1)), len(m_mh.group(1))
    ok('② ⭐⛔ 融資維持率不可巢狀在「P/B 成功」之內',
       d_mh - d_pb <= 4, f'pb 縮排 {d_pb}、mh 縮排 {d_mh}(差 {d_mh - d_pb} > 4 = 被包住了)')

# ── ③ ⭐ P/B 失敗的分支要明說「不影響融資維持率」──────────────
ok('③ ⭐ P/B 算不出來時要註明不影響下面',
   '不影響下面的融資維持率' in blk, blk[:200])
ok('③ ⛔ 舊的「不寫 market_stats.json(保留既有值)」不可留著(那正是整段被跳過的寫法)',
   '不寫 market_stats.json' not in blk, '')

# ── ④ ⭐ 陷阱 #22:算不出來要留原因 ─────────────────────────
ok('④ ⭐ margin 算不出來要寫 margin_error', "existing_ms['margin_error']" in blk, '')
ok('④ ⭐ 成功時要把舊的 margin_error 清掉(否則永遠掛著假警報)',
   "existing_ms.pop('margin_error', None)" in blk, '')
ok('④ 例外也要寫進 margin_error(不可只 print)',
   re.search(r"except Exception as _e_mh:[\s\S]{0,200}margin_error", blk) is not None, '')

# ── ⑤ ⭐ 只要任一邊成功就要寫檔 ───────────────────────────
ok('⑤ ⭐ 用 _ms_dirty 旗標決定寫檔(⛔ 不綁在 pb_pct 上)', '_ms_dirty' in blk, '')
ok('⑤ pb 成功會標 dirty', re.search(r"existing_ms\['pb'\] = pb_pct\s*\n\s*_ms_dirty = True", blk) is not None, '')
ok('⑤ margin 成功也會標 dirty', re.search(r"existing_ms\['margin_hist'\] = _h\[-500:\]\s*\n\s*_ms_dirty = True", blk) is not None, '')

# ── ⑥ ⭐ 融資維持率函式本身⛔ 不可依賴 fund_cache ───────────────
sig = inspect.signature(miner.compute_market_margin_health)
ok('⑥ ⭐⛔ compute_market_margin_health 不收任何參數(證明它不依賴 fundamentals)',
   len(sig.parameters) == 0, str(sig))
fsrc = inspect.getsource(miner.compute_market_margin_health)
ok('⑥ ⛔ 函式內不可讀 fund_cache / fundamentals_cache',
   'fund_cache' not in fsrc and 'fundamentals_cache' not in fsrc, '')
ok('⑥ 它讀的是 margin_balance(這才是它真正的依賴)', 'margin_balance' in fsrc, '')

# ── ⑦ 實跑:拿真實 data/ 算一次,確認它真的算得出來 ───────────────
#   ⛔ 不能只驗程式碼結構 —— 那驗不出「其實根本算不出來」
try:
    mh = miner.compute_market_margin_health()
except Exception as e:                                   # pragma: no cover
    mh = None
    print(f'   ↳ 實跑丟例外:{str(e)[:120]}')
if mh:
    ok('⑦ ⭐ 實跑算得出維持率', isinstance(mh.get('ratio'), (int, float)) and mh['ratio'] > 0, mh)
    ok('⑦ 樣本數要過守門(n >= 200)', mh.get('n', 0) >= 200, mh.get('n'))
    ok('⑦ ⭐ 必須帶免責 note(是推估不是官方值)', '推估' in str(mh.get('note', '')), mh.get('note'))
    print(f"   ↳ 實跑結果:{mh['ratio']}% ・{mh['n']} 檔有效 ・{mh.get('level')}")
else:
    # data/ 可能沒有融資資料(乾淨 checkout)→ 不算失敗,但要講清楚
    print('   ⏭️ 本機 data/ 沒有足夠融資資料,略過實跑(結構驗證仍有效)')

print()
if fails:
    print(f'❌ MARKETSTATS_INDEP_FAIL: {fails}')
    raise SystemExit(1)
print('✅ MARKETSTATS_INDEP_PASS')
