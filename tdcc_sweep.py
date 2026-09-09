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
OUT_FILE = 'data/tdcc_holders.json'
KEEP_WEEKS = 13          # 滾動保留 13 週(一季)歷史
MIN_STOCKS = 500         # 低於此檔數視為抓壞,不覆寫
TW_TZ = timezone(timedelta(hours=8))


def fetch_csv() -> str:
    req = urllib.request.Request(TDCC_URL, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/csv,*/*',
    })
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
    return raw.decode('utf-8-sig', errors='replace')


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


def main():
    print('🏦 TDCC 股權分散表週採礦開始…')
    # 讀舊檔(workflow 會先從 origin/data 還原)以滾動累積歷史
    old = {}
    if os.path.exists(OUT_FILE):
        try:
            with open(OUT_FILE, 'r', encoding='utf-8') as f:
                old = json.load(f)
            print(f'  ↩️ 舊檔載入:{len([k for k in old if not k.startswith("_")])} 檔(續累歷史)')
        except Exception as e:
            print(f'  ⚠️ 舊檔解析失敗(忽略,重建):{e}')
            old = {}

    try:
        txt = fetch_csv()
    except Exception as e:
        print(f'❌ TDCC 下載失敗:{e}')
        sys.exit(1)
    print(f'  📥 下載完成:{len(txt) // 1024} KB')

    parsed = parse(txt)
    print(f'  🔍 解析出 {len(parsed)} 檔')
    if len(parsed) < MIN_STOCKS:
        print(f'❌ 檔數 {len(parsed)} < {MIN_STOCKS},疑似抓壞/格式變 → 不覆寫舊檔,保留原狀')
        sys.exit(1)

    result = build(parsed, old)
    data_date = next(iter(parsed.values()))['date'] if parsed else ''
    result['_meta'] = {
        'updated': datetime.now(TW_TZ).strftime('%Y-%m-%d %H:%M'),
        'data_date': data_date,
        'stocks': len(result),
        'keep_weeks': KEEP_WEEKS,
        'src': 'TDCC opendata 1-5(集保股權分散表,每週六更新)',
    }
    os.makedirs('data', exist_ok=True)
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, separators=(',', ':'))
    size_kb = os.path.getsize(OUT_FILE) // 1024
    print(f'✅ 輸出 {OUT_FILE}:{len(result) - 1} 檔 / {size_kb} KB / 資料日 {data_date}')


if __name__ == '__main__':
    main()
