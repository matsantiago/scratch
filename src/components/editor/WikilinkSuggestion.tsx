import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import type { NoteMetadata } from "../../types/note";
import type { WikilinkStorage } from "./Wikilink";
import {
  WikilinkSuggestionList,
  type WikilinkSuggestionListRef,
} from "./WikilinkSuggestionList";

const wikilinkSuggestionPluginKey = new PluginKey("wikilinkSuggestion");

export const WikilinkSuggestion = Extension.create({
  name: "wikilinkSuggestion",

  addProseMirrorPlugins() {
    const storage = () => (
      this.editor.storage as unknown as { wikilink?: WikilinkStorage }
    ).wikilink;
    return [
      Suggestion<NoteMetadata>({
        editor: this.editor,
        char: "[[",
        pluginKey: wikilinkSuggestionPluginKey,
        allowSpaces: true,
        startOfLine: false,

        allow: ({ editor }) => {
          return (
            !editor.isActive("codeBlock") &&
            !editor.isActive("frontmatter") &&
            !editor.isActive("code")
          );
        },

        items: ({ query }) => {
          const q = query.toLowerCase();
          return (storage()?.notes ?? [])
            .filter((note) => note.title.toLowerCase().includes(q))
            .slice(0, 10);
        },

        command: ({ editor, range, props: note }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: "wikilink",
              attrs: { noteTitle: note.title },
            })
            .run();
        },

        render: () => {
          let component: ReactRenderer<WikilinkSuggestionListRef> | null =
            null;
          let popup: TippyInstance | null = null;
          let timer: number | undefined;
          let request = 0;

          function searchMore({ query, items }: SuggestionProps<NoteMetadata>) {
            clearTimeout(timer);
            const id = ++request;
            const searchTitles = storage()?.searchTitles;
            if (!query?.trim() || items.length >= 10 || !searchTitles) return;
            timer = window.setTimeout(() => {
              void searchTitles(query).then(matches => {
                if (id !== request) return;
                const byId = new Map(items.map(note => [note.id, note]));
                for (const note of matches) byId.set(note.id, note);
                component?.updateProps({ items: [...byId.values()].slice(0, 10) });
              }).catch(error => console.error("Failed to search wikilink titles:", error));
            }, 150);
          }

          return {
            onStart: (props) => {
              component = new ReactRenderer(WikilinkSuggestionList, {
                props: {
                  items: props.items,
                  command: props.command,
                },
                editor: props.editor,
              });

              popup = tippy(document.body, {
                getReferenceClientRect: () =>
                  props.clientRect?.() ?? new DOMRect(),
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: "manual",
                placement: "bottom-start",
                offset: [0, 4],
                popperOptions: {
                  modifiers: [
                    {
                      name: "flip",
                      options: { fallbackPlacements: ["top-start"] },
                    },
                  ],
                },
              });
              searchMore(props);
            },

            onUpdate: (props) => {
              component?.updateProps({
                items: props.items,
                command: props.command,
              });

              popup?.setProps({
                getReferenceClientRect: () =>
                  props.clientRect?.() ?? new DOMRect(),
              });
              searchMore(props);
            },

            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                popup?.hide();
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },

            onExit: () => {
              clearTimeout(timer);
              request++;
              popup?.destroy();
              component?.destroy();
              popup = null;
              component = null;
            },
          };
        },
      }),
    ];
  },
});
