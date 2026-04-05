importScripts("appwrite-web-sdk.js");

const DEFAULT_CONFIG = {
  appwriteEndpoint: "https://fra.cloud.appwrite.io/v1",
  appwriteProjectId: "69b5015800281183d258",
  appwriteFunctionSolveId: "69b50ac000155a09f932",
  appwriteDatabaseId: "69b502620001c600ec4b",
  appwriteUsersTableId: "users"
};

const STORAGE_KEYS = {
  config: "af_config",
  session: "af_session",
  inFlightSolve: "af_in_flight_solve"
};

const SOLVE_LOCK_TTL_MS = 15 * 60 * 1000;

function isPlaceholder(value) {
  return typeof value === "string" && value.startsWith("YOUR_");
}

async function getConfig() {
  const { [STORAGE_KEYS.config]: saved } = await chrome.storage.local.get(STORAGE_KEYS.config);
  const merged = { ...DEFAULT_CONFIG, ...(saved || {}) };

  // Keep old storage from pinning placeholders forever.
  if (isPlaceholder(merged.appwriteFunctionSolveId)) {
    merged.appwriteFunctionSolveId = DEFAULT_CONFIG.appwriteFunctionSolveId;
  }

  if (isPlaceholder(merged.appwriteDatabaseId)) {
    merged.appwriteDatabaseId = DEFAULT_CONFIG.appwriteDatabaseId;
  }

  if (!merged.appwriteUsersTableId && merged.appwriteUsersCollectionId) {
    merged.appwriteUsersTableId = merged.appwriteUsersCollectionId;
  }

  return merged;
}

async function setSession(session) {
  await chrome.storage.local.set({ [STORAGE_KEYS.session]: session });
}

async function getSession() {
  const { [STORAGE_KEYS.session]: session } = await chrome.storage.local.get(STORAGE_KEYS.session);
  return session || null;
}

async function clearSession() {
  await chrome.storage.local.remove(STORAGE_KEYS.session);
}

function buildOAuthUrlWithSdk(config, successRedirect, failureRedirect, options = {}) {
  const params = new URLSearchParams({
    project: config.appwriteProjectId,
    success: successRedirect,
    failure: failureRedirect
  });

  if (options.prompt) {
    params.set("prompt", options.prompt);
  }

  return `${config.appwriteEndpoint}/account/tokens/oauth2/google?${params.toString()}`;
}

function getOAuthCallbackParam(parsedUrl, key) {
  const searchValue = parsedUrl.searchParams.get(key);
  if (searchValue) {
    return searchValue;
  }

  const rawHash = (parsedUrl.hash || "").replace(/^#/, "");
  if (!rawHash) {
    return null;
  }

  const hashParams = new URLSearchParams(rawHash);
  return hashParams.get(key);
}

async function exchangeOAuthToken(config, userId, secret) {
  const response = await fetch(`${config.appwriteEndpoint}/account/sessions/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Appwrite-Project": config.appwriteProjectId
    },
    body: JSON.stringify({ userId, secret })
  });

  if (!response.ok) {
    let details = "";
    try {
      const body = await response.json();
      details = body?.message || body?.type || "";
    } catch {
      // ignore
    }

    throw new Error(`Session token exchange failed: ${response.status}${details ? `:${details}` : ""}`);
  }

  return response.json();
}

async function getAccount(config, sessionSecret) {
  const response = await fetch(`${config.appwriteEndpoint}/account`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Appwrite-Project": config.appwriteProjectId,
      "X-Appwrite-Session": sessionSecret
    }
  });

  if (!response.ok) {
    throw new Error(`Account fetch failed: ${response.status}`);
  }

  return response.json();
}

async function createJwt(config, sessionSecret) {
  const response = await fetch(`${config.appwriteEndpoint}/account/jwts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Appwrite-Project": config.appwriteProjectId,
      "X-Appwrite-Session": sessionSecret
    }
  });

  if (!response.ok) {
    throw new Error(`JWT creation failed: ${response.status}`);
  }

  const payload = await response.json();
  return payload.jwt;
}

async function getUserCredits(config, session) {
  const client = new self.Appwrite.Client()
    .setEndpoint(config.appwriteEndpoint)
    .setProject(config.appwriteProjectId)
    .setSession(session.secret);

  const usersCollectionId = config.appwriteUsersTableId || config.appwriteUsersCollectionId || "users";

  // Primary path matches the backend implementation, which uses Databases collections.
  try {
    const databases = new self.Appwrite.Databases(client);
    const documentsResult = await databases.listDocuments(config.appwriteDatabaseId, usersCollectionId, [
      self.Appwrite.Query.equal("userId", session.userId),
      self.Appwrite.Query.limit(1)
    ]);

    const userDoc = documentsResult.documents?.[0];
    return { credits: Number(userDoc?.credits || 0) };
  } catch (firstErr) {
    // Backward compatibility: support older TablesDB deployments.
    try {
      const tablesDB = new self.Appwrite.TablesDB(client);
      const rowsResult = await tablesDB.listRows(config.appwriteDatabaseId, usersCollectionId, [
        self.Appwrite.Query.equal("userId", session.userId),
        self.Appwrite.Query.limit(1)
      ]);

      const userRow = rowsResult.rows?.[0];
      return { credits: Number(userRow?.credits || 0) };
    } catch {
      throw firstErr;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryParseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function looksLikeSolvePayload(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.ok === "boolean" &&
    (Array.isArray(value.results) || value.error)
  );
}

function decodeBase64IfPossible(value) {
  const text = String(value || "").trim();
  if (!text || text.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(text)) {
    return null;
  }

  try {
    return atob(text);
  } catch {
    return null;
  }
}

function coerceParsedPayload(value) {
  if (!value) return null;

  if (typeof value === "object") {
    if (looksLikeSolvePayload(value)) {
      return value;
    }

    const nestedCandidates = [
      value.body,
      value.responseBody,
      value.response,
      value.payload,
      value.data,
      value.output,
      value.stdout,
      value.result
    ];

    for (const candidate of nestedCandidates) {
      const parsedNested = coerceParsedPayload(candidate);
      if (parsedNested) return parsedNested;
    }

    return null;
  }

  const text = String(value).trim();
  if (!text) return null;

  const direct = tryParseJsonText(text);
  if (direct && typeof direct === "object") {
    return direct;
  }

  if (typeof direct === "string") {
    const secondPass = tryParseJsonText(direct);
    if (secondPass && typeof secondPass === "object") {
      return secondPass;
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = text.slice(firstBrace, lastBrace + 1);
    const extracted = tryParseJsonText(sliced);
    if (extracted && typeof extracted === "object") {
      return extracted;
    }
  }

  const decoded = decodeBase64IfPossible(text);
  if (decoded) {
    const fromDecoded = tryParseJsonText(decoded);
    if (fromDecoded && typeof fromDecoded === "object") {
      return fromDecoded;
    }
  }

  try {
    const uriDecoded = decodeURIComponent(text);
    if (uriDecoded !== text) {
      const fromUriDecoded = tryParseJsonText(uriDecoded);
      if (fromUriDecoded && typeof fromUriDecoded === "object") {
        return fromUriDecoded;
      }
    }
  } catch {
    // Not URL encoded; ignore.
  }

  return null;
}

function parseExecutionBody(execution) {
  const rawCandidates = [
    execution?.responseBody,
    execution?.response?.body,
    execution?.response,
    execution?.stdout,
    execution?.output,
    execution?.body,
    execution?.data,
    execution
  ];

  for (const raw of rawCandidates) {
    const parsed = coerceParsedPayload(raw);
    if (parsed) return parsed;
  }

  return null;
}

function extractSolvePayloadFromLogs(logValue) {
  const lines = String(logValue || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parsed = coerceParsedPayload(line);
    if (looksLikeSolvePayload(parsed)) {
      return parsed;
    }
  }

  return null;
}

function isTerminalExecutionStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return ["completed", "succeeded", "failed", "canceled", "cancelled", "done"].includes(normalized);
}

function isFailedExecutionStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return ["failed", "canceled", "cancelled"].includes(normalized);
}

function getExecutionStatusCode(execution) {
  const code = Number(execution?.responseStatusCode);
  return Number.isFinite(code) ? code : null;
}

function getExecutionErrorHint(execution) {
  const raw =
    execution?.errors ||
    execution?.stderr ||
    execution?.logs ||
    execution?.message ||
    "";
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : "";
}

async function tryGetTerminalExecutionBody(config, session, execution, pollIntervalMs) {
  let current = execution;
  // On Appwrite cloud the execution can be marked completed before responseBody
  // is fully propagated; poll a bit longer to avoid false empty-response errors.
  const bodySettleAttempts = 12;

  for (let i = 0; i < bodySettleAttempts; i++) {
    const parsed = parseExecutionBody(current);
    if (parsed && typeof parsed === "object") {
      return { parsed, execution: current };
    }

    const parsedFromLogs = extractSolvePayloadFromLogs(current?.logs);
    if (parsedFromLogs && typeof parsedFromLogs === "object") {
      return { parsed: parsedFromLogs, execution: current };
    }

    if (i < bodySettleAttempts - 1) {
      await sleep(Math.max(300, Math.min(1200, pollIntervalMs)));
      current = await fetchExecution(config, session, current?.$id || current?.id);
    }
  }

  return { parsed: null, execution: current };
}

async function fetchExecution(config, session, executionId) {
  const client = new self.Appwrite.Client()
    .setEndpoint(config.appwriteEndpoint)
    .setProject(config.appwriteProjectId)
    .setSession(session.secret);
  const functions = new self.Appwrite.Functions(client);

  return functions.getExecution({
    functionId: config.appwriteFunctionSolveId,
    executionId
  });
}

async function executeSolveFunction(config, session, payload) {
  const pollIntervalMs = Number(config.functionExecutionPollIntervalMs || 1500);
  const waitTimeoutMs = Number(config.functionExecutionWaitTimeoutMs || 12 * 60 * 1000);
  const startedAt = Date.now();

  const client = new self.Appwrite.Client()
    .setEndpoint(config.appwriteEndpoint)
    .setProject(config.appwriteProjectId)
    .setSession(session.secret);
  const functions = new self.Appwrite.Functions(client);

  // Try sync execution first because Appwrite async polling may omit responseBody
  // even when status is completed with HTTP 200.
  try {
    const syncExecution = await functions.createExecution({
      functionId: config.appwriteFunctionSolveId,
      body: JSON.stringify(payload),
      async: false,
      path: "/solve",
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    const syncParsed = parseExecutionBody(syncExecution);
    if (syncParsed && typeof syncParsed === "object") {
      return syncParsed;
    }
  } catch (err) {
    const message = String(err?.message || "").toLowerCase();
    const syncTimedOut =
      message.includes("synchronous function execution timed out") ||
      message.includes("function execution timed out") ||
      message.includes("timed out");

    if (!syncTimedOut) {
      throw err;
    }

    emitSolveProgress(40, "Sync execution timed out. Switching to async polling...");
  }

  let createdExecution;
  try {
    createdExecution = await functions.createExecution({
      functionId: config.appwriteFunctionSolveId,
      body: JSON.stringify(payload),
      async: true,
      path: "/solve",
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    const message = String(err?.message || "");
    if (message.toLowerCase().includes("synchronous function execution timed out")) {
      throw new Error("FUNCTION_EXECUTION_FORCE_SYNC_TIMEOUT");
    }
    throw err;
  }
  const executionId = createdExecution?.$id || createdExecution?.id;

  if (!executionId) {
    throw new Error("FUNCTION_EXECUTION_ID_MISSING");
  }

  emitSolveProgress(40, "Function started. Waiting for completion...");

  while (Date.now() - startedAt < waitTimeoutMs) {
    const execution = await fetchExecution(config, session, executionId);
    const status = execution?.status || "unknown";

    if (isTerminalExecutionStatus(status)) {
      const { parsed, execution: terminalExecution } = await tryGetTerminalExecutionBody(
        config,
        session,
        execution,
        pollIntervalMs
      );
      if (parsed && typeof parsed === "object") {
        return parsed;
      }

      if (isFailedExecutionStatus(status)) {
        throw new Error(`FUNCTION_EXECUTION_${String(status).toUpperCase()}`);
      }

      const responseStatusCode = getExecutionStatusCode(terminalExecution);
      if (responseStatusCode !== null && responseStatusCode >= 400) {
        const hint = getExecutionErrorHint(terminalExecution);
        throw new Error(
          `FUNCTION_EXECUTION_HTTP_${responseStatusCode}${hint ? `:${hint}` : ""}`
        );
      }

      const hint = getExecutionErrorHint(terminalExecution);
      throw new Error(
        `FUNCTION_EXECUTION_EMPTY_RESPONSE${hint ? `:${hint}` : ""}`
      );
    }

    const waitedRatio = Math.min(1, (Date.now() - startedAt) / waitTimeoutMs);
    const progress = 40 + Math.round(waitedRatio * 25);
    emitSolveProgress(progress, `Waiting for function... status: ${status}`);
    await sleep(pollIntervalMs);
  }

  throw new Error("FUNCTION_EXECUTION_TIMEOUT");
}

function emitSolveProgress(percent, text, extra = {}) {
  chrome.runtime.sendMessage({
    action: "SOLVE_PROGRESS_EVENT",
    percent,
    text,
    ...extra
  }).catch(() => {
    // Popup may be closed; ignore progress delivery errors.
  });
}

function humanizeReportReason(code) {
  const labels = {
    answered: "Answered",
    unsupported_question_type: "Unsupported question type",
    unclear_image: "Unclear image",
    low_ai_confidence: "Low AI confidence",
    insufficient_context: "Insufficient context",
    invalid_answer_shape: "Invalid answer shape",
    answer_not_returned: "No answer returned",
    field_not_found: "Form field not found",
    option_not_found: "Matching option not found",
    fill_failed: "Could not fill answer"
  };

  return labels[code] || code || "Unknown";
}

function mergeSolveAndFillResults(solveResults, fillResults) {
  const fillById = new Map((fillResults || []).map((item) => [String(item.id), item]));

  const results = (solveResults || []).map((item) => {
    const fill = fillById.get(String(item.id));

    if (!fill || item.status !== "answered") {
      return {
        ...item,
        fillStatus: item.status === "answered" ? "not_attempted" : "skipped"
      };
    }

    if (fill.status === "filled") {
      return {
        ...item,
        fillStatus: "filled"
      };
    }

    const reason = fill.reason || "fill_failed";
    return {
      ...item,
      status: "skipped",
      skipReason: reason,
      reasonLabel: humanizeReportReason(reason),
      explanation: item.explanation
        ? `${item.explanation} The extension could not place this answer into the form: ${humanizeReportReason(reason)}.`
        : `The extension could not place this answer into the form: ${humanizeReportReason(reason)}.`,
      fillStatus: "skipped"
    };
  });

  return {
    results,
    summary: {
      total: results.length,
      answered: results.filter((item) => item.status === "answered").length,
      skipped: results.filter((item) => item.status === "skipped").length,
      filled: results.filter((item) => item.fillStatus === "filled").length
    }
  };
}

async function getActiveFormTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];

  if (!tab?.id || !tab.url || !tab.url.includes("docs.google.com/forms")) {
    throw new Error("NOT_ON_GOOGLE_FORM");
  }

  return tab;
}

async function sendMessageToFormTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    const receiverMissing = msg.includes("receiving end does not exist") || msg.includes("could not establish connection");

    if (!receiverMissing) {
      throw err;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function withSolveLock(handler) {
  const state = await chrome.storage.local.get(STORAGE_KEYS.inFlightSolve);
  const rawLock = state[STORAGE_KEYS.inFlightSolve];
  const now = Date.now();
  const isBooleanLock = rawLock === true;
  const active = isBooleanLock || Boolean(rawLock?.active);
  const startedAt = Number(rawLock?.startedAt || 0);
  const hasTimestamp = Number.isFinite(startedAt) && startedAt > 0;
  const isStale = hasTimestamp ? (now - startedAt > SOLVE_LOCK_TTL_MS) : false;

  if (active && !isStale) {
    throw new Error("SOLVE_IN_PROGRESS");
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.inFlightSolve]: {
      active: true,
      startedAt: now
    }
  });

  try {
    return await handler();
  } finally {
    await chrome.storage.local.remove(STORAGE_KEYS.inFlightSolve);
  }
}

async function initUserAccount(config, session) {
  try {
    const jwt = await createJwt(config, session.secret);
    const client = new self.Appwrite.Client()
      .setEndpoint(config.appwriteEndpoint)
      .setProject(config.appwriteProjectId)
      .setSession(session.secret);
    const functions = new self.Appwrite.Functions(client);
    const execution = await functions.createExecution({
      functionId: config.appwriteFunctionSolveId,
      body: JSON.stringify({ userId: session.userId, jwt }),
      async: false,
      path: "/init",
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const parsed = parseExecutionBody(execution);
    if (typeof parsed?.credits === "number") {
      return { credits: parsed.credits };
    }
  } catch {
    // Non-critical: init failure does not block login.
  }
  return null;
}

async function loginWithGoogle(options = {}) {
  const config = await getConfig();
  const forceReauth = Boolean(options.forceReauth);

  // If we already have a valid session, reuse it instead of forcing OAuth.
  const existing = await getSession();
  if (!forceReauth && existing?.secret) {
    try {
      const user = await getAccount(config, existing.secret);
      const session = {
        userId: existing.userId || user.$id,
        secret: existing.secret,
        email: user.email || existing.email || "",
        name: user.name || existing.name || "",
        updatedAt: new Date().toISOString()
      };
      await setSession(session);
      const credits = await getUserCredits(config, session).catch(() => ({ credits: 0 }));
      return { session, credits: credits.credits };
    } catch {
      // Existing session is invalid/expired; continue with OAuth login flow.
    }
  }

  const redirectUrl = chrome.identity.getRedirectURL();
  const oauthUrl = buildOAuthUrlWithSdk(config, redirectUrl, redirectUrl, {
    prompt: forceReauth ? "select_account" : undefined
  });

  let callbackUrl;
  try {
    callbackUrl = await chrome.identity.launchWebAuthFlow({
      url: oauthUrl,
      interactive: true
    });
  } catch (_err) {
    throw new Error("AUTH_PAGE_LOAD_FAILED");
  }

  if (!callbackUrl) {
    throw new Error("AUTH_PAGE_LOAD_FAILED");
  }

  const parsed = new URL(callbackUrl);
  const userId = getOAuthCallbackParam(parsed, "userId");
  const secret = getOAuthCallbackParam(parsed, "secret");
  const error = getOAuthCallbackParam(parsed, "error");

  if (error) {
    // Appwrite may return user_already_exists for an already-linked identity.
    // In that case, keep the user logged in with the existing valid session.
    const normalizedError = String(error).toLowerCase();
    if (normalizedError.includes("user_already_exists")) {
      const fallback = await getSession();
      if (fallback?.secret) {
        try {
          const user = await getAccount(config, fallback.secret);
          const session = {
            userId: fallback.userId || user.$id,
            secret: fallback.secret,
            email: user.email || fallback.email || "",
            name: user.name || fallback.name || "",
            updatedAt: new Date().toISOString()
          };
          await setSession(session);
          const credits = await getUserCredits(config, session).catch(() => ({ credits: 0 }));
          return { session, credits: credits.credits };
        } catch {
          // Continue to throw the original OAuth error.
        }
      }
    }
    throw new Error(`AUTH_ERROR:${error}`);
  }

  if (!userId || !secret) {
    throw new Error("AUTH_ERROR:missing_user_or_secret");
  }

  let sessionSecret = secret;

  try {
    const exchanged = await exchangeOAuthToken(config, userId, secret);
    sessionSecret = exchanged?.secret || secret;
  } catch (err) {
    // Some Appwrite configurations deny /account/sessions/token for this flow.
    // Fall back to using the OAuth secret directly as session.
    if (!String(err.message || "").includes("403")) {
      throw err;
    }
  }

  const user = await getAccount(config, sessionSecret);

  const session = {
    userId,
    secret: sessionSecret,
    email: user.email || "",
    name: user.name || "",
    updatedAt: new Date().toISOString()
  };

  await setSession(session);

  // Ensure user row exists and fetch real starter credits.
  const initResult = await initUserAccount(config, session);
  const credits = initResult !== null
    ? initResult.credits
    : (await getUserCredits(config, session).catch(() => ({ credits: 0 }))).credits;
  return { session, credits };
}

async function refreshCredits() {
  const config = await getConfig();
  const session = await getSession();
  if (!session) {
    return { ok: false, error: "AUTH_REQUIRED" };
  }

  const credits = await getUserCredits(config, session);
  return { ok: true, credits: credits.credits, email: session.email };
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(STORAGE_KEYS.config);
  if (!existing[STORAGE_KEYS.config]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.config]: DEFAULT_CONFIG });
  }

  // Clear stale lock state left behind from previous worker lifecycles.
  await chrome.storage.local.remove(STORAGE_KEYS.inFlightSolve);
});

chrome.runtime.onStartup.addListener(async () => {
  // Service workers can be terminated during solve; remove old lock on startup.
  await chrome.storage.local.remove(STORAGE_KEYS.inFlightSolve);
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    const config = await getConfig();

    if (request?.action === "SOLVE_PROGRESS_UPDATE") {
      emitSolveProgress(request.percent, request.text, {
        phase: request.phase,
        processed: request.processed,
        total: request.total,
        done: request.done
      });
      sendResponse({ ok: true });
      return;
    }

    if (request?.action === "AUTH_LOGIN") {
      const result = await loginWithGoogle({ forceReauth: request?.forceReauth });
      sendResponse({ ok: true, ...result });
      return;
    }

    if (request?.action === "AUTH_LOGOUT") {
      await clearSession();
      sendResponse({ ok: true });
      return;
    }

    if (request?.action === "GET_SESSION") {
      const session = await getSession();
      if (!session) {
        sendResponse({ ok: true, authenticated: false });
        return;
      }

      // Validate the stored session is still live with Appwrite.
      try {
        await getAccount(config, session.secret);
      } catch {
        await clearSession();
        sendResponse({ ok: true, authenticated: false });
        return;
      }

      const credits = await getUserCredits(config, session).catch(() => ({ credits: 0 }));
      sendResponse({
        ok: true,
        authenticated: true,
        session,
        credits: credits.credits
      });
      return;
    }

    if (request?.action === "REFRESH_CREDITS") {
      const result = await refreshCredits();
      sendResponse(result);
      return;
    }

    if (request?.action === "SOLVE_FORM") {
      const result = await withSolveLock(async () => {
        emitSolveProgress(3, "Checking session...");
        const session = await getSession();
        if (!session) {
          return { ok: false, error: "AUTH_REQUIRED" };
        }

        emitSolveProgress(10, "Extracting form questions...");
        const tab = await getActiveFormTab();
        const extraction = await sendMessageToFormTab(tab.id, { action: "EXTRACT_FORM" });

        if (!extraction?.ok || !extraction.form?.questions?.length) {
          const detailCode = extraction?.details?.code;
          return {
            ok: false,
            error: detailCode ? `FORM_PARSE_ERROR:${detailCode}` : "FORM_PARSE_ERROR"
          };
        }

        const jwt = await createJwt(config, session.secret);
        emitSolveProgress(35, "Sending questions to AI...");
        const payload = {
          userId: session.userId,
          jwt,
          questions: extraction.form.questions,
          formTitle: extraction.form.title || "Untitled Form"
        };

        const solve = await executeSolveFunction(config, session, payload);

        if (!solve?.ok) {
          const fallbackDetails =
            solve?.error === "AI_ERROR" && !solve?.details
              ? { code: "NO_DETAILS_FROM_FUNCTION" }
              : null;

          return {
            ok: false,
            error: solve?.error || "AI_ERROR",
            details: solve?.details || fallbackDetails
          };
        }

        emitSolveProgress(70, "Applying answers to the form...");
        const fillResult = await sendMessageToFormTab(tab.id, {
          action: "FILL_FORM",
          results: solve.results || []
        });

        if (!fillResult?.ok) {
          return { ok: false, error: "FORM_PARSE_ERROR" };
        }

        const report = mergeSolveAndFillResults(solve.results || [], fillResult.results || []);
        emitSolveProgress(100, "Solve completed.", { done: true });

        return {
          ok: true,
          filled: report.summary.filled,
          creditsLeft: solve.creditsLeft,
          report
        };
      });

      sendResponse(result);
      return;
    }

    sendResponse({ ok: false, error: "UNKNOWN_ACTION" });
  })().catch((err) => {
    const normalized = typeof err?.message === "string" ? err.message : "UNEXPECTED_ERROR";
    sendResponse({ ok: false, error: normalized });
  });

  return true;
});
