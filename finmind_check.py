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
import json
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
        # 🔐 repo 是 public → Actions log 也公開。⛔ 絕不可印 token 的任何片段(舊版洩漏 14 個字元)。
        #    診斷需要的只有「第幾把 + 長度 + 錯誤訊息」,那些都不含金鑰內容。
        note = f'(原始 {len(raw)} → 清空白後 {len(tok)} 字元)' if len(tok) != len(raw) else f'(長度 {len(tok)} 字元)'
        print(f'\n── Token #{i}  {note} ──')
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

        # 🏦 八大行庫專項探針:大小寫 + bulk/per-stock + date vs range,一次定案正確接法
        print('\n' + '=' * 60)
        print('🏦 八大行庫(govbank)接法探針 — 找哪個組合回得到資料')
        print('=' * 60)
        import requests as _rq3
        gv_sd = (date.today() - timedelta(days=16)).strftime('%Y-%m-%d')
        gv_ed = date.today().strftime('%Y-%m-%d')
        # 近幾個交易日單日測(size 400 通常代表它是 single-day 資料集、不吃 range)
        gv_days = [(date.today() - timedelta(days=k)).strftime('%Y-%m-%d') for k in range(1, 8)]
        gv_variants = [
            ('大寫S bulk single start_date', f'{BASE}/data?dataset=TaiwanStockGovernmentBankBuySell&start_date={gv_ed}'),
            ('大寫S 2330 single start_date', f'{BASE}/data?dataset=TaiwanStockGovernmentBankBuySell&data_id=2330&start_date={gv_ed}'),
            ('大寫S bulk date=',            f'{BASE}/data?dataset=TaiwanStockGovernmentBankBuySell&date={gv_ed}'),
            ('大寫S 2330 近3日 range',       f'{BASE}/data?dataset=TaiwanStockGovernmentBankBuySell&data_id=2330&start_date={(date.today()-timedelta(days=3)).strftime("%Y-%m-%d")}&end_date={gv_ed}'),
        ]
        # 逐日 bulk single 掃前 7 天,找哪天有資料(避開非交易日)
        for d in gv_days:
            gv_variants.append((f'大寫S bulk single {d}', f'{BASE}/data?dataset=TaiwanStockGovernmentBankBuySell&start_date={d}'))
        for label, url in gv_variants:
            try:
                r = _rq3.get(url, headers=hdr, timeout=20)
                j = r.json(); st = j.get('status'); rows = j.get('data') or []
                extra = ''
                if rows:
                    extra = f'  欄位={list(rows[0].keys())}  樣本={json.dumps(rows[0], ensure_ascii=False)[:180]}'
                print(f'▸ {label}: status={st}  rows={len(rows)}  msg={str(j.get("msg",""))[:120]}{extra}')
            except Exception as e:
                print(f'▸ {label}: 例外 {str(e)[:80]}')
        print('=' * 60)

        # 📐 資產負債表 + 現金流量表「真實 type/origin_name」實測(給基本面頁 ROE/負債比/現金流用,不猜欄位)
        print('\n' + '=' * 60)
        print('📐 財報細項欄位實測(2330,近2年)→ 建 ROE/負債比/現金流 用')
        print('=' * 60)
        import requests as _rq4
        fin_sd = (date.today() - timedelta(days=730)).strftime('%Y-%m-%d')
        for nm, ds in [('資產負債表 BalanceSheet', 'TaiwanStockBalanceSheet'),
                       ('現金流量表 CashFlows', 'TaiwanStockCashFlowsStatement')]:
            try:
                r = _rq4.get(f'{BASE}/data?dataset={ds}&data_id=2330&start_date={fin_sd}', headers=hdr, timeout=25)
                j = r.json(); rows = j.get('data') or []
                print(f'\n▸ {nm}: status={j.get("status")}  rows={len(rows)}')
                if rows:
                    latest = max(r0.get('date', '') for r0 in rows)
                    items = {}
                    for r0 in rows:
                        if r0.get('date') == latest:
                            items[r0.get('type', '?')] = (r0.get('origin_name', ''), r0.get('value'))
                    print(f'   最新季 {latest} 共 {len(items)} 個 type:')
                    for t, (on, v) in sorted(items.items()):
                        print(f'     {t}  ({on})  = {v}')
            except Exception as e:
                print(f'\n▸ {nm}: 例外 {str(e)[:80]}')
        print('=' * 60)

        # 📐 集保股權持股分級(籌碼分佈用:千張大戶/散戶怎麼分,絕不能猜)
        print('\n' + '=' * 60)
        print('📐 集保股權持股分級 HoldingSharesPer 實測(2330,近60日)')
        print('=' * 60)
        import requests as _rq5
        hd_sd = (date.today() - timedelta(days=60)).strftime('%Y-%m-%d')
        try:
            r = _rq5.get(f'{BASE}/data?dataset=TaiwanStockHoldingSharesPer&data_id=2330&start_date={hd_sd}', headers=hdr, timeout=25)
            j = r.json(); rows = j.get('data') or []
            print(f'▸ status={j.get("status")}  rows={len(rows)}  msg={str(j.get("msg",""))[:60]}')
            if rows:
                print(f'   欄位: {list(rows[0].keys())}')
                latest = max(r0.get('date', '') for r0 in rows)
                print(f'   最新日 {latest} 各分級:')
                for r0 in rows:
                    if r0.get('date') == latest:
                        print(f'     level={r0.get("HoldingSharesLevel")}  people={r0.get("people")}  percent={r0.get("percent")}  unit={r0.get("unit")}')
                dates = sorted(set(r0.get('date') for r0 in rows))
                print(f'   共 {len(dates)} 個日期(週頻?):{dates[-4:]}')
        except Exception as e:
            print(f'▸ 例外 {str(e)[:80]}')
        print('=' * 60)

    # ═══ 🚨 V73.9.6 分點「新鮮度」探針(使用者:「籌碼採礦重新看一下有沒有問題」)═══
    #
    # 🔍 實測背景(2026-08-26 掃 gh-pages 的 data/chips/):
    #    ・熱門股(2330/2317/2454/2382…)的 `chips_fetched_on` = **08-26(昨天)**
    #      → **採礦有跑到它們**,⛔ 不是「輪不到」
    #    ・但它們的**最新分點日全部停在 08-14**(落後 12 天)
    #    ・抽樣 50 檔:最大一群卡在 **07-28**(約一個月前)
    #
    # ⭐⭐ 「採礦有跑」+「資料還是舊的」= 上游給不出新的,⛔ 不是排程問題。
    #    但那還有兩種可能,**必須分清楚**才知道要修哪裡:
    #      ① FinMind 的分點資料本身就落後(那就只能等,程式再怎麼改都沒用)
    #      ② 我們的金鑰掉了 Sponsor 等級(那要使用者去續約/換金鑰)
    #    → 這段就是用來分這兩件事的:**從今天往回一天一天問,找出「最新拿得到的分點日」**。
    #
    # ⛔ 三條刻意的設計:
    #  ① **要有對照組** —— 同時問「一定拿得到」的免費資料集(股價)最新到哪天。
    #     兩邊一起落後 = 上游/假日問題;只有分點落後 = 權限或該資料集的問題。
    #     ⛔ 沒有對照組的話,又會變成「猜是不是自己壞掉」(同 V73.7.8 期交所那次)。
    #  ② **單日全市場批次要單獨試** —— 它需要更高的等級,可能只有它掛掉
    #     (逐檔還通、批次不通 → 採礦會退回逐檔慢速模式,長尾就永遠輪不到)。
    #  ③ 🔐 只印「第幾把」,⛔ 絕不印 token。
    # ⛔ 沒有付費金鑰時**不可靜默跳過** —— 那樣使用者只會看到一片空白,
    #    不知道是「沒跑」還是「跑了沒事」(診斷不可靜默,同陷阱 #22)。
    if not (any_paid and paid_tok):
        print('\n🕵️ 分點新鮮度探針')
        print('=' * 60)
        print('   ⏭️ 跳過:**沒有任何一把是付費金鑰**,分點端點本來就會被擋,測了也只會全紅。')
        print('   ⭐ 但上面那段已經是決定性的證據了:')
        print('      ・免費資料集(TaiwanStockInfo)四把**全部 200 success** → 金鑰有效、網路正常')
        print('      ・付費分點端點四把**全部回 `Your level is register`** → 這是**帳號等級**問題')
        print('   → ⛔ 不是程式壞掉、不是排程問題、也不是 FinMind 資料落後,')
        print('      是 **FinMind 的付費(Sponsor)訂閱失效了**。')
        print('   📌 只有帳號擁有者能處理:去 FinMind 確認訂閱狀態,')
        print('      續約後把**付費那把**金鑰放進 GitHub Secrets 的 FINMIND_TOKENS,再跑一次這支確認。')
        print('=' * 60)
    if any_paid and paid_tok:
        print('\n🕵️ 分點新鮮度探針(最重要的一段)')
        print('=' * 60)
        hdr = {'Authorization': f'Bearer {paid_tok}'}
        today = date.today()

        def newest(url_fn, label, max_back=25):
            """從今天往回找第一個有資料的日子。回 (日期, 落後幾個日曆天) 或 (None, None)。"""
            for back in range(max_back):
                d = (today - timedelta(days=back)).strftime('%Y-%m-%d')
                st, msg, rows = probe(url_fn(d), hdr)
                if st == 200 and rows > 0:
                    print(f'   {label}:最新 {d}(往回第 {back} 天)・{rows} 列')
                    return d, back
                if st not in (200,):
                    print(f'   {label}:{d} status={st} msg={str(msg)[:50]}')
                    if st in (401, 402, 403):
                        print(f'   → ⛔ 這是**權限**問題,不是「沒有資料」')
                        return None, None
            print(f'   {label}:往回 {max_back} 天都沒有資料')
            return None, None

        # ① 對照組:免費的股價資料集(⛔ 沒有它就分不出「上游落後」與「我們沒權限」)
        d_px, b_px = newest(
            lambda d: f'{BASE}/data?dataset=TaiwanStockPrice&data_id=2330&start_date={d}&end_date={d}',
            '📈 對照組·股價(免費)')
        # 逐檔分點
        d_ch, b_ch = newest(
            lambda d: f'{BASE}/taiwan_stock_trading_daily_report?data_id=2330&date={d}',
            '🧙 分點·逐檔(付費)')
        # ② 單日全市場批次(省略 data_id;需要更高等級)
        d_bulk, b_bulk = newest(
            lambda d: f'{BASE}/taiwan_stock_trading_daily_report?date={d}',
            '🚀 分點·全市場批次(需 Sponsor)', max_back=8)

        print('\n📋 結論')
        if d_ch and d_px:
            gap = (date.fromisoformat(d_px) - date.fromisoformat(d_ch)).days
            if gap <= 1:
                print(f'   ✅ 分點沒有落後(股價 {d_px} / 分點 {d_ch})')
                print('      → 那 chips 檔還舊的話,問題在**採礦端的跳過邏輯或輪動速度**,不是上游。')
            else:
                print(f'   🚨 分點比股價落後 {gap} 天(股價 {d_px} / 分點 {d_ch})')
                print('      → 上游那個資料集自己在落後,⛔ 改程式沒有用,只能等或換來源。')
        elif d_px and not d_ch:
            print('   🚨 股價拿得到、分點拿不到 → **權限/等級**問題,要去確認 FinMind 訂閱')
        elif not d_px:
            print('   ⚠️ 連免費的股價都拿不到 → 這台機器或帳號整個不通,⛔ 別急著怪分點')
        if d_bulk is None:
            print('   ⚠️ 單日全市場批次不通 → 採礦會退回「逐檔」慢速模式,')
            print('      長尾冷門股會輪不到(實測抽樣有一群卡在 07-28)。')
        print('=' * 60)

        # ── 🚀 V74.0.7 批次模式「還有沒有別的寫法」總掃 ─────────────────────
        #   為什麼要有這段:「1 年全市場逐日」整個計畫的成本假設就是
        #   **一次呼叫 = 該日全市場**(245 次 vs 65 萬次,差 2,600 倍)。
        #   2026-08-30 實測專用端點省略 data_id 回 `parameter data_id can't be none`
        #   → ⛔ 在確認「所有寫法都不通」之前,不可以說這條路死了,
        #     也不可以照著 245 次的假設去排工作。
        #   ⭐ CLAUDE.md V73.4.0 的教訓:**同一份資料可能有多個入口,層級要求還不一樣**
        #     (權證分點就是「專用端點通、dataset 形式要付費層」)。
        print('\n🚀 分點「全市場批次」還有沒有別的寫法(決定 1 年回算的成本)')
        print('=' * 60)
        _d = d_ch or (today - timedelta(days=2)).strftime('%Y-%m-%d')
        variants = [
            ('A 專用端點 date=(現行)', f'{BASE}/taiwan_stock_trading_daily_report?date={_d}'),
            ('B 專用端點 date= + 空 data_id', f'{BASE}/taiwan_stock_trading_daily_report?data_id=&date={_d}'),
            ('C dataset 形式 date=', f'{BASE}/data?dataset=TaiwanStockTradingDailyReport&date={_d}'),
            ('D dataset 形式 start_date=', f'{BASE}/data?dataset=TaiwanStockTradingDailyReport&start_date={_d}'),
            ('E dataset 形式 start+end', f'{BASE}/data?dataset=TaiwanStockTradingDailyReport&start_date={_d}&end_date={_d}'),
            ('F 分點聚合 SecIdAgg', f'{BASE}/data?dataset=TaiwanStockTradingDailyReportSecIdAgg&start_date={_d}'),
            ('G 券商聚合(單一券商全市場)', f'{BASE}/taiwan_stock_trading_daily_report?securities_trader_id=9200&date={_d}'),
            # 對照組:已知**可以**批次的資料集 —— ⛔ 沒有它就分不出
            #        「這個帳號不能批次」與「這個資料集不能批次」
            ('🆚 對照·八大行庫(已知可批次)', f'{BASE}/data?dataset=TaiwanStockGovernmentBankBuySell&start_date={_d}'),
        ]
        best = None
        for label, url in variants:
            st, msg, rows = probe(url, hdr)
            mark = '✅' if (st == 200 and rows > 50) else ('➖' if st == 200 else '❌')
            print(f'   {mark} {label:<28} status={st} rows={rows} msg={str(msg)[:70]}')
            if st == 200 and rows > 50 and label[0] in 'ABCDEFG' and best is None:
                best = label
        print()
        if best:
            print(f'   ⭐ **有可用的批次寫法:{best}** → 1 年回算只要約 245 次呼叫,'
                  '把 `_fetch_chips_bulk` 改用這個寫法即可。')
        else:
            print('   🚨 **所有批次寫法都不通** → 1 年全市場逐日要 245×2,653 ≈ 65 萬次呼叫,')
            print('      以 6,000 req/hr 算是 108 小時 → ⛔ 全市場不可行。')
            print('   ⭐ 可行的替代:**熱門 220 檔 × 245 天 ≈ 5.4 萬次(約 9 小時)**,體積約 4 MB。')
            print('   ⚠️ 若對照組(八大行庫)是 ✅ 而分點全紅 → 那是**這個資料集**不給批次,')
            print('      ⛔ 不是帳號等級不夠,升級也沒用。')
        print('=' * 60)


if __name__ == '__main__':
    main()
