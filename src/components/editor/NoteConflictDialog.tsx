import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "../ui";

interface Props {
  disk: string | null;
  draft: string;
  isSaving: boolean;
  onClose: () => void;
  onUseDisk: (expected: string) => Promise<void>;
  onSaveMine: (expected: string) => void;
}

export function NoteConflictDialog({ disk, draft, isSaving, onClose, onUseDisk, onSaveMine }: Props) {
  const copyDraft = async () => {
    try {
      await invoke("copy_to_clipboard", { text: draft });
      toast.success("Draft copied");
    } catch {
      toast.error("Could not copy the draft");
    }
  };

  return (
    <AlertDialog open onOpenChange={open => { if (!open) onClose(); }}>
      <AlertDialogContent className="w-[calc(100%-2rem)] max-w-4xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{disk === null ? "File missing on disk" : "File changed on disk"}</AlertDialogTitle>
          <AlertDialogDescription>
            {disk === null
              ? "The file was moved or deleted. You can copy the version still open in Scratch."
              : "Auto-save is paused. Review both versions before choosing which one to keep."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid min-w-0 grid-cols-2 gap-3">
          <section className="min-w-0" aria-label="On disk">
            <h3 className="mb-1 text-sm font-medium">On disk</h3>
            <pre className="h-[min(42vh,24rem)] select-text overflow-auto rounded-md border border-border bg-bg-muted p-3 text-xs">
              {disk ?? "File missing"}
            </pre>
          </section>
          <section className="min-w-0" aria-label="Your draft">
            <h3 className="mb-1 text-sm font-medium">Your draft</h3>
            <pre className="h-[min(42vh,24rem)] select-text overflow-auto rounded-md border border-border bg-bg-muted p-3 text-xs">
              {draft}
            </pre>
          </section>
        </div>
        <AlertDialogFooter className="flex-wrap gap-2 sm:space-x-0">
          <AlertDialogCancel>Close</AlertDialogCancel>
          <Button onClick={copyDraft}>Copy Draft</Button>
          {disk !== null && (
            <>
              <Button disabled={isSaving} onClick={() => void onUseDisk(disk)}>Discard Draft</Button>
              <Button disabled={isSaving} variant="primary" onClick={() => onSaveMine(disk)}>Overwrite Disk Version</Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
