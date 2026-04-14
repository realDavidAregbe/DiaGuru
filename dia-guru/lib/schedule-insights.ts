import type { Capture } from "./capture";

type ScheduleLikeCapture = Pick<
  Capture,
  | "planned_start"
  | "planned_end"
  | "freeze_until"
  | "scheduling_notes"
  | "extraction_json"
>;

export function normalizeExtractionJson(value: unknown) {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function formatIsoLabel(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function extractReasonsFromExtraction(
  extraction: Record<string, unknown> | null,
) {
  if (!extraction) return [];
  const reasons: string[] = [];
  const ex = extraction as {
    scheduled_time?: { datetime?: string | null } | null;
    execution_window?: { start?: string | null; end?: string | null } | null;
    deadline?: { datetime?: string | null } | null;
    time_preferences?: {
      time_of_day?: string | null;
      day?: string | null;
    } | null;
    importance?: { rationale?: string | null } | null;
  };

  const scheduledLabel = formatIsoLabel(ex.scheduled_time?.datetime ?? null);
  if (scheduledLabel) {
    reasons.push(`Requested time: ${scheduledLabel}.`);
  }

  const windowStart = formatIsoLabel(ex.execution_window?.start ?? null);
  const windowEnd = formatIsoLabel(ex.execution_window?.end ?? null);
  if (windowStart || windowEnd) {
    const range =
      windowStart && windowEnd
        ? `${windowStart} -> ${windowEnd}`
        : (windowStart ?? windowEnd);
    reasons.push(`Requested window: ${range}.`);
  }

  const deadlineLabel = formatIsoLabel(ex.deadline?.datetime ?? null);
  if (deadlineLabel) {
    reasons.push(`Deadline: ${deadlineLabel}.`);
  }

  if (ex.time_preferences?.time_of_day) {
    reasons.push(`Time preference: ${ex.time_preferences.time_of_day}.`);
  }
  if (ex.time_preferences?.day) {
    reasons.push(`Day preference: ${ex.time_preferences.day}.`);
  }

  if (ex.importance?.rationale) {
    reasons.push(ex.importance.rationale);
  }

  return reasons;
}

export function extractScheduleReasons(capture: ScheduleLikeCapture) {
  const fallback = "Scheduled by DiaGuru based on your constraints.";
  const raw = capture.scheduling_notes;
  const scheduleReasons: string[] = [];
  let scheduleNote: string | null = null;

  if (raw && typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const scheduleExplanation = (parsed as Record<string, unknown>)
          .schedule_explanation as { reasons?: unknown } | undefined;
        if (
          scheduleExplanation?.reasons &&
          Array.isArray(scheduleExplanation.reasons)
        ) {
          const reasons = scheduleExplanation.reasons
            .map((reason) => String(reason))
            .filter((reason) => reason.trim().length > 0);
          scheduleReasons.push(...reasons);
        }
        const note = (parsed as Record<string, unknown>).schedule_note;
        if (typeof note === "string" && note.trim().length > 0) {
          scheduleNote = note.trim();
        }
      }
    } catch {
      scheduleNote = raw.trim() || null;
    }
  }

  const extractionReasons = extractReasonsFromExtraction(
    normalizeExtractionJson(capture.extraction_json),
  );

  const combined =
    scheduleReasons.length > 0
      ? scheduleReasons
      : scheduleNote
        ? [scheduleNote]
        : [];

  if (combined.length < 2 && extractionReasons.length > 0) {
    combined.push(...extractionReasons);
  }

  const unique = Array.from(
    new Set(combined.map((reason) => reason.trim()).filter(Boolean)),
  );
  return unique.length > 0 ? unique.slice(0, 5) : [fallback];
}

export function getScheduleReasonPreview(
  capture: ScheduleLikeCapture,
  limit = 2,
) {
  return extractScheduleReasons(capture).slice(0, Math.max(1, limit));
}

export function formatCaptureScheduleSummary(
  capture: ScheduleLikeCapture | null,
) {
  if (!capture?.planned_start) return null;
  const start = new Date(capture.planned_start);
  if (Number.isNaN(start.getTime())) return null;

  const dateText = start.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
  const startText = start.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  if (!capture.planned_end) {
    return `${dateText} at ${startText}`;
  }

  const end = new Date(capture.planned_end);
  if (Number.isNaN(end.getTime())) {
    return `${dateText} at ${startText}`;
  }

  const endText = end.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${dateText}, ${startText} - ${endText}`;
}

export function isCaptureActivelyLocked(
  capture: Pick<Capture, "freeze_until">,
  referenceNow = new Date(),
) {
  if (!capture.freeze_until) return false;
  const freezeTs = Date.parse(capture.freeze_until);
  if (!Number.isFinite(freezeTs)) return false;
  return freezeTs > referenceNow.getTime();
}

export function formatFreezeUntilLabel(capture: Pick<Capture, "freeze_until">) {
  if (!capture.freeze_until) return null;
  const freezeDate = new Date(capture.freeze_until);
  if (Number.isNaN(freezeDate.getTime())) return null;
  return freezeDate.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
