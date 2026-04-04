/**
 * validate-urls.ts — Validates URL map from discovery/url_map.csv
 *
 * For canonical URLs (redirect_type=200): verifies HTTP 200 on the new site.
 * For alias URLs (redirect_type=301): verifies HTTP 301 with correct Location header.
 *
 * Usage:
 *   npx tsx validate-urls.ts [--base-url http://localhost:4321]
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(): { baseUrl: string } {
  const args = process.argv.slice(2);
  let baseUrl = "http://localhost:4321";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) {
      baseUrl = args[i + 1];
      i++;
    }
  }

  return { baseUrl: baseUrl.replace(/\/+$/, "") };
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------
interface UrlEntry {
  old_url: string;
  old_path: string;
  new_path: string;
  redirect_type: string;
  page_type: string;
  alias_type: string;
  title: string;
}

function parseCsv(filePath: string): UrlEntry[] {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((line: string) => line.trim());
  const header = lines[0].split(",");

  const idx = {
    old_url: header.indexOf("old_url"),
    old_path: header.indexOf("old_path"),
    new_path: header.indexOf("new_path"),
    redirect_type: header.indexOf("redirect_type"),
    page_type: header.indexOf("page_type"),
    alias_type: header.indexOf("alias_type"),
    title: header.indexOf("title"),
  };

  return lines.slice(1).map((line: string) => {
    const cols = line.split(",");
    return {
      old_url: cols[idx.old_url]?.trim() ?? "",
      old_path: cols[idx.old_path]?.trim() ?? "",
      new_path: cols[idx.new_path]?.trim() ?? "",
      redirect_type: cols[idx.redirect_type]?.trim() ?? "",
      page_type: cols[idx.page_type]?.trim() ?? "",
      alias_type: cols[idx.alias_type]?.trim() ?? "",
      title: cols[idx.title]?.trim() ?? "",
    };
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
interface Result {
  url: string;
  expected: string;
  actual: string;
  status: "pass" | "fail" | "error";
  detail: string;
}

async function checkCanonical(
  baseUrl: string,
  entry: UrlEntry
): Promise<Result> {
  const url = `${baseUrl}${entry.new_path}`;
  try {
    const res = await fetch(url, { redirect: "manual" });
    const ok = res.status === 200;
    return {
      url,
      expected: "200",
      actual: String(res.status),
      status: ok ? "pass" : "fail",
      detail: ok ? "" : `Expected 200, got ${res.status}`,
    };
  } catch (err) {
    return {
      url,
      expected: "200",
      actual: "error",
      status: "error",
      detail: String(err instanceof Error ? err.message : err),
    };
  }
}

async function checkRedirect(
  baseUrl: string,
  entry: UrlEntry
): Promise<Result> {
  const url = `${baseUrl}${entry.old_path}`;
  const expectedLocation = entry.new_path;

  try {
    const res = await fetch(url, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";

    // Normalize location: could be absolute or relative
    let locationPath = location;
    try {
      const parsed = new URL(location);
      locationPath = parsed.pathname;
    } catch {
      // location is already a relative path
    }

    // Remove trailing slashes for comparison
    const normExpected = expectedLocation.replace(/\/+$/, "") || "/";
    const normActual = locationPath.replace(/\/+$/, "") || "/";

    const statusOk = res.status === 301 || res.status === 308;
    const locationOk = normActual === normExpected;
    const ok = statusOk && locationOk;

    let detail = "";
    if (!statusOk) detail += `Expected 301, got ${res.status}. `;
    if (!locationOk) detail += `Expected redirect to ${normExpected}, got ${normActual}. `;

    return {
      url,
      expected: `301 → ${normExpected}`,
      actual: `${res.status} → ${normActual}`,
      status: ok ? "pass" : "fail",
      detail: detail.trim(),
    };
  } catch (err) {
    return {
      url,
      expected: `301 → ${expectedLocation}`,
      actual: "error",
      status: "error",
      detail: String(err instanceof Error ? err.message : err),
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { baseUrl } = parseArgs();
  const csvPath = resolve(__dirname, "..", "discovery", "url_map.csv");

  console.log(`\n🔍 Validating URLs from: ${csvPath}`);
  console.log(`🌐 Base URL: ${baseUrl}\n`);

  const entries = parseCsv(csvPath);

  const canonicals = entries.filter(
    (e) => e.redirect_type === "200" && e.alias_type === "canonical"
  );
  const redirects = entries.filter((e) => e.redirect_type === "301");

  console.log(
    `Found ${canonicals.length} canonical URLs (200) and ${redirects.length} redirect URLs (301)\n`
  );

  // --- Validate canonical URLs (200) ---
  console.log("━".repeat(60));
  console.log("Checking canonical URLs (expecting 200)...");
  console.log("━".repeat(60));

  const canonicalResults: Result[] = [];
  const CONCURRENCY = 10;

  for (let i = 0; i < canonicals.length; i += CONCURRENCY) {
    const batch = canonicals.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((e) => checkCanonical(baseUrl, e))
    );
    canonicalResults.push(...results);

    for (const r of results) {
      const icon = r.status === "pass" ? "✅" : r.status === "fail" ? "❌" : "⚠️";
      if (r.status !== "pass") {
        console.log(`${icon} ${r.url} — ${r.detail}`);
      }
    }
  }

  // --- Validate redirect URLs (301) ---
  console.log("\n" + "━".repeat(60));
  console.log("Checking redirect URLs (expecting 301)...");
  console.log("━".repeat(60));

  const redirectResults: Result[] = [];

  for (let i = 0; i < redirects.length; i += CONCURRENCY) {
    const batch = redirects.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((e) => checkRedirect(baseUrl, e))
    );
    redirectResults.push(...results);

    for (const r of results) {
      const icon = r.status === "pass" ? "✅" : r.status === "fail" ? "❌" : "⚠️";
      if (r.status !== "pass") {
        console.log(`${icon} ${r.url} — ${r.detail}`);
      }
    }
  }

  // --- Summary ---
  const allResults = [...canonicalResults, ...redirectResults];
  const passed = allResults.filter((r) => r.status === "pass").length;
  const failed = allResults.filter((r) => r.status === "fail").length;
  const errors = allResults.filter((r) => r.status === "error").length;

  const canonicalPassed = canonicalResults.filter((r) => r.status === "pass").length;
  const canonicalFailed = canonicalResults.filter((r) => r.status === "fail").length;
  const canonicalErrors = canonicalResults.filter((r) => r.status === "error").length;

  const redirectPassed = redirectResults.filter((r) => r.status === "pass").length;
  const redirectFailed = redirectResults.filter((r) => r.status === "fail").length;
  const redirectErrors = redirectResults.filter((r) => r.status === "error").length;

  console.log("\n" + "═".repeat(60));
  console.log("REPORT");
  console.log("═".repeat(60));
  console.log(
    `\nCanonical (200):  ${canonicalPassed} passed, ${canonicalFailed} failed, ${canonicalErrors} errors  (of ${canonicalResults.length})`
  );
  console.log(
    `Redirects (301):  ${redirectPassed} passed, ${redirectFailed} failed, ${redirectErrors} errors  (of ${redirectResults.length})`
  );
  console.log(
    `\nTotal:            ${passed} passed, ${failed} failed, ${errors} errors  (of ${allResults.length})`
  );
  console.log("═".repeat(60));

  if (failed > 0 || errors > 0) {
    console.log("\n❌ VALIDATION FAILED\n");
    process.exit(1);
  } else {
    console.log("\n✅ ALL URLS VALIDATED SUCCESSFULLY\n");
    process.exit(0);
  }
}

main();
