function isGoogleFormPage() {
  return window.location.href.includes("docs.google.com/forms");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findQuestionTitle(block) {
  const selectors = [
    '[role="heading"]',
    '.M7eMe',
    '.HoXoMd',
    '.z12JJ',
    '.MztJPd'
  ];

  for (const selector of selectors) {
    const el = block.querySelector(selector);
    const text = cleanText(el?.textContent || "");
    if (text) return text;
  }

  return "";
}

function findQuestionDescription(block, title) {
  const selectors = [
    '.gubaDc',
    '.RgANM',
    '.freebirdFormviewerComponentsQuestionBaseDescription',
    '[role="note"]'
  ];

  for (const selector of selectors) {
    const nodes = Array.from(block.querySelectorAll(selector));
    for (const node of nodes) {
      const text = cleanText(node.textContent || "");
      if (text && text !== title) {
        return text;
      }
    }
  }

  return "";
}

function extractOptions(block) {
  const options = [];
  const candidates = block.querySelectorAll('label, [role="option"], .nWQGrd, [role="radio"], [role="checkbox"]');

  candidates.forEach((label) => {
    const text = cleanText(label.textContent || "");
    if (text && !options.includes(text)) {
      options.push(text);
    }
  });

  return options;
}

function extractQuestionImages(block) {
  const images = [];
  const seen = new Set();

  Array.from(block.querySelectorAll("img")).forEach((img) => {
    const url = img.currentSrc || img.src || "";
    const alt = cleanText(img.alt || "");
    const width = Number(img.naturalWidth || img.width || 0);
    const height = Number(img.naturalHeight || img.height || 0);

    if (!url || seen.has(url)) return;
    if (!width && !height && !alt) return;

    seen.add(url);
    images.push({ url, alt, width, height });
  });

  return images;
}

function hasGridLayout(block) {
  return Boolean(block.querySelector('table, [role="grid"], [role="group"] table'));
}

function detectQuestionType(block) {
  const text = cleanText(block.textContent || "");

  if (block.querySelector('input[type="file"]') || /upload files?/i.test(text)) return "FILE_UPLOAD";
  if (block.querySelector('input[type="date"]')) return "DATE";
  if (block.querySelector('input[type="time"]')) return "TIME";

  if (block.querySelector('input[type="radio"], [role="radio"]')) {
    return hasGridLayout(block) ? "MULTIPLE_CHOICE_GRID" : "MULTIPLE_CHOICE";
  }

  if (block.querySelector('input[type="checkbox"], [role="checkbox"]')) {
    return hasGridLayout(block) ? "CHECKBOX_GRID" : "CHECKBOX";
  }

  if (block.querySelector("select") || block.querySelector('[role="listbox"]')) return "DROPDOWN";
  if (block.querySelector("textarea")) return "PARAGRAPH";
  if (block.querySelector('input[type="text"], input[type="email"], input:not([type])')) return "SHORT_ANSWER";

  return "UNSUPPORTED";
}

function hasQuestionSignal(block) {
  return Boolean(
    block.querySelector('input, textarea, select, [role="radio"], [role="checkbox"], [role="listbox"], table') ||
    /upload files?/i.test(cleanText(block.textContent || ""))
  );
}

function extractEntryIdFromText(text) {
  const match = String(text || "").match(/entry\.\d+/);
  return match ? match[0] : null;
}

function extractNumericQuestionIdFromDataParams(text) {
  const source = String(text || "");
  const nested = source.match(/\[\[(\d+),\s*null,\s*true/);
  if (nested) {
    return nested[1];
  }

  const generic = source.match(/\b(\d{6,})\b/);
  return generic ? generic[1] : null;
}

function findEntryId(block, type, fallbackId) {
  const queryByType = {
    SHORT_ANSWER: 'input[name^="entry."]',
    PARAGRAPH: 'textarea[name^="entry."]',
    MULTIPLE_CHOICE: 'input[type="radio"][name^="entry."]',
    CHECKBOX: 'input[type="checkbox"][name^="entry."]',
    DROPDOWN: 'select[name^="entry."], [name^="entry."]',
    DATE: 'input[type="date"][name^="entry."]',
    TIME: 'input[type="time"][name^="entry."]'
  };

  const input = block.querySelector(queryByType[type] || '[name^="entry."]');
  if (input?.name) {
    return input.name;
  }

  const attrCandidates = [
    block.getAttribute("data-params"),
    block.getAttribute("jsdata"),
    block.getAttribute("data-item-id")
  ];

  for (const attr of attrCandidates) {
    const found = extractEntryIdFromText(attr);
    if (found) {
      return found;
    }

    const numeric = extractNumericQuestionIdFromDataParams(attr);
    if (numeric) {
      return numeric;
    }
  }

  const withDataParams = block.querySelector('[data-params*="entry."], [jsdata*="entry."]');
  if (withDataParams) {
    const found =
      extractEntryIdFromText(withDataParams.getAttribute("data-params")) ||
      extractEntryIdFromText(withDataParams.getAttribute("jsdata"));
    if (found) {
      return found;
    }
  }

  const anyDataParams = block.querySelector("[data-params]");
  if (anyDataParams) {
    const numeric = extractNumericQuestionIdFromDataParams(anyDataParams.getAttribute("data-params"));
    if (numeric) {
      return numeric;
    }
  }

  return extractEntryIdFromText(block.outerHTML) || extractNumericQuestionIdFromDataParams(block.outerHTML) || fallbackId;
}

function findQuestionContainer(element) {
  return (
    element.closest('[role="listitem"]') ||
    element.closest('.Qr7Oae') ||
    element.closest('[data-params]') ||
    element.parentElement
  );
}

function getQuestionTextForElement(element, id) {
  const container = findQuestionContainer(element);
  const fromContainer = container ? findQuestionTitle(container) : "";
  if (fromContainer) {
    return fromContainer;
  }

  const aria = cleanText(element.getAttribute("aria-label") || "");
  if (aria) {
    return aria;
  }

  const placeholder = cleanText(element.getAttribute("placeholder") || "");
  if (placeholder) {
    return placeholder;
  }

  return `Question ${id}`;
}

function optionTextForInput(input) {
  const label = input.closest("label");
  if (label) {
    return cleanText(label.textContent || "");
  }

  if (input.id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (forLabel) {
      return cleanText(forLabel.textContent || "");
    }
  }

  return cleanText(input.parentElement?.textContent || "");
}

function extractQuestionsFromEntriesFallback() {
  const byId = new Map();

  const textInputs = Array.from(
    document.querySelectorAll('input[name^="entry."]:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]), textarea[name^="entry."]')
  );

  textInputs.forEach((el) => {
    const id = el.name;
    const type = el.tagName.toLowerCase() === "textarea" ? "PARAGRAPH" : "SHORT_ANSWER";
    if (!id || byId.has(id)) return;

    byId.set(id, {
      id,
      type,
      question: getQuestionTextForElement(el, id),
      description: "",
      options: [],
      images: [],
      required: false,
      supported: true
    });
  });

  const radios = Array.from(document.querySelectorAll('input[type="radio"][name^="entry."]'));
  const radioGroups = new Map();
  radios.forEach((radio) => {
    if (!radioGroups.has(radio.name)) {
      radioGroups.set(radio.name, []);
    }
    radioGroups.get(radio.name).push(radio);
  });

  for (const [id, group] of radioGroups.entries()) {
    if (!id || byId.has(id)) continue;

    byId.set(id, {
      id,
      type: "MULTIPLE_CHOICE",
      question: getQuestionTextForElement(group[0], id),
      description: "",
      options: group.map(optionTextForInput).filter(Boolean),
      images: [],
      required: false,
      supported: true
    });
  }

  const checks = Array.from(document.querySelectorAll('input[type="checkbox"][name^="entry."]'));
  const checkGroups = new Map();
  checks.forEach((box) => {
    if (!checkGroups.has(box.name)) {
      checkGroups.set(box.name, []);
    }
    checkGroups.get(box.name).push(box);
  });

  for (const [id, group] of checkGroups.entries()) {
    if (!id || byId.has(id)) continue;

    byId.set(id, {
      id,
      type: "CHECKBOX",
      question: getQuestionTextForElement(group[0], id),
      description: "",
      options: group.map(optionTextForInput).filter(Boolean),
      images: [],
      required: false,
      supported: true
    });
  }

  const selects = Array.from(document.querySelectorAll('select[name^="entry."]'));
  selects.forEach((select) => {
    const id = select.name;
    if (!id || byId.has(id)) return;

    const options = Array.from(select.options)
      .map((opt) => cleanText(opt.textContent || ""))
      .filter((opt) => opt && !/choose|select/i.test(opt));

    byId.set(id, {
      id,
      type: "DROPDOWN",
      question: getQuestionTextForElement(select, id),
      description: "",
      options,
      images: [],
      required: false,
      supported: true
    });
  });

  return Array.from(byId.values());
}

function extractQuestionsFromDataParamsFallback() {
  const questions = [];
  const seen = new Set();

  Array.from(document.querySelectorAll("script")).forEach((script) => {
    const match = (script.textContent || "").match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(.*?);/s);
    if (!match?.[1]) {
      return;
    }

    try {
      const data = JSON.parse(match[1]);
      if (data && data[1] && data[1][1]) {
        data[1][1].forEach((item, index) => {
          if (item && item[4] && item[4][0] && item[4][0][0]) {
            const id = String(item[4][0][0]);
            if (!seen.has(id)) {
              seen.add(id);
              questions.push({
                id,
                type: "SHORT_ANSWER",
                question: item[1] || `Question ${index + 1}`,
                description: "",
                options: [],
                images: [],
                required: false,
                supported: true
              });
            }
          }
        });
      }
    } catch (_err) {
      // ignore malformed embedded payloads
    }
  });

  return questions;
}

function buildQuestionRecord(block, index) {
  const title = findQuestionTitle(block);
  if (!title) {
    return null;
  }

  const type = detectQuestionType(block);
  if (type === "UNSUPPORTED" && !hasQuestionSignal(block)) {
    return null;
  }

  const fallbackId = `question-${index + 1}`;
  const id = findEntryId(block, type, fallbackId);

  return {
    id,
    type,
    question: title,
    description: findQuestionDescription(block, title),
    options: ["MULTIPLE_CHOICE", "CHECKBOX", "DROPDOWN"].includes(type) ? extractOptions(block) : [],
    images: extractQuestionImages(block),
    required: block.textContent?.includes("*") || Boolean(block.querySelector('[aria-label*="Required"], [data-required="true"]')),
    supported: ["SHORT_ANSWER", "PARAGRAPH", "MULTIPLE_CHOICE", "CHECKBOX", "DROPDOWN"].includes(type)
  };
}

function extractFormData() {
  if (!isGoogleFormPage()) {
    return { ok: false, error: "FORM_PARSE_ERROR", details: { code: "NOT_GOOGLE_FORM" } };
  }

  if (window.location.href.includes("/edit")) {
    return { ok: false, error: "FORM_PARSE_ERROR", details: { code: "EDIT_MODE_URL" } };
  }

  const title =
    cleanText(document.querySelector('[role="heading"]')?.textContent || "") ||
    cleanText(document.title.replace(" - Google Forms", ""));

  const blocks = Array.from(document.querySelectorAll('[role="listitem"], .Qr7Oae'));
  const questions = [];
  const seen = new Set();

  blocks.forEach((block, index) => {
    const record = buildQuestionRecord(block, index);
    if (!record || seen.has(record.id)) {
      return;
    }

    seen.add(record.id);
    questions.push(record);
  });

  if (!questions.length) {
    let fallbackQuestions = extractQuestionsFromEntriesFallback();
    if (!fallbackQuestions.length) fallbackQuestions = extractQuestionsFromDataParamsFallback();

    if (!fallbackQuestions.length) {
      const entryLikeFields = document.querySelectorAll('[name^="entry."]').length;
      return {
        ok: false,
        error: "FORM_PARSE_ERROR",
        details: {
          code: entryLikeFields ? "NO_SUPPORTED_QUESTIONS" : "NO_ENTRY_FIELDS_FOUND",
          entryFieldCount: entryLikeFields,
          blockCount: blocks.length
        }
      };
    }

    return {
      ok: true,
      form: {
        title: title || "Untitled Form",
        questions: fallbackQuestions
      }
    };
  }

  return {
    ok: true,
    form: {
      title: title || "Untitled Form",
      questions
    }
  };
}

function dispatchInputEvents(element) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function textOfLabelForInput(input) {
  const label = input.closest("label") || document.querySelector(`label[for="${input.id}"]`);
  return cleanText(label?.textContent || "");
}

function textOfChoiceElement(element) {
  if (!element) return "";

  if (element.matches('input[type="radio"], input[type="checkbox"]')) {
    return textOfLabelForInput(element);
  }

  return cleanText(element.getAttribute("aria-label") || element.textContent || "");
}

function findQuestionBlockById(id) {
  const value = String(id || "");
  if (!value) return null;

  if (/^entry\.\d+$/.test(value)) {
    const field = document.querySelector(`[name="${CSS.escape(value)}"]`);
    if (field) {
      return findQuestionContainer(field);
    }
  }

  if (/^\d+$/.test(value)) {
    const blocks = Array.from(document.querySelectorAll("[data-params]"));
    const matched = blocks.find((el) => String(el.getAttribute("data-params") || "").includes(`[[${value},`));
    if (matched) {
      return findQuestionContainer(matched);
    }
  }

  return null;
}

function chooseBestOption(elements, expected) {
  const normalizedExpected = normalizeForMatch(expected);
  if (!normalizedExpected) {
    return null;
  }

  return elements.find((element) => normalizeForMatch(textOfChoiceElement(element)) === normalizedExpected) ||
    elements.find((element) => {
      const candidate = normalizeForMatch(textOfChoiceElement(element));
      return candidate && (candidate.includes(normalizedExpected) || normalizedExpected.includes(candidate));
    }) ||
    null;
}

function fillShortAnswer(id, value) {
  const input = document.querySelector(`input[name="${CSS.escape(id)}"]`);
  if (!input) return { filled: false, reason: "field_not_found" };
  input.focus();
  input.value = String(value ?? "");
  dispatchInputEvents(input);
  return { filled: true };
}

function findQuestionInputByNumericId(id) {
  const safeId = String(id || "").replace(/[^0-9]/g, "");
  if (!safeId) return null;

  const blocks = Array.from(document.querySelectorAll("[data-params]"));
  const block = blocks.find((el) => String(el.getAttribute("data-params") || "").includes(`[[${safeId},`));
  if (!block) return null;

  return block.querySelector('textarea, input[type="text"], input[type="email"], input:not([type])');
}

function fillTextByNumericId(id, value) {
  const el = findQuestionInputByNumericId(id);
  if (!el) return { filled: false, reason: "field_not_found" };

  el.focus();
  el.value = String(value ?? "");
  dispatchInputEvents(el);
  return { filled: true };
}

function fillParagraph(id, value) {
  const textarea = document.querySelector(`textarea[name="${CSS.escape(id)}"]`);
  if (!textarea) return { filled: false, reason: "field_not_found" };
  textarea.focus();
  textarea.value = String(value ?? "");
  dispatchInputEvents(textarea);
  return { filled: true };
}

function fillMultipleChoice(id, value) {
  const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(id)}"]`));
  if (radios.length) {
    const target = chooseBestOption(radios, value);
    if (!target) {
      return { filled: false, reason: "option_not_found" };
    }

    target.click();
    return { filled: true };
  }

  const block = findQuestionBlockById(id);
  const roleRadios = block ? Array.from(block.querySelectorAll('[role="radio"]')) : [];
  if (!roleRadios.length) {
    return { filled: false, reason: "field_not_found" };
  }

  const target = chooseBestOption(roleRadios, value);

  if (!target) {
    return { filled: false, reason: "option_not_found" };
  }

  target.click();
  return { filled: true };
}

function fillCheckbox(id, values) {
  const expected = new Set((Array.isArray(values) ? values : [values]).map((value) => normalizeForMatch(value)).filter(Boolean));
  const boxes = Array.from(document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(id)}"]`));
  if (boxes.length) {
    const available = new Set(boxes.map((box) => normalizeForMatch(textOfLabelForInput(box))).filter(Boolean));
    let toggled = 0;

    boxes.forEach((box) => {
      const labelText = normalizeForMatch(textOfLabelForInput(box));
      const shouldSelect = expected.has(labelText);

      if (shouldSelect !== box.checked) {
        box.click();
        toggled += 1;
      }
    });

    if (Array.from(expected).some((value) => !available.has(value))) {
      return { filled: false, reason: "option_not_found" };
    }

    return { filled: toggled > 0 || expected.size > 0, reason: expected.size ? undefined : "empty_selection" };
  }

  const block = findQuestionBlockById(id);
  const roleBoxes = block ? Array.from(block.querySelectorAll('[role="checkbox"]')) : [];
  if (!roleBoxes.length) {
    return { filled: false, reason: "field_not_found" };
  }

  const available = new Set(roleBoxes.map((box) => normalizeForMatch(textOfChoiceElement(box))).filter(Boolean));
  let toggled = 0;

  roleBoxes.forEach((box) => {
    const labelText = normalizeForMatch(textOfChoiceElement(box));
    const shouldSelect = expected.has(labelText);
    const isChecked = String(box.getAttribute("aria-checked") || "false") === "true";

    if (shouldSelect !== isChecked) {
      box.click();
      toggled += 1;
    }
  });

  if (Array.from(expected).some((value) => !available.has(value))) {
    return { filled: false, reason: "option_not_found" };
  }

  return { filled: toggled > 0 || expected.size > 0, reason: expected.size ? undefined : "empty_selection" };
}

function fillDropdown(id, value) {
  const select = document.querySelector(`select[name="${CSS.escape(id)}"]`);
  if (!select) {
    return { filled: false, reason: "field_not_found" };
  }

  const normalized = normalizeForMatch(value);
  const option = Array.from(select.options).find((opt) => normalizeForMatch(opt.textContent) === normalized);

  if (!option) return { filled: false, reason: "option_not_found" };

  select.value = option.value;
  dispatchInputEvents(select);
  return { filled: true };
}

function fillQuestionResult(result) {
  if (!result || result.status !== "answered") {
    return {
      id: result?.id || "unknown",
      status: "skipped",
      reason: result?.skipReason || result?.reason || "not_answered"
    };
  }

  let outcome = { filled: false, reason: "unsupported_question_type" };

  if (/^\d+$/.test(String(result.id || "")) && ["SHORT_ANSWER", "PARAGRAPH"].includes(result.type)) {
    outcome = fillTextByNumericId(result.id, result.answer);
  } else if (result.type === "SHORT_ANSWER") {
    outcome = fillShortAnswer(result.id, result.answer);
  } else if (result.type === "PARAGRAPH") {
    outcome = fillParagraph(result.id, result.answer);
  } else if (result.type === "MULTIPLE_CHOICE") {
    outcome = fillMultipleChoice(result.id, result.answer);
  } else if (result.type === "CHECKBOX") {
    outcome = fillCheckbox(result.id, result.answer);
  } else if (result.type === "DROPDOWN") {
    outcome = fillDropdown(result.id, result.answer);
  }

  return {
    id: result.id,
    status: outcome.filled ? "filled" : "skipped",
    reason: outcome.filled ? null : outcome.reason || "fill_failed"
  };
}

function fillAnswers(results) {
  if (!Array.isArray(results)) {
    return { ok: false, error: "FORM_PARSE_ERROR" };
  }

  const total = results.length;
  const fillResults = [];

  results.forEach((item, index) => {
    fillResults.push(fillQuestionResult(item));

    const processed = index + 1;
    const percent = total > 0 ? 70 + Math.round((processed / total) * 25) : 95;
    chrome.runtime.sendMessage({
      action: "SOLVE_PROGRESS_UPDATE",
      phase: "filling",
      processed,
      total,
      percent,
      text: `Filling form: ${processed}/${total}`
    }).catch(() => {
      // Popup may be closed.
    });
  });

  return {
    ok: true,
    filled: fillResults.filter((item) => item.status === "filled").length,
    results: fillResults
  };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action === "EXTRACT_FORM") {
    sendResponse(extractFormData());
    return true;
  }

  if (request?.action === "FILL_FORM") {
    sendResponse(fillAnswers(request.results));
    return true;
  }

  sendResponse({ ok: false, error: "UNKNOWN_ACTION" });
  return true;
});
