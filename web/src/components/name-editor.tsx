/**
 * The rename control, shared by the roster row and the profile heading.
 *
 * The driver's roster is mostly forge logins — `kaziu`, `bbregu141`,
 * `luisalla-art`, `maksimiliano.bajo` — and none of those is a person's name.
 * Naming 29 of them by opening 29 profiles is the wrong shape, so the same
 * control has to work inline in a list row and on a heading. A person's name is
 * one role — `text-title` — so both callers now pass the same size and weight,
 * and the class stays a prop only because the colour is theirs to choose.
 *
 * Three details are deliberate.
 *
 * A rename is one row in the database and the undo is another rename, so there
 * is no confirm step. What there is instead is a visible fallback: emptying the
 * field, or the explicit `clear` control, drops the stored label rather than
 * writing an empty one — a person with a blank name would render as a nameless
 * row. `clearPersonName` on the server does that deletion; `renamePerson("")`
 * would just be rejected, which is why the empty field is routed to the former.
 *
 * The store is the truth, not this component's state. Every write is followed by
 * `router.invalidate()` so the loader re-reads; nothing here patches a label in
 * place and hopes the database agreed.
 *
 * Failures are shown where they happened, verbatim. The server's messages name
 * the fix — a label longer than the column allows says so — and replacing them
 * with "could not save" would throw the only useful part away.
 */

import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { clearPersonName, renamePerson } from "../server/settings";
import { ROW_CONTROL } from "./system";

/**
 * The label a person falls back to with nothing stored. Mirrors the server's
 * rule exactly: an identity id is `provider:login`, and a slug id — a merge
 * target, or a config-seeded person — falls back to itself.
 */
export function fallbackLabel(id: string): string {
  const colon = id.indexOf(":");
  return colon === -1 ? id : id.slice(colon + 1);
}

export function NameEditor({
  id,
  label,
  textClass,
  onEditingChange,
}: {
  id: string;
  label: string;
  /** The name's role and colour, so a row and a heading can share this. */
  textClass: string;
  /** Lets a row suspend its own click handling while an input is open. */
  onEditingChange?: (editing: boolean) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fallback = fallbackLabel(id);
  const named = label !== fallback;

  function open() {
    setDraft(label);
    setError(null);
    setEditing(true);
    onEditingChange?.(true);
  }

  function close() {
    setEditing(false);
    setError(null);
    onEditingChange?.(false);
  }

  /** A failed write keeps the field open with the typed text and the reason. */
  async function write(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await router.invalidate();
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const next = draft.trim();
    if (next === label) return close();
    if (next === "") return named ? clear() : close();
    void write(() => renamePerson({ data: { id, label: next } }));
  }

  function clear() {
    void write(() => clearPersonName({ data: { id } }));
  }

  /*
   * `pointer-events-auto` above a `pointer-events-none` cell: the roster row is
   * one link with the editor sitting on top of it, so a click meant for this
   * control must not also be a navigation, and a click anywhere else on the row
   * must still reach the link underneath.
   */
  if (!editing) {
    return (
      <span className="pointer-events-auto relative z-10 flex min-w-0 items-baseline gap-1.5">
        <button
          type="button"
          onClick={open}
          title={
            named
              ? `Stored name. Click to rename, or clear it back to "${fallback}".`
              : `Forge login. Click to give ${fallback} a real name — stored in the database, not config.yaml.`
          }
          className={`group/name flex min-w-0 items-baseline gap-1.5 text-left ${textClass}`}
        >
          <span className="truncate decoration-dotted underline-offset-4 group-hover/name:underline">
            {label}
          </span>
          {/*
           * A hover-only affordance, and `opacity-0` leaves it in the
           * accessibility tree — so on the profile, where this button is now the
           * page's `<h1>`, the heading read as "Ermand Durro rename". The
           * button's `title` already says what a click does.
           */}
          <span
            aria-hidden="true"
            className="shrink-0 text-chip text-fg-subtle opacity-0 transition-opacity group-hover/name:opacity-100"
          >
            rename
          </span>
        </button>
      </span>
    );
  }

  return (
    <span className="pointer-events-auto relative z-10 flex min-w-0 flex-wrap items-center gap-1.5">
      <input
        /* The click that opened this field was the request to type in it. */
        autoFocus
        value={draft}
        disabled={busy}
        aria-label={`Name for ${fallback}`}
        placeholder={fallback}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        className={`${ROW_CONTROL} w-44 border-accent-emphasis bg-surface text-fg placeholder:text-fg-subtle focus:border-accent disabled:opacity-50`}
      />
      <button
        type="button"
        onClick={save}
        disabled={busy}
        className={`${ROW_CONTROL} border-accent-emphasis bg-accent-emphasis text-white hover:bg-accent hover:text-canvas disabled:opacity-50`}
      >
        save
      </button>
      <button
        type="button"
        onClick={close}
        disabled={busy}
        className={`${ROW_CONTROL} border-border text-fg-muted hover:border-fg-muted hover:text-fg disabled:opacity-50`}
      >
        esc
      </button>
      {named && (
        <button
          type="button"
          onClick={clear}
          disabled={busy}
          title={`Drop the stored name; the display falls back to "${fallback}".`}
          className={`${ROW_CONTROL} border-border text-fg-muted hover:border-danger hover:text-danger disabled:opacity-50`}
        >
          clear
        </button>
      )}
      {error !== null && (
        <span className="w-full font-mono text-meta leading-relaxed text-danger">{error}</span>
      )}
    </span>
  );
}
