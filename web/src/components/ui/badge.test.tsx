/**
 * Smoke component test — proves the RTL + vitest harness works.
 * Mounts a real UI surface that needs no IPC.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Badge } from "@/components/ui/badge";
import {
  installSanCitroMock,
  uninstallSanCitroMock,
} from "@/test/mock-san-citro";

afterEach(() => {
  cleanup();
  uninstallSanCitroMock();
});

describe("component test harness smoke", () => {
  it("mounts a real UI surface and asserts visible text", () => {
    installSanCitroMock();
    render(<Badge>San Citro</Badge>);
    expect(screen.getByText("San Citro")).toBeInTheDocument();
  });
});
