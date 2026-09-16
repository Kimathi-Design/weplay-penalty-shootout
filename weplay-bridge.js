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
      if (global.Weplay && typeof global.Weplay[event] === "function") {
        global.Weplay[event](msg.payload);
      }
    } catch (e2) {}
    if (global.location.search.indexOf("debug=1") !== -1) {
      console.log("[weplay-bridge]", event, msg.payload);
    }
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
  };
})(window);
