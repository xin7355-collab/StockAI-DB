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


def main():
    print("📊 訊號勝率回測啟動...")
    DATA_DIR.mkdir(exist_ok=True)
    agg = {}  # signal -> {'n':, 'win5':, 'win10':, 'sum5':, 'sum10':, 'c5':, 'c10':}

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

    payload = {
        'updated': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'replay_days': REPLAY_DAYS,
        'scanned_stocks': scanned,
        'by_signal': by_signal,
        '_note': '回測歷史訊號的往後 5/10 日勝率;過去績效不代表未來,僅供參考紀律。',
    }
    OUTPUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"✅ 回測完成 — 掃 {scanned} 檔 → {OUTPUT_FILE}")
    for sig, st in by_signal.items():
        print(f"   {sig}: {st['samples']} 樣本, 10日勝率 {st['win_rate_10d']}%, 平均 {st['avg_return_10d']}%")


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"💥 backtest 頂層例外(不影響其他):{e}")
