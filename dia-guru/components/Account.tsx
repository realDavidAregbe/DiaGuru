import { connectGoogleCalendar } from '@/lib/google-connect';
import { fetchProfile, upsertProfile } from '@/lib/profile';
import { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '../lib/supabase';

export default function Account({ session }: { session: Session }) {
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [website, setWebsite] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');

  const [linking, setLinking] = useState(false);
  const [checkingGoogle, setCheckingGoogle] = useState(false);
  const [googleLinked, setGoogleLinked] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const userId = session?.user?.id;

  const getProfile = useCallback(async () => {
    try {
      setLoading(true);
      if (!userId) throw new Error('No user on the session!');

      const data = await fetchProfile(userId);

      if (data) {
        setUsername(data.username ?? '');
        setWebsite(data.website ?? '');
        setAvatarUrl(data.avatar_url ?? '');
      }
    } catch (error) {
      if (error instanceof Error) {
        Alert.alert(error.message);
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const refreshGoogleStatus = useCallback(async () => {
    if (!userId) return;
    setCheckingGoogle(true);
    setGoogleError(null);
    try {
      const { data, error } = await supabase
        .from('calendar_accounts')
        .select('id')
        .eq('user_id', userId)
        .eq('provider', 'google')
        .maybeSingle();
      if (error) throw error;
      setGoogleLinked(!!data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGoogleLinked(false);
      setGoogleError(message);
    } finally {
      setCheckingGoogle(false);
    }
  }, [userId]);

  useEffect(() => {
    if (session) getProfile();
  }, [session, getProfile]);

  useEffect(() => {
    if (userId) refreshGoogleStatus();
  }, [userId, refreshGoogleStatus]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshGoogleStatus();
    });
    return () => sub.remove();
  }, [refreshGoogleStatus]);

  async function updateProfile({
    username,
    website,
    avatar_url,
  }: {
    username: string;
    website: string;
    avatar_url: string;
  }) {
    try {
      setLoading(true);
      if (!userId) throw new Error('No user on the session!');

      const updates = {
        id: userId,
        username,
        website,
        avatar_url,
        updated_at: new Date().toISOString(),
      };

      await upsertProfile(updates);
      Alert.alert('Profile saved', 'Your account details were updated successfully.');
    } catch (error) {
      if (error instanceof Error) {
        Alert.alert(error.message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleConnectGoogle() {
    try {
      setLinking(true);
      setGoogleError(null);
      await connectGoogleCalendar();
      Alert.alert(
        'Check your browser',
        'Approve Google Calendar access, then return to DiaGuru to finish linking.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGoogleError(message);
      Alert.alert('Google connect failed', message);
    } finally {
      setLinking(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.heroCard}>
            <Text style={styles.eyebrow}>Profile</Text>
            <Text style={styles.heroTitle}>Keep DiaGuru connected to the right account.</Text>
            <Text style={styles.heroSubtitle}>
              Update your profile details, check Google Calendar status, and stay ready for scheduling
              without bouncing between screens.
            </Text>
            <View style={styles.statusRow}>
              <View style={[styles.statusPill, googleLinked ? styles.statusPillSuccess : styles.statusPillNeutral]}>
                <Text style={[styles.statusPillText, googleLinked && styles.statusPillTextSuccess]}>
                  {googleLinked ? 'Google Calendar linked' : 'Google Calendar not linked'}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Account details</Text>
            <Text style={styles.sectionSubtitle}>
              These values are saved to your DiaGuru profile and can be updated anytime.
            </Text>

            <View style={styles.field}>
              <Text style={styles.label}>Email</Text>
              <View style={styles.readOnlyField}>
                <Text style={styles.readOnlyText}>{session?.user?.email ?? 'Unknown email'}</Text>
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Username</Text>
              <TextInput
                value={username}
                onChangeText={setUsername}
                placeholder="Your name"
                placeholderTextColor="#94A3B8"
                style={styles.input}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Website</Text>
              <TextInput
                value={website}
                onChangeText={setWebsite}
                placeholder="https://example.com"
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={styles.input}
              />
            </View>

            <TouchableOpacity
              style={[styles.primaryButton, loading && styles.buttonDisabled]}
              onPress={() => updateProfile({ username, website, avatar_url: avatarUrl })}
              disabled={loading}
              accessibilityRole="button"
            >
              {loading ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Save profile</Text>}
            </TouchableOpacity>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Google Calendar</Text>
            <Text style={styles.sectionSubtitle}>
              Link the calendar that should receive DiaGuru sessions and health checks.
            </Text>

            <View style={styles.statusList}>
              <View style={styles.statusRowCompact}>
                <Text style={styles.statusLabel}>Linked</Text>
                <Text style={styles.statusValue}>{googleLinked ? 'Yes' : 'No'}</Text>
              </View>
              <View style={styles.statusRowCompact}>
                <Text style={styles.statusLabel}>Last check</Text>
                <Text style={styles.statusValue}>{checkingGoogle ? 'Checking...' : 'Ready'}</Text>
              </View>
            </View>

            {googleError ? <Text style={styles.errorText}>{googleError}</Text> : null}

            <View style={styles.buttonStack}>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  (linking || checkingGoogle || googleLinked) && styles.buttonDisabled,
                ]}
                disabled={linking || checkingGoogle || googleLinked}
                onPress={handleConnectGoogle}
                accessibilityRole="button"
              >
                <Text style={styles.primaryButtonText}>
                  {linking
                    ? 'Opening browser...'
                    : checkingGoogle
                      ? 'Checking status...'
                      : googleLinked
                        ? 'Google Calendar connected'
                        : 'Connect Google Calendar'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, checkingGoogle && styles.buttonDisabled]}
                onPress={refreshGoogleStatus}
                disabled={checkingGoogle}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryButtonText}>
                  {checkingGoogle ? 'Refreshing...' : 'Refresh connection'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <TouchableOpacity
            style={styles.dangerButton}
            onPress={() => supabase.auth.signOut()}
            accessibilityRole="button"
          >
            <Text style={styles.dangerButtonText}>Sign out</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  flex: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    gap: 16,
    paddingHorizontal: 20,
    paddingVertical: 24,
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
    fontSize: 26,
    fontWeight: '700',
    lineHeight: 31,
  },
  heroSubtitle: {
    color: '#475569',
    fontSize: 15,
    lineHeight: 22,
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusPill: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#F1F5F9',
  },
  statusPillNeutral: {
    backgroundColor: '#F1F5F9',
  },
  statusPillSuccess: {
    backgroundColor: '#E2E8F0',
  },
  statusPillText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '700',
  },
  statusPillTextSuccess: {
    color: '#334155',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 18,
    gap: 12,
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
  field: {
    gap: 8,
  },
  label: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '700',
  },
  input: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    color: '#111827',
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  readOnlyField: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  readOnlyText: {
    color: '#334155',
    fontSize: 15,
  },
  statusList: {
    gap: 10,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  statusRowCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
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
  },
  errorText: {
    color: '#B91C1C',
    fontSize: 13,
    lineHeight: 18,
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
  dangerButton: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  dangerButtonText: {
    color: '#B91C1C',
    fontSize: 15,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
});
