#!/usr/bin/env python3
"""🗓️ V79.5.2 主動式 ETF 換股紀錄「同一天第二輪被洗掉」守門(不打網路)。

🚨 實測(2026-10-22 查 gh-pages 的 etf_tracking.json):10/20 換股紀錄全空、10/21 只剩 1 筆。
   真因:每一輪都拿「上一輪存的持股」當基準,而 daily_miner 一天常跑 2 輪以上
   → 第二輪 = 拿今天比今天 → 一定是空的 → `_push_chg` 先刪掉當天那筆、空的又不寫回去
   → 今天的換股紀錄 / 今天的 changes / 經理人動向被洗掉,換股頻率一天還衰減兩次。

驗 `_etf_day_step`(主流程每一檔都走它)+ `_push_chg`:
  ① 同一天跑兩次 → 第二輪的換股 == 第一輪(都跟前一個交易日最後那份比),紀錄還在
  ② 隔天照常比:基準換成前一天最後那份
  ③ 換股頻率一天只衰減一次
  ④ 抓不到持股 → 什麼都不動(持股 / 日期 / 紀錄 / 頻率都沿用)
  ⑤ 舊格式(沒有 hold_d)但整份檔是今天的 → 照上一輪結果留著(⛔ 不重算成空的)
  ⑥ `_push_chg` 本身:同一天有換股的紀錄 ⛔ 不可被空的蓋掉
  ⑦ 決定性對照:拿「今天前一輪」當基準(舊寫法)→ 一定是空的
  ⑧ 接線:main 每一檔都走 `_etf_day_step`,而且把 hold_d / base_all / base_d / turnover_base 存起來
"""
import inspect
import os
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('SKIP_GLOBAL', '1')
for _m in ('yfinance',):
    if _m not in sys.modules:
        _s = types.ModuleType(_m)
        _s.Ticker = lambda *a, **k: None
        sys.modules[_m] = _s

import etf_miner as em

fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:300]}'))
    if not cond:
        fails.append(name)


def H(*pairs):
    return [{'sym': s, 'weight': w} for s, w in pairs]


def entry(st, prev_e=None):
    """把 `_etf_day_step` 的結果組成主流程會存的那一筆(只取相關欄位)。"""
    return {'symbol': '00981A', 'hold_all': [{'sym': h['sym'], 'weight': h['weight']} for h in st['hold']],
            'hold_d': st['hold_d'], 'base_all': st['base_all'], 'base_d': st['base_d'],
            'turnover_base': st['turnover_base'], 'turnover_score': st['turnover'],
            'changes': st['changes'], 'changed_today': st['changed'], 'chg_hist': st['chg_hist']}


D0, D1, D2 = '2026-10-20', '2026-10-21', '2026-10-22'
H0 = H(('2330', 10.0), ('2317', 5.0), ('2454', 4.0))                       # 10/20 最後那份
H1 = H(('2330', 10.5), ('2454', 4.0), ('3231', 3.0))                       # 10/21:換入 3231、換出 2317、2330 +0.5
H2 = H(('2330', 10.5), ('2454', 3.0), ('3231', 3.0), ('6669', 2.0))        # 10/22:換入 6669、2454 −1.0

# 前一天(10/20)最後那一輪存下來的(新格式)
e0 = {'symbol': '00981A', 'hold_all': H0, 'hold_d': D0, 'base_all': None, 'base_d': None,
      'turnover_base': 1.0, 'turnover_score': 2.0, 'changes': dict(em.EMPTY_CHANGES), 'changed_today': False,
      'chg_hist': [{'d': '2026-10-15', 'a': ['1101'], 'r': [], 'u': [], 'w': []}]}

# ── ① 同一天跑兩次 ──────────────────────────────────────────────
r1 = em._etf_day_step(e0, D0, D1, H1)
ok('① 空過守門:第一輪抓到換股(換入 3231、換出 2317)',
   [h['sym'] for h in r1['changes']['added']] == ['3231'] and [h['sym'] for h in r1['changes']['removed']] == ['2317'],
   r1['changes'])
ok('①b 第一輪把基準(前一天最後那份)存下來', r1['base_all'] == H0 and r1['base_d'] == D0 and r1['hold_d'] == D1)
e1 = entry(r1)
r1b = em._etf_day_step(e1, D1, D1, H1)                                # 同一天第二輪,持股沒變
ok('①c ⭐ 同一天第二輪:換股 == 第一輪(⛔ 不可變成空的)',
   r1b['changes'] == r1['changes'] and r1b['changed'] is True, r1b['changes'])
ok('①d 同一天第二輪:今天那筆換股紀錄還在', any(x['d'] == D1 and x['a'] == ['3231'] for x in r1b['chg_hist']), r1b['chg_hist'])
ok('①e 第三輪也一樣(基準一路帶著走)',
   em._etf_day_step(entry(r1b), D1, D1, H1)['changes'] == r1['changes'])

# ①f ⭐ 同一天兩輪看到的持股不一樣(第一輪的持股表只更新了一半,晚上那輪才完整)
#   → 第二輪要跟「前一天最後那份」比 = 完整的一天;⛔ 拿第一輪比只會剩「後半段」(換入 3231 那筆會不見)
H1a = H(('2330', 10.5), ('2317', 5.0), ('2454', 4.0), ('3231', 3.0))        # 第一輪:只看到換入 3231
ra = em._etf_day_step(e0, D0, D1, H1a)
rb = em._etf_day_step(entry(ra), D1, D1, H1)                               # 第二輪:2317 也換出了
ok('①f ⭐ 同一天第二輪看到更完整的持股 → 換入 3231 + 換出 2317 都要在(⛔ 不可只剩後半段)',
   [h['sym'] for h in rb['changes']['added']] == ['3231'] and [h['sym'] for h in rb['changes']['removed']] == ['2317']
   and any(x['d'] == D1 and x['a'] == ['3231'] and x['r'] == ['2317'] for x in rb['chg_hist']), [rb['changes'], rb['chg_hist']])

# ── ② 隔天照常比 ────────────────────────────────────────────────
r2 = em._etf_day_step(entry(r1b), D1, D2, H2)
ok('② 隔天的基準換成前一天(10/21)最後那份 → 只看到 10/22 的換股',
   [h['sym'] for h in r2['changes']['added']] == ['6669'] and not r2['changes']['removed']
   and r2['base_d'] == D1 and r2['base_all'] == entry(r1b)['hold_all'], r2['changes'])
ok('②b 歷史:10/15、10/21、10/22 三筆都在', [x['d'] for x in r2['chg_hist']] == ['2026-10-15', D1, D2], r2['chg_hist'])

# ── ③ 換股頻率一天只衰減一次 ─────────────────────────────────────
ok('③ 第一輪:2.0 × 0.9 + 1 = 2.8', r1['turnover'] == 2.8 and r1['turnover_base'] == 2.0, r1['turnover'])
ok('③b 同一天第二輪:仍是 2.8(⛔ 不可再衰減一次變 3.52)', r1b['turnover'] == 2.8 and r1b['turnover_base'] == 2.0, r1b['turnover'])
ok('③c 隔天:2.8 × 0.9 + 1 = 3.52', r2['turnover'] == 3.52, r2['turnover'])

# ── ④ 抓不到持股 ─────────────────────────────────────────────────
r4 = em._etf_day_step(entry(r1), D1, D1, [])
ok('④ 同一天抓不到:持股 / 日期 / 換股 / 紀錄 / 頻率全部沿用',
   r4['hold'] == entry(r1)['hold_all'] and r4['hold_d'] == D1 and r4['changes'] == r1['changes']
   and r4['chg_hist'] == r1['chg_hist'] and r4['turnover'] == 2.8 and r4['got'] == 0, r4)
r4b = em._etf_day_step(entry(r1), D1, D2, [])
ok('④b 隔天抓不到:持股日期留在 10/21(⛔ 不可冒充 10/22)、換股空、頻率不衰減',
   r4b['hold_d'] == D1 and em._chg_empty(r4b['changes']) and r4b['turnover'] == 2.8, r4b)
r4c = em._etf_day_step(entry(r4b), D2, D2, H2)
ok('④c 同一天稍後抓到了 → 跟 10/21 那份比(⛔ 不可因為整份檔是今天的就不比)',
   [h['sym'] for h in r4c['changes']['added']] == ['6669'] and r4c['turnover'] == 3.52, r4c['changes'])

# ── ⑤ 舊格式(沒有 hold_d)────────────────────────────────────────
legacy = {'symbol': '00981A', 'hold_all': H1, 'turnover_score': 2.8, 'changes': r1['changes'],
          'changed_today': True, 'chg_hist': r1['chg_hist']}
r5 = em._etf_day_step(legacy, D1, D1, H1)                             # 整份檔是今天的 → 今天第二輪
ok('⑤ 舊格式 + 整份檔是今天的 → 換股 / 紀錄 / 頻率照上一輪(⛔ 不重算成空的)',
   r5['changes'] == r1['changes'] and r5['changed'] is True and r5['chg_hist'] == r1['chg_hist']
   and r5['turnover'] == 2.8 and r5['hold_d'] == D1, r5)
r5b = em._etf_day_step(legacy, D1, D2, H2)                            # 舊格式 + 別天 → 照常跟它比
ok('⑤b 舊格式 + 整份檔是前一天的 → 照常跟它比', [h['sym'] for h in r5b['changes']['added']] == ['6669'], r5b['changes'])
r5c = em._etf_day_step({'symbol': '00981A', 'holdings': H1[:2]}, D1, D2, H2)
ok('⑤c 更舊的格式(只存前 15 大)→ 重建基準、不算換股(⛔ 不可每天亂標換入)',
   em._chg_empty(r5c['changes']) and r5c['base_all'] is None, r5c)
r5d = em._etf_day_step(None, None, D2, H2)
ok('⑤d 第一次見到這一檔 → 建立基準、不算換股', em._chg_empty(r5d['changes']) and r5d['got'] == 1)

# ── ⑥ _push_chg 本身 ──────────────────────────────────────────────
_h = [{'d': D1, 'a': ['3231'], 'r': ['2317'], 'u': [], 'w': []}]
ok('⑥ 同一天有換股的紀錄 ⛔ 不可被空的蓋掉', em._push_chg(_h, D1, dict(em.EMPTY_CHANGES)) == _h)
ok('⑥b 同一天新的有換股 → 換成新的那筆',
   em._push_chg(_h, D1, {'added': [{'sym': '6669'}], 'removed': [], 'weight_up': [], 'weight_down': []})
   == [{'d': D1, 'a': ['6669'], 'r': [], 'u': [], 'w': []}])
ok('⑥c 同一天只留一筆(⛔ 不累加)', len(em._push_chg(_h, D1, {'added': [{'sym': '6669'}], 'removed': [],
                                                          'weight_up': [], 'weight_down': []})) == 1)

# ── ⑦ ⭐ 決定性對照:舊寫法(拿今天前一輪當基準)→ 一定是空的 ──────────
_old = em.diff_holdings(entry(r1)['hold_all'], H1)
ok('⑦ 決定性對照:今天比今天 → 空的(這就是 10/20、10/21 被洗掉的原因)', em._chg_empty(_old), _old)
ok('⑦b 同一份資料,新寫法比的是前一天最後那份 → 有換股', not em._chg_empty(r1b['changes']))

# ── ⑧ 接線 ───────────────────────────────────────────────────────
_src = inspect.getsource(em.main)
ok('⑧ main 每一檔都走 `_etf_day_step`', '_etf_day_step(prev_ent.get(s), prev_updated, today, curr_h)' in _src)
for k in ('"hold_d": _st["hold_d"]', '"base_all": _st["base_all"]', '"base_d": _st["base_d"]',
          '"turnover_base": _st["turnover_base"]', '"chg_hist": _st["chg_hist"]', 'turnover_score = _st["turnover"]'):
    ok(f'⑧b 存起來:{k}', k in _src)
ok('⑧c ⛔ 不可再拿「上一輪持股」直接當基準(舊的 prev_hold 那條路)', 'prev_hold' not in _src and 'diff_holdings(prev_h' not in _src)

# ── ⑨ 🏷️ V80.1.7 被動 ETF 成分進出(pbase / pchg)────────────────────────
P0 = H(('2330', 57.0), ('2317', 10.0), ('3661', 3.0), ('202612F', 0.5), ('2454', 29.5))   # 有一列期貨
P1 = H(('2330', 57.0), ('2317', 10.0), ('6446', 3.0), ('202612F', 0.5), ('2454', 29.5))   # 6446 換進、3661 換出
ok('⑨ 成分只收股票代號(⛔ 期貨那列)、照代號排好', em._passive_syms(P0) == ['2317', '2330', '2454', '3661'], em._passive_syms(P0))
ok('⑨b 權重合計 < 90% = 只抓到一部分 → 當成沒抓到(⛔ 誤判成一堆剔除)', em._passive_syms(P0[:2]) is None)
pb0, c0 = em._passive_step(None, D0, em._passive_syms(P0))
ok('⑨c 第一次:只建基準、不算進出', c0 is None and pb0 == {'d': D0, 's': ['2317', '2330', '2454', '3661'], 'bd': None, 'bs': None}, [pb0, c0])
pb1, c1 = em._passive_step(pb0, D1, em._passive_syms(P1))
ok('⑨d 隔天:跟前一天那份比 → 進 6446、出 3661', c1 == {'a': ['6446'], 'r': ['3661']} and pb1['bd'] == D0, [pb1, c1])
pb1b, c1b = em._passive_step(pb1, D1, em._passive_syms(P1))
ok('⑨e ⭐ 同一天第二輪:還是跟前一天比(⛔ 拿今天比今天 → 空的)', c1b == c1 and pb1b['bd'] == D0 and pb1b['bs'] == pb0['s'], [pb1b, c1b])
_old_p = sorted(set(pb1['s']) ^ set(em._passive_syms(P1)))
ok('⑨f 決定性對照:舊寫法(拿今天前一輪當基準)→ 空的', _old_p == [], _old_p)
pb1c, c1c = em._passive_step(pb1, D1, None)
ok('⑨g 抓不到 → 基準與日期都不動', pb1c == pb1 and c1c is None)
pb2, c2 = em._passive_step(pb1b, D2, em._passive_syms(P1))
ok('⑨h 再隔天沒變 → 進出是空的、基準換成 10/21', c2 == {'a': [], 'r': []} and pb2['bd'] == D1, [pb2, c2])
_pc = em._push_pchg([], D1, '0050', D0, c1, 4)
ok('⑨i 有進出 → 記一筆(日期 / 哪一檔 / 基準日 / 進 / 出 / 檔數)',
   _pc == [{'d': D1, 'e': '0050', 'bd': D0, 'a': ['6446'], 'r': ['3661'], 'n': 4}], _pc)
ok('⑨j 同一天後面那輪空的 ⛔ 不可蓋掉', em._push_pchg(_pc, D1, '0050', D0, {'a': [], 'r': []}, 4) == _pc)
ok('⑨k 同一天同一檔只留一筆', len(em._push_pchg(_pc, D1, '0050', D0, c1, 4)) == 1)
ok('⑨l 別檔 / 別天照加', len(em._push_pchg(_pc, D1, '0056', D0, c1, 4)) == 2 and len(em._push_pchg(_pc, D2, '0050', D1, c1, 4)) == 2)
ok('⑨m 只追被動式(⛔ 美股那兩檔 / 主動式)', '0050' in em.PASSIVE_TRACK and '00878' in em.PASSIVE_TRACK
   and '00757' not in em.PASSIVE_TRACK and not any(s.endswith('A') for s in em.PASSIVE_TRACK))
for k in ('_passive_step(_prev_pb.get(cs), today, _ps)', '"pbase": pbase', '"pchg": pchg', 'pbase = dict(_prev_pb)'):
    ok(f'⑨n 接線:{k}', k in _src)

# ── ⑨o ⭐ 走正式入口 main()(假網路、暫存資料夾、假時鐘)三天 ────────────────
import json
import tempfile
from datetime import datetime as _RealDT


class _FakeDT(_RealDT):
    _now = None

    @classmethod
    def now(cls, tz=None):
        return cls._now


_tmp = Path(tempfile.mkdtemp(prefix='etfp-'))
_saved = {k: getattr(em, k) for k in ('OUT', 'DATA_DIR', 'datetime', 'list_active_etfs', '_discover_active_etfs',
                                      'fetch_etf_detail', 'load_prices', 'perf_with_tr', 'dividend_fill_metrics',
                                      'fetch_etf_premium', 'PIN_ETFS')}
_feed = {}
try:
    em.OUT, em.DATA_DIR, em.datetime = _tmp / 'etf_tracking.json', str(_tmp), _FakeDT
    em.list_active_etfs = lambda: []
    em._discover_active_etfs = lambda: []
    em.PIN_ETFS = []
    em.load_prices = lambda s: []
    em.perf_with_tr = lambda s, r: None
    em.dividend_fill_metrics = lambda *a, **k: None
    em.fetch_etf_premium = lambda: {}
    em.fetch_etf_detail = lambda s: ('元大台灣50', [dict(h) for h in _feed.get(s, [])], None, None)

    def _day(d, holds):
        _FakeDT._now = _RealDT.fromisoformat(d + 'T18:00:00')
        _feed.clear()
        _feed['0050'] = holds
        rc = em.main()
        return rc, json.loads((_tmp / 'etf_tracking.json').read_text(encoding='utf-8'))

    rc0, j0 = _day(D0, P0)
    ok('⑨o 第一天跑得起來、建好基準、還沒有進出', rc0 in (0, None) and j0['pbase']['0050']['s'] == ['2317', '2330', '2454', '3661']
       and j0['pchg'] == [], [rc0, j0.get('pbase'), j0.get('pchg')])
    rc1, j1 = _day(D1, P1)
    ok('⑨o2 隔天換成分 → pchg 記到 0050 進 6446、出 3661(跟 10/20 比)',
       j1['pchg'] == [{'d': D1, 'e': '0050', 'bd': D0, 'a': ['6446'], 'r': ['3661'], 'n': 4}], j1.get('pchg'))
    rc1b, j1b = _day(D1, P1)
    ok('⑨o3 ⭐ 同一天再跑一輪 → 那一筆還在、沒有重複', j1b['pchg'] == j1['pchg'], j1b.get('pchg'))
    rc2, j2 = _day(D2, P1[:2])
    ok('⑨o4 抓不全那天 → 基準照留 10/21、紀錄不動', j2['pbase']['0050']['d'] == D1 and j2['pchg'] == j1['pchg'],
       [j2['pbase'].get('0050'), j2.get('pchg')])
finally:
    for k, v in _saved.items():
        setattr(em, k, v)

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ ETF_CHG_PASS(全部通過)')
sys.exit(1 if fails else 0)
