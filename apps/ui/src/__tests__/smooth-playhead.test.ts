import { describe, expect, it } from 'vitest';
import { smoothPlayhead } from '../components/smoothPlayhead';

describe('playhead smoothing', () => {
  const previous = { position: 1000, time: 100, revision: 1 };
  it('absorbs small clock corrections without moving backwards', () => {
    expect(smoothPlayhead(900, 116, previous, true, 1)).toBe(1016);
    expect(smoothPlayhead(1200, 116, previous, true, 1)).toBe(1016);
  });
  it('responds immediately to seeks, pause, large jumps and resumed frames', () => {
    expect(smoothPlayhead(2000, 116, previous, true, 2)).toBe(2000);
    expect(smoothPlayhead(900, 116, previous, false, 1)).toBe(900);
    expect(smoothPlayhead(7000, 116, previous, true, 1)).toBe(7000);
    expect(smoothPlayhead(3000, 1200, previous, true, 1)).toBe(3000);
  });
});
