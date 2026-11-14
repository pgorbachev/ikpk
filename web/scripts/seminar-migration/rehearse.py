#!/usr/bin/env python3
"""Isolated rehearsal only: copy an existing SQLite DB and migrate reviewed content.

Never modifies the input DB. Does not integrate with release runner or authorize a
194/production migration. Reports and database contain content; keep private.
"""
import argparse
import hashlib
import json
import os
import sqlite3
from collections import defaultdict
from pathlib import Path


def sha_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def digest_source(source):
    raw = json.dumps(source, ensure_ascii=False, separators=(',', ':')).encode()
    return hashlib.sha256(raw).hexdigest()


def renderer_fingerprint():
    """Bind evidence to the rendering source, checks and dependency lockfile."""
    web = Path(__file__).resolve().parents[2]
    discovered = list((web / 'src').rglob('*'))
    if any(path.is_symlink() for path in discovered):
        raise ValueError('Renderer source must not contain symlinks')
    # This manifest is regenerated from each independently sealed snapshot.
    paths = [p for p in discovered if p.is_file() and p.relative_to(web).as_posix() != 'src/lib/media-manifest.json']
    paths += [web / name for name in (
        'astro.config.mjs', 'package-lock.json',
        'scripts/seminar-migration/render-audit.ts',
        'scripts/seminar-migration/rehearse.py',
        'tests/seminar-real-migration.migration.test.ts',
        'tests/seminar-separate-fields.migration.test.ts',
    )]
    h = hashlib.sha256()
    for path in sorted(paths, key=lambda x: x.relative_to(web).as_posix()):
        if path.is_symlink():
            raise ValueError('Renderer source must not contain symlinks')
        name = path.relative_to(web).as_posix()
        h.update((name + '\0' + sha_file(path) + '\n').encode())
    return h.hexdigest()


def document_graph(db, entity_id):
    graph = {}
    definitions = {
        'documents': ('seminar.document-record', 'components_seminar_document_records'),
        'training_registries': ('seminar.registry-fact', 'components_seminar_registry_facts'),
        'nmo': ('seminar.nmo-fact', 'components_seminar_nmo_facts'),
    }
    for field, (component_type, table) in definitions.items():
        graph[field] = []
        for item in db.execute('SELECT * FROM seminars_cmps WHERE entity_id=? AND field=? ORDER BY "order", id', (entity_id, field)):
            link = dict(item)
            if link['component_type'] != component_type:
                raise ValueError('Unexpected document component type')
            component = db.execute(f'SELECT * FROM {table} WHERE id=?', (link['cmp_id'],)).fetchone()
            if not component:
                raise ValueError('Missing document component')
            nested = []
            if field == 'documents':
                for edge in db.execute('SELECT * FROM components_seminar_document_records_cmps WHERE entity_id=? ORDER BY "order", id', (link['cmp_id'],)):
                    edge = dict(edge)
                    if edge['component_type'] != 'seminar.registry-fact' or edge['field'] != 'registry':
                        raise ValueError('Unexpected document registry link')
                    row = db.execute('SELECT * FROM components_seminar_registry_facts WHERE id=?', (edge['cmp_id'],)).fetchone()
                    if not row:
                        raise ValueError('Missing document registry')
                    nested.append({'link': edge, 'row': dict(row)})
            graph[field].append({'link': link, 'row': dict(component), 'nested': nested})
    return graph


def document_postimages(db, receipt, expected_digest, expected_plan_digest):
    if not receipt or not expected_digest or receipt.get('digest') != expected_digest:
        raise ValueError('Document receipt is not externally approved')
    payload = receipt.get('payload')
    if not isinstance(payload, dict) or digest_source(payload) != expected_digest or not expected_plan_digest or payload.get('planDigest') != expected_plan_digest:
        raise ValueError('Document receipt digest mismatch')
    ledger = db.execute('SELECT receipt_json,status FROM ikpk_documents_migration_ledger WHERE plan_digest=?', (payload.get('planDigest'),)).fetchone()
    if not ledger or ledger['status'] != 'applied' or json.loads(ledger['receipt_json']) != receipt:
        raise ValueError('Document receipt not in applied ledger')
    result = {}
    for entry in payload.get('entries', []):
        item = entry.get('item', {})
        identity = item.get('documentId')
        if not identity or identity in result or not item.get('approved') or item.get('eligibleForAutomaticWrite') is not True or item.get('readyForReviewOnly') is not False:
            raise ValueError('Unapproved or duplicate document proposal')
        result[identity] = entry
    return result


def load(path):
    with open(path, encoding='utf8') as f:
        return json.load(f)


def route(db, row):
    routes = db.execute('''SELECT DISTINCT i.slug,c.slug FROM seminars_course_group_lnk sc
      JOIN course_groups c ON c.id=sc.course_group_id
      JOIN course_groups_institute_lnk ci ON ci.course_group_id=c.id
      JOIN institutes i ON i.id=ci.institute_id WHERE sc.seminar_id=?''', (row['id'],)).fetchall()
    if len(routes) != 1 or not all(routes[0]) or not row['slug']:
        raise ValueError(f"Non-unique or missing route: {row['id']}")
    path = '/' + '/'.join((*routes[0], row['slug']))
    if '/' + (row['legacy_id'] or '').lstrip('/') != path:
        raise ValueError(f"Legacy route mismatch: {row['id']}")
    return path


def make_plan(db, sources, report, rendered, separate_rendered=(), *, documents_receipt=None,
              expected_documents_receipt_digest=None, expected_documents_plan_digest=None, expected_renderer_sha256=None):
    source_by_id = {e['source']['id']: e['source'] for e in sources}
    report_by_id = {e['id']: e for e in report['entries']}
    if len(source_by_id) != len(sources) or len(report_by_id) != len(report['entries']) or set(source_by_id) != set(report_by_id):
        raise ValueError('Duplicate or incomplete source/audit records')
    if report.get('sidecar_sha256') != 'db77136e25d403c16d0d38b488578a92adcf0b8361b5c2b1afa9dac52346e8ff':
        raise ValueError('Unexpected sidecar digest')
    current_renderer = renderer_fingerprint()
    if expected_renderer_sha256 != current_renderer:
        raise ValueError('Renderer fingerprint has not been independently approved')
    has_documents = any('documents' in e.get('sections', []) for e in report['entries'])
    documents = document_postimages(db, documents_receipt, expected_documents_receipt_digest, expected_documents_plan_digest) if has_documents else {}
    render_by_id = {e['id']: e for e in rendered}
    if len(render_by_id) != len(rendered):
        raise ValueError('Duplicate actual-render results')
    separate_by_id = {e['id']: e for e in separate_rendered}
    if len(separate_by_id) != len(separate_rendered):
        raise ValueError('Duplicate separate-field render results')
    pairs = defaultdict(dict)
    for s in source_by_id.values():
        if s['version'] in pairs[(s['document_id'], s['locale'])]:
            raise ValueError('Duplicate physical version')
        pairs[(s['document_id'], s['locale'])][s['version']] = s
    planned = []
    exclusions = []
    for key, pair in pairs.items():
        if set(pair) != {'draft', 'published'}:
            exclusions.append({'document_id': key[0], 'reason': 'missing-version'}); continue
        draft, pub = pair['draft'], pair['published']
        equivalent = ('path', 'description', 'full_text', 'learning_plan', 'learning_mode', 'recommendations')
        if any(draft.get(k) != pub.get(k) for k in equivalent):
            exclusions.append({'document_id': key[0], 'reason': 'draft-published-content-differs'}); continue
        separate = any(str(pub.get(k) or '').strip() for k in ('learning_plan','learning_mode','recommendations'))
        published_audit = report_by_id[pub['id']]
        accepted = {'additional-legacy-anchors-need-support', 'documents-require-separate-structured-review'}
        if set(published_audit.get('reasons', [])) - accepted:
            exclusions.append({'document_id': key[0], 'reason': 'audit-exception'}); continue
        if separate and (published_audit.get('sections') or pub.get('full_text') or pub.get('recommendations')):
            exclusions.append({'document_id': key[0], 'reason': 'unsupported-existing-separate-content'}); continue
        rendered_row = (separate_by_id if separate else render_by_id).get(pub['id'])
        if not rendered_row or rendered_row['path'] != pub['path'] or rendered_row['errors']:
            exclusions.append({'document_id': key[0], 'reason': 'actual-render-not-verified'}); continue
        if rendered_row.get('entry') != published_audit or rendered_row.get('rendererSha256') != current_renderer:
            raise ValueError(f"Renderer evidence does not match target: {pub['id']}")
        if 'documents' in published_audit['sections']:
            documented = documents.get(pub['document_id'])
            if not documented or documented['item'].get('route') != pub['path'] or rendered_row.get('documentProposal') != documented['item'].get('proposal'):
                raise ValueError('Renderer document proposal does not match approved receipt')
            postimages = documented.get('postimage', [])
            if len(postimages) != 2:
                raise ValueError('Document receipt must cover both physical versions')
            for original in (pub, draft):
                matches = [v for v in postimages if v.get('row', {}).get('id') == original['id']]
                row = db.execute('SELECT * FROM seminars WHERE id=?', (original['id'],)).fetchone()
                if not row or len(matches) != 1 or matches[0] != {'row': dict(row), 'route': route(db, row), 'graph': document_graph(db, original['id'])}:
                    raise ValueError('Document postimage changed since review')
        elif rendered_row.get('documentProposal') is not None:
            raise ValueError('Unexpected document proposal')
        for source in (pub, draft):
            audit = report_by_id[source['id']]
            if audit.get('source_sha256') != digest_source(source):
                raise ValueError(f"Source fingerprint mismatch: {source['id']}")
            if audit.get('sections') != published_audit['sections'] or audit.get('fields') != published_audit['fields'] or audit.get('ids') != published_audit['ids'] or audit.get('aliases') != published_audit['aliases']:
                raise ValueError(f"Draft/published renderer mismatch: {source['id']}")
            row = db.execute('SELECT * FROM seminars WHERE id=?', (source['id'],)).fetchone()
            if not row:
                raise ValueError('Missing database source')
            for field in ('document_id', 'locale', 'description', 'full_text', 'learning_plan', 'learning_mode', 'recommendations'):
                if row[field] != source.get(field):
                    raise ValueError(f"Database field changed: {source['id']} {field}")
            if ('published' if row['published_at'] else 'draft') != source['version'] or route(db, row) != source['path']:
                raise ValueError(f"Database version or route changed: {source['id']}")
            if row['content_format'] not in (None, 'legacy') or row['audience'] or row['content_section_anchors']:
                raise ValueError(f"Existing structured content: {source['id']}")
            if 'documents' in audit['sections'] and row['documents_state'] not in ('issued','not-issued'):
                raise ValueError(f"Structured documents missing from copy: {source['id']}")
            anchors = {k: [*audit['aliases'].get(k, []), audit['ids'][k]] for k in audit['sections']}
            fields = audit['fields']
            post = {'content_format': 'structured', 'content_section_anchors': json.dumps(anchors, ensure_ascii=False, separators=(',', ':'))}
            if not separate:
                post.update({'description': fields['description'], 'full_text': None, 'audience': fields.get('audience'),
                             'learning_plan': fields.get('learning_plan'), 'learning_mode': fields.get('learning_mode'),
                             'recommendations': fields.get('recommendations')})
            planned.append({'id': source['id'], 'document_id': source['document_id'], 'version': source['version'],
                            'path': source['path'], 'source': source, 'preimage': dict(row), 'post': post,
                            'separate': separate, 'reviewEvidence': rendered_row})
    return planned, exclusions


def main():
    p = argparse.ArgumentParser(); p.add_argument('source_db'); p.add_argument('source_json'); p.add_argument('report_json'); p.add_argument('render_json'); p.add_argument('separate_render_json'); p.add_argument('output_db'); p.add_argument('receipt')
    p.add_argument('--documents-receipt'); p.add_argument('--expected-documents-receipt-digest'); p.add_argument('--expected-documents-plan-digest'); p.add_argument('--expected-renderer-sha256', required=True); p.add_argument('--plan-output')
    a = p.parse_args()
    if os.path.realpath(a.source_db) == os.path.realpath(a.output_db):
        raise ValueError('Source and output must differ')
    sources, report, rendered, separate_rendered = load(a.source_json), load(a.report_json), load(a.render_json), load(a.separate_render_json)
    source = sqlite3.connect('file:' + os.path.abspath(a.source_db) + '?mode=ro', uri=True); source.row_factory = sqlite3.Row
    documents_receipt = load(a.documents_receipt) if a.documents_receipt else None
    plan, exceptions = make_plan(source, sources, report, rendered, separate_rendered,
        documents_receipt=documents_receipt, expected_documents_receipt_digest=a.expected_documents_receipt_digest,
        expected_documents_plan_digest=a.expected_documents_plan_digest, expected_renderer_sha256=a.expected_renderer_sha256)
    if not plan:
        raise ValueError('Nothing verified to rehearse')
    if a.plan_output and exceptions:
        raise ValueError('Content exceptions must be resolved before sealing a migration plan')
    fd = os.open(a.output_db, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600); os.close(fd)
    target = sqlite3.connect(a.output_db)
    try:
        source.backup(target)
        target.row_factory = sqlite3.Row
        target.execute('BEGIN IMMEDIATE')
        for item in plan:
            row = target.execute('SELECT * FROM seminars WHERE id=?', (item['id'],)).fetchone()
            if dict(row) != item['preimage']:
                raise ValueError('Copied database changed')
            post = item['post']; fields = list(post)
            target.execute('UPDATE seminars SET ' + ','.join('"' + k + '"=?' for k in fields) + ' WHERE id=?', [post[k] for k in fields] + [item['id']])
            actual = dict(target.execute('SELECT * FROM seminars WHERE id=?', (item['id'],)).fetchone())
            expected = dict(item['preimage']); expected.update(post)
            if actual != expected:
                raise ValueError('Unexpected postimage')
        if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or target.execute('PRAGMA foreign_key_check').fetchone() is not None:
            raise ValueError('Database integrity check failed')
        target.commit()
        receipt = {'kind': 'local-rehearsal-only', 'input_sha256': {k: sha_file(getattr(a, k)) for k in ('source_db','source_json','report_json','render_json','separate_render_json')},
                   'count_versions': len(plan), 'count_seminars': len(plan)//2, 'entries': plan, 'exceptions': exceptions}
        with open(a.receipt, 'x', encoding='utf8') as f:
            os.chmod(a.receipt, 0o600); json.dump(receipt, f, ensure_ascii=False, indent=2)
        if a.plan_output:
            payload = {'version': 1, 'entries': plan, 'rendererSha256': a.expected_renderer_sha256,
                       'documentsReceiptDigest': a.expected_documents_receipt_digest,
                       'documentsPlanDigest': a.expected_documents_plan_digest,
                       'inputSha256': receipt['input_sha256']}
            with open(a.plan_output, 'x', encoding='utf8') as f:
                os.chmod(a.plan_output, 0o600); json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
        print(json.dumps({'versions':len(plan),'seminars':len(plan)//2,'exceptions':len(exceptions)}))
    except BaseException:
        target.rollback(); raise
    finally:
        target.close(); source.close()


if __name__ == '__main__': main()
