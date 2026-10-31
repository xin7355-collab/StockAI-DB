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


# 🧬 V80.0.9 決策台「今天可以買的」那條篩選(= index `_deckBuyOf` / auto_trade `fetch_picks`):
#   只留這套規則的列 → 🧬 排前面 → 這套規則的值 → 同一檔只留最好那一招 → 🧬 而且這一檔自己不是空頭。
#   以前 Telegram(alert_system)只排序不擋 → 🧬 不夠 2 檔、或這一檔自己空頭時,照樣推「買點到了」(陷阱 #37)。
#   ⛔ 少了「自己手上的優先」那一層(雲端讀不到 App 的自選 / 庫存)。test_pbpick_same 跨檔比對決策台 / auto_trade / alert_system。
#   ⚠️ auto_trade.py 自己有一份 gene_hq(會動真錢,⛔ 不為了共用去動它)—— 兩份由 test_pbpick_same 同一份清單比對。
GENE_RANK = 85   # 🧬 一年位階門檻(= index `_GENE_RULE.rank`;舊的是 75,環境變數 GENE_RANK=75 換回)
GENE_VOL = 60    # 🧬 年化波動率門檻(= index `_GENE_RULE.vol`)


def gene_rank(env=None):
    """環境變數 GENE_RANK → 85(預設)/ 75(換回舊的);其他值一律當預設(同 auto_trade)。"""
    return 75 if str(env or '').strip() == '75' else GENE_RANK


def gene_hq(p, rank=GENE_RANK):
    """🧬 這一筆是不是強勢高波動:清單帶 rank / vol 就用它算(設定換門檻時跟著變),沒帶就退回採礦端標的 hq。"""
    r, v = _num(p.get('rank')), _num(p.get('vol'))
    if r is not None and v is not None:
        return 1 if (r >= rank and v >= GENE_VOL) else 0
    return 1 if p.get('hq') else 0


def deck_pick(picks, rule, rank=GENE_RANK):
    """決策台那條篩選:回「🧬 而且這一檔自己不是空頭」的名單(同一檔只留最好那一招),順序 = 決策台的順序。
    呼叫端取前 N 檔(N = 一天最多買幾檔)就是決策台「今天可以買的」。"""
    rows = sorted(rule_rows(picks, rule), key=lambda p: (-gene_hq(p, rank), -rule_key(p, rule)))   # 穩定排序:同分照採礦端順序
    out, seen = [], set()
    for p in rows:
        s = str(p.get('s') or '')
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(p)
    return [p for p in out if gene_hq(p, rank) == 1 and not p.get('bear')]
