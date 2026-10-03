import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://pvp.giustizia.it/pvp/it/lista_annunci.page?searchType=searchForm&page=0&size=48&sortProperty=dataPubblicazione,desc&sortAlpha=citta,asc&searchWith=Raggio%20d%27azione&codTipoLotto=VALORI/CREDITI&raggioAzione=25";
const TIME_ZONE = "Europe/Paris";
const PAGE_SIZE = 48;
const MAX_PAGES = 200;
const NAVIGATION_TIMEOUT_MS = 60_000;
const DETAIL_CONTENT_TIMEOUT_MS = 15_000;
const DETAIL_STABILITY_MS = 1_000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, "../data/latest.json");

function todayInParis() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const targetDate = process.env.TARGET_DATE || todayInParis();

if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
  throw new Error("TARGET_DATE deve avere il formato YYYY-MM-DD.");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function toIsoDate(value) {
  const match = String(value || "").match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/);
  if (!match) return null;

  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function linesOf(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);
}

function readLabel(text, labels) {
  const lines = linesOf(text);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    for (const label of labels) {
      const matcher = new RegExp(`^${label}\\s*(?::|-)?\\s*(.*)$`, "i");
      const match = line.match(matcher);
      if (!match) continue;

      const sameLine = clean(match[1]);
      if (sameLine) return sameLine;

      const nextLine = clean(lines[index + 1]);
      if (nextLine) return nextLine;
    }
  }

  return null;
}

function publicationDateFrom(text) {
  const labeled = readLabel(text, [
    "data\\s+di\\s+pubblicazione",
    "data\\s+pubblicazione",
    "pubblicato\\s+il",
  ]);
  return toIsoDate(labeled);
}

function looksBlocked(text) {
  return /captcha|accesso negato|access denied|forbidden|temporaneamente non disponibile|service unavailable|richiesta non autorizzata/i.test(
    text,
  );
}

function looksLikeNoResults(text) {
  return /nessun(?:o)?\s+(?:annuncio|risultat|element)|non sono stati trovati risultati|0\s+risultati/i.test(
    text,
  );
}

function isAnnouncementUrl(url) {
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

async function assertUsablePage(page, response, context) {
  if (!response) {
    throw new Error(`Nessuna risposta HTTP ricevuta per ${context}.`);
  }

  if (!response.ok()) {
    throw new Error(`Risposta HTTP ${response.status()} per ${context}.`);
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!clean(bodyText)) {
    throw new Error(`Pagina vuota o illeggibile per ${context}.`);
  }

  if (looksBlocked(bodyText)) {
    throw new Error(`Il sito PVP ha bloccato o interrotto l'accesso per ${context}.`);
  }

  return bodyText;
}

async function waitForReadableDetail(page, response, context) {
  if (!response) {
    throw new Error(`Nessuna risposta HTTP ricevuta per ${context}.`);
  }

  if (!response.ok()) {
    throw new Error(`Risposta HTTP ${response.status()} per ${context}.`);
  }

  const deadline = Date.now() + DETAIL_CONTENT_TIMEOUT_MS;
  await page
    .waitForLoadState("load", { timeout: Math.min(5_000, DETAIL_CONTENT_TIMEOUT_MS) })
    .catch(() => {});

  try {
    await page.waitForFunction(
      ({ stabilityMs }) => {
        const bodyText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
        const blocked =
          /captcha|accesso negato|access denied|forbidden|temporaneamente non disponibile|service unavailable|richiesta non autorizzata/i.test(
            bodyText,
          );
        const hasPublicationDate =
          /data\\s+(?:di\\s+)?pubblicazione|pubblicato\\s+il/i.test(bodyText);
        const stateKey = "__pvpDetailReadiness";
        const now = performance.now();
        const previous = window[stateKey];

        if (blocked) return true;

        if (!hasPublicationDate) {
          window[stateKey] = null;
          return false;
        }

        if (!previous || previous.text !== bodyText) {
          window[stateKey] = { text: bodyText, since: now };
          return false;
        }

        return now - previous.since >= stabilityMs;
      },
      { stabilityMs: DETAIL_STABILITY_MS },
      { polling: 250, timeout: Math.max(1, deadline - Date.now()) },
    );
  } catch {
    const bodyText = await page.locator("body").innerText().catch(() => "");

    if (looksBlocked(bodyText)) {
      throw new Error(`Il sito PVP ha bloccato o interrotto l'accesso per ${context}.`);
    }

    if (!clean(bodyText)) {
      throw new Error(
        `Pagina vuota o illeggibile per ${context} dopo ${DETAIL_CONTENT_TIMEOUT_MS} ms di attesa.`,
      );
    }

    throw new Error(
      `Contenuto o data di pubblicazione non leggibile per ${context} entro ${DETAIL_CONTENT_TIMEOUT_MS} ms.`,
    );
  }

  return assertUsablePage(page, response, context);
}

async function collectAnnouncementLinks(page) {
  const rawLinks = await page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      url: anchor.href,
      text: anchor.innerText || anchor.textContent || "",
    })),
  );

  const byUrl = new Map();
  for (const item of rawLinks) {
    if (!isAnnouncementUrl(item.url)) continue;

    const normalizedUrl = new URL(item.url);
    normalizedUrl.hash = "";
    const url = normalizedUrl.toString();

    if (!byUrl.has(url)) {
      byUrl.set(url, { url, listingText: clean(item.text) });
    }
  }

  return [...byUrl.values()];
}

async function collectAllResultLinks(page) {
  const seen = new Map();

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const url = new URL(SOURCE_URL);
    url.searchParams.set("page", String(pageNumber));
    url.searchParams.set("size", String(PAGE_SIZE));

    const response = await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    const bodyText = await assertUsablePage(page, response, `la pagina risultati ${pageNumber + 1}`);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    const links = await collectAnnouncementLinks(page);
    const unseen = links.filter((item) => !seen.has(item.url));

    if (links.length === 0) {
      if (pageNumber === 0 && !looksLikeNoResults(bodyText)) {
        throw new Error(
          "La pagina risultati non espone annunci né un messaggio verificabile di assenza risultati.",
        );
      }
      return [...seen.values()];
    }

    if (unseen.length === 0) {
      return [...seen.values()];
    }

    for (const item of unseen) {
      seen.set(item.url, item);
    }

    if (links.length < PAGE_SIZE) {
      return [...seen.values()];
    }
  }

  throw new Error(
    `Paginazione interrotta al limite di sicurezza di ${MAX_PAGES} pagine; risultato incompleto.`,
  );
}

async function firstUsefulHeading(page) {
  const headings = await page
    .locator("main h1, main h2, main h3, main h4, article h1, article h2, article h3")
    .allTextContents()
    .catch(() => []);

  return (
    headings
      .map(clean)
      .find((value) => value.length >= 4 && !/portale|vendite pubbliche|dettaglio annuncio/i.test(value)) ||
    null
  );
}

async function extractAnnouncement(page, item) {
  const response = await page.goto(item.url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  const bodyText = await waitForReadableDetail(
    page,
    response,
    `l'annuncio ${item.url}`,
  );

  const publicationDate =
    publicationDateFrom(bodyText) || publicationDateFrom(item.listingText);

  if (!publicationDate) {
    throw new Error(
      `Data di pubblicazione non verificabile per l'annuncio ${item.url}.`,
    );
  }

  if (publicationDate !== targetDate) {
    return null;
  }

  const location = unique([
    readLabel(bodyText, ["citt[aà]", "comune", "localit[aà]", "luogo"]),
    readLabel(bodyText, ["indirizzo"]),
    readLabel(bodyText, ["provincia"]),
  ]).join(", ");

  const courtOrProcedure = unique([
    readLabel(bodyText, ["tribunale", "ufficio giudiziario"]),
    readLabel(bodyText, [
      "numero procedura",
      "procedura",
      "r\\.?g\\.?",
      "registro generale",
    ]),
  ]).join(" - ");

  const saleOrDeadlineDate =
    toIsoDate(
      readLabel(bodyText, [
        "data vendita",
        "data della vendita",
        "termine presentazione offerte",
        "scadenza offerte",
        "data asta",
      ]),
    ) || null;

  const priceOrValue =
    readLabel(bodyText, [
      "prezzo base",
      "prezzo",
      "valore",
      "offerta minima",
      "importo",
    ]) || null;

  const title =
    (await firstUsefulHeading(page)) ||
    readLabel(bodyText, ["descrizione lotto", "descrizione", "tipologia"]) ||
    item.listingText ||
    "Annuncio PVP";

  return {
    title: clean(title),
    location: location || null,
    court_or_procedure: courtOrProcedure || null,
    publication_date: publicationDate,
    sale_or_deadline_date: saleOrDeadlineDate,
    price_or_value: priceOrValue,
    official_url: item.url,
  };
}

async function saveResult(payload) {
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

let browser;
const announcements = [];
const announcementErrors = [];

function deduplicateAnnouncements(values) {
  return [
    ...new Map(
      values.map((announcement) => [announcement.official_url, announcement]),
    ).values(),
  ];
}

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "it-IT",
    timezoneId: TIME_ZONE,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36",
  });

  await context.route(/\.(?:png|jpe?g|gif|webp|svg|woff2?|ttf)(?:\?.*)?$/i, (route) =>
    route.abort(),
  );

  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  const resultLinks = await collectAllResultLinks(page);

  for (const item of resultLinks) {
    try {
      const announcement = await extractAnnouncement(page, item);
      if (announcement) announcements.push(announcement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const warning = { official_url: item.url, error: message };
      announcementErrors.push(warning);
      console.warn(`Avviso: ${message} Continuo con gli altri annunci.`);
    }
  }

  const deduplicated = deduplicateAnnouncements(announcements);
  const isPartial = announcementErrors.length > 0;
  const partialError = isPartial
    ? `${announcementErrors.length} annunci non sono stati verificati; il risultato è incompleto.`
    : null;

  await saveResult({
    checked_at: new Date().toISOString(),
    target_date: targetDate,
    source_url: SOURCE_URL,
    status: isPartial ? "partial" : "success",
    error: partialError,
    announcement_errors: announcementErrors,
    announcements: deduplicated,
  });

  if (isPartial) {
    console.warn(
      `Controllo parziale per ${targetDate}: ${deduplicated.length} annunci verificati, ${announcementErrors.length} non verificati. Non è possibile concludere che non esistano annunci se l'elenco verificato è vuoto.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Controllo completato per ${targetDate}: ${deduplicated.length} annunci verificati.`,
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  await saveResult({
    checked_at: new Date().toISOString(),
    target_date: targetDate,
    source_url: SOURCE_URL,
    status: "error",
    error: message,
    announcement_errors: announcementErrors,
    announcements: deduplicateAnnouncements(announcements),
  });

  console.error(`Controllo PVP non completato: ${message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
