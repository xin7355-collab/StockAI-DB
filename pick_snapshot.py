#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📸 榜單事後驗證:把「今天實際推薦了什麼」存成快照 → `data/pick_history.json`(V73.4.1)

🚨 為什麼要做(使用者上傳的 `plot_stock` 照出來的缺口):
   那支專案有一頁「**排行榜事後驗證**」—— 存 67 週快照,追蹤 +1W/+2W/+4W/+8W/+12W
   報酬並跟**同期加權指數**比。
   ⭐ 本專案的回測全部是「**拿歷史資料重算**」(signal_backtest / playbook_scan /
      portfolio_backtest),**從來沒有存過「當時實際產出的榜單」**。

⭐ 兩者的差別很重要,⛔ 不可互相取代:
   ・**重算** = 用**今天的程式**跑歷史 → 程式改過就會變,而且天生對自己有利
     (你不會留下一版「跑出來很難看」的邏輯)。
   ・**快照** = 記錄當時**真的**推了哪幾檔 → 事後看它漲跌,**程式怎麼改都不影響已存的紀錄**。
   → 快照能回答一個重算永遠答不了的問題:「這個 App 上個月推的,後來到底漲還跌?」

🚨 **回算不了,只能從今天開始存**(已實測):`data` / `gh-pages` 都是 orphan force-push,
   commit 數分別是 **1 / 3** → 過去的 `playbook_edge.json` 已經不存在。
   ⭐ 所以這屬於「**現在不存,以後永遠沒有**」那一類(同 V72.9.8 ETF `mgr_hist` 的判斷)。

⛔ 三條刻意的設計:
   ① **只存事實**(日期/代號/當時收盤/打法/排名),⛔ 不存任何結論或評分
      —— 評分邏輯會改,存進去就變成第二份真相。
   ② **冪等**:同一天重跑會覆蓋當天那筆,⛔ 不會累加成兩筆。
   ③ ⛔ **不在這裡算報酬** —— 報酬要用「未來的收盤價」算,那是讀取端的事。
      這支只負責「把當時的樣子釘住」。
"""
import json
import os
import sys
from pathlib import Path

DATA = Path(os.getenv('DATA_DIR', 'data'))
OUT = DATA / 'pick_history.json'
KEEP_DAYS = int(os.getenv('KEEP_DAYS', '400'))     # 保留幾天(約 1.5 年)
TOP_N = int(os.getenv('TOP_N', '20'))              # 每天存前幾名(⛔ 不存全部,體積會爆)


def _load(p, d=None):
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return d


def main():
    hist = _load(OUT, None)
    if not isinstance(hist, dict) or 'days' not in hist:
        hist = {'note': '每天實際產出的榜單快照,用來事後驗證。⛔ 只存事實不存結論。',
                'days': []}

    day = {}
    # ── ① 明日作戰清單(playbook_edge)──
    pe = _load(DATA / 'playbook_edge.json')
    if isinstance(pe, dict) and pe.get('picks'):
        d = str(pe.get('data_date') or '')[:10]
        picks = []
        for x in pe['picks'][:TOP_N]:
            if not isinstance(x, dict):
                continue
            picks.append({
                's': str(x.get('s') or ''),
                'c': x.get('c'),                 # 當時收盤(⭐ 事後算報酬要用它當基準)
                'k': x.get('k'),                 # 打法名稱
                'lb': x.get('lb'),               # 保守下界(當時的排序依據)
                'trig': x.get('trig'),           # 觸發價(⛔ 是估計值,已知)
            })
        if d and picks:
            day['d'] = d
            day['pb'] = picks

    # ── ② 今天出現的實測訊號(today_signals)──
    ts = _load(DATA / 'today_signals.json')
    if isinstance(ts, dict):
        d2 = str(ts.get('data_date') or '')[:10]
        arr = ts.get('bull') or ts.get('picks') or ts.get('items') or []
        sig = []
        for x in (arr if isinstance(arr, list) else [])[:TOP_N]:
            if isinstance(x, dict):
                sig.append({'s': str(x.get('sym') or x.get('s') or ''),
                            'c': x.get('close') or x.get('c'),
                            'k': x.get('title') or x.get('k')})
        if d2 and sig:
            day.setdefault('d', d2)
            day['sig'] = sig

    if not day.get('d'):
        # 🚧 空過守門:兩個來源都讀不到 → ⛔ 不可寫出空快照假裝有存
        print('❌ playbook_edge.json / today_signals.json 都讀不到內容 → 不寫檔')
        return 1

    # ⭐ 冪等:同一天重跑覆蓋,⛔ 不累加
    days = [x for x in hist['days'] if isinstance(x, dict) and x.get('d') != day['d']]
    days.append(day)
    days.sort(key=lambda x: x.get('d') or '')
    hist['days'] = days[-KEEP_DAYS:]
    hist['updated'] = day['d']
    hist['n_days'] = len(hist['days'])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(hist, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f"📸 榜單快照 {day['d']}:明日清單 {len(day.get('pb') or [])} 筆 ・"
          f"實測訊號 {len(day.get('sig') or [])} 筆 ・累計 {hist['n_days']} 天 ・"
          f"{OUT.stat().st_size/1024:.1f} KB")
    if hist['n_days'] < 20:
        print(f"   ⏳ 還在累積({hist['n_days']}/20 天)—— ⛔ 在那之前前端不會顯示任何績效數字")
    return 0


if __name__ == '__main__':
    sys.exit(main())
