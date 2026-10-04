// Individua gli annunci di data/latest.json non ancora notificati.
//
//   node scripts/notify-new.mjs prepare <file-corpo>
//     scrive il corpo Markdown della notifica e, se eseguito in GitHub Actions,
//     imposta gli output new_count e title;
//   node scripts/notify-new.mjs mark
//     registra gli annunci correnti in data/notified-ids.json.
//
// "mark" va eseguito solo dopo l'invio riuscito della notifica, così un invio
// fallito viene ripetuto al controllo successivo.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { announcementIdFrom } from "./lib/parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LATEST_PATH = resolve(__dirname, "../data/latest.json");
const NOTIFIED_PATH = resolve(__dirname, "../data/notified-ids.json");

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function keyOf(announcement) {
  return announcementIdFrom(announcement.official_url) || announcement.official_url;
}

function bodyFor(latest, announcements) {
  const sections = announcements.map((announcement) => {
    const rows = [
      ["Procedura", announcement.court_or_procedure],
      ["Pubblicato il", announcement.publication_date],
      ["Tipo di vendita", announcement.sale_type],
      ["Data vendita", announcement.sale_date?.replace("T", " ")],
      ["Termine offerte", announcement.offer_deadline?.replace("T", " ")],
      ["Prezzo base", announcement.base_auction_price],
      ["Dettaglio verificato", announcement.detail_verified ? "sì" : "no"],
    ]
      .filter(([, value]) => value)
      .map(([label, value]) => `- **${label}:** ${value}`);
    return [
      `### [${announcement.title || "Annuncio PVP"}](${announcement.official_url})`,
      ...rows,
      announcement.credit_description ? `\n> ${announcement.credit_description}` : "",
      // Il PVP tronca la descrizione del lotto: si aggiungono i beni se dicono di più.
      ...(announcement.asset_descriptions || [])
        .filter((text) => text !== announcement.credit_description)
        .map((text) => `\n**Bene:** ${text}`),
    ].join("\n");
  });

  const note =
    latest.status === "success"
      ? ""
      : `\n\n⚠️ Controllo con stato \`${latest.status}\`: ${latest.error || "copertura incompleta"}.`;
  return `Nuovi annunci PVP pubblicati il ${latest.target_date}.${note}\n\n${sections.join("\n\n")}\n`;
}

const [mode, bodyPath] = process.argv.slice(2);
const latest = await readJson(LATEST_PATH, null);
const notified = new Set(await readJson(NOTIFIED_PATH, []));
const fresh = (latest?.announcements || []).filter((item) => !notified.has(keyOf(item)));

if (mode === "prepare") {
  if (!bodyPath) throw new Error("Specificare il file in cui scrivere il corpo della notifica.");
  if (fresh.length > 0) await writeFile(bodyPath, bodyFor(latest, fresh), "utf8");
  if (process.env.GITHUB_OUTPUT) {
    const title = `PVP: ${fresh.length} nuovi annunci del ${latest?.target_date}`;
    await appendFile(process.env.GITHUB_OUTPUT, `new_count=${fresh.length}\ntitle=${title}\n`);
  }
  console.log(`Annunci da notificare: ${fresh.length}.`);
} else if (mode === "mark") {
  for (const item of fresh) notified.add(keyOf(item));
  await writeFile(NOTIFIED_PATH, `${JSON.stringify([...notified].sort(), null, 2)}\n`, "utf8");
  console.log(`Registrati ${fresh.length} annunci notificati.`);
} else {
  throw new Error('Modalità non valida: usare "prepare" oppure "mark".');
}
