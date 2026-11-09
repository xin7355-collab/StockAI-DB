#!/usr/bin/env python3
"""
📈 V82.0.9 盤中快照順便存現貨加權 / 櫃買(live_snapshot_miner._fetch_spot_index)

使用者 11/09 09:45 截圖:App 拿上週五的加權漲跌 −4.51% 配今天的個股中位數 +2.15% →「今天指數被權值股拖累」,
實際 0050 / 台指期都漲約 5%(正好相反)。快照裡有現貨加權之後,兩個數字出自同一個時間點、⛔ 不用富果金鑰。

走正式入口 `main()`(假 shioaji 模組 + 暫存資料夾),⛔ 在測試裡另寫一份邏輯:
  ① 一般模式(1.5 代碼 '001' / '101')→ live_quotes.json 的 idx 有 twii / twoii;股票檔數不變(指數 ⛔ 混進 data)
  ② 1.7 代碼('IX0001' / 'IX0043')也找得到 ・③ 只有屬性 TSE001 / OTC101 也找得到
  ④ 指數 snapshots 丟例外 → 照常產出、沒有 twii、股票與台指期都在
  ⑤ 沒有 Indexs 這一層 → 照常產出、沒有 twii
  ⑥ 盤前模式 → live_index.json ⛔ 有 twii(現貨還沒開,會是昨天的值)、⛔ 寫 live_quotes.json
INJECT=nocall(拿掉呼叫)→ ① 必紅
"""
import os
import sys
import json
import types
import tempfile
import importlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
FAILS = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:300]}'))
    if not cond:
        FAILS.append(name)


class Snap:
    def __init__(self, close, rate, vol=1000):
        self.close, self.change_rate, self.total_volume = close, rate, vol
        self.open, self.high, self.low, self.volume_ratio = close, close, close, 1.0


class C:
    def __init__(self, code, exchange='TSE', delivery_date=''):
        self.code, self.exchange, self.delivery_date = code, exchange, delivery_date


class Group(list):
    """可以 for、可以 [代碼]、可以 .屬性 —— 跟 Shioaji 的合約群組一樣三種拿法"""
    def __init__(self, items=(), mapping=None, attrs=None):
        super().__init__(items)
        self._map = mapping or {}
        for k, v in (attrs or {}).items():
            setattr(self, k, v)

    def __getitem__(self, k):
        if isinstance(k, (int, slice)):
            return list.__getitem__(self, k)
        if k in self._map:
            return self._map[k]
        raise KeyError(k)


def make_api(index_style='15', idx_raise=False, no_indexs=False, n_stocks=400):
    stocks = Group([C(str(1101 + i)) for i in range(n_stocks)])
    twii, twoii = C('IDX_TWII', 'TSE'), C('IDX_TWOII', 'OTC')
    snaps_map = {'IDX_TWII': Snap(41700.0, 5.03), 'IDX_TWOII': Snap(318.5, 4.76),
                 'TXF_N': Snap(41654.0, 5.05), 'MXF_N': Snap(41659.0, 5.06)}
    fut = types.SimpleNamespace(TXF=Group([C('TXF_N', 'TAIFEX', '2099/12/31')]), MXF=Group([C('MXF_N', 'TAIFEX', '2099/12/31')]))
    if index_style == '15':
        tse, otc = Group(mapping={'001': twii}), Group(mapping={'101': twoii})
    elif index_style == '17':
        tse, otc = Group(mapping={'IX0001': twii}), Group(mapping={'IX0043': twoii})
    else:   # 只有屬性
        tse, otc = Group(attrs={'TSE001': twii}), Group(attrs={'OTC101': twoii})
    contracts = types.SimpleNamespace(Stocks=Group([stocks]), Futures=fut)
    if not no_indexs:
        contracts.Indexs = types.SimpleNamespace(TSE=tse, OTC=otc)

    class Api:
        Contracts = contracts

        def login(self, **kw):
            return True

        def logout(self):
            return True

        def usage(self):
            return types.SimpleNamespace(bytes=1e6, limit_bytes=5e8, remaining_bytes=4.99e8)

        def snapshots(self, cs):
            codes = [c.code for c in cs]
            if idx_raise and any(c.startswith('IDX_') for c in codes):
                raise RuntimeError('index snapshot not supported')
            return [snaps_map.get(c.code, Snap(50.0, 1.0)) for c in cs]
    return Api()


def run(premarket=False, **kw):
    api = make_api(**kw)
    fake = types.ModuleType('shioaji')
    fake.Shioaji = lambda: api
    sys.modules['shioaji'] = fake
    M = importlib.import_module('live_snapshot_miner')
    M = importlib.reload(M)
    if os.environ.get('INJECT') == 'nocall':
        M._fetch_spot_index = lambda api: {}
    M._is_premarket = lambda: premarket
    os.environ['SHIOAJI_API_KEY'] = 'k'
    os.environ['SHIOAJI_SECRET_KEY'] = 's'
    cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as d:
        os.chdir(d)
        try:
            M.main()
            out = {}
            for f in ('live_quotes.json', 'live_index.json'):
                if os.path.exists(f):
                    out[f] = json.load(open(f, encoding='utf-8'))
            return out
        finally:
            os.chdir(cwd)


o = run(index_style='15')
q = o.get('live_quotes.json') or {}
idx = q.get('idx') or {}
ok('① ⭐ 一般模式(1.5 代碼)→ idx 有 twii / twoii', idx.get('twii') == {'p': 41700.0, 'c': 5.03} and idx.get('twoii') == {'p': 318.5, 'c': 4.76}, idx)
ok('① 台指期照舊在、股票 400 檔(指數 ⛔ 混進 data)', 'txf' in idx and len(q.get('data') or {}) == 400 and 'IDX_TWII' not in (q.get('data') or {}), len(q.get('data') or {}))
idx2 = ((run(index_style='17').get('live_quotes.json') or {}).get('idx') or {})
ok('② 1.7 代碼 IX0001 / IX0043 也找得到', 'twii' in idx2 and 'twoii' in idx2, idx2)
idx3 = ((run(index_style='attr').get('live_quotes.json') or {}).get('idx') or {})
ok('③ 只有屬性 TSE001 / OTC101 也找得到', 'twii' in idx3 and 'twoii' in idx3, idx3)
o4 = run(index_style='15', idx_raise=True)
q4 = o4.get('live_quotes.json') or {}
ok('④ 指數 snapshots 丟例外 → 照常產出、沒有 twii、股票與台指期都在', bool(q4) and 'twii' not in (q4.get('idx') or {}) and 'txf' in (q4.get('idx') or {}) and len(q4.get('data') or {}) == 400, (q4.get('idx'), len(q4.get('data') or {})))
o5 = run(index_style='15', no_indexs=True)
q5 = o5.get('live_quotes.json') or {}
ok('⑤ 沒有 Indexs 這一層 → 照常產出、沒有 twii', bool(q5) and 'twii' not in (q5.get('idx') or {}) and len(q5.get('data') or {}) == 400, q5.get('idx'))
o6 = run(premarket=True, index_style='15')
li = o6.get('live_index.json') or {}
ok('⑥ 盤前模式 → live_index.json 有台指期、⛔ 有 twii(現貨還沒開)、⛔ 寫 live_quotes.json', 'txf' in (li.get('idx') or {}) and 'twii' not in (li.get('idx') or {}) and 'live_quotes.json' not in o6, (li.get('idx'), list(o6)))

print(f"\n{'❌ ' + str(len(FAILS)) + ' 條失敗 ' + json.dumps(FAILS, ensure_ascii=False) if FAILS else '✅ test_live_spot_idx 全過'}")
sys.exit(1 if FAILS else 0)
