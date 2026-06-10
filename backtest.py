#!/usr/bin/env python3
"""📊 訊號勝率回測(Tier 4)— 讓使用者知道系統準不準,才敢照訊號買。

掃 data/*.json,回放最近 ~90 個交易日的「⭐送分題綠燈」訊號,
往後看 5 日 / 10 日報酬,統計各訊號的歷史勝率與平均報酬。

複刻前端 computeUnifiedSignal 的綠燈核心邏輯(站月線 + 多頭排列 + 法人連買),
確保回測結果與線上實際吐出的燈號一致。

輸出 data/signal_history.json 供前端「系統準度」卡讀取。
純運算、不打任何 API、絕不拋例外。
"""
import json
from pathlib import Path
from datetime import datetime

DATA_DIR = Path("data")
OUTPUT_FILE = DATA_DIR / "signal_history.json"

REPLAY_DAYS = 90      # 回放最近幾個交易日
FWD_WINDOWS = (5, 10) # 往後看幾日報酬
MIN_HISTORY = 70      # 至少要有幾天才能算 ma60 + 回放


def _ma(closes, idx, period):
    """closes[idx] 當日往回 period 日均線(含當日)。不足回 None。"""
    if idx + 1 < period:
        return None
    seg = closes[idx - period + 1: idx + 1]
    return sum(seg) / period if seg else None


def _inst_sum(row):
    return ((row.get('foreign_net') or row.get('foreign_inv') or 0)
            + (row.get('trust_net') or row.get('invest_trust') or 0))


def classify_signal(rows, idx):
    """複刻前端綠燈核心:回 '🟢送分題' / '🟢趨勢' / '🟡' / None(非正向不統計)。
    只統計正向訊號的勝率(使用者最在意「叫我買的準不準」)。
    """
    closes = [r.get('close', 0) for r in rows]
    c = closes[idx]
    if c <= 0:
        return None
    ma5 = _ma(closes, idx, 5)
    ma20 = _ma(closes, idx, 20)
    ma60 = _ma(closes, idx, 60)
    if ma5 is None or ma20 is None:
        return None
    if c < ma20:          # 跌破月線 = 負向,不列入「買進訊號」統計
        return None
    ma_bullish = (ma5 > ma20) and (ma60 is None or ma20 > ma60)
    # 法人連買天數 + 近10日買超天數
    streak = 0
    for j in range(idx, max(idx - 10, -1), -1):
        if _inst_sum(rows[j]) > 0:
            streak += 1
        else:
            break
    look = rows[max(0, idx - 9): idx + 1]
    inst_days = sum(1 for r in look if _inst_sum(r) > 0)
    inst_support = streak >= 3 or inst_days >= 6
    if ma_bullish and inst_support:
        return '🟢送分題'
    if ma_bullish:
        return '🟡偏多'
    return None


def backtest_one(rows):
    """回放單檔,回傳 list of (signal, fwd5_ret%, fwd10_ret%)。"""
    out = []
    n = len(rows)
    if n < MIN_HISTORY:
        return out
    # 留出最大 forward window,從 (n-1-max_fwd) 往回 REPLAY_DAYS 天
    max_fwd = max(FWD_WINDOWS)
    end = n - 1 - max_fwd
    start = max(MIN_HISTORY - 1, end - REPLAY_DAYS)
    closes = [r.get('close', 0) for r in rows]
    for idx in range(start, end + 1):
        sig = classify_signal(rows, idx)
        if not sig:
            continue
        base = closes[idx]
        if base <= 0:
            continue
        rets = {}
        for w in FWD_WINDOWS:
            fc = closes[idx + w]
            rets[w] = (fc - base) / base * 100 if fc > 0 else None
        out.append((sig, rets.get(5), rets.get(10)))
    return out


def _falcon_score_simplified(rows, idx):
    """🦅 簡化版獵鷹建倉分(回測用,只算微觀因子,不含全球宏觀煞車):
    技術面 ±25(站月線/多頭排列/乖離健康)+ 流動性 ±(殭屍 -30 / 大量 +5)。
    回傳 0-100;資料不足回 None。"""
    if idx < 22:
        return None
    closes = [r.get('close') for r in rows[:idx + 1] if r.get('close')]
    if len(closes) < 22:
        return None
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
    if ma5 and ma20 and ma60 and ma5 > ma20 > ma60:
        base += 10
    if ma60 and c > ma60:
        base += 5
    # 流動性(近 5 日均量,股 ÷1000 = 張)
    vols = [r.get('volume', 0) or 0 for r in rows[max(0, idx - 4):idx + 1]]
    if vols:
        avg_lots = sum(vols) / len(vols) / 1000
        if avg_lots < 200: base -= 30
        elif avg_lots < 500: base -= 10
        elif avg_lots > 50000: base += 5
    return max(0, min(100, round(base)))


def backtest_falcon(rows):
    """🦅 獵鷹回測:對每天歷史 bar 算簡化獵鷹分,記錄「≥75 進場、隔日報酬」。
    回傳 list of (score_bucket, next_day_ret%);bucket: 'falcon75' / 'falcon60' / 'falcon45'。
    """
    results = []
    n = len(rows)
    for i in range(22, n - 1):
        score = _falcon_score_simplified(rows, i)
        if score is None:
            continue
        c_today = rows[i].get('close')
        c_next = rows[i + 1].get('close')
        if not (c_today and c_next and c_today > 0):
            continue
        ret = (c_next - c_today) / c_today * 100
        if score >= 75: bucket = 'falcon75'
        elif score >= 60: bucket = 'falcon60'
        elif score >= 45: bucket = 'falcon45'
        else: continue   # <45 不統計
        results.append((bucket, ret))
    return results


def main():
    print("📊 訊號勝率回測啟動...")
    DATA_DIR.mkdir(exist_ok=True)
    agg = {}  # signal -> {'n':, 'win5':, 'win10':, 'sum5':, 'sum10':, 'c5':, 'c10':}
    falcon_agg = {}   # 🦅 獵鷹回測:bucket -> {'n', 'wins', 'sum_ret'}

    def _slot(sig):
        return agg.setdefault(sig, {'n': 0, 'win5': 0, 'win10': 0,
                                    'sum5': 0.0, 'sum10': 0.0, 'c5': 0, 'c10': 0})

    scanned = 0
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue
        try:
            rows = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(rows, list):
                continue
            for sig, r5, r10 in backtest_one(rows):
                s = _slot(sig)
                s['n'] += 1
                if r5 is not None:
                    s['c5'] += 1; s['sum5'] += r5
                    if r5 > 0: s['win5'] += 1
                if r10 is not None:
                    s['c10'] += 1; s['sum10'] += r10
                    if r10 > 0: s['win10'] += 1
            # 🦅 獵鷹回測:統計 ≥75/≥60/≥45 三檔的隔日勝率
            for bucket, ret in backtest_falcon(rows):
                fs = falcon_agg.setdefault(bucket, {'n': 0, 'wins': 0, 'sum_ret': 0.0})
                fs['n'] += 1
                fs['sum_ret'] += ret
                if ret > 0: fs['wins'] += 1
            scanned += 1
        except Exception:
            continue

    by_signal = {}
    for sig, s in agg.items():
        if s['n'] == 0:
            continue
        by_signal[sig] = {
            'samples': s['n'],
            'win_rate_5d': round(s['win5'] / s['c5'] * 100, 1) if s['c5'] else None,
            'win_rate_10d': round(s['win10'] / s['c10'] * 100, 1) if s['c10'] else None,
            'avg_return_5d': round(s['sum5'] / s['c5'], 2) if s['c5'] else None,
            'avg_return_10d': round(s['sum10'] / s['c10'], 2) if s['c10'] else None,
        }

    # 🦅 獵鷹策略回測結果
    falcon_strategy = {}
    for bucket, fs in falcon_agg.items():
        if fs['n'] == 0:
            continue
        falcon_strategy[bucket] = {
            'samples': fs['n'],
            'win_rate': round(fs['wins'] / fs['n'] * 100, 1),
            'avg_return': round(fs['sum_ret'] / fs['n'], 2),
        }

    payload = {
        'updated': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'replay_days': REPLAY_DAYS,
        'scanned_stocks': scanned,
        'by_signal': by_signal,
        'falcon_strategy': falcon_strategy,
        '_note': '回測歷史訊號的往後 5/10 日勝率;獵鷹策略統計「分≥75/60/45 隔日報酬」;過去績效不代表未來。',
    }
    print(f"\n🦅 獵鷹回測結果:")
    for bucket, st in falcon_strategy.items():
        print(f"   {bucket}: {st['samples']} 樣本, 隔日勝率 {st['win_rate']}%, 平均 {st['avg_return']}%")
    OUTPUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"✅ 回測完成 — 掃 {scanned} 檔 → {OUTPUT_FILE}")
    for sig, st in by_signal.items():
        print(f"   {sig}: {st['samples']} 樣本, 10日勝率 {st['win_rate_10d']}%, 平均 {st['avg_return_10d']}%")


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"💥 backtest 頂層例外(不影響其他):{e}")
