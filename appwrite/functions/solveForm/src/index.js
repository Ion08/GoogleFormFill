const sdk = require("node-appwrite");
// This is a sample function that demonstrates how to solve a Google Form using an AI model (like OpenAI's GPT) and manage user credits in Appwrite. It includes error handling and rate limiting.
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

const LOW_CONFIDENCE_THRESHOLD = 0.55;
const MAX_IMAGE_COUNT_PER_QUESTION = 3;

function getEnv(name, fallback = "") {
  return process.env[name] || fallback;
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

  if (message.startsWith("OPENROUTER_")) {
    return { code: message.split(":")[0] };
  }

  if (message.includes("not authorized") || message.includes("missing scope") || message.includes("permission")) {
    return { code: "APPWRITE_PERMISSION_DENIED" };
  }

  if (message.includes("Document not found") || message.includes("Collection not found") || message.includes("Database not found")) {
    return { code: "APPWRITE_RESOURCE_NOT_FOUND" };
  }

  return { code: "UNKNOWN", details: message };
}

function createAdminClients() {
  const endpoint = getEnv("APPWRITE_ENDPOINT", "https://fra.cloud.appwrite.io/v1");
  const projectId = getEnv("APPWRITE_PROJECT_ID");
  const apiKey = getEnv("APPWRITE_API_KEY");

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
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeQuestion(question, index) {
  return {
    id: String(question?.id || `question-${index + 1}`),
    type: String(question?.type || "UNSUPPORTED"),
    question: cleanText(question?.question || `Question ${index + 1}`),
    description: cleanText(question?.description || ""),
    options: Array.isArray(question?.options) ? question.options.map((option) => cleanText(option)).filter(Boolean) : [],
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
    supported: Boolean(question?.supported) && SUPPORTED_SOLVE_TYPES.has(String(question?.type || ""))
  };
}

function getLocalSkipReason(question) {
  if (!SUPPORTED_SOLVE_TYPES.has(question.type) || !question.supported) {
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

  if (Array.isArray(rawAnswer)) {
    return cleanText(rawAnswer[0] || "");
  }

  return cleanText(rawAnswer || "");
}

function buildPromptText(formTitle, questions) {
  const lines = [
    "You are solving a Google Form for the current user.",
    "Answer the provided questions as accurately as possible.",
    "If an image is required to answer but is unclear, skip it with reason 'unclear_image'.",
    "If you are uncertain, skip it with reason 'low_ai_confidence'.",
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
    if (question.description) {
      lines.push(`description: ${question.description}`);
    }
    if (question.options.length) {
      lines.push(`options: ${question.options.join(" | ")}`);
    }
    if (question.images.length) {
      lines.push(`image_count: ${question.images.length}`);
      question.images.forEach((image, imageIndex) => {
        if (image.alt) {
          lines.push(`image_${imageIndex + 1}_alt: ${image.alt}`);
        }
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
        image_url: {
          url: image.url
        }
      });
    });
  });

  return content;
}

function extractQuestionPayload(rawPayload) {
  if (rawPayload && typeof rawPayload === "object" && rawPayload.questions && typeof rawPayload.questions === "object") {
    return rawPayload.questions;
  }

  if (rawPayload && typeof rawPayload === "object") {
    return rawPayload;
  }

  return {};
}

function coerceAiResult(question, aiResult) {
  if (!aiResult || typeof aiResult !== "object") {
    return buildSkippedResult(question, "answer_not_returned", "The AI did not return a usable answer for this question.");
  }

  const confidence = clampConfidence(aiResult.confidence);
  const requestedStatus = aiResult.status === "answered" ? "answered" : "skipped";
  const requestedReason = cleanText(aiResult.reason || (requestedStatus === "answered" ? "answered" : "insufficient_context"));
  const explanation = cleanText(aiResult.explanation || "");

  if (requestedStatus === "skipped") {
    return buildSkippedResult(question, requestedReason, explanation || humanizeReason(requestedReason));
  }

  const normalizedAnswer = normalizeAnswerForType(question, aiResult.answer);
  const missingAnswer = question.type === "CHECKBOX" ? normalizedAnswer.length === 0 : !normalizedAnswer;

  if (missingAnswer) {
    return buildSkippedResult(question, "invalid_answer_shape", explanation || "The AI response did not match the expected answer format.");
  }

  if (confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD) {
    return buildSkippedResult(question, "low_ai_confidence", explanation || "The AI marked this answer as low confidence.");
  }

  return {
    id: question.id,
    type: question.type,
    question: question.question,
    status: "answered",
    skipReason: null,
    reasonLabel: humanizeReason("answered"),
    explanation: explanation || "Answer generated from the question text and available options.",
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

function summarizeQuestionSet(questions) {
  const byType = {};
  let imageCount = 0;

  questions.forEach((question) => {
    const type = String(question?.type || "UNKNOWN");
    byType[type] = (byType[type] || 0) + 1;
    imageCount += Array.isArray(question?.images) ? question.images.length : 0;
  });

  return {
    total: questions.length,
    byType,
    imageCount
  };
}

async function fetchOpenRouterWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
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
    setTimeout(() => reject(new Error(`OPENROUTER_BODY_TIMEOUT_${timeoutMs}`)), timeoutMs);
  });

  return Promise.race([readPromise, timeoutPromise]);
}

function createJwtAccountClient(jwt) {
  const endpoint = getEnv("APPWRITE_ENDPOINT", "https://fra.cloud.appwrite.io/v1");
  const projectId = getEnv("APPWRITE_PROJECT_ID");

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
  return getEnv("APPWRITE_TRANSACTIONS_TABLE_ID", getEnv("APPWRITE_TRANSACTIONS_COLLECTION_ID", "transactions"));
}

function ownerPermissions(userId) {
  return [
    sdk.Permission.read(sdk.Role.user(userId)),
    sdk.Permission.update(sdk.Role.user(userId)),
    sdk.Permission.delete(sdk.Role.user(userId))
  ];
}

async function getOrCreateUserRow(databases, userData) {
  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const usersTableId = getUsersTableId();
  const starterCredits = Number(getEnv("STARTER_CREDITS", "5"));

  const result = await databases.listDocuments(databaseId, usersTableId, [
    sdk.Query.equal("userId", userData.$id),
    sdk.Query.limit(1)
  ]);

  if (result.documents?.length) {
    return result.documents[0];
  }

  return databases.createDocument(
    databaseId,
    usersTableId,
    sdk.ID.unique(),
    {
      userId: userData.$id,
      email: userData.email || "",
      credits: starterCredits
    },
    ownerPermissions(userData.$id)
  );
}

async function updateCredits(databases, userRow, delta) {
  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const usersTableId = getUsersTableId();
  const nextCredits = Number(userRow.credits || 0) + delta;

  return databases.updateDocument(databaseId, usersTableId, userRow.$id, {
    credits: nextCredits
  });
}

async function createTransaction(databases, userId, amount, type) {
  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const transactionsTableId = getTransactionsTableId();

  return databases.createDocument(
    databaseId,
    transactionsTableId,
    sdk.ID.unique(),
    {
      userId: String(userId),
      amount: String(amount),
      type: String(type),
      timestamp: new Date().toISOString()
    },
    ownerPermissions(userId)
  );
}

async function enforceRateLimit(databases, userId) {
  const enabled = String(getEnv("RATE_LIMIT_ENABLED", "false")).toLowerCase() === "true";
  if (!enabled) {
    return { limited: false, enforced: false };
  }

  const databaseId = getEnv("APPWRITE_DATABASE_ID");
  const transactionsTableId = getTransactionsTableId();

  const maxPerWindow = Number(getEnv("RATE_LIMIT_MAX", "20"));
  const windowHours = Number(getEnv("RATE_LIMIT_WINDOW_HOURS", "1"));
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

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

async function callOpenRouter(questions, formTitle, trace = () => {}) {
  const apiKey = getEnv("OPENROUTER_API_KEY") || getEnv("PLATFORM_OPENROUTER_KEY");
  const model = getEnv("OPENROUTER_MODEL", "openai/gpt-4o-mini");
  const referer = getEnv("OPENROUTER_REFERER", "");
  const timeoutMs = Number(getEnv("OPENROUTER_TIMEOUT_MS", "600000"));
  const bodyTimeoutMs = Number(getEnv("OPENROUTER_BODY_TIMEOUT_MS", "45000"));
  const retryCount = Math.max(0, Number(getEnv("OPENROUTER_MAX_RETRIES", "2")));

  trace("openrouter.config", {
    model,
    timeoutMs,
    bodyTimeoutMs,
    retryCount,
    questionSummary: summarizeQuestionSet(questions),
    hasReferer: Boolean(referer)
  });

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY_MISSING");
  }

  const requestBody = JSON.stringify({
    model,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Return only valid JSON. Solve common Google Form question types, skip personal-data prompts, and provide short explanations."
      },
      {
        role: "user",
        content: buildMultimodalMessage(formTitle, questions)
      }
    ],
    temperature: 0.2
  });

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
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
        timeoutMs
      );

      trace("openrouter.attempt.http", {
        attempt: attempt + 1,
        status: response.status,
        elapsedMs: Date.now() - attemptStartedAt
      });

      if (!response.ok) {
        trace("openrouter.attempt.error_body.read.start", {
          attempt: attempt + 1
        });
        let providerMessage = "";
        try {
          const rawBody = await readResponseTextWithTimeout(response, bodyTimeoutMs);
          const errBody = JSON.parse(rawBody || "{}");
          providerMessage = errBody?.error?.message || errBody?.message || "";
          trace("openrouter.attempt.error_body.read.done", {
            attempt: attempt + 1,
            bodyLength: String(rawBody || "").length
          });
        } catch {
          trace("openrouter.attempt.error_body.read.failed", {
            attempt: attempt + 1
          });
        }

        const codePrefix = isRetryableStatus(response.status) ? "OPENROUTER_RETRYABLE_HTTP_" : "OPENROUTER_HTTP_";
        throw new Error(`${codePrefix}${response.status}${providerMessage ? `:${providerMessage}` : ""}`);
      }

      trace("openrouter.attempt.body.read.start", {
        attempt: attempt + 1
      });
      const rawBody = await readResponseTextWithTimeout(response, bodyTimeoutMs);
      trace("openrouter.attempt.body.read.done", {
        attempt: attempt + 1,
        elapsedMs: Date.now() - attemptStartedAt,
        bodyLength: String(rawBody || "").length
      });

      let payload;
      try {
        payload = JSON.parse(rawBody || "{}");
      } catch {
        throw new Error("OPENROUTER_INVALID_PAYLOAD_JSON");
      }

      const content = payload.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("OPENROUTER_EMPTY_CONTENT");
      }

      trace("openrouter.attempt.content.received", {
        attempt: attempt + 1,
        contentLength: String(content).length,
        contentPreview: String(content).slice(0, 120)
      });

      try {
        trace("openrouter.attempt.success", {
          attempt: attempt + 1,
          elapsedMs: Date.now() - attemptStartedAt,
          contentLength: String(content).length
        });
        return extractQuestionPayload(JSON.parse(content));
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

      if (!retryable || attempt >= retryCount) {
        throw err;
      }

      await sleep(1200 * (attempt + 1));
    }
  }

  throw new Error("OPENROUTER_RETRIES_EXHAUSTED");
}

module.exports = async ({ req, res, log, error }) => {
  const startedAt = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let stage = "init";

  const trace = (name, meta = {}) => {
    const payload = {
      requestId,
      stage,
      checkpoint: name,
      elapsedMs: Date.now() - startedAt,
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
    trace("account.get.done", {
      authenticatedUserId: authenticated?.$id || null
    });

    if (authenticated.$id !== userId) {
      trace("account.user_mismatch");
      return json(res, 401, { ok: false, error: ERROR_CODES.AUTH_REQUIRED });
    }

    stage = "admin_clients";
    trace("databases.client.create.start");
    const { databases } = createAdminClients();
    trace("databases.client.create.done");

    stage = "rate_limit";
    trace("rate_limit.check.start");
    const rate = await enforceRateLimit(databases, userId);
    trace("rate_limit.check.done", rate);
    if (rate.limited) {
      trace("rate_limit.blocked");
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
    trace("questions.normalize.start", {
      incomingQuestionCount: questions.length
    });
    const normalizedQuestions = questions.map(normalizeQuestion);
    const localResults = new Map();
    const eligibleQuestions = [];

    normalizedQuestions.forEach((question) => {
      const localSkipReason = getLocalSkipReason(question);
      if (localSkipReason) {
        const explanation = "This Google Forms input format is not supported by the current autofill workflow.";
        localResults.set(question.id, buildSkippedResult(question, localSkipReason, explanation));
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
    trace("ai.call.start", {
      eligibleCount: eligibleQuestions.length
    });
    const aiPayload = eligibleQuestions.length ? await callOpenRouter(eligibleQuestions, formTitle, trace) : {};
    trace("ai.call.done", {
      aiPayloadKeys: Object.keys(aiPayload || {}).length
    });

    stage = "results_build";
    trace("results.build.start");
    const results = normalizedQuestions.map((question) => {
      if (localResults.has(question.id)) {
        return localResults.get(question.id);
      }

      return coerceAiResult(question, aiPayload[question.id]);
    });
    trace("results.build.done", summarizeResults(results));

    stage = "credits_update";
    trace("credits.update.start");
    const updatedUser = await updateCredits(databases, userRow, -1);
    trace("credits.update.done", {
      updatedCredits: Number(updatedUser.credits || 0)
    });

    stage = "transaction_create";
    trace("transaction.create.start");
    await createTransaction(databases, userId, 1, "use");
    trace("transaction.create.done");

    stage = "response";
    trace("response.success", {
      totalElapsedMs: Date.now() - startedAt
    });

    return json(res, 200, {
      ok: true,
      results,
      summary: summarizeResults(results),
      creditsLeft: Number(updatedUser.credits || 0),
      rateLimit: {
        enabled: rate.enforced
      }
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