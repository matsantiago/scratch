import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useNotes } from "../../context/NotesContext";
import { useTheme } from "../../context/ThemeContext";
import { Button } from "../ui";
import { isWindows } from "../../lib/platform";

export function FolderPicker() {
  const { setNotesFolder, error } = useNotes();
  const { reloadSettings } = useTheme();

  const [recent, setRecent] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    invoke<string | null>("get_recent_folder").then(setRecent).catch(console.error);
  }, []);

  const openFolder = async (folder: string) => {
    setOpening(true);
    try {
      await setNotesFolder(folder);
      await reloadSettings();
    } catch (err) {
      console.error("Could not open folder:", err);
    } finally {
      setOpening(false);
    }
  };

  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose Notes Folder",
      });

      if (selected && typeof selected === "string") {
        await openFolder(selected);
      }
    } catch (err) {
      console.error("Failed to select folder:", err);
    }
  };

  return (
    <div className="h-full flex flex-col bg-bg-secondary">
      {/* Draggable title bar area */}
      {!isWindows && <div className="h-10 shrink-0" data-tauri-drag-region />}

      <div className="flex-1 flex items-center justify-center">
        <div className="text-center p-8 max-w-lg select-none">
          <div
            role="img"
            aria-label="Folders"
            className="w-48 aspect-square mx-auto mb-2 opacity-40 animate-fade-in-up"
            style={{
              animationDelay: "0ms",
              backgroundColor: "var(--color-text)",
              WebkitMaskImage: "url(/folders-dark.png)",
              WebkitMaskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskImage: "url(/folders-dark.png)",
              maskSize: "contain",
              maskRepeat: "no-repeat",
              maskPosition: "center",
            }}
          />

          <h1
            className="text-3xl text-text font-serif mb-2 tracking-[-0.01em] animate-fade-in-up"
            style={{ animationDelay: "100ms" }}
          >
            {recent ? "Open a notes folder" : "Welcome to Scratch"}
          </h1>
          <p
            className="text-text-muted mb-6 animate-fade-in-up"
            style={{ animationDelay: "100ms" }}
          >
            Choose the folder of Markdown notes to use in this window.
          </p>
          <div
            className="animate-fade-in-up"
            style={{ animationDelay: "200ms" }}
          >
            <Button disabled={opening} onClick={handleSelectFolder} size="xl">
              Choose your notes folder
            </Button>
          </div>

          {recent && (
            <Button variant="link" disabled={opening} title={recent} className="mt-2 max-w-full"
              onClick={() => void openFolder(recent)}>
              <span className="truncate">Reopen {recent}</span>
            </Button>
          )}
          {error && <p role="alert" className="mt-2 text-sm">{error}</p>}
        </div>
      </div>
    </div>
  );
}
