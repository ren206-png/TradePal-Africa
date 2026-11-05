import type { WhatsappCodeRequest } from "../lib/types";

/** Shown when a code is asked for in "message" mode: nothing was sent yet; the person writes first and the code comes back as the reply. */
export function WhatsappChatPrompt({ request }: { request: WhatsappCodeRequest }) {
  const m = request.message;
  if (!m) return <p className="login-lede">We sent a code to your WhatsApp number ending {request.last4}. It lasts 5 minutes.</p>;
  const shown = `+${m.to.replace(/^(\d)(\d{3})(\d{3})(\d+)$/, "$1 $2-$3-$4")}`;
  return (
    <div className="whatsapp-chat-prompt">
      <p className="login-lede">
        To get your code, open WhatsApp on the number ending <strong>{request.last4}</strong> and send the message <strong>{m.text}</strong> to <strong>{shown}</strong>.
        We reply with a 6-digit code within a few seconds. Then enter it below. You have 10 minutes to send the message.
      </p>
      <p><a href={m.url} target="_blank" rel="noopener noreferrer">Open WhatsApp with the message ready</a> (works best on your phone)</p>
    </div>
  );
}
