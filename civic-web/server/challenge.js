// Challenge a determination. Every step up to the OpenAI call runs for real:
// validation, file parsing, and building the request. The call itself is withheld until the
// challenge prompt is certified (config.challengeEnabled).
import path from 'node:path';
import { config } from './config.js';
import { hasPrompt, challengePrompt, VERDICT_TAG_INSTRUCTION } from './prompts.js';
import { fileToText } from './documents.js';
import { ApiError, clientFor, usageOf } from './openai.js';
import { parseEntry } from './evaluate.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const DOC_EXT = new Set(['.pdf', '.txt', '.md', '.docx', '.csv', '.json', '.html', '.srt', '.vtt']);
export const ACCEPTED_CHALLENGE_EXT = [...IMAGE_EXT, ...DOC_EXT];

/** Builds the exact OpenAI input that would be sent. Exported so it can be unit-tested. */
export async function buildChallengeInput({ claim, verdict, originalEntry, message, files }) {
  if (!claim || !String(claim).trim()) throw new ApiError(400, 'missing_claim', 'A claim is required.');
  if (!message || !String(message).trim()) {
    if (!files?.length) throw new ApiError(400, 'empty_challenge', 'Write why you believe the result is wrong, or attach evidence.');
  }
  if (files && files.length > config.challengeMaxFiles) {
    throw new ApiError(400, 'too_many_files', `Attach up to ${config.challengeMaxFiles} items.`);
  }

  const content = [];
  const attachments = [];
  for (const file of files || []) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (file.size > config.challengeMaxFileBytes) throw new ApiError(413, 'file_too_large', `${file.originalname} is larger than 20 MB.`);
    if (IMAGE_EXT.has(ext)) {
      content.push({ type: 'input_image', image_url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`, detail: 'auto' });
      attachments.push({ name: file.originalname, kind: 'image', bytes: file.size });
    } else if (DOC_EXT.has(ext)) {
      const parsed = await fileToText(file);
      content.push({ type: 'input_text', text: `[Attached document: ${file.originalname}]\n${parsed.text}` });
      attachments.push({ name: file.originalname, kind: parsed.kind, bytes: file.size, chars: parsed.chars });
    } else {
      throw new ApiError(415, 'unsupported_file', `${file.originalname}: unsupported type.`);
    }
  }

  const promptText = hasPrompt('challenge')
    ? challengePrompt({ claim, verdict, originalEntry, challenge: message })
    : null;

  // Prompt text is deliberately NOT included in the returned summary.
  return {
    ready: Boolean(promptText),
    attachments,
    request: promptText
      ? {
          model: config.evalModels[0],
          instructions: VERDICT_TAG_INSTRUCTION,
          input: [{ role: 'user', content: [{ type: 'input_text', text: promptText }, ...content] }],
          reasoning: { effort: config.evalEffort },
          tools: config.evalWebSearch ? [{ type: 'web_search' }] : undefined,
          max_output_tokens: config.evalMaxOutputTokens,
          store: false,
        }
      : null,
  };
}

export async function runChallenge({ apiKey, claim, verdict, originalEntry, message, files }) {
  const built = await buildChallengeInput({ claim, verdict, originalEntry, message, files });

  if (!config.challengeEnabled || !built.ready) {
    // Mechanics complete; the API step is withheld.
    return { submitted: false, reason: built.ready ? 'challenge_disabled' : 'challenge_prompt_not_certified', attachments: built.attachments };
  }

  const client = clientFor(apiKey);
  const response = await client.responses.create(built.request);
  const parsed = parseEntry(response.output_text || '');
  return { submitted: true, attachments: built.attachments, verdict: parsed.verdict, confidence: parsed.confidence, text: parsed.text, usage: usageOf(response) };
}
