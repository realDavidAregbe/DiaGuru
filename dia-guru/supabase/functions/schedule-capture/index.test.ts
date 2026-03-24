import { assert, assertEquals } from "std/assert";

import type { CaptureEntryRow } from "../types.ts";
import { mapExtractionToCapture } from "../parse-task/index.ts";
import {
  type CalendarEvent,
  collectConflictingEvents,
  computeSchedulingPlan,
  resolveDeadlineFromCapture,
} from "./scheduling-core.ts";

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

function makeEvent(
  id: string,
  start: string,
  end: string,
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    start: { dateTime: start },
    end: { dateTime: end },
    ...overrides,
  };
}

function makeSlot(start: string, end: string) {
  return { start: new Date(start), end: new Date(end) };
}

Deno.test(
  "mapExtractionToCapture: explicit scheduled_time wins over window and deadline",
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
    assertEquals(mapped.original_target_time, "2026-01-09T15:00:00Z");
    assertEquals(mapped.start_target_at, "2026-01-09T15:00:00Z");
    assertEquals(mapped.is_soft_start, false);
    assertEquals(mapped.deadline_at, "2026-01-09T18:00:00Z");
    assertEquals(mapped.window_start, "2026-01-09T14:00:00Z");
    assertEquals(mapped.window_end, "2026-01-09T17:00:00Z");
  },
);

Deno.test(
  "mapExtractionToCapture: window only maps to window constraint",
  () => {
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
    assertEquals(mapped.constraint_time, "2026-01-10T10:00:00Z");
    assertEquals(mapped.constraint_end, "2026-01-10T12:00:00Z");
    assertEquals(mapped.window_start, "2026-01-10T10:00:00Z");
    assertEquals(mapped.window_end, "2026-01-10T12:00:00Z");
  },
);

Deno.test("mapExtractionToCapture: deadline only maps to deadline_time", () => {
  const extraction = makeExtraction({
    deadline: {
      datetime: "2026-01-12T18:30:00Z",
      kind: "hard",
      source: "explicit",
    },
  });

  const mapped = mapExtractionToCapture(extraction);
  assertEquals(mapped.constraint_type, "deadline_time");
  assertEquals(mapped.constraint_time, "2026-01-12T18:30:00Z");
  assertEquals(mapped.deadline_at, "2026-01-12T18:30:00Z");
});

Deno.test(
  "mapExtractionToCapture: inferred scheduled_time marks soft start and preserves hints",
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
    assertEquals(mapped.constraint_time, "2026-01-11T09:00:00Z");
    assertEquals(mapped.original_target_time, "2026-01-11T09:00:00Z");
    assertEquals(mapped.start_target_at, "2026-01-11T09:00:00Z");
    assert(mapped.is_soft_start);
  },
);

Deno.test("mapExtractionToCapture: no temporal signals stays flexible", () => {
  const mapped = mapExtractionToCapture(
    makeExtraction({ estimated_minutes: 25 }),
  );
  assertEquals(mapped.constraint_type, "flexible");
  assertEquals(mapped.constraint_time, null);
  assertEquals(mapped.constraint_end, null);
});

Deno.test(
  "computeSchedulingPlan: start_time uses requested start when it is in the future",
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
      plan.preferredSlot.start.toISOString(),
      "2026-02-01T10:00:00.000Z",
    );
  },
);

Deno.test(
  "computeSchedulingPlan: start_time clamps a past requested start to now",
  () => {
    const now = new Date("2026-02-01T09:00:00Z");
    const capture = makeCapture({
      constraint_type: "start_time",
      constraint_time: "2026-02-01T08:30:00Z",
    });

    const plan = computeSchedulingPlan(capture, 30, 0, now);
    assertEquals(plan.mode, "start");
    assert(plan.preferredSlot);
    assertEquals(plan.preferredSlot.start.toISOString(), now.toISOString());
    assertEquals(
      plan.preferredSlot.end.toISOString(),
      "2026-02-01T09:30:00.000Z",
    );
  },
);

Deno.test(
  "computeSchedulingPlan: start_time falls back to original_target_time when needed",
  () => {
    const capture = makeCapture({
      constraint_type: "start_time",
      constraint_time: null,
      original_target_time: "2026-02-01T11:00:00Z",
    });

    const plan = computeSchedulingPlan(
      capture,
      45,
      0,
      new Date("2026-02-01T09:00:00Z"),
    );

    assertEquals(plan.mode, "start");
    assert(plan.preferredSlot);
    assertEquals(
      plan.preferredSlot.start.toISOString(),
      "2026-02-01T11:00:00.000Z",
    );
  },
);

Deno.test("computeSchedulingPlan: valid window returns window mode", () => {
  const capture = makeCapture({
    constraint_type: "window",
    constraint_time: "2026-02-02T10:00:00Z",
    constraint_end: "2026-02-02T11:30:00Z",
  });

  const plan = computeSchedulingPlan(
    capture,
    60,
    0,
    new Date("2026-02-02T08:00:00Z"),
  );

  assertEquals(plan.mode, "window");
  assert(plan.window);
  assertEquals(plan.window.start.toISOString(), "2026-02-02T10:00:00.000Z");
  assertEquals(plan.window.end.toISOString(), "2026-02-02T11:30:00.000Z");
});

Deno.test(
  "computeSchedulingPlan: invalid window falls back to flexible",
  () => {
    const capture = makeCapture({
      constraint_type: "window",
      constraint_time: "2026-02-02T11:00:00Z",
      constraint_end: "2026-02-02T10:00:00Z",
    });

    const plan = computeSchedulingPlan(
      capture,
      60,
      0,
      new Date("2026-02-02T08:00:00Z"),
    );

    assertEquals(plan.mode, "flexible");
    assertEquals(plan.window, null);
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
  assertEquals(plan.deadline.toISOString(), "2026-02-03T18:00:00.000Z");
});

Deno.test(
  "computeSchedulingPlan: deadline_date computes local day-end deadline",
  () => {
    const capture = makeCapture({
      constraint_type: "deadline_date",
      constraint_date: "2026-02-04",
    });

    const plan = computeSchedulingPlan(
      capture,
      30,
      0,
      new Date("2026-02-03T09:00:00Z"),
    );
    const expectedDeadline = resolveDeadlineFromCapture(capture, 0);

    assertEquals(plan.mode, "deadline");
    assert(plan.deadline);
    assert(expectedDeadline);
    assertEquals(plan.deadline.toISOString(), expectedDeadline.toISOString());
  },
);

Deno.test(
  "collectConflictingEvents uses normal buffers when no in-progress context is provided",
  () => {
    const event = makeEvent(
      "evt-1",
      "2025-01-01T10:00:00Z",
      "2025-01-01T11:00:00Z",
    );
    const slot = makeSlot("2025-01-01T11:00:00Z", "2025-01-01T11:30:00Z");

    const conflicts = collectConflictingEvents(slot, [event]);
    assertEquals(conflicts.length, 1);
    assertEquals(conflicts[0].id, "evt-1");
  },
);

Deno.test(
  "collectConflictingEvents relaxes tail buffer for an in-progress event",
  () => {
    const now = new Date("2025-01-01T10:30:00Z");
    const event = makeEvent(
      "evt-2",
      "2025-01-01T10:00:00Z",
      "2025-01-01T11:00:00Z",
    );
    const slot = makeSlot("2025-01-01T11:00:00Z", "2025-01-01T11:30:00Z");

    const conflicts = collectConflictingEvents(slot, [event], now);
    assertEquals(conflicts.length, 0);
  },
);

Deno.test(
  "collectConflictingEvents still blocks overlapping slot while event is in progress",
  () => {
    const now = new Date("2025-01-01T10:30:00Z");
    const event = makeEvent(
      "evt-3",
      "2025-01-01T10:00:00Z",
      "2025-01-01T11:00:00Z",
      {
        summary: "Standup",
        extendedProperties: {
          private: { diaGuru: "true", capture_id: "cap-99" },
        },
      },
    );
    const slot = makeSlot("2025-01-01T10:45:00Z", "2025-01-01T11:15:00Z");

    const conflicts = collectConflictingEvents(slot, [event], now);
    assertEquals(conflicts.length, 1);
    assertEquals(conflicts[0].id, "evt-3");
    assertEquals(conflicts[0].diaGuru, true);
    assertEquals(conflicts[0].captureId, "cap-99");
  },
);
