import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { PairScreen } from './src/PairScreen';
import { PlayerScreen } from './src/PlayerScreen';
import { forgetHost, loadHost, saveHost, type SavedHost } from './src/savedHost';
import { colors } from './src/theme';

type Boot = { kind: 'loading' } | { kind: 'unpaired'; notice: string | null } | { kind: 'paired'; host: SavedHost };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });

  useEffect(() => {
    void loadHost().then((host) => setBoot(host === null ? { kind: 'unpaired', notice: null } : { kind: 'paired', host }));
  }, []);

  const onPaired = useCallback((host: SavedHost) => {
    void saveHost(host);
    setBoot({ kind: 'paired', host });
  }, []);
  const onHostChanged = useCallback((host: SavedHost) => {
    void saveHost(host);
  }, []);
  const onForget = useCallback(() => {
    void forgetHost();
    setBoot({ kind: 'unpaired', notice: null });
  }, []);
  const onRevoked = useCallback(() => {
    void forgetHost();
    setBoot({ kind: 'unpaired', notice: 'The computer removed this phone. Pair again to reconnect.' });
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        <StatusBar style="light" />
        {boot.kind === 'loading' && <View style={styles.root} />}
        {boot.kind === 'unpaired' && <PairScreen onPaired={onPaired} notice={boot.notice} />}
        {boot.kind === 'paired' && (
          <PlayerScreen
            key={`${boot.host.hostId}:${boot.host.token}`}
            host={boot.host}
            onHostChanged={onHostChanged}
            onForget={onForget}
            onRevoked={onRevoked}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
