/**
 * Ticket #60 — ensure default disabled/hover affordances do not weaken
 * ghost, outline, or destructive recipes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button, buttonVariants } from "@/components/ui/button";

afterEach(() => {
  cleanup();
});

describe("Button variants (#60)", () => {
  it("default variant has hover, focus-visible, and solid disabled styles", () => {
    render(
      <Button disabled data-testid="primary">
        Go
      </Button>
    );
    const btn = screen.getByTestId("primary");
    expect(btn).toBeDisabled();
    expect(btn.className).toMatch(/hover:bg-primary\/90/);
    expect(btn.className).toMatch(/focus-visible:ring-/);
    expect(btn.className).toMatch(/disabled:bg-muted/);
    expect(btn.className).toMatch(/disabled:text-muted-foreground/);
    expect(btn.className).toMatch(/disabled:opacity-100/);
  });

  it("ghost, outline, and destructive keep their hover recipes and base opacity disabled", () => {
    const ghost = buttonVariants({ variant: "ghost" });
    const outline = buttonVariants({ variant: "outline" });
    const destructive = buttonVariants({ variant: "destructive" });

    expect(ghost).toMatch(/hover:bg-muted/);
    expect(outline).toMatch(/hover:bg-muted/);
    expect(destructive).toMatch(/hover:bg-destructive\/20/);
    expect(destructive).toMatch(/focus-visible:ring-destructive/);

    // Non-default variants still rely on shared disabled:opacity-50, not muted fill.
    for (const cls of [ghost, outline, destructive]) {
      expect(cls).toMatch(/disabled:opacity-50/);
      expect(cls).not.toMatch(/disabled:bg-muted/);
      expect(cls).not.toMatch(/disabled:opacity-100/);
    }
  });
});
