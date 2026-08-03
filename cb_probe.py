#!/usr/bin/env python3
"""💳 可轉債「離轉換價還差多少」探針 —— 公司到底有沒有拉抬動機?

來源:使用者提供的 113 份逐字稿,其中【哥有籌必爆S2】第2集整集在講可轉債。
權證小哥講的完整邏輯(這集是少數把公式講死的):

  ・轉換張數 = 100 ÷ 轉換價   ・CB 市值 = 股價 × 轉換張數 = 股價 ÷ 轉換價 × 100
  ・公司發 CB **最想要的是不還錢** → 想辦法把股價拉過轉換價,讓持有人換股
  ・所以 **股價 < 轉換價** 時公司有拉抬動機;拉到 **市值 >130** 可提前贖回,那時動機就沒了
  ・「拉過轉換價」是整個炒作 SOP 的核心目標

⭐ 我已經有 `cb_overview.json` 的 `cp`(轉換價),但**前端只用了餘額變化 `chg`,cp 完全沒用到**。
   所以問題是:「股價低於轉換價」這件事,在我的資料上到底有沒有預測力?

⛔ 照鐵則「探針先行、實測不猜」(ORB / sector_flow / broker_habit / floor / tdcc 五次的教訓)。
   這支只讀 data/,不打 API、不寫檔。

方法論(照 CLAUDE.md 四點):
  ① **乾淨對照組**:同樣有發 CB 的股票,分成「股價低於轉換價」vs「已經高於轉換價」。
     ⛔ 不能拿「沒發 CB 的全市場」當對照 —— 會發 CB 的公司本來就偏中小型/財務吃緊,
        那個差異會被誤算成訊號。
  ② **扣掉同期大盤**:報酬一律減同期加權指數。
  ③ **事件去重**:同一檔 20 個交易日內只算一次。
  ④ **樣本守門**:每桶至少 100 筆才報數字。

⚠️⚠️ 這支有一個**必須寫出來、而且方向已知**的偏誤:
   `cb_overview.json` 是**今天的快照**,只含「今天還沒轉換完的 CB」。
   當年真的被拉過轉換價、順利換股贖回的 CB **已經從清單消失**
   → 樣本天生偏向「拉失敗的那些」→ **系統性低估**這個訊號的效果。
   所以:
     ・若實測仍是**正的** → 那是真的有東西(偏誤是往下壓的)。
     ・若實測是**負的或零** → **不能下結論**,只能說「用現有資料看不出來」。
   另外轉換價會因反稀釋(除權息/現增)向下調整,拿今天的 cp 回推過去會**略微高估**距離。

跑法:python3 cb_probe.py
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

DATA = Path('data')
HORIZONS = (5, 10, 20, 60)
DEDUP = 20
MIN_BUCKET = 100


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
    pack = load(DATA / 'fmx_pack.json') or {}
    cb = (pack.get('data') or {}).get('cb') or load(DATA / 'cb_overview.json') or {}
    if isinstance(cb, dict) and 'data' in cb:
        cb = cb['data']
    cb = {k: v for k, v in (cb or {}).items() if isinstance(v, dict) and float(v.get('cp') or 0) > 0}
    if len(cb) < 50:
        print(f'❌ 可轉債資料不足({len(cb)} 檔)→ 先還原 data/(git archive origin/gh-pages)')
        return 2

    twii = dict(series(load(DATA / '^TWII.json') or []))
    if not twii:
        print('⚠️ 沒有 ^TWII.json → 無法扣同期大盤')
        return 2

    print(f'📂 有發可轉債且拿得到轉換價的:{len(cb)} 檔\n')

    # 分桶:parity = 股價/轉換價×100(逐字稿的「CB 市值」)
    #   <85   還差很遠(公司壓力最大,但也可能是基本面真的爛)
    #   85~100 快到了(拉抬動機最強)
    #   100~130 已過轉換價(換股中)
    #   ≥130  可提前贖回(拉抬期結束)
    def bucket(p):
        if p < 85:
            return 'A <85 離轉換價還很遠'
        if p < 100:
            return 'B 85~100 快摸到轉換價'
        if p < 130:
            return 'C 100~130 已過轉換價'
        return 'D ≥130 可提前贖回'

    buckets = defaultdict(lambda: defaultdict(list))
    n_sym = n_evt = 0

    for sym, rec in cb.items():
        cp = float(rec.get('cp') or 0)
        rows = series(load(DATA / f'{sym}.json') or [])
        if cp <= 0 or len(rows) < 200:
            continue
        n_sym += 1
        dates = [d for d, _ in rows]
        cl = [c for _, c in rows]
        last_evt = -99
        for i in range(60, len(cl) - max(HORIZONS)):
            if i - last_evt < DEDUP:
                continue
            last_evt = i
            n_evt += 1
            key = bucket(cl[i] / cp * 100)
            for h in HORIZONS:
                d0, d1 = dates[i], dates[i + h]
                if d0 in twii and d1 in twii and twii[d0] > 0:
                    r_stk = (cl[i + h] - cl[i]) / cl[i] * 100
                    r_mkt = (twii[d1] - twii[d0]) / twii[d0] * 100
                    buckets[key][h].append(r_stk - r_mkt)

    print(f'✅ {n_sym} 檔 ・{n_evt} 個事件(同檔 {DEDUP} 交易日內只算一次)')
    print('   報酬皆為**超額**(已扣同期加權指數);轉換價用今天的快照回推\n')

    hdr = f'{"位階(股價/轉換價)":<24}{"n":>6}'
    for h in HORIZONS:
        hdr += f'{f"{h}日中位":>10}'
    hdr += f'{"60日勝率":>10}'
    print(hdr)
    rows_out = []
    for key in sorted(buckets):
        hs = buckets[key]
        n = len(hs.get(20, []))
        if n < MIN_BUCKET:
            print(f'{key:<24}{n:>6}   樣本不足,略過')
            continue
        line = f'{key:<24}{n:>6}'
        vals = {}
        for h in HORIZONS:
            v = hs.get(h) or []
            m = statistics.median(v) if v else 0
            vals[h] = m
            line += f'{m:>+9.2f}%'
        w60 = (sum(1 for x in hs.get(60, []) if x > 0) / len(hs[60]) * 100) if hs.get(60) else 0
        line += f'{w60:>9.1f}%'
        print(line)
        rows_out.append((key, vals, w60, n))

    print()
    if len(rows_out) < 2:
        print('⛔ 有效桶不足 2 個,無法比較 → 無結論。')
        return 0

    below = [r for r in rows_out if r[0].startswith(('A', 'B'))]
    above = [r for r in rows_out if r[0].startswith(('C', 'D'))]
    if below and above:
        mb = statistics.median([r[1][20] for r in below])
        ma = statistics.median([r[1][20] for r in above])
        print(f'📌 逐字稿說法:「公司發 CB 是為了不還錢 → 股價低於轉換價時有拉抬動機」')
        print(f'   股價**低於**轉換價(A+B):20 日超額中位 {mb:+.2f}%')
        print(f'   股價**高於**轉換價(C+D):20 日超額中位 {ma:+.2f}%')
        print(f'   → 差距 {mb - ma:+.2f}pp')
        if mb - ma > 0.8:
            print('   ✅ 低於轉換價那組明顯較好 → 訊號成立,值得做成卡片')
        elif mb - ma > -0.8:
            print('   ➖ 兩組差不多 → 沒有可用邊際,⛔ 別為它開功能(可留作說明性資訊)')
        else:
            print('   ❌ 反而更差 → 別做;⚠️ 但注意下面的偏誤說明,不能直接說「這說法是錯的」')

    # 「快摸到轉換價」是不是特別強?(逐字稿:B 區才是拉抬動機最強的)
    b = next((r for r in rows_out if r[0].startswith('B')), None)
    if b:
        others = [r[1][20] for r in rows_out if not r[0].startswith('B')]
        if others:
            print(f'\n📌 逐字稿的重點區「85~100 快摸到轉換價」:20 日超額 {b[1][20]:+.2f}%'
                  f'(n={b[3]}、60 日勝率 {b[2]:.1f}%)')
            print(f'   其餘各桶中位 = {statistics.median(others):+.2f}% → 邊際 {b[1][20] - statistics.median(others):+.2f}pp')

    # ── 對照組:**沒有**發 CB 的股票 ───────────────────────────────
    # ⭐ 上面的分桶比較不需要這個(桶跟桶之間已互為對照),但「有發 CB 的整體表現」這句話
    #    一定要有它 —— 不然分不出是「CB 害的」還是「這個窗口大家都在跌」。
    #    (broker_habit 那次的教訓:窗口內大盤 −8.4%,不扣會得到相反結論。)
    ctl = defaultdict(list)
    n_ctl_sym = 0
    for f in sorted(DATA.glob('*.json')):
        sym = f.stem
        if sym.startswith('^') or sym in cb or not sym.isdigit() or len(sym) != 4:
            continue
        rows = series(load(f) or [])
        if len(rows) < 200:
            continue
        n_ctl_sym += 1
        dates = [d for d, _ in rows]
        cl = [c for _, c in rows]
        last_evt = -99
        for i in range(60, len(cl) - max(HORIZONS)):
            if i - last_evt < DEDUP:
                continue
            last_evt = i
            for h in HORIZONS:
                d0, d1 = dates[i], dates[i + h]
                if d0 in twii and d1 in twii and twii[d0] > 0:
                    ctl[h].append((cl[i + h] - cl[i]) / cl[i] * 100
                                  - (twii[d1] - twii[d0]) / twii[d0] * 100)

    if ctl.get(20) and len(ctl[20]) >= MIN_BUCKET:
        allcb = defaultdict(list)
        for hs in buckets.values():
            for h in HORIZONS:
                allcb[h].extend(hs.get(h) or [])
        print(f'\n📌 ⭐ 乾淨對照組:**沒發 CB** 的 {n_ctl_sym} 檔(同樣扣掉同期加權)')
        line_cb = f'{"有發 CB(全部)":<24}{len(allcb[20]):>6}'
        line_ct = f'{"沒發 CB(對照)":<24}{len(ctl[20]):>6}'
        for h in HORIZONS:
            line_cb += f'{statistics.median(allcb[h]):>+9.2f}%'
            line_ct += f'{statistics.median(ctl[h]):>+9.2f}%'
        print(f'{"":<24}{"n":>6}' + ''.join(f'{f"{h}日中位":>10}' for h in HORIZONS))
        print(line_cb)
        print(line_ct)
        d60 = statistics.median(allcb[60]) - statistics.median(ctl[60])
        print(f'   → 60 日差距 {d60:+.2f}pp')
        print('   ' + ('✅ 逐字稿說「發可轉債多的公司要留意、最後吃虧的是小股東」→ **實測支持**'
                       if d60 < -1 else
                       '➖ 有發 CB 跟沒發差不多 → 「小股東吃虧」在我的資料上看不出來'))

    # ── ⭐ 決定性的一問:扣掉「位階」之後,轉換價還剩下什麼? ──────────────
    # parity = 股價 ÷ 轉換價,而轉換價 ≈ 發行當時的股價 → parity 本質上就是
    # 「這檔從發債到現在漲了多少」= 一個**動能/位階的代理變數**。
    # 本專案早就有位階溫度計與乖離,所以真正要問的不是「parity 有沒有效」,
    # 而是「**在位階相同的股票裡**,parity 還有沒有額外資訊」。
    # 沒有的話就別開新卡(同 P2-6「本來就不同的東西別硬合併」的反面:重複的別硬加)。
    strat = defaultdict(lambda: defaultdict(list))
    for sym, rec in cb.items():
        cp = float(rec.get('cp') or 0)
        rows = series(load(DATA / f'{sym}.json') or [])
        if cp <= 0 or len(rows) < 300:
            continue
        dates = [d for d, _ in rows]
        cl = [c for _, c in rows]
        last_evt = -99
        for i in range(250, len(cl) - max(HORIZONS)):
            if i - last_evt < DEDUP:
                continue
            last_evt = i
            win = cl[i - 240:i + 1]
            mn, mx = min(win), max(win)
            pos = (cl[i] - mn) / (mx - mn) * 100 if mx > mn else 50
            pb = '低位階' if pos < 33 else ('中位階' if pos < 67 else '高位階')
            par = '低於轉換價' if cl[i] < cp else '高於轉換價'
            for h in HORIZONS:
                d0, d1 = dates[i], dates[i + h]
                if d0 in twii and d1 in twii and twii[d0] > 0:
                    strat[(pb, par)][h].append((cl[i + h] - cl[i]) / cl[i] * 100
                                               - (twii[d1] - twii[d0]) / twii[d0] * 100)

    print('\n📌 ⭐ 決定性測試:**同一個位階裡**,「低於/高於轉換價」還差多少?')
    print('   (轉換價≈發債當時股價 → parity 本質是位階的代理變數;位階我早就有了)')
    print(f'{"位階":<10}{"vs轉換價":<14}{"n":>6}{"20日中位":>10}{"60日中位":>10}')
    deltas = []
    for pb in ('低位階', '中位階', '高位階'):
        pair = {}
        for par in ('低於轉換價', '高於轉換價'):
            v = strat.get((pb, par)) or {}
            n = len(v.get(20) or [])
            if n < MIN_BUCKET:
                print(f'{pb:<10}{par:<14}{n:>6}   樣本不足')
                continue
            m20, m60 = statistics.median(v[20]), statistics.median(v.get(60) or [0])
            pair[par] = m20
            print(f'{pb:<10}{par:<14}{n:>6}{m20:>+9.2f}%{m60:>+9.2f}%')
        if len(pair) == 2:
            deltas.append((pb, pair['低於轉換價'] - pair['高於轉換價']))
    if deltas:
        print('\n   同位階內的差距(低於 − 高於):'
              + ' ・'.join(f'{pb} {d:+.2f}pp' for pb, d in deltas))
        big = [d for _, d in deltas if abs(d) > 1.0]
        same_sign = len({d > 0 for _, d in deltas}) == 1
        if len(big) >= 2 and same_sign:
            print('   ✅ 位階固定後仍有一致方向的差距 → 轉換價**有額外資訊**,值得做')
        else:
            print('   ➖ 位階固定後差距就散掉了 → 轉換價講的東西**位階溫度計早就講過了**')
            print('   ⛔ 結論:別為它開新卡(會變成「同一件事兩個名字」,違反「邏輯不打架」)')

    # ── 收斂門檻:高位階裡,parity 要到多少才算「出貨期」? ─────────────
    # 逐字稿講的是「高檔 + 市值 >120(厲害的炒到 150~200)+ 融券大增 + 現券償還 → 行情告一段落」。
    # 上面已證明 (高位階 × 高於轉換價) 是最差的一格,這裡把 parity 切細找門檻。
    fine = defaultdict(lambda: defaultdict(list))
    for sym, rec in cb.items():
        cp = float(rec.get('cp') or 0)
        rows = series(load(DATA / f'{sym}.json') or [])
        if cp <= 0 or len(rows) < 300:
            continue
        dates = [d for d, _ in rows]
        cl = [c for _, c in rows]
        last_evt = -99
        for i in range(250, len(cl) - max(HORIZONS)):
            if i - last_evt < DEDUP:
                continue
            last_evt = i
            win = cl[i - 240:i + 1]
            mn, mx = min(win), max(win)
            pos = (cl[i] - mn) / (mx - mn) * 100 if mx > mn else 50
            if pos < 67:
                continue                      # 只看高位階(那格差距最大)
            p = cl[i] / cp * 100
            k = ('<100 還沒過轉換價' if p < 100 else '100~120 剛過' if p < 120
                 else '120~150 逐字稿的出貨區' if p < 150 else '≥150 大幅超過')
            for h in HORIZONS:
                d0, d1 = dates[i], dates[i + h]
                if d0 in twii and d1 in twii and twii[d0] > 0:
                    fine[k][h].append((cl[i + h] - cl[i]) / cl[i] * 100
                                      - (twii[d1] - twii[d0]) / twii[d0] * 100)

    print('\n📌 收斂門檻:**高位階**的股票裡,離轉換價多遠開始變差?')
    print(f'{"高位階 × parity":<26}{"n":>6}{"20日中位":>10}{"60日中位":>10}{"60日勝率":>10}')
    for k in ('<100 還沒過轉換價', '100~120 剛過', '120~150 逐字稿的出貨區', '≥150 大幅超過'):
        v = fine.get(k) or {}
        n = len(v.get(20) or [])
        if n < 60:
            print(f'{k:<26}{n:>6}   樣本不足')
            continue
        w = sum(1 for x in v.get(60) or [] if x > 0) / max(1, len(v.get(60) or [1])) * 100
        print(f'{k:<26}{n:>6}{statistics.median(v[20]):>+9.2f}%'
              f'{statistics.median(v.get(60) or [0]):>+9.2f}%{w:>9.1f}%')

    print('\n⚠️⚠️ 必讀偏誤(方向已知,不可省略):')
    print('   cb_overview.json 是**今天的快照**,只含今天還沒轉換完的 CB。')
    print('   當年真的被拉過轉換價、換股贖回的 CB 已經從清單消失')
    print('   → 樣本天生偏向「拉失敗的那些」→ **系統性低估**這個訊號。')
    print('   所以正數才有意義;負數/零只能說「現有資料看不出來」,不能說這個說法是錯的。')
    print('   另外轉換價會因反稀釋向下調整,用今天的 cp 回推過去會略微高估距離。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
