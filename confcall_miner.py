#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🎤 confcall_miner.py —— 法說會(法人說明會)時間表 + 官方擇要 → `data/confcall.json`(V77.2.7)

🚨 為什麼要有這一支(2026-09-18 探針 Actions #35294351143 / #35294467879 定案):
   ・舊的 `macro_miner.fetch_earnings_calls` 打 TWSE OpenAPI `t187ap02_L` —— 探針實跑證實那是
     「**大股東名稱**」表,`t187ap38_L` 是股東會/股利表;TWSE 與 TPEx 的 OpenAPI 目錄**都沒有**法人說明會資料集。
     → 三個月來每天「📞 法說會 上市: 0 場」不是配額也不是網路,是**打錯資料集**(陷阱 #23 的變形)。
   ・⭐ 真正給得到的是公開資訊觀測站 **mopsov.twse.com.tw** 的 `ajax_t100sb02_1`(POST,按月查):
     欄位 = 代號 / 名稱 / 日期 / 時間 / 地點 / 擇要訊息 / 中文簡報檔 / 英文簡報檔 / 公司網站 / 影音連結 / 其他 / 歷年
     上市 9 月 301 列、上櫃 112 列。⚠️ `mops.twse.com.tw` 主機對 runner 回「因為安全性考量…」,⛔ 只有 mopsov 通。

📐 產物 `data/confcall.json`:
   { updated, data_date, src:{host, months:[…]}, src_error:{sii:null|str, otc:null|str},
     window:{past:60, future:45},
     upcoming:[row…]   // d >= data_date
     recent:[row…]     // d <  data_date(有擇要/簡報的多半在這裡 —— 會後才貼)
     hist:{ "2330":["2026-07-17", …] }   // 只存過去日期,每檔 ≤ HIST_MAX 筆,從舊檔合併(累積型)
     n:{sii, otc, upcoming, recent, with_sum, with_files} }
   row = { s, name, mkt:"上市"|"上櫃", d:"YYYY-MM-DD", t:"HH:MM", place, sum(≤400 字),
           pdf:[檔名…](⚠️ 只有檔名 —— MOPS 用 POST 表單下載,⛔ 沒有可直接開的網址), web, vid }

⛔ 四條不可改掉:
   ① **每個市場各自 try/except**(陷阱 #44)—— 上櫃掛掉⛔ 不可拖累上市;掛的那邊要寫 `src_error`(陷阱 #22)。
   ② **空過守門**:兩個市場加起來 0 列而舊檔有列 → ⛔ 不覆寫(印原因、exit 0)。
   ③ `hist` 是**累積型**:要先讀舊檔合併再寫,⛔ 不可每輪重建(playbook_scan 跑之前已還原 data/)。
   ④ 進入點放檔尾(陷阱 #9)。
"""
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DATA = Path(os.getenv('DATA_DIR', 'data'))
OUT = DATA / 'confcall.json'
HOST = os.getenv('CONFCALL_HOST', 'https://mopsov.twse.com.tw')
PAST = int(os.getenv('CONFCALL_PAST', '60'))
FUTURE = int(os.getenv('CONFCALL_FUTURE', '45'))
HIST_MAX = 40               # 每檔最多留幾場(≈ 3 年)
SUM_MAX = 400
UA = {'User-Agent': 'Mozilla/5.0 confcall_miner/1.0',
      'Accept': 'text/html, */*', 'Content-Type': 'application/x-www-form-urlencoded'}
TW = timezone(timedelta(hours=8))


# ───────────────────────── 解析(純函式,測試直接打這幾支) ─────────────────────────
def parse_roc_date(s):
    """'115/09/15' → '2026-09-15';失敗回 None。"""
    m = re.match(r'^\s*(\d{2,3})/(\d{1,2})/(\d{1,2})\s*$', str(s or ''))
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 1911:
        y += 1911
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


def _strip(html):
    """去標籤 + HTML 實體 + 壓空白。"""
    t = re.sub(r'<br\s*/?>', '\n', html or '', flags=re.I)
    t = re.sub(r'<[^>]+>', '', t)
    t = (t.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<')
          .replace('&gt;', '>').replace('&quot;', '"').replace('&#39;', "'"))
    t = re.sub(r'&#(\d+);', lambda m: chr(int(m.group(1))), t)
    return re.sub(r'\s+', ' ', t).strip()


def parse_rows(html, mkt):
    """把 ajax_t100sb02_1 回的 HTML 表格 → [row]。⛔ 只認 12 欄的資料列(表頭與空表不算)。"""
    out = []
    for tr in re.findall(r'<tr[^>]*>.*?</tr>', html or '', flags=re.S | re.I):
        tds = re.findall(r'<td[^>]*>(.*?)</td>', tr, flags=re.S | re.I)
        if len(tds) < 11:
            continue
        code = _strip(tds[0])
        if not re.match(r'^\d{4,6}[A-Z]?$', code):
            continue
        d = parse_roc_date(_strip(tds[2]))
        if not d:
            continue
        pdf = re.findall(r'fileName\.value="([^"]+)"', tds[6] + tds[7])
        web = re.findall(r'href=[\'"](https?://[^\'"]+)[\'"]', tds[8])
        vid = re.findall(r'href=[\'"](https?://[^\'"]+)[\'"]', tds[9])
        sum_ = _strip(tds[5])
        other = _strip(tds[10]) if len(tds) > 10 else ''
        out.append({
            's': code, 'name': _strip(tds[1]), 'mkt': mkt, 'd': d,
            't': _strip(tds[3]), 'place': _strip(tds[4])[:120],
            'sum': sum_[:SUM_MAX],
            'pdf': sorted(set(pdf)),
            'web': web[0] if web else '',
            'vid': vid[0] if vid else '',
            'other': '' if other in ('無', '無。', '') else other[:160],
        })
    return out


def to_macro_events(rows, today, window_days=14):
    """給 macro_miner 用:未來 window 天內 → [{date, event}]。
    ⭐ 文字一律 `📞 {name}({code}) 法說會 {time}` —— index.html `_findEarningsEvent` 靠「事件文字含股名或代號」比對,
       ⛔ 改格式會讓報告頁 §12 / 個股頁提醒整個對不到(陷阱 #37)。"""
    end = today + timedelta(days=window_days)
    seen, out = set(), []
    for r in sorted(rows, key=lambda x: x['d']):
        try:
            d = date.fromisoformat(r['d'])
        except Exception:
            continue
        if not (today <= d <= end):
            continue
        ev = f"📞 {r.get('name') or ''}({r['s']}) 法說會" + (f" {r['t']}" if r.get('t') else '')
        k = (r['d'], ev)
        if k in seen:
            continue
        seen.add(k)
        out.append({'date': r['d'], 'event': ev})
    return out


def merge_hist(old_hist, rows, today):
    """累積型:舊檔的 hist + 這一輪已經開過的場次。⛔ 只收過去日期;每檔最多 HIST_MAX 筆。"""
    hist = {}
    for k, v in (old_hist or {}).items():
        if isinstance(v, list):
            hist[str(k)] = [x for x in v if isinstance(x, str)]
    t = today.isoformat()
    for r in rows:
        if r['d'] < t:
            hist.setdefault(r['s'], [])
            if r['d'] not in hist[r['s']]:
                hist[r['s']].append(r['d'])
    for k in list(hist):
        hist[k] = sorted(set(hist[k]))[-HIST_MAX:]
        if not hist[k]:
            del hist[k]
    return hist


# ───────────────────────── 抓取 ─────────────────────────
def _months(today):
    """涵蓋 [today−PAST, today+FUTURE] 的 (year, month) 清單。"""
    lo, hi = today - timedelta(days=PAST), today + timedelta(days=FUTURE)
    out, y, m = [], lo.year, lo.month
    while (y, m) <= (hi.year, hi.month):
        out.append((y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def fetch_market(typek, today, session=None):
    """typek = 'sii'(上市) / 'otc'(上櫃)。回 (rows, err)。⛔ 這裡自己 try,呼叫端⛔ 不需要再包。"""
    import requests
    s = session or requests.Session()
    mkt = '上市' if typek == 'sii' else '上櫃'
    rows, errs, got = [], [], 0
    for (y, m) in _months(today):
        form = {'encodeURIComponent': '1', 'step': '1', 'firstin': '1', 'off': '1',
                'TYPEK': typek, 'year': str(y - 1911), 'month': f'{m:02d}'}
        last = None
        for attempt in range(3):
            try:
                r = s.post(f'{HOST}/mops/web/ajax_t100sb02_1', data=form,
                           headers={**UA, 'Referer': f'{HOST}/mops/web/t100sb02_1'}, timeout=30)
                if r.status_code != 200:
                    last = f'{y}/{m:02d} HTTP {r.status_code}'
                elif '因為安全性考量' in (r.text or '') or 'CAN NOT BE ACCESSED' in (r.text or ''):
                    last = f'{y}/{m:02d} 被主機擋(安全性考量)'
                else:
                    part = parse_rows(r.text, mkt)
                    rows.extend(part)
                    got += 1
                    print(f"  🎤 {mkt} {y}/{m:02d}:{len(part)} 場")
                    last = None
                    break
            except Exception as e:
                last = f'{y}/{m:02d} {type(e).__name__}: {str(e)[:80]}'
            time.sleep(1.5 * (attempt + 1))     # 指數退避(MOPS 對機器人敏感)
        if last:
            errs.append(last)
            print(f"  ⚠️ {mkt} {last}")
        time.sleep(0.8)
    err = None if got else ('; '.join(errs)[:300] or '沒有任何一個月查到')
    if got and errs:
        err = '部分月份失敗:' + '; '.join(errs)[:220]
    # 同一檔同一天只留一筆(MOPS 偶爾重複列)
    seen, uniq = set(), []
    for r in rows:
        k = (r['s'], r['d'], r['t'])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)
    return uniq, err


def _load_old():
    try:
        j = json.loads(OUT.read_text(encoding='utf-8'))
        return j if isinstance(j, dict) else {}
    except Exception:
        return {}


def build(rows_sii, err_sii, rows_otc, err_otc, today, old=None):
    """組出產物 dict;回 None = 空過守門擋下(⛔ 不覆寫)。"""
    old = old or {}
    rows = rows_sii + rows_otc
    lo, hi = (today - timedelta(days=PAST)).isoformat(), (today + timedelta(days=FUTURE)).isoformat()
    rows = [r for r in rows if lo <= r['d'] <= hi]
    old_n = len(old.get('upcoming') or []) + len(old.get('recent') or [])
    if not rows and old_n:
        print(f"❌ 兩個市場都 0 場而舊檔有 {old_n} 場 → 🚧 空過守門,⛔ 不覆寫 confcall.json"
              f"(上市:{err_sii} / 上櫃:{err_otc})")
        return None
    t = today.isoformat()
    rows.sort(key=lambda r: (r['d'], r['t'], r['s']))
    upcoming = [r for r in rows if r['d'] >= t]
    recent = [r for r in rows if r['d'] < t]
    hist = merge_hist(old.get('hist'), rows, today)
    return {
        'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'data_date': t,
        'src': {'host': HOST, 'page': 'ajax_t100sb02_1', 'months': [f'{y}-{m:02d}' for y, m in _months(today)]},
        'src_error': {'sii': err_sii, 'otc': err_otc},
        'window': {'past': PAST, 'future': FUTURE},
        'upcoming': upcoming, 'recent': recent, 'hist': hist,
        'n': {'sii': len(rows_sii), 'otc': len(rows_otc), 'upcoming': len(upcoming), 'recent': len(recent),
              'with_sum': sum(1 for r in rows if r['sum']),
              'with_files': sum(1 for r in rows if r['pdf'] or r['vid'])},
        'note': '⛔ 只描述「誰、哪天、講了什麼」;法說會前後波動常變大,但方向實測 0 個成立(calendar_stock_probe),⛔ 不給多空。',
    }


def main():
    today = datetime.now(TW).date()
    print(f"🎤 confcall_miner 開跑(台北 {today},窗口 −{PAST}~+{FUTURE} 天,主機 {HOST})")
    import requests
    s = requests.Session()
    # ① 每個市場各自失敗各自記(陷阱 #44 / #22)
    rows_sii, err_sii = fetch_market('sii', today, s)
    rows_otc, err_otc = fetch_market('otc', today, s)
    print(f"  📊 上市 {len(rows_sii)} 場(err={err_sii}) ・上櫃 {len(rows_otc)} 場(err={err_otc})")
    old = _load_old()
    out = build(rows_sii, err_sii, rows_otc, err_otc, today, old)
    if out is None:
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    n = out['n']
    print(f"✅ data/confcall.json:未來 {n['upcoming']} 場 ・已開 {n['recent']} 場 ・有擇要 {n['with_sum']} ・"
          f"有簡報/影音 {n['with_files']} ・hist {len(out['hist'])} 檔 ・{OUT.stat().st_size / 1024:.1f} KB")
    if not out['upcoming'] and not out['recent']:
        print("  ⚠️ 兩邊都 0 場(舊檔也沒有)—— 前端會顯示「這幾天沒有」,先確認上面的 err 是不是被擋")
    return 0


if __name__ == '__main__':
    sys.exit(main())
