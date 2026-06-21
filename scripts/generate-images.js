import 'dotenv/config';
import OpenAI from 'openai';
import { resolveTargetWeek } from './utils/dates.js';
import { readJsonFile, writeBinaryFile, writeJsonFile, ensureDir } from './utils/fs.js';
import { logger } from './utils/logger.js';

async function main() {
  await logger.info('Generate images started');
  try {
    const target = resolveTargetWeek();
    const promptsFile = `output/${target.week}/prompts.json`;
    await logger.info(`Reading image prompts: ${promptsFile}`);
    const prompts = await readJsonFile(promptsFile);
    const imagesDir = `output/${target.week}/images`;
    await ensureDir(imagesDir);
    const manifest = { week: target.week, created_at: new Date().toISOString(), images: [] };
    if (process.env.GENERATE_IMAGES !== 'true') {
      await logger.info('Image generation disabled because GENERATE_IMAGES is not true');
      for (const item of prompts.items) {
        const file = `${imagesDir}/${item.slug}.png`;
        await logger.info(`Dry run: would generate image for ${item.event_title} at ${file}`);
        manifest.images.push({ event_title: item.event_title, slug: item.slug, file, status: 'skipped' });
      }
    } else {
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required when GENERATE_IMAGES=true.');
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      for (const item of prompts.items) {
        const file = `${imagesDir}/${item.slug}.png`;
        await logger.info(`Generating image for ${item.event_title}`);
        const result = await client.images.generate({ model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt: item.image_prompt, size: '1024x1792' });
        const imageBase64 = result.data?.[0]?.b64_json;
        if (!imageBase64) throw new Error(`No image data returned for ${item.event_title}`);
        await writeBinaryFile(file, Buffer.from(imageBase64, 'base64'));
        manifest.images.push({ event_title: item.event_title, slug: item.slug, file, status: 'generated' });
        await logger.info(`Generated image: ${file}`);
      }
    }
    const manifestFile = `output/${target.week}/images.json`;
    await writeJsonFile(manifestFile, manifest);
    await logger.info(`Created image manifest: ${manifestFile}`);
    await logger.info('Generate images finished successfully');
  } catch (error) { await logger.error(`Generate images failed: ${error.message}`); process.exitCode = 1; }
}
main();
