#!/usr/bin/env python3
"""
🩺 V82.1.2 每週 L1 自動體檢報告(SELF_EVOLVING_AUDIT H2)—— 每週回測那一輪順手寫 `data/l1_report.json`,產業作戰室 App 體檢頁讀它

收四樣(全部是確定性檢查,⛔ 不用 AI、⛔ 不改任何判定):
  ① 資料體檢(data_audit.py --json 的結果:各類幾個錯 / 警告 + 前幾條)
  ② 每週回測產物(backtest_edge.json 的更新時間 / 訊號幾個 / 成績單幾筆)
  ③ 實盤參數守門(test_release_gate.py:指紋跟使用者核准那份一不一樣)
  ④ 實驗登錄(research/experiments.ndjson:幾筆、還沒收結果的、最近一筆)
任何一樣讀不到 → 那一格寫 `err`(⛔ 整份不寫 = 頁面以為上週的還是最新的)。

跑法:python3 scripts/l1_report.py <data_audit --json 輸出> <backtest_edge.json> > l1_report.json
      python3 scripts/l1_report.py --selftest
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TW = timezone(timedelta(hours=8))


def audit_part(path):
    try:
        j = json.load(open(path, encoding='utf-8'))
        return {'bad': j.get('bad'), 'warn': j.get('warn'), 'cats': j.get('cats') or {}, 'items': (j.get('items') or [])[:12], 'ref': j.get('ref')}
    except Exception as e:
        return {'err': f'資料體檢結果讀不到({type(e).__name__})'}


def edge_part(path):
    try:
        j = json.load(open(path, encoding='utf-8'))
        sig = j.get('signal') or {}
        deck = j.get('deck') or {}
        g = deck.get('gene') if isinstance(deck, dict) else None
        return {'updated': j.get('run_at') or j.get('updated'), 'signals': sig.get('n') if isinstance(sig, dict) else None,
                'window': sig.get('window') if isinstance(sig, dict) else None, 'deck': bool(g), 'diff': len(j.get('diff') or [])}
    except Exception as e:
        return {'err': f'每週回測產物讀不到({type(e).__name__})'}


def gate_part(run=None):
    run = run or (lambda: subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'test_release_gate.py')], capture_output=True, text=True, timeout=60))
    try:
        r = run()
        lines = [l for l in (r.stdout or '').splitlines() if l.strip()]
        return {'ok': r.returncode == 0, 'msg': lines[0][:200] if lines else ''}
    except Exception as e:
        return {'err': f'實盤參數守門跑不動({type(e).__name__})'}


def reg_part(path=os.path.join(ROOT, 'research', 'experiments.ndjson')):
    try:
        rows = [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
        ids = {}
        for r in rows:
            ids.setdefault(r['id'], {})[r['t']] = r
        open_ = [i for i, e in ids.items() if 'done' not in e]
        last = max(ids) if ids else None
        return {'n': len(ids), 'open': open_[:10], 'last': last, 'retro': sum(1 for e in ids.values() if e.get('pre', {}).get('retro'))}
    except Exception as e:
        return {'err': f'實驗登錄讀不到({type(e).__name__})'}


def build(audit_path, edge_path, gate_run=None, reg_path=None):
    return {'at': datetime.now(TW).isoformat(timespec='minutes'), 'audit': audit_part(audit_path), 'edge': edge_part(edge_path),
            'gate': gate_part(gate_run), 'reg': reg_part(reg_path) if reg_path else reg_part()}


def selftest():
    import tempfile
    ok = bad = 0

    def t(c, m):
        nonlocal ok, bad
        print(('  ✅ ' if c else '  ❌ ') + m)
        ok, bad = (ok + 1, bad) if c else (ok, bad + 1)
    d = tempfile.mkdtemp()
    a, e, g = os.path.join(d, 'a.json'), os.path.join(d, 'e.json'), os.path.join(d, 'r.ndjson')
    json.dump({'ref': 'origin/gh-pages', 'bad': 1, 'warn': 2, 'cats': {'A': {'bad': 1, 'warn': 0}}, 'items': [['❌', 'A', 'x']]}, open(a, 'w'))
    json.dump({'run_at': '2026-11-13', 'signal': {'n': 2, 'window': [1, 2]}, 'deck': {'gene': {'x': 1}}, 'diff': [1, 2, 3]}, open(e, 'w'))
    with open(g, 'w') as f:
        f.write(json.dumps({'id': 'EXP-20261112-01', 't': 'pre', 'retro': False}) + '\n')
        f.write(json.dumps({'id': 'EXP-20261112-02', 't': 'pre', 'retro': True}) + '\n' + json.dumps({'id': 'EXP-20261112-02', 't': 'done'}) + '\n')

    class R:
        returncode, stdout = 1, '❌ ① 實盤策略參數跟使用者核准那份不一樣\n'
    B = build(a, e, gate_run=lambda: R(), reg_path=g)
    t(B['audit']['bad'] == 1 and B['edge']['signals'] == 2 and B['edge']['deck'] and B['edge']['diff'] == 3 and B['edge']['updated'] == '2026-11-13', '① 資料體檢 / 每週回測兩格讀得到')
    t(B['gate']['ok'] is False and '不一樣' in B['gate']['msg'], '② 實盤參數守門紅燈 → ok false + 原因')
    t(B['reg']['n'] == 2 and B['reg']['open'] == ['EXP-20261112-01'] and B['reg']['retro'] == 1, '③ 實驗登錄:2 筆、1 筆還沒收結果、1 筆補登')
    B2 = build(os.path.join(d, 'none.json'), os.path.join(d, 'none2.json'), gate_run=lambda: R(), reg_path=os.path.join(d, 'no.ndjson'))
    t('err' in B2['audit'] and 'err' in B2['edge'] and 'err' in B2['reg'], '④ 讀不到的那一格寫 err(⛔ 整份不寫)')
    print(f'\n{"❌" if bad else "✅"} selftest {ok}/{ok + bad}')
    return 1 if bad else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    print(json.dumps(build(sys.argv[1], sys.argv[2]), ensure_ascii=False))
