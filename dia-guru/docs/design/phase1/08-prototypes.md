# 08 Prototypes

Build core clickable prototype flows using the frame IDs below.

## Flow 1: First Run Auth to Home

Start:
- `AUTH-01 Sign In`

Path:
1. Sign in success -> `HOME-01 Default Populated` or `HOME-02 Empty Queue + Empty Scheduled`
2. Sign up -> `AUTH-04 Sign Up`
3. Sign up no immediate session -> `AUTH-05 Email Verification Notice`

## Flow 2: Home Quick Capture to Auto-Schedule Success

Start:
- `HOME-01 Default Populated`

Path:
1. Enter capture + minutes + importance
2. Tap `Save and auto-schedule`
3. Loading state -> success micro-feedback
4. Scheduled item appears in upcoming section

## Flow 3: Home Capture to DeepSeek Follow-Up

Start:
- `HOME-01`

Path:
1. Enter capture without duration
2. Submit
3. `HOME-FOLLOWUP-01` opens
4. Enter numeric answer
5. Send -> success -> scheduled state update

## Flow 4: Scheduling Conflict Decision Sheet

Start:
- `HOME-CONFLICT-01`

Actions:
1. `Overlap anyway` -> conflict resolved state
2. `Make room` -> rebalanced schedule state
3. `Let DiaGuru decide` -> auto-resolution state
4. `Cancel` -> back to previous Home state

## Flow 5: Scheduled Check-In

Start:
- `HOME-01` with overdue card

Paths:
1. Tap `Completed` -> card removed from overdue list
2. Tap `Reschedule` -> rescheduled outcome and card moves to upcoming
3. Tap `Why this time?` -> `HOME-WHY-01`

## Flow 6: Widget Tap to In-App Capture Sheet

Start:
- `WID-S-01` and `WID-M-01`

Path:
1. Tap quick capture action
2. Open `HOME-QUICKADD-01`
3. Keyboard active -> `HOME-QUICKADD-02`

## Flow 7: Live Activity Tap to Check-In Target

Start:
- `LA-LS-01` or `LA-DI-Expanded-01`

Path:
1. Tap activity/action
2. Open app via `diaguru://session/checkin?id=...`
3. Land on Home with relevant overdue card focused

## Prototype Quality Rules

- Use smart animate only for meaningful transitions.
- Keep transition timings from motion tokens.
- Every action path in conflict and check-in flows must be clickable.
- Keep one branch per decision outcome for QA walkthrough.

