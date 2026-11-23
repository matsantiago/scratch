// Run with Node 24+: node --test tests/lazy-folder-tree.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { buildFolderTree, collectVisibleEntries, getVisibleItems } from "../src/lib/folderTree.ts";

const note = id => ({ id, title: id, preview: "", modified: 0 });
const listings = new Map([
  ["", { folders: ["repo", "empty"], notes: [] }],
  ["repo", { folders: ["repo/docs"], notes: [note("repo/README")] }],
  ["repo/docs", { folders: [], notes: [note("repo/docs/Guide")] }],
  ["deleted", { folders: ["deleted/subfolder"], notes: [note("deleted/Old")] }],
]);

test("collapsed repositories show only their folder rows", () => {
  const entries = collectVisibleEntries(listings, new Set());
  assert.deepEqual(entries.folders, ["repo", "empty"]);
  assert.deepEqual(entries.notes, []);
});

test("expanding a repository shows only its immediate contents", () => {
  const expanded = new Set(["repo"]);
  const entries = collectVisibleEntries(listings, expanded);
  assert.deepEqual(entries.folders, ["repo", "repo/docs", "empty"]);
  assert.deepEqual(entries.notes.map(note => note.id), ["repo/README"]);
  const tree = buildFolderTree(entries.notes, new Set(), entries.folders);
  assert.deepEqual(getVisibleItems(tree, new Set(), expanded), [
    { type: "folder", path: "empty" },
    { type: "folder", path: "repo" },
    { type: "folder", path: "repo/docs" },
    { type: "note", id: "repo/README" },
  ]);
});

test("cached entries for deleted or collapsed branches stay out of the tree", () => {
  const entries = collectVisibleEntries(listings, new Set(["repo/docs", "deleted"]));
  assert.deepEqual(entries.folders, ["repo", "empty"]);
  assert.deepEqual(entries.notes, []);
});
