/**
 * The lineman app's Play Store link as a QR code (PLAN §12.3 step ④ "Play Store link + QR code"):
 * the Owner points the lineman's phone camera at the office screen. Drawn as one SVG path from
 * `uqr`'s module matrix, in the text colour on the page background (tokens only, no image file),
 * so it is rendered on the server and needs no client JavaScript.
 */
import { encode } from "uqr";

/** The SVG path of the dark modules (one `h1v1h-1z` square each), and the matrix size. */
export function qrPath(text: string): { d: string; size: number } {
  // A 2-module quiet zone (the card's padding adds more white around it); ECC M survives smudges.
  const qr = encode(text, { ecc: "M", border: 2 });
  const parts: string[] = [];
  qr.data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x} ${y}h1v1h-1z`);
    });
  });
  return { d: parts.join(""), size: qr.size };
}

export function AppQr({ url, label, hint }: { url: string; label: string; hint: string }) {
  const { d, size } = qrPath(url);
  return (
    <div className="flex flex-wrap items-center gap-4" data-testid="app-qr">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${size} ${size}`}
        shapeRendering="crispEdges"
        className="size-40 shrink-0 rounded-md border-hairline border-border bg-bg text-text"
      >
        <path d={d} fill="currentColor" />
      </svg>
      <p className="min-w-0 flex-1 text-base text-text-muted">{hint}</p>
    </div>
  );
}
