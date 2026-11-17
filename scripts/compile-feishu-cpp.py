"""Compile the complete C++ archive into bounded native-reader chapters.

Does not mutate the handbook compiler or the active production snapshot.
Unknown blocks, missing images and incomplete sheets abort compilation.
"""
import argparse
import collections
import hashlib
import html
import importlib.util
import json
import pathlib
import re
import xml.etree.ElementTree as ET

BASE = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('handbook', BASE/'scripts/compile-feishu-handbook.py')
handbook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handbook)
handbook.BLOCKS.update({'pre', 'sheet', 'grid', 'column'})
URL = 'https://nankai.feishu.cn/wiki/Cve2wGjESikMqrkMY7bcEbqgned'
AUTHOR = '王昊成（小红书：秋来拾光），无所不能哈基咪'

def literal(node):
    return (node.text or '') + ''.join(('\n' if c.tag == 'br' else literal(c)) + (c.tail or '') for c in node)

class Compiler(handbook.Compiler):
    def __init__(self, archive, images):
        super().__init__(URL, images, {})
        self.archive = archive
        self.counts = collections.Counter()

    def render(self, node):
        tag = node.tag
        self.counts[tag] += 1
        if tag == 'pre':
            # Preserve every space, newline, operator and literal, including long numbers.
            language = html.escape(node.get('lang', '代码'))
            return '<div style="margin:18px 0"><div style="font-size:12px;color:var(--nk-muted,#6F6972)">' + language + '</div><pre style="white-space:pre;overflow:auto;padding:14px;background:var(--nk-soft,#F5F0F9);border-radius:8px;font-size:13px;line-height:1.65"><code style="padding:0;background:transparent">' + html.escape(literal(node)) + '</code></pre></div>'
        if tag == 'code':
            return '<code>' + html.escape(literal(node)) + '</code>'
        if tag == 'sheet':
            file = self.archive/'sheets'/f'{node.get("token")}-{node.get("sheet-id")}.json'
            data = json.loads(file.read_text(encoding='utf-8'))
            if not data.get('ok') or data['data'].get('has_more'): raise ValueError('Incomplete sheet')
            rows = data['data']['ranges'][0]['cells']
            def cell(c):
                value = c.get('value', '')
                if not isinstance(value, (str, int, float, bool)): raise ValueError('Unsupported cell value: '+repr(value))
                return html.escape(str(value)).replace('\n','<br />')
            return '<table style="min-width:560px"><tbody>' + ''.join('<tr>'+''.join('<td>'+cell(c)+'</td>' for c in row)+'</tr>' for row in rows) + '</tbody></table>'
        if tag in {'grid', 'column'}: return '<div>' + self.children(node) + '</div>'
        if tag in {'colgroup', 'col'}: return ''  # Intrinsic table widths remain responsive.
        if tag == 'latex':
            formula = literal(node).strip().replace('\\\\', '\\')
            known = {
                r'\boldsymbol{0.625_{(10)}=0.101_{(2)}}': '<strong>0.625<sub>(10)</sub> = 0.101<sub>(2)</sub></strong>',
                'ax^2 + bx + c = 0': 'ax<sup>2</sup> + bx + c = 0',
                r'a \neq 0': 'a ≠ 0', 's': '<em>s</em>',
            }
            if formula == r'\begin{align} 0.625\times 2 &= 1.25 \quad \text{取整：}\boldsymbol1\ 0.25\times 2  &= 0.5 \quad \text{取整：}\boldsymbol0\ 0.5\times 2   &= 1.0 \quad \text{取整：}\boldsymbol1\ \end{align}':
                return '<div>0.625 × 2 = 1.25　取整：<strong>1</strong><br />0.25 × 2 = 0.5　取整：<strong>0</strong><br />0.5 × 2 = 1.0　取整：<strong>1</strong></div>'
            if formula not in known: raise ValueError('Unsupported formula: '+formula)
            return '<span>'+known[formula]+'</span>'
        return super().render(node)

def compile_archive(archive, target):
    source = json.loads((archive/'source.json').read_text(encoding='utf-8-sig'))
    assert source['ok']
    root = ET.fromstring('<root>'+source['data']['document']['content']+'</root>')
    mapping = json.loads((archive/'images.json').read_text(encoding='utf-8'))
    images = {}
    for token, url in mapping.items():
        file = BASE/'public'/url.lstrip('/')
        if not file.is_file() or not file.stat().st_size: raise ValueError('Missing original '+token)
        images[token] = 'https://nkustudy.top'+url
    # Each h1 is an original chapter boundary, no content dropped or summarized.
    chunks = []
    for node in root:
        if node.tag == 'title': continue
        if (node.tag == 'h1' and literal(node).strip()) or not chunks: chunks.append([])
        chunks[-1].append(node)
    guides, report = [], []
    for i, nodes in enumerate(chunks):
        compiler = Compiler(archive, images)
        rich = ''.join(compiler.render(n) for n in nodes)
        if compiler.unknown: raise ValueError('Unhandled tags: '+str(compiler.unknown))
        compiler.outline = [entry for entry in compiler.outline if f'id="{entry["id"]}"' in rich]
        title = literal(nodes[0]).strip() if nodes[0].tag == 'h1' else '前言与作者'
        gid = f'cpp-notes-{i:03d}'
        sid = gid+'-source'
        guide = dict(id=gid, title='C++ 笔记 · '+title, summary='作者：'+AUTHOR, category='academic-development', category_label='学业拓展', applicable_scope='C++ 课程学习参考', updated_at='2026-11-17', time_status='long_term', content_type='student_experience', read_minutes=max(1,len(rich)//1500), aliases=[title], tags=['C++','学习笔记'], sources=[dict(id=sid,title='C++ 笔记',publisher=AUTHOR,official_page_url=URL,url=URL,file_url='',location_label='飞书原文',file_type='web',document_no='学生笔记')], variants=[],variant_details=[],retrieval=[])
        guide['sections'] = [dict(id=gid+'-body',title=title,body='\n'.join(literal(n) for n in nodes),body_format='plain',render_format='feishu-html-v1',body_html=rich,body_outline=compiler.outline,source_ids=[sid])]
        if len(json.dumps(guide,ensure_ascii=False).encode()) > 700000: raise ValueError('Chapter exceeds native payload budget: '+gid)
        guides.append(guide)
        report.append(dict(id=gid, title=title, html_bytes=len(rich.encode()), counts=dict(compiler.counts)))
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(dict(version='cpp-notes-richtext-v1',source_revision=source['data']['document']['revision_id'],guides=guides),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (archive/'compile-report.json').write_text(json.dumps(dict(source_sha256=hashlib.sha256((archive/'source.json').read_bytes()).hexdigest(),source_counts=dict(collections.Counter(n.tag for n in root.iter())),chapters=report),ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(dict(chapters=len(guides),images=len(images),max_html_bytes=max(r['html_bytes'] for r in report))))

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--archive',type=pathlib.Path,default=BASE/'artifacts/cpp-notes')
    parser.add_argument('--target',type=pathlib.Path,default=BASE/'content/cpp-notes.json')
    args=parser.parse_args()
    compile_archive(args.archive,args.target)
