import { CATALOG } from "../i18n/index.js";
import { MESSAGE_CLASSES } from "./registry.js";
import { templateParamOrder } from "./send.js";

/** Renders `docs/expansion/message-template-register.md` from the code registry. `tests/messagingRegistry.test.ts` fails if the file on disk differs. */
export function renderTemplateRegister(): string {
  let out = "# Message template register\n\n";
  out += "Generated from `src/messaging/registry.ts` by `npx tsx scripts/genTemplateRegister.ts > docs/expansion/message-template-register.md`. The code is the source of truth and `tests/messagingRegistry.test.ts` fails when this file is stale.\n\n";
  out += "**Approval state of every template in this register: NOT SUBMITTED.** No template has been created in WhatsApp Business Manager, submitted to Meta, or approved. Until an operator records an approval (provider template name and where the approval can be checked) in the admin messaging panel, a class that needs a template is suppressed, not sent. Consumer messaging is off: the flag `consumerMessaging` defaults to off, the platform switch `CONSUMER_MESSAGING_ENABLED` is unset, and no existing customer number has ever been messaged.\n\n";
  out += "Rules (master prompt sections 14-16): a message class that is not in this register cannot be sent through the pipeline; order updates and marketing are separate permissions; there is no marketing class; there is no debt-collection, lending or reminder-to-pay class; every shopper message names the seller; a shopper who sends STOP is blocked platform-wide until they send START.\n\n";
  out += "Pipeline column: **ENFORCED** = sent only through `sendMessage` (class, consent, block list, window, template approval, switch, log). **REPLY** = free-text answer to the registered merchant who just wrote, via the dispatcher's reply, inside the window they opened; not in the outbound log. **LEGACY** = existed before Phase 7 and sends through its own module; documented here, NOT subject to the new checks.\n\n";
  out += "| Class | Audience | Category | Pipeline | Trigger | Consent basis | Window rule | Template / body | Params | Approval |\n|---|---|---|---|---|---|---|---|---|---|\n";
  for (const c of MESSAGE_CLASSES) {
    const body = c.bodyKey ? `\`${CATALOG[c.bodyKey].en.replace(/\n/g, " ⏎ ").replace(/\|/g, "\\|")}\`` : c.legacyTemplateEnv ? `provider template from \`${c.legacyTemplateEnv}\`` : "free text";
    const params = c.pipeline === "ENFORCED" && c.windowRule !== "SESSION_ONLY" ? templateParamOrder(c).map((p, i) => `{{${i + 1}}}=${p}`).join(", ") || "-" : "-";
    const needsTemplate = c.windowRule !== "SESSION_ONLY";
    const approval = c.pipeline === "ENFORCED" ? (needsTemplate ? "NOT SUBMITTED (suppressed)" : "not needed (session reply)") : c.pipeline === "REPLY" ? "not needed (session reply)" : "legacy: outside this register's control";
    out += `| \`${c.id}\` | ${c.audience} | ${c.category} | ${c.pipeline} | ${c.trigger} | ${c.consentBasis}${c.consentPurpose ? ` (${c.consentPurpose})` : ""} | ${c.windowRule} | ${body} | ${params} | ${approval} |\n`;
  }
  out += "\n## Notes per class\n\n";
  for (const c of MESSAGE_CLASSES) out += `- \`${c.id}\`: ${c.notes}\n`;
  return out;
}
