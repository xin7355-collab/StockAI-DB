#!/usr/bin/env python3
"""👩 投信「投量比」探針 —— 他說坊間都看錯指標,我來驗一下。

來源:逐字稿【哥有籌必爆】。他在講投信時特別更正了一個常見用法:

  「坊間一堆**投本比**(投信買賣超占**股本**比)…**但這是占成交量**,
    那要怎麼說?它叫做**投量比**」
  「這檔成交量 205 張、投信買 40 張,40 張怎麼可能進榜?你看不到投信買超排行榜,
    可是 **40 張就佔了 20%**」
  「有媽媽栽培的小孩才有爆發力」(投信 = 媽媽)

⭐ 他的論點是:**絕對張數的排行榜會漏掉小型股**。投信在冷門小股買 40 張上不了榜,
   但那 40 張可能是當天成交量的 20% —— 那才是真的被盯上。

⭐ 對本專案的意義:`trust_net` 與 `volume` **我兩個欄位都有**(回溯到 2023),
   所以投量比是**零採礦**就能算的;反而他反對的「投本比」需要股本、要另外採礦。
   → 先驗投量比有沒有用,有用才做。

⛔ 照鐵則「探針先行、實測不猜」。只讀 data/,不打 API、不寫檔。

方法論(照 CLAUDE.md 四點):
  ① **乾淨對照組**:同樣是「投信買超日」,比較高投量比 vs 低投量比
     (⛔ 不能拿「投信沒買的日子」當對照 —— 那會把「投信有買」本身的效果算進來)
  ② **扣掉同期大盤**;③ 同檔 10 交易日內只算一次;④ 每桶至少 200 筆
  ⑤ ⭐ **決定性測試**:控制住「絕對張數」之後,投量比還有沒有額外資訊?
     —— 若沒有,就代表投量比只是「小型股」的代理變數,不值得單獨做
     (同 cb_probe 控制位階、tdcc_probe 拆解融資的做法)

跑法:python3 trust_probe.py
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

DATA = Path('data')
HORIZONS = (5, 10, 20)
DEDUP = 10
MIN_BUCKET = 200


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

    ratio_b = defaultdict(lambda: defaultdict(list))   # 依投量比分桶
    lots_b = defaultdict(lambda: defaultdict(list))    # 依絕對張數分桶
    strat = defaultdict(lambda: defaultdict(list))     # 張數 × 投量比(決定性測試)
    n_sym = n_evt = 0

    for f in files:
        rows = load(f) or []
        if len(rows) < 300:
            continue
        try:
            dates = [str(r['date']).replace('/', '-') for r in rows]
            cl = [float(r.get('close') or 0) for r in rows]
            vol = [float(r.get('volume') or 0) for r in rows]
            tn = [float(r.get('trust_net') or 0) for r in rows]
        except (KeyError, TypeError, ValueError):
            continue
        if min(cl) <= 0:
            continue
        n_sym += 1
        last_evt = -99
        for i in range(20, len(cl) - max(HORIZONS)):
            if tn[i] <= 0 or vol[i] <= 0:
                continue                      # 只看「投信買超日」
            if i - last_evt < DEDUP:
                continue
            last_evt = i
            n_evt += 1
            ratio = tn[i] / vol[i] * 100      # 投量比 %
            lots = tn[i] / 1000               # 投信買超張數
            rk = ('A <1%' if ratio < 1 else 'B 1~3%' if ratio < 3 else
                  'C 3~5%' if ratio < 5 else 'D 5~10%' if ratio < 10 else
                  'E 10~20%' if ratio < 20 else '⭐ F ≥20%(他舉的例子)')
            lk = ('小 <50 張' if lots < 50 else '中 50~300 張' if lots < 300 else
                  '大 300~1000 張' if lots < 1000 else '巨 ≥1000 張')
            sk = (lk, '投量比高(≥5%)' if ratio >= 5 else '投量比低(<5%)')
            d0 = dates[i]
            for h in HORIZONS:
                d1 = dates[i + h]
                if d0 in tw and d1 in tw and tw[d0] > 0:
                    ex = (cl[i + h] - cl[i]) / cl[i] * 100 - (tw[d1] - tw[d0]) / tw[d0] * 100
                    ratio_b[rk][h].append(ex)
                    lots_b[lk][h].append(ex)
                    strat[sk][h].append(ex)

    print(f'✅ {n_sym} 檔 ・{n_evt} 個投信買超事件(同檔 {DEDUP} 交易日內只算一次)')
    print('   投量比 = 投信買超股數 ÷ 當日成交量;報酬皆為**超額**(已扣同期加權)\n')

    def show(title, b, order):
        print(title)
        print(f'{"":<24}{"n":>7}' + ''.join(f'{f"{h}日中位":>10}' for h in HORIZONS) + f'{"20日勝率":>10}')
        out = {}
        for k in order:
            v = b.get(k) or {}
            n = len(v.get(20) or [])
            if n < MIN_BUCKET:
                print(f'{k:<24}{n:>7}   樣本不足')
                continue
            w = sum(1 for x in v[20] if x > 0) / n * 100
            out[k] = statistics.median(v[20])
            print(f'{k:<24}{n:>7}' + ''.join(f'{statistics.median(v[h]):>+9.2f}%' for h in HORIZONS) + f'{w:>9.1f}%')
        print()
        return out

    r = show('📌 ① 依「投量比」分桶(他主張的指標)', ratio_b,
             ['A <1%', 'B 1~3%', 'C 3~5%', 'D 5~10%', 'E 10~20%', '⭐ F ≥20%(他舉的例子)'])
    l = show('📌 ② 依「絕對買超張數」分桶(排行榜用的)', lots_b,
             ['小 <50 張', '中 50~300 張', '大 300~1000 張', '巨 ≥1000 張'])

    print('📌 ③ ⭐ 決定性測試:**同樣張數級距**內,投量比高低差多少?')
    print('   (若差距消失 → 投量比只是「小型股」的代理變數,不值得單獨做)')
    print(f'{"張數級距":<16}{"投量比":<16}{"n":>7}' + ''.join(f'{f"{h}日中位":>10}' for h in HORIZONS))
    deltas = []
    for lk in ('小 <50 張', '中 50~300 張', '大 300~1000 張', '巨 ≥1000 張'):
        pair = {}
        for rr in ('投量比高(≥5%)', '投量比低(<5%)'):
            v = strat.get((lk, rr)) or {}
            n = len(v.get(20) or [])
            if n < MIN_BUCKET:
                print(f'{lk:<16}{rr:<16}{n:>7}   樣本不足')
                continue
            pair[rr] = statistics.median(v[20])
            print(f'{lk:<16}{rr:<16}{n:>7}' + ''.join(f'{statistics.median(v[h]):>+9.2f}%' for h in HORIZONS))
        if len(pair) == 2:
            deltas.append((lk, pair['投量比高(≥5%)'] - pair['投量比低(<5%)']))

    print('\n📊 結論')
    if r:
        hi = [v for k, v in r.items() if k[0] in 'EF' or k.startswith('⭐')]
        lo = [v for k, v in r.items() if k[0] in 'AB']
        if hi and lo:
            d = statistics.median(hi) - statistics.median(lo)
            print(f'   ① 投量比高 − 投量比低 = {d:+.2f}pp'
                  f' → {"✅ 有邊際" if d > 0.8 else "➖ 沒有明顯邊際" if d > -0.8 else "❌ 反而更差"}')
    if deltas:
        print('   ③ 同張數級距內的差距:' + ' ・'.join(f'{k} {v:+.2f}pp' for k, v in deltas))
        same = len({v > 0 for _, v in deltas}) == 1
        big = [v for _, v in deltas if abs(v) > 0.8]
        if len(big) >= 2 and same:
            print('   ✅ 控制住張數後仍有一致方向的差距 → **投量比有額外資訊,值得做**')
        else:
            print('   ➖ 控制住張數後差距就散掉了 → 投量比多半只是「小型股」的代理')
            print('   ⛔ 那就別單獨做,或只當補充說明,別給方向')

    print('\n⚠️ 限制:')
    print('   ・data/ 只有 2~3 年、已下市的不在裡面(倖存者偏誤);未扣交易成本。')
    print('   ・只看投信「買超日」,沒有測賣超側。')
    print('   ・他講的是盤中看排行榜的用法,我這裡是日 K 收盤後的統計,不完全等價。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
