"use strict";

// Log whole objects instead of giving up after two levels of nesting
require("util").inspect.defaultOptions.depth = null;

const CONFIG = require("./config");
const Express = require("express");
const Fs = require("fs");
const Https = require("https");
const KurentoClient = require("kurento-client");
const SocketServer = require("socket.io");

// Promisify some Kurento API methods that are still callback-based
const Util = require("util");
const MediaElement = require("kurento-client-core").abstracts.MediaElement;
MediaElement.prototype.connect = Util.promisify(MediaElement.prototype.connect);
const SdpEndpoint = require("kurento-client-core").abstracts.SdpEndpoint;
SdpEndpoint.prototype.processOffer = Util.promisify(
  SdpEndpoint.prototype.processOffer
);
const WebRtcEndpoint = require("kurento-client-elements").WebRtcEndpoint;
WebRtcEndpoint.prototype.gatherCandidates = Util.promisify(
  WebRtcEndpoint.prototype.gatherCandidates
);
WebRtcEndpoint.prototype.addIceCandidate = Util.promisify(
  WebRtcEndpoint.prototype.addIceCandidate
);

// ----------------------------------------------------------------------------

// Application state
// =================

const global = {
  server: {
    expressApp: null,
    https: null,
    socket: null,
    socketServer: null,
  },

  kurento: {
    client: null,
    pipeline: null,
    playerEndpoint: null,
  },

  sessions: new Map(), // "SessionId": Session
};

class Session {
  constructor(socket) {
    this.socket = socket;
    this.consumerData = {
      webrtcEndpoint: null,
      pendingCandidates: [],
    };
  }
}

// ----------------------------------------------------------------------------

// HTTPS server
// ============
{
  const expressApp = Express();
  global.server.expressApp = expressApp;
  expressApp.use("/", Express.static(__dirname));

  const https = Https.createServer(
    {
      cert: Fs.readFileSync(CONFIG.https.cert),
      key: Fs.readFileSync(CONFIG.https.certKey),
    },
    expressApp
  );
  global.server.https = https;

  https.on("listening", () => {
    console.log(
      `Web server is listening on https://localhost:${CONFIG.https.port}`
    );
  });
  https.on("error", (err) => {
    console.error("HTTPS ERROR:", err.message);
  });
  https.on("tlsClientError", (err) => {
    if (err.message.includes("alert number 46")) {
      // Ignore: this is the client browser rejecting our self-signed certificate
    } else {
      console.error("TLS ERROR:", err);
    }
  });
  https.listen(CONFIG.https.port);
}

// ----------------------------------------------------------------------------

// WebSocket server
// ================
{
  const socketServer = SocketServer(global.server.https, {
    path: CONFIG.https.wsPath,
    serveClient: false,
    pingTimeout: CONFIG.https.wsPingTimeout,
    pingInterval: CONFIG.https.wsPingInterval,
    transports: ["websocket"],
  });
  global.server.socketServer = socketServer;

  socketServer.on("connect", (socket) => {
    console.log(
      "WebSocket server connected, port: %s",
      socket.request.connection.remotePort
    );
    global.server.socket = socket;

    socket.on("CLIENT_START_PUBLISH", async () => {
      await handleStartPublish();
    });
    socket.on("CLIENT_SDP_OFFER", async (sdpOffer) => {
      await handleSdpOffer(socket, sdpOffer);
    });
    socket.on("CLIENT_ICE_CANDIDATE", async (candidate) => {
      await handleIceCandidate(socket, candidate);
    });
    socket.on("CLIENT_DEBUG_DOT", async () => {
      await handleDebugDot();
    });
  });
}

// ----------------------------------------------------------------------------

// Kurento Media Server
// ====================
{
  const kurentoUrl = `ws://${CONFIG.kurento.ip}:${CONFIG.kurento.port}${CONFIG.kurento.wsPath}`;

  console.log("Connect with Kurento Media Server:", kurentoUrl);

  const client = new KurentoClient(kurentoUrl, (err) => {
    if (err) {
      console.error("Exit: Kurento Media Server not listening");
      process.exit(1);
    }

    global.kurento.client = client;
    console.log("Kurento client connected");
  });
}

// ----------------------------------------------------------------------------

async function handleStartPublish() {
  const client = global.kurento.client;

  let pipeline;
  try {
    pipeline = await client.create("MediaPipeline");
  } catch (err) {
    return console.error("Promise ERROR:", err);
  }
  global.kurento.pipeline = pipeline;
  console.log("Kurento pipeline created");

  let playerEndpoint;
  try {
    playerEndpoint = await pipeline.create("PlayerEndpoint", {
      // uri: "http://files.openvidu.io/video/format/sintel.webm",
      uri: "http://files.openvidu.io/video/format/fiware-ppp.webm",
      // uri: "rtsp://192.168.1.2:553/stream",

      useEncodedMedia: false,
      //useEncodedMedia: true
    });
  } catch (err) {
    return console.error("Promise ERROR:", err);
  }
  global.kurento.playerEndpoint = playerEndpoint;
  console.log("Kurento PlayerEndpoint created");

  playerEndpoint.on("Error", (event) => {
    console.error("PlayerEndpoint ERROR:", event);
  });

  try {
    await playerEndpoint.play();
  } catch (err) {
    return console.error("Promise ERROR:", err);
  }
}

// ----------------------------------------------------------------------------

async function handleSdpOffer(socket, sdpOffer) {
  // Session handling
  const sessionId = socket.id;
  const pipeline = global.kurento.pipeline;

  let session;
  let webrtcEndpoint;

  if (global.sessions.has(sessionId)) {
    return console.warn("Skip adding session, already exists:", sessionId);
  }

  session = new Session(socket);
  global.sessions.set(sessionId, session);

  try {
    webrtcEndpoint = await pipeline.create("WebRtcEndpoint");
  } catch (err) {
    return console.error("Promise ERROR:", err);
  }
  session.consumerData.webrtcEndpoint = webrtcEndpoint;

  webrtcEndpoint.on("Error", (event) => {
    console.error("WebRtcEndpoint ERROR:", event);
  });

  webrtcEndpoint.on("IceCandidateFound", (event) => {
    const iceCandidate = KurentoClient.getComplexType("IceCandidate")(
      event.candidate
    );
    socket.emit("SERVER_ICE_CANDIDATE", iceCandidate);
  });

  // Connect to the publisher
  const playerEndpoint = global.kurento.playerEndpoint;
  if (!playerEndpoint) {
    return console.error("ERROR: Publisher endpoint doesn't exist");
  }

  try {
    await playerEndpoint.connect(webrtcEndpoint);
  } catch (err) {
    return console.error("Promise ERROR:", err);
  }

  // Start the WebRtcEndpoint
  console.log("SDP Offer from App to KMS:\n%s", sdpOffer);

  let sdpAnswer;
  try {
    sdpAnswer = await webrtcEndpoint.processOffer(sdpOffer);
  } catch (err) {
    return console.error("Promise ERROR:", err);
  }

  console.log("SDP Answer from KMS to App:\n%s", sdpAnswer);

  try {
    await webrtcEndpoint.gatherCandidates();
  } catch (err) {
    return console.error("Promise ERROR:", err);
  }

  // Add ICE candidates that might have been received asynchronously
  const pendingCandidates = session.consumerData.pendingCandidates;
  while (pendingCandidates.length) {
    const candidate = pendingCandidates.shift();
    await handleIceCandidate(socket, candidate);
  }

  socket.emit("SERVER_SDP_ANSWER", sdpAnswer);
}

// ----------------------------------------------------------------------------

async function handleIceCandidate(socket, candidate) {
  // Session handling
  const sessionId = socket.id;
  if (!global.sessions.has(sessionId)) {
    console.warn("Skip adding candidate, session doesn't exist:", sessionId);
    return;
  }
  const session = global.sessions.get(sessionId);

  if (session.consumerData.webrtcEndpoint) {
    const kmsCandidate = KurentoClient.getComplexType("IceCandidate")(
      candidate
    );
    try {
      await session.consumerData.webrtcEndpoint.addIceCandidate(kmsCandidate);
    } catch (err) {
      return console.error("Promise ERROR: {}, candidate: {}", err, candidate);
    }
  } else {
    session.consumerData.pendingCandidates.push(candidate);
  }
}

// ----------------------------------------------------------------------------

async function handleDebugDot() {
  let pipelineDot;
  try {
    pipelineDot = await global.kurento.pipeline.getGstreamerDot();
  } catch (err) {
    return console.error("Promise ERROR:", err);
  }
  Fs.writeFile("pipeline.dot", pipelineDot, (err) => {
    if (err) {
      return console.error("ERROR:", err);
    }
    console.log("Saved DOT file: pipeline.dot");
  });

  let playerDot;
  try {
    playerDot = await global.kurento.playerEndpoint.getElementGstreamerDot();
  } catch (err) {
    return console.error("Promise ERROR:", err);
  }
  Fs.writeFile("playerEndpoint.dot", playerDot, (err) => {
    if (err) {
      return console.error("ERROR:", err);
    }
    console.log("Saved DOT file: playerEndpoint.dot");
  });
}

// ----------------------------------------------------------------------------
