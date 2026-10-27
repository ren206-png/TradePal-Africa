import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * A QR code drawn in the browser from the setup address (`otpauth://...`). The setup key never leaves this page: nothing is sent to a
 * server or an image service to make the picture.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    QRCode.toString(value, { type: "svg", margin: 2, width: 220, errorCorrectionLevel: "M", color: { dark: "#0f2a22", light: "#ffffff" } })
      .then((svg) => { if (!cancelled) setSrc(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [value]);

  if (failed) return <p>Could not draw the QR code. Use the setup key below instead.</p>;
  if (!src) return <p>Preparing your QR code…</p>;
  return <img src={src} alt={label} width={220} height={220} style={{ background: "#fff", borderRadius: 8, border: "1px solid #e5dccb" }} />;
}
