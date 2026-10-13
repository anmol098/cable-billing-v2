// The reports section's page: its list of pages (T-029). Sub-pages are built by feature tasks.
import { placeholderMetadata, SectionIndexPage } from "@/components/shell/placeholder-page";

export const generateMetadata = () => placeholderMetadata("reports");

export default function Page() {
  return <SectionIndexPage section="reports" />;
}
