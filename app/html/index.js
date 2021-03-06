// https://janus.conf.meetecho.com/docs/JS.html

class StreamInputController {
	intervals = [];

	socket = null;
	streamEl = null;

	guacamoleKeyboard = null;
	keysDown = {};

	active = false;

	constructor(socket, streamEl) {
		this.socket = socket;
		this.streamEl = streamEl;

		this.guacamoleKeyboard = new Guacamole.Keyboard(this.streamEl);
	}

	mouseMovePacket = null;

	mousemove = event => {
		event.preventDefault();
		const x = event.layerX / event.target.clientWidth;
		const y = event.layerY / event.target.clientHeight;
		this.mouseMovePacket = [x, y];
	};

	mousedown = event => {
		event.preventDefault();
		event.target.focus();
		this.socket.emit("mousedown", event.button);
	};

	mouseup = event => {
		event.preventDefault();
		this.socket.emit("mouseup", event.button);
	};

	wheel = event => {
		event.preventDefault();
		const up = event.deltaY < 0;
		this.socket.emit("scroll", up);
	};

	start() {
		if (this.active) return;
		this.active = true;

		this.intervals.push(
			setInterval(() => {
				if (this.mouseMovePacket == null) return;
				this.socket.emit("mousemove", this.mouseMovePacket);
				this.mouseMovePacket = null;
			}, 1000 / 30),
		);

		this.streamEl.addEventListener("mousemove", this.mousemove);
		this.streamEl.addEventListener("mousedown", this.mousedown);
		this.streamEl.addEventListener("mouseup", this.mouseup);
		this.streamEl.addEventListener("wheel", this.wheel);

		if (navigator.clipboard && navigator.clipboard.readText)
			navigator.clipboard.readText(); // request permission

		this.guacamoleKeyboard.onkeydown = keysym => {
			this.keysDown[keysym] = true;

			if (
				this.keysDown[65507] && // CTRL
				(keysym == 118 || keysym == 86) // v or V
			) {
				if (navigator.clipboard && navigator.clipboard.readText)
					navigator.clipboard
						.readText()
						.then(text => {
							this.socket.emit("keyup", 65507); // release CTRL first lol
							this.socket.emit("type", text);
						})
						.catch(err => {});
			} else {
				this.socket.emit("keydown", keysym);
			}
		};
		this.guacamoleKeyboard.onkeyup = keysym => {
			delete this.keysDown[keysym];
			this.socket.emit("keyup", keysym);
		};
	}

	stop() {
		if (!this.active) return;
		this.active = false;

		for (const interval of this.intervals) {
			clearInterval(interval);
		}

		this.streamEl.removeEventListener("mousemove", this.mousemove);
		this.streamEl.removeEventListener("mousedown", this.mousedown);
		this.streamEl.removeEventListener("mouseup", this.mouseup);
		this.streamEl.removeEventListener("wheel", this.wheel);

		this.guacamoleKeyboard.onkeydown = null;
		this.guacamoleKeyboard.onkeyup = null;

		this.keysDown = {};
	}
}

let janusInitialized = false;

const startJanus = async (streamEl, streamName, destroyedCallback) => {
	if (!janusInitialized) {
		await new Promise(callback => {
			Janus.init({
				// debug: "all",
				callback,
			});
		});
		janusInitialized = true;
	}

	if (!Janus.isWebrtcSupported()) {
		alert("WebRTC not supported");
		return;
	}

	const janusServer =
		(window.location.protocol.startsWith("https") ? "wss://" : "ws://") +
		window.location.host +
		"/janus";

	const janus = await new Promise((resolve, reject) => {
		const janus = new Janus({
			server: janusServer,
			success() {
				resolve(janus);
			},
			error(error) {
				reject(error);
			},
			destroyed() {},
		});
	});

	let streaming;

	janus.attach({
		plugin: "janus.plugin.streaming",
		opaqueId: Janus.randomString(16),
		async success(pluginHandle) {
			streaming = pluginHandle;

			const { list } = await new Promise(success => {
				streaming.send({
					message: { request: "list" },
					success,
				});
			});

			if (list == null) return;
			if (list.length <= 0) return;

			const stream = list.find(item =>
				item.description
					.toLowerCase()
					.includes(streamName.toLowerCase()),
			);
			if (stream == null) return;
			// console.log("Found stream", stream);

			await new Promise(success => {
				streaming.send({
					message: { request: "watch", id: stream.id },
					success,
				});
			});
		},
		error(error) {
			console.error(error);
		},
		iceState(state) {
			// console.log("ICE state changed to", state);
			if (state == "disconnected") {
				streaming.detach();
				janus.destroy();
				if (destroyedCallback) destroyedCallback();
			}
		},
		webrtcState(on) {
			// console.log("WebRTC PeerConnection up", on);
		},
		onmessage(msg, jsep) {
			// console.log(" ::: Got a message :::", msg);

			if (msg.result && msg.result.status) {
				// const status = msg.result.status;
				// if (status === "starting") {
				// 	console.log("starting");
				// } else if (status === "started") {
				// 	console.log("started");
				// } else if (status === "stopped") {
				// 	console.log("stopped");
				// 	// stopStream();
				// }
			} else if (msg.error) {
				console.error(msg.error);
				// stopStream();
				return;
			}

			if (jsep) {
				// console.log("Handling SDP as well...", jsep);
				const stereo = jsep.sdp.indexOf("stereo=1") !== -1;
				streaming.createAnswer({
					jsep,
					media: {
						audioSend: false,
						videoSend: false,
					},
					customizeSdp(jsep) {
						if (stereo && jsep.sdp.indexOf("stereo=1") == -1) {
							jsep.sdp = jsep.sdp.replace(
								"useinbandfec=1",
								"useinbandfec=1;stereo=1",
							);
						}
					},
					success(jsep) {
						// console.log("Got SDP!", jsep);
						streaming.send({
							message: {
								request: "start",
							},
							jsep,
						});
					},
					error(error) {
						console.error(error);
					},
				});
			}
		},
		onremotestream(stream) {
			// console.log(" ::: Got a remote stream :::", stream);
			Janus.attachMediaStream(streamEl, stream);
			streamEl.play();
		},
	});
};

(async function () {
	const queryParams = window.location.search
		.substr(1)
		.split("&")
		.reduce((params, paramStr) => {
			const param = paramStr.split("=");
			if (param.length == 1) {
				params[param[0]] = true;
			} else if (param.length > 1) {
				params[param[0]] = param[1];
			}
			return params;
		}, {});

	const displayPlural = (n, singular, plural = null) =>
		n +
		" " +
		(n === 1 ? singular : plural != null ? plural : singular + "s");

	// initial query params

	if (queryParams.hideControls) document.body.className = "hide-controls";
	if (queryParams.grayscale) document.body.style.filter = "grayscale(1)";
	if (queryParams.sepia) document.body.style.filter = "sepia(1)";
	if (queryParams.invert) document.body.style.filter = "invert(1)";

	// socket to node server for handling input

	const socket = io({
		query: {
			password: queryParams.password,
		},
	});
	window.socket = socket;

	// make sure the stream is playing

	const streamEl = document.getElementById("stream");
	const streamAudioEl = document.getElementById("stream-audio");
	const volumeSliderEl = document.getElementById("volume-slider");
	const loadingEl = document.getElementById("loading");

	streamEl.addEventListener("contextmenu", event => {
		event.preventDefault();
	});

	volumeSliderEl.addEventListener("input", event => {
		streamAudioEl.volume = Number(volumeSliderEl.value);
	});

	if (queryParams.volume != null) {
		const volume = Number(queryParams.volume);
		if (volume >= 0 && volume <= 1) {
			streamAudioEl.volume = volumeSliderEl.value = volume;
		}
	} else {
		streamAudioEl.volume = volumeSliderEl.value = 0.7; // default volume
	}

	streamEl.addEventListener("playing", () => {
		loadingEl.style.display = streamEl.paused ? "initial" : "none";
	});

	setInterval(() => {
		if (streamEl.paused) {
			try {
				streamEl.play();
			} catch (err) {}
		}
		if (streamAudioEl.paused) {
			try {
				streamAudioEl.play();
			} catch (err) {}
		}
	}, 500);

	// controller management

	const controller = new StreamInputController(socket, streamEl);
	window.controller = controller;

	const usersEl = document.getElementById("users");
	const toggleControlsEl = document.getElementById("toggle-controls");

	toggleControlsEl.addEventListener("click", () => {
		socket.emit("toggleControls");
	});

	const iconHtml = icon => '<i class="material-icons">' + icon + "</i> ";

	socket.on("info", info => {
		usersEl.textContent =
			displayPlural(info.users, "person", "people") + " watching";

		if (!info.hasPassword || (info.hasPassword && info.validPassword)) {
			if (info.controlsOwner == socket.id) {
				controller.start();
				toggleControlsEl.innerHTML =
					iconHtml("stop") + "Stop controlling";
				toggleControlsEl.disabled = false;
			} else if (info.controlsOwner != null) {
				if (info.allowSteal) {
					controller.stop();
					toggleControlsEl.innerHTML =
						iconHtml("skip_next") + "Steal controls";
					toggleControlsEl.disabled = false;
				} else {
					controller.stop();
					toggleControlsEl.innerHTML =
						iconHtml("close") + "Someone is controlling";
					toggleControlsEl.disabled = true;
				}
			} else {
				controller.stop();
				toggleControlsEl.innerHTML =
					iconHtml("play_arrow") + "Start controlling";
				toggleControlsEl.disabled = false;
			}
		} else if (!info.validPassword) {
			controller.stop();
			toggleControlsEl.innerHTML = iconHtml("close") + "Can't control";
			toggleControlsEl.disabled = true;
		}
	});

	// janus video stuff

	const playing = {
		video: false,
		audio: false,
	};

	const preStartJanus = () => {
		const check = (el, streamName) => {
			if (!playing[streamName]) {
				startJanus(el, streamName, () => {
					playing[streamName] = false;
				})
					.then(() => {
						playing[streamName] = true;
					})
					.catch(error => {
						console.error(error);
					});
			}
		};

		check(streamEl, "video");
		check(streamAudioEl, "audio");

		setInterval(() => {
			check(streamEl, "video");
			check(streamAudioEl, "audio");
		}, 1000 * 5);
	};

	if (window.qt) {
		preStartJanus();
	} else {
		const getUserInputEl = document.getElementById("get-user-input");
		getUserInputEl.style.display = "flex";
		getUserInputEl.addEventListener("click", e => {
			getUserInputEl.parentNode.removeChild(getUserInputEl);
			preStartJanus();
		});
	}

	// dynamic lights

	if (queryParams.dynamicLights) {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 30;

		// document.body.appendChild(canvas);
		// let debug = document.createElement("h2");
		// document.body.appendChild(debug);

		const ctx = canvas.getContext("2d");

		const getAverageColor = (x, y) => {
			const average = [0, 0, 0];
			const colors = ctx.getImageData(x * 10, y * 10, 10, 10).data;

			for (let i = 0; i < 100; i++) {
				const index = i * 4;
				average[0] += colors[index];
				average[1] += colors[index + 1];
				average[2] += colors[index + 2];
			}

			return [
				Math.floor(average[0] / 100),
				Math.floor(average[1] / 100),
				Math.floor(average[2] / 100),
			];
		};

		const getColors = () =>
			[
				// top
				getAverageColor(0, 0),
				getAverageColor(1, 0),
				getAverageColor(2, 0),
				// middle
				getAverageColor(0, 1),
				getAverageColor(2, 1),
				// bottom
				getAverageColor(0, 2),
				getAverageColor(1, 2),
				getAverageColor(2, 2),
			]
				.reduce((colors, c) => {
					colors = colors.concat([c[0], c[1], c[2]]);
					return colors;
				}, [])
				.join(",");

		let renderWidth = canvas.width;
		if (queryParams["3D"]) renderWidth = canvas.width * 2;

		setInterval(() => {
			ctx.drawImage(streamEl, 0, 0, renderWidth, canvas.height);

			const color = getColors();
			// debug.textContent = getColors();

			if (window.qt) EventBridge.emitWebEvent(color);
		}, 1000 / 30);
	}
})();
