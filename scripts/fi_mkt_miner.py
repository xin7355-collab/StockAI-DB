#!/usr/bin/env python3
"""📉 大盤層級「外資現貨・外資台指期・整體融資」長歷史 → data/fi_mkt_hist.json(V79.3.6)

為什麼要有這支:使用者問「高檔 + 新聞說外資拋售 + 今天大跌,要不要先停?」——
本站能回測的外資資料只有兩種,都太短:
  ・外資台指期淨未平倉 → risk_history.json 只有 ~90 天(App 的 `_fiFutState` 從來沒回測過)
  ・外資現貨 → 只有個股層級 data/*.json 2023-06 起(沒經歷過空頭)
使用者:「沒有資料,該回測就回測、該挖礦就挖礦」→ 一次挖回來,⛔ 不開排程(hist_backfill.yml which=fimkt 手動跑)。

來源(全部 FinMind **免費層**,`.claude/commands/finmind-references/datasets.md` 標 Free;一年一次呼叫):
  spot  TaiwanStockTotalInstitutionalInvestors        上市整體三大法人(元)→ [外資, 投信, 自營](億)
  fut   TaiwanFuturesInstitutionalInvestors data_id=TX 外資台指期(大台)淨未平倉 = 多方餘額 − 空方餘額(口)
  mg    TaiwanStockTotalMarginPurchaseShortSale        整體融資餘額(MarginPurchaseMoney 的 TodayBalance,元 → 億)
  bs    TaiwanFuturesDaily data_id=TX + TaiwanStockPrice data_id=TAIEX(V79.3.8)
        台指期近月(一般盤、單一月份、最小的那個合約月)收盤 − 加權收盤 = 順逆價差(點;負 = 逆價差)→ [價差, 期貨, 加權]
        ⭐ 外資台指期空單有一部分是避險,單看口數會誤判(CLAUDE.md「順逆價差」那節)→ 變因研究的大盤狀態要它

守門(三份各自判,沒過的那一份 ⛔ 不寫、原因寫進 src_error;三份都沒過 → exit 1 不寫檔):
  ① 天數 ≥ 那一段平日數的 85%(國定假日約 4%)
  ② 起點不可比預期晚太多(spot / mg ≤ FROM + 120 天、fut ≤ 2018-12-31)
  ③ ⭐ 跟現有的對表(陷阱 #17:單位 / 正負號對不上 = 不是同一個東西):
     risk_history.json 的 fi_spot_net(億)/ fi_futures_net(口)/ margin_100m(億),
     快照日期本身可能晚 1~4 天(快照是「採礦那天」不是「資料那天」)→ 往前 4 個日曆天內任一天對得上就算;
     重複的快照值只算一次(陷阱 #16);可對表的 ≥5 筆時一致率要 ≥80%。
     ⛔ 沒有 RISK_HIST(而且沒設 NO_CHECK=1)→ 一律不寫(不能讓「沒對表」長得跟「對過了」一樣)。

⛔ 安全:金鑰只放 Authorization 標頭,⛔ 不進網址、⛔ 不印;⛔ 不可 `.strip()` 金鑰中間的空白(V73.2.7)。

跑法:python3 scripts/fi_mkt_miner.py [--selftest]
      環境變數 FROM=2004-01-01・OUT=/tmp/fi_mkt_hist.json・RISK_HIST=data/risk_history.json・FINMIND_TOKENS
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

API = 'https://api.finmindtrade.com/api/v4/data'
FROM = (os.environ.get('FROM') or '2004-01-01').strip()          # 🔧 空字串守門(check_env_default)
OUT = os.environ.get('OUT') or '/tmp/fi_mkt_hist.json'
RISK_HIST = os.environ.get('RISK_HIST') or ''
NO_CHECK = (os.environ.get('NO_CHECK') or '') == '1'
FUT_FROM = '2018-01-01'          # FinMind 期貨三大法人實測 2018-06 起(taifex_hist rl 欄)
MIN_RATIO = 0.85
MATCH_MIN = 0.80
MATCH_N = 5
SHIFT_DAYS = 4
TOL = {'spot': (1.0, 0.01), 'fut': (50, 0.005), 'mg': (5.0, 0.01), 'bs': (3.0, 0.0)}   # (絕對, 相對) 取大者;價差 ±3 點
RH_KEY = {'spot': 'fi_spot_net', 'fut': 'fi_futures_net', 'mg': 'margin_100m', 'bs': 'taifex_backwardation'}

F_NAMES = ('Foreign_Investor', 'Foreign_Dealer_Self')
T_NAMES = ('Investment_Trust',)
D_NAMES = ('Dealer_self', 'Dealer_Hedging', 'Dealer')


def _tokens():
    return [''.join(t.split()) for t in (os.environ.get('FINMIND_TOKENS') or '').split(',') if t.strip()] or ['']


def _date(s):
    s = str(s or '').strip().replace('/', '-')
    try:
        return datetime.strptime(s[:10], '%Y-%m-%d').strftime('%Y-%m-%d')
    except Exception:
        return ''


def _num(x):
    try:
        return float(str(x).replace(',', ''))
    except Exception:
        return None


def _cls(nm):
    """法人身分 → 'f' / 't' / 'd' / None。FinMind 回英文列舉(V41.28 踩過),也收中文以防改版。"""
    nm = str(nm or '')
    if nm in F_NAMES or '外資' in nm:
        return 'f'
    if nm in T_NAMES or '投信' in nm:
        return 't'
    if nm in D_NAMES or nm.startswith('自營'):
        return 'd'
    return None


def parse_spot(rows):
    """TaiwanStockTotalInstitutionalInvestors → {date: [外資, 投信, 自營]}(億,買 − 賣)。'total' 那列不算。"""
    acc = {}
    for r in rows or []:
        d, k = _date(r.get('date')), _cls(r.get('name'))
        b, s = _num(r.get('buy')), _num(r.get('sell'))
        if not d or not k or b is None or s is None:
            continue
        o = acc.setdefault(d, {'f': 0.0, 't': 0.0, 'd': 0.0})
        o[k] += (b - s)
    return {d: [round(v['f'] / 1e8, 2), round(v['t'] / 1e8, 2), round(v['d'] / 1e8, 2)] for d, v in acc.items()}


def parse_fut(rows):
    """TaiwanFuturesInstitutionalInvestors(TX)→ {date: 外資淨未平倉口};只收外資那一列(⛔ 不三身份加總)。"""
    out = {}
    for r in rows or []:
        d = _date(r.get('date'))
        if not d or _cls(r.get('institutional_investors') or r.get('name')) != 'f':
            continue
        lo, sh = _num(r.get('long_open_interest_balance_volume')), _num(r.get('short_open_interest_balance_volume'))
        if lo is None or sh is None:
            continue
        out[d] = out.get(d, 0) + int(lo - sh)
    return out


def parse_mg(rows):
    """TaiwanStockTotalMarginPurchaseShortSale → {date: 融資餘額億}(只收 MarginPurchaseMoney,元 → 億)。"""
    out = {}
    for r in rows or []:
        d = _date(r.get('date'))
        if not d or str(r.get('name') or '') != 'MarginPurchaseMoney':
            continue
        v = _num(r.get('TodayBalance'))
        if v is not None:
            out[d] = round(v / 1e8, 2)
    return out


def parse_txnear(rows):
    """TaiwanFuturesDaily(TX)→ {date: (合約月, 收盤)}:只收一般盤(夜盤 after_market ⛔)、單一月份(價差單 202301/202302 ⛔)、
    收盤 > 0,取那天**最小的**合約月 = 近月(結算日當天到期的那個仍算近月,同 App 的口徑)。"""
    best = {}
    for r in rows or []:
        d = _date(r.get('date'))
        cd = str(r.get('contract_date') or '').strip()
        if not d or len(cd) != 6 or not cd.isdigit():
            continue
        if str(r.get('trading_session') or 'position') != 'position':
            continue
        c = _num(r.get('close'))
        if c is None or c <= 0:
            continue
        if d not in best or cd < best[d][0]:
            best[d] = (cd, c)
    return best


def parse_ix(rows):
    """TaiwanStockPrice(TAIEX)→ {date: 收盤}。"""
    out = {}
    for r in rows or []:
        d, c = _date(r.get('date')), _num(r.get('close'))
        if d and c and c > 0:
            out[d] = c
    return out


def combine_bs(tx, ix):
    """{date: [價差, 期貨近月收盤, 加權收盤]};兩邊都有那天才算(⛔ 不拿不同天的相減,陷阱 #22 V71.4.9 那條)。"""
    return {d: [round(tx[d][1] - ix[d], 2), tx[d][1], ix[d]] for d in sorted(set(tx) & set(ix))}


def weekdays(a, b):
    """a~b(含)的平日數。"""
    d0, d1 = datetime.strptime(a, '%Y-%m-%d').date(), datetime.strptime(b, '%Y-%m-%d').date()
    n, d = 0, d0
    while d <= d1:
        n += d.weekday() < 5
        d += timedelta(days=1)
    return n


def _close(a, b, tol):
    ab, rel = tol
    return abs(a - b) <= max(ab, abs(b) * rel)


def cross_check(series, kind, hist):
    """跟 risk_history 快照對表。回 (ok, 說明)。series 的值:spot 取外資那一格。"""
    key, tol = RH_KEY[kind], TOL[kind]
    seen, n, hit, miss = set(), 0, 0, []
    for h in hist or []:
        v, d = h.get(key), _date(h.get('date'))
        if v is None or not d or v in seen:          # 重複快照值只算一次(陷阱 #16)
            continue
        seen.add(v)
        base = datetime.strptime(d, '%Y-%m-%d').date()
        cands = [(base - timedelta(days=k)).strftime('%Y-%m-%d') for k in range(SHIFT_DAYS + 1)]
        have = [series[c] for c in cands if c in series]
        if not have:
            continue                                   # 那幾天我們沒有資料 → 不算(不是「對不上」)
        have = [x[0] if isinstance(x, list) else x for x in have]
        n += 1
        if any(_close(x, float(v), tol) for x in have):
            hit += 1
        elif len(miss) < 3:
            miss.append(f'{d} 快照 {v} vs 我們 {have[0]}')
    if n < MATCH_N:
        return False, f'可對表只有 {n} 筆(< {MATCH_N})'
    r = hit / n
    msg = f'對表 {hit}/{n}({r:.0%})' + (f' ・例:{"; ".join(miss)}' if miss else '')
    return r >= MATCH_MIN, msg


def guard(series, kind, frm, to):
    """天數 + 起點守門。回 (ok, 說明)。"""
    if not series:
        return False, '0 天'
    ks = sorted(series)
    first, last = ks[0], ks[-1]
    exp_from = FUT_FROM if kind == 'fut' else frm
    late = (datetime.strptime(first, '%Y-%m-%d') - datetime.strptime(exp_from, '%Y-%m-%d')).days
    lim = 365 if kind == 'fut' else 120
    if late > lim:
        return False, f'第一天 {first} 比預期 {exp_from} 晚 {late} 天(> {lim})'
    wd = weekdays(first, min(last, to))
    if len(ks) < MIN_RATIO * wd:
        return False, f'{len(ks)} 天 < 平日 {wd} 的 {MIN_RATIO:.0%}'
    return True, f'{first} ~ {last} ・{len(ks)} 天(平日 {wd})'


def fm_year(dataset, y, data_id=None, sleep=1.0):
    """一年一次呼叫,輪 token;回 (rows, err)。⛔ 金鑰只放標頭。"""
    q = {'dataset': dataset, 'start_date': f'{y}-01-01', 'end_date': f'{y}-12-31'}
    if data_id:
        q['data_id'] = data_id
    last = None
    for i, t in enumerate(_tokens()):
        req = urllib.request.Request(API + '?' + urllib.parse.urlencode(q),
                                     headers={'User-Agent': 'fi_mkt_miner/1.0', **({'Authorization': f'Bearer {t}'} if t else {})})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                j = json.loads(r.read().decode('utf-8'))
            if isinstance(j, dict) and j.get('status') in (200, None) and j.get('data') is not None:
                time.sleep(sleep)
                return j['data'], None
            last = f"第{i + 1}把 status={j.get('status') if isinstance(j, dict) else '?'} {str((j or {}).get('msg') or '')[:60]}"
        except urllib.error.HTTPError as e:
            try:
                msg = str(json.loads(e.read().decode('utf-8', 'replace')).get('msg') or '')[:60]
            except Exception:
                msg = ''
            last = f'第{i + 1}把 HTTP {e.code} {msg}'
        except Exception as e:
            last = f'第{i + 1}把 {type(e).__name__}'
    time.sleep(sleep)
    return None, last


def fetch(dataset, parse, y0, y1, data_id=None, tag=''):
    got, errs, shown = {}, {}, False
    for y in range(y0, y1 + 1):
        rows, err = fm_year(dataset, y, data_id)
        if rows is None:
            errs[err] = errs.get(err, 0) + 1
            print(f'  ⚠️ {tag} {y}:{err}', flush=True)
            continue
        if rows and not shown:
            ks = sorted(rows[0].keys())
            nm = sorted({str(r.get('name') or r.get('institutional_investors') or '') for r in rows})[:12]
            print(f'  ℹ️ {tag} 欄位:{ks} ・名稱:{nm}', flush=True)
            shown = True
        p = parse(rows)
        got.update(p)
        print(f'  {tag} {y}:{len(rows)} 列 → {len(p)} 天', flush=True)
    return got, (' ・'.join(f'{k}×{v}' for k, v in errs.items()) or None)


def build(parts, hist, frm, to, check=True):
    """parts = {kind: series}。逐份守門 + 對表 → (產物 dict, 有幾份過關)。"""
    out = {'updated': datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M'), 'from': frm, 'to': to,
           'unit': {'spot': '億元(買−賣;[外資, 投信, 自營];上市)', 'fut': '口(外資台指期大台 多−空 未平倉)', 'mg': '億元(整體融資餘額)',
                    'bs': '點([期貨近月 − 加權, 期貨近月收盤, 加權收盤];負 = 逆價差;一般盤)'},
           'src': {}, 'src_error': {}, 'check': {}}
    good = 0
    for kind, s in parts.items():
        ok, why = guard(s, kind, frm, to)
        if ok and check:
            ok2, why2 = cross_check(s, kind, hist)
            out['check'][kind] = why2
            if not ok2:
                ok, why = False, f'對表沒過:{why2}'
        elif ok:
            out['check'][kind] = '⛔ 沒對表(NO_CHECK=1,只給 selftest 用)'
        if ok:
            out[kind] = {d: s[d] for d in sorted(s)}
            out['src'][kind] = why
            good += 1
        else:
            out['src_error'][kind] = why
        print(f"  {'✅' if ok else '❌'} {kind}:{why}", flush=True)
    return out, good


def main():
    to = date.today().strftime('%Y-%m-%d')
    frm = _date(FROM if len(FROM) > 7 else FROM + '-01') or '2004-01-01'   # 接受 YYYY-MM(workflow 的 from 輸入是月份)
    hist = None
    if RISK_HIST and os.path.exists(RISK_HIST) and os.path.getsize(RISK_HIST) > 0:
        try:
            j = json.load(open(RISK_HIST, encoding='utf-8'))
            hist = j if isinstance(j, list) else (j.get('rows') or j.get('data') or [])
        except Exception as e:
            print(f'❌ RISK_HIST 讀不到:{e}')
    if hist is None and not NO_CHECK:
        print('❌ 沒有 risk_history.json → 沒辦法對表 → ⛔ 不寫(NO_CHECK=1 才可跳過)')
        return 1
    print(f'📉 大盤層級長歷史 {frm} ~ {to} ・token {len([t for t in _tokens() if t])} 把 ・對表快照 {len(hist or [])} 筆', flush=True)
    y0, y1 = int(frm[:4]), int(to[:4])
    spot, e1 = fetch('TaiwanStockTotalInstitutionalInvestors', parse_spot, y0, y1, tag='外資現貨')
    fut, e2 = fetch('TaiwanFuturesInstitutionalInvestors', parse_fut, max(y0, int(FUT_FROM[:4])), y1, data_id='TX', tag='外資台指期')
    mg, e3 = fetch('TaiwanStockTotalMarginPurchaseShortSale', parse_mg, y0, y1, tag='整體融資')
    tx, e4 = fetch('TaiwanFuturesDaily', parse_txnear, y0, y1, data_id='TX', tag='台指期近月')
    ix, e5 = fetch('TaiwanStockPrice', parse_ix, y0, y1, data_id='TAIEX', tag='加權收盤')
    bs = combine_bs(tx, ix)
    print(f'  順逆價差:期貨 {len(tx)} 天 ・加權 {len(ix)} 天 ・兩邊都有 {len(bs)} 天', flush=True)
    parts = {'spot': spot, 'fut': fut, 'mg': mg, 'bs': bs}
    out, good = build(parts, hist, frm, to, check=not NO_CHECK)
    for k, e in (('spot', e1), ('fut', e2), ('mg', e3), ('bs', e4 or e5)):
        if e:
            out['src_error'][f'{k}_fetch'] = e
    if not good:
        print(f'❌ {len(parts)} 份都沒過守門 → ⛔ 不寫')
        return 1
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'✅ 寫入 {OUT}:{good}/{len(parts)} 份過關 ・{os.path.getsize(OUT):,} bytes')
    return 0


def selftest():
    bad = []

    def ok(name, cond, extra=''):
        print(f"  {'✅' if cond else '❌'} {name}{(' ・' + str(extra)) if extra and not cond else ''}")
        if not cond:
            bad.append(name)

    # ① 現貨:英文列舉 + 中文、'total' 不算、元 → 億
    sp = parse_spot([
        {'date': '2026-10-15', 'name': 'Foreign_Investor', 'buy': 100e8, 'sell': 3100e8},
        {'date': '2026-10-15', 'name': 'Foreign_Dealer_Self', 'buy': 1e8, 'sell': 1.5e8},
        {'date': '2026-10-15', 'name': 'Investment_Trust', 'buy': 50e8, 'sell': 20e8},
        {'date': '2026-10-15', 'name': 'Dealer_self', 'buy': 5e8, 'sell': 6e8},
        {'date': '2026-10-15', 'name': 'Dealer_Hedging', 'buy': 2e8, 'sell': 1e8},
        {'date': '2026-10-15', 'name': 'total', 'buy': 999e8, 'sell': 0},
        {'date': '2026/10/16', 'name': '外資及陸資(不含外資自營商)', 'buy': 10e8, 'sell': 5e8},
    ])
    ok('① 現貨 外資 = 外資 + 外資自營、元 → 億', sp.get('2026-10-15', [None])[0] == -3000.5, sp.get('2026-10-15'))
    ok('① 投信 / 自營分開、total 不算', sp['2026-10-15'][1] == 30.0 and sp['2026-10-15'][2] == 0.0, sp.get('2026-10-15'))
    ok('① 中文名稱 + 斜線日期', sp.get('2026-10-16', [None])[0] == 5.0, sp.get('2026-10-16'))
    # ② 期貨:只收外資(⛔ 不三身份加總)
    fu = parse_fut([
        {'date': '2026-10-16', 'institutional_investors': 'Foreign_Investor', 'long_open_interest_balance_volume': 20000, 'short_open_interest_balance_volume': 113675},
        {'date': '2026-10-16', 'institutional_investors': 'Investment_Trust', 'long_open_interest_balance_volume': 50000, 'short_open_interest_balance_volume': 0},
        {'date': '2026-10-15', 'name': '外資及陸資', 'long_open_interest_balance_volume': 1, 'short_open_interest_balance_volume': 11},
    ])
    ok('② 期貨只收外資那一列', fu.get('2026-10-16') == -93675, fu)
    ok('② 名稱欄是 name 也認得', fu.get('2026-10-15') == -10, fu)
    # ③ 融資:只收 MarginPurchaseMoney、元 → 億
    mg = parse_mg([{'date': '2026-10-16', 'name': 'MarginPurchaseMoney', 'TodayBalance': 645590000000},
                   {'date': '2026-10-16', 'name': 'MarginPurchase', 'TodayBalance': 9999999}])
    ok('③ 融資只收金額那一列', mg == {'2026-10-16': 6455.9}, mg)

    # ④ 對表:快照晚 2 天、重複快照只算一次
    days = [(date(2026, 9, 1) + timedelta(days=k)) for k in range(40)]
    days = [d.strftime('%Y-%m-%d') for d in days if d.weekday() < 5]
    fs = {d: -1000 - 997 * i for i, d in enumerate(days)}   # 相鄰兩天差 997 口(> 容差 50),晚太多天才對不上
    hist = []
    for i, d in enumerate(days):
        snap = (datetime.strptime(d, '%Y-%m-%d') + timedelta(days=2)).strftime('%Y-%m-%d')
        hist.append({'date': snap, 'fi_futures_net': fs[d]})
        hist.append({'date': snap, 'fi_futures_net': fs[d]})       # 重複快照
    good, why = cross_check(fs, 'fut', hist)
    ok('④ 快照晚 2 天仍對得上', good, why)
    ok('④ 重複快照只算一次', f'/{len(days)}' in why, why)
    half_fs = {d: v for d, v in fs.items() if d < days[len(days) // 2]}
    good, why = cross_check(half_fs, 'fut', hist)
    ok('④ 我們沒資料的那幾天 ⛔ 不算「對不上」', good, why)
    # ⑤ 注入:單位差 1,000 倍 / 正負號反 / 快照晚 7 天 → 必紅
    good, why = cross_check({d: v * 1000 for d, v in fs.items()}, 'fut', hist)
    ok('⑤ 單位差 1,000 倍 → 對表必紅', not good, why)
    good, why = cross_check({d: -v for d, v in fs.items()}, 'fut', hist)
    ok('⑤ 正負號反 → 對表必紅', not good, why)
    late = [{'date': (datetime.strptime(d, '%Y-%m-%d') + timedelta(days=9)).strftime('%Y-%m-%d'), 'fi_futures_net': fs[d]} for d in days]
    good, why = cross_check(fs, 'fut', late)
    ok('⑤ 快照晚 9 天(超過 4 天)→ 不算對上', not good, why)
    good, why = cross_check(fs, 'fut', hist[:6])
    ok('⑤ 可對表 < 5 筆 → 不算過', not good, why)
    # ⑥ 現貨對表用外資那一格
    ss = {d: [round(-500.5 - i, 2), 1.0, 2.0] for i, d in enumerate(days)}
    hs = [{'date': d, 'fi_spot_net': ss[d][0]} for d in days]
    good, why = cross_check(ss, 'spot', hs)
    ok('⑥ 現貨對表取外資那一格', good, why)
    hs2 = [{'date': d, 'fi_spot_net': ss[d][1]} for d in days]
    good, why = cross_check(ss, 'spot', hs2)
    ok('⑥ 拿投信去對 → 必紅', not good, why)
    # ⑦ 守門:天數 / 起點
    full = {}
    d = date(2004, 1, 2)
    while d <= date(2005, 12, 31):
        if d.weekday() < 5:
            full[d.strftime('%Y-%m-%d')] = [round(1 + len(full) * 0.5, 2), 0, 0]
        d += timedelta(days=1)
    g, why = guard(full, 'spot', '2004-01-01', '2005-12-31')
    ok('⑦ 平日全有 → 過', g, why)
    half = {k: v for i, (k, v) in enumerate(sorted(full.items())) if i % 2}
    g, why = guard(half, 'spot', '2004-01-01', '2005-12-31')
    ok('⑦ 少一半天數 → 不過', not g, why)
    late_s = {k: v for k, v in full.items() if k >= '2004-08-01'}
    g, why = guard(late_s, 'spot', '2004-01-01', '2005-12-31')
    ok('⑦ 起點晚 7 個月 → 不過', not g, why)
    # ⑧ build:一份對表沒過 → 那份不寫、其他照寫;三份都沒過 → good=0
    hist2 = [{'date': d, 'fi_spot_net': full[d][0], 'margin_100m': 7.0} for d in sorted(full)[-30:]]
    out, good = build({'spot': full, 'mg': {d: 999.0 for d in full}}, hist2, '2004-01-01', '2005-12-31')
    ok('⑧ 現貨過、融資對表沒過 → 只寫現貨', good == 1 and 'spot' in out and 'mg' not in out and 'mg' in out['src_error'], (good, out.get('src_error')))
    out, good = build({'spot': {}}, hist2, '2004-01-01', '2005-12-31')
    ok('⑧ 0 天 → good=0', good == 0)
    out, good = build({'spot': full}, None, '2004-01-01', '2005-12-31', check=True)
    ok('⑧ 沒有快照 → 對表不過(⛔ 不可默默當成過)', good == 0, out.get('src_error'))
    # ⑩ V79.3.8 順逆價差:近月 = 最小的單一月份合約、⛔ 夜盤、⛔ 價差單;兩邊都有那天才算
    txr = [
        {'date': '2026-10-16', 'contract_date': '202611', 'close': 23100, 'trading_session': 'position'},
        {'date': '2026-10-16', 'contract_date': '202610', 'close': 23050, 'trading_session': 'position'},
        {'date': '2026-10-16', 'contract_date': '202610', 'close': 22000, 'trading_session': 'after_market'},
        {'date': '2026-10-16', 'contract_date': '202610/202611', 'close': 50, 'trading_session': 'position'},
        {'date': '2026-10-15', 'contract_date': '202610', 'close': 0, 'trading_session': 'position'},
        {'date': '2026-10-15', 'contract_date': '202611', 'close': 22900},
        {'date': '2026-10-14', 'contract_date': '202610', 'close': 22800, 'trading_session': 'position'},
    ]
    txn = parse_txnear(txr)
    ok('⑩ 近月 = 最小的單一月份、⛔ 夜盤、⛔ 價差單、收盤 0 不收', txn.get('2026-10-16') == ('202610', 23050.0) and txn.get('2026-10-15') == ('202611', 22900.0), txn)
    bs = combine_bs(txn, parse_ix([{'date': '2026-10-16', 'close': 23181}, {'date': '2026-10-15', 'close': 22850.5}]))
    ok('⑩ 價差 = 期貨 − 加權(負 = 逆價差)、兩邊都有才算(10-14 沒有加權 → 不算)', bs == {'2026-10-15': [49.5, 22900.0, 22850.5], '2026-10-16': [-131.0, 23050.0, 23181.0]}, bs)
    hb = [{'date': d, 'taifex_backwardation': -100.0 - i} for i, d in enumerate(days)]
    sb = {d: [-100.0 - i, 1.0, 1.0] for i, d in enumerate(days)}
    good, why = cross_check(sb, 'bs', hb)
    ok('⑩ 價差對表取第一格(價差)', good, why)
    good, why = cross_check({d: [-v[0], 1.0, 1.0] for d, v in sb.items()}, 'bs', hb)
    ok('⑩ 正負號反(拿加權 − 期貨)→ 對表必紅', not good, why)
    # ⑨ 金鑰⛔ 不進網址
    src = open(__file__, encoding='utf-8').read()
    needle = 'q[' + "'token']"
    ok('⑨ 金鑰只放標頭(⛔ 進網址參數)', needle not in src and 'Authorization' in src)

    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
