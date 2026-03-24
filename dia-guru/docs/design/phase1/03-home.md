# 03 Home

Route source:
- `/(tabs)/index`

This is the most state-heavy screen. Build all states below.

## Core Information Architecture

1. Calendar health notice (conditional)
2. Today changed summary card (conditional)
3. Last scheduled chunks card (conditional)
4. Capture composer section
5. Queue preview section
6. Scheduled section
7. Global quick-add floating button (new)

## Base Frames

1. `HOME-01 Default Populated`
2. `HOME-02 Empty Queue + Empty Scheduled`
3. `HOME-03 Pending Loading`
4. `HOME-04 Pending Error`
5. `HOME-05 Scheduled Loading`
6. `HOME-06 Scheduled Error`
7. `HOME-07 Pull To Refresh`

## Conditional Blocks

### Calendar Health Notice

States:
- `healthy` (hidden)
- `needs_reconnect` (warning banner with reconnect/check actions)
- `check_failed` (error banner with retry action)

### Today Changed Card

States:
- default summary with action rows
- locking state for individual capture
- undo loading state

Actions:
- `Dismiss`
- `Got it`
- `Undo plan`
- `Lock`

### Last Scheduled Chunks

States:
- hidden when no recent chunks
- list rows with flags (`Late`, `Overlapped`, `Prime`, `Background`)
- optional overlap budget footer

## Capture Composer

Fields:
- Capture text area (`What needs your attention?`)
- Estimated minutes number input
- Importance chips (`Low`, `Medium`, `High`)
- Primary CTA: `Save and auto-schedule`

States:
- default
- submitting
- validation error
- save failure

## Queue Preview

States:
- empty: `"You're clear for now. Add the next thing above."`
- populated: top 3 ranked cards + `+N more` text
- loading/error variants

Actions:
- `Re-run Scheduling` button (disabled while scheduling)

## Scheduled Section

Subsections:
- `Needs check-in` (overdue scheduled captures)
- `Upcoming` (future scheduled captures)

Each overdue card:
- content/title
- date-time range
- `Completed`
- `Reschedule`
- `Why this time?`

Each upcoming card:
- content/title
- date-time range
- `Why this time?`

## New UX Additions in This Phase

### Global Quick-Add FAB

- Persistent on Home and all tabs.
- Opens `HOME-QUICKADD-01 Capture Sheet`.

### Scheduling Conflict Sheet (replaces alert style in UX)

Frame: `HOME-CONFLICT-01`

Contains:
- conflict summary
- conflicted blocks preview
- suggested slot
- action buttons:
  - `Overlap anyway`
  - `Make room`
  - `Let DiaGuru decide`
  - `Cancel`

### Why This Time Sheet

Frame: `HOME-WHY-01`

Contains:
- ranked schedule reasons list
- extracted constraints summary
- reminder that user can reschedule

### DeepSeek Follow-Up Modal

Frame: `HOME-FOLLOWUP-01`

Contains:
- prompt title: `DeepSeek asks`
- missing fields helper
- numeric response input
- actions: `Cancel`, `Send`

States:
- input empty error
- parsing failure
- sending

## Quick Capture Sheet (Global Entry)

Frames:
- `HOME-QUICKADD-01 Default`
- `HOME-QUICKADD-02 Keyboard Active`
- `HOME-QUICKADD-03 Submitting`
- `HOME-QUICKADD-04 Success`

Behavior:
- Opens from FAB or widget deep link.
- Auto-focus text input.
- Source tagging in handoff notes:
  - `app_quick_add`
  - `widget`
  - `home_capture`

## Pull To Refresh

Frame: `HOME-REFRESH-01`

State cues:
- loading indicator at top
- temporary disabled schedule actions

