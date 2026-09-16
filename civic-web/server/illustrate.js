// Visual echo — a symbolic image of what the document is about, generated on the operator's key
// while the claims are being extracted and tested.
//
// Two stages, both fast:
//   1. Art direction. A small, quick model reads the document and writes a concrete scene brief:
//      subject, setting, foreground, light, palette, lens. Dumping raw document text at an image
//      model is what produces generic, childish pictures; a specific brief is what does not.
//   2. Image. The brief is composed into a fixed house style drawn from the CIVIC photograph:
//      a documentary frame in morning light, people at human scale, no text of any kind.
import { config } from './config.js';
import { clientFor, withModelFallback, throughGate } from './openai.js';
import { estimateImageCost, estimateTextCost } from './pricing.js';
import { record } from './ledger.js';

const ART_DIRECTION_INSTRUCTIONS = `You are the art director for a documentary photo essay.
You will be given the text of a document. Write the brief for ONE photograph that a reader would
recognise as being about this document's subject, without any words appearing in the frame.

Answer with exactly these six lines, nothing else, no labels other than the ones shown:

SUBJECT: the single concrete thing or moment the photograph is of (a place, an object, an action, people doing something specific)
SETTING: where it is, what time of day, what season, what is visible behind it
FOREGROUND: one specific physical detail close to the camera that grounds the frame
LIGHT: the quality and direction of the light
PALETTE: four or five colours, named plainly
LENS: focal length and camera position, e.g. "35mm, eye level, half a step back"

Rules: be concrete and physical, never abstract or symbolic in the greeting-card sense. No text,
signage, logos, charts, screens, or numbers anywhere in the frame. No metaphors about truth,
scales of justice, lightbulbs, brains, magnifying glasses, or glowing orbs. If the document is
about an event, photograph the place it happened. If it is about a measurement, photograph the
thing measured. If it is about people, photograph the people at ordinary human scale.`;

const HOUSE_STYLE = `Documentary photograph, shot on a full-frame camera with natural light.
Unstaged and calm: a real moment, not an illustration and not a rendering. Fine photographic
grain, true-to-life colour, deep clear air, no haze filter, no vignette, no HDR, no glow.
Absolutely no text, letters, numbers, captions, watermarks, logos, signage, charts, diagrams,
user interfaces or screens anywhere in the image.`;

/** Stage 1: a concrete scene brief. Falls back to null so the image still gets made. */
async function artDirect({ client, text, signal }) {
  if (!config.artDirection) return null;
  const excerpt = String(text).replace(/\s+/g, ' ').slice(0, 6000);
  try {
    const { response, model } = await withModelFallback('artdirect', config.artDirectionModels, async (m) => {
      const { data: r, release } = await throughGate(client, {
        model: m,
        instructions: ART_DIRECTION_INSTRUCTIONS,
        input: [{ role: 'user', content: [{ type: 'input_text', text: excerpt }] }],
        reasoning: { effort: config.artDirectionEffort },
        stream: false,
        store: false,
      }, { kind: 'art', signal });
      release();
      return { response: r, model: m };
    });
    const brief = (response.output_text || '').trim();
    record({ kind: 'art-direction', model, usage: response.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : null, ...estimateTextCost({ model, usage: { input: response.usage?.input_tokens || 0, output: response.usage?.output_tokens || 0 } }) });
    return brief.length > 40 ? brief : null;
  } catch {
    return null; // the echo is optional; never let it break or delay the run
  }
}

export async function runIllustration({ apiKey, text, signal }) {
  const client = clientFor(apiKey);
  const startedAt = Date.now();

  const brief = await artDirect({ client, text, signal });
  const subject = brief
    ? `Photograph this brief exactly:\n${brief}`
    : `Photograph the subject matter of this text, as a real place or moment, with no words in the frame:\n${String(text).replace(/\s+/g, ' ').slice(0, 2000)}`;
  const prompt = `${subject}\n\nSTYLE:\n${HOUSE_STYLE}`;

  const image = await withModelFallback('illustrate', config.illustrateModels, async (model) => {
    const params = {
      model,
      prompt,
      n: 1,
      size: config.illustrateSize,
      quality: config.illustrateQuality,
      output_format: 'jpeg',
      output_compression: 88,
      moderation: 'low',
    };
    try {
      return await client.images.generate(params, { signal });
    } catch (err) {
      // Older image models reject the newer knobs; retry once with the minimal set.
      if (err?.status === 400 && !/model/i.test(String(err?.message))) {
        return client.images.generate({ model, prompt, n: 1, size: config.illustrateSize }, { signal });
      }
      throw err;
    }
  });

  const item = image?.data?.[0];
  if (!item) return null;
  const ms = Date.now() - startedAt;
  const cost = estimateImageCost();
  const model = image.model || null;
  record({ kind: 'illustrate', model, quality: config.illustrateQuality, artDirected: Boolean(brief), ms, usd: cost.usd, priced: cost.priced });
  const common = { model, ms, cost, artDirected: Boolean(brief) };
  if (item.b64_json) return { dataUrl: `data:image/${item.output_format || 'jpeg'};base64,${item.b64_json}`, ...common };
  if (item.url) return { url: item.url, ...common };
  return null;
}
