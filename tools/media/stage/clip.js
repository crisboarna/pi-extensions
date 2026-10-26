// Shared setup for the terminal clips: pi starts before the recording, then
// the clip's own steps run with the Stage API (tools/media/stage/stage.js).
// pi is ready once its footer shows the context meter ("0.0%/200k", or "(0.0%)" in powerline).
window.clip = (steps, { title = "~/acme-shop — pi", ready = /\d+\.\d%\/\d+|\(\d+\.\d%\)/ } = {}) => {
	let stage;
	window.prepare = async () => {
		stage = await Stage.open({ title });
		await stage.waitFor(ready);
	};
	window.play = async () => {
		await sleep(500);
		await steps(stage);
		await sleep(600);
	};
};
