import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { readFileDirect } from "../../services/files";
import type { Note, SaveResult } from "../../types/note";

type Session = {
  note: Note;
  pending: (() => string) | null;
  conflict: { disk: string | null } | null;
  persistedConflict: string | null;
  saving: Promise<void> | null;
  writing: string | null;
  timer: number | null;
  checking: boolean;
  checkAgain: boolean;
};

const drafts = new Map<string, Session>();
const draftKey = (path: string) => `scratch:conflict:${path}`;

function persistConflict(session: Session) {
  try {
    const key = draftKey(session.note.path);
    if (session.conflict && session.pending) {
      const stored = JSON.stringify({
        base: session.note.content,
        local: session.pending(),
      });
      localStorage.setItem(key, stored);
      session.persistedConflict = stored;
    } else if (session.persistedConflict !== null) {
      // Another window may have saved a different draft for this note.
      if (localStorage.getItem(key) === session.persistedConflict) {
        localStorage.removeItem(key);
      }
      session.persistedConflict = null;
    }
  } catch {
    // The editor and in-memory draft still work when local storage is unavailable.
  }
}

function openSession(note: Note): Session {
  const existing = drafts.get(note.path);
  if (existing) return existing;
  const session: Session = {
    note, pending: null, conflict: null, persistedConflict: null, saving: null, writing: null,
    timer: null, checking: false, checkAgain: false,
  };
  try {
    const stored = localStorage.getItem(draftKey(note.path));
    if (stored) {
      const { base, local } = JSON.parse(stored);
      if (typeof base === "string" && typeof local === "string" && local !== note.content) {
        session.note = { ...note, content: base };
        session.pending = () => local;
        session.conflict = { disk: note.content };
        session.persistedConflict = stored;
        drafts.set(note.path, session);
      }
    }
  } catch {
    // A saved draft is optional when opening a note.
  }
  return session;
}

function clearTimer(session: Session) {
  if (session.timer !== null) {
    window.clearTimeout(session.timer);
    session.timer = null;
  }
}

interface Options {
  save: (note: Note, content: string) => Promise<SaveResult<Note>>;
  acceptDiskNote: (note: Note) => void;
  applyContent: (content: string) => void;
}

export function useNoteDraft(options: Options) {
  const active = useRef<Session | null>(null);
  const operations = useRef(options);
  operations.current = options;
  const [, setVersion] = useState(0);

  const updateStatus = useCallback((session: Session) => {
    if (active.current === session) setVersion(version => version + 1);
  }, []);

  const check = useCallback(async (session = active.current) => {
    if (!session) return;
    if (session.saving || session.checking) {
      session.checkAgain = true;
      return;
    }

    session.checking = true;
    try {
      do {
        session.checkAgain = false;
        const base = session.note;
        const file = await readFileDirect(base.path);
        if (active.current !== session) return;
        if (session.saving) {
          session.checkAgain = true;
          return;
        }
        if (session.note !== base) {
          session.checkAgain = true;
          continue;
        }
        const disk = file?.content ?? null;
        if (disk === base.content && !session.conflict) continue;

        const local = session.pending?.() ?? base.content;
        if (disk === null || (local !== base.content && local !== disk)) {
          clearTimer(session);
          session.conflict = { disk };
          persistConflict(session);
          updateStatus(session);
          continue;
        }
        if (!file) continue;

        clearTimer(session);
        session.pending = null;
        session.conflict = null;
        drafts.delete(base.path);
        persistConflict(session);
        const updated = { ...file, id: base.id };
        session.note = updated;
        if (disk !== local) operations.current.applyContent(file.content);
        operations.current.acceptDiskNote(updated);
        updateStatus(session);
      } while (session.checkAgain);
    } catch (error) {
      console.error("Could not check the note on disk:", error);
    } finally {
      session.checking = false;
    }
  }, [updateStatus]);

  const flush = useCallback((session: Session, overwrite?: string) => {
    clearTimer(session);
    if (session.saving) {
      void session.saving.then(() => flush(session, overwrite));
      return;
    }
    if (!session.pending || (session.conflict && overwrite === undefined)) return;

    const content = session.pending();
    const base = session.note;
    if (content === base.content && overwrite === undefined) {
      session.pending = null;
      drafts.delete(base.path);
      updateStatus(session);
      return;
    }

    session.pending = null;
    session.writing = content;
    session.saving = Promise.resolve().then(async () => {
      try {
        const expected = overwrite === undefined ? base : { ...base, content: overwrite };
        const result = await operations.current.save(expected, content);
        if (result.status === "conflict") {
          session.pending ??= () => content;
          session.conflict = { disk: result.disk };
          persistConflict(session);
          return;
        }

        session.conflict = null;
        persistConflict(session);
        drafts.delete(base.path);
        session.note = result.note;
        if (session.pending) drafts.set(result.note.path, session);
      } catch (error) {
        session.pending ??= () => content;
        console.error("Failed to save note:", error);
        toast.error("Failed to save note. Your draft is still open.");
      } finally {
        session.writing = null;
        session.saving = null;
        updateStatus(session);
        if (session.checkAgain) void check(session);
      }
    });
    updateStatus(session);
  }, [check, updateStatus]);

  const edit = useCallback((getContent: () => string, delay: number) => {
    const session = active.current;
    if (!session) return;
    const wasPending = session.pending !== null;
    session.pending = getContent;
    drafts.set(session.note.path, session);
    clearTimer(session);
    if (session.conflict) {
      persistConflict(session);
      updateStatus(session);
      return;
    }
    session.timer = window.setTimeout(() => flush(session), delay);
    if (!wasPending) updateStatus(session);
  }, [flush, updateStatus]);

  const detach = useCallback(() => {
    const session = active.current;
    if (!session) return;
    active.current = null;
    if (session.pending) {
      const content = session.pending();
      session.pending = () => content;
    }
    flush(session);
  }, [flush]);

  useEffect(() => detach, [detach]);

  const load = useCallback((note: Note) => {
    detach();
    const session = openSession(note);
    active.current = session;
    updateStatus(session);
    void check(session);
    return session.pending?.() ?? session.writing ?? session.note.content;
  }, [check, detach, updateStatus]);

  const useDisk = useCallback(async (expected: string) => {
    const session = active.current;
    if (!session?.conflict) return;
    try {
      const file = await readFileDirect(session.note.path);
      if (active.current !== session || session.saving || !session.conflict) return;
      if (file?.content !== expected) {
        session.conflict = { disk: file?.content ?? null };
        persistConflict(session);
        updateStatus(session);
        return;
      }
      session.pending = null;
      session.conflict = null;
      drafts.delete(session.note.path);
      persistConflict(session);
      const updated = { ...file, id: session.note.id };
      session.note = updated;
      operations.current.applyContent(file.content);
      operations.current.acceptDiskNote(updated);
      updateStatus(session);
    } catch (error) {
      console.error("Failed to load the file on disk:", error);
      toast.error("Failed to load the file on disk");
    }
  }, [updateStatus]);

  const saveMine = useCallback((expected: string) => {
    const session = active.current;
    if (session?.conflict && !session.saving) flush(session, expected);
  }, [flush]);

  const getContent = useCallback(() => {
    const session = active.current;
    return session?.pending?.() ?? session?.writing ?? session?.note.content;
  }, []);
  const currentNotePath = useCallback(() => active.current?.note.path, []);

  const session = active.current;
  return {
    load, detach, edit, check, useDisk, saveMine, getContent,
    isSaving: session?.saving != null,
    hasUnsavedChanges: session?.pending != null,
    conflict: session?.conflict ?? null,
    currentNotePath,
  };
}
