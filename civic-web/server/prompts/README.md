# Prompt vault

The prompts FactEngine runs are loaded by `server/prompts.js` at startup, in this order:

1. Environment variable with the full text: `CIVIC_PROMPT_EXTRACT`, `CIVIC_PROMPT_EVALUATE`, `CIVIC_PROMPT_RANK`
2. Environment variable with a file path: `CIVIC_PROMPT_EXTRACT_FILE`, etc. (a path outside the repo is fine)
3. A file in this directory: `extract.txt`, `evaluate.txt`, `rank.txt` (all gitignored)

The ranking prompt (`rank`, the second pass of 16 October) is optional: without it the claims are listed unranked.

Nothing in this directory except the `.example.txt` templates and this README is ever committed.
The prompts are never written to logs, never included in any API response, and every OpenAI
request is sent with `store: false` so the key owner cannot read them back from the OpenAI dashboard.

`evaluate.txt` must contain the token `{{CLAIM}}` where the claim is inserted. `rank.txt` must contain `{{CLAIMS}}`
once, where the numbered claims go, and may contain `{{TITLE}}` once, where the headline as published goes; its answer
is read by the headings SUMMARY, HEADLINE, HEADLINE TYPE, HEADLINE CLAIM, RANKED and NOT EMPIRICAL. Nothing else about
the prompts' content is assumed, recorded or described anywhere in this repository.
