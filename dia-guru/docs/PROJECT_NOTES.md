# DiaGuru Project Notes

This document consolidates prior planning, progress, and debug notes into one place.

Archived source notes:
- DEV_NOTES.local.md
- dia_guru_implementation_plan.md
- PROGRESS.md
- WORKFLOW_DEBUG_MAP.md
- docs/PROGRESS-backup.md
- docs/ResearcherBrief.md

## Product Goal
DiaGuru is a personal planning assistant that captures what is on a user's mind, extracts structured task constraints, and schedules those tasks into Google Calendar automatically. The long-term goal is a personalized planner that learns from user behavior while staying reliable with deterministic scheduling fallbacks.

## Current System Snapshot
- Mobile app: Expo + React Native + Supabase auth and data.
- Parsing: `supabase/functions/parse-task` (Duckling + heuristic logic + optional DeepSeek follow-up for clarification).
- Scheduling: `supabase/functions/schedule-capture` (priority ranking, constraints, window checks, conflict handling, Google Calendar writes).
- Sync: `supabase/functions/sync-captures` to reconcile edits and state.
- Notifications: local reminder helpers and follow-up handling in app logic.

## Behavior and Design Intent
- Deterministic mode should ask for missing fields directly.
- Conversational mode may ask one short clarifying question when ambiguity exists.
- Scheduler should respect urgency, importance, time constraints, and realistic windows.
- Routine tasks (sleep/meals) should remain routine-aware and not dominate critical deliverables.

## Consolidated Implementation Plan

### 1) Instrumentation and Observability
- Keep structured logs for parse and schedule decisions.
- Log normalized constraints, chosen slot candidates, conflict reasons, and fallback decisions.
- Keep request/response summaries stable for easier regression diagnosis.

### 2) Routine Task Normalization
- Normalize sleep tasks to realistic night windows.
- Normalize meal tasks to mealtime windows.
- Keep routine overlap restrictions and routine priority scaling.
- Avoid auto-freezing routine tasks unless explicitly user-locked.

### 3) Time-of-Day Preference Enforcement
- Use morning/afternoon/evening/night bands when preferences are present.
- Try preferred windows first, then fall back with explicit penalty/trace.
- Ensure "tonight" and "before sleep" intent stays local-day aware.

### 4) Hard Deadline Handling
- Improve emergency handling for near-term hard deadlines.
- Revisit preemption candidate selection so urgent tasks can reclaim time from lower-priority movable items.
- Return clear outcomes when a deadline is already missed, with optional late scheduling path.

### 5) Priority and Preemption Tuning
- Keep routine priority caps/scalers.
- Fold overlap soft-cost and churn penalties into net-gain decisions.
- Limit excessive task shuffling in one run while preserving urgent recovery.

### 6) Multi-Chunk and Packing Enhancements
- Expand splitting/EDF-style placement for long tasks.
- Enforce chunk constraints and min chunk size while preserving deadline constraints.

### 7) UX and Reporting
- Keep plan summaries concise and actionable.
- Show meaningful reschedule reasons and late-placement context.
- Surface reconnect and calendar health states clearly.

## Known Scheduling/Parsing Gaps
- Some night-intent tasks can still be placed outside preferred periods under pressure.
- Preemption remains conservative in certain ripple scenarios.
- Missed hard deadline flows need clearer user-facing decisions.
- Complex conflict resolution still needs stronger deterministic + optional LLM arbitration boundaries.

## Debug Workflow (Condensed)
1. Confirm parse output in `capture_entries` (`constraint_type`, windows, `task_type_hint`, flexibility flags).
2. Confirm normalization in `schedule-capture` logs before slot search.
3. Inspect computed scheduling window and busy intervals.
4. Validate conflict reason (`preferred_conflict`, `slot_exceeds_deadline`, `no_slot`) and fallback candidates.
5. Verify persistence updates (`planned_start`, `planned_end`, `calendar_event_id`, status).

## Working Commands
- `npm run typecheck`
- `npm test`
- `npm run deno:test`
- `npm run deno:test:live:schedule-capture`
- `npm run validate`

## Notes on Environment and Live Pipeline
- Live pipeline tests read env vars from `supabase/functions/.env` when using the provided npm script.
- Prefer rotating API keys via env updates only; avoid hardcoding keys in scripts.

## Next Practical Priorities
1. Finish general time-of-day enforcement for non-routine tasks.
2. Strengthen hard-deadline preemption and missed-deadline UX.
3. Expand regression fixtures around sleep/night windows and urgent conflicts.
4. Keep logs focused and stable for easier root-cause analysis.