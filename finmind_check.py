#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔑 FinMind 金鑰快速檢測(20 秒)—— 不用等 60 分的 daily_miner
────────────────────────────────────────────────────────
用途:改完 GitHub Secrets 的 FINMIND_TOKENS 後,Actions 手動 Run 這支,
     20 秒內告訴你每一把 token 到底「有效 / 貼錯(illegal) / 有效但非付費」,
     並印出 token 長度(揪出「複製被截斷」——這是最常見的 illegal 主因)。

判讀:
  · ✅ 付費有效  → 分點(TaiwanStockTradingDailyReport)回 200+資料 → 全開
  · 🟡 有效非付費 → 免費資料集(TaiwanStockInfo)通,但分點回 402 → 需升級 Sponsor
  · ❌ 金鑰非法  → 連免費資料集都回 illegal → token 貼錯/截斷/過期,請重貼完整金鑰
"""
import os
import sys
import requests
from datetime import date, timedelta

BASE = 'https://api.finmindtrade.com/api/v4'


def probe(url, headers):
    try:
        r = requests.get(url, headers=headers, timeout=15)
        try:
            j = r.json()
        except Exception:
            return r.status_code, '(非 JSON 回應)', 0
        return j.get('status'), str(j.get('msg', ''))[:80], len(j.get('data') or [])
    except Exception as e:
        return 'EXC', str(e)[:80], 0


def main():
    env = os.getenv('FINMIND_TOKENS') or os.getenv('FINMIND_TOKEN', '')
    tokens = [t.strip() for t in env.split(',') if t.strip()]
    print('=' * 60)
    print(f'🔑 FinMind 金鑰檢測 — FINMIND_TOKENS 內共 {len(tokens)} 把')
    print('=' * 60)
    if not tokens:
        print('❌ Secret FINMIND_TOKENS 是空的 → 請到 GitHub Secrets 填入付費金鑰')
        sys.exit(1)

    sd = (date.today() - timedelta(days=10)).strftime('%Y-%m-%d')
    any_paid = False
    for i, tok in enumerate(tokens, 1):
        hdr = {'Authorization': f'Bearer {tok}'}
        mask = (tok[:8] + '…' + tok[-6:]) if len(tok) > 16 else tok
        print(f'\n── Token #{i}  {mask}  (長度 {len(tok)} 字元) ──')
        # 1) 免費資料集:判 token 本身合不合法
        f_st, f_msg, _ = probe(f'{BASE}/data?dataset=TaiwanStockInfo&data_id=2330', hdr)
        # 2) 付費分點專屬端點:判付費層級
        p_st, p_msg, p_rows = probe(
            f'{BASE}/taiwan_stock_trading_daily_report?data_id=2330&date={sd}', hdr)
        print(f'   免費集 TaiwanStockInfo : status={f_st}  msg={f_msg}')
        print(f'   付費分點 分點端點       : status={p_st}  rows={p_rows}  msg={p_msg}')

        if p_st == 200 and p_rows > 0:
            print('   → ✅ 付費有效!分點/八大行庫/借券等 Sponsor 資料全開')
            any_paid = True
        elif ('illegal' in (f_msg or '').lower()) or ('illegal' in (p_msg or '').lower()) \
                or f_st in (400, 401):
            print('   → ❌ 金鑰非法(貼錯/截斷/過期)。真金鑰通常 200~400 字元;')
            print('        若上面長度偏短 = 被截斷。請用 FinMind 會員中心的「複製」鈕重抓完整金鑰,')
            print('        貼進 GitHub Secrets FINMIND_TOKENS(不要引號、空白、換行)。')
        elif p_st in (402, 403):
            print('   → 🟡 金鑰有效,但「非付費層級」→ 分點需 FinMind Sponsor。基本資料仍可用。')
        else:
            print(f'   → ⚠️ 未定:免費 status={f_st} / 付費 status={p_st}(可能該日非交易日或連線問題)')

    print('\n' + '=' * 60)
    print('✅ 檢測完成:偵測到有效付費金鑰,採礦機會全開付費資料。' if any_paid
          else '⚠️ 檢測完成:沒有任何一把是有效付費金鑰 → 採礦維持免費降版模式。')
    print('=' * 60)


if __name__ == '__main__':
    main()
