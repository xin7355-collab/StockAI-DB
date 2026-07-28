#!/usr/bin/env python3
"""🔬 Walk-forward 樣本外驗證(防 overfit)

把過去 480 天切成「訓練集 384 天 + 驗證集 96 天」(8:2),分別計算每訊號的勝率,
比對「訓練 vs 驗證」差距 (gap):
- gap ≤ 5pp = ✅ 穩健(訊號真的有效)
- 5 < gap ≤ 10pp = 🟡 中性(略有差異,可保留觀察)
- gap > 10pp = ⛔ 疑似 overfit(歷史好不代表未來會好,別信)

輸出 data/walk_forward.json 供前端「回測」tab 顯示。
"""
import json
import math
from pathlib import Path
from datetime import datetime

# reuse backtest.py 的所有 SIGNALS / cost helpers
from backtest import (
    SIGNALS, FWD_WINDOWS, MIN_HISTORY, ROUND_TRIP_COST_PCT,
    apply_real_cost, _avg_volume_lots, _load_attention_set, DATA_DIR,
)

OUTPUT_FILE = DATA_DIR / "walk_forward.json"
TOTAL_LOOKBACK = 480       # 取近 480 天
TRAIN_RATIO    = 0.80      # 訓練集 384 天
TEST_RATIO     = 0.20      # 驗證集 96 天
FWD = 10                   # 只看 10 日報酬(主要觀察視窗)


def _scan_split(rows, sym, attention_set, idx_start, idx_end):
    """掃描 [idx_start, idx_end) 區間,回傳每訊號的 (wins, total) 對。"""
    out = {name: [0, 0] for name in SIGNALS}   # name -> [wins, total]
    closes = [r.get('close', 0) for r in rows]
    if sym in attention_set:
        return out
    for idx in range(idx_start, idx_end):
        if idx + FWD >= len(rows): break
        base = closes[idx]
        if base <= 0: continue
        for name, fn in SIGNALS.items():
            try:
                if not fn(rows, idx): continue
            except Exception:
                continue
            fc = closes[idx + FWD]
            if fc <= 0: continue
            ret_net = apply_real_cost((fc - base) / base * 100)
            out[name][1] += 1
            if ret_net > 0:
                out[name][0] += 1
    return out


def _classify_gap(gap):
    if gap is None: return None, '?'
    a = abs(gap)
    if a <= 5: return '✅ 穩健', '#34d399'
    if a <= 10: return '🟡 中性', '#facc15'
    return '⛔ 疑似 overfit', '#f87171'


def main():
    print(f"🔬 Walk-forward 樣本外驗證 — 切 {TRAIN_RATIO:.0%} 訓練 / {TEST_RATIO:.0%} 驗證")
    DATA_DIR.mkdir(exist_ok=True)
    attention_set = _load_attention_set()

    train_agg = {name: [0, 0] for name in SIGNALS}  # [wins, total]
    test_agg  = {name: [0, 0] for name in SIGNALS}

    scanned = 0
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue
        try:
            rows = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(rows, list) or len(rows) < MIN_HISTORY + FWD: continue
            avg60 = _avg_volume_lots(rows, len(rows) - 1, period=60)
            if avg60 is not None and avg60 < 200: continue

            n = len(rows)
            window_end = n - 1 - FWD
            window_start = max(MIN_HISTORY - 1, window_end - TOTAL_LOOKBACK)
            window_len = window_end - window_start
            if window_len < 100: continue
            train_end = window_start + int(window_len * TRAIN_RATIO)

            # 訓練集:[window_start, train_end)
            for name, (wins, tot) in _scan_split(rows, sym, attention_set, window_start, train_end).items():
                train_agg[name][0] += wins
                train_agg[name][1] += tot
            # 驗證集:[train_end, window_end)
            for name, (wins, tot) in _scan_split(rows, sym, attention_set, train_end, window_end).items():
                test_agg[name][0] += wins
                test_agg[name][1] += tot
            scanned += 1
        except Exception:
            continue

    results = {}
    for name in SIGNALS:
        tw, tt = train_agg[name]
        vw, vt = test_agg[name]
        train_wr = round(tw / tt * 100, 1) if tt else None
        test_wr  = round(vw / vt * 100, 1) if vt else None
        gap = round(test_wr - train_wr, 1) if (train_wr is not None and test_wr is not None) else None
        verdict, color = _classify_gap(gap)
        results[name] = {
            'train_wr': train_wr,
            'train_samples': tt,
            'test_wr':  test_wr,
            'test_samples':  vt,
            'gap': gap,
            'verdict': verdict,
            'color': color,
            'low_confidence': (vt is not None and vt < 30),  # 驗證樣本不足 30 → 統計顯著性低
        }

    # 排序:訓練樣本多 + 穩健優先
    payload = {
        'updated': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'train_ratio': TRAIN_RATIO,
        'test_ratio': TEST_RATIO,
        'fwd_window': FWD,
        'scanned_stocks': scanned,
        'cost_pct': round(ROUND_TRIP_COST_PCT, 3),
        'signals': results,
        '_note': '訓練/驗證 80%/20% 切資料,gap = 驗證勝率 - 訓練勝率;|gap| > 10pp 疑似 overfit。驗證樣本 < 30 統計顯著性不足。',
    }
    OUTPUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"✅ Walk-forward 完成 — 掃 {scanned} 檔 → {OUTPUT_FILE}")
    print(f"\n📊 樣本外勝率對比(訓練 vs 驗證):")
    rankable = sorted(
        ((n, r) for n, r in results.items() if r['train_wr'] is not None and r['test_wr'] is not None),
        key=lambda x: -(x[1]['train_samples'] or 0)
    )
    for name, r in rankable:
        lc = ' ⚠️ 樣本少' if r['low_confidence'] else ''
        print(f"   {name:18s} 訓 {r['train_wr']:5.1f}% / 測 {r['test_wr']:5.1f}% / gap {r['gap']:+.1f}pp · {r['verdict']}{lc}")


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"❌ walk_forward.py 失敗(不致命,daily_miner 仍會繼續):{e}")
