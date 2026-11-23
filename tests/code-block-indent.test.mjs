import assert from "node:assert/strict";
import test from "node:test";
import { getSchema } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { indentCodeBlockLines } from "../src/components/editor/moveLines.ts";

const schema = getSchema([StarterKit]);

function fixture(text, anchor, head = anchor) {
  const block = schema.node("codeBlock", { language: "mermaid" }, text ? schema.text(text) : null);
  const paragraph = schema.node("paragraph", null, schema.text("Outside"));
  const doc = schema.node("doc", null, [block, paragraph]);
  return {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, anchor + 1, head + 1),
      plugins: [history()],
    }),
    dispatch(tr) { this.state = this.state.apply(tr); },
  };
}

test("Tab advances from the cursor to the next tab stop", () => {
  const cases = [["", 0, "  ", 2], [" a", 1, "  a", 2], ["abcde", 3, "abc de", 4]];
  for (const [before, caret, after, expectedCaret] of cases) {
    const view = fixture(before, caret);
    assert.equal(indentCodeBlockLines(view, false), true);
    assert.equal(view.state.doc.firstChild.textContent, after);
    assert.equal(view.state.selection.head, expectedCaret + 1);
  }
});

test("Shift+Tab removes only the excess spaces at an uneven indent", () => {
  for (const [before, after] of [
    ["   item", "  item"],
    ["root\n   sibling\n    item", "root\n   sibling\n   item"],
  ]) {
    const view = fixture(before, before.indexOf("item"));
    assert.equal(indentCodeBlockLines(view, true), true);
    assert.equal(view.state.doc.firstChild.textContent, after);
    assert.equal(view.state.selection.head, after.indexOf("item") + 1);
    assert.equal(indentCodeBlockLines(view, true), true);
    assert.equal(view.state.doc.firstChild.textContent, after.replace(/ +item$/, "item"));
  }
});

test("Tab and Shift+Tab preserve a backwards selection ending before the next line", () => {
  const before = "alpha\n beta\ngamma";
  const view = fixture(before, before.indexOf("gamma"), 0);
  assert.equal(indentCodeBlockLines(view, false), true);
  const indented = "  alpha\n  beta\ngamma";
  assert.equal(view.state.doc.firstChild.textContent, indented);
  assert.equal(view.state.selection.anchor, indented.indexOf("gamma") + 1);
  assert.equal(view.state.selection.head, 1);
  assert.equal(indentCodeBlockLines(view, true), true);
  assert.equal(view.state.doc.firstChild.textContent, "alpha\nbeta\ngamma");
  assert.equal(undo(view.state, view.dispatch.bind(view)), true);
  assert.equal(view.state.doc.firstChild.textContent, indented);
});

test("indents with literal tabs when the existing block uses them", () => {
  const before = "root\n\tchild";
  const view = fixture(before, before.indexOf("child"));
  assert.equal(indentCodeBlockLines(view, false), true);
  assert.equal(view.state.doc.firstChild.textContent, "root\n\t\tchild");
  assert.equal(indentCodeBlockLines(view, true), true);
  assert.equal(view.state.doc.firstChild.textContent, before);
});

test("leaves cross-block selections alone and handles outdent at column one without editing", () => {
  const crossBlock = fixture("one", 0, 6);
  assert.equal(indentCodeBlockLines(crossBlock, false), false);
  const atStart = fixture("one", 0);
  const original = atStart.state;
  assert.equal(indentCodeBlockLines(atStart, true), true);
  assert.equal(atStart.state, original);
});
