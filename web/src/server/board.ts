/**
 * The entire server surface: read the stored board, or sync it.
 *
 * There is deliberately **no mutation function here**. Acting on a PR is an
 * anchor to the forge, so prq stays read-only structurally rather than by
 * discipline — the same conclusion the TUI reached.
 *
 * `getBoard` touches no network. That is the invariant the whole tool rests on:
 * a page load, or a reload, can never destroy the diff.
 */

import { createServerFn } from "@tanstack/react-start";
import { performSync, readAll } from "../../../src/engine";
import { toPayload } from "./payload";
import { withStore } from "./with-store";

export type { BoardPayload, ProviderSummary } from "./payload";

export const getBoard = createServerFn({ method: "GET" }).handler(() =>
  withStore((store, { projects }) => toPayload(readAll(store), projects, new Date())),
);

export const runSync = createServerFn({ method: "POST" }).handler(() =>
  withStore(async (store, { projects }) =>
    toPayload(await performSync(store, projects), projects, new Date()),
  ),
);
