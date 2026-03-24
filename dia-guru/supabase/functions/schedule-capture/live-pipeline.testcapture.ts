import { assert } from "std/assert";
import { handler } from "./index.ts";

type ScheduleAction = "schedule" | "reschedule" | "complete";

type LiveConfig = {
  userBearer: string;
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  googleClientId: string;
  googleClientSecret: string;
  captureId: string;
  action: ScheduleAction;
  allowOverlap: boolean;
  allowLatePlacement: boolean;
  timezone: string | null;
  timezoneOffsetMinutes: number | undefined;
  expectedStatuses: number[];
  extraBody: Record<string, unknown>;
};

const DEFAULT_LIVE_CAPTURE_ID = "";

function readEnvFirst(name: string, aliases: string[] = []): string | null {
  const candidates = [name, ...aliases];
  for (const candidate of candidates) {
    const value = (Deno.env.get(candidate) ?? "").trim();
    if (value) {
      if (candidate !== name && !Deno.env.get(name)) {
        Deno.env.set(name, value);
      }
      return value;
    }
  }
  return null;
}

function readOptionalEnv(name: string, aliases: string[] = []): string | null {
  const candidates = [name, ...aliases];
  for (const candidate of candidates) {
    const value = (Deno.env.get(candidate) ?? "").trim();
    if (value) return value;
  }
  return null;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = (Deno.env.get(name) ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "y";
}

function parseExpectedStatuses(raw: string | null): number[] {
  if (!raw) return [200, 409];
  const parsed = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 100 && value <= 599);
  return parsed.length > 0 ? parsed : [200, 409];
}

function parseExtraBody(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Keep default empty object for malformed JSON.
  }
  return {};
}

function decodeJwtPayload(token: string) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function maskSecret(value: string) {
  if (!value) return "<empty>";
  if (value.length <= 10) return `${value.slice(0, 2)}...`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function resolveConfig(): LiveConfig {
  const missing: string[] = [];
  const requireEnv = (name: string, aliases: string[] = []) => {
    const value = readEnvFirst(name, aliases);
    if (!value) {
      missing.push(name);
      return "";
    }
    return value;
  };
  const actionRaw = (
    readOptionalEnv("LIVE_SCHEDULE_ACTION", ["TEST_SCHEDULE_ACTION"]) ??
    "schedule"
  ).toLowerCase();
  const action: ScheduleAction =
    actionRaw === "complete" || actionRaw === "reschedule"
      ? actionRaw
      : "schedule";

  const timezoneOffsetRaw = readOptionalEnv("LIVE_TIMEZONE_OFFSET_MINUTES", [
    "TEST_TZ_OFFSET_MINUTES",
  ]);
  const timezoneOffsetMinutes =
    timezoneOffsetRaw && Number.isFinite(Number(timezoneOffsetRaw))
      ? Number(timezoneOffsetRaw)
      : undefined;

  const config: LiveConfig = {
    userBearer: requireEnv("TEST_USER_BEARER", ["USER_BEARER"]),
    supabaseUrl: requireEnv("SUPABASE_URL", ["EXPO_PUBLIC_SUPABASE_URL"]),
    anonKey: requireEnv("SUPABASE_ANON_KEY", [
      "ANON_KEY",
      "EXPO_PUBLIC_SUPABASE_ANON_KEY",
    ]),
    serviceRoleKey: requireEnv("SERVICE_ROLE_KEY"),
    googleClientId: requireEnv("GOOGLE_CLIENT_ID", [
      "EXPO_PUBLIC_GOOGLE_CLIENT_ID",
    ]),
    googleClientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
    captureId:
      readEnvFirst("LIVE_CAPTURE_ID", ["TEST_CAPTURE_ID", "CAPTURE_ID"]) ??
      DEFAULT_LIVE_CAPTURE_ID,
    action,
    allowOverlap: readBoolEnv("LIVE_ALLOW_OVERLAP", true),
    allowLatePlacement: readBoolEnv("LIVE_ALLOW_LATE_PLACEMENT", true),
    timezone: readOptionalEnv("LIVE_TIMEZONE", ["TEST_TIMEZONE"]),
    timezoneOffsetMinutes,
    expectedStatuses: parseExpectedStatuses(
      readOptionalEnv("LIVE_EXPECT_STATUSES"),
    ),
    extraBody: parseExtraBody(readOptionalEnv("LIVE_EXTRA_BODY_JSON")),
  };

  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. ` +
        "Set them and rerun `npm run deno:test:live:schedule-capture`.",
    );
  }

  return config;
}

function buildRequestBody(config: LiveConfig) {
  return {
    action: config.action,
    captureId: config.captureId,
    allowOverlap: config.allowOverlap,
    allowLatePlacement: config.allowLatePlacement,
    timezone: config.timezone,
    timezoneOffsetMinutes: config.timezoneOffsetMinutes,
    ...config.extraBody,
  };
}

function logRunContext(config: LiveConfig) {
  const serviceRolePayload = decodeJwtPayload(config.serviceRoleKey);
  console.log("[live-pipeline] config", {
    action: config.action,
    captureId: config.captureId,
    timezone: config.timezone,
    timezoneOffsetMinutes: config.timezoneOffsetMinutes,
    allowOverlap: config.allowOverlap,
    allowLatePlacement: config.allowLatePlacement,
    expectedStatuses: config.expectedStatuses,
    supabaseUrl: config.supabaseUrl,
    anonKey: maskSecret(config.anonKey),
    userBearer: maskSecret(config.userBearer),
    googleClientId: maskSecret(config.googleClientId),
    serviceRole: serviceRolePayload
      ? {
          iss: serviceRolePayload.iss,
          role: serviceRolePayload.role,
          ref: serviceRolePayload.ref,
        }
      : "<unreadable>",
  });
}

export async function runLiveScheduleCapturePipeline(config = resolveConfig()) {
  logRunContext(config);
  const requestBody = buildRequestBody(config);
  console.log("[live-pipeline] request-body", requestBody);

  const req = new Request("http://localhost/functions/v1/schedule-capture", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.userBearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const started = performance.now();
  const res = await handler(req);
  const elapsedMs = Math.round(performance.now() - started);
  const data = await res.json().catch(() => ({}));

  console.log("[live-pipeline] response", {
    status: res.status,
    ok: res.ok,
    elapsedMs,
    body: data,
  });

  const isExpected = config.expectedStatuses.includes(res.status);
  assert(
    isExpected,
    `Unexpected status ${res.status}. Expected one of [${config.expectedStatuses.join(
      ", ",
    )}]. Response: ${JSON.stringify(data, null, 2)}`,
  );
  assert(
    data && (data.message || data.decision || data.error),
    `Response missing message/decision/error: ${JSON.stringify(data, null, 2)}`,
  );
}

Deno.test("schedule-capture live pipeline", async () => {
  await runLiveScheduleCapturePipeline();
});
