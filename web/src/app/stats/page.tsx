import { SearchIcon } from "lucide-react";

export default function StatsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Stats</h1>
        <p className="text-sm text-muted-foreground">Statistics overview</p>
      </div>

      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <SearchIcon className="size-12 mb-4 opacity-30" />
        <p className="text-sm font-medium">
          Stats are not available — this app uses live search from
          Anna&apos;s Archive
        </p>
        <p className="text-xs mt-2">
          <a
            href="/search"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Go to Search
          </a>
        </p>
      </div>
    </div>
  );
}
