import type { Node } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

type Line = { start: number; end: number };
type Direction = -1 | 1;

export function moveLineDirection(e: KeyboardEvent): Direction | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return null;
  if (e.key === "ArrowUp") return -1;
  return e.key === "ArrowDown" ? 1 : null;
}

// Logical lines are separated by Enter or a hard break, independent of word wrap.
function textblockLines(node: Node, start: number): Line[] {
  const rows: Line[] = [];
  let from = start;
  const endLine = (at: number) => {
    rows.push({ start: from, end: at });
    from = at + 1;
  };
  node.forEach((child, offset) => {
    if (child.type.name === "hardBreak") endLine(start + offset);
    if (child.isText) {
      for (const match of (child.text ?? "").matchAll(/\n/g)) endLine(start + offset + match.index!);
    }
  });
  rows.push({ start: from, end: start + node.content.size });
  return rows;
}

function planMove(lines: Line[], from: number, to: number, direction: Direction) {
  const first = lines.findIndex(row => row.start <= from && from <= row.end);
  const endRow = lines.findIndex(row => row.start <= to && to <= row.end);
  if (first < 0 || endRow < 0) return null;
  const endsAtNextLine = endRow > first && to === lines[endRow].start;
  const last = endsAtNextLine ? endRow - 1 : endRow;
  const low = direction < 0 ? first - 1 : first;
  const high = direction > 0 ? last + 1 : last;
  if (low < 0 || high >= lines.length) return null;

  const order = lines.slice(low, high + 1);
  if (direction < 0) order.push(order.shift()!);
  else order.unshift(order.pop()!);

  // Preserve the cursor's column even when paragraph and soft-break separators differ.
  const starts = [lines[low].start];
  for (let i = 0; i < order.length; i++) {
    const gap = (lines[low + i + 1]?.start ?? lines[low + i].end) - lines[low + i].end;
    starts.push(starts[i] + order[i].end - order[i].start + gap);
  }
  const shiftFrom = starts[first + direction - low] + from - lines[first].start;
  const shiftTo = endsAtNextLine ? starts[last + direction - low + 1]
    : starts[last + direction - low] + to - lines[last].start;
  return { low, high, order, from: shiftFrom, to: shiftTo };
}

// Swap complete sibling items so checkboxes, marks, and nested lists travel together.
function moveListItems(view: EditorView, selection: TextSelection, direction: Direction) {
  const { $from, $to } = selection;
  const itemDepth = $from.depth - 1;
  if (itemDepth < 1 || $from.parent.type.name !== "paragraph" ||
      $to.parent.type.name !== "paragraph" || $to.depth !== $from.depth) return false;
  const itemType = $from.node(itemDepth).type.name;
  const listDepth = itemDepth - 1;
  if ((itemType !== "listItem" && itemType !== "taskItem") ||
      $from.start(listDepth) !== $to.start(listDepth)) return false;

  const list = $from.node(listDepth);
  const first = $from.index(listDepth);
  const endsAtNextItem = first < $to.index(listDepth) && $to.pos === $to.before(itemDepth) + 2;
  const last = $to.index(listDepth) - Number(endsAtNextItem);
  const neighborIndex = direction < 0 ? first - 1 : last + 1;
  const neighbor = list.maybeChild(neighborIndex);
  if (!neighbor) return true;

  const start = $from.before(itemDepth);
  const end = endsAtNextItem ? $to.before(itemDepth) : $to.after(itemDepth);
  const { state } = view;
  const items = state.doc.slice(start, end).content;
  const tr = closeHistory(state.tr);
  if (direction < 0) {
    tr.replaceWith(start - neighbor.nodeSize, end, items.addToEnd(neighbor));
  } else {
    tr.replaceWith(start, end + neighbor.nodeSize, items.addToStart(neighbor));
  }

  const delta = direction * neighbor.nodeSize;
  const movedFrom = selection.from + delta;
  // An exclusive end at the next item's start may now be at the end of the list.
  const movedTo = endsAtNextItem && last + direction === list.childCount - 1
    ? TextSelection.near(tr.doc.resolve(end + delta), -1).head
    : selection.to + delta;
  const reversed = selection.anchor > selection.head;
  tr.setSelection(TextSelection.create(tr.doc, reversed ? movedTo : movedFrom, reversed ? movedFrom : movedTo));
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function moveEditorLines(view: EditorView, direction: Direction) {
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return false;
  const { $from, $to } = selection;
  if (!$from.parent.isTextblock || !$to.parent.isTextblock ||
      $from.depth !== $to.depth) return false;
  if ($from.start(-1) !== $to.start(-1)) return moveListItems(view, selection, direction);

  let lines = textblockLines($from.parent, $from.start());
  if ($from.parent.type.name === "paragraph") {
    const parent = $from.node(-1);
    let first = $from.index(-1);
    let last = $to.index(-1);
    for (let i = first; i <= last; i++) {
      if (parent.child(i).type.name !== "paragraph") return false;
    }
    if (first > 0 && parent.child(first - 1).type.name === "paragraph") first--;
    if (last + 1 < parent.childCount && parent.child(last + 1).type.name === "paragraph") last++;
    lines = [];
    parent.forEach((child, offset, i) => {
      if (i >= first && i <= last) lines.push(...textblockLines(child, $from.start(-1) + offset + 1));
    });
  } else if (!$from.sameParent($to)) return false;

  const move = planMove(lines, selection.from, selection.to, direction);
  if (!move) {
    moveListItems(view, selection, direction);
    return true;
  }
  const tr = closeHistory(state.tr);
  // Keep each separator in place and move the inline content, including its marks.
  for (let i = move.high; i >= move.low; i--) {
    const source = move.order[i - move.low];
    const content = state.doc.slice(source.start, source.end).content;
    tr.replaceWith(lines[i].start, lines[i].end, content);
  }
  const reversed = selection.anchor > selection.head;
  tr.setSelection(TextSelection.create(tr.doc, reversed ? move.to : move.from, reversed ? move.from : move.to));
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function moveSourceLines(input: HTMLTextAreaElement, direction: Direction) {
  let start = 0;
  const text = input.value;
  const lines = text.split("\n").map(line => {
    const row = { start, end: start + line.length };
    start = row.end + 1;
    return row;
  });
  const move = planMove(lines, input.selectionStart, input.selectionEnd, direction);
  if (!move) return;
  const selectionDirection = input.selectionDirection;
  input.setSelectionRange(lines[move.low].start, lines[move.high].end);
  // Use the native edit command so the textarea keeps its undo history.
  const replacement = move.order.map(row => text.slice(row.start, row.end)).join("\n");
  document.execCommand("insertText", false, replacement);
  input.setSelectionRange(move.from, move.to, selectionDirection);
}
