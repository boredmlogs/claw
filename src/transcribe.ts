import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Transcribe an audio file using OpenAI's Whisper API.
 * Returns the transcript text, or empty string on failure.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const { OPENAI_API_KEY } = readEnvFile(['OPENAI_API_KEY']);
  if (!OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY not configured, skipping transcription');
    return '';
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    const form = new FormData();
    form.append('model', 'whisper-1');
    form.append('file', new Blob([fileBuffer]), fileName);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error({ status: response.status, body: errText }, 'Whisper API error');
      return '';
    }

    const result = await response.json() as { text: string };
    logger.info({ filePath, length: result.text.length }, 'Audio transcribed');
    return result.text;
  } catch (err) {
    logger.error({ err, filePath }, 'Failed to transcribe audio');
    return '';
  }
}
