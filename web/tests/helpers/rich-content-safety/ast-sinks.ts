import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parse as parseAstro } from '@astrojs/compiler';
import { WEB_SRC } from './paths.js';

export interface AstroNode {
  type: string;
  name?: string;
  value?: string;
  attributes?: { name: string; kind: string; value: string }[];
  children?: AstroNode[];
  position?: { start?: { line?: number; column?: number; offset?: number } };
}

export interface SinkRecord {
  id: string;
  classification: 'rich-html' | 'json-ld' | 'innerhtml-clear';
  file: string;
  nodeKind: string;
  elementName: string;
  attribute: string;
  expression: string;
  attrKind?: string;
  locator: string;
  fingerprint: string;
}

function* walkFiles(dir: string, suffixes: string[]): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-demo') continue;
      yield* walkFiles(full, suffixes);
    } else if (suffixes.some((s) => full.endsWith(s))) yield full;
  }
}

function locOf(node: AstroNode): string {
  const start = node.position?.start;
  return start ? `L${start.line ?? 0}:C${start.column ?? 0}` : 'L?:C?';
}

function walkAstro(node: AstroNode, visit: (n: AstroNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkAstro(child, visit);
}

export async function collectAstroSinksFromSource(rel: string, src: string): Promise<SinkRecord[]> {
  const sinks: SinkRecord[] = [];
  const { ast } = await parseAstro(src);
  walkAstro(ast as AstroNode, (node) => {
    const attrs = node.attributes ?? [];
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      const onIframe = (node.name ?? '').toLowerCase() === 'iframe';
      const spreadSrcdoc =
        attr.kind === 'spread' && (onIframe || /srcdoc/i.test(attr.value) || /srcdoc/i.test(attr.name));
      const attrName = spreadSrcdoc ? 'srcdoc' : name;
      if (attrName === 'set:html' || attrName === 'is:raw' || attrName === 'srcdoc') {
        const classification =
          rel === 'components/HeadMeta.astro' || rel === 'components/Breadcrumbs.astro'
            ? 'json-ld'
            : 'rich-html';
        const locator = `${rel}:${locOf(node)}:${node.type}:${node.name ?? ''}:${attrName}`;
        sinks.push({
          id: sinkIdFor(rel, attrName, attr.value),
          classification,
          file: rel,
          nodeKind: node.type,
          elementName: node.name ?? '',
          attribute: attrName,
          expression: attr.value,
          attrKind: attr.kind,
          locator,
          fingerprint: locator,
        });
      }
    }
  });
  return sinks;
}

export async function collectAstroSinks(srcRoot = WEB_SRC): Promise<SinkRecord[]> {
  const sinks: SinkRecord[] = [];
  for (const file of walkFiles(srcRoot, ['.astro'])) {
    const src = readFileSync(file, 'utf-8');
    const rel = relative(srcRoot, file).replaceAll('\\', '/');
    sinks.push(...(await collectAstroSinksFromSource(rel, src)));
  }
  sinks.sort((a, b) => a.locator.localeCompare(b.locator));
  return sinks;
}

export const JSON_LD_FILES = new Set(['components/HeadMeta.astro', 'components/Breadcrumbs.astro']);
export const FUTURE_SINGLETON = 'components/RichContent.astro';

export function assertSingletonSinkContract(sinks: SinkRecord[]): string[] {
  const errors: string[] = [];
  for (const sink of sinks) {
    if (sink.attribute === 'is:raw' || sink.attribute === 'srcdoc') {
      errors.push(`запрещённый ${sink.attribute} (${sink.locator})`);
      continue;
    }
    if (sink.attribute !== 'set:html') continue;
    if (sink.file === FUTURE_SINGLETON || JSON_LD_FILES.has(sink.file)) continue;
    errors.push(`set:html вне singleton/JSON-LD: ${sink.file}`);
  }
  return errors;
}

function sinkIdFor(file: string, attr: string, expr: string): string {
  if (file === 'components/HeadMeta.astro') return 'json-ld-head-meta';
  if (file === 'components/Breadcrumbs.astro') return 'json-ld-breadcrumbs';
  if (file === 'pages/statyi/[slug].astro') return 'article-body';
  if (file === 'pages/[institute].astro') return 'institute-extra';
  if (file === 'pages/[institute]/[courseGroup].astro') return 'course-group-extra';
  if (file === 'pages/[institute]/[courseGroup]/[seminar].astro') return 'seminar-body';
  if (file === 'pages/[institute]/prepodavatel/[id].astro') return 'teacher-bio';
  if (file === 'pages/oplata.astro') return 'static-page-oplata';
  if (file === 'pages/sotrudnichestvo-s-nami.astro') return 'static-page-sotrudnichestvo';
  if (file === 'pages/svedeniya-ob-obrazovatelnoy-organizatsii.astro') {
    return 'static-page-svedeniya';
  }
  if (file === 'pages/aktsii-i-skidki.astro') return 'promo-description';
  if (file === 'components/home/sections/News.astro') return 'news-description';
  if (file === 'pages/preview/[variant]/seminar.astro') return 'preview-seminar-body';
  if (file === 'pages/preview/[variant]/seminar-undated.astro') return 'preview-seminar-undated-body';
  if (file === 'components/seminars/SeminarArchitectureHeader.astro') {
    return 'seminar-architecture-header';
  }
  if (file === 'pages/rich-content-canary.astro') return 'canary-body';
  if (file === 'components/RichContent.astro') return 'rich-content-singleton';
  return `${file}:${attr}:${expr.slice(0, 40)}`;
}

export interface TsSinkRecord {
  file: string;
  kind: string;
  text: string;
  locator: string;
  allowedEmptyClear: boolean;
}

const ALLOWED_EMPTY_INNERHTML = new Set([
  'pages/statyi/index.astro:pagination.innerHTML = \'\'',
  'pages/statyi/index.astro:grid.innerHTML = \'\'',
  'components/schedule/ScheduleControlsScript.astro:program.innerHTML = \'\'',
  'components/schedule/ScheduleControlsScript.astro:pagination.innerHTML = \'\'',
]);

function frontmatterOf(src: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  return m ? m[1] : '';
}

function collectTsRawSinksFromSource(file: string, sourceText: string, scriptKind: ts.ScriptKind): TsSinkRecord[] {
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const found: TsSinkRecord[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const el of node.importClause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).getText(sf);
        if (imported !== 'authenticate') continue;
        const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push({
          file,
          kind: 'SafeRichHtml-factory',
          text: node.getText(sf),
          locator: `${file}:L${loc.line + 1}:C${loc.character + 1}:authenticate`,
          allowedEmptyClear: false,
        });
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left.getText(sf);
      if (/\.(innerHTML|outerHTML)$/.test(left)) {
        const right = node.right.getText(sf).trim();
        const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const locator = `${file}:L${loc.line + 1}:C${loc.character + 1}:${left}=${right}`;
        const empty = right === "''" || right === '""' || right === '``';
        found.push({
          file,
          kind: left.endsWith('innerHTML') ? 'innerHTML' : 'outerHTML',
          text: `${left} = ${right}`,
          locator,
          allowedEmptyClear: empty,
        });
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (
        /\.(insertAdjacentHTML|write|writeln|setHTMLUnsafe|createContextualFragment)$/.test(callee)
        || callee === 'document.write'
        || callee === 'document.writeln'
      ) {
        const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push({
          file,
          kind: callee,
          text: node.getText(sf),
          locator: `${file}:L${loc.line + 1}:C${loc.character + 1}:${callee}`,
          allowedEmptyClear: false,
        });
      }
    }
    if (ts.isNewExpression(node) && node.expression.getText(sf) === 'DOMParser') {
      const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({
        file,
        kind: 'DOMParser',
        text: node.getText(sf),
        locator: `${file}:L${loc.line + 1}:C${loc.character + 1}:DOMParser`,
        allowedEmptyClear: false,
      });
    }
    if (ts.isAsExpression(node) && /SafeRichHtml/.test(node.type.getText(sf))) {
      const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({
        file,
        kind: 'SafeRichHtml-cast',
        text: node.getText(sf),
        locator: `${file}:L${loc.line + 1}:C${loc.character + 1}:cast`,
        allowedEmptyClear: false,
      });
    }
    if (ts.isSatisfiesExpression?.(node) && /SafeRichHtml/.test(node.type.getText(sf))) {
      const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({
        file,
        kind: 'SafeRichHtml-satisfies',
        text: node.getText(sf),
        locator: `${file}:L${loc.line + 1}:C${loc.character + 1}:satisfies`,
        allowedEmptyClear: false,
      });
    }
    if (ts.isNewExpression(node) && /SafeRichHtml/.test(node.expression.getText(sf))) {
      const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({
        file,
        kind: 'SafeRichHtml-construct',
        text: node.getText(sf),
        locator: `${file}:L${loc.line + 1}:C${loc.character + 1}:new`,
        allowedEmptyClear: false,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

export function collectTsSinksFromSource(
  file: string,
  sourceText: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS,
): TsSinkRecord[] {
  return collectTsRawSinksFromSource(file, sourceText, scriptKind);
}

function scriptKindForFile(name: string): ts.ScriptKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.d.ts')) return null;
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.ts')) return ts.ScriptKind.TS;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.js')) return ts.ScriptKind.JS;
  return null;
}

export function collectTsSinks(srcRoot = WEB_SRC): TsSinkRecord[] {
  const found: TsSinkRecord[] = [];
  for (const file of walkFiles(srcRoot, ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.astro'])) {
    const rel = relative(srcRoot, file).replaceAll('\\', '/');
    const src = readFileSync(file, 'utf-8');
    if (file.endsWith('.astro')) {
      found.push(...collectTsRawSinksFromSource(rel, frontmatterOf(src), ts.ScriptKind.TS));
      const scripts = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
      for (const block of scripts) {
        found.push(...collectTsRawSinksFromSource(rel, block[1], ts.ScriptKind.TS));
      }
      continue;
    }
    const kind = scriptKindForFile(file);
    if (kind == null) continue;
    found.push(...collectTsRawSinksFromSource(rel, src, kind));
  }
  found.sort((a, b) => a.locator.localeCompare(b.locator));
  return found;
}

export function allowedEmptyClearKey(rec: TsSinkRecord): string {
  const left = rec.text.split('=')[0].trim();
  return `${rec.file}:${left} = ''`;
}

export { ALLOWED_EMPTY_INNERHTML };

export interface ExecutableSlot {
  slotId: string;
  file: string;
  nodeKind: string;
  locator: string;
  fingerprint: string;
  identity: string;
}

function nodeText(node: AstroNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(nodeText).join('');
}

export async function collectExecutableSourceSlots(srcRoot = WEB_SRC): Promise<ExecutableSlot[]> {
  const slots: ExecutableSlot[] = [];
  for (const file of walkFiles(srcRoot, ['.astro'])) {
    const src = readFileSync(file, 'utf-8');
    const { ast } = await parseAstro(src);
    const rel = relative(srcRoot, file).replaceAll('\\', '/');
    walkAstro(ast as AstroNode, (node) => {
      if (node.type !== 'element') return;
      const name = (node.name ?? '').toLowerCase();
      if (!['script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'link', 'svg', 'math', 'template'].includes(name)) {
        return;
      }
      const attrs = node.attributes ?? [];
      const type = attrs.find((a) => a.name.toLowerCase() === 'type')?.value ?? '';
      if (name === 'script' && type.split(';')[0].trim().toLowerCase() === 'application/ld+json') return;
      const locator = `${rel}:${locOf(node)}:${name}`;
      const body = name === 'script' || name === 'style' ? nodeText(node) : '';
      const bodyHash = body ? createHash('sha256').update(body).digest('hex').slice(0, 16) : '';
      const identity = [
        name,
        ...attrs.map((a) => `${a.name}=${a.kind}:${a.value}`).sort(),
        bodyHash ? `body:${bodyHash}` : '',
      ]
        .filter(Boolean)
        .join('|');
      const fingerprint = createHash('sha256').update(`${locator}\n${identity}\n${body}`).digest('hex');
      slots.push({
        slotId: `src:${locator}`,
        file: rel,
        nodeKind: node.type,
        locator,
        fingerprint,
        identity,
      });
    });
    const cssImports = [...src.matchAll(/^import\s+['"]([^'"]+\.css)['"]/gm)];
    for (const [index, match] of cssImports.entries()) {
      const href = match[1];
      const locator = `${rel}:css-import:${index}:${href}`;
      const identity = `link|href=quoted:${href}|rel=quoted:stylesheet`;
      slots.push({
        slotId: `src:${locator}`,
        file: rel,
        nodeKind: 'css-import',
        locator,
        fingerprint: createHash('sha256').update(`${locator}\n${identity}`).digest('hex'),
        identity,
      });
    }
  }
  slots.sort((a, b) => a.slotId.localeCompare(b.slotId));
  return slots;
}

export function assertSourceSlotsMatch(live: ExecutableSlot[], committed: ExecutableSlot[]): string[] {
  const errors: string[] = [];
  const liveById = new Map(live.map((s) => [s.slotId, s]));
  const committedById = new Map(committed.map((s) => [s.slotId, s]));
  for (const slot of committed) {
    const found = liveById.get(slot.slotId);
    if (!found) {
      errors.push(`пропал source slot ${slot.slotId}`);
      continue;
    }
    if (found.nodeKind !== slot.nodeKind || found.locator !== slot.locator || found.identity !== slot.identity || found.fingerprint !== slot.fingerprint) {
      errors.push(`изменён source slot ${slot.slotId}: ${found.nodeKind}/${found.locator}/${found.fingerprint} vs ${slot.nodeKind}/${slot.locator}/${slot.fingerprint}`);
    }
  }
  for (const slot of live) {
    if (!committedById.has(slot.slotId)) errors.push(`незарегистрированный source node ${slot.slotId}`);
  }
  return errors;
}
