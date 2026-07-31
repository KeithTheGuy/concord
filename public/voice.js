// Concord voice engine — WebRTC mesh audio + screen/camera video.
// One RTCPeerConnection per remote peer in the same voice channel, signaled
// over the server's addressed `rtc` relay using the perfect-negotiation
// pattern (polite side = lexicographically smaller sid).

import { buildFxGraph } from "./voicefx.js";
import {
  buildNoiseGate,
  micConstraints,
  displayConstraints,
  applySenderParams,
  applyVideoSenderParams,
  applySink,
  summariseStats,
} from "./voicelab.js";

const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const SPEAK_THRESHOLD = 0.024;
const SPEAK_HOLD_MS = 250;

// Firefox/Safari can't move an AudioContext to a chosen device, but Firefox
// can move an individual <audio> element. Probed off the prototype so we can
// answer "can this browser pick an output?" before any peer exists.
const ELEMENT_SINK =
  typeof HTMLAudioElement !== "undefined" && typeof HTMLAudioElement.prototype.setSinkId === "function";

// Screen-share audio sits under the voice rather than over it — the point is
// to hear the game, not to be drowned out by it.
const SHARE_AUDIO_GAIN = 0.8;

// This is a full mesh: a screen share isn't one upload, it's one independent
// encode PER PEER, all leaving this machine at once. A flat per-peer cap
// doesn't protect anyone once the room is big enough — 8 peers at an
// uncapped 1080p60 (~2-3Mbps each) is 17-22Mbps of uplink from one person,
// which reliably collapses everyone's call. So the cap is a shared budget:
// SHARE_VIDEO_BUDGET_KBPS is the total we're willing to spend on the share
// across every peer combined, divided evenly as the room grows.
// SHARE_VIDEO_MAX_KBPS keeps a 1:1 or small call from being throttled below
// what a single 720p30 stream actually wants. SHARE_VIDEO_MIN_KBPS is the
// floor below which screen text stops being legible, so a big room degrades
// instead of collapsing to nothing.
//   peers=1  -> 6000/1 = 6000, capped to 2000
//   peers=2  -> 6000/2 = 3000, capped to 2000
//   peers=3  -> 6000/3 = 2000  (budget and ceiling meet)
//   peers=6  -> 6000/6 = 1000
//   peers=8  -> 6000/8 =  750   (total uplink for the share: 6Mbps, not 17-22)
//   peers=24 -> 6000/24=  250  (floor)
const SHARE_VIDEO_BUDGET_KBPS = 6000;
const SHARE_VIDEO_MAX_KBPS = 2000;
const SHARE_VIDEO_MIN_KBPS = 250;

// Compares two FX specs ignoring pitch, so moving the pitch slider doesn't
// tear down and rebuild the whole rack on every input event.
const stripSemis = ({ semis, ...rest }) => rest;

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
    // Voice changer: mic -> pitch shifter -> the track peers actually receive.
    this.fxReady = false;
    this.fxSource = null;
    this.fxNode = null;
    this.fxDest = null;
    this.outTrack = null;
    this.rack = null; // the FX graph after the shifter
    this.gate = null; // noise gate, last thing before the outgoing track
    this.fxSpec = null; // the preset description currently applied
    this.shareKind = null; // "screen" | "camera" | null
    this.shareAudioSrc = null; // system audio from a screen share, mixed outbound
    this.shareAudioGain = null;
    // True once we've given up on ctx.setSinkId and put the <audio> elements
    // in charge of output. Changes how volume is applied, so it's state.
    this.elementSink = false;
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
    await this._buildFxChain();
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
    if (this.fxSource) {
      try {
        this.fxSource.disconnect();
      } catch {}
      this.fxSource = null;
    }
    if (this.rack) {
      this.rack.dispose(); // oscillators in the rack must actually be stopped
      this.rack = null;
    }
    this._disposeGate(); // and its interval, which outlives the call otherwise
    this.outTrack = null; // fxNode/fxDest are reused on the next join
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
      userVolume: this._savedScalar(sid),
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
      if (pc.connectionState === "closed") {
        this._closePeer(sid);
      } else if (pc.connectionState === "failed") {
        this._closePeer(sid);
        // Transient ICE failure: the impolite side re-dials if the peer is
        // still in our channel. Each retry requires a full ICE failure
        // (tens of seconds), so this cannot spin.
        if (this.connected && !peer.polite && this.h.inMyChannel?.(sid)) {
          const fresh = this._ensurePeer(sid);
          this._attachLocalAudio(fresh);
          if (this.shareStream) this._attachShare(fresh);
        }
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
    const track = this._outgoingTrack();
    if (!track) return;
    const already = peer.pc.getSenders().some((s) => s.track && s.track.kind === "audio");
    if (already) return;
    const sender = peer.pc.addTrack(track, this.localStream);
    // Fire and forget: bitrate is a nicety, and a call at default parameters
    // is infinitely better than a call that threw on the way up.
    applySenderParams(sender, this.h.settings()).catch(() => {});
  }

  /** Re-applies bitrate/priority to every peer — for a mid-call stereo flip. */
  async applyBitrate() {
    const settings = this.h.settings();
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === "audio");
      if (sender) await applySenderParams(sender, settings);
    }
  }

  /**
   * Connection health across the mesh. Worst-case rtt/loss/jitter (a call is
   * only as good as its unhappiest leg) but summed kbps, since that's what
   * your connection is actually carrying. No polling in here on purpose —
   * the UI knows when anyone is looking.
   */
  async stats() {
    const peers = this.peers.size;
    const samples = (
      await Promise.all([...this.peers.values()].map((p) => summariseStats(p.pc).catch(() => null)))
    ).filter(Boolean);
    if (!samples.length) return { peers, samples: 0 };
    const worst = (key) => {
      const vals = samples.map((s) => s[key]).filter((v) => v != null);
      return vals.length ? Math.max(...vals) : null;
    };
    return {
      peers,
      samples: samples.length,
      rtt: worst("rtt"),
      loss: worst("loss") ?? 0,
      jitter: worst("jitter"),
      kbps: samples.reduce((sum, s) => sum + (s.kbps || 0), 0),
    };
  }

  // What peers hear: the pitch-shifted output when the changer is available,
  // otherwise the raw mic.
  _outgoingTrack() {
    return this.outTrack || this.localStream?.getAudioTracks()[0] || null;
  }

  // mic -> pitch shifter (worklet) -> FX rack -> the track peers receive.
  // fxDest never gets rebuilt, so swapping presets mid-call needs no
  // renegotiation: the track everyone holds stays the same object.
  async _buildFxChain() {
    this.outTrack = null;
    if (!this.localStream || !this.ctx?.audioWorklet) return;
    try {
      if (!this.fxReady) {
        await this.ctx.audioWorklet.addModule("/voicefx-worklet.js");
        this.fxReady = true;
      }
      if (this.fxSource) {
        try {
          this.fxSource.disconnect();
        } catch {}
      }
      this.fxSource = this.ctx.createMediaStreamSource(this.localStream);
      if (!this.fxNode) {
        this.fxNode = new AudioWorkletNode(this.ctx, "voice-fx");
        this.fxDest = this.ctx.createMediaStreamDestination();
      }
      this.fxSource.connect(this.fxNode);
      this._rebuildRack();
      this.outTrack = this.fxDest.stream.getAudioTracks()[0] || null;
    } catch (err) {
      console.warn("voice changer unavailable, sending raw mic", err);
      this.outTrack = null;
    }
  }

  // mic -> shifter -> rack -> gate -> fxDest. The gate is deliberately last:
  // gating *before* a reverb would chop the tail off your own effects the
  // instant you stopped talking, which sounds broken rather than quiet.
  _rebuildRack() {
    if (!this.fxNode || !this.fxDest) return;
    try {
      this.fxNode.disconnect();
    } catch {}
    if (this.rack) {
      this.rack.dispose();
      this.rack = null;
    }
    // The gate is rebuilt here with the rack, and — more to the point —
    // disposed here. It owns a polling interval; one leaked per preset swap
    // would quietly eat the tab over an evening of messing with voices.
    this._disposeGate();
    this.gate = buildNoiseGate(this.ctx, { threshold: this.h.settings().noiseGate || 0 });
    this.gate.output.connect(this.fxDest);
    const spec = this.fxSpec || {};
    const hasRack = Object.keys(spec).some((k) => k !== "semis");
    if (!hasRack) {
      this.fxNode.connect(this.gate.input); // pitch only
      return;
    }
    this.rack = buildFxGraph(this.ctx, spec);
    this.fxNode.connect(this.rack.input);
    this.rack.output.connect(this.gate.input);
  }

  _disposeGate() {
    if (!this.gate) return;
    this.gate.dispose();
    this.gate = null;
  }

  /** Live threshold change (slider drag): no teardown, no audible seam. */
  setGate(threshold) {
    this.gate?.setThreshold(Number(threshold) || 0);
  }

  /**
   * Applies a full voice preset. `pitchOverride` lets the settings slider nudge
   * the pitch without abandoning the rest of the character.
   * Live: heard immediately, mid-sentence.
   */
  setVoice(spec, pitchOverride) {
    const next = { ...(spec || {}) };
    if (typeof pitchOverride === "number") next.semis = pitchOverride;
    const rackChanged = JSON.stringify(stripSemis(next)) !== JSON.stringify(stripSemis(this.fxSpec || {}));
    this.fxSpec = next;
    this.setEffect(next.semis || 0);
    if (rackChanged && this.ctx) this._rebuildRack();
  }

  setEffect(semitones) {
    const param = this.fxNode?.parameters.get("semitones");
    if (param) param.value = Math.max(-24, Math.min(24, Number(semitones) || 0));
  }

  async handleRtc(from, data) {
    if (!this.connected) return;
    const peer = this._ensurePeer(from);
    // A peer signaling us means they want our audio (and screen, if live) too.
    this._attachLocalAudio(peer);
    if (this.shareStream) this._attachShare(peer);
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
      peer.pc.oniceconnectionstatechange = null; // else a closed pc can still restartIce() on itself
      peer.pc.ontrack = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.close();
    } catch {}
    // One fewer peer means everyone still sharing gets a bigger slice.
    this._rebalanceShareBitrate();
    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }
    // Detach this peer's WebAudio branch from masterGain (re-dial rebuilds it).
    for (const node of [peer.srcNode, peer.gainNode, peer.analyser]) {
      if (node) {
        try {
          node.disconnect();
        } catch {}
      }
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
      // A saved output device has to be re-applied to every fresh context;
      // quietly, because nobody wants a toast about their speakers on load.
      const saved = this.h.settings().outputId;
      if (saved) this._applyOutput(saved, true);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  /**
   * Output device selection. The catch: `_playRemoteAudio` keeps the <audio>
   * elements muted and mixes through WebAudio, so setSinkId on an element
   * does precisely nothing — the sink that matters is the AudioContext's
   * (Chrome 110+). Where that doesn't exist we hand output back to the
   * elements, which means unmuting them and taking volume off the graph.
   */
  async setOutputDevice(deviceId) {
    return this._applyOutput(deviceId, false);
  }

  async _applyOutput(deviceId, quiet) {
    this._ensureCtx();
    const id = deviceId || "";
    if (typeof this.ctx.setSinkId === "function") {
      this.elementSink = false;
      for (const peer of this.peers.values()) this._routePeerOutput(peer);
      const done = await applySink(this.ctx, id);
      if (!done && !quiet) this.h.onError("That output device refused the audio — staying where we are.");
      return done;
    }
    if (!ELEMENT_SINK) {
      // Safari, mostly. Saying so beats a dropdown that silently does nothing.
      if (!quiet) this.h.onError("This browser can't choose an output device — audio follows the system default.");
      return false;
    }
    this.elementSink = true;
    let done = true;
    for (const peer of this.peers.values()) {
      this._routePeerOutput(peer);
      if (peer.audioEl && !(await applySink(peer.audioEl, id))) done = false;
    }
    if (!done && !quiet) this.h.onError("That output device refused the audio — staying where we are.");
    return done;
  }

  // Decides whether a peer is heard through the graph (muted element) or
  // through its element (graph detached). Never both, or you hear everyone
  // twice.
  _routePeerOutput(peer) {
    if (!peer.audioEl || !peer.gainNode) return;
    if (this.elementSink) {
      try {
        peer.gainNode.disconnect(this.masterGain);
      } catch {}
      peer.audioEl.muted = false;
      // Element volume tops out at 1, so the 100–200% half of the volume
      // slider is a graph-only luxury. Better clipped than silent.
      peer.audioEl.volume = this.deafened ? 0 : Math.min(1, peer.userVolume * this._volumeScalar());
    } else {
      peer.audioEl.muted = true;
      peer.gainNode.connect(this.masterGain); // duplicate connections are a no-op
    }
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

    // A repeated ontrack for the same peer must not double the audio graph.
    for (const node of [peer.srcNode, peer.gainNode, peer.analyser]) {
      if (node) {
        try {
          node.disconnect();
        } catch {}
      }
    }
    const src = this.ctx.createMediaStreamSource(stream);
    peer.srcNode = src;
    // The member list may only have arrived after the peer object was made,
    // so re-read the saved volume now that we can map sid -> user.
    peer.userVolume = this._savedScalar(peer.sid);
    peer.gainNode = this.ctx.createGain();
    peer.gainNode.gain.value = peer.userVolume;
    peer.analyser = this.ctx.createAnalyser();
    peer.analyser.fftSize = 512;
    src.connect(peer.analyser);
    src.connect(peer.gainNode);
    peer.gainNode.connect(this.masterGain);
    this._routePeerOutput(peer);
    if (this.elementSink) applySink(peer.audioEl, this.h.settings().outputId || "");
  }

  _watchLocalLevel() {
    if (!this.localStream) return;
    if (this.localSrc) {
      try {
        this.localSrc.disconnect();
      } catch {}
    }
    const src = this.ctx.createMediaStreamSource(this.localStream);
    this.localSrc = src;
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
    return micConstraints(this.h.settings());
  }

  /**
   * Echo cancellation, noise suppression, AGC and stereo are getUserMedia
   * *constraints*, not knobs — the browser bakes them into the capture. The
   * only way to change one is to ask for the mic again, which is exactly what
   * a device switch does, so reuse that path rather than write a second one.
   */
  async applyAudioSettings() {
    await this.setMicDevice();
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
    this._ensureCtx(); // masterGain must exist so deafen always takes effect
    this._applyMasterVolume();
    this._applyTrackEnabled();
    this.playCue(deafened ? "mute" : "unmute");
    this._sendVoiceState();
  }

  _volumeScalar() {
    return Math.max(0, Math.min(2, (this.h.settings().volume ?? 100) / 100));
  }

  _applyMasterVolume() {
    if (this.masterGain) this.masterGain.gain.value = this.deafened ? 0 : this._volumeScalar();
    if (this.elementSink) for (const peer of this.peers.values()) this._routePeerOutput(peer);
  }

  volumeChanged() {
    this._applyMasterVolume();
  }

  pttChanged() {
    this._applyTrackEnabled();
  }

  // Per-person volume is remembered by the app against a stable user id, not
  // the per-connection sid, so it survives reloads and rejoins.
  setUserVolume(sid, percent) {
    const clamped = Math.max(0, Math.min(200, Math.round(percent)));
    this.h.saveVolume?.(sid, clamped);
    const peer = this.peers.get(sid);
    if (!peer) return;
    peer.userVolume = clamped / 100;
    if (peer.gainNode) peer.gainNode.gain.value = peer.userVolume;
    if (this.elementSink) this._routePeerOutput(peer);
  }

  getUserVolume(sid) {
    const saved = this.h.volumeFor?.(sid);
    if (typeof saved === "number") return saved;
    const peer = this.peers.get(sid);
    return peer ? Math.round(peer.userVolume * 100) : 100;
  }

  _savedScalar(sid) {
    const saved = this.h.volumeFor?.(sid);
    return typeof saved === "number" ? Math.max(0, Math.min(2, saved / 100)) : 1;
  }

  // key is a peer sid, or "me" for the local mic.
  isSpeaking(key) {
    return !!this.speakingState.get(key)?.speaking;
  }

  async setMicDevice() {
    if (!this.connected) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: this._micConstraints() });
      const newTrack = stream.getAudioTracks()[0];
      const old = this.localStream.getAudioTracks()[0];
      old.stop();
      this.localStream.removeTrack(old);
      this.localStream.addTrack(newTrack);
      this._applyTrackEnabled();
      // Rebind the shifter to the new mic. With the changer active the track
      // peers hold is unchanged, so this usually needs no renegotiation.
      await this._buildFxChain();
      const outgoing = this._outgoingTrack();
      for (const peer of this.peers.values()) {
        const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === "audio");
        if (sender && sender.track !== outgoing) await sender.replaceTrack(outgoing);
      }
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
      const typing = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT");
      const insertsText = e.key.length === 1 || e.code === "Space";
      if (typing && insertsText) return; // never eat real typing
      if (!typing) e.preventDefault();
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
      shareKind: this.shareKind,
    });
  }

  // ------------------------------------------------------------ screen share

  async startShare() {
    if (!this.connected || this.shareStream) return;
    try {
      this.shareStream = await navigator.mediaDevices.getDisplayMedia(displayConstraints(this.h.settings()));
    } catch {
      return; // user cancelled the picker
    }
    this.shareKind = "screen";
    const track = this.shareStream.getVideoTracks()[0];
    track.onended = () => this.stopShare(); // browser "Stop sharing" button
    this._mixShareAudio();
    for (const peer of this.peers.values()) this._attachShare(peer);
    this._sendVoiceState();
  }

  /**
   * "Share system audio" has to mean people can hear it, so the captured
   * audio joins the outgoing mix at fxDest — downstream of the gate, because
   * nothing is more absurd than a noise gate chewing on the game you're
   * showing people, and downstream of the FX rack, because your podcast
   * reverb has no business on someone's YouTube video.
   *
   * Riding fxDest also means no renegotiation: it's the track peers already
   * hold. The trade is that with the voice changer unavailable there's no
   * fxDest to mix into and the checkbox can't be honoured — rare, and the
   * alternative is a second transceiver for a fringe case.
   */
  _mixShareAudio() {
    const tracks = this.shareStream?.getAudioTracks() || [];
    this._stopShareAudioMix();
    if (!tracks.length || !this.ctx || !this.fxDest || !this.outTrack) return;
    this.shareAudioSrc = this.ctx.createMediaStreamSource(new MediaStream(tracks));
    this.shareAudioGain = this.ctx.createGain();
    this.shareAudioGain.gain.value = SHARE_AUDIO_GAIN;
    this.shareAudioSrc.connect(this.shareAudioGain).connect(this.fxDest);
  }

  _stopShareAudioMix() {
    for (const node of [this.shareAudioSrc, this.shareAudioGain]) {
      if (node) {
        try {
          node.disconnect();
        } catch {}
      }
    }
    this.shareAudioSrc = null;
    this.shareAudioGain = null;
  }

  // Camera rides the exact same transceiver as screen share — one outgoing
  // video track per person, so you're either on camera or sharing a screen,
  // never both. That keeps the receiving side unambiguous.
  async startCamera() {
    if (!this.connected || this.shareStream) return;
    try {
      this.shareStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch {
      this.h.onError("Camera blocked — check browser permissions.");
      return;
    }
    this.shareKind = "camera";
    const track = this.shareStream.getVideoTracks()[0];
    track.onended = () => this.stopShare();
    for (const peer of this.peers.values()) this._attachShare(peer);
    this._sendVoiceState();
  }

  _attachShare(peer) {
    if (!this.shareStream) return;
    const track = this.shareStream.getVideoTracks()[0];
    if (!track || peer.videoSender) return;
    peer.videoSender = peer.pc.addTrack(track, this.shareStream);
    // Adding a sender changes the room's peer count, so rebalance everyone's
    // slice of the budget rather than just capping this one.
    this._rebalanceShareBitrate();
  }

  // peers.size is exactly the fan-out of the share: one independent encode
  // per connected peer. Floors at 1 so a cap still applies before any peer
  // has connected (harmless — _attachShare only runs once one has).
  _shareVideoKbps() {
    const perPeer = SHARE_VIDEO_BUDGET_KBPS / Math.max(1, this.peers.size);
    return Math.max(SHARE_VIDEO_MIN_KBPS, Math.min(SHARE_VIDEO_MAX_KBPS, perPeer));
  }

  /**
   * Re-applies the current bitrate budget to every live screen-share sender.
   * Called whenever the peer count could have moved — join, leave, or a
   * fresh reconnect — so the cap always reflects the room as it is now, not
   * as it was when the share started.
   */
  _rebalanceShareBitrate() {
    if (!this.shareStream) return;
    const kbps = this._shareVideoKbps();
    for (const peer of this.peers.values()) {
      if (peer.videoSender) applyVideoSenderParams(peer.videoSender, kbps).catch(() => {});
    }
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
    this._stopShareAudioMix(); // unwire before the tracks die, not after
    for (const t of this.shareStream.getTracks()) t.stop();
    this.shareStream = null;
    this.shareKind = null;
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
      // Mentions and DMs get their own, more insistent three-note figure so
      // you can tell "someone said something" from "someone said YOUR NAME".
      mention: [
        [1046, 0, 0.09],
        [1318, 0.1, 0.09],
        [1568, 0.2, 0.22],
      ],
    }[name];
    if (!notes) return;
    const loud = name === "mention" ? 0.3 : 0.12;
    const t0 = this.ctx.currentTime;
    for (const [freq, start, dur] of notes) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + start);
      g.gain.exponentialRampToValueAtTime(loud, t0 + start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(g);
      g.connect(this.ctx.destination); // cues bypass deafen master gain
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.05);
    }
  }
}
