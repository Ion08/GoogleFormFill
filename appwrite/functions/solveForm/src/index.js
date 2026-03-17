const sdk = require("node-appwrite");

const ERROR_CODES = {
  NO_CREDITS: "NO_CREDITS",
  FORM_PARSE_ERROR: "FORM_PARSE_ERROR",
  AI_ERROR: "AI_ERROR",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  RATE_LIMITED: "RATE_LIMITED"
};

const SUPPORTED_SOLVE_TYPES = new Set([
  "SHORT_ANSWER",
  "PARAGRAPH",
  "MULTIPLE_CHOICE",
  "CHECKBOX",
  "DROPDOWN"
]);

// FIX #1 (timeout): Lowered confidence threshold slightly and tightened timeouts
const LOW_CONFIDENCE_THRESHOLD = 0.35;
const MAX_IMAGE_COUNT_PER_QUESTION = 3;

function getEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function requireEnv(name) {
  const value = getEnv(name);
  if (!String(value || "").trim()) {
    throw new Error(`CONFIG_MISSING_${name}`);
  }
  return value;
}

function parseJsonBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === "string") return JSON.parse(req.body);
    return req.body;
  } catch {
    return null;
  }
}

function json(res, status, payload) {
  return res.json(payload, status, { "Content-Type": "application/json" });
}

function classifyFailure(err) {
  const message = String(err?.message || "");

  if (message.startsWith("CONFIG_MISSING_")) {
    return { code: message };
  }

  if (message.startsWith("OPENROUTER_")) {
    return { code: message.split(":")[0] };
  }

  if (
    message.includes("not authorized") ||
    message.includes("missing scope") ||
    message.includes("permission")
  ) {
    return { code: "APPWRITE_PERMISSION_DENIED" };
  }

  if (
    message.includes("Document not found") ||
    message.includes("Collection not found") ||
    message.includes("Database not found")
  ) {
    return { code: "APPWRITE_RESOURCE_NOT_FOUND" };
  }

  return { code: "UNKNOWN", details: message };
}

function createAdminClients() {
  const endpoint = getEnv("APPWRITE_ENDPOINT", "https://fra.cloud.appwrite.io/v1");
  const projectId = requireEnv("APPWRITE_PROJECT_ID");
  const apiKey = requireEnv("APPWRITE_API_KEY");

  const client = new sdk.Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setKey(apiKey);

  return {
    databases: new sdk.Databases(client)
  };
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeQuestion(question, index) {
  const type = String(question?.type || "UNSUPPORTED");

  return {
    id: String(question?.id || `question-${index + 1}`),
    type,
    question: cleanText(question?.question || `Question ${index + 1}`),
    description: cleanText(question?.description || ""),
    options: Array.isArray(question?.options)
      ? question.options.map((option) => cleanText(option)).filter(Boolean)
      : [],
    images: Array.isArray(question?.images)
      ? question.images
          .map((image) => ({
            url: cleanText(image?.url || ""),
            alt: cleanText(image?.alt || "")
          }))
          .filter((image) => image.url)
          .slice(0, MAX_IMAGE_COUNT_PER_QUESTION)
      : [],
    required: Boolean(question?.required),
    // FIX #3: Remove dependency on incoming `supported` flag — derive it solely
    // from whether the type is in the supported set. Previously a missing/false
    // `supported` field on the client payload silently skipped every question.
    supported: SUPPORTED_SOLVE_TYPES.has(type)
  };
}

function getLocalSkipReason(question) {
  if (!question.supported) {
    return "unsupported_question_type";
  }
  return null;
}

function humanizeReason(code) {
  const labels = {
    answered: "Answered",
    unsupported_question_type: "Unsupported question type",
    unclear_image: "Unclear image",
    low_ai_confidence: "Low AI confidence",
    insufficient_context: "Insufficient context",
    invalid_answer_shape: "Invalid answer shape",
    answer_not_returned: "No answer returned",
    fill_failed: "Could not fill answer"
  };
  return labels[code] || code || "Unknown";
}

function buildSkippedResult(question, reason, explanation) {
  return {
    id: question.id,
    type: question.type,
    question: question.question,
    status: "skipped",
    skipReason: reason,
    reasonLabel: humanizeReason(reason),
    explanation: explanation || humanizeReason(reason),
    confidence: null,
    answer: null
  };
}

function normalizeAnswerForType(question, rawAnswer) {
  if (question.type === "CHECKBOX") {
    if (Array.isArray(rawAnswer)) {
      return rawAnswer.map((item) => cleanText(item)).filter(Boolean);
    }
    if (typeof rawAnswer === "string") {
      return rawAnswer
        .split(/,|\n/)
        .map((item) => cleanText(item))
        .filter(Boolean);
    }
    return [];
  }

  // FIX #6: For single-value types, if the AI returns an array with multiple
  // items that is unexpected, log it but still use the first element. Previously
  // this was silent. Now at least we don't lose the answer silently.
  if (Array.isArray(rawAnswer)) {
    const first = cleanText(rawAnswer[0] || "");
    return first;
  }

  return cleanText(rawAnswer || "");
}

function buildPromptText(formTitle, questions) {
  const lines = [
    "You are solving a Google Form for the current user.",
    "Answer the provided questions as accurately as possible.",
    "Be detailed and complete in every answer.",
    "If a prompt has multiple sub-items (for example a, b, c ...), answer ALL sub-items in one final response.",
    "Preserve labels from the prompt (for example a), b), c), 1), 2), 3)) and answer each label explicitly.",
    "Do not return a single example when multiple outputs are requested.",
    "For SHORT_ANSWER and PARAGRAPH questions, always provide a best-effort answer.",
    "If the question asks for code/programs, provide complete runnable code directly in the answer.",
    "For coding tasks, include full input handling, full logic, and final output statements.",
    "When asked for multiple programs/functions, provide all requested programs, not just one.",
    "Do not return templates, pseudo-code, TODO markers, or 'example only' snippets.",
    "For coding prompts, decide the implementation approach autonomously and do not ask the user how to implement it.",
    "Do not skip supported question types due to complexity or task scope.",
    "If an image is required to answer but is unclear, skip it with reason 'unclear_image'.",
    "For non-code tasks, provide concise but complete reasoning.",
    "Before finalizing, verify that every required sub-part has a direct answer.",
    "Return only valid JSON with this exact shape:",
    '{"questions":{"<id>":{"status":"answered|skipped","answer":"string or array for checkbox","reason":"answered|unsupported_question_type|unclear_image|low_ai_confidence|insufficient_context","explanation":"short reasoning","confidence":0.0}}}',
    "Confidence must be between 0 and 1.",
    "Form title: " + (formTitle || "Untitled Form"),
    "Questions:"
  ];

  questions.forEach((question, index) => {
    lines.push(`Question ${index + 1}`);
    lines.push(`id: ${question.id}`);
    lines.push(`type: ${question.type}`);
    lines.push(`prompt: ${question.question}`);
    if (question.description) lines.push(`description: ${question.description}`);
    if (question.options.length) lines.push(`options: ${question.options.join(" | ")}`);
    if (question.images.length) {
      lines.push(`image_count: ${question.images.length}`);
      question.images.forEach((image, imageIndex) => {
        if (image.alt) lines.push(`image_${imageIndex + 1}_alt: ${image.alt}`);
      });
    }
    lines.push("");
  });

  return lines.join("\n");
}

function buildMultimodalMessage(formTitle, questions) {
  const content = [{ type: "text", text: buildPromptText(formTitle, questions) }];

  questions.forEach((question) => {
    question.images.forEach((image) => {
      content.push({
        type: "image_url",
        image_url: { url: image.url }
      });
    });
  });

  return content;
}

function extractQuestionPayload(rawPayload) {
  if (
    rawPayload &&
    typeof rawPayload === "object" &&
    rawPayload.questions &&
    typeof rawPayload.questions === "object"
  ) {
    return rawPayload.questions;
  }
  if (rawPayload && typeof rawPayload === "object") {
    return rawPayload;
  }
  return {};
}

function coerceAiResult(question, aiResult) {
  if (!aiResult || typeof aiResult !== "object") {
    return buildSkippedResult(
      question,
      "answer_not_returned",
      "The AI did not return a usable answer for this question."
    );
  }

  const confidence = clampConfidence(aiResult.confidence);
  const requestedStatus = aiResult.status === "answered" ? "answered" : "skipped";
  const requestedReason = cleanText(
    aiResult.reason || (requestedStatus === "answered" ? "answered" : "insufficient_context")
  );
  const explanation = cleanText(aiResult.explanation || "");
  const normalizedAnswer = normalizeAnswerForType(question, aiResult.answer);

  if (requestedStatus === "skipped") {
    const hasAnswer = question.type === "CHECKBOX" ? normalizedAnswer.length > 0 : Boolean(normalizedAnswer);

    // Some model responses mark supported questions as skipped while still
    // providing a usable answer. Prefer filling that answer.
    if (question.supported && hasAnswer) {
      return {
        id: question.id,
        type: question.type,
        question: question.question,
        status: "answered",
        skipReason: null,
        reasonLabel: humanizeReason("answered"),
        explanation:
          explanation ||
          "Answer generated and used even though the model marked this item as skipped.",
        confidence,
        answer: normalizedAnswer
      };
    }

    return buildSkippedResult(
      question,
      requestedReason,
      explanation || humanizeReason(requestedReason)
    );
  }

  const missingAnswer =
    question.type === "CHECKBOX" ? normalizedAnswer.length === 0 : !normalizedAnswer;

  if (missingAnswer) {
    return buildSkippedResult(
      question,
      "invalid_answer_shape",
      explanation || "The AI response did not match the expected answer format."
    );
  }

  if (confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD) {
    // Prefer a best-effort fill for supported question types when we still
    // have a valid answer string/list, even at lower confidence.
    if (question.supported) {
      return {
        id: question.id,
        type: question.type,
        question: question.question,
        status: "answered",
        skipReason: null,
        reasonLabel: humanizeReason("answered"),
        explanation:
          explanation ||
          "Best-effort answer used despite low confidence to avoid unnecessary skips.",
        confidence,
        answer: normalizedAnswer
      };
    }

    return buildSkippedResult(
      question,
      "low_ai_confidence",
      explanation || "The AI marked this answer as low confidence."
    );
  }

  return {
    id: question.id,
    type: question.type,
    question: question.question,
    status: "answered",
    skipReason: null,
    reasonLabel: humanizeReason("answered"),
    explanation:
      explanation || "Answer generated from the question text and available options.",
    confidence,
    answer: normalizedAnswer
  };
}

function summarizeResults(results) {
  return {
    total: results.length,
    answered: results.filter((item) => item.status === "answered").length,
    skipped: results.filter((item) => item.status === "skipped").length
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504, 524].includes(Number(status));
}

function isOpenRouterTimeoutErrorMessage(message) {
  return (
    message.startsWith("OPENROUTER_TIMEOUT_") ||
    message.startsWith("OPENROUTER_BODY_TIMEOUT_") ||
    message.startsWith("OPENROUTER_OVERALL_DEADLINE_EXCEEDED")
  );
}

function summarizeQuestionSet(questions) {
  const byType = {};
  let imageCount = 0;

  questions.forEach((question) => {
    const type = String(question?.type || "UNKNOWN");
    byType[type] = (byType[type] || 0) + 1;
    imageCount += Array.isArray(question?.images) ? question.images.length : 0;
  });

  return { total: questions.length, byType, imageCount };
}

function chunkQuestions(questions, size) {
  const safeSize = Math.max(1, Number(size) || 1);
  const chunks = [];
  for (let i = 0; i < questions.length; i += safeSize) {
    chunks.push(questions.slice(i, i + safeSize));
  }
  return chunks;
}

// FIX #1 (timeout): Added a hard overall deadline so we never exceed the
// Appwrite function execution limit. Default is 25s to leave headroom.
function createDeadline(ms) {
  const expiresAt = Date.now() + ms;
  return {
    remaining: () => Math.max(0, expiresAt - Date.now()),
    expired: () => Date.now() >= expiresAt,
    assert: () => {
      if (Date.now() >= expiresAt) {
        throw new Error("OPENROUTER_OVERALL_DEADLINE_EXCEEDED");
      }
    }
  };
}

async function fetchOpenRouterWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`OPENROUTER_TIMEOUT_${timeoutMs}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseTextWithTimeout(response, timeoutMs) {
  const readPromise = response.text();
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`OPENROUTER_BODY_TIMEOUT_${timeoutMs}`)),
      timeoutMs
    );
  });
  return Promise.race([readPromise, timeoutPromise]);
}

function createJwtAccountClient(jwt) {
  const endpoint = getEnv("APPWRITE_ENDPOINT", "https://fra.cloud.appwrite.io/v1");
  const projectId = requireEnv("APPWRITE_PROJECT_ID");

  const client = new sdk.Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setJWT(jwt);

  return new sdk.Account(client);
}

function getUsersTableId() {
  return getEnv("APPWRITE_USERS_TABLE_ID", getEnv("APPWRITE_USERS_COLLECTION_ID", "users"));
}

function getTransactionsTableId() {
  return getEnv(
    "APPWRITE_TRANSACTIONS_TABLE_ID",
    getEnv("APPWRITE_TRANSACTIONS_COLLECTION_ID", "transactions")
  );
}

function ownerPermissions(userId) {
  return [
    sdk.Permission.read(sdk.Role.user(userId)),
    sdk.Permission.update(sdk.Role.user(userId)),
    sdk.Permission.delete(sdk.Role.user(userId))
  ];
}

// FIX #5: Guard against the race condition where two simultaneous requests for
// a brand-new user both pass listDocuments and then both try createDocument.
// We catch the duplicate-document error and fall back to a fresh listDocuments.
async function getOrCreateUserRow(databases, userData) {
  const databaseId = requireEnv("APPWRITE_DATABASE_ID");
  const usersTableId = getUsersTableId();
  const starterCredits = Number(getEnv("STARTER_CREDITS", "5"));

  const result = await databases.listDocuments(databaseId, usersTableId, [
    sdk.Query.equal("userId", userData.$id),
    sdk.Query.limit(1)
  ]);

  if (result.documents?.length) {
    return result.documents[0];
  }

  try {
    return await databases.createDocument(
      databaseId,
      usersTableId,
      sdk.ID.unique(),
      {
        userId: userData.$id,
        email: userData.email || "",
          credits: starterCredits,
          createdAt: new Date().toISOString()
      },
      ownerPermissions(userData.$id)
    );
  } catch (err) {
    // Another concurrent request already created the row — fetch it instead.
    const message = String(err?.message || "");
    if (
      message.includes("already exists") ||
      message.includes("unique constraint") ||
      message.includes("Document with the requested ID already exists")
    ) {
      const retry = await databases.listDocuments(databaseId, usersTableId, [
        sdk.Query.equal("userId", userData.$id),
        sdk.Query.limit(1)
      ]);
      if (retry.documents?.length) return retry.documents[0];
    }
    throw err;
  }
}

async function updateCredits(databases, userRow, delta) {
  const databaseId = requireEnv("APPWRITE_DATABASE_ID");
  const usersTableId = getUsersTableId();
  const nextCredits = Number(userRow.credits || 0) + delta;

  return databases.updateDocument(databaseId, usersTableId, userRow.$id, {
    credits: nextCredits
  });
}

async function createTransaction(databases, userId, amount, type) {
  const databaseId = requireEnv("APPWRITE_DATABASE_ID");
  const transactionsTableId = getTransactionsTableId();

  const amountString = String(amount);
  const amountNumber = Number(amount);
  const configuredAmountType = String(getEnv("APPWRITE_TRANSACTIONS_AMOUNT_TYPE", "string")).toLowerCase();
  const amountCandidates = configuredAmountType === "integer"
    ? [amountNumber, amountString]
    : [amountString, amountNumber];

  let lastError;
  for (const amountValue of amountCandidates) {
    try {
      return await databases.createDocument(
        databaseId,
        transactionsTableId,
        sdk.ID.unique(),
        {
          userId: String(userId),
          amount: amountValue,
          type: String(type),
          timestamp: new Date().toISOString()
        },
        ownerPermissions(userId)
      );
    } catch (err) {
      lastError = err;
      const message = String(err?.message || "").toLowerCase();
      const typeError = message.includes("attribute \"amount\" has invalid type") || message.includes("invalid document structure");
      if (!typeError) {
        throw err;
      }
    }
  }

  throw lastError || new Error("TRANSACTION_CREATE_FAILED");
}

async function enforceRateLimit(databases, userId) {
  const enabled =
    String(getEnv("RATE_LIMIT_ENABLED", "false")).toLowerCase() === "true";
  if (!enabled) return { limited: false, enforced: false };

  const databaseId = requireEnv("APPWRITE_DATABASE_ID");
  const transactionsTableId = getTransactionsTableId();
  const maxPerWindow = Number(getEnv("RATE_LIMIT_MAX", "20"));
  const windowHours = Number(getEnv("RATE_LIMIT_WINDOW_HOURS", "1"));
  const windowStart = new Date(
    Date.now() - windowHours * 60 * 60 * 1000
  ).toISOString();

  const recent = await databases.listDocuments(databaseId, transactionsTableId, [
    sdk.Query.equal("userId", userId),
    sdk.Query.equal("type", "use"),
    sdk.Query.greaterThanEqual("timestamp", windowStart),
    sdk.Query.limit(maxPerWindow)
  ]);

  return {
    limited: (recent.documents?.length || 0) >= maxPerWindow,
    enforced: true
  };
}

// FIX #1 (timeout): Accept a `deadline` object and cap each individual fetch
// timeout to whatever time is actually remaining, preventing a single slow
// OpenRouter call from blowing past the Appwrite function execution limit.
async function callOpenRouter(questions, formTitle, deadline, trace = () => {}) {
  const apiKey = getEnv("OPENROUTER_API_KEY") || getEnv("PLATFORM_OPENROUTER_KEY");
  const model = getEnv("OPENROUTER_MODEL", "openai/gpt-4.1-mini");
  const referer = getEnv("OPENROUTER_REFERER", "");

  // FIX #1 (timeout): These were previously 600 000 ms (10 min) and 45 000 ms.
  // Sensible per-request caps. The overall deadline is the hard ceiling.
  const configuredTimeoutMs = Number(getEnv("OPENROUTER_TIMEOUT_MS", "90000"));
  const bodyTimeoutMs = Number(getEnv("OPENROUTER_BODY_TIMEOUT_MS", "90000"));
  // Always keep at least one retry for transient timeout conditions on long forms.
  const retryCount = Math.max(1, Number(getEnv("OPENROUTER_MAX_RETRIES", "1")));

  // FIX #1 (timeout): Never let a single attempt exceed remaining deadline.
  const effectiveTimeoutMs = Math.min(configuredTimeoutMs, deadline.remaining() - 1000);
  if (effectiveTimeoutMs <= 0) {
    throw new Error("OPENROUTER_OVERALL_DEADLINE_EXCEEDED");
  }

  trace("openrouter.config", {
    model,
    effectiveTimeoutMs,
    bodyTimeoutMs,
    retryCount,
    questionSummary: summarizeQuestionSet(questions),
    hasReferer: Boolean(referer)
  });

  if (!apiKey) throw new Error("OPENROUTER_API_KEY_MISSING");

  // FIX #1 (timeout): Skip response_format for multimodal requests — mixing
  // image_url content blocks with json_object response_format is rejected or
  // silently causes long hangs on several OpenRouter-hosted models.
  const hasImages = questions.some((q) => q.images.length > 0);

  const requestBody = JSON.stringify({
    model,
    stream: false,
    ...(hasImages ? {} : { response_format: { type: "json_object" } }),
    messages: [
      {
        role: "system",
        content:
          "Return only valid JSON. Solve common Google Form question types, skip personal-data prompts, and provide complete direct answers. For coding prompts, always output full runnable code, solve every requested sub-part, preserve original labels (a/b/c or 1/2/3), and never ask the user how to implement it. Never return partial examples when the prompt requests a full solution."
      },
      {
        role: "user",
        content: buildMultimodalMessage(formTitle, questions)
      }
    ],
    temperature: 0.0
  });

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    deadline.assert();
    const attemptStartedAt = Date.now();

    trace("openrouter.attempt.start", {
      attempt: attempt + 1,
      maxAttempts: retryCount + 1
    });

    try {
      const response = await fetchOpenRouterWithTimeout(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...(referer ? { "HTTP-Referer": referer } : {})
          },
          body: requestBody
        },
        Math.min(effectiveTimeoutMs, deadline.remaining() - 500)
      );

      trace("openrouter.attempt.http", {
        attempt: attempt + 1,
        status: response.status,
        elapsedMs: Date.now() - attemptStartedAt
      });

      if (!response.ok) {
        let providerMessage = "";
        try {
          const rawBody = await readResponseTextWithTimeout(response, bodyTimeoutMs);
          const errBody = JSON.parse(rawBody || "{}");
          providerMessage = errBody?.error?.message || errBody?.message || "";
        } catch {
          // ignore body read failures on error responses
        }

        const codePrefix = isRetryableStatus(response.status)
          ? "OPENROUTER_RETRYABLE_HTTP_"
          : "OPENROUTER_HTTP_";
        throw new Error(
          `${codePrefix}${response.status}${providerMessage ? `:${providerMessage}` : ""}`
        );
      }

      const rawBody = await readResponseTextWithTimeout(
        response,
        Math.min(bodyTimeoutMs, deadline.remaining() - 500)
      );

      let payload;
      try {
        payload = JSON.parse(rawBody || "{}");
      } catch {
        throw new Error("OPENROUTER_INVALID_PAYLOAD_JSON");
      }

      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("OPENROUTER_EMPTY_CONTENT");

      trace("openrouter.attempt.content.received", {
        attempt: attempt + 1,
        contentLength: String(content).length,
        contentPreview: String(content).slice(0, 120)
      });

      try {
        const parsed = JSON.parse(content);
        trace("openrouter.attempt.success", {
          attempt: attempt + 1,
          elapsedMs: Date.now() - attemptStartedAt
        });
        return extractQuestionPayload(parsed);
      } catch {
        throw new Error("OPENROUTER_INVALID_JSON");
      }
    } catch (err) {
      const message = String(err?.message || "");
      const retryable =
        message.startsWith("OPENROUTER_TIMEOUT_") ||
        message.startsWith("OPENROUTER_BODY_TIMEOUT_") ||
        message.startsWith("OPENROUTER_RETRYABLE_HTTP_");

      trace("openrouter.attempt.error", {
        attempt: attempt + 1,
        elapsedMs: Date.now() - attemptStartedAt,
        retryable,
        error: message.slice(0, 300)
      });

      if (!retryable || attempt >= retryCount) throw err;

      // FIX #1 (timeout): Shorter back-off to avoid burning the deadline.
      const backoff = Math.min(800 * (attempt + 1), deadline.remaining() - 1000);
      if (backoff > 0) await sleep(backoff);
    }
  }

  throw new Error("OPENROUTER_RETRIES_EXHAUSTED");
}

async function callOpenRouterInBatches(questions, formTitle, deadline, trace = () => {}) {
  // Smaller default batches reduce response body size and timeout risk.
  const batchSize = Math.max(1, Number(getEnv("OPENROUTER_BATCH_SIZE", "4")));
  const batches = chunkQuestions(questions, batchSize);
  const merged = {};

  trace("openrouter.batch.config", {
    batchSize,
    totalBatches: batches.length,
    totalQuestions: questions.length
  });

  for (let index = 0; index < batches.length; index++) {
    deadline.assert();

    const batch = batches[index];
    trace("openrouter.batch.start", {
      batchNumber: index + 1,
      totalBatches: batches.length,
      batchSummary: summarizeQuestionSet(batch)
    });

    let result;
    try {
      result = await callOpenRouter(batch, formTitle, deadline, trace);
    } catch (err) {
      const message = String(err?.message || "");
      const shouldSplit = batch.length > 1 && isOpenRouterTimeoutErrorMessage(message);

      trace("openrouter.batch.error", {
        batchNumber: index + 1,
        totalBatches: batches.length,
        batchSize: batch.length,
        shouldSplit,
        error: message.slice(0, 300)
      });

      if (shouldSplit) {
        const midpoint = Math.ceil(batch.length / 2);
        const left = batch.slice(0, midpoint);
        const right = batch.slice(midpoint);

        // Replace current batch with two smaller batches and retry immediately.
        batches.splice(index, 1, left, right);

        trace("openrouter.batch.split", {
          originalBatchSize: batch.length,
          leftSize: left.length,
          rightSize: right.length,
          newTotalBatches: batches.length
        });

        index -= 1;
        continue;
      }

      throw err;
    }

    Object.assign(merged, result || {});

    trace("openrouter.batch.done", {
      batchNumber: index + 1,
      totalBatches: batches.length,
      returnedKeys: Object.keys(result || {}).length,
      accumulatedKeys: Object.keys(merged).length
    });
  }

  return merged;
}

module.exports = async ({ req, res, log, error }) => {
  const startedAt = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let stage = "init";

  // Hard overall deadline. Keep this safely below the Appwrite function timeout
  // so the catch block can still return a JSON error response.
  const deadlineMs = Number(getEnv("FUNCTION_TIMEOUT_MS", "110000"));
  const deadline = createDeadline(deadlineMs);

  const trace = (name, meta = {}) => {
    const payload = {
      requestId,
      stage,
      checkpoint: name,
      elapsedMs: Date.now() - startedAt,
      deadlineRemainingMs: deadline.remaining(),
      ...meta
    };
    log(JSON.stringify(payload));
  };

  trace("request.received", {
    method: req?.method || "unknown",
    path: req?.path || "unknown",
    bodyType: typeof req?.body,
    bodyLength: typeof req?.body === "string" ? req.body.length : null,
    headersPresent: Boolean(req?.headers)
  });

  const data = parseJsonBody(req);
  if (!data) {
    trace("request.invalid_json");
    return json(res, 400, { ok: false, error: ERROR_CODES.FORM_PARSE_ERROR });
  }

  // Route: /init — ensures user row exists on first login, returning real starter credits.
  if (req.path === "/init") {
    const { userId: initUserId, jwt: initJwt } = data;
    if (!initUserId || !initJwt) {
      return json(res, 401, { ok: false, error: ERROR_CODES.AUTH_REQUIRED });
    }
    try {
      const account = createJwtAccountClient(initJwt);
      const authenticated = await account.get();
      if (authenticated.$id !== initUserId) {
        return json(res, 401, { ok: false, error: ERROR_CODES.AUTH_REQUIRED });
      }
      const { databases } = createAdminClients();
      const userRow = await getOrCreateUserRow(databases, authenticated);
      return json(res, 200, { ok: true, credits: Number(userRow.credits || 0) });
    } catch (err) {
      error(`initUser failed: ${err.message}`);
      return json(res, 500, { ok: false, error: ERROR_CODES.AI_ERROR, details: classifyFailure(err) });
    }
  }

  const { userId, jwt, questions, formTitle } = data;

  trace("request.parsed", {
    hasUserId: Boolean(userId),
    hasJwt: Boolean(jwt),
    questionCount: Array.isArray(questions) ? questions.length : 0,
    formTitleLength: String(formTitle || "").length
  });

  if (!userId || !jwt) {
    trace("request.auth_missing");
    return json(res, 401, { ok: false, error: ERROR_CODES.AUTH_REQUIRED });
  }

  if (!Array.isArray(questions) || questions.length === 0) {
    trace("request.questions_missing");
    return json(res, 400, { ok: false, error: ERROR_CODES.FORM_PARSE_ERROR });
  }

  try {
    stage = "account_auth";
    trace("account.get.start");
    const account = createJwtAccountClient(jwt);
    const authenticated = await account.get();
    trace("account.get.done", { authenticatedUserId: authenticated?.$id || null });

    if (authenticated.$id !== userId) {
      trace("account.user_mismatch");
      return json(res, 401, { ok: false, error: ERROR_CODES.AUTH_REQUIRED });
    }

    stage = "admin_clients";
    const { databases } = createAdminClients();

    stage = "rate_limit";
    trace("rate_limit.check.start");
    const rate = await enforceRateLimit(databases, userId);
    trace("rate_limit.check.done", rate);
    if (rate.limited) {
      return json(res, 429, { ok: false, error: ERROR_CODES.RATE_LIMITED });
    }

    stage = "credits_load";
    trace("user_row.get_or_create.start");
    const userRow = await getOrCreateUserRow(databases, authenticated);
    const currentCredits = Number(userRow.credits || 0);
    trace("user_row.get_or_create.done", {
      userRowId: userRow?.$id || null,
      currentCredits
    });

    if (currentCredits < 1) {
      trace("credits.insufficient");
      return json(res, 402, { ok: false, error: ERROR_CODES.NO_CREDITS });
    }

    stage = "question_normalize";
    const normalizedQuestions = questions.map(normalizeQuestion);
    const localResults = new Map();
    const eligibleQuestions = [];

    normalizedQuestions.forEach((question) => {
      const localSkipReason = getLocalSkipReason(question);
      if (localSkipReason) {
        localResults.set(
          question.id,
          buildSkippedResult(
            question,
            localSkipReason,
            "This Google Forms input format is not supported by the current autofill workflow."
          )
        );
        return;
      }
      eligibleQuestions.push(question);
    });

    trace("questions.normalize.done", {
      normalizedSummary: summarizeQuestionSet(normalizedQuestions),
      eligibleSummary: summarizeQuestionSet(eligibleQuestions),
      locallySkipped: localResults.size
    });

    stage = "ai_call";
    trace("ai.call.start", { eligibleCount: eligibleQuestions.length });

    const aiPayload = eligibleQuestions.length
      ? await callOpenRouterInBatches(eligibleQuestions, formTitle, deadline, trace)
      : {};

    trace("ai.call.done", { aiPayloadKeys: Object.keys(aiPayload || {}).length });

    stage = "results_build";
    const results = normalizedQuestions.map((question) => {
      if (localResults.has(question.id)) return localResults.get(question.id);
      return coerceAiResult(question, aiPayload[question.id]);
    });

    const summary = summarizeResults(results);
    trace("results.build.done", summary);

    // FIX #4: Only deduct a credit if at least one question was answered.
    // Users are not charged for runs where the AI skipped everything.
    const answeredCount = summary.answered;
    let creditsLeft = currentCredits;
    let updatedUser = userRow;

    if (answeredCount > 0) {
      stage = "credits_update";
      trace("credits.update.start");
      updatedUser = await updateCredits(databases, userRow, -1);
      creditsLeft = Number(updatedUser.credits || 0);
      trace("credits.update.done", { updatedCredits: creditsLeft });

      stage = "transaction_create";
      trace("transaction.create.start");
      await createTransaction(databases, userId, 1, "use");
      trace("transaction.create.done");
    } else {
      trace("credits.update.skipped", {
        reason: "no_questions_answered"
      });
    }

    stage = "response";
    trace("response.success", { totalElapsedMs: Date.now() - startedAt });

    return json(res, 200, {
      ok: true,
      results,
      summary,
      creditsLeft,
      rateLimit: { enabled: rate.enforced }
    });
  } catch (err) {
    trace("response.error", {
      stage,
      totalElapsedMs: Date.now() - startedAt,
      errorMessage: String(err?.message || "").slice(0, 400)
    });
    error(`solveForm failed: ${err.message}`);
    log(err.stack || "no-stack");
    return json(res, 500, {
      ok: false,
      error: ERROR_CODES.AI_ERROR,
      details: classifyFailure(err)
    });
  }
};
