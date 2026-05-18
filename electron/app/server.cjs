var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// server.ts
var import_express = __toESM(require("express"), 1);
var import_path = __toESM(require("path"), 1);
var import_vite = require("vite");
var import_axios = __toESM(require("axios"), 1);
async function startServer() {
  const app = (0, import_express.default)();
  const PORT = 3e3;
  app.use(import_express.default.json());
  app.post("/api/proxy/check", async (req, res) => {
    let { serverUrl, token, hwid } = req.body;
    if (!serverUrl.startsWith("http")) serverUrl = `https://${serverUrl}`;
    try {
      const response = await import_axios.default.post(`${serverUrl.replace(/\/$/, "")}/api/machine/check`, { token, hwid }, {
        timeout: 1e4,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
      });
      res.json(response.data);
    } catch (error) {
      const status = error.response?.status;
      const errorMsg = error.response?.data?.error || error.message;
      console.error(`Erro no Proxy Check (${status}):`, errorMsg);
      res.status(status || 500).json({
        ok: false,
        error: `Erro no servidor remoto (${status || "timeout"}): ${errorMsg}`
      });
    }
  });
  app.post("/api/proxy/pix/create", async (req, res) => {
    let { serverUrl, token, amount, credits } = req.body;
    if (!serverUrl || !serverUrl.startsWith("http")) serverUrl = `https://${serverUrl || "juke-2.onrender.com"}`;
    try {
      const response = await import_axios.default.post(`${serverUrl.replace(/\/$/, "")}/api/machine/pix/create`, { token, amount, credits }, {
        timeout: 1e4,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
      });
      res.json(response.data);
    } catch (error) {
      const status = error.response?.status;
      const errorMsg = error.response?.data?.error || error.message;
      console.error(`Erro no Proxy PIX (${status}):`, errorMsg);
      res.status(status || 500).json({ ok: false, error: "Erro ao gerar PIX" });
    }
  });
  app.post("/api/proxy/pix/status", async (req, res) => {
    let { serverUrl, token, paymentId, id } = req.body;
    const pId = paymentId || id;
    if (!serverUrl.startsWith("http")) serverUrl = `https://${serverUrl}`;
    try {
      const response = await import_axios.default.post(`${serverUrl.replace(/\/$/, "")}/api/machine/pix/status`, {
        token,
        payment_id: pId
        // Usando payment_id conforme especificado
      }, {
        timeout: 1e4,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
      });
      res.json(response.data);
    } catch (error) {
      const status = error.response?.status;
      const errorMsg = error.response?.data?.error || error.message;
      console.error(`Erro no Proxy PIX Status (${status}):`, errorMsg);
      res.status(status || 500).json({ ok: false, error: "Erro ao verificar status do PIX" });
    }
  });
  if (process.env.NODE_ENV !== "production") {
    const vite = await (0, import_vite.createServer)({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = import_path.default.join(process.cwd(), "dist");
    app.use(import_express.default.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(import_path.default.join(distPath, "index.html"));
    });
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MajuBox Server rodando em http://localhost:${PORT}`);
  });
}
startServer();
//# sourceMappingURL=server.cjs.map
