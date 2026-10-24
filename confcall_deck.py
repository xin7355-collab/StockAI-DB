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

📚 回補舊簡報(V79.6.3,使用者鐵則「要馬上就能用的,不是還要等好幾天」):
   「這次第一次提到」要跟這家公司前幾份比 → 只讀最近 60 天的話,上線後要等下一季才有得比。
   → 手動給起訖月(CC_LIST_FROM / CC_LIST_TO)時,先用 confcall_miner.fetch_market 一個月一個月查舊場次表
     (含簡報檔名)存進 cc_deep/cc/backlog.json.gz;讀的順序 = ① 最近 60 天 ② 這些公司前 4 份 ③ 其他(新 → 舊)。
     讀不完就寫 GITHUB_OUTPUT more=1 → workflow 自己接力下一棒(⛔ 被擋 / 只剩暫時性失敗不接)。
   「第一次提到」每輪從全部特徵重算(novelty_all,⛔ 不存進特徵檔)→ 回補讀到更舊的,新簡報的結果自動變準;
   同一份簡報被好幾場引用 → 日期一律用最早那場(fix_dates)。

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
import shutil
import subprocess
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
DL_MAX_SEC = float(os.getenv('CC_DL_MAX_SEC') or 240)   # 不知道檔案多大時:一份簡報(含重試)最多下載幾秒 —— 下載程式實測約 30 KB/s,4 MB 要 2 分多(120 秒那版 12 份斷 5 份)
# 📏 V79.6.4 下載提速 知道檔案多大(Content-Length)時,時限照大小算:大小 ÷ DL_FLOOR_KBS,介於 DL_MAX_SEC ~ DL_BIG_MAX_SEC
#    10/23 第 4 輪:8~16 MB 的大簡報檔案路徑 23~55 KB/s,固定 240 秒一律下載不完 → 4 份整份放棄、40 分鐘白花 18 分
#    ⏱️ 上限 10 分:一輪 40 分才停止開新的一份 + 這份 10 分 + 抽字 1 分 + AI 40 秒 + 推檔 ≈ 53 分 < job 時限 60 分
DL_FLOOR_KBS = float(os.getenv('CC_DL_FLOOR_KBS') or 20)
DL_BIG_MAX_SEC = float(os.getenv('CC_DL_BIG_MAX_SEC') or 600)
DL_READ = float(os.getenv('CC_DL_READ') or 20)          # 一次讀取最多等幾秒沒有收到東西
# 🔀 V79.6.4 下載提速 檔案路徑分幾段同時下載(deck_dl_probe 10/23 實測:一條連線 19~37 KB/s、四條合計 69~149 KB/s,
#    主機是「每條連線限速」);只對 > DL_SPLIT_MIN 的檔、每段至少 DL_SEG_MIN。CC_DL_CONN=1 = 回到一條連線(逃生門)
DL_CONN = int(os.getenv('CC_DL_CONN') or 4)
DL_SPLIT_MIN = 1024 * 1024
DL_SEG_MIN = 512 * 1024
DL_SEG_TRIES = 3              # 一段斷線最多續傳幾次
DL_BACKOFF = (0, 2, 5)        # 一份簡報最多試 3 次(⛔ 舊版 5 次 × 60 秒)
EXTRACT_MAX_SEC = float(os.getenv('CC_EXTRACT_MAX_SEC') or 60)   # 一份簡報最多抽幾秒字(pypdf 遇到很複雜的頁面會卡好幾分鐘)
MAX_PAGES = 80
KEEP_PER_SYM = 4
DIGEST_DAYS = 60
PREV_DECKS = 4                # 「第一次提到」跟這家公司前幾份比
COMMON_SHARE = 0.20           # 這一季超過兩成公司都在講的詞 ⛔ 不算「新」
COMMON_MIN_DECKS = 30         # 樣本太少就不判「大家都在講」
TRANSIENT_TRIES = 3           # 下載失敗(暫時性)最多試幾輪
NOT_FILE_GRACE = 3            # 開完 3 天內「回網頁」多半是還沒上傳 → 當暫時性失敗(之後再試);更舊的才當永久
# 🛡️ V79.6.4 巡邏:主機擋機器人時回 200 + 一頁「因為安全性考量…」(confcall_miner 實測同一句)→ ⛔ 不可當成「檔案不在」
#    (舊版把它算成 not_file → 開完超過 3 天的簡報一被擋就永久標 bad_file、而且不算連續失敗 → 擋多久就白問多久)
BLOCK_MARKS = ('因為安全性考量', 'CAN NOT BE ACCESSED', 'CANNOT BE ACCESSED', 'Request Rejected')
BLOCK_STOP = 3                # 連幾份被擋 → 本輪收工(⛔ 硬打)
BLOCK_BACKOFF = (10, 20, 40)  # 被擋之後下一份先等幾秒(指數退避)
IDX_VER = 2                   # cc/index.json 的格式版本(升版時 run() 開頭搬一次舊紀錄)
LIST_FROM = os.getenv('CC_LIST_FROM') or ''          # 📚 回補舊簡報清單的起訖月(YYYY-MM;手動 / 第一棒才給)
LIST_TO = os.getenv('CC_LIST_TO') or ''
LIST_RETRY_MAX = 6            # 上次沒抓齊的月份,每輪最多重抓幾個
LIST_PACE = float(os.getenv('CC_LIST_PACE') or 2.0)   # 🐢 查清單時兩次查詢之間多等幾秒(MOPS 對機器人敏感)
# 受邀參加券商 / 投顧辦的場次(⛔ 不是公司自己辦的)—— 從官方「擇要訊息」判斷
INV_RE = re.compile(r'受邀|邀請|應邀|參加.{0,24}(證券|投顧|銀行|金控|論壇|研討會|峰會|投資人會議)')
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
    # V79.6.3 第一輪實跑:通用的「英文 + 數字代號」抓到一堆廠區 / 料號(Y19、CB02、H007)→ 拿掉那條,常見的 AI 產品代號改列在這裡
    'GB200', 'GB300', 'B200', 'B300', 'H100', 'H200', 'H20', 'MI300', 'MI350', 'Blackwell', 'Rubin', 'NVLink', 'SOCAMM', 'LPDDR5', 'DDR6', 'HBM4', 'HBM3E',
]
_EN_STOP = {
    'EPS', 'YOY', 'QOQ', 'MOM', 'Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2', 'FY', 'IR', 'TWD', 'NTD', 'NT', 'USD', 'RMB', 'CEO', 'CFO',
    'COO', 'CTO', 'IFRS', 'PDF', 'LTD', 'INC', 'CO', 'CORP', 'TEL', 'FAX', 'HTTP', 'HTTPS', 'WWW', 'COM', 'TW', 'ROC', 'ROE',
    'ROA', 'GM', 'OP', 'OPM', 'NP', 'YTD', 'TTM', 'KPI', 'ESG', 'Q', 'M', 'K', 'B', 'NO', 'OK', 'THE', 'AND', 'FOR', 'OF',
    'IN', 'TO', 'ON', 'BY', 'AT', 'AS', 'IS', 'BE', 'OR', 'AN', 'A', 'I', 'II', 'III', 'IV', 'V', 'VS', 'ETC', 'AGM', 'SEC',
    'TWSE', 'TPEX', 'MOPS', 'GAAP', 'NON', 'TBD', 'NA', 'N', 'E', 'P', 'F', 'R', 'S', 'T', 'U', 'X', 'Y', 'Z', 'C', 'D', 'G', 'H',
    'L', 'O', 'W', 'J', 'MAP', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
    # V79.6.3 第一輪實跑抓到的雜訊:財務 / ESG / 機構 / 國家縮寫(⛔ 產品詞)
    'CAGR', 'ASP', 'ISO', 'RBA', 'SDG', 'SDGS', 'GHG', 'CDP', 'TCFD', 'SBTI', 'TNFD', 'OECD', 'IMF', 'GDP', 'CPI', 'PMI', 'DGBAS',
    'USA', 'EU', 'US', 'UK', 'APAC', 'EMEA', 'CEO', 'VP', 'SVP', 'EVP', 'CSR', 'ERP', 'BOD', 'NAV', 'PE', 'PB', 'PER', 'DPS', 'CNY',
    'JPY', 'EUR', 'KRW', 'YEN', 'QTD', 'MTD', 'BU', 'IRR', 'NPV', 'EBIT', 'EBITDA', 'CAPEX', 'OPEX', 'CASH', 'FCF', 'WACC', 'LTM',
    'STOCK', 'CODE', 'NOTE', 'NOTES', 'TOTAL', 'OTHER', 'OTHERS', 'MARKET', 'SALES', 'GROSS', 'NET', 'PROFIT', 'INCOME', 'ASSET',
    # 投資人關係聯絡頁常見的姓氏拼音(⛔ 產品詞)
    'CHEN', 'LIN', 'HUANG', 'CHANG', 'LEE', 'WANG', 'WU', 'LIU', 'TSAI', 'YANG', 'HSU', 'CHENG', 'KUO', 'HUNG', 'TSENG', 'CHIU',
    'LIAO', 'LAI', 'HSIEH', 'YEH', 'CHOU', 'CHU', 'CHIANG', 'SU', 'LU', 'KAO', 'HO', 'LO', 'TU', 'SHIH', 'CHIEN', 'PAN', 'FANG',
}
OUTLOOK_RE = re.compile(r'展望|預期|預估|預計|目標|看好|指引|後市|下半年|明年|outlook|guidance|expect|forecast|target', re.I)
KPI_RE = re.compile(r'營收|毛利率|營業利益率|營益率|營業利益|淨利|稅後|EPS|每股盈餘|資本支出|產能|稼動率|出貨|訂單|在手訂單|單價|ASP|'
                    r'市占|revenue|gross margin|operating margin|net income|capex|capacity|utilization|shipment|backlog', re.I)
NUM_RE = re.compile(r'\d[\d,]*(?:\.\d+)?\s*(?:%|％|億|萬|元|倍|x|X|kW|MW|GW|nm|吋|片|台|K|M|B)?')
# 免責聲明 / 前瞻性陳述那一頁一定有「expect / 預期」→ ⛔ 不可當成公司的展望
DISCLAIM_RE = re.compile(r'forward[- ]looking|safe harbor|undertakes no obligation|uncertaint|免責|前瞻性|僅供參考|不代表|聲明|風險與不確定|'
                         r'預測性資訊|預測性陳述|未來的看法|截至目前為止|不負.{0,6}更新|更新或修正|實際結果|可能與.{0,8}不同|'
                         r'actual results|no obligation|without notice', re.I)
# 註腳 / 資料來源 / 參考 —— ⛔ 不是公司的話(10/23 實跑:「註:時程預期可能因主管機關審核…」「* Ref : Boeing … OUTLOOK」)
NOTE_RE = re.compile(r'^\s*(註|＊|\*|※|資料來源|來源|出處|Source|Ref\b|Note\b|Notes\b)', re.I)
# 只有標題字(「2026 年第 4 季市場展望」「營運展望」)⛔ 不算一句話
TITLE_RE = re.compile(r'(展望|規劃|計畫|計劃|目標|策略|outlook|guidance|plan)\s*$', re.I)
# 總經背景(OECD / IMF / 全球經濟 …)⛔ 是公司自己的展望 —— 挑「最有代表性的一句」時排後面
MACRO_RE = re.compile(r'OECD|IMF|世界銀行|全球經濟|經濟成長|經濟展望|GDP|通膨|聯準會|Fed\b|利率|主計總處', re.I)
COMPANY_RE = re.compile(r'本公司|公司|我們|集團|本集團|營收|訂單|產能|出貨|客戶|新產品|量產')
POS_RE = re.compile(r'成長|增加|提升|強勁|優於|創新高|新高|擴產|樂觀|回溫|復甦|看好|倍增|growth|increase|strong|record|recover', re.I)
NEG_RE = re.compile(r'下滑|減少|衰退|疲弱|保守|審慎|謹慎|調整|庫存去化|逆風|不確定|放緩|下修|decline|decrease|weak|cautious|headwind|soft', re.I)
_THEME_RES = [(t, re.compile((r'(?<![A-Za-z])' + re.escape(t) + r'(?![A-Za-z])') if re.match(r'^[\x00-\x7f ]+$', t) else re.escape(t), re.I))
              for t in THEMES]
# ⚠️ V79.6.3 第一輪實跑:舊樣式抓到人名(CHIEN-HUNG)、英文單字(COMMERCIAL / MARKET / OUTLOOK)、廠區料號(Y19 / CB02 / H007)、
#    StockCode 這種混大小寫 → 只收「3~5 個大寫字母」的縮寫;2 個字母 / 混大小寫 / 英文加數字一律只認詞庫裡的(GaN / CoWoS / GB200…)
_EN_TOKEN = re.compile(r'(?<![A-Za-z0-9\-])[A-Z]{3,5}(?![A-Za-z0-9\-])')

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


def file_urls(tpl, name):
    """兩條官方下載路:① 下載程式(FileDownLoad)② 檔案原本的路徑(filePath 是 /home/html/nas/STR/ → 網站上的 /nas/STR/)。
    ⛔ 第二條拼不出來(樣板沒有 filePath)就只給第一條;兩條回來的東西都要驗檔頭。"""
    out = [('srv', file_url(tpl, name))]
    t = tpl if (tpl and tpl.get('path')) else FILE_FALLBACK
    m = re.search(r'/html(/[^?#]+/)$', str((t.get('q') or {}).get('filePath') or ''))
    if m and re.fullmatch(r'[0-9A-Za-z_.-]+', name or ''):
        out.append(('nas', f"{t.get('host') or FILE_FALLBACK['host']}{m.group(1)}{name}"))
    return out


_PUA_RE = re.compile('[\ue000-\uf8ff\ufffd]')


def _clean(s):
    s = _html.unescape(str(s or '')).replace('　', ' ').replace('\xa0', ' ')
    s = _PUA_RE.sub('', s)          # 🔣 PDF 字型的私用區字元(項目符號 \uf06e、\uf0b7…)在手機上是方框(V79.6.4 巡邏)
    s = re.sub(r'[ \t]+', ' ', s)
    return s


def extract_pdf(b):
    """⚡ 先用 pdftotext(poppler,C 寫的,中文簡報比 pypdf 快好幾倍;workflow 會裝);沒有才退回 pypdf。
    🐢 pdftotext 也有時限(比整份抽字的時限早 5 秒 → 子程序自己砍掉它,⛔ 不留孤兒程序)。"""
    exe = shutil.which('pdftotext')
    if exe:
        try:
            r = subprocess.run([exe, '-q', '-enc', 'UTF-8', '-l', str(MAX_PAGES), '-', '-'], input=b,
                               capture_output=True, timeout=max(5.0, EXTRACT_MAX_SEC - 5))
        except subprocess.TimeoutExpired:
            raise
        except Exception:                                    # noqa: BLE001 —— 叫不起來就退回 pypdf
            r = None
        if r is not None and r.returncode == 0:
            parts = r.stdout.decode('utf-8', 'ignore').split('\f')
            if parts and not parts[-1].strip():
                parts = parts[:-1]                           # 每頁後面都有一個換頁符號 → 最後一段是空的
            return [_clean(x) for x in parts[:MAX_PAGES]]
    import logging
    logging.getLogger('pypdf').setLevel(logging.ERROR)       # 「EOF marker not found」這類警告 ⛔ 灌爆紀錄
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


def _extract_worker(b, q):
    """子程序裡抽字(卡住可以整個砍掉;⛔ 不可在主程序裡等一個不會回來的 pypdf)。"""
    try:
        q.put(('ok', extract_pptx(b) if b[:2] == b'PK' else extract_pdf(b)))
    except Exception as e:                                   # noqa: BLE001 —— 抽不出來就回原因
        q.put(('err', type(e).__name__))


def extract_safe(b, timeout=None):
    """回 (pages, '') 或 (None, 原因)。超過時限 → 砍掉子程序回 'timeout'。"""
    import multiprocessing as mp
    timeout = EXTRACT_MAX_SEC if timeout is None else timeout
    ctx = mp.get_context('fork') if 'fork' in mp.get_all_start_methods() else mp.get_context()
    q = ctx.Queue()
    p = ctx.Process(target=_extract_worker, args=(b, q), daemon=True)
    p.start()
    try:
        kind, val = q.get(timeout=timeout)
    except Exception:                                        # noqa: BLE001 —— queue.Empty = 卡住
        p.terminate()
        p.join(2)
        return None, 'timeout'
    p.join(2)
    return (val, '') if kind == 'ok' else (None, val)


_BULLET_RE = re.compile(r'^\s*([●•▪■◆◇○◎★☆※\-–—*]|\(?\d{1,2}[.、)]|[一二三四五六七八九十]+[、.]|[A-Za-z][.)]\s)')
_END_RE = re.compile(r'[。！？!?；;：:]\s*$')


def _join_wrapped(raw):
    """🧩 PDF 一行一行斷的句子接回來(10/23 實跑:「…全球經濟面臨「科技投資強勁、」被切在半句)。
    只接「長的那一行沒有句尾符號、下一行也不是新的條列」;表格那種短格子 ⛔ 接(會接成一串數字)。接完再照句號切開。"""
    units, cur = [], ''
    for ln in raw:
        # 下一行也要夠長(≥8 字)或自己就是句尾 —— 表格格子(「營收」「1,234」)⛔ 被接進上一句
        if (cur and len(cur) >= 18 and not _END_RE.search(cur) and not _BULLET_RE.match(ln) and len(cur) + len(ln) <= 300
                and (len(ln) >= 8 or _END_RE.search(ln))):
            sep = ' ' if (re.search(r'[A-Za-z0-9,]$', cur) and re.match(r'[A-Za-z0-9]', ln)) else ''
            cur = cur + sep + ln
        else:
            if cur:
                units.append(cur)
            cur = ln
    if cur:
        units.append(cur)
    out = []
    for u in units:
        out.extend(x for x in re.split(r'(?<=[。！？；])\s*', u) if x)
    return out


def page_lines(pages):
    """[(頁碼, 一句)…];PDF 斷行接回整句;頁首頁尾那種每頁都出現的行(公司名、免責聲明)拿掉。"""
    per = []
    for i, t in enumerate(pages):
        raw = []
        for ln in re.split(r'[\r\n]+', t or ''):
            ln = ln.strip(' •·●▪-–—|')
            if 2 <= len(ln) <= 220 and not re.fullmatch(r'[\d\s/.:\-]+', ln):
                raw.append(ln)
        ls = [x.strip() for x in _join_wrapped(raw) if 2 <= len(x.strip()) <= 300]
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


def _not_said(s):
    """⛔ 不是公司說的話:免責聲明 / 註腳 / 資料來源。"""
    return bool(DISCLAIM_RE.search(s) or NOTE_RE.search(s))


def _is_title(s):
    t = re.sub(r'\s', '', s)
    return len(t) <= 20 and bool(TITLE_RE.search(s)) and not re.search(r'[,，。;；]', s)


def outlook_of(lines, limit=8):
    # ⛔ 只有標題字(「展望」「Outlook」「2026 年第 4 季市場展望」)不算一句話;⛔ 免責聲明 / 註腳不算
    return _pick(lines, lambda s: bool(OUTLOOK_RE.search(s)) and not _not_said(s) and not _is_title(s)
                 and len(re.sub(r'\s', '', s)) >= 8, limit)


# 不算「數字」的數字:年份 / 年月(2026、2026/09、2026年3月)、民國年(115年)、季別(Q3 / 3Q / H1)、晶圓尺寸(12吋)、條列編號(「5. 」)
_NOFIG_RES = [re.compile(r'(?<!\d)(19|20)\d\d(?:\s*[/\-.年]\s*(?:0?[1-9]|1[0-2])(?!\d)\s*月?)?(?:\s*年|Q[1-4]|H[12]|E)?(?!\d)'),
              re.compile(r'(?<!\d)1[01]\d\s*年'), re.compile(r'(?<![A-Za-z0-9])(?:[1-4]Q|Q[1-4]|H[12])(?![A-Za-z0-9])'),
              re.compile(r'\d{1,2}\s*(?:吋|英寸|inch)'), re.compile(r'^\s*\d{1,2}[.、)]\s*')]


def _has_figure(s):
    """有真的數字(10/23 實跑:「2025 Sales Revenue」「截至2026/09未交貨訂單」「115年資本支出計畫」「出貨片數(約當12吋)」都只是標題)"""
    for rx in _NOFIG_RES:
        s = rx.sub(' ', s)
    return bool(re.search(r'\d', s))


def nums_of(lines, limit=10):
    return _pick(lines, lambda s: bool(KPI_RE.search(s)) and _has_figure(s) and len(re.sub(r'\s', '', s)) >= 6 and not _not_said(s), limit)


def _cjk_share(texts):
    """幾成的句子是中文(一句有 ≥4 個中文字)—— ⚠️ 不用字數比:一個中文字抵兩三個英文字母,雙語簡報用字數比會被判成英文簡報"""
    texts = [t for t in texts if t]
    return sum(1 for t in texts if len(re.findall(r'[\u4e00-\u9fff]', t)) >= 4) / max(1, len(texts))


def _mostly_ascii(t):
    letters = re.sub(r'[\s\d\W_]', '', t)
    return len(letters) >= 8 and sum(1 for ch in letters if ch.isascii()) / len(letters) >= 0.8


def drop_translation(lines):
    """🌐 中文簡報裡的英文翻譯(10/23 實跑:同一頁每一句都有一句英文版)→ 中文為主的簡報才拿掉「幾乎全英文」的那幾句;
    ⛔ 英文簡報不動。"""
    if _cjk_share([t for _, t in lines]) < 0.3:
        return lines
    return [(p, t) for p, t in lines if not _mostly_ascii(t)]


def _ol_score(t):
    return (2 if _has_figure(t) else 0) + (2 if KPI_RE.search(t) else 0) + (1 if COMPANY_RE.search(t) else 0) - (3 if MACRO_RE.search(t) else 0)


def rank_outlook(outlook):
    """講到「之後」的句子照「有數字 / 講營運 / 講公司」排前面、總經背景排後面(同分照頁碼);⛔ 改寫原文"""
    return [x for _, _, x in sorted(((-_ol_score(x[1]), i, x) for i, x in enumerate(outlook)), key=lambda z: (z[0], z[1]))]


def best_outlook(outlook):
    """清單上那一句「公司講到之後」:有數字 / 講營運的優先,總經背景排後面(⛔ 改寫原文,只是挑一句)。"""
    r = rank_outlook(outlook or [])
    return r[0] if r else None


def terms_of(pages):
    """這份簡報講到的「產品 / 應用 / 技術」詞:詞庫命中 + 英文縮寫 / 產品代號。回 {詞: 第一次出現的頁}。"""
    out = {}
    for i, t in enumerate(pages):
        if not t:
            continue
        for term, rx in _THEME_RES:
            if term not in out and rx.search(t):
                out[term] = i + 1
        for tk in _EN_TOKEN.findall(t):
            if tk in _EN_STOP:
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
_SRC_PAGE = re.compile(r'(?m)^p\d+ ')                                   # ai_prompt 每行開頭的頁碼標籤「p12 」
_AI_PAGE = re.compile(r'(?<![A-Za-z])[pP]\.?\s?\d+|第\s*\d+\s*頁')        # AI 自己在句子裡寫的頁碼(⛔ 算數字主張)


def _num_norm(n):
    v = n.replace(',', '').rstrip('.')
    if '.' in v:
        v = v.rstrip('0').rstrip('.')          # 53.10 = 53.1、5.0 = 5
    return v


def num_gate(text, source):
    """AI 寫的每個數字都要在原文找得到;回缺的那幾個(空 list = 過關)。⛔ 1 位數也查。
    🧾 V79.6.4 巡邏:**整個數字比對**(⛔ 子字串)—— 舊版「20」在「2026」裡、「5」在頁碼標籤「p5」裡都算找得到
       → AI 編的「成長 20%」照樣過關。現在:原文先拿掉每行開頭的頁碼標籤再切成一個一個數字;
       AI 句子裡自己寫的頁碼(p5 / P.5 / 第 5 頁)不算數字主張。"""
    have = {_num_norm(n) for n in _NUM_ONLY.findall(_SRC_PAGE.sub('', re.sub(r'(?<=\d),(?=\d)', '', source or '')))}
    miss = []
    for n in _NUM_ONLY.findall(_AI_PAGE.sub(' ', text or '')):
        v = _num_norm(n)
        if v and v not in have:
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
            '"new":[{"t":"新的產品 / 應用 / 客戶 / 投資","p":頁碼}],'
            # 🧭 V79.6.6 南亞 10/23:「中東產能受損、乙二醇到港量受影響」被列成風險 —— 那是對手的事,對南亞是報價有撐 → 方向讀反
            '"risk":[{"t":"公司說對自己不利、會變差或講得保守的地方(⛔ 對手停產、產品缺貨、報價上漲這種對公司有利的不算;'
            '原料缺、成本漲、需求變弱、價格跌才算)","p":頁碼}]},'
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
    # 🧾 免責聲明那一頁(同一頁 ≥2 行在講「預測性資訊 / 實際結果可能不同」)整頁拿掉 —— 一句一句擋會漏(10/23 實跑兩份漏掉)
    dpg = {}
    for p, ln in lines:
        if DISCLAIM_RE.search(ln):
            dpg[p] = dpg.get(p, 0) + 1
    lines = [(p, ln) for p, ln in lines if dpg.get(p, 0) < 2]
    lines = drop_translation(lines)
    ol = rank_outlook(outlook_of(lines))
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
    if p.suffix == '.gz':
        try:
            with gzip.open(p, 'rt', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return dflt
    # 🩺 10/24:data/confcall.json 被寫成「完整 JSON + 舊版的尾巴」→ 舊寫法整份讀不到 → 這輪不做、接力斷掉
    #    → 尾巴多一段就用前面那份完整的(lib_jsonsafe,同 confcall_miner / pick_snapshot)
    from lib_jsonsafe import load_json_safe
    j, st, _ = load_json_safe(p, dflt, what=p.name)
    return j if st in ('ok', 'salvaged') else dflt


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


def load_all():
    """cc_deep 讀過的全部簡報特徵 → {YYYY-MM: [rec…]}。
    ⚠️ 全部載進記憶體:「第一次提到」要跟這家公司前幾份比、「大家都在講的詞」要看前 100 天全市場,
       只能一起算。量級:2021-07 起約 1.2 萬份 × 每份約 4KB → 約 50MB JSON(runner 7GB 夠;⛔ 不在 1GB 小主機跑)。"""
    out = {}
    d = CC / 'cc' / 'feat'
    if d.exists():
        for p in sorted(d.glob('*.json.gz')):
            out[p.name[:7]] = [refilter(r) for r in _load_json(p, [])]
    return out


_THEME_SET = set(THEMES)


def _term_ok(t):
    return t in _THEME_SET or (bool(re.fullmatch(r'[A-Z]{3,5}', t or '')) and t not in _EN_STOP)


def refilter(rec):
    """🧾 以前版本抽的特徵(cc_deep 存的)照現在的規則再篩一次 —— 冪等、⛔ 不重新下載。
    (10/23 第一輪用舊規則讀了一批:免責聲明 / 註腳被當成展望、人名料號被當成產品詞;同一頁的免責整頁拿掉那條補不回來)"""
    if not isinstance(rec, dict) or rec.get('st') != 'ok':
        return rec
    # 🔣 V79.6.4:以前抽的字留著 PDF 私用區字元(手機上是方框)→ 照現在的 _clean 再洗一次(冪等)
    for k in ('outlook', 'nums', 'titles'):
        v = rec.get(k)
        if isinstance(v, list):
            rec[k] = [[x[0], re.sub(r'[ \t]+', ' ', _PUA_RE.sub('', str(x[1]))).strip()] for x in v
                      if isinstance(x, (list, tuple)) and len(x) == 2 and _PUA_RE.sub('', str(x[1])).strip()]
    ol = [x for x in (rec.get('outlook') or []) if isinstance(x, (list, tuple)) and len(x) == 2 and not _not_said(x[1]) and not _is_title(x[1])]
    nm = [x for x in (rec.get('nums') or []) if isinstance(x, (list, tuple)) and len(x) == 2 and not _not_said(x[1]) and _has_figure(x[1])
          and len(re.sub(r'\s', '', x[1])) >= 6]
    if _cjk_share([t for _, t in ol + nm + [x for x in (rec.get('titles') or []) if isinstance(x, (list, tuple)) and len(x) == 2]]) >= 0.3:
        ol = [x for x in ol if not _mostly_ascii(x[1])]
        nm = [x for x in nm if not _mostly_ascii(x[1])]
    ol = rank_outlook(ol)
    rec['outlook'], rec['nums'] = ol, nm
    rec['terms'] = {k: v for k, v in (rec.get('terms') or {}).items() if _term_ok(k)}
    rec['tone'] = tone_of(ol)
    return rec


def backlog_path():
    return CC / 'cc' / 'backlog.json.gz'


def load_backlog():
    bl = _load_json(backlog_path(), None)
    if not isinstance(bl, dict) or not isinstance(bl.get('rows'), list):
        bl = {'months': {}, 'rows': []}
    bl.setdefault('months', {})
    return bl


def months_between(a, b):
    """'2021-07','2021-09' → [(2021,7),(2021,8),(2021,9)];格式錯 / 反了 → []。"""
    try:
        y, m = int(a[:4]), int(a[5:7])
        y2, m2 = int(b[:4]), int(b[5:7])
    except (ValueError, TypeError):
        return []
    out = []
    while (y, m) <= (y2, m2) and len(out) < 240:
        out.append((y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def compact_row(r):
    x = {'s': str(r.get('s')), 'name': r.get('name') or '', 'mkt': r.get('mkt') or '', 'd': r.get('d'), 't': r.get('t') or '',
         'pdf': list(r.get('pdf') or []), 'inv': 1 if INV_RE.search(r.get('sum') or '') else 0}
    if r.get('vid'):
        x['vid'] = r['vid']
    return x


def list_backfill(bl, months, today, fetch=None, log=print, sleeper=time.sleep):
    """📚 一個月一個月查公開資訊觀測站的法說會一覽表(上市 + 上櫃)→ 有簡報檔名、已經開完的場次併進 backlog。
    ⛔ 某個月沒抓齊 → 不標「做完」(下一輪自動重抓);連 3 個月都抓不到 → 收手(多半被擋,⛔ 不硬打)。
    回 (新增幾場, 沒抓齊的月份)。"""
    if fetch is None:
        import requests
        import confcall_miner
        sess = requests.Session()
        fetch = lambda typek, ym: confcall_miner.fetch_market(typek, today, sess, months=[ym])
    have = {(r['s'], r['d'], r.get('t') or '') for r in bl['rows']}
    done = bl.setdefault('months', {})
    t = today.isoformat()
    added, bad, streak = 0, [], 0
    for (y, m) in months:
        key = f'{y}-{m:02d}'
        if (done.get(key) or {}).get('ok'):
            continue
        got, n_rows, errs = 0, 0, []
        for typek in ('sii', 'otc'):
            try:
                rows, err = fetch(typek, (y, m))
            except Exception as e:                 # fetch_market 自己有 try;這裡防假的 / 未來改壞
                rows, err = [], f'{type(e).__name__}'
            if err:
                errs.append(f'{typek}:{str(err)[:60]}')
            else:
                got += 1
            n_rows += len(rows or [])
            for r in rows or []:
                if not r.get('pdf') or not r.get('d') or r['d'] >= t:
                    continue
                k = (str(r['s']), r['d'], r.get('t') or '')
                if k in have:
                    continue
                have.add(k)
                bl['rows'].append(compact_row(r))
                added += 1
            sleeper(LIST_PACE)      # 🐢 兩次查詢之間多等(MOPS 對機器人敏感;fetch_market 自己也有退避)
        ok_m = got == 2 and n_rows > 0
        done[key] = {'ok': ok_m, 'n': n_rows, 'at': datetime.now(TW).isoformat(timespec='minutes')}
        log(f'  📚 {key}:{n_rows} 場' + ('' if ok_m else f' ⚠️ 沒抓齊({"; ".join(errs) or "0 場"}),下一輪再抓'))
        if ok_m:
            streak = 0
        else:
            bad.append(key)
            streak += 1
            if streak >= 3:
                # 📌 V79.6.4 巡邏:還沒輪到的月份也要記「沒抓齊」—— 接力那幾棒 ⛔ 不帶起訖月(只重抓「記著沒抓齊」的),
                #    不記的話這幾個月就永遠沒人查(舊版:連 3 個月被擋 → 後面的月份從此消失)
                rest = [f'{yy}-{mm:02d}' for (yy, mm) in months[months.index((y, m)) + 1:]]
                for k2 in rest:
                    if not (done.get(k2) or {}).get('ok'):
                        done[k2] = {'ok': False, 'n': 0, 'at': datetime.now(TW).isoformat(timespec='minutes'), 'skip': 1}
                        bad.append(k2)
                log('🛑 連 3 個月抓不到(可能被擋)→ 清單回補先停,下一輪再接' + (f'(還沒查的 {len(rest)} 個月記下來,之後每輪重抓幾個)' if rest else ''))
                break
    bl['updated'] = datetime.now(TW).isoformat(timespec='minutes')
    return added, bad


def migrate_index(idx):
    """cc/index.json 舊格式搬一次(冪等:搬過就記 v)。回一句說明(沒搬回 '')。
    v2(V79.6.4 巡邏):① 舊版把「被擋」那一頁也當成檔案不在 → bad_file 全部重新判一次(真的不在的,下一次一樣會標回去)
                    ② 下載路換了(先走檔案路徑)→ 以前因為「太慢」失敗的重新算次數。"""
    if (idx.get('v') or 1) >= IDX_VER:
        return ''
    files = idx.setdefault('files', {})
    nb = nr = 0
    for f in list(files):
        st = files[f] or {}
        if st.get('st') == 'bad_file':
            del files[f]
            nb += 1
        elif st.get('st') == 'dl_fail' and 'slow:' in str(st.get('err') or ''):
            st['tries'] = 0
            st.pop('last', None)
            nr += 1
    idx['v'] = IDX_VER
    return f'標「檔案不在」的 {nb} 份重新判・太慢失敗的 {nr} 份重新算次數' if (nb or nr) else ''


def _readable(st, today=None):
    """這份簡報這一輪要不要讀。⛔ 讀過的 / 永久失敗的 / 暫時性失敗滿 TRANSIENT_TRIES「天」的。
    📅 V79.6.4 巡邏:暫時性失敗**今天已經試過**的也先跳過(明天再試)—— 接力那幾棒同一天會連撞同一份慢檔,
       舊版 3 次機會一個小時內就用完、之後永久放棄;現在 3 次 = 3 個不同的日子。"""
    if not st:
        return True
    if st.get('st') in ('ok', 'no_text', 'bad_file', 'ppt_old', 'too_big', 'parse_fail'):
        return False
    if (st.get('tries') or 0) >= TRANSIENT_TRIES:
        return False
    if today is not None and st.get('st') == 'dl_fail' and st.get('last') == today.isoformat():
        return False
    return True


def plan_todo(recent_rows, backlog_rows, files, today):
    """要讀哪些簡報、照什麼順序。回 (todo[(row, 檔名, 原因)…], earliest{檔名: (日期, row)})。
    順序:① 最近 60 天場次表裡的(新 → 舊)
         ② 這些公司前 PREV_DECKS 份(新 → 舊;「這次第一次提到」要跟它們比,⭐ 回補時先讀這些 App 才馬上有得比)
         ③ 其他回補的(新 → 舊)
    同一份簡報只排一次;日期用「最早引用它的那一場」(拿舊簡報去券商場重講的 ⛔ 不算新的一場)。"""
    t = today.isoformat()
    earliest = {}
    for r in list(recent_rows) + list(backlog_rows):
        d = r.get('d') or '9999'
        if d > t:
            continue
        f, why = pick_deck(r.get('pdf'))
        if not f:
            continue
        if f not in earliest or d < earliest[f][0]:
            earliest[f] = (d, r, why)
    recent_f, recent_s = set(), set()
    for r in recent_rows:
        f, _ = pick_deck(r.get('pdf'))
        if f and f in earliest:
            recent_f.add(f)
            recent_s.add(str(r.get('s')))
    by_sym = {}
    for f, (d, r, _) in earliest.items():
        by_sym.setdefault(str(r.get('s')), []).append((d, f))
    tier = {f: 0 for f in recent_f}
    for s in recent_s:
        older = [f for d, f in sorted(by_sym.get(s, []), reverse=True) if f not in recent_f]
        for f in older[:PREV_DECKS]:
            tier.setdefault(f, 1)
    todo = [(tier.get(f, 2), d, f, r, why) for f, (d, r, why) in earliest.items() if _readable(files.get(f), today)]
    todo.sort(key=lambda x: (x[1], x[2]), reverse=True)        # 新 → 舊
    todo.sort(key=lambda x: x[0])                              # 再照優先序(穩定排序)
    return [(r, f, why) for _, _, f, r, why in todo], {f: (d, r) for f, (d, r, _) in earliest.items()}


def fix_dates(allr, earliest):
    """讀過的簡報後來找到「更早引用它的場次」→ 日期改成更早那場(⛔ 不重新下載)。回 (改了幾筆, 動到的月份)。"""
    moved, touched = 0, set()
    for m in list(allr):
        keep = []
        for r in allr[m]:
            e = earliest.get(r.get('f'))
            if e and r.get('d') and e[0] < r['d']:
                row = e[1]
                r['d'], r['t'], r['inv'] = e[0], row.get('t') or '', 1 if row.get('inv') or INV_RE.search(row.get('sum') or '') else 0
                mt = file_meta(r.get('f')) or {}
                r.pop('reuse', None)
                if mt.get('fd') and mt['fd'] < r['d'] and (date.fromisoformat(r['d']) - date.fromisoformat(mt['fd'])).days > 3:
                    r['reuse'] = mt['fd']
                nm = r['d'][:7]
                touched |= {m, nm}
                moved += 1
                if nm != m:
                    allr.setdefault(nm, []).append(r)
                    continue
            keep.append(r)
        allr[m] = keep
    return moved, touched


class _Common:
    """「大家都在講的詞」:只用這一場**之前** 100 天的簡報算(⛔ 前視);樣本 < COMMON_MIN_DECKS 份就不判。"""
    def __init__(self, df, n):
        self.df, self.n = df, n

    def __contains__(self, t):
        return self.n >= COMMON_MIN_DECKS and self.df.get(t, 0) / self.n > COMMON_SHARE


def novelty_all(recs):
    """每一份讀成功的簡報 → {檔名: {'first':True} 或 {'new':[[詞,頁]…], 'n_new', 'dropped':[…], 'prev_d'}}。
    ⭐ 每輪重算(⛔ 不存進特徵檔):回補讀到更舊的簡報之後,新簡報的「第一次提到」自動變準。
    ⛔ 前視:前幾份只取日期更早的;「大家都在講」只看這一場之前 100 天。"""
    ok = sorted([r for r in recs if r.get('st') == 'ok' and isinstance(r.get('terms'), dict) and r.get('d')],
                key=lambda r: (r['d'], r.get('f') or ''))
    low = [{t.lower() for t in r['terms']} for r in ok]
    out, hist, df = {}, {}, {}
    lo = hi = 0
    for i, r in enumerate(ok):
        d = r['d']
        try:
            cut = (date.fromisoformat(d) - timedelta(days=100)).isoformat()
        except ValueError:
            cut = d
        while hi < len(ok) and ok[hi]['d'] < d:
            for t in low[hi]:
                df[t] = df.get(t, 0) + 1
            hi += 1
        while lo < hi and ok[lo]['d'] < cut:
            for t in low[lo]:
                df[t] -= 1
                if not df[t]:
                    del df[t]
            lo += 1
        prev = [x for x in hist.get(r['s'], []) if x[0] < d][-PREV_DECKS:]
        new, dropped = novelty(r['terms'], [x[1] for x in reversed(prev)], _Common(df, hi - lo))
        if new is None:
            out[r['f']] = {'first': True}
        else:
            out[r['f']] = {'new': [[t, r['terms'][t]] for t in new][:12], 'n_new': len(new), 'dropped': dropped, 'prev_d': prev[-1][0]}
        hist.setdefault(r['s'], []).append((d, r['terms']))
    return out


# ───────────────────────── 網路(只在正式跑時用) ─────────────────────────
def is_block_page(b):
    """主機回的網頁是不是「被擋」那一頁(⛔ 是檔案不在)。網頁可能是 UTF-8 也可能是 Big5 → 兩種都解;只看前 8KB。"""
    b = (b or b'')[:8192]
    for enc in ('utf-8', 'big5'):
        t = b.decode(enc, 'ignore')
        if any(m in t for m in BLOCK_MARKS):
            return True
    return False


def err_kind(err):
    """下載失敗的原因分類(兩條路的原因用「 | 」串起來,每段前面是 srv: / nas:)。
    'too_big' 任一條說太大 ・'nf' 每一條都回網頁(檔案不在)・'4xx' 下載程式回 4xx(429 除外)而另一條也沒拿到 ・其他 = 暫時性
    ⚠️ 兩條路的順序會變(先走上一次成功的那條)→ 照 srv / nas 名字找,⛔ 不可假設第一段是下載程式"""
    by = {}
    for p in str(err or '').split(' | '):
        k, _, v = p.partition(':')
        if k in ('srv', 'nas'):
            by[k] = v
        else:
            by['srv'] = p                                    # 舊格式 / 只有一條路
    parts = list(by.values())
    if any(x == 'too_big' for x in parts):
        return 'too_big'
    # 🛡️ 任一條路回「被擋」的網頁 → 被擋(⛔ 永久、⛔ 算這份檔的錯;算連續失敗並退避)
    if any(x.startswith('blocked') for x in parts):
        return 'blocked'
    # 📭 檔案不在:下載程式回網頁、檔案路徑回 404 / 網頁(V79.6.4 巡邏:nas 404 + srv 網頁以前被當成暫時性 → 白試 3 輪、還算連續失敗)
    if by and all(v.startswith('not_file') or (k == 'nas' and v in ('HTTP 404', 'HTTP 410')) for k, v in by.items()):
        return 'nf'
    sv = by.get('srv', '')
    if sv.startswith('HTTP 4') and sv != 'HTTP 429' and all(x.startswith(('HTTP 4', 'not_file')) for x in parts):
        return '4xx'
    return 'tmp'


def dl_limit(total):
    """📏 一份簡報(兩條路合起來)最多下載幾秒:不知道多大 → DL_MAX_SEC;知道 → 大小 ÷ DL_FLOOR_KBS,介於 DL_MAX_SEC ~ DL_BIG_MAX_SEC。"""
    if not total:
        return DL_MAX_SEC
    return max(DL_MAX_SEC, min(DL_BIG_MAX_SEC, total / 1024 / DL_FLOOR_KBS))


def _content_range(v):
    """'bytes 1024-2047/9999' → (1024, 9999);看不懂回 (None, 0)。"""
    m = re.match(r'\s*bytes\s+(\d+)-(\d+)/(\d+|\*)', str(v or ''))
    if not m:
        return None, 0
    return int(m.group(1)), (int(m.group(3)) if m.group(3) != '*' else 0)


class Fetcher:
    def __init__(self, session=None, pace=PACE, sleeper=time.sleep, clock=time.time, session_factory=None):
        if session is None:
            import requests
            session = requests.Session()
            session_factory = session_factory or requests.Session
        self.s = session
        # 🔀 分段同時下載時每一段開自己的連線(requests.Session ⛔ 跨執行緒共用);測試注入假 session 時就共用那一個
        self.mk = session_factory or (lambda: self.s)
        self.pace, self.sleep, self.clock = pace, sleeper, clock
        self.fail_streak = 0
        self.last = 0.0
        self.pref = 'nas'            # ⚡ 先走檔案原本的路徑(下載程式實測每份只有約 30 KB/s);回網頁就馬上換下載程式
        self.wins = {}
        self.last_total = 0          # 上一次 get 從 Content-Length / Content-Range 知道的檔案大小(get_any 換路時算剩幾秒)
        self.resumed = 0             # 📎 這一輪靠續傳救回來幾次(log 用)
        self.par = 0                 # 🔀 這一輪分段同時下載成功幾份(log 用)

    def get(self, url, max_sec=None, parallel=False):
        """回 (bytes|None, 原因)。暫時性錯誤指數退避重試;⛔ 不無限重試。
        🐢 V79.6.3 第二輪:整份(含重試)有時限;每次讀取 DL_READ 秒沒收到東西就算逾時;每一次嘗試的結果都寫進原因
           (10/23 第一輪 30 份 40 分鐘讀不完 —— 舊版每份最多試 5 次 × 讀取逾時 60 秒,一份就可能卡 5 分鐘以上)。
        📏 V79.6.4 下載提速 時限照檔案大小算(dl_limit);max_sec = 呼叫端給的上限(get_any 換路時只給剩下的秒數)。
        📎 V79.6.4 下載提速 續傳:下載到一半斷線 → 下一次嘗試帶 Range 從斷掉的地方接著拿;主機回 206 而且起點對得上才接,
           回 200(不支援續傳)就整份重來、起點對不上也整份重來(⛔ 拼出錯的檔)。
        🔀 V79.6.4 下載提速 parallel=True(檔案路徑那條):第一次請求帶「Range: bytes=0-」—— 主機回 206 而且檔案比
           DL_SPLIT_MIN 大 → 改成分 DL_CONN 段同時下載(10/23 實測一條 19~37 KB/s、四條合計 69~149 KB/s);
           回 200(不支援)或小檔 → 那一個回應本來就是整份,照舊讀完(⛔ 多一次請求)。"""
        wait = self.pace - (self.clock() - self.last)
        if wait > 0:
            self.sleep(wait)
        notes = []
        t0 = self.clock()
        buf = io.BytesIO()           # 📎 跨嘗試留著(續傳)
        total = 0
        self.last_total = 0
        cap = max_sec if max_sec is not None else None
        probe = bool(parallel and DL_CONN > 1)

        def lim():
            x = dl_limit(total)
            return min(x, cap) if cap is not None else x

        def tag():
            return f'({";".join(notes)})' if notes else ''
        for k, back in enumerate(DL_BACKOFF):
            if back:
                if self.clock() - t0 + back > lim():
                    break
                self.sleep(back)
            ta = self.clock()
            have = buf.tell()
            hdr = dict(UA)
            asked0 = False
            if have:
                hdr['Range'] = f'bytes={have}-'
            elif probe:
                hdr['Range'] = 'bytes=0-'               # 🔀 問主機支不支援分段(回 200 = 不支援,這個回應就是整份)
                asked0 = True
            try:
                r = self.s.get(url, headers=hdr, timeout=(8, DL_READ), stream=True)
                self.last = self.clock()
                if r.status_code in (429, 500, 502, 503, 504):
                    notes.append(f'HTTP {r.status_code}')
                    continue
                hd = getattr(r, 'headers', None) or {}
                if have and r.status_code == 206:
                    st, tt = _content_range(hd.get('Content-Range'))
                    if st != have:                           # 起點對不上 → ⛔ 接;下一次整份重來
                        r.close()
                        notes.append(f'續傳起點不對({st}≠{have})')
                        buf, have = io.BytesIO(), 0
                        continue
                    total = tt or total
                    notes.append(f'續傳@{have // 1024}KB')
                    self.resumed += 1
                elif asked0 and r.status_code == 206:
                    st, tt = _content_range(hd.get('Content-Range'))
                    if st != 0 or not tt:                    # 看不懂 → 這一次照一般請求重來
                        r.close()
                        notes.append('分段回應看不懂')
                        probe = False
                        continue
                    total = tt
                    self.last_total = total
                    if total > MAX_BYTES:
                        r.close()
                        return None, 'too_big'
                    if total > DL_SPLIT_MIN:
                        r.close()
                        return self._get_par(url, total, t0, lim, notes)
                    # 小檔:這個 206 從第 0 個位元組到最後 = 整份,照一般讀法讀完
                elif r.status_code == 200:
                    if have:                                 # 主機不支援續傳 → 整份重來
                        notes.append('不支援續傳→重來')
                        buf, have = io.BytesIO(), 0
                    try:
                        total = int(hd.get('Content-Length') or 0)
                    except (TypeError, ValueError):
                        total = 0
                else:
                    return None, f'HTTP {r.status_code}'
                self.last_total = total
                if total > MAX_BYTES:
                    r.close()
                    return None, 'too_big'
                t_body, got0 = self.clock(), buf.tell()
                for chunk in r.iter_content(16384):
                    buf.write(chunk)
                    got = buf.tell()
                    if got > MAX_BYTES:
                        return None, 'too_big'
                    el = self.clock() - t_body
                    part = got - got0
                    # ⏱️ 知道檔案多大的話,照這一次的速度算得出「時限內下載不完」就提早放棄(⛔ 白白等滿時限、最後整份丟掉)
                    if total and el >= 20 and part > 0 and got < total and (el / part) * (total - got) + (self.clock() - t0) > lim():
                        r.close()
                        return None, f'slow:{got // 1024}/{total // 1024}KB@{part / 1024 / max(el, 1e-9):.0f}KB/s' + tag()
                    if self.clock() - t0 > lim():           # 🐢 主機把頻寬壓到很慢(一小塊一小塊給)→ ⛔ 不可一份等十分鐘
                        r.close()
                        return None, f'slow:{got // 1024}KB/{lim():.0f}s' + tag()
                b = buf.getvalue()
                if total and len(b) < total:                 # 連線提早結束(沒丟例外)→ 下一次續傳
                    notes.append(f'只拿到{len(b) // 1024}/{total // 1024}KB')
                    continue
                return self._judge(b)
            except Exception as e:                           # noqa: BLE001 —— 每一次的原因都記下來
                notes.append(f'{type(e).__name__}@{self.clock() - ta:.0f}s' + (f'(已{buf.tell() // 1024}KB)' if buf.tell() else ''))
                self.last = self.clock()
            if self.clock() - t0 > lim():
                break
        return None, ';'.join(notes) or 'fail'

    @staticmethod
    def _judge(b):
        """下載完的位元組 → (bytes, '') 或 (None, 原因)。⛔ 不猜:一律驗 %PDF- / zip 標頭(陷阱 #23)。"""
        if b[:5] == b'%PDF-' or b[:4] == b'PK\x03\x04':
            return b, ''
        # ⚠️ 原因字串裡的「|」會被 err_kind 當成兩條路的分隔(網頁標題常有「公開資訊觀測站 | …」)→ 換掉
        head = b[:200].decode('utf-8', 'ignore').replace('\n', ' ').replace('|', '¦')
        if is_block_page(b):
            return None, f'blocked:{head[:60]}'      # 🛡️ 被擋(⛔ 當成檔案不在)
        return None, f'not_file:{head[:80]}'         # 回了網頁(陷阱 #23:不存在的路徑回 200 + 網頁)

    def _get_par(self, url, total, t0, lim, notes):
        """🔀 分 DL_CONN 段同時下載(每段自己的連線、自己續傳);每段都要 206 而且起點 / 檔案大小對得上才收。
        ⏱️ 時限照整份算(lim);合計速度算得出下載不完 → 全部停下來回 slow(⛔ 白等到時限)。
        ⛔ 任何一段拿到的不是分段回應 → 那一段失敗(被擋的網頁回 blocked:)—— ⛔ 不可把網頁拼進 PDF。"""
        import threading
        from concurrent.futures import ThreadPoolExecutor, wait as _fwait
        n = max(1, min(DL_CONN, -(-total // DL_SEG_MIN)))
        bounds = [(i * total // n, (i + 1) * total // n - 1) for i in range(n)]
        got = [0] * n
        parts = [None] * n
        errs = [None] * n
        stop = threading.Event()
        t_body = self.clock()

        def too_slow():
            # ⏱️ 合計速度算得出時限內下載不完 → 全部停(⛔ 白等到時限);每一段每收一塊就看一次(⛔ 只靠主執行緒輪詢)
            el, done = self.clock() - t_body, sum(got)
            return el >= 20 and 0 < done < total and (el / done) * (total - done) + (self.clock() - t0) > lim()

        def seg(i):
            sess = self.mk()
            try:
                _seg(i, sess)
            finally:
                if sess is not self.s:                  # 自己開的連線自己關(測試注入的假 session ⛔ 關)
                    try:
                        sess.close()
                    except Exception:                    # noqa: BLE001
                        pass

        def _seg(i, sess):
            a, z = bounds[i]
            need = z - a + 1
            bb = bytearray()
            fails = 0
            while len(bb) < need and not stop.is_set():
                if self.clock() - t0 > lim():
                    errs[i] = f'slow:{sum(got) // 1024}/{total // 1024}KB×{n}/{lim():.0f}s'
                    stop.set()
                    return
                try:
                    h = dict(UA)
                    h['Range'] = f'bytes={a + len(bb)}-{z}'
                    r = sess.get(url, headers=h, timeout=(8, DL_READ), stream=True)
                    if r.status_code in (429, 500, 502, 503, 504):
                        raise IOError(f'HTTP {r.status_code}')
                    if r.status_code != 206:
                        head = b''
                        try:
                            for ch in r.iter_content(8192):
                                head += ch
                                if len(head) >= 8192:
                                    break
                        finally:
                            r.close()
                        errs[i] = (Fetcher._judge(head)[1] if is_block_page(head) else f'HTTP {r.status_code}(分段)')
                        stop.set()
                        return
                    st, tt = _content_range((getattr(r, 'headers', None) or {}).get('Content-Range'))
                    if st != a + len(bb) or (tt and tt != total):
                        r.close()
                        errs[i] = f'分段起點/大小不對({st}/{tt})'
                        stop.set()
                        return
                    for ch in r.iter_content(16384):
                        bb += ch
                        got[i] = len(bb)
                        if len(bb) > need:
                            r.close()
                            errs[i] = '分段多給了'
                            stop.set()
                            return
                        if stop.is_set():
                            r.close()
                            return
                        if self.clock() - t0 > lim() or too_slow():
                            r.close()
                            done = sum(got)
                            errs[i] = f'slow:{done // 1024}/{total // 1024}KB@{done / 1024 / max(self.clock() - t_body, 1e-9):.0f}KB/s×{n}'
                            stop.set()
                            return
                except Exception as e:                      # noqa: BLE001 —— 斷線就從斷掉的地方續傳,最多 DL_SEG_TRIES 次
                    fails += 1
                    if fails > DL_SEG_TRIES:
                        errs[i] = f'{type(e).__name__}'
                        return
                    self.sleep(min(2 ** fails, 8))
            if len(bb) == need:
                parts[i] = bytes(bb)

        with ThreadPoolExecutor(max_workers=n) as ex:
            futs = [ex.submit(seg, i) for i in range(n)]
            _fwait(futs)
            for f in futs:
                if f.exception() is not None:          # 每一段自己接例外;漏網的(例如開連線就壞)當那一段失敗
                    errs.append(f'{type(f.exception()).__name__}(分段)')
        if all(p is not None for p in parts):
            b = b''.join(parts)
            if len(b) == total:
                self.par += 1
                return self._judge(b)
        why = next((e for e in errs if e and e.startswith(('blocked', 'slow:'))), None) or next((e for e in errs if e), 'fail')
        return None, why + (f'({";".join(notes)})' if notes else '')

    def get_any(self, routes):
        """⚡ 同一份簡報有兩條官方下載路(下載程式 / 檔案原本的路徑)→ 先走上一次成功的那條,失敗才換另一條。
        回 (bytes|None, 原因, 用的是哪條)。⛔ 不猜網址:回來的東西一律驗 %PDF- / zip 標頭(陷阱 #23)。
        ⏱️ V79.6.4 下載提速 兩條路**合起來**一份最多 dl_limit(檔案大小) 秒:換路時第二條只拿剩下的秒數,剩不到 30 秒就不換
           (時限照大小放寬之後,兩條各自從頭算會變成一份最多 20 分鐘)。"""
        order = sorted(routes, key=lambda kv: 0 if kv[0] == self.pref else 1)
        errs = []
        t_file, known = self.clock(), 0
        for i, (kind, u) in enumerate(order):
            rem = None
            if i:
                rem = dl_limit(known) - (self.clock() - t_file)
                if rem < 30:
                    errs.append(f'{kind}:skip:沒時間換路({rem:.0f}s)')
                    break
            b, err = self.get(u, max_sec=rem, parallel=(kind == 'nas'))   # 🔀 只有檔案路徑支援分段(下載程式回 HTTP/1.0 200 整份)
            known = max(known, self.last_total)
            if b is not None:
                self.pref = kind
                self.wins[kind] = self.wins.get(kind, 0) + 1
                return b, '', kind
            errs.append(f'{kind}:{err}')
            if err == 'too_big':
                break
        return None, ' | '.join(errs), None


AI_DEADLINE = float(os.getenv('CC_AI_DEADLINE') or 40)    # 一份簡報的 AI 最多花幾秒(⛔ 不可為了 AI 拖慢整輪讀簡報)
AI_FAIL_STOP = 3              # 連幾份 AI 都失敗 → 這一輪不再叫(多半是額度用完)
# 🤖 V79.6.5 補摘要:讀的那一輪 AI 次數用完(AI_MAX)或沒回的,之後每輪用剩下的次數補(拿已存的重點句,⛔ 不重新下載)
AI_FILL_SEC = float(os.getenv('CC_AI_FILL_SEC') or 180)  # 補摘要那段最多花幾秒(job 時限要裝得下,測試 ㊷)
AI_TRIES = 2                  # 模型有回、但回的東西不能用 → 同一份最多再試幾次(⛔ 每一輪都叫同一份;額度用完 ⛔ 算這份的錯)


def groq_summarize(name, sym, d, feat, keys, poster=None, clock=time.time, sleeper=time.sleep):
    """回 (ai dict, model, 丟掉幾點) 或 (None, None, 0)。⛔ 沒有金鑰就不做。
    🐢 防拖慢:被限流(429)就換下一把金鑰(每把額度分開)、只等 1 秒;一份簡報最多 AI_DEADLINE 秒。"""
    if not keys:
        return None, None, 0
    from groq_common import groq_model, groq_apply, invalidate
    import requests
    sys_msg, user, src = ai_prompt(name, sym, d, feat['titles'], feat['outlook'], feat['nums'])
    payload = {'model': None, 'messages': [{'role': 'system', 'content': sys_msg}, {'role': 'user', 'content': user}],
               'temperature': 0.2, 'max_tokens': 700}
    post = poster or (lambda **kw: requests.post(**kw))
    tried = set()
    t0 = clock()
    for i, key in enumerate(list(keys) * 2):
        if clock() - t0 > AI_DEADLINE:
            break
        try:
            if not payload.get('model'):
                groq_apply(payload, groq_model(keys, 'light', avoid=tried), 700)
            r = post(url='https://api.groq.com/openai/v1/chat/completions', json=payload,
                     headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, timeout=30)
            if r.status_code == 404 and len(tried) < 3:
                tried.add(payload.get('model')); invalidate('light', payload.get('model')); payload['model'] = None
                continue
            if r.status_code == 429:
                sleeper(1.0)            # 換下一把(⛔ 不在同一把上越等越久)
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


def ai_fill(allr, today, keys, budget, log=print, clock=time.time):
    """🤖 V79.6.5 補摘要。讀簡報那一段一輪最多叫 AI_MAX 次;下載變快之後一輪讀得比這個多(10/23 第 4 棒讀 47 份、40 份有摘要),
    而讀過的簡報 ⛔ 不會再讀 → 那幾份「永遠沒有一句話」。額度用完 / 沒回的也一樣。
    → 每輪用剩下的次數,拿**已存的重點句**(titles / outlook / nums)補,⛔ 不重新下載。
    範圍跟讀簡報那段一樣:最近 DIGEST_DAYS 天(App 清單看得到的)、新 → 舊;這段自己最多 AI_FILL_SEC 秒、連 AI_FAIL_STOP 份沒回就停。
    模型有回、但回的不能用 → ai_n +1,滿 AI_TRIES 次就不再補(⛔ 每輪一直叫同一份);沒回(額度 / 連不上)⛔ 不算這份的錯。
    回 (補到幾份, 叫了幾次, 動到的月份, 還差幾份)。"""
    if not keys or budget <= 0:
        return 0, 0, set(), 0
    cut = (today - timedelta(days=DIGEST_DAYS)).isoformat()
    cands = [(m, r) for m, lst in allr.items() for r in lst
             if isinstance(r, dict) and r.get('st') == 'ok' and not r.get('ai') and (r.get('d') or '') >= cut
             and (r.get('ai_n') or 0) < AI_TRIES and (r.get('outlook') or r.get('nums') or r.get('titles'))]
    if not cands:
        return 0, 0, set(), 0
    cands.sort(key=lambda x: (x[1].get('d') or '', x[1].get('f') or ''), reverse=True)
    t0, n_call, n_ok, fail, touched = clock(), 0, 0, 0, set()
    for m, r in cands:
        if n_call >= budget or clock() - t0 > AI_FILL_SEC or fail >= AI_FAIL_STOP:
            break
        feat = {'titles': r.get('titles') or [], 'outlook': r.get('outlook') or [], 'nums': r.get('nums') or []}
        ai, model, gd = groq_summarize(r.get('name') or r.get('s'), r.get('s'), r.get('d'), feat, keys)
        n_call += 1
        if ai:
            r.update({'ai': ai, 'model': model, 'gate_drop': gd})
            r.pop('ai_n', None)
            n_ok, fail = n_ok + 1, 0
            touched.add(m)
        else:
            fail += 1
            if model:                       # 模型有回、但回的不能用(⛔ 沒回 = 額度 / 連線,不算這份的錯)
                r['ai_n'] = (r.get('ai_n') or 0) + 1
                touched.add(m)
    left = len(cands) - n_ok
    log(f'🤖 補摘要:{n_ok} 份(讀的時候 AI 次數用完 / 沒回的;拿存好的重點句,⛔ 不重新下載)・叫了 {n_call} 次'
        + (f'・還差 {left} 份,下一輪接著補' if left else ''))
    return n_ok, n_call, touched, left


# ───────────────────────── 主流程 ─────────────────────────
def _today():
    return datetime.now(TW).date()


def build_outputs(recs, nov, info, today, files=None, cite=None):
    """App 讀的兩個檔:data/cc/{sym}.json(每檔最近 4 份)+ data/confcall_digest.json(最近 60 天每場一列)。
    ⛔ 每檔的檔案裡沒有「每輪都變」的時間戳 → 內容沒變就不改檔(不然每輪上千個檔都算變更)。
    📋 V79.6.4 巡邏:清單也列「讀不成的」(只有狀態 st:只有圖片 / 舊格式 / 抽不出字 / 檔案不在 / 太大 / 下載失敗)
       → App 才分得出「還沒讀」跟「讀不到」(舊版一律寫「還沒讀到」);
       最近場次引用的簡報(cite)⛔ 被 60 天切掉 —— 拿 3 個月前那份去券商場重講的那一場也要對得到。"""
    by_sym = {}
    for r in recs:
        if r.get('st') in ('ok', 'no_text'):
            by_sym.setdefault(r['s'], []).append(r)
    out_dir = DATA / 'cc'
    out_dir.mkdir(parents=True, exist_ok=True)
    cut = (today - timedelta(days=DIGEST_DAYS)).isoformat()
    cite = set(cite or ())
    in_dg = lambda f, d: (d or '') >= cut or (f in cite)
    keys = ('d', 't', 'inv', 'f', 'kind', 'pages', 'st', 'reuse', 'outlook', 'nums', 'titles', 'tone', 'ai', 'model', 'gate_drop')
    wrote, digest, seen = 0, [], set()
    for s, lst in sorted(by_sym.items()):
        lst.sort(key=lambda r: (r.get('d') or '', r.get('f') or ''), reverse=True)
        decks = []
        for r in lst[:KEEP_PER_SYM]:
            x = {k: r.get(k) for k in keys if r.get(k) not in (None, '', [], 0) or k in ('d', 'f', 'st')}
            if x.get('titles'):
                x['titles'] = x['titles'][:12]
            x.update(nov.get(r.get('f')) or {})
            decks.append(x)
        body = json.dumps({'s': s, 'name': lst[0].get('name') or s, 'decks': decks}, ensure_ascii=False, separators=(',', ':'))
        p = out_dir / f'{s}.json'
        if not p.exists() or p.read_text(encoding='utf-8') != body:
            p.write_text(body, encoding='utf-8')
            wrote += 1
        for r in lst:
            if r.get('st') != 'ok' or not in_dg(r.get('f'), r.get('d')):
                continue
            nv, ai = nov.get(r.get('f')) or {}, r.get('ai') or {}
            row = {'s': s, 'name': r.get('name') or s, 'd': r.get('d'), 't': r.get('t') or '', 'inv': r.get('inv') or 0, 'f': r.get('f'), 'st': 'ok',
                   'one': ai.get('one') or '', 'ol': ((best_outlook(r.get('outlook') or []) or [0, ''])[1] or '')[:80],
                   'new': [t for t, _ in (nv.get('new') or [])][:5], 'new_n': nv.get('n_new', 0), 'first': bool(nv.get('first')),
                   'prev_d': nv.get('prev_d') or '', 'reuse': r.get('reuse') or '', 'n_nums': len(r.get('nums') or []), 'pages': r.get('pages'),
                   # 🔎 簡報講到的產品 / 技術詞(照第一次出現的頁排,最多 30 個)→ 法說會頁可以搜「誰在講 CPO」
                   'tm': [t for t, _ in sorted((r.get('terms') or {}).items(), key=lambda x: x[1])][:30]}
            vid = ((info.get(r.get('f')) or (None, {}))[1] or {}).get('vid')
            if vid:
                row['vid'] = vid
            digest.append(row)
            seen.add(r.get('f'))
    n_ok = len(digest)

    def st_row(f, s, d, st, src=None, extra=None):
        """讀不成的那一份:只有狀態(⛔ 沒有任何重點欄位,App 不會拿空的去畫)。"""
        src = src or {}
        x = {'s': str(s), 'name': src.get('name') or str(s), 'd': d, 't': src.get('t') or '', 'f': f, 'st': st, 'new_n': 0,
             'inv': 1 if (src.get('inv') or INV_RE.search(src.get('sum') or '')) else 0}
        x.update(extra or {})
        return x
    for r in recs:                                       # 讀到了但沒有字 / 抽不出來 / 舊格式
        f = r.get('f')
        if r.get('st') in ('no_text', 'parse_fail', 'ppt_old') and f and f not in seen and in_dg(f, r.get('d')):
            digest.append(st_row(f, r.get('s'), r.get('d'), r['st'], r))
            seen.add(f)
    for f, st in (files or {}).items():                  # 下載不到(只有 index 有紀錄)
        st = st or {}
        if f in seen or st.get('st') not in ('bad_file', 'too_big', 'dl_fail'):
            continue
        e = info.get(f)
        d = e[0] if e else st.get('d')
        if not in_dg(f, d):
            continue
        tries = st.get('tries') or 0
        ex = {'tries': tries, 'gave_up': 1 if tries >= TRANSIENT_TRIES else 0} if st['st'] == 'dl_fail' else None
        digest.append(st_row(f, st.get('s') or ((e[1] or {}).get('s') if e else ''), d, st['st'], e[1] if e else None, ex))
        seen.add(f)
    digest.sort(key=lambda x: (x['d'] or '', x['new_n']), reverse=True)
    _save_json(DATA / 'confcall_digest.json', {'updated': datetime.now(TW).isoformat(timespec='minutes'),
                                               'days': DIGEST_DAYS, 'n': len(digest), 'n_ok': n_ok, 'rows': digest})
    return wrote, n_ok


def _gh_out(**kw):
    """接力用:寫進 GitHub Actions 的 step outputs(本機跑沒有這個檔 → 不寫)。"""
    p = os.getenv('GITHUB_OUTPUT')
    if not p:
        return
    with open(p, 'a', encoding='utf-8') as f:
        for k, v in kw.items():
            f.write(f'{k}={v}\n')


def run(fetcher=None, groq_keys=None, today=None, log=print, list_fetch=None):
    today = today or _today()
    t0 = time.time()
    src = _load_json(SRC, None)
    if not src:
        log('❌ 讀不到 data/confcall.json(法說會場次表)→ 這輪不做')
        _gh_out(more=0, reason='nosrc', left=0)
        return 1
    tpl = (src.get('src') or {}).get('file')
    past = today.isoformat()
    recent_rows = [r for r in (src.get('recent') or []) + (src.get('upcoming') or [])
                   if r and r.get('pdf') and (r.get('d') or '9999') <= past]
    # 📚 回補:手動給起訖月才查清單;上次沒抓齊的月份每輪自動重抓幾個
    bl = load_backlog()
    want = months_between(LIST_FROM, LIST_TO) if (LIST_FROM and LIST_TO) else []
    retry = [tuple(map(int, k.split('-'))) for k, v in sorted(bl['months'].items(), reverse=True) if not (v or {}).get('ok')][:LIST_RETRY_MAX]
    months = sorted(set(want) | set(retry), reverse=True)            # 新 → 舊(App 最需要的是最近幾季)
    if months:
        log(f'📚 回補場次清單:{len(months)} 個月({months[-1][0]}-{months[-1][1]:02d} ~ {months[0][0]}-{months[0][1]:02d})')
        added, bad = list_backfill(bl, months, today, fetch=list_fetch, log=log)
        _save_json(backlog_path(), bl)
        log(f'📚 清單多了 {added} 場(回補清單共 {len(bl["rows"])} 場)' + (f' ・沒抓齊 {len(bad)} 個月:{", ".join(bad[:6])}' if bad else ''))
    idx = load_index()
    files = idx.setdefault('files', {})
    nmig = migrate_index(idx)
    if nmig:
        log(f'🧹 紀錄格式升到 v{IDX_VER}:{nmig}')
    todo, earliest = plan_todo(recent_rows, bl['rows'], files, today)
    recent_fs = {pick_deck(x.get('pdf'))[0] for x in recent_rows}
    n_t0 = sum(1 for r, f, w in todo if f in recent_fs)
    log(f'📞 最近場次 {len(recent_rows)} 場有簡報 ・回補清單 {len(bl["rows"])} 場 ・這一輪待讀 {len(todo)} 份'
        f'(最近的 {n_t0} 份優先;上限 {MAX_FILES})')
    allr = load_all()
    moved, touched_m = fix_dates(allr, earliest)
    if moved:
        log(f'🗓️ {moved} 份簡報找到更早引用它的場次 → 日期改成那一場(⛔ 不重新下載)')
    fetcher = fetcher or (Fetcher() if todo else None)
    new_recs, ai_used, ai_fail, n_ok, n_fail, streak, n_try = [], 0, 0, 0, 0, 0, 0
    n_bad, blk = 0, 0             # n_bad = 暫時性 / 被擋(紅燈只看這種;「還沒上傳」⛔ 算壞掉)・blk = 連續被擋幾份
    tday = today.isoformat()
    reason = 'done'
    for r, f, why in todo:
        if n_try >= MAX_FILES:
            reason = 'cap'
            break
        if (time.time() - t0) / 60 > BUDGET_MIN:
            log(f'⏱️ 到時間上限 {BUDGET_MIN} 分 → 收工(剩的下一輪接著讀)')
            reason = 'time'
            break
        n_try += 1
        s, d = str(r['s']), r.get('d')
        mt = file_meta(f) or {}
        rec = {'s': s, 'd': d, 'f': f, 'name': r.get('name') or s, 'kind': mt.get('ext'), 't': r.get('t') or '',
               'inv': 1 if (r.get('inv') or INV_RE.search(r.get('sum') or '')) else 0, 'ts': datetime.now(TW).isoformat(timespec='minutes')}
        if mt.get('fd') and d and mt['fd'] < d and (date.fromisoformat(d) - date.fromisoformat(mt['fd'])).days > 3:
            rec['reuse'] = mt['fd']          # 拿舊簡報去券商場重講
        if why == 'ppt_old':
            rec['st'] = 'ppt_old'
            files[f] = {'st': 'ppt_old', 's': s, 'd': d, 'tries': 1}
            new_recs.append(rec)
            continue
        t_f = time.time()
        if hasattr(fetcher, 'get_any'):
            b, err, route = fetcher.get_any(file_urls(tpl, f))
        else:                                                # 測試用的假下載器只有 get
            (b, err), route = fetcher.get(file_url(tpl, f)), 'srv'
        t_dl = time.time() - t_f
        if n_try % 10 == 0:
            log(f'  ⏳ 第 {n_try} 份 ・已 {(time.time() - t0) / 60:.1f} 分 ・成功 {n_ok} ・失敗 {n_fail}')
        if b is None:
            n_fail += 1
            prev = files.get(f) or {}
            young = bool(d) and (today - date.fromisoformat(d)).days <= NOT_FILE_GRACE
            ek = err_kind(err)
            perm = (ek == 'nf' and not young) or ek in ('too_big', '4xx')
            # 📅 一天只算一次(同一天又失敗 ⛔ 再扣)・🛡️ 被擋 ⛔ 算這份檔的錯(tries 不動)
            tries = (prev.get('tries') or 0) + (0 if (ek == 'blocked' or prev.get('last') == tday) else 1)
            files[f] = {'st': 'too_big' if ek == 'too_big' else ('bad_file' if perm else 'dl_fail'), 'err': err[:160],
                        's': s, 'd': d, 'tries': tries, 'last': tday}
            log(f'  ⚠️ {s} {d} {f} 下載失敗:{err[:140]}({t_dl:.0f} 秒)')
            if ek == 'blocked':
                n_bad += 1
                blk += 1
                if blk >= BLOCK_STOP:
                    log(f'🛑 連 {BLOCK_STOP} 份被主機擋(「安全性考量」那一頁)→ 本輪收工,明天再試(⛔ 硬打)')
                    reason = 'blocked'
                    break
                wait_s = BLOCK_BACKOFF[min(blk, len(BLOCK_BACKOFF)) - 1]
                log(f'  🛡️ 被擋 → 先等 {wait_s} 秒再試下一份(指數退避)')
                if hasattr(fetcher, 'sleep'):
                    fetcher.sleep(wait_s)
                continue
            # 「連不上 / 逾時 / 5xx」才算連續失敗(⛔ 回網頁 = 主機有回應、只是那份檔不在,不算被擋)
            if ek in ('nf', 'too_big'):
                continue
            n_bad += 1
            streak += 1
            if streak >= 5:
                log('🛑 連 5 份下載失敗(可能被擋)→ 本輪收工,下一輪再試')
                reason = 'blocked'
                break
            continue
        streak, blk = 0, 0
        t_ai = 0.0
        kb, t_e = len(b) // 1024, time.time()
        pages, perr = extract_safe(b)
        t_ex = time.time() - t_e
        del b
        if pages is None:                                    # 抽不出來 / 抽太久 → 記原因、⛔ 不重試(同一份檔下次一樣卡)
            files[f] = {'st': 'parse_fail', 'err': perr, 's': s, 'd': d, 'tries': 1}
            rec['st'] = 'parse_fail'
            rec['err'] = perr
            new_recs.append(rec)
            log(f'  ⚠️ {s} {d} {f} 抽不出字:{perr}({kb:,} KB ・下載 {t_dl:.0f} 秒 ・抽字 {t_ex:.0f} 秒)')
            continue
        if sum(len(p or '') for p in pages) < 200:
            rec.update({'st': 'no_text', 'pages': len(pages)})       # 只有圖片的簡報(⛔ 不 OCR)
            files[f] = {'st': 'no_text', 's': s, 'd': d, 'tries': 1}
            new_recs.append(rec)
            continue
        feat = feat_of(pages, mt)
        rec.update({'st': 'ok', **feat})
        if groq_keys and ai_used < AI_MAX and ai_fail < AI_FAIL_STOP and d and d >= (today - timedelta(days=DIGEST_DAYS)).isoformat():
            t_a = time.time()
            ai, model, gd = groq_summarize(rec['name'], s, d, feat, groq_keys)
            t_ai = time.time() - t_a
            ai_used += 1
            if ai:
                rec.update({'ai': ai, 'model': model, 'gate_drop': gd})
                ai_fail = 0
            else:
                ai_fail += 1
                if model:
                    rec['ai_n'] = 1             # 模型有回、但回的不能用 → 補摘要那段最多再試 AI_TRIES 次(沒回 ⛔ 算這份的錯)
                if ai_fail >= AI_FAIL_STOP:
                    log(f'🤖 AI 連 {AI_FAIL_STOP} 份都沒回(多半是額度用完)→ 這一輪不再叫 AI,只給機械式重點')
        files[f] = {'st': 'ok', 's': s, 'd': d, 'tries': 1, 'pages': feat['pages']}
        new_recs.append(rec)
        n_ok += 1
        log(f'  ✅ {s} {d} {feat["pages"]} 頁 ・重點 {len(feat["outlook"])} 句 ・數字 {len(feat["nums"])} 句 ・詞 {len(feat["terms"])} 個'
            f'{" ・AI ✓" if rec.get("ai") else ""}'
            f'({kb:,} KB ・下載 {t_dl:.0f} 秒{"(nas)" if route == "nas" else ""} ・抽字 {t_ex:.1f} 秒{f" ・AI {t_ai:.0f} 秒" if t_ai else ""})')
    # 寫回 cc_deep(按場次月份;同一份簡報以這一輪的為準)
    for rec in new_recs:
        m = (rec.get('d') or '0000-00')[:7]
        lst = allr.setdefault(m, [])
        lst[:] = [x for x in lst if x.get('f') != rec['f']] + [rec]
        touched_m.add(m)
    # 🤖 V79.6.5 補摘要:用這一輪剩下的 AI 次數,補「讀的時候沒拿到一句話」的(⛔ 不重新下載;新讀的優先 = 先讀完才補)
    n_fill = 0
    if groq_keys and ai_fail < AI_FAIL_STOP and AI_MAX - ai_used > 0:
        n_fill, n_call, tm, _ = ai_fill(allr, today, groq_keys, AI_MAX - ai_used, log=log)
        ai_used += n_call
        touched_m |= tm
    for m in touched_m:
        _save_json(month_file(m + '-01'), sorted(allr.get(m, []), key=lambda x: (x.get('d') or '', x.get('f') or '')))
    idx['updated'] = datetime.now(TW).isoformat(timespec='minutes')
    _save_json(CC / 'cc' / 'index.json', idx)
    _gh_out(ran=1)                # 💾 紀錄已存 → 就算等一下紅燈,workflow 也要把 cc_deep 推上去(⛔ 不然「試過幾次」永遠存不住)
    recs = [x for lst in allr.values() for x in lst]
    nov = novelty_all(recs)
    wrote, nd = build_outputs(recs, nov, earliest, today, files=files, cite=recent_fs)
    left = max(0, len(todo) - n_try) + sum(1 for r, f, w in todo[:n_try] if (files.get(f) or {}).get('st') == 'dl_fail'
                                           and (files.get(f) or {}).get('tries', 0) < TRANSIENT_TRIES)
    if reason == 'done' and left:
        reason = 'retry'          # 只剩暫時性失敗的 → 下一輪(每天那一輪)再試,⛔ 不接力
    wins = getattr(fetcher, 'wins', None) or {}
    route = ('・下載路 ' + ' / '.join(f'{"檔案路徑" if k == "nas" else "下載程式"} {v} 份' for k, v in sorted(wins.items()))) if wins else ''
    if getattr(fetcher, 'par', 0):
        route += f'・分 {DL_CONN} 段同時下載 {fetcher.par} 份'
    if getattr(fetcher, 'resumed', 0):
        route += f'・斷線續傳 {fetcher.resumed} 次'
    log(f'📦 讀成功 {n_ok} 份 ・失敗 {n_fail} ・AI 摘要 {ai_used} 次{f"(補摘要 {n_fill} 份)" if n_fill else ""} ・改了 {wrote} 檔 data/cc/ ・清單 {nd} 場 ・還沒讀 {left} 份({reason}){route}')
    _gh_out(more=1 if left else 0, reason=reason, left=left)
    if todo and n_ok == 0 and n_bad >= (BLOCK_STOP if reason == 'blocked' else 5):
        log('❌ 一份都沒讀到而且連續失敗 / 被擋 → 紅燈(⛔ 不可全綠沒資料)')
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
