#!/usr/bin/env python3
"""🆓 V79.0.0 fetch_free_fundamentals 守門(券商分點 + 10 個付費資料集移除後,只留每檔基本面)

釘住的用意:
  ① 寫出的 data/chips/{sym}.json **只有基本面**:⛔ 不可再有 chips / periods / hist / bstat / data_completeness
     (前端 X 光機、報告頁、top_picks 都讀 fundamentals,路徑不能變)
  ② ⛔ 舊檔裡的分點欄位要被洗掉(不是保留 09/30 的舊分點)
  ③ 冷門股 ⛔ 不打 FinMind(零 API,只寫 TWSE/TPEx 的 PE/殖利率)
  ④ miner.py ⛔ 不可再有付費偵測 / 分點相關函式(會動到真的付費 API)
用假網路跑真的那支函式(⛔ 測試裡不複製一份邏輯)。
"""
import json, os, sys, tempfile, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
fails = []
def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:240]}")
    if not cond:
        fails.append(name)

tmp = tempfile.mkdtemp()
cwd = os.getcwd()
os.chdir(tmp)
try:
    import miner
    Path('data/chips').mkdir(parents=True, exist_ok=True)
    miner.DATA_DIR = 'data'
    # 兩檔:2330(精選清單 = 熱門) / 9999(冷門)
    for sym in ('2330', '9999'):
        rows = [{'date': f'2026/10/0{i}', 'close': 100.0, 'volume': 1e6} for i in range(1, 8)]
        Path(f'data/{sym}.json').write_text(json.dumps(rows), encoding='utf-8')
    # 舊格式 chips 檔:帶著分點欄位 + 有效基本面快取(冷門股那檔)
    old = {'fundamentals': {'eps': 1.0, 'generated': '2026-10-08', 'miner_version': miner.MINER_VERSION},
           'chips': [{'date': '2026-09-30', 'buyers': [{'bnm': 'X', 'net': 1}]}],
           'periods': {'1d': {'buy': [], 'sell': []}}, 'hist': [{'d': '2026-09-30'}],
           'bstat': {'b': {}}, 'data_completeness': {'broker_chip': False}}
    Path('data/chips/9999.json').write_text(json.dumps(old), encoding='utf-8')

    calls = {'fm': []}
    miner.fetch_twse_fundamentals = lambda d: {'2330': {'pe': 20.0, 'yield_rate': 2.0, 'pbr': 5.0},
                                               '9999': {'pe': 8.0, 'yield_rate': 5.0, 'pbr': 1.0}}
    miner.fetch_tpex_fundamentals = lambda: {}
    miner.fetch_industry_map = lambda: {}
    miner.build_stock_names = lambda m: None
    miner.compute_market_margin_health = lambda: None
    miner.compute_market_pb_percentiles = lambda f: None
    miner.write_miner_status = lambda *a, **k: None
    miner.compute_dividend_fill_history = lambda *a, **k: ([], None, None)
    miner._fetch_finmind_per = lambda sym: {}
    def _fm(sym):
        calls['fm'].append(sym)
        return {'eps': 9.9, 'revenue_yoy': 12.0, 'gross_margin_trend': '50%→51%↑'}
    miner.fetch_finmind_fundamentals = _fm
    miner.CHIP_WATCHLIST = ['2330']

    miner.fetch_free_fundamentals()

    a = json.loads(Path('data/chips/2330.json').read_text(encoding='utf-8'))
    b = json.loads(Path('data/chips/9999.json').read_text(encoding='utf-8'))
    BAD = ('chips', 'periods', 'hist', 'bstat', 'data_completeness')
    ok('① 熱門股檔只有基本面(⛔ 沒有分點欄位)', 'fundamentals' in a and not any(k in a for k in BAD), sorted(a))
    ok('① 熱門股基本面來自 FinMind(eps 9.9)+ TWSE PE', a['fundamentals'].get('eps') == 9.9 and a['fundamentals'].get('pe') == 20.0, a['fundamentals'])
    ok('② 舊檔的分點欄位被洗掉', not any(k in b for k in BAD), sorted(b))
    ok('② 冷門股沿用快取的基本面 + 今天的 TWSE PE', b['fundamentals'].get('eps') == 1.0 and b['fundamentals'].get('pe') == 8.0, b['fundamentals'])
    ok('③ 冷門股 ⛔ 不打 FinMind', calls['fm'] == ['2330'], calls['fm'])
    fc = json.loads(Path('data/fundamentals_cache.json').read_text(encoding='utf-8'))
    ok('③b fundamentals_cache 有寫出(含 YoY 併入)', fc.get('2330', {}).get('rev_yoy') == 12.0 and fc.get('9999', {}).get('pe') == 8.0, fc.get('2330'))
finally:
    os.chdir(cwd)
    shutil.rmtree(tmp, ignore_errors=True)

src = (ROOT / 'miner.py').read_text(encoding='utf-8')
code = '\n'.join(l for l in src.split('\n') if not l.lstrip().startswith('#'))
for bad in ('def fetch_broker_chips', 'def detect_finmind_paid', 'def fm_paid_get', 'def build_broker_perf',
            'def _fetch_chips_bulk', 'taiwan_stock_trading_daily_report', 'FINMIND_PAID_TOKENS'):
    ok(f'④ miner.py ⛔ 不可再有 {bad}', bad not in code)

print(f"\n{'❌ FREE_FUND_FAIL:' + str(len(fails)) + ' 條' if fails else '✅ FREE_FUND_PASS'}")
sys.exit(1 if fails else 0)
