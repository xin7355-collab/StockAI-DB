#!/usr/bin/env python3
"""🎙️ 法說會「影音 → 逐字稿」與「簡報圖片頁 → 文字」可行性 + 準度量測(V79.7.3 第 0 步)

⛔ 只量、只寫 /tmp 的報告(workflow 上傳成附件);⛔ 不推任何分支、⛔ 不改 App、⛔ 不碰 cc_deep。
使用者 2026-10-24:「法說會目前也有影音…需要抓取逐字稿判讀嗎?」「Pdf 轉逐字稿有適合做嗎?」
「先不抓南亞,以目前有可以複查回測有用的來檢查法說會到底有沒有用」→ 樣本一律挑**已經開完、而且簡報已讀過**的歷史場次。

量五件事(報告每一節對一件):
  ① 影音還抓不抓得到:證交所法說會影音平台(irconference,直接是 mp4)逐年抽樣問得到嗎、多長;
     YouTube / zucast / vimeo / 證交所 webpro 用 yt-dlp 問(GitHub 機器上 YouTube 常被擋 → 照實記)
  ② Groq 語音辨識(whisper-large-v3-turbo)整場轉幾場:花多少秒、用掉多少音訊秒
  ③ GitHub 機器自己跑(faster-whisper)的速度:同一段 10 分鐘,turbo / small 各幾倍時間 + 跟 Groq 的文字相似度
  ④ 準度(⛔ 不叫 AI 判):逐字稿裡的數字 / 簡報講到的產品詞,跟同一場簡報全文比 —— 對得上幾成;問答段切不切得出來
  ⑤ 簡報「圖片頁」(不到 40 字的頁)送 Groq 視覺模型:讀出幾個字、幾個數字;圖片與讀出來的字一起放進附件給人看

跑法(Actions:🎙️ 法說會影音 / 圖片頁量測):CC_DIR=<git archive origin/cc_deep 解開的目錄> OUT=/tmp/av python3 scripts/confcall_av_probe.py
     python3 scripts/confcall_av_probe.py --selftest(純函式,不連網)

🏢 V79.7.5 `AV_MODE=qa`(使用者 10/24 選「先挑問答多的大型公司」):市值前 N 名
  ① 從清單裡那家自己的投資人網址找**官方逐字稿**(transcript / 逐字稿 / 會議紀錄 PDF)、對到哪幾場
  ② 讀幾份:切「簡報 / 問答」、數提問、「只在問答出現」的數字句比例(vs 同一場簡報 + 逐字稿前半段)
  ③ 大型公司在證交所影音網站的那幾場 → Groq 辨識 → 簡轉繁 + 幻覺字過濾 → 同樣切問答
  ④ 過關門檻寫死(QA_GATE_CALLS / QA_GATE_SHARE)→ 報告最後印 PASS / FAIL
  ⚠️ 官方逐字稿有 LSEG / FactSet 版權註記 → ⛔ 全文不寫進報告附件以外的地方,log 只印一兩百字
"""
import base64
import difflib
import gzip
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 🔧 workflow 從 inputs.* 餵進來:排程 / 空白時是空字串 → 一律 `or 預設`(check_env_default)
TRANS_N = int(os.getenv('AV_TRANS_N') or 4)          # Groq 整場轉幾場
LOCAL_N = int(os.getenv('AV_LOCAL_N') or 2)          # 本機 faster-whisper 量速度的場數(每場只轉第一段 10 分)
OCR_N = int(os.getenv('AV_OCR_N') or 16)             # 圖片頁送視覺模型幾頁
AVAIL_PER_YEAR = int(os.getenv('AV_AVAIL_PER_YEAR') or 20)   # 證交所 mp4 逐年問幾場(只問檔頭,不下載)
OTHER_PER_KIND = int(os.getenv('AV_OTHER_PER_KIND') or 4)    # YouTube / zucast / vimeo / webpro 各問幾場
SEED = int(os.getenv('AV_SEED') or 20261024)
SEG = 600                     # 切段秒數(16kHz 單聲道 flac 10 分 ≈ 10 MB < Groq 25 MB)
MAX_MB = float(os.getenv('AV_MAX_MB') or 1500)       # 一場影片最多下載多大
DEADLINE = time.time() + float(os.getenv('AV_DEADLINE_MIN') or 140) * 60
GROQ_ASR_MODEL = os.getenv('AV_ASR_MODEL') or 'whisper-large-v3-turbo'
GROQ_ASR_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'
GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'
# 視覺模型:先照偏好挑,清單上都沒有就挑名字看起來是視覺 / 多模態的(⛔ 寫死一個名字 —— 下架是常態)
VISION_PREF = [m for m in (os.getenv('AV_VISION_MODEL') or '').split(',') if m] + [
    'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct',
    'qwen/qwen3.6-27b', 'qwen/qwen2.5-vl-32b-instruct']
VISION_RE = re.compile(r'llama-4|vision|-vl|qwen3\.6', re.I)
OCR_PROMPT = ('逐字抄出這張投影片上看得到的所有文字與數字(含圖表上的標籤、座標軸、數值、圖例);'
              '表格轉成 Markdown 表格;看不清楚的寫 [?]。⛔ 不要解釋、不要摘要、不要補圖上沒有的內容。')
QA_TOP = int(os.getenv('AV_QA_TOP') or 100)            # qa 模式:市值前幾名
QA_READ = int(os.getenv('AV_QA_READ') or 40)            # 讀幾份官方逐字稿
QA_ASR_N = int(os.getenv('AV_QA_ASR_N') or 8)           # 大型公司的證交所影片轉幾場(Groq 一天約 8 小時錄音)
QA_ASR_TOP = int(os.getenv('AV_QA_ASR_TOP') or 150)
QA_MAX_MIN = float(os.getenv('AV_QA_MAX_MIN') or 90)    # 一場超過幾分鐘不轉(額度)
QA_GATE_CALLS = 150      # 過關:估計有 ≥150 場「至少 3 個提問」
QA_GATE_SHARE = 0.30     # 過關:問答裡的數字句 ≥30% 是簡報 / 前半段沒講的
THIN = 40                     # 一頁抽得到的字不到這麼多 = 多半是圖片頁(10/24 量:107,608 頁裡 22.3%)

UA = {'User-Agent': 'Mozilla/5.0 (StockAI-DB research probe)'}


# ───────────────────────── 純函式(selftest 直接打) ─────────────────────────
def kind_of(url):
    u = (url or '').lower()
    if 'irconference.twse.com.tw' in u and re.search(r'\.mp4(\?|$)', u):
        return 'ir_mp4'
    if 'webpro.twse.com.tw' in u:
        return 'twse_vod'
    if 'youtu.be' in u or 'youtube.com' in u:
        return 'youtube'
    if 'zucast.com' in u:
        return 'zucast'
    if 'vimeo.com' in u:
        return 'vimeo'
    if 'drive.google.com' in u:
        return 'gdrive'
    if re.search(r'\.(mp4|mp3|m4a|wav)(\?|$)', u):
        return 'file'
    return 'other'


def _cn_int(s):
    """中文整數(含 萬 / 億 / 十百千)→ int;認不得回 None。「兩」= 2、「〇/零」= 0。"""
    dig = {'零': 0, '〇': 0, '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
    unit = {'十': 10, '百': 100, '千': 1000}
    big = {'萬': 10 ** 4, '億': 10 ** 8}
    if not s:
        return None
    if all(ch in dig for ch in s):                   # 一二三 → 123(逐字唸)
        return int(''.join(str(dig[ch]) for ch in s))
    total, sec, num = 0, 0, 0
    for ch in s:
        if ch in dig:
            num = dig[ch]
        elif ch in unit:
            sec += (num or 1) * unit[ch]
            num = 0
        elif ch in big:
            total += (sec + num) * big[ch]
            sec, num = 0, 0
        else:
            return None
    return total + sec + num


_CN_DIG = {'零': 0, '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
_CN_NUM = re.compile(r'(百分之)?([零〇一二兩三四五六七八九十百千萬億]+)(?:點([零〇一二三四五六七八九]+))?')


def cn_to_arabic(text):
    """「百分之五十八點一」→「58.1%」・「九百五十六億」→「956億」・「四點九零元」→「4.90元」(逐字稿的數字常寫成國字)。
    ⛔ 單獨一個「一」「十」這種多半是詞不是數字(一定、十分)→ 只換 ≥2 個字、或帶「點」/「百分之」的。"""
    def rep(m):
        pct, ip, dp = m.group(1), m.group(2), m.group(3)
        if not pct and not dp and len(ip) < 2:
            return m.group(0)
        # 「九百五十六億」:只有一個 萬/億 而且在最後 → 保留單位(簡報寫的是「956 億」);兩個以上(三億五千萬)才換成整數
        tail = ''
        if ip[-1] in '萬億' and sum(1 for ch in ip if ch in '萬億') == 1 and len(ip) > 1:
            ip, tail = ip[:-1], ip[-1]
        n = _cn_int(ip)
        if n is None:
            return m.group(0)
        s = str(n)
        if dp:
            s += '.' + ''.join(str(_CN_DIG[c]) for c in dp)
        return s + tail + ('%' if pct else '')
    return _CN_NUM.sub(rep, text or '')


def _norm_num(s):
    s = s.replace(',', '')
    if '.' in s:
        s = s.rstrip('0').rstrip('.')
    return s


NUM_RE = re.compile(r'\d[\d,]*(?:\.\d+)?')


def nums_in(text, min_val=10):
    """一段文字裡「有意義的數字」集合:有小數點的都收;整數 ≥ min_val 才收(1~9 多半是編號 / 頁碼);
    年份(2019~2031)⛔ 不收(簡報與逐字稿都一定有,算進去會灌水)。"""
    out = set()
    for m in NUM_RE.finditer(cn_to_arabic(text or '')):
        raw = m.group(0)
        n = _norm_num(raw)
        if not n or n.count('.') > 1:
            continue
        try:
            v = float(n)
        except ValueError:
            continue
        if '.' not in n and (v < min_val or (2019 <= v <= 2031)):
            continue
        out.add(n)
    return out


def num_match(trans_text, deck_text):
    """逐字稿 vs 同一場簡報的數字:
    p = 逐字稿講到的數字裡,簡報上也有的比例(⚠️ 講者本來就會講簡報沒有的數字 → 這是下限,不是錯誤率)
    r = 簡報上的數字裡,逐字稿也講到的比例(講者本來就不會唸完每個數字 → 也是參考)"""
    t, d = nums_in(trans_text), nums_in(deck_text)
    both = t & d
    return {'t_n': len(t), 'd_n': len(d), 'both': len(both),
            'p': round(len(both) / len(t), 3) if t else None, 'r': round(len(both) / len(d), 3) if d else None,
            'only_t': sorted(t - d, key=lambda x: float(x))[:40]}


def term_match(trans_text, terms):
    """簡報講到的產品 / 技術詞(confcall_deck.terms_of)有幾個在逐字稿裡聽得到(英文不分大小寫)。"""
    if not terms:
        return {'n': 0, 'hit': 0, 'rate': None, 'miss': []}
    low = (trans_text or '').lower()
    hit = [t for t in terms if t.lower() in low]
    miss = [t for t in terms if t.lower() not in low]
    return {'n': len(terms), 'hit': len(hit), 'rate': round(len(hit) / len(terms), 3), 'miss': miss[:20]}


QA_RE = re.compile(r'(?<![A-Za-z])Q\s*&?\s*A(?![A-Za-z])|問答|提問|開放.{0,6}(發問|問題|提問)|有沒有.{0,8}問題|第一個問題|第一位')


def qa_split(cues, min_frac=0.0):
    """問答段從哪裡開始:第一個「問答 / 提問 / 開放發問」出現的時間;之後「請問」幾次(= 大約幾個問題)。
    cues = [{'start','end','text'}];切不到回 None(⛔ 硬猜)。
    🏢 min_frac:主持人開場常先講「簡報後有 Q&A」(10/24 曜越在第 21 秒)→ 優先挑那個時間點之後的第一個,都在前面才退回第一個。"""
    cues = cues or []
    total0 = (cues[-1].get('end') or 0) if cues else 0
    marks = [i for i, c in enumerate(cues) if QA_RE.search(c.get('text') or '')]
    late = [i for i in marks if total0 and (cues[i].get('start') or 0) >= total0 * min_frac]
    first = (late or marks or [None])[0]
    for i, c in enumerate(cues):
        if i == first:
            rest = ' '.join(x.get('text') or '' for x in cues[i:])
            total = (cues[-1].get('end') or 0) or 1
            return {'at': round(c.get('start') or 0), 'frac': round((c.get('start') or 0) / total, 3),
                    'asks': len(ASK_RE.findall(rest)), 'chars_after': len(re.sub(r'\s', '', rest))}
    return None


def similarity(a, b, cap=4000):
    """兩份逐字稿(同一段)的字元相似度 0~1(⛔ 不是準度,只是兩個辨識器講得一不一樣)。"""
    a = re.sub(r'\s', '', a or '')[:cap]
    b = re.sub(r'\s', '', b or '')[:cap]
    if not a or not b:
        return None
    return round(difflib.SequenceMatcher(None, a, b, autojunk=False).ratio(), 3)


def thin_pages(pages, thin=THIN):
    """抽得到的字不到 thin 的頁(頁碼從 1 開始);⛔ 封面(第 1 頁)不算 —— 它本來就只有標題。"""
    return [i + 1 for i, p in enumerate(pages or []) if i > 0 and len(re.sub(r'\s', '', p or '')) < thin]


# 🏢 qa 模式的純函式(yq_of / links_of / split_qa_text / count_questions …)V79.7.6 搬到根目錄 lib_transcript.py(⛔ 第二份)
from lib_transcript import (ASK_RE, yq_of, reported_q, prev_q, links_of, is_transcript, is_nav,  # noqa: E402,F401
                            split_qa_text, count_questions, sentences_of)

def only_in_qa(qa_text, ref_text, cd=None, min_val=1):
    """問答段的「數字句」(講營運 KPI + 有數字,照 confcall_deck.nums_of 的判法)與「展望句」(outlook_of)裡,
    數字是簡報 / 前半段沒有的佔幾成。⭐ 決定性對照:問答段換成 ref 原文 → 比例 = 0。"""
    if cd is None:
        import confcall_deck as cd
    lines = [(1, x) for x in sentences_of(qa_text)]
    num_s = cd.nums_of(lines, limit=10000)
    out_s = cd.outlook_of(lines, limit=10000)
    ref = nums_in(ref_text, min_val=min_val)
    only = [x for _, x in num_s if nums_in(x, min_val=min_val) - ref]
    ol_num = [x for _, x in out_s if nums_in(x, min_val=min_val)]
    ol_only = [x for x in ol_num if nums_in(x, min_val=min_val) - ref]
    return {'num_sent': len(num_s), 'only_num_sent': len(only), 'share': round(len(only) / len(num_s), 3) if num_s else None,
            'outlook': len(out_s), 'outlook_num': len(ol_num), 'outlook_only': len(ol_only), 'eg': only[:3]}


JUNK_RE = re.compile(r'不吝点赞|不吝點讚|订阅|訂閱|转发|轉發|打赏|打賞|字幕志愿者|字幕志願者|字幕由|明镜与点点|明鏡與點點|独播剧场|獨播劇場|'
                     r'YoYo Television|Amara\.org|谢谢观看|謝謝觀看|请订阅|請訂閱')


def clean_cues(cues):
    """Whisper 在靜音 / 片頭音樂會冒固定的幻覺字(10/24 實測:「请不吝点赞 订阅…」「字幕志愿者 李宗盛」)→ 那幾段整句丟掉;
    連續一模一樣的句子只留一句。回 (乾淨的, 丟掉幾段)。"""
    out, drop, last = [], 0, None
    for c in cues or []:
        t = (c.get('text') or '').strip()
        if not t or JUNK_RE.search(t):
            drop += 1
            continue
        if t == last:
            drop += 1
            continue
        last = t
        out.append(c)
    return out, drop


_CC = []


def to_trad(text):
    """簡轉繁(OpenCC s2twp:臺灣用字 + 慣用詞);沒裝就原樣回傳。"""
    if not _CC:
        try:
            from opencc import OpenCC
            _CC.append(OpenCC('s2twp'))
        except Exception:
            _CC.append(None)
    return _CC[0].convert(text) if _CC[0] else text


def qa_gate(n_calls_3q, share_med):
    """第 1 步過不過關:估計有幾場「至少 3 個提問」+ 問答數字句「只在問答」比例中位數。"""
    ok_n = (n_calls_3q or 0) >= QA_GATE_CALLS
    ok_s = share_med is not None and share_med >= QA_GATE_SHARE
    return {'pass': ok_n and ok_s, 'calls_3q': n_calls_3q, 'share_med': share_med, 'need_calls': QA_GATE_CALLS, 'need_share': QA_GATE_SHARE}


def pick_samples(rows, ok_files, rng, per_year, other_per_kind):
    """從清單挑:① 證交所 mp4 逐年 per_year 場(只挑簡報已讀成功的,才有東西可以比)② 其他平台每種 other_per_kind 場。
    回 {'ir': {年: [row…]}, 'other': {kind: [row…]}}。⛔ 還沒開的場次(日期在今天之後)不挑。"""
    today = time.strftime('%Y-%m-%d')
    ir, other = {}, {}
    for r in rows:
        v = r.get('vid') or ''
        d = r.get('d') or ''
        if not v or not d or d > today:
            continue
        r = dict(r, deck=next((f for f in (r.get('pdf') or []) if f in ok_files), None))
        k = kind_of(v)
        if k == 'ir_mp4':
            ir.setdefault(d[:4], []).append(r)
        elif k in ('youtube', 'zucast', 'vimeo', 'twse_vod', 'gdrive'):
            other.setdefault(k, []).append(r)
    out_ir = {}
    for y, lst in sorted(ir.items()):
        withdeck = [r for r in lst if r['deck']]
        nodeck = [r for r in lst if not r['deck']]
        rng.shuffle(withdeck)
        rng.shuffle(nodeck)
        out_ir[y] = (withdeck + nodeck)[:per_year]      # 簡報讀過的排前面(轉逐字稿只挑這些);不夠才補沒讀過的(只問抓不抓得到)
    out_o = {}
    for k, lst in sorted(other.items()):
        lst = sorted(lst, key=lambda r: (0 if r['deck'] else 1, r['d']), reverse=False)
        cand = [r for r in lst if r['deck']] or lst
        rng.shuffle(cand)
        out_o[k] = cand[:other_per_kind]
    return {'ir': out_ir, 'other': out_o}


def pages_of(cc_dir, f, d):
    """從 cc/text/{YYYY-MM}.json.gz 拿某份簡報的全文(每頁一格)。⚠️ 月份照 index.json 的 tx,沒有就用場次日期。"""
    tx = None
    try:
        idx = json.loads((Path(cc_dir) / 'cc' / 'index.json').read_text(encoding='utf-8'))
        tx = ((idx.get('files') or {}).get(f) or {}).get('tx')
    except Exception:
        pass
    for m in [tx, (d or '')[:7]]:
        if not m:
            continue
        p = Path(cc_dir) / 'cc' / 'text' / f'{m}.json.gz'
        if p.exists():
            try:
                obj = json.loads(gzip.decompress(p.read_bytes()))
            except Exception:
                continue
            if f in obj:
                return obj[f].get('p') or []
    return None


# ───────────────────────── 連網那幾段(只在 Actions 跑) ─────────────────────────
def _keys():
    raw = os.getenv('GROQ_API_KEYS') or os.getenv('GROQ_API_KEY') or ''
    return [k.strip() for k in re.split(r'[,\s]+', raw) if k.strip()]


def head_mp4(url):
    """只問檔頭(⛔ 不下載):狀態碼 + 大小;再用 ffprobe 讀長度(它只讀 moov 那一小段)。"""
    import requests
    out = {'url': url}
    try:
        r = requests.head(url, timeout=20, allow_redirects=True, headers=UA)
        if r.status_code in (403, 405):
            r = requests.get(url, timeout=20, stream=True, headers=dict(UA, Range='bytes=0-1023'))
            r.close()
        out['http'] = r.status_code
        out['mb'] = round(int(r.headers.get('Content-Length') or 0) / 1048576, 1) if r.status_code == 200 else None
        out['ctype'] = (r.headers.get('Content-Type') or '')[:40]
    except Exception as e:
        out['http'] = None
        out['err'] = f'{type(e).__name__}: {str(e)[:80]}'
        return out
    if out.get('http') in (200, 206) and shutil.which('ffprobe'):
        try:
            p = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url],
                               capture_output=True, text=True, timeout=60)
            out['sec'] = round(float(p.stdout.strip() or 0)) or None
        except Exception as e:
            out['sec_err'] = type(e).__name__
    return out


def ytdlp_probe(url):
    """yt-dlp 只問不下載;回 {ok, sec, err}。⛔ 沒有 cookies(GitHub 機器上 YouTube 常被擋 → 照實記)。"""
    try:
        import yt_dlp
    except ImportError:
        return {'url': url, 'ok': False, 'err': 'yt-dlp 沒裝'}
    try:
        with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True, 'skip_download': True}) as y:
            info = y.extract_info(url, download=False)
        return {'url': url, 'ok': True, 'sec': info.get('duration'), 'ext': info.get('ext'), 'title': (info.get('title') or '')[:40]}
    except Exception as e:
        return {'url': url, 'ok': False, 'err': re.sub(r'\s+', ' ', str(e))[:140]}


def download(url, kind, dest):
    """回 (路徑, 秒數)。證交所 mp4 一般下載(邊下邊寫,⛔ 整份讀進記憶體);其他用 yt-dlp 抓音軌。"""
    t0 = time.time()
    if kind == 'ir_mp4' or kind == 'file':
        import requests
        p = Path(dest) / 'in.mp4'
        # 🔁 V79.7.3 第一輪實測:480 MB 那場下載到 1 MB 就斷線(IncompleteRead)→ 斷了用 Range 從斷點續傳,最多 6 次
        got, total, tries = 0, None, 0
        with open(p, 'wb') as fh:
            while True:
                hdr = dict(UA, Range=f'bytes={got}-') if got else dict(UA)
                try:
                    with requests.get(url, timeout=60, stream=True, headers=hdr) as r:
                        r.raise_for_status()
                        if got and r.status_code != 206:          # 主機不理 Range → 整份重來
                            fh.seek(0)
                            fh.truncate()
                            got = 0
                        if total is None:
                            cl = r.headers.get('Content-Length')
                            total = (int(cl) + got) if cl and cl.isdigit() else None
                        for chunk in r.iter_content(1 << 20):
                            fh.write(chunk)
                            got += len(chunk)
                            if got > MAX_MB * 1048576:
                                raise RuntimeError(f'超過 {MAX_MB:.0f} MB')
                    if total is None or got >= total:
                        break
                except RuntimeError:
                    raise
                except Exception as e:  # 斷線 → 續傳
                    if tries >= 6:
                        raise RuntimeError(f'續傳 {tries} 次仍斷線({got >> 20} MB / {(total or 0) >> 20} MB):{str(e)[:60]}')
                tries += 1
                if tries > 6:
                    raise RuntimeError(f'續傳 {tries} 次仍不完整({got >> 20} MB / {(total or 0) >> 20} MB)')
                time.sleep(2 * tries)
        download.retries = tries
        return p, time.time() - t0
    import yt_dlp
    opts = {'quiet': True, 'no_warnings': True, 'format': 'bestaudio/best', 'outtmpl': str(Path(dest) / 'in.%(ext)s')}
    with yt_dlp.YoutubeDL(opts) as y:
        y.extract_info(url, download=True)
    files = sorted(Path(dest).glob('in.*'), key=lambda x: x.stat().st_size)
    if not files:
        raise RuntimeError('沒下載到檔案')
    return files[-1], time.time() - t0


def to_chunks(path, dest, seg=SEG):
    """16kHz 單聲道 flac,每 seg 秒一段。回 [路徑…]。"""
    pat = str(Path(dest) / 'c_%04d.flac')
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(path), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac',
                    '-f', 'segment', '-segment_time', str(seg), pat], check=True)
    return sorted(str(p) for p in Path(dest).glob('c_*.flac'))


def _dur(path):
    try:
        p = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                           capture_output=True, text=True, timeout=60)
        return float(p.stdout.strip() or 0)
    except Exception:
        return 0.0


class Groq:
    """多把金鑰輪流;429 換下一把,全部都 429 就等(⛔ 無限等:超過時限就停)。🔐 log 只寫第幾把。"""
    def __init__(self, keys):
        self.keys, self.i = list(keys), 0
        self.used_sec = 0.0
        self.notes = []

    def _post(self, url, files=None, data=None, json_body=None, timeout=600):
        import requests
        tries, waited = 0, 0
        while self.keys and time.time() < DEADLINE:
            k = self.keys[self.i % len(self.keys)]
            h = {'Authorization': f'Bearer {k}'}
            try:
                r = requests.post(url, headers=h, files=files, data=data, json=json_body, timeout=timeout)
            except Exception as e:
                tries += 1
                if tries >= 4:
                    raise RuntimeError(f'連線失敗 {type(e).__name__}')
                time.sleep(5 * tries)
                continue
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429 or r.status_code >= 500:
                self.notes.append(f'key#{self.i % len(self.keys) + 1} HTTP {r.status_code}')
                self.i += 1
                if self.i % len(self.keys) == 0:          # 每一把都滿了 → 等一下
                    wait = min(120, 15 * (1 + waited))
                    waited += 1
                    if waited > 8:
                        raise RuntimeError('每一把金鑰都被限流(多半是音訊額度用完)')
                    time.sleep(wait)
                continue
            raise RuntimeError(f'HTTP {r.status_code}: {r.text[:160]}')
        raise RuntimeError('沒有金鑰或超過時限')

    def asr(self, path):
        with open(path, 'rb') as fh:
            j = self._post(GROQ_ASR_URL, files={'file': ('a.flac', fh, 'audio/flac')},
                           data={'model': GROQ_ASR_MODEL, 'response_format': 'verbose_json', 'temperature': '0', 'language': 'zh'})
        self.used_sec += _dur(path)
        segs = [{'start': float(s.get('start') or 0), 'end': float(s.get('end') or 0), 'text': (s.get('text') or '').strip()}
                for s in (j.get('segments') or []) if (s.get('text') or '').strip()]
        return segs or ([{'start': 0, 'end': 0, 'text': (j.get('text') or '').strip()}] if j.get('text') else [])

    def models(self):
        import requests
        for k in self.keys:
            try:
                r = requests.get(GROQ_MODELS_URL, headers={'Authorization': f'Bearer {k}'}, timeout=15)
                if r.status_code == 200:
                    return [m.get('id') for m in (r.json().get('data') or []) if m.get('id')]
            except Exception:
                continue
        return []

    def vision(self, model, png_bytes):
        b64 = base64.b64encode(png_bytes).decode()
        body = {'model': model, 'temperature': 0, 'max_tokens': 1500, 'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': OCR_PROMPT},
            {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{b64}'}}]}]}
        j = self._post(GROQ_CHAT_URL, json_body=body, timeout=120)
        return ((j.get('choices') or [{}])[0].get('message') or {}).get('content') or ''


def _gem_keys():
    raw = os.getenv('GEMINI_API_KEYS') or os.getenv('GEMINI_API_KEY') or ''
    return [k.strip() for k in re.split(r'[,\s]+', raw) if k.strip()]


def gem_model(keys):
    """🔁 第二輪實測 Groq 清單上已經沒有視覺模型 → 讀圖改用 Gemini(同一個挑模型規則:macro_miner._pick_gemini_model,⛔ 第四份)。"""
    import requests
    ids = []
    for k in keys:
        try:
            r = requests.get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', headers={'x-goog-api-key': k}, timeout=20)
            if r.status_code == 200:
                ids = [str(m.get('name', '')).replace('models/', '', 1) for m in (r.json().get('models') or [])
                       if 'generateContent' in (m.get('supportedGenerationMethods') or ['generateContent'])]
                break
        except Exception:
            continue
    try:
        import macro_miner as mm
        return mm._pick_gemini_model(ids, mm.GEMINI_MODEL_MM)
    except Exception as e:
        print(f'  ⚠️ 讀不到 macro_miner 的挑模型規則({type(e).__name__})→ 用 gemini-2.5-flash', flush=True)
        return 'gemini-2.5-flash'


def gem_vision(keys, model, png_bytes):
    """Gemini 讀一張圖(🔐 金鑰放標頭);429 換下一把。"""
    import requests
    body = {'contents': [{'role': 'user', 'parts': [{'text': OCR_PROMPT},
                                                   {'inline_data': {'mime_type': 'image/png', 'data': base64.b64encode(png_bytes).decode()}}]}],
            'generationConfig': {'temperature': 0, 'maxOutputTokens': 2000, 'thinkingConfig': {'thinkingBudget': 0}}}
    last = ''
    for k in keys:
        r = requests.post(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
                          headers={'x-goog-api-key': k, 'Content-Type': 'application/json'}, json=body, timeout=120)
        if r.status_code == 200:
            c = (r.json().get('candidates') or [{}])[0]
            return ''.join(p.get('text', '') for p in ((c.get('content') or {}).get('parts') or []))
        last = f'HTTP {r.status_code} {r.text[:80]}'
        if r.status_code not in (429, 403, 500, 503):
            break
    raise RuntimeError(last)


def local_asr(chunk, model_name):
    """本機 faster-whisper(CPU int8)轉一段;回 (文字, 花幾秒, 音訊幾秒)。"""
    from faster_whisper import WhisperModel
    t0 = time.time()
    m = WhisperModel(model_name, device='cpu', compute_type='int8')
    load = time.time() - t0
    t1 = time.time()
    segs, info = m.transcribe(chunk, language='zh', beam_size=1, condition_on_previous_text=False, vad_filter=True)
    txt = ''.join(s.text for s in segs)
    return txt, time.time() - t1, float(getattr(info, 'duration', 0) or 0), load


# ───────────────────────── 主流程 ─────────────────────────
def main():
    cc_dir = Path(os.getenv('CC_DIR') or 'ccd')
    out = Path(os.getenv('OUT') or '/tmp/av')
    out.mkdir(parents=True, exist_ok=True)
    (out / 'tx').mkdir(exist_ok=True)
    (out / 'ocr').mkdir(exist_ok=True)
    import confcall_deck as cd
    bl = json.loads(gzip.decompress((cc_dir / 'cc' / 'backlog.json.gz').read_bytes()))
    idx = json.loads((cc_dir / 'cc' / 'index.json').read_text(encoding='utf-8'))
    ok_files = {f for f, x in (idx.get('files') or {}).items() if x.get('st') == 'ok'}
    rows = bl.get('rows') or []
    rng = random.Random(SEED)
    smp = pick_samples(rows, ok_files, rng, AVAIL_PER_YEAR, OTHER_PER_KIND)
    rep = {'at': time.strftime('%Y-%m-%d %H:%M'), 'rows': len(rows), 'with_vid': sum(1 for r in rows if r.get('vid')),
           'kinds': {}, 'avail_ir': {}, 'avail_other': {}, 'groq': [], 'local': [], 'ocr': [], 'notes': []}
    for r in rows:
        if r.get('vid'):
            k = kind_of(r['vid'])
            rep['kinds'][k] = rep['kinds'].get(k, 0) + 1
    print(f'📋 清單 {len(rows):,} 場 ・有影音 {rep["with_vid"]:,} ・{rep["kinds"]}', flush=True)

    # ① 還抓不抓得到
    ir_ok = []
    for y, lst in smp['ir'].items():
        res = [head_mp4(r['vid']) for r in lst]
        ok = [x for x in res if x.get('http') in (200, 206)]
        secs = sorted(x['sec'] for x in ok if x.get('sec'))
        rep['avail_ir'][y] = {'asked': len(res), 'ok': len(ok), 'med_min': round(secs[len(secs) // 2] / 60) if secs else None,
                              'med_mb': sorted(x['mb'] for x in ok if x.get('mb'))[len(ok) // 2] if any(x.get('mb') for x in ok) else None,
                              'fail': [f"{x.get('http')}{(' ' + x['err']) if x.get('err') else ''}" for x in res if x.get('http') not in (200, 206)][:5]}
        for r, x in zip(lst, res):
            if x.get('http') in (200, 206):
                ir_ok.append(dict(r, sec=x.get('sec'), mb=x.get('mb')))
        print(f'① 證交所 mp4 {y}:問 {len(res)} 場 → 拿得到 {len(ok)} ・長度中位 {rep["avail_ir"][y]["med_min"]} 分', flush=True)
    for k, lst in smp['other'].items():
        res = [ytdlp_probe(r['vid']) for r in lst]
        rep['avail_other'][k] = {'asked': len(res), 'ok': sum(1 for x in res if x.get('ok')),
                                 'err': [x.get('err') for x in res if not x.get('ok')][:3]}
        print(f'① {k}:問 {len(res)} → 拿得到 {rep["avail_other"][k]["ok"]} ・{rep["avail_other"][k]["err"][:1]}', flush=True)

    keys = _keys()
    gq = Groq(keys)
    if not keys:
        rep['notes'].append('沒有 GROQ_API_KEYS → ②⑤ 不做')
    # ② Groq 整場轉(逐年挑,越分散越好;⛔ 超過時限就停)
    by_year = {}
    for r in ir_ok:
        if r.get('deck'):                       # 轉逐字稿只挑簡報讀過的(才有東西可以對)
            by_year.setdefault(r['d'][:4], []).append(r)
    order = []
    while len(order) < max(TRANS_N, LOCAL_N) and any(by_year.values()):
        for y in sorted(by_year, reverse=True):
            if by_year[y]:
                order.append(by_year[y].pop(0))
            if len(order) >= max(TRANS_N, LOCAL_N):
                break
    for i, r in enumerate(order):
        if time.time() > DEADLINE - 20 * 60:
            rep['notes'].append(f'時間到,轉了 {i} 場就停')
            break
        rec = {'s': r['s'], 'name': r.get('name'), 'd': r['d'], 'url': r['vid'], 'deck': r.get('deck')}
        with tempfile.TemporaryDirectory() as td:
            try:
                path, dl = download(r['vid'], 'ir_mp4', td)
                rec['dl_sec'] = round(dl)
                rec['mb'] = round(path.stat().st_size / 1048576, 1)
                rec['dl_retries'] = getattr(download, 'retries', 0)
                rec['mb_per_s'] = round(rec['mb'] / max(dl, 1), 2)
                chunks = to_chunks(path, td)
                rec['audio_min'] = round(sum(_dur(c) for c in chunks) / 60, 1)
            except Exception as e:
                rec['err'] = f'下載 / 切段失敗:{str(e)[:120]}'
                rep['groq'].append(rec)
                print(f'② {r["s"]} {r["d"]} ❌ {rec["err"]}', flush=True)
                continue
            deck_pages = pages_of(cc_dir, r.get('deck'), r['d']) if r.get('deck') else None
            deck_text = '\n'.join(deck_pages or [])
            terms = list(cd.terms_of(deck_pages).keys()) if deck_pages else []
            # ③ 本機:只轉第一段,量速度(turbo / small)
            first_local = {}
            if i < LOCAL_N and chunks:
                for mname in ('large-v3-turbo', 'small'):
                    if time.time() > DEADLINE - 25 * 60:
                        break
                    try:
                        txt, spent, asec, load = local_asr(chunks[0], mname)
                        first_local[mname] = txt
                        rep['local'].append({'s': r['s'], 'd': r['d'], 'model': mname, 'audio_sec': round(asec), 'spent_sec': round(spent),
                                             'x_realtime': round(spent / asec, 2) if asec else None, 'load_sec': round(load)})
                        print(f'③ 本機 {mname}:{asec:.0f} 秒音訊花 {spent:.0f} 秒(×{spent / max(asec, 1):.2f})', flush=True)
                    except Exception as e:
                        rep['local'].append({'s': r['s'], 'model': mname, 'err': str(e)[:120]})
            for m, t in first_local.items():          # 🔁 沒有 Groq 也存本機那段,並對簡報數字(只有前 10 分鐘)
                (out / 'tx' / f"{r['s']}_{r['d']}_local_{m}.txt").write_text(t, encoding='utf-8')
                if deck_text:
                    rec.setdefault('local_num', {})[m] = num_match(t, deck_text)
                rec.setdefault('local_chars', {})[m] = len(re.sub(r'\s', '', t))
            if i < TRANS_N and keys:
                t0 = time.time()
                cues = []
                try:
                    for j, c in enumerate(chunks):
                        for cu in gq.asr(c):
                            cues.append({'start': cu['start'] + j * SEG, 'end': cu['end'] + j * SEG, 'text': cu['text']})
                except Exception as e:
                    rec['asr_err'] = str(e)[:160]
                rec['asr_sec'] = round(time.time() - t0)
                text = '\n'.join(c['text'] for c in cues)
                rec['chars'] = len(re.sub(r'\s', '', text))
                rec['num'] = num_match(text, deck_text) if deck_text else None
                rec['terms'] = term_match(text, terms)
                rec['qa'] = qa_split(cues)
                first = '\n'.join(c['text'] for c in cues if c['start'] < SEG)
                rec['vs_local'] = {m: similarity(first, t) for m, t in first_local.items()}
                (out / 'tx' / f"{r['s']}_{r['d']}.txt").write_text(
                    '\n'.join(f"[{int(c['start'] // 60):02d}:{int(c['start'] % 60):02d}] {c['text']}" for c in cues), encoding='utf-8')
                for m, t in first_local.items():
                    (out / 'tx' / f"{r['s']}_{r['d']}_local_{m}.txt").write_text(t, encoding='utf-8')
                if deck_text:
                    (out / 'tx' / f"{r['s']}_{r['d']}_deck.txt").write_text(deck_text, encoding='utf-8')
                print(f"② {r['s']} {r.get('name')} {r['d']}:{rec['audio_min']} 分 → Groq {rec['asr_sec']} 秒 ・{rec['chars']:,} 字"
                      f" ・數字 {rec['num']} ・產品詞 {rec['terms'].get('hit')}/{rec['terms'].get('n')} ・問答 {rec['qa']}", flush=True)
            rep['groq'].append(rec)
    rep['groq_audio_sec'] = round(gq.used_sec)
    rep['groq_notes'] = gq.notes[-10:]

    # ⑤ 圖片頁 → 視覺模型
    gkeys = _gem_keys()
    if (keys or gkeys) and OCR_N > 0 and time.time() < DEADLINE - 10 * 60:
        ids = gq.models() if keys else []
        rep['groq_models'] = ids
        model = next((m for m in VISION_PREF if m in ids), None) or next((m for m in ids if VISION_RE.search(m)), None)
        rep['vision_candidates'] = [m for m in ids if VISION_RE.search(m)][:10]
        print(f'⑤ Groq 視覺模型:{model}(清單 {len(ids)} 個,像視覺的:{rep["vision_candidates"]})', flush=True)
        gmodel = None
        if not model and gkeys:
            gmodel = gem_model(gkeys)
            print(f'⑤ Groq 沒有視覺模型 → 改用 Gemini {gmodel}', flush=True)
        rep['vision_model'] = model or (f'gemini:{gmodel}' if gmodel else None)
        if (model or gmodel) and shutil.which('pdftoppm'):
            # 挑「圖片頁比較多」的簡報,最近兩年優先(圖表數字最有用的那種)
            cands = []
            for f, x in (idx.get('files') or {}).items():
                if x.get('st') != 'ok' or (x.get('d') or '') < '2025-01-01':
                    continue
                pg = pages_of(cc_dir, f, x.get('d'))
                if not pg or len(pg) < 8:
                    continue
                tp = thin_pages(pg)
                if 3 <= len(tp) <= len(pg) * 0.6:
                    cands.append((f, x, pg, tp))
            rng.shuffle(cands)
            fetcher = cd.Fetcher()
            done = 0
            for f, x, pg, tp in cands[:max(2, OCR_N // 3)]:
                if done >= OCR_N or time.time() > DEADLINE - 5 * 60:
                    break
                b, err, _ = fetcher.get_any(cd.file_urls(None, f))
                if b is None or not b[:5] == b'%PDF-':
                    rep['ocr'].append({'f': f, 'err': f'下載不到:{str(err)[:80]}'})
                    continue
                with tempfile.TemporaryDirectory() as td:
                    pdf = Path(td) / 'd.pdf'
                    pdf.write_bytes(b)
                    other_text = '\n'.join(p for k, p in enumerate(pg) if (k + 1) not in tp)
                    for pno in tp[:3]:
                        if done >= OCR_N:
                            break
                        subprocess.run(['pdftoppm', '-f', str(pno), '-l', str(pno), '-r', '110', '-png', str(pdf), str(Path(td) / 'p')],
                                       check=False, capture_output=True, timeout=60)
                        pngs = sorted(Path(td).glob('p*.png'))
                        if not pngs:
                            continue
                        png = pngs[-1].read_bytes()
                        for q in pngs:
                            q.unlink()
                        tag = f"{f.replace('.pdf', '')}_p{pno}"
                        (out / 'ocr' / f'{tag}.png').write_bytes(png)
                        try:
                            t0 = time.time()
                            txt = gq.vision(model, png) if model else gem_vision(gkeys, gmodel, png)
                            spent = time.time() - t0
                        except Exception as e:
                            rep['ocr'].append({'f': f, 'p': pno, 'err': str(e)[:120]})
                            continue
                        (out / 'ocr' / f'{tag}.txt').write_text(txt, encoding='utf-8')
                        n_v = nums_in(txt, min_val=1)
                        n_o = nums_in(other_text, min_val=1)
                        rep['ocr'].append({'f': f, 's': x.get('s'), 'd': x.get('d'), 'p': pno,
                                           'pdf_chars': len(re.sub(r'\s', '', pg[pno - 1] or '')),
                                           'ocr_chars': len(re.sub(r'\s', '', txt)), 'ocr_nums': len(n_v),
                                           'also_elsewhere': len(n_v & n_o), 'unclear': txt.count('[?]'), 'sec': round(spent, 1)})
                        done += 1
                        print(f"⑤ {tag}:PDF 抽到 {rep['ocr'][-1]['pdf_chars']} 字 → 視覺模型 {rep['ocr'][-1]['ocr_chars']} 字・"
                              f"{len(n_v)} 個數字(其中 {len(n_v & n_o)} 個簡報別頁也有)", flush=True)

    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'💾 {out}/report.json', flush=True)
    # 🧾 附件下載不到時也看得到:重點直接印進 log(逐字稿只印頭尾一小段)
    print('\n════ 摘要 ════', flush=True)
    for rec in rep['groq']:
        print(f"🎙️ {rec.get('s')} {rec.get('name')} {rec.get('d')} ・{rec.get('mb')} MB ・下載 {rec.get('dl_sec')} 秒"
              f"({rec.get('mb_per_s')} MB/s、續傳 {rec.get('dl_retries')} 次)・{rec.get('audio_min')} 分 ・Groq {rec.get('asr_sec')} 秒"
              f" ・本機 vs Groq 相似度 {rec.get('vs_local')} ・本機前 10 分數字 {rec.get('local_num')} ・{rec.get('err') or rec.get('asr_err') or ''}", flush=True)
        if rec.get('terms'):
            print(f"   產品詞沒聽到:{rec['terms'].get('miss')}", flush=True)
        f = out / 'tx' / f"{rec.get('s')}_{rec.get('d')}.txt"
        if f.exists():
            t = f.read_text(encoding='utf-8')
            print('   ── 逐字稿開頭 ──\n' + t[:700] + '\n   ── 結尾 ──\n' + t[-500:], flush=True)
        for m in ('large-v3-turbo', 'small'):
            g = out / 'tx' / f"{rec.get('s')}_{rec.get('d')}_local_{m}.txt"
            if g.exists():
                print(f'   ── 本機 {m} 開頭 ──\n' + g.read_text(encoding='utf-8')[:400], flush=True)
    for x in rep['ocr']:
        print(f"🖼️ {x}", flush=True)
        tag = f"{str(x.get('f', '')).replace('.pdf', '')}_p{x.get('p')}"
        g = out / 'ocr' / f'{tag}.txt'
        if g.exists():
            print('   ── 讀出來的 ──\n' + g.read_text(encoding='utf-8')[:600], flush=True)
    any_ok = any(v['ok'] for v in rep['avail_ir'].values())
    if not any_ok:
        print('❌ 證交所 mp4 一場都拿不到 → 紅燈(報告照寫)', flush=True)
        return 1
    return 0


def _get(url, timeout=20, max_mb=40):
    """GET 一個網址 → (狀態碼, Content-Type, bytes);失敗回 (None, 錯誤, b'')。"""
    import requests
    try:
        with requests.get(url, timeout=timeout, stream=True, headers=UA, allow_redirects=True) as r:
            buf, got = [], 0
            for ch in r.iter_content(1 << 16):
                buf.append(ch)
                got += len(ch)
                if got > max_mb * 1048576:
                    break
            return r.status_code, (r.headers.get('Content-Type') or ''), b''.join(buf)
    except Exception as e:
        return None, f'{type(e).__name__}', b''


def _html_text(b, ctype=''):
    m = re.search(r'charset=([\w-]+)', ctype or '', re.I) or re.search(rb'charset=["\']?([\w-]+)', b[:3000] or b'', re.I)
    enc = (m.group(1).decode() if isinstance(m.group(1), bytes) else m.group(1)) if m else 'utf-8'
    for e in (enc, 'utf-8', 'big5', 'cp950'):
        try:
            return b.decode(e)
        except Exception:
            continue
    return b.decode('utf-8', 'replace')


def main_qa():
    """🏢 qa 模式:大型公司的官方逐字稿 + 證交所影片 → 問答量測 → 過關門檻。"""
    from urllib.parse import urlparse
    import statistics as st
    cc_dir = Path(os.getenv('CC_DIR') or 'ccd')
    out = Path(os.getenv('OUT') or '/tmp/av')
    (out / 'qa').mkdir(parents=True, exist_ok=True)
    import confcall_deck as cd
    bl = json.loads(gzip.decompress((cc_dir / 'cc' / 'backlog.json.gz').read_bytes()))
    idx = json.loads((cc_dir / 'cc' / 'index.json').read_text(encoding='utf-8'))
    ok_files = {f for f, x in (idx.get('files') or {}).items() if x.get('st') == 'ok'}
    scr = json.loads(Path(os.getenv('AV_SCREENER') or 'scr.json').read_text(encoding='utf-8'))
    cols = scr.get('cols') or []
    ci, ei = cols.index('mcap'), cols.index('etf')
    mc = {sy: v[ci] for sy, v in (scr.get('rows') or {}).items() if len(sy) == 4 and v[ci] and not v[ei]}
    rank = sorted(mc, key=lambda x: -mc[x])
    today = time.strftime('%Y-%m-%d')
    rows = [r for r in (bl.get('rows') or []) if (r.get('d') or '') and r['d'] <= today]
    by_s = {}
    for r in rows:
        by_s.setdefault(r['s'], []).append(r)
    rep = {'at': time.strftime('%Y-%m-%d %H:%M'), 'top': QA_TOP, 'co': [], 'read': [], 'asr': [], 'notes': []}
    print(f'🏢 qa 模式:市值前 {QA_TOP} 名(screener {scr.get("data_date")})・清單 {len(rows):,} 場', flush=True)

    # ① 找官方逐字稿
    trans, ok_pages = {}, [0]
    for sy in rank[:QA_TOP]:
        if time.time() > DEADLINE - 60 * 60:
            rep['notes'].append('時間到,找逐字稿停在 ' + sy)
            break
        rs = sorted(by_s.get(sy) or [], key=lambda r: r['d'], reverse=True)
        if not rs:
            continue
        pages = []
        for r in rs:
            v = (r.get('vid') or '').strip()
            if v and kind_of(v) == 'other' and v not in pages:
                pages.append(v)
                if '/chinese/' in v and v.replace('/chinese/', '/english/') not in pages:
                    pages.append(v.replace('/chinese/', '/english/'))
        pages = pages[:6]
        found, fetched, nav_done = {}, 0, set()
        queue = list(pages)
        while queue and fetched < 10:
            u = queue.pop(0)
            code, ctype, b = _get(u)
            fetched += 1
            if code != 200 or not b or 'html' not in (ctype or 'html').lower():
                continue
            ok_pages[0] += 1
            html = _html_text(b, ctype)
            host = urlparse(u).netloc
            for lu, lt in links_of(html, u):
                if is_transcript(lu, lt):
                    found.setdefault(lu, {'t': lt[:80], 'yq': yq_of(lt) or yq_of(lu)})
                elif is_nav(lu, lt, host) and lu not in nav_done and lu not in pages and len(nav_done) < 4 and not found:
                    nav_done.add(lu)
                    queue.append(lu)
        calls = [r for r in rs if r['d'] >= '2021-07-01']
        yqs = {x['yq'] for x in found.values() if x['yq']}
        # 對到幾季:法說會那幾季(2021-07 起,同一季開好幾場算一季)有幾季找得到逐字稿
        cq = {reported_q(r['d']) for r in calls}
        hit = len({x for x in cq if x in yqs or prev_q(x) in yqs})
        name = rs[0].get('name')
        rec = {'s': sy, 'name': name, 'calls': len(calls), 'call_q': len(cq), 'pages': fetched, 'trans': len(found), 'yq_n': len(yqs),
               'yq_from': min(yqs) if yqs else None, 'yq_to': max(yqs) if yqs else None, 'calls_hit': hit,
               'eg': [{'u': u, **x} for u, x in list(found.items())[:3]]}
        rep['co'].append(rec)
        if found:
            trans[sy] = found
        print(f"🔎 {sy} {name}:問 {fetched} 頁 → 逐字稿連結 {len(found)} 個(有季別 {len(yqs)} 季:{rec['yq_from']}~{rec['yq_to']})"
              f"・2021-07 起開過 {len(cq)} 季、對到 {hit} 季", flush=True)
    co_with = [c for c in rep['co'] if c['trans']]
    calls_with = sum(c['yq_n'] for c in rep['co'])           # 回測用得到的:每一季一份(2010 起都算,價格有到那麼早)
    print(f'\n🔎 有官方逐字稿的公司 {len(co_with)}/{len(rep["co"])} 家 ・有季別的逐字稿 {calls_with} 份'
          f" ・2021-07 起對到 {sum(c['calls_hit'] for c in rep['co'])} / {sum(c['call_q'] for c in rep['co'])} 季", flush=True)

    # ② 讀幾份
    order, ptr = [], {sy: sorted(v.items(), key=lambda kv: kv[1]['yq'] or (0, 0), reverse=True) for sy, v in trans.items()}
    while len(order) < QA_READ and any(ptr.values()):
        for sy in list(ptr):
            if ptr[sy]:
                order.append((sy,) + ptr[sy].pop(0))
            if len(order) >= QA_READ:
                break
    for sy, u, x in order:
        if time.time() > DEADLINE - 40 * 60:
            rep['notes'].append('時間到,讀逐字稿停')
            break
        rec = {'s': sy, 'u': u, 'yq': x['yq']}
        code, ctype, b = _get(u, timeout=60)
        if code != 200 or not b:
            rec['err'] = f'下載不到 {code} {ctype}'[:80]
            rep['read'].append(rec)
            continue
        if b[:5] != b'%PDF-':
            rec['err'] = f'不是 PDF({ctype[:30]})'
            rep['read'].append(rec)
            continue
        pages, err = cd.extract_safe(b)
        text = '\n'.join(pages or [])
        rec['pages'] = len(pages or [])
        rec['chars'] = len(re.sub(r'\s', '', text))
        sp = split_qa_text(text)
        if not sp:
            rec['qa'] = None
            rep['read'].append(rec)
            print(f"📄 {sy} {x['yq']}:{rec['pages']} 頁 {rec['chars']:,} 字 ・⛔ 切不到問答", flush=True)
            continue
        pres, qa, at = sp
        rec.update(qa_at=at, qa_chars=len(re.sub(r'\s', '', qa)), q_n=count_questions(qa))
        # 對同一場的簡報(已讀的)
        call = next((r for r in by_s.get(sy, []) if x['yq'] and reported_q(r['d']) == x['yq']), None) or \
            next((r for r in by_s.get(sy, []) if x['yq'] and prev_q(reported_q(r['d'])) == x['yq']), None)
        deck = next((f for f in ((call or {}).get('pdf') or []) if f in ok_files), None)
        dtext = '\n'.join(pages_of(cc_dir, deck, call['d']) or []) if deck else ''
        rec['vs_pres'] = only_in_qa(qa, pres, cd)
        rec['vs_both'] = only_in_qa(qa, pres + '\n' + dtext, cd) if dtext else None
        rec['deck'] = bool(dtext)
        rep['read'].append(rec)
        vb = rec['vs_both'] or rec['vs_pres']
        print(f"📄 {sy} {x['yq']}:{rec['pages']} 頁 {rec['chars']:,} 字 ・問答從 {at:.0%} 開始 {rec['qa_chars']:,} 字 ・提問 {rec['q_n']}"
              f" ・數字句 {vb['num_sent']} 句,只在問答 {vb['only_num_sent']}({vb['share']}){' ・含簡報比' if dtext else ''}", flush=True)
        if vb['eg']:
            print(f"   例:{vb['eg'][0][:140]}", flush=True)

    # ③ 大型公司的證交所影片 → Groq
    keys = _keys()
    gq = Groq(keys)
    top_asr = set(rank[:QA_ASR_TOP])
    cand = [r for r in rows if r['s'] in top_asr and r.get('vid') and kind_of(r['vid']) == 'ir_mp4'
            and any(f in ok_files for f in (r.get('pdf') or []))]
    cand.sort(key=lambda r: r['d'], reverse=True)
    seen_s, pick = set(), []
    for r in cand:                                   # 一家先一場,分散
        if r['s'] not in seen_s:
            seen_s.add(r['s'])
            pick.append(r)
    pick = pick[:QA_ASR_N]
    rep['asr_pool'] = len(cand)
    print(f'\n🎙️ 前 {QA_ASR_TOP} 名在證交所影音網站、簡報讀過的 {len(cand)} 場({len({r["s"] for r in cand})} 家)→ 轉 {len(pick)} 場', flush=True)
    for r in pick if keys else []:
        if time.time() > DEADLINE - 15 * 60:
            rep['notes'].append('時間到,辨識停')
            break
        rec = {'s': r['s'], 'name': r.get('name'), 'd': r['d']}
        h = head_mp4(r['vid'])
        if h.get('sec') and h['sec'] > QA_MAX_MIN * 60:
            rec['err'] = f"太長 {h['sec'] // 60} 分"
            rep['asr'].append(rec)
            continue
        with tempfile.TemporaryDirectory() as td:
            try:
                path, dl = download(r['vid'], 'ir_mp4', td)
                chunks = to_chunks(path, td)
                cues = []
                for j, c in enumerate(chunks):
                    for cu in gq.asr(c):
                        cues.append({'start': cu['start'] + j * SEG, 'end': cu['end'] + j * SEG, 'text': to_trad(cu['text'])})
            except Exception as e:
                rec['err'] = str(e)[:120]
                rep['asr'].append(rec)
                print(f"🎙️ {r['s']} {r['d']} ❌ {rec['err']}", flush=True)
                continue
        cues, drop = clean_cues(cues)
        total = cues[-1]['end'] if cues else 0
        rec.update(min=round(total / 60, 1), junk=drop)
        q = qa_split(cues, min_frac=0.25)
        deck = next(f for f in r['pdf'] if f in ok_files)
        dtext = '\n'.join(pages_of(cc_dir, deck, r['d']) or [])
        if q:
            qa_txt = '。'.join(c['text'] for c in cues if c['start'] >= q['at'])
            pre_txt = '。'.join(c['text'] for c in cues if c['start'] < q['at'])
            rec.update(qa_at=q['frac'], q_n=count_questions(qa_txt), qa_chars=len(re.sub(r'\s', '', qa_txt)),
                       vs_both=only_in_qa(qa_txt, pre_txt + '\n' + dtext, cd))
        rep['asr'].append(rec)
        vb = rec.get('vs_both') or {}
        print(f"🎙️ {r['s']} {r.get('name')} {r['d']}:{rec['min']} 分 ・幻覺丟 {drop} 段 ・問答 {q and q['frac']} ・提問 {rec.get('q_n')}"
              f" ・數字句 {vb.get('num_sent')} 只在問答 {vb.get('only_num_sent')}({vb.get('share')})", flush=True)
        (out / 'qa' / f"{r['s']}_{r['d']}.txt").write_text('\n'.join(f"[{int(c['start'] // 60):02d}:{int(c['start'] % 60):02d}] {c['text']}" for c in cues), encoding='utf-8')
        if q:
            tail = [c['text'] for c in cues if c['start'] >= q['at']][:12]
            print('   ── 問答開頭 ──\n   ' + '\n   '.join(tail), flush=True)
    rep['groq_audio_sec'] = round(gq.used_sec)

    # ④ 過關?
    rd = [x for x in rep['read'] if x.get('q_n') is not None]
    ar = [x for x in rep['asr'] if x.get('q_n') is not None]
    f3_off = sum(1 for x in rd if x['q_n'] >= 3) / len(rd) if rd else 0
    f3_asr = sum(1 for x in ar if x['q_n'] >= 3) / len(ar) if ar else 0
    est = round(calls_with * f3_off + rep['asr_pool'] * f3_asr)
    shares = [(x.get('vs_both') or x.get('vs_pres') or {}).get('share') for x in rd + ar]
    shares = [v for v in shares if v is not None]
    med = round(st.median(shares), 3) if shares else None
    rep['gate'] = qa_gate(est, med)
    rep['gate'].update(off_read=len(rd), off_3q=round(f3_off, 3), asr_read=len(ar), asr_3q=round(f3_asr, 3),
                       calls_off=calls_with, calls_asr_pool=rep['asr_pool'])
    (out / 'qa_report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    g = rep['gate']
    print(f"\n════ 過關門檻 ════\n官方逐字稿:對到 {calls_with} 場、讀 {len(rd)} 份裡 ≥3 個提問 {g['off_3q']:.0%}\n"
          f"證交所影片:大公司 {rep['asr_pool']} 場、轉 {len(ar)} 場裡 ≥3 個提問 {g['asr_3q']:.0%}\n"
          f"→ 估計 ≥3 個提問的場次 {est}(要 ≥{QA_GATE_CALLS})・問答數字句「只在問答」中位 {med}(要 ≥{QA_GATE_SHARE})\n"
          f"{'✅ PASS → 做第 2 步' if g['pass'] else '⛔ FAIL → 結論寫進實測總表收工'}", flush=True)
    if not ok_pages[0]:
        print('❌ 投資人網站一頁都抓不到(網路被擋?)→ 紅燈(報告照寫)', flush=True)
        return 1
    return 0


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

    chk('① kind_of:證交所 mp4 / YouTube / webpro / zucast / 其他',
        kind_of('http://irconference.twse.com.tw/1102_112_20260817_ch.mp4') == 'ir_mp4'
        and kind_of('http://irconference.twse.com.tw/5312_14_20240109_ch.MP4') == 'ir_mp4'
        and kind_of('https://youtu.be/abc') == 'youtube' and kind_of('https://webpro.twse.com.tw/WebPortal/vod/1') == 'twse_vod'
        and kind_of('https://www.zucast.com/webcast/x') == 'zucast' and kind_of('https://www.tpex.org.tw/zh-tw/live.html') == 'other')
    chk('② 國字數字:百分之五十八點一 / 九百五十六億 / 四點九零 / 兩千三百',
        cn_to_arabic('毛利率百分之五十八點一') == '毛利率58.1%' and cn_to_arabic('營收九百五十六億') == '營收956億'
        and cn_to_arabic('EPS四點九零元') == 'EPS4.90元' and cn_to_arabic('兩千三百張') == '2300張')
    chk('③ 單獨一個「一 / 十」不當數字(一定、十分)', cn_to_arabic('一定會十分好') == '一定會十分好')
    chk('④ 一萬兩千 / 三億五千萬', cn_to_arabic('一萬兩千') == '12000' and cn_to_arabic('三億五千萬') == '350000000')
    s = nums_in('2026年第三季營收956.0億、EPS 4.90元、毛利率百分之三十點九,第3頁')
    chk('⑤ nums_in:956 / 4.9 / 30.9 收、年份與 1~9 不收', s == {'956', '4.9', '30.9'})
    m = num_match('營收九百五十六億 毛利率三十點九 另外講 777', '營收 956.0 億 毛利率 30.9% 出貨 1,234')
    chk('⑥ num_match:逐字稿 3 個數字、簡報也有 2 個;簡報 3 個講到 2 個', m['t_n'] == 3 and m['both'] == 2 and m['d_n'] == 3 and m['only_t'] == ['777'])
    chk('⑦ term_match 不分大小寫', term_match('今年 abf 載板與 AI 伺服器', ['ABF', 'AI伺服器', 'CCL'])['hit'] == 1)
    cues = [{'start': 0, 'end': 600, 'text': '各位好 今天報告第三季'}, {'start': 1800, 'end': 1900, 'text': '接下來開放提問'},
            {'start': 1900, 'end': 3000, 'text': '請問毛利率 請問明年資本支出'}]
    q = qa_split(cues)
    chk('⑧ qa_split:在 1800 秒、之後 2 個「請問」', q and q['at'] == 1800 and q['asks'] == 2 and q['frac'] == 0.6)
    chk('⑨ 切不到問答 → None(⛔ 硬猜)', qa_split([{'start': 0, 'end': 10, 'text': '謝謝大家'}]) is None)
    chk('⑩ similarity:一樣 = 1、不同 < 0.5、空的 = None',
        similarity('今天營收成長', '今天營收成長') == 1.0 and similarity('甲乙丙丁戊', '子丑寅卯辰') < 0.5 and similarity('', 'x') is None)
    chk('⑪ thin_pages:封面不算、只收不到 40 字的頁', thin_pages(['封面', '短', 'x' * 50, ' 2 0 %']) == [2, 4])
    rows = [{'s': '1101', 'd': '2023-05-01', 'vid': 'http://irconference.twse.com.tw/a.mp4', 'pdf': ['A.pdf']},
            {'s': '1102', 'd': '2023-06-01', 'vid': 'http://irconference.twse.com.tw/b.mp4', 'pdf': ['B.pdf']},
            {'s': '1103', 'd': '2099-01-01', 'vid': 'http://irconference.twse.com.tw/c.mp4', 'pdf': ['C.pdf']},
            {'s': '1104', 'd': '2024-01-01', 'vid': 'https://youtu.be/x', 'pdf': ['D.pdf']}]
    sp = pick_samples(rows, {'A.pdf', 'D.pdf', 'C.pdf'}, random.Random(1), 5, 3)
    chk('⑫ 抽樣:簡報讀過的排前面、⛔ 未來場次', [r['s'] for r in sp['ir'].get('2023', [])] == ['1101', '1102'] and '2099' not in sp['ir']
        and [r['s'] for r in sp['other'].get('youtube', [])] == ['1104'])
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / 'cc' / 'text').mkdir(parents=True)
        (Path(td) / 'cc' / 'index.json').write_text(json.dumps({'files': {'X.pdf': {'st': 'ok', 'tx': '2026-10'}}}), encoding='utf-8')
        (Path(td) / 'cc' / 'text' / '2026-10.json.gz').write_bytes(gzip.compress(json.dumps({'X.pdf': {'p': ['一', '二']}}).encode()))
        chk('⑬ pages_of 照 index 的 tx 月份找全文', pages_of(td, 'X.pdf', '2026-09-30') == ['一', '二'])
    # ⑭ 下載斷線 → Range 續傳(第一輪實測 480 MB 那場斷在 1 MB);主機不理 Range → 整份重來
    import types
    FULL = bytes(range(256)) * 40
    class _R:
        def __init__(self, body, code, cl, cut=None):
            self.body, self.status_code, self.cut = body, code, cut
            self.headers = {'Content-Length': str(cl)}
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def raise_for_status(self):
            pass
        def iter_content(self, n):
            for k in range(0, len(self.body), 1000):
                if self.cut is not None and k >= self.cut:
                    raise ConnectionError('IncompleteRead')
                yield self.body[k:k + 1000]
    def _fake(mode):
        calls = []
        def get(url, timeout=None, stream=None, headers=None):
            rg = (headers or {}).get('Range')
            calls.append(rg)
            if not rg:
                return _R(FULL, 200, len(FULL), cut=3000)
            st = int(rg.split('=')[1].rstrip('-'))
            if mode == 'ignore':
                return _R(FULL, 200, len(FULL), cut=None if len(calls) > 2 else 3000)
            return _R(FULL[st:], 206, len(FULL) - st)
        return types.SimpleNamespace(get=get), calls
    old = sys.modules.get('requests')
    try:
        for mode in ('range', 'ignore'):
            fk, calls = _fake(mode)
            sys.modules['requests'] = fk
            _sl, time.sleep = time.sleep, (lambda *_: None)
            try:
                with tempfile.TemporaryDirectory() as td:
                    pth, _ = download('http://x/a.mp4', 'ir_mp4', td)
                    okb = pth.read_bytes() == FULL
            finally:
                time.sleep = _sl
            chk(f'⑭ 下載斷線續傳({mode}):檔案完整、{"第二次帶 Range 從斷點接" if mode == "range" else "主機不理 Range → 整份重來"}',
                okb and len(calls) >= 2 and calls[1] == 'bytes=3000-')
    finally:
        if old is not None:
            sys.modules['requests'] = old
        else:
            sys.modules.pop('requests', None)
    # ── 🏢 qa 模式 ──
    chk('⑮ yq_of:2Q25 / Q2 2025 / 2025Q2 / 2025/q2 / 2025年第二季 / 114年第2季 / 抓不到 None',
        yq_of('TSMC 2Q25 Transcript.pdf') == (2025, 2) and yq_of('Q2 2025 Earnings Call') == (2025, 2)
        and yq_of('UMC_2025Q2_transcript.pdf') == (2025, 2) and yq_of('/quarterly-results/2025/q2') == (2025, 2)
        and yq_of('2025年第二季法說會逐字稿') == (2025, 2) and yq_of('114年第2季') == (2025, 2)
        and yq_of('TSMC%203Q20%20transcript_0.pdf') == (2020, 3) and yq_of('annual report') is None)
    chk('⑯ reported_q:1~3 月開的報上一年第 4 季;7 月報第 2 季;prev_q 跨年',
        reported_q('2026-01-15') == (2025, 4) and reported_q('2025-07-17') == (2025, 2) and reported_q('2025-10-16') == (2025, 3)
        and prev_q((2026, 1)) == (2025, 4))
    html_fx = ('<a href="/english/encrypt/files/x/TSMC%202Q25%20Transcript.pdf">Transcript</a>'
               '<a href="/english/encrypt/files/x/TSMC%202Q25%20Presentation.pdf">Presentation</a>'
               '<a href="https://ir.x.com/c/events.php">法人說明會</a><a href="https://other.com/q">earnings</a>'
               '<script>var f="https://ir.x.com/files/2025Q1_逐字稿.pdf";</script>')
    L = links_of(html_fx, 'https://ir.x.com/c/index.php')
    tr = [u for u, t in L if is_transcript(u, t)]
    nv = [u for u, t in L if is_nav(u, t, 'ir.x.com')]
    chk('⑰ 找逐字稿連結:Transcript 收、Presentation ⛔ 收、JS 裡的 .pdf 也收;法說會頁(同主機)當下一層、別的主機 ⛔ 跟',
        len(tr) == 2 and all('Presentation' not in u for u in tr) and any('逐字稿' in u for u in tr)
        and nv == ['https://ir.x.com/c/events.php'])
    tx = ('Contents ... Questions and Answers ... page 9\n' + 'Prepared remarks. Revenue was US$30.1 billion. ' * 20 +
          '\nQUESTIONS AND ANSWERS\nOperator\nThe first question is from Gokul Hariharan.\n'
          'Gokul Hariharan, J.P. Morgan - Analyst\nWhat about 2026 capex? Will gross margin reach 59.5%?\n'
          'Jen-Chau Huang - CFO\nWe expect capex of US$42.5 billion.\nOperator\nThe next question is from Charlie Chan.\n'
          'Charlie Chan, Morgan Stanley - Analyst\nOn N2 ramp?\n')
    sp = split_qa_text(tx)
    chk('⑱ split_qa_text:目錄裡先出現的「Questions and Answers」⛔ 當開始(挑 15% 之後那個);切不到 → None',
        sp is not None and sp[1].startswith('QUESTIONS AND ANSWERS') and sp[2] > 0.5 and split_qa_text('only prepared remarks') is None)
    chk('⑲ count_questions:分析師那一行 / 下一個問題 / 「Q」那一行 / 中文「請問」取最大',
        count_questions(sp[1]) == 2 and count_questions('Q:\nA:\nQ:\nA:\nQ:\n') == 3 and count_questions('請問毛利 想請教資本支出') == 2)
    o1 = only_in_qa(sp[1], sp[0])
    o0 = only_in_qa(sp[0], sp[0])
    chk('⑳ only_in_qa:問答講到簡報沒有的數字(59.5% / 42.5)→ 算「只在問答」;⭐ 決定性對照:拿前半段自己比 → 0',
        o1['num_sent'] >= 1 and o1['only_num_sent'] >= 1 and o0['num_sent'] >= 1 and o0['only_num_sent'] == 0 and o0['share'] == 0)
    cc, dr = clean_cues([{'text': '请不吝点赞 订阅 转发 打赏支持明镜与点点栏目'}, {'text': '字幕志愿者 李宗盛'}, {'text': '各位好'},
                         {'text': '各位好'}, {'text': '今天報告營收'}])
    chk('㉑ clean_cues:幻覺固定句丟掉、連續一樣的只留一句', [c['text'] for c in cc] == ['各位好', '今天報告營收'] and dr == 3)
    _CC.clear()
    t1 = to_trad('请问毛利率 软件')
    _CC.clear()
    _CC.append(None)
    t0 = to_trad('请问毛利率')
    _CC.clear()
    try:
        import opencc  # noqa: F401
        has_cc = True
    except Exception:
        has_cc = False
    chk('㉒ to_trad:裝了 OpenCC 就轉臺灣用字(请问 → 請問、软件 → 軟體);沒裝原樣回傳', t0 == '请问毛利率' and (t1 == '請問毛利率 軟體' if has_cc else t1 == '请问毛利率 软件'))
    cues2 = [{'start': 21, 'end': 25, 'text': '簡報後再進行 Q&A'}, {'start': 600, 'end': 610, 'text': '今天營收'},
             {'start': 1500, 'end': 1510, 'text': '接下來是 QA 時間'}, {'start': 1510, 'end': 2000, 'text': '請問毛利率'}]
    q2 = qa_split(cues2, min_frac=0.25)
    chk('㉓ qa_split(min_frac):開場先講「之後有 Q&A」⛔ 當開始 → 挑後面那個;不給 min_frac 照舊挑第一個',
        q2['at'] == 1500 and qa_split(cues2)['at'] == 21)
    chk('㉔ qa_gate:兩個條件都要過', qa_gate(200, 0.4)['pass'] and not qa_gate(100, 0.4)['pass'] and not qa_gate(200, 0.2)['pass']
        and not qa_gate(200, None)['pass'])
    print(f'\n{"✅ 全部通過" if not fail else f"❌ {fail} 條失敗"}({ok} 條)')
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else (main_qa() if (os.getenv('AV_MODE') or '') == 'qa' else main()))
