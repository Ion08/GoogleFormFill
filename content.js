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

function findEntryId(block, type) {
  const queryByType = {
    SHORT_ANSWER: 'input[name^="entry."]',
    PARAGRAPH: 'textarea[name^="entry."]',
    MULTIPLE_CHOICE: 'input[type="radio"][name^="entry."]',
    CHECKBOX: 'input[type="checkbox"][name^="entry."]',
    DROPDOWN: 'select[name^="entry."], [name^="entry."]'
  };

  const input = block.querySelector(queryByType[type] || '[name^="entry."]');
  return input?.name || null;
}

function extractFormData() {
  if (!isGoogleFormPage()) {
    return { ok: false, error: "FORM_PARSE_ERROR" };
  }

  const title =
    cleanText(document.querySelector('[role="heading"]')?.textContent || "") ||
    cleanText(document.title.replace(" - Google Forms", ""));

  const blocks = Array.from(document.querySelectorAll('[role="listitem"], .Qr7Oae'));
  const questions = [];

  for (const block of blocks) {
    const type = detectQuestionType(block);
    if (!type) continue;

    const question = findQuestionTitle(block);
    const id = findEntryId(block, type);

    if (!id || !question) continue;

    const item = { id, type, question };

    if (["MULTIPLE_CHOICE", "CHECKBOX", "DROPDOWN"].includes(type)) {
      item.options = extractOptions(block);
    }

    questions.push(item);
  }

  if (!questions.length) {
    return { ok: false, error: "FORM_PARSE_ERROR" };
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
