"""Archive only resources referenced by the C++ DocxXML; never reads credentials."""
import concurrent.futures as futures
import json
import pathlib
import subprocess
import xml.etree.ElementTree as ET

BASE = pathlib.Path(__file__).resolve().parents[1]
ARCHIVE = BASE / 'artifacts/cpp-notes'
CLI = 'C:/Users/HP/AppData/Roaming/npm/node_modules/@larksuite/cli/scripts/run.js'

def run(args):
    result = subprocess.run(['node', CLI, *args, '--as', 'bot'], cwd=BASE, capture_output=True, encoding='utf-8')
    data = json.loads(result.stdout if result.returncode == 0 else result.stderr)
    if not data.get('ok'):
        raise RuntimeError(data.get('error'))
    return data

def archive():
    root = ET.fromstring('<root>' + json.loads((ARCHIVE/'source.json').read_text(encoding='utf-8-sig'))['data']['document']['content'] + '</root>')
    (ARCHIVE/'sheets').mkdir(exist_ok=True)
    (BASE/'public/guide-media/cpp-notes').mkdir(parents=True, exist_ok=True)
    workbooks = {}
    for token in {n.get('token') for n in root.iter('sheet')}:
        data = run(['sheets', '+workbook-info', '--spreadsheet-token', token])
        (ARCHIVE/f'workbook-{token}.json').write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        workbooks[token] = {s['sheet_id']: s for s in data['data']['sheets']}
    def image(node):
        token = node.get('src')
        destination = f'public/guide-media/cpp-notes/{token}'
        existing = list(BASE.glob(destination + '.*'))
        data = {'saved_path': str(existing[0])} if existing else run(['docs', '+media-download', '--token', token, '--output', destination])['data']
        return token, '/guide-media/cpp-notes/' + pathlib.Path(data['saved_path']).name
    def sheet(node):
        token, sid = node.get('token'), node.get('sheet-id')
        info = workbooks[token][sid]
        if info['merged_cells_count'] or info['float_image_count'] or info['chart_count']:
            raise ValueError('Sheet requires additional object extraction: '+sid)
        col, n = '', info['column_count']
        while n:
            n, rem = divmod(n-1,26); col = chr(65+rem)+col
        file = ARCHIVE/'sheets'/f'{token}-{sid}.json'
        if not file.exists():
            data = run(['sheets', '+cells-get', '--spreadsheet-token', token, '--sheet-id', sid, '--range', f'A1:{col}{info["row_count"]}', '--include', 'value,style'])
            if data['data'].get('has_more'): raise ValueError('Truncated sheet '+sid)
            file.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
        return sid
    with futures.ThreadPoolExecutor(max_workers=4) as pool:
        images = dict(pool.map(image, list(root.iter('img'))))
        print('Images archived:', len(images), flush=True)
        sheets = list(pool.map(sheet, list(root.iter('sheet'))))
        print('Sheets archived:', len(sheets), flush=True)
    (ARCHIVE/'images.json').write_text(json.dumps(images,indent=2),encoding='utf-8')

if __name__ == '__main__': archive()
