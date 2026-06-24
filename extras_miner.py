#!/usr/bin/env python3
"""V21.5 extras_miner — 為「⚖️ 多空優勢計分卡」補三項全市場資料。

在 daily_miner.yml deploy job 並行 7 腳本之後跑(此時 data/*.json 已是合併後全市場最新版,
適合算全市場排名)。失敗不影響主採礦,前端規則自動降級為「⚪ 待採礦補資料」。

輸出:
  - data/inst_rank.json    全市場 5 日法人累積排名(投信/外資/自營各 Top 50)
  - data/day_trade.json    全市場當沖比(TWSE TWTB4U)
  - data/tdcc.json         千張大戶集保戶股權(每天試抓,週末資料才會更新)
"""
import csv
import io
import json
from datetime import datetime, date, timedelta
from pathlib import Path

import requests

DATA_DIR = Path('data')
DATA_DIR.mkdir(exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0 (StockAI-DB extras_miner)'}


def _valid_sym(s: str) -> bool:
    """跟 miner.py 同樣的個股代號判斷(4 碼數字或 00 開頭 ETF)。"""
    return (s.isdigit() and len(s) == 4) or s.startswith('00')


def generate_inst_rank():
    """讀全市場 data/{sym}.json,算近 5 日法人累積,輸出 Top 50。"""
    rows = []
    for f in DATA_DIR.glob('*.json'):
        sym = f.stem
        if not _valid_sym(sym):
            continue
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
            daily = (data.get('daily') or [])[-5:]
            if len(daily) < 3:
                continue
            rows.append({
                'sym': sym,
                'foreign_5d': sum(int(r.get('foreign_net') or 0) for r in daily),
                'trust_5d':   sum(int(r.get('trust_net') or 0) for r in daily),
                'dealer_5d':  sum(int(r.get('dealer_net') or 0) for r in daily),
            })
        except Exception:
            continue

    if not rows:
        print('⚠️ inst_rank: 全市場 data/*.json 為空,跳過')
        return

    out = {
        'updated': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'total': len(rows),
        'foreign_top': sorted(rows, key=lambda r: -r['foreign_5d'])[:50],
        'trust_top':   sorted(rows, key=lambda r: -r['trust_5d'])[:50],
        'dealer_top':  sorted(rows, key=lambda r: -r['dealer_5d'])[:50],
    }
    (DATA_DIR / 'inst_rank.json').write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
    print(f'✅ inst_rank.json 已寫({len(rows)} 檔參與排序,各 Top 50)')


def fetch_day_trade():
    """TWSE TWTB4U 全市場當沖比 — 一次拉完。"""
    for back in range(6):
        d = date.today() - timedelta(days=back)
        if d.weekday() < 5:
            break
    date_str = d.strftime('%Y%m%d')
    url = f'https://www.twse.com.tw/exchangeReport/TWTB4U?date={date_str}&response=json'
    try:
        r = requests.get(url, timeout=20, headers=UA)
        if r.status_code != 200:
            print(f'⚠️ day_trade: TWSE HTTP {r.status_code}')
            return
        j = r.json()
        data = {}
        for row in j.get('data', []) or []:
            if not row or len(row) < 6:
                continue
            sym = str(row[0]).strip()
            if not _valid_sym(sym):
                continue
            try:
                vol = int(str(row[3]).replace(',', '') or '0')
                day_vol = int(str(row[4]).replace(',', '') or '0')
                ratio = float(str(row[5]).replace(',', '').replace('%', '') or '0')
            except (ValueError, TypeError):
                continue
            if vol > 0:
                data[sym] = {'ratio_pct': ratio, 'vol': vol, 'day_vol': day_vol}
        out = {
            'updated': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
            'date': date_str,
            'data': data,
        }
        (DATA_DIR / 'day_trade.json').write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
        print(f'✅ day_trade.json 已寫({len(data)} 檔當沖比, date={date_str})')
    except Exception as e:
        print(f'⚠️ day_trade: {e}')


def fetch_tdcc_holdings():
    """TDCC 集保戶股權分散表(1-5)— 每週更新,每天試抓,內容無變動就保留。

    取「15. 1000張以上」級距佔比 = 千張大戶持股 %
    跟上次比對算 top_pct_week_chg。
    """
    url = 'https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5'
    try:
        r = requests.get(url, timeout=30, headers=UA)
        if r.status_code != 200:
            print(f'⚠️ tdcc: HTTP {r.status_code}')
            return
        # 載入上週的 tdcc.json 算週變化
        prev_file = DATA_DIR / 'tdcc.json'
        prev_data = {}
        if prev_file.exists():
            try:
                prev = json.loads(prev_file.read_text(encoding='utf-8'))
                prev_data = prev.get('data') or {}
            except Exception:
                pass

        reader = csv.DictReader(io.StringIO(r.text))
        latest_date = None
        data_by_sym = {}
        for row in reader:
            sym = (row.get('證券代號') or '').strip()
            grade = (row.get('持股分級') or '').strip()
            if not _valid_sym(sym):
                continue
            # 千張大戶 = 第 15 級「1,000,001-5,000,000」或「5,000,001 以上」級距合計
            # TDCC 分級:1=1-999、...、15=1000-5000、16=5000-10000、17=10000+
            # 對「1000 張以上」我們取 15 + 16 + 17 合計
            if not grade or not grade[0].isdigit():
                continue
            try:
                grade_num = int(grade.split('.')[0].split('-')[0].strip())
                pct = float((row.get('占集保庫存比例%') or '0').strip())
            except (ValueError, TypeError):
                continue
            date_str = (row.get('資料日期') or '').strip()
            if grade_num >= 15:
                slot = data_by_sym.setdefault(sym, {'top_pct': 0.0})
                slot['top_pct'] = round(slot['top_pct'] + pct, 3)
                if date_str and (not latest_date or date_str > latest_date):
                    latest_date = date_str

        if not data_by_sym:
            print('⚠️ tdcc: CSV 解析後 0 檔,跳過(保留上次)')
            return

        for sym, info in data_by_sym.items():
            prev_pct = (prev_data.get(sym) or {}).get('top_pct')
            info['top_pct_week_chg'] = round(info['top_pct'] - prev_pct, 3) if prev_pct is not None else 0.0

        out = {
            'updated': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
            'date': latest_date or date.today().strftime('%Y%m%d'),
            'data': data_by_sym,
        }
        prev_file.write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
        print(f'✅ tdcc.json 已寫({len(data_by_sym)} 檔千張大戶, date={latest_date or "今天"})')
    except Exception as e:
        print(f'⚠️ tdcc: {e}')


if __name__ == '__main__':
    print('═════ V21.5 extras_miner 啟動 ═════')
    print('\n[1/3] generate_inst_rank — 全市場 5 日法人累積排名')
    generate_inst_rank()
    print('\n[2/3] fetch_day_trade — TWSE 全市場當沖比')
    fetch_day_trade()
    print('\n[3/3] fetch_tdcc_holdings — 千張大戶集保股權')
    fetch_tdcc_holdings()
    print('\n═════ V21.5 extras_miner 完成 ═════')
