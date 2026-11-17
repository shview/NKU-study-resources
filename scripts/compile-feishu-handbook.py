"""Compile archived Feishu DocxXML directly to safe mini-program HTML (no Markdown pass)."""
import argparse
import html
import json
import pathlib
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from urllib.parse import urlsplit

BLOCKS = {'p', 'ul', 'ol', 'li', 'blockquote', 'callout', 'figure', 'img', 'hr', 'table', 'sub-page-list', *[f'h{i}' for i in range(1, 10)]}
INLINE = {'b', 'strong', 'em', 'i', 'u', 'del', 's', 'code', 'sub', 'sup', 'span', 'a', 'cite', 'latex', 'br'}

def public_text(value):
    value = str(value or '')
    value = re.sub(r'(?<!\d)1[3-9]\d{9}(?!\d)', '[联系方式已隐藏]', value)
    return re.sub(r'(?:微信|QQ)\s*[:：]\s*[A-Za-z0-9_-]{5,}', '[私人联系方式已隐藏]', value, flags=re.I)

def escaped(value):
    return html.escape(public_text(value), quote=True)

def safe_url(value):
    value = str(value or '').strip()
    try:
        parsed = urlsplit(value)
    except ValueError:
        return ''
    return value if parsed.scheme == 'https' and parsed.hostname and not parsed.username and not re.search(r'[\s\\<>]', value) else ''

class Compiler:
    def __init__(self, source_url, images, document_routes):
        self.source_url = source_url
        self.images = images
        self.document_routes = document_routes
        self.outline = []
        self.used_images = []
        self.attachments = 0
        self.unknown = set()

    def link(self, label, url):
        href = safe_url(url)
        return f'<a href="{html.escape(href, quote=True)}">{escaped(label)}</a>' if href else escaped(label)

    def children(self, node):
        return escaped(node.text) + ''.join(self.render(child) + escaped(child.tail) for child in node)

    def flow(self, node, tag, attributes=''):
        # DocxXML permits lists below headings and paragraphs. HTML headings must
        # contain only their own inline content, never the descendant paragraphs.
        current = escaped(node.text)
        pieces = []
        for child in node:
            if child.tag in BLOCKS:
                if current.strip():
                    pieces.append(f'<{tag}{attributes}>{current}</{tag}>')
                    attributes = ''
                    current = ''
                pieces.append(self.render(child))
            else:
                current += self.render(child)
            current += escaped(child.tail)
        if current.strip():
            pieces.append(f'<{tag}{attributes}>{current}</{tag}>')
        return ''.join(pieces)

    def render(self, node):
        tag = node.tag
        if tag == 'title':
            return ''  # The native page header owns the document title.
        if tag == 'root':
            return self.children(node)
        if re.fullmatch(r'h[1-9]', tag):
            level = min(int(tag[1]), 6)
            label = public_text((node.text or '') + ''.join(''.join(child.itertext()) + (child.tail or '') for child in node if child.tag not in BLOCKS)).strip()
            anchor = f'fs-heading-{len(self.outline) + 1}'
            self.outline.append({'id': anchor, 'title': label, 'level': level})
            return self.flow(node, f'h{level}', f' id="{anchor}"')
        if tag == 'p':
            return self.flow(node, 'p')
        if tag in {'ul', 'ol'}:
            first = next(iter(node), None)
            seq = first.get('seq', '') if first is not None else ''
            start = f' start="{seq}"' if tag == 'ol' and seq.isdigit() else ''
            return f'<{tag}{start}>{self.children(node)}</{tag}>'
        if tag == 'li':
            return f'<li>{self.children(node)}</li>'
        if tag in {'blockquote', 'callout'}:
            emoji = escaped(node.get('emoji', ''))
            return f'<blockquote>{emoji + " " if emoji else ""}{self.children(node)}</blockquote>'
        if tag == 'span':
            style = ' style="background-color:var(--nk-gold-soft,#FFF2BD);color:inherit"' if node.get('background-color') else ''
            return f'<span{style}>{self.children(node)}</span>'
        if tag == 'a':
            href = safe_url(node.get('href'))
            return f'<a href="{html.escape(href, quote=True)}">{self.children(node)}</a>' if href else self.children(node)
        if tag == 'bookmark':
            return f'<p>{self.link(node.get("name") or node.get("href"), node.get("href"))}</p>'
        if tag in {'cite', 'sub-page'}:
            if node.get('type') == 'user':
                return escaped(node.get('user-name') or '原作者')
            doc_id = node.get('doc-id', '')
            url = self.document_routes.get(doc_id)
            if not url and re.fullmatch(r'[A-Za-z0-9]+', doc_id):
                kind = node.get('file-type', 'docx')
                url = f'https://nankai.feishu.cn/{kind if kind in {"docx", "doc", "wiki", "sheets", "base"} else "docx"}/{doc_id}'
            link = self.link(node.get('title') or '引用文档', url or self.source_url)
            return f'<li>{link}</li>' if tag == 'sub-page' else link
        if tag == 'sub-page-list':
            return '<ul>' + self.children(node) + '</ul>'
        if tag == 'img':
            token = node.get('src') or node.get('token')
            if token not in self.images:
                raise ValueError('Image has no archived public mapping: ' + str(token))
            src = self.images[token]
            self.used_images.append(src)
            return f'<img src="{src}" alt="{escaped(node.get("alt") or "手册原图")}" />'
        if tag == 'figure':
            return self.children(node)
        if tag == 'source':
            self.attachments += 1
            label = node.get('name') or '原文附件'
            return '<div style="padding:12px 14px;margin:12px 0;border:1px solid var(--nk-line,#E5DDED);border-radius:8px">' + self.link('附件 · ' + label, self.source_url) + '</div>'
        if tag == 'latex':
            formula = ''.join(node.itertext()).replace('\\\\', '\\')
            match = re.fullmatch(r'\s*([A-Za-z])\s*\\leq_p\s*([A-Za-z])\s*', formula)
            if match:
                return f'<span>{match[1]} ≤<sub>p</sub> {match[2]}</span>'
            return '<code>' + escaped(formula) + '</code>'
        if tag in {'br', 'hr'}:
            return f'<{tag} />'
        if tag in INLINE - {'a', 'cite', 'span', 'latex', 'br'}:
            mapped = {'b': 'strong', 'i': 'em', 'del': 's'}.get(tag, tag)
            return f'<{mapped}>{self.children(node)}</{mapped}>'
        if tag in {'table', 'thead', 'tbody', 'tr', 'td', 'th'}:
            spans = ''.join(f' {key}="{node.get(key)}"' for key in ['colspan', 'rowspan'] if node.get(key, '').isdigit()) if tag in {'td', 'th'} else ''
            return f'<{tag}{spans}>{self.children(node)}</{tag}>'
        # Unknown blocks stop publication instead of silently discarding content.
        self.unknown.add(tag)
        return self.children(node)

def compile_archive(archive, target):
    log = archive / '_同步记录'
    records = json.loads((log / 'documents.json').read_text(encoding='utf-8-sig'))
    media = json.loads((log / 'main-images.json').read_text(encoding='utf-8-sig'))
    images = {entry['token']: 'https://nkustudy.top/guide-media/' + entry['token'] + pathlib.Path(entry['saved']).suffix for entry in media}
    routes = {record['obj_token']: 'https://nkustudy.top/guides/handbook-' + record['node_token'].lower() + '/' for record in records}
    content = json.loads(target.read_text(encoding='utf-8'))
    by_id = {guide['id']: guide for guide in content['guides']}
    report = []
    for record in records:
        original = json.loads((log / 'xml' / (record['obj_token'] + '.json')).read_text(encoding='utf-8-sig'))
        if not original.get('ok'):
            raise ValueError('Missing source XML: ' + record['title'])
        guide = by_id['handbook-' + record['node_token'].lower()]
        compiler = Compiler(guide['sources'][0]['official_page_url'], images, routes)
        rich = compiler.render(ET.fromstring('<root>' + original['data']['document']['content'] + '</root>'))
        if compiler.unknown:
            raise ValueError('Unhandled blocks: ' + ', '.join(sorted(compiler.unknown)))
        section = next(section for section in guide['sections'] if section['id'].endswith('-body'))
        section['body_html'] = rich
        section['body_outline'] = compiler.outline
        section['render_format'] = 'feishu-html-v1'
        report.append({'id': guide['id'], 'images': len(compiler.used_images), 'attachments': compiler.attachments, 'headings': len(compiler.outline), 'html_bytes': len(rich.encode('utf-8'))})
    assert sum(row['images'] for row in report) == len(images) == 6
    content['version'] = 'handbook-richtext-20261117'
    content['compiled_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    target.write_text(json.dumps(content, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'guides': len(report), 'images': sum(row['images'] for row in report), 'attachments': sum(row['attachments'] for row in report), 'headings': sum(row['headings'] for row in report), 'largest_html_bytes': max(row['html_bytes'] for row in report)}, ensure_ascii=False))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=pathlib.Path)
    parser.add_argument('--target', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent / 'content/survival-handbook.json')
    args = parser.parse_args()
    compile_archive(args.archive, args.target)
