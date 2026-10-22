#!/usr/bin/env python3
"""🌅 V79.5.5 盤前體檢「早上那份」每天留一筆(macro_miner → macro_risk.premkt_recent → daily_miner 寫 data/premkt_log.json)

為什麼這樣存(⛔ 不寫進 risk_history):risk_history 只有 daily_miner 晚上那輪會寫並部署(macro_cron 只推 macro_risk.json),
晚上那輪讀的「上一份」又是 data 分支的舊檔,看不到早上那份;散戶 App 還有 3 處會下載 risk_history。

驗:
  ① 只有平日台北 05:00~08:59 那幾輪會寫今天那一筆(04:59 / 09:00 / 週末都不寫)
  ② 同一天後一輪蓋前一輪(開盤前最後一輪為準)・09:00 以後只沿用
  ③ ⭐ 決定性對照:晚上那輪本機上一份沒有今天 → 一定要合併已發佈那份才拿得到(不合併就少今天)
  ④ macro_risk 裡只留最近 5 天
  ⑤ log 合併:新的一天加進去、同一天比較晚寫的才換、留 400 天
  ⑥ 寫檔:沒有就建、壞掉的⛔ 不覆蓋、一筆都沒有就不建、NaN 不會讓整份寫不出來
  ⑦ 跨檔:產業作戰室 _premktScore / 散戶 App _premktFieldAge 實際讀到的每一個欄位都在 PREMKT_SNAP_KEYS 裡
     (⭐ 真的執行那兩支函式、用 Proxy 記錄讀了哪些鍵,⛔ 不靠 regex 猜)
  ⑧ 接線:main() 先算 premkt_recent 再寫 macro_risk.json、寫完才在有底層資料時寫 premkt_log;已發佈那份用 local=False 讀
用法:python3 scripts/test_premkt_log.py
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import types
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault('SKIP_GLOBAL', '1')
for _m in ('yfinance',):
    if _m not in sys.modules:
        sys.modules[_m] = types.ModuleType(_m)
_cwd = os.getcwd()
_tmp = tempfile.mkdtemp(prefix='pmlog-')
os.chdir(_tmp)                       # macro_miner 匯入時會建 data/ → 放在暫存區
import macro_miner as mm             # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:300]}")
    if not cond:
        fails.append(name)


TW = timezone(timedelta(hours=8))


def at(day, hh, mm_):
    return datetime(2026, 10, day, hh, mm_, tzinfo=TW)   # 2026-10-19 是週一


def out_with(v):
    o = {k: None for k in mm.PREMKT_SNAP_KEYS}
    o.update({'sp500_chg_pct': v, 'nasdaq_chg_pct': v, 'dji_chg_pct': v, 'sox_chg_pct': v,
              'tsm_chg_pct': v, 'vix': 18.0, 'sp500_date': '2026-10-21', 'tsm_date': '2026-10-21',
              'taifex_tx_now': {'price': 1, 'chg': v, 'est': False}, 'unrelated_field': 123})
    return o


# ① 時間窗
for (d, h, m, want, lab) in [(22, 5, 0, True, '週四 05:00'), (22, 8, 59, True, '週四 08:59'), (22, 4, 59, False, '週四 04:59'),
                             (22, 9, 0, False, '週四 09:00'), (22, 18, 20, False, '週四 18:20'), (24, 7, 0, False, '週六 07:00')]:
    rec, did = mm._premkt_recent_step(out_with(1.0), [{}], at(d, h, m))
    got = any(e['d'] == f'2026-10-{d:02d}' for e in rec)
    ok(f'① {lab} → {"寫" if want else "不寫"}今天那一筆', got == want, (rec, did))
rec, _ = mm._premkt_recent_step(out_with(1.0), [{}], at(22, 7, 30))
e = rec[-1]
ok('①b 一筆只存 PREMKT_SNAP_KEYS(⛔ 不帶 macro_risk 其他欄位)', set(e['x']) == set(mm.PREMKT_SNAP_KEYS) and 'unrelated_field' not in e['x'], sorted(e['x']))
ok('①c 記下是幾點的資料', e['at'] == '07:30' and e['d'] == '2026-10-22', e)

# ② 後一輪蓋前一輪、09:00 後只沿用
r1, _ = mm._premkt_recent_step(out_with(1.0), [{}], at(22, 6, 30))
r2, _ = mm._premkt_recent_step(out_with(-2.0), [{'premkt_recent': r1}], at(22, 8, 10))
ok('② 同一天 08:10 那輪蓋掉 06:30 那輪(開盤前最後一輪為準)', r2[-1]['at'] == '08:10' and r2[-1]['x']['sp500_chg_pct'] == -2.0, r2)
r3, did3 = mm._premkt_recent_step(out_with(5.0), [{'premkt_recent': r2}], at(22, 13, 0))
ok('②b 13:00 那輪只沿用(值還是 08:10 的)', r3[-1]['at'] == '08:10' and r3[-1]['x']['sp500_chg_pct'] == -2.0 and did3 == '只沿用', (r3, did3))
# 兩份上一份同一天不同時間 → 留比較晚的(不管誰在前)
a = {'d': '2026-10-21', 'at': '06:00', 'x': {'sp500_chg_pct': 1}}
b = {'d': '2026-10-21', 'at': '08:30', 'x': {'sp500_chg_pct': 2}}
for order in ([a, b], [b, a]):
    r, _ = mm._premkt_recent_step(out_with(0), [{'premkt_recent': [order[0]]}, {'premkt_recent': [order[1]]}], at(22, 13, 0))
    ok(f'②c 兩份上一份同一天 → 留 08:30 那筆(順序 {order[0]["at"]} 先)', r[-1]['at'] == '08:30', r)

# ③ 決定性對照:晚上那輪
local_prev = {'premkt_recent': [{'d': '2026-10-21', 'at': '08:05', 'x': {'sp500_chg_pct': 0.3}}]}   # data 分支那份(昨晚)
published = {'premkt_recent': local_prev['premkt_recent'] + [{'d': '2026-10-22', 'at': '08:12', 'x': {'sp500_chg_pct': 0.6}}]}
r_no, _ = mm._premkt_recent_step(out_with(9.9), [local_prev], at(22, 18, 20))
r_yes, _ = mm._premkt_recent_step(out_with(9.9), [local_prev, published], at(22, 18, 20))
ok('③ ⭐ 決定性對照:只看本機上一份 → 少了今天;合併已發佈那份 → 有今天(值是早上那份,⛔ 不是晚上這輪的)',
   not any(e['d'] == '2026-10-22' for e in r_no)
   and any(e['d'] == '2026-10-22' and e['x']['sp500_chg_pct'] == 0.6 for e in r_yes), (r_no, r_yes))

# ④ 只留最近 5 天
many = {'premkt_recent': [{'d': f'2026-10-{d:02d}', 'at': '08:00', 'x': {}} for d in range(1, 21)]}
r, _ = mm._premkt_recent_step(out_with(0), [many], at(22, 8, 0))
ok('④ macro_risk 裡只留最近 5 天(今天在最後)', len(r) == mm.PREMKT_RECENT_N == 5 and r[-1]['d'] == '2026-10-22' and r[0]['d'] == '2026-10-17', [e['d'] for e in r])

# ⑤ log 合併
rows = [{'d': f'2025-{m:02d}-{d:02d}', 'at': '08:00', 'x': {}} for m in range(1, 13) for d in range(1, 29)]   # 336 天
recent = [{'d': '2026-10-21', 'at': '08:05', 'x': {'a': 1}}, {'d': '2026-10-22', 'at': '08:12', 'x': {'a': 2}}]
n_rows, add, upd = mm._premkt_log_merge(rows, recent)
ok('⑤ 新的兩天加進去', add == 2 and upd == 0 and n_rows[-1]['d'] == '2026-10-22', (add, upd, n_rows[-1]))
n2, add2, upd2 = mm._premkt_log_merge(n_rows, [{'d': '2026-10-22', 'at': '08:40', 'x': {'a': 3}}])
ok('⑤b 同一天比較晚寫的才換', add2 == 0 and upd2 == 1 and n2[-1]['x']['a'] == 3, (add2, upd2, n2[-1]))
n3, add3, upd3 = mm._premkt_log_merge(n2, [{'d': '2026-10-22', 'at': '06:00', 'x': {'a': 4}}])
ok('⑤c 同一天比較早寫的⛔ 不換', add3 == 0 and upd3 == 0 and n3[-1]['x']['a'] == 3, (add3, upd3, n3[-1]))
big = [{'d': (datetime(2024, 1, 1) + timedelta(days=i)).strftime('%Y-%m-%d'), 'at': '08:00', 'x': {}} for i in range(450)]
n4, _, _ = mm._premkt_log_merge(big, [])
ok('⑤d 留最近 400 天', len(n4) == 400 and n4[-1]['d'] == big[-1]['d'], len(n4))
n5, add5, _ = mm._premkt_log_merge([{'d': 'bad'}, None, {'d': '2026-10-01', 'at': '08:00', 'x': {}}], [{'x': {}}, {'d': '2026-10-02'}])
ok('⑤e 格式不對的列直接丟掉(⛔ 不讓整份壞掉)', len(n5) == 1 and add5 == 0, n5)

# ⑥ 寫檔
p = Path(_tmp) / 'premkt_log_test.json'
msg = mm._premkt_log_write([], p)
ok('⑥ 一筆都沒有 → ⛔ 不建檔', not p.exists() and '還沒有' in msg, msg)
nan_out = out_with(float('nan'))
r, _ = mm._premkt_recent_step(nan_out, [{}], at(22, 8, 0))
msg = mm._premkt_log_write(r, p)
j = json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
ok('⑥b 沒有檔就建;NaN 變成 null(⛔ 不會整份寫不出來)', p.exists() and j.get('rows') and j['rows'][-1]['x']['sp500_chg_pct'] is None
   and j['rows'][-1]['x']['taifex_tx_now']['chg'] is None and j.get('keys') == list(mm.PREMKT_SNAP_KEYS), (msg, j.get('rows')))
p.write_text('{"rows": [1, 2', encoding='utf-8')
before = p.read_text(encoding='utf-8')
msg = mm._premkt_log_write(r, p)
ok('⑥c 舊檔壞掉 → ⛔ 不覆蓋(留著下一輪再試、印原因)', p.read_text(encoding='utf-8') == before and '不覆蓋' in msg, msg)

# ⑦ 跨檔:實際執行兩支函式,記錄讀了哪些鍵
pro = (ROOT / 'pro.html').read_text(encoding='utf-8')
idx = (ROOT / 'index.html').read_text(encoding='utf-8')


def grab(src, head):
    i = src.index(head)
    j = src.index('{', i)
    dep = 0
    for k in range(j, len(src)):
        if src[k] == '{':
            dep += 1
        elif src[k] == '}':
            dep -= 1
            if dep == 0:
                return src[i:k + 1]
    raise RuntimeError(head)


js = """
const keys = new Set();
const mk = () => new Proxy({}, { get(t, k) {
  if (typeof k !== 'string') return undefined;
  keys.add(k);
  if (k === 'taifex_tx_now') return { price: 1, chg: 1.2, est: false };
  if (/_date$/.test(k)) return k === 'tsm_date' ? '2026-10-20' : '2026-10-21';
  if (k === 'vix') return 18.4;
  if (k === 'fear_greed') return 50;
  return 1.1;
} });
const O = { %s, %s };
O._premktScore(mk(), '2026-10-22');
O._premktFieldAge(mk(), '2026-10-22');
console.log(JSON.stringify([...keys].sort()));
""" % (grab(pro, '_premktScore(mr, todayISO) {'), grab(idx, '_premktFieldAge(mr, todayISO) {'))
try:
    res = subprocess.run(['node', '-e', js], capture_output=True, text=True, timeout=60)
    read = json.loads(res.stdout.strip() or '[]')
except Exception as e:  # noqa: BLE001
    read, res = [], e
missing = sorted(set(read) - set(mm.PREMKT_SNAP_KEYS))
ok('⑦ ⭐ 產業作戰室 _premktScore + 散戶 App _premktFieldAge 實際讀的每一個欄位都在 PREMKT_SNAP_KEYS 裡',
   len(read) >= 20 and not missing, (len(read), missing, getattr(res, 'stderr', '')[:200] if hasattr(res, 'stderr') else res))

# ⑧ 接線(只看 main 本體)
src = (ROOT / 'macro_miner.py').read_text(encoding='utf-8')
body = src[src.index('def main():'):src.index('\nif __name__')]
i_step = body.find('_premkt_recent_step(')
i_write = body.find('OUTPUT_FILE.write_text(')
i_log = body.find('_premkt_log_write(')
ok('⑧ main():先算 premkt_recent → 再寫 macro_risk.json → 寫完才寫 premkt_log', 0 < i_step < i_write < i_log, (i_step, i_write, i_log))
ok('⑧b premkt_log 只在有底層資料(_had_base)時寫', 'if _had_base:' in body[i_write:i_log + 40], body[i_write:i_log + 40][-200:])
ok('⑧c main 用 _premkt_prevs 決定要不要另讀已發佈那份', '_premkt_prevs(_prev_json, _prev_src)' in body, '')
i_base, i_rh = body.find('_had_base ='), body.find('rh_file.write_text(')
ok('⑧d _had_base 在 main 一開頭就判斷(⛔ 等到後面 risk_history 已被這一輪寫出來才判就永遠是真的)',
   0 < i_base < body.find('[4/8]') and 0 < i_base < i_rh, (i_base, i_rh))
# ⑧e 決定性對照:本機那份 → 一定另讀已發佈那份;已經是線上那份 → ⛔ 不再打網路
calls = []
def fake_loader(local=True):
    calls.append(local)
    return {'premkt_recent': [{'d': '2026-10-22', 'at': '08:12', 'x': {}}]}, '線上 gh-pages(只讀已發佈那份)'
pv1, m1 = mm._premkt_prevs({'a': 1}, '本機 macro_risk.json', loader=fake_loader)
ok('⑧e 本機那份 → 另讀已發佈那份(local=False)、兩份都拿來合併', len(pv1) == 2 and calls == [False] and '另讀' in m1, (pv1, calls, m1))
calls.clear()
pv2, m2 = mm._premkt_prevs({'a': 1}, '線上 gh-pages(本機沒有上一份)', loader=fake_loader)
ok('⑧f 已經是線上那份 → ⛔ 不再多打一次網路', len(pv2) == 1 and calls == [], (pv2, calls, m2))

os.chdir(_cwd)

# 🧪 INJECT=1:六種壞寫法各放進一份暫存的副本(⛔ 不動正本),每一種都要讓這支測試變紅
if os.environ.get('INJECT') and not os.environ.get('_PMLOG_CHILD'):
    import shutil
    MUT = {
        'window': ('PREMKT_WIN = (5 * 60, 9 * 60)', 'PREMKT_WIN = (5 * 60, 10 * 60)'),
        'pick': ('return b if str(b.get("at") or "") > str(a.get("at") or "") else a', 'return a'),
        'merge': ('        elif _premkt_pick(old, e) is not old:\n            by[e["d"]] = e; upd += 1', '        else:\n            by[e["d"]] = e; upd += 1'),
        'gate': ('    if _had_base:\n        print("  " + _premkt_log_write', '    if True:\n        print("  " + _premkt_log_write'),
        'prevs': ('    if str(prev_src or "").startswith("線上"):\n        return prevs, "上一份就是已發佈那份"', '    if True:\n        return prevs, "上一份就是已發佈那份"'),
        'keys': ('    "taiex_date", "fi_three_date",\n)', '    "taiex_date",\n)'),
    }
    msrc = (ROOT / 'macro_miner.py').read_text(encoding='utf-8')
    all_red = True
    for nm, (a, b) in MUT.items():
        if msrc.count(a) != 1:
            print(f'⚠️ 注入 {nm}:找不到原句'); all_red = False; continue
        d = Path(tempfile.mkdtemp(prefix=f'pmlog-inj-{nm}-'))
        (d / 'scripts').mkdir()
        for f in ('common.py', 'groq_common.py', 'pro.html', 'index.html'):
            shutil.copy(ROOT / f, d / f)
        shutil.copy(ROOT / 'scripts' / 'test_premkt_log.py', d / 'scripts' / 'test_premkt_log.py')
        (d / 'macro_miner.py').write_text(msrc.replace(a, b), encoding='utf-8')
        r = subprocess.run([sys.executable, str(d / 'scripts' / 'test_premkt_log.py')], capture_output=True, text=True,
                           env={**os.environ, '_PMLOG_CHILD': '1'}, timeout=300)
        reds = [l for l in r.stdout.splitlines() if l.startswith('❌')]
        print(f"{'✅' if r.returncode else '❌'} 注入 {nm} → {reds[0][:80] if reds else '沒叫出來'}")
        all_red = all_red and r.returncode != 0
        shutil.rmtree(d, ignore_errors=True)
    print('✅ 六種注入全部叫得出來' if all_red else '❌ 有注入沒叫出來')
    if not all_red:
        fails.append('INJECT')

print('\n' + (f'❌ {len(fails)} 條失敗' if fails else '✅ PREMKT_LOG_PASS'))
sys.exit(1 if fails else 0)
