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
    try:
        fspot = float(macro.get('fi_spot_net'))
        if fspot > 0:
            s += 1
        elif fspot < -200:
            s -= 1
    except Exception:
        pass
    if s >= 2:
        return ('🔴', '偏多', '順勢偏多,開高別追、拉回不破可續抱')
    if s <= -2:
        return ('🟢', '偏空', '偏空防守,手上有貨顧停損、空手別急著接刀')
    return ('🟡', '中性', '方向未定,等站上昨高或跌破昨低再表態')


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
    """重大事件即時警報(只在「狀態惡化」時發,平日不吵)。
    回傳 list of str,空 list = 今日無事不發。
    """
    alerts = []
    macro = load_json("macro_risk.json") or {}
    bubble = load_json("bubble_warning.json") or {}

    # V21.3 ── 統一模板格式(三段式:核心數字 / 操作建議 / 為什麼)
    SEP = '━━━━━━━━━━━━━━━━━━━━'

    # 融資 > 3200 億 ★★★
    m = bubble.get('margin_balance_billion')
    if m is not None and m >= 3200:
        alerts.append(
            f"🚨 *【融資爆量警報 ★★★】*\n{SEP}\n"
            f"📊 融資餘額 *{m} 億* (超過 3200 億警戒線)\n\n"
            f"🎯 *操作建議*\n"
            f"  ▸ 持有者:減碼槓桿(融資戶先還款)\n"
            f"  ▸ 空手者:觀望,別追高\n"
            f"  ▸ 注意盤中急殺風險(融資斷頭引發雪崩)\n\n"
            f"💡 *為什麼?*\n"
            f"  ① 散戶槓桿過高,大盤拉回易引發多殺多\n"
            f"  ② 歷史高點前融資都先衝高(末升段警訊)\n"
            f"  ③ 主力常在融資爆量時偷偷出貨"
        )

    # VIX > 30 ★★★
    vix = macro.get('vix')
    if vix is not None and vix > 30:
        alerts.append(
            f"🚨 *【恐慌指數爆表 ★★★】*\n{SEP}\n"
            f"📊 VIX *{vix}* (突破 30 = 末日恐慌)\n\n"
            f"🎯 *操作建議*\n"
            f"  ▸ 持有減 50% → 現金為王\n"
            f"  ▸ 避開:航運/金融/中小型題材\n"
            f"  ▸ 防禦:電信/民生(中華電/統一)\n\n"
            f"💡 *為什麼?*\n"
            f"  ① VIX > 30 歷史對應股市大底前後 1-2 週\n"
            f"  ② 全球避險,熱錢撤離新興市場\n"
            f"  ③ 別接刀,等紅 K 反包再考慮"
        )

    # 期現比警戒 ★★
    if macro.get('fi_ratio_alert', '').startswith('⚠️'):
        alerts.append(
            f"⚠️ *【外資期現異常 ★★】*\n{SEP}\n"
            f"📊 {macro['fi_ratio_alert']}\n\n"
            f"🎯 *操作建議*\n"
            f"  ▸ 主力出貨訊號明確,持股先減 1/3\n"
            f"  ▸ 新單暫緩,等期現比回正常\n"
            f"  ▸ 留意明日盤中外資是否續空"
        )

    return alerts


def main():
    print(f"🚨 alert_system 啟動 — MODE={MODE} / {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    if not BOT_TOKEN or not CHAT_ID:
        print("❌ Telegram 未設定 secrets,跳過(workflow 繼續)")
        sys.exit(0)

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
