import { useEffect, useState } from "react";

function useIsTouchDevice() {
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    // Initialize based on touch capability
    const touchQuery = window.matchMedia("(pointer: coarse)");
    setIsTouch(touchQuery.matches);

    // Listen for changes (e.g., when connecting/disconnecting input devices)
    const updateIsTouch = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    touchQuery.addEventListener("change", updateIsTouch);

    return () => touchQuery.removeEventListener("change", updateIsTouch);
  }, []);

  return isTouch;
}

export default useIsTouchDevice;
