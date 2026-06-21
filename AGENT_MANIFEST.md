# Melody4U Weekly Image Agent Manifest

## Agent name
Melody4U Weekly Image Agent

## Version
v1

## Purpose
Automatically create a weekly overview of important social and sport events, convert them into Melody4U-style image prompts, and optionally generate images for social media.

## Main workflow
1. Calculate target week.
2. Create weekly overview JSON.
3. Save weekly overview into `data/weekly/`.
4. Generate Melody4U image prompts.
5. Save prompts into `output/YYYY-Www/prompts.json`.
6. Optionally generate images if `GENERATE_IMAGES=true`.
7. Save images into `output/YYYY-Www/images/`.
8. Log all actions into `logs/agent.log`.
9. Commit generated files back to GitHub.

## Inputs
- Date range or ISO week from CLI args.
- OpenAI API key from GitHub Secrets or `.env`.
- Prompt templates from `prompts/` folder.
- Web search results used by the OpenAI Responses API.

## Outputs
- `data/weekly/YYYY-Www.json`
- `output/YYYY-Www/prompts.json`
- `output/YYYY-Www/images.json`
- `output/YYYY-Www/images/*.png`
- `logs/agent.log`

## Secrets
- `OPENAI_API_KEY`

## Environment variables
- `GENERATE_IMAGES=false` by default
- `OPENAI_API_KEY`

## Safety/content rules
- Do not use official logos.
- Do not use copyrighted team badges.
- Do not use real athlete or celebrity likenesses.
- Do not use exact trademarked visual identities.
- Prefer symbolic cinematic scenes.
- Use English text on images.
- Generated images must be reviewed before publishing.

## Cost control
- Image generation is disabled by default.
- `GENERATE_IMAGES` must be explicitly set to `true`.
- Default GitHub Action must run in dry-run mode.

## Current limitations
- No Google Sheets integration.
- No automatic TikTok publishing.
- No automatic Instagram publishing.
- No Backblaze B2 or Cloudflare R2 upload.
- No approval UI yet.
- Images are generated only if explicitly enabled.

## Future roadmap
- Add admin approval workflow.
- Add Backblaze B2 / Cloudflare R2 upload.
- Add Melody4U admin page.
- Add automatic Reels/TikTok draft preparation.
- Add weekly reporting.
- Add better event source configuration.
- Add Czech-localized event filtering.

## v1.2 editorial policy

The agent is tuned for a Czech audience. Combined major world tournament themes with a Czech national team match rank highest, followed by main significant days, Formula 1, other major sports, and secondary significant days. Ice Hockey World Championship Czech matches are treated at the same top editorial level as Czech football matches at World Cup or Euro when they are actually relevant; hockey must not be invented for unrelated weeks.

Prompt outputs include `tone`, `event_origin`, `language_policy`, and `composition_type`. International significant days are bilingual Czech/English, Czech significant days are Czech-only, and sports/motorsport are English-only. Serious topics use respectful_memorial or awareness tone and avoid fearmongering, graphic imagery, and sensationalism.
