

# Replace Image Search with Brave Search API + AI Validation

## Summary

Replace the current Firecrawl + LLM image discovery in Stage 4 with Brave Search Image API. Try up to 3 different query variations, validate each candidate image against the story using a cheap GPT model, and fall back to Gemini AI generation if nothing matches.

## New Flow

```text
Stage 4: Finding real image
  ├─ Step 1: Brave Image Search (up to 3 query attempts)
  │    Query 1: "{story.title} photo"
  │    Query 2: "{characters} {location} {event keywords}"
  │    Query 3: "{story.hook} real photo"
  │    For each query → get top 5 results → validate URLs → AI relevance check
  ├─ Step 2: AI Relevance Check (gpt-5-nano / TEXT_CHEAP)
  │    Send candidate image + story summary to cheap model
  │    Ask: "Does this image match this story?" → yes/no + confidence
  │    Accept if match, otherwise try next candidate/query
  └─ Fallback: Generate photorealistic image with Gemini (existing logic)
```

## Technical Changes

### 1. Add `BRAVE_SEARCH_API_KEY` secret
- Use the `add_secret` tool to request the Brave Search API key from the user
- Brave Image Search endpoint: `https://api.search.brave.com/res/v1/images/search`
- Auth header: `X-Subscription-Token: <key>`

### 2. Rewrite `stage4()` in `supabase/functions/story-pipeline/index.ts`

**Remove**: All Firecrawl scraping logic (Steps 1, 2, 2b) and the LLM URL-guessing fallback (Step 3).

**Add**:
- `braveImageSearch(query: string, count: number)` helper — calls `GET https://api.search.brave.com/res/v1/images/search?q=...&count=...` with the API key
- 3 query variations built from story data (title, characters, hook, locations)
- For each query, iterate through results, validate image URL via HEAD request
- For each valid image, call `callText()` with `MODELS.TEXT_CHEAP` (gemini-2.5-flash) passing the image URL and story summary, asking if the image is relevant
- If the AI says yes → download, store, return
- If all 3 queries exhausted → fall back to existing Gemini generation (keep current Step 4 logic)

### 3. AI Relevance Validation Prompt

Use `MODELS.TEXT_CHEAP` (gemini-2.5-flash) with a simple prompt:
```
You are an image-story relevance judge. Given a story and an image URL, 
determine if the image is relevant to the story.
Reply with JSON: {"relevant": true/false, "reason": "brief explanation"}
```

Pass the image URL as a vision/image content block so the model actually sees the image, not just the URL.

### 4. Deploy
- Deploy the updated `story-pipeline` edge function

## Files Modified
- `supabase/functions/story-pipeline/index.ts` — rewrite stage4() (~170 lines replaced)

