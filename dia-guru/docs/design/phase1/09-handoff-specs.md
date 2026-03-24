# 09 Handoff Specs

This page captures implementation-facing details for later build phases.

## Route and Frame Mapping

- `/(auth)/sign-in` -> `AUTH-*`
- `/(tabs)/index` -> `HOME-*`
- `/(tabs)/calendar` -> `CAL-*`
- `/(tabs)/profile` -> `PROF-*`
- `/(tabs)/settings` -> `SET-*`
- iOS activity/widget surfaces -> `LA-*`, `WID-*`

## New Public Interface Contracts (for Later Build Phase)

```ts
export type LiveSessionState = {
  captureId: string;
  title: string;
  plannedStart: string;
  plannedEnd: string;
  status: "not_started" | "in_progress" | "awaiting_check_in" | "completed";
  progressPercent: number;
  remainingMinutes: number;
  canComplete: boolean;
  canReschedule: boolean;
};

export type QuickCaptureSource = "app_quick_add" | "widget" | "home_capture";

export type QuickCaptureInput = {
  source: QuickCaptureSource;
  prefillText?: string;
  estimatedMinutes?: number;
  importance?: 1 | 2 | 3;
};

export type LiveActivityActionPayload = {
  captureId: string;
  action: "complete" | "reschedule";
};
```

Deep links:
- `diaguru://capture/new?source=app_quick_add|widget|home_capture`
- `diaguru://session/checkin?id={captureId}`

UI presentation extension:
- Add UI-only display statuses:
  - `in_progress`
  - explicit `awaiting_check_in`

## Engineering Notes by Area

### Global Quick-Add

- Add persistent FAB overlay in tab shell.
- Open shared capture sheet from all tabs.
- Ensure source tagging is passed to capture handler.

### Conflict UX

- Replace alert-heavy conflict flow with bottom sheet component.
- Preserve existing action semantics:
  - overlap
  - rebalance/make room
  - auto decide
  - cancel

### Why This Time

- Move reason display to sheet/modal pattern.
- Keep extracted reasons and fallback text behavior.

### Live Activity

- Map scheduled/in-progress captures to activity state.
- Provide complete/reschedule action hooks.

### Widgets

- Small: one-tap capture.
- Medium: one-tap capture + next session and queue count.

## Phase 2 Build Notes (Native Requirements)

1. Add iOS targets/extensions:
   - ActivityKit Live Activity extension
   - WidgetKit extension
2. Define shared model bridge between React Native app and native extensions.
3. Support deep-link handling for:
   - capture sheet launch
   - session check-in target
4. Determine update channel for live progress:
   - local timer + app state
   - push update path for background changes (if needed)
5. Validate App Store/TestFlight entitlement and provisioning for Live Activities and widgets.

## Handoff Deliverables Checklist

- Component variants documented and named
- Tokens bound to components
- All required states represented
- Prototype flows connected
- QA checklist completed
- Frame IDs stable for engineering reference

