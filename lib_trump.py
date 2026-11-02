#!/usr/bin/env python3
"""🗽 V80.2.1 川普發文:分類 / 對到台股哪一天 / 文字清理 —— 全 repo 只有這一份。

用的人:
  scripts/trump_post_probe.py(隔天 0050 研究)・scripts/trump_intraday_probe.py(盤中 5 分 K)
  scripts/trump_src_probe.py(雲端探路)・trump_posts_miner.py(每天採礦 → 🗽 川普那一格)
⛔ 別處不准再寫一份關鍵字或「幾點以後算隔天」(陷阱 #37:同一條規則兩份 → 研究跟畫面講的不是同一件事)。

規則(評估紀錄㊵ 2026-09-27 定的,這裡只是搬家,一個字都沒改):
  ① 分類 = 小寫後的關鍵字:關稅 / 台灣 / 晶片 / 中國 / 協議(KW)
  ② 對到台股:台北時間 13:30 以後 → 隔天;09:00 以前 → 當天;09:00~13:30(含)而且當天有開盤 → 盤中(研究剔除)
  ③ 去重:同一分鐘 + 內文前 80 個字一樣 = 同一則
文字清理的想法參考 sstklen/trump-code(MIT License, Copyright (c) 2025-2026 Washin Mura Contributors)
multi_source_fetcher.py 的「latin-1 → utf-8 亂碼修復 + html.unescape」;程式自己寫。

跑法:python3 lib_trump.py --selftest
"""
import bisect
import html
import re
import sys
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

TW = timezone(timedelta(hours=8))
KW = {'tariff': r'\btariffs?\b|\bduties\b', 'taiwan': r'\btaiwan\b', 'chip': r'\bchips?\b|semiconductor|\btsmc\b',
      'china': r'\bchina\b|\bxi\b', 'deal': r'\bdeal\b'}
CLS = tuple(KW)
CLS_ZH = {'tariff': '關稅', 'taiwan': '台灣', 'chip': '晶片', 'china': '中國', 'deal': '協議'}
OPEN_MIN, CLOSE_MIN = 9 * 60, 13 * 60 + 30
_KW_RE = {k: re.compile(rx) for k, rx in KW.items()}
_TAG = re.compile(r'<[^>]+>')
_WS = re.compile(r'\s+')


def classify(text):
    """→ 依 KW 順序的類別清單(小寫後比對;沒有就空清單)"""
    c = (text or '').lower()
    return [k for k in CLS if _KW_RE[k].search(c)]


def fix_mojibake(s):
    """「â€™」這種 utf-8 被當 latin-1 讀的亂碼 → 修回;本來就正常的字串原樣回(編不回去 / 解不出來就不動)"""
    try:
        t = s.encode('latin-1').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s
    return t


def clean_text(s):
    """亂碼修復 → html 跳脫還原 → 去標籤 → 空白收一個"""
    if not s:
        return ''
    t = fix_mojibake(str(s))
    t = html.unescape(_TAG.sub(' ', html.unescape(t)))
    return _WS.sub(' ', t).strip()


def parse_ts(s):
    """ISO(…Z / +00:00 / 沒時區當 UTC)或 RSS 的 RFC 822 → 帶時區的 UTC datetime;讀不出來回 None"""
    if not s:
        return None
    s = str(s).strip()
    try:
        if re.match(r'^\d{4}-\d{2}-\d{2}', s):
            t = datetime.fromisoformat(s.replace('Z', '+00:00').replace(' ', 'T', 1))
        else:
            t = parsedate_to_datetime(s)
    except (ValueError, TypeError):
        return None
    if t is None:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t.astimezone(timezone.utc)


def iso_z(t):
    return t.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def tw_slot(ts):
    """→ (台北日期 'YYYY-MM-DD', 台北分鐘數, 'pre' | 'in' | 'post');讀不出來回 None。⛔ 不管有沒有開盤(那要 K 線)"""
    t = parse_ts(ts)
    if t is None:
        return None
    t = t.astimezone(TW)
    hm = t.hour * 60 + t.minute
    slot = 'pre' if hm < OPEN_MIN else ('post' if hm > CLOSE_MIN else 'in')
    return t.strftime('%Y-%m-%d'), hm, slot


def tw_day(ts, days, open_days=None):
    """發文 → 它影響的「第一個可交易台股日」;盤中發的(當天有開盤)回 None(開盤那一刻還沒發生)。
    days = 排好的交易日清單('YYYY-MM-DD');open_days = 判斷「當天有沒有開盤」用的集合(預設 = days)。
    超過最後一個交易日 → None。"""
    s = tw_slot(ts)
    if s is None:
        return None
    d, hm, slot = s
    od = open_days if open_days is not None else days
    if slot == 'in' and d in od:
        return None
    if slot == 'post':
        d = (datetime.strptime(d, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')
    i = bisect.bisect_left(days, d)
    return days[i] if i < len(days) else None


def dedup_key(created_at, content):
    """同一分鐘 + 內文(小寫)前 80 字 = 同一則"""
    return (str(created_at or '')[:16], (content or '').lower()[:80])


def selftest():
    fails = []

    def ok(name, cond, got=''):
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {got}'))
        if not cond:
            fails.append(name)

    # ① 分類:跟㊵ 那支的正規式一字不差(搬家前後同一份)
    ok('① 關稅 + 中國', classify('China must pay TARIFFS now') == ['tariff', 'china'], classify('China must pay TARIFFS now'))
    ok('① duties 也算關稅', classify('new duties on steel') == ['tariff'])
    ok('① chips / TSMC / semiconductor', classify('TSMC builds chips') == ['chip'] and classify('Semiconductor plants') == ['chip'])
    ok('① Xi 要整個字', classify('President Xi') == ['china'] and classify('taxi drivers') == [], classify('taxi drivers'))
    ok('① deal 要整個字(dealer ⛔)', classify('Great DEAL') == ['deal'] and classify('dealer') == [])
    ok('① Taiwan', classify('Taiwan stole our chip business') == ['taiwan', 'chip'])
    ok('① 空字串', classify('') == [] and classify(None) == [])
    # ② 時間:台北 13:30 之後算隔天、09:00 前當天、盤中剔除
    days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-06']   # 03-05 沒開盤
    ok('② 台北 08:59 → 當天', tw_day('2026-03-03T00:59:00Z', days) == '2026-03-03')
    ok('② 台北 09:00 盤中 → None', tw_day('2026-03-03T01:00:00Z', days) is None)
    ok('② 台北 13:30 整還算盤中', tw_day('2026-03-03T05:30:00Z', days) is None)
    ok('② 台北 13:31 → 隔天', tw_day('2026-03-03T05:31:00Z', days) == '2026-03-04')
    ok('② 沒開盤那天的盤中時段 → 下一個交易日', tw_day('2026-03-05T02:00:00Z', days) == '2026-03-06')
    ok('② 週末 → 下一個交易日', tw_day('2026-03-01T03:00:00Z', days) == '2026-03-02')
    ok('② 超過最後一天 → None', tw_day('2026-03-06T06:00:00Z', days) is None)
    ok('② 讀不出來 → None', tw_day('昨天晚上', days) is None)
    # 決定性對照:不轉時區(把 UTC 當台北)→ 美東晚上 21:00(台北隔天 10:00 盤中)會被當成「當天 13:30 以後 → 隔天」
    naive = '2026-03-03T02:00:00Z'   # 台北 10:00 盤中
    ok('② 決定性對照:轉時區 → 盤中剔除;不轉 → 會被當成開盤前', tw_day(naive, days) is None and tw_slot(naive)[2] == 'in')
    # ③ RSS 的時間格式
    t = parse_ts('Mon, 02 Nov 2026 21:15:00 -0500')
    ok('③ RFC 822 帶時區 → UTC', t is not None and iso_z(t) == '2026-11-03T02:15:00Z', t)
    ok('③ 沒時區的 ISO 當 UTC', iso_z(parse_ts('2026-11-03 02:15:00')) == '2026-11-03T02:15:00Z')
    ok('③ +00:00 / Z 一樣', parse_ts('2026-11-03T02:15:00+00:00') == parse_ts('2026-11-03T02:15:00.000Z'))
    ok('③ tw_slot 台北日期 / 分鐘', tw_slot('2026-11-03T02:15:00Z') == ('2026-11-03', 615, 'in'))
    # ④ 文字清理
    ok('④ 亂碼修復', clean_text('Itâ\u0080\u0099s great') == 'It’s great', clean_text('Itâ\u0080\u0099s great'))
    ok('④ 正常的 é 不動', clean_text('Café') == 'Café')
    ok('④ emoji 不動', clean_text('Great 🇺🇸') == 'Great 🇺🇸')
    ok('④ html 跳脫 + 標籤', clean_text('<p>A &amp; B</p><br/>C') == 'A & B C', clean_text('<p>A &amp; B</p><br/>C'))
    ok('④ 雙重跳脫的標籤也拿掉', clean_text('&lt;p&gt;Hi&lt;/p&gt;') == 'Hi', clean_text('&lt;p&gt;Hi&lt;/p&gt;'))
    # ⑤ 去重鍵
    ok('⑤ 同一分鐘同內文 = 同一則', dedup_key('2026-03-03T01:00:59Z', 'ABC') == dedup_key('2026-03-03T01:00:00.000Z', 'abc'))
    ok('⑤ 不同分鐘 = 不同則', dedup_key('2026-03-03T01:01:00Z', 'abc') != dedup_key('2026-03-03T01:00:00Z', 'abc'))
    print(f'\n{"✅ 全部通過" if not fails else "❌ " + str(len(fails)) + " 條沒過"}')
    return 0 if not fails else 1


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    print('用法:python3 lib_trump.py --selftest')
