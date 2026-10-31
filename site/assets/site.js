// The site's one script: the theme toggle, entrance animations, the hero
// video's narration button, copy buttons and the offline worker. Every page
// works without it; it only adds to the page.
const script = document.currentScript;
const root = document.documentElement;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function remember(storage, key, value) {
	try {
		storage.setItem(key, value);
	} catch {
		// Storage can be blocked; the choice then lasts for this page only.
	}
}

function setupThemeToggle() {
	const button = document.getElementById("theme-toggle");
	if (!button) return;
	const show = () => {
		const light = root.dataset.theme === "light";
		button.setAttribute("aria-pressed", String(light));
		button.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
	};
	show();
	button.addEventListener("click", () => {
		root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
		remember(localStorage, "theme", root.dataset.theme);
		show();
	});
}

function setupReveal() {
	const targets = document.querySelectorAll(".reveal");
	if (!("IntersectionObserver" in window) || reducedMotion.matches) {
		for (const target of targets) target.classList.add("is-visible");
		return;
	}
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.classList.add("is-visible");
				observer.unobserve(entry.target);
			}
		},
		{ rootMargin: "0px 0px -8% 0px" },
	);
	for (const target of targets) observer.observe(target);
}

/** The sidebar is open on a wide screen and starts closed on a narrow one. */
function setupSidebar() {
	const details = document.querySelector(".sidebar details");
	if (details) details.open = !window.matchMedia("(max-width: 960px)").matches;
}

/**
 * The hero video starts muted by itself, because browsers do not start sound
 * on load. The button restarts it with the narration. A visitor who prefers
 * less motion gets the poster and a play button instead.
 */
function setupHeroVideo() {
	const video = document.querySelector("video[autoplay]");
	if (!video) return;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "narration";
	if (reducedMotion.matches) {
		video.pause();
		button.textContent = "▶ Play the demo";
	} else {
		button.textContent = "🔊 Play with narration";
		// The attribute starts it in most browsers; asking again covers the rest. A muted video may always play.
		video.play().catch(() => {});
	}
	button.addEventListener("click", () => {
		video.muted = false;
		video.loop = false;
		video.currentTime = 0;
		video.play().catch(() => {
			video.muted = true;
		});
		button.textContent = "Narration on. Use the player to pause";
	});
	video.after(button);
}

function setupCopyButtons() {
	for (const button of document.querySelectorAll("button[data-copy]")) {
		button.addEventListener("click", async () => {
			const before = button.textContent;
			try {
				await navigator.clipboard.writeText(button.dataset.copy ?? "");
				button.textContent = "Copied";
			} catch {
				button.textContent = "Press Ctrl+C";
			}
			setTimeout(() => {
				button.textContent = before;
			}, 1600);
		});
	}
}

/**
 * One worker for the whole site: it keeps the pages for offline use and adds
 * the headers a static host cannot send, which the live pages need for their
 * WebContainer. The first visit has no worker yet, so a live page reloads once.
 */
async function registerWorker() {
	if (!("serviceWorker" in navigator) || !script) return;
	try {
		await navigator.serviceWorker.register(new URL("../sw.js", script.src));
		if (!document.body.classList.contains("live") || window.crossOriginIsolated) return;
		await navigator.serviceWorker.ready;
		if (sessionStorage.getItem("isolation-reload") === location.href) return;
		remember(sessionStorage, "isolation-reload", location.href);
		location.reload();
	} catch {
		// Without a worker the pages still work online.
	}
}

setupThemeToggle();
setupReveal();
setupSidebar();
setupHeroVideo();
setupCopyButtons();
registerWorker();
