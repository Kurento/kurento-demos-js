# Kurento player2many

This demo connects 1 publisher PlayerEndpoint (which can play HTTP or RTSP
sources) to N consumer WebRtcEndpoints. Each consumer can let the SDP
Offer/Answer negotiate the video codec, or a specific codec can be forced.

Note: Currently, the resource played by PlayerEndpoint is hardcoded in
"server.js".



## Run

Run these commands:

```sh
npm install

npm start
```

Then wait for a message such as "`Web server is listening on https://localhost:8080`", and direct your browser to that URL.
