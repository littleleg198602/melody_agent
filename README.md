# Melody4U Weekly Image Agent

A simple v1 Node.js agent that creates a weekly overview of social and sport events, converts those events into Melody4U-style image prompts, and optionally generates images for social media.

The agent is local-to-repo: weekly JSON, prompt output, optional image manifests, optional PNG images, and logs are saved directly in this repository.

## Requirements

- Node.js 20+
- `OPENAI_API_KEY` as a local `.env` value or GitHub Actions secret

## Local setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `OPENAI_API_KEY`.

## Run locally

```bash
npm run weekly
npm run weekly -- --week 2026-W26
npm run weekly -- --from 2026-06-22 --to 2026-06-28
```

Individual steps are also available:

```bash
npm run overview
npm run prompts
npm run images
```

## GitHub Action

The workflow in `.github/workflows/weekly-agent.yml` runs manually with `workflow_dispatch` and automatically every Sunday morning. Add `OPENAI_API_KEY` in GitHub repository secrets, then run the workflow from the Actions tab.

## Image generation

Image generation is disabled by default to control costs. The default is:

```env
GENERATE_IMAGES=false
```

To generate paid images with the OpenAI Images API, set:

```env
GENERATE_IMAGES=true
```

Generated images must be reviewed before publishing. The v1 agent does not publish to TikTok, Instagram, Facebook, Google Sheets, Backblaze B2, Cloudflare R2, or any external storage.

## Output folders

- `data/weekly/YYYY-Www.json` contains weekly overview data.
- `output/YYYY-Www/prompts.json` contains generated image prompts.
- `output/YYYY-Www/images.json` contains image-generation status.
- `output/YYYY-Www/images/*.png` contains optional generated PNG files.

## Logs

The agent writes all important actions to:

logs/agent.log

The log file is append-only and is committed back to the repository together with generated outputs.

## Documentation and manifests

- See `PROJECT_STRUCTURE.md` for the full project tree.
- See `AGENT_MANIFEST.md` for the human-readable agent manifest.
- See `agent.manifest.json` for machine-readable metadata.

## Editorial and language policy

The v1.2 editorial rules prioritize Czech-audience relevance: combined Czech national team world-tournament themes first, then main significant days, Formula 1, other major sports, and secondary significant days. Serious significant days are allowed and should use respectful or awareness tone rather than being skipped.

Generated prompt items include `tone`, `event_origin`, `language_policy`, and `composition_type`. International significant days use bilingual Czech/English image text, Czech significant days use Czech text, and sport or motorsport content uses English text. Image generation remains disabled by default with `GENERATE_IMAGES=false`.
