#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
💳 大盤融資維持率門檻探針(V73.3.8)—— 只讀、手動觸發、不寫產物。

🚨 為什麼現在才做得了:CLAUDE.md 對「維持率 <135% 恐慌 / <140% 斷頭潮」(兆華 f07)、
   「<130% 券商強制斷頭 → V 型反彈」(權證小哥)這些門檻,一直寫著:
     「⛔ **不加那兩條線** —— `margin_hist` 從 V72.2.1 才開始存,**沒有歷史可驗**,
       加上去就是又一個沒驗證過的預測性門檻」
   ⭐ FinMind 缺口探針實測:`TaiwanTotalExchangeMarginMaintenance` 有 **2015 起 2,821 天**
      的**官方**大盤維持率 → **終於驗得動了**。

⚠️ 而且這同時解掉另一件事:V72.0.3 那個 127.9% 是我**自己推估**的
   (成本用「融資餘額增加日均價」反推,系統性偏高,掛了四條免責)。
   ⭐ 探針要順便比對「官方值 vs 我的推估」差多少 —— ⛔ 不可假設換上去就一定更好。

📐 六道關卡(照 CLAUDE.md 回測鐵則):
   ① 對照組 = **所有交易日**,⛔ 不抽樣
   ② 事件 20 日去重
   ③ 多個門檻一起測 → 看**是不是單調**(單點好看 = 過度配適)
   ④ 前後半段各自檢定
   ⑤ 拿掉貢獻最大的那一年後還成立嗎
   ⑥ ⭐ 同時測「**相對自己的歷史位階**」版本 —— 同 V71.1.6 外資期貨的教訓:
      寫死絕對門檻會隨市場結構失真(小台上市後未平倉放大 → 絕對口數門檻天天觸發)

⛔ 安全:只記「第幾把 token」,絕不印金鑰值。
⚠️ 沙箱連不到 FinMind → 只能雲端跑。
"""
import json
import os
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.finmindtrade.com/api/v4/data'
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
HORIZONS = (5, 10, 20, 60)
DEDUP = 20


def fm(dataset, extra=None, start='2015-01-01'):
    last = 'no-token'
    for i in range(max(1, len(TOKENS))):
        q = {'dataset': dataset, 'start_date': start}
        q.update(extra or {})
        if TOKENS:
            q['token'] = TOKENS[i]
        try:
            with urllib.request.urlopen(API + '?' + urllib.parse.urlencode(q), timeout=60) as r:
                j = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                raw = e.read().decode('utf-8', 'replace')[:200]
                last = f'http{e.code}:{str((json.loads(raw) or {}).get("msg") or raw)[:70]}'
            except Exception:
                last = f'http{e.code}'
            continue
        except Exception as e:
            last = type(e).__name__
            continue
        rows = (j or {}).get('data') or []
        if rows:
            return rows, i + 1, None
    return None, None, last


def _d(x):
    return str(x or '').replace('/', '-')[:10]


def main():
    if not TOKENS:
        print('❌ 沒有 FINMIND_TOKENS')
        return 1

    mm, tok, err = fm('TaiwanTotalExchangeMarginMaintenance')
    if not mm:
        print(f'❌ 大盤維持率抓不到:{err}')
        return 1
    print(f'✅ 官方大盤維持率 {len(mm):,} 列(用第 {tok} 把)')
    print(f'   欄位:{", ".join(sorted(mm[0].keys()))}')
    # 找出「維持率」是哪一欄(⛔ 別猜欄名,實測才知道)
    numcols = [k for k, v in mm[0].items() if isinstance(v, (int, float))]
    print(f'   數值欄:{numcols}')
    col = None
    for c in numcols:
        vals = [float(r[c]) for r in mm[:300] if isinstance(r.get(c), (int, float))]
        if vals and 100 <= statistics.median(vals) <= 300:
            col = c
            break
    if not col:
        print('❌ 找不到維持率欄位(數值落在 100~300 的那一欄)→ 印前 2 列自己看:')
        print(json.dumps(mm[:2], ensure_ascii=False)[:500])
        return 1
    print(f'   ⭐ 判定維持率欄位 = `{col}`')

    M = {}
    for r in mm:
        d = _d(r.get('date'))
        v = r.get(col)
        if d and isinstance(v, (int, float)):
            M[d] = float(v)

    px, _, err2 = fm('TaiwanStockPrice', {'data_id': 'TAIEX'})
    if not px:
        print(f'❌ 加權指數抓不到:{err2}')
        return 1
    P = {}
    for r in px:
        d = _d(r.get('date'))
        c = r.get('close')
        if d and isinstance(c, (int, float)) and c:
            P[d] = float(c)
    days = sorted(set(M) & set(P))
    print(f'✅ 加權指數 {len(px):,} 列 → 兩邊都有的交易日 **{len(days):,}** 天({days[0]} ~ {days[-1]})\n')

    vals = [M[d] for d in days]
    print(f'📊 維持率分布:最低 {min(vals):.1f}% ・P5 {statistics.quantiles(vals, n=20)[0]:.1f}% '
          f'・中位 {statistics.median(vals):.1f}% ・P95 {statistics.quantiles(vals, n=20)[18]:.1f}% ・最高 {max(vals):.1f}%')
    print(f'   最近一筆:{days[-1]} = **{M[days[-1]]:.2f}%**')
    print(f'   ⚠️ 對照:V72.0.3 我自己推估的是 127.9%(2026-08)—— 差多少見上面這個數字\n')

    idx = {d: i for i, d in enumerate(days)}

    def fwd(d, h):
        i = idx[d]
        if i + h >= len(days):
            return None
        a, b = P[days[i]], P[days[i + h]]
        return (b - a) / a * 100.0 if a else None

    def bucket(name, hit):
        """hit(d) -> bool;回 {h: [報酬]} + 日期清單。含 20 日去重。"""
        out = {h: [] for h in HORIZONS}
        dts = []
        last = -999
        for i, d in enumerate(days):
            if not hit(d):
                continue
            if i - last < DEDUP:
                continue
            last = i
            dts.append(d)
            for h in HORIZONS:
                r = fwd(d, h)
                if r is not None:
                    out[h].append(r)
        return out, dts

    base, base_dts = bucket('all', lambda d: True)
    bm = {h: statistics.median(base[h]) for h in HORIZONS}
    print(f'📐 對照組 = **所有交易日**(⛔ 不抽樣),去重後 {len(base_dts):,} 筆')
    print('   基準中位報酬:' + ' ・'.join(f'{h}日 {bm[h]:+.2f}%' for h in HORIZONS) + '\n')

    # ── ① 絕對門檻:多個一起測,看是不是單調 ──
    print('── ① 絕對門檻「跌破 X%」後大盤怎麼走(邊際 = 減掉基準)──')
    hdr = f'{"門檻":<12}{"n":>6}' + ''.join(f'{str(h)+"日":>11}' for h in HORIZONS)
    print(hdr); print('─' * len(hdr))
    abs_res = {}
    for th in (125, 130, 135, 140, 145, 150, 155, 160):
        b, dts = bucket(f'<{th}', lambda d, t=th: M[d] < t)
        n = len(b[HORIZONS[0]])
        if n < 5:
            print(f'{"<"+str(th)+"%":<12}{n:>6}   樣本太少')
            continue
        cells = ''.join(f'{statistics.median(b[h]) - bm[h]:>+10.2f}pp' for h in HORIZONS)
        print(f'{"<"+str(th)+"%":<12}{n:>6}{cells}')
        abs_res[th] = (b, dts)

    # ── ② 相對位階(同 V71.1.6 教訓:寫死絕對門檻會失真)──
    print('\n── ② 相對「自己近 3 年」的位階(⭐ 不寫死數字)──')
    W = 750
    pct = {}
    for i, d in enumerate(days):
        if i < 250:
            continue
        w = [M[x] for x in days[max(0, i - W):i + 1]]
        pct[d] = sum(1 for x in w if x <= M[d]) / len(w) * 100
    print(hdr); print('─' * len(hdr))
    rel_res = {}
    for lo, hi, lab in ((0, 5, '最低 5%'), (0, 10, '最低 10%'), (0, 20, '最低 20%'),
                        (80, 101, '最高 20%'), (95, 101, '最高 5%')):
        b, dts = bucket(lab, lambda d, l=lo, h2=hi: d in pct and l <= pct[d] < h2)
        n = len(b[HORIZONS[0]])
        if n < 5:
            print(f'{lab:<12}{n:>6}   樣本太少')
            continue
        cells = ''.join(f'{statistics.median(b[h]) - bm[h]:>+10.2f}pp' for h in HORIZONS)
        print(f'{lab:<12}{n:>6}{cells}')
        rel_res[lab] = (b, dts)

    # ── ③ 穩健性:前後半段 + 拿掉貢獻最大的那一年 ──
    mid = days[len(days) // 2]
    print(f'\n── ③ 穩健性檢定(20 日;分界 {mid})──')
    print('   ⛔ 前後半段不同向、或拿掉某一年就由正轉負 → 不成立')

    def robust(lab, b, dts):
        ev = {d: fwd(d, 20) for d in dts}
        ev = {d: v for d, v in ev.items() if v is not None}
        if len(ev) < 8:
            return f'   {lab:<12} 樣本不足({len(ev)})'
        bl = {d: fwd(d, 20) for d in base_dts}
        bl = {d: v for d, v in bl.items() if v is not None}
        full = statistics.median(ev.values()) - statistics.median(bl.values())
        parts = []
        for lo, hi, tag in ((None, mid, '前半'), (mid, None, '後半')):
            e = [v for d, v in ev.items() if (lo is None or d >= lo) and (hi is None or d < hi)]
            bb = [v for d, v in bl.items() if (lo is None or d >= lo) and (hi is None or d < hi)]
            parts.append(f'{tag} {statistics.median(e)-statistics.median(bb):+.2f}pp(n={len(e)})' if len(e) >= 4 and bb else f'{tag} n={len(e)} 不足')
        yrs = {}
        for d, v in ev.items():
            yrs.setdefault(d[:4], []).append(v)
        contrib = {y: (statistics.median(v) - statistics.median(bl.values())) * len(v) for y, v in yrs.items() if len(v) >= 3}
        drop = ''
        if contrib:
            worst = max(contrib, key=contrib.get)
            re_ = [v for d, v in ev.items() if d[:4] != worst]
            rb = [v for d, v in bl.items() if d[:4] != worst]
            if len(re_) >= 4 and rb:
                r = statistics.median(re_) - statistics.median(rb)
                flag = '⛔ 靠那一年' if (full > 0 and r <= 0) else ('✅ 仍成立' if r > 0 else '➖')
                drop = f' ・拿掉 {worst} 後 {r:+.2f}pp {flag}'
        return f'   {lab:<12} 整段 {full:+.2f}pp ・' + ' ・'.join(parts) + drop

    for th, (b, dts) in abs_res.items():
        print(robust(f'<{th}%', b, dts))
    for lab, (b, dts) in rel_res.items():
        print(robust(lab, b, dts))

    print('\n⚠️ 提醒:這是**大盤**層級的擇時訊號 —— CLAUDE.md 已實測過'
          '「大盤有邊際 ≠ 個股打法在那之後進場也有效」(地板股 300+ 那次差 98 萬)。')
    print('⛔ 要拿來當個股進場濾網,必須另外用 portfolio_backtest 再測一次。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
