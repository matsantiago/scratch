// Run with Node 24+: node --test tests/note-history.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { getSchema } from "@tiptap/core";
import { closeHistory, history, redo, redoDepth, undo, undoDepth } from "@tiptap/pm/history";
import { EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { resetNoteHistory } from "../src/components/editor/noteHistory.ts";

const schema = getSchema([StarterKit]);
const makeDoc = text => schema.node("doc", null, schema.node("paragraph", null, schema.text(text)));
const otherKey = new PluginKey("note-history-test");
const otherPlugin = new Plugin({
  key: otherKey,
  state: { init: () => 0, apply: (_transaction, count) => count + 1 },
});

test("loading another note clears undo and redo while keeping the document and other plugin state", () => {
  let state = EditorState.create({ doc: makeDoc("Original"), plugins: [otherPlugin, history()] });
  state = state.apply(state.tr.insertText(" edited", 9));
  state = state.apply(closeHistory(state.tr).insertText(" again", 16));
  assert.equal(undo(state, transaction => { state = state.apply(transaction); }), true);
  assert.equal(undoDepth(state), 1);
  assert.equal(redoDepth(state), 1);

  const newDoc = makeDoc("Untitled");
  state = state.apply(state.tr.replaceWith(0, state.doc.content.size, newDoc.content)
    .setMeta("addToHistory", false));
  const selection = state.selection;
  const otherState = otherKey.getState(state);

  state = resetNoteHistory(state);
  assert.ok(state.doc.eq(newDoc));
  assert.ok(state.selection.eq(selection));
  assert.equal(otherKey.getState(state), otherState);
  assert.equal(undo(state), false);
  assert.equal(redo(state), false);
});

test("edits in the current note remain undoable and redoable after a reset", () => {
  let state = resetNoteHistory(EditorState.create({
    doc: makeDoc("Untitled"),
    plugins: [history()],
  }));
  const dispatch = transaction => { state = state.apply(transaction); };

  dispatch(state.tr.insertText(" edited", 9));
  assert.equal(state.doc.textContent, "Untitled edited");
  assert.equal(undo(state, dispatch), true);
  assert.equal(state.doc.textContent, "Untitled");
  assert.equal(redo(state, dispatch), true);
  assert.equal(state.doc.textContent, "Untitled edited");
});
