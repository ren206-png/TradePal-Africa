import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { requireAdminRole, type AuthenticatedAdminRequest } from "../src/admin/authMiddleware.js";
import type { AdminJwtPayload } from "../src/admin/auth.js";

/**
 * requireAdminRole (authMiddleware.ts) is only ever reached in production behind requireAdminAuth
 * (adminRoutes.ts: `router.use(requireAdminAuth(...))` runs first), which always populates
 * req.adminUser on success — so every existing adminRoutes.test.ts 403 assertion exercises the
 * "role present but not allowed" branch, never the "no adminUser at all" branch. That branch is
 * still live, defensive code (a wiring mistake — e.g. a future route registered before the
 * requireAdminAuth middleware, or a unit test calling this in isolation) and untested by any
 * existing suite, so it's covered directly here rather than through an HTTP round trip.
 */
function fakeRes(): { res: Response; statusMock: ReturnType<typeof vi.fn>; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn();
  const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
  const res = { status: statusMock } as unknown as Response;
  return { res, statusMock, jsonMock };
}

function fakeReq(adminUser?: AdminJwtPayload): AuthenticatedAdminRequest {
  return { adminUser } as unknown as AuthenticatedAdminRequest;
}

const SUPPORT_PAYLOAD: AdminJwtPayload = {
  adminUserId: "admin-1",
  email: "support@tradepal.test",
  role: "SUPPORT",
  jti: "jti-1",
  exp: Math.floor(Date.now() / 1000) + 3600,
};
const SUPER_ADMIN_PAYLOAD: AdminJwtPayload = {
  adminUserId: "admin-2",
  email: "super@tradepal.test",
  role: "SUPER_ADMIN",
  jti: "jti-2",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

describe("requireAdminRole", () => {
  it("responds 403 and never calls next when req.adminUser is entirely unset (requireAdminAuth didn't run first)", () => {
    const middleware = requireAdminRole("SUPER_ADMIN", "SUPPORT");
    const { res, statusMock, jsonMock } = fakeRes();
    const next = vi.fn();

    middleware(fakeReq(undefined), res, next);

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith({ error: "You do not have permission to perform this action." });
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 403 and never calls next when adminUser's role is not in the allowed list", () => {
    const middleware = requireAdminRole("SUPER_ADMIN");
    const { res, statusMock, jsonMock } = fakeRes();
    const next = vi.fn();

    middleware(fakeReq(SUPPORT_PAYLOAD), res, next);

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith({ error: "You do not have permission to perform this action." });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next and never touches res when adminUser's role is in the allowed list", () => {
    const middleware = requireAdminRole("SUPER_ADMIN", "SUPPORT");
    const { res, statusMock } = fakeRes();
    const next = vi.fn();

    middleware(fakeReq(SUPER_ADMIN_PAYLOAD), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("allows a role appearing anywhere in a multi-role allow-list, not just the first entry", () => {
    const middleware = requireAdminRole("SUPER_ADMIN", "SUPPORT");
    const { res, statusMock } = fakeRes();
    const next = vi.fn();

    middleware(fakeReq(SUPPORT_PAYLOAD), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(statusMock).not.toHaveBeenCalled();
  });
});
