import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // The board is the only data source and it is read from local SQLite, so a
    // navigation never needs to refetch on a hunch.
    defaultPreload: "intent",
  });
}
