import type { CaptureEntryRow } from "../types.ts";
import { computeCapturePrioritySnapshot } from "./priority-model.ts";

type SchedulerConfig = {
  workingWindow: { startHour: number; endHour: number };
  rigidity: {
    reschedulePenaltyWeight: number;
    rescheduleCountWeight: number;
    hardDeadlineWeight: number;
    slackWeight: number;
    cannotOverlapWeight: number;
    durationFixedWeight: number;
    startHardWeight: number;
    urgencyWeight: number;
    impactWeight: number;
    blockingWeight: number;
    protectedTaskBonuses: {
      appointment: number;
      deepWork: number;
      health: number;
      routineMeal: number;
      routineSleep: number;
    };
  };
  fragmentation: {
    coefficient: number;
  };
  preemption: {
    baseThreshold: number;
    movePenalty: number;
    gainPerMinuteThreshold: number;
    priorityBenefitScale: number;
  };
  limits: {
    maxMovedTasksPerRun: number;
    maxRippleDepth: number;
    maxTotalMinutesShifted: number;
  };
  chunking: {
    targetChunkMinutes: number;
  };
  overlap: {
    enabled: boolean;
    maxConcurrency: number;
    dailyBudgetMinutes: number;
    perTaskOverlapFraction: number;
    softCostPerMinute: number;
  };
  timeOfDayDefaults: Record<string, { start: number; end: number }[]>;
};

export const schedulerConfig: SchedulerConfig = {
  workingWindow: { startHour: 8, endHour: 22 },
  rigidity: {
    reschedulePenaltyWeight: 20,
    rescheduleCountWeight: 10,
    hardDeadlineWeight: 15,
    slackWeight: 15,
    cannotOverlapWeight: 10,
    durationFixedWeight: 10,
    startHardWeight: 5,
    urgencyWeight: 4,
    impactWeight: 2,
    blockingWeight: 8,
    protectedTaskBonuses: {
      appointment: 28,
      deepWork: 12,
      health: 24,
      routineMeal: 38,
      routineSleep: 40,
    },
  },
  fragmentation: {
    coefficient: 2,
  },
  preemption: {
    baseThreshold: 12,
    movePenalty: 4,
    gainPerMinuteThreshold: 0.08,
    priorityBenefitScale: 40,
  },
  limits: {
    maxMovedTasksPerRun: 5,
    maxRippleDepth: 2,
    maxTotalMinutesShifted: 240,
  },
  chunking: {
    targetChunkMinutes: 60,
  },
  overlap: {
    enabled: true,
    maxConcurrency: 2,
    dailyBudgetMinutes: 90,
    perTaskOverlapFraction: 0.5,
    softCostPerMinute: 0.03,
  },
  timeOfDayDefaults: {
    deep_work: [{ start: 8, end: 12 }],
    admin: [{ start: 13, end: 17 }],
    creative: [{ start: 10, end: 15 }],
    errand: [{ start: 12, end: 18 }],
    health: [{ start: 6, end: 9 }, { start: 17, end: 20 }],
    social: [{ start: 18, end: 22 }],
    collaboration: [{ start: 9, end: 17 }],
    "routine.sleep": [{ start: 22, end: 31 }], // 22:00 -> 07:00 next day
    "routine.meal": [
      { start: 7.5, end: 9.5 }, // breakfast
      { start: 12, end: 14 }, // lunch
      { start: 18, end: 20 }, // dinner
    ],
  },
};

const MS_PER_MINUTE = 60 * 1000;

const clamp01 = (value: number) => {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

const getDeadlineDate = (capture: CaptureEntryRow): Date | null => {
  const candidates: (string | null)[] = [
    capture.deadline_at,
    capture.window_end,
    capture.constraint_end,
  ];

  if (capture.constraint_type === "deadline_time" && capture.constraint_time) {
    candidates.push(capture.constraint_time);
  }

  for (const iso of candidates) {
    if (!iso) continue;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
};

const getEstimatedMinutes = (capture: CaptureEntryRow) => {
  const value = capture.estimated_minutes ?? 30;
  return Math.max(5, Math.min(8 * 60, value));
};

export type PrioritySnapshot = {
  baseScore: number;
  durationMinutes: number;
  routineKind: string | null;
  score: number;
  perMinute: number;
  components: {
    aging: number;
    deadline: number;
    durationPenalty: number;
    externality: number;
    importance: number;
    reschedulePenalty: number;
    window: number;
  };
};

export function computePrioritySnapshot(
  capture: CaptureEntryRow,
  referenceNow: Date,
): PrioritySnapshot {
  const snapshot = computeCapturePrioritySnapshot(capture, referenceNow);

  return {
    baseScore: snapshot.baseScore,
    durationMinutes: snapshot.durationMinutes,
    routineKind: snapshot.routineKind,
    score: snapshot.score,
    perMinute: snapshot.perMinute,
    components: snapshot.components,
  };
}

export function computeRigidityScore(
  capture: CaptureEntryRow,
  referenceNow: Date,
) {
  const config = schedulerConfig.rigidity;
  const slackDeadline = getDeadlineDate(capture);
  const minutes = getEstimatedMinutes(capture);
  let slackComponent = 0;
  if (slackDeadline) {
    const slackMinutes = slackDeadline.getTime() - referenceNow.getTime();
    const slack = slackMinutes / MS_PER_MINUTE - minutes;
    slackComponent = config.slackWeight * clamp01((minutes - slack) / minutes);
  }

  const hint = capture.task_type_hint?.toLowerCase() ?? "";
  const text = capture.content?.toLowerCase() ?? "";
  let protectedTaskBonus = 0;
  if (hint.includes("routine.sleep") || /\bsleep|bed ?time|night routine\b/.test(text)) {
    protectedTaskBonus = config.protectedTaskBonuses.routineSleep;
  } else if (
    hint.includes("routine.meal") ||
    /\b(breakfast|lunch|dinner|meal|eat)\b/.test(text)
  ) {
    protectedTaskBonus = config.protectedTaskBonuses.routineMeal;
  } else if (hint.includes("appointment")) {
    protectedTaskBonus = config.protectedTaskBonuses.appointment;
  } else if (hint.includes("health")) {
    protectedTaskBonus = config.protectedTaskBonuses.health;
  } else if (hint.includes("deep_work")) {
    protectedTaskBonus = config.protectedTaskBonuses.deepWork;
  }

  return (
    (capture.reschedule_penalty ?? 0) * config.reschedulePenaltyWeight +
    (capture.reschedule_count ?? 0) * config.rescheduleCountWeight +
    (capture.deadline_at ? config.hardDeadlineWeight : 0) +
    slackComponent +
    (capture.cannot_overlap ? config.cannotOverlapWeight : 0) +
    (capture.duration_flexibility === "fixed"
      ? config.durationFixedWeight
      : 0) +
    (capture.start_flexibility === "hard" ? config.startHardWeight : 0) +
    (capture.urgency ?? 0) * config.urgencyWeight +
    (capture.impact ?? 0) * config.impactWeight +
    (capture.blocking ? config.blockingWeight : 0) +
    protectedTaskBonus
  );
}

export function computeRescheduleCost(
  capture: CaptureEntryRow,
  minutesMoved: number,
  referenceNow: Date,
) {
  const rigidity = computeRigidityScore(capture, referenceNow);
  const ratio = minutesMoved / getEstimatedMinutes(capture);
  const base = ratio * rigidity;
  const fragmentation = schedulerConfig.fragmentation.coefficient *
    Math.sqrt(Math.max(1, minutesMoved));
  return base + fragmentation;
}

export function logSchedulerEvent(
  event: string,
  payload: Record<string, unknown>,
) {
  try {
    console.log(`[dg.schedule] ${event}`, payload);
  } catch {
    // no-op
  }
}

export type PreemptionDisplacement = {
  capture: CaptureEntryRow;
  minutes: number;
};

export type NetGainEvaluation = {
  targetPriority: {
    score: number;
    perMinute: number;
  };
  benefit: number;
  cost: number;
  overlapCost: number;
  net: number;
  perMinuteGain: number;
  movedTasks: number;
  totalDisplacedMinutes: number;
  thresholds: {
    base: number;
    gainPerMinute: number;
    movePenalty: number;
  };
  meetsBaseThreshold: boolean;
  meetsGainPerMinuteThreshold: boolean;
  allowed: boolean;
  limitChecks: {
    exceedsTaskCap: boolean;
    exceedsMinuteCap: boolean;
    maxMovedTasks: number;
    maxMinutesShifted: number;
  };
};

export function evaluatePreemptionNetGain(args: {
  target: CaptureEntryRow;
  displacements: PreemptionDisplacement[];
  minutesClaimed: number;
  referenceNow: Date;
  overlapMinutes?: number;
}): NetGainEvaluation {
  const minutesClaimed = Math.max(1, args.minutesClaimed);
  const priority = computePrioritySnapshot(args.target, args.referenceNow);
  const benefit = priority.perMinute * minutesClaimed *
    schedulerConfig.preemption.priorityBenefitScale;

  let cost = 0;
  let totalDisplacedMinutes = 0;
  for (const displacement of args.displacements) {
    const minutes = Math.max(0, displacement.minutes);
    if (minutes === 0) continue;
    totalDisplacedMinutes += minutes;
    cost += computeRescheduleCost(
      displacement.capture,
      minutes,
      args.referenceNow,
    );
  }

  const overlapCostMinutes = Math.max(0, args.overlapMinutes ?? minutesClaimed);
  const overlapSoftCost = schedulerConfig.overlap.softCostPerMinute *
    overlapCostMinutes;

  const net = benefit - cost - overlapSoftCost;
  const perMinuteGain = minutesClaimed > 0 ? net / minutesClaimed : 0;
  const movedTasks = args.displacements.length;
  const thresholds = {
    base: schedulerConfig.preemption.baseThreshold +
      schedulerConfig.preemption.movePenalty * movedTasks,
    gainPerMinute: schedulerConfig.preemption.gainPerMinuteThreshold,
    movePenalty: schedulerConfig.preemption.movePenalty,
  };
  const meetsBaseThreshold = net >= thresholds.base;
  const meetsGainPerMinuteThreshold = perMinuteGain >= thresholds.gainPerMinute;
  const limitChecks = {
    exceedsTaskCap: movedTasks > schedulerConfig.limits.maxMovedTasksPerRun,
    exceedsMinuteCap:
      totalDisplacedMinutes > schedulerConfig.limits.maxTotalMinutesShifted,
    maxMovedTasks: schedulerConfig.limits.maxMovedTasksPerRun,
    maxMinutesShifted: schedulerConfig.limits.maxTotalMinutesShifted,
  };
  const allowed = meetsBaseThreshold && meetsGainPerMinuteThreshold &&
    !limitChecks.exceedsTaskCap && !limitChecks.exceedsMinuteCap;

  return {
    targetPriority: {
      score: priority.score,
      perMinute: priority.perMinute,
    },
    benefit,
    cost,
    overlapCost: overlapSoftCost,
    net,
    perMinuteGain,
    movedTasks,
    totalDisplacedMinutes,
    thresholds,
    meetsBaseThreshold,
    meetsGainPerMinuteThreshold,
    allowed,
    limitChecks,
  };
}
