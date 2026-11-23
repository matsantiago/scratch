// Run with Node 24+: node --test tests/duplicate-code-lines.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { getSchema } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { duplicateCodeBlockLines, lineShortcutDirection } from "../src/components/editor/moveLines.ts";

const schema = getSchema([StarterKit]);

function fixture(text, anchor, head = anchor) {
  const code = schema.node("codeBlock", { language: "mermaid" }, text ? schema.text(text) : null);
  const paragraph = schema.node("paragraph", null, schema.text("Outside"));
  const doc = schema.node("doc", null, [code, paragraph]);
  const selection = TextSelection.create(doc, anchor + 1, head + 1);
  return {
    state: EditorState.create({ doc, selection, plugins: [history()] }),
    dispatch(tr) { this.state = this.state.apply(tr); },
  };
}

test("duplicates the current line and keeps the cursor on the copy", () => {
  for (const direction of [-1, 1]) {
    const view = fixture("  A --> B\n  B --> C", 4);
    assert.equal(duplicateCodeBlockLines(view, direction), true);
    assert.equal(view.state.doc.firstChild.textContent, "  A --> B\n  A --> B\n  B --> C");
    assert.equal(view.state.doc.firstChild.attrs.language, "mermaid");
    assert.equal(view.state.selection.head, direction < 0 ? 5 : 15);
  }
});

test("duplicates selected lines and preserves a backwards selection ending at the next line", () => {
  const view = fixture("one\n  two\nthree", 10, 1);
  assert.equal(duplicateCodeBlockLines(view, 1), true);
  assert.equal(view.state.doc.firstChild.textContent, "one\n  two\none\n  two\nthree");
  assert.equal(view.state.selection.anchor, 21);
  assert.equal(view.state.selection.head, 12);
});

test("duplicates the empty line in an empty block and undoes it in one step", () => {
  const view = fixture("", 0);
  assert.equal(duplicateCodeBlockLines(view, 1), true);
  assert.equal(view.state.doc.firstChild.textContent, "\n");
  assert.equal(view.state.selection.head, 2);
  assert.equal(undo(view.state, view.dispatch.bind(view)), true);
  assert.equal(view.state.doc.firstChild.textContent, "");
  assert.equal(view.state.selection.head, 1);
});

test("leaves selections across blocks and in ordinary text to the editor", () => {
  for (const anchor of [0, 6]) {
    const view = fixture("one", anchor, 7);
    const original = view.state;
    assert.equal(duplicateCodeBlockLines(view, 1), false);
    assert.equal(view.state, original);
  }
});

test("recognizes Option with either arrow, including Shift, and ignores other modifiers", () => {
  const up = { key: "ArrowUp", altKey: true };
  assert.equal(lineShortcutDirection(up), -1);
  assert.equal(lineShortcutDirection({ ...up, shiftKey: true }), -1);
  assert.equal(lineShortcutDirection({ ...up, shiftKey: true, key: "ArrowDown" }), 1);
  for (const modifiers of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }]) {
    assert.equal(lineShortcutDirection({ ...up, ...modifiers, shiftKey: true }), null);
  }
});
