
function normalizeRoutineCapture(input: any, options: { referenceNow: Date; offsetMinutes: number }) {
    const capture = { ...input };
    const { referenceNow, offsetMinutes } = options;

    const localNowMs = referenceNow.getTime() + offsetMinutes * 60000;
    const localDate = new Date(localNowMs);

    const isSleep = capture.task_type_hint === "routine.sleep";

    if (isSleep) {
        const localNightStart = new Date(localDate);
        localNightStart.setUTCHours(22, 0, 0, 0);

        const localNightEnd = new Date(localNightStart);
        localNightEnd.setUTCDate(localNightEnd.getUTCDate() + 1);
        localNightEnd.setUTCHours(7, 30, 0, 0);

        const nightStart = new Date(localNightStart.getTime() - offsetMinutes * 60000);
        const nightEnd = new Date(localNightEnd.getTime() - offsetMinutes * 60000);

        capture.window_start = capture.window_start ?? nightStart.toISOString();
        capture.window_end = capture.window_end ?? nightEnd.toISOString();
    }
    return capture;
}

const now = new Date("2025-11-21T16:46:00Z"); // Approx time of request
const offset = -360; // CST

const input = {
    task_type_hint: "routine.sleep",
    window_start: null,
    window_end: null,
    constraint_time: "2025-11-21T22:00:00.000Z"
};

const result = normalizeRoutineCapture(input, { referenceNow: now, offsetMinutes: offset });
console.log("Start: " + result.window_start);
console.log("End: " + result.window_end);
