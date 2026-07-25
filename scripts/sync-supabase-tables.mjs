/**
 * Supabase → Git JSON sync
 *
 * Flow:
 *   1. Resolve auth (service_role preferred, else anon)
 *   2. Discover tables (OpenAPI paths, or SUPABASE_TABLES list)
 *   3. Page-fetch each table via PostgREST Range headers
 *   4. Redact secret-like fields/values
 *   5. Write data/<table>.json + data/_manifest.json
 *   6. Prune JSON files for tables that no longer exist
 */

import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = loadConfig();

function loadConfig() {
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!supabaseUrl) {
    throw new Error("Missing required environment variable: SUPABASE_URL");
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  const apiKey = serviceRoleKey || anonKey;

  if (!apiKey) {
    throw new Error(
      "Missing API key. Add SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY in GitHub Secrets.",
    );
  }

  const tables = (process.env.SUPABASE_TABLES || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  return {
    supabaseUrl,
    apiKey,
    serviceRoleKey,
    anonKey,
    configuredTables: tables,
    outputRoot: path.resolve("data"),
    manifestPath: path.resolve("data", "_manifest.json"),
    pageSize: Number(process.env.SYNC_PAGE_SIZE) || 1000,
    concurrency: Math.max(1, Number(process.env.SYNC_CONCURRENCY) || 4),
    maxRetries: Number(process.env.SYNC_MAX_RETRIES) || 3,
    retryBaseMs: Number(process.env.SYNC_RETRY_BASE_MS) || 500,
  };
}

const REDACTED = "[REDACTED SECRET]";
const SECRET_FIELD = /(api[-_ ]?key|secret|token|password|passwd|authorization|bearer)/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-kimi-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g,
];

const baseHeaders = {
  apikey: config.apiKey,
  Authorization: `Bearer ${config.apiKey}`,
};

// ---------------------------------------------------------------------------
// Sanitization — strip secrets before writing public git history
// ---------------------------------------------------------------------------

function sanitizeString(value, keyName = "") {
  if (SECRET_FIELD.test(keyName) && value.trim().length > 0) {
    return REDACTED;
  }

  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // Reset lastIndex for global regex reuse
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

function sanitizeValue(value, keyName = "") {
  if (typeof value === "string") {
    return sanitizeString(value, keyName);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitizeValue(v, k)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// HTTP — retry transient failures (429 / 5xx / network)
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status === 408 || status >= 500;
}

async function fetchWithRetry(url, init = {}, retries = config.maxRetries) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok || !isRetryableStatus(response.status) || attempt === retries) {
        return response;
      }

      lastError = new Error(`HTTP ${response.status}`);
      // Honor Retry-After when present
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : config.retryBaseMs * 2 ** attempt;
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(config.retryBaseMs * 2 ** attempt);
    }
  }

  throw lastError ?? new Error("Request failed");
}

async function fetchJson(url, init = {}) {
  const response = await fetchWithRetry(url, init);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Request failed: ${response.status} ${errorText}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Table discovery
// ---------------------------------------------------------------------------

/**
 * Service role can read PostgREST OpenAPI: each top-level path (not rpc / params)
 * is an exported table or view.
 */
async function discoverTablesWithServiceRole() {
  const spec = await fetchJson(`${config.supabaseUrl}/rest/v1/`, {
    headers: {
      ...baseHeaders,
      Accept: "application/openapi+json",
    },
  });

  const tables = new Set();

  for (const route of Object.keys(spec.paths ?? {})) {
    const name = route.replace(/^\//, "");
    if (!name || name.includes("{") || name.startsWith("rpc/")) continue;
    tables.add(name);
  }

  return [...tables].sort((a, b) => a.localeCompare(b));
}

async function discoverTables() {
  if (config.serviceRoleKey) {
    return {
      tables: await discoverTablesWithServiceRole(),
      mode: "service_role_auto_discovery",
    };
  }

  if (config.configuredTables.length > 0) {
    return {
      tables: config.configuredTables,
      mode: "configured_table_list",
    };
  }

  throw new Error(
    "Exporting all tables requires SUPABASE_SERVICE_ROLE_KEY. " +
      "If you only want specific tables, set SUPABASE_TABLES (comma-separated).",
  );
}

// ---------------------------------------------------------------------------
// Row fetch — PostgREST Range pagination
// ---------------------------------------------------------------------------

function safeFileName(tableName) {
  return `${tableName.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

/**
 * Fetches all rows for a table using Range: from-to pages of pageSize.
 * Stops when a page is empty or shorter than pageSize.
 */
async function fetchTableRows(tableName) {
  const rows = [];
  let from = 0;

  while (true) {
    const url = new URL(`${config.supabaseUrl}/rest/v1/${encodeURIComponent(tableName)}`);
    url.searchParams.set("select", "*");

    const response = await fetchWithRetry(url, {
      headers: {
        ...baseHeaders,
        Range: `${from}-${from + config.pageSize - 1}`,
        Prefer: "count=exact",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch table "${tableName}": ${response.status} ${errorText}`,
      );
    }

    const page = await response.json();
    if (!Array.isArray(page) || page.length === 0) break;

    rows.push(...page);

    // Content-Range: "0-999/1234" or "*/0"
    const contentRange = response.headers.get("content-range");
    const totalMatch = contentRange?.match(/\/(\d+|\*)$/);
    const total = totalMatch && totalMatch[1] !== "*" ? Number(totalMatch[1]) : null;

    if (page.length < config.pageSize) break;
    if (total !== null && rows.length >= total) break;

    from += page.length;
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Run async work over items with a fixed concurrency limit.
 * Preserves result order matching `items`.
 */
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

async function walkJsonFiles(dir) {
  const found = new Set();

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const file of await walkJsonFiles(absolutePath)) {
          found.add(file);
        }
      } else if (entry.name.endsWith(".json")) {
        found.add(absolutePath);
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") return found;
    throw error;
  }

  return found;
}

async function pruneDeletedFiles(expectedFiles) {
  const existing = await walkJsonFiles(config.outputRoot);

  for (const existingFile of existing) {
    const relative = path.relative(config.outputRoot, existingFile).replace(/\\/g, "/");
    if (!expectedFiles.has(relative)) {
      await unlink(existingFile);
      console.log(`  pruned obsolete file: ${relative}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function exportTable(tableName) {
  const rows = await fetchTableRows(tableName);
  const sanitized = sanitizeValue(rows);
  const fileName = safeFileName(tableName);
  const filePath = path.join(config.outputRoot, fileName);

  await writeFile(filePath, `${JSON.stringify(sanitized, null, 2)}\n`);

  return {
    table: tableName,
    row_count: rows.length,
    file: fileName,
    ok: true,
  };
}

async function main() {
  const started = Date.now();
  await mkdir(config.outputRoot, { recursive: true });

  const { tables, mode } = await discoverTables();
  console.log(
    `Discovery: ${tables.length} table(s) via ${mode} (concurrency=${config.concurrency})`,
  );

  const failures = [];

  const results = await mapPool(tables, config.concurrency, async (tableName) => {
    try {
      const entry = await exportTable(tableName);
      console.log(`  ✓ ${tableName} (${entry.row_count} rows)`);
      return entry;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ ${tableName}: ${message}`);
      failures.push({ table: tableName, error: message });
      return {
        table: tableName,
        row_count: 0,
        file: null,
        ok: false,
        error: message,
      };
    }
  });

  const succeeded = results.filter((r) => r.ok);

  // Keep manifest + successful exports; retain last-known files for failed tables
  const expectedFiles = new Set(["_manifest.json"]);
  for (const r of succeeded) expectedFiles.add(r.file);
  for (const f of failures) expectedFiles.add(safeFileName(f.table));

  await pruneDeletedFiles(expectedFiles);

  const manifest = {
    synced_at: new Date().toISOString(),
    table_count: succeeded.length,
    discovery_mode: mode,
    duration_ms: Date.now() - started,
    failures: failures.length > 0 ? failures : undefined,
    tables: succeeded
      .map(({ table, row_count, file }) => ({ table, row_count, file }))
      .sort((a, b) => a.table.localeCompare(b.table)),
  };

  await writeFile(config.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `Synced ${succeeded.length}/${tables.length} table(s) in ${manifest.duration_ms}ms.`,
  );

  if (failures.length > 0) {
    console.error(`${failures.length} table(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
