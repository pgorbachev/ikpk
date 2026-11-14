"""Fail-closed, offline proposal generator; it never writes to a CMS or database."""
import hashlib
import html
from html.parser import HTMLParser
import json
import re
from urllib.parse import urlsplit

RULE_VERSION = '1'
TITLES = {'Для кого подойдет': ('audience', 'audience'),
          'Для кого подойдёт': ('audience', 'audience'),
          'Учебный план': ('learning_plan', 'learning-plan'),
          'Как проходит обучение': ('learning_mode', 'learning-mode'),
          'Рекомендации': ('recommendations', 'recommendations')}
ORDER = ['audience', 'learning_plan', 'learning_mode', 'recommendations']
FIELDS = ['description', 'audience', *ORDER[1:]]
TAGS = {'p', 'div', 'span', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'br', 'a', 'img', 'h2', 'h3', 'h4', 'blockquote', 'button'}
VOID = {'br', 'img'}
ATTRS = {'a': {'href', 'title'}, 'img': {'src', 'alt', 'title'}, 'h2': {'data-collapsible-title'}, 'div': {'data-state', 'class'}, 'button': {'class'}}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


class Node:
    def __init__(self, tag=None, attrs=None, parent=None):
        self.tag, self.attrs, self.parent = tag, attrs or [], parent
        self.children = []


class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = self.current = Node()
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in TAGS:
            self.errors.append('unsupported-element:' + tag)
        if len({k for k, _ in attrs}) != len(attrs):
            self.errors.append('duplicate-attribute:' + tag)
        for key, value in attrs:
            if key not in ATTRS.get(tag, set()):
                self.errors.append('unsupported-attribute:' + tag + ':' + key)
            if key in ('href', 'src'):
                if not value or value.strip() != value or any(ord(c) < 32 for c in value):
                    self.errors.append('invalid-url')
                elif urlsplit(value).scheme.lower() not in ('', 'https', 'http', 'mailto', 'tel') or value.startswith('//'):
                    self.errors.append('unsupported-url')
        node = Node(tag, attrs, self.current)
        self.current.children.append(node)
        if tag not in VOID:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.current is self.root or self.current.tag != tag:
            self.errors.append('unbalanced-tag:' + tag)
        else:
            self.current = self.current.parent

    def handle_data(self, data):
        self.current.children.append(data)

    def handle_comment(self, data):
        self.errors.append('unsupported-comment')

    def handle_decl(self, decl):
        self.errors.append('unsupported-declaration')

    def unknown_decl(self, data):
        self.errors.append('unsupported-declaration')

    def finish(self):
        self.close()
        if self.current is not self.root:
            self.errors.append('unclosed-tag')
        return self.root


def parse(value):
    parser = Parser()
    try:
        parser.feed(value or '')
        return parser.finish(), parser.errors
    except (ValueError, TypeError):
        return Node(), ['invalid-html']


def render(node):
    if isinstance(node, str):
        return html.escape(node, quote=False)
    attrs = ''.join(' ' + k + ('="' + html.escape(v, quote=True) + '"' if v is not None else '') for k, v in node.attrs)
    return '<' + node.tag + attrs + '>' + ('' if node.tag in VOID else ''.join(map(render, node.children)) + '</' + node.tag + '>')


def text_content(node):
    return node if isinstance(node, str) else ''.join(map(text_content, node.children))


def walk(node):
    if not isinstance(node, str):
        yield node
        for child in node.children:
            yield from walk(child)


def significant(children):
    return [n for n in children if not isinstance(n, str) or n.strip()]


def panel_parts(node):
    # Only this completely recognised Radix shape can be stripped.
    if isinstance(node, str) or node.tag != 'div' or node.attrs != [('data-state', 'closed')]:
        return None
    children = significant(node.children)
    if not 1 <= len(children) <= 2:
        return None
    trigger = children[0]
    if isinstance(trigger, str) or trigger.tag != 'button' or not re.fullmatch(r'collapsible_trigger__[^ ]+', dict(trigger.attrs).get('class', '')) or len(trigger.attrs) != 1:
        return None
    headings = significant(trigger.children)
    if len(headings) != 1 or isinstance(headings[0], str) or headings[0].tag != 'h2' or headings[0].attrs != [('data-collapsible-title', 'true')]:
        return None
    body = None
    if len(children) == 2:
        content = children[1]
        if isinstance(content, str) or content.tag != 'div' or dict(content.attrs).get('data-state') != 'open' or not re.fullmatch(r'collapsible_content__[^ ]+', dict(content.attrs).get('class', '')) or len(content.attrs) != 2:
            return None
        body = content.children
    return headings[0], body


def check_content(node, reasons):
    for item in walk(node):
        if item.tag == 'button' or (item.tag == 'div' and item.attrs):
            reasons.append('unrecognised-wrapper')
        if item.tag == 'h2' and dict(item.attrs).get('data-collapsible-title') == 'true':
            reasons.append('nested-section-or-legacy-wrapper')


def convert(source, sidecar=None):
    reasons = []
    if not isinstance(source, dict):
        return {'status': 'blocked', 'reasons': ['invalid-source']}
    for key in ('document_id', 'version', 'path', 'description'):
        if not isinstance(source.get(key), str) or (key != 'description' and not source[key]):
            reasons.append('invalid-source:' + key)
    if source.get('version') not in ('draft', 'published'):
        reasons.append('invalid-version')
    for key in ('description', 'full_text', 'audience', 'learning_plan', 'learning_mode', 'recommendations'):
        if source.get(key) is not None and not isinstance(source[key], str):
            reasons.append('invalid-field:' + key)
    if reasons:
        return {'status': 'blocked', 'reasons': sorted(set(reasons))}
    root, errors = parse(source['description'])
    reasons.extend(errors)
    fields = {k: '' for k in FIELDS}
    provenance = {k: [] for k in FIELDS}
    anchors = {}
    active = 'description'
    seen = set()
    previous = -1
    panels = None
    for node in root.children:
        if isinstance(node, str) and not node.strip():
            continue
        parts = panel_parts(node)
        is_heading = not isinstance(node, str) and node.tag == 'h2' and dict(node.attrs).get('data-collapsible-title') == 'true'
        if parts or is_heading:
            heading, embedded = parts if parts else (node, None)
            title = text_content(heading).strip()
            if title not in TITLES:
                reasons.append('unknown-or-document-section:' + title)
                active = None
                continue
            field, anchor = TITLES[title]
            if field in seen:
                reasons.append('duplicate-section:' + title)
            seen.add(field)
            index = ORDER.index(field)
            if index < previous:
                reasons.append('section-order-conflict')
            previous = index
            anchors['#section-' + str(len(anchors) + 1)] = '#' + anchor
            active = field
            if embedded is not None and any(text_content(n).strip() or (not isinstance(n, str) and any(x.tag == 'img' for x in walk(n))) for n in embedded):
                for child in embedded:
                    check_content(child, reasons)
                fields[field] = ''.join(map(render, embedded))
                provenance[field].append({'source': 'description', 'sha256': fingerprint(fields[field])})
                continue
            # A collapsed panel requires a sidecar pinned to this exact source.
            if panels is None:
                if not isinstance(sidecar, dict) or not isinstance(sidecar.get('panels'), dict) or not isinstance(sidecar.get('pin'), dict):
                    reasons.append('sidecar-provenance-unverified')
                    panels = {}
                else:
                    panels = sidecar['panels']
                    pin = sidecar['pin']
                    if pin.get('source_sha256') != fingerprint(source) or pin.get('panels_sha256') != fingerprint(panels):
                        reasons.append('sidecar-provenance-unverified')
            panel = panels.get(source['path'], {}).get(title) if isinstance(panels.get(source['path'], {}), dict) else None
            if not isinstance(panel, str):
                reasons.append('missing-sidecar-body:' + title)
            else:
                body, body_errors = parse(panel)
                reasons.extend(body_errors)
                if any(not isinstance(n, str) and n.tag == 'h2' and dict(n.attrs).get('data-collapsible-title') == 'true' for n in walk(body)):
                    reasons.append('nested-section')
                check_content(body, reasons)
                fields[field] = ''.join(map(render, body.children))
                provenance[field].append({'source': 'sidecar', 'path': source['path'], 'title': title, 'sha256': fingerprint(panel)})
            continue
        check_content(node, reasons)
        if active is not None:
            # A nonempty body alongside sidecar creates an unresolved precedence conflict.
            if active != 'description':
                reasons.append('embedded-and-sidecar-content-conflict')
            fields[active] += render(node)
            provenance[active].append({'source': 'description', 'sha256': fingerprint(render(node))})
    for key in ('full_text', 'audience', 'learning_plan', 'learning_mode', 'recommendations'):
        if source.get(key) and source[key].strip():
            reasons.append('existing-field-needs-review:' + key)
    if reasons:
        return {'status': 'blocked', 'reasons': sorted(set(reasons)), 'input_sha256': fingerprint(source)}
    return {'status': 'ready', 'fields': fields, 'anchors': anchors, 'provenance': provenance,
            'input_sha256': fingerprint(source), 'output_sha256': fingerprint(fields), 'rules_version': RULE_VERSION,
            'comparison': {'source_description': source['description'], 'proposed_fields': fields,
                           'limitations': ['requires renderer, sanitizer, links, media, documents and incoming-anchor review']}}
