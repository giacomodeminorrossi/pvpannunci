import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://pvp.giustizia.it/pvp/it/lista_annunci.page?searchType=searchForm&page=0&size=48&sortProperty=dataPubblicazione,desc&sortAlpha=citta,asc&searchWith=Raggio%20d%27azione&codTipoLotto=VALORI/CREDITI&raggioAzione=25";
const TIME_ZONE = "Europe/Paris";
const PAGE_SIZE = 48;
const MAX_PAGES = 200;
const GLOBAL_BUDGET_MS = 24 * 60 * 1_000;
const SAVE_RESERVE_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 60_000;
const DETAIL_CONTENT_TIMEOUT_MS = 15_000;
const DETAIL_STABILITY_MS = 1_000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, "../data/latest.json");
const startedAt = Date.now();
const deadlineAt = startedAt + GLOBAL_BUDGET_MS;

class BudgetExceededError extends Error {
  constructor(context) {
    super(`Limite globale di ${GLOBAL_BUDGET_MS / 60_000} minuti raggiunto durante ${context}.`);
    this.name = "BudgetExceededError";
    this.code = "global_time_budget_exceeded";
  }
}

function todayInParis() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const targetDate = process.env.TARGET_DATE || todayInParis();

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
  const candidate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
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

function isValidIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const [, year, month, day] = match;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
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
  const labeledDate = toIsoDate(labeled);
  if (labeledDate) return labeledDate;

  const inline = String(text || "").match(
    /(?:data\s+(?:di\s+)?pubblicazione|pubblicato\s+il)[^\d]{0,30}(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4})/i,
  );
  return toIsoDate(inline?.[1]);
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

function remainingBudgetMs() {
  return deadlineAt - Date.now();
}

function ensureBudget(context, reserveMs = SAVE_RESERVE_MS) {
  if (remainingBudgetMs() <= reserveMs) {
    throw new BudgetExceededError(context);
  }
}

function operationTimeout(preferredMs, context) {
  ensureBudget(context);
  return Math.max(1_000, Math.min(preferredMs, remainingBudgetMs() - SAVE_RESERVE_MS));
}

function structuredError(error, fallbackCode, extra = {}) {
  return {
    code: error?.code || fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    ...extra,
  };
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

  const contentTimeout = operationTimeout(DETAIL_CONTENT_TIMEOUT_MS, context);
  const deadline = Date.now() + contentTimeout;
  await page
    .waitForLoadState("load", { timeout: Math.min(5_000, contentTimeout) })
    .catch(() => {});

  try {
    await page.waitForFunction(
      ({ stabilityMs }) => {
        const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const blocked =
          /captcha|accesso negato|access denied|forbidden|temporaneamente non disponibile|service unavailable|richiesta non autorizzata/i.test(
            bodyText,
          );
        const hasPublicationDate =
          /data\s+(?:di\s+)?pubblicazione|pubblicato\s+il/i.test(bodyText);
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
    ensureBudget(context);
    const bodyText = await page.locator("body").innerText().catch(() => "");

    if (looksBlocked(bodyText)) {
      throw new Error(`Il sito PVP ha bloccato o interrotto l'accesso per ${context}.`);
    }

    if (!clean(bodyText)) {
      throw new Error(`Pagina vuota o illeggibile per ${context}.`);
    }

    throw new Error(`Contenuto o data di pubblicazione non leggibile per ${context}.`);
  }

  return assertUsablePage(page, response, context);
}

async function collectAnnouncementCards(page) {
  const rawLinks = await page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => {
      const candidates = [];
      const selectors = [
        "article",
        "li",
        "tr",
        ".card",
        "[class*='annuncio']",
        "[class*='result']",
        "[class*='lotto']",
      ];

      for (const selector of selectors) {
        const element = anchor.closest(selector);
        if (element && !candidates.includes(element)) candidates.push(element);
      }

      let parent = anchor.parentElement;
      for (let depth = 0; parent && depth < 5; depth += 1) {
        if (!candidates.includes(parent)) candidates.push(parent);
        parent = parent.parentElement;
      }

      const withPublicationDate = candidates.find((element) => {
        const text = element.innerText || element.textContent || "";
        return (
          text.length <= 8_000 &&
          /data\s+(?:di\s+)?pubblicazione|pubblicato\s+il/i.test(text)
        );
      });
      const compact = candidates.find((element) => {
        const text = element.innerText || element.textContent || "";
        return text.trim() && text.length <= 3_000;
      });
      const container = withPublicationDate || compact || anchor;

      return {
        url: anchor.href,
        linkText: anchor.innerText || anchor.textContent || "",
        listingText: container.innerText || container.textContent || "",
      };
    }),
  );

  const byUrl = new Map();
  for (const item of rawLinks) {
    if (!isAnnouncementUrl(item.url)) continue;

    const normalizedUrl = new URL(item.url);
    normalizedUrl.hash = "";
    const url = normalizedUrl.toString();
    const listingText = clean(item.listingText);
    const current = byUrl.get(url);

    if (!current || listingText.length > current.listingText.length) {
      byUrl.set(url, {
        url,
        listingText,
        listingTitle: clean(item.linkText),
        listingPublicationDate: publicationDateFrom(item.listingText),
      });
    }
  }

  return [...byUrl.values()];
}

async function collectCandidateLinks(page, coverage, warnings) {
  const seen = new Map();
  const candidates = new Map();

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    ensureBudget(`la paginazione, prima della pagina ${pageNumber + 1}`);
    const url = new URL(SOURCE_URL);
    url.searchParams.set("page", String(pageNumber));
    url.searchParams.set("size", String(PAGE_SIZE));

    let bodyText;
    let links;
    try {
      const response = await page.goto(url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: operationTimeout(
          NAVIGATION_TIMEOUT_MS,
          `il caricamento della pagina risultati ${pageNumber + 1}`,
        ),
      });
      bodyText = await assertUsablePage(
        page,
        response,
        `la pagina risultati ${pageNumber + 1}`,
      );
      await page
        .waitForLoadState("networkidle", {
          timeout: operationTimeout(10_000, `l'attesa della pagina risultati ${pageNumber + 1}`),
        })
        .catch(() => {});
      links = await collectAnnouncementCards(page);
    } catch (error) {
      coverage.complete = false;
      if (error instanceof BudgetExceededError) {
        coverage.stop_reason = "global_time_budget";
      }
      warnings.push(
        structuredError(error, "result_page_unverified", { page: pageNumber + 1 }),
      );
      break;
    }

    coverage.pages_checked += 1;
    coverage.listings_seen += links.length;

    if (links.length === 0) {
      if (pageNumber === 0 && !looksLikeNoResults(bodyText)) {
        coverage.complete = false;
        warnings.push({
          code: "result_page_not_verifiable",
          message:
            "La pagina risultati non espone annunci né un messaggio verificabile di assenza risultati.",
          page: 1,
        });
      }
      break;
    }

    const unseen = links.filter((item) => !seen.has(item.url));
    if (unseen.length === 0) {
      coverage.complete = false;
      warnings.push({
        code: "pagination_repeated_page",
        message: "La paginazione ha ripetuto una pagina senza nuovi annunci.",
        page: pageNumber + 1,
      });
      break;
    }

    for (const item of unseen) {
      seen.set(item.url, item);
      if (
        item.listingPublicationDate === targetDate ||
        item.listingPublicationDate === null
      ) {
        candidates.set(item.url, item);
      }
    }

    coverage.candidates_found = candidates.size;
    const pageDates = links.map((item) => item.listingPublicationDate);
    const pageIsVerifiablyOlder =
      pageDates.length > 0 &&
      pageDates.every((date) => date !== null && date < targetDate);

    if (pageIsVerifiablyOlder) {
      coverage.stop_reason = "page_only_older_dates";
      break;
    }

    if (links.length < PAGE_SIZE) {
      coverage.stop_reason = "last_page";
      break;
    }

    if (pageNumber === MAX_PAGES - 1) {
      coverage.complete = false;
      coverage.stop_reason = "page_limit";
      warnings.push({
        code: "pagination_page_limit",
        message: `Paginazione interrotta al limite di sicurezza di ${MAX_PAGES} pagine.`,
        page: MAX_PAGES,
      });
    }
  }

  return [...candidates.values()];
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
  ensureBudget(`la verifica dell'annuncio ${item.url}`);
  const response = await page.goto(item.url, {
    waitUntil: "domcontentloaded",
    timeout: operationTimeout(NAVIGATION_TIMEOUT_MS, `il caricamento dell'annuncio ${item.url}`),
  });
  const bodyText = await waitForReadableDetail(page, response, `l'annuncio ${item.url}`);
  const detailPublicationDate = publicationDateFrom(bodyText);
  const publicationDate = detailPublicationDate || item.listingPublicationDate;

  if (!publicationDate) {
    throw new Error(`Data di pubblicazione non verificabile per l'annuncio ${item.url}.`);
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
    item.listingTitle ||
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

function deduplicateAnnouncements(values) {
  return [
    ...new Map(
      values.map((announcement) => [announcement.official_url, announcement]),
    ).values(),
  ];
}

async function saveResult(payload) {
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

let browser;
const announcements = [];
const warnings = [];
const errors = [];
const announcementErrors = [];
const coverage = {
  complete: true,
  pages_checked: 0,
  listings_seen: 0,
  candidates_found: 0,
  candidates_checked: 0,
  stop_reason: null,
};

try {
  if (!isValidIsoDate(targetDate)) {
    throw Object.assign(new Error("TARGET_DATE deve avere il formato YYYY-MM-DD ed essere valida."), {
      code: "invalid_target_date",
    });
  }

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

  const candidates = await collectCandidateLinks(page, coverage, warnings);

  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index];
    try {
      ensureBudget(`la verifica dei dettagli (${index + 1}/${candidates.length})`);
      const announcement = await extractAnnouncement(page, item);
      coverage.candidates_checked += 1;
      if (announcement) announcements.push(announcement);
    } catch (error) {
      if (error instanceof BudgetExceededError) throw error;

      coverage.complete = false;
      const warning = structuredError(error, "announcement_unverified", {
        official_url: item.url,
      });
      announcementErrors.push(warning);
      warnings.push(warning);
      console.warn(`Avviso: ${warning.message} Continuo con gli altri annunci.`);
    }
  }
} catch (error) {
  coverage.complete = false;
  if (error instanceof BudgetExceededError) coverage.stop_reason = "global_time_budget";
  errors.push(structuredError(error, "scrape_failed"));
} finally {
  try {
    await browser?.close();
  } catch (error) {
    coverage.complete = false;
    warnings.push(structuredError(error, "browser_close_failed"));
  }

  const deduplicated = deduplicateAnnouncements(announcements);
  const isPartial = !coverage.complete || warnings.length > 0 || errors.length > 0;
  const errorSummary = isPartial
    ? errors[0]?.message ||
      `${warnings.length} avvisi durante il controllo; la copertura non è completa.`
    : null;

  try {
    await saveResult({
      checked_at: new Date().toISOString(),
      target_date: targetDate,
      source_url: SOURCE_URL,
      status: isPartial ? "partial" : "success",
      error: errorSummary,
      warnings,
      errors,
      coverage,
      announcement_errors: announcementErrors,
      announcements: deduplicated,
    });
  } catch (saveError) {
    console.error(
      `Impossibile salvare data/latest.json: ${saveError instanceof Error ? saveError.message : String(saveError)}`,
    );
    process.exitCode = 1;
  }

  if (isPartial) {
    console.warn(
      `Controllo parziale per ${targetDate}: ${deduplicated.length} annunci verificati. La copertura è incompleta; un elenco vuoto non equivale a zero annunci.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Controllo completato per ${targetDate}: ${deduplicated.length} annunci verificati.`,
    );
  }
}
