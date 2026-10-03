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

const targetDate = process.env.TARGET_DATE || "2026-09-28";

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
  "data\\s+(?:della\\s+)?vendita",
  "termine\\s+presentazione\\s+offerte",
  "scadenza\\s+offerte",
  "data\\s+asta",
  "prezzo\\s+base(?:\\s+d['’]asta)?",
  "offerta\\s+minima",
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
  "documenti",
  "allegati",
];

function matchLabel(line, label) {
  return line.match(new RegExp(`^${label}\\s*(?::|-)?\\s*(.*)$`, "i"));
}

function readLabelBlock(text, labels, stopLabels) {
  const lines = linesOf(text);

  for (let index = 0; index < lines.length; index += 1) {
    for (const label of labels) {
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

function creditDescriptionFrom(text) {
  return readLabelBlock(text, CREDIT_DESCRIPTION_LABELS, FIELD_BOUNDARY_LABELS);
}

function baseAuctionPriceFrom(text) {
  return readLabel(text, [
    "prezzo\\s+base\\s+d['’]asta",
    "prezzo\\s+base",
    "base\\s+d['’]asta",
  ]);
}

function publicationDateFrom(text) {
  const labeled = readLabel(text, [
    "data\\s+di\\s+pubblicazione",
    "data\\s+pubblicazione",
    "pubblicato\\s+il",
    "pubblicato\\s+sul\\s+portale\\s+il",
  ]);
  const labeledDate = toIsoDate(labeled);
  if (labeledDate) return labeledDate;

  const inline = String(text || "").match(
    /(?:data\s+(?:di\s+)?pubblicazione|pubblicato\s+(?:sul\s+portale\s+)?il)[^\d]{0,30}(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4})/i,
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

function announcementIdFrom(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("idAnnuncio") || parsed.searchParams.get("idInserzione");
  } catch {
    return null;
  }
}

function sanitizeOfficialUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== "pvp.giustizia.it") return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/auth|authorization|cookie|csrf|jwt|key|password|secret|session|token/i.test(key)) {
        url.searchParams.delete(key);
      }
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
    .replace(/[\u0300-\u036f]/g, "")
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

function jsonLooksPertinent(value, item, responseUrl) {
  const entries = scalarEntries(value);
  const identifier = announcementIdFrom(item.url);
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
  return {
    pertinent: Boolean(hasIdentifier || (endpointMatches && hasRelevantKeys)),
    entries,
  };
}

function extractJsonDetails(payloads) {
  const entries = payloads.flatMap((payload) => scalarEntries(payload));
  const publicationDate = toIsoDate(
    firstJsonValue(entries, [
      "dataPubblicazione",
      "dataPubblicazionePortale",
      "publicationDate",
      "pubblicatoIl",
    ]),
  );
  const courtOrProcedure = unique([
    firstJsonValue(entries, ["tribunale", "ufficioGiudiziario"]),
    firstJsonValue(entries, ["numeroProcedura", "procedura", "registroGenerale", "rg"]),
  ]).join(" - ");

  return {
    title: firstJsonValue(entries, ["descrizioneLotto", "descrizione", "titolo", "tipologia"]),
    credit_description: firstJsonValue(entries, [
      "descrizioneCredito",
      "descrizioneLotto",
      "descrizioneBene",
      "lotDescription",
      "descrizione",
    ]),
    court_or_procedure: courtOrProcedure || null,
    publication_date: publicationDate,
    sale_or_deadline_date: toIsoDate(
      firstJsonValue(entries, [
        "dataVendita",
        "dataDellaVendita",
        "terminePresentazioneOfferte",
        "scadenzaOfferte",
        "dataAsta",
      ]),
    ),
    base_auction_price: firstJsonValue(entries, [
      "prezzoBaseAsta",
      "prezzoBaseDasta",
      "prezzoBase",
      "baseAuctionPrice",
    ]),
  };
}

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
                .filter((key) => !/auth|cookie|csrf|jwt|password|secret|session|token/i.test(key))
                .slice(0, 50)
            : [];
        const match = jsonLooksPertinent(json, item, safeUrl);
        summary.pertinent = match.pertinent;
        if (match.pertinent) payloads.push(json);
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
      ({ stabilityMs }) => {
        const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const blocked =
          /captcha|accesso negato|access denied|forbidden|temporaneamente non disponibile|service unavailable|richiesta non autorizzata/i.test(
            bodyText,
          );
        const hasPublicationDate =
          /data\s+(?:di\s+)?pubblicazione|pubblicato\s+(?:sul\s+portale\s+)?il/i.test(bodyText);
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

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!clean(bodyText)) throw new Error(`Pagina vuota o illeggibile per ${context}.`);
  if (looksBlocked(bodyText)) {
    throw new Error(`Il sito PVP ha bloccato o interrotto l'accesso per ${context}.`);
  }
  return bodyText;
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
          /data\s+(?:di\s+)?pubblicazione|pubblicato\s+(?:sul\s+portale\s+)?il/i.test(text)
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

function procedureReferenceFrom(text) {
  const number = readLabel(text, [
    "n[°ºo]\\s*procedura",
    "numero procedura",
    "registro generale",
    "r\\.?g\\.?",
  ]);
  const year = readLabel(text, ["anno procedura"]);
  if (number && year && !number.includes(year)) return `${number}/${year}`;
  return number || readLabel(text, ["procedura"]) || null;
}

function extractListingAnnouncement(item) {
  const listingText = item.listingText;
  const courtOrProcedure = unique([
    readLabel(listingText, ["tribunale", "ufficio giudiziario"]),
    procedureReferenceFrom(listingText),
  ]).join(" - ");

  const saleOrDeadlineDate =
    toIsoDate(
      readLabel(listingText, [
        "data vendita",
        "data della vendita",
        "termine presentazione offerte",
        "scadenza offerte",
        "data asta",
      ]),
    ) || null;

  const title =
    item.listingTitle ||
    readLabel(listingText, ["descrizione lotto", "descrizione", "tipologia"]) ||
    null;

  return {
    title: title ? clean(title) : null,
    credit_description: creditDescriptionFrom(listingText),
    court_or_procedure: courtOrProcedure || null,
    publication_date: item.listingPublicationDate,
    sale_or_deadline_date: saleOrDeadlineDate,
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
    const count = await links.count();
    for (let index = 0; index < count; index += 1) {
      const link = links.nth(index);
      const href = await link.getAttribute("href");
      if (!href) continue;
      try {
        const normalized = new URL(href, page.url());
        normalized.hash = "";
        if (normalized.toString() === item.url) return link;
      } catch {
        // Ignora href non interpretabili.
      }
    }
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
  return page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("script, noscript").forEach((element) => element.remove());
    clone.querySelectorAll("input[type='hidden']").forEach((element) => {
      element.removeAttribute("value");
    });
    clone.querySelectorAll("*").forEach((element) => {
      for (const attribute of [...element.attributes]) {
        if (/auth|cookie|csrf|jwt|password|secret|session|token/i.test(attribute.name)) {
          element.removeAttribute(attribute.name);
        }
      }
    });
    return `<!doctype html>\n${clone.outerHTML}`;
  });
}

async function saveDiagnostics(page, item, networkResponses, error) {
  const id = announcementIdFrom(item.url) || `candidate-${Date.now()}`;
  const directory = resolve(DIAGNOSTICS_PATH, id.replace(/[^a-zA-Z0-9_-]/g, "_"));
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
    const jsonDetails = extractJsonDetails(capture.payloads);
    const detailPublicationDate = publicationDateFrom(bodyText) || jsonDetails.publication_date;
    const publicationDate = detailPublicationDate || item.listingPublicationDate;

    if (!detailPublicationDate) {
      throw bodyError || new Error(`Data di pubblicazione non verificabile per l'annuncio ${item.url}.`);
    }
    if (publicationDate !== targetDate) return null;

    const courtOrProcedure = unique([
      readLabel(bodyText, ["tribunale", "ufficio giudiziario"]),
      procedureReferenceFrom(bodyText),
    ]).join(" - ");
    const saleOrDeadlineDate = toIsoDate(
      readLabel(bodyText, [
        "data vendita",
        "data della vendita",
        "termine presentazione offerte",
        "scadenza offerte",
        "data asta",
      ]),
    );
    const creditDescription = creditDescriptionFrom(bodyText);
    const baseAuctionPrice = baseAuctionPriceFrom(bodyText);
    const title =
      readLabel(bodyText, ["descrizione lotto", "descrizione", "tipologia"]) ||
      jsonDetails.title ||
      (await firstUsefulHeading(detailPage)) ||
      item.listingTitle ||
      item.listingText ||
      "Annuncio PVP";

    return {
      title: clean(title),
      credit_description: creditDescription || jsonDetails.credit_description || null,
      court_or_procedure: courtOrProcedure || jsonDetails.court_or_procedure || null,
      publication_date: publicationDate,
      sale_or_deadline_date: saleOrDeadlineDate || jsonDetails.sale_or_deadline_date || null,
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
