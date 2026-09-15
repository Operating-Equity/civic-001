# CIVIC

Paste a document, a transcript, a speech, a study or a link. CIVIC extracts every empirical claim it
contains, tests the first twenty at the same time, and shows each determination as True, False or
Unverified with the full entry behind it.

The working application is in **[`civic-web/`](civic-web/README.md)**, which has the instructions for
running it, the settings, and how the prompts are kept.

## What it does

1. **Extraction.** The whole document goes to the model with the operator's extraction prompt. Every
   empirical claim comes back as a numbered list, shown verbatim.
2. **Determination.** The first twenty claims each go out as their own request, all at the same time,
   carrying the operator's evaluation prompt with that one claim in it. Claims beyond twenty wait for
   the reader to choose them.
3. **The entry.** Each card shows the verdict in its own colour, the complete entry, the model's
   reasoning summary, every web search it ran, every source it cited, and the raw text.

A live count of True, False and Unverified updates as each claim finishes. **Download full run**
writes the source, the verbatim extraction output and every entry to one Markdown file.

## Two rules the code exists to keep

1. **Nothing runs that was not submitted.** No sample, no seeded text, no demo mode, no preloaded
   result anywhere in the product. The page is empty until a document is given to it.
2. **Nothing the model returns is edited, trimmed or withheld.** The prompts are sent verbatim and the
   entry is rendered whole. There is no output cap. The verdict is read from the model's own
   conclusion, and when it cannot be read the card says so and the claim is counted in no column.

## The prompts

The prompts are the product and are never in this repository. They are loaded at startup from
environment variables or from gitignored files, kept in server memory, never logged, never returned by
any endpoint, and every request is sent with `store: false` so they cannot be read back from an OpenAI
dashboard. `npm run leak-check` searches every tracked file for any five-word run of the installed
prompts and fails if one is found; it runs on every push.

## Checking it

```bash
cd civic-web
npm run verify        # reads the request bodies actually sent, and the leak guard
npm start             # http://localhost:3000
```

`http://localhost:3000/check` asks the server whether CIVIC can work at all and answers in sentences:
prompts installed, key configured, OpenAI accepting the key, the key allowed to use the model.

## Layout

```
civic-web/      The application. See its README.
render.yaml     Blueprint for running the server on Render without a terminal.
```

A video fact-checking prototype lived here until September 2026, in `civic-backend/` and
`civic-frontend/`. It was removed once CIVIC replaced it and remains in the history.
