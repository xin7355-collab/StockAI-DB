"""
通用型情報監聽雷達 (universal_radar.py)
- 監聽多個 RSS Feed
- 關鍵字過濾命中文章
- Groq AI 利多/利空/中立 情緒判讀
- 輸出 data/radar_news.json 供前端 UI 渲染

環境變數：
- GROQ_API_KEY: Groq AI 金鑰（必填，缺則全部標記為中立）
"""
import os
import json
import time
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import feedparser
from pathlib import Path
from datetime import datetime

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL   = "llama-3.1-8b-instant"

# 【防禦機制】建立全域連線池與自動退避重試
http_session = requests.Session()
retry_strategy = Retry(
    total=3,
    backoff_factor=1.5,
    status_forcelist=[500, 502, 503, 504]
)
http_session.mount("https://", HTTPAdapter(max_retries=retry_strategy))

RSS_SOURCES = {
    "科技新報":         "https://technews.tw/feed/",
    "鉅亨網台股":       "https://www.cnyes.com/rss/cat/tw_stock",
    "MoneyDJ 即時新聞": "https://www.moneydj.com/RSS/RSSNews.aspx",
    "Reddit r/stocks":  "https://www.reddit.com/r/stocks/.rss",
    # PTT RSSHub 預留（自架 rsshub instance 後解開）
    # "PTT Stock":      "https://rsshub.app/ptt/stock",
}

KEYWORDS = [
    "砍單", "急單", "擴產", "良率", "滿載", "停機",
    "缺貨", "庫存", "出貨", "轉單", "降價",
    "漲停", "跌停", "破底", "新高",
    "處置股", "減資", "增資", "重訊",
]

DATA_DIR       = Path("data")
DATA_DIR.mkdir(exist_ok=True)
OUTPUT_FILE    = DATA_DIR / "radar_news.json"
MAX_PER_SOURCE = 30
SUMMARY_MAXLEN = 300


def analyze_sentiment(title: str, summary: str) -> tuple:
    """呼叫 Groq AI 進行利多/利空判讀，回傳 (sentiment, reason)。
    遇 429 自動退避重試，最終失敗 fallback 為「中立」。"""
    if not GROQ_API_KEY:
        return ("中立", "未設定 GROQ_API_KEY")

    user_prompt = (
        f"你是一個專業的財經情緒分析系統。請分析以下台股情報，判斷其對個股或供應鏈的影響為【利多】、【利空】或【中立】。\n\n"
        f"標題：{title}\n"
        f"摘要：{summary[:SUMMARY_MAXLEN]}\n\n"
        f"輸出要求：\n"
        f"1. 必須輸出純 JSON 格式，絕對不要包含 Markdown backticks (如 ```json)。\n"
        f"2. 格式範例：{{\"sentiment\": \"利多\", \"reason\": \"此處填寫20字內具體原因\"}}"
    )
    
    payload = {
        "model":           GROQ_MODEL,
        "messages":        [{"role": "user", "content": user_prompt}],
        "max_tokens":      120,
        "temperature":     0.3,
        "response_format": {"type": "json_object"},
    }
    
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type":  "application/json",
    }

    for attempt in range(3):
        try:
            # 【修復】改用 http_session 享有底層連線池，減少 SSL 握手開銷
            res = http_session.post(GROQ_URL, json=payload, headers=headers, timeout=20)
            if res.status_code == 429:
                # 【修復】Groq 限流恢復較慢，將重試秒數大幅拉長至 5s, 10s, 15s
                wait = 5 * (attempt + 1)
                print(f"  ⚠️ Groq 429 限流（第 {attempt+1} 次），{wait}s 後重試")
                time.sleep(wait)
                continue
            if res.status_code != 200:
                print(f"  ⚠️ Groq HTTP {res.status_code}: {res.text[:120]}")
                return ("中立", f"API 錯誤 {res.status_code}")
                
            content = res.json()["choices"][0]["message"]["content"].strip()
            parsed  = json.loads(content)
            sentiment = parsed.get("sentiment", "中立")
            if sentiment not in ("利多", "利空", "中立"):
                sentiment = "中立"
            reason = str(parsed.get("reason", "")).strip()[:30] or "AI 未提供說明"
            return (sentiment, reason)
            
        except Exception as e:
            print(f"  ⚠️ Groq 第 {attempt+1} 次例外：{e}")
            if attempt < 2:
                time.sleep(1)

    return ("中立", "AI 暫時無法分析")


def fetch_feed(source_name: str, url: str) -> list:
    """抓取單一 RSS Feed，回傳命中關鍵字的文章列表"""
    matched = []
    try:
        feed = feedparser.parse(url, request_headers={'User-Agent': 'Mozilla/5.0 universal_radar/1.0'})
        if not feed.entries:
            if feed.bozo:
                print(f"  ⚠️ {source_name} parse 失敗：{feed.bozo_exception}")
            return matched

        for entry in feed.entries[:MAX_PER_SOURCE]:
            title   = entry.get("title", "") or ""
            summary = entry.get("summary", "") or entry.get("description", "") or ""
            combined = title + " " + summary
            hits = [k for k in KEYWORDS if k in combined]
            if not hits:
                continue
            matched.append({
                "source_name":      source_name,
                "title":            title,
                "link":             entry.get("link", ""),
                "published_time":   entry.get("published", "") or entry.get("updated", ""),
                "matched_keywords": hits,
                "_summary":         summary,
            })
        print(f"  📡 {source_name}：總 {len(feed.entries)} 篇，命中 {len(matched)} 篇")
    except Exception as e:
        print(f"  ⚠️ {source_name} 抓取例外：{e}")
    return matched


GLOBAL_NEWS_SOURCES = {
    # Reuters/MarketWatch/CNBC block datacenter IPs (403)
    # Using datacenter-accessible alternatives:
    "BBC Business":  "https://feeds.bbci.co.uk/news/business/rss.xml",
    "Google Finance": "https://news.google.com/rss/search?q=stock+market+economy+finance&hl=en&gl=US&ceid=US:en",
    "Nasdaq News":   "https://www.nasdaq.com/feed/nasdaq-originals/rss.xml",
}
GLOBAL_NEWS_FILE = DATA_DIR / "global_news.json"


def fetch_global_news():
    """抓取全球財經 RSS，用 Groq 批次分析對台股的影響，輸出 data/global_news.json"""
    print("\n📡 全球即時情報採集中...")
    from datetime import timezone, timedelta
    now_utc = datetime.now(timezone.utc)
    cutoff = now_utc - timedelta(hours=48)

    items = []
    for source, url in GLOBAL_NEWS_SOURCES.items():
        try:
            feed = feedparser.parse(url, request_headers={'User-Agent': 'Mozilla/5.0 universal_radar/1.0'})
            count = 0
            for entry in feed.entries[:10]:
                title = (entry.get("title", "") or "").strip()
                link  = entry.get("link", "") or ""
                pub   = entry.get("published", "") or entry.get("updated", "") or ""
                if not title:
                    continue
                items.append({"source": source, "title": title, "url": link, "published": pub})
                count += 1
                if count >= 5:
                    break
            print(f"  {source}: {count} 篇")
        except Exception as e:
            print(f"  ⚠️ {source} 失敗: {e}")

    if not items:
        print("  ⚠️ 無法取得全球新聞")
        return

    # 批次呼叫 Groq 分析每則新聞對台股的影響
    analyzed = []
    for i, item in enumerate(items[:15]):
        impact, level, title_zh = "暫無分析", "neutral", ""
        if GROQ_API_KEY:
            prompt = (
                f"請將以下新聞標題翻譯成繁體中文（20字以內），並用一句話說明對台股的影響，判斷bullish/bearish/neutral。\n"
                f"標題：{item['title']}\n"
                f"輸出純JSON，格式：{{\"title_zh\":\"繁體中文標題\",\"impact\":\"...\",\"impact_level\":\"bullish|bearish|neutral\"}}"
            )
            payload = {
                "model": GROQ_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 100,
                "temperature": 0.3,
                "response_format": {"type": "json_object"},
            }
            headers = {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}
            for attempt in range(3):
                try:
                    res = http_session.post(GROQ_URL, json=payload, headers=headers, timeout=20)
                    if res.status_code == 429:
                        wait = 5 * (attempt + 1)
                        print(f"  ⚠️ Groq 429，{wait}s 後重試")
                        time.sleep(wait)
                        continue
                    if res.status_code == 200:
                        parsed = json.loads(res.json()["choices"][0]["message"]["content"])
                        impact = str(parsed.get("impact", "暫無分析"))[:30]
                        lvl = parsed.get("impact_level", "neutral")
                        level = lvl if lvl in ("bullish", "bearish", "neutral") else "neutral"
                        title_zh = str(parsed.get("title_zh", ""))[:40]
                    break
                except Exception as e:
                    print(f"  ⚠️ Groq 例外: {e}")
                    if attempt < 2:
                        time.sleep(1)
            time.sleep(2.5)

        analyzed.append({**item, "title_zh": title_zh, "impact": impact, "impact_level": level})
        if (i + 1) % 5 == 0:
            print(f"  進度: {i+1}/{min(len(items), 15)}")

    output = {
        "updated": now_utc.strftime("%Y-%m-%d %H:%M UTC"),
        "items": analyzed,
    }
    GLOBAL_NEWS_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ 全球新聞已輸出 {len(analyzed)} 篇 → {GLOBAL_NEWS_FILE}")


def main():
    print("📡 通用型情報監聽雷達啟動")
    print(f"  關鍵字（{len(KEYWORDS)}）：{', '.join(KEYWORDS)}")
    print(f"  情報源（{len(RSS_SOURCES)}）：{', '.join(RSS_SOURCES.keys())}")
    print(f"  Groq Token：{'已設定' if GROQ_API_KEY else '⚠️ 未設定 — 全部將標記為中立'}")

    all_matched = []
    for name, url in RSS_SOURCES.items():
        all_matched.extend(fetch_feed(name, url))
        time.sleep(0.5)

    print(f"\n🎯 共命中 {len(all_matched)} 篇，啟動 AI 情緒判讀")

    results = []
    for i, item in enumerate(all_matched):
        sentiment, reason = analyze_sentiment(item["title"], item["_summary"])
        item.pop("_summary", None)
        item["ai_sentiment"] = sentiment
        item["ai_reason"]    = reason
        results.append(item)
        
        # 【修復】縮排對齊！讓印出進度的邏輯正確包在迴圈內
        if (i + 1) % 5 == 0 or i == len(all_matched) - 1:
            print(f"  進度：{i+1}/{len(all_matched)}（{sentiment} — {reason}）")
        
        # 【致命危機修復】Groq 免費版限制 30 RPM (每分鐘 30 次)。
        # 強制冷卻 2.5 秒 (相當於一分鐘最多 24 次)，確保絕對不會觸發 429 封鎖！
        time.sleep(2.5)

    output = {
        "updated": datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
        "count":   len(results),
        "data":    results,
    }
    OUTPUT_FILE.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"\n✅ 已輸出 {len(results)} 篇 → {OUTPUT_FILE}")

    fetch_global_news()


if __name__ == "__main__":
    main()
