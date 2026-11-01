// A tiny timeline for the README animations. Each page defines its scenes and
// exposes window.play(), which the media renderer records until it resolves.
// Holds stretch by the media pace (render.mjs sets window.MEDIA_PACE), so every animation slows down together.
window.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms * (window.MEDIA_PACE ?? 1)));
window.$ = (selector) => document.querySelector(selector);
window.show = (selector) => {
	for (const node of document.querySelectorAll(selector)) node.classList.remove("hidden");
};
window.caption = (text) => {
	const el = document.querySelector(".caption");
	el.style.opacity = "0";
	return sleep(250).then(() => {
		el.textContent = text;
		el.style.opacity = "1";
	});
};
window.el = (tag, className, text) => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
};
window.time = (iso) => new Date(iso).toISOString().slice(11, 16);
// Saves the frame on screen as the item's still (`still: true` in the manifest).
window.still = () => window.__stageStill?.();
