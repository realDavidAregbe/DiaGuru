import type { Capture } from "../capture";
import { deriveTodayPlan } from "../today-plan";

function scheduledCapture(
  id: string,
  start: string,
  end: string,
): Capture {
  return {
    id,
    user_id: "user-1",
    content: `Task ${id}`,
    estimated_minutes: 30,
    importance: 2,
    status: "scheduled",
    scheduled_for: start,
    planned_start: start,
    planned_end: end,
    calendar_event_id: null,
    calendar_event_etag: null,
    last_check_in: null,
    scheduling_notes: null,
    extraction_json: null,
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
    externality_score: 0,
    reschedule_count: 0,
    task_type_hint: null,
    freeze_until: null,
    plan_id: null,
    manual_touch_at: null,
    created_at: start,
    updated_at: start,
    priorityScore: 0,
  };
}

describe("deriveTodayPlan", () => {
  const now = new Date("2026-07-13T18:00:00-05:00");

  it("puts an active task first and keeps only later tasks from today", () => {
    const plan = deriveTodayPlan(
      [
        scheduledCapture(
          "active",
          "2026-07-13T17:45:00-05:00",
          "2026-07-13T18:15:00-05:00",
        ),
        scheduledCapture(
          "later",
          "2026-07-13T20:00:00-05:00",
          "2026-07-13T20:30:00-05:00",
        ),
        scheduledCapture(
          "tomorrow",
          "2026-07-14T09:00:00-05:00",
          "2026-07-14T09:30:00-05:00",
        ),
      ],
      now,
    );

    expect(plan.primary?.id).toBe("active");
    expect(plan.primaryState).toBe("now");
    expect(plan.laterToday.map((capture) => capture.id)).toEqual(["later"]);
  });

  it("uses the next task when nothing is active", () => {
    const plan = deriveTodayPlan(
      [
        scheduledCapture(
          "next",
          "2026-07-13T19:00:00-05:00",
          "2026-07-13T19:30:00-05:00",
        ),
        scheduledCapture(
          "later",
          "2026-07-13T21:00:00-05:00",
          "2026-07-13T21:30:00-05:00",
        ),
      ],
      now,
    );

    expect(plan.primary?.id).toBe("next");
    expect(plan.primaryState).toBe("up_next");
    expect(plan.laterToday.map((capture) => capture.id)).toEqual(["later"]);
  });

  it("surfaces the most recent past task for confirmation", () => {
    const plan = deriveTodayPlan(
      [
        scheduledCapture(
          "older",
          "2026-07-13T15:00:00-05:00",
          "2026-07-13T15:30:00-05:00",
        ),
        scheduledCapture(
          "recent",
          "2026-07-13T17:00:00-05:00",
          "2026-07-13T17:30:00-05:00",
        ),
      ],
      now,
    );

    expect(plan.primary?.id).toBe("recent");
    expect(plan.primaryState).toBe("check_in");
  });

  it("returns a completed-day state when nothing remains", () => {
    const plan = deriveTodayPlan([], now);

    expect(plan).toEqual({
      primary: null,
      primaryState: null,
      laterToday: [],
    });
  });
});
