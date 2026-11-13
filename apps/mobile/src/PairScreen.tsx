import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Device from 'expo-device';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { DEFAULT_PORT, PairError, findReachable, pair } from './desktopApi';
import { parseManualTarget, parsePairLink, type PairTarget } from './pairLink';
import type { SavedHost } from './savedHost';
import { colors, radius } from './theme';

type Mode = 'choose' | 'scan' | 'type';

function deviceName(): string {
  return Device.deviceName ?? Device.modelName ?? 'Phone';
}

/** First run: pair with the computer by scanning its QR code or typing the code. */
export function PairScreen({ onPaired, notice }: { onPaired(host: SavedHost): void; notice: string | null }) {
  const [mode, setMode] = useState<Mode>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);

  const connect = async (target: PairTarget) => {
    setBusy(true);
    setError(null);
    try {
      const found = await findReachable(target.hosts, target.port);
      if (found === null) {
        throw new PairError(`Cannot reach ${target.name}. Check that the phone is on the same Wi-Fi and phone sync is on.`);
      }
      const res = await pair(found.base, target.code, deviceName());
      onPaired({
        hostId: res.host.hostId,
        name: res.host.name,
        hosts: [found.host, ...target.hosts.filter((h) => h !== found.host)],
        port: target.port,
        token: res.token,
        deviceId: res.deviceId,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      scanned.current = false;
      setMode((m) => (m === 'scan' ? 'choose' : m));
    } finally {
      setBusy(false);
    }
  };

  const onScan = (r: BarcodeScanningResult) => {
    if (scanned.current) return;
    const target = parsePairLink(r.data);
    if (target === null) return;
    scanned.current = true;
    void connect(target);
  };

  if (mode === 'scan') {
    if (permission === null) return <View style={styles.fill} />;
    if (!permission.granted) {
      return (
        <View style={[styles.fill, styles.center]}>
          <Text style={styles.body}>Cadence needs the camera to read the pairing code.</Text>
          <Pressable style={styles.primary} onPress={() => void requestPermission()}>
            <Text style={styles.primaryText}>Allow camera</Text>
          </Pressable>
          <Pressable style={styles.link} onPress={() => setMode('type')}>
            <Text style={styles.linkText}>Type the code instead</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <View style={styles.fill}>
        <CameraView style={styles.fill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={busy ? undefined : onScan} />
        <View style={styles.scanOverlay}>
          {busy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.body}>Point the camera at the code in Cadence on your computer.</Text>}
          <Pressable style={styles.link} onPress={() => setMode('choose')}>
            <Text style={styles.linkText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.fill, styles.page]}>
      <Text style={styles.title}>Cadence</Text>
      <Text style={styles.body}>
        On your computer, open Cadence, go to Settings › Phone, turn on phone sync and click Pair a phone.
      </Text>
      {mode === 'type' ? (
        <View style={styles.form}>
          <Text style={styles.label}>Computer address</Text>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={setAddress}
            placeholder={`192.168.1.20:${DEFAULT_PORT}`}
            placeholderTextColor={colors.text3}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.label}>Pairing code</Text>
          <TextInput
            style={[styles.input, styles.code]}
            value={code}
            onChangeText={setCode}
            placeholder="000 000"
            placeholderTextColor={colors.text3}
            keyboardType="number-pad"
            maxLength={7}
          />
          <Pressable
            style={[styles.primary, busy && styles.disabled]}
            disabled={busy}
            onPress={() => {
              const target = parseManualTarget(address, code, DEFAULT_PORT);
              if (target === null) setError('Enter the address shown in Settings › Phone and the six-digit code.');
              else void connect(target);
            }}
          >
            {busy ? <ActivityIndicator color={colors.accentText} /> : <Text style={styles.primaryText}>Pair</Text>}
          </Pressable>
          <Pressable style={styles.link} onPress={() => setMode('choose')}>
            <Text style={styles.linkText}>Back</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.form}>
          <Pressable
            style={styles.primary}
            onPress={() => {
              scanned.current = false;
              setError(null);
              setMode('scan');
            }}
          >
            <Text style={styles.primaryText}>Scan the code</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => setMode('type')}>
            <Text style={styles.secondaryText}>Type the code</Text>
          </Pressable>
        </View>
      )}
      {error !== null && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  page: { padding: 24, paddingTop: 48, gap: 16 },
  title: { color: colors.text, fontSize: 34, fontWeight: '700', letterSpacing: -0.5 },
  body: { color: colors.text2, fontSize: 16, lineHeight: 23, textAlign: 'left' },
  form: { gap: 10, marginTop: 8 },
  label: { color: colors.text2, fontSize: 13, marginTop: 6 },
  input: {
    backgroundColor: colors.surface,
    color: colors.text,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 17,
  },
  code: { fontSize: 24, letterSpacing: 6, fontVariant: ['tabular-nums'] },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryText: { color: colors.accentText, fontSize: 17, fontWeight: '600' },
  secondary: { backgroundColor: colors.surfaceHi, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  secondaryText: { color: colors.text, fontSize: 17, fontWeight: '600' },
  disabled: { opacity: 0.6 },
  link: { paddingVertical: 12, alignItems: 'center' },
  linkText: { color: colors.accent, fontSize: 16 },
  error: { color: colors.danger, fontSize: 15, lineHeight: 21 },
  scanOverlay: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 32,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(20,19,18,0.85)',
    gap: 8,
    alignItems: 'center',
  },
});
