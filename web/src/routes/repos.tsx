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

const VARIANTS = ["A", "B", "C"] as const;
export type Variant = (typeof VARIANTS)[number];

/** Optional by annotation, so a `Link` need not restate the whole shape. */
export interface ReposSearch {
  /** `${provider}:${path}` — absent means the list. */
  r?: string;
  q?: string;
  variant?: Variant;
}

export const Route = createFileRoute("/repos")({
  validateSearch: (search: Record<string, unknown>): ReposSearch => ({
    /** `${provider}:${path}` — absent means the list. */
    r: typeof search.r === "string" && search.r !== "" ? search.r : undefined,
    q: typeof search.q === "string" && search.q !== "" ? search.q : undefined,
    /**
     * Throwaway: three competing layouts for the project page, switchable from
     * the floating bar. Whichever wins gets folded in and this param, the bar
     * and the losing variants all leave.
     */
    variant: VARIANTS.includes(search.variant as Variant)
      ? (search.variant as Variant)
      : undefined,
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
  const { r, q, variant } = Route.useSearch();

  if (repos.empty) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center">
        <p className="max-w-md text-center text-xs leading-relaxed text-zinc-500">
          No census yet. Run <code className="text-zinc-300">prq census</code> to read
          every configured project's history — it takes a couple of minutes and is
          the only thing on this page that costs a request.
        </p>
      </main>
    );
  }

  if (r !== undefined && detail !== null) {
    return <RepoDetail detail={detail} variant={variant ?? "A"} variants={VARIANTS} />;
  }

  return <RepoList repos={repos} q={q} />;
}

