const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("Error: Missing SUPABASE_URL or SERVICE_ROLE_KEY environment variables.");
    console.error("Usage: SERVICE_ROLE_KEY=... node scripts/cleanup-routines.js");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function runCleanup() {
    console.log("Starting cleanup of routine tasks...");

    // Fetch potential routines
    const { data: captures, error } = await supabase
        .from('capture_entries')
        .select('*')
        .or('task_type_hint.eq.routine.sleep,task_type_hint.eq.routine.meal,extraction_kind.eq.routine.sleep,extraction_kind.eq.routine.meal');

    if (error) {
        console.error("Error fetching captures:", error);
        process.exit(1);
    }

    console.log(`Found ${captures.length} potential routine tasks.`);

    let updatedCount = 0;

    for (const capture of captures) {
        let needsUpdate = false;
        const updates = {};

        const isSleep = capture.task_type_hint === 'routine.sleep' || capture.extraction_kind === 'routine.sleep';
        const isMeal = capture.task_type_hint === 'routine.meal' || capture.extraction_kind === 'routine.meal';

        // Logic to detect if it needs normalization
        // For sleep: if it's scheduled during the day (e.g. 08:00 to 20:00)
        // For meal: if it's missing a window or at an odd time

        // We can just force normalization by clearing freeze and setting to pending if it looks like a routine
        // The scheduler will re-normalize it on next run.

        // Only update if it's not already properly constrained or if we want to force a refresh
        // But the prompt says: "Unfreeze those... and let the new rules reschedule them"

        if (capture.freeze_until) {
            updates.freeze_until = null;
            needsUpdate = true;
        }

        // If it's scheduled, we might want to unschedule it so it gets picked up again
        if (capture.status === 'scheduled') {
            updates.status = 'pending';
            updates.calendar_event_id = null;
            updates.calendar_event_etag = null;
            updates.planned_start = null;
            updates.planned_end = null;
            updates.scheduled_for = null;
            updates.scheduling_notes = 'Reset by cleanup script for routine normalization.';
            needsUpdate = true;
        }

        if (needsUpdate) {
            const { error: updateError } = await supabase
                .from('capture_entries')
                .update(updates)
                .eq('id', capture.id);

            if (updateError) {
                console.error(`Failed to update capture ${capture.id}:`, updateError);
            } else {
                console.log(`Updated capture ${capture.id} (${capture.content})`);
                updatedCount++;
            }
        }
    }

    console.log(`Cleanup complete. Updated ${updatedCount} tasks.`);
}

runCleanup();
