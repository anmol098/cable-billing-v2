/**
 * Status words for customers and connections (PLAN §2.2 rule 3: icon + colour + word). Active is
 * the green "done" pill; Closed / Stopped / Removed are a quiet grey pill (nothing is wrong, so not
 * the red "problem" colour). Words come in as props (i18n strings).
 */
import { cn, Icon, StatusPill } from "@cb/ui";

/** A quiet pill: same shape as `StatusPill`, muted colour, a "close" icon. */
export function MutedPill({ label, className }: { label: string; className?: string }) {
  return (
    <span
      data-variant="muted"
      className={cn(
        "inline-flex items-center gap-1 rounded-full border-hairline border-current bg-bg px-3 py-1",
        "font-sans font-strong text-sm text-text-muted",
        className,
      )}
    >
      <Icon name="close" className="shrink-0" />
      <span>{label}</span>
    </span>
  );
}

/** `active` → green pill; anything else → muted pill. */
export function ActivePill({ active, label }: { active: boolean; label: string }) {
  return active ? <StatusPill variant="success" label={label} /> : <MutedPill label={label} />;
}
