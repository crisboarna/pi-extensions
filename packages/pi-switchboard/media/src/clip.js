// Shared setup for the terminal clips: pi starts before the recording, then
// the clip's own steps run with the Stage API (tools/media/stage/stage.js).
window.clip = (steps, { title = "~/acme-shop — pi" } = {}) => {
	let stage;
	window.prepare = async () => {
		stage = await Stage.open({ title });
		await stage.waitFor("(switchboard)");
	};
	window.play = async () => {
		await sleep(500);
		await steps(stage);
		await sleep(600);
	};
};
