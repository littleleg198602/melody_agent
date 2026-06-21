# Project Structure

```text
melody4u-agent/
  package.json
  README.md
  PROJECT_STRUCTURE.md
  AGENT_MANIFEST.md
  agent.manifest.json
  .env.example
  .gitignore

  prompts/
    melody4u_style.txt
    weekly_overview_system.txt
    image_prompt_system.txt

  data/
    weekly/
      YYYY-Www.json

  output/
    YYYY-Www/
      prompts.json
      images.json
      images/

  logs/
    agent.log

  scripts/
    utils/
      dates.js
      fs.js
      slug.js
      logger.js
    create-weekly-overview.js
    generate-image-prompts.js
    generate-images.js
    run-weekly-agent.js

  .github/
    workflows/
      weekly-agent.yml
```

## Important folders and files

- `data/weekly/` stores generated weekly overview JSON files named by ISO week, for example `2026-W26.json`.
- `output/YYYY-Www/prompts.json` stores generated Melody4U image prompts for a specific week.
- `output/YYYY-Www/images/` stores optional generated PNG images when `GENERATE_IMAGES=true`.
- `output/YYYY-Www/images.json` records image generation status for each prompt.
- `logs/agent.log` is the append-only runtime log committed with generated outputs.
- `prompts/` contains reusable system prompts and the Melody4U visual style guide.
- `scripts/create-weekly-overview.js` creates weekly event overview JSON with the OpenAI Responses API and web search when an API key is available.
- `scripts/generate-image-prompts.js` converts waiting weekly events into image prompts.
- `scripts/generate-images.js` dry-runs by default and only calls the OpenAI Images API when `GENERATE_IMAGES=true`.
- `scripts/run-weekly-agent.js` runs all three main steps in order and stops on failure.
- `.github/workflows/weekly-agent.yml` runs the agent manually or every Sunday morning with Node.js 20 and commits generated changes back to the repository.
