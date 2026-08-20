/**
 * Projects: the list, and one project's history.
 *
 * One route, two views, because the detail is reached by a search param rather
 * than a path segment. That is forced by the data, not chosen: a GitLab project
 * path is `albanian-technology-distribution/kesh/kesh-back`, three segments
 * deep, and no path parameter survives that. The board already made the same
 * call for `?pr=`.
 *
 * Reads stored census rows only. Nothing here touches a forge.
 */

import { createFileRoute } from "@tanstack/react-router";
import { RepoDetail } from "../components/repo-detail";
import { RepoList } from "../components/repo-list";
import { getRepo, getRepos } from "../server/census";

/** Optional by annotation, so a `Link` need not restate the whole shape. */
export interface ReposSearch {
  /** `${provider}:${path}` — absent means the list. */
  r?: string;
  q?: string;
}

export const Route = createFileRoute("/repos")({
  validateSearch: (search: Record<string, unknown>): ReposSearch => ({
    /** `${provider}:${path}` — absent means the list. */
    r: typeof search.r === "string" && search.r !== "" ? search.r : undefined,
    q: typeof search.q === "string" && search.q !== "" ? search.q : undefined,
  }),
  loaderDeps: ({ search }) => ({ r: search.r }),
  loader: async ({ deps }) => ({
    repos: await getRepos(),
    detail: deps.r === undefined ? null : await getRepo({ data: deps.r }),
  }),
  component: Repos,
});

function Repos() {
  const { repos, detail } = Route.useLoaderData();
  const { r, q } = Route.useSearch();

  if (repos.empty) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center">
        {/* The list and the detail carry their own `<h1>`; this branch is still
            the Projects page, so it needs one too or the route has none. */}
        <h1 className="sr-only">Projects</h1>
        <p className="max-w-md text-center text-body leading-relaxed text-fg-muted">
          No census yet. Run <code className="text-fg">prq census</code> to read
          every configured project's history — it takes a couple of minutes and is
          the only thing on this page that costs a request.
        </p>
      </main>
    );
  }

  if (r !== undefined && detail !== null) {
    return <RepoDetail detail={detail} />;
  }

  return <RepoList repos={repos} q={q} />;
}

