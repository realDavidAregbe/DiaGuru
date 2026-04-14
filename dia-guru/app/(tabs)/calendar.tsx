import { fetchUpcomingEvents, SimpleEvent } from "@/lib/calendar";
import {
  Capture,
  listScheduledCaptures,
  lockCaptureWindow,
  syncCaptureEvents,
} from "@/lib/capture";
import {
  extractScheduleReasons,
  formatFreezeUntilLabel,
  getScheduleReasonPreview,
  isCaptureActivelyLocked,
} from "@/lib/schedule-insights";
import { useSupabaseSession } from "@/hooks/useSupabaseSession";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

const LOOKAHEAD_DAYS = 14;

type CalendarFilter = "all" | "diaguru";

type TimelineItem =
  | {
      id: string;
      kind: "capture";
      sortTs: number;
      dateKey: string;
      dateLabel: string;
      capture: Capture;
    }
  | {
      id: string;
      kind: "external";
      sortTs: number;
      dateKey: string;
      dateLabel: string;
      event: SimpleEvent;
    };

type TimelineSection = {
  dateKey: string;
  dateLabel: string;
  items: TimelineItem[];
};

type ExternalTimelineItem = Extract<TimelineItem, { kind: "external" }>;

function isDiaGuruEvent(event: SimpleEvent) {
  return (
    event.extendedProperties?.private?.diaGuru === "true" ||
    (event.summary ?? "").trim().startsWith("[DG]")
  );
}

function showScheduleWhy(capture: Capture) {
  const reasons = extractScheduleReasons(capture);
  const body = reasons.map((reason) => `- ${reason}`).join("\n");
  Alert.alert("Why this time?", body);
}

function buildDayMeta(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return {
    dateKey: `${year}-${month}-${day}`,
    dateLabel: date.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    }),
  };
}

function parseCalendarValue(value?: string | null) {
  if (!value) return null;
  if (!value.includes("T")) {
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatTimeRange(startValue?: string | null, endValue?: string | null) {
  if (!startValue) return "Time unavailable";

  const isAllDay = !startValue.includes("T");
  if (isAllDay) {
    return "All day";
  }

  const start = new Date(startValue);
  if (Number.isNaN(start.getTime())) {
    return "Time unavailable";
  }

  const startText = start.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  if (!endValue) {
    return startText;
  }

  const end = new Date(endValue);
  if (Number.isNaN(end.getTime())) {
    return startText;
  }

  const endText = end.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${startText} - ${endText}`;
}

function getEventStartValue(event: SimpleEvent) {
  return event.start?.dateTime ?? event.start?.date ?? null;
}

function getEventEndValue(event: SimpleEvent) {
  return event.end?.dateTime ?? event.end?.date ?? null;
}

function getEventSortTs(event: SimpleEvent) {
  const startValue = getEventStartValue(event);
  if (!startValue) return Number.POSITIVE_INFINITY;
  const start = parseCalendarValue(startValue);
  return start ? start.getTime() : Number.POSITIVE_INFINITY;
}

export default function CalendarTab() {
  const { session } = useSupabaseSession();
  const userId = session?.user?.id ?? null;
  const insets = useSafeAreaInsets();

  const [events, setEvents] = useState<SimpleEvent[]>([]);
  const [sessions, setSessions] = useState<Capture[]>([]);
  const [filter, setFilter] = useState<CalendarFilter>("all");
  const [loading, setLoading] = useState(true);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lockingCaptureId, setLockingCaptureId] = useState<string | null>(null);

  const loadCalendarView = useCallback(
    async (showSpinner: boolean) => {
      if (!userId) return;
      if (showSpinner) setLoading(true);
      setCalendarError(null);
      try {
        try {
          await syncCaptureEvents();
        } catch (error) {
          console.log("calendar sync error", error);
        }

        const [eventList, scheduledList] = await Promise.all([
          fetchUpcomingEvents(LOOKAHEAD_DAYS),
          listScheduledCaptures(),
        ]);

        const nowTs = Date.now();
        const windowEndTs = nowTs + LOOKAHEAD_DAYS * 86400000;
        const visibleSessions = scheduledList.filter((capture) => {
          if (!capture.planned_start) return false;
          const startTs = Date.parse(capture.planned_start);
          const endTs = capture.planned_end
            ? Date.parse(capture.planned_end)
            : startTs;
          if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
            return false;
          }
          return endTs >= nowTs && startTs <= windowEndTs;
        });

        setEvents(eventList);
        setSessions(visibleSessions);
      } catch (error: any) {
        setCalendarError(error?.message ?? "Failed to load calendar view");
      } finally {
        if (showSpinner) setLoading(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    if (!userId) return;
    loadCalendarView(true);
  }, [loadCalendarView, userId]);

  const onRefresh = useCallback(async () => {
    if (!userId) return;
    setRefreshing(true);
    try {
      await loadCalendarView(false);
    } catch (error) {
      console.log("calendar refresh error", error);
    } finally {
      setRefreshing(false);
    }
  }, [loadCalendarView, userId]);

  const handleLockCapture = useCallback(
    async (captureId: string) => {
      if (lockingCaptureId) return;
      setLockingCaptureId(captureId);
      try {
        await lockCaptureWindow(captureId);
        await loadCalendarView(false);
        Alert.alert(
          "Time protected",
          "DiaGuru will keep that session fixed unless you change it.",
        );
      } catch (error: any) {
        Alert.alert(
          "Lock failed",
          error?.message ?? "Unable to protect this session right now.",
        );
      } finally {
        setLockingCaptureId(null);
      }
    },
    [loadCalendarView, lockingCaptureId],
  );

  const lockedSessions = useMemo(
    () => sessions.filter((capture) => isCaptureActivelyLocked(capture)),
    [sessions],
  );

  const externalEvents = useMemo(
    () => events.filter((event) => !isDiaGuruEvent(event)),
    [events],
  );

  const timelineItems = useMemo<TimelineItem[]>(() => {
    const captureItems: TimelineItem[] = sessions
      .filter((capture) => Boolean(capture.planned_start))
      .map((capture) => {
        const start = new Date(capture.planned_start!);
        const { dateKey, dateLabel } = buildDayMeta(start);
        return {
          id: capture.id,
          kind: "capture",
          sortTs: start.getTime(),
          dateKey,
          dateLabel,
          capture,
        };
      });

    if (filter === "diaguru") {
      return captureItems.sort((a, b) => a.sortTs - b.sortTs);
    }

    const externalItems: ExternalTimelineItem[] = externalEvents.flatMap(
      (event) => {
        const startValue = getEventStartValue(event);
        if (!startValue) return [];
        const start = parseCalendarValue(startValue);
        if (!start) return [];
        const { dateKey, dateLabel } = buildDayMeta(start);
        return [
          {
            id: event.id,
            kind: "external",
            sortTs: getEventSortTs(event),
            dateKey,
            dateLabel,
            event,
          },
        ];
      },
    );

    return [...captureItems, ...externalItems].sort(
      (a, b) => a.sortTs - b.sortTs,
    );
  }, [externalEvents, filter, sessions]);

  const timelineSections = useMemo<TimelineSection[]>(() => {
    const grouped: TimelineSection[] = [];
    for (const item of timelineItems) {
      const existing = grouped[grouped.length - 1];
      if (!existing || existing.dateKey !== item.dateKey) {
        grouped.push({
          dateKey: item.dateKey,
          dateLabel: item.dateLabel,
          items: [item],
        });
        continue;
      }
      existing.items.push(item);
    }
    return grouped;
  }, [timelineItems]);

  const timelineContent = useMemo(() => {
    if (loading) {
      return <ActivityIndicator />;
    }
    if (calendarError) {
      return <Text style={styles.errorText}>{calendarError}</Text>;
    }
    if (timelineSections.length === 0) {
      return (
        <Text style={styles.emptyText}>
          {filter === "diaguru"
            ? `No DiaGuru sessions are scheduled in the next ${LOOKAHEAD_DAYS} days.`
            : `No events were found in the next ${LOOKAHEAD_DAYS} days.`}
        </Text>
      );
    }

    return timelineSections.map((section) => (
      <View key={section.dateKey} style={styles.daySection}>
        <View style={styles.daySeparator}>
          <View style={styles.daySeparatorLine} />
          <Text style={styles.daySeparatorText}>{section.dateLabel}</Text>
          <View style={styles.daySeparatorLine} />
        </View>

        <View style={styles.eventList}>
          {section.items.map((item) =>
            item.kind === "capture" ? (
              <DiaGuruTimelineCard
                key={item.id}
                capture={item.capture}
                locking={lockingCaptureId === item.capture.id}
                onLock={() => handleLockCapture(item.capture.id)}
              />
            ) : (
              <ExternalEventRow key={item.id} event={item.event} />
            ),
          )}
        </View>
      </View>
    ));
  }, [
    calendarError,
    filter,
    handleLockCapture,
    loading,
    lockingCaptureId,
    timelineSections,
  ]);

  return (
    <SafeAreaView
      style={[styles.safeArea, { paddingTop: Math.max(insets.top, 16) }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroCard}>
          <Text style={styles.eyebrow}>Calendar</Text>
          <Text style={styles.heroTitle}>One timeline, split by day.</Text>
          <Text style={styles.heroSubtitle}>
            See everything in order, then narrow to DiaGuru sessions only when
            you want to inspect what the scheduler owns.
          </Text>
          <View style={styles.statRow}>
            <Stat label="DiaGuru" value={`${sessions.length}`} />
            <Stat label="Protected" value={`${lockedSessions.length}`} />
            <Stat label="External" value={`${externalEvents.length}`} />
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Upcoming timeline</Text>
            <Text style={styles.sectionSubtitle}>
              Dates separate the feed. DiaGuru sessions keep their reasoning and
              protection controls inline.
            </Text>
          </View>

          <View style={styles.filterRow}>
            <FilterChip
              label="All events"
              active={filter === "all"}
              onPress={() => setFilter("all")}
            />
            <FilterChip
              label="DiaGuru"
              active={filter === "diaguru"}
              onPress={() => setFilter("diaguru")}
            />
          </View>

          {timelineContent}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function DiaGuruTimelineCard({
  capture,
  locking,
  onLock,
}: {
  capture: Capture;
  locking: boolean;
  onLock: () => void;
}) {
  const reasons = getScheduleReasonPreview(capture, 2);
  const locked = isCaptureActivelyLocked(capture);
  const freezeLabel = formatFreezeUntilLabel(capture);
  const timeLabel = formatTimeRange(capture.planned_start, capture.planned_end);

  return (
    <View style={styles.sessionCard}>
      <View style={styles.sessionHeader}>
        <View style={styles.sessionHeaderCopy}>
          <Text style={styles.eventTitle}>{capture.content}</Text>
          <Text style={styles.eventTime}>{timeLabel}</Text>
        </View>
        <View style={styles.badgeRow}>
          <View style={[styles.pill, styles.pillBrand]}>
            <Text style={[styles.pillText, styles.pillTextBrand]}>DiaGuru</Text>
          </View>
          <View
            style={[
              styles.pill,
              locked ? styles.pillLocked : styles.pillNeutral,
            ]}
          >
            <Text
              style={[
                styles.pillText,
                locked ? styles.pillTextLocked : styles.pillTextNeutral,
              ]}
            >
              {locked ? "Protected" : "Flexible"}
            </Text>
          </View>
          {capture.reschedule_count > 0 ? (
            <View style={[styles.pill, styles.pillNeutral]}>
              <Text style={[styles.pillText, styles.pillTextNeutral]}>
                Moved {capture.reschedule_count}x
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {freezeLabel && locked ? (
        <Text style={styles.lockDetail}>Protected until {freezeLabel}</Text>
      ) : null}

      <View style={styles.reasonList}>
        {reasons.map((reason) => (
          <Text key={reason} style={styles.reasonText}>
            - {reason}
          </Text>
        ))}
      </View>

      <View style={styles.actionRow}>
        <TouchableOpacity
          style={styles.ghostButton}
          onPress={() => showScheduleWhy(capture)}
        >
          <Text style={styles.ghostButtonText}>Why this time?</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.outlineButton,
            (locked || locking) && styles.disabledButton,
          ]}
          onPress={onLock}
          disabled={locked || locking}
        >
          <Text
            style={[
              styles.outlineButtonText,
              (locked || locking) && styles.disabledButtonText,
            ]}
          >
            {locked ? "Protected" : locking ? "Protecting..." : "Protect time"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ExternalEventRow({ event }: { event: SimpleEvent }) {
  const timeLabel = formatTimeRange(
    getEventStartValue(event),
    getEventEndValue(event),
  );

  return (
    <View style={styles.eventCard}>
      <View style={styles.externalHeader}>
        <Text style={styles.eventTitle} numberOfLines={2}>
          {event.summary ?? "(no title)"}
        </Text>
        <View style={[styles.pill, styles.pillNeutral]}>
          <Text style={[styles.pillText, styles.pillTextNeutral]}>
            External
          </Text>
        </View>
      </View>
      <Text style={styles.eventTime}>{timeLabel}</Text>
      <Text style={styles.externalHint}>
        DiaGuru reads this as context and leaves it untouched.
      </Text>
    </View>
  );
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.filterChip, active && styles.filterChipActive]}
      onPress={onPress}
    >
      <Text
        style={[styles.filterChipText, active && styles.filterChipTextActive]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F8FAFC",
  },
  content: {
    gap: 16,
    paddingHorizontal: 20,
    paddingBottom: 28,
  },
  heroCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 18,
    gap: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  eyebrow: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  heroTitle: {
    color: "#111827",
    fontSize: 24,
    fontWeight: "700",
    lineHeight: 29,
  },
  heroSubtitle: {
    color: "#475569",
    fontSize: 15,
    lineHeight: 22,
  },
  statRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  statCard: {
    flexGrow: 1,
    minWidth: 90,
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 4,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  statLabel: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  statValue: {
    color: "#111827",
    fontSize: 16,
    fontWeight: "700",
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 18,
    gap: 14,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  sectionHeader: {
    gap: 6,
  },
  sectionTitle: {
    color: "#111827",
    fontSize: 18,
    fontWeight: "700",
  },
  sectionSubtitle: {
    color: "#475569",
    fontSize: 14,
    lineHeight: 20,
  },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    backgroundColor: "#F8FAFC",
  },
  filterChipActive: {
    backgroundColor: "#111827",
    borderColor: "#111827",
  },
  filterChipText: {
    color: "#334155",
    fontWeight: "700",
  },
  filterChipTextActive: {
    color: "#FFFFFF",
  },
  daySection: {
    gap: 12,
  },
  daySeparator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  daySeparatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: "#E2E8F0",
  },
  daySeparatorText: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  eventList: {
    gap: 12,
  },
  sessionCard: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    backgroundColor: "#FFFFFF",
    gap: 10,
  },
  sessionHeader: {
    gap: 10,
  },
  sessionHeaderCopy: {
    gap: 4,
  },
  externalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  pill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  pillNeutral: {
    backgroundColor: "#F1F5F9",
  },
  pillLocked: {
    backgroundColor: "#DBEAFE",
  },
  pillBrand: {
    backgroundColor: "#E0E7FF",
  },
  pillText: {
    fontSize: 12,
    fontWeight: "700",
  },
  pillTextNeutral: {
    color: "#475569",
  },
  pillTextLocked: {
    color: "#1D4ED8",
  },
  pillTextBrand: {
    color: "#3730A3",
  },
  lockDetail: {
    color: "#1D4ED8",
    fontSize: 12,
    fontWeight: "600",
  },
  reasonList: {
    gap: 6,
  },
  reasonText: {
    color: "#334155",
    lineHeight: 19,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },
  ghostButton: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "#F8FAFC",
  },
  ghostButtonText: {
    color: "#0F172A",
    fontWeight: "700",
  },
  outlineButton: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    backgroundColor: "#FFFFFF",
  },
  outlineButtonText: {
    color: "#0F172A",
    fontWeight: "700",
  },
  disabledButton: {
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
  },
  disabledButtonText: {
    color: "#94A3B8",
  },
  eventCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
    gap: 6,
  },
  eventTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    color: "#111827",
  },
  eventTime: {
    color: "#4B5563",
  },
  externalHint: {
    color: "#64748B",
    fontSize: 12,
    fontWeight: "600",
  },
  emptyText: {
    color: "#475569",
  },
  errorText: {
    color: "#DC2626",
  },
});
