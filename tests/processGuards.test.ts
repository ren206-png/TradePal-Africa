import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installGracefulShutdown, type ShutdownTarget } from "../src/monitoring/processGuards.js";

describe("installGracefulShutdown", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onSpy: any;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const capturedHandlers = new Map<string, (...args: unknown[]) => void>();

  beforeEach(() => {
    capturedHandlers.clear();
    // Never let a test actually terminate the vitest process.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    // Capture the SIGTERM/SIGINT handlers instead of relying on real OS
    // signals (which would affect every other listener already registered
    // on this shared `process` object across the whole test run).
    onSpy = vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      capturedHandlers.set(event, handler);
      return process;
    }) as typeof process.on);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    onSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  function makeTarget(
    name: string,
    impl: () => Promise<void> = () => Promise.resolve(),
  ): ShutdownTarget & { close: ReturnType<typeof vi.fn> } {
    return { name, close: vi.fn(impl) };
  }

  it("registers a SIGTERM and a SIGINT handler", () => {
    installGracefulShutdown("test-service", [makeTarget("t1")]);

    expect(capturedHandlers.has("SIGTERM")).toBe(true);
    expect(capturedHandlers.has("SIGINT")).toBe(true);
  });

  it("closes every target and exits 0 on SIGTERM", async () => {
    const t1 = makeTarget("t1");
    const t2 = makeTarget("t2");
    installGracefulShutdown("test-service", [t1, t2]);

    capturedHandlers.get("SIGTERM")?.("SIGTERM");

    await vi.waitFor(() => {
      expect(t1.close).toHaveBeenCalledTimes(1);
      expect(t2.close).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  it("is idempotent against a repeat signal — does not close targets twice", async () => {
    const t1 = makeTarget("t1");
    installGracefulShutdown("test-service", [t1]);

    capturedHandlers.get("SIGTERM")?.("SIGTERM");
    capturedHandlers.get("SIGTERM")?.("SIGTERM");
    capturedHandlers.get("SIGINT")?.("SIGINT");

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    expect(t1.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("a failing target does not block the others or crash the process", async () => {
    const failing = makeTarget("failing", () => Promise.reject(new Error("close boom")));
    const healthy = makeTarget("healthy");
    installGracefulShutdown("test-service", [failing, healthy]);

    capturedHandlers.get("SIGTERM")?.("SIGTERM");

    await vi.waitFor(() => {
      expect(failing.close).toHaveBeenCalledTimes(1);
      expect(healthy.close).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("error closing 'failing'"),
      expect.any(Error),
    );
  });

  it("forces exit(1) once the timeout elapses, even if a target never resolves", async () => {
    vi.useFakeTimers();
    const hangingTarget = makeTarget("hanging", () => new Promise<void>(() => {}));
    installGracefulShutdown("test-service", [hangingTarget], 50);

    capturedHandlers.get("SIGTERM")?.("SIGTERM");
    expect(exitSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("exceeded 50ms — forcing exit."));
  });
});
