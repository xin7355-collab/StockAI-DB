#!/usr/bin/env python3
"""
🔏 V82.1.2 實盤策略指紋(SELF_EVOLVING_AUDIT G7 / 使用者 11/11 決定 ①)

「會改到 auto_trade 實際下單」的策略參數,抽出它們在原始碼裡的**預設值原文**,排好序 → 指紋。
`scripts/test_release_gate.py` 拿它跟 `research/approved_live.json`(使用者核准過的那一份)比,不一樣就紅燈。

⭐ 只抓「參數」不抓「程式」:程式修 bug(修復)不用核准;改門檻 / 預設 / 錨點(優化)要核准。
   → 改註解、改函式內容、改 log 文字 = 指紋不變;改任何白名單常數的預設值 = 指紋變。
⛔ 新增會影響下單的常數時,記得加進下面的名單(test_release_gate ③ 會擋「看起來像策略常數卻沒列進來」的新名字)。

跑法:python3 scripts/live_fingerprint.py           → 印出指紋 JSON
      python3 scripts/live_fingerprint.py --hash    → 只印雜湊
"""
import ast
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 每個檔案:要收哪些 module-level 名字(正規式,整個名字要符合)
PY_FILES = {
    'auto_trade.py': r'(LIVE|ACCOUNT_SIZE|MAX_PICKS|MAX_LOTS_PER_TRADE|MAX_AMT_PER_TRADE|POS_PCT|GENE_RANK|GENE_VOL|HOT_RULE|BEAR_GATE'
                     r'|PARK|PARK_[A-Z_]+|LEADER|LEADER_[A-Z0-9_]+|EXIT_RULE|SELL_ENABLE|MAX_HOLD_BY_RULE|MAX_HOLD_OVERRIDE|LOSS_LOCK_PCT|EOD_FROM|EOD_TO)',
    'lib_leader.py': r'(LEADER_RULE|LEADER_ANCHOR|LEADER_ANCHOR2|LEADER_BOOKS)',
    'lib_hotrule.py': r'(HOT_RULES|HOT_DEFAULT|GENE_RANK|GENE_VOL)',
}
JS_FILES = {
    'scripts/lib_leaddd.mjs': r'(LEAD_DD|LEAD_DD_MODEL)',
}
# 看起來像策略常數、卻刻意不收的(log / 檔案路徑 / 對帳時間這類「怎麼做」不是「做什麼」)
IGNORE = re.compile(r'(STATE_PATH|AUTO_LOG.*|FILLS_.*|ORD_KEEP_DAYS|GATE_.*|RECON_.*|POLL_SEC|DAILY_KEYS|GH_BASE|DRY_RUN|TW|LEADER_DEFER_.*_LOGGED)$')


def py_consts(src, pat):
    """module-level 賦值:名字符合 pat → 值的原文(ast.unparse,⛔ 註解與空白不影響)。同名多次就全部依序收。"""
    rx = re.compile(pat + r'$')
    out = {}
    for node in ast.parse(src).body:
        targets = node.targets if isinstance(node, ast.Assign) else ([node.target] if isinstance(node, ast.AnnAssign) and node.value is not None else [])
        for t in targets:
            if isinstance(t, ast.Name) and rx.match(t.id) and not IGNORE.match(t.id):
                out.setdefault(t.id, []).append(ast.unparse(node.value))
    return {k: v[0] if len(v) == 1 else v for k, v in out.items()}


def js_consts(src, pat):
    """`export const NAME = <值>;`(單行)→ 去掉空白的原文"""
    out = {}
    for m in re.finditer(r'^export const (?P<n>' + pat + r')\s*=\s*(?P<v>.+?);\s*(?://.*)?$', src, re.M):
        out[m.group('n')] = re.sub(r'\s+', '', m.group('v'))
    return out


def fingerprint(read=None):
    """read(相對路徑) → 原始碼(selftest 用假的);回 {檔案: {名字: 值原文}}"""
    read = read or (lambda p: (ROOT / p).read_text(encoding='utf-8'))
    fp = {}
    for f, pat in PY_FILES.items():
        fp[f] = py_consts(read(f), pat)
    for f, pat in JS_FILES.items():
        fp[f] = js_consts(read(f), pat)
    return fp


def fp_hash(fp):
    return hashlib.sha256(json.dumps(fp, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()[:16]


def diff(old, new):
    """→ [(檔案, 名字, 舊, 新)]"""
    out = []
    for f in sorted(set(old) | set(new)):
        a, b = old.get(f, {}), new.get(f, {})
        for k in sorted(set(a) | set(b)):
            if a.get(k) != b.get(k):
                out.append((f, k, a.get(k), b.get(k)))
    return out


if __name__ == '__main__':
    fp = fingerprint()
    if '--hash' in sys.argv:
        print(fp_hash(fp))
    else:
        print(json.dumps({'hash': fp_hash(fp), 'fp': fp}, ensure_ascii=False, indent=1, sort_keys=True))
