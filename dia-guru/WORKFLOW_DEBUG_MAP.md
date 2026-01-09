# Sleep Routine Scheduling Workflow & Debug Map

## Complete Flow: "Sleep tonight" → Scheduled Event

### 1. USER INPUT
```
User types: "Sleep tonight"
Location: app/(tabs)/index.tsx
```

### 2. PARSE-TASK FUNCTION
**File:** `supabase/functions/parse-task/index.ts`

**What happens:**
- Calls DeepSeek API to extract structured data
- Detects "sleep" keyword → triggers `normalizeSleepExtraction()` (line 932)
- Creates default execution window using `buildZonedDateTime()` (line 962-980):
  - Start: 22:00 local time
  - End: 07:30 next day local time
- Maps to capture via `mapExtractionToCapture()` (line 835)
- **PROBLEM AREA:** Lines 864-865 set `window_start = constraint_time` when constraint_type is "start_time"

**Output:**
```json
{
  "constraint_type": "start_time",
  "constraint_time": "2025-11-21T22:00:00-06:00",
  "task_type_hint": "routine.sleep",
  "window_start": null,  // These should be set by parse-task but aren't for start_time
  "window_end": null
}
```

**CHECK HERE:**
- Line 864: Does it set window_start for sleep tasks?
- Line 932-986: Does normalizeSleepExtraction run before mapExtractionToCapture?

---

### 3. CAPTURE CREATED IN DATABASE
**Table:** `capture_entries`
**Columns to check:**
- `window_start`
- `window_end`
- `constraint_time`
- `constraint_type`
- `task_type_hint`

---

### 4. SCHEDULE-CAPTURE FUNCTION CALLED
**File:** `supabase/functions/schedule-capture/index.ts`

#### Step 4a: Load Capture (line ~350)
```typescript
const { data: capture } = await admin
  .from("capture_entries")
  .select("*")
  .eq("id", captureId)
  .single();
```

**CHECK:** What are the actual values in the database?

#### Step 4b: Normalize Routine (line 384-392)
```typescript
const normalizedCapture = normalizeRoutineCapture(capture, {
  referenceNow: now,
  timezone: timezone ?? undefined,  // IS THIS BEING PASSED?
});
```

**Function:** `normalizeRoutineCapture()` (line 235)

**What SHOULD happen:**
- Detects `task_type_hint === "routine.sleep"` (line 244)
- Calls `buildZonedDateTime()` for 22:00 → returns ISO string (line 254-262)
- Calls `buildZonedDateTime()` for 07:30 next day → returns ISO string (line 264-272)
- Sets `capture.window_start` and `capture.window_end` (line 277-280)

**CHECK HERE:**
1. Is `timezone` being passed correctly? (line 387)
2. Is `buildZonedDateTime` defined? (line 3973+)
3. Are there any errors in console.log? (lines 253, 261, 269, 282-285)
4. Does the try-catch log an error? (line 286)

#### Step 4c: Update Database (line 394-405)
```typescript
await admin.from("capture_entries").update({
  window_start: normalizedCapture.window_start,
  window_end: normalizedCapture.window_end,
  // ...
}).eq("id", capture.id);
```

**CHECK:** Does this UPDATE succeed? Are the values correct?

#### Step 4d: Compute Scheduling Plan (line 437)
```typescript
const plan = computeSchedulingPlan(capture, {
  referenceNow: now,
  timezone: timezone ?? "UTC",
});
```

**Function:** `computeSchedulingPlan()` (line ~2400+)

**What happens:**
- Reads `capture.window_start` and `capture.window_end`
- Creates `plan.window.start` and `plan.window.end`

**CHECK:** Are these dates valid? Not identical?

#### Step 4e: Adjust Window Start (line 573-575)
```typescript
const scheduleWindowStart = plan.window?.start
  ? new Date(Math.max(plan.window.start.getTime(), now.getTime()))
  : now;
```

**PROBLEM:** If `plan.window.start` is in the past (like 04:00 UTC when it's 17:00 UTC), it gets replaced with `now`!

**THIS IS THE BUG IF:**
- window_start is `2025-11-22T04:00Z` (22:00 CST tonight)
- Current time is `2025-11-21T17:30Z` (11:30 AM CST)
- But `2025-11-22T04:00Z` is TOMORROW 04:00 UTC, not today!
- So it should be AFTER now, not before

**CHECK:** Is the date calculation wrong? Should be Nov 22, not Nov 21?

#### Step 4f: Return 409 Conflict (line ~600)
```typescript
return json({
  error: "Found slot exceeds deadline/window.",
  reason: "slot_exceeds_deadline",
  // ...
}, 409);
```

---

## Key Debug Points

### A. Check Supabase Logs for Console Output
**Where:** Supabase Dashboard → Edge Functions → schedule-capture → Logs

**Look for:**
```
[NORMALIZE] Sleep task detected, timezone: America/Chicago
[NORMALIZE] nightStart calculated: 2025-11-22T04:00:00.000Z
[NORMALIZE] nightEnd calculated: 2025-11-22T13:30:00.000Z
[NORMALIZE] Final sleep capture: { window_start: ..., window_end: ... }
```

**Or errors:**
```
[NORMALIZE] Error in sleep normalization: ...
```

### B. Check Database Directly
**Query:**
```sql
SELECT 
  id,
  title,
  task_type_hint,
  window_start,
  window_end,
  constraint_time,
  constraint_type,
  created_at
FROM capture_entries
WHERE task_type_hint LIKE '%sleep%'
ORDER BY created_at DESC
LIMIT 5;
```

### C. Check Request Body
**In app logs, what is being sent?**
```json
{
  "captureId": "...",
  "timezone": "America/Chicago",  // ← Is this present?
  "timezoneOffsetMinutes": -360   // ← Is this present?
}
```

### D. Check buildZonedDateTime Logic
**File:** schedule-capture/index.ts, line 3973+

**Test manually:**
```javascript
const now = new Date("2025-11-21T17:30:00Z");  // 11:30 AM CST
const timezone = "America/Chicago";

// Should return: "2025-11-22T04:00:00.000Z" (tomorrow 04:00 UTC = tonight 22:00 CST)
const result = buildZonedDateTime({
  timezone,
  reference: now,
  hour: 22,
  minute: 0,
});
console.log(result);
```

## Most Likely Issues

1. **Timezone not passed:** `timezone` is `undefined` → defaults to "UTC" → wrong calculation
2. **buildZonedDateTime not defined:** Function didn't deploy → error in try-catch → original values used
3. **Date comparison bug:** Using Nov 21 instead of Nov 22 for tonight's 22:00
4. **Database not updated:** normalizeRoutineCapture runs but UPDATE fails silently
5. **computeSchedulingPlan overwrites:** Takes normalized values but transforms them incorrectly
