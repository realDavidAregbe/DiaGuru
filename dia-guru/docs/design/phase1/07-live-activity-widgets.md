# 07 Live Activity + Widgets

This page defines forward-compatible iOS surfaces for quick glance and one-tap capture.

## Live Activity Spec

Primary model:
- Current task progress only

### Data Contract for Design Binding

`LiveSessionState = { captureId, title, plannedStart, plannedEnd, status, progressPercent, remainingMinutes, canComplete, canReschedule }`

### Required States

1. `LA-01 Not Started`
2. `LA-02 In Progress`
3. `LA-03 Awaiting Check-In`
4. `LA-04 Completed/Ended`

### Lock Screen Layout

Frame: `LA-LS-01`

Elements:
- Task title (2 lines max)
- Time range label
- Horizontal progress bar
- Remaining minutes
- Primary quick action:
  - `Complete` when allowed
  - `Reschedule` when needed

### Dynamic Island

Frames:
- `LA-DI-Compact-01`
- `LA-DI-Minimal-01`
- `LA-DI-Expanded-01`

Compact:
- Progress ring + remaining minutes

Minimal:
- Single progress glyph

Expanded:
- Title
- Progress
- Action buttons (`Complete`, `Reschedule`)

### Interaction Targets

- Tap activity -> open app deep link:
  - `diaguru://session/checkin?id={captureId}`

## Widget Spec

Widget family:
- Small widget: single primary action
- Medium widget: primary action + schedule preview

### Small Widget

Frame: `WID-S-01`

Elements:
- Quick capture icon/button
- Label: `Capture now`
- Secondary text: `One tap to schedule`

Tap action:
- `diaguru://capture/new?source=widget`

### Medium Widget

Frame: `WID-M-01`

Elements:
- Primary quick capture action
- Next session summary:
  - title
  - start time
- Queue count pill:
  - `N waiting`

Tap actions:
- Primary area -> quick capture deep link
- Session chip -> open Home scheduled section anchor (future enhancement)

## Widget Behavior Rules

- Default behavior must not require typing inside widget.
- Widget always launches in-app quick capture sheet with keyboard focus.
- Source tagging for analytics and routing:
  - `source = "widget"`

## Visual Rules

- Use high-contrast text for lock screen readability.
- Keep progress color in primary blue family.
- Show state labels (not color alone) for accessibility.

