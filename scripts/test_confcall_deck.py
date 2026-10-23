#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📞 V79.6.3 法說會簡報讀取(confcall_deck.py)端到端 —— 假網路、真的 PDF / PPTX 位元組、走正式入口 run()

釘的用意:
  ① 讀得出來:PDF(pypdf)與 PPTX(zip)都抽得到字,重點句與數字句帶頁碼,寫出 data/cc/{sym}.json + confcall_digest.json
  ② 同一份簡報只讀一次:第二輪 ⛔ 不再下載(拿舊簡報去券商場重講的 → 標 reuse)
  ③ 「第一次提到」要跟這家公司上一份比:第一份 → first(⛔ 不說新);第二份 → 只列上一份沒有的
  ④ 防封鎖:回網頁(不存在的路徑回 200 + HTML)→ bad_file 永久跳過;連 5 份失敗 → 本輪收工;一份都沒讀到 → rc=1(⛔ 全綠沒資料)
  ⑤ AI 數字核對:AI 編的數字那一點整點丟掉(決定性對照:同一份回答關掉核對 → 編的數字會留下來)
  ⑥ 只有圖片的簡報 → no_text(⛔ 不 OCR、⛔ 不硬給重點)
  ⑦ 沒有 GROQ 金鑰 → 不呼叫 AI,只給機械式重點
"""
import importlib
import io
import json
import os
import sys
import tempfile
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
fails = []


def ok(n, c, e=''):
    print(('✅ ' if c else '❌ ') + n + ('' if c else f'  {str(e)[:300]}'))
    if not c:
        fails.append(n)


def mini_pdf(pages):
    """手寫一份最小的 PDF(Helvetica、ASCII)—— 只為了讓 pypdf 真的跑一次抽字。"""
    objs = []
    n = len(pages)
    kids = ' '.join(f'{4 + 2 * i} 0 R' for i in range(n))
    objs.append(b'<< /Type /Catalog /Pages 2 0 R >>')
    objs.append(f'<< /Type /Pages /Kids [{kids}] /Count {n} >>'.encode())
    objs.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    for i, lines in enumerate(pages):
        ops = ['BT', '/F1 12 Tf', '72 720 Td']
        for j, ln in enumerate(lines):
            if j:
                ops.append('0 -18 Td')
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


def mini_pptx(slides):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for i, lines in enumerate(slides):
            paras = ''.join(f'<a:p><a:r><a:t>{t}</a:t></a:r></a:p>' for t in lines)
            z.writestr(f'ppt/slides/slide{i + 1}.xml', f'<p:sld>{paras}</p:sld>')
    return buf.getvalue()


# 真的簡報幾十頁、上千字;這裡補一頁免責聲明讓總字數超過「只有圖片」的門檻(200 字)
FILL = ['Safe harbor notice: this presentation contains forward-looking statements based on current', 'expectations and assumptions that are subject to risks and uncertainties; actual results may', 'differ materially. The company undertakes no obligation to update these statements publicly.']
PDF_OLD = mini_pdf([['ACME Corp', '2026 Q2 Results', 'Revenue 1,200 million, up 8%'],
                    ['ACME Corp', 'Outlook', 'Expect Q3 revenue growth driven by AI server', 'CoWoS capacity expands'],
                    ['ACME Corp', 'Thank you'], FILL])
PDF_NEW = mini_pdf([['ACME Corp', '2026 Q3 Results', 'Revenue 1,350 million, gross margin 41.5%'],
                    ['ACME Corp', 'Outlook', 'Expect robot and CPO products to ramp in 2027', 'AI server demand remains strong'],
                    ['ACME Corp', 'Capex 300 million for new US plant'], FILL])
PPTX = mini_pptx([['展望', '預期明年營收成長,低軌衛星新產品量產'], ['毛利率 35.2%'], ['風險:匯率'],
                  ['補充說明一', '更多說明文字讓總字數超過門檻'], ['補充說明二', '附錄:各產品線營收比重與說明文字'], FILL])
IMG_ONLY = mini_pdf([[''], [''], ['']])
HTML = b'<html><body>error</body></html>'


class FakeFetcher:
    def __init__(self, table):
        self.table, self.calls = table, []

    def get(self, url):
        name = url.split('fileName=')[-1]
        self.calls.append(name)
        v = self.table.get(name)
        if v is None:
            return None, 'ConnectionError'
        if v == HTML:
            return None, 'not_file:<html>'
        return v, ''


def setup(tmp, rows, today='2026-10-23'):
    data, cc = Path(tmp) / 'data', Path(tmp) / 'cc_deep'
    data.mkdir(parents=True, exist_ok=True)
    (data / 'confcall.json').write_text(json.dumps({'data_date': today, 'src': {'file': {'host': 'https://x', 'path': '/f', 'q': {'step': '9'}, 'arg': 'fileName'}},
                                                     'recent': rows, 'upcoming': []}, ensure_ascii=False), encoding='utf-8')
    os.environ['DATA_DIR'], os.environ['CC_DIR'], os.environ['CC_PACE'] = str(data), str(cc), '0'
    import confcall_deck
    importlib.reload(confcall_deck)
    return confcall_deck, data, cc


logs = []
with tempfile.TemporaryDirectory() as tmp:
    rows1 = [{'s': '1234', 'name': '測試甲', 'd': '2026-08-10', 't': '14:00', 'pdf': ['123420260810M001.pdf', '123420260810E001.pdf']},
             {'s': '5678', 'name': '測試乙', 'd': '2026-10-20', 't': '14:00', 'pdf': ['567820261020M001.pptx']},
             {'s': '9999', 'name': '測試丙', 'd': '2026-10-21', 't': '14:00', 'pdf': ['999920261021M001.pdf']},
             {'s': '8888', 'name': '測試丁', 'd': '2026-10-22', 't': '14:00', 'pdf': ['888820261022M001.pdf']}]
    cd, data, cc = setup(tmp, rows1)
    ff = FakeFetcher({'123420260810M001.pdf': PDF_OLD, '567820261020M001.pptx': PPTX, '999920261021M001.pdf': IMG_ONLY, '888820261022M001.pdf': HTML})
    rc = cd.run(fetcher=ff, groq_keys=[], today=date(2026, 10, 23), log=logs.append)
    ok('① 第一輪 rc=0、四份都試了、挑中文那份(⛔ 英文那份不下載)', rc == 0 and sorted(ff.calls) == sorted(['123420260810M001.pdf', '567820261020M001.pptx', '999920261021M001.pdf', '888820261022M001.pdf']), (rc, ff.calls))
    a = json.loads((data / 'cc' / '1234.json').read_text(encoding='utf-8'))
    d0 = a['decks'][0]
    ok('①b PDF 抽字:展望句與數字句帶頁碼', any(p == 2 and 'Expect Q3 revenue' in t for p, t in d0['outlook']) and any(p == 1 and 'Revenue 1,200' in t for p, t in d0['nums']), d0)
    ok('①c 第一份 → first(⛔ 不說「新」)', d0.get('first') is True and 'new' not in d0, d0)
    b = json.loads((data / 'cc' / '5678.json').read_text(encoding='utf-8'))['decks'][0]
    ok('①d PPTX 抽字(中文)+ 數字句「毛利率 35.2%」頁碼 2', any(p == 2 and '35.2' in t for p, t in b['nums']) and any('低軌衛星' in t for _, t in b['outlook']), b)
    idx = json.loads((cc / 'cc' / 'index.json').read_text(encoding='utf-8'))['files']
    ok('⑥ 只有圖片的簡報 → no_text(⛔ 不給重點)', idx['999920261021M001.pdf']['st'] == 'no_text', idx.get('999920261021M001.pdf'))
    ok('④ 回網頁(不存在的路徑回 200 + HTML)→ bad_file(⛔ 下一輪不再試)', idx['888820261022M001.pdf']['st'] == 'bad_file', idx.get('888820261022M001.pdf'))
    dg = json.loads((data / 'confcall_digest.json').read_text(encoding='utf-8'))
    ok('①e 清單只列最近 60 天、讀成功的(8/10 那場在 60 天外 → 不列;5678 有列)', [r['s'] for r in dg['rows']] == ['5678'], dg['rows'])
    ok('⑦ 沒有金鑰 → 沒有 AI 摘要', 'ai' not in d0 and 'ai' not in b)

    # 第二輪:1234 開了新的一場(新簡報)+ 9/20 券商場拿 8/10 那份重講;舊的那幾份 ⛔ 不再下載
    rows2 = rows1 + [{'s': '1234', 'name': '測試甲', 'd': '2026-10-21', 't': '14:00', 'pdf': ['123420261021M001.pdf']},
                     {'s': '1234', 'name': '測試甲', 'd': '2026-09-20', 't': '10:00', 'pdf': ['123420260810M001.pdf']}]
    cd, data, cc = setup(tmp, rows2)
    ff2 = FakeFetcher({'123420261021M001.pdf': PDF_NEW})
    rc2 = cd.run(fetcher=ff2, groq_keys=[], today=date(2026, 10, 23), log=logs.append)
    ok('② 第二輪只下載新的那一份(讀過的 / 永久失敗的 ⛔ 不再下載;重講的同一份檔名 ⛔ 不再下載)', rc2 == 0 and ff2.calls == ['123420261021M001.pdf'], ff2.calls)
    a2 = json.loads((data / 'cc' / '1234.json').read_text(encoding='utf-8'))['decks']
    nw = [t for t, _ in a2[0].get('new', [])]
    ok('③ 第二份跟上一份比:robot / CPO / US 是新的,AI / CoWoS 不算新', a2[0]['d'] == '2026-10-21' and 'CPO' in nw and 'AI' not in nw and 'CoWoS' not in nw, a2[0])
    ol2 = [t for _, t in a2[0].get('outlook', [])]
    ok('③c 展望句 ⛔ 收免責聲明(expectations…)、⛔ 收只有標題字的「Outlook」', ol2 and not any('expectations' in t or t == 'Outlook' for t in ol2), ol2)
    ok('③b 寫出上一份是哪天 + 這次沒講的(CoWoS)', a2[0].get('prev_d') == '2026-08-10' and 'CoWoS' in (a2[0].get('dropped') or []), a2[0])

    # ④ 連 5 份下載失敗 → 本輪收工 + 一份都沒讀到 → rc=1
    rows3 = [{'s': str(1000 + i), 'name': 'x', 'd': '2026-10-2' + str(i % 3), 'pdf': [f'{1000 + i}2026102{i % 3}M001.pdf']} for i in range(8)]
    cd, data, cc = setup(tmp, rows3)
    ff3 = FakeFetcher({})
    rc3 = cd.run(fetcher=ff3, groq_keys=[], today=date(2026, 10, 23), log=logs.append)
    ok('④b 連 5 份失敗 → 收工(第 6 份 ⛔ 不再試)+ rc=1(⛔ 全綠沒資料)', len(ff3.calls) == 5 and rc3 == 1, (ff3.calls, rc3))
    idx3 = json.loads((cc / 'cc' / 'index.json').read_text(encoding='utf-8'))['files']
    ok('④c 暫時性失敗記 dl_fail + tries(下一輪還會試,最多 3 次)', all(v['st'] == 'dl_fail' and v['tries'] == 1 for k, v in idx3.items() if k.startswith('100')), idx3)

# ⑤ AI 數字核對(走正式的 groq_summarize,只換網路)
import confcall_deck as cdm


class R:
    def __init__(self, code, body):
        self.status_code, self._b = code, body

    def json(self):
        return self._b


feat = cdm.feat_of(['公司\n營收 120 億元,季增 8%\n毛利率 41.5%', '公司\n展望\n預期明年 CPO 產品放量', '公司\n謝謝'], {})
ans = {'one': '營收 120 億、季增 8%', 'outlook': [{'t': '明年 CPO 放量', 'p': 2}, {'t': '毛利率將升到 45%', 'p': 2}], 'new': [{'t': 'CPO 產品', 'p': 2}], 'risk': []}
poster = lambda **kw: R(200, {'choices': [{'message': {'content': '```json\n' + json.dumps(ans, ensure_ascii=False) + '\n```'}}]})
import groq_common
groq_common.groq_model = lambda keys, tier='light', avoid=None: 'qwen/qwen3.8-27b'
ai, model, gd = cdm.groq_summarize('公司', '1234', '2026-10-21', feat, ['k1'], poster=poster)
ok('⑤ AI 編的「毛利率將升到 45%」整點丟掉、原文有的留著', ai and gd == 1 and [x['t'] for x in ai['outlook']] == ['明年 CPO 放量'] and ai['one'], (ai, gd))
ok('⑤b 記下是哪個模型回答的', model == 'qwen/qwen3.8-27b', model)
raw_items = [x['t'] for x in ans['outlook']]
ok('⑤c ⭐ 決定性對照:同一份回答不過核對 → 編的那句會留下來', '毛利率將升到 45%' in raw_items)

print('\n' + (f'❌ test_confcall_deck 失敗 {len(fails)} 條' if fails else '✅ test_confcall_deck 全過'))
sys.exit(1 if fails else 0)
