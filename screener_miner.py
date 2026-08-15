#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔎 自訂選股 —— 全市場逐檔特徵快照(V73.5.0)

❓ 為什麼需要這支:使用者要 XQ 那種「自己勾條件、自由組合」的選股。
   ⛔ 前端**不可能**為了篩選去下載 2,700 個 `data/{sym}.json`(合計數百 MB)
   → 採礦端先把「篩選會用到的欄位」逐檔算好,壓成**一個檔** `data/screener.json`。

⭐ 設計上的三個決定(⛔ 改之前先讀):
 ① **cols + rows 壓縮格式**:`rows` 是 `{代號: [值, 值, …]}`,欄位名只寫一次在 `cols`。
    用逐檔物件(`{"c":…,"chg":…}`)會讓檔案大約 **3 倍**;實測壓縮格式約 500KB。
 ② **零額外 API** —— 全部來自既有的 `data/*.json`(OHLCV+法人+融資券)與既有快取
    (`fundamentals_cache` / `fund_yoy_gm` / `tdcc_holders` / `attention_status` / `industry_map`)。
 ③ **算不出來一律寫 `null`,⛔ 不補 0** —— 0 在「外資買賣超」是「沒買沒賣」、
    在「殖利率」是「不配息」,跟「沒有資料」完全不同。前端篩選時 null 一律**不通過**
    數值條件(⛔ 不可當成 0 去比大小,那會選出一堆其實沒資料的股票)。

⚠️ 已知限制(誠實寫進輸出的 `caveat`,前端要顯示):
   ・籌碼欄位(`foreign_net`/`trust_net`)本專案**只回溯到 2026/05**
     → 連買天數這類「要連續好幾天」的條件,樣本本來就淺(CLAUDE.md V72.9.7)。
   ・上市/上櫃只靠 `fundamentals_cache` 是否有值粗分會誤判 → ⛔ 不做,改用官方產業代碼有無。
   ・⛔ **不提供回測按鈕** —— 任意條件組合的歷史回測需要「每天一份全市場快照」,
     本專案沒有那份歷史;做一個沒有對照組的假回測比不做更糟(CLAUDE.md 一貫立場)。
     替代:選出來的每一檔直接標 App 已有的**實測成績**(`playbook_edge` / `today_signals`)。

🚧 空過守門:有效檔數 < 800 → exit 1(⛔ 不可寫出半殘的快照蓋掉昨天的好檔)。
"""
import json
import math
import os
import sys
import time
from pathlib import Path

DATA = Path(os.getenv('DATA_DIR') or 'data')
OUT = DATA / 'screener.json'
MIN_OK = int(os.getenv('SCREENER_MIN_OK') or 800)
MIN_BARS = 70          # 至少要有 70 根 K 才算得出 60 日的東西

# TWSE/TPEX 官方產業代碼(穩定,⛔ 別改成用 AI 生成)
IND = {
    '01': '水泥', '02': '食品', '03': '塑膠', '04': '紡織', '05': '電機機械',
    '06': '電器電纜', '07': '化學生技', '08': '玻璃陶瓷', '09': '造紙', '10': '鋼鐵',
    '11': '橡膠', '12': '汽車', '13': '電子', '14': '營建', '15': '航運',
    '16': '觀光餐旅', '17': '金融保險', '18': '貿易百貨', '19': '綜合', '20': '其他',
    '21': '化學', '22': '生技醫療', '23': '油電燃氣', '24': '半導體', '25': '電腦週邊',
    '26': '光電', '27': '通信網路', '28': '電子零組件', '29': '電子通路', '30': '資訊服務',
    '31': '其他電子', '32': '文化創意', '33': '農業科技', '34': '電子商務', '35': '綠能環保',
    '36': '數位雲端', '37': '運動休閒', '38': '居家生活', '80': '管理股票',
}

COLS = [
    # ── 價量 ──
    'c',        # 收盤
    'chg',      # 今日漲跌 %
    'chg5', 'chg20', 'chg60',
    'amt',      # 成交金額(億)
    'vr',       # 量比:今量 ÷ 20 日均量 ×100
    'pos252',   # 一年位階 %
    'dd60',     # 距 60 日高 %(負值)
    'b5', 'b20', 'b60', 'b240',   # 乖離各均線 %
    'rsi',      # RSI14
    'vol20',    # 20 日實現波動率(年化 %)
    'clr',      # 收盤在當日高低區間的位置 %(100=收最高)
    'streak',   # 連紅天數(負=連黑)
    'lim',      # 1=漲停 −1=跌停 0=否
    'nh',       # 創幾日新高(5/20/60/252;0=沒創新高)
    'nl',       # 創幾日新低
    'rs',       # 相對強度:今日漲跌% − 大盤今日漲跌%(>0 = 優於大盤)
    'bull',     # 1=均線多頭排列(5>20>60)
    'amp20',    # 20 日平均振幅 %
    'b10',      # 乖離 10MA %
    'sl5', 'sl60',   # 5MA / 60MA 斜率(對 5 日前,%)—— 「均線翻揚/翻黑」
    'knot',     # 均線糾結度:5/10/20MA 三者最大差距 %(越小越糾結)
    'k', 'd',   # KD(9,3,3)
    'kx',       # 1=今日 KD 黃金交叉 ・ −1=死亡交叉 ・ 0=沒交叉
    'dif', 'dea',
    'mx',       # 1=今日 MACD 黃金交叉 ・ −1=死亡交叉
    'bb',       # 布林通道位置 %(0=下軌 100=上軌;>100 = 突破上軌)
    'mtm6',     # 6 日動量(c − 6 日前 c)
    'mtmt',     # 1=MTM 由負轉正 ・ −1=由正轉負
    'v5',       # 5 日均量(張)
    'vr5',      # 今量 ÷ 5 日均量 ×100
    'vnh', 'vnl',    # 成交量創 N 日新高 / 新低(5/20;0=沒有)
    'turn5',    # 近 5 日週轉率 %(5 日成交股數 ÷ 總股數)
    # ── 籌碼 ──
    'f1', 'f3', 'f5', 'f10',   # 外資買賣超(張)
    'fd',       # 外資連買(+)/連賣(−)天數
    'fpct',     # 外資今日買超佔成交量 %
    'fdays',    # 外資近 10 日「買超天數」(⛔ 跟 f10 累計張數是兩件事)
    'fturn',    # 1 = 外資連 3 日賣超之後今天轉買
    't1', 't3', 't5',          # 投信買賣超(張)
    'td',       # 投信連買/連賣天數
    'tdays',    # 投信近 10 日買超天數
    'tturn',    # 1 = 投信連 3 日賣超之後今天轉買
    'tpct',     # 投信今日買超佔成交量 %
    'd1', 'd3',  # 自營商買賣超(張)
    'dd',       # 自營商連買/連賣天數
    'mg5',      # 融資 5 日增減(張)
    'mgp',      # 融資 5 日增減 %
    'mgd',      # 融資連續增加(+)/減少(−)天數
    'mgnl',     # 1=融資餘額創 5 日新低 ・ −1=創 5 日新高
    'sbr',      # 券資比 %
    'sb3',      # 融券近 3 日增減(張)
    'sbd',      # 融券連續增加(+)/減少(−)天數
    'sbnh',     # 1=融券餘額創 5 日新高
    'sbv',      # 融券餘額 ÷ 10 日均量 %(軋空空間)
    'fcap',     # 外資今日買超佔總股數 %(= XQ 的「佔股本比例」)
    'tcap',     # 投信今日買超佔總股數 %
    'big',      # 千張大戶持股 %
    'sml',      # 散戶(<10 張)持股 %
    'bchg',     # 大戶近 4 週變化 pp
    # ── 財務 ──
    'pe', 'pb', 'yld', 'yoy', 'gm', 'payout',
    # ── 分類(數值旗標)──
    'etf',      # 1=ETF
    'att',      # 0 無 / 1 注意股 / 2 處置中
    'tse',      # 1=上市(有官方產業別);0=其他(上櫃/興櫃/ETF)
    'dr',       # 1=存託憑證(DR,代號 6 碼且 91 開頭)
]
CI = {k: i for i, k in enumerate(COLS)}


def rd(v, n=2):
    if v is None:
        return None
    try:
        f = float(v)
    except Exception:
        return None
    if not math.isfinite(f):
        return None
    return round(f, n)


def load(name):
    p = DATA / name
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except Exception as e:
        print(f'⚠️ {name} 讀不起來:{type(e).__name__}')
        return None


def lots(v):
    """法人欄位是**股**,一律換算成張(同前端 _volToLots 的用意:單位只換算一次)。"""
    if v is None:
        return None
    try:
        return float(v) / 1000.0
    except Exception:
        return None


def streak_of(seq):
    """回連續同號天數:正=連續為正,負=連續為負,0=最新一筆是 0/None。"""
    if not seq:
        return 0
    last = seq[-1]
    if last is None or last == 0:
        return 0
    sign = 1 if last > 0 else -1
    n = 0
    for v in reversed(seq):
        if v is None or v == 0 or (1 if v > 0 else -1) != sign:
            break
        n += 1
    return n * sign


def build_one(rows, twii_chg=None):
    """rows = data/{sym}.json 的列(舊→新)。回 (values, ok)。⛔ 只用到當天為止的資料。"""
    n = len(rows)
    if n < MIN_BARS:
        return None
    try:
        cl = [float(r['close']) for r in rows]
        hi = [float(r.get('high') or r['close']) for r in rows]
        lo = [float(r.get('low') or r['close']) for r in rows]
        vo = [float(r.get('volume') or 0) for r in rows]
    except Exception:
        return None
    if cl[-1] <= 0:
        return None
    v = [None] * len(COLS)
    c = cl[-1]
    v[CI['c']] = rd(c)
    if n >= 2 and cl[-2] > 0:
        v[CI['chg']] = rd((c / cl[-2] - 1) * 100)
        # 漲跌停:±10% 容許四捨五入誤差(⛔ 別寫死 9.9,新股/ETF 另有級距)
        p = (c / cl[-2] - 1) * 100
        v[CI['lim']] = 1 if p >= 9.6 else (-1 if p <= -9.6 else 0)
    for k, d in (('chg5', 5), ('chg20', 20), ('chg60', 60)):
        if n > d and cl[-1 - d] > 0:
            v[CI[k]] = rd((c / cl[-1 - d] - 1) * 100)

    # 成交金額(億):volume 是股 → close × 股 ÷ 1e8
    v[CI['amt']] = rd(c * vo[-1] / 1e8)
    v20 = sum(vo[-20:]) / 20.0
    if v20 > 0:
        v[CI['vr']] = rd(vo[-1] / v20 * 100, 1)

    w = cl[-252:] if n >= 252 else cl
    lo252, hi252 = min(w), max(w)
    if hi252 > lo252:
        v[CI['pos252']] = rd((c - lo252) / (hi252 - lo252) * 100, 1)
    h60 = max(hi[-60:])
    if h60 > 0:
        v[CI['dd60']] = rd((c / h60 - 1) * 100)

    for k, d in (('b5', 5), ('b20', 20), ('b60', 60), ('b240', 240)):
        if n >= d:
            m = sum(cl[-d:]) / d
            if m > 0:
                v[CI[k]] = rd((c / m - 1) * 100)

    # RSI14(Wilder)
    ag = al = 0.0
    for i in range(max(1, n - 400), n):
        dd = cl[i] - cl[i - 1]
        g, l_ = (dd, 0.0) if dd > 0 else (0.0, -dd)
        if i <= max(1, n - 400) + 13:
            ag += g / 14.0
            al += l_ / 14.0
        else:
            ag = (ag * 13 + g) / 14.0
            al = (al * 13 + l_) / 14.0
    v[CI['rsi']] = rd(100.0 if al <= 0 else 100.0 - 100.0 / (1.0 + ag / al), 1)

    s = 0.0
    for i in range(n - 20, n):
        if cl[i - 1] > 0:
            s += (cl[i] / cl[i - 1] - 1.0) ** 2
    v[CI['vol20']] = rd(math.sqrt(s / 20.0) * math.sqrt(252.0) * 100, 1)

    rng = hi[-1] - lo[-1]
    v[CI['clr']] = rd((c - lo[-1]) / rng * 100, 1) if rng > 0 else 50.0

    ups = []
    for i in range(max(1, n - 30), n):
        ups.append(1 if cl[i] > cl[i - 1] else (-1 if cl[i] < cl[i - 1] else 0))
    v[CI['streak']] = streak_of(ups)

    # ⭐ 由大到小,回「最強的那一個」:創年新高的一定也創了 5 日新高,
    #    前端「創 5 日新高」要判 `nh >= 5`(⛔ 不是 `nh === 5`)
    nh = 0
    for d in (252, 60, 20, 5):
        if n >= d and c >= max(cl[-d:]) - 1e-9:
            nh = d
            break
    v[CI['nh']] = nh
    nl = 0
    for d in (252, 60, 20, 5):
        if n >= d and c <= min(cl[-d:]) + 1e-9:
            nl = d
            break
    v[CI['nl']] = nl

    # ⭐ 相對強度:⛔ 只在「這一檔的最新日 == 大盤的最新日」時才算,
    #    不同日相減會得到一個看起來合理但其實錯的數字(同順逆價差陷阱 #22 的教訓)
    if twii_chg is not None and v[CI['chg']] is not None:
        v[CI['rs']] = rd(v[CI['chg']] - twii_chg)

    if n >= 60:
        m5, m20, m60 = sum(cl[-5:]) / 5, sum(cl[-20:]) / 20, sum(cl[-60:]) / 60
        v[CI['bull']] = 1 if (m5 > m20 > m60) else 0

    a = 0.0
    for i in range(n - 20, n):
        if cl[i] > 0:
            a += (hi[i] - lo[i]) / cl[i]
    v[CI['amp20']] = rd(a / 20.0 * 100, 2)

    # ── 均線:10MA 乖離、5/60MA 斜率(對 5 日前)、5/10/20 糾結度 ──
    def ma_at(end, k):
        """end = 索引(含),回 k 日均價;不足回 None。"""
        if end + 1 - k < 0:
            return None
        return sum(cl[end + 1 - k:end + 1]) / k

    m10 = ma_at(n - 1, 10)
    if m10 and m10 > 0:
        v[CI['b10']] = rd((c / m10 - 1) * 100)
    for key, k in (('sl5', 5), ('sl60', 60)):
        cur, prev = ma_at(n - 1, k), ma_at(n - 6, k)
        if cur and prev and prev > 0:
            v[CI[key]] = rd((cur / prev - 1) * 100, 2)
    m5v, m20v = ma_at(n - 1, 5), ma_at(n - 1, 20)
    if m5v and m10 and m20v and c > 0:
        v[CI['knot']] = rd((max(m5v, m10, m20v) - min(m5v, m10, m20v)) / c * 100, 2)

    # ── KD(9,3,3):要算出「今天有沒有交叉」→ 需要昨天的 K/D,所以整條遞推 ──
    if n >= 30:
        kv = dv = 50.0
        prev_k = prev_d = None
        start = max(9, n - 200)
        for i in range(start, n):
            ll, hh = min(lo[i - 8:i + 1]), max(hi[i - 8:i + 1])
            rsv = 50.0 if hh <= ll else (cl[i] - ll) / (hh - ll) * 100
            prev_k, prev_d = kv, dv
            kv = kv * 2 / 3 + rsv / 3
            dv = dv * 2 / 3 + kv / 3
        v[CI['k']], v[CI['d']] = rd(kv, 1), rd(dv, 1)
        if prev_k is not None:
            v[CI['kx']] = 1 if (prev_k <= prev_d and kv > dv) else (-1 if (prev_k >= prev_d and kv < dv) else 0)

    # ── MACD(12,26,9)──
    if n >= 40:
        ef = es = cl[max(0, n - 250)]
        dif_hist = []
        for i in range(max(0, n - 250), n):
            ef = ef + (cl[i] - ef) * 2 / 13
            es = es + (cl[i] - es) * 2 / 27
            dif_hist.append(ef - es)
        dea = dif_hist[0]
        prev_dif = prev_dea = None
        for x in dif_hist:
            prev_dif, prev_dea = x, dea
            dea = dea + (x - dea) * 2 / 10
        dif = dif_hist[-1]
        v[CI['dif']], v[CI['dea']] = rd(dif, 3), rd(dea, 3)
        if len(dif_hist) >= 2:
            # 重算前一根的 dea 才能判交叉
            dea2 = dif_hist[0]
            for x in dif_hist[:-1]:
                dea2 = dea2 + (x - dea2) * 2 / 10
            p_dif = dif_hist[-2]
            v[CI['mx']] = 1 if (p_dif <= dea2 and dif > dea) else (-1 if (p_dif >= dea2 and dif < dea) else 0)

    # ── 布林通道位置(20, 2σ)──
    if n >= 20 and m20v:
        var = sum((x - m20v) ** 2 for x in cl[-20:]) / 20.0
        sd = math.sqrt(var)
        if sd > 0:
            v[CI['bb']] = rd((c - (m20v - 2 * sd)) / (4 * sd) * 100, 1)

    # ── 6 日動量 ──
    if n >= 8:
        m_now = c - cl[-7]
        m_prev = cl[-2] - cl[-8]
        v[CI['mtm6']] = rd(m_now)
        v[CI['mtmt']] = 1 if (m_prev <= 0 < m_now) else (-1 if (m_prev >= 0 > m_now) else 0)

    # ── 量能:5 日均量、量創新高低 ──
    v5 = sum(vo[-5:]) / 5.0
    if v5 > 0:
        v[CI['v5']] = rd(v5 / 1000.0, 0)          # 張
        v[CI['vr5']] = rd(vo[-1] / v5 * 100, 1)
    vnh = 0
    for dd_ in (20, 5):
        if n >= dd_ and vo[-1] >= max(vo[-dd_:]) - 1e-9:
            vnh = dd_
            break
    v[CI['vnh']] = vnh
    vnl = 0
    for dd_ in (20, 5):
        if n >= dd_ and vo[-1] <= min(vo[-dd_:]) + 1e-9:
            vnl = dd_
            break
    v[CI['vnl']] = vnl

    # ── 籌碼(⛔ 只有近期才有值 → 沒有一律 None,不補 0)──
    def acc(field, d):
        seg = [r.get(field) for r in rows[-d:]]
        seg = [x for x in seg if x is not None]
        return rd(lots(sum(seg)), 0) if seg else None

    v[CI['f1']] = rd(lots(rows[-1].get('foreign_net')), 0) if rows[-1].get('foreign_net') is not None else None
    v[CI['f3']], v[CI['f5']], v[CI['f10']] = acc('foreign_net', 3), acc('foreign_net', 5), acc('foreign_net', 10)
    v[CI['fd']] = streak_of([r.get('foreign_net') for r in rows[-15:]])
    if vo[-1] > 0 and rows[-1].get('foreign_net') is not None:
        v[CI['fpct']] = rd(float(rows[-1]['foreign_net']) / vo[-1] * 100, 2)
    v[CI['t1']] = rd(lots(rows[-1].get('trust_net')), 0) if rows[-1].get('trust_net') is not None else None
    v[CI['t3']], v[CI['t5']] = acc('trust_net', 3), acc('trust_net', 5)
    v[CI['td']] = streak_of([r.get('trust_net') for r in rows[-15:]])

    def days_pos(field):
        """近 10 日買超天數。⛔ 有值的天數不足 10 就回 None(不可把「沒資料」算成「沒買」)。"""
        seg = [r.get(field) for r in rows[-10:]]
        if sum(1 for x in seg if x is not None) < 10:
            return None
        return sum(1 for x in seg if x > 0)

    def turn_buy(field):
        """連 3 日賣超之後今天轉買。⛔ 任一天沒資料就回 None。"""
        seg = [r.get(field) for r in rows[-4:]]
        if len(seg) < 4 or any(x is None for x in seg):
            return None
        return 1 if (seg[3] > 0 and seg[0] < 0 and seg[1] < 0 and seg[2] < 0) else 0

    v[CI['fdays']], v[CI['tdays']] = days_pos('foreign_net'), days_pos('trust_net')
    v[CI['fturn']], v[CI['tturn']] = turn_buy('foreign_net'), turn_buy('trust_net')
    if vo[-1] > 0 and rows[-1].get('trust_net') is not None:
        v[CI['tpct']] = rd(float(rows[-1]['trust_net']) / vo[-1] * 100, 2)
    v[CI['d1']] = rd(lots(rows[-1].get('dealer_net')), 0) if rows[-1].get('dealer_net') is not None else None
    v[CI['d3']] = acc('dealer_net', 3)
    v[CI['dd']] = streak_of([r.get('dealer_net') for r in rows[-15:]])

    mb = [r.get('margin_balance') for r in rows[-6:]]
    mb = [x for x in mb if x is not None]
    if len(mb) >= 2:
        v[CI['mg5']] = rd(mb[-1] - mb[0], 0)
        if mb[0] > 0:
            v[CI['mgp']] = rd((mb[-1] / mb[0] - 1) * 100, 1)
    m_last, s_last = rows[-1].get('margin_balance'), rows[-1].get('short_balance')
    if m_last and s_last is not None and float(m_last) > 0:
        v[CI['sbr']] = rd(float(s_last) / float(m_last) * 100, 1)

    # ── 融資券的「連續天數 / 創 N 日新高低」(⛔ 有缺值就不算,不可拿 None 當 0)──
    def _bal_seq(field, k):
        seg = [r.get(field) for r in rows[-k:]]
        return seg if (len(seg) == k and all(x is not None for x in seg)) else None

    mg = _bal_seq('margin_balance', 7)
    if mg:
        v[CI['mgd']] = streak_of([mg[i] - mg[i - 1] for i in range(1, len(mg))])
    mg5s = _bal_seq('margin_balance', 5)
    if mg5s:
        v[CI['mgnl']] = 1 if mg5s[-1] <= min(mg5s) else (-1 if mg5s[-1] >= max(mg5s) else 0)
    sb = _bal_seq('short_balance', 7)
    if sb:
        v[CI['sbd']] = streak_of([sb[i] - sb[i - 1] for i in range(1, len(sb))])
        v[CI['sb3']] = rd(sb[-1] - sb[-4], 0)
    sb5 = _bal_seq('short_balance', 5)
    if sb5:
        v[CI['sbnh']] = 1 if sb5[-1] >= max(sb5) else 0
    if s_last is not None and n >= 10:
        v10 = sum(vo[-10:]) / 10.0 / 1000.0      # 10 日均量(張)
        if v10 > 0:
            v[CI['sbv']] = rd(float(s_last) / v10 * 100, 1)
    return v


def main():
    if not DATA.exists():
        print(f'❌ 找不到 {DATA}')
        return 1
    fc = load('fundamentals_cache.json') or {}
    fy = load('fund_yoy_gm.json') or {}
    td = load('tdcc_holders.json') or {}
    att = (load('attention_status.json') or {}).get('stocks') or {}
    imap = load('industry_map.json') or {}

    # 大盤今日漲跌%(算「優於大盤」用)。⛔ 拿不到就整欄留 None,不硬給。
    tw = load('^TWII.json') or []
    tw = tw if isinstance(tw, list) else (tw.get('data') or [])
    # ⭐ 建「日期 → 大盤當日漲跌%」對照表,⛔ 不是只取最後一天 ——
    #    大盤與個股的最新日常常差一天(採礦時序),只比最後一天會讓整欄空掉;
    #    查各自日期則兩邊都對得起來,而且**跨日相減**這個錯依然被擋住(查不到就 None)。
    twii_by_date = {}
    for i in range(1, len(tw)):
        try:
            p = float(tw[i - 1]['close'])
            if p > 0:
                twii_by_date[str(tw[i]['date']).replace('/', '-')] = (float(tw[i]['close']) / p - 1) * 100
        except Exception:
            pass
    print(f'📈 大盤漲跌對照表 {len(twii_by_date)} 天'
          f'{"(最新 " + str(tw[-1]["date"]).replace("/", "-") + ")" if tw else ""}')

    files = sorted(p for p in DATA.glob('*.json') if p.stem.isdigit() and not p.stem.startswith('_'))
    print(f'📂 掃 {len(files)} 檔')
    rows_out, names_ind = {}, {}
    dates = {}
    skipped = 0
    for p in files:
        sym = p.stem
        try:
            d = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            skipped += 1
            continue
        d = d if isinstance(d, list) else (d.get('data') or [])
        # ⛔ 相對強度一律查「這一檔自己最新日」的大盤漲跌;查不到就留空(不同日相減是錯的)
        my_date = str(d[-1].get('date', '')).replace('/', '-') if d else ''
        v = build_one(d, twii_by_date.get(my_date))
        if v is None:
            skipped += 1
            continue

        # 大戶/散戶(集保週更;⛔ 沒有就 None,別拿舊到過期的值硬填)
        t = td.get(sym) or {}
        h = t.get('h') or []
        # ⭐ 總股數(集保 `t`)→ 週轉率 與「買超佔股本比例」的分母。
        #    ⛔ 沒有總股數就整組留 None(⛔ 不可拿成交量硬湊一個看起來合理的數字)
        try:
            tot = float(t.get('t') or 0)
        except Exception:
            tot = 0.0
        if tot > 0:
            try:
                d5 = d[-5:]
                vol5 = sum(float(r.get('volume') or 0) for r in d5)
                v[CI['turn5']] = rd(vol5 / tot * 100, 2)
            except Exception:
                pass
            fn_ = d[-1].get('foreign_net')
            tn_ = d[-1].get('trust_net')
            if fn_ is not None:
                v[CI['fcap']] = rd(float(fn_) / tot * 100, 3)
            if tn_ is not None:
                v[CI['tcap']] = rd(float(tn_) / tot * 100, 3)
        if h:
            try:
                v[CI['big']] = rd(float(h[-1][1]), 2)
                v[CI['sml']] = rd(float(h[-1][3]), 2)
                if len(h) >= 5:
                    v[CI['bchg']] = rd(float(h[-1][1]) - float(h[-5][1]), 2)
            except Exception:
                pass

        f1 = fc.get(sym) or {}
        f2 = fy.get(sym) or {}
        v[CI['pe']] = rd(f1.get('pe'))
        v[CI['pb']] = rd(f1.get('pbr') if f1.get('pbr') is not None else f2.get('pb'))
        v[CI['yld']] = rd(f1.get('yield_rate'))
        # ⭐ 殖利率缺值時用「每股股利 ÷ 現價」補(同前端 V73.4.1 的 fallback,⛔ 公式只有一份)
        if v[CI['yld']] is None and f2.get('div') and v[CI['c']]:
            v[CI['yld']] = rd(float(f2['div']) / float(v[CI['c']]) * 100)
        v[CI['yoy']] = rd(f2.get('yoy'), 1)
        v[CI['gm']] = rd(f2.get('gm'), 1)
        v[CI['payout']] = rd(f2.get('payout'), 1)

        v[CI['etf']] = 1 if sym.startswith('00') else 0
        st = (att.get(sym) or {}).get('status') or ''
        v[CI['att']] = 2 if '處置' in st else (1 if '注意' in st else 0)

        # ⭐ 上市判定:`industry_map.json` 來自 TWSE 公司基本資料(t187ap03)= **只有上市**。
        #    實測 2026-08:表內 1,093 檔;知名上市 6/6 都在,知名上櫃幾乎都不在。
        #    ⚠️ 這是**推導**不是官方掛牌欄位 → 剛轉上市的可能還沒進表,文案要說清楚。
        code = imap.get(sym)
        v[CI['tse']] = 1 if code else 0
        v[CI['dr']] = 1 if (len(sym) == 6 and sym.startswith('91')) else 0
        if code:
            names_ind[sym] = IND.get(str(code), str(code))

        rows_out[sym] = v
        try:
            dates[str(d[-1]['date']).replace('/', '-')] = dates.get(str(d[-1]['date']).replace('/', '-'), 0) + 1
        except Exception:
            pass

    ok = len(rows_out)
    print(f'✅ 有效 {ok} 檔・略過 {skipped} 檔')
    if ok < MIN_OK:
        print(f'❌ 只有 {ok} 檔 < {MIN_OK} → 🚧 空過守門,⛔ 不覆寫既有快照')
        return 1

    # 資料日期取「最多檔共用的那一天」(⛔ 不用 max —— 少數檔可能已寫入隔日盤中列,陷阱 #14)
    data_date = max(dates.items(), key=lambda x: x[1])[0] if dates else ''
    cov = {k: sum(1 for v in rows_out.values() if v[CI[k]] is not None) for k in COLS}

    out = {
        'updated': time.strftime('%Y-%m-%d %H:%M', time.localtime()),
        'data_date': data_date,
        'n': ok,
        'cols': COLS,
        'rows': rows_out,
        'ind': names_ind,
        'cov': cov,
        'caveat': ('籌碼欄位(外資/投信/融資)本站只回溯到 2026/05,連買天數這類條件樣本較淺;'
                   '沒有資料的欄位一律不通過數值條件,不會被當成 0。'),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    kb = OUT.stat().st_size / 1024
    print(f'💾 {OUT} 寫出 {kb:.0f} KB・資料日 {data_date}')
    # ⭐ 覆蓋率一定要印:欄位存在 ≠ 有資料(V72.1.6 的教訓)
    thin = [(k, cov[k]) for k in COLS if cov[k] < ok * 0.5]
    print('📊 覆蓋率偏低的欄位(前端要據此把條件標成「資料較少」):')
    for k, c_ in sorted(thin, key=lambda x: x[1])[:14]:
        print(f'     {k:<8}{c_:>6} / {ok}  ({c_ / ok * 100:.0f}%)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
