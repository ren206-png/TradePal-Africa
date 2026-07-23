// Registers @testing-library/jest-dom's DOM matchers (toBeInTheDocument, etc.)
// onto vitest's `expect`, and cleans up the jsdom render tree after each test
// so one test's DOM doesn't leak into the next.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
