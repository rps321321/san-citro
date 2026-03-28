import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <h1 className="text-6xl font-bold tracking-tighter text-muted-foreground">
        404
      </h1>
      <p className="mt-2 text-lg text-muted-foreground">Page Not Found</p>
      <p className="mt-1 text-sm text-muted-foreground/70">
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>
      <a href="/search">
        <Button className="mt-6" variant="outline">
          <SearchIcon className="size-4" />
          Back to Search
        </Button>
      </a>
    </div>
  );
}
