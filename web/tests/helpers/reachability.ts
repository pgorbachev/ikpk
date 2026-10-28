/**
 * Shared full-rectangle visibility check for page content. Keep this callback
 * self-contained: Playwright serializes it into the browser for evaluate().
 */
export function measureFullReachability(el: HTMLElement, launcherSelector?: string) {
  const r = el.getBoundingClientRect();
  const clips = [{ left: 0, top: 0, right: innerWidth, bottom: innerHeight }];
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipX = /(hidden|clip|scroll|auto)/.test(style.overflowX);
    const clipY = /(hidden|clip|scroll|auto)/.test(style.overflowY);
    if (!clipX && !clipY) continue;
    const bounds = parent.getBoundingClientRect();
    clips.push({
      left: clipX ? bounds.left : -Infinity,
      right: clipX ? bounds.right : Infinity,
      top: clipY ? bounds.top : -Infinity,
      bottom: clipY ? bounds.bottom : Infinity,
    });
  }
  const fullRectVisible = r.width > 0 && r.height > 0 && clips.every((clip) =>
    r.left >= clip.left - 1 && r.right <= clip.right + 1
      && r.top >= clip.top - 1 && r.bottom <= clip.bottom + 1);
  const launcher = launcherSelector ? document.querySelector<HTMLElement>(launcherSelector)?.getBoundingClientRect() : null;
  const fullRectOutsideLauncher = !launcher || r.right <= launcher.left || r.left >= launcher.right
    || r.bottom <= launcher.top || r.top >= launcher.bottom;
  const points = [
    [r.left + r.width * .1, r.top + r.height * .1], [r.left + r.width * .5, r.top + r.height * .5],
    [r.left + r.width * .9, r.top + r.height * .9],
  ];
  const hitTestable = points.some(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (hit === el || el.contains(hit))
      && (!launcher || x < launcher.left || x > launcher.right || y < launcher.top || y > launcher.bottom));
  });
  return { fullRectVisible, fullRectOutsideLauncher, hitTestable };
}
