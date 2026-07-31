/**
 * Ticket #51 — PageContainer width variants for desktop content frames.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PageContainer } from "@/components/page-container";

afterEach(() => {
  cleanup();
});

describe("PageContainer (#51)", () => {
  it("defaults to the wide max-width frame", () => {
    const { container } = render(
      <PageContainer>
        <span>body</span>
      </PageContainer>
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute("data-page-container", "wide");
    expect(el.className).toMatch(/max-w-6xl/);
    expect(el.className).toMatch(/mx-auto/);
    expect(el.className).toMatch(/w-full/);
    expect(el.className).toMatch(/min-w-0/);
  });

  it("supports a narrow form-oriented variant", () => {
    const { container } = render(
      <PageContainer size="narrow">
        <span>form</span>
      </PageContainer>
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute("data-page-container", "narrow");
    expect(el.className).toMatch(/max-w-2xl/);
    expect(el.className).not.toMatch(/max-w-6xl/);
  });
});
