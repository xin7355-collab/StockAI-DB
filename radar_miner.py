"""
radar_miner.py — 首席 AI 司令部：三大戰略雷達矩陣引擎
特色：極低記憶體消耗、無 Pandas 依賴、逐檔串流掃描全台股
輸出：data/radar_matrix.json

⚠️ 注意：
  - 🏎️ 渣男賽車 / 🐢 烏龜過河 掃描全市場 data/*.json（約 2000 檔）。
  - 🎯 狙擊手 依賴分點籌碼 data/chips/*.json，而 chips 只對 CHIP_WATCHLIST
    （約 50 檔熱門股）產出，故狙擊手實際只會掃到監控清單內的標的，屬正常設計限制。
"""
import os
import json
import math
import requests
from pathlib import Path

from common import is_finite_num   # 🧩 共用工具:NaN/±Inf 防呆的單一真相來源(見 common.py)
from strategy_sim import (chu_long_entry, chu_eliminate,   # 🎯 回後買上漲(旗艦)+ 淘汰13條
                          granville, box_breakout, divergence, volume_signals,   # 建議2:葛蘭碧/橫盤突破/背離/量能 全市場 port
                          reversal_candle, half_price_signal)   # 第2-6/2-7章單根變盤線 + 2-9章½價多空分界
from datetime import date, datetime

DATA_DIR = Path("data")
CHIPS_DIR = DATA_DIR / "chips"
OUTPUT_FILE = DATA_DIR / "radar_matrix.json"
ATTENTION_FILE = DATA_DIR / "attention_status.json"

# 1 億 = 10^8（成交額顯示單位）
YI = 100_000_000


def calculate_ma(data, period):
    """計算簡單移動平均線 (MA)"""
    if len(data) < period:
        return 0
    return sum(d['close'] for d in data[-period:]) / period


# ────────────────────────────────────────────────────────────
# 📚 朱家泓五大選股法 — 共用工具函式
# ────────────────────────────────────────────────────────────
def _chu_load_attention_set():
    """讀 data/attention_status.json,回傳 {sym} set(處置/注意/全額交割)"""
    try:
        if ATTENTION_FILE.exists():
            blob = json.loads(ATTENTION_FILE.read_text(encoding='utf-8'))
            return set((blob.get('stocks') or {}).keys())
    except Exception:
        pass
    return set()


def _chu_skip(sym, rows, attention_set, min_rows=22):
    """共用排除:處置 / ETF / 殭屍量 / 資料筆數不足。回 True = 跳過。"""
    if sym in attention_set:
        return True
    if sym.startswith('00'):  # ETF 排除
        return True
    if not isinstance(rows, list) or len(rows) < min_rows:
        return True
    # 殭屍量:最近 5 日平均成交量 < 200 張(200 × 1000 股)
    vols = [(r.get('volume', 0) or 0) for r in rows[-5:]]
    if vols and (sum(vols) / len(vols) / 1000) < 200:
        return True
    return False


def _chu_macd_hist(closes, fast=12, slow=26, sig=9):
    """算今日 MACD 柱(DIF - DEA)。資料 < slow+sig 回 None。
    EMA 標準公式:EMA_t = α·close + (1-α)·EMA_{t-1},α=2/(N+1)。"""
    # 🛡️ 先剔除非有限收盤(None/NaN/±Inf),避免髒資料把整條 EMA 污染成 NaN;
    #    清洗後再判斷筆數是否仍足夠。
    closes = [c for c in closes if is_finite_num(c)]
    if len(closes) < slow + sig:
        return None
    def _ema(values, n):
        k = 2 / (n + 1)
        e = sum(values[:n]) / n  # 用首 N 筆 SMA 當 seed
        for v in values[n:]:
            e = v * k + e * (1 - k)
        return e
    # 為了得到「今日 DEA」,需要連續 N 天的 DIF 序列
    # 簡化:用迭代法一次算到底,輸出每日 DIF + 末 sig 天 EMA
    k_fast, k_slow, k_sig = 2 / (fast + 1), 2 / (slow + 1), 2 / (sig + 1)
    e_fast = sum(closes[:fast]) / fast
    e_slow = sum(closes[:slow]) / slow
    difs = []
    for i, v in enumerate(closes):
        if i >= fast:
            e_fast = v * k_fast + e_fast * (1 - k_fast)
        if i >= slow:
            e_slow = v * k_slow + e_slow * (1 - k_slow)
        if i >= slow - 1:
            difs.append(e_fast - e_slow)
    if len(difs) < sig:
        return None
    dea = sum(difs[:sig]) / sig
    for d in difs[sig:]:
        dea = d * k_sig + dea * (1 - k_sig)
    hist = difs[-1] - dea  # 今日 MACD 柱
    # 🛡️ 雙保險:結果非有限值一律回 None,不讓 NaN 冒充成「MACD 訊號」
    return hist if is_finite_num(hist) else None


def _chu_kd(rows, n=9):
    """算今日 (K, D, K_prev, D_prev)。資料 < n+1 回 None。
    台股慣用「Stochastic Slow」:RSV → K = 2/3·K_prev + 1/3·RSV,D 同理。"""
    if len(rows) < n + 1:
        return None
    K, D = 50.0, 50.0
    K_prev, D_prev = K, D
    for i in range(n - 1, len(rows)):
        window = rows[i - n + 1: i + 1]
        highs = [r.get('high', r.get('close', 0)) or 0 for r in window]
        lows = [r.get('low', r.get('close', 0)) or 0 for r in window]
        c = rows[i].get('close', 0) or 0
        hi, lo = max(highs), min(lows)
        rsv = (c - lo) / (hi - lo) * 100 if hi > lo else 50.0
        K_new = (2 / 3) * K + (1 / 3) * rsv
        D_new = (2 / 3) * D + (1 / 3) * K_new
        K_prev, D_prev = K, D
        K, D = K_new, D_new
    return (K, D, K_prev, D_prev)


def _chu_stdev_ratio(closes):
    """近 20 日標準差 / 均價(波動率)。資料 < 20 回 None。"""
    # 🛡️ 先剔除非有限收盤,避免 NaN 讓 av<=0 判斷失效(NaN 比較恆 False 會漏網)
    closes = [c for c in closes if is_finite_num(c)]
    if len(closes) < 20:
        return None
    w = closes[-20:]
    av = sum(w) / 20
    if not is_finite_num(av) or av <= 0:
        return None
    var = sum((c - av) ** 2 for c in w) / 20
    ratio = (var ** 0.5) / av
    return ratio if is_finite_num(ratio) else None


def _chu_perfect6(sym, rows):
    """🍀 模組 A:六六大順。核心 4 必中 + 加分項 0-25。回 record dict 或 None。"""
    if len(rows) < 60:
        return None
    closes = [r.get('close', 0) or 0 for r in rows]
    opens = [r.get('open', 0) or 0 for r in rows]
    vols = [r.get('volume', 0) or 0 for r in rows]
    c, o, v = closes[-1], opens[-1], vols[-1]
    pc = closes[-2]
    if c <= 0 or o <= 0 or pc <= 0 or v <= 0:
        return None

    # 核心 4 必中
    ma5 = sum(closes[-5:]) / 5
    ma10 = sum(closes[-10:]) / 10
    ma20 = sum(closes[-20:]) / 20
    ma60 = sum(closes[-60:]) / 60
    if not (ma5 > ma10 > ma20 > ma60):  # 多頭排列
        return None
    day_gain = (c - pc) / pc * 100
    if not (c > o and day_gain > 0.5):  # 紅 K + 漲幅 > 0.5%
        return None
    v_avg_5 = sum(vols[-5:]) / 5
    if not (v_avg_5 > 0 and v > v_avg_5 * 1.2):  # 爆量
        return None
    # 創 20 日新高(不含今日)
    if not (c > max(closes[-21:-1])):
        return None

    # 加分項 0-25
    quality = 0
    badges = []
    macd_h = _chu_macd_hist(closes)
    if macd_h is not None and macd_h > 0:
        quality += 10
        badges.append("MACD多")
    kd = _chu_kd(rows)
    if kd:
        K, D, Kp, Dp = kd
        if K > D and Kp <= Dp:
            quality += 10
            badges.append("KD金叉")
    ma20_5ago = sum(closes[-25:-5]) / 20 if len(closes) >= 25 else None
    if ma20_5ago and ma20 > ma20_5ago:
        quality += 5
        badges.append("月線上揚")

    turnover = c * v
    result = {
        'sym': sym, 'close': round(c, 2),
        'turnover_e': round(turnover / YI, 2),
        'gain': round(day_gain, 2),
        'quality': quality,
        'status': f"品質{quality}/25" + (" · " + "·".join(badges) if badges else ""),
    }
    warn = _chu_top_distribution_warning(rows)
    if warn:
        result['warning'] = warn   # V15.4 朱老師高檔出貨警示(不淘汰,只標警讓使用者決定)
    return result


def _chu_top_gainer(sym, rows):
    """🔥 模組 B:特別報價。紅 K + 漲幅 ≥ 3% + 成交額 ≥ 5000 萬 + 成交量 ≥ 2000 張。"""
    if len(rows) < 2:   # V41.14 防禦:需今+昨兩根才算漲幅(原僅靠呼叫端 _chu_skip 擋,補上自身守門)
        return None
    closes = [r.get('close', 0) or 0 for r in rows]
    opens = [r.get('open', 0) or 0 for r in rows]
    c, o, v = closes[-1], opens[-1], rows[-1].get('volume', 0) or 0
    pc = closes[-2] if len(closes) >= 2 else 0
    if c <= 0 or o <= 0 or pc <= 0 or v <= 0:
        return None
    day_gain = (c - pc) / pc * 100
    turnover = c * v
    lots = v / 1000  # 張數

    # 過濾:漲幅 < 3%、非紅 K、成交額 < 5000 萬、量 < 2000 張
    if day_gain < 3.0:
        return None
    if c <= o:
        return None
    if turnover < 50_000_000:
        return None
    if lots < 2000:
        return None

    result = {
        'sym': sym, 'close': round(c, 2),
        'turnover_e': round(turnover / YI, 2),
        'gain': round(day_gain, 2),
        'status': f"漲{day_gain:.1f}% · 量{int(lots)}張",
    }
    warn = _chu_top_distribution_warning(rows)
    if warn:
        result['warning'] = warn   # V15.4 朱老師高檔出貨警示
    return result


def _chu_bottom(sym, rows):
    """🥣 模組 D:底部轉折。需資料 ≥ 120 筆。"""
    if len(rows) < 120:
        return None
    closes = [r.get('close', 0) or 0 for r in rows]
    opens = [r.get('open', 0) or 0 for r in rows]
    vols = [r.get('volume', 0) or 0 for r in rows]
    c, o, v = closes[-1], opens[-1], vols[-1]
    pc = closes[-2]
    if c <= 0 or o <= 0 or pc <= 0 or v <= 0:
        return None

    # 距 120MA 乖離 -5% ~ +5%
    ma120 = sum(closes[-120:]) / 120
    if ma120 <= 0:
        return None
    bias120 = (c - ma120) / ma120 * 100
    if not (-5 <= bias120 <= 5):
        return None

    # 波動率極低:近 20 日標準差/均價 < 3%
    sr = _chu_stdev_ratio(closes)
    if sr is None or sr >= 0.03:
        return None

    # 長期下跌:距近 120 日(半年)高點下跌 ≥ 20%
    high_120 = max(closes[-120:])
    if high_120 <= 0:
        return None
    drop_from_high = (high_120 - c) / high_120 * 100
    if drop_from_high < 20:
        return None

    # 啟動紅 K:量 ≥ 20日均量 × 2,且 收 > 開、漲幅 > 0.5%
    #   V41.14 修:底部長期量縮,「昨量」本身就很低 → 原本 1.2×昨量 根本不是爆量(且與卡片說明「爆2倍量」、
    #   本函式 L255 註解都不符)。底部轉折的爆量必須對比「長期量縮的基準量」= 20日均量,×2 才是主力大戶真進貨。
    day_gain = (c - pc) / pc * 100
    if not (c > o and day_gain > 0.5):
        return None
    v_avg_20 = sum(vols[-20:]) / 20
    if not (v_avg_20 > 0 and v >= v_avg_20 * 2):
        return None

    turnover = c * v
    return {
        'sym': sym, 'close': round(c, 2),
        'turnover_e': round(turnover / YI, 2),
        'gain': round(day_gain, 2),
        'status': f"底部 · 距高{drop_from_high:.0f}% · 爆量{v/v_avg_20:.1f}x",
    }


def _chu_riding5ma(sym, rows):
    """🚀 模組 E:5MA 飆股主升段。"""
    if len(rows) < 11:
        return None
    closes = [r.get('close', 0) or 0 for r in rows]
    highs = [r.get('high', closes[i]) or 0 for i, r in enumerate(rows)]
    lows = [r.get('low', closes[i]) or 0 for i, r in enumerate(rows)]
    c = closes[-1]
    pc = closes[-2]
    if c <= 0 or pc <= 0:
        return None

    # MA5
    ma5_today = sum(closes[-5:]) / 5
    ma5_5ago = sum(closes[-10:-5]) / 5
    if ma5_5ago <= 0:
        return None
    if c <= ma5_today:  # 收盤要站上 MA5
        return None
    # V15.4 朱老師心法:回後買允許 MA5 短期下彎(回檔 3 天 5MA 可能短負),
    # 但今日收必須強勢突破 5MA 壓力(close > ma5 + close > 昨收 = 突破前日壓力)
    # 從「slope > 5%」改為「slope > -2%(允許下彎)+ 收 > 5MA + 收 > 昨收」
    slope_5 = (ma5_today - ma5_5ago) / ma5_5ago * 100
    if slope_5 <= -2 or c <= pc:
        return None
    # 近 5 日 ≥ 2 根漲幅 > 5%
    big_days = 0
    for i in range(-5, 0):
        if closes[i - 1] > 0:
            g = (closes[i] - closes[i - 1]) / closes[i - 1] * 100
            if g > 5:
                big_days += 1
    if big_days < 2:
        return None
    # 今日最高 > 昨日最高
    if highs[-1] <= highs[-2]:
        return None
    # 今日最低 ≥ MA5(沒跌破)
    if lows[-1] < ma5_today:
        return None
    # 乖離 MA5 < +15%(防接刀)
    bias5 = (c - ma5_today) / ma5_today * 100
    if bias5 >= 15:
        return None

    # 5 日累計漲幅(排序用)
    cum_5d = (c - closes[-6]) / closes[-6] * 100 if len(closes) >= 6 and closes[-6] > 0 else 0
    day_gain = (c - pc) / pc * 100
    v = rows[-1].get('volume', 0) or 0
    turnover = c * v
    result = {
        'sym': sym, 'close': round(c, 2),
        'turnover_e': round(turnover / YI, 2),
        'gain': round(day_gain, 2),
        'cum_5d': round(cum_5d, 2),
        'status': f"5日累漲{cum_5d:.0f}% · 斜率{slope_5:.0f}%",
    }
    warn = _chu_top_distribution_warning(rows)
    if warn:
        result['warning'] = warn   # V15.4 朱老師高檔出貨警示
    return result


def _chu_backtest(sym, rows):
    """🎯 模組 F(V41.18):朱式波段回測期望值榜。逐根模擬「回後買上漲進場 + 跌破5MA停利 / 破進場K低或-5%停損」,
    只收「正期望值 + 交易數 ≥ 5」的股,依每趟期望值排序。需資料 ≥ 90 筆。與前端 _chuSwingBacktest 同邏輯。"""
    if len(rows) < 90:
        return None
    closes = [r.get('close', 0) or 0 for r in rows]
    opens = [r.get('open', 0) or 0 for r in rows]
    highs = [r.get('high', closes[i]) or 0 for i, r in enumerate(rows)]
    lows = [r.get('low', closes[i]) or 0 for i, r in enumerate(rows)]
    vols = [r.get('volume', 0) or 0 for r in rows]
    n = len(rows)
    if closes[-1] <= 0:
        return None
    ma5 = [sum(closes[max(0, i - 4):i + 1]) / len(closes[max(0, i - 4):i + 1]) for i in range(n)]
    ma20 = [sum(closes[max(0, i - 19):i + 1]) / len(closes[max(0, i - 19):i + 1]) for i in range(n)]
    trades = []
    pos = None   # (idx, px, stop)
    for i in range(21, n):
        m5, m20, m5p = ma5[i], ma20[i], ma5[i - 1]
        c, o, pc, ph = closes[i], opens[i], closes[i - 1], highs[i - 1]
        if pos is None:
            uptrend = c > m20 and m5 >= m20
            reclaim5 = pc < m5p and c >= m5
            body = (c - o) / o * 100 if o > 0 else 0
            vol_up = vols[i] > vols[i - 1]
            if uptrend and reclaim5 and body >= 2 and vol_up and c > ph:
                pos = (i, c, min(lows[i], c * 0.95))
        else:
            if c <= pos[2] or c < m5:   # 破停損 或 跌破5MA
                trades.append((c - pos[1]) / pos[1] * 100)
                pos = None
    if len(trades) < 5:
        return None
    wins = [t for t in trades if t > 0]
    losses = [t for t in trades if t <= 0]
    win_rate = len(wins) / len(trades) * 100
    expectancy = sum(trades) / len(trades)
    if expectancy <= 0:   # 只收正期望值
        return None
    avg_win = sum(wins) / len(wins) if wins else 0
    avg_loss = sum(losses) / len(losses) if losses else 0
    pl_ratio = abs(avg_win / avg_loss) if avg_loss != 0 else 99
    comp = 1.0
    for t in trades:
        comp *= (1 + t / 100)
    return {
        'sym': sym, 'close': round(closes[-1], 2),
        'expectancy': round(expectancy, 2),
        'win_rate': round(win_rate, 0),
        'pl_ratio': round(pl_ratio, 2),
        'trades': len(trades),
        'total_return': round((comp - 1) * 100, 0),
        'gain': round(expectancy, 2),   # 供排序/前端 gain 欄相容
    }


# V15.4 朱老師心法:高檔異量過濾(連漲 5+ 日 + 60 日天量 + 長上影 + 乖離 > 15% = 多頭高檔出貨)
def _chu_top_distribution_warning(rows):
    """朱老師高檔出貨警告 — 4 條全中紅、僅乖離過熱黃,讓使用者一眼識破追高陷阱。"""
    if len(rows) < 60:
        return None
    last = rows[-1]
    o = last.get('open', 0) or 0
    h = last.get('high', 0) or 0
    c = last.get('close', 0) or 0
    v = last.get('volume', 0) or 0
    if c <= 0:
        return None
    closes = [r.get('close', 0) or 0 for r in rows]
    vols = [r.get('volume', 0) or 0 for r in rows]
    # 1. 連漲 N 日(close > open 連續)
    consecutive_up = 0
    for r in reversed(rows[-7:]):
        if (r.get('close', 0) or 0) > (r.get('open', 0) or 0):
            consecutive_up += 1
        else:
            break
    # 2. 爆 60 日天量
    max_vol_60 = max(vols[-60:]) if vols[-60:] else 0
    is_peak_vol = max_vol_60 > 0 and v >= max_vol_60
    # 3. 長上影線(上影 / 實體 > 1 或上影 > 2.5%)
    body = abs(c - o) or 0.01
    upper_shadow = max(0.0, h - max(o, c))
    long_upper = (upper_shadow / body > 1) or (upper_shadow / c > 0.025)
    # 4. bias20 > 15%
    if len(closes) >= 20:
        ma20 = sum(closes[-20:]) / 20
        bias20 = (c - ma20) / ma20 * 100 if ma20 > 0 else 0
    else:
        bias20 = 0
    over_extended = bias20 > 15
    # 4 條全中 → 高檔出貨紅燈
    if consecutive_up >= 5 and is_peak_vol and long_upper and over_extended:
        return {'warning': '高檔爆量出貨',
                'detail': f'連漲 {consecutive_up} 日 + 60 日天量 + 長上影 + 乖離 {bias20:.1f}%',
                'level': 'red'}
    # 部分中(只乖離過熱)→ 黃燈
    if over_extended:
        return {'warning': '位階過高,別追',
                'detail': f'乖離月線 +{bias20:.1f}%',
                'level': 'yellow'}
    return None


def fetch_attention_disposal_status():
    """🚨 處置神器爬蟲:抓 TWSE 注意股 + 處置股名單,寫 data/attention_status.json。

    斷崖防護:若兩個端點都失敗且舊檔存在,沿用昨日資料,絕不覆蓋成空檔。
    """
    print("\n🚨 啟動【處置神器】爬蟲偵蒐部隊...")
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "zh-TW,zh;q=0.9",
        "Referer": "https://www.twse.com.tw/",
    }

    def _roc_to_iso(s):
        """民國日期字串轉 ISO:'1150610' / '115/06/10' → '2026-06-10';失敗回 None"""
        import re as _re
        m = _re.search(r'(\d{2,3})[/\-.]?(\d{2})[/\-.]?(\d{2})', str(s or ''))
        if not m:
            return None
        try:
            y = int(m.group(1))
            y = y + 1911 if y < 1911 else y   # 民國→西元;若已是西元 4 位則 regex 抓 3 位會錯,故再防呆
            if y < 2000:
                return None
            return f"{y:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        except Exception:
            return None

    def _fetch_openapi(url, status_label, threshold_label, parse_punish=False):
        """TWSE OpenAPI v1 解析(RESTful JSON list)。
        嚴格 sym 驗證:必為 4 位純數字(上市/上櫃)或 00 開頭 5 位數(ETF)。
        parse_punish=True 時額外解析:分盤間隔(每N分鐘)、處置迄日(出關日)。
        欄位名多候選 + 全防呆:解析失敗自動退回基本 status/threshold,絕不炸。
        回傳 (fetch_ok, out_dict)。
        """
        import re as _re
        try:
            # Referer 依 host 動態(打 TPEx 就給 tpex referer,避免跨站被擋)
            _h = dict(headers)
            _h["Referer"] = "https://www.tpex.org.tw/" if "tpex.org.tw" in url else "https://www.twse.com.tw/"
            r = requests.get(url, headers=_h, timeout=10)
            rows = r.json()
            if not isinstance(rows, list):
                return (False, {})
            # 偵錯:印第一筆 row 完整 schema,讓 workflow log 揭露 OpenAPI 真實欄位名
            if rows and isinstance(rows[0], dict):
                print(f"   [debug] {url.rsplit('/',1)[-1]} 首筆 keys: {list(rows[0].keys())[:12]}")
                print(f"   [debug] 首筆 sample: {str(rows[0])[:300]}")
            out = {}
            for row in rows:
                if not isinstance(row, dict):
                    continue
                sym = str(row.get('Code') or row.get('CompanyCode')
                          or row.get('Symbol') or row.get('StockNo')
                          or row.get('SecuritiesCompanyCode') or row.get('SecuritiesCode')
                          or row.get('StockCode') or row.get('證券代號')
                          or row.get('股票代號') or row.get('代號') or '').strip()
                if not (sym and ((sym.isdigit() and len(sym) == 4) or
                                 (sym.startswith('00') and len(sym) == 5 and sym.isdigit()))):
                    continue
                rec = {"status": status_label, "threshold": threshold_label}
                if parse_punish:
                    try:
                        # 把整列值串起來掃(欄名各版本不同:DispositionMeasures/處置內容/Remark…)
                        blob = ' '.join(str(v) for v in row.values() if v)
                        # 分盤間隔:「每5分鐘」「每20分鐘」「約每 5 分鐘」
                        m_int = _re.search(r'每\s*(\d+)\s*分鐘', blob)
                        if m_int:
                            rec['interval'] = int(m_int.group(1))
                        # 處置期間迄日 = 出關日:期間格式常見「115/06/05～115/06/18」或「1150605-1150618」
                        #   抓 blob 中所有民國日期,取「最大」那個當迄日(起日必小於迄日)
                        dates = [_roc_to_iso(x) for x in _re.findall(r'\d{2,3}[/\-.]\d{2}[/\-.]\d{2}|\d{7}', blob)]
                        dates = sorted(d for d in dates if d)
                        if dates:
                            rec['end_date'] = dates[-1]
                    except Exception:
                        pass   # 任何解析失敗退回基本欄位
                out[sym] = rec
            return (True, out)
        except Exception as e:
            print(f"   ⚠️ {status_label} OpenAPI 失敗:{e}")
            return (False, {})

    # V67.9 自我診斷版:多端點候選,並把「每個端點試了幾筆、ok 嗎、命中哪個」記進 diag,
    #   寫進 attention_status.json 的 diag 鍵(前端只讀 stocks 不受影響)→ 直接抓 JSON 就能驗證,
    #   不必挖 workflow log(radar 輸出跑進 /tmp 沒被 cat)。取代舊 _fetch_first_ok。
    def _fetch_cat(urls, status_label, threshold_label, parse_punish=False):
        """多端點候選 + 診斷:依序試,回 (out_dict, diag)。
        diag = {'hit': 命中端點短名|None, 'n': 命中筆數, 'tried': [{'u':短名,'ok':bool,'n':筆數}, ...]}
        命中定義 = fetch_ok 且有資料;全空但有 ok 端點也照實記(區分「端點壞」vs「端點通但0筆」)。"""
        tried = []
        for u in urls:
            ok, out = _fetch_openapi(u, status_label, threshold_label, parse_punish=parse_punish)
            short = u.rsplit('/', 1)[-1]
            tried.append({'u': short, 'ok': bool(ok), 'n': len(out)})
            if ok and out:
                print(f"   · {status_label} 命中端點 {short} → {len(out)} 檔")
                return out, {'hit': short, 'n': len(out), 'tried': tried}
        return {}, {'hit': None, 'n': 0, 'tried': tried}

    diag = {}

    # ── 上市 TWSE ──(V67.9 diag 實證:notetrans 才是真注意端點,notice 回空;notetrans 排前)
    attention, diag['tw_notice'] = _fetch_cat(
        ["https://openapi.twse.com.tw/v1/announcement/notetrans",
         "https://openapi.twse.com.tw/v1/announcement/notice"],
        "⚠️ 注意股", "注意條款觸發")
    print(f"   · 上市注意股:{len(attention)} 檔 (hit={diag['tw_notice']['hit']})")

    disposal, diag['tw_punish'] = _fetch_cat(
        ["https://openapi.twse.com.tw/v1/announcement/punish"],
        "🚨 處置中", "已關禁閉", parse_punish=True)
    print(f"   · 上市處置股:{len(disposal)} 檔 (hit={diag['tw_punish']['hit']})")

    # ── 上櫃 TPEx 櫃買中心 ──(注意/處置各多候選;diag 會揭露哪個 slug 有效)
    # ⛔ 上櫃注意股:V67.9/V67.10 diag 已實測 11 個候選 slug 全 ok=false(路徑不存在)→
    #   結論:TPEx 未把「上櫃注意股」放進免費 OpenAPI(只開放處置 tpex_disposal_information)。
    #   故不再打(免每次採礦白白多 ~110s 失敗請求);上櫃注意股由前端公式推估 + 誠實標「非官方」
    #   + 官方公告連結涵蓋(index.html renderDispHeadline)。若日後 TPEx 新增注意 OpenAPI 再補。
    otc_attention = {}
    diag['otc_notice'] = {'hit': None, 'n': 0, 'note': 'TPEx 未開放上櫃注意 OpenAPI(V67.10 實測 11 slug 全 404),不再打'}

    otc_disposal, diag['otc_punish'] = _fetch_cat(
        ["https://www.tpex.org.tw/openapi/v1/tpex_disposal_information",
         "https://www.tpex.org.tw/openapi/v1/tpex_disposal_securities",
         "https://www.tpex.org.tw/openapi/v1/tpex_disposal"],
        "🚨 處置中", "已關禁閉", parse_punish=True)
    print(f"   · 上櫃處置股:{len(otc_disposal)} 檔 (hit={diag['otc_punish']['hit']})")

    # 合併:注意先、處置後(處置蓋注意,同股以處置為準);上市/上櫃互不覆蓋(代號不重複)
    result = {**attention, **otc_attention, **disposal, **otc_disposal}
    _any_ok = any(t['ok'] for c in diag.values() for t in c['tried'])

    # 斷崖防護:只在「所有端點都 fetch 失敗」時沿用昨日 cache。
    # 若至少一個成功但 result 空,代表當日該市場無事,合法寫入。
    if not _any_ok and ATTENTION_FILE.exists():
        print("🛡️  所有 OpenAPI 端點都失敗,沿用昨日 attention_status.json,不覆蓋")
        return

    payload = {
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "stocks": result,
        "diag": diag,   # V67.9 端點自我診斷(前端只讀 stocks,忽略此鍵)
    }
    try:
        ATTENTION_FILE.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )
        print(f"✅ 處置神器:寫入 {len(result)} 檔注意/處置股 → {ATTENTION_FILE}")
    except Exception as e:
        print(f"❌ attention_status.json 寫檔失敗(不影響其他流程):{e}")

    # V20.9 — 累積 attention_history.json:每日 append 一筆(只存 sym+status),保留近 90 天
    #         用途:前端算「該股近 30 日被列幾次」+ K 線標記觸發點
    try:
        HIST_FILE = DATA_DIR / "attention_history.json"
        today_iso = datetime.now().strftime("%Y-%m-%d")
        # 讀舊資料
        hist = {}
        if HIST_FILE.exists():
            try:
                hist = json.loads(HIST_FILE.read_text(encoding='utf-8'))
            except Exception:
                hist = {}
        if not isinstance(hist, dict):
            hist = {}
        if "history" not in hist or not isinstance(hist["history"], dict):
            hist["history"] = {}
        # 今日資料(去除 threshold/interval/end_date,只留 sym → status 短字串)
        today_data = {}
        for sym, info in result.items():
            status = info.get("status", "")
            if status.startswith("🚨"):
                today_data[sym] = "處置"
            elif "注意" in status:
                today_data[sym] = "注意"
        hist["history"][today_iso] = today_data
        # 清掉 > 90 天前的資料(保留近 90 天)
        cutoff = datetime.now().timestamp() - 90 * 86400
        hist["history"] = {
            d: v for d, v in hist["history"].items()
            if d >= datetime.fromtimestamp(cutoff).strftime("%Y-%m-%d")
        }
        hist["updated"] = datetime.now().strftime("%Y-%m-%d %H:%M")
        HIST_FILE.write_text(json.dumps(hist, ensure_ascii=False, indent=2), encoding='utf-8')
        total_days = len(hist["history"])
        print(f"✅ attention_history.json:已累積 {total_days} 天紀錄(今日 {len(today_data)} 檔)")
    except Exception as e:
        print(f"⚠️ attention_history.json 累積失敗(不影響主流程):{e}")


# ════════════════════════════════════════════════════════════════════
# 📐 K棒轉折雷達(V41.7)— 朱家泓 K棒戰法純公式偵測器,port 自前端 index.html:
#   _detectStarPatterns(夜星/晨星)・_detect2BarReversal(吞噬/覆蓋/貫穿/遭遇/母子)
#   ・_detectPressureTest(測壓/測撐+量)・_detectVolPriceDiverge(量價背離)
#   全市場掃 → data/radar_matrix.json 的 kbar_bull / kbar_bear。閾值與前端逐一對齊。
# ════════════════════════════════════════════════════════════════════
def _kb_o(b): return float(b.get('open') or b.get('o') or 0)
def _kb_c(b): return float(b.get('close') or b.get('c') or 0)
def _kb_h(b): return float(b.get('high') or b.get('h') or 0)
def _kb_l(b): return float(b.get('low') or b.get('l') or 0)
def _kb_v(b): return float(b.get('volume') or 0)
def _kb_body(b): return abs(_kb_c(b) - _kb_o(b))
def _kb_small(b):
    o = _kb_o(b); return o > 0 and _kb_body(b) / o < 0.018
def _kb_long_up(b):
    o = _kb_o(b); return _kb_c(b) > o and o > 0 and (_kb_c(b) - o) / o >= 0.03
def _kb_long_dn(b):
    o = _kb_o(b); return _kb_c(b) < o and o > 0 and (o - _kb_c(b)) / o >= 0.03
def _kb_bigvol(data, j):
    pv = [_kb_v(x) for x in data[max(0, j - 5):j]]
    av = sum(pv) / len(pv) if pv else _kb_v(data[j])
    return av > 0 and _kb_v(data[j]) >= av * 1.5


def _kb_star(data, bear):
    """三根K棒 夜星(bear)/晨星(bull):左長K + 1-3 變盤線 + 右長K收破左K中點;孤島最強。"""
    last = len(data) - 1
    for e in range(last, max(3, last - 2) - 1, -1):
        conf = data[e]
        if (not _kb_long_dn(conf)) if bear else (not _kb_long_up(conf)):
            continue
        for nmid in range(1, 4):
            s_idx = e - nmid - 1
            if s_idx < 0:
                break
            if not all(_kb_small(data[m]) for m in range(s_idx + 1, e)):
                continue
            lead = data[s_idx]
            if (not _kb_long_up(lead)) if bear else (not _kb_long_dn(lead)):
                continue
            mid = (_kb_o(lead) + _kb_c(lead)) / 2
            if (_kb_c(conf) >= mid) if bear else (_kb_c(conf) <= mid):
                continue
            win = data[max(0, s_idx - 20):s_idx + 1]
            if bear:
                hi = max((_kb_h(x) for x in win), default=0)
                if not hi or _kb_h(lead) < hi * 0.94:
                    continue
            else:
                lo = min((_kb_l(x) for x in win), default=0)
                if not lo or _kb_l(lead) > lo * 1.06:
                    continue
            island = ((_kb_l(data[s_idx + 1]) > _kb_h(lead) and _kb_h(conf) < _kb_l(data[e - 1])) if bear
                      else (_kb_h(data[s_idx + 1]) < _kb_l(lead) and _kb_l(conf) > _kb_h(data[e - 1])))
            big = _kb_bigvol(data, e)
            if bear:
                name = '孤島夜星' if island else ('群星夜星' if nmid >= 2 else '夜星轉折')
            else:
                name = '孤島晨星' if island else ('群星晨星' if nmid >= 2 else '晨星轉折')
            return name + ('+爆量' if big else '')
    return None


def _kb_2bar(data):
    """兩根K棒反轉:高檔紅黑配(偏空)/低檔黑紅配(偏多),確認 K 在最後 1-2 根。"""
    if len(data) < 4:
        return None
    last = len(data) - 1
    for e in range(last, max(2, last - 1) - 1, -1):
        b2 = data[e]; b1 = data[e - 1]
        if not _kb_o(b1) or not _kb_o(b2):
            continue
        win = data[max(0, e - 1 - 20):e - 1]
        hi = max((_kb_h(x) for x in win), default=_kb_h(b1))
        lo = min((_kb_l(x) for x in win), default=_kb_l(b1))
        at_high = hi and _kb_h(b1) >= hi * 0.96
        at_low = lo and _kb_l(b1) <= lo * 1.04
        big = _kb_bigvol(data, e)
        mid1 = (_kb_o(b1) + _kb_c(b1)) / 2
        O2, C2, O1, C1 = _kb_o(b2), _kb_c(b2), _kb_o(b1), _kb_c(b1)
        H2, L2, H1, L1 = _kb_h(b2), _kb_l(b2), _kb_h(b1), _kb_l(b1)
        # 高檔紅黑配(偏空)
        if at_high and _kb_long_up(b1) and C2 < O2:
            if O2 >= C1 and C2 <= O1:
                return ('bear', '長黑吞噬(主力出貨)' + ('+爆量' if big else ''))
            if O2 >= C1 and C2 < mid1 and C2 > O1:
                return ('bear', '長黑覆蓋(烏雲罩頂)')
            if O2 > C1 and C2 >= mid1 and C1 and abs(C2 - C1) / C1 < 0.012:
                return ('bear', '長黑遭遇(一日封口)' + ('+爆量' if big else ''))
        if at_high and _kb_long_up(b1) and _kb_small(b2) and H2 <= H1 and L2 >= L1:
            return ('bear', '高檔母子懷抱')
        # 低檔黑紅配(偏多)
        if at_low and _kb_long_dn(b1) and C2 > O2:
            if O2 <= C1 and C2 >= O1:
                return ('bull', '長紅吞噬(主力進貨)' + ('+爆量' if big else ''))
            if O2 <= C1 and C2 > mid1 and C2 < O1:
                return ('bull', '長紅貫穿(旭日東升)')
            if O2 < C1 and C2 <= mid1 and C1 and abs(C2 - C1) / C1 < 0.012:
                return ('bull', '長紅遭遇(一日封口)' + ('+爆量' if big else ''))
        if at_low and _kb_long_dn(b1) and _kb_small(b2) and H2 <= H1 and L2 >= L1:
            return ('bull', '低檔母子懷抱')
    return None


def _kb_pressure(data):
    """測壓有壓(前高賣壓,偏空)/測撐有撐(前低支撐,偏多),配合成交量。"""
    if len(data) < 25:
        return None
    last = len(data) - 1; cur = data[last]
    o, c, h, l = _kb_o(cur), _kb_c(cur), _kb_h(cur), _kb_l(cur)
    if not o or not c or not h or not l:
        return None
    rng = h - l
    if rng <= 0:
        return None
    body = abs(c - o)
    up_sh = h - max(o, c); dn_sh = min(o, c) - l
    vol5 = [_kb_v(x) for x in data[max(0, last - 5):last]]
    avg_v = sum(vol5) / len(vol5) if vol5 else _kb_v(cur)
    vr = _kb_v(cur) / avg_v if avg_v > 0 else 1
    big_v = vr >= 1.5; shrink_v = vr <= 0.7
    win = data[max(0, last - 60):last - 1]
    if len(win) < 5:
        return None
    prev_high = max(_kb_h(x) for x in win); prev_low = min(_kb_l(x) for x in win)
    if not prev_high or not prev_low:
        return None
    if h >= prev_high * 0.985 and h <= prev_high * 1.03 and c < prev_high and up_sh >= body and up_sh >= rng * 0.35:
        return ('bear', '測壓有壓(前高賣壓)' + ('+爆量' if big_v else ''))
    if l <= prev_low * 1.015 and l >= prev_low * 0.97 and c > prev_low and dn_sh >= body and dn_sh >= rng * 0.35:
        return ('bull', '測撐有撐(前低支撐)' + ('+量縮' if shrink_v else ''))
    return None


def _kb_diverge(data):
    """量價背離:無量創高 / 高檔價漲量縮(皆偏空,出貨前兆)。"""
    if len(data) < 25:
        return None
    last = len(data) - 1; cur = data[last]
    c = _kb_c(cur); v = _kb_v(cur)
    if not c or not v:
        return None
    prior = data[max(0, last - 20):last]
    if len(prior) < 15:
        return None
    hi20 = max(_kb_c(x) for x in prior)
    avg_v = sum(_kb_v(x) for x in prior) / len(prior)
    if avg_v <= 0:
        return None
    vr = v / avg_v
    if c >= hi20 and vr < 0.9:
        return ('bear', '無量創高(量價背離)')
    hi60 = max(_kb_h(x) for x in data[max(0, last - 60):last + 1])
    if hi60 and c >= hi60 * 0.93 and last >= 3:
        rising = c > _kb_c(data[last - 1]) and _kb_c(data[last - 1]) > _kb_c(data[last - 2])
        vol_down = v < _kb_v(data[last - 1]) and _kb_v(data[last - 1]) < _kb_v(data[last - 2])
        if rising and vol_down:
            return ('bear', '價漲量縮(高檔背離)')
    return None


def detect_kbar_signals(rows):
    """回 (bull_titles, bear_titles) — 對齊前端 4 個 K棒偵測器。rows = OHLCV list。"""
    bull, bear = [], []
    if not isinstance(rows, list) or len(rows) < 25:
        return bull, bear
    sb = _kb_star(rows, True)
    if sb:
        bear.append(sb)
    su = _kb_star(rows, False)
    if su:
        bull.append(su)
    for fn in (_kb_2bar, _kb_pressure, _kb_diverge):
        try:
            r = fn(rows)
        except Exception:
            r = None
        if r:
            (bull if r[0] == 'bull' else bear).append(r[1])
    # 第2-6/2-7章:單根變盤線(只在高/低檔極端位階觸發,避免洗版)
    try:
        rc = reversal_candle(rows)
    except Exception:
        rc = None
    if rc:
        (bull if rc['side'] == 'bull' else bear).append(rc['name'])
    # 第2-9章:大量長K ½價多空分界(已被反向收破才算轉勢確認,避免只是接近)
    try:
        hp = half_price_signal(rows)
    except Exception:
        hp = None
    if hp and hp.get('broken'):
        (bull if hp['side'] == 'bull' else bear).append(hp['name'])
    return bull, bear


# 🎯 V69.1.24 口袋支點(Pocket Pivot,Minervini)全市場版 — 與前端 _detectPocketPivot 逐條對齊
def _pocket_pivot(raw_data):
    """回傳 status 字串或 None。多頭沿均線整理,今日上漲量 > 近10日最大黑K量 + 貼近10日線。"""
    if not isinstance(raw_data, list) or len(raw_data) < 25:
        return None
    C = lambda b: b.get('close', 0) or 0
    V = lambda b: b.get('volume', 0) or 0
    n = len(raw_data); last = n - 1
    c = C(raw_data[last]); o = raw_data[last].get('open', 0) or 0; v = V(raw_data[last])
    if not (c > 0 and o > 0 and v > 0):
        return None
    closes = [C(b) for b in raw_data]
    def ma(k):
        s = closes[-k:]
        return sum(s) / k if len(s) >= k else None
    ma10, ma20, ma50 = ma(10), ma(20), ma(50)
    if not (ma10 and ma20 and c >= ma20 and (ma50 is None or c > ma50)):
        return None
    if not (c > C(raw_data[last - 1]) and c >= o):     # 今日收紅上漲
        return None
    max_down_vol = 0
    for j in range(last - 10, last):
        if j < 1:
            continue
        if C(raw_data[j]) < C(raw_data[j - 1]):
            max_down_vol = max(max_down_vol, V(raw_data[j]))
    if max_down_vol > 0 and v > max_down_vol and abs(c - ma10) / c * 100 <= 4:
        volx = v / max_down_vol
        return f"量 {volx:.1f}× 近10日最大黑K量 · 貼10日線 {ma10:.2f}(主力偷買)"
    return None


# 🚀 V69.1.24 相對強度 RS(個股近20日超額報酬 vs 大盤)— 與前端 _detectRelativeStrength 對齊(只收「強於大盤」)
def _rs_vs_market(raw_data, twii_ret20):
    """回傳 (rs, status) 或 None。近20日個股報酬 − 大盤報酬 ≥ 8% = 強勢股。"""
    if twii_ret20 is None or not isinstance(raw_data, list) or len(raw_data) < 25:
        return None
    C = lambda b: b.get('close', 0) or 0
    n = len(raw_data)
    c = C(raw_data[n - 1]); c20 = C(raw_data[n - 21])
    if not (c > 0 and c20 > 0):
        return None
    stk_ret = (c - c20) / c20 * 100
    rs = stk_ret - twii_ret20
    if rs >= 8:
        return (rs, f"近20日 {stk_ret:+.1f}% vs 大盤 {twii_ret20:+.1f}% · 超額 +{rs:.1f}%")
    return None


def _fetch_twii_ret20():
    """大盤(^TWII)近 20 交易日報酬%,供 RS 用;任何失敗回 None(該輪 RS 榜空,不影響其他戰區)。"""
    try:
        import yfinance as yf
        hist = yf.Ticker("^TWII").history(period="2mo")
        closes = [float(x) for x in hist["Close"].tolist() if x == x]
        if len(closes) < 21:
            return None
        return (closes[-1] - closes[-21]) / closes[-21] * 100
    except Exception as e:
        print(f"   ⚠️ RS 大盤基準抓取失敗,本輪 RS 榜略過:{e}")
        return None


def main():
    print("🚀 啟動【首席雷達矩陣】全市場掃描引擎...")

    # 準備三個戰區的空名單
    matrix = {
        'momentum': [],  # 🏎️ 渣男賽車
        'swing': [],     # 🐢 烏龜過河
        'sniper': [],    # 🎯 狙擊手
        # 📚 朱家泓五大選股法(雷達只跑 A/B/D/E;C 淘汰在前端跑)
        'chu_perfect6': [],     # 🍀 六六大順(模組 A)
        'chu_top_gainer': [],   # 🔥 特別報價(模組 B)
        'chu_bottom': [],       # 🥣 底部轉折(模組 D)
        'chu_riding5ma': [],    # 🚀 5MA 飆股主升段(模組 E)
        'chu_backtest': [],     # 🎯 朱式波段回測期望值榜(模組 F,V41.18)
        'chu_entry': [],        # 🎯 回後買上漲(旗艦訊號全市場 port,建議2):頭頭高底底高+回站5MA+上方空間gate
        'chu_granville': [],    # 📐 葛蘭碧八大買點(全市場 port,建議2)
        'chu_box': [],          # 📦 K線橫盤突破(全市場 port,建議2)
        'chu_diverge': [],      # 🔀 KD/MACD 背離(全市場 port,建議2)
        # 📐 K棒轉折雷達(V41.7):純公式 K棒戰法全市場掃描
        'kbar_bull': [],        # 🌅 K棒轉多(晨星/長紅吞噬遭遇/測撐)
        'kbar_bear': [],        # 🌃 K棒轉空(夜星/長黑吞噬遭遇/測壓/量價背離)
        # 🎯🚀 V69.1.24 口袋支點 / 相對強度(全市場版,對齊前端偵測器)
        'pocket_pivot': [],     # 🎯 口袋支點(Minervini 主力偷買早期買點)
        'rs_strong': [],        # 🚀 相對強度(近20日超額報酬強於大盤)
    }

    # 🚀 V69.1.24 大盤近20日報酬(RS 相對強度基準),抓一次;失敗則 RS 榜本輪略過
    twii_ret20 = _fetch_twii_ret20()
    print(f"   📊 大盤近20日報酬:{('%+.1f%%' % twii_ret20) if twii_ret20 is not None else '抓取失敗(RS 榜本輪略過)'}")

    # 朱家泓選股法共用排除名單(處置/注意/全額交割)
    chu_attention_set = _chu_load_attention_set()
    print(f"   📚 朱家泓選股排除名單載入:{len(chu_attention_set)} 檔(處置/注意股)")

    processed_count = 0

    # 掃描 data 資料夾下所有的股票 JSON 檔
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        # 過濾掉非股票代號的檔案 (例如 radar.json / macro_cache.json)
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue

        try:
            raw_data = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(raw_data, list) or len(raw_data) < 22:
                continue

            # 取最近 25 天資料來運算
            data = raw_data[-25:]
            latest = data[-1]
            prev = data[-2]

            c = latest.get('close', 0)
            pc = prev.get('close', 0)
            v = latest.get('volume', 0)  # 單位是股數

            if c <= 0 or pc <= 0 or v <= 0:
                continue

            # 基礎指標計算
            ma5 = calculate_ma(data, 5)
            ma20 = calculate_ma(data, 20)
            p_ma20 = calculate_ma(data[:-1], 20)  # 昨天的 20MA

            # 當日成交金額 (新台幣)
            turnover = c * v
            turnover_e = round(turnover / YI, 2)  # 換算成「億」
            # 漲跌幅
            day_gain = round((c - pc) / pc * 100, 2)

            # --- 🏎️ 戰區一：渣男賽車 (極速動能) ---
            # 條件：成交額 > 5億、近5天有單日漲幅 >= 7%、收盤站上5日線且5MA>20MA
            max_gain_5d = max(
                (
                    (data[i]['close'] - data[i - 1]['close']) / data[i - 1]['close'] * 100
                    for i in range(-5, 0) if data[i - 1]['close'] > 0
                ),
                default=0,
            )

            if turnover >= 500_000_000 and max_gain_5d >= 7.0 and c > ma5 and ma5 > ma20:
                matrix['momentum'].append({
                    'sym': sym,
                    'close': round(c, 2),
                    'turnover_e': turnover_e,
                    'gain': day_gain,
                    'status': f"最高動能 {round(max_gain_5d, 1)}%"
                })

            # --- 🐢 戰區二：烏龜過河 (波段起漲) ---
            # 放寬條件:法人「近5日內 ≥3 天買超」+「近3日內首次站月線」+ 量增
            # 原 AND 三嚴條件導致候選極稀(常 0 檔),改為彈性 AND 仍嚴格但有實用性
            inst_buy_days_5 = sum(
                1 for r in data[-5:]
                if (r.get('foreign_net', 0) + r.get('trust_net', 0)) > 0
            )
            inst_support = inst_buy_days_5 >= 3
            # 近 3 日內任一日從月線下穿月線上(首次站月線)
            cross_20ma_recent = False
            for k in range(-3, 0):
                if k - 1 < -len(data):
                    continue
                kc = data[k].get('close', 0)
                kpc = data[k - 1].get('close', 0) if abs(k - 1) <= len(data) else 0
                # 用該天的 ma20 近似(資料只到 last,近3日內用 ma20 近似可接受)
                if kpc > 0 and kpc <= ma20 and kc > ma20:
                    cross_20ma_recent = True
                    break
            v_avg_5 = sum(d.get('volume', 0) for d in data[-5:]) / 5
            vol_expanding = v > v_avg_5

            if inst_support and cross_20ma_recent and vol_expanding:
                matrix['swing'].append({
                    'sym': sym,
                    'close': round(c, 2),
                    'turnover_e': turnover_e,
                    'gain': day_gain,
                    'status': f"近3日站月線+法人買{inst_buy_days_5}/5天"
                })

            # --- 🎯 戰區三：狙擊手 (籌碼集中) ---
            # 條件：乖離率極低(股價貼著月線)，但特定大戶籌碼高度集中
            # ⚠️ 僅 CHIP_WATCHLIST(~50檔) 有分點資料，故此區候選天然受限
            bias_20 = (c - ma20) / ma20 * 100
            sniper_added = False
            if -2 <= bias_20 <= 3:  # 股價在月線附近盤整
                # 主路徑:分點籌碼集中(僅 CHIP_WATCHLIST ~50 檔有資料)
                chip_file = CHIPS_DIR / f"{sym}.json"
                if chip_file.exists():
                    chip_data = json.loads(chip_file.read_text(encoding='utf-8'))
                    chips_list = chip_data.get('chips', [])
                    if chips_list:
                        latest_chip = chips_list[-1]
                        tot_buy = latest_chip.get('tot_buy', 0)
                        if tot_buy > 0:
                            top3_buy = sum(
                                b.get('buy', 0)
                                for b in sorted(
                                    latest_chip.get('buyers', []),
                                    key=lambda x: -x.get('net', 0)
                                )[:3]
                            )
                            concentration = top3_buy / tot_buy * 100
                            if concentration >= 30:
                                matrix['sniper'].append({
                                    'sym': sym, 'close': round(c, 2),
                                    'turnover_e': turnover_e, 'gain': day_gain,
                                    'status': f"主力高度集中 {round(concentration, 1)}%"
                                })
                                sniper_added = True

                # 🎯 替代路徑(全市場可判,不需分點):法人連買 + 貼月線 + 量增
                # 解決原本 sniper 常 0 檔(分點只覆蓋 50 檔)→ 讓 1900+ 檔也有機會入選
                if not sniper_added and turnover >= 100_000_000:
                    inst_buy_5d = sum(
                        1 for r in data[-5:]
                        if (r.get('foreign_net', 0) + r.get('trust_net', 0)) > 0
                    )
                    v_avg_5s = sum(d.get('volume', 0) for d in data[-5:]) / 5
                    if inst_buy_5d >= 4 and v > v_avg_5s:  # 近5日法人買≥4天 + 量增
                        matrix['sniper'].append({
                            'sym': sym, 'close': round(c, 2),
                            'turnover_e': turnover_e, 'gain': day_gain,
                            'status': f"法人連買{inst_buy_5d}/5天+貼月線"
                        })

            # ─────────────────────────────────────────────────
            # 📚 朱家泓五大選股法(A/B/D/E,C 淘汰在前端跑)
            # 共用排除:處置/注意股、ETF、殭屍量、資料筆數不足
            # ─────────────────────────────────────────────────
            if not _chu_skip(sym, raw_data, chu_attention_set, min_rows=22):
                # 🍀 模組 A 六六大順(需 60 筆)
                rec_a = _chu_perfect6(sym, raw_data)
                if rec_a:
                    matrix['chu_perfect6'].append(rec_a)
                # 🔥 模組 B 特別報價
                rec_b = _chu_top_gainer(sym, raw_data)
                if rec_b:
                    matrix['chu_top_gainer'].append(rec_b)
                # 🥣 模組 D 底部轉折(需 120 筆)
                rec_d = _chu_bottom(sym, raw_data)
                if rec_d:
                    matrix['chu_bottom'].append(rec_d)
                # 🚀 模組 E 5MA 飆股
                rec_e = _chu_riding5ma(sym, raw_data)
                if rec_e:
                    matrix['chu_riding5ma'].append(rec_e)
                # 🎯 模組 F 朱式波段回測期望值(需 ≥ 90 筆)
                rec_f = _chu_backtest(sym, raw_data)
                if rec_f:
                    matrix['chu_backtest'].append(rec_f)
                # 🎯 建議2:回後買上漲(旗艦訊號全市場 port)。只收 high/weak 進場級,
                #    附「上方空間%、波段階段、淘汰紅旗」。追高/等待級不進榜(避免雜訊)。
                rec_g = chu_long_entry(raw_data)
                if rec_g and rec_g.get('grade') in ('high', 'weak'):
                    flags = chu_eliminate(raw_data)
                    matrix['chu_entry'].append({
                        'sym': sym, 'close': round(c, 2), 'turnover_e': turnover_e,
                        'grade': rec_g['grade'], 'entry': rec_g['entry'], 'stop': rec_g['stop'],
                        'upside_room': rec_g['upside_room'], 'stage': rec_g['stage'],
                        'reason': rec_g['reason'],
                        'red_flags': flags[:3],   # 淘汰紅旗(有則提醒風險)
                        'status': ('🎯高勝率' if rec_g['grade'] == 'high' else '⚡力道弱')
                                  + (f" · ⚠️{flags[0]}" if flags else ''),
                    })

                # 📐 建議2:葛蘭碧買點(只收買 1/2/3,買4乖離另有雷達)
                _gv = [g for g in granville(raw_data) if g['side'] == 'buy' and g['point'] <= 3]
                if _gv:
                    _vs = volume_signals(raw_data)
                    matrix['chu_granville'].append({
                        'sym': sym, 'close': round(c, 2), 'turnover_e': turnover_e, 'gain': day_gain,
                        'status': '＋'.join(f"買{g['point']}·{g['name']}" for g in _gv[:2])
                                  + (f" · {_vs[0]['name']}" if _vs else ''),
                    })
                # 📦 建議2:K線橫盤突破(只收多方突破)
                _bx = box_breakout(raw_data)
                if _bx and _bx['side'] == 'bull':
                    matrix['chu_box'].append({
                        'sym': sym, 'close': round(c, 2), 'turnover_e': turnover_e, 'gain': day_gain,
                        'neck': _bx['neck'],
                        'status': f"橫盤{_bx['box_n']}根後突破上頸線{_bx['neck']}"
                                  + ('(剛)' if _bx['when_ago'] == 0 else f"({_bx['when_ago']}天前)"),
                    })
                # 🔀 建議2:KD/MACD 背離(頂背離=賣訊、底背離=買訊)
                _dv = divergence(raw_data)
                if _dv:
                    matrix['chu_diverge'].append({
                        'sym': sym, 'close': round(c, 2), 'turnover_e': turnover_e, 'gain': day_gain,
                        'side': _dv[0]['side'],
                        'status': '／'.join(d['name'] for d in _dv[:2]),
                    })

            # 📐 K棒轉折雷達(V41.7):純公式,全市場皆掃。過濾流動性不足(<3千萬)+處置/注意股
            if turnover >= 30_000_000 and sym not in chu_attention_set:
                kb_bull, kb_bear = detect_kbar_signals(raw_data[-70:])
                if kb_bull:
                    matrix['kbar_bull'].append({
                        'sym': sym, 'close': round(c, 2), 'turnover_e': turnover_e,
                        'gain': day_gain, 'status': ' + '.join(kb_bull[:2])
                    })
                if kb_bear:
                    matrix['kbar_bear'].append({
                        'sym': sym, 'close': round(c, 2), 'turnover_e': turnover_e,
                        'gain': day_gain, 'status': ' + '.join(kb_bear[:2])
                    })

                # 🎯 口袋支點(Minervini 主力偷買)
                _pp = _pocket_pivot(raw_data)
                if _pp:
                    matrix['pocket_pivot'].append({
                        'sym': sym, 'close': round(c, 2), 'turnover_e': turnover_e,
                        'gain': day_gain, 'status': _pp
                    })
                # 🚀 相對強度(強於大盤)
                _rs = _rs_vs_market(raw_data, twii_ret20)
                if _rs:
                    matrix['rs_strong'].append({
                        'sym': sym, 'close': round(c, 2), 'turnover_e': turnover_e,
                        'gain': day_gain, 'rs': round(_rs[0], 1), 'status': _rs[1]
                    })

            processed_count += 1

        except Exception:
            # 遇到髒資料直接跳過，絕不當機
            continue

    # 三區皆以當日成交額由大到小排序（流動性優先，散戶較好進出）
    matrix['momentum'].sort(key=lambda x: x['turnover_e'], reverse=True)
    matrix['swing'].sort(key=lambda x: x['turnover_e'], reverse=True)
    matrix['sniper'].sort(key=lambda x: x['turnover_e'], reverse=True)

    # 📚 朱家泓四模組排序(各自最適合的排序鍵)
    matrix['chu_perfect6'].sort(key=lambda x: (x.get('quality', 0), x['turnover_e']), reverse=True)
    matrix['chu_top_gainer'].sort(key=lambda x: (x.get('gain', 0), x.get('turnover_e', 0)), reverse=True)
    matrix['chu_bottom'].sort(key=lambda x: x.get('gain', 0), reverse=True)
    matrix['chu_riding5ma'].sort(key=lambda x: x.get('cum_5d', 0), reverse=True)
    matrix['chu_backtest'].sort(key=lambda x: x.get('expectancy', 0), reverse=True)
    # 🎯 回後買上漲:高勝率在前、無淘汰紅旗在前、上方空間大在前
    matrix['chu_entry'].sort(key=lambda x: (x.get('grade') == 'high', not x.get('red_flags'),
                                            x.get('upside_room', 0), x.get('turnover_e', 0)), reverse=True)
    # 📐📦🔀 葛蘭碧/橫盤突破/背離:成交額大到小(流動性優先)
    matrix['chu_granville'].sort(key=lambda x: x.get('turnover_e', 0), reverse=True)
    matrix['chu_box'].sort(key=lambda x: x.get('turnover_e', 0), reverse=True)
    matrix['chu_diverge'].sort(key=lambda x: x.get('turnover_e', 0), reverse=True)

    # 📐 K棒轉折雷達:成交額大到小(流動性優先,散戶好進出)
    matrix['kbar_bull'].sort(key=lambda x: x['turnover_e'], reverse=True)
    matrix['kbar_bear'].sort(key=lambda x: x['turnover_e'], reverse=True)
    # 🎯 口袋支點:成交額大到小;🚀 相對強度:超額報酬由高到低
    matrix['pocket_pivot'].sort(key=lambda x: x['turnover_e'], reverse=True)
    matrix['rs_strong'].sort(key=lambda x: x.get('rs', 0), reverse=True)

    # 輸出最終雷達矩陣
    output = {
        'updated': date.today().isoformat(),
        'scanned_count': processed_count,
        'data': {
            'momentum': matrix['momentum'][:20],  # 各取最強的前 20 檔
            'swing': matrix['swing'][:20],
            'sniper': matrix['sniper'][:20],
            # 📚 朱家泓五大選股法
            'chu_perfect6': matrix['chu_perfect6'][:20],
            'chu_top_gainer': matrix['chu_top_gainer'][:30],
            'chu_bottom': matrix['chu_bottom'][:20],
            'chu_riding5ma': matrix['chu_riding5ma'][:20],
            'chu_backtest': matrix['chu_backtest'][:30],
            'chu_entry': matrix['chu_entry'][:30],   # 🎯 回後買上漲(建議2)
            'chu_granville': matrix['chu_granville'][:30],   # 📐 葛蘭碧買點(建議2)
            'chu_box': matrix['chu_box'][:30],               # 📦 橫盤突破(建議2)
            'chu_diverge': matrix['chu_diverge'][:30],       # 🔀 背離(建議2)
            # 📐 K棒轉折雷達(各取前 30 檔)
            'kbar_bull': matrix['kbar_bull'][:30],
            'kbar_bear': matrix['kbar_bear'][:30],
            # 🎯🚀 口袋支點 / 相對強度(各取前 30 檔)
            'pocket_pivot': matrix['pocket_pivot'][:30],
            'rs_strong': matrix['rs_strong'][:30],
        }
    }

    DATA_DIR.mkdir(exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(output, ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8'
    )

    print(f"✅ 雷達矩陣建構完畢！共掃描 {processed_count} 檔。")
    print(f"   🏎️ 渣男賽車: {len(output['data']['momentum'])} 檔")
    print(f"   🐢 烏龜過河: {len(output['data']['swing'])} 檔")
    print(f"   🎯 狙擊手: {len(output['data']['sniper'])} 檔")
    print(f"   📚 朱家泓五大選股法:")
    print(f"      🍀 六六大順: {len(output['data']['chu_perfect6'])} 檔")
    print(f"      🔥 特別報價: {len(output['data']['chu_top_gainer'])} 檔")
    print(f"      🥣 底部轉折: {len(output['data']['chu_bottom'])} 檔")
    print(f"      🚀 5MA飆股: {len(output['data']['chu_riding5ma'])} 檔")
    print(f"      🎯 回後買上漲: {len(output['data']['chu_entry'])} 檔(旗艦訊號全市場)")
    print(f"      📐 葛蘭碧買點: {len(output['data']['chu_granville'])} 檔 / 📦 橫盤突破: {len(output['data']['chu_box'])} 檔 / 🔀 背離: {len(output['data']['chu_diverge'])} 檔")
    print(f"   📐 K棒轉折雷達:🌅 轉多 {len(output['data']['kbar_bull'])} 檔 / 🌃 轉空 {len(output['data']['kbar_bear'])} 檔")
    print(f"💾 已匯出至 {OUTPUT_FILE}")


# ────────────────────────────────────────────────────────────
# 🚨 戰區二升級:處置門檻價預估算式(純運算,不打 API)
# ────────────────────────────────────────────────────────────
def estimate_attention_threshold(ohlcv_data):
    """近 10 日 OHLCV 分析,模擬下一日達 TWSE 注意/處置條款機率。
    回傳 dict:{score: 0-100, status: '🚨/⚠️/✅', reasons: [...]}

    參考 TWSE 三大主要條款:
    1. 連 3 日累計漲跌 18% → 預警
    2. 近 6 日累計漲跌 25% → 預警
    3. 近 10 中 6 個營業日 |日漲跌| > 5% → 預警
    """
    if not isinstance(ohlcv_data, list) or len(ohlcv_data) < 6:
        return None
    last_10 = ohlcv_data[-10:]
    if len(last_10) < 3:
        return None

    score = 0
    reasons = []

    # 條款 1:連 3 日累計漲跌
    try:
        if len(last_10) >= 4:
            chg_3day = (last_10[-1]['close'] - last_10[-4]['close']) / last_10[-4]['close'] * 100
            if abs(chg_3day) > 15:
                score += 35
                reasons.append(f"連 3 日累 {chg_3day:+.1f}%(近 18% 門檻)")
            elif abs(chg_3day) > 10:
                score += 15
                reasons.append(f"連 3 日累 {chg_3day:+.1f}%")
    except (KeyError, ZeroDivisionError, TypeError):
        pass

    # 條款 2:近 6 日累計漲跌
    try:
        if len(last_10) >= 7:
            chg_6day = (last_10[-1]['close'] - last_10[-7]['close']) / last_10[-7]['close'] * 100
            if abs(chg_6day) > 22:
                score += 35
                reasons.append(f"6 日累 {chg_6day:+.1f}%(近 25% 門檻)")
            elif abs(chg_6day) > 15:
                score += 15
                reasons.append(f"6 日累 {chg_6day:+.1f}%")
    except (KeyError, ZeroDivisionError, TypeError):
        pass

    # 條款 3:近 10 日大波動天數
    try:
        big_move = 0
        for i in range(1, len(last_10)):
            prev_close = last_10[i-1].get('close', 0)
            if prev_close > 0:
                daily_chg = (last_10[i]['close'] - prev_close) / prev_close * 100
                if abs(daily_chg) > 5:
                    big_move += 1
        if big_move >= 5:
            score += 30
            reasons.append(f"10 日 {big_move}/10 大波動(近 6 次門檻)")
        elif big_move >= 4:
            score += 15
            reasons.append(f"10 日 {big_move}/10 大波動")
    except (KeyError, TypeError):
        pass

    if score >= 70:
        status = '🚨 明日恐達處置門檻'
    elif score >= 40:
        status = '⚠️ 接近警戒區'
    else:
        return None  # score < 40 不存,只記錄高風險的

    return {
        'score': min(score, 100),
        'status': status,
        'reasons': reasons[:3],
        'latest_close': last_10[-1].get('close'),
    }


def build_attention_forecast():
    """掃全市場 data/*.json,對近期波動大的股票算處置門檻達標機率,
    寫 data/attention_forecast.json 供前端【🚨 妖股處置神器】顯示。
    """
    print("\n🚨 啟動【處置門檻價預估】算式(戰區二)...")
    forecast = {}
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue
        try:
            raw = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(raw, list):
                continue
            est = estimate_attention_threshold(raw)
            if est:
                forecast[sym] = est
        except Exception:
            continue
    out_file = DATA_DIR / "attention_forecast.json"
    payload = {
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "total": len(forecast),
        "stocks": forecast,
    }
    try:
        out_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f"   ✅ 處置門檻預估:{len(forecast)} 檔達警戒區 → {out_file}")
    except Exception as e:
        print(f"   ❌ attention_forecast.json 寫檔失敗:{e}")


# ── 🦅 獵鷹建倉分:全市場每股 0-100 空手建倉評分(融合個股微觀 + 全球宏觀煞車)──
# 個股→族群反查(對齊 miner.py SUB_SECTORS / 前端 _industrySectors)
_FALCON_SECTORS = {
    'us': ['2330', '3711'], 'server': ['2382', '6669', '3231'],
    'power': ['1519', '1503', '1513'], 'packaging': ['2330', '3711', '3131'],
    'cpo': ['3081', '3450', '3363'], 'cooling': ['3017', '3324', '3653'],
    'robot': ['2359', '6188', '1568'], 'finance': ['2881', '2882', '2891'],
    'leo': ['3491', '2313', '6285'], 'dram': ['2408', '2344', '8299'],
}
_SYM2SECTOR = {s: k for k, syms in _FALCON_SECTORS.items() for s in syms}


def _falcon_ma(closes, n):
    return sum(closes[-n:]) / n if len(closes) >= n else None


def build_falcon_scores():
    """🦅 全市場每股算「獵鷹建倉分」(0-100,空手建倉吸引力),寫 data/falcon_scores.json。
    微觀(技術/低PE/流動性/族群/分點)在個股算,宏觀黑天鵝(讀 macro_risk.json)全市場同步套用。
    全程 try/except 包覆,任何來源缺失皆 graceful 退回中性,絕不崩潰。
    """
    print("\n🦅 啟動【獵鷹建倉分】全市場評分引擎...")
    from datetime import date as _date  # 哲哲抗跌 + 資料新鮮度共用
    today = _date.today()
    # 1) 讀全球宏觀黑天鵝旗標(macro_miner 已在前一步產出)
    blackswan, macro_lines = {}, []
    try:
        mr = json.loads((DATA_DIR / "macro_risk.json").read_text(encoding='utf-8'))
        blackswan = mr.get("blackswan") or {}
    except Exception as e:
        print(f"   ⚠️ 讀 macro_risk.json 失敗,宏觀煞車本輪略過:{e}")
    if blackswan.get("market_bias_high"): macro_lines.append("大盤懼高×0.7")
    if blackswan.get("jpy_surge"):        macro_lines.append("日圓套利平倉-20")
    if blackswan.get("metal_oil_spike"):  macro_lines.append("金油暴漲避險-20")
    if blackswan.get("kospi_dump"):       macro_lines.append("亞股提款-10")

    # 1.5) 🎯 哲哲抗跌狙擊:預先算大盤本週一最低 vs 今日最低,個股迴圈內套用
    def _find_monday_low(_rows):
        """從 rows 倒數最近 7 筆找 weekday==0 (Monday) 的 low;放假時挑本週第一個交易日"""
        if not isinstance(_rows, list):
            return None
        for r in reversed(_rows[-7:]):
            try:
                d = _date.fromisoformat(str(r.get('date', '')).replace('/', '-'))
                if d.weekday() == 0:
                    lo = r.get('low')
                    if isinstance(lo, (int, float)):
                        return lo
            except Exception:
                continue
        # 找不到週一(連續假期)→ 退回本週第一筆有效 low
        for r in _rows[-5:]:
            try:
                d = _date.fromisoformat(str(r.get('date', '')).replace('/', '-'))
                if d >= today - timedelta(days=today.weekday()):
                    lo = r.get('low')
                    if isinstance(lo, (int, float)):
                        return lo
            except Exception:
                continue
        return None
    from datetime import timedelta
    twii_break_mon = False
    try:
        twii_path = DATA_DIR / "^TWII.json"
        if twii_path.exists():
            twii_raw = json.loads(twii_path.read_text(encoding='utf-8'))
            twii_rows = twii_raw if isinstance(twii_raw, list) else (twii_raw.get('data') or twii_raw.get('ohlcv') or [])
            twii_mon_low = _find_monday_low(twii_rows)
            twii_today_low = twii_rows[-1].get('low') if twii_rows else None
            if isinstance(twii_mon_low, (int, float)) and isinstance(twii_today_low, (int, float)):
                twii_break_mon = twii_today_low < twii_mon_low
                print(f"   🎯 大盤本週一低 {twii_mon_low} vs 今日低 {twii_today_low} → 跌破週一? {twii_break_mon}")
            else:
                print(f"   ℹ️ 大盤週一低/今日低資料不足,哲哲抗跌本輪略過(mon={twii_mon_low}, today={twii_today_low})")
        else:
            print("   ℹ️ ^TWII.json 不存在,哲哲抗跌本輪略過")
    except Exception as e:
        print(f"   ⚠️ 哲哲抗跌讀 ^TWII 失敗(不影響其他):{e}")
    if twii_break_mon:
        macro_lines.append("大盤破週一低·哲哲抗跌啟動")

    # 2) 全市場 PE 快取(miner.py 產)+ 族群熱度(sector_heat.json,缺則略)
    fund_cache, sector_chg = {}, {}
    try:
        fund_cache = json.loads((DATA_DIR / "fundamentals_cache.json").read_text(encoding='utf-8'))
    except Exception:
        pass
    try:
        sh = json.loads((DATA_DIR / "sector_heat.json").read_text(encoding='utf-8'))
        for k, v in (sh.get("sectors") or {}).items():
            if isinstance(v, dict) and isinstance(v.get("chg"), (int, float)):
                sector_chg[k] = v["chg"]
    except Exception:
        pass

    scores = {}  # _date / today / _find_monday_low / twii_break_mon 已在開頭定義
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue
        try:
            raw = json.loads(f.read_text(encoding='utf-8'))
            rows = raw if isinstance(raw, list) else (raw.get('data') or raw.get('ohlcv') or [])
            if not isinstance(rows, list) or len(rows) < 22:
                continue
            closes = [r.get('close') for r in rows if r.get('close')]
            if len(closes) < 22:
                continue
            c = closes[-1]
            ma5, ma20, ma60 = _falcon_ma(closes, 5), _falcon_ma(closes, 20), _falcon_ma(closes, 60)
            base, factors = 50, []

            # ── 技術面 (±25) ──
            if ma20:
                if c > ma20:
                    base += 10; factors.append("站上月線+10")
                else:
                    base -= 15; factors.append("跌破月線-15")
                bias20 = (c - ma20) / ma20 * 100
                if 0 <= bias20 <= 8:
                    base += 5; factors.append("乖離健康+5")
                elif bias20 > 20:
                    base -= 20; factors.append(f"乖離過大{bias20:.0f}%-20")   # V27.4 追高重災區,加重防套牢
                elif bias20 > 15:
                    base -= 12; factors.append(f"乖離過熱{bias20:.0f}%-12")   # V27.4 原 -10 加重
            if ma5 and ma20 and ma60 and ma5 > ma20 > ma60:
                base += 10; factors.append("多頭排列+10")
            if ma60 and c > ma60:
                base += 5; factors.append("站季線+5")

            # ── 低本益比 (±10) ──
            pe = (fund_cache.get(sym) or {}).get('pe')
            if isinstance(pe, (int, float)):
                if pe <= 0:
                    base -= 10; factors.append("虧損-10")
                elif pe < 15:
                    base += 10; factors.append(f"低PE{pe:.0f}+10")
                elif pe <= 25:
                    base += 3
                elif pe > 40:
                    base -= 5; factors.append(f"高PE{pe:.0f}-5")

            # ── 小型股流動性陷阱 (±, volume 股數 ÷1000 = 張) ──
            vols = [r.get('volume', 0) or 0 for r in rows[-5:]]
            avg_lots = (sum(vols) / len(vols) / 1000) if vols else 0
            if avg_lots < 200:
                base -= 30; factors.append("殭屍量-30")
            elif avg_lots < 500:
                base -= 10; factors.append("量稀-10")
            elif avg_lots > 50000:
                base += 5; factors.append("大量+5")

            # ── 同族群龍頭連動 (±5,僅 ~30 檔有族群) ──
            sec = _SYM2SECTOR.get(sym)
            if sec and sec in sector_chg:
                if sector_chg[sec] > 1:
                    base += 5; factors.append("族群強+5")
                elif sector_chg[sec] < -1:
                    base -= 5; factors.append("族群弱-5")

            # ── 主力分點 3 日連續性 (±8 或 ±3,僅 ~50 檔有 chips) ──
            # 改為「最近 3 日 majority」防隔日沖騙線:單日暴增不再 +8,只給 +3
            try:
                cf = CHIPS_DIR / f"{sym}.json"
                if cf.exists():
                    cj = json.loads(cf.read_text(encoding='utf-8'))
                    days = cj if isinstance(cj, list) else (cj.get('chips') or [])
                    recent3 = days[-3:] if days else []
                    sigs = []
                    for d in recent3:
                        bnet = sum(b.get('net', 0) for b in (d.get('buyers') or []))
                        snet = sum(abs(s.get('net', 0)) for s in (d.get('sellers') or []))
                        if bnet > snet * 1.2:   sigs.append('buy')
                        elif snet > bnet * 1.2: sigs.append('sell')
                        else:                   sigs.append('flat')
                    buy_days = sigs.count('buy')
                    sell_days = sigs.count('sell')
                    if buy_days >= 2:
                        base += 8; factors.append(f"主力連{buy_days}日買超+8")
                    elif sell_days >= 2:
                        base -= 8; factors.append(f"主力連{sell_days}日賣超-8")
                    elif sigs and sigs[-1] == 'buy':
                        # 只當日暴增、前 2 日反向/平淡 → 半信半疑(防隔日沖)
                        base += 3; factors.append("主力單日暴增+3")
                    elif sigs and sigs[-1] == 'sell':
                        base -= 3; factors.append("主力單日大賣-3")
            except Exception:
                pass

            # ── 🚨 V27.4 出貨/追高風險扣分(降低套牢率;資料皆在 rows,缺值 graceful 跳過)──
            try:
                # 融資爆增(散戶追高陷阱):近 5 日融資餘額暴衝
                mb = [r.get('margin_balance') for r in rows[-6:] if isinstance(r.get('margin_balance'), (int, float))]
                if len(mb) >= 2 and mb[0] > 0:
                    mb_chg = (mb[-1] - mb[0]) / mb[0] * 100
                    if mb_chg > 25:
                        base -= 8; factors.append(f"融資爆增{mb_chg:.0f}%-8")
                    elif mb_chg > 15:
                        base -= 4; factors.append(f"融資增{mb_chg:.0f}%-4")
            except Exception:
                pass
            try:
                # 融券爆增(空方壓力上升,偏風險)
                sb = [r.get('short_balance') for r in rows[-6:] if isinstance(r.get('short_balance'), (int, float))]
                if len(sb) >= 2 and sb[0] > 0:
                    sb_chg = (sb[-1] - sb[0]) / sb[0] * 100
                    if sb_chg > 50:
                        base -= 5; factors.append(f"融券爆增{sb_chg:.0f}%-5")
            except Exception:
                pass
            try:
                # 外資連 3 日賣超(真出貨,非單日調節):近 3 日每日皆 ≤0 且累計 <0
                f3 = [r.get('foreign_net') for r in rows[-3:] if isinstance(r.get('foreign_net'), (int, float))]
                if len(f3) == 3 and sum(f3) < 0 and all(x <= 0 for x in f3):
                    base -= 8; factors.append("外資連3日賣超-8")
            except Exception:
                pass

            # ── 看盤時間軸信任度(資料新鮮度)──
            stale = False
            try:
                ld = str(rows[-1].get('date', '')).replace('/', '-')
                last_dt = _date.fromisoformat(ld)
                if (today - last_dt).days > 4:   # >4 日曆日(約 >2 交易日)視為舊
                    base -= 5; stale = True; factors.append("資料偏舊-5")
            except Exception:
                pass

            # 🎯 哲哲抗跌狙擊:大盤跌破本週一低 + 個股不破本週一低 → +20(強勢主力鎖碼鐵證)
            if twii_break_mon:
                try:
                    s_mon_low = _find_monday_low(rows)
                    s_today_low = rows[-1].get('low')
                    if (isinstance(s_mon_low, (int, float))
                            and isinstance(s_today_low, (int, float))
                            and s_today_low > s_mon_low):
                        base += 20; factors.append("哲哲抗跌+20")
                except Exception:
                    pass

            base = max(0, min(100, round(base)))

            # ── 🌍 全球宏觀黑天鵝煞車(全市場同步)──
            score = base
            if blackswan.get("market_bias_high"):
                score = round(score * 0.7)
            if blackswan.get("jpy_surge") or blackswan.get("metal_oil_spike"):
                score -= 20
            if blackswan.get("kospi_dump"):
                score -= 10
            score = max(0, min(100, score))

            if score >= 75:   label = "🦅 強力建倉"
            elif score >= 60: label = "✅ 可建倉"
            elif score >= 45: label = "🟡 觀望"
            else:             label = "🔴 避開"

            scores[sym] = {"score": score, "base": base, "label": label,
                           "factors": factors[:6], "stale": stale, "close": round(c, 2)}
        except Exception:
            continue

    payload = {
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "macro_flags": blackswan,
        "macro_lines": macro_lines,
        "total": len(scores),
        "stocks": scores,
    }
    try:
        (DATA_DIR / "falcon_scores.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(f"   ✅ 獵鷹建倉分:{len(scores)} 檔評分完成,宏觀煞車={macro_lines or '無'} → falcon_scores.json")
    except Exception as e:
        print(f"   ❌ falcon_scores.json 寫檔失敗:{e}")


if __name__ == '__main__':
    main()
    # 🚨 雷達矩陣完成後,順手抓注意/處置股名單(獨立 try,失敗不影響雷達)
    try:
        fetch_attention_disposal_status()
    except Exception as e:
        print(f"💥 處置神器頂層異常(不影響雷達矩陣):{e}")
    # 🚨 戰區二:處置門檻價預估(純算式,失敗也不影響上面兩個)
    try:
        build_attention_forecast()
    except Exception as e:
        print(f"💥 處置門檻預估頂層異常(不影響其他):{e}")
    # 🦅 獵鷹建倉分:全市場空手建倉評分(獨立 try,需 macro_risk.json 已產出)
    try:
        build_falcon_scores()
    except Exception as e:
        print(f"💥 獵鷹建倉分頂層異常(不影響其他):{e}")
