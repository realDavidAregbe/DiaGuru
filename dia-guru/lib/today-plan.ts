import type { Capture } from "./capture";

export type TodayPrimaryState = "now" | "up_next" | "check_in";

export type TodayPlan = {
  primary: Capture | null;
  primaryState: TodayPrimaryState | null;
  laterToday: Capture[];
};

type ScheduledWindow = {
  capture: Capture;
  start: number;
  end: number;
};

function toScheduledWindow(capture: Capture): ScheduledWindow | null {
  if (
    capture.status !== "scheduled" ||
    !capture.planned_start ||
    !capture.planned_end
  ) {
    return null;
  }

  const start = new Date(capture.planned_start).getTime();
  const end = new Date(capture.planned_end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  return { capture, start, end };
}

export function deriveTodayPlan(
  captures: Capture[],
  now = new Date(),
): TodayPlan {
  const nowMs = now.getTime();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const windows = captures
    .map(toScheduledWindow)
    .filter((window): window is ScheduledWindow => Boolean(window))
    .sort((a, b) => a.start - b.start);

  const active = windows.find(
    (window) => window.start <= nowMs && window.end > nowMs,
  );
  const overdue = windows
    .filter((window) => window.end <= nowMs)
    .sort((a, b) => b.end - a.end)[0];
  const upcomingToday = windows.filter(
    (window) => window.start > nowMs && window.start <= endOfToday.getTime(),
  );

  const primaryWindow = active ?? overdue ?? upcomingToday[0] ?? null;
  const primaryState: TodayPrimaryState | null = active
    ? "now"
    : overdue
      ? "check_in"
      : primaryWindow
        ? "up_next"
        : null;

  return {
    primary: primaryWindow?.capture ?? null,
    primaryState,
    laterToday: upcomingToday
      .filter((window) => window.capture.id !== primaryWindow?.capture.id)
      .map((window) => window.capture),
  };
}
