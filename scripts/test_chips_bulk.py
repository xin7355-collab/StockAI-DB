#!/usr/bin/env python3
"""_fetch_chips_bulk 單元測試(不打網路,全用假回應)。

驗六件事:
  ① 正常全市場 → 正確分桶、日期數對、欄位保留
  ② 第一天就失敗(帳號不支援省略 data_id)→ 立刻回 None,只浪費 1 次呼叫
  ③ 回傳只有少數股票(不是真全市場)→ 回 None,不誤用
  ④ 欄位不是分點(污染)→ 回 None
  ⑤ 中間有非交易日回空 → 跳過續抓,不整份放棄
  ⑥ 單日單股超過 top_per_day 家分點 → 只留淨額最大的前 N 家
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('SKIP_GLOBAL', '1')
sys.path.insert(0, '/home/user/StockAI-DB')
import miner

calls = []


def mk_rows(syms, d, brokers=3):
    out = []
    for s in syms:
        for b in range(brokers):
            out.append({'date': d, 'stock_id': s, 'securities_trader_id': f'{1000+b}',
                        'securities_trader': f'券商{b}', 'buy': 100 * (b + 1), 'sell': 10, 'price': 50.0})
    return out


def patch(fn):
    miner.fm_paid_get = fn
    calls.clear()


SYMS = [f'{2000+i}' for i in range(300)]

# ① 正常
def fake_ok(ep, params, timeout=15):
    calls.append(params)
    d = params.split('date=')[1]
    if d.endswith('-26') or d.endswith('-25'):      # 假日回空
        return {'status': 200, 'data': []}
    return {'status': 200, 'data': mk_rows(SYMS, d)}

patch(fake_ok)
dates = [f'2026-07-{d:02d}' for d in range(29, 13, -1)]
idx = miner._fetch_chips_bulk(dates, need_days=11)
assert idx is not None, '① 應該成功'
assert len(idx) == 300, f'① 股票數 {len(idx)}'
ds = sorted({r['date'] for r in idx['2000']})
assert len(ds) == 11, f'① 日期數 {len(ds)}'
assert len(calls) == 13, f'① 呼叫次數應為 11 交易日 + 2 假日 = 13,實際 {len(calls)}'
assert all('data_id' not in c for c in calls), '① 不可帶 data_id'
print(f'✅ ① 正常全市場:{len(idx)} 檔 × {len(ds)} 日,共 {len(calls)} 次呼叫')

# ② 第一天就失敗 → 立刻放棄
patch(lambda ep, params, timeout=15: (calls.append(params), {'status': 402, 'msg': 'need sponsor'})[1])
assert miner._fetch_chips_bulk(dates, need_days=11) is None, '② 應回 None'
assert len(calls) == 1, f'② 只該浪費 1 次呼叫,實際 {len(calls)}'
print('✅ ② 帳號不支援 → 立刻退回逐檔,只花 1 次呼叫')

# ③ 不是全市場(只回 5 檔)
patch(lambda ep, params, timeout=15: (calls.append(params),
      {'status': 200, 'data': mk_rows(SYMS[:5], params.split('date=')[1])})[1])
assert miner._fetch_chips_bulk(dates, need_days=11) is None, '③ 應回 None'
print('✅ ③ 回傳股票數不足 → 判定不是全市場,不誤用')

# ④ 欄位污染
patch(lambda ep, params, timeout=15: {'status': 200, 'data': [{'date': '2026-07-28', 'stock_id': '2330',
      'amount': '18,232,856', 'foo': 1}]})
assert miner._fetch_chips_bulk(dates, need_days=11) is None, '④ 應回 None'
print('✅ ④ 欄位不是分點 → 拒收,不污染 chips')

# ⑤ 中途空日不中斷(①已含,再單獨確認一次日期正確性)
patch(fake_ok)
idx = miner._fetch_chips_bulk(dates, need_days=3)
assert sorted({r['date'] for r in idx['2000']}) == ['2026-07-27', '2026-07-28', '2026-07-29'], '⑤ 日期不對'
print('✅ ⑤ 中間非交易日回空 → 跳過續抓,取到最近 3 個交易日')

# ⑥ top_per_day 截斷:單股單日 60 家分點 → 只留 25 家,且留下的是淨額最大的
def fake_many(ep, params, timeout=15):
    d = params.split('date=')[1]
    rows = []
    for s in SYMS:
        for b in range(60):
            rows.append({'date': d, 'stock_id': s, 'securities_trader_id': f'{1000+b}',
                         'securities_trader': f'券商{b}', 'buy': b * 10, 'sell': 0, 'price': 50.0})
    return {'status': 200, 'data': rows}

patch(fake_many)
idx = miner._fetch_chips_bulk([dates[0]], need_days=1, top_per_day=25)
one = idx['2000']
assert len(one) == 25, f'⑥ 應留 25 家,實際 {len(one)}'
nets = sorted(int(r['buy']) - int(r['sell']) for r in one)
assert nets[0] == 350 and nets[-1] == 590, f'⑥ 留下的不是淨額最大的 25 家:{nets[:3]}…{nets[-3:]}'
print('✅ ⑥ 單日單股超量 → 只留淨額最大的 25 家(記憶體有上限)')

print('\n🎉 _fetch_chips_bulk 六項測試全過')
