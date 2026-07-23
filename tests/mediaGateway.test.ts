import { describe, expect, it, vi } from "vitest";
import { downloadWhatsAppMedia } from "../src/whatsapp/mediaGateway.js";

describe("downloadWhatsAppMedia", () => {
  it("resolves the media ID to a URL, then downloads the bytes from it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: "https://lookaside.example/media-1", mime_type: "audio/ogg; codecs=opus" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));

    const result = await downloadWhatsAppMedia({ accessToken: "test-token", fetchImpl }, "media-1");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://graph.facebook.com/v21.0/media-1");
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://lookaside.example/media-1");
    expect((fetchImpl.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-token" });

    expect(result.mimeType).toBe("audio/ogg; codecs=opus");
    expect(Buffer.from(result.buffer)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("falls back to application/octet-stream when the metadata response has no mime_type", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://lookaside.example/media-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));

    const result = await downloadWhatsAppMedia({ accessToken: "test-token", fetchImpl }, "media-1");
    expect(result.mimeType).toBe("application/octet-stream");
  });

  it("throws when the media-metadata request fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));

    await expect(downloadWhatsAppMedia({ accessToken: "test-token", fetchImpl }, "media-1")).rejects.toThrow(
      /Failed to resolve WhatsApp media 'media-1' \(404\)/,
    );
  });

  it("throws when the metadata response has no url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ mime_type: "audio/ogg" }), { status: 200 }));

    await expect(downloadWhatsAppMedia({ accessToken: "test-token", fetchImpl }, "media-1")).rejects.toThrow(
      /had no download url/,
    );
  });

  it("throws when the file download itself fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://lookaside.example/media-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("gone", { status: 410 }));

    await expect(downloadWhatsAppMedia({ accessToken: "test-token", fetchImpl }, "media-1")).rejects.toThrow(
      /Failed to download WhatsApp media 'media-1' \(410\)/,
    );
  });
});
