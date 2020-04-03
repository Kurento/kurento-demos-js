"use strict";

const CONFIG = require("./config");
const Express = require("express");
const Fs = require("fs");
const Https = require("https");
const KurentoClient = require("kurento-client");
const SocketServer = require("socket.io");

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
      iceCandidatesQueue: [],
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
    console.error("HTTPS error:", err.message);
  });
  https.on("tlsClientError", (err) => {
    console.error("TLS error:", err.message);
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

    socket.on("CLIENT_START_PUBLISH", handleStartPublish);
    socket.on("CLIENT_SDP_OFFER", (sdpOffer) =>
      handleSdpOffer(socket, sdpOffer)
    );
    socket.on("CLIENT_ICE_CANDIDATE", (candidate) =>
      handleIceCandidate(socket, candidate)
    );
    socket.on("CLIENT_DEBUG_DOT", handleDebugDot);
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

  const pipeline = await client.create("MediaPipeline");
  global.kurento.pipeline = pipeline;
  console.log("Kurento pipeline created");

  const playerEndpoint = await pipeline.create("PlayerEndpoint", {
    // uri: "http://files.openvidu.io/video/format/sintel.webm",
    uri: "http://files.openvidu.io/video/format/fiware-ppp.webm",
    //uri: "rtsp://192.168.12.23:553/stream",

    useEncodedMedia: false,
    //useEncodedMedia: true
  });
  global.kurento.playerEndpoint = playerEndpoint;
  console.log("Kurento PlayerEndpoint created");

  playerEndpoint.play();
}

// ----------------------------------------------------------------------------

async function handleSdpOffer(socket, sdpOffer) {
  // Session handling
  const sessionId = socket.id;
  if (global.sessions.has(sessionId)) {
    console.warn("Skip adding session, already exists:", sessionId);
    return;
  }
  const session = new Session(socket);
  global.sessions.set(sessionId, session);

  console.log("SDP Offer from App to KMS:\n%s", sdpOffer);

  const pipeline = global.kurento.pipeline;

  const webrtcEndpoint = await pipeline.create("WebRtcEndpoint");
  session.consumerData.webrtcEndpoint = webrtcEndpoint;

  webrtcEndpoint.on("IceCandidateFound", (event) => {
    const iceCandidate = KurentoClient.getComplexType("IceCandidate")(
      event.candidate
    );
    socket.emit("SERVER_ICE_CANDIDATE", iceCandidate);
  });

  // Add ICE candidates that were received asynchronously
  const iceCandidatesQueue = session.consumerData.iceCandidatesQueue;
  while (iceCandidatesQueue.length) {
    const candidate = iceCandidatesQueue.shift();
    webrtcEndpoint.addIceCandidate(candidate);
  }

  // Start the WebRtcEndpoint
  const sdpAnswer = await webrtcEndpoint.processOffer(sdpOffer);
  webrtcEndpoint.gatherCandidates((err) => {
    if (err) {
      console.error("ERROR:", err);
    }
  });

  console.log("SDP Answer from KMS to App:\n%s", sdpAnswer);
  socket.emit("SERVER_SDP_ANSWER", sdpAnswer);

  // Connect to the publisher
  const playerEndpoint = global.kurento.playerEndpoint;
  if (!playerEndpoint) {
    console.error("ERROR: Publisher endpoint doesn't exist");
    return;
  }

  await playerEndpoint.connect(webrtcEndpoint);
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

  const iceCandidate = KurentoClient.getComplexType("IceCandidate")(candidate);

  if (session.consumerData.webrtcEndpoint) {
    session.consumerData.webrtcEndpoint.addIceCandidate(iceCandidate);
  } else {
    session.consumerData.iceCandidatesQueue.push(iceCandidate);
  }
}

// ----------------------------------------------------------------------------

async function handleDebugDot() {
  const pipelineDot = await global.kurento.pipeline.getGstreamerDot();
  Fs.writeFile("pipeline.dot", pipelineDot, (err) => {
    if (err) {
      console.error("ERROR:", err);
    }
    console.log("Saved DOT file: pipeline.dot");
  });

  const playerDot = await global.kurento.playerEndpoint.getElementGstreamerDot();
  Fs.writeFile("playerEndpoint.dot", playerDot, (err) => {
    if (err) {
      console.error("ERROR:", err);
    }
    console.log("Saved DOT file: playerEndpoint.dot");
  });
}

// ----------------------------------------------------------------------------
