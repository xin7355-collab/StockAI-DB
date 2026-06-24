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


def build_summary():
    """組「盤前/盤後 摘要」訊息(每天 2 則)。"""
    macro = load_json("macro_risk.json") or {}
    bubble = load_json("bubble_warning.json") or {}
    attention = load_json("attention_status.json") or {}
    forecast = load_json("attention_forecast.json") or {}
    radar_matrix = load_json("radar_matrix.json") or {}

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

    # 📅 未來重大事件(14 日視窗,顯示前 6 場)
    events = (macro.get('upcoming_macro_events') or [])[:6]
    if events:
        lines.append("📅 *未來 14 日核彈事件*")
        for ev in events:
            lines.append(f"  · `{ev['date']}` {ev['event']}")
        lines.append("")

    # 📚 朱家泓今日選股(4 大模組,各取前 3 檔)
    rm_data = (radar_matrix.get('data') or {})
    chu_blocks = [
        ('🍀 六六大順',   'chu_perfect6'),
        ('🔥 特別報價',   'chu_top_gainer'),
        ('🥣 底部轉折',   'chu_bottom'),
        ('🚀 5MA飆股',    'chu_riding5ma'),
    ]
    chu_lines = []
    for label, key in chu_blocks:
        picks = (rm_data.get(key) or [])[:3]
        if picks:
            syms = ' '.join(f"`{p.get('sym','')}({p.get('gain',0):+.1f}%)`" for p in picks)
            chu_lines.append(f"  · {label}: {syms}")
    if chu_lines:
        lines.append("📚 *朱家泓今日選股*(各模組前 3 檔)")
        lines.extend(chu_lines)
        lines.append("  💡 _盤後篩選, 隔日參考進場, 跌破 5MA 立停_")
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
