import { useEffect, useMemo, useRef, useState } from "react";
import { defaultThemeColors, useTheme } from "../../context/ThemeContext";
import { renderOfficialMermaid, usesOfficialMermaid } from "./officialMermaid";

interface MermaidRendererProps {
  code: string;
  retainLastValid?: boolean;
}

type Diagram = { imageUrl: string } | { svg: string };
type RenderResult = { source: string; diagram: Diagram | null; error: boolean };

export function MermaidRenderer({ code, retainLastValid = false }: MermaidRendererProps) {
  const { resolvedTheme, customColorsDark, customColorsLight } = useTheme();
  const customColors = resolvedTheme === "dark" ? customColorsDark : customColorsLight;
  const colors = useMemo(() => ({ ...defaultThemeColors[resolvedTheme], ...customColors }), [resolvedTheme, customColors]);
  const source = code.trim();
  const [result, setResult] = useState<RenderResult | null>(null);
  const lastValid = useRef<Diagram | null>(null);

  useEffect(() => {
    if (!source) {
      lastValid.current = null;
      setResult(null);
      return;
    }
    const request = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        let diagram: Diagram | null = null;
        if (usesOfficialMermaid(source)) {
          const svg = await renderOfficialMermaid(source, colors, resolvedTheme === "dark", request.signal);
          if (svg) diagram = { imageUrl: `data:image/svg+xml,${encodeURIComponent(svg)}` };
        }
        if (request.signal.aborted) return;
        if (!diagram) {
          const { renderMermaidSVG } = await import("beautiful-mermaid");
          if (request.signal.aborted) return;
          diagram = {
            svg: renderMermaidSVG(source, {
              bg: "var(--color-bg)",
              fg: "var(--color-text)",
              muted: "var(--color-text-muted)",
              border: "var(--color-border)",
              transparent: true,
            }),
          };
        }
        lastValid.current = diagram;
        setResult({ source, diagram, error: false });
      } catch {
        if (!request.signal.aborted) setResult({ source, diagram: null, error: true });
      }
    }, retainLastValid ? 120 : 0);
    return () => {
      request.abort();
      window.clearTimeout(timer);
    };
  }, [source, colors, resolvedTheme, retainLastValid]);

  const rendered = result?.source === source ? result : null;
  const visible = rendered?.diagram ?? (source && retainLastValid ? lastValid.current : null);
  const error = rendered?.error;
  const status = !source ? "Empty mermaid diagram"
    : error ? (visible ? "Syntax error · showing last valid diagram" : "Mermaid syntax error")
    : !visible ? "Rendering Mermaid…" : null;

  return (
    <>
      {status && (
        <p role="status" className="text-xs text-text-muted italic px-2 pt-4 text-center">
          {status}
        </p>
      )}
      {visible && (
        "imageUrl" in visible ? (
          <div className="mermaid-diagram flex justify-center py-2">
            <img alt="Mermaid diagram" src={visible.imageUrl} />
          </div>
        ) : (
          <div className="mermaid-diagram flex justify-center py-2"
            dangerouslySetInnerHTML={{ __html: visible.svg }} />
        )
      )}
    </>
  );
}
