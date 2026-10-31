#!/usr/bin/env python3
"""🕳️ V80.1.0 K 線補洞 + 匯出取「最新」1200 根 —— 走正式入口(seed_db_from_json → export_json)

為什麼要這支:2026-10-31 清點 origin/data,上櫃 2025/08/01 缺 88%、2026/05/19 與 05/20 各缺 78%(加權那天有開盤)。
`_fill_gaps_from_deep` 用 klines_deep(FinMind 原始價)補回來;同一版把匯出改成「最新的」1200 根
(舊寫法 ORDER BY ASC LIMIT 1200 = 最舊的 1200 根,一檔超過就停在第 1200 根那天)。

釘住(每一條都走真的 seed → export,⛔ 不在測試裡複製判斷):
 ① 加權有開盤、這一檔沒有、深歷史有成交 → 補一根 = 深歷史價(尺標 1),法人 / 融資寫 0,其他列籌碼一個都不動
 ② 尺標 2(我們的價 = 深歷史 × 2,兩邊分割還原不同步)→ 補的那根 = 深歷史 × 2、量 = 深歷史 ÷ 2
 ③ 前後尺標不一樣(卡在分割邊界)→ ⛔ 不補
 ④ 深歷史那天沒有 / 量 0(停牌)→ ⛔ 不補
 ⑤ 這一檔第一根之前、最後一根之後 → ⛔ 不補(不往前補到掛牌前)
 ⑥ ⭐ 決定性對照:同一份資料,加權那天沒開盤 → 不補
 ⑦ 沒設 KLINES_DEEP_DIR → 不補(而且要說出來)
 ⑧ 冪等:匯出的檔再種回去、再匯出一次 → 一模一樣
 ⑨ 匯出取「最新」1200 根(1300 根那檔:最後一天是最新那天);⭐ 決定性對照:舊的 SQL 會停在第 1200 根
 ⑩ 原始碼:補洞排在還原價修復之後、分割還原之前
 ⑪ 深歷史那一根本身是壞 K(開盤在高低之外 / 不在跳動單位格上,FinMind 興櫃那段「開盤 = 均價」)→ ⛔ 不拿來補;同一檔好的那天照補(決定性對照)
跑法:python3 scripts/test_kline_gapfill.py
"""
import contextlib, gzip, io, json, os, shutil, sqlite3, sys, tempfile
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]
import miner  # noqa: E402

FAIL = []


def ck(c, m, extra=''):
    print(('✅ ' if c else '❌ ') + m + ('' if c or not extra else f'  {str(extra)[:300]}'))
    if not c:
        FAIL.append(m)


def weekdays(end, n):
    out, d = [], end
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    return sorted(out)


ALL = weekdays(date(2026, 8, 28), 1300)                     # 1300 個平日
CAL = ALL[-260:]                                            # 加權那 260 天
GAP = [CAL[100], CAL[150], CAL[151]]                        # 上櫃缺的那三天(像 2025/08/01、2026/05/19、05/20)
S = lambda d: d.strftime('%Y/%m/%d')
D = lambda d: d.strftime('%Y-%m-%d')


def px(i):
    return round(60 + 10 * ((i * 37) % 17) / 17 + i * 0.02, 1)    # 50~100 元(跳動單位 0.1 → 一位小數都在格上)、有起伏、不會觸發分割判斷


def deep_rows(days, scale=1.0, vol0=(), drop=()):
    out = []
    for i, d in enumerate(days):
        if d in drop:
            continue
        p = px(i)
        out.append([D(d), p, round(p + 1, 1), round(p - 1, 1), p, 0 if d in vol0 else 50000 + i])
    return out


def ours_rows(days, deep, skip=(), mult=lambda d: 1.0, chips=True):
    dk = {r[0]: r for r in deep}
    out = []
    for i, d in enumerate(days):
        if d in skip:
            continue
        r = dk.get(D(d))
        p = px(i) if r is None else r[4]
        m = mult(d)
        out.append({'date': S(d), 'open': round(p * m, 2), 'high': round((p + 1) * m, 2), 'low': round((p - 1) * m, 2),
                    'close': round(p * m, 2), 'volume': int(round((50000 + i) / m)),
                    'foreign_net': (i * 7 + 1) if chips else 0, 'trust_net': 3, 'dealer_net': -2,
                    'margin_balance': 100 + i, 'short_balance': 5})
    return out


def run_export(stocks, deeps, cal_days, deep_on=True):
    """stocks = {sym: rows};deeps = {sym: deep rows};回 ({sym: exported rows}, log)"""
    tmp = tempfile.mkdtemp(prefix='gapfill_')
    try:
        dd = os.path.join(tmp, 'data'); os.makedirs(dd)
        kd = os.path.join(tmp, 'kd', 'klines_deep'); os.makedirs(kd)
        with open(os.path.join(dd, '^TWII.json'), 'w', encoding='utf-8') as f:
            json.dump([{'date': S(d), 'open': 1, 'high': 1, 'low': 1, 'close': 1, 'volume': 0, 'amount': 1e11} for d in cal_days], f)
        for sym, rows in stocks.items():
            with open(os.path.join(dd, f'{sym}.json'), 'w', encoding='utf-8') as f:
                json.dump(rows, f)
        for sym, rows in deeps.items():
            with gzip.open(os.path.join(kd, f'{sym}.json.gz'), 'wt', encoding='utf-8') as f:
                json.dump({'k': rows}, f)
        old = (miner.DATA_DIR, miner.DB_PATH, os.environ.get('KLINES_DEEP_DIR'))
        miner.DATA_DIR = dd
        miner.DB_PATH = os.path.join(tmp, 't.db')
        if deep_on:
            os.environ['KLINES_DEEP_DIR'] = os.path.join(tmp, 'kd')
        else:
            os.environ.pop('KLINES_DEEP_DIR', None)
        for k in ('rows', 'syms', 'skip'):
            miner._GAP_FILL[k] = 0
        miner._GAP_FILL['days'] = {}
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                miner.init_db()
                miner.seed_db_from_json(list(stocks))
                miner.export_json()
        finally:
            miner.DATA_DIR, miner.DB_PATH = old[0], old[1]
            if old[2] is None:
                os.environ.pop('KLINES_DEEP_DIR', None)
            else:
                os.environ['KLINES_DEEP_DIR'] = old[2]
        out = {}
        for sym in stocks:
            with open(os.path.join(dd, f'{sym}.json'), encoding='utf-8') as f:
                out[sym] = json.load(f)
        return out, buf.getvalue()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


days = CAL
dA = deep_rows(days)
stocks = {
    'A111': ours_rows(days, dA, skip=GAP),                                            # ① 尺標 1
    'B222': ours_rows(days, dA, skip=GAP, mult=lambda d: 2.0),                        # ② 尺標 2
    'C333': ours_rows(days, dA, skip=GAP, mult=lambda d: 1.0 if d < GAP[0] else 2.0),  # ③ 卡在分割邊界(第一個洞)
    'D444': ours_rows(days, dA, skip=GAP),                                            # ④ 深歷史那天沒有 / 量 0
    'F666': ours_rows(days[140:], dA),                                                # ⑤ 掛牌晚(第 140 天才有;第一個洞在第 100 天)
    'H888': ours_rows(days, dA, skip=GAP),                                            # ⑪ 深歷史第一個洞那天是壞 K
}
dH = [list(r) for r in dA]
for r in dH:
    if r[0] == D(GAP[0]): r[1] = round(r[3] - 0.37, 2)          # 開盤在最低價之下、而且不在格上(FinMind 興櫃「開盤 = 均價」那種)
    if r[0] == D(GAP[1]): r[1] = round(r[4] + 0.03, 2)          # 開盤在高低之間,但不在 0.1 格上
deeps = {'A111': dA, 'B222': dA, 'C333': dA, 'D444': deep_rows(days, drop=(GAP[0],), vol0=(GAP[1], GAP[2])), 'F666': dA, 'H888': dH}
ex, log = run_export(stocks, deeps, CAL)

A = {r['date']: r for r in ex['A111']}
g0 = A.get(S(GAP[0]))
dkA = {r[0]: r for r in dA}
ck(all(S(g) in A for g in GAP), f'① 三個洞都補上(A111 補完 {len(ex["A111"])} 根 / 應 {len(days)})', [S(g) for g in GAP if S(g) not in A])
ck(g0 is not None and abs(g0['close'] - dkA[D(GAP[0])][4]) < 1e-6 and abs(g0['open'] - dkA[D(GAP[0])][1]) < 1e-6 and g0['volume'] == dkA[D(GAP[0])][5],
   '①b 補的那根 = 深歷史那天的開收盤與成交量(尺標 1)', g0)
ck(g0 is not None and all(g0.get(k) == 0 for k in ('foreign_net', 'trust_net', 'dealer_net', 'margin_balance', 'short_balance')),
   '①c 補的那根法人 / 融資寫 0(⛔ 編數字)', g0)
src_chip = {r['date']: r for r in stocks['A111']}
ck(all(A[d]['foreign_net'] == src_chip[d]['foreign_net'] and A[d]['margin_balance'] == src_chip[d]['margin_balance'] for d in src_chip),
   '①d 原本就有的那幾根,籌碼一個都沒動')
ck([r['date'] for r in ex['A111']] == sorted(r['date'] for r in ex['A111']), '①e 補完照日期排好')

B = {r['date']: r for r in ex['B222']}
gb = B.get(S(GAP[0]))
ck(gb is not None and abs(gb['close'] - 2 * dkA[D(GAP[0])][4]) < 1e-6 and gb['volume'] == int(round(dkA[D(GAP[0])][5] / 2)),
   '② 尺標 2 → 補的那根 = 深歷史 × 2、量 ÷ 2', gb)

C = {r['date']: r for r in ex['C333']}
ck(S(GAP[0]) not in C, '③ 前後尺標不一樣(分割邊界)→ ⛔ 不補', C.get(S(GAP[0])))
ck(S(GAP[1]) in C and S(GAP[2]) in C, '③b 同一檔其他前後一致的洞照補')

Dd = {r['date']: r for r in ex['D444']}
ck(not any(S(g) in Dd for g in GAP), '④ 深歷史那天沒有 / 量 0(停牌)→ ⛔ 不補', [S(g) for g in GAP if S(g) in Dd])

F = ex['F666']
ck(F[0]['date'] == S(days[140]) and len(F) == len(days) - 140, f'⑤ 掛牌前那幾天 ⛔ 不補(第一根仍是 {S(days[140])})', (F[0]['date'], len(F)))

ck('🕳️ 補洞:' in log and '檔' in log, '⑦a 匯出後印補洞摘要', log[-400:])

H = {r['date'] for r in ex['H888']}
ck(S(GAP[0]) not in H and S(GAP[1]) not in H, '⑪ 深歷史那天是壞 K(開盤在最低之下 / 不在跳動單位格上)→ ⛔ 不補', sorted(x for x in (S(GAP[0]), S(GAP[1])) if x in H))
ck(S(GAP[2]) in H, '⑪b ⭐ 決定性對照:同一檔深歷史好好的那天照補')

# ⑥ 決定性對照:加權那幾天沒開盤 → 同一份資料不補
ex2, _ = run_export({'A111': stocks['A111']}, {'A111': dA}, [d for d in CAL if d not in GAP])
ck(not any(S(g) in {r['date'] for r in ex2['A111']} for g in GAP), '⑥ ⭐ 決定性對照:加權那天沒開盤 → 同一份資料不補')

# ⑦ 沒有深歷史 → 不補,而且說出來
ex3, log3 = run_export({'A111': stocks['A111']}, {'A111': dA}, CAL, deep_on=False)
ck(len(ex3['A111']) == len(stocks['A111']) and '這一輪沒補' in log3, '⑦ 沒設 KLINES_DEEP_DIR → 不補,log 寫「這一輪沒補」', log3[-200:])

# ⑧ 冪等
ex4, _ = run_export({'A111': ex['A111'], 'B222': ex['B222']}, {'A111': dA, 'B222': dA}, CAL)
ck(ex4['A111'] == ex['A111'] and ex4['B222'] == ex['B222'], '⑧ 冪等:補完的檔再種回去、再匯出一次 → 一模一樣')

# ⑨ 最新的 1200 根
dG = deep_rows(ALL)
G = ours_rows(ALL, dG)
ex5, _ = run_export({'G777': G}, {}, CAL)
ck(len(ex5['G777']) == 1200 and ex5['G777'][-1]['date'] == S(ALL[-1]) and ex5['G777'][0]['date'] == S(ALL[100]),
   f'⑨ 1300 根那檔匯出最新的 1200 根(最後一天 {S(ALL[-1])})', (len(ex5['G777']), ex5['G777'][0]['date'], ex5['G777'][-1]['date']))
# ⭐ 決定性對照:舊的 SQL(ASC LIMIT 1200)在同一份 SQLite 上會停在第 1200 根
con = sqlite3.connect(':memory:')
con.execute('CREATE TABLE stock_history (symbol TEXT, trade_date TEXT, close REAL)')
con.executemany('INSERT INTO stock_history VALUES (?,?,?)', [('G777', D(d), 1.0) for d in ALL])
old_last = con.execute("SELECT trade_date FROM stock_history WHERE symbol='G777' ORDER BY trade_date ASC LIMIT 1200").fetchall()[-1][0]
ck(old_last == D(ALL[1199]) and old_last != D(ALL[-1]), f'⑨b ⭐ 決定性對照:舊寫法會停在 {old_last}(第 1200 根),⛔ 不是最新那天')

# ⑩ 原始碼順序
src = open(os.path.join(ROOT, 'miner.py'), encoding='utf-8').read()
exs = src[src.index('def export_json'):src.index('def seed_db_from_json')]
ia, ib, ic = exs.find('_repair_from_deep(records'), exs.find('_fill_gaps_from_deep(records'), exs.find('_backadjust_splits(records')
ck(0 < ia < ib < ic, '⑩ 補洞排在還原價修復之後、分割還原之前', (ia, ib, ic))
ck('ORDER BY trade_date DESC' in exs and 'ORDER BY trade_date ASC\n            LIMIT 1200' not in exs, '⑩b 匯出 SQL 是「最新的 1200 根」')

print(f"\n{'❌ ' + str(len(FAIL)) + ' 條失敗' if FAIL else '✅ 全過'}")
sys.exit(1 if FAIL else 0)
