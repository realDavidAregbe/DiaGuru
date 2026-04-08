#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const process = require("node:process");
const { createClient } = require("@supabase/supabase-js");

const suitePath = path.join(__dirname, "benchmark-suite.json");
const suite = JSON.parse(fs.readFileSync(suitePath, "utf8"));
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMESTAMP_KEYS = [
  "constraint_time",
  "constraint_end",
  "deadline_at",
  "window_start",
  "window_end",
  "original_target_time",
  "start_target_at",
  "preferredStart",
  "preferredEnd",
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!key || process.env[key]) continue;
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    process.env[key] = value;
  }
}

function ensureDefaultEnv() {
  loadEnvFile(path.resolve(__dirname, "../.env"));
  loadEnvFile(path.resolve(__dirname, "../../../.env"));
}

ensureDefaultEnv();

function readBoolEnv(name, fallback) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "y";
}

function readOptionalEnv(name, fallback = "") {
  const raw = String(process.env[name] ?? "").trim();
  return raw || fallback;
}

function parseArgs(argv) {
  const options = {
    keepData: readBoolEnv("BENCHMARK_KEEP_DATA", false),
    list: false,
    scenarios: [],
  };

  for (const arg of argv) {
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--keep-data") {
      options.keepData = true;
      continue;
    }
    options.scenarios.push(arg);
  }

  if (options.scenarios.length === 0) {
    const raw = String(process.env.BENCHMARK_SCENARIOS ?? "").trim();
    if (raw) {
      options.scenarios = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }

  return options;
}

function printSuiteGuidance() {
  const requiredSetup = Array.isArray(suite.meta?.requiredSetup)
    ? suite.meta.requiredSetup
    : [];
  if (requiredSetup.length > 0) {
    console.log("[benchmark] required setup:");
    for (const item of requiredSetup) {
      const status = String(item?.status ?? "note").toUpperCase();
      const instruction = String(item?.instruction ?? "").trim();
      if (!instruction) continue;
      console.log(`[benchmark] - ${status}: ${instruction}`);
    }
  }

  const criticalLiveScenarios = Array.isArray(
    suite.meta?.verificationGuide?.criticalLiveScenarios,
  )
    ? suite.meta.verificationGuide.criticalLiveScenarios
    : [];
  if (criticalLiveScenarios.length > 0) {
    console.log("[benchmark] critical live scenarios:");
    for (const scenario of criticalLiveScenarios) {
      console.log(
        `[benchmark] - ${scenario.id}: ${String(scenario.why ?? "").trim()}`,
      );
    }
  }

  const isolatedPolicyTests = Array.isArray(
    suite.meta?.verificationGuide?.isolatedPolicyTests,
  )
    ? suite.meta.verificationGuide.isolatedPolicyTests
    : [];
  if (isolatedPolicyTests.length > 0) {
    console.log("[benchmark] isolated policy tests:");
    for (const testName of isolatedPolicyTests) {
      console.log(`[benchmark] - ${String(testName).trim()}`);
    }
  }
}

function requireEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function getTimeZoneOffsetMinutes(timeZone, referenceDate = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(referenceDate)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const zonedUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return Math.round((zonedUtc - referenceDate.getTime()) / 60000);
  } catch {
    return undefined;
  }
}

function formatLocalDateInTimeZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function shiftIsoString(value, deltaMs) {
  if (typeof value !== "string" || !value.trim()) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Date(parsed.getTime() + deltaMs).toISOString();
}

function collectScenarioTimestamps(scenario) {
  const timestamps = [];

  for (const capture of scenario.captures ?? []) {
    for (const key of TIMESTAMP_KEYS) {
      const value = capture[key];
      if (typeof value !== "string") continue;
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        timestamps.push(parsed);
      }
    }
  }

  for (const step of scenario.steps ?? []) {
    const options = step?.options ?? {};
    for (const key of ["preferredStart", "preferredEnd"]) {
      const value = options[key];
      if (typeof value !== "string") continue;
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        timestamps.push(parsed);
      }
    }
  }

  return timestamps;
}

function collectScenarioLocalDates(scenario, timeZone) {
  const timestamps = collectScenarioTimestamps(scenario);
  const dates = new Set();
  for (const timestamp of timestamps) {
    dates.add(formatLocalDateInTimeZone(timestamp, timeZone));
  }
  return Array.from(dates).sort();
}

function materializeScenario(scenario, referenceNow = new Date()) {
  const timestamps = collectScenarioTimestamps(scenario);
  if (timestamps.length === 0) {
    return JSON.parse(JSON.stringify(scenario));
  }

  timestamps.sort((a, b) => a.getTime() - b.getTime());
  const anchor = timestamps[0];
  const targetAnchor = new Date(referenceNow.getTime() + 24 * 60 * 60 * 1000);
  targetAnchor.setUTCHours(
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
  const deltaMs = targetAnchor.getTime() - anchor.getTime();

  const clone = JSON.parse(JSON.stringify(scenario));
  clone.captures = (clone.captures ?? []).map((capture) => {
    const shifted = { ...capture };
    for (const key of TIMESTAMP_KEYS) {
      if (key in shifted) {
        shifted[key] = shiftIsoString(shifted[key], deltaMs);
      }
    }
    return shifted;
  });
  clone.steps = (clone.steps ?? []).map((step) => {
    if (!step?.options) return step;
    const shiftedOptions = { ...step.options };
    for (const key of ["preferredStart", "preferredEnd"]) {
      if (key in shiftedOptions) {
        shiftedOptions[key] = shiftIsoString(shiftedOptions[key], deltaMs);
      }
    }
    return {
      ...step,
      options: shiftedOptions,
    };
  });
  clone._benchmarkAnchor = targetAnchor.toISOString();
  clone._benchmarkDeltaMs = deltaMs;
  return clone;
}

function buildCaptureRecord(source, scenarioId, userId) {
  const id = crypto.randomUUID();
  const rawImportance = source.importance ?? source.urgency ?? source.impact ?? 3;
  const normalizedImportance = Math.max(1, Math.min(5, Number(rawImportance) || 1));
  const importance = normalizedImportance >= 4
    ? 3
    : normalizedImportance >= 2
    ? 2
    : 1;
  const isDeadline = source.constraint_type === "deadline_time";
  const isStart = source.constraint_type === "start_time";
  const nowIso = new Date().toISOString();

  return {
    id,
    user_id: userId,
    content: source.content,
    estimated_minutes: source.estimated_minutes,
    importance,
    urgency: source.urgency ?? importance,
    impact: source.impact ?? importance,
    reschedule_penalty: source.reschedule_penalty ?? 0,
    blocking: source.blocking ?? false,
    status: "pending",
    scheduled_for: null,
    created_at: nowIso,
    updated_at: nowIso,
    calendar_event_id: null,
    calendar_event_etag: null,
    planned_start: null,
    planned_end: null,
    last_check_in: null,
    scheduling_notes: JSON.stringify({
      fixture: true,
      suite: suite.meta.name,
      scenario: scenarioId,
      alias: source.alias,
    }),
    constraint_type: source.constraint_type ?? "flexible",
    constraint_time: source.constraint_time ?? null,
    constraint_end: source.constraint_end ?? null,
    constraint_date: source.constraint_date ?? null,
    original_target_time: isStart ? source.constraint_time ?? null : null,
    deadline_at: source.deadline_at ?? (isDeadline ? source.constraint_time ?? null : null),
    window_start: source.window_start ?? null,
    window_end: source.window_end ?? (isDeadline ? source.constraint_time ?? null : null),
    start_target_at: isStart ? source.constraint_time ?? null : null,
    is_soft_start:
      typeof source.is_soft_start === "boolean"
        ? source.is_soft_start
        : (source.start_flexibility ?? "soft") === "soft",
    externality_score: source.externality_score ?? 0,
    reschedule_count: 0,
    task_type_hint: source.task_type_hint ?? "task",
    freeze_until: null,
    plan_id: null,
    manual_touch_at: null,
    cannot_overlap: source.cannot_overlap ?? false,
    start_flexibility: source.start_flexibility ?? "soft",
    duration_flexibility: source.duration_flexibility ?? "fixed",
    min_chunk_minutes: source.min_chunk_minutes ?? 15,
    max_splits: source.max_splits ?? null,
    extraction_kind: source.task_type_hint ?? "task",
    time_pref_time_of_day: source.time_pref_time_of_day ?? null,
    time_pref_day: source.time_pref_day ?? "today",
    importance_rationale: source.importance_rationale ?? null,
  };
}

function deriveOutcome(responseBody, captureId) {
  const decision = responseBody?.decision ?? null;
  const capture = responseBody?.capture ?? null;
  const planActions = Array.isArray(responseBody?.planSummary?.actions)
    ? responseBody.planSummary.actions
    : [];
  const conflictCaptureIds = Array.isArray(decision?.conflicts)
    ? decision.conflicts
        .map((item) => item?.captureId)
        .filter((value) => typeof value === "string")
    : [];

  if (decision?.type === "preferred_conflict") {
    return {
      actionTypes: planActions.map((action) => action?.actionType).filter(Boolean),
      conflictCaptureIds,
      outcome: "preferred_conflict",
      suggestion: Boolean(decision?.suggestion),
    };
  }

  if (capture?.status === "scheduled") {
    const displaced = planActions.some(
      (action) =>
        action?.captureId &&
        action.captureId !== captureId &&
        (action.actionType === "unscheduled" || action.actionType === "rescheduled"),
    );

    return {
      actionTypes: planActions.map((action) => action?.actionType).filter(Boolean),
      conflictCaptureIds,
      outcome: responseBody?.overlap
        ? "overlap_scheduled"
        : displaced
          ? "rebalanced_scheduled"
          : "scheduled",
      suggestion: false,
    };
  }

  return {
    actionTypes: planActions.map((action) => action?.actionType).filter(Boolean),
    conflictCaptureIds,
    outcome: "unknown",
    suggestion: false,
  };
}

function describeExpectation(expectation) {
  if (!expectation) return "no expectation";
  const fragments = [];
  if (Array.isArray(expectation.outcomes) && expectation.outcomes.length > 0) {
    fragments.push(`outcomes=${expectation.outcomes.join("|")}`);
  }
  if (expectation.requiresSuggestion) {
    fragments.push("requiresSuggestion=true");
  }
  if (Array.isArray(expectation.conflictCaptures) && expectation.conflictCaptures.length > 0) {
    fragments.push(`conflicts=${expectation.conflictCaptures.join(",")}`);
  }
  if (expectation.note) {
    fragments.push(`note=${expectation.note}`);
  }
  return fragments.join(" ; ");
}

function evaluateExpectation(expectation, actual, aliasToId) {
  if (!expectation) return { passed: true, reasons: [] };

  const reasons = [];
  if (Array.isArray(expectation.outcomes) && expectation.outcomes.length > 0) {
    if (!expectation.outcomes.includes(actual.outcome)) {
      reasons.push(`expected outcome ${expectation.outcomes.join("|")} but got ${actual.outcome}`);
    }
  }

  if (expectation.requiresSuggestion && !actual.suggestion) {
    reasons.push("expected a fallback suggestion");
  }

  if (Array.isArray(expectation.conflictCaptures) && expectation.conflictCaptures.length > 0) {
    const expectedIds = expectation.conflictCaptures
      .map((alias) => aliasToId.get(alias))
      .filter(Boolean);
    const actualIds = new Set(actual.conflictCaptureIds);
    for (const expectedId of expectedIds) {
      if (!actualIds.has(expectedId)) {
        reasons.push(`expected conflict with ${expectation.conflictCaptures.join(",")}`);
        break;
      }
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
  };
}

function resolveAliases(aliasToId, ids) {
  return ids.map((id) => {
    for (const [alias, mappedId] of aliasToId.entries()) {
      if (mappedId === id) return alias;
    }
    return id;
  });
}

async function fetchRow(admin, captureId) {
  const { data, error } = await admin
    .from("capture_entries")
    .select("id,status,calendar_event_id")
    .eq("id", captureId)
    .single();

  if (error || !data) return null;
  return data;
}

async function clearBenchmarkDay(clearUrl, secret, isoDate) {
  const response = await fetch(clearUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: isoDate, secret }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Benchmark clear failed for ${isoDate} (status ${response.status}): ${JSON.stringify(json)}`,
    );
  }
  return json;
}

function zonedLocalDateTimeToUtc(isoDate, timeZone, hour, minute, second) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const reference = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, reference) ?? 0;
  const utcMs =
    Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  return new Date(utcMs);
}

async function ensureGoogleCredentials(context) {
  if (context.googleCredentials) return context.googleCredentials;
  if (!context.googleClientId || !context.googleClientSecret) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET for direct benchmark calendar cleanup.",
    );
  }

  const { data: account, error: accountError } = await context.admin
    .from("calendar_accounts")
    .select("id")
    .eq("user_id", context.userId)
    .eq("provider", "google")
    .single();

  if (accountError || !account) {
    throw new Error(`Failed to load Google calendar account: ${accountError?.message ?? "missing"}`);
  }

  const { data: tokenRow, error: tokenError } = await context.admin
    .from("calendar_tokens")
    .select("access_token,refresh_token,expiry")
    .eq("account_id", account.id)
    .single();

  if (tokenError || !tokenRow?.access_token) {
    throw new Error(`Failed to load Google calendar token: ${tokenError?.message ?? "missing"}`);
  }

  context.googleCredentials = {
    accountId: account.id,
    accessToken: tokenRow.access_token,
    refreshToken: tokenRow.refresh_token ?? null,
    expiry: tokenRow.expiry ?? null,
  };
  return context.googleCredentials;
}

async function refreshGoogleCredentials(context, credentials) {
  if (!credentials.refreshToken) {
    throw new Error("Google refresh token is missing for benchmark cleanup.");
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: context.googleClientId,
      client_secret: context.googleClientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload?.access_token !== "string") {
    throw new Error(`Failed to refresh Google token for benchmark cleanup: ${JSON.stringify(payload)}`);
  }

  credentials.accessToken = payload.access_token;
  credentials.refreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token.trim().length > 0
      ? payload.refresh_token
      : credentials.refreshToken;
  credentials.expiry =
    typeof payload.expires_in === "number"
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : credentials.expiry;

  await context.admin
    .from("calendar_tokens")
    .update({
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      expiry: credentials.expiry,
    })
    .eq("account_id", credentials.accountId);
}

async function runGoogleOperation(context, operation) {
  const credentials = await ensureGoogleCredentials(context);
  const expiryMs = credentials.expiry ? Date.parse(credentials.expiry) : NaN;
  if (!Number.isNaN(expiryMs) && expiryMs <= Date.now() + 60_000) {
    await refreshGoogleCredentials(context, credentials);
  }

  let retried = false;
  while (true) {
    const response = await operation(credentials.accessToken);
    if (response.status !== 401 || retried || !credentials.refreshToken) {
      return response;
    }
    await refreshGoogleCredentials(context, credentials);
    retried = true;
  }
}

async function clearBenchmarkDayDirect(context, isoDate, timeZone) {
  const start = zonedLocalDateTimeToUtc(isoDate, timeZone, 0, 0, 0);
  const end = zonedLocalDateTimeToUtc(isoDate, timeZone, 23, 59, 59);
  const eventsUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    context.benchmarkCalendarId,
  )}/events`;
  const listUrl = new URL(eventsUrl);
  listUrl.searchParams.set("singleEvents", "true");
  listUrl.searchParams.set("orderBy", "startTime");
  listUrl.searchParams.set("timeMin", start.toISOString());
  listUrl.searchParams.set("timeMax", end.toISOString());
  listUrl.searchParams.set("maxResults", "250");

  const listResponse = await runGoogleOperation(context, (accessToken) =>
    fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    }));
  const listJson = await listResponse.json().catch(() => ({}));
  if (!listResponse.ok) {
    throw new Error(
      `Benchmark direct clear list failed for ${isoDate} (status ${listResponse.status}): ${JSON.stringify(listJson)}`,
    );
  }

  const items = Array.isArray(listJson?.items) ? listJson.items : [];
  let deleted = 0;
  for (const event of items) {
    if (!event?.id) continue;
    const deleteResponse = await runGoogleOperation(context, (accessToken) =>
      fetch(`${eventsUrl}/${event.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      }));
    if (deleteResponse.ok || deleteResponse.status === 404) {
      deleted += 1;
      continue;
    }
    const deleteJson = await deleteResponse.json().catch(() => ({}));
    throw new Error(
      `Benchmark direct clear delete failed for ${isoDate}/${event.id} (status ${deleteResponse.status}): ${JSON.stringify(deleteJson)}`,
    );
  }

  return { deleted, date: isoDate };
}

async function clearBenchmarkScenarioDays(context, scenario, scenarioTimezone) {
  const effectiveTimeZone =
    scenarioTimezone || context.timezone || suite.meta.referenceTimezone || "UTC";
  if (!context.benchmarkCalendarId) return;
  const dates = collectScenarioLocalDates(
    scenario,
    effectiveTimeZone,
  );
  for (const isoDate of dates) {
    const result = context.benchmarkClearUrl && context.benchmarkSecret
      ? await clearBenchmarkDay(
          context.benchmarkClearUrl,
          context.benchmarkSecret,
          isoDate,
        )
      : await clearBenchmarkDayDirect(context, isoDate, effectiveTimeZone);
    console.log(
      `[benchmark] cleared ${isoDate} deleted=${Number(result?.deleted ?? 0)}`,
    );
  }
}

async function invokeFunction(functionUrl, anonKey, userBearer, body) {
  const headers = {
    Authorization: `Bearer ${userBearer}`,
    "Content-Type": "application/json",
  };

  if (anonKey) {
    headers.apikey = anonKey;
  }

  const response = await fetch(functionUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));

  return {
    body: json,
    ok: response.ok,
    status: response.status,
  };
}

async function cleanupScenario(
  admin,
  functionUrl,
  anonKey,
  userBearer,
  captureIds,
  keepData,
  benchmarkSecret,
) {
  if (keepData || captureIds.length === 0) return;

  for (const captureId of captureIds) {
    const row = await fetchRow(admin, captureId);
    if (row?.status === "scheduled" || row?.calendar_event_id) {
      await invokeFunction(functionUrl, anonKey, userBearer, {
        action: "complete",
        captureId,
        ...(benchmarkSecret ? { benchmarkSecret } : {}),
      }).catch(() => null);
    }
  }

  await admin.from("capture_entries").delete().in("id", captureIds);
}

async function runScenario(scenario, context) {
  const materialized = materializeScenario(scenario);
  const scenarioTimezone =
    scenario.timezone ??
    suite.meta.referenceTimezone ??
    context.timezone ??
    null;
  const scenarioOffsetMinutes =
    typeof scenario.timezoneOffsetMinutes === "number"
      ? scenario.timezoneOffsetMinutes
      : typeof context.timezoneOffsetMinutes === "number"
      ? context.timezoneOffsetMinutes
      : scenarioTimezone
      ? getTimeZoneOffsetMinutes(
          scenarioTimezone,
          materialized._benchmarkAnchor
            ? new Date(materialized._benchmarkAnchor)
            : new Date(),
        )
      : undefined;
  const aliasToId = new Map();
  const captureIds = [];
  const results = [];

  console.log(
    `[benchmark] ${scenario.id} anchor=${materialized._benchmarkAnchor ?? "<static>"} timezone=${scenarioTimezone ?? "<none>"} offset=${scenarioOffsetMinutes ?? "<none>"}`,
  );

  await clearBenchmarkScenarioDays(context, materialized, scenarioTimezone);

  for (const capture of materialized.captures) {
    const record = buildCaptureRecord(capture, scenario.id, context.userId);
    const { error } = await context.admin.from("capture_entries").insert(record);
    if (error) {
      throw new Error(`Insert failed for ${scenario.id}/${capture.alias}: ${error.message}`);
    }
    aliasToId.set(capture.alias, record.id);
    captureIds.push(record.id);
  }

  try {
    for (let index = 0; index < scenario.steps.length; index += 1) {
      const step = materialized.steps[index];
      const stepLabel = `${scenario.id}#${index + 1}`;

      if (step.type === "freeze") {
        const captureId = aliasToId.get(step.capture);
        const freezeUntil = new Date(Date.now() + (step.hours ?? 24) * 60 * 60 * 1000).toISOString();
        const { error } = await context.admin
          .from("capture_entries")
          .update({ freeze_until: freezeUntil })
          .eq("id", captureId);
        if (error) {
          throw new Error(`Freeze failed for ${stepLabel}: ${error.message}`);
        }
        console.log(`[benchmark] ${stepLabel} froze ${step.capture} until ${freezeUntil}`);
        continue;
      }

      if (step.type !== "schedule") {
        throw new Error(`Unsupported step type: ${step.type}`);
      }

      const captureId = aliasToId.get(step.capture);
      const body = {
        action: "schedule",
        captureId,
        timezone: scenarioTimezone,
        timezoneOffsetMinutes: scenarioOffsetMinutes,
        ...(context.benchmarkSecret ? { benchmarkSecret: context.benchmarkSecret } : {}),
        ...(step.options ?? {}),
      };

      const response = await invokeFunction(
        context.functionUrl,
        context.anonKey,
        context.userBearer,
        body,
      );
      const actual = deriveOutcome(response.body, captureId);
      const evaluation = evaluateExpectation(step.expect, actual, aliasToId);
      const conflictAliases = resolveAliases(aliasToId, actual.conflictCaptureIds);

      console.log(
        `[benchmark] ${stepLabel} ${step.capture} -> ${actual.outcome}` +
          ` status=${response.status}` +
          (actual.suggestion ? " suggestion=yes" : "") +
          (conflictAliases.length > 0 ? ` conflicts=${conflictAliases.join(",")}` : ""),
      );
      console.log(`[benchmark] ${stepLabel} expect ${describeExpectation(step.expect)}`);
      if (!evaluation.passed) {
        console.log(`[benchmark] ${stepLabel} mismatch ${evaluation.reasons.join(" | ")}`);
      }

      results.push({
        capture: step.capture,
        label: stepLabel,
        passed: evaluation.passed,
        reasons: evaluation.reasons,
        response,
      });
    }
  } finally {
    await cleanupScenario(
      context.admin,
      context.functionUrl,
      context.anonKey,
      context.userBearer,
      captureIds,
      context.keepData,
      context.benchmarkSecret,
    );
  }

  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    console.log(suite.meta.name);
    printSuiteGuidance();
    for (const scenario of suite.scenarios) {
      console.log(`${scenario.id} - ${scenario.description}`);
    }
    return;
  }

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SERVICE_ROLE_KEY");
  const userId = requireEnv("USER_ID");
  const userBearer = requireEnv("USER_BEARER");
  const anonKey = String(process.env.SUPABASE_ANON_KEY ?? "").trim();
  const functionUrl =
    process.env.FUNCTION_URL ??
    `${supabaseUrl.replace(/\/$/, "")}/functions/v1/schedule-capture`;
  const timezone = String(process.env.TIMEZONE ?? "").trim() || null;
  const timezoneOffsetMinutes = String(process.env.TZ_OFFSET_MINUTES ?? "").trim()
    ? Number(process.env.TZ_OFFSET_MINUTES)
    : undefined;
  const benchmarkCalendarId = readOptionalEnv("BENCHMARK_GOOGLE_CALENDAR_ID");
  const benchmarkSecret = readOptionalEnv("BENCHMARK_SHARED_SECRET");
  const benchmarkClearUrl = readOptionalEnv("BENCHMARK_CLEAR_URL");
  const googleClientId = readOptionalEnv("GOOGLE_CLIENT_ID");
  const googleClientSecret = readOptionalEnv("GOOGLE_CLIENT_SECRET");

  const selectedIds =
    options.scenarios.length > 0 ? options.scenarios : suite.scenarios.map((scenario) => scenario.id);
  const selectedScenarios = selectedIds.map((scenarioId) => {
    const scenario = suite.scenarios.find((entry) => entry.id === scenarioId);
    if (!scenario) {
      throw new Error(`Unknown scenario id: ${scenarioId}`);
    }
    return scenario;
  });

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const context = {
    admin,
    anonKey,
    functionUrl,
    keepData: options.keepData,
    timezone,
    timezoneOffsetMinutes,
    userBearer,
    userId,
    benchmarkCalendarId,
    benchmarkClearUrl,
    benchmarkSecret,
    googleClientId,
    googleClientSecret,
  };

  console.log(
    `[benchmark] suite=${suite.meta.name} scenarios=${selectedScenarios
      .map((scenario) => scenario.id)
      .join(",")}`,
  );
  console.log(`[benchmark] keepData=${context.keepData} timezone=${context.timezone ?? "<none>"}`);
  console.log(
    `[benchmark] calendarScope=${
      context.benchmarkSecret && context.benchmarkCalendarId ? "benchmark" : "default"
    } calendarId=${context.benchmarkCalendarId || "<default>"}`,
  );
  if (!context.benchmarkSecret || !context.benchmarkCalendarId) {
    console.log(
      "[benchmark] benchmark calendar override is not fully configured; runs may hit the default calendar.",
    );
  }
  if (context.benchmarkClearUrl) {
    console.log("[benchmark] benchmark day clear hook configured");
  }
  printSuiteGuidance();

  let passed = 0;
  let failed = 0;

  for (const scenario of selectedScenarios) {
    console.log(`\n[benchmark] scenario ${scenario.id}`);
    console.log(`[benchmark] ${scenario.description}`);
    const results = await runScenario(scenario, context);
    for (const result of results) {
      if (result.passed) {
        passed += 1;
      } else {
        failed += 1;
      }
    }
  }

  console.log(`\n[benchmark] summary passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
