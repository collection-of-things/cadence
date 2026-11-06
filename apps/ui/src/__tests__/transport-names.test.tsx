import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlayerBar } from '../components/PlayerBar';
import appShellSource from '../App.tsx?raw';
import nowPlayingSource from '../components/NowPlaying.tsx?raw';

/**
 * Regression for the transport-name collision: controls whose accessible
 * names contained "play" — "Play album", "Play <track> next", "Show now
 * playing" — sat ahead of the transport in DOM order, so a name-driven
 * "Play" (automation, voice control, AT) activated them instead of the
 * transport. That surfaced as "Play does nothing" and "Play replays the
 * album" in e2e driving.
 *
 * Contract under test: the transport Play is the first play-named control
 * in the document. The player bar leads the shell and its transport zone
 * leads the bar (both position:fixed — visuals unaffected); remaining
 * play-named controls (album actions, now-playing expand) must not carry
 * a stray "play" name or must sit behind it.
 *
 * SSR markup only sees the store's initial state, so invariants that need
 * a live session are asserted on the component sources instead.
 */

/** aria-label + text snippets of every <button> in rendered markup. */
function buttonNames(html: string): string[] {
  const names: string[] = [];
  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
    const tag = m[0];
    const aria = tag.match(/aria-label="([^"]*)"/)?.[1];
    const text = m[1]?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    names.push(aria ?? text ?? '');
  }
  return names;
}

describe('transport accessible names', () => {
  it('player bar: the transport is the first play-named button', () => {
    const html = renderToStaticMarkup(<PlayerBar />);
    const names = buttonNames(html);
    expect(names.length).toBeGreaterThan(0);
    const playNamed = names.filter((n) => /play/i.test(n));
    expect(playNamed[0]).toBe('Play');
  });

  it('now playing: the expand control is not play-named', () => {
    const expand = nowPlayingSource.match(/className="np-expand"[\s\S]{0,400}?aria-label="([^"]*)"/);
    expect(expand).not.toBeNull();
    expect(expand![1]).not.toMatch(/play/i);
  });

  it('app shell: the player bar precedes page content in DOM order', () => {
    // The transport must outrank "Play album"/"Play <track> next" for
    // name-driven activation — the fixed player bar leads the shell.
    const bar = appShellSource.indexOf('<PlayerBar');
    const main = appShellSource.indexOf('<main');
    expect(bar).toBeGreaterThan(-1);
    expect(main).toBeGreaterThan(-1);
    expect(bar).toBeLessThan(main);
  });
});
