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
    if rise >= 100 or n_peaks >= 4:
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
        hi_prob = body >= 2 and vol_up and over_y and on_ma20
        if hi_prob and upside_room >= 10 and stage != 'end':
            return _mk('high', f'高勝率:回站5MA+紅K{body:.1f}%+量增+過昨高,上方空間{upside_room:.0f}%')
        # 空間不足或末升段 → 即使三條件齊也只給 weak(第 4 建議 gate)
        miss = []
        if body < 2: miss.append('紅K<2%')
        if not vol_up: miss.append('量未增')
        if not over_y: miss.append('未過昨高')
        if upside_room < 10: miss.append(f'上方空間僅{upside_room:.0f}%<10%')
        if stage == 'end': miss.append('末升段(漲幅過大)')
        return _mk('weak', '力道/空間偏弱:' + ('、'.join(miss) if miss else '待三條件齊'))
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
    n = len(bars)
    if entry_idx < 0 or entry_idx >= n - 1:
        return None
    closes = [_c(b) for b in bars]
    ma5 = _ma_series(closes, 5)
    entry = entry_px if (entry_px and entry_px > 0) else closes[entry_idx]
    if entry <= 0:
        return None
    hard_stop = min(_l(bars[entry_idx]), entry * 0.95)
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
        # 未鎖利前,固定停損仍有效
        if not locked and c <= hard_stop:
            return _exit(entry, c, i, entry_idx, '破固定停損(進場K低/-5%)')
    # 資料尾端仍持有 → 以最後收盤結算(未平倉)
    return _exit(entry, closes[-1], n - 1, entry_idx, '尚未出場(資料末端結算)')


def _exit(entry, exit_px, exit_idx, entry_idx, reason):
    return {'exit_idx': exit_idx, 'exit_px': round(exit_px, 2),
            'return_pct': round((exit_px - entry) / entry * 100, 2),
            'bars_held': exit_idx - entry_idx, 'reason': reason}


def backtest_chu_swing(bars, cost_pct=0.0):
    """回後買上漲進場 + 朱式出場 的逐根回測期望值。回 dict 或 None(交易<5筆/負期望值)。
    取代原本散在 radar_miner._chu_backtest 的內嵌邏輯,並改用 simulate_chu_exit(含動態移動停損)。"""
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
            ex = simulate_chu_exit(bars, i)
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
