import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types.ts";

type ResetRequest = {
  tables?: string[] | string;
  dryRun?: boolean;
  dry_run?: boolean;
  confirm?: boolean | string;
};

const RESET_SECRET_HEADER = "x-reset-secret";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_TABLES = [
  "plan_actions",
  "capture_chunks",
  "plan_runs",
  "capture_entries",
] as const;

export async function handler(req: Request) {
  const requestId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  if (req.method !== "POST" && req.method !== "GET") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const resetSecret = Deno.env.get("RESET_SECRET") ?? "";
  if (!resetSecret) {
    console.log("[reset-test-data] missing RESET_SECRET", { requestId });
    return json({ ok: false, error: "Reset not configured" }, 500);
  }

  const providedSecret = req.headers.get(RESET_SECRET_HEADER) ?? "";
  if (!providedSecret || providedSecret !== resetSecret) {
    console.log("[reset-test-data] unauthorized", { requestId });
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRole = Deno.env.get("SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRole) {
    console.log("[reset-test-data] missing Supabase env", { requestId });
    return json({ ok: false, error: "Server not configured" }, 500);
  }

  const envMode = normalizeEnvMode(Deno.env.get("RESET_ENV") ?? Deno.env.get("APP_ENV") ?? Deno.env.get("NODE_ENV"));
  const projectRef = extractProjectRef(supabaseUrl);
  const allowedRefs = parseCsv(Deno.env.get("RESET_ALLOWED_PROJECT_REFS"));
  const projectAllowed = projectRef ? allowedRefs.includes(projectRef) : false;
  const isTestMode = isTestEnvironment(envMode);

  if (!isTestMode && !projectAllowed) {
    console.log("[reset-test-data] blocked by env guard", {
      requestId,
      envMode,
      projectRef,
      allowedRefs,
    });
    return json({ ok: false, error: "Reset disabled outside test mode" }, 403);
  }

  const payload: ResetRequest = req.method === "POST" ? (await safeJson(req)) as ResetRequest : {};
  const url = new URL(req.url);
  const requireConfirm = readBoolean(Deno.env.get("RESET_REQUIRE_CONFIRM"));
  const confirmed = readBoolean(payload.confirm ?? url.searchParams.get("confirm"));
  if (requireConfirm && !confirmed) {
    return json({ ok: false, error: "confirm=true required" }, 400);
  }

  const dryRun = readBoolean(
    payload.dryRun ??
      payload.dry_run ??
      url.searchParams.get("dryRun") ??
      url.searchParams.get("dry_run"),
  );

  const requestedTables = parseTables(payload.tables ?? url.searchParams.get("tables"));
  const { tables, unknownTables } = resolveTables(requestedTables);
  if (unknownTables.length > 0) {
    return json({ ok: false, error: `Unsupported tables: ${unknownTables.join(", ")}` }, 400);
  }

  console.log("[reset-test-data] start", {
    requestId,
    envMode,
    projectRef,
    tables,
    dryRun,
  });

  const admin = createClient<Database, "public">(supabaseUrl, serviceRole);
  const cleared: Record<string, number> = {};

  try {
    for (const table of tables) {
      cleared[table] = await countRows(admin, table);
    }

    if (!dryRun) {
      for (const table of tables) {
        await clearTable(admin, table);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("[reset-test-data] failed", { requestId, message });
    return json({ ok: false, error: message }, 500);
  }

  console.log("[reset-test-data] complete", { requestId, cleared, dryRun });

  return json({
    ok: true,
    cleared,
    timestamp: nowIso,
    mode: "test",
    dry_run: dryRun,
  });
}

if (import.meta.main) {
  Deno.serve(handler);
}

async function safeJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function normalizeEnvMode(value?: string | null) {
  return (value ?? "").trim().toLowerCase();
}

function isTestEnvironment(value: string) {
  return ["test", "testing", "dev", "development", "local"].includes(value);
}

function extractProjectRef(supabaseUrl: string) {
  try {
    const url = new URL(supabaseUrl);
    const [ref] = url.hostname.split(".");
    return ref ?? null;
  } catch {
    return null;
  }
}

function parseCsv(value?: string | null) {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseTables(value: unknown) {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return null;
}

function resolveTables(tables: string[] | null) {
  if (!tables || tables.length === 0) {
    return { tables: [...DEFAULT_TABLES], unknownTables: [] as string[] };
  }
  const allowlist = new Set(DEFAULT_TABLES);
  const unknownTables = tables.filter((table) => !allowlist.has(table));
  const requested = new Set(tables);
  const ordered = DEFAULT_TABLES.filter((table) => requested.has(table));
  return { tables: ordered, unknownTables };
}

function readBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["true", "1", "yes", "y", "testing"].includes(normalized);
  }
  return false;
}

async function countRows(
  admin: SupabaseClient<Database, "public">,
  table: (typeof DEFAULT_TABLES)[number],
) {
  const { count, error } = await admin.from(table).select("id", { count: "exact", head: true });
  if (error) {
    throw new Error(`Count failed for ${table}: ${error.message}`);
  }
  return count ?? 0;
}

async function clearTable(
  admin: SupabaseClient<Database, "public">,
  table: (typeof DEFAULT_TABLES)[number],
) {
  const { error } = await admin.from(table).delete().neq("id", ZERO_UUID);
  if (error) {
    throw new Error(`Delete failed for ${table}: ${error.message}`);
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
