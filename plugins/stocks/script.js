// Hides a company logo that fails to load (an image error does not bubble, so it is caught in the capture phase on the document).
// Slot html is injected after the page loads, which is why this listens on the document and not on the images.
document.addEventListener(
  "error",
  (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.classList.contains("stocks-logo")) target.remove();
  },
  true,
);
