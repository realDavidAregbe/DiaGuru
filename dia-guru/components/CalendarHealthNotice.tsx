import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { CalendarHealth } from '@/lib/google-connect';

type Props = {
  health: CalendarHealth | null;
  error: string | null;
  checking: boolean;
  onReconnect: () => void;
  onRetry: () => void;
};

export function CalendarHealthNotice({
  health,
  error,
  checking,
  onReconnect,
  onRetry,
}: Props) {
  const showBanner = health?.status === 'needs_reconnect';
  const showError = Boolean(error);

  if (!showBanner && !showError) {
    return null;
  }

  return (
    <View style={styles.container}>
      {showError ? (
        <View style={[styles.noticeCard, styles.errorCard]}>
          <View style={styles.headerRow}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>Calendar</Text>
            </View>
            <Text style={styles.statusLabel}>Needs attention</Text>
          </View>
          <Text style={styles.noticeTitle}>Calendar check failed</Text>
          <Text style={styles.noticeText}>
            {error ?? 'We could not verify your Google Calendar link right now.'}
          </Text>
          <TouchableOpacity
            onPress={onRetry}
            style={[styles.primaryButton, checking && styles.buttonDisabled]}
            disabled={checking}
            accessibilityRole="button"
          >
            <Text style={styles.primaryButtonText}>{checking ? 'Retrying...' : 'Try again'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {showBanner ? (
        <View style={[styles.noticeCard, styles.warningCard]}>
          <View style={styles.headerRow}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>Sync</Text>
            </View>
            {checking ? <ActivityIndicator size="small" color="#92400E" /> : null}
          </View>
          <Text style={styles.noticeTitle}>Reconnect Google Calendar</Text>
          <Text style={styles.noticeText}>
            DiaGuru needs access to your calendar to plan sessions automatically. Reconnect now to
            resume scheduling.
          </Text>
          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={onReconnect}
              style={styles.primaryButton}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>Reconnect</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onRetry}
              style={[styles.secondaryButton, checking && styles.buttonDisabled]}
              disabled={checking}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryButtonText}>Check again</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
    marginBottom: 12,
  },
  noticeCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 10,
    backgroundColor: '#FFFFFF',
    borderColor: '#E2E8F0',
  },
  errorCard: {
    borderLeftWidth: 4,
    borderLeftColor: '#F87171',
  },
  warningCard: {
    borderLeftWidth: 4,
    borderLeftColor: '#94A3B8',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: '#F8FAFC',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  statusLabel: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  noticeTitle: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '700',
  },
  noticeText: {
    color: '#475569',
    fontSize: 13,
    lineHeight: 19,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  primaryButton: {
    backgroundColor: '#111827',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    minWidth: 120,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingVertical: 10,
    paddingHorizontal: 16,
    minWidth: 120,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#111827',
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.65,
  },
});

export default CalendarHealthNotice;
