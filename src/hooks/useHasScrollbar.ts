import { useEffect, useState } from "react";

/**
 * Hook to detect if an element has a scrollbar
 * @param elementRef Reference to the element to check
 * @param dependencies Array of dependencies that should trigger a recheck
 * @returns
 */
function useHasScrollbar<T extends HTMLElement>(
  elementRef: React.RefObject<T | null>,
  dependencies: readonly unknown[] = [],
) {
  const [hasScrollbar, setHasScrollbar] = useState(false);

  useEffect(() => {
    const checkForScrollbar = () => {
      const element = elementRef.current;
      if (!element) return;

      // Check if scrollbar is present (scrollHeight > clientHeight)
      const hasScroll = element.scrollHeight > element.clientHeight;
      setHasScrollbar(hasScroll);
    };

    // Check immediately and after a small delay to account for rendering
    checkForScrollbar();
    const timeoutId = setTimeout(checkForScrollbar, 100);

    // Use ResizeObserver to detect changes in element size
    const resizeObserver = new ResizeObserver(() => {
      // Small delay to ensure accurate measurement after resize
      setTimeout(checkForScrollbar, 50);
    });

    if (elementRef.current) resizeObserver.observe(elementRef.current);

    return () => {
      clearTimeout(timeoutId);
      resizeObserver.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elementRef, ...dependencies]);

  return hasScrollbar;
}

export default useHasScrollbar;
