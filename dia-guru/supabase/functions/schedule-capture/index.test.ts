import type { CaptureEntryRow } from "../types.ts";
import { computeSchedulingPlan } from "./scheduling-core.ts";
import { handler } from "./index.ts";
import { assert, assertEquals } from "std/assert"; // if you're on Deno
import { mapExtractionToCapture } from "../parse-task/index.ts";

// or the equivalent for Jest/Vitest
type Extraction = Parameters<typeof mapExtractionToCapture>[0];

function makeCapture(
  overrides: Partial<CaptureEntryRow> = {},
): CaptureEntryRow {
  const base: CaptureEntryRow = {
    id: "cap_1",
    user_id: "user_1",
    content: "Test capture",
    estimated_minutes: 60,
    importance: 1,
    urgency: null,
    impact: null,
    reschedule_penalty: null,
    blocking: false,
    status: "pending",
    scheduled_for: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    calendar_event_id: null,
    calendar_event_etag: null,
    planned_start: null,
    planned_end: null,
    last_check_in: null,
    scheduling_notes: null,
    constraint_type: "flexible",
    constraint_time: null,
    constraint_end: null,
    constraint_date: null,
    original_target_time: null,
    deadline_at: null,
    window_start: null,
    window_end: null,
    start_target_at: null,
    is_soft_start: false,
    cannot_overlap: false,
    start_flexibility: "soft",
    duration_flexibility: "fixed",
    min_chunk_minutes: null,
    max_splits: null,
    extraction_kind: null,
    time_pref_time_of_day: null,
    time_pref_day: null,
    importance_rationale: null,
    externality_score: 0,
    reschedule_count: 0,
    task_type_hint: null,
    freeze_until: null,
    plan_id: null,
    manual_touch_at: null,
  };

  return { ...base, ...overrides } as CaptureEntryRow;
}

function makeExtraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    title: null,
    estimated_minutes: null,
    deadline: null,
    scheduled_time: null,
    execution_window: null,
    time_preferences: null,
    missing: [],
    clarifying_question: null,
    notes: [],
    kind: null,
    importance: null,
    flexibility: null,
    policy: null,
    ...overrides,
  };
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

// Deno.test("collectConflictingEvents relaxes buffer for in-progress events", () => {
//   const now = new Date("2025-01-01T10:30:00Z");
//   const event = makeEvent("2025-01-01T10:00:00Z", "2025-01-01T11:00:00Z");

//   // slot that starts just after the event *end* — should be OK if tail buffer = 0
//   const justAfter = slot("2025-01-01T11:00:00Z", "2025-01-01T11:30:00Z");

//   const conflicts = collectConflictingEvents(justAfter, [event], now);
//   assertEquals(conflicts.length, 0);
// });

// Deno.test("collectConflictingEvents still blocks overlapping slots during event", () => {
//   const now = new Date("2025-01-01T10:30:00Z");
//   const event = makeEvent("2025-01-01T10:00:00Z", "2025-01-01T11:00:00Z");

//   const overlapping = slot("2025-01-01T10:45:00Z", "2025-01-01T11:15:00Z");
//   const conflicts = collectConflictingEvents(overlapping, [event], now);

//   assertEquals(conflicts.length, 1);
//   assertEquals(conflicts[0].id, event.id);
// });

// Deno.test("computeSchedulingPlan: deadline_time builds a deadline plan", () => {
//   const capture = makeCapture({
//     constraint_type: "deadline_time",
//     constraint_time: "2025-01-01T18:00:00Z",
//   });

//   const plan = computeSchedulingPlan(capture, 60, 0, new Date("2025-01-01T10:00:00Z"));

//   assertEquals(plan.mode, "deadline");
//   assert(plan.deadline);
//   assertEquals(plan.deadline!.toISOString(), "2025-01-01T18:00:00.000Z");
// });

// Deno.test("computeSchedulingPlan: start_time builds a start plan at or after now", () => {
//   const capture = makeCapture({
//     constraint_type: "start_time",
//     constraint_time: "2025-01-01T10:00:00Z",
//   });

//   const referenceNow = new Date("2025-01-01T09:00:00Z");
//   const plan = computeSchedulingPlan(capture, 60, 0, referenceNow);

//   assertEquals(plan.mode, "start");
//   assert(plan.preferredSlot);
//   assertEquals(plan.preferredSlot!.start.toISOString(), "2025-01-01T10:00:00.000Z");
// });

// // Deno.test("findNextAvailableSlot respects busy intervals and working window", () => {
// //   const now = new Date("2025-01-01T09:00:00Z");
// //   const events = [
// //     makeEvent("2025-01-01T10:00:00Z", "2025-01-01T11:00:00Z"),
// //   ];
// //   const busy = computeBusyIntervals(events); // full 30m buffer
// //   const slot = findNextAvailableSlot(busy, 60, 0, { referenceNow: now });

// //   assert(slot);
// //   // With 30m buffer, the earliest free start is 11:30
// //   assertEquals(slot!.start.toISOString(), "2025-01-01T11:30:00.000Z");
// // });

Deno.test("schedule-capture handler (live request)", async () => {
  console.log("Starting live schedule-capture test...");
  const runLive = (Deno.env.get("RUN_LIVE_SCHEDULE_CAPTURE_TEST") ?? "").trim();
  if (runLive !== "1") return;

  const userBearer =
    Deno.env.get("TEST_USER_BEARER") ?? Deno.env.get("USER_BEARER");
  assert(userBearer, "Missing env TEST_USER_BEARER");

  const supabaseUrl =
    Deno.env.get("SUPABASE_URL") ?? Deno.env.get("EXPO_PUBLIC_SUPABASE_URL");
  if (supabaseUrl && !Deno.env.get("SUPABASE_URL")) {
    Deno.env.set("SUPABASE_URL", supabaseUrl);
  }

  const anonKey =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("ANON_KEY") ??
    Deno.env.get("EXPO_PUBLIC_SUPABASE_ANON_KEY");
  if (anonKey && !Deno.env.get("SUPABASE_ANON_KEY")) {
    Deno.env.set("SUPABASE_ANON_KEY", anonKey);
  }

  const googleClientId =
    Deno.env.get("GOOGLE_CLIENT_ID") ??
    Deno.env.get("EXPO_PUBLIC_GOOGLE_CLIENT_ID");
  if (googleClientId && !Deno.env.get("GOOGLE_CLIENT_ID")) {
    Deno.env.set("GOOGLE_CLIENT_ID", googleClientId);
  }

  assert(supabaseUrl, "Missing env SUPABASE_URL");
  assert(anonKey, "Missing env SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY");
  assert(serviceRoleKey, "Missing env SERVICE_ROLE_KEY");
  assert(googleClientId, "Missing env GOOGLE_CLIENT_ID");
  assert(
    Deno.env.get("GOOGLE_CLIENT_SECRET"),
    "Missing env GOOGLE_CLIENT_SECRET",
  );

  const serviceRolePayload = decodeJwtPayload(serviceRoleKey);
  console.log("Supabase URL:", supabaseUrl);
  console.log("Anon key:", maskSecret(anonKey));
  if (serviceRolePayload) {
    console.log("Service role key payload:", {
      iss: serviceRolePayload.iss,
      role: serviceRolePayload.role,
      ref: serviceRolePayload.ref,
    });
  } else {
    console.log("Service role key payload: <unreadable>");
  }

  const timezone = Deno.env.get("TEST_TIMEZONE") ?? null;
  const offsetRaw = Deno.env.get("TEST_TZ_OFFSET_MINUTES");
  const timezoneOffsetMinutes = offsetRaw ? Number(offsetRaw) : undefined;
  console.log(
    "Using timezone:",
    timezone,
    "offset minutes:",
    timezoneOffsetMinutes,
  );
  const captureId = "0dd868f0-f8ea-4953-9e10-96e25d0dd7e6";
  const req = new Request("http://localhost/functions/v1/schedule-capture", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${userBearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "schedule",
      captureId,
      allowOverlap: true,
      allowLatePlacement: true,
      timezone,
      timezoneOffsetMinutes,
    }),
  });

  const res = await handler(req);
  const data = await res.json().catch(() => ({}));
  console.log("Response data:", data);
  assert(
    res.ok || res.status === 409,
    `Unexpected status ${res.status}: ${JSON.stringify(data)}`,
  );
  assert(data && (data.message || data.decision || data.error));
});

// --- Mapping tests ---

Deno.test(
  "mapExtractionToCapture: explicit scheduled_time wins over window/deadline",
  () => {
    const extraction = makeExtraction({
      scheduled_time: {
        datetime: "2026-01-09T15:00:00Z",
        precision: "exact",
        source: "explicit",
      },
      deadline: {
        datetime: "2026-01-09T18:00:00Z",
        kind: "hard",
        source: "explicit",
      },
      execution_window: {
        relation: "between",
        start: "2026-01-09T14:00:00Z",
        end: "2026-01-09T17:00:00Z",
        source: "explicit",
      },
      estimated_minutes: 30,
    });
    const mapped = mapExtractionToCapture(extraction);
    assertEquals(mapped.constraint_type, "start_time");
    assertEquals(mapped.constraint_time, "2026-01-09T15:00:00Z");
    assertEquals(mapped.deadline_at, "2026-01-09T18:00:00Z");
    assertEquals(mapped.window_start, "2026-01-09T14:00:00Z");
    assertEquals(mapped.window_end, "2026-01-09T17:00:00Z");
  },
);

Deno.test("mapExtractionToCapture: window only maps to window", () => {
  const extraction = makeExtraction({
    execution_window: {
      relation: "between",
      start: "2026-01-10T10:00:00Z",
      end: "2026-01-10T12:00:00Z",
      source: "explicit",
    },
    estimated_minutes: 60,
  });
  const mapped = mapExtractionToCapture(extraction);
  assertEquals(mapped.constraint_type, "window");
  assertEquals(mapped.window_start, "2026-01-10T10:00:00Z");
  assertEquals(mapped.window_end, "2026-01-10T12:00:00Z");
});

Deno.test(
  "mapExtractionToCapture: approximate scheduled_time marks soft start",
  () => {
    const extraction = makeExtraction({
      scheduled_time: {
        datetime: "2026-01-11T09:00:00Z",
        precision: "approximate",
        source: "inferred",
      },
      estimated_minutes: 30,
    });
    const mapped = mapExtractionToCapture(extraction);
    assertEquals(mapped.constraint_type, "start_time");
    assert(mapped.is_soft_start);
  },
);

// --- Plan tests ---

Deno.test(
  "computeSchedulingPlan: start_time produces start mode with preferredSlot at or after now",
  () => {
    const capture = makeCapture({
      constraint_type: "start_time",
      constraint_time: "2026-02-01T10:00:00Z",
    });
    const plan = computeSchedulingPlan(
      capture,
      60,
      0,
      new Date("2026-02-01T09:00:00Z"),
    );
    assertEquals(plan.mode, "start");
    assert(plan.preferredSlot);
    assertEquals(
      plan.preferredSlot!.start.toISOString(),
      "2026-02-01T10:00:00.000Z",
    );
  },
);

Deno.test(
  "computeSchedulingPlan: window that cannot fit returns window mode with null preferredSlot",
  () => {
    const capture = makeCapture({
      constraint_type: "window",
      constraint_time: "2026-02-02T10:00:00Z",
      constraint_end: "2026-02-02T10:30:00Z", // 30-min window but task is 60
    });
    const plan = computeSchedulingPlan(
      capture,
      60,
      0,
      new Date("2026-02-02T08:00:00Z"),
    );
    assertEquals(plan.mode, "window");
    assertEquals(plan.preferredSlot, null);
  },
);

Deno.test("computeSchedulingPlan: deadline_time builds a deadline plan", () => {
  const capture = makeCapture({
    constraint_type: "deadline_time",
    constraint_time: "2026-02-03T18:00:00Z",
  });
  const plan = computeSchedulingPlan(
    capture,
    30,
    0,
    new Date("2026-02-03T09:00:00Z"),
  );
  assertEquals(plan.mode, "deadline");
  assert(plan.deadline);
  assertEquals(plan.deadline!.toISOString(), "2026-02-03T18:00:00.000Z");
});
