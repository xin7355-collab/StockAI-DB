#!/usr/bin/env python3
"""🧊 V82.7.0 macro_cron 那一步「凍結今天早上的開盤預判 + 反攻雷達」接線守門(只讀 workflow 文字,⛔ 需要 PyYAML)

驗:
  ① 步驟順序:🌍 執行總經採礦 → 🧊 凍結 → 📡 同步(凍結要在採礦寫完之後、推送之前)
  ② 凍結那步:continue-on-error、自己 2 分鐘上限(job 只有 8 分)、跑 forecast_freeze.mjs 再 --attach、⛔ npm install
  ③ PREMKT_WRITER=1 只在 macro_cron 的採礦那步(⛔ 其他 workflow 設 —— daily_miner 早上那輪寫了會蓋掉已凍結那筆)
  ④ 用到的檔案都在(scripts/forecast_freeze.mjs / lib_appextract.mjs、macro_miner.py 有 --attach)
  INJECT=1:拿掉 continue-on-error / 凍結搬到推送後面 / daily_miner 也設寫入者 —— 三種都要紅
用法:python3 scripts/test_macro_cron_freeze.py
"""
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WF = ROOT / '.github' / 'workflows'
fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:300]}")
    if not cond:
        fails.append(name)


def steps_of(text):
    """→ [(名字, 這一步的整段文字)](照順序;一步 = 從 `- name:` 到下一個 `- name:`)"""
    idx = [m.start() for m in re.finditer(r'\n      - name: ', text)]
    out = []
    for i, s in enumerate(idx):
        e = idx[i + 1] if i + 1 < len(idx) else len(text)
        seg = text[s:e]
        out.append((seg.split('- name: ', 1)[1].split('\n', 1)[0].strip(), seg))
    return out


def check(mc, others):
    st = steps_of(mc)
    names = [n for n, _ in st]
    i_mine = next((i for i, n in enumerate(names) if n.startswith('🌍 執行總經採礦')), -1)
    i_frz = next((i for i, n in enumerate(names) if n.startswith('🧊 凍結')), -1)
    i_sync = next((i for i, n in enumerate(names) if n.startswith('📡 同步')), -1)
    ok('① 步驟順序:🌍 執行總經採礦 → 🧊 凍結 → 📡 同步', 0 <= i_mine < i_frz < i_sync, names)
    frz = st[i_frz][1] if i_frz >= 0 else ''
    ok('② 凍結那步:continue-on-error: true(⛔ 擋推送)', re.search(r'\n\s+continue-on-error: true', frz) is not None, frz[:200])
    tm = re.search(r'timeout-minutes: (\d+)', frz)
    job_tm = re.search(r'\n    timeout-minutes: (\d+)', mc)
    ok('②b 自己有時限 ≤ 2 分、而且比整個 job 短', tm is not None and int(tm.group(1)) <= 2 and job_tm is not None and int(tm.group(1)) < int(job_tm.group(1)), (tm and tm.group(1), job_tm and job_tm.group(1)))
    ok('②c 先跑 forecast_freeze.mjs、有結果才 --attach;⛔ npm install(只用 Node 內建)',
       'node scripts/forecast_freeze.mjs data/macro_risk.json /tmp/freeze.json' in frz and 'macro_miner.py --attach /tmp/freeze.json' in frz
       and frz.find('forecast_freeze.mjs') < frz.find('--attach') and 'npm ' not in frz, frz[-300:])
    mine = st[i_mine][1] if i_mine >= 0 else ''
    ok("③ macro_cron 的採礦那步設 PREMKT_WRITER: '1'", re.search(r"PREMKT_WRITER: '1'", mine) is not None, mine[-300:])
    bad = [n for n, t in others.items() if 'PREMKT_WRITER' in t]
    ok('③b ⛔ 其他 workflow 設 PREMKT_WRITER(daily_miner 早上那輪寫了會蓋掉已凍結那筆)', not bad, bad)


mc_text = (WF / 'macro_cron.yml').read_text(encoding='utf-8')
others = {p.name: p.read_text(encoding='utf-8') for p in WF.glob('*.yml') if p.name != 'macro_cron.yml'}
check(mc_text, others)
ok('④ 用到的檔案都在、macro_miner.py 有 --attach',
   (ROOT / 'scripts' / 'forecast_freeze.mjs').exists() and (ROOT / 'scripts' / 'lib_appextract.mjs').exists()
   and '"--attach"' in (ROOT / 'macro_miner.py').read_text(encoding='utf-8'))

if os.environ.get('INJECT') and not os.environ.get('_MCF_CHILD'):
    MUT = {
        'noCoe': lambda mc, ot: (mc.replace('        continue-on-error: true\n        timeout-minutes: 2\n', '        timeout-minutes: 2\n'), ot),
        'afterSync': lambda mc, ot: (mc.replace('      - name: 🧊 凍結', '      - name: 🧊X 凍結').replace('      - name: 📡 同步', '      - name: 📡 同步Y'), ot),
        'dmWriter': lambda mc, ot: (mc, {**ot, 'daily_miner.yml': ot.get('daily_miner.yml', '') + "\n          PREMKT_WRITER: '1'\n"}),
    }
    all_red = True
    for nm, f in MUT.items():
        saved = list(fails)
        fails.clear()
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            mc2, ot2 = f(mc_text, others)
            check(mc2, ot2)
        hit = bool(fails)
        print(f"{'✅' if hit else '❌'} 注入 {nm} → {fails[0][:70] if fails else '沒叫出來'}")
        all_red = all_red and hit
        fails[:] = saved
    ok('🧪 三種注入全部叫得出來', all_red)

print('\n' + (f'❌ {len(fails)} 條失敗' if fails else '✅ MACRO_CRON_FREEZE_PASS'))
sys.exit(1 if fails else 0)
