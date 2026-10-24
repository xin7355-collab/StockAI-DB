#!/usr/bin/env python3
"""🧾 V79.6.6 上市融資融券:改用證交所「帶日期」那份 + 只在證明得了日期時才收 OpenAPI + 驗過的才蓋掉 K 線舊值

為什麼(2026-10-24 核對颱風假那根假 K 時發現):
  上市股融資從 2026-05 起錯位 —— 證交所 rwd MI_MARGN(帶日期)的個股表 id 欄叫「代號」、欄名沒有「融資 / 融券」,
  舊版找「股票代號」找不到就整張放棄,改用 OpenAPI(⛔ 沒有日期參數,永遠回最新一天)寫成當天;
  傍晚證交所還沒更新時那份是**前一天**的 → 逐日相關:當天漲跌跟「隔天那格」融資變化最相關(上櫃對照組正常);
  05-13~06-11 那一個月更是每天都跟前一天一模一樣。而 K 線「只補 0」的規則讓錯的永遠留著。

走正式入口(fetch_market_margin / _twse_margin_parse / _twse_oapi_check / _margin_apply),網路全部換成假的:
  ① 帶日期那份五道關卡:日期對不上 / 欄位看不懂 / 「今日 = 前日 + 買 − 賣 − 償還」對不上 / 太少 / 融資 ≤ 融券 → 整張不收
  ② OpenAPI:它的「前日餘額」= 本輪前一個交易日帶日期那份 → 收;它的「今日餘額」= 前一天 → 還沒更新,⛔ 不收
  ③ fetch_market_margin 實跑:最新一天、非最新一天、只抓上市(回補)、OpenAPI 舊的 ⛔ 收(決定性對照:舊寫法會收)
  ④ _margin_apply:帶 dt 的才蓋掉;沒有 dt 的只補 0(決定性對照)
  ⑤ 接線:主迴圈傳 prev_twse、回補視窗走 MARGIN_TWSE_DAYS(workflow 有 input)、法人那段 ⛔ 拿 0 蓋掉融資
"""
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('FINMIND_TOKENS', '')
import miner  # noqa: E402

bad = 0


def ok(c, name, extra=''):
    global bad
    print(('✅ ' if c else '❌ ') + name + (f' — {extra}' if extra else ''))
    if not c:
        bad += 1


FIELDS = ['代號', '名稱', '買進', '賣出', '現金償還', '前日餘額', '今日餘額', '次一營業日限額',
          '買進', '賣出', '現券償還', '前日餘額', '今日餘額', '次一營業日限額', '資券互抵', '註記']
# 🧾 證交所真實的 groups 只有 span、沒有 start(2026-10-24 macro_probe which=twse_margin 實測;第一版測資自己編了 start = 陷阱 #40)
GROUPS = [{'title': '股票', 'span': 2}, {'title': '融資', 'span': 6}, {'title': '融券', 'span': 6}, {'title': '', 'span': 1}, {'title': '', 'span': 1}]
GROUPS_START = [{'start': 2, 'span': 6, 'title': '融資'}, {'start': 8, 'span': 6, 'title': '融券'}]   # 有 start 的寫法也要認


def syms(n=400):
    out = ['2330', '1303', '2317', '0050', '00400A']
    i = 1101
    while len(out) < n:
        s = str(i)
        if s not in out:
            out.append(s)
        i += 1
    return out


def stock_rows(seed, n=400, prev_map=None):
    """合成一天的個股列:今日 = 前日 + 買 − 賣 − 償還(融資)、前日 + 賣 − 買 − 償還(融券)。
    prev_map 給的話,前日餘額照它(模擬「前一天的今日 = 今天的前日」)。"""
    rows, today = [], {}
    for k, s in enumerate(syms(n)):
        pm = prev_map[s][0] if prev_map else 1000 + (k * 37 + seed * 11) % 50000
        ps = prev_map[s][1] if prev_map else 10 + (k * 13 + seed * 7) % 900
        mb, msell, mrep = (k * 7 + seed) % 300, (k * 5 + seed * 3) % 250, (k + seed) % 9
        sbuy, ssell, srep = (k * 3 + seed) % 40, (k * 2 + seed * 5) % 45, (k + seed * 2) % 3
        tm = max(0, pm + mb - msell - mrep)
        ts = max(0, ps + ssell - sbuy - srep)
        if tm != pm + mb - msell - mrep:
            mrep = pm + mb - msell - tm
        if ts != ps + ssell - sbuy - srep:
            srep = ps + ssell - sbuy - ts
        rows.append([s, f'名{s}', f'{mb:,}', f'{msell:,}', f'{mrep:,}', f'{pm:,}', f'{tm:,}', '6,666,666',
                     f'{sbuy:,}', f'{ssell:,}', f'{srep:,}', f'{ps:,}', f'{ts:,}', '6,666,666', '0', ''])
        today[s] = (tm, ts)
    return rows, today


def rwd_json(d, rows, groups=True, title_date=None, jdate=None, fields=None):
    roc = title_date or f"{d.year - 1911}年{d.month:02d}月{d.day:02d}日"
    t = {'title': f'{roc} 融資融券彙總 (全部)', 'fields': fields or FIELDS, 'data': rows}
    if groups:
        t['groups'] = GROUPS
    return {'stat': 'OK', 'date': jdate if jdate is not None else d.strftime('%Y%m%d'),
            'tables': [{'title': f'{roc} 信用交易統計', 'fields': ['項目', '買進', '賣出', '現金(券)償還', '前日餘額', '今日餘額'],
                        'data': [['融資(交易單位)', '1', '2', '3', '4', '5']]}, t]}


D1, D2 = date(2026, 10, 21), date(2026, 10, 22)
rows1, today1 = stock_rows(1)
rows2, today2 = stock_rows(2, prev_map=today1)

# ── ① 帶日期那份五道關卡
res, prev, why = miner._twse_margin_parse(rwd_json(D2, rows2), D2)
ok(len(res) == 400 and why == '', '①a 帶日期那份(有 groups)收得下來', why or f'{len(res)} 檔')
ok(res['2330'] == {'margin_balance': today2['2330'][0], 'short_balance': today2['2330'][1], 'dt': 1},
   '①a2 融資 / 融券對到「今日餘額」那兩欄,而且帶 dt', str(res.get('2330')))
ok(prev['2330'] == today1['2330'][0], '①a3 前日餘額記下來(= 前一天的今日餘額)', f"{prev.get('2330')} vs {today1['2330'][0]}")
res_ng, _, why_ng = miner._twse_margin_parse(rwd_json(D2, rows2, groups=False), D2)
ok(len(res_ng) == 400 and res_ng['1303'] == res['1303'], '①b 沒有 groups → 用「現金償還 / 現券償還」當錨點,結果一樣', why_ng)
_, _, w = miner._twse_margin_parse(rwd_json(D2, rows2, title_date='115年10月21日'), D2)
ok('表名日期' in w, '①c 表名日期 ≠ 要的那天 → 整張不收', w)
_, _, w = miner._twse_margin_parse(rwd_json(D2, rows2, jdate='20261021'), D2)
ok('回應日期' in w, '①d 回應的 date ≠ 要的那天 → 整張不收', w)
rows_off = [list(r) for r in rows2]
for r in rows_off[:150]:                                              # 前 150 列有資券互抵:融資、融券今日餘額都再扣掉它
    r[14] = '3'; r[6] = f"{int(r[6].replace(',', '')) - 3:,}"; r[12] = f"{max(0, int(r[12].replace(',', '')) - 3):,}"
r_off, _, w_off = miner._twse_margin_parse(rwd_json(D2, rows_off), D2)
ok(len(r_off) == 400, '①d2 有資券互抵的列(今日 = 前日 + 買 − 賣 − 償還 − 互抵)也算對得上 → 照收', w_off)
f_sw = list(FIELDS); f_sw[5], f_sw[6] = '今日餘額', '前日餘額'           # 表頭寫反(或資料欄位順序變了)
_, _, w = miner._twse_margin_parse(rwd_json(D2, rows2, fields=f_sw), D2)
ok('對得上' in w, '①e 「今日 = 前日 + 買 − 賣 − 償還」對不上(前日 / 今日抓反)→ 整張不收', w)
g_sw = [{'start': 2, 'span': 6, 'title': '融券'}, {'start': 8, 'span': 6, 'title': '融資'}]
j_sw = rwd_json(D2, rows2); j_sw['tables'][1]['groups'] = g_sw
r_sw, _, w = miner._twse_margin_parse(j_sw, D2)
ok(not r_sw, '①f 融資 / 融券兩段對調 → 整張不收(償還欄名對不上)', w)
_, _, w = miner._twse_margin_parse({'stat': '很抱歉，沒有符合條件的資料'}, D2)
ok(w.startswith('stat='), '①g stat ≠ OK(休市 / 還沒公布)→ 不收', w)
_, _, w = miner._twse_margin_parse(rwd_json(D2, rows2[:120]), D2)
ok('只解出' in w, '①g2 太少(< 300 檔)→ 不收', w)
f_nocash = [x if x != '現金償還' else '償還' for x in FIELDS]
ok(miner._twse_margin_cols(f_nocash, None) is None, '①h 沒有 groups 又找不到「現金償還」→ 看不懂,⛔ 不猜位置')
ok(miner._twse_margin_cols(FIELDS, GROUPS)['m']['today'] == 6 and miner._twse_margin_cols(FIELDS, GROUPS)['s']['today'] == 12,
   '①i 標準欄位:融資今日餘額 = 第 6 欄、融券今日餘額 = 第 12 欄')
# 舊寫法的決定性對照:找「股票代號 / 證券代號」+ 欄名要有「融資」→ 這張表一定找不到(這就是 2026-06 起的病)
old_id = [i for i, f in enumerate(FIELDS) if '股票代號' in f or '證券代號' in f]
old_m = [i for i, f in enumerate(FIELDS) if '融資' in f and '餘額' in f]
ok(not old_id and not old_m, '①j 決定性對照:舊寫法的找法在這張表上一定找不到(id 欄叫「代號」、欄名沒有「融資」)')
# ①k ⭐ groups 要真的被用到(⛔ 只靠錨點那條路):多一個「買進」欄 → 錨點切兩段一定切錯 → 只有照 groups(span 累加)才找得到
FIELDS_X = ['代號', '名稱', '買進'] + FIELDS[2:]
GROUPS_X = [{'title': '股票', 'span': 3}, {'title': '融資', 'span': 6}, {'title': '融券', 'span': 6}, {'title': '', 'span': 1}, {'title': '', 'span': 1}]
cx = miner._twse_margin_cols(FIELDS_X, GROUPS_X)
ok(cx is not None and cx['m']['buy'] == 3 and cx['m']['today'] == 7 and cx['s']['today'] == 13,
   '①k 真實格式的 groups(只有 span)照左到右累加找到兩段 —— 多一個「買進」欄也找得對', str(cx))
ok(miner._twse_margin_cols(FIELDS_X, None) is None, '①k2 ⭐ 決定性對照:同一張表拿掉 groups → 錨點那條路找不到(證明 ①k 是 groups 找到的)')
ok(miner._twse_margin_cols(FIELDS, GROUPS_START) == miner._twse_margin_cols(FIELDS, GROUPS) == miner._twse_margin_cols(FIELDS, None),
   '①l 有 start 的寫法、只有 span 的寫法、沒有 groups(錨點)三種結果一樣')
g_bad = [{'title': '股票', 'span': 'x'}, {'title': '融資', 'span': 6}, {'title': '融券', 'span': 6}]
ok(miner._twse_margin_cols(FIELDS, g_bad) == miner._twse_margin_cols(FIELDS, None),
   '①m groups 有一組看不懂 → 後面位置都不可信 → 整份不用、退回錨點(⛔ 用錯位的段)')

# ── ② OpenAPI 只在證明得了日期時才收
def oapi_rows(today_map, prev_map):
    return [{'股票代號': s, '股票名稱': f'名{s}', '融資買進': '1', '融資賣出': '1', '融資現金償還': '0',
             '融資前日餘額': f'{prev_map[s][0]:,}', '融資今日餘額': f'{today_map[s][0]:,}', '融資限額': '1',
             '融券今日餘額': f'{today_map[s][1]:,}'} for s in today_map]
prev_twse1 = {s: v[0] for s, v in today1.items()}
o_res, o_why = miner._twse_oapi_check(oapi_rows(today2, today1), prev_twse1)
ok(len(o_res) == 400 and o_res['2330']['dt'] == 1 and o_res['2330']['margin_balance'] == today2['2330'][0],
   '②a OpenAPI 的前日餘額 = 本輪前一天帶日期那份 → 證明是今天的,收(帶 dt)', o_why)
o_res, o_why = miner._twse_oapi_check(oapi_rows(today1, {s: (v[0] - 5, v[1]) for s, v in today1.items()}), prev_twse1)
ok(not o_res and '還沒更新' in o_why, '②b OpenAPI 的今日餘額 = 前一天 → 證交所還沒更新(其實是前一天的),⛔ 不收', o_why)
o_res, o_why = miner._twse_oapi_check(oapi_rows(today2, today1), None)
ok(not o_res and '驗不了' in o_why, '②c 沒有前一天帶日期的資料 → 驗不了日期,⛔ 不收', o_why)
# ②d OpenAPI 的 0 有時是空字串(2026-10-24 實測 1,302 列只有 736 列三欄都是數字)→ 欄位在、但是空的 = 0(V79.6.5 舊版也是 `or 0`)
rows_e = oapi_rows(today2, today1)
for k_, r_ in enumerate(rows_e):
    if k_ % 2 == 0:
        r_['融券今日餘額'] = ''
o_res, o_why = miner._twse_oapi_check(rows_e, prev_twse1)
_e0 = rows_e[0]['股票代號']
ok(len(o_res) == 400 and o_res[_e0]['short_balance'] == 0, '②d OpenAPI 空字串 = 0 → 照收(⛔ 一半的股票整列不見)', f'{len(o_res)} 檔 {o_why}')
rows_m = oapi_rows(today2, today1)
for k_, r_ in enumerate(rows_m):
    if k_ % 4 == 0:                       # 拿掉 100 列(剩 300 列 = 驗日期的下限,⛔ 低於 300 整份不收)
        del r_['融券今日餘額']
o_res, o_why = miner._twse_oapi_check(rows_m, prev_twse1)
ok(len(o_res) == 300 and rows_m[0]['股票代號'] not in o_res, '②d2 ⭐ 決定性對照:欄位根本不在 = 不知道 → 那一列 ⛔ 收(⛔ 當 0)', f'{len(o_res)} 檔 {o_why}')

# ── ③ fetch_market_margin 實跑(假網路)
class R:
    def __init__(self, j, code=200):
        self._j, self.status_code, self.text = j, code, json.dumps(j, ensure_ascii=False)[:300]

    def json(self):
        return self._j


CALLS = []
STATE = {'rwd': {}, 'oapi': None}


def fake_get(url, headers=None, timeout=None, **k):
    CALLS.append(url)
    if 'twse.com.tw/rwd/zh/marginTrading/MI_MARGN' in url:
        m = re.search(r'date=(\d{8})', url)
        return R(STATE['rwd'].get(m.group(1), {'stat': '很抱歉，沒有符合條件的資料'}))
    if 'openapi.twse.com.tw' in url:
        return R(STATE['oapi'] if STATE['oapi'] is not None else [])
    if 'tpex.org.tw' in url:
        return R({'tables': [{'title': '上櫃股票融資融券餘額', 'data': [], 'fields': []}], 'stat': 'ok'})
    return R({}, 404)


miner.http_session.get = fake_get
miner.time.sleep = lambda *a, **k: None
miner.fm_request = lambda *a, **k: {'data': []}
miner.CHIP_WATCHLIST = []        # yfinance 第三條源 ⛔ 打網路

STATE['rwd'] = {'20261021': rwd_json(D1, rows1), '20261022': rwd_json(D2, rows2)}
r = miner.fetch_market_margin(D2, is_latest=True, prev_twse=prev_twse1)
src = getattr(miner.fetch_market_margin, 'last_src', {})
ok(r.get('2330', {}).get('dt') == 1 and r['2330']['margin_balance'] == today2['2330'][0] and src.get('twse_dated'),
   '③a 最新一天:證交所帶日期那份收下來(dt)、_src 記 twse_dated', json.dumps(src, ensure_ascii=False)[:120])
ok(not any('openapi' in u for u in CALLS), '③a2 帶日期那份有了 → ⛔ 不打 OpenAPI')
ok((miner.fetch_market_margin.last_twse or {}).get('2330') == today2['2330'][0], '③a3 last_twse 給下一天驗 OpenAPI 用')
CALLS.clear()
r = miner.fetch_market_margin(D1, is_latest=False)
ok(r.get('1303', {}).get('dt') == 1, '③b 非最新一天:帶日期那份照收(⭐ 以前這種日子上市一檔都沒有)')
# 最新一天但證交所還沒公布(rwd 沒資料)+ OpenAPI 還是前一天的
STATE['rwd'] = {'20261021': rwd_json(D1, rows1)}
STATE['oapi'] = oapi_rows(today1, {s: (v[0] - 5, v[1]) for s, v in today1.items()})
CALLS.clear()
r = miner.fetch_market_margin(D2, is_latest=True, prev_twse=prev_twse1)
ok('2330' not in r and any('openapi' in u for u in CALLS), '③c 證交所還沒公布 + OpenAPI 是前一天的 → 上市 ⛔ 收(寧可那天沒有)',
   miner.fetch_market_margin.last_src.get('twse_why', '')[:100])
# 決定性對照:舊寫法(OpenAPI 直接收)會把前一天的數字寫成今天
old_like = {row['股票代號']: int(row['融資今日餘額'].replace(',', '')) for row in STATE['oapi']}
ok(old_like['2330'] == today1['2330'][0] != today2['2330'][0], '③c2 決定性對照:舊寫法照收 → 2330 那格會是前一天的數字')
STATE['oapi'] = oapi_rows(today2, today1)
r = miner.fetch_market_margin(D2, is_latest=True, prev_twse=prev_twse1)
ok(r.get('2330', {}).get('margin_balance') == today2['2330'][0] and r['2330'].get('dt') == 1,
   '③d 證交所 rwd 還沒有、但 OpenAPI 證明得了是今天的 → 收')
STATE['rwd'] = {'20261021': rwd_json(D1, rows1)}
CALLS.clear()
r = miner.fetch_market_margin(D1, is_latest=False, twse_only=True)
ok(r.get('2317', {}).get('dt') == 1 and not any('tpex' in u or 'openapi' in u for u in CALLS),
   '③e 只抓上市(回補用)→ ⛔ 不打上櫃 / OpenAPI', ' | '.join(u.split('/')[2] for u in CALLS))

# ── ④ _margin_apply
em = {'2026/10/21': {'date': '2026/10/21', 'margin_balance': 111, 'short_balance': 2},
      '2026/10/22': {'date': '2026/10/22', 'margin_balance': 0, 'short_balance': 0},
      '2026/10/20': {'date': '2026/10/20', 'margin_balance': 50, 'short_balance': 1}}
mc = {'2026-10-21': {'2330': {'margin_balance': 120, 'short_balance': 3, 'dt': 1}},
      '2026-10-22': {'2330': {'margin_balance': 130, 'short_balance': 4}},
      '2026-10-20': {'2330': {'margin_balance': 77, 'short_balance': 9}},
      '_src': {'2026-10-21': {'twse_dated': True}}}
f, x = miner._margin_apply(em, mc, '2330')
ok(em['2026/10/21']['margin_balance'] == 120 and em['2026/10/21']['short_balance'] == 3 and x == 1,
   '④a 帶 dt 而且跟 K 線不一樣 → 蓋掉(校正 1 列)', str(em['2026/10/21']))
ok(em['2026/10/20']['margin_balance'] == 50, '④b 決定性對照:沒有 dt 的 ⛔ 蓋掉已經有的值(照舊只補 0)')
ok(em['2026/10/22']['margin_balance'] == 130 and f == 1, '④c K 線原本是 0 → 補上(舊規則,任何來源)')
f2, x2 = miner._margin_apply(em, mc, '2330')
ok(f2 == 0 and x2 == 0, '④d 一樣的不動(第二次跑不再算改了)')
ok(miner._margin_apply(em, {'_src': {'2026-10-21': {'2330': {'margin_balance': 1}}}}, '2330') == (0, 0), '④e 底線鍵(_src)跳過')

# ── ⑤ 接線(原始碼)
SRC = (ROOT / 'miner.py').read_text(encoding='utf-8')
ok('prev_twse=_prev_twse' in SRC and "_prev_twse = getattr(fetch_market_margin, 'last_twse', None) or _prev_twse" in SRC,
   '⑤a 主迴圈把前一個交易日帶日期那份傳給下一天(驗 OpenAPI 用)')
ok("int(os.environ.get('MARGIN_TWSE_DAYS') or 0)" in SRC and 'twse_only=True' in SRC, '⑤b 回補視窗走 MARGIN_TWSE_DAYS(空字串 → 0)、只抓上市')
ok('_margin_apply(existing_map, margin_cache, sym)' in SRC
   and "if fmt_date in existing_map and existing_map[fmt_date].get('margin_balance', 0) == 0:" not in SRC,
   '⑤c K 線寫融資只走 _margin_apply(舊的「只補 0」迴圈拿掉了)')
ok('                        rec.update(chip)\n' not in SRC and '_has_m' in SRC, '⑤d 法人先到時 ⛔ 拿 0 蓋掉已經有的融資')
WF = (ROOT / '.github/workflows/daily_miner.yml').read_text(encoding='utf-8')
ok('margin_twse_days:' in WF and 'MARGIN_TWSE_DAYS: ${{ github.event.inputs.margin_twse_days }}' in WF,
   '⑤e daily_miner 手動派可以填 margin_twse_days,採礦節點吃得到')

# ── ⑥ 前端:證交所當天的融資晚上才公布 → 傍晚那輪最新一根是空的(0)→ 籌碼頁融資走勢只畫到最後一天有資料那根
#    ⭐ 跑 index.html 裡那支函式原文(⛔ 測試裡不抄一份邏輯)
import subprocess  # noqa: E402
HTML = (ROOT / 'index.html').read_text(encoding='utf-8')
m_fn = re.search(r'\n    _marginTrimTail\(arr\) \{\n(.*?)\n    \},\n', HTML, re.S)
ok(m_fn is not None, '⑥0 空過守門:切得到 index.html 的 _marginTrimTail')
if m_fn:
    cases = {
        'tail0': [{'margin': 5, 'short': 1}, {'margin': 6, 'short': 1}, {'margin': 0, 'short': 0}, {'margin': 0, 'short': 0}],
        'shortOnly': [{'margin': 5, 'short': 1}, {'margin': 0, 'short': 3}],
        'mid0': [{'margin_balance': 5, 'short_balance': 0}, {'margin_balance': 0, 'short_balance': 0}, {'margin_balance': 7, 'short_balance': 0}],
        'all0': [{'margin': 0, 'short': 0}, {'margin': 0, 'short': 0}],
        'raw': [{'margin_balance': 35330, 'short_balance': 6}, {'margin_balance': 0, 'short_balance': 0}],
        'empty': [],
    }
    js = ('const f = function (arr) {\n' + m_fn.group(1) + '\n};\nconst C = ' + json.dumps(cases)
          + ';\nconst o = {}; for (const k in C) o[k] = f(C[k]).length;\nconsole.log(JSON.stringify(o));')
    pr = subprocess.run(['node', '-e', js], capture_output=True, text=True, timeout=30)
    try:
        L = json.loads(pr.stdout.strip().splitlines()[-1])
    except Exception:
        L = {}
    ok(L.get('tail0') == 2 and L.get('raw') == 1, '⑥a 最後幾根融資券都是 0(還沒公布)→ 只畫到前一根', f'{L} {pr.stderr[:120]}')
    ok(L.get('shortOnly') == 2 and L.get('mid0') == 3, '⑥b 只有融券有值的那根照畫;中間某天是 0 ⛔ 動(只剪尾巴)', str(L))
    ok(L.get('all0') == 2 and L.get('empty') == 0, '⑥c 全部是 0 → 原封不動(交給原本「融資券抓取資料失敗」那段)', str(L))
_ct = HTML[HTML.index('    _renderChipTimeline(instData, marginData) {'):]
_ct = _ct[:_ct.index('\n    },\n')]
ok('const mLine = this._marginTrimTail(marginData);' in _ct and "data: mLine.map(d => d.date.slice(5))" in _ct
   and "data: mLine.map(d => d.margin_balance ?? d.margin_bal ?? d.margin ?? 0)" in _ct
   and "data: marginData.map(d => d.margin_balance ?? d.margin_bal ?? d.margin ?? 0)" not in _ct,
   '⑥d 融資走勢的 X 軸和那條線都用剪過的 mLine(⭐ 決定性對照:舊寫法 marginData.map 會畫到 0)')

print(f"\n{'✅ MARGIN_DATED_PASS' if bad == 0 else f'❌ {bad} 項失敗'}")
sys.exit(1 if bad else 0)
