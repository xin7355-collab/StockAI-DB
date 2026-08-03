#!/usr/bin/env python3
"""🧊 「兩上兩下」籌碼選股探針 —— 逐字稿裡權證小哥自述的選股邏輯,拿我的資料驗一次。

來源:使用者提供的 113 份逐字稿,其中「籌碼視覺選股」那集他直接講了自己的順序:
  ・大戶持股(≥400 張)要**往上**
  ・主力(全台前 15 大買超分點 vs 前 15 大賣超分點 PK)要**往上**
  ・散戶(<100 張)要**往下**(人多的地方不要去)
  ・融資要**往下**(散戶融資退潮);若大戶增、融資也增 → 那是「主力融資」不是散戶
  ・觀察區間拉半年到一年

⛔ 照鐵則「探針先行、實測不猜」。這支只讀 data/,不打 API、不寫檔。

方法論(照 CLAUDE.md 四點):
  ① **乾淨對照組**:同一週、同樣有資料的其他股票當基準,而不是只跟自己比。
  ② **扣掉同期大盤**:報酬一律減去同期加權指數。
  ③ **事件去重**:集保是週資料,一檔一週最多算一次。
  ④ **樣本守門**:每個桶至少 100 筆才報數字。

⚠️ 硬限制(先寫出來,免得數字被過度解讀):
  `tdcc_holders.json` 只有 **13 週**(約 3 個月)→ 涵蓋不到一個完整多空循環,
  而且全部落在同一個市場環境。結論只能當方向參考,**不足以當定論**。
  累積到 1 年以上再重跑才有統計意義。

跑法:python3 tdcc_probe.py
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

DATA = Path('data')
HORIZONS = (5, 10, 20)
MIN_BUCKET = 100


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


def daily(rows):
    """回 {日期(YYYY-MM-DD): (close, margin_balance)}, 以及排序後的日期清單"""
    m, order = {}, []
    for r in rows if isinstance(rows, list) else []:
        try:
            c = float(r.get('close') or 0)
            d = str(r.get('date') or '').replace('/', '-')
            if c > 0 and d:
                m[d] = (c, float(r.get('margin_balance') or 0))
                order.append(d)
        except (TypeError, ValueError):
            continue
    return m, sorted(set(order))


def main():
    tdcc = load(DATA / 'tdcc_holders.json')
    if not isinstance(tdcc, dict) or len(tdcc) < 100:
        print('❌ 找不到 data/tdcc_holders.json')
        return 2
    twii_map, twii_days = daily(load(DATA / '^TWII.json') or [])
    if not twii_map:
        print('⚠️ 沒有 ^TWII.json → 無法扣同期大盤')
        return 2

    weeks = max((len(v.get('h') or []) for v in tdcc.values() if isinstance(v, dict)), default=0)
    print(f'📂 集保 {len(tdcc)} 檔 ・最長 {weeks} 週歷史\n')

    # bucket: (大戶方向, 散戶方向, 融資方向) → 超額報酬
    buckets = defaultdict(lambda: defaultdict(list))
    n_evt = 0

    for sym, v in tdcc.items():
        if sym.startswith('__') or not isinstance(v, dict):
            continue
        h = v.get('h') or []
        if len(h) < 4:
            continue
        px, days = daily(load(DATA / f'{sym}.json') or [])
        if len(days) < 60:
            continue
        dayset = days

        for wi in range(1, len(h) - 1):
            try:
                d_cur = str(h[wi][0])
                big_now, big_prev = float(h[wi][1]), float(h[wi - 1][1])
                ret_now, ret_prev = float(h[wi][3]), float(h[wi - 1][3])
            except (IndexError, TypeError, ValueError):
                continue
            iso = f'{d_cur[:4]}-{d_cur[4:6]}-{d_cur[6:8]}'
            # 找集保結算日之後的第一個交易日當進場點
            fut = [d for d in dayset if d > iso]
            if len(fut) < max(HORIZONS) + 1:
                continue
            d0 = fut[0]
            # 融資方向:進場日 vs 一週前
            past = [d for d in dayset if d <= iso]
            if len(past) < 6:
                continue
            mg_now = px[d0][1]
            mg_prev = px[past[-6]][1]
            if not (mg_now > 0 and mg_prev > 0):
                continue

            key = ('大戶↑' if big_now > big_prev else '大戶↓',
                   '散戶↓' if ret_now < ret_prev else '散戶↑',
                   '融資↓' if mg_now < mg_prev else '融資↑')
            n_evt += 1
            for hz in HORIZONS:
                d1 = fut[hz]
                if d0 not in px or d1 not in px:
                    continue
                r_stk = (px[d1][0] - px[d0][0]) / px[d0][0] * 100
                if d0 in twii_map and d1 in twii_map:
                    r_mkt = (twii_map[d1][0] - twii_map[d0][0]) / twii_map[d0][0] * 100
                    buckets[key][hz].append(r_stk - r_mkt)

    print(f'✅ 事件數 {n_evt}(每檔每週最多 1 次)・報酬皆為**超額**(已扣同期加權)\n')
    target = ('大戶↑', '散戶↓', '融資↓')
    rows = []
    for key, hs in buckets.items():
        n = len(hs.get(20, []))
        if n < MIN_BUCKET:
            continue
        rows.append((key, {h: (statistics.median(hs[h]),
                               sum(1 for x in hs[h] if x > 0) / len(hs[h]) * 100,
                               len(hs[h])) for h in HORIZONS if hs.get(h)}))
    rows.sort(key=lambda x: -(x[1].get(20, (0,))[0]))

    print(f'{"組合":<22}{"n":>6}{"5日中位":>10}{"10日中位":>10}{"20日中位":>10}{"20日勝率":>10}')
    for key, d in rows:
        n = d.get(20, (0, 0, 0))[2]
        lab = '・'.join(key)
        star = ' ⭐' if key == target else ''
        print(f'{lab:<22}{n:>6}'
              + ''.join(f'{d.get(h, (0,))[0]:>+9.2f}%' for h in HORIZONS)
              + f'{d.get(20, (0, 0))[1]:>9.1f}%{star}')

    print()
    tgt = next((d for k, d in rows if k == target), None)
    allv = [x for _, d in rows for x in [d.get(20, (0,))[0]]]
    base = statistics.median(allv) if allv else 0
    if not tgt:
        print(f'⛔ 「{"・".join(target)}」樣本不足 {MIN_BUCKET} 筆,無法下結論。')
    else:
        edge = tgt[20][0] - base
        print(f'📌 「兩上兩下」({"・".join(target)}) 20 日超額報酬中位 = {tgt[20][0]:+.2f}%'
              f'(n={tgt[20][2]}、勝率 {tgt[20][1]:.1f}%)')
        print(f'   全部組合的中位數當基準 = {base:+.2f}% → 這個組合的邊際 {edge:+.2f}pp')
        print(f'   → {"✅ 有邊際,值得做" if edge > 0.5 else ("➖ 邊際很小,做了也沒差" if edge > -0.5 else "❌ 反而更差,別做")}')
    # ── ⭐ V71.9.7 追加:位階 × 股東人數(新逐字稿的兩個線索)────────────────
    # 逐字稿【第23集 2種再見股】:「壞的再見股…股價在**高檔**主力賣散戶買,後面會跌一段」
    #   → 「兩上兩下」卡目前**沒有位階守門**,而 cb_probe 那次證明位階常常是決定性的。
    # 另一段:「我最喜歡看這三個指標:主力買超、主力買散戶賣、**集保戶數**」
    #   → `h` 每列第 5 欄就是股東人數,一直沒用。人數減少 = 同樣股票被更少人拿著 = 籌碼集中。
    print('\n' + '=' * 66)
    print('⭐ 追加測試①:位階 × 大戶散戶方向(他說「高檔主力賣散戶買」最慘)')
    st = defaultdict(lambda: defaultdict(list))
    st2 = defaultdict(lambda: defaultdict(list))
    for sym, v in tdcc.items():
        if sym.startswith('__') or not isinstance(v, dict):
            continue
        h = v.get('h') or []
        if len(h) < 4:
            continue
        px, days = daily(load(DATA / f'{sym}.json') or [])
        if len(days) < 300:
            continue
        for wi in range(1, len(h) - 1):
            try:
                d_cur = str(h[wi][0])
                big_now, big_prev = float(h[wi][1]), float(h[wi - 1][1])
                ret_now, ret_prev = float(h[wi][3]), float(h[wi - 1][3])
                ppl_now = float(h[wi][4]) if len(h[wi]) > 4 else 0
                ppl_prev = float(h[wi - 1][4]) if len(h[wi - 1]) > 4 else 0
            except (IndexError, TypeError, ValueError):
                continue
            iso = f'{d_cur[:4]}-{d_cur[4:6]}-{d_cur[6:8]}'
            fut = [d for d in days if d > iso]
            past = [d for d in days if d <= iso]
            if len(fut) < max(HORIZONS) + 1 or len(past) < 250:
                continue
            d0 = fut[0]
            win = [px[d][0] for d in past[-250:]]
            mn, mx = min(win), max(win)
            cur = px[d0][0]
            pos = (cur - mn) / (mx - mn) * 100 if mx > mn else 50
            pb = '低位階' if pos < 33 else ('中位階' if pos < 67 else 'HI 高位階')
            bad = (big_now < big_prev) and (ret_now > ret_prev)
            good = (big_now > big_prev) and (ret_now < ret_prev)
            lab = '大戶↓散戶↑(他說最慘)' if bad else ('大戶↑散戶↓' if good else '其他')
            pk = None
            if ppl_now > 0 and ppl_prev > 0:
                pk = '股東人數↓(集中)' if ppl_now < ppl_prev else '股東人數↑(分散)'
            for hz in HORIZONS:
                d1 = fut[hz]
                if d0 in px and d1 in px and d0 in twii_map and d1 in twii_map:
                    ex = ((px[d1][0] - px[d0][0]) / px[d0][0]
                          - (twii_map[d1][0] - twii_map[d0][0]) / twii_map[d0][0]) * 100
                    st[(pb, lab)][hz].append(ex)
                    if pk:
                        st2[pk][hz].append(ex)

    print(f'{"位階":<10}{"大戶/散戶方向":<24}{"n":>6}{"20日中位":>10}{"20日勝率":>10}')
    for pb in ('低位階', '中位階', 'HI 高位階'):
        for lab in ('大戶↑散戶↓', '大戶↓散戶↑(他說最慘)'):
            v = st.get((pb, lab)) or {}
            n = len(v.get(20) or [])
            if n < MIN_BUCKET:
                print(f'{pb:<10}{lab:<24}{n:>6}   樣本不足')
                continue
            w = sum(1 for x in v[20] if x > 0) / n * 100
            print(f'{pb:<10}{lab:<24}{n:>6}{statistics.median(v[20]):>+9.2f}%{w:>9.1f}%')

    print('\n⭐ 追加測試②:股東人數方向(他的第三個指標「集保戶數」)')
    print(f'{"":<24}{"n":>6}' + ''.join(f'{f"{h}日中位":>10}' for h in HORIZONS) + f'{"20日勝率":>10}')
    got = {}
    for pk in ('股東人數↓(集中)', '股東人數↑(分散)'):
        v = st2.get(pk) or {}
        n = len(v.get(20) or [])
        if n < MIN_BUCKET:
            print(f'{pk:<24}{n:>6}   樣本不足')
            continue
        got[pk] = statistics.median(v[20])
        w = sum(1 for x in v[20] if x > 0) / n * 100
        print(f'{pk:<24}{n:>6}' + ''.join(f'{statistics.median(v[hh]):>+9.2f}%' for hh in HORIZONS) + f'{w:>9.1f}%')
    if len(got) == 2:
        d = got['股東人數↓(集中)'] - got['股東人數↑(分散)']
        print(f'   -> 集中 - 分散 = {d:+.2f}pp'
              f' -> {"OK 有邊際,值得用" if d > 0.8 else "-- 沒有明顯邊際" if d > -0.8 else "XX 反而更差"}')

    print(f'\n⚠️ 硬限制:集保只有 {weeks} 週(約 {weeks // 4} 個月),全部落在同一個市場環境,')
    print('   而且是倖存者樣本(已下市的不在裡面)。累積到 1 年以上再重跑才有統計意義。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
