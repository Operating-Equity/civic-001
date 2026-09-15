// Turns an uploaded file into plain text for claim extraction.
import path from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { config } from './config.js';
import { ApiError } from './openai.js';

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.srt', '.vtt', '.rtf']);

export const ACCEPTED_SOURCE_EXT = ['.txt', '.md', '.pdf', '.docx', '.csv', '.json', '.html', '.srt', '.vtt'];

export async function fileToText(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const buf = file.buffer;
  let text;
  let kind = ext.replace('.', '') || 'text';

  if (ext === '.pdf' || file.mimetype === 'application/pdf') {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getText();
      text = result.text;
    } finally {
      await parser.destroy?.();
    }
    kind = 'pdf';
  } else if (ext === '.docx' || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer: buf });
    text = result.value;
    kind = 'docx';
  } else if (TEXT_EXT.has(ext) || /^text\//.test(file.mimetype || '')) {
    text = buf.toString('utf8');
    if (ext === '.html' || ext === '.htm') text = stripHtml(text);
    if (ext === '.srt' || ext === '.vtt') text = stripCaptions(text);
  } else {
    throw new ApiError(415, 'unsupported_file', `Unsupported file type "${ext || file.mimetype}". Use .txt, .md, .pdf, .docx, .csv, .json, .html, .srt or .vtt.`);
  }

  return normalise(text, kind);
}

/**
 * Line-ending and trailing-whitespace normalisation only; no words are changed.
 * Over-length text is NOT quietly cut: `truncated` and `omitted` are always reported, and the
 * caller decides whether to refuse. Losing the tail of a document loses claims invisibly.
 */
export function normalise(text, kind = 'text') {
  let clean = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  const originalChars = clean.length;
  const limit = config.maxSourceChars > 0 ? config.maxSourceChars : Infinity; // 0 = no limit of ours
  const truncated = originalChars > limit;
  if (truncated && config.allowSourceTruncation) clean = clean.slice(0, limit);
  return { text: clean, chars: clean.length, originalChars, truncated, omitted: truncated ? originalChars - limit : 0, kind };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripCaptions(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*\d+\s*$/.test(line) && !/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(line) && !/^WEBVTT/.test(line))
    .join('\n');
}
