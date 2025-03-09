import { useEffect, useState } from "react";

/**
 * Hook to measure the width of browser scrollbars
 * @returns Width of scrollbars in pixels
 */
function useScrollbarWidth(): number {
  const [scrollbarWidth, setScrollbarWidth] = useState(0);

  useEffect(() => {
    // Function to measure scrollbar width
    const getScrollbarWidth = (): number => {
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
    };

    // Set the scrollbar width
    setScrollbarWidth(getScrollbarWidth());
  }, []);

  return scrollbarWidth;
}

export default useScrollbarWidth;
