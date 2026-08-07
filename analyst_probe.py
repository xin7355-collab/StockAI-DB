#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🧪 分析師內容來源探針(analyst_probe)—— 只讀不寫,一次把所有路都試完

⚠️⚠️ 為什麼要有這支(2026-08-07 的教訓,寫下來免得再犯):
   使用者看完成品說「我覺得你這樣做都沒有用」—— 他是對的。
   我為了「分析師焦點」改了 **8 個版本**,每一版都是「改採礦機 → 等 workflow → 看輸出 → 再改」,
   每輪 10 分鐘,而且每次只驗證**一個**假設。
   ⛔ 這違反了 CLAUDE.md 自己的兩條鐵則:
     ① **探針先行**(ORB / sector_flow / tdcc 那幾次都是先寫探針才動手)
     ② **解釋 ≠ 修好** —— 前幾版一直在補說明文字與診斷,但畫面上那格始終是空的。

⭐ 這支的任務:**一次跑完所有候選路徑,印出一張可以直接做決策的表**。
   跑完就知道「哪條真的拿得到內容」,不用再一輪一輪猜。

⛔ 只讀:不寫 data/、不改任何檔案、不部署。跑法:Actions → 手動 Run。

測的東西:
  A. YouTube 逐字稿 —— 三條路(watch 頁 / youtubei player API / timedtext 直取)
  B. Podcast RSS shownotes —— 長度與內容(⚠️ 從來沒真正試過,YouTube 先成功就 return 了)
  C. Google News 跳轉頁 → 真實出處 → 正文
  D. 兆華兩位的頻道 —— handle 候選 + 搜尋 + 第三方鏡像
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

TPE = timezone(timedelta(hours=8))
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      'Accept-Language': 'zh-TW,zh;q=0.9'}
UA_CONSENT = dict(UA, Cookie='CONSENT=YES+cb.20260101-00-p0.zh-TW+FX+000')
T = int(os.getenv('PROBE_TIMEOUT', '25'))
R = []          # 結果表


def rec(group, name, ok, detail):
    R.append((group, name, ok, detail))
    print(f'  {"✅" if ok else "❌"} [{group}] {name}: {detail[:160]}')


def get(url, headers=None, **kw):
    return requests.get(url, headers=headers or UA, timeout=T, **kw)


def strip_html(x):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', x or '')).strip()


# ══ A. YouTube 逐字稿:三條路 ═══════════════════════════════════════════════
def yt_latest_vid(cid):
    try:
        x = get(f'https://www.youtube.com/feeds/videos.xml?channel_id={cid}').text
        m = re.search(r'<yt:videoId>([\w-]{11})</yt:videoId>', x)
        return m.group(1) if m else ''
    except Exception:
        return ''


def a1_watch(vid, hdr, label):
    """路 1:watch 頁 HTML → captionTracks"""
    try:
        r = get(f'https://www.youtube.com/watch?v={vid}&bpctr=9999999999&has_verified=1&hl=zh-TW', hdr)
        h = r.text
    except Exception as e:
        rec('A-逐字稿', f'watch頁({label})', False, f'{type(e).__name__} {e}')
        return ''
    if r.status_code != 200:
        rec('A-逐字稿', f'watch頁({label})', False, f'HTTP {r.status_code}')
        return ''
    m = re.search(r'"captionTracks":(\[.*?\])', h)
    if not m:
        why = ('同意頁' if re.search(r'consent\.youtube|CONSENT', h) else
               '有播放器但沒字幕軌' if 'ytInitialPlayerResponse' in h else '不是播放頁')
        rec('A-逐字稿', f'watch頁({label})', False, f'{len(h)//1024}KB 沒有 captionTracks({why})')
        return ''
    rec('A-逐字稿', f'watch頁({label})', True, f'找到 captionTracks({len(h)//1024}KB)')
    return m.group(1)


def a2_player_api(vid):
    """路 2:youtubei/v1/player(yt-dlp 用的內部 API,免金鑰、不吃同意頁)"""
    body = {
        'context': {'client': {'clientName': 'ANDROID', 'clientVersion': '19.09.37',
                               'androidSdkVersion': 30, 'hl': 'zh-TW', 'gl': 'TW'}},
        'videoId': vid,
    }
    try:
        r = requests.post('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
                          json=body, headers=dict(UA, **{'Content-Type': 'application/json'}), timeout=T)
        if r.status_code != 200:
            rec('A-逐字稿', 'player API', False, f'HTTP {r.status_code} {r.text[:80]}')
            return ''
        j = r.json()
    except Exception as e:
        rec('A-逐字稿', 'player API', False, f'{type(e).__name__} {e}')
        return ''
    tr = (((j.get('captions') or {}).get('playerCaptionsTracklistRenderer') or {}).get('captionTracks') or [])
    if not tr:
        st = ((j.get('playabilityStatus') or {}).get('status'), (j.get('playabilityStatus') or {}).get('reason'))
        rec('A-逐字稿', 'player API', False, f'回應正常但沒有字幕軌(playability={st})')
        return ''
    rec('A-逐字稿', 'player API', True, f'{len(tr)} 條字幕軌:{[t.get("languageCode") for t in tr]}')
    return json.dumps(tr)


def a3_fetch_track(tracks_json, label):
    """拿到字幕軌 → 真的把逐字稿抓下來"""
    try:
        tr = json.loads(tracks_json.replace('\\u0026', '&'))
    except Exception as e:
        rec('A-逐字稿', f'取字幕({label})', False, f'解析軌道失敗 {e}')
        return
    pick = next((t for t in tr if str(t.get('languageCode', '')).startswith('zh')), tr[0])
    url = (pick.get('baseUrl') or '').replace('\\u0026', '&')
    try:
        x = get(url).text
    except Exception as e:
        rec('A-逐字稿', f'取字幕({label})', False, f'{type(e).__name__} {e}')
        return
    txt = ' '.join(strip_html(t) for t in re.findall(r'(?is)<text[^>]*>(.*?)</text>', x))
    if len(txt) < 50:
        rec('A-逐字稿', f'取字幕({label})', False, f'只有 {len(txt)} 字(XML {len(x)} bytes)')
        return
    rec('A-逐字稿', f'取字幕({label})', True, f'{len(txt)} 字 ・開頭:{txt[:70]}')


# ══ B. Podcast shownotes(⚠️ 從來沒真正試過)═══════════════════════════════
def probe_podcast(url):
    try:
        x = get(url).text
    except Exception as e:
        rec('B-Podcast', 'RSS', False, f'{type(e).__name__} {e}')
        return
    items = re.findall(r'(?is)<item>(.*?)</item>', x)
    if not items:
        rec('B-Podcast', 'RSS', False, f'{len(x)//1024}KB 但沒有 <item>')
        return
    lens = []
    for it in items[:3]:
        t = strip_html(re.search(r'(?is)<title>(.*?)</title>', it).group(1)) if re.search(r'(?is)<title>', it) else ''
        d = ''
        for tag in ('content:encoded', 'description', 'itunes:summary'):
            m = re.search(rf'(?is)<{tag}[^>]*>(.*?)</{tag}>', it)
            if m and len(strip_html(m.group(1))) > len(d):
                d = strip_html(m.group(1))
        lens.append(len(d))
        print(f'      ・{t[:28]} → shownotes {len(d)} 字:{d[:110]}')
    ok = max(lens) >= 100
    rec('B-Podcast', 'shownotes 長度', ok, f'最近 3 集 {lens} 字(≥100 才算有內容)')


# ══ C. Google News 跳轉頁 → 真實出處 → 正文 ═══════════════════════════════
def probe_gnews(kw):
    try:
        x = get('https://news.google.com/rss/search?q=' + requests.utils.quote(kw)
                + '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant').text
    except Exception as e:
        rec('C-新聞', 'RSS', False, f'{type(e).__name__} {e}')
        return
    links = re.findall(r'(?is)<item>.*?<link>(.*?)</link>.*?</item>', x)
    if not links:
        rec('C-新聞', 'RSS', False, '沒有 item')
        return
    rec('C-新聞', 'RSS', True, f'{len(links)} 則')
    u = links[0].strip()
    try:
        r = get(u, allow_redirects=True)
        h, final = r.text, r.url
    except Exception as e:
        rec('C-新聞', '跳轉', False, f'{type(e).__name__} {e}')
        return
    rec('C-新聞', '跳轉', 'news.google.com' not in final, f'最終網址:{final[:90]}')
    ps = [t for t in (strip_html(p) for p in re.findall(r'(?is)<p[^>]*>(.*?)</p>', h)) if len(t) >= 20]
    body = ' '.join(ps)
    if not body and 'news.google.com' in final:
        m = re.search(r'<a[^>]+href="(https?://(?!news\.google\.com)[^"]+)"', h)
        if m:
            try:
                h2 = get(m.group(1)).text
                ps = [t for t in (strip_html(p) for p in re.findall(r'(?is)<p[^>]*>(.*?)</p>', h2)) if len(t) >= 20]
                body = ' '.join(ps)
                rec('C-新聞', '撈出處再抓', bool(body), f'{m.group(1)[:70]} → {len(body)} 字')
            except Exception as e:
                rec('C-新聞', '撈出處再抓', False, f'{type(e).__name__} {e}')
    rec('C-新聞', '正文', len(body) >= 200, f'{len(body)} 字 ・開頭:{body[:110]}')


# ══ D. 兆華兩位的頻道 ══════════════════════════════════════════════════════
def probe_channel(name, handles, must):
    for h in handles:
        try:
            r = get('https://www.youtube.com/' + requests.utils.quote(h), UA_CONSENT)
        except Exception as e:
            rec('D-頻道', f'{name} {h}', False, f'{type(e).__name__} {e}')
            continue
        if r.status_code != 200:
            rec('D-頻道', f'{name} {h}', False, f'HTTP {r.status_code}')
            continue
        m = re.search(r'"(?:channelId|externalId)":"(UC[\w-]{20,})"', r.text)
        if not m:
            rec('D-頻道', f'{name} {h}', False, f'200 但沒有 channelId({len(r.text)//1024}KB)')
            continue
        cid = m.group(1)
        try:
            x = get(f'https://www.youtube.com/feeds/videos.xml?channel_id={cid}').text
            titles = re.findall(r'<title>(.*?)</title>', x)[1:4]
            dates = re.findall(r'<published>(.{10})', x)
            newest = max(dates) if dates else '?'
            hit = must in x
            rec('D-頻道', f'{name} {h}', hit, f'{cid} 最新 {newest} ・{len(dates)} 部 ・含「{must}」={hit} ・{titles[:2]}')
        except Exception as e:
            rec('D-頻道', f'{name} {h}', False, f'feed {type(e).__name__} {e}')
        time.sleep(1)
    # 搜尋
    try:
        r = get('https://www.youtube.com/results?search_query=' + requests.utils.quote(name), UA_CONSENT)
        pairs = re.findall(r'"text":"([^"]{2,40})"[^{}]{0,400}?"browseId":"(UC[\w-]{20,})"', r.text)
        names = [n for n, _ in pairs][:6]
        hit = [(n, c) for n, c in pairs if must in n]
        rec('D-頻道', f'{name} 搜尋', bool(hit), f'{len(pairs)} 個候選 {names} → 命中 {hit[:1]}')
    except Exception as e:
        rec('D-頻道', f'{name} 搜尋', False, f'{type(e).__name__} {e}')


def main():
    print(f'🧪 分析師內容來源探針 ・{datetime.now(TPE):%Y-%m-%d %H:%M}\n')

    print('── A. YouTube 逐字稿(用股癌最新一集當測試對象)──')
    cid = 'UC23rnlQU_qE3cec9x709peA'      # 實測解到的股癌頻道
    vid = yt_latest_vid(cid)
    rec('A-逐字稿', '取得最新 videoId', bool(vid), vid or '拿不到')
    if vid:
        t1 = a1_watch(vid, UA, '無 cookie')
        t2 = a1_watch(vid, UA_CONSENT, '帶 consent cookie')
        t3 = a2_player_api(vid)
        for tj, lb in ((t1, 'watch'), (t2, 'watch+cookie'), (t3, 'playerAPI')):
            if tj:
                a3_fetch_track(tj, lb)
                break

    print('\n── B. Podcast shownotes(⚠️ 之前從沒真正試過)──')
    probe_podcast('https://feeds.soundon.fm/podcasts/954689a5-3096-43a4-a80b-7810b219cef3.xml')

    print('\n── C. Google News 跳轉頁 → 真實出處 → 正文 ──')
    probe_gnews('郭哲榮 分析師')

    print('\n── D. 兆華兩位的頻道 ──')
    probe_channel('兆華與股惑仔', ['@stockmasterTW', '@兆華與股惑仔', '@guhuozai', '@stockdiary'], '股惑仔')
    probe_channel('兆華艾綸說', ['@兆華艾綸說', '@ailunshuo', '@ailun', '@zhaohua'], '艾綸')

    print('\n' + '═' * 74)
    print('📋 結論表(這才是拿來做決策的東西)')
    print('═' * 74)
    for g in ('A-逐字稿', 'B-Podcast', 'C-新聞', 'D-頻道'):
        rows = [x for x in R if x[0] == g]
        good = [x for x in rows if x[2]]
        print(f'{g}:{len(good)}/{len(rows)} 通')
        for x in rows:
            print(f'   {"✅" if x[2] else "❌"} {x[1]:22} {x[3][:110]}')
    print('═' * 74)
    print('⛔ 這支只讀不寫。拿到結果後才決定「分析師焦點」要救哪一條、還是整頁下架。')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
    sys.exit(0)   # 探針永遠 exit 0(它是拿情報的,不是守門的)
