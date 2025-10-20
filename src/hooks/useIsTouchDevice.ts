import { useEffect, useState } from "react";

function isTouchDevice() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const mql = window.matchMedia?.("(pointer: coarse)");
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (mql) return mql.matches;
  } catch {
    // Ignore
  }
  // Fallbacks
  const nav: any = navigator;
  return (
    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) ||
    nav?.msMaxTouchPoints > 0 ||
    "ontouchstart" in window
  );
}

function useIsTouchDevice() {
  const [isTouch, setIsTouch] = useState(isTouchDevice);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!window.matchMedia) return;

    const mql = window.matchMedia("(pointer: coarse)");

    // Listen for changes (e.g., when connecting/disconnecting input devices)
    const onChange = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    const onChangeLegacy = () => setIsTouch(mql.matches);

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
      // eslint-disable-next-line @typescript-eslint/no-deprecated
    } else if (typeof mql.addListener === "function") {
      // For old Safari
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      mql.addListener(onChangeLegacy);
      return () => {
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        mql.removeListener(onChangeLegacy);
      };
    }
  }, []);

  return isTouch;
}

export default useIsTouchDevice;
