#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📰 重大訊息事件研究(V79.3.8,變因因子研究「事件類」)—— 公告之後那一檔怎麼走?

資料:mops_backfill 存在 orphan 分支 mops_deep 的 {YYYY-MM}.json.gz(rows = [代號, 名稱, 日期, 時間, 主旨, 市場])
+ 日 K(DATA_DIR,{代號}.json)。⛔ 唯讀、⛔ 不改 App。

📐 方法(先寫死,⛔ 跑完不改):
  ・分類 = 主旨關鍵字(CATS,先中先得;⛔ 不用 AI 分類 —— 那會變成沒人能重現的第二份真相)
  ・進場 = **公告之後第一個看得到的開盤**:公告時間 < 08:30 且那天有開盤 → 當天開盤;其他 → 下一個交易日開盤
    (⛔ 盤中 / 盤後公告用當天價 = 偷看;`STRICT=1` 一律下一個交易日開盤當敏感度)
  ・報酬 = 開盤進場 → 5 / 10 / 20 個交易日後收盤,減「同一天、同樣進場方式」全部股票的平均(= 比同一天隨便挑一檔多多少)
  ・同一檔同一類 20 個交易日內只算第一次(⛔ 一波連發的公告不重複計)
  ・進場那天開盤鎖漲停 / 跌停 = 買不到 → 剔除(lib_limit,2015-06 前 ±7%)
  ・🧱 V79.4.6 窗口裡有價格斷崖(減資 / 分割沒還原)→ 那個窗口剔除(lib_limit.cliff_*;事件與對照組同一條)
  ・關卡(先寫死):全部類別一起 BH q ≤ 0.05(t 用「每天的平均」再算,⛔ 同一天多檔不當獨立樣本)
    + 前後半同向 + 逐年 ≥70% 同向(≥5 年有樣本)+ 扣成本 0.44 後同向 → 過關
  ・⛔ 過關也只是「描述」,要當訊號還得疊在 👑 / 🔥 上跑真引擎(第三層)

跑法:MOPS_DIR=mops_deep DATA_DIR=d16 python3 scripts/mops_event_probe.py out.json [--strict]
      python3 scripts/mops_event_probe.py --selftest
"""
import glob
import gzip
import json
import math
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib_limit as LL  # noqa: E402  🔁 V79.4.6 漲跌幅制度 + 斷崖守門共用(⛔ 不在這裡各寫一份)

COST = 0.44
HS = (5, 10, 20)
DEDUP = 20
YR_MIN_N = 20                 # 一年至少幾次才算那一年有樣本

# 先中先得(順序有意義:「代子公司」最先、「澄清」優先於「訂單」、「庫藏股執行完畢」優先於「買回」、
#   「財報」優先於「合併」)。每列 = (鍵, 名稱, 主旨要中的字, strip = 比對前先拿掉的字, veto = 中了就不算這類)
# 🔁 2026-10-20 第一段真資料(2026-08~10,1.1 萬則)試跑後**只看主旨**重整(⛔ 沒看報酬,2.5 個月也看不出報酬):
#   「合併」1,948 則裡 1,820 則是「合併財務報告」(財報,不是併購)→ 財報另成一類、合併比對前拿掉合併財報 / 營收字樣;
#   現金增資混進「取得別家私募 / 增資子公司」、減資混進例行的「限制員工新股註銷」、接單混進「聯貸合約」、
#   災害混進「捐款 / 未受影響」→ 加 veto;「代子公司公告」另成一類;其他那桶找出 面額變更 / 注意交易資訊說明 /
#   財務會計主管異動 / 退票等財務異常 / 暫停交易 五類。⛔ 這之後不再改(selftest ①b 用真實主旨釘住)。
_CONSOL = r'合併(財務報告|財務報表|財報|報表|營收|營業收入|自結|損益|綜合損益|淨利|報告)'
CATS = [
    ('sub', '代子公司 / 孫公司公告', r'代(本公司之)?(重要)?(子|孫)公司', None, None),
    ('distress', '退票 / 違約 / 重整等財務異常', r'退票|跳票|存款不足|重整|紓困|債務協商|違約|無法如期|全額交割|繼續經營|保留意見|無法表示意見|財務危機|終止上市|終止(上櫃|櫃檯買賣)', None, None),
    ('halt', '暫停交易', r'暫停交易|停止買賣', None, None),
    ('clarify', '澄清媒體報導', r'澄清', None, None),
    ('attn', '注意交易資訊說明', r'注意交易資訊|有價證券近期多次|公布注意|股價異常|成交量異常', None, None),
    ('buyback_end', '庫藏股期滿 / 執行完畢 / 註銷 / 轉讓', r'(買回|庫藏股).{0,20}(執行完畢|期滿|屆滿|未執行完畢|註銷|轉讓)|註銷庫藏股', None, None),
    ('buyback', '董事會決議買回庫藏股', r'買回本公司股份|買回庫藏股|實施庫藏股|庫藏股|買回股份', None, None),
    ('selfprofit', '自結損益 / 營收', r'自結', None, None),
    ('finrep', '財報(董事會通過 / 召開日)', r'財務報告|財務報表|財報', None, None),
    ('par', '面額變更 / 股票分割', r'面額|股票分割', None, None),
    ('cb', '發行(可轉換)公司債', r'可轉換公司債|轉換公司債|發行.{0,8}公司債', None, None),
    ('cash_inc', '現金增資 / 私募(本公司)', r'現金增資|私募', None, r'取得|認購|參與|增資.{0,4}(子|孫)公司|對.{0,12}增資'),
    ('cap_red_cash', '現金減資(退錢給股東)', r'現金減資|退還股款', None, None),
    ('cap_red_loss', '減資彌補虧損', r'彌補虧損', None, None),
    ('ma', '合併 / 收購 / 公開收購', r'合併|收購|股份轉換', _CONSOL, None),
    ('boss', '董事長 / 總經理異動', r'(董事長|總經理|執行長).{0,10}(異動|變動|辭任|解任|退休)', None, None),
    ('cfo', '財務 / 會計主管或簽證會計師異動', r'(財務|會計)主管.{0,10}(異動|辭任|解任)|會計師.{0,10}(異動|更換|變更)', None, None),
    ('order', '簽約 / 接單 / 得標', r'簽訂|簽署|得標|訂單|合約|契約', None, r'授信|借款|貸款|融資|租賃|和解|保險|律師|委任|承銷'),
    ('disaster', '火災 / 停工 / 災害', r'火災|停工|停產|地震|颱風|淹水|爆炸|工安|意外事故|災害', None, r'捐|勸募|未受|不受|無重大影響|無影響|順延'),
    ('lawsuit', '訴訟 / 裁罰 / 搜索', r'訴訟|判決|裁罰|罰鍰|起訴|搜索', None, None),
    ('guarantee', '背書保證 / 資金貸與', r'背書保證|資金貸與', None, None),
    ('dividend', '股利 / 除權息相關', r'股利|配息|除權|除息', None, None),
    ('confcall', '法說會', r'法人說明會|法說會', None, None),
    ('asset', '取得 / 處分資產(多半是例行)', r'取得|處分', None, None),
]
_CRE = [(k, lab, re.compile(p), re.compile(st) if st else None, re.compile(vt) if vt else None) for k, lab, p, st, vt in CATS]


def classify(subject):
    s = str(subject or '')
    for k, _lab, rx, strip, veto in _CRE:
        t = strip.sub('', s) if strip else s
        if rx.search(t) and not (veto and veto.search(s)):
            return k
    return 'other'


def tradable_day(dates, d, hhmm, strict=False):
    """公告日期 d、時間 hhmm(HH:MM:SS)→ 第一個看得到的開盤是哪一根(索引);沒有 → None。
    ⛔ 08:30 以後(含盤中、盤後)一律下一個交易日。"""
    import bisect
    i = bisect.bisect_left(dates, d)
    pre_open = (not strict) and str(hhmm or '99')[:5] < '08:30'
    if i < len(dates) and dates[i] == d and pre_open:
        return i
    j = i + 1 if (i < len(dates) and dates[i] == d) else i
    return j if j < len(dates) else None


def load_k(path):
    try:
        j = json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return None
    rows = j if isinstance(j, list) else (j.get('data') or [])
    ds, o, c, h, lo = [], [], [], [], []
    for r in rows:
        try:
            op, cl = float(r['open']), float(r['close'])
        except Exception:
            continue
        if op <= 0 or cl <= 0:
            continue
        ds.append(str(r['date']).replace('/', '-')[:10])
        o.append(op)
        c.append(cl)
        h.append(float(r.get('high') or cl))
        lo.append(float(r.get('low') or cl))
    return {'d': ds, 'o': o, 'c': c, 'h': h, 'l': lo} if len(ds) > 60 else None


def locked(K, i):
    """開盤就鎖死(一價到底):走 lib_limit.locked_bar(2015-06 前 ±7%,⛔ 不在這裡各寫一份)。"""
    if i <= 0:
        return False
    return LL.locked_bar(K['d'][i], K['c'][i - 1], K['o'][i], K['h'][i], K['l'][i]) != 0


def cliff(K, i, h):
    """🧱 V79.4.6 進場那根之後 h 根內有價格斷崖(減資 / 分割沒還原,×1.5 / ×0.67)→ 那個窗口剔除(⛔ 不整檔剔除)。
    ⭐ 減資類公告(現金減資 / 減資彌補虧損)剛好就是會出現斷崖的那種 —— 不擋會量到假的大漲 / 大跌。"""
    pre = K.get('_cl')
    if pre is None:
        pre = K['_cl'] = LL.cliff_prefix(K['c'], K['o'])
    return LL.cliff_in(pre, i, i + h)


def mean(a):
    return sum(a) / len(a) if a else float('nan')


def tstat(a):
    n = len(a)
    if n < 3:
        return float('nan')
    m = mean(a)
    v = sum((x - m) ** 2 for x in a) / (n - 1)
    return m / math.sqrt(v / n) if v > 0 else float('nan')


def p_two(t):
    return math.erfc(abs(t) / math.sqrt(2)) if t == t else 1.0


def bh(ps):
    n = len(ps)
    order = sorted(range(n), key=lambda i: ps[i])
    q = [0.0] * n
    prev = 1.0
    for rank in range(n, 0, -1):
        i = order[rank - 1]
        prev = min(prev, ps[i] * n / rank)
        q[i] = prev
    return q


def study(events, K, strict=False):
    """events = [(代號, 日期, 時間, 類別)];K = {代號: K 線}。回 {類別: 結果}。"""
    # 同一天、同樣進場方式的全部股票平均(對照組)—— 每個「進場索引日」算一次
    base = {}
    allsyms = list(K)

    def base_ret(day, h):
        key = (day, h)
        if key in base:
            return base[key]
        acc = []
        for s in allsyms:
            Ks = K[s]
            import bisect
            i = bisect.bisect_left(Ks['d'], day)
            if i < len(Ks['d']) and Ks['d'][i] == day and i + h < len(Ks['d']) and not locked(Ks, i) and not cliff(Ks, i, h):
                acc.append((Ks['c'][i + h] / Ks['o'][i] - 1) * 100)
        base[key] = mean(acc) if len(acc) >= 30 else float('nan')
        return base[key]

    last = {}
    rows = {}
    for sym, d, t, cat in sorted(events, key=lambda e: (e[1], e[2])):
        Ks = K.get(sym)
        if not Ks:
            continue
        i = tradable_day(Ks['d'], d, t, strict)
        if i is None or locked(Ks, i):
            continue
        k = (sym, cat)
        if k in last and i - last[k] < DEDUP:
            continue
        last[k] = i
        day = Ks['d'][i]
        rec = {'d': day}
        for h in HS:
            if i + h < len(Ks['d']) and not cliff(Ks, i, h):
                b = base_ret(day, h)
                if b == b:
                    rec[h] = (Ks['c'][i + h] / Ks['o'][i] - 1) * 100 - b
        if 10 in rec:
            rows.setdefault(cat, []).append(rec)
    out = {}
    for cat, rs in rows.items():
        byday = {}
        for r in rs:
            byday.setdefault(r['d'], []).append(r[10])
        dm = [mean(v) for _, v in sorted(byday.items())]       # ⛔ 同一天多檔不當獨立樣本
        t = tstat(dm)
        v10 = [r[10] for r in rs]
        m = mean(v10)
        ds = sorted(byday)
        mid = ds[len(ds) // 2] if ds else ''
        h1 = mean([r[10] for r in rs if r['d'] < mid])
        h2 = mean([r[10] for r in rs if r['d'] >= mid])
        yrs = {}
        for r in rs:
            yrs.setdefault(r['d'][:4], []).append(r[10])
        ym = {y: mean(v) for y, v in yrs.items() if len(v) >= YR_MIN_N}
        sg = 1 if m >= 0 else -1
        same = sum(1 for v in ym.values() if v * sg > 0)
        med = sorted(v10)[len(v10) // 2] if v10 else float('nan')
        out[cat] = {'n': len(rs), 'days': len(dm), 'm5': mean([r[5] for r in rs if 5 in r]), 'm10': m,
                    'm20': mean([r[20] for r in rs if 20 in r]), 'med10': med, 't': t, 'p': p_two(t),
                    'h1': h1, 'h2': h2, 'years': {y: round(v, 2) for y, v in sorted(ym.items())}, 'yr_same': [same, len(ym)]}
    cats = [c for c in out if out[c]['days'] >= 30]
    qs = bh([out[c]['p'] for c in cats]) if cats else []
    for c, q in zip(cats, qs):
        r = out[c]
        sg = 1 if r['m10'] >= 0 else -1
        r['q'] = q
        r['pass'] = bool(q <= 0.05 and r['h1'] * sg > 0 and r['h2'] * sg > 0 and r['yr_same'][1] >= 5
                         and r['yr_same'][0] >= 0.7 * r['yr_same'][1] and (abs(r['m10']) - COST) > 0)
    return out


def load_mops(d):
    ev, n = [], 0
    for f in sorted(glob.glob(os.path.join(d, '*.json.gz'))):
        doc = json.loads(gzip.decompress(Path(f).read_bytes()).decode('utf-8'))
        for r in doc.get('rows') or []:
            if len(r) >= 5 and re.match(r'^\d{4}$', str(r[0])):
                ev.append((r[0], r[2], r[3], classify(r[4])))
                n += 1
    return ev


def main():
    if '--selftest' in sys.argv:
        return selftest()
    md, dd = os.environ.get('MOPS_DIR') or 'mops_deep', os.environ.get('DATA_DIR') or 'data'
    strict = '--strict' in sys.argv
    ev = load_mops(md)
    if len(ev) < 1000:
        print(f'❌ 重大訊息只有 {len(ev)} 則(< 1,000)→ ⛔ 不判(空過守門)')
        return 1
    syms = sorted({e[0] for e in ev})
    K = {}
    for f in glob.glob(os.path.join(dd, '*.json')):
        s = Path(f).stem
        if re.match(r'^\d{4}$', s):
            k = load_k(f)
            if k:
                K[s] = k
    print(f'📰 重大訊息 {len(ev):,} 則 ・{len(syms)} 檔 ・日 K {len(K)} 檔 ・{"一律隔天開盤" if strict else "08:30 前公告當天開盤、其他隔天開盤"}')
    res = study(ev, K, strict)
    lab = {c[0]: c[1] for c in CATS}
    lab['other'] = '其他'
    print(f'{"類別":<26}{"次數":>7}{"10天超額":>9}{"中位":>7}{"t":>6}{"q":>7}{"前/後半":>14}{"逐年":>7}  過')
    for c, r in sorted(res.items(), key=lambda kv: -abs(kv[1]['t']) if kv[1]['t'] == kv[1]['t'] else 0):
        print(f'{lab.get(c, c):<24}{r["n"]:>7}{r["m10"]:>+9.2f}{r["med10"]:>+7.2f}{r["t"]:>6.1f}{r.get("q", 1):>7.3f}'
              f'{r["h1"]:>+7.2f}/{r["h2"]:>+6.2f}{r["yr_same"][0]:>4}/{r["yr_same"][1]:<2}  {"✅" if r.get("pass") else ""}')
    outp = next((a for a in sys.argv[1:] if not a.startswith('--')), None)
    if outp:
        Path(outp).write_text(json.dumps({'strict': strict, 'n_events': len(ev), 'res': res}, ensure_ascii=False), encoding='utf-8')
        print(f'💾 {outp}')
    return 0


def selftest():
    import random
    bad = []

    def ok(n, c, e=''):
        print(f"  {'✅' if c else '❌'} {n}{'' if c else '  ' + str(e)[:200]}")
        if not c:
            bad.append(n)
    ok('① 分類:先中先得', classify('董事會決議買回本公司股份') == 'buyback' and classify('買回本公司股份執行完畢') == 'buyback_end'
       and classify('澄清媒體報導有關訂單') == 'clarify' and classify('公告本公司代子公司取得固定收益證券') == 'sub'
       and classify('公告本公司取得固定收益證券') == 'asset'
       and classify('本公司董事長異動') == 'boss' and classify('其他事項') == 'other')
    # ①b 2026-10-20 第一段真資料裡的**真實主旨**(一字不改)→ 該進哪一類(⛔ 改分類表一定要跑過這組)
    REAL = [
        ('公告本公司董事會通過115年第二季合併財務報告', 'finrep'),
        ('公告本公司115年度第二季合併財務報告董事會召開日期', 'finrep'),
        ('本公司代子公司新光銀行公告與台新銀行合併基準日', 'sub'),
        ('公告本公司115年8月份自結合併營收', 'selfprofit'),
        ('公告本公司115年9月合併營收', 'other'),
        ('公告本公司取得濾能股份有限公司私募普通股 (更正誤植事實發生日)', 'asset'),
        ('公告本公司董事會決議現金增資子公司Concord Industries Limited', 'other'),
        ('本公司115年現金增資發行普通股催繳公告', 'cash_inc'),
        ('公告本公司董事會決議辦理限制員工權利新股收回註銷減資事宜', 'other'),
        ('代重要子公司Quanta Storage (BVI) Ltd.公告 董事會決議辦理現金減資案', 'sub'),
        ('(補充公告)本公司與聯貸銀行團簽訂聯合授信合約', 'other'),
        ('公告本公司簽訂高雄市三民區大港段住宅大樓 新建工程承攬契約追加協議書', 'order'),
        ('公告本公司董事會通過捐助「財團法人國際合作發展基金會 國際重大災害勸募專戶」援助「日本熊本縣大地震」乙案', 'other'),
        ('公告本公司火災事件說明', 'disaster'),
        ('公告本公司買回庫藏股期間屆滿執行情形', 'buyback_end'),
        ('公告辦理註銷庫藏股減資變更登記完成', 'buyback_end'),
        ('公告本公司董事會決議買回本公司股份', 'buyback'),
        ('公告本公司股票面額由「新台幣10元」變更為「新台幣2.5元」', 'par'),
        ('係因本公司有價證券近期多次達公布注意交易資訊標準，故公布相關財務業務等重大訊息', 'attn'),
        ('公告本公司之關係人退票事宜', 'distress'),
        ('公告本公司財務主管異動', 'cfo'),
        ('公告本公司總經理異動', 'boss'),
        ('澄清115年9月22日工商時報B4版新聞內容', 'clarify'),
        ('公告本公司董事會決議與甲公司合併', 'ma'),
        ('公告本公司受邀參加115年9月16日元大證券舉辦之線上法人說明會(電話會議)', 'confcall'),
    ]
    wrong = [(t, classify(t), want) for t, want in REAL if classify(t) != want]
    ok(f'①b 真實主旨 {len(REAL)} 則分類正確', not wrong, wrong)
    # ①c 決定性對照:把「合併財報 / 營收」那道 strip 拿掉 → 月營收公告就會被當成併購(證明 strip 真的在作用)
    _ma = next(c for c in _CRE if c[0] == 'ma')
    ok('①c 決定性對照:沒有 strip 時「合併營收」會被誤判成併購', bool(_ma[2].search('公告本公司115年9月合併營收')) and classify('公告本公司115年9月合併營收') != 'ma')
    ds = ['2024-03-04', '2024-03-05', '2024-03-06']
    ok('② 08:30 前公告 → 當天開盤', tradable_day(ds, '2024-03-05', '07:00:04') == 1)
    ok('② 盤中 / 盤後公告 → 下一個交易日(⛔ 偷看當天)', tradable_day(ds, '2024-03-05', '10:00:00') == 2 and tradable_day(ds, '2024-03-05', '17:30:00') == 2)
    ok('② 週末公告 → 下一個交易日開盤', tradable_day(ds, '2024-03-03', '07:00:00') == 0)
    ok('② STRICT:一律下一個交易日', tradable_day(ds, '2024-03-05', '07:00:04', strict=True) == 2)
    ok('② 最後一天之後 → 沒有', tradable_day(ds, '2024-03-06', '15:00:00') is None)
    # ③ 合成:60 檔 × 1,600 天(約 6 年,逐年那關要 ≥5 年),buyback 公告當天 +2%、之後 10 天每天 +0.1%,clarify 沒效果
    #    ⚠️ 對照組是「同一天全部股票」,裡面也有別檔在漲 → 量到的會比 +3% 小一點
    random.seed(5)
    days = []
    from datetime import date, timedelta
    d0 = date(2015, 1, 5)
    while len(days) < 1600:
        if d0.weekday() < 5:
            days.append(d0.isoformat())
        d0 += timedelta(days=1)
    K, ev = {}, []
    for s in range(60):
        sym = f'{1100 + s}'
        c, o = [], []
        px = 50.0
        bump = {}
        for i, d in enumerate(days):
            if i % 37 == s % 37 and 100 < i < 1550:
                if s % 2 == 0:
                    ev.append((sym, d, '07:00:00', 'buyback'))
                    bump[i] = 0.02                      # 公告當天開盤 → 收盤的反應(盤後公告的人吃不到)
                    for k in range(1, 11):
                        bump[i + k] = 0.001
                else:
                    ev.append((sym, d, '07:00:00', 'clarify'))
            r = random.gauss(0, 0.015) + bump.get(i, 0)
            o.append(px)
            px = px * (1 + r)
            c.append(px)
        K[sym] = {'d': days, 'o': o, 'c': c, 'h': [max(a, b) * 1.01 for a, b in zip(o, c)], 'l': [min(a, b) * 0.99 for a, b in zip(o, c)]}
    res = study(ev, K)
    rb, rc = res.get('buyback', {}), res.get('clarify', {})
    ok('③ 合成:有效的那類抓得到(+2~4%、過關)', rb.get('pass') and 1.8 < rb.get('m10', 0) < 4, {k: rb.get(k) for k in ('m10', 'q', 'yr_same', 'h1', 'h2', 'pass')})
    ok('③ 沒效果的那類抓不到', not rc.get('pass'), rc)
    # ④ 決定性對照:把 buyback 的時間改成盤後 → 進場晚一天,前一天的漲幅不算(效果變小但還在)
    ev2 = [(a, b, '15:00:00', c) for a, b, _t, c in ev]
    r2 = study(ev2, K).get('buyback', {})
    ok('④ 決定性對照:同一批改成盤後公告 → 隔天開盤才進場,吃不到公告當天那 +2%(少 ≥1pp)', r2.get('m10', 9) < rb.get('m10', 0) - 1, (r2.get('m10'), rb.get('m10')))
    # ⑤ 🧱 V79.4.6 斷崖守門:減資公告之後第 3 天價格 ×2(減資沒還原)→ 那個窗口要剔除(⛔ 量到假的 +100%)
    global cliff
    K5 = {s_: {kk: (vv[:] if isinstance(vv, list) else vv) for kk, vv in K[s_].items() if not kk.startswith('_')} for s_ in K}
    ev5 = []
    for s in range(0, 60, 3):
        sym = f'{1100 + s}'
        Kx = K5[sym]
        for i0 in range(200, 1500, 97):
            ev5.append((sym, Kx['d'][i0], '07:00:00', 'cap_red_loss'))
            for j in range(i0 + 3, len(Kx['d'])):                          # 第 3 天起整段 ×2(像減資彌補虧損恢復交易)
                for kk in ('o', 'c', 'h', 'l'):
                    Kx[kk][j] *= 2
    r5 = study(ev5, K5).get('cap_red_loss', {})
    _cliff = cliff
    cliff = lambda K_, i, h: False                                           # 決定性對照:拿掉守門
    r5x = study(ev5, {s_: {kk: vv for kk, vv in K5[s_].items() if not kk.startswith('_')} for s_ in K5}).get('cap_red_loss', {})
    cliff = _cliff
    ok('⑤ 斷崖守門:減資沒還原的那段窗口剔除(⛔ 量到假的 +100%)', not r5 or abs(r5.get('m10', 0)) < 20, r5.get('m10'))
    ok('⑤ 決定性對照:拿掉守門 → 量到 >+50% 的假大漲', r5x.get('m10', 0) > 50, r5x.get('m10'))
    print(f"\n{'✅ selftest 全過' if not bad else '❌ 失敗:' + ', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())
