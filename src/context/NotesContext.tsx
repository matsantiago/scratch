import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { FolderListing, Note, NoteMetadata, SaveResult } from "../types/note";
import * as notesService from "../services/notes";
import type { SearchResult } from "../services/notes";
import { collectVisibleEntries, folderParent, loadExpandedFolders, saveExpandedFolders } from "../lib/folderTree";

interface BrowseState {
  root: string;
  treeMode: boolean;
  expanded: Set<string>;
  listings: Map<string, FolderListing>;
  requests: Map<string, number>;
  requestId: number;
}

const emptyEntries: FolderListing = { folders: [], notes: [] };

// Separate contexts to prevent unnecessary re-renders
// Data context: changes frequently, only subscribed by components that need the data
interface NotesDataContextValue {
  notes: NoteMetadata[];
  foldersEnabled: boolean;
  knownFolders: string[];
  loadedFolders: ReadonlySet<string>;
  expandedFolders: Set<string>;
  selectedNoteId: string | null;
  currentNote: Note | null;
  notesFolder: string | null;
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
  searchResults: SearchResult[];
  isSearching: boolean;
  reloadVersion: number;
}

// Actions context: stable references, rarely causes re-renders
interface NotesActionsContextValue {
  selectNote: (id: string) => Promise<void>;
  createNote: () => Promise<void>;
  consumePendingNewNote: (id: string) => boolean;
  saveNote: (note: Note, content: string) => Promise<SaveResult<Note>>;
  acceptDiskNote: (note: Note) => void;
  deleteNote: (id: string) => Promise<void>;
  duplicateNote: (id: string) => Promise<void>;
  refreshNotes: () => Promise<void>;
  setFoldersEnabled: (enabled: boolean) => void;
  expandFolder: (path: string) => void;
  toggleFolder: (path: string) => void;
  collapseAllFolders: () => void;
  reloadCurrentNote: () => void;
  setNotesFolder: (path: string) => Promise<void>;
  search: (query: string) => Promise<void>;
  clearSearch: () => void;
  pinNote: (id: string) => Promise<void>;
  unpinNote: (id: string) => Promise<void>;
  createNoteInFolder: (folderPath: string) => Promise<void>;
  createFolder: (parentPath: string, name: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  renameFolder: (oldPath: string, newName: string) => Promise<void>;
  moveNote: (id: string, targetFolder: string) => Promise<void>;
  moveFolder: (path: string, targetParent: string) => Promise<void>;
}

const NotesDataContext = createContext<NotesDataContextValue | null>(null);
const NotesActionsContext = createContext<NotesActionsContextValue | null>(null);

export function NotesProvider({ children }: { children: ReactNode }) {
  const [flatNotes, setFlatNotes] = useState<NoteMetadata[]>([]);
  const [treeEntries, setTreeEntries] = useState<FolderListing>(emptyEntries);
  const [loadedFolders, setLoadedFolders] = useState<ReadonlySet<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [foldersEnabled, setFoldersEnabledState] = useState(true);
  const browseRef = useRef<BrowseState | null>(null);
  const browseRequestRef = useRef(0);
  const refreshPathsRef = useRef(new Set<string>());
  const notes = foldersEnabled ? treeEntries.notes : flatNotes;
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [currentNote, setCurrentNote] = useState<Note | null>(null);
  const [notesFolder, setNotesFolderState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  // A file change or a manual refresh asks the editor to check the current file.
  const [reloadVersion, setReloadVersion] = useState(0);

  // Track recently saved note IDs to ignore file-change events from our own saves
  const recentlySavedRef = useRef<Set<string>>(new Set());
  // Track pending refresh timeout to debounce refreshes during rapid saves
  const refreshTimeoutRef = useRef<number | null>(null);
  // Ref to access selectedNoteId in file watcher without re-registering listener
  const selectedNoteIdRef = useRef<string | null>(null);
  selectedNoteIdRef.current = selectedNoteId;
  // Ref to access notes in search callback without re-creating it on every notes change
  const notesRef = useRef<NoteMetadata[]>([]);
  notesRef.current = notes;
  // Monotonic counter to ignore stale async note selection responses.
  const selectRequestIdRef = useRef(0);
  // Monotonic counter to ignore stale async search responses
  const searchRequestIdRef = useRef(0);
  // Tracks the ID of a newly created note so Editor can focus its title.
  const pendingNewNoteIdRef = useRef<string | null>(null);

  const showTree = useCallback((scope: BrowseState) => {
    setExpandedFolders(scope.expanded);
    const visible = collectVisibleEntries(scope.listings, scope.expanded);
    setTreeEntries(visible);
    setLoadedFolders(new Set(scope.listings.keys()));
  }, []);

  const updateExpandedFolders = useCallback((scope: BrowseState, expanded: Set<string>) => {
    scope.expanded = expanded;
    saveExpandedFolders(scope.root, expanded);
    showTree(scope);
  }, [showTree]);

  const loadFolders = useCallback(async (scope: BrowseState, parents: Iterable<string>) => {
    const paths = [...parents];
    if (!paths.length) return;
    const request = ++scope.requestId;
    await Promise.all(paths.map(async path => {
      scope.requests.set(path, request);
      try {
        const listing = await notesService.listFolderEntries(path);
        if (browseRef.current !== scope || scope.requests.get(path) !== request) return;
        scope.listings.set(path, listing);
      } catch (error) {
        if (browseRef.current !== scope || scope.requests.get(path) !== request) return;
        console.error("Failed to load folder:", error);
        setError("Failed to load folder");
        if (!scope.listings.has(path)) scope.listings.set(path, emptyEntries);
      } finally {
        if (scope.requests.get(path) === request) scope.requests.delete(path);
      }
    }));
    if (browseRef.current === scope) showTree(scope);
  }, [showTree]);

  const refreshNotes = useCallback(async (paths?: Iterable<string>) => {
    const scope = browseRef.current;
    if (!scope) return;
    try {
      if (!scope.treeMode) {
        const request = ++scope.requestId;
        const items = await notesService.listNotes();
        if (browseRef.current === scope && scope.requestId === request) setFlatNotes(items);
        return;
      }
      const openPaths = new Set(["", ...scope.expanded]);
      const parents = paths ? [...paths].filter(path => openPaths.has(path)) : openPaths;
      await loadFolders(scope, parents);
    } catch (error) {
      if (browseRef.current === scope) setError(error instanceof Error ? error.message : "Failed to load notes");
    }
  }, [loadFolders]);

  // Changes in a closed branch do not trigger disk reads for that branch.
  const scheduleRefresh = useCallback((paths: string[]) => {
    for (const path of paths) refreshPathsRef.current.add(path);
    if (refreshTimeoutRef.current !== null) return;
    refreshTimeoutRef.current = window.setTimeout(() => {
      refreshTimeoutRef.current = null;
      const pending = refreshPathsRef.current;
      refreshPathsRef.current = new Set();
      void refreshNotes(pending);
    }, 250);
  }, [refreshNotes]);

  const setFoldersEnabled = useCallback((enabled: boolean) => {
    const previous = browseRef.current;
    if (!previous || previous.treeMode === enabled) return;
    const scope = { ...previous, treeMode: enabled, requests: new Map<string, number>(), requestId: 0 };
    browseRef.current = scope;
    setFoldersEnabledState(enabled);
    void refreshNotes();
  }, [refreshNotes]);

  const expandFolder = useCallback((path: string, refresh = false) => {
    const scope = browseRef.current;
    if (!scope?.treeMode || !path) return;
    const expanded = new Set(scope.expanded);
    const missing = new Set<string>();
    for (let branch = path; branch; branch = folderParent(branch)) {
      expanded.add(branch);
      if (!scope.requests.has(branch) && (!scope.listings.has(branch) || (refresh && branch === path))) {
        missing.add(branch);
      }
    }
    if (expanded.size !== scope.expanded.size) {
      updateExpandedFolders(scope, expanded);
    }
    if (missing.size) void loadFolders(scope, missing);
  }, [loadFolders, updateExpandedFolders]);

  const toggleFolder = useCallback((path: string) => {
    const scope = browseRef.current;
    if (!scope?.treeMode) return;
    if (!scope.expanded.has(path)) {
      expandFolder(path, true);
      return;
    }
    const expanded = new Set([...scope.expanded].filter(branch => branch !== path && !branch.startsWith(path + "/")));
    updateExpandedFolders(scope, expanded);
  }, [expandFolder, updateExpandedFolders]);

  const collapseAllFolders = useCallback(() => {
    const scope = browseRef.current;
    if (scope?.treeMode && scope.expanded.size) {
      updateExpandedFolders(scope, new Set());
    }
  }, [updateExpandedFolders]);

  const selectNote = useCallback(async (id: string) => {
    const requestId = ++selectRequestIdRef.current;
    try {
      if (pendingNewNoteIdRef.current !== id) {
        pendingNewNoteIdRef.current = null;
      }
      // Set selected ID immediately for responsive UI
      setSelectedNoteId(id);
      expandFolder(folderParent(id));
      const note = await notesService.readNote(id);
      if (requestId !== selectRequestIdRef.current) return;
      setCurrentNote(note);
    } catch (err) {
      if (requestId !== selectRequestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load note");
    }
  }, [expandFolder]);

  const reloadCurrentNote = useCallback(() => {
    setReloadVersion((v) => v + 1);
  }, []);

  const acceptDiskNote = useCallback((note: Note) => {
    setCurrentNote(previous => previous?.path === note.path ? note : previous);
  }, []);

  const createNote = useCallback(async () => {
    try {
      // Derive target folder from the selected note's parent path
      let targetFolder: string | undefined;
      if (selectedNoteIdRef.current) {
        const lastSlash = selectedNoteIdRef.current.lastIndexOf("/");
        if (lastSlash > 0) {
          targetFolder = selectedNoteIdRef.current.substring(0, lastSlash);
        }
      }
      const note = await notesService.createNote(targetFolder);
      selectRequestIdRef.current += 1;
      pendingNewNoteIdRef.current = note.id;
      // Mark as recently saved to ignore file-change events from our own creation
      recentlySavedRef.current.add(note.id);
      await refreshNotes();
      setCurrentNote(note);
      setSelectedNoteId(note.id);
      // Clear search when creating a new note
      setSearchQuery("");
      setSearchResults([]);
      setTimeout(() => {
        recentlySavedRef.current.delete(note.id);
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create note");
    }
  }, [refreshNotes]);

  const consumePendingNewNote = useCallback((id: string) => {
    if (pendingNewNoteIdRef.current !== id) {
      pendingNewNoteIdRef.current = null;
      return false;
    }
    pendingNewNoteIdRef.current = null;
    return true;
  }, []);

  const saveNote = useCallback(
    async (note: Note, content: string): Promise<SaveResult<Note>> => {
      const savingNoteId = note.id;
      let updatedId: string | null = null;

      try {
        // Mark this note as recently saved to ignore file-change events from our own save
        recentlySavedRef.current.add(savingNoteId);

        const result = await notesService.saveNote(savingNoteId, content, note.content, note.path);
        if (result.status === "conflict") {
          recentlySavedRef.current.delete(savingNoteId);
          return result;
        }
        const updated = result.note;
        updatedId = updated.id;

        // If the note was renamed (ID changed), also mark the new ID
        if (updated.id !== savingNoteId) {
          recentlySavedRef.current.add(updated.id);

          // Transfer pin status to new ID
          const currentSettings = await notesService.getSettings();
          const pinnedIds = currentSettings.pinnedNoteIds || [];
          if (pinnedIds.includes(savingNoteId)) {
            const updatedSettings = {
              ...currentSettings,
              pinnedNoteIds: pinnedIds.map((id) =>
                id === savingNoteId ? updated.id : id
              ),
            };
            await notesService.updateSettings(updatedSettings);
          }
        }

        // A completed save must not replace the note selected while it was in flight.
        setCurrentNote(previous => previous?.path === note.path ? updated : previous);
        if (updated.id !== savingNoteId) {
          setSelectedNoteId(previous => previous === savingNoteId ? updated.id : previous);
        }

        // Schedule refresh with debounce - avoids blocking typing during rapid saves
        scheduleRefresh([folderParent(savingNoteId), folderParent(updated.id)]);

        // Clear the recently saved flag after a short delay
        // (longer than the file watcher debounce of 500ms)
        setTimeout(() => {
          recentlySavedRef.current.delete(savingNoteId);
          if (updatedId) recentlySavedRef.current.delete(updatedId);
        }, 1000);
        return result;
      } catch (err) {
        // Clean up immediately on error to avoid leaving stale entries
        recentlySavedRef.current.delete(savingNoteId);
        if (updatedId) recentlySavedRef.current.delete(updatedId);
        throw err;
      }
    },
    [scheduleRefresh]
  );

  const deleteNote = useCallback(
    async (id: string) => {
      try {
        await notesService.deleteNote(id);

        // Clean up pinned status for deleted note
        const currentSettings = await notesService.getSettings();
        const pinnedIds = currentSettings.pinnedNoteIds || [];
        if (pinnedIds.includes(id)) {
          const updatedSettings = {
            ...currentSettings,
            pinnedNoteIds: pinnedIds.filter((pinId) => pinId !== id),
          };
          await notesService.updateSettings(updatedSettings);
        }

        // Only clear selection if we're deleting the currently selected note
        setSelectedNoteId((prevId) => {
          if (prevId === id) {
            setCurrentNote(null);
            return null;
          }
          return prevId;
        });
        await refreshNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete note");
      }
    },
    [refreshNotes]
  );

  const duplicateNote = useCallback(
    async (id: string) => {
      try {
        const newNote = await notesService.duplicateNote(id);
        selectRequestIdRef.current += 1;
        // Mark as recently saved to ignore file-change events from our own creation
        recentlySavedRef.current.add(newNote.id);
        await refreshNotes();
        setCurrentNote(newNote);
        setSelectedNoteId(newNote.id);
        setTimeout(() => {
          recentlySavedRef.current.delete(newNote.id);
        }, 1000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to duplicate note");
      }
    },
    [refreshNotes]
  );

  const pinNote = useCallback(
    async (id: string) => {
      try {
        const currentSettings = await notesService.getSettings();
        const pinnedIds = currentSettings.pinnedNoteIds || [];

        if (!pinnedIds.includes(id)) {
          const updatedSettings = {
            ...currentSettings,
            pinnedNoteIds: [...pinnedIds, id],
          };
          await notesService.updateSettings(updatedSettings);
          await refreshNotes();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to pin note");
      }
    },
    [refreshNotes]
  );

  const unpinNote = useCallback(
    async (id: string) => {
      try {
        const currentSettings = await notesService.getSettings();
        const pinnedIds = currentSettings.pinnedNoteIds || [];

        const updatedSettings = {
          ...currentSettings,
          pinnedNoteIds: pinnedIds.filter((pinId) => pinId !== id),
        };
        await notesService.updateSettings(updatedSettings);
        await refreshNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to unpin note");
      }
    },
    [refreshNotes]
  );

  const createNoteInFolder = useCallback(
    async (folderPath: string) => {
      try {
        const note = await notesService.createNote(folderPath);
        selectRequestIdRef.current += 1;
        pendingNewNoteIdRef.current = note.id;
        recentlySavedRef.current.add(note.id);
        await refreshNotes();
        setCurrentNote(note);
        setSelectedNoteId(note.id);
        setSearchQuery("");
        setSearchResults([]);
        setTimeout(() => {
          recentlySavedRef.current.delete(note.id);
        }, 1000);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to create note"
        );
      }
    },
    [refreshNotes]
  );

  const createFolderAction = useCallback(
    async (parentPath: string, name: string) => {
      try {
        const fullPath = parentPath ? `${parentPath}/${name}` : name;
        await notesService.createFolder(fullPath);
        await refreshNotes();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to create folder"
        );
      }
    },
    [refreshNotes]
  );

  const deleteFolderAction = useCallback(
    async (path: string) => {
      try {
        await notesService.deleteFolder(path);
        // If the selected note was inside the deleted folder, clear selection
        setSelectedNoteId((prevId) => {
          if (prevId && prevId.startsWith(path + "/")) {
            setCurrentNote(null);
            return null;
          }
          return prevId;
        });
        await refreshNotes();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to delete folder"
        );
      }
    },
    [refreshNotes]
  );

  const renameFolderAction = useCallback(
    async (oldPath: string, newName: string) => {
      try {
        await notesService.renameFolder(oldPath, newName);

        // Compute new folder path
        const lastSlash = oldPath.lastIndexOf("/");
        const newPath =
          lastSlash >= 0
            ? `${oldPath.substring(0, lastSlash)}/${newName}`
            : newName;
        const oldPrefix = oldPath + "/";
        const newPrefix = newPath + "/";

        // Update selectedNoteId if it was inside the renamed folder
        setSelectedNoteId((prevId) => {
          if (prevId && prevId.startsWith(oldPrefix)) {
            const newId = newPrefix + prevId.substring(oldPrefix.length);
            notesService.readNote(newId).then((note) => {
              setCurrentNote(note);
            }).catch((err) => {
              setError(err instanceof Error ? err.message : "Failed to read renamed note");
            });
            return newId;
          }
          return prevId;
        });

        await refreshNotes();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to rename folder"
        );
      }
    },
    [refreshNotes]
  );

  const moveNoteAction = useCallback(
    async (id: string, targetFolder: string) => {
      try {
        const newId = await notesService.moveNote(id, targetFolder);
        // Update selection if we moved the selected note
        setSelectedNoteId((prevId) => {
          if (prevId === id) {
            notesService.readNote(newId).then((note) => {
              setCurrentNote(note);
            }).catch((err) => {
              setError(err instanceof Error ? err.message : "Failed to read moved note");
            });
            return newId;
          }
          return prevId;
        });
        await refreshNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to move note");
      }
    },
    [refreshNotes]
  );

  const moveFolderAction = useCallback(
    async (path: string, targetParent: string) => {
      try {
        await notesService.moveFolder(path, targetParent);

        // Compute new folder path
        const folderName = path.includes("/")
          ? path.substring(path.lastIndexOf("/") + 1)
          : path;
        const newPath = targetParent
          ? `${targetParent}/${folderName}`
          : folderName;
        const oldPrefix = path + "/";
        const newPrefix = newPath + "/";

        // Update selectedNoteId if it was inside the moved folder
        setSelectedNoteId((prevId) => {
          if (prevId && prevId.startsWith(oldPrefix)) {
            const newId = newPrefix + prevId.substring(oldPrefix.length);
            notesService.readNote(newId).then((note) => {
              setCurrentNote(note);
            }).catch((err) => {
              setError(err instanceof Error ? err.message : "Failed to read moved note");
            });
            return newId;
          }
          return prevId;
        });

        await refreshNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to move folder");
      }
    },
    [refreshNotes]
  );

  const activateFolder = useCallback(async (path: string) => {
    const request = ++browseRequestRef.current;
    ++selectRequestIdRef.current;
    ++searchRequestIdRef.current;
    refreshPathsRef.current.clear();
    setSelectedNoteId(null);
    setCurrentNote(null);
    setSearchQuery("");
    setSearchResults([]);
    setIsSearching(false);
    setFlatNotes([]);
    setTreeEntries(emptyEntries);
    setLoadedFolders(new Set());
    browseRef.current = null;
    const settings = await notesService.getSettings();
    if (browseRequestRef.current !== request) return;
    const scope: BrowseState = {
      root: path,
      treeMode: settings.foldersEnabled !== false,
      expanded: loadExpandedFolders(path),
      listings: new Map(),
      requests: new Map(),
      requestId: 0,
    };
    browseRef.current = scope;
    setFoldersEnabledState(scope.treeMode);
    setExpandedFolders(scope.expanded);
    setNotesFolderState(path);

    // The sidebar can render as soon as the root is ready, independently of the watcher.
    void notesService.startFileWatcher().catch(error => {
      console.error("Failed to start file watcher:", error);
    });
    if (scope.treeMode) {
      await loadFolders(scope, [""]);
      if (scope.expanded.size && browseRef.current === scope) void loadFolders(scope, scope.expanded);
    } else {
      await refreshNotes();
    }
  }, [loadFolders, refreshNotes]);

  const setNotesFolder = useCallback(async (path: string) => {
    try {
      const folder = await notesService.setNotesFolder(path);
      await activateFolder(folder);
    } catch (error) {
      setError(String(error));
      throw error;
    }
  }, [activateFolder]);

  const search = useCallback(async (query: string) => {
    const requestId = ++searchRequestIdRef.current;
    setSearchQuery(query);

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    const queryLower = trimmedQuery.toLowerCase();
    // Instant local results for responsive UX while full-text search runs.
    const instantResults: SearchResult[] = notesRef.current
      .filter(
        (note) =>
          note.title.toLowerCase().includes(queryLower) ||
          note.preview.toLowerCase().includes(queryLower),
      )
      .slice(0, 20)
      .map((note) => ({
        id: note.id,
        title: note.title,
        preview: note.preview,
        modified: note.modified,
        score: 0,
      }));

    // Show instant local matches immediately; clear stale results if none match.
    setSearchResults(instantResults);

    setIsSearching(true);
    try {
      const results = await notesService.searchNotes(trimmedQuery);
      if (requestId !== searchRequestIdRef.current) return;
      if (results.length === 0) {
        // If neither backend nor instant matches found, clear results only now
        // (after async search settles) to avoid transient empty states.
        setSearchResults(instantResults);
      } else {
        // Merge backend + instant results, deduping by note id.
        const merged = [...results];
        const seen = new Set(results.map((result) => result.id));
        for (const result of instantResults) {
          if (!seen.has(result.id)) {
            merged.push(result);
          }
        }
        setSearchResults(merged);
      }
    } catch (err) {
      console.error("Search failed:", err);
    }
    if (requestId !== searchRequestIdRef.current) return;
    setIsSearching(false);
  }, []);

  const clearSearch = useCallback(() => {
    searchRequestIdRef.current += 1;
    setSearchQuery("");
    setSearchResults([]);
    setIsSearching(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initialNoteId = new URLSearchParams(window.location.search).get("note");
    notesService.getNotesFolder()
      .then(async (folder) => {
        if (!folder || cancelled) return;
        await activateFolder(folder);
        if (initialNoteId && !cancelled && browseRef.current?.root === folder) {
          await selectNote(initialNoteId);
        }
      })
      .catch(error => { if (!cancelled) setError(String(error)); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [activateFolder, selectNote]);

  useEffect(() => {
    const onExpand = (event: Event) => expandFolder((event as CustomEvent<string>).detail);
    window.addEventListener("expand-folder", onExpand);
    return () => window.removeEventListener("expand-folder", onExpand);
  }, [expandFolder]);

  useEffect(() => {
    const unlisten = getCurrentWindow().listen<string>("folder-change", event => {
      if (browseRef.current?.treeMode) scheduleRefresh([event.payload]);
    });
    return () => { void unlisten.then(dispose => dispose()); };
  }, [scheduleRefresh]);

  // Check the open note even when we just saved it. A different writer can
  // change it again before our own file watcher event is delivered.
  useEffect(() => {
    let isCancelled = false;
    let unlisten: (() => void) | undefined;

    getCurrentWindow().listen<{ changed_ids: string[] }>("file-change", (event) => {
      // Don't process if effect was cleaned up
      if (isCancelled) return;

      const changedIds = event.payload.changed_ids || [];

      // Filter out notes we recently saved ourselves
      const externalChanges = changedIds.filter(
        (id) => !recentlySavedRef.current.has(id)
      );

      if (externalChanges.length > 0) scheduleRefresh(externalChanges.map(folderParent));
      const currentId = selectedNoteIdRef.current;
      if (currentId && changedIds.includes(currentId)) {
        reloadCurrentNote();
      }
    }).then((fn) => {
      if (isCancelled) {
        // Effect was cleaned up before listener registered, clean up immediately
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      isCancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [reloadCurrentNote, scheduleRefresh]);

  // Listen for "select-note" events from the backend (CLI, drag-drop, Open With, import from preview)
  useEffect(() => {
    const unlisten = getCurrentWindow().listen<string>("select-note", (event) => {
      // Refresh the notes list so the sidebar shows the new note immediately
      refreshNotes();
      selectNote(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [selectNote, refreshNotes]);

  // Memoize data context value to prevent unnecessary re-renders
  const dataValue = useMemo<NotesDataContextValue>(
    () => ({
      notes,
      foldersEnabled,
      knownFolders: treeEntries.folders,
      loadedFolders,
      expandedFolders,
      selectedNoteId,
      currentNote,
      notesFolder,
      isLoading,
      error,
      searchQuery,
      searchResults,
      isSearching,
      reloadVersion,
    }),
    [
      notes,
      foldersEnabled,
      treeEntries.folders,
      loadedFolders,
      expandedFolders,
      selectedNoteId,
      currentNote,
      notesFolder,
      isLoading,
      error,
      searchQuery,
      searchResults,
      isSearching,
      reloadVersion,
    ]
  );

  // Memoize actions context value - these are stable callbacks
  const actionsValue = useMemo<NotesActionsContextValue>(
    () => ({
      selectNote,
      createNote,
      consumePendingNewNote,
      saveNote,
      acceptDiskNote,
      deleteNote,
      duplicateNote,
      refreshNotes,
      setFoldersEnabled,
      expandFolder,
      toggleFolder,
      collapseAllFolders,
      reloadCurrentNote,
      setNotesFolder,
      search,
      clearSearch,
      pinNote,
      unpinNote,
      createNoteInFolder,
      createFolder: createFolderAction,
      deleteFolder: deleteFolderAction,
      renameFolder: renameFolderAction,
      moveNote: moveNoteAction,
      moveFolder: moveFolderAction,
    }),
    [
      selectNote,
      createNote,
      consumePendingNewNote,
      saveNote,
      acceptDiskNote,
      deleteNote,
      duplicateNote,
      refreshNotes,
      setFoldersEnabled,
      expandFolder,
      toggleFolder,
      collapseAllFolders,
      reloadCurrentNote,
      setNotesFolder,
      search,
      clearSearch,
      pinNote,
      unpinNote,
      createNoteInFolder,
      createFolderAction,
      deleteFolderAction,
      renameFolderAction,
      moveNoteAction,
      moveFolderAction,
    ]
  );

  return (
    <NotesActionsContext.Provider value={actionsValue}>
      <NotesDataContext.Provider value={dataValue}>
        {children}
      </NotesDataContext.Provider>
    </NotesActionsContext.Provider>
  );
}

// Hook to get notes data (subscribes to data changes)
export function useNotesData() {
  const context = useContext(NotesDataContext);
  if (!context) {
    throw new Error("useNotesData must be used within a NotesProvider");
  }
  return context;
}

// Hook to get notes actions (stable references, rarely causes re-renders)
export function useNotesActions() {
  const context = useContext(NotesActionsContext);
  if (!context) {
    throw new Error("useNotesActions must be used within a NotesProvider");
  }
  return context;
}

// Combined hook for convenience (backward compatible)
export function useNotes() {
  const data = useNotesData();
  const actions = useNotesActions();
  return { ...data, ...actions };
}

// Optional hook that returns null when outside a NotesProvider (for preview mode)
export function useOptionalNotes() {
  const data = useContext(NotesDataContext);
  const actions = useContext(NotesActionsContext);
  if (!data || !actions) return null;
  return { ...data, ...actions };
}
