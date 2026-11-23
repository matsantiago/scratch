import rendererUrl from "@mermaid-js/tiny/dist/mermaid.tiny.js?url";
import { parseCssColorToRgb } from "../../context/ThemeContext";
import type { ThemeColorKey } from "../../types/note";

interface OfficialMermaid {
  initialize(options: {
    startOnLoad: false;
    securityLevel: "strict";
    suppressErrorRendering: true;
    htmlLabels: false;
    theme: "base";
    look: "classic";
    fontFamily: string;
    flowchart: { useMaxWidth: false };
    themeVariables: Record<string, string | boolean | Record<string, string>>;
  }): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

type Palette = Record<ThemeColorKey, string>;

let renderer: Promise<OfficialMermaid | null> | undefined;
let rendering: Promise<unknown> = Promise.resolve();
let nextDiagramId = 0;

function loadRenderer(): Promise<OfficialMermaid | null> {
  renderer ??= new Promise(resolve => {
    const script = document.createElement("script");
    script.src = rendererUrl;
    script.onload = () => {
      script.remove();
      resolve((window as Window & { mermaid?: OfficialMermaid }).mermaid ?? null);
    };
    script.onerror = () => {
      script.remove();
      resolve(null);
    };
    document.head.append(script);
  });
  return renderer;
}

export function usesOfficialMermaid(source: string): boolean {
  const header = source
    .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
    .replace(/^\s*(?:(?:%%\{[\s\S]*?\}%%|%%[^\r\n]*)\s*)*/, "");
  return /^(?:(?:flowchart|graph)\b|treeView-beta(?:\s|$))/i.test(header);
}

function hexColor(value: string, fallback: string): string {
  const rgb = parseCssColorToRgb(value);
  return rgb ? "#" + rgb.map(channel => channel.toString(16).padStart(2, "0")).join("") : fallback;
}

export async function renderOfficialMermaid(
  source: string,
  colors: Palette,
  darkMode: boolean,
  signal: AbortSignal,
): Promise<string | null> {
  const mermaid = await loadRenderer();
  if (!mermaid || signal.aborted) return null;

  // Mermaid configuration is global, so keep each theme paired with its render.
  const task = rendering.then(async () => {
    if (signal.aborted) return null;
    const background = hexColor(colors.bg, darkMode ? "#161413" : "#ffffff");
    const surface = hexColor(colors["bg-secondary"], darkMode ? "#0e0c0b" : "#fafaf9");
    const text = hexColor(colors.text, darkMode ? "#fafaf9" : "#1c1917");
    const muted = hexColor(colors["text-muted"], darkMode ? "#a8a29e" : "#78716c");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      theme: "base",
      look: "classic",
      fontFamily: "system-ui, sans-serif",
      flowchart: { useMaxWidth: false },
      themeVariables: {
        darkMode,
        background,
        primaryColor: surface,
        primaryTextColor: text,
        primaryBorderColor: muted,
        lineColor: muted,
        clusterBkg: background,
        clusterBorder: muted,
        titleColor: text,
        edgeLabelBackground: surface,
        treeView: { labelColor: text, lineColor: muted, iconColor: muted, descriptionColor: muted },
      },
    });
    try {
      const { svg } = await mermaid.render("scratch-mermaid-" + ++nextDiagramId, source);
      return svg;
    } catch (error) {
      // Older WebViews may load the renderer but lack a browser API it uses.
      if (error instanceof TypeError || error instanceof ReferenceError) return null;
      throw error;
    }
  });
  rendering = task.catch(() => {});
  return task;
}
