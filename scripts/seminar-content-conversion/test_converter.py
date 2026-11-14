"""Contract tests for version-isolated, loss-aware seminar conversion.

Synthetic content uses the Radix shape recorded in web/tests/html-cleaner.test.ts.
A matching hash binds inputs but does not itself prove sidecar provenance.
"""
import copy
import hashlib
import importlib.util
import json
from html.parser import HTMLParser
from pathlib import Path
import unittest

MODULE = Path(__file__).with_name('converter.py')


def fingerprint(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(raw).hexdigest()


def source(description, version='published'):
    return {'document_id': 'seminar-test', 'version': version, 'path': '/example/seminar',
            'description': description, 'full_text': None, 'learning_plan': None,
            'learning_mode': None, 'recommendations': None}


def panel(title, body=None):
    content = '' if body is None else f'<div class="collapsible_content__x" data-state="open">{body}</div>'
    return (f'<div data-state="closed"><button class="collapsible_trigger__x">'
            f'<h2 data-collapsible-title="true">{title}</h2></button>{content}</div>')


def pinned(record, titles):
    panels = {record['path']: titles}
    return {'panels': panels, 'pin': {'source_sha256': fingerprint(record), 'panels_sha256': fingerprint(panels)}}


class Content(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.text, self.links, self.media, self.tags = [], [], [], []
        self.feed(html or '')

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.tags.append(tag)
        if tag == 'a': self.links.append(attrs.get('href'))
        if tag in ('img', 'video', 'audio', 'source', 'iframe'):
            self.media.append((tag, attrs.get('src')))

    def handle_data(self, text):
        if text.strip(): self.text.append(text.strip())


class ConversionContract(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('seminar_converter', MODULE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.convert = module.convert

    def ready(self, record, sidecar):
        result = self.convert(copy.deepcopy(record), copy.deepcopy(sidecar))
        self.assertEqual(result['status'], 'ready', result)
        return result

    def blocked(self, record, sidecar):
        result = self.convert(copy.deepcopy(record), copy.deepcopy(sidecar))
        self.assertEqual(result['status'], 'blocked', result)
        self.assertTrue(result.get('reasons'), result)
        self.assertFalse(result.get('fields'), 'A blocked plan must not expose partial fields for application')

    def test_intro_and_all_semantic_sections_preserve_text_links_media_and_anchors(self):
        record = source('<p>Введение <a href="/read">Читать</a>.</p>' + ''.join(panel(x) for x in
            ('Для кого подойдет', 'Учебный план', 'Как проходит обучение', 'Рекомендации')))
        sidecar = pinned(record, {
            'Для кого подойдет': '<p>Для врачей и студентов.</p>',
            'Учебный план': '<ul><li>Анатомия <a href="/read">подробно</a></li><li>Практика <a href="/read">подробно</a></li></ul><img src="/uploads/anatomy.png" alt="Схема">',
            'Как проходит обучение': '<p>Очно и <strong>дистанционно</strong>.</p>',
            'Рекомендации': '<p>Подготовка заранее.</p>',
            'Компания': '<p>Посторонняя навигация</p>',
        })
        result = self.ready(record, sidecar)
        fields = result['fields']
        self.assertIn('Введение', ' '.join(Content(fields['description']).text))
        self.assertIn('/read', Content(fields['description']).links)
        self.assertIn('Для врачей и студентов.', Content(fields['audience']).text)
        plan = Content(fields['learning_plan'])
        self.assertEqual(plan.links, ['/read', '/read'])
        self.assertEqual(plan.media, [('img', '/uploads/anatomy.png')])
        self.assertEqual(plan.tags.count('li'), 2)
        self.assertIn('дистанционно', Content(fields['learning_mode']).text)
        self.assertIn('Подготовка заранее.', Content(fields['recommendations']).text)
        self.assertNotIn('Посторонняя навигация', json.dumps(fields, ensure_ascii=False))
        self.assertEqual(result['anchors'], {'#section-1': '#audience', '#section-2': '#learning-plan',
                                              '#section-3': '#learning-mode', '#section-4': '#recommendations'})

    def test_embedded_content_wins_over_sidecar(self):
        record = source('<p>Вступление</p>' + panel('Учебный план', '<p>Встроенная программа</p>'))
        result = self.ready(record, pinned(record, {'Учебный план': '<p>Устаревшая программа</p>'}))
        text = ' '.join(Content(result['fields']['learning_plan']).text)
        self.assertIn('Встроенная программа', text)
        self.assertNotIn('Устаревшая программа', text)

    def test_missing_or_unmatched_sidecar_blocks_closed_panel(self):
        record = source('<p>Вступление</p>' + panel('Учебный план'))
        self.blocked(record, None)
        self.blocked(record, pinned(record, {'Для кого подойдет': '<p>Не тот раздел</p>'}))

    def test_draft_cannot_use_published_version_pin(self):
        published = source(panel('Учебный план'), 'published')
        draft = source(panel('Учебный план'), 'draft')
        self.blocked(draft, pinned(published, {'Учебный план': '<p>Опубликованный текст</p>'}))
        changed = copy.deepcopy(published)
        changed['description'] += '<p>Изменённый текст</p>'
        self.blocked(changed, pinned(published, {'Учебный план': '<p>Старый текст</p>'}))

    def test_published_and_draft_convert_only_their_own_content(self):
        published = source('<p>Публичное вступление</p>' + panel('Учебный план'), 'published')
        draft = source('<p>Секретная черновая правка</p>' + panel('Учебный план'), 'draft')
        public_result = self.ready(published, pinned(published, {'Учебный план': '<p>Публичная программа</p>'}))
        draft_result = self.ready(draft, pinned(draft, {'Учебный план': '<p>Черновая программа</p>'}))
        public_text = json.dumps(public_result, ensure_ascii=False)
        self.assertIn('Публичная программа', public_text)
        self.assertNotIn('Черновая программа', public_text)
        self.assertNotIn('Секретная черновая правка', public_text)
        self.assertIn('Черновая программа', json.dumps(draft_result, ensure_ascii=False))

    def test_tampered_sidecar_is_rejected(self):
        record = source(panel('Учебный план'))
        sidecar = pinned(record, {'Учебный план': '<p>Оригинал</p>'})
        sidecar['panels'][record['path']]['Учебный план'] = '<p>Подмена</p>'
        self.blocked(record, sidecar)

    def test_unknown_section_element_and_documents_block(self):
        for fragment in (panel('Неизвестный раздел', '<p>Не терять</p>'),
                         '<p>Текст</p><custom-widget>Не терять</custom-widget>',
                         panel('Выдаваемые документы', '<p>Сертификат</p>')):
            with self.subTest(fragment=fragment):
                record = source(fragment)
                self.blocked(record, pinned(record, {}))

    def test_existing_content_fields_are_not_overwritten(self):
        for key in ('full_text', 'learning_plan', 'learning_mode', 'recommendations'):
            with self.subTest(field=key):
                record = source('<p>Введение</p>' + panel('Учебный план', '<p>Программа</p>'))
                record[key] = '<p>Ранее сохранённое содержимое</p>'
                self.blocked(record, pinned(record, {}))

    def test_repeatable_and_inputs_unchanged(self):
        record = source('<p>Введение</p>' + panel('Для кого подойдет'))
        sidecar = pinned(record, {'Для кого подойдет': '<p>Врачи</p>'})
        original = copy.deepcopy((record, sidecar))
        first = self.ready(record, sidecar)
        second = self.ready(record, sidecar)
        self.assertEqual(first, second)
        self.assertEqual((record, sidecar), original)


if __name__ == '__main__':
    unittest.main()
