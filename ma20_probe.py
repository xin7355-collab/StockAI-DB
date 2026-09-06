#!/usr/bin/env python3
"""📉 「跌破月線就停損」到底對不對? —— 逐字稿直接嗆這條,拿我的資料驗一次。

⚠️ 這支跟前幾支探針不同:它檢查的是**我自己現在正在做的事**。
   本專案的 regime 是「風控優先:跌破月線一律先降級」,朱家泓策略也有 5MA/月線停損。
   而逐字稿(權證小哥)整段在嗆這條:

     「不靈通道…站上月線買進、跌破月線賣出,這個你不知道停損多少次…你會一直停損」
     「跌破月線要停損?每個講月均線派都跟你講跌破月線要停損。
       來,各位,你要遵守機率 —— 我 90 塊不賣,你現在跌破月線剩 50 塊你叫我停損?
       **你的停損點就是我的買點**」
     「在處置股裡面破月線反而是個大買點」
     「停損%數設大一點,但是張數不要太大」(→ 寬停損 + 小部位,而不是窄停損)

⭐ 這正是「邏輯不打架」該處理的情況:兩派講反話,**我不能兩邊都照抄**。
   所以先量三件事,再決定 UI 要怎麼寫:
     ① 跌破月線之後,往後真的比較差嗎?(超額報酬)
     ② **假跌破率**:跌破後 N 日內又站回月線的比例 —— 這才是「一直在停損」的直接證據
     ③ **分位階**:他說「低檔破月線是買點」—— 高位階跌破 vs 低位階跌破 差多少

方法論(照 CLAUDE.md 四點):
  ・乾淨對照組 = 同一批股票**沒有跌破月線**的日子(不是拿別的股票比)
  ・報酬全扣同期加權指數
  ・事件去重:同一檔 10 個交易日內只算一次跌破
  ・樣本守門:每桶至少 300 筆

跑法:python3 ma20_probe.py   (只讀 data/,不打 API、不寫檔)
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

DATA = Path('data')
HORIZONS = (5, 10, 20, 60)
DEDUP = 10
MIN_BUCKET = 300


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
            d = str(r.get('date') or '').replace('/', '-')
            if c > 0 and d:
                out.append((d, c))
        except (TypeError, ValueError):
            continue
    return out


def main():
    twii = dict(series(load(DATA / '^TWII.json') or []))
    if not twii:
        print('⚠️ 沒有 ^TWII.json → 無法扣同期大盤')
        return 2
    files = [f for f in sorted(DATA.glob('*.json'))
             if f.stem.isdigit() and len(f.stem) == 4]
    if not files:
        print('❌ 找不到 data/NNNN.json')
        return 2
    print(f'📂 掃描 {len(files)} 檔\n')

    brk = defaultdict(list)          # 跌破月線
    ctl = defaultdict(list)          # 對照:在月線之上的日子
    by_pos = defaultdict(lambda: defaultdict(list))   # 跌破 × 位階
    n_sym = n_brk = 0
    whip = defaultdict(int)          # 假跌破統計

    for f in files:
        rows = series(load(f) or [])
        if len(rows) < 320:
            continue
        n_sym += 1
        dates = [d for d, _ in rows]
        cl = [c for _, c in rows]
        ma = [None] * len(cl)
        for i in range(19, len(cl)):
            ma[i] = sum(cl[i - 19:i + 1]) / 20

        last_evt = -99
        for i in range(250, len(cl) - max(HORIZONS)):
            if ma[i] is None or ma[i - 1] is None:
                continue
            d0 = dates[i]
            above = cl[i] > ma[i]
            # 對照組:單純「站在月線之上」的日子(每 DEDUP 天取一次,免得樣本爆量失衡)
            if above and i % DEDUP == 0:
                for h in HORIZONS:
                    d1 = dates[i + h]
                    if d0 in twii and d1 in twii and twii[d0] > 0:
                        ctl[h].append((cl[i + h] - cl[i]) / cl[i] * 100
                                      - (twii[d1] - twii[d0]) / twii[d0] * 100)
            # 事件:今天跌破、昨天還在上面
            if not (cl[i] < ma[i] and cl[i - 1] >= ma[i - 1]):
                continue
            if i - last_evt < DEDUP:
                continue
            last_evt = i
            n_brk += 1
            # ② 假跌破:往後 5 / 10 日內有沒有再站回月線
            for w in (5, 10):
                if any(cl[j] > (ma[j] or 1e18) for j in range(i + 1, min(i + 1 + w, len(cl)))):
                    whip[w] += 1
            whip['n'] += 1
            # ③ 位階(近一年)
            win = cl[i - 240:i + 1]
            mn, mx = min(win), max(win)
            pos = (cl[i] - mn) / (mx - mn) * 100 if mx > mn else 50
            pb = '低位階(<33%)' if pos < 33 else ('中位階' if pos < 67 else '高位階(≥67%)')
            for h in HORIZONS:
                d1 = dates[i + h]
                if d0 in twii and d1 in twii and twii[d0] > 0:
                    ex = (cl[i + h] - cl[i]) / cl[i] * 100 - (twii[d1] - twii[d0]) / twii[d0] * 100
                    brk[h].append(ex)
                    by_pos[pb][h].append(ex)

    print(f'✅ {n_sym} 檔 ・跌破月線事件 {n_brk} 次(同檔 {DEDUP} 交易日內只算一次)')
    print('   報酬皆為**超額**(已扣同期加權指數)\n')

    # ── ① 跌破之後真的比較差嗎? ────────────────────────────
    print('📌 ① 跌破月線之後 vs 站在月線之上(同一批股票)')
    print(f'{"":<20}{"n":>7}' + ''.join(f'{f"{h}日中位":>10}' for h in HORIZONS) + f'{"20日勝率":>10}')
    for lab, b in (('跌破月線當天', brk), ('月線之上(對照)', ctl)):
        if len(b.get(20) or []) < MIN_BUCKET:
            print(f'{lab:<20}{len(b.get(20) or []):>7}  樣本不足')
            continue
        w = sum(1 for x in b[20] if x > 0) / len(b[20]) * 100
        print(f'{lab:<20}{len(b[20]):>7}'
              + ''.join(f'{statistics.median(b[h]):>+9.2f}%' for h in HORIZONS)
              + f'{w:>9.1f}%')
    if len(brk.get(20) or []) >= MIN_BUCKET and len(ctl.get(20) or []) >= MIN_BUCKET:
        d20 = statistics.median(brk[20]) - statistics.median(ctl[20])
        d60 = statistics.median(brk[60]) - statistics.median(ctl[60])
        print(f'   → 差距:20 日 {d20:+.2f}pp ・ 60 日 {d60:+.2f}pp')
        print('   ' + ('✅ 跌破月線確實比較差 → 「破月線降級」站得住腳'
                       if d20 < -0.8 else
                       '➖ 跌破月線跟沒跌破**差不多** → 拿它當停損理由,說服力不足'
                       if d20 < 0.8 else
                       '❌ 跌破月線反而比較好 → 「破月線停損」在我的資料上是**反指標**'))

    # ── ② 假跌破率:「一直在停損」的直接證據 ─────────────────
    if whip.get('n'):
        n = whip['n']
        print(f'\n📌 ② 假跌破率(逐字稿說「你不知道停損多少次」)')
        print(f'   跌破後 5 個交易日內又站回月線:{whip[5] / n * 100:.1f}%({whip[5]}/{n})')
        print(f'   跌破後 10 個交易日內又站回月線:{whip[10] / n * 100:.1f}%({whip[10]}/{n})')
        print('   ' + ('⭐ 一半以上是假跌破 → 「跌破就砍」會被反覆巴來巴去,他這句話**成立**'
                       if whip[10] / n > 0.5 else
                       '➖ 假跌破不到一半 → 「一直在停損」沒有到他講的那麼誇張'))

    # ── ③ 分位階:他說「低檔破月線是買點」──────────────────
    print(f'\n📌 ③ 跌破月線 × 股價位階(他說低檔破月線反而是買點)')
    print(f'{"位階":<18}{"n":>7}' + ''.join(f'{f"{h}日中位":>10}' for h in HORIZONS))
    got = {}
    for pb in ('低位階(<33%)', '中位階', '高位階(≥67%)'):
        v = by_pos.get(pb) or {}
        n = len(v.get(20) or [])
        if n < MIN_BUCKET:
            print(f'{pb:<18}{n:>7}  樣本不足')
            continue
        got[pb] = statistics.median(v[20])
        print(f'{pb:<18}{n:>7}' + ''.join(f'{statistics.median(v[h]):>+9.2f}%' for h in HORIZONS))
    if '低位階(<33%)' in got and '高位階(≥67%)' in got:
        gap = got['低位階(<33%)'] - got['高位階(≥67%)']
        print(f'   → 低位階 − 高位階 = {gap:+.2f}pp')
        print('   ' + ('✅ 低檔跌破確實沒那麼糟 → 「破月線」不該一視同仁,要看位階'
                       if gap > 0.8 else
                       '❌ 低檔跌破**沒有**比較好 → 「低檔破月線是買點」不成立,別照抄'))

    # ── ④ ⭐ 大盤本身:我的 regime 降級是對**加權指數**,不是個股,必須分開驗 ──
    # ⛔ 不可拿上面的個股結論直接推到大盤(那是越推)。指數的均線行為跟個股差很多:
    #    指數是一籃子,雜訊被平均掉,趨勢性通常比單一個股強。
    tw = series(load(DATA / '^TWII.json') or [])
    if len(tw) >= 320:
        cl = [c for _, c in tw]
        ma = [None] * len(cl)
        for i in range(19, len(cl)):
            ma[i] = sum(cl[i - 19:i + 1]) / 20
        ev, ctl2, wh, whn = defaultdict(list), defaultdict(list), {5: 0, 10: 0}, 0
        last = -99
        for i in range(250, len(cl) - max(HORIZONS)):
            if ma[i] is None or ma[i - 1] is None:
                continue
            if cl[i] > ma[i] and i % DEDUP == 0:
                for h in HORIZONS:
                    ctl2[h].append((cl[i + h] - cl[i]) / cl[i] * 100)
            if not (cl[i] < ma[i] and cl[i - 1] >= ma[i - 1]) or i - last < DEDUP:
                continue
            last = i
            whn += 1
            for w in (5, 10):
                if any(cl[j] > (ma[j] or 1e18) for j in range(i + 1, min(i + 1 + w, len(cl)))):
                    wh[w] += 1
            for h in HORIZONS:
                ev[h].append((cl[i + h] - cl[i]) / cl[i] * 100)
        print(f'\n📌 ④ ⭐ **加權指數本身**跌破月線(我的 regime 降級看的是這個,不是個股)')
        print(f'   ⚠️ 報酬這裡是**絕對**的(大盤自己就是基準,沒有東西可扣)')
        if len(ev.get(20) or []) >= 8:
            print(f'{"":<20}{"n":>7}' + ''.join(f'{f"{h}日中位":>10}' for h in HORIZONS))
            print(f'{"大盤跌破月線":<20}{len(ev[20]):>7}'
                  + ''.join(f'{statistics.median(ev[h]):>+9.2f}%' for h in HORIZONS))
            if ctl2.get(20):
                print(f'{"大盤在月線之上":<20}{len(ctl2[20]):>7}'
                      + ''.join(f'{statistics.median(ctl2[h]):>+9.2f}%' for h in HORIZONS))
                dd = statistics.median(ev[20]) - statistics.median(ctl2[20])
                print(f'   → 20 日差距 {dd:+.2f}pp')
                print('   ' + ('✅ **大盤**跌破月線確實比較差 → regime 降級有依據,個股那條另議'
                               if dd < -0.8 else
                               '➖ 大盤跌破月線也差不多 → regime 降級的依據同樣不強'))
            if whn:
                print(f'   大盤假跌破率:5 日內站回 {wh[5] / whn * 100:.0f}% ・10 日內 {wh[10] / whn * 100:.0f}%(n={whn})')
        else:
            print(f'   ⏳ 大盤跌破事件只有 {len(ev.get(20) or [])} 次,樣本太少不下結論'
                  f'(指數跌破月線本來就比個股少很多)')

    print('\n⚠️ 限制:data/ 只有 2~3 年、空頭段有限、已下市的不在裡面(倖存者偏誤)。')
    print('   月線用收盤價 20 日簡單均線;沒有扣交易成本(停損來回約 0.44%,實務上會更不利於頻繁停損)。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
