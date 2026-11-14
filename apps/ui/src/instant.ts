/**
 * Run a state change with transitions switched off. Keyboard shortcuts use
 * this: they repeat many times a day, so the result must land on the next
 * frame. The same change made with the pointer keeps its motion.
 * CSS opts surfaces in with `:root[data-instant]` (motion.css).
 */
export function withoutMotion(change: () => void): void {
  const root = document.documentElement;
  root.dataset.instant = '';
  change();
  // Two frames: React commits the change, then the browser styles it with motion off.
  requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.instant));
}
