/**
 * Закрытый selector list из spec `rich-content-safety`.
 * Расширение списка — изменение capability, не тестовая вольность.
 */

export interface JsonSelector {
  id: string;
  file: string;
  field: string | null;
  kind: 'record-field' | 'all-strings';
}

export const JSON_SELECTORS: JsonSelector[] = [
  { id: 'articles[*].body_html', file: 'articles.json', field: 'body_html', kind: 'record-field' },
  {
    id: 'course_groups[*].description_html',
    file: 'course_groups.json',
    field: 'description_html',
    kind: 'record-field',
  },
  {
    id: 'institutes[*].description_html',
    file: 'institutes.json',
    field: 'description_html',
    kind: 'record-field',
  },
  {
    id: 'seminars[*].description_html',
    file: 'seminars.json',
    field: 'description_html',
    kind: 'record-field',
  },
  { id: 'static_pages[*].body_html', file: 'static_pages.json', field: 'body_html', kind: 'record-field' },
  { id: 'teachers[*].bio_html', file: 'teachers.json', field: 'bio_html', kind: 'record-field' },
  {
    id: 'video_playlists[*].description_html',
    file: 'video_playlists.json',
    field: 'description_html',
    kind: 'record-field',
  },
  { id: 'news[*].description', file: 'news.json', field: 'description', kind: 'record-field' },
  { id: 'promotions[*].description', file: 'promotions.json', field: 'description', kind: 'record-field' },
  {
    id: 'collapsible_panels.json',
    file: 'collapsible_panels.json',
    field: null,
    kind: 'all-strings',
  },
];

export interface CmsRichtextSelector {
  id: string;
  singularName: string;
  attr: string;
  jsonFile: string | null;
  jsonField: string | null;
}

export const CMS_RICHTEXT_SELECTORS: CmsRichtextSelector[] = [
  { id: 'cms:article.body', singularName: 'article', attr: 'body', jsonFile: 'articles.json', jsonField: 'body_html' },
  {
    id: 'cms:course-group.description',
    singularName: 'course-group',
    attr: 'description',
    jsonFile: 'course_groups.json',
    jsonField: 'description_html',
  },
  {
    id: 'cms:institute.description',
    singularName: 'institute',
    attr: 'description',
    jsonFile: 'institutes.json',
    jsonField: 'description_html',
  },
  {
    id: 'cms:news-item.description',
    singularName: 'news-item',
    attr: 'description',
    jsonFile: 'news.json',
    jsonField: 'description',
  },
  { id: 'cms:page.body', singularName: 'page', attr: 'body', jsonFile: 'static_pages.json', jsonField: 'body_html' },
  {
    id: 'cms:promotion.description',
    singularName: 'promotion',
    attr: 'description',
    jsonFile: 'promotions.json',
    jsonField: 'description',
  },
  {
    id: 'cms:schedule-entry.description',
    singularName: 'schedule-entry',
    attr: 'description',
    jsonFile: 'schedule_entries.json',
    jsonField: 'description',
  },
  {
    id: 'cms:schedule-entry.additionalText',
    singularName: 'schedule-entry',
    attr: 'additionalText',
    jsonFile: 'schedule_entries.json',
    jsonField: 'additionalText',
  },
  {
    id: 'cms:seminar.description',
    singularName: 'seminar',
    attr: 'description',
    jsonFile: 'seminars.json',
    jsonField: 'description_html',
  },
  {
    id: 'cms:seminar.full_text',
    singularName: 'seminar',
    attr: 'full_text',
    jsonFile: 'seminars.json',
    jsonField: null,
  },
  { id: 'cms:teacher.bio', singularName: 'teacher', attr: 'bio', jsonFile: 'teachers.json', jsonField: 'bio_html' },
];

export const ALL_SELECTOR_IDS = [
  ...JSON_SELECTORS.map((s) => s.id),
  ...CMS_RICHTEXT_SELECTORS.map((s) => s.id),
];
