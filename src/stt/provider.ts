export interface SttTranscribeRequest {
  audioBuffer: Buffer;
  mimeType: string;
}

/**
 * Provider-abstraction layer, mirroring src/ai/provider.ts's AiProvider
 * (PHASE_0_FINDINGS ADR-2): the dispatcher never calls a vendor SDK/HTTP API
 * directly, so the ASR vendor can be swapped — or, per ADR-3, routed
 * per-country via CountryConfig.asrProviderConfig — without touching
 * src/messageDispatcher.ts. This phase wires up exactly one vendor
 * (OpenAI Whisper) used uniformly for every voice-enabled country; ADR-3's
 * fuller vision of a distinct vendor per language (e.g. Ghana NLP's Khaya AI
 * for Twi) remains unbuilt and is disclosed as a gap, not silently dropped.
 */
export interface SttProvider {
  /** Returns the transcript, or an empty string if no intelligible speech was detected. */
  transcribe(request: SttTranscribeRequest): Promise<string>;
}

/**
 * OpenAI's Whisper API (see PHASE_0_FINDINGS KQ4 cost/feasibility evidence).
 * Deliberately uses the simple `response_format: "json"` shape (just
 * `{ text }`) rather than `verbose_json`'s per-segment confidence data: this
 * codebase already has a separate, tested "don't guess" safety net for noisy
 * input at the AI-parse layer (parseTransactionText's confidence/
 * requiresClarification handling), so re-deriving an ASR-specific confidence
 * threshold from `no_speech_prob` here would be new, unvalidated guesswork
 * rather than reusing something already proven. Only a genuinely empty
 * transcript (Whisper's own signal that it heard no intelligible speech) is
 * treated specially, by the caller in src/messageDispatcher.ts.
 */
export class WhisperSttProvider implements SttProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey: string; model?: string; fetchImpl?: typeof fetch }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "whisper-1";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(request: SttTranscribeRequest): Promise<string> {
    const formData = new FormData();
    formData.append("file", new Blob([request.audioBuffer], { type: request.mimeType }), "voice-note");
    formData.append("model", this.model);
    formData.append("response_format", "json");

    const response = await this.fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Whisper transcription failed (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as { text?: string };
    return (data.text ?? "").trim();
  }
}
