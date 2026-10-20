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


# 🧭 V79.3.8 第一次 runner 實跑(2026-10-20):9 條全是 HTTP 200、0 列,而 body 是 MOPS **自己的提示訊息**
#   (「未指定公司代號時，僅能查詢單日重大訊息」「資料庫中查無需求資料」)→ 端點是對的、**參數不對**,
#   舊判定一律寫「名字猜錯」= 把第四種失敗講成第三種(下一步完全不同:該改的是表單欄位,⛔ 不是換網址)
MOPS_MSG = ('查無需求資料', '未指定公司代號', '僅能查詢', '請輸入', '查詢條件', '輸入錯誤', '日期錯誤', '不得')


def mops_msg(text):
    """body 是 MOPS 自己的提示訊息 → 回那句話(去標籤、80 字);不是 → None。"""
    t = strip_tags(text or '')
    for k in MOPS_MSG:
        i = t.find(k)
        if i != -1:
            a = max(0, t.rfind(' ', 0, max(0, i - 30)) + 1)
            return t[a:a + 80]
    return None


def form_fields(html):
    """官方頁面上的表單欄位 [(tag, name, value)]、form action 與每一個 ajax_ 的上下文 —— 讓官方頁面自己說參數是什麼(陷阱 #23)。"""
    out, seen = [], set()
    for m in re.finditer(r'<(input|select|textarea)\b([^>]*)>', html or '', flags=re.I):
        attrs = m.group(2)
        nm = re.search(r'name\s*=\s*["\']?([\w\-\[\]]+)', attrs, flags=re.I)
        if not nm:
            continue
        val = re.search(r'value\s*=\s*["\']([^"\']*)', attrs, flags=re.I)
        key = (m.group(1).lower(), nm.group(1))
        if key in seen:
            continue
        seen.add(key)
        out.append((m.group(1).lower(), nm.group(1), (val.group(1) if val else '')[:40]))
    actions = sorted(set(re.findall(r'action\s*=\s*["\']([^"\']+)', html or '', flags=re.I)))[:10]
    ajax = []
    for m in re.finditer(r'ajax_\w+', html or ''):
        ajax.append(re.sub(r'\s+', ' ', html[max(0, m.start() - 120):m.end() + 160]))
        if len(ajax) >= 6:
            break
    return {'fields': out[:80], 'actions': actions, 'ajax': ajax}


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
    msg = mops_msg(text)
    if msg:
        return f'🔧 端點對、**參數不對**(MOPS 回它自己的提示:「{msg}」)'
    return '⚠️ HTTP 200 但**沒有任何資料列**(多半是名字猜錯 → 拿到一頁網頁)'


def roc(d):
    return str(d.year - 1911)


# ───────────────────────── 候選端點(⛔ 猜的,由 log 說了算) ─────────────────────────
def candidates(today, back_day, deep_day):
    """每個 = (標籤, path, form)。
    🧭 V79.3.8 第二輪:照 runner 上抓到的**官方表單欄位**改(第一輪 log 的 🧾 那幾行):
       form1 → /mops/web/ajax_t05st01,欄位 firstin / TYPEK / step / co_id / funcName / queryName / inpuType / off /
       year(民國)/ month / b_date / e_date(都是下拉選單);MOPS 自己的提示「未指定公司代號時,僅能查詢單日」
       → 全市場一定要 b_date = e_date(單日),指定公司才可以一段。
    ⚠️ 下拉選單的值是 1 還是 01 不知道 → 兩種都送,由 log 說了算(⛔ 不猜一種就寫進採礦)。"""
    base = {'encodeURIComponent': '1', 'firstin': '1', 'step': '1', 'off': '1', 'funcName': 't05st01',
            'queryName': 'co_id', 'inpuType': 'co_id', 'keyword': '', 'keycon': ''}
    C = []
    for typek in ('sii', 'otc'):
        for d, tag in ((today, '今天'), (back_day, f'{BACK_DAYS} 天前'), (deep_day, f'{DEEP_DAYS} 天前')):
            for pad in (False, True):
                mm, dd = (f'{d.month:02d}', f'{d.day:02d}') if pad else (str(d.month), str(d.day))
                C.append((f'全市場單日 t05st01 / {typek} / {tag}({d})/ {"01" if pad else "1"} 格式', '/mops/web/ajax_t05st01',
                          {**base, 'TYPEK': typek, 'co_id': '', 'year': roc(d), 'month': mm, 'b_date': dd, 'e_date': dd}))
    # 指定公司:可以查一段 → 一整個月 / 整年 / 5 年前(⭐ 回補深度看這幾條)
    for y, mm, b, e, tag in ((today.year, str(today.month), '1', str(today.day), '這個月'),
                             (today.year, '', '', '', '今年整年(月份留空)'),
                             (today.year - 5, '', '', '', '5 年前整年'),
                             (today.year - 5, '6', '1', '30', '5 年前 6 月')):
        C.append((f'單一公司 t05st01 / {SAMPLE} / {tag}', '/mops/web/ajax_t05st01',
                  {**base, 'TYPEK': 'all', 'co_id': SAMPLE, 'year': str(y - 1911), 'month': mm, 'b_date': b, 'e_date': e}))
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
            if 'ajax' not in path:                          # 整頁:把官方表單的欄位印出來(下一輪照它改參數)
                last['form_info'] = form_fields(txt)
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
    # ⑩ V79.3.8:MOPS 自己的提示訊息 = 參數不對(⛔ 不可再判成「名字猜錯」);一般網頁照舊
    msg_page = '<html><body>公開資訊觀測站 未指定公司代號時，僅能查詢單日重大訊息 <script>x</script></body></html>'
    ok('⑩ MOPS 自己的提示 → 判成「參數不對」(⛔ 不是名字猜錯)', '參數不對' in verdict(200, 'text/html', msg_page) and '名字猜錯' not in verdict(200, 'text/html', msg_page), verdict(200, 'text/html', msg_page))
    ok('⑩ 一般網頁(沒有 MOPS 提示)照舊判「名字猜錯」', '名字猜錯' in verdict(200, 'text/html', page), verdict(200, 'text/html', page))
    ff = form_fields('<form action="/mops/web/ajax_t05st01" method=post><input type="hidden" name="step" value="1"><input name=co_id value="">'
                     '<select name="TYPEK"><option>sii</option></select><script>ajax1(document.form1,"ajax_t05st01")</script></form>')
    ok('⑪ 官方表單欄位解析:input / select 名字、action、ajax 上下文', [x[1] for x in ff['fields']] == ['step', 'co_id', 'TYPEK'] and ff['actions'] == ['/mops/web/ajax_t05st01'] and len(ff['ajax']) >= 1, ff)
    print('❌ %d 條失敗' % len(fails) if fails else '✅ MOPS_PROBE_SELFTEST_PASS')
    return 1 if fails else 0


def main():
    if '--selftest' in sys.argv:
        return selftest()
    import requests
    today = datetime.now(TW).date()
    back, deep = today - timedelta(days=BACK_DAYS), today - timedelta(days=DEEP_DAYS)
    # 週末沒有重大訊息 → 往前挪到平日(⛔ 不然「0 列」分不出是週末還是參數不對)
    while back.weekday() >= 5:
        back -= timedelta(days=1)
    while deep.weekday() >= 5:
        deep -= timedelta(days=1)
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
            fi = r.get('form_info')
            if fi:
                print(f"   🧾 官方表單 action:{fi['actions']}")
                print(f"   🧾 欄位({len(fi['fields'])}):" + ' ・'.join(f'{t}:{n}={v}' for t, n, v in fi['fields']))
                for a in fi['ajax']:
                    print(f"   🧾 ajax 上下文:…{a}…")
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
    elif any('參數不對' in str(r.get('verdict', '')) for r in res):
        head = '🔧 連得上、沒被擋,而且 MOPS 回的是**它自己的提示訊息** → 端點是對的、**表單欄位不對** —— 照上面 🧾 官方表單的欄位改參數再跑一輪(⛔ 不是換網址)'
    else:
        head = '⛔ 連得上、也沒被擋,但候選全部沒拿到資料列 → **名字猜錯**的機率最高(陷阱 #23);⛔ 不可據此寫採礦'
    print(f"1️⃣ 端點:{head}")
    print(f"2️⃣ 筆數/欄位:{'見上面 📄 那幾行' if hit else '—'}")
    deep_hit = [r for r in hit if str(DEEP_DAYS) in r['label'] or '5 年前' in r['label']]
    print(f"3️⃣ ⭐ 歷史:{'✅ 拿得到舊的(' + '、'.join(r['label'] for r in deep_hit) + ')→ **現在就測得動**' if deep_hit else ('⛔ 這一輪連都連不上,歷史這件事**沒測到**' if allerr else '⛔ 沒拿到舊資料 → 很可能只能從今天開始存(要再等約三個月才測得動)')}")
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
