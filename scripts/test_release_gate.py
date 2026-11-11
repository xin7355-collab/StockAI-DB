#!/usr/bin/env python3
"""
🔏 V82.1.2 發布守門:會改到 auto_trade 實際下單的策略參數,要使用者核准過才可以推(使用者 11/11 決定 ①)

① 現在的指紋 == research/approved_live.json 那份 → 綠;不一樣 → 紅,逐一印出是哪個常數、舊值 → 新值
   紅了怎麼辦:⛔ 不可以自己改 approved_live.json 讓它變綠 —— 先照 docs/RELEASES.md 寫發布報告、在對話裡問使用者,
   使用者說可以之後才更新 approved_live.json(寫進核准日期與他的原話)。
② 程式修 bug 不擋:改註解 / 函式內容 / log 文字,指紋不變(selftest 證明)
③ 新名字守門:auto_trade.py 新增了看起來像策略常數的 module-level 名字(全大寫、名字裡有 PICK / RANK / VOL / PCT / LOT / AMT /
   GATE / HOLD / STOP / EXIT / MAX / MIN / TOP / BUY / SELL)卻不在指紋名單、也不在刻意不收的名單 → 紅(⛔ 漏收 = 守門有洞)

跑法:python3 scripts/test_release_gate.py            python3 scripts/test_release_gate.py --selftest
"""
import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
import live_fingerprint as LF  # noqa: E402

APPROVED = ROOT / 'research' / 'approved_live.json'
SUSPECT = re.compile(r'^[A-Z][A-Z0-9_]*(PICK|RANK|VOL|PCT|LOT|AMT|GATE|HOLD|STOP|EXIT|MAX|MIN|TOP|BUY|SELL)[A-Z0-9_]*$')


def unlisted(src):
    """auto_trade.py 裡看起來像策略常數、卻沒被指紋收、也沒在 IGNORE 的名字"""
    rx = re.compile(LF.PY_FILES['auto_trade.py'] + r'$')
    out = []
    for node in ast.parse(src).body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            ts = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in ts:
                if isinstance(t, ast.Name) and SUSPECT.match(t.id) and not rx.match(t.id) and not LF.IGNORE.match(t.id):
                    out.append(t.id)
    return sorted(set(out))


def main():
    if not APPROVED.exists():
        print(f'❌ 找不到 {APPROVED.relative_to(ROOT)}')
        return 1
    ap = json.loads(APPROVED.read_text(encoding='utf-8'))
    fp = LF.fingerprint()
    d = LF.diff(ap['fp'], fp)
    bad = 0
    if d:
        bad += 1
        print(f'❌ ① 實盤策略參數跟使用者核准那份({ap.get("approved")})不一樣 —— 先寫發布報告問使用者,⛔ 自己改 approved_live.json:')
        for f, k, a, b in d:
            print(f'     {f} {k}:{a} → {b}')
    else:
        print(f'✅ ① 實盤策略參數 == 使用者 {ap.get("approved")} 核准那份(指紋 {LF.fp_hash(fp)},{sum(len(v) for v in fp.values())} 個常數)')
    u = unlisted((ROOT / 'auto_trade.py').read_text(encoding='utf-8'))
    if u:
        bad += 1
        print(f'❌ ③ auto_trade.py 有看起來像策略常數、卻沒進指紋也沒列在刻意不收的名字:{", ".join(u)}(加進 live_fingerprint.py 的名單或 IGNORE)')
    else:
        print('✅ ③ auto_trade.py 沒有漏收的策略常數')
    if ap.get('hash') != LF.fp_hash(ap['fp']):
        bad += 1
        print('❌ approved_live.json 的 hash 跟它自己的 fp 對不上(被手改過?)')
    print('✅ 全部通過' if not bad else f'❌ {bad} 條失敗')
    return 1 if bad else 0


def selftest():
    ok = bad = 0

    def t(c, m):
        nonlocal ok, bad
        print(('  ✅ ' if c else '  ❌ ') + m)
        ok, bad = (ok + 1, bad) if c else (ok, bad + 1)

    real = {f: (ROOT / f).read_text(encoding='utf-8') for f in list(LF.PY_FILES) + list(LF.JS_FILES)}
    base = LF.fingerprint(lambda p: real[p])
    t(LF.fingerprint(lambda p: real[p]) == base and sum(len(v) for v in base.values()) >= 30,
      f'⓪ 同一份原始碼兩次指紋一樣,收到 {sum(len(v) for v in base.values())} 個常數')
    # ① 改一個常數(MAX_PICKS 預設 2 → 3)→ 有差
    mod = dict(real); mod['auto_trade.py'] = real['auto_trade.py'].replace("os.getenv('MAX_PICKS', '2')", "os.getenv('MAX_PICKS', '3')", 1)
    d1 = LF.diff(base, LF.fingerprint(lambda p: mod[p]))
    t(mod['auto_trade.py'] != real['auto_trade.py'] and [x[1] for x in d1] == ['MAX_PICKS'], f'① 改 MAX_PICKS 預設 → 只抓到它:{[x[1] for x in d1]}')
    # ② 改 lib_leader 錨點 / lib_leaddd 門檻 → 有差
    mod2 = dict(real); mod2['lib_leader.py'] = real['lib_leader.py'].replace("LEADER_ANCHOR = '2026-09-24'", "LEADER_ANCHOR = '2026-09-25'", 1)
    mod2['scripts/lib_leaddd.mjs'] = real['scripts/lib_leaddd.mjs'].replace('th: 20,', 'th: 25,', 1)
    d2 = LF.diff(base, LF.fingerprint(lambda p: mod2[p]))
    t(sorted(x[1] for x in d2) == ['LEADER_ANCHOR', 'LEAD_DD'], f'② 改錨點 / 收一半門檻 → 抓到 {sorted(x[1] for x in d2)}')
    # ③ 改註解、函式內容、log 文字 → 沒差(修 bug 不擋)
    mod3 = dict(real)
    mod3['auto_trade.py'] = real['auto_trade.py'].replace('# ⛔ 預設 False = 模擬模式', '# 註解改了', 1).replace('def hot_step(', 'def hot_step(  ', 1) + '\n# 檔尾多一行註解\n'
    t(mod3['auto_trade.py'] != real['auto_trade.py'] and not LF.diff(base, LF.fingerprint(lambda p: mod3[p])), '③ 改註解 / 函式內容 → 指紋不變')
    # ④ 新增一個看起來像策略常數的名字沒列進來 → 抓得到
    t(unlisted(real['auto_trade.py'] + '\nMIN_TOP_RANK = 3\n') == ['MIN_TOP_RANK'] and not unlisted(real['auto_trade.py']), '④ 新增 MIN_TOP_RANK 沒列進指紋 → 抓得到;現在沒有漏收')
    print(f'\n{"❌" if bad else "✅"} selftest {ok}/{ok + bad}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
