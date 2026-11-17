"""🗓️ 證交所官方休市表(openapi.twse.com.tw holidaySchedule)—— 解析只有這一份。

用的人:miner.py(K 棒「假日幽靈列」判斷,V80.1.9)、macro_miner.py(財經行事曆的休市日 / 連休前後,2026-11-17)。
⛔ 兩邊各寫一份解析:這張表有「開始交易」「最後交易」兩種**有開盤**的列,漏一邊就會把開盤日當休市。
⛔ 不偽裝瀏覽器(V80.1.6 決策):V80.1.9 探針用這種寫明身分的 UA 實測 HTTP 200。
⚠️ 這張表只有「今年」(V80.1.9 實測 2026 年 27 列);颱風假不在表上。
"""
import re

TW_HOLIDAY_URL = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule'
HONEST_UA = 'Mozilla/5.0 (compatible; StockAI-DB miner/1.0; +https://github.com/xin7355-collab/stockai-db)'


def parse_official_closed_named(rows) -> dict:
    """官方休市表 → {'YYYY-MM-DD': 名稱}(只收「沒有交易」的日子)。純函式。
    ⚠️ 名字有「開始交易」「最後交易」的那兩種日子**有**交易 → ⛔ 收;「市場無交易,僅辦理結算交割作業」= 沒交易 → 收。
    週末那幾列照收(週末本來就沒開盤,無害)。日期是民國 1150101 這種;格式不對的列跳過。"""
    out = {}
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, dict):
            continue
        name = str(r.get('Name') or '').strip()
        if '開始交易' in name or '最後交易' in name:
            continue
        m = re.fullmatch(r'(\d{3})(\d{2})(\d{2})', str(r.get('Date') or '').strip())
        if m:
            out[f'{int(m.group(1)) + 1911:04d}-{m.group(2)}-{m.group(3)}'] = name or '台股休市'
    return out


def parse_official_closed(rows) -> set:
    """🗓️ V80.1.9 證交所官方休市表 → {'YYYY/MM/DD', ...}(miner.py 的 K 棒日期格式)。規則同 parse_official_closed_named。"""
    return {d.replace('-', '/') for d in parse_official_closed_named(rows)}
