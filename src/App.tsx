import { useEffect, useRef, useState } from "react";

import HistoryArea from "./components/HistoryArea";
import type { InputAreaRef } from "./components/InputArea";
import InputArea from "./components/InputArea";
import LoadingOverlay from "./components/LoadingOverlay";
import sandboxStore, { useSandboxStore } from "./stores/sandbox";

const App: React.FC = () => {
  const [inputHistoryIndex, setInputHistoryIndex] = useState(-1);

  const isLoading = useSandboxStore((state) => state.isLoading);
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    const loadingTimer = setTimeout(() => {
      setShowLoading(true);
    }, 500);

    sandboxStore
      .load()
      .catch(() => {
        alert("Failed to load JavaScript/TypeScript runtime");
      })
      .finally(() => {
        clearTimeout(loadingTimer);
        setShowLoading(false);
        setTimeout(() => inputAreaRef.current?.focus(), 100);
      });

    return () => clearTimeout(loadingTimer);
  }, []);

  const inputAreaRef = useRef<InputAreaRef>(null);

  return (
    <div className="flex h-screen flex-col bg-[#1a1520] bg-[radial-gradient(ellipse_at_top_right,#4d2535_5%,transparent_50%),radial-gradient(circle_at_30%_80%,#2d1f25_0%,transparent_40%),radial-gradient(circle_at_70%_60%,#3d2530_0%,transparent_40%),linear-gradient(45deg,#1a1520_30%,#251a25_70%,#1a1520_100%)]">
      {isLoading && showLoading && <LoadingOverlay />}

      <HistoryArea inputAreaRef={inputAreaRef} onJumpToInputHistory={setInputHistoryIndex} />
      <InputArea
        ref={inputAreaRef}
        inputHistoryIndex={inputHistoryIndex}
        onInputHistoryIndexChange={setInputHistoryIndex}
      />
    </div>
  );
};

export default App;
