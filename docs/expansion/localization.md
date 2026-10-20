# Localization (Phase 7)

**Coverage: English only. Nothing else exists, and coverage is unmeasured.**

- Framework: `src/i18n/` (catalog, locale registry, `t(key, params, locale)`).
- Languages registered: English (source), French (MISSING), Krio (MISSING). MISSING means no text exists; requests fall back to English and report `fallbackUsed`.
- A translation is served only when its locale is HUMAN_REVIEWED **and** the string names a reviewer. Nothing is machine-translated, and no Krio or dialect string has been written or guessed.
- Scope: only messages added in Phase 7 use the catalog (confirmations, clarifications, consent, order updates, phone connection). Every older message is still inline English in its module.
- The admin panel shows the key count per language with the caveat that a count says nothing about whether the text reads naturally or is understood. Nobody has tested comprehension with users.
- To add a language: a speaker supplies the text, a second person reviews it, `reviewedBy` is recorded, the locale status is changed by a code review.
