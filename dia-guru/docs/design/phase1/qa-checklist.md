# Phase 1 QA Checklist

Use this checklist for design QA now and implementation QA later.

## Product Scenarios

1. Empty account with no captures and no calendar link
   - Expected: Home empty states plus reconnect guidance where relevant.
2. Calendar linked but reconnect required
   - Expected: warning banner with reconnect/check actions.
3. Capture with explicit minutes and immediate scheduling
   - Expected: smooth success state and scheduled preview update.
4. Capture without minutes requiring DeepSeek clarification
   - Expected: follow-up modal with numeric answer path.
5. Conflict requiring overlap or rebalance decision
   - Expected: conflict sheet with all four actions.
6. Overdue scheduled task requiring confirmation
   - Expected: `Completed` and `Reschedule` actions visible and clear.
7. Queue rerun scheduling while scheduling is active
   - Expected: rerun button disabled + loading affordance.
8. Calendar list with mixed DiaGuru and external events
   - Expected: DG badge only where applicable.
9. Profile Google linking success/failure/refresh
   - Expected: status transitions are explicit and action labels update.
10. Notification permission denied then re-requested
    - Expected: permission status copy and action flow clarity.
11. Live Activity progress at start, midpoint, near completion
    - Expected: state labels and progress display remain legible.
12. Widget quick capture from lock screen and home screen
    - Expected: deep link opens capture sheet with source tag.
13. Accessibility checks for contrast/type scaling/tap targets
    - Expected: WCAG AA contrast and >=44x44 targets across critical actions.

## UI Quality Checks

- Spacing uses 4pt token system only.
- Card/header/button radius uses defined radius tokens only.
- Text styles use tokenized type scale only.
- Icon sizes are consistent by role.
- Error and warning states include text labels, not color only.

## Prototype Checks

- Every flow listed in `08-prototypes.md` is connected.
- Conflict sheet actions all navigate to distinct outcomes.
- Widget and Live Activity tap routes are represented.

