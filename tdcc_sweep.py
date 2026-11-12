#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏦 TDCC 集保股權分散表 週採礦 (tdcc_sweep.py) — V69.6.3

資料源(黑科技,零金鑰零額度):集保結算所開放資料,每週更新一次(週六),
一個 CSV 涵蓋全市場每一檔的「持股分級 × 人數 × 股數」:
  https://opendata.tdcc.com.tw/getOD.ashx?id=1-5

這是付費籌碼 App「大戶 vs 散戶趨勢」的原始資料:
  - 千張大戶比率(持股分級 15 = 1,000,001 股以上)
  - 400 張以上大戶比率(分級 12~15)
  - 散戶比率/人數(分級 1~3 = 10 張以下)
  - 總發行股數(分級 17 = 合計)→ 前端算「換手率」

輸出 data/tdcc_holders.json(滾動保留 13 週歷史):
  { "_meta": {...},
    "2330": { "t": 總股數, "n": 總股東人數,
              "h": [[民國日期8碼, 千張%, 400張%, 散戶%, 散戶人數], ...最舊→最新] } }

自我保護:解析出的股票數 < MIN_STOCKS(500)→ 不覆寫舊檔(視為抓失敗/格式變)。
沙盒/本機 403 是 proxy 擋,GitHub Actions 可正常存取(同 TWSE T86 前例)。
"""
import csv
import io
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

TDCC_URL = 'https://opendata.tdcc.com.tw/getOD.ashx?id=1-5'
TDCC_URL_ALT = 'https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5'   # extras_miner 以前的備援網址
# ⛔ 偽裝瀏覽器(V80.1.6 決策):寫明是誰;被擋就記下來,⛔ 換身分再試
UA = 'Mozilla/5.0 (compatible; StockAI-DB tdcc_sweep/1.0; +https://github.com/xin7355-collab/stockai-db)'
STALE_DAYS = 9           # 資料日超過幾天算舊(TDCC 每週更新一次 → 9 天 = 至少漏了一週)
OUT_FILE = 'data/tdcc_holders.json'
KEEP_WEEKS = 13          # 滾動保留 13 週(一季)歷史
MIN_STOCKS = 500         # 低於此檔數視為抓壞,不覆寫
TW_TZ = timezone(timedelta(hours=8))


def fetch_csv() -> str:
    last = None
    for url in (TDCC_URL, TDCC_URL_ALT):
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/csv,*/*'})
        try:
            # ⏱️ 60 秒 = 連線 / 每次讀取「多久沒動靜」就放棄(⛔ 整個下載的總時間,大檔照樣下得完)。
            #   以前 300:extras_miner 現在每天會順便叫 → 萬一 TDCC 對機房丟封包,兩個網址各卡 5 分鐘 = 每天拖 10 分鐘。
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            return raw.decode('utf-8-sig', errors='replace')
        except Exception as e:  # noqa: BLE001
            last = e
            print(f'  ⚠️ {url.split("/")[2]} 抓不到:{e}')
    raise last


def data_date_of(path) -> str:
    """tdcc_holders.json 的資料日(YYYYMMDD):先看 _meta.data_date,沒有就取各檔最後一週的最大值;讀不到回 ''。"""
    try:
        with open(path, encoding='utf-8') as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001
        return ''
    if not isinstance(d, dict):
        return ''
    dd = str((d.get('_meta') or {}).get('data_date') or '')
    if dd:
        return dd
    best = ''
    for k, v in d.items():
        if k.startswith('_') or not isinstance(v, dict):
            continue
        h = v.get('h')
        if isinstance(h, list) and h and isinstance(h[-1], list) and h[-1]:
            best = max(best, str(h[-1][0]))
    return best


def is_stale(data_date: str, today, max_days: int = STALE_DAYS) -> bool:
    """資料日比今天(台北)早超過 max_days 天 → True;沒有資料日也算舊。"""
    try:
        d = datetime.strptime(str(data_date), '%Y%m%d').date()
    except (TypeError, ValueError):
        return True
    return (today - d).days > max_days


def num(s, cast=int):
    try:
        return cast(str(s).replace(',', '').strip())
    except Exception:
        return 0


def parse(txt: str):
    """回 {sym: {'date': 'YYYYMMDD', 'levels': {lv:(人數,股數,比例%)}}}"""
    out = {}
    rows = csv.reader(io.StringIO(txt))
    for r in rows:
        if len(r) < 6:
            continue
        d = r[0].strip()
        if not (d.isdigit() and len(d) == 8):   # 跳過表頭/雜訊列
            continue
        sym = r[1].strip()
        lv = num(r[2])
        if lv <= 0 or not sym:
            continue
        ppl, sh, pct = num(r[3]), num(r[4]), num(r[5], float)
        ent = out.setdefault(sym, {'date': d, 'levels': {}})
        ent['levels'][lv] = (ppl, sh, pct)
    return out


def build(parsed, old):
    """併入舊檔歷史 → 新 JSON 結構"""
    result = {}
    for sym, ent in parsed.items():
        lv = ent['levels']
        # 分級 17 = 合計;缺就用 1~15 加總(16=差異數調整,不併)
        if 17 in lv:
            total_ppl, total_sh, _ = lv[17]
        else:
            total_ppl = sum(lv[i][0] for i in range(1, 16) if i in lv)
            total_sh = sum(lv[i][1] for i in range(1, 16) if i in lv)
        if total_sh <= 0:
            continue
        big1000 = lv.get(15, (0, 0, 0.0))[2]                                  # 千張大戶 %
        big400 = sum(lv[i][2] for i in range(12, 16) if i in lv)              # ≥400張 %
        retail = sum(lv[i][2] for i in range(1, 4) if i in lv)                # ≤10張 %
        retail_n = sum(lv[i][0] for i in range(1, 4) if i in lv)              # ≤10張 人數
        row = [ent['date'], round(big1000, 2), round(big400, 2), round(retail, 2), retail_n]
        hist = []
        if sym in old and isinstance(old[sym], dict):
            hist = [h for h in (old[sym].get('h') or []) if isinstance(h, list) and len(h) >= 5]
        # 同日期覆蓋,否則 append;保留最後 KEEP_WEEKS 筆
        hist = [h for h in hist if h[0] != ent['date']]
        hist.append(row)
        hist = sorted(hist, key=lambda h: h[0])[-KEEP_WEEKS:]
        result[sym] = {'t': total_sh, 'n': total_ppl, 'h': hist}
    return result


def update(out_file: str = None):
    """抓最新一週、併進舊檔 → (ok, 說明)。⛔ 丟例外 / ⛔ sys.exit(extras_miner 每天順便叫它,失敗不能拖垮別的)。"""
    # ⚠️ 預設值寫成 None、呼叫時才讀 OUT_FILE:寫成 `= OUT_FILE` 會在定義當下就綁死,
    #    之後改模組的 OUT_FILE(test_accum_safe ② 就這樣測「舊檔讀壞 ⛔ 下載」)完全沒作用 → 保護作用在別的檔上。
    out_file = out_file or OUT_FILE
    # 讀舊檔(workflow 會先從 origin/data 還原)以滾動累積歷史
    # 🩺 10/24 巡邏:讀壞了 ⛔「忽略,重建」(那會把每檔累積的週資料蓋成只剩這一週)→ 救得回用前面那份,救不回 ⛔ 寫
    from pathlib import Path as _Path
    from lib_jsonsafe import load_accum
    old, _old_ok = load_accum(_Path(out_file), {}, what=out_file)
    if not _old_ok:
        return False, f'{out_file} 讀不出來 → 不寫(先修檔)'
    if not isinstance(old, dict):
        old = {}
    if old:
        print(f'  ↩️ 舊檔載入:{len([k for k in old if not k.startswith("_")])} 檔(續累歷史)')
    try:
        txt = fetch_csv()
    except Exception as e:  # noqa: BLE001
        return False, f'TDCC 下載失敗:{e}(舊檔不動)'
    print(f'  📥 下載完成:{len(txt) // 1024} KB')
    parsed = parse(txt)
    print(f'  🔍 解析出 {len(parsed)} 檔')
    if len(parsed) < MIN_STOCKS:
        return False, f'檔數 {len(parsed)} < {MIN_STOCKS},疑似抓壞 / 格式變 → 不覆寫舊檔'
    result = build(parsed, old)
    data_date = next(iter(parsed.values()))['date'] if parsed else ''
    result['_meta'] = {
        'updated': datetime.now(TW_TZ).strftime('%Y-%m-%d %H:%M'),
        'data_date': data_date,
        'stocks': len(result),
        'keep_weeks': KEEP_WEEKS,
        'src': 'TDCC opendata 1-5(集保股權分散表,每週六更新)',
    }
    os.makedirs(os.path.dirname(out_file) or '.', exist_ok=True)
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, separators=(',', ':'))
    return True, f'{out_file}:{len(result) - 1} 檔 / 資料日 {data_date}'


def main():
    print('🏦 TDCC 股權分散表週採礦開始…')
    ok, msg = update()
    print(('✅ ' if ok else '❌ ') + msg)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
