#!/usr/bin/env python3
"""📞 V79.6.7 法說會 3.0 第二步(雛形):從簡報全文抽「公司講到之後」的句子 → 指標 + 方向 + 時間 + 跟誰比。

為什麼要有這支:研究「公司講的話做到了沒」要先知道它講了什麼可以對答案的話。
   舊的抽句規則只認「展望 / 預期 / 預計」,實測南亞 8 份簡報只有 2 份抽到 1 句,
   漏掉「第四季合併營收將持續攀升,整體績效將優於第三季」這種寫法(10/23 那份第 12 頁,外部 AI 讀到、本站沒抓到)。

⚠️ 雛形:規則一律「先量再改」(`--measure`),人工看過才接進研究與畫面。
   📏 2026-10-24 拿 150 份真的全文量了 5 輪(cc_deep 05:43 那份):有抽到展望的 51 份 ・共 143 個展望 ・
      可以拿季報對答案的 19 個(10 家)→ 人工逐句看:17 個確定對、1 個其實只講一個產品線(TVS)、1 個不確定;
      另外 28 個是「只講一個產品線 / 事業」(seg,先收著、⛔ 拿全公司的季報對答案)。
      ⭐ 19 個裡 18 個是講好的(往上 / 持平)—— 簡報很少講壞消息 → 能研究的是「講好話的時候準不準」。
   🚫 量出來改掉的:研究機構 / 市場規模預測(Yole、「台灣科技業獲利」)、「上半年成長」被當成跟去年比、
      「約持平(+3~5%)」被前一段的「產能成長」判成往上、「獲利」拿營業利益對答案、
      confcall_deck.MACRO_RE 的「利率」吃到「毛利率」(講毛利率的那句被當成總經)。
⛔ 這支不碰股價(那是下一步);⛔ 不叫 AI;⛔ 改 confcall_deck 讀簡報的流程。

每一句回傳:
  p   頁碼            t  原文(一字不改)
  m   指標 rev 營收 / gm 毛利率 / om 營益率 / nm 淨利率 / opi 營業利益 / ni 稅後淨利(獲利 / EPS)/
      util 稼動率 / cap 產能 / capex 資本支出 / price 價格 / demand 需求 / None
  dir up / down / flat / mixed / None
  h   時間 '2026Q4' / '2026H2' / '2026' / None(沒講時間)
  cmp 跟誰比 'QoQ' 上一季 / 'YoY' 去年同期 / None
  ok  可以對答案(有指標 + 方向 + 時間,而且指標是本站量得到的:營收 / 利潤率 / 營業利益 / 稅後淨利;
      ⛔ 只講一個產品線(seg)、⛔ 多年區間('2026-2028')、⛔ 營收占比(mix))
  seg 1 = 只講一個產品線 / 事業 ・ pos 1 =「轉虧為盈」(那段時間要 > 0 才算做到)

用法:
  python3 confcall_guidance.py --selftest
  python3 confcall_guidance.py --measure <cc_deep 目錄> [抽幾份,預設 40]   # 印抽到的句子給人看 + 總數
  FIN=origin/gh-pages TODAY=2026-10-24 OUT=x.json python3 confcall_guidance.py --grade <cc_deep 目錄>   # 說到做到 + 兩個對照
"""
import json
import os
import random
import re
import sys
from datetime import date

import confcall_deck as CD

# ⚠️ 10/24 第一次量 150 份真的全文:「持續」單獨出現多半是報結果(「規模持續擴大,稅後淨利再創新高」)→ ⛔ 當展望字眼
FWD_RE = re.compile(r'將|可望|預期|預估|預計|展望|看好|有望|目標|規劃|計畫|計劃|預料|估計|應可|仍可|可期|蓄勢|'
                    r'期待|樂觀看待|保守看待|審慎看待|謹慎看待|拚|\bexpect|\bwill\b|outlook|guidance|forecast|anticipate', re.I)
# 排除:免責聲明 / 註腳(confcall_deck 同一份)、ESG 目標、會計名詞(「預期信用減損」不是展望)
ESG_RE = re.compile(r'淨零|碳中和|減碳|碳排|溫室氣體|再生能源|綠電|ESG|永續|SBTi|RE100|用水|廢棄物|節能|碳足跡|net[- ]zero|carbon', re.I)
ACCT_RE = re.compile(r'預期信用|預計負債|預付|預收|預計發放|股利|除息|股東會|董事會|庫藏股|增資|私募')
# 不是公司自己的展望:總經 / 研究機構 / 市場規模預測、投資人問卷(「貴公司…」)、工程進度(完工 / 動土)
# ⚠️ 10/24 第二次量:「Yole 預估先進封裝市場總營收 2031 年倍增」「2027 年台灣科技業獲利預估年增 38.5%」被當成公司的話
OTHER_RE = re.compile(r'根據|研究機構|調研|預測顯示|市場規模|CAGR|複合年|經濟成長率|GDP|通膨|央行|聯準會|'
                      r'貴公司|請問|完工|動土|上樑|取得使用執照|'
                      r'台股(大盤|指數|報酬|本益比)|大盤|加權指數|本益比|(科技業|產業|台灣|全球).{0,4}(獲利|產值|規模)|'
                      r'市場.{0,6}(營收|規模|產值|銷售額)|全球.{0,12}市場|'
                      r'Yole|IDC|Gartner|TrendForce|集邦|DIGITIMES|拓墣|Counterpoint|Omdia|WSTS|IEA\b|BNEF', re.I)
# 指標(順序 = 優先序:一小段同時講兩個 → 記前面那個)
# ⚠️ 10/24 實跑:「今年獲利可望挑戰新高(加上業外資產處分挹注)」講的是稅後淨利,⛔ 拿營業利益對答案
#    → 利潤率(毛利率 / 營益率 / 淨利率)排在金額前面(「營業利益率」裡有「營業利益」、「淨利率」裡有「淨利」)
METRICS = [
    ('gm', re.compile(r'毛利率|gross margin', re.I)),
    ('om', re.compile(r'營益率|營業利益率|營業淨利率|operating margin', re.I)),
    ('nm', re.compile(r'淨利率|純益率|net margin', re.I)),
    ('mix', re.compile(r'占比|佔比|比重|營收比例|營收比|mix', re.I)),      # 「海外營收占比 > 50%」是結構,⛔ 是營收本身
    ('rev', re.compile(r'營收|營業收入|合併營收|業績|銷售額|revenue|sales', re.I)),
    ('opi', re.compile(r'營業利益|營業淨利|本業獲利|operating (income|profit)', re.I)),
    ('ni', re.compile(r'獲利|淨利|稅後|EPS|每股盈餘|盈餘|虧損|轉虧|轉盈|net income|net profit|profit|earnings', re.I)),
    ('util', re.compile(r'稼動率|產能利用率|滿載|utili[sz]ation', re.I)),
    ('capex', re.compile(r'資本支出|capex', re.I)),
    ('cap', re.compile(r'產能|擴產|新廠|產線|capacity', re.I)),
    ('price', re.compile(r'價格|售價|報價|單價|ASP|漲價|price', re.I)),
    ('demand', re.compile(r'需求|拉貨|訂單|出貨|銷量|demand|shipment|order', re.I)),
]
GRADABLE = {'rev', 'gm', 'om', 'nm', 'opi', 'ni'}     # 本站有資料可以對答案的(data/fin 季報)
MARGIN = {'gm', 'om', 'nm'}      # 利潤率:比「差幾個百分點」;其他比「變動 %」
UP_RE = re.compile(r'成長|增加|攀升|提升|上揚|優於|高於|回升|增溫|擴大|走高|回溫|好轉|轉佳|增長|上升|倍增|翻倍|加速|強勁|暢旺|'
                   r'亮麗|放大|新高|旺季|挹注|帶動|樂觀|轉虧為盈|轉盈|轉正|減虧|虧損收斂|\bgrow|increase|higher|improv|rise|\bup\b|strong|better', re.I)
DOWN_RE = re.compile(r'下滑|減少|衰退|下降|低於|趨緩|疲弱|走低|縮減|減緩|放緩|承壓|下修|探底|偏弱|不佳|淡季|轉虧(?!為盈)|'
                     r'declin|decrease|lower|soft|weak|\bdown\b|worse', re.I)
# 「轉虧為盈」「應可維持獲利局面」= 那段時間要賺錢(> 0)才算做到 —— ⛔ 拿變動 % 判(1455「維持獲利」被當成持平、−10,090%)
POS_RE = re.compile(r'轉虧為盈|轉盈|轉正|維持獲利|持續獲利|保持獲利|獲利局面|穩定獲利')
FLAT_RE = re.compile(r'持平|相當|維持|穩定|平穩|相近|flat|stable', re.I)
QOQ_RE = re.compile(r'季增|季減|較上季|較前一季|上一季|前一季|優於第[一二三四1-4]季|高於第[一二三四1-4]季|低於第[一二三四1-4]季|QoQ|sequential', re.I)
# ⚠️ 「下半年較上半年成長」裡有「年成長」、「下半年增加」裡有「年增」→ 前面是「半」的不算
YOY_RE = re.compile(r'(?<!半)年增|(?<!半)年減|較去年|去年同期|(?<!半)年成長|YoY|year[- ]over[- ]year', re.I)
CN_NUM = {'一': 1, '二': 2, '三': 3, '四': 4, '1': 1, '2': 2, '3': 3, '4': 4}


def _quarter(d):
    return (d.month - 1) // 3 + 1


def horizon(t, d):
    """這句講的是哪一段時間;講的是已經過去的那一段 → 'past'(⛔ 是報結果不是展望);沒講時間 → None。d = 簡報的場次日期。"""
    y0, cq = d.year, _quarter(d)
    # 縮寫:1H26 / 2H26(半年)、4Q26 / Q4'26 / Q4 26(季)—— ⚠️ 10/24 實跑:「1H26」被舊樣式當成「H2」
    mh = re.search(r'(?<![0-9A-Za-z])([12])H\s?\'?(\d{2})(?![0-9])', t)
    if mh:
        y, half = 2000 + int(mh.group(2)), mh.group(1)
        if half == '2':
            return 'past' if y < y0 else f'{y}H2'
        return 'past' if (y < y0 or (y == y0 and d.month > 6)) else f'{y}H1'
    mqq = re.search(r'(?<![0-9A-Za-z])([1-4])Q\s?\'?(\d{2})(?![0-9])', t) or re.search(r'(?<![0-9A-Za-z])Q([1-4])\s?\'?(\d{2})(?![0-9])', t)
    if mqq:
        y, q = 2000 + int(mqq.group(2)), int(mqq.group(1))
        return 'past' if (y < y0 or (y == y0 and q < cq)) else f'{y}Q{q}'
    mrg = re.search(r'(20[2-3]\d)\s*[-~–—至到]\s*(20[2-3]\d)\s*年', t)
    if mrg:
        return f'{mrg.group(1)}-{mrg.group(2)}'          # 多年目標(複合成長)→ ⛔ 對單一年的答案
    m = (re.search(r'(20[2-3]\d)\s*年', t)
         or re.search(r'(?<![\d.])(20[2-3]\d)(?![\d.%萬億元])\s*(?=全年|年度|上半|下半|第\s*[一二三四1-4]\s*季)', t))
    yr = int(m.group(1)) if m else None
    mr = re.search(r'(?<![0-9])(1[0-2]\d)\s*年', t)      # 民國年(115 年 = 2026)
    if yr is None and mr:
        yr = int(mr.group(1)) + 1911
    if '明年' in t or re.search(r'next year', t, re.I):
        yr = y0 + 1
    if '後年' in t:
        yr = y0 + 2
    q = None
    mq = (re.search(r'第\s*([一二三四1-4])\s*季', t) or re.search(r'(?<![A-Za-z0-9])([1-4])\s*Q(?![A-Za-z0-9])', t)
          or re.search(r'(?<![A-Za-z0-9])Q\s*([1-4])(?![0-9])', t))     # ⚠️「Q3營收」裡 \b 不成立(中文也是 word 字元)
    if mq:
        q = CN_NUM.get(mq.group(1))
    if re.search(r'下一季|下季|next quarter', t, re.I) and q is None:
        q = cq                    # 法說會多半在季底後一兩個月開:「下一季」= 開會時正在跑的那一季
    if q:
        y = yr or y0
        if y < y0 or (y == y0 and q < cq):
            return 'past'         # 講的是已經過去的那一季(報結果,⛔ 不是展望)
        return f'{y}Q{q}'
    if '下半年' in t or re.search(r'second half|(?<![0-9A-Za-z])(2H|H2)(?![0-9A-Za-z])', t):
        y = yr or y0
        return 'past' if y < y0 else f'{y}H2'          # 10~12 月講的「下半年」還沒結束 → 照樣是展望
    if '上半年' in t or re.search(r'first half|(?<![0-9A-Za-z])(1H|H1)(?![0-9A-Za-z])', t):
        y = yr or y0              # 下半年講「上半年」沒寫明年 = 報上半年的結果(明年上半年會寫「明年」)
        return 'past' if (y < y0 or (y == y0 and d.month > 6)) else f'{y}H1'
    if yr and yr >= y0:
        return str(yr)
    if re.search(r'今年|全年|this year|full[- ]year', t, re.I):
        return str(y0)
    return None


LATER_RE = re.compile(r'後續|之後|往後|未來|長期|中長期|陸續|逐步|long[- ]term|going forward', re.I)


def _explicit_year(t, d):
    """這一小段有沒有「明寫」的年份(2026 年 / 2026 全年 / 2H26 / 4Q26 / 115 年 / 明年);沒有 → None"""
    m = (re.search(r'(20[2-3]\d)\s*年', t) or re.search(r'(?<![\d.])(20[2-3]\d)(?![\d.%萬億元])\s*(?=全年|年度|上半|下半|第)', t))
    if m:
        return int(m.group(1))
    m = re.search(r'(?<![0-9A-Za-z])[1-4]Q\s?\'?(\d{2})(?![0-9])', t) or re.search(r'(?<![0-9A-Za-z])[12]H\s?\'?(\d{2})(?![0-9])', t)
    if m:
        return 2000 + int(m.group(1))
    m = re.search(r'(?<![0-9])(1[0-2]\d)\s*年', t)
    if m:
        return int(m.group(1)) + 1911
    if '明年' in t:
        return d.year + 1
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


CLAUSE_RE = re.compile(r'[，,;；。：]|(?<!\d):(?!\d)')
# 只講一個產品線 / 事業(「家用營收」「TVS 業績」「GaN(氮化鎵):…」)→ 先收著、⛔ 拿全公司的季報對答案
SEG_RE = re.compile(r'產品線|事業部|事業群|子公司|家用|商用|產品(?:業績|營收|出貨)')
_SEG_UNIT_RE = re.compile(r'([\u4e00-\u9fffA-Za-z])\s?(?:業務|事業)')     # 「鞋材業務」「AI 業務」是產品線;「各項業務」「業務持續拓展」不是
_GENERIC_BEFORE = set('各項整體全體公司集團本核心主要既有新的與及和、')
WHOLE_RE = re.compile(r'全公司|整體|合併|公司整體|集團|本公司')
LABEL_RE = re.compile(r'^\s*([A-Za-z][A-Za-z0-9\-]{1,10})\s*(\(.{1,10}\)|（.{1,10}）)?\s*$')     # 「GaN (氮化稼)」這種產品標題
_LABEL_STOP = {'outlook', 'guidance', 'revenue', 'summary', 'highlights', 'agenda', 'note', 'notes', 'source', 'overview', 'business'}
_NOT_SEG_TOKEN = re.compile(r'^(Q[1-4]|H[12]|[1-4]Q|[12]H|FY\d*|YoY|QoQ)$', re.I)


def _clauses(s):
    return [x for x in CLAUSE_RE.split(s) if x and x.strip()]


def _seg_of(before, near, claim_clause):
    """這個展望是不是只講某個產品線 / 事業。claim_clause 裡寫了「整體 / 合併 / 全公司」→ 不是。
    before = 同一句前面所有小段(只看「GaN (氮化稼)」這種產品標題);near = 前一段 + 這一段(看「家用 / XX 業務 / TVS 業績」)。"""
    if WHOLE_RE.search(claim_clause):
        return False
    for x in before:
        lb = LABEL_RE.match(x)
        if lb and not _NOT_SEG_TOKEN.match(lb.group(1)) and lb.group(1).lower() not in _LABEL_STOP:
            return True
    for x in near:
        if SEG_RE.search(x):
            return True
        if any(c not in _GENERIC_BEFORE for c in _SEG_UNIT_RE.findall(x)):
            return True
        for tok in re.findall(r'(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]+)\s*(?:業績|營收|出貨)', x):
            if not _NOT_SEG_TOKEN.match(tok):
                return True
    return False


def _excluded(s):
    """⛔ 不是公司自己可以對答案的展望 → 回原因;是 → None"""
    if CD.DISCLAIM_RE.search(s):
        return '免責'
    if CD.NOTE_RE.search(s):
        return '註腳'
    if ESG_RE.search(s):
        return 'ESG'
    if ACCT_RE.search(s):
        return '會計/股利'
    if OTHER_RE.search(s) or CD.MACRO_RE.search(s):
        return '總經/別人'
    return None


def claims_of(s, d):
    """一句話 → 0~多個展望(一句常常同時講營收和毛利率:「第四季營收將成長,毛利率將持平」)。
    ⭐ 一句裡常常「前半報結果、後半講展望」→ 每一小段(逗號切)各自看:
       有展望字眼的那一小段才算;時間 / 指標可以向前一小段借(「下半年透過…,有望挹注營收」)、
       指標 / 方向 / 跟誰比也可以向後一小段借(「第四季營收將持續攀升,整體績效將優於第三季」),
       ⛔ 但後一小段講的是別的指標就不借(「營收將成長,毛利率較上季持平」的「較上季」不是營收的)。"""
    s = CD.norm_radicals(s)         # 「成⾧」→「成長」(PDF 部首字;10/24 量 150 份有 27 份)
    parts = _clauses(s)
    got, last_h, skip = [], None, -1
    for k, fwd in enumerate(parts):
        if k == skip or not FWD_RE.search(fwd):
            continue
        prev = parts[k - 1] if k > 0 else ''
        nxt = parts[k + 1] if k + 1 < len(parts) else ''
        if CD.TITLE_RE.search(fwd) and nxt:
            # 「業績展望：下半年營收較上半年大幅成長」→ 標題那段沒有內容,內容在冒號後面
            fwd, nxt, skip = fwd + '：' + nxt, (parts[k + 2] if k + 2 < len(parts) else ''), k + 1
        h = horizon(fwd, d)
        if h is not None and h != 'past' and re.fullmatch(r'\d{4}', h) and not _explicit_year(fwd, d):
            # 「全年 / 今年」沒寫年份,同一句前面寫了「2026 全年：」→ 用前面寫的(1294:2025-12 講「2026全年：…全年營收預期恢復雙位數成長」)
            yx = next((y for y in (_explicit_year(x, d) for x in reversed(parts[:k])) if y), None)
            if yx and yx >= d.year:
                h = str(yx)
        if h is None and not LATER_RE.search(fwd):
            # ⛔「預計 1Q26 裝設完成,後續將開始貢獻營收」:「後續 / 未來」講的是之後某個時候,⛔ 借前面那個時間
            if prev:
                h = horizon(prev, d)
            if h is None:
                h = last_h                  # 同一句前面已經講過時間
            if h is None:
                for x in reversed(parts[:max(0, k - 1)]):
                    hx = horizon(x, d)
                    if hx and hx != 'past':
                        h = hx              # 時間寫在同一句更前面的小段
                        break
        if h == 'past':
            continue                        # 講的是已經過去的那一段 = 報結果
        m = metric(fwd) or metric(prev) or (metric(nxt) if nxt and not FWD_RE.search(nxt) else None)
        if not m:
            continue                        # 沒有指標(「預計 2029 年投產」「今年會是亮麗的一年」)→ ⛔ 對答案,先不收
        same = lambda x: bool(x) and metric(x) in (None, m)
        dr = direction(fwd)
        if dr is None and same(nxt) and not FWD_RE.search(nxt):
            dr = direction(nxt)
        if h is None and not dr:
            continue
        ctx = (prev + ',' if same(prev) else '') + fwd + (',' + nxt if same(nxt) else '')
        cmp_ = 'QoQ' if QOQ_RE.search(ctx) else ('YoY' if YOY_RE.search(ctx) else None)
        last_h = h or last_h
        hit = next((x for x in got if (x['m'], x['h'], x['dir']) == (m, h, dr)), None)
        if hit:
            hit['cmp'] = hit['cmp'] or cmp_
            continue
        if m == 'ni' and POS_RE.search(fwd + (',' + prev if same(prev) else '')):
            dr = 'pos'                      # 「轉虧為盈 / 應可維持獲利局面」= 要賺錢才算做到
        src = fwd if metric(fwd) else (prev if metric(prev) else nxt)
        seg = _seg_of(parts[:k], [prev, fwd] + ([src] if src not in (fwd, prev) else []), fwd + src)
        got.append({'m': m, 'dir': dr, 'h': h, 'cmp': cmp_,
                    'ok': bool(m in GRADABLE and dr in ('up', 'down', 'flat', 'pos') and h and '-' not in h and not seg),
                    **({'seg': 1} if seg else {})})
    return got


def guidance_of(pages, d):
    """pages = 每頁的字(confcall_deck 存的全文 'p');d = 場次日期(date 或 'YYYY-MM-DD')。"""
    if isinstance(d, str):
        d = date.fromisoformat(d[:10])
    out, seen = [], set()
    for p, t in CD.page_lines(pages):
        s = t.strip()
        if len(s) < 8 or s in seen or _excluded(s):
            continue
        cs = claims_of(s, d)
        if cs:
            seen.add(s)
        out += [{'p': p, 't': s, **c} for c in cs]
    return out


def explain(pages, d):
    """量測用:每一句有「之後」字眼的句子 → 收了(None)/ 為什麼沒收(人工看漏掉了什麼)。"""
    if isinstance(d, str):
        d = date.fromisoformat(d[:10])
    out = []
    for p, t in CD.page_lines(pages):
        s = t.strip()
        if len(s) < 8 or not FWD_RE.search(s):
            continue
        why = _excluded(s)
        if not why and not claims_of(s, d):
            fw = [x for x in _clauses(s) if FWD_RE.search(x)]
            why = ('講過去' if fw and all(horizon(x, d) == 'past' for x in fw)
                   else '沒指標' if not metric(s) else '太空泛')
        out.append((p, s, why))
    return out


# ───────────────────────── 對答案(雛形)─────────────────────────
# 門檻(⚠️ 定義,⛔ 調來讓成績好看):營收 / 獲利用「變動 %」、毛利率用「差幾個百分點」
REV_UP, REV_FLAT = 1.0, 3.0          # 營收:+1% 以上算往上、-1% 以下算往下;±3% 內也算「持平」
GM_UP, GM_FLAT = 0.3, 0.5            # 毛利率:+0.3pp 算往上;±0.5pp 內算持平


def _qkey(pstr):
    """'2026-09-30' → (2026, 3)"""
    y, m = int(pstr[:4]), int(pstr[5:7])
    return y, (m - 1) // 3 + 1


def _sum(qs, keys, field):
    vals = [qs.get(k, {}).get(field) for k in keys]
    return None if any(v is None for v in vals) else sum(vals)


def _periods(h, cmp_):
    """展望的時間 → (要看的季, 拿來比的季)。沒寫跟誰比:季 → 上一季、半年 → 上半年、全年 → 去年。"""
    if 'Q' in h:
        y, q = int(h[:4]), int(h[-1])
        cur = [(y, q)]
        base = [(y - 1, q)] if cmp_ == 'YoY' else [((y, q - 1) if q > 1 else (y - 1, 4))]
    elif h.endswith('H1') or h.endswith('H2'):
        y, half = int(h[:4]), h[-1]
        cur = [(y, 1), (y, 2)] if half == '1' else [(y, 3), (y, 4)]
        if cmp_ == 'YoY' or half == '1':
            base = [(y - 1, k[1]) for k in cur]
        else:
            base = [(y, 1), (y, 2)]
    else:
        y = int(h)
        cur = [(y, q) for q in range(1, 5)]
        base = [(y - 1, q) for q in range(1, 5)]
    return cur, base


def _margin(qs, keys, m):
    """期間的利潤率(%):Σ分子 ÷ Σ營收。單季又沒有分子時退回 data/fin 自己的欄位(gm / oim / nm)。"""
    rev = _sum(qs, keys, 'rev')
    num = {'gm': None, 'om': _sum(qs, keys, 'opi'), 'nm': _sum(qs, keys, 'ni')}[m]
    if m == 'gm':
        cogs = _sum(qs, keys, 'cogs')
        num = (rev - cogs) if (rev is not None and cogs is not None) else None
    if rev and num is not None and rev > 0:
        return num / rev * 100
    if len(keys) == 1:
        return qs.get(keys[0], {}).get({'gm': 'gm', 'om': 'oim', 'nm': 'nm'}[m])
    return None


def _plabel(keys):
    """[(2026, 4)] → '2026Q4';[(2026, 3), (2026, 4)] → '2026H2';四季 → '2026'"""
    if len(keys) == 1:
        return f'{keys[0][0]}Q{keys[0][1]}'
    if len(keys) == 2:
        return f'{keys[0][0]}H{1 if keys[0][1] == 1 else 2}'
    return str(keys[0][0])


def _qmonths(keys):
    return [f'{y}-{(q - 1) * 3 + i:02d}' for y, q in keys for i in (1, 2, 3)]


def _month_known(ym):
    """月營收法定公布期限:隔月 10 號"""
    y, m = int(ym[:4]), int(ym[5:7])
    y2, m2 = (y + 1, 1) if m == 12 else (y, m + 1)
    return f'{y2}-{m2:02d}-10'


def _judge(dr, a, b, margin):
    """(結果, 變動)。利潤率比差幾個百分點、金額比變動 %;金額基準 ≤ 0(上一段虧損)→ 只比大小。"""
    if margin:
        chg = round(a - b, 2)
        up, flat, dn = chg >= GM_UP, abs(chg) <= GM_FLAT, chg <= -GM_UP
    elif b <= 0:
        if dr == 'flat':
            return 'na', None
        chg = None
        up, flat, dn = a > b, False, a < b
    else:
        chg = round((a / b - 1) * 100, 2)
        up, flat, dn = chg >= REV_UP, abs(chg) <= REV_FLAT, chg <= -REV_UP
    hit = (dr == 'up' and up) or (dr == 'down' and dn) or (dr == 'flat' and flat)
    return ('hit' if hit else 'miss'), chg


def grade(claim, quarters, today=None, months=None):
    """拿財報對答案。quarters = data/fin 那種 [{'p': '2026-09-30', 'pub': '2026-11-14', 'rev', 'cogs', 'opi', 'ni', 'gm'…}…]
    (也可以傳已經轉好的 {(年, 季): …});months = 月營收 {'YYYY-MM': 值}(只用在營收:季報要等 45~90 天,月營收隔月 10 號就公布)。
    回 {'res': 'hit' 說到做到 / 'miss' 沒做到 / 'pending' 還沒到期 / 'na' 量不到, 'chg': 實際變動, 'known': 哪天才知道,
        'a' / 'b': 那段時間 / 拿來比的那段的值, 'src': 'm' 月營收 / 'q' 季報, 'cur' / 'base': 期間名稱}。
    ⛔ 前視:'known' 是公布日(季報 pub / 月營收隔月 10 號),研究時只能用 known 之後的股價。"""
    if not claim.get('ok'):
        return {'res': 'na'}
    m, h, dr = claim['m'], claim['h'], claim['dir']
    qs = quarters if isinstance(quarters, dict) else {_qkey(q['p']): q for q in quarters if q.get('p')}
    cur, base = _periods(h, claim.get('cmp'))
    lab = {'cur': _plabel(cur), 'base': _plabel(base)}
    if m == 'rev' and months and dr != 'pos':
        cm, bm = _qmonths(cur), _qmonths(base)
        if all(x in months for x in cm + bm):
            known = _month_known(cm[-1])
            if not (today and known > today.isoformat()):
                a, b = sum(months[x] for x in cm), sum(months[x] for x in bm)
                res, chg = _judge(dr, a, b, False)
                return {'res': res, 'chg': chg, 'known': known, 'a': a, 'b': b, 'src': 'm', **lab}
    if any(k not in qs for k in cur):
        return {'res': 'pending', **lab}
    known = max((qs[k].get('pub') or qs[k]['p']) for k in cur)
    if today and known > today.isoformat():
        return {'res': 'pending', **lab}
    if dr == 'pos':                         # 只看那段時間有沒有賺錢 → ⛔ 需要拿來比的那幾季
        a = _sum(qs, cur, m)
        if a is None:
            return {'res': 'na', 'known': known, **lab}
        return {'res': 'hit' if a > 0 else 'miss', 'chg': None, 'known': known, 'a': a, 'src': 'q', **lab}
    if any(k not in qs for k in base):
        return {'res': 'na', 'known': known, **lab}
    if m in MARGIN:
        a, b = _margin(qs, cur, m), _margin(qs, base, m)
    else:
        a, b = _sum(qs, cur, m), _sum(qs, base, m)
    if a is None or b is None:
        return {'res': 'na', 'known': known, **lab}
    res, chg = _judge(dr, a, b, m in MARGIN)
    return {'res': res, 'chg': chg, 'known': known, 'a': a, 'b': b, 'src': 'q', **lab}


# ───────────────────────── 給 App:每份簡報「公司講的展望 → 做到了沒」(confcall_deck 寫 data/cc/{sym}.json 時呼叫)─────────────────────────
G_MAX = 6          # 每份簡報最多列幾個(可以對答案的排前面)
T_MAX = 160        # 原文最多幾個字(⛔ 改寫,只截短)


def raw_claims(rec, pages=None):
    """一份簡報 → 展望清單(還沒對答案)。有存全文就從全文抽;沒有 → 用以前存的「講到之後」句子(舊規則抽的,比較少)。"""
    d = rec.get('d')
    if not d:
        return []
    dd = date.fromisoformat(d[:10])
    if pages:
        return guidance_of(pages, dd)
    out, seen = [], set()
    for p, s in (rec.get('outlook') or []):
        if not isinstance(s, str) or s in seen or _excluded(CD.norm_radicals(s)):
            continue
        seen.add(s)
        out += [{'p': p, 't': s, **c} for c in claims_of(s, dd)]
    return out


def _amt(v, src):
    """金額 → 億元(月營收存百萬元、季報存元)"""
    return None if v is None else round(v / (100 if src == 'm' else 1e8), 2)


def deck_claims(rec, pages, quarters, months, today, nmax=G_MAX):
    """App 用:展望 + 對答案的結果(精簡欄位)。"""
    cl = raw_claims(rec, pages)
    cl.sort(key=lambda x: (not x['ok'], x['p']))
    out = []
    for c in cl[:nmax]:
        x = {'p': c['p'], 't': CD.norm_radicals(c['t'])[:T_MAX], 'm': c['m'], 'dir': c['dir'], 'h': c['h'], 'ok': 1 if c['ok'] else 0}
        if c.get('cmp'):
            x['cmp'] = c['cmp']
        if c.get('seg'):
            x['seg'] = 1
        if c['ok']:
            g = grade(c, quarters or [], today=today, months=months)
            r = {'res': g['res']}
            for k in ('known', 'cur', 'base', 'src', 'chg'):
                if g.get(k) is not None:
                    r[k] = g[k]
            if g.get('a') is not None:
                r['a'] = round(g['a'], 2) if c['m'] in MARGIN else _amt(g['a'], g.get('src'))
            if g.get('b') is not None:
                r['b'] = round(g['b'], 2) if c['m'] in MARGIN else _amt(g['b'], g.get('src'))
            x['r'] = r
        out.append(x)
    return out


def months_of(fund_row):
    """data/fund_yoy_gm.json 一檔的 mrh([['2026-09', 34423], …],百萬元)→ {'2026-09': 34423}"""
    try:
        return {str(a): float(b) for a, b in (fund_row or {}).get('mrh') or [] if b is not None}
    except (TypeError, ValueError):
        return {}


# ───────────────────────── 研究:說到做到(`--grade`)─────────────────────────
def load_fin(src, repo='.'):
    """data/fin 季報 → {sym: {(年, 季): 那一季}}。src = 目錄(data/fin)或 git ref(origin/gh-pages / origin/data)。"""
    import subprocess
    from pathlib import Path
    out = {}
    if Path(src).is_dir():
        for f in Path(src).glob('*.json'):
            try:
                j = json.loads(f.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                continue
            out[j.get('sym') or f.stem] = {_qkey(q['p']): q for q in j.get('q') or [] if q.get('p')}
        return out
    names = subprocess.run(['git', '-C', repo, 'ls-tree', '--name-only', src, 'data/fin/'], capture_output=True, text=True).stdout.split()
    pr = subprocess.run(['git', '-C', repo, 'cat-file', '--batch'], input=''.join(f'{src}:{n}\n' for n in names).encode(), capture_output=True)
    buf, i = pr.stdout, 0
    for n in names:
        he = buf.index(b'\n', i)
        hdr = buf[i:he].split()
        if len(hdr) < 3 or hdr[1] != b'blob':
            i = he + 1
            continue
        size = int(hdr[2])
        body = buf[he + 1: he + 1 + size]
        i = he + 1 + size + 1
        try:
            j = json.loads(body)
        except ValueError:
            continue
        out[j.get('sym') or n.rsplit('/', 1)[-1][:-5]] = {_qkey(q['p']): q for q in j.get('q') or [] if q.get('p')}
    return out


def naive_dir(c, qs):
    """⭐ 公平的對照:講的那天(c['d'])已經公布的季報猜方向 —— 目標期間已公布的那幾季 vs 同一批基準季;
    一季都還沒公布 → 最近一季的年增。回 up / down / flat / None。(利潤率 / 轉虧為盈 → None)"""
    if c['dir'] == 'pos' or c['m'] in MARGIN:
        return None
    cur, base = _periods(c['h'], c.get('cmp'))
    pairs = list(zip(cur, base)) if len(cur) == len(base) else []
    known = [(a, b) for a, b in pairs if a in qs and (qs[a].get('pub') or '9') <= c['d'] and b in qs]
    f = c['m']

    def sgn(a, b):
        return None if not b or b <= 0 else ('up' if a > b * 1.01 else 'down' if a < b * 0.99 else 'flat')
    if known:
        r = sgn(sum(qs[a].get(f) or 0 for a, _ in known), sum(qs[b].get(f) or 0 for _, b in known))
        if r:
            return r
    pubs = sorted(k for k, q in qs.items() if (q.get('pub') or '9') <= c['d'])
    if pubs:
        y, q = pubs[-1]
        if (y - 1, q) in qs:
            return sgn(qs[(y, q)].get(f) or 0, qs[(y - 1, q)].get(f))
    return None


def grade_all(cc_dir, fin, today, log=print):
    """全部讀過的簡報 → 可以對答案的展望(同一家公司講同一句只算第一場)→ 季報對答案 + 兩個對照:
    ① 基準:同一段時間、同一個方向,拿全部公司的季報對(=「隨便一家公司這樣講會不會也對」)
    ② naive:講的那天已經公布的數字猜(=「看最近數字猜,不用聽公司講」)"""
    from pathlib import Path
    import gzip
    import collections
    CD.CC = Path(cc_dir)
    files = CD.load_index().get('files', {})
    recs = []
    for f in sorted((CD.CC / 'cc' / 'feat').glob('*.json.gz')):
        recs += json.loads(gzip.decompress(f.read_bytes()))
    recs.sort(key=lambda r: (r.get('d') or '', r.get('f') or ''))
    txc = {}

    def pages_of(f):
        m = (files.get(f) or {}).get('tx')
        if not m or m == '-':
            return None
        if m not in txc:
            txc[m] = CD._load_json(CD.text_file(m), {}) or {}
        return (txc[m].get(f) or {}).get('p')
    claims, seen, n_tx = [], set(), 0
    for r in recs:
        if r.get('st') != 'ok' or not r.get('d'):
            continue
        pg = pages_of(r.get('f'))
        n_tx += bool(pg)
        for c in raw_claims(r, pg):
            if not c['ok']:
                continue
            key = (r['s'], c['m'], c['h'], c['dir'])
            if key in seen:
                continue
            seen.add(key)
            claims.append(dict(c, s=r['s'], d=r['d'][:10], f=r.get('f')))
    rows, res = [], collections.Counter()
    for c in claims:
        qs = fin.get(c['s'])
        if not qs:
            res['沒有季報'] += 1
            continue
        g = grade(c, qs, today=today)
        res[g['res']] += 1
        if g['res'] not in ('hit', 'miss'):
            continue
        bh = bn = 0
        for qq in fin.values():
            gb = grade(c, qq, today=today)
            if gb['res'] in ('hit', 'miss'):
                bn += 1
                bh += gb['res'] == 'hit'
        nv = naive_dir(c, qs)
        rows.append({'s': c['s'], 'd': c['d'], 'p': c['p'], 'm': c['m'], 'dir': c['dir'], 'h': c['h'], 'cmp': c.get('cmp'),
                     'res': g['res'], 'chg': g.get('chg'), 'known': g.get('known'), 'base': round(bh / bn, 3) if bn else None,
                     'naive': nv, 't': c['t'][:T_MAX]})
    n = len(rows)
    hit = sum(r['res'] == 'hit' for r in rows)
    base = sum(r['base'] or 0 for r in rows) / max(1, n)
    nv_rows = [r for r in rows if r['naive']]
    nv_right = sum(1 for r in nv_rows if (r['naive'] == r['dir']) == (r['res'] == 'hit'))
    dis = [r for r in nv_rows if r['naive'] != r['dir']]
    summ = {'decks': sum(1 for r in recs if r.get('st') == 'ok'), 'decks_text': n_tx, 'claims': len(claims), 'res': dict(res),
            'graded': n, 'hit': hit, 'hit_rate': round(hit / max(1, n), 3), 'base_rate': round(base, 3),
            'naive_n': len(nv_rows), 'naive_right': nv_right, 'disagree_n': len(dis), 'disagree_hit': sum(r['res'] == 'hit' for r in dis),
            'companies': len({r['s'] for r in rows}), 'today': today.isoformat()}
    log(f"📊 簡報 {summ['decks']} 份(有全文 {n_tx})→ 可以對答案的展望 {len(claims)} 個(同一家同一句只算一次)・結果 {dict(res)}")
    log(f"   到期 {n} 個({summ['companies']} 家):說到做到 {hit} = {hit / max(1, n):.1%} ・同一段時間隨便一家公司這樣講會對 {base:.1%}")
    log(f"   用講的那天已公布的數字猜:對 {nv_right}/{len(nv_rows)} ・公司講的跟最近數字相反的 {len(dis)} 次,公司對 {summ['disagree_hit']} 次")
    return summ, rows


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
        if os.getenv('EXPLAIN'):
            for p_, t_, why in explain(rec['p'], st.get('d') or '2026-01-01'):
                if why:
                    print(f'      ✗ p{p_:<2} {why:<6} {t_[:90]}')
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
    ok('④e 「今年會是亮麗的一年」沒有指標 → ⛔ 收(對不了答案)', guidance_of(['年初預期,今年會是亮麗的一年。'], D) == [])
    # ④f~④k 10/24 第一次量 150 份真的全文抓到的誤判
    g11 = guidance_of(['營業收入較去年同期減少，下半年透過國內外展業及健保暫時性支付通過，有望挹注營收。'], D)
    ok('④f 前半報結果、後半講展望 → 只看後半:營收・往上・2026H2', g11 and g11[0]['m'] == 'rev' and g11[0]['dir'] == 'up' and g11[0]['h'] == '2026H2', g11)
    ok('④g 「受惠台股交易活絡,1H26 獲利再創新高」(報結果)⛔ 收、⛔ 被當成下半年', guidance_of(['受惠台股交易活絡，1H26獲利再創新高，年成長148%'], D) == [])
    ok('④h 「規模持續擴大,稅後淨利再創新高」(只有「持續」)⛔ 當展望', guidance_of(['受惠資產管理規模持續擴大，稅後淨利再創新高，年成長27%'], D) == [])
    ok('④i 投資人問卷(「貴公司…」)⛔ 收', guidance_of(['貴公司研發費用占營業收入比重較低，又規劃發展 AI 導入客服營運'], D) == [])
    ok('④j 研究機構 / 市場規模預測 ⛔ 收', guidance_of(['根據研究顯示，預計未來幾年全球汽車售後市場零件規模將穩定成長'], D) == [])
    g12 = guidance_of(['本公司預期115年將恢復穩健成長態勢，獲利逐年提升'], date(2025, 11, 10))
    ok('④k 民國年:「115 年」= 2026', g12 and g12[0]['h'] == '2026', g12)
    g13 = guidance_of(['We expect 2H26 revenue to grow'], D)
    ok('④l 縮寫:2H26 = 2026H2、4Q26 = 2026Q4', g13 and g13[0]['h'] == '2026H2' and guidance_of(['4Q26 revenue will increase'], D)[0]['h'] == '2026Q4', g13)
    # ⑤ 太空泛 ⛔ 收
    ok('⑤ 「持續深耕客戶關係」⛔ 收(沒時間、沒指標)', guidance_of(['持續深耕客戶關係'], D) == [])
    g10 = guidance_of(['下半年營收可望優於上半年'], D)
    ok('⑤b 10 月講「下半年」(還沒結束)→ 2026H2 照收', g10 and g10[0]['h'] == '2026H2' and g10[0]['m'] == 'rev', g10)
    ok('⑤c 10 月講「上半年營收成長」(已經結束)⛔ 收', guidance_of(['上半年營收持續成長'], D) == [])
    # ⑥ 同一句只收一次、頁碼對
    g9 = guidance_of(['毛利率預期第四季將持平', '其他', '毛利率預期第四季將持平'], D)
    ok('⑥ 同一句兩頁都出現 → 只收一次、記第一次出現的頁碼', len(g9) == 1 and g9[0]['p'] == 1 and g9[0]['m'] == 'gm' and g9[0]['dir'] == 'flat', g9)
    # ⑧ 一句講兩件事 / 指標・方向・跟誰比在下一小段(10/24 改成逐小段看)
    g14 = guidance_of(['第四季營收將成長，毛利率將持平'], D)
    ok('⑧ 一句兩個展望:營收往上 + 毛利率持平,時間都是 2026Q4',
       [(x['m'], x['dir'], x['h']) for x in g14] == [('rev', 'up', '2026Q4'), ('gm', 'flat', '2026Q4')], g14)
    g15 = guidance_of(['第四季營收將成長，毛利率較上季持平'], D)
    ok('⑧b ⭐ 決定性對照:後一小段講的是毛利率 →「較上季」⛔ 借給營收那句(而且那段沒有展望字眼 ⛔ 自己成一句)',
       len(g15) == 1 and g15[0]['m'] == 'rev' and g15[0]['cmp'] is None, g15)
    g16 = guidance_of(['預計第四季營收，較上季成長5%'], D)
    ok('⑧c 方向和跟誰比在下一小段:營收・往上・2026Q4・QoQ', g16 and g16[0]['dir'] == 'up' and g16[0]['cmp'] == 'QoQ' and g16[0]['ok'], g16)
    ok('⑧d 總經「聯準會降息、利率走低」⛔ 收;講毛利率的 ⛔ 被當總經(⑥ 那句)',
       guidance_of(['預期聯準會降息,利率走低將帶動營收成長'], D) == [] and guidance_of(['預期第四季毛利率將回升'], D))
    ex = dict((t, w) for _, t, w in explain(['第四季營收將成長，毛利率將持平', '持續深耕客戶關係並預期提升服務', '第三季營收將持續成長'], D))
    ok('⑧e 量測用 explain:收了 → None、沒收 → 原因(太空泛 / 講過去)',
       ex.get('第四季營收將成長，毛利率將持平') is None and ex.get('持續深耕客戶關係並預期提升服務') in ('沒指標', '太空泛')
       and ex.get('第三季營收將持續成長') == '講過去', ex)
    # ⑨ 10/24 第二次量(30 句人工逐句看)抓到的
    ok('⑨a 研究機構 / 市場 / 大盤的預測 ⛔ 收', guidance_of(['2027年台灣科技業獲利預估年增38.5%'], D) == []
       and guidance_of(['Yole預估：先進封裝市場總營收將於2031年倍增'], D) == []
       and guidance_of(['2027 年全球乙太網路光收發模組市場銷售額預估年增約 76%.'], D) == [])
    D7 = date(2026, 10, 7)
    g20 = guidance_of(['下半年業績預估較上半年成長約35~40%'], D7)
    ok('⑨b 「下半年較上半年成長」⛔ 當成跟去年比(「上半年成長」裡有「年成長」)', g20 and g20[0]['cmp'] is None and g20[0]['h'] == '2026H2', g20)
    g21 = guidance_of(['整體營運：產業結構性需求，帶動下半年產能成長整體業績： 2026 下半年預估較上半年約持平（+3~5%）'], D7)
    ok('⑨c 「約持平(+3~5%)」= 持平(⛔ 被前一段的「產能成長」判成往上)', g21 and g21[0]['dir'] == 'flat' and g21[0]['m'] == 'rev' and g21[0]['ok'], g21)
    sic = 'SiC (碳化矽): 呈現 V 型反彈，利用率逐季攀升業績展望：下半年營收較上半年大幅成長 >120%。'
    g22 = guidance_of([sic], D7)
    ok('⑨d 標題「業績展望：」接下一段;「SiC (碳化矽)」= 只講一個產品線 → 收著但 ⛔ 拿全公司對答案',
       g22 and g22[0]['m'] == 'rev' and g22[0]['dir'] == 'up' and g22[0]['h'] == '2026H2' and g22[0].get('seg') == 1 and not g22[0]['ok'], g22)
    g23 = guidance_of([sic.replace('SiC (碳化矽): ', '')], D7)
    ok('⑨e ⭐ 決定性對照:同一句拿掉「SiC (碳化矽):」→ 可以對答案', g23 and not g23[0].get('seg') and g23[0]['ok'], g23)
    g24 = guidance_of(['✓ 家用新品訂單狀況良好，家用下半年將重返成長，全年家用營收可望持平或小幅成長。'], D)
    ok('⑨f 「家用營收」= 產品線(seg)', g24 and all(x.get('seg') for x in g24), g24)
    g25 = guidance_of(['商用新客戶推進順利，家用新品接受度高，全年整體營收可望重返成長'], D)
    ok('⑨g 前面講產品線、但這段寫「整體營收」→ 全公司,可以對答案', g25 and g25[0]['m'] == 'rev' and not g25[0].get('seg') and g25[0]['ok'], g25)
    g26 = guidance_of(['目標2026-2028年營收複合成長>30%'], D)
    ok('⑨h 多年目標「2026-2028 年」→ 時間記區間、⛔ 拿單一年對答案', g26 and g26[0]['h'] == '2026-2028' and not g26[0]['ok'], g26)
    g27 = guidance_of(['Q4 Outlook: revenue will grow sequentially'], D)
    ok('⑨i 英文標題「Q4 Outlook:」⛔ 當產品線', g27 and not g27[0].get('seg') and g27[0]['h'] == '2026Q4' and g27[0]['ok'], g27)
    g28 = guidance_of(['預計TVS業績明年將成長30%'], D)
    ok('⑨j 「TVS 業績」= 產品線;「2026 營收」⛔ 是', g28 and g28[0].get('seg') == 1
       and (lambda g: g and not g[0].get('seg'))(guidance_of(['預計 2027 營收將成長 30%'], D)), g28)
    g30 = guidance_of(['2026 年三發首席大院建案陸續交屋，加上新成屋銷售，預期仍可帶來可觀的營收挹注。'], date(2026, 9, 23))
    ok('⑨k 時間寫在同一句更前面的小段 → 2026', g30 and g30[0]['h'] == '2026' and g30[0]['ok'], g30)
    ok('⑨l ⭐ 決定性對照:前面那段講的是已經過去的(「第二季營收創新高」)→ ⛔ 借成時間',
       (lambda g: g and g[0]['h'] is None and not g[0]['ok'])(guidance_of(['第二季營收創新高，加上新客戶加入，預期將帶來可觀的營收挹注'], D)))
    ok('⑨m 「營收占比由 18.3% 提升至 40%」是結構 ⛔ 營收本身', (lambda g: g and g[0]['m'] == 'mix' and not g[0]['ok'])(
       guidance_of(['營收占比由2025年18.3%提升至2026年預估40%'], D)))
    g31 = guidance_of(['預估2026 全年業績將實現年增約 75~80% 的強勁表現'], D)
    ok('⑨n 「2026 全年」沒有「年」字也認得;「2026 萬元」⛔ 當年份', g31 and g31[0]['h'] == '2026' and g31[0]['cmp'] == 'YoY'
       and horizon('預計投資 2026 萬元', D) is None, g31)
    # ⑩ 10/24 第一次「說到做到」初量(舊簡報 outlook 句 → 35 個到期)照出的抽錯
    rad = '全年營收預期維持雙位數成⾧，主因主要品牌下單增加'
    g40 = guidance_of([rad], date(2025, 11, 11))
    ok('⑩a PDF 部首字「成⾧」= 成長 → 往上(⛔ 被「維持」判成持平);原文照存一字不改',
       g40 and g40[0]['dir'] == 'up' and g40[0]['t'] == rad and direction('維持雙位數成⾧') == 'flat', g40)
    g41 = guidance_of(['1) 整體預估明年加工絲景氣及接單狀況，應可維持獲利局面。'], date(2024, 12, 12))
    ok('⑩b 「應可維持獲利局面」= 明年要賺錢(dir pos)⛔ 持平', g41 and g41[0]['m'] == 'ni' and g41[0]['dir'] == 'pos' and g41[0]['h'] == '2025' and g41[0]['ok'], g41)
    QP = [{'p': f'2025-{mm}', 'pub': f'{2025 if mm != "12-31" else 2026}-{pb}', 'rev': 100, 'ni': ni}
          for mm, pb, ni in (('03-31', '05-15', 5), ('06-30', '08-14', -2), ('09-30', '11-14', 1), ('12-31', '03-31', 3))]
    ok('⑩b2 全年 +7(有一季虧)→ 做到;全年 −1 → 沒做到', g41 and grade(g41[0], QP, today=date(2026, 4, 1))['res'] == 'hit'
       and grade(g41[0], [dict(x, ni=x['ni'] - 2) for x in QP], today=date(2026, 4, 1))['res'] == 'miss')
    bbu = '美國廠第一條 BBU 全自動化生產線預計於 1Q26裝設完成，後續將開始貢獻營收，帶動整體業務進一步成長。'
    g42 = [x for x in guidance_of([bbu], date(2025, 12, 12)) if x['m'] == 'rev']
    ok('⑩c 「預計 1Q26 裝設完成,後續將開始貢獻營收」→ 營收那句 ⛔ 借裝機的時間(⛔ 可以對答案)', g42 and g42[0]['h'] is None and not g42[0]['ok'], g42)
    g43 = [x for x in guidance_of([bbu.replace('後續將', '將')], date(2025, 12, 12)) if x['m'] == 'rev']
    ok('⑩c2 ⭐ 決定性對照:拿掉「後續」→ 1Q26 營收往上', g43 and g43[0]['h'] == '2026Q1' and g43[0]['ok'], g43)
    g44 = guidance_of(['2026全年：加深客戶往來，營收恢復雙位數成長全年營收預期恢復雙位數成長'], date(2025, 12, 2))
    ok('⑩d 「2026全年：…全年營收預期…」(12 月講)→ 2026(⛔ 2025)', g44 and g44[0]['h'] == '2026', g44)
    g45 = guidance_of(['Q3營收預期YoY成長 >170%'], date(2025, 8, 14))
    ok('⑩e 「Q3營收」(Q 後面直接接中文)也認得 → 2025Q3・YoY', g45 and g45[0]['h'] == '2025Q3' and g45[0]['cmp'] == 'YoY', g45)
    g46 = guidance_of(['✓ 業務持續拓展，預計2025年營收優於2024年'], date(2025, 8, 29))
    g47 = guidance_of(['鞋材業務今年營收可望成長'], date(2025, 8, 29))
    ok('⑩f 「業務持續拓展」是全公司的話(⛔ 產品線);「鞋材業務」才是', g46 and not g46[0].get('seg') and g46[0]['ok']
       and g47 and g47[0].get('seg') == 1, (g46, g47))
    # ⑦ 對答案(用 data/fin 那種季報)
    Q = [{'p': '2025-12-31', 'pub': '2026-03-31', 'rev': 640, 'gm': 10.0, 'opi': 10},
         {'p': '2026-03-31', 'pub': '2026-05-15', 'rev': 690, 'gm': 12.0, 'opi': 20},
         {'p': '2026-06-30', 'pub': '2026-08-14', 'rev': 840, 'gm': 18.9, 'opi': 110},
         {'p': '2026-09-30', 'pub': '2026-11-14', 'rev': 956, 'gm': 22.0, 'opi': 183}]
    c4 = guidance_of(['第四季合併營收將持續攀升,整體績效將優於第三季。'], D)[0]
    ok('⑦ 2026Q4 還沒有季報 → 還沒到期', grade(c4, Q)['res'] == 'pending', grade(c4, Q))
    Q5 = Q + [{'p': '2026-12-31', 'pub': '2027-03-31', 'rev': 1000, 'gm': 23.0, 'opi': 200}]
    g4 = grade(c4, Q5, today=date(2027, 4, 1))
    ok('⑦b 第四季 1,000 vs 第三季 956(+4.6%)→ 說到做到,幾時才知道 = 季報公布日', g4['res'] == 'hit' and g4['chg'] == 4.6 and g4['known'] == '2027-03-31', g4)
    ok('⑦c ⭐ 前視守門:季報公布(2027-03-31)之前問 → 還沒到期', grade(c4, Q5, today=date(2027, 3, 1))['res'] == 'pending')
    Q6 = Q + [{'p': '2026-12-31', 'pub': '2027-03-31', 'rev': 900, 'gm': 21.0, 'opi': 150}]
    ok('⑦d ⭐ 決定性對照:同一句、第四季 900 → 沒做到', grade(c4, Q6, today=date(2027, 4, 1))['res'] == 'miss')
    cg = guidance_of(['毛利率預期第三季將持平'], date(2026, 7, 20))[0]
    ok('⑦e 毛利率「持平」:22.0 vs 18.9(+3.1pp)→ 沒做到(⛔ 拿營收的門檻判)', grade(cg, Q, today=date(2026, 12, 1))['res'] == 'miss', grade(cg, Q, today=date(2026, 12, 1)))
    ch = guidance_of(['下半年營收可望優於上半年'], date(2026, 5, 26))[0]
    ok('⑦f 半年:下半年(Q3+Q4)vs 上半年(Q1+Q2)', grade(ch, Q5, today=date(2027, 4, 1))['res'] == 'hit' and grade(ch, Q5, today=date(2027, 4, 1))['chg'] == round((1956 / 1530 - 1) * 100, 2), grade(ch, Q5, today=date(2027, 4, 1)))
    ok('⑦g 量不到的(需求 / 沒有時間)→ na', grade(guidance_of(['下半年需求可望回溫'], date(2026, 5, 26))[0], Q5)['res'] == 'na')
    # ⑦h~⑦k 利潤率 / 稅後淨利 / 轉虧為盈(10/24 拆指標)
    gp = guidance_of(['今年獲利可望挑戰新高'], D)
    ok('⑦h 「獲利」= 稅後淨利(⛔ 營業利益)', gp and gp[0]['m'] == 'ni' and gp[0]['ok'], gp)
    gm2 = guidance_of(['預期第四季營益率將提升'], D)
    ok('⑦i 「營益率」= 營業利益率(⛔ 被「營業利益」吃掉)', gm2 and gm2[0]['m'] == 'om', gm2)
    QQ = Q5 + [{'p': '2025-09-30', 'pub': '2025-11-14', 'rev': 600, 'gm': 9.0, 'opi': 5}]
    r_om = grade(gm2[0], QQ, today=date(2027, 4, 1))
    ok('⑦j 營益率用營業利益 ÷ 營收算:第四季 200/1000 = 20.0% vs 第三季 183/956 = 19.14% → +0.86pp 說到做到',
       r_om['res'] == 'hit' and r_om['chg'] == round(200 / 1000 * 100 - 183 / 956 * 100, 2), r_om)
    gpos = guidance_of(['預期明年將轉虧為盈'], D)
    QN = [{'p': f'{y}-{mm}', 'pub': f'{y + (1 if q == 4 else 0)}-{["05-15", "08-14", "11-14", "03-31"][q - 1]}', 'rev': 100, 'ni': ni}
          for y, ni_list in ((2026, (-10, -8, -6, -4)), (2027, (-3, -1, 1, 2)))
          for q, (mm, ni) in enumerate(zip(('03-31', '06-30', '09-30', '12-31'), ni_list), start=1)]
    r_pos = grade(gpos[0], QN, today=date(2028, 4, 1)) if gpos else {}
    ok('⑦k 「明年轉虧為盈」:2027 全年 −1 → 還是虧 = 沒做到(⛔ 只因為虧比較少就算做到)',
       gpos and gpos[0]['m'] == 'ni' and gpos[0]['dir'] == 'pos' and r_pos.get('res') == 'miss', (gpos, r_pos))
    QN2 = [dict(x, ni=(x['ni'] + 5 if x['p'].startswith('2027') else x['ni'])) for x in QN]
    ok('⑦k2 ⭐ 決定性對照:同一句、2027 全年 +19 → 說到做到', gpos and grade(gpos[0], QN2, today=date(2028, 4, 1))['res'] == 'hit')
    ok('⑦l 「續拚新高」算展望', (lambda g: g and g[0]['m'] == 'rev' and g[0]['h'] == '2026')(guidance_of(['全年營收續拚新高'], D)))
    # ⑪ 月營收對答案(季報要等 45~90 天,月營收隔月 10 號就公布)+ App 用的精簡欄位
    MO = {f'2026-{i:02d}': v for i, v in zip(range(7, 13), (300, 310, 346, 330, 340, 350))}
    r_m = grade(c4, Q, today=date(2027, 1, 12), months=MO)
    ok('⑪a 「第四季營收將優於第三季」用月營收:10~12 月 1,020 vs 7~9 月 956 → 說到做到,1/10(12 月營收公布)就知道',
       r_m['res'] == 'hit' and r_m['src'] == 'm' and r_m['known'] == '2027-01-10' and r_m['a'] == 1020 and r_m['b'] == 956
       and r_m['cur'] == '2026Q4' and r_m['base'] == '2026Q3', r_m)
    ok('⑪b 12 月營收還沒公布 → 退回季報 → 還沒到期', grade(c4, Q, today=date(2026, 12, 20), months={k: v for k, v in MO.items() if k != '2026-12'})['res'] == 'pending')
    ok('⑪c ⭐ 決定性對照:同一句、10~12 月營收合計 900 → 沒做到', grade(c4, Q, today=date(2027, 1, 12), months=dict(MO, **{'2026-10': 280, '2026-11': 300, '2026-12': 320}))['res'] == 'miss')
    ok('⑪d 1/10 之前問(12 月營收法定還沒到)→ 還沒到期(前視守門)', grade(c4, Q, today=date(2027, 1, 5), months=MO)['res'] == 'pending')
    pages = ['', '第四季合併營收將持續攀升,整體績效將優於第三季。', '預計明年資本支出約500億元']
    dc = deck_claims({'d': '2026-10-23'}, pages, Q, MO, date(2027, 1, 12))
    ok('⑪e App 欄位:可以對答案的排前面、金額換成億元、附公布日與期間',
       dc and dc[0]['m'] == 'rev' and dc[0]['ok'] == 1 and dc[0]['r']['res'] == 'hit' and dc[0]['r']['a'] == 10.2 and dc[0]['r']['src'] == 'm'
       and dc[0]['p'] == 2 and any(x['m'] == 'capex' and x['ok'] == 0 and 'r' not in x for x in dc), dc)
    dc2 = deck_claims({'d': '2026-10-23', 'outlook': [[13, '第四季合併營收將持續攀升,整體績效將優於第三季。'], [5, '本簡報包含前瞻性陳述']]}, None, Q, None, date(2026, 10, 24))
    ok('⑪f 沒有全文 → 用以前存的「講到之後」句子;免責聲明 ⛔ 收;季報還沒有 → 還沒到期',
       len(dc2) == 1 and dc2[0]['p'] == 13 and dc2[0]['r']['res'] == 'pending' and dc2[0]['r']['cur'] == '2026Q4', dc2)
    ok('⑪g months_of 讀 fund_yoy_gm 的 mrh;壞的回空', months_of({'mrh': [['2026-09', 34423], ['2026-08', None]]}) == {'2026-09': 34423.0}
       and months_of({'mrh': 'x'}) == {} and months_of(None) == {})
    # ⑫ 研究模式 --grade(合成 cc_deep + 兩家公司的季報)
    import gzip as _gz, tempfile as _tf
    from pathlib import Path as _P
    tdir = _P(_tf.mkdtemp())
    (tdir / 'cc' / 'feat').mkdir(parents=True)
    (tdir / 'cc' / 'index.json').write_text(json.dumps({'files': {}}), encoding='utf-8')
    feats = [{'s': '1111', 'd': '2025-08-14', 'f': 'a.pdf', 'st': 'ok', 'outlook': [[3, '預期全年營收將成長']]},
             {'s': '1111', 'd': '2025-11-12', 'f': 'b.pdf', 'st': 'ok', 'outlook': [[4, '預期全年營收將成長']]},
             {'s': '1111', 'd': '2025-11-12', 'f': 'b.pdf', 'st': 'ok', 'outlook': [[5, '預期第四季營收將較上季成長']]}]
    (tdir / 'cc' / 'feat' / '2025-08.json.gz').write_bytes(_gz.compress(json.dumps(feats).encode()))
    mk = lambda revs, y0=2024: {(y0 + i // 4, i % 4 + 1): {'p': f'{y0 + i // 4}-{("03-31", "06-30", "09-30", "12-31")[i % 4]}',
                                  'pub': f'{y0 + i // 4 + (1 if i % 4 == 3 else 0)}-{("05-15", "08-14", "11-14", "03-31")[i % 4]}', 'rev': v}
                               for i, v in enumerate(revs)}
    FIN = {'1111': mk([100, 100, 100, 100, 110, 112, 115, 120]), '2222': mk([100, 100, 100, 100, 90, 92, 95, 90])}
    summ, rows = grade_all(str(tdir), FIN, date(2026, 4, 1), log=lambda *_: None)
    ok('⑫a 同一家公司在兩場講同一句只算一次(留最早那場)、兩句都到期都做到', summ['claims'] == 2 and summ['graded'] == 2 and summ['hit'] == 2
       and sorted(r['d'] for r in rows) == ['2025-08-14', '2025-11-12'], (summ, rows))
    ok('⑫b 基準 = 同一段時間隨便一家公司這樣講會對的比例(兩家各一半)', all(r['base'] == 0.5 for r in rows), rows)
    ok('⑫c naive:8/14 講全年,上半年已公布(+11%)→ 猜往上', next(r for r in rows if r['h'] == '2025')['naive'] == 'up', rows)
    cq3 = {'d': '2025-09-01', 'dir': 'up', 'm': 'rev', 'h': '2025Q3'}
    nv0 = naive_dir(cq3, FIN['2222'])
    nv_fut = naive_dir(cq3, {**FIN['2222'], (2025, 3): dict(FIN['2222'][(2025, 3)], rev=999)})
    nv_pub = naive_dir(cq3, {**FIN['2222'], (2025, 2): dict(FIN['2222'][(2025, 2)], rev=999)})
    ok('⑫d naive 前視守門:9/1 講第三季,第三季(11/14 才公布)改成 999 ⛔ 影響;⭐ 對照:已公布的第二季改 999 → 跟著變',
       nv0 == 'down' and nv_fut == 'down' and nv_pub == 'up', (nv0, nv_fut, nv_pub))
    print('\n' + ('❌ confcall_guidance selftest 失敗 %d 條' % len(fails) if fails else '✅ confcall_guidance selftest 全過'))
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    if '--grade' in sys.argv:
        i = sys.argv.index('--grade')
        cc = sys.argv[i + 1] if len(sys.argv) > i + 1 else os.getenv('CC_DIR', 'cc_deep')
        fin_src = os.getenv('FIN', 'origin/gh-pages')
        summ, rows = grade_all(cc, load_fin(fin_src), date.fromisoformat(os.getenv('TODAY') or date.today().isoformat()))
        if os.getenv('OUT'):
            from pathlib import Path
            Path(os.environ['OUT']).write_text(json.dumps({'summary': summ, 'rows': rows}, ensure_ascii=False, indent=1), encoding='utf-8')
        sys.exit(0)
    if '--measure' in sys.argv:
        i = sys.argv.index('--measure')
        cc = sys.argv[i + 1] if len(sys.argv) > i + 1 else os.getenv('CC_DIR', 'cc_deep')
        n = int(sys.argv[i + 2]) if len(sys.argv) > i + 2 else 40
        sys.exit(measure(cc, n))
    print(__doc__)
