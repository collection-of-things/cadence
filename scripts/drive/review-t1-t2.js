(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // T1: type in Albums search -> jumps to Songs, keeps text + focus.
  document.querySelectorAll('.side-row')[3].click();
  await wait(400);
  const input = document.querySelector('.lib-search input');
  input.focus();
  set(input, 'tone');
  await wait(700);
  const after = document.querySelector('.lib-search input');
  const t1 = {
    title: document.querySelector('.lib-head h1')?.textContent,
    value: after?.value,
    sameInput: after === input,
    focused: document.activeElement === after,
  };
  // T2: narrow window with the lyrics rail on (needs a playing track).
  await window.cadence.library.scan([__FOLDER__]);
  const tr = (await window.cadence.library.tracks({}))[0];
  await window.cadence.sendCommand({ kind: 'setQueue', items: [{ queueId: 'r1', track: tr }], startIndex: 0, autoplay: true });
  await wait(800);
  window.resizeTo(860, 700);
  await wait(600);
  const lyr = document.querySelector('.topbar [aria-label="Lyrics"]');
  if (lyr && lyr.getAttribute('aria-pressed') !== 'true') lyr.click();
  await wait(400);
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;width:var(--wco-right);height:1px';
  document.body.appendChild(probe);
  const wco = probe.getBoundingClientRect().width;
  probe.remove();
  const right = document.querySelector('.topbar > :last-child').getBoundingClientRect().right;
  const t2 = {
    innerWidth,
    hasRail: document.querySelector('.app').classList.contains('has-rail'),
    controlsStartAt: innerWidth - wco,
    ourRightEdge: right,
    clear: right <= innerWidth - wco,
  };
  return { t1, t2 };
})()
