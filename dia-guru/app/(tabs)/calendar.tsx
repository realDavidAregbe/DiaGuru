import { fetchUpcomingEvents, SimpleEvent } from '@/lib/calendar';
import { useSupabaseSession } from '@/hooks/useSupabaseSession';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const PREVIEW_WINDOW = 20;

export default function CalendarTab() {
  const { session } = useSupabaseSession();
  const userId = session?.user?.id ?? null;
  const insets = useSafeAreaInsets();

  const [events, setEvents] = useState<SimpleEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadEvents = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setEventsLoading(true);
      setEventsError(null);
      try {
        const list = await fetchUpcomingEvents(PREVIEW_WINDOW);
        setEvents(list);
      } catch (error: any) {
        setEventsError(error?.message ?? 'Failed to load calendar events');
      } finally {
        if (showSpinner) setEventsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!userId) return;
    loadEvents(true);
  }, [loadEvents, userId]);

  const onRefresh = useCallback(async () => {
    if (!userId) return;
    setRefreshing(true);
    try {
      await loadEvents(false);
    } catch (error) {
      console.log('calendar refresh error', error);
    } finally {
      setRefreshing(false);
    }
  }, [loadEvents, userId]);

  const eventsContent = useMemo(() => {
    if (eventsLoading) {
      return <ActivityIndicator />;
    }
    if (eventsError) {
      return <Text style={styles.errorText}>{eventsError}</Text>;
    }
    if (events.length === 0) {
      return <Text style={styles.emptyText}>Nothing scheduled in the next few days.</Text>;
    }

    return events.map((event) => <EventRow key={event.id} e={event} />);
  }, [events, eventsError, eventsLoading]);

  return (
    <SafeAreaView style={[styles.safeArea, { paddingTop: Math.max(insets.top, 16) }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroCard}>
          <Text style={styles.eyebrow}>Calendar</Text>
          <Text style={styles.heroTitle}>See DiaGuru sessions alongside everything else.</Text>
          <Text style={styles.heroSubtitle}>
            The next {PREVIEW_WINDOW} events are shown here. DiaGuru-created items remain tagged with
            [DG] so they are easy to spot.
          </Text>
          <View style={styles.statRow}>
            <Stat label="Loaded" value={`${events.length}`} />
            <Stat label="View" value={eventsLoading ? 'Syncing' : 'Upcoming'} />
            <Stat label="Mode" value="Read only" />
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Upcoming calendar</Text>
          <Text style={styles.sectionSubtitle}>
            DiaGuru tags its sessions with [DG]. External events stay untouched so your original plans
            remain.
          </Text>
          <View style={styles.eventList}>{eventsContent}</View>
          <View style={styles.footer}>
            <TouchableOpacity
              onPress={() =>
                Alert.alert('Coming soon', 'Calendar filters and quick actions are coming soon.')
              }
            >
              <Text style={styles.linkAction}>Calendar tips and actions</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function EventRow({ e }: { e: SimpleEvent }) {
  const start = e.start?.dateTime ?? e.start?.date;
  const end = e.end?.dateTime ?? e.end?.date;
  const isDiaGuru =
    e.extendedProperties?.private?.diaGuru === 'true' || (e.summary ?? '').trim().startsWith('[DG]');

  const startLabel = start
    ? new Date(start).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Anytime';
  const endLabel = end ? new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <View style={styles.eventCard}>
      <View style={styles.eventHeader}>
        <Text style={[styles.eventTitle, isDiaGuru && styles.diaGuruTitle]} numberOfLines={2}>
          {e.summary ?? '(no title)'}
        </Text>
        {isDiaGuru ? (
          <View style={styles.eventBadge}>
            <Text style={styles.eventBadgeText}>DG</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.eventTime}>
        {startLabel}
        {endLabel ? `  ->  ${endLabel}` : ''}
      </Text>
      {isDiaGuru && <Text style={styles.diaGuruTag}>DiaGuru scheduled</Text>}
    </View>
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
    backgroundColor: '#F8FAFC',
  },
  content: {
    gap: 16,
    paddingHorizontal: 20,
    paddingBottom: 28,
  },
  heroCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 18,
    gap: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  eyebrow: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  heroTitle: {
    color: '#111827',
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 29,
  },
  heroSubtitle: {
    color: '#475569',
    fontSize: 15,
    lineHeight: 22,
  },
  statRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  statCard: {
    flexGrow: 1,
    minWidth: 90,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 4,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  statLabel: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  statValue: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 18,
    gap: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  sectionTitle: {
    color: '#111827',
    fontSize: 18,
    fontWeight: '700',
  },
  sectionSubtitle: {
    color: '#475569',
    fontSize: 14,
    lineHeight: 20,
  },
  eventList: {
    gap: 12,
  },
  eventCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    gap: 6,
  },
  eventHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  eventTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    flex: 1,
    paddingRight: 8,
  },
  eventTime: {
    color: '#4B5563',
  },
  eventBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#F1F5F9',
  },
  eventBadgeText: {
    color: '#475569',
    fontWeight: '700',
    fontSize: 12,
  },
  diaGuruTag: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '600',
  },
  diaGuruTitle: {
    color: '#334155',
  },
  emptyText: {
    color: '#475569',
  },
  errorText: {
    color: '#DC2626',
  },
  linkAction: {
    color: '#334155',
    fontWeight: '600',
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#E2E8F0',
    paddingTop: 12,
  },
});
