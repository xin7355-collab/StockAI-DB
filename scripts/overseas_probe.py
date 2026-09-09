#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🌏 台股 vs 美股 / 日股 / 韓股 對照(V74.6.2)

使用者:「目前都沒有對照美股,還有日股韓股,比對台股的回測」

⭐ 先講清楚**能比什麼、不能比什麼**(⛔ 免得下一個人以為可以直接套):
  ❌ **不能**跑「同一套打法在美日韓的個股上」—— 本站只有台股個股 K 線,
     美日韓的個股資料沒有免費來源(而且真要做,那是另一個專案)。
  ✅ **能比的是大盤層級的「行為」** —— 而那正好回答使用者問題①的前提:
     「台股是不是特別容易一天大跌、一天就回來?」

問三件事(每一個都用同一套定義,四個市場並排):
  ① 大跌的頻率:單日跌 ≥2% / ≥3% 佔多少天
  ② V 型反彈:大跌之後隔天平均漲多少、上漲比例、**隔天就全部收回的比例**
  ③ 連動與領先:台股跟各市場的**同期**相關 vs **隔天**相關
     ⭐ 同期相關高是廢話(同一件事的兩種記法),⛔ 只有隔天相關才有預測意義

⚠️ 沙箱連不到 Yahoo / stooq(網路政策只放行 npm/pypi/github)→ **只能在 Actions 跑**。
⛔ 只讀、只印,不寫檔、不碰任何分支。
"""
import sys, math

TICKERS = [
    ('^TWII', '台股加權'),
    ('^GSPC', '美股 S&P500'),
    ('^IXIC', '美股 那斯達克'),
    ('^N225', '日股 日經'),
    ('^KS11', '韓股 KOSPI'),
    ('^HSI',  '港股 恆生'),
]
YEARS = '5y'

def fetch():
    import yfinance as yf
    out = {}
    for t, nm in TICKERS:
        try:
            h = yf.Ticker(t).history(period=YEARS, auto_adjust=False)
            if h is None or h.empty:
                print(f'   ⚠️ {nm}({t}) 回空'); continue
            ser = [(str(i.date()), float(c)) for i, c in zip(h.index, h['Close']) if c == c and c > 0]
            if len(ser) < 300:
                print(f'   ⚠️ {nm}({t}) 只有 {len(ser)} 筆,略過'); continue
            out[t] = {'name': nm, 'd': [x[0] for x in ser], 'c': [x[1] for x in ser]}
            print(f'   ✅ {nm}({t}) {len(ser)} 筆 {ser[0][0]} ~ {ser[-1][0]}')
        except Exception as e:
            print(f'   ❌ {nm}({t}) {type(e).__name__}: {str(e)[:90]}')
    return out

def chg(c):
    return [None] + [(c[i] / c[i - 1] - 1) * 100 for i in range(1, len(c))]

def main():
    print('🌏 台股 vs 美日韓港 —— 大盤層級對照(⛔ 不是個股回測)\n')
    print('📥 抓取中(yfinance,5 年日線)…')
    D = fetch()
    if '^TWII' not in D:
        print('❌ 台股抓不到,無法對照'); sys.exit(1)
    print()

    # ═══ ①② 大跌頻率 + V 型反彈 ═══
    print('═' * 92)
    print('① 大跌的頻率、② 大跌之後隔天怎麼走(⭐ 這一段直接回答「台股是不是特別容易一天跌一天回來」)\n')
    for TH in (2.0, 3.0):
        print(f'🔻 單日跌 ≥{TH:.0f}%')
        print('   市場'.ljust(16) + '次數'.rjust(7) + '佔比'.rjust(8) + '隔天平均'.rjust(10)
              + '隔天上漲'.rjust(10) + '(平常上漲)'.rjust(11) + '隔天全收回'.rjust(11))
        for t, _nm in TICKERS:
            if t not in D: continue
            c = D[t]['c']; g = chg(c)
            ev = [i for i in range(1, len(c) - 1) if g[i] is not None and g[i] <= -TH]
            allnx = [g[i + 1] for i in range(1, len(c) - 1) if g[i + 1] is not None]
            baseUp = sum(1 for x in allnx if x > 0) / len(allnx) * 100
            if not ev:
                print('   ' + D[t]['name'].ljust(14) + '0'.rjust(7)); continue
            nx = [g[i + 1] for i in ev]
            up = sum(1 for x in nx if x > 0) / len(nx) * 100
            full = sum(1 for i in ev if g[i + 1] >= -g[i]) / len(ev) * 100
            print('   ' + D[t]['name'].ljust(14) + str(len(ev)).rjust(7)
                  + f'{len(ev)/len(c)*100:.1f}%'.rjust(8)
                  + f'{nx and sum(nx)/len(nx) or 0:+.2f}%'.rjust(10)
                  + f'{up:.0f}%'.rjust(10) + f'{baseUp:.0f}%'.rjust(11) + f'{full:.0f}%'.rjust(11))
        print()

    # ═══ ③ 連動與領先 ═══
    print('═' * 92)
    print('③ 台股跟各市場的關聯 —— ⭐ 同期 vs 隔天(⛔ 同期相關高是廢話,只有隔天的才有預測意義)\n')
    tw = D['^TWII']
    twMap = dict(zip(tw['d'], tw['c']))
    twG = dict(zip(tw['d'][1:], chg(tw['c'])[1:]))
    print('   市場'.ljust(16) + '同期相關'.rjust(10) + '海外→台股隔天'.rjust(15)
          + '台股→海外隔天'.rjust(15) + '共同交易日'.rjust(11))
    def corr(a, b):
        n = len(a)
        if n < 30: return None
        ma, mb = sum(a) / n, sum(b) / n
        va = sum((x - ma) ** 2 for x in a); vb = sum((x - mb) ** 2 for x in b)
        if va <= 0 or vb <= 0: return None
        return sum((a[i] - ma) * (b[i] - mb) for i in range(n)) / math.sqrt(va * vb)
    for t, _nm in TICKERS:
        if t == '^TWII' or t not in D: continue
        o = D[t]; oG = dict(zip(o['d'][1:], chg(o['c'])[1:]))
        days = sorted(set(twG) & set(oG))
        if len(days) < 100: continue
        same_a = [twG[d] for d in days]; same_b = [oG[d] for d in days]
        # 海外 T 日 → 台股 T+1 日(⭐ 台股比美股早開,所以「美股昨晚 → 台股今天」用日期偏移)
        lead_a, lead_b, lag_a, lag_b = [], [], [], []
        twd = tw['d']
        idx = {d: i for i, d in enumerate(twd)}
        for d in days:
            i = idx.get(d)
            if i is None or i + 1 >= len(twd): continue
            nd = twd[i + 1]
            if nd in twG: lead_a.append(oG[d]); lead_b.append(twG[nd])
        od = o['d']; oidx = {d: i for i, d in enumerate(od)}
        for d in days:
            i = oidx.get(d)
            if i is None or i + 1 >= len(od): continue
            nd = od[i + 1]
            if nd in oG: lag_a.append(twG[d]); lag_b.append(oG[nd])
        f = lambda v: '  —  ' if v is None else f'{v:+.3f}'
        print('   ' + o['name'].ljust(14) + f(corr(same_a, same_b)).rjust(10)
              + f(corr(lead_a, lead_b)).rjust(15) + f(corr(lag_a, lag_b)).rjust(15)
              + str(len(days)).rjust(11))
    print()
    print('═' * 92)
    print('⚠️ 這是**大盤層級**的對照,⛔ 不是「同一套打法在美日韓的個股上回測」(沒有那些市場的個股資料)。')
    print('⚠️ 各市場休市日不同 → 「隔天」是用各自的下一個交易日,共同交易日數已列出。')

if __name__ == '__main__':
    main()
