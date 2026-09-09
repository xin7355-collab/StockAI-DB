#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏦 集保股權分散「歷史回補」(tdcc_backfill.py) — V72.5.1(深歷史 13 週 → 104 週)

痛點:TDCC 開放資料 CSV 只給「最新一週」→ 趨勢箭頭要等下週六才有。
解法:FinMind 付費版集保歷史資料集 TaiwanStockHoldingSharesPer(同源 TDCC),
     逐檔往前抓 `BACKFILL_DAYS` 天,同一份資料寫成兩個檔:
       ・data/tdcc_holders.json  13 週  → **前端**用(每次開 App 會下載,必須小)
       ・data/tdcc_deep.json    104 週  → **只給探針/回測**用(前端⛔不 fetch)

V72.5.1 為什麼要加深(這條很重要,別再把它改回 13 週):
  「13 週」是**當初隨手設的上限,不是資料的限制**,卻讓 CLAUDE.md 裡四、五條功能
  長期卡在「樣本不足以驗證」——而加深的**API 成本是零**(一檔仍然只打一個請求,
  只是 start_date 往前推)。⛔ 唯一的代價是檔案大小,所以才拆成兩個檔。

V69.6.7 修正(首跑 50 分超時、跑完才寫檔 → 全白跑):
  ① 並行 3 工人 + 自適應限速(撞 429 全域放慢),4014 檔約 10-25 分
  ② 每 400 檔 checkpoint 寫檔 → 中途被砍也保留,重跑冪等接續(同日期不重複)
  ③ 40 分軟時限自我收工寫檔(留 10 分給部署),不再被 timeout 砍到白工
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

OUT_FILE = 'data/tdcc_holders.json'
KEEP_WEEKS = 13
# 🕳️ V72.5.1 ⭐⭐ 「13 週」一直是**我自己設的上限,不是資料的限制**。
#   CLAUDE.md 有四、五條功能卡在「tdcc 只有 13 週 → 樣本不足以驗證」:
#     兩上兩下(V71.9.0)・散戶結構(V72.4.5)・千張大戶連週增減(多空規則 C7,weight 3,**從沒驗證過**)・
#     大戶單週 ±3% 門檻(權證小哥 f49)・集保戶數(V71.9.7)。
#   而 FinMind 的 `TaiwanStockHoldingSharesPer`(跟 TDCC 同源)本來就給得出更長的歷史,
#   ⭐ **而且成本完全一樣** —— 一檔一個請求,只是 `start_date` 往前推,請求數不變。
#   ⛔ 但**不能直接把 `tdcc_holders.json` 加深** —— 前端每次開 App 會整份下載,
#      13 週已經 1.9 MB,104 週會變成約 16 MB,手機會被拖死。
#   → 分成兩個檔:`tdcc_holders.json` 給前端(維持 13 週,⛔ 行為完全不變)、
#     `tdcc_deep.json` 只給**探針/回測**用(前端⛔不 fetch)。
DEEP_FILE = 'data/tdcc_deep.json'
DEEP_WEEKS = int(os.getenv('TDCC_DEEP_WEEKS', '104'))        # 深歷史保留週數(約 2 年)
BACKFILL_DAYS = int(os.getenv('TDCC_BACKFILL_DAYS', '760'))  # 往前抓幾天(2 年 + 緩衝)
DEEP_ENOUGH = int(os.getenv('TDCC_DEEP_ENOUGH', '90'))       # 深歷史已達幾週就跳過(重跑接續用)
LONG_TIMEOUT = int(os.getenv('TDCC_TIMEOUT', '120'))         # ⚠️ 2 年 × 17 級距 ≈ 1,700 列,老牌大股回應很大,30 秒不夠
API = 'https://api.finmindtrade.com/api/v4/data'
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or os.getenv('FINMIND_TOKEN', '')).split(',') if t.strip()]
WORKERS = 3
SOFT_DEADLINE_SEC = 40 * 60      # 40 分軟時限(step timeout 50 分,留 10 分緩衝+部署)
CHECKPOINT_EVERY = 400
TW_TZ = timezone(timedelta(hours=8))

_lock = threading.Lock()
_tok_i = 0
_min_interval = 0.25             # 全域限速:每請求最小間隔(撞 429 自動加大)
_last_req_ts = 0.0


def _norm(lv: str) -> str:
    return str(lv).replace(',', '').replace(' ', '').lower()


RETAIL = {'1-999', '1000-5000', '5001-10000'}
BIG400_MID = {'400001-600000', '600001-800000', '800001-1000000'}


def _throttle():
    """全域節流(執行緒安全):維持 _min_interval 的請求間隔"""
    global _last_req_ts
    with _lock:
        wait = _last_req_ts + _min_interval - time.time()
        _last_req_ts = max(time.time(), _last_req_ts + _min_interval)
    if wait > 0:
        time.sleep(wait)


def _slow_down():
    global _min_interval
    with _lock:
        _min_interval = min(_min_interval * 1.5 + 0.05, 1.5)


def _next_token():
    global _tok_i
    with _lock:
        tok = TOKENS[_tok_i % len(TOKENS)] if TOKENS else ''
        _tok_i += 1
    return tok


REASON = {}          # 診斷用:失敗原因計數(⛔ 只記類型,絕不記 token 值)


def _bump(k):
    with _lock:
        REASON[k] = REASON.get(k, 0) + 1


def _fetch_once(sym: str, start: str, timeout: int):
    """單次嘗試。回 list(rows)/[](查無)/None(該試失敗)"""
    for _ in range(max(len(TOKENS), 1) + 1):
        _throttle()
        tok = _next_token()
        q = {'dataset': 'TaiwanStockHoldingSharesPer', 'data_id': sym, 'start_date': start}
        if tok:
            q['token'] = tok
        url = API + '?' + urllib.parse.urlencode(q)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                j = json.loads(r.read().decode('utf-8', errors='replace'))
            return j.get('data') or []
        except urllib.error.HTTPError as e:
            if e.code in (402, 429):
                _bump(f'http{e.code}'); _slow_down(); continue
            if e.code in (500, 502, 503, 504):
                _bump(f'http{e.code}'); continue
            # 🐛 V72.5.3 **403 一定要換下一把 token 再試,⛔ 不可直接放棄**。
            #   實測(V72.5.2 那輪的 REASON 統計):`http403×2442` —— 而 `timeout` **一次都沒有**。
            #   403 = 「這把金鑰的帳號層級開不了這個資料集」,不是網路慢。
            #   使用者的 4 把 `FINMIND_TOKENS` **並非每一把都是付費層**
            #   (CLAUDE.md 台指 VIX 那次已經查過:有的回 `Your level is register`、有的無效)。
            #   舊寫法在 403 直接 `return []` → 一檔只要**剛好輪到壞的那把**就整檔放棄,
            #   於是覆蓋率被鎖在「好 token 的比例」≈ 55%(實測兩輪加起來 2,272 / 約 4,000 檔)。
            #   ⚠️ 這也推翻我上一版寫在註解裡的推論(「真因是老牌大股回應大、30 秒逾時不夠」)——
            #      **那是用猜的,診斷欄位出來才知道是權限**。⭐ 通用:先加分類統計,別用推論當結論。
            if e.code in (401, 403):
                _bump(f'http{e.code}'); continue
            _bump(f'http{e.code}')
            return []
        except Exception as e:
            _bump('timeout' if 'timed out' in str(e).lower() else type(e).__name__)
            continue
    return None


def fetch(sym: str, start: str):
    """回 list(rows)/[](查無)/None(全失敗)

    🐛 V72.5.2 首次深度回補只拿到 **740 / 2,956** 檔四碼股(**2330 這種大權值股也缺**)。
    ⚠️⚠️ 我當時**推論**是「老牌大股 2 年資料量大、30 秒逾時不夠」→ **那是錯的**。
       加上 `REASON` 分類統計之後,實測結果是 `http403×2442`、`http400×1549`,
       而 **`timeout` 一次都沒出現**。真因是**金鑰權限**不是網路慢(見 `_fetch_once` 的 403 註解)。
    ⭐ 所以這裡留下兩層防護(都有用,但都不是主因):
       ① timeout 30 → `LONG_TIMEOUT`(大檔本來就該給久一點)
       ② 全窗口失敗就**退而求其次抓半個窗口**(1 年)—— 拿到 1 年遠好過拿到 0。
          ⚠️ 退化時要記進 REASON,否則「只拿到一半深度」會靜默發生(實測 degraded_half_window×357)。
    ⭐⭐ 通用教訓:**先加分類統計,再下結論**。我那句「真因是逾時」白紙黑字寫進註解,
       如果沒有 REASON,下一個人會照著它往錯的方向修。
    """
    rows = _fetch_once(sym, start, LONG_TIMEOUT)
    if rows:
        return rows
    half = (datetime.now(TW_TZ) - timedelta(days=max(BACKFILL_DAYS // 2, 120))).date().isoformat()
    if half <= start:
        return rows
    rows2 = _fetch_once(sym, half, LONG_TIMEOUT)
    if rows2:
        _bump('degraded_half_window')
    return rows2 if rows2 else rows


def build_rows(rows):
    """FinMind rows → {date8: [date8, big1000, big400, retail_pct, retail_n]}"""
    by_date = {}
    for r in rows:
        d = str(r.get('date') or '')[:10]
        if len(d) != 10:
            continue
        by_date.setdefault(d, {})[_norm(r.get('HoldingSharesLevel'))] = (
            int(r.get('people') or 0), float(r.get('percent') or 0.0))
    out = {}
    for d, lv in by_date.items():
        d8 = d.replace('-', '')
        big1000 = big400 = retail = 0.0
        retail_n = 0
        for k, (ppl, pct) in lv.items():
            if k == 'total':
                continue
            if 'morethan' in k or '1000001' in k:
                big1000 += pct; big400 += pct
            elif k in BIG400_MID:
                big400 += pct
            elif k in RETAIL:
                retail += pct; retail_n += ppl
        if big1000 <= 0 and big400 <= 0 and retail <= 0:
            continue
        out[d8] = [d8, round(big1000, 2), round(big400, 2), round(retail, 2), retail_n]
    return out


def merge_one(data, sym, rows, deep=None):
    """把 FinMind 歷史併入該股 h(既有日期為準,不覆蓋);回補進幾週。

    ⭐ V72.5.1 同一份 rows 順便寫進 `deep`(深歷史,給探針用)——
       ⛔ 不會多打一次 API,只是同一包資料存兩種保留長度。
    """
    built = build_rows(rows)
    if deep is not None:
        dent = deep.setdefault(sym, {})
        # ⭐ V72.5.2 深檔也要存 `t`(總發行股數)—— 沒有它就無法把「大戶 %」換成「張數」,
        #   「隱藏大戶扣抵」那條探針第一次跑就因為缺這欄拿到 0 筆樣本(看起來像沒資料)。
        if not dent.get('t'):
            dent['t'] = (data.get(sym) or {}).get('t') or 0
        dh = [h for h in (dent.get('h') or []) if isinstance(h, list) and len(h) >= 5]
        dhave = {h[0] for h in dh}
        dh.extend(v for d8, v in built.items() if d8 not in dhave)
        dent['h'] = sorted(dh, key=lambda h: h[0])[-DEEP_WEEKS:]
    ent = data.get(sym)
    if not isinstance(ent, dict):
        return 0
    hist = [h for h in (ent.get('h') or []) if isinstance(h, list) and len(h) >= 5]
    have = {h[0] for h in hist}
    new = [v for d8, v in built.items() if d8 not in have]
    if not new:
        return 0
    hist.extend(new)
    ent['h'] = sorted(hist, key=lambda h: h[0])[-KEEP_WEEKS:]
    return len(new)


def save(data, touched, note='', deep=None):
    meta = data.get('_meta') or {}
    if touched >= 50:
        meta['backfilled'] = datetime.now(TW_TZ).strftime('%Y-%m-%d %H:%M')
    data['_meta'] = meta
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    msg = f'  💾 checkpoint 寫檔 {note}({os.path.getsize(OUT_FILE)//1024} KB)'
    # ⛔ 深歷史空的時候**不要寫檔** —— 寫出一個空的 tdcc_deep.json 會把上一輪辛苦累積的蓋掉
    #   (同 fund_sweep「命中不足不覆寫」的自我保護)。
    if deep:
        real = {k: v for k, v in deep.items() if (v or {}).get('h')}
        if len(real) >= 200:
            real['_meta'] = {'updated': datetime.now(TW_TZ).strftime('%Y-%m-%d %H:%M'),
                             'weeks_kept': DEEP_WEEKS, 'symbols': len(real),
                             'note': '深歷史,只給探針/回測用;⛔ 前端不 fetch(前端請用 tdcc_holders.json)'}
            with open(DEEP_FILE, 'w', encoding='utf-8') as f:
                json.dump(real, f, ensure_ascii=False, separators=(',', ':'))
            msg += f' ・deep {len(real) - 1} 檔/{os.path.getsize(DEEP_FILE)//1024} KB'
        else:
            msg += f' ・deep 只有 {len(real)} 檔(<200)→ 不覆寫舊檔'
    print(msg, flush=True)


def main():
    t0 = time.time()
    if not TOKENS:
        print('❌ 無 FINMIND_TOKENS,回補需要付費 token'); sys.exit(1)
    if not os.path.exists(OUT_FILE):
        print('❌ 找不到現有 tdcc_holders.json(先跑週採礦)'); sys.exit(1)
    with open(OUT_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
    # ⭐ V72.5.1 深歷史檔:先讀回舊的(workflow 已從 data 分支還原),重跑時接續而不是從頭抓
    deep = {}
    if os.path.exists(DEEP_FILE):
        try:
            with open(DEEP_FILE, 'r', encoding='utf-8') as f:
                deep = {k: v for k, v in (json.load(f) or {}).items() if not k.startswith('_')}
            print(f'↩️ 讀回深歷史 {len(deep)} 檔', flush=True)
        except Exception as e:
            print(f'⚠️ 深歷史讀取失敗(當作沒有,重抓):{str(e)[:80]}', flush=True)
            deep = {}
    # 跳過條件:淺檔已有 ≥2 週 **而且** 深檔已經夠深(重跑接續)
    #   ⛔ 舊版只看「淺檔 ≥2 週」→ 第一輪跑完之後**永遠不會再補**,深度就永遠停在那裡。
    #      這正是「13 週」卡了那麼多版的真因(同陷阱 #10:跳過條件綁「有沒有做過」而不是「夠不夠深」)。
    def _need(s):
        if len((data.get(s) or {}).get('h') or []) < 2:
            return True
        return len((deep.get(s) or {}).get('h') or []) < DEEP_ENOUGH
    syms = [k for k in data if not k.startswith('_') and _need(k)]
    syms.sort(key=lambda s: (0 if (len(s) == 4 and s.isdigit()) else 1, s))
    start = (datetime.now(TW_TZ) - timedelta(days=BACKFILL_DAYS)).date().isoformat()
    print(f'🏦 歷史回補:{len(syms)} 檔待補,start={start}(深歷史保留 {DEEP_WEEKS} 週),'
          f'tokens={len(TOKENS)} 把,workers={WORKERS}', flush=True)
    touched = added = empty = hard_fail = done = touched_deep = 0
    stop = False
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fetch, s, start): s for s in syms}
        for fu in as_completed(futs):
            sym = futs[fu]; done += 1
            try:
                rows = fu.result()
            except Exception:
                rows = None
            if rows is None:
                hard_fail += 1
            elif not rows:
                empty += 1
            else:
                n = merge_one(data, sym, rows, deep)
                if n:
                    touched += 1; added += n
                else:
                    touched_deep += 1          # 淺檔沒新增,但深檔可能有(重跑加深時的常態)
            if done % 200 == 0:
                el = int(time.time() - t0)
                print(f'  … {done}/{len(syms)}({el}s)補 {touched} 檔/{added} 週,空 {empty},敗 {hard_fail},限速 {_min_interval:.2f}s', flush=True)
            if done % CHECKPOINT_EVERY == 0:
                save(data, touched, f'{done}/{len(syms)}', deep)
            if time.time() - t0 > SOFT_DEADLINE_SEC and not stop:
                stop = True
                print('⏰ 40 分軟時限到 → 停止排程,收尾寫檔(剩的下次重跑自動接續)', flush=True)
                for f2 in futs:
                    f2.cancel()
    _dw = [len((v or {}).get('h') or []) for v in deep.values() if (v or {}).get('h')]
    _med = sorted(_dw)[len(_dw) // 2] if _dw else 0
    print(f'📊 回補結果:{touched} 檔補進 {added} 週;空 {empty}、敗 {hard_fail}、共處理 {done}', flush=True)
    print(f'🕳️ 深歷史:{len(_dw)} 檔有資料,週數中位 {_med}(目標 {DEEP_WEEKS})', flush=True)
    # 🔍 失敗原因分類(⛔ 只印類型與次數,絕不印 token 值)—— 沒有這個就查不出
    #   「為什麼剛好是大股票拿不到」(V72.5.2 那次差點誤判成「資料源沒有」)
    if REASON:
        print('🔍 失敗/降級原因:' + '、'.join(f'{k}×{v}' for k, v in sorted(REASON.items(), key=lambda x: -x[1])), flush=True)
    # ⛔ 淺檔沒補到不代表白跑 —— 重跑加深時淺檔本來就早就滿了,深檔才是這輪的產出
    if touched == 0 and not _dw:
        print('⚠️ 沒補到任何歷史(API 失敗或已全補過)→ 不改寫檔案'); return
    save(data, touched, 'final', deep)
    print(f'✅ 完成,耗時 {int(time.time()-t0)}s', flush=True)


if __name__ == '__main__':
    main()
