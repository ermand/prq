/**
 * Application geometry.
 *
 * The first design-system pass unified colours and typography but left each page
 * free to invent its own container, toolbar, row and control dimensions. Measured
 * at 1568px: Projects was 1568px wide, People 1088px, Settings 1024px; page
 * headers were 45–50.5px, rows 37.5–42.5px, and controls 24–29.5px.
 *
 * These constants are intentionally boring. A page may have different content;
 * it may not have different geometry without naming the exception beside it.
 */

/** GitHub-style application content width: roomy, bounded, identical everywhere. */
export const PAGE_FRAME = "mx-auto box-border w-full max-w-[80rem] px-4";
/** Global application bar. */
export const APP_NAV = "h-12 shrink-0 border-b border-border-muted bg-canvas";

/** Standard page-level toolbar surface. */
export const PAGE_TOOLBAR = "shrink-0 border-b border-border-muted bg-surface";

/** Standard toolbar contents. Pair with `PAGE_FRAME` unless the page is full-width. */
export const TOOLBAR_CONTENT =
  "flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2";

/** Column headers and data rows share a fixed vertical rhythm. */
export const TABLE_HEADER = "min-h-8";
export const TABLE_ROW = "min-h-10";

/** Dense rows inside a detail section; distinct from the primary 40px lists. */
export const SUBTABLE_ROW = "min-h-8";

/** Search/select/primary actions in page toolbars. */
export const TOOLBAR_CONTROL =
  "h-8 rounded-md border border-border bg-canvas px-3 font-sans text-chip leading-none text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-muted focus:border-accent";

/** Compact actions inside rows. */
export const ROW_CONTROL =
  "h-7 rounded-md border px-2 font-sans text-chip leading-none transition-colors";
