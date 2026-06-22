import 'dotenv/config';
import OpenAI from 'openai';
import { resolveTargetWeek } from './utils/dates.js';
import { readJsonFile, readTextFile, writeJsonFile } from './utils/fs.js';
import { slugify } from './utils/slug.js';
import { logger } from './utils/logger.js';

const FALLBACK_HASHTAGS = ['#Melody4U', '#MusicGift', '#PersonalWish', '#GiftIdea', '#ForTheFans', '#GameNight', '#RaceWeekend', '#FamilyMoment', '#ThoughtfulMoment', '#NeverForgotten', '#HockeyNight'];
const ALLOWED_COMPOSITION_TYPES = ['fan_with_phone', 'family_at_home', 'stadium_atmosphere', 'closeup_phone_gift', 'city_event_mood', 'motorsport_track', 'child_or_family_moment', 'seasonal_symbolic_scene', 'respectful_memorial_scene', 'awareness_symbolic_scene'];
const ALLOWED_TONES = ['fan_hype', 'celebration', 'respectful_memorial', 'awareness'];
const ALLOWED_EVENT_ORIGINS = ['international_significant_day', 'czech_significant_day', 'sport', 'motorsport', 'seasonal', 'other'];
const ALLOWED_LANGUAGE_POLICIES = ['english', 'czech', 'bilingual_cs_en'];
const NEGATIVE_STYLE_INSTRUCTION = 'Avoid flat vector art, simple illustration, childish cartoon, bland orange poster, weak composition, low-detail background, minimal poster, generic stock art, fake official logos, fake team badges, real athlete faces, exact official uniforms, excessive text.';


function previewText(value, maxLength = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function extractJson(rawText) {
  const text = String(rawText ?? '').trim();
  try { return JSON.parse(text); } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd > objectStart) return JSON.parse(text.slice(objectStart, objectEnd + 1));
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) return JSON.parse(text.slice(arrayStart, arrayEnd + 1));
    throw new Error(`Response was not parseable JSON. First 1000 chars: ${previewText(text)}`);
  }
}

function chooseCompositionType(event, index) {
  const category = String(event.category ?? '').toLowerCase();
  const title = String(event.title ?? event.event_title ?? '').toLowerCase();
  const tone = event.tone;
  if (tone === 'respectful_memorial') return 'respectful_memorial_scene';
  if (tone === 'awareness') return 'awareness_symbolic_scene';
  if (tone === 'celebration') return ['child_or_family_moment', 'seasonal_symbolic_scene', 'closeup_phone_gift'][index % 3];
  if (category.includes('motor') || title.includes('formula') || title.includes('motogp')) return 'motorsport_track';
  if (title.includes('hockey') || title.includes('football') || category.includes('sport')) return ['fan_with_phone', 'family_at_home', 'stadium_atmosphere'][index % 3];
  return ALLOWED_COMPOSITION_TYPES[index % ALLOWED_COMPOSITION_TYPES.length];
}

function safeTextForEvent(event) {
  const title = String(event.title ?? event.event_title ?? 'Make the Moment Sing').toLowerCase();
  if (event.language_policy === 'bilingual_cs_en') return { text_on_image: 'Choose Hope / Volíme naději', text_on_image_en: 'Choose Hope', text_on_image_cs: 'Volíme naději' };
  if (event.language_policy === 'czech') {
    if (title.includes('communist') || title.includes('political prisoner') || title.includes('victim')) return { text_on_image: 'Nikdy nezapomeneme', text_on_image_cs: 'Nikdy nezapomeneme', text_on_image_en: '' };
    if (title.includes('john') || title.includes('jan') || title.includes('midsummer')) return { text_on_image: 'Svatojánská noc', text_on_image_cs: 'Svatojánská noc', text_on_image_en: '' };
    return { text_on_image: 'S úctou vzpomínáme', text_on_image_cs: 'S úctou vzpomínáme', text_on_image_en: '' };
  }
  if (title.includes('world cup') || title.includes('czech republic vs')) return { text_on_image: 'World Football Night', text_on_image_en: 'World Football Night', text_on_image_cs: '' };
  if (title.includes('ice hockey')) return { text_on_image: 'Hockey Night Feeling', text_on_image_en: 'Hockey Night Feeling', text_on_image_cs: '' };
  if (title.includes('formula') || title.includes('grand prix')) return { text_on_image: 'Race Weekend Energy', text_on_image_en: 'Race Weekend Energy', text_on_image_cs: '' };
  if (title.includes('motogp')) return { text_on_image: 'Weekend Racing Spirit', text_on_image_en: 'Weekend Racing Spirit', text_on_image_cs: '' };
  if (title.includes('wimbledon')) return { text_on_image: 'Summer Sport Vibes', text_on_image_en: 'Summer Sport Vibes', text_on_image_cs: '' };
  return { text_on_image: 'Make the Moment Sing', text_on_image_en: 'Make the Moment Sing', text_on_image_cs: '' };
}

function sanitizeTextFields(item) {
  const languagePolicy = item.language_policy;
  const generated = safeTextForEvent(item);
  const text = String(item.text_on_image || generated.text_on_image).replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
  const textCs = String(item.text_on_image_cs ?? generated.text_on_image_cs ?? '').trim();
  const textEn = String(item.text_on_image_en ?? generated.text_on_image_en ?? '').trim();

  if (languagePolicy === 'bilingual_cs_en') {
    return { text_on_image: text.includes('/') ? text : generated.text_on_image, text_on_image_cs: textCs || generated.text_on_image_cs, text_on_image_en: textEn || generated.text_on_image_en };
  }
  if (languagePolicy === 'czech') {
    return { text_on_image: textCs || text || generated.text_on_image, text_on_image_cs: textCs || text || generated.text_on_image_cs, text_on_image_en: '' };
  }
  return { text_on_image: textEn || text || generated.text_on_image, text_on_image_cs: '', text_on_image_en: textEn || text || generated.text_on_image_en };
}

function eventVisualGuidance(event, compositionType) {
  const text = `${event.title ?? event.event_title ?? ''} ${event.category ?? ''} ${compositionType}`.toLowerCase();
  if (text.includes('world cup') || text.includes('football') || text.includes('czechia vs') || text.includes('czech republic vs')) {
    return 'Football / Czech match direction: dramatic stadium night, Czech fan energy, symbolic football players or fan silhouettes, safe symbolic flags/colors if needed, smartphone with Melody4U gift/music message, no real player faces, no official badges, no official FIFA branding, avoid exact national crests.';
  }
  if (text.includes('formula') || text.includes('f1') || text.includes('grand prix')) {
    return 'Formula 1 direction: cinematic racing track at golden hour or night, dramatic generic race car silhouettes, speed trails, neon purple/magenta Melody4U accents, phone with Melody4U gift/music CTA, no official F1 logo, no team liveries, no real cars or exact branding.';
  }
  if (text.includes('motogp') || text.includes('moto gp')) {
    return 'MotoGP direction: cinematic motorcycle racing energy, motion blur, racing weekend atmosphere, visible phone/product anchor, no official MotoGP logo, no official rider likenesses.';
  }
  if (event.tone === 'respectful_memorial' || event.tone === 'awareness') {
    return 'Memorial / awareness direction: respectful premium social poster, symbolic candles, light, silhouettes and quiet dignity, no graphic imagery, no sensationalism, still visually polished and shareable, follow correct Czech/bilingual text rules.';
  }
  return 'General Melody4U direction: emotional social moment, visible phone/product anchor, neon music energy and polished campaign-poster layout.';
}

function buildImagePrompt(event, compositionType, textFields, visualStyleGuide = '') {
  const compositionDescriptions = {
    fan_with_phone: 'a Czech fan with a smartphone in the foreground, energetic but symbolic stadium atmosphere, no team marks',
    family_at_home: 'a family at home watching a big match together, smartphone visible as a personal music gift, warm living-room light',
    stadium_atmosphere: 'generic stadium lights, abstract crowd silhouettes, smartphone in the foreground, no official competition branding',
    closeup_phone_gift: 'close-up hands presenting a smartphone like a personal gift, gentle glow, music notes and sound waves',
    city_event_mood: 'warm city evening mood with people sharing a thoughtful greeting on a smartphone',
    motorsport_track: 'symbolic racing track energy with generic vehicles as motion streaks, smartphone visible, no official racing identity',
    child_or_family_moment: 'tender family-friendly celebration moment with smartphone greeting, soft lights and music notes',
    seasonal_symbolic_scene: 'seasonal Czech summer mood, lantern-like warm lights, smartphone greeting, subtle sound waves',
    respectful_memorial_scene: 'calm dignified memorial scene with candlelight, subtle Czech atmosphere, smartphone with respectful message, no hype',
    awareness_symbolic_scene: 'thoughtful human awareness scene with hopeful light, supportive mood, smartphone message, no fear or shock visuals'
  };
  const toneGuidance = {
    fan_hype: 'energetic, exciting, vivid, social-media friendly, symbolic fan atmosphere',
    celebration: 'warm, festive, emotional, family-friendly',
    respectful_memorial: 'calm, dignified, serious, subtle, respectful, no hype',
    awareness: 'thoughtful, human, socially aware, hopeful, no fearmongering'
  }[event.tone] || 'warm and social-media friendly';
  const languageDescription = event.language_policy === 'bilingual_cs_en' ? 'Czech and English bilingual visible text' : event.language_policy === 'czech' ? 'Czech-only visible text' : 'English-only visible text';
  const styleBlock = visualStyleGuide ? `Melody4U visual style guide:\n${visualStyleGuide.trim()}\n\n` : '';

  return `${styleBlock}Create a premium cinematic vertical 9:16 social media campaign poster suitable for TikTok, Instagram Reels and Facebook. The result must look like a professional Melody4U social ad, not a simple illustration or generic AI poster. Use layered cinematic composition, dramatic lighting, depth, particles, glow, lens flare, high contrast, and neon purple/magenta/blue Melody4U brand energy. Use a strong central subject, big bold mobile-readable headline typography, and a visible smartphone as the product/action anchor showing a Melody4U music gift or personal wish concept. Add glowing music notes, sound waves, waveform UI or light trails. Visible text must be exactly: "${textFields.text_on_image}". Do not add other large text, invented match details, dates, times, groups, fake scores, team names or extra slogans. Small generic phone UI text may say only "Create Gift" or "Create a music gift". Visible text language: ${languageDescription}. Tone: ${event.tone} (${toneGuidance}). Composition type ${compositionType}: ${compositionDescriptions[compositionType]}. Theme: ${event.title}. Marketing angle: ${event.marketing_angle || 'personal Melody4U greeting'}. ${eventVisualGuidance(event, compositionType)} Restrictions: no official logos, no official badges, no copyrighted team badges, no real athlete faces, no real celebrity likenesses, no exact trademarked visual identity, no graphic or disturbing imagery, no sensationalism. ${NEGATIVE_STYLE_INSTRUCTION}`;
}

function enhanceImagePrompt(promptItem, visualStyleGuide = '') {
  const baseItem = {
    ...promptItem,
    title: promptItem.event_title,
    marketing_angle: promptItem.marketing_angle || 'personal Melody4U music gift'
  };
  return buildImagePrompt(baseItem, promptItem.composition_type, { text_on_image: promptItem.text_on_image }, visualStyleGuide);
}

function normalizePromptResponse(parsed, week) {
  if (Array.isArray(parsed)) return { week, created_at: new Date().toISOString(), items: parsed };
  if (!parsed || typeof parsed !== 'object') throw new Error('Prompt JSON must be an object or an array that can be normalized.');
  if (Array.isArray(parsed.items)) return { ...parsed, week, created_at: new Date().toISOString() };
  for (const key of ['prompts', 'events', 'results']) {
    if (Array.isArray(parsed[key])) return { week, created_at: new Date().toISOString(), items: parsed[key] };
  }
  throw new Error('Prompt JSON must include an items array, or a normalizable prompts/events/results array.');
}

function normalizeHashtags(hashtags, item) {
  const normalized = Array.isArray(hashtags)
    ? hashtags.filter((hashtag) => typeof hashtag === 'string' && hashtag.trim()).map((hashtag) => hashtag.trim())
    : [];
  if (!normalized.includes('#Melody4U')) normalized.unshift('#Melody4U');
  const toneTags = item.tone === 'respectful_memorial' ? ['#NeverForgotten', '#ThoughtfulMoment'] : item.tone === 'awareness' ? ['#ThoughtfulMoment', '#PersonalWish'] : item.event_origin === 'motorsport' ? ['#RaceWeekend', '#ForTheFans'] : ['#MusicGift', '#GiftIdea', '#ForTheFans'];
  for (const hashtag of [...toneTags, ...FALLBACK_HASHTAGS]) {
    if (normalized.length >= 5) break;
    if (!normalized.includes(hashtag)) normalized.push(hashtag);
  }
  return normalized.slice(0, 5);
}



function thirdSundayOfJune(year) {
  const date = new Date(Date.UTC(year, 5, 1));
  const daysUntilSunday = (7 - date.getUTCDay()) % 7;
  date.setUTCDate(1 + daysUntilSunday + 14);
  return date.toISOString().slice(0, 10);
}

function dateIsInTarget(date, target) {
  return date >= target.date_from && date <= target.date_to;
}

function isKnownOutOfWeekHoliday(item, target) {
  const text = `${item.title ?? ''} ${item.event_title ?? ''} ${item.category ?? ''}`;
  if (/father'?s day|fathers day|den otc[uů]/i.test(text)) {
    const year = Number(String(target.date_from).slice(0, 4));
    return !dateIsInTarget(thirdSundayOfJune(year), target);
  }
  return false;
}

function isMotoBackupTopic(item) {
  return /motogp|moto gp/i.test(`${item.title ?? ''} ${item.event_title ?? ''} ${item.category ?? ''}`);
}

function isBlockedImageTopic(item) {
  return /summer solstice|letn[íi] slunovrat|začátek léta|zacatek leta/i.test(`${item.title ?? ''} ${item.event_title ?? ''} ${item.category ?? ''}`);
}

function filterImageEvents(events, target) {
  const primaryEvents = events.filter((event) => !isMotoBackupTopic(event) && !isBlockedImageTopic(event) && !isKnownOutOfWeekHoliday(event, target));
  const allowMotoBackup = primaryEvents.length < 2;
  return events.filter((event) => {
    if (isBlockedImageTopic(event) || isKnownOutOfWeekHoliday(event, target)) return false;
    if (isMotoBackupTopic(event) && !allowMotoBackup) return false;
    return true;
  });
}

function filterPromptItems(items, target) {
  const primaryItems = items.filter((item) => !isMotoBackupTopic(item) && !isBlockedImageTopic(item) && !isKnownOutOfWeekHoliday(item, target));
  const allowMotoBackup = primaryItems.length < 2;
  return items.filter((item) => {
    if (isBlockedImageTopic(item) || isKnownOutOfWeekHoliday(item, target)) return false;
    if (isMotoBackupTopic(item) && !allowMotoBackup) return false;
    return true;
  });
}

function fallbackPrompts(week, events, visualStyleGuide = '') {
  return {
    week,
    created_at: new Date().toISOString(),
    items: events.map((event, index) => {
      const compositionType = chooseCompositionType(event, index);
      const textFields = safeTextForEvent(event);
      return {
        event_title: event.title,
        date: event.date,
        category: event.category,
        tone: event.tone,
        event_origin: event.event_origin,
        language_policy: event.language_policy,
        composition_type: compositionType,
        ...textFields,
        image_prompt: buildImagePrompt(event, compositionType, textFields, visualStyleGuide),
        reels_text: `${textFields.text_on_image} — create a personal Melody4U music wish for this moment.`,
        hashtags: normalizeHashtags([], event),
        slug: slugify(event.title)
      };
    })
  };
}

function validatePrompts(data, week, visualStyleGuide = '') {
  const normalized = normalizePromptResponse(data, week);
  normalized.items = normalized.items.map((item, index) => {
    const eventTitle = item.event_title || item.title;
    const tone = ALLOWED_TONES.includes(item.tone) ? item.tone : 'fan_hype';
    const eventOrigin = ALLOWED_EVENT_ORIGINS.includes(item.event_origin) ? item.event_origin : 'other';
    const languagePolicy = ALLOWED_LANGUAGE_POLICIES.includes(item.language_policy) ? item.language_policy : 'english';
    const baseItem = { ...item, event_title: eventTitle, title: eventTitle, tone, event_origin: eventOrigin, language_policy: languagePolicy };
    const compositionType = ALLOWED_COMPOSITION_TYPES.includes(item.composition_type) ? item.composition_type : chooseCompositionType(baseItem, index);
    const textFields = sanitizeTextFields(baseItem);
    const promptItem = {
      event_title: eventTitle,
      date: item.date,
      category: item.category,
      tone,
      event_origin: eventOrigin,
      language_policy: languagePolicy,
      composition_type: compositionType,
      ...textFields,
      image_prompt: item.image_prompt || item.prompt || buildImagePrompt(baseItem, compositionType, textFields, visualStyleGuide),
      reels_text: item.reels_text || `${textFields.text_on_image} — create a personal Melody4U music wish for this moment.`,
      hashtags: normalizeHashtags(item.hashtags, { ...baseItem, composition_type: compositionType }),
      slug: item.slug || slugify(eventTitle)
    };

    promptItem.image_prompt = enhanceImagePrompt(promptItem, visualStyleGuide);

    for (const key of ['event_title', 'date', 'category', 'tone', 'event_origin', 'language_policy', 'composition_type', 'text_on_image', 'image_prompt', 'reels_text', 'slug']) {
      if (!promptItem[key]) throw new Error(`Prompt item ${index} missing required field: ${key}`);
    }
    if (promptItem.language_policy === 'bilingual_cs_en' && (!promptItem.text_on_image_cs || !promptItem.text_on_image_en || !promptItem.text_on_image.includes('/'))) throw new Error(`Prompt item ${index} must include bilingual Czech and English text fields.`);
    if (promptItem.language_policy === 'czech' && !promptItem.text_on_image_cs) throw new Error(`Prompt item ${index} must include Czech text field.`);
    if (promptItem.language_policy === 'english' && !promptItem.text_on_image_en) throw new Error(`Prompt item ${index} must include English text field.`);
    if (!Array.isArray(promptItem.hashtags) || promptItem.hashtags.length !== 5 || !promptItem.hashtags.includes('#Melody4U')) throw new Error(`Prompt item ${index} must include exactly 5 hashtags including #Melody4U.`);
    return promptItem;
  });

  normalized.week = week;
  normalized.created_at = new Date().toISOString();
  return normalized;
}

async function main() {
  await logger.info('Generate image prompts started');
  let rawResponseText = '';
  try {
    const target = resolveTargetWeek();
    const inputFile = `data/weekly/${target.week}.json`;
    await logger.info(`Reading weekly overview: ${inputFile}`);
    const overview = await readJsonFile(inputFile);
    const events = filterImageEvents(overview.events.filter((event) => event.generate_image === true && event.status === 'waiting'), target);
    await logger.info(`Found ${events.length} waiting events with generate_image=true for ${target.week}`);
    const style = await readTextFile('prompts/melody4u_style.txt');
    const visualStyle = await readTextFile('prompts/melody4u_visual_style.txt');
    const system = await readTextFile('prompts/image_prompt_system.txt');
    let prompts;
    if (events.length === 0) {
      prompts = { week: target.week, created_at: new Date().toISOString(), items: [] };
      await logger.info('No waiting image events found; writing empty prompts array.');
    } else if (!process.env.OPENAI_API_KEY) {
      await logger.warn('OPENAI_API_KEY is missing; using deterministic local fallback image prompts for testing.');
      prompts = fallbackPrompts(target.week, events, visualStyle);
    } else {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.responses.create({
        model: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini',
        temperature: 0.2,
        input: [
          { role: 'system', content: `${system}\n\n${style}\n\n${visualStyle}` },
          { role: 'user', content: JSON.stringify({ week: target.week, events }, null, 2) }
        ]
      });
      rawResponseText = response.output_text ?? '';
      await logger.info(`Raw OpenAI prompt response preview: ${previewText(rawResponseText, 500)}`);
      prompts = validatePrompts(extractJson(rawResponseText), target.week, visualStyle);
    }
    prompts = validatePrompts(prompts, target.week, visualStyle);
    prompts.items = filterPromptItems(prompts.items, target);
    await logger.info(`Prompt count after validation and image-topic filtering: ${prompts.items.length}`);
    await logger.info(`Prompts created_at set by script: ${prompts.created_at}`);
    const out = `output/${target.week}/prompts.json`;
    await writeJsonFile(out, prompts);
    await logger.info(`Created image prompts: ${out}`);
    await logger.info('Generate image prompts finished successfully');
  } catch (error) {
    if (rawResponseText) await logger.error(`Raw OpenAI prompt response first 1000 chars: ${previewText(rawResponseText, 1000)}`);
    await logger.error(`Generate image prompts failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
