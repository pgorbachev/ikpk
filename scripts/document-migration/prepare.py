#!/usr/bin/env python3
"""Prepare review-only migration proposals; never connect to a database."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path

SNAPSHOT_SHA = 'db77136e25d403c16d0d38b488578a92adcf0b8361b5c2b1afa9dac52346e8ff'
RULES_VERSION = 'documents-2026-11-13-v4'
MANIFEST = Path(__file__).with_name('manifest.json')

class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            href = dict(attrs).get('href')
            if href is not None:
                self.links.append(href)

def doc(name, issuer=None, **kw):
    return {'document': name, 'issuer': issuer, 'issuer_unknown': issuer is None,
            'prior_education': 'unspecified', 'completion_scope': 'unspecified', **kw}

def group_facts(group):
    # Exact facts only; omitted fields are unknown, never inferred from another page.
    medical = doc('Удостоверение о повышении квалификации государственного образца Российской Федерации', prior_education='medical')
    cert_ikpk = doc('Сертификат', 'ООО «ИКПК»')
    testimony = doc('Свидетельство об успешном прохождении обучения', 'ООО «ИКПК»', outcome='completed')
    iahe = [{'name': 'IAHE', 'subject': 'training', 'international': True, 'url': 'https://www.iahe.com/'}]
    nmo = {'status': 'possible', 'url': 'https://edu.rosminzdrav.ru/specialistam/obshchaja-informacija/'}
    result = {'documents_state': 'issued', 'documents': [], 'training_registries': [], 'nmo': None}
    if group in (1, 2, 9):
        institute = 'Институт Барраля' if group == 2 else 'Институт Апледжера'
        result['documents'] = [doc('Сертификат', institute, signed_by='teacher')]
        if group != 9: result['documents'].append(medical)
        result['training_registries'] = iahe
    elif group == 3:
        regulation = '/svedeniya-ob-obrazovatelnoy-organizatsii#section-3'
        result['documents'] = [doc('Удостоверение о повышении квалификации установленного образца', completion_scope='full-cycle', completion_cycle_name='Прикладная Кинезиология', qualification_topic='Прикладные методы мышечного тестирования', hours_mode='actual-completed', hours_may_vary=True, regulation_url=regulation, regulation_issuer='ООО «ИКПК»')]
        for outcome in ('assessment-not-completed', 'assessment-failed', 'partially-completed', 'expelled'):
            result['documents'].append(doc('Справка об обучении или о периоде обучения', outcome=outcome, regulation_url=regulation, regulation_issuer='ООО «ИКПК»', document_on_template=True))
        result['nmo'] = nmo
    elif group == 4:
        result['documents'] = [doc('Сертификат', 'ЧУ ДПО «Институт кинезиологии»', signed_by='teacher')]
    elif group in (5, 15, 16, 17, 18):
        result['documents'] = [testimony]
        if group in (5, 17, 18):
            if group == 18:
                medical['registry'] = [{'name': 'ФИС ФРДО', 'subject': 'document'}]
            result['documents'].append(medical)
        if group == 17: result['nmo'] = nmo
    elif group in (6, 20):
        result['documents'] = [cert_ikpk, doc('Удостоверение о повышении квалификации', prior_education='physical-or-pedagogical', completion_scope='full-cycle', completion_after_seminar_number=4)]
    elif group == 7:
        result['documents'] = [cert_ikpk, medical]
    elif group in (8, 21):
        result['documents'] = [doc('Сертификат участника' if group == 8 else 'Сертификат участия')]
    elif group == 10:
        result['documents_state'] = 'not-issued'
    elif group == 13:
        result['documents'] = [doc('Удостоверение о повышении квалификации установленного образца', completion_required=True), doc('Сертификат по программе: перепрограмиирование нейрорецептроных полей в прикладной кинезиологии', includes_completed_level=True, completion_required=True)]
        result['nmo'] = {'status': 'awarded', 'audience': 'Врачи и средний медицинский персонал', 'purpose': 'аккредитация', 'completion_required': True}
    elif group == 14:
        result['documents'] = [doc('Свидетельство', 'Институт клинической прикладной кинезиологии', signed_by='teacher', completion_scope='course'), doc('Удостоверение о повышении квалификации установленного образца РФ', prior_education='medical')]
    elif group == 19:
        result['documents'] = [cert_ikpk]
    elif group in (11, 12):
        if group == 11:
            label = 'Антистрессовая кинезиология. Уровень 2'
            href = '/institut-klinicheskoy-prikladnoy-kineziologii/psihokineziologiya/antistressovaya-kineziologiya-2'
        else:
            label = 'Кинезиология здоровья. Уровень 2'
            href = '/institut-klinicheskoy-prikladnoy-kineziologii/psihokineziologiya/kineziologiya-zdorovya-2'
        result['documents'] = [doc('Документы', document_type_unspecified=True, completion_scope='other-seminar', other_seminar_label=label, other_seminar_href=href)]
    else:
        raise ValueError(f'Unknown group {group}')
    return result

EXCEPTIONS = {
    3: 'Ссылка в исходнике указывает на соседний раздел; сохранить её без исправления и отдельно проверить назначение.',
}

def prepare(snapshot_bytes, manifest):
    if hashlib.sha256(snapshot_bytes).hexdigest() != SNAPSHOT_SHA:
        raise ValueError('Snapshot SHA-256 mismatch')
    snapshot = json.loads(snapshot_bytes)
    if len(manifest) != 69 or len({x['route'] for x in manifest}) != 69 or len({x['documentId'] for x in manifest}) != 69 or {x['group'] for x in manifest} != set(range(1, 22)):
        raise ValueError('Invalid manifest identities or group coverage')
    output = []
    for entry in manifest:
        route = entry['route']
        html = snapshot.get(route, {}).get('Выдаваемые документы')
        if not isinstance(html, str) or hashlib.sha256(html.encode()).hexdigest() != entry['sourceSha256']:
            raise ValueError(f'Source mismatch: {route}')
        parser = Links(); parser.feed(html)
        item = {**entry, 'sourceHtml': html, 'sourceLinks': parser.links,
                'snapshotSha256': SNAPSHOT_SHA, 'rulesVersion': RULES_VERSION,
                'proposal': group_facts(entry['group']), 'exception': EXCEPTIONS.get(entry['group']),
                'readyForReviewOnly': True, 'eligibleForAutomaticWrite': False}
        output.append(item)
    return output

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('report', type=Path, help='Private destination outside the repository; must not already exist')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    destination = args.report.resolve()
    if destination == repo or repo in destination.parents:
        parser.error('Report must be outside the repository')
    data = prepare(args.snapshot.read_bytes(), json.loads(MANIFEST.read_text()))
    # Exclusive creation protects existing reports; mode restricts access to the owner.
    import os
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=2); f.write('\n')

if __name__ == '__main__': main()
