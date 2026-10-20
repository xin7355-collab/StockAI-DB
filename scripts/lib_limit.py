"""
📏🧱 台股漲跌幅制度 + 價格斷崖守門 —— Python 版(跟 scripts/lib_limit.mjs / lib_cliff.mjs 同一組數字)

⛔ 別在探針裡各寫一份 9.6 / 9.7 / 1.095 / 整檔剔除 —— 2015-06-01 前漲跌幅是 ±7%(陷阱 #52),
   16 年回測寫死 ±10% 會把 2010~2015 開盤就鎖死、根本買不到的那幾筆當成買得到。
⭐ 兩份實作靠 scripts/test_lib_limit.mjs 跨語言比對(同一批案例 JS == Python),改一邊沒改另一邊就紅。
"""

LIMIT_CHANGE = '2015-06-01'
CLIFF_LO, CLIFF_HI = 0.67, 1.5


def _iso(d):
    return str(d or '').replace('/', '-')[:10]


def limit_of(d):
    """那一天的漲跌幅限制(小數 0.07 / 0.10)。'YYYY-MM-DD' 或 'YYYY/MM/DD' 都收。"""
    return 0.07 if _iso(d) < LIMIT_CHANGE else 0.10


def limit_pct(d):
    """同上,但用百分比(7 / 10),給「漲跌幅 %」那種欄位用。"""
    return 7.0 if _iso(d) < LIMIT_CHANGE else 10.0


def locked_bar(date, prev_close, o, h, l, slack=0.003):
    """一價到底鎖死(高 = 低、跟前收差到接近限制)→ 1 鎖漲停、-1 鎖跌停、0 沒鎖。同 lockedBar。"""
    try:
        pc, o, h, l = float(prev_close or 0), float(o or 0), float(h or 0), float(l or 0)
    except (TypeError, ValueError):
        return 0
    if not (pc > 0 and o > 0) or h != l:
        return 0
    g, lim = o / pc - 1, limit_of(date) - slack
    return 1 if g >= lim else (-1 if g <= -lim else 0)


def limit_flag(date, chg_pct, slack_pct=0.4):
    """收盤漲跌幅(%)有沒有到漲跌停:1 / -1 / 0。slack 預設 0.4 個百分點(= 舊寫法 ±9.6% 在 ±10% 制度下的寬度)。"""
    try:
        p = float(chg_pct)
    except (TypeError, ValueError):
        return 0
    lim = limit_pct(date) - slack_pct
    return 1 if p >= lim else (-1 if p <= -lim else 0)


def up_limit_close(date, close, prev_close, slack=0.005):
    """收盤停在漲停價 →「今天尾盤買」買不到。同 upLimitClose(slack 0.5 個百分點)。"""
    try:
        c, pc = float(close or 0), float(prev_close or 0)
    except (TypeError, ValueError):
        return False
    return pc > 0 and c > 0 and c >= pc * (1 + limit_of(date) - slack)


def cliff_prefix(closes, opens=None):
    """前綴和:pre[k+1] = 第 0..k 根裡有幾根「跟前一根之間有斷崖」(×1.5 / ×0.67,收盤或開盤 vs 前收)。同 cliffPrefix。"""
    n = len(closes)
    pre = [0] * (n + 1)
    for k in range(n):
        b = 0
        if k > 0:
            try:
                c0, c1 = float(closes[k - 1] or 0), float(closes[k] or 0)
            except (TypeError, ValueError):
                c0 = c1 = 0.0
            if c0 > 0 and c1 > 0:
                r1 = c1 / c0
                o = float(opens[k] or 0) if opens is not None else 0.0
                r2 = o / c0 if o > 0 else 1.0
                if not (CLIFF_LO <= r1 <= CLIFF_HI) or not (CLIFF_LO <= r2 <= CLIFF_HI):
                    b = 1
        pre[k + 1] = pre[k] + b
    return pre


def cliff_in(pre, a, b):
    """第 a+1 根到第 b 根之間(含兩端「跟前一根比」)有沒有斷崖;a、b 夾到資料範圍內。同 cliffIn。"""
    n = len(pre) - 1
    hi, lo = min(b, n - 1) + 1, max(a, -1) + 1
    return hi > lo and pre[hi] - pre[lo] > 0


def _eval_cases(cases):
    """給 test_lib_limit.mjs 跨語言比對用:案例清單 → 同順序的答案(⛔ 正式程式不要呼叫)。"""
    out = []
    for c in cases:
        f = c['f']
        if f == 'limit_of':
            out.append(limit_of(c['d']))
        elif f == 'locked_bar':
            out.append(locked_bar(*c['a']))
        elif f == 'limit_flag':
            out.append(limit_flag(*c['a']))
        elif f == 'up_limit_close':
            out.append(bool(up_limit_close(*c['a'])))
        elif f == 'cliff':
            pre = cliff_prefix(c['c'], c.get('o'))
            out.append([bool(cliff_in(pre, a, b)) for a, b in c['w']])
        else:
            out.append(None)
    return out


if __name__ == '__main__':
    import json
    import sys
    print(json.dumps(_eval_cases(json.load(sys.stdin))))
