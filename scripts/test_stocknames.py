#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏷️ V75.1.4 `miner.build_stock_names` —— 前端股名的離線來源。

🚨 背景:前端 `fetchStockList` 本來**只靠 FinMind 匿名 API**(而且那支 URL 連 token 都沒帶),
   它被擋之後 `allStockList` 變空 → 名字全變代號(使用者截圖:009816 印兩次),
   ⛔ 更嚴重的是 `_filterStockList` 清單空就 return [] → **搜尋整個失效**、零錯誤訊息。

⛔ 釘死八件事:
  ① 官方公司表(`_COMPANY_NAME`,零額外 API)要進表,而且帶產業別
  ② ETF 從 etf_tracking.json 保底,⛔ 只補前面沒有的(不覆蓋)
  ③ 🚧 <1500 檔 ⛔ 不覆寫舊檔(半份表比沒有更糟)
  ④ 合併舊檔:這輪某來源掛掉,舊名字要留著
  ⑤ `src` 分類統計要誠實(0 檔要說得出為什麼)
  ⑥ ETF 太少要**主動示警**
  ⑦ 壞掉的 etf_tracking ⛔ 不可讓整支炸掉
  ⑧ ⭐ **每日收盤行情**那層(ETF 名字的正解,探針 2026-09-09 定案):
     ・名字要進表、⛔ 不覆蓋官方表
     ・🚨 **權證一定要濾掉** —— 而且⛔ 不可用代號格式判(`00981A` 跟 `03013T` 格式一模一樣),
       只能拿 `data/{code}.json` 存不存在當白名單
     ・沒有白名單(data/ 空)→ ⛔ 整層跳過(寧可沒名字,也不可混進 4 千檔權證)
     ・HTTP 掛掉 ⛔ 不可靜默、也不可炸掉整支

⚠️ 測試在暫存目錄跑,⛔ 不可污染 repo 的 data/。
⚠️ 🚧 `http_session.get` 一律 stub —— 沙箱連不到 TWSE/TPEx,不 stub 的話會等兩次 30 秒 timeout,
   而且「那層有沒有作用」會取決於網路,測不出東西(陷阱 #40)。
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

fails = 0


def ok(name, cond, extra=''):
    global fails
    print(f"{'✅' if cond else '❌'} {name}" + ('' if cond else f"  {str(extra)[:220]}"))
    if not cond:
        fails += 1


class _Resp:
    def __init__(self, status, payload):
        self.status_code = status
        self._p = payload

    def json(self):
        return self._p


def run(company_names, etf_rows=None, old=None, quotes=None, data_syms=None,
        quote_status=200, no_data_dir=False):
    """在乾淨的暫存 cwd 裡跑一次 build_stock_names,回 (寫進去的檔數, 產物 dict or None, stdout)."""
    import io
    import contextlib
    import miner

    with tempfile.TemporaryDirectory() as td:
        cwd = os.getcwd()
        _orig_get = miner.http_session.get
        try:
            os.chdir(td)
            Path('data').mkdir(exist_ok=True)
            for _sy in (data_syms or []):
                Path('data', f'{_sy}.json').write_text('[]', encoding='utf-8')
            if etf_rows is not None:
                Path('data/etf_tracking.json').write_text(
                    json.dumps({'concentration': etf_rows, 'etfs': []}, ensure_ascii=False), encoding='utf-8')
            if old is not None:
                Path('data/stock_names.json').write_text(
                    json.dumps({'names': old}, ensure_ascii=False), encoding='utf-8')

            def _fake_get(url, **kw):
                for key, rows in (quotes or {}).items():
                    if key in url:
                        return _Resp(quote_status, rows)
                return _Resp(404, {})
            miner.http_session.get = _fake_get

            miner._COMPANY_NAME = dict(company_names)
            imap = {k: '半導體業' for k in company_names if k.startswith('2')}

            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                n = miner.build_stock_names(imap)
            out = None
            _p = Path('data/stock_names.json')
            if _p.exists():
                out = json.loads(_p.read_text(encoding='utf-8'))
            return n, out, buf.getvalue()
        finally:
            miner.http_session.get = _orig_get
            os.chdir(cwd)


# ── 測資:2,000 檔一般股(過門檻)──
BIG = {str(1000 + i): f'股{i}' for i in range(2000)}
BIG['2330'] = '台積電'
BIG['5483'] = '中美晶'

# ══ ① 官方表進表 + 帶產業別 ══
n, out, log = run(BIG)
ok('① 官方公司表的名字有寫進去', n >= 2000 and out and out['names'].get('2330', [None])[0] == '台積電',
   f"n={n} 2330={out and out['names'].get('2330')}")
ok('①b 產業別跟著帶上(前端 industry_category 那 5 個讀取點要用)',
   out and out['names']['2330'][1] == '半導體業', out and out['names'].get('2330'))

# ══ ② ETF 保底 ══
n2, out2, _ = run(BIG, etf_rows=[{'symbol': '0050', 'name': '元大台灣50'},
                                 {'symbol': '2330', 'name': '不可覆蓋官方的'}])
ok('② ETF 從 etf_tracking 保底進來', out2 and out2['names'].get('0050', [None])[0] == '元大台灣50',
   out2 and out2['names'].get('0050'))
ok('②b ⛔ 不可覆蓋官方表已有的(官方為準)',
   out2 and out2['names']['2330'][0] == '台積電', out2 and out2['names'].get('2330'))
ok('②c src 統計要分得出各來源幾檔',
   out2 and out2['src']['official'] >= 2000 and out2['src']['etf_tracking'] == 1, out2 and out2['src'])

# ══ ③ 🚧 <1500 不覆寫(核心守門)══
OLD = {'9999': ['舊股名', ''], '8888': ['另一檔', '']}
n3, out3, log3 = run({'1101': '台泥'}, old=OLD)
ok('③ 🚧 只有 1 檔 → ⛔ 不覆寫,回 0', n3 == 0, f"n={n3}")
ok('③b ⛔ 舊檔要原封不動留著(⛔ 不可被半份表洗掉)',
   out3 and out3['names'] == OLD, out3 and out3.get('names'))
ok('③c 不覆寫時要說出為什麼 + 印來源分佈', '不覆寫' in log3 and 'official' in log3, log3[-200:])

# ══ ④ 合併舊檔 ══
n4, out4, _ = run(BIG, old={'7777': ['老朋友', ''], '2330': ['舊的台積電', '']})
ok('④ 舊檔裡官方沒有的要留著', out4 and out4['names'].get('7777', [None])[0] == '老朋友',
   out4 and out4['names'].get('7777'))
ok('④b ⛔ 舊值不可蓋掉這輪的新值', out4 and out4['names']['2330'][0] == '台積電',
   out4 and out4['names'].get('2330'))
ok('④c merged_old 統計正確', out4 and out4['src']['merged_old'] == 1, out4 and out4['src'])

# ══ ⑤⑥ 誠實揭露 ══
ok('⑤ 產物要標 updated / n / n_etf / caveat',
   out and all(k in out for k in ('updated', 'n', 'n_etf', 'src', 'caveat')), out and list(out.keys()))
ok('⑥ 🚨 ETF 太少要主動示警', 'ETF 只有' in log, log[-260:])
ok('⑥b caveat 要講明 ETF 的來源與限制', out and 'ETF' in out['caveat'], out and out.get('caveat'))

# ══ ⑦ 壞掉的 etf_tracking ⛔ 不可讓整支炸掉 ══
import tempfile as _tf
with _tf.TemporaryDirectory() as td:
    cwd = os.getcwd()
    import miner as _m
    _og = _m.http_session.get
    try:
        os.chdir(td)
        Path('data').mkdir()
        Path('data/etf_tracking.json').write_text('{壞掉的 json', encoding='utf-8')
        import io, contextlib
        _m.http_session.get = lambda url, **kw: _Resp(404, {})
        _m._COMPANY_NAME = dict(BIG)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            n7 = _m.build_stock_names({})
        ok('⑦ etf_tracking 壞掉 → 照樣產出(只印警告)', n7 >= 2000, f"n={n7}")
        ok('⑦b 而且要把失敗印出來(⛔ 不可靜默)', 'ETF 名字保底讀取失敗' in buf.getvalue(), buf.getvalue()[-200:])
    finally:
        _m.http_session.get = _og
        os.chdir(cwd)

# ══ ⑧ ⭐ 每日收盤行情那層(ETF 名字的正解)══
# 🚨 測資刻意重現探針實測的真實情境:
#    ・`00981A` 主動式 ETF(5 數字 + 1 英文)  ・`03013T` 權證(**格式一模一樣**)
#    → 唯一分得開的是「data/ 裡有沒有它的 K 線」。
QUOTES = {
    'STOCK_DAY_ALL': [
        {'Code': '0050', 'Name': '元大台灣50'},
        {'Code': '009816', 'Name': '凱基台灣TOP50'},
        {'Code': '00981A', 'Name': '主動統一台股增長'},
        {'Code': '03013T', 'Name': '凱基某某購01'},        # 🚨 權證,data/ 裡沒有 → 必須被濾掉
        {'Code': '2330', 'Name': '不可覆蓋官方的'},
    ],
    'tpex_mainboard': [
        {'SecuritiesCompanyCode': '6488', 'CompanyName': '環球晶'},
        {'SecuritiesCompanyCode': '069954', 'CompanyName': '中興電中信38購01'},   # 權證
    ],
}
DATA_SYMS = ['0050', '009816', '00981A', '6488', '2330']
n8, out8, log8 = run(BIG, quotes=QUOTES, data_syms=DATA_SYMS)
ok('⑧ 收盤行情的 ETF 名字有進表(0050 / 009816 / 00981A)',
   out8 and out8['names'].get('0050', [None])[0] == '元大台灣50'
   and out8['names'].get('009816', [None])[0] == '凱基台灣TOP50'
   and out8['names'].get('00981A', [None])[0] == '主動統一台股增長',
   out8 and [out8['names'].get(k) for k in ('0050', '009816', '00981A')])
ok('⑧b 上櫃那支也吃得到(欄名不同:SecuritiesCompanyCode / CompanyName)',
   out8 and out8['names'].get('6488', [None])[0] == '環球晶', out8 and out8['names'].get('6488'))
ok('⑧c 🚨 權證一定要被濾掉(⛔ 代號格式分不開,只能靠 data/ 白名單)',
   out8 and '03013T' not in out8['names'] and '069954' not in out8['names'],
   out8 and [k for k in ('03013T', '069954') if k in out8['names']])
ok('⑧d ⛔ 不可覆蓋官方公司表已有的', out8 and out8['names']['2330'][0] == '台積電',
   out8 and out8['names'].get('2330'))
ok('⑧e src 統計:daily_quote 4 檔、skipped_not_in_data 2 檔(⛔ 濾掉了幾檔要說得出來)',
   out8 and out8['src']['daily_quote'] == 4 and out8['src']['skipped_not_in_data'] == 2,
   out8 and out8['src'])
# ⑧f ETF 夠多就 ⛔ 不可再示警(天天道歉會讓人養成忽略的習慣)
#    ⚠️ 上面那組測資只有 3 檔 ETF(本來就該示警)→ 這條要**另外**給一份夠多的,
#       ⛔ 不可寫成「n_etf<100 就算過」那種永遠成立的斷言(= 假綠燈)。
_MANY = {'STOCK_DAY_ALL': [{'Code': '00%04d' % i, 'Name': 'ETF%d' % i} for i in range(120)]}
_MANY_SYMS = ['00%04d' % i for i in range(120)]
n8f, out8f, log8f = run(BIG, quotes=_MANY, data_syms=_MANY_SYMS)
ok('⑧f ETF 夠多(120 檔)就 ⛔ 不可再示警',
   out8f and out8f['n_etf'] >= 120 and 'ETF 只有' not in log8f,
   f"n_etf={out8f and out8f.get('n_etf')} ・{log8f[-200:]}")

# ⑧g 沒有白名單(data/ 裡一個 json 都沒有)→ 整層跳過並說出為什麼
n9, out9, log9 = run(BIG, quotes=QUOTES)          # ⚠️ 沒給 data_syms、沒給 etf_rows/old → data/ 是空的
# ⚠️ 注入驗證的誠實紀錄:把 `if _known:` 改成 `if True:` **⑧g 照樣綠** ——
#    因為真正擋住權證的是迴圈裡那行 `if _sy not in _known: continue`(⑧c 釘的就是它),
#    `if _known:` 只是提早收工 + 把原因說出來 → 那條由 ⑧g2 釘住。⛔ 兩條都不可拿掉。
ok('⑧g 🚨 沒有白名單 → 一檔都不可收(⛔ 寧可沒名字也不可混進權證)',
   out9 and '0050' not in out9['names'] and out9['src']['daily_quote'] == 0,
   out9 and out9['src'])
ok('⑧g2 而且要說出為什麼(⛔ 不可靜默跳過)', '沒有白名單' in log9, log9[-260:])

# ⑧h HTTP 掛掉 → 印警告、⛔ 不炸、其餘照產出
n10, out10, log10 = run(BIG, quotes=QUOTES, data_syms=DATA_SYMS, quote_status=500)
ok('⑧h 收盤行情 HTTP 500 → 照樣產出(官方表那半還在)', n10 >= 2000, f"n={n10}")
ok('⑧h2 而且要把 HTTP 狀態印出來(⛔ 不可靜默 —— 那正是查 ETF 為什麼沒名字的第一條線索)',
   'HTTP 500' in log10, log10[-260:])

print(f"\n{'❌ %d 條失敗' % fails if fails else '✅ 全部通過'}")
sys.exit(1 if fails else 0)
