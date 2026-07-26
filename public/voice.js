// Concord voice engine — WebRTC mesh audio + screen share.
// One RTCPeerConnection per remote peer in the same voice channel, signaled
// over the server's addressed `rtc` relay using the perfect-negotiation
// pattern (polite side = lexicographically smaller sid).

const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const SPEAK_THRESHOLD = 0.024;
const SPEAK_HOLD_MS = 250;

export class VoiceEngine {
  /**
   * hooks: {
   *   mySid(): string,
   *   send(obj): void,                      // ws send (rtc / voice-state)
   *   onSpeaking(sid|'me', bool): void,
   *   onShareStart(sid, MediaStream): void, // remote screen appears
   *   onShareEnd(sid): void,
   *   onLocalShareEnd(): void,              // our own share stopped (any reason)
   *   onError(text): void,
   *   settings(): {micId, ptt, pttKey, sounds, volume}  // volume 0..200
   * }
   */
  constructor(hooks) {
    this.h = hooks;
    this.peers = new Map(); // sid -> peer record
    this.localStream = null;
    this.shareStream = null;
    this.chanId = null;
    this.muted = false;
    this.deafened = false;
    this.pttDown = false;
    this.ctx = null;
    this.masterGain = null;
    this.localAnalyser = null;
    this.speakTimer = null;
    this.speakingState = new Map(); // sid -> {speaking, lastLoud}
    this._keyHandlersInstalled = false;
  }

  get connected() {
    return this.chanId !== null;
  }

  // ---------------------------------------------------------------- lifecycle

  async join(chanId) {
    if (this.connected) await this.leave({ silent: true });
    this._ensureCtx();
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: this._micConstraints(),
      });
    } catch (err) {
      this.h.onError("Microphone blocked — check browser permissions.");
      throw err;
    }
    this.chanId = chanId;
    this._applyTrackEnabled();
    this._watchLocalLevel();
    this._installPttHandlers();
    this._startSpeakLoop();
    this.playCue("join");
    return true;
  }

  // Server told us who's already in the room; we initiate toward each.
  async connectToPeers(sids) {
    for (const sid of sids) {
      const peer = this._ensurePeer(sid);
      // Adding our track triggers onnegotiationneeded → offer.
      this._attachLocalAudio(peer);
      if (this.shareStream) this._attachShare(peer);
    }
  }

  async leave({ silent } = {}) {
    for (const sid of [...this.peers.keys()]) this._closePeer(sid);
    this.peers.clear();
    if (this.shareStream) this._stopShareTracks();
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
    if (this.speakTimer) {
      clearInterval(this.speakTimer);
      this.speakTimer = null;
    }
    this.localAnalyser = null;
    this.chanId = null;
    this.h.onSpeaking("me", false);
    if (!silent) this.playCue("leave");
  }

  // ------------------------------------------------------------------ peers

  _ensurePeer(sid) {
    let peer = this.peers.get(sid);
    if (peer) return peer;

    const pc = new RTCPeerConnection(ICE);
    peer = {
      sid,
      pc,
      polite: this.h.mySid() < sid,
      makingOffer: false,
      ignoreOffer: false,
      audioEl: null,
      gainNode: null,
      analyser: null,
      userVolume: 1,
      videoSender: null,
      shareVisible: false,
    };
    this.peers.set(sid, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.h.send({ type: "rtc", to: sid, data: { kind: "desc", desc: pc.localDescription } });
      } catch (err) {
        console.warn("negotiation failed", err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      this.h.send({ type: "rtc", to: sid, data: { kind: "ice", candidate } });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") pc.restartIce();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        // If the peer is still supposed to be here, app-level state will
        // re-establish on their next signal; drop our side cleanly.
        this._closePeer(sid);
      }
    };

    pc.ontrack = ({ track, streams }) => {
      if (track.kind === "audio") {
        this._playRemoteAudio(peer, streams[0] || new MediaStream([track]));
      } else {
        peer.shareVisible = true;
        this.h.onShareStart(sid, streams[0] || new MediaStream([track]));
        const gone = () => {
          if (peer.shareVisible) {
            peer.shareVisible = false;
            this.h.onShareEnd(sid);
          }
        };
        track.onended = gone;
        track.onmute = gone;
        track.onunmute = () => {
          if (!peer.shareVisible) {
            peer.shareVisible = true;
            this.h.onShareStart(sid, streams[0] || new MediaStream([track]));
          }
        };
      }
    };

    return peer;
  }

  _attachLocalAudio(peer) {
    if (!this.localStream) return;
    const track = this.localStream.getAudioTracks()[0];
    if (!track) return;
    const already = peer.pc.getSenders().some((s) => s.track && s.track.kind === "audio");
    if (!already) peer.pc.addTrack(track, this.localStream);
  }

  async handleRtc(from, data) {
    if (!this.connected) return;
    const peer = this._ensurePeer(from);
    // A peer signaling us means they want our audio too.
    this._attachLocalAudio(peer);
    const pc = peer.pc;

    try {
      if (data.kind === "desc") {
        const desc = data.desc;
        const collision =
          desc.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (desc.type === "offer") {
          await pc.setLocalDescription();
          this.h.send({ type: "rtc", to: from, data: { kind: "desc", desc: pc.localDescription } });
        }
      } else if (data.kind === "ice" && data.candidate !== undefined) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn("rtc handling error", err);
    }
  }

  peerLeft(sid) {
    this._closePeer(sid);
  }

  _closePeer(sid) {
    const peer = this.peers.get(sid);
    if (!peer) return;
    this.peers.delete(sid);
    if (peer.shareVisible) this.h.onShareEnd(sid);
    try {
      peer.pc.onnegotiationneeded = null;
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.close();
    } catch {}
    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }
    this.h.onSpeaking(sid, false);
    this.speakingState.delete(sid);
  }

  // ------------------------------------------------------------------ audio

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
      this._applyMasterVolume();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  _playRemoteAudio(peer, stream) {
    this._ensureCtx();
    // Chrome quirk: WebRTC audio must be attached to a media element for the
    // WebAudio graph to receive data — keep the element muted, output via graph.
    if (!peer.audioEl) {
      peer.audioEl = document.createElement("audio");
      peer.audioEl.autoplay = true;
      peer.audioEl.muted = true;
      document.body.appendChild(peer.audioEl);
    }
    peer.audioEl.srcObject = stream;

    const src = this.ctx.createMediaStreamSource(stream);
    peer.gainNode = this.ctx.createGain();
    peer.gainNode.gain.value = peer.userVolume;
    peer.analyser = this.ctx.createAnalyser();
    peer.analyser.fftSize = 512;
    src.connect(peer.analyser);
    src.connect(peer.gainNode);
    peer.gainNode.connect(this.masterGain);
  }

  _watchLocalLevel() {
    if (!this.localStream) return;
    const src = this.ctx.createMediaStreamSource(this.localStream);
    this.localAnalyser = this.ctx.createAnalyser();
    this.localAnalyser.fftSize = 512;
    src.connect(this.localAnalyser); // analysis only — never to output (no echo)
  }

  _level(analyser) {
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    return Math.sqrt(sum / buf.length);
  }

  _startSpeakLoop() {
    if (this.speakTimer) clearInterval(this.speakTimer);
    this.speakTimer = setInterval(() => {
      const now = Date.now();
      const check = (key, analyser, gate) => {
        let st = this.speakingState.get(key);
        if (!st) {
          st = { speaking: false, lastLoud: 0 };
          this.speakingState.set(key, st);
        }
        const loud = gate && analyser && this._level(analyser) > SPEAK_THRESHOLD;
        if (loud) st.lastLoud = now;
        const speaking = loud || (st.speaking && now - st.lastLoud < SPEAK_HOLD_MS);
        if (speaking !== st.speaking) {
          st.speaking = speaking;
          this.h.onSpeaking(key, speaking);
        }
      };
      const micLive = this._micLive();
      check("me", this.localAnalyser, micLive);
      for (const peer of this.peers.values()) {
        check(peer.sid, peer.analyser, !this.deafened);
      }
    }, 100);
  }

  _micLive() {
    const track = this.localStream?.getAudioTracks()[0];
    return !!track && track.enabled;
  }

  // ------------------------------------------------------------- mic control

  _micConstraints() {
    const { micId } = this.h.settings();
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    return micId ? { ...base, deviceId: { ideal: micId } } : base;
  }

  _applyTrackEnabled() {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return;
    const { ptt } = this.h.settings();
    const silenced = this.muted || this.deafened || (ptt && !this.pttDown);
    track.enabled = !silenced;
  }

  setMuted(muted) {
    this.muted = muted;
    this._applyTrackEnabled();
    this.playCue(muted ? "mute" : "unmute");
    this._sendVoiceState();
  }

  setDeafened(deafened) {
    this.deafened = deafened;
    if (this.masterGain) {
      this.masterGain.gain.value = deafened ? 0 : this._volumeScalar();
    }
    this._applyTrackEnabled();
    this.playCue(deafened ? "mute" : "unmute");
    this._sendVoiceState();
  }

  _volumeScalar() {
    return Math.max(0, Math.min(2, (this.h.settings().volume ?? 100) / 100));
  }

  _applyMasterVolume() {
    if (this.masterGain && !this.deafened) this.masterGain.gain.value = this._volumeScalar();
  }

  volumeChanged() {
    this._applyMasterVolume();
  }

  pttChanged() {
    this._applyTrackEnabled();
  }

  setUserVolume(sid, percent) {
    const peer = this.peers.get(sid);
    if (!peer) return;
    peer.userVolume = Math.max(0, Math.min(2, percent / 100));
    if (peer.gainNode) peer.gainNode.gain.value = peer.userVolume;
  }

  getUserVolume(sid) {
    const peer = this.peers.get(sid);
    return peer ? Math.round(peer.userVolume * 100) : 100;
  }

  async setMicDevice() {
    if (!this.connected) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: this._micConstraints() });
      const newTrack = stream.getAudioTracks()[0];
      const old = this.localStream.getAudioTracks()[0];
      for (const peer of this.peers.values()) {
        const sender = peer.pc.getSenders().find((s) => s.track === old);
        if (sender) await sender.replaceTrack(newTrack);
      }
      old.stop();
      this.localStream.removeTrack(old);
      this.localStream.addTrack(newTrack);
      this._applyTrackEnabled();
      this._watchLocalLevel();
    } catch {
      this.h.onError("Couldn't switch microphone.");
    }
  }

  _installPttHandlers() {
    if (this._keyHandlersInstalled) return;
    this._keyHandlersInstalled = true;
    const isPttKey = (e) => {
      const { ptt, pttKey } = this.h.settings();
      return ptt && this.connected && e.code === (pttKey || "Space");
    };
    window.addEventListener("keydown", (e) => {
      if (!isPttKey(e)) return;
      const t = e.target;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      e.preventDefault();
      if (!this.pttDown) {
        this.pttDown = true;
        this._applyTrackEnabled();
      }
    });
    window.addEventListener("keyup", (e) => {
      const { ptt, pttKey } = this.h.settings();
      if (!ptt || e.code !== (pttKey || "Space")) return;
      this.pttDown = false;
      this._applyTrackEnabled();
    });
    window.addEventListener("blur", () => {
      if (this.pttDown) {
        this.pttDown = false;
        this._applyTrackEnabled();
      }
    });
  }

  _sendVoiceState() {
    if (!this.connected) return;
    this.h.send({
      type: "voice-state",
      muted: this.muted,
      deafened: this.deafened,
      sharing: !!this.shareStream,
    });
  }

  // ------------------------------------------------------------ screen share

  async startShare() {
    if (!this.connected || this.shareStream) return;
    try {
      this.shareStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch {
      return; // user cancelled the picker
    }
    const track = this.shareStream.getVideoTracks()[0];
    track.onended = () => this.stopShare(); // browser "Stop sharing" button
    for (const peer of this.peers.values()) this._attachShare(peer);
    this._sendVoiceState();
  }

  _attachShare(peer) {
    if (!this.shareStream) return;
    const track = this.shareStream.getVideoTracks()[0];
    if (!track || peer.videoSender) return;
    peer.videoSender = peer.pc.addTrack(track, this.shareStream);
  }

  stopShare() {
    if (!this.shareStream) return;
    this._stopShareTracks();
    for (const peer of this.peers.values()) {
      if (peer.videoSender) {
        try {
          peer.pc.removeTrack(peer.videoSender);
        } catch {}
        peer.videoSender = null;
      }
    }
    this._sendVoiceState();
    this.h.onLocalShareEnd();
  }

  _stopShareTracks() {
    for (const t of this.shareStream.getTracks()) t.stop();
    this.shareStream = null;
  }

  // ----------------------------------------------------------------- sounds

  playCue(name) {
    if (!this.h.settings().sounds) return;
    this._ensureCtx();
    const notes = {
      join: [
        [440, 0, 0.08],
        [660, 0.09, 0.1],
      ],
      leave: [
        [660, 0, 0.08],
        [440, 0.09, 0.1],
      ],
      mute: [[330, 0, 0.07]],
      unmute: [[520, 0, 0.07]],
      ping: [
        [880, 0, 0.05],
        [1100, 0.06, 0.08],
      ],
    }[name];
    if (!notes) return;
    const t0 = this.ctx.currentTime;
    for (const [freq, start, dur] of notes) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + start);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(g);
      g.connect(this.ctx.destination); // cues bypass deafen master gain
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.05);
    }
  }
}
