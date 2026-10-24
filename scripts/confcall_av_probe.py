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


QA_RE = re.compile(r'Q\s*&\s*A|問答|提問|開放.{0,6}(發問|問題|提問)|有沒有.{0,8}問題|第一個問題|第一位')
ASK_RE = re.compile(r'請問|想請教|想問一下|問題是')


def qa_split(cues):
    """問答段從哪裡開始:第一個「問答 / 提問 / 開放發問」出現的時間;之後「請問」幾次(= 大約幾個問題)。
    cues = [{'start','end','text'}];切不到回 None(⛔ 硬猜)。"""
    for i, c in enumerate(cues or []):
        if QA_RE.search(c.get('text') or ''):
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
            {'type': 'text', 'text': ('逐字抄出這張投影片上看得到的所有文字與數字(含圖表上的標籤、座標軸、數值、圖例);'
                                      '表格轉成 Markdown 表格;看不清楚的寫 [?]。⛔ 不要解釋、不要摘要、不要補圖上沒有的內容。')},
            {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{b64}'}}]}]}
        j = self._post(GROQ_CHAT_URL, json_body=body, timeout=120)
        return ((j.get('choices') or [{}])[0].get('message') or {}).get('content') or ''


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
    if keys and OCR_N > 0 and time.time() < DEADLINE - 10 * 60:
        ids = gq.models()
        model = next((m for m in VISION_PREF if m in ids), None) or next((m for m in ids if VISION_RE.search(m)), None)
        rep['vision_model'] = model
        rep['vision_candidates'] = [m for m in ids if VISION_RE.search(m)][:10]
        print(f'⑤ 視覺模型:{model}(清單上像視覺的:{rep["vision_candidates"]})', flush=True)
        if model and shutil.which('pdftoppm'):
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
                            txt = gq.vision(model, png)
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
    any_ok = any(v['ok'] for v in rep['avail_ir'].values())
    if not any_ok:
        print('❌ 證交所 mp4 一場都拿不到 → 紅燈(報告照寫)', flush=True)
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
    print(f'\n{"✅ 全部通過" if not fail else f"❌ {fail} 條失敗"}({ok} 條)')
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
