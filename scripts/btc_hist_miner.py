#!/usr/bin/env python3
"""₿ btc_hist_miner.py —— 比特幣每小時 K 線長歷史(Coinbase Exchange BTC-USD,2016 起)→ btc_1h.json.gz(研究用)

為什麼要有這支(V82.6.7,使用者 11/23「比特幣跟股市有沒有關聯、能不能在盤前 / 盤中先知道股市信心」):
  本站只有比特幣「每天一個價」(macro_risk.btc_usd,Coinbase 日 K)+ FRED CBBTCUSD 每日(一天裡哪個時間點不清楚)
  → 量不到「美股收盤 → 台北 08:00」「台股收盤 → 隔天 08:00」「09:00 → 10:00」這幾段 = 盤前 / 盤中研究要的東西。
來源:Coinbase Exchange 公開 K 線(免金鑰;⚠️ 是交易所報價不是「官方」)。走 lib_quotes.make_gate():
  同一個網站一秒一次、429 / 5xx 退避 2 → 4 秒再試、連續失敗斷路(使用者鐵則 3:外部 API 要有退避與限流)。
  GET /products/BTC-USD/candles?granularity=3600&start=ISO&end=ISO → [[時間, 低, 高, 開, 收, 量], …](新到舊,一次最多 300 根)
  ⚠️ 時間 = 那一根的**開始**。某一刻 T 的價 = 開始於 T − 1 小時那根的收盤 → 檔內 c[k] = t0 + (k+1) 小時那一刻的價
     (⛔ 拿開始於 T 那根 = 偷看 T 之後那一小時;探針 btc_tw_probe.mjs 的 px() 照這條讀)。
  ⚠️ 還在跑的那一根(開始 + 1 小時 > 抓的時間)丟掉。
產物(只推研究分支 premkt_hist,⛔ 進 gh-pages / data —— 手機用不到):
  {v:1, src, t0, step:3600, c:[收盤 | null], asof, cov:{年: 有值的比例}, gaps:[[開始 epoch, 缺幾小時]], jumps:[[epoch, %]],
   req, fetched, note}
守門(沒過 → 不寫檔、exit 1,分支上那份留著):
  ① 整體完整率 ≥ 97%、最近 730 天 ≥ 99% ② 連續 20 個窗口都空 → 停 ③ 有舊檔接著抓時,重疊那 72 小時差 > 0.5% → 停(來源變了)
  單小時漲跌 > 15% 只記在 jumps、⛔ 改數字。
記憶體(使用者鐵則 1):一小時一個數字,10 年約 9.5 萬個 → 一份 dict 就夠;一個窗口抓完就併進去,⛔ 先把所有回應留著。
跑法:python3 scripts/btc_hist_miner.py [--selftest]
      環境變數 START=2016-01-01・OUT=/tmp/btc_1h.json.gz・PREV=舊檔(有就從 asof − 72 小時接著抓)・FULL=1(整段重抓)
"""
import gzip
import json
import math
import os
import sys
import time
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

URL = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start={s}&end={e}'
H = 3600
WIN = 300                      # Coinbase 一次最多 300 根
START = (os.environ.get('START') or '2016-01-01').strip()          # 🔧 空字串一律退回預設(check_env_default)
OUT = (os.environ.get('OUT') or '/tmp/btc_1h.json.gz').strip()
PREV = (os.environ.get('PREV') or '').strip()
FULL = (os.environ.get('FULL') or '').strip() == '1'
COV_ALL, COV_RECENT, RECENT_DAYS = 0.97, 0.99, 730
MAX_EMPTY = 20
OVERLAP_H, OVERLAP_TOL = 72, 0.005
JUMP = 0.15


def iso(t):
    return datetime.fromtimestamp(int(t), timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def epoch(day):
    return int(datetime.strptime(day[:10], '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp())


def windows(s, e, n=WIN):
    """[s, e](整點、含兩端)切成一段一段:每段 [a, a + (n−1) 小時](= n 根),最後一段截到 e。純函式。"""
    s, e = s - s % H, e - e % H
    out, a = [], s
    while a <= e:
        b = min(a + (n - 1) * H, e)
        out.append((a, b))
        a = b + H
    return out


def parse_candles(rows, a, b, now):
    """Coinbase 回應(新到舊)→ {開始 epoch: 收盤};只收 [a, b] 裡、整點、收盤 > 0、而且已經收完(開始 + 1 小時 ≤ now)的。純函式。"""
    out = {}
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, (list, tuple)) or len(r) < 5:
            continue
        try:
            t, c = int(r[0]), float(r[4])
        except (TypeError, ValueError):
            continue
        if t % H or t < a or t > b or not math.isfinite(c) or c <= 0 or t + H > now:
            continue
        out[t] = c
    return out


def assemble(pts, now):
    """{開始 epoch: 收盤} → 檔案內容(c[k] = 開始於 t0 + k 小時那根的收盤 = t0 + (k+1) 小時那一刻的價)。純函式。"""
    if not pts:
        raise ValueError('一根都沒有')
    ks = sorted(pts)
    t0, t1 = ks[0], ks[-1]
    n = (t1 - t0) // H + 1
    c = [None] * n
    for t in ks:
        c[(t - t0) // H] = round(pts[t], 2)
    gaps, jumps, run, prev = [], [], None, None
    for k, v in enumerate(c):
        t = t0 + k * H
        if v is None:
            if run is None:
                run = [t, 0]
            run[1] += 1
        else:
            if run is not None:
                gaps.append(run)
                run = None
            if prev is not None and abs(v / prev - 1) > JUMP:
                jumps.append([t, round((v / prev - 1) * 100, 2)])
            prev = v
    by = {}
    for k, v in enumerate(c):
        y = datetime.fromtimestamp(t0 + k * H, timezone.utc).strftime('%Y')
        tot, got = by.get(y, (0, 0))
        by[y] = (tot + 1, got + (v is not None))
    cov = {y: round(g / t, 4) for y, (t, g) in sorted(by.items())}
    return {'v': 1, 'src': 'Coinbase Exchange BTC-USD 每小時 K 線(granularity 3600)', 't0': t0, 'step': H, 'c': c,
            'asof': iso(t1 + H), 'cov': cov, 'gaps': gaps, 'jumps': jumps,
            'note': 'c[k] = t0 + (k+1) 小時那一刻的價(開始於 t0 + k 小時那根的收盤);null = Coinbase 那一小時沒有成交 / 沒資料'}


def coverage(doc, now):
    """→ (整體完整率, 最近 RECENT_DAYS 天完整率)。純函式。"""
    c, t0 = doc['c'], doc['t0']
    allv = sum(v is not None for v in c) / len(c) if c else 0.0
    cut = now - RECENT_DAYS * 86400
    rec = [v for k, v in enumerate(c) if t0 + k * H >= cut]
    recv = sum(v is not None for v in rec) / len(rec) if rec else 0.0
    return allv, recv


def guard(doc, now):
    """→ (ok, 說明)。純函式。"""
    a, r = coverage(doc, now)
    if a < COV_ALL:
        return False, f'整體完整率 {a:.2%} < {COV_ALL:.0%}'
    if r < COV_RECENT:
        return False, f'最近 {RECENT_DAYS} 天完整率 {r:.2%} < {COV_RECENT:.0%}'
    return True, f'整體 {a:.2%}・最近 {RECENT_DAYS} 天 {r:.2%}'


def from_doc(doc):
    """檔案內容 → {開始 epoch: 收盤}。純函式。"""
    t0 = doc['t0']
    return {t0 + k * H: v for k, v in enumerate(doc.get('c') or []) if v is not None}


def overlap_ok(old, new, a):
    """舊檔與新抓的在 [a, ∞) 重疊的那幾根要一樣(±0.5%)。→ (ok, 說明)。純函式。"""
    both = [t for t in new if t >= a and t in old]
    bad = [t for t in both if abs(new[t] / old[t] - 1) > OVERLAP_TOL]
    if not both:
        return False, '跟舊檔沒有重疊(接不起來)'
    if bad:
        t = bad[0]
        return False, f'重疊 {len(both)} 根有 {len(bad)} 根差 > {OVERLAP_TOL:.1%}(例:{iso(t)} 舊 {old[t]} 新 {new[t]})'
    return True, f'重疊 {len(both)} 根一致'


def fetch(gate, s, e, now, log=print):
    """一段一段抓;→ (pts, 送出次數, 錯誤或 None)。連續 MAX_EMPTY 段都空 → 停。"""
    pts, req, empty = {}, 0, 0
    W = windows(s, e)
    for i, (a, b) in enumerate(W):
        res, why = gate.get(URL.format(s=iso(a), e=iso(b)), expect='json')
        req += 1
        got = {}
        if res is not None:
            try:
                got = parse_candles(res.json(), a, b, now)
            except ValueError:
                why = '回應不是 JSON'
        if got:
            pts.update(got)
            empty = 0
        else:
            empty += 1
            if why and 'gate' not in why:
                log(f'  ⚠️ {iso(a)[:13]} ~ {iso(b)[:13]}:{why or "空的"}')
            if empty >= MAX_EMPTY:
                return pts, req, f'連續 {empty} 段都沒有資料(最後一段 {iso(a)[:10]}:{why or "空的"})'
            if why and why.startswith('斷路'):
                return pts, req, f'Coinbase {why}'
        if (i + 1) % 40 == 0 or i + 1 == len(W):
            log(f'  … {i + 1}/{len(W)} 段・{len(pts):,} 根・到 {iso(b)[:13]}', flush=True) if log is print else log(f'{i + 1}/{len(W)}')
    return pts, req, None


def write(doc, out):
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    tmp = out + '.tmp'
    with gzip.open(tmp, 'wt', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, out)


def main():
    from lib_quotes import make_gate
    now = int(time.time())
    gate = make_gate(timeout=30)
    old = {}
    s = epoch(START)
    if PREV and not FULL and os.path.exists(PREV) and os.path.getsize(PREV) > 0:
        try:
            with gzip.open(PREV, 'rt', encoding='utf-8') as f:
                pd = json.load(f)
            old = from_doc(pd)
            s = max(s, max(old) - OVERLAP_H * H) if old else s
            print(f'🧾 舊檔 {len(old):,} 根(到 {pd.get("asof")})→ 從 {iso(s)} 接著抓', flush=True)
        except Exception as e:   # noqa: BLE001
            print(f'⚠️ 舊檔讀不到({type(e).__name__})→ 整段重抓', flush=True)
            old, s = {}, epoch(START)
    e = now - now % H - H          # 最後一根完整的開始時間
    print(f'₿ Coinbase BTC-USD 每小時:{iso(s)} ~ {iso(e)}({len(windows(s, e))} 段)', flush=True)
    pts, req, err = fetch(gate, s, e, now)
    if err:
        print(f'⛔ {err} → 不寫檔(分支上那份保留)')
        return 1
    if old:
        ok, why = overlap_ok(old, pts, s)
        print(('✅ ' if ok else '⛔ ') + why)
        if not ok:
            return 1
        merged = dict(old)
        merged.update(pts)
        pts = merged
    doc = assemble(pts, now)
    ok, why = guard(doc, now)
    print(f'{"✅" if ok else "⛔"} 守門:{why}・{len(doc["c"]):,} 小時(t0 {iso(doc["t0"])} ~ {doc["asof"]})・缺口 {len(doc["gaps"])} 段・單小時 > 15% {len(doc["jumps"])} 次')
    print('   每年完整率:' + ' '.join(f'{y}:{v:.1%}' for y, v in doc['cov'].items()))
    if not ok:
        return 1
    doc['req'] = req
    doc['fetched'] = iso(now)
    write(doc, OUT)
    print(f'💾 {OUT}({os.path.getsize(OUT):,} bytes)・送出 {req} 次')
    return 0


def selftest():
    bad = []

    def ok(name, cond, got=''):
        print(f"{'✅' if cond else '❌'} {name}" + ('' if cond else f'  → {got}'))
        if not cond:
            bad.append(name)

    t0 = epoch('2024-03-01')
    W = windows(t0, t0 + 700 * H)
    ok('① 切段:每段 300 根、首尾相接、最後一段截到結尾', len(W) == 3 and all((b - a) // H + 1 <= WIN for a, b in W)
       and W[0] == (t0, t0 + 299 * H) and W[1][0] == t0 + 300 * H and W[-1][1] == t0 + 700 * H, W)
    rows = [[t0 + 2 * H, 1, 2, 1, 102.0, 5], [t0 + H, 1, 2, 1, 101.0, 5], [t0, 1, 2, 1, 100.0, 5],
            [t0 + 30, 1, 2, 1, 9.0, 1], [t0 - H, 1, 2, 1, 99.0, 1], [t0 + 3 * H, 1, 2, 1, 0, 1], ['x'], [t0 + 4 * H, 1, 2, 1, 'n', 1]]
    p = parse_candles(rows, t0, t0 + 5 * H, now=t0 + 10 * H)
    ok('② 解析:新到舊也對、⛔ 窗口外 / 非整點 / 收盤 0 / 壞列', p == {t0: 100.0, t0 + H: 101.0, t0 + 2 * H: 102.0}, p)
    p2 = parse_candles(rows, t0, t0 + 5 * H, now=t0 + 2 * H + 1800)
    ok('② 還在跑的那一根(開始 + 1 小時 > 現在)丟掉', t0 + 2 * H not in p2 and t0 + H in p2, sorted(p2))
    doc = assemble({t0: 100.0, t0 + H: 101.0, t0 + 4 * H: 140.0}, now=t0 + 10 * H)
    ok('③ 格子:c[k] = 開始於 t0 + k 小時那根;缺的是 null;缺口記 [開始, 小時數]', doc['c'] == [100.0, 101.0, None, None, 140.0]
       and doc['gaps'] == [[t0 + 2 * H, 2]] and doc['t0'] == t0, (doc['c'], doc['gaps']))
    ok('③ 單小時 > 15% 只記下來(⛔ 改數字)', doc['jumps'] == [[t0 + 4 * H, 38.61]] and doc['c'][4] == 140.0, doc['jumps'])
    ok('③ asof = 最後一根收完的那一刻(開始 + 1 小時)', doc['asof'] == iso(t0 + 5 * H), doc['asof'])
    # 某一刻的價:台北 08:00 = UTC 00:00 → 開始於 23:00 那根的收盤
    d0 = epoch('2024-03-04')
    doc2 = assemble({d0 - H: 50000.0, d0: 51000.0}, now=d0 + 5 * H)
    k = (d0 - doc2['t0']) // H - 1
    ok('④ UTC 00:00(台北 08:00)那一刻的價 = c[(T − t0)/3600 − 1] = 開始於 23:00 那根(⛔ 開始於 00:00 那根)', doc2['c'][k] == 50000.0 and doc2['c'][k + 1] == 51000.0, doc2['c'])
    now = epoch('2026-11-20')
    full = {now - 900 * 86400 + i * H: 100.0 for i in range(900 * 24)}
    ok('⑤ 守門:沒缺 → 過', guard(assemble(full, now), now)[0], guard(assemble(full, now), now))
    holes = {t: v for i, (t, v) in enumerate(sorted(full.items())) if i % 50}           # 缺 2%
    g = guard(assemble(holes, now), now)
    ok('⑤ 守門:整體 98% 但最近兩年也只有 98% → ⛔', not g[0] and '最近' in g[1], g)
    holes3 = {t: v for i, (t, v) in enumerate(sorted(full.items())) if i % 20}           # 缺 5%
    ok('⑤ 守門:整體 95% → ⛔', not guard(assemble(holes3, now), now)[0])
    old = {t0 + i * H: 100.0 + i for i in range(100)}
    new_ok = {t0 + i * H: 100.0 + i for i in range(28, 140)}
    new_bad = dict(new_ok); new_bad[t0 + 50 * H] = 300.0
    ok('⑥ 接著抓:重疊那段一樣 → 接', overlap_ok(old, new_ok, t0 + 28 * H)[0])
    ok('⑥ 接著抓:重疊那段有一根差很多 → ⛔(來源變了)', not overlap_ok(old, new_bad, t0 + 28 * H)[0])
    ok('⑥ 接著抓:完全沒有重疊 → ⛔', not overlap_ok(old, {t0 + 500 * H: 1.0}, t0 + 400 * H)[0])

    class R:
        def __init__(self, rows):
            self._r = rows

        def json(self):
            return self._r

    class G:
        def __init__(self, plan):
            self.plan, self.n = plan, 0

        def get(self, url, expect='json'):
            x = self.plan[min(self.n, len(self.plan) - 1)]
            self.n += 1
            return (R(x), '') if x is not None else (None, 'HTTP 404')

    s = epoch('2024-01-01')
    rows1 = [[s + i * H, 1, 2, 1, 100.0, 1] for i in range(299, -1, -1)]
    gt = G([rows1, [], [[s + 600 * H, 1, 2, 1, 101.0, 1]]])
    pts, req, err = fetch(gt, s, s + 650 * H, now=s + 2000 * H, log=lambda *a, **k: None)
    ok('⑦ 中間一段是空的 → 照抓下一段(⛔ 停)', err is None and len(pts) == 301 and req == 3, (err, len(pts), req))
    gt2 = G([None])
    pts2, req2, err2 = fetch(gt2, s, s + 30 * WIN * H, now=s + 99999 * H, log=lambda *a, **k: None)
    ok(f'⑦ 連續 {MAX_EMPTY} 段都空 → 停、回錯誤(⛔ 寫一份空檔)', err2 is not None and req2 == MAX_EMPTY and not pts2, (err2, req2))
    os.environ.pop('X', None)
    ok('⑧ 預設值:START 空字串 → 2016-01-01(check_env_default)', START == ((os.environ.get('START') or '2016-01-01').strip()))
    print(f"\n{'❌ ' + str(len(bad)) + ' 條沒過' if bad else '✅ BTC_HIST_SELFTEST_PASS'}")
    return 1 if bad else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(main())
