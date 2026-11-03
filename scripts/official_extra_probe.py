#!/usr/bin/env python3
"""🔭 新官方資料探路(評估紀錄 52:20 個開源專案對照,使用者:「可以做的都做」)。

為什麼要有這支:參考專案(twjackysu/TWSEMCPServer,MIT)用到幾個本站沒用過的**免費官方**網址,
其中「上櫃注意股」是本站 V67.10 試了 11 個網址都 404、`otc_attention` 一直是空的那一塊。
⚠️ 雲端工作階段連不到證交所 / 櫃買 / 期交所 → 只能在 GitHub Actions 跑,log 說了算。

只讀:⛔ 不寫任何分支、不寫任何資料檔;結果印在 log + job summary(公開行情,列數 / 欄位 / 前兩列)。
三種結論分開(陷阱 #23):連不上(例外)/ 被擋(403、429、回 HTML 擋頁)/ 格式不同(200 但不是預期格式)。
⛔ 不偽裝瀏覽器(V80.1.6 決策):UA 寫明是誰,被擋就記下來,⛔ 不換 UA 再試。
⛔ 不用金鑰。每個主機之間至少隔 1 秒(證交所 www 隔 3 秒 —— 它對短時間大量請求會暫時封 IP)。

段落:
 ① 上櫃注意股 tpex_trading_warning_information(V67.10 沒試過這個)+ 上櫃處置(對照組)
    + 上市注意 notetrans / notice(現在用 notetrans,10/29 只有 2 檔 → 順便看哪個才是每天的注意名單)
 ② 上市風險名單 OpenAPI:BFI84U 停資停券預告、TWT85U 變更交易、TWTBAU1 暫停先賣後買當沖、BFZFZU_T 理財節目異常推介
 ③ 休市日 holidaySchedule(今年 / 明年有沒有)
 ④ 鉅額 BFIAUU、借券 TWT93U:最近一個交易日 + 歷史抽樣(最早到哪年、欄位哪天變)
 ⑤ 外資持股 MI_QFIIS(上市)/ insti/qfii(上櫃):最近一天 + 一個舊日期(只確認格式;研究用歷史 FinMind 已有)
 ⑥ 期交所三大法人選擇權(TXO):optContractsDateDown、callsAndPutsDateDown —— 最近、1 / 3 / 5 年前(參考專案說約保留 3 年)
 ⑦ 期交所官方查詢頁的表單欄位
 ⑧ 上市注意股:OpenAPI notice / notetrans 連續 4 次都 0 檔(11/02 13:12、17:51、18:48,11/03 03:08;同時上櫃有 13 檔)
    → OpenAPI 的網址清單(swagger.json)有沒有改名 + 跟證交所官網同一份名單(rwd announcement/notice)比;
    處置 punish 當對照(OpenAPI 那份有資料)。官網只問 4~5 次。

跑法:python3 scripts/official_extra_probe.py [--selftest]
      WHICH=notice python3 scripts/official_extra_probe.py   ← 只跑 ⑧(⛔ 打到鉅額 / 借券 / 期交所那些)
"""
import csv
import io
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlsplit

UA = 'Mozilla/5.0 (compatible; StockAI-DB official_extra_probe/1.0; +https://github.com/xin7355-collab/stockai-db)'
GAP = {'www.twse.com.tw': 3.0}          # 其他主機 1 秒
BACKOFF = (2, 4, 8, 16)                  # 連線失敗 / 429 / 5xx 才重試;403 ⛔ 不重試(那是擋,不是忙)
OUT = []                                 # job summary 用
TALLY = []                               # (段落, 名稱, 結論, 說明)
_last = {}


def say(s=''):
    print(s, flush=True)
    OUT.append(s)


def _strip_html(t: str) -> str:
    """擋頁 / 錯誤頁只留文字開頭(⛔ 先去標籤再壓空白,不然標籤之間的空白會變一堆)。"""
    t = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', t, flags=re.S | re.I)
    t = re.sub(r'<[^>]+>', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def fetch(url, method='GET', params=None, data=None, timeout=40):
    """回 (response 或 Exception, 秒數, 第幾次)。只在連線失敗 / 429 / 5xx 時退避重試。"""
    import requests
    host = urlsplit(url).netloc
    for i in range(len(BACKOFF) + 1):
        wait = GAP.get(host, 1.0) - (time.time() - _last.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        t0 = time.time()
        try:
            r = requests.request(method, url, params=params, data=data, timeout=timeout,
                                 headers={'User-Agent': UA, 'Accept': '*/*'})
            res = r
        except Exception as e:  # noqa: BLE001
            res = e
        _last[host] = time.time()
        dt = time.time() - t0
        retry = isinstance(res, Exception) or res.status_code == 429 or res.status_code >= 500
        if not retry or i == len(BACKOFF):
            return res, dt, i + 1
        say(f'    ↻ 第 {i + 1} 次{"連線失敗 " + type(res).__name__ if isinstance(res, Exception) else " HTTP " + str(res.status_code)}'
            f' → 等 {BACKOFF[i]} 秒再試')
        time.sleep(BACKOFF[i])
    return res, dt, len(BACKOFF) + 1


def classify(res):
    """→ (結論, 說明)。結論:ok / empty / blocked / down / format。"""
    if isinstance(res, Exception):
        return 'down', f'連不上 {type(res).__name__}'
    code = res.status_code
    ctype = (res.headers.get('content-type') or '').lower()
    if code in (401, 403, 429):
        return 'blocked', f'HTTP {code}:{_strip_html(res.text)[:100]}'
    if code == 404:
        return 'format', 'HTTP 404(網址不存在)'
    if code != 200:
        return 'format', f'HTTP {code}'
    body = res.content.lstrip()[:20].lower()
    if body.startswith(b'<') or 'html' in ctype:
        return 'blocked', f'回 HTML({_strip_html(res.text)[:100]})'
    return 'ok', ''


def rows_of(obj):
    """JSON → (列數, 欄位, 前兩列, 補充)。三種形狀:OpenAPI list / rwd {stat,fields,data} / {tables:[...]}。"""
    if isinstance(obj, list):
        keys = list(obj[0].keys()) if obj and isinstance(obj[0], dict) else []
        return len(obj), keys, obj[:2], ''
    if isinstance(obj, dict):
        if isinstance(obj.get('tables'), list):
            tb = [t for t in obj['tables'] if isinstance(t, dict)]
            first = tb[0] if tb else {}
            n = sum(len(t.get('data') or []) for t in tb)
            extra = f"stat={obj.get('stat')} date={obj.get('date')} 表 {len(tb)} 張:" + '、'.join(
                f"{str(t.get('title') or '')[:24]}({len(t.get('data') or [])})" for t in tb[:4])
            return n, list(first.get('fields') or []), list(first.get('data') or [])[:2], extra
        data = obj.get('data') or obj.get('aaData') or []
        extra = f"stat={obj.get('stat')} date={obj.get('date')} title={str(obj.get('title') or '')[:40]}"
        if obj.get('groups'):
            extra += ' groups=' + '/'.join(f"{g.get('title')}×{g.get('span')}" for g in obj['groups'] if isinstance(g, dict))
        return len(data), list(obj.get('fields') or []), list(data)[:2], extra
    return 0, [], [], f'不認得的 JSON 形狀 {type(obj).__name__}'


def parse_taifex_csv(body: bytes):
    """期交所下載頁:cp950 CSV;沒資料 / 被拒是 HTML。→ (header, rows) 或 None。"""
    text = body.decode('cp950', errors='replace')
    if 'DateTime error' in text or text.lstrip().startswith('<'):
        return None
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        return None
    header = [h.strip() for h in rows[0]]
    data = [r for r in rows[1:] if len(r) >= max(len(header) - 1, 1) and r[0].strip()]
    return (header, data) if data else None


def otc_sym_ok(s):
    s = str(s or '').strip()
    return (s.isdigit() and len(s) == 4) or (s.startswith('00') and len(s) == 5 and s.isdigit())


def probe_json(sec, name, url, params=None, show=True):
    res, dt, n_try = fetch(url, params=params)
    verdict, why = classify(res)
    size = '' if isinstance(res, Exception) else f'{len(res.content) // 1024} KB、'
    say(f'- **{name}** {"" if isinstance(res, Exception) else "HTTP " + str(res.status_code)}、{size}{dt:.1f}s'
        f'{"、試了 " + str(n_try) + " 次" if n_try > 1 else ""}')
    obj = None
    if verdict == 'ok':
        try:
            obj = res.json()
        except ValueError:
            verdict, why = 'format', f'不是 JSON(開頭 {res.text[:60]!r})'
    if obj is not None:
        n, keys, first, extra = rows_of(obj)
        if extra:
            say(f'  - {extra}')
        say(f'  - 列數 {n}、欄位 {keys[:16]}')
        if show:
            for r in first:
                say(f'  - 例:{json.dumps(r, ensure_ascii=False)[:300]}')
        if n == 0:
            verdict, why = 'empty', '通了但 0 列'
    if why:
        say(f'  - → {verdict}:{why}')
    TALLY.append((sec, name, verdict, why))
    return obj, verdict


def walk_recent(url, base_params, today, max_back=10):
    """從今天往回找第一個 stat=OK 而且有資料的交易日 → (YYYYMMDD, obj) 或 (None, None)。"""
    for k in range(max_back):
        d = (today - timedelta(days=k))
        if d.weekday() >= 5:
            continue
        ds = d.strftime('%Y%m%d')
        res, _, _ = fetch(url, params={**base_params, 'date': ds})
        if classify(res)[0] != 'ok':
            return None, None
        try:
            obj = res.json()
        except ValueError:
            return None, None
        if str(obj.get('stat', '')).upper() == 'OK' and (obj.get('data') or obj.get('tables')):
            return ds, obj
    return None, None


def probe_rwd_series(sec, name, url, base_params, dates):
    """歷史抽樣:每個日期遇到沒開市就往後試 2 天。只印列數 + 欄位數(+ 欄位名有變才印)。"""
    last_fields = None
    for ds in dates:
        d0 = datetime.strptime(ds, '%Y%m%d').date()
        got = False
        for k in range(3):
            d = (d0 + timedelta(days=k)).strftime('%Y%m%d')
            res, dt, _ = fetch(url, params={**base_params, 'date': d})
            verdict, why = classify(res)
            if verdict != 'ok':
                say(f'  - {d}:{verdict} {why}')
                TALLY.append((sec, f'{name} {d}', verdict, why))
                got = True
                break
            try:
                obj = res.json()
            except ValueError:
                say(f'  - {d}:不是 JSON')
                TALLY.append((sec, f'{name} {d}', 'format', '不是 JSON'))
                got = True
                break
            n, fields, first, extra = rows_of(obj)
            if n == 0:
                continue
            msg = f'  - {d}:{n} 列、{len(fields)} 欄({dt:.1f}s)'
            if fields != last_fields:
                msg += f' 欄位 {fields}'
                last_fields = fields
            say(msg)
            if first:
                say(f'    例:{json.dumps(first[0], ensure_ascii=False)[:220]}')
            TALLY.append((sec, f'{name} {d}', 'ok', f'{n} 列'))
            got = True
            break
        if not got:
            say(f'  - {ds}(+2 天):都沒資料(stat 非 OK 或 0 列)')
            TALLY.append((sec, f'{name} {ds}', 'empty', '連 3 天都沒資料'))


def probe_taifex(sec, page, start, end, commodity='TXO'):
    url = f'https://www.taifex.com.tw/cht/3/{page}'
    form = {'queryStartDate': start.strftime('%Y/%m/%d'), 'queryEndDate': end.strftime('%Y/%m/%d'),
            'commodityId': commodity}
    res, dt, _ = fetch(url, method='POST', data=form)
    tag = f'{page} {form["queryStartDate"]}~{form["queryEndDate"]}'
    if isinstance(res, Exception):
        say(f'  - {tag}:連不上 {type(res).__name__}')
        TALLY.append((sec, tag, 'down', type(res).__name__))
        return None
    if res.status_code != 200:
        verdict, why = classify(res)
        say(f'  - {tag}:{verdict} {why}')
        TALLY.append((sec, tag, verdict, why))
        return None
    parsed = parse_taifex_csv(res.content)
    if parsed is None:
        # 🆕 第三輪:期交所拒絕的理由在 DOCTYPE / head 後面 → 去掉那兩段再壓空白(第二輪 200 字只印到 head)
        raw = res.content.decode('cp950', errors='replace')
        raw = re.sub(r'<!DOCTYPE[^>]*>|<head>.*?</head>', ' ', raw, flags=re.S | re.I)
        txt = re.sub(r'\s+', ' ', raw).strip()[:400]
        say(f'  - {tag}:回 HTML / 沒資料({len(res.content)} B、{dt:.1f}s):{txt}')
        TALLY.append((sec, tag, 'empty', f'HTML:{txt[:40]}'))
        return None
    header, rows = parsed
    days = sorted({r[0].strip() for r in rows})
    say(f'  - {tag}:{len(rows)} 列、{len(days)} 天({days[0]}~{days[-1]})、{dt:.1f}s')
    say(f'    欄位 {header}')
    say(f'    例:{rows[0]}')
    TALLY.append((sec, tag, 'ok', f'{len(rows)} 列 {len(days)} 天'))
    return parsed


def rwd_by_date(obj):
    """證交所官網公告表 {fields, data} → ([(日期, 列數)], 有代號的列數)。
    日期欄 = 欄位名有「日期」的第一欄;代號欄 = 欄位名有「代號」的第一欄(⛔ 寫死第幾欄:官網改版會換位置)。"""
    fields = [str(f) for f in (obj.get('fields') or [])] if isinstance(obj, dict) else []
    data = (obj.get('data') or []) if isinstance(obj, dict) else []
    di = next((i for i, f in enumerate(fields) if '日期' in f), None)
    ci = next((i for i, f in enumerate(fields) if '代號' in f), None)
    cnt, coded = {}, 0
    for r in data:
        if not isinstance(r, list):
            continue
        if di is not None and len(r) > di:
            k = str(r[di]).strip()
            cnt[k] = cnt.get(k, 0) + 1
        if ci is not None and len(r) > ci and otc_sym_ok(r[ci]):
            coded += 1
    return sorted(cnt.items()), coded


def probe_notice(tw_today):
    """⑧ 上市注意股:OpenAPI vs 官網(見檔頭)。官網最多問 4 次、間隔照 GAP(3 秒)。"""
    say('\n## ⑧ 上市注意股:OpenAPI vs 證交所官網')
    res, dt, _ = fetch('https://openapi.twse.com.tw/v1/swagger.json')
    verdict, why = classify(res)
    sw = None
    if verdict == 'ok':
        try:
            sw = res.json()
        except ValueError:
            verdict, why = 'format', '不是 JSON'
    if isinstance(sw, dict):
        paths = sw.get('paths') or {}
        hits = []
        for p, ops in paths.items():
            summ = ' '.join(str(op.get('summary') or '') for op in (ops or {}).values() if isinstance(op, dict))
            if 'announcement' in p.lower() or '注意' in summ or '處置' in summ:
                hits.append((p, summ[:50]))
        say(f'- **OpenAPI swagger.json**:{len(paths)} 個網址;跟公告 / 注意 / 處置有關的 {len(hits)} 個')
        for p, s in hits[:40]:
            say(f'  - `{p}` {s}')
        TALLY.append(('⑧', 'swagger.json', 'ok', f'{len(hits)} 個相關網址'))
    else:
        say(f'- **OpenAPI swagger.json**:{verdict} {why}')
        TALLY.append(('⑧', 'swagger.json', verdict, why))

    for slug in ('notice', 'notetrans'):
        obj, _v = probe_json('⑧', f'OpenAPI announcement/{slug}', f'https://openapi.twse.com.tw/v1/announcement/{slug}',
                             show=False)
        if isinstance(obj, list):
            real = [r for r in obj if isinstance(r, dict) and otc_sym_ok(r.get('Code'))]
            say(f'  - 有代號的 {len(real)} 列 / 全部 {len(obj)} 列;前 2 列原樣:'
                f'{json.dumps(obj[:2], ensure_ascii=False)[:400]}')

    # 官網:一次問最近 8 天(白天 / 凌晨問,當天的可能還沒公告 → 要看得到前一個交易日)
    d0, d1 = (tw_today - timedelta(days=7)).strftime('%Y%m%d'), tw_today.strftime('%Y%m%d')
    full = {'querytype': '1', 'stockNo': '', 'selectType': '', 'proceType': '', 'startDate': d0, 'endDate': d1,
            'sortKind': 'STKNO', 'response': 'json'}
    plain = {'startDate': d0, 'endDate': d1, 'response': 'json'}
    for slug, what, variants in (('notice', '公布注意', (full, plain)),
                                 ('punish', '公布處置(對照:OpenAPI 那份有資料)', (plain,)),
                                 ('notetrans', '公布注意累計次數異常', (plain,))):
        for params in variants:
            obj, v = probe_json('⑧', f'官網 rwd announcement/{slug}({what})參數 {sorted(params)}',
                                f'https://www.twse.com.tw/rwd/zh/announcement/{slug}', params=params)
            if v == 'blocked':
                say('  - 🚦 官網擋了 → 這段後面的 ⛔ 再問')
                return
            if isinstance(obj, dict):
                by, coded = rwd_by_date(obj)
                say(f'  - 有代號的 {coded} 列;依日期 {by[-6:]}')
                if str(obj.get('stat', '')).upper() == 'OK' and obj.get('data'):
                    break       # 這組參數有資料 → 不用再試下一組


def finish():
    say('\n## 📋 總表')
    cnt = {}
    for sec, name, verdict, why in TALLY:
        cnt[verdict] = cnt.get(verdict, 0) + 1
        say(f'- {sec} {name}:{verdict}{" — " + why if why else ""}')
    say(f'\n合計:{cnt}(ok = 抓得到、empty = 通了但沒資料、blocked = 被擋、down = 連不上、format = 網址或格式不對)')
    summ = os.environ.get('GITHUB_STEP_SUMMARY')
    if summ:
        with open(summ, 'a', encoding='utf-8') as f:
            f.write('\n'.join(OUT) + '\n')
    return 0


def main():
    tw_today = datetime.now(timezone(timedelta(hours=8))).date()
    say(f'# 🔭 新官方資料探路({tw_today},UA 寫明身分,⛔ 不偽裝瀏覽器)')
    if (os.environ.get('WHICH') or 'all').strip() == 'notice':
        probe_notice(tw_today)
        return finish()

    say('\n## ① 注意 / 處置名單')
    warn, v = probe_json('①', '上櫃注意 tpex_trading_warning_information',
                         'https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information')
    if isinstance(warn, list):
        codes = [str(r.get('SecuritiesCompanyCode') or '').strip() for r in warn if isinstance(r, dict)]
        good = [c for c in codes if otc_sym_ok(c)]
        say(f'  - 代號 {len(codes)} 個,其中 radar_miner 會收的(4 碼 / 00 開頭 5 碼){len(good)} 個:{good[:12]}')
        dates = {}
        for r in warn:
            if isinstance(r, dict):
                k = str(r.get('Date') or r.get('date') or '?')
                dates[k] = dates.get(k, 0) + 1
        say(f'  - 日期欄分布:{sorted(dates.items())[-5:]}')
    probe_json('①', '上櫃處置 tpex_disposal_information(對照,現在在用)',
               'https://www.tpex.org.tw/openapi/v1/tpex_disposal_information', show=False)
    for slug in ('notetrans', 'notice', 'punish'):
        obj, _v = probe_json('①', f'上市 announcement/{slug}', f'https://openapi.twse.com.tw/v1/announcement/{slug}')
        # 🆕 第二輪:notice / notetrans 每一列都印(要比「當天公布注意股」是哪一個名單;第一輪 13:12 兩個都是空白佔位)
        if slug != 'punish' and isinstance(obj, list):
            for r in obj[:40]:
                if isinstance(r, dict):
                    say(f"    {r.get('Code')} {r.get('Name')} {r.get('Date', '')} "
                        f"{str(r.get('TradingInfoForAttention') or r.get('RecentlyMetAttentionSecuritiesCriteria') or '')[:60]}")

    say('\n## ② 上市風險名單(OpenAPI)')
    for path, what in (('exchangeReport/BFI84U', '停資停券預告'), ('exchangeReport/TWT85U', '變更交易'),
                       ('exchangeReport/TWTBAU1', '暫停先賣後買當沖'), ('Announcement/BFZFZU_T', '理財節目異常推介')):
        probe_json('②', f'{what} {path}', f'https://openapi.twse.com.tw/v1/{path}')

    say('\n## ③ 休市日')
    hol, v = probe_json('③', 'holidaySchedule', 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule',
                        show=False)
    if isinstance(hol, list) and hol:
        ds = sorted(str(r.get('Date') or '') for r in hol if isinstance(r, dict))
        say(f'  - Date 範圍 {ds[0]} ~ {ds[-1]}(共 {len(ds)} 列)')
        for r in hol[:40]:
            if isinstance(r, dict):
                say(f'    {r.get("Date")} {r.get("Name")} {str(r.get("Description") or "")[:40]}')

    say('\n## ④ 鉅額 / 借券(證交所 rwd)')
    bf_url = 'https://www.twse.com.tw/rwd/zh/block/BFIAUU'
    day, obj = walk_recent(bf_url, {'response': 'json'}, tw_today)
    if day:
        n, fields, first, extra = rows_of(obj)
        say(f'- **BFIAUU 最近交易日 {day}**:{n} 列、欄位 {fields}、{extra}')
        for r in first:
            say(f'  - 例:{r}')
        tail = (obj.get('data') or [])[-1:]
        say(f'  - 最後一列(參考專案說是「總計」):{tail}')
        TALLY.append(('④', f'BFIAUU {day}', 'ok', f'{n} 列'))
    else:
        say('- **BFIAUU 最近 10 天**:找不到有資料的一天(看上面 ↻ / 結論)')
        TALLY.append(('④', 'BFIAUU 最近', 'empty', '10 天內沒有 stat=OK'))
    say('- BFIAUU 歷史抽樣(參考專案:2005-04-04 起;2011-12-16 前多一欄「交割期別」)')
    probe_rwd_series('④', 'BFIAUU', bf_url, {'response': 'json'},
                     ['20050406', '20080618', '20111214', '20111220', '20160615', '20210616'])
    t93 = 'https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U'
    say('- TWT93U 最近 + 歷史抽樣(參考專案:2005-07-01 起;2012-03-19 借券欄位改版)')
    probe_rwd_series('④', 'TWT93U', t93, {'response': 'json', 'selectType': 'ALL'},
                     [day or tw_today.strftime('%Y%m%d'), '20050706', '20090617', '20120315', '20120320', '20160615'])

    say('\n## ⑤ 外資持股(只確認格式)')
    probe_rwd_series('⑤', 'MI_QFIIS', 'https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS',
                     {'response': 'json', 'selectType': 'ALLBUT0999'}, [day or tw_today.strftime('%Y%m%d'), '20150617'])
    probe_json('⑤', '上櫃 insti/qfii(不帶日期 = 最新)', 'https://www.tpex.org.tw/www/zh-tw/insti/qfii',
               params={'response': 'json'})
    probe_json('⑤', '上櫃 insti/qfii 2015/06/17', 'https://www.tpex.org.tw/www/zh-tw/insti/qfii',
               params={'response': 'json', 'date': '2015/06/17'}, show=False)

    say('\n## ⑥ 期交所三大法人選擇權(TXO)')
    # 🆕 第二輪:第一輪「結束日 = 今天」的兩段都回 HTML、1 年前那段有資料、3 年前那段(起日剛好跨過 3 年)回 HTML
    #   → 這輪結束日改成昨天,3 年那段往內縮 10 天,另外量 2 年前與 60 天長區間
    yday = tw_today - timedelta(days=1)
    for page in ('optContractsDateDown', 'callsAndPutsDateDown'):
        say(f'- **{page}**')
        probe_taifex('⑥', page, yday - timedelta(days=6), yday)
        probe_taifex('⑥', page, yday - timedelta(days=60), yday)
        for d0 in (tw_today - timedelta(days=365 * 2 + 7), tw_today - timedelta(days=365 * 3 - 10)):
            probe_taifex('⑥', page, d0, d0 + timedelta(days=7))

    # 🆕 第三輪:最近兩個月用 queryStartDate / queryEndDate 查都回 HTML,一年前、三年內的卻查得到
    #   → 讀官方查詢頁本身的 <form>(action / 欄位名 / 預設值),看最近的資料要用哪一種表單(⛔ 猜欄位名)
    say('\n## ⑦ 期交所官方查詢頁的表單欄位')
    for page in ('callsAndPutsDate', 'optContractsDate'):
        url = f'https://www.taifex.com.tw/cht/3/{page}'
        res, dt, _ = fetch(url)
        if isinstance(res, Exception) or res.status_code != 200:
            say(f'- {page}:{classify(res)}')
            TALLY.append(('⑦', page, classify(res)[0], classify(res)[1]))
            continue
        html = res.content.decode('utf-8', errors='replace')
        forms = re.findall(r'<form\b[^>]*>.*?</form>', html, flags=re.S | re.I)
        say(f'- **{page}** HTTP 200、{len(res.content) // 1024} KB、表單 {len(forms)} 個')
        for f in forms[:4]:
            act = re.search(r'action="([^"]*)"', f)
            fields = re.findall(r'<(?:input|select)\b[^>]*\bname="([^"]+)"[^>]*?(?:value="([^"]*)")?', f, flags=re.I)
            say(f'  - action={act.group(1) if act else "?"} 欄位={[(n, v[:20]) for n, v in fields][:20]}')
        TALLY.append(('⑦', page, 'ok', f'表單 {len(forms)} 個'))

    probe_notice(tw_today)
    return finish()


def selftest():
    """離線自我測試(⛔ 不連網)。"""
    fails = []

    def ok(name, cond, got=''):
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {got}'))
        if not cond:
            fails.append(name)

    class R:
        def __init__(self, code, body=b'', ctype='application/json'):
            self.status_code, self.content, self.headers = code, body, {'content-type': ctype}
            self.text = body.decode('utf-8', errors='replace')

        def json(self):
            return json.loads(self.text)

    ok('① 連不上 → down', classify(ConnectionError('x'))[0] == 'down')
    ok('② 403 → blocked(⛔ 不可當成「網址不對」)', classify(R(403, b'<html>Forbidden</html>'))[0] == 'blocked')
    ok('③ 200 但回 HTML → blocked', classify(R(200, b'  <!DOCTYPE html><p>x</p>', 'text/html'))[0] == 'blocked')
    ok('④ 404 → format', classify(R(404))[0] == 'format')
    ok('⑤ 200 JSON → ok', classify(R(200, b'[{"a":1}]'))[0] == 'ok')
    n, keys, first, _ = rows_of([{'SecuritiesCompanyCode': '6488', 'CompanyName': 'x'}, {}])
    ok('⑥ OpenAPI list → 列數 / 欄位', n == 2 and keys == ['SecuritiesCompanyCode', 'CompanyName'], (n, keys))
    n, keys, first, extra = rows_of({'stat': 'OK', 'date': '20250103', 'fields': ['證券代號', '成交股數'],
                                     'data': [['2308', '1'], ['總計', '9']]})
    ok('⑦ rwd {stat,fields,data}', n == 2 and keys[0] == '證券代號' and 'stat=OK' in extra, (n, keys, extra))
    n, keys, first, extra = rows_of({'stat': 'ok', 'date': '20250103', 'tables': [
        {'title': '僑外資持股', 'fields': ['排行', '代號'], 'data': [['1', '8455']]}, {'title': '空', 'data': []}]})
    ok('⑧ {tables:[...]} → 列數加總 + 第一張的欄位', n == 1 and keys == ['排行', '代號'] and '表 2 張' in extra,
       (n, keys, extra))
    csv_body = '日期,商品名稱,身份別,多方交易口數\r\n2026/10/30,臺指選擇權,外資,123\r\n\r\n'.encode('cp950')
    p = parse_taifex_csv(csv_body)
    ok('⑨ 期交所 cp950 CSV → 表頭 + 1 列(空白行要丟)', p and p[0][2] == '身份別' and len(p[1]) == 1, p)
    ok('⑩ 期交所回 HTML → None(⛔ 不可當成 CSV 解析)', parse_taifex_csv(b'<!DOCTYPE HTML><html>x</html>') is None)
    ok('⑪ 代號規則跟 radar_miner 一樣(4 碼 / 00 開頭 5 碼)',
       otc_sym_ok('6488') and otc_sym_ok('00679') and not otc_sym_ok('64881') and not otc_sym_ok('A123'))
    ok('⑫ 擋頁文字:先去標籤再壓空白',
       _strip_html('<p>Access</p>\n\n  <b>Denied</b><script>var a=1</script>') == 'Access Denied',
       _strip_html('<p>Access</p>\n\n  <b>Denied</b><script>var a=1</script>'))
    src = open(os.path.abspath(__file__), encoding='utf-8').read()
    ok('⑬ ⛔ 不偽裝瀏覽器:UA 寫明工具名,而且程式裡沒有 Chrome / Safari 字樣',
       'StockAI-DB official_extra_probe' in UA and 'Chrome/' not in src.replace("'Chrome/'", '')
       and 'Safari/' not in src.replace("'Safari/'", ''))
    ok('⑭ 403 不重試(只有連線失敗 / 429 / 5xx 才退避)', 'res.status_code == 429 or res.status_code >= 500' in src)

    # ⑮ 官網公告表:日期 / 代號欄用名字找
    flds = ['編號', '證券代號', '證券名稱', '累計次數', '注意交易資訊', '日期', '收盤價', '本益比']
    rows = [['1', '2330', '台積電', '1', 'x', '115/11/02', '1000', '20'],
            ['2', '6488', '環球晶', '1', 'x', '115/11/02', '400', '15'],
            ['3', '總計', '', '', '', '115/10/31', '', '']]
    by, coded = rwd_by_date({'stat': 'OK', 'fields': flds, 'data': rows})
    ok('⑮ 官網公告表 → 依日期計數 + 有代號的列數(「總計」不算)',
       by == [('115/10/31', 1), ('115/11/02', 2)] and coded == 2, (by, coded))
    perm = [5, 1, 0, 2, 3, 4, 6, 7]
    by2, coded2 = rwd_by_date({'fields': [flds[i] for i in perm], 'data': [[r[i] for i in perm] for r in rows]})
    ok('⑮b 決定性對照:欄位換位置(日期排第一)→ 結果一樣(⛔ 寫死第幾欄)', (by2, coded2) == (by, coded), (by2, coded2))

    # ⑯~⑱ 只跑 ⑧ / 官網被擋就停 / 第一組參數有資料就不試第二組(假的 fetch,⛔ 連網)
    real_fetch, saved_env = fetch, {k: os.environ.get(k) for k in ('WHICH', 'GITHUB_STEP_SUMMARY')}
    notice_ok = json.dumps({'stat': 'OK', 'fields': flds, 'data': rows[:2]}).encode()

    def run_with(which, www):
        calls = []

        def stub(url, method='GET', params=None, data=None, timeout=40):
            calls.append(url)
            if 'swagger.json' in url:
                return R(200, json.dumps({'paths': {'/announcement/notice': {'get': {'summary': '集中市場當日公布注意股票'}},
                                                    '/exchangeReport/X': {'get': {'summary': 'y'}}}}).encode()), 0.0, 1
            if 'openapi.twse.com.tw/v1/announcement/' in url:
                return R(200, b'[{"Code":"","Name":""}]'), 0.0, 1
            if 'www.twse.com.tw/rwd/zh/announcement/' in url:
                return www(url, params), 0.0, 1
            return R(404), 0.0, 1
        globals()['fetch'] = stub
        os.environ.pop('GITHUB_STEP_SUMMARY', None)
        if which is None:
            os.environ.pop('WHICH', None)
        else:
            os.environ['WHICH'] = which
        OUT.clear()
        TALLY.clear()
        try:
            with __import__('contextlib').redirect_stdout(io.StringIO()):
                main()
        finally:
            globals()['fetch'] = real_fetch
            for k, v in saved_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        www_calls = [u for u in calls if 'www.twse.com.tw/rwd/zh/announcement/' in u]
        return calls, www_calls, list(OUT)

    calls, www_calls, out = run_with('notice', lambda u, p: R(200, notice_ok))
    heavy = [u for u in calls if any(w in u for w in ('BFIAUU', 'TWT93U', 'MI_QFIIS', 'taifex', 'tpex'))]
    ok('⑯ WHICH=notice → 只跑 ⑧(⛔ 打到鉅額 / 借券 / 外資持股 / 期交所 / 櫃買),官網 3 次',
       not heavy and len(www_calls) == 3 and any('有代號的 2 列' in s for s in out), (heavy, www_calls))
    calls_all, www_all, _ = run_with(None, lambda u, p: R(200, notice_ok))
    ok('⑯b 決定性對照:沒設 WHICH → 全部段落都跑(有 BFIAUU、期交所)而且最後也跑 ⑧',
       any('BFIAUU' in u for u in calls_all) and any('taifex' in u for u in calls_all) and len(www_all) == 3,
       (len(calls_all), www_all))
    _, www_blk, out_blk = run_with('notice', lambda u, p: R(200, b'<html>blocked</html>', 'text/html'))
    ok('⑰ 官網回擋頁 → 這段後面 ⛔ 再問(只問 1 次)', len(www_blk) == 1 and any('官網擋了' in s for s in out_blk),
       www_blk)
    _, www_2, _ = run_with('notice', lambda u, p: R(200, b'{"stat":"x"}') if 'notice' in u and 'querytype' in p
                           else R(200, notice_ok))
    ok('⑱ 第一組參數沒資料 → 試第二組;第二組有資料就停(notice 2 次 + punish + notetrans = 4)',
       len(www_2) == 4 and sum('announcement/notice' in u for u in www_2) == 2, www_2)
    OUT.clear()
    TALLY.clear()
    print(f'\n{"✅ 全過" if not fails else "❌ 失敗 " + str(len(fails)) + " 條"}(共 20 條)')
    return 1 if fails else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(main())
