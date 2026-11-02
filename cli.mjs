// Lokaler Check ohne Claude: holt Bahn und Auto einmal und druckt sie lesbar aus.
// Aufruf: node --env-file-if-exists=.env cli.mjs   (Option --watch: jede Minute neu)
import { autoFahrzeit, bahnVerbindungen } from "./server.mjs";

const uhr = (iso) =>
  new Date(iso).toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  });

async function einmal() {
  console.log(`\n=== Schwaikheim → Stuttgart Hbf · ${uhr(new Date())} ===`);
  try {
    const bahn = await bahnVerbindungen();
    console.log("BAHN (VVS Echtzeit)");
    for (const v of bahn.verbindungen) {
      const status = v.ausfall
        ? "FÄLLT AUS"
        : v.verspaetungAbfahrt > 0
          ? `+${v.verspaetungAbfahrt}`
          : "pünktlich";
      console.log(
        `  ab ${uhr(v.abfahrtIst)} (Plan ${uhr(v.abfahrtPlan)}) ${status.padEnd(9)} an ${uhr(v.ankunftIst)}  ${v.dauerMin} min  ${v.linien.join("+")}  ${v.gleis ?? ""}`,
      );
    }
  } catch (e) {
    console.log("BAHN Fehler:", e.message);
  }
  try {
    const auto = await autoFahrzeit();
    if (auto.status === "ok") {
      console.log(
        `AUTO (Google)  ${auto.dauerMin} min mit Verkehr, ${auto.ohneVerkehrMin} ohne, Stau +${auto.stauMin}, ${auto.km} km, an ${uhr(Date.now() + auto.dauerMin * 60000)}`,
      );
    } else {
      console.log("AUTO", auto.hinweis);
    }
  } catch (e) {
    console.log("AUTO Fehler:", e.message);
  }
}

await einmal();
if (process.argv.includes("--watch")) setInterval(einmal, 60000);
