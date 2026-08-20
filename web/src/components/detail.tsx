/**
 * The detail panel — the thing a terminal row has no room for.
 *
 * Everything here is already in the store; none of it costs a request. The panel
 * exists because 80 columns forced the TUI to choose between the title and the
 * evidence, and a browser does not have to choose.
 */

import { Link } from "@tanstack/react-router";
import { label, type Change } from "../../../src/changes";
import { BUCKETS, bucketOf, type PullRequest } from "../../../src/domain";
import { relativeAge } from "../../../src/render";
import { Badge, providerLabel } from "./ui";

const STANDING: Record<PullRequest["standing"], string> = {
  mine: "I opened it",
  "awaiting-me": "waiting on my review",
  "i-requested-changes": "I requested changes",
  "i-approved": "I approved it",
  "i-commented": "I commented",
  "not-involved": "not involved",
};

/**
 * Abbreviates a git object id, and only an object id. A `pushed-while-blocked`
 * change carries two full 40-character head oids, which wrapped over three
 * lines and buried the change it was describing. Anything that is not plainly
 * an oid — a verdict, a bucket number, a branch name — is left alone.
 */
function short(value: string): string {
  return /^[0-9a-f]{20,}$/.test(value) ? value.slice(0, 12) : value;
}

export function Detail({
  pr,
  changes,
  now,
}: {
  pr: PullRequest;
  changes: Change[];
  now: Date;
}) {
  const bucket = BUCKETS.find((b) => b.id === bucketOf(pr));

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border-muted p-4">
        {/* The panel is the safe place to reach the dashboards. The row itself
            already carries two targets that must not overlap — select, and leave
            for the forge — and a third inside it would be a nested anchor. */}
        <div className="flex items-center gap-2 font-mono text-meta text-fg-muted">
          <span>{providerLabel(pr.provider)}</span>
          <Link
            to="/repos"
            search={{ r: `${pr.provider}:${pr.repo}` }}
            title="This project's history"
            className="truncate hover:text-accent hover:underline"
          >
            {pr.repo}
          </Link>
          <span className="text-fg-muted">#{pr.number}</span>
        </div>

        {pr.url === null ? (
          // `safeUrl` rejected whatever the API returned. Saying so is better
          // than rendering a dead control.
          <p className="mt-2 text-title leading-snug text-fg">
            {pr.title}
            <span className="mt-1 block text-body font-normal text-danger">
              no usable link — the API returned an address that was not https
            </span>
          </p>
        ) : (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 block text-title leading-snug text-fg hover:text-accent hover:underline"
          >
            {pr.title}
            <span className="ml-1.5 text-fg-muted">↗</span>
          </a>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5">
          {bucket && <Badge tone="info">{bucket.label}</Badge>}
          {pr.draft && <Badge tone="mute">draft</Badge>}
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-b border-border-muted p-4">
        <Field name="author">
          {pr.author === "" ? (
            <span className="text-fg-subtle">unknown</span>
          ) : (
            <Link
              to="/people"
              search={{ id: `${pr.provider}:${pr.author}` }}
              title="This person's profile"
              className="hover:text-accent hover:underline"
            >
              {pr.author}
            </Link>
          )}
        </Field>
        <Field name="standing">{STANDING[pr.standing]}</Field>
        <Field name="verdict">{pr.verdict.replace("-", " ")}</Field>
        <Field name="checks">{pr.checks}</Field>
        <Field name="merge">{pr.merge}</Field>
        <Field name="base">
          <span className="font-mono text-meta">{pr.baseRef}</span>
        </Field>
        <Field name="head">
          <span className="font-mono text-meta">{pr.headOid.slice(0, 12) || "—"}</span>
        </Field>
        <Field name="updated">{relativeAge(pr.updatedAt, now)}</Field>
        <Field name="opened">{relativeAge(pr.createdAt, now)}</Field>
        {pr.viaCodeOwners && <Field name="routed">via CODEOWNERS</Field>}
        {pr.otherReviews > 0 && (
          <Field name="others">{pr.otherReviews} opinionated review(s)</Field>
        )}
      </dl>

      {pr.staleBlock !== null && (
        <div className="border-b border-border-muted p-4">
          <h3 className="text-section text-fg-muted uppercase">
            My block
          </h3>
          <p className="mt-1.5 text-body text-fg">
            {pr.staleBlock.value
              ? "The head has moved since I requested changes — my objection may already be addressed."
              : "The head has not moved since I requested changes."}
            {pr.staleBlock.precision === "approximate" && (
              <span className="mt-1 block text-fg-muted">
                Approximate: this provider attaches no commit to a review, so it
                compares timestamps instead.
              </span>
            )}
          </p>
        </div>
      )}

      {pr.stacks.length > 0 && (
        <div className="border-b border-border-muted p-4">
          <h3 className="text-section text-fg-muted uppercase">
            Stacks
          </h3>
          <ul className="mt-2 space-y-1.5">
            {pr.stacks.map((stack) => (
              <li key={stack.id} className="flex items-center gap-2">
                <Badge tone="info">
                  {stack.position}/{stack.size}
                  {stack.precision === "approximate" && "~"}
                </Badge>
                <span className="truncate font-mono text-meta text-fg-muted">
                  {stack.id}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="p-4">
        <h3 className="text-section text-fg-muted uppercase">
          Since the last sync
        </h3>
        {changes.length === 0 ? (
          <p className="mt-1.5 text-body text-fg-muted">Unchanged.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {changes.map((change) => (
              <li key={change.kind} className="flex items-baseline gap-2">
                <Badge tone="urgent">{label(change.kind)}</Badge>
                <span className="min-w-0 text-meta text-fg-muted">
                  {change.from !== null && change.to !== null ? (
                    <>
                      <span className="text-fg-muted">{short(change.from)}</span>
                      {" → "}
                      <span className="text-fg">{short(change.to)}</span>
                    </>
                  ) : (
                    short(change.to ?? change.from ?? "")
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Field({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-label text-fg-muted">{name}</dt>
      <dd className="truncate text-body text-fg">{children}</dd>
    </>
  );
}
