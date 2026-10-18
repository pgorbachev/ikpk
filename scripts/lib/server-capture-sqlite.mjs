/** Read-only projection of the current Strapi v5 SQLite layout. Never loads Strapi. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const TYPES = ['institute', 'course-group', 'seminar', 'teacher', 'article', 'schedule-entry', 'news-item', 'promotion', 'page', 'video-playlist'];
const COMPONENTS = ['shared.seo', 'seminar.document-record'];
const scalarTypes = new Set(['string', 'text', 'richtext', 'uid', 'enumeration', 'integer', 'decimal', 'boolean', 'json', 'date', 'datetime']);
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replaceAll('-', '_');
const quote = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsupported SQL identifier: ${s}`); return `"${s}"`; };

export function loadCaptureSchemas(schemaRoot) {
  const schemas = {};
  for (const name of TYPES) schemas[`api::${name}.${name}`] = JSON.parse(readFileSync(join(schemaRoot, 'api', name, 'content-types', name, 'schema.json'), 'utf8'));
  for (const name of COMPONENTS) schemas[name] = JSON.parse(readFileSync(join(schemaRoot, 'components', ...name.split('.')) + '.json', 'utf8'));
  return schemas;
}

export function schemaContractDigest(schemaRoot) {
  return createHash('sha256').update(JSON.stringify(loadCaptureSchemas(schemaRoot))).digest('hex');
}

export function readPublishedSqlite(database, schemaRoot) {
  const schemas = loadCaptureSchemas(schemaRoot);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const info = new Map();
    function requireColumns(table, columns) {
      if (!info.has(table)) {
        if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error(`schema incompatible: table ${table} missing`);
        info.set(table, new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((r) => r.name)));
      }
      for (const column of columns) if (!info.get(table).has(column)) throw new Error(`schema incompatible: ${table}.${column} missing`);
    }
    function relationSpec(uid, name, attr) {
      const owner = attr.mappedBy ? schemas[attr.target] : schemas[uid];
      const ownerAttr = attr.mappedBy ? owner?.attributes[attr.mappedBy] : attr;
      const ownerName = attr.mappedBy ?? name;
      const target = schemas[ownerAttr?.target];
      if (!owner || !target || ownerAttr?.useJoinTable === false) throw new Error(`schema unsupported relation: ${uid}.${name}`);
      const left = snake(owner.info.singularName);
      const right = snake(target.info.singularName);
      const inverse = Boolean(attr.mappedBy);
      return { table: `${owner.collectionName}_${snake(ownerName)}_lnk`, from: `${inverse ? right : left}_id`, to: `${inverse ? left : right}_id`, order: attr.relation.endsWith('Many') ? `${inverse ? left : right}_ord` : null };
    }
    // Validate every type even when it has zero rows. Missing schema is never an empty collection.
    for (const [uid, schema] of Object.entries(schemas)) {
      const scalar = Object.entries(schema.attributes).filter(([, a]) => scalarTypes.has(a.type));
      requireColumns(schema.collectionName, ['id', ...scalar.map(([n]) => snake(n)), ...(uid.startsWith('api::') ? ['document_id', 'created_at', 'updated_at', 'published_at'] : [])]);
      const allowed = new Set(['id', 'document_id', 'created_at', 'updated_at', 'published_at', 'created_by_id', 'updated_by_id', 'locale', ...scalar.map(([n]) => snake(n))]);
      for (const column of info.get(schema.collectionName)) if (!allowed.has(column)) throw new Error(`schema incompatible: undeclared ${schema.collectionName}.${column}`);
      for (const [name, attr] of Object.entries(schema.attributes)) {
        if (attr.type === 'relation') {
          const r = relationSpec(uid, name, attr); requireColumns(r.table, [r.from, r.to, ...(r.order ? [r.order] : [])]);
        } else if (attr.type === 'component') {
          if (!schemas[attr.component]) throw new Error(`schema unsupported component: ${attr.component}`);
          requireColumns(`${schema.collectionName}_cmps`, ['entity_id', 'cmp_id', 'component_type', 'field', 'order']);
        } else if (attr.type !== 'media' && !scalarTypes.has(attr.type)) throw new Error(`schema unsupported attribute: ${uid}.${name}`);
      }
    }
    requireColumns('files', ['id', 'document_id', 'url']);
    requireColumns('files_related_mph', ['file_id', 'related_id', 'related_type', 'field', 'order']);
    const rows = new Map();
    for (const [uid, schema] of Object.entries(schemas)) rows.set(uid, new Map(db.prepare(`SELECT * FROM ${quote(schema.collectionName)} ORDER BY id`).all().map((r) => [r.id, r])));
    const published = (uid, row) => row && (!uid.startsWith('api::') || row.published_at !== null);
    function scalarRecord(uid, row) {
      const result = { id: row.id };
      if (uid.startsWith('api::')) {
        if (row.locale !== undefined && row.locale !== null) throw new Error(`unsupported localized published record: ${uid}#${row.id}`);
        if (!row.document_id) throw new Error(`schema incompatible: missing document_id in ${uid}#${row.id}`);
        result.documentId = row.document_id;
        for (const n of ['createdAt', 'updatedAt', 'publishedAt']) result[n] = dateTime(row[snake(n)]);
      }
      for (const [name, attr] of Object.entries(schemas[uid].attributes)) {
        if (!scalarTypes.has(attr.type)) continue;
        const value = row[snake(name)];
        if (value === null) result[name] = null;
        else if (attr.type === 'json') result[name] = JSON.parse(value);
        else if (attr.type === 'boolean') {
          if (![0, 1].includes(value)) throw new Error(`schema incompatible boolean: ${uid}.${name}`);
          result[name] = value === 1;
        } else result[name] = attr.type === 'datetime' ? dateTime(value) : value;
      }
      return result;
    }
    function project(uid, row) {
      const out = scalarRecord(uid, row);
      for (const [name, attr] of Object.entries(schemas[uid].attributes)) {
        if (attr.type === 'relation') {
          const r = relationSpec(uid, name, attr);
          const links = db.prepare(`SELECT ${quote(r.to)} AS target FROM ${quote(r.table)} WHERE ${quote(r.from)}=? ORDER BY ${r.order ? `${quote(r.order)},` : ''}${quote(r.to)}`).all(row.id);
          const related = links.flatMap((link) => {
            const target = rows.get(attr.target).get(link.target);
            if (!target) throw new Error(`broken relation: ${uid}.${name}#${link.target}`);
            // A draft relation is not published content. Do not silently substitute its draft fields.
            return published(attr.target, target) ? [scalarRecord(attr.target, target)] : [];
          });
          out[name] = cardinality(related, attr.relation.endsWith('Many'), `${uid}.${name}`);
        } else if (attr.type === 'media') {
          const links = db.prepare('SELECT file_id FROM files_related_mph WHERE related_id=? AND related_type=? AND field=? ORDER BY "order", file_id').all(row.id, uid, name);
          const related = links.map(({ file_id }) => {
            const media = db.prepare('SELECT id, document_id AS documentId, url FROM files WHERE id=?').get(file_id);
            if (!media || typeof media.url !== 'string' || !media.url.startsWith('/uploads/')) throw new Error(`broken or nonlocal media: ${uid}.${name}#${file_id}`);
            return { ...media };
          });
          out[name] = cardinality(related, attr.multiple, `${uid}.${name}`);
        } else if (attr.type === 'component') {
          const links = db.prepare(`SELECT cmp_id, component_type FROM ${quote(`${schemas[uid].collectionName}_cmps`)} WHERE entity_id=? AND field=? ORDER BY "order", cmp_id`).all(row.id, name);
          const related = links.map((link) => {
            if (link.component_type !== attr.component) throw new Error(`schema incompatible component: ${uid}.${name}`);
            const component = rows.get(attr.component).get(link.cmp_id);
            if (!component) throw new Error(`broken component: ${uid}.${name}#${link.cmp_id}`);
            return project(attr.component, component);
          });
          out[name] = cardinality(related, attr.repeatable, `${uid}.${name}`);
        }
      }
      return out;
    }
    const collections = {};
    for (const name of TYPES) {
      const uid = `api::${name}.${name}`;
      const publicRows = [...rows.get(uid).values()].filter((r) => published(uid, r));
      if (new Set(publicRows.map((r) => r.document_id)).size !== publicRows.length) throw new Error(`schema incompatible: duplicate published document in ${uid}`);
      collections[schemas[uid].info.pluralName] = publicRows.map((r) => project(uid, r));
    }
    // Includes actual SQLite DDL as well as the expected CMS contract.
    const ddl = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const schemaDigest = createHash('sha256').update(JSON.stringify({ schemas, ddl })).digest('hex');
    return { collections, schemaDigest };
  } finally { db.close(); }
}
function cardinality(rows, multiple, where) {
  if (!multiple && rows.length > 1) throw new Error(`schema incompatible cardinality: ${where}`);
  return multiple ? rows : (rows[0] ?? null);
}
function dateTime(value) {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('schema incompatible datetime');
  return date.toISOString();
}
