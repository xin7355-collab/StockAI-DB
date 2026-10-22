# -*- coding: utf-8 -*-
"""🔥 V79.4.9 「高檔飆股」選股規則的 Python 抄本(auto_trade.py / alert_system.py 共用)

⛔ 跟 scripts/lib_hotrule.mjs / index.html `_HOT_RULE` 一字不差(test_hotrule.mjs 跨檔比對)。
使用者 2026-10-21 選「換,次數維持 8 次」:預設 'mean' = 照這一招的平均排・每一招都算;'lb' = 舊的保守下界排法(換回舊的)。

名單(data/playbook_edge.json)每一列帶:
  exp = 這一招平均每趟 %   lb = 保守下界(平均 − 1.28×標準差/√次數)
  r   = 新排法這一檔第幾名(0 = 不是)   o = 舊排法這一檔第幾名(0 = 不是)
⚠️ 舊格式名單(V79.4.8 以前採礦的,沒有 r / o)→ 一律不篩、照 lb 排(它本來就只有舊的那幾列)。
"""
HOT_RULES = {
    'mean': {'minN': 8, 'z': 0, 'top': 99},
    'lb': {'minN': 8, 'z': 1.28, 'top': 2},
}
HOT_DEFAULT = 'mean'


def hot_rule(name=None):
    """環境變數 HOT_RULE 的值 → 'mean' / 'lb'(認不得 = 預設)。"""
    n = (name or '').strip()
    return n if n in HOT_RULES else HOT_DEFAULT


def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def rule_rows(picks, rule):
    """只留這套規則的列:mean → r > 0;lb → o > 0;舊格式(沒有 r / o)→ 不篩。"""
    rows = [p for p in (picks or []) if p]
    if not any(('r' in p) or ('o' in p) for p in rows):
        return rows
    k = 'o' if rule == 'lb' else 'r'
    return [p for p in rows if (_num(p.get(k)) or 0) > 0]


def rule_key(p, rule):
    """排序用的值(同 App `_pbKey`):mean 照 exp(沒有就退回 lb);lb 照 lb(沒有就退回 exp)。
    ⚠️ 這一列沒有 r / o(舊格式名單)→ 一律照 lb(= 舊排法)—— ⛔ 不可照平均:舊名單只有舊排法挑的那幾列,照平均排是兩套都不是的順序。"""
    if 'r' not in p and 'o' not in p:
        rule = 'lb'
    a, b = (p.get('lb'), p.get('exp')) if rule == 'lb' else (p.get('exp'), p.get('lb'))
    v = _num(a)
    if v is None:
        v = _num(b)
    return v if v is not None else 0.0
