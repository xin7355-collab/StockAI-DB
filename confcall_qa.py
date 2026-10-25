#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🎤 confcall_qa.py —— 法說會「問答重點」(V79.7.6,先只有台積電)

🎯 為什麼要有這一支(使用者 2026-10-25):「我要台積電的」→ 選「最近 4 季」+「放進產業作戰室法說會頁」。
   上一輪量測(confcall_av_probe qa 模式)查過:市值前 100 名只有台積電有完整問答的官方英文逐字稿,
   一場 15~36 題、問答佔全文七成 —— 簡報上沒有的東西大多在問答裡。
   ⚠️ 研究那一關沒過(一年只有約 4 份、不夠回測)→ 這是**閱讀區**,⛔ 不進任何判斷 / 計分 / 推播。

📐 做法:
   ① 算出最近 4 季 → 已經整理過的季 ⛔ 重抓(冪等;有幾題 AI 沒回的,之後最多再補 RETRY_MAX 次)
   ② 季度頁(investor.tsmc.com/english/quarterly-results/YYYY/qN)找逐字稿 PDF 連結 → 下載(confcall_deck.Fetcher:
      間隔 / 退避 / 續傳 / 只收 %PDF-)→ 抽字(confcall_deck.extract_safe,子程序 + 時限)
   ③ 切問答(lib_transcript.split_qa_text)→ 講者(speaker_turns)→ 一題一題(qa_units)
      守門:認到的題目 < 3 或公司回答 < 3 → 那一季 ⛔ 發佈,原因寫進 todo(版面變了要看得出來)
   ④ 每一題一次 Groq:分類(固定清單)+ 分析師問什麼 + 公司怎麼答(繁中)
      ⭐ 數字核對(confcall_deck.num_gate):AI 寫的數字在這一題原文找不到 → 那一句整句丟掉、記 drop
      ⭐ 只寫機構名(⛔ 分析師人名)、⛔ 英文原句(中文要過半;一串 6 個英文字以上整句丟掉)
   ⑤ 產物 data/cc_qa/{sym}.json(留 KEEP_Q 季;App 顯示 4 季)

⛔ 不可改掉的設計:
   ① 逐字稿版權屬 LSEG → **只存本站 AI 寫的中文摘要 + 原文連結**,⛔ 存 / 印任何英文原句(log 也一樣:只印機構 / 職稱 / 統計)
   ② ⛔ 評論 / 利多利空 / 買賣建議(提示詞明寫;畫面再寫一次)
   ③ 讀不到 ≠ 沒有問答:每一季抓不到 / 解析不了的原因寫進 todo,畫面照實講
   ④ 進入點放檔尾(陷阱 #9)
"""
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import lib_transcript as LT

DATA = Path(os.getenv('DATA_DIR', 'data'))
OUT_DIR = DATA / 'cc_qa'
SHOW_Q = int(os.getenv('QA_QUARTERS') or 4)          # 🔧 inputs.* 空字串 → `or 預設`(check_env_default)
KEEP_Q = 8
AI_MAX = int(os.getenv('QA_AI_MAX') or 160)          # 一輪最多叫幾次 AI(一季約 15~36 題)
BUDGET_MIN = float(os.getenv('QA_BUDGET_MIN') or 20)
DRY = (os.getenv('QA_DRY') or '').strip().lower() in ('1', 'true', 'yes')
RETRY_MAX = 3                                         # 有幾題 AI 沒回的那一季,之後最多再補幾輪
UNIT_MAX = 9000                                       # 一題餵給 AI 的原文最多幾個字(10/25 實測台積電一位分析師問兩件事、2.5~7.6 千字;太長的截掉)
AI_DEADLINE = 45                                      # 一題最多花幾秒在 AI 上(換金鑰 / 換模型都算)
MAX_TOKENS = 1000
PAGE_PACE = 3.0

COMPANIES = {
    '2330': {'name': '台積電', 'co_re': r'Taiwan Semiconductor|TSMC',
             'pages': ['https://investor.tsmc.com/english/quarterly-results/{y}/q{q}',
                       'https://investor.tsmc.com/chinese/quarterly-results/{y}/q{q}']},
}

TAGS = ['營收展望', '毛利率', '資本支出', 'AI 需求', '先進製程', '先進封裝', '海外廠', '價格', '匯率', '關稅與地緣', '長期目標', '股利', '其他']
_TAG_ALIAS = {'AI需求': 'AI 需求', '營收': '營收展望', '展望': '營收展望', '製程': '先進製程', '封裝': '先進封裝',
              '海外': '海外廠', '關稅': '關稅與地緣', '地緣政治': '關稅與地緣', '資本支出(capex)': '資本支出'}

UA = {'User-Agent': 'Mozilla/5.0 confcall_qa/1.0', 'Accept': 'text/html,application/xhtml+xml,*/*'}


# ───────────────────────── 純函式 ─────────────────────────
def yq_key(yq):
    return f'{yq[0]}Q{yq[1]}'


def target_quarters(today, n=SHOW_Q):
    """今天看得到的最近 n 季(最新那季的法說會可能還沒開 → 抓不到就寫 todo,⛔ 當錯)。"""
    yq = LT.reported_q(today)
    out = [yq]
    while len(out) < n:
        out.append(LT.prev_q(out[-1]))
    return out


_MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']
_DATE_RE = re.compile(r'\b(' + '|'.join(_MONTHS) + r')\s+(\d{1,2}),?\s+(20\d\d)\b', re.I)


def call_date(text, hist, yq):
    """這一季法說會哪天開:先看逐字稿第一頁的日期(EVENT DATE / OCTOBER 15, 2026),再看場次表;
    ⛔ 對不上那一季(reported_q 不同)就不收。抓不到回 None。"""
    for m in _DATE_RE.finditer((text or '')[:4000]):
        try:
            d = date(int(m.group(3)), _MONTHS.index(m.group(1).upper()) + 1, int(m.group(2))).isoformat()
        except ValueError:
            continue
        if LT.reported_q(d) == tuple(yq):
            return d
    ds = sorted(d for d in (hist or []) if isinstance(d, str) and len(d) >= 10 and LT.reported_q(d) == tuple(yq)
                and int(d[5:7]) in (1, 4, 7, 10))
    return ds[0] if ds else None


def find_transcript(html, base, yq):
    """季度頁上的逐字稿連結;季別對得上的優先,沒有季別的只有一個時才收(⛔ 猜)。"""
    cand = [(u, t) for u, t in LT.links_of(html, base) if LT.is_transcript(u, t)]
    hit = [u for u, t in cand if (LT.yq_of(t) or LT.yq_of(u)) == tuple(yq)]
    if hit:
        return hit[0]
    loose = [u for u, t in cand if not (LT.yq_of(t) or LT.yq_of(u))]
    return loose[0] if len(loose) == 1 and len(cand) == 1 else None


# 常見券商 / 研究機構:機構那一段開頭夾到人名的一個字(3 個字的名字、PDF 名字跟公司接在一起)時,從這裡切
_BROKER_RE = re.compile(r'Morgan Stanley|J\.?\s?P\.?\s?Morgan|JPMorgan|Goldman Sachs|\bUBS\b|Citigroup|\bCiti\b|Bernstein|Barclays|\bHSBC\b|'
                        r'Macquarie|Daiwa|Nomura|Credit Suisse|Arete|Jefferies|\bBofA\b|Bank of America|Merrill|Mizuho|\bCLSA\b|Deutsche|'
                        r'Fubon|Yuanta|\bKGI\b|Cathay|SinoPac|Mirae|Haitong|Morningstar|Needham|Evercore|\bCICC\b|Huatai|Aletheia|'
                        r'Redburn|New Street|\bBNP\b|Natixis|Masterlink|Samsung|Maybank|\bCGS\b|China Renaissance|Capital Securities')


def short_org(org):
    """「JPMorgan Chase & Co, Research Division」→「JPMorgan Chase」;⛔ 人名(這裡只收機構那一段)。"""
    m = _BROKER_RE.search(org or '')
    if m and 0 < m.start() <= 25:
        org = org[m.start():]
    t = re.sub(r',?\s*Research Division\b.*$', '', org or '', flags=re.I).strip(' ,-–—')
    t = re.sub(r'(?:,?\s*(?:&\s*Company|&\s*Co\.?|Inc\.?|Ltd\.?|LLLP|LLP|LLC|L\.L\.C\.|Limited|Co\.,?|Corporation|Corp\.?|plc|AG|S\.A\.|N\.A\.|Group|Holdings))+\s*$', '', t, flags=re.I)
    t = t.strip(' ,-–—')
    return (t or '外部')[:40]


def role_zh(role):
    r = role or ''
    if re.search(r'Chairman', r, re.I):
        return '董事長'
    if re.search(r'\bCFO\b|Financial Officer', r, re.I):
        return '財務長'
    if re.search(r'\bCEO\b|President|Executive Officer', r, re.I):
        return '總裁'
    if re.search(r'Investor Relations|\bIR\b|Spokes', r, re.I):
        return '發言人'
    return '公司'


def by_of(unit):
    """這一題主要是誰答的(⛔ 算主持人 / 發言人轉述;只有發言人答的就寫發言人)。"""
    rs = [role_zh(t['role']) for t in unit['turns'] if t['side'] == 'co']
    main = [r for r in rs if r != '發言人']
    return (main or rs or ['公司'])[0]


_CJK = re.compile(r'[一-鿿]')
_LAT = re.compile(r'[A-Za-z]')
_EN_RUN = re.compile(r"(?:[A-Za-z][A-Za-z'’\-]*[\s,]+){5,}[A-Za-z]")
_DIR_RE = re.compile(r'利多|利空|建議(?:買|賣)|買進|賣出|加碼|減碼|逢低|追高')     # 買賣字眼(⛔ 給方向)→ 那一句丟掉


def zh_ok(s):
    """中文為主:中文字 ≥4 而且佔(中文 + 英文字母)過半;一串 6 個英文字以上 = 原句漏出來 → ⛔。"""
    c, l = len(_CJK.findall(s or '')), len(_LAT.findall(s or ''))
    return c >= 4 and c / max(1, c + l) >= 0.5 and not _EN_RUN.search(s or '')


def norm_tag(t):
    t = re.sub(r'\s+', ' ', str(t or '')).strip()
    if t in TAGS:
        return t
    t2 = t.replace(' ', '')
    for k in TAGS:
        if k.replace(' ', '') == t2:
            return k
    return _TAG_ALIAS.get(t2, '其他')


def _cap(s, n):
    s = re.sub(r'\s+', ' ', s or '').strip()
    return s if len(s) <= n else s[:n - 1].rstrip() + '…'


def scrub_names(s, names):
    for nm in sorted({x for x in names if x and len(x) >= 3}, key=len, reverse=True):
        s = re.sub(re.escape(nm), '分析師', s)
    return s


def gate_items(ai, src, names=()):
    """AI 回的 items → (留下的, 數字對不上丟幾句, 不是中文丟幾句)。
    ⭐ 數字核對對這一題的原文(confcall_deck.num_gate:整個數字比對);人名換成「分析師」。"""
    import confcall_deck as cd
    items = (ai or {}).get('items') if isinstance(ai, dict) else None
    if isinstance(ai, dict) and items is None and ai.get('q'):
        items = [ai]
    keep, d_num, d_lang = [], 0, 0
    for it in (items or [])[:3]:
        if not isinstance(it, dict):
            continue
        q = scrub_names(str(it.get('q') or ''), names)
        a = scrub_names(str(it.get('a') or ''), names)
        if not q.strip() or not a.strip():
            continue
        if cd.num_gate(q + ' ' + a, src):
            d_num += 1
            continue
        if not (zh_ok(q) and zh_ok(a)) or _DIR_RE.search(q + a):
            d_lang += 1
            continue
        keep.append({'tag': norm_tag(it.get('tag')), 'q': _cap(q, 60), 'a': _cap(a, 150)})
    return keep, d_num, d_lang


def ai_prompt(name, utext):
    src = utext[:UNIT_MAX]
    sys_msg = ('你是法說會問答的整理員。只能根據使用者給的這一題問答,整理成繁體中文。'
               '⛔ 不可以加原文沒有的數字;⛔ 不可以換算單位或幣別(原文 US$60 billion 就寫「60 billion 美元」,⛔ 寫成 600 億);'
               '⛔ 不評論、⛔ 不判斷利多利空、⛔ 不給買賣建議、⛔ 不寫任何人名(問的人一律寫「分析師」);'
               '⛔ 不可以照抄英文句子(產品 / 技術名稱如 N2、CoWoS、HPC 可以保留)。輸出純 JSON(不要 markdown)。')
    user = (f'{name}法說會問答的其中一題([ ]裡是身分;分析師可能一次問兩件事):\n{src}\n\n'
            '輸出 JSON:{"items":[{"tag":"從這些挑一個:' + ' / '.join(TAGS) + '",'
            '"q":"分析師問什麼(40 字內)","a":"公司怎麼答(90 字內,只寫公司講的內容)"}]},'
            '一件事一個 item、最多 3 個;公司沒有正面回答就照實寫「沒有正面回答」。')
    return sys_msg, user, src


def parse_call(text, co_re):
    """逐字稿全文 → {'units','an','co','qa_at'} 或 {'err': 原因}(⛔ 硬猜)。"""
    sp = LT.split_qa_text(text)
    if not sp:
        return {'err': '切不到問答段'}
    turns = LT.speaker_turns(sp[1], co_re)
    units = LT.qa_units(turns)
    an = sum(1 for t in turns if t['side'] == 'an')
    co = sum(1 for t in turns if t['side'] == 'co')
    if len(units) < 3 or co < 3:
        return {'err': f'講者認不出來(題目 {len(units)}・分析師發言 {an}・公司回答 {co})', 'an': an, 'co': co, 'units': units}
    return {'units': units, 'an': an, 'co': co, 'qa_at': sp[2]}


def shape_lines(text, n=15):
    """🔍 解析不了時印「版面長相」給人看:像講者標籤的那幾行,⛔ 印人名與內文 —— 只印逗號 / 破折號後面那段(機構 / 職稱)。"""
    sp = LT.split_qa_text(text)
    qa = sp[1] if sp else (text or '')
    out = []
    lines = qa.splitlines()
    for i, ln in enumerate(lines):
        s = ln.strip()
        if len(s) > 190 or not re.search(r'Analyst|Officer|\bCFO\b|\bCEO\b|Director|Chairman|Operator', s, re.I):
            continue
        m = re.search(r'(?:,|\s[-–—]\s)(.*)$', s)
        tail = m.group(1).strip() if m else ('Operator' if re.fullmatch(r'Operator.*', s, re.I) else '(只有職稱字樣)')
        out.append(f'前一行 {len(lines[i - 1].strip()) if i else 0} 字 ・本行 {len(s)} 字 ・…{tail[:80]}')
        if len(out) >= n:
            break
    return out


# ───────────────────────── AI ─────────────────────────
class AI:
    """一題一次 Groq(照 confcall_deck.groq_summarize:429 換下一把、404 換模型最多 3 次;一題有時限)。"""

    def __init__(self, keys, poster=None, picker=None, clock=time.time, sleeper=time.sleep, budget=AI_MAX):
        self.keys = list(keys or [])
        self.post = poster
        self.pick = picker
        self.clock, self.sleep = clock, sleeper
        self.budget = budget
        self.calls = self.ok = self.fail = 0
        self.model = None
        self.tried = set()
        self.ki = 0
        self.dead = False

    def ask(self, sys_msg, user):
        """回 (ai dict|None, 原因)。"""
        if not self.keys:
            return None, 'no_key'
        if self.calls >= self.budget:
            return None, 'budget'
        if self.dead:
            return None, 'dead'
        from groq_common import groq_model, groq_apply, invalidate
        pick = self.pick or (lambda keys, avoid: groq_model(keys, 'light', avoid=avoid))
        if self.post is None:
            import requests
            self.post = lambda **kw: requests.post(**kw)
        self.calls += 1
        payload = {'model': None, 'messages': [{'role': 'system', 'content': sys_msg}, {'role': 'user', 'content': user}],
                   'temperature': 0.2, 'max_tokens': MAX_TOKENS}
        t0 = self.clock()
        why = 'fail'
        for _ in range(len(self.keys) * 2):
            if self.clock() - t0 > AI_DEADLINE:
                why = 'timeout'
                break
            key = self.keys[self.ki % len(self.keys)]
            self.ki += 1
            try:
                if not self.model:
                    self.model = pick(self.keys, self.tried)
                groq_apply(payload, self.model, MAX_TOKENS)
                r = self.post(url='https://api.groq.com/openai/v1/chat/completions', json=payload,
                              headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, timeout=40)
                if r.status_code == 404 and len(self.tried) < 3:
                    self.tried.add(self.model)
                    invalidate('light', self.model)
                    self.model = None
                    why = 'HTTP 404'
                    continue
                if r.status_code == 429:
                    why = 'HTTP 429'
                    self.sleep(1.0)
                    continue
                if r.status_code != 200:
                    why = f'HTTP {r.status_code}'
                    continue
                import confcall_deck as cd
                txt = (r.json().get('choices') or [{}])[0].get('message', {}).get('content', '') or ''
                ai = cd.parse_ai_json(txt)
                if not ai:
                    self.fail += 1
                    return None, 'bad_json'
                self.ok += 1
                return ai, ''
            except Exception as e:                              # noqa: BLE001 —— 換下一把
                why = type(e).__name__
                continue
        self.fail += 1
        if self.fail >= 6 and self.ok == 0:
            self.dead = True                                    # 連 6 題都沒回 → 這一輪不再叫(⛔ 白等)
        return None, why


# ───────────────────────── 一季 ─────────────────────────
def do_quarter(sym, cfg, yq, prev, fetch_page, fetcher, ai, hist, log, deadline, extract=None):
    """回 (rec|None, todo|None)。rec = 這一季的產物;todo = {'yq','why'}(抓不到 / 解析不了 / 還沒開)。"""
    import confcall_deck as cd
    extract = extract or cd.extract_safe
    key = yq_key(yq)
    url = (prev or {}).get('url')
    if not url:
        for tpl in cfg['pages']:
            pu = tpl.format(y=yq[0], q=yq[1])
            code, html = fetch_page(pu)
            if code != 200 or not html:
                log(f'   🔎 {key} 季度頁 {pu.split("/")[3]} → {code}')
                continue
            url = find_transcript(html, pu, yq)
            if url:
                break
        if not url:
            return None, {'yq': key, 'why': '季度頁上還沒有逐字稿(法說會還沒開,或官方還沒放上來)'}
    b, err = fetcher.get(url)
    if b is None:
        return None, {'yq': key, 'why': f'逐字稿下載不到({str(err)[:60]})', 'url': url}
    pages, err = extract(b)
    if not pages:
        return None, {'yq': key, 'why': f'逐字稿抽不出字({err})', 'url': url}
    text = '\n'.join(pages)
    pc = parse_call(text, cfg['co_re'])
    d = call_date(text, hist, yq)
    if pc.get('err'):
        log(f'   ⛔ {key} {pc["err"]} → 這一季⛔ 發佈;版面長相(只印職稱那段):')
        for s in shape_lines(text):
            log(f'      {s}')
        return None, {'yq': key, 'why': pc['err'], 'url': url}
    units = pc['units']
    log(f'   📄 {key} {len(pages)} 頁 ・問答從 {pc["qa_at"]:.0%} 開始 ・{len(units)} 題(分析師發言 {pc["an"]}・公司回答 {pc["co"]})'
        f' ・法說會 {d or "日期不明"}')
    names = set()
    for u in units:
        for t in u['turns']:
            if t['side'] == 'an' and t.get('who'):
                names.add(t['who'])
                names.update(p for p in re.split(r'\s+', t['who']) if len(p) >= 3)
    old = {it.get('i'): it for it in ((prev or {}).get('items') or [])}
    done_i = {i for i in old}
    items = list((prev or {}).get('items') or [])
    drop = int((prev or {}).get('drop') or 0)
    lang = int((prev or {}).get('lang') or 0)
    miss = []
    if DRY:
        for i, u in enumerate(units[:8]):
            log(f'      第 {i + 1} 題 ・{short_org(u["org"])} ・{by_of(u)}答 ・{len(u["turns"])} 段 ・{len(LT.unit_text(u))} 字')
        return None, {'yq': key, 'why': 'dry'}
    for i, u in enumerate(units):
        if i in done_i:
            continue
        if time.time() > deadline:
            miss.append(i)
            continue
        sys_msg, user, src = ai_prompt(cfg['name'], LT.unit_text(u, cfg['name']))
        res, why = ai.ask(sys_msg, user)
        if res is None:
            miss.append(i)
            continue
        keep, dn, dl = gate_items(res, src, names)
        drop += dn
        lang += dl
        org, by = short_org(u['org']), by_of(u)
        for k, it in enumerate(keep):
            items.append({'i': i, 'k': k, 'tag': it['tag'], 'org': org, 'by': by, 'q': it['q'], 'a': it['a']})
        if not keep:
            items.append({'i': i, 'k': 0, 'skip': 1})          # 那一題整句被丟光 → 記下來(⛔ 下一輪重叫同一題)
    items.sort(key=lambda x: (x['i'], x.get('k', 0)))
    rec = {'yq': key, 'y': yq[0], 'q': yq[1], 'd': d, 'url': url, 'q_n': len(units), 'items': items,
           'drop': drop, 'lang': lang, 'miss': len(miss), 'model': ai.model,
           'parse': {'an': pc['an'], 'co': pc['co']}, 'at': date.today().isoformat(),
           'tries': int((prev or {}).get('tries') or 0) + 1}
    shown = sum(1 for x in items if not x.get('skip'))
    log(f'   ✅ {key} 整理 {shown} 句(數字對不上丟 {drop}・不是中文丟 {lang}・AI 沒回 {len(miss)} 題)')
    return rec, None


def _need(prev):
    """已經有的那一季要不要再做:AI 沒回的題目還有、而且補不到 RETRY_MAX 次。"""
    if not prev:
        return True
    return int(prev.get('miss') or 0) > 0 and int(prev.get('tries') or 0) < RETRY_MAX


def _today():
    return datetime.now(timezone(timedelta(hours=8))).date().isoformat()


def run(fetch_page=None, fetcher=None, ai=None, today=None, log=print, extract=None, syms=None):
    """正式入口。回 rc(0 = 正常;1 = 這一輪有要做的季卻全部解析不了 / 舊檔讀壞了)。"""
    import confcall_deck as cd
    from lib_jsonsafe import load_json_safe
    today = today or _today()
    deadline = time.time() + BUDGET_MIN * 60
    fetch_page = fetch_page or _http_page
    fetcher = fetcher or cd.Fetcher(pace=PAGE_PACE)
    ai = ai or AI(_keys())
    hist_all = {}
    cj, _st, _m = load_json_safe(DATA / 'confcall.json', {}, log=log, what='confcall.json')
    if isinstance(cj, dict):
        hist_all = cj.get('hist') or {}
    rc = 0
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for sym in syms or list(COMPANIES):
        cfg = COMPANIES[sym]
        path = OUT_DIR / f'{sym}.json'
        cur, st, msg = load_json_safe(path, {}, log=log, what=str(path))
        if st == 'corrupt':
            log(f'❌ {sym} 舊檔讀壞了 → ⛔ 覆蓋(手動查)')
            rc = 1
            continue
        cur = cur if isinstance(cur, dict) else {}
        have = {x.get('yq'): x for x in (cur.get('quarters') or []) if isinstance(x, dict)}
        targets = target_quarters(today)
        log(f'🎤 {sym} {cfg["name"]}:最近 {len(targets)} 季 {", ".join(yq_key(x) for x in targets)}'
            f' ・已經整理過 {sum(1 for x in targets if yq_key(x) in have)} 季')
        todo, tried, got, parse_bad = [], 0, 0, 0
        for yq in targets:
            prev = have.get(yq_key(yq))
            if not _need(prev) and not DRY:
                continue
            tried += 1
            rec, td = do_quarter(sym, cfg, yq, prev if not DRY else None, fetch_page, fetcher, ai,
                                 hist_all.get(sym), log, deadline, extract)
            if rec:
                have[rec['yq']] = rec
                got += 1
            elif td and td.get('why') != 'dry':
                todo.append(td)
                if '講者認不出來' in td['why'] or '切不到問答' in td['why']:
                    parse_bad += 1
                    got += 1
        if DRY:
            log('🧪 dry:只印解析統計,⛔ 叫 AI、⛔ 寫檔')
            continue
        qs = sorted(have.values(), key=lambda x: (x.get('y') or 0, x.get('q') or 0), reverse=True)[:KEEP_Q]
        out = {'sym': sym, 'name': cfg['name'], 'updated': datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M'),
               'src': '公司官方法說會逐字稿(英文,版權屬原作者;本站只存 AI 整理的中文重點 + 原文連結)',
               'tags': TAGS, 'show': SHOW_Q, 'quarters': qs, 'todo': todo,
               'ai': {'calls': ai.calls, 'ok': ai.ok, 'fail': ai.fail}}
        if qs or todo:
            cd._save_json(path, out)
            log(f'💾 {path}:{len(qs)} 季 ・還沒有的 {len(todo)} 季'
                + ''.join(f'\n   ⏳ {t["yq"]}:{t["why"]}' for t in todo))
        if got and parse_bad == got:
            log(f'❌ {sym} 這一輪下載到的 {got} 份逐字稿全部解析不了 → 紅燈(逐字稿版面可能變了)')
            rc = 1
    return rc


def _http_page(url):
    """季度頁 → (狀態碼, html 文字)。⛔ 不重試很多次:一季一頁,抓不到下一輪再來。"""
    import requests
    time.sleep(PAGE_PACE)
    for back in (0, 4):
        if back:
            time.sleep(back)
        try:
            r = requests.get(url, headers=UA, timeout=25)
            if r.status_code in (429, 500, 502, 503, 504):
                continue
            r.encoding = r.encoding or 'utf-8'
            return r.status_code, r.text if r.status_code == 200 else ''
        except Exception:                                       # noqa: BLE001 —— 下一輪再來
            continue
    return None, ''


def _keys():
    raw = os.getenv('GROQ_API_KEYS') or os.getenv('GROQ_API_KEY') or ''
    return [k.strip() for k in re.split(r'[,\s]+', raw) if k.strip()]


# ───────────────────────── selftest ─────────────────────────
def selftest():
    ok_n = bad = 0

    def ok(name, cond, extra=''):
        nonlocal ok_n, bad
        if cond:
            ok_n += 1
            print(f'✅ {name}')
        else:
            bad += 1
            print(f'❌ {name} {extra}')

    ok('① target_quarters:10/25 → 2026Q3 往前 4 季;1/5 → 2025Q4(那季法說會還沒開也列)',
       [yq_key(x) for x in target_quarters('2026-10-25')] == ['2026Q3', '2026Q2', '2026Q1', '2025Q4']
       and yq_key(target_quarters('2027-01-05')[0]) == '2026Q4')
    ok('② call_date:逐字稿第一頁日期優先;對不上那一季 ⛔ 收;退回場次表(只收 1/4/7/10 月)',
       call_date('EVENT DATE/TIME: OCTOBER 15, 2026 / 6:00AM GMT', [], (2026, 3)) == '2026-10-15'
       and call_date('JULY 16, 2026', ['2026-10-15'], (2026, 3)) == '2026-10-15'
       and call_date('', ['2026-09-14', '2026-10-25', '2026-10-15'], (2026, 3)) == '2026-10-15'
       and call_date('', ['2026-09-14'], (2026, 3)) is None)
    html = ('<a href="/english/encrypt/files/x/TSMC%203Q26%20Transcript.pdf">Transcript</a>'
            '<a href="/english/encrypt/files/x/TSMC%203Q26%20Presentation.pdf">Presentation</a>'
            '<a href="/english/encrypt/files/x/TSMC%202Q26%20Transcript.pdf">Transcript</a>')
    u = find_transcript(html, 'https://investor.tsmc.com/english/quarterly-results/2026/q3', (2026, 3))
    ok('③ find_transcript:季別對得上的那一份(⛔ 簡報、⛔ 別季)', u and '3Q26%20Transcript' in u, u)
    ok('③b 季別都不對 → None(⛔ 拿別季的)', find_transcript(html, 'https://x.com/', (2025, 4)) is None)
    ok('④ short_org:拿掉 Research Division / Inc / & Co',
       short_org('JPMorgan Chase & Co, Research Division') == 'JPMorgan Chase' and short_org('Morgan Stanley') == 'Morgan Stanley'
       and short_org('Goldman Sachs Group, Inc., Research Division') == 'Goldman Sachs' and short_org('') == '外部'
       and short_org('Ho Morgan Stanley, Research Division') == 'Morgan Stanley' and short_org('Stifel Nicolaus & Company') == 'Stifel Nicolaus'
       and short_org('Susquehanna Financial Group LLLP') == 'Susquehanna Financial' and short_org('Arete Research Services LLP') == 'Arete Research Services')
    ok('⑤ role_zh:董事長 / 財務長 / 發言人', role_zh('Chairman & CEO') == '董事長' and role_zh('CFO') == '財務長'
       and role_zh('Director of IR') == '發言人' and role_zh('VP of Something') == '公司')
    ok('⑥ zh_ok:中文為主收、英文原句 ⛔、短字 ⛔',
       zh_ok('公司預期 N2 明年產能倍增') and not zh_ok('We expect N2 capacity to double next year')
       and not zh_ok('公司說 we expect strong demand from AI customers next') and not zh_ok('是'))
    src = ('[分析師(Morgan Stanley)] What is 2026 capex? And N2?\n'
           '[台積電(Chairman & CEO)] We expect capex of US$52 to 56 billion. Gross margin 56% and higher. N2 ramps fast.')
    keep, dn, dl = gate_items({'items': [{'tag': '資本支出', 'q': '分析師問今年資本支出', 'a': '公司預期 52 到 56 billion 美元'},
                                         {'tag': '毛利率', 'q': '分析師問毛利率', 'a': '長期毛利率 60% 以上'}]}, src)
    ok('⑦ ⭐ 數字核對:原文有的留、原文沒有的(60%)整句丟 → 決定性對照', len(keep) == 1 and dn == 1 and keep[0]['tag'] == '資本支出',
       (keep, dn))
    keep2, dn2, dl2 = gate_items({'items': [{'tag': '毛利率', 'q': '分析師問毛利率', 'a': '長期毛利率 56% 以上'}]}, src)
    ok('⑦b 同一句數字改成原文有的(56%)→ 留下', len(keep2) == 1 and dn2 == 0)
    keep3, _, dl3 = gate_items({'items': [{'tag': '?', 'q': 'Charlie Chan 問 N2', 'a': 'We expect N2 ramp to be very fast this year'}]},
                               src, {'Charlie Chan', 'Charlie'})
    ok('⑧ 英文原句 ⛔(整句丟);tag 不在清單 → 其他', not keep3 and dl3 == 1)
    keep4, _, _ = gate_items({'items': [{'tag': 'AI需求', 'q': 'Charlie Chan 問 AI 需求', 'a': '公司說 AI 需求很強'}]}, src, {'Charlie Chan', 'Charlie'})
    ok('⑨ 人名換成「分析師」;tag 別名對到清單', keep4 and '分析師' in keep4[0]['q'] and 'Charlie' not in keep4[0]['q'] and keep4[0]['tag'] == 'AI 需求', keep4)
    k5, _, dl5 = gate_items({'items': [{'tag': '其他', 'q': '分析師問明年展望', 'a': '公司說需求很強,屬於利多'}]}, src)
    ok('⑨b 買賣字眼(利多 / 買進 …)那一句丟掉', not k5 and dl5 == 1)
    ok('⑩ norm_tag:清單外 → 其他', norm_tag('天氣') == '其他' and norm_tag('先進封裝') == '先進封裝')
    ok('⑪ _need:沒有 → 做;有缺題且補不到 3 次 → 做;沒缺 / 補滿 → ⛔',
       _need(None) and _need({'miss': 2, 'tries': 1}) and not _need({'miss': 0, 'tries': 1}) and not _need({'miss': 2, 'tries': 3}))
    sys_m, user, _ = ai_prompt('台積電', src)
    ok('⑫ 提示詞:⛔ 換算 / ⛔ 利多利空 / ⛔ 人名 / ⛔ 照抄英文 / 固定分類清單',
       all(x in sys_m for x in ('換算', '利多利空', '人名', '英文')) and all(t in user for t in TAGS))
    print(f'\n{"✅ 全部通過" if not bad else "❌ 有失敗"}({ok_n} 過 / {bad} 失敗)')
    return 1 if bad else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(run())
