/**
 * Message catalog (expansion Phase 7). English only. Messages added in Phase 7 live here; older messages are still written
 * inline in their modules and are NOT localized (they are out of this framework's reach until moved here one by one).
 *
 * To add a translation: put `{ text, reviewedBy }` under `translations.<locale>`. Without a named `reviewedBy` it is never
 * served. Do not add text for a language you cannot read.
 */
export interface CatalogEntry {
  en: string;
  translations?: Record<string, { text: string; reviewedBy: string }>;
}

const define = <K extends string>(c: Record<K, CatalogEntry>): Record<K, CatalogEntry> => c;

export const CATALOG = define({
  // ---- conversational confirmation
  "confirm.proposal": { en: "I understood: {summary}\nReply YES to save it or NO to cancel. This expires in {minutes} minutes." },
  "confirm.proposalCode": {
    en: "I understood: {summary}\nThis needs an extra check before I save it. Reply with the code {code} to save it, or NO to cancel. This expires in {minutes} minutes.",
  },
  "confirm.heard": { en: "I heard: \"{heard}\"\n{rest}" },
  "confirm.saved": { en: "Saved: {summary}" },
  "confirm.cancelled": { en: "Cancelled. Nothing was saved." },
  "confirm.expired": { en: "That request expired. Nothing was saved. Please send it again." },
  "confirm.nothingPending": { en: "There is nothing waiting for your confirmation." },
  "confirm.changed": { en: "I could not save that because something changed: {reason} Nothing was saved. Please send it again." },
  "confirm.notYours": { en: "Only the person who sent the request can confirm it. Nothing was saved." },
  "confirm.wrongCode": { en: "That code does not match. Nothing was saved yet. Reply with the code {code}, or NO to cancel." },
  "confirm.replaced": { en: "Your earlier request was replaced by this newer one and was not saved." },
  "confirm.reminder": { en: "You still have a request waiting: {summary}\nReply YES to save it or NO to cancel." },

  // ---- clarification
  "clarify.ask": { en: "{question}\n{options}\nReply with the number, or NO to cancel." },
  "clarify.invalidChoice": { en: "Please reply with one of the numbers shown, or NO to cancel." },
  "clarify.currency": {
    en: "I could not tell which currency or denomination {amount} is in. Please send it again with the amount written in {currency}.",
  },
  "clarify.unit": { en: "Which unit did you mean for \"{item}\"?" },
  "clarify.product": { en: "Which product did you mean by \"{item}\"?" },
  "clarify.largeAmount": { en: "{amount} is a large amount for this business." },
  "clarify.suspicious": { en: "That message looked unusual, so I need an extra check." },

  // ---- consent
  "consent.optedOut": { en: "You will not get any more order messages from TradePal Africa. Reply START if you want them again." },
  "consent.optedIn": { en: "Order messages from TradePal Africa are on again for this number." },
  "consent.nothingToTurnOn": { en: "There were no order messages to turn back on for this number." },

  // ---- order updates to a shopper (each one is a registered template class)
  "order.confirmed": { en: "{seller}: your order {reference} is confirmed. Reply STOP to stop order messages." },
  "order.ready": { en: "{seller}: your order {reference} is ready for pickup. Reply STOP to stop order messages." },
  "order.dispatched": { en: "{seller}: your order {reference} is on its way. Reply STOP to stop order messages." },
  "order.cancelled": { en: "{seller}: your order {reference} was cancelled. Reply STOP to stop order messages." },

  // ---- phone connection
  "device.code": { en: "Your one-time code to connect this phone is {code}. It works once and expires in {minutes} minutes. Do not share it." },
  "device.connected": { en: "This phone is connected. Entries you make offline are saved as drafts until you review them." },
  "device.revoked": { en: "All connected phones were disconnected." },
});

export type CatalogKey = keyof typeof CATALOG;
