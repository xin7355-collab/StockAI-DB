#!/usr/bin/env python3
"""📞 V79.6.7 法說會 3.0 第二步(雛形):從簡報全文抽「公司講到之後」的句子 → 指標 + 方向 + 時間 + 跟誰比。

為什麼要有這支:研究「公司講的話做到了沒」要先知道它講了什麼可以對答案的話。
   舊的抽句規則只認「展望 / 預期 / 預計」,實測南亞 8 份簡報只有 2 份抽到 1 句,
   漏掉「第四季合併營收將持續攀升,整體績效將優於第三季」這種寫法(10/23 那份第 12 頁,外部 AI 讀到、本站沒抓到)。

⚠️ 雛形:規則先寫成「測得動」的樣子,⛔ 憑感覺定案 —— 下一步在雲端拿真的全文量「抽到幾句、錯幾句」
   (`--measure`),人工看過才接進研究與畫面。
⛔ 這支不判對錯、不碰股價(那是下一步);⛔ 不叫 AI;⛔ 改 confcall_deck 讀簡報的流程。

每一句回傳:
  p   頁碼            t  原文(一字不改)
  m   指標 rev 營收 / gm 毛利率 / op 獲利 / util 稼動率 / cap 產能 / capex 資本支出 / price 價格 / demand 需求 / None
  dir up / down / flat / mixed / None
  h   時間 '2026Q4' / '2026H2' / '2026' / None(沒講時間)
  cmp 跟誰比 'QoQ' 上一季 / 'YoY' 去年同期 / None
  ok  可以對答案(有指標 + 方向 + 時間,而且指標是本站量得到的:營收 / 毛利率 / 獲利)

用法:
  python3 confcall_guidance.py --selftest
  python3 confcall_guidance.py --measure <cc_deep 目錄> [抽幾份,預設 40]   # 印抽到的句子給人看 + 總數
"""
import json
import os
import random
import re
import sys
from datetime import date

import confcall_deck as CD

FWD_RE = re.compile(r'將|可望|預期|預估|預計|展望|看好|有望|目標|規劃|計畫|計劃|預料|估計|應可|仍可|可期|蓄勢|持續|'
                    r'期待|樂觀|保守看待|審慎|謹慎看待|\bexpect|\bwill\b|outlook|guidance|forecast|anticipate', re.I)
# 排除:免責聲明 / 註腳(confcall_deck 同一份)、ESG 目標、會計名詞(「預期信用減損」不是展望)
ESG_RE = re.compile(r'淨零|碳中和|減碳|碳排|溫室氣體|再生能源|綠電|ESG|永續|SBTi|RE100|用水|廢棄物|節能|碳足跡|net[- ]zero|carbon', re.I)
ACCT_RE = re.compile(r'預期信用|預計負債|預付|預收|預計發放|股利|除息|股東會|董事會|庫藏股|增資|私募')
# 指標(順序 = 優先序:一句同時講營收和毛利率 → 記營收;毛利率另外一句通常會再講)
METRICS = [
    ('gm', re.compile(r'毛利率|gross margin', re.I)),
    ('rev', re.compile(r'營收|營業收入|合併營收|業績|銷售額|revenue|sales', re.I)),
    ('op', re.compile(r'營業利益|營益率|本業獲利|獲利|淨利|EPS|每股盈餘|operating (income|margin)|net income|profit', re.I)),
    ('util', re.compile(r'稼動率|產能利用率|滿載|utili[sz]ation', re.I)),
    ('capex', re.compile(r'資本支出|capex', re.I)),
    ('cap', re.compile(r'產能|擴產|新廠|產線|capacity', re.I)),
    ('price', re.compile(r'價格|售價|報價|單價|ASP|漲價|price', re.I)),
    ('demand', re.compile(r'需求|拉貨|訂單|出貨|銷量|demand|shipment|order', re.I)),
]
GRADABLE = {'rev', 'gm', 'op'}     # 本站有資料可以對答案的(月營收 / 季報)
UP_RE = re.compile(r'成長|增加|攀升|提升|上揚|優於|高於|回升|增溫|擴大|走高|回溫|好轉|轉佳|增長|上升|倍增|翻倍|加速|強勁|暢旺|'
                   r'亮麗|放大|新高|旺季|\bgrow|increase|higher|improv|rise|\bup\b|strong|better', re.I)
DOWN_RE = re.compile(r'下滑|減少|衰退|下降|低於|趨緩|疲弱|走低|縮減|減緩|放緩|承壓|下修|探底|偏弱|不佳|淡季|'
                     r'declin|decrease|lower|soft|weak|\bdown\b|worse', re.I)
FLAT_RE = re.compile(r'持平|相當|維持|穩定|平穩|相近|flat|stable', re.I)
QOQ_RE = re.compile(r'季增|季減|較上季|較前一季|上一季|前一季|優於第[一二三四1-4]季|高於第[一二三四1-4]季|低於第[一二三四1-4]季|QoQ|sequential', re.I)
YOY_RE = re.compile(r'年增|年減|較去年|去年同期|年成長|YoY|year[- ]over[- ]year', re.I)
CN_NUM = {'一': 1, '二': 2, '三': 3, '四': 4, '1': 1, '2': 2, '3': 3, '4': 4}


def _quarter(d):
    return (d.month - 1) // 3 + 1


def horizon(t, d):
    """這句講的是哪一段時間;講的是已經過去的那一段 → 'past'(⛔ 是報結果不是展望);沒講時間 → None。d = 簡報的場次日期。"""
    y0, cq = d.year, _quarter(d)
    m = re.search(r'(20[2-3]\d)\s*年', t)
    yr = int(m.group(1)) if m else None
    if '明年' in t or re.search(r'next year', t, re.I):
        yr = y0 + 1
    if '後年' in t:
        yr = y0 + 2
    q = None
    mq = re.search(r'第\s*([一二三四1-4])\s*季', t) or re.search(r'\b([1-4])\s*Q\b', t) or re.search(r'\bQ\s*([1-4])\b', t)
    if mq:
        q = CN_NUM.get(mq.group(1))
    if re.search(r'下一季|下季|next quarter', t, re.I) and q is None:
        q = cq                    # 法說會多半在季底後一兩個月開:「下一季」= 開會時正在跑的那一季
    if q:
        y = yr or y0
        if y < y0 or (y == y0 and q < cq):
            return 'past'         # 講的是已經過去的那一季(報結果,⛔ 不是展望)
        return f'{y}Q{q}'
    if '下半年' in t or re.search(r'second half|2H|H2', t):
        y = yr or y0
        return 'past' if y < y0 else f'{y}H2'          # 10~12 月講的「下半年」還沒結束 → 照樣是展望
    if '上半年' in t or re.search(r'first half|1H|H1', t):
        y = yr or y0              # 下半年講「上半年」沒寫明年 = 報上半年的結果(明年上半年會寫「明年」)
        return 'past' if (y < y0 or (y == y0 and d.month > 6)) else f'{y}H1'
    if yr and yr >= y0:
        return str(yr)
    if re.search(r'今年|全年|this year|full[- ]year', t, re.I):
        return str(y0)
    return None


def direction(t):
    up, dn, fl = bool(UP_RE.search(t)), bool(DOWN_RE.search(t)), bool(FLAT_RE.search(t))
    if up and dn:
        return 'mixed'
    if up:
        return 'up'
    if dn:
        return 'down'
    if fl:
        return 'flat'
    return None


def metric(t):
    for k, rx in METRICS:
        if rx.search(t):
            return k
    return None


def guidance_of(pages, d):
    """pages = 每頁的字(confcall_deck 存的全文 'p');d = 場次日期(date 或 'YYYY-MM-DD')。"""
    if isinstance(d, str):
        d = date.fromisoformat(d[:10])
    out, seen = [], set()
    for p, t in CD.page_lines(pages):
        s = t.strip()
        if len(s) < 8 or s in seen:
            continue
        if CD.DISCLAIM_RE.search(s) or CD.NOTE_RE.search(s) or ESG_RE.search(s) or ACCT_RE.search(s):
            continue
        if not FWD_RE.search(s):
            continue
        h = horizon(s, d)
        if h == 'past':
            continue              # 講的是已經過去的那一段 = 報結果(就算有「持續」)
        m, dr = metric(s), direction(s)
        if h is None and not (m and dr):
            continue              # 沒講時間、也沒講指標 + 方向 → 太空泛(「持續深耕客戶」)
        cmp_ = 'QoQ' if QOQ_RE.search(s) else ('YoY' if YOY_RE.search(s) else None)
        seen.add(s)
        out.append({'p': p, 't': s, 'm': m, 'dir': dr, 'h': h, 'cmp': cmp_,
                    'ok': bool(m in GRADABLE and dr in ('up', 'down', 'flat') and h)})
    return out


# ───────────────────────── 量測(雲端拿真的全文跑,人工看) ─────────────────────────
def measure(cc_dir, n=40, seed=7):
    CD.CC = __import__('pathlib').Path(cc_dir)
    idx = CD.load_index().get('files', {})
    have = [(f, st) for f, st in idx.items() if st.get('tx') and st.get('tx') != '-']
    print(f'有全文的簡報 {len(have)} 份(索引共 {len(idx)} 份)')
    random.Random(seed).shuffle(have)
    tot = gr = decks_with = 0
    for f, st in have[:n]:
        rec = CD.load_text(f, idx)
        if not rec:
            continue
        g = guidance_of(rec['p'], st.get('d') or '2026-01-01')
        tot += len(g)
        gr += sum(1 for x in g if x['ok'])
        decks_with += 1 if g else 0
        print(f'\n== {st.get("s")} {st.get("d")} {f}:{len(g)} 句(可以對答案 {sum(1 for x in g if x["ok"])})')
        for x in g[:8]:
            print(f'   p{x["p"]:<2} {x["m"] or "-":<6} {x["dir"] or "-":<5} {x["h"] or "-":<7} {x["cmp"] or "-":<4} {"✅" if x["ok"] else "  "} {x["t"][:90]}')
    k = min(n, len(have))
    print(f'\n抽 {k} 份:有抽到的 {decks_with} 份 ・共 {tot} 句 ・可以對答案 {gr} 句(平均每份 {tot / max(1, k):.1f} / {gr / max(1, k):.1f})')
    return 0


# ───────────────────────── selftest ─────────────────────────
def selftest():
    fails = []

    def ok(name, cond, extra=''):
        print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {extra}'))
        if not cond:
            fails.append(name)

    D = date(2026, 10, 23)
    # ① 南亞 10/23 第 12 頁(外部 AI 讀到、舊規則漏掉的那一句)
    g = guidance_of(['', '第四季合併營收將持續攀升,整體績效將優於第三季。'], D)
    ok('① 南亞那句:營收・往上・2026 第四季・跟上一季比・可以對答案',
       len(g) == 1 and g[0]['m'] == 'rev' and g[0]['dir'] == 'up' and g[0]['h'] == '2026Q4' and g[0]['cmp'] == 'QoQ' and g[0]['ok'] and g[0]['p'] == 2, g)
    ok('①b ⭐ 決定性對照:舊規則(confcall_deck.outlook_of)抽不到同一句', not CD.outlook_of(CD.page_lines(['', '第四季合併營收將持續攀升,整體績效將優於第三季。'])))
    # ② 報結果的(沒有「之後」)⛔ 收
    ok('② 「第三季營收較上季成長 12.5%」(報結果)⛔ 收', guidance_of(['2026年第三季營收較上季成長12.5%'], D) == [])
    ok('②b 10 月那份講「第三季」→ 已經過去 ⛔ 當展望(就算有「持續」)', guidance_of(['第三季營收持續成長,創單季新高'], D) == [])
    # ③ 排除:免責聲明 / ESG / 會計名詞 / 股利
    ok('③ 免責聲明 ⛔ 收', guidance_of(['本簡報包含前瞻性陳述,實際結果可能與預期不同'], D) == [])
    ok('③b ESG 目標 ⛔ 收', guidance_of(['預計2030年達成碳排放減量30%'], D) == [])
    ok('③c 「預期信用減損」⛔ 收', guidance_of(['明年預期信用減損損失將增加'], D) == [])
    ok('③d 股利 ⛔ 收', guidance_of(['預計發放現金股利每股 2 元'], D) == [])
    # ④ 時間
    g4 = guidance_of(['第一季為傳統淡季,營收將較上季下滑'], date(2026, 2, 20))
    ok('④ 2 月那份「第一季營收將較上季下滑」→ 2026Q1・往下・QoQ', g4 and g4[0]['h'] == '2026Q1' and g4[0]['dir'] == 'down' and g4[0]['cmp'] == 'QoQ' and g4[0]['ok'], g4)
    g5 = guidance_of(['下半年需求可望回溫'], date(2026, 5, 26))
    ok('④b 5 月那份「下半年需求可望回溫」→ 2026H2・需求・往上(⛔ 算可以對答案:需求本站量不到)',
       g5 and g5[0]['h'] == '2026H2' and g5[0]['m'] == 'demand' and g5[0]['dir'] == 'up' and not g5[0]['ok'], g5)
    g6 = guidance_of(['明年資本支出預計約新台幣500億元'], D)
    ok('④c 「明年資本支出預計 500 億」→ 2027・資本支出(先收著,⛔ 算可以對答案)', g6 and g6[0]['h'] == '2027' and g6[0]['m'] == 'capex' and not g6[0]['ok'], g6)
    g7 = guidance_of(['We expect Q4 revenue to grow mid-single digits sequentially'], D)
    ok('④d 英文:expect Q4 revenue grow sequentially → 2026Q4・營收・往上・QoQ', g7 and g7[0]['h'] == '2026Q4' and g7[0]['m'] == 'rev' and g7[0]['dir'] == 'up' and g7[0]['cmp'] == 'QoQ', g7)
    g8 = guidance_of(['年初預期,今年會是亮麗的一年。'], D)
    ok('④e 「今年會是亮麗的一年」→ 2026・往上・沒有指標(⛔ 算可以對答案)', g8 and g8[0]['h'] == '2026' and g8[0]['dir'] == 'up' and g8[0]['m'] is None and not g8[0]['ok'], g8)
    # ⑤ 太空泛 ⛔ 收
    ok('⑤ 「持續深耕客戶關係」⛔ 收(沒時間、沒指標)', guidance_of(['持續深耕客戶關係'], D) == [])
    g10 = guidance_of(['下半年營收可望優於上半年'], D)
    ok('⑤b 10 月講「下半年」(還沒結束)→ 2026H2 照收', g10 and g10[0]['h'] == '2026H2' and g10[0]['m'] == 'rev', g10)
    ok('⑤c 10 月講「上半年營收成長」(已經結束)⛔ 收', guidance_of(['上半年營收持續成長'], D) == [])
    # ⑥ 同一句只收一次、頁碼對
    g9 = guidance_of(['毛利率預期第四季將持平', '其他', '毛利率預期第四季將持平'], D)
    ok('⑥ 同一句兩頁都出現 → 只收一次、記第一次出現的頁碼', len(g9) == 1 and g9[0]['p'] == 1 and g9[0]['m'] == 'gm' and g9[0]['dir'] == 'flat', g9)
    print('\n' + ('❌ confcall_guidance selftest 失敗 %d 條' % len(fails) if fails else '✅ confcall_guidance selftest 全過'))
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    if '--measure' in sys.argv:
        i = sys.argv.index('--measure')
        cc = sys.argv[i + 1] if len(sys.argv) > i + 1 else os.getenv('CC_DIR', 'cc_deep')
        n = int(sys.argv[i + 2]) if len(sys.argv) > i + 2 else 40
        sys.exit(measure(cc, n))
    print(__doc__)
