import { Icon } from "@iconify/react";

const LoadingOverlay: React.FC = () => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 text-gray-100">
    <div className="mb-12 rounded-lg border border-[#3d2530] bg-[#1a1520]/70 px-6 py-4 shadow-lg backdrop-blur-sm">
      <div className="flex flex-row items-center space-x-3">
        <Icon icon="svg-spinners:180-ring" className="size-4" />
        <div className="text-gray-400">Loading JavaScript/TypeScript runtime...</div>
      </div>
    </div>
  </div>
);

export default LoadingOverlay;
