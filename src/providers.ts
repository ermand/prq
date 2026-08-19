/**
 * The provider seam (wayfinder ticket 0010).
 *
 * One operation. Each provider owns how it gets there, because the two shapes do
 * not converge: GitHub unions two server-side `search` queries; GitLab issues one
 * `projects(fullPaths:)` query and then filters client-side, because
 * `involves:@me` has no GitLab equivalent and provably cannot have one.
 *
 * The seam standardises the *result*, not the route.
 */

import type { Provider, PullRequest } from "./domain";

export interface ProviderScan {
  /** Rows in the shared model. Empty is a legitimate answer. */
  rows: PullRequest[];
  /**
   * Non-empty when this provider could not see its whole set. Under the
   * per-provider baseline rule, a provider with failures does not commit — so a
   * failure here freezes only this provider's diff, never the other's.
   */
  failed: string[];
  /** The account this provider speaks for. Discovered, never configured. */
  viewer: string;
}

export interface ProviderClient {
  readonly provider: Provider;
  /** Resolves the credential, or throws with a message naming the fix. */
  token(): Promise<string>;
  scan(projects: string[], token: string, signal?: AbortSignal): Promise<ProviderScan>;
}
