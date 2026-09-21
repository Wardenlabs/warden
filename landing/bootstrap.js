// Recover readable content when the enhancement module fails to load.
document.documentElement.classList.add('js');
setTimeout(() => {
  if (!window.__wardenReady) document.documentElement.classList.remove('js');
}, 2500);

if (location.hostname === 'warden-theta.vercel.app' &&
    !['1', 'yes'].includes(String(navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack))) {
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  const script = document.createElement('script');
  script.defer = true;
  script.src = '/_vercel/insights/script.js';
  document.head.append(script);
}
