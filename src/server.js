const http = require("http");
const { app, startWorker } = require("./app");
const config = require("./config");

const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || "0.0.0.0";

http.createServer(app).listen(PORT, HOST, () => {
  console.log(`USDT Custody Console listening on http://${HOST}:${PORT}`);
  if (config.isSetupComplete()) startWorker();
  else console.log("Not configured yet — open the app in a browser to run setup.");
});
