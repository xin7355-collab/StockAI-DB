#!/usr/bin/env python3
"""📊 系統勝率回測機(Tier 4 擴充版)— 驗證系統到底準不準

擴充內容(2026-06-12 第二代):
1. 訊號 5 個 → 15 個(KD/爆量/創新高/跌破季線/5MA黃金/乖離/量縮/島狀反轉等)
2. 機構級指標:Sharpe / MDD / Profit Factor / Sortino + 原本勝率/平均報酬
3. 真實成本:手續費 0.1425%×2 + 證交稅 0.3% + 滑價 0.1% = 進出總損 ~0.685%
4. 多時間段:5 / 10 / 20 / 60 日報酬,看訊號最適合的持有期
5. 回放期間從 90 天 → 480 天(近 2 年)
6. 排除處置股(_skip_attention)+ 殭屍量(日均量 < 200 張)

輸出 data/signal_history.json 供前端「系統準度」卡讀取。
純運算、不打任何 API、絕不拋例外。
"""
import json
import math
from pathlib import Path
from datetime import datetime

DATA_DIR = Path("data")
OUTPUT_FILE = DATA_DIR / "signal_history.json"

REPLAY_DAYS = 480       # 回放最近 ~2 年交易日(2024-06 ~ 2026-06)
FWD_WINDOWS = (5, 10, 20, 60)   # 往後看幾日報酬(短中長線)
MIN_HISTORY = 70        # 至少要有幾天才能算 ma60 + 回放

# 💸 真實交易成本(進出總計約 0.685%,影響短線勝率甚鉅)
FEE_BUY  = 0.001425    # 證券手續費 0.1425%
FEE_SELL = 0.001425    # 手續費(賣)
TAX      = 0.003       # 證交稅 0.3%(賣方)
SLIPPAGE = 0.001       # 進出各 0.1% 滑價(實盤 vs 收盤價差)
ROUND_TRIP_COST_PCT = (FEE_BUY + FEE_SELL + TAX + SLIPPAGE * 2) * 100  # = ~0.685%

# 🚨 處置股名單(skip,因為分盤交易、無法在計算的「隔日開盤」進場)
def _load_attention_set():
    try:
        att = json.loads((DATA_DIR / "attention_status.json").read_text(encoding='utf-8'))
        return set(att.get('stocks', {}).keys())
    except Exception:
        return set()


# ═══════════════════════════════════════════════════════════════════
# 📐 通用指標計算
# ═══════════════════════════════════════════════════════════════════

def _ma(closes, idx, period):
    """closes[idx] 當日往回 period 日均線(含當日)。不足回 None。"""
    if idx + 1 < period:
        return None
    seg = closes[idx - period + 1: idx + 1]
    return sum(seg) / period if seg else None


def _inst_sum(row):
    return ((row.get('foreign_net') or row.get('foreign_inv') or 0)
            + (row.get('trust_net') or row.get('invest_trust') or 0)
            + (row.get('dealer_net') or row.get('dealer_inv') or 0))


def _stochastic_kd(rows, idx, period=9, k_smooth=3, d_smooth=3):
    """簡化 KD:RSV → K → D。回 (K, D, K_prev, D_prev) 或 None。"""
    if idx < period + k_smooth + d_smooth:
        return None
    def rsv(i):
        seg = rows[i - period + 1: i + 1]
        highs = [r.get('high', 0) for r in seg]
        lows  = [r.get('low',  0) for r in seg]
        c     = rows[i].get('close', 0)
        h, l = max(highs), min(lows)
        if h == l:
            return 50.0
        return (c - l) / (h - l) * 100
    # 計算近 N 期 RSV → K(SMA k_smooth)→ D(SMA d_smooth)
    rsvs = [rsv(i) for i in range(idx - k_smooth - d_smooth + 1, idx + 1)]
    if any(r is None for r in rsvs):
        return None
    ks = []
    for i in range(k_smooth - 1, len(rsvs)):
        ks.append(sum(rsvs[i - k_smooth + 1: i + 1]) / k_smooth)
    if len(ks) < d_smooth + 1:
        return None
    ds = []
    for i in range(d_smooth - 1, len(ks)):
        ds.append(sum(ks[i - d_smooth + 1: i + 1]) / d_smooth)
    if len(ds) < 2:
        return None
    return (ks[-1], ds[-1], ks[-2], ds[-2])


def _avg_volume_lots(rows, idx, period=5):
    """近 N 日平均成交「張數」(volume / 1000)。不足回 None。"""
    if idx + 1 < period:
        return None
    vols = [r.get('volume', 0) or 0 for r in rows[idx - period + 1: idx + 1]]
    return sum(vols) / period / 1000 if vols else None


# ═══════════════════════════════════════════════════════════════════
# 🎯 15 個訊號檢測函式(每個回 True/False,True = 該日訊號觸發)
# ═══════════════════════════════════════════════════════════════════

def sig_kd_golden_cross(rows, idx):
    """KD 黃金交叉:K 由下而上穿越 D,且 K < 55(剛底部反轉)"""
    kd = _stochastic_kd(rows, idx)
    if not kd: return False
    k, d, k0, d0 = kd
    return k0 < d0 and k > d and k < 55


def sig_kd_dead_cross(rows, idx):
    """KD 死亡交叉:K 由上而下穿越 D,且 K > 75(高檔轉折)"""
    kd = _stochastic_kd(rows, idx)
    if not kd: return False
    k, d, k0, d0 = kd
    return k0 > d0 and k < d and k > 75


def sig_volume_breakout(rows, idx):
    """爆量長紅:成交量 ≥ 5 日均量 1.5 倍 + 收紅 + 收盤站月線"""
    avg5 = _avg_volume_lots(rows, idx)
    if not avg5: return False
    v_lots = (rows[idx].get('volume', 0) or 0) / 1000
    c = rows[idx].get('close', 0)
    o = rows[idx].get('open', 0)
    closes = [r.get('close', 0) for r in rows]
    ma20 = _ma(closes, idx, 20)
    if not (ma20 and c > 0): return False
    return v_lots >= avg5 * 1.5 and c > o and c > ma20


def sig_new_high_60d(rows, idx):
    """創 60 日新高:收盤 ≥ 近 60 個交易日(不含當日)的最高"""
    if idx < 60: return False
    c = rows[idx].get('close', 0)
    highs = [r.get('high', 0) for r in rows[idx - 60: idx]]
    return c > 0 and highs and c >= max(highs)


def sig_break_prev_low(rows, idx):
    """跌破前 20 日低:收盤 < 近 20 個交易日(不含當日)的最低"""
    if idx < 20: return False
    c = rows[idx].get('close', 0)
    lows = [r.get('low', 0) for r in rows[idx - 20: idx] if r.get('low', 0) > 0]
    return c > 0 and lows and c < min(lows)


def sig_break_ma60(rows, idx):
    """跌破季線(60MA):收盤跌破 60MA 且前一日仍站上"""
    closes = [r.get('close', 0) for r in rows]
    ma60 = _ma(closes, idx, 60)
    ma60_prev = _ma(closes, idx - 1, 60)
    if not (ma60 and ma60_prev): return False
    c = closes[idx]
    c_prev = closes[idx - 1]
    return c < ma60 and c_prev >= ma60_prev


def sig_ma5_golden(rows, idx):
    """5MA 黃金交叉:前日 ≤ 5MA → 今日收盤 > 5MA + 5MA 上揚"""
    closes = [r.get('close', 0) for r in rows]
    ma5 = _ma(closes, idx, 5)
    ma5_prev = _ma(closes, idx - 1, 5)
    if not (ma5 and ma5_prev): return False
    return closes[idx] > ma5 and closes[idx - 1] <= ma5_prev and ma5 > ma5_prev


def sig_bias_overstretch(rows, idx):
    """乖離過大 +12%:可能追高風險"""
    closes = [r.get('close', 0) for r in rows]
    ma20 = _ma(closes, idx, 20)
    if not ma20 or ma20 <= 0: return False
    bias = (closes[idx] - ma20) / ma20 * 100
    return bias > 12


def sig_volume_dry(rows, idx):
    """量縮窒息:成交量 < 5 日均量 0.6 倍"""
    avg5 = _avg_volume_lots(rows, idx)
    if not avg5 or avg5 < 100: return False
    v_lots = (rows[idx].get('volume', 0) or 0) / 1000
    return v_lots < avg5 * 0.6


def sig_price_up_volume_div(rows, idx):
    """價漲量縮(背離):收紅但量縮 < 5 日均量 0.8 倍"""
    if idx < 5: return False
    c = rows[idx].get('close', 0)
    c_prev = rows[idx - 1].get('close', 0)
    avg5 = _avg_volume_lots(rows, idx)
    if not avg5: return False
    v_lots = (rows[idx].get('volume', 0) or 0) / 1000
    return c > c_prev and v_lots < avg5 * 0.8


def sig_big_black_k(rows, idx):
    """大黑K摜壓:收盤 < 開盤,實體 > 3.5% + 下影 < 20%"""
    c = rows[idx].get('close', 0)
    o = rows[idx].get('open', 0)
    h = rows[idx].get('high', 0)
    l = rows[idx].get('low', 0)
    if not (c > 0 and o > 0 and c < o): return False
    body_pct = (o - c) / c
    total_len = h - l
    if total_len <= 0: return False
    lower_shadow = c - l
    return body_pct > 0.035 and (lower_shadow / total_len) < 0.2


def sig_island_reversal(rows, idx):
    """島狀反轉:近 10 日內出現兩個跳空缺口(高位被孤立)。
    新鮮度守門(對齊前端 index.html):最新一根強漲 ≥5% 或已收復下跳空缺口 → 型態失效,不觸發。"""
    if idx < 10: return False
    # 最新一根相對前一根強漲(漲停/大漲 ≥5%)→ 明顯反彈,島狀頭部失效,不再算逃命訊號
    prev_c = rows[idx - 1].get('close', 0)
    if prev_c > 0 and (rows[idx].get('close', 0) - prev_c) / prev_c >= 0.05:
        return False
    cur_c = rows[idx].get('close', 0)
    # 簡化:近 10 日內找 (j) 跳空向下 + 之前更早 (k) 跳空向上 + j-k 之間是高位區
    for j in range(idx, max(idx - 10, 1), -1):
        if rows[j].get('high', 0) < rows[j - 1].get('low', 0):
            gap_top = rows[j - 1].get('low', 0)  # 下跳空缺口上緣:收復此價=缺口被填、型態失效
            if cur_c > gap_top:                  # 已收復缺口 → 略過此 j,不算島狀
                continue
            for k in range(j - 1, max(j - 10, 0), -1):
                if rows[k].get('low', 0) > rows[k - 1].get('high', 0) and rows[j].get('high', 0) < rows[k].get('low', 0):
                    return True
    return False


def sig_inst_buy_streak3(rows, idx):
    """法人連 3 日買超(籌碼面正向 — 不一定多頭排列,純看法人動向)"""
    if idx < 3: return False
    return all(_inst_sum(rows[idx - i]) > 0 for i in range(3))


def sig_inst_sell_streak3(rows, idx):
    """法人連 3 日賣超(籌碼面負向警示)"""
    if idx < 3: return False
    return all(_inst_sum(rows[idx - i]) < 0 for i in range(3))


def sig_ma_bullish_alignment(rows, idx):
    """多頭排列:5MA > 20MA > 60MA(三線完美多頭)"""
    closes = [r.get('close', 0) for r in rows]
    ma5 = _ma(closes, idx, 5)
    ma20 = _ma(closes, idx, 20)
    ma60 = _ma(closes, idx, 60)
    if not (ma5 and ma20 and ma60): return False
    return ma5 > ma20 > ma60


SIGNALS = {
    '🌅 KD黃金交叉':   sig_kd_golden_cross,
    '🌇 KD死亡交叉':   sig_kd_dead_cross,
    '🚀 爆量長紅':     sig_volume_breakout,
    '🏔️ 創60日新高':   sig_new_high_60d,
    '⛏️ 跌破前20日低': sig_break_prev_low,
    '📉 跌破季線60MA': sig_break_ma60,
    '✨ 5MA黃金交叉':  sig_ma5_golden,
    '🌡️ 乖離過大+12%': sig_bias_overstretch,
    '😴 量縮窒息':     sig_volume_dry,
    '⚠️ 價漲量縮背離': sig_price_up_volume_div,
    '💀 大黑K摜壓':    sig_big_black_k,
    '🌋 島狀反轉':     sig_island_reversal,
    '🟢 法人連3日買':  sig_inst_buy_streak3,
    '🔴 法人連3日賣':  sig_inst_sell_streak3,
    '📈 多頭排列':     sig_ma_bullish_alignment,
}


# ═══════════════════════════════════════════════════════════════════
# 📊 機構級績效指標(Sharpe / MDD / Profit Factor / Sortino)
# ═══════════════════════════════════════════════════════════════════

def apply_real_cost(ret_pct):
    """扣掉真實成本(手續費 + 證交稅 + 滑價),回淨報酬 %"""
    return ret_pct - ROUND_TRIP_COST_PCT


def calc_advanced_metrics(returns):
    """returns 是 list[float] 淨報酬(已扣成本)。
    回傳 dict 含:samples / win_rate / avg_return / std / sharpe / mdd /
                 profit_factor / sortino / median
    """
    if not returns:
        return None
    n = len(returns)
    wins = [r for r in returns if r > 0]
    losses = [r for r in returns if r < 0]
    avg = sum(returns) / n
    median = sorted(returns)[n // 2]
    # 標準差
    var = sum((r - avg) ** 2 for r in returns) / n
    std = math.sqrt(var)
    # Sharpe(年化,近似:假設 252 交易日,每筆是 N 日報酬,簡化用 sqrt(252/N))
    # 這裡只用「平均 / 標準差」當 Sharpe 近似(每筆持有期固定),非嚴格年化
    sharpe = (avg / std) if std > 0 else 0
    # Sortino(只計算負報酬的標準差)
    neg_var = sum(r ** 2 for r in losses) / n if losses else 0
    neg_std = math.sqrt(neg_var)
    sortino = (avg / neg_std) if neg_std > 0 else 0
    # Profit Factor:總獲利 / 總虧損(絕對值)
    total_win = sum(wins)
    total_loss = abs(sum(losses))
    pf = (total_win / total_loss) if total_loss > 0 else float('inf')
    # 最大回撤 MDD(把報酬序列當資金曲線)
    cumulative = []
    cum = 1.0
    for r in returns:
        cum *= (1 + r / 100)
        cumulative.append(cum)
    peak = cumulative[0]
    mdd = 0
    for v in cumulative:
        if v > peak:
            peak = v
        dd = (peak - v) / peak * 100
        if dd > mdd:
            mdd = dd
    return {
        'samples': n,
        'win_rate': round(len(wins) / n * 100, 1),
        'avg_return': round(avg, 2),
        'median_return': round(median, 2),
        'std': round(std, 2),
        'sharpe': round(sharpe, 2),
        'sortino': round(sortino, 2),
        'profit_factor': round(pf, 2) if pf != float('inf') else None,
        'mdd_pct': round(mdd, 2),
        'best': round(max(returns), 2),
        'worst': round(min(returns), 2),
    }


# ═══════════════════════════════════════════════════════════════════
# 🔁 原版 — 保留向下相容(送分題/偏多 + 獵鷹)
# ═══════════════════════════════════════════════════════════════════

def classify_signal_legacy(rows, idx):
    """複刻前端綠燈核心:回 '🟢送分題' / '🟡偏多' / None"""
    closes = [r.get('close', 0) for r in rows]
    c = closes[idx]
    if c <= 0: return None
    ma5 = _ma(closes, idx, 5)
    ma20 = _ma(closes, idx, 20)
    ma60 = _ma(closes, idx, 60)
    if ma5 is None or ma20 is None: return None
    if c < ma20: return None
    ma_bullish = (ma5 > ma20) and (ma60 is None or ma20 > ma60)
    streak = 0
    for j in range(idx, max(idx - 10, -1), -1):
        if _inst_sum(rows[j]) > 0: streak += 1
        else: break
    look = rows[max(0, idx - 9): idx + 1]
    inst_days = sum(1 for r in look if _inst_sum(r) > 0)
    inst_support = streak >= 3 or inst_days >= 6
    if ma_bullish and inst_support: return '🟢送分題'
    if ma_bullish: return '🟡偏多'
    return None


def _falcon_score_simplified(rows, idx):
    """🦅 簡化版獵鷹建倉分(回測用)"""
    if idx < 22: return None
    closes = [r.get('close') for r in rows[:idx + 1] if r.get('close')]
    if len(closes) < 22: return None
    c = closes[-1]
    def ma(n):
        return sum(closes[-n:]) / n if len(closes) >= n else None
    ma5, ma20, ma60 = ma(5), ma(20), ma(60)
    base = 50
    if ma20:
        if c > ma20: base += 10
        else: base -= 15
        bias20 = (c - ma20) / ma20 * 100
        if 0 <= bias20 <= 8: base += 5
        elif bias20 > 15: base -= 10
    if ma5 and ma20 and ma60 and ma5 > ma20 > ma60: base += 10
    if ma60 and c > ma60: base += 5
    vols = [r.get('volume', 0) or 0 for r in rows[max(0, idx - 4):idx + 1]]
    if vols:
        avg_lots = sum(vols) / len(vols) / 1000
        if avg_lots < 200: base -= 30
        elif avg_lots < 500: base -= 10
        elif avg_lots > 50000: base += 5
    return max(0, min(100, round(base)))


# ═══════════════════════════════════════════════════════════════════
# 🔬 回測單檔
# ═══════════════════════════════════════════════════════════════════

def _classify_tier(rows):
    """🏷️ F 路徑:依近 60 日平均成交張數分類股票池(代理市值,不需另外抓基本資料)
    - large(大型股):日均量 ≥ 50000 張(權值股 / 中型龍頭)
    - mid(中型股):10000-50000 張
    - small(小型股):200-10000 張
    - zombie:< 200 張(已在主流程 skip)
    """
    n = len(rows)
    if n < 60: return 'small'
    avg60_lots = _avg_volume_lots(rows, n - 1, period=60)
    if avg60_lots is None: return 'small'
    if avg60_lots >= 50000: return 'large'
    if avg60_lots >= 10000: return 'mid'
    return 'small'


def backtest_one_extended(rows, sym, attention_set):
    """對單檔做擴充回測,跑所有 SIGNALS + 多時間段 + 真實成本。
    回傳 dict: signal_name -> list of {'window': N, 'gross': ret%, 'net': ret%}
    """
    out = {name: [] for name in SIGNALS}
    n = len(rows)
    if n < MIN_HISTORY: return out
    # 殭屍量過濾(整檔近 60 日均量 < 200 張就完全 skip)
    avg60_lots = _avg_volume_lots(rows, n - 1, period=60)
    if avg60_lots is not None and avg60_lots < 200:
        return out
    # 處置股 skip(分盤交易,「隔日開盤進場」不準確)
    if sym in attention_set:
        return out

    max_fwd = max(FWD_WINDOWS)
    end = n - 1 - max_fwd
    start = max(MIN_HISTORY - 1, end - REPLAY_DAYS)
    closes = [r.get('close', 0) for r in rows]

    for idx in range(start, end + 1):
        base = closes[idx]
        if base <= 0: continue
        for name, fn in SIGNALS.items():
            try:
                if not fn(rows, idx): continue
            except Exception:
                continue
            for w in FWD_WINDOWS:
                fc = closes[idx + w]
                if fc <= 0: continue
                gross = (fc - base) / base * 100
                net = apply_real_cost(gross)
                out[name].append({'window': w, 'gross': gross, 'net': net})
    return out


def backtest_legacy(rows):
    """原版 backtest_one(送分題/偏多)— 保留向下相容"""
    out = []
    n = len(rows)
    if n < MIN_HISTORY: return out
    max_fwd = max(FWD_WINDOWS)
    end = n - 1 - max_fwd
    start = max(MIN_HISTORY - 1, end - REPLAY_DAYS)
    closes = [r.get('close', 0) for r in rows]
    for idx in range(start, end + 1):
        sig = classify_signal_legacy(rows, idx)
        if not sig: continue
        base = closes[idx]
        if base <= 0: continue
        rets = {}
        for w in (5, 10):
            fc = closes[idx + w]
            rets[w] = (fc - base) / base * 100 if fc > 0 else None
        out.append((sig, rets.get(5), rets.get(10)))
    return out


def backtest_falcon(rows):
    """🦅 獵鷹回測"""
    results = []
    n = len(rows)
    for i in range(22, n - 1):
        score = _falcon_score_simplified(rows, i)
        if score is None: continue
        c_today = rows[i].get('close')
        c_next = rows[i + 1].get('close')
        if not (c_today and c_next and c_today > 0): continue
        ret = (c_next - c_today) / c_today * 100
        if score >= 75: bucket = 'falcon75'
        elif score >= 60: bucket = 'falcon60'
        elif score >= 45: bucket = 'falcon45'
        else: continue
        results.append((bucket, ret))
    return results


# ═══════════════════════════════════════════════════════════════════
# 🏆 Day 2 路徑 B:整套系統策略組合回測 — 模擬「跟著系統交易」vs 0050
# ═══════════════════════════════════════════════════════════════════

STRATEGY_TAKE_PROFIT_PCT = 20.0   # 漲幅 20% 停利
STRATEGY_HARD_STOP_PCT   = -8.0   # 跌幅 -8% 硬停損
STRATEGY_MAX_HOLD_DAYS   = 30     # 持有 30 個交易日時間止損
STRATEGY_MIN_FALCON      = 85     # 🔧 進場獵鷹分門檻(原 75,調 85 過濾雜訊)


def simulate_strategy(rows, sym, attention_set):
    """模擬「跟著系統訊號交易」單檔策略回測。
    🔧 第二代規則(收緊進場 + 拉緊防守線):
    進場條件(全部 AND):
      1. 獵鷹分 ≥ 85(原 75)
      2. 多頭排列(MA5 > MA20 > MA60)
      3. 站上 5MA(c > MA5)— 新增
      4. 5MA 上揚(MA5 > MA5_prev)— 新增
    出場條件(任一):
      1. 收盤跌破 5MA(原 20MA,拉緊防守)
      2. 漲幅 ≥ +20%(停利)
      3. 跌幅 ≤ -8%(硬停損)
      4. 持有 30 個交易日(時間止損)
    """
    trades = []
    n = len(rows)
    if n < MIN_HISTORY: return trades
    avg60_lots = _avg_volume_lots(rows, n - 1, period=60)
    if avg60_lots is not None and avg60_lots < 200: return trades
    if sym in attention_set: return trades

    closes = [r.get('close', 0) for r in rows]
    in_position = False
    entry_idx = None
    entry_price = None

    for idx in range(MIN_HISTORY, n - 1):
        c = closes[idx]
        if c <= 0: continue
        if not in_position:
            # 🔧 進場條件(收緊):獵鷹 ≥85 + 多頭排列 + 站上 5MA + 5MA 上揚
            try:
                score = _falcon_score_simplified(rows, idx)
                if score is None or score < STRATEGY_MIN_FALCON: continue
                if not sig_ma_bullish_alignment(rows, idx): continue
                ma5 = _ma(closes, idx, 5)
                ma5_prev = _ma(closes, idx - 1, 5)
                if not (ma5 and ma5_prev): continue
                if c <= ma5: continue          # 必須收盤站上 5MA
                if ma5 <= ma5_prev: continue   # 5MA 必須上揚
            except Exception:
                continue
            # 進場:用隔日收盤近似隔日開盤(簡化)
            if idx + 1 >= n: continue
            entry_price = closes[idx + 1]
            if entry_price <= 0: continue
            entry_idx = idx + 1
            in_position = True
        else:
            # 持倉中:檢查出場條件(🔧 防守線從 20MA → 5MA,拉緊)
            hold_days = idx - entry_idx
            ret_pct = (c - entry_price) / entry_price * 100
            ma5 = _ma(closes, idx, 5)
            exit_reason = None
            if ma5 is not None and c < ma5:
                exit_reason = 'stop_loss_ma5'
            elif ret_pct >= STRATEGY_TAKE_PROFIT_PCT:
                exit_reason = 'take_profit_20pct'
            elif ret_pct <= STRATEGY_HARD_STOP_PCT:
                exit_reason = 'hard_stop_8pct'
            elif hold_days >= STRATEGY_MAX_HOLD_DAYS:
                exit_reason = 'time_stop_30d'
            if exit_reason:
                # 平倉:扣真實成本
                gross = ret_pct
                net = apply_real_cost(gross)
                trades.append({
                    'symbol': sym,
                    'entry_date': rows[entry_idx].get('date', ''),
                    'exit_date': rows[idx].get('date', ''),
                    'entry_price': round(entry_price, 2),
                    'exit_price': round(c, 2),
                    'gross_return': round(gross, 2),
                    'net_return': round(net, 2),
                    'exit_reason': exit_reason,
                    'holding_days': hold_days,
                })
                in_position = False
                entry_idx = None
                entry_price = None

    # 結束未平倉的單也補一筆(簡化:強制最後一天收盤平倉)
    if in_position and entry_idx is not None and entry_idx < n:
        c = closes[n - 1]
        if c > 0 and entry_price > 0:
            gross = (c - entry_price) / entry_price * 100
            net = apply_real_cost(gross)
            trades.append({
                'symbol': sym,
                'entry_date': rows[entry_idx].get('date', ''),
                'exit_date': rows[n - 1].get('date', ''),
                'entry_price': round(entry_price, 2),
                'exit_price': round(c, 2),
                'gross_return': round(gross, 2),
                'net_return': round(net, 2),
                'exit_reason': 'period_end',
                'holding_days': n - 1 - entry_idx,
            })
    return trades


def benchmark_0050():
    """讀 data/0050.json 算 buy-and-hold 累計報酬,作為策略 vs 大盤的對標。
    若無 0050 則 fallback 用 ^TWII.json(加權指數)。
    回傳 dict {first_date, last_date, total_days, cumulative_return, annualized_return, mdd, equity_curve}
    """
    for fname in ('0050.json', '^TWII.json'):
        f = DATA_DIR / fname
        if not f.exists(): continue
        try:
            rows = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(rows, list) or len(rows) < 30: continue
            closes = [(r.get('date', ''), r.get('close', 0)) for r in rows if r.get('close', 0) > 0]
            if len(closes) < 30: continue
            first_date, first_close = closes[0]
            last_date, last_close = closes[-1]
            cum_ret = (last_close - first_close) / first_close * 100
            total_days = len(closes)
            # 年化(252 交易日 = 1 年)
            ann_ret = ((last_close / first_close) ** (252 / total_days) - 1) * 100
            # MDD
            peak = closes[0][1]
            mdd = 0
            for _, c in closes:
                if c > peak: peak = c
                dd = (peak - c) / peak * 100
                if dd > mdd: mdd = dd
            # equity curve(每 5 個交易日採 1 點省空間)
            equity = []
            for i in range(0, len(closes), max(1, len(closes) // 100)):
                d, c = closes[i]
                equity.append({'date': d, 'equity': round((c / first_close - 1) * 100, 2)})
            if closes[-1] not in [(e['date'], None) for e in equity]:
                equity.append({'date': last_date, 'equity': round(cum_ret, 2)})
            return {
                'benchmark': fname.replace('.json', ''),
                'first_date': first_date,
                'last_date': last_date,
                'total_days': total_days,
                'cumulative_return': round(cum_ret, 2),
                'annualized_return': round(ann_ret, 2),
                'mdd': round(mdd, 2),
                'equity_curve': equity,
            }
        except Exception:
            continue
    return None


def backtest_full_strategy():
    """跑全市場「整套系統策略」回測,聚合所有 trade,算策略指標 + equity curve。
    回傳 dict 含 strategy / benchmark / alpha / exit_reasons / sample_trades(前 20 筆)。
    """
    attention_set = _load_attention_set()
    all_trades = []
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue
        try:
            rows = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(rows, list): continue
            trades = simulate_strategy(rows, sym, attention_set)
            all_trades.extend(trades)
        except Exception:
            continue

    if not all_trades:
        return {'strategy': None, 'benchmark': None, 'alpha': None, 'note': '無交易訊號觸發,可能歷史不足或全市場無 ≥85 獵鷹分'}

    # 出場原因統計
    exit_reasons = {}
    for t in all_trades:
        exit_reasons[t['exit_reason']] = exit_reasons.get(t['exit_reason'], 0) + 1

    # 策略指標(用淨報酬)
    net_returns = [t['net_return'] for t in all_trades]
    metrics = calc_advanced_metrics(net_returns)
    # 平均持有期
    avg_hold = sum(t['holding_days'] for t in all_trades) / len(all_trades)

    # 🔧 第二代累計權益曲線:「按交易日聚合」(模擬真實組合 — 同日所有平倉的 trade 取平均淨報酬,日度連乘)
    # 原版用「全部 trade 連續連乘」造成 12000 筆中只要一筆 -90% 就歸零的問題
    # 新版:同一天平倉的 N 筆 trade → 該日報酬 = mean(N 筆) → 日度連乘 → 模擬「等權重 N 個位置同時持有」
    trades_by_exit_date = {}
    for t in all_trades:
        d = t['exit_date']
        trades_by_exit_date.setdefault(d, []).append(t['net_return'])
    sorted_exit_dates = sorted(trades_by_exit_date.keys())
    cum = 1.0
    equity_curve = []
    sample_step = max(1, len(sorted_exit_dates) // 100)
    for i, d in enumerate(sorted_exit_dates):
        daily_returns = trades_by_exit_date[d]
        daily_avg = sum(daily_returns) / len(daily_returns)
        cum *= (1 + daily_avg / 100)
        if cum < 0.01:   # 避免歸零(現實中組合不會被某 1 天打趴)
            cum = 0.01
        if i % sample_step == 0 or i == len(sorted_exit_dates) - 1:
            equity_curve.append({'date': d, 'equity': round((cum - 1) * 100, 2)})

    cumulative_return = round((cum - 1) * 100, 2)
    # 年化:用第一筆 entry 到最後一筆 exit 的天數估
    try:
        from datetime import datetime as _dt
        first_entry = min(t['entry_date'] for t in all_trades).replace('/', '-')
        last_exit = max(t['exit_date'] for t in all_trades).replace('/', '-')
        d0 = _dt.strptime(first_entry, '%Y-%m-%d')
        d1 = _dt.strptime(last_exit, '%Y-%m-%d')
        calendar_days = max(1, (d1 - d0).days)
        years = calendar_days / 365.25
        annualized_return = ((cum) ** (1 / max(years, 0.1)) - 1) * 100 if cum > 0 else -99
    except Exception:
        annualized_return = None

    bench = benchmark_0050()
    alpha = None
    if bench and annualized_return is not None and bench.get('annualized_return') is not None:
        alpha = round(annualized_return - bench['annualized_return'], 2)

    sorted_trades = sorted(all_trades, key=lambda x: x['exit_date'])
    return {
        'strategy': {
            'total_trades': len(all_trades),
            'win_rate': metrics['win_rate'],
            'avg_return': metrics['avg_return'],
            'median_return': metrics['median_return'],
            'sharpe': metrics['sharpe'],
            'sortino': metrics['sortino'],
            'profit_factor': metrics['profit_factor'],
            'mdd_pct': metrics['mdd_pct'],
            'best': metrics['best'],
            'worst': metrics['worst'],
            'avg_holding_days': round(avg_hold, 1),
            'cumulative_return': cumulative_return,
            'annualized_return': round(annualized_return, 2) if annualized_return is not None else None,
            'equity_curve': equity_curve,
        },
        'benchmark': bench,
        'alpha': alpha,
        'exit_reasons': exit_reasons,
        'sample_trades': sorted_trades[:20],
        'entry_rule': f'獵鷹分≥{STRATEGY_MIN_FALCON} + 多頭排列 + 站上5MA + 5MA上揚',
        'exit_rules': f'跌破5MA / +{STRATEGY_TAKE_PROFIT_PCT}% 停利 / {STRATEGY_HARD_STOP_PCT}% 硬停損 / {STRATEGY_MAX_HOLD_DAYS}日時間止損',
        'cost_pct': round(ROUND_TRIP_COST_PCT, 3),
    }


# ═══════════════════════════════════════════════════════════════════
# 🚀 main():聚合 + 輸出
# ═══════════════════════════════════════════════════════════════════

def main():
    print(f"📊 擴充版回測啟動 — REPLAY {REPLAY_DAYS} 日 / FWD {FWD_WINDOWS} / 真實成本 {ROUND_TRIP_COST_PCT:.3f}%")
    DATA_DIR.mkdir(exist_ok=True)
    attention_set = _load_attention_set()
    print(f"   排除處置股:{len(attention_set)} 檔")

    # 擴充版聚合:signal_name -> window -> {'gross_list':, 'net_list':}
    extended_agg = {name: {w: {'gross': [], 'net': []} for w in FWD_WINDOWS}
                    for name in SIGNALS}
    # 🏷️ F 路徑:額外按股池分群(large/mid/small)聚合,看哪個池子有 edge
    tier_agg = {tier: {name: {w: {'gross': [], 'net': []} for w in FWD_WINDOWS}
                       for name in SIGNALS}
                for tier in ('large', 'mid', 'small')}
    tier_stocks = {'large': 0, 'mid': 0, 'small': 0}
    # 原版(送分題/偏多)
    legacy_agg = {}
    def _legacy_slot(sig):
        return legacy_agg.setdefault(sig, {'n': 0, 'win5': 0, 'win10': 0,
                                           'sum5': 0.0, 'sum10': 0.0, 'c5': 0, 'c10': 0})
    # 獵鷹
    falcon_agg = {}

    scanned = 0
    skipped_zombie = 0
    skipped_attention = 0

    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue
        try:
            rows = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(rows, list): continue

            # 🏷️ 分群(F):依平均量分入 large/mid/small,後面聚合一份
            tier = _classify_tier(rows)
            tier_stocks[tier] = tier_stocks.get(tier, 0) + 1

            # 擴充版回測(15 訊號 × 4 時間段)
            ext = backtest_one_extended(rows, sym, attention_set)
            # 若全部 signal 都空 + 至少有 80 天資料 → 大概率是被殭屍量/處置股 skip
            if all(not v for v in ext.values()):
                if sym in attention_set:
                    skipped_attention += 1
                else:
                    avg60 = _avg_volume_lots(rows, len(rows) - 1, period=60)
                    if avg60 is not None and avg60 < 200:
                        skipped_zombie += 1
            for name, samples in ext.items():
                for s in samples:
                    extended_agg[name][s['window']]['gross'].append(s['gross'])
                    extended_agg[name][s['window']]['net'].append(s['net'])
                    # 🏷️ 同步丟進 tier_agg
                    tier_agg[tier][name][s['window']]['gross'].append(s['gross'])
                    tier_agg[tier][name][s['window']]['net'].append(s['net'])

            # 原版(送分題/偏多)— 保留向下相容
            for sig, r5, r10 in backtest_legacy(rows):
                s = _legacy_slot(sig)
                s['n'] += 1
                if r5 is not None:
                    s['c5'] += 1; s['sum5'] += r5
                    if r5 > 0: s['win5'] += 1
                if r10 is not None:
                    s['c10'] += 1; s['sum10'] += r10
                    if r10 > 0: s['win10'] += 1

            # 獵鷹
            for bucket, ret in backtest_falcon(rows):
                fs = falcon_agg.setdefault(bucket, {'n': 0, 'wins': 0, 'sum_ret': 0.0})
                fs['n'] += 1
                fs['sum_ret'] += ret
                if ret > 0: fs['wins'] += 1
            scanned += 1
        except Exception:
            continue

    # 🎯 擴充版輸出:每訊號 × 4 時間段 × 機構級指標
    by_signal_extended = {}
    for name, by_w in extended_agg.items():
        per_window = {}
        for w, lists in by_w.items():
            if not lists['gross']: continue
            per_window[f'{w}d'] = {
                'gross': calc_advanced_metrics(lists['gross']),
                'net':   calc_advanced_metrics(lists['net']),
            }
        if per_window:
            by_signal_extended[name] = per_window

    # 🔄 原版輸出(維持向下相容)
    by_signal_legacy = {}
    for sig, s in legacy_agg.items():
        if s['n'] == 0: continue
        by_signal_legacy[sig] = {
            'samples': s['n'],
            'win_rate_5d': round(s['win5'] / s['c5'] * 100, 1) if s['c5'] else None,
            'win_rate_10d': round(s['win10'] / s['c10'] * 100, 1) if s['c10'] else None,
            'avg_return_5d': round(s['sum5'] / s['c5'], 2) if s['c5'] else None,
            'avg_return_10d': round(s['sum10'] / s['c10'], 2) if s['c10'] else None,
        }

    # 🦅 獵鷹
    falcon_strategy = {}
    for bucket, fs in falcon_agg.items():
        if fs['n'] == 0: continue
        falcon_strategy[bucket] = {
            'samples': fs['n'],
            'win_rate': round(fs['wins'] / fs['n'] * 100, 1),
            'avg_return': round(fs['sum_ret'] / fs['n'], 2),
        }

    # 🏷️ F 路徑:股池分群輸出(large/mid/small)— 看哪個池子在哪個訊號上有 edge
    #    例:某訊號在小型股勝率 65% 但大型股只有 48% → 證據顯示應該專用在小型股
    by_signal_by_tier = {}
    for tier, by_name in tier_agg.items():
        tier_out = {}
        for name, by_w in by_name.items():
            per_window = {}
            for w, lists in by_w.items():
                if not lists['net']: continue
                per_window[f'{w}d'] = {
                    'net': calc_advanced_metrics(lists['net']),
                }
            if per_window:
                tier_out[name] = per_window
        by_signal_by_tier[tier] = tier_out

    payload = {
        'updated': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'replay_days': REPLAY_DAYS,
        'scanned_stocks': scanned,
        'skipped_zombie': skipped_zombie,
        'skipped_attention': skipped_attention,
        'fwd_windows': list(FWD_WINDOWS),
        'round_trip_cost_pct': round(ROUND_TRIP_COST_PCT, 3),
        'by_signal': by_signal_legacy,   # 向下相容
        'by_signal_extended': by_signal_extended,   # 🎯 新版:15 訊號 × 4 期間 × 機構級指標
        'by_signal_by_tier': by_signal_by_tier,   # 🏷️ F:股池分群(大/中/小)各訊號勝率
        'tier_stocks': tier_stocks,   # 各 tier 掃到幾檔
        'falcon_strategy': falcon_strategy,
        '_note': '擴充版回測:15 訊號 × 4 時間段 × Sharpe/MDD/Profit Factor + 股池分群。淨報酬已扣手續費+證交稅+滑價。過去績效不代表未來。',
    }

    # 🖨️ 列印 Top 5 訊號(以 10 日淨報酬勝率排序)
    print(f"\n📊 擴充版 15 訊號回測結果(以 10 日淨報酬勝率排序):")
    rankable = []
    for name, by_w in by_signal_extended.items():
        if '10d' in by_w and by_w['10d']['net']:
            net = by_w['10d']['net']
            rankable.append((name, net['win_rate'], net['avg_return'], net['samples'], net.get('sharpe', 0)))
    rankable.sort(key=lambda x: x[1], reverse=True)
    for name, wr, avg, n, sharpe in rankable:
        print(f"   {name:18s}: 10日淨勝率 {wr:5.1f}% / 平均 {avg:+.2f}% / Sharpe {sharpe:+.2f} / 樣本 {n}")

    print(f"\n🦅 獵鷹回測結果:")
    for bucket, st in falcon_strategy.items():
        print(f"   {bucket}: {st['samples']} 樣本, 隔日勝率 {st['win_rate']}%, 平均 {st['avg_return']}%")

    # 🏷️ F:股池分群 10 日淨勝率 Top 3 訊號(每池)
    print(f"\n🏷️ 股池分群結果(大 {tier_stocks['large']} / 中 {tier_stocks['mid']} / 小 {tier_stocks['small']}):")
    for tier in ('large', 'mid', 'small'):
        tier_rank = []
        for name, by_w in by_signal_by_tier.get(tier, {}).items():
            if '10d' in by_w and by_w['10d'].get('net'):
                n10 = by_w['10d']['net']
                tier_rank.append((name, n10['win_rate'], n10['avg_return'], n10['samples']))
        tier_rank.sort(key=lambda x: x[1], reverse=True)
        top3 = tier_rank[:3]
        if top3:
            label = {'large': '大型股', 'mid': '中型股', 'small': '小型股'}[tier]
            print(f"   {label} Top3:")
            for name, wr, avg, n in top3:
                print(f"     {name:18s} 10日勝率 {wr:5.1f}% / 平均 {avg:+.2f}% / 樣本 {n}")

    OUTPUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"\n✅ 回測完成 — 掃 {scanned} 檔(排除殭屍量 {skipped_zombie} / 處置股 {skipped_attention}) → {OUTPUT_FILE}")

    # 🏆 Day 2 路徑 B:整套系統策略組合回測(獵鷹 ≥75 進場 + 4 種出場 vs 0050)
    print("\n🏆 開始 Day 2 B 整套策略回測...")
    try:
        strategy_result = backtest_full_strategy()
        STRATEGY_FILE = DATA_DIR / "strategy_backtest.json"
        strategy_payload = {
            'updated': datetime.now().strftime('%Y-%m-%d %H:%M'),
            **strategy_result,
        }
        STRATEGY_FILE.write_text(json.dumps(strategy_payload, ensure_ascii=False, indent=2), encoding='utf-8')
        s = strategy_result.get('strategy') or {}
        b = strategy_result.get('benchmark') or {}
        print(f"   策略:{s.get('total_trades', 0)} 筆 / 勝率 {s.get('win_rate', '?')}% / 累計 {s.get('cumulative_return', '?')}% / 年化 {s.get('annualized_return', '?')}% / MDD {s.get('mdd_pct', '?')}%")
        print(f"   {b.get('benchmark', '?')} buy-and-hold:累計 {b.get('cumulative_return', '?')}% / 年化 {b.get('annualized_return', '?')}% / MDD {b.get('mdd', '?')}%")
        print(f"   🎯 Alpha(策略年化 - {b.get('benchmark', '?')} 年化):{strategy_result.get('alpha', '?')}%")
        print(f"   ✅ 寫入 → {STRATEGY_FILE}")
    except Exception as e:
        print(f"   ⚠️ 策略回測失敗(不影響其他):{e}")


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"💥 backtest 頂層例外(不影響其他):{e}")
