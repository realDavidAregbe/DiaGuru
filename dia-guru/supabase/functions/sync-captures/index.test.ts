import { assertEquals, assertStrictEquals } from "std/assert";
import {
  evaluateCaptureSyncState,
  extractGoogleError,
  parseEventDate,
  sameInstant,
} from "./index.ts";

Deno.test("extractGoogleError returns nested message", () => {
  const payload = {
    error: {
      message: "Invalid credentials",
      errors: [{ reason: "authError", message: "Invalid credentials" }],
    },
  };
  assertStrictEquals(extractGoogleError(payload), "Invalid credentials");
});

Deno.test("extractGoogleError falls back to top-level message", () => {
  const payload = { message: "Something went wrong" };
  assertStrictEquals(extractGoogleError(payload), "Something went wrong");
});

Deno.test("extractGoogleError falls back to nested reason", () => {
  const payload = {
    error: {
      errors: [{ reason: "authError" }],
    },
  };
  assertStrictEquals(extractGoogleError(payload), "authError");
});

Deno.test("extractGoogleError handles string and unknown payloads", () => {
  assertStrictEquals(extractGoogleError("raw-error"), "raw-error");
  assertStrictEquals(extractGoogleError({}), null);
  assertStrictEquals(extractGoogleError(null), null);
});

Deno.test("parseEventDate handles dateTime and date", () => {
  const dateTime = parseEventDate({ dateTime: "2025-10-25T10:00:00Z" });
  assertEquals(dateTime?.toISOString(), "2025-10-25T10:00:00.000Z");
  const date = parseEventDate({ date: "2025-10-26" });
  assertEquals(date?.toISOString(), "2025-10-26T00:00:00.000Z");
});

Deno.test("parseEventDate returns null for missing values", () => {
  assertStrictEquals(parseEventDate(null), null);
  assertStrictEquals(parseEventDate({}), null);
});

Deno.test("sameInstant treats equivalent timestamp formats as equal", () => {
  assertStrictEquals(
    sameInstant("2026-04-10 13:00:00+00", "2026-04-10T13:00:00.000Z"),
    true,
  );
  assertStrictEquals(
    sameInstant("2026-04-10 13:30:00+00", "2026-04-10T13:00:00.000Z"),
    false,
  );
});

Deno.test(
  "evaluateCaptureSyncState does not mark equivalent times and etag churn as manual edits",
  () => {
    const state = evaluateCaptureSyncState({
      capture: {
        status: "scheduled",
        planned_start: "2026-04-10 13:00:00+00",
        planned_end: "2026-04-10 13:30:00+00",
        calendar_event_id: "event_1",
        calendar_event_etag: '"old"',
        manual_touch_at: null,
        freeze_until: null,
      },
      plannedStart: "2026-04-10T13:00:00.000Z",
      plannedEnd: "2026-04-10T13:30:00.000Z",
      eventId: "event_1",
      eventEtag: '"new"',
    });

    assertStrictEquals(state.startChanged, false);
    assertStrictEquals(state.endChanged, false);
    assertStrictEquals(state.etagChanged, true);
    assertStrictEquals(state.staleSyncFreeze, false);
    assertStrictEquals(state.requiresUpdate, true);
    assertStrictEquals(state.manualChangeDetected, false);
  },
);

Deno.test(
  "evaluateCaptureSyncState marks real event moves as manual edits",
  () => {
    const state = evaluateCaptureSyncState({
      capture: {
        status: "scheduled",
        planned_start: "2026-04-10 13:00:00+00",
        planned_end: "2026-04-10 13:30:00+00",
        calendar_event_id: "event_1",
        calendar_event_etag: '"etag"',
        manual_touch_at: null,
        freeze_until: null,
      },
      plannedStart: "2026-04-10T14:00:00.000Z",
      plannedEnd: "2026-04-10T14:30:00.000Z",
      eventId: "event_1",
      eventEtag: '"etag2"',
    });

    assertStrictEquals(state.startChanged, true);
    assertStrictEquals(state.endChanged, true);
    assertStrictEquals(state.manualChangeDetected, true);
  },
);

Deno.test(
  "evaluateCaptureSyncState flags stale sync freezes for cleanup without treating them as manual edits",
  () => {
    const state = evaluateCaptureSyncState({
      capture: {
        status: "scheduled",
        planned_start: "2026-04-10 13:00:00+00",
        planned_end: "2026-04-10 13:30:00+00",
        calendar_event_id: "event_1",
        calendar_event_etag: '"etag"',
        manual_touch_at: "2026-04-09T20:43:00.858Z",
        freeze_until: "2026-04-10T20:43:00.858Z",
      },
      plannedStart: "2026-04-10T13:00:00.000Z",
      plannedEnd: "2026-04-10T13:30:00.000Z",
      eventId: "event_1",
      eventEtag: '"etag"',
    });

    assertStrictEquals(state.startChanged, false);
    assertStrictEquals(state.endChanged, false);
    assertStrictEquals(state.staleSyncFreeze, true);
    assertStrictEquals(state.requiresUpdate, true);
    assertStrictEquals(state.manualChangeDetected, false);
  },
);
