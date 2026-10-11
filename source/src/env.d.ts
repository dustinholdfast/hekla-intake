/** Secrets and optional Access settings. Non-secret IDs live in wrangler.toml. */
interface Env {
  AIRTABLE_API_KEY?: string;
  AIRTABLE_PAT?: string;
  APP_PASSWORD?: string;
  SESSION_SECRET?: string;
  HEKLA_WEBHOOK_URL?: string;
  GEMINI_API_KEY?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}
