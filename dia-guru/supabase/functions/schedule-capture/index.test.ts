import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStrictEquals,
} from "std/assert";

import type { CaptureEntryRow } from "../types.ts";

import {
  CalendarEvent,
  buildChunksForSlot,
  buildOccupancyGrid,
  buildPreemptionDisplacements,
  canCaptureOverlap,
  collectConflictingEvents,
  collectGridWindowCandidates,
  computeBusyIntervals,
  computeDateDeadline,
  computeSchedulingPlan,
  derivePreferredTimeOfDayBands,
  estimateConflictMinutes,
  findNextAvailableSlot,
  findSlotBeforeDeadline,
  findSlotWithinWindow,
  generateChunkDurations,
  hasActiveFreeze,
  isSlotWithinConstraints,
  normalizeConstraintType,
  normalizeRoutineCapture,
  parseIsoDate,
  placeChunksWithinRange,
  priorityForCapture,
  resolveDeadlineFromCapture,
  sanitizedEstimatedMinutes,
  scheduleWithPlan,
  selectMinimalPreemptionSet,
  serializeChunks,
  summarizeWindowCapacity,
  withinStabilityWindow,
} from "./index.ts";



Deno.test("computeSchedulingPlan: window capture prefers earliest slot inside window", () => {
  const capture = fakeCapture({
    constraint_type: "window",
    constraint_time: "2025-01-01T10:00:00Z",
    constraint_end:  "2025-01-01T12:00:00Z",
  });
  const plan = computeSchedulingPlan(capture, /*durationMinutes*/ 60, 0, new Date("2025-01-01T09:00:00Z"));

  assertEquals(plan.mode, "window");
  assert(plan.preferredSlot);
  assertEquals(plan.preferredSlot.start.toISOString(), "2025-01-01T10:00:00.000Z");
  assertEquals(plan.preferredSlot.end.toISOString(),   "2025-01-01T11:00:00.000Z");
});



function fakeCapture(overrides: Partial<CaptureEntryRow> = {}): CaptureEntryRow {
  return {
    id: "cap_1",
    user_id: "user_1",
    content: "Test",
    importance: 1,
    estimated_minutes: 60,
    status: "pending",
    constraint_type: "flexible",
    // ...everything else with safe defaults...
    ...overrides,
  } as CaptureEntryRow;
}

function event(startIso: string, endIso: string, extra?: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: extra?.id ?? crypto.randomUUID(),
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    ...extra,
  };
}
