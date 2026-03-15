function isGoogleFormPage() {
  return window.location.href.includes("docs.google.com/forms");
}

function cleanText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
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

function extractOptions(block) {
  const options = [];

  const labels = block.querySelectorAll('label, [role="option"], .nWQGrd');
  labels.forEach((label) => {
    const text = cleanText(label.textContent || "");
    if (text && !options.includes(text)) {
      options.push(text);
    }
  });

  return options;
}

function detectQuestionType(block) {
  if (block.querySelector('input[type="radio"]')) return "MULTIPLE_CHOICE";
  if (block.querySelector('input[type="checkbox"]')) return "CHECKBOX";
  if (block.querySelector("select") || block.querySelector('[role="listbox"]')) return "DROPDOWN";
  if (block.querySelector("textarea")) return "PARAGRAPH";
  if (block.querySelector('input[type="text"], input[type="email"], input:not([type])')) return "SHORT_ANSWER";
  return null;
}

function extractEntryIdFromText(text) {
  const match = String(text || "").match(/entry\.\d+/);
  return match ? match[0] : null;
}

function extractNumericQuestionIdFromDataParams(text) {
  const source = String(text || "");
  // Typical pattern in Google Forms question blocks: [[641627248,null,true,...]]
  const nested = source.match(/\[\[(\d+),\s*null,\s*true/);
  if (nested) {
    return nested[1];
  }

  // Fallback to first large integer in data-params payload.
  const generic = source.match(/\b(\d{6,})\b/);
  return generic ? generic[1] : null;
}

function findEntryId(block, type) {
  const queryByType = {
    SHORT_ANSWER: 'input[name^="entry."]',
    PARAGRAPH: 'textarea[name^="entry."]',
    MULTIPLE_CHOICE: 'input[type="radio"][name^="entry."]',
    CHECKBOX: 'input[type="checkbox"][name^="entry."]',
    DROPDOWN: 'select[name^="entry."], [name^="entry."]'
  };

  const input = block.querySelector(queryByType[type] || '[name^="entry."]');
  if (input?.name) {
    return input.name;
  }

  // Newer Forms layouts often store ids in attributes such as data-params.
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

  return extractEntryIdFromText(block.outerHTML) || extractNumericQuestionIdFromDataParams(block.outerHTML);
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

  const wrapperText = cleanText(input.parentElement?.textContent || "");
  return wrapperText;
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
      question: getQuestionTextForElement(el, id)
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
    const options = [];
    group.forEach((radio) => {
      const text = optionTextForInput(radio);
      if (text && !options.includes(text)) options.push(text);
    });

    byId.set(id, {
      id,
      type: "MULTIPLE_CHOICE",
      question: getQuestionTextForElement(group[0], id),
      options
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
    const options = [];
    group.forEach((box) => {
      const text = optionTextForInput(box);
      if (text && !options.includes(text)) options.push(text);
    });

    byId.set(id, {
      id,
      type: "CHECKBOX",
      question: getQuestionTextForElement(group[0], id),
      options
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
      options
    });
  });

  return Array.from(byId.values());
}

function extractQuestionsFromDataParamsFallback() {
  const questions = [];
  const seen = new Set();

  Array.from(document.querySelectorAll("script")).forEach((script) => {
    const match = (script.textContent || "").match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(.*?);/s);
    if (match && match[1]) {
      try {
        const data = JSON.parse(match[1]);
        if (data && data[1] && data[1][1]) {
          data[1][1].forEach((item) => {
            if (item && item[4] && item[4][0] && item[4][0][0]) {
              const id = String(item[4][0][0]);
              if (!seen.has(id)) {
                seen.add(id);
                questions.push({
                  id,
                  type: "TEXT",
                  question: item[1] || `Question ${id}`
                });
              }
            }
          });
        }
      } catch (e) {}
    }
  });

  return questions;
}

function extractFormData() {
  if (!isGoogleFormPage()) {
    return { ok: false, error: "FORM_PARSE_ERROR", details: { code: "NOT_GOOGLE_FORM" } };
  }

  // Builder/edit links are not fillable by the extension parser.
  if (window.location.href.includes("/edit")) {
    return { ok: false, error: "FORM_PARSE_ERROR", details: { code: "EDIT_MODE_URL" } };
  }

  const title =
    cleanText(document.querySelector('[role="heading"]')?.textContent || "") ||
    cleanText(document.title.replace(" - Google Forms", ""));

  const blocks = Array.from(
    document.querySelectorAll('[role="listitem"], .Qr7Oae, [data-params*="entry."], [jsdata*="entry."]')
  );
  const questions = [];
  const seen = new Set();

  for (const block of blocks) {
    const type = detectQuestionType(block);
    if (!type) continue;

    const question = findQuestionTitle(block);
    const id = findEntryId(block, type);

    if (!id || !question) continue;

    if (seen.has(id)) continue;
    seen.add(id);

    const item = { id, type, question };

    if (["MULTIPLE_CHOICE", "CHECKBOX", "DROPDOWN"].includes(type)) {
      item.options = extractOptions(block);
    }

    questions.push(item);
  }

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
  const label = input.closest('label') || document.querySelector(`label[for="${input.id}"]`);
  return cleanText(label?.textContent || "");
}

function fillShortAnswer(id, value) {
  const input = document.querySelector(`input[name="${CSS.escape(id)}"]`);
  if (!input) return false;
  input.focus();
  input.value = String(value ?? "");
  dispatchInputEvents(input);
  return true;
}

function findQuestionInputByNumericId(id) {
  const safeId = String(id || "").replace(/[^0-9]/g, "");
  if (!safeId) return null;

  const blocks = Array.from(document.querySelectorAll("[data-params]"));
  const block = blocks.find((el) => String(el.getAttribute("data-params") || "").includes(`[[${safeId},`));
  if (!block) return null;

  return block.querySelector("textarea, input[type=\"text\"], input[type=\"email\"], input:not([type])");
}

function fillTextByNumericId(id, value) {
  const el = findQuestionInputByNumericId(id);
  if (!el) return false;

  el.focus();
  el.value = String(value ?? "");
  dispatchInputEvents(el);
  return true;
}

function fillParagraph(id, value) {
  const textarea = document.querySelector(`textarea[name="${CSS.escape(id)}"]`);
  if (!textarea) return false;
  textarea.focus();
  textarea.value = String(value ?? "");
  dispatchInputEvents(textarea);
  return true;
}

function fillMultipleChoice(id, value) {
  const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(id)}"]`));
  if (!radios.length) return false;

  const target = radios.find((radio) => {
    const labelText = textOfLabelForInput(radio);
    return labelText.toLowerCase() === String(value || "").toLowerCase();
  });

  (target || radios[0]).click();
  return true;
}

function fillCheckbox(id, values) {
  const expected = new Set((Array.isArray(values) ? values : [values]).map((v) => String(v).toLowerCase()));
  const boxes = Array.from(document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(id)}"]`));
  if (!boxes.length) return false;

  let clicked = 0;
  boxes.forEach((box) => {
    const labelText = textOfLabelForInput(box).toLowerCase();
    const shouldSelect = expected.has(labelText);

    if (shouldSelect !== box.checked) {
      box.click();
      clicked += 1;
    }
  });

  return clicked > 0 || expected.size === 0;
}

function fillDropdown(id, value) {
  const select = document.querySelector(`select[name="${CSS.escape(id)}"]`);
  if (!select) {
    return false;
  }

  const normalized = String(value || "").toLowerCase();
  const option = Array.from(select.options).find((opt) => cleanText(opt.textContent).toLowerCase() === normalized);

  if (!option) return false;

  select.value = option.value;
  dispatchInputEvents(select);
  return true;
}

function fillAnswers(answersById) {
  if (!answersById || typeof answersById !== "object") {
    return { ok: false, error: "FORM_PARSE_ERROR" };
  }

  let filled = 0;

  Object.entries(answersById).forEach(([id, answer]) => {
    if (/^\d+$/.test(String(id)) && fillTextByNumericId(id, answer)) {
      filled += 1;
      return;
    }

    if (fillShortAnswer(id, answer)) {
      filled += 1;
      return;
    }

    if (fillParagraph(id, answer)) {
      filled += 1;
      return;
    }

    const isArrayAnswer = Array.isArray(answer);
    if (isArrayAnswer && fillCheckbox(id, answer)) {
      filled += 1;
      return;
    }

    if (fillMultipleChoice(id, answer)) {
      filled += 1;
      return;
    }

    if (fillDropdown(id, answer)) {
      filled += 1;
    }
  });

  return { ok: true, filled };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action === "EXTRACT_FORM") {
    sendResponse(extractFormData());
    return true;
  }

  if (request?.action === "FILL_FORM") {
    sendResponse(fillAnswers(request.answers));
    return true;
  }

  sendResponse({ ok: false, error: "UNKNOWN_ACTION" });
  return true;
});
