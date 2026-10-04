import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCKED_PATTERN,
  PUBLICATION_LABEL_PATTERN,
  announcementIdFrom,
  baseAuctionPriceFrom,
  clean,
  courtOrProcedureFrom,
  creditDescriptionFrom,
  deduplicateAnnouncements,
  extractJsonDetails,
  isAnnouncementUrl,
  isValidIsoDate,
  jsonLooksPertinent,
  looksBlocked,
  looksLikeNoResults,
  publicationDateFrom,
  offerDeadlineFrom,
  saleDateFrom,
  saleTypeFrom,
  sanitizeOfficialUrl,
  shortTitle,
} from "./lib/parse.mjs";

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
const HISTORY_PATH = resolve(__dirname, "../data/history");
const DIAGNOSTICS_PATH = resolve(__dirname, "../diagnostics");
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

// Nomi di chiavi e attributi da non riportare nella diagnostica.
const SENSITIVE_NAME_PATTERN = /auth|cookie|csrf|jwt|password|secret|session|token/i;

function startNetworkCapture(context, item) {
  const responses = [];
  const payloads = [];
  const pending = new Set();
  let active = true;

  const listener = (response) => {
    if (!active) return;
    const request = response.request();
    if (!["fetch", "xhr"].includes(request.resourceType())) return;
    const safeUrl = sanitizeOfficialUrl(response.url());
    if (!safeUrl) return;

    const task = (async () => {
      const summary = {
        url: safeUrl,
        status: response.status(),
        resource_type: request.resourceType(),
        json_detected: false,
        pertinent: false,
        top_level_keys: [],
      };
      try {
        const json = await response.json();
        summary.json_detected = true;
        summary.top_level_keys =
          json && typeof json === "object" && !Array.isArray(json)
            ? Object.keys(json)
                .filter((key) => !SENSITIVE_NAME_PATTERN.test(key))
                .slice(0, 50)
            : [];
        summary.pertinent = jsonLooksPertinent(json, item.url, safeUrl);
        if (summary.pertinent) payloads.push(json);
      } catch {
        // La risposta non contiene JSON leggibile; il riepilogo resta metadato-only.
      }
      responses.push(summary);
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  };

  context.on("response", listener);
  return {
    responses,
    payloads,
    async stop() {
      active = false;
      context.off("response", listener);
      await Promise.allSettled([...pending]);
    },
  };
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
  if (response && !response.ok()) {
    throw new Error(`Risposta HTTP ${response.status()} per ${context}.`);
  }

  const contentTimeout = operationTimeout(DETAIL_CONTENT_TIMEOUT_MS, context);
  const deadline = Date.now() + contentTimeout;
  await page.locator("body").waitFor({
    state: "visible",
    timeout: Math.min(5_000, contentTimeout),
  });
  await page
    .locator("main, article, [class*='detail'], [id*='detail']")
    .first()
    .waitFor({ state: "visible", timeout: Math.min(5_000, contentTimeout) })
    .catch(() => {});
  await page
    .waitForLoadState("load", { timeout: Math.min(5_000, contentTimeout) })
    .catch(() => {});

  try {
    await page.waitForFunction(
      ({ stabilityMs, blockedSource, publicationSource }) => {
        const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const blocked = new RegExp(blockedSource, "i").test(bodyText);
        const hasPublicationDate = new RegExp(publicationSource, "i").test(bodyText);
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
      {
        stabilityMs: DETAIL_STABILITY_MS,
        blockedSource: BLOCKED_PATTERN.source,
        publicationSource: PUBLICATION_LABEL_PATTERN.source,
      },
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

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!clean(bodyText)) throw new Error(`Pagina vuota o illeggibile per ${context}.`);
  if (looksBlocked(bodyText)) {
    throw new Error(`Il sito PVP ha bloccato o interrotto l'accesso per ${context}.`);
  }
  return bodyText;
}

async function collectAnnouncementCards(page) {
  const rawLinks = await page.locator("a[href]").evaluateAll((anchors, publicationSource) => {
    const publicationPattern = new RegExp(publicationSource, "i");
    return anchors.map((anchor) => {
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
        return text.length <= 8_000 && publicationPattern.test(text);
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
    });
  }, PUBLICATION_LABEL_PATTERN.source);

  const byUrl = new Map();
  for (const item of rawLinks) {
    if (!isAnnouncementUrl(item.url)) continue;

    const normalizedUrl = new URL(item.url);
    normalizedUrl.hash = "";
    const url = normalizedUrl.toString();
    // Le righe restano separate: readLabel lavora riga per riga.
    const listingText = String(item.listingText || "").replace(/\r\n?/g, "\n").trim();
    const current = byUrl.get(url);

    if (!current || clean(listingText).length > clean(current.listingText).length) {
      byUrl.set(url, {
        url,
        listingText,
        listingTitle: clean(item.linkText),
        listingPublicationDate: publicationDateFrom(item.listingText),
        listingPageUrl: page.url(),
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

function extractListingAnnouncement(item) {
  const listingText = item.listingText;
  const creditDescription = creditDescriptionFrom(listingText);

  return {
    title: shortTitle(creditDescription),
    credit_description: creditDescription,
    court_or_procedure: courtOrProcedureFrom(listingText),
    publication_date: item.listingPublicationDate,
    sale_type: saleTypeFrom(listingText),
    sale_date: saleDateFrom(listingText),
    offer_deadline: offerDeadlineFrom(listingText),
    base_auction_price: baseAuctionPriceFrom(listingText),
    official_url: item.url,
    detail_verified: false,
  };
}

async function findCandidateLink(page, item) {
  const timeout = operationTimeout(15_000, `la ricerca del link ${item.url}`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const links = page.locator("a[href]");
    // Un solo passaggio nel browser invece di una chiamata per ogni link.
    const index = await links
      .evaluateAll(
        (anchors, targetUrl) =>
          anchors.findIndex((anchor) => {
            try {
              const normalized = new URL(anchor.getAttribute("href"), document.baseURI);
              normalized.hash = "";
              return normalized.toString() === targetUrl;
            } catch {
              return false;
            }
          }),
        item.url,
      )
      .catch(() => -1);
    if (index >= 0) return links.nth(index);
    await page.waitForTimeout(250);
  }
  throw new Error(`Link del candidato non trovato nella pagina risultati: ${item.url}.`);
}

async function waitForClickedDetail(context, listPage, beforePages, beforeUrl, beforeText, item) {
  const timeout = operationTimeout(DETAIL_CONTENT_TIMEOUT_MS, `l'apertura tramite click di ${item.url}`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const popup = context.pages().find((candidate) => !beforePages.has(candidate));
    if (popup) return { detailPage: popup, openedNewPage: true, response: null };
    if (listPage.url() !== beforeUrl || isAnnouncementUrl(listPage.url())) {
      return { detailPage: listPage, openedNewPage: false, response: null };
    }
    const currentText = await listPage.locator("body").innerText().catch(() => "");
    if (clean(currentText) && clean(currentText) !== clean(beforeText)) {
      return { detailPage: listPage, openedNewPage: false, response: null };
    }
    await listPage.waitForTimeout(250);
  }
  throw new Error(`Il click non ha aperto un dettaglio leggibile per ${item.url}.`);
}

async function sanitizedHtml(page) {
  return page.evaluate((sensitiveSource) => {
    const sensitivePattern = new RegExp(sensitiveSource, "i");
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("script, noscript").forEach((element) => element.remove());
    clone.querySelectorAll("input[type='hidden']").forEach((element) => {
      element.removeAttribute("value");
    });
    clone.querySelectorAll("*").forEach((element) => {
      for (const attribute of [...element.attributes]) {
        if (sensitivePattern.test(attribute.name)) {
          element.removeAttribute(attribute.name);
        }
      }
    });
    return `<!doctype html>\n${clone.outerHTML}`;
  }, SENSITIVE_NAME_PATTERN.source);
}

async function saveDiagnostics(page, item, networkResponses, error) {
  const id = (announcementIdFrom(item.url) || `candidate-${Date.now()}`).replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const directory = resolve(DIAGNOSTICS_PATH, id);
  await mkdir(directory, { recursive: true });
  const paths = {
    html: `diagnostics/${id}/detail.html`,
    screenshot: `diagnostics/${id}/detail.png`,
    network: `diagnostics/${id}/network-summary.json`,
  };
  await writeFile(resolve(directory, "detail.html"), await sanitizedHtml(page), "utf8");
  await page.screenshot({ path: resolve(directory, "detail.png"), fullPage: true });
  await writeFile(
    resolve(directory, "network-summary.json"),
    `${JSON.stringify(
      {
        captured_at: new Date().toISOString(),
        announcement_id: id,
        official_url: sanitizeOfficialUrl(item.url),
        error: error instanceof Error ? error.message : String(error),
        responses: networkResponses,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return paths;
}

// Salva il testo letto per ogni annuncio verificato, così le etichette reali
// della pagina si possono consultare negli artifact dell'esecuzione.
async function saveDetailText(item, bodyText, jsonDetails) {
  const id = (announcementIdFrom(item.url) || `candidate-${Date.now()}`).replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const directory = resolve(DIAGNOSTICS_PATH, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "detail-text.txt"),
    [
      `URL: ${sanitizeOfficialUrl(item.url)}`,
      `Titolo del link nella lista: ${item.listingTitle}`,
      "",
      "=== Testo della scheda nella lista ===",
      item.listingText,
      "",
      "=== Testo della pagina di dettaglio ===",
      bodyText,
      "",
      "=== Campi letti dalle risposte JSON ===",
      JSON.stringify(jsonDetails, null, 2),
      "",
    ].join("\n"),
    "utf8",
  );
}

async function restoreResultsPage(page, item) {
  if (page.isClosed()) return;
  if (page.url() !== item.listingPageUrl) {
    await page.goBack({
      waitUntil: "domcontentloaded",
      timeout: operationTimeout(15_000, `il ritorno alla lista dopo ${item.url}`),
    }).catch(() => null);
  }
  const linkIsPresent = await findCandidateLink(page, item).then(() => true).catch(() => false);
  if (!linkIsPresent) {
    await page.goto(item.listingPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: operationTimeout(30_000, `il ripristino della lista dopo ${item.url}`),
    });
  }
}

async function extractAnnouncement(context, listPage, item) {
  ensureBudget(`la verifica dell'annuncio ${item.url}`);
  if (listPage.url() !== item.listingPageUrl) {
    const response = await listPage.goto(item.listingPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: operationTimeout(NAVIGATION_TIMEOUT_MS, `il ritorno alla lista per ${item.url}`),
    });
    await assertUsablePage(listPage, response, `la pagina risultati per ${item.url}`);
  }

  const capture = startNetworkCapture(context, item);
  let detailPage = listPage;
  let openedNewPage = false;
  try {
    const link = await findCandidateLink(listPage, item);
    const beforePages = new Set(context.pages());
    const beforeUrl = listPage.url();
    const beforeText = await listPage.locator("body").innerText().catch(() => "");
    await link.scrollIntoViewIfNeeded();
    await link.click({
      timeout: operationTimeout(15_000, `il click sul candidato ${item.url}`),
    });
    ({ detailPage, openedNewPage } = await waitForClickedDetail(
      context,
      listPage,
      beforePages,
      beforeUrl,
      beforeText,
      item,
    ));
    detailPage.setDefaultTimeout(20_000);
    await detailPage.waitForLoadState("domcontentloaded", {
      timeout: operationTimeout(10_000, `il caricamento dinamico di ${item.url}`),
    }).catch(() => {});

    let bodyText = "";
    let bodyError = null;
    try {
      bodyText = await waitForReadableDetail(detailPage, null, `l'annuncio ${item.url}`);
    } catch (error) {
      bodyError = error;
      bodyText = await detailPage.locator("body").innerText().catch(() => "");
    }
    await capture.stop();
    const jsonDetails = extractJsonDetails(capture.payloads, announcementIdFrom(item.url));
    const detailPublicationDate = publicationDateFrom(bodyText) || jsonDetails.publication_date;
    const publicationDate = detailPublicationDate || item.listingPublicationDate;

    if (!detailPublicationDate) {
      throw bodyError || new Error(`Data di pubblicazione non verificabile per l'annuncio ${item.url}.`);
    }
    if (publicationDate !== targetDate) return null;
    await saveDetailText(item, bodyText, jsonDetails).catch((error) => {
      console.warn(`Testo del dettaglio non salvato per ${item.url}: ${error.message}`);
    });

    const courtOrProcedure = courtOrProcedureFrom(bodyText);
    const creditDescription =
      creditDescriptionFrom(bodyText) || jsonDetails.credit_description || null;
    const baseAuctionPrice = baseAuctionPriceFrom(bodyText);
    const title =
      shortTitle(creditDescription) ||
      (await firstUsefulHeading(detailPage)) ||
      "Annuncio PVP";

    return {
      title: clean(title),
      credit_description: creditDescription,
      court_or_procedure: courtOrProcedure || jsonDetails.court_or_procedure || null,
      publication_date: publicationDate,
      sale_type: saleTypeFrom(bodyText),
      sale_date: saleDateFrom(bodyText) || jsonDetails.sale_date || null,
      offer_deadline: offerDeadlineFrom(bodyText) || jsonDetails.offer_deadline || null,
      base_auction_price: baseAuctionPrice || jsonDetails.base_auction_price || null,
      official_url: item.url,
      detail_verified: true,
    };
  } catch (error) {
    await capture.stop();
    try {
      error.diagnostics = await saveDiagnostics(detailPage, item, capture.responses, error);
    } catch (diagnosticError) {
      error.diagnostics_error = diagnosticError instanceof Error
        ? diagnosticError.message
        : String(diagnosticError);
    }
    throw error;
  } finally {
    if (openedNewPage && !detailPage.isClosed()) await detailPage.close().catch(() => {});
    await restoreResultsPage(listPage, item).catch(() => {});
  }
}

async function saveResult(payload) {
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  await mkdir(HISTORY_PATH, { recursive: true });
  await writeFile(OUTPUT_PATH, content, "utf8");
  // Una copia per data, così un controllo successivo non cancella i risultati precedenti.
  if (isValidIsoDate(payload.target_date)) {
    await writeFile(resolve(HISTORY_PATH, `${payload.target_date}.json`), content, "utf8");
  }
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
      const announcement = await extractAnnouncement(context, page, item);
      coverage.candidates_checked += 1;
      if (announcement) announcements.push(announcement);
    } catch (error) {
      if (error instanceof BudgetExceededError) throw error;

      coverage.complete = false;
      const retainedFromListing = item.listingPublicationDate === targetDate;
      const warning = structuredError(error, "announcement_detail_unverified", {
        official_url: item.url,
        publication_date: item.listingPublicationDate,
        detail_verified: false,
        retained_from: retainedFromListing ? "result_listing" : null,
        diagnostics: error?.diagnostics || null,
        diagnostics_error: error?.diagnostics_error || null,
      });
      announcementErrors.push(warning);
      warnings.push(warning);

      if (retainedFromListing) {
        announcements.push(extractListingAnnouncement(item));
      }

      console.warn(
        `Avviso: ${warning.message} ${retainedFromListing ? "Annuncio conservato con i soli dati della scheda risultati." : "Continuo con gli altri annunci."}`,
      );
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
  const verifiedCount = deduplicated.filter(
    (announcement) => announcement.detail_verified === true,
  ).length;
  const unverifiedDetailCount = deduplicated.length - verifiedCount;
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
      `Controllo parziale per ${targetDate}: ${deduplicated.length} annunci conservati, ${verifiedCount} con dettaglio verificato e ${unverifiedDetailCount} con dettaglio non verificato. La copertura è incompleta; un elenco vuoto non equivale a zero annunci.`,
    );
    if (errors.length > 0) process.exitCode = 1;
  } else {
    console.log(
      `Controllo completato per ${targetDate}: ${deduplicated.length} annunci verificati.`,
    );
  }
}
