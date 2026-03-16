# Google Forms AI AutoFiller MVP

Production-oriented MVP Chrome extension (Manifest V3) with Appwrite auth + credits and OpenRouter AI solving.

## Features

- Google OAuth login via Appwrite
- Credits system stored in Appwrite
- Solve flow: parse Google Form -> backend solveForm -> auto-fill answers
- Supports common Google Form inputs: short answer, paragraph, multiple choice, checkboxes, and dropdowns
- Detects several unsupported formats such as file upload, date/time, and grid questions and reports them as skipped
- Includes question image URLs and alt text in the AI request so image-based prompts can be interpreted when the provider can access them
- Popup report shows which questions were answered, which were skipped, the reason for each skip, and a short explanation for every AI-generated answer
- Error handling: `NO_CREDITS`, `FORM_PARSE_ERROR`, `AI_ERROR`, `RATE_LIMITED`
- Rate limit logic implemented but disabled by default (`RATE_LIMIT_ENABLED=false`)

## Project Structure

- `manifest.json`
- `background.js`
- `content.js`
- `popup.html`
- `popup.js`
- `styles.css`
- `appwrite/functions/solveForm/src/index.js`
- `appwrite/schemas/users.json`
- `appwrite/schemas/transactions.json`

## Appwrite Setup

### If Project Already Exists

Use these project details:

- Project name: FillGoolgeForm
- Project ID: 69b5015800281183d258
- Endpoint: https://fra.cloud.appwrite.io/v1

1. In Appwrite Console, open project FillGoolgeForm.
2. Create one database and import/create collections from appwrite/schemas.
3. Deploy function from appwrite/functions/solveForm using Node.js 20 runtime.
4. Set function environment variables from .env.example.
5. Ensure extension defaults are already aligned in background.js with the endpoint and project ID above.

### If Project Does Not Exist

1. Create a new Appwrite project named FillGoolgeForm.
2. Confirm the project region endpoint is https://fra.cloud.appwrite.io/v1.
3. Copy the new Project ID and replace APPWRITE_PROJECT_ID in background.js and .env.example.
4. Create one database and create users + transactions collections using files in appwrite/schemas.
5. Deploy solveForm function and set all required environment variables.
6. Update APPWRITE_FUNCTION_SOLVE_ID and APPWRITE_DATABASE_ID in extension config.

### Required Permissions

1. Configure collection permissions so authenticated users can read their own users doc.
2. Configure function execution permissions for authenticated users.

## Extension Setup

1. Install dependencies (already done for local SDK bundle):
   - `npm install`
2. Load extension in Chrome:
   - Open `chrome://extensions`
   - Enable Developer mode
   - Load unpacked -> select this folder
3. Update runtime config (one-time) in `background.js`:
   - `appwriteProjectId`
   - `appwriteFunctionSolveId`
   - `appwriteDatabaseId`

## Solve Flow

1. User logs in with Google from popup.
2. On Solve Form click, the content script extracts structured questions, supported input types, options, and question images from the current Google Form.
3. Background calls Appwrite function `solveForm`.
4. Function validates auth, checks credits, applies optional rate limit, skips only unsupported input types, then calls OpenRouter for the remaining questions.
5. Extension fills only questions marked as answered and keeps the rest as skipped.
6. Popup renders a per-question report with status, skip reason, confidence, answer, and explanation.

## Notes

- OpenRouter key is backend-only (never in extension).
- OpenRouter request timeout defaults to 20000 ms and can be configured with `OPENROUTER_TIMEOUT_MS`.
- Temporary provider failures can be retried with `OPENROUTER_MAX_RETRIES` (default 1).
- Function-level deadline defaults to 25000 ms and can be configured with `FUNCTION_TIMEOUT_MS`.
- `RATE_LIMIT_ENABLED=false` keeps rate limiting code inactive until you turn it on.
- MVP includes manual/admin top-up by editing `users.credits` and writing `transactions` records with type `purchase`.
- Image-based solving depends on the model and whether the question image URL is reachable from the AI provider.

# GoogleFormFill
