#!/usr/bin/env python3
"""🏪 V80.1.1 上櫃逐股月 K 換成新站 tradingStock —— 走正式入口 miner.tpex_ohlcv,只換網路

為什麼:舊的 st43 從 GitHub runner 打一律回網頁(V80.0.5 實測)→ 上櫃 K 線整條靠 yfinance / 盤中快照,
       最新那根常常是盤中沒收完的(10/30:網站跟官方收盤只有 55% 一樣、量的比值中位 2.1)。
       openapi_daily_probe(2026-10-31,runner 實打)量到新站 tradingStock 打得通,欄位與日期長相寫在測資裡。

釘住:
 ① 正常回應(測資照探針印出來的原樣:民國日期、千分位、成交張數)→ 西元日期、價格、量 ×1000(張 → 股)
 ② 網址:新站 tradingStock、date 是西元 YYYY/MM/01(⛔ 民國 —— 探針實測民國回空表)、⛔ 不再打 st43
 ③ 欄位照名字找:欄位順序換過 → 值照樣對(⭐ 決定性對照:照舊站寫死的位置讀 → 開盤 / 收盤會讀錯)
 ④ 每一列要落在要的那個月:混了別月的列 → 那幾列丟掉;全部都是別月 → None(算被擋,⛔ 不可當成這個月)
 ⑤ 網頁 / HTTP 403 / JSON 壞 → None(被擋);空白 / 空表 → [](真的沒資料)
 ⑥ '--' 收盤 = 那天沒成交 → 不收;開盤 '--' → 用收盤補(記數)
 ⑦ 日期帶星號照樣認得;_roc_to_gregorian 補零
 ⑧ 欄位找不到(格式變了)→ None(⛔ 靜默當沒資料)
 ⑨ 斷路器:連 5 次被擋 → 冷卻期間直接回 None、⛔ 不再打網路
 ⑩ 欄位改成「成交股數」→ 照用(⛔ 再 ×1000)
跑法:python3 scripts/test_tpex_new.py
"""
import contextlib, io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]
import miner as M  # noqa: E402

FAIL = []


def ck(c, m, extra=''):
    print(('✅ ' if c else '❌ ') + m + ('' if c or not extra else f'  {str(extra)[:300]}'))
    if not c:
        FAIL.append(m)


# 探針原樣(6488 2026/10)
FIELDS = ['日 期', '成交張數', '成交仟元', '開盤', '最高', '最低', '收盤', '漲跌', '筆數']
ROWS = [['115/10/01', '24,330', '26,580,157', '1,055.00', '1,135.00', '1,045.00', '1,085.00', '50.00', '39,220'],
        ['115/10/02', '16,256', '18,622,066', '1,090.00', '1,190.00', '1,075.00', '1,190.00', '105.00', '30,486']]


def doc(fields=FIELDS, rows=ROWS):
    return {'date': '20261001', 'stat': 'ok', 'tables': [{'title': '個股日成交資訊', 'date': '115/10/01',
                                                         'fields': fields, 'data': rows}]}


class R:
    def __init__(self, text, code=200):
        self.text, self.status_code = text, code


def reset():
    M._FETCH_HEALTH['tpex'] = {'ok': 0, 'empty': 0, 'blocked': 0, 'skipped': 0, 'streak': 0,
                               'trips': 0, 'open_until': 0.0, 'dead': False, 'why': {}}
    for k in ('bad_num', 'fill_ohl', 'no_vol'):
        M._OHLCV_Q[k] = 0


def call(resp, sym='6488', ym='202610', reset_cb=True):
    """resp = R 物件或 callable(url) → R;回 (結果, 打過的網址, log)"""
    if reset_cb:
        reset()
    urls = []

    def get(url, **kw):
        urls.append(url)
        return resp(url) if callable(resp) else resp

    old = (M.http_session.get, M.time.sleep)
    M.http_session.get = get
    M.time.sleep = lambda *a, **k: None
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            out = M.tpex_ohlcv(sym, ym)
    finally:
        M.http_session.get, M.time.sleep = old
    return out, urls, buf.getvalue()


# ① 正常回應
out, urls, _ = call(R(json.dumps(doc(), ensure_ascii=False)))
ck(isinstance(out, list) and len(out) == 2, '① 兩列都收', out)
ck(out and out[0] == {'date': '2026/10/01', 'open': 1055.0, 'high': 1135.0, 'low': 1045.0, 'close': 1085.0, 'volume': 24330000},
   '① 2026/10/01 開高低收 1055 / 1135 / 1045 / 1085、量 24,330 張 → 24,330,000 股', out[:1])
ck(out and out[1]['close'] == 1190.0 and out[1]['volume'] == 16256000, '① 第二列 10/02 收 1190、量 16,256,000 股', out[1:2])
ck(M._FETCH_HEALTH['tpex']['ok'] == 1, '① 斷路器記一次成功')

# ② 網址
u = urls[0] if urls else ''
ck('/www/zh-tw/afterTrading/tradingStock' in u and 'code=6488' in u and 'date=2026/10/01' in u and 'response=json' in u,
   '② 新站 tradingStock、code=6488、date=2026/10/01(西元)、response=json', u)
ck('115/10' not in u and 'st43' not in u, '② ⛔ 民國日期(探針:民國回空表)、⛔ 舊 st43', u)
_, u2, _ = call(R(json.dumps(doc(), ensure_ascii=False)), ym='202603')
ck(u2 and 'date=2026/03/01' in u2[0], '② 月份補零(202603 → 2026/03/01)', u2)

# ③ 欄位換順序 → 照名字找
perm = [0, 6, 2, 5, 4, 3, 1, 7, 8]     # 把收盤放到第 2 格、開盤放到第 6 格…
F3 = [FIELDS[i] for i in perm]
R3 = [[r[i] for i in perm] for r in ROWS]
out3, _, _ = call(R(json.dumps(doc(F3, R3), ensure_ascii=False)))
ck(out3 and out3[0] == out[0], '③ 欄位順序換過 → 值完全一樣(照名字找)', out3[:1])
# 決定性對照:照舊站寫死的位置(row[3] 開盤、row[6] 收盤、row[1] 量)讀同一份 → 一定讀錯
old_way = {'open': float(R3[0][3].replace(',', '')), 'close': float(R3[0][6].replace(',', ''))}
ck(old_way != {'open': 1055.0, 'close': 1085.0}, '③ ⭐ 決定性對照:寫死位置讀同一份 → 開盤 / 收盤讀錯(證明測資真的換了順序)', old_way)

# ④ 月份
R4 = ROWS + [['115/09/30', '10,000', '1', '1,000.00', '1,010.00', '990.00', '1,000.00', '0', '1']]
out4, _, _ = call(R(json.dumps(doc(rows=R4), ensure_ascii=False)))
ck(out4 and len(out4) == 2 and all(b['date'].startswith('2026/10/') for b in out4), '④ 混了一列 9/30 → 那一列丟掉、10 月兩列照收', out4)
R4b = [['115/09/29', '10,000', '1', '1,000.00', '1,010.00', '990.00', '1,000.00', '0', '1'],
       ['115/09/30', '10,000', '1', '1,000.00', '1,010.00', '990.00', '1,000.00', '0', '1']]
out4b, _, log4b = call(R(json.dumps(doc(rows=R4b), ensure_ascii=False)))
ck(out4b is None and M._FETCH_HEALTH['tpex']['why'].get('月份不對') == 1 and '不是 2026/10' in log4b,
   '④ 全部都是 9 月(網址日期沒被吃進去)→ None + 斷路器記「月份不對」+ log 寫原因', (out4b, M._FETCH_HEALTH['tpex']['why'], log4b[-160:]))

# ⑤ 被擋 vs 沒資料
o, _, _ = call(R('<!DOCTYPE html><html>擋</html>'))
ck(o is None and M._FETCH_HEALTH['tpex']['why'].get('HTML') == 1, '⑤ 網頁 → None(被擋,記 HTML)')
o, _, _ = call(R('', 403))
ck(o is None and M._FETCH_HEALTH['tpex']['why'].get('HTTP403') == 1, '⑤ HTTP 403 → None')
o, _, _ = call(R('{"stat":'))
ck(o is None and M._FETCH_HEALTH['tpex']['why'].get('JSON壞') == 1, '⑤ JSON 壞 → None')
o, _, _ = call(R('   '))
ck(o == [] and M._FETCH_HEALTH['tpex']['empty'] == 1, '⑤ 空白 → [](真的沒資料)')
o, _, _ = call(R(json.dumps({'stat': 'ok', 'tables': [{'fields': FIELDS, 'data': []}]})))
ck(o == [] and M._FETCH_HEALTH['tpex']['empty'] == 1 and M._FETCH_HEALTH['tpex']['blocked'] == 0,
   '⑤ 空表(不是上櫃股 / 這個月沒交易)→ [],⛔ 不算被擋')

# ⑥ '--'
R6 = [['115/10/01', '0', '0', '--', '--', '--', '--', '--', '0'],
      ['115/10/02', '1,000', '1', '--', '1,190.00', '1,075.00', '1,190.00', '0', '1']]
out6, _, _ = call(R(json.dumps(doc(rows=R6), ensure_ascii=False)))
ck(out6 and len(out6) == 1 and out6[0]['date'] == '2026/10/02', '⑥ 收盤 -- 那天不收(⛔ 不可變成 0 元的 K 棒)', out6)
ck(out6 and out6[0]['open'] == 1190.0 and M._OHLCV_Q['fill_ohl'] == 1, '⑥ 開盤 -- → 用收盤補而且記數', (out6, M._OHLCV_Q['fill_ohl']))

# ⑦ 星號 / 補零
R7 = [['115/10/01*', '24,330', '1', '1,055.00', '1,135.00', '1,045.00', '1,085.00', '0', '1'],
      ['＊115/10/02', '16,256', '1', '1,090.00', '1,190.00', '1,075.00', '1,190.00', '0', '1']]
out7, _, _ = call(R(json.dumps(doc(rows=R7), ensure_ascii=False)))
ck(out7 and [b['date'] for b in out7] == ['2026/10/01', '2026/10/02'], '⑦ 日期帶星號(半形 / 全形)照樣認得', out7)
ck(M._roc_to_gregorian('115/5/2') == '2026/05/02' and M._roc_to_gregorian(' 115/05/02 ') == '2026/05/02',
   '⑦ _roc_to_gregorian 補零、去空白(上市 STOCK_DAY 本來的格式不變)')

# ⑧ 欄位找不到
out8, _, log8 = call(R(json.dumps(doc(fields=['日 期', '成交張數', '開盤', '最高', '最低', '價格'], rows=ROWS), ensure_ascii=False)))
ck(out8 is None and M._FETCH_HEALTH['tpex']['why'].get('欄位變了') == 1 and '欄位找不到' in log8,
   '⑧ 沒有「收盤」欄 → None + 記「欄位變了」+ log 印欄位(⛔ 靜默當沒資料)', (out8, log8[-160:]))

# ⑨ 斷路器
reset()
n_calls = []
for _ in range(5):
    o, us, _ = call(R('<!DOCTYPE html>'), reset_cb=False)
    n_calls.append(len(us))
o, us, _ = call(R(json.dumps(doc(), ensure_ascii=False)), reset_cb=False)
h = M._FETCH_HEALTH['tpex']
ck(h['trips'] == 1 and o is None and us == [] and h['skipped'] == 1,
   '⑨ 連 5 次被擋 → 冷卻:第 6 次直接回 None、⛔ 不打網路', (h, us))

# ⑩ 成交股數
F10 = ['日 期', '成交股數', '成交金額', '開盤', '最高', '最低', '收盤', '漲跌', '筆數']
R10 = [['115/10/01', '24,330,512', '1', '1,055.00', '1,135.00', '1,045.00', '1,085.00', '0', '1']]
out10, _, _ = call(R(json.dumps(doc(F10, R10), ensure_ascii=False)))
ck(out10 and out10[0]['volume'] == 24330512, '⑩ 欄位改成「成交股數」→ 照用(⛔ 再 ×1000)', out10)

# ⑪ run() 慢路徑仍呼叫 tpex_ohlcv(sym, ym)(⛔ 換來源時漏接)
src = open(os.path.join(ROOT, 'miner.py'), encoding='utf-8').read()
ck(src.count('rows = tpex_ohlcv(sym, ym)') >= 2 and 'st43_result.php' not in src,
   '⑪ run() 慢路徑照舊呼叫 tpex_ohlcv、全檔 ⛔ 再有 st43 網址')

print(f"\n{'❌ ' + str(len(FAIL)) + ' 條失敗' if FAIL else '✅ 全過'}")
sys.exit(1 if FAIL else 0)
