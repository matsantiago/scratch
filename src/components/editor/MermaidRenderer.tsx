import { useEffect, useMemo, useRef } from "react";
import { renderMermaidSVG } from "beautiful-mermaid";

interface MermaidRendererProps {
  code: string;
  retainLastValid?: boolean;
}

export function MermaidRenderer({ code, retainLastValid = false }: MermaidRendererProps) {
  const { svg, error } = useMemo(() => {
    if (!code.trim()) return { svg: null, error: null };
    try {
      return {
        svg: renderMermaidSVG(code.trim(), {
          bg: "var(--color-bg)",
          fg: "var(--color-text)",
          muted: "var(--color-text-muted)",
          border: "var(--color-border)",
          transparent: true,
        }),
        error: null,
      };
    } catch (err) {
      return {
        svg: null,
        error: err instanceof Error ? err.message : "Invalid mermaid syntax",
      };
    }
  }, [code]);

  const lastValid = useRef<string | null>(null);
  useEffect(() => {
    if (svg || !code.trim()) lastValid.current = svg;
  }, [svg, code]);
  const visibleSvg = svg ?? (error && retainLastValid ? lastValid.current : null);

  return (
    <>
      {(error || !code.trim()) && (
        <p role="status" className="text-xs text-text-muted italic px-2 pt-4 text-center">
          {error ? (visibleSvg ? "Syntax error · showing last valid diagram" : "Mermaid syntax error") : "Empty mermaid diagram"}
        </p>
      )}
      {visibleSvg && (
        <div className="mermaid-diagram flex justify-center py-2"
          dangerouslySetInnerHTML={{ __html: visibleSvg }} />
      )}
    </>
  );
}
