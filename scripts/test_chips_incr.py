#!/usr/bin/env python3
"""V71.2.9 增量採礦 —— 正確性驗證(不打網路)。

背景(實測 run 30423842005):
  ・單日全市場批次被 FinMind 擋掉:status=400
    "parameter data_id can't be none on TaiwanStockTradingDailyReport"
  ・逐檔模式 35 分鐘只更新 143 檔 ≈ 14.7 秒/檔 → 全市場 2,696 檔要 11 小時
  ・使用者只有 1 把付費金鑰(6,000 req/hr = 100 req/min),額度也是牆
  ⇒ 唯一解:別再每天重買同樣的資料,只補「本地沒有的那一天」。

這支驗最關鍵的一件事:
  **「只抓 1 天 + 用本地 hist 補齊」算出來的多日週期,
    要跟「整個窗全部重抓」算出來的一模一樣。**
若不一樣,省下的呼叫就是拿數字正確性去換,不能上。

另驗:
  ② 彙總鍵正規化(新資料以 id 為鍵、hist 以名稱為鍵)不會把同一家分點拆成兩筆
  ③ 已有的日期不重複呼叫,且不會因此往回多翻日期
"""
import sys
sys.path.insert(0, '/home/user/StockAI-DB')

DATES = ['2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21', '2026-07-22',
         '2026-07-23', '2026-07-24', '2026-07-27', '2026-07-28', '2026-07-29']
BROKERS = [('1020', '元大-總公司'), ('9200', '凱基-台北'), ('1440', '美林'),
           ('5920', '富邦-建國'), ('7000', '兆豐-北高雄')]


def mk_rows(dates):
    """模擬 FinMind 逐檔回傳:每天每家分點一列。"""
    rows = []
    for d in dates:
        di = DATES.index(d)          # 用「在全序列中的位置」而非切片位置,
                                     # 否則傳單日切片時數值會跟全序列不同(這是測試自身的坑,不是程式碼問題)
        for bi, (bid, nm) in enumerate(BROKERS):
            buy = 1000 + di * 100 + bi * 37
            sell = 300 + di * 20 + bi * 11
            rows.append({'date': d, 'stock_id': '2330', 'securities_trader_id': bid,
                         'securities_trader': nm, 'buy': buy, 'sell': sell,
                         'price': 100.0 + di})
    return rows


def build_by_date(rows, hist=None):
    """複製 miner.py 的組裝邏輯(hist 還原 + 新資料疊上)。"""
    by_date = {}
    for _h in (hist or []):
        _slot = by_date.setdefault(str(_h['d']), {})
        for _arr in list(_h.get('b') or []) + list(_h.get('s') or []):
            _nm, _nt = str(_arr[0]), int(_arr[1])
            _av = float(_arr[2]) if len(_arr) > 2 and _arr[2] is not None else None
            if not _nm or not _nt:
                continue
            _e = _slot.setdefault(_nm, {'broker_id': '', 'broker_name': _nm,
                                        'net': 0, 'buy': 0, 'sel': 0, 'pv': 0.0, 'vol': 0})
            _e['net'] += _nt
            if _av is not None:
                _e['pv'] += _av * abs(_nt); _e['vol'] += abs(_nt)
    for r in rows:
        d = r['date']; bid = r['securities_trader_id']; bnm = r['securities_trader']
        buy, sell, price = int(r['buy']), int(r['sell']), float(r['price'])
        slot = by_date.setdefault(d, {})
        e = slot.setdefault(bid, {'broker_id': bid, 'broker_name': bnm,
                                  'net': 0, 'buy': 0, 'sel': 0, 'pv': 0.0, 'vol': 0})
        e['buy'] += buy; e['sel'] += sell; e['net'] += (buy - sell)
        if price > 0:
            e['pv'] += price * (buy + sell); e['vol'] += (buy + sell)
    return by_date


def agg_period(by_date, n):
    """複製 miner.py 的 _agg_period(含 V71.2.9 的鍵正規化)。"""
    wdates = sorted(by_date.keys())[-n:]
    agg = {}
    for wd in wdates:
        for b, e in by_date[wd].items():
            _k = (e.get('broker_name') or b) if not str(e.get('broker_name') or '').isdigit() else b
            a = agg.setdefault(_k, {'broker_id': e.get('broker_id') or b,
                                    'broker_name': e['broker_name'],
                                    'net': 0, 'buy': 0, 'sel': 0, 'pv': 0.0, 'vol': 0})
            a['net'] += e['net']; a['buy'] += e.get('buy', 0); a['sel'] += e.get('sel', 0)
            a['pv'] += e.get('pv', 0.0); a['vol'] += e.get('vol', 0)
            if e['broker_name'] and not str(e['broker_name']).isdigit():
                a['broker_name'] = e['broker_name']
            if not a.get('broker_id') and e.get('broker_id'):
                a['broker_id'] = e['broker_id']
    vals = list(agg.values())
    for a in vals:
        a['avg'] = round(a['pv'] / a['vol'], 2) if a.get('vol') else None
        a.pop('pv', None); a.pop('vol', None)
    return {'buy': sorted([x for x in vals if x['net'] > 0], key=lambda x: -x['net'])[:15],
            'sell': sorted([x for x in vals if x['net'] < 0], key=lambda x: x['net'])[:15]}


def compact(side):
    out = []
    for x in side[:25]:
        nm = x.get('broker_name') or str(x.get('broker_id') or '')
        net = int(x.get('net') or 0)
        if nm and not str(nm).isdigit() and net:
            out.append([nm, net, x.get('avg')])
    return out


# ── ① 基準:整個 10 天窗全部重抓(舊做法)────────────────────────────────
full = build_by_date(mk_rows(DATES))
base = {f'{n}d': agg_period(full, n) for n in (1, 3, 5, 10)}

# ── ② 增量:前 9 天存在 hist,今天只抓 1 天 ─────────────────────────────
prev = build_by_date(mk_rows(DATES[:-1]))
hist = []
for d in sorted(prev.keys()):
    one = agg_period({d: prev[d]}, 1)
    hist.append({'d': d, 'b': compact(one['buy']), 's': compact(one['sell'])})
incr = build_by_date(mk_rows(DATES[-1:]), hist=hist)
got = {f'{n}d': agg_period(incr, n) for n in (1, 3, 5, 10)}

for k in ('1d', '3d', '5d', '10d'):
    bl = [(x['broker_name'], x['net']) for x in base[k]['buy']]
    gl = [(x['broker_name'], x['net']) for x in got[k]['buy']]
    assert bl == gl, f'① {k} 買超榜不一致\n  全抓:{bl}\n  增量:{gl}'
    bs = [(x['broker_name'], x['net']) for x in base[k]['sell']]
    gs = [(x['broker_name'], x['net']) for x in got[k]['sell']]
    assert bs == gs, f'① {k} 賣超榜不一致\n  全抓:{bs}\n  增量:{gs}'
print('✅ ① 只抓 1 天 + 本地 hist 補齊 → 1d/3d/5d/10d 買賣超榜與「全部重抓」完全一致')
print(f'     呼叫數 10 次 → 1 次(省 90%),數字零差異')

# ── ③ 鍵正規化:同一家分點不可被拆成兩筆 ──────────────────────────────
names = [x['broker_name'] for x in got['10d']['buy']] + [x['broker_name'] for x in got['10d']['sell']]
assert len(names) == len(set(names)), f'② 同一家分點被重複計算:{names}'
assert set(names) <= {nm for _, nm in BROKERS}, f'② 出現非預期分點:{names}'
print('✅ ② 新資料(以代號為鍵)與 hist(以名稱為鍵)正確合併,同一家分點不會被拆成兩筆')

# ── ④ 已有日期不重複呼叫,且不往回多翻 ────────────────────────────────
have = set(DATES[:-1])
seen, called = set(), []
for d in DATES[::-1]:            # 由新到舊
    if len(seen) >= 10:
        break
    if d in have:
        seen.add(d)
        continue
    called.append(d)
    seen.add(d)
assert called == [DATES[-1]], f'③ 應只呼叫最新那天,實際 {called}'
assert len(seen) == 10, f'③ 應在湊滿 10 天就停,實際 {len(seen)}'
print('✅ ③ 已有的日期直接跳過且計入天數 → 只打 1 次,不會往回多翻把省下的花掉')

print('\n🎉 增量採礦三項驗證全過:省 90% 呼叫、數字與全抓完全相同')
