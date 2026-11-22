import { createContext, useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

export const MermaidLiveContext = createContext<{
  active: string | null;
  setActive: Dispatch<SetStateAction<string | null>>;
  target: HTMLDivElement | null;
} | null>(null);

export function MermaidLiveLayout({ children, documentId, sourceMode }: {
  children: ReactNode;
  documentId: string;
  sourceMode: boolean;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(35);
  const layout = useRef<HTMLDivElement>(null);
  const resize = (percent: number) => setWidth(Math.max(20, Math.min(60, percent)));

  useEffect(() => setActive(null), [documentId, sourceMode]);

  return (
    <MermaidLiveContext.Provider value={{ active, setActive, target }}>
      <div ref={layout} className="flex flex-1 min-h-0 min-w-0">
        {children}
        {active && !sourceMode && (
          <aside aria-label="Mermaid live preview" style={{ width: width + "%" }}
            className="relative shrink-0 flex flex-col border-l border-border bg-bg-secondary print:hidden">
            <div role="separator" tabIndex={0} aria-label="Resize Mermaid preview"
              aria-orientation="vertical" aria-valuemin={20} aria-valuemax={60} aria-valuenow={Math.round(width)}
              className="absolute inset-y-0 left-0 w-2 cursor-col-resize touch-none hover:bg-bg-emphasis"
              onPointerDown={e => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerMove={e => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId) || !layout.current) return;
                const bounds = layout.current.getBoundingClientRect();
                resize(100 * (bounds.right - e.clientX) / bounds.width);
              }}
              onKeyDown={e => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                resize(width + (e.key === "ArrowLeft" ? 2 : -2));
              }}
            />
            <header className="flex items-center justify-between px-4 py-2 text-sm text-text-muted">
              Mermaid
              <button type="button" aria-label="Close Mermaid preview" className="px-2 rounded hover:bg-bg-emphasis"
                onClick={() => setActive(null)}>×</button>
            </header>
            <div ref={setTarget} className="flex-1 overflow-auto px-4 pb-4" />
          </aside>
        )}
      </div>
    </MermaidLiveContext.Provider>
  );
}
