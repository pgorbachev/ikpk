#!/usr/bin/env python3
"""Read-only inventory, deliberately not a content converter or migration."""
import argparse
import collections
import hashlib
import json
import sqlite3
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote

FIELDS = ('description', 'full_text', 'learning_plan', 'learning_mode', 'recommendations')
TITLES = {'Для кого подойдет': 'audience', 'Учебный план': 'learning_plan',
          'Как проходит обучение': 'learning_mode', 'Рекомендации': 'recommendations',
          'Выдаваемые документы': 'documents'}


def digest(value):
    return hashlib.sha256((value or '').encode()).hexdigest()


class Inventory(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.titles, self.urls, self.tags = [], [], collections.Counter()
        self._title = None
        self.feed(html or '')
        self.close()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.tags[tag] += 1
        if attrs.get('data-collapsible-title') == 'true':
            self._title = []
        for key in ('href', 'src', 'srcset', 'poster'):
            if attrs.get(key):
                self.urls.append((tag, key, attrs[key]))

    def handle_data(self, data):
        if self._title is not None:
            self._title.append(data)

    def handle_endtag(self, tag):
        if self._title is not None and tag in ('h1','h2','h3','h4','h5','h6'):
            self.titles.append(''.join(self._title).strip())
            self._title = None


def inspect_row(row, paths, panels):
    source = Inventory(row['description'])
    path = paths[0] if len(paths) == 1 else None
    sidecar = panels.get(path, {}) if path else {}
    reasons = []
    if len(paths) != 1: reasons.append('route-not-unique')
    if row['published_at'] is None and source.titles: reasons.append('draft-sidecar-provenance-unverified')
    if any(t not in TITLES for t in source.titles): reasons.append('unknown-title')
    if len(source.titles) != len(set(source.titles)): reasons.append('duplicate-title')
    if any(t not in sidecar for t in source.titles): reasons.append('missing-sidecar-key')
    if any(row[f] for f in FIELDS[1:]): reasons.append('existing-content-needs-reconciliation')
    # No automatic conversion: even matched sections need editor review, full render
    # comparison, and explicit handling of document and registration content.
    reasons.append('conversion-and-public-equivalence-not-verified')
    return {'id': row['id'], 'document_id': row['document_id'], 'locale': row['locale'],
            'version': 'published' if row['published_at'] is not None else 'draft',
            'published_at': row['published_at'], 'route_candidates': paths,
            'field_sha256': {f: digest(row[f]) for f in FIELDS},
            'field_nonempty': {f: bool(row[f]) for f in FIELDS},
            'titles': source.titles, 'sidecar_keys': sorted(sidecar),
            'sidecar_body_sha256': {t: digest(sidecar[t]) for t in source.titles if t in sidecar},
            'source_url_count': len(source.urls),
            'sidecar_url_counts': {t: len(Inventory(sidecar[t]).urls) for t in source.titles if t in sidecar},
            'blocked': sorted(set(reasons))}


def audit(db, sidecar):
    # URI-escape the filesystem path; never open in default read/write mode.
    uri = 'file:' + quote(str(Path(db).resolve()), safe='/') + '?mode=ro'
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA query_only=ON')
    raw = Path(sidecar).read_bytes()
    panels = json.loads(raw)
    rows = con.execute('SELECT id, document_id, locale, slug, published_at, ' + ','.join(FIELDS) + ' FROM seminars ORDER BY document_id, locale, id').fetchall()
    results = []
    for row in rows:
        routes = con.execute('''SELECT DISTINCT i.slug, c.slug FROM seminars_course_group_lnk sc
            JOIN course_groups c ON c.id=sc.course_group_id
            JOIN course_groups_institute_lnk ci ON ci.course_group_id=c.id
            JOIN institutes i ON i.id=ci.institute_id WHERE sc.seminar_id=?''', (row['id'],)).fetchall()
        paths = sorted({'/' + '/'.join((r[0], r[1], row['slug'])) for r in routes if all((r[0],r[1],row['slug']))})
        results.append(inspect_row(row, paths, panels))
    con.close()
    return {'sidecar_sha256': hashlib.sha256(raw).hexdigest(), 'records': results}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('database'); p.add_argument('sidecar'); p.add_argument('output')
    args = p.parse_args()
    report = audit(args.database, args.sidecar)
    # Never overwrite either input or an existing result.
    with open(args.output, 'x', encoding='utf-8') as out:
        json.dump(report, out, ensure_ascii=False, indent=2, sort_keys=True)
        out.write('\n')

if __name__ == '__main__': main()
