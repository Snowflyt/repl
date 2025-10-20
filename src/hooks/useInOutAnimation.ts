import { useCallback, useEffect, useState } from "react";

interface UseInOutAnimationOptions {
  /** Duration in ms, should match CSS animation duration. */
  duration: number;
  /** Called when animation completes and component should unmount. */
  onClose?: () => void;
}

/**
 * Hook to manage in/out animations.
 * @returns
 *
 * @example
 * ```javascript
 * const { isClosing, isVisible, handleClose } = useInOutAnimation({
 *   duration: 200,
 *   onClose: () => setIsOpen(false),
 * });
 * ```
 */
function useInOutAnimation({ duration, onClose }: UseInOutAnimationOptions) {
  const [isClosing, setIsClosing] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  // Handle fade-in animation on mount
  useEffect(() => {
    // After a tiny delay, make it visible to trigger the animation
    const timer = requestAnimationFrame(() => {
      setIsVisible(true);
    });

    return () => cancelAnimationFrame(timer);
  }, []);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => onClose?.(), duration);
  }, [duration, onClose]);

  return { isClosing, isVisible, handleClose };
}

export default useInOutAnimation;
