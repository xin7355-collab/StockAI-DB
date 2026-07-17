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
    paid_tok = None
    for i, raw in enumerate(tokens, 1):
        # 🧹 JWT 金鑰內不該有任何空白;複製時常把頁面換行的空格一起帶進來 → 全清掉
        tok = ''.join(raw.split())
        mask = (tok[:8] + '…' + tok[-6:]) if len(tok) > 16 else tok
        note = f'(原始 {len(raw)} → 清空白後 {len(tok)} 字元)' if len(tok) != len(raw) else f'(長度 {len(tok)} 字元)'
        print(f'\n── Token #{i}  {mask}  {note} ──')
        if len(tok) != len(raw):
            print(f'   🧹 偵測到金鑰內含 {len(raw) - len(tok)} 個空白字元 → 已清除(這通常就是 illegal 主因)')
        hdr = {'Authorization': f'Bearer {tok}'}
        # 1a) 免費集,Bearer 標頭
        fb_st, fb_msg, _ = probe(f'{BASE}/data?dataset=TaiwanStockInfo&data_id=2330', hdr)
        # 1b) 免費集,?token= query(FinMind /data 舊式帶法,雙保險)
        fq_st, fq_msg, _ = probe(f'{BASE}/data?dataset=TaiwanStockInfo&data_id=2330&token={tok}', {})
        # 2) 付費分點專屬端點,Bearer
        p_st, p_msg, p_rows = probe(
            f'{BASE}/taiwan_stock_trading_daily_report?data_id=2330&date={sd}', hdr)
        print(f'   免費集(Bearer)  : status={fb_st}  msg={fb_msg}')
        print(f'   免費集(?token=) : status={fq_st}  msg={fq_msg}')
        print(f'   付費分點端點      : status={p_st}  rows={p_rows}  msg={p_msg}')

        free_ok = (fb_st == 200) or (fq_st == 200)
        if p_st == 200 and p_rows > 0:
            print('   → ✅ 付費有效!分點/八大行庫/借券等 Sponsor 資料全開')
            any_paid = True
            paid_tok = tok
        elif free_ok and p_st in (402, 403):
            print('   → 🟡 金鑰有效,但「非付費層級」→ 分點需 FinMind Sponsor(確認帳號付費是否在這把 token)')
        elif free_ok:
            print(f'   → 🟡 金鑰合法(免費集通),但付費端點回 {p_st} → 可能該日非交易日,或付費未生效')
        elif ('illegal' in (fb_msg or fq_msg or p_msg or '').lower()) or fb_st in (400, 401):
            print('   → ❌ 金鑰非法。已試過「清空白 + Bearer + ?token= 兩種帶法」都被拒 →')
            print('        代表這把 token 字串本身 FinMind 不認(需在 FinMind 帳號頁按「更新令牌」重產一把,')
            print('        再用「全選」複製整串貼進 Secret)。')
        else:
            print(f'   → ⚠️ 未定:free(Bearer)={fb_st} / free(query)={fq_st} / paid={p_st}')

    print('\n' + '=' * 60)
    print('✅ 檢測完成:偵測到有效付費金鑰,採礦機會全開付費資料。' if any_paid
          else '⚠️ 檢測完成:沒有任何一把是有效付費金鑰 → 採礦維持免費降版模式。')
    print('=' * 60)

    # ── 📐 付費資料集「真實欄位」實測(給採礦碼照著寫,不靠猜)──
    if paid_tok:
        print('\n' + '=' * 60)
        print('📐 付費資料集 schema 實測(1 筆樣本 → 建 premium 採礦用)')
        print('=' * 60)
        hdr = {'Authorization': f'Bearer {paid_tok}'}
        sd30 = (date.today() - timedelta(days=30)).strftime('%Y-%m-%d')
        ed = date.today().strftime('%Y-%m-%d')
        probes = [
            ('八大行庫 GovernmentBank', f'{BASE}/data?dataset=TaiwanstockGovernmentBankBuySell&start_date={sd}&end_date={ed}', True),
            ('借券 SecuritiesLending',  f'{BASE}/data?dataset=TaiwanStockSecuritiesLending&data_id=2330&start_date={sd30}&end_date={ed}', True),
            ('鉅額 BlockTrade',         f'{BASE}/data?dataset=TaiwanStockBlockTrade&data_id=2330&start_date={sd30}&end_date={ed}', True),
            ('還原股價 PriceAdj',       f'{BASE}/data?dataset=TaiwanStockPriceAdj&data_id=2330&start_date={sd30}&end_date={ed}', True),
            ('月營收 MonthRevenue',     f'{BASE}/data?dataset=TaiwanStockMonthRevenue&data_id=5483&start_date=2025-01-01&end_date={ed}', True),
            ('財報 FinancialStatements', f'{BASE}/data?dataset=TaiwanStockFinancialStatements&data_id=5483&start_date=2025-01-01&end_date={ed}', True),
            ('分點聚合 SecIdAgg',       f'{BASE}/taiwan_stock_trading_daily_report_secid_agg?data_id=2330&start_date={sd}&end_date={ed}', False),
        ]
        import requests as _rq
        for name, url, _ in probes:
            try:
                r = _rq.get(url, headers=hdr, timeout=20)
                j = r.json()
                st = j.get('status'); rows = j.get('data') or []
                if st == 200 and rows:
                    print(f'\n▸ {name}: status=200  rows={len(rows)}')
                    print(f'   欄位: {list(rows[0].keys())}')
                    print(f'   樣本: {json.dumps(rows[0], ensure_ascii=False)[:300]}')
                else:
                    print(f'\n▸ {name}: status={st}  rows={len(rows)}  msg={str(j.get("msg",""))[:80]}')
            except Exception as e:
                print(f'\n▸ {name}: 例外 {str(e)[:80]}')
        # 🔎 用無效 dataset 觸發 422,其 detail 常列出所有合法 dataset 名 → 找八大行庫真名
        try:
            import requests as _rq2
            rr = _rq2.get(f'{BASE}/data?dataset=__FINDNAME__&data_id=2330', headers=hdr, timeout=20)
            txt = rr.text
            print('\n▸ 合法 dataset 名清單(從 422 detail 撈,找 Government/Bank):')
            import re as _re
            hits = _re.findall(r'[A-Za-z]*[Gg]overnment[A-Za-z]*|[A-Za-z]*[Bb]ank[A-Za-z]*|[A-Za-z]*[Ll]ending[A-Za-z]*', txt)
            print('   命中:', sorted(set(hits))[:20])
            print('   raw(前1500):', txt[:1500])
        except Exception as e:
            print('   enum dump 例外', str(e)[:80])
        print('\n' + '=' * 60)


if __name__ == '__main__':
    main()
