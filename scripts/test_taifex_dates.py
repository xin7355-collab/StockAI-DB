#!/usr/bin/env python3
"""台指逆價差「兩條腿必須同一天」守門測試(不打網路)。

踩到的事(2026-07-30 使用者截圖):
  大盤頁三格顯示 加權 40,039(07/29 收盤)、台指電子盤 41,613 —— 看起來是 +1,574 點的
  巨大正價差。查 macro_risk.json:
      taifex_tx_now = {'price': 41613.0, 'chg': -5.17, 'est': False}
      taifex_backwardation = 10.0
  41,613 − 10 = 41,603 = **07/28** 的加權收盤。也就是 yfinance 的 ^TXF=F 與 ^TWII
  兩邊都落後一個交易日,價差本身自洽、但整組是昨天的,而前端把它跟今天的指數並排。

  為什麼非修不可:正逆價差是判讀外資空單真假的關鍵配套 ——
  空單大但仍正價差 = 多半是避險/套利;空單大又深度逆價差 = 才是真的在殺。
  價差算錯會把「避險」誤判成「看空」,結論整個反過來。

修法:
  ① 現貨改用本地 data/^TWII.json(miner.py 直接抓證交所,當天下午就有,權威且不落後)
  ② 期貨那條腿記下資料日期;兩邊日期對不上就回 None + 原因,不硬給一個看起來合理的假數字
  ③ taifex_tx_now 補上 date/src,前端才能誠實標「07/28 收盤(非今日)」

驗:
  ① 同一天 → 正常算出價差
  ② 期貨落後一天 → 回 None 且原因講清楚(不可回一個數字)
  ③ 現貨優先讀本地證交所檔(不是 yfinance)
  ④ 本地檔沒有/壞掉 → 退回 yfinance,不炸
  ⑤ 期貨日期未知 → 不擋(只有「明確不同天」才擋,避免過度保守整天沒價差)
  ⑥ _LAST_TWII_SPOT 有被設(期現比 合約價值=指數×200 要用)
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault('SKIP_GLOBAL', '1')

import types
for _m in ('yfinance',):
    if _m not in sys.modules:
        _stub = types.ModuleType(_m)
        _stub.Ticker = lambda *a, **k: None
        sys.modules[_m] = _stub

import macro_miner as mm

TMP = tempfile.TemporaryDirectory()
DD = Path(TMP.name) / 'data'
DD.mkdir(parents=True)
mm.DATA_DIR = DD


def seed_spot(date_str, close):
    (DD / '^TWII.json').write_text(json.dumps(
        [{'date': '2026/07/28', 'close': 41603.36},
         {'date': date_str, 'close': close}]), encoding='utf-8')


def run(fut_close, fut_date):
    mm._LAST_TX_FUT_DATE = fut_date
    mm._taifex_openapi_tx_fut_close = lambda: fut_close
    return mm.fetch_taifex_backwardation()


# ① 同一天 → 正常算
seed_spot('2026/07/29', 40039.18)
back, err = run(40120.0, '2026-07-29')
assert err is None and back == 81.0, f'① 應算出 +81,實際 back={back} err={err}'
print(f'✅ ① 期貨與現貨同一天 → 正常算出價差 {back:+.0f} 點')

# ② 期貨落後一天 → 不可回數字(這正是 07/30 那次的情境)
back, err = run(41613.0, '2026-07-28')
assert back is None, f'② 跨日不該回數字,實際 {back}(那會變成 +1,574 點的假正價差)'
assert err and '不同交易日' in err and '2026-07-28' in err and '2026-07-29' in err, f'② 原因要講清楚,實際:{err}'
print(f'✅ ② 期貨(07/28)配現貨(07/29)→ 回 None 並說明:{err}')

# ③ 現貨優先讀本地證交所檔,不是 yfinance
called = {'yf': 0}


class _FakeYf:
    @staticmethod
    def Ticker(*a, **k):
        called['yf'] += 1
        raise AssertionError('③ 有本地檔時不該去打 yfinance 拿現貨')


sys.modules['yfinance'] = _FakeYf
seed_spot('2026/07/29', 40039.18)
back, err = run(40120.0, '2026-07-29')
assert called['yf'] == 0 and back == 81.0, f"③ 應只讀本地檔,yf 被呼叫 {called['yf']} 次"
print('✅ ③ 現貨優先讀本地 data/^TWII.json(證交所權威收盤),完全沒動用 yfinance')

# ④ 本地檔壞掉 → 退 yfinance 不炸
(DD / '^TWII.json').write_text('{壞掉', encoding='utf-8')
back, err = run(40120.0, '2026-07-29')
assert back is None and err, '④ 本地壞 + yfinance 也不可用 → 應回 (None, 原因) 而不是拋例外'
print(f'✅ ④ 本地檔壞掉 → 退 yfinance,失敗也只是回 None + 原因,不炸:{str(err)[:40]}')

# ⑤ 期貨日期未知 → 不擋(避免過度保守整天沒價差)
seed_spot('2026/07/29', 40039.18)
back, err = run(40120.0, None)
assert err is None and back == 81.0, f'⑤ 期貨日期未知時不該擋,實際 back={back} err={err}'
print('✅ ⑤ 期貨日期抓不到 → 只有「明確不同天」才擋,不會整天沒價差')

# ⑥ _LAST_TWII_SPOT 有被設(期現比用:一口合約價值 = 指數 × 200)
assert mm._LAST_TWII_SPOT == 40039.18, f'⑥ _LAST_TWII_SPOT 應為現貨收盤,實際 {mm._LAST_TWII_SPOT}'
print(f'✅ ⑥ _LAST_TWII_SPOT = {mm._LAST_TWII_SPOT}(期現比算合約價值 指數×200 要用)')

print('\n🎉 台指逆價差日期對帳 六項測試全過')
