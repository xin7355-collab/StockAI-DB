#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔎 insider_src_probe.py —— 公開資訊觀測站「內部人持股轉讓事前申報」「董監持股 / 質押」有沒有歷史可以回補(V80.1.7 探路)

使用者(2026-11-01):「早知道先機,贏多一點少輸一點」→ 計畫 B4:大股東賣股前要先申報轉讓、董監質押跌深會被追繳。
本站 `insider_miner.py` 只存「今天」的董監持股 / 質押快照(每天覆蓋),申報轉讓**完全沒有**
(`docs/EXTERNAL_REVIEWS.md` 以前寫它有,程式沒有)。要先知道公開資訊觀測站能不能一次回補。

⛔ 這不是採礦:只印不寫、⛔ 不碰任何分支、⛔ 不需要金鑰。
⛔ 沙箱連不到 MOPS → 只能在 Actions 跑(`macro_probe.yml` which=mops_insider)。
⛔ 陷阱 #23:MOPS 對不存在的頁回 HTTP 200 + 一頁網頁 → 判定一律走 `mops_probe.verdict`(看資料列,⛔ 只看 status)。

做法(⛔ 猜網址 —— 讓官方頁面自己說):
  ① 抓首頁 + 首頁引用的 js,把所有 /mops/web/<代碼> 與 ajax_<代碼> 撈出來,只留「附近文字有關鍵字」的
     (轉讓 / 申報 / 設質 / 質權 / 質押 / 持股 / 內部人 / 董監);再加上以前 insider_probe 試過的兩個(t16sn02 / stapap1)
  ② 每個候選頁抓整頁 → 印標題 + 官方表單欄位(`mops_probe.form_fields`)
  ③ 表單有 co_id / year / month 的 → 依它的欄位名組幾個查詢(2330、今年、10 年前)POST ajax_<代碼>
     → `mops_probe.verdict` 印「有資料 N 列 / 參數不對(MOPS 自己的提示)/ 一頁網頁」+ 前 3 列原文

--selftest:連結 / 代碼抽取、關鍵字挑選、表單欄位 → 查詢組合(不用網路)。
"""
import os
import re
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mops_probe as mp          # noqa: E402  ⭐ 被擋偵測 / 解析 / 判定只有一份(⛔ 不抄)

HOST = os.getenv('MOPS_HOST') or 'https://mopsov.twse.com.tw'
SAMPLE = (os.getenv('MOPS_SAMPLE') or '2330').strip()
SLEEP = float(os.getenv('MOPS_SLEEP') or '1.5')
MAX_REQ = int(os.getenv('MAX_REQ') or '70')
KEYS = ('轉讓', '申報', '設質', '質權', '質押', '持股', '內部人', '董監', '董事', '大股東')
KNOWN = ('t16sn02', 'stapap1')        # insider_probe.py 以前試過(結果沒有留在本站紀錄裡 → 這次重新看)
_N = {'req': 0}


# ───────────────────────── 純函式(--selftest) ─────────────────────────
CODE_RE = r"(t\d{2,3}[a-z]{1,3}\d{1,3}(?:_q\d|_\d)?|[a-z]{3,8}ap\d|query\d_\d)"


def codes_near_keys(text, keys=KEYS, span=30):
    """回 [(代碼, 附近文字)]。⛔ 不猜:代碼全部來自頁面本身。
    ① <a href=".../mops/web/<代碼>">文字</a> → 只看**連結文字**(⛔ 用前後幾十字:隔壁連結的字會混進來)
    ② 其他(js 裡的 ajax_<代碼>、引號裡的代碼)→ 前後 span 字內有關鍵字才收"""
    text = text or ''
    out, seen, taken = [], set(), []
    for m in re.finditer(r'<a\b[^>]*href\s*=\s*["\'][^"\']*?/mops/web/(?:ajax_)?' + CODE_RE + r'["\'][^>]*>(.*?)</a>', text, flags=re.S | re.I):
        code, label = m.group(1), mp.strip_tags(m.group(2))
        taken.append((m.start(), m.end()))
        if code not in seen and any(k in label for k in keys):
            seen.add(code)
            out.append((code, label[:140]))
    for m in re.finditer(r"(?:/mops/web/(?:ajax_)?|ajax_|['\"])" + CODE_RE + r"\b", text):
        if any(a <= m.start() < b for a, b in taken):
            continue
        code = m.group(1)
        if code in seen:
            continue
        ctx = mp.strip_tags(text[max(0, m.start() - span):m.end() + span])
        if any(k in ctx for k in keys):
            seen.add(code)
            out.append((code, ctx[:140]))
    return out


def script_srcs(html, host=HOST):
    """首頁引用的 js(只收同一台主機的)。"""
    out = []
    for s in re.findall(r'<script[^>]+src\s*=\s*["\']([^"\']+)', html or '', flags=re.I):
        if s.startswith('//'):
            s = 'https:' + s
        elif s.startswith('/'):
            s = host + s
        elif not s.startswith('http'):
            s = host + '/mops/web/' + s
        if s.startswith(host) and s not in out:
            out.append(s)
    return out


def build_queries(fields, sample, today):
    """官方表單欄位 → 幾組查詢(⛔ 欄位名一律用表單裡真的有的;沒有 co_id / year 就不組)。
    回 [(標籤, form)]。民國年;月份 1 與 01 兩種都送(下拉選單的值不知道是哪種,由回應說了算)。"""
    names = {n for _, n, _ in fields}
    base = {n: v for _, n, v in fields if n in ('encodeURIComponent', 'firstin', 'step', 'off', 'TYPEK', 'funcName', 'queryName', 'inpuType')}
    base.setdefault('encodeURIComponent', '1')
    base.setdefault('firstin', '1')
    base.setdefault('step', '1')
    if 'co_id' not in names and 'year' not in names:
        return []
    out = []
    for y, tag in ((today.year, '今年'), (today.year - 10, '10 年前')):
        for pad in (False, True):
            f = dict(base)
            if 'co_id' in names:
                f['co_id'] = sample
            if 'TYPEK' in names:
                f['TYPEK'] = 'sii'
            if 'year' in names:
                f['year'] = str(y - 1911)
            if 'month' in names:
                f['month'] = '06' if pad else '6'
            if 'b_date' in names:
                f['b_date'] = '01' if pad else '1'
            if 'e_date' in names:
                f['e_date'] = '30'
            out.append((f'{sample} {tag} {"01" if pad else "1"} 格式', f))
    return out


# ───────────────────────── 網路 ─────────────────────────
def get(session, url, form=None):
    if _N['req'] >= MAX_REQ:
        return None
    _N['req'] += 1
    time.sleep(SLEEP)
    try:
        hdr = {**mp.UA, 'Referer': f'{HOST}/mops/web/index'}
        r = session.post(url, data=form, headers=hdr, timeout=30) if form is not None else session.get(url, headers=hdr, timeout=30)
        r.encoding = r.encoding or 'utf-8'
        return r
    except Exception as e:
        print(f'   ❌ {url} 連線失敗 {type(e).__name__}: {str(e)[:100]}', flush=True)
        return None


def title_of(html):
    m = re.search(r'<title[^>]*>(.*?)</title>', html or '', flags=re.S | re.I)
    return mp.strip_tags(m.group(1))[:60] if m else ''


def main():
    import requests
    s = requests.Session()
    today = date.today()
    print(f'🔎 MOPS 內部人 / 質押 探路 ・主機 {HOST} ・樣本 {SAMPLE} ・最多 {MAX_REQ} 次請求', flush=True)
    found = {}
    r = get(s, f'{HOST}/mops/web/index')
    if r is None:
        print('❌ 首頁連不上 → 這台主機今天不能用(結論:沒驗到,⛔ 不是「沒有歷史」)')
        return 1
    html = r.text or ''
    print(f'① 首頁 HTTP {r.status_code} ・{len(html)} 字 ・被擋={mp.is_blocked(html)} ・標題「{title_of(html)}」', flush=True)
    for c, ctx in codes_near_keys(html):
        found.setdefault(c, ctx)
    for js in script_srcs(html)[:8]:
        rj = get(s, js)
        if rj is None:
            continue
        hits = codes_near_keys(rj.text or '')
        print(f'   js {js.rsplit("/", 1)[-1][:40]} HTTP {rj.status_code} ・{len(rj.text or "")} 字 ・關鍵字附近的代碼 {len(hits)} 個', flush=True)
        for c, ctx in hits:
            found.setdefault(c, ctx)
    for c in KNOWN:
        found.setdefault(c, '(以前 insider_probe 試過)')
    print(f'② 候選 {len(found)} 個:', flush=True)
    for c, ctx in found.items():
        print(f'   · {c}:{ctx}', flush=True)
    ok_pages = []
    for c in list(found)[:20]:
        rp = get(s, f'{HOST}/mops/web/{c}')
        if rp is None:
            continue
        t = rp.text or ''
        info = mp.form_fields(t)
        print(f'③ 頁 {c}:HTTP {rp.status_code} ・{len(t)} 字 ・被擋={mp.is_blocked(t)} ・標題「{title_of(t)}」 ・判定 {mp.verdict(rp.status_code, rp.headers.get("Content-Type", ""), t)}', flush=True)
        print(f'   表單欄位 {info["fields"][:30]}', flush=True)
        print(f'   form action {info["actions"]} ・ajax 上下文 {[a[:200] for a in info["ajax"][:3]]}', flush=True)
        qs = build_queries(info['fields'], SAMPLE, today)
        if qs:
            ok_pages.append(c)
        for tag, form in qs[:4]:
            rq = get(s, f'{HOST}/mops/web/ajax_{c}', form)
            if rq is None:
                continue
            tq = rq.text or ''
            rows = mp.table_rows(tq)
            print(f'   ↳ ajax_{c} {tag}:HTTP {rq.status_code} ・{mp.verdict(rq.status_code, rq.headers.get("Content-Type", ""), tq)}', flush=True)
            for row in rows[:3]:
                print(f'      {row[:10]}', flush=True)
            if not rows:
                print(f'      開頭:{mp.strip_tags(tq[:600])[:220]}', flush=True)
    print(f'📋 結論:候選 {len(found)} 個、有表單可查的 {ok_pages} ・共 {_N["req"]} 次請求', flush=True)
    print('   ⚠️ 判定看「✅ 有資料 N 列」那幾行;全部是「參數不對 / 一頁網頁」= 這一輪沒找到,⛔ 不等於 MOPS 沒有', flush=True)
    return 0


def selftest():
    bad = []

    def ok(n, c, e=''):
        print(('✅ ' if c else '❌ ') + n + ('' if c else '  ' + str(e)[:200]))
        if not c:
            bad.append(n)
    page = ('<a href="/mops/web/t56sb12_q1">董監事持股轉讓事前申報</a> <a href="/mops/web/t05st01">重大訊息</a>'
            '<script>go("ajax_stapap1")/*董事、監察人持股餘額*/;x("t99zz99")</script>')
    got = dict(codes_near_keys(page))
    ok('① 關鍵字附近的代碼才收(轉讓那個收、重大訊息那個不收)', 't56sb12_q1' in got and 't05st01' not in got, got)
    ok('① ajax_ 名字也收、跟關鍵字距離夠近', 'stapap1' in got, got)
    ok('② js 只收同一台主機', script_srcs('<script src="/mops/web/js/a.js"></script><script src="https://evil.example/b.js"></script>')
       == [f'{HOST}/mops/web/js/a.js'])
    q = build_queries([('input', 'co_id', ''), ('select', 'year', ''), ('select', 'month', ''), ('input', 'TYPEK', 'sii')], '2330', date(2026, 11, 1))
    ok('③ 有 co_id / year → 組 4 組(今年 / 10 年前 × 1 / 01 格式),民國年', len(q) == 4 and q[0][1]['year'] == '115' and q[2][1]['year'] == '105'
       and q[1][1]['month'] == '06' and q[0][1]['co_id'] == '2330', q)
    ok('③ 決定性對照:表單沒有 co_id / year → 不組(⛔ 憑空加欄位)', build_queries([('input', 'keyword', '')], '2330', date(2026, 11, 1)) == [])
    print(('\n❌ selftest 失敗 ' + str(bad)) if bad else '\n✅ selftest 全過')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
