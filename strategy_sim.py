# -*- coding: utf-8 -*-
"""朱家泓折數心法 — 策略核心純函式(單一真相來源)。

背景:原本這些邏輯只存在於前端 index.html(JS,逐檔開圖才算),Python 全市場掃描
      (radar_miner)與回測(backtest)只 port 了一部分,且「與前端同邏輯」全靠人工同步。
      本模組把可程式化的策略核心集中成 Python 純函式,供 backtest / radar_miner /
      potential_miner 共用,並作為未來與前端對齊的規格參考。

對應逐字稿:
- 轉折波高低點(±8 fractal)/頭頭高底底高 …… 第 1 章
- 回後買上漲(chu_long_entry)…………………… 第 6-2 章(旗艦訊號)
- 朱式出場模擬 + 動態移動停損(simulate_chu_exit)第 7、8、9 章
- 波段階段(bang_stage)……………………………… 第 5-1/5-6 章
- 淘汰選股 13 條(chu_eliminate)………………… 第 5-3 章
- 葛蘭碧八大買賣點(granville)…………………… 第 3-6 章

只依賴標準函式庫與 common(is_finite_num / safe_ma),不 import 專案其他模組。
所有函式對「資料不足 / 髒值」皆回安全預設(None / [] / 'range'),不拋例外。
"""
from common import is_finite_num, safe_ma

# ── K 棒欄位存取(相容 close/c、high/h …;非有限值回 0)──────────────────────
def _num(x):
    return x if is_finite_num(x) else 0.0

def _c(b): return _num(b.get('close', b.get('c', 0)))
def _o(b): return _num(b.get('open',  b.get('o', 0)))
def _h(b): return _num(b.get('high',  b.get('h', 0)))
def _l(b): return _num(b.get('low',   b.get('l', 0)))
def _v(b): return _num(b.get('volume', 0))


def _clean_closes(closes):
    """把收盤序列的非有限值(None/NaN/±Inf)一律轉 0.0 → 讓下列公開函式也能安全吃髒資料。"""
    return [c if is_finite_num(c) else 0.0 for c in (closes or [])]


def _ma_series(closes, period):
    """回傳與 closes 等長的 MA 陣列;每點取「往回 period(不足則用現有)」的平均。
    對齊前端 data.slice(end-k+1, end+1) 的算法(前段不足時用較短視窗,不回 None)。"""
    out = []
    for i in range(len(closes)):
        seg = closes[max(0, i - period + 1): i + 1]
        out.append(sum(seg) / len(seg) if seg else 0.0)
    return out


# ── 轉折波高低點(±k fractal)+ 趨勢結構(頭頭高底底高)第 1 章 ───────────────
def find_swings(closes, k=8, lookback=120):
    """在最近 lookback 根用 ±k 收盤 fractal 找波峰 / 波谷。
    回 (peaks, troughs),各為 [(idx, value), ...](時間序)。對齊前端 _detectChuLongEntry。"""
    closes = _clean_closes(closes)
    n = len(closes)
    peaks, troughs = [], []
    if n < 2 * k + 1:
        return peaks, troughs
    frm = max(0, n - lookback)
    for i in range(frm + k, n - k):
        w = closes[i - k: i + k + 1]
        if closes[i] == max(w):
            peaks.append((i, closes[i]))
        if closes[i] == min(w):
            troughs.append((i, closes[i]))
    return peaks, troughs


def trend_structure(closes, k=8):
    """朱式趨勢結構判定。回 dict:
       trend='bull'/'bear'/'range'、higher_high、trough_up、last_peak、last_trough。
       多頭=(頭頭高 或 正創更高高點) 且 底底高;空頭=頭頭低 且 底底低;其餘=盤整。"""
    closes = _clean_closes(closes)
    peaks, troughs = find_swings(closes, k)
    res = {'trend': 'range', 'higher_high': False, 'trough_up': False,
           'last_peak': None, 'last_trough': None, 'peaks': peaks, 'troughs': troughs}
    if len(peaks) < 2 or len(troughs) < 2 or not closes:
        return res
    pC = closes[-1]
    peak_up = peaks[-1][1] > peaks[-2][1]
    higher_high = pC > peaks[-1][1]           # V42.1 噴出股補丁:正創更高高點也算頭頭高
    trough_up = troughs[-1][1] > troughs[-2][1]
    peak_dn = peaks[-1][1] < peaks[-2][1]
    trough_dn = troughs[-1][1] < troughs[-2][1]
    res.update({'higher_high': higher_high, 'trough_up': trough_up,
                'last_peak': peaks[-1][1], 'last_trough': troughs[-1][1]})
    if (peak_up or higher_high) and trough_up:
        res['trend'] = 'bull'
    elif peak_dn and trough_dn:
        res['trend'] = 'bear'
    return res


# ── 波段階段(底部/出生段/主升段/末升段)第 5-1、5-6 章 ─────────────────────
def bang_stage(closes, k=8):
    """粗判目前波段階段,供選股排序與「末升段排除」。
    以「距最近確認波谷的漲幅」+ 波數近似:
      <8% 且剛轉多 → 'base'(打底/出生段);8~40% → 'main'(主升段);
      >=100% 或距底 4 個波峰以上 → 'end'(末升段,應排除);其餘 → 'mid'。"""
    closes = _clean_closes(closes)
    st = trend_structure(closes, k)
    if st['trend'] != 'bull' or st['last_trough'] is None or st['last_trough'] <= 0:
        return {'stage': 'na', 'rise_from_trough': 0.0, 'trend': st['trend']}
    rise = (closes[-1] - st['last_trough']) / st['last_trough'] * 100
    n_peaks = len(st['peaks'])
    # 末升段 = 漲幅一倍(主判據)或「多波段且已有相當漲幅」(第3波後);
    # 純用 n_peaks 會誤殺震盪股(120天±8 fractal 容易湊到4峰卻漲幅不大)→ 波數須搭配漲幅≥50%
    if rise >= 100 or (n_peaks >= 4 and rise >= 50):
        stage = 'end'
    elif rise < 8:
        stage = 'base'
    elif rise <= 40:
        stage = 'main'
    else:
        stage = 'mid'
    return {'stage': stage, 'rise_from_trough': round(rise, 1), 'trend': 'bull'}


# ── 回後買上漲(旗艦訊號)第 6-2 章 ── port 自前端 _detectChuLongEntry ─────────
def chu_long_entry(bars, k=8):
    """回後買上漲偵測。回 dict 或 None:
       {grade:'high'/'weak'/'chase'/'wait', reason, entry, stop, upside_room, stage, retrace}
       grade:
         high  = 高勝率(波段多頭 + 剛站上5MA + 紅K≥2% + 量增 + 過昨高 + 上方空間≥10%)
         weak  = 力道偏弱(站上5MA 但三條件未齊 或 上方空間不足)
         chase = 多頭但追高(近波段高,不建議追)
         wait  = 多頭回檔中,暫未站上5MA(鎖股等待)
    第 4 建議:加「上方空間 upside_room ≥10%」gate;末升段(bang_stage='end')降級。"""
    if not bars or len(bars) < 30:
        return None
    closes = [_c(b) for b in bars]
    n = len(closes)
    ma5 = _ma_series(closes, 5)
    ma20 = _ma_series(closes, 20)
    if ma5[-1] <= 0 or ma5[-2] <= 0:
        return None
    st = trend_structure(closes, k)
    if not ((st['higher_high'] or (st['last_peak'] is not None and closes[-1] > st['last_peak'])
             or _bull_peakup(st)) and st['trough_up']):
        return None                       # 非波段多頭 → 不可做多
    last_trough = st['last_trough']
    if last_trough is None or last_trough <= 0:
        return None
    pC, yC = closes[-1], closes[-2]
    no_break_low = pC > last_trough and _l(bars[-1]) > last_trough * 0.99
    if not no_break_low:
        return None
    red = pC > _o(bars[-1])
    up_day = pC > yC
    just_reclaim = yC < ma5[-2] and pC >= ma5[-1]
    above_ma5 = pC >= ma5[-1]
    high60 = max((_h(b) for b in bars[-60:]), default=0)
    chasing = high60 > 0 and pC >= high60 * 0.97
    # 回檔幅度(強弱):回 < ½ 為強勢
    recent_peak = st['last_peak']
    prior_trough = st['troughs'][-2][1] if len(st['troughs']) >= 2 else last_trough
    up_leg = (recent_peak - prior_trough) if recent_peak is not None else 0
    retrace = (recent_peak - last_trough) / up_leg if up_leg > 0 else 0

    # 第 4 建議:上方空間 = 到最近壓力(前波峰 / 季線)的空間%,<10% 視為空間不足
    ma60 = safe_ma(closes, 60) if n >= 60 else None
    resist = [r for r in (recent_peak, ma60) if r and r > pC]
    upside_room = (min(resist) - pC) / pC * 100 if resist else 99.0
    stage = bang_stage(closes, k)['stage']

    def _mk(grade, reason):
        entry = round(pC, 2)
        stop = round(min(_l(bars[-1]), last_trough), 2)
        return {'grade': grade, 'reason': reason, 'entry': entry, 'stop': stop,
                'upside_room': round(upside_room, 1), 'stage': stage,
                'retrace': round(retrace, 2), 'ma5': round(ma5[-1], 2)}

    if just_reclaim and (red or up_day):
        body = (pC - _o(bars[-1])) / _o(bars[-1]) * 100 if _o(bars[-1]) > 0 else 0
        vol_up = _v(bars[-1]) > _v(bars[-2])
        over_y = pC > _h(bars[-2])
        on_ma20 = pC >= ma20[-1] if ma20[-1] > 0 else True
        # 📏 逐字稿6-2 鐵則:收>20MA 且 20MA 上彎(缺一不可)。月線上彎用 5 天斜率(波段準則)。
        ma20_up = ma20[-1] >= ma20[-6] if n >= 25 else True
        # 📏 逐字稿6-2 黃金分割:回檔 >0.618 上方全是解套賣壓 → 即使站上5MA也不算高勝率(降級)。
        shallow = retrace <= 0.618
        hi_prob = body >= 2 and vol_up and over_y and on_ma20 and ma20_up and shallow
        if hi_prob and upside_room >= 10 and stage != 'end':
            return _mk('high', f'高勝率:回站5MA+紅K{body:.1f}%+量增+過昨高+站月線上彎+回檔淺{retrace:.0%},上方空間{upside_room:.0f}%')
        # 缺鐵則 / 空間不足 / 末升段 → 只給 weak
        miss = []
        if body < 2: miss.append('紅K<2%')
        if not vol_up: miss.append('量未增')
        if not over_y: miss.append('未過昨高')
        if not on_ma20: miss.append('未站月線')
        if not ma20_up: miss.append('月線未上彎')
        if not shallow: miss.append(f'回檔過深{retrace:.0%}(>0.618解套賣壓重)')
        if upside_room < 10: miss.append(f'上方空間僅{upside_room:.0f}%<10%')
        if stage == 'end': miss.append('末升段(漲幅過大)')
        return _mk('weak', '力道/空間偏弱:' + ('、'.join(miss) if miss else '待鐵則齊'))
    if above_ma5 and chasing:
        return _mk('chase', '多頭但追高:近波段高,等回檔不破前低再站上5MA')
    if not above_ma5:
        return _mk('wait', '多頭回檔中,鎖股等紅K站回5MA且不破前低')
    return None


def _bull_peakup(st):
    peaks = st.get('peaks') or []
    return len(peaks) >= 2 and peaks[-1][1] > peaks[-2][1]


# ── 朱式出場模擬 + 動態移動停損 第 7、8、9 章 ─────────────────────────────────
def simulate_chu_exit(bars, entry_idx, entry_px=None):
    """從 entry_idx 進場,逐根模擬朱式出場,回 dict:
       {exit_idx, exit_px, return_pct, bars_held, reason}。走到資料尾端仍未出場則以最後收盤結算。
    出場規則(第 7-9 章):
       初始停損 = min(進場K低點, 進場價×0.95)。
       跌破5MA 收盤 → 停利/停損出場。
       動態升級:獲利曾達 +7% → 取消固定停損,只守 5MA(鎖住不再賠);
                 獲利曾達 +20% → 高檔爆量長黑/長上影收黑 隔根即出(加速停利)。"""
    if not bars:
        return None
    n = len(bars)
    if entry_idx < 0 or entry_idx >= n - 1:
        return None
    closes = [_c(b) for b in bars]
    ma5 = _ma_series(closes, 5)
    entry = entry_px if (entry_px and entry_px > 0) else closes[entry_idx]
    if entry <= 0:
        return None
    # 📏 逐字稿7-3 絕對停損鐵則:虧損超過 10% 一律出場,任何情況(含鎖利後)不可再凹。
    #    初始固定停損取「進場K低 / -5%」較嚴者,但地板永不低於 -10%(進場買在漲停附近時 K 低可能 <-10%)。
    abs_floor = entry * 0.90
    hard_stop = max(min(_l(bars[entry_idx]), entry * 0.95), abs_floor)
    peak_ret = 0.0
    locked = False              # 獲利 ≥7% 後鎖利(取消固定停損)
    accel = False               # 獲利 ≥20% 後啟動加速停利
    for i in range(entry_idx + 1, n):
        c = closes[i]
        ret = (c - entry) / entry
        peak_ret = max(peak_ret, ret)
        if peak_ret >= 0.07:
            locked = True
        if peak_ret >= 0.20:
            accel = True
        # 7-3 絕對停損鐵則:跌幅 >10% 一律出(含鎖利後跳空,守 5MA 也擋不住的破口)
        if c <= abs_floor:
            return _exit(entry, c, i, entry_idx, '破絕對停損-10%(鐵則)')
        # 加速停利:高檔爆量長黑或長上影收黑 → 出場
        if accel:
            rng = _h(bars[i]) - _l(bars[i])
            black = c < _o(bars[i])
            up_shadow = _h(bars[i]) - max(_o(bars[i]), c)
            if rng > 0 and black and (up_shadow >= rng * 0.5 or (_o(bars[i]) - c) / entry >= 0.03):
                return _exit(entry, c, i, entry_idx, '高檔爆量長黑/上影加速停利')
        # 跌破 5MA 收盤 → 出場(停利或停損)
        if ma5[i] > 0 and c < ma5[i]:
            return _exit(entry, c, i, entry_idx, '跌破5MA')
        # 未鎖利前,固定停損仍有效(-5%~-10% 區間)
        if not locked and c <= hard_stop:
            return _exit(entry, c, i, entry_idx, '破固定停損(進場K低/-5%)')
    # 資料尾端仍持有 → 以最後收盤結算(未平倉,closed=False 供向前追蹤判斷「還在持有」)
    return _exit(entry, closes[-1], n - 1, entry_idx, '尚未出場(資料末端結算)', closed=False)


def _exit(entry, exit_px, exit_idx, entry_idx, reason, closed=True):
    return {'exit_idx': exit_idx, 'exit_px': round(exit_px, 2),
            'return_pct': round((exit_px - entry) / entry * 100, 2),
            'bars_held': exit_idx - entry_idx, 'reason': reason, 'closed': closed}


def simulate_three_ma_scaled_exit(bars, entry_idx, entry_px=None):
    """三均線分批出場(第 8-5 章「長線保護短線」):3 張等額。
       跌破5MA賣1張、跌破10MA賣1張、跌破20MA賣尾張;急漲曾>20% 後跌破5MA → 三張全出。
    回 dict:{return_pct(3張加權平均), exit_idx(最後一張出場), bars_held, closed, reasons}。
    介面與 simulate_chu_exit 相容(exit_idx/return_pct/closed),可互換給 backtest_chu_swing。"""
    if not bars:
        return None
    n = len(bars)
    if entry_idx < 0 or entry_idx >= n - 1:
        return None
    closes = [_c(b) for b in bars]
    ma5 = _ma_series(closes, 5)
    ma10 = _ma_series(closes, 10)
    ma20 = _ma_series(closes, 20)
    entry = entry_px if (entry_px and entry_px > 0) else closes[entry_idx]
    if entry <= 0:
        return None
    shares = {'5': None, '10': None, '20': None}   # 每張的 (exit_idx, exit_px, reason)
    stop_px = entry * 0.95                          # 8-3/8-5 初始 -5% 停損

    def _sell(key, i, reason):
        if shares[key] is None:
            shares[key] = (i, closes[i], reason)

    peak_ret = 0.0
    for i in range(entry_idx + 1, n):
        c = closes[i]
        peak_ret = max(peak_ret, (c - entry) / entry)
        # 📏 8-3/8-5 初始停損鐵則:仍在虧損且跌破 -5% → 三張「全部一起停損」(不分批,避免小賠拖成大賠)
        if c <= stop_px and c < entry and any(v is None for v in shares.values()):
            for kma in shares:
                _sell(kma, i, '破-5%停損三張全出')
            break
        # 急漲曾 >20% 後跌破5MA → 三張全出(鎖住主升段利潤)
        if peak_ret >= 0.20 and ma5[i] > 0 and c < ma5[i]:
            for kma in shares:
                _sell(kma, i, '急漲>20%跌破5MA全出')
            break
        if ma5[i] > 0 and c < ma5[i]:
            _sell('5', i, '跌破5MA賣1/3')
        if ma10[i] > 0 and c < ma10[i]:
            _sell('10', i, '跌破10MA賣1/3')
        if ma20[i] > 0 and c < ma20[i]:
            _sell('20', i, '跌破20MA賣尾1/3')
        if all(v is not None for v in shares.values()):
            break

    closed_all = all(v is not None for v in shares.values())
    # 尾端未出的張以最後收盤結算(未平倉)
    for kma in shares:
        if shares[kma] is None:
            shares[kma] = (n - 1, closes[-1], '尚未出場(末端結算)')
    rets = [(px - entry) / entry * 100 for (_i, px, _r) in shares.values()]
    exit_idx = max(i for (i, _px, _r) in shares.values())
    return {
        'return_pct': round(sum(rets) / 3, 2),
        'exit_idx': exit_idx,
        'bars_held': exit_idx - entry_idx,
        'closed': closed_all,
        'reasons': [shares[k][2] for k in ('5', '10', '20')],
    }


def simulate_kline_exit(bars, entry_idx, entry_px=None):
    """K線轉折短線出場(第 8-2 章):每天守「前一根 K 線最低點」,收盤跌破前一日低點即出場
       (逐日上移,兼具移動停利)。專用於離 5MA 太遠、噴出中的飆股(守 5MA 會太早出)。
       仍保留 -10% 絕對停損地板(7-3)。介面與 simulate_chu_exit 相容,可傳給 backtest_chu_swing。"""
    if not bars:
        return None
    n = len(bars)
    if entry_idx < 0 or entry_idx >= n - 1:
        return None
    closes = [_c(b) for b in bars]
    entry = entry_px if (entry_px and entry_px > 0) else closes[entry_idx]
    if entry <= 0:
        return None
    abs_floor = entry * 0.90
    for i in range(entry_idx + 1, n):
        c = closes[i]
        if c <= abs_floor:
            return _exit(entry, c, i, entry_idx, '破絕對停損-10%(鐵則)')
        prev_low = _l(bars[i - 1])
        if prev_low > 0 and c < prev_low:
            return _exit(entry, c, i, entry_idx, '跌破前一日K低(轉折出場)')
    return _exit(entry, closes[-1], n - 1, entry_idx, '尚未出場(資料末端結算)', closed=False)


def simulate_long_ma_exit(bars, entry_idx, entry_px=None):
    """長線均線出場(第 8-4 章):停利守月線 20MA(而非 5MA),抱得住波段;
       獲利曾 >20% 改守 5MA 鎖利(主升段末端加速);仍保留 -10% 絕對停損地板(7-3)。
       (逐字稿另有「趨勢確認轉空頭即出」,實務上頭頭低多已跌破 20MA,為維持 O(n) 不逐根重算轉折波,
        以「跌破 20MA」近似涵蓋。)介面與 simulate_chu_exit 相容,可傳給 backtest_chu_swing。"""
    if not bars:
        return None
    n = len(bars)
    if entry_idx < 0 or entry_idx >= n - 1:
        return None
    closes = [_c(b) for b in bars]
    ma5 = _ma_series(closes, 5)
    ma20 = _ma_series(closes, 20)
    entry = entry_px if (entry_px and entry_px > 0) else closes[entry_idx]
    if entry <= 0:
        return None
    abs_floor = entry * 0.90
    peak_ret = 0.0
    for i in range(entry_idx + 1, n):
        c = closes[i]
        peak_ret = max(peak_ret, (c - entry) / entry)
        if c <= abs_floor:
            return _exit(entry, c, i, entry_idx, '破絕對停損-10%(鐵則)')
        # 獲利曾 >20% → 改守 5MA 鎖利;否則守月線 20MA(長線抱波段)
        if peak_ret >= 0.20:
            if ma5[i] > 0 and c < ma5[i]:
                return _exit(entry, c, i, entry_idx, '跌破5MA(鎖利)')
        elif ma20[i] > 0 and c < ma20[i]:
            return _exit(entry, c, i, entry_idx, '跌破20MA(長線停利)')
    return _exit(entry, closes[-1], n - 1, entry_idx, '尚未出場(資料末端結算)', closed=False)


def backtest_chu_swing(bars, cost_pct=0.0, exit_fn=None):
    """回後買上漲進場 + 朱式出場 的逐根回測期望值。回 dict 或 None(交易<5筆/負期望值)。
    取代原本散在 radar_miner._chu_backtest 的內嵌邏輯。
    exit_fn:出場模型,預設 simulate_chu_exit(全出);可傳 simulate_three_ma_scaled_exit(三均線分批)比較。"""
    if exit_fn is None:
        exit_fn = simulate_chu_exit
    if not bars or len(bars) < 90:
        return None
    closes = [_c(b) for b in bars]
    n = len(closes)
    ma5 = _ma_series(closes, 5)
    ma20 = _ma_series(closes, 20)
    trades = []
    i = 21
    while i < n:
        c, o, pc, ph = closes[i], _o(bars[i]), closes[i - 1], _h(bars[i - 1])
        uptrend = c > ma20[i] and ma5[i] >= ma20[i]
        reclaim5 = pc < ma5[i - 1] and c >= ma5[i]
        body = (c - o) / o * 100 if o > 0 else 0
        vol_up = _v(bars[i]) > _v(bars[i - 1])
        if uptrend and reclaim5 and body >= 2 and vol_up and c > ph:
            ex = exit_fn(bars, i)
            if ex:
                trades.append(ex['return_pct'] - cost_pct)
                i = ex['exit_idx'] + 1     # 出場後才找下一次進場(不重疊)
                continue
        i += 1
    if len(trades) < 5:
        return None
    wins = [t for t in trades if t > 0]
    losses = [t for t in trades if t <= 0]
    expectancy = sum(trades) / len(trades)
    avg_win = sum(wins) / len(wins) if wins else 0
    avg_loss = sum(losses) / len(losses) if losses else 0
    comp = 1.0
    for t in trades:
        comp *= (1 + t / 100)
    return {
        'trades': len(trades),
        'win_rate': round(len(wins) / len(trades) * 100, 0),
        'expectancy': round(expectancy, 2),
        'pl_ratio': round(abs(avg_win / avg_loss), 2) if avg_loss != 0 else 99,
        'total_return': round((comp - 1) * 100, 0),
        'positive': expectancy > 0,
    }


# ── 淘汰選股法 13 條 第 5-3 章 ───────────────────────────────────────────────
def chu_eliminate(bars, k=8):
    """回傳「觸發的淘汰理由」清單(空 list = 沒踩雷)。作為選股後的負面過濾/紅旗標註。"""
    reasons = []
    if not bars or len(bars) < 30:
        return ['資料不足30根']
    closes = [_c(b) for b in bars]
    n = len(closes)
    st = trend_structure(closes, k)
    ma20 = _ma_series(closes, 20)
    ma20_up = n >= 25 and ma20[-1] >= ma20[-6]
    c = closes[-1]
    # 1 未打底 / 空頭下跌
    if st['trend'] == 'bear':
        reasons.append('空頭趨勢(頭頭低底底低)')
    # 4 自底部漲幅≥100% → 只可短線
    stg = bang_stage(closes, k)
    if stg['stage'] == 'end':
        reasons.append(f"末升段/漲幅過大(距底{stg['rise_from_trough']:.0f}%)")
    # 5 高檔爆量後連跌3天
    if n >= 8:
        base = sum(_v(b) for b in bars[-8:-3]) / 5 if len(bars) >= 8 else 0
        recent_burst = any(_v(bars[-j]) >= base * 2 for j in range(3, 6)) if base > 0 else False
        down3 = all(closes[-j] < closes[-j - 1] for j in range(1, 4))
        if recent_burst and down3:
            reasons.append('高檔爆量後連跌3天')
    # 8 跌破月線且月線下彎
    if ma20[-1] > 0 and c < ma20[-1] and n >= 25 and ma20[-1] < ma20[-6]:
        reasons.append('跌破月線且月線下彎')
    # 9 跌破前低(底底低)
    if st['last_trough'] and c < st['last_trough']:
        reasons.append('跌破前波低點(底底低)')
    # 3 量價背離:近5日價漲但量縮
    if n >= 6:
        v5 = sum(_v(b) for b in bars[-5:]) / 5
        v_prev = sum(_v(b) for b in bars[-10:-5]) / 5 if n >= 10 else v5
        if closes[-1] > closes[-6] and v_prev > 0 and v5 < v_prev * 0.9:
            reasons.append('價漲量縮(量價背離)')
    # 2 上漲後轉盤整、趨勢不明
    if st['trend'] == 'range' and not ma20_up:
        reasons.append('盤整/趨勢不明、月線未上揚')
    # 7 高檔爆量長黑(開高走低)— 5-3 淘汰第7條:相對高檔單日爆量長黑,短期過不了
    if n >= 6:
        win = bars[-60:]
        whi = max(_h(b) for b in win)
        wlo = min(_l(b) for b in win)
        pos = (c - wlo) / (whi - wlo) if whi > wlo else 0.5
        base5 = sum(_v(b) for b in bars[-6:-1]) / 5
        o_last = _o(bars[-1])
        if pos >= 0.7 and base5 > 0 and _v(bars[-1]) >= base5 * 2 \
           and c < o_last and o_last > 0 and (o_last - c) / c >= 0.03:
            reasons.append('高檔爆量長黑(開高走低,短期過不了)')
    # 11 高檔指標背離 + 頭頭低 — 5-3 淘汰第11條:指標領先反應轉空,立即淘汰
    peaks = st.get('peaks') or []
    peak_dn = len(peaks) >= 2 and peaks[-1][1] < peaks[-2][1]
    if peak_dn and any(d.get('side') == 'bear' for d in divergence(bars)):
        reasons.append('高檔頭頭低+KD/MACD頂背離(動能轉空)')
    return reasons


# ── 葛蘭碧八大買賣點 第 3-6 章 ── port 自前端 _detectGranville ────────────────
def granville(bars):
    """以 20MA(月線)為準的葛蘭碧八法。回訊號 list:[{side:'buy'/'sell', point:1..4, name}]。
    買4/賣4 為乖離過大(遛狗理論)。"""
    out = []
    if not bars or len(bars) < 25:
        return out
    closes = [_c(b) for b in bars]
    n = len(closes)
    ma = _ma_series(closes, 20)
    m, mY = ma[-1], ma[-2]
    if m <= 0 or mY <= 0:
        return out
    pC, yC = closes[-1], closes[-2]
    pH, pL = _h(bars[-1]), _l(bars[-1])
    slope_up = n >= 6 and ma[-1] > ma[-6]
    slope_dn = n >= 6 and ma[-1] < ma[-6]
    dev = (pC - m) / m * 100
    if yC < mY and pC > m and not slope_dn:
        out.append({'side': 'buy', 'point': 1, 'name': '突破月線(黃金交叉)'})
    elif yC > mY and pC < m and not slope_up:
        out.append({'side': 'sell', 'point': 1, 'name': '跌破月線(死亡交叉)'})
    elif slope_up and pL < m and pC > m:
        out.append({'side': 'buy', 'point': 2, 'name': '假跌破站回'})
    elif slope_dn and pH > m and pC < m:
        out.append({'side': 'sell', 'point': 2, 'name': '假突破跌回'})
    elif slope_up and m <= pC <= m * 1.03 and pC > _o(bars[-1]):
        out.append({'side': 'buy', 'point': 3, 'name': '回測月線支撐收紅'})
    elif slope_dn and m * 0.97 <= pC <= m and pC < _o(bars[-1]):
        out.append({'side': 'sell', 'point': 3, 'name': '反彈受阻月線收黑'})
    # 買4/賣4:乖離過大(遛狗)
    if dev <= -15 and pC > closes[-2]:
        out.append({'side': 'buy', 'point': 4, 'name': f'負乖離過大{dev:.0f}%搶反彈'})
    elif dev >= 15 and pC < closes[-2]:
        out.append({'side': 'sell', 'point': 4, 'name': f'正乖離過大{dev:.0f}%轉空'})
    return out


# ── K線橫盤突破 第 2-3、6-3 章 ── port 自前端 _detectBoxBreakout ─────────────
def box_breakout(bars):
    """近 1-2 根是否突破/跌破前面 3-6 根「窄幅(<8%)橫盤」的上/下頸線。
    回 dict 或 None:{side:'bull'/'bear', neck, when_ago, box_n}。"""
    if not bars or len(bars) < 5:
        return None
    last = len(bars) - 1
    for e in range(last, max(3, last - 1) - 1, -1):
        conf = bars[e]
        if _o(conf) <= 0 or _c(conf) <= 0:
            continue
        for nlen in range(3, 7):                 # 橫盤 3-6 根
            s = e - nlen
            if s < 0:
                break
            box = bars[s:e]
            if len(box) < 3:
                continue
            box_hi = max(_h(b) for b in box)
            box_lo = min(_l(b) for b in box)
            if box_hi <= 0 or box_hi <= box_lo:
                continue
            if (box_hi - box_lo) / box_lo > 0.08:   # 窄幅 <8% 才算橫盤
                continue
            body = (_c(conf) - _o(conf)) / _o(conf) if _o(conf) > 0 else 0
            if _c(conf) > box_hi and _c(conf) > _o(conf) and body >= 0.02:
                return {'side': 'bull', 'neck': round(box_hi, 2), 'when_ago': last - e, 'box_n': nlen}
            if _c(conf) < box_lo and _c(conf) < _o(conf) and (-body) >= 0.02:
                return {'side': 'bear', 'neck': round(box_lo, 2), 'when_ago': last - e, 'box_n': nlen}
    return None


# ── 量能戰法(攻擊/出貨/止跌/換手/強反彈量)第 4 章 ── port 自 _detectVolumeSignals ──
def volume_signals(bars):
    """回訊號 list:[{tone:'bull'/'bear'/'flat'/'warn', name}]。基本量=前5日均量。"""
    out = []
    if not bars or len(bars) < 8:
        return out
    last = len(bars) - 1
    cur = bars[last]
    base = sum(_v(b) for b in bars[last - 5:last]) / 5
    if base <= 0 or _o(cur) <= 0:
        return out
    vr = _v(cur) / base
    win = bars[-60:]
    hi = max(_h(b) for b in win)
    lo = min(_l(b) for b in win)
    rng = hi - lo
    pos = (_c(cur) - lo) / rng if rng > 0 else 0.5      # 0=低檔 1=高檔
    is_high, is_low = pos >= 0.80, pos <= 0.30
    red, black = _c(cur) > _o(cur), _c(cur) < _o(cur)
    if vr >= 1.2 and red and not is_high:
        out.append({'tone': 'bull', 'name': f'攻擊量{vr:.1f}×(主力進貨)'})
    if vr >= 1.5 and black and is_high:
        dbl = lo > 0 and _c(cur) >= lo * 1.9
        out.append({'tone': 'bear', 'name': f'高檔出貨量{vr:.1f}×' + ('(漲近一倍)' if dbl else '')})
    if vr <= 0.5 and is_low:
        lo5 = min(_l(b) for b in bars[last - 5:last])
        if _l(cur) >= lo5:
            out.append({'tone': 'flat', 'name': f'止跌量(量縮{vr*100:.0f}%未破前低)'})
    # 換手量:近5日內高檔大量黑K,被今日紅K收盤過其高
    for j in range(last - 1, max(1, last - 5) - 1, -1):
        b = bars[j]
        bw = [_v(x) for x in bars[max(0, j - 5):j]]
        ba = sum(bw) / len(bw) if bw else 0
        vrj = _v(b) / ba if ba > 0 else 0
        posj = (_c(b) - lo) / rng if rng > 0 else 0.5
        if _c(b) < _o(b) and vrj >= 1.8 and posj >= 0.7:
            if red and _c(cur) > _h(b):
                out.append({'tone': 'bull', 'name': f'換手量(過{last-j}天前高檔大量黑K高)'})
            break
    if is_low and vr >= 2 and red and _c(cur) > _h(bars[last - 1]):
        out.append({'tone': 'warn', 'name': f'強反彈量{vr:.1f}×(非多頭,僅反彈)'})
    # 調節量(第 4-3 高檔爆量三型之一):高檔大量後回檔「價跌量急縮」、守月線不破前低 → 主力調節,易再過高
    if not is_low and black and vr <= 0.5:
        ma20 = _ma_series([_c(b) for b in bars], 20)
        on_ma20 = ma20[-1] > 0 and _c(cur) >= ma20[-1]
        prior_low = min(_l(b) for b in bars[last - 5:last]) if last >= 5 else _l(cur)
        if on_ma20 or _l(cur) > prior_low:
            out.append({'tone': 'bull', 'name': f'調節量(回檔量縮{vr*100:.0f}%守撐,易再過高)'})
    return out


# ── KD / MACD-DIF 序列(供背離)──────────────────────────────────────────────
def kd_series(bars, n=9):
    """台股慣用 Stochastic Slow 的 K 序列(與 radar._chu_kd 同法)。前 n-1 根為 None。"""
    out = [None] * len(bars)
    K, D = 50.0, 50.0
    for i in range(len(bars)):
        if i < n - 1:
            continue
        w = bars[i - n + 1: i + 1]
        hi = max(_h(b) for b in w)
        lo = min(_l(b) for b in w)
        c = _c(bars[i])
        rsv = (c - lo) / (hi - lo) * 100 if hi > lo else 50.0
        K = (2 / 3) * K + (1 / 3) * rsv
        D = (2 / 3) * D + (1 / 3) * K
        out[i] = K
    return out


def dif_series(closes, fast=12, slow=26):
    """MACD 的 DIF(EMA_fast - EMA_slow)序列(與 radar._chu_macd_hist 同法)。前 slow-1 根為 None。"""
    closes = _clean_closes(closes)
    out = [None] * len(closes)
    if len(closes) < slow:
        return out
    kf, ksl = 2 / (fast + 1), 2 / (slow + 1)
    ef = sum(closes[:fast]) / fast
    es = sum(closes[:slow]) / slow
    for i in range(len(closes)):
        if i >= fast:
            ef = closes[i] * kf + ef * (1 - kf)
        if i >= slow:
            es = closes[i] * ksl + es * (1 - ksl)
        if i >= slow - 1:
            out[i] = ef - es
    return out


# ── 指標背離(KD/MACD 頂/底背離)第 5 章 ── port 自前端 _detectIndicatorDivergence ──
def divergence(bars):
    """回訊號 list:[{side:'bear'/'bull', kind:'KD'/'MACD'/'KD+MACD', name}]。
       頂背離=價創新高但 K/DIF 沒創高(賣訊);底背離=價創新低但 K/DIF 沒創低(買訊)。
       用 ±4 收盤 fractal 取最近兩波峰/波谷,最近極值須在最後 8 根內才算即時。"""
    out = []
    if not bars or len(bars) < 40:
        return out
    closes = [_c(b) for b in bars]
    n = len(closes)
    K = kd_series(bars)
    DIF = dif_series(closes)
    SW, last = 4, n - 1
    frm = max(SW, n - 60)
    peaks, troughs = [], []
    for i in range(frm, last - SW + 1):
        w = closes[i - SW: i + SW + 1]
        if closes[i] == max(w):
            peaks.append(i)
        if closes[i] == min(w):
            troughs.append(i)

    def _val(a, i):
        return a[i] if (0 <= i < len(a) and is_finite_num(a[i])) else None

    if len(peaks) >= 2:
        p2, p1 = peaks[-1], peaks[-2]
        if last - p2 <= 8 and closes[p2] > closes[p1]:
            k2, k1, d2, d1 = _val(K, p2), _val(K, p1), _val(DIF, p2), _val(DIF, p1)
            kd_div = k2 is not None and k1 is not None and k2 < k1
            macd_div = d2 is not None and d1 is not None and d2 < d1
            if kd_div or macd_div:
                kind = 'KD+MACD' if (kd_div and macd_div) else ('KD' if kd_div else 'MACD')
                out.append({'side': 'bear', 'kind': kind, 'name': f'{kind}頂背離(動能衰竭,賣訊)'})
    if len(troughs) >= 2:
        t2, t1 = troughs[-1], troughs[-2]
        if last - t2 <= 8 and closes[t2] < closes[t1]:
            k2, k1, d2, d1 = _val(K, t2), _val(K, t1), _val(DIF, t2), _val(DIF, t1)
            kd_div = k2 is not None and k1 is not None and k2 > k1
            macd_div = d2 is not None and d1 is not None and d2 > d1
            if kd_div or macd_div:
                kind = 'KD+MACD' if (kd_div and macd_div) else ('KD' if kd_div else 'MACD')
                out.append({'side': 'bull', 'kind': kind, 'name': f'{kind}底背離(跌勢趨緩,買訊)'})
    return out


# ── 每日強弱(收盤過昨高/破昨低)第 2-2 章 ── port 自前端 chu_long_entry 內埋的 over_y ──
def bar_strength(bars):
    """每日最基本強弱(第 2-2 章):收盤過昨高=多方轉強;收盤破昨低=空方轉強;之間=區間震盪。
    回 {state:'strong'/'weak'/'range', ref_high, ref_low}。供選股/警報共用(原本只埋在 chu_long_entry 門檻)。"""
    if not bars or len(bars) < 2:
        return {'state': 'range', 'ref_high': None, 'ref_low': None}
    c, yh, yl = _c(bars[-1]), _h(bars[-2]), _l(bars[-2])
    state = 'strong' if c > yh else ('weak' if c < yl else 'range')
    return {'state': state, 'ref_high': round(yh, 2), 'ref_low': round(yl, 2)}


# ── 均線排列(月線穿季線黃金交叉 + 多空排列)第 1-9 章 ────────────────────────
def ma_alignment(closes):
    """均線排列(第 1-9 章)。月線(20MA)上穿季線(60MA)黃金交叉 → 可轉中長線佈局;
       5>10>20>60 完全多頭排列 = 強勢;反向 = 空頭排列。
       回 {golden_cross_2060, dead_cross_2060, bull_stack, bear_stack}。"""
    closes = _clean_closes(closes)
    n = len(closes)
    out = {'golden_cross_2060': False, 'dead_cross_2060': False,
           'bull_stack': False, 'bear_stack': False}
    if n < 61:
        return out
    ma5, ma10 = _ma_series(closes, 5), _ma_series(closes, 10)
    ma20, ma60 = _ma_series(closes, 20), _ma_series(closes, 60)
    out['golden_cross_2060'] = ma20[-2] < ma60[-2] and ma20[-1] >= ma60[-1]
    out['dead_cross_2060'] = ma20[-2] > ma60[-2] and ma20[-1] <= ma60[-1]
    out['bull_stack'] = ma5[-1] > ma10[-1] > ma20[-1] > ma60[-1]
    out['bear_stack'] = ma5[-1] < ma10[-1] < ma20[-1] < ma60[-1]
    return out


# ── 移動扣抵預測(未卜先知均線何時上彎)第 3-2 章 ──────────────────────────────
def ma_koudi_forecast(closes, period=20):
    """移動扣抵(第 3-2 章):不必等,先算 N 日均線未來會上彎還是下彎。
       原理:明日均線 = 今日均線 +(明日收盤 − 明日要扣掉的舊收盤)/N。以「現價」近似明日收盤:
       現價 > 扣抵值 → 均線上彎(反之下彎)。回:
       {deduct_value(明日扣抵值), will_turn_up, days_to_turn}。
       days_to_turn:以現價持平推估「幾天後」均線轉上彎(掃未來會被扣掉的舊收盤序列),None=近端不會轉。"""
    closes = _clean_closes(closes)
    n = len(closes)
    if n < period + 1:
        return {'deduct_value': None, 'will_turn_up': None, 'days_to_turn': None}
    cur = closes[-1]
    deduct = closes[-period]                       # 明日要扣掉的最舊那根收盤
    will_up = cur > deduct
    days = None                                    # 未來 period-1 天陸續扣掉 closes[-period..-2]
    for k, v in enumerate(closes[-period: -1], start=1):
        if cur > v:
            days = k
            break
    return {'deduct_value': round(deduct, 2), 'will_turn_up': will_up, 'days_to_turn': days}


# ── 二分之一價分界(大量長K的最強多空分水嶺)第 2-9 章 ────────────────────────
def half_price_signal(bars, lookback=20):
    """二分之一價(第 2-9 章):大量長K的 ½=(當根H+當根L)/2 是最強多空分界(當根平均成本)。
       高檔大量長紅之後,收盤「跌破」其 ½ → 多方轉弱/主力出貨確認(不可再回後買上漲);
       低檔大量長黑之後,收盤「站上」其 ½ → 套牢賣壓消化/止跌確認(可搶反彈)。
       取最近 lookback 根內、最近一根符合的大量長K。回 dict 或 None:
       {ref_idx, half, side:'bear'/'bull', broken, name}。大量=量≥前5日均量×1.5,長K=實體≥4%。"""
    if not bars or len(bars) < 8:
        return None
    n = len(bars)
    last = n - 1
    c = _c(bars[last])
    for j in range(last - 1, max(0, last - lookback) - 1, -1):
        vol = _v(bars[j])
        base = [_v(b) for b in bars[max(0, j - 5):j]]
        avg = sum(base) / len(base) if base else 0
        if avg <= 0 or vol < avg * 1.5:
            continue
        o, cl, hi, lo = _o(bars[j]), _c(bars[j]), _h(bars[j]), _l(bars[j])
        if o <= 0 or hi <= lo:
            continue
        body = (cl - o) / o * 100
        half = (hi + lo) / 2
        win = bars[max(0, j - 59): j + 1]
        whi = max(_h(b) for b in win)
        wlo = min(_l(b) for b in win)
        pos = (cl - wlo) / (whi - wlo) if whi > wlo else 0.5     # 0=低檔 1=高檔
        if body >= 4 and pos >= 0.7:                            # 高檔大量長紅
            broken = c < half
            return {'ref_idx': j, 'half': round(half, 2), 'side': 'bear', 'broken': broken,
                    'name': f'高檔大量長紅½={half:.2f}' + ('(已跌破→多方轉弱)' if broken else '(守住→多方仍強)')}
        if body <= -4 and pos <= 0.3:                           # 低檔大量長黑
            reclaim = c > half
            return {'ref_idx': j, 'half': round(half, 2), 'side': 'bull', 'broken': reclaim,
                    'name': f'低檔大量長黑½={half:.2f}' + ('(已站上→止跌確認)' if reclaim else '(壓著→賣壓未消)')}
    return None


# ── 單根變盤線(高/低檔轉折警訊)第 2-6、2-7 章 ──────────────────────────────
def reversal_candle(bars):
    """單根變盤線在高/低檔即為轉折警訊(第 2-6/2-7 章,次日確認)。
       高檔(近60日位階≥0.8):十字/紡錘/墓碑/倒錘/長上影 → 偏空變盤;
       低檔(位階≤0.3):十字/紡錘/T字/錘子/長下影 → 偏多變盤。
       變盤線 = 實體 ≤ 全距×0.3。回 dict 或 None:{side:'bear'/'bull', name, pos}。"""
    if not bars or len(bars) < 20:
        return None
    cur = bars[-1]
    o, c, h, l = _o(cur), _c(cur), _h(cur), _l(cur)
    if o <= 0 or h <= l:
        return None
    rng = h - l
    body = abs(c - o)
    up_sh = h - max(o, c)
    dn_sh = min(o, c) - l
    if body > rng * 0.3:                       # 實體太大 → 非變盤線
        return None
    win = bars[-60:]
    whi = max(_h(b) for b in win)
    wlo = min(_l(b) for b in win)
    pos = (c - wlo) / (whi - wlo) if whi > wlo else 0.5

    def _name():
        if body <= rng * 0.1:                  # 幾乎無實體 = 十字家族
            if up_sh >= rng * 0.6 and dn_sh < rng * 0.3:
                return '墓碑/倒T變盤'
            if dn_sh >= rng * 0.6 and up_sh < rng * 0.3:
                return '蜻蜓/T字變盤'
            return '十字變盤線'
        if up_sh >= body * 2 and dn_sh <= body:
            return '倒錘/長上影'
        if dn_sh >= body * 2 and up_sh <= body:
            return '錘子/長下影'
        return '紡錘變盤線'

    if pos >= 0.8:
        return {'side': 'bear', 'name': f'高檔{_name()}(轉折警訊,次日確認)', 'pos': round(pos, 2)}
    if pos <= 0.3:
        return {'side': 'bull', 'name': f'低檔{_name()}(轉折警訊,次日確認)', 'pos': round(pos, 2)}
    return None
