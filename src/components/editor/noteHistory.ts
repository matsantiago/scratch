import { history } from "@tiptap/pm/history";
import type { EditorState } from "@tiptap/pm/state";

const historyKey = history().spec.key;

export function resetNoteHistory(state: EditorState): EditorState {
  const undoRedo = historyKey?.get(state);
  if (!undoRedo) return state;

  // Reconfiguring preserves the other plugins and gives history fresh undo and redo stacks.
  return state
    .reconfigure({ plugins: state.plugins.filter(plugin => plugin !== undoRedo) })
    .reconfigure({ plugins: state.plugins });
}
