#!/usr/bin/env tsx
/**
 * IKPK Discovery → Strapi CMS Import Pipeline
 *
 * Idempotent import: uses legacy_id to detect existing records, then creates or updates.
 * Imports entities in dependency order across four phases.
 *
 * Usage:
 *   STRAPI_API_TOKEN=xxx tsx import.ts
 *   STRAPI_API_TOKEN=xxx tsx import.ts --dry-run
 *   STRAPI_API_TOKEN=xxx tsx import.ts --skip-media
 *
 * Env vars:
 *   STRAPI_URL        – base URL (default http://localhost:1337)
 *   STRAPI_API_TOKEN  – Full-access API token (required unless --dry-run)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────

const STRAPI_URL = (process.env.STRAPI_URL || "http://localhost:1337").replace(
  /\/$/,
  "",
);
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN ?? "";
const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_MEDIA = process.argv.includes("--skip-media");
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENTITIES_DIR = path.resolve(__dirname, "..", "discovery", "entities");

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface StrapiEntry {
  id: number;
  documentId: string;
  [key: string]: unknown;
}

interface EntityReport {
  created: number;
  updated: number;
  skipped: number;
  errors: { legacy_id: string; reason: string }[];
  missingRelations: { legacy_id: string; relation: string; target: string }[];
}

interface CacheEntry {
  id: number;
  documentId: string;
}

// ────────────────────────────────────────────────────────────────
// Global state
// ────────────────────────────────────────────────────────────────

const reports: Record<string, EntityReport> = {};
/** apiName → legacy_id → { id, documentId } */
const idCache: Record<string, Map<string, CacheEntry>> = {};
/** downloaded image URL → Strapi media file id */
const mediaCache = new Map<string, number>();
/** Set to true when Strapi is confirmed unreachable (skip API calls in dry-run) */
let strapiOffline = false;

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function newReport(name: string): EntityReport {
  const r: EntityReport = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    missingRelations: [],
  };
  reports[name] = r;
  return r;
}

function getCache(apiName: string): Map<string, CacheEntry> {
  return (idCache[apiName] ??= new Map());
}

// ────────────────────────────────────────────────────────────────
// HTTP client with exponential-backoff retries
// ────────────────────────────────────────────────────────────────

async function api<T = unknown>(
  method: string,
  endpoint: string,
  body?: unknown,
  rawBody?: { body: Buffer; contentType: string },
): Promise<T> {
  const url = `${STRAPI_URL}${endpoint}`;
  const headers: Record<string, string> = {};
  if (STRAPI_API_TOKEN) {
    headers["Authorization"] = `Bearer ${STRAPI_API_TOKEN}`;
  }

  let fetchBody: BodyInit | undefined;
  if (rawBody) {
    headers["Content-Type"] = rawBody.contentType;
    fetchBody = rawBody.body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchBody = JSON.stringify(body);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { method, headers, body: fetchBody });

      if (res.status === 429) {
        const wait = RETRY_BASE_MS * 2 ** attempt;
        log(`  ⏳ Rate-limited – waiting ${wait} ms …`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
        );
      }

      const ct = res.headers.get("content-type") ?? "";
      return ct.includes("application/json")
        ? ((await res.json()) as T)
        : ((await res.text()) as unknown as T);
    } catch (err: unknown) {
      if (attempt === MAX_RETRIES) throw err;
      const wait = RETRY_BASE_MS * 2 ** attempt;
      const msg = err instanceof Error ? err.message : String(err);
      log(
        `  ⚠ Attempt ${attempt}/${MAX_RETRIES} failed: ${msg}. Retrying in ${wait} ms …`,
      );
      await sleep(wait);
    }
  }
  throw new Error("unreachable");
}

// ────────────────────────────────────────────────────────────────
// Data loading
// ────────────────────────────────────────────────────────────────

async function loadJSON<T = Record<string, unknown>>(
  filename: string,
): Promise<T[]> {
  const fp = path.join(ENTITIES_DIR, filename);
  return JSON.parse(await fs.readFile(fp, "utf-8"));
}

// ────────────────────────────────────────────────────────────────
// Media helpers
// ────────────────────────────────────────────────────────────────

/**
 * Normalise the many shapes an "image" field can take into a single
 * downloadable URL (or null).
 */
function extractImageUrl(field: unknown): string | null {
  if (!field) return null;
  if (typeof field === "string") return field || null;
  if (Array.isArray(field)) {
    if (field.length === 0) return null;
    const first = field[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "url" in first)
      return (first as { url: string }).url ?? null;
    return null;
  }
  if (typeof field === "object" && field !== null && "url" in field) {
    return (field as { url: string }).url ?? null;
  }
  return null;
}

/**
 * Download an image from `url`, upload it to Strapi /api/upload, and
 * return the Strapi media file ID (or null on failure / skip).
 */
async function uploadImage(url: string | null): Promise<number | null> {
  if (!url || SKIP_MEDIA) return null;
  if (mediaCache.has(url)) return mediaCache.get(url)!;
  if (DRY_RUN) {
    log(`  📷 [DRY] Would upload: ${url.slice(0, 80)}`);
    return null;
  }

  try {
    // Download
    const res = await fetch(url);
    if (!res.ok) {
      log(`  ⚠ Download failed (${res.status}): ${url.slice(0, 80)}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const fname =
      decodeURIComponent(path.basename(new URL(url).pathname)) || "image.jpg";
    const mime = res.headers.get("content-type") || "application/octet-stream";

    // Build multipart/form-data manually to avoid extra deps
    const boundary = `----IKPKUpload${Date.now()}${Math.random().toString(36).slice(2)}`;
    const formBuf = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fname}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const uploaded = await api<unknown[]>("POST", "/api/upload", undefined, {
      body: formBuf,
      contentType: `multipart/form-data; boundary=${boundary}`,
    });

    const fileId: number | undefined = Array.isArray(uploaded)
      ? (uploaded[0] as { id?: number })?.id
      : undefined;
    if (fileId) {
      mediaCache.set(url, fileId);
      log(`  📷 Uploaded ${fname} → media #${fileId}`);
      return fileId;
    }
    log(`  ⚠ Upload returned no id for ${fname}`);
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  ⚠ Upload error: ${msg} (${url.slice(0, 60)})`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// SEO component builder
// ────────────────────────────────────────────────────────────────

function buildSeo(
  entity: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const title = entity.seo_title as string | undefined;
  const desc = entity.seo_description as string | undefined;
  if (!title && !desc) return undefined;
  return {
    seo_title: title || null,
    seo_description: desc || null,
    noindex: false,
  };
}

// ────────────────────────────────────────────────────────────────
// Core CRUD – find / resolve / upsert
// ────────────────────────────────────────────────────────────────

async function findByLegacyId(
  apiName: string,
  legacyId: string,
): Promise<StrapiEntry | null> {
  if (strapiOffline) return null; // fast path when Strapi is unreachable

  try {
    const res = await api<{ data: StrapiEntry[] }>(
      "GET",
      `/api/${apiName}?filters[legacy_id][$eq]=${encodeURIComponent(legacyId)}&pagination[pageSize]=1`,
    );
    const list = res?.data;
    if (Array.isArray(list) && list.length > 0) {
      const entry = list[0];
      getCache(apiName).set(legacyId, {
        id: entry.id,
        documentId: entry.documentId,
      });
      return entry;
    }
  } catch (err: unknown) {
    // In dry-run without connectivity, treat as "not found"
    if (DRY_RUN) return null;
    throw err;
  }
  return null;
}

/**
 * Look up a related entity's documentId by its legacy_id.
 * Uses the in-memory cache first, then falls back to an API lookup.
 * Records a missing-relation entry in the report if not found.
 */
async function resolveRelation(
  apiName: string,
  legacyId: string,
  report: EntityReport,
  sourceLegacyId: string,
  relationName: string,
): Promise<string | null> {
  const cached = getCache(apiName).get(legacyId);
  if (cached) return cached.documentId;

  const found = await findByLegacyId(apiName, legacyId);
  if (found) return found.documentId;

  report.missingRelations.push({
    legacy_id: sourceLegacyId,
    relation: relationName,
    target: `${apiName}/${legacyId}`,
  });
  return null;
}

/**
 * Create or update an entity via the Strapi REST API.
 * Uses filters[legacy_id] to detect existing records.
 */
async function upsert(
  apiName: string,
  legacyId: string,
  data: Record<string, unknown>,
  report: EntityReport,
): Promise<StrapiEntry | null> {
  try {
    const existing = await findByLegacyId(apiName, legacyId);

    if (existing) {
      // ── UPDATE ──
      if (DRY_RUN) {
        log(`  [DRY] Would update ${apiName} [${legacyId}]`);
        report.updated++;
        return existing;
      }
      const res = await api<{ data: StrapiEntry }>(
        "PUT",
        `/api/${apiName}/${existing.documentId}`,
        { data },
      );
      const entry = res.data;
      getCache(apiName).set(legacyId, {
        id: entry.id,
        documentId: entry.documentId,
      });
      log(`  ✏️  Updated ${apiName} [${legacyId}]`);
      report.updated++;
      return entry;
    }

    // ── CREATE ──
    if (DRY_RUN) {
      log(`  [DRY] Would create ${apiName} [${legacyId}]`);
      report.created++;
      return null;
    }
    const res = await api<{ data: StrapiEntry }>("POST", `/api/${apiName}`, {
      data: { ...data, legacy_id: legacyId },
    });
    const entry = res.data;
    getCache(apiName).set(legacyId, {
      id: entry.id,
      documentId: entry.documentId,
    });
    log(`  ✅ Created ${apiName} [${legacyId}]`);
    report.created++;
    return entry;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  ❌ ${apiName} [${legacyId}]: ${msg}`);
    report.errors.push({ legacy_id: legacyId, reason: msg });
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// Phase 1 — Independent entities (no foreign-key deps)
// ════════════════════════════════════════════════════════════════

async function importInstitutes(): Promise<void> {
  log("📦 Importing institutes …");
  const report = newReport("institutes");
  for (const e of await loadJSON("institutes.json")) {
    const imgId = await uploadImage(extractImageUrl(e.images));
    const data: Record<string, unknown> = {
      name: e.name,
      slug: e.slug,
      shortName: (e.shortName as string) ?? null,
      description: (e.description_html as string) ?? null,
      order: (e.order as number) ?? 0,
      legacy_id: e.legacy_id,
    };
    const s = buildSeo(e);
    if (s) data.seo = s;
    if (imgId) data.image = imgId;
    await upsert("institutes", e.legacy_id as string, data, report);
  }
}

async function importTeachers(): Promise<void> {
  log("📦 Importing teachers …");
  const report = newReport("teachers");
  for (const e of await loadJSON("teachers.json")) {
    const photoId = await uploadImage((e.photo as string) ?? null);
    const data: Record<string, unknown> = {
      name: e.name,
      slug: e.slug,
      bio: (e.bio_html as string) ?? null,
      legacy_id: e.legacy_id,
    };
    if (photoId) data.photo = photoId;
    await upsert("teachers", e.legacy_id as string, data, report);
  }
}

async function importArticles(): Promise<void> {
  log("📦 Importing articles …");
  const report = newReport("articles");
  for (const e of await loadJSON("articles.json")) {
    const imgId = await uploadImage(extractImageUrl(e.image));
    const data: Record<string, unknown> = {
      title: e.title,
      slug: e.slug,
      body: (e.body_html as string) ?? null,
      published_at: (e.published_at as string) ?? null,
      legacy_id: e.legacy_id,
    };
    const s = buildSeo(e);
    if (s) data.seo = s;
    if (imgId) data.image = imgId;
    await upsert("articles", e.legacy_id as string, data, report);
  }
}

async function importVideoPlaylists(): Promise<void> {
  log("📦 Importing video playlists …");
  const report = newReport("video-playlists");
  for (const e of await loadJSON("video_playlists.json")) {
    const data: Record<string, unknown> = {
      name: (e.title as string) ?? (e.name as string),
      slug: e.slug,
      // discovery data has no structured videos array; Strapi field stays null
      videos: (e.videos as unknown) ?? null,
      legacy_id: e.legacy_id,
    };
    const s = buildSeo(e);
    if (s) data.seo = s;
    await upsert("video-playlists", e.legacy_id as string, data, report);
  }
}

async function importPages(): Promise<void> {
  log("📦 Importing pages …");
  const report = newReport("pages");
  for (const e of await loadJSON("static_pages.json")) {
    const data: Record<string, unknown> = {
      title: e.title,
      slug: e.slug,
      body: (e.body_html as string) ?? null,
      legacy_id: e.legacy_id,
    };
    const s = buildSeo(e);
    if (s) data.seo = s;
    await upsert("pages", e.legacy_id as string, data, report);
  }
}

async function importNewsItems(): Promise<void> {
  log("📦 Importing news items …");
  const report = newReport("news-items");
  for (const e of await loadJSON("news.json")) {
    const lid = String(e.id);
    const imgId = await uploadImage(extractImageUrl(e.image));
    const data: Record<string, unknown> = {
      name: e.name,
      description: (e.description as string) ?? null,
      link: (e.link as string) ?? null,
      priority: (e.priority as number) ?? 0,
      legacy_id: lid,
    };
    if (imgId) data.image = imgId;
    await upsert("news-items", lid, data, report);
  }
}

async function importPromotions(): Promise<void> {
  log("📦 Importing promotions …");
  const report = newReport("promotions");
  for (const e of await loadJSON("promotions.json")) {
    const lid = String(e.id);
    const imgId = await uploadImage(extractImageUrl(e.image));
    const data: Record<string, unknown> = {
      name: e.name,
      description: (e.description as string) ?? null,
      link: (e.link as string) ?? null,
      priority: (e.priority as number) ?? 0,
      active: true,
      legacy_id: lid,
    };
    if (imgId) data.image = imgId;
    await upsert("promotions", lid, data, report);
  }
}

// ════════════════════════════════════════════════════════════════
// Phase 2 — Course Groups (depends on institutes)
// ════════════════════════════════════════════════════════════════

async function importCourseGroups(): Promise<void> {
  log("📦 Importing course groups …");
  const report = newReport("course-groups");
  for (const e of await loadJSON("course_groups.json")) {
    const imgId = await uploadImage(extractImageUrl(e.images));
    const data: Record<string, unknown> = {
      name: e.name,
      slug: e.slug,
      description: (e.description_html as string) ?? null,
      legacy_id: e.legacy_id,
    };
    const s = buildSeo(e);
    if (s) data.seo = s;
    if (imgId) data.image = imgId;

    // Resolve institute relation
    if (e.institute_legacy_id) {
      const docId = await resolveRelation(
        "institutes",
        e.institute_legacy_id as string,
        report,
        e.legacy_id as string,
        "institute",
      );
      if (docId) data.institute = docId;
    }

    await upsert("course-groups", e.legacy_id as string, data, report);
  }
}

// ════════════════════════════════════════════════════════════════
// Phase 3 — Seminars (depends on course groups + teachers M2M)
// ════════════════════════════════════════════════════════════════

/**
 * Build a map: teacher numeric-id (string) → teacher legacy_id.
 * Discovery teacher legacy_ids follow the pattern `…/prepodavatel/{numericId}`.
 */
function buildTeacherNumericMap(
  teachers: Record<string, unknown>[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of teachers) {
    const lid = t.legacy_id as string;
    const parts = lid.split("/");
    const numPart = parts[parts.length - 1];
    if (/^\d+$/.test(numPart)) {
      m.set(numPart, lid);
    }
  }
  return m;
}

/**
 * Derive seminar → teacher associations from schedule entries.
 * Returns: seminarSlug → Set<teacher legacy_id>
 */
function buildSeminarTeachersMap(
  scheduleEntries: Record<string, unknown>[],
  teacherNumMap: Map<string, string>,
): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const se of scheduleEntries) {
    const seminar = se.seminar as { slug?: string } | undefined;
    const teachers = se.teachers as { id: number }[] | undefined;
    if (!seminar?.slug || !Array.isArray(teachers)) continue;

    if (!m.has(seminar.slug)) m.set(seminar.slug, new Set());
    for (const t of teachers) {
      const lid = teacherNumMap.get(String(t.id));
      if (lid) m.get(seminar.slug)!.add(lid);
    }
  }
  return m;
}

async function importSeminars(): Promise<void> {
  log("📦 Importing seminars …");
  const report = newReport("seminars");

  const [seminars, schedules, teachers] = await Promise.all([
    loadJSON("seminars.json"),
    loadJSON("schedule_entries.json"),
    loadJSON("teachers.json"),
  ]);

  const teacherNumMap = buildTeacherNumericMap(teachers);
  const semTeachers = buildSeminarTeachersMap(schedules, teacherNumMap);

  for (const e of seminars) {
    const imgId = await uploadImage(extractImageUrl(e.images));
    const data: Record<string, unknown> = {
      name: e.name,
      slug: e.slug,
      description: (e.description_html as string) ?? null,
      status: (e.status as string) ?? "planned",
      legacy_id: e.legacy_id,
    };
    const s = buildSeo(e);
    if (s) data.seo = s;
    if (imgId) data.image = imgId;

    // Resolve course_group relation
    if (e.course_group_legacy_id) {
      const cgDocId = await resolveRelation(
        "course-groups",
        e.course_group_legacy_id as string,
        report,
        e.legacy_id as string,
        "course_group",
      );
      if (cgDocId) data.course_group = cgDocId;
    }

    // Resolve teachers M2M (derived from schedule entries)
    const tLegacyIds = semTeachers.get(e.slug as string);
    if (tLegacyIds && tLegacyIds.size > 0) {
      const docIds: string[] = [];
      for (const tLid of tLegacyIds) {
        const cached = getCache("teachers").get(tLid);
        if (cached) {
          docIds.push(cached.documentId);
        } else {
          const found = await findByLegacyId("teachers", tLid);
          if (found) {
            docIds.push(found.documentId);
          } else {
            report.missingRelations.push({
              legacy_id: e.legacy_id as string,
              relation: "teachers",
              target: `teachers/${tLid}`,
            });
          }
        }
      }
      if (docIds.length > 0) {
        // Use "set" to replace the entire M2M relation (idempotent)
        data.teachers = { set: docIds };
      }
    }

    await upsert("seminars", e.legacy_id as string, data, report);
  }
}

// ════════════════════════════════════════════════════════════════
// Phase 4 — Schedule Entries (depends on seminars)
// ════════════════════════════════════════════════════════════════

async function importScheduleEntries(): Promise<void> {
  log("📦 Importing schedule entries …");
  const report = newReport("schedule-entries");

  const [entries, seminars] = await Promise.all([
    loadJSON("schedule_entries.json"),
    loadJSON("seminars.json"),
  ]);

  // Build slug → legacy_id map for efficient seminar resolution
  const seminarSlugToLid = new Map<string, string>();
  for (const s of seminars) {
    if (s.slug && s.legacy_id) {
      seminarSlugToLid.set(s.slug as string, s.legacy_id as string);
    }
  }

  for (const e of entries) {
    const lid = String(e.id);
    const data: Record<string, unknown> = {
      name: e.name,
      startAt: (e.startAt as string) ?? null,
      endAt: (e.endAt as string) ?? null,
      city:
        (e.city as { name?: string } | undefined)?.name ?? null,
      price: (e.newPrice as number) ?? null,
      oldPrice: (e.oldPrice as number) ?? null,
      isFree: (e.isFree as boolean) ?? false,
      status: (e.status as string) ?? "active",
      registrationFormLink: (e.registrationFormLink as string) ?? null,
      description: (e.description as string) ?? null,
      additionalText: (e.additionalText as string) ?? null,
      duration: e.duration != null ? String(e.duration) : null,
      // teachers stored as JSON (not a relation) on schedule-entry
      teachers: Array.isArray(e.teachers) ? e.teachers : null,
      legacy_id: lid,
    };

    // Resolve seminar relation via slug
    const seminarObj = e.seminar as { slug?: string } | undefined;
    if (seminarObj?.slug) {
      let docId: string | null = null;

      // 1. Try cache via slug → legacy_id → cache
      const semLid = seminarSlugToLid.get(seminarObj.slug);
      if (semLid) {
        const cached = getCache("seminars").get(semLid);
        if (cached) docId = cached.documentId;
      }

      // 2. Fallback: direct API lookup by slug
      if (!docId && !strapiOffline) {
        try {
          const res = await api<{ data: StrapiEntry[] }>(
            "GET",
            `/api/seminars?filters[slug][$eq]=${encodeURIComponent(seminarObj.slug)}&pagination[pageSize]=1`,
          );
          if (res?.data?.[0]) {
            docId = res.data[0].documentId;
          }
        } catch {
          if (!DRY_RUN) {
            log(
              `  ⚠ Could not look up seminar slug=${seminarObj.slug}`,
            );
          }
        }
      }

      if (docId) {
        data.seminar = docId;
      } else {
        report.missingRelations.push({
          legacy_id: lid,
          relation: "seminar",
          target: `seminars/slug=${seminarObj.slug}`,
        });
      }
    }

    await upsert("schedule-entries", lid, data, report);
  }
}

// ════════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════════

function printReport(): void {
  const sep = "═".repeat(64);
  const thin = "─".repeat(64);
  console.log(`\n${sep}`);
  console.log("  📊  IMPORT REPORT");
  console.log(sep);

  let totCreated = 0;
  let totUpdated = 0;
  let totErrors = 0;

  for (const [name, r] of Object.entries(reports)) {
    console.log(`\n  ${name}:`);
    console.log(
      `    ✅ Created: ${r.created}   ✏️  Updated: ${r.updated}   ⏭  Skipped: ${r.skipped}`,
    );
    totCreated += r.created;
    totUpdated += r.updated;
    totErrors += r.errors.length;

    if (r.errors.length > 0) {
      console.log(`    ❌ Errors (${r.errors.length}):`);
      for (const x of r.errors) {
        console.log(`       [${x.legacy_id}] ${x.reason}`);
      }
    }
    if (r.missingRelations.length > 0) {
      console.log(`    ⚠️  Missing relations (${r.missingRelations.length}):`);
      for (const x of r.missingRelations) {
        console.log(`       [${x.legacy_id}] ${x.relation} → ${x.target}`);
      }
    }
  }

  console.log(`\n${thin}`);
  console.log(
    `  TOTALS: ✅ ${totCreated} created   ✏️  ${totUpdated} updated   ❌ ${totErrors} errors`,
  );
  if (DRY_RUN)
    console.log("  ℹ️   DRY-RUN mode — no data was written to Strapi");
  if (SKIP_MEDIA)
    console.log("  ℹ️   SKIP-MEDIA mode — images were not uploaded");
  console.log(`${sep}\n`);
}

// ════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("\n🚀 IKPK Discovery → Strapi Import Pipeline");
  console.log(`   Strapi URL:  ${STRAPI_URL}`);
  console.log(`   Dry run:     ${DRY_RUN}`);
  console.log(`   Skip media:  ${SKIP_MEDIA}`);
  console.log(`   Entities:    ${ENTITIES_DIR}\n`);

  if (!STRAPI_API_TOKEN && !DRY_RUN) {
    console.error(
      "❌ STRAPI_API_TOKEN environment variable is required (use --dry-run to preview without it)",
    );
    process.exit(1);
  }

  // Verify entities directory exists
  try {
    await fs.access(ENTITIES_DIR);
  } catch {
    console.error(`❌ Entities directory not found: ${ENTITIES_DIR}`);
    process.exit(1);
  }

  // Connectivity check (skip in dry-run without token)
  if (STRAPI_API_TOKEN) {
    try {
      await api("GET", "/api/institutes?pagination[pageSize]=1");
      log("✓ Connected to Strapi");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!DRY_RUN) {
        console.error(`❌ Cannot reach Strapi API: ${msg}`);
        process.exit(1);
      }
      strapiOffline = true;
      log(`⚠ Strapi not reachable (continuing in dry-run): ${msg}`);
    }
  } else if (DRY_RUN) {
    strapiOffline = true;
    log("ℹ️  No API token – running fully offline dry-run");
  }

  // ─── Phase 1: Independent entities ───────────────────────
  log("═══ Phase 1: Independent entities ═══");
  await importInstitutes();
  await importTeachers();
  await importArticles();
  await importVideoPlaylists();
  await importPages();
  await importNewsItems();
  await importPromotions();

  // ─── Phase 2: Course Groups (needs institutes) ───────────
  log("\n═══ Phase 2: Course Groups ═══");
  await importCourseGroups();

  // ─── Phase 3: Seminars (needs course groups + teachers) ──
  log("\n═══ Phase 3: Seminars ═══");
  await importSeminars();

  // ─── Phase 4: Schedule Entries (needs seminars) ──────────
  log("\n═══ Phase 4: Schedule Entries ═══");
  await importScheduleEntries();

  // ─── Report ──────────────────────────────────────────────
  printReport();
}

main().catch((err) => {
  console.error("\n💥 Fatal error:", err);
  process.exit(1);
});
