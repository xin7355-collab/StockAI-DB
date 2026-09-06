#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🌅 盤前體檢分數回測(V74.4.5)—— 使用者:「盤前檢視頁面裡面的分數幫我回測一下,我覺得還滿準」

⛔ 為什麼一定要另外抓資料:盤前體檢的成分(美股四雄/台積電 ADR/VIX/亞股/匯率)
   在 `macro_risk.json` 裡**只有當前快照**;`risk_history.json` 只有 42 天而且
   **缺權重最高的兩項**(台積電 ADR ×2、大盤技術分數 ×2)→ 重建不出歷史分數。
   → 這支去 yfinance 抓那些指數的**日線歷史**自己重建。

🚨 時區對齊(這題最容易錯的地方,錯了整份結論作廢):
   台股 T 日開盤前,你**看得到的**只有 T−1 的海外收盤
   (美股 T−1 收盤 = 台北 T 日凌晨 04:00;日韓 T−1 收盤也早就出來了)。
   → 一律用 **T−1 的漲跌%** 去預測 **T 日的台股**。⛔ 不可用 T 日的海外資料(那是前視)。
   ⚠️ 假日不對齊時,用「台股 T 日之前、最近一個有資料的海外交易日」。

📐 分數公式:照 index.html 盤前體檢**可回算的那一半**(⛔ 誠實限制,見輸出):
   ✅ 有:美股三雄(各 ±1)・費半 ×1.5・台積電 ADR ×2・VIX(<20 +1 / >30 −2 / >25 −1)
          ・日經 ・韓股 ・恆指 ×0.5 ・台幣匯率 ・那斯達克期貨(用那指現貨代理)
   ❌ 沒有歷史(⛔ 不計分,會在輸出說明):外資期貨/現貨(約 4 分)・台指期夜盤(1.5)
          ・大盤技術分數(2)・恐懼貪婪(0.5)・三大法人合計(1)
   → 所以這測的是「**盤前體檢的海外連動部分**」,⛔ 不等於 App 顯示的完整分數。

用法:python3 scripts/premkt_probe.py(要 yfinance;沙箱連不到 → 只能在 Actions 跑)
      ⛔ 只讀不寫任何產物;結論印進 log。
"""
import json
import os
import subprocess
import sys
from datetime import datetime

TICKERS = {
    'dji': '^DJI', 'ndx': '^IXIC', 'spx': '^GSPC', 'sox': '^SOX',
    'tsm': 'TSM', 'vix': '^VIX', 'nk': '^N225', 'ks': '^KS11', 'hs': '^HSI',
    'twd': 'TWD=X',
}
YEARS = os.getenv('PREMKT_YEARS', '5y')


def load_twii():
    """加權指數日線:從 gh-pages 讀(workflow 已 git archive 出來)。"""
    for p in ('data/^TWII.json', '^TWII.json'):
        if os.path.exists(p):
            rows = json.load(open(p, encoding='utf-8'))
            out = []
            for r in rows:
                try:
                    d = str(r['date']).replace('/', '-')[:10]
                    o, c = float(r['open']), float(r['close'])
                    if o > 0 and c > 0:
                        out.append((d, o, c))
                except (KeyError, TypeError, ValueError):
                    continue
            return sorted(out)
    print('❌ 讀不到 ^TWII.json(workflow 要先從 gh-pages 撈出來)')
    sys.exit(1)


def fetch_all():
    import yfinance as yf
    out = {}
    for k, t in TICKERS.items():
        try:
            h = yf.Ticker(t).history(period=YEARS, auto_adjust=False)
            ser = {}
            closes = list(h['Close'].items())
            for i in range(1, len(closes)):
                d0, c0 = closes[i - 1]
                d1, c1 = closes[i]
                if c0 and c0 == c0 and c1 == c1 and c0 > 0:
                    ser[str(d1)[:10]] = (c1 / c0 - 1) * 100
            out[k] = ser
            print(f'  {k:4s} {t:8s} → {len(ser)} 天 ・最早 {min(ser) if ser else "-"}')
        except Exception as e:
            print(f'  {k:4s} {t:8s} → ❌ {type(e).__name__}: {str(e)[:80]}')
            out[k] = {}
    return out


def prev_val(ser, day):
    """台股 T 日之前、最近一個有資料的海外交易日的漲跌%(⛔ 不可取 T 日本身 = 前視)。"""
    best = None
    for d, v in ser.items():
        if d < day and (best is None or d > best[0]):
            best = (d, v)
    return best[1] if best else None


# 🚨🚨 STRICT 模式(V74.4.5 第二版,⛔ 這條是要接進前端的前提):
#   前端的 `macro_risk.json` **沒有道瓊(dji)也沒有恆指(hs)** → 如果探針用 10 個成分算、
#   前端只用 8 個成分算,那是**同名不同義**(全專案犯過最多次的錯):
#   前端顯示「今天 4 分」配上探針「4 分那格的歷史勝率」= 拿別人的成績單貼在自己身上。
#   → STRICT=1 時**只用前端也算得出來的 8 個成分**,兩邊完全一致才可以接。
STRICT = os.getenv('PREMKT_STRICT', '') == '1'


def score(day, S):
    """回傳 (分數, 用到幾項)。⛔ 缺的項目不計分也不猜。"""
    s, n = 0.0, 0
    sign = lambda v: 1 if v > 0 else -1 if v < 0 else 0
    for k in (('ndx', 'spx') if STRICT else ('dji', 'ndx', 'spx')):
        v = prev_val(S[k], day)
        if v is not None:
            s += sign(v); n += 1
    v = prev_val(S['sox'], day)
    if v is not None:
        s += sign(v) * 1.5; n += 1
    v = prev_val(S['tsm'], day)
    if v is not None:
        s += sign(v) * 2; n += 1
    # VIX:用**水位**不是漲跌 → 需要收盤價,這裡用漲跌代理(⚠️ 誠實限制,權重壓到 0.5)
    v = prev_val(S['vix'], day)
    if v is not None:
        s += (-0.5 if v > 0 else 0.5); n += 1
    for k, w in ((('nk', 1), ('ks', 1)) if STRICT else (('nk', 1), ('ks', 1), ('hs', 0.5))):
        v = prev_val(S[k], day)
        if v is not None:
            s += (0.5 if v > 0.3 else -0.5 if v < -0.3 else 0) * 2 * w   # 對齊 App 的 _asiaScore 量級
            n += 1
    v = prev_val(S['twd'], day)     # 台幣貶值(TWD=X 上升)→ 外資撤 → 偏空
    if v is not None:
        s += (-1 if v >= 0.4 else -0.5 if v >= 0.15 else 1 if v <= -0.4 else 0.5 if v <= -0.15 else 0)
        n += 1
    return s, n


def stats(a):
    if not a:
        return None
    a = sorted(a)
    return {'n': len(a), 'avg': sum(a) / len(a), 'med': a[len(a) // 2],
            'wr': sum(1 for x in a if x > 0) / len(a) * 100}


def main():
    print(f'🌅 盤前體檢分數回測 ・海外歷史 {YEARS} ・模式={"STRICT(只用前端也有的 8 個成分)" if STRICT else "完整(10 個成分)"}')
    S = fetch_all()
    if sum(len(v) for v in S.values()) < 1000:
        print('❌ 海外資料抓太少 → 不下結論')
        sys.exit(1)
    twii = load_twii()
    print(f'📈 加權指數:{len(twii)} 天 ・{twii[0][0]} ~ {twii[-1][0]}')

    rows = []
    for i in range(1, len(twii)):
        d, o, c = twii[i]
        pc = twii[i - 1][2]
        s, n = score(d, S)
        if n < (6 if not STRICT else 5):   # 🚧 用到的成分太少就不算(⛔ 半套分數不可拿來下結論)
            continue
        rows.append({'d': d, 's': s,
                     'gap': (o / pc - 1) * 100,      # 開盤跳空(盤前體檢真正在講的)
                     'day': (c / pc - 1) * 100,      # 當日全天漲跌
                     'io': (c / o - 1) * 100})       # 開盤買收盤賣
    print(f'📊 可評分的交易日:{len(rows)}(用到 ≥6 個成分)')
    if len(rows) < 200:
        print('⏳ 樣本不足')
        sys.exit(1)

    allday = [r['day'] for r in rows]
    base = stats(allday)
    print(f"\n(對照組=所有交易日:平均 {base['avg']:+.3f}% ・中位 {base['med']:+.3f}% ・上漲比例 {base['wr']:.1f}%)")

    BUCKETS = [('🔴 分數 ≥3(開高偏多)', lambda s: s >= 3),
               ('🔺 1 ~ 3', lambda s: 1 <= s < 3),
               ('➖ −1 ~ 1(中性)', lambda s: -1 < s < 1),
               ('🔻 −3 ~ −1', lambda s: -3 < s <= -1),
               ('🟢 分數 ≤−3(開低偏空)', lambda s: s <= -3)]
    print('\n═══ ① 分數 vs 隔日大盤(⭐ 主判準:開盤跳空 —— 盤前體檢講的就是開高開低)═══')
    for name, f in BUCKETS:
        sub = [r for r in rows if f(r['s'])]
        if len(sub) < 30:
            print(f'  {name}: n={len(sub)} ⏳ 樣本不足')
            continue
        g, dy, io = stats([r['gap'] for r in sub]), stats([r['day'] for r in sub]), stats([r['io'] for r in sub])
        print(f"  {name}: n={g['n']:4d} ・跳空 {g['avg']:+.3f}%(開高比例 {g['wr']:.1f}%)"
              f" ・全天 {dy['avg']:+.3f}%(上漲 {dy['wr']:.1f}%)・開盤買收盤賣 {io['avg']:+.3f}%")

    # ② 單調性 + 穩健性(前後半 / 逐年)
    print('\n═══ ② 穩健性:最高分桶 − 最低分桶 ═══')
    hi = [r for r in rows if r['s'] >= 3]
    lo = [r for r in rows if r['s'] <= -3]
    # ⭐⭐ 'io'(開盤買收盤賣)是**最關鍵**的一欄:
    #    「分數高 → 開高」有一大半是**同義反覆**(昨晚美股漲,台股本來就會開高,那不是預測)。
    #    真正的預測力是「**開高之後還會不會繼續漲**」= 開盤買收盤賣。⛔ 不看這欄會高估這個分數。
    for label, key in (('開盤跳空(含同義反覆)', 'gap'), ('全天漲跌', 'day'), ('⭐ 開盤買收盤賣(扣掉同義反覆)', 'io')):
        dh, dl = stats([r[key] for r in hi]), stats([r[key] for r in lo])
        if not dh or not dl:
            continue
        spread = dh['avg'] - dl['avg']
        mid = sorted(r['d'] for r in rows)[len(rows) // 2]
        h1 = (stats([r[key] for r in hi if r['d'] < mid]) or {}).get('avg')
        l1 = (stats([r[key] for r in lo if r['d'] < mid]) or {}).get('avg')
        h2 = (stats([r[key] for r in hi if r['d'] >= mid]) or {}).get('avg')
        l2 = (stats([r[key] for r in lo if r['d'] >= mid]) or {}).get('avg')
        s1 = (h1 - l1) if (h1 is not None and l1 is not None) else None
        s2 = (h2 - l2) if (h2 is not None and l2 is not None) else None
        yrs = {}
        for y in sorted({r['d'][:4] for r in rows}):
            a = stats([r[key] for r in hi if r['d'][:4] == y])
            b = stats([r[key] for r in lo if r['d'][:4] == y])
            if a and b and a['n'] >= 10 and b['n'] >= 10:
                yrs[y] = a['avg'] - b['avg']
        same = (s1 is not None and s2 is not None and s1 * s2 > 0)
        print(f"  {label}:高分桶 {dh['avg']:+.3f}% − 低分桶 {dl['avg']:+.3f}% = **{spread:+.3f}pp**"
              f" ・前後半 {s1:+.3f}/{s2:+.3f} {'✅同向' if same else '❌不同向'}"
              f" ・逐年 {' '.join(f'{y}:{v:+.2f}' for y, v in yrs.items())}")
        if yrs:
            worst = min(yrs.values())
            print(f"     逐年最差 {worst:+.3f}pp {'(全部同向 ✅)' if min(yrs.values()) > 0 else '(有年份反向 ❌)'}")

    # ③ V74.3.3 使用者:「幫我回測開低、開平、開高的機率,與分數的比對」
    #    ⭐ 桶用 **App 上顯示的 0~100 分**(sPct = 50 + s×5),⛔ 不用內部的 ±10 分 ——
    #       使用者看到的是 50/100,拿內部分數報表他對不起來。
    #    ⚠️ 「開平」的界線是**我訂的**(±0.3%),⛔ 不是市場定義 → 一併印 ±0.5% 版本讓它可被檢查。
    print('\n═══ ③ 分數 vs 開低 / 開平 / 開高(⭐ 桶用 App 顯示的 0~100 分)═══')
    PB = [('偏多 ≥65 分', lambda v: v >= 65), ('55 ~ 65', lambda v: 55 <= v < 65),
          ('中性 45 ~ 55', lambda v: 45 <= v < 55), ('35 ~ 45', lambda v: 35 <= v < 45),
          ('偏空 ≤35 分', lambda v: v < 35)]
    for band in (0.3, 0.5):
        print(f'  ── 開平的界線 = 跳空在 ±{band}% 以內 ──')
        for name, f in PB:
            sub = [r for r in rows if f(50 + r['s'] * 5)]
            if len(sub) < 30:
                print(f'    {name}: n={len(sub)} ⏳ 樣本不足')
                continue
            hi = sum(1 for r in sub if r['gap'] > band)
            lo = sum(1 for r in sub if r['gap'] < -band)
            fl = len(sub) - hi - lo
            n = len(sub)
            io = stats([r['io'] for r in sub])
            print(f"    {name}: n={n:4d} ・開高 {hi/n*100:5.1f}% ・開平 {fl/n*100:5.1f}% ・開低 {lo/n*100:5.1f}%"
                  f"  ⭐ 開盤買收盤賣 {io['avg']:+.3f}%")
    # ⭐ 對照組:不看分數,單純「隨便挑一天」的開低開平開高比例 —— ⛔ 沒有它就不知道上面那些算不算高
    for band in (0.3, 0.5):
        hi = sum(1 for r in rows if r['gap'] > band)
        lo = sum(1 for r in rows if r['gap'] < -band)
        n = len(rows)
        print(f"  (對照組・±{band}%)所有交易日:開高 {hi/n*100:.1f}% ・開平 {(n-hi-lo)/n*100:.1f}% ・開低 {lo/n*100:.1f}%")

    print('\n⚠️ 誠實限制(⛔ 不可省略):')
    print('   ① 這只是盤前體檢的**海外連動部分**(約一半權重)——'
          '外資期貨/現貨(~4分)、台指期夜盤(1.5)、大盤技術分數(2)、恐懼貪婪(0.5)**沒有歷史**,無法計分。')
    print('   ② VIX 這裡用「漲跌」代理「水位」(權重壓到 0.5),跟 App 的 <20/>25/>30 分級不同。')
    print('   ③ 一律用 T−1 的海外收盤預測 T 日台股(零前視);假日用最近一個有資料的日子。')
    print('   ④ ⛔ 分數高 ≠ 該買:這裡量的是「大盤開高/收紅的機率」,'
          '⛔ 不含任何個股選擇,也沒有扣交易成本。')
    print('   ⑥ 「開平」的界線(±0.3% / ±0.5%)是**我訂的**,⛔ 不是市場定義 —— 換一個界線比例會變。')
    print('   ⑤ ⭐⭐ 「跳空」那欄有一大半是**同義反覆**(昨晚美股漲 → 台股本來就會開高)——'
          '真正的預測力要看「開盤買收盤賣」那一欄。')
    print('done', datetime.utcnow().isoformat() + 'Z')


if __name__ == '__main__':
    main()
