#!/usr/bin/env python3
"""🔥 券資比 / 軋空探針 —— 「券資比高 + 主力在買 = 軋空」有沒有邊際?

來源:逐字稿(權證小哥)多次提到軋空(37 處)。他描述的完整條件是:
  「券資比高」+「主力有在買(分點)」+「股價沿著布林上軌走」→ 軋空行情
  而且他自己也強調:被軋到要**趕快停損**,因為「你不曉得這座山的山頂在哪」。

⭐ 資料現況:`data/{sym}.json` 早就有 `short_balance`(融券餘額)與 `margin_balance`(融資餘額),
   但**全 App 從來沒算過券資比**(只有把融券張數畫出來)。所以這是真缺口,值得驗。

券資比 = 融券餘額 ÷ 融資餘額 × 100
  ・比值高 = 空方壓力累積,一旦上漲空單要回補 → 助漲(軋空燃料)
  ・比值低 = 沒什麼空單,沒有軋空題材

⛔ 照鐵則「探針先行、實測不猜」。只讀 data/,不打 API、不寫檔。

方法論(照 CLAUDE.md 四點):
  ① **乾淨對照組**:同一批有融資券資料的股票,依券資比分桶互為對照
     (⛔ 不能拿全市場比 —— 有融資券的本來就偏熱門股)
  ② **扣掉同期大盤**;③ 同檔 5 交易日內只算一次;④ 每桶至少 150 筆
  ⑤ ⭐ 額外做「**券資比不寫死門檻,用該股自己的歷史百分位**」的版本
     —— 同 V71.1.6 外資期貨、V71.8.1 波動率的教訓:絕對門檻會因個股結構失真
     (權值股融資基數大、小型股融資基數小,同一個 5% 意義完全不同)。

════════════════════════════════════════════════════════════════
📊 2026-08-03 實測結果:**不做**(V71.9.2 決策紀錄)
════════════════════════════════════════════════════════════════
1,002 檔 ・9,893 個事件:

  券資比(自身歷史百分位)  n      3日      5日     10日   10日勝率
  自身最低 25%          5,444  −0.72%  −0.64%  −1.41%   42.8%
  自身 25~75%          3,346  −0.90%  −0.90%  −1.88%   41.8%
  自身最高 25%            540  −0.62%  −0.60%  −1.75%   43.0%
  ⭐ 自身最高 10%          369  −1.38%  −1.76%  −3.07%   33.6%

❌ **方向跟「軋空」相反**:券資比最高那 10% 反而最差(−3.07% vs −1.41%,差 −1.65pp)。

⭐ 而且做了**最關鍵的拆解**(這步不做會得到錯誤結論):
     「外資買」在券資比**不高**時 = −0.86%,在券資比**高**時 = −2.81%
     → 券資比的額外貢獻 **−1.95pp** → 真正有用的是「外資買」,券資比不但沒加分還扣分。
   ⛔ 所以**不為券資比開任何功能**。⚠️ 別被「券資比高 × 外資買 vs × 外資賣 = +0.87pp」
     那個數字騙了 —— 那只證明「外資方向有用」,不證明券資比有用。

⚠️⚠️ 但這個結論有一個**必須講清楚的重大限制**:
   融資券資料(`margin_balance` / `short_balance`)**只回溯到 2026/05/14**(約 55 個交易日),
   而那個窗口大盤是**下跌**的(參 CLAUDE.md broker_habit 那次:窗口內大盤 −8.4%)。
   **空頭段裡「空單多」本來就是對的**,軋空要在多頭段才會發生。
   → 正確說法是「**在我目前唯一有的窗口裡不成立**」,⛔ 不是「軋空這件事是假的」。
   → 融資券資料累積滿 1 年、且涵蓋一段多頭之後,**要重跑這支再決定**。

跑法:python3 short_probe.py
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

DATA = Path('data')
HORIZONS = (3, 5, 10)
DEDUP = 5
MIN_BUCKET = 150


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


def main():
    tw = {}
    for r in load(DATA / '^TWII.json') or []:
        try:
            c = float(r.get('close') or 0)
            d = str(r.get('date') or '').replace('/', '-')
            if c > 0 and d:
                tw[d] = c
        except (TypeError, ValueError):
            pass
    if not tw:
        print('⚠️ 沒有 ^TWII.json')
        return 2

    files = [f for f in sorted(DATA.glob('*.json')) if f.stem.isdigit() and len(f.stem) == 4]
    print(f'📂 掃描 {len(files)} 檔\n')

    abs_b = defaultdict(lambda: defaultdict(list))    # 絕對門檻分桶
    pct_b = defaultdict(lambda: defaultdict(list))    # 自身歷史百分位分桶
    combo = defaultdict(lambda: defaultdict(list))    # 券資比高 × 外資買
    n_sym = n_evt = 0

    for f in files:
        rows = load(f) or []
        if len(rows) < 120:
            continue
        try:
            dates = [str(r['date']).replace('/', '-') for r in rows]
            cl = [float(r.get('close') or 0) for r in rows]
            mg = [float(r.get('margin_balance') or 0) for r in rows]
            sh = [float(r.get('short_balance') or 0) for r in rows]
            fn = [float(r.get('foreign_net') or 0) for r in rows]
        except (KeyError, TypeError, ValueError):
            continue
        if min(cl) <= 0:
            continue
        # 券資比(融資為 0 的日子算不出來)
        sr = [(sh[i] / mg[i] * 100) if mg[i] > 0 else None for i in range(len(cl))]
        known = [x for x in sr if x is not None]
        if len(known) < 30:
            continue
        n_sym += 1
        ks = sorted(known)

        def pctile(v):
            lo, hi = 0, len(ks)
            while lo < hi:
                m = (lo + hi) // 2
                if ks[m] < v:
                    lo = m + 1
                else:
                    hi = m
            return lo / len(ks) * 100

        last_evt = -99
        for i in range(len(cl) - len(known) , len(cl) - max(HORIZONS)):
            if sr[i] is None or i - last_evt < DEDUP:
                continue
            last_evt = i
            n_evt += 1
            v = sr[i]
            ab = ('A <1%' if v < 1 else 'B 1~3%' if v < 3 else
                  'C 3~10%' if v < 10 else 'D 10~30%' if v < 30 else 'E ≥30%')
            p = pctile(v)
            pb = ('自身最低 25%' if p < 25 else '自身 25~75%' if p < 75 else
                  '自身最高 25%' if p < 90 else '⭐ 自身最高 10%')
            # 外資近 5 日淨買
            f5 = sum(fn[max(0, i - 4):i + 1])
            ck = f'{"券資比高(自身前10%)" if p >= 90 else "其餘"}×{"外資買" if f5 > 0 else "外資賣"}'
            d0 = dates[i]
            for h in HORIZONS:
                d1 = dates[i + h]
                if d0 in tw and d1 in tw and tw[d0] > 0:
                    ex = (cl[i + h] - cl[i]) / cl[i] * 100 - (tw[d1] - tw[d0]) / tw[d0] * 100
                    abs_b[ab][h].append(ex)
                    pct_b[pb][h].append(ex)
                    combo[ck][h].append(ex)

    print(f'✅ {n_sym} 檔 ・{n_evt} 個事件(同檔 {DEDUP} 交易日內只算一次)')
    print('   券資比 = 融券餘額 ÷ 融資餘額 × 100;報酬皆為**超額**(已扣同期加權)\n')

    def show(title, b, order=None):
        print(title)
        print(f'{"":<24}{"n":>7}' + ''.join(f'{f"{h}日中位":>10}' for h in HORIZONS) + f'{"10日勝率":>10}')
        out = {}
        for k in (order or sorted(b)):
            v = b.get(k) or {}
            n = len(v.get(10) or [])
            if n < MIN_BUCKET:
                print(f'{k:<24}{n:>7}   樣本不足')
                continue
            w = sum(1 for x in v[10] if x > 0) / n * 100
            out[k] = statistics.median(v[10])
            print(f'{k:<24}{n:>7}'
                  + ''.join(f'{statistics.median(v[h]):>+9.2f}%' for h in HORIZONS)
                  + f'{w:>9.1f}%')
        print()
        return out

    a = show('📌 ① 券資比(絕對門檻)', abs_b, ['A <1%', 'B 1~3%', 'C 3~10%', 'D 10~30%', 'E ≥30%'])
    p = show('📌 ② 券資比(⭐ 該股**自己**的歷史百分位 —— 不寫死門檻)', pct_b,
             ['自身最低 25%', '自身 25~75%', '自身最高 25%', '⭐ 自身最高 10%'])
    c = show('📌 ③ 他說的完整條件:券資比高 **且** 主力(外資)在買', combo)

    print('📊 結論')
    if a:
        hi = [v for k, v in a.items() if k[0] in 'DE']
        lo = [v for k, v in a.items() if k[0] in 'AB']
        if hi and lo:
            d = statistics.median(hi) - statistics.median(lo)
            print(f'   ① 絕對門檻:高券資比 − 低券資比 = {d:+.2f}pp'
                  f' → {"✅ 有邊際" if d > 0.8 else "➖ 沒有明顯邊際" if d > -0.8 else "❌ 反而更差"}')
    if p and '⭐ 自身最高 10%' in p and '自身最低 25%' in p:
        d = p['⭐ 自身最高 10%'] - p['自身最低 25%']
        print(f'   ② 自身百分位:最高 10% − 最低 25% = {d:+.2f}pp'
              f' → {"✅ 有邊際" if d > 0.8 else "➖ 沒有明顯邊際" if d > -0.8 else "❌ 反而更差"}')
    k1, k2 = '券資比高(自身前10%)×外資買', '券資比高(自身前10%)×外資賣'
    if k1 in c and k2 in c:
        print(f'   ③ 券資比高時,外資買 vs 外資賣 = {c[k1] - c[k2]:+.2f}pp'
              f' → {"✅ 主力方向確實有差,他的組合條件成立" if c[k1] - c[k2] > 0.8 else "➖ 加了主力方向也沒有明顯改善"}')
    o1, o2 = '其餘×外資買', '其餘×外資賣'
    if k1 in c and o1 in c:
        print(f'   ④ ⭐ 關鍵對照:「外資買」這件事本身在券資比**不高**時 = {c[o1]:+.2f}%,'
              f'券資比高時 = {c[k1]:+.2f}%')
        print(f'      → 券資比帶來的額外貢獻 {c[k1] - c[o1]:+.2f}pp'
              f' → {"✅ 券資比是有加分的" if c[k1] - c[o1] > 0.8 else "⛔ 賺的其實是「外資買」,券資比沒有加分 → 別為券資比單獨開功能"}')

    print('\n⚠️ 限制:')
    print('   ・分點「主力」我無法逐日回測(chips 只有滾動 20 日快照)→ 用外資近 5 日淨買代替,')
    print('     跟他講的「特定分點在買」不完全是同一件事。')
    print('   ・「沿布林上軌」那條沒測(那是形態確認,不是選股條件)。')
    print('   ・data/ 只有 2~3 年、已下市的不在裡面(倖存者偏誤);未扣交易成本。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
