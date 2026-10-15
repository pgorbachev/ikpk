import { beforeAll, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { parseFragment } from 'parse5';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

type Node = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[];
};

const teachers = Array.from({ length: 10 }, (_, index) => ({
  legacy_id: `teacher-${index + 1}`,
  slug: `teacher-${index + 1}`,
  name: `Преподаватель ${index + 1}, врач`,
  trait: 'teacher',
  photo: `/teacher-${index + 1}.jpg`,
  institute_legacy_id: 'institute-a',
}));
const authors = Array.from({ length: 10 }, (_, index) => ({
  legacy_id: `author-${index + 1}`,
  slug: `author-${index + 1}`,
  name: `Автор методики ${index + 1}`,
  trait: 'method-author',
  photo: `/author-${index + 1}.jpg`,
  institute_legacy_id: 'institute-a',
}));
let fixture = [...teachers, ...authors];

const component = () => import(pathToFileURL(join(import.meta.dirname, '..', 'src', 'components/home/sections/Teachers.astro')).href);

function descendants(node: Node, predicate: (candidate: Node) => boolean): Node[] {
  const result: Node[] = [];
  for (const child of node.childNodes ?? []) {
    if (predicate(child)) result.push(child);
    result.push(...descendants(child, predicate));
  }
  return result;
}

function textContent(node: Node): string {
  return (node.value ?? '') + (node.childNodes ?? []).map(textContent).join('');
}

function attr(node: Node, name: string): string | undefined {
  return node.attrs?.find((item) => item.name === name)?.value;
}

function cardData(section: Node): Array<{ href: string; name: string }> {
  return descendants(section, (node) => node.tagName === 'a' && Boolean(attr(node, 'class')?.split(/\s+/).includes('teacher-card')))
    .map((card) => ({
      href: attr(card, 'href') ?? '',
      name: textContent(descendants(card, (node) => node.tagName === 'span' && Boolean(attr(node, 'class')?.split(/\s+/).includes('teacher-name')))[0] ?? card).trim(),
    }));
}

describe('homepage people sections', () => {
  let Teachers: unknown;

  beforeAll(async () => {
    vi.doMock('../src/lib/data.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/lib/data.js')>(),
      getTeachers: () => fixture,
    }));

    ({ default: Teachers } = await component());
  });

  async function render(people = [...teachers, ...authors]): Promise<string> {
    fixture = people;
    const container = await AstroContainer.create();
    return container.renderToString(Teachers as never);
  }

  function roleSections(html: string): Map<string, Node> {
    const tree = parseFragment(html) as unknown as Node;
    const sections = descendants(tree, (node) => node.tagName === 'section');
    const byHeading = new Map<string, Node>();
    for (const section of sections) {
      const heading = descendants(section, (node) => node.tagName === 'h2')[0];
      if (heading) byHeading.set(textContent(heading).trim(), section);
    }
    return byHeading;
  }

  it('renders two separately named sections with the exact headings', () => {
    return render().then((html) => {
      const sections = roleSections(html);
      expect([...sections.keys()]).toEqual(['Преподаватели', 'Авторы методик']);
    });
  });

  it('shows up to eight people in each role section without filling one role with the other', async () => {
    const sections = roleSections(await render());
    const teacherCards = cardData(sections.get('Преподаватели') ?? ({} as Node));
    const authorCards = cardData(sections.get('Авторы методик') ?? ({} as Node));

    expect(teacherCards).toHaveLength(8);
    expect(authorCards).toHaveLength(8);
    expect(teacherCards.every(({ href }) => href.startsWith('/institute-a/prepodavatel/'))).toBe(true);
    expect(authorCards.every(({ href }) => href.startsWith('/specialisty/'))).toBe(true);
  });

  it('preserves source order, uses the existing role links, and never repeats a card', async () => {
    const sections = roleSections(await render());
    const teacherCards = cardData(sections.get('Преподаватели') ?? ({} as Node));
    const authorCards = cardData(sections.get('Авторы методик') ?? ({} as Node));

    expect(teacherCards.map(({ name, href }) => [name, href])).toEqual(
      teachers.slice(0, 8).map((person) => [person.name.split(',')[0], `/institute-a/prepodavatel/${person.slug}`]),
    );
    expect(authorCards.map(({ name, href }) => [name, href])).toEqual(
      authors.slice(0, 8).map((person) => [person.name.split(',')[0], `/specialisty/${person.slug}`]),
    );
    const allHrefs = [...teacherCards, ...authorCards].map(({ href }) => href);
    expect(new Set(allHrefs).size).toBe(allHrefs.length);
  });

  it('keeps a short role short instead of borrowing cards from the other role', async () => {
    const sections = roleSections(await render([...teachers.slice(0, 3), ...authors]));
    const teacherCards = cardData(sections.get('Преподаватели') ?? ({} as Node));
    const authorCards = cardData(sections.get('Авторы методик') ?? ({} as Node));

    expect(teacherCards.map(({ href }) => href)).toEqual(
      teachers.slice(0, 3).map((person) => `/institute-a/prepodavatel/${person.slug}`),
    );
    expect(authorCards).toHaveLength(8);
    expect(authorCards.every(({ href }) => href.startsWith('/specialisty/'))).toBe(true);
  });
});
