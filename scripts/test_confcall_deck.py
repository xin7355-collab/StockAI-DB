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
    """mode:'range' 支援續傳 / 'ignore' 不理 Range(回 200 整份)/ 'wrong' 回 206 但起點不對
       kbs:{'nas': KB/s, 'srv': KB/s} ・cut:第一次請求在第幾個 byte 斷 ・early:斷法改成提早結束不丟例外 ・clen:有沒有 Content-Length"""
    def __init__(s, clk, body, kbs, mode='range', cut=None, early=False, clen=True):
        s.clk, s.body, s.kbs, s.mode, s.cut, s.early, s.clen, s.calls = clk, body, kbs, mode, cut, early, clen, []
    def get(s, url, headers=None, **kw):
        k = 'nas' if '/nas/STR/' in url else 'srv'
        rg = (headers or {}).get('Range')
        s.calls.append((k, rg))
        n = len(s.body)
        cut = s.cut if len(s.calls) == 1 else None
        if rg and s.mode in ('range', 'wrong'):
            a = int(rg.split('=')[1].rstrip('-'))
            st = a if s.mode == 'range' else max(0, a - 1000)
            return RgResp(s.clk, s.body, st, s.kbs[k], 206, {'Content-Range': f'bytes {st}-{n - 1}/{n}', 'Content-Length': str(n - st)}, cut, not s.early)
        return RgResp(s.clk, s.body, 0, s.kbs[k], 200, ({'Content-Length': str(n)} if s.clen else {}), cut, not s.early)
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
s41b = RgSess(ck41b, B9, {'nas': 10, 'srv': 25}, clen=False)
b41b, e41b, k41b = _rgf(s41b, ck41b).get_any(cdm.file_urls(TPL, '771520261022M001.pdf'))
ok('㊶b 不知道多大、檔案路徑慢慢給到時限 → 下載程式那條沒時間了就 ⛔ 換(一份 ⛔ 拖到 480 秒)',
   b41b is None and 'srv:skip:' in e41b and all(c[0] == 'nas' for c in s41b.calls) and ck41b['t'] <= cdm.DL_MAX_SEC + 5
   and cdm.err_kind(e41b) == 'tmp', (e41b, round(ck41b['t']), s41b.calls[:3]))
ck41c = {'t': 0.0}
rs41 = RouteSess({'srv': 'pdf', 'nas': 'html'}, ck41c)
b41c, e41c, k41c = cdm.Fetcher(session=rs41, pace=0, sleeper=lambda x: None, clock=lambda: ck41c['t']).get_any(cdm.file_urls(TPL, '233020260716M001.pdf'))
ok('㊶c ⭐ 決定性對照:檔案路徑馬上回網頁 → 下載程式照樣有整份的時間(⛔ 誤判成沒時間)', b41c and k41c == 'srv' and rs41.calls == ['nas', 'srv'], (e41c, rs41.calls))
ok('㊶d 原因字串的續傳紀錄不會被 err_kind 當成兩條路的分隔', cdm.err_kind('nas:ConnectionError@3s(已800KB);續傳@800KB | srv:slow:100KB/240s') == 'tmp')
# ㊷ job 時限要裝得下「讀到 40 分才停止開新的 + 最後那份大簡報下載滿 + 抽字 + AI + 推檔」(被砍掉 = 整輪白讀,紀錄在最後才存)
_tm = int(re.search(r'timeout-minutes:\s*(\d+)', _wf).group(1))
# 安裝平常 3 分、apt 慢的時候 5 分;推檔兩個分支各 5 次重試(5~25 秒)+ 接力 → 抓 5 分
_need = 5 * 60 + cdm.BUDGET_MIN * 60 + cdm.DL_BIG_MAX_SEC + cdm.EXTRACT_MAX_SEC + cdm.AI_DEADLINE + 5 * 60
ok('㊷ job 時限 ≥ 安裝 5 分 + 讀簡報上限 + 最後一份下載上限 + 抽字 + AI + 推檔 5 分(改其中任何一個時限要一起看)',
   _tm * 60 >= _need, (_tm, round(_need / 60, 1)))


print('\n' + (f'❌ test_confcall_deck 失敗 {len(fails)} 條' if fails else '✅ test_confcall_deck 全過'))
sys.exit(1 if fails else 0)
