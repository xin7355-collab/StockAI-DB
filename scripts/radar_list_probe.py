#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📋 選股頁剩下的榜 16 年實測 —— 只讀資料,不打網路、不寫產物。

❓ 使用者(2026-10-26):「策略有沒有要更換最厲害的那幾種」→「如果都沒有用就刪除策略」
   選股頁還在的 5 排(🏎️ 渣男賽車 / 🚀 相對強度 / 🌅 K棒轉多 / 🐲 妖股雷達 / 🌃 K棒轉空)
   + 「朱家泓選股法」8 個分頁,從來沒有整排回測過,畫面只寫「⚠️ 只當觀察」。

⭐ 名單規則一律呼叫採礦端原本那幾支(⛔ 第二份):
   ・radar_miner.scan_one(sym, 到今天為止的 K 線, 大盤 20 日報酬, 處置名單, want, fast)
     = radar_miner.main 每一檔做的事(main 自己也呼叫它)
   ・miner.monster_pick(sym, raw, ind) = miner.build_radar_cache 的妖股那段
   每天照採礦端**同一個排序、同一個前 N 名**才算「上榜」(radar_matrix 的切法:渣男賽車 20、
   相對強度 30、K 棒 30、六六大順 20、特別報價 30、底部轉折 20、5MA 飆股 20、回後買上漲 / 葛蘭碧 /
   橫盤突破 / 背離 30;妖股不切)。

📐 量法(跟 screener_edge_probe 同一把尺,骨架直接 import 它):
   ・進場 = 隔天開盤(一價到底鎖漲停 → 買不到;2015-06 前 ±7%)
   ・持有窗口碰到價格斷崖 → 那一筆不算
   ・超額 = 那一筆 − **同一天**所有可交易股票(成交額 ≥1,000 萬、不含 ETF)的平均(陷阱 #50)
   ・同一檔同一榜 20 個交易日內只算一次(⛔ 相鄰窗口重疊灌水)
   ・報 5 / 10 / 20 天,判定只看 20 天(先講好,⛔ 挑最好看的天期)
   ・六關:全期 > 0 ・前後半都 > 0 ・逐年都 > 0(≥5 年)・去最好年 > 0 ・扣成本 0.44% 還 > 0
   ・🌃 K棒轉空(找賣點的榜)反過來:全期、前後半、去最差年都 < 0 才算「有用的風險提醒」
   ・🏎️ 渣男賽車 / 🐲 妖股另報「大盤站在 5 日線上」那一半(App 在大盤跌破 5 日線時會把它們灰掉)

⚠️ 量不到的(寫進結果):處置 / 注意股濾網沒有逐日名單 → 不套;App 的「大盤風險分數 ≥50 也灰掉」算不回去。
   名單用最近 260 根算(採礦端用整條 K 線;只有 MACD / KD 這種遞迴指標差在小數點後很多位,selftest 釘住結果相同)。

🚧 空過守門:總事件數 < 3,000 → exit 1。`WORKERS=3`;`--selftest` 不需要資料。
"""
import heapq
import json
import os
import re
import sys
from collections import Counter, defaultdict
from multiprocessing import Pool
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'scripts'))
import lib_limit as LL  # noqa: E402
import radar_miner as RM  # noqa: E402
import miner as MN  # noqa: E402
import screener_edge_probe as SEP  # noqa: E402

DATA = Path(os.environ.get('DATA_DIR') or (ROOT / 'data'))
WARM = 260           # 最少要有這麼多根才開始算(底部轉折要 120 根,MACD / KD 遞迴要暖身)
WIN = 260            # 每天只餵最近 260 根給 scan_one(selftest 逐值比對整段)
HS = (5, 10, 20)
FWD = 20             # 判定天期
COST = SEP.COST
MIN_AMT = 0.1        # 對照組的可交易門檻(億)
MIN_CTRL = SEP.MIN_CTRL
WORKERS = max(1, int(os.environ.get('WORKERS', '3')))
SELFTEST = '--selftest' in sys.argv
SEP.ENTRY = 'open1'

# 每個榜:採礦端的排序鍵(大到小)與前 N 名(None = 不切)—— 照 radar_miner.main / miner.build_radar_cache
LISTS = {
    'momentum':       (lambda r: r['turnover_e'], 20, '🏎️ 渣男賽車'),
    'rs_strong':      (lambda r: r.get('rs', 0), 30, '🚀 相對強度'),
    'kbar_bull':      (lambda r: r['turnover_e'], 30, '🌅 K棒轉多'),
    'monster':        (lambda r: r.get('gain5d', 0), None, '🐲 妖股雷達'),
    'kbar_bear':      (lambda r: r['turnover_e'], 30, '🌃 K棒轉空'),
    'chu_perfect6':   (lambda r: (r.get('quality', 0), r['turnover_e']), 20, '🍀 六六大順'),
    'chu_top_gainer': (lambda r: (r.get('gain', 0), r.get('turnover_e', 0)), 30, '🔥 特別報價'),
    'chu_bottom':     (lambda r: r.get('gain', 0), 20, '🥣 底部轉折'),
    'chu_riding5ma':  (lambda r: r.get('cum_5d', 0), 20, '🚀 5MA飆股'),
    'chu_entry':      (lambda r: (r.get('grade') == 'high', not r.get('red_flags'), r.get('upside_room', 0), r.get('turnover_e', 0)), 30, '🎯 回後買上漲'),
    'chu_granville':  (lambda r: r.get('turnover_e', 0), 30, '📐 葛蘭碧'),
    'chu_box':        (lambda r: r.get('turnover_e', 0), 30, '📦 橫盤突破'),
    'chu_diverge':    (lambda r: r.get('turnover_e', 0), 30, '🔀 背離'),
}
RISK = {'kbar_bear'}                                   # 找賣點的榜(上榜之後要穩定比較差才算有用)
WANT = frozenset(k for k in LISTS if k != 'monster')   # monster 不在 radar_matrix,走 miner.monster_pick


def is_universe(sym):
    """跟 radar_miner.main / miner.build_radar_cache 同一條:4 碼數字或 00 開頭。"""
    return (len(sym) == 4 and sym.isdigit()) or sym.startswith('00')


def load_rows(p):
    try:
        rows = json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None
    rows = rows if isinstance(rows, list) else (rows.get('data') or [])
    return [r for r in rows if float(r.get('close') or 0) > 0]


def day_hits(sym, win, twr20):
    """這一檔「今天」(win 的最後一根)進了哪幾個榜 → {榜名: record}。win 只到今天為止(⛔ 前視)。"""
    out = {}
    if len(win) >= 22:
        h = RM.scan_one(sym, win, twr20, frozenset(), want=WANT, fast=True)
        if h:
            out.update(h)
        data = [{'close': r['close'], 'volume': r['volume']} for r in win[-25:]]
        ind = MN._quick_ind(data)
        if ind and ind['vma5'] >= 200_000:
            m = MN.monster_pick(sym, win, ind)
            if m:
                out['monster'] = m
    return out


def stock_cands(sym, rows, twc, twr20):
    """一檔的全部候選(純函式,selftest 直接測)。
    回 dict:base {日期: [Σ5, Σ10, Σ20, 檔數]}(同一天對照)/ c [(榜, 日期, 排序鍵, 超額(5,10,20) 或 None=買不到/斷崖, 標記)] / skip"""
    n = len(rows)
    ds = [str(r['date']).replace('/', '-') for r in rows]
    cl = [float(r['close']) for r in rows]
    op = [float(r.get('open') or r['close']) for r in rows]
    vol = [float(r.get('volume') or 0) for r in rows]
    pre = LL.cliff_prefix(cl, op)
    etf = sym.startswith('00')
    out = {'base': {}, 'c': [], 'skip': {'lock': 0, 'cliff': 0}}
    for i in range(WARM, n - FWD):
        d = ds[i]
        if d not in twc or any(ds[i + h] not in twc for h in HS):
            continue
        px = SEP.entry_px(rows, i, ds, cl)
        exs = None
        if px is not None and not LL.cliff_in(pre, i, i + FWD):
            exs = tuple((cl[i + h] / px - 1) * 100 - (twc[ds[i + h]] / twc[d] - 1) * 100 for h in HS)
        if not etf and exs is not None and cl[i] * vol[i] / 1e8 >= MIN_AMT:
            b = out['base'].setdefault(d, [0.0, 0.0, 0.0, 0])
            b[0] += exs[0]
            b[1] += exs[1]
            b[2] += exs[2]
            b[3] += 1
        hits = day_hits(sym, rows[max(0, i + 1 - WIN):i + 1], twr20.get(d))
        if not hits:
            continue
        if px is None:
            out['skip']['lock'] += 1
        elif exs is None:
            out['skip']['cliff'] += 1
        for k, rec in hits.items():
            tag = rec.get('side', '') if k == 'chu_diverge' else ''
            out['c'].append((k, d, LISTS[k][0](rec), exs, tag))
    return out


def _rank(key, sym):
    """前 N 名的比較鍵:排序鍵大的先;同分時代號小的先(採礦端同分是檔案順序,本來就不固定)。"""
    return (key, tuple(-ord(ch) for ch in sym))


def push_top(heaps, k, d, key, sym, exs, tag):
    """每一個(榜, 日期)只留前 N 名(N=None 全留)。"""
    n = LISTS[k][1]
    h = heaps.setdefault((k, d), [])
    item = (_rank(key, sym), sym, exs, tag)
    if n is None or len(h) < n:
        heapq.heappush(h, item)
    elif item[0] > h[0][0]:
        heapq.heapreplace(h, item)


def dedupe(entries, twi, gap=FWD):
    """entries = [(日期, 代號, 超額, 標記)];同一檔 gap 個交易日內只算一次(只算買得到的那幾筆)。"""
    last, kept = {}, []
    for d, sym, exs, tag in sorted(entries, key=lambda t: (twi[t[0]], t[1])):
        if exs is None:
            continue
        if twi[d] - last.get(sym, -10 ** 9) >= gap:
            last[sym] = twi[d]
            kept.append((d, sym, exs, tag))
    return kept


def risk_gates(st, valid):
    """找賣點的榜:全期 / 前後半 / 去最差年都 < 0 → 有用的風險提醒。回 (rel, h1, h2, xw, ok)。"""
    if not st.bn:
        return float('nan'), float('nan'), float('nan'), float('nan'), False
    rel = st.bsum / st.bn
    h1 = st.r1s / st.r1n if st.r1n else float('nan')
    h2 = st.r2s / st.r2n if st.r2n else float('nan')
    yv = [(y, o[1] / o[0], o[0]) for y, o in st.rY.items() if y in valid]
    if len(yv) < SEP.MIN_YEARS:
        return rel, h1, h2, float('nan'), False
    worst = min(yv, key=lambda t: t[1])
    rn, rs_ = st.bn - worst[2], st.bsum - st.rY[worst[0]][1]
    xw = rs_ / rn if rn else float('nan')
    return rel, h1, h2, xw, rel < 0 and h1 < 0 and h2 < 0 and xw < 0


def judge(entries, bmean, twi, valid):
    """entries 已去重;回每個天期的 St + 20 天判定。"""
    sts = {h: SEP.St() for h in HS}
    ix = [twi[d] for d, *_ in entries if d in bmean]
    cmid = (min(ix) + max(ix)) // 2 if ix else 0
    for d, sym, exs, tag in entries:
        bm = bmean.get(d)
        if bm is None:
            continue
        for j, h in enumerate(HS):
            sts[h].add(exs[j], d[:4], twi[d] < cmid, bm[j])
    return sts


_G = {}


def _init(twc, twr20):
    _G.update(twc=twc, twr20=twr20)


def _work(f):
    rows = load_rows(DATA / f)
    if not rows or len(rows) < WARM + FWD + 5:
        return None
    return Path(f).stem, stock_cands(Path(f).stem, rows, _G['twc'], _G['twr20'])


def _selftest():
    import random
    bad = 0

    def ok(name, c, x=''):
        nonlocal bad
        print(('✅ ' if c else '❌ ') + name + ('' if c else ' ・' + repr(x)[:300]))
        if not c:
            bad += 1

    # ① 前 N 名照排序鍵切(同一天 50 檔候選,鍵 = 隨機)
    random.seed(7)
    heaps = {}
    keys = {f'{1000 + k}': random.random() for k in range(50)}
    for s, kv in keys.items():
        push_top(heaps, 'momentum', '2020-01-02', kv, s, (0, 0, 1.0), '')
    got = sorted(t[1] for t in heaps[('momentum', '2020-01-02')])
    want = sorted(sorted(keys, key=lambda s: -keys[s])[:20])
    ok('① 渣男賽車一天只留排序鍵前 20 名', got == want, (got[:5], want[:5]))
    for s, kv in keys.items():
        push_top(heaps, 'monster', '2020-01-02', kv, s, (0, 0, 1.0), '')
    ok('① 妖股不切(50 檔全留)', len(heaps[('monster', '2020-01-02')]) == 50)

    # ② 同一檔 20 個交易日內只算一次;買不到的不佔位
    twi = {f'2020-{k:04d}': k for k in range(200)}
    ent = [(f'2020-{k:04d}', '2330', (0, 0, 1.0), '') for k in range(0, 60, 5)] + [('2020-0002', '2317', None, '')]
    kept = dedupe(ent, twi)
    ok('② 同檔每 5 天上榜一次、60 天 → 只算 3 次(第 0 / 20 / 40 天)', [d for d, *_ in kept] == ['2020-0000', '2020-0020', '2020-0040'], kept)
    ok('② 買不到的(超額 None)不算', all(s != '2317' for _, s, *_ in kept))

    # ③ 判定:決定性對照 ——「名單 = 之後真的贏同一天 2pp」→ 有用;「名單 = 隨機」→ 沒用
    def mk(edge, years=range(2012, 2024)):
        twi_, bmean, ents, k = {}, {}, [], 0
        for y in years:
            for t in range(120):
                d = f'{y}-{t:04d}'
                twi_[d] = k
                bm = random.uniform(-2, 2)
                bmean[d] = (bm, bm, bm)
                if t % 3 == 0:
                    e = bm + edge + random.uniform(-0.3, 0.3)
                    ents.append((d, f's{k}', (e, e, e), ''))
                k += 1
        valid = {str(y) for y in years}
        return judge(ents, bmean, twi_, valid), valid
    sts, valid = mk(2.0)
    g = SEP.gates(sts[20], valid)
    ok('③ 名單 = 之後真的贏同一天 2pp → 六關全過', g[7], g)
    sts0, valid0 = mk(0.0)
    g0 = SEP.gates(sts0[20], valid0)
    ok('③ 決定性對照:名單 = 隨機(≈ 0)→ 判沒用', not g0[7] and abs(sts0[20].bsum / sts0[20].bn) < 0.2, (g0[7], sts0[20].bsum / sts0[20].bn))
    stn, validn = mk(-1.5)
    r = risk_gates(stn[20], validn)
    ok('③ 找賣點的榜:上榜後穩定輸同一天 1.5pp → 有用的風險提醒', r[4], r)
    ok('③ 決定性對照:隨機名單 → 不算風險提醒', not risk_gates(sts0[20], valid0)[4])

    # ④ 合成一檔 700 根(有爆量、有噴出、有盤整)→ 用真的 scan_one / monster_pick 跑
    def synth(seed, n=700):
        random.seed(seed)
        rows, p, ymd = [], 50.0, []
        for k in range(n):
            mu = 0.012 if (k // 60) % 3 == 0 else (-0.008 if (k // 60) % 3 == 1 else 0.0)
            ch = mu + random.gauss(0, 0.025)
            if k % 97 == 0:
                ch = 0.095
            o = p * (1 + random.gauss(0, 0.006))
            p = max(1.0, p * (1 + ch))
            hi_, lo_ = max(o, p) * (1 + abs(random.gauss(0, 0.01))), min(o, p) * (1 - abs(random.gauss(0, 0.01)))
            v = 3e6 * (1 + random.random()) * (4 if k % 97 in (0, 1, 2) else 1)
            yy, dd = 2012 + k // 240, k % 240
            rows.append({'date': f'{yy}-{dd // 20 + 1:02d}-{dd % 20 + 1:02d}', 'open': round(o, 2), 'high': round(hi_, 2),
                         'low': round(lo_, 2), 'close': round(p, 2), 'volume': v,
                         'foreign_net': random.randint(-5000, 5000), 'trust_net': random.randint(-500, 500)})
        return rows
    rows = synth(11)
    twc = {r['date']: 100.0 for r in rows}
    twr = {r['date']: 1.0 for r in rows}
    full = [dict(RM.scan_one('2330', rows[:i + 1], 1.0, frozenset(), want=WANT, fast=False) or {})
            for i in range(WARM, len(rows) - FWD)]
    winv = [dict(RM.scan_one('2330', rows[max(0, i + 1 - WIN):i + 1], 1.0, frozenset(), want=WANT, fast=True) or {})
            for i in range(WARM, len(rows) - FWD)]
    keyset = lambda hs: [{k: LISTS[k][0](v) for k, v in h.items()} for h in hs]
    nhit = sum(len(h) for h in full)
    ok(f'④ 最近 {WIN} 根 + 快篩 == 整段 + 不快篩(每天每個榜的排序鍵逐值相同,共 {nhit} 次上榜)',
       keyset(full) == keyset(winv) and nhit > 50, nhit)
    seen = Counter(k for h in full for k in h)
    ok(f'④ 合成資料至少碰到 8 個榜(才有鑑別力):{dict(seen)}', len(seen) >= 8, dict(seen))

    # ⑤ ⛔ 前視:把第 500 根之後的 K 線全部換掉,500 之前每一天的候選(榜 / 日期 / 排序鍵)一模一樣
    rows2 = [dict(r) for r in rows]
    random.seed(99)
    for r in rows2[500:]:
        f = random.uniform(0.6, 1.6)
        for c in ('open', 'high', 'low', 'close'):
            r[c] = round(r[c] * f, 2)
        r['volume'] *= random.uniform(0.2, 5)
    a = stock_cands('2330', rows, twc, twr)
    b = stock_cands('2330', rows2, twc, twr)
    cut = rows[500]['date']
    pa = [(k, d, kv) for k, d, kv, _, _ in a['c'] if d < cut]
    pb = [(k, d, kv) for k, d, kv, _, _ in b['c'] if d < cut]
    ok(f'⑤ 改掉未來 K 線 → 之前的上榜紀錄不變({len(pa)} 筆)', pa == pb and len(pa) > 30, (len(pa), len(pb)))
    ok('⑤ 決定性對照:改掉之後的上榜紀錄確實變了', [(k, d, kv) for k, d, kv, _, _ in a['c'] if d >= cut] != [(k, d, kv) for k, d, kv, _, _ in b['c'] if d >= cut])

    # ⑥ 採礦端真的在用這兩支(⛔ 第二份)
    src_rm = (ROOT / 'radar_miner.py').read_text(encoding='utf-8')
    src_mn = (ROOT / 'miner.py').read_text(encoding='utf-8')
    ok('⑥ radar_miner.main 呼叫 scan_one、miner.build_radar_cache 呼叫 monster_pick',
       re.search(r'scan_one\(sym, raw_data, twii_ret20, chu_attention_set', src_rm) is not None
       and re.search(r'monster_pick\(sym, raw, ind\)', src_mn) is not None)
    print(f'\n❌ {bad} 條失敗' if bad else '\n✅ RADAR_LIST_SELFTEST_PASS')
    sys.exit(1 if bad else 0)


def main():
    tw = json.loads((DATA / '^TWII.json').read_text(encoding='utf-8'))
    tw = [r for r in (tw if isinstance(tw, list) else tw.get('data') or []) if float(r.get('close') or 0) > 0]
    twd = [str(r['date']).replace('/', '-') for r in tw]
    twcl = [float(r['close']) for r in tw]
    twc = dict(zip(twd, twcl))
    twi = {d: i for i, d in enumerate(twd)}
    twr20 = {twd[i]: (twcl[i] / twcl[i - 20] - 1) * 100 for i in range(20, len(twd))}
    tw5ok = {twd[i]: twcl[i] >= sum(twcl[i - 4:i + 1]) / 5 for i in range(4, len(twd))}
    files = sorted(f for f in os.listdir(DATA) if f.endswith('.json') and is_universe(Path(f).stem))
    only = os.environ.get('ONLY')
    if only:
        files = [f for f in files if Path(f).stem in set(only.split(','))]
    print(f'📈 日期軸 {len(twd)} 天({twd[0]} ~ {twd[-1]})・{len(files)} 檔(含 ETF,跟採礦端同一個母體)・{WORKERS} 個行程')

    heaps, base = {}, defaultdict(lambda: [0.0, 0.0, 0.0, 0])
    skip = Counter()
    used = 0
    with Pool(WORKERS, initializer=_init, initargs=(twc, twr20)) as pool:
        for k, r in enumerate(pool.imap_unordered(_work, files, chunksize=2)):
            if k % 200 == 0:
                print(f'  … {k}/{len(files)}', flush=True)
            if not r:
                continue
            sym, o = r
            used += 1
            for d, b in o['base'].items():
                x = base[d]
                for j in range(4):
                    x[j] += b[j]
            skip.update(o['skip'])
            for lst, d, key, exs, tag in o['c']:
                push_top(heaps, lst, d, key, sym, exs, tag)

    bmean = {d: (b[0] / b[3], b[1] / b[3], b[2] / b[3]) for d, b in base.items() if b[3] >= MIN_CTRL}
    ydays = Counter(d[:4] for d in bmean)
    valid = {y for y, c in ydays.items() if c >= SEP.MIN_YEAR_DAYS}
    print(f'\n✅ 用了 {used} 檔 ・同一天對照 {len(bmean):,} 天 ・逐年那關的年份 {",".join(sorted(valid))}')
    print(f'   上榜當天剔除:隔天鎖漲停買不到 {skip["lock"]:,} 次 ・持有窗口碰到斷崖 {skip["cliff"]:,} 次(⚠️ 這兩個是「這一檔有上任何一個榜的那幾天」,還沒切前 N 名)')

    res, total = {}, 0
    for lst in LISTS:
        days = sorted({d for (k, d) in heaps if k == lst})
        raw = [(d, s, exs, tag) for (k, d), h in heaps.items() if k == lst for _, s, exs, tag in h]
        unbuy = sum(1 for e in raw if e[2] is None)
        subsets = {'all': raw}
        if lst in ('momentum', 'monster'):
            subsets['tw5ok'] = [e for e in raw if tw5ok.get(e[0])]
        if lst == 'chu_diverge':
            subsets['bull'] = [e for e in raw if e[3] == 'bull']
            subsets['bear'] = [e for e in raw if e[3] == 'bear']
        out = {'days': len(days), 'rows': len(raw), 'unbuy': unbuy}
        for nm, ents in subsets.items():
            kept = dedupe(ents, twi)
            sts = judge(kept, bmean, twi, valid)
            st = sts[FWD]
            if not st.bn:
                out[nm] = None
                continue
            g = SEP.gates(st, valid)
            rk = risk_gates(st, valid)
            out[nm] = {
                'n': st.bn,
                'rel': {h: round(sts[h].bsum / sts[h].bn, 2) for h in HS if sts[h].bn},
                'raw20': round(st.sum / st.n, 2),
                'win20': round(st.win / st.n * 100, 1),
                'h1': round(g[1], 2), 'h2': round(g[2], 2),
                'xbest': round(g[4], 2) if g[4] == g[4] else None,
                'years': {y: round(x, 2) for y, x, _ in g[5]},
                'pos_years': sum(1 for _, x, _ in g[5] if x > 0),
                'n_years': len(g[5]),
                'ok': bool(g[7]),
                'risk_ok': bool(rk[4]), 'xworst': round(rk[3], 2) if rk[3] == rk[3] else None,
            }
            if nm == 'all':
                total += st.bn
        res[lst] = out

    print(f'\n{"榜":<14}{"天數":>6}{"列數":>8}{"買不到":>7}{"事件":>8}{"5天":>7}{"10天":>7}{"20天":>7}{"前半":>7}{"後半":>7}{"去最好年":>9}{"正年數":>8}  判定')
    print('─' * 118)
    for lst, (_, n, name) in LISTS.items():
        o = res[lst]
        for nm in ('all', 'tw5ok', 'bull', 'bear'):
            s = o.get(nm)
            if s is None or nm not in o:
                continue
            lab = name if nm == 'all' else f'  └ {"大盤站 5 日線" if nm == "tw5ok" else ("底背離" if nm == "bull" else "頂背離")}'
            if lst in RISK:
                verdict = '✅ 風險提醒有用' if s['risk_ok'] else '⛔ 沒用'
            else:
                verdict = '✅ 有用(六關全過)' if s['ok'] else '⛔ 沒用'
            print(f"{lab:<14}{o['days'] if nm == 'all' else '':>6}{o['rows'] if nm == 'all' else '':>8}{o['unbuy'] if nm == 'all' else '':>7}"
                  f"{s['n']:>8,}{s['rel'].get(5, 0):>+7.2f}{s['rel'].get(10, 0):>+7.2f}{s['rel'].get(20, 0):>+7.2f}"
                  f"{s['h1']:>+7.2f}{s['h2']:>+7.2f}{(s['xbest'] if s['xbest'] is not None else float('nan')):>+9.2f}"
                  f"{s['pos_years']:>4}/{s['n_years']:<3}  {verdict}")
    print('\n   數字 = 每一筆隔天開盤買、抱 N 個交易日,比同一天所有可交易股票的平均多幾 %(⛔ 還沒扣 0.44% 成本;六關的「扣成本」那關有扣)')
    for lst, (_, n, name) in LISTS.items():
        s = res[lst].get('all')
        if s:
            print(f"   {name} 逐年(20 天):" + ' '.join(f'{y}:{x:+.1f}' for y, x in sorted(s['years'].items())))
    if total < 3000:
        sys.exit(f'🚧 空過守門:全部榜加起來只有 {total} 個事件,結論不可信')
    if os.environ.get('EMIT'):
        print('\n===EMIT_JSON===')
        print(json.dumps({'win': [min(bmean), max(bmean)], 'fwd': FWD, 'cost': COST, 'syms': used, 'lists': res},
                         ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    if SELFTEST:
        _selftest()
    main()
