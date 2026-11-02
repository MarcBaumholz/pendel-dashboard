// Pendel-MCP-Server: liefert Live-Daten Bahn und Auto zwischen zwei frei wählbaren Orten.
// Bahn: VVS-EFA-API (Echtzeit, kein Key). Auto: Google Routes API (Key in .env).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VVS = "https://www3.vvs.de/mngvvs";
// Standardstrecke, wenn der Aufrufer nichts angibt. Beide Seiten sind freie Eingaben (Ort, Haltestelle, Adresse).
export const STANDARD_START = process.env.PENDEL_START ?? "Schwaikheim";
export const STANDARD_ZIEL = process.env.PENDEL_ZIEL ?? "Stuttgart Hauptbahnhof";
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
// Google Routes (Pro-Tarif) hat 5.000 Gratis-Calls im Monat; der Cache hält das Dashboard darunter.
const AUTO_CACHE_MS =
  Number(process.env.PENDEL_AUTO_CACHE_SECONDS ?? 180) * 1000;

const minuten = (a, b) => Math.round((new Date(a) - new Date(b)) / 60000);

const istAusfall = (leg) =>
  leg.isCancelled === true ||
  (leg.realtimeStatus ?? []).some((s) => s.includes("CANCELLED"));

// EFA-Produktklassen ab 99 sind Fußwege, keine Fahrten.
const istFahrt = (leg) => leg.transportation && (leg.transportation.product?.class ?? 0) < 99;

// Freie Eingabe → bester VVS-Treffer (Haltestelle, Ortsteil oder Adresse).
const ortCache = new Map();
async function vvsOrt(text) {
  if (ortCache.has(text)) return ortCache.get(text);
  const params = new URLSearchParams({
    outputFormat: "rapidJSON",
    type_sf: "any",
    name_sf: text,
    SpEncId: "0",
    coordOutputFormat: "EPSG:4326",
  });
  const res = await fetch(`${VVS}/XML_STOPFINDER_REQUEST?${params}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`VVS-Ortssuche antwortet mit HTTP ${res.status}`);
  const orte = (await res.json()).locations ?? [];
  const ort = orte.find((o) => o.isBest) ?? orte[0];
  if (!ort) throw new Error(`VVS kennt „${text}“ nicht`);
  const treffer = { id: ort.id, name: ort.name };
  ortCache.set(text, treffer);
  return treffer;
}

export async function bahnVerbindungen(start = STANDARD_START, ziel = STANDARD_ZIEL) {
  const [von, nach] = await Promise.all([vvsOrt(start), vvsOrt(ziel)]);
  const params = new URLSearchParams({
    outputFormat: "rapidJSON",
    coordOutputFormat: "EPSG:4326",
    type_origin: "any",
    name_origin: von.id,
    type_destination: "any",
    name_destination: nach.id,
    useRealtime: "1",
    calcNumberOfTrips: "5",
    SpEncId: "0",
    language: "de",
  });
  const res = await fetch(`${VVS}/XML_TRIP_REQUEST2?${params}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`VVS antwortet mit HTTP ${res.status}`);
  const data = await res.json();

  const verbindungen = (data.journeys ?? []).map((j) => {
    const fahrten = j.legs.filter(istFahrt);
    if (!fahrten.length) return null;
    const erste = fahrten[0];
    const letzte = fahrten.at(-1);
    const abPlan = erste.origin.departureTimePlanned;
    const abIst = erste.origin.departureTimeEstimated ?? abPlan;
    const anPlan = letzte.destination.arrivalTimePlanned;
    const anIst = letzte.destination.arrivalTimeEstimated ?? anPlan;
    return {
      abfahrtPlan: abPlan,
      abfahrtIst: abIst,
      ankunftPlan: anPlan,
      ankunftIst: anIst,
      // Bei einer Adresse als Start beginnt die Reise mit einem Fußweg zur Haltestelle.
      losgehen: j.legs[0].origin.departureTimeEstimated ?? j.legs[0].origin.departureTimePlanned,
      fussMin: Math.max(minuten(abIst, j.legs[0].origin.departureTimeEstimated ?? j.legs[0].origin.departureTimePlanned), 0),
      verspaetungAbfahrt: minuten(abIst, abPlan),
      verspaetungAnkunft: minuten(anIst, anPlan),
      dauerMin: minuten(anIst, abIst),
      umstiege: Math.max(fahrten.length - 1, 0),
      linien: fahrten.map(
        (l) => l.transportation.disassembledName ?? l.transportation.name,
      ),
      gleis: erste.origin.properties?.platformName ?? null,
      echtzeit: fahrten.every((l) => l.isRealtimeControlled),
      ausfall: fahrten.some(istAusfall),
      hinweise: [
        ...new Set(
          fahrten.flatMap((l) =>
            (l.infos ?? []).map((i) => i.title ?? i.subtitle).filter(Boolean),
          ),
        ),
      ],
    };
  });
  // Streckenverlauf für die Karte: von der ersten Direktverbindung, sonst der ersten überhaupt.
  const reisen = data.journeys ?? [];
  const vorbild =
    reisen.find((j) => j.legs.filter(istFahrt).length === 1) ??
    reisen[0];
  const strecke = (vorbild?.legs ?? []).flatMap((l) => l.coords ?? []);

  // Die VVS liefert auch Züge, die gerade abgefahren sind; die braucht niemand mehr.
  const jetzt = Date.now();
  return {
    abgerufen: new Date(jetzt).toISOString(),
    quelle: "VVS EFA",
    start: von.name,
    ziel: nach.name,
    strecke,
    verbindungen: verbindungen
      .filter((v) => v && new Date(v.abfahrtIst) >= jetzt - 60000)
      .slice(0, 4),
  };
}

const autoCache = new Map();

export async function autoFahrzeit(start = STANDARD_START, ziel = STANDARD_ZIEL) {
  if (!GOOGLE_KEY) {
    return {
      status: "kein_key",
      hinweis: "GOOGLE_MAPS_API_KEY fehlt in ~/pendel-dashboard/.env",
    };
  }
  const schluessel = `${start}→${ziel}`;
  const gemerkt = autoCache.get(schluessel);
  if (gemerkt && Date.now() - gemerkt.zeit < AUTO_CACHE_MS) return gemerkt.daten;

  const res = await fetch(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask":
          "routes.duration,routes.staticDuration,routes.distanceMeters,routes.description," +
          "routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals",
      },
      body: JSON.stringify({
        origin: { address: start },
        destination: { address: ziel },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        // Liefert pro Abschnitt NORMAL / SLOW / TRAFFIC_JAM, damit die Karte den Stau einfärben kann.
        extraComputations: ["TRAFFIC_ON_POLYLINE"],
        languageCode: "de-DE",
      }),
    },
  );
  const body = await res.json();
  if (!res.ok)
    throw new Error(
      `Google Routes: ${body.error?.message ?? `HTTP ${res.status}`}`,
    );
  const route = body.routes?.[0];
  if (!route) throw new Error("Google Routes lieferte keine Route");

  const mitVerkehr = Math.round(parseInt(route.duration) / 60);
  const ohneVerkehr = Math.round(parseInt(route.staticDuration) / 60);
  const daten = {
    status: "ok",
    abgerufen: new Date().toISOString(),
    quelle: "Google Routes",
    dauerMin: mitVerkehr,
    ohneVerkehrMin: ohneVerkehr,
    stauMin: mitVerkehr - ohneVerkehr,
    km: Math.round(route.distanceMeters / 100) / 10,
    route: route.description ?? null,
    polyline: route.polyline?.encodedPolyline ?? null,
    stauAbschnitte: (route.travelAdvisory?.speedReadingIntervals ?? []).map(
      (s) => ({
        von: s.startPolylinePointIndex ?? 0,
        bis: s.endPolylinePointIndex,
        tempo: s.speed,
      }),
    ),
  };
  autoCache.set(schluessel, { zeit: Date.now(), daten });
  return daten;
}

const alsText = (daten) => ({
  content: [{ type: "text", text: JSON.stringify(daten) }],
});

const server = new McpServer({ name: "pendel", version: "1.0.0" });

const strecke = {
  start: z.string().optional().describe(`Ort, Haltestelle oder Adresse (Standard: ${STANDARD_START})`),
  ziel: z.string().optional().describe(`Ort, Haltestelle oder Adresse (Standard: ${STANDARD_ZIEL})`),
};

server.registerTool(
  "bahn_verbindungen",
  {
    title: "Bahn zwischen Start und Ziel",
    description: "Nächste Verbindungen mit Echtzeit-Verspätung, Gleis, Umstiegen und Ausfällen (VVS).",
    inputSchema: strecke,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ start, ziel }) => alsText(await bahnVerbindungen(start, ziel)),
);

server.registerTool(
  "auto_fahrzeit",
  {
    title: "Auto zwischen Start und Ziel",
    description: "Aktuelle Fahrzeit mit Verkehr, Fahrzeit ohne Verkehr und Stau-Minuten (Google Routes).",
    inputSchema: strecke,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ start, ziel }) => alsText(await autoFahrzeit(start, ziel)),
);

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await server.connect(new StdioServerTransport());
}
