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
import re
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
    for k in ('CC_MAX', 'CC_AI_MAX', 'CC_LIST_FROM', 'CC_LIST_TO', 'GITHUB_OUTPUT'):
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
    okr = {r['s']: r for r in dg['rows'] if r.get('st') == 'ok'}
    str_ = {r['s']: r for r in dg['rows'] if r.get('st') != 'ok'}
    # 📋 V79.6.4:最近場次表引用的簡報 ⛔ 被 60 天切掉(8/10 那份在場次表裡 → 列);讀不成的也列一列只有狀態
    ok('①e 清單:讀成功的 5678 + 場次表引用的 1234(8/10,60 天外也列)都帶 st=ok;n_ok = 讀成功的份數',
       set(okr) == {'5678', '1234'} and dg.get('n_ok') == 2, ([(r['s'], r.get('st')) for r in dg['rows']], dg.get('n_ok')))
    ok('①e2 讀不成的也列(只有狀態):9999 只有圖片 no_text ・8888 還沒上傳 dl_fail(還在試)・7777 檔案不在 bad_file;⛔ 沒有任何重點欄位',
       {k: v['st'] for k, v in str_.items()} == {'9999': 'no_text', '8888': 'dl_fail', '7777': 'bad_file'}
       and str_['8888'].get('gave_up') == 0 and str_['8888'].get('tries') == 1
       and not any(k in v for v in str_.values() for k in ('one', 'ol', 'tm', 'new', 'first')), str_)
    ok('①f 清單帶這份簡報講到的詞(法說會頁搜「誰在講 X」用)', '低軌衛星' in (okr['5678'].get('tm') or []), okr['5678'].get('tm'))
    # ⭐ 決定性對照:同一批特徵、不給「最近場次引用」→ 8/10 那份照舊被 60 天切掉
    _all = [x for l in cd.load_all().values() for x in l]
    cd.build_outputs(_all, cd.novelty_all(_all), {}, date(2026, 10, 23), files={}, cite=set())
    dg0 = json.loads((data / 'confcall_digest.json').read_text(encoding='utf-8'))
    ok('①e3 ⭐ 決定性對照:不給最近場次引用的簡報 → 1234 那份(60 天外)不列、讀不成的也沒有(沒給 index)',
       [r['s'] for r in dg0['rows'] if r.get('st') == 'ok'] == ['5678'] and not [r for r in dg0['rows'] if r.get('st') not in ('ok', 'no_text')], dg0['rows'])
    ok('⑦ 沒有金鑰 → 沒有 AI 摘要', 'ai' not in d0 and 'ai' not in b)

    # 第二輪:1234 開了新的一場(新簡報)+ 9/20 券商場拿 8/10 那份重講;舊的那幾份 ⛔ 不再下載
    rows2 = rows1 + [{'s': '1234', 'name': '測試甲', 'd': '2026-10-21', 't': '14:00', 'pdf': ['123420261021M001.pdf']},
                     {'s': '1234', 'name': '測試甲', 'd': '2026-09-20', 't': '10:00', 'pdf': ['123420260810M001.pdf']}]
    cd, data, cc = setup(tmp, rows2)
    # 📅 V79.6.4:同一天再跑一輪 → 今天已經失敗過的 8888 ⛔ 再試(接力那幾棒同一天會連撞同一份)
    ff2s = FakeFetcher({'123420261021M001.pdf': PDF_NEW, '888820261022M001.pdf': PDF_OLD})
    cd.run(fetcher=ff2s, groq_keys=[], today=date(2026, 10, 23), log=logs.append)
    ok('②s 同一天再跑:今天失敗過的那份 ⛔ 再試(只下載新的那一份)', ff2s.calls == ['123420261021M001.pdf'], ff2s.calls)
    ff2 = FakeFetcher({'123420261021M001.pdf': PDF_NEW, '888820261022M001.pdf': PDF_OLD})
    rc2 = cd.run(fetcher=ff2, groq_keys=[], today=date(2026, 10, 24), log=logs.append)
    ok('② 隔天:上次還沒上傳的那份再試一次(讀過的 / 永久失敗的 ⛔ 不再下載;重講的同一份檔名 ⛔ 不再下載)',
       rc2 == 0 and sorted(ff2.calls) == ['888820261022M001.pdf'], ff2.calls)
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


# ⑯ 🐢 下載被壓頻寬(一小塊一小塊給)→ 一份最多 DL_MAX_SEC 秒就放棄(read timeout 只管每一小塊,⛔ 不可一份等十分鐘)
class SlowResp:
    status_code = 200
    def __init__(self, clk, body, per=10.0):
        self.clk, self.body, self.per = clk, body, per
    def iter_content(self, n):
        for i in range(0, len(self.body), 1024):
            self.clk['t'] += self.per            # 每一小塊要 10 秒
            yield self.body[i:i + 1024]
    def close(self):
        pass
class SlowSess:
    def __init__(self, clk, body, per):
        self.clk, self.body, self.per, self.n = clk, body, per, 0
    def get(self, url, **kw):
        self.n += 1
        return SlowResp(self.clk, self.body, self.per)
clk = {'t': 0.0}
big = b'%PDF-1.4\n' + b'x' * (1024 * 40)
fs_ = cdm.Fetcher(session=SlowSess(clk, big, 10.0), pace=0, sleeper=lambda x: None, clock=lambda: clk['t'])
b_, err_ = fs_.get('https://x/f?fileName=a.pdf')
ok('⑯ 下載太慢 → 放棄並回 slow(⛔ 一份等到天荒地老)', b_ is None and err_.startswith('slow') and clk['t'] <= cdm.DL_MAX_SEC + 20, (err_, clk['t']))
clk2 = {'t': 0.0}
fs2 = cdm.Fetcher(session=SlowSess(clk2, big, 0.1), pace=0, sleeper=lambda x: None, clock=lambda: clk2['t'])
b2, err2 = fs2.get('https://x/f?fileName=a.pdf')
ok('⑯b ⭐ 決定性對照:同一份檔速度正常 → 照常拿到', b2 is not None and b2[:5] == b'%PDF-' and err2 == '', (err2, clk2['t']))


# ⑯c ⏱️ 知道檔案多大(Content-Length)而且照目前速度一定下載不完 → 提早放棄(⛔ 白等滿時限、最後整份丟掉)
class SizedResp(SlowResp):
    def __init__(self, clk, body, per, total):
        super().__init__(clk, body, per); self.headers = {'Content-Length': str(total)}
class SizedSess(SlowSess):
    def __init__(self, clk, body, per, total):
        super().__init__(clk, body, per); self.total = total
    def get(self, url, **kw):
        self.n += 1
        return SizedResp(self.clk, self.body, self.per, self.total) if self.total else SlowResp(self.clk, self.body, self.per)
big2 = b'%PDF-1.4\n' + b'x' * (1024 * 300)
ck5 = {'t': 0.0}
f5 = cdm.Fetcher(session=SizedSess(ck5, big2, 1.0, len(big2)), pace=0, sleeper=lambda x: None, clock=lambda: ck5['t'])
b5, e5 = f5.get('https://x/f?fileName=a.pdf')
ck6 = {'t': 0.0}
f6 = cdm.Fetcher(session=SizedSess(ck6, big2, 1.0, 0), pace=0, sleeper=lambda x: None, clock=lambda: ck6['t'])
b6, e6 = f6.get('https://x/f?fileName=a.pdf')
ok('⑯c 300 KB、每秒 1 KB(要 5 分鐘)→ 20 秒就算得出下載不完,提早放棄並寫速度', b5 is None and e5.startswith('slow:') and 'KB/s' in e5 and ck5['t'] <= 25, (e5, ck5['t']))
ok('⑯d ⭐ 決定性對照:同一份檔不知道多大(沒有 Content-Length)→ 等到總時限才放棄', b6 is None and e6.startswith('slow:') and ck6['t'] >= cdm.DL_MAX_SEC, (e6, ck6['t']))


# ⑰ 🐢 抽字卡住(pypdf 遇到很複雜的頁面會卡好幾分鐘)→ 子程序時限到就砍掉、記 timeout(⛔ 整輪卡死)
import time as _t
_orig_pdf = cdm.extract_pdf
cdm.extract_pdf = lambda b: (_t.sleep(5), ['x'])[1]
t0 = _t.time()
pg_, er_ = cdm.extract_safe(PDF_NEW, timeout=0.8)
dt_ = _t.time() - t0
cdm.extract_pdf = _orig_pdf
ok('⑰ 抽字卡住 → 時限到砍掉、回 timeout(⛔ 等 5 秒)', pg_ is None and er_ == 'timeout' and dt_ < 3, (er_, round(dt_, 2)))
pg2_, er2_ = cdm.extract_safe(PDF_NEW, timeout=20)
ok('⑰b ⭐ 決定性對照:同一份正常的簡報 → 照常抽到字', pg2_ is not None and any('Revenue 1,350' in p for p in pg2_) and er2_ == '', (er2_, pg2_[:1] if pg2_ else None))


# ⑲ ⚡ 兩條官方下載路 + 每份(含重試)總時限 —— 10/23 第一輪 30 份讀 40 分鐘還沒完(舊版每份最多 5 次 × 讀取逾時 60 秒)
TPL = {'host': 'https://mopsov.twse.com.tw', 'path': '/server-java/FileDownLoad',
       'q': {'step': '9', 'filePath': '/home/html/nas/STR/', 'functionName': 't100sb02_1'}, 'arg': 'fileName'}
R_ = cdm.file_urls(TPL, '233020260716M001.pdf')
ok('⑲ 兩條路:下載程式 + 檔案原本的路徑 /nas/STR/', [k for k, _ in R_] == ['srv', 'nas'] and R_[1][1] == 'https://mopsov.twse.com.tw/nas/STR/233020260716M001.pdf'
   and 'fileName=233020260716M001.pdf' in R_[0][1], R_)
ok('⑲a 檔名怪怪的(有斜線)→ 只給下載程式那條(⛔ 拼網址)', [k for k, _ in cdm.file_urls(TPL, '../x.pdf')] == ['srv'])
class RouteSess:
    """srv / nas 各自回什麼:'pdf' 正常 / 'html' 回網頁 / 'to' 讀取逾時;記下被叫的順序"""
    def __init__(self, beh, clk):
        self.beh, self.clk, self.calls = beh, clk, []
    def get(self, url, **kw):
        k = 'nas' if '/nas/STR/' in url else 'srv'
        self.calls.append(k)
        b = self.beh[k]
        if b == 'to':
            self.clk['t'] += 20
            raise TimeoutError('read timeout')
        class R:
            status_code = 200
            def __init__(s, body): s.body = body
            def iter_content(s, n): yield s.body
            def close(s): pass
        return R(b'%PDF-1.4\nhello' if b == 'pdf' else b'<html>not here</html>')
ck = {'t': 0.0}
rs = RouteSess({'srv': 'to', 'nas': 'pdf'}, ck)
fa = cdm.Fetcher(session=rs, pace=0, sleeper=lambda x: ck.__setitem__('t', ck['t'] + x), clock=lambda: ck['t'])
b1, e1, k1 = fa.get_any(cdm.file_urls(TPL, '233020260716M001.pdf'))
b2, e2, k2 = fa.get_any(cdm.file_urls(TPL, '233020260717M001.pdf'))
ok('⑲b 先走檔案路徑(下載程式實測只有約 30 KB/s);拿到了就一直走它、⛔ 去叫下載程式', b1 and k1 == 'nas' and b2 and k2 == 'nas'
   and rs.calls == ['nas', 'nas'], (k1, k2, rs.calls))
ck1 = {'t': 0.0}
rs1 = RouteSess({'srv': 'pdf', 'nas': 'to'}, ck1)
fa1 = cdm.Fetcher(session=rs1, pace=0, sleeper=lambda x: ck1.__setitem__('t', ck1['t'] + x), clock=lambda: ck1['t'])
b1b, e1b, k1b = fa1.get_any(cdm.file_urls(TPL, '233020260716M001.pdf'))
ok('⑲c 檔案路徑逾時 → 換下載程式拿到;每一次嘗試都有時限(3 次 × 讀取逾時 + 退避 < 總時限)', b1b and k1b == 'srv' and rs1.calls == ['nas', 'nas', 'nas', 'srv']
   and ck1['t'] <= cdm.DL_MAX_SEC + cdm.DL_READ, (k1b, rs1.calls, ck1['t']))
ck2 = {'t': 0.0}
rs2 = RouteSess({'srv': 'pdf', 'nas': 'html'}, ck2)
fb = cdm.Fetcher(session=rs2, pace=0, sleeper=lambda x: None, clock=lambda: ck2['t'])
b3, e3, k3 = fb.get_any(cdm.file_urls(TPL, '233020260716M001.pdf'))
b3b, e3b, k3b = fb.get_any(cdm.file_urls(TPL, '233020260717M001.pdf'))
ok('⑲d ⭐ 決定性對照:檔案路徑回網頁(⛔ 被當成檔案)→ 換下載程式拿到;下一份直接走下載程式(⛔ 每份都先白問一次)',
   b3 and k3 == 'srv' and b3b and k3b == 'srv' and rs2.calls == ['nas', 'srv', 'srv'], (k3, k3b, rs2.calls))
ck3 = {'t': 0.0}
fc = cdm.Fetcher(session=RouteSess({'srv': 'to', 'nas': 'to'}, ck3), pace=0, sleeper=lambda x: ck3.__setitem__('t', ck3['t'] + x), clock=lambda: ck3['t'])
b4, e4, k4 = fc.get_any(cdm.file_urls(TPL, '233020260716M001.pdf'))
ok('⑲e 兩條都逾時 → 原因兩段都在(nas:… | srv:…)、每段寫幾次嘗試', b4 is None and e4.startswith('nas:') and ' | srv:' in e4 and e4.count('TimeoutError@') == 6, e4)
ok('⑳ 失敗原因分類:兩條都回網頁 = nf ・下載程式 404 + 另一條回網頁 = 4xx(⛔ 管順序)・下載程式逾時 = 暫時性 ・太大 = too_big',
   cdm.err_kind('srv:not_file:a | nas:not_file:b') == 'nf' and cdm.err_kind('srv:HTTP 404 | nas:not_file:b') == '4xx'
   and cdm.err_kind('srv:ReadTimeout@20s | nas:not_file:b') == 'tmp' and cdm.err_kind('srv:too_big') == 'too_big'
   and cdm.err_kind('not_file:x') == 'nf' and cdm.err_kind('HTTP 429') == 'tmp'
   and cdm.err_kind('nas:not_file:b | srv:HTTP 404') == '4xx' and cdm.err_kind('nas:HTTP 404 | srv:ReadTimeout@20s') == 'tmp')


# ㉑~㉓ 🧾 10/23 第一輪實跑抓到的品質問題(原文照抄當測資):免責聲明 / 註腳 / 標題被當成「講到之後」、人名 / 料號被當成產品詞
L_ = [(1, '本簡報中所提及之預測性資訊包括營運展望、財務狀況以及業務'),
      (2, '產業狀況或後續重大發展的完整述論。對未來的展望,反應本公司截至目前為止對於未來的看法'),
      (3, '註：時程預期可能因主管機關審核速度、出口國設備審批、工期、客戶需求變化'),
      (4, '* Ref : Boeing COMMERCIAL MARKET OUTLOOK 2026–2045'),
      (5, '2026年第4季市場展望'),
      (6, '預期第四季營收季增 5%~8%,毛利率維持 30% 以上')]
ol_ = [t for _, t in cdm.outlook_of(L_)]
ok('㉑ 免責聲明 / 註腳 / 資料來源 / 只有標題 ⛔ 當成「講到之後」', ol_ == ['預期第四季營收季增 5%~8%,毛利率維持 30% 以上'], ol_)
ok('㉑a ⭐ 決定性對照:同一句真的展望照收', '預期第四季營收季增 5%~8%,毛利率維持 30% 以上' in ol_)
pg_disc = ['公司簡介\n本公司為台灣上市公司', '預測性陳述\n本簡報包含預測性資訊\n實際結果可能與預期不同\n預期明年營收成長 20%', '營運展望\n預期明年營收成長 20%']
f_ = cdm.feat_of(pg_disc, {})
ok('㉑b 免責那一頁整頁拿掉(同一頁 ≥2 行免責),別頁同一句照收', [p for p, _ in f_['outlook']] == [3], f_['outlook'])
f2_ = cdm.feat_of([pg_disc[0], '營運展望\n本公司說明\n預期明年營收成長 20%', pg_disc[2]], {})
ok('㉑c ⭐ 決定性對照:那一頁沒有免責 → 那一頁的展望也收', [p for p, _ in f2_['outlook']] == [2], f2_['outlook'])
tm_ = cdm.terms_of(['CHIEN-HUNG KUO 投資人關係 StockCode COMMERCIAL MARKET OUTLOOK Y19 YC02 CB410 H007 ISO27001 CAGR ISO',
                    'GB200 機櫃 CoWoS 產能 HVAC 空調 PMIC DRAM 導入'])
bad_ = [k for k in ('CHIEN-HUNG', 'CHIEN', 'HUNG', 'KUO', 'StockCode', 'COMMERCIAL', 'MARKET', 'OUTLOOK', 'Y19', 'YC02', 'CB410', 'H007', 'ISO27001', 'CAGR', 'ISO') if k in tm_]
ok('㉒ 產品詞 ⛔ 人名 / 英文單字 / 廠區料號 / 財務縮寫 / 認證', not bad_, bad_)
ok('㉒a ⭐ 決定性對照:真的產品 / 技術詞照收(GB200 / CoWoS / HVAC / PMIC / DRAM)', all(k in tm_ for k in ('GB200', 'CoWoS', 'HVAC', 'PMIC', 'DRAM')), tm_)
bo_ = cdm.best_outlook([[2, '經濟合作暨發展組織(OECD)2026年經濟展望報告指出全球經濟面臨科技投資強勁'], [5, '預期明年營收成長 15%,產能擴充一倍']])
ok('㉓ 清單那一句挑「有數字、講營運」的,總經背景排後面(⛔ 改寫)', bo_ == [5, '預期明年營收成長 15%,產能擴充一倍'], bo_)
ok('㉓a 只有一句 → 就是那一句;沒有 → None', cdm.best_outlook([[3, '預期明年持續成長']]) == [3, '預期明年持續成長'] and cdm.best_outlook([]) is None)


# ㉔ 🧾 舊版規則讀過的(cc_deep 已存)→ 載入時照現在的規則再篩一次,digest 那一句 ⛔ 是免責聲明(⛔ 重新下載)
with tempfile.TemporaryDirectory() as tmp:
    cdx, datax, ccx = setup(tmp, [])
    old_rec = {'s': '6770', 'name': '力積電', 'd': '2026-10-21', 'f': '677020261021M001.pdf', 'st': 'ok', 'pages': 18,
               'outlook': [[2, '本簡報中所提及之預測性資訊包括營運展望、財務狀況以及業務'], [9, '預期第四季稼動率回升至 80%']],
               'nums': [[3, '註:營收 100 億元'], [9, '預期第四季稼動率回升至 80%']], 'terms': {'KUO': 1, 'Y19': 2, 'PMIC': 9}, 'tone': [0, 0]}
    cdx._save_json(cdx.month_file('2026-10-01'), [old_rec])
    allx = cdx.load_all()
    rr = allx['2026-10'][0]
    ok('㉔ 舊特徵載入時再篩:免責那句、註腳那句、人名料號拿掉,真的展望 / 數字 / 產品詞留著',
       [p for p, _ in rr['outlook']] == [9] and [p for p, _ in rr['nums']] == [9] and list(rr['terms']) == ['PMIC'], rr)
    w, nd = cdx.build_outputs([rr], cdx.novelty_all([rr]), {}, date(2026, 10, 23))
    dg = json.loads((datax / 'confcall_digest.json').read_text(encoding='utf-8'))
    ok('㉔a 清單那一句變成真的展望(⛔ 免責聲明)', dg['rows'][0]['ol'].startswith('預期第四季稼動率'), dg['rows'][0])
    ok('㉔b 再篩一次結果不變(冪等)', cdx.refilter(json.loads(json.dumps(rr))) == rr)


# ㉕~㉘ 🧩 真資料第二批:PDF 斷行把一句切成兩半 / 中文簡報每句都有英文翻譯 / 圖表標題「2025 Sales Revenue」被當成數字
J_ = cdm._join_wrapped(['水主機配管的需求出現結構性噴發，本公司目前已接訂單量', '已排至2027年6月。2026年之銷售目標維持不變', '營收', '1,234', '2,345', '● 新產品量產'])
ok('㉕ 長的那一行沒有句尾 → 接上下一行,再照句號切開', '水主機配管的需求出現結構性噴發，本公司目前已接訂單量已排至2027年6月。' in J_, J_)
ok('㉕a ⭐ 決定性對照:表格那種短格子 ⛔ 接、條列 ⛔ 接進上一句', '營收' in J_ and '1,234' in J_ and '2,345' in J_ and '● 新產品量產' in J_, J_)
zh_ = [(1, '預期明年營收成長 15%,產能擴充一倍'), (1, 'Revenue is expected to grow 15% next year with capacity doubling'), (2, '毛利率維持 30% 以上')]
en_ = [(1, 'Revenue is expected to grow 15% next year'), (2, 'Gross margin above 30%'), (3, '產能')]
ok('㉖ 中文簡報裡幾乎全英文的翻譯句拿掉', [t for _, t in cdm.drop_translation(zh_)] == ['預期明年營收成長 15%,產能擴充一倍', '毛利率維持 30% 以上'], cdm.drop_translation(zh_))
ok('㉖a ⭐ 決定性對照:英文簡報 ⛔ 動', cdm.drop_translation(en_) == en_)
nm_ = [t for _, t in cdm.nums_of([(4, '2025 Sales Revenue'), (4, '2026Q3 營收'), (6, '截至2026/09未交貨訂單'), (11, '115年資本支出計畫'),
                                   (5, '出貨片數(仟片-約當12吋片數)'), (2, '毛利率 35.2%'), (5, '2026 年營收 120 億元'), (12, '1. Q3營收NT$213億→ QoQ +23%')])]
ok('㉗ 只是標題(年份 / 年月 / 民國年 / 季別 / 晶圓尺寸)⛔ 算公司給的數字;真的數字照收',
   nm_ == ['毛利率 35.2%', '2026 年營收 120 億元', '1. Q3營收NT$213億→ QoQ +23%'], nm_)
rk_ = cdm.rank_outlook([[11, '經濟合作暨發展組織(OECD)2026年經濟展望報告中指出全球經濟面臨科技投資強勁'], [14, '本公司目前已接訂單量已排至2027年6月,預期營收成長'], [12, '預期明年持續成長']])
ok('㉘ 講到之後照「有數字 / 講營運 / 講公司」排前面,總經背景排最後(原文不改)', [p for p, _ in rk_] == [14, 12, 11], rk_)


# ⑱ ⚡ 抽字引擎:有 pdftotext 用它(快好幾倍),沒有退回 pypdf —— 兩條路抽到的頁數與字要一樣
import shutil as _sh
_pdf3 = mini_pdf([['Outlook 2026', 'Revenue 1,350 million'], ['CapEx 42 billion'], ['Thank you']])
if _sh.which('pdftotext'):
    a_ = cdm.extract_pdf(_pdf3)
    _orig_which = cdm.shutil.which
    cdm.shutil.which = lambda n: None
    try:
        b_ = cdm.extract_pdf(_pdf3)
    finally:
        cdm.shutil.which = _orig_which
    ok('⑱ pdftotext 與 pypdf 抽到一樣的頁數(3 頁)', len(a_) == 3 and len(b_) == 3, (len(a_), len(b_)))
    ok('⑱b ⭐ 決定性對照:沒有 pdftotext → 退回 pypdf,第 2 頁一樣抽到 CapEx 42',
       'CapEx 42' in a_[1] and 'CapEx 42' in b_[1] and 'Revenue 1,350' in a_[0] and 'Revenue 1,350' in b_[0], (a_, b_))
else:
    print('ℹ️ ⑱ 這台機器沒有 pdftotext → 只驗 pypdf 那條')
    ok('⑱ 沒有 pdftotext 也抽得到(pypdf)', len(cdm.extract_pdf(_pdf3)) == 3)



# ㉙~㊳ 🧹 V79.6.4 巡邏修正(採礦端)——每一條都有「舊寫法會怎樣」的對照
# ㉙ 被擋那一頁(200 + 「因為安全性考量」)⛔ 當成檔案不在
class _BodySess:
    def __init__(self, body):
        self.body, self.n = body, 0
    def get(self, url, **kw):
        self.n += 1
        body = self.body
        class R:
            status_code = 200
            headers = {}
            def iter_content(s, n): yield body
            def close(s): pass
        return R()
_blk = '<html><head><title>公開資訊觀測站 | 錯誤</title></head><body>因為安全性考量,您的網頁請求被拒絕</body></html>'
fb_ = cdm.Fetcher(session=_BodySess(_blk.encode('big5')), pace=0, sleeper=lambda x: None)
bb_, eb_ = fb_.get('https://x/f?fileName=a.pdf')
fn_ = cdm.Fetcher(session=_BodySess('<html><head><title>公開資訊觀測站 | 查無資料</title></head></html>'.encode('utf-8')), pace=0, sleeper=lambda x: None)
bn_, en_ = fn_.get('https://x/f?fileName=a.pdf')
ok('㉙ 被擋那一頁(Big5「因為安全性考量」)→ blocked(⛔ 當成檔案不在)', bb_ is None and eb_.startswith('blocked:') and cdm.err_kind('nas:' + eb_) == 'blocked', eb_)
ok('㉙a ⭐ 決定性對照:一般的網頁(查無資料)→ 還是 not_file / nf', bn_ is None and en_.startswith('not_file:') and cdm.err_kind('srv:' + en_ + ' | nas:' + en_) == 'nf', en_)
ok('㉙b 原因裡的「|」換掉(⛔ 讓 err_kind 把網頁標題切成第三條路)', ' | ' not in eb_ and ' | ' not in en_ and '¦' in en_, (eb_, en_))


class _BlkFetcher(FakeFetcher):
    """每一份都回指定原因;記下退避等了幾秒"""
    def __init__(self, err):
        super().__init__({})
        self.err, self.slept = err, []
    def get(self, url):
        self.calls.append(url.split('fileName=')[-1])
        return None, self.err
    def sleep(self, x):
        self.slept.append(x)


with tempfile.TemporaryDirectory() as tmp:
    rows_b = [{'s': str(4000 + i), 'name': 'x', 'd': '2026-09-0' + str(i + 1), 'pdf': [f'{4000 + i}2026090{i + 1}M001.pdf']} for i in range(6)]
    gho = Path(tmp) / 'gh_out.txt'
    cd, data, cc = setup(tmp, rows_b, GITHUB_OUTPUT=gho)
    fbk = _BlkFetcher('srv:blocked:<html>因為安全性考量')
    lgb = []
    rcb_ = cd.run(fetcher=fbk, groq_keys=[], today=date(2026, 10, 23), log=lgb.append)
    idxb = json.loads((cc / 'cc' / 'index.json').read_text(encoding='utf-8'))['files']
    outb = gho.read_text(encoding='utf-8')
    ok(f'㉙c 連 {cdm.BLOCK_STOP} 份被擋 → 收工(⛔ 硬打)、中間照退避等({list(cdm.BLOCK_BACKOFF[:cdm.BLOCK_STOP - 1])} 秒)、紅燈',
       len(fbk.calls) == cdm.BLOCK_STOP and fbk.slept == list(cdm.BLOCK_BACKOFF[:cdm.BLOCK_STOP - 1]) and rcb_ == 1 and 'reason=blocked' in outb,
       (fbk.calls, fbk.slept, rcb_, outb))
    ok('㉙d 被擋的那幾份記 dl_fail、試過次數 ⛔ 加(⛔ 算這份檔的錯、⛔ 永久 bad_file)',
       all(v['st'] == 'dl_fail' and v['tries'] == 0 for v in idxb.values()) and len(idxb) == cdm.BLOCK_STOP, idxb)
    ok('㉝ 💾 紅燈也寫 ran=1(workflow 照推 cc_deep → 紀錄存得住)', 'ran=1' in outb and (cc / 'cc' / 'index.json').exists(), outb)
    # ⭐ 決定性對照:同 6 份(都開完超過 3 天)回一般網頁 = 檔案真的不在 → 全部試完、標 bad_file、⛔ 紅燈
    cd, data, cc = setup(tmp, rows_b, GITHUB_OUTPUT=gho)
    shutil_rm = __import__('shutil').rmtree
    shutil_rm(cc, ignore_errors=True)
    fnf = _BlkFetcher('srv:not_file:<html>查無資料')
    rcn_ = cd.run(fetcher=fnf, groq_keys=[], today=date(2026, 10, 23), log=lambda x: None)
    idxn = json.loads((cc / 'cc' / 'index.json').read_text(encoding='utf-8'))['files']
    ok('㉙e ⭐ 決定性對照:同 6 份回「查無資料」→ 6 份都試、全部 bad_file、⛔ 退避、⛔ 紅燈(檔案不在 ≠ 壞掉)',
       len(fnf.calls) == 6 and not fnf.slept and all(v['st'] == 'bad_file' for v in idxn.values()) and rcn_ == 0, (fnf.calls, fnf.slept, rcn_))

# ㉞ 檔案路徑 404 + 下載程式回網頁 = 檔案不在(舊版當暫時性 → 白試 3 輪、還算連續失敗)
ok('㉞ nas 404 + srv 回網頁 → nf(兩種順序都是)', cdm.err_kind('nas:HTTP 404 | srv:not_file:<html>') == 'nf'
   and cdm.err_kind('srv:not_file:<html> | nas:HTTP 404') == 'nf')
ok('㉞a ⭐ 決定性對照:nas 404 但下載程式逾時 → 還是暫時性(下載程式那條沒說檔案不在)', cdm.err_kind('nas:HTTP 404 | srv:ReadTimeout@20s') == 'tmp')
ok('㉞b 任一條被擋 → blocked(先於 nf 判斷)', cdm.err_kind('nas:blocked:<html> | srv:not_file:x') == 'blocked')

# ㉜ 數字核對改成「整個數字」比 —— 舊版子字串:「20」在「2026」裡、「5」在頁碼 p5 裡都算找得到
_src = 'p3 預計 2026 年營收成長 15%\np5 毛利率 53.10%\np12 產能 1,200 片'
ok('㉜ AI 編的「成長 20%」抓得到(原文只有 2026 / 15)', cdm.num_gate('營收成長 20%', _src) == ['20'], cdm.num_gate('營收成長 20%', _src))
ok('㉜a 頁碼標籤不算原文的數字:「5 成」抓得到(原文只有 p5)', cdm.num_gate('5 成', _src) == ['5'], cdm.num_gate('5 成', _src))
ok('㉜b 原文有的照過:53.1 = 53.10、1200 = 1,200、2026 年', all(not cdm.num_gate(t, _src) for t in ('毛利率 53.1%', '產能 1200 片', '2026 年營收成長 15%')))
ok('㉜c AI 句子裡自己寫的頁碼(p5 / 第 12 頁)⛔ 算數字主張', not cdm.num_gate('見 p5 說明', _src) and not cdm.num_gate('第 12 頁:成長 15%', _src))
_old_gate = lambda text, source: [n for n in cdm._NUM_ONLY.findall(text) if n.replace(',', '').rstrip('.') not in re.sub(r'(?<=\d),(?=\d)', '', source)]
ok('㉜d ⭐ 決定性對照:舊的子字串比法同一句會放行(「20」⊂「2026」)', _old_gate('營收成長 20%', _src) == [] and _old_gate('5 成', _src) == [])

# ㉟ PDF 字型的私用區字元( 項目符號)在手機上是方框 → 抽字時拿掉;舊特徵載入時也洗一次
ok('㉟ _clean 拿掉私用區字元(\\uf06e / \\uf0b7),中文照留', cdm._clean(' 營收成長 15%') == ' 營收成長 15%' and cdm._clean('毛利率 30%') == '毛利率 30%', repr(cdm._clean(' 營收成長 15%')))
_rr = {'st': 'ok', 'outlook': [[3, '預期明年營收成長 15%,產能擴充一倍']], 'nums': [[4, '毛利率維持 30% 以上']], 'titles': [[1, '營運展望']], 'terms': {}}
_rf = cdm.refilter(json.loads(json.dumps(_rr)))
ok('㉟a 舊特徵(cc_deep 存的)載入時再洗:句子裡沒有私用區字元、內容不變', all('' not in t and '' not in t for _, t in _rf['outlook'] + _rf['nums'] + _rf['titles'])
   and _rf['outlook'][0][1] == '預期明年營收成長 15%,產能擴充一倍', _rf)
ok('㉟b 再洗一次結果不變(冪等)', cdm.refilter(json.loads(json.dumps(_rf))) == _rf)

# ㉚ 清單回補連 3 個月被擋 → 還沒輪到的月份也記「沒抓齊」(接力那幾棒 ⛔ 帶起訖月,不記就永遠沒人查)
_bl = {'months': {}, 'rows': []}
_got = []
def _lf_block(typek, ym):
    _got.append(ym)
    return [], '被主機擋(安全性考量)'
cdm.list_backfill(_bl, [(2026, 8), (2026, 7), (2026, 6), (2026, 5), (2026, 4)], date(2026, 10, 23), fetch=_lf_block, log=lambda x: None, sleeper=lambda x: None)
ok('㉚ 連 3 個月被擋 → 收手(5 月 / 4 月 ⛔ 打);但 5 月 / 4 月也記成「沒抓齊」(下一輪 retry 會抓)',
   sorted(set(_got)) == [(2026, 6), (2026, 7), (2026, 8)] and all(not _bl['months'].get(k, {'ok': True}).get('ok') for k in ('2026-05', '2026-04'))
   and _bl['months']['2026-04'].get('skip') == 1, (_got, _bl['months']))
_bl2 = {'months': {}, 'rows': []}
cdm.list_backfill(_bl2, [(2026, 8), (2026, 7)], date(2026, 10, 23), fetch=lambda t, ym: ([{'s': '1', 'd': '2026-07-01', 'pdf': ['x.pdf']}], None), log=lambda x: None, sleeper=lambda x: None)
ok('㉚a ⭐ 決定性對照:沒被擋 → 每個月都 ok、沒有 skip 紀錄', all(v.get('ok') and not v.get('skip') for v in _bl2['months'].values()) and len(_bl2['months']) == 2, _bl2['months'])

# ㉛ 暫時性失敗「一天算一次」:同一天 ⛔ 再試、3 個不同的日子之後才放棄
with tempfile.TemporaryDirectory() as tmp:
    rows_t = [{'s': '6001', 'name': 'x', 'd': '2026-10-01', 'pdf': ['600120261001M001.pdf']}]
    cd, data, cc = setup(tmp, rows_t)
    seq = []
    for dd in (date(2026, 10, 20), date(2026, 10, 20), date(2026, 10, 21), date(2026, 10, 22), date(2026, 10, 23)):
        f_ = FakeFetcher({})
        cd.run(fetcher=f_, groq_keys=[], today=dd, log=lambda x: None)
        st_ = json.loads((cc / 'cc' / 'index.json').read_text(encoding='utf-8'))['files'].get('600120261001M001.pdf', {})
        seq.append((len(f_.calls), st_.get('tries')))
    ok('㉛ 同一份連不上:10/20 試 → 10/20 再跑 ⛔ 試 → 10/21、10/22 各試一次 → 滿 3 天之後 ⛔ 再試',
       seq == [(1, 1), (0, 1), (1, 2), (1, 3), (0, 3)], seq)
    dgt = json.loads((data / 'confcall_digest.json').read_text(encoding='utf-8'))
    ok('㉛a 放棄之後清單那一列標 gave_up=1(App 才寫得出「試了 3 天都沒下載到」)',
       [(r['st'], r.get('gave_up')) for r in dgt['rows']] == [('dl_fail', 1)], dgt['rows'])
    # ⭐ 決定性對照:舊格式紀錄(沒有 last)→ 同一天照樣會試(= 舊版行為)
    ix = json.loads((cc / 'cc' / 'index.json').read_text(encoding='utf-8'))
    ix['files']['600120261001M001.pdf'] = {'st': 'dl_fail', 'err': 'ConnectionError', 's': '6001', 'd': '2026-10-01', 'tries': 1}
    (cc / 'cc' / 'index.json').write_text(json.dumps(ix), encoding='utf-8')
    f_ = FakeFetcher({})
    cd.run(fetcher=f_, groq_keys=[], today=date(2026, 10, 23), log=lambda x: None)
    ok('㉛b ⭐ 決定性對照:沒有 last 的舊紀錄 → 同一天照樣試(試過次數 +1)', len(f_.calls) == 1, f_.calls)

# ㊲ 「還沒上傳」的(開完 3 天內回網頁)再多也 ⛔ 紅燈(那是正常的,⛔ 不是壞掉)
with tempfile.TemporaryDirectory() as tmp:
    rows_y = [{'s': str(7100 + i), 'name': 'x', 'd': '2026-10-22', 'pdf': [f'{7100 + i}20261022M001.pdf']} for i in range(6)]
    cd, data, cc = setup(tmp, rows_y)
    fy = _BlkFetcher('srv:not_file:<html>')
    rcy = cd.run(fetcher=fy, groq_keys=[], today=date(2026, 10, 23), log=lambda x: None)
    ok('㊲ 6 份昨天才開完的都還沒上傳 → 全部試、rc 0(⛔ 紅燈)、記 dl_fail(明天再試)',
       len(fy.calls) == 6 and rcy == 0 and all(v['st'] == 'dl_fail' for v in json.loads((cc / 'cc' / 'index.json').read_text(encoding='utf-8'))['files'].values()), (fy.calls, rcy))

# ㊳ 紀錄格式升到 v2(一次):舊版標的 bad_file 重新判(有些其實是被擋)・「太慢」失敗的重新算次數
with tempfile.TemporaryDirectory() as tmp:
    rows_m = [{'s': '8101', 'name': 'x', 'd': '2026-09-01', 'pdf': ['810120260901M001.pdf']},
              {'s': '8102', 'name': 'x', 'd': '2026-09-02', 'pdf': ['810220260902M001.pdf']},
              {'s': '8103', 'name': 'x', 'd': '2026-09-03', 'pdf': ['810320260903M001.pdf']}]
    cd, data, cc = setup(tmp, rows_m)
    (cc / 'cc').mkdir(parents=True, exist_ok=True)
    (cc / 'cc' / 'index.json').write_text(json.dumps({'files': {
        '810120260901M001.pdf': {'st': 'bad_file', 'err': 'not_file:<html>', 's': '8101', 'd': '2026-09-01', 'tries': 1},
        '810220260902M001.pdf': {'st': 'dl_fail', 'err': 'slow:3008KB/120s', 's': '8102', 'd': '2026-09-02', 'tries': 3},
        '810320260903M001.pdf': {'st': 'dl_fail', 'err': 'ConnectionError', 's': '8103', 'd': '2026-09-03', 'tries': 3}}}), encoding='utf-8')
    fm = FakeFetcher({'810120260901M001.pdf': PDF_OLD, '810220260902M001.pdf': PDF_NEW})
    lgm = []
    cd.run(fetcher=fm, groq_keys=[], today=date(2026, 10, 23), log=lgm.append)
    ixm = json.loads((cc / 'cc' / 'index.json').read_text(encoding='utf-8'))
    ok('㊳ 升 v2:舊的 bad_file 重新判(這次讀到了)、太慢失敗滿 3 次的重新算(讀到了)、其他原因滿 3 次的 ⛔ 動',
       sorted(fm.calls) == ['810120260901M001.pdf', '810220260902M001.pdf'] and ixm.get('v') == cdm.IDX_VER
       and ixm['files']['810120260901M001.pdf']['st'] == 'ok' and ixm['files']['810220260902M001.pdf']['st'] == 'ok'
       and ixm['files']['810320260903M001.pdf']['tries'] == 3 and any('紀錄格式升到' in x for x in lgm), (fm.calls, ixm))
    fm2 = FakeFetcher({})
    lgm2 = []
    cd.run(fetcher=fm2, groq_keys=[], today=date(2026, 10, 23), log=lgm2.append)
    ok('㊳a 已經是 v2 → ⛔ 再搬(冪等)', not fm2.calls and not any('紀錄格式升到' in x for x in lgm2), (fm2.calls, lgm2[:3]))

# ㉝b workflow:推 cc_deep 那步紅燈也跑(看 ran=1);部署 / 接力照舊只在成功時
_wf = (ROOT / '.github' / 'workflows' / 'confcall_deck.yml').read_text(encoding='utf-8')
_push = _wf[_wf.index('🚀 推 cc_deep'):_wf.index('🚀 部署 data/cc')]
_dep = _wf[_wf.index('🚀 部署 data/cc'):_wf.index('🔁 接力(回補還沒讀完)')]
ok("㉝b workflow 推 cc_deep 那步:`!cancelled() && steps.run.outputs.ran == '1'`(紅燈也推、selftest 沒過 ⛔ 推)",
   "!cancelled()" in _push and "steps.run.outputs.ran == '1'" in _push, _push[:300])
ok('㉝c 部署那步 ⛔ 跟著紅燈跑(沒有 always / !cancelled)', 'always()' not in _dep and '!cancelled()' not in _dep, _dep[:200])


# ㊴~㊶ 📏📎 V79.6.4 下載提速 大簡報不再整份放棄(10/23 第 4 輪:8~16 MB 的 4 份在固定 240 秒內下載不完,40 分鐘白花 18 分)
class RgResp:
    def __init__(s, clk, body, start, kbs, code, hdrs, cut=None, exc=True):
        s.clk, s.body, s.start, s.kbs, s.status_code, s.headers, s.cut, s.exc = clk, body, start, kbs, code, hdrs, cut, exc
    def iter_content(s, n):
        pos = s.start
        while pos < len(s.body):
            if s.cut is not None and pos >= s.cut:
                if s.exc:
                    raise ConnectionError('connection reset')
                return                                   # 連線提早結束(沒丟例外)
            ch = s.body[pos:pos + 16384]
            s.clk['t'] += len(ch) / 1024 / s.kbs
            pos += len(ch)
            yield ch
    def close(s):
        pass
class RgSess:
    """mode:'range' 支援續傳 / 'ignore' 不理 Range(回 200 整份)/ 'wrong' 回 206 但起點不對 / 'blockseg' 分段請求回被擋的網頁
       kbs:{'nas': KB/s, 'srv': KB/s} ・cut:第一次請求在第幾個 byte 斷 ・early:斷法改成提早結束不丟例外 ・clen:有沒有 Content-Length
       segcut:{分段起點: 第幾個 byte 斷}(只斷第一次)"""
    def __init__(s, clk, body, kbs, mode='range', cut=None, early=False, clen=True, segcut=None):
        s.clk, s.body, s.kbs, s.mode, s.cut, s.early, s.clen, s.calls = clk, body, kbs, mode, cut, early, clen, []
        s.segcut = dict(segcut or {})
    def get(s, url, headers=None, **kw):
        k = 'nas' if '/nas/STR/' in url else 'srv'
        rg = (headers or {}).get('Range')
        s.calls.append((k, rg))
        n = len(s.body)
        cut = s.cut if len(s.calls) == 1 else None
        if rg and s.mode in ('range', 'wrong', 'blockseg'):
            lo, _, hi = rg.split('=')[1].partition('-')
            a, z = int(lo), (int(hi) if hi else n - 1)
            if s.mode == 'blockseg' and hi:
                return RgResp(s.clk, BLOCK_HTML, 0, s.kbs[k], 200, {'Content-Length': str(len(BLOCK_HTML))})
            st = a if s.mode in ('range', 'blockseg') else max(0, a - 1000)
            if hi and a in s.segcut:
                c = s.segcut.pop(a)
                return RgResp(s.clk, s.body[:z + 1], st, s.kbs[k], 206, {'Content-Range': f'bytes {st}-{z}/{n}'}, st + c, True)
            return RgResp(s.clk, s.body[:z + 1], st, s.kbs[k], 206, {'Content-Range': f'bytes {st}-{z}/{n}', 'Content-Length': str(z - st + 1)},
                          cut, not s.early)
        return RgResp(s.clk, s.body, 0, s.kbs[k], 200, ({'Content-Length': str(n)} if s.clen else {}), cut, not s.early)
BLOCK_HTML = '<html><body>因為安全性考量,您的連線已被拒絕</body></html>'.encode('utf-8')
def _rgf(sess, clk):
    return cdm.Fetcher(session=sess, pace=0, sleeper=lambda x: clk.__setitem__('t', clk['t'] + x), clock=lambda: clk['t'])
B6 = b'%PDF-1.4\n' + b'x' * (6 * 1024 * 1024)
NAS = 'https://mopsov.twse.com.tw/nas/STR/641420261016M001.pdf'
ok('㊴0 時限照大小算:不知道多大 240 秒・6 MB 307 秒・16 MB 封頂 600 秒',
   cdm.dl_limit(0) == cdm.DL_MAX_SEC and abs(cdm.dl_limit(6 * 1024 * 1024) - 307.2) < 0.1 and cdm.dl_limit(16 * 1024 * 1024) == cdm.DL_BIG_MAX_SEC,
   (cdm.dl_limit(0), cdm.dl_limit(6 * 1024 * 1024), cdm.dl_limit(16 * 1024 * 1024)))
ck39 = {'t': 0.0}
b39, e39 = _rgf(RgSess(ck39, B6, {'nas': 25, 'srv': 25}), ck39).get(NAS)
ok('㊴ 6 MB、每秒 25 KB(要 246 秒,超過舊的固定 240 秒)→ 照大小給時間,下載得完', b39 == B6 and e39 == '' and 240 < ck39['t'] < 300, (e39, ck39['t']))
_old_big = cdm.DL_BIG_MAX_SEC
cdm.DL_BIG_MAX_SEC = cdm.DL_MAX_SEC                       # 退回舊寫法:不管多大一律 240 秒
ck39b = {'t': 0.0}
b39b, e39b = _rgf(RgSess(ck39b, B6, {'nas': 25, 'srv': 25}), ck39b).get(NAS)
cdm.DL_BIG_MAX_SEC = _old_big
ok('㊴b ⭐ 決定性對照:退回固定 240 秒 → 同一份 20 秒就判下載不完、整份放棄', b39b is None and e39b.startswith('slow:') and ck39b['t'] < 30, (e39b, ck39b['t']))

B2 = b'%PDF-1.4\n' + bytes(range(256)) * (8 * 1024)        # 2 MB(內容會變,拼錯一段就對不上)
CUT = 50 * 16384
ck40 = {'t': 0.0}
s40 = RgSess(ck40, B2, {'nas': 50, 'srv': 50}, mode='range', cut=CUT)
f40 = _rgf(s40, ck40)
b40, e40 = f40.get(NAS)
ok('㊵ 下載到 800 KB 斷線 → 第二次帶 Range 從 800 KB 接著拿,拼起來一個位元組都不差', b40 == B2 and e40 == '' and s40.calls == [('nas', None), ('nas', f'bytes={CUT}-')]
   and f40.resumed == 1, (e40, s40.calls, f40.resumed, len(b40 or b'')))
ck40b = {'t': 0.0}
s40b = RgSess(ck40b, B2, {'nas': 50, 'srv': 50}, mode='ignore', cut=CUT)
f40b = _rgf(s40b, ck40b)
b40b, e40b = f40b.get(NAS)
ok('㊵b ⭐ 決定性對照:主機不理 Range(回 200 整份)→ 整份重來,⛔ 把整份接在半份後面', b40b == B2 and e40b == '' and s40b.calls[1] == ('nas', f'bytes={CUT}-')
   and f40b.resumed == 0, (e40b, s40b.calls, len(b40b or b'')))
ck40c = {'t': 0.0}
s40c = RgSess(ck40c, B2, {'nas': 50, 'srv': 50}, mode='wrong', cut=CUT)
b40c, e40c = _rgf(s40c, ck40c).get(NAS)
ok('㊵c 主機回 206 但起點對不上 → ⛔ 接、下一次整份重來', b40c == B2 and e40c == '' and s40c.calls == [('nas', None), ('nas', f'bytes={CUT}-'), ('nas', None)],
   (e40c, s40c.calls))
ck40d = {'t': 0.0}
s40d = RgSess(ck40d, B2, {'nas': 50, 'srv': 50}, mode='range', cut=CUT, early=True)
b40d, e40d = _rgf(s40d, ck40d).get(NAS)
ok('㊵d 連線提早結束(沒丟例外、知道檔案多大)→ 看得出來只拿到一半 → 續傳拿完(⛔ 把半份 PDF 當成功)', b40d == B2 and len(s40d.calls) == 2, (e40d, s40d.calls))
ck40e = {'t': 0.0}
s40e = RgSess(ck40e, B2, {'nas': 50, 'srv': 50}, mode='range', cut=CUT, early=True, clen=False)
b40e, e40e = _rgf(s40e, ck40e).get(NAS)
ok('㊵e 對照:不知道檔案多大 → 看不出被截斷(所以㊵d 靠 Content-Length;抽字會再擋一次)', b40e is not None and len(b40e) == CUT and len(s40e.calls) == 1,
   (len(b40e or b''), s40e.calls))

# ㊶ 兩條路合起來一份最多 dl_limit(檔案大小) 秒(放寬時限之後,兩條各自從頭算會變成一份 20 分鐘)
B9 = b'%PDF-1.4\n' + b'y' * (9830 * 1024)               # 9.6 MB(10/23 7715 那份的大小)
ck41 = {'t': 0.0}
s41 = RgSess(ck41, B9, {'nas': 10, 'srv': 25})
b41, e41, k41 = _rgf(s41, ck41).get_any(cdm.file_urls(TPL, '771520261022M001.pdf'))
ok('㊶ 檔案路徑每秒 10 KB(20 秒就算得出下載不完)→ 換下載程式、只拿剩下的時間,25 KB/s 下載得完',
   b41 == B9 and k41 == 'srv' and ck41['t'] <= cdm.dl_limit(len(B9)) + 5, (e41, k41, round(ck41['t']), [c[0] for c in s41.calls]))
ck41b = {'t': 0.0}
s41b = RgSess(ck41b, B9, {'nas': 10, 'srv': 25}, mode='ignore', clen=False)
b41b, e41b, k41b = _rgf(s41b, ck41b).get_any(cdm.file_urls(TPL, '771520261022M001.pdf'))
ok('㊶b 不知道多大、檔案路徑慢慢給到時限 → 下載程式那條沒時間了就 ⛔ 換(一份 ⛔ 拖到 480 秒)',
   b41b is None and 'srv:skip:' in e41b and all(c[0] == 'nas' for c in s41b.calls) and ck41b['t'] <= cdm.DL_MAX_SEC + 5
   and cdm.err_kind(e41b) == 'tmp', (e41b, round(ck41b['t']), s41b.calls[:3]))
ck41c = {'t': 0.0}
rs41 = RouteSess({'srv': 'pdf', 'nas': 'html'}, ck41c)
b41c, e41c, k41c = cdm.Fetcher(session=rs41, pace=0, sleeper=lambda x: None, clock=lambda: ck41c['t']).get_any(cdm.file_urls(TPL, '233020260716M001.pdf'))
ok('㊶c ⭐ 決定性對照:檔案路徑馬上回網頁 → 下載程式照樣有整份的時間(⛔ 誤判成沒時間)', b41c and k41c == 'srv' and rs41.calls == ['nas', 'srv'], (e41c, rs41.calls))
ok('㊶d 原因字串的續傳紀錄不會被 err_kind 當成兩條路的分隔', cdm.err_kind('nas:ConnectionError@3s(已800KB);續傳@800KB | srv:slow:100KB/240s') == 'tmp')
# ㊸ 🔀 檔案路徑分段同時下載(deck_dl_probe 10/23 實測:一條 19~37 KB/s、四條合計 69~149 KB/s,主機是「每條連線限速」)
def _segs(calls):
    return sorted(int(r.split('=')[1].split('-')[0]) for k, r in calls if r and r != 'bytes=0-' and not r.endswith('-'))
def _ranges_ok(calls, n):
    rr = sorted((int(a), int(b)) for k, r in calls if r and not r.endswith('-') for a, b in [r.split('=')[1].split('-')])
    return rr and rr[0][0] == 0 and rr[-1][1] == n - 1 and all(rr[i][1] + 1 == rr[i + 1][0] for i in range(len(rr) - 1))
ck43 = {'t': 0.0}
s43 = RgSess(ck43, B9, {'nas': 400, 'srv': 25})
f43 = _rgf(s43, ck43)
b43, e43, k43 = f43.get_any(cdm.file_urls(TPL, '641420261016M001.pdf'))
ok('㊸ 9.6 MB:先問「bytes=0-」→ 206 → 分 4 段同時下載,4 段剛好接成整份(沒有縫、沒有重疊),拼起來一個位元組都不差',
   b43 == B9 and k43 == 'nas' and s43.calls[0] == ('nas', 'bytes=0-') and len(_segs(s43.calls)) == cdm.DL_CONN
   and _ranges_ok(s43.calls, len(B9)) and f43.par == 1, (e43, s43.calls[:6]))
_old_conn = cdm.DL_CONN
cdm.DL_CONN = 1
ck43b = {'t': 0.0}
s43b = RgSess(ck43b, B9, {'nas': 400, 'srv': 25})
b43b, e43b, k43b = _rgf(s43b, ck43b).get_any(cdm.file_urls(TPL, '641420261016M001.pdf'))
cdm.DL_CONN = _old_conn
ok('㊸b ⭐ 決定性對照:CC_DL_CONN=1(逃生門)→ 一條連線、⛔ 帶 Range,一個請求拿完整份', b43b == B9 and s43b.calls == [('nas', None)], (e43b, s43b.calls))
ck43c = {'t': 0.0}
s43c = RgSess(ck43c, B9, {'nas': 400, 'srv': 25}, mode='ignore')
f43c = _rgf(s43c, ck43c)
b43c, e43c, k43c = f43c.get_any(cdm.file_urls(TPL, '641420261016M001.pdf'))
ok('㊸c 主機不支援分段(回 200 整份)→ 那個回應就是整份,照一條連線讀完(⛔ 多發一次請求)', b43c == B9 and s43c.calls == [('nas', 'bytes=0-')] and f43c.par == 0,
   (e43c, s43c.calls))
SMALL = b'%PDF-1.4\n' + b's' * (600 * 1024)
ck43d = {'t': 0.0}
s43d = RgSess(ck43d, SMALL, {'nas': 400, 'srv': 25})
f43d = _rgf(s43d, ck43d)
b43d, e43d, k43d = f43d.get_any(cdm.file_urls(TPL, '233020261015M001.pdf'))
ok('㊸d 小檔(600 KB < 1 MB)→ 「bytes=0-」回的 206 就是整份,⛔ 分段、⛔ 再發請求', b43d == SMALL and s43d.calls == [('nas', 'bytes=0-')] and f43d.par == 0,
   (e43d, s43d.calls))
ck43e = {'t': 0.0}
s43e = RgSess(ck43e, B9, {'nas': 400, 'srv': 25}, segcut={2 * len(B9) // 4: 300 * 1024})
f43e = _rgf(s43e, ck43e)
b43e, e43e, k43e = f43e.get_any(cdm.file_urls(TPL, '641420261016M001.pdf'))
_st3 = 2 * len(B9) // 4
_re = [r for k, r in s43e.calls if r and not r.endswith('-') and _st3 < int(r.split('=')[1].split('-')[0]) < 3 * len(B9) // 4]
ok('㊸e 第 3 段下載到 300 KB 斷線 → 那一段從斷掉的地方續傳(其他段不重來),拼起來一個位元組都不差',
   b43e == B9 and len(_re) == 1 and len(_segs(s43e.calls)) == cdm.DL_CONN + 1, (e43e, s43e.calls))
ck43f = {'t': 0.0}
s43f = RgSess(ck43f, B9, {'nas': 400, 'srv': 400}, mode='blockseg')
b43f, e43f = _rgf(s43f, ck43f).get(cdm.file_urls(TPL, '641420261016M001.pdf')[1][1], parallel=True)
ok('㊸f 分段請求回「因為安全性考量」那一頁 → 全部停、這份算被擋(⛔ 把網頁拼進 PDF)', b43f is None and e43f.startswith('blocked:') and cdm.err_kind('nas:' + e43f) == 'blocked',
   (e43f[:160], s43f.calls[:6]))
ck43g = {'t': 0.0}
s43g = RgSess(ck43g, B9, {'nas': 400, 'srv': 400}, mode='wrong')
f43g = _rgf(s43g, ck43g)
b43g, e43g = f43g.get(cdm.file_urls(TPL, '641420261016M001.pdf')[1][1], parallel=True)
ok('㊸g 分段回 206 但起點對不上 → 那份失敗(⛔ 拼出錯的檔)', b43g is None and ('起點' in e43g or '看不懂' in e43g), (e43g, s43g.calls[:6]))

# ㊷ job 時限要裝得下「讀到 40 分才停止開新的 + 最後那份大簡報下載滿 + 抽字 + AI + 補摘要 + 推檔」(被砍掉 = 整輪白讀,紀錄在最後才存)
_tm = int(re.search(r'timeout-minutes:\s*(\d+)', _wf).group(1))
# 安裝平常 3 分、apt 慢的時候 5 分;推檔兩個分支各 5 次重試(5~25 秒)+ 接力 → 抓 5 分
# 🛰️ V79.7.7 + 舊簡報重抽「講到的詞」(RETERM_SEC;最後一個月份可能超過一點)+ 主題雷達 → 再多抓 60 秒
_need = 5 * 60 + cdm.BUDGET_MIN * 60 + cdm.DL_BIG_MAX_SEC + cdm.EXTRACT_MAX_SEC + cdm.AI_DEADLINE + cdm.AI_FILL_SEC + cdm.AI_DEADLINE + cdm.RETERM_SEC + 60 + 5 * 60
ok('㊷ job 時限 ≥ 安裝 5 分 + 讀簡報上限 + 最後一份下載上限 + 抽字 + AI + 補摘要(+ 最後一次 AI)+ 重抽詞 + 雷達 + 推檔 5 分(改其中任何一個時限要一起看)',
   _tm * 60 >= _need, (_tm, round(_need / 60, 1)))


# ㊹ 🤖 V79.6.5 補摘要:讀的那一輪 AI 次數用完 → 之後每輪用剩下的次數補(拿存好的重點句,⛔ 不重新下載)
#    10/23 第 4 棒:讀 47 份、AI 上限 40 次 → 7 份永遠沒有一句話(讀過的 ⛔ 不會再讀)
ANS_OK = {'one': '營收 100 億、AI 伺服器成長', 'outlook': [{'t': 'AI 伺服器成長', 'p': 1}], 'new': [], 'risk': []}
with tempfile.TemporaryDirectory() as tmp:
    rows = [{'s': str(4100 + i), 'name': f'補{i}', 'd': f'2026-10-{15 + i}', 't': '14:00', 'pdf': [f'{4100 + i}202610{15 + i}M001.pdf']} for i in range(3)]
    tbl = {r['pdf'][0]: deck([['公司', 'Outlook', 'Expect AI server growth next year'], ['Revenue 100 million, up 8%']]) for r in rows}
    cd, data, cc = setup(tmp, rows, CC_AI_MAX=1)
    called = []

    def sum_ok(name, sym, d, feat, keys, **kw):
        called.append((sym, len(feat.get('outlook') or []) + len(feat.get('nums') or [])))
        return dict(ANS_OK), 'qwen/qwen3.8-27b', 0
    cd.groq_summarize = sum_ok
    ff1 = FakeFetcher(tbl)
    cd.run(fetcher=ff1, groq_keys=['k1'], today=date(2026, 10, 23), log=lambda x: None)
    has_ai = lambda s: bool(((json.loads((data / 'cc' / f'{s}.json').read_text(encoding='utf-8'))['decks'] or [{}])[0]).get('ai'))
    ok('㊹ 第一輪:AI 上限 1 次 → 最新那份(4102)有摘要、另外兩份沒有(重現 10/23 第 4 棒的缺口)',
       has_ai('4102') and not has_ai('4101') and not has_ai('4100') and [c[0] for c in called] == ['4102'], called)
    ff2, lg2 = FakeFetcher(tbl), []
    called.clear()
    cd.run(fetcher=ff2, groq_keys=['k1'], today=date(2026, 10, 23), log=lg2.append)
    ok('㊹b 第二輪:沒有新簡報要讀 → 用剩下的 1 次補 4101(新 → 舊)、⛔ 不重新下載',
       has_ai('4101') and not has_ai('4100') and ff2.calls == [] and [c[0] for c in called] == ['4101'] and called[0][1] > 0
       and any('補摘要:1 份' in x for x in lg2) and any('還差 1 份' in x for x in lg2), (called, ff2.calls, [x for x in lg2 if '補摘要' in x]))
    dg = json.loads((data / 'confcall_digest.json').read_text(encoding='utf-8'))
    ok('㊹c 補到的摘要進得了法說會清單(digest 的 one)', next((r for r in dg['rows'] if r['s'] == '4101'), {}).get('one') == ANS_OK['one'], dg['rows'][:3])
    cd.run(fetcher=FakeFetcher(tbl), groq_keys=['k1'], today=date(2026, 10, 23), log=lambda x: None)
    ok('㊹d 第三輪補完最後一份;第四輪沒有要補的 → ⛔ 不叫 AI', has_ai('4100'), called)
    called.clear()
    cd.run(fetcher=FakeFetcher(tbl), groq_keys=['k1'], today=date(2026, 10, 23), log=lambda x: None)
    ok('㊹d2 (第四輪)全部都有摘要 → 0 次', called == [], called)

with tempfile.TemporaryDirectory() as tmp:
    rows = [{'s': str(4200 + i), 'name': f'對{i}', 'd': f'2026-10-{15 + i}', 't': '14:00', 'pdf': [f'{4200 + i}202610{15 + i}M001.pdf']} for i in range(2)]
    tbl = {r['pdf'][0]: deck([['公司', 'Outlook', 'Expect AI server growth next year'], ['Revenue 100 million, up 8%']]) for r in rows}
    cd, data, cc = setup(tmp, rows, CC_AI_MAX=1)
    cd.groq_summarize = lambda *a, **k: (dict(ANS_OK), 'qwen/qwen3.8-27b', 0)
    cd.ai_fill = lambda *a, **k: (0, 0, set(), 0)          # ⭐ 決定性對照:拿掉補摘要(= V79.6.4 以前)
    for _ in range(3):
        cd.run(fetcher=FakeFetcher(tbl), groq_keys=['k1'], today=date(2026, 10, 23), log=lambda x: None)
    a0 = json.loads((data / 'cc' / '4200.json').read_text(encoding='utf-8'))['decks'][0]
    ok('㊹e ⭐ 決定性對照:拿掉補摘要 → 讀的時候沒拿到摘要的那份,跑幾輪都一樣沒有', not a0.get('ai'), a0)

# ㊹f~㊹k 直接測 ai_fill(範圍 / 順序 / 不能用 vs 沒回 / 連 3 份沒回就停 / 自己的時限)
cdf = importlib.reload(sys.modules['confcall_deck'])        # ⚠️ ㊹e 把 ai_fill 換成空殼 → 先換回真的
_T = date(2026, 10, 23)
_rec = lambda s, d, **kw: {'s': s, 'name': s, 'd': d, 'f': f'{s}x.pdf', 'st': 'ok', 'outlook': [[1, '預期明年成長']], 'nums': [], 'titles': [], **kw}
_all = {'2026-10': [_rec('A', '2026-10-20'), _rec('B', '2026-10-01'), _rec('C', '2026-10-10', ai={'one': 'x'})],
        '2026-08': [_rec('D', '2026-08-01')],                         # 超過 60 天(cut = 08-24)→ ⛔ 不補
        '2026-09': [_rec('E', '2026-09-05', st='no_text'), _rec('F', '2026-09-30', outlook=[], nums=[], titles=[])]}
seen = []
cdf.groq_summarize = lambda name, s, d, feat, keys, **kw: (seen.append(s) or (dict(ANS_OK), 'm', 0))
n_ok_, n_call_, tm_, left_ = cdf.ai_fill(_all, _T, ['k'], 1, log=lambda x: None)
ok('㊹f 只補最近 60 天、狀態 ok、有重點句、還沒有摘要的;新 → 舊(預算 1 → 只補 A)',
   seen == ['A'] and n_ok_ == 1 and n_call_ == 1 and tm_ == {'2026-10'} and left_ == 1 and _all['2026-10'][0].get('ai'), (seen, n_ok_, left_))
seen.clear()
cdf.ai_fill(_all, _T, ['k'], 99, log=lambda x: None)
ok('㊹g 預算夠 → 補 B;⛔ D(超過 60 天)/ E(只有圖片)/ F(沒有句子)/ C(已有)', seen == ['B'], seen)
_bad = {'2026-10': [_rec('G', '2026-10-20')]}
cdf.groq_summarize = lambda *a, **k: (None, 'm', 0)          # 模型有回、但回的不能用
for _ in range(cdf.AI_TRIES + 2):
    cdf.ai_fill(_bad, _T, ['k'], 99, log=lambda x: None)
calls_bad = []
cdf.groq_summarize = lambda *a, **k: (calls_bad.append(1) or (None, 'm', 0))
cdf.ai_fill(_bad, _T, ['k'], 99, log=lambda x: None)
ok('㊹h 模型有回、但回的不能用 → ai_n 記到 AI_TRIES 次就不再補(⛔ 每一輪都叫同一份)',
   _bad['2026-10'][0].get('ai_n') == cdf.AI_TRIES and calls_bad == [], _bad)
_quota = {'2026-10': [_rec('H', '2026-10-20')]}
for _ in range(cdf.AI_TRIES + 2):
    cdf.groq_summarize = lambda *a, **k: (None, None, 0)     # 沒回(額度用完 / 連不上)
    cdf.ai_fill(_quota, _T, ['k'], 99, log=lambda x: None)
ok('㊹i 沒回(額度 / 連線)⛔ 不算這份的錯 → 不記 ai_n,下一輪還會補', not _quota['2026-10'][0].get('ai_n'), _quota)
_many = {'2026-10': [_rec(f'M{i}', f'2026-10-{10 + i}') for i in range(8)]}
cnt = []
cdf.groq_summarize = lambda *a, **k: (cnt.append(1) or (None, None, 0))
cdf.ai_fill(_many, _T, ['k'], 99, log=lambda x: None)
ok('㊹j 連 AI_FAIL_STOP 份沒回 → 這一段就停(⛔ 每份都等)', len(cnt) == cdf.AI_FAIL_STOP, cnt)
clk = {'t': 0.0}
cnt.clear()
def slow_sum(*a, **k):
    cnt.append(1); clk['t'] += 70.0
    return dict(ANS_OK), 'm', 0
cdf.groq_summarize = slow_sum
_slow = {'2026-10': [_rec(f'S{i}', f'2026-10-{10 + i}') for i in range(8)]}
cdf.ai_fill(_slow, _T, ['k'], 99, log=lambda x: None, clock=lambda: clk['t'])
ok('㊹k 補摘要那段自己有時限(AI_FILL_SEC):一份 70 秒 → 最多叫到超過時限的那一份就停',
   len(cnt) == int(cdf.AI_FILL_SEC // 70) + 1, (len(cnt), cdf.AI_FILL_SEC))
ok('㊹l 沒有金鑰 / 預算 0 → 一次都不叫', cdf.ai_fill(_slow, _T, [], 99) == (0, 0, set(), 0) and cdf.ai_fill(_slow, _T, ['k'], 0) == (0, 0, set(), 0))


# ㊺ 🚦 接力:已經有一輪在排隊(手動派的回補 / 每天那一輪)→ ⛔ 不再派(同一組只留一個排隊的,再派會把它擠掉)
#    ⭐ 實跑 yaml 裡那段 bash 原文(⛔ 測試裡不抄一份邏輯),gh 換成假的:api 回排隊幾輪、workflow run 記下來
import subprocess
_rl = _wf[_wf.index('🔁 接力(回補還沒讀完)'):]
_rl = _rl[_rl.index('run: |') + len('run: |'):].split('\n')
_relay = '\n'.join(ln[10:] for ln in _rl if ln.startswith(' ' * 10) or not ln.strip())


def _relay_run(chain, pending, queued, api_fail=False, wr_queued=0):
    """pending / queued = 手動派 / 接力那種(workflow_dispatch)在排隊幾輪;
    wr_queued = 跟在 playbook_scan 後面那種(workflow_run)在排隊幾輪 —— 查詢沒帶 event=workflow_dispatch 才會被算進去"""
    with tempfile.TemporaryDirectory() as td:
        log = Path(td) / 'calls'
        gh = Path(td) / 'gh'
        gh.write_text('#!/bin/bash\n'
                      f'echo "$*" >> "{log}"\n'
                      'if [ "$1" = api ]; then\n'
                      + ('  exit 1\n' if api_fail else
                         f'  case "$2" in *event=workflow_dispatch*) W=0;; *) W={wr_queued};; esac\n'
                         f'  case "$2" in *status=pending*) echo $(({pending} + W));; *status=queued*) echo $(({queued} + W));; *) echo 0;; esac\n')
                      + 'fi\n', encoding='utf-8')
        gh.chmod(0o755)
        env = dict(os.environ, PATH=f'{td}:{os.environ.get("PATH", "")}', CHAIN=str(chain), LEFT='9', GH_REPO='o/r', GH_TOKEN='x')
        r = subprocess.run(['bash', '-e', '-c', _relay], capture_output=True, text=True, env=env, timeout=30)
        calls = log.read_text(encoding='utf-8').splitlines() if log.exists() else []
        return r.returncode, r.stdout, [c for c in calls if c.startswith('workflow run')]


_a = _relay_run(4, 0, 0)
ok('㊺ ⭐ 決定性對照:沒有排隊的 → 派下一棒(chain 5)', _a[0] == 0 and _a[2] == ['workflow run confcall_deck.yml --ref main -f chain=5 -f max_files=99999'], _a)
_b = _relay_run(4, 1, 0)
ok('㊺b 有一輪在等(pending)→ ⛔ 不派、說出來', _b[0] == 0 and _b[2] == [] and '排隊' in _b[1], _b)
_c = _relay_run(4, 0, 2)
ok('㊺c 有在排隊(queued)→ ⛔ 不派', _c[0] == 0 and _c[2] == [], _c)
_d = _relay_run(4, 0, 0, api_fail=True)
ok('㊺d 查不到排隊狀況(API 失敗)→ 照舊派(⛔ 接力斷掉)', _d[0] == 0 and len(_d[2]) == 1, _d)
_e = _relay_run(60, 0, 0)
ok('㊺e 已經接力 60 棒 → 停(防無限迴圈)', _e[0] == 0 and _e[2] == [] and '60 棒' in _e[1], _e)
# ㊺f 🔗 V79.6.6 10/24 接力斷掉那次:排隊的是跟在 playbook_scan 後面那種(上游不是成功 → 整輪跳過)
#    ⭐ 決定性對照:舊寫法(查詢不分哪一種)同一個情境一定不派
_f = _relay_run(4, 0, 0, wr_queued=1)
ok('㊺f 排隊的只有 workflow_run 那種(可能整輪跳過)→ 照樣派下一棒(⛔ 接力斷掉)',
   _f[0] == 0 and _f[2] == ['workflow run confcall_deck.yml --ref main -f chain=5 -f max_files=99999'], _f)
_relay_old = _relay
_relay = _relay.replace('&event=workflow_dispatch', '')
_f2 = _relay_run(4, 0, 0, wr_queued=1)
_relay = _relay_old
ok('㊺f2 ⭐ 決定性對照:查詢拿掉 event=workflow_dispatch(= 10/24 那版)→ 同一個情境不派 = 接力斷掉', _f2[2] == [], _f2)
_g = _relay_run(4, 1, 0, wr_queued=1)
ok('㊺g 手動派的回補在等 + workflow_run 也在等 → 照舊不派(⛔ 擠掉手動派的)', _g[2] == [], _g)


# ㊻ 🧭 V79.6.6 摘要的「風險」只收對公司不利的 —— 南亞 10/23 那份把「中東產能受損、乙二醇到港量受影響」
#    (對手的事,對南亞是報價有撐)列成風險。⛔ 不釘整句,只釘用意:風險那格的定義要把「對公司有利的外部事件」排除,
#    而且要舉出真的算風險的例子(不然模型會連原料缺貨也一起丟掉)
_sm, _um, _ = cdf.ai_prompt('南亞', '1303', '2026-10-23', [], [(7, '化工產品乙二醇也因中東產能受損尚未修復')], [])
_rk = _um[_um.index('"risk":[{"t":"') + len('"risk":[{"t":"'):]
_rk = _rk[:_rk.index('","p"')]
ok('㊻ 風險的定義:對公司不利 / 會變差才算,⛔ 對手停產、報價上漲不算',
   '不利' in _rk and '不算' in _rk and '對手停產' in _rk and '報價上漲' in _rk, _rk)
ok('㊻b 也要寫出真的算風險的例子(原料、成本)—— 只寫排除的話,公司自己缺料也會被丟掉', '原料' in _rk and '成本' in _rk, _rk)
ok('㊻c 其他三格的格式沒動(one / outlook / new 照舊,JSON 骨架完整)',
   all(k in _um for k in ('"one":', '"outlook":[{"t":', '"new":[{"t":', '"risk":[{"t":')) and _um.count('"p":頁碼') == 3, _um)


# ㊼ 📝 V79.6.7 法說會 3.0 第一步:每份簡報的全文存起來(研究「講了什麼 → 做到了沒」要從全文抽)
#    ① 新讀的:全文進 cc/text/{場次月份}.json.gz、頁碼對得上、索引記 tx
#    ② 已讀過、當時沒存的:排進待讀(最近 60 天的排在回補之前、其他排最後)、只下載 + 抽字
#       ⛔ 重算特徵、⛔ 重叫 AI、⛔ 把「已讀」改掉;下載失敗只記補存試了幾天
with tempfile.TemporaryDirectory() as tmp:
    rows = [{'s': '4444', 'name': '測試己', 'd': '2026-10-20', 't': '14:00', 'pdf': ['444420261020M001.pdf']},
            {'s': '5555', 'name': '測試庚', 'd': '2026-10-21', 't': '14:00', 'pdf': ['555520261021M001.pdf']}]
    cd, data, cc = setup(tmp, rows)
    D_NEW = deck([['Results', 'Revenue 300 million'], ['Outlook', 'Q4 revenue will keep rising, better than Q3']])
    D_OLD = deck([['Results', 'Revenue 200 million'], ['Outlook', 'Second half demand stays strong']])
    # 5555 這份「以前就讀過」(舊版:index 只有 ok、沒有 tx;特徵檔裡有 AI 摘要)
    old_rec = {'s': '5555', 'd': '2026-10-21', 'f': '555520261021M001.pdf', 'name': '測試庚', 'kind': 'pdf', 'st': 'ok', 'pages': 3,
               'chars': 300, 'titles': [], 'outlook': [[2, 'Second half demand stays strong']], 'nums': [], 'terms': {}, 'tone': [1, 0],
               'ai': {'one': '下半年需求強', 'outlook': [], 'new': [], 'risk': []}, 'model': 'qwen/qwen3.8-27b', 'gate_drop': 0}
    (cc / 'cc' / 'feat').mkdir(parents=True, exist_ok=True)
    cd._save_json(cc / 'cc' / 'feat' / '2026-10.json.gz', [old_rec])
    cd._save_json(cc / 'cc' / 'index.json', {'v': 2, 'files': {'555520261021M001.pdf': {'st': 'ok', 's': '5555', 'd': '2026-10-21', 'tries': 1, 'pages': 3}}})
    ai_syms = []
    cd.groq_summarize = lambda name, sym, *a, **k: (ai_syms.append(sym), (None, None, 0))[1]
    ffx = FakeFetcher({'444420261020M001.pdf': D_NEW, '555520261021M001.pdf': D_OLD})
    lg = []
    rcx = cd.run(fetcher=ffx, groq_keys=['k1'], today=date(2026, 10, 23), log=lg.append)
    idx = cd.load_index()['files']
    tx = cd._load_json(cd.text_file('2026-10'), {})
    ok('㊼a 新讀的那份:全文存進 cc/text/2026-10.json.gz、索引 tx = 2026-10',
       rcx == 0 and idx['444420261020M001.pdf'].get('tx') == '2026-10' and '444420261020M001.pdf' in tx, (rcx, idx, list(tx)))
    pg = (cd.load_text('444420261020M001.pdf', idx) or {}).get('p') or []
    ok('㊼b 頁碼對得上:第 2 頁就是第 2 個(Outlook 那頁)、總字數記著', len(pg) == 3 and 'better than Q3' in pg[1] and 'Revenue 300' in pg[0]
       and tx['444420261020M001.pdf']['n'] == sum(len(x) for x in pg), pg)
    ok('㊼c 已讀過、沒全文的那份 → 有下載(補存)、全文存了、tx 記上', '555520261021M001.pdf' in ffx.calls
       and idx['555520261021M001.pdf'].get('tx') == '2026-10' and 'demand stays strong' in ''.join(tx['555520261021M001.pdf']['p']), (ffx.calls, idx['555520261021M001.pdf']))
    recs = cd._load_json(cc / 'cc' / 'feat' / '2026-10.json.gz', [])
    r55 = [r for r in recs if r['f'] == '555520261021M001.pdf']
    ok('㊼d ⭐ 補存 ⛔ 重算特徵、⛔ 動 AI 摘要(還是原本那一份)、「已讀」照舊', len(r55) == 1 and r55[0].get('ai', {}).get('one') == '下半年需求強'
       and r55[0].get('chars') == 300 and idx['555520261021M001.pdf']['st'] == 'ok', r55)
    ok('㊼e 補存 ⛔ 叫 AI(只有新讀的 4444 叫過;5555 一次都沒有)', '4444' in ai_syms and '5555' not in ai_syms, ai_syms)
    ok('㊼f log 寫出存了幾份、補存幾份', any('存全文 2 份(其中補存已讀過的 1 份)' in x for x in lg), [x for x in lg if '全文' in x])
    # ㊼g 第二輪:都有全文了 → ⛔ 再下載
    ffy = FakeFetcher({'444420261020M001.pdf': D_NEW, '555520261021M001.pdf': D_OLD})
    cd.run(fetcher=ffy, groq_keys=[], today=date(2026, 10, 24), log=[].append)
    ok('㊼g 第二輪:兩份都有全文了 → 一份都 ⛔ 再下載', ffy.calls == [], ffy.calls)
    # ㊼h 月檔是「加進去」不是「整份重寫」:同月再讀一份新的 → 舊的兩份全文還在
    rows2 = rows + [{'s': '6666', 'name': '測試辛', 'd': '2026-10-22', 't': '14:00', 'pdf': ['666620261022M001.pdf']}]
    cd, data, cc = setup(tmp, rows2)
    cd.run(fetcher=FakeFetcher({'666620261022M001.pdf': D_NEW}), groq_keys=[], today=date(2026, 10, 24), log=[].append)
    tx2 = cd._load_json(cd.text_file('2026-10'), {})
    ok('㊼h 同一個月檔再加一份 → 舊的兩份全文還在(⛔ 整份重寫成只剩這一輪的)', set(tx2) == {'444420261020M001.pdf', '555520261021M001.pdf', '666620261022M001.pdf'}, list(tx2))

# ㊼i 補存下載失敗:⛔ 把「已讀」改掉;同一天 ⛔ 再試;隔天再試;滿 TEXT_TRIES 天放棄
with tempfile.TemporaryDirectory() as tmp:
    rows = [{'s': '5555', 'name': '測試庚', 'd': '2026-10-21', 't': '14:00', 'pdf': ['555520261021M001.pdf']}]
    cd, data, cc = setup(tmp, rows)
    (cc / 'cc' / 'feat').mkdir(parents=True, exist_ok=True)
    cd._save_json(cc / 'cc' / 'index.json', {'v': 2, 'files': {'555520261021M001.pdf': {'st': 'ok', 's': '5555', 'd': '2026-10-21', 'tries': 1, 'pages': 3}}})
    cd._save_json(cc / 'cc' / 'feat' / '2026-10.json.gz', [dict(old_rec)])
    seen = []
    for day in (23, 23, 24, 25, 26):
        f_ = FakeFetcher({})                         # 下載一律失敗(ConnectionError)
        cd.run(fetcher=f_, groq_keys=[], today=date(2026, 10, day), log=[].append)
        seen.append(len(f_.calls))
    st = cd.load_index()['files']['555520261021M001.pdf']
    ok('㊼i 補存失敗 → 「已讀」照舊(st=ok)、記 txtries;同一天 ⛔ 再試、隔天再試、滿 3 天放棄',
       st['st'] == 'ok' and st.get('txtries') == 3 and seen == [1, 0, 1, 1, 0], (st, seen))
    r55 = [r for r in cd._load_json(cc / 'cc' / 'feat' / '2026-10.json.gz', []) if r['f'] == '555520261021M001.pdf']
    ok('㊼i2 特徵與 AI 摘要都還在(⛔ 被當成沒讀過重讀)', r55 and r55[0].get('ai', {}).get('one') == '下半年需求強', r55)

# ㊼j 讀的順序:最近 60 天沒讀的 → 最近 60 天補存 → 這些公司前幾份 → 其他回補 → 其他補存
_rr = [{'s': '1111', 'd': '2026-10-20', 'pdf': ['111120261020M001.pdf']}, {'s': '2222', 'd': '2026-10-19', 'pdf': ['222220261019M001.pdf']}]
_bk = [{'s': '1111', 'd': '2026-07-20', 'pdf': ['111120260720M001.pdf']}, {'s': '3333', 'd': '2026-06-10', 'pdf': ['333320260610M001.pdf']},
       {'s': '4444', 'd': '2026-05-10', 'pdf': ['444420260510M001.pdf']}]
_fs = {'222220261019M001.pdf': {'st': 'ok'}, '444420260510M001.pdf': {'st': 'ok'}, '333320260610M001.pdf': {'st': 'ok', 'tx': '2026-06'}}
_todo, _ = cd.plan_todo(_rr, _bk, _fs, date(2026, 10, 23))
_ord = [(f[:4], w) for _, f, w in _todo]
ok('㊼j 順序:最近沒讀的 1111 → 最近補存 2222 → 1111 上一份 → (3333 已有全文 ⛔ 排)→ 最後補存 4444',
   _ord == [('1111', ''), ('2222', 'text'), ('1111', ''), ('4444', 'text')], _ord)
# ㊼k ⭐ 決定性對照:拿掉補存那一關 → 已讀過的永遠沒有全文(⛔ 會被排進來)
_orig = cd._need_text
cd._need_text = lambda *a, **k: False
_todo2, _ = cd.plan_todo(_rr, _bk, _fs, date(2026, 10, 23))
cd._need_text = _orig
ok('㊼k 決定性對照:拿掉補存那一關 → 已讀過的 2222 / 4444 一份都不會排進來', [f[:4] for _, f, _w in _todo2] == ['1111', '1111'], _todo2)
# ㊼l text_pack:頁碼照順序、空白頁保留(⛔ 拿掉 = 引用頁碼對不上)、超過上限後面的頁存空字串 + cut
_tp = cd.text_pack(['a' * 10, '', 'b' * 10])
_old_max = cd.TEXT_MAX
cd.TEXT_MAX = 15
_tp2 = cd.text_pack(['a' * 10, 'b' * 10, 'c' * 10])
cd.TEXT_MAX = _old_max
ok('㊼l 空白頁保留、超過上限截斷並標 cut、總字數記原本的', _tp['p'] == ['a' * 10, '', 'b' * 10] and 'cut' not in _tp
   and _tp2['p'] == ['a' * 10, 'b' * 5, ''] and _tp2['cut'] == 1 and _tp2['n'] == 30, (_tp, _tp2))


# ㊽ 總經背景排後面:「利率」⛔ 吃到「毛利率 / 淨利率 / 營利率」(10/24 實跑:講毛利率的那句被扣 3 分排到最後)
ok('㊽a 「毛利率 / 淨利率 / 營利率」⛔ 算總經', not any(cd.MACRO_RE.search(x) for x in ['毛利率維持 30% 以上', '淨利率可望提升', '營利率將回升']))
ok('㊽b ⭐ 決定性對照:「聯準會降息、利率走低」照樣算總經', bool(cd.MACRO_RE.search('預期聯準會降息,利率走低')) and bool(cd.MACRO_RE.search('利率將維持高檔')))
_bo2 = cd.best_outlook([[3, '預期明年持續成長'], [5, '預期第四季毛利率將回升至 25%']])
ok('㊽c 講毛利率又有數字的那句排第一(⛔ 被當成總經排到最後)', _bo2 == [5, '預期第四季毛利率將回升至 25%'], _bo2)

# ㊾ 部首字(10/24 量 150 份有 27 份):「成⾧」⛔ 對到「成長」→ 抽字時換回一般字;舊特徵 refilter 也換(冪等)
ok('㊾a _clean:「營收成⾧」「⻑期」→ 一般字;全形標點 ⛔ 跟著換', cd._clean('營收成⾧，⻑期：⾼階') == '營收成長，長期：高階')
_rf = cd.refilter({'st': 'ok', 'outlook': [[3, '預期明年營收成⾧ 15%']], 'nums': [[4, '毛利率⾼於 30%']], 'titles': [[1, '營運⻑期展望']], 'terms': {}})
ok('㊾b refilter 把舊特徵的部首字換掉,語氣跟著算得到「成長」',
   _rf['outlook'] == [[3, '預期明年營收成長 15%']] and _rf['nums'] == [[4, '毛利率高於 30%']] and _rf['titles'] == [[1, '營運長期展望']]
   and _rf['tone'][0] >= 1, _rf)
ok('㊾c ⭐ 決定性對照:沒換之前「成⾧」對不到 POS_RE', not cd.POS_RE.search('預期明年營收成⾧') and cd.POS_RE.search(cd.norm_radicals('預期明年營收成⾧')))

# ㊿ 📋 法說會 3.0:data/cc/{sym}.json 每份簡報多一個 g =「公司講的展望 → 做到了沒」(confcall_guidance)
with tempfile.TemporaryDirectory() as tmp:
    cdx, datax, ccx = setup(tmp, [])
    rec = {'s': '1303', 'name': '南亞', 'd': '2026-10-23', 'f': '130320261022M001.pdf', 'st': 'ok', 'pages': 3,
           'outlook': [[3, '年初預期，今年會是亮麗的一年。']], 'nums': [], 'terms': {}, 'tone': [0, 0]}
    cdx._save_json(cdx.month_file('2026-10-01'), [rec])
    files = {rec['f']: {'st': 'ok', 'd': '2026-10-23', 's': '1303', 'tx': '2026-10'}}
    cdx._save_json(cdx.text_file('2026-10'), {rec['f']: cdx.text_pack(['', '第四季合併營收將持續攀升,整體績效將優於第三季。', '年初預期，今年會是亮麗的一年。'])})
    (datax / 'fin').mkdir()
    (datax / 'fin' / '1303.json').write_text(json.dumps({'sym': '1303', 'q': [
        {'p': '2026-06-30', 'pub': '2026-08-14', 'rev': 83646883000}, {'p': '2026-09-30', 'pub': '2026-11-14', 'rev': 95597000000}]}), encoding='utf-8')
    mrh = [[f'2026-{m:02d}', v] for m, v in zip(range(7, 13), (30573, 30601, 34423, 33000, 34000, 35000))]
    (datax / 'fund_yoy_gm.json').write_text(json.dumps({'1303': {'mrh': mrh}}), encoding='utf-8')
    allx = cdx.load_all()
    _logs = []
    cdx.build_outputs([x for l in allx.values() for x in l], cdx.novelty_all([rec]), {}, date(2027, 1, 12), files=files, cite={rec['f']}, log=_logs.append)
    cc1303 = json.loads((datax / 'cc' / '1303.json').read_text(encoding='utf-8'))
    g = cc1303['decks'][0].get('g') or []
    dg = json.loads((datax / 'confcall_digest.json').read_text(encoding='utf-8'))
    ok('㊿a 從全文抽到第 2 頁那句(舊規則漏掉的)→ 營收・往上・2026Q4;月營收 10~12 月 1,020 億 vs 7~9 月 955.97 億 → ✅ 做到了,1/10 公布',
       g and g[0]['p'] == 2 and g[0]['m'] == 'rev' and g[0]['r']['res'] == 'hit' and g[0]['r']['src'] == 'm' and g[0]['r']['a'] == 1020.0
       and g[0]['r']['b'] == 955.97 and g[0]['r']['known'] == '2027-01-10', g)
    ok('㊿b 清單那一列帶「可以對答案的展望」幾句(gn)', dg['rows'][0].get('gn') == 1, dg['rows'][0])
    ok('㊿c 紀錄印出幾份 / 幾句 / 讀到幾檔季報與月營收', any('📋 展望' in str(x) and '季報 1 檔' in str(x) and '月營收 1 檔' in str(x) for x in _logs), _logs)
    # ⭐ 決定性對照:同一份簡報、10~12 月營收合計 900 億 → ❌ 沒做到
    (datax / 'fund_yoy_gm.json').write_text(json.dumps({'1303': {'mrh': mrh[:3] + [['2026-10', 28000], ['2026-11', 30000], ['2026-12', 32000]]}}), encoding='utf-8')
    cdx.build_outputs([x for l in allx.values() for x in l], cdx.novelty_all([rec]), {}, date(2027, 1, 12), files=files, log=_logs.append)
    g2 = json.loads((datax / 'cc' / '1303.json').read_text(encoding='utf-8'))['decks'][0].get('g') or []
    ok('㊿d ⭐ 決定性對照:10~12 月合計 900 億 → ❌ 沒做到', g2 and g2[0]['r']['res'] == 'miss', g2)
    # 讀不到季報 / 月營收 / 全文 → 照樣列(舊的「講到之後」句子),對答案那格 ⛔ 編
    (datax / 'fund_yoy_gm.json').unlink()
    (datax / 'fin' / '1303.json').unlink()
    cdx.build_outputs([x for l in allx.values() for x in l], cdx.novelty_all([rec]), {}, date(2026, 10, 24), files={}, log=_logs.append)
    cc3 = json.loads((datax / 'cc' / '1303.json').read_text(encoding='utf-8'))
    ok('㊿e 讀不到季報 / 月營收 / 全文 → 不出錯;「今年會是亮麗的一年」沒有指標 ⛔ 硬列', 'g' not in cc3['decks'][0], cc3['decks'][0].get('g'))
    rec2 = dict(rec, outlook=[[12, '第四季合併營收將持續攀升,整體績效將優於第三季。']])
    cdx.build_outputs([rec2], cdx.novelty_all([rec2]), {}, date(2026, 10, 24), files={}, log=_logs.append)
    g4 = json.loads((datax / 'cc' / '1303.json').read_text(encoding='utf-8'))['decks'][0].get('g') or []
    ok('㊿f 沒有全文 → 用以前存的句子;季報月營收都還沒有 → ⏳ 還沒到期(⛔ 編答案)', g4 and g4[0]['p'] == 12 and g4[0]['r']['res'] == 'pending', g4)
    # ㊿g 全文照月份分組:同一個月兩份簡報 → 那個月的全文檔只解壓一次(⛔ 每份各讀一次 / ⛔ 全部月份同時留在記憶體)
    rec3 = dict(rec, s='1304', f='130420261020M001.pdf', d='2026-10-20')
    files2 = dict(files, **{rec3['f']: {'st': 'ok', 'd': '2026-10-20', 's': '1304', 'tx': '2026-10'}})
    cdx._save_json(cdx.text_file('2026-10'), {rec['f']: cdx.text_pack(['第四季合併營收將持續攀升']), rec3['f']: cdx.text_pack(['第四季營收將較上季成長'])})
    _orig_lj, _hits = cdx._load_json, []
    cdx._load_json = lambda p, d=None: (_hits.append(str(p)) if 'text' in str(p) else None) or _orig_lj(p, d)
    cdx.build_outputs([rec, rec3], cdx.novelty_all([rec, rec3]), {}, date(2026, 10, 24), files=files2, log=_logs.append)
    cdx._load_json = _orig_lj
    _g13 = [json.loads((datax / 'cc' / f'{x}.json').read_text(encoding='utf-8'))['decks'][0].get('g') for x in ('1303', '1304')]
    ok('㊿g 同一個月兩份簡報 → 那個月的全文只解壓一次,兩份都抽得到', len([h for h in _hits if '2026-10' in h]) == 1 and all(_g13), (_hits, _g13))
    # ㊿h 🧩 V79.7.0 畫面上那三樣(標題 / 講到之後 / 公司給的數字)有全文就照現在的規則重抽
    #     (10/24 南亞那份是在「PDF 斷行接回整句」之前讀的 → 存著的「公司給的數字」被切成兩半)
    half = [[1, '帶動電子材料產品營業利益季增96.1%，淨利率達30.9%。轉投資也因記憶體價格持續'],
            [1, '上漲，南亞科挹注顯著投資收益，推升2026年第3季EPS達4.90元，改寫單季歷史新高。']]
    rec5 = dict(rec, s='1305', f='130520261022M001.pdf', d='2026-10-22', nums=half)
    page5 = ('因應產業需求,適時調漲售價,\n帶動電子材料產品營業利益季增96.1%，淨利率達30.9%。轉投資也因記憶體價格持續\n'
             '上漲，南亞科挹注顯著投資收益，推升2026年第3季EPS達4.90元，改寫單季歷史新高。\n')
    files5 = {rec5['f']: {'st': 'ok', 'd': '2026-10-22', 's': '1305', 'tx': '2026-10'}}
    cdx._save_json(cdx.text_file('2026-10'), {rec5['f']: cdx.text_pack([page5])})
    cdx.build_outputs([rec5], cdx.novelty_all([rec5]), {}, date(2026, 10, 24), files=files5, log=_logs.append)
    n5 = json.loads((datax / 'cc' / '1305.json').read_text(encoding='utf-8'))['decks'][0].get('nums') or []
    dg5 = [x for x in json.loads((datax / 'confcall_digest.json').read_text(encoding='utf-8'))['rows'] if x.get('f') == rec5['f']]
    ok('㊿h 有全文 → 公司給的數字照現在的規則重抽(斷行接回整句:「轉投資也因記憶體價格持續上漲,…」是同一句)',
       any(t.startswith('轉投資也因記憶體價格持續上漲') for _, t in n5) and not any(t.endswith('持續') for _, t in n5)
       and dg5 and dg5[0].get('n_nums') == len(n5), (n5, dg5))
    cdx.build_outputs([rec5], cdx.novelty_all([rec5]), {}, date(2026, 10, 24), files={}, log=_logs.append)
    n6 = json.loads((datax / 'cc' / '1305.json').read_text(encoding='utf-8'))['decks'][0].get('nums') or []
    ok('㊿h ⭐ 決定性對照:沒有全文 → 照舊用存著的那兩半句(⛔ 編、⛔ 弄丟)', n6 == half, n6)
    ok('㊿h 存著的那份(研究用的特徵)⛔ 被改:重抽只寫進給 App 的 data/cc', rec5['nums'] == half, rec5['nums'])


# 🛰️ V79.7.7 主題雷達 + 詞庫比對規則(使用者 10/25:「更厲害可以看到裡面重點或別人看不到的重點」)
#   ① 「AI伺服器」沒空白也要對得到(舊規則只認一個空白:2026-08 有全文的 417 份,14 份對得到、26 份漏掉)
#   ② 舊簡報有全文的 → 照新規則重抽「講到的詞」(冪等、⛔ 動其他欄位、時間用完下一輪接著做)
#   ③ 補存全文那條路順便重抽
#   ④ build_radar:每一季幾家在講 / 幾家第一次提到(第一次收錄 ⛔ 算、以前講過 ⛔ 算、別名併在一起、同一天 ⛔ 互相算更早、
#      以前是舊規則抽的 ⛔ 算第一次 —— 決定性對照:同一家以前是新規則 → 算)
#   ⑤ run() 寫出 data/cc_radar.json(⛔ 沒有一季夠多家就不寫)・⑥ 第一次提到的詞:詞庫題材排前面 ・⑦ workflow 一起推
with tempfile.TemporaryDirectory() as tmp:
    cd, data, cc = setup(tmp, [])
    rx = dict(cd._THEME_RES)
    ok('🛰️① 「AI伺服器」沒空白 / 一個 / 兩個空白都對得到', all(rx['AI 伺服器'].search(t) for t in ['AI伺服器出貨', 'AI 伺服器', 'AI  伺服器', 'ai伺服器']))
    ok('🛰️①b ⭐ 決定性對照:舊寫法(只 re.escape)對不到「AI伺服器」', not re.compile(re.escape('AI 伺服器'), re.I).search('AI伺服器出貨'))
    ok('🛰️①c 英文那一側 ⛔ 接著別的英文字母(「GAI伺服器」⛔ 算)', not rx['AI 伺服器'].search('GAI伺服器'))
    ok('🛰️①d Wi-Fi 的連字號 / 空白可有可無;Micro LED 也一樣', bool(rx['Wi-Fi 7'].search('WiFi7 晶片') and rx['Wi-Fi 7'].search('Wi-Fi 7')
       and rx['Micro LED'].search('MicroLED') and rx['Micro LED'].search('Micro LED')))
    ok('🛰️①e 全英數的詞兩側照舊不接英文字母(5G ⛔ 對到 B5G、AI ⛔ 對到 RAID)', bool(rx['5G'].search('5G 手機')) and not rx['5G'].search('B5G')
       and bool(rx['AI'].search('AI 需求')) and not rx['AI'].search('RAID'))
    ok('🛰️①f 新讀的簡報特徵標 tv = TERMS_VER', cd.feat_of(['AI伺服器'], {}).get('tv') == cd.TERMS_VER and 'AI 伺服器' in cd.feat_of(['AI伺服器'], {})['terms'])

    # ② reterm_all
    r_old = {'s': '1111', 'd': '2026-08-10', 'f': '111120260810M001.pdf', 'st': 'ok', 'terms': {'伺服器': 2}, 'chars': 999, 'ai': {'one': 'x'}}
    r_notx = {'s': '2222', 'd': '2026-08-11', 'f': '222220260811M001.pdf', 'st': 'ok', 'terms': {'伺服器': 1}}
    r_new = {'s': '3333', 'd': '2026-08-12', 'f': '333320260812M001.pdf', 'st': 'ok', 'terms': {'CPO': 1}, 'tv': cd.TERMS_VER}
    r_gone = {'s': '4444', 'd': '2026-08-13', 'f': '444420260813M001.pdf', 'st': 'ok', 'terms': {'HBM': 3}}
    allr = {'2026-08': [r_old, r_notx, r_new, r_gone]}
    files = {r_old['f']: {'st': 'ok', 'tx': '2026-08'}, r_notx['f']: {'st': 'ok'}, r_new['f']: {'st': 'ok', 'tx': '2026-08'}, r_gone['f']: {'st': 'ok', 'tx': '2026-08'}}
    cd._save_json(cd.text_file('2026-08'), {r_old['f']: {'p': ['封面', 'AI伺服器出貨成長', '謝謝'], 'n': 20}, r_new['f']: {'p': ['x'], 'n': 1}})
    lg2 = []
    n_rt, tm_rt = cd.reterm_all(allr, files, log=lg2.append)
    ok('🛰️② 有全文的舊簡報:詞照新規則重抽(對到「AI伺服器」)、標 tv、其他欄位一個字都不動',
       n_rt == 1 and r_old['terms'].get('AI 伺服器') == 2 and r_old.get('tv') == cd.TERMS_VER and r_old['chars'] == 999 and r_old['ai'] == {'one': 'x'} and tm_rt == {'2026-08'},
       (n_rt, r_old, tm_rt))
    ok('🛰️②b 沒有全文的:留著舊的詞、⛔ 標做過(之後補存了全文再做)', r_notx['terms'] == {'伺服器': 1} and 'tv' not in r_notx, r_notx)
    ok('🛰️②c 已經是新規則的 ⛔ 再做;索引說有全文、全文檔裡卻沒有 → 留舊的詞、標做過(⛔ 每輪重新解壓)',
       r_new['terms'] == {'CPO': 1} and r_gone['terms'] == {'HBM': 3} and r_gone.get('tv') == cd.TERMS_VER and any('全文檔裡找不到 1 份' in x for x in lg2), (r_new, r_gone, lg2))
    n_rt2, tm_rt2 = cd.reterm_all(allr, files, log=lg2.append)
    ok('🛰️②d 冪等:第二次跑一份都 ⛔ 再做', n_rt2 == 0 and not tm_rt2, (n_rt2, tm_rt2))
    r_b = {'s': '5555', 'd': '2026-08-14', 'f': '555520260814M001.pdf', 'st': 'ok', 'terms': {}}
    lg3 = []
    n_rt3, _ = cd.reterm_all({'2026-08': [r_b]}, {r_b['f']: {'st': 'ok', 'tx': '2026-08'}}, log=lg3.append, budget=-1)
    ok('🛰️②e 時間用完 → 這一輪不做、寫「還有 N 份下一輪接著做」', n_rt3 == 0 and 'tv' not in r_b and any('還有 1 份下一輪接著做' in x for x in lg3), lg3)

    # ④ build_radar
    cd.RADAR_MIN_CO = 2
    TV = cd.TERMS_VER
    def R_(s_, d_, terms, tv=TV, k=1):
        x = {'s': s_, 'd': d_, 'f': f'{s_}{d_.replace("-", "")}M00{k}.pdf', 'st': 'ok', 'terms': terms, 'name': '名' + s_}
        if tv is not None:
            x['tv'] = tv
        return x
    base = [R_('X', '2024-11-01', {'CPO': 1}),                                              # 2024Q4 只有 1 家 → 那一季 ⛔ 列
            R_('A', '2025-08-01', {'AI': 1}), R_('C', '2025-08-02', {'CPO': 3}), R_('F', '2025-08-04', {'AI': 1}),
            R_('G', '2026-04-01', {'AI': 1}), R_('H', '2026-05-01', {'AI': 1}),
            R_('A', '2026-08-01', {'CPO': 5, '量產': 2}),          # 第一次提到 CPO
            R_('B', '2026-08-02', {'CPO': 4}),                    # 第一次收錄 → ⛔ 算第一次
            R_('C', '2026-08-03', {'CPO': 2}),                    # 以前就講過 → ⛔ 算
            R_('D', '2026-01-05', {'AI': 1}), R_('D', '2026-09-01', {'共封裝光學': 7}),   # 別名 → 併進 CPO、算第一次
            R_('F', '2026-08-06', {'AI 伺服器': 2}),               # 以前是新規則、沒講 → 算第一次
            R_('G', '2026-07-01', {'CPO': 1}), R_('G', '2026-07-01', {'CPO': 2}, k=2),   # 同一天兩份 → 只算一次
            R_('H', '2026-10-08', {'CPO': 10})]                  # 2026Q4 進行中
    e_old = [R_('E', '2025-08-03', {'伺服器': 2}, tv=None), R_('E', '2026-08-05', {'AI 伺服器': 3})]
    rad = cd.build_radar(base + e_old, date(2026, 10, 25), log=[].append)
    rows_ = {r['t']: r for r in rad['rows']}
    qs = rad['qs']
    iQ3, iQ4 = qs.index('2026Q3'), qs.index('2026Q4')
    cpo, ais = rows_.get('CPO'), rows_.get('AI 伺服器')
    ok('🛰️④ 季從第一個夠多家的那一季開始(2024Q4 只有 1 家 ⛔ 列)、最後一季進行中、比較用 2026Q3',
       qs[0] == '2025Q3' and qs[-1] == '2026Q4' and rad['part'] == 1 and rad['last'] == '2026Q3', (qs, rad['part'], rad['last']))
    ok('🛰️④b CPO 2026Q3:A B C D G 五家在講;第一次提到只有 A D G(B 第一次收錄、C 以前講過 ⛔ 算;G 同一天兩份只算一次)',
       cpo and cpo['m'][iQ3] == 5 and cpo['f'][iQ3] == 3 and sorted(x[0] for x in cpo['fl']['2026Q3']) == ['A', 'D', 'G'], cpo)
    ok('🛰️④c 別名「共封裝光學」併進 CPO(al 列出來)、量產這種太泛的詞 ⛔ 列', cpo and cpo['al'] == ['共封裝光學'] and '量產' not in rows_ and '共封裝光學' not in rows_, list(rows_))
    ok('🛰️④d 第一次提到的公司照日期新 → 舊、帶 [代號, 名稱, 日期, 頁]', cpo and cpo['fl']['2026Q3'][0] == ['D', '名D', '2026-09-01', 7]
       and [x[2] for x in cpo['fl']['2026Q3']] == sorted([x[2] for x in cpo['fl']['2026Q3']], reverse=True), cpo and cpo['fl'])
    ok('🛰️④e 進行中那一季也列第一次提到的(H 10/08)、分母 nco 照季算', cpo and cpo['fl'].get('2026Q4') == [['H', '名H', '2026-10-08', 10]]
       and rad['nco'][iQ3] == 7 and rad['nco'][qs.index('2025Q3')] == 4, (cpo and cpo['fl'], rad['nco']))
    ok('🛰️④f ⭐ 以前那份是舊規則抽的(E)→ 「AI 伺服器」⛔ 算第一次;F 以前是新規則 → 算', ais and ais['m'][iQ3] == 2 and ais['f'][iQ3] == 1
       and [x[0] for x in ais['fl']['2026Q3']] == ['F'] and 'AI 伺服器' in rad['rv'], ais)
    e_new = [R_('E', '2025-08-03', {'伺服器': 2}), R_('E', '2026-08-05', {'AI 伺服器': 3})]
    rad2 = cd.build_radar(base + e_new, date(2026, 10, 25), log=[].append)
    ais2 = {r['t']: r for r in rad2['rows']}['AI 伺服器']
    ok('🛰️④g ⭐ 決定性對照:同一家以前那份也是新規則 → E 算第一次(2 家)', ais2['f'][iQ3] == 2, ais2)
    ok('🛰️④h 每季讀到幾份 / 幾份是舊規則(畫面講「那幾季可能偏低」用)', rad['nd'][qs.index('2025Q3')] == 4 and rad['nold'][qs.index('2025Q3')] == 1, (rad['nd'], rad['nold']))
    ok('🛰️④i 沒有一季夠多家 → 回 None(⛔ 寫半套)', cd.build_radar(base[:2], date(2026, 10, 25), log=[].append) is None)

    # ⑥ 第一次提到:詞庫題材排前面(同一組裡照頁碼)
    nv = cd.novelty_all([R_('Q', '2026-07-01', {'AI': 1}), R_('Q', '2026-08-01', {'WEF': 1, 'TMP': 2, 'CPO': 5, '機器人': 6})])
    q_new = [t for t, _ in nv['Q20260801M001.pdf']['new']]
    ok('🛰️⑥ 第一次提到的詞:題材(CPO / 機器人)排在英文縮寫(WEF / TMP)前面,同一組照頁碼', q_new == ['CPO', '機器人', 'WEF', 'TMP']
       and nv['Q20260801M001.pdf']['n_new'] == 4, q_new)

# ③ 補存全文那條路順便重抽 + ⑤ run() 寫出 cc_radar.json
with tempfile.TemporaryDirectory() as tmp:
    rows = [{'s': '5555', 'name': '測試庚', 'd': '2026-10-21', 't': '14:00', 'pdf': ['555520261021M001.pdf']},
            {'s': '6666', 'name': '測試辛', 'd': '2026-10-22', 't': '14:00', 'pdf': ['666620261022M001.pdf']}]
    cd, data, cc = setup(tmp, rows)
    old55 = {'s': '5555', 'd': '2026-10-21', 'f': '555520261021M001.pdf', 'name': '測試庚', 'kind': 'pdf', 'st': 'ok', 'pages': 2,
             'chars': 300, 'titles': [], 'outlook': [], 'nums': [], 'terms': {}, 'tone': [0, 0], 'ai': {'one': '舊摘要', 'outlook': [], 'new': [], 'risk': []}}
    (cc / 'cc' / 'feat').mkdir(parents=True, exist_ok=True)
    cd._save_json(cc / 'cc' / 'feat' / '2026-10.json.gz', [old55])
    cd._save_json(cc / 'cc' / 'index.json', {'v': 2, 'files': {'555520261021M001.pdf': {'st': 'ok', 's': '5555', 'd': '2026-10-21', 'tries': 1, 'pages': 2}}})
    D55 = deck([['Results', 'Revenue 200 million'], ['Outlook', 'CPO and HBM demand stays strong']])
    D66 = deck([['Results', 'Revenue 300 million'], ['Outlook', 'CPO shipments start next year']])
    cd.RADAR_MIN_CO = 1
    lg5 = []
    rc5 = cd.run(fetcher=FakeFetcher({'555520261021M001.pdf': D55, '666620261022M001.pdf': D66}), groq_keys=[], today=date(2026, 10, 23), log=lg5.append)
    r55 = [r for r in cd._load_json(cc / 'cc' / 'feat' / '2026-10.json.gz', []) if r['f'] == '555520261021M001.pdf']
    ok('🛰️③ 補存全文時順便照新規則重抽詞(CPO / HBM)、標 tv;AI 摘要 / 字數照舊(⛔ 重算特徵)',
       rc5 == 0 and r55 and r55[0].get('tv') == cd.TERMS_VER and 'CPO' in r55[0]['terms'] and 'HBM' in r55[0]['terms']
       and r55[0]['chars'] == 300 and r55[0]['ai']['one'] == '舊摘要', (rc5, r55))
    radf = data / 'cc_radar.json'
    rj = json.loads(radf.read_text(encoding='utf-8')) if radf.exists() else {}
    ok('🛰️⑤ run() 寫出 data/cc_radar.json(兩家都在講 CPO;log 寫季數 / 份數 / 題材數)',
       rj.get('qs') == ['2026Q4'] and {r['t']: r for r in rj.get('rows', [])}.get('CPO', {}).get('m') == [2] and any('🛰️ 主題雷達' in x for x in lg5),
       (rj.get('qs'), [x for x in lg5 if '雷達' in x]))
with tempfile.TemporaryDirectory() as tmp:
    rows = [{'s': '6666', 'name': '測試辛', 'd': '2026-10-22', 't': '14:00', 'pdf': ['666620261022M001.pdf']}]
    cd, data, cc = setup(tmp, rows)
    lg6 = []
    cd.run(fetcher=FakeFetcher({'666620261022M001.pdf': deck([['Outlook', 'CPO shipments start next year']])}), groq_keys=[], today=date(2026, 10, 23), log=lg6.append)
    ok('🛰️⑤b ⭐ 決定性對照:預設門檻(一季 300 家)→ 不寫雷達、log 說為什麼', not (data / 'cc_radar.json').exists() and any('不產出' in x for x in lg6), [x for x in lg6 if '雷達' in x])
with tempfile.TemporaryDirectory() as tmp:
    rows = [{'s': '6666', 'name': '測試辛', 'd': '2026-10-22', 't': '14:00', 'pdf': ['666620261022M001.pdf']}]
    cd, data, cc = setup(tmp, rows)
    cd.RADAR_MIN_CO = 1
    def _boom(*a, **k):
        raise ValueError('測試用:雷達壞掉')
    cd.build_radar = _boom
    lg7 = []
    rc7 = cd.run(fetcher=FakeFetcher({'666620261022M001.pdf': deck([['Outlook', 'CPO shipments start next year']])}), groq_keys=[], today=date(2026, 10, 23), log=lg7.append)
    ok('🛰️⑤c 雷達算不出來 → 只記一行、run() 照常結束、簡報重點照樣寫出來(⛔ 拖累部署)',
       rc7 == 0 and (data / 'confcall_digest.json').exists() and not (data / 'cc_radar.json').exists() and any('主題雷達算不出來' in x for x in lg7),
       (rc7, [x for x in lg7 if '雷達' in x]))

# ⑦ workflow:雷達跟 data/cc 一起推(兩個分支、重試那一圈也要帶)
ok('🛰️⑦ confcall_deck.yml 部署那步帶 cc_radar.json(先驗是完整 JSON、重試也帶)',
   'cc_radar.json' in _dep and _dep.count('$RAD') >= 3 and 'json.load(open(sys.argv[1]))' in _dep, _dep[:400])

print('\n' + (f'❌ test_confcall_deck 失敗 {len(fails)} 條' if fails else '✅ test_confcall_deck 全過'))
sys.exit(1 if fails else 0)
