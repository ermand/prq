import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles.css?url";
import { Nav } from "../components/nav";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "prq" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: () => (
    <Shell>
      <div className="flex h-screen flex-col">
        <Nav />
        <Outlet />
      </div>
    </Shell>
  ),
});

function Shell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
