#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🎤 confcall_probe.py —— 「法說會(法人說明會)到底哪個來源給得到、給什麼欄位」探針
   (只讀、不寫檔、不碰 gh-pages/data)。

🚨 背景(V77.2.7 前):
   `macro_miner.fetch_earnings_calls` 打 TWSE OpenAPI `t187ap02_L/_O`,實跑 log 2026-09-16:
     📞 法說會 上市: 0 場(窗內 14 天)
     ⚠️ 法說會 上櫃 例外:Expecting value: line 1 column 1 (char 0)
   → 上市那個資料集代碼**從沒驗證過**(docstring 自己寫「候選端點,首次跑看 log」),
     上櫃把 `_O` 掛在 TWSE 主機上 → 回 HTML 200(陷阱 #23)。
   而 `docs/DECISIONS.md:4043` 早就登記「macro_risk.json 法說會 0 筆」沒修。
   使用者現在要一整頁法說會(時間表 + 擇要內容)→ 來源先定案,⛔ 不再憑猜的端點寫進 miner。

⛔ 沙箱連不到 twse / tpex / mops(proxy 403,已實測)→ 只能在 GitHub Actions 跑
   (`finmind_gap_probe.yml` → which = confcall),結果只在 log。

🚧 三個刻意的設計(⛔ 都別拿掉):
   ① **對照組**:先打本專案每天都在用、已知會通的 `t187ap03_L`。它也掛 = 這台 runner 被擋,
      ⛔ 不可解讀成「端點改名」(V73.6.1 櫃買指數卡五輪的教訓)。
   ② **HTTP 200 不等於成功**(陷阱 #23):每一筆印 content-type + 回應前 200 字;
      例外要印 `type(e).__name__`(SSLError / 403 / HTML-200 是三種不同的失敗)。
   ③ **讓官方自己說資料集名**:抓 OpenAPI 目錄(swagger / HTML),列出標題含「法人說明會/法說」的 path,
      ⛔ 不靠我背名字(同 V71.3.4 解 FinMind 資料集名的做法)。

📋 結尾會印一張「決策表」:每個 JSON 命中的來源 → 日期鍵 / 代號鍵 / 名稱鍵 / 時間鍵 / 地點鍵 / 擇要鍵 / 檔案鍵,
   以及窗內(−60 ~ +45 天)列數、有擇要幾列、有檔案連結幾列。
   那兩列「原文樣本」之後要**逐字**貼進 `scripts/test_confcall.py` 當測資(陷阱 #40:⛔ 不憑印象編)。

用法(GHA 手動 dispatch:finmind_gap_probe.yml → which = confcall):
   python3 scripts/confcall_probe.py
"""
import json
import re
import sys
from datetime import date, timedelta

import requests

UA = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, text/plain, */*'}
PAST, FUTURE = 60, 45
TODAY = date.today()


def _get(url, headers=None, timeout=25):
    h = dict(UA)
    if headers:
        h.update(headers)
    return requests.get(url, headers=h, timeout=timeout)


def _post(url, data=None, json_body=None, headers=None, timeout=25):
    h = dict(UA)
    if headers:
        h.update(headers)
    return requests.post(url, data=data, json=json_body, headers=h, timeout=timeout)


def _show(tag, r):
    ct = (r.headers.get('content-type') or '')[:45]
    body = r.text or ''
    print(f"  {tag:<52} HTTP {r.status_code} ・{ct} ・{len(body)} bytes")
    print(f"     ↳ {body[:200].replace(chr(10), ' ')!r}")


def _parse_date(s):
    """'115/07/17'(民國) / '1150717' / '2026/07/17' / '2026-07-17' → date;失敗回 None。
    ⛔ 刻意複製 macro_miner._parse_date_flexible 而不 import —— 探針不該拖進整支 macro_miner。"""
    s = str(s or "").strip().replace("-", "/").replace(".", "/")
    if not s:
        return None
    if s.isdigit() and len(s) in (7, 8):
        if len(s) == 7:
            y, m, d = int(s[:3]) + 1911, int(s[3:5]), int(s[5:7])
        else:
            y, m, d = int(s[:4]), int(s[4:6]), int(s[6:8])
        try:
            return date(y, m, d)
        except Exception:
            return None
    parts = [p for p in s.split("/") if p != ""]
    if len(parts) != 3:
        return None
    try:
        y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
        if y < 1911:
            y += 1911
        return date(y, m, d)
    except Exception:
        return None


def _find_key(keys, *musts):
    for k in keys:
        if all(m in k for m in musts):
            return k
    return None


DECISION = []   # [(tag, dict)]


def _analyze_rows(tag, rows):
    """對一份 JSON list 做欄位偵測 + 窗內統計 + 印兩列原文。"""
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        print(f"     ⚠️ 非預期結構:{type(rows).__name__}"
              + (f" / 首筆 {type(rows[0]).__name__}" if isinstance(rows, list) and rows else ""))
        return
    keys = list(rows[0].keys())
    print(f"     列數 {len(rows)} ・欄名 {keys}")
    for i, row in enumerate(rows[:2]):
        print(f"     樣本{i + 1}(逐字):{json.dumps(row, ensure_ascii=False)[:600]}")
    k_date = (_find_key(keys, '說明會', '日期') or _find_key(keys, '法說', '日期')
              or _find_key(keys, '日期') or _find_key(keys, 'Date'))
    k_code = _find_key(keys, '公司', '代號') or _find_key(keys, '代號') or _find_key(keys, 'Code')
    k_name = (_find_key(keys, '公司', '簡稱') or _find_key(keys, '公司', '名稱')
              or _find_key(keys, '簡稱') or _find_key(keys, '名稱') or _find_key(keys, 'Name'))
    k_time = _find_key(keys, '說明會', '時間') or _find_key(keys, '時間')
    k_place = _find_key(keys, '地點')
    k_sum = (_find_key(keys, '擇要') or _find_key(keys, '摘要') or _find_key(keys, '訊息')
             or _find_key(keys, '內容'))
    k_files = [k for k in keys if any(w in k for w in ('簡報', '檔案', '影音', '連結', '網址', 'URL', 'Link'))]
    dates = [d for d in (_parse_date(r.get(k_date)) if k_date else None for r in rows) if d]
    lo, hi = (min(dates), max(dates)) if dates else (None, None)
    win = [r for r in rows if k_date and (d := _parse_date(r.get(k_date)))
           and (TODAY - timedelta(days=PAST)) <= d <= (TODAY + timedelta(days=FUTURE))]
    with_sum = sum(1 for r in rows if k_sum and str(r.get(k_sum) or '').strip())
    with_files = sum(1 for r in rows if any(str(r.get(k) or '').strip() for k in k_files))
    fut = sum(1 for d in dates if d >= TODAY)
    print(f"     🔑 日期={k_date!r} 代號={k_code!r} 名稱={k_name!r} 時間={k_time!r} 地點={k_place!r} 擇要={k_sum!r} 檔案={k_files}")
    print(f"     📅 日期解析成功 {len(dates)}/{len(rows)} ・範圍 {lo} ~ {hi} ・今天起 {fut} 列 ・窗內(−{PAST}~+{FUTURE}) {len(win)} 列")
    print(f"     📝 有擇要文字 {with_sum} 列 ・有檔案/連結 {with_files} 列")
    DECISION.append((tag, {'n': len(rows), 'date': k_date, 'code': k_code, 'name': k_name, 'time': k_time,
                           'place': k_place, 'sum': k_sum, 'files': k_files, 'win': len(win),
                           'with_sum': with_sum, 'with_files': with_files, 'range': f'{lo}~{hi}'}))


def _try_json(tag, url, headers=None):
    try:
        r = _get(url, headers=headers)
        _show(tag, r)
        if r.status_code != 200:
            return None
        try:
            j = r.json()
        except Exception as e:
            print(f"     ⚠️ 不是 JSON({type(e).__name__})→ 陷阱 #23:200 但回的是網頁")
            return None
        _analyze_rows(tag, j)
        return j
    except Exception as e:
        print(f"  {tag:<52} ❌ {type(e).__name__}: {str(e)[:120]}")
        return None


# ══════════════════════════════════════════════════════════════
def probe_control():
    print("\n" + "=" * 72)
    print("⓪ 對照組 t187ap03_L(本專案每天在用;它掛 = runner 被擋,⛔ 下面全部不可解讀成端點改名)")
    print("=" * 72)
    try:
        r = _get('https://openapi.twse.com.tw/v1/opendata/t187ap03_L')
        _show('TWSE t187ap03_L(對照組)', r)
        ok = r.status_code == 200 and isinstance(r.json(), list) and len(r.json()) > 900
        print(f"     {'✅ 對照組通' if ok else '❌ 對照組掛 → 這一輪的失敗不可解讀'}")
        return ok
    except Exception as e:
        print(f"  對照組 ❌ {type(e).__name__}: {str(e)[:120]}")
        return False


def probe_twse_candidates():
    print("\n" + "=" * 72)
    print("① TWSE OpenAPI 上市候選(t187ap38_L / t187ap02_L)")
    print("=" * 72)
    for code in ('t187ap38_L', 't187ap02_L'):
        _try_json(f'TWSE {code}', f'https://openapi.twse.com.tw/v1/opendata/{code}')


def probe_twse_catalog():
    print("\n" + "=" * 72)
    print("② TWSE OpenAPI 目錄:讓官方自己說哪個 path 是法人說明會")
    print("=" * 72)
    found = []
    for url in ('https://openapi.twse.com.tw/v1/swagger.json', 'https://openapi.twse.com.tw/v1/openapi.json',
                'https://openapi.twse.com.tw/'):
        try:
            r = _get(url)
            _show(f'目錄 {url.split("/v1/")[-1] if "/v1/" in url else "首頁"}', r)
            if r.status_code != 200:
                continue
            txt = r.text or ''
            try:
                j = r.json()
                paths = j.get('paths') if isinstance(j, dict) else None
                if isinstance(paths, dict):
                    print(f"     swagger paths 共 {len(paths)}")
                    for p, spec in paths.items():
                        blob = json.dumps(spec, ensure_ascii=False)
                        if re.search(r'法人說明會|法說', blob):
                            found.append(p)
                            summ = ''
                            for mth in spec.values():
                                if isinstance(mth, dict):
                                    summ = mth.get('summary') or mth.get('description') or ''
                                    break
                            print(f"     🎯 {p}  ← {str(summ)[:80]}")
                    continue
            except Exception:
                pass
            # HTML → regex 撈 /v1/opendata/xxx 與旁邊的中文
            hits = re.findall(r'(/v1/(?:opendata|exchangeReport)/[A-Za-z0-9_]+)', txt)
            uniq = sorted(set(hits))
            print(f"     HTML 撈到 {len(uniq)} 個 path")
            for m in re.finditer(r'法人說明會|法說', txt):
                seg = txt[max(0, m.start() - 200): m.end() + 200]
                ps = re.findall(r'/v1/(?:opendata|exchangeReport)/[A-Za-z0-9_]+', seg)
                print(f"     🎯 「{m.group(0)}」附近的 path:{sorted(set(ps))} ・片段 {seg[:160].replace(chr(10), ' ')!r}")
                found.extend(ps)
        except Exception as e:
            print(f"  目錄 ❌ {type(e).__name__}: {str(e)[:120]}")
    found = sorted(set(found))
    print(f"  📋 目錄裡跟法說會有關的 path:{found or '（沒有找到 —— 目錄拿不到或名稱不含那四個字）'}")
    for p in found:
        _try_json(f'目錄命中 {p}', 'https://openapi.twse.com.tw' + p)
    return found


def probe_tpex():
    print("\n" + "=" * 72)
    print("③ TPEx 櫃買主機(⚠️ V73.6.1/V76.4.2:對 GitHub runner 間歇 403 / SSLError,三種要分開講)")
    print("=" * 72)
    for code in ('mopsfin_t187ap38_O', 'mopsfin_t187ap02_O'):
        _try_json(f'TPEx {code}', f'https://www.tpex.org.tw/openapi/v1/{code}')
    for url in ('https://www.tpex.org.tw/openapi/swagger.json', 'https://www.tpex.org.tw/openapi/'):
        try:
            r = _get(url)
            _show(f'TPEx 目錄 {url.rsplit("/", 1)[-1] or "首頁"}', r)
            if r.status_code == 200:
                txt = r.text or ''
                ps = set()
                for m in re.finditer(r'法人說明會|法說', txt):
                    seg = txt[max(0, m.start() - 300): m.end() + 300]
                    ps.update(re.findall(r'/openapi/v1/[A-Za-z0-9_]+|mopsfin_[A-Za-z0-9_]+', seg))
                print(f"     🎯 TPEx 目錄裡跟法說會有關:{sorted(ps) or '（沒有）'}")
        except Exception as e:
            print(f"  TPEx 目錄 ❌ {type(e).__name__}: {str(e)[:120]}")
    print("\n  ④ TWSE 主機掛 _O(現行 miner 的寫法;預期 HTML-200 = 陷阱 #23,印出來當證據)")
    _try_json('TWSE t187ap38_O(預期是網頁)', 'https://openapi.twse.com.tw/v1/opendata/t187ap38_O')
    _try_json('TWSE t187ap02_O(現行 miner)', 'https://openapi.twse.com.tw/v1/opendata/t187ap02_O')


def probe_mops():
    print("\n" + "=" * 72)
    print("⑤ MOPS 公開資訊觀測站 法說會查詢(t100sb02_1)—— 上市上櫃都在同一站,是上櫃最可能的活路")
    print("=" * 72)
    # 表單頁:撈出真正的欄位名,下一輪才有得修
    try:
        r = _get('https://mops.twse.com.tw/mops/web/t100sb02_1')
        _show('MOPS 表單頁 t100sb02_1(GET)', r)
        if r.status_code == 200:
            txt = r.text or ''
            names = sorted(set(re.findall(r'<(?:input|select)[^>]*name=["\']([^"\']+)["\']', txt)))
            print(f"     表單欄位:{names[:30]}")
    except Exception as e:
        print(f"  MOPS 表單頁 ❌ {type(e).__name__}: {str(e)[:120]}")

    roc_y = TODAY.year - 1911
    for host in ('https://mops.twse.com.tw', 'https://mopsov.twse.com.tw'):
        for typek in ('sii', 'otc'):
            form = {'encodeURIComponent': '1', 'step': '1', 'firstin': '1', 'off': '1',
                    'TYPEK': typek, 'year': str(roc_y), 'month': f'{TODAY.month:02d}'}
            try:
                r = _post(f'{host}/mops/web/ajax_t100sb02_1', data=form,
                          headers={'Referer': f'{host}/mops/web/t100sb02_1',
                                   'Content-Type': 'application/x-www-form-urlencoded'})
                _show(f'MOPS ajax POST {typek}@{host.split("//")[1].split(".")[0]}', r)
                if r.status_code == 200:
                    txt = r.text or ''
                    tr = len(re.findall(r'<tr', txt, flags=re.I))
                    hit = len(re.findall(r'法人說明會|法說', txt))
                    flags = [w for w in ('驗證碼', '查詢過於頻繁', 'Overrun', '無資料', '查無') if w in txt]
                    print(f"     <tr> {tr} 個 ・「法說」字樣 {hit} 次 ・旗標 {flags}")
                    # 印第一個資料列附近,看欄位長什麼樣
                    m = re.search(r'<tr[^>]*>(?:(?!</tr>).){40,}?</tr>', txt, flags=re.S | re.I)
                    if m:
                        row = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '|', m.group(0)))
                        print(f"     首列(去標籤):{row[:300]!r}")
            except Exception as e:
                print(f"  MOPS ajax {typek}@{host} ❌ {type(e).__name__}: {str(e)[:120]}")
    # ⑥ 第二輪(run #1 已證實只有 mopsov 的 ajax 回真表格):把**原始列 HTML** 逐字印出來,
    #    parser 與測試測資才有真東西可以對(陷阱 #40)。順便驗「前一個月 / 下一個月」查得到嗎(窗口要跨月)。
    print("\n  ⑥ mopsov 原始列 dump(給 parser + 測資用)+ 跨月查詢")
    for typek in ('sii', 'otc'):
        for dm in (-1, 0, 1):
            y, m = TODAY.year, TODAY.month + dm
            if m < 1: y, m = y - 1, 12
            if m > 12: y, m = y + 1, 1
            form = {'encodeURIComponent': '1', 'step': '1', 'firstin': '1', 'off': '1',
                    'TYPEK': typek, 'year': str(y - 1911), 'month': f'{m:02d}'}
            try:
                r = _post('https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1', data=form,
                          headers={'Referer': 'https://mopsov.twse.com.tw/mops/web/t100sb02_1',
                                   'Content-Type': 'application/x-www-form-urlencoded'})
                txt = r.text or ''
                trs = re.findall(r'<tr[^>]*>.*?</tr>', txt, flags=re.S | re.I)
                data_trs = [t for t in trs if re.search(r'<td', t, flags=re.I)]
                print(f"  {typek} {y}/{m:02d}: HTTP {r.status_code} ・{len(txt)} bytes ・<tr> {len(trs)} ・含 <td> 的 {len(data_trs)}")
                if dm == 0:
                    for i, t in enumerate(data_trs[:3]):
                        print(f"     原始列{i + 1}(逐字,前 1500 字):{t[:1500]!r}")
                    hrefs = re.findall(r'href=["\']([^"\']+)["\']', ' '.join(data_trs[:20]))
                    print(f"     前 20 列裡的 href 樣本:{hrefs[:8]}")
                    # 有些欄位是用 JS onclick / form 開檔,也印出來
                    oc = re.findall(r'onclick=["\']([^"\']{0,160})', ' '.join(data_trs[:20]))
                    print(f"     onclick 樣本:{oc[:5]}")
                    # 擇要文字非空的比例
                    cells = [re.sub(r'<[^>]+>', '', c) for t in data_trs for c in re.findall(r'<td[^>]*>(.*?)</td>', t, flags=re.S | re.I)]
                    print(f"     每列 <td> 數(前 5 列):{[len(re.findall(r'<td', t, flags=re.I)) for t in data_trs[:5]]}")
            except Exception as e:
                print(f"  {typek} {y}/{m:02d} ❌ {type(e).__name__}: {str(e)[:120]}")

    # JSON API 候選(新版 MOPS 有 /mops/api/)
    for typek in ('sii', 'otc'):
        try:
            r = _post('https://mops.twse.com.tw/mops/api/t100sb02_1',
                      json_body={'TYPEK': typek, 'year': str(roc_y), 'month': f'{TODAY.month:02d}'},
                      headers={'Referer': 'https://mops.twse.com.tw/mops/web/t100sb02_1'})
            _show(f'MOPS api JSON POST {typek}', r)
            if r.status_code == 200:
                try:
                    j = r.json()
                    print(f"     頂層 {type(j).__name__} ・keys={list(j.keys())[:12] if isinstance(j, dict) else len(j)}")
                    rows = None
                    if isinstance(j, dict):
                        for k in ('result', 'data', 'rows', 'list'):
                            v = j.get(k)
                            if isinstance(v, list):
                                rows = v
                            elif isinstance(v, dict):
                                for kk in ('data', 'rows', 'list'):
                                    if isinstance(v.get(kk), list):
                                        rows = v[kk]
                            if rows:
                                break
                    elif isinstance(j, list):
                        rows = j
                    if rows and isinstance(rows[0], dict):
                        _analyze_rows(f'MOPS api {typek}', rows)
                    elif rows:
                        print(f"     rows 是 list-of-list:首列 {json.dumps(rows[0], ensure_ascii=False)[:300]}")
                except Exception as e:
                    print(f"     ⚠️ 不是 JSON({type(e).__name__})")
        except Exception as e:
            print(f"  MOPS api {typek} ❌ {type(e).__name__}: {str(e)[:120]}")


# ─────────────────────────────────────────────────────────────────────
# ⑦ 簡報 PDF 到底怎麼下載(V77.2.8)
#    🚨 這一段的存在理由:擇要訊息中位數只有 34 個字(「說明產業現況及本公司經營績效等」),
#       **真正的內容全在簡報裡**,而 918 場有 884 場附檔 → 能不能一鍵開,決定這一頁有沒有用。
#    ⛔ 不可猜網址(陷阱 #23:MOPS 對錯路徑會回 HTTP 200 + 網頁)→ 讓官方的 HTML 自己說要送什麼。
#    ⭐ 最後印一行結論「GET 可直接開嗎?」—— 它同時決定兩件事:
#       (a) 前端能不能用 <a href>;(b) 外部 AI 能不能讀那份 PDF(深度查詢要不要附網址)。
# ─────────────────────────────────────────────────────────────────────
def probe_file_download():
    print("\n" + "=" * 72)
    print("⑦ 簡報下載:先讓官方 HTML 自己說(form 原文),再拿『真實檔名』實際試")
    print("=" * 72)

    # ── 7-1 取一份有資料的 ajax 回應(上市;本月沒有就往回找)
    html, used = '', ''
    for back in range(0, 4):
        y, m = TODAY.year, TODAY.month - back
        while m <= 0:
            y, m = y - 1, m + 12
        form = {'encodeURIComponent': '1', 'step': '1', 'firstin': '1', 'off': '1',
                'TYPEK': 'sii', 'year': str(y - 1911), 'month': f'{m:02d}'}
        try:
            r = _post('https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1', data=form,
                      headers={'Referer': 'https://mopsov.twse.com.tw/mops/web/t100sb02_1',
                               'Content-Type': 'application/x-www-form-urlencoded'})
            if r.status_code == 200 and 'fileName' in (r.text or ''):
                html, used = r.text, f'{y}/{m:02d}'
                break
            print(f"  ⏭️ {y}/{m:02d}:HTTP {r.status_code} ・{len(r.text or '')} bytes ・含 fileName={('fileName' in (r.text or ''))}")
        except Exception as e:
            print(f"  ❌ {y}/{m:02d} {type(e).__name__}: {str(e)[:120]}")
    if not html:
        print("  ❌ 四個月都沒拿到含檔名的回應 → ⑦ 整段不可解讀(先看 ⑥ 是不是被擋)。")
        return
    print(f"  ✅ 用 {used} 這份回應({len(html)} bytes)")

    # ── 7-2 把所有 <form> 逐字印出來(⭐ 官方自己說要送什麼)
    forms = re.findall(r'<form[^>]*>.*?</form>', html, flags=re.S | re.I)
    print(f"  📋 回應裡共 {len(forms)} 個 <form>")
    for i, f in enumerate(forms[:6]):
        nm = re.search(r'name\s*=\s*[\'"]([^\'"]+)', f)
        ac = re.search(r'action\s*=\s*[\'"]([^\'"]+)', f)
        mth = re.search(r'method\s*=\s*[\'"]([^\'"]+)', f)
        ins = re.findall(r'<input[^>]*>', f, flags=re.I)
        print(f"    form{i + 1}: name={nm.group(1) if nm else None!r} action={ac.group(1) if ac else None!r} method={mth.group(1) if mth else None!r} ・input {len(ins)} 個")
        for tag in ins[:14]:
            n = re.search(r'name\s*=\s*[\'"]([^\'"]*)', tag)
            v = re.search(r'value\s*=\s*[\'"]([^\'"]*)', tag)
            print(f"        - name={n.group(1) if n else None!r} value={v.group(1) if v else None!r}")
        print(f"        原文(前 600 字):{f[:600]!r}")

    # ── 7-3 撈一個真實檔名 + 它那一列的公司代號(⛔ 不自己造檔名)
    fn = re.findall(r'fileName\.value="([^"]+)"', html)
    print(f"  📄 檔名樣本({len(fn)} 個):{fn[:5]}")
    if not fn:
        print("  ❌ 沒有檔名 → ⑦ 停在這。")
        return
    name = fn[0]
    # 有些站的下載還要帶 step/filePath,把該列附近的 JS 逐字印出來
    idx = html.find(name)
    print(f"  🔍 該檔名前後 400 字(逐字):{html[max(0, idx - 400):idx + 200]!r}")

    # ── 7-4 實際試:POST / GET × 兩台主機
    base = {'step': '9', 'functionName': 'show_file', 'filePath': '/server-java/t100sb02_1',
            'fileName': name}
    # ⭐ 若 7-2 有撈到 fm_fileDownload 的 input,改用官方給的欄位(⛔ 官方 > 我的猜測)
    # 🚨 V77.2.8 run#13 教訓:官方寫的是 `name = 'step'`(等號兩邊有空白),舊 regex 吃不到 →
    #    `got` 全空 → **靜默退回我猜的 filePath** → 下面四筆全部「下載失敗」,
    #    而那測的是我的猜測**不是**官方欄位(陷阱 #40:檢查工具本身沒有鑑別力)。
    #    → 解析不到一律大聲說出來,⛔ 不可讓它看起來像「官方也不行」。
    parsed_from_form = False
    for f in forms:
        if 'fm_fileDownload' in f or 'fileDownload' in f:
            got = {}
            for tag in re.findall(r'<input[^>]*>', f, flags=re.I):
                n = re.search(r'name\s*=\s*[\'"]([^\'"]*)', tag)
                v = re.search(r'value\s*=\s*[\'"]([^\'"]*)', tag)
                if n:
                    got[n.group(1)] = v.group(1) if v else ''
            if got:
                got['fileName'] = name
                base = got
                parsed_from_form = True
                ac = re.search(r'action\s*=\s*[\'"]([^\'"]+)', f)
                if ac:
                    base['__action__'] = ac.group(1)
            break
    action = base.pop('__action__', '/server-java/FileDownLoad')
    if not action.startswith('/'):
        action = '/' + action
    print(f"  🎯 要送的欄位:{json.dumps(base, ensure_ascii=False)} ・action={action!r}")
    if not parsed_from_form:
        print("  🚨 ⛔ 上面那組是**我猜的**,不是從官方 form 解析出來的 → 下面四筆若失敗,"
              "⛔ 不可解讀成『官方不給下載』,先修解析。")
    else:
        print("  ✅ 上面那組是從官方 <form name='fm_fileDownload'> 逐欄抄來的。")

    get_ok = False
    for host in ('https://mopsov.twse.com.tw', 'https://mops.twse.com.tw'):
        for how in ('POST', 'GET'):
            url = host + action
            try:
                if how == 'POST':
                    r = _post(url, data=base, headers={'Referer': f'{host}/mops/web/t100sb02_1'}, timeout=30)
                else:
                    r = _get(url + '?' + '&'.join(f'{k}={v}' for k, v in base.items()),
                             headers={'Referer': f'{host}/mops/web/t100sb02_1'}, timeout=30)
                body = r.content or b''
                ct = (r.headers.get('content-type') or '')[:45]
                cd = (r.headers.get('content-disposition') or '')[:90]
                ispdf = body[:8].startswith(b'%PDF-')
                print(f"    {how:<4} {host:<32} HTTP {r.status_code} ・{ct} ・CD={cd!r} ・{len(body)} bytes ・前8bytes={body[:8]!r} ・是PDF={ispdf}")
                if not ispdf and body[:400]:
                    print(f"        ↳ 前 200 字:{body[:200]!r}")
                if ispdf and how == 'GET':
                    get_ok = True
                    print(f"        ⭐ 這一條可直接當 <a href>:{url}?{'&'.join(f'{k}={v}' for k, v in base.items())}")
            except Exception as e:
                print(f"    {how:<4} {host:<32} ❌ {type(e).__name__}: {str(e)[:120]}")

    print("\n  " + "─" * 66)
    print(f"  ⭐ 決定性結論 ── GET 可直接開嗎?{'✅ 可以(前端用 <a href>,網址也可以餵給外部 AI)' if get_ok else '❌ 不行(只能隱藏表單 POST 開新分頁;外部 AI 讀不到這份 PDF)'}")
    print("  " + "─" * 66)


def main():
    print(f"🎤 confcall_probe 開跑(今天 {TODAY},窗口 −{PAST} ~ +{FUTURE} 天)")
    ctrl = probe_control()
    probe_twse_candidates()
    probe_twse_catalog()
    probe_tpex()
    probe_mops()
    probe_file_download()
    print("\n" + "=" * 72)
    print("📋 決策表(給下一步寫 confcall_miner 用;⛔ 樣本列要逐字貼進測試)")
    print("=" * 72)
    if not ctrl:
        print("  ❌ 對照組沒通 → 這一輪**全部**不可解讀,換時間再跑一次。")
    if not DECISION:
        print("  ❌ 沒有任何來源回 JSON 列表。看上面每一筆的 content-type / 前 200 字判斷是被擋還是名字錯。")
    for tag, d in DECISION:
        print(f"  ・{tag}:{d['n']} 列 ・範圍 {d['range']} ・窗內 {d['win']} ・擇要 {d['with_sum']} ・檔案 {d['with_files']}")
        print(f"      日期={d['date']!r} 代號={d['code']!r} 名稱={d['name']!r} 時間={d['time']!r} 地點={d['place']!r} 擇要={d['sum']!r} 檔案={d['files']}")
    print("\n✅ 探針結束(只讀,沒寫任何檔)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
