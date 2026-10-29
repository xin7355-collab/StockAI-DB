#!/usr/bin/env python3
"""📝 V80.0.0 auto_trade.log() 也寫一份到檔案(交易安全檢查清單:每一個決定都要留紀錄)。
① 寫得進去(帶日期時間 + 原文)② 預設跟狀態檔放一起(真實 .log / 模擬 .sim.log)③ AUTO_LOG=0 不寫
④ 寫不進去(路徑是資料夾)⛔ 不丟例外 ⑤ 超過上限換成 .1 ⑥ 決定性對照:拿掉寫檔那行 → ① 必紅(INJECT=1)
每一條都開子程序(模組層讀環境變數)。"""
import os, subprocess, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ok_n = bad_n = 0


def ok(name, cond, extra=''):
    global ok_n, bad_n
    if cond:
        ok_n += 1; print('✅', name)
    else:
        bad_n += 1; print('❌', name, extra)


def run(code, env_add, home):
    env = {k: v for k, v in os.environ.items() if k not in ('AUTO_LOG', 'STATE_PATH', 'LIVE')}
    env.update(env_add); env['HOME'] = home
    pre = ''
    if os.getenv('INJECT') == '1':
        pre = "import auto_trade as A\nA._log_file = lambda line: None\n"
    r = subprocess.run([sys.executable, '-c', f"import sys; sys.path.insert(0, {ROOT!r})\n{pre}{code}"],
                       env=env, cwd=ROOT, capture_output=True, text=True, timeout=120)
    return r


with tempfile.TemporaryDirectory() as d:
    lp = os.path.join(d, 'a.log')
    r = run("import auto_trade as A\nA.log('🔥 買進 2330 1 張', 1000)\nA.log('第二行')", {'AUTO_LOG': lp}, d)
    txt = open(lp, encoding='utf-8').read() if os.path.exists(lp) else ''
    ok('① 寫得進檔案(原文 + 日期時間)', r.returncode == 0 and '🔥 買進 2330 1 張 1000' in txt
       and txt.count('\n') == 2 and txt.startswith('[20'), r.stderr[-300:] + repr(txt[:200]))
    ok('① 螢幕照樣印', '🔥 買進 2330 1 張' in r.stdout)

    r = run("import auto_trade as A\nprint('P', A.AUTO_LOG)", {}, d)
    ok('② 模擬帳戶預設 = ~/.stockai_auto_trade.sim.log', f"P {os.path.join(d, '.stockai_auto_trade.sim.log')}" in r.stdout, r.stdout + r.stderr[-200:])
    r = run("import auto_trade as A\nprint('P', A.AUTO_LOG)", {'LIVE': '1'}, d)
    ok('② 真實帳戶預設 = ~/.stockai_auto_trade.log', f"P {os.path.join(d, '.stockai_auto_trade.log')}" in r.stdout, r.stdout)
    r = run("import auto_trade as A\nprint('P', A.AUTO_LOG)", {'STATE_PATH': os.path.join(d, 'x.json')}, d)
    ok('② 自己設 STATE_PATH → 同一個地方的 .log', f"P {os.path.join(d, 'x.log')}" in r.stdout, r.stdout)

    r = run("import auto_trade as A\nprint('P', A.AUTO_LOG)\nA.log('不該寫')", {'AUTO_LOG': '0'}, d)
    ok('③ AUTO_LOG=0 不寫', 'P None' in r.stdout and r.returncode == 0, r.stdout)

    r = run("import auto_trade as A\nA.log('寫不進去也要活著')\nprint('ALIVE')", {'AUTO_LOG': d}, d)
    ok('④ 寫不進去 ⛔ 不丟例外', r.returncode == 0 and 'ALIVE' in r.stdout, r.stderr[-300:])

    big = os.path.join(d, 'big.log')
    with open(big, 'w') as f:
        f.write('x' * 50)
    r = run("import auto_trade as A\nA.AUTO_LOG_MAX = 10\nA.log('新的')", {'AUTO_LOG': big}, d)
    new = open(big, encoding='utf-8').read() if os.path.exists(big) else ''
    ok('⑤ 超過上限 → 舊的換成 .1、新的從頭寫', os.path.exists(big + '.1') and open(big + '.1').read() == 'x' * 50
       and '新的' in new and 'x' not in new, repr(new))

print(f'\n通過 {ok_n} / 失敗 {bad_n}')
sys.exit(1 if bad_n else 0)
