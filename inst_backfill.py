#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🏦 法人買賣超 / 融資券 歷史回補(V73.3.6)

🚨 為什麼要做:`data/{sym}.json` 的 `foreign_net` **只回溯到 2026/04**(約 60 個交易日),
   害 CLAUDE.md 裡至少 5 條功能長期卡在「樣本不足以回測」:
   券資比軋空・板塊偷布局・投量比・籌碼訊號勝率・「外資認錯回補」…

⭐ 但那**不是資料源的限制** —— `miner.py` 只把 FinMind 當「今天的備援」在用
   (`start_date=end_date=今天`,一次抓一天)。探針實測(2026-08-12):
     TaiwanStockInstitutionalInvestorsBuySell  data_id=2330 start=2015-01-01
       → ✅ 13,411 列 / **2,827 個交易日 / 2015-01-05 起** / 1.4 秒
     TaiwanStockMarginPurchaseShortSale        → ✅ 2015 起
   **一檔一次呼叫就拿到 11 年。**

📐 這支怎麼做:
   ・逐檔把「這一檔 K 線已經有的那些日子」的法人/融資券補齊(⛔ 不加新的日期列)
   ・⛔ **實跑寫入優先**:已經有非 0 值的日期**不覆蓋**,只補 0/缺的
   ・⛔ 冪等:再跑一次不會變壞;已補滿的直接跳過(可分批、可續跑)

💾 只寫 `data/*.json` → 由 workflow 推 **data 分支**。
   ⭐ 不用推 gh-pages:`miner.py::seed_db_from_json` 每天會把 JSON 讀回 SQLite
      (已確認它有帶 foreign_net/trust_net/dealer_net/margin_balance/short_balance),
      再 export 回 JSON 並部署 → 隔天自動出現在前端。
   ⛔ 這也避免跟 daily_miner 的 gh-pages force-push 打架。

⛔ 安全:只用 GitHub Secrets 的 FINMIND_TOKENS,只記「第幾把」,絕不印金鑰值。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = 'https://api.finmindtrade.com/api/v4/data'
DATA_DIR = Path(os.getenv('DATA_DIR', 'data'))
# ⚠️ ⛔ 不可用 `.strip()` —— 金鑰中間常夾一個空白(V73.2.7 實測 4 把有 3 把中招)
TOKENS = [''.join(t.split()) for t in (os.getenv('FINMIND_TOKENS') or '').split(',') if t.strip()]
LIMIT = int(os.getenv('LIMIT', '99999'))
MAX_MIN = int(os.getenv('MAX_MIN', '300'))         # 時間預算(GitHub job 上限 6 小時)
SLEEP = float(os.getenv('SLEEP', '0.12'))
# ⭐ 補到「已經有 K 線的那些日子」即可 —— K 線本身只有 2~3 年,補更早也沒有價格可以配對
MIN_FILL_RATIO = float(os.getenv('MIN_FILL_RATIO', '0.80'))   # 已補到這個比例就跳過

_tok_i = 0
STAT = {'ok': 0, 'skip': 0, 'nodata': 0, 'fail': 0, 'filled_inst': 0, 'filled_margin': 0}
REASON = {}


def _rec(k):
    REASON[k] = REASON.get(k, 0) + 1


def fm(dataset, data_id, start_date, timeout=45):
    """回 (rows, err)。每一把 token 都試過才放棄(V72.5.3:403/400 要換 token,⛔ 不可當成沒資料)。"""
    global _tok_i
    tries = max(1, len(TOKENS))
    last = 'no-token'
    for k in range(tries):
        i = (_tok_i + k) % max(1, len(TOKENS))
        q = {'dataset': dataset, 'data_id': data_id, 'start_date': start_date}
        if TOKENS:
            q['token'] = TOKENS[i]
        try:
            with urllib.request.urlopen(API + '?' + urllib.parse.urlencode(q), timeout=timeout) as r:
                j = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode('utf-8', 'replace'))
                msg = str(body.get('msg') or '')[:80]
            except Exception:
                msg = ''
            last = f'http{e.code}:{msg}'
            _rec(f'http{e.code}')
            continue
        except Exception as e:
            last = f'{type(e).__name__}'
            _rec('net')
            continue
        if not isinstance(j, dict) or j.get('status') not in (200, None):
            last = f"status={j.get('status') if isinstance(j, dict) else '?'}"
            _rec('status')
            continue
        _tok_i = (i + 1) % max(1, len(TOKENS))      # 成功後也輪動,平均分散額度
        return (j.get('data') or []), None
    return None, last


def _d(x):
    return str(x or '').replace('/', '-')[:10]


def agg_inst(rows):
    """FinMind 一檔一天回多列(每個法人身分一列)→ 聚合成 {date: {f,t,d}}(單位:股)。"""
    out = {}
    for r in rows:
        d = _d(r.get('date'))
        if not d:
            continue
        nm = str(r.get('name') or '')
        net = (float(r.get('buy') or 0) - float(r.get('sell') or 0))
        o = out.setdefault(d, {'f': 0.0, 't': 0.0, 'd': 0.0})
        # ⚠️ FinMind 的 name 是**英文列舉**(V41.28 踩過:舊版只比中文 → 全部歸 0)
        if nm in ('Foreign_Investor', 'Foreign_Dealer_Self'):
            o['f'] += net
        elif nm in ('Investment_Trust',):
            o['t'] += net
        elif nm in ('Dealer_self', 'Dealer_Hedging', 'Dealer'):
            o['d'] += net
    return out


def agg_margin(rows):
    """{date: {mb, sb}} —— 融資餘額 / 融券餘額(單位:張,FinMind 給的就是張)。"""
    out = {}
    for r in rows:
        d = _d(r.get('date'))
        if not d:
            continue
        out[d] = {
            'mb': float(r.get('MarginPurchaseTodayBalance') or 0),
            'sb': float(r.get('ShortSaleTodayBalance') or 0),
        }
    return out


def main():
    if not TOKENS:
        print('❌ 沒有 FINMIND_TOKENS → 回補需要金鑰')
        return 1
    files = sorted(p for p in DATA_DIR.glob('*.json')
                   if p.stem.isdigit() or (p.stem and p.stem[0].isdigit()))
    print(f'🏦 法人/融資券 歷史回補 ・{len(files)} 檔候選 ・token {len(TOKENS)} 把 ・上限 {LIMIT} 檔 / {MAX_MIN} 分')
    t0 = time.time()
    done = 0
    for p in files:
        if done >= LIMIT:
            print(f'⏹️ 到達 LIMIT={LIMIT},本輪結束(下次再跑會接著補)')
            break
        if (time.time() - t0) / 60 > MAX_MIN:
            print(f'⏹️ 到達時間預算 {MAX_MIN} 分,本輪結束(下次再跑會接著補)')
            break
        sym = p.stem
        try:
            rows = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            STAT['fail'] += 1
            continue
        if not isinstance(rows, list) or len(rows) < 60:
            STAT['skip'] += 1
            continue
        # ── 跳過條件:綁「補到什麼程度」而不是「有沒有做過」(陷阱 #10)──
        have_i = sum(1 for r in rows if (r.get('foreign_net') or r.get('trust_net') or r.get('dealer_net')))
        have_m = sum(1 for r in rows if (r.get('margin_balance') or r.get('short_balance')))
        need_i = have_i < len(rows) * MIN_FILL_RATIO
        need_m = have_m < len(rows) * MIN_FILL_RATIO
        if not need_i and not need_m:
            STAT['skip'] += 1
            continue
        start = _d(rows[0].get('date')) or '2015-01-01'
        changed = 0
        if need_i:
            data, err = fm('TaiwanStockInstitutionalInvestorsBuySell', sym, start)
            if data:
                m = agg_inst(data)
                for r in rows:
                    d = _d(r.get('date'))
                    v = m.get(d)
                    if not v:
                        continue
                    # ⛔ 實跑寫入優先:已經有非 0 值就不動(只補 0/缺的)
                    if not r.get('foreign_net') and v['f']:
                        r['foreign_net'] = int(round(v['f'])); changed += 1
                    if not r.get('trust_net') and v['t']:
                        r['trust_net'] = int(round(v['t'])); changed += 1
                    if not r.get('dealer_net') and v['d']:
                        r['dealer_net'] = int(round(v['d'])); changed += 1
                STAT['filled_inst'] += 1
            elif err:
                _rec('inst_' + err[:14])
            time.sleep(SLEEP)
        if need_m:
            data, err = fm('TaiwanStockMarginPurchaseShortSale', sym, start)
            if data:
                m = agg_margin(data)
                for r in rows:
                    d = _d(r.get('date'))
                    v = m.get(d)
                    if not v:
                        continue
                    if not r.get('margin_balance') and v['mb']:
                        r['margin_balance'] = int(round(v['mb'])); changed += 1
                    if not r.get('short_balance') and v['sb']:
                        r['short_balance'] = int(round(v['sb'])); changed += 1
                STAT['filled_margin'] += 1
            elif err:
                _rec('mgn_' + err[:14])
            time.sleep(SLEEP)
        done += 1
        if changed:
            p.write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            STAT['ok'] += 1
        else:
            STAT['nodata'] += 1
        if done % 100 == 0:
            el = (time.time() - t0) / 60
            print(f'   … {done} 檔 ・{el:.0f} 分 ・寫入 {STAT["ok"]} ・跳過 {STAT["skip"]} ・沒補到 {STAT["nodata"]}')

    el = (time.time() - t0) / 60
    print(f'\n📊 本輪:處理 {done} 檔 / {el:.0f} 分')
    print(f'   ✅ 有寫入 {STAT["ok"]} ・⏭️ 已補滿跳過 {STAT["skip"]} ・➖ 抓不到 {STAT["nodata"]} ・❌ 壞檔 {STAT["fail"]}')
    print(f'   法人補了 {STAT["filled_inst"]} 檔 ・融資券補了 {STAT["filled_margin"]} 檔')
    # ⭐ 分類統計(V72.5.3 的教訓:先加分類統計,再下結論 —— 沒有它會把權限問題誤診成逾時)
    if REASON:
        print('   失敗分類:' + ' ・'.join(f'{k}×{v}' for k, v in sorted(REASON.items(), key=lambda x: -x[1])[:8]))

    # 🚧 空過守門:一檔都沒寫成功 = 這一輪無效,⛔ 不可讓 workflow 綠燈騙人(陷阱 #9)
    if done > 0 and STAT['ok'] == 0:
        print('❌ 處理了檔案但一筆都沒寫進去 → 這一輪無效(可能金鑰/欄位名有問題),⛔ 別當成「補完了」')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
