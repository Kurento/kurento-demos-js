"use strict";

const CONFIG = require("./config");
const KurentoUtils = require("kurento-utils");
const SdpTransform = require("sdp-transform");
const SocketClient = require("socket.io-client");

// ----------------------------------------------------------------------------

// Application state
// =================

const global = {
  server: {
    socket: null,
  },

  // WebRTC peer connection(s) with Kurento
  peer: null,
};

// ----------------------------------------------------------------------------

// HTML UI elements
// ================

const ui = {
  // <button>
  publish: document.getElementById("uiPublish"),
  consume: document.getElementById("uiConsume"),
  consumeVp8: document.getElementById("uiConsumeVp8"),
  consumeH264: document.getElementById("uiConsumeH264"),
  debugDot: document.getElementById("uiDebugDot"),

  // <video>
  video: document.getElementById("uiVideo"),
};

ui.publish.onclick = () => global.server.socket.emit("CLIENT_START_PUBLISH");
ui.consume.onclick = () => startConsumer("");
ui.consumeVp8.onclick = () => startConsumer("VP8");
ui.consumeH264.onclick = () => startConsumer("H264");
ui.debugDot.onclick = () => global.server.socket.emit("CLIENT_DEBUG_DOT");

// ----------------------------------------------------------------------------

window.addEventListener("load", function () {
  console.log("Page load, connect WebSocket");
  connectSocket();

  if ("adapter" in window) {
    console.log(
      // eslint-disable-next-line no-undef
      `webrtc-adapter loaded, browser: '${adapter.browserDetails.browser}', version: '${adapter.browserDetails.version}'`
    );
  } else {
    console.warn("webrtc-adapter is not loaded! an install or config issue?");
  }
});

window.addEventListener("beforeunload", function () {
  console.log("Page unload, close WebSocket");
  global.server.socket.close();
});

// ----

function connectSocket() {
  const serverUrl = `https://${window.location.host}`;

  console.log("Connect with Application Server:", serverUrl);

  const socket = SocketClient(serverUrl, {
    path: CONFIG.https.wsPath,
    transports: ["websocket"],
  });
  global.server.socket = socket;

  socket.on("connect", () => {
    console.log("WebSocket connected");
  });

  socket.on("error", (err) => {
    console.error("WebSocket error:", err);
  });

  socket.on("SERVER_ICE_CANDIDATE", (candidate) => {
    console.log("SERVER_ICE_CANDIDATE, candidate:", candidate);
    global.peer.addIceCandidate(candidate);
  });

  socket.on("SERVER_SDP_ANSWER", (sdpAnswer) => {
    console.log("SERVER_SDP_ANSWER, sdpAnswer:", sdpAnswer);
    global.peer.processAnswer(sdpAnswer, (err) => {
      if (err) {
        return console.error("ERROR:", err);
      }

      startVideo(ui.video);
    });
  });
}

// ----------------------------------------------------------------------------

function startConsumer(codecName) {
  if (global.peer) {
    console.warn("Skip: Consumer already exists");
    return;
  }

  const options = {
    localVideo: null,
    remoteVideo: ui.video,
    mediaConstraints: { audio: false, video: true },
    onicecandidate: (candidate) => {
      const socket = global.server.socket;
      socket.emit("CLIENT_ICE_CANDIDATE", candidate);
    },
  };

  const consumer = new KurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(
    options,
    (err) => {
      if (err) {
        return console.error("ERROR:", err);
      }

      consumer.generateOffer((err, sdpOffer) => {
        if (err) {
          return console.error("ERROR:", err);
        }

        if (codecName === "H264") {
          sdpOffer = sdpRemoveCodec(sdpOffer, "VP8");
        } else if (codecName === "VP8") {
          sdpOffer = sdpRemoveCodec(sdpOffer, "H264");
        }

        const socket = global.server.socket;
        socket.emit("CLIENT_SDP_OFFER", sdpOffer);
      });
    }
  );
  global.peer = consumer;
}

// ----

function sdpRemoveCodec(sdp, codecName) {
  const sdpObj = SdpTransform.parse(sdp);

  //console.log("OLD sdpObj:\n%s", JSON.stringify(sdpObj, null, 2));

  const videoMedia = sdpObj.media.find((media) => media["type"] == "video");

  // Get all "rtpmap" entries for the given codec
  const codecmaps = videoMedia.rtp.filter((cmap) => cmap.codec === codecName);
  if (!codecmaps.length) {
    // Nothing to do: "codecName" is not present in the given SDP
    return sdp;
  }

  // Get the PayloadType(s) of the codec, and remove them from all arrays
  codecmaps.forEach((cmap) => {
    const payload = cmap.payload;

    videoMedia.rtp = videoMedia.rtp.filter((elem) => elem.payload != payload);

    videoMedia.fmtp = videoMedia.fmtp.filter((elem) => elem.payload != payload);

    videoMedia.rtcpFb = videoMedia.rtcpFb.filter(
      (elem) => elem.payload != payload
    );

    videoMedia.payloads = videoMedia.payloads
      .split(" ")
      .filter((str) => parseInt(str, 10) != payload)
      .join(" ");
  });

  //console.log("NEW sdpObj:\n%s", JSON.stringify(sdpObj, null, 2));

  return SdpTransform.write(sdpObj);
}

// ----------------------------------------------------------------------------

/* Start playback on the <video> HTML element.
 * Formerly the "autoplay" video tag attribute was used for this, but now has
 * been rendered unreliable and should be considered deprecated. Modern browsers
 * implement very restrictive policies to limit autoplay, so it is better to
 * write code for it and be able to catch the possible errors that might occur.
 * Ref: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video
 */
function startVideo(videoTag) {
  console.log("Calling video.play() now");
  videoTag.play().catch((err) => {
    if (err.name === "NotAllowedError") {
      return console.error("[start] Browser doesn't allow playing video: " + err);
    } else {
      return console.error("[start] Error in video.play(): " + err);
    }
  });
}

// ----------------------------------------------------------------------------
