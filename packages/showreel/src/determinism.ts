// Imported before any web module. The web app animates only under
// `(prefers-reduced-motion: no-preference)` (GSAP matchMedia, slideIn, Stat count-up). In the film
// every motion is driven by the frame instead, so the page reports reduced motion: the real
// components render their settled state and never start a wall-clock animation. Scrolling an
// element into view would move the whole stage, so it is a no-op here.
const original = window.matchMedia.bind(window);

window.matchMedia = (query: string): MediaQueryList => {
  const q = query.replace(/\s+/g, " ").toLowerCase();
  const reduce = q.includes("prefers-reduced-motion: reduce");
  const motionOk = q.includes("prefers-reduced-motion: no-preference");
  if (!reduce && !motionOk) return original(query);
  const matches = reduce;
  return {
    matches,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  } as MediaQueryList;
};

Element.prototype.scrollIntoView = function scrollIntoView() {
  /* the camera decides what is on screen */
};

export {};
