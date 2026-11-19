import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { digestTree } from '../../scripts/publication-launcher.mjs';
import { artifactFiles } from './publication-context.ts';
import { contentFingerprint, snapshotId, type Snapshot } from './lib/content-snapshot.ts';
import { getScheduleEntries, getSeminarPagePaths, scheduleBelongsToSeminar } from '../src/lib/data.ts';
import { safeHref } from '../src/lib/safe-href.ts';
import { isBeforeStart } from '../src/lib/schedule-window.ts';
import { DEMO193_ORIGIN } from './demo193-profile.mjs';

type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];
const schedule = 'raspisanie-i-tseny/index.html';
const occurrence = 'data-schedule-occurrence';
const registration = 'data-registration-occurrence';
const attr = (node: Element, name: string) => node.attrs.find((item) => item.name === name)?.value;
const classes = (node: Element) => (attr(node, 'class') ?? '').split(/\s+/);

function* elements(node: Node): Generator<Element> {
  if ('tagName' in node) yield node;
  if ('childNodes' in node) for (const child of node.childNodes) yield* elements(child);
  if ('content' in node) yield* elements(node.content as Node);
}

function ancestorWith(node: Element, name: string): Element | undefined {
  for (let parent = node.parentNode; parent; parent = 'parentNode' in parent ? parent.parentNode : null) {
    if ('tagName' in parent && attr(parent, name) !== undefined) return parent;
  }
}

function elementText(node: Node): string {
  if ('value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(elementText).join(' ') : '';
}

function parseLink(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value, DEMO193_ORIGIN);
  } catch {
    return null;
  }
}

function isRegistrationLabel(node: Element): boolean {
  const caption = attr(node, 'aria-label') ?? elementText(node);
  return /^(?:записаться|зарегистрироваться|(?:подать|отправить) заявку)(?:[\s.!]|$)/i
    .test(caption.replace(/\s+/g, ' ').trim());
}

function linkedPage(links: Map<string, string>, occurrences: Map<string, string>, id: number, start: string, href: string) {
  if (!Number.isSafeInteger(id) || id <= 0 || occurrences.has(String(id))) throw new Error('invalid or duplicate snapshot occurrence');
  occurrences.set(String(id), start);
  if (href) links.set(String(id), href);
}

function checkHtml(root: string, files: string[], now: Date, snapshot: Snapshot) {
  const sourceLinks = new Map(snapshot.content.types.schedule_entries.map((entry) =>
    [entry.id, typeof entry.registrationFormLink === 'string' ? safeHref(entry.registrationFormLink) : '']));
  const routes = new Map<string, { links: Map<string, string>; occurrences: Map<string, string> }>();
  const entries = getScheduleEntries();
  const active = entries.filter((entry) => entry.status === 'active' && isBeforeStart(entry, now));
  const scheduleLinks = { links: new Map<string, string>(), occurrences: new Map<string, string>() };
  for (const entry of active) linkedPage(scheduleLinks.links, scheduleLinks.occurrences, entry.id, entry.startAt, sourceLinks.get(entry.id) ?? '');
  routes.set(schedule, scheduleLinks);
  for (const { seminar, courseGroup, institute } of getSeminarPagePaths()) {
    const file = `${institute.slug}/${courseGroup.slug}/${seminar.slug}/index.html`;
    if (routes.has(file)) throw new Error(`duplicate snapshot route ${file}`);
    const seminarLinks = { links: new Map<string, string>(), occurrences: new Map<string, string>() };
    for (const entry of active.filter((item) => scheduleBelongsToSeminar(item, seminar))) {
      linkedPage(seminarLinks.links, seminarLinks.occurrences, entry.id, entry.startAt,
        sourceLinks.get(entry.id) || '/raspisanie-i-tseny');
    }
    routes.set(file, seminarLinks);
  }
  const knownExternal = new Set([...sourceLinks.values()]
    .filter((href) => /^https?:\/\//i.test(href)));
  const robots = readFileSync(join(root, 'robots.txt'), 'utf8').split(/\r?\n/)
    .map((line) => line.split('#', 1)[0].trim()).filter(Boolean);
  if (robots.join('\n') !== 'User-agent: *\nDisallow: /') throw new Error('staging194 crawl rules are not closed');
  for (const file of files.filter((name) => name.endsWith('.html'))) {
    const html = readFileSync(join(root, file), 'utf8');
    const expected = routes.get(file);
    const foundRows = new Set<string>();
    const foundLinks = new Set<string>();
    const pageRoute = file === '404.html' ? '/404' : file.endsWith('index.html')
      ? ('/' + file.slice(0, -'index.html'.length)).replace(/(.)\/$/, '$1') : null;
    const canonicals: (string | undefined)[] = [];
    const robotsDirectives: (string | undefined)[] = [];
    let banner = 0;
    if (/mc\.yandex\.ru\/(?:metrika\/|watch\/39506315)|top-fwz1\.mail\.ru\//i.test(html)) {
      throw new Error(`${file}: forbidden staging194 integration`);
    }
    for (const node of elements(parse(html, { scriptingEnabled: false }))) {
      const row = attr(node, occurrence);
      if (row !== undefined) {
        const expectedRowKind = file === schedule ? 'data-schedule-item' : 'data-seminar-schedule-card';
        if (attr(node, expectedRowKind) === undefined || foundRows.has(row)
            || expected?.occurrences.get(row) !== attr(node, 'data-start-at') || !expected?.occurrences.has(row)) {
          throw new Error(`${file}: unexpected occurrence ${row}`);
        }
        foundRows.add(row);
      }
      const id = attr(node, registration);
      const boundRow = ancestorWith(node, occurrence);
      const isCta = node.tagName === 'a' && (classes(node).includes('seminar-register-link') ||
        (boundRow && file === schedule && classes(node).includes('btn-primary')));
      const href = attr(node, 'href');
      const target = parseLink(href);
      const offSite = target && /^https?:$/.test(target.protocol) && target.origin !== DEMO193_ORIGIN;
      const unmarkedRegistration = node.tagName === 'a' && (boundRow || offSite) && isRegistrationLabel(node);
      if (node.attrs.some(({ name }) => /^(?:data-chat-(?:loader-src|trigger)|data-payment-(?:form|endpoint))$/.test(name))) {
        throw new Error(`${file}: forbidden staging194 integration`);
      }
      if (id !== undefined || isCta || unmarkedRegistration) {
        if (!isCta || id === undefined || !boundRow || attr(boundRow, occurrence) !== id || foundLinks.has(id)
            || expected?.links.get(id) !== href || !expected?.links.has(id)) {
          throw new Error(`${file}: unexpected registration CTA for occurrence ${id ?? 'unknown'}`);
        }
        foundLinks.add(id);
      }
      for (const { name, value } of node.attrs) {
        if (!/(?:href|src|action)$/.test(name)) continue;
        if (isCta && name === 'href') continue;
        const host = parseLink(value)?.hostname ?? '';
        if (/(?:^|\.)bitrix24(?:site)?\.ru$/i.test(host) || knownExternal.has(value)) {
          throw new Error(`${file}: registration URL outside its approved CTA`);
        }
      }
      if (node.tagName === 'link' && attr(node, 'rel')?.toLowerCase().split(/\s+/).includes('canonical')) {
        canonicals.push(attr(node, 'href'));
      }
      if (node.tagName === 'meta' && attr(node, 'name')?.toLowerCase() === 'robots') {
        robotsDirectives.push(attr(node, 'content'));
      }
      if (expected && attr(node, 'data-demo-banner') !== undefined) {
        const bannerText = elementText(node);
        if (bannerText.includes('ссылки записи на семинары действуют') &&
            bannerText.includes('Остальные формы заявки ведут на заглушки')) banner++;
      }
    }
    if (pageRoute !== null && (canonicals.length !== 1 || canonicals[0] !== DEMO193_ORIGIN + pageRoute ||
        robotsDirectives.length !== 1 || robotsDirectives[0] !== 'noindex, nofollow')) {
      throw new Error(`${file}: invalid staging194 canonical or robots metadata`);
    }
    if (expected) {
      if (foundRows.size !== expected.occurrences.size || foundLinks.size !== expected.links.size || banner !== 1) {
        throw new Error(`${file}: incomplete occurrence CTA or staging194 metadata`);
      }
      routes.delete(file);
    }
  }
  if (routes.size) throw new Error('staging194 candidate is missing schedule or seminar pages');
}

const [mode, tree, snapshotDirectory, expectedSha, buildNow, expectedTreeDigest] = process.argv.slice(2);
if ((mode !== 'check' && mode !== 'confirm') || !tree || !snapshotDirectory || !/^[a-f0-9]{64}$/.test(expectedSha ?? '')
    || !buildNow || Number.isNaN(Date.parse(buildNow)) || (mode === 'confirm' && !/^[a-f0-9]{64}$/.test(expectedTreeDigest ?? ''))) {
  throw new Error('invalid staging194 registration check arguments');
}
const snapshotPath = join(snapshotDirectory, 'snapshot.json');
const root = resolve(tree);
const readSnapshot = () => {
  const buffer = readFileSync(snapshotPath);
  if (createHash('sha256').update(buffer).digest('hex') !== expectedSha) throw new Error('staging194 snapshot bytes changed');
  return JSON.parse(buffer.toString('utf8')) as Snapshot;
};
const snapshot = readSnapshot();
const release = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
if (!snapshot.fingerprint || !snapshot.snapshotId || snapshot.snapshotId !== release.snapshotId ||
    snapshot.fingerprint !== contentFingerprint(snapshot.content) || snapshot.snapshotId !== snapshotId({
      fingerprint: snapshot.fingerprint, referenceDate: snapshot.referenceDate, contractVersion: snapshot.contractVersion,
    })) throw new Error('staging194 snapshot identity does not match candidate');
const treeDigest = () => digestTree(root, artifactFiles(root));
const before = await treeDigest();
if (mode === 'check') {
  process.env.CONTENT_SNAPSHOT_DIR = resolve(snapshotDirectory);
  checkHtml(root, artifactFiles(root), new Date(buildNow), snapshot);
  if (await treeDigest() !== before) throw new Error('staging194 candidate changed during registration check');
} else if (before !== expectedTreeDigest) {
  throw new Error('staging194 checked candidate changed before switch');
}
readSnapshot();
console.log(before);
