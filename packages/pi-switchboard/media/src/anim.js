// A tiny timeline for the README animations. Each page defines its scenes and
// exposes window.play(), which the media renderer records until it resolves.
window.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
