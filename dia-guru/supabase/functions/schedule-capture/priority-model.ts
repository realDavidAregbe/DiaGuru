import {
  computePriorityBreakdown,
  type PriorityInput,
  type PriorityScoreBreakdown,
} from "../../../shared/priority.ts";
import type { CaptureEntryRow } from "../types.ts";

export const ROUTINE_PRIORITY_RULES = {
  sleep: { scaler: 0.7, cap: 70 },
  meal: { scaler: 0.5, cap: 55 },
} as const;

export type RoutineKind = keyof typeof ROUTINE_PRIORITY_RULES;

export type CapturePrioritySnapshot = {
  baseScore: number;
  components: PriorityScoreBreakdown["components"];
  durationMinutes: number;
  perMinute: number;
  routineKind: RoutineKind | null;
  score: number;
};

export function buildPriorityInput(capture: CaptureEntryRow): PriorityInput {
  let urgency: number | null = null;
  let impact: number | null = null;
  let reschedule_penalty: number | null = null;

  if (typeof capture.urgency === "number") urgency = capture.urgency;
  if (typeof capture.impact === "number") impact = capture.impact;
  if (typeof capture.reschedule_penalty === "number") {
    reschedule_penalty = capture.reschedule_penalty;
  }

  if (urgency == null || impact == null || reschedule_penalty == null) {
    try {
      const notes = typeof capture.scheduling_notes === "string"
        ? capture.scheduling_notes
        : null;
      if (notes && notes.trim().length > 0) {
        const parsed = JSON.parse(notes);
        if (parsed && typeof parsed === "object") {
          const importance = "importance" in parsed && parsed.importance &&
              typeof parsed.importance === "object"
            ? (parsed.importance as Record<string, unknown>)
            : null;
          const toNumber = (value: unknown) =>
            typeof value === "number"
              ? value
              : typeof value === "string"
              ? Number(value)
              : null;

          if (importance) {
            if (urgency == null) urgency = toNumber(importance.urgency);
            if (impact == null) impact = toNumber(importance.impact);
            if (reschedule_penalty == null) {
              reschedule_penalty = toNumber(importance.reschedule_penalty);
            }
          }
        }
      }
    } catch {
      // ignore malformed scheduling notes
    }
  }

  return {
    estimated_minutes: capture.estimated_minutes ?? null,
    importance: capture.importance ?? 1,
    urgency: urgency ?? null,
    impact: impact ?? null,
    reschedule_penalty: reschedule_penalty ?? null,
    created_at: capture.created_at ?? new Date().toISOString(),
    constraint_type: capture.constraint_type,
    constraint_time: capture.constraint_time,
    constraint_end: capture.constraint_end,
    constraint_date: capture.constraint_date,
    original_target_time: capture.original_target_time,
    deadline_at: capture.deadline_at,
    window_start: capture.window_start,
    window_end: capture.window_end,
    start_target_at: capture.start_target_at,
    is_soft_start: capture.is_soft_start,
    externality_score: capture.externality_score,
    reschedule_count: capture.reschedule_count,
  };
}

export function detectRoutineKind(
  capture: CaptureEntryRow,
): RoutineKind | null {
  const hint = capture.task_type_hint?.toLowerCase() ?? "";
  const text = capture.content?.toLowerCase() ?? "";

  if (hint.includes("routine.sleep") || /\bsleep|nap|bed ?time\b/.test(text)) {
    return "sleep";
  }
  if (
    hint.includes("routine.meal") ||
    /\b(breakfast|lunch|dinner|meal|eat)\b/.test(text)
  ) {
    return "meal";
  }
  return null;
}

export function applyRoutinePriorityScore(
  score: number,
  kind: RoutineKind | null,
) {
  if (!kind) return score;
  const rule = ROUTINE_PRIORITY_RULES[kind];
  const scaled = score * rule.scaler;
  return Math.min(scaled, rule.cap);
}

export function computeCapturePrioritySnapshot(
  capture: CaptureEntryRow,
  referenceNow: Date,
): CapturePrioritySnapshot {
  const breakdown = computePriorityBreakdown(
    buildPriorityInput(capture),
    referenceNow,
  );
  const routineKind = detectRoutineKind(capture);
  const score = applyRoutinePriorityScore(breakdown.score, routineKind);
  const durationMinutes = Math.max(1, breakdown.durationMinutes);

  return {
    baseScore: breakdown.score,
    components: breakdown.components,
    durationMinutes,
    perMinute: score / durationMinutes,
    routineKind,
    score,
  };
}

export function priorityForCapture(
  capture: CaptureEntryRow,
  referenceNow: Date,
) {
  return computeCapturePrioritySnapshot(capture, referenceNow).score;
}
