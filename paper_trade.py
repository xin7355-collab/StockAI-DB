#!/usr/bin/env python3
"""📝 Paper Trade 紙上跟單(Day 3 路徑 D 驗證未來預測力)

從今天開始每日記錄系統發出的訊號 + 1/3/5/10 日後真實收盤價,
累積 1-3 個月後算實際勝率,反映滑價/漲跌停/處置等真實成本。

零成本驗證:歷史回測勝率 ≠ 實戰勝率,差距(reality gap)就在這顯現。

每日由 daily_miner.yml 結尾呼叫一次,輸出 data/paper_trades.json。
"""
import json
import sys
from pathlib import Path
from datetime import datetime, date

# Reuse backtest.py 的 helpers(15 訊號 + 機構級指標 + 真實成本)
sys.path.insert(0, str(Path(__file__).parent))
from backtest import (
    SIGNALS, MIN_HISTORY,
    _falcon_score_simplified, _avg_volume_lots,
    sig_ma_bullish_alignment, apply_real_cost, _load_attention_set,
    ROUND_TRIP_COST_PCT,
)

DATA_DIR = Path("data")
OUTPUT_FILE = DATA_DIR / "paper_trades.json"
TRADE_WINDOWS = (1, 3, 5, 10)   # 追蹤 1/3/5/10 日後報酬
MAX_TRADES_KEEP = 5000          # 最多保留最新 5000 筆,避免 JSON 過大


def _normalize_date(d):
    return str(d).replace('/', '-')


def _find_idx_by_date(rows, target_date):
    target_norm = _normalize_date(target_date)
    for i, r in enumerate(rows):
        if _normalize_date(r.get('date', '')) == target_norm:
            return i
    return None


def _read_trades():
    """讀既有 paper_trades.json;不存在或解析失敗回空 list"""
    if not OUTPUT_FILE.exists():
        return []
    try:
        d = json.loads(OUTPUT_FILE.read_text(encoding='utf-8'))
        return d.get('trades', []) if isinstance(d, dict) else (d if isinstance(d, list) else [])
    except Exception:
        return []


def record_today_signals(attention_set, today):
    """掃所有 data/*.json,對每檔 last_idx 跑 SIGNALS 字典 + 整套策略,
    記錄今日(last_row.date == today)觸發的 trade。
    """
    new_trades = []
    today_str = today.strftime('%Y-%m-%d')
    scanned = 0
    triggered = 0
    for f in DATA_DIR.glob("*.json"):
        sym = f.stem
        if not (len(sym) == 4 and sym.isdigit()) and not sym.startswith('00'):
            continue
        if sym in attention_set:
            continue   # 處置股 skip(分盤交易實際無法跟單)
        try:
            rows = json.loads(f.read_text(encoding='utf-8'))
            if not isinstance(rows, list) or len(rows) < MIN_HISTORY: continue
            # 殭屍量 skip
            avg60 = _avg_volume_lots(rows, len(rows) - 1, period=60)
            if avg60 is None or avg60 < 200: continue
            # 只記錄「今天」的訊號(避免歷史重複進)
            last_row = rows[-1]
            last_date = _normalize_date(last_row.get('date', ''))
            if last_date != today_str:
                continue
            scanned += 1
            idx = len(rows) - 1
            entry_price = last_row.get('close', 0)
            if entry_price <= 0: continue

            # 跑 15 訊號
            for name, fn in SIGNALS.items():
                try:
                    if not fn(rows, idx): continue
                except Exception:
                    continue
                new_trades.append({
                    'open_date': today_str,
                    'symbol': sym,
                    'signal': name,
                    'entry_close': round(entry_price, 2),
                    'fwd_returns': {},
                    'status': 'open',
                })
                triggered += 1

            # 整套策略(獵鷹 ≥75 + 多頭排列)
            try:
                score = _falcon_score_simplified(rows, idx)
                if score is not None and score >= 75 and sig_ma_bullish_alignment(rows, idx):
                    new_trades.append({
                        'open_date': today_str,
                        'symbol': sym,
                        'signal': '🏆 整套策略(獵鷹≥75+多頭)',
                        'entry_close': round(entry_price, 2),
                        'fwd_returns': {},
                        'status': 'open',
                    })
                    triggered += 1
            except Exception:
                pass
        except Exception:
            continue
    print(f"📝 今日訊號掃描:{scanned} 檔有今日資料,{triggered} 筆訊號觸發")
    return new_trades


def update_open_trades(trades, today):
    """對每筆 open trade,根據今天日期算 fwd_1d/3d/5d/10d 報酬(扣真實成本)。
    10d 填完 → status='closed'。
    """
    updated = 0
    closed = 0
    rows_cache = {}
    def get_rows(sym):
        if sym in rows_cache: return rows_cache[sym]
        f = DATA_DIR / f"{sym}.json"
        if not f.exists():
            rows_cache[sym] = None; return None
        try:
            r = json.loads(f.read_text(encoding='utf-8'))
            rows_cache[sym] = r if isinstance(r, list) else None
            return rows_cache[sym]
        except Exception:
            rows_cache[sym] = None; return None

    for t in trades:
        if t.get('status') != 'open': continue
        rows = get_rows(t['symbol'])
        if not rows: continue
        open_idx = _find_idx_by_date(rows, t['open_date'])
        if open_idx is None: continue
        entry = t.get('entry_close', 0)
        if entry <= 0: continue
        fwd = t.get('fwd_returns') or {}
        any_updated = False
        for w in TRADE_WINDOWS:
            key = f'{w}d'
            if key in fwd: continue   # 已填過跳過
            fwd_idx = open_idx + w
            if fwd_idx >= len(rows): continue
            fwd_close = rows[fwd_idx].get('close', 0)
            if fwd_close <= 0: continue
            gross = (fwd_close - entry) / entry * 100
            net = apply_real_cost(gross)
            fwd[key] = {
                'close': round(fwd_close, 2),
                'date': _normalize_date(rows[fwd_idx].get('date', '')),
                'gross': round(gross, 2),
                'net': round(net, 2),
            }
            any_updated = True
        t['fwd_returns'] = fwd
        if any_updated: updated += 1
        if '10d' in fwd:
            t['status'] = 'closed'
            closed += 1
    print(f"📊 既有 trade 更新:{updated} 筆有新 fwd 資料,{closed} 筆轉 closed")
    return trades


def summarize(trades):
    """按 signal 分組,算實際勝率 + 平均報酬(1/3/5/10 日)"""
    by_sig = {}
    for t in trades:
        sig = t.get('signal')
        if not sig: continue
        slot = by_sig.setdefault(sig, {f'{w}d': {'wins': 0, 'sum': 0.0, 'n': 0} for w in TRADE_WINDOWS})
        for key, val in (t.get('fwd_returns') or {}).items():
            if key not in slot: continue
            net = val.get('net')
            if net is None: continue
            slot[key]['n'] += 1
            slot[key]['sum'] += net
            if net > 0: slot[key]['wins'] += 1
    out = {}
    for sig, by_w in by_sig.items():
        per = {}
        for w_key, s in by_w.items():
            if s['n'] == 0: continue
            per[w_key] = {
                'samples': s['n'],
                'win_rate': round(s['wins'] / s['n'] * 100, 1),
                'avg_return': round(s['sum'] / s['n'], 2),
            }
        if per: out[sig] = per
    return out


def main():
    today = date.today()
    print(f"📝 Paper Trade 紙上跟單 — {today.strftime('%Y-%m-%d')}")
    DATA_DIR.mkdir(exist_ok=True)
    attention_set = _load_attention_set()
    print(f"   排除處置股:{len(attention_set)} 檔")

    trades = _read_trades()
    print(f"   既有 trade 累計:{len(trades)} 筆")

    # Step 1: 記錄今日訊號(去重:同日同股同訊號不重加)
    existing = {(t.get('open_date'), t.get('symbol'), t.get('signal')) for t in trades}
    new_today = record_today_signals(attention_set, today)
    added = 0
    for nt in new_today:
        key = (nt['open_date'], nt['symbol'], nt['signal'])
        if key not in existing:
            trades.append(nt)
            existing.add(key)
            added += 1
    print(f"   新增今日訊號:{added} 筆")

    # Step 2: 對 open trade 計算 fwd 報酬
    trades = update_open_trades(trades, today)

    # Step 3: 累計指標
    summary = summarize(trades)
    opened = sum(1 for t in trades if t.get('status') == 'open')
    closed_n = sum(1 for t in trades if t.get('status') == 'closed')

    # 保留最新 MAX_TRADES_KEEP 筆,避免 JSON 過大
    trades_to_keep = trades[-MAX_TRADES_KEEP:] if len(trades) > MAX_TRADES_KEEP else trades

    payload = {
        'updated': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'total_trades': len(trades),
        'open': opened,
        'closed': closed_n,
        'cost_pct': round(ROUND_TRIP_COST_PCT, 3),
        'tracking_windows': list(TRADE_WINDOWS),
        'note': 'Paper Trade 累積實戰績效;扣手續費+證交稅+滑價後的淨報酬;訊號累計樣本 >= 30 才有統計意義。',
        'summary': summary,
        'trades': trades_to_keep,
    }
    OUTPUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"✅ Paper Trade 已寫 → {OUTPUT_FILE}")
    print(f"   累計 {len(trades)} 筆(open {opened} / closed {closed_n})")

    # 列前 10 個訊號的 10 日實戰勝率(只列樣本 >= 5)
    if summary:
        print(f"\n📊 各訊號實戰勝率(10 日,樣本 >= 5 才印):")
        ranked = []
        for sig, by_w in summary.items():
            if '10d' in by_w and by_w['10d']['samples'] >= 5:
                ranked.append((sig, by_w['10d']['win_rate'], by_w['10d']['avg_return'], by_w['10d']['samples']))
        ranked.sort(key=lambda x: x[1], reverse=True)
        for sig, wr, avg, n in ranked[:10]:
            print(f"   {sig:30s}: 10d 勝率 {wr:5.1f}% / 平均 {avg:+.2f}% / {n} 樣本")


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"💥 paper_trade 頂層例外(不影響其他):{e}")
