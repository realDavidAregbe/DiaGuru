import { CalendarHealthNotice } from "@/components/CalendarHealthNotice";
import { useSupabaseSession } from "@/hooks/useSupabaseSession";
import {
  addCapture,
  Capture,
  CaptureStatus,
  ConstraintType,
  invokeCaptureCompletion,
  invokeScheduleCapture,
  listCaptures,
  listScheduledCaptures,
  lockCaptureWindow,
  parseCapture,
  ParseMode,
  ParseTaskResponse,
  PlanSummary,
  ScheduleDecision,
  ScheduleOptions,
  syncCaptureEvents,
  undoPlan,
} from "@/lib/capture";
import {
  connectGoogleCalendar,
  getCalendarHealth,
  type CalendarHealth,
} from "@/lib/google-connect";
import {
  cancelScheduledNotification,
  scheduleReminderAt,
} from "@/lib/notifications";
import { getAssistantModePreference } from "@/lib/preferences";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

const IMPORTANCE_LEVELS = [
  { value: 1, label: "Low" },
  { value: 2, label: "Medium" },
  { value: 3, label: "High" },
];

const REMINDER_STORAGE_KEY = "@diaGuru.reminders";

type PendingCaptureState = {
  baseContent: string;
  importance: number;
  appended: string[];
  mode: ParseMode;
  parseResult: ParseTaskResponse | null;
};

type ReminderEntry = {
  notificationId: string;
  plannedEnd: string;
};

type ReminderRegistry = Record<string, ReminderEntry>;

type HomeStatusTone = "success" | "info" | "warning";

type HomeStatusNotice = {
  tone: HomeStatusTone;
  title: string;
  message: string;
};

function extractScheduleError(error: unknown) {
  if (!error) return "Unable to schedule this item.";
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;

  const context = (error as { context?: unknown })?.context;
  if (typeof context === "string") return context;
  if (context && typeof context === "object") {
    const candidate =
      (context as Record<string, unknown>).error ??
      (context as Record<string, unknown>).details ??
      (context as Record<string, unknown>).message;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return "Unable to schedule this item.";
}

function formatConflictMessage(decision: ScheduleDecision) {
  const lines = [decision.message.trim()];
  if (decision.advisor?.message) {
    lines.push("", decision.advisor.message.trim());
  }
  if (decision.conflicts.length > 0) {
    lines.push("", "Conflicts:");
    for (const conflict of decision.conflicts) {
      const label = conflict.summary?.trim() || "Busy block";
      const startText = conflict.start
        ? new Date(conflict.start).toLocaleString()
        : "unknown";
      const endText = conflict.end
        ? new Date(conflict.end).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      const suffix = conflict.diaGuru ? " (DiaGuru)" : "";
      const details = `${startText}${endText ? ` -> ${endText}` : ""}`;
      lines.push(`- ${label}${suffix}: ${details}`);
    }
  }
  if (decision.suggestion) {
    const suggestionStart = new Date(
      decision.suggestion.start,
    ).toLocaleString();
    const suggestionEnd = new Date(decision.suggestion.end).toLocaleTimeString(
      [],
      {
        hour: "2-digit",
        minute: "2-digit",
      },
    );
    lines.push(
      "",
      `Next available slot: ${suggestionStart} -> ${suggestionEnd}`,
    );
  }
  if (decision.advisor?.slot?.start) {
    const advisorStart = new Date(decision.advisor.slot.start).toLocaleString();
    const advisorEnd =
      decision.advisor.slot.end &&
      new Date(decision.advisor.slot.end).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    lines.push(
      "",
      `Assistant suggestion: ${advisorStart}${advisorEnd ? ` -> ${advisorEnd}` : ""}`,
    );
  }
  return lines.join("\n");
}

function normalizeExtractionJson(value: unknown) {
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

function normalizeDisplayTitle(value: unknown) {
  if (typeof value !== "string") return null;
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length > 0 ? flattened : null;
}

function formatIsoLabel(value: unknown) {
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

function extractScheduleReasons(capture: Capture) {
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
            .filter((r) => r.trim().length > 0);
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

function showScheduleWhy(capture: Capture) {
  const reasons = extractScheduleReasons(capture);
  const body = reasons.map((reason) => `- ${reason}`).join("\n");
  Alert.alert("Why this time?", body);
}

function formatCaptureScheduleSummary(capture: Capture | null) {
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

function summarizePlan(plan: PlanSummary) {
  if (plan.actions.length === 0) {
    return "DiaGuru updated your schedule.";
  }

  const scheduledCount = plan.actions.filter(
    (action) => action.actionType === "scheduled",
  ).length;
  const movedCount = plan.actions.filter(
    (action) => action.actionType === "rescheduled",
  ).length;
  const removedCount = plan.actions.filter(
    (action) => action.actionType === "unscheduled",
  ).length;

  const parts: string[] = [];
  if (scheduledCount > 0) {
    parts.push(
      `${scheduledCount} ${scheduledCount === 1 ? "session" : "sessions"} scheduled`,
    );
  }
  if (movedCount > 0) {
    parts.push(
      `${movedCount} ${movedCount === 1 ? "session" : "sessions"} moved`,
    );
  }
  if (removedCount > 0) {
    parts.push(
      `${removedCount} ${removedCount === 1 ? "session" : "sessions"} unscheduled`,
    );
  }

  return parts.length > 0 ? parts.join(" • ") : "DiaGuru updated your schedule.";
}

type DerivedConstraint = {
  constraintType: ConstraintType;
  constraintTime: string | null;
  constraintEnd: string | null;
  constraintDate: string | null;
  originalTargetTime: string | null;
  deadlineAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  startTargetAt: string | null;
  isSoftStart: boolean;
  externalityScore: number;
  taskTypeHint: TaskTypeHint | null;
};

type TaskTypeHint =
  | "deep_work"
  | "admin"
  | "creative"
  | "errand"
  | "health"
  | "social"
  | "collaboration";

const DEADLINE_KEYWORDS = [
  " due",
  "due",
  "deadline",
  "before",
  "submit",
  "turn in",
  "finish",
  "complete",
  "overdue",
];
const START_KEYWORDS = [
  " start",
  "begin",
  "meeting",
  "meet ",
  "meet-up",
  "meetup",
  "call",
  "appointment",
  "arrive",
  "leave",
  "ride",
  "flight",
  "depart",
  "pickup",
  "pick up",
  "drop off",
  "visit",
  "hangout",
  "lunch",
  "dinner",
  "breakfast",
  "nap",
  "sleep",
  "rest",
  "meditate",
];
const COLLAB_KEYWORDS = [
  "meet",
  "meeting",
  "call",
  "zoom",
  "hangout",
  "sync",
  "interview",
  "pair",
  "with ",
  "client",
  "team",
  "presentation",
  "demo",
  "standup",
];
const ADMIN_KEYWORDS = [
  "email",
  "inbox",
  "budget",
  "file",
  "tax",
  "expense",
  "admin",
  "invoice",
  "plan",
  "review",
];
const CREATIVE_KEYWORDS = [
  "write",
  "draft",
  "design",
  "brainstorm",
  "record",
  "edit",
  "sketch",
  "prototype",
];
const ERRAND_KEYWORDS = [
  "pickup",
  "pick up",
  "drop off",
  "deliver",
  "grocery",
  "groceries",
  "errand",
  "store",
  "commute",
];
const HEALTH_KEYWORDS = [
  "workout",
  "run",
  "gym",
  "yoga",
  "meditate",
  "doctor",
  "dentist",
  "therapy",
  "rest",
  "sleep",
];
const SOCIAL_KEYWORDS = [
  "dinner",
  "lunch",
  "date",
  "party",
  "birthday",
  "hangout",
  "friends",
  "family",
];
const SOFT_START_HINTS = [
  "around",
  "ish",
  "about",
  "maybe",
  "whenever",
  "some time",
  "sometime",
  "after",
  "before",
  "flexible",
];
const HARD_ANCHOR_KEYWORDS = [
  "appointment",
  "flight",
  "depart",
  "arrive",
  "pickup",
  "drop off",
  "doctor",
  "dentist",
  "interview",
  "call",
  "meeting",
];

function deriveConstraintData(
  content: string,
  parseResult: ParseTaskResponse | null,
  _estimatedMinutes: number | null,
): DerivedConstraint {
  const lowerContent = content.toLowerCase();
  const classification = classifyTaskType(lowerContent);
  const defaults: DerivedConstraint = {
    constraintType: "flexible",
    constraintTime: null,
    constraintEnd: null,
    constraintDate: null,
    originalTargetTime: null,
    deadlineAt: null,
    windowStart: null,
    windowEnd: null,
    startTargetAt: null,
    isSoftStart: false,
    externalityScore: classification.externalityScore,
    taskTypeHint: classification.taskTypeHint,
  };
  if (!parseResult) return defaults;

  const structured = parseResult.structured ?? {};

  // Prefer rich capture mapping if provided by parse-task
  const cap = structured.capture as
    | {
        constraint_type?:
          | "flexible"
          | "deadline_time"
          | "deadline_date"
          | "start_time"
          | "window";
        constraint_time?: string | null;
        constraint_end?: string | null;
        constraint_date?: string | null;
        original_target_time?: string | null;
        deadline_at?: string | null;
        window_start?: string | null;
        window_end?: string | null;
        start_target_at?: string | null;
        is_soft_start?: boolean;
        task_type_hint?: TaskTypeHint | null;
      }
    | undefined;
  if (cap && cap.constraint_type) {
    return {
      ...defaults,
      constraintType: cap.constraint_type,
      constraintTime: cap.constraint_time ?? null,
      constraintEnd: cap.constraint_end ?? null,
      constraintDate: cap.constraint_date ?? null,
      originalTargetTime: cap.original_target_time ?? null,
      deadlineAt: cap.deadline_at ?? null,
      windowStart: cap.window_start ?? null,
      windowEnd: cap.window_end ?? null,
      startTargetAt: cap.start_target_at ?? null,
      isSoftStart: Boolean(cap.is_soft_start),
      taskTypeHint:
        (cap.task_type_hint as TaskTypeHint | null) ??
        classification.taskTypeHint,
    };
  }
  const hasDeadlineKeyword = containsKeyword(lowerContent, DEADLINE_KEYWORDS);
  const hasStartKeyword = containsKeyword(lowerContent, START_KEYWORDS);

  const window = structured.window;
  if (window?.start && window?.end) {
    return {
      ...defaults,
      constraintType: "window",
      constraintTime: window.start,
      constraintEnd: window.end,
      constraintDate: null,
      originalTargetTime: window.end ?? window.start ?? null,
      windowStart: window.start ?? null,
      windowEnd: window.end ?? null,
      deadlineAt: window.end ?? null,
    };
  }
  if (window?.start) {
    if (!window.start) return defaults;
    return {
      ...defaults,
      constraintType: "start_time",
      constraintTime: window.start,
      constraintEnd: null,
      constraintDate: null,
      originalTargetTime: window.start,
      startTargetAt: window.start,
      isSoftStart: inferSoftStart(lowerContent),
    };
  }
  if (window?.end) {
    return {
      ...defaults,
      constraintType: "deadline_time",
      constraintTime: window.end,
      constraintEnd: null,
      constraintDate: null,
      originalTargetTime: window.end,
      deadlineAt: window.end,
    };
  }

  const datetime = structured.datetime;
  if (!datetime) {
    return defaults;
  }

  const isDateOnly = /T00:00:00/iu.test(datetime);
  const hasExplicitTime = !isDateOnly;

  if (hasDeadlineKeyword && hasExplicitTime) {
    return {
      ...defaults,
      constraintType: "deadline_time",
      constraintTime: datetime,
      constraintEnd: null,
      constraintDate: null,
      originalTargetTime: datetime,
      deadlineAt: datetime,
    };
  }

  if ((hasDeadlineKeyword && isDateOnly) || (isDateOnly && !hasStartKeyword)) {
    const date = datetime.slice(0, 10);
    const endOfDay = buildEndOfDayIso(datetime);
    return {
      ...defaults,
      constraintType: "deadline_date",
      constraintTime: null,
      constraintEnd: null,
      constraintDate: date,
      originalTargetTime: endOfDay,
      deadlineAt: endOfDay,
    };
  }

  if (hasStartKeyword && !hasDeadlineKeyword) {
    if (!hasExplicitTime) {
      const date = datetime.slice(0, 10);
      const endOfDay = buildEndOfDayIso(datetime);
      return {
        ...defaults,
        constraintType: "deadline_date",
        constraintTime: null,
        constraintEnd: null,
        constraintDate: date,
        originalTargetTime: endOfDay,
        deadlineAt: endOfDay,
      };
    }
    return {
      ...defaults,
      constraintType: "start_time",
      constraintTime: datetime,
      constraintEnd: null,
      constraintDate: null,
      originalTargetTime: datetime,
      startTargetAt: datetime,
      isSoftStart: inferSoftStart(lowerContent),
    };
  }

  return {
    ...defaults,
    constraintType: "deadline_time",
    constraintTime: datetime,
    constraintEnd: null,
    constraintDate: null,
    originalTargetTime: datetime,
    deadlineAt: datetime,
  };
}

function buildEndOfDayIso(datetime: string) {
  const date = new Date(datetime);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(23, 59, 0, 0);
  return date.toISOString();
}

function containsKeyword(content: string, keywords: string[]) {
  return keywords.some((keyword) => {
    const trimmed = keyword.trim();
    if (!trimmed) return false;
    const hasInternalWhitespace = /\s/.test(trimmed);
    const requiresLeadingWhitespace = keyword.startsWith(" ");
    const requiresTrailingWhitespace = keyword.endsWith(" ");
    const startBoundary = requiresLeadingWhitespace ? "(?:^|\\s)" : "\\b";
    const endBoundary = requiresTrailingWhitespace ? "(?:\\s|$)" : "\\b";

    if (hasInternalWhitespace) {
      const pattern = new RegExp(
        `${requiresLeadingWhitespace ? "(?:^|\\s)" : ""}${escapeRegex(trimmed)}${requiresTrailingWhitespace ? "(?:\\s|$)" : ""} `,
        "i",
      );
      return pattern.test(content);
    }

    const pattern = new RegExp(
      `${startBoundary}${escapeRegex(trimmed)}${endBoundary} `,
      "i",
    );
    return pattern.test(content);
  });
}

function classifyTaskType(content: string): {
  taskTypeHint: TaskTypeHint | null;
  externalityScore: number;
} {
  if (containsKeyword(content, COLLAB_KEYWORDS)) {
    return { taskTypeHint: "collaboration", externalityScore: 3 };
  }
  if (containsKeyword(content, SOCIAL_KEYWORDS)) {
    return { taskTypeHint: "social", externalityScore: 2 };
  }
  if (containsKeyword(content, ERRAND_KEYWORDS)) {
    return { taskTypeHint: "errand", externalityScore: 1 };
  }
  if (containsKeyword(content, HEALTH_KEYWORDS)) {
    return { taskTypeHint: "health", externalityScore: 1 };
  }
  if (containsKeyword(content, ADMIN_KEYWORDS)) {
    return { taskTypeHint: "admin", externalityScore: 1 };
  }
  if (containsKeyword(content, CREATIVE_KEYWORDS)) {
    return { taskTypeHint: "creative", externalityScore: 0 };
  }
  return {
    taskTypeHint: "deep_work",
    externalityScore: containsKeyword(content, DEADLINE_KEYWORDS) ? 1 : 0,
  };
}

function inferSoftStart(content: string) {
  const hasSoftLanguage = containsKeyword(content, SOFT_START_HINTS);
  const hasHardAnchor = containsKeyword(content, HARD_ANCHOR_KEYWORDS);
  if (hasSoftLanguage && !hasHardAnchor) return true;
  return false;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function HomeTab() {
  const { session } = useSupabaseSession();
  const userId = session?.user?.id ?? null;
  const insets = useSafeAreaInsets();
  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    } catch {
      return "UTC";
    }
  }, []);
  const timezoneOffsetMinutes = useMemo(
    () => -new Date().getTimezoneOffset(),
    [],
  );

  const [idea, setIdea] = useState("");
  const [minutesInput, setMinutesInput] = useState("");
  const [importance, setImportance] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [pendingCapture, setPendingCapture] =
    useState<PendingCaptureState | null>(null);
  const [followUpState, setFollowUpState] = useState<{
    prompt: string;
    missing: string[];
  } | null>(null);
  const [followUpAnswer, setFollowUpAnswer] = useState("");

  const [pending, setPending] = useState<Capture[]>([]);
  const [scheduled, setScheduled] = useState<Capture[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [scheduledLoading, setScheduledLoading] = useState(true);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [scheduledError, setScheduledError] = useState<string | null>(null);
  const [calendarHealth, setCalendarHealth] = useState<CalendarHealth | null>(
    null,
  );
  const [calendarHealthError, setCalendarHealthError] = useState<string | null>(
    null,
  );
  const [calendarHealthChecking, setCalendarHealthChecking] = useState(false);
  type UICapturedChunk = {
    start: string;
    end: string;
    late?: boolean;
    overlapped?: boolean;
    prime?: boolean;
  };
  type UIOverlapBudget = { used: number; limit: number } | null;
  const [recentPlan, setRecentPlan] = useState<PlanSummary | null>(null);
  const [recentChunks, setRecentChunks] = useState<UICapturedChunk[] | null>(
    null,
  );
  const [recentOverlapBudget, setRecentOverlapBudget] =
    useState<UIOverlapBudget>(null);
  const [undoingPlan, setUndoingPlan] = useState(false);
  const [lockingCaptureId, setLockingCaptureId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<HomeStatusNotice | null>(
    null,
  );
  const [captureDetailsOpen, setCaptureDetailsOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [actionCaptureId, setActionCaptureId] = useState<string | null>(null);

  const autoSchedulingRef = useRef(false);
  const reminderRegistryRef = useRef<ReminderRegistry>({});
  const reminderSyncingRef = useRef(false);
  const calendarHealthRequestRef = useRef(false);
  const [reminderLoaded, setReminderLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(REMINDER_STORAGE_KEY);
        if (stored && active) {
          reminderRegistryRef.current = JSON.parse(stored) as ReminderRegistry;
        }
      } catch (error) {
        console.log("reminder registry load failed", error);
      } finally {
        if (active) setReminderLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const ensureReminders = useCallback(async () => {
    if (!reminderLoaded) return;
    if (reminderSyncingRef.current) return;
    reminderSyncingRef.current = true;
    try {
      const registry = reminderRegistryRef.current;
      const nextRegistry: ReminderRegistry = {};
      const now = Date.now();

      for (const capture of scheduled) {
        if (capture.status !== "scheduled") continue;
        if (!capture.planned_end) continue;

        const endDate = new Date(capture.planned_end);
        if (Number.isNaN(endDate.getTime())) continue;

        if (endDate.getTime() <= now) {
          const existing = registry[capture.id];
          if (existing) {
            await cancelScheduledNotification(existing.notificationId);
          }
          continue;
        }

        const existing = registry[capture.id];
        if (existing && existing.plannedEnd === capture.planned_end) {
          nextRegistry[capture.id] = existing;
          continue;
        }

        if (existing) {
          await cancelScheduledNotification(existing.notificationId);
        }

        try {
          const notificationId = await scheduleReminderAt(
            endDate,
            "Time to check in",
            `Did you complete "${capture.content}" ? `,
          );
          nextRegistry[capture.id] = {
            notificationId,
            plannedEnd: capture.planned_end,
          };
        } catch (error) {
          console.log("reminder schedule failed", error);
        }
      }

      for (const [captureId, entry] of Object.entries(registry)) {
        if (!nextRegistry[captureId]) {
          await cancelScheduledNotification(entry.notificationId);
        }
      }

      reminderRegistryRef.current = nextRegistry;
      await AsyncStorage.setItem(
        REMINDER_STORAGE_KEY,
        JSON.stringify(nextRegistry),
      );
    } catch (error) {
      console.log("reminder sync failed", error);
    } finally {
      reminderSyncingRef.current = false;
    }
  }, [reminderLoaded, scheduled]);

  useEffect(() => {
    if (!reminderLoaded) return;
    ensureReminders();
  }, [ensureReminders, reminderLoaded]);

  const refreshCalendarHealth = useCallback(async () => {
    if (!userId) {
      setCalendarHealth(null);
      setCalendarHealthError(null);
      return;
    }
    if (calendarHealthRequestRef.current) return;
    calendarHealthRequestRef.current = true;
    setCalendarHealthChecking(true);
    try {
      const status = await getCalendarHealth();
      setCalendarHealth(status);
      setCalendarHealthError(null);
    } catch (error) {
      console.log("calendar health check failed", error);
      setCalendarHealthError("Unable to reach Google Calendar right now.");
    } finally {
      setCalendarHealthChecking(false);
      calendarHealthRequestRef.current = false;
    }
  }, [userId]);

  const loadPending = useCallback(async () => {
    if (!userId) return [];
    setPendingLoading(true);
    setPendingError(null);
    try {
      const list = await listCaptures();
      setPending(list);
      return list;
    } catch (error: any) {
      setPendingError(error?.message ?? "Failed to load capture entries");
      return [];
    } finally {
      setPendingLoading(false);
    }
  }, [userId]);

  const loadScheduled = useCallback(async () => {
    if (!userId) return [];
    setScheduledLoading(true);
    setScheduledError(null);
    try {
      const list = await listScheduledCaptures();
      setScheduled(list);
      return list;
    } catch (error: any) {
      setScheduledError(error?.message ?? "Failed to load scheduled captures");
      return [];
    } finally {
      setScheduledLoading(false);
    }
  }, [userId]);

  const synchronizeFromCalendar = useCallback(async () => {
    if (!userId) return;
    try {
      await syncCaptureEvents();
    } catch (error) {
      console.log("sync-captures error", error);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    (async () => {
      await synchronizeFromCalendar();
      await Promise.all([
        loadPending(),
        loadScheduled(),
        refreshCalendarHealth(),
      ]);
    })();
  }, [
    loadPending,
    loadScheduled,
    refreshCalendarHealth,
    synchronizeFromCalendar,
    userId,
  ]);

  useEffect(() => {
    if (userId) return;
    setCalendarHealth(null);
    setCalendarHealthError(null);
  }, [userId]);

  const onRefresh = useCallback(async () => {
    if (!userId) return;
    setRefreshing(true);
    try {
      await synchronizeFromCalendar();
      await Promise.all([
        loadPending(),
        loadScheduled(),
        refreshCalendarHealth(),
      ]);
    } catch (error) {
      console.log("refresh sync error", error);
    } finally {
      setRefreshing(false);
    }
  }, [
    loadPending,
    loadScheduled,
    refreshCalendarHealth,
    synchronizeFromCalendar,
    userId,
  ]);

  const scheduleTopCapture = useCallback(
    async (
      captureId?: string,
      mode: "schedule" | "reschedule" = "schedule",
      options?: ScheduleOptions,
    ) => {
      if (!userId) return null;
      const targetId = captureId ?? pending[0]?.id;
      if (!targetId) return null;
      if (autoSchedulingRef.current) return null;
      autoSchedulingRef.current = true;
      try {
        setScheduling(true);
        const response = await invokeScheduleCapture(targetId, mode, {
          timezone,
          timezoneOffsetMinutes,
          ...(options ?? {}),
        });
        await Promise.all([loadPending(), loadScheduled()]);
        if (response?.planSummary) {
          setRecentPlan(response.planSummary);
          setStatusNotice(null);
        }
        await refreshCalendarHealth();
        if (response) {
          console.log("schedule-capture response payload", response);
          if (Array.isArray(response.chunks)) {
            setRecentChunks(response.chunks as UICapturedChunk[]);
          }
          const budget = (response as any)?.overlap?.budget;
          if (
            budget &&
            typeof budget.used === "number" &&
            typeof budget.limit === "number"
          ) {
            setRecentOverlapBudget({ used: budget.used, limit: budget.limit });
          } else {
            setRecentOverlapBudget(null);
          }

          const scheduledLabel = formatCaptureScheduleSummary(response.capture);
          const successTitle =
            mode === "reschedule" ? "Rescheduled" : "Scheduled";
          const successMessage =
            scheduledLabel && response.capture?.content
              ? `${response.capture.content} is set for ${scheduledLabel}.`
              : response.message || "Your capture was scheduled successfully.";

          if (!response.planSummary) {
            setStatusNotice({
              tone: "success",
              title: successTitle,
              message: successMessage,
            });
          }

          if (!response.decision) {
            Alert.alert(successTitle, successMessage);
          }
        }
        return response;
      } catch (error: any) {
        console.log("schedule-capture error", error);
        let message = extractScheduleError(error);
        // Try to extract JSON error payload from FunctionsHttpError
        try {
          const ctx = (error as any)?.context;
          if (ctx && typeof ctx.json === "function") {
            const payload = await ctx.json();
            console.log("schedule-capture response payload", payload);
            if (payload?.error) message = String(payload.error);
            if (payload?.reason === "no_slot" && payload?.deadline) {
              message = `${message} (no legal slot before ${payload.deadline})`;
            }
            if (
              payload?.reason === "slot_exceeds_deadline" &&
              payload?.slot?.end &&
              payload?.deadline
            ) {
              message = `${message} (slot ${payload.slot.end} > deadline ${payload.deadline})`;
            }
          }
        } catch {}
        setStatusNotice({
          tone: "warning",
          title: "Scheduling failed",
          message,
        });
        Alert.alert("Scheduling failed", message);
        if (message?.toLowerCase().includes("google calendar not linked")) {
          refreshCalendarHealth();
        }
        return null;
      } finally {
        setScheduling(false);
        autoSchedulingRef.current = false;
      }
    },
    [
      loadPending,
      loadScheduled,
      pending,
      refreshCalendarHealth,
      timezone,
      timezoneOffsetMinutes,
      userId,
    ],
  );

  const scheduleEntireQueue = useCallback(async () => {
    if (!userId) return null;
    if (autoSchedulingRef.current) return null;
    autoSchedulingRef.current = true;
    try {
      setScheduling(true);
      // Fetch the latest pending list (ranked)
      const queue = await loadPending();
      let scheduledCount = 0;
      for (const cap of queue) {
        try {
          const resp = await invokeScheduleCapture(cap.id, "schedule", {
            timezone,
            timezoneOffsetMinutes,
          });
          if (resp) {
            console.log("schedule-capture response payload", resp);
            if (Array.isArray(resp.chunks)) {
              setRecentChunks(resp.chunks as UICapturedChunk[]);
            }
            const budget = (resp as any)?.overlap?.budget;
            if (
              budget &&
              typeof budget.used === "number" &&
              typeof budget.limit === "number"
            ) {
              setRecentOverlapBudget({
                used: budget.used,
                limit: budget.limit,
              });
            } else {
              setRecentOverlapBudget(null);
            }
          }
          let scheduled = !resp?.decision;

          // If server returns a conflict decision with a suggestion, try suggested slot first
          const suggestion = resp?.decision?.suggestion ?? null;
          if (!scheduled && suggestion) {
            const follow = await invokeScheduleCapture(cap.id, "schedule", {
              preferredStart: suggestion.start,
              preferredEnd: suggestion.end,
              timezone,
              timezoneOffsetMinutes,
            });
            if (follow && Array.isArray((follow as any).chunks)) {
              setRecentChunks(follow.chunks as UICapturedChunk[]);
            }
            const followBudget = (follow as any)?.overlap?.budget;
            if (
              followBudget &&
              typeof followBudget.used === "number" &&
              typeof followBudget.limit === "number"
            ) {
              setRecentOverlapBudget({
                used: followBudget.used,
                limit: followBudget.limit,
              });
            } else if (follow) {
              setRecentOverlapBudget(null);
            }
            scheduled = !follow?.decision;
            // If still not scheduled, allow overlap with suggested slot
            if (!scheduled) {
              const overlapFollow = await invokeScheduleCapture(
                cap.id,
                "schedule",
                {
                  preferredStart: suggestion.start,
                  preferredEnd: suggestion.end,
                  allowOverlap: true,
                  timezone,
                  timezoneOffsetMinutes,
                },
              );
              if (
                overlapFollow &&
                Array.isArray((overlapFollow as any).chunks)
              ) {
                setRecentChunks(overlapFollow.chunks as UICapturedChunk[]);
              }
              const overlapFollowBudget = (overlapFollow as any)?.overlap
                ?.budget;
              if (
                overlapFollowBudget &&
                typeof overlapFollowBudget.used === "number" &&
                typeof overlapFollowBudget.limit === "number"
              ) {
                setRecentOverlapBudget({
                  used: overlapFollowBudget.used,
                  limit: overlapFollowBudget.limit,
                });
              } else if (overlapFollow) {
                setRecentOverlapBudget(null);
              }
              scheduled = !overlapFollow?.decision;
            }
          }

          // If no suggestion or still not scheduled, attempt overlap without a preferred slot
          if (!scheduled && !suggestion) {
            const overlapResp = await invokeScheduleCapture(
              cap.id,
              "schedule",
              {
                allowOverlap: true,
                timezone,
                timezoneOffsetMinutes,
              },
            );
            if (overlapResp && Array.isArray((overlapResp as any).chunks)) {
              setRecentChunks(overlapResp.chunks as UICapturedChunk[]);
            }
            const overlapBudget = (overlapResp as any)?.overlap?.budget;
            if (
              overlapBudget &&
              typeof overlapBudget.used === "number" &&
              typeof overlapBudget.limit === "number"
            ) {
              setRecentOverlapBudget({
                used: overlapBudget.used,
                limit: overlapBudget.limit,
              });
            } else if (overlapResp) {
              setRecentOverlapBudget(null);
            }
            scheduled = !overlapResp?.decision;
          }

          if (scheduled) scheduledCount += 1;
          // Refresh lists incrementally to keep busy intervals consistent server-side
          await Promise.all([loadPending(), loadScheduled()]);
        } catch (e: any) {
          // Skip problematic capture; continue with the rest
          console.log("queue scheduling error", cap.id, e);
          try {
            const ctx = (e as any)?.context;
            if (ctx && typeof ctx.json === "function") {
              const payload = await ctx.json();
              console.log("queue scheduling response payload", cap.id, payload);
            }
          } catch {}
          continue;
        }
      }
      await refreshCalendarHealth();
      setStatusNotice({
        tone: scheduledCount > 0 ? "success" : "info",
        title: "Queue updated",
        message:
          scheduledCount > 0
            ? `Scheduled ${scheduledCount} of ${queue.length} ${queue.length === 1 ? "item" : "items"} in your queue.`
            : "No new items were scheduled from the queue.",
      });
      return scheduledCount;
    } finally {
      setScheduling(false);
      autoSchedulingRef.current = false;
    }
  }, [
    loadPending,
    loadScheduled,
    refreshCalendarHealth,
    timezone,
    timezoneOffsetMinutes,
    userId,
  ]);

  const finalizeCapture = useCallback(
    async (
      content: string,
      estimatedMinutes: number | null,
      selectedImportance: number,
      parseResult: ParseTaskResponse | null,
    ) => {
      if (!userId) {
        throw new Error("Sign in required");
      }

      const constraint = deriveConstraintData(
        content,
        parseResult,
        estimatedMinutes,
      );

      // Prefer LLM-provided importance if available
      const extraction = parseResult?.structured?.extraction as any | null;
      const llmUrgency: number | null = extraction?.importance?.urgency ?? null;
      const llmImpact: number | null = extraction?.importance?.impact ?? null;
      const llmCompositeImportance =
        llmUrgency != null || llmImpact != null
          ? Math.max(
              1,
              Math.round((llmUrgency ?? 0) * 0.6 + (llmImpact ?? 0) * 0.4),
            )
          : selectedImportance;
      // Map LLM 1-5 scale to DB 1-3 scale to satisfy capture_entries_importance_check
      const mappedImportance =
        llmCompositeImportance <= 2 ? 1 : llmCompositeImportance >= 5 ? 3 : 2;
      const displayTitle = normalizeDisplayTitle(extraction?.title) ?? content;
      const extractionJson = extraction
        ? {
            ...extraction,
            original_prompt: content,
            display_title: displayTitle,
          }
        : null;

      // Persist rich facets in scheduling_notes for server-side policy
      const schedulingNotes = extraction
        ? JSON.stringify({
            importance: extraction.importance ?? null,
            flexibility: extraction.flexibility ?? null,
          })
        : null;

      const created = await addCapture(
        {
          content: displayTitle,
          estimatedMinutes,
          importance: mappedImportance,
          urgency: llmUrgency,
          impact: llmImpact,
          reschedulePenalty: extraction?.importance?.reschedule_penalty ?? null,
          blocking: extraction?.importance?.blocking ?? null,
          cannotOverlap: extraction?.flexibility?.cannot_overlap ?? null,
          startFlexibility: extraction?.flexibility?.start_flexibility ?? null,
          durationFlexibility:
            extraction?.flexibility?.duration_flexibility ?? null,
          minChunkMinutes: extraction?.flexibility?.min_chunk_minutes ?? null,
          maxSplits: extraction?.flexibility?.max_splits ?? null,
          extractionKind: extraction?.kind ?? null,
          timePrefTimeOfDay: extraction?.time_preferences?.time_of_day ?? null,
          timePrefDay: extraction?.time_preferences?.day ?? null,
          importanceRationale: extraction?.importance?.rationale ?? null,
          schedulingNotes,
          extractionJson,
          constraintType: constraint.constraintType,
          constraintTime: constraint.constraintTime,
          constraintEnd: constraint.constraintEnd,
          constraintDate: constraint.constraintDate,
          originalTargetTime: constraint.originalTargetTime,
          deadlineAt: constraint.deadlineAt,
          windowStart: constraint.windowStart,
          windowEnd: constraint.windowEnd,
          startTargetAt: constraint.startTargetAt,
          isSoftStart: constraint.isSoftStart,
          externalityScore: constraint.externalityScore,
          taskTypeHint: constraint.taskTypeHint,
        },
        userId,
      );

      setIdea("");
      setMinutesInput("");
      setImportance(2);
      setPendingCapture(null);

      await loadPending();
      setStatusNotice({
        tone: "success",
        title: "Capture saved",
        message: `"${displayTitle}" was added to your queue.`,
      });
      return created;
    },
    [loadPending, userId],
  );

  const handleReconnectCalendar = useCallback(() => {
    connectGoogleCalendar().catch((error) => {
      console.log("google connect error", error);
      Alert.alert(
        "Reconnect failed",
        "Unable to open Google sign-in right now. Please try again.",
      );
    });
  }, []);

  const dismissPlanSummary = useCallback(() => {
    setRecentPlan(null);
  }, []);

  const handlePlanUndo = useCallback(async () => {
    if (!recentPlan || undoingPlan) return;
    setUndoingPlan(true);
    try {
      await undoPlan(recentPlan.id);
      setRecentPlan(null);
      await Promise.all([loadPending(), loadScheduled()]);
      setStatusNotice({
        tone: "info",
        title: "Plan undone",
        message: "The most recent scheduling changes were reverted.",
      });
    } catch (error) {
      Alert.alert("Undo failed", extractScheduleError(error));
    } finally {
      setUndoingPlan(false);
    }
  }, [loadPending, loadScheduled, recentPlan, undoingPlan]);

  const handleLockCapture = useCallback(
    async (captureId: string) => {
      if (lockingCaptureId) return;
      setLockingCaptureId(captureId);
      try {
        await lockCaptureWindow(captureId);
        await loadScheduled();
        setStatusNotice({
          tone: "info",
          title: "Time locked",
          message: "DiaGuru will keep that scheduled time fixed.",
        });
      } catch (error) {
        Alert.alert("Lock failed", extractScheduleError(error));
      } finally {
        setLockingCaptureId(null);
      }
    },
    [loadScheduled, lockingCaptureId],
  );

  const attemptSchedule = useCallback(
    async (captureId: string) => {
      const response = await scheduleTopCapture(captureId, "schedule");
      const decision = response?.decision;
      if (decision?.type === "preferred_conflict") {
        const message = formatConflictMessage(decision);
        Alert.alert("Scheduling conflict", message, [
          { text: "Cancel", style: "cancel" },
          {
            text: "Overlap anyway",
            onPress: () =>
              scheduleTopCapture(captureId, "schedule", {
                allowOverlap: true,
              }),
          },
          {
            text: "Make room",
            onPress: () =>
              scheduleTopCapture(captureId, "schedule", {
                allowRebalance: true,
              }),
          },
          {
            text: "Let DiaGuru decide",
            onPress: () => scheduleTopCapture(captureId, "schedule"),
          },
        ]);
      }
      return response;
    },
    [scheduleTopCapture],
  );

  const handleFollowUpCancel = useCallback(() => {
    setFollowUpState(null);
    setFollowUpAnswer("");
    setPendingCapture(null);
    setSubmitting(false);
  }, []);

  const handleFollowUpSubmit = useCallback(async () => {
    if (!followUpState || !pendingCapture) return;
    const answer = followUpAnswer.trim();
    if (!answer) {
      Alert.alert(
        "Need a response",
        "Please answer the question so DiaGuru can schedule this.",
      );
      return;
    }

    try {
      setSubmitting(true);

      let resolvedMinutes: number | null = null;
      const numericMatch = answer.match(/(\d+(?:\.\d+)?)/);
      if (numericMatch) {
        const numeric = Number(numericMatch[1]);
        if (!Number.isNaN(numeric) && numeric > 0) {
          resolvedMinutes = Math.round(numeric);
        }
      }

      if (resolvedMinutes === null) {
        Alert.alert(
          "Unable to parse answer",
          "Please reply with a number of minutes (for example, 45).",
        );
        setSubmitting(false);
        return;
      }

      const capture = await finalizeCapture(
        pendingCapture.baseContent,
        resolvedMinutes,
        pendingCapture.importance,
        pendingCapture.parseResult,
      );

      setFollowUpState(null);
      setFollowUpAnswer("");
      setPendingCapture(null);

      await attemptSchedule(capture.id);
    } catch (error: any) {
      Alert.alert("Save failed", error?.message ?? "Could not save capture.");
    } finally {
      setSubmitting(false);
    }
  }, [
    attemptSchedule,
    finalizeCapture,
    followUpAnswer,
    followUpState,
    pendingCapture,
  ]);

  const handleAddCapture = useCallback(async () => {
    if (!userId) {
      Alert.alert("Sign in required", "Please sign in to save ideas.");
      return;
    }

    const content = idea.trim();
    if (!content) {
      Alert.alert(
        "Add something first",
        "Tell DiaGuru what is on your mind before saving.",
      );
      return;
    }

    const trimmedMinutes = minutesInput.trim();
    const hasMinutes = trimmedMinutes.length > 0;
    let resolvedMinutes: number | null = null;
    if (hasMinutes) {
      resolvedMinutes = Number(trimmedMinutes);
      if (Number.isNaN(resolvedMinutes) || resolvedMinutes <= 0) {
        Alert.alert(
          "Check duration",
          "Estimated minutes should be a positive number.",
        );
        return;
      }
    }

    try {
      setSubmitting(true);
      setPendingCapture(null);
      setFollowUpState(null);
      setFollowUpAnswer("");

      const mode = await getAssistantModePreference();
      let parseResult: ParseTaskResponse | null = null;

      try {
        parseResult = await parseCapture({
          text: content,
          mode,
          timezone,
          now: new Date().toISOString(),
        });
      } catch (error) {
        if (!hasMinutes) {
          const message =
            error instanceof Error && error.message
              ? error.message
              : "We could not infer the duration automatically.";
          Alert.alert("DeepSeek failed", message);

          setSubmitting(false);
          return;
        }
      }

      if (!hasMinutes) {
        const candidate = parseResult?.structured?.estimated_minutes;
        if (typeof candidate === "number" && candidate > 0) {
          resolvedMinutes = candidate;
        } else if (parseResult?.follow_up) {
          setPendingCapture({
            baseContent: content,
            importance,
            appended: [],
            mode,
            parseResult,
          });
          setFollowUpState({
            prompt: parseResult.follow_up.prompt,
            missing: parseResult.follow_up.missing ?? [],
          });
          setStatusNotice({
            tone: "info",
            title: "Need one more detail",
            message: parseResult.follow_up.prompt,
          });
          setFollowUpAnswer("");
          setSubmitting(false);
          return;
        } else {
          Alert.alert(
            "DeepSeek failed",
            "DeepSeek did not provide a clarifying question in conversational strict mode.",
          );
          setSubmitting(false);
          return;
        }
      }

      if (resolvedMinutes === null) {
        Alert.alert(
          "DeepSeek failed",
          "DeepSeek could not infer a duration from your capture.",
        );
        setSubmitting(false);
        return;
      }

      const created = await finalizeCapture(
        content,
        resolvedMinutes,
        importance,
        parseResult,
      );
      await attemptSchedule(created.id);
    } catch (error: any) {
      Alert.alert("Save failed", error?.message ?? "Could not save capture.");
    } finally {
      setSubmitting(false);
    }
  }, [
    attemptSchedule,
    finalizeCapture,
    idea,
    importance,
    minutesInput,
    timezone,
    userId,
  ]);

  const overdueScheduled = useMemo(
    () =>
      scheduled.filter(
        (capture) =>
          capture.status === "scheduled" &&
          capture.planned_end &&
          new Date(capture.planned_end).getTime() <= Date.now(),
      ),
    [scheduled],
  );

  const upcomingScheduled = useMemo(
    () =>
      scheduled.filter(
        (capture) =>
          capture.status === "scheduled" &&
          capture.planned_start &&
          new Date(capture.planned_start).getTime() > Date.now(),
      ),
    [scheduled],
  );

  const pendingPreview = useMemo(() => pending.slice(0, 1), [pending]);
  const queueExtras = Math.max(0, pending.length - pendingPreview.length);
  const overduePreview = useMemo(
    () => overdueScheduled.slice(0, 1),
    [overdueScheduled],
  );
  const upcomingPreview = useMemo(
    () => upcomingScheduled.slice(0, 2),
    [upcomingScheduled],
  );
  const followUpVisible = Boolean(followUpState);
  const selectedImportanceLabel =
    IMPORTANCE_LEVELS.find((level) => level.value === importance)?.label ??
    "Medium";
  const normalizeCaptureDetailsSummary = (value: string) => value.replace(
    /[^\x20-\x7E]+/g,
    " - ",
  );
  const captureDetailsSummary = `${
    minutesInput.trim().length > 0 ? `${minutesInput.trim()} min` : "Auto duration"
  } • ${selectedImportanceLabel} priority`;

  const captureDetailsSummaryText = normalizeCaptureDetailsSummary(
    captureDetailsSummary,
  );

  const handleCompletionAction = useCallback(
    async (capture: Capture, action: CaptureStatus | "reschedule") => {
      if (!userId) return;
      setActionCaptureId(capture.id);
      try {
        if (action === "completed") {
          await invokeCaptureCompletion(capture.id, "complete");
          setStatusNotice({
            tone: "success",
            title: "Marked complete",
            message: `"${capture.content}" was marked as completed.`,
          });
        } else if (action === "reschedule") {
          await invokeCaptureCompletion(capture.id, "reschedule");
          // Immediately try to schedule this capture again
          await scheduleTopCapture(capture.id, "schedule");
        }
        await Promise.all([loadPending(), loadScheduled()]);
      } catch (error: any) {
        Alert.alert(
          "Action failed",
          error?.message ?? "Unable to update scheduled item.",
        );
      } finally {
        setActionCaptureId(null);
      }
    },
    [loadPending, loadScheduled, scheduleTopCapture, userId],
  );

  const captureForm = (
    <View style={styles.captureSection}>
      <Text style={styles.sectionTitle}>Capture</Text>
      <Text style={styles.sectionSubtext}>
        Add one task and let DiaGuru place it around your day.
      </Text>

      <TextInput
        value={idea}
        onChangeText={setIdea}
        placeholder="What needs your attention?"
        placeholderTextColor="#9CA3AF"
        multiline
        style={styles.ideaInput}
      />

      <TouchableOpacity
        style={styles.disclosureRow}
        onPress={() => setCaptureDetailsOpen((value) => !value)}
        activeOpacity={0.85}
      >
        <View style={styles.disclosureCopy}>
          <Text style={styles.disclosureTitle}>Details</Text>
          <Text style={styles.disclosureSummary}>
            {captureDetailsSummaryText}
          </Text>
        </View>
        <Text style={styles.disclosureAction}>
          {captureDetailsOpen ? "Hide" : "Edit"}
        </Text>
      </TouchableOpacity>

      {captureDetailsOpen ? (
        <View style={styles.disclosureBody}>
          <View style={styles.formRow}>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Est. minutes</Text>
              <TextInput
                value={minutesInput}
                onChangeText={setMinutesInput}
                placeholder="30"
                placeholderTextColor="#9CA3AF"
                keyboardType="numeric"
                style={styles.numberInput}
              />
            </View>

            <View style={[styles.formField, { flex: 1 }]}>
              <Text style={styles.fieldLabel}>Importance</Text>
              <View style={styles.importanceRow}>
                {IMPORTANCE_LEVELS.map((level) => (
                  <TouchableOpacity
                    key={level.value}
                    style={[
                      styles.importanceChip,
                      importance === level.value && styles.importanceChipActive,
                    ]}
                    onPress={() => setImportance(level.value)}
                  >
                    <Text
                      style={[
                        styles.importanceChipText,
                        importance === level.value &&
                          styles.importanceChipTextActive,
                      ]}
                    >
                      {level.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        </View>
      ) : null}

      <TouchableOpacity
        style={[
          styles.primaryButton,
          submitting && styles.primaryButtonDisabled,
        ]}
        onPress={handleAddCapture}
        disabled={submitting}
      >
        <Text style={styles.primaryButtonText}>
          {submitting ? "Saving..." : "Save and schedule"}
        </Text>
      </TouchableOpacity>

      {pendingLoading ? (
        <ActivityIndicator />
      ) : pendingError ? (
        <Text style={styles.errorText}>{pendingError}</Text>
      ) : pending.length === 0 ? (
        <Text style={styles.sectionSubtext}>
          You&apos;re clear for now. Add the next thing above.
        </Text>
      ) : (
        <View style={{ gap: 12 }}>
          <TouchableOpacity
            style={styles.disclosureRow}
            onPress={() => setQueueOpen((value) => !value)}
            activeOpacity={0.85}
          >
            <View style={styles.disclosureCopy}>
              <Text style={styles.disclosureTitle}>Queue</Text>
              <Text style={styles.disclosureSummary}>
                {pending.length} {pending.length === 1 ? "item" : "items"} waiting
              </Text>
            </View>
            <Text style={styles.disclosureAction}>
              {queueOpen ? "Hide" : "View"}
            </Text>
          </TouchableOpacity>
          {queueOpen ? (
            <View style={styles.disclosureBody}>
              <View style={styles.captureListHeader}>
                <Text style={styles.sectionSubtitle}>Next up</Text>
                <TouchableOpacity
                  disabled={scheduling || pending.length === 0}
                  onPress={() => scheduleEntireQueue()}
                  style={[
                    styles.secondaryButton,
                    (scheduling || pending.length === 0) &&
                      styles.primaryButtonDisabled,
                  ]}
                >
                  <Text
                    style={[
                      styles.secondaryButtonText,
                      (scheduling || pending.length === 0) &&
                        styles.secondaryButtonTextDisabled,
                    ]}
                  >
                    Re-run scheduling
                  </Text>
                </TouchableOpacity>
              </View>
              {pendingPreview.map((capture, index) => (
                <CaptureCard
                  key={capture.id}
                  capture={capture}
                  rank={index + 1}
                />
              ))}
              {queueExtras > 0 ? (
                <Text
                  style={styles.sectionSubtext}
                >{`+ ${queueExtras} more ${queueExtras === 1 ? "item" : "items"} in queue`}</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      )}
    </View>
  );

  const scheduledSection = (
    <View style={styles.captureSection}>
      <Text style={styles.sectionTitle}>Scheduled</Text>
      <Text style={styles.sectionSubtext}>
        Confirm finished items so the schedule stays current.
      </Text>

      {scheduledLoading ? (
        <ActivityIndicator />
      ) : scheduledError ? (
        <Text style={styles.errorText}>{scheduledError}</Text>
      ) : scheduled.length === 0 ? (
        <Text style={styles.sectionSubtext}>
          No DiaGuru sessions on the calendar yet.
        </Text>
      ) : (
        <>
          {overdueScheduled.length > 0 && (
            <View style={{ gap: 12 }}>
              <Text style={styles.sectionSubtitle}>Needs check-in</Text>
              {overduePreview.map((capture) => (
                <ScheduledCard
                  key={capture.id}
                  capture={capture}
                  pendingAction={actionCaptureId === capture.id}
                  onComplete={() =>
                    handleCompletionAction(capture, "completed")
                  }
                  onReschedule={() =>
                    handleCompletionAction(capture, "reschedule")
                  }
                />
              ))}
              {overdueScheduled.length > overduePreview.length ? (
                <Text
                  style={styles.sectionSubtext}
                >{`+ ${overdueScheduled.length - overduePreview.length} more awaiting confirmation`}</Text>
              ) : null}
            </View>
          )}

          {upcomingScheduled.length > 0 && (
            <View style={{ gap: 12 }}>
              <Text style={styles.sectionSubtitle}>Upcoming</Text>
              {upcomingPreview.map((capture) => (
                <ScheduledSummaryCard key={capture.id} capture={capture} />
              ))}
              {upcomingScheduled.length > upcomingPreview.length ? (
                <Text
                  style={styles.sectionSubtext}
                >{`+ ${upcomingScheduled.length - upcomingPreview.length} more scheduled`}</Text>
              ) : null}
            </View>
          )}
        </>
      )}
    </View>
  );

  const feedbackSection = recentPlan ? (
    <View style={[styles.noticeCard, styles.noticeCardInfo]}>
      <View style={styles.noticeHeader}>
        <View style={styles.noticeCopy}>
          <Text style={styles.noticeTitle}>Schedule updated</Text>
          <Text style={styles.noticeMessage}>{summarizePlan(recentPlan)}</Text>
        </View>
        <TouchableOpacity onPress={dismissPlanSummary}>
          <Text style={styles.noticeDismiss}>Dismiss</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.noticeActions}>
        <TouchableOpacity
          style={[styles.secondaryButton, undoingPlan && styles.primaryButtonDisabled]}
          onPress={handlePlanUndo}
          disabled={undoingPlan}
        >
          <Text
            style={[
              styles.secondaryButtonText,
              undoingPlan && styles.secondaryButtonTextDisabled,
            ]}
          >
            {undoingPlan ? "Undoing..." : "Undo changes"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  ) : statusNotice ? (
    <View
      style={[
        styles.noticeCard,
        statusNotice.tone === "success"
          ? styles.noticeCardSuccess
          : statusNotice.tone === "warning"
            ? styles.noticeCardWarning
            : styles.noticeCardInfo,
      ]}
    >
      <View style={styles.noticeHeader}>
        <View style={styles.noticeCopy}>
          <Text style={styles.noticeTitle}>{statusNotice.title}</Text>
          <Text style={styles.noticeMessage}>{statusNotice.message}</Text>
        </View>
        <TouchableOpacity onPress={() => setStatusNotice(null)}>
          <Text style={styles.noticeDismiss}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    </View>
  ) : null;

  return (
    <>
      <SafeAreaView
        style={[styles.safeArea, { paddingTop: Math.max(insets.top, 16) }]}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          <View style={styles.heroCard}>
            <View style={styles.heroCompactHeader}>
              <View style={styles.heroCopy}>
                <Text style={styles.heroEyebrow}>DiaGuru</Text>
                <Text style={styles.heroTitle}>
                  Capture one thing, then get back to work.
                </Text>
              </View>
              <View style={styles.heroBadge}>
                <Text style={styles.heroBadgeLabel}>Local time</Text>
                <Text style={styles.heroBadgeValue}>{timezone}</Text>
              </View>
            </View>
            <Text style={styles.heroSubtitle}>
              Add the next task, set the basics, and let DiaGuru place it
              around the rest of your day.
            </Text>
          </View>
          {feedbackSection}
          {captureForm}
          <CalendarHealthNotice
            health={calendarHealth}
            error={calendarHealthError}
            checking={calendarHealthChecking}
            onReconnect={handleReconnectCalendar}
            onRetry={refreshCalendarHealth}
          />
          {scheduledSection}
        </ScrollView>
      </SafeAreaView>

      <Modal
        visible={followUpVisible}
        animationType="fade"
        transparent
        onRequestClose={handleFollowUpCancel}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.followUpBackdrop}
        >
          <View style={styles.followUpCard}>
            <Text style={styles.followUpTitle}>DeepSeek asks</Text>
            <Text style={styles.followUpPrompt}>
              {followUpState?.prompt ??
                "Please answer the assistant\u2019s question."}
            </Text>
            {followUpState?.missing?.length ? (
              <Text style={styles.followUpHint}>
                Missing: {followUpState.missing.join(", ")}
              </Text>
            ) : null}
            <TextInput
              style={styles.followUpInput}
              value={followUpAnswer}
              onChangeText={setFollowUpAnswer}
              placeholder="Type your answer..."
              placeholderTextColor="#9CA3AF"
              autoFocus
              editable={!submitting}
            />
            <View style={styles.followUpActions}>
              <TouchableOpacity
                onPress={handleFollowUpCancel}
                style={styles.tertiaryButton}
                disabled={submitting}
              >
                <Text style={styles.tertiaryButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleFollowUpSubmit}
                style={[
                  styles.confirmButton,
                  submitting && styles.confirmButtonDisabled,
                ]}
                disabled={submitting}
              >
                <Text style={styles.confirmButtonText}>
                  {submitting ? "Saving..." : "Send"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

function CaptureCard({ capture, rank }: { capture: Capture; rank: number }) {
  return (
    <View style={styles.captureCard}>
      <View style={styles.captureCardHeader}>
        <Text style={styles.captureRank}>{`#${rank}`}</Text>
        <Text style={[styles.captureTitle, styles.captureTitleFlex]}>
          {capture.content}
        </Text>
      </View>
      <Text style={styles.captureMeta}>
        {"Importance: " +
          (IMPORTANCE_LEVELS.find((it) => it.value === capture.importance)
            ?.label ?? "Medium")}
        {capture.estimated_minutes
          ? " | ~" + capture.estimated_minutes + " min"
          : ""}
      </Text>
    </View>
  );
}

function ScheduledCard({
  capture,
  pendingAction,
  onComplete,
  onReschedule,
}: {
  capture: Capture;
  pendingAction: boolean;
  onComplete: () => void;
  onReschedule: () => void;
}) {
  const start = capture.planned_start ? new Date(capture.planned_start) : null;
  const end = capture.planned_end ? new Date(capture.planned_end) : null;

  return (
    <View style={styles.captureCard}>
      <Text style={styles.captureTitle}>{capture.content}</Text>
      <Text style={styles.captureMeta}>
        {start ? start.toLocaleString() : "Scheduled time unavailable"}
        {end
          ? ` -> ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : ""}
      </Text>
      <View style={styles.captureActions}>
        <TouchableOpacity
          style={[
            styles.primaryButton,
            { flex: 1 },
            pendingAction && styles.primaryButtonDisabled,
          ]}
          onPress={onComplete}
          disabled={pendingAction}
        >
          <Text style={styles.primaryButtonText}>
            {pendingAction ? "Updating..." : "Completed"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.secondaryButton,
            { flex: 1 },
            pendingAction && styles.primaryButtonDisabled,
          ]}
          onPress={onReschedule}
          disabled={pendingAction}
        >
          <Text
            style={[
              styles.secondaryButtonText,
              pendingAction && styles.secondaryButtonTextDisabled,
            ]}
          >
            Reschedule
          </Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity
        style={styles.whyLink}
        onPress={() => showScheduleWhy(capture)}
      >
        <Text style={styles.whyText}>Why this time?</Text>
      </TouchableOpacity>
    </View>
  );
}

function ScheduledSummaryCard({ capture }: { capture: Capture }) {
  const start = capture.planned_start ? new Date(capture.planned_start) : null;
  const end = capture.planned_end ? new Date(capture.planned_end) : null;
  return (
    <View style={styles.captureCard}>
      <Text style={styles.captureTitle}>{capture.content}</Text>
      <Text style={styles.captureMeta}>
        {start ? start.toLocaleString() : "Scheduled time unavailable"}
        {end
          ? ` -> ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} `
          : ""}
      </Text>
      <TouchableOpacity
        style={styles.whyLink}
        onPress={() => showScheduleWhy(capture)}
      >
        <Text style={styles.whyText}>Why this time?</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F8FAFC" },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 32,
    gap: 16,
  },
  heroCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  heroCompactHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  heroCopy: {
    flex: 1,
    gap: 4,
  },
  heroEyebrow: {
    color: "#475569",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: "700",
    lineHeight: 27,
    color: "#111827",
  },
  heroSubtitle: { color: "#475569", lineHeight: 20 },
  heroBadge: {
    backgroundColor: "#F1F5F9",
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minWidth: 108,
    gap: 4,
  },
  heroBadgeLabel: {
    color: "#475569",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  heroBadgeValue: {
    color: "#111827",
    fontSize: 14,
    fontWeight: "700",
  },
  noticeCard: {
    borderRadius: 14,
    padding: 14,
    gap: 10,
    borderWidth: 1,
  },
  noticeCardSuccess: {
    backgroundColor: "#F0FDF4",
    borderColor: "#BBF7D0",
  },
  noticeCardInfo: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
  },
  noticeCardWarning: {
    backgroundColor: "#FFFBEB",
    borderColor: "#FDE68A",
  },
  noticeHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  noticeCopy: {
    flex: 1,
    gap: 4,
  },
  noticeTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111827",
  },
  noticeMessage: {
    color: "#475569",
    lineHeight: 20,
  },
  noticeDismiss: {
    color: "#64748B",
    fontWeight: "600",
  },
  noticeActions: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },
  captureSection: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    gap: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: "#111827" },
  sectionSubtext: { color: "#475569" },
  sectionSubtitle: { fontSize: 16, fontWeight: "700", color: "#111827" },
  disclosureRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "#F8FAFC",
  },
  disclosureCopy: {
    flex: 1,
    gap: 2,
  },
  disclosureTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#111827",
  },
  disclosureSummary: {
    color: "#64748B",
    fontSize: 13,
  },
  disclosureAction: {
    color: "#334155",
    fontWeight: "600",
  },
  disclosureBody: {
    gap: 12,
  },
  ideaInput: {
    minHeight: 80,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 14,
    padding: 14,
    textAlignVertical: "top",
    color: "#111827",
    backgroundColor: "#FFFFFF",
  },
  formRow: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  formField: { flex: 1, minWidth: 150, gap: 6 },
  fieldLabel: { fontWeight: "600", color: "#111827" },
  numberInput: {
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 14,
    padding: 12,
    color: "#111827",
    backgroundColor: "#FFFFFF",
  },
  importanceRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  importanceChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#d1d5db",
  },
  importanceChipActive: {
    backgroundColor: "#111827",
    borderColor: "#111827",
  },
  importanceChipText: { color: "#475569", fontWeight: "600" },
  importanceChipTextActive: { color: "#fff" },
  primaryButton: {
    backgroundColor: "#111827",
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: "#fff", fontWeight: "700" },
  secondaryButton: {
    borderRadius: 14,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#CBD5E1",
  },
  secondaryButtonText: { color: "#111827", fontWeight: "600" },
  secondaryButtonTextDisabled: { color: "#9CA3AF" },
  captureListHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  captureCard: {
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    padding: 14,
    gap: 6,
    backgroundColor: "#FFFFFF",
  },
  captureCardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  captureRank: {
    fontSize: 12,
    fontWeight: "700",
    color: "#475569",
    backgroundColor: "#F1F5F9",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: "hidden",
  },
  captureTitle: { fontSize: 16, fontWeight: "600", color: "#111827" },
  captureTitleFlex: { flex: 1 },
  captureMeta: { color: "#475569" },
  captureActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 12,
    flexWrap: "wrap",
  },
  whyLink: { alignSelf: "flex-start", marginTop: 8 },
  whyText: { color: "#334155", fontWeight: "600" },
  card: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    gap: 4,
  },
  title: { fontSize: 16, fontWeight: "600", marginBottom: 4, color: "#111" },
  time: { color: "#555" },
  errorText: { color: "#DC2626" },
  followUpBackdrop: {
    flex: 1,
    backgroundColor: "rgba(17, 24, 39, 0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  followUpCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    gap: 12,
  },
  followUpTitle: { fontSize: 18, fontWeight: "800", color: "#111827" },
  followUpPrompt: { color: "#475569" },
  followUpHint: { color: "#6B7280", fontSize: 12 },
  followUpInput: {
    borderWidth: 1,
    borderColor: "#CBD5E1",
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: "#111827",
    backgroundColor: "#FFFFFF",
  },
  followUpActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
    flexWrap: "wrap",
  },
  tertiaryButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    backgroundColor: "#fff",
  },
  tertiaryButtonText: { color: "#111827", fontWeight: "600" },
  confirmButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: "#111827",
  },
  confirmButtonDisabled: { opacity: 0.6 },
  confirmButtonText: { color: "#fff", fontWeight: "700" },
});
