#!/usr/bin/env python3
"""🏛️ 2026-11-25 美國官方關稅動作追蹤 → data/tariff_watch.json(+ 有新的正式公告推 Telegram)

為什麼要有這支:使用者 11/25「川普新 301 關稅請持續追蹤,並且會對股市怎麼影響」→ 問了一次,選
  「App 每天自動收官方公告 + 有新的推 Telegram」。本站原本只有川普發文(trump_posts_miner),沒有「政府真的做了什麼」。

來源:美國聯邦公報(Federal Register)官方 API(免金鑰 JSON;macro_probe which=tariff_src 量過真實格式)
  ① 美國貿易代表署(USTR)的公告:301 調查 / 行動 / 聽證 / 排除清單
  ② 總統文件(行政命令 / 公告)裡講到關稅的
  ③ 「section 232」(商務部國安關稅:半導體、鋼鋁、汽車…)
  一律走 lib_http.Gate(UA 寫明 StockAI-DB、⛔ 偽裝瀏覽器、被擋就停、退避);一輪最多 3 個請求。

輸出 data/tariff_watch.json(v1):
  { v, checked(這一輪)、ok_at(最後一次三個查詢都成功), src, err,
    items:[{id 文件號, date 刊登日, type, kind 中文種類, agency, title 英文原標題, zh 規則組的中文摘要,
            countries 點名的國家(中文), tw 台灣有沒有在裡面, url, eff 生效日, cmt 意見截止, sign 簽署日}],
    upcoming:[{date, what, id, zh}](今天起 60 天內的生效日 / 意見截止 → 財經行事曆 kind tariff),
    pushed:[已經推過 Telegram 的文件號] }
  items 只增不減(以上一份為底,同一個文件號留新的),最多留 MAX_ITEMS 筆、新的在前。

Telegram(⛔ 重複推、⛔ 一次推幾十則):
  - 上一份不存在(第一次跑 / 檔案掉了)→ 全部記成「已推過」、這一輪 ⛔ 推(只建立基準)
  - 之後:沒推過、刊登日在 PUSH_DAYS 天內的才推;送成功才記進 pushed(失敗下一輪再試,過了 PUSH_DAYS 天就不再試)
  - 內容 = 事實(日期・種類・機關・點名哪些國家 / 台灣有沒有在裡面・生效日・原文連結)+ LAB_LINE(實測總表 tariff-policy 那一句)
    + 「手上的照你的出場規則走」;⛔ 買賣字、⛔ 方向(scripts/test_tariff_watch.py 用 lib_retailbad 與行事曆那份禁字掃)

⛔ 只描述:不產生買賣訊號、⛔ 進任何計分。中文摘要是關鍵字規則組的(⛔ AI 翻譯 —— 數字與國名要一字不差)。

跑法:python3 tariff_watch.py [--selftest](環境變數 OUT 預設 data/tariff_watch.json;TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 沒設 = 只寫檔)
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

FR = 'https://www.federalregister.gov/api/v1/documents.json'
USTR_AGENCY = 'trade-representative-office-of-united-states'
# ⚠️ 2026-11-25 實測(macro_probe tariff_src ⓪):'presidential_document_type' 不是合法欄位 → 整個查詢 HTTP 400
#    (第一版三個查詢全部 400 就是它);改用 'subtype'(Proclamation / Executive Order…)。selftest ⓪ 釘住只用實測收的欄位
FIELDS = ['title', 'type', 'abstract', 'document_number', 'html_url', 'publication_date', 'agencies',
          'effective_on', 'comments_close_on', 'action', 'signing_date', 'subtype']
LOOKBACK_DAYS = 120     # 每一輪往回抓幾天(第一次跑就有 4 個月的歷史;之後只是重抓同一段,⛔ 越抓越多)
MAX_ITEMS = 200
PUSH_DAYS = 3           # 刊登日在幾天內才推(第一輪之後新出現的;太舊的只記不推)
UPCOMING_DAYS = 60
PER_MSG = 5             # 一則 Telegram 最多列幾筆,其他只寫「還有 N 筆」
# 📋 實測總表 k:'tariff-policy' 的那一句(pl[3])—— scripts/test_tariff_watch.py 逐字比對 pro.html,⛔ 只改一邊
LAB_LINE = '美國正式加徵關稅那幾天,台股之後一個月跟一般同樣幅度的日子差不多,關稅這種消息沒有比較特別。'
HOW_LINE = '手上的照你的出場規則走;⛔ 不用因為一則公告就先賣或追進去。'

# 關鍵字(英文原文)→ 這一筆跟關稅有沒有關;USTR 的委員會開會 / 人事那種 ⛔ 收
RELEVANT = re.compile(r'\b301\b|\b232\b|tariff|dut(?:y|ies)|import|reciprocal|retaliat|excess capacity|overcapacity|'
                      r'exclusion|trade (?:action|agreement|deal|remed)|IEEPA|emergency economic|section 122', re.I)
TOPICS = [   # (英文樣式, 中文) —— 依序比對,最多取 3 個
    (r'\b301\b', '301 條款'), (r'\b232\b', '232 條款'), (r'section 122', '122 條款'), (r'reciprocal', '對等關稅'),
    (r'IEEPA|International Emergency Economic Powers', '緊急經濟權力法'),
    (r'excess capacity|overcapacity', '產能過剩'), (r'semiconductor|chip', '半導體'), (r'steel|aluminum', '鋼鋁'),
    (r'automobile|auto part|vehicle', '汽車'), (r'pharmaceutical|drug', '藥品'), (r'lumber|timber', '木材'),
    (r'copper', '銅'), (r'shipbuild|vessel|maritime', '造船'), (r'critical mineral', '關鍵礦產'),
    (r'exclusion', '排除清單'), (r'fentanyl', '芬太尼'), (r'digital services', '數位服務稅'),
]
COUNTRIES = [   # (英文樣式, 中文);⚠️ 「Taiwan」一定要在(tw 旗標看它)
    (r'\bTaiwan\b', '台灣'), (r"\bChina\b|People'?s Republic of China|\bPRC\b", '中國'), (r'\bJapan\b', '日本'),
    (r'\bKorea\b', '韓國'), (r'European Union|\bEU\b', '歐盟'), (r'Viet ?nam', '越南'), (r'\bMexico\b', '墨西哥'),
    (r'\bCanada\b', '加拿大'), (r'\bIndia\b', '印度'), (r'\bThailand\b', '泰國'), (r'\bMalaysia\b', '馬來西亞'),
    (r'\bIndonesia\b', '印尼'), (r'\bGermany\b', '德國'), (r'\bSwitzerland\b', '瑞士'), (r'\bCambodia\b', '柬埔寨'),
    (r'\bBrazil\b', '巴西'), (r'\bSingapore\b', '新加坡'), (r'\bPhilippines\b', '菲律賓'), (r'United Kingdom', '英國'),
    (r'\bT(?:u|ü)rk(?:ey|iye)\b', '土耳其'), (r'\bBangladesh\b', '孟加拉'), (r'\bIsrael\b', '以色列'), (r'\bNorway\b', '挪威'),
    (r'\bAustralia\b', '澳洲'), (r'South Africa', '南非'), (r'\bNicaragua\b', '尼加拉瓜'),
]
AGENCY_ZH = [(r'Trade Representative', '美國貿易代表署'), (r'Executive Office of the President|President', '白宮'),
             (r'Industry and Security', '商務部工業安全局'), (r'International Trade Administration', '商務部國際貿易局'),
             (r'Commerce', '商務部'), (r'Customs and Border', '海關'), (r'International Trade Commission', '國際貿易委員會')]


def fr_params(per_page=100, agencies=(), types=(), term=None, gte=None):
    p = [('per_page', str(per_page)), ('order', 'newest')] + [('fields[]', f) for f in FIELDS]
    p += [('conditions[agencies][]', a) for a in agencies] + [('conditions[type][]', t) for t in types]
    if term:
        p.append(('conditions[term]', term))
    if gte:
        p.append(('conditions[publication_date][gte]', gte))
    return p


QUERIES = [   # (名字, 參數)—— 一輪三個請求
    ('美國貿易代表署', dict(agencies=[USTR_AGENCY])),
    ('總統文件(關稅)', dict(types=['PRESDOCU'], term='tariff')),
    ('232 條款', dict(term='"section 232"')),
]


def _txt(r):
    return ' '.join(str(r.get(k) or '') for k in ('title', 'abstract', 'action'))


def kind_of(r):
    """中文種類(純函式):行政命令 / 總統公告 / 總統令 / 聽證 / 提案 / 定案 / 排除 / 公告"""
    if str(r.get('type') or '').lower().startswith('presidential'):
        st = str(r.get('subtype') or '').lower()
        return '行政命令' if 'executive order' in st else '總統公告' if 'proclamation' in st else '總統令'
    t = (str(r.get('title') or '') + ' ' + str(r.get('action') or '')).lower()
    if 'hearing' in t:
        return '聽證'
    if re.search(r'exclusion|extension', t) and not re.search(r'notice of action|imposition|increase', t):
        return '排除'
    if re.search(r'notice of action|determination|modification|imposition|increase|final rule|\bfinal\b', t):
        return '定案'
    if re.search(r'initiation|request for (?:public )?comment|proposed|investigation|petition', t):
        return '提案'
    return '公告'


def countries_of(text):
    seen, out = set(), []
    for pat, zh in COUNTRIES:
        if zh not in seen and re.search(pat, text or '', re.I if zh not in ('中國', '台灣') else 0):
            seen.add(zh)
            out.append(zh)
    return out


def topics_of(text):
    out = []
    for pat, zh in TOPICS:
        if zh not in out and re.search(pat, text or '', re.I):
            out.append(zh)
    return out[:3]


def agency_of(r):
    names = ' '.join(str(a.get('name') or a.get('raw_name') or '') for a in (r.get('agencies') or []) if isinstance(a, dict))
    if str(r.get('type') or '').lower().startswith('presidential'):
        return '白宮'
    for pat, zh in AGENCY_ZH:
        if re.search(pat, names, re.I):
            return zh
    return '美國政府'


def norm(r):
    """聯邦公報一筆 → items 的一筆;跟關稅無關 / 缺文件號或日期 → None(純函式)"""
    if not isinstance(r, dict):
        return None
    doc, date = str(r.get('document_number') or '').strip(), str(r.get('publication_date') or '')[:10]
    if not doc or not re.match(r'^\d{4}-\d{2}-\d{2}$', date):
        return None
    text = _txt(r)
    if not RELEVANT.search(text):
        return None
    title = re.sub(r'\s+', ' ', str(r.get('title') or '')).strip()
    cs, tp, kind = countries_of(text), topics_of(text), kind_of(r)
    zh = '・'.join(tp) if tp else '關稅相關'
    zh += f'・{kind}'
    if cs:
        zh += f"(點名 {len(cs)} 個:{'、'.join(cs[:6])}{'…' if len(cs) > 6 else ''})"
    url = str(r.get('html_url') or '')
    if not re.match(r'^https://www\.federalregister\.gov/', url):
        url = f'https://www.federalregister.gov/d/{doc}'
    d10 = lambda k: (str(r.get(k))[:10] if r.get(k) and re.match(r'^\d{4}-\d{2}-\d{2}', str(r.get(k))) else None)
    return {'id': doc, 'date': date, 'type': str(r.get('type') or ''), 'kind': kind, 'agency': agency_of(r),
            'title': title[:300], 'zh': zh, 'countries': cs, 'tw': '台灣' in cs, 'url': url,
            'eff': d10('effective_on'), 'cmt': d10('comments_close_on'), 'sign': d10('signing_date')}


def merge(old_items, new_items, cap=MAX_ITEMS):
    """同一個文件號留新抓的(欄位可能補上生效日);新到舊排;最多 cap 筆(純函式)"""
    m = {x['id']: x for x in (old_items or []) if isinstance(x, dict) and x.get('id')}
    for x in new_items:
        m[x['id']] = x
    return sorted(m.values(), key=lambda x: (x['date'], x['id']), reverse=True)[:cap]


def upcoming_of(items, today):
    """今天起 UPCOMING_DAYS 天內的生效日 / 意見截止(純函式)→ 財經行事曆"""
    t0, t1 = today.isoformat(), (today + timedelta(days=UPCOMING_DAYS)).isoformat()
    out = []
    for x in items:
        for k, what in (('eff', '生效'), ('cmt', '意見截止')):
            d = x.get(k)
            if d and t0 <= d <= t1:
                out.append({'date': d, 'what': what, 'id': x['id'], 'zh': x['zh']})
    return sorted(out, key=lambda z: (z['date'], z['what'], z['id']))


def pick_push(prev, items, today, days=PUSH_DAYS):
    """→ (這一輪要推的, 已推過的 set)。上一份不存在 = 建立基準(全部當成推過、這一輪 ⛔ 推)(純函式)"""
    if not isinstance(prev, dict) or not isinstance(prev.get('items'), list):
        return [], {x['id'] for x in items}
    pushed = set(prev.get('pushed') or [])
    cut = (today - timedelta(days=days)).isoformat()
    return [x for x in items if x['id'] not in pushed and x['date'] >= cut], pushed


def md(s):
    """Telegram(舊版 Markdown)跳脫:_ * ` [ 前面加反斜線"""
    return re.sub(r'([_*`\[])', r'\\\1', str(s))


def fmt_msg(xs):
    """要推的那幾筆 → 一則 Telegram(只講事實 + 實測總表那一句 + 怎麼做;⛔ 買賣字 / 方向)"""
    lines = ['🏛️ *美國官方關稅動作*(聯邦公報)']
    for x in xs[:PER_MSG]:
        md_ = x['date'][5:].replace('-', '/')
        lines.append(f"・{md_} {md(x['kind'])}|{md(x['agency'])}|{md(x['zh'])}")
        extra = []
        if x.get('tw'):
            extra.append('⚠️ 台灣在名單裡')
        if x.get('eff'):
            extra.append(f"生效 {x['eff'][5:].replace('-', '/')}")
        if x.get('cmt'):
            extra.append(f"意見截止 {x['cmt'][5:].replace('-', '/')}")
        if extra:
            lines.append('  ' + ' ・'.join(extra))
        lines.append(f"  {md(x['title'][:160])}")
        lines.append(f"  {md(x['url'])}")
    if len(xs) > PER_MSG:
        lines.append(f'・還有 {len(xs) - PER_MSG} 筆(App「大盤 › 消息面 › 川普」看全部)')
    lines.append(f'📋 {md(LAB_LINE)}')
    lines.append(f'💡 {md(HOW_LINE)}')
    return '\n'.join(lines)


def stable(o):
    return json.dumps({k: o.get(k) for k in ('items', 'upcoming', 'pushed', 'err')}, ensure_ascii=False, sort_keys=True)


def run(gate, prev, now, send=None, log=print):
    """一輪:抓三個查詢 → 合併 → 挑要推的 → (送)→ 回新的那份(純流程;網路 / 送出都由呼叫端給)"""
    today = now.date()
    gte = (today - timedelta(days=LOOKBACK_DAYS)).isoformat()
    got, errs, ok_all = [], [], True
    for name, kw in QUERIES:
        res, why = gate.get(FR, params=fr_params(gte=gte, **kw), expect='json')
        if res is None:
            ok_all = False
            errs.append(f'{name}:{why}')
            continue
        try:
            rs = (res.json() or {}).get('results') or []
        except ValueError:
            ok_all = False
            errs.append(f'{name}:回應不是 JSON')
            continue
        n0 = len(got)
        got += [x for x in (norm(r) for r in rs) if x]
        log(f'  {name}:{len(rs)} 筆,跟關稅有關 {len(got) - n0} 筆')
    prev_items = prev.get('items') if isinstance(prev, dict) else None
    items = merge(prev_items, got)
    todo, pushed = pick_push(prev, items, today)
    sent = []
    if todo and send:
        if send(fmt_msg(todo)):
            sent = [x['id'] for x in todo]
            log(f'  📲 Telegram 推了 {len(sent)} 筆')
        else:
            log(f'  ⚠️ Telegram 沒送出 → 下一輪再試({len(todo)} 筆)')
    elif todo:
        log(f'  ℹ️ 有 {len(todo)} 筆新的,但這一輪不送(沒設 Telegram)')
    pushed = sorted(set(pushed) | set(sent))[-500:]
    stamp = now.strftime('%Y-%m-%dT%H:%M:%SZ')
    out = {'v': 1, 'checked': stamp, 'ok_at': stamp if ok_all else (prev or {}).get('ok_at'),
           'src': 'federalregister.gov(美國聯邦公報官方 API)', 'err': ';'.join(errs) or None,
           'items': items, 'upcoming': upcoming_of(items, today), 'pushed': pushed}
    return out, todo, sent


def main():
    out_path = os.environ.get('OUT', 'data/tariff_watch.json')
    prev = None
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding='utf-8') as f:
                prev = json.load(f)
        except Exception as e:  # noqa: BLE001
            print(f'⚠️ 上一份讀不到({type(e).__name__})→ 當成第一次跑(只建立基準、⛔ 推)')
    import lib_http
    gate = lib_http.Gate(default_gap=1.5, timeout=40)
    send = None
    if os.environ.get('TELEGRAM_BOT_TOKEN') and os.environ.get('TELEGRAM_CHAT_ID'):
        from alert_system import send_telegram
        send = send_telegram
    now = datetime.now(timezone.utc)
    print(f'🏛️ 美國官方關稅動作({now:%Y-%m-%d %H:%M} UTC,往回 {LOOKBACK_DAYS} 天)')
    out, todo, sent = run(gate, prev, now, send)
    if not out['items'] and prev is None and out['err']:
        print(f"❌ 三個查詢都沒拿到、也沒有上一份 → 不寫檔:{out['err']}")
        sys.exit(1)
    changed = prev is None or stable(out) != stable(prev) or \
        (now - datetime.fromisoformat(str(prev.get('checked', '2000-01-01T00:00:00Z')).replace('Z', '+00:00'))).total_seconds() > 12 * 3600
    if not changed:
        out['checked'] = prev.get('checked')   # 沒變 → ⛔ 只為了時間戳推一次 gh-pages
    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    tw = sum(1 for x in out['items'] if x['tw'])
    print(f"  ✅ {len(out['items'])} 筆(點名台灣 {tw} 筆)・接下來 {len(out['upcoming'])} 個日子・要推 {len(todo)} 筆 / 推了 {len(sent)} 筆・"
          f"{'有變 → 部署' if changed else '沒變 → 不部署'}" + (f"・⚠️ {out['err']}" if out['err'] else ''))
    gh = os.environ.get('GITHUB_OUTPUT')
    if gh:
        with open(gh, 'a', encoding='utf-8') as f:
            f.write(f"changed={'1' if changed else '0'}\n")


# ═══════════════════════════ selftest(網路 / 送出都換成假的)═══════════════════════════
def selftest():
    fails = []

    def ok(n, c, x=''):
        print(f"{'✅' if c else '❌'} {n}" + ('' if c else f'  → {x}'))
        if not c:
            fails.append(n)

    # ⓪ 2026-11-25 macro_probe tariff_src ⓪ 一個一個試過、HTTP 200 的欄位(⛔ 用這份以外的 —— 一個不收整個查詢就 400)
    FR_OK = {'title', 'type', 'abstract', 'document_number', 'html_url', 'pdf_url', 'publication_date', 'agencies', 'effective_on',
             'comments_close_on', 'dates', 'action', 'signing_date', 'proclamation_number', 'executive_order_number', 'subtype',
             'president', 'citation', 'excerpts'}
    ok('⓪ 查詢欄位全部是實測收的(presidential_document_type → HTTP 400)', set(FIELDS) <= FR_OK, sorted(set(FIELDS) - FR_OK))
    ok('⓪ 參數:每個欄位一個 fields[]、日期條件 gte', [v for k, v in fr_params(gte='2026-08-01') if k == 'fields[]'] == FIELDS
       and ('conditions[publication_date][gte]', '2026-08-01') in fr_params(gte='2026-08-01'))
    USTR = [{'name': 'Trade Representative, Office of United States', 'raw_name': 'OFFICE OF THE UNITED STATES TRADE REPRESENTATIVE'}]
    R1 = {'document_number': '2026-22001', 'publication_date': '2026-11-24', 'type': 'Notice', 'agencies': USTR,
          'title': 'Notice of Action in the Section 301 Investigations of Acts, Policies, and Practices of Sixteen Economies Related to Structural Excess Capacity',
          'abstract': 'The economies are China, the European Union, Japan, Korea, Taiwan, Vietnam, Mexico, Thailand, Malaysia, India, Indonesia, Switzerland, Cambodia, Germany, Canada and Brazil.',
          'effective_on': '2026-12-15', 'comments_close_on': None, 'html_url': 'https://www.federalregister.gov/documents/2026/11/24/2026-22001/notice-of-action'}
    R2 = {'document_number': '2026-21000', 'publication_date': '2026-11-10', 'type': 'Notice', 'agencies': USTR,
          'title': 'Advisory Committee for Trade Policy and Negotiations; Meeting', 'abstract': 'Notice of a meeting.'}
    R3 = {'document_number': '2026-21500', 'publication_date': '2026-11-18', 'type': 'Presidential Document', 'subtype': 'Proclamation', 'agencies': [{'name': 'Executive Office of the President'}],
          'title': 'Adjusting Imports of Semiconductors Into the United States', 'abstract': 'Section 232 tariff on semiconductors.', 'signing_date': '2026-11-14'}
    R4 = {'document_number': '2026-20000', 'publication_date': '2026-10-01', 'type': 'Notice', 'agencies': USTR,
          'title': 'Notice of Public Hearing: Section 301 Investigation', 'abstract': 'Hearing on excess capacity; Taiwan.', 'comments_close_on': '2026-12-01'}
    a = norm(R1)
    ok('① 301 定案:種類 / 機關 / 點名 16 個含台灣 / 生效日 / 中文摘要', a and a['kind'] == '定案' and a['agency'] == '美國貿易代表署' and len(a['countries']) == 16
       and a['tw'] and a['eff'] == '2026-12-15' and a['zh'].startswith('301 條款・產能過剩・定案(點名 16 個'), a)
    ok('① 委員會開會那種(跟關稅無關)⛔ 收', norm(R2) is None)
    c = norm(R3)
    ok('① 總統文件:種類「總統公告」、機關「白宮」、232 + 半導體、簽署日', c and c['kind'] == '總統公告' and c['agency'] == '白宮' and c['zh'].startswith('232 條款・半導體')
       and c['sign'] == '2026-11-14' and not c['tw'], c)
    ok('① 總統文件的 subtype:行政命令 / 沒寫 → 總統令', kind_of({**R3, 'subtype': 'Executive Order'}) == '行政命令' and kind_of({**R3, 'subtype': None}) == '總統令')
    ok('① 聽證 / 意見截止;沒有文件號或日期 → ⛔ 收', norm(R4)['kind'] == '聽證' and norm(R4)['cmt'] == '2026-12-01'
       and norm({**R1, 'document_number': ''}) is None and norm({**R1, 'publication_date': 'x'}) is None)
    ok('① 「Chinatown」⛔ 算中國、「Taiwanese」⛔ 算台灣(整個字比對)', countries_of('Chinatown Taiwanese') == [] and countries_of('China and Taiwan') == ['台灣', '中國'])
    ok('① 網址不是聯邦公報 → 改成官方短網址', norm({**R1, 'html_url': 'javascript:alert(1)'})['url'] == 'https://www.federalregister.gov/d/2026-22001')
    ok('① kind_of:提案 / 排除 / 公告', kind_of({'title': 'Initiation of Section 301 Investigation; Request for Comments'}) == '提案'
       and kind_of({'title': 'Extension of Certain Exclusions'}) == '排除' and kind_of({'title': 'Section 301 Update'}) == '公告')
    # ② 合併:同一個文件號留新的、新到舊、上限
    old = [dict(a, eff=None), norm(R4)]
    m = merge(old, [a, c])
    ok('② 合併:同一個文件號留新抓的(生效日補上)、新到舊', [x['id'] for x in m] == ['2026-22001', '2026-21500', '2026-20000'] and m[0]['eff'] == '2026-12-15', [x['id'] for x in m])
    ok('② 最多留 MAX_ITEMS 筆', len(merge([dict(a, id=f'2026-{i:05d}', date='2026-01-01') for i in range(300)], [])) == MAX_ITEMS)
    from datetime import date as _d
    up = upcoming_of(m, _d(2026, 11, 25))
    ok('③ 接下來 60 天的生效 / 意見截止(過去的 ⛔ 列)', [(u['date'], u['what']) for u in up] == [('2026-12-01', '意見截止'), ('2026-12-15', '生效')], up)
    # ④ 推播:第一次 = 只建立基準;之後新的推一次;送失敗下一輪再試;太舊 ⛔ 推
    todo, pushed = pick_push(None, m, _d(2026, 11, 25))
    ok('④ 第一次跑(沒有上一份)→ ⛔ 推、全部記成推過', todo == [] and pushed == {x['id'] for x in m})
    prev = {'items': [norm(R4)], 'pushed': [norm(R4)['id']]}
    todo, _ = pick_push(prev, m, _d(2026, 11, 25))
    ok('④ 之後:沒推過而且 3 天內刊登的才推(11/24 那筆推;11/18 那筆太舊只記)', [x['id'] for x in todo] == ['2026-22001'], [x['id'] for x in todo])

    class _Res:
        def __init__(self, j):
            self._j = j

        def json(self):
            return self._j

    class _Gate:
        def __init__(self, pages):
            self.pages, self.calls = pages, []

        def get(self, url, params=None, expect=None):
            self.calls.append(dict(params))
            k = dict(params)
            if k.get('conditions[agencies][]') == USTR_AGENCY:
                return (_Res({'results': [R1, R2, R4]}), '') if self.pages.get('ustr', True) else (None, '斷路:HTTP 403')
            if k.get('conditions[type][]') == 'PRESDOCU':
                return _Res({'results': [R3]}), ''
            return _Res({'results': []}), ''
    sent_msgs = []
    now = datetime(2026, 11, 25, 1, 0, tzinfo=timezone.utc)
    out1, t1, s1 = run(_Gate({}), None, now, send=lambda m: (sent_msgs.append(m), True)[1], log=lambda *a: None)
    ok('⑤ 第一輪(沒有上一份):三個查詢都問、收 3 筆、⛔ 推', len(out1['items']) == 3 and not t1 and not sent_msgs and out1['ok_at'] and out1['err'] is None, (len(out1['items']), t1))
    R5 = dict(R1, document_number='2026-22100', publication_date='2026-11-25', title='Notice of Modification of Section 301 Action: Taiwan')
    g2 = _Gate({})
    g2.get = (lambda base: (lambda url, params=None, expect=None: (_Res({'results': [R5, R1, R2, R4]}), '') if dict(params).get('conditions[agencies][]') == USTR_AGENCY else base(url, params, expect)))(g2.get)
    out2, t2, s2 = run(g2, out1, now + timedelta(hours=6), send=lambda m: (sent_msgs.append(m), True)[1], log=lambda *a: None)
    ok('⑤ 第二輪:新的一筆推一次、記進 pushed', [x['id'] for x in t2] == ['2026-22100'] and s2 == ['2026-22100'] and '2026-22100' in out2['pushed'] and len(sent_msgs) == 1, (t2, s2))
    out3, t3, s3 = run(g2, out2, now + timedelta(hours=12), send=lambda m: (sent_msgs.append(m), True)[1], log=lambda *a: None)
    ok('⑤ 第三輪:同一筆 ⛔ 再推', not t3 and len(sent_msgs) == 1)
    fail_msgs = []
    out4, t4, s4 = run(g2, out1, now + timedelta(hours=6), send=lambda m: (fail_msgs.append(m), False)[1], log=lambda *a: None)
    ok('⑤ 送失敗 → ⛔ 記成推過(下一輪再試)', t4 and not s4 and '2026-22100' not in out4['pushed'])
    out5, _, _ = run(_Gate({'ustr': False}), out1, now, send=None, log=lambda *a: None)
    ok('⑤ 美國貿易代表署被擋 → err 寫原因、舊的 items 保住、ok_at 不前進', out5['err'] and '403' in out5['err'] and len(out5['items']) == 3 and out5['ok_at'] == out1['ok_at'], out5['err'])
    # ⑥ 訊息:只講事實、跳脫、⛔ 買賣字
    msg = sent_msgs[0]
    ok('⑥ 訊息有日期 / 種類 / 機關 / 台灣在名單裡 / 原文連結 / 實測總表那一句 / 怎麼做', '11/25' in msg and '定案' in msg and '美國貿易代表署' in msg
       and '台灣在名單裡' in msg and 'federalregister.gov' in msg and md(LAB_LINE) in msg and md(HOW_LINE) in msg, msg)
    DIRECTIVE = re.compile(r'利多|利空|(?<!先)賣(?!出規則)|進場|加碼|減碼|會漲|會跌|大漲|大跌|風險')
    body = msg.replace(HOW_LINE, '').replace(md(HOW_LINE), '')
    ok('⑥ 除了「怎麼做」那句,⛔ 買賣 / 方向 / 風險字', not DIRECTIVE.search(body), DIRECTIVE.findall(body))
    ok('⑥ Markdown 跳脫(_ * ` [)', md('a_b*c`d[e') == 'a\\_b\\*c\\`d\\[e')
    many = [dict(a, id=f'2026-3{i:04d}') for i in range(8)]
    ok(f'⑥ 一則最多列 {PER_MSG} 筆,其他寫「還有 N 筆」', fmt_msg(many).count('federalregister.gov') == PER_MSG and '還有 3 筆' in fmt_msg(many))
    print(f"\n{'❌ ' + str(len(fails)) + ' 條失敗' if fails else '✅ TARIFF_WATCH_SELFTEST_PASS'}")
    return not fails


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(0 if selftest() else 1)
    main()
