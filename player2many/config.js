module.exports = {
  https: {
    cert: "../cert/cert.pem",
    certKey: "../cert/key.pem",
    port: 8080,
    wsPath: "/server",
    wsPingInterval: 25000,
    wsPingTimeout: 5000,
  },

  kurento: {
    ip: "127.0.0.1",
    port: 8888,
    wsPath: "/kurento",
  },
};
