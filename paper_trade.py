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
from strategy_sim import chu_long_entry, simulate_chu_exit   # 🎯 建議3:回後買上漲 + 朱式動態出場(向前追蹤)

CHU_SIGNAL = '🎯 回後買上漲(朱式出場)'   # 用朱式動態出場(跌破5MA/破進場K低)追蹤,而非固定 N 日

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

            # 🎯 建議3:回後買上漲 → 以「朱式動態出場」追蹤(非固定 N 日;由 update_chu_swing_exits 逐日判斷出場)
            try:
                _ce = chu_long_entry(rows)
                if _ce and _ce.get('grade') in ('high', 'weak'):
                    new_trades.append({
                        'open_date': today_str,
                        'symbol': sym,
                        'signal': CHU_SIGNAL,
                        'entry_close': round(entry_price, 2),
                        'grade': _ce['grade'],
                        'chu_swing': True,       # 標記:用朱式出場而非 fwd 視窗
                        'chu_exit': None,
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
        if t.get('chu_swing'): continue   # 🎯 朱式出場由 update_chu_swing_exits 處理,不走固定 N 日視窗
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


def update_chu_swing_exits(trades, today, max_hold=60):
    """🎯 建議3:對 open 的「回後買上漲」trade,用 simulate_chu_exit 逐日判斷是否已朱式出場
    (跌破5MA停利 / 破進場K低-5%停損 / 獲利升級鎖利)。已出場則記 chu_exit 並轉 closed。
    持有超過 max_hold 根仍未觸發出場 → 以最新收盤強制結算(避免永久掛單)。"""
    updated = closed = 0
    cache = {}

    def get_rows(sym):
        if sym in cache:
            return cache[sym]
        f = DATA_DIR / f"{sym}.json"
        try:
            r = json.loads(f.read_text(encoding='utf-8')) if f.exists() else None
            cache[sym] = r if isinstance(r, list) else None
        except Exception:
            cache[sym] = None
        return cache[sym]

    for t in trades:
        if t.get('status') != 'open' or not t.get('chu_swing'):
            continue
        rows = get_rows(t['symbol'])
        if not rows:
            continue
        entry_idx = _find_idx_by_date(rows, t['open_date'])
        if entry_idx is None or entry_idx >= len(rows) - 1:
            continue
        ex = simulate_chu_exit(rows, entry_idx, entry_px=t.get('entry_close'))
        if not ex:
            continue
        held = len(rows) - 1 - entry_idx
        if ex.get('closed'):
            net = apply_real_cost(ex['return_pct'])
            t['chu_exit'] = {
                'return_gross': ex['return_pct'], 'return_net': round(net, 2),
                'reason': ex['reason'], 'bars_held': ex['bars_held'],
                'exit_date': _normalize_date(rows[ex['exit_idx']].get('date', '')),
            }
            t['status'] = 'closed'
            closed += 1
        elif held >= max_hold:
            net = apply_real_cost(ex['return_pct'])
            t['chu_exit'] = {
                'return_gross': ex['return_pct'], 'return_net': round(net, 2),
                'reason': f'持有滿{max_hold}根強制結算', 'bars_held': held,
                'exit_date': _normalize_date(rows[-1].get('date', '')),
            }
            t['status'] = 'closed'
            closed += 1
        else:
            updated += 1   # 仍持有
    print(f"🎯 回後買上漲(朱式出場)更新:{closed} 筆平倉、{updated} 筆仍持有")
    return trades


def summarize_chu_swing(trades):
    """回後買上漲(朱式出場)實戰統計:勝率 / 平均淨報酬 / 平均持有天數。"""
    closed = [t['chu_exit'] for t in trades
              if t.get('chu_swing') and t.get('status') == 'closed' and t.get('chu_exit')]
    if not closed:
        return None
    nets = [e['return_net'] for e in closed if e.get('return_net') is not None]
    if not nets:
        return None
    wins = [x for x in nets if x > 0]
    holds = [e['bars_held'] for e in closed if e.get('bars_held') is not None]
    return {
        'closed_trades': len(nets),
        'win_rate': round(len(wins) / len(nets) * 100, 1),
        'avg_return_net': round(sum(nets) / len(nets), 2),
        'avg_bars_held': round(sum(holds) / len(holds), 1) if holds else None,
        'exit_rule': '跌破5MA停利 / 破進場K低-5%停損 / +7%鎖利、+20%加速停利',
    }


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
    # Step 2.5: 🎯 建議3 — 回後買上漲用朱式動態出場逐日判斷平倉
    trades = update_chu_swing_exits(trades, today)

    # Step 3: 累計指標
    summary = summarize(trades)
    chu_swing_summary = summarize_chu_swing(trades)
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
        'chu_swing_summary': chu_swing_summary,   # 🎯 建議3:回後買上漲(朱式動態出場)實戰統計
        'trades': trades_to_keep,
    }
    OUTPUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"✅ Paper Trade 已寫 → {OUTPUT_FILE}")
    print(f"   累計 {len(trades)} 筆(open {opened} / closed {closed_n})")
    if chu_swing_summary:
        print(f"🎯 回後買上漲(朱式出場)實戰:{chu_swing_summary['closed_trades']} 筆平倉、"
              f"勝率 {chu_swing_summary['win_rate']}%、平均淨報酬 {chu_swing_summary['avg_return_net']:+.2f}%、"
              f"平均持有 {chu_swing_summary['avg_bars_held']} 根")

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
