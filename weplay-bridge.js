/**
 * Weplay Arcade bridge — post score/events to the parent platform.
 * Payload shape: { source: "coke-penalty", event, payload }
 */
(function (global) {
  var GAME_ID = "coke-penalty-shootout";
  var SOURCE = "coke-penalty";

  function notify(event, payload) {
    var msg = {
      source: SOURCE,
      event: event,
      payload: payload || {},
    };
    try {
      if (global.parent && global.parent !== global) {
        global.parent.postMessage(msg, "*");
      }
    } catch (e) {}
    try {
      if (global.top && global.top !== global && global.top !== global.parent) {
        global.top.postMessage(msg, "*");
      }
    } catch (eTop) {}
    try {
      if (global.Weplay && typeof global.Weplay[event] === "function") {
        global.Weplay[event](msg.payload);
      }
    } catch (e2) {}
    if (global.location.search.indexOf("debug=1") !== -1) {
      console.log("[weplay-bridge]", event, msg.payload);
    }
  }

  function callLogoutApi() {
    try {
      if (global.Weplay && typeof global.Weplay.logout === "function") {
        global.Weplay.logout({ gameId: GAME_ID, ts: Date.now() });
        return;
      }
    } catch (e) {}
    try {
      var url =
        (global.Weplay && global.Weplay.logoutUrl) ||
        (global.__WEPLAY_LOGOUT_URL__) ||
        null;
      if (url && global.fetch) {
        global.fetch(String(url), {
          method: "POST",
          credentials: "include",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId: GAME_ID, ts: Date.now() }),
        }).catch(function () {});
      }
    } catch (e2) {}
  }

  global.WeplayBridge = {
    gameId: GAME_ID,
    gameStart: function () {
      notify("gameStart", { gameId: GAME_ID, ts: Date.now() });
    },
    scoreUpdate: function (score, maxScore) {
      notify("scoreUpdate", {
        gameId: GAME_ID,
        score: score,
        maxScore: maxScore,
        ts: Date.now(),
      });
    },
    gameComplete: function (score, maxScore, details) {
      notify("gameComplete", {
        gameId: GAME_ID,
        score: score,
        maxScore: maxScore,
        details: details || {},
        ts: Date.now(),
      });
    },
    playAgain: function () {
      notify("playAgain", { gameId: GAME_ID, ts: Date.now() });
    },
    pause: function () {
      notify("pause", { gameId: GAME_ID, ts: Date.now() });
    },
    resume: function () {
      notify("resume", { gameId: GAME_ID, ts: Date.now() });
    },
    exit: function () {
      notify("exit", { gameId: GAME_ID, ts: Date.now() });
      notify("close", { gameId: GAME_ID, ts: Date.now() });
    },
    logout: function () {
      notify("logout", { gameId: GAME_ID, ts: Date.now() });
      callLogoutApi();
    },
  };
})(window);
