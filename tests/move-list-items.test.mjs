// Run with Node 24+: node --test tests/move-list-items.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { moveEditorLines } from "../src/components/editor/moveLines.ts";

const schema = new Schema({ nodes: {
  doc: { content: "list" },
  list: { content: "taskItem+" },
  taskItem: { content: "paragraph list?", attrs: { checked: { default: false } } },
  paragraph: { content: "text*" },
  text: {},
} });
const list = (...items) => schema.node("list", null, items);
const item = (text, checked = false, children) => schema.node("taskItem", { checked },
  [schema.node("paragraph", null, schema.text(text)), ...(children ? [children] : [])]);

function fixture(content, anchorLabel, anchorOffset, headLabel = anchorLabel, headOffset = anchorOffset) {
  const doc = schema.node("doc", null, content);
  const positions = new Map();
  doc.descendants((node, pos) => { if (node.isText) positions.set(node.text, pos); });
  const selection = TextSelection.create(doc,
    positions.get(anchorLabel) + anchorOffset, positions.get(headLabel) + headOffset);
  return {
    state: EditorState.create({ doc, selection }),
    dispatch(tr) { this.state = this.state.apply(tr); },
  };
}

test("moving a backwards selection swaps whole sibling items and keeps the selection", () => {
  const a = item("first", true, list(item("child")));
  const b = item("second");
  const c = item("third", true);
  const view = fixture(list(a, b, c), "third", 2, "second", 1);
  moveEditorLines(view, -1);
  assert.ok(view.state.doc.firstChild.eq(list(b, c, a)));
  assert.equal(view.state.selection.$anchor.parent.textContent, "third");
  assert.equal(view.state.selection.$anchor.parentOffset, 2);
  assert.equal(view.state.selection.$head.parent.textContent, "second");
  assert.equal(view.state.selection.$head.parentOffset, 1);
});

test("the start of the following item is an exclusive selection end", () => {
  const a = item("a"), b = item("b"), c = item("c");
  const view = fixture(list(a, b, c), "a", 0, "c", 0);
  moveEditorLines(view, 1);
  assert.ok(view.state.doc.firstChild.eq(list(c, a, b)));
  assert.equal(view.state.selection.$to.parent.textContent, "b");
});

test("a nested item stays in its list at the edge", () => {
  const doc = list(item("outer", false, list(item("nested"))), item("other"));
  const view = fixture(doc, "nested", 1);
  for (const direction of [-1, 1]) {
    moveEditorLines(view, direction);
    assert.ok(view.state.doc.firstChild.eq(doc));
  }
});
