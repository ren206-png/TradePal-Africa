export interface MediaGatewayDeps {
  accessToken: string;
  apiVersion?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Downloads WhatsApp-hosted media (e.g. a voice note) given its media ID.
 * Meta's Media API is a two-step flow: resolve the media ID to a
 * short-lived, pre-authenticated download URL, then fetch the bytes from
 * that URL — both requests carry the same bearer token used for outbound
 * sends (see outboundGateway.ts), since a WhatsApp access token authorizes
 * both directions for its phone number.
 */
export async function downloadWhatsAppMedia(deps: MediaGatewayDeps, mediaId: string): Promise<DownloadedMedia> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const apiVersion = deps.apiVersion ?? "v21.0";

  const metaResponse = await fetchFn(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${deps.accessToken}` },
  });
  if (!metaResponse.ok) {
    throw new Error(
      `Failed to resolve WhatsApp media '${mediaId}' (${metaResponse.status}): ${await metaResponse.text()}`,
    );
  }

  const meta = (await metaResponse.json()) as { url?: string; mime_type?: string };
  if (!meta.url) {
    throw new Error(`WhatsApp media '${mediaId}' metadata response had no download url.`);
  }

  const fileResponse = await fetchFn(meta.url, { headers: { Authorization: `Bearer ${deps.accessToken}` } });
  if (!fileResponse.ok) {
    throw new Error(`Failed to download WhatsApp media '${mediaId}' (${fileResponse.status}).`);
  }

  const arrayBuffer = await fileResponse.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type ?? "application/octet-stream" };
}
