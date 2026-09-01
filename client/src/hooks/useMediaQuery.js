import { useCallback, useSyncExternalStore } from 'react';

// matchMedia is an external store, so this is what useSyncExternalStore is for:
// it subscribes and reads without an effect, and cannot tear between renders.
//
// The layout is chosen in JS rather than by rendering both variants and hiding
// one with CSS - `display: none` still leaves the markup in source order, so a
// screen reader would read every row twice.
export default function useMediaQuery(query) {
  const subscribe = useCallback(
    (onChange) => {
      // jsdom and older browsers may not implement matchMedia. Returning a no-op
      // unsubscribe leaves the snapshot at its default rather than crashing.
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};

      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query]
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  }, [query]);

  // Server snapshot: the wide layout is the safe default.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
