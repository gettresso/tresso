# tresso website

The marketing site for [tresso](https://gettresso.com), the email client where every email is something to do, hand
over or know. A static [Astro](https://astro.build) site in English and Dutch. It is not part of the npm workspaces at
the root: it has its own `package-lock.json`, so the apps never install its dependencies.

## Develop

You need Node 22.22 or newer. Run everything from `apps/website`:

```bash
npm install
```

```bash
npm run dev
```

`npm run build` type-checks the project (including that every locale has the same keys as English) and writes the
static site to `dist/`.

## Structure

| Path | What it holds |
|---|---|
| `src/i18n/en.ts` | All English copy. The source of truth for the shape of every locale |
| `src/i18n/nl.ts` | Dutch copy, typed against the English dictionary |
| `src/pages/[...locale]/` | Pages, generated once per locale: `/` for English, `/nl/` for Dutch |
| `src/components/` | Mark, wordmark, verdict chips, header, footer |
| `src/styles/global.css` | Brand tokens (light and dark), type and shared styles |
| `src/config/site.ts` | Site URL, contact address and the repository link |

## Brand rules

- The name is always lowercase: tresso. Wordmark in Bricolage Grotesque 700, letter-spacing -0.03em.
- Bricolage Grotesque for display only, Instrument Sans for all text, JetBrains Mono for code and keys.
- Color is only for the three verdicts, and a verdict is always shown as icon plus word.
- No gradients, no emoji, no em or en dashes in copy.
- `[PRICE]` marks prices that are not decided yet.

## Hosting

The site is plain static files in `dist/`, so any static host serves it. gettresso.com runs on the Cloudflare Pages
project `tresso-website`; the project, its domains (gettresso.com and www.gettresso.com) and the DNS records live in
Terraform in [SherinBloemendaal/dns](https://github.com/SherinBloemendaal/dns). [CI](../../.github/workflows/ci.yml)
type-checks and builds the site on every push and pull request.
