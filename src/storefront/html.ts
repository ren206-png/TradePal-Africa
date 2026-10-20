import { formatMoney } from "../domain/money.js";

/**
 * Tiny server-side HTML helpers for the storefront (expansion Phase 4, sections 10 and 16). No JavaScript, no web fonts, no
 * images by default: pages stay small enough for a modest phone on a slow connection. EVERY dynamic value goes through
 * `esc()`; there is no other way to put text into a page.
 */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[c] as string);
}

export function money(amountMinor: bigint, exp: number, currency: string): string {
  return `${formatMoney(amountMinor, exp)} ${esc(currency)}`;
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#111;background:#fff}
main{max-width:40rem;margin:0 auto;padding:1rem}h1{font-size:1.4rem;margin:.5rem 0}h2{font-size:1.1rem;margin:1.2rem 0 .4rem}
a{color:#0b4f9c}.muted{color:#4a4a4a;font-size:.9rem}.card{border:1px solid #bbb;border-radius:.5rem;padding:.75rem;margin:.6rem 0}
label{display:block;margin:.6rem 0 .2rem;font-weight:600}input,select,textarea{width:100%;padding:.7rem;font:inherit;border:1px solid #555;border-radius:.4rem;min-height:2.75rem}
button,.btn{display:inline-block;min-height:2.75rem;padding:.65rem 1rem;font:inherit;font-weight:600;color:#fff;background:#0b4f9c;border:0;border-radius:.4rem;cursor:pointer;text-decoration:none}
button.secondary{background:#fff;color:#0b4f9c;border:2px solid #0b4f9c}.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:1rem;background:#e8eef6;font-size:.85rem}.warn{background:#fff3cd;border-color:#8a6d00}.err{color:#8a0000;font-weight:600}
table{width:100%;border-collapse:collapse}td,th{padding:.35rem;text-align:left;border-bottom:1px solid #ddd}td.n,th.n{text-align:right}
`;

export function page(title: string, body: string, opts: { nav?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${opts.nav ?? ""}${body}</main></body></html>`;
}

export const notFoundPage = (): string => page("Not found", `<h1>We could not find that</h1><p>The link may have expired or the shop may be closed.</p>`);
