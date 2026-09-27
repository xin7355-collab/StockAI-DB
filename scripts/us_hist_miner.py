#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🇺🇸 us_hist_miner.py —— 美股 / 美股 ETF / 指數 5 年日線 → `data/us_hist.json`(V77.7.7)

為什麼要有這支:
  repo 正式產物**完全沒有美股逐日價格序列** —— macro_cache.json / macro_risk.json 全是「最後一天收盤 + 漲跌%」快照,
  risk_history.json 只有 59 天而且只有 sp500_chg_pct / vix。要驗「美股隔夜異常 → 台股」(us_tw_lead_probe.mjs)
  就得先有序列。⚠️ 沙箱連不到 Yahoo(CONNECT 403),只有 GitHub Actions 能用 yfinance → 這支只在 Actions 跑。

設計(CLAUDE.md 鐵則):
  ① 價格用 **adjusted**(`auto_adjust=True`):窗內 NVDA/AVGO/SMCI/LRCX 10:1、GOOGL/AMZN 20:1 分割,不調整會製造 −90% 假 shock。
     這條序列只跟自己算報酬、永遠不跟盤中官方價對照 → 陷阱 #17/#46(同一序列混兩種尺)不適用;檔頭寫 `adj:true`。
  ② 任一日 |收盤報酬| > 40% → 記 `split_suspect` 並把那天 o/c 設 None(⛔ 不寫死一個看起來合理的假數字,陷阱 #22)。
  ③ 空過守門:n_syms ≥ 30 ∧ n_days ≥ 1000 ∧ asof 距今 ≤ 5 天,不過就 exit 0 **不覆蓋舊檔**(實跑寫入優先:全抓完才寫)。
  ④ 抓不到的檔進 `errors`(陷阱 #22:None 要寫原因),其他檔照寫。
  ⑤ ⛔ 不需要任何金鑰;⛔ 不印 env。
  ⑥ 欄式儲存、日期共用(37 檔 × ~1,260 天 ≈ 1.2 MB);⛔ 不進 App 首載(index/pro 只吃探針嵌進去的常數)。

用法:
  YEARS=5y OUT=data/us_hist.json python3 scripts/us_hist_miner.py
  python3 scripts/us_hist_miner.py --selftest      # 離線合成資料,不碰網路
"""
import json
import os
import sys
import datetime as _dt

# 37 檔:大盤 / 波動 / 半導體 / AI 供應鏈 / 板塊 ETF(對照 macro_miner.SECTOR_ETF_MAP)/ 期貨(只當附屬欄)
TICKERS = [
    '^GSPC', '^IXIC', '^SOX', '^VIX', '^DJI',
    'TSM', 'ASX', 'UMC',
    'NVDA', 'AMD', 'AVGO', 'MU', 'AMAT', 'LRCX', 'KLAC', 'ANET', 'MRVL', 'ASML', 'SMCI',
    'MSFT', 'AAPL', 'GOOGL', 'AMZN', 'META', 'TSLA',
    'SMH', 'SOXX', 'XLF', 'XLI', 'GRID', 'BOTZ', 'ITA', 'PPA', 'CIBR',
    'ES=F', 'NQ=F',
]
FUTURES = {'ES=F', 'NQ=F'}   # 連續合約換月會製造假報酬 → 探針只當附屬欄,⛔ 不當事件源

# 🔧 排程/workflow_run 觸發時 inputs.* 是**空字串**不是不存在 → 一律 `or 預設`(check_env_default.py)
YEARS = os.environ.get('YEARS') or '5y'
OUT = os.environ.get('OUT') or 'data/us_hist.json'
MIN_SYMS = int(os.environ.get('MIN_SYMS') or 30)
MIN_DAYS = int(os.environ.get('MIN_DAYS') or 1000)
MAX_STALE_DAYS = int(os.environ.get('MAX_STALE_DAYS') or 5)
SPLIT_SUSPECT = 0.40   # 單日 |報酬| 超過這個就不可能是真實行情(美股沒有漲跌停,但 40% 單日只會是分割沒調到)


def fetch_all(tickers=TICKERS, years=YEARS):
    """回 ({ticker: {date: (o, c, v)}}, {ticker: error})。逐檔 try/except,一檔壞不拖累其他檔。"""
    import yfinance as yf
    frames, errors = {}, {}
    for t in tickers:
        try:
            h = yf.Ticker(t).history(period=years, auto_adjust=True)
            ser = {}
            for idx, row in h.iterrows():
                d = str(idx)[:10]
                try:
                    o, c, v = float(row['Open']), float(row['Close']), float(row['Volume'])
                except (KeyError, TypeError, ValueError):
                    continue
                if not (o == o and c == c) or c <= 0:   # NaN 守門
                    continue
                ser[d] = (o, c, v if v == v else 0.0)
            if not ser:
                errors[t] = 'empty'
            else:
                frames[t] = ser
            print(f'  {t:6s} → {len(ser)} 天 ・最早 {min(ser) if ser else "-"} ・最晚 {max(ser) if ser else "-"}')
        except Exception as e:  # noqa: BLE001 —— 一檔失敗不影響其他檔,原因寫進 errors
            errors[t] = f'{type(e).__name__}: {str(e)[:120]}'
            print(f'  {t:6s} ❌ {errors[t]}')
    return frames, errors


def compact(frames, errors, years=YEARS):
    """欄式壓縮:日期聯集共用,缺值 None;順手做分割守門。"""
    days = sorted({d for ser in frames.values() for d in ser})
    syms, first, split_suspect = {}, {}, {}
    for t, ser in frames.items():
        o_arr, c_arr, v_arr = [], [], []
        prev_c, susp_c = None, None   # prev_c = 最近一個「可信」收盤;susp_c = 上一個被判可疑的收盤
        for d in days:
            rec = ser.get(d)
            if rec is None:
                o_arr.append(None); c_arr.append(None); v_arr.append(None)
                continue
            o, c, v = rec
            if prev_c and abs(c / prev_c - 1) > SPLIT_SUSPECT:
                # 連續第二天仍跟「可信的尺」差很多、但跟昨天那個可疑值差不多 → 那是永久換尺(真的沒調到的分割),
                # 只把第一天設 None,從今天起接受新尺;否則就是單日髒點,下一天繼續跟舊尺比。
                if susp_c and abs(c / susp_c - 1) <= SPLIT_SUSPECT:
                    o_arr.append(round(o, 2)); c_arr.append(round(c, 2)); v_arr.append(int(v))
                    prev_c, susp_c = c, None
                    continue
                split_suspect.setdefault(t, []).append(d)
                o_arr.append(None); c_arr.append(None); v_arr.append(int(v))
                susp_c = c
                continue
            o_arr.append(round(o, 2)); c_arr.append(round(c, 2)); v_arr.append(int(v))
            prev_c, susp_c = c, None
        syms[t] = {'o': o_arr, 'c': c_arr, 'v': v_arr}
        first[t] = min(ser)
    asof = days[-1] if days else None
    return {
        'asof': asof, 'adj': True, 'years': years, 'generated': _dt.datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC'),
        'days': days, 'syms': syms,
        'meta': {'n_syms': len(syms), 'n_days': len(days), 'first': first, 'futures': sorted(FUTURES & set(syms)),
                 'split_suspect': split_suspect},
        'errors': errors,
    }


def guard(doc, today=None):
    """回 (ok, reason)。⛔ 不過就不覆蓋舊檔。"""
    m = doc.get('meta', {})
    if m.get('n_syms', 0) < MIN_SYMS:
        return False, f'只有 {m.get("n_syms", 0)} 檔(<{MIN_SYMS})'
    if m.get('n_days', 0) < MIN_DAYS:
        return False, f'只有 {m.get("n_days", 0)} 天(<{MIN_DAYS})'
    if not doc.get('asof'):
        return False, 'asof 是空的'
    today = today or _dt.date.today()
    asof = _dt.date.fromisoformat(doc['asof'])
    if (today - asof).days > MAX_STALE_DAYS:
        return False, f'asof {doc["asof"]} 距今 {(today - asof).days} 天(>{MAX_STALE_DAYS})→ 來源沒更新'
    return True, ''


def write(doc, out=OUT):
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    tmp = out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, out)   # 原子替換:寫到一半失敗不會留下半截檔(陷阱 #18)
    return os.path.getsize(out)


def main():
    print(f'🇺🇸 美股日線歷史 ・{len(TICKERS)} 檔 ・period={YEARS} ・adjusted')
    frames, errors = fetch_all()
    doc = compact(frames, errors)
    ok, why = guard(doc)
    m = doc['meta']
    print(f'📊 {m["n_syms"]} 檔 ・{m["n_days"]} 天 ・asof {doc["asof"]} ・抓不到 {len(errors)} 檔 ・分割守門 {sum(len(v) for v in m["split_suspect"].values())} 天')
    if errors:
        for t, e in errors.items():
            print(f'   ⚠️ {t}: {e}')
    if not ok:
        print(f'⛔ 空過守門:{why} → 不覆蓋 {OUT}(舊檔保留)')
        sys.exit(0)
    size = write(doc)
    print(f'💾 {OUT} ・{size / 1024:.0f} KB')


# ── selftest(離線,不碰網路)──────────────────────────────────────────
def _synth(n_syms=37, n_days=1300, start=_dt.date(2021, 9, 1), skip_for=None, split_at=None):
    frames = {}
    d0 = start
    days = []
    d = d0
    while len(days) < n_days:
        if d.weekday() < 5:
            days.append(d.isoformat())
        d += _dt.timedelta(days=1)
    for k in range(n_syms):
        t = f'T{k:02d}'
        ser = {}
        px = 100.0 + k
        for i, dd in enumerate(days):
            if skip_for and t in skip_for and i % 2:   # 這一檔隔天缺一筆(交易日不同)
                continue
            px *= 1.0 + ((i * 7 + k) % 11 - 5) / 1000.0
            c = px
            if split_at and t in split_at and dd == split_at[t]:
                c = px * 0.08   # −92% 假分割
            ser[dd] = (c * 0.999, c, 1000.0 + i)
        frames[t] = ser
    return frames, days


def selftest():
    fails = []

    def ok(name, cond, extra=''):
        print(f'{"✅" if cond else "❌"} {name}{"" if cond else "  " + str(extra)[:200]}')
        if not cond:
            fails.append(name)

    today = _dt.date(2026, 9, 27)
    frames, days = _synth()
    # ① 壓縮往返:逐值相等
    doc = compact(frames, {}, '5y')
    j = json.loads(json.dumps(doc))
    t0 = 'T03'; i5 = 5
    ok('① 壓縮→json→解回逐值相等', j['syms'][t0]['c'][i5] == round(frames[t0][days[i5]][1], 2) and j['days'] == days and j['syms'][t0]['v'][i5] == int(frames[t0][days[i5]][2]))
    ok('⑦ 日期全是 YYYY-MM-DD、c 無 NaN', all(len(d) == 10 and d[4] == '-' for d in j['days']) and all(c is None or c == c for c in j['syms'][t0]['c']))
    # 守門
    g_ok, _ = guard(doc, today=_dt.date.fromisoformat(doc['asof']) + _dt.timedelta(days=2))
    ok('⓪ 正常資料過守門', g_ok)
    f20, _ = _synth(n_syms=20)
    ok('② 只有 20 檔 → 擋', guard(compact(f20, {}, '5y'), today=today)[0] is False)
    ok('③ asof 落後 10 天 → 擋', guard(doc, today=_dt.date.fromisoformat(doc['asof']) + _dt.timedelta(days=10))[0] is False)
    fshort, _ = _synth(n_days=500)
    ok('②b 只有 500 天 → 擋', guard(compact(fshort, {}, '5y'), today=today)[0] is False)
    # ④ 某檔 raise → errors 有它、其他檔照寫
    doc_e = compact({k: v for k, v in frames.items() if k != 'T05'}, {'T05': 'HTTPError 404'}, '5y')
    ok('④ 抓不到的檔進 errors、其他檔照寫', doc_e['errors'].get('T05') == 'HTTPError 404' and 'T05' not in doc_e['syms'] and doc_e['meta']['n_syms'] == 36)
    # ⑤ −92% 日進 split_suspect、該值變 None、隔天不再被判
    fsp, _ = _synth(split_at={'T07': days[100]})
    doc_s = compact(fsp, {}, '5y')
    ok('⑤ −92% 日進 split_suspect、當天 c=None、隔天照常', doc_s['meta']['split_suspect'].get('T07') == [days[100]] and doc_s['syms']['T07']['c'][100] is None and doc_s['syms']['T07']['c'][101] is not None and doc_s['syms']['T07']['c'][99] is not None)
    # ⑤b 永久換尺(從第 100 天起全部 ×0.1):只有第一天 None,之後照常、且不再一路被判
    fpm, _ = _synth()
    for dd in days[100:]:
        o, c, v = fpm['T08'][dd]; fpm['T08'][dd] = (o * 0.1, c * 0.1, v)
    doc_p = compact(fpm, {}, '5y')
    ok('⑤b 永久換尺只把第一天設 None、之後接受新尺', doc_p['meta']['split_suspect'].get('T08') == [days[100]] and doc_p['syms']['T08']['c'][100] is None and all(c is not None for c in doc_p['syms']['T08']['c'][101:110]))
    # ⑥ 兩檔交易日不同 → days 是聯集、短的補 None
    fsk, _ = _synth(skip_for={'T09'})
    doc_k = compact(fsk, {}, '5y')
    ok('⑥ 交易日不同 → days 聯集、缺的補 None', len(doc_k['days']) == len(days) and doc_k['syms']['T09']['c'][1] is None and doc_k['syms']['T09']['c'][0] is not None and doc_k['syms']['T00']['c'][1] is not None)
    # ⑧ write 原子替換 + 不覆蓋:guard 沒過時 main 路徑不會呼叫 write(這裡只驗 write 本身可讀回)
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, 'x', 'us_hist.json')
        write(doc, p)
        back = json.load(open(p, encoding='utf-8'))
        ok('⑧ write 可讀回、沒有 .tmp 殘留', back['meta']['n_syms'] == 37 and not os.path.exists(p + '.tmp'))
    print(f'\n{"❌ " + str(len(fails)) + " 條沒過" if fails else "✅ selftest 全部通過"}')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    else:
        main()
