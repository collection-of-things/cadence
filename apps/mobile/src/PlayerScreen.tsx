import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  AppState,
  FlatList,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import type { QueueItem, TrackRef } from '@cadence/protocol';
import { DesktopLink, projectedPositionMs, type LinkState } from './desktopLink';
import { PhoneRemote } from './phoneRemote';
import { PhoneSession, type PhoneState } from './phoneSession';
import type { SavedHost } from './savedHost';
import { colors, radius } from './theme';
import {
  artistLine,
  artworkUri,
  formatTime,
  isStreamable,
  orderIndexOf,
  playOrder,
  providerLink,
} from './tracks';

/** How long to wait for the computer to start a handed-back track before seeking. */
const HANDBACK_TIMEOUT_MS = 8000;

function useTicker(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [active]);
}

/** Resolve once the computer reports `queueId` playing, or after the timeout. */
function waitForDesktopPlaying(link: DesktopLink, queueId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      const s = link.getState().snapshot;
      return s?.current?.queueId === queueId && s.status === 'playing';
    };
    if (check()) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, HANDBACK_TIMEOUT_MS);
    const off = link.subscribe(() => {
      if (!check()) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

export function PlayerScreen({
  host,
  onHostChanged,
  onForget,
  onRevoked,
}: {
  host: SavedHost;
  onHostChanged(host: SavedHost): void;
  onForget(): void;
  onRevoked(): void;
}) {
  // One link and one phone session per paired host; App remounts this screen on re-pair.
  const [link] = useState(() => new DesktopLink(host, onHostChanged));
  const [phone] = useState(() => new PhoneSession());
  const [note, setNote] = useState<string | null>(null);
  // Ownership (reports, handoff, control, release) lives in PhoneRemote; the
  // computer stops the phone itself when someone presses play there.
  const [remote] = useState(() => new PhoneRemote(link, phone, setNote));
  const ls = useSyncExternalStore(link.subscribe, link.getState);
  const ps = useSyncExternalStore(phone.subscribe, phone.getState);

  useEffect(() => {
    link.start();
    const offMessages = link.subscribeMessages((msg) => remote.handle(msg));
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') link.poke();
    });
    return () => {
      sub.remove();
      offMessages();
      remote.dispose();
      link.stop();
      phone.stop();
    };
  }, [link, phone, remote]);

  useEffect(() => {
    if (ls.connection === 'revoked') onRevoked();
  }, [ls.connection, onRevoked]);

  useTicker(ls.snapshot?.status === 'playing' && !ps.active);

  const onPhone = ps.active;
  const desktopOrder = ls.queue === null ? [] : playOrder(ls.queue);
  const desktopIndex = ls.queue === null ? -1 : orderIndexOf(ls.queue, ls.snapshot?.current?.queueId);
  const current: QueueItem | null = onPhone ? phone.current() : (ls.snapshot?.current ?? null);
  const items = onPhone ? ps.items : desktopOrder;
  const index = onPhone ? ps.index : desktopIndex;
  const positionMs = onPhone ? ps.positionMs : projectedPositionMs(ls);
  const durationMs = onPhone ? ps.durationMs : (ls.snapshot?.durationMs ?? current?.track.durationMs ?? 0);
  const playing = onPhone ? ps.playing : ls.snapshot?.status === 'playing';

  const takeOver = async () => {
    setNote(null);
    if (ls.base === null || ls.queue === null || current === null) return;
    const pos = projectedPositionMs(ls);
    if (!isStreamable(current.track)) {
      const target = providerLink(current.track, pos);
      if (target === null) {
        setNote('This song cannot be opened on the phone.');
        return;
      }
      link.send({ kind: 'pause' });
      await Linking.openURL(target.url).catch(() => setNote(`Could not open ${target.label.replace('Open in ', '')}.`));
      return;
    }
    const result = await remote.takeOver();
    if (result === 'unavailable') setNote('The phone could not take over right now.');
  };

  const handBack = async () => {
    setNote(null);
    const item = phone.current();
    const pos = ps.positionMs;
    phone.stop();
    if (item === null) return;
    link.send({ kind: 'play', queueId: item.queueId });
    const started = await waitForDesktopPlaying(link, item.queueId);
    if (started && pos > 1000) link.send({ kind: 'seek', positionMs: pos });
    if (!started) setNote('The computer did not start that song. It may have left the queue.');
  };

  const toggle = () => {
    if (onPhone) phone.toggle();
    else link.send(playing ? { kind: 'pause' } : { kind: 'resume' });
  };
  const next = () => (onPhone ? phone.next() : link.send({ kind: 'next' }));
  const previous = () => (onPhone ? phone.previous() : link.send({ kind: 'previous' }));
  const seek = (ms: number) => (onPhone ? phone.seek(ms) : link.send({ kind: 'seek', positionMs: ms }));
  const jump = (i: number) => {
    if (onPhone) phone.jump(i);
    else {
      const item = items[i];
      if (item !== undefined) link.send({ kind: 'play', queueId: item.queueId });
    }
  };

  const art = current === null ? null : artworkUri(ls.base, current.track, link.token);
  const blocked = onPhone ? ps.stoppedAt : null;
  const blockedLink = blocked === null ? null : providerLink(blocked.track, 0);
  const phoneLabel = current !== null && !isStreamable(current.track) ? (providerLink(current.track, 0)?.label ?? 'This phone') : 'This phone';

  return (
    <View style={styles.page}>
      <Header name={host.name} state={ls} onForget={onForget} />
      <FlatList
        data={items}
        keyExtractor={(i) => i.queueId}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.now}>
            <Artwork uri={art} />
            <Text style={styles.title} numberOfLines={2}>
              {current?.track.title ?? (ls.connection === 'online' ? 'Nothing playing' : ' ')}
            </Text>
            <Text style={styles.artist} numberOfLines={1}>
              {current === null ? ' ' : artistLine(current.track)}
            </Text>
            <Progress positionMs={positionMs} durationMs={durationMs} onSeek={seek} disabled={current === null} />
            <View style={styles.controls}>
              <ControlButton label="⏮" a11y="Previous" onPress={previous} />
              <ControlButton label={playing ? '⏸' : '▶'} a11y={playing ? 'Pause' : 'Play'} onPress={toggle} big />
              <ControlButton label="⏭" a11y="Next" onPress={next} />
            </View>
            <View style={styles.seg} accessibilityRole="radiogroup">
              <SegButton label="Computer" on={!onPhone} onPress={() => void (onPhone ? handBack() : undefined)} />
              <SegButton
                label={phoneLabel}
                on={onPhone}
                disabled={ls.connection !== 'online' || current === null}
                onPress={() => void (onPhone ? undefined : takeOver())}
              />
            </View>
            {blocked !== null && (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>“{blocked.track.title}” is from a streaming service, so the phone stopped here.</Text>
                {blockedLink !== null && (
                  <Pressable onPress={() => void Linking.openURL(blockedLink.url)}>
                    <Text style={styles.linkText}>{blockedLink.label}</Text>
                  </Pressable>
                )}
              </View>
            )}
            {note !== null && <Text style={styles.noteText}>{note}</Text>}
            {ps.error !== null && <Text style={styles.errorText}>{ps.error}</Text>}
            {items.length > 0 && <Text style={styles.section}>Queue</Text>}
          </View>
        }
        renderItem={({ item, index: i }) => <QueueRow item={item} active={i === index} onPress={() => jump(i)} />}
      />
    </View>
  );
}

function Header({ name, state, onForget }: { name: string; state: LinkState; onForget(): void }) {
  const dot =
    state.connection === 'online' ? colors.ok : state.connection === 'connecting' ? colors.accent : colors.danger;
  const line =
    state.connection === 'online'
      ? 'Connected'
      : state.connection === 'connecting'
        ? 'Connecting…'
        : (state.lastError ?? 'Offline');
  return (
    <View style={styles.header}>
      <View style={styles.headerTxt}>
        <Text style={styles.hostName} numberOfLines={1}>
          {name}
        </Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: dot }]} />
          <Text style={styles.statusText} numberOfLines={2}>
            {line}
          </Text>
        </View>
      </View>
      <Pressable onPress={onForget} hitSlop={10} accessibilityRole="button">
        <Text style={styles.linkText}>Unpair</Text>
      </Pressable>
    </View>
  );
}

function Artwork({ uri }: { uri: string | null }) {
  return (
    <View style={styles.art}>
      {uri !== null && <Image source={{ uri }} style={styles.artImg} resizeMode="cover" />}
    </View>
  );
}

function Progress({
  positionMs,
  durationMs,
  onSeek,
  disabled,
}: {
  positionMs: number;
  durationMs: number;
  onSeek(ms: number): void;
  disabled: boolean;
}) {
  const [width, setWidth] = useState(0);
  const frac = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const onPress = (e: GestureResponderEvent) => {
    if (width <= 0 || durationMs <= 0) return;
    onSeek(Math.round((e.nativeEvent.locationX / width) * durationMs));
  };
  return (
    <View style={styles.progressWrap}>
      <Pressable
        disabled={disabled}
        onPress={onPress}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        style={styles.track}
        accessibilityRole="adjustable"
        accessibilityLabel="Position"
      >
        <View style={[styles.fill, { width: `${frac * 100}%` }]} />
      </Pressable>
      <View style={styles.times}>
        <Text style={styles.time}>{formatTime(positionMs)}</Text>
        <Text style={styles.time}>{formatTime(durationMs)}</Text>
      </View>
    </View>
  );
}

function ControlButton({ label, a11y, onPress, big }: { label: string; a11y: string; onPress(): void; big?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => [big ? styles.ctrlBig : styles.ctrl, pressed && styles.pressed]}
    >
      <Text style={big ? styles.ctrlBigText : styles.ctrlText}>{label}</Text>
    </Pressable>
  );
}

function SegButton({ label, on, onPress, disabled }: { label: string; on: boolean; onPress(): void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled === true}
      accessibilityRole="radio"
      accessibilityState={{ checked: on, disabled: disabled === true }}
      style={[styles.segBtn, on && styles.segOn, disabled === true && styles.disabled]}
    >
      <Text style={[styles.segText, on && styles.segTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function sourceTag(track: TrackRef): string {
  switch (track.provider) {
    case 'local':
      return '';
    case 'spotify':
      return 'Spotify';
    case 'apple':
      return 'Apple Music';
    case 'youtube':
      return 'YouTube Music';
    default: {
      const _exhaustive: never = track.provider;
      return _exhaustive;
    }
  }
}

function QueueRow({ item, active, onPress }: { item: QueueItem; active: boolean; onPress(): void }) {
  const tag = sourceTag(item.track);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.rowTxt}>
        <Text style={[styles.rowTitle, active && styles.rowActive]} numberOfLines={1}>
          {item.track.title}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {artistLine(item.track)}
          {tag ? ` · ${tag}` : ''}
        </Text>
      </View>
      <Text style={styles.rowTime}>{formatTime(item.track.durationMs)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, gap: 12 },
  headerTxt: { flex: 1, minWidth: 0 },
  hostName: { color: colors.text, fontSize: 17, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: colors.text2, fontSize: 13, flexShrink: 1 },
  list: { paddingHorizontal: 20, paddingBottom: 40 },
  now: { alignItems: 'stretch', paddingTop: 8 },
  art: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  artImg: { width: '100%', height: '100%' },
  title: { color: colors.text, fontSize: 24, fontWeight: '700', marginTop: 20, letterSpacing: -0.3 },
  artist: { color: colors.text2, fontSize: 17, marginTop: 4 },
  progressWrap: { marginTop: 18 },
  track: { height: 24, justifyContent: 'center' },
  fill: { height: 4, borderRadius: 2, backgroundColor: colors.accent },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { color: colors.text3, fontSize: 12, fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 28, marginTop: 12 },
  ctrl: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center', borderRadius: 28 },
  ctrlText: { color: colors.text, fontSize: 28 },
  ctrlBig: {
    width: 72,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 36,
    backgroundColor: colors.text,
  },
  ctrlBigText: { color: colors.bg, fontSize: 30 },
  pressed: { opacity: 0.6 },
  seg: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 4,
    marginTop: 24,
  },
  segBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: radius.sm },
  segOn: { backgroundColor: colors.surfaceHi },
  segText: { color: colors.text2, fontSize: 15, fontWeight: '600' },
  segTextOn: { color: colors.text },
  disabled: { opacity: 0.45 },
  notice: { marginTop: 16, padding: 14, borderRadius: radius.md, backgroundColor: colors.surface, gap: 8 },
  noticeText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  noteText: { color: colors.text2, fontSize: 14, marginTop: 12, lineHeight: 20 },
  errorText: { color: colors.danger, fontSize: 14, marginTop: 12 },
  linkText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  section: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 28, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12 },
  rowTxt: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 16 },
  rowActive: { color: colors.accent, fontWeight: '600' },
  rowSub: { color: colors.text3, fontSize: 13, marginTop: 2 },
  rowTime: { color: colors.text3, fontSize: 13, fontVariant: ['tabular-nums'] },
});
