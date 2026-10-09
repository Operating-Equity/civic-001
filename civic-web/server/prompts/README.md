# Prompt vault

The three prompts FactEngine runs are loaded by `server/prompts.js` at startup, in this order:

1. Environment variable with the full text: `CIVIC_PROMPT_EXTRACT`, `CIVIC_PROMPT_EVALUATE`, `CIVIC_PROMPT_CHAT`
2. Environment variable with a file path: `CIVIC_PROMPT_EXTRACT_FILE`, etc. (a path outside the repo is fine)
3. A file in this directory: `extract.txt`, `evaluate.txt`, `chat.txt` (all gitignored)

Nothing in this directory except the `.example.txt` templates and this README is ever committed.
The prompts are never written to logs, never included in any API response, and every OpenAI
request is sent with `store: false` so the key owner cannot read them back from the OpenAI dashboard.

`evaluate.txt` must contain the token `{{CLAIM}}` where the claim is inserted. Nothing else about
the prompt's content is assumed, recorded or described anywhere in this repository.

`chat.txt` is the conversation under a result (`server/chat.js`). It has three slots: `{{INSPECTOR}}`
(the inspector the fact-check named), `{{LETTER}}` (the first letter of that name, after a title) and
`{{QUESTION}}` (the reader's message), which must sit on exactly one line. The server splits the file
at that line: everything above it is the reply's instructions, sent whole and identically on every
reply; that line and what follows is the reader's message, the question put in once. Nothing else is
added or changed. A file without exactly one `{{QUESTION}}` keeps the conversation closed, and the
check page says why.
