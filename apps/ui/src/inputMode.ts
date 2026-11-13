/**
 * Tracks whether the listener is driving the app with the keyboard, as
 * <html data-input="keyboard">. Focus rings are styled only under that
 * attribute (styles.css), so focus the app moves on its own, such as into a
 * sheet that just opened, never draws one. Tab turns it on; any pointer
 * press turns it off. Call once at startup.
 */
export function trackInputMode(): void {
  const root = document.documentElement;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Tab') root.dataset.input = 'keyboard';
    },
    true,
  );
  window.addEventListener('pointerdown', () => delete root.dataset.input, true);
}
