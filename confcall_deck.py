#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📞 confcall_deck.py —— 把法說會「簡報內容」讀進來(V79.6.3)

🎯 為什麼要有這一支(使用者 2026-10-23):
   「法說會的最新不是很重要嗎?如何快速提取裡面重點,還有之前沒有做的項目,突然開始要做,
    我的想法就是要找出裡面有用資料」
   → 以前 confcall_miner.py 只抓公開資訊觀測站的**場次表**(日期 / 地點 / 約 39 字的議程 / 簡報檔名),
     簡報內容一個字都沒讀;產業作戰室的法說會分頁只是日期清單 + 連結。

📐 做法(⛔ 不讓 AI 算數字,AI 只是把抽出來的句子濃縮成一句話):
   ① 讀 data/confcall.json 的簡報檔名 → 官方下載網址(mopsov FileDownLoad,GET;樣板跟 confcall_miner 同一份)
   ② 下載(一次一檔、間隔 ≥3 秒、被擋 / 5xx 指數退避 2/4/8/16 秒、連 5 檔失敗本輪收工)→ 邊下載邊抽字,⛔ 不存原檔
   ③ 機械式重點(可以拿去回測,⛔ 不用 AI):每頁標題、講「展望 / 預期 / 目標」的句子、帶數字的營運指標句子,全部附**頁碼**
   ④「這次第一次提到」= 這家公司前幾份簡報都沒出現、而且不是這一季全市場兩成以上公司都在講的詞
   ⑤ (有 GROQ 金鑰才做)AI 只讀③抽出來的句子 → 一句話 / 展望 / 新東西 / 風險,每點附頁碼;
      ⭐ 數字核對:AI 寫的每個數字都要在餵進去的原文找得到,找不到那一點整點丟掉並計數
   ⑥ 產物:
      cc_deep 分支  cc/index.json(讀過哪些簡報、結果)・cc/feat/{YYYY-MM}.json.gz(每份簡報的特徵,給研究與「跟上次比」)
      data/cc/{sym}.json        ← 每檔最近 4 份(散戶 App 個股頁 / 產業作戰室讀)
      data/confcall_digest.json ← 最近 60 天每場一列(產業作戰室法說會分頁的清單)

⛔ 不可改掉的設計:
   ① 只讀公開資訊觀測站 mopsov(mops 主機對 runner 回安全性錯誤;confcall_miner 已實測)
   ② 防封鎖:間隔 + 指數退避 + 連續失敗收工 + 每輪上限(使用者鐵則:外部請求要完美略過與重試)
   ③ 防爆記憶體:單檔 >40MB 不讀、最多 80 頁、一次只處理一檔;歷史特徵一個月一個月讀
   ④ 數字只能來自簡報原文(AI 編的整點丟掉);沒有上一份簡報 → ⛔ 不說「第一次提到」(寫「第一次收錄」)
   ⑤ 進入點放檔尾(陷阱 #9)
"""
import gzip
import html as _html
import io
import json
import os
import re
import sys
import time
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

DATA = Path(os.getenv('DATA_DIR', 'data'))
CC = Path(os.getenv('CC_DIR', 'cc_deep'))           # cc_deep 分支的工作目錄(workflow 先還原)
SRC = DATA / 'confcall.json'
MAX_FILES = int(os.getenv('CC_MAX') or 150)          # 🔧 inputs.* 排程觸發時是空字串 → 一律 `or 預設`(check_env_default)
PACE = float(os.getenv('CC_PACE') or 3.0)
BUDGET_MIN = float(os.getenv('CC_BUDGET_MIN') or 40)
AI_MAX = int(os.getenv('CC_AI_MAX') or 40)
MAX_BYTES = 40 * 1024 * 1024
MAX_PAGES = 80
KEEP_PER_SYM = 4
DIGEST_DAYS = 60
PREV_DECKS = 4                # 「第一次提到」跟這家公司前幾份比
COMMON_SHARE = 0.20           # 這一季超過兩成公司都在講的詞 ⛔ 不算「新」
COMMON_MIN_DECKS = 30         # 樣本太少就不判「大家都在講」
TRANSIENT_TRIES = 3           # 下載失敗(暫時性)最多試幾輪
TW = timezone(timedelta(hours=8))
UA = {'User-Agent': 'Mozilla/5.0 confcall_deck/1.0', 'Accept': 'application/pdf, application/octet-stream, */*'}

# ───────────────────────── 詞庫(「新業務」用;⭐ 寫在一處,研究探針 import 同一份) ─────────────────────────
#   ⚠️ 只放「產品 / 應用 / 技術」這種名詞;⛔ 不放「成長 / 樂觀」這種形容詞(那是語氣,另外算)
THEMES = [
    'AI', '人工智慧', '生成式', 'AI 伺服器', '伺服器', '資料中心', '雲端', '邊緣運算', 'GPU', 'ASIC', 'CPU', 'HBM', 'DDR5',
    'CoWoS', '先進封裝', '異質整合', 'Chiplet', '小晶片', '矽光子', 'CPO', '共封裝光學', '光通訊', '800G', '1.6T', '400G',
    '液冷', '浸沒式', '散熱', '水冷板', '電源', 'BBU', 'UPS', 'HVDC', '高壓直流',
    '機器人', '人形機器人', '自動化', '無人機', '國防', '軍工', '低軌衛星', '衛星', '太空',
    '電動車', '車用', '自駕', 'ADAS', '充電樁', '充電', '電池', '固態電池', '儲能', '綠能', '太陽能', '風電', '離岸風電', '氫能', '核能',
    'SiC', 'GaN', '碳化矽', '氮化鎵', '第三代半導體', 'Micro LED', 'MicroLED', 'Mini LED', 'OLED', 'AR', 'VR', 'XR', '智慧眼鏡',
    '5G', '6G', 'Wi-Fi 7', 'WiFi 7', 'Wi-Fi 8', '低功耗', '物聯網', 'IoT', '醫療', '生技', '新藥', '醫材', '減重',
    'PCB', 'ABF', '載板', 'CCL', '銅箔', '玻璃基板', '面板級封裝', 'FOPLP', 'TGV', '矽晶圓', '半導體設備', '量測', '檢測',
    '美國廠', '墨西哥', '越南', '印度', '日本廠', '泰國', '海外設廠', '併購', '轉投資', '新產品', '新客戶', '量產',
]
_EN_STOP = {
    'EPS', 'YOY', 'QOQ', 'MOM', 'Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2', 'FY', 'IR', 'TWD', 'NTD', 'NT', 'USD', 'RMB', 'CEO', 'CFO',
    'COO', 'CTO', 'IFRS', 'PDF', 'LTD', 'INC', 'CO', 'CORP', 'TEL', 'FAX', 'HTTP', 'HTTPS', 'WWW', 'COM', 'TW', 'ROC', 'ROE',
    'ROA', 'GM', 'OP', 'OPM', 'NP', 'YTD', 'TTM', 'KPI', 'ESG', 'Q', 'M', 'K', 'B', 'NO', 'OK', 'THE', 'AND', 'FOR', 'OF',
    'IN', 'TO', 'ON', 'BY', 'AT', 'AS', 'IS', 'BE', 'OR', 'AN', 'A', 'I', 'II', 'III', 'IV', 'V', 'VS', 'ETC', 'AGM', 'SEC',
    'TWSE', 'TPEX', 'MOPS', 'GAAP', 'NON', 'TBD', 'NA', 'N', 'E', 'P', 'F', 'R', 'S', 'T', 'U', 'X', 'Y', 'Z', 'C', 'D', 'G', 'H',
    'L', 'O', 'W', 'J', 'MAP', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
}
OUTLOOK_RE = re.compile(r'展望|預期|預估|預計|目標|看好|指引|後市|下半年|明年|outlook|guidance|expect|forecast|target', re.I)
KPI_RE = re.compile(r'營收|毛利率|營業利益率|營益率|營業利益|淨利|稅後|EPS|每股盈餘|資本支出|產能|稼動率|出貨|訂單|在手訂單|單價|ASP|'
                    r'市占|revenue|gross margin|operating margin|net income|capex|capacity|utilization|shipment|backlog', re.I)
NUM_RE = re.compile(r'\d[\d,]*(?:\.\d+)?\s*(?:%|％|億|萬|元|倍|x|X|kW|MW|GW|nm|吋|片|台|K|M|B)?')
# 免責聲明 / 前瞻性陳述那一頁一定有「expect / 預期」→ ⛔ 不可當成公司的展望
DISCLAIM_RE = re.compile(r'forward[- ]looking|safe harbor|undertakes no obligation|uncertaint|免責|前瞻性|僅供參考|不代表|聲明|風險與不確定', re.I)
POS_RE = re.compile(r'成長|增加|提升|強勁|優於|創新高|新高|擴產|樂觀|回溫|復甦|看好|倍增|growth|increase|strong|record|recover', re.I)
NEG_RE = re.compile(r'下滑|減少|衰退|疲弱|保守|審慎|謹慎|調整|庫存去化|逆風|不確定|放緩|下修|decline|decrease|weak|cautious|headwind|soft', re.I)
_THEME_RES = [(t, re.compile((r'(?<![A-Za-z])' + re.escape(t) + r'(?![A-Za-z])') if re.match(r'^[\x00-\x7f ]+$', t) else re.escape(t), re.I))
              for t in THEMES]
_EN_TOKEN = re.compile(r'(?<![A-Za-z0-9])(?:[A-Z]{2,}[A-Za-z0-9\-\+]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[A-Z]{1,4}\d{2,4}[A-Za-z]*|\d{3,4}[GT])(?![A-Za-z0-9])')

FILE_FALLBACK = {'host': 'https://mopsov.twse.com.tw', 'path': '/server-java/FileDownLoad',
                 'q': {'step': '9', 'filePath': '/home/html/nas/STR/', 'functionName': 't100sb02_1'}, 'arg': 'fileName'}


# ───────────────────────── 純函式(測試直接打這幾支) ─────────────────────────
def file_meta(name):
    """'233020260716M001.pdf' → {'sym':'2330','fd':'2026-07-16','lang':'M','ext':'pdf'};認不得回 None。"""
    m = re.match(r'^([0-9A-Za-z]{4,6}?)(\d{8})([ME])(\d+)\.([A-Za-z]{3,4})$', str(name or '').strip())
    if not m:
        return None
    d = m.group(2)
    try:
        fd = date(int(d[:4]), int(d[4:6]), int(d[6:8])).isoformat()
    except ValueError:
        return None
    return {'sym': m.group(1), 'fd': fd, 'lang': m.group(3).upper(), 'ext': m.group(5).lower()}


def pick_deck(files):
    """一場法說會可能有中文 / 英文兩份 → 挑中文(M)的 pdf/pptx;沒有才拿英文。回 (檔名, 原因)。"""
    cands = []
    for f in files or []:
        mt = file_meta(f)
        if not mt:
            continue
        cands.append((0 if mt['lang'] == 'M' else 1, 0 if mt['ext'] in ('pdf', 'pptx') else 1, f, mt))
    if not cands:
        return None, 'no_file'
    cands.sort()
    _, okext, f, mt = cands[0]
    if okext:
        return f, 'ppt_old'        # 舊 .ppt(二進位格式)→ ⛔ 不硬猜
    return f, ''


def file_url(tpl, name):
    t = tpl if (tpl and tpl.get('path')) else FILE_FALLBACK
    q = dict(t.get('q') or {})
    return f"{t.get('host') or FILE_FALLBACK['host']}{t['path']}?{urlencode(q)}&{t.get('arg') or 'fileName'}={name}"


def _clean(s):
    s = _html.unescape(str(s or '')).replace('　', ' ').replace('\xa0', ' ')
    s = re.sub(r'[ \t]+', ' ', s)
    return s


def extract_pdf(b):
    from pypdf import PdfReader          # 只有這支 workflow 會裝(⛔ 不加進全域 requirements)
    rd = PdfReader(io.BytesIO(b))
    pages = []
    for i, pg in enumerate(rd.pages):
        if i >= MAX_PAGES:
            break
        try:
            pages.append(_clean(pg.extract_text() or ''))
        except Exception:
            pages.append('')
    return pages


def extract_pptx(b):
    """pptx 是 zip:逐張投影片讀 <a:t> 文字(零依賴)。"""
    z = zipfile.ZipFile(io.BytesIO(b))
    names = [n for n in z.namelist() if re.match(r'^ppt/slides/slide\d+\.xml$', n)]
    names.sort(key=lambda n: int(re.search(r'(\d+)\.xml$', n).group(1)))
    pages = []
    for n in names[:MAX_PAGES]:
        x = z.read(n).decode('utf-8', 'ignore')
        paras = []
        for p in re.findall(r'<a:p\b.*?</a:p>', x, flags=re.S):
            t = ''.join(re.findall(r'<a:t>([^<]*)</a:t>', p))
            if t.strip():
                paras.append(t)
        pages.append(_clean('\n'.join(paras)))
    return pages


def page_lines(pages):
    """[(頁碼, 一行)…];頁首頁尾那種每頁都出現的行(公司名、免責聲明)拿掉。"""
    per = []
    for i, t in enumerate(pages):
        ls = []
        for ln in re.split(r'[\r\n]+', t or ''):
            ln = ln.strip(' •·●▪-–—|')
            if 2 <= len(ln) <= 220 and not re.fullmatch(r'[\d\s/.:\-]+', ln):
                ls.append(ln)
        per.append((i + 1, ls))
    n = max(1, sum(1 for _, ls in per if ls))
    freq = {}
    for _, ls in per:
        for ln in set(ls):
            freq[ln] = freq.get(ln, 0) + 1
    boiler = {ln for ln, c in freq.items() if n >= 4 and c / n > 0.4}
    return [(p, ln) for p, ls in per for ln in ls if ln not in boiler]


def titles_of(lines, limit=30):
    seen, out = set(), []
    for p, ln in lines:
        if p in seen or len(ln) > 40:
            continue
        seen.add(p)
        out.append([p, ln])
        if len(out) >= limit:
            break
    return out


def _pick(lines, pred, limit):
    seen, out = set(), []
    for p, ln in lines:
        k = re.sub(r'\s+', '', ln)
        if k in seen or not pred(ln):
            continue
        seen.add(k)
        out.append([p, ln[:160]])
        if len(out) >= limit:
            break
    return out


def outlook_of(lines, limit=8):
    # ⛔ 只有標題字(「展望」「Outlook」)不算一句話;⛔ 免責聲明不算
    return _pick(lines, lambda s: bool(OUTLOOK_RE.search(s)) and not DISCLAIM_RE.search(s) and len(re.sub(r'\s', '', s)) >= 8, limit)


def nums_of(lines, limit=10):
    return _pick(lines, lambda s: bool(KPI_RE.search(s)) and bool(re.search(r'\d', s)) and not DISCLAIM_RE.search(s), limit)


def terms_of(pages):
    """這份簡報講到的「產品 / 應用 / 技術」詞:詞庫命中 + 英文縮寫 / 產品代號。回 {詞: 第一次出現的頁}。"""
    out = {}
    for i, t in enumerate(pages):
        if not t:
            continue
        for term, rx in _THEME_RES:
            if term not in out and rx.search(t):
                out[term] = i + 1
        for tok in _EN_TOKEN.findall(t):
            tk = tok.strip('-+')
            if len(tk) < 2 or tk.upper() in _EN_STOP or re.fullmatch(r'\d+', tk):
                continue
            if re.fullmatch(r'(19|20)\d\d[A-Za-z]*', tk):      # 年份
                continue
            if tk not in out and not any(tk.lower() == k.lower() for k in out):
                out[tk] = i + 1
    return out


def tone_of(outlook):
    pos = sum(len(POS_RE.findall(t)) for _, t in outlook)
    neg = sum(len(NEG_RE.findall(t)) for _, t in outlook)
    return [pos, neg]


def novelty(terms, prev_terms, common):
    """這次第一次提到 = 這家公司前幾份都沒有 + 不是大家都在講的;⛔ 沒有上一份 → 回 None(不可說「新」)。"""
    if not prev_terms:
        return None, []
    seen = set()
    for ts in prev_terms:
        seen |= {x.lower() for x in ts}
    new = sorted([t for t in terms if t.lower() not in seen and t.lower() not in common], key=lambda t: terms[t])
    last = {x.lower(): x for x in prev_terms[0]}
    dropped = sorted([v for k, v in last.items() if k not in {t.lower() for t in terms} and k not in common])[:10]
    return new, dropped


_NUM_ONLY = re.compile(r'\d[\d,]*(?:\.\d+)?')


def num_gate(text, source):
    """AI 寫的每個數字都要在原文找得到;回缺的那幾個(空 list = 過關)。⛔ 1 位數也查(頁碼除外由呼叫端處理)。"""
    src = re.sub(r'(?<=\d),(?=\d)', '', source or '')
    miss = []
    for n in _NUM_ONLY.findall(text or ''):
        v = n.replace(',', '').rstrip('.')
        if v and v not in src:
            miss.append(n)
    return miss


def gate_ai(ai, source):
    """把 AI 回的每一點過數字核對;回 (乾淨的 ai, 丟掉幾點)。頁碼欄位不算數字主張。"""
    if not isinstance(ai, dict):
        return None, 0
    dropped = 0
    out = {}
    one = str(ai.get('one') or '').strip()
    if one and num_gate(one, source):
        dropped += 1
        one = ''
    out['one'] = one[:80]
    for k in ('outlook', 'new', 'risk'):
        keep = []
        for it in (ai.get(k) or [])[:3]:
            if isinstance(it, str):
                it = {'t': it}
            if not isinstance(it, dict):
                continue
            t = str(it.get('t') or '').strip()
            if not t:
                continue
            if num_gate(t, source):
                dropped += 1
                continue
            p = it.get('p')
            keep.append({'t': t[:120], 'p': p if isinstance(p, int) else None})
        out[k] = keep
    return out, dropped


def ai_prompt(name, sym, d, titles, outlook, nums):
    lines = [f'p{p} {t}' for p, t in (outlook + nums)] or [f'p{p} {t}' for p, t in titles[:15]]
    src = '\n'.join(lines)[:3000]
    sys_msg = ('你是台股法說會簡報的整理員。只能根據使用者給的句子整理,⛔ 不可以加句子裡沒有的數字、⛔ 不可以自己計算、'
               '⛔ 不給買賣建議、⛔ 不猜股價。輸出純 JSON(不要 markdown)。')
    user = (f'{name}({sym}){d} 法說會簡報抽出來的句子(p 後面是頁碼):\n{src}\n\n'
            '用繁體中文輸出 JSON:{"one":"一句話重點(30 字內)","outlook":[{"t":"公司對之後的說法","p":頁碼}],'
            '"new":[{"t":"新的產品 / 應用 / 客戶 / 投資","p":頁碼}],"risk":[{"t":"公司自己提到的風險或保守的地方","p":頁碼}]},'
            '每項最多 3 點;句子裡沒有的就給空陣列。')
    return sys_msg, user, src


def parse_ai_json(txt):
    t = re.sub(r'<think>.*?</think>', '', txt or '', flags=re.S).strip()
    t = re.sub(r'^```(?:json)?\s*|\s*```$', '', t.strip())
    m = re.search(r'\{.*\}', t, flags=re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def feat_of(pages, meta):
    lines = page_lines(pages)
    ol = outlook_of(lines)
    return {
        'pages': len(pages),
        'chars': sum(len(p or '') for p in pages),
        'titles': titles_of(lines),
        'outlook': ol,
        'nums': nums_of(lines),
        'terms': terms_of(pages),
        'tone': tone_of(ol),
    }


# ───────────────────────── 狀態 / 特徵檔(cc_deep 分支) ─────────────────────────
def _load_json(p, dflt):
    try:
        if p.suffix == '.gz':
            with gzip.open(p, 'rt', encoding='utf-8') as f:
                return json.load(f)
        return json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return dflt


def _save_json(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    s = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
    if p.suffix == '.gz':
        with gzip.open(p, 'wt', encoding='utf-8', compresslevel=9) as f:
            f.write(s)
    else:
        p.write_text(s, encoding='utf-8')


def month_file(d):
    return CC / 'cc' / 'feat' / f'{d[:7]}.json.gz'


def load_index():
    return _load_json(CC / 'cc' / 'index.json', {'files': {}})


def iter_feats(months=None):
    """一個月一個月讀(⛔ 不一次全讀進記憶體)。months=None → 全部。"""
    d = CC / 'cc' / 'feat'
    if not d.exists():
        return
    for p in sorted(d.glob('*.json.gz')):
        if months and p.name[:7] not in months:
            continue
        for r in _load_json(p, []):
            yield r


def common_terms(recs):
    """這一批(最近一季)裡超過兩成簡報都講到的詞 → 不算「新」。樣本太少回空集合。"""
    recs = [r for r in recs if r.get('terms')]
    if len(recs) < COMMON_MIN_DECKS:
        return set()
    df = {}
    for r in recs:
        for t in {x.lower() for x in r['terms']}:
            df[t] = df.get(t, 0) + 1
    return {t for t, c in df.items() if c / len(recs) > COMMON_SHARE}


# ───────────────────────── 網路(只在正式跑時用) ─────────────────────────
class Fetcher:
    def __init__(self, session=None, pace=PACE, sleeper=time.sleep):
        import requests
        self.s = session or requests.Session()
        self.pace, self.sleep = pace, sleeper
        self.fail_streak = 0
        self.last = 0.0

    def get(self, url):
        """回 (bytes|None, 原因)。暫時性錯誤指數退避重試;⛔ 不無限重試。"""
        wait = self.pace - (time.time() - self.last)
        if wait > 0:
            self.sleep(wait)
        err = ''
        for k, back in enumerate((0, 2, 4, 8, 16)):
            if back:
                self.sleep(back)
            try:
                r = self.s.get(url, headers=UA, timeout=(10, 60), stream=True)
                self.last = time.time()
                if r.status_code in (429, 500, 502, 503, 504):
                    err = f'HTTP {r.status_code}'
                    continue
                if r.status_code != 200:
                    return None, f'HTTP {r.status_code}'
                buf = io.BytesIO()
                for chunk in r.iter_content(65536):
                    buf.write(chunk)
                    if buf.tell() > MAX_BYTES:
                        return None, 'too_big'
                b = buf.getvalue()
                if b[:5] == b'%PDF-' or b[:4] == b'PK\x03\x04':
                    return b, ''
                head = b[:200].decode('utf-8', 'ignore').replace('\n', ' ')
                return None, f'not_file:{head[:80]}'     # 回了網頁(陷阱 #23:不存在的路徑回 200 + 網頁)
            except Exception as e:
                err = type(e).__name__
                self.last = time.time()
        return None, err or 'fail'


def groq_summarize(name, sym, d, feat, keys, poster=None):
    """回 (ai dict, model, 丟掉幾點) 或 (None, None, 0)。⛔ 沒有金鑰就不做。"""
    if not keys:
        return None, None, 0
    from groq_common import groq_model, groq_apply, invalidate
    import requests
    sys_msg, user, src = ai_prompt(name, sym, d, feat['titles'], feat['outlook'], feat['nums'])
    payload = {'model': None, 'messages': [{'role': 'system', 'content': sys_msg}, {'role': 'user', 'content': user}],
               'temperature': 0.2, 'max_tokens': 700}
    post = poster or (lambda **kw: requests.post(**kw))
    tried = set()
    for i, key in enumerate(list(keys) * 2):
        try:
            if not payload.get('model'):
                groq_apply(payload, groq_model(keys, 'light', avoid=tried), 700)
            r = post(url='https://api.groq.com/openai/v1/chat/completions', json=payload,
                     headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, timeout=45)
            if r.status_code == 404 and len(tried) < 3:
                tried.add(payload.get('model')); invalidate('light', payload.get('model')); payload['model'] = None
                continue
            if r.status_code == 429:
                time.sleep(2 + i)
                continue
            if r.status_code != 200:
                continue
            txt = (r.json().get('choices') or [{}])[0].get('message', {}).get('content', '') or ''
            ai = parse_ai_json(txt)
            if not ai:
                return None, payload.get('model'), 0
            clean, dropped = gate_ai(ai, src)
            return clean, payload.get('model'), dropped
        except Exception:
            continue
    return None, None, 0


# ───────────────────────── 主流程 ─────────────────────────
def _today():
    return datetime.now(TW).date()


def build_outputs(touched, rows_by_sym, today):
    """依 cc_deep 的特徵寫 App 讀的兩個檔。touched = 這一輪有新簡報的股票。"""
    recent_months = {(today - timedelta(days=k)).isoformat()[:7] for k in range(0, DIGEST_DAYS + 35, 28)}
    by_sym, digest = {}, []
    cut = (today - timedelta(days=DIGEST_DAYS)).isoformat()
    for r in iter_feats():
        by_sym.setdefault(r['s'], []).append(r)
    out_dir = DATA / 'cc'
    out_dir.mkdir(parents=True, exist_ok=True)
    wrote = 0
    for s, lst in by_sym.items():
        lst.sort(key=lambda r: (r.get('d') or '', r.get('f') or ''), reverse=True)
        if s in touched or not (out_dir / f'{s}.json').exists():
            decks = []
            for r in lst[:KEEP_PER_SYM]:
                decks.append({k: r.get(k) for k in ('d', 'f', 'kind', 'pages', 'st', 'reuse', 'first', 'new', 'dropped', 'prev_d',
                                                     'outlook', 'nums', 'titles', 'tone', 'ai', 'model', 'gate_drop') if r.get(k) is not None})
                decks[-1]['titles'] = (decks[-1].get('titles') or [])[:12]
            (out_dir / f'{s}.json').write_text(json.dumps({'s': s, 'updated': datetime.now(TW).isoformat(timespec='minutes'),
                                                           'decks': decks}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            wrote += 1
        for r in lst:
            if (r.get('d') or '') >= cut and r.get('st') == 'ok':
                nm = (rows_by_sym.get(s) or {}).get('name') or r.get('name') or s
                ai = r.get('ai') or {}
                digest.append({'s': s, 'name': nm, 'd': r.get('d'), 'f': r.get('f'), 'one': ai.get('one') or '',
                               'new': [t for t, _ in (r.get('new') or [])][:5], 'new_n': len(r.get('new') or []),
                               'first': bool(r.get('first')), 'reuse': r.get('reuse') or '', 'n_nums': len(r.get('nums') or []),
                               'pages': r.get('pages')})
    digest.sort(key=lambda x: (x['d'] or '', x['new_n']), reverse=True)
    _save_json(DATA / 'confcall_digest.json', {'updated': datetime.now(TW).isoformat(timespec='minutes'),
                                               'days': DIGEST_DAYS, 'n': len(digest), 'rows': digest})
    return wrote, len(digest)


def run(fetcher=None, groq_keys=None, today=None, log=print):
    today = today or _today()
    t0 = time.time()
    src = _load_json(SRC, None)
    if not src:
        log('❌ 讀不到 data/confcall.json(法說會場次表)→ 這輪不做')
        return 1
    tpl = (src.get('src') or {}).get('file')
    rows = [r for r in (src.get('recent') or []) + (src.get('upcoming') or []) if r and r.get('pdf')]
    rows_by_sym = {}
    for r in rows:
        rows_by_sym.setdefault(str(r['s']), r)
    idx = load_index()
    files = idx.setdefault('files', {})
    # 要讀的:已經開完、有簡報、還沒讀過(或上次是暫時性失敗而且還沒超過次數)
    todo, seen = [], set()
    for r in sorted(rows, key=lambda x: x.get('d') or '', reverse=True):
        if (r.get('d') or '9999') > today.isoformat():
            continue
        f, why = pick_deck(r.get('pdf'))
        if not f or f in seen:
            continue
        seen.add(f)
        st = files.get(f)
        if st and (st.get('st') == 'ok' or st.get('st') in ('no_text', 'bad_file', 'ppt_old', 'too_big', 'parse_fail')
                   or (st.get('tries') or 0) >= TRANSIENT_TRIES):
            continue
        todo.append((r, f, why))
    log(f'📞 場次表 {len(rows)} 場有簡報 ・這一輪要讀 {len(todo)} 份(上限 {MAX_FILES})')
    if not todo:
        build_outputs(set(), rows_by_sym, today)
        log('ℹ️ 沒有新的簡報;只重建清單')
        return 0
    fetcher = fetcher or Fetcher()
    # 歷史:每家公司前幾份的詞 + 最近一季大家都在講的詞(一個月一個月讀)
    hist = {}
    recent = []
    q_cut = (today - timedelta(days=100)).isoformat()
    for rec in iter_feats():
        if rec.get('st') == 'ok' and rec.get('terms') is not None:
            hist.setdefault(rec['s'], []).append((rec.get('d') or '', rec['terms']))
            if (rec.get('d') or '') >= q_cut:
                recent.append(rec)
    common = common_terms(recent)
    new_recs, touched, ai_used, n_ok, n_fail, streak = [], set(), 0, 0, 0, 0
    for r, f, why in todo[:MAX_FILES]:
        if (time.time() - t0) / 60 > BUDGET_MIN:
            log(f'⏱️ 到時間上限 {BUDGET_MIN} 分 → 收工(剩的下一輪接著讀)')
            break
        s, d = str(r['s']), r.get('d')
        mt = file_meta(f) or {}
        rec = {'s': s, 'd': d, 'f': f, 'name': r.get('name') or s, 'kind': mt.get('ext'), 'ts': datetime.now(TW).isoformat(timespec='minutes')}
        if mt.get('fd') and d and mt['fd'] < d and (date.fromisoformat(d) - date.fromisoformat(mt['fd'])).days > 3:
            rec['reuse'] = mt['fd']          # 拿舊簡報去券商場重講
        if why == 'ppt_old':
            rec['st'] = 'ppt_old'
            files[f] = {'st': 'ppt_old', 's': s, 'd': d, 'tries': 1}
            new_recs.append(rec)
            continue
        b, err = fetcher.get(file_url(tpl, f))
        if b is None:
            n_fail += 1
            streak += 1
            prev = files.get(f) or {}
            perm = err.startswith('not_file') or err == 'too_big' or err.startswith('HTTP 4')
            files[f] = {'st': 'too_big' if err == 'too_big' else ('bad_file' if perm else 'dl_fail'), 'err': err[:120],
                        's': s, 'd': d, 'tries': (prev.get('tries') or 0) + 1}
            log(f'  ⚠️ {s} {d} {f} 下載失敗:{err[:80]}')
            if streak >= 5:
                log('🛑 連 5 份下載失敗(可能被擋)→ 本輪收工,下一輪再試')
                break
            continue
        streak = 0
        try:
            pages = extract_pptx(b) if b[:2] == b'PK' else extract_pdf(b)
        except Exception as e:
            files[f] = {'st': 'parse_fail', 'err': type(e).__name__, 's': s, 'd': d, 'tries': 1}
            rec['st'] = 'parse_fail'
            new_recs.append(rec)
            continue
        del b
        if sum(len(p or '') for p in pages) < 200:
            rec.update({'st': 'no_text', 'pages': len(pages)})       # 只有圖片的簡報(⛔ 不 OCR)
            files[f] = {'st': 'no_text', 's': s, 'd': d, 'tries': 1}
            new_recs.append(rec)
            touched.add(s)
            continue
        feat = feat_of(pages, mt)
        prev = sorted([x for x in hist.get(s, []) if x[0] < (d or '')], reverse=True)[:PREV_DECKS]
        new, dropped = novelty(feat['terms'], [x[1] for x in prev], common)
        rec.update({'st': 'ok', **feat})
        if new is None:
            rec['first'] = True
        else:
            rec['new'] = [[t, feat['terms'][t]] for t in new][:12]
            rec['dropped'] = dropped
            rec['prev_d'] = prev[0][0] if prev else None
        if groq_keys and ai_used < AI_MAX and d and d >= (today - timedelta(days=DIGEST_DAYS)).isoformat():
            ai, model, gd = groq_summarize(rec['name'], s, d, feat, groq_keys)
            ai_used += 1
            if ai:
                rec.update({'ai': ai, 'model': model, 'gate_drop': gd})
        files[f] = {'st': 'ok', 's': s, 'd': d, 'tries': 1, 'pages': feat['pages']}
        hist.setdefault(s, []).append((d or '', feat['terms']))
        new_recs.append(rec)
        touched.add(s)
        n_ok += 1
        log(f'  ✅ {s} {d} {feat["pages"]} 頁 ・重點 {len(feat["outlook"])} 句 ・數字 {len(feat["nums"])} 句 ・'
            f'{"第一次收錄" if new is None else f"新詞 {len(new)} 個"}{" ・AI ✓" if rec.get("ai") else ""}')
    # 寫回 cc_deep(按場次月份)
    by_m = {}
    for rec in new_recs:
        by_m.setdefault((rec.get('d') or '0000-00')[:7], []).append(rec)
    for m, lst in by_m.items():
        p = month_file(m + '-01')
        old = _load_json(p, [])
        keep = {x.get('f'): x for x in old}
        for rec in lst:
            keep[rec['f']] = rec
        _save_json(p, sorted(keep.values(), key=lambda x: (x.get('d') or '', x.get('f') or '')))
    idx['updated'] = datetime.now(TW).isoformat(timespec='minutes')
    _save_json(CC / 'cc' / 'index.json', idx)
    wrote, nd = build_outputs(touched, rows_by_sym, today)
    log(f'📦 讀成功 {n_ok} 份 ・失敗 {n_fail} ・AI 摘要 {ai_used} 次 ・寫了 {wrote} 檔 data/cc/ ・清單 {nd} 場')
    if todo and n_ok == 0 and n_fail >= 5:
        log('❌ 一份都沒讀到而且連續失敗 → 紅燈(⛔ 不可全綠沒資料)')
        return 1
    return 0


def _keys():
    raw = os.getenv('GROQ_API_KEYS') or os.getenv('GROQ_API_KEY') or ''
    return [k.strip() for k in re.split(r'[,\s]+', raw) if k.strip()]


def selftest():
    fails = []
    def ok(n, c, e=''):
        print(('✅ ' if c else '❌ ') + n + ('' if c else f'  {e}'))
        if not c:
            fails.append(n)
    ok('① 檔名解析', file_meta('233020260716M001.pdf') == {'sym': '2330', 'fd': '2026-07-16', 'lang': 'M', 'ext': 'pdf'}, file_meta('233020260716M001.pdf'))
    ok('①b 認不得的檔名 → None', file_meta('abc.pdf') is None and file_meta('233020261341M001.pdf') is None)
    ok('② 挑中文 pdf/pptx、沒有才英文;舊 ppt 標原因', pick_deck(['233020260716E001.pdf', '233020260716M001.pdf']) == ('233020260716M001.pdf', '')
       and pick_deck(['233020260716E001.pptx']) == ('233020260716E001.pptx', '') and pick_deck(['233020260716M001.ppt'])[1] == 'ppt_old')
    pages = ['台積公司\n2026 第三季法說會\n營收 9,000 億元,季增 10%\n毛利率 59.5%', '台積公司\n展望\n預期第四季營收 9,500~9,800 億元\n先進封裝 CoWoS 產能倍增',
             '台積公司\n機器人與矽光子是新的成長來源\n資本支出 420 億美元', '台積公司\n風險:匯率不確定\n謝謝']
    L = page_lines(pages)
    ok('③ 頁首重複的公司名拿掉', all(ln != '台積公司' for _, ln in L), L[:3])
    ol = outlook_of(L)
    ok('③b 展望句帶頁碼', any(p == 2 and '預期第四季營收' in t for p, t in ol), ol)
    nm = nums_of(L)
    ok('③c 數字句帶頁碼(營收 / 毛利率 / 資本支出)', any(p == 1 and '毛利率' in t for p, t in nm) and any(p == 3 and '資本支出' in t for p, t in nm), nm)
    tm = terms_of(pages)
    ok('④ 詞庫 + 縮寫:CoWoS / 先進封裝 / 機器人 / 矽光子', all(k in tm for k in ('CoWoS', '先進封裝', '機器人', '矽光子')), tm)
    new, dropped = novelty(tm, [{'CoWoS': 1, '先進封裝': 1, 'AI': 2}], set())
    ok('④b 第一次提到 = 前幾份沒有的(CoWoS 不算新、機器人算)', new is not None and '機器人' in new and 'CoWoS' not in new and 'AI' in dropped, (new, dropped))
    ok('④c ⭐ 決定性對照:沒有上一份 → 回 None(⛔ 不可說「新」)', novelty(tm, [], set())[0] is None)
    ok('④d 大家都在講的詞 ⛔ 不算新', '機器人' not in novelty(tm, [{'CoWoS': 1}], {'機器人'})[0])
    src = 'p1 營收 9000 億元,季增 10%\np2 預期第四季營收 9,500~9,800 億元'
    ok('⑤ 數字核對:原文有的過、編的抓到', num_gate('營收 9,000 億、季增 10%', src) == [] and num_gate('營收成長 25%', src) == ['25'], num_gate('營收成長 25%', src))
    clean, dr = gate_ai({'one': '第四季營收 9,500~9,800 億', 'outlook': [{'t': '毛利率 61%', 'p': 2}, {'t': '先進封裝擴產', 'p': 2}], 'new': [], 'risk': []}, src)
    ok('⑤b ⭐ 決定性對照:AI 編的那一點整點丟掉、其他留著', dr == 1 and clean['one'] and [x['t'] for x in clean['outlook']] == ['先進封裝擴產'], (clean, dr))
    ok('⑥ AI 回 ```json 包起來 / <think> 也解析得到', parse_ai_json('<think>x</think>```json\n{"one":"a"}\n```') == {'one': 'a'})
    ok('⑦ 語氣計數(研究用)', tone_of([[1, '營收成長、創新高'], [2, '保守看待庫存去化']]) == [2, 2], tone_of([[1, '營收成長、創新高'], [2, '保守看待庫存去化']]))
    # pptx 抽字(零依賴)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>第二張</a:t></a:r></a:p></p:sld>')
        z.writestr('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>展望 &amp; 目標</a:t></a:r></a:p><a:p><a:r><a:t>AI 伺服器</a:t></a:r></a:p></p:sld>')
    pp = extract_pptx(buf.getvalue())
    ok('⑧ pptx 照投影片順序抽字、XML 字元還原', pp == ['展望 & 目標\nAI 伺服器', '第二張'], pp)
    print('\n' + ('❌ selftest 失敗 %d 條' % len(fails) if fails else '✅ confcall_deck selftest 全過'))
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(run(groq_keys=_keys()))
