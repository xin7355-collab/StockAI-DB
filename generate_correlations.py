#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🕸️ 關聯星圖採礦 —— top_correlations.json(V74.5.0)

❓ 這支在回答什麼:「我看的這一檔在動的時候,還有哪幾檔會跟著動?」
   ⛔ 它**不是**預測工具 —— 相關係數是**同期**的(同一天一起漲),
      CLAUDE.md 評估紀錄⑧ 已實測:同期相關再高都不能拿來預測
      (外資買超 vs 當天漲跌同期 +0.298,vs 隔天只剩 +0.028、51 檔沒有一檔 >0.3)。
      所以前端一律只描述、⛔ 不下多空、不計分。

⭐ 三個架構決定(⛔ 改之前先讀)
 ① **重活全部在採礦端** —— 前端只讀一個壓縮好的 JSON。
    2,500 檔 × 120 天的相關矩陣有 300 萬對,手機做這件事會直接當掉。
 ② **零額外 API** —— 只讀既有的 `data/{sym}.json`(OHLCV),不打任何外部服務。
 ③ **輸出用陣列不用物件** —— `[代號, r, 狀態]` 比 `{"id":…,"r":…,"s":…}` 小約 3 倍
    (同 screener.json 的 cols+rows 做法)。實測約 100~200 KB。

🚨 三個踩過的坑,已經處理(⛔ 別「簡化」掉)
 ① **成交量的單位是「股」不是「張」**(陷阱 #17)。實測 2330 某日 volume=19,091,713
    = 19,091 張。門檻(1000 / 1500)講的是**張** → 一律先 `/1000` 換算,
    ⛔ 直接拿股數去比 1000 的話,全市場每一檔都會通過 = 這個濾網等於沒有。
 ② **不是每一檔在最後一天都有交易**。拿全市場最新日去 `.iloc[-1]` 會讓停牌/下市股拿到 NaN。
    → 硬性要求「最新交易日有成交」才進入宇宙,被排除的**分類統計出來**(⛔ 不靜默,
    CLAUDE.md V72.5.3 的教訓:先加分類統計再下結論)。
 ③ **新上市股的 20MA 是 NaN**。→ 狀態一律回 Enum 0,⛔ 不可讓它 crash 也不可猜。

🚧 空過守門:輸出檔數 < CORR_MIN_OK(預設 200)→ exit 1。
   ⛔ 寧可保留昨天的好檔,也不可以寫出一份半殘的蓋掉它(同 fund_sweep / chips_backfill)。

用法:
    python3 generate_correlations.py               # 讀 data/,寫 data/top_correlations.json
    DATA_DIR=/path CORR_WINDOW=120 python3 generate_correlations.py
    python3 generate_correlations.py --selftest    # 注入已知訊號,驗 harness 會不會算
"""
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(os.getenv('DATA_DIR') or 'data')
OUT = DATA / 'top_correlations.json'

# ── 參數(全部可用環境變數覆蓋,⛔ 別散在程式各處寫死)──────────────────────
WINDOW    = int(os.getenv('CORR_WINDOW') or 120)     # 算相關用幾個交易日(約半年)
TOP_N     = int(os.getenv('CORR_TOP_N') or 5)        # 每檔最多留幾個鄰居
R_MIN     = float(os.getenv('CORR_R_MIN') or 0.4)    # 相關係數門檻
MIN_OK    = int(os.getenv('CORR_MIN_OK') or 200)     # 空過守門:少於這個數就拒絕寫檔
VOL_AVG20 = float(os.getenv('CORR_VOL_AVG20') or 1000)   # 張:20 日均量門檻
VOL_TODAY = float(os.getenv('CORR_VOL_TODAY') or 1500)   # 張:爆量當日最低量
OVERHEAT  = float(os.getenv('CORR_OVERHEAT') or 1.15)    # 收盤 > 20MA × 這個倍數 = 過熱
STALE_D   = int(os.getenv('CORR_STALE_DAYS') or 0)   # 0 = 必須在最新交易日有成交
# 🚨 排除 ETF(預設開)。實測不排除的話 2330 的前 5 名**全部是 ETF**
#    (0052 .924 / 0050 .910 / 006208 .907 / 009816 .860 / 009803 .835)、2454 是 5/5。
#    那是**恆等式不是資訊** —— 0050 有四成本來就是台積電,「台積電跟 0050 一起動」
#    對使用者零可操作性,而且會把真正同族的個股名額整個吃光。
#    ⛔ 別為了「多一點連線」把它關掉。台股 ETF 代號一律 00 開頭,個股是 1xxx~9xxx → 判準乾淨。
EXCL_ETF  = (os.getenv('CORR_EXCLUDE_ETF') or '1') != '0'

# 狀態列舉(⚠️ 前端 pro.html 的 STAR_STATUS 必須跟這裡一致 —— 同名不同義是本專案犯最多次的錯)
ST_FLAT, ST_BREAK, ST_HOT = 0, 1, 2


# ══════════════════════════════════════════════════════════════════════════
# 1. 讀檔(唯一的 for 迴圈:純 I/O,把 2,500 個檔壓成一張長表)
#    ⭐ 只留最後 WINDOW+40 根 —— 全市場 3 年全載進來要 1GB 主機吃不消(OOM 防禦),
#       而相關係數只用得到最近那段。
# ══════════════════════════════════════════════════════════════════════════
def load_long(data_dir: Path, tail: int):
    syms, dates, closes, vols = [], [], [], []
    n_file = n_bad = n_short = n_etf = 0
    for p in sorted(data_dir.glob('*.json')):
        stem = p.stem
        # 只收個股/ETF(4~6 位數字)。^TWII 這種指數與各式 cache 檔一律跳過。
        if not (stem.isdigit() and 4 <= len(stem) <= 6):
            continue
        n_file += 1
        if EXCL_ETF and stem.startswith('00'):
            n_etf += 1
            continue
        try:
            rows = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            n_bad += 1
            continue
        if not isinstance(rows, list):
            n_bad += 1
            continue
        rows = rows[-tail:]
        if len(rows) < 30:
            n_short += 1
            continue
        for r in rows:
            c = r.get('close')
            if c is None:
                continue          # 陷阱 V74.2.1:盤中快照留下的空殼(有量沒收盤價)
            syms.append(stem)
            dates.append(str(r.get('date') or '').replace('/', '-'))
            closes.append(c)
            vols.append(r.get('volume'))
    long = pd.DataFrame({'sym': syms, 'date': dates,
                         'close': pd.to_numeric(closes, errors='coerce'),
                         'volume': pd.to_numeric(vols, errors='coerce')})
    long = long[(long['close'] > 0) & (long['date'].str.len() == 10)]
    return long, {'files': n_file, 'bad': n_bad, 'too_short': n_short, 'etf': n_etf}


# ══════════════════════════════════════════════════════════════════════════
# 2. 濾網 A(流動性 or 爆量突襲)+ 狀態評級 —— 全部 pandas 向量化,零逐檔迴圈
# ══════════════════════════════════════════════════════════════════════════
def screen_and_status(close: pd.DataFrame, lots: pd.DataFrame):
    """close / lots 都是 wide(index=日期, columns=股號);lots 單位是**張**。"""
    last, prev = close.index[-1], close.index[-2]

    c_t, c_y = close.loc[last], close.loc[prev]
    v_t, v_y = lots.loc[last], lots.loc[prev]
    avg20 = lots.rolling(20, min_periods=15).mean().loc[last]
    avg5  = lots.rolling(5,  min_periods=3).mean().loc[last]
    ma20  = close.rolling(20, min_periods=15).mean().loc[last]
    ma20_y = close.rolling(20, min_periods=15).mean().loc[prev]

    # 🚧 必須在最新交易日真的有成交(見檔頭坑 ②)
    traded = c_t.notna() & v_t.notna()

    # ── Filter A ──
    liquid = avg20 > VOL_AVG20
    surge  = (v_t > VOL_TODAY) & (v_t > avg5 * 2) & (c_t > c_y)
    keep = traded & (liquid.fillna(False) | surge.fillna(False))

    # ── 狀態評級(NaN → Enum 0,⛔ 不 crash 也不猜)──
    # 🚀 突破:昨收 ≤ 昨 20MA、今收 > 今 20MA、今量 > 昨量、**今收 > 昨收**(帶量紅K保護)。
    #    ⚠️ 最後那條幾乎被前兩條蘊含(20MA 一天只動 1/20),但「幾乎」不是「一定」——
    #       跌破後 MA 下彎時可能出現「收黑卻剛好站上 MA」的怪例,明寫掉它零成本。
    breakout = (c_y <= ma20_y) & (c_t > ma20) & (v_t > v_y) & (c_t > c_y)
    hot = c_t > ma20 * OVERHEAT
    status = pd.Series(ST_FLAT, index=close.columns, dtype='int8')
    status[breakout.fillna(False)] = ST_BREAK
    # ⚠️ 過熱(🔥)刻意**壓過**突破(🚀):它是風險提醒,而本專案的多空不對稱鐵則是
    #    「寧可多提醒,不可少提醒」。⛔ 想改成突破優先的話這一行對調即可,但要想清楚。
    status[hot.fillna(False)] = ST_HOT

    return keep, status, {'liquid': int(liquid.fillna(False).sum()),
                          'surge': int(surge.fillna(False).sum()),
                          'not_traded': int((~traded).sum())}


# ══════════════════════════════════════════════════════════════════════════
# 3. 相關矩陣 + 取 Top N(NumPy,⛔ 不逐檔跑 .corr())
#    ⭐ 為什麼不用 DataFrame.corr():有 NaN 時 pandas 會退化成逐對的慢路徑,
#       1,000 檔 = 50 萬對,實測會慢一個量級。先把窗口補成完整矩陣再走 np.corrcoef。
# ══════════════════════════════════════════════════════════════════════════
def top_correlations(close_win: pd.DataFrame, status: pd.Series, top_n: int, r_min: float):
    ret = close_win.pct_change().iloc[1:]
    X = ret.to_numpy(dtype=np.float64)
    # 全期不動的股票(標準差 0)相關係數無定義 → 先剔除,⛔ 不可讓它變成 NaN 混進去
    sd = X.std(axis=0)
    alive = sd > 1e-12
    X, cols = X[:, alive], close_win.columns[alive]
    if X.shape[1] < 2:
        return {}, 0

    R = np.corrcoef(X, rowvar=False)
    np.fill_diagonal(R, -2.0)              # 排除自己(自相關恆為 1)
    R = np.nan_to_num(R, nan=-2.0)

    n = R.shape[0]
    k = min(top_n, n - 1)
    idx = np.argpartition(-R, k - 1, axis=1)[:, :k]             # 每列取最大的 k 個
    vals = np.take_along_axis(R, idx, axis=1)
    order = np.argsort(-vals, axis=1)                            # 再把那 k 個排好
    idx = np.take_along_axis(idx, order, axis=1)
    vals = np.take_along_axis(vals, order, axis=1)

    codes = cols.to_numpy()
    st = status.reindex(cols).fillna(ST_FLAT).astype(int).to_numpy()
    ok = vals > r_min

    out, pairs = {}, 0
    for i in range(n):                      # 只跑「留下來的」那幾檔,而且每檔最多 5 筆
        m = ok[i]
        if not m.any():
            continue
        lst = [[str(codes[j]), round(float(v), 3), int(st[j])]
               for j, v in zip(idx[i][m], vals[i][m])]
        out[str(codes[i])] = lst
        pairs += len(lst)
    return out, pairs


# ══════════════════════════════════════════════════════════════════════════
def build(data_dir: Path):
    t0 = time.time()
    long, stat = load_long(data_dir, WINDOW + 40)
    if long.empty:
        print(f'❌ 讀不到任何 K 線({data_dir}) — {stat}')
        return None, stat

    close = long.pivot_table(index='date', columns='sym', values='close', aggfunc='last').sort_index()
    vol   = long.pivot_table(index='date', columns='sym', values='volume', aggfunc='last').sort_index()
    if len(close) < 30:
        print(f'❌ 只有 {len(close)} 個交易日,不夠算相關')
        return None, stat

    # 🚨 陷阱 #14(V74.3.8 雲端實跑抓到):「最新交易日」⛔ 不可用 index[-1]。
    #    只要少數幾檔(盤中快照、時區跑掉)已經寫進「明天」的列,index[-1] 就變成那一天,
    #    當天有收盤的只有那幾檔 → Filter A 過關 2 檔 → 全部退場。
    #    實跑 2026-09-01 22:07 UTC:「宇宙 2 檔 ・有鄰居 0 檔」,而本機同一份程式是 582 檔。
    #    → 改取「通得過樣本門檻的最大日期」:該日有收盤的檔數 ≥ 全窗口最大檔數的一半,
    #      後面的日子整列砍掉,並印出砍了哪幾天(⛔ 不靜默)。
    cnt = close.notna().sum(axis=1)
    good = cnt[cnt >= max(2, cnt.max() * 0.5)]
    if good.empty:
        print(f'❌ 沒有任何一天的樣本數過門檻 — {stat}')
        return None, stat
    last_ok = good.index[-1]
    skipped = [f'{d}({int(cnt[d])}檔)' for d in close.index if d > last_ok]
    if skipped:
        print(f'⚠️ 最新 {len(skipped)} 個日期樣本不足,改用 {last_ok} 當最新交易日:{", ".join(skipped[:5])}')
        close = close.loc[:last_ok]
        vol = vol.loc[:last_ok]
    stat['skipped_dates'] = len(skipped)

    lots = vol / 1000.0        # 🚨 股 → 張(檔頭坑 ①)

    keep, status, sstat = screen_and_status(close, lots)
    stat.update(sstat)
    stat['pass_filter_a'] = int(keep.sum())
    if keep.sum() < 2:
        print(f'❌ 通過流動性濾網的只有 {int(keep.sum())} 檔 — {stat}')
        return None, stat

    win = close.loc[:, keep[keep].index].tail(WINDOW)
    # 一兩天停牌不該讓整檔出局,但⛔ 不可無限補(那等於捏造價格)
    win = win.ffill(limit=2)
    before = win.shape[1]
    win = win.dropna(axis=1)
    stat['dropped_holes'] = before - win.shape[1]
    stat['universe'] = win.shape[1]
    stat['bars'] = win.shape[0]

    res, pairs = top_correlations(win, status, TOP_N, R_MIN)
    stat['pairs'] = pairs
    stat['secs'] = round(time.time() - t0, 1)

    payload = {
        'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'data_date': str(close.index[-1]),
        'window': int(stat['bars']), 'r_min': R_MIN, 'top_n': TOP_N,
        'universe': stat['universe'], 'pairs': pairs,
        'status_enum': {'0': '盤整', '1': '突破', '2': '過熱'},
        'excl_etf': bool(EXCL_ETF),
        'caveat': '相關係數是同期的(同一天一起動),⛔ 不是預測。本站實測:同期相關再高都不能拿來預測隔天。',
        'r': res,
    }
    return payload, stat


def selftest():
    """注入兩組已知訊號 → 相關必須抓得到;沒有訊號的那組必須抓不到。
       ⛔ 沒有這條的話,「跑出來 0 筆」分不出是沒訊號還是程式壞掉。"""
    import tempfile
    rng = np.random.default_rng(7)
    n = 160
    base = rng.normal(0, 0.02, n)
    dates = pd.bdate_range('2025-01-01', periods=n).strftime('%Y/%m/%d')
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        def w(sym, ret, vol):
            px, rows = 100.0, []
            for i, r in enumerate(ret):
                px *= (1 + r)
                rows.append({'date': dates[i], 'open': px, 'high': px, 'low': px,
                             'close': round(px, 2), 'volume': vol})
            (d / f'{sym}.json').write_text(json.dumps(rows), encoding='utf-8')
        # 同族三兄弟(共用 base)→ 彼此相關必須 > 0.9
        for s in ('1001', '1002', '1003'):
            w(s, base + rng.normal(0, 0.004, n), 5_000_000)
        # 各走各的兩檔 → 不該互相配對
        w('2001', rng.normal(0, 0.02, n), 5_000_000)
        w('2002', rng.normal(0, 0.02, n), 5_000_000)
        # 沒量的一檔 → 必須被 Filter A 濾掉
        w('3001', base + rng.normal(0, 0.004, n), 100_000)
        # ETF(00 開頭)跟同族完全同步 → 不排除的話必定佔滿名額
        w('0050', base + rng.normal(0, 0.001, n), 50_000_000)
        # 🚀 突破樣本:前 159 天平盤、最後一天 +6% 帶量 → 昨收 ≤ MA、今收 > MA、量 > 昨量、紅K
        brk = np.zeros(n); brk[-1] = 0.06
        w('4001', brk, 5_000_000)
        w('4002', brk + rng.normal(0, 0.002, n), 5_000_000)   # 4001 的同伴,讓 4001 出現在鄰居欄
        rows = json.loads((d / '4001.json').read_text()); rows[-1]['volume'] = 20_000_000
        (d / '4001.json').write_text(json.dumps(rows))
        # 🌱 只上市 35 天的新股:通得過 Filter A(有 20 日均量),但湊不滿 120 天的窗口
        #    → 必須被「缺口剔除」安靜地排除、⛔ 不可 crash,也不可用半截資料硬算相關。
        #    (真正 20MA=NaN 的 <15 天新股,連 30 根的讀檔門檻都過不了,更早就擋掉了。)
        (d / '5001.json').write_text(json.dumps([{'date': dates[i], 'close': 50 + i * 0.1, 'volume': 9_000_000}
                                                 for i in range(n - 35, n)]))
        # 🚨 陷阱 #14:兩檔多了一根「明天」的列(盤中快照 / 時區跑掉會發生)→
        #    ⛔ 不可讓那一天變成「最新交易日」(那樣宇宙只剩 2 檔、其他全部退場)。
        nxt = pd.bdate_range(dates[-1].replace('/', '-'), periods=2)[-1].strftime('%Y/%m/%d')
        for s in ('2001', '2002'):
            rows = json.loads((d / f'{s}.json').read_text())
            rows.append({'date': nxt, 'close': rows[-1]['close'], 'volume': 5_000_000})
            (d / f'{s}.json').write_text(json.dumps(rows))
        payload, stat = build(d)
        assert payload, '❌ selftest:build 回 None'
        assert payload['data_date'] == dates[-1].replace('/', '-'), f'❌ 最新交易日被兩檔未來列帶走:{payload["data_date"]}'
        assert stat.get('skipped_dates') == 1, f'❌ 沒有把樣本不足的日期砍掉:{stat}'
        st_of = {}
        for k, v in payload['r'].items():
            for c, r_, st in v: st_of[c] = st
        assert st_of.get('4001') == ST_BREAK, f'❌ 帶量紅K站上 20MA 沒被標成突破:{st_of.get("4001")}'
        assert '5001' not in payload['r'] and all('5001' not in [x[0] for x in v] for v in payload['r'].values()), \
            '❌ 湊不滿窗口的新股混進來了'
        assert stat['dropped_holes'] >= 1, f'❌ 新股應該被記在 dropped_holes:{stat}'
        r = payload['r']
        assert '3001' not in r, '❌ 沒量的股票沒有被 Filter A 濾掉'
        assert '0050' not in r and all('0050' not in [x[0] for x in v] for v in r.values()), \
            '❌ ETF 沒有被排除(不排的話會佔滿權值股的鄰居名額)'
        assert all('3001' not in [x[0] for x in v] for v in r.values()), '❌ 被濾掉的股票仍出現在鄰居裡'
        fam = {x[0] for x in r.get('1001', [])}
        assert {'1002', '1003'} <= fam, f'❌ 同族沒被抓出來:{fam}'
        assert '2001' not in fam and '2002' not in fam, f'❌ 不相干的股票被配對了:{fam}'
        assert all(x[0] != k for k, v in r.items() for x in v), '❌ 有股票跟自己配對'
        assert all(x[1] > R_MIN for v in r.values() for x in v), '❌ 有低於門檻的 r 混進來'
        assert all(len(v) <= TOP_N for v in r.values()), '❌ 有超過 TOP_N 的清單'
        print(f'✅ selftest 通過 — {stat}')
        return 0


def main():
    if '--selftest' in sys.argv:
        return selftest()
    payload, stat = build(DATA)
    print(f'📊 讀檔 {stat.get("files", 0)} ・ETF 排除 {stat.get("etf", 0)} ・壞檔 {stat.get("bad", 0)} ・太短 {stat.get("too_short", 0)} ・'
          f'最新日沒成交 {stat.get("not_traded", 0)} ・流動性過關 {stat.get("liquid", 0)} ・'
          f'爆量過關 {stat.get("surge", 0)} ・缺口剔除 {stat.get("dropped_holes", 0)}')
    if not payload:
        print('❌ 產不出結果 → ⛔ 不覆寫舊檔')
        return 1
    n = len(payload['r'])
    print(f'🕸️ 宇宙 {payload["universe"]} 檔 ・{payload["window"]} 個交易日 ・'
          f'有鄰居 {n} 檔 ・連線 {payload["pairs"]} 條 ・{stat["secs"]}s')
    if n < MIN_OK:
        print(f'❌ 只有 {n} 檔有鄰居(門檻 {MIN_OK})→ ⛔ 拒絕覆寫舊檔')
        return 1
    DATA.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'✅ 已寫出 {OUT} ({OUT.stat().st_size / 1024:.1f} KB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
