#!/usr/bin/env python3
"""🕵️ 分點慣性探針 —— 「隔日沖分點是不是真的隔天就倒?賺幾%出場?」

使用者問(2026-07-31):
  「當沖和隔日沖的分點有沒有慣性?比如明天開高就出、或獲利多少就出?
    可以從歷史數據回推嗎?能不能做成『某分點已經賺/賠多少,他準備要出了』的告警?」

照本專案鐵則(ORB / sector_flow 那兩次的教訓):**探針先行、實測不猜**。
這支只讀 data/,不打任何 API、不寫任何檔,隨時可重跑。

量四件事:
  ① 配對率:某分點今天在「買超前 15」,**隔天**是否出現在「賣超前 15」
  ② 對照組(**錯了兩次才做對,記錄下來**):
     ✗ 第一版寫「所有分點出現在賣方的機率」→ 算出來剛好 50.0%,因為每天就是
       15 個買方 + 15 個賣方,**那是結構算出來的必然值,不是基準**,毫無意義。
     ✓ 改成**同股換日對照**:同一檔股票、同一組隔日賣方名單 S(d+1),
       比較「d 日的買方」與「**其他日**的買方」誰更常出現在 S(d+1)。
       買方名單換成別天、其他都不變 → 差多少才是「買了才隔天賣」的真實效果。
  ③ 出場報酬:賣出均價 vs 買進均價,**且必須扣掉同期個股自己的漲跌**
     ⚠️ 本次樣本(07/22~07/30)加權從 43,600 跌到 39,933 = **−8.4%**,
        不扣就會看到「大家都賠 3%」然後誤以為是分點的行為 —— 那是崩盤造成的。
  ④ 開高就倒:隔日開盤跳空幅度 vs 「當天是否倒貨」的關係

⚠️ 已知限制(先寫出來,免得數字被過度解讀):
  ・`hist` 只有 7 個交易日 → 每檔最多 6 組「今天→明天」配對,樣本偏薄
  ・只看得到每日**前 15 大**買/賣方:分點賣得少沒進前 15 就會被當成「沒賣」
    → 配對率是**低估**值(這個方向是保守的,不會高估慣性)
  ・分點 ≠ 單一投資人(一個分點有很多客戶),「均價」是該分點當日全部客戶的加權
    → 不能當成「某個大戶的成本」,只能當「這個分點整體的成本區」
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

DATA = Path('data')
CHIPS = DATA / 'chips'


def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None


def main():
    files = sorted(CHIPS.glob('*.json'))
    if not files:
        print('❌ 找不到 data/chips/*.json(請先 git show origin/data 還原,或在 Actions 上跑)')
        return 2
    print(f'📂 掃描 {len(files)} 檔分點資料\n')

    # broker → 統計
    pair_hit = defaultdict(int)      # 今天買、明天賣(配對成功)
    pair_tot = defaultdict(int)      # 今天買的總次數(配對母體)
    ctrl_hit = defaultdict(int)      # 對照組:**其他日**的買方出現在同一組隔日賣方名單
    ctrl_tot = defaultdict(int)
    exit_rets = defaultdict(list)    # 出場超額報酬 %(已扣同期個股漲跌)
    raw_rets = defaultdict(list)     # 未扣的原始報酬(留著對照,證明扣的必要性)
    gap_sold, gap_held = [], []      # 隔日開盤跳空 %:有倒貨 vs 沒倒貨
    n_sym = 0

    for f in files:
        d = load(f)
        if not isinstance(d, dict):
            continue
        hist = d.get('hist') or []
        if len(hist) < 2:
            continue
        n_sym += 1
        sym = f.stem
        # 該股的日 K(拿隔日開盤算跳空)
        ohlc = load(DATA / f'{sym}.json') or []
        by_date = {}
        for r in ohlc if isinstance(ohlc, list) else []:
            dt = str(r.get('date') or '').replace('/', '-')
            if dt:
                by_date[dt] = r

        def _tp(dt):
            """個股當日的代表價((高+低+收)/3),用來算「同期個股自己漲跌多少」。"""
            r = by_date.get(str(dt))
            if not r:
                return None
            try:
                h_, l_, c_ = float(r['high']), float(r['low']), float(r['close'])
                return (h_ + l_ + c_) / 3 if c_ > 0 else None
            except (KeyError, TypeError, ValueError):
                return None

        for i in range(len(hist) - 1):
            today, nxt = hist[i], hist[i + 1]
            sellers_nxt = {}
            for row in (nxt.get('s') or []):
                try:
                    sellers_nxt[row[0]] = (abs(float(row[1])), float(row[2]))
                except (IndexError, TypeError, ValueError):
                    continue
            # 隔日開盤跳空(相對今日收盤)
            gap = None
            try:
                c0 = float(by_date[str(today['d'])]['close'])
                o1 = float(by_date[str(nxt['d'])]['open'])
                if c0 > 0 and o1 > 0:
                    gap = (o1 - c0) / c0 * 100
            except (KeyError, TypeError, ValueError):
                pass

            # 同期個股自己的漲跌(扣掉它才看得出分點的「行為」而不是「行情」)
            p0, p1 = _tp(today['d']), _tp(nxt['d'])
            stock_ret = ((p1 - p0) / p0 * 100) if (p0 and p1) else None

            for row in (today.get('b') or []):
                try:
                    nm, _sh, buy_p = row[0], float(row[1]), float(row[2])
                except (IndexError, TypeError, ValueError):
                    continue
                if buy_p <= 0:
                    continue
                pair_tot[nm] += 1
                if nm in sellers_nxt:
                    pair_hit[nm] += 1
                    sell_p = sellers_nxt[nm][1]
                    if sell_p > 0:
                        raw = (sell_p - buy_p) / buy_p * 100
                        raw_rets[nm].append(raw)
                        if stock_ret is not None:
                            exit_rets[nm].append(raw - stock_ret)
                    if gap is not None:
                        gap_sold.append(gap)
                elif gap is not None:
                    gap_held.append(gap)

            # ── 對照組:同一組 sellers_nxt,改用「其他日」的買方名單去比對 ──
            #    買方名單換成別天、其他條件全部不變 → 差多少才是真效果。
            for j in range(len(hist) - 1):
                if j == i:
                    continue
                for row in (hist[j].get('b') or []):
                    try:
                        nm2 = row[0]
                    except (IndexError, TypeError):
                        continue
                    ctrl_tot[nm2] += 1
                    if nm2 in sellers_nxt:
                        ctrl_hit[nm2] += 1

    print(f'✅ 有效樣本:{n_sym} 檔股票\n')

    # ── ② 對照組:同股換日 ───────────────────────────────────────
    base = (sum(ctrl_hit.values()) / sum(ctrl_tot.values()) * 100) if sum(ctrl_tot.values()) else 0
    print('─' * 66)
    print(f'【對照組(同股換日)】其他日的買方出現在同一組隔日賣方名單 = {base:.1f}%')
    print('  ⚠️ 第一版對照組寫「所有分點出現在賣方的機率」→ 得到剛好 50.0%,')
    print('     那是「每天 15 買 + 15 賣」結構算出來的必然值,毫無意義。已改成同股換日。')
    print('─' * 66)

    # ── ① + ③ 逐分點:配對率 & 出場報酬 ─────────────────────────
    rows = []
    for nm, tot in pair_tot.items():
        if tot < 20:                      # 樣本太少不列(避免雜訊)
            continue
        hit = pair_hit[nm]
        rate = hit / tot * 100
        cb = (ctrl_hit[nm] / ctrl_tot[nm] * 100) if ctrl_tot.get(nm) else None   # 該分點自己的對照
        rets = exit_rets[nm]
        rows.append({
            'broker': nm, 'n': tot, 'hit': hit, 'rate': rate, 'ctrl': cb,
            'med_ret': statistics.median(rets) if rets else None,
            'avg_ret': (sum(rets) / len(rets)) if rets else None,
            'win': (sum(1 for r in rets if r > 0) / len(rets) * 100) if rets else None,
            'nret': len(rets),
        })
    # 用「自己的對照組」排序(配對率 − 同股換日對照),這才是真效果
    for r in rows:
        r['edge'] = r['rate'] - (r['ctrl'] if r['ctrl'] is not None else base)
    rows.sort(key=lambda x: -x['edge'])

    print('\n【① 隔日沖「真效果」Top 20】(配對率 − 同股換日對照;正值才代表有慣性)')
    print(f"{'分點':<34}{'樣本':>5}{'配對率':>8}{'對照':>7}{'真效果':>8}{'超額報酬':>9}{'勝率':>7}")
    for r in rows[:20]:
        mr = f"{r['med_ret']:+.2f}%" if r['med_ret'] is not None else '  —  '
        wr = f"{r['win']:.0f}%" if r['win'] is not None else ' — '
        cb = f"{r['ctrl']:.1f}%" if r['ctrl'] is not None else '  — '
        print(f"{r['broker'][:32]:<34}{r['n']:>5}{r['rate']:>7.1f}%{cb:>8}"
              f"{r['edge']:>+7.1f}{mr:>10}{wr:>7}")

    # ── ③ 全體出場報酬分布 ──────────────────────────────────────
    _raw = [x for v in raw_rets.values() for x in v]
    if _raw:
        _raw.sort()
        print(f'\n【②-a 未扣同期個股漲跌的原始報酬】(僅供對照,**不可拿來下結論**)')
        print(f'  中位={_raw[len(_raw) // 2]:+.2f}%  ← 這個窗口大盤 −8.4%,所以看起來大家都在賠')
    all_rets = [x for v in exit_rets.values() for x in v]
    if all_rets:
        all_rets.sort()
        n = len(all_rets)
        q = lambda p: all_rets[min(n - 1, int(n * p))]
        print(f'\n【②-b 出場**超額**報酬分布】(已扣同期個股漲跌,{n} 筆)')
        print(f'  P10={q(.10):+.2f}%  P25={q(.25):+.2f}%  中位={q(.50):+.2f}%  '
              f'P75={q(.75):+.2f}%  P90={q(.90):+.2f}%')
        print(f'  賺錢出場佔比 {sum(1 for r in all_rets if r > 0) / n * 100:.1f}%'
              f' ・ 平均 {sum(all_rets) / n:+.2f}%')
        print('  💡 讀法:如果中位數接近 0 且分布很窄 → 他們是「隔天就走、不管賺賠」;')
        print('           如果中位數明顯為正 → 才有「賺到 X% 才走」的慣性。')

    # ── ④ 開高就倒? ───────────────────────────────────────────
    if gap_sold and gap_held:
        ms, mh = statistics.median(gap_sold), statistics.median(gap_held)
        print(f'\n【③ 開高就倒?】隔日開盤跳空中位數')
        print(f'  隔天有倒貨:{ms:+.2f}%(n={len(gap_sold)})')
        print(f'  隔天沒倒貨:{mh:+.2f}%(n={len(gap_held)})')
        print(f'  差距 {ms - mh:+.2f} 個百分點 → '
              + ('✅ 開高確實比較會倒' if ms - mh > 0.15 else
                 '❌ 看不出「開高才倒」的傾向(差距太小,別做這個功能)'))

    print('\n' + '─' * 66)
    print('⚠️ 結論會過期:hist 只有 7 天。累積到 1~2 個月後重跑一次,')
    print('   若配對率與對照組的差距消失,就代表這個慣性不存在或已失效 → 別留著誤導。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
