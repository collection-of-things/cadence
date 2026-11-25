import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RouteCapabilities } from '@cadence/protocol';
import { session } from '../session';

// Server rendering reads zustand's server snapshot (the initial state); read
// the live store instead so each test's state is what renders.
vi.mock('../hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks')>();
  const { session: live } = await import('../session');
  return { ...actual, useUi: <T,>(selector: (s: ReturnType<typeof live.store.getState>) => T) => selector(live.store.getState()) };
});
import { Toasts } from '../components/Toasts';
import { playNeedsSignIn } from '../routes';
import viewsSource from '../components/provider/views.tsx?raw';

/**
 * Signed out of a route that needs an account, the listener is offered
 * sign-in — never a Play that can only fail, nor a "Try again" that cannot
 * help.
 */

const initial = session.store.getState();
afterEach(() => session.store.setState(initial, true));

function appleCapability(signedIn: boolean): RouteCapabilities {
  return {
    route: 'apple-musickit',
    state: signedIn ? 'ready' : 'unauthenticated',
    playback: {
      engine: 'provider-engine',
      canPlay: signedIn,
      canPause: true,
      canSeek: true,
      canNextPrevious: true,
      gapless: 'unknown',
      exclusiveOutput: 'no',
    },
    audio: { pcmAccess: 'no', eq: 'yes', replayGain: 'no' },
    visuals: { kind: 'ambient' },
    notes: [],
  };
}

describe('sign-in toast', () => {
  it('offers Sign in instead of "Try again" for an unauthenticated error', () => {
    session.store.setState({
      toasts: [{ id: 1, route: 'apple-musickit', message: 'Sign in to Apple Music to play full songs.', retriable: false, code: 'unauthenticated' }],
    });
    const html = renderToStaticMarkup(<Toasts />);
    expect(html).toContain('toast-action');
    expect(html).toContain('>Sign in<');
    expect(html).not.toContain('Try again');
  });

  it('keeps "Try again" for a retriable failure', () => {
    session.store.setState({
      toasts: [{ id: 2, route: 'local', message: 'play failed: x', retriable: true }],
    });
    const html = renderToStaticMarkup(<Toasts />);
    expect(html).toContain('Try again');
    expect(html).not.toContain('toast-action');
  });
});

describe('playNeedsSignIn', () => {
  const state = (cap?: RouteCapabilities) => ({ snapshot: initial.snapshot, capabilities: cap ? [cap] : [] });

  it('gates a signed-out route that reports it cannot play', () => {
    expect(playNeedsSignIn(state(appleCapability(false)), 'apple-musickit')).toBe(true);
  });

  it('does not gate a signed-in route', () => {
    expect(playNeedsSignIn(state(appleCapability(true)), 'apple-musickit')).toBe(false);
  });

  it('does not gate a signed-out route that can still play (YouTube Music)', () => {
    const ytm = { ...appleCapability(false), route: 'youtube-music' as const, playback: { ...appleCapability(false).playback, canPlay: true } };
    expect(playNeedsSignIn(state(ytm), 'youtube-music')).toBe(false);
  });

  it('does not gate an unavailable route (that is not a sign-in problem)', () => {
    const down = { ...appleCapability(false), state: 'unavailable' as const };
    expect(playNeedsSignIn(state(down), 'apple-musickit')).toBe(false);
  });

  it('does not gate a route that has not reported yet', () => {
    expect(playNeedsSignIn(state(), 'apple-musickit')).toBe(false);
    expect(playNeedsSignIn(state(appleCapability(false)), undefined)).toBe(false);
  });
});

describe('catalog Play buttons', () => {
  // These pages need a mounted catalog session; assert their wiring, as
  // ux-regressions.test.tsx does for other session-bound views.
  it('album/playlist and artist pages swap Play for Sign in to play while gated', () => {
    expect(viewsSource).toContain('playNeedsSignIn(s, container.route)');
    expect(viewsSource).toContain('playNeedsSignIn(s, artist.route)');
    expect(viewsSource.match(/Sign in to play/g)).toHaveLength(2);
    expect(viewsSource).toContain('session.signInRoute(container.route)');
    expect(viewsSource).toContain('session.signInRoute(artist.route)');
  });
});
