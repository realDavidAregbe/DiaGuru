
import { computePriorityScore, type PriorityInput } from "../../../shared/priority.ts";
import type { CaptureEntryRow } from "../types.ts";
import type { ChunkRecord } from "./chunks.ts";
import {
    computePrioritySnapshot,
    schedulerConfig,
    type NetGainEvaluation,
    type PreemptionDisplacement,
} from "./scheduler-config.ts";

export const BUFFER_MINUTES = 10;
export const COMPRESSED_BUFFER_MINUTES = 5;
export const SEARCH_DAYS = 7;
export const DAY_END_HOUR = 22;
export const SLOT_INCREMENT_MINUTES = 15;
export const STABILITY_WINDOW_MINUTES = 30;
export const DEFAULT_MIN_CHUNK_MINUTES = SLOT_INCREMENT_MINUTES;
export const TARGET_CHUNK_MINUTES = schedulerConfig.chunking.targetChunkMinutes;
export const ROUTINE_PRIORITY_RULES = {
    sleep: { scaler: 0.7, cap: 70 },
    meal: { scaler: 0.5, cap: 55 },
} as const;


export const DEADLINE_RULES: Record<string, DeadlineStrategy> = {
  deadline_time: (c) => c.constraint_time,
  deadline: (c) => c.constraint_time,
  end_time: (c) => c.constraint_time,
  deadline_date: (c, offset) =>
    computeDateDeadline(c.constraint_date, offset)?.toISOString() ?? null,
  window: (c) => c.constraint_end,
  start_time: () => null,
};

export type RoutineKind = keyof typeof ROUTINE_PRIORITY_RULES;
export type DeadlineStrategy = (capture: CaptureEntryRow, offsetMinutes: number) => string | null;


export class ScheduleError extends Error {
    status: number;
    details?: unknown;

    constructor(message: string, status = 500, details?: unknown) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

export type CalendarEvent = {
    id: string;
    summary?: string;
    etag?: string;
    updated?: string;
    start: { dateTime?: string; date?: string };
    end: { dateTime?: string; date?: string };
    extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
};

export type ScheduleAdvisor = {
    action: "suggest_slot" | "ask_overlap" | "defer";
    message: string;
    slot?: { start: string; end?: string | null } | null;
};

export type ConflictSummary = {
    id: string;
    summary?: string;
    start?: string;
    end?: string;
    diaGuru?: boolean;
    captureId?: string;
};

export type ScheduleDecision = {
    type: "preferred_conflict";
    message: string;
    preferred: { start: string; end: string };
    conflicts: ConflictSummary[];
    suggestion?: { start: string; end: string } | null;
    advisor?: ScheduleAdvisor | null;
    metadata?: {
        llmAttempted: boolean;
        llmModel?: string | null;
        llmError?: string | null;
    };
};

export type ConflictDecision = {
    decision: ScheduleDecision;
    note: string;
};

export type PreferredSlot = { start: Date; end: Date };

export type OccupancySlotStatus = "free" | "external" | "diaguru";

export type OccupancySlot = {
    start: Date;
    end: Date;
    status: OccupancySlotStatus;
    eventId?: string;
    captureId?: string;
};

export type OccupancyStats = {
    free: number;
    external: number;
    diaguru: number;
    total: number;
};

export type OccupancySegment = {
    start: string;
    end: string;
    status: OccupancySlotStatus;
    eventId?: string;
    captureId?: string;
};

export type OccupancyDaySummary = {
    day: string;
    stats: OccupancyStats;
    segments: OccupancySegment[];
};

export type OccupancyGrid = {
    start: Date;
    end: Date;
    slotMinutes: number;
    stats: OccupancyStats;
    slots: OccupancySlot[];
    days: OccupancyDaySummary[];
};

export type GridWindowCandidate = {
    slot: PreferredSlot;
    stats: {
        totalMinutes: number;
        freeMinutes: number;
        diaguruMinutes: number;
        externalMinutes: number;
        diaguruBreakdown: Record<string, number>;
        diaguruCount: number;
    };
    hasExternal: boolean;
};

export type GridPreemptionChoice = {
    slot: PreferredSlot;
    conflicts: ConflictSummary[];
    captureMap: Map<string, CaptureEntryRow>;
    evaluation: NetGainEvaluation;
};

export type ChunkPlacementResult = {
    records: ChunkRecord[];
    intervals: { start: Date; end: Date }[];
};

export type SerializedChunk = {
    start: string;
    end: string;
    late: boolean;
    overlapped: boolean;
    prime: boolean;
};

export type SchedulingPlan = {
    mode: "flexible" | "deadline" | "window" | "start";
    preferredSlot: PreferredSlot | null;
    deadline?: Date | null;
    window?: { start: Date; end: Date } | null;
};

export function isRoutineKind(kind: string | null | undefined) {
    if (!kind) return false;
    return kind.startsWith("routine.");
}

// Uses existing parseIsoDate helper from your codebase.
export function resolveSleepBaseReference(
  capture: CaptureEntryRow,
  referenceNow: Date,
): Date {
  // 1) Prefer explicit target times if present
  const fromStartTarget =
    capture.start_target_at ? parseIsoDate(capture.start_target_at) : null;
  if (fromStartTarget) return fromStartTarget;

  const fromOriginal =
    capture.original_target_time ? parseIsoDate(capture.original_target_time) : null;
  if (fromOriginal) return fromOriginal;

  // 2) Fall back to relative day preference (today/tomorrow)
  let dayOffset = 0;
  if (capture.time_pref_day === "tomorrow") {
    dayOffset = 1;
  }
  // If you later support "specific_date", you'd handle it here.

  return new Date(referenceNow.getTime() + dayOffset * 24 * 60 * 60 * 1000);
}


export function normalizeRoutineCapture(input: CaptureEntryRow, options: { referenceNow: Date; timezone?: string }) {
    const capture = { ...input };
    const { referenceNow } = options;

    const isSleep = capture.task_type_hint === "routine.sleep" || capture.extraction_kind === "routine.sleep";
    const isMeal = capture.task_type_hint === "routine.meal" || capture.extraction_kind === "routine.meal";
    const isRoutine = isSleep || isMeal || isRoutineKind(capture.task_type_hint);

    if (!isRoutine) return capture;

    const userLocked = Boolean(capture.manual_touch_at) || Boolean(capture.freeze_until);

    if (isSleep) {
  try {
        const timezone = options.timezone ?? "UTC";
        const baseRef = resolveSleepBaseReference(capture, referenceNow);

        console.log("[NORMALIZE] Sleep task detected", {
        timezone,
        time_pref_day: capture.time_pref_day,
        original_target_time: capture.original_target_time,
        start_target_at: capture.start_target_at,
        baseRef,
        });

        // Night start: 22:00 on the *baseRef* day in the user's timezone
        const nightStart = buildZonedDateTime({
        timezone,
        reference: baseRef,
        hour: 22,
        minute: 0,
        });

        console.log("[NORMALIZE] nightStart calculated:", nightStart);

        // Night end: ~07:30 the following morning
        const nextDayRef = new Date(baseRef.getTime() + 24 * 60 * 60 * 1000);
        const nightEnd = buildZonedDateTime({
        timezone,
        reference: nextDayRef,
        hour: 7,
        minute: 30,
        });

        console.log("[NORMALIZE] nightEnd calculated:", nightEnd);

        // FORCE sleep into a window for that specific night
        capture.constraint_type = "window";
        capture.window_start = nightStart;
        capture.window_end = nightEnd;
        capture.constraint_time = nightStart;
        capture.constraint_end = nightEnd;

        console.log("[NORMALIZE] Final sleep capture:", {
        window_start: capture.window_start,
        window_end: capture.window_end,
        });

        // Optional but keeps your existing behavior:
        // treat the end of the sleep window as the "deadline" for this sleep.
        capture.deadline_at = capture.deadline_at ?? capture.window_end;
    } catch (error) {
        console.error("[NORMALIZE] Error in sleep normalization:", error);
        // On error, keep whatever was there before.
    }

    capture.start_flexibility = "soft";
    capture.duration_flexibility = "fixed";
    capture.cannot_overlap = true;
    capture.time_pref_time_of_day = capture.time_pref_time_of_day ?? "night";

    if (!userLocked) {
        capture.freeze_until = null;
    }
    } else if (isMeal) {
        const timezone = options.timezone ?? "UTC";
        if (!capture.window_start || !capture.window_end) {

            const localMealStart = buildZonedDateTime({
                timezone,
                reference: referenceNow,
                hour: 12,
                minute: 0,
            });
            const localMealEnd = buildZonedDateTime({
                timezone,
                reference: referenceNow,
                hour: 14,
                minute: 0,
            });

            capture.window_start = localMealStart;
            capture.window_end = localMealEnd;
            capture.constraint_type = "window";
            capture.constraint_time = capture.window_start;
            capture.constraint_end = capture.window_end;
        }
        capture.start_flexibility = capture.start_flexibility ?? "soft";
        capture.duration_flexibility = capture.duration_flexibility ?? "fixed";
        capture.cannot_overlap = capture.cannot_overlap ?? false;
        if (!userLocked) {
            capture.freeze_until = null;
        }
    }

    console.log("[NORMALIZE] Returning capture:", {
        task_type_hint: capture.task_type_hint,
        constraint_type: capture.constraint_type,
        window_start: capture.window_start,
        window_end: capture.window_end,
        constraint_time: capture.constraint_time,
        constraint_end: capture.constraint_end,
    });

    return capture;
}

export function findNextAvailableSlot(
    intervals: { start: Date; end: Date }[],
    durationMinutes: number,
    offsetMinutes: number,
    options: {
        startFrom?: Date;
        referenceNow?: Date;
        enforceWorkingWindow?: boolean;
        preferredTimeOfDay?: { start: number; end: number }[];
    } = {},
) {
    const referenceNow = options.referenceNow ?? new Date();
    const enforceWorkingWindow = options.enforceWorkingWindow ?? true;
    intervals.sort((a, b) => a.start.getTime() - b.start.getTime());

    let cursor = options.startFrom
        ? new Date(Math.max(options.startFrom.getTime(), referenceNow.getTime()))
        : addMinutes(referenceNow, 5);

    const searchWindow = (start: Date, end: Date) => {
        let candidateStart = new Date(start.getTime());
        const limit = end.getTime();
        const durationMs = durationMinutes * 60000;

        while (candidateStart.getTime() + durationMs <= limit) {
            const candidateEnd = new Date(candidateStart.getTime() + durationMs);
            if (isSlotFree(candidateStart, candidateEnd, intervals)) {
                return { start: candidateStart, end: candidateEnd };
            }
            candidateStart = addMinutes(candidateStart, SLOT_INCREMENT_MINUTES);
        }
        return null;
    };

    if (options.preferredTimeOfDay && options.preferredTimeOfDay.length > 0) {
        for (let day = 0; day < SEARCH_DAYS; day++) {
            const dayAnchor = addDays(referenceNow, day);
            const local = toLocalDate(dayAnchor, offsetMinutes);
            local.setHours(0, 0, 0, 0);
            const dayStartMidnight = toUtcDate(local, offsetMinutes);

            for (const pref of options.preferredTimeOfDay) {
                const windowStart = addMinutes(dayStartMidnight, pref.start * 60);
                const windowEnd = addMinutes(dayStartMidnight, pref.end * 60);

                const effectiveStart = new Date(Math.max(windowStart.getTime(), cursor.getTime()));
                const effectiveEnd = windowEnd;

                if (effectiveStart.getTime() >= effectiveEnd.getTime()) continue;

                const slot = searchWindow(effectiveStart, effectiveEnd);
                if (slot) return slot;
            }
        }
    }

    if (!enforceWorkingWindow) {
        const maxSearchMinutes = SEARCH_DAYS * 24 * 60;
        let candidateStart = new Date(cursor.getTime());
        const limit = candidateStart.getTime() + maxSearchMinutes * 60000;
        const durationMs = durationMinutes * 60000;
        while (candidateStart.getTime() + durationMs <= limit) {
            const candidateEnd = new Date(candidateStart.getTime() + durationMs);
            if (isSlotFree(candidateStart, candidateEnd, intervals)) {
                return { start: candidateStart, end: candidateEnd };
            }
            candidateStart = addMinutes(candidateStart, SLOT_INCREMENT_MINUTES);
        }
        return null;
    }

    if (isBeforeDayStart(cursor, offsetMinutes)) {
        cursor = startOfDayOffset(referenceNow, offsetMinutes);
    }

    for (let day = 0; day < SEARCH_DAYS; day++) {
        const dayAnchor = addDays(referenceNow, day);
        const dayStart = startOfDayOffset(dayAnchor, offsetMinutes);
        let candidateStart = new Date(Math.max(dayStart.getTime(), cursor.getTime()));

        while (true) {
            if (isAfterDayEnd(candidateStart, offsetMinutes)) break;
            const candidateEnd = addMinutes(candidateStart, durationMinutes);
            if (isAfterDayEnd(candidateEnd, offsetMinutes)) break;

            if (isSlotFree(candidateStart, candidateEnd, intervals)) {
                return { start: candidateStart, end: candidateEnd };
            }

            candidateStart = addMinutes(candidateStart, SLOT_INCREMENT_MINUTES);
        }

        cursor = startOfDayOffset(addDays(referenceNow, day + 1), offsetMinutes);
    }

    return null;
}

export function computeBusyIntervals(events: CalendarEvent[], bufferMinutes = BUFFER_MINUTES) {
    const intervals = events
        .map((event) => {
            const start = parseEventDate(event.start);
            const end = parseEventDate(event.end);
            if (!start || !end) return null;
            return {
                start: addMinutes(start, -bufferMinutes),
                end: addMinutes(end, bufferMinutes),
            };
        })
        .filter(Boolean) as { start: Date; end: Date }[];

    intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
    return intervals;
}

export function buildOccupancyGrid(args: {
    events: CalendarEvent[];
    offsetMinutes: number;
    referenceNow: Date;
    days?: number;
}): OccupancyGrid {
    const slotMinutes = SLOT_INCREMENT_MINUTES;
    const slotMs = slotMinutes * 60000;
    const totalDays = Math.max(1, Math.min(SEARCH_DAYS, args.days ?? SEARCH_DAYS));
    const { startHour, endHour } = schedulerConfig.workingWindow;
    const localNow = toLocalDate(args.referenceNow, args.offsetMinutes);
    const localStart = new Date(localNow.getTime());
    localStart.setUTCHours(startHour, 0, 0, 0);
    if (localNow.getUTCHours() >= endHour) {
        localStart.setUTCDate(localStart.getUTCDate() + 1);
    }

    const gridStart = toUtcDate(localStart, args.offsetMinutes);
    const localGridEnd = new Date(localStart.getTime());
    localGridEnd.setUTCDate(localGridEnd.getUTCDate() + totalDays - 1);
    localGridEnd.setUTCHours(endHour, 0, 0, 0);
    const gridEnd = toUtcDate(localGridEnd, args.offsetMinutes);

    const eventWindows = args.events
        .map((event) => {
            const start = parseEventDate(event.start);
            const end = parseEventDate(event.end);
            if (!start || !end) return null;
            if (end.getTime() <= gridStart.getTime() || start.getTime() >= gridEnd.getTime()) {
                return null;
            }
            const isDiaGuru = event.extendedProperties?.private?.diaGuru === "true";
            const captureId = event.extendedProperties?.private?.capture_id ?? null;
            return { start, end, isDiaGuru, captureId, id: event.id };
        })
        .filter(Boolean) as {
            start: Date;
            end: Date;
            isDiaGuru: boolean;
            captureId: string | null;
            id: string;
        }[];

    const allSlots: OccupancySlot[] = [];
    const daySummaries: OccupancyDaySummary[] = [];

    for (let day = 0; day < totalDays; day++) {
        const dayStartLocal = new Date(localStart.getTime());
        dayStartLocal.setUTCDate(dayStartLocal.getUTCDate() + day);
        const dayEndLocal = new Date(dayStartLocal.getTime());
        dayEndLocal.setUTCHours(endHour, 0, 0, 0);
        const dayStartUtc = toUtcDate(dayStartLocal, args.offsetMinutes);
        const dayEndUtc = toUtcDate(dayEndLocal, args.offsetMinutes);

        const daySlots: OccupancySlot[] = [];
        for (let cursor = new Date(dayStartUtc.getTime()); cursor.getTime() < dayEndUtc.getTime(); cursor = new Date(cursor.getTime() + slotMs)) {
            const slotEnd = new Date(cursor.getTime() + slotMs);
            let status: OccupancySlotStatus = "free";
            let eventId: string | undefined;
            let captureId: string | undefined;

            for (const event of eventWindows) {
                if (event.start.getTime() >= slotEnd.getTime()) continue;
                if (event.end.getTime() <= cursor.getTime()) continue;
                status = event.isDiaGuru ? "diaguru" : "external";
                eventId = event.id;
                captureId = event.captureId ?? undefined;
                if (event.isDiaGuru) break;
            }

            daySlots.push({ start: new Date(cursor.getTime()), end: slotEnd, status, eventId, captureId });
        }

        const dayStats = summarizeSlotStats(daySlots);
        const segments = compressOccupancySegments(daySlots);
        const label = formatLocalDayLabel(dayStartUtc, args.offsetMinutes);
        daySummaries.push({ day: label, stats: dayStats, segments });
        allSlots.push(...daySlots);
    }

    return {
        start: gridStart,
        end: gridEnd,
        slotMinutes,
        stats: summarizeSlotStats(allSlots),
        slots: allSlots,
        days: daySummaries,
    };
}

export function collectGridWindowCandidates(args: {
    grid: OccupancyGrid;
    durationMinutes: number;
    windowStart?: Date | null;
    windowEnd?: Date | null;
    referenceNow: Date;
    limit?: number;
}): GridWindowCandidate[] {
    const { grid } = args;
    const slotMinutes = Math.max(1, grid.slotMinutes);
    const slotsNeeded = Math.max(1, Math.ceil(args.durationMinutes / slotMinutes));
    if (grid.slots.length === 0) return [];

    const rangeStart = Math.max(
        grid.start.getTime(),
        args.referenceNow.getTime(),
        args.windowStart ? args.windowStart.getTime() : grid.start.getTime(),
    );
    const rangeEnd = Math.min(
        grid.end.getTime(),
        args.windowEnd ? args.windowEnd.getTime() : grid.end.getTime(),
    );
    if (rangeStart >= rangeEnd) return [];

    const results: GridWindowCandidate[] = [];
    for (let i = 0; i < grid.slots.length; i++) {
        const slot = grid.slots[i];
        if (slot.start.getTime() < rangeStart) continue;
        const lastIndex = i + slotsNeeded - 1;
        if (lastIndex >= grid.slots.length) break;
        const lastSlot = grid.slots[lastIndex];
        if (lastSlot.end.getTime() > rangeEnd) break;

        const candidate = analyzeGridWindow(grid.slots, i, slotsNeeded, slotMinutes);
        results.push(candidate);
        if (args.limit && results.length >= args.limit) break;
    }

    return results;
}

function analyzeGridWindow(
    slots: OccupancySlot[],
    startIndex: number,
    size: number,
    slotMinutes: number,
): GridWindowCandidate {
    const diaguruBreakdown = new Map<string, number>();
    let freeMinutes = 0;
    let diaguruMinutes = 0;
    let externalMinutes = 0;

    for (let i = 0; i < size; i++) {
        const slot = slots[startIndex + i];
        if (!slot) break;
        if (slot.status === "free") {
            freeMinutes += slotMinutes;
        } else if (slot.status === "diaguru") {
            diaguruMinutes += slotMinutes;
            if (slot.captureId) {
                const prev = diaguruBreakdown.get(slot.captureId) ?? 0;
                diaguruBreakdown.set(slot.captureId, prev + slotMinutes);
            }
        } else if (slot.status === "external") {
            externalMinutes += slotMinutes;
        }
    }

    const startSlot = slots[startIndex];
    const endSlot = slots[startIndex + size - 1];
    const totalMinutes = freeMinutes + diaguruMinutes + externalMinutes;
    return {
        slot: { start: new Date(startSlot.start), end: new Date(endSlot.end) },
        stats: {
            totalMinutes,
            freeMinutes,
            diaguruMinutes,
            externalMinutes,
            diaguruBreakdown: Object.fromEntries(diaguruBreakdown.entries()),
            diaguruCount: diaguruBreakdown.size,
        },
        hasExternal: externalMinutes > 0,
    };
}

export function generateChunkDurations(args: {
    totalMinutes: number;
    minChunkMinutes?: number | null;
    maxSplits?: number | null;
    allowSplitting: boolean;
}): number[] {
    const increment = SLOT_INCREMENT_MINUTES;
    const totalMinutes = Math.max(increment, roundUpToIncrement(args.totalMinutes, increment));
    if (!args.allowSplitting) return [totalMinutes];

    const minChunkMinutes = Math.max(
        increment,
        roundUpToIncrement(args.minChunkMinutes ?? DEFAULT_MIN_CHUNK_MINUTES, increment),
    );
    const totalIncrements = Math.max(1, Math.ceil(totalMinutes / increment));
    const minChunkIncrements = Math.max(1, Math.ceil(minChunkMinutes / increment));
    const targetChunkIncrements = Math.max(
        minChunkIncrements,
        Math.ceil(TARGET_CHUNK_MINUTES / increment),
    );

    const maxChunksFromDuration = Math.floor(totalIncrements / minChunkIncrements);
    if (maxChunksFromDuration <= 1) return [totalMinutes];

    const maxSplits = typeof args.maxSplits === "number" && args.maxSplits > 0
        ? Math.max(1, Math.floor(args.maxSplits))
        : Infinity;
    const cappedChunks = Math.min(maxChunksFromDuration, maxSplits);
    if (cappedChunks <= 1) return [totalMinutes];

    const roughCount = Math.ceil(totalIncrements / targetChunkIncrements);
    let chunkCount = Math.max(1, Math.min(cappedChunks, roughCount));

    while (chunkCount > 1 && Math.floor(totalIncrements / chunkCount) < minChunkIncrements) {
        chunkCount -= 1;
    }

    const baseIncrements = Math.floor(totalIncrements / chunkCount);
    let remainder = totalIncrements - baseIncrements * chunkCount;
    const chunkIncrements = Array(chunkCount)
        .fill(baseIncrements)
        .map((value) => Math.max(value, minChunkIncrements));

    let cursor = 0;
    while (remainder > 0) {
        const index = cursor % chunkIncrements.length;
        chunkIncrements[index] += 1;
        remainder -= 1;
        cursor += 1;
    }

    return chunkIncrements.map((value) => value * increment);
}

export function placeChunksWithinRange(args: {
    chunkDurations: number[];
    busyIntervals: { start: Date; end: Date }[];
    offsetMinutes: number;
    rangeStart: Date;
    rangeEnd: Date;
    enforceWorkingWindow?: boolean;
}): ChunkPlacementResult | null {
    if (args.chunkDurations.length === 0) {
        return {
            records: [],
            intervals: args.busyIntervals.map((interval) => ({
                start: new Date(interval.start),
                end: new Date(interval.end),
            })),
        };
    }
    const intervals = args.busyIntervals.map((interval) => ({
        start: new Date(interval.start),
        end: new Date(interval.end),
    }));
    const placements: ChunkRecord[] = [];
    let cursor = alignToSlotIncrement(args.rangeStart);

    for (const minutes of args.chunkDurations) {
        const slot = findSlotWithinRange(
            intervals,
            minutes,
            args.offsetMinutes,
            {
                start: cursor,
                end: args.rangeEnd,
            },
            args.enforceWorkingWindow ?? true,
        );
        if (!slot) {
            return null;
        }
        placements.push({ start: slot.start, end: slot.end, prime: true });
        registerInterval(intervals, slot);
        cursor = alignToSlotIncrement(slot.end);
    }

    return { records: placements, intervals };
}

function findSlotWithinRange(
    intervals: { start: Date; end: Date }[],
    durationMinutes: number,
    offsetMinutes: number,
    options: { start: Date; end: Date },
    enforceWorkingWindow = true,
): PreferredSlot | null {
    const durationMs = durationMinutes * 60000;
    let candidateStart = alignToSlotIncrement(options.start);
    const limit = options.end.getTime();
    if (candidateStart.getTime() + durationMs > limit) return null;

    while (candidateStart.getTime() + durationMs <= limit) {
        const candidateEnd = new Date(candidateStart.getTime() + durationMs);
        if (
            (!enforceWorkingWindow || !isBeforeDayStart(candidateStart, offsetMinutes)) &&
            (!enforceWorkingWindow || !isAfterDayEnd(candidateEnd, offsetMinutes)) &&
            isSlotFree(candidateStart, candidateEnd, intervals)
        ) {
            return { start: candidateStart, end: candidateEnd };
        }

        candidateStart = addMinutes(candidateStart, SLOT_INCREMENT_MINUTES);
        if (candidateStart.getTime() >= limit) break;
        if (enforceWorkingWindow && isAfterDayEnd(candidateStart, offsetMinutes)) {
            const nextDay = startOfDayOffset(addDays(candidateStart, 1), offsetMinutes);
            candidateStart = alignToSlotIncrement(
                new Date(Math.max(nextDay.getTime(), options.start.getTime())),
            );
        }
    }

    return null;
}

export function findLatePlacementSlot(args: {
    busyIntervals: { start: Date; end: Date }[];
    durationMinutes: number;
    offsetMinutes: number;
    referenceNow: Date;
    startFrom: Date;
    enforceWorkingWindow?: boolean;
}) {
    const startFrom = new Date(Math.max(args.startFrom.getTime(), args.referenceNow.getTime()));
    return findNextAvailableSlot(args.busyIntervals, args.durationMinutes, args.offsetMinutes, {
        startFrom,
        referenceNow: args.referenceNow,
        enforceWorkingWindow: args.enforceWorkingWindow,
    });
}

function alignToSlotIncrement(date: Date) {
    const incrementMs = SLOT_INCREMENT_MINUTES * 60000;
    const remainder = date.getTime() % incrementMs;
    if (remainder === 0) {
        return new Date(date.getTime());
    }
    return new Date(date.getTime() + (incrementMs - remainder));
}

function roundUpToIncrement(value: number, increment: number) {
    if (increment <= 0) return value;
    return Math.ceil(value / increment) * increment;
}

export function buildChunksForSlot(
    capture: CaptureEntryRow,
    slot: PreferredSlot,
    options: { late?: boolean; overlapped?: boolean; prime?: boolean } = {},
): ChunkRecord[] {
    const slotMinutes = Math.max(
        SLOT_INCREMENT_MINUTES,
        Math.max(1, Math.round((slot.end.getTime() - slot.start.getTime()) / 60000)),
    );
    const durations = generateChunkDurations({
        totalMinutes: slotMinutes,
        minChunkMinutes: capture.min_chunk_minutes ?? DEFAULT_MIN_CHUNK_MINUTES,
        maxSplits: capture.max_splits ?? null,
        allowSplitting: capture.duration_flexibility === "split_allowed",
    });

    if (durations.length === 0) {
        return [
            {
                start: new Date(slot.start),
                end: new Date(slot.end),
                prime: options.prime ?? true,
                late: options.late ?? false,
                overlapped: options.overlapped ?? false,
            },
        ];
    }

    const records: ChunkRecord[] = [];
    let cursor = new Date(slot.start);
    for (let i = 0; i < durations.length; i++) {
        const minutes = durations[i];
        let chunkEnd = addMinutes(cursor, minutes);
        if (chunkEnd.getTime() > slot.end.getTime() || i === durations.length - 1) {
            chunkEnd = new Date(slot.end);
        }
        if (chunkEnd.getTime() <= cursor.getTime()) break;
        records.push({
            start: new Date(cursor),
            end: chunkEnd,
            prime: options.prime ?? true,
            late: options.late ?? false,
            overlapped: options.overlapped ?? false,
        });
        cursor = new Date(chunkEnd);
        if (cursor.getTime() >= slot.end.getTime()) break;
    }

    if (records.length === 0) {
        records.push({
            start: new Date(slot.start),
            end: new Date(slot.end),
            prime: options.prime ?? true,
            late: options.late ?? false,
            overlapped: options.overlapped ?? false,
        });
    } else {
        const last = records[records.length - 1];
        if (last.end.getTime() !== slot.end.getTime()) {
            last.end = new Date(slot.end);
        }
    }

    return records;
}

export function serializeChunks(records: ChunkRecord[]): SerializedChunk[] {
    return records.map((record) => ({
        start: record.start.toISOString(),
        end: record.end.toISOString(),
        late: Boolean(record.late),
        overlapped: Boolean(record.overlapped),
        prime: record.prime !== false,
    }));
}

export function summarizeWindowCapacity(grid: OccupancyGrid, rangeStart: Date, rangeEnd: Date) {
    const start = rangeStart.getTime();
    const end = rangeEnd.getTime();
    let freeMinutes = 0;
    let diaguruMinutes = 0;
    let externalMinutes = 0;
    for (const slot of grid.slots) {
        if (slot.end.getTime() <= start) continue;
        if (slot.start.getTime() >= end) break;
        const overlapStart = Math.max(slot.start.getTime(), start);
        const overlapEnd = Math.min(slot.end.getTime(), end);
        if (overlapEnd <= overlapStart) continue;
        const minutes = (overlapEnd - overlapStart) / 60000;
        if (slot.status === "free") freeMinutes += minutes;
        else if (slot.status === "diaguru") diaguruMinutes += minutes;
        else externalMinutes += minutes;
    }
    return {
        freeMinutes,
        diaguruMinutes,
        externalMinutes,
    };
}

export function buildDeadlineFailurePayload(args: {
    capture: CaptureEntryRow;
    durationMinutes: number;
    deadline: Date;
    windowStart: Date;
    windowEnd: Date;
    windowSummary: { freeMinutes: number; diaguruMinutes: number; externalMinutes: number } | null;
    lateCandidate?: PreferredSlot | null;
    reason: "slot_exceeds_deadline" | "no_slot";
}) {
    const summary = args.windowSummary ?? {
        freeMinutes: 0,
        diaguruMinutes: 0,
        externalMinutes: 0,
    };
    const suggestions = [
        "shorten_duration",
        "relax_deadline",
        "allow_splitting",
        "enable_overlap",
        "free_lower_priority_time",
    ];
    return {
        error:
            args.reason === "slot_exceeds_deadline"
                ? "Found slot exceeds deadline/window."
                : "No legal arrangement before the deadline/window.",
        reason: args.reason,
        capture_id: args.capture.id,
        deadline: args.deadline.toISOString(),
        window_start: args.windowStart.toISOString(),
        window_end: args.windowEnd.toISOString(),
        needed_minutes: args.durationMinutes,
        available_free_minutes: Math.max(0, Math.floor(summary.freeMinutes)),
        diaguru_minutes: Math.max(0, Math.floor(summary.diaguruMinutes)),
        external_minutes: Math.max(0, Math.floor(summary.externalMinutes)),
        late_candidate: args.lateCandidate
            ? {
                start: args.lateCandidate.start.toISOString(),
                end: args.lateCandidate.end.toISOString(),
            }
            : null,
        suggestions,
    };
}

function summarizeSlotStats(slots: OccupancySlot[]): OccupancyStats {
    return slots.reduce(
        (acc, slot) => {
            acc[slot.status] += 1;
            acc.total += 1;
            return acc;
        },
        { free: 0, external: 0, diaguru: 0, total: 0 } as OccupancyStats,
    );
}

function compressOccupancySegments(slots: OccupancySlot[]): OccupancySegment[] {
    const segments: OccupancySegment[] = [];
    for (const slot of slots) {
        const prev = segments[segments.length - 1];
        if (
            prev &&
            prev.status === slot.status &&
            prev.eventId === slot.eventId &&
            prev.captureId === slot.captureId
        ) {
            prev.end = slot.end.toISOString();
            continue;
        }
        segments.push({
            start: slot.start.toISOString(),
            end: slot.end.toISOString(),
            status: slot.status,
            eventId: slot.eventId,
            captureId: slot.captureId,
        });
    }
    return segments;
}

function formatLocalDayLabel(dayStartUtc: Date, offsetMinutes: number) {
    const local = toLocalDate(dayStartUtc, offsetMinutes);
    const year = local.getUTCFullYear();
    const month = String(local.getUTCMonth() + 1).padStart(2, "0");
    const date = String(local.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${date}`;
}

export function parsePreferredSlot(
    startIso: string,
    endIso: string | null,
    fallbackMinutes: number,
): PreferredSlot | null {
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) return null;
    let end: Date | null = null;
    if (endIso) {
        const parsedEnd = new Date(endIso);
        if (!Number.isNaN(parsedEnd.getTime())) {
            end = parsedEnd;
        }
    }
    if (!end) {
        end = addMinutes(start, fallbackMinutes);
    }
    if (end.getTime() <= start.getTime()) {
        end = addMinutes(start, Math.max(fallbackMinutes, 5));
    }
    return { start, end };
}

export function normalizeConstraintType(
  value: string | null
): "flexible" | "deadline_time" | "deadline_date" | "start_time" | "window" {
  if (!value) return "flexible";

  if (
    value === "deadline_time" ||
    value === "deadline_date" ||
    value === "start_time" ||
    value === "window"
  ) {
    return value;
  }

  // Legacy aliases
  if (value === "deadline" || value === "end_time") {
    return "deadline_time";
  }

  return "flexible";
}


export function parseIsoDate(value: string | null): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
}

export function computeDateDeadline(dateInput: string | null, offsetMinutes: number): Date | null {
    if (!dateInput) return null;
    const base = new Date(`${dateInput}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) return null;
    const local = toLocalDate(base, offsetMinutes);
    local.setHours(DAY_END_HOUR, 0, 0, 0);
    return toUtcDate(local, offsetMinutes);
}

export function resolveDeadlineFromCapture(
  capture: CaptureEntryRow,
  offsetMinutes: number,
): Date | null {
  if (capture.deadline_at) {
    return parseIsoDate(capture.deadline_at);
  }

  const type = normalizeConstraintType(capture.constraint_type);
  const strategy = DEADLINE_RULES[type];

  if (!strategy) return null;

  const iso = strategy(capture, offsetMinutes);
  return iso ? parseIsoDate(iso) : null;
}


export function computeSchedulingPlan(
    capture: CaptureEntryRow,
    durationMinutes: number,
    offsetMinutes: number,
    referenceNow: Date,
): SchedulingPlan {
    const constraintType = normalizeConstraintType(capture.constraint_type);
    const durationMs = durationMinutes * 60000;

    if (constraintType === "deadline_time" || constraintType === "deadline_date") {
        const deadline = resolveDeadlineFromCapture(capture, offsetMinutes);
        if (deadline) {
            return {
                mode: "deadline",
                preferredSlot: null,
                deadline,
                window: null,
            };
        }
    }

    if (constraintType === "start_time") {
        const targetStart =
            parseIsoDate(capture.constraint_time) ?? parseIsoDate(capture.original_target_time);
        if (targetStart) {
            const start = new Date(Math.max(targetStart.getTime(), referenceNow.getTime()));
            const end = new Date(start.getTime() + durationMs);
            return {
                mode: "start",
                preferredSlot: { start, end },
                deadline: null,
                window: null,
            };
        }
    }

    if (constraintType === "window") {
        const windowStart = parseIsoDate(capture.constraint_time);
        const windowEnd = parseIsoDate(capture.constraint_end);
        if (windowStart && windowEnd && windowEnd.getTime() > windowStart.getTime()) {
            return {
                mode: "window",
                preferredSlot: null,
                //preferredSlot: fitsWindow ? { start, end } : null,
                deadline: null,
                window: { start: windowStart, end: windowEnd },
            };
        }
    }

    return {
        mode: "flexible",
        preferredSlot: null,
        deadline: null,
        window: null,
    };
}

function adjustSlotToReference(slot: PreferredSlot, referenceNow: Date): PreferredSlot {
    if (slot.start.getTime() >= referenceNow.getTime()) return slot;
    const duration = slot.end.getTime() - slot.start.getTime();
    const start = new Date(referenceNow.getTime());
    const end = new Date(start.getTime() + duration);
    return { start, end };
}

export function isSlotFeasible(
    slot: PreferredSlot,
    offsetMinutes: number,
    intervals: { start: Date; end: Date }[],
    enforceWorkingWindow = true,
) {
    if (enforceWorkingWindow && isBeforeDayStart(slot.start, offsetMinutes)) return false;
    if (enforceWorkingWindow && isAfterDayEnd(slot.end, offsetMinutes)) return false;
    return isSlotFree(slot.start, slot.end, intervals);
}

export function findSlotBeforeDeadline(
    intervals: { start: Date; end: Date }[],
    durationMinutes: number,
    offsetMinutes: number,
    options: { deadline: Date; referenceNow: Date },
    enforceWorkingWindow = true,
): PreferredSlot | null {
    const durationMs = durationMinutes * 60000;
    const latestStart = new Date(options.deadline.getTime() - durationMs);
    if (latestStart.getTime() < options.referenceNow.getTime()) return null;

    let candidateStart = new Date(options.referenceNow.getTime());

    if (enforceWorkingWindow && isBeforeDayStart(candidateStart, offsetMinutes)) {
        candidateStart = startOfDayOffset(candidateStart, offsetMinutes);
    }
    if (enforceWorkingWindow && isAfterDayEnd(candidateStart, offsetMinutes)) {
        candidateStart = startOfDayOffset(addDays(candidateStart, 1), offsetMinutes);
    }

    while (candidateStart.getTime() <= latestStart.getTime()) {
        const candidateEnd = new Date(candidateStart.getTime() + durationMs);
        if (candidateEnd.getTime() > options.deadline.getTime()) break;

        if (
            (!enforceWorkingWindow || !isBeforeDayStart(candidateStart, offsetMinutes)) &&
            (!enforceWorkingWindow || !isAfterDayEnd(candidateEnd, offsetMinutes)) &&
            isSlotFree(candidateStart, candidateEnd, intervals)
        ) {
            return { start: candidateStart, end: candidateEnd };
        }

        candidateStart = addMinutes(candidateStart, SLOT_INCREMENT_MINUTES);
        if (enforceWorkingWindow && isAfterDayEnd(candidateStart, offsetMinutes)) {
            candidateStart = startOfDayOffset(addDays(candidateStart, 1), offsetMinutes);
        }
    }

    return null;
}

export function findSlotWithinWindow(
    intervals: { start: Date; end: Date }[],
    durationMinutes: number,
    offsetMinutes: number,
    options: { windowStart: Date; windowEnd: Date; referenceNow: Date },
    enforceWorkingWindow = true,
): PreferredSlot | null {
    const durationMs = durationMinutes * 60000;
    let candidateStart = new Date(Math.max(options.windowStart.getTime(), options.referenceNow.getTime()));

    while (candidateStart.getTime() + durationMs <= options.windowEnd.getTime()) {
        const candidateEnd = new Date(candidateStart.getTime() + durationMs);
        if (
            (!enforceWorkingWindow || !isBeforeDayStart(candidateStart, offsetMinutes)) &&
            (!enforceWorkingWindow || !isAfterDayEnd(candidateEnd, offsetMinutes)) &&
            isSlotFree(candidateStart, candidateEnd, intervals)
        ) {
            return { start: candidateStart, end: candidateEnd };
        }
        candidateStart = addMinutes(candidateStart, SLOT_INCREMENT_MINUTES);
    }

    return null;
}

export function scheduleWithPlan(args: {
    plan: SchedulingPlan;
    durationMinutes: number;
    busyIntervals: { start: Date; end: Date }[];
    offsetMinutes: number;
    referenceNow: Date;
    isSoftStart?: boolean;
    enforceWorkingWindow?: boolean;
    preferredTimeOfDay?: { start: number; end: number }[];
}): PreferredSlot | null {
    const {
        plan,
        durationMinutes,
        busyIntervals,
        offsetMinutes,
        referenceNow,
        isSoftStart,
        enforceWorkingWindow = true,
        preferredTimeOfDay,
    } = args;
    if (plan.preferredSlot) {
        const adjusted = adjustSlotToReference(plan.preferredSlot, referenceNow);
        if (isSlotFeasible(adjusted, offsetMinutes, busyIntervals, enforceWorkingWindow)) {
            return adjusted;
        }
    }

    if (plan.mode === "deadline" && plan.deadline) {
        const deadlineSlot = findSlotBeforeDeadline(
            busyIntervals,
            durationMinutes,
            offsetMinutes,
            {
                deadline: plan.deadline,
                referenceNow,
            },
            enforceWorkingWindow,
        );
        if (deadlineSlot) return deadlineSlot;
    }

    if (plan.mode === "window" && plan.window) {
        const windowSlot = findSlotWithinWindow(
            busyIntervals,
            durationMinutes,
            offsetMinutes,
            {
                windowStart: plan.window.start,
                windowEnd: plan.window.end,
                referenceNow,
            },
            enforceWorkingWindow,
        );
        if (windowSlot) return windowSlot;
    }

    if (plan.mode === "start" && plan.preferredSlot) {
        const toleranceMinutes = isSoftStart ? 120 : 60;
        const toleranceEnd = addMinutes(plan.preferredSlot.start, toleranceMinutes);
        const windowSlot = findSlotWithinWindow(
            busyIntervals,
            durationMinutes,
            offsetMinutes,
            {
                windowStart: plan.preferredSlot.start,
                windowEnd: toleranceEnd,
                referenceNow,
            },
            enforceWorkingWindow,
        );
        if (windowSlot) return windowSlot;
    }

    return findNextAvailableSlot(busyIntervals, durationMinutes, offsetMinutes, {
        referenceNow,
        enforceWorkingWindow,
        preferredTimeOfDay,
    });
}

export function priorityForCapture(capture: CaptureEntryRow, referenceNow: Date) {
    const base = computePriorityScore(buildPriorityInput(capture), referenceNow);
    return applyRoutinePriorityScore(base, detectRoutineKind(capture));
}

function buildPriorityInput(capture: CaptureEntryRow): PriorityInput {
    let urgency: number | null = null;
    let impact: number | null = null;
    let reschedule_penalty: number | null = null;
    // Prefer direct DB columns when available
    if (typeof capture.urgency === 'number') urgency = capture.urgency;
    if (typeof capture.impact === 'number') impact = capture.impact;
    if (typeof capture.reschedule_penalty === 'number') reschedule_penalty = capture.reschedule_penalty;
    if (urgency == null || impact == null || reschedule_penalty == null) {
        try {
            const notes = typeof capture.scheduling_notes === "string" ? capture.scheduling_notes : null;
            if (notes && notes.trim().length > 0) {
                const parsed = JSON.parse(notes);
                if (parsed && typeof parsed === 'object') {
                    if (parsed.importance && typeof parsed.importance === 'object') {
                        const imp = parsed.importance as Record<string, unknown>;
                        const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : null);
                        if (urgency == null) urgency = num(imp.urgency);
                        if (impact == null) impact = num(imp.impact);
                        if (reschedule_penalty == null) reschedule_penalty = num(imp.reschedule_penalty);
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

export function isSlotWithinConstraints(capture: CaptureEntryRow, slot: { start: Date; end: Date }) {
    const candidates: Date[] = [];
    const pushIfValid = (iso: string | null) => {
        if (!iso) return;
        const d = new Date(iso);
        if (!Number.isNaN(d.getTime())) candidates.push(d);
    };
    pushIfValid(capture.deadline_at);
    pushIfValid(capture.window_end);
    pushIfValid(capture.constraint_end);
    if (capture.constraint_type === "deadline_time") pushIfValid(capture.constraint_time);
    if (candidates.length === 0) return true;
    const minEnd = new Date(Math.min(...candidates.map((d) => d.getTime())));
    
    if (capture.constraint_type === "start_time" && capture.window_start && capture.window_end) {
        const window_start = new Date(capture.window_start);
        const window_end = new Date(capture.window_end);
        if (!Number.isNaN(window_start.getTime()) && !Number.isNaN(window_end.getTime())) {
            return window_start <= slot.start && slot.start <= window_end;
        }
    }
    return slot.end.getTime() <= minEnd.getTime();
}

export function hasActiveFreeze(capture: CaptureEntryRow, referenceNow: Date) {
    if (!capture.freeze_until) return false;
    const freezeTs = Date.parse(capture.freeze_until);
    if (!Number.isFinite(freezeTs)) return false;
    return freezeTs > referenceNow.getTime();
}

export function withinStabilityWindow(capture: CaptureEntryRow, referenceNow: Date) {
    if (!capture.planned_start) return false;
    const plannedTs = Date.parse(capture.planned_start);
    if (!Number.isFinite(plannedTs)) return false;
    return plannedTs - referenceNow.getTime() <= STABILITY_WINDOW_MINUTES * 60_000;
}

export function selectMinimalPreemptionSet(args: {
    slot: PreferredSlot;
    events: CalendarEvent[];
    candidateIds: string[];
    offsetMinutes: number;
    allowCompressedBuffer: boolean;
}) {
    if (args.candidateIds.length === 0) return null;
    const buffers = args.allowCompressedBuffer
        ? [BUFFER_MINUTES, COMPRESSED_BUFFER_MINUTES]
        : [BUFFER_MINUTES];
    const uniqueBuffers = Array.from(new Set(buffers));
    const maxCombinationSize = Math.min(args.candidateIds.length, 4);

    for (const buffer of uniqueBuffers) {
        for (let size = 1; size <= maxCombinationSize; size++) {
            const combos = generateCombinations(args.candidateIds, size, 64);
            for (const combo of combos) {
                const removalSet = new Set(combo);
                const filteredEvents = args.events.filter((event) => !removalSet.has(event.id));
                const intervals = computeBusyIntervals(filteredEvents, buffer);
                if (isSlotFeasible(args.slot, args.offsetMinutes, intervals)) {
                    return { ids: combo, bufferMinutes: buffer };
                }
            }
        }
    }

    return null;
}

export function buildPreemptionDisplacements(
    conflicts: ConflictSummary[],
    captureMap: Map<string, CaptureEntryRow>,
): PreemptionDisplacement[] {
    const displacements: PreemptionDisplacement[] = [];
    for (const conflict of conflicts) {
        if (!conflict.captureId) continue;
        const capture = captureMap.get(conflict.captureId);
        if (!capture) continue;
        const minutes = estimateConflictMinutes(conflict, capture);
        if (minutes <= 0) continue;
        displacements.push({ capture, minutes });
    }
    return displacements;
}

export function estimateConflictMinutes(conflict: ConflictSummary, capture: CaptureEntryRow) {
    const start = firstValidDate([conflict.start, capture.planned_start, capture.scheduled_for]);
    let end = firstValidDate([conflict.end, capture.planned_end]);
    if (!end && start && typeof capture.estimated_minutes === "number") {
        end = addMinutes(start, capture.estimated_minutes);
    }
    if (start && end) {
        const diff = (end.getTime() - start.getTime()) / 60000;
        if (diff > 0) return diff;
    }
    return Math.max(0, capture.estimated_minutes ?? 0);
}

function firstValidDate(candidates: (string | null | undefined)[]): Date | null {
    for (const iso of candidates) {
        if (!iso) continue;
        const parsed = new Date(iso);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }
    return null;
}

export function detectRoutineKind(capture: CaptureEntryRow): RoutineKind | null {
    const hint = capture.task_type_hint?.toLowerCase() ?? "";
    const text = capture.content?.toLowerCase() ?? "";

    if (hint.includes("routine.sleep") || /\bsleep|nap|bed ?time\b/.test(text)) {
        return "sleep";
    }
    if (hint.includes("routine.meal") || /\b(breakfast|lunch|dinner|meal|eat)\b/.test(text)) {
        return "meal";
    }
    return null;
}

export function applyRoutinePrioritySnapshot(snapshot: ReturnType<typeof computePrioritySnapshot>, kind: RoutineKind, durationMinutes: number) {
    const adjustedScore = applyRoutinePriorityScore(snapshot.score, kind);
    return {
        ...snapshot,
        score: adjustedScore,
        perMinute: adjustedScore / Math.max(durationMinutes, 1),
    };
}

function applyRoutinePriorityScore(score: number, kind: RoutineKind | null) {
    if (!kind) return score;
    const rule = ROUTINE_PRIORITY_RULES[kind];
    const scaled = score * rule.scaler;
    return Math.min(scaled, rule.cap);
}

export function shouldEnforceWorkingWindow(capture: CaptureEntryRow) {
    return detectRoutineKind(capture) ? false : true;
}

export function derivePreferredTimeOfDayBands(capture: CaptureEntryRow) {
    const bands: { start: number; end: number }[] = [];
    const pref = capture.time_pref_time_of_day;
    const map: Record<string, { start: number; end: number }> = {
        morning: { start: 8, end: 12 },
        afternoon: { start: 12, end: 17 },
        evening: { start: 17, end: 21 },
        night: { start: 21, end: 26 },
    };
    if (pref && map[pref]) {
        bands.push(map[pref]);
    }

    if (bands.length === 0 && capture.task_type_hint) {
        const defaults = schedulerConfig.timeOfDayDefaults[capture.task_type_hint];
        if (defaults && defaults.length > 0) {
            bands.push(...defaults);
        }
    }
    return bands.length > 0 ? bands : undefined;
}

export function canCaptureOverlap(capture: CaptureEntryRow) {
    if (capture.blocking) return false;
    if (capture.start_flexibility === "hard") return false;
    if (capture.cannot_overlap) return false;
    if (readCannotOverlapFromNotes(capture)) return false;
    return true;
}

export function sanitizedEstimatedMinutes(capture: CaptureEntryRow) {
    return Math.max(5, Math.min(capture.estimated_minutes ?? 30, 480));
}

export function readCannotOverlapFromNotes(capture: CaptureEntryRow): boolean {
    if (typeof capture.cannot_overlap === "boolean") return Boolean(capture.cannot_overlap);
    try {
        const raw = typeof capture.scheduling_notes === "string" ? capture.scheduling_notes : null;
        if (!raw || typeof raw !== "string") return false;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            const record = parsed as Record<string, unknown>;
            const flexibility = record.flexibility;
            if (flexibility && typeof flexibility === "object") {
                const flexRecord = flexibility as Record<string, unknown>;
                if (typeof flexRecord.cannot_overlap === "boolean") {
                    return flexRecord.cannot_overlap;
                }
            }
        }
    } catch {
        // ignore malformed scheduling notes
    }
    return false;
}

function generateCombinations<T>(items: T[], size: number, limit = 64): T[][] {
    if (size <= 0) return [[]];
    if (size > items.length) return [];
    const results: T[][] = [];

    const backtrack = (start: number, path: T[]) => {
        if (results.length >= limit) return;
        if (path.length === size) {
            results.push([...path]);
            return;
        }
        for (let i = start; i < items.length; i++) {
            path.push(items[i]);
            backtrack(i + 1, path);
            path.pop();
            if (results.length >= limit) return;
        }
    };

    backtrack(0, []);
    return results;
}

export function collectConflictingEvents(
  slot: PreferredSlot,
  events: CalendarEvent[],
  referenceNow?: Date,
): ConflictSummary[] {
  const conflicts: ConflictSummary[] = [];
  for (const event of events) {
    const start = parseEventDate(event.start);
    const end = parseEventDate(event.end);
    if (!start || !end) continue;

    let beforeBuffer = BUFFER_MINUTES;
    let afterBuffer = BUFFER_MINUTES;

    if (referenceNow && start <= referenceNow && referenceNow < end) {
      // Event is currently in progress
      // - no need to block time *before* it (already in the past)
      // - shrink the tail buffer so you can schedule closer after it
      beforeBuffer = 0;
      afterBuffer = 0; // or 0 if you want no tail at all
    }

    const bufferedStart = addMinutes(start, -beforeBuffer);
    const bufferedEnd = addMinutes(end, afterBuffer);

    const overlaps = slot.start < bufferedEnd && slot.end > bufferedStart;
    if (overlaps) {
      conflicts.push({
        id: event.id,
        summary: event.summary,
        start: start.toISOString(),
        end: end.toISOString(),
        diaGuru: event.extendedProperties?.private?.diaGuru === "true",
        captureId: event.extendedProperties?.private?.capture_id,
      });
    }
  }
  return conflicts;
}


export function isSlotWithinWorkingWindow(slot: PreferredSlot, offsetMinutes: number) {
    if (isBeforeDayStart(slot.start, offsetMinutes)) return false;
    if (isAfterDayEnd(slot.end, offsetMinutes)) return false;
    return true;
}

export function registerInterval(intervals: { start: Date; end: Date }[], slot: PreferredSlot) {
    intervals.push({
        start: addMinutes(slot.start, -BUFFER_MINUTES),
        end: addMinutes(slot.end, BUFFER_MINUTES),
    });
    intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function parseEventDate(value: { dateTime?: string; date?: string }) {
    if (value.dateTime) return new Date(value.dateTime);
    if (value.date) return new Date(`${value.date}T00:00:00Z`);
    return null;
}

export function addMinutes(date: Date, minutes: number) {
    return new Date(date.getTime() + minutes * 60000);
}

export function addDays(date: Date, days: number) {
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + days);
    return next;
}

export function startOfDayOffset(date: Date, offsetMinutes: number) {
    const local = toLocalDate(date, offsetMinutes);
    local.setHours(8, 0, 0, 0);
    return toUtcDate(local, offsetMinutes);
}

export function isBeforeDayStart(date: Date, offsetMinutes: number) {
    const local = toLocalDate(date, offsetMinutes);
    const start = new Date(local.getTime());
    start.setHours(8, 0, 0, 0);
    return local.getTime() < start.getTime();
}

export function isAfterDayEnd(date: Date, offsetMinutes: number) {
    const local = toLocalDate(date, offsetMinutes);
    if (local.getHours() > DAY_END_HOUR) return true;
    if (local.getHours() === DAY_END_HOUR && local.getMinutes() > 0) return true;
    return false;
}

export function toLocalDate(date: Date, offsetMinutes: number) {
    return new Date(date.getTime() + offsetMinutes * 60000);
}

export function toUtcDate(date: Date, offsetMinutes: number) {
    return new Date(date.getTime() - offsetMinutes * 60000);
}

export function isSlotFree(start: Date, end: Date, intervals: { start: Date; end: Date }[]) {
    for (const interval of intervals) {
        if (start < interval.end && end > interval.start) {
            return false;
        }
    }
    return true;
}

export function buildZonedDateTime(args: {
    timezone: string;
    reference: Date;
    hour: number;
    minute: number;
    dayOffset?: number;
}) {
    const { timezone, reference, hour, minute } = args;
    const dayOffset = args.dayOffset ?? computeDayOffset(reference, timezone, hour, minute);
    const dateParts = getLocalDateParts(reference, timezone);
    const utcGuess = new Date(
        Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + dayOffset, hour, minute, 0, 0),
    );
    const offsetMinutes = getTimezoneOffsetMinutes(utcGuess, timezone);
    return new Date(utcGuess.getTime() - offsetMinutes * 60000).toISOString();
}

function computeDayOffset(reference: Date, timezone: string, targetHour: number, targetMinute: number) {
    const { hour, minute } = getLocalTimeParts(reference, timezone);
    if (hour > targetHour) return 1;
    if (hour === targetHour && minute >= targetMinute) return 1;
    return 0;
}

function getLocalDateParts(reference: Date, timezone: string) {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const parts = formatter.formatToParts(reference);
    const lookup = (type: "year" | "month" | "day") =>
        parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    return {
        year: lookup("year"),
        month: lookup("month"),
        day: lookup("day"),
    };
}

function getLocalTimeParts(reference: Date, timezone: string) {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const [hourStr, minuteStr] = formatter.format(reference).split(":");
    return {
        hour: parseInt(hourStr, 10),
        minute: parseInt(minuteStr, 10),
    };
}

function getTimezoneOffsetMinutes(date: Date, timeZone: string) {
    const localDate = new Date(date.toLocaleString("en-US", { timeZone }));
    const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
    return (localDate.getTime() - utcDate.getTime()) / 60000;
}
