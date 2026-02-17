import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CalendarTokenRow, CaptureEntryRow, Database } from "../types.ts";
import { replaceCaptureChunks } from "./chunks.ts";
import {
  computeRigidityScore,
  evaluatePreemptionNetGain,
  logSchedulerEvent,
  schedulerConfig,
} from "./scheduler-config.ts";

import {
  BUFFER_MINUTES,
  SEARCH_DAYS,
  SLOT_INCREMENT_MINUTES,
  DEFAULT_MIN_CHUNK_MINUTES,
  ScheduleError,
  type CalendarEvent,
  type ConflictSummary,
  type ScheduleDecision,
  type ConflictDecision,
  type PreferredSlot,
  type GridWindowCandidate,
  type GridPreemptionChoice,
  type SerializedChunk,
  type SchedulingPlan,
  normalizeRoutineCapture,
  findNextAvailableSlot,
  computeBusyIntervals,
  buildOccupancyGrid,
  collectGridWindowCandidates,
  generateChunkDurations,
  placeChunksWithinRange,
  findLatePlacementSlot,
  buildChunksForSlot,
  serializeChunks,
  summarizeWindowCapacity,
  buildDeadlineFailurePayload,
  parsePreferredSlot,
  resolveDeadlineFromCapture,
  computeSchedulingPlan,
  scheduleWithPlan,
  priorityForCapture,
  isSlotWithinConstraints,
  hasActiveFreeze,
  withinStabilityWindow,
  selectMinimalPreemptionSet,
  buildPreemptionDisplacements,
  detectRoutineKind,
  shouldEnforceWorkingWindow,
  derivePreferredTimeOfDayBands,
  canCaptureOverlap,
  sanitizedEstimatedMinutes,
  collectConflictingEvents,
  isSlotWithinWorkingWindow,
  registerInterval,
  addMinutes,
  isSlotFree,
  readCannotOverlapFromNotes,
} from "./scheduling-core.ts";


const GOOGLE_CALENDAR_ID = (Deno.env.get("GOOGLE_CALENDAR_ID") ?? "primary").trim() || "primary";
const ENCODED_GOOGLE_CALENDAR_ID = encodeURIComponent(GOOGLE_CALENDAR_ID);
const GOOGLE_EVENTS = `https://www.googleapis.com/calendar/v3/calendars/${ENCODED_GOOGLE_CALENDAR_ID}/events`;

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

type CalendarClientCredentials = {
  accountId: number;
  accessToken: string;
  refreshToken: string | null;
  refreshed: boolean;
};

type GoogleCalendarActions = {
  listEvents: (timeMin: string, timeMax: string) => Promise<CalendarEvent[]>;
  deleteEvent: (options: { eventId: string; etag?: string | null }) => Promise<void>;
  createEvent: (options: {
    capture: CaptureEntryRow;
    slot: { start: Date; end: Date };
    planId?: string | null;
    actionId: string;
    priorityScore: number;
    description?: string;
  }) => Promise<{ id: string; etag: string | null }>;
  getEvent: (eventId: string) => Promise<CalendarEvent | null>;
};

type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

type AdvisorResult = {
  advisor: {
    action: "suggest_slot" | "ask_overlap" | "defer";
    message: string;
    slot: { start: string; end: string } | null;
  } | null;
  metadata: {
    llmAttempted: boolean;
    llmModel?: string | null;
    llmError?: string | null;
  };
};

type CaptureSnapshot = {
  status: string | null;
  planned_start: string | null;
  planned_end: string | null;
  calendar_event_id: string | null;
  calendar_event_etag: string | null;
  freeze_until: string | null;
  plan_id: string | null;
};

type PlanActionRecord = {
  planId: string;
  actionId: string;
  captureId: string;
  captureContent: string;
  actionType: "unscheduled" | "scheduled" | "rescheduled";
  prev: CaptureSnapshot;
  next: CaptureSnapshot;
};

type ScheduleExplanation = {
  mode: SchedulingPlan["mode"];
  reasons: string[];
  constraints: {
    workingHours: boolean;
    bufferMinutes: number;
    windowStart: string | null;
    windowEnd: string | null;
    deadline: string | null;
    requestedStart: string | null;
  };
  priority: {
    score: number;
    perMinute: number;
  };
  decisionPath: string[];
};

type ExplanationFlags = {
  late?: boolean;
  overlapped?: boolean;
  preempted?: boolean;
  usedPreferred?: boolean;
  usedStartTolerance?: boolean;
};

function logScheduleSummary(event: string, payload: Record<string, unknown>) {
  logSchedulerEvent(event, payload);
}

export async function handler(req: Request) {
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Missing Authorization" }, 401);

    const body = await req.json().catch(() => ({}));
    const now = new Date();
    const captureId = body.captureId as string | undefined;
    const action = (body.action as "schedule" | "reschedule" | "complete") ?? "schedule";
    const timezoneOffsetMinutes =
      typeof body.timezoneOffsetMinutes === "number" && Number.isFinite(body.timezoneOffsetMinutes)
        ? body.timezoneOffsetMinutes
        : null;
    const timezone = typeof body.timezone === "string" ? body.timezone : null;

    if (!captureId) return json({ error: "captureId required" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRole = Deno.env.get("SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

    const supaFromUser = createClient<Database, "public">(supabaseUrl, anon, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData, error: userError } = await supaFromUser.auth.getUser();
    console.log("user data:", userData, "error:", userError);
    if (userError || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const userId = userData.user.id;
    const admin = createClient<Database, "public">(supabaseUrl, serviceRole);

    const { data: captureData, error: captureError } = await admin
      .from("capture_entries")
      .select("*")
      .eq("id", captureId)
      .single();
    if (captureError || !captureData) return json({ error: "Capture not found" , message: captureError }, 404);
    const capture = captureData as CaptureEntryRow;
    if (capture.user_id !== userId) return json({ error: "Forbidden" }, 403);

    logScheduleSummary("schedule.request", {
      captureId: capture.id,
      content: capture.content,
      estimatedMinutes: capture.estimated_minutes,
      urgency: capture.urgency,
      impact: capture.impact,
      reschedulePenalty: capture.reschedule_penalty,
      blocking: capture.blocking,
      cannotOverlap: capture.cannot_overlap,
      startFlexibility: capture.start_flexibility,
      durationFlexibility: capture.duration_flexibility,
      constraint: {
        type: capture.constraint_type,
        time: capture.constraint_time,
        end: capture.constraint_end,
        deadline: capture.deadline_at,
        windowStart: capture.window_start,
        windowEnd: capture.window_end,
      },
      scheduledFor: capture.scheduled_for,
      freezeUntil: capture.freeze_until,
      extractionKind: capture.extraction_kind,
    });

    // Normalize routines on the fly (sleep/meals) before scheduling.
    const normalizedCapture = normalizeRoutineCapture(capture as CaptureEntryRow, {
      referenceNow: now,
      timezone: timezone ?? undefined,
    });
    if (normalizedCapture !== capture) {
      await admin.from("capture_entries").update({
        constraint_type: normalizedCapture.constraint_type,
        constraint_time: normalizedCapture.constraint_time,
        constraint_end: normalizedCapture.constraint_end,
        window_start: normalizedCapture.window_start,
        window_end: normalizedCapture.window_end,
        deadline_at: normalizedCapture.deadline_at,
        start_flexibility: normalizedCapture.start_flexibility,
        duration_flexibility: normalizedCapture.duration_flexibility,
        cannot_overlap: normalizedCapture.cannot_overlap,
        time_pref_time_of_day: normalizedCapture.time_pref_time_of_day,
        freeze_until: normalizedCapture.freeze_until,
      }).eq("id", capture.id);

      // Verify DB update worked
      const { data: dbVerification } = await admin
        .from("capture_entries")
        .select("window_start, window_end, constraint_time, constraint_end, deadline_at")
        .eq("id", capture.id)
        .single();
      console.log("[DEBUG] DB after update:", dbVerification);

      capture.constraint_type = normalizedCapture.constraint_type;
      capture.constraint_time = normalizedCapture.constraint_time;
      capture.constraint_end = normalizedCapture.constraint_end;
      capture.window_start = normalizedCapture.window_start;
      capture.window_end = normalizedCapture.window_end;
      capture.deadline_at = normalizedCapture.deadline_at;
      capture.start_flexibility = normalizedCapture.start_flexibility;
      capture.duration_flexibility = normalizedCapture.duration_flexibility;
      capture.cannot_overlap = normalizedCapture.cannot_overlap;
      capture.time_pref_time_of_day = normalizedCapture.time_pref_time_of_day;
      capture.freeze_until = normalizedCapture.freeze_until;

      console.log("[NORMALIZE] After DB update, capture values:", {
        captureId: capture.id,
        constraint_type: capture.constraint_type,
        window_start: capture.window_start,
        window_end: capture.window_end,
        constraint_time: capture.constraint_time,
        constraint_end: capture.constraint_end,
      });
    }

    const calendarClient = await resolveCalendarClient(admin, userId, clientId, clientSecret);
    if (!calendarClient) {
      return json({ error: "Google Calendar not linked" ,message: calendarClient}, 400);
    }
    const google = createGoogleCalendarActions({
      credentials: calendarClient,
      admin,
      clientId,
      clientSecret,
    });

    if (action === "complete") {
      if (capture.calendar_event_id) {
        await google.deleteEvent({
          eventId: capture.calendar_event_id,
          etag: capture.calendar_event_etag ?? undefined,
        });
      }
      const { error: updateError } = await admin
        .from("capture_entries")
        .update({
          status: "completed",
          last_check_in: new Date().toISOString(),
          scheduling_notes: mergeSchedulingNotes(capture.scheduling_notes, "Marked completed by user."),
          calendar_event_id: null,
          calendar_event_etag: null,
          planned_start: null,
          planned_end: null,
          scheduled_for: null,
          freeze_until: null,
        })
        .eq("id", capture.id);
      if (updateError) return json({ error: updateError.message }, 500);
      return json({ message: "Capture marked completed.", capture: null });
    }

    if (action === "reschedule" && capture.calendar_event_id) {
      await google.deleteEvent({
        eventId: capture.calendar_event_id,
        etag: capture.calendar_event_etag ?? undefined,
      });
      await admin
        .from("capture_entries")
        .update({
          calendar_event_id: null,
          calendar_event_etag: null,
          planned_start: null,
          planned_end: null,
          scheduling_notes: mergeSchedulingNotes(capture.scheduling_notes, "Rescheduling initiated."),
          status: "pending",
          scheduled_for: null,
          freeze_until: null,
        })
        .eq("id", capture.id);
    }

    if (capture.status === "completed") {
      return json({ error: "Capture already completed." }, 400);
    }

    const allowOverlap = Boolean(body.allowOverlap);
    const allowRebalance = Boolean(body.allowRebalance ?? body.allowPreemption ?? false);
    const allowLatePlacement = Boolean(
      body.allowLatePlacement ?? body.allowLate ?? body.scheduleLate ?? false,
    );
    const preferredStartIso = typeof body.preferredStart === "string" ? body.preferredStart : null;
    const preferredEndIso = typeof body.preferredEnd === "string" ? body.preferredEnd : null;

    const offsetMinutes = timezoneOffsetMinutes ?? 0;

    const durationMinutes = Math.max(5, Math.min(capture.estimated_minutes ?? 30, 480));
    const planId = crypto.randomUUID();
    const planActions: PlanActionRecord[] = [];
    let planRunCreated = false;

    const capturePriority = priorityForCapture(capture as CaptureEntryRow, now);
    const rigidityScore = computeRigidityScore(capture as CaptureEntryRow, now);
    const routineKind = detectRoutineKind(capture as CaptureEntryRow);
    logSchedulerEvent("capture.metrics", {
      captureId: capture.id,
      routineKind,
      priority: Number(capturePriority.toFixed(3)),
      perMinute: Number((capturePriority / Math.max(durationMinutes, 1)).toFixed(3)),
      rigidity: Number(rigidityScore.toFixed(2)),
      durationMinutes,
    });

    const ensurePlanRun = async () => {
      if (planRunCreated) return;
      const { error } = await admin
        .from("plan_runs")
        .insert({ id: planId, user_id: userId })
        .select("id")
        .single();
      if (error) {
        throw new ScheduleError("Failed to register scheduling plan.", 500, error);
      }
      planRunCreated = true;
    };

    const recordPlanAction = async (action: Omit<PlanActionRecord, "planId">) => {
      await ensurePlanRun();
      planActions.push({ ...action, planId });
    };

    const finalizePlan = async () => {
      if (!planRunCreated || planActions.length === 0) return null;
      const rows = planActions.map((action) => convertPlanActionForInsert(action));
      const { error } = await admin.from("plan_actions").insert(rows);
      if (error) {
        throw new ScheduleError("Failed to persist plan audit trail.", 500, error);
      }
      const summaryText = buildPlanSummaryText(planActions);
      await admin.from("plan_runs").update({ summary: summaryText }).eq("id", planId);
      return buildPlanSummary(planId, planActions);
    };
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + SEARCH_DAYS * 86400000).toISOString();
    let events = await google.listEvents(timeMin, timeMax);
    let eventsById = new Map(events.map((event) => [event.id, event]));
    let busyIntervals = computeBusyIntervals(events);
    const occupancyGrid = buildOccupancyGrid({
      events,
      offsetMinutes,
      referenceNow: now,
    });
    const overlapUsage = new Map<string, number>();
    logSchedulerEvent("occupancy.grid", {
      captureId: capture.id,
      range: {
        start: occupancyGrid.start.toISOString(),
        end: occupancyGrid.end.toISOString(),
      },
      slotMinutes: occupancyGrid.slotMinutes,
      stats: occupancyGrid.stats,
      days: occupancyGrid.days,
    });

    const requestPreferred = preferredStartIso
      ? parsePreferredSlot(preferredStartIso, preferredEndIso, durationMinutes)
      : null;

    const plan = computeSchedulingPlan(capture, durationMinutes, offsetMinutes, now);
    const enforceWorkingWindow = shouldEnforceWorkingWindow(capture as CaptureEntryRow);
    const preferredSlot = requestPreferred ?? plan.preferredSlot;
    const resolvedDeadline = plan.deadline ?? resolveDeadlineFromCapture(capture, offsetMinutes);
    const scheduleWindowStart = plan.window?.start
      ? new Date(Math.max(plan.window.start.getTime(), now.getTime()))
      : now;
    const primaryWindowEnd = plan.window?.end ?? resolvedDeadline ?? occupancyGrid.end;
    const scheduleWindowEnd =
      primaryWindowEnd.getTime() >= scheduleWindowStart.getTime()
        ? primaryWindowEnd
        : scheduleWindowStart;
    const windowSummary = resolvedDeadline
      ? summarizeWindowCapacity(occupancyGrid, scheduleWindowStart, scheduleWindowEnd)
      : null;
    const deadlineElapsed =
      resolvedDeadline && resolvedDeadline.getTime() <= scheduleWindowStart.getTime();
    const initialLateCandidate = resolvedDeadline
      ? findLatePlacementSlot({
        busyIntervals,
        durationMinutes,
        offsetMinutes,
        referenceNow: now,
        startFrom: scheduleWindowEnd,
        enforceWorkingWindow,
      })
      : null;

    logSchedulerEvent("plan.summary", {
      captureId: capture.id,
      mode: plan.mode,
      preferredSlot: preferredSlot
        ? { start: preferredSlot.start.toISOString(), end: preferredSlot.end.toISOString() }
        : null,
      deadline: resolvedDeadline ? resolvedDeadline.toISOString() : null,
      windowStart: scheduleWindowStart.toISOString(),
      windowEnd: scheduleWindowEnd.toISOString(),
    });
    if (deadlineElapsed && resolvedDeadline) {
      if (allowLatePlacement && initialLateCandidate) {
        return await scheduleLatePlacementResponse({
          capture: capture as CaptureEntryRow,
          slot: initialLateCandidate,
          admin,
          google,
          planId,
          capturePriority,
          durationMinutes,
          busyIntervals,
          recordPlanAction,
          finalizePlan,
          schedulingNote: "Scheduled after missed deadline (user override).",
          responseMessage: "Capture scheduled after missed deadline (marked late).",
          plan,
          resolvedDeadline,
          enforceWorkingWindow,
          preferredSlot,
          decisionPath: ["late_placement"],
        });
      }

      return json(
        buildDeadlineFailurePayload({
          capture,
          durationMinutes,
          deadline: resolvedDeadline,
          windowStart: scheduleWindowStart,
          windowEnd: resolvedDeadline,
          windowSummary,
          lateCandidate: initialLateCandidate,
          reason: "slot_exceeds_deadline",
        }),
        409,
      );
    }

    if (preferredSlot) {
      const withinWorkingHours = enforceWorkingWindow
        ? isSlotWithinWorkingWindow(preferredSlot, offsetMinutes)
        : true;
      const withinPlanWindow =
        plan.mode !== 'window' || !plan.window
          ? true
          : preferredSlot.start.getTime() >= plan.window.start.getTime() &&
          preferredSlot.end.getTime() <= plan.window.end.getTime();
      const slotWithinWindow = withinWorkingHours && withinPlanWindow;
      const conflicts = collectConflictingEvents(preferredSlot, events, now);
      const externalConflicts = conflicts.filter((conflict) => !conflict.diaGuru);
      const diaGuruConflicts = conflicts.filter((conflict) => conflict.diaGuru && conflict.captureId);
      const hasConflict = conflicts.length > 0;

      let rescheduleQueue: CaptureEntryRow[] = [];

      // Determine if overlap is actually allowed under policy
      let effectiveAllowOverlap = allowOverlap;
      if (effectiveAllowOverlap) {
        if (!slotWithinWindow || externalConflicts.length > 0) {
          effectiveAllowOverlap = false;
        } else {
          const currentCannot = readCannotOverlapFromNotes(capture);
          if (currentCannot) {
            effectiveAllowOverlap = false;
          } else if (diaGuruConflicts.length > 0) {
            const conflictMap = await loadConflictCaptures(admin, diaGuruConflicts);
            for (const v of conflictMap.values()) {
              if (readCannotOverlapFromNotes(v)) {
                effectiveAllowOverlap = false;
                break;
              }
            }
          }
        }
      }

      if (hasConflict || !slotWithinWindow) {
        if (
          effectiveAllowOverlap &&
          slotWithinWindow &&
          hasConflict &&
          externalConflicts.length === 0
        ) {
          const overlapResponse = await tryScheduleWithOverlap({
            capture: capture as CaptureEntryRow,
            slot: preferredSlot,
            conflicts: diaGuruConflicts,
            admin,
            google,
            planId,
            capturePriority,
            durationMinutes,
            busyIntervals,
            referenceNow: now,
            recordPlanAction,
            finalizePlan,
            overlapUsage,
            enforceWorkingWindow,
            plan,
            resolvedDeadline,
            preferredSlot,
          });
          if (overlapResponse) {
            return overlapResponse;
          }
        }

        const respondWithConflictDecision = async () => {
          const suggestion = findNextAvailableSlot(busyIntervals, durationMinutes, offsetMinutes, {
            startFrom: addMinutes(preferredSlot.end, SLOT_INCREMENT_MINUTES),
            referenceNow: now,
            enforceWorkingWindow,
          });
          const llmConfig = resolveLlmConfig();
          const { decision, note } = await buildConflictDecision({
            capture,
            preferredSlot,
            conflicts,
            suggestion,
            timezone,
            offsetMinutes,
            outsideWindow: !slotWithinWindow,
            llmConfig,
            busyIntervals,
            admin,
          });

          await admin
            .from("capture_entries")
            .update({ scheduling_notes: mergeSchedulingNotes(capture.scheduling_notes, note) })
            .eq("id", capture.id);

          logScheduleSummary("schedule.conflict", {
            captureId: capture.id,
            content: capture.content,
            preferredSlot: {
              start: preferredSlot.start.toISOString(),
              end: preferredSlot.end.toISOString(),
              withinWindow: slotWithinWindow,
            },
            conflicts: conflicts.map((c) => ({
              id: c.id,
              summary: c.summary,
              start: c.start,
              end: c.end,
              diaGuru: c.diaGuru,
              captureId: c.captureId,
            })),
            suggestion,
            reason: "preferred_conflict",
            note,
          });

          return json({
            message: decision.message,
            capture,
            decision,
          });
        };

        let captureMap: Map<string, CaptureEntryRow> | null = null;
        let selectedConflicts: ConflictSummary[] = [];
        let canRebalance = false;
        if (
          allowRebalance &&
          plan.mode !== "flexible" &&
          slotWithinWindow &&
          conflicts.length > 0 &&
          externalConflicts.length === 0 &&
          diaGuruConflicts.length > 0
        ) {
          captureMap = await loadConflictCaptures(admin, diaGuruConflicts);
          if (captureMap.size > 0) {
            const movable: ConflictSummary[] = [];
            let hasLocked = false;

            for (const conflict of diaGuruConflicts) {
              const blocker = conflict.captureId ? captureMap.get(conflict.captureId) : null;
              if (!blocker) {
                hasLocked = true;
                break;
              }
              const frozen = hasActiveFreeze(blocker, now);
              const stabilityLocked = withinStabilityWindow(blocker, now) && plan.mode !== "deadline";
              if (frozen || stabilityLocked) {
                hasLocked = true;
                break;
              }
              movable.push(conflict);
            }

            if (!hasLocked && movable.length > 0) {
              const outranksAll = movable.every((conflict) => {
                const blocker = conflict.captureId ? captureMap!.get(conflict.captureId) : null;
                if (!blocker) return false;
                const blockerPriority = priorityForCapture(blocker, now);
                return capturePriority > blockerPriority;
              });

              if (outranksAll) {
                const preemptionPlan = selectMinimalPreemptionSet({
                  slot: preferredSlot,
                  events,
                  candidateIds: movable.map((conflict) => conflict.id),
                  offsetMinutes,
                  allowCompressedBuffer: plan.mode === "deadline",
                });
                if (preemptionPlan) {
                  const idSet = new Set(preemptionPlan.ids);
                  selectedConflicts = movable.filter((conflict) => idSet.has(conflict.id));
                  canRebalance = selectedConflicts.length > 0;
                  if (canRebalance && captureMap) {
                    const displacements = buildPreemptionDisplacements(selectedConflicts, captureMap);
                    if (displacements.length > 0) {
                      const slotMinutes = Math.max(
                        1,
                        (preferredSlot.end.getTime() - preferredSlot.start.getTime()) / 60000,
                      );
                      const evaluation = evaluatePreemptionNetGain({
                        target: capture,
                        displacements,
                        minutesClaimed: slotMinutes,
                        referenceNow: now,
                      });
                      logSchedulerEvent("preemption.analysis", {
                        captureId: capture.id,
                        slotMinutes: Number(slotMinutes.toFixed(2)),
                        displaced: displacements.map((disp) => ({
                          captureId: disp.capture.id,
                          minutes: Number(disp.minutes.toFixed(2)),
                        })),
                        evaluation: {
                          benefit: Number(evaluation.benefit.toFixed(3)),
                          cost: Number(evaluation.cost.toFixed(3)),
                          overlapCost: Number(evaluation.overlapCost.toFixed(3)),
                          net: Number(evaluation.net.toFixed(3)),
                          perMinuteGain: Number(evaluation.perMinuteGain.toFixed(4)),
                          movedTasks: evaluation.movedTasks,
                          totalDisplacedMinutes: Number(
                            evaluation.totalDisplacedMinutes.toFixed(2),
                          ),
                          meetsBaseThreshold: evaluation.meetsBaseThreshold,
                          meetsGainPerMinuteThreshold: evaluation.meetsGainPerMinuteThreshold,
                          allowed: evaluation.allowed,
                          thresholds: evaluation.thresholds,
                          limitChecks: evaluation.limitChecks,
                          targetPriority: evaluation.targetPriority,
                        },
                      });
                      if (!evaluation.allowed) {
                        logSchedulerEvent("preemption.rejected", {
                          captureId: capture.id,
                          reason: "net_gain_threshold",
                          evaluation: {
                            net: Number(evaluation.net.toFixed(3)),
                            perMinuteGain: Number(evaluation.perMinuteGain.toFixed(4)),
                            meetsBaseThreshold: evaluation.meetsBaseThreshold,
                            meetsGainPerMinuteThreshold: evaluation.meetsGainPerMinuteThreshold,
                            limitChecks: evaluation.limitChecks,
                          },
                        });
                        canRebalance = false;
                        selectedConflicts = [];
                      }
                    } else {
                      canRebalance = false;
                      selectedConflicts = [];
                    }
                  }
                }
              }
            }
          }
        }

        if (canRebalance && selectedConflicts.length > 0 && captureMap) {
          rescheduleQueue = await reclaimDiaGuruConflicts(selectedConflicts, google, admin, {
            captureMap,
            eventsById,
            planId,
            recordPlanAction,
          });
          if (rescheduleQueue.length > 0) {
            const removedIds = new Set(selectedConflicts.map((conflict) => conflict.id));
            events = events.filter((event) => !removedIds.has(event.id));
            eventsById = new Map(events.map((event) => [event.id, event]));
            busyIntervals = computeBusyIntervals(events);
          } else {
            return await respondWithConflictDecision();
          }
        } else {
          return await respondWithConflictDecision();
        }
      }

      // Hard guard: ensure slot respects deadline/window
      if (!isSlotWithinConstraints(capture, preferredSlot)) {
        return json({ error: "Requested slot exceeds deadline/window." }, 409);
      }
      const actionId = crypto.randomUUID();
      const prevSnapshot = snapshotFromRow(capture);
      const createdEvent = await google.createEvent({
        capture,
        slot: preferredSlot,
        planId,
        actionId,
        priorityScore: capturePriority,
      });
      registerInterval(busyIntervals, preferredSlot);

      if (rescheduleQueue.length > 0) {
        await rescheduleCaptures({
          captures: rescheduleQueue,
          admin,
          busyIntervals,
          offsetMinutes,
          referenceNow: now,
          google,
          planId,
          recordPlanAction,
        });
      }

      const schedulingNote = rescheduleQueue.length > 0
        ? "Scheduled at preferred slot after auto rebalancing existing DiaGuru sessions."
        : allowOverlap
          ? "Scheduled at preferred slot with overlap permitted by user."
          : "Scheduled at preferred slot requested by user.";

      const usedPreferred = slotMatchesTarget(preferredSlot, preferredSlot);
      const usedStartTolerance = Boolean(
        plan.mode === "start" && preferredSlot && !usedPreferred,
      );
      const explanation = buildScheduleExplanation({
        plan,
        slot: preferredSlot,
        capturePriority,
        durationMinutes,
        enforceWorkingWindow,
        resolvedDeadline,
        preferredSlot,
        decisionPath: rescheduleQueue.length > 0 ? ["preferred_slot", "preempted"] : ["preferred_slot"],
        flags: {
          preempted: rescheduleQueue.length > 0,
          usedPreferred,
          usedStartTolerance,
        },
      });

      const { data: updated, error: updateError } = await admin
        .from("capture_entries")
        .update({
          status: "scheduled",
          planned_start: preferredSlot.start.toISOString(),
          planned_end: preferredSlot.end.toISOString(),
          scheduled_for: preferredSlot.start.toISOString(),
          calendar_event_id: createdEvent.id,
          calendar_event_etag: createdEvent.etag,
          plan_id: planId,
          freeze_until: null,
          scheduling_notes: mergeSchedulingNotes(
            capture.scheduling_notes,
            schedulingNote,
            explanation,
          ),
        })
        .eq("id", capture.id)
        .select("*")
        .single();

      if (updateError) return json({ error: updateError.message }, 500);

      const chunkRecords = buildChunksForSlot(updated as CaptureEntryRow, preferredSlot);
      await replaceCaptureChunks(admin, updated as CaptureEntryRow, chunkRecords);
      const serializedChunks = serializeChunks(chunkRecords);

      await recordPlanAction({
        actionId,
        captureId: capture.id,
        captureContent: capture.content,
        actionType: prevSnapshot.status === "scheduled" ? "rescheduled" : "scheduled",
        prev: prevSnapshot,
        next: snapshotFromRow(updated as CaptureEntryRow),
      });

      const planSummary = await finalizePlan();
      logScheduleSummary("schedule.success", {
        captureId: capture.id,
        content: capture.content,
        slot: { start: preferredSlot.start.toISOString(), end: preferredSlot.end.toISOString() },
        overlap: null,
        planId,
        actionId,
      });
        return json({
          message: "Capture scheduled.",
          capture: updated,
          planSummary,
          chunks: serializedChunks,
          explanation,
        });
      }

    const preferredTimeOfDay = derivePreferredTimeOfDayBands(capture as CaptureEntryRow);

    const candidate = scheduleWithPlan({
      plan,
      durationMinutes,
      busyIntervals,
      offsetMinutes,
      referenceNow: now,
      isSoftStart: capture.is_soft_start,
      enforceWorkingWindow,
      preferredTimeOfDay,
    });
    const candidateWithinWindow =
      candidate &&
      candidate.start.getTime() >= scheduleWindowStart.getTime() &&
      candidate.end.getTime() <= scheduleWindowEnd.getTime();
    const validCandidate = candidateWithinWindow ? candidate : null;
    if (candidate && !candidateWithinWindow) {
      logSchedulerEvent("plan.discardedCandidate", {
        captureId: capture.id,
        candidate: { start: candidate.start.toISOString(), end: candidate.end.toISOString() },
        windowStart: scheduleWindowStart.toISOString(),
        windowEnd: scheduleWindowEnd.toISOString(),
      });
    }
    if (!validCandidate) {
      const searchWindowStart = scheduleWindowStart;
      const searchWindowEnd = scheduleWindowEnd;
      const canScanWindow = searchWindowEnd.getTime() > searchWindowStart.getTime();
      const gridCandidates = canScanWindow
        ? collectGridWindowCandidates({
          grid: occupancyGrid,
          durationMinutes,
          windowStart: searchWindowStart,
          windowEnd: searchWindowEnd,
          referenceNow: now,
          limit: 6,
        })
        : [];
      logSchedulerEvent("grid.windowScan", {
        captureId: capture.id,
        requestedMinutes: durationMinutes,
        windowStart: searchWindowStart.toISOString(),
        windowEnd: searchWindowEnd.toISOString(),
        totalCandidates: gridCandidates.length,
        top: gridCandidates.slice(0, 5).map((entry) => ({
          start: entry.slot.start.toISOString(),
          end: entry.slot.end.toISOString(),
          stats: entry.stats,
          hasExternal: entry.hasExternal,
        })),
      });

      let directSlot: PreferredSlot | null = null;
      if (resolvedDeadline && canScanWindow) {
        const chunkDurations = generateChunkDurations({
          totalMinutes: durationMinutes,
          minChunkMinutes: capture.min_chunk_minutes ?? DEFAULT_MIN_CHUNK_MINUTES,
          maxSplits: capture.max_splits ?? null,
          allowSplitting: capture.duration_flexibility === "split_allowed",
        });
        const placement = placeChunksWithinRange({
          chunkDurations,
          busyIntervals,
          offsetMinutes,
          rangeStart: searchWindowStart,
          rangeEnd: searchWindowEnd,
          enforceWorkingWindow,
        });
        if (placement && placement.records.length > 0) {
          directSlot = {
            start: placement.records[0].start,
            end: placement.records[placement.records.length - 1].end,
          };
        }
      }

      if (directSlot) {
        logSchedulerEvent("deadline.directPlacement", {
          captureId: capture.id,
          slot: { start: directSlot.start.toISOString(), end: directSlot.end.toISOString() },
        });
        const actionId = crypto.randomUUID();
        const prevSnapshot = snapshotFromRow(capture);
        const createdEvent = await google.createEvent({
          capture,
          slot: directSlot,
          planId,
          actionId,
          priorityScore: capturePriority,
        });
        registerInterval(busyIntervals, directSlot);

        const usedPreferred = slotMatchesTarget(directSlot, plan.preferredSlot ?? null);
        const usedStartTolerance = Boolean(
          plan.mode === "start" && plan.preferredSlot && !usedPreferred,
        );
        const explanation = buildScheduleExplanation({
          plan,
          slot: directSlot,
          capturePriority,
          durationMinutes,
          enforceWorkingWindow,
          resolvedDeadline,
          preferredSlot: plan.preferredSlot ?? null,
          decisionPath: ["deadline_direct"],
          flags: { usedPreferred, usedStartTolerance },
        });

        const { data: scheduledCapture, error: scheduleUpdateError } = await admin
          .from("capture_entries")
          .update({
            status: "scheduled",
            planned_start: directSlot.start.toISOString(),
            planned_end: directSlot.end.toISOString(),
            scheduled_for: directSlot.start.toISOString(),
            calendar_event_id: createdEvent.id,
            calendar_event_etag: createdEvent.etag,
            plan_id: planId,
            freeze_until: null,
            scheduling_notes: mergeSchedulingNotes(
              capture.scheduling_notes,
              "Scheduled within deadline window.",
              explanation,
            ),
          })
          .eq("id", capture.id)
          .select("*")
          .single();

        if (scheduleUpdateError) {
          throw new ScheduleError("Failed to persist scheduled capture after window placement.", 500, scheduleUpdateError);
        }

        const chunkRecords = buildChunksForSlot(scheduledCapture as CaptureEntryRow, directSlot);
        await replaceCaptureChunks(admin, scheduledCapture as CaptureEntryRow, chunkRecords);
        const serializedChunks = serializeChunks(chunkRecords);

        await recordPlanAction({
          actionId,
          captureId: capture.id,
          captureContent: capture.content,
          actionType: prevSnapshot.status === "scheduled" ? "rescheduled" : "scheduled",
          prev: prevSnapshot,
          next: snapshotFromRow(scheduledCapture as CaptureEntryRow),
        });

        const planSummary = await finalizePlan();
        return json({
          message: "Capture scheduled within deadline window.",
          capture: scheduledCapture,
          planSummary,
          chunks: serializedChunks,
          explanation,
        });
      }

      const gridChoice = allowRebalance
        ? await pickGridPreemptionCandidate({
          candidates: gridCandidates,
          events,
          capture,
          capturePriority,
          admin,
          referenceNow: now,
          offsetMinutes,
        })
        : null;

      if (gridChoice) {
        const rescheduleQueue = await reclaimDiaGuruConflicts(gridChoice.conflicts, google, admin, {
          captureMap: gridChoice.captureMap,
          eventsById,
          planId,
          recordPlanAction,
        });

        if (rescheduleQueue.length > 0) {
          const removedIds = new Set(gridChoice.conflicts.map((conflict) => conflict.id));
          events = events.filter((event) => !removedIds.has(event.id));
          eventsById = new Map(events.map((event) => [event.id, event]));
          busyIntervals = computeBusyIntervals(events);

          const actionId = crypto.randomUUID();
          const prevSnapshot = snapshotFromRow(capture);
          const createdEvent = await google.createEvent({
            capture,
            slot: gridChoice.slot,
            planId,
            actionId,
            priorityScore: capturePriority,
          });
          registerInterval(busyIntervals, gridChoice.slot);

          await rescheduleCaptures({
            captures: rescheduleQueue,
            admin,
            busyIntervals,
            offsetMinutes,
            referenceNow: now,
            google,
            planId,
            recordPlanAction,
          });

          const explanation = buildScheduleExplanation({
            plan,
            slot: gridChoice.slot,
            capturePriority,
            durationMinutes,
            enforceWorkingWindow,
            resolvedDeadline,
            preferredSlot: plan.preferredSlot ?? null,
            decisionPath: ["grid_preemption"],
            flags: { preempted: true },
          });

          const { data: scheduledCapture, error: scheduleUpdateError } = await admin
            .from("capture_entries")
            .update({
              status: "scheduled",
              planned_start: gridChoice.slot.start.toISOString(),
              planned_end: gridChoice.slot.end.toISOString(),
              scheduled_for: gridChoice.slot.start.toISOString(),
              calendar_event_id: createdEvent.id,
              calendar_event_etag: createdEvent.etag,
              plan_id: planId,
              freeze_until: null,
              scheduling_notes: mergeSchedulingNotes(
                capture.scheduling_notes,
                "Scheduled via prioritized rebalancing window.",
                explanation,
              ),
            })
            .eq("id", capture.id)
            .select("*")
            .single();

          if (scheduleUpdateError) {
            throw new ScheduleError("Failed to persist scheduled capture after grid preemption.", 500, scheduleUpdateError);
          }

          const chunkRecords = buildChunksForSlot(scheduledCapture as CaptureEntryRow, gridChoice.slot);
          await replaceCaptureChunks(admin, scheduledCapture as CaptureEntryRow, chunkRecords);
          const serializedChunks = serializeChunks(chunkRecords);

          await recordPlanAction({
            actionId,
            captureId: capture.id,
            captureContent: capture.content,
            actionType: prevSnapshot.status === "scheduled" ? "rescheduled" : "scheduled",
            prev: prevSnapshot,
            next: snapshotFromRow(scheduledCapture as CaptureEntryRow),
          });

          const planSummary = await finalizePlan();
          logSchedulerEvent("grid.preemption.commit", {
            captureId: capture.id,
            slot: { start: gridChoice.slot.start.toISOString(), end: gridChoice.slot.end.toISOString() },
            evaluation: gridChoice.evaluation,
            rescheduledCount: rescheduleQueue.length,
          });

            return json({
              message: "Capture scheduled via prioritized rebalancing.",
              capture: scheduledCapture,
              planSummary,
              chunks: serializedChunks,
              explanation,
            });
        } else {
          logSchedulerEvent("grid.preemption.abort", {
            captureId: capture.id,
            reason: "reclaim_failed",
          });
        }
      }

      const hardDeadline = Boolean(resolvedDeadline) && capture.constraint_type === "deadline_time";
      if (!hardDeadline && resolvedDeadline) {
        const capacityThreshold = Math.max(
          capture.min_chunk_minutes ?? DEFAULT_MIN_CHUNK_MINUTES,
          Math.ceil(0.25 * durationMinutes),
        );
        const preCapacity = windowSummary?.freeMinutes ?? 0;
        if (preCapacity < capacityThreshold) {
          const lateSlot = findNextAvailableSlot(busyIntervals, durationMinutes, offsetMinutes, {
            startFrom: scheduleWindowEnd,
            referenceNow: now,
            enforceWorkingWindow,
          });
          if (lateSlot) {
            return await scheduleLatePlacementResponse({
              capture: capture as CaptureEntryRow,
              slot: lateSlot,
              admin,
              google,
              planId,
              capturePriority,
              durationMinutes,
              busyIntervals,
              recordPlanAction,
              finalizePlan,
              schedulingNote: "Scheduled after soft deadline; marked late.",
              responseMessage: "Capture scheduled after soft deadline (marked late).",
              plan,
              resolvedDeadline,
              enforceWorkingWindow,
              preferredSlot,
              decisionPath: ["late_placement"],
            });
          }
        }
      }

      const fallbackLateCandidate = resolvedDeadline
        ? findLatePlacementSlot({
          busyIntervals,
          durationMinutes,
          offsetMinutes,
          referenceNow: now,
          startFrom: scheduleWindowEnd,
          enforceWorkingWindow,
        })
        : null;

      if (resolvedDeadline) {
        if (allowLatePlacement && fallbackLateCandidate) {
          return await scheduleLatePlacementResponse({
            capture: capture as CaptureEntryRow,
            slot: fallbackLateCandidate,
            admin,
            google,
            planId,
            capturePriority,
            durationMinutes,
            busyIntervals,
            recordPlanAction,
            finalizePlan,
            schedulingNote: "Scheduled after missed deadline (user override).",
            responseMessage: "Capture scheduled after missed deadline (marked late).",
            plan,
            resolvedDeadline,
            enforceWorkingWindow,
            preferredSlot,
            decisionPath: ["late_placement"],
          });
        }

        return json(
          buildDeadlineFailurePayload({
            capture,
            durationMinutes,
            deadline: resolvedDeadline,
            windowStart: scheduleWindowStart,
            windowEnd: scheduleWindowEnd,
            windowSummary,
            lateCandidate: fallbackLateCandidate,
            reason: "no_slot",
          }),
          409,
        );
      }
      return json(
        {
          error: "No available slot within constraints.",
          reason: "no_slot",
          capture_id: capture.id,
          duration_minutes: durationMinutes,
          reference_now: now.toISOString(),
        },
        409,
      );
    }

    const autoActionId = crypto.randomUUID();
    const prevSnapshot = snapshotFromRow(capture);
    // Hard guard: ensure slot respects deadline/window
    if (!isSlotWithinConstraints(capture, validCandidate)) {
      return json(
        {
          error: "Found slot exceeds deadline/window.",
          reason: "slot_exceeds_deadline",
          capture_id: capture.id,
          slot: { start: validCandidate.start.toISOString(), end: validCandidate.end.toISOString() },
          deadline: capture.deadline_at ?? capture.window_end ?? capture.constraint_end ?? (capture.constraint_type === "deadline_time" ? capture.constraint_time : null),
        },
        409,
      );
    }
    const createdEvent = await google.createEvent({
      capture,
      slot: validCandidate,
      planId,
      actionId: autoActionId,
      priorityScore: capturePriority,
    });

    const usedPreferred = slotMatchesTarget(validCandidate, plan.preferredSlot ?? null);
    const usedStartTolerance = Boolean(
      plan.mode === "start" && plan.preferredSlot && !usedPreferred,
    );
    const explanation = buildScheduleExplanation({
      plan,
      slot: validCandidate,
      capturePriority,
      durationMinutes,
      enforceWorkingWindow,
      resolvedDeadline,
      preferredSlot: plan.preferredSlot ?? null,
      decisionPath: ["plan_candidate"],
      flags: { usedPreferred, usedStartTolerance },
    });

    const { data: updated, error: updateError } = await admin
      .from("capture_entries")
      .update({
        status: "scheduled",
        planned_start: validCandidate.start.toISOString(),
        planned_end: validCandidate.end.toISOString(),
        scheduled_for: validCandidate.start.toISOString(),
        calendar_event_id: createdEvent.id,
        calendar_event_etag: createdEvent.etag,
        plan_id: planId,
        freeze_until: null,
        scheduling_notes: mergeSchedulingNotes(
          capture.scheduling_notes,
          `Scheduled automatically with ${BUFFER_MINUTES} minute buffer.`,
          explanation,
        ),
      })
      .eq("id", capture.id)
      .select("*")
      .single();

    if (updateError) return json({ error: updateError.message }, 500);

    let serializedChunks: SerializedChunk[] = [];
    if (updated) {
      const chunkRecords = buildChunksForSlot(updated as CaptureEntryRow, validCandidate);
      await replaceCaptureChunks(admin, updated as CaptureEntryRow, chunkRecords);
      serializedChunks = serializeChunks(chunkRecords);
    }

    await recordPlanAction({
      actionId: autoActionId,
      captureId: capture.id,
      captureContent: capture.content,
      actionType: prevSnapshot.status === "scheduled" ? "rescheduled" : "scheduled",
      prev: prevSnapshot,
      next: snapshotFromRow(updated as CaptureEntryRow),
    });

    const planSummary = await finalizePlan();
    return json({
      message: "Capture scheduled.",
      capture: updated,
      planSummary,
      chunks: serializedChunks,
      explanation,
    });
  } catch (error) {
    if (error instanceof ScheduleError) {
      return json(
        {
          error: error.message || "Scheduling failed",
          details: error.details ?? null,
        },
        error.status || 500,
      );
    }
    const fallbackMessage = error instanceof Error ? error.message : String(error);
    return json({ error: "Server error", details: fallbackMessage }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}

export async function resolveCalendarClient(
  admin: SupabaseClient<Database, "public">,
  userId: string,
  clientId: string,
  clientSecret: string,
) {
  const { data: accountData, error: accountError } = await admin
    .from("calendar_accounts")
    .select("id, needs_reconnect")
    .eq("user_id", userId)
    .eq("provider", "google")
    .single();
  if (accountError || !accountData) return null;
  const account = accountData as { id: number; needs_reconnect?: boolean };

  const { data: tokenRow, error: tokenError } = await admin
    .from("calendar_tokens")
    .select("access_token, refresh_token, expiry")
    .eq("account_id", account.id)
    .single();
  if (tokenError || !tokenRow) {
    await setCalendarReconnectFlag(admin, account.id, true);
    return null;
  }

  const typedToken = tokenRow as CalendarTokenRow;

  const credentials: CalendarClientCredentials = {
    accountId: account.id,
    accessToken: typedToken.access_token,
    refreshToken: typedToken.refresh_token,
    refreshed: false,
  };

  const expiryMillis = typedToken.expiry ? Date.parse(typedToken.expiry) : 0;
  const expiryIsValid = Number.isFinite(expiryMillis) && expiryMillis > 0;
  const alreadyExpired = expiryIsValid ? expiryMillis <= Date.now() : true;
  const expiresSoon = expiryIsValid ? expiryMillis <= Date.now() + 30_000 : true;
  const needsRefresh =
    !credentials.accessToken || alreadyExpired || expiresSoon || account.needs_reconnect;

  if (needsRefresh) {
    const refreshed = await refreshCalendarAccess({
      credentials,
      admin,
      clientId,
      clientSecret,
    });
    if (!refreshed) {
      await setCalendarReconnectFlag(admin, credentials.accountId, true);
      return null;
    }
  }

  await setCalendarReconnectFlag(admin, credentials.accountId, false);
  return credentials;
}

async function refreshGoogleToken(refreshToken: string, clientId: string, clientSecret: string) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  return await res.json();
}



// function scheduleLatePlacementResponse is KEPT as it is impure.
async function scheduleLatePlacementResponse(args: {
  capture: CaptureEntryRow;
  slot: PreferredSlot;
  admin: SupabaseClient<Database, "public">;
  google: GoogleCalendarActions;
  planId: string;
  capturePriority: number;
  durationMinutes: number;
  busyIntervals: { start: Date; end: Date }[];
  recordPlanAction: (action: Omit<PlanActionRecord, "planId">) => Promise<void>;
  finalizePlan: () => Promise<ReturnType<typeof buildPlanSummary> | null>;
  schedulingNote: string;
  responseMessage: string;
  plan: SchedulingPlan;
  resolvedDeadline: Date | null;
  enforceWorkingWindow: boolean;
  preferredSlot: PreferredSlot | null;
  decisionPath: string[];
}) {
  const actionId = crypto.randomUUID();
  const prevSnapshot = snapshotFromRow(args.capture);
  const createdEvent = await args.google.createEvent({
    capture: args.capture,
    slot: args.slot,
    planId: args.planId,
    actionId,
    priorityScore: args.capturePriority,
  });
  registerInterval(args.busyIntervals, args.slot);

  const explanation = buildScheduleExplanation({
    plan: args.plan,
    slot: args.slot,
    capturePriority: args.capturePriority,
    durationMinutes: args.durationMinutes,
    enforceWorkingWindow: args.enforceWorkingWindow,
    resolvedDeadline: args.resolvedDeadline,
    preferredSlot: args.preferredSlot,
    decisionPath: args.decisionPath,
    flags: { late: true },
  });

  const { data, error } = await args.admin
    .from("capture_entries")
    .update({
      status: "scheduled",
      planned_start: args.slot.start.toISOString(),
      planned_end: args.slot.end.toISOString(),
      scheduled_for: args.slot.start.toISOString(),
      calendar_event_id: createdEvent.id,
      calendar_event_etag: createdEvent.etag,
      plan_id: args.planId,
      freeze_until: null,
      scheduling_notes: mergeSchedulingNotes(
        args.capture.scheduling_notes,
        args.schedulingNote,
        explanation,
      ),
    })
    .eq("id", args.capture.id)
    .select("*")
    .single();

  if (error || !data) {
    throw new ScheduleError("Failed to persist late placement.", 500, error);
  }

  const chunkRecords = buildChunksForSlot(data as CaptureEntryRow, args.slot, { late: true });
  await replaceCaptureChunks(args.admin, data as CaptureEntryRow, chunkRecords);
  const serializedChunks = serializeChunks(chunkRecords);

  await args.recordPlanAction({
    actionId,
    captureId: args.capture.id,
    captureContent: args.capture.content,
    actionType: prevSnapshot.status === "scheduled" ? "rescheduled" : "scheduled",
    prev: prevSnapshot,
    next: snapshotFromRow(data as CaptureEntryRow),
  });

  const planSummary = await args.finalizePlan();
  return json({
    message: args.responseMessage,
    capture: data,
    planSummary,
    chunks: serializedChunks,
    explanation,
  });
}

async function tryScheduleWithOverlap(args: {
  capture: CaptureEntryRow;
  slot: PreferredSlot;
  conflicts: ConflictSummary[];
  admin: SupabaseClient<Database, "public">;
  google: GoogleCalendarActions;
  planId: string;
  capturePriority: number;
  durationMinutes: number;
  busyIntervals: { start: Date; end: Date }[];
  referenceNow: Date;
  recordPlanAction: (action: Omit<PlanActionRecord, "planId">) => Promise<void>;
  finalizePlan: () => Promise<ReturnType<typeof buildPlanSummary> | null>;
  overlapUsage: Map<string, number>;
  enforceWorkingWindow: boolean;
  plan: SchedulingPlan;
  resolvedDeadline: Date | null;
  preferredSlot: PreferredSlot | null;
}): Promise<Response | null> {
  if (!schedulerConfig.overlap.enabled) return null;
  if (args.conflicts.length === 0) return null;

  if (!canCaptureOverlap(args.capture)) return null;

  const conflictMap = await loadConflictCaptures(args.admin, args.conflicts);
  if (conflictMap.size === 0) return null;

  const overlapConfig = schedulerConfig.overlap;
  if (args.conflicts.length + 1 > overlapConfig.maxConcurrency) return null;

  const conflictingCaptures: CaptureEntryRow[] = [];
  for (const conflict of args.conflicts) {
    if (!conflict.captureId) return null;
    const capture = conflictMap.get(conflict.captureId);
    if (!capture || !canCaptureOverlap(capture)) {
      return null;
    }
    conflictingCaptures.push(capture);
  }

  const slotMinutes = Math.max(
    SLOT_INCREMENT_MINUTES,
    Math.round((args.slot.end.getTime() - args.slot.start.getTime()) / 60000),
  );
  const targetEstimate = sanitizedEstimatedMinutes(args.capture);
  const maxOverlapForTarget = Math.max(
    SLOT_INCREMENT_MINUTES,
    Math.floor(targetEstimate * overlapConfig.perTaskOverlapFraction),
  );
  if (slotMinutes > maxOverlapForTarget) return null;

  const dayKey = args.slot.start.toISOString().slice(0, 10);
  const usedMinutes = args.overlapUsage.get(dayKey) ?? 0;
  if (usedMinutes + slotMinutes > overlapConfig.dailyBudgetMinutes) return null;

  const conflictPriorities = conflictingCaptures.map((capture) =>
    priorityForCapture(capture, args.referenceNow),
  );
  const highestConflictPriority =
    conflictPriorities.length > 0 ? Math.max(...conflictPriorities) : 0;
  const isPrime = args.capturePriority >= highestConflictPriority;

  const targetMinutes = Math.max(1, sanitizedEstimatedMinutes(args.capture));
  const overlapBenefit = (args.capturePriority / targetMinutes) * slotMinutes;
  const overlapCost = overlapConfig.softCostPerMinute * slotMinutes;
  const overlapNet = overlapBenefit - overlapCost;
  if (overlapNet <= 0) {
    logSchedulerEvent("overlap.rejected", {
      captureId: args.capture.id,
      overlapMinutes: slotMinutes,
      reason: "soft_cost_exceeds_benefit",
      overlapBenefit: Number(overlapBenefit.toFixed(3)),
      overlapCost: Number(overlapCost.toFixed(3)),
    });
    return null;
  }

  const usedPreferred = slotMatchesTarget(args.slot, args.preferredSlot);
  const usedStartTolerance = Boolean(
    args.plan.mode === "start" && args.preferredSlot && !usedPreferred,
  );
  const explanation = buildScheduleExplanation({
    plan: args.plan,
    slot: args.slot,
    capturePriority: args.capturePriority,
    durationMinutes: args.durationMinutes,
    enforceWorkingWindow: args.enforceWorkingWindow,
    resolvedDeadline: args.resolvedDeadline,
    preferredSlot: args.preferredSlot,
    decisionPath: ["overlap"],
    flags: { overlapped: true, usedPreferred, usedStartTolerance },
  });

  const actionId = crypto.randomUUID();
  const prevSnapshot = snapshotFromRow(args.capture);
  const createdEvent = await args.google.createEvent({
    capture: args.capture,
    slot: args.slot,
    planId: args.planId,
    actionId,
    priorityScore: args.capturePriority,
  });
  registerInterval(args.busyIntervals, args.slot);

  const { data, error } = await args.admin
    .from("capture_entries")
    .update({
      status: "scheduled",
      planned_start: args.slot.start.toISOString(),
      planned_end: args.slot.end.toISOString(),
      scheduled_for: args.slot.start.toISOString(),
      calendar_event_id: createdEvent.id,
      calendar_event_etag: createdEvent.etag,
      plan_id: args.planId,
      freeze_until: null,
      scheduling_notes: mergeSchedulingNotes(
        args.capture.scheduling_notes,
        `Scheduled with overlap alongside ${conflictingCaptures.length} capture(s).`,
        explanation,
      ),
    })
    .eq("id", args.capture.id)
    .select("*")
    .single();

  if (error || !data) {
    throw new ScheduleError("Failed to persist overlap placement.", 500, error);
  }

  const chunkRecords = buildChunksForSlot(data as CaptureEntryRow, args.slot, {
    overlapped: true,
    prime: isPrime,
  });
  await replaceCaptureChunks(args.admin, data as CaptureEntryRow, chunkRecords);
  const serializedChunks = serializeChunks(chunkRecords);

  await args.recordPlanAction({
    actionId,
    captureId: args.capture.id,
    captureContent: args.capture.content,
    actionType: prevSnapshot.status === "scheduled" ? "rescheduled" : "scheduled",
    prev: prevSnapshot,
    next: snapshotFromRow(data as CaptureEntryRow),
  });

  args.overlapUsage.set(dayKey, usedMinutes + slotMinutes);

  const planSummary = await args.finalizePlan();
  logSchedulerEvent("overlap.commit", {
    captureId: args.capture.id,
    slot: { start: args.slot.start.toISOString(), end: args.slot.end.toISOString() },
    conflicts: args.conflicts.map((conflict) => conflict.captureId),
    overlapMinutes: slotMinutes,
    dayKey,
    prime: isPrime,
    budget: {
      used: usedMinutes + slotMinutes,
      limit: overlapConfig.dailyBudgetMinutes,
    },
    overlapBenefit: Number(overlapBenefit.toFixed(3)),
    overlapCost: Number(overlapCost.toFixed(3)),
  });

  logScheduleSummary("schedule.success", {
    captureId: args.capture.id,
    content: args.capture.content,
    slot: { start: args.slot.start.toISOString(), end: args.slot.end.toISOString() },
    overlap: {
      conflicts: args.conflicts.map((c) => c.captureId),
      minutes: slotMinutes,
      budget: { used: usedMinutes + slotMinutes, limit: overlapConfig.dailyBudgetMinutes },
      prime: isPrime,
    },
    planId: args.planId,
  });

  return json({
    message: "Capture scheduled via overlap.",
    capture: data,
    planSummary,
    chunks: serializedChunks,
    explanation,
    overlap: {
      minutes: slotMinutes,
      conflicts: args.conflicts.map((conflict) => conflict.captureId),
      day: dayKey,
      prime: isPrime,
      budget: {
        used: usedMinutes + slotMinutes,
        limit: overlapConfig.dailyBudgetMinutes,
      },
    },
  });
}

async function pickGridPreemptionCandidate(args: {
  candidates: GridWindowCandidate[];
  events: CalendarEvent[];
  capture: CaptureEntryRow;
  capturePriority: number;
  admin: SupabaseClient<Database, "public">;
  referenceNow: Date;
  offsetMinutes: number;
}): Promise<GridPreemptionChoice | null> {
  let best: GridPreemptionChoice | null = null;

  for (const candidate of args.candidates) {
    if (candidate.hasExternal) continue;
    if (!isSlotWithinWorkingWindow(candidate.slot, args.offsetMinutes)) continue;

    const conflicts = collectConflictingEvents(candidate.slot, args.events, args.referenceNow);
    const externalConflicts = conflicts.filter((conflict) => !conflict.diaGuru);
    if (externalConflicts.length > 0) continue;
    const diaGuruConflicts = conflicts.filter((conflict) => conflict.diaGuru && conflict.captureId);
    if (diaGuruConflicts.length === 0) continue;

    const captureMap = await loadConflictCaptures(args.admin, diaGuruConflicts);
    if (captureMap.size === 0) continue;
    const movable: ConflictSummary[] = [];
    let blocked = false;

    for (const conflict of diaGuruConflicts) {
      const blocker = conflict.captureId ? captureMap.get(conflict.captureId) : null;
      if (!blocker) {
        blocked = true;
        break;
      }
      const frozen = hasActiveFreeze(blocker, args.referenceNow);
      const stabilityLocked = withinStabilityWindow(blocker, args.referenceNow);
      if (frozen || stabilityLocked) {
        blocked = true;
        break;
      }
      movable.push(conflict);
    }
    if (blocked || movable.length === 0) continue;

    const outranksAll = movable.every((conflict) => {
      const blocker = conflict.captureId ? captureMap.get(conflict.captureId) : null;
      if (!blocker) return false;
      const blockerPriority = priorityForCapture(blocker, args.referenceNow);
      return args.capturePriority > blockerPriority;
    });
    if (!outranksAll) continue;

    const displacements = buildPreemptionDisplacements(movable, captureMap);
    if (displacements.length === 0) continue;
    const slotMinutes = Math.max(
      1,
      (candidate.slot.end.getTime() - candidate.slot.start.getTime()) / 60000,
    );
    const evaluation = evaluatePreemptionNetGain({
      target: args.capture,
      displacements,
      minutesClaimed: slotMinutes,
      referenceNow: args.referenceNow,
    });
    if (!evaluation.allowed) continue;

    if (!best || evaluation.net > best.evaluation.net) {
      best = { slot: candidate.slot, conflicts: movable, captureMap, evaluation };
    }
  }

  if (best) {
    logSchedulerEvent("grid.preemption.candidate", {
      captureId: args.capture.id,
      slot: { start: best.slot.start.toISOString(), end: best.slot.end.toISOString() },
      evaluation: {
        net: Number(best.evaluation.net.toFixed(3)),
        perMinuteGain: Number(best.evaluation.perMinuteGain.toFixed(4)),
        overlapCost: Number(best.evaluation.overlapCost.toFixed(3)),
        movedTasks: best.evaluation.movedTasks,
        totalDisplacedMinutes: Number(best.evaluation.totalDisplacedMinutes.toFixed(2)),
        thresholds: best.evaluation.thresholds,
      },
    });
  }

  return best;
}



async function reclaimDiaGuruConflicts(
  conflicts: ConflictSummary[],
  google: GoogleCalendarActions,
  admin: SupabaseClient<Database, "public">,
  options: {
    captureMap: Map<string, CaptureEntryRow>;
    eventsById: Map<string, CalendarEvent>;
    planId: string;
    recordPlanAction: (action: Omit<PlanActionRecord, "planId">) => Promise<void>;
  },
) {
  const removed: CaptureEntryRow[] = [];
  for (const conflict of conflicts) {
    if (!conflict.captureId) continue;
    const blocker = options.captureMap.get(conflict.captureId);
    const prevSnapshot = blocker ? snapshotFromRow(blocker) : null;
    try {
      const event = options.eventsById.get(conflict.id);
      await google.deleteEvent({
        eventId: conflict.id,
        etag: blocker?.calendar_event_etag ?? event?.etag,
      });
    } catch (error) {
      if (error instanceof ScheduleError && error.status === 412) {
        const refreshed = await google.getEvent(conflict.id);
        if (refreshed) {
          options.eventsById.set(conflict.id, refreshed);
          try {
            await google.deleteEvent({
              eventId: conflict.id,
              etag: refreshed.etag ?? undefined,
            });
          } catch (retryError) {
            console.log("Retry delete failed for event", conflict.id, retryError);
          }
        }
      } else {
        console.log("Failed to delete conflicting event", conflict.id, error);
      }
    }
    const nextRescheduleCount = (options.captureMap.get(conflict.captureId)?.reschedule_count ?? 0) + 1;
    const { data, error } = await admin
      .from("capture_entries")
      .update({
        status: "pending",
        calendar_event_id: null,
        calendar_event_etag: null,
        planned_start: null,
        planned_end: null,
        scheduled_for: null,
        reschedule_count: nextRescheduleCount,
        plan_id: options.planId,
        freeze_until: null,
        scheduling_notes: mergeSchedulingNotes(
          blocker?.scheduling_notes ?? null,
          "Rebalanced to honour a higher priority constraint.",
        ),
      })
      .eq("id", conflict.captureId)
      .select("*")
      .single();
    if (error || !data) continue;
    removed.push(data as CaptureEntryRow);
    options.eventsById.delete(conflict.id);
    if (prevSnapshot) {
      await options.recordPlanAction({
        actionId: crypto.randomUUID(),
        captureId: conflict.captureId,
        captureContent: blocker?.content ?? "Capture",
        actionType: "unscheduled",
        prev: prevSnapshot,
        next: snapshotFromRow(data as CaptureEntryRow),
      });
    }
  }
  return removed;
}

async function loadConflictCaptures(
  admin: SupabaseClient<Database, "public">,
  conflicts: ConflictSummary[],
) {
  const ids = Array.from(
    new Set(
      conflicts
        .map((conflict) => conflict.captureId)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (ids.length === 0) {
    return new Map();
  }
  const { data, error } = await admin
    .from("capture_entries")
    .select("*")
    .in("id", ids);
  if (error || !data) {
    return new Map();
  }
  const map = new Map<string, CaptureEntryRow>();
  for (const row of data as CaptureEntryRow[]) {
    map.set(row.id, row);
  }
  return map;
}

async function rescheduleCaptures(args: {
  captures: CaptureEntryRow[];
  google: GoogleCalendarActions;
  admin: SupabaseClient<Database, "public">;
  busyIntervals: { start: Date; end: Date }[];
  offsetMinutes: number;
  referenceNow: Date;
  planId: string;
  recordPlanAction: (action: Omit<PlanActionRecord, "planId">) => Promise<void>;
}) {
  const {
    captures,
    google,
    admin,
    busyIntervals,
    offsetMinutes,
    referenceNow,
    planId,
    recordPlanAction,
  } = args;
  const queue = [...captures].sort((a, b) => {
    const bPriority = priorityForCapture(b, referenceNow);
    const aPriority = priorityForCapture(a, referenceNow);
    if (bPriority !== aPriority) return bPriority - aPriority;
    if (b.importance !== a.importance) return b.importance - a.importance;
    const aMinutes = Math.max(5, Math.min(a.estimated_minutes ?? 30, 480));
    const bMinutes = Math.max(5, Math.min(b.estimated_minutes ?? 30, 480));
    if (aMinutes !== bMinutes) return aMinutes - bMinutes;
    return new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime();
  });

  for (const capture of queue) {
    const durationMinutes = Math.max(5, Math.min(capture.estimated_minutes ?? 30, 480));
    const plan = computeSchedulingPlan(capture, durationMinutes, offsetMinutes, referenceNow);
    const enforceWorkingWindow = shouldEnforceWorkingWindow(capture);
    const slot = scheduleWithPlan({
      plan,
      durationMinutes,
      busyIntervals,
      offsetMinutes,
      referenceNow,
      isSoftStart: capture.is_soft_start,
      enforceWorkingWindow,
    });

    if (!slot) {
      await admin
        .from("capture_entries")
        .update({
          status: "pending",
          scheduling_notes: mergeSchedulingNotes(
            capture.scheduling_notes,
            "Unable to reschedule automatically. Please choose a new time.",
          ),
        })
        .eq("id", capture.id);
      await replaceCaptureChunks(admin, capture, []);
      continue;
    }

    try {
      const actionId = crypto.randomUUID();
      const priorityScore = priorityForCapture(capture, referenceNow);
      const createdEvent = await google.createEvent({
        capture,
        slot,
        planId,
        actionId,
        priorityScore,
      });
      const prevSnapshot = snapshotFromRow(capture);
      const resolvedDeadline = plan.deadline ?? resolveDeadlineFromCapture(capture, offsetMinutes);
      const usedPreferred = slotMatchesTarget(slot, plan.preferredSlot ?? null);
      const usedStartTolerance = Boolean(
        plan.mode === "start" && plan.preferredSlot && !usedPreferred,
      );
      const explanation = buildScheduleExplanation({
        plan,
        slot,
        capturePriority: priorityScore,
        durationMinutes,
        enforceWorkingWindow,
        resolvedDeadline,
        preferredSlot: plan.preferredSlot ?? null,
        decisionPath: ["reschedule_auto"],
        flags: { usedPreferred, usedStartTolerance },
      });
      const { data, error } = await admin
        .from("capture_entries")
        .update({
          status: "scheduled",
          planned_start: slot.start.toISOString(),
          planned_end: slot.end.toISOString(),
          scheduled_for: slot.start.toISOString(),
          calendar_event_id: createdEvent.id,
          calendar_event_etag: createdEvent.etag,
          plan_id: planId,
          freeze_until: null,
          scheduling_notes: mergeSchedulingNotes(
            capture.scheduling_notes,
            "Rescheduled automatically after calendar reflow.",
            explanation,
          ),
        })
        .eq("id", capture.id)
        .select("*")
        .single();
      if (!error && data) {
        const chunkRecords = buildChunksForSlot(data as CaptureEntryRow, slot);
        await replaceCaptureChunks(admin, data as CaptureEntryRow, chunkRecords);
        registerInterval(busyIntervals, slot);
        await recordPlanAction({
          actionId,
          captureId: capture.id,
          captureContent: capture.content,
          actionType: "rescheduled",
          prev: prevSnapshot,
          next: snapshotFromRow(data as CaptureEntryRow),
        });
      }
    } catch (error) {
      console.log("Failed to reschedule capture", capture.id, error);
      await admin
        .from("capture_entries")
        .update({
          status: "pending",
          scheduling_notes: mergeSchedulingNotes(
            capture.scheduling_notes,
            "Reschedule attempt failed. Please retry manually.",
          ),
        })
        .eq("id", capture.id);
      await replaceCaptureChunks(admin, capture, []);
    }
  }
}

function resolveLlmConfig(): LlmConfig | null {
  const baseUrlRaw = Deno.env.get("LLM_BASE_URL");
  const apiKey = Deno.env.get("LLM_API_KEY");
  const model = Deno.env.get("LLM_MODEL") ?? "deepseek-v3";
  if (!baseUrlRaw || !apiKey) return null;
  const baseUrl = baseUrlRaw.replace(/\s+/g, "").replace(/\/+$/, "");
  if (!baseUrl) return null;
  return { baseUrl, apiKey, model };
}

async function buildConflictDecision(args: {
  capture: CaptureEntryRow;
  preferredSlot: PreferredSlot;
  conflicts: ConflictSummary[];
  suggestion: { start: Date; end: Date } | null;
  timezone: string | null;
  offsetMinutes: number;
  outsideWindow: boolean;
  llmConfig: LlmConfig | null;
  busyIntervals: { start: Date; end: Date }[];
  admin: SupabaseClient<Database, "public">;
}): Promise<ConflictDecision> {
  const { capture, preferredSlot } = args;
  const suggestionPayload = args.suggestion
    ? {
      start: args.suggestion.start.toISOString(),
      end: args.suggestion.end.toISOString(),
    }
    : null;

  const baseMessage = args.outsideWindow
    ? "This request falls outside DiaGuru's scheduling window (8am – 10pm)."
    : "That time is already blocked. Here is what we found.";

  const durationMinutes = Math.max(
    5,
    Math.round((preferredSlot.end.getTime() - preferredSlot.start.getTime()) / 60000),
  );

  // enrich conflicts with capture details when available
  const diaGuruConflicts = args.conflicts.filter((c) => c.diaGuru && c.captureId);
  const captureMap = await loadConflictCaptures(args.admin, diaGuruConflicts);
  const conflictCaptures = Array.from(captureMap.values()).map((c) => {
    let facets: Record<string, unknown> = {};
    try {
      const raw = typeof c.scheduling_notes === "string" ? c.scheduling_notes : null;
      if (raw && raw.trim().length > 0) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          facets = parsed as Record<string, unknown>;
        }
      }
    } catch {
      // ignore malformed scheduling notes
    }
    return {
      id: c.id,
      content: c.content,
      estimated_minutes: c.estimated_minutes,
      constraint_type: c.constraint_type,
      constraint_time: c.constraint_time,
      constraint_end: c.constraint_end,
      constraint_date: c.constraint_date,
      deadline_at: c.deadline_at,
      window_start: c.window_start,
      window_end: c.window_end,
      start_target_at: c.start_target_at,
      is_soft_start: c.is_soft_start,
      reschedule_count: c.reschedule_count,
      facets,
    };
  });

  const advisorResult = await adviseWithDeepSeek({
    config: args.llmConfig,
    capture,
    preferredSlot,
    conflicts: args.conflicts,
    conflictCaptures,
    suggestion: suggestionPayload,
    timezone: args.timezone,
    offsetMinutes: args.offsetMinutes,
    outsideWindow: args.outsideWindow,
    durationMinutes,
    busyIntervals: args.busyIntervals,
  });

  const decision: ScheduleDecision = {
    type: "preferred_conflict",
    message: advisorResult.advisor?.message?.trim() || baseMessage,
    preferred: {
      start: preferredSlot.start.toISOString(),
      end: preferredSlot.end.toISOString(),
    },
    conflicts: args.conflicts,
    suggestion: suggestionPayload,
    advisor: advisorResult.advisor,
    metadata: advisorResult.metadata,
  };

  const noteParts = [
    `Preferred slot conflict at ${decision.preferred.start}.`,
    args.outsideWindow ? "Outside working window." : null,
    `LLM attempted: ${advisorResult.metadata.llmAttempted ? "yes" : "no"}.`,
    advisorResult.metadata.llmModel ? `Model: ${advisorResult.metadata.llmModel}.` : null,
    advisorResult.metadata.llmError ? `LLM error: ${advisorResult.metadata.llmError}.` : null,
    advisorResult.advisor?.action ? `Advisor action: ${advisorResult.advisor.action}.` : null,
    advisorResult.advisor?.slot?.start ? `Advisor slot: ${advisorResult.advisor.slot.start}.` : null,
    suggestionPayload ? `Fallback slot: ${suggestionPayload.start}.` : null,
  ].filter(Boolean);

  const note = noteParts.join(" ");
  return { decision, note };
}

async function adviseWithDeepSeek(args: {
  config: LlmConfig | null;
  capture: CaptureEntryRow;
  preferredSlot: PreferredSlot;
  conflicts: ConflictSummary[];
  conflictCaptures: Record<string, unknown>[];
  suggestion: { start: string; end: string } | null;
  timezone: string | null;
  offsetMinutes: number;
  outsideWindow: boolean;
  durationMinutes: number;
  busyIntervals: { start: Date; end: Date }[];
}): Promise<AdvisorResult> {
  if (!args.config) {
    return {
      advisor: null,
      metadata: { llmAttempted: false },
    };
  }

  const endpoint = args.config.baseUrl.match(/\/chat\/completions$/)
    ? args.config.baseUrl
    : `${args.config.baseUrl}/chat/completions`;

  const context = {
    capture: {
      id: args.capture.id,
      importance: args.capture.importance,
      estimated_minutes: args.capture.estimated_minutes,
      content: args.capture.content,
    },
    preferred_slot: {
      start: args.preferredSlot.start.toISOString(),
      end: args.preferredSlot.end.toISOString(),
    },
    duration_minutes: args.durationMinutes,
    conflicts: args.conflicts,
    conflict_captures: args.conflictCaptures,
    suggestion: args.suggestion,
    timezone: args.timezone,
    timezone_offset_minutes: args.offsetMinutes,
    outside_window: args.outsideWindow,
    generated_at: new Date().toISOString(),
  };

  const payload = {
    model: args.config.model,
    messages: [
      {
        role: "system",
        content:
          "You are DiaGuru's scheduling assistant. Resolve conflicts succinctly and respond in JSON with keys: action ('suggest_slot' | 'ask_overlap' | 'defer'), message (string), optional slot { start, end } in ISO 8601.",
      },
      { role: "user", content: JSON.stringify(context) },
    ],
    temperature: 0.2,
    max_tokens: 400,
    response_format: { type: "json_object" },
  };

  const metadata: AdvisorResult["metadata"] = {
    llmAttempted: true,
    llmModel: args.config.model,
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await safeParse(res);
    if (!res.ok) {
      const message = extractGoogleError(data) ?? `LLM request failed with status ${res.status}`;
      metadata.llmError = message;
      return { advisor: null, metadata };
    }

    const choicesValue =
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>).choices
        : undefined;
    const firstChoice = Array.isArray(choicesValue) ? choicesValue[0] : null;
    const messageValue =
      firstChoice && typeof firstChoice === "object"
        ? (firstChoice as Record<string, unknown>).message
        : undefined;
    const content =
      messageValue && typeof messageValue === "object"
        ? (messageValue as Record<string, unknown>).content
        : undefined;

    if (typeof content !== "string" || !content.trim()) {
      metadata.llmError = "LLM returned empty content.";
      return { advisor: null, metadata };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      metadata.llmError = `Unable to parse LLM JSON: ${error instanceof Error ? error.message : "unknown error"}`;
      return { advisor: null, metadata };
    }

    const actionRaw = parsed.action;
    const messageRaw = parsed.message;
    const slotRaw = parsed.slot;

    if (actionRaw !== "suggest_slot" && actionRaw !== "ask_overlap" && actionRaw !== "defer") {
      metadata.llmError = "LLM returned an invalid action.";
      return { advisor: null, metadata };
    }

    const advisorSlotRaw = normalizeAdvisorSlot(slotRaw, args.durationMinutes);
    let advisorSlot: { start: string; end: string } | null = null;
    if (advisorSlotRaw) {
      const slotIsValid = validateAdvisorSlot(advisorSlotRaw, args.busyIntervals, args.offsetMinutes);
      if (slotIsValid) {
        advisorSlot = {
          start: advisorSlotRaw.start.toISOString(),
          end: advisorSlotRaw.end.toISOString(),
        };
      } else {
        metadata.llmError = "LLM proposed slot failed validation.";
      }
    }

    const messageText =
      typeof messageRaw === "string" && messageRaw.trim().length > 0
        ? messageRaw.trim()
        : "DiaGuru could not honour that slot without a conflict.";

    return {
      advisor: {
        action: actionRaw,
        message: messageText,
        slot: advisorSlot,
      },
      metadata,
    };
  } catch (error) {
    metadata.llmError = error instanceof Error ? error.message : String(error);
    return { advisor: null, metadata };
  }
}

function normalizeAdvisorSlot(
  slot: unknown,
  fallbackMinutes: number,
): PreferredSlot | null {
  if (!slot || typeof slot !== "object") return null;
  const slotRecord = slot as Record<string, unknown>;
  const startIso = typeof slotRecord.start === "string" ? slotRecord.start : null;
  const endIso = typeof slotRecord.end === "string" ? slotRecord.end : null;
  if (!startIso) return null;
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

function validateAdvisorSlot(
  slot: PreferredSlot,
  busyIntervals: { start: Date; end: Date }[],
  offsetMinutes: number,
) {
  if (!isSlotWithinWorkingWindow(slot, offsetMinutes)) return false;
  return isSlotFree(slot.start, slot.end, busyIntervals);
}

async function listCalendarEvents(accessToken: string, timeMin: string, timeMax: string) {
  const url = new URL(GOOGLE_EVENTS);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("maxResults", "250");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await safeParse(res);
  if (!res.ok) {
    const message =
      extractGoogleError(payload) ?? `Google events fetch failed (status ${res.status})`;
    throw new ScheduleError(message, res.status, payload);
  }
  const itemsValue =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).items
      : null;
  const rawItems = Array.isArray(itemsValue) ? (itemsValue as unknown[]) : [];
  return rawItems as CalendarEvent[];
}

async function getCalendarEvent(accessToken: string, eventId: string) {
  const res = await fetch(`${GOOGLE_EVENTS}/${eventId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  const payload = await safeParse(res);
  if (!res.ok) {
    const message =
      extractGoogleError(payload) ?? `Failed to fetch calendar event (status ${res.status})`;
    throw new ScheduleError(message, res.status, payload);
  }
  return payload as CalendarEvent;
}

async function deleteCalendarEvent(
  accessToken: string,
  options: { eventId: string; etag?: string | null },
) {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (options.etag) headers["If-Match"] = options.etag;
  const res = await fetch(`${GOOGLE_EVENTS}/${options.eventId}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const payload = await safeParse(res);
    const message =
      extractGoogleError(payload) ?? `Failed to delete calendar event (status ${res.status})`;
    if (res.status === 412) {
      throw new ScheduleError(message, res.status, { eventId: options.eventId, payload });
    }
    if (res.status === 404) return;
    throw new ScheduleError(message, res.status, payload);
  }
}

async function createCalendarEvent(
  accessToken: string,
  params: {
    capture: CaptureEntryRow;
    slot: { start: Date; end: Date };
    planId?: string | null;
    actionId: string;
    priorityScore: number;
    description?: string;
  },
) {
  const { capture, slot, planId, actionId, priorityScore } = params;
  const summary = `[DG] ${capture.content}`.slice(0, 200);
  const privateProps: Record<string, string> = {
    diaGuru: "true",
    capture_id: capture.id,
    action_id: actionId,
    priority_snapshot: priorityScore.toFixed(2),
  };
  if (planId) {
    privateProps.plan_id = planId;
  }
  const body = {
    summary,
    description:
      params.description ??
      `DiaGuru scheduled task (importance ${capture.importance}).`,
    start: { dateTime: slot.start.toISOString() },
    end: { dateTime: slot.end.toISOString() },
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        ...privateProps,
      },
    },
  };

  const res = await fetch(GOOGLE_EVENTS, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await safeParse(res);
  if (!res.ok) {
    const message =
      extractGoogleError(payload) ?? `Failed to create calendar event (status ${res.status})`;
    throw new ScheduleError(message, res.status, payload);
  }
  const identifier =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>).id : null;
  const etag =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>).etag : null;
  if (!identifier || typeof identifier !== "string") {
    throw new ScheduleError("Google did not return an event id", 502, payload);
  }
  return { id: identifier, etag: typeof etag === "string" ? etag : null };
}

function snapshotFromRow(row: CaptureEntryRow): CaptureSnapshot {
  return {
    status: row.status ?? null,
    planned_start: row.planned_start ?? null,
    planned_end: row.planned_end ?? null,
    calendar_event_id: row.calendar_event_id ?? null,
    calendar_event_etag: row.calendar_event_etag ?? null,
    freeze_until: row.freeze_until ?? null,
    plan_id: row.plan_id ?? null,
  };
}

function mergeSchedulingNotes(
  existing: string | null | undefined,
  note: string,
  explanation?: ScheduleExplanation,
) {
  const trimmed = note.trim();
  if (!trimmed && !explanation) return existing ?? null;
  const timestamp = new Date().toISOString();
  const nextFields: Record<string, unknown> = {
    schedule_note_at: timestamp,
  };
  if (trimmed) nextFields.schedule_note = trimmed;
  if (explanation) nextFields.schedule_explanation = explanation;
  if (!existing) {
    return JSON.stringify(nextFields);
  }
  try {
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({
        ...(parsed as Record<string, unknown>),
        ...nextFields,
      });
    }
  } catch {
    // ignore malformed notes payload
  }
  return JSON.stringify({
    previous_note: existing,
    ...nextFields,
  });
}

function slotMatchesTarget(slot: PreferredSlot, target: PreferredSlot | null, toleranceMinutes = 5) {
  if (!target) return false;
  const delta = Math.abs(slot.start.getTime() - target.start.getTime());
  return delta <= toleranceMinutes * 60_000;
}

function buildScheduleExplanation(args: {
  plan: SchedulingPlan;
  slot: PreferredSlot;
  capturePriority: number;
  durationMinutes: number;
  enforceWorkingWindow: boolean;
  resolvedDeadline: Date | null;
  preferredSlot: PreferredSlot | null;
  decisionPath: string[];
  flags?: ExplanationFlags;
}): ScheduleExplanation {
  const reasons: string[] = [];
  const { plan, flags } = args;

  if (flags?.late) {
    reasons.push("Scheduled after the deadline because late scheduling was allowed.");
  }
  if (flags?.overlapped) {
    reasons.push("Overlap allowed; scheduled alongside another DiaGuru task.");
  }
  if (flags?.preempted) {
    reasons.push("Rebalanced lower-priority DiaGuru sessions to make room.");
  }

  if (plan.mode === "start") {
    if (flags?.usedPreferred) {
      reasons.push("Scheduled at your requested start time.");
    } else if (flags?.usedStartTolerance) {
      reasons.push("Scheduled near your requested start time.");
    } else {
      reasons.push("Scheduled based on your requested start time.");
    }
  } else if (plan.mode === "window") {
    reasons.push("Scheduled within your requested window.");
  } else if (plan.mode === "deadline") {
    if (!flags?.late) {
      reasons.push("Scheduled before your deadline.");
    }
  } else {
    reasons.push("Scheduled in the next available slot.");
  }

  if (args.enforceWorkingWindow) {
    reasons.push("Within working hours.");
  }
  if (!flags?.overlapped) {
    reasons.push("Avoids existing calendar conflicts.");
  }

  const requestedStart = args.preferredSlot?.start?.toISOString() ?? null;
  const windowStart = plan.window?.start?.toISOString() ?? null;
  const windowEnd = plan.window?.end?.toISOString() ?? null;
  const deadline = args.resolvedDeadline?.toISOString() ?? null;

  return {
    mode: plan.mode,
    reasons,
    constraints: {
      workingHours: args.enforceWorkingWindow,
      bufferMinutes: BUFFER_MINUTES,
      windowStart,
      windowEnd,
      deadline,
      requestedStart,
    },
    priority: {
      score: Number(args.capturePriority.toFixed(3)),
      perMinute: Number((args.capturePriority / Math.max(args.durationMinutes, 1)).toFixed(3)),
    },
    decisionPath: args.decisionPath,
  };
}

function convertPlanActionForInsert(action: PlanActionRecord) {
  return {
    plan_id: action.planId,
    action_id: action.actionId,
    capture_id: action.captureId,
    capture_content: action.captureContent,
    action_type: action.actionType,
    prev_status: action.prev.status,
    prev_planned_start: action.prev.planned_start,
    prev_planned_end: action.prev.planned_end,
    prev_calendar_event_id: action.prev.calendar_event_id,
    prev_calendar_event_etag: action.prev.calendar_event_etag,
    prev_freeze_until: action.prev.freeze_until,
    prev_plan_id: action.prev.plan_id,
    next_status: action.next.status,
    next_planned_start: action.next.planned_start,
    next_planned_end: action.next.planned_end,
    next_calendar_event_id: action.next.calendar_event_id,
    next_calendar_event_etag: action.next.calendar_event_etag,
    next_freeze_until: action.next.freeze_until,
    next_plan_id: action.next.plan_id,
  };
}

function buildPlanSummary(planId: string, actions: PlanActionRecord[]) {
  return {
    id: planId,
    createdAt: new Date().toISOString(),
    actions: actions.map((action) => ({
      actionId: action.actionId,
      captureId: action.captureId,
      content: action.captureContent,
      actionType: action.actionType,
      previousStart: action.prev.planned_start,
      previousEnd: action.prev.planned_end,
      nextStart: action.next.planned_start,
      nextEnd: action.next.planned_end,
    })),
  };
}

function buildPlanSummaryText(actions: PlanActionRecord[]) {
  const scheduled = actions.filter((action) => action.actionType === "scheduled").length;
  const moved = actions.filter((action) => action.actionType === "rescheduled").length;
  const unscheduled = actions.filter((action) => action.actionType === "unscheduled").length;
  return `scheduled:${scheduled} moved:${moved} unscheduled:${unscheduled}`;
}

export function createGoogleCalendarActions(options: {
  credentials: CalendarClientCredentials;
  admin: SupabaseClient<Database, "public">;
  clientId: string;
  clientSecret: string;
}): GoogleCalendarActions {
  const { credentials, admin, clientId, clientSecret } = options;

  const run = async <T>(operation: (token: string) => Promise<T>): Promise<T> => {
    let refreshed = false;
    while (true) {
      try {
        const result = await operation(credentials.accessToken);
        await setCalendarReconnectFlag(admin, credentials.accountId, false);
        return result;
      } catch (error) {
        if (!refreshed && shouldAttemptTokenRefresh(error) && credentials.refreshToken) {
          const didRefresh = await refreshCalendarAccess({
            credentials,
            admin,
            clientId,
            clientSecret,
          });
          if (didRefresh) {
            refreshed = true;
            continue;
          }
        }

        if (isAuthError(error)) {
          await setCalendarReconnectFlag(admin, credentials.accountId, true);
          throw new ScheduleError("Google Calendar not linked", 400, error instanceof ScheduleError ? error.details : null);
        }
        throw error;
      }
    }
  };

  return {
    listEvents: (timeMin, timeMax) => run((token) => listCalendarEvents(token, timeMin, timeMax)),
    deleteEvent: (options) => run((token) => deleteCalendarEvent(token, options)),
    createEvent: (options) => run((token) => createCalendarEvent(token, options)),
    getEvent: (eventId) => run((token) => getCalendarEvent(token, eventId)),
  };
}

async function refreshCalendarAccess(args: {
  credentials: CalendarClientCredentials;
  admin: SupabaseClient<Database, "public">;
  clientId: string;
  clientSecret: string;
}): Promise<boolean> {
  const { credentials, admin, clientId, clientSecret } = args;
  const refreshToken = credentials.refreshToken;
  if (!refreshToken) return false;

  const refreshed = await refreshGoogleToken(refreshToken, clientId, clientSecret);
  if (!refreshed || typeof refreshed.access_token !== "string") {
    return false;
  }

  const nextRefreshToken =
    typeof refreshed.refresh_token === "string" && refreshed.refresh_token.trim().length > 0
      ? refreshed.refresh_token
      : refreshToken;

  credentials.accessToken = refreshed.access_token;
  credentials.refreshToken = nextRefreshToken;
  credentials.refreshed = true;

  const expiresIn =
    typeof refreshed.expires_in === "number" && Number.isFinite(refreshed.expires_in) && refreshed.expires_in > 0
      ? refreshed.expires_in
      : 3600;

  await persistCalendarToken(admin, {
    accountId: credentials.accountId,
    accessToken: credentials.accessToken,
    refreshToken: nextRefreshToken,
    expiresInSeconds: expiresIn,
  });

  return true;
}

async function persistCalendarToken(
  admin: SupabaseClient<Database, "public">,
  params: { accountId: number; accessToken: string; refreshToken: string | null; expiresInSeconds: number },
) {
  const expiryIso = new Date(Date.now() + Math.max(0, params.expiresInSeconds) * 1000).toISOString();
  const calendarTokens = admin.from("calendar_tokens") as unknown as {
    upsert: (
      values: {
        account_id: number;
        access_token: string;
        refresh_token: string | null;
        expiry: string;
      },
    ) => Promise<unknown>;
  };

  await calendarTokens.upsert({
    account_id: params.accountId,
    access_token: params.accessToken,
    refresh_token: params.refreshToken,
    expiry: expiryIso,
  });

  return expiryIso;
}

async function setCalendarReconnectFlag(
  admin: SupabaseClient<Database, "public">,
  accountId: number,
  needsReconnect: boolean,
) {
  try {
    await admin.from("calendar_accounts").update({ needs_reconnect: needsReconnect }).eq("id", accountId);
  } catch (error) {
    console.log("Failed to update reconnect flag", error);
  }
}

function shouldAttemptTokenRefresh(error: unknown) {
  return error instanceof ScheduleError && error.status === 401;
}

function isAuthError(error: unknown) {
  return error instanceof ScheduleError && (error.status === 401 || error.status === 403);
}



async function safeParse(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractGoogleError(payload: unknown) {
  if (!payload) return null;
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return null;

  const top = payload as Record<string, unknown>;
  if (typeof top.error === "string" && top.error.trim()) return top.error;
  if (top.error && typeof top.error === "object") {
    const nested = top.error as Record<string, unknown>;
    if (typeof nested.message === "string" && nested.message.trim()) return nested.message;
    if (Array.isArray(nested.errors) && nested.errors.length > 0) {
      const first = nested.errors[0] as Record<string, unknown>;
      if (typeof first.message === "string" && first.message.trim()) return first.message;
      if (typeof first.reason === "string" && first.reason.trim()) return first.reason;
    }
  }
  if (typeof top.message === "string" && top.message.trim()) return top.message;
  if (Array.isArray(top.errors) && top.errors.length > 0) {
    const first = top.errors[0] as Record<string, unknown>;
    if (typeof first.message === "string" && first.message.trim()) return first.message;
  }

  return null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Timezone helper functions


export const __test__ = {
  createGoogleCalendarActions,
};

export { ScheduleError, priorityForCapture };
