import { useEffect, useState } from 'react';
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

const FEATURES = [
  {
    title: 'Capture fast',
    description: 'Drop the thought in once. DiaGuru keeps the rest organized.',
  },
  {
    title: 'Schedule smart',
    description: 'The app parses intent, then fits work into realistic calendar slots.',
  },
  {
    title: 'Stay in sync',
    description: 'Google Calendar stays linked so scheduled sessions are actually actionable.',
  },
];

export default function Auth() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        supabase.auth.startAutoRefresh();
      } else {
        supabase.auth.stopAutoRefresh();
      }
    });

    return () => subscription.remove();
  }, []);

  async function signInWithEmail() {
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) Alert.alert(error.message);
    setLoading(false);
  }

  async function signUpWithEmail() {
    setLoading(true);
    const {
      data: { session },
      error,
    } = await supabase.auth.signUp({
      email: email.trim(),
      password,
    });

    if (error) Alert.alert(error.message);
    if (!session) Alert.alert('Check your inbox', 'Confirm your email address to finish signing up.');
    setLoading(false);
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
            <Text style={styles.eyebrow}>DiaGuru</Text>
            <Text style={styles.heroTitle}>Turn loose thoughts into a schedule that fits your day.</Text>
            <Text style={styles.heroSubtitle}>
              Capture tasks, let the assistant infer the details, and keep Google Calendar aligned
              without juggling everything manually.
            </Text>
            <View style={styles.featureList}>
              {FEATURES.map((feature) => (
                <View key={feature.title} style={styles.featureRow}>
                  <View style={styles.featureDot} />
                  <View style={styles.featureTextWrap}>
                    <Text style={styles.featureTitle}>{feature.title}</Text>
                    <Text style={styles.featureDescription}>{feature.description}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.formCard}>
            <Text style={styles.formTitle}>Sign in</Text>
            <Text style={styles.formSubtitle}>Use the same account you want linked to DiaGuru.</Text>

            <View style={styles.field}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="email@address.com"
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                textContentType="emailAddress"
                style={styles.input}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
                autoComplete="password"
                textContentType="password"
                secureTextEntry
                style={styles.input}
              />
            </View>

            <View style={styles.buttonStack}>
              <TouchableOpacity
                style={[styles.primaryButton, loading && styles.buttonDisabled]}
                onPress={signInWithEmail}
                disabled={loading}
                accessibilityRole="button"
              >
                {loading ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Sign in</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, loading && styles.buttonDisabled]}
                onPress={signUpWithEmail}
                disabled={loading}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryButtonText}>Create account</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.footerNote}>
              You can link Google Calendar from the Profile tab after signing in.
            </Text>
          </View>
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
    paddingHorizontal: 20,
    paddingVertical: 24,
    gap: 18,
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
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
  },
  heroSubtitle: {
    color: '#475569',
    fontSize: 15,
    lineHeight: 22,
  },
  featureList: {
    gap: 12,
  },
  featureRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  featureDot: {
    width: 10,
    height: 10,
    marginTop: 6,
    borderRadius: 999,
    backgroundColor: '#94A3B8',
  },
  featureTextWrap: {
    flex: 1,
    gap: 2,
  },
  featureTitle: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '700',
  },
  featureDescription: {
    color: '#6B7280',
    fontSize: 13,
    lineHeight: 18,
  },
  formCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 18,
    gap: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  formTitle: {
    color: '#111827',
    fontSize: 20,
    fontWeight: '700',
  },
  formSubtitle: {
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
  buttonStack: {
    gap: 10,
    marginTop: 4,
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
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  secondaryButtonText: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '600',
  },
  footerNote: {
    color: '#64748B',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 2,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
});
