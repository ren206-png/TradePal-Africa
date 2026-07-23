import { describe, expect, it, vi } from "vitest";
import { WhisperSttProvider } from "../src/stt/provider.js";

describe("WhisperSttProvider", () => {
  it("posts the audio as multipart form data and returns the trimmed transcript", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "  sold 2 bread for 500  " }), { status: 200 }));
    const provider = new WhisperSttProvider({ apiKey: "test-key", fetchImpl });

    const transcript = await provider.transcribe({ audioBuffer: Buffer.from([1, 2, 3]), mimeType: "audio/ogg" });

    expect(transcript).toBe("sold 2 bread for 500");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const formData = init.body as FormData;
    expect(formData.get("model")).toBe("whisper-1");
    expect(formData.get("response_format")).toBe("json");
    expect(formData.get("file")).toBeInstanceOf(Blob);
  });

  it("returns an empty string when Whisper heard no intelligible speech", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "" }), { status: 200 }));
    const provider = new WhisperSttProvider({ apiKey: "test-key", fetchImpl });

    const transcript = await provider.transcribe({ audioBuffer: Buffer.from([1]), mimeType: "audio/ogg" });
    expect(transcript).toBe("");
  });

  it("uses a custom model when given one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hi" }), { status: 200 }));
    const provider = new WhisperSttProvider({ apiKey: "test-key", model: "whisper-2", fetchImpl });

    await provider.transcribe({ audioBuffer: Buffer.from([1]), mimeType: "audio/ogg" });

    const formData = (fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(formData.get("model")).toBe("whisper-2");
  });

  it("throws when the Whisper API responds with a non-2xx status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const provider = new WhisperSttProvider({ apiKey: "test-key", fetchImpl });

    await expect(provider.transcribe({ audioBuffer: Buffer.from([1]), mimeType: "audio/ogg" })).rejects.toThrow(
      /Whisper transcription failed \(400\)/,
    );
  });
});
