// Touch navigation leaves text controls, horizontal scrollers and vertical
// scrolling alone. Native browser back uses the same guarded app transition.
export function installBackNavigation({ target, canBack, back, report = () => {}, now = () => Date.now() }) {
  const doc = target.document, history = target.history, marker = 'fengweiBackLayer';
  let active = !!history.state?.[marker], busy = false, ignorePop = false, touch = null, suppressClickUntil = 0;
  function sync() {
    if (busy || ignorePop) return;
    if (canBack() && !active) { history.pushState({ ...history.state, [marker]: true }, '', target.location.href); active = true; }
    else if (!canBack() && active) { active = false; ignorePop = true; history.back(); }
  }
  async function go() {
    if (busy || !canBack()) return;
    busy = true;
    try { await back(); } catch (error) { report(error); }
    finally { busy = false; sync(); }
  }
  async function pop(event) {
    if (ignorePop) { ignorePop = false; sync(); return; }
    if (event.state?.[marker]) { active = true; sync(); return; }
    if (!active) return;
    active = false; await go();
  }
  const blocked = node => {
    if (node.closest('input,textarea,select,button,a,[contenteditable="true"],[role="slider"],[data-no-swipe]')) return true;
    for (let el = node; el && el !== doc.body; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 8 && ['auto', 'scroll'].includes(target.getComputedStyle(el).overflowX)) return true;
    }
    return false;
  };
  function start(event) {
    touch = null;
    if (busy || !canBack() || event.touches.length !== 1 || blocked(event.target)) return;
    const point = event.touches[0];
    // The first 24 px belong to Safari's native back gesture, handled by popstate.
    if (point.clientX < 24 || target.visualViewport?.scale > 1.01) return;
    touch = { x: point.clientX, y: point.clientY, at: now(), locked: false };
  }
  function move(event) {
    if (!touch) return;
    if (event.touches.length !== 1) { touch = null; return; }
    const point = event.touches[0], dx = point.clientX - touch.x, dy = point.clientY - touch.y;
    if (!touch.locked && (Math.abs(dy) > 12 || dx < -12)) { touch = null; return; }
    if (dx > 18 && dx > Math.abs(dy) * 2) touch.locked = true;
    if (touch.locked && event.cancelable) event.preventDefault();
  }
  function end(event) {
    const gesture = touch; touch = null;
    if (!gesture || event.touches.length || !event.changedTouches.length) return;
    const point = event.changedTouches[0], dx = point.clientX - gesture.x, dy = point.clientY - gesture.y;
    if (gesture.locked && dx >= 80 && dx > Math.abs(dy) * 2 && now() - gesture.at < 900) {
      suppressClickUntil = now() + 400; void go();
    }
  }
  target.addEventListener('popstate', pop);
  doc.addEventListener('touchstart', start, { passive: true });
  doc.addEventListener('touchmove', move, { passive: false });
  doc.addEventListener('touchend', end, { passive: true });
  doc.addEventListener('touchcancel', () => { touch = null; }, { passive: true });
  doc.addEventListener('click', event => { if (now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  return { sync, back: go };
}
