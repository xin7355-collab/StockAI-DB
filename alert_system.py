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


def build_summary():
    """組「盤前/盤後 摘要」訊息(每天 2 則)。"""
    macro = load_json("macro_risk.json") or {}
    bubble = load_json("bubble_warning.json") or {}
    attention = load_json("attention_status.json") or {}
    forecast = load_json("attention_forecast.json") or {}

    now = datetime.now()
    title = "📊 *盤前快報*" if 0 <= now.hour < 9 else "📊 *盤後總結*"

    lines = [f"{title} _{now.strftime('%m/%d %H:%M')}_", ""]

    # 🌐 總經
    us10y = macro.get('us10y_yield')
    vix = macro.get('vix')
    fg = macro.get('fear_greed')
    fi_spot = macro.get('fi_spot_net')
    fi_fut = macro.get('fi_futures_net')
    fi_alert = macro.get('fi_ratio_alert')
    m1b = macro.get('m1b_yoy')
    lines.append("🌐 *全球總經*")
    lines.append(f"  · 美債10Y `{us10y}%` / VIX `{vix}` / 恐慌貪婪 `{fg}`")
    lines.append(f"  · 外資現貨 `{fi_spot} 億` / 期貨 `{fi_fut:+,} 口`" if fi_spot is not None and fi_fut is not None else "  · 外資資料採集中")
    if fi_alert:
        lines.append(f"  · {fi_alert}")
    if m1b is not None:
        lines.append(f"  · 🏦 M1B YoY `{m1b}%`" + (" ⚠️ 熱錢氾濫" if m1b > 5 else ""))
    lines.append("")

    # 💣 融資水位
    margin = bubble.get('margin_balance_billion')
    margin_status = bubble.get('margin_status', '')
    if margin is not None:
        emoji = "🚨" if margin >= 3200 else ("⚠️" if margin >= 2800 else "✅")
        lines.append(f"💣 *融資水位* {emoji}")
        lines.append(f"  · 餘額 `{margin} 億` ({margin_status})")
        lines.append("")

    # 🚨 處置股
    att_stocks = attention.get('stocks', {})
    if att_stocks:
        att_count = sum(1 for v in att_stocks.values() if '處置' in v.get('status', ''))
        notice_count = sum(1 for v in att_stocks.values() if '注意' in v.get('status', ''))
        lines.append(f"🚨 *列管股* 處置 `{att_count}` / 注意 `{notice_count}`")
        # 列前 5 檔處置股代號
        disposed = [k for k, v in att_stocks.items() if '處置' in v.get('status', '')][:5]
        if disposed:
            lines.append(f"  · 處置股: `{', '.join(disposed)}`")
        lines.append("")

    # ⚠️ 處置門檻預估(明日恐達標)
    fc_stocks = forecast.get('stocks', {})
    high_risk = sorted([(k, v) for k, v in fc_stocks.items() if v.get('score', 0) >= 70],
                       key=lambda x: -x[1]['score'])[:5]
    if high_risk:
        lines.append("⚠️ *明日恐達處置門檻*")
        for sym, info in high_risk:
            lines.append(f"  · `{sym}` 分數 `{info['score']}` — {info.get('reasons', ['—'])[0]}")
        lines.append("")

    # 📅 未來重大事件
    events = (macro.get('upcoming_macro_events') or [])[:4]
    if events:
        lines.append("📅 *未來 7 日核彈事件*")
        for ev in events:
            lines.append(f"  · `{ev['date']}` {ev['event']}")
        lines.append("")

    lines.append("_💡 詳細分析請開 [StockAI 終端機](https://xin7355-collab.github.io/StockAI-DB/)_")
    return "\n".join(lines)


def build_watch_alerts():
    """重大事件即時警報(只在「狀態惡化」時發,平日不吵)。
    回傳 list of str,空 list = 今日無事不發。
    """
    alerts = []
    macro = load_json("macro_risk.json") or {}
    bubble = load_json("bubble_warning.json") or {}

    # 融資 > 3200 億
    m = bubble.get('margin_balance_billion')
    if m is not None and m >= 3200:
        alerts.append(f"🚨 *融資爆量警報*\n融資餘額 `{m} 億` 超過 3200 億警戒線\n👉 持有者請減碼槓桿,空手者觀望")

    # VIX > 30
    vix = macro.get('vix')
    if vix is not None and vix > 30:
        alerts.append(f"🚨 *恐慌指數爆表*\nVIX `{vix}` 突破 30 — 系統性風險升溫\n👉 啟動真泡沫對策,持有者減碼")

    # 期現比警戒
    if macro.get('fi_ratio_alert', '').startswith('⚠️'):
        alerts.append(f"⚠️ *外資期現異常*\n{macro['fi_ratio_alert']}\n👉 注意主力出貨訊號")

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
