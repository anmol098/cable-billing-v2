/**
 * Class strings that tie the shell's pieces together on phones (token spacing only). Kept out of
 * the client components so server components can import the plain strings.
 *
 * Under `md` the bottom bar (`h-16`) is fixed to the bottom of the screen, so:
 * - the page area leaves room for it (`SHELL_MAIN_CLASS`);
 * - PageHeader's pinned phone action (T-007, under `sm`) sits on top of it
 *   (`PAGE_ACTION_ABOVE_NAV`, passed as `actionClassName`; `ShellPageHeader` does this). Pages
 *   with a pinned action still add `PAGE_ACTION_CLEARANCE` from `@cb/ui` to their body.
 */

/** Height of the phone bottom bar. */
export const BOTTOM_BAR_HEIGHT = "h-16";

/** PageHeader `actionClassName`: lifts its phone action bar above the bottom bar. */
export const PAGE_ACTION_ABOVE_NAV = "bottom-16";

/** The `<main>` element: gutters, and room for the bottom bar on phones. */
export const SHELL_MAIN_CLASS = "min-w-0 flex-1 px-4 pt-6 pb-24 md:px-8 md:pb-8";
