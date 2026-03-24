# 01 Components

All components below are required for Phase 1. Build them as reusable Figma components with variants.

## Navigation

### `TabBar/Bottom`

Variants:
- `state:default`
- `state:keyboard-hidden`

Slots:
- Home
- Calendar
- Profile
- Settings

Rules:
- Keep 4-tab architecture.
- Active tab color: `Action/Primary`.
- Inactive tab color: `Text/Muted`.

### `QuickAdd/FAB`

Variants:
- `state:rest`
- `state:pressed`
- `state:disabled`

Specs:
- Size: `56x56`
- Position: fixed bottom-right, `16` from edges above tab bar
- Icon: `+`
- Label (optional in prototype overlay): `Quick add`

## Buttons

### `Button/Primary`

Variants:
- `size:md|lg`
- `state:default|pressed|loading|disabled`

### `Button/Secondary`

Variants:
- `size:md|lg`
- `state:default|pressed|disabled`

### `Button/Tertiary`

Variants:
- `state:default|pressed|disabled`

### `Button/InlineLink`

Variants:
- `tone:primary|danger|warning`

Use for:
- "Why this time?"
- "Calendar tips and actions"
- Retry/check actions

## Inputs

### `Input/TextField`

Variants:
- `state:default|focused|error|disabled`
- `withLabel:true|false`
- `withHelper:true|false`

Use for:
- Email, password, username, website

### `Input/TextArea`

Variants:
- `state:default|focused|error|disabled`
- `rows:3|5`

Use for:
- Home capture text

### `Input/NumberField`

Variants:
- `state:default|focused|error|disabled`

Use for:
- Estimated minutes

## Selection

### `Chip/Importance`

Variants:
- `value:low|medium|high`
- `state:selected|unselected|disabled`

### `Chip/Mode`

Variants:
- `state:selected|unselected|disabled`

Use for:
- Assistant mode display

## Cards

### `Card/Section`

Variants:
- `tone:default|info|warning|error`

### `Card/CaptureQueueItem`

Variants:
- `rank:1|2|3|other`
- `state:default`

Fields:
- Rank
- Title
- Importance label
- Duration text

### `Card/ScheduledItem`

Variants:
- `mode:overdue|upcoming`
- `state:default|action-loading`

Actions:
- `Completed`
- `Reschedule`
- `Why this time?`

### `Card/PlanChangeSummary`

Variants:
- `state:default|undo-loading|lock-loading`

### `Card/Event`

Variants:
- `source:diaguru|external`

Fields:
- Event title
- Time range
- `DG` badge for DiaGuru events

### `Card/WidgetSmall` and `Card/WidgetMedium`

Variants:
- `state:default|empty`

## Banners + Notices

### `Banner/CalendarHealth`

Variants:
- `status:healthy(hidden)|needs-reconnect|check-failed`
- `state:idle|checking`

Actions:
- `Reconnect`
- `Check again`
- `Try again`

### `Banner/StatusInline`

Variants:
- `tone:success|warning|error|info`

## Overlays

### `Modal/FollowUpQuestion`

Variants:
- `state:default|sending|input-error`

Fields:
- Prompt
- Missing fields helper
- Answer input
- Actions: Cancel / Send

### `Sheet/SchedulingConflict`

Variants:
- `state:default|action-loading`

Actions:
- `Overlap anyway`
- `Make room`
- `Let DiaGuru decide`
- `Cancel`

## List + Utility

### `Row/ChunkSummary`

Variants:
- `flags:none|late|overlapped|prime|mixed`

### `Progress/Task`

Variants:
- `state:not-started|in-progress|awaiting-check-in|completed`

Use for:
- Live Activity
- Widget medium status strip

## Accessibility Notes per Component

- All actionable components must meet `44x44`.
- Disabled state must remain legible and still meet context clarity.
- Focus style for inputs and buttons must be visible against all backgrounds.
- Semantic colors are always paired with icon/text labels.

