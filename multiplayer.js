/**
 * P2P turn-based multiplayer — PeerJS data channel + host-authoritative match state.
 * Messages are small JSON; Digita physics stay local per turn.
 */
(function (global) {
  var PREFIX = "coke-pvp-";
  var CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var SHOTS_EACH_DEFAULT = 5;

  function genCode(len) {
    len = len || 4;
    var out = "";
    var bytes = new Uint8Array(len);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < len; i++) bytes[i] = (Math.random() * 256) | 0;
    }
    for (var j = 0; j < len; j++) out += CODE_CHARS[bytes[j] % CODE_CHARS.length];
    return out;
  }

  function peerIdFromCode(code) {
    return PREFIX + String(code || "").toUpperCase();
  }

  function emptyPlayer() {
    return { goals: 0, attempts: [], shotCount: 0 };
  }

  function cleanName(name, fallback) {
    var n = String(name || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 16);
    return n || fallback || "Player";
  }

  /**
   * @param {object} hooks
   * @param {function} hooks.onStatus
   * @param {function} hooks.onMatchStart
   * @param {function} hooks.onTurn
   * @param {function} hooks.onShotResult
   * @param {function} hooks.onMatchEnd
   * @param {function} hooks.onPeerLeft
   * @param {function} hooks.onError
   * @param {function} [hooks.onRematch]
   * @param {function} [hooks.onNames]
   * @param {function} [hooks.onSpectateStream]
   * @param {function} [hooks.onSpectateEnded]
   * @param {function} [hooks.onSpectateError]
   */
  function MatchSession(hooks) {
    this.hooks = hooks || {};
    this.peer = null;
    this.conn = null;
    this.role = null; // "host" | "guest"
    this.roomCode = null;
    this.localId = null;
    this.remoteId = null;
    this.localName = "Player";
    this.names = { host: "Host", guest: "Guest" };
    this.shotsEach = SHOTS_EACH_DEFAULT;
    this.seed = 0;
    this.players = { host: emptyPlayer(), guest: emptyPlayer() };
    this.turnRole = null;
    this.roundIndex = 0; // 0-based shared shot index within regulation / SD
    this.phase = "idle"; // idle|lobby|connecting|ready|playing|suddenDeath|ended
    this.seenShots = {};
    this._destroyed = false;
    this.mediaCall = null;
    this._localSpectateStream = null;
    this._spectateProfile = null;
    this._adaptTimer = null;
    this._adaptBitrate = 0;
    this._adaptStats = null;
  }

  MatchSession.prototype._emit = function (name, payload) {
    var fn = this.hooks[name];
    if (typeof fn === "function") fn(payload);
  };

  MatchSession.prototype._status = function (text) {
    this._emit("onStatus", { text: text, phase: this.phase, role: this.role, roomCode: this.roomCode });
  };

  MatchSession.prototype.send = function (type, data) {
    if (!this.conn || !this.conn.open) return false;
    try {
      this.conn.send({ v: 1, type: type, data: data || {}, ts: Date.now() });
      return true;
    } catch (e) {
      return false;
    }
  };

  MatchSession.prototype._bindConn = function (conn) {
    var self = this;
    this.conn = conn;
    if (conn && conn.peer) this.remoteId = conn.peer;
    conn.on("open", function () {
      if (conn.peer) self.remoteId = conn.peer;
      self._status("Connected");
      self.send("hello", { role: self.role, peerId: self.localId, name: self.localName });
      if (self.role === "guest") {
        self.send("ready", { peerId: self.localId, name: self.localName });
      }
    });
    conn.on("data", function (raw) {
      self._onData(raw);
    });
    conn.on("close", function () {
      if (self._destroyed) return;
      self.stopSpectateMedia();
      self.phase = "ended";
      self._emit("onPeerLeft", {});
      self._status("Opponent disconnected");
    });
    conn.on("error", function (err) {
      self._emit("onError", { message: (err && err.message) || "Connection error" });
    });
  };

  MatchSession.prototype._bindPeerMedia = function () {
    var self = this;
    if (!this.peer || this.peer.__spectateBound) return;
    this.peer.__spectateBound = true;
    this.peer.on("call", function (call) {
      if (self._destroyed) {
        try {
          call.close();
        } catch (e) {}
        return;
      }
      // Close previous call without racing the new assignment
      var prev = self.mediaCall;
      self.mediaCall = call;
      if (prev && prev !== call) {
        try {
          prev.close();
        } catch (e2) {}
      }
      self._stopLocalTracks();
      try {
        call.answer();
      } catch (err) {
        self._emit("onSpectateError", { message: (err && err.message) || "Could not answer spectate call" });
        if (self.mediaCall === call) self._cleanupMediaCall(false);
        return;
      }
      call.on("stream", function (remoteStream) {
        if (self._destroyed || self.mediaCall !== call) return;
        self._emit("onSpectateStream", { stream: remoteStream });
      });
      call.on("close", function () {
        if (self.mediaCall !== call) return;
        self._emit("onSpectateEnded", {});
        self._cleanupMediaCall(false);
      });
      call.on("error", function (err) {
        if (self.mediaCall !== call) return;
        self._emit("onSpectateError", { message: (err && err.message) || "Spectate stream error" });
        self._emit("onSpectateEnded", {});
        self._cleanupMediaCall(false);
      });
    });
  };

  MatchSession.prototype._stopLocalTracks = function () {
    if (!this._localSpectateStream) return;
    try {
      var stopRelay = this._localSpectateStream.__spectateStop;
      if (typeof stopRelay === "function") {
        try {
          stopRelay();
        } catch (e0) {}
      }
      this._localSpectateStream.getTracks().forEach(function (t) {
        try {
          t.stop();
        } catch (e) {}
      });
    } catch (e2) {}
    this._localSpectateStream = null;
  };

  MatchSession.prototype._clearAdaptLoop = function () {
    if (this._adaptTimer) {
      window.clearInterval(this._adaptTimer);
      this._adaptTimer = null;
    }
    this._adaptStats = null;
  };

  MatchSession.prototype._cleanupMediaCall = function (stopTracks) {
    this._clearAdaptLoop();
    var call = this.mediaCall;
    this.mediaCall = null;
    if (call) {
      try {
        call.close();
      } catch (e) {}
    }
    if (stopTracks) this._stopLocalTracks();
  };

  /** Spectator: tell shooter we are ready to receive a media call. */
  MatchSession.prototype.notifySpectateReady = function () {
    return this.send("spectateReady", { role: this.role });
  };

  /**
   * Shooter: broadcast canvas MediaStream to opponent.
   * @param {MediaStream} stream
   * @param {{delayMs?: number, profile?: object}} [opts]
   */
  MatchSession.prototype.startSpectateBroadcast = function (stream, opts) {
    if (!stream) {
      this._emit("onSpectateError", { message: "No canvas stream" });
      return false;
    }
    opts = opts || {};
    var self = this;
    var delayMs = typeof opts.delayMs === "number" ? opts.delayMs : 0;
    var profile = opts.profile || null;
    this._spectateProfile = profile;
    this._adaptBitrate = profile && typeof profile.maxBitrate === "number" ? profile.maxBitrate : 0;
    this._adaptStats = null;

    function placeCall() {
      if (self._destroyed || !self.peer) {
        try {
          stream.getTracks().forEach(function (t) {
            t.stop();
          });
        } catch (e) {}
        self._emit("onSpectateError", { message: "Peer not ready" });
        return false;
      }
      // Hang up any prior call, then wait a beat so PeerJS can free the slot
      self._cleanupMediaCall(true);

      var remoteId = self.remoteId;
      if (!remoteId && self.role === "guest" && self.roomCode) {
        remoteId = peerIdFromCode(self.roomCode);
        self.remoteId = remoteId;
      }
      if (!remoteId) {
        try {
          stream.getTracks().forEach(function (t) {
            t.stop();
          });
        } catch (e2) {}
        self._emit("onSpectateError", { message: "Opponent peer id unknown" });
        return false;
      }

      try {
        var call = self.peer.call(remoteId, stream);
        if (!call) {
          try {
            stream.getTracks().forEach(function (t) {
              t.stop();
            });
          } catch (e3) {}
          self._emit("onSpectateError", { message: "Spectate call failed" });
          return false;
        }
        self.mediaCall = call;
        self._localSpectateStream = stream;
        try {
          stream.getVideoTracks().forEach(function (track) {
            if ("contentHint" in track) track.contentHint = "motion";
          });
        } catch (hintErr) {}
        // Apply cellular-friendly encode caps once PC is ready
        window.setTimeout(function () {
          if (self.mediaCall !== call) return;
          self._tuneCallEncoding(call, profile);
        }, 180);
        window.setTimeout(function () {
          if (self.mediaCall !== call) return;
          self._tuneCallEncoding(call, profile);
          self._startAdaptLoop(call, profile);
        }, 700);
        call.on("close", function () {
          if (self.mediaCall !== call) return;
          self._cleanupMediaCall(true);
        });
        call.on("error", function (err) {
          if (self.mediaCall !== call) return;
          self._emit("onSpectateError", { message: (err && err.message) || "Spectate call error" });
          self._cleanupMediaCall(true);
        });
        return true;
      } catch (err) {
        try {
          stream.getTracks().forEach(function (t) {
            t.stop();
          });
        } catch (e4) {}
        self._emit("onSpectateError", { message: (err && err.message) || "Spectate call failed" });
        return false;
      }
    }

    if (delayMs > 0) {
      window.setTimeout(placeCall, delayMs);
      return true;
    }
    return placeCall();
  };

  /** End outgoing or incoming spectate media. */
  MatchSession.prototype.stopSpectateMedia = function () {
    this._cleanupMediaCall(true);
  };

  MatchSession.prototype._peerConnection = function (call) {
    return call && (call.peerConnection || call._pc || (call.provider && call.provider._pc));
  };

  /**
   * Prefer smooth playback over sharp frames — critical on cellular.
   * @param {*} call
   * @param {{maxBitrate?: number, maxFramerate?: number, scaleResolutionDownBy?: number}|null} profile
   */
  MatchSession.prototype._tuneCallEncoding = function (call, profile) {
    profile = profile || {};
    var maxBitrate = typeof profile.maxBitrate === "number" ? profile.maxBitrate : 450000;
    var maxFramerate = typeof profile.maxFramerate === "number" ? profile.maxFramerate : 15;
    var scale = typeof profile.scaleResolutionDownBy === "number" ? profile.scaleResolutionDownBy : 1;
    if (this._adaptBitrate > 0) maxBitrate = this._adaptBitrate;
    else this._adaptBitrate = maxBitrate;

    try {
      var pc = this._peerConnection(call);
      if (!pc || typeof pc.getSenders !== "function") return;
      pc.getSenders().forEach(function (sender) {
        if (!sender.track || sender.track.kind !== "video") return;
        try {
          if ("contentHint" in sender.track) sender.track.contentHint = "motion";
        } catch (e) {}
        if (typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function") {
          return;
        }
        var params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) {
          params.encodings = [{}];
        }
        params.encodings.forEach(function (enc) {
          enc.maxBitrate = maxBitrate;
          enc.maxFramerate = maxFramerate;
          if ("scaleResolutionDownBy" in enc) enc.scaleResolutionDownBy = Math.max(1, scale);
          if ("priority" in enc) enc.priority = "medium";
          if ("networkPriority" in enc) enc.networkPriority = "medium";
        });
        // Drop resolution/quality before freezing frames on a congested link
        if ("degradationPreference" in params) {
          params.degradationPreference = "maintain-framerate";
        }
        sender.setParameters(params).catch(function () {});
      });
    } catch (err) {}
  };

  /** Watch outbound RTP and step bitrate down (or slightly up) for the live link. */
  MatchSession.prototype._startAdaptLoop = function (call, profile) {
    var self = this;
    this._clearAdaptLoop();
    profile = profile || {};
    var floor = typeof profile.minBitrate === "number" ? profile.minBitrate : 120000;
    var ceiling = typeof profile.maxBitrate === "number" ? profile.maxBitrate : 450000;
    if (!this._adaptBitrate) this._adaptBitrate = ceiling;

    this._adaptTimer = window.setInterval(function () {
      if (self._destroyed || self.mediaCall !== call) {
        self._clearAdaptLoop();
        return;
      }
      var pc = self._peerConnection(call);
      if (!pc || typeof pc.getStats !== "function") return;
      pc.getStats()
        .then(function (report) {
          var outbound = null;
          var candidate = null;
          report.forEach(function (stat) {
            if (stat.type === "outbound-rtp" && (!stat.kind || stat.kind === "video") && !stat.isRemote) {
              outbound = stat;
            }
            if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated) {
              candidate = stat;
            }
          });
          if (!outbound) return;

          var prev = self._adaptStats;
          self._adaptStats = {
            packetsLost: outbound.packetsLost || 0,
            packetsSent: outbound.packetsSent || 0,
            framesEncoded: outbound.framesEncoded || 0,
            bytesSent: outbound.bytesSent || 0,
            rtt: candidate && typeof candidate.currentRoundTripTime === "number" ? candidate.currentRoundTripTime : null,
            ts: Date.now(),
          };
          if (!prev) return;

          var dt = Math.max(0.5, (self._adaptStats.ts - prev.ts) / 1000);
          var lostDelta = Math.max(0, self._adaptStats.packetsLost - prev.packetsLost);
          var sentDelta = Math.max(0, self._adaptStats.packetsSent - prev.packetsSent);
          var lossRatio = sentDelta > 0 ? lostDelta / sentDelta : lostDelta > 0 ? 1 : 0;
          var framesDelta = Math.max(0, self._adaptStats.framesEncoded - prev.framesEncoded);
          var rtt = self._adaptStats.rtt;
          var next = self._adaptBitrate;
          var congested =
            lossRatio > 0.04 ||
            lostDelta >= 8 ||
            (rtt != null && rtt > 0.45) ||
            (framesDelta === 0 && sentDelta > 0);

          if (congested) {
            next = Math.max(floor, Math.floor(next * 0.72));
          } else if (lossRatio < 0.01 && (rtt == null || rtt < 0.25) && framesDelta > 0) {
            next = Math.min(ceiling, Math.floor(next * 1.08 + 8000));
          }

          if (Math.abs(next - self._adaptBitrate) >= 12000) {
            self._adaptBitrate = next;
            self._tuneCallEncoding(call, profile);
          }
        })
        .catch(function () {});
    }, 1800);
  };

  MatchSession.prototype._onData = function (raw) {
    if (!raw || typeof raw !== "object") return;
    var type = raw.type;
    var data = raw.data || {};

    if (type === "hello") {
      this.remoteId = data.peerId || this.remoteId;
      if (data.name) {
        var theirRole = data.role === "host" || data.role === "guest" ? data.role : this.role === "host" ? "guest" : "host";
        this.names[theirRole] = cleanName(data.name, theirRole === "host" ? "Host" : "Guest");
        this._emit("onNames", { names: this.names, role: this.role });
      }
      if (this.role === "host" && this.phase === "connecting") {
        this._startMatchAsHost();
      }
      return;
    }

    if (type === "ready") {
      this.remoteId = data.peerId || this.remoteId;
      if (data.name) {
        this.names.guest = cleanName(data.name, "Guest");
        this._emit("onNames", { names: this.names, role: this.role });
      }
      if (this.role === "host" && (this.phase === "connecting" || this.phase === "ready")) {
        this._startMatchAsHost();
      }
      return;
    }

    if (type === "matchStart") {
      if (this.role !== "guest") return;
      this._applyMatchStart(data);
      return;
    }

    if (type === "turn") {
      this.turnRole = data.playerId;
      this.roundIndex = typeof data.shotIndex === "number" ? data.shotIndex : this.roundIndex;
      this.phase = data.suddenDeath ? "suddenDeath" : "playing";
      this._emit("onTurn", this._turnPayload());
      return;
    }

    if (type === "shotResult") {
      this._applyShotResult(data, false);
      return;
    }

    if (type === "matchEnd") {
      this.phase = "ended";
      this._emit("onMatchEnd", data);
      return;
    }

    if (type === "rematch") {
      if (this.role === "host") {
        this._resetForRematch();
        this._startMatchAsHost();
      } else {
        this._emit("onRematch", {});
      }
      return;
    }

    if (type === "peerLeft") {
      this.phase = "ended";
      this._emit("onPeerLeft", {});
      return;
    }

    if (type === "spectateReady") {
      this._emit("onSpectateReady", data || {});
      return;
    }
  };

  MatchSession.prototype._turnPayload = function () {
    return {
      playerId: this.turnRole,
      shotIndex: this.roundIndex,
      isLocalTurn: this.turnRole === this.role,
      suddenDeath: this.phase === "suddenDeath",
      players: {
        host: { goals: this.players.host.goals, attempts: this.players.host.attempts.slice(), shotCount: this.players.host.shotCount },
        guest: { goals: this.players.guest.goals, attempts: this.players.guest.attempts.slice(), shotCount: this.players.guest.shotCount },
      },
      names: { host: this.names.host, guest: this.names.guest },
      shotsEach: this.shotsEach,
      role: this.role,
    };
  };

  MatchSession.prototype._applyMatchStart = function (data) {
    this.shotsEach = data.shotsEach || SHOTS_EACH_DEFAULT;
    this.seed = data.seed || 0;
    this.players = { host: emptyPlayer(), guest: emptyPlayer() };
    this.seenShots = {};
    this.roundIndex = 0;
    this.turnRole = data.hostId === "host" || !data.firstTurn ? "host" : data.firstTurn;
    if (data.firstTurn) this.turnRole = data.firstTurn;
    if (data.names) {
      this.names.host = cleanName(data.names.host, "Host");
      this.names.guest = cleanName(data.names.guest, "Guest");
    }
    this.phase = "playing";
    this._emit("onMatchStart", {
      shotsEach: this.shotsEach,
      seed: this.seed,
      role: this.role,
      roomCode: this.roomCode,
      names: { host: this.names.host, guest: this.names.guest },
    });
    // Guest waits for host `turn` message so we don't double-start a round
  };

  MatchSession.prototype._startMatchAsHost = function () {
    if (this.role !== "host") return;
    if (this.phase === "playing" || this.phase === "suddenDeath") return;
    this.phase = "ready";
    this.shotsEach = this.shotsEach || SHOTS_EACH_DEFAULT;
    this.seed = (Date.now() ^ ((Math.random() * 0x7fffffff) | 0)) >>> 0;
    this.players = { host: emptyPlayer(), guest: emptyPlayer() };
    this.seenShots = {};
    this.roundIndex = 0;
    this.turnRole = "host";
    this.phase = "playing";
    this.names.host = this.localName;
    var payload = {
      shotsEach: this.shotsEach,
      seed: this.seed,
      hostId: "host",
      firstTurn: "host",
      names: { host: this.names.host, guest: this.names.guest },
    };
    this.send("matchStart", payload);
    this._emit("onMatchStart", {
      shotsEach: this.shotsEach,
      seed: this.seed,
      role: this.role,
      roomCode: this.roomCode,
      names: { host: this.names.host, guest: this.names.guest },
    });
    this.send("turn", { playerId: "host", shotIndex: 0, suddenDeath: false });
    this._emit("onTurn", this._turnPayload());
  };

  MatchSession.prototype._shotKey = function (playerId, shotIndex, suddenDeath) {
    return playerId + ":" + shotIndex + ":" + (suddenDeath ? "sd" : "reg");
  };

  MatchSession.prototype._applyShotResult = function (data, fromLocal) {
    var playerId = data.playerId;
    if (playerId !== "host" && playerId !== "guest") return;
    if (this.phase !== "playing" && this.phase !== "suddenDeath") return;

    // Host validates turn; guests accept host-forwarded or self-echo after host ack path
    if (this.role === "host") {
      if (playerId !== this.turnRole) return;
    }

    var sd = this.phase === "suddenDeath";
    var key = this._shotKey(playerId, data.shotIndex, sd);
    if (this.seenShots[key]) return;
    this.seenShots[key] = true;

    var pl = this.players[playerId];
    var outcome = data.outcome === "goal" ? "goal" : "miss";
    pl.attempts.push(outcome);
    pl.shotCount = pl.attempts.length;
    if (outcome === "goal") pl.goals += 1;

    var resultPayload = {
      playerId: playerId,
      shotIndex: data.shotIndex,
      outcome: outcome,
      goals: pl.goals,
      attempts: pl.attempts.slice(),
      suddenDeath: sd,
      players: {
        host: { goals: this.players.host.goals, attempts: this.players.host.attempts.slice(), shotCount: this.players.host.shotCount },
        guest: { goals: this.players.guest.goals, attempts: this.players.guest.attempts.slice(), shotCount: this.players.guest.shotCount },
      },
    };

    if (this.role === "host" && fromLocal) {
      this.send("shotResult", resultPayload);
    } else if (this.role === "host" && !fromLocal) {
      // Re-broadcast canonical result to guest (guest already knows own shot; keeps state aligned)
      this.send("shotResult", resultPayload);
    } else if (this.role === "guest" && fromLocal) {
      this.send("shotResult", {
        playerId: playerId,
        shotIndex: data.shotIndex,
        outcome: outcome,
        goals: pl.goals,
        attempts: pl.attempts.slice(),
      });
      // Wait for host echo / turn advance — still emit locally for UI responsiveness
    }

    this._emit("onShotResult", resultPayload);

    if (this.role === "host") {
      this._advanceAfterShot();
    }
  };

  MatchSession.prototype.reportLocalShot = function (outcome) {
    if (this.turnRole !== this.role) return false;
    if (this.phase !== "playing" && this.phase !== "suddenDeath") return false;
    var shotIndex = this.players[this.role].shotCount;
    this._applyShotResult(
      {
        playerId: this.role,
        shotIndex: shotIndex,
        outcome: outcome === "goal" ? "goal" : "miss",
      },
      true
    );
    return true;
  };

  MatchSession.prototype._regulationDone = function () {
    return (
      this.players.host.shotCount >= this.shotsEach &&
      this.players.guest.shotCount >= this.shotsEach
    );
  };

  MatchSession.prototype._suddenDeathPairDone = function () {
    // In SD, each "round" both have taken the same number of SD shots beyond regulation
    var h = this.players.host.shotCount - this.shotsEach;
    var g = this.players.guest.shotCount - this.shotsEach;
    return h > 0 && g > 0 && h === g;
  };

  MatchSession.prototype._advanceAfterShot = function () {
    if (this.role !== "host") return;

    if (this.phase === "playing") {
      if (this.turnRole === "host") {
        this.turnRole = "guest";
      } else {
        this.turnRole = "host";
        this.roundIndex += 1;
      }

      if (this._regulationDone()) {
        if (this.players.host.goals === this.players.guest.goals) {
          this.phase = "suddenDeath";
          this.turnRole = "host";
          this.roundIndex = 0;
          this.send("turn", { playerId: "host", shotIndex: 0, suddenDeath: true });
          this._emit("onTurn", this._turnPayload());
          return;
        }
        this._endMatch();
        return;
      }

      this.send("turn", {
        playerId: this.turnRole,
        shotIndex: this.players[this.turnRole].shotCount,
        suddenDeath: false,
      });
      this._emit("onTurn", this._turnPayload());
      return;
    }

    if (this.phase === "suddenDeath") {
      if (this.turnRole === "host") {
        this.turnRole = "guest";
        this.send("turn", {
          playerId: "guest",
          shotIndex: this.players.guest.shotCount,
          suddenDeath: true,
        });
        this._emit("onTurn", this._turnPayload());
        return;
      }

      // Both have taken this SD round
      var hExtra = this.players.host.attempts.slice(this.shotsEach);
      var gExtra = this.players.guest.attempts.slice(this.shotsEach);
      var n = Math.min(hExtra.length, gExtra.length);
      if (n > 0) {
        var hi = hExtra[n - 1];
        var gi = gExtra[n - 1];
        if (hi !== gi) {
          this._endMatch();
          return;
        }
      }

      this.turnRole = "host";
      this.roundIndex += 1;
      this.send("turn", {
        playerId: "host",
        shotIndex: this.players.host.shotCount,
        suddenDeath: true,
      });
      this._emit("onTurn", this._turnPayload());
    }
  };

  MatchSession.prototype._endMatch = function () {
    var hg = this.players.host.goals;
    var gg = this.players.guest.goals;
    var winnerId = hg === gg ? null : hg > gg ? "host" : "guest";
    var payload = {
      scores: {
        host: { goals: hg, attempts: this.players.host.attempts.slice() },
        guest: { goals: gg, attempts: this.players.guest.attempts.slice() },
      },
      winnerId: winnerId,
      shotsEach: this.shotsEach,
    };
    this.phase = "ended";
    this.send("matchEnd", payload);
    this._emit("onMatchEnd", payload);
  };

  MatchSession.prototype._resetForRematch = function () {
    this.players = { host: emptyPlayer(), guest: emptyPlayer() };
    this.seenShots = {};
    this.roundIndex = 0;
    this.turnRole = null;
    this.phase = "ready";
  };

    MatchSession.prototype.requestRematch = function () {
      if (this.role === "host") {
        this._resetForRematch();
        this.send("rematch", {});
        this._startMatchAsHost();
      } else {
        this.send("rematch", {});
      }
    };

  MatchSession.prototype.createRoom = function (shotsEach, displayName) {
    var self = this;
    this.destroy();
    this._destroyed = false;
    this.role = "host";
    this.localName = cleanName(displayName, "Host");
    this.names = { host: this.localName, guest: "Guest" };
    this.shotsEach = shotsEach || SHOTS_EACH_DEFAULT;
    this.roomCode = genCode(4);
    this.localId = peerIdFromCode(this.roomCode);
    this.phase = "lobby";
    this._status("Creating room…");

    return new Promise(function (resolve, reject) {
      if (typeof global.Peer !== "function") {
        reject(new Error("PeerJS not loaded"));
        return;
      }
      self.peer = new global.Peer(self.localId, { debug: 0 });
      self.peer.on("open", function () {
        self.phase = "connecting";
        self._status("Room " + self.roomCode + " — waiting for opponent…");
        self._bindPeerMedia();
        resolve({ roomCode: self.roomCode, role: "host" });
      });
      self.peer.on("connection", function (conn) {
        if (self.conn && self.conn.open) {
          try {
            conn.close();
          } catch (e) {}
          return;
        }
        self.remoteId = conn.peer || self.remoteId;
        self._bindConn(conn);
      });
      self.peer.on("error", function (err) {
        var msg = (err && err.message) || "Host peer error";
        self._emit("onError", { message: msg });
        reject(err);
      });
      self._bindPeerMedia();
    });
  };

  MatchSession.prototype.joinRoom = function (code, displayName) {
    var self = this;
    this.destroy();
    this._destroyed = false;
    this.role = "guest";
    this.localName = cleanName(displayName, "Guest");
    this.names = { host: "Host", guest: this.localName };
    this.roomCode = String(code || "")
      .trim()
      .toUpperCase();
    if (this.roomCode.length < 3) {
      return Promise.reject(new Error("Enter a valid room code"));
    }
    this.localId = peerIdFromCode(this.roomCode + "-g-" + genCode(3));
    this.remoteId = peerIdFromCode(this.roomCode);
    this.phase = "connecting";
    this._status("Joining " + this.roomCode + "…");

    return new Promise(function (resolve, reject) {
      if (typeof global.Peer !== "function") {
        reject(new Error("PeerJS not loaded"));
        return;
      }
      self.peer = new global.Peer(self.localId, { debug: 0 });
      self.peer.on("open", function () {
        self._bindPeerMedia();
        var conn = self.peer.connect(peerIdFromCode(self.roomCode), { reliable: true });
        self._bindConn(conn);
        resolve({ roomCode: self.roomCode, role: "guest" });
      });
      self.peer.on("error", function (err) {
        var msg = (err && err.message) || "Join failed";
        self._emit("onError", { message: msg });
        reject(err);
      });
      self._bindPeerMedia();
    });
  };

  MatchSession.prototype.isLocalTurn = function () {
    return this.turnRole === this.role && (this.phase === "playing" || this.phase === "suddenDeath");
  };

  MatchSession.prototype.getState = function () {
    return {
      role: this.role,
      roomCode: this.roomCode,
      phase: this.phase,
      turnRole: this.turnRole,
      shotsEach: this.shotsEach,
      players: {
        host: { goals: this.players.host.goals, attempts: this.players.host.attempts.slice(), shotCount: this.players.host.shotCount },
        guest: { goals: this.players.guest.goals, attempts: this.players.guest.attempts.slice(), shotCount: this.players.guest.shotCount },
      },
    };
  };

  MatchSession.prototype.destroy = function () {
    this._destroyed = true;
    this.stopSpectateMedia();
    try {
      if (this.conn) this.conn.close();
    } catch (e) {}
    try {
      if (this.peer) this.peer.destroy();
    } catch (e2) {}
    this.conn = null;
    this.peer = null;
    this.phase = "idle";
  };

  global.PvpMatch = {
    MatchSession: MatchSession,
    genCode: genCode,
    SHOTS_EACH_DEFAULT: SHOTS_EACH_DEFAULT,
  };
})(window);
