class VologramPlayer {
	#wasm;
	/** @type {number} */ #frameToLoad;
	vologram = {};

	#events = {
		/** @type {Array<(vologram: any) => void>} */
		onframeready: [],
		/** @type {Array<() => void>} */
		onclose: [],
	};

	#loadMesh = (frameIdx) => {
		if (this.vologram.lastFrameLoaded == frameIdx) {
			return;
		} // Safety catch to avoid reloading the same frame twice.

		// Ask the vol_geom WASM to read the frame data from the vologram file into `_frame_data`.
		var ret = this.vologram.read_frame(frameIdx);
		if (!ret) {
			return false;
		}
		this.vologram.frame.isKey = this.vologram.is_keyframe(frameIdx);

		// Positions - fetch and upload.
		this.vologram.frame.positions = this.vologram.frame_get_verts();

		if (this.vologram.header.hasNormals) {
			// Not all volograms include normals.
			// Normals - fetch and upload.
			this.vologram.frame.normals = this.vologram.frame_get_norms();
		}

		// Key-Frames also contain texture coordinate and index data.
		if (this.vologram.frame.isKey) {
			this.vologram.lastKeyframeLoaded = frameIdx;
			// Texture Coordinates - fetch and upload.
			this.vologram.frame.texCoords = this.vologram.frame_get_uvs();

			// Indices - fetch and upload.
			this.vologram.frame.indices = this.vologram.frame_get_ind();
		}
		this.vologram.lastFrameLoaded = frameIdx;
		return true;
	};

	// Calls mesh_from_frame() but first loads a keyframe, if required.
	#updateMeshFrameAllowingSkip = (desiredFrameIndex) => {
		var keyframeRequired = this.vologram.find_previous_keyframe(desiredFrameIndex);

		// If running slowly we may skip over a keyframe. Grab that now to avoid stale keyframe desync.
		if (this.vologram.lastKeyframeLoaded != keyframeRequired) {
			this.#loadMesh(keyframeRequired);
		}
		// Load actual current frame.
		this.#loadMesh(desiredFrameIndex);
	};

	#initVologram = () => {
		var ret = false;
		if (this.vologram.singleFileMode) {
			ret = this.vologram.create_single_file_info("vologram.vols");
		} else {
			ret = this.vologram.create_file_info("header.vols", "sequence.vols");
		}

		console.log("create_file_info=" + ret);
		if (!ret) {
			console.error("failed to load vologram");
			return;
		}

		this.vologram.header.hasNormals = this.vologram.has_normals();
		this.vologram.header.hasTexture = this.vologram.has_texture();
		this.vologram.header.hasAudio = this.vologram.has_audio();
		this.vologram.header.textureCompression = this.vologram.texture_compression();
		this.vologram.header.textureContainerFormat = this.vologram.texture_container_format();
		this.vologram.header.textureWidth = this.vologram.texture_width();
		this.vologram.header.textureHeight = this.vologram.texture_height();
		if (this.vologram.header.textureWidth === 0) this.vologram.header.textureWidth = 2048;
		if (this.vologram.header.textureHeight === 0) this.vologram.header.textureHeight = 2048;
		console.log(this.vologram.header.textureWidth, this.vologram.header.textureHeight);
		this.vologram.header.frameCount = this.vologram.frame_count();
		this.vologram.header.fps = 30;
		this.vologram.header.durationS = this.vologram.header.frameCount / this.vologram.header.fps; // 5.0;
		this.vologram.header.ready = true;
	};

	#initWasm = async (downloadFiles) => {
		const onInitFinished = async () => {
			console.log("Init finished");
			this.#wasm.initVologramFunctions(this.vologram);
			// TODO: Add function in pre.js
			this.#wasm.ccall("basis_init", "boolean");
			this.#initVologram();
		};

		this.#wasm = {
			onRuntimeInitialized: () => {
				console.log("Vologram wasm module initialised");
				if (downloadFiles) {
					if (this.vologram.header.singleFile) {
						this.#wasm.fetch_file("vologram.vols", this.vologram.fileUrl).then(() => {
							onInitFinished();
						});
					} else {
						console.log("Downloading hdr and seq files");
						this.#wasm.fetch_file("header.vols", this.vologram.headerUrl).then(() => {
							this.#wasm.fetch_file("sequence.vols", this.vologram.sequenceUrl).then(() => {
								onInitFinished();
							});
						});
					}
				} else {
					onInitFinished();
				}
			},
		};
		return VolWeb(this.#wasm);
	};

	#shouldAdvanceFrame = (time) => {
		this.#frameToLoad = Math.floor(this.vologram.header.fps * time);
		if (this.#frameToLoad === this.vologram.lastFrameLoaded) {
			return false;
		}
		if (this.#frameToLoad >= this.vologram.header.frameCount) {
			this.#frameToLoad = 0;
		}
		return true;
	};

	/** @type {VideoFrameRequestCallback} */
	#videoFrameCallback = (now, metadata) => {
		if (this.vologram.header.ready && this.#shouldAdvanceFrame(metadata.mediaTime)) {
			this.#updateMeshFrameAllowingSkip(this.#frameToLoad);
			this.#events.onframeready.forEach((fn) => fn(this.vologram));
		}
		this.vologram.attachedVideo?.requestVideoFrameCallback(this.#videoFrameCallback);
	};

	play = () => {
		if (this.vologram.attachedVideo) this.vologram.attachedVideo.play();
	};

	/** @type {(videoElement: HTMLVideoElement) => void} */
	attachVideo = (videoElement) => {
		this.vologram.attachedVideo = videoElement;
		videoElement.src = this.vologram.textureUrl;
		videoElement.requestVideoFrameCallback(this.#videoFrameCallback);
	};

	open = async (headerUrl, sequenceUrl, textureUrl, downloadFiles = true) => {
		this.vologram = {};
		this.vologram.header = {};
		this.vologram.frame = {};
		this.vologram.header.singleFile = false;
		this.vologram.headerUrl = headerUrl;
		this.vologram.sequenceUrl = sequenceUrl;
		this.vologram.textureUrl = textureUrl;
		return this.#initWasm(downloadFiles);
	};

	close = () => {
		this.vologram.attachedVideo?.pause();
		this.vologram.attachedVideo = null;
		this.#events.onclose.forEach((fn) => fn());
	};

	openSingleFile = async (fileUrl, downloadFiles = true) => {
		this.vologram = {};
		this.vologram.header = {};
		this.vologram.frame = {};
		this.vologram.header.singleFile = true;
		this.vologram.header.fileUrl = fileUrl;
		return this.#initWasm(downloadFiles);
	};

	addEventListener(event, callback) {
		this.#events[event].push(callback);
	}

	removeEventListener(event, callback) {
		let index = this.#events[event].indexOf(callback);
		if (index < 0) return;
		this.#events[event].splice(index, 1);
	}
}
