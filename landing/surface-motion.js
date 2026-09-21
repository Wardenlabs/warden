// Motion illustrates the local example; it never performs a policy evaluation.
// Native radios and readable outcomes remain functional without this module.
const preference = matchMedia('(prefers-reduced-motion: reduce)');
const surfaces = [...document.querySelectorAll('[data-motion-surface]')];
let observer;
function observe() {
  observer?.disconnect();
  for (const surface of surfaces) surface.classList.remove('motion-visible');
  if (preference.matches || !('IntersectionObserver' in window)) return;
  observer = new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      target.classList.toggle('motion-visible', isIntersecting && !document.hidden && !preference.matches);
    }
  }, { threshold: .25 });
  for (const surface of surfaces) observer.observe(surface);
}
document.addEventListener('visibilitychange', observe);
preference.addEventListener('change', observe);
observe();
