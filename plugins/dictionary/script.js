// Pronunciation buttons for the dictionary card. Slot html is injected after the page loads, so this listens on the document.
// The audio address is in the button's data-src (our own /audio route, or the dictionary's media address).
let current = null;

const reset = (state) => {
  if (!state) return;
  state.button.classList.remove("is-playing");
  state.audio.pause();
  if (current === state) current = null;
};

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target ? target.closest(".dictionary-play") : null;
  if (!button) return;
  const src = button.getAttribute("data-src");
  if (!src) return;
  if (current && current.button === button) {
    reset(current);
    return;
  }
  reset(current);
  const audio = new Audio(src);
  const state = { button, audio };
  current = state;
  button.removeAttribute("data-failed");
  button.classList.add("is-playing");
  audio.addEventListener("ended", () => reset(state));
  audio.addEventListener("error", () => {
    button.setAttribute("data-failed", "true");
    button.setAttribute("title", "Audio unavailable");
    reset(state);
  });
  audio.play().catch(() => {
    button.setAttribute("data-failed", "true");
    reset(state);
  });
});
