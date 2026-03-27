import { useEffect, useState } from 'react';
import {
  Alert,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ParseMode } from '@/lib/capture';
import { requestNotificationPermission, scheduleIn, sendLocal } from '../../lib/notifications';
import { getAssistantModePreference } from '@/lib/preferences';

export default function SettingsScreen() {
  const [status, setStatus] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [assistantMode, setAssistantMode] = useState<ParseMode>('conversational_strict');
  const [modeLoading, setModeLoading] = useState(true);
  const insets = useSafeAreaInsets();

  const ask = async () => {
    const ok = await requestNotificationPermission();
    setStatus(ok ? 'granted' : 'denied');
    Alert.alert(ok ? 'Notifications enabled' : 'Permission denied');
  };

  useEffect(() => {
    (async () => {
      const stored = await getAssistantModePreference();
      setAssistantMode(stored);
      setModeLoading(false);
    })();
  }, []);

  return (
    <SafeAreaView style={[styles.safeArea, { paddingTop: Math.max(insets.top, 16) }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroCard}>
          <Text style={styles.eyebrow}>Settings</Text>
          <Text style={styles.heroTitle}>Tune notifications and assistant behavior.</Text>
          <Text style={styles.heroSubtitle}>
            DiaGuru currently uses a single conversational mode, so this screen is mostly about staying
            informed and keeping reminders reliable.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Assistant mode</Text>
          <Text style={styles.sectionSubtitle}>
            The assistant runs in conversational strict mode and asks one clarifying question using
            DeepSeek when details are missing.
          </Text>

          <View style={styles.modeCard}>
            <View style={styles.modeHeader}>
              <View style={styles.modePill}>
                <Text style={styles.modePillText}>Active</Text>
              </View>
              {modeLoading ? <ActivityIndicator size="small" color="#334155" /> : null}
            </View>
            <Text style={styles.modeTitle}>Conversational strict</Text>
            <Text style={styles.modeDescription}>
              DeepSeek only, with no deterministic fallback.
            </Text>
            <Text style={styles.modeStatus}>
              Current mode: {assistantMode === 'conversational_strict' ? 'Conversational strict' : assistantMode}
            </Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Notifications</Text>
          <Text style={styles.sectionSubtitle}>
            Use these controls to verify local reminders while you are developing or testing.
          </Text>

          <View style={styles.buttonStack}>
            <TouchableOpacity style={styles.primaryButton} onPress={ask} accessibilityRole="button">
              <Text style={styles.primaryButtonText}>Request notification permission</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => sendLocal('DiaGuru', 'Local test notification')}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryButtonText}>Send test notification</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => scheduleIn(5, 'DiaGuru', 'Scheduled test (5s)')}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryButtonText}>Schedule in 5 seconds</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Permission</Text>
            <Text style={styles.statusValue}>{status}</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  content: {
    flexGrow: 1,
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
  modeCard: {
    gap: 10,
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  modeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  modePill: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  modePillText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  modeTitle: {
    color: '#111827',
    fontSize: 17,
    fontWeight: '700',
  },
  modeDescription: {
    color: '#475569',
    fontSize: 14,
    lineHeight: 20,
  },
  modeStatus: {
    color: '#64748B',
    fontSize: 13,
  },
  buttonStack: {
    gap: 10,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  secondaryButton: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  secondaryButtonText: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '600',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E2E8F0',
  },
  statusLabel: {
    color: '#475569',
    fontSize: 13,
    fontWeight: '600',
  },
  statusValue: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
});
