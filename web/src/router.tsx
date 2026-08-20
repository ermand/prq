import { createRouter } from "@tanstack/react-router";
import { TableSkeleton } from "./components/skeleton";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // The board is the only data source and it is read from local SQLite, so a
    // navigation never needs to refetch on a hunch.
    defaultPreload: "intent",
    /*
     * Every route here blocks its navigation on a loader, and before this there
     * was nothing on screen saying so: no `[aria-busy]`, no `[role=status]`, no
     * pulse anywhere in the app. One placeholder at the router covers all four
     * routes; a `pendingComponent` on the root route would only cover the root
     * loader, which is not where the reading happens.
     *
     * The threshold is a measurement, not TanStack's 1000ms default. These
     * loaders read local SQLite and return in single-digit milliseconds warm, so
     * 1000ms would never show; 250ms is past the point where a click still feels
     * instant and comfortably above the warm read, so the skeleton appears on a
     * cold or contended read and never strobes on an ordinary one.
     */
    defaultPendingComponent: TableSkeleton,
    defaultPendingMs: 250,
  });
}
