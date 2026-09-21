#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🧨 mops_probe.py —— 公開資訊觀測站「重大訊息」可行性探針(V77.4.3)

⛔ **這不是採礦** —— 只印不寫、⛔ 不碰任何分支、⛔ 不碰 `data/` 既有檔(只落一份 artifact 用的結果檔)。
   照 `orb_probe.yml` 的前例:先確認可行性 → 可行再正式建 miner。

🚨 為什麼一定要先探針(⛔ 不可直接寫採礦上線):
   ① **沙箱連不到 MOPS**(實測 `mops.` / `mopsov.` / `mopsfin.` / `openapi.twse` 全部 connect_rejected,
      是組織網路政策)→ 端點、參數、解析在本機**一個字都驗不了**。
   ② **陷阱 #23**:MOPS 對不存在的路徑會回 **HTTP 200 + 一頁網頁**(不是 404)
      → ⛔ 只看 status 會把「名字猜錯」讀成「抓到了」。V76.4.0 上櫃產業別就是這樣連錯 6 輪,
      `confcall_miner` 也因為打錯資料集空轉三個月。所以這裡**一律印 content-type + body 開頭**。
   ③ ⚠️ `confcall_miner.py` 已經踩過一次:`mops.twse.com.tw` 對 runner 回「因為安全性考量…」,
      ⛔ **只有 `mopsov.twse.com.tw` 通** → 這支照抄它的 host / UA / Referer / 退避節奏。

📋 要回答的五件事(每一件都印進 log,並寫進 artifact `data/mops_probe_result.json`):
   1. 端點到底是哪一個(候選逐一試;⛔ 猜不到就誠實說猜不到,⛔ 不硬掰第二輪)
   2. 一天幾筆、欄位長什麼樣(印 2~3 筆原文)
   3. ⭐⭐ **有沒有歷史 / 能回補多久** —— 這是決定「要不要開始存」的關鍵:
      能回補 → 現在就測得動;只有當天 → 要再等約三個月(同 `news_hist.json` 的教訓)
   4. 抓一次多久、會不會被擋(GitHub IP)
   5. 需不需要金鑰(既有 MOPS 抓法是**零 GitHub Secrets**,確認重大訊息也是)

🧪 `--selftest`:純函式(被擋偵測 / 表格解析 / 表格 vs 網頁的分辨)不用網路也驗得到,
   含**決定性對照**(一頁「查無資料」的網頁⛔ 不可被當成抓到了)。
"""
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HOST = os.getenv('MOPS_HOST') or 'https://mopsov.twse.com.tw'
OUT = Path(os.getenv('DATA_DIR') or 'data') / 'mops_probe_result.json'
BACK_DAYS = int(os.getenv('MOPS_BACK_DAYS') or '3')        # 往回試幾天(答第 3 件事:有沒有歷史)
DEEP_DAYS = int(os.getenv('MOPS_DEEP_DAYS') or '400')      # 再往回試這麼多天,看能回補多深
SAMPLE = os.getenv('MOPS_SAMPLE') or '2330'
TW = timezone(timedelta(hours=8))
UA = {'User-Agent': 'Mozilla/5.0 mops_probe/1.0',
      'Accept': 'text/html, */*', 'Content-Type': 'application/x-www-form-urlencoded'}


# ───────────────────────── 純函式(--selftest 直接打這幾支) ─────────────────────────
def is_blocked(text):
    """MOPS 擋機器人時回的是一頁中文網頁(HTTP 仍是 200)。照 confcall_miner 那組字串。"""
    t = text or ''
    return ('因為安全性考量' in t) or ('CAN NOT BE ACCESSED' in t)


def strip_tags(html):
    t = re.sub(r'<br\s*/?>', ' ', html or '', flags=re.I)
    t = re.sub(r'<[^>]+>', '', t)
    t = (t.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<')
          .replace('&gt;', '>').replace('&quot;', '"').replace('&#39;', "'"))
    t = re.sub(r'&#(\d+);', lambda m: chr(int(m.group(1))), t)
    return re.sub(r'\s+', ' ', t).strip()


def table_rows(html, min_td=4):
    """回 [[欄文字…]] —— ⛔ 只認「第一欄像股票代號」的資料列(表頭、版面用的表格都不算)。
    ⚠️ 這是**分辨「真的抓到資料」與「抓到一頁網頁」的關鍵**:MOPS 的錯誤頁也有一堆 <table>。"""
    out = []
    for tr in re.findall(r'<tr[^>]*>.*?</tr>', html or '', flags=re.S | re.I):
        tds = re.findall(r'<td[^>]*>(.*?)</td>', tr, flags=re.S | re.I)
        if len(tds) < min_td:
            continue
        cells = [strip_tags(x) for x in tds]
        if not any(re.match(r'^\d{4,6}[A-Z]?$', c) for c in cells[:2]):
            continue
        out.append(cells)
    return out


def verdict(status, ctype, text):
    """一個候選端點的判定 —— ⛔ 只看 status 不算數(陷阱 #23)。"""
    if status != 200:
        return f'HTTP {status}'
    if is_blocked(text):
        return '被主機擋(安全性考量)'
    n = len(table_rows(text))
    if n:
        return f'✅ 有資料({n} 列)'
    if 'json' in (ctype or '').lower():
        return '回 JSON 但沒有資料列(要改解析方式)'
    return '⚠️ HTTP 200 但**沒有任何資料列**(多半是名字猜錯 → 拿到一頁網頁)'


def roc(d):
    return str(d.year - 1911)


# ───────────────────────── 候選端點(⛔ 猜的,由 log 說了算) ─────────────────────────
def candidates(today, back_day, deep_day):
    """每個 = (標籤, path, form)。⚠️ 這些參數是**照 t100sb02_1 的慣例推的**,
    對不對由 runner 上的 log 決定 —— ⛔ 不可因為「看起來合理」就寫進採礦。"""
    C = []
    for typek in ('sii', 'otc'):
        for d, tag in ((today, '今天'), (back_day, f'{BACK_DAYS} 天前'), (deep_day, f'{DEEP_DAYS} 天前')):
            C.append((f'當日重大訊息 t05st01 / {typek} / {tag}({d})', '/mops/web/ajax_t05st01',
                      {'encodeURIComponent': '1', 'step': '1', 'firstin': '1', 'off': '1',
                       'TYPEK': typek, 'year': roc(d), 'month': f'{d.month:02d}', 'day': f'{d.day:02d}'}))
    C.append((f'單一公司歷史 t05st01_1 / {SAMPLE}', '/mops/web/ajax_t05st01_1',
              {'encodeURIComponent': '1', 'step': '1', 'firstin': '1', 'off': '1',
               'TYPEK': 'sii', 'co_id': SAMPLE, 'year': roc(today), 'month': f'{today.month:02d}'}))
    C.append((f'歷史重大訊息 t05st02 / {SAMPLE}(⭐ 能不能一次回補就看這條)', '/mops/web/ajax_t05st02',
              {'encodeURIComponent': '1', 'step': '1', 'firstin': '1', 'off': '1',
               'TYPEK': 'sii', 'co_id': SAMPLE, 'keyword4': '', 'code1': '', 'TYPEK2': '', 'checkbtn': '',
               'queryName': 'co_id', 'inpuType': 'co_id', 'b_date': deep_day.strftime('%Y%m%d'),
               'e_date': today.strftime('%Y%m%d')}))
    C.append(('整頁(⛔ 非 ajax)t05st01 —— 只為了看官方表單長什麼樣', '/mops/web/t05st01', None))
    return C


def try_one(session, path, form, tries=3):
    """回 dict。⛔ 一律連 content-type 與 body 開頭一起帶回來(陷阱 #23)。"""
    import requests
    last = {'err': '沒跑到'}
    for attempt in range(tries):
        t0 = time.time()
        try:
            url = f'{HOST}{path}'
            hdr = {**UA, 'Referer': f'{HOST}/mops/web/t05st01'}
            r = (session.post(url, data=form, headers=hdr, timeout=30) if form is not None
                 else session.get(url, headers=hdr, timeout=30))
            r.encoding = r.encoding or 'utf-8'
            txt = r.text or ''
            rows = table_rows(txt)
            last = {'status': r.status_code, 'ctype': r.headers.get('Content-Type', ''),
                    'bytes': len(r.content or b''), 'sec': round(time.time() - t0, 2),
                    'blocked': is_blocked(txt), 'rows': len(rows),
                    'head': strip_tags(txt[:1200])[:300],
                    'sample': [r2[:8] for r2 in rows[:3]],
                    'verdict': verdict(r.status_code, r.headers.get('Content-Type', ''), txt)}
            if r.status_code == 200 and not is_blocked(txt):
                return last
        except Exception as e:
            last = {'err': f'{type(e).__name__}: {str(e)[:120]}', 'sec': round(time.time() - t0, 2)}
        time.sleep(1.5 * (attempt + 1))     # 指數退避(MOPS 對機器人敏感;照 confcall_miner)
    return last


def selftest():
    fails = []
    def ok(n, c, e=''):
        print(('✅ ' if c else '❌ ') + n + ('' if c else '  ' + str(e)[:160]))
        if not c:
            fails.append(n)
    ok('① 被擋偵測(兩組字串都認)', is_blocked('…因為安全性考量…') and is_blocked('CAN NOT BE ACCESSED') and not is_blocked('<table></table>'))
    good = '<table><tr><th>代號</th><th>名稱</th></tr><tr><td>2330</td><td>台積電</td><td>115/09/19</td><td>公告本公司…</td></tr></table>'
    ok('② 解析:代號開頭的資料列才算(表頭⛔ 不算)', len(table_rows(good)) == 1 and table_rows(good)[0][0] == '2330')
    # ⭐ 決定性對照:一頁「查無資料」的網頁也是 HTTP 200、也有 <table> —— ⛔ 不可被當成抓到了
    page = '<html><body><table><tr><td>查詢</td><td>說明</td><td>回首頁</td><td>登出</td></tr></table></body></html>'
    ok('③ ⭐ 決定性對照:HTTP 200 的「一頁網頁」⛔ 不可判成有資料(陷阱 #23)',
       len(table_rows(page)) == 0 and '沒有任何資料列' in verdict(200, 'text/html', page), verdict(200, 'text/html', page))
    ok('④ 被擋 → 判定要說是被擋,⛔ 不可說成沒資料', verdict(200, 'text/html', '因為安全性考量') == '被主機擋(安全性考量)')
    ok('⑤ 有資料 → 印出列數', verdict(200, 'text/html', good).startswith('✅ 有資料(1 列)'), verdict(200, 'text/html', good))
    ok('⑥ 非 200 直接回 HTTP 碼', verdict(403, '', '') == 'HTTP 403')
    ok('⑦ 民國年換算', roc(date(2026, 9, 21)) == '115')
    ok('⑧ 候選清單:host 一律 mopsov(⛔ mops. 對 runner 是擋的)', HOST.startswith('https://mopsov.'), HOST)
    ok('⑨ 空過守門:候選端點不可是空的', len(candidates(date(2026, 9, 21), date(2026, 9, 18), date(2025, 8, 17))) >= 8)
    print('❌ %d 條失敗' % len(fails) if fails else '✅ MOPS_PROBE_SELFTEST_PASS')
    return 1 if fails else 0


def main():
    if '--selftest' in sys.argv:
        return selftest()
    import requests
    today = datetime.now(TW).date()
    back, deep = today - timedelta(days=BACK_DAYS), today - timedelta(days=DEEP_DAYS)
    print(f'🧨 MOPS 重大訊息探針 —— host {HOST} ・今天(台北){today}')
    print('🔐 金鑰:這支**一把都沒用**(既有 MOPS 抓法就是零 Secrets)——')
    print('   log 裡若出現要登入/驗證碼的字樣,那才是「需要金鑰」的證據。')
    print('⛔ 提醒:HTTP 200 ⛔ 不等於抓到了 —— 每一條都會印 content-type 與 body 開頭(陷阱 #23)。\n')
    s = requests.Session()
    res, t0 = [], time.time()
    for (label, path, form) in candidates(today, back, deep):
        r = try_one(s, path, form)
        r.update({'label': label, 'path': path, 'form': form})
        res.append(r)
        print(f"── {label}\n   {path}")
        if 'err' in r:
            print(f"   ❌ {r['err']}  ({r.get('sec')}s)")
        else:
            print(f"   {r['verdict']} ・HTTP {r['status']} ・{r['ctype']} ・{r['bytes']} bytes ・{r['sec']}s")
            print(f"   body 開頭:{r['head'][:220]}")
            for row in r.get('sample', []):
                print(f"   📄 {row}")
        time.sleep(0.8)
    hit = [r for r in res if str(r.get('verdict', '')).startswith('✅')]
    nerr, nblk = sum(1 for r in res if 'err' in r), sum(1 for r in res if r.get('blocked'))
    # 🚨 「連不上」「被擋」「名字猜錯」是**三件完全不同的失敗**,下一步也完全不同 ——
    #    ⛔ 不可全部講成「抓不到」(V76.4.2 才因為把兩種失敗混為一談差點修錯那一個)。
    allerr = nerr == len(res)
    print('\n══════ 結論 ══════')
    if hit:
        head = '、'.join(r['path'] + ' ← ' + r['label'] for r in hit)
    elif allerr:
        head = '⛔ **一條都連不上**(網路層就掛了)—— ⛔ 這⛔ 不是「名字猜錯」的證據,端點對不對這一輪根本沒測到'
    elif nblk:
        head = f'⛔ 被主機擋了 {nblk} 次 —— 這是 **IP/UA 的問題**,⛔ 不是端點名字的問題'
    else:
        head = '⛔ 連得上、也沒被擋,但候選全部沒拿到資料列 → **名字猜錯**的機率最高(陷阱 #23);⛔ 不可據此寫採礦'
    print(f"1️⃣ 端點:{head}")
    print(f"2️⃣ 筆數/欄位:{'見上面 📄 那幾行' if hit else '—'}")
    deep_hit = [r for r in hit if str(DEEP_DAYS) in r['label'] or 't05st02' in r['path']]
    print(f"3️⃣ ⭐ 歷史:{'✅ 拿得到 %d 天前的 → **現在就測得動**' % DEEP_DAYS if deep_hit else ('⛔ 這一輪連都連不上,歷史這件事**沒測到**' if allerr else '⛔ 沒拿到舊資料 → 很可能只能從今天開始存(要再等約三個月才測得動)')}")
    print(f"4️⃣ 耗時/被擋:全部 {round(time.time() - t0, 1)}s ・被擋 {nblk} 次 ・連不上 {nerr} 次 / 共 {len(res)} 條")
    print('5️⃣ 金鑰:這一輪**一把金鑰都沒用**。'
          + ('⛔ 但這一輪連都連不上 → 「要不要金鑰」這件事還沒測到。' if allerr
             else ('⚠️ 被主機擋 → 那是 IP/UA 的問題,⛔ 加金鑰也沒用(MOPS 本來就不發金鑰)。' if nblk
                   else '✅ 連得上而且沒被擋 → GitHub IP 進得去,零金鑰可行。')))
    try:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps({'probed_at': datetime.now(TW).isoformat(), 'host': HOST,
                                   'today': str(today), 'results': res}, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'\n📤 結果已寫 {OUT}(artifact 用;⛔ 不推任何分支)')
    except Exception as e:
        print(f'⚠️ 結果檔寫不出來:{e}')
    return 0


# ⛔ 陷阱 #9:進入點一律放檔尾
if __name__ == '__main__':
    sys.exit(main())
