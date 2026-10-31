#!/usr/bin/env python3
"""🚨 Telegram 警報系統(戰區三)

讀 data/ 下既有採礦 JSON,挑出「重大事件」推 Telegram。

設計原則(不吵):
- 每天 2 則「定時摘要」:盤前 09:00 + 盤後 14:00(台北)
- 重大事件即時:融資 > 3200 億 / 新增處置股 / 美債大跌等

ENV(GitHub secrets):
- TELEGRAM_BOT_TOKEN  :從 @BotFather 拿
- TELEGRAM_CHAT_ID    :您的 Telegram 用戶 ID(從 @userinfobot 拿)

若 ENV 沒設 → 印警告即退 exit 0,workflow 不會炸。
"""
import os
import sys
import json
from pathlib import Path
from datetime import datetime
from lib_hotrule import hot_rule, deck_pick, gene_rank   # 🔥 V79.4.9 名單排序規則(= scripts/lib_hotrule.mjs)
#   🧬 V80.0.9 + 決策台那條篩選(🧬 而且這一檔自己不是空頭)—— 跟 App `_deckBuyOf` / auto_trade 同一條

DATA_DIR = Path(__file__).parent / "data"
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
MODE = os.environ.get("ALERT_MODE", "summary").strip().lower()  # summary | watch


def send_telegram(text):
    """送 Telegram 訊息(Markdown 格式)。失敗印警告不拋例外。"""
    if not BOT_TOKEN or not CHAT_ID:
        print(f"⚠️ Telegram 未設定(BOT_TOKEN={'有' if BOT_TOKEN else '無'} / CHAT_ID={'有' if CHAT_ID else '無'})")
        return False
    import urllib.request
    import urllib.parse
    try:
        url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
        data = urllib.parse.urlencode({
            "chat_id": CHAT_ID,
            "text": text,
            "parse_mode": "Markdown",
            "disable_web_page_preview": "true",
        }).encode('utf-8')
        req = urllib.request.Request(url, data=data, method='POST')
        with urllib.request.urlopen(req, timeout=10) as r:
            ok = r.status == 200
            print(f"   {'✅' if ok else '❌'} Telegram HTTP {r.status}")
            return ok
    except Exception as e:
        print(f"   ❌ Telegram 送出失敗:{e}")
        return False


def load_json(name):
    f = DATA_DIR / name
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text(encoding='utf-8'))
    except Exception as e:
        print(f"   ⚠️ {name} parse 失敗:{e}")
        return None


# V21.3 ── 股票代號 → 中文名 lookup(從 data/{sym}.json 的 name 欄位)
#   首次呼叫時掃全部 data/*.json 建表(~700 檔,< 2 秒),後續 O(1) cache
_STOCK_NAMES_CACHE = None

def stock_label(sym):
    """2330 → '台積電 2330'(若無中文名 fallback 純代號)"""
    global _STOCK_NAMES_CACHE
    if _STOCK_NAMES_CACHE is None:
        _STOCK_NAMES_CACHE = {}
        try:
            for f in DATA_DIR.glob('*.json'):
                # 跳過已知非個股 json(broker_names / radar / top_picks 等)
                if any(skip in f.stem for skip in ['broker_names', 'radar', 'top_picks',
                                                    'macro_risk', 'bubble_warning', 'attention_',
                                                    'futures_cache', 'margin_cache', 'signal_history',
                                                    'strategy_backtest', 'paper_trades', 'sector_heat',
                                                    'walk_forward', 'tier_backtest', 'etf_tracking',
                                                    'radar_news', 'radar_matrix', 'global_news']):
                    continue
                try:
                    j = json.loads(f.read_text(encoding='utf-8'))
                    if isinstance(j, dict) and j.get('name'):
                        _STOCK_NAMES_CACHE[f.stem.upper()] = str(j['name']).strip()[:30]
                except Exception:
                    continue
            print(f"   📚 stock_label 對照表建立完成:{len(_STOCK_NAMES_CACHE)} 檔有中文名")
        except Exception as e:
            print(f"   ⚠️ stock_label 對照表建立失敗:{e}")
    name = _STOCK_NAMES_CACHE.get(str(sym).upper(), '')
    return f"{name} {sym}" if name else str(sym)


def _tpe_now():
    """台北時間(GitHub Actions runner 是 UTC → 這裡轉 +8,修時間顯錯)。"""
    from datetime import timezone, timedelta
    return datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8)))


def _market_direction(macro):
    """簡易大盤方向(對齊前端盤前體檢;紅漲綠跌:偏多🔴 偏空🟢 中性🟡)。"""
    s = 0.0

    def sgn(v):
        try:
            v = float(v)
            return 1 if v > 0 else -1 if v < 0 else 0
        except Exception:
            return 0
    s += sgn(macro.get('sp500_chg_pct')) + sgn(macro.get('nasdaq_chg_pct'))
    try:
        vix = float(macro.get('vix'))
        if vix < 20:
            s += 1
        elif vix > 30:
            s -= 2
        elif vix > 25:
            s -= 1
    except Exception:
        pass
    # 🧪 V79.5.2 外資現貨 ⛔ 不再算進方向分(V79.3.8 App 盤前體檢 / worker 盤前簡報早就拿掉了,這一份漏了 = 陷阱 #37):
    #   premkt_dom_probe 2004~2026:外資現貨對隔天開盤 / 收盤的名次相關每年都 ≈ 0,算進去反而比只看海外不準。
    # 🧪 V79.5.2 對策那句只講開盤(同 App「📌 今天怎麼看」):開盤之後怎麼走 ⛔ 不預測;
    #   以前的「拉回不破可續抱 / 空手別急著接刀 / 等站上昨高」都沒有回測過。
    if s >= 2:
        return ('🔴', '偏多', '隔夜海外偏多,今天多半開高 → 照原本計畫做,⛔ 別在開盤追高;開盤之後怎麼走不預測')
    if s <= -2:
        return ('🟢', '偏空', '隔夜海外偏弱,今天多半開低 → 新買的先縮小部位;手上的照出場規則走,⛔ 不用因為這樣就先賣')
    return ('🟡', '中性', '多空拉扯,今天多半開平 → 照原本計畫做')


def build_summary():
    """組「盤前/盤後 精選摘要」(每天 2 則)。V22 重新設計:只給最有用的 —
    大盤一句話 + 籌碼/技術/型態精選(含股名) + 處置注意;砍掉總經長篇/核彈事件/融資水位噪音。
    """
    macro = load_json("macro_risk.json") or {}
    top_picks = load_json("top_picks.json") or {}
    radar = load_json("radar.json") or {}
    attention = load_json("attention_status.json") or {}

    now = _tpe_now()
    is_pre = 6 <= now.hour < 12   # 台北早上 = 盤前
    title = "🌅 *盤前快報*" if is_pre else "🌆 *盤後精選*"
    lines = [f"{title} _{now.strftime('%m/%d %H:%M')} 台北_", ""]

    # 🌏 今日大盤一句話(白話方向 + 對策)
    emo, dirt, sop = _market_direction(macro)
    vix = macro.get('vix')
    lines.append(f"{emo} *今日大盤:{dirt}*" + (f"　VIX {vix}" if vix is not None else ""))
    lines.append(f"　💡 {sop}")
    lines.append("")

    # 🌟 今日精選(籌碼+基本面):top_picks = 法人淨流入 + 主力建倉 + 營收成長
    picks = (top_picks.get('data') or [])[:5]
    if picks:
        lines.append("🌟 *今日精選*(法人+主力+基本面)")
        for p in picks:
            reasons = '、'.join(str(r) for r in (p.get('reasons') or [])[:2])
            lines.append(f"　▸ {stock_label(p.get('sym', ''))}　{reasons}")
        lines.append("")

    # 🚀 技術/型態強勢:超跌可買(帶白話 flags)+ 飆股 + 底部起漲
    rd = (radar.get('data') or {})
    tech = []
    for x in (rd.get('wrongkill') or [])[:2]:
        fl = '·'.join(str(f) for f in (x.get('flags') or [])[:2])
        tech.append(f"　▸ {stock_label(x.get('sym', ''))}　超跌可留意" + (f"({fl})" if fl else ''))
    for x in (rd.get('surge') or [])[:2]:
        tech.append(f"　▸ {stock_label(x.get('sym', ''))}　🚀 飆股型態(站上均線)")
    for x in (rd.get('bottom') or [])[:1]:
        tech.append(f"　▸ {stock_label(x.get('sym', ''))}　🥣 底部起漲")
    if tech:
        lines.append("🚀 *技術/型態強勢*")
        lines.extend(tech[:5])
        lines.append("")

    # 🏦 法人連 3 日買超(籌碼偏多):外資 / 投信
    fr = (rd.get('foreign3') or [])[:3]
    tr = (rd.get('trust3') or [])[:3]
    if fr or tr:
        lines.append("🏦 *法人連 3 日買超*(籌碼偏多)")
        if fr:
            lines.append("　外資:" + "、".join(stock_label(x.get('sym', '')) for x in fr))
        if tr:
            lines.append("　投信:" + "、".join(stock_label(x.get('sym', '')) for x in tr))
        lines.append("")

    # 🚨 處置注意(精簡:數量 + 前 3 檔名)
    att = (attention.get('stocks') or {})
    disposed = [k for k, v in att.items() if '處置' in (v.get('status') or '')]
    if disposed:
        names = '、'.join(stock_label(s) for s in disposed[:3])
        lines.append(f"🚨 *處置中 {len(disposed)} 檔*:{names}" + (" 等" if len(disposed) > 3 else ""))
        lines.append("　💡 分盤撮合、流動性差,別當沖")
        lines.append("")

    lines.append("_🔔 想收「你的庫存/自選」即時提醒 → App 設定綁定 Telegram_")
    lines.append("_📱 完整分析 [StockAI 終端機](https://xin7355-collab.github.io/StockAI-DB/)_")
    return "\n".join(lines)


def build_watch_alerts():
    """重大事件即時警報(只在「狀態惡化」時發,平日不吵)。⚠️ 沒有排程,只有手動 dispatch 才會跑。
    回傳 list of str,空 list = 今日無事不發。
    🔕 V80.0.9 只描述(同 App V79.3.5 大盤警示、worker 重大事件):`crash_warn_probe` 24 種大盤警示 0 種六關全過
       → ⛔ 不叫人減碼 / 現金為王 / 持股先減 1/3 / 別接刀;一律「手上的照出場規則走、要不要買新的照決策台」。
    """
    alerts = []
    macro = load_json("macro_risk.json") or {}
    bubble = load_json("bubble_warning.json") or {}
    SEP = '━━━━━━━━━━━━━━━━━━━━'
    HOW = "💡 手上的照你的出場規則走;要不要買新的照 App 決策台。這是描述,⛔ 不是叫你賣。"

    # 融資 > 3200 億
    # 🩹 V69.8.4 P0-4:原 margin_balance_billion 是幽靈欄位(無程式寫過→警報從沒發過),
    #    改讀 miner.py build_bubble_warning 真實輸出的 margin_leverage.total_100m(億)
    m = (bubble.get('margin_leverage') or {}).get('total_100m')
    if m is not None and m >= 3200:
        alerts.append(f"⚠️ *融資餘額偏高*\n{SEP}\n📊 融資餘額 *{m} 億*(超過 3200 億):散戶槓桿偏高,大盤拉回時波動會比較大。\n\n{HOW}")

    # VIX > 30
    vix = macro.get('vix')
    if vix is not None and vix > 30:
        alerts.append(f"⚠️ *美股恐慌指數偏高*\n{SEP}\n📊 VIX *{vix}*(超過 30):恐慌很重,這幾天波動會很大。\n\n{HOW}")

    # 期現比警戒
    if str(macro.get('fi_ratio_alert') or '').startswith('⚠️'):
        alerts.append(f"⚠️ *外資期現比異常*\n{SEP}\n📊 {macro['fi_ratio_alert']}\n\n{HOW}")

    return alerts


SEP2 = '━━━━━━━━━━━━━━━━━━━━'
MAX_PICKS = 2          # 一天最多 2 檔(= App `_DECK_TRACK49.picks` / auto_trade MAX_PICKS)
SITE = 'https://xin7355-collab.github.io/StockAI-DB/'


def _rank_picks(picks):
    """= 決策台「今天可以買的」那條篩選(`_deckBuyOf`):只留這套規則的列 → 🧬 排前面 → 這套規則的值
    → 同一檔只留最好那一招 → **🧬 而且這一檔自己不是空頭**(lib_hotrule.deck_pick,auto_trade 同一條)。
    🧬 V80.0.9 以前這裡只排序不擋 → 🧬 不夠 2 檔、或這一檔自己空頭時,照樣推「買點到了」,
       而決策台根本不會列那幾檔(使用者:「一直跌也叫我買,這樣對嗎?」)。test_pbpick_same 跨檔比對。
    ⚠️ 雲端**讀不到**使用者的自選/庫存(那存在手機 localStorage)→ 少了「自己手上的優先」那一層,
       所以推播文案要誠實說「這是全市場排序」。
    """
    return deck_pick(picks, hot_rule(os.getenv('HOT_RULE')), gene_rank(os.getenv('GENE_RANK')))


def _mkt_line(j):
    """🐻 V80.0.9 大盤狀態一行(讀名單裡採礦算好的 `mkt`,= App `_mktBear60` 同一份;⛔ 這裡不另算)。
    只描述:嚴格空頭 = 收盤在 60 日線下而且 20 日線也在 60 日線下。⛔ 不叫人減碼 / 空手。"""
    m = (j or {}).get('mkt') or {}
    b = m.get('bear60')
    f = lambda v: f"{float(v):,.0f}" if isinstance(v, (int, float)) else '—'
    c, ma20, ma60 = m.get('c'), m.get('ma20'), m.get('ma60')
    nums = f"(加權 {f(c)}・20 日線 {f(ma20)}・60 日線 {f(ma60)})"
    if b is True:
        return (f"🐻 大盤*嚴格空頭*{nums}\n"
                f"　App 預設空頭也照買;你若在設定打開「大盤嚴格空頭不開新倉」,這幾天就不買新的。手上的照你的出場規則走。")
    if b is False and isinstance(c, (int, float)) and isinstance(ma60, (int, float)) and c < ma60:
        return f"⚠️ 大盤收盤在 60 日線下,但 20 日線還在 60 日線上 → *還不算空頭*{nums}"
    if b is False:
        return f"➖ 大盤在 60 日線上,不是空頭{nums}"
    return ""


def _pick_line(p, i):
    """一檔的推播內容。⛔ 文案不可出現「開盤買」(V72.9.0 實測那樣少賺一半以上)。
    🧹 V80.0.9 跟 App 尾盤提醒一樣只講怎麼做(V78.3.4 / V79.1.6):⛔ 勝率 / 平均每趟 / 「實測」字樣(研究數字在產業作戰室)。"""
    s = p.get('s')
    trig = p.get('trig')
    loose = int(p.get('loose') or 0)
    stop = p.get('stop')
    t = f"*{i}. {stock_label(s)}* ・ {p.get('k', '')}\n"
    if loose or trig in (None, 0):
        t += "   ▸ 這招不是靠價位觸發,要盤中重算才知道\n"
    else:
        t += f"   ▸ 漲過 *{trig}* 才算成立(昨收 {p.get('c')})\n"
    if stop:
        t += f"   ▸ 停損 {stop}(收盤跌破就走)\n"
    t += "   ▸ 🧬 高位階+高波動\n"
    return t


def build_playbook_brief():
    """【A】盤後推「明日作戰清單」—— 讓使用者不用自己記得開 App 看。"""
    j = load_json("playbook_edge.json")
    if not j:
        print("   ⚠️ 沒有 playbook_edge.json,不發")
        return None
    picks = j.get('picks') or []
    if not picks:
        print("   ✅ 今天全市場一檔都沒有值得做的打法 —— 這本來就是常態,不發")
        return None
    # 🚧 新鮮度守門:⛔ 過期清單絕不推(推了會讓人拿舊觸發價去掛單)
    dd = str(j.get('data_date') or '')[:10]
    try:
        from datetime import date
        gap = (_tpe_now().date() - date(*map(int, dd.split('-')))).days
    except Exception:
        gap = 99
    if gap > 4:
        print(f"   ❌ playbook_edge 資料日 {dd} 已距今 {gap} 天,過期不發")
        return None
    top = _rank_picks(picks)[:MAX_PICKS]
    if not top:
        # 🧬 V80.0.9 名單上沒有「🧬 而且這一檔自己不是空頭」的 → 決策台明天也不會列,⛔ 不推(以前會推非 🧬 / 自己空頭的)
        print("   ✅ 名單上沒有 🧬 而且自己不是空頭的 → 明天決策台也不會列可以買的,不發")
        return None
    ml = _mkt_line(j)
    msg = (f"🎯 *明天的作戰清單*\n{SEP2}\n"
           + (f"{ml}\n\n" if ml else "")
           + f"⭐ *跟 App 決策台同一份:一天最多 2 檔*\n\n")
    for i, p in enumerate(top, 1):
        msg += _pick_line(p, i) + "\n"
    msg += (f"{SEP2}\n"
            f"⛔ *不是叫你明天一開盤就買* —— 要「漲過那個價,而且撐到*尾盤 13:00~13:25* 還站得住」才進場。\n"
            f"⚠️ 這是*全市場*排序,雲端看不到你的自選/庫存 —— App 裡的清單會把你手上的排前面。\n"
            f"👉 {SITE}")
    return msg


def build_eod_triggers():
    """【B】尾盤 13:20 一輪:比對即時價,買點到了就推。

    ⛔ 刻意**只跑一輪**(不是每 5 分鐘):
       ① 無狀態 → 不用維護「今天推過誰」的檔案,也就不可能重複推
       ② 13:20 正是實測有效的進場時窗(13:00~13:28)的中間
    """
    j = load_json("playbook_edge.json")
    q = load_json("live_quotes.json")
    if not j or not q:
        print(f"   ❌ 缺資料(playbook_edge={'有' if j else '無'} / live_quotes={'有' if q else '無'})")
        return None
    # 🚧 即時報價新鮮度:⛔ 舊快照絕不拿來判斷「買點到了」(V73.7.7 的教訓)
    upd = str(q.get('updated') or '')
    now = _tpe_now()
    try:
        from datetime import datetime as _dt
        ts = _dt.fromisoformat(upd)
        age_min = (now - ts).total_seconds() / 60
    except Exception:
        age_min = 9999
    if not (0 <= age_min <= 30):
        print(f"   ❌ 即時報價不新鮮(updated={upd},{age_min:.0f} 分鐘前)→ 不發")
        print("      ⚠️ 這代表盤中快照採礦沒跑到,要去查 live_snapshot,⛔ 不是把守門放寬")
        return None
    data = q.get('data') or {}
    picks = j.get('picks') or []
    hit = []
    # 🧬 V80.0.9 只看決策台「今天可以買的」那 2 檔(⛔ 不再往下補第 3 名以後的 —— App 決策台與自動下單都只看前 2 名)
    top = _rank_picks(picks)[:MAX_PICKS]
    for p in top:
        if int(p.get('loose') or 0):
            continue                      # 這招不是靠價位 → 雲端算不出來,交給 App
        trig = p.get('trig')
        if not trig:
            continue
        row = data.get(str(p.get('s')))
        px = None
        if isinstance(row, dict):
            px = row.get('p') or row.get('c')
        elif isinstance(row, (int, float)):
            px = row
        if px is None:
            continue
        try:
            px = float(px)
        except Exception:
            continue
        if px >= float(trig):
            p = dict(p, _px=px)
            hit.append(p)
        if len(hit) >= MAX_PICKS:
            break
    print(f"   📊 名單 {len(picks)} 筆 → 決策台那 {len(top)} 檔 ・ 報價 {len(data)} 檔 ・ 觸發 {len(hit)} 檔")
    if not hit:
        print("   ✅ 今天沒有買點成立,不發(這是常態,⛔ 不是壞掉)")
        return None
    ml = _mkt_line(j)
    msg = f"⏰ *尾盤買點成立*\n{SEP2}\n" + (f"{ml}\n\n" if ml else "")
    for i, p in enumerate(hit, 1):
        msg += _pick_line(p, i)
        msg += f"   ▸ *現在 {p['_px']}*(已站上觸發價)\n\n"
    msg += (f"{SEP2}\n"
            f"⏰ 現在約 {now:%H:%M} —— 收盤前(*13:00~13:28*)確認還站得住再進;停損照上面那個價,收盤跌破就走。\n"
            f"⚠️ 這是*全市場*排序,雲端看不到你的自選/庫存。\n"
            f"⛔ 一天最多 2 檔。\n"
            f"👉 {SITE}")
    return msg


def main():
    print(f"🚨 alert_system 啟動 — MODE={MODE} / {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    if not BOT_TOKEN or not CHAT_ID:
        print("❌ Telegram 未設定 secrets,跳過(workflow 繼續)")
        sys.exit(0)

    # 🎯 V73.8.5 兩個新模式(使用者要求:「買點到了跟我說,不用一直盯」)
    #    ⛔ 跟舊的 summary/watch 完全分開 —— 那兩個是**大盤層級籠統摘要**,V21.4 已刻意停用。
    if MODE in ("playbook", "eod"):
        msg = build_playbook_brief() if MODE == "playbook" else build_eod_triggers()
        if msg is None:
            print("   ✅ 本輪沒有要發的內容(上面已印原因)")
            sys.exit(0)
        if send_telegram(msg):
            print(f"   📡 已發送 {MODE}({len(msg)} chars)")
        else:
            print(f"   ❌ {MODE} 送出失敗")
        return

    if MODE == "watch":
        # 盤中監聽:只在重大事件發
        alerts = build_watch_alerts()
        if alerts:
            for a in alerts:
                send_telegram(a)
            print(f"   📡 發出 {len(alerts)} 則警報")
        else:
            print("   ✅ 今日無重大事件,不發 Telegram")
    else:
        # 摘要:盤前/盤後固定發
        msg = build_summary()
        if send_telegram(msg):
            print(f"   📡 已發送摘要({len(msg)} chars)")


if __name__ == '__main__':
    main()
