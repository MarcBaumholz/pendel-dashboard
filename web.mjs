// Lokale Pendel-App: http://localhost:4321
// Liefert die Seite app.html und zwei JSON-Routen, die dieselben Abfragen wie der MCP-Server nutzen.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  STANDARD_START,
  STANDARD_ZIEL,
  autoFahrzeit,
  bahnVerbindungen,
} from "./server.mjs";

const PORT = Number(process.env.PENDEL_PORT ?? 4321);
const SEITE = new URL("./app.html", import.meta.url);

const json = (res, status, daten) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(daten));
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    // Start und Ziel kommen als ?start=…&ziel=…, auf 120 Zeichen gekürzt; leer heißt Standardstrecke.
    const feld = (name, standard) =>
      url.searchParams.get(name)?.trim().slice(0, 120) || standard;
    const start = feld("start", STANDARD_START);
    const ziel = feld("ziel", STANDARD_ZIEL);

    if (url.pathname === "/api/bahn")
      return json(res, 200, await bahnVerbindungen(start, ziel));
    if (url.pathname === "/api/auto")
      return json(res, 200, await autoFahrzeit(start, ziel));
    // Der Karten-Key ist bei Google auf http://localhost:4321 beschränkt, darf also in den Browser.
    if (url.pathname === "/api/config")
      return json(res, 200, {
        kartenKey: process.env.GOOGLE_MAPS_JS_KEY ?? null,
        start: STANDARD_START,
        ziel: STANDARD_ZIEL,
      });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(SEITE));
    }
    json(res, 404, { fehler: "nicht gefunden" });
  } catch (e) {
    json(res, 502, { fehler: e.message });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Pendel-App läuft auf http://localhost:${PORT}`);
});
