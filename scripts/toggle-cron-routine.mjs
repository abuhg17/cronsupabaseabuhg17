/**
 * Odd/even hour routine toggle (writes to Supabase, not only local JSON)
 *
 * - Odd hours  (1,3,5…): insert a marker row into `routine` if missing
 * - Even hours (0,2,4…): delete all marker rows previously inserted
 *
 * Marker rows are identified by note === MARKER (safe to find/delete).
 * Hour is evaluated in ROUTINE_TZ (default Asia/Taipei).
 */

const MARKER = "__CRON_ROUTINE_TOGGLE__";
const MARKER_NAME_PREFIX = "[cron] 奇數小時標記";

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
      "Missing API key. Add SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY.",
    );
  }

  return {
    supabaseUrl,
    apiKey,
    timeZone: process.env.ROUTINE_TZ || "Asia/Taipei",
    table: process.env.ROUTINE_TABLE || "routine",
    maxRetries: Number(process.env.SYNC_MAX_RETRIES) || 3,
    retryBaseMs: Number(process.env.SYNC_RETRY_BASE_MS) || 500,
  };
}

const config = loadConfig();

const baseHeaders = {
  apikey: config.apiKey,
  Authorization: `Bearer ${config.apiKey}`,
  "Content-Type": "application/json",
};

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
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : config.retryBaseMs * 2 ** attempt;
      await sleep(delay);
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(config.retryBaseMs * 2 ** attempt);
    }
  }

  throw lastError ?? new Error("Request failed");
}

function tableUrl(extraSearch = "") {
  const url = new URL(
    `${config.supabaseUrl}/rest/v1/${encodeURIComponent(config.table)}`,
  );
  if (extraSearch) {
    const params = new URLSearchParams(extraSearch);
    for (const [k, v] of params) url.searchParams.set(k, v);
  }
  return url;
}

/** Current hour 0–23 in the configured timezone. */
function currentHour(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  if (!Number.isFinite(hour)) {
    throw new Error(`Unable to resolve hour for timezone ${timeZone}`);
  }
  return hour;
}

async function listMarkerRows() {
  const url = tableUrl();
  url.searchParams.set("select", "id,name,note,created_at");
  url.searchParams.set("note", `eq.${MARKER}`);

  const response = await fetchWithRetry(url, {
    headers: {
      ...baseHeaders,
      Prefer: "count=exact",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`List marker rows failed: ${response.status} ${text}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

async function insertMarker(hour, timeZone) {
  const now = new Date();
  const stamp = now.toISOString();
  const body = {
    name: `${MARKER_NAME_PREFIX} ${String(hour).padStart(2, "0")}:00`,
    note: MARKER,
    lastdate1: stamp,
    link: null,
    photo: null,
  };

  const response = await fetchWithRetry(tableUrl(), {
    method: "POST",
    headers: {
      ...baseHeaders,
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Insert marker failed: ${response.status} ${text}`);
  }

  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : rows;
  console.log(
    `Inserted routine marker id=${row?.id ?? "?"} name="${body.name}" (${timeZone} hour=${hour})`,
  );
  return row;
}

async function deleteMarkers() {
  const url = tableUrl();
  url.searchParams.set("note", `eq.${MARKER}`);

  const response = await fetchWithRetry(url, {
    method: "DELETE",
    headers: {
      ...baseHeaders,
      Prefer: "return=representation",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Delete markers failed: ${response.status} ${text}`);
  }

  const deleted = await response.json();
  const count = Array.isArray(deleted) ? deleted.length : 0;
  if (count === 0) {
    console.log("No marker routine rows to delete.");
  } else {
    const ids = deleted.map((r) => r.id).join(", ");
    console.log(`Deleted ${count} marker routine row(s): id=${ids}`);
  }
  return count;
}

async function main() {
  const hour = currentHour(config.timeZone);
  const isOddHour = hour % 2 === 1;

  console.log(
    `Routine toggle: tz=${config.timeZone} hour=${hour} mode=${isOddHour ? "INSERT (odd)" : "DELETE (even)"}`,
  );

  if (isOddHour) {
    const existing = await listMarkerRows();
    if (existing.length > 0) {
      console.log(
        `Marker already present (${existing.length}); skip insert. ids=${existing.map((r) => r.id).join(", ")}`,
      );
      return;
    }
    await insertMarker(hour, config.timeZone);
    return;
  }

  await deleteMarkers();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
