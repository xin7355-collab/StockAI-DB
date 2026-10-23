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
  ⑧~⑬ 📚 回補:清單一個月一個月查(被擋的月份 ⛔ 標做完、下一輪重抓)・讀的順序(最近 → 這些公司前幾份 → 其他)・
        到上限寫 more=1 給 workflow 接力・「第一次提到」跟著回補變準・日期改成最早引用它的那場・
        「大家都在講」只看之前 100 天(⛔ 前視)・內容沒變 data/cc 不重寫
  ⑭⑮ AI 被限流不可拖慢整輪:換下一把、只等 1 秒、一份最多 AI_DEADLINE 秒;連 3 份失敗這一輪不再叫
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


def setup(tmp, rows, today='2026-10-23', **env):
    data, cc = Path(tmp) / 'data', Path(tmp) / 'cc_deep'
    data.mkdir(parents=True, exist_ok=True)
    (data / 'confcall.json').write_text(json.dumps({'data_date': today, 'src': {'file': {'host': 'https://x', 'path': '/f', 'q': {'step': '9'}, 'arg': 'fileName'}},
                                                     'recent': rows, 'upcoming': []}, ensure_ascii=False), encoding='utf-8')
    os.environ['DATA_DIR'], os.environ['CC_DIR'], os.environ['CC_PACE'] = str(data), str(cc), '0'
    os.environ['CC_LIST_PACE'] = '0'
    for k in ('CC_MAX', 'CC_LIST_FROM', 'CC_LIST_TO', 'GITHUB_OUTPUT'):
        os.environ.pop(k, None)
    for k, v in env.items():
        os.environ[k] = str(v)
    import confcall_deck
    importlib.reload(confcall_deck)
    return confcall_deck, data, cc


logs = []
with tempfile.TemporaryDirectory() as tmp:
    rows1 = [{'s': '1234', 'name': '測試甲', 'd': '2026-08-10', 't': '14:00', 'pdf': ['123420260810M001.pdf', '123420260810E001.pdf']},
             {'s': '5678', 'name': '測試乙', 'd': '2026-10-20', 't': '14:00', 'pdf': ['567820261020M001.pptx']},
             {'s': '9999', 'name': '測試丙', 'd': '2026-10-21', 't': '14:00', 'pdf': ['999920261021M001.pdf']},
             {'s': '8888', 'name': '測試丁', 'd': '2026-10-22', 't': '14:00', 'pdf': ['888820261022M001.pdf']},
             {'s': '7777', 'name': '測試戊', 'd': '2026-09-01', 't': '14:00', 'pdf': ['777720260901M001.pdf']}]
    cd, data, cc = setup(tmp, rows1)
    ff = FakeFetcher({'123420260810M001.pdf': PDF_OLD, '567820261020M001.pptx': PPTX, '999920261021M001.pdf': IMG_ONLY,
                      '888820261022M001.pdf': HTML, '777720260901M001.pdf': HTML})
    rc = cd.run(fetcher=ff, groq_keys=[], today=date(2026, 10, 23), log=logs.append)
    ok('① 第一輪 rc=0、五份都試了、挑中文那份(⛔ 英文那份不下載)', rc == 0 and sorted(ff.calls) == sorted(['123420260810M001.pdf', '567820261020M001.pptx', '999920261021M001.pdf', '888820261022M001.pdf', '777720260901M001.pdf']), (rc, ff.calls))
    a = json.loads((data / 'cc' / '1234.json').read_text(encoding='utf-8'))
    d0 = a['decks'][0]
    ok('①b PDF 抽字:展望句與數字句帶頁碼', any(p == 2 and 'Expect Q3 revenue' in t for p, t in d0['outlook']) and any(p == 1 and 'Revenue 1,200' in t for p, t in d0['nums']), d0)
    ok('①c 第一份 → first(⛔ 不說「新」)', d0.get('first') is True and 'new' not in d0, d0)
    b = json.loads((data / 'cc' / '5678.json').read_text(encoding='utf-8'))['decks'][0]
    ok('①d PPTX 抽字(中文)+ 數字句「毛利率 35.2%」頁碼 2', any(p == 2 and '35.2' in t for p, t in b['nums']) and any('低軌衛星' in t for _, t in b['outlook']), b)
    idx = json.loads((cc / 'cc' / 'index.json').read_text(encoding='utf-8'))['files']
    ok('⑥ 只有圖片的簡報 → no_text(⛔ 不給重點)', idx['999920261021M001.pdf']['st'] == 'no_text', idx.get('999920261021M001.pdf'))
    ok('④ 回網頁(不存在的路徑回 200 + HTML):開完超過 3 天 → bad_file(⛔ 下一輪不再試)', idx['777720260901M001.pdf']['st'] == 'bad_file', idx.get('777720260901M001.pdf'))
    ok('④a ⭐ 決定性對照:昨天才開完的回網頁 = 多半還沒上傳 → dl_fail(下一輪再試)', idx['888820261022M001.pdf']['st'] == 'dl_fail', idx.get('888820261022M001.pdf'))
    dg = json.loads((data / 'confcall_digest.json').read_text(encoding='utf-8'))
    ok('①e 清單只列最近 60 天、讀成功的(8/10 那場在 60 天外 → 不列;5678 有列)', [r['s'] for r in dg['rows']] == ['5678'], dg['rows'])
    ok('⑦ 沒有金鑰 → 沒有 AI 摘要', 'ai' not in d0 and 'ai' not in b)

    # 第二輪:1234 開了新的一場(新簡報)+ 9/20 券商場拿 8/10 那份重講;舊的那幾份 ⛔ 不再下載
    rows2 = rows1 + [{'s': '1234', 'name': '測試甲', 'd': '2026-10-21', 't': '14:00', 'pdf': ['123420261021M001.pdf']},
                     {'s': '1234', 'name': '測試甲', 'd': '2026-09-20', 't': '10:00', 'pdf': ['123420260810M001.pdf']}]
    cd, data, cc = setup(tmp, rows2)
    ff2 = FakeFetcher({'123420261021M001.pdf': PDF_NEW, '888820261022M001.pdf': PDF_OLD})
    rc2 = cd.run(fetcher=ff2, groq_keys=[], today=date(2026, 10, 23), log=logs.append)
    ok('② 第二輪只下載新的那一份 + 上次還沒上傳的那份(讀過的 / 永久失敗的 ⛔ 不再下載;重講的同一份檔名 ⛔ 不再下載)',
       rc2 == 0 and sorted(ff2.calls) == ['123420261021M001.pdf', '888820261022M001.pdf'], ff2.calls)
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

# ⑧~⑬ 📚 回補舊簡報(清單回補 / 讀的順序 / 接力訊號 / 「第一次提到」跟著回補變準 / 日期改成最早那場 / 前視)
def deck(lines_by_page):
    return mini_pdf(lines_by_page + [FILL])


with tempfile.TemporaryDirectory() as tmp:
    # 最近 60 天:A(1111)10/20、B(2222)10/15;回補清單:A 的 7/20、4/20、1/20 與 B 的 7/15,還有 C(3333)6/10
    recent = [{'s': '1111', 'name': '甲', 'd': '2026-10-20', 't': '14:00', 'sum': '本公司受邀參加元大證券舉辦之法人說明會', 'pdf': ['111120261020M001.pdf']},
              {'s': '2222', 'name': '乙', 'd': '2026-10-15', 't': '15:00', 'sum': '公司營運概況', 'pdf': ['222220261015M001.pdf']}]
    month_rows = {
        (2026, 7): [{'s': '1111', 'name': '甲', 'd': '2026-07-20', 't': '14:00', 'pdf': ['111120260720M001.pdf']},
                    {'s': '2222', 'name': '乙', 'd': '2026-07-15', 't': '14:00', 'pdf': ['222220260715M001.pdf']}],
        (2026, 6): [{'s': '3333', 'name': '丙', 'd': '2026-06-10', 't': '14:00', 'pdf': ['333320260610M001.pdf']}],
        (2026, 4): [{'s': '1111', 'name': '甲', 'd': '2026-04-20', 't': '14:00', 'pdf': ['111120260420M001.pdf']}],
        (2026, 1): [{'s': '1111', 'name': '甲', 'd': '2026-01-20', 't': '14:00', 'pdf': ['111120260120M001.pdf']}],
    }
    calls_list = []

    def list_fetch(typek, ym):
        calls_list.append((typek, ym))
        if ym == (2026, 5):
            return [], '被主機擋(安全性考量)'
        # 每個月都有場次(沒有簡報檔名的不收);⛔ 一個月 0 場 = 沒抓到(真實每月都有上百場)
        filler = [{'s': '0000', 'name': '無簡報', 'd': f'{ym[0]}-{ym[1]:02d}-05', 't': '14:00', 'pdf': []}]
        return ([r for r in month_rows.get(ym, []) if typek == 'sii'] + filler, None)

    gho = Path(tmp) / 'gh_out.txt'
    cd, data, cc = setup(tmp, recent, CC_MAX=3, CC_LIST_FROM='2026-01', CC_LIST_TO='2026-08', GITHUB_OUTPUT=gho)
    A_NEW = deck([['甲公司', 'Outlook', 'Expect robot and CPO products to ramp'], ['Revenue 500 million']])
    A_JUL = deck([['甲公司', 'Results', 'AI server demand strong'], ['Revenue 450 million']])
    A_APR = deck([['甲公司', 'Results', 'AI server and robot pilot lines'], ['Revenue 420 million']])
    A_JAN = deck([['甲公司', 'Results', 'AI server shipments'], ['Revenue 400 million']])
    B_NEW = deck([['乙公司', 'Results', 'EV charger business'], ['Revenue 100 million']])
    B_JUL = deck([['乙公司', 'Results', 'EV charger orders'], ['Revenue 90 million']])
    C_JUN = deck([['丙公司', 'Results', 'PCB orders'], ['Revenue 80 million']])
    table = {'111120261020M001.pdf': A_NEW, '111120260720M001.pdf': A_JUL, '111120260420M001.pdf': A_APR, '111120260120M001.pdf': A_JAN,
             '222220261015M001.pdf': B_NEW, '222220260715M001.pdf': B_JUL, '333320260610M001.pdf': C_JUN}
    ffa = FakeFetcher(table)
    rca = cd.run(fetcher=ffa, groq_keys=[], today=date(2026, 10, 23), log=logs.append, list_fetch=list_fetch)
    bl = cd.load_backlog()
    ok('⑧ 清單回補:抓到的月份標 ok、被擋的 5 月 ⛔ 不標(下一輪重抓)', bl['months'].get('2026-07', {}).get('ok') is True
       and bl['months'].get('2026-05', {}).get('ok') is False and len(bl['rows']) == 5, (bl['months'], len(bl['rows'])))
    ok('⑧b 只收已經開完、有簡報檔名的場次;受邀場次標 inv', all(r['d'] < '2026-10-23' and r['pdf'] for r in bl['rows']), bl['rows'][:2])
    ok('⑨ 讀的順序:最近的兩份先讀 → 再讀這兩家的上一份(⭐ 「第一次提到」要跟它們比)', ffa.calls == ['111120261020M001.pdf', '222220261015M001.pdf', '111120260720M001.pdf'], ffa.calls)
    out1 = gho.read_text(encoding='utf-8')
    ok('⑨b 到每輪上限 → reason=cap、more=1、left=4(給 workflow 接力)', rca == 0 and 'more=1' in out1 and 'reason=cap' in out1 and 'left=4' in out1, out1)
    a_out = json.loads((data / 'cc' / '1111.json').read_text(encoding='utf-8'))['decks']
    nw = [t for t, _ in a_out[0].get('new', [])]
    ok('⑩ 10/20 那份跟 7/20 比:robot / CPO 是新的、AI 不算', a_out[0]['d'] == '2026-10-20' and 'CPO' in nw and 'AI' not in nw and a_out[0].get('prev_d') == '2026-07-20', a_out[0])
    ok('⑩a 受邀場次的 inv 帶到 App 的檔', a_out[0].get('inv') == 1, a_out[0])
    # 第二輪:把剩下的讀完(上限放寬)→ 4/20 那份講過 robot → 10/20 的「第一次提到」⛔ 再含 robot(跟著回補變準)
    gho.write_text('', encoding='utf-8')
    cd, data, cc = setup(tmp, recent, CC_MAX=50, GITHUB_OUTPUT=gho)
    ffb = FakeFetcher(table)
    rcb = cd.run(fetcher=ffb, groq_keys=[], today=date(2026, 10, 23), log=logs.append, list_fetch=list_fetch)
    ok('⑩b 第二輪先重抓上次被擋的 5 月(⛔ 抓過的月份不重抓),再讀剩下的 4 份:這兩家更早的(新 → 舊)→ 其他公司的',
       calls_list[-2:] == [('sii', (2026, 5)), ('otc', (2026, 5))] and len(calls_list) == 18
       and ffb.calls == ['222220260715M001.pdf', '111120260420M001.pdf', '111120260120M001.pdf', '333320260610M001.pdf'], (calls_list[-4:], len(calls_list), ffb.calls))
    a2 = json.loads((data / 'cc' / '1111.json').read_text(encoding='utf-8'))['decks']
    nw2 = [t for t, _ in a2[0].get('new', [])]
    ok('⑩c ⭐ 「第一次提到」跟著回補變準:4/20 講過 robot → 10/20 ⛔ 再算新(CPO 仍是新的)', 'robot' not in [x.lower() for x in nw2] and 'CPO' in nw2, nw2)
    ok('⑩d 每檔最多留 4 份、最舊那份是 first', len(a2) == 4 and a2[-1].get('first') is True and a2[-1]['d'] == '2026-01-20', [(x['d'], x.get('first')) for x in a2])
    out2 = gho.read_text(encoding='utf-8')
    ok('⑨c 全部讀完 → more=0(⛔ 不再接力)', rcb == 0 and 'more=0' in out2, out2)
    # ⑬ 內容沒變 → 每檔的 App 檔 ⛔ 不重寫(不然每輪上千個檔都算變更)
    m0 = {p.name: p.stat().st_mtime_ns for p in (data / 'cc').glob('*.json')}
    cd, data, cc = setup(tmp, recent, CC_MAX=50)
    lg = []
    cd.run(fetcher=FakeFetcher(table), groq_keys=[], today=date(2026, 10, 23), log=lg.append, list_fetch=list_fetch)
    m1 = {p.name: p.stat().st_mtime_ns for p in (data / 'cc').glob('*.json')}
    ok('⑬ 沒有新簡報 → data/cc/*.json 一個都沒改', m0 == m1 and any('改了 0 檔' in x for x in lg), (lg[-1:], [k for k in m0 if m0[k] != m1.get(k)]))

    # ⑫ 日期改成最早那場:券商場(10/20)拿 7/20 那份重講,先讀到的是券商場 → 回補清單有 7/20 那場之後,日期改回 7/20(⛔ 不重新下載)
with tempfile.TemporaryDirectory() as tmp:
    recent = [{'s': '4444', 'name': '丁', 'd': '2026-10-20', 't': '10:00', 'sum': '受邀參加凱基證券舉辦之投資論壇', 'pdf': ['444420260720M001.pdf']}]
    cd, data, cc = setup(tmp, recent)
    D_JUL = deck([['丁公司', 'Results', 'AI server'], ['Revenue 70 million']])
    ffc = FakeFetcher({'444420260720M001.pdf': D_JUL})
    cd.run(fetcher=ffc, groq_keys=[], today=date(2026, 10, 23), log=logs.append)
    d1 = json.loads((data / 'cc' / '4444.json').read_text(encoding='utf-8'))['decks'][0]
    ok('⑫ 只看到券商場那天 → 日期 10/20 + reuse 07/20', d1['d'] == '2026-10-20' and d1.get('reuse') == '2026-07-20', d1)
    cd, data, cc = setup(tmp, recent, CC_LIST_FROM='2026-07', CC_LIST_TO='2026-07')
    ffd = FakeFetcher({'444420260720M001.pdf': D_JUL})
    cd.run(fetcher=ffd, groq_keys=[], today=date(2026, 10, 23), log=logs.append,
           list_fetch=lambda typek, ym: ([{'s': '4444', 'name': '丁', 'd': '2026-07-20', 't': '14:00', 'sum': '公司營運概況', 'pdf': ['444420260720M001.pdf']}] if typek == 'sii' else [], None))
    d2 = json.loads((data / 'cc' / '4444.json').read_text(encoding='utf-8'))['decks'][0]
    moved = [p.name for p in (cc / 'cc' / 'feat').glob('*.json.gz')]
    jul = cd._load_json(cc / 'cc' / 'feat' / '2026-07.json.gz', [])
    octo = cd._load_json(cc / 'cc' / 'feat' / '2026-10.json.gz', [])
    ok('⑫b 找到原本那場 → 日期改回 07/20、reuse 拿掉、inv 跟著那場(自辦 = 0)、⛔ 不重新下載', d2['d'] == '2026-07-20' and 'reuse' not in d2
       and not d2.get('inv') and ffd.calls == [], (d2, ffd.calls))
    ok('⑫c 特徵檔搬到 7 月那一檔(10 月那檔不再有它)', len(jul) == 1 and not octo, (moved, len(jul), len(octo)))

# ⑪ 前視:「大家都在講的詞」只看這一場之前 100 天 —— 之後才大家都在講的,⛔ 不可讓之前那一場的「新」消失
import confcall_deck as cdx
recs = [{'s': 'S0', 'd': '2026-03-01', 'f': 'a', 'st': 'ok', 'terms': {'AI': 1}},
        {'s': 'S0', 'd': '2026-06-01', 'f': 'b', 'st': 'ok', 'terms': {'AI': 1, 'CPO': 2}}]
later = [{'s': f'L{i}', 'd': '2026-06-15', 'f': f'l{i}', 'st': 'ok', 'terms': {'CPO': 1}} for i in range(40)]
before = [{'s': f'B{i}', 'd': '2026-05-15', 'f': f'b{i}', 'st': 'ok', 'terms': {'CPO': 1}} for i in range(40)]
n1 = cdx.novelty_all(recs + later)
n2 = cdx.novelty_all(recs + before)
ok('⑪ 之後(6/15)才大家都在講 CPO → 6/1 那份的 CPO 仍是「第一次提到」(⛔ 前視)', [t for t, _ in n1['b']['new']] == ['CPO'], n1['b'])
ok('⑪b ⭐ 決定性對照:之前(5/15)就大家都在講 → CPO ⛔ 不算新', n2['b']['new'] == [] and n2['b']['n_new'] == 0, n2['b'])


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

# ⑭ 🐢 AI 被限流(429)不可拖慢整輪:換下一把、每次只等 1 秒、一份最多 AI_DEADLINE 秒
tick = {'t': 0.0, 'sleep': [], 'calls': 0}
def fake_clock():
    return tick['t']
def fake_sleep(x):
    tick['sleep'].append(x); tick['t'] += x
def poster429(**kw):
    tick['calls'] += 1; tick['t'] += 3.0
    return R(429, {})
ai4, m4, g4 = cdm.groq_summarize('公司', '1234', '2026-10-21', feat, ['k1', 'k2', 'k3'], poster=poster429, clock=fake_clock, sleeper=fake_sleep)
ok('⑭ 全部 429 → 回 None;每次只等 1 秒(⛔ 不越等越久)', ai4 is None and tick['sleep'] and max(tick['sleep']) <= 1.0, tick)
tick2 = {'t': 0.0}
def poster_slow(**kw):
    tick2['t'] += 15.0
    return R(500, {})
cdm.groq_summarize('公司', '1234', '2026-10-21', feat, ['k%d' % i for i in range(10)], poster=poster_slow, clock=lambda: tick2['t'], sleeper=lambda x: None)
ok('⑭b 一份簡報的 AI 最多 AI_DEADLINE 秒(10 把金鑰 × 2 輪 ⛔ 全部試完)', tick2['t'] <= cdm.AI_DEADLINE + 15.0, tick2)

# ⑮ AI 連 3 份都沒回 → 這一輪不再叫(多半是額度用完;⛔ 不可每份都等)
with tempfile.TemporaryDirectory() as tmp:
    rows = [{'s': str(2000 + i), 'name': 'x', 'd': '2026-10-2' + str(i % 3), 't': '14:00', 'pdf': [f'{2000 + i}2026102{i % 3}M001.pdf']} for i in range(6)]
    cd, data, cc = setup(tmp, rows)
    n_ai = {'n': 0}
    def fake_sum(*a, **kw):
        n_ai['n'] += 1
        return None, None, 0
    cd.groq_summarize = fake_sum
    lg = []
    tbl = {r['pdf'][0]: deck([['公司', 'Outlook', 'Expect AI server growth'], ['Revenue 100 million']]) for r in rows}
    cd.run(fetcher=FakeFetcher(tbl), groq_keys=['k1'], today=date(2026, 10, 23), log=lg.append)
    ok('⑮ AI 連 3 份失敗 → 後面 3 份 ⛔ 不再叫(讀簡報照常)', n_ai['n'] == 3 and any('不再叫 AI' in x for x in lg)
       and len(list((data / 'cc').glob('*.json'))) == 6, (n_ai, lg[-2:]))


print('\n' + (f'❌ test_confcall_deck 失敗 {len(fails)} 條' if fails else '✅ test_confcall_deck 全過'))
sys.exit(1 if fails else 0)
