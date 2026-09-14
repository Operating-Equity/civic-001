// Visual echo — a quick, wordless, symbolic image of what the document is about, generated on
// the reader's own key while the claims are being extracted and tested.
import { config } from './config.js';
import { clientFor, withModelFallback } from './openai.js';
import { estimateImageCost } from './pricing.js';
import { record } from './ledger.js';

const STYLE =
  'A single symbolic, wordless illustration that represents the subject matter of the text below. ' +
  'Mood: a calm present-day civic space in soft morning sunlight, warm and hopeful, clear air, ' +
  'people and places rendered with quiet realism. Composition: one central visual metaphor for the ' +
  'topic, uncluttered, no text, no letters, no numbers, no logos, no captions, no charts.';

export async function runIllustration({ apiKey, text, signal }) {
  const client = clientFor(apiKey);
  const startedAt = Date.now();
  const excerpt = String(text).replace(/\s+/g, ' ').slice(0, 2500);
  const prompt = `${STYLE}\n\nTEXT:\n${excerpt}`;

  const image = await withModelFallback('illustrate', config.illustrateModels, async (model) => {
    const params = {
      model,
      prompt,
      n: 1,
      size: config.illustrateSize,
      quality: config.illustrateQuality,
      output_format: 'jpeg',
      output_compression: 72,
      moderation: 'low',
    };
    try {
      return await client.images.generate(params, { signal });
    } catch (err) {
      // Some image models reject the newer knobs; retry with the minimal set once.
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
  record({ kind: 'illustrate', model, ms, usd: cost.usd, priced: cost.priced });
  if (item.b64_json) return { dataUrl: `data:image/${item.output_format || 'jpeg'};base64,${item.b64_json}`, model, ms, cost };
  if (item.url) return { url: item.url, model, ms, cost };
  return null;
}
