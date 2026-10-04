// Funzioni pure di interpretazione del testo e dei dati PVP.
// Non dipendono da Playwright e sono coperte dai test in test/parse.test.mjs.

export const BLOCKED_PATTERN =
  /captcha|accesso negato|access denied|forbidden|temporaneamente non disponibile|service unavailable|richiesta non autorizzata/i;
export const PUBLICATION_LABEL_PATTERN =
  /data\s+(?:di\s+)?pubblicazione|pubblicato\s+(?:sul\s+portale\s+)?il/i;

const LETTER = "A-Za-zÀ-ÖØ-öø-ÿ";

export function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function isoFromParts(year, month, day) {
  const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${candidate}T00:00:00Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return candidate;
}

export function toIsoDate(value) {
  const match = String(value || "").match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/);
  if (!match) return null;
  const [, day, month, year] = match;
  return isoFromParts(year, month, day);
}

// Come toIsoDate, ma conserva l'ora se presente: "05/11/2026 13:00" → "2026-11-05T13:00".
export function toIsoDateTime(value) {
  const date = toIsoDate(value);
  if (!date) return null;
  const time = String(value).match(
    /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}\D{1,10}?(\d{1,2})[:.](\d{2})\b/,
  );
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) return date;
  return `${date}T${time[1].padStart(2, "0")}:${time[2]}`;
}

export function isValidIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return Boolean(match && isoFromParts(match[1], match[2], match[3]) === value);
}

function linesOf(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);
}

// L'etichetta deve terminare a fine parola: "procedura" non deve
// corrispondere a "Procedurale", né "rg" a "Rgxyz".
export function matchLabel(line, label) {
  return line.match(new RegExp(`^${label}(?![${LETTER}])\\s*(?::|-)?\\s*(.*)$`, "i"));
}

// Le etichette sono in ordine di priorità: la prima etichetta presente nel
// testo vince, anche se un'etichetta meno specifica compare prima.
// Il PVP mostra "-" per i campi vuoti (es. "Tribunale" nelle liquidazioni volontarie).
function isPlaceholder(value) {
  return /^[-–—/.\s]*$/.test(value);
}

export function readLabel(text, labels) {
  const lines = linesOf(text);

  for (const label of labels) {
    for (let index = 0; index < lines.length; index += 1) {
      const match = matchLabel(lines[index], label);
      if (!match) continue;

      const value = clean(match[1]) || clean(lines[index + 1]);
      if (!isPlaceholder(value)) return value;
    }
  }

  return null;
}

export function readLabelBlock(text, labels, stopLabels) {
  const lines = linesOf(text);

  for (const label of labels) {
    for (let index = 0; index < lines.length; index += 1) {
      const match = matchLabel(lines[index], label);
      if (!match) continue;

      const values = [];
      const sameLine = clean(match[1]);
      if (sameLine) values.push(sameLine);

      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (stopLabels.some((stopLabel) => matchLabel(line, stopLabel))) break;
        values.push(line);
      }

      const value = clean(values.join(" "));
      if (value) return value;
    }
  }

  return null;
}

const CREDIT_DESCRIPTION_LABELS = [
  "descrizione\\s+(?:del\\s+)?credito",
  "descrizione\\s+(?:del\\s+)?lotto",
  "descrizione\\s+(?:del\\s+)?bene",
  "descrizione",
];

const FIELD_BOUNDARY_LABELS = [
  "categoria",
  "tipologia",
  "tribunale",
  "ufficio\\s+giudiziario",
  "n[°ºo]\\s*procedura",
  "numero\\s+procedura",
  "anno\\s+procedura",
  "procedura",
  "registro\\s+generale",
  "r\\.?g\\.?",
  "data\\s+(?:di\\s+)?pubblicazione",
  "pubblicato\\s+(?:sul\\s+portale\\s+)?il",
  "data\\s+(?:di\\s+|della\\s+)?vendita",
  "vendita$",
  "termine\\s+presentazione\\s+offerte",
  "scadenza\\s+offerte",
  "data\\s+asta",
  "prezzo\\s+base(?:\\s+d['’]asta)?",
  "offerta\\s+minima",
  "rialzo\\s+minimo",
  "modalit[aà]\\s+(?:di\\s+)?vendita",
  "luogo\\s+(?:di\\s+)?vendita",
  "ubicazione",
  "indirizzo",
  "citt[aà]",
  "comune",
  "localit[aà]",
  "provincia",
  "custode",
  "delegato",
  "professionista",
  "giudice",
  "numero\\s+lotto",
  "codice\\s+lotto",
  "dati\\s+(?:del|della)\\s+(?:bene|lotto|procedura|vendita)",
  "beni\\s+inclusi(?:\\s+nel\\s+lotto)?",
  "tipo\\s+procedura",
  "lotto\\s+nr\\.?",
  "referenti",
  "documenti",
  "allegati",
];

// Sulla pagina PVP: "Data di vendita 06/11/2026 12:00", "Data asta 06/11/2026"
// e, separato, "Termine presentazione offerte 05/11/2026 13:00".
const SALE_DATE_LABELS = ["data\\s+(?:di\\s+|della\\s+)?vendita", "data\\s+asta"];
const OFFER_DEADLINE_LABELS = [
  "termine\\s+(?:di\\s+)?presentazione\\s+(?:delle\\s+)?offerte",
  "scadenza\\s+(?:presentazione\\s+)?(?:delle\\s+)?offerte",
];
const TITLE_MAX_LENGTH = 100;

export function normalizeCreditDescription(value) {
  return clean(value)
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    // Solo davanti a una parola ("75.La" → "75. La"), non nelle sigle come "R.G.".
    .replace(/([.!?])(?=[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ])/g, "$1 ")
    .replace(new RegExp(`([:;])(?=[${LETTER}])`, "g"), "$1 ")
    .replace(/([a-zà-öø-ÿ])(?=[A-ZÀ-ÖØ-Þ])/g, "$1 ")
    // Importo attaccato al testo successivo: "111.059,00credito" → "111.059,00 credito".
    .replace(new RegExp(`(\\d,\\d{2})(?=[${LETTER}])`, "g"), "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

export function creditDescriptionFrom(text) {
  const value = readLabelBlock(text, CREDIT_DESCRIPTION_LABELS, FIELD_BOUNDARY_LABELS);
  return value ? normalizeCreditDescription(value) : null;
}

export function baseAuctionPriceFrom(text) {
  return readLabel(text, [
    "prezzo\\s+base\\s+d['’]asta",
    "prezzo\\s+base",
    "base\\s+d['’]asta",
  ]);
}

export function publicationDateFrom(text) {
  const labeled = readLabel(text, [
    "data\\s+di\\s+pubblicazione",
    "data\\s+pubblicazione",
    "pubblicato\\s+sul\\s+portale\\s+il",
    "pubblicato\\s+il",
  ]);
  const labeledDate = toIsoDate(labeled);
  if (labeledDate) return labeledDate;

  const inline = String(text || "").match(
    /(?:data\s+(?:di\s+)?pubblicazione|pubblicato\s+(?:sul\s+portale\s+)?il)[^\d]{0,30}(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4})/i,
  );
  return toIsoDate(inline?.[1]);
}

export function saleDateFrom(text) {
  return toIsoDateTime(readLabel(text, SALE_DATE_LABELS));
}

export function offerDeadlineFrom(text) {
  return toIsoDateTime(readLabel(text, OFFER_DEADLINE_LABELS));
}

// La prima "Tipologia" della pagina è il tipo di vendita (es. "Competitiva");
// le successive riguardano il bene e i referenti.
export function saleTypeFrom(text) {
  return readLabel(text, ["tipologia"]);
}

// Il PVP non espone un titolo: si usa l'inizio della descrizione.
export function shortTitle(description, maxLength = TITLE_MAX_LENGTH) {
  const value = clean(description);
  if (!value) return null;
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:]+$/, "")}…`;
}

export function procedureReferenceFrom(text) {
  const number = readLabel(text, [
    "n[°ºo]\\s*procedura",
    "numero\\s+procedura",
    "registro\\s+generale",
    "r\\.?g\\.?",
  ]);
  const year = readLabel(text, ["anno\\s+procedura"]);
  if (number && year && !number.includes(year)) return `${number}/${year}`;
  return number || readLabel(text, ["procedura"]) || null;
}

export function courtOrProcedureFrom(text) {
  return (
    unique([
      readLabel(text, ["tribunale", "ufficio\\s+giudiziario"]),
      procedureReferenceFrom(text),
    ]).join(" - ") || null
  );
}

export function looksBlocked(text) {
  return BLOCKED_PATTERN.test(text);
}

export function looksLikeNoResults(text) {
  return /nessun(?:o)?\s+(?:annuncio|risultat|element)|non sono stati trovati risultati|0\s+risultati/i.test(
    text,
  );
}

export function isAnnouncementUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "pvp.giustizia.it") return false;

    const candidate = `${parsed.pathname}${parsed.search}`;
    return (
      /(?:detail|dettaglio)[^/?#]*annuncio/i.test(candidate) ||
      /annuncio[^/?#]*(?:detail|dettaglio)/i.test(candidate) ||
      /[?&](?:idAnnuncio|idInserzione)=/i.test(candidate)
    );
  } catch {
    return false;
  }
}

export function announcementIdFrom(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("idAnnuncio") || parsed.searchParams.get("idInserzione");
  } catch {
    return null;
  }
}

export const SENSITIVE_KEY_PATTERN = /auth|cookie|csrf|jwt|key|password|secret|session|token/i;

export function sanitizeOfficialUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== "pvp.giustizia.it") return null;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function scalarEntries(value, path = [], result = [], depth = 0) {
  if (depth > 8 || result.length >= 2_000 || value === null || value === undefined) {
    return result;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      scalarEntries(child, [...path, String(index)], result, depth + 1);
    }
  } else if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      scalarEntries(child, [...path, key], result, depth + 1);
    }
  } else if (["string", "number", "boolean"].includes(typeof value)) {
    result.push({ path, key: normalizedKey(path.at(-1)), value: clean(value) });
  }
  return result;
}

function firstJsonValue(entries, keys) {
  const wanted = new Set(keys.map(normalizedKey));
  return entries.find((entry) => wanted.has(entry.key) && entry.value)?.value || null;
}

export function jsonLooksPertinent(value, itemUrl, responseUrl) {
  const entries = scalarEntries(value);
  const identifier = announcementIdFrom(itemUrl);
  const hasIdentifier = identifier && entries.some((entry) => entry.value === identifier);
  const responseIdentifier = announcementIdFrom(responseUrl);
  const relevantKeys = new Set([
    "idannuncio",
    "idannunciopvp",
    "datapubblicazione",
    "datapubblicazioneportale",
    "descrizionelotto",
    "numeroprocedura",
  ]);
  const hasRelevantKeys = entries.some((entry) => relevantKeys.has(entry.key));
  const endpointMatches = identifier && responseIdentifier === identifier;
  return Boolean(hasIdentifier || (endpointMatches && hasRelevantKeys));
}

// Una risposta può contenere più annunci (es. una lista): si usa solo l'oggetto
// che contiene l'identificativo dell'annuncio, se presente.
function recordWithIdentifier(value, identifier, depth = 0) {
  if (!identifier || depth > 8 || value === null || typeof value !== "object") return null;
  if (
    !Array.isArray(value) &&
    Object.values(value).some((child) => child !== null && typeof child !== "object" && String(child) === identifier)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    const record = recordWithIdentifier(child, identifier, depth + 1);
    if (record) return record;
  }
  return null;
}

export function extractJsonDetails(payloads, identifier = null) {
  const entries = payloads.flatMap((payload) =>
    scalarEntries(recordWithIdentifier(payload, identifier) || payload),
  );
  const courtOrProcedure = unique([
    firstJsonValue(entries, ["tribunale", "ufficioGiudiziario"]),
    firstJsonValue(entries, ["numeroProcedura", "procedura", "registroGenerale", "rg"]),
  ]).join(" - ");

  return {
    credit_description:
      normalizeCreditDescription(
        firstJsonValue(entries, [
          "descrizioneCredito",
          "descrizioneLotto",
          "descrizioneBene",
          "lotDescription",
          "descrizione",
        ]),
      ) || null,
    court_or_procedure: courtOrProcedure || null,
    publication_date: toIsoDate(
      firstJsonValue(entries, [
        "dataPubblicazione",
        "dataPubblicazionePortale",
        "publicationDate",
        "pubblicatoIl",
      ]),
    ),
    sale_date: toIsoDateTime(
      firstJsonValue(entries, ["dataVendita", "dataDellaVendita", "dataAsta"]),
    ),
    offer_deadline: toIsoDateTime(
      firstJsonValue(entries, ["terminePresentazioneOfferte", "scadenzaOfferte"]),
    ),
    base_auction_price: firstJsonValue(entries, [
      "prezzoBaseAsta",
      "prezzoBaseDasta",
      "prezzoBase",
      "baseAuctionPrice",
    ]),
  };
}

export function deduplicateAnnouncements(values) {
  return [
    ...new Map(values.map((announcement) => [announcement.official_url, announcement])).values(),
  ];
}

// Riepilogo delle date di pubblicazione di una pagina risultati, nell'ordine mostrato.
export function summarizePageDates(dates) {
  const known = dates.filter(Boolean);
  return {
    listings: dates.length,
    newest: known.length ? known.reduce((a, b) => (a > b ? a : b)) : null,
    oldest: known.length ? known.reduce((a, b) => (a < b ? a : b)) : null,
    undated: dates.length - known.length,
    // La ricerca è ordinata per data di pubblicazione decrescente.
    ordered: known.every((date, index) => index === 0 || known[index - 1] >= date),
  };
}

// Descrizioni della sezione "Beni inclusi nel lotto". Il PVP tronca il campo
// "Descrizione" del lotto, mentre qui il testo è spesso più completo. Per ogni
// bene la struttura è: categoria, indirizzo (facoltativo), descrizione,
// "Tipologia", categoria; la descrizione è la riga prima di "Tipologia".
export function assetDescriptionsFrom(text) {
  const lines = linesOf(text);
  const start = lines.findIndex((line) => matchLabel(line, "beni\\s+inclusi(?:\\s+nel\\s+lotto)?"));
  if (start < 0) return [];
  const end = lines.findIndex(
    (line, index) => index > start && /^(?:procedura|tipo\s+procedura|referenti|allegati)$/i.test(line),
  );
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  return unique(
    section
      .map((line, index) => (/^tipologia$/i.test(line) && index > 0 ? section[index - 1] : null))
      .filter((line) => line && !/^tipologia$/i.test(line))
      .map(normalizeCreditDescription),
  );
}

// Nella scheda della lista risultati la descrizione non ha etichetta: è la riga
// che precede "Data Pubblicazione" (categoria, data vendita, lotto, indirizzo,
// descrizione, data pubblicazione, prezzo).
export function listingDescriptionFrom(text) {
  const lines = linesOf(text);
  const index = lines.findIndex((line) => PUBLICATION_LABEL_PATTERN.test(line));
  if (index < 1) return null;
  const candidate = lines[index - 1];
  if (/^lotto\b/i.test(candidate) || toIsoDate(candidate)) return null;
  return normalizeCreditDescription(candidate) || null;
}
