// Copy button for the calculator card. Slot html is injected after the page loads, so this listens on the document.
// navigator.clipboard needs a secure context (https or localhost); a LAN address over http does not have one, so there is a
// fallback that copies through a temporary textarea.
const copyText = async (text) => {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the textarea fallback
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
};

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target ? target.closest(".calculator-copy") : null;
  if (!button) return;
  const text = button.getAttribute("data-copy") || "";
  if (!text || !(await copyText(text))) return;
  const label = button.querySelector(".calculator-copy-label");
  const before = label ? label.textContent : null;
  button.setAttribute("data-copied", "true");
  if (label) label.textContent = "Copied";
  setTimeout(() => {
    button.removeAttribute("data-copied");
    if (label && before !== null) label.textContent = before;
  }, 1500);
});
