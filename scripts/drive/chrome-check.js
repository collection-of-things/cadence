(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bar = document.querySelector('.topbar');
  const css = getComputedStyle(bar);
  const wco = getComputedStyle(document.documentElement).getPropertyValue('--wco-right');
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;width:var(--wco-right);height:1px';
  document.body.appendChild(probe);
  const wcoPx = probe.getBoundingClientRect().width;
  probe.remove();
  const right = document.querySelector('.topbar > :last-child').getBoundingClientRect().right;
  // Navigate to Songs and list the animations that run.
  document.querySelectorAll('.side-row')[2]?.click();
  await wait(60);
  const anims = [...new Set(document.getAnimations().map((a) => a.animationName))];
  await wait(1500);
  window.focus();
  return {
    windowWidth: innerWidth,
    wcoVar: wco.trim(),
    wcoPx,
    topbarPaddingRight: css.paddingRight,
    rightGroupRightEdge: right,
    appRegion: css.getPropertyValue('-webkit-app-region') || css.webkitAppRegion,
    animationsAfterNav: anims,
  };
})()
