#!/usr/bin/env python3
"""🔄 週轉率 × 昨日漲跌幅 探針 —— 他的「當沖三大指標」裡我唯一沒做的那個。

來源:逐字稿【當沖必看的三大指標】權證小哥講得很明確:
  「當沖必看**三個指標**:第一個**週轉率**、第二個**連次量**、第三**籌碼**,這三個都要看」
  「週轉率高的股票,要嘛很好要嘛很差」
  「週轉率會**搭配籌碼跟昨日漲跌幅一起看**」
  ⭐「假如**昨天漲跌幅小漲小跌,可能今天就不錯**;
     昨天漲跌幅假如是**漲停**的,那我們今天盤中要好好研究籌碼,看人家到底在出貨還是進貨」
  「前天週轉率高,隔天不一定要空 —— 週轉率是**盤中**指標,
    有些股票前天週轉率很高,可是當天一開盤沒什麼量,代表還沒出貨」

📌 三大指標我的現況:
  ・**連次量** → 已驗兩次(日線 volstall_probe + 分K volseq_probe)**都不成立**,⛔ 不做
  ・**籌碼**   → V71.9.4(追價買 vs 低檔吃貨)+ V71.9.6(隔日沖占比/手牽手)已做
  ・**週轉率** → ⭐ **完全沒有**,而且資料其實有:
     週轉率 = 當日成交量 ÷ 總發行股數,而總股數在 `tdcc_holders.json` 的 `t` 欄(零採礦)。
     ⚠️ App 目前只有「區間週轉率」在主力動向卡,個股當沖頁沒有「今日週轉率」。

⛔ 照鐵則探針先行。只讀 data/,不打 API、不寫檔。

方法論(照 CLAUDE.md 四點):
  ① **乾淨對照組**:所有交易日(= 隨便挑一天),⛔ 不是「沒訊號的日子」
  ② **扣掉同期大盤**;③ 同檔 5 交易日內只算一次;④ 每桶至少 200 筆
  ⑤ ⭐ **重點是交互作用**:單看週轉率沒意義(他自己說「要嘛很好要嘛很差」),
     一定要跟「昨日漲跌幅」交叉,才問得出他講的那條規則成不成立。

⚠️ 沒有前視偏誤:今日週轉率在收盤時就知道,報酬從**次日**起算。

跑法:python3 turnover_probe.py
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

DATA = Path('data')
HORIZONS = (1, 3, 5)
DEDUP = 5
MIN_BUCKET = 200


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


def main():
    tdcc = load(DATA / 'tdcc_holders.json') or {}
    shares = {}
    for k, v in tdcc.items():
        if isinstance(v, dict):
            try:
                t = float(v.get('t') or 0)
                if t > 1e6:
                    shares[k] = t
            except (TypeError, ValueError):
                pass
    if len(shares) < 500:
        print(f'❌ 總股數樣本只有 {len(shares)} 檔(需 tdcc_holders.json)')
        return 2

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

    print(f'📂 有總股數的 {len(shares)} 檔\n')

    buk = defaultdict(lambda: defaultdict(list))    # (昨日漲跌幅桶, 週轉率桶) -> {h: [超額%]}
    solo = defaultdict(lambda: defaultdict(list))   # 只看週轉率(證明單看沒用)
    base = defaultdict(list)
    n_sym = n_evt = 0

    for sym, tot in shares.items():
        rows = load(DATA / f'{sym}.json')
        if not isinstance(rows, list) or len(rows) < 300:
            continue
        try:
            dates = [str(r['date']).replace('/', '-') for r in rows]
            cl = [float(r.get('close') or 0) for r in rows]
            vol = [float(r.get('volume') or 0) for r in rows]
        except (KeyError, TypeError, ValueError):
            continue
        if min(cl) <= 0:
            continue
        n_sym += 1
        last_evt = -99
        for i in range(60, len(cl) - max(HORIZONS)):
            if vol[i] <= 0 or cl[i - 1] <= 0:
                continue
            d0 = dates[i]
            if d0 not in tw:
                continue
            ex = {}
            for h in HORIZONS:
                d1 = dates[i + h]
                if d1 in tw and tw[d0] > 0:
                    ex[h] = ((cl[i + h] - cl[i]) / cl[i]
                             - (tw[d1] - tw[d0]) / tw[d0]) * 100
            if not ex:
                continue
            for h, v in ex.items():
                base[h].append(v)
            if i - last_evt < DEDUP:
                continue

            turn = vol[i] / tot * 100                      # 今日週轉率 %
            chg_y = (cl[i] - cl[i - 1]) / cl[i - 1] * 100   # 「昨日漲跌幅」= 今天這根相對前一根
            # 週轉率分桶(絕對值;週轉率本來就是標準化過的量,可跨股比較)
            tb = ('低 <1%' if turn < 1 else '中 1~3%' if turn < 3
                  else '高 3~8%' if turn < 8 else '⭐ 極高 ≥8%')
            # 他講的「昨日漲跌幅」四種情境
            yb = ('⭐ 漲停(≥9%)' if chg_y >= 9 else '大漲 4~9%' if chg_y >= 4
                  else '⭐ 小漲小跌 −2~+4%' if chg_y >= -2 else '下跌 <−2%')
            last_evt = i
            n_evt += 1
            for h, v in ex.items():
                buk[(yb, tb)][h].append(v)
                solo[tb][h].append(v)

    bm = {h: statistics.median(base[h]) for h in HORIZONS if base[h]}
    bw = {h: sum(1 for x in base[h] if x > 0) / len(base[h]) * 100 for h in HORIZONS if base[h]}
    print(f'✅ {n_sym} 檔 ・{n_evt} 個事件(同檔 {DEDUP} 日內只算一次)')
    print(f'📐 對照組(隨便挑一天):n={len(base[1])} ・1日中位 {bm.get(1, 0):+.2f}% ・勝率 {bw.get(1, 0):.1f}%')
    print('   ⚠️ 報酬皆為**超額**(已扣同期加權);「邊際」= 該桶 − 對照組\n')

    def show(title, b, order, keyfmt=str):
        print(title)
        print(f'{"":<34}{"n":>7}' + ''.join(f'{f"{h}日邊際":>10}' for h in HORIZONS) + f'{"1日勝率":>9}')
        got = {}
        for k in order:
            v = b.get(k) or {}
            n = len(v.get(1) or [])
            if n < MIN_BUCKET:
                print(f'{keyfmt(k):<34}{n:>7}   樣本不足')
                continue
            w = sum(1 for x in v[1] if x > 0) / n * 100
            got[k] = {h: statistics.median(v[h]) - bm.get(h, 0) for h in HORIZONS if v.get(h)}
            got[k]['w'] = w
            print(f'{keyfmt(k):<34}{n:>7}'
                  + ''.join(f'{got[k].get(h, 0):>+9.2f}%' for h in HORIZONS) + f'{w:>8.1f}%')
        print()
        return got

    TB = ['低 <1%', '中 1~3%', '高 3~8%', '⭐ 極高 ≥8%']
    YB = ['⭐ 小漲小跌 −2~+4%', '大漲 4~9%', '⭐ 漲停(≥9%)', '下跌 <−2%']
    s1 = show('📌 ① 只看週轉率(他說「要嘛很好要嘛很差」→ 預期單看沒鑑別力)', solo, TB)
    print('📌 ② ⭐ 週轉率 × 昨日漲跌幅(他說的那條規則)')
    print(f'{"昨日漲跌幅":<20}{"今日週轉率":<16}{"n":>6}' + ''.join(f'{f"{h}日邊際":>10}' for h in HORIZONS) + f'{"1日勝率":>9}')
    grid = {}
    for yb in YB:
        for tb in TB:
            v = buk.get((yb, tb)) or {}
            n = len(v.get(1) or [])
            if n < MIN_BUCKET:
                continue
            w = sum(1 for x in v[1] if x > 0) / n * 100
            e = {h: statistics.median(v[h]) - bm.get(h, 0) for h in HORIZONS if v.get(h)}
            grid[(yb, tb)] = (e, w, n)
            print(f'{yb:<20}{tb:<16}{n:>6}' + ''.join(f'{e.get(h, 0):>+9.2f}%' for h in HORIZONS) + f'{w:>8.1f}%')

    print('\n📊 結論')
    if s1:
        sp = max(s1.values(), key=lambda x: x.get(1, 0)).get(1, 0) - min(s1.values(), key=lambda x: x.get(1, 0)).get(1, 0)
        print(f'   ① 單看週轉率:最好與最差桶差 {sp:.2f}pp'
              f' → {"有一點鑑別力" if sp > 0.8 else "➖ 幾乎沒有鑑別力(跟他說的一致:要嘛很好要嘛很差)"}')
    hi = [k for k in grid if k[1] in ('高 3~8%', '⭐ 極高 ≥8%')]
    small = [k for k in hi if k[0] == '⭐ 小漲小跌 −2~+4%']
    limit = [k for k in hi if k[0] == '⭐ 漲停(≥9%)']
    if small and limit:
        a = statistics.median([grid[k][0].get(1, 0) for k in small])
        b = statistics.median([grid[k][0].get(1, 0) for k in limit])
        print(f'   ② ⭐ 他的規則:高週轉率時,「昨天小漲小跌」= {a:+.2f}pp vs「昨天漲停」= {b:+.2f}pp')
        print(f'      差距 {a - b:+.2f}pp → '
              + ('✅ **他說的成立**:同樣高週轉率,昨天沒噴過的比昨天漲停的好'
                 if a - b > 0.5 else
                 '➖ 兩者差不多,他這條規則看不出效果'
                 if a - b > -0.5 else
                 '❌ **相反**:昨天漲停的反而比較好'))
    print('\n⚠️ 限制:')
    print('   ・週轉率用「總發行股數」不是「流通在外股數」(沒有扣庫藏股/董監質押),數值會略低估。')
    print('   ・這是**日線**尺度(收盤知道週轉率、次日起算報酬);他講的是盤中選股,不完全等價。')
    print('   ・未扣交易成本;data/ 只有 2~3 年、已下市的不在裡面(倖存者偏誤)。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
