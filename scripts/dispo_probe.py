#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🚨 處置/注意股「歷史事件」探針(V74.4.2)—— 回答「官方名單的歷史抓不抓得到」

背景:使用者要「進處置 / 進注意股」的**事件回測**(還要用前幾天漲跌當條件)。
但 `data/disposition.json` 只有 42 筆、回溯 1 個月(miner 只取 120 天再過濾成「處置中+剛出關」),
`attention_status.json` 是純快照 → 本地資料**完全不夠**做六關回測。

這支一次問完三件事(⭐ 探針先行鐵則 —— 沙箱連不到 FinMind/TWSE,只能上 Actions 驗):
  ① FinMind `TaiwanStockDispositionSecuritiesPeriod` 給 start_date 能回溯多深?
     (miner 實測 120 天窗口有資料 → 上游很可能有多年;含上市+上櫃)
  ② 注意股歷史:TWSE `rwd/zh/announcement/notice` 查詢端點吃不吃日期區間?回溯多深?
     (OpenAPI 的 notetrans 只有「今天的快照」;rwd 是官網「注意股票資訊」查詢頁背後的 API)
     ⚠️ TPEx 整站對 GitHub runner 回 403(V73.6.1 實測)→ 上櫃注意股不用試,誠實缺席。
  ③ FinMind 有沒有注意股 dataset?(候選名全試 + datalist 掃描)

輸出:摘要 + **壓縮事件 dump**(D|/N| 行)印進 log —— 之後本地回測直接從 job log 收,
⛔ 不寫任何檔案、不碰任何分支。

⛔ 安全:只印「第幾把 token」,絕不印 token 值(全專案鐵律,repo 是 public)。
⭐ 對照組:清單裡放一個「本專案一直在用、已知會通」的 TWSE 端點(BFI82U)——
   它也失敗 = 這台 runner 被擋,⛔ 不是端點不存在(V73.7.7 的做法)。
"""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime

API = 'https://api.finmindtrade.com/api/v4/data'
# ⛔ 不可用 .strip() —— 金鑰中間常夾空白(V73.2.7 教訓)
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
TOK_STAT = {}


def classify(msg):
    m = (msg or '').lower()
    if 'illegal' in m or 'invalid token' in m:
        return 'bad_token'
    if 'level is register' in m or 'update your user level' in m:
        return 'free_tier'
    if 'limit' in m or 'too many' in m or '402' in m:
        return 'quota'
    return 'other'


def fm(dataset, extra=None, timeout=90):
    """FinMind 取數:每一把 token 都試過才放棄(V72.5.3 教訓);400 原因在 body(V73 探針教訓)。"""
    tries = max(1, len(TOKENS))
    last = 'no-token'
    for k in range(tries):
        q = {'dataset': dataset}
        q.update(extra or {})
        if TOKENS:
            q['token'] = TOKENS[k]
        url = API + '?' + urllib.parse.urlencode(q)
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                j = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                raw = e.read().decode('utf-8', 'replace')[:200]
                raw = str((json.loads(raw) or {}).get('msg') or raw)[:160]
            except Exception:
                raw = ''
            cls = classify(raw)
            TOK_STAT.setdefault(k + 1, {}).setdefault(cls, 0)
            TOK_STAT[k + 1][cls] = TOK_STAT[k + 1][cls] + 1
            last = f'第{k+1}把/HTTP {e.code}/{cls}/{raw}'
            continue
        except Exception as e:
            last = f'第{k+1}把/{type(e).__name__}: {str(e)[:100]}'
            continue
        if not isinstance(j, dict) or j.get('status') not in (200, None):
            msg = str((j or {}).get('msg'))[:160]
            cls = classify(msg)
            TOK_STAT.setdefault(k + 1, {}).setdefault(cls, 0)
            TOK_STAT[k + 1][cls] = TOK_STAT[k + 1][cls] + 1
            last = f"第{k+1}把/status={(j or {}).get('status')}/{cls}/{msg}"
            continue
        return (j.get('data') or []), None
    return None, f'{tries} 把全失敗;最後 → {last}'


def http_json(url, timeout=45):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode('utf-8', 'replace')
        ct = r.headers.get('content-type', '')
    try:
        return json.loads(body), ct, None
    except Exception as e:
        # 陷阱 #23:不存在的路徑常回 200 + HTML → 印 content-type + 開頭才分得出來
        return None, ct, f'{type(e).__name__}(ct={ct}, head={body[:80]!r})'


def roc2iso(s):
    """115/08/29 → 2026-08-29;已是西元就原樣。"""
    s = str(s or '').strip()
    m = re.match(r'^(\d{2,3})/(\d{1,2})/(\d{1,2})$', s)
    if m:
        return f'{int(m.group(1)) + 1911}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    m = re.match(r'^(\d{4})[-/](\d{1,2})[-/](\d{1,2})', s)
    if m:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    return ''


def main():
    print(f'🔑 token:{len(TOKENS)} 把(只報序號不印值)')

    # ───── 對照組:已知會通的 TWSE 端點(它也掛 = runner 被擋,下面的失敗不能解讀成「沒有」)─────
    j, ct, err = None, '', None
    try:
        j, ct, err = http_json('https://www.twse.com.tw/rwd/zh/fund/BFI82U?response=json')
    except Exception as e:
        err = f'{type(e).__name__}: {str(e)[:80]}'
    ctrl_ok = bool(j and j.get('stat') == 'OK')
    print(f"🆚 對照組 TWSE BFI82U:{'✅ 通' if ctrl_ok else '🚨 失敗 → runner 連不到 TWSE,下面 TWSE 的失敗不能解讀成端點不存在'}{'' if ctrl_ok else '(' + str(err) + ')'}")

    # ───── ① FinMind 處置歷史深度 ─────
    print('\n═══ ① FinMind 處置歷史(TaiwanStockDispositionSecuritiesPeriod)═══')
    rows, err = fm('TaiwanStockDispositionSecuritiesPeriod',
                   {'start_date': '2023-06-01', 'end_date': date.today().isoformat()})
    if rows is None:
        print(f'  ❌ 抓不到:{err}')
    else:
        ds = sorted({str(r.get('date') or '')[:10] for r in rows if r.get('date')})
        print(f'  ✅ {len(rows)} 列 ・公告日 {ds[0] if ds else "-"} ~ {ds[-1] if ds else "-"}')
        # 逐年分布(判斷深度夠不夠六關的「逐年同向」)
        yr = {}
        for d in ds:
            yr[d[:4]] = yr.get(d[:4], 0) + 1
        print(f'  逐年公告日數:{dict(sorted(yr.items()))}')
        # dump:D|股號|公告日|處置起|處置迄|第幾次(本地回測直接從 log 收這些行)
        print('DUMP_D_BEGIN')
        for r in rows:
            sid = str(r.get('stock_id') or '').strip()
            if not re.match(r'^\d{4,6}$', sid):
                continue
            print(f"D|{sid}|{str(r.get('date') or '')[:10]}|{str(r.get('period_start') or '')[:10]}|"
                  f"{str(r.get('period_end') or '')[:10]}|{r.get('disposition_cnt') or ''}")
        print('DUMP_D_END')

    # ───── ② TWSE 注意股歷史(rwd 查詢端點)─────
    print('\n═══ ② TWSE 注意股歷史(rwd/zh/announcement/notice)═══')
    # 先探一個月:看 fields 長相 + 吃不吃日期區間
    probe_url = ('https://www.twse.com.tw/rwd/zh/announcement/notice'
                 '?startDate=20240301&endDate=20240331&response=json')
    j, ct, err = None, '', None
    try:
        j, ct, err = http_json(probe_url)
    except Exception as e:
        err = f'{type(e).__name__}: {str(e)[:100]}'
    if not j or j.get('stat') != 'OK' or not j.get('data'):
        print(f'  ❌ 2024-03 探測失敗:stat={j.get("stat") if j else None} err={err}')
        print('  (若對照組是通的 → 這個端點格式/參數不對,把下面的 fields 樣本拿去修參數)')
        if j:
            print(f'  回應鍵:{list(j.keys())[:10]}')
    else:
        fields = j.get('fields') or []
        print(f'  ✅ 2024-03 回 {len(j["data"])} 列 ・fields={fields}')
        for smp in j['data'][:2]:
            print(f'  樣本列:{smp}')
        # 自動找欄位:代號 / 日期(找不到就只印樣本,回合 2 再修)
        i_sym = next((i for i, f in enumerate(fields) if '代號' in str(f)), None)
        i_dt = next((i for i, f in enumerate(fields) if '日期' in str(f)), None)
        if i_sym is None or i_dt is None:
            print(f'  ⚠️ 欄位自動對照失敗(i_sym={i_sym}, i_dt={i_dt})→ 用上面的樣本人工定欄位')
        else:
            # 全量:2023-06 起逐月抓(一個月一次呼叫,~28 次)
            print('DUMP_N_BEGIN')
            total = 0
            y, m = 2023, 6
            today = date.today()
            while (y, m) <= (today.year, today.month):
                ed = date(y + (m == 12), (m % 12) + 1, 1)
                url = (f'https://www.twse.com.tw/rwd/zh/announcement/notice'
                       f'?startDate={y}{m:02d}01&endDate={y}{m:02d}{(ed - date(y, m, 1)).days:02d}&response=json')
                try:
                    jj, _, _ = http_json(url)
                except Exception:
                    jj = None
                by_day = {}
                for row in (jj or {}).get('data') or []:
                    try:
                        sid = str(row[i_sym]).strip()
                        dt = roc2iso(row[i_dt])
                    except Exception:
                        continue
                    if re.match(r'^\d{4,6}$', sid) and dt:
                        by_day.setdefault(dt, []).append(sid)
                for dt in sorted(by_day):
                    print(f'N|{dt}|{",".join(by_day[dt])}')
                    total += len(by_day[dt])
                y, m = (y + 1, 1) if m == 12 else (y, m + 1)
                import time as _t
                _t.sleep(1.2)   # 官網查詢端點,禮貌節流
            print('DUMP_N_END')
            print(f'  📊 注意股事件合計:{total} 筆(上市;⚠️ TPEx 對 runner 403 → 上櫃缺席,誠實限制)')

    # ───── ③ FinMind 注意股 dataset 候選 ─────
    print('\n═══ ③ FinMind 注意股 dataset 候選 ═══')
    for name in ('TaiwanStockMarketNotice', 'TaiwanStockNotice',
                 'TaiwanStockAttention', 'TaiwanStockNoticeInfo'):
        rows, err = fm(name, {'start_date': '2026-08-01', 'end_date': '2026-08-29'}, timeout=45)
        print(f'  {name}: ' + (f'✅ {len(rows)} 列;樣本鍵={list(rows[0].keys()) if rows else "空"}'
                               if rows is not None else f'❌ {err}'))
    # datalist 掃描(讓官方自己說有哪些 —— V71.3.4 的做法)
    try:
        j, ct, err = http_json('https://api.finmindtrade.com/api/v4/datalist', timeout=45)
        if isinstance(j, list):
            hit = [x for x in j if re.search(r'notice|attention|disposition|punish', str(x), re.I)]
            print(f'  datalist:{len(j)} 個 dataset;含 notice/attention/disposition 的 → {hit}')
        else:
            print(f'  datalist:非清單(ct={ct} err={err})')
    except Exception as e:
        print(f'  datalist:失敗 {type(e).__name__}: {str(e)[:80]}')

    print('\n📊 token 分類統計(只列序號):')
    for i in sorted(TOK_STAT):
        print(f'  第{i}把:{TOK_STAT[i]}')
    print('done', datetime.utcnow().isoformat() + 'Z')


if __name__ == '__main__':
    main()
