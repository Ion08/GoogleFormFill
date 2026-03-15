const state = {
  authenticated: false,
  session: null,
  credits: 0,
  sdkReady: false,
  lastReport: null,
  progress: {
    active: false,
    percent: 0,
    text: "Waiting to start..."
  }
};

const ui = {
  authView: document.getElementById("authView"),
  appView: document.getElementById("appView"),
  email: document.getElementById("email"),
  credits: document.getElementById("credits"),
  status: document.getElementById("status"),
  progressPanel: document.getElementById("progressPanel"),
  progressPercent: document.getElementById("progressPercent"),
  progressText: document.getElementById("progressText"),
  progressBar: document.getElementById("progressBar"),
  reportPanel: document.getElementById("reportPanel"),
  reportSummary: document.getElementById("reportSummary"),
  reportList: document.getElementById("reportList"),
  loginBtn: document.getElementById("loginBtn"),
  solveBtn: document.getElementById("solveBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  logoutBtn: document.getElementById("logoutBtn")
};

function setStatus(message, tone = "info") {
  ui.status.textContent = message || "";
  ui.status.className = `status ${tone}`;
}

function render() {
  if (!state.authenticated) {
    ui.authView.classList.remove("hidden");
    ui.appView.classList.add("hidden");
    return;
  }

  ui.authView.classList.add("hidden");
  ui.appView.classList.remove("hidden");

  ui.email.textContent = state.session?.email || "Unknown";
  ui.credits.textContent = String(state.credits ?? 0);
  renderProgress();
  renderReport();
}

function updateProgress(percent, text, active = true) {
  const numeric = Number.isFinite(Number(percent)) ? Number(percent) : 0;
  state.progress.percent = Math.max(0, Math.min(100, Math.round(numeric)));
  state.progress.text = text || state.progress.text || "Processing...";
  state.progress.active = active;
  renderProgress();
}

function resetProgress() {
  state.progress = {
    active: false,
    percent: 0,
    text: "Waiting to start..."
  };
  renderProgress();
}

function renderProgress() {
  if (!state.progress.active) {
    ui.progressPanel.classList.add("hidden");
    ui.progressBar.style.width = "0%";
    ui.progressPercent.textContent = "0%";
    ui.progressText.textContent = "Waiting to start...";
    return;
  }

  ui.progressPanel.classList.remove("hidden");
  ui.progressBar.style.width = `${state.progress.percent}%`;
  ui.progressPercent.textContent = `${state.progress.percent}%`;
  ui.progressText.textContent = state.progress.text;
}

function formatConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "n/a";
  }

  return `${Math.round(value * 100)}%`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderReport() {
  const report = state.lastReport;

  if (!report?.results?.length) {
    ui.reportPanel.classList.add("hidden");
    ui.reportSummary.textContent = "No solve report yet.";
    ui.reportList.innerHTML = "";
    return;
  }

  ui.reportPanel.classList.remove("hidden");
  ui.reportSummary.textContent = `${report.summary.answered} answered, ${report.summary.skipped} skipped, ${report.summary.filled} filled into the form.`;

  ui.reportList.innerHTML = report.results.map((item, index) => {
    const answerText = Array.isArray(item.answer) ? item.answer.join(", ") : item.answer;
    const answerMarkup = item.status === "answered"
      ? `<p><strong>Answer:</strong> ${escapeHtml(answerText || "-")}</p>`
      : "";
    const reason = item.status === "skipped" ? item.reasonLabel || item.skipReason || "Skipped" : "Completed";
    const confidence = item.status === "answered" ? `<p><strong>Confidence:</strong> ${escapeHtml(formatConfidence(item.confidence))}</p>` : "";

    return `
      <article class="report-item ${item.status === "answered" ? "report-item-success" : "report-item-skipped"}">
        <div class="report-item-head">
          <span class="report-index">Q${index + 1}</span>
          <span class="report-badge ${item.status === "answered" ? "report-badge-success" : "report-badge-skipped"}">${escapeHtml(item.status === "answered" ? "Answered" : "Skipped")}</span>
        </div>
        <h3>${escapeHtml(item.question || item.id)}</h3>
        <p><strong>Type:</strong> ${escapeHtml(item.type || "Unknown")}</p>
        <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
        ${answerMarkup}
        ${confidence}
        <p><strong>Why:</strong> ${escapeHtml(item.explanation || "No explanation provided.")}</p>
      </article>
    `;
  }).join("");
}

function sendMessage(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

async function bootstrapSdkSession(session) {
  try {
    const { af_config: config } = await chrome.storage.local.get("af_config");
    if (!window.Appwrite || !config?.appwriteEndpoint || !config?.appwriteProjectId || !session?.secret) {
      return;
    }

    const client = new window.Appwrite.Client()
      .setEndpoint(config.appwriteEndpoint)
      .setProject(config.appwriteProjectId)
      .setSession(session.secret);

    const account = new window.Appwrite.Account(client);
    await account.get();
    state.sdkReady = true;
  } catch (_err) {
    state.sdkReady = false;
  }
}

function mapErrorToMessage(code) {
  const normalized = String(code || "").toLowerCase();
  if (normalized.includes("not authorized") || normalized.includes("invalid origin")) {
    return "Appwrite rejected this request. Check Function execute permissions and users table read permissions for this user.";
  }

  if (normalized.includes("receiving end does not exist") || normalized.includes("could not establish connection")) {
    return "Form helper was not attached yet. Reload the Google Form tab and try Solve again.";
  }

  if (normalized === "function_execution_timeout" || normalized.includes("function execution timed out")) {
    return "The backend is still processing and exceeded the wait window. Try again in a moment or increase function timeout in Appwrite.";
  }

  if (normalized === "function_execution_force_sync_timeout") {
    return "Appwrite still handled this execution synchronously and hit the 30s limit. Reload the extension, then redeploy/check function execution settings in Appwrite.";
  }

  if (normalized.startsWith("function_execution_failed") || normalized.startsWith("function_execution_canceled")) {
    return "Function execution failed before returning a valid response. Check Appwrite execution logs for the latest run.";
  }

  if (normalized.startsWith("function_execution_http_")) {
    return "Function execution returned an HTTP error. Open Appwrite Function execution details/logs for the latest run to inspect the backend error payload.";
  }

  if (normalized.startsWith("function_execution_empty_response")) {
    return "Function finished but returned no parseable JSON response. Check the latest Appwrite execution logs and confirm the deployed function returns res.json(...) on all code paths.";
  }

  if (normalized === "form_parse_error:edit_mode_url") {
    return "You opened the form editor URL. Open the public form link ending in /viewform and try again.";
  }

  if (normalized === "form_parse_error:no_entry_fields_found") {
    return "No fillable form fields were detected. Open the actual question page (not confirmation/preview) and try again.";
  }

  if (normalized === "form_parse_error:no_supported_questions") {
    return "Questions were found but not in a supported format yet. Try reloading the form page and then Solve again.";
  }

  if (normalized === "ai_error:openrouter_api_key_missing") {
    return "OpenRouter key is missing in Appwrite Function environment variables.";
  }

  if (normalized.startsWith("ai_error:openrouter_http_401") || normalized.startsWith("ai_error:openrouter_http_403")) {
    return "OpenRouter rejected the request. Verify PLATFORM_OPENROUTER_KEY in Appwrite Function settings.";
  }

  if (
    normalized.startsWith("ai_error:openrouter_timeout_") ||
    normalized.startsWith("ai_error:openrouter_body_timeout_") ||
    normalized.startsWith("ai_error:openrouter_retryable_http_")
  ) {
    return "The form is taking longer to solve. Please wait and retry once; backend retries are enabled for long forms.";
  }

  if (normalized === "ai_error:openrouter_retries_exhausted") {
    return "The AI service is slow right now and retries were exhausted. Please try again in a moment.";
  }

  if (normalized === "ai_error:appwrite_permission_denied") {
    return "Appwrite denied backend access. Check APPWRITE_API_KEY scopes for TablesDB read/write and Users read.";
  }

  if (normalized === "ai_error:appwrite_resource_not_found") {
    return "Appwrite database/table IDs are incorrect. Verify APPWRITE_DATABASE_ID and table IDs in Function env vars.";
  }

  if (normalized === "ai_error:no_details_from_function") {
    return "Backend returned a generic AI error. Redeploy solveForm from latest code, then verify PLATFORM_OPENROUTER_KEY and APPWRITE_API_KEY scopes in Appwrite Function settings.";
  }

  const messages = {
    AUTH_REQUIRED: "Please sign in first.",
    AUTH_PAGE_LOAD_FAILED: "Google sign-in page could not load. Check Appwrite OAuth provider and redirect domain settings.",
    FORM_PARSE_ERROR: "Could not parse this Google Form.",
    NO_CREDITS: "No credits left. Please top up your account.",
    RATE_LIMITED: "Rate limit reached. Try again later.",
    AI_ERROR: "AI service is temporarily unavailable.",
    NOT_ON_GOOGLE_FORM: "Open a Google Form tab first.",
    SOLVE_IN_PROGRESS: "A solve request is already in progress."
  };

  return messages[code] || `Unexpected error: ${code}`;
}

async function loadSession() {
  setStatus("Loading session...");

  const response = await sendMessage("GET_SESSION");

  if (!response?.ok || !response.authenticated) {
    state.authenticated = false;
    state.session = null;
    state.credits = 0;
    setStatus("Not signed in.", "info");
    render();
    return;
  }

  state.authenticated = true;
  state.session = response.session;
  state.credits = Number(response.credits || 0);

  await bootstrapSdkSession(response.session);

  setStatus(state.sdkReady ? "Signed in and SDK session active." : "Signed in.", "success");
  render();
}

async function login() {
  setStatus("Opening Google sign-in...");
  ui.loginBtn.disabled = true;

  try {
    const response = await sendMessage("AUTH_LOGIN");
    if (!response?.ok) {
      throw new Error(response?.error || "AUTH_REQUIRED");
    }

    state.authenticated = true;
    state.session = response.session;
    state.credits = Number(response.credits || 0);

    await bootstrapSdkSession(response.session);

    setStatus("Login successful.", "success");
    render();
  } catch (err) {
    setStatus(mapErrorToMessage(err.message), "error");
  } finally {
    ui.loginBtn.disabled = false;
  }
}

async function logout() {
  await sendMessage("AUTH_LOGOUT");
  state.authenticated = false;
  state.session = null;
  state.credits = 0;
  state.sdkReady = false;
  state.lastReport = null;
  resetProgress();
  setStatus("Logged out.", "info");
  render();
}

async function refreshCredits() {
  setStatus("Refreshing credits...");

  const response = await sendMessage("REFRESH_CREDITS");
  if (!response?.ok) {
    setStatus(mapErrorToMessage(response?.error || "AI_ERROR"), "error");
    return;
  }

  state.credits = Number(response.credits || 0);
  render();
  setStatus("Credits updated.", "success");
}

async function solveForm() {
  ui.solveBtn.disabled = true;
  updateProgress(1, "Starting solve flow...");
  setStatus("Extracting and solving form...");

  try {
    const response = await sendMessage("SOLVE_FORM");
    if (!response?.ok) {
      const detailCode = response?.details?.code;
      throw new Error(detailCode ? `${response?.error || "AI_ERROR"}:${detailCode}` : (response?.error || "AI_ERROR"));
    }

    if (typeof response.creditsLeft === "number") {
      state.credits = response.creditsLeft;
    }

    state.lastReport = response.report || null;

  const total = Number(response?.report?.summary?.total || 0);
  const filled = Number(response?.report?.summary?.filled || 0);
  const processedPercent = total > 0 ? Math.round((filled / total) * 100) : 100;
  updateProgress(100, `Done. Filled ${filled}/${total || 0} questions (${processedPercent}%).`, true);

    render();
    if (response.report?.summary) {
      setStatus(
        `Answered ${response.report.summary.answered}, skipped ${response.report.summary.skipped}, filled ${response.report.summary.filled}.`,
        "success"
      );
    } else {
      setStatus(`Solved and filled ${response.filled || 0} question(s).`, "success");
    }
  } catch (err) {
    resetProgress();
    setStatus(mapErrorToMessage(err.message), "error");
  } finally {
    ui.solveBtn.disabled = false;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action !== "SOLVE_PROGRESS_EVENT") {
    return;
  }

  const percent = Number(message.percent || 0);
  const text = String(message.text || "Processing...");
  const done = Boolean(message.done);
  updateProgress(percent, text, true);

  if (done) {
    state.progress.active = true;
    renderProgress();
  }
});

ui.loginBtn.addEventListener("click", login);
ui.logoutBtn.addEventListener("click", logout);
ui.refreshBtn.addEventListener("click", refreshCredits);
ui.solveBtn.addEventListener("click", solveForm);

loadSession().catch((err) => {
  setStatus(mapErrorToMessage(err.message || "AI_ERROR"), "error");
});
