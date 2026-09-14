# Prompt vault

The three prompts CIVIC runs are loaded by `server/prompts.js` at startup, in this order:

1. Environment variable with the full text: `CIVIC_PROMPT_EXTRACT`, `CIVIC_PROMPT_EVALUATE`, `CIVIC_PROMPT_CHALLENGE`
2. Environment variable with a file path: `CIVIC_PROMPT_EXTRACT_FILE`, etc. (a path outside the repo is fine)
3. A file in this directory: `extract.txt`, `evaluate.txt`, `challenge.txt` (all gitignored)

Nothing in this directory except the `.example.txt` templates and this README is ever committed.
The prompts are never written to logs, never included in any API response, and every OpenAI
request is sent with `store: false` so the key owner cannot read them back from the OpenAI dashboard.

`evaluate.txt` must contain the placeholder `{{CLAIM}}` where the claim is inserted
(the template's first line is `Prompt = {{CLAIM}}`).
