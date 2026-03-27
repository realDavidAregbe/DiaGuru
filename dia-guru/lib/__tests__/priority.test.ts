import { computePriorityScore } from '../priority';

describe('computePriorityScore', () => {
  const reference = new Date('2025-10-25T12:00:00Z');

  it('penalises long duration tasks', () => {
    const shortScore = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
      },
      reference,
    );
    const longScore = computePriorityScore(
      {
        estimated_minutes: 240,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
      },
      reference,
    );
    expect(longScore).toBeLessThan(shortScore);
  });

  it('applies recency boost for older captures', () => {
    const newer = computePriorityScore(
      {
        estimated_minutes: 45,
        importance: 2,
        created_at: '2025-10-24T18:00:00Z',
      },
      reference,
    );
    const older = computePriorityScore(
      {
        estimated_minutes: 45,
        importance: 2,
        created_at: '2025-10-20T12:00:00Z',
      },
      reference,
    );
    expect(older).toBeGreaterThan(newer);
  });

  it('adds strong boost for imminent deadlines', () => {
    const imminent = computePriorityScore(
      {
        estimated_minutes: 60,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        deadline_at: '2025-10-25T13:00:00Z',
      },
      reference,
    );
    const flexible = computePriorityScore(
      {
        estimated_minutes: 60,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
      },
      reference,
    );
    expect(imminent).toBeGreaterThan(flexible + 5);
  });

  it('treats manual start targets as deadlines, but soft starts are gentler', () => {
    const hardStart = computePriorityScore(
      {
        estimated_minutes: 45,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        start_target_at: '2025-10-25T13:00:00Z',
        is_soft_start: false,
      },
      reference,
    );
    const softStart = computePriorityScore(
      {
        estimated_minutes: 45,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        start_target_at: '2025-10-25T13:00:00Z',
        is_soft_start: true,
      },
      reference,
    );
    expect(hardStart).toBeGreaterThan(softStart);
  });

  it('uses externality score as a nudge', () => {
    const solo = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        externality_score: 0,
      },
      reference,
    );
    const collaborative = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        externality_score: 3,
      },
      reference,
    );
    expect(collaborative).toBeGreaterThan(solo);
  });

  it('boosts near windows, ignores invalid windows, and does not boost far windows', () => {
    const baseline = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
      },
      reference,
    );

    const nearPastWindow = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        window_start: '2025-10-25T11:45:00Z',
      },
      reference,
    );

    const farFutureWindow = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        window_start: '2025-10-25T20:00:00Z',
      },
      reference,
    );

    const invalidWindow = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        window_start: 'not-a-date',
      },
      reference,
    );

    expect(nearPastWindow).toBeGreaterThan(baseline);
    expect(farFutureWindow).toBeCloseTo(baseline, 6);
    expect(invalidWindow).toBeCloseTo(baseline, 6);
  });

  it('applies non-overdue start-target deadline math and soft-start multiplier', () => {
    const flexible = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
      },
      reference,
    );

    const hardStart = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        start_target_at: '2025-10-26T00:00:00Z',
        is_soft_start: false,
      },
      reference,
    );

    const softStart = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        start_target_at: '2025-10-26T00:00:00Z',
        is_soft_start: true,
      },
      reference,
    );

    expect(hardStart).toBeGreaterThan(softStart);
    expect(softStart).toBeGreaterThan(flexible);
  });

  it('supports deadline candidates from deadline_time and deadline_date constraints', () => {
    const flexible = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
      },
      reference,
    );

    const deadlineTimeScore = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        constraint_type: 'deadline_time',
        constraint_time: '2025-10-25T18:00:00Z',
      },
      reference,
    );

    const deadlineDateScore = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        constraint_type: 'deadline_date',
        constraint_date: '2025-10-25',
      },
      reference,
    );

    expect(deadlineTimeScore).toBeGreaterThan(flexible);
    expect(deadlineDateScore).toBeGreaterThan(flexible);
  });

  it('falls back to original_target_time when earlier deadline candidates are invalid', () => {
    const baseline = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
      },
      reference,
    );

    const fallbackDeadline = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        deadline_at: 'invalid-deadline',
        constraint_type: 'deadline_date',
        constraint_date: 'invalid-date',
        original_target_time: '2025-10-25T19:00:00Z',
      },
      reference,
    );

    expect(fallbackDeadline).toBeGreaterThan(baseline);
  });

  it('penalises repeated rescheduling pressure', () => {
    const pristine = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        reschedule_count: 0,
        reschedule_penalty: 0,
      },
      reference,
    );

    const rescheduled = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        reschedule_count: 3,
        reschedule_penalty: 3,
      },
      reference,
    );

    expect(rescheduled).toBeLessThan(pristine);
  });
});
