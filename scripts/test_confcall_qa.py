#!/usr/bin/env python3
"""🎤 V79.7.6 法說會問答重點(confcall_qa.py)—— 假網路 + 假 Groq,走正式入口 run()

釘住:
  ① 最近 4 季:有逐字稿的兩季整理出來、沒有逐字稿 / 季度頁 404 的寫進 todo(⛔ 當錯、⛔ 消失)
  ② 只存機構名(⛔ 分析師人名)、⛔ 英文原句漏出去(整份產物 + log 都查)
  ③ ⭐ 數字核對:AI 編的數字那句丟掉、記 drop;決定性對照:關掉核對 → 編的那句留下來
  ④ 冪等:已經整理過的季 ⛔ 重新下載、⛔ 重叫 AI
  ⑤ 認不出講者 → 那一季 ⛔ 發佈、todo 寫原因、rc=1;log 只印職稱那段(⛔ 人名)
  ⑥ AI 沒回的題目:下一輪只補那幾題、補到 RETRY_MAX 次就停
  ⑦ 404 換模型、429 換下一把金鑰
  ⑧ 舊檔讀壞了 → rc=1、⛔ 覆蓋
  ⑨ dry:⛔ 寫檔、⛔ 叫 AI
  ⑩ 法說會日期從逐字稿第一頁
"""
import io
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
TMP = Path(tempfile.mkdtemp(prefix='ccqa_'))
os.environ['DATA_DIR'] = str(TMP / 'data')
import confcall_qa as Q  # noqa: E402
import confcall_deck as cd  # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(extra)[:300]}'))
    if not cond:
        fails.append(name)


def mini_pdf(pages):
    """手寫一份最小的 PDF(Helvetica、ASCII;同 test_confcall_deck)—— 讓 pdftotext / pypdf 真的跑一次抽字。"""
    objs = []
    n = len(pages)
    kids = ' '.join(f'{4 + 2 * i} 0 R' for i in range(n))
    objs.append(b'<< /Type /Catalog /Pages 2 0 R >>')
    objs.append(f'<< /Type /Pages /Kids [{kids}] /Count {n} >>'.encode())
    objs.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    for i, lines in enumerate(pages):
        ops = ['BT', '/F1 10 Tf', '40 760 Td']
        for j, ln in enumerate(lines):
            if j:
                ops.append('0 -16 Td')
            ops.append('(' + ln.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)') + ') Tj')
        ops.append('ET')
        stream = '\n'.join(ops).encode()
        objs.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {5 + 2 * i} 0 R >>'.encode())
        objs.append(b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream')
    out = io.BytesIO()
    out.write(b'%PDF-1.4\n')
    offs = []
    for k, o in enumerate(objs):
        offs.append(out.tell())
        out.write(f'{k + 1} 0 obj\n'.encode() + o + b'\nendobj\n')
    x = out.tell()
    out.write(f'xref\n0 {len(objs) + 1}\n0000000000 65535 f \n'.encode())
    for o in offs:
        out.write(f'{o:010d} 00000 n \n'.encode())
    out.write(f'trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n'.encode())
    return out.getvalue()


CO = 'Taiwan Semiconductor Manufacturing Co Ltd'
PRES = (['Taiwan Semiconductor Manufacturing Co Ltd (2330.TW)', 'Q3 2026 Earnings Call',
         'EVENT DATE/TIME: OCTOBER 15, 2026 / 6:00AM GMT', 'PRESENTATION', f'Jeff Su - {CO} - Director of IR',
         'Good afternoon and welcome to the third quarter earnings conference.',
         'The Q&A session will follow the prepared remarks today.',
         f'Wendell Huang - {CO} - CFO'] +
        [f'Third quarter revenue increased {10 + k} percent sequentially in US dollar terms.' for k in range(18)])
QA1 = ['QUESTIONS AND ANSWERS', 'Operator', 'The first question comes from Gokul Hariharan.',
       'Gokul Hariharan, JPMorgan Chase & Co, Research Division - Analyst',
       'Can you talk about capex for next year and the margin outlook?',
       f'C.C. Wei - {CO} - Chairman & CEO',
       'We expect capex of US$52 to 56 billion next year.',
       f'Wendell Huang - {CO} - CFO',
       'Long-term gross margin of 56% and higher is achievable.',
       'Operator', 'Next question is from Charlie Chan.',
       'Charlie Chan - Morgan Stanley - Analyst',
       'How fast is the N2 ramp - and what about CoWoS capacity?',
       f'Jeff Su - {CO} - Director of IR',
       'So Charlie is asking about the N2 ramp and CoWoS.',
       f'C.C. Wei - {CO} - Chairman & CEO',
       'N2 is ramping faster than N3 did. CoWoS capacity will double again.']
QA2 = ['Operator', 'Next question is from Brett Simpson.',
       'Brett Simpson, Arete Research Services LLP - Analyst',
       'What is the impact of tariffs on your US fabs?',
       f'C.C. Wei - {CO} - Chairman & CEO',
       'We have not seen any change in customer behavior due to tariffs.',
       'Operator', 'Next question is from Sunny Lin.',
       'Sunny Lin, UBS Investment Bank, Research Division - Analyst',
       'Can you share the AI accelerator revenue growth target?',
       f'Wendell Huang - {CO} - CFO',
       'AI accelerator revenue will grow at a mid-40s percent CAGR.',
       'Operator', 'This concludes the question and answer session.']
PDF_Q3 = mini_pdf([PRES[:24], PRES[24:] + QA1, QA2])
def nocomma(lines):
    """另一種版面:名字跟公司之間只有空白(PDF 粗體名字接公司)、標籤後面帶 [n]。"""
    out = []
    for x in lines:
        lab = re.match(r'^(.+?)(?:, | - )(.+ - [^-]+)$', x)
        out.append(f'{lab.group(1)} {lab.group(2)} [{len(out)}]' if lab and Q.LT.parse_label(x) else x)
    return out


PDF_Q2 = mini_pdf([[x.replace('Q3 2026', 'Q2 2026').replace('OCTOBER 15, 2026', 'JULY 16, 2026') for x in PRES[:24]],
                   nocomma(PRES[24:] + QA1), nocomma(QA2)])
# 講者標籤長得完全不一樣(名字一行、公司一行)→ 認不出講者
PDF_BAD = mini_pdf([PRES[:24], PRES[24:] + ['QUESTIONS AND ANSWERS', 'Gokul Hariharan', 'JPMorgan Chase', 'Can you talk about capex?',
                                            'C.C. Wei', 'We expect capex to grow.'] * 3])
NAMES = ['Gokul', 'Hariharan', 'Charlie Chan', 'Brett Simpson', 'Sunny Lin']
EN_SENT = ['Can you talk about capex', 'We have not seen any change', 'N2 is ramping faster', 'Long-term gross margin']

BASE = 'https://investor.tsmc.com/english/quarterly-results'


def page_html(name):
    return (f'<a href="/english/encrypt/files/encrypt_file/reports/x/TSMC%20{name}%20Transcript.pdf">Transcript</a>'
            f'<a href="/english/encrypt/files/encrypt_file/reports/x/TSMC%20{name}%20Presentation.pdf">Presentation</a>')


class Net:
    def __init__(self, pages, files):
        self.pages, self.files = pages, files
        self.page_calls, self.get_calls = [], []

    def fetch_page(self, url):
        self.page_calls.append(url)
        h = self.pages.get(url)
        return (200, h) if h is not None else (404, '')

    def get(self, url, **kw):
        self.get_calls.append(url)
        for k, b in self.files.items():
            if k in url:
                return b, ''
        return None, 'HTTP 404'


class R:
    def __init__(self, code, body=None, headers=None):
        self.status_code, self._b, self.headers = code, body, headers or {}

    def json(self):
        return self._b


def fake_answer(user):
    """照題目內容回:capex 那題多編一句原文沒有的數字(60 billion 是編的)。"""
    if 'capex' in user:
        items = [{'tag': '資本支出', 'q': '分析師問明年資本支出', 'a': '公司預期明年資本支出 52 到 56 billion 美元'},
                 {'tag': '毛利率', 'q': '分析師問長期毛利率', 'a': '公司說長期毛利率 60% 以上'}]
    elif 'N2' in user:
        items = [{'tag': '先進製程', 'q': 'Charlie Chan 問 N2 量產速度', 'a': '公司說 N2 量產比 N3 快'},
                 {'tag': '先進封裝', 'q': '分析師問 CoWoS 產能', 'a': '公司說 CoWoS 產能會再倍增'}]
    elif 'tariff' in user:
        items = [{'tag': '關稅', 'q': '分析師問關稅對美國廠的影響', 'a': 'We have not seen any change in customer behavior'}]
    else:
        items = [{'tag': 'AI 需求', 'q': '分析師問 AI 加速器營收目標', 'a': '公司說 AI 加速器營收年複合成長 mid-40s 百分比'}]
    return {'choices': [{'message': {'content': json.dumps({'items': items}, ensure_ascii=False)}}]}


class Poster:
    def __init__(self, script=None):
        self.calls, self.script = [], list(script or [])

    def __call__(self, url=None, json=None, headers=None, timeout=None):
        self.calls.append({'model': json.get('model'), 'key': headers['Authorization'][-2:], 'user': json['messages'][1]['content']})
        if self.script:
            code = self.script.pop(0)
            if code != 200:
                return R(code, {}, {'x-ratelimit-reset-tokens': '7.5s'} if code == 429 else None)
        return R(200, fake_answer(json['messages'][1]['content']))


MODELS = ['m-a', 'm-b', 'm-c', 'm-d']


def picker(keys, avoid):
    return next(m for m in MODELS if m not in avoid)


def mk_ai(poster, budget=160):
    return Q.AI(['k1', 'k2'], poster=poster, picker=picker, sleeper=lambda s: None, budget=budget)


def fresh():
    shutil.rmtree(TMP / 'data', ignore_errors=True)
    (TMP / 'data').mkdir(parents=True)
    (TMP / 'data' / 'confcall.json').write_text(json.dumps({'hist': {'2330': ['2026-01-15', '2026-04-16', '2026-07-16', '2026-10-15']}}), encoding='utf-8')


def out_of():
    p = TMP / 'data' / 'cc_qa' / '2330.json'
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else None


PAGES = {f'{BASE}/2026/q3': page_html('3Q26'), f'{BASE}/2026/q2': page_html('2Q26'),
         f'{BASE}/2026/q1': '<a href="/x/TSMC%201Q26%20Presentation.pdf">Presentation</a>'}
FILES = {'3Q26%20Transcript': PDF_Q3, '2Q26%20Transcript': PDF_Q2}

# ── ① ~ ③ 第一輪 ──
fresh()
net = Net(dict(PAGES), dict(FILES))
logs = []
po = Poster()
rc = Q.run(fetch_page=net.fetch_page, fetcher=net, ai=mk_ai(po), today='2026-10-25', log=logs.append)
o = out_of()
ok('① rc=0、產物在', rc == 0 and o is not None, (rc, logs[-5:]))
qs = {x['yq']: x for x in (o or {}).get('quarters', [])}
td = {x['yq']: x['why'] for x in (o or {}).get('todo', [])}
ok('① 有逐字稿的兩季整理出來(2026Q3 / 2026Q2),沒有的兩季寫進 todo', set(qs) == {'2026Q3', '2026Q2'} and set(td) == {'2026Q1', '2025Q4'}, (list(qs), td))
ok('① 季度頁只有簡報 → todo 講「還沒有逐字稿」(⛔ 當成錯誤)', '還沒有逐字稿' in td.get('2026Q1', ''), td)
q3 = qs.get('2026Q3') or {}
ok('⑩ 法說會日期從逐字稿第一頁(2026-10-15 / 2026-07-16)', q3.get('d') == '2026-10-15' and (qs.get('2026Q2') or {}).get('d') == '2026-07-16',
   (q3.get('d'), (qs.get('2026Q2') or {}).get('d')))
ok('① 認出 4 題(開場 Q&A 那句 ⛔ 當開始)', q3.get('q_n') == 4, q3.get('q_n'))
items = [x for x in q3.get('items', []) if not x.get('skip')]
orgs = {x['org'] for x in items}
ok('② 只存機構名(JPMorgan Chase / Morgan Stanley / UBS Investment Bank)', {'JPMorgan Chase', 'Morgan Stanley', 'UBS Investment Bank'} <= orgs, orgs)
blob = json.dumps(o, ensure_ascii=False)
ok('② ⛔ 分析師人名出現在產物任何地方', not any(n in blob for n in NAMES), [n for n in NAMES if n in blob])
ok('② ⛔ 英文原句出現在產物任何地方', not any(s in blob for s in EN_SENT), [s for s in EN_SENT if s in blob])
vals = ' '.join(x['q'] + ' ' + x['a'] for x in items)
ok('② ⛔ 一串 6 個英文字(原句漏出來)', not Q._EN_RUN.search(vals), Q._EN_RUN.search(vals))
ok('③ ⭐ 數字核對:原文有的(52 到 56)留下、編的(60%)整句丟', any('52 到 56' in x['a'] for x in items) and not any('60%' in x['a'] for x in items)
   and q3.get('drop', 0) >= 1, (q3.get('drop'), vals[:200]))
ok('② 英文那一句(關稅那題的回答)整句丟、記 lang', q3.get('lang', 0) >= 1 and not any(x['tag'] == '關稅與地緣' for x in items), q3.get('lang'))
ok('② 人名換成「分析師」', any(x['tag'] == '先進製程' and x['q'].startswith('分析師') for x in items), [x['q'] for x in items])
ok('① 分類一律在固定清單裡;誰答的寫中文職稱', all(x['tag'] in Q.TAGS for x in items) and {x['by'] for x in items} <= {'董事長', '財務長', '總裁', '發言人', '公司'},
   ({x['tag'] for x in items}, {x['by'] for x in items}))
ok('① 主持人(發言人)轉述 ⛔ 當成回答的人:N2 那題寫董事長', any(x['tag'] == '先進製程' and x['by'] == '董事長' for x in items))
ok('① 題目被丟光的記 skip(⛔ 下一輪重叫)', any(x.get('skip') for x in q3.get('items', [])))
q2i = [x for x in (qs.get('2026Q2') or {}).get('items', []) if not x.get('skip')]
ok('① 另一種版面(名字跟公司只隔空白、帶 [n])照樣認出 4 題、機構名對', (qs.get('2026Q2') or {}).get('q_n') == 4
   and {'JPMorgan Chase', 'Morgan Stanley', 'UBS Investment Bank'} <= {x['org'] for x in q2i}, ((qs.get('2026Q2') or {}).get('q_n'), {x['org'] for x in q2i}))
ok('① 每一季都有官方原文連結', all(x.get('url', '').startswith('https://investor.tsmc.com/') for x in qs.values()))
logtxt = '\n'.join(map(str, logs))
ok('② log ⛔ 印人名 / 英文原句', not any(n in logtxt for n in NAMES) and not any(s in logtxt for s in EN_SENT),
   [n for n in NAMES + EN_SENT if n in logtxt])

# ── ③ 決定性對照:關掉數字核對 → 編的那句留下來 ──
fresh()
orig_gate = cd.num_gate
cd.num_gate = lambda text, source: []
try:
    Q.run(fetch_page=Net(dict(PAGES), dict(FILES)).fetch_page, fetcher=Net(dict(PAGES), dict(FILES)), ai=mk_ai(Poster()), today='2026-10-25', log=lambda *a: None)
finally:
    cd.num_gate = orig_gate
oc = out_of()
it_c = [x for x in {q['yq']: q for q in oc['quarters']}['2026Q3']['items'] if not x.get('skip')]
ok('③ ⭐ 決定性對照:關掉數字核對 → 「60%」那句留下來(證明是核對擋掉的)', any('60%' in x['a'] for x in it_c), [x['a'] for x in it_c])

# ── ④ 冪等 ──
fresh()
net1 = Net(dict(PAGES), dict(FILES))
Q.run(fetch_page=net1.fetch_page, fetcher=net1, ai=mk_ai(Poster()), today='2026-10-25', log=lambda *a: None)
before = out_of()
net2 = Net(dict(PAGES), dict(FILES))
po2 = Poster()
rc2 = Q.run(fetch_page=net2.fetch_page, fetcher=net2, ai=mk_ai(po2), today='2026-10-25', log=lambda *a: None)
after = out_of()
ok('④ 第二輪:整理過的兩季 ⛔ 重新下載、⛔ 重叫 AI', rc2 == 0 and not net2.get_calls and not po2.calls, (net2.get_calls, len(po2.calls)))
ok('④ 第二輪只問還沒有逐字稿的那兩季的季度頁', all(('2026/q1' in u or '2025/q4' in u) for u in net2.page_calls) and net2.page_calls, net2.page_calls)
ok('④ 兩季的內容一個字都沒變', {q['yq']: q['items'] for q in before['quarters']} == {q['yq']: q['items'] for q in after['quarters']})

# ── ⑥ AI 沒回的題目:下一輪只補那幾題 ──
fresh()
net3 = Net({f'{BASE}/2026/q3': page_html('3Q26')}, {'3Q26%20Transcript': PDF_Q3})
po3 = Poster(script=[500] * 12)            # 前 12 次全部 500 → 第 1 題沒回(一題最多試 2 把 × 2 輪 = 4 次)
Q.run(fetch_page=net3.fetch_page, fetcher=net3, ai=mk_ai(po3, budget=1), today='2026-10-25', log=lambda *a: None)
o6 = out_of()
q6 = {q['yq']: q for q in o6['quarters']}['2026Q3']
ok('⑥ 這一輪 AI 只給 1 次而且失敗 → 4 題都記成沒回(miss=4)、tries=1', q6['miss'] == 4 and q6['tries'] == 1 and not q6['items'], (q6['miss'], q6['tries']))
po4 = Poster()
Q.run(fetch_page=net3.fetch_page, fetcher=net3, ai=mk_ai(po4), today='2026-10-25', log=lambda *a: None)
q6b = {q['yq']: q for q in out_of()['quarters']}['2026Q3']
ok('⑥ 下一輪補齊(miss=0、tries=2)、AI 叫 4 次', q6b['miss'] == 0 and q6b['tries'] == 2 and len(po4.calls) == 4, (q6b['miss'], q6b['tries'], len(po4.calls)))
# 補一半:這一輪只給 2 次 AI → 前 2 題做好、後 2 題沒回 → 下一輪只叫 2 次、⛔ 重複
fresh()
Q.run(fetch_page=net3.fetch_page, fetcher=net3, ai=mk_ai(Poster(), budget=2), today='2026-10-25', log=lambda *a: None)
qh = {q['yq']: q for q in out_of()['quarters']}['2026Q3']
po6 = Poster()
Q.run(fetch_page=net3.fetch_page, fetcher=net3, ai=mk_ai(po6), today='2026-10-25', log=lambda *a: None)
qh2 = {q['yq']: q for q in out_of()['quarters']}['2026Q3']
ik = [(x['i'], x.get('k', 0)) for x in qh2['items']]
ok('⑥ 做了一半(miss=2)→ 下一輪只叫 AI 2 次(⛔ 已做好的題目重叫)、題目 ⛔ 重複', qh['miss'] == 2 and len(po6.calls) == 2
   and len(ik) == len(set(ik)) and qh2['miss'] == 0, (qh['miss'], len(po6.calls), ik))
# 補滿 RETRY_MAX 次就停
p = TMP / 'data' / 'cc_qa' / '2330.json'
j = json.loads(p.read_text(encoding='utf-8'))
for q in j['quarters']:
    q['miss'], q['tries'] = 2, Q.RETRY_MAX
p.write_text(json.dumps(j, ensure_ascii=False), encoding='utf-8')
net5 = Net({f'{BASE}/2026/q3': page_html('3Q26')}, {'3Q26%20Transcript': PDF_Q3})
po5 = Poster()
Q.run(fetch_page=net5.fetch_page, fetcher=net5, ai=mk_ai(po5), today='2026-10-25', log=lambda *a: None)
ok('⑥ 補到 RETRY_MAX 次 → ⛔ 再下載、⛔ 再叫 AI', not net5.get_calls and not po5.calls, (net5.get_calls, len(po5.calls)))

# ── ⑦ 404 換模型、429 換下一把 ──
fresh()
po7 = Poster(script=[404, 429])
net7 = Net({f'{BASE}/2026/q3': page_html('3Q26')}, {'3Q26%20Transcript': PDF_Q3})
waits7 = []
ai7 = Q.AI(['k1', 'k2'], poster=po7, picker=picker, sleeper=waits7.append)
Q.run(fetch_page=net7.fetch_page, fetcher=net7, ai=ai7, today='2026-10-25', log=lambda *a: None)
ok('⑦ 404 → 換下一個模型(m-a → m-b)', po7.calls[0]['model'] == 'm-a' and po7.calls[1]['model'] == 'm-b' and ai7.model == 'm-b', [c['model'] for c in po7.calls[:3]])
ok('⑦ 429 → 換下一把金鑰', po7.calls[1]['key'] != po7.calls[2]['key'], [c['key'] for c in po7.calls[:3]])
ok('⑦ 429 → 照 Groq 給的秒數等(7.5 秒;⛔ 只等 1 秒)', 7.5 in waits7, waits7)
ok('⑦ 產物記下真的回答的模型', {q['yq']: q for q in out_of()['quarters']}['2026Q3']['model'] == 'm-b')

# ── ⑤ 認不出講者 ──
fresh()
net8 = Net({f'{BASE}/2026/q3': page_html('3Q26')}, {'3Q26%20Transcript': PDF_BAD})
logs8 = []
po8 = Poster()
rc8 = Q.run(fetch_page=net8.fetch_page, fetcher=net8, ai=mk_ai(po8), today='2026-10-25', log=logs8.append)
o8 = out_of()
ok('⑤ 認不出講者 → 那一季 ⛔ 發佈、⛔ 叫 AI', not (o8 or {}).get('quarters') and not po8.calls, ((o8 or {}).get('quarters'), len(po8.calls)))
ok('⑤ todo 寫原因(講者認不出來)', any('講者認不出來' in t['why'] for t in (o8 or {}).get('todo', [])), (o8 or {}).get('todo'))
ok('⑤ 這一輪下載到的逐字稿全部解析不了(另外三季只是還沒有)→ rc=1(紅燈:版面可能變了)', rc8 == 1, rc8)
lt8 = '\n'.join(map(str, logs8))
ok('⑤ log 印版面長相但 ⛔ 印人名', '版面長相' in lt8 and not any(n in lt8 for n in NAMES), lt8[-400:])
# 只有那一季要做 → 全部解析不了 → rc=1
fresh()
(TMP / 'data' / 'cc_qa').mkdir(parents=True, exist_ok=True)
(TMP / 'data' / 'cc_qa' / '2330.json').write_text(json.dumps({'quarters': [
    {'yq': y, 'y': int(y[:4]), 'q': int(y[-1]), 'items': [], 'miss': 0, 'tries': 1} for y in ('2026Q2', '2026Q1', '2025Q4')]}), encoding='utf-8')
rc9 = Q.run(fetch_page=net8.fetch_page, fetcher=net8, ai=mk_ai(Poster()), today='2026-10-25', log=lambda *a: None)
ok('⑤ 只剩那一季要做、解析不了 → rc=1', rc9 == 1, rc9)
ok('⑤ 紅燈那輪 ⛔ 把舊的三季弄丟', {q['yq'] for q in out_of()['quarters']} == {'2026Q2', '2026Q1', '2025Q4'})

# ── ⑧ 舊檔讀壞了 ──
fresh()
(TMP / 'data' / 'cc_qa').mkdir(parents=True, exist_ok=True)
bad = TMP / 'data' / 'cc_qa' / '2330.json'
bad.write_text('{"quarters": [ {"yq": "2026', encoding='utf-8')
rc10 = Q.run(fetch_page=Net(dict(PAGES), dict(FILES)).fetch_page, fetcher=Net(dict(PAGES), dict(FILES)), ai=mk_ai(Poster()), today='2026-10-25', log=lambda *a: None)
ok('⑧ 舊檔讀壞了 → rc=1、⛔ 覆蓋', rc10 == 1 and bad.read_text(encoding='utf-8') == '{"quarters": [ {"yq": "2026', rc10)

# ── ⑨ dry ──
fresh()
Q.DRY = True
try:
    po11 = Poster()
    logs11 = []
    Q.run(fetch_page=Net(dict(PAGES), dict(FILES)).fetch_page, fetcher=Net(dict(PAGES), dict(FILES)), ai=mk_ai(po11), today='2026-10-25', log=logs11.append)
finally:
    Q.DRY = False
ok('⑨ dry:⛔ 寫檔、⛔ 叫 AI', out_of() is None and not po11.calls, (out_of(), len(po11.calls)))
lt11 = '\n'.join(map(str, logs11))
ok('⑨ dry 印解析統計(幾題 / 機構 / 誰答)且 ⛔ 人名', '4 題' in lt11 and 'JPMorgan Chase' in lt11 and not any(n in lt11 for n in NAMES), lt11[-500:])

shutil.rmtree(TMP, ignore_errors=True)
print(f'\n{"✅ 全部通過" if not fails else "❌ 失敗 " + str(len(fails)) + " 條"}')
sys.exit(1 if fails else 0)
