import { useEffect, useState } from "react";

function measureScrollbarWidth(): number {
  // Create a temporary div with scrollbars
  const outer = document.createElement("div");
  outer.style.visibility = "hidden";
  outer.style.overflow = "scroll";
  document.body.appendChild(outer);

  // Create inner div
  const inner = document.createElement("div");
  outer.appendChild(inner);

  // Calculate the width difference
  const scrollbarWidth = outer.offsetWidth - inner.offsetWidth;

  // Clean up
  outer.parentNode?.removeChild(outer);

  return scrollbarWidth;
}

/**
 * Hook to measure the width of browser scrollbars
 * @returns Width of scrollbars in pixels
 */
function useScrollbarWidth(): number {
  const [scrollbarWidth, setScrollbarWidth] = useState(measureScrollbarWidth);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let rafId = 0;
    const update = () => setScrollbarWidth(measureScrollbarWidth());
    const onResize = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(update);
    };

    rafId = requestAnimationFrame(update);
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return scrollbarWidth;
}

export default useScrollbarWidth;
