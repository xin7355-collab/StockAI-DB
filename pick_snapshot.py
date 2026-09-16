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
TOP_N = int(os.getenv('TOP_N', '20'))              # 明日作戰清單每天存前幾名(⛔ 不存全部,體積會爆)
# 📈 V77.2.5 實測訊號要存多一點 —— 「📈 符合進場」是 bull ∩ 🧬,而 🧬 的那一檔
#   可能排在 bull 的第 30 名 → 只存前 20 筆會**系統性漏掉**(同 pb 的 EXTRA_HQ 補位)。
SIG_N = int(os.getenv('SIG_N', '60'))              # 每天存前幾筆看多訊號


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
        # 📒 V76.0.4 決策台「今天可以買的」= hq==1 且 !bear、依 lb 排、取前 2(index.html `_deckState`)。
        #   要事後重建那份名單,快照裡就得有 hq / bear 兩個**事實欄**(它們是 playbook_edge 算好的旗標,
        #   ⛔ 不是結論),而且 hq 候選可能排在 TOP_N 之外 → 前 TOP_N 之外再補前 EXTRA_HQ 個 hq 候選。
        #   ⚠️ 這兩欄從 2026-09-12 起才有;之前的天數重建不出決策台名單(前端會誠實寫起算日)。
        EXTRA_HQ = int(os.getenv('EXTRA_HQ', '10'))
        rows_all = [x for x in pe['picks'] if isinstance(x, dict)]
        keep = list(range(min(TOP_N, len(rows_all))))
        extra = [i for i, x in enumerate(rows_all) if i >= TOP_N and (x.get('hq') or 0) == 1 and not x.get('bear')][:EXTRA_HQ]
        for i in keep + extra:
            x = rows_all[i]
            picks.append({
                's': str(x.get('s') or ''),
                'c': x.get('c'),                 # 當時收盤(⭐ 事後算報酬要用它當基準)
                'k': x.get('k'),                 # 打法名稱
                'lb': x.get('lb'),               # 保守下界(當時的排序依據)
                'trig': x.get('trig'),           # 觸發價(⛔ 是估計值,已知)
                'hq': 1 if (x.get('hq') or 0) == 1 else 0,   # 🧬 高位階+高波動(事實旗標)
                'bear': 1 if x.get('bear') else 0,           # 空頭(事實旗標;決策台⛔ 不給進場)
            })
        if d and picks:
            day['d'] = d
            day['pb'] = picks

    # ── ② 今天出現的實測訊號(today_signals)──
    # 📈 V77.2.5 使用者:「符合進場的也進到成績單裡面,重新回測」
    #   決策台那個「📈 符合進場」= `today_signals.bull` ∩ 🧬(位階 ≥75 且振幅 ≥3.2%)− 黑名單。
    #   要事後重建它,快照就得多存三個**事實欄**:`e` 期望值(排序用)・`p` 一年位階 ・`m` 20 日振幅。
    #
    # ⛔⛔ 只存 p / m 兩個**原始數字**,⛔ 不在這裡判斷「有沒有符合 🧬」——
    #    門檻(index.html `_EDGE_RULES.gene`)寫進這裡就變成第二份真相;
    #    而且門檻日後若調整,存原始數字的歷史可以**重新判定**,存結論的不行。
    #    (= 本檔頂端鐵則 ①「只存事實,⛔ 不存任何結論或評分」。)
    #
    # 🚨 位階/振幅⛔ **不可以讀 `screener.json`** —— 在 `playbook_scan.yml` 裡
    #    這一步跑在 `screener_miner.py` **之前**,那時候 `screener.json` 還是**昨天**那份
    #    (從 data 分支還原回來的)→ 會拿昨天的位階去配今天的訊號,而 App 上顯示的是今天的
    #    → 成績單跟畫面對不起來(使用者講最多次的「邏輯打架」)。
    # ⭐ 正解:直接呼叫 `screener_miner.build_one()` —— **同一份實作、同一份 data/{sym}.json**,
    #    ⛔ 不在這裡另寫一套公式(那就是第二份真相)。只算 bull 那幾十檔,很便宜。
    try:
        import screener_miner as _scr
    except Exception as _e:                                  # pragma: no cover
        _scr = None
        print(f'   ⚠️ 匯入 screener_miner 失敗({_e})→ 這一天的訊號沒有位階/振幅')

    def _posamp(sym):
        """回 (一年位階 %, 20 日振幅 %);算不出來回 (None, None)。⛔ 公式只有一份。"""
        if _scr is None:
            return (None, None)
        rows = _load(DATA / f'{sym}.json')
        if not isinstance(rows, list) or not rows:
            return (None, None)
        try:
            v = _scr.build_one(rows)
        except Exception:
            return (None, None)
        if not v:
            return (None, None)
        return (v[_scr.CI['pos252']], v[_scr.CI['amp20']])

    ts = _load(DATA / 'today_signals.json')
    if isinstance(ts, dict):
        d2 = str(ts.get('data_date') or '')[:10]
        arr = ts.get('bull') or ts.get('picks') or ts.get('items') or []
        sig = []
        for x in (arr if isinstance(arr, list) else [])[:SIG_N]:
            if isinstance(x, dict):
                sym = str(x.get('sym') or x.get('s') or '')
                pos, amp = _posamp(sym)
                sig.append({'s': sym,
                            'c': x.get('close') or x.get('c'),
                            # 🐛 V77.2.5 修掉既有 bug:`today_signals.bull` 的打法名稱欄位叫 **`t`**
                            #   (`{'s','c','v','a20','d','t','g','n','w','exp','po'}`),而這裡從
                            #   V73.4.1 起只試 `title`/`k` → **每一天的 `sig[].k` 都是 null**。
                            #   🚨 後果不只是難看:「📈 符合進場」要靠打法名稱過**黑名單**
                            #   (撿便宜/補漲/布林壓縮… 那幾招實測沒用甚至反向),名稱是 null 就整個擋不掉。
                            'k': x.get('title') or x.get('t') or x.get('k'),
                            'e': x.get('exp'),
                            'p': pos, 'm': amp})
        if d2 and sig:
            day.setdefault('d', d2)
            day['sig'] = sig
            _pm = sum(1 for z in sig if z.get('p') is not None)
            # 🚧 空過守門:一筆都補不到 → 前端重建不出「📈 符合進場」,⛔ 不可靜默(陷阱 #22)
            if _pm == 0:
                print('   ⚠️ 位階/振幅一筆都算不出來(data/{sym}.json 還原了嗎?)'
                      '→ 「📈 符合進場」這一天重建不出來,前端會誠實標出起算日')
            else:
                print(f'   🧬 位階/振幅補到 {_pm}/{len(sig)} 筆(screener_miner.build_one,⛔ 同一份公式)')

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
