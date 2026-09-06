#!/usr/bin/env python3
"""🏚️ 地板股(超跌搶反彈)探針 —— 影片說「95% 會反彈」,我用自己的資料驗一次。

來源:使用者提供的 113 份逐字稿(權證小哥)。其中「地板股 SOP」是少數**講得出具體規則**的:
  ・跌到某個乖離線 → 統計上高機率反彈(他們的線是私有的,沒公布數字)
  ・**要有量才算**:出大量 = 20 日均量的 2 倍(3 倍更強、5 倍最強)
  ・資金分 10 等份,最多搶 3 份;反彈要跑,**沒反彈也要跑**

⛔ 本專案鐵則:探針先行、實測不猜(ORB / sector_flow / broker_habit 三次的教訓)。
   所以這支不實作功能,只回答:**這個訊號在我的資料上到底有沒有邊際?**

方法論(照 CLAUDE.md 已寫成鐵則的四點做):
  ① **乾淨對照組**:同一批「超跌」的日子,分成「有 2 倍量」vs「沒有 2 倍量」。
     不設對照就分不出賺的是「跌深反彈」還是「量」帶來的。
  ② **扣掉同期大盤**:broker_habit 那次的教訓 —— 窗口內大盤 −8.4%,不扣會得到相反結論。
  ③ **事件去重**:同一檔連續幾天都超跌是同一件事,5 個交易日內只算一次。
  ④ **不寫死門檻**:乖離用「該股自己的歷史百分位」,不用固定 %(同 V71.1.6 外資期貨的教訓)。

⚠️ 已知限制:`data/` 只有 2~3 年,涵蓋的空頭段有限;倖存者偏誤(已下市的不在裡面)。
   結論只能當方向參考,若日後重跑邊際消失,就該把功能降級或移除。

跑法:python3 floor_probe.py   (只讀 data/,不打 API、不寫檔)
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

DATA = Path('data')
BIAS_PCTL = 5        # 乖離落在自己歷史最極端的前 5%
VOL_MULT = 2.0       # 影片說的 20 日均量 2 倍
DEDUP_DAYS = 5       # 事件去重
HORIZONS = (1, 3, 5, 10)


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


def series(rows):
    out = []
    for r in rows if isinstance(rows, list) else []:
        try:
            c = float(r.get('close') or 0)
            v = float(r.get('volume') or 0)
            d = str(r.get('date') or '').replace('/', '-')
            if c > 0 and d:
                out.append((d, c, v))
        except (TypeError, ValueError):
            continue
    return out


def main():
    twii = {d: c for d, c, _ in series(load(DATA / '^TWII.json') or [])}
    if not twii:
        print('⚠️ 找不到 ^TWII.json,無法扣掉同期大盤 → 先還原 data/ 再跑')
        return 2

    files = sorted(DATA.glob('*.json'))
    files = [f for f in files if not f.stem.startswith('^')]
    if not files:
        print('❌ 找不到 data/*.json(先 git archive origin/data | tar x)')
        return 2
    print(f'📂 掃描 {len(files)} 檔\n')

    # bucket → list of 超額報酬
    hit = defaultdict(list)     # 有量(≥2倍)
    ctl = defaultdict(list)     # 對照:一樣超跌但沒量
    n_sym = n_hit = n_ctl = 0

    for f in files:
        rows = series(load(f) or [])
        if len(rows) < 300:
            continue
        n_sym += 1
        dates = [d for d, _, _ in rows]
        cl = [c for _, c, _ in rows]
        vol = [v for _, _, v in rows]

        ma20, vma20, bias = [None] * len(cl), [None] * len(cl), [None] * len(cl)
        for i in range(len(cl)):
            if i >= 19:
                m = sum(cl[i - 19:i + 1]) / 20
                ma20[i] = m
                bias[i] = (cl[i] - m) / m * 100 if m > 0 else None
                vv = [x for x in vol[i - 19:i + 1] if x > 0]
                vma20[i] = (sum(vv) / len(vv)) if vv else None

        known = [b for b in bias if b is not None]
        if len(known) < 200:
            continue
        known_sorted = sorted(known)
        thr = known_sorted[max(0, int(len(known_sorted) * BIAS_PCTL / 100) - 1)]   # 自己歷史最極端 5%

        last_evt = -99
        for i in range(60, len(cl) - max(HORIZONS)):
            if bias[i] is None or bias[i] > thr:
                continue                       # 沒有極端超跌
            if i - last_evt < DEDUP_DAYS:
                continue                       # 同一件事
            last_evt = i
            big = (vma20[i] and vol[i] >= vma20[i] * VOL_MULT)
            tgt = hit if big else ctl
            if big:
                n_hit += 1
            else:
                n_ctl += 1
            for h in HORIZONS:
                r_stk = (cl[i + h] - cl[i]) / cl[i] * 100
                # 扣掉同期大盤(找得到才扣;找不到就不列入,不硬算)
                d0, d1 = dates[i], dates[i + h]
                if d0 in twii and d1 in twii and twii[d0] > 0:
                    r_mkt = (twii[d1] - twii[d0]) / twii[d0] * 100
                    tgt[h].append(r_stk - r_mkt)

    print(f'✅ 有效樣本:{n_sym} 檔 ・帶量事件 {n_hit} 次 ・對照(超跌但沒量) {n_ctl} 次')
    print(f'   訊號定義:乖離 ≤ 該股自己歷史最極端 {BIAS_PCTL}% ・量 ≥ 20日均量 ×{VOL_MULT}')
    print(f'   報酬皆為**超額**(已扣同期加權指數);同檔 {DEDUP_DAYS} 日內只算一次\n')

    print(f'{"天期":>4}{"帶量中位":>10}{"帶量勝率":>10}{"沒量中位":>10}{"沒量勝率":>10}{"量的邊際":>10}')
    verdicts = []
    for h in HORIZONS:
        a, b = hit[h], ctl[h]
        if len(a) < 30 or len(b) < 30:
            print(f'{h:>3}日  樣本不足(帶量 {len(a)} / 沒量 {len(b)})')
            continue
        ma, mb = statistics.median(a), statistics.median(b)
        wa = sum(1 for x in a if x > 0) / len(a) * 100
        wb = sum(1 for x in b if x > 0) / len(b) * 100
        edge = ma - mb
        verdicts.append((h, ma, wa, mb, wb, edge, len(a)))
        print(f'{h:>3}日{ma:>+9.2f}%{wa:>9.1f}%{mb:>+9.2f}%{wb:>9.1f}%{edge:>+9.2f}pp')

    print()
    if not verdicts:
        print('⛔ 樣本不足,無法下結論。')
        return 0
    # 影片宣稱「95% 會反彈」→ 直接對照我的實測勝率
    best = max(verdicts, key=lambda x: x[5])
    print(f'📌 影片說法:「跌到那條線,統計上 95% 會反彈」')
    print(f'   我的實測:帶量超跌後,勝率最高的天期是 {best[0]} 日 = {best[2]:.1f}%'
          f'(超額報酬中位 {best[1]:+.2f}%,n={best[6]})')
    print(f'   ⚠️ 勝率 {best[2]:.1f}% 跟 95% 差距{"很大" if best[2] < 70 else "不算大"};'
          f'而且這是**超額**報酬(已扣大盤),跟「有沒有反彈」不是同一個問題。')
    print(f'   ⭐ 真正該看的是「量的邊際」:帶量 vs 沒量 差 {best[5]:+.2f}pp'
          f' → {"量確實有幫助,值得做" if best[5] > 0.5 else "量沒有明顯幫助,別為它單獨開功能"}')
    print('\n⚠️ 限制:data/ 只有 2~3 年、空頭段有限、已下市的不在裡面(倖存者偏誤)。')
    print('   日後重跑若邊際消失,就把功能降級為參考資訊或移除,別留著誤導。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
