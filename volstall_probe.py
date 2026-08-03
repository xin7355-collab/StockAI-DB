#!/usr/bin/env python3
"""📊 「爆量漲不動 / 爆量跌不動」探針 —— 連次量心法的日線可回測版。

來源:逐字稿【當沖心法】標題就寫死了他的原則:
  「用**連次量**抓轉折,**空在爆量漲不動、買在爆量跌不動**」
  「連次量爆量急拉,這時候容易轉折」「連次量綠色的急殺,他容易反彈」

⛔ 「連次量」本身是**盤中**概念(當天第幾次出現大量),我沒有分 K 歷史 → 無法直接回測。
   照鐵則(ORB 那次的教訓:當沖策略沒扣成本回測過就不能上),⛔ 不硬做盤中版。

⭐ 但他的**核心原則是可以搬到日線的**,而且日線我有 2~3 年:
   ・**爆量漲不動** = 量能爆增,但當天收盤沒漲(甚至收黑)→ 有人在倒貨 → 偏空
   ・**爆量跌不動** = 量能爆增,但當天收盤沒跌(甚至收紅)→ 有人在接 → 偏多
   這就是「量價背離」的極端版,而且**方向明確、可以扣成本算**。

方法論(照 CLAUDE.md 四點):
  ① **乾淨對照組**:同樣是「爆量日」,分成「漲不動」vs「跌不動」vs「量價同向」
     ⛔ 不能拿「沒爆量的日子」當對照 —— 那會把「爆量」本身的效果算進來
  ② **扣掉同期大盤**;③ 同檔 10 交易日內只算一次;④ 每桶至少 300 筆
  ⑤ **量的門檻用該股自己的歷史**(20 日均量的倍數),⛔ 不寫死張數

跑法:python3 volstall_probe.py   (只讀 data/,不打 API、不寫檔)
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

DATA = Path('data')
HORIZONS = (1, 3, 5, 10)
DEDUP = 10
MIN_BUCKET = 300
VOL_MULT = 2.0          # 爆量 = 20 日均量 ×2(他影片講的門檻)


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

    b = defaultdict(lambda: defaultdict(list))
    n_sym = n_evt = 0

    for f in files:
        rows = load(f) or []
        if len(rows) < 300:
            continue
        try:
            dates = [str(r['date']).replace('/', '-') for r in rows]
            op = [float(r.get('open') or 0) for r in rows]
            hi = [float(r.get('high') or 0) for r in rows]
            lo = [float(r.get('low') or 0) for r in rows]
            cl = [float(r.get('close') or 0) for r in rows]
            vol = [float(r.get('volume') or 0) for r in rows]
        except (KeyError, TypeError, ValueError):
            continue
        if min(cl) <= 0:
            continue
        n_sym += 1
        last_evt = -99
        for i in range(25, len(cl) - max(HORIZONS)):
            vv = [x for x in vol[i - 20:i] if x > 0]
            if len(vv) < 15 or vol[i] <= 0:
                continue
            vma = sum(vv) / len(vv)
            if vol[i] < vma * VOL_MULT:          # 沒爆量 → 不是事件
                continue
            if i - last_evt < DEDUP:
                continue
            last_evt = i
            n_evt += 1
            chg = (cl[i] - cl[i - 1]) / cl[i - 1] * 100 if cl[i - 1] > 0 else 0
            rng = hi[i] - lo[i]
            # 收在當日 K 棒的哪個位置(收在低端 = 衝高被打下來 = 漲不動)
            pos = (cl[i] - lo[i]) / rng * 100 if rng > 0 else 50
            up = hi[i] > (cl[i - 1] if cl[i - 1] > 0 else hi[i])   # 當天有沒有衝高過
            if chg <= 0.5 and pos <= 40 and up:
                k = '⭐ 爆量漲不動(衝高被壓、收低端)'
            elif chg >= -0.5 and pos >= 60 and lo[i] < cl[i - 1]:
                k = '⭐ 爆量跌不動(殺低被拉、收高端)'
            elif chg >= 3:
                k = '爆量大漲(量價同向·對照)'
            elif chg <= -3:
                k = '爆量大跌(量價同向·對照)'
            else:
                k = '爆量其他(對照)'
            d0 = dates[i]
            for h in HORIZONS:
                d1 = dates[i + h]
                if d0 in tw and d1 in tw and tw[d0] > 0:
                    b[k][h].append((cl[i + h] - cl[i]) / cl[i] * 100
                                   - (tw[d1] - tw[d0]) / tw[d0] * 100)

    print(f'✅ {n_sym} 檔 ・{n_evt} 個爆量事件(量 ≥ 20日均量 ×{VOL_MULT}、同檔 {DEDUP} 日內只算一次)')
    print('   報酬皆為**超額**(已扣同期加權指數)\n')

    order = ['⭐ 爆量漲不動(衝高被壓、收低端)', '⭐ 爆量跌不動(殺低被拉、收高端)',
             '爆量大漲(量價同向·對照)', '爆量大跌(量價同向·對照)', '爆量其他(對照)']
    print(f'{"型態":<34}{"n":>7}' + ''.join(f'{f"{h}日中位":>10}' for h in HORIZONS) + f'{"5日勝率":>9}')
    got = {}
    for k in order:
        v = b.get(k) or {}
        n = len(v.get(5) or [])
        if n < MIN_BUCKET:
            print(f'{k:<34}{n:>7}   樣本不足')
            continue
        w = sum(1 for x in v[5] if x > 0) / n * 100
        got[k] = {h: statistics.median(v[h]) for h in HORIZONS if v.get(h)}
        got[k]['w'] = w
        print(f'{k:<34}{n:>7}' + ''.join(f'{statistics.median(v[h]):>+9.2f}%' for h in HORIZONS) + f'{w:>8.1f}%')

    print('\n📊 結論(他的說法:空在爆量漲不動、買在爆量跌不動)')
    base = [v[5] for k, v in got.items() if '對照' in k]
    med = statistics.median(base) if base else 0
    print(f'   對照組(其他爆量日)5 日中位 = {med:+.2f}%')
    for k, lbl, want in ((order[0], '爆量漲不動 → 他說要**空**', 'down'),
                         (order[1], '爆量跌不動 → 他說要**買**', 'up')):
        if k not in got:
            print(f'   ⏳ {lbl}:樣本不足,不下結論')
            continue
        d = got[k][5] - med
        okk = (d < -0.5) if want == 'down' else (d > 0.5)
        print(f'   {"✅" if okk else "❌" if abs(d) > 0.5 else "➖"} {lbl}:'
              f'5 日 {got[k][5]:+.2f}%(勝率 {got[k]["w"]:.1f}%),比對照組 {d:+.2f}pp'
              f' → {"方向符合" if okk else ("方向相反" if abs(d) > 0.5 else "沒有明顯差別")}')

    print('\n⚠️ 限制:')
    print('   ・這是**日線版**,他講的「連次量」是盤中第幾次爆量,不完全等價。')
    print('   ・未扣交易成本(來回約 0.44%);短天期的邊際要能超過成本才有意義。')
    print('   ・data/ 只有 2~3 年、已下市的不在裡面(倖存者偏誤)。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
