#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📚 `scripts/chips_backfill.py` 測試(分點深歷史回算,V74.0.6)

⚠️ 沙箱連不到 FinMind → 網路那半只能 stub。所以這支釘的是「拿到資料之後有沒有做對」:
  ① 彙總規則跟 miner 一致:broker_id 防呆(1~5 位數字)、均價 = Σ(價×量)/Σ量
  ② **每側各留前 K 家**(⛔ 不是「總共前 K 名」—— 那樣賣方會被買方整個擠光)
  ③ 🚧 單日股票數不足 → **整天不寫檔**(⛔ 不可寫半份,否則冪等會誤判「這天做過了」)
  ④ 冪等:已存在的日期預設跳過,`--redo` 才重抓
  ⑤ 券商存**代號**不存名稱(體積關鍵:名稱平均 19.5 bytes → 代號 4)
  ⑥ gzip 真的壓到(⛔ 沒壓的話 1 年是 397MB 不是 90MB)
  ⑦ 🚨 沒有付費層 → 直接停手,⛔ 不可產出空檔
  ⑧ 週末不排進待抓清單
"""
import gzip
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp())
os.environ['CHIPS_DEEP_DIR'] = str(TMP)

spec = importlib.util.spec_from_file_location('cbf', ROOT / 'scripts' / 'chips_backfill.py')
cbf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cbf)

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else f'  {extra}'}")
    if not cond:
        fails.append(name)


def row(sid, bid, nm, buy, sell, price):
    return {'stock_id': sid, 'securities_trader_id': bid, 'securities_trader': nm,
            'buy': buy, 'sell': sell, 'price': price, 'date': '2026-08-14'}


# ── ①⑤ 彙總 + 防呆 ──────────────────────────────────────────
rows = [
    row('2330', '9200', '凱基', 1000, 0, 100.0),
    row('2330', '9200', '凱基', 1000, 0, 200.0),      # 同券商多價位 → 要合併
    row('2330', '1590', '花旗環球', 0, 500, 150.0),
    row('2330', '18,232,856', '垃圾', 999, 0, 10.0),   # 🛡️ 金額誤映射成 id → 丟掉
    row('2330', '', '沒有代號', 999, 0, 10.0),          # 沒 id → 丟掉
    row('2330', '123456', '太長', 999, 0, 10.0),        # >5 位 → 丟掉
]
c, names, nsym = cbf.compact_day(rows)
ok('🚧 空過守門:彙總真的有輸出', '2330' in c and len(c['2330']) >= 2, json.dumps(c, ensure_ascii=False))
e = {x[0]: x for x in c.get('2330', [])}
ok('① 同一家券商多個價位要合併成一筆', len(c['2330']) == 2, json.dumps(c['2330'], ensure_ascii=False))
ok('① 淨股數正確(1000+1000 買 = +2000)', e.get('9200', [None, None])[1] == 2000, str(e.get('9200')))
ok('① 均價 = Σ(價×量)/Σ量 = (100×1000+200×1000)/2000 = 150',
   abs(e.get('9200', [0, 0, 0])[2] - 150.0) < 1e-6, str(e.get('9200')))
ok('① 賣方淨額是負的', e.get('1590', [None, None])[1] == -500, str(e.get('1590')))
ok('①🛡️ 含逗號的假 broker_id 被擋掉', '18,232,856' not in e)
ok('①🛡️ 空 id / 超過 5 位的被擋掉', len(e) == 2, list(e))
ok('⑤ 存的是券商**代號**不是名稱(體積關鍵)',
   all(str(x[0]).replace('A', '').isdigit() for x in c['2330']), json.dumps(c['2330'], ensure_ascii=False))
ok('⑤ 名稱另外收在對照表', names.get('9200') == '凱基', json.dumps(names, ensure_ascii=False))

# ── ② 每側各留前 K 家(⛔ 不是總共前 K 名)────────────────────
many = []
for i in range(40):
    many.append(row('1101', f'{1000 + i}', f'買{i}', 10000 - i * 10, 0, 50.0))
for i in range(40):
    many.append(row('1101', f'{2000 + i}', f'賣{i}', 0, 10000 - i * 10, 50.0))
c2, _, _ = cbf.compact_day(many, top_k=15)
lst = c2['1101']
buys = [x for x in lst if x[1] > 0]
sells = [x for x in lst if x[1] < 0]
ok('②🚧 空過守門:測資真的兩側都超過 K', len(many) == 80)
ok('② 買方留滿 15 家', len(buys) == 15, str(len(buys)))
ok('② ⭐ 賣方也要留滿 15 家(⛔ 不可被買方擠光)', len(sells) == 15, str(len(sells)))
ok('② 買方是淨額最大的前 15', buys[0][1] == 10000 and buys[-1][1] == 10000 - 14 * 10, str(buys[0]) + str(buys[-1]))
ok('② 賣方是淨額最小(最負)的前 15', sells[-1][1] == -10000, str(sells[-1]))

# ── ⑥ 寫檔 + gzip ───────────────────────────────────────────
raw, gz = cbf.write_day('2026-08-14', c2, {'1000': '測試券商'})
ok('🚧 空過守門:檔案真的寫出來了', cbf.day_path('2026-08-14').exists())
ok('⑥ gzip 真的有壓到(⛔ 沒壓的話 1 年是 397MB 不是 90MB)', gz < raw * 0.6, f'{raw} → {gz}')
back = cbf.read_day('2026-08-14')
ok('⑥ 讀回來內容一致', back['d'] == '2026-08-14' and back['n'] == len(c2) and back['s']['1101'] == c2['1101'])
ok('⑥ 券商名稱對照表有寫進去', back['nm'].get('1000') == '測試券商')

# ── ③ 股票數不足 → 整天不寫檔 ────────────────────────────────
#    ⛔ 這條最重要:寫半份的話,冪等檢查(檔案存在)會以為那天已經做過了,永遠補不回來。
before = set(p.name for p in TMP.glob('*.json.gz'))
env = {**os.environ, 'CHIPS_DEEP_MIN_SYMS': '200'}
ok('③ MIN_SYMS 可用環境變數調(⛔ 不寫死)', 'CHIPS_DEEP_MIN_SYMS' in (ROOT / 'scripts' / 'chips_backfill.py').read_text(encoding='utf-8'))
src = (ROOT / 'scripts' / 'chips_backfill.py').read_text(encoding='utf-8')
ok('③ 股票數不足時是 `continue`(⛔ 不可 write_day)',
   'if nsym < MIN_SYMS:' in src
   and src.split('if nsym < MIN_SYMS:')[1].split('write_day')[0].count('continue') == 1,
   src.split('if nsym < MIN_SYMS:')[1][:200] if 'if nsym < MIN_SYMS:' in src else '找不到守門')

# ── ④⑦⑧ CLI 行為(用 --dry-run,不打 API)───────────────────
r = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'chips_backfill.py'),
                    '--days', '10', '--dry-run'],
                   capture_output=True, text=True, env=env, cwd=str(ROOT))
out = r.stdout
ok('🚧 空過守門:--dry-run 真的有輸出', r.returncode == 0 and len(out) > 50, out[-300:] + r.stderr[-300:])
import re as _re
# ⚠️ 這條第一版寫成 `all(... for d in [])` —— **空迭代恆為 True = 假綠燈**。
#    ⭐ 正解:把印出來的日期真的解析出來,逐個檢查 weekday。
_days = _re.findall(r'\d{4}-\d{2}-\d{2}', out.split('前 5 天 =')[-1])
ok('⑧🚧 空過守門:dry-run 真的印出日期', len(_days) >= 3, out[-200:])
from datetime import date as _date
ok('⑧ 待抓清單裡⛔ 不可有週末',
   all(_date.fromisoformat(d).weekday() < 5 for d in _days),
   [d + '/w' + str(_date.fromisoformat(d).weekday()) for d in _days])
m = _re.search(r'→ (\d+) 個平日', out)
ok('⑧ 10 個日曆天只排到 ≤8 個平日', m and int(m.group(1)) <= 8, out[:200])
ok('④ 冪等:已經有的天數會被扣掉',
   '已經有的' in out and '這次要抓' in out, out[:300])
ok('⑦ --dry-run ⛔ 不可去偵測付費(那需要 Secrets)', 'FinMind' not in out, out[:300])

# 已寫過 2026-08-14 → 用涵蓋它的區間跑 dry-run,應該被跳過
r2 = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'chips_backfill.py'),
                     '--from', '2026-08-13', '--to', '2026-08-15', '--dry-run'],
                    capture_output=True, text=True, env=env, cwd=str(ROOT))
ok('④ 已存在的日期真的被跳過', '已經有的 1 天' in r2.stdout, r2.stdout[:300])

# ⑦ 沒有付費層 → 直接停手(⛔ 不可產出空檔)
ok('⑦ 🚨 原始碼裡有「不是付費層就 return 1」的守門',
   'if not miner.detect_finmind_paid():' in src and 'return 1' in
   src.split('if not miner.detect_finmind_paid():')[1][:600], '')
ok('⑦ 而且要說清楚為什麼(⛔ 不可只印一個錯誤碼)',
   'Your level is register' in src)

# ── ⑨ 🚨 V74.0.7 改成「按券商抓」(原本的「省略 data_id 拿全市場」實測不通)──
ok('⑨a 主迴圈要按**券商**抓(⛔ 不是按股票)',
   'securities_trader_id={bid}&date={d}' in src, '')
ok('⑨b ⛔ 不可再用「省略 data_id」那條(實測回 data_id can\'t be none)',
   "fm_paid_get('taiwan_stock_trading_daily_report', f'date={d}'" not in src, '')
ok('⑨c 文件要記下「A~F 全部不通、對照組卻通」這個決定性證據',
   'A~F' in src and '八大行庫' in src, '')
ok('⑨d 要有「一半以上券商沒回就不寫檔」的守門(⛔ 不可寫半份)',
   'partial(' in src and src.split('partial(')[1].split('compact_day')[0].count('continue') == 1, '')
ok('⑨e --brokers 可調,預設 200(實測 98% 覆蓋)',
   "'--brokers'" in src and 'default=200' in src, '')

# top_brokers:用真實 data/chips 驗(⛔ 不用假資料 —— 要驗的正是「真的資料裡撈得到代號」)
_bs = cbf.top_brokers(200)
ok('⑨f 🚧 空過守門:top_brokers 從真實資料撈得出 ≥100 家', len(_bs) >= 100, f'只有 {len(_bs)} 家')
ok('⑨g ⭐ 回的是**代號**不是名稱(⛔ 名稱不能當 API 參數)',
   all(str(b).replace('A', '').replace('a', '').isdigit() and len(str(b)) <= 5 for b in _bs),
   [b for b in _bs if not str(b).replace('A', '').isdigit()][:5])
ok('⑨h 依 |淨額| 由大到小(第一名要是主力分點)', len(set(_bs)) == len(_bs), '有重複代號')
# ⚠️ 第一版用「名稱反查 broker_names.json」→ 906 個查不到、只湊出 18 家。
#    這條就是釘住那個回歸。
ok('⑨i ⛔ 不可再用「名稱反查代號」(第一版只湊得出 18 家)',
   'name2id' not in src, '')
ok('⑨j 要讀 chips[].bid(那裡本來就有代號)', "e.get('bid')" in src, '')

# ── 架構決定要寫在檔案裡(⛔ 免得下一個人搬回 gh-pages)──────
ok('🏛️ 註解要寫明「只推 data 分支,不上 gh-pages」', '不上 gh-pages' in src)
ok('🏛️ 註解要寫明「一天一個檔」的理由', '一天一個檔' in src and '2,653' in src)

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ CHIPS_BACKFILL_PASS(全部通過)')
sys.exit(1 if fails else 0)
