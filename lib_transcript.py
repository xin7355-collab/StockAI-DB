#!/usr/bin/env python3
"""📄 法說會「逐字稿」共用純函式(V79.7.6,從 scripts/confcall_av_probe.py 搬出來;⛔ 第二份)

- 找連結:`links_of` / `is_transcript` / `is_nav`、季別 `yq_of` / `reported_q` / `prev_q`
- 切段:`split_qa_text`(簡報 / 問答)、`count_questions`、`sentences_of`
- 🎤 講者:`speaker_turns`(LSEG 那種「姓名, 公司 - 職稱」一行)→ `qa_units`(一位分析師開口到下一位之前 = 一題)

用的人:`confcall_qa.py`(作戰室「問答重點」採礦)、`scripts/confcall_av_probe.py`(量測)
⛔ 不連網、⛔ 不讀檔;`python3 lib_transcript.py --selftest`
"""
import re
import sys

ASK_RE = re.compile(r'請問|想請教|想問一下|問題是')


_CN_Q = {'一': 1, '二': 2, '三': 3, '四': 4, '1': 1, '2': 2, '3': 3, '4': 4}


def yq_of(s):
    """從連結文字 / 檔名抓「哪一年哪一季」:2Q25 / 2Q2025 / Q2 2025 / 2025Q2 / 2025/q2 / 2025年第二季 / 114年第2季 → (2025, 2);抓不到 None。"""
    t = (s or '').replace('%20', ' ').replace('+', ' ')
    pats = [(r'(?<![\dA-Za-z])([1-4])\s*Q\s*[\'’]?(\d{4}|\d{2})(?!\d)', lambda m: (m.group(2), m.group(1))),
            (r'(?<![A-Za-z])Q([1-4])[\s_\-/,]*[\'’]?(\d{4}|\d{2})(?!\d)', lambda m: (m.group(2), m.group(1))),
            (r'(?<!\d)(\d{4})\s*[-_ /]?\s*Q([1-4])(?!\d)', lambda m: (m.group(1), m.group(2))),
            (r'(?<!\d)(\d{4})\s*年\s*第\s*([1-4一二三四])\s*季', lambda m: (m.group(1), m.group(2))),
            (r'(?<!\d)(1[01]\d)\s*年\s*(?:度\s*)?第\s*([1-4一二三四])\s*季', lambda m: (str(int(m.group(1)) + 1911), m.group(2)))]
    for rx, get in pats:
        m = re.search(rx, t, re.I)
        if m:
            y, q = get(m)
            y = int(y) + (2000 if len(y) == 2 else 0)
            if 2005 <= y <= 2035:
                return (y, _CN_Q[q])
    return None


def reported_q(d):
    """法說會日期 → 多半在報告的那一季(1~3 月開的報上一年第 4 季)。"""
    y, m = int(d[:4]), int(d[5:7])
    return (y - 1, 4) if m <= 3 else (y, (m - 1) // 3)


def prev_q(yq):
    y, q = yq
    return (y, q - 1) if q > 1 else (y - 1, 4)


TRANS_RE = re.compile(r'transcript|逐字稿|會議實錄|会议实录|會議紀錄|會議記錄|问答纪录|問答紀錄|問答記錄', re.I)
NOT_TRANS_RE = re.compile(r'presentation|slides?\b|簡報|简报|financial\s+statements?|財報|webcast\s+replay', re.I)
DOC_RE = re.compile(r'\.pdf|\.docx?|download|file|attach', re.I)
NAV_RE = re.compile(r'法說|法人說明|投資人說明|investor\s*conference|quarterly\s*results|earnings|financial\s*results|季報|業績發表|營運報告', re.I)


def links_of(html, base):
    """頁面上的連結 [(絕對網址, 文字)];也收 JS 裡直接寫的 .pdf 網址(文字用檔名)。"""
    import html as H
    from urllib.parse import urljoin
    out, seen = [], set()
    for m in re.finditer(r'<a\b[^>]*?href\s*=\s*["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', html or '', re.S | re.I):
        u = urljoin(base, H.unescape(m.group(1)).strip())
        t = re.sub(r'\s+', ' ', H.unescape(re.sub(r'<[^>]+>', ' ', m.group(2)))).strip()
        if u not in seen and u.startswith('http'):
            seen.add(u)
            out.append((u, t))
    for m in re.finditer(r'["\']([^"\'\s<>]+?\.pdf)["\']', html or '', re.I):
        u = urljoin(base, H.unescape(m.group(1)))
        if u not in seen and u.startswith('http'):
            seen.add(u)
            out.append((u, u.rsplit('/', 1)[-1]))
    return out


def is_transcript(u, t):
    from urllib.parse import unquote
    blob = unquote(u) + ' ' + (t or '')
    return bool(TRANS_RE.search(blob)) and bool(DOC_RE.search(u)) and not (NOT_TRANS_RE.search(t or '') and not TRANS_RE.search(t or ''))


def is_nav(u, t, host):
    from urllib.parse import urlparse
    return urlparse(u).netloc == host and bool(NAV_RE.search((t or '') + ' ' + u))


QA_HDR_RE = re.compile(r'QUESTIONS?\s*(?:AND|&)\s*ANSWERS?|QUESTION[- ]AND[- ]ANSWER|Q\s*&\s*A\s*(?:SESSION|SECTION)|問答(?:時間|環節|階段|時段)|開放.{0,6}(?:提問|發問)|接下來.{0,6}(?:Q\s*&?\s*A|問答|提問)', re.I)


def split_qa_text(text, min_frac=0.15):
    """逐字稿全文 → (簡報那段, 問答那段, 問答從幾成開始);切不到回 None(⛔ 硬猜)。
    ⚠️ 目錄 / 主持人開場常先講一次「之後有 Q&A」→ 優先挑 min_frac 之後的第一個;都在前面才退回第一個。"""
    t = text or ''
    ms = list(QA_HDR_RE.finditer(t))
    if not ms or not t:
        return None
    m = next((x for x in ms if x.start() >= len(t) * min_frac), ms[0])
    return t[:m.start()], t[m.start():], round(m.start() / len(t), 3)


def count_questions(qa):
    """問答段大約幾個提問:官方逐字稿看「Q」那一行 / 「- 分析師」/ 主持人說「下一個問題」;中文看「請問」那類。取最大的那個。"""
    t = qa or ''
    a = len(re.findall(r'^\s*Q\s*[:：.]?\s*$|^\s*Q\s*[:：]', t, re.M))
    b = len(re.findall(r'\s[-–—]\s*(?:Analyst|分析師)\b', t))
    c = len(re.findall(r'(?i)\b(?:next|first|following|last)\s+question\b', t))
    d = len(ASK_RE.findall(t))
    return max(a, b, c, d)


def sentences_of(text):
    """切句:中文句號 / 問號 / 分號、英文「. 」後面接大寫、空行;⛔ 切小數點。"""
    t = re.sub(r'-\n(?=[a-z])', '', text or '')
    parts = re.split(r'(?<=[。？！；;?!])\s*|(?<=[a-z0-9%)])\.\s+(?=[A-Z“"(])|\n\s*\n', t)
    return [re.sub(r'\s+', ' ', x).strip() for x in parts if x and len(re.sub(r'\s', '', x)) >= 6]


# ───────────────────────── 🎤 講者 / 分題 ─────────────────────────
ROLE_RE = re.compile(r'Analyst|Director|Officer|\bCFO\b|\bCEO\b|\bCOO\b|Chairman|President|Vice|\bHead\b|Manager|Investor Relations|'
                     r'Research|Controller|Treasurer|Spokes|Executive|Partner|Strategist|Associate|\bIR\b', re.I)
_DASH = re.compile(r'\s[-–—]\s')
_INITIAL = re.compile(r"^(?:[A-Z]\.){1,3}$|^[A-Z]\.?$")
_SUFFIX = re.compile(r'^\s*(?:Inc\b|Ltd\b|LLC\b|L\.P\.|Limited\b|Co\b|Corp|S\.A\.|AG\b|plc\b|N\.A\.|Research Division\b|Securities\b)', re.I)


def _split_name(head):
    """「講者 + 機構」那一段 → (人名, 機構)。三種版面都收:
       「Gokul Hariharan, JPMorgan Chase & Co, Research Division」(逗號)/「Charlie Chan - Morgan Stanley」(破折號)/
       「Charlie Chan Morgan Stanley, Research Division」(只有空白 —— PDF 把粗體名字跟公司接在一起)。
    沒有分隔符號時人名 = 開頭的縮寫(C. C.)+ 1 個字,或開頭 2 個字(⚠️ 3 個字的名字會多一個字進機構 → 機構那邊再修)。"""
    parts = [x.strip() for x in _DASH.split(head) if x.strip()]
    if len(parts) > 1:
        return parts[0], ' - '.join(parts[1:])
    if ',' in head:
        a, b = head.split(',', 1)
        if not _SUFFIX.match(b) and len(a.split()) <= 4:
            return a.strip(), b.strip()
    toks = head.split()
    k = 0
    while k < len(toks) and _INITIAL.match(toks[k]):
        k += 1
    n = k + 1 if k else 2
    return ' '.join(toks[:n]), ' '.join(toks[n:])


def parse_label(line):
    """一行像不像講者標籤 → {'who','org','role'} 或 None。
    「Gokul Hariharan, JPMorgan Chase & Co, Research Division - Analyst [3]」「Jeff Su - TSMC - Director of IR」
    「Charlie Chan Morgan Stanley, Research Division - Analyst」「Operator」都收。
    ⚠️ 句子裡也會有「 - 」→ 最後一段要是職稱(ROLE_RE)、⛔ 句點結尾、⛔ 太長、前段小寫開頭的字 ≤ 兩成(句子一堆小寫字)才算。"""
    t = re.sub(r'\s*\[\d+\]\s*$', '', (line or '').strip())
    if re.fullmatch(r'Operator', t, re.I):
        return {'who': 'Operator', 'org': '', 'role': 'Operator'}
    if not t or len(t) > 190 or t.endswith(('.', '。', '?', '？', ',', ':', '：')) or not re.match(r'[A-Z]', t):
        return None
    segs = _DASH.split(t)
    if len(segs) < 2:
        return None
    role = segs[-1].strip()
    head = t[:len(t) - len(segs[-1])].rstrip(' -–—')
    if not role or len(role) > 80 or not ROLE_RE.search(role) or '?' in t:
        return None
    words = [w for w in re.split(r'[\s,&/]+', head) if re.match(r'[A-Za-z]', w)]
    if not words or len(words) > 14 or sum(1 for w in words if w[0].islower()) > max(1, len(words) // 5):
        return None
    who, org = _split_name(head)
    return {'who': who, 'org': org, 'role': role}


def speaker_turns(text, co_re=None):
    """全文 → [{who, org, role, side, text}];side = 'co'(公司的人)/ 'an'(分析師 / 外部)/ 'op'(主持系統)。
    co_re:公司名稱(例 r'Taiwan Semiconductor|TSMC');沒給就看職稱(Analyst = 外部)。"""
    co = re.compile(co_re, re.I) if co_re else None
    turns, cur = [], None
    for ln in (text or '').splitlines():
        lab = parse_label(ln)
        if lab:
            if lab['role'] == 'Operator':
                side = 'op'
            elif re.search(r'Analyst', lab['role'], re.I):
                side = 'an'
            elif co is not None:
                side = 'co' if co.search(lab['who'] + ' ' + lab['org'] + ' ' + lab['role']) else 'an'
            else:
                side = 'co'
            cur = dict(lab, side=side, text='')
            turns.append(cur)
            continue
        if cur is not None and ln.strip():
            cur['text'] += ln.strip() + ' '
    for t in turns:
        t['text'] = re.sub(r'\s+', ' ', t['text']).strip()
    return [t for t in turns if t['text'] or t['side'] == 'op']


def qa_units(turns):
    """問答段的講者 → 一題一題:一位分析師開口到「另一位分析師」開口之前(同一位追問算同一題;主持人轉述 / 公司回答都算在裡面)。
    回 [{'who','org','turns':[…]}];第一位分析師之前的開場 ⛔ 算。"""
    units, cur = [], None
    for t in turns or []:
        if t['side'] == 'an':
            if cur is None or t['who'] != cur['who']:
                cur = {'who': t['who'], 'org': t['org'], 'turns': []}
                units.append(cur)
        if cur is not None and t['side'] != 'op':
            cur['turns'].append(t)
    return [u for u in units if any(x['side'] == 'co' for x in u['turns'])]


def unit_text(u, co_name='公司'):
    """一題 → 給 AI 看的文字(每一段標「分析師(機構)」或「公司(職稱)」);⛔ 放人名(分析師)。"""
    out = []
    for t in u['turns']:
        if t['side'] == 'an':
            out.append(f"[分析師({t['org'] or '外部'})] {t['text']}")
        else:
            out.append(f"[{co_name}({t['role']})] {t['text']}")
    return '\n'.join(out)


def selftest():
    ok = fail = 0

    def chk(name, cond):
        nonlocal ok, fail
        if cond:
            ok += 1
            print(f'✅ {name}')
        else:
            fail += 1
            print(f'❌ {name}')

    chk('① yq_of:2Q25 / Q2 2025 / 2025Q2 / 2025/q2 / 2025年第二季 / 114年第2季 / 抓不到 None',
        yq_of('TSMC 2Q25 Transcript.pdf') == (2025, 2) and yq_of('Q2 2025 Earnings Call') == (2025, 2)
        and yq_of('UMC_2025Q2_transcript.pdf') == (2025, 2) and yq_of('/quarterly-results/2025/q2') == (2025, 2)
        and yq_of('2025年第二季法說會逐字稿') == (2025, 2) and yq_of('114年第2季') == (2025, 2)
        and yq_of('TSMC%203Q20%20transcript_0.pdf') == (2020, 3) and yq_of('annual report') is None)
    chk('② reported_q:1~3 月開的報上一年第 4 季;7 月報第 2 季;prev_q 跨年',
        reported_q('2026-01-15') == (2025, 4) and reported_q('2025-07-17') == (2025, 2) and prev_q((2026, 1)) == (2025, 4))
    html_fx = ('<a href="/english/encrypt/files/x/TSMC%202Q25%20Transcript.pdf">Transcript</a>'
               '<a href="/english/encrypt/files/x/TSMC%202Q25%20Presentation.pdf">Presentation</a>'
               '<a href="https://ir.x.com/c/events.php">法人說明會</a><a href="https://other.com/q">earnings</a>'
               '<script>var f="https://ir.x.com/files/2025Q1_逐字稿.pdf";</script>')
    L = links_of(html_fx, 'https://ir.x.com/c/index.php')
    tr = [u for u, t in L if is_transcript(u, t)]
    chk('③ 逐字稿連結:Transcript 收、Presentation ⛔ 收、JS 裡的 .pdf 也收;同主機法說會頁當下一層',
        len(tr) == 2 and all('Presentation' not in u for u in tr) and [u for u, t in L if is_nav(u, t, 'ir.x.com')] == ['https://ir.x.com/c/events.php'])
    fx = ('PRESENTATION\nJeff Su - Taiwan Semiconductor Manufacturing Co Ltd - Director of IR\n'
          'Good afternoon. Today we will cover the outlook. The Q&A session will follow.\n'
          'Wendell Huang - Taiwan Semiconductor Manufacturing Co Ltd - CFO\nRevenue was US$30.1 billion. Gross margin was 59.5%.\n'
          'QUESTIONS AND ANSWERS\nOperator\nThe first question is from Gokul Hariharan.\n'
          'Gokul Hariharan, JPMorgan Chase & Co, Research Division - Analyst\nWhat about 2026 capex?\n'
          'C.C. Wei - Taiwan Semiconductor Manufacturing Co Ltd - Chairman & CEO\nWe expect capex of US$42.5 billion.\n'
          'Gokul Hariharan, JPMorgan Chase & Co, Research Division - Analyst\nOne follow-up on margin.\n'
          'Wendell Huang - Taiwan Semiconductor Manufacturing Co Ltd - CFO\nLong-term gross margin is 56% and higher.\n'
          'Operator\nNext question is from Charlie Chan.\n'
          'Charlie Chan - Morgan Stanley - Analyst\nOn N2 ramp - how fast?\n'
          'Jeff Su - Taiwan Semiconductor Manufacturing Co Ltd - Director of IR\nSo Charlie wants to know about N2.\n'
          'C.C. Wei - Taiwan Semiconductor Manufacturing Co Ltd - Chairman & CEO\nN2 is ramping well.\n')
    sp = split_qa_text(fx)
    chk('④ split_qa_text:開場那句「Q&A session」⛔ 當開始(挑 15% 之後那個 QUESTIONS AND ANSWERS)',
        sp is not None and sp[1].startswith('QUESTIONS AND ANSWERS'))
    tv = speaker_turns(sp[1], r'Taiwan Semiconductor|TSMC')
    sides = [t['side'] for t in tv]
    chk('⑤ speaker_turns:分析師 / 公司 / 主持系統分得出來;句子裡的「 - 」⛔ 當標籤;機構名抓得到',
        sides == ['op', 'an', 'co', 'an', 'co', 'op', 'an', 'co', 'co'] and tv[1]['org'].startswith('JPMorgan')
        and tv[6]['org'] == 'Morgan Stanley' and 'N2 ramp - how fast' in tv[6]['text'])
    us = qa_units(tv)
    chk('⑥ qa_units:同一位分析師追問算同一題、主持人轉述算在那一題裡、開場 ⛔ 算 → 2 題',
        len(us) == 2 and us[0]['org'].startswith('JPMorgan') and len(us[0]['turns']) == 4 and len(us[1]['turns']) == 3)
    txt = unit_text(us[1], '台積電')
    chk('⑦ unit_text:分析師只留機構名(⛔ 人名)', 'Charlie' not in txt.split('\n')[0] and '[分析師(Morgan Stanley)]' in txt and '[台積電(Chairman & CEO)]' in txt)
    chk('⑧ parse_label:一般句子(結尾句點 / 太長 / 職稱認不得)⛔ 當標籤',
        parse_label('We expect revenue - in US dollar - to grow.') is None and parse_label('Apple - Nvidia - AMD') is None
        and parse_label('Operator') == {'who': 'Operator', 'org': '', 'role': 'Operator'}
        and parse_label('So the question is about pricing and we think it is fine - Director') is None)
    a = parse_label('Charlie Chan Morgan Stanley, Research Division - Analyst [4]')
    b = parse_label('Jeff Su Taiwan Semiconductor Manufacturing Co Ltd - Director of IR')
    c = parse_label('C. C. Wei Taiwan Semiconductor Manufacturing Co Ltd - Chairman & CEO')
    e = parse_label('Gokul Hariharan JPMorgan Chase & Co, Research Division - Head of Taiwan Research')
    f = parse_label('Bruce Lu Goldman Sachs Group, Inc., Research Division - Analyst')
    chk('⑩ parse_label:PDF 把名字跟公司接在一起(只有空白)也拆得開;[n] 拿掉;縮寫名字(C. C. Wei)',
        a == {'who': 'Charlie Chan', 'org': 'Morgan Stanley, Research Division', 'role': 'Analyst'}
        and b and b['who'] == 'Jeff Su' and b['org'].startswith('Taiwan Semiconductor') and b['role'] == 'Director of IR'
        and c and c['who'] == 'C. C. Wei' and e and e['who'] == 'Gokul Hariharan' and e['org'].startswith('JPMorgan')
        and f and f['who'] == 'Bruce Lu' and f['org'].startswith('Goldman Sachs'))
    fx2 = ('QUESTIONS AND ANSWERS\nOperator [1]\nFirst question please.\n'
           'Gokul Hariharan JPMorgan Chase & Co, Research Division - Head of Taiwan Research [2]\nWhat about capex?\n'
           'C. C. Wei Taiwan Semiconductor Manufacturing Co Ltd - Chairman & CEO [3]\nCapex will grow.\n'
           'Charlie Chan Morgan Stanley, Research Division - Analyst [4]\nN2 ramp?\n'
           'Jeff Su Taiwan Semiconductor Manufacturing Co Ltd - Director of IR [5]\nCharlie asks about N2.\n'
           'C. C. Wei Taiwan Semiconductor Manufacturing Co Ltd - Chairman & CEO [6]\nN2 is fine.\n')
    tv2 = speaker_turns(fx2, r'Taiwan Semiconductor|TSMC')
    chk('⑪ 沒有逗號的版面:分析師(職稱寫 Head of … Research)/ 公司 / 主持系統照樣分得出來 → 2 題',
        [t['side'] for t in tv2] == ['op', 'an', 'co', 'an', 'co', 'co'] and len(qa_units(tv2)) == 2)
    chk('⑨ count_questions:分析師那一行 / 「Q」那一行 / 中文「請問」取最大',
        count_questions(sp[1]) == 3 and count_questions('Q:\nA:\nQ:\nA:\nQ:\n') == 3
        and count_questions('請問毛利 想請教資本支出') == 2)
    print(f'\n{"✅ 全部通過" if not fail else f"❌ {fail} 條失敗"}({ok} 條)')
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else 0)
