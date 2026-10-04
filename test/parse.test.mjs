import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  courtOrProcedureFrom,
  creditDescriptionFrom,
  extractJsonDetails,
  isAnnouncementUrl,
  isValidIsoDate,
  matchLabel,
  normalizeCreditDescription,
  publicationDateFrom,
  readLabel,
  baseAuctionPriceFrom,
  offerDeadlineFrom,
  saleDateFrom,
  saleTypeFrom,
  sanitizeOfficialUrl,
  shortTitle,
  toIsoDate,
  toIsoDateTime,
} from "../scripts/lib/parse.mjs";

// Testo reale della pagina di dettaglio PVP (annuncio 4639634), senza i referenti.
const DETAIL_TEXT = readFileSync(new URL("./fixtures/detail-4639634.txt", import.meta.url), "utf8");

test("toIsoDate converte date italiane e rifiuta date inesistenti", () => {
  assert.equal(toIsoDate("Pubblicato il 3/10/2026"), "2026-10-03");
  assert.equal(toIsoDate("03.10.2026"), "2026-10-03");
  assert.equal(toIsoDate("31/02/2026"), null);
  assert.equal(toIsoDate(""), null);
});

test("isValidIsoDate accetta solo YYYY-MM-DD validi", () => {
  assert.equal(isValidIsoDate("2026-10-03"), true);
  assert.equal(isValidIsoDate("2026-02-30"), false);
  assert.equal(isValidIsoDate("2026-1-3"), false);
});

test("readLabel rispetta la priorità delle etichette, non l'ordine delle righe", () => {
  const text = "Descrizione\nTesto generico\nDescrizione lotto: Credito IVA";
  assert.equal(readLabel(text, ["descrizione\\s+lotto", "descrizione"]), "Credito IVA");
});

test("readLabel legge il valore sulla riga successiva", () => {
  assert.equal(readLabel("Tribunale\nTribunale di ROMA", ["tribunale"]), "Tribunale di ROMA");
});

test("matchLabel richiede la fine della parola", () => {
  assert.equal(matchLabel("Procedurale: x", "procedura"), null);
  assert.equal(matchLabel("Rgxyz", "r\\.?g\\.?"), null);
  assert.ok(matchLabel("R.G. 150/2017", "r\\.?g\\.?"));
});

test("normalizeCreditDescription sistema gli spazi attorno alla punteggiatura", () => {
  assert.equal(normalizeCreditDescription("prezzo , base ( x )"), "prezzo, base (x )");
  assert.equal(normalizeCreditDescription("fine.Inizio"), "fine. Inizio");
  assert.equal(normalizeCreditDescription("RG123 n.150/2017"), "RG123 n.150/2017");
});

test("creditDescriptionFrom unisce le righe fino all'etichetta successiva", () => {
  const text = [
    "Descrizione credito",
    "Cessione pro soluto del credito IVA",
    "Valore nominale euro 20.163,23 .",
    "Prezzo base d'asta: 9.736,00 €",
  ].join("\n");
  assert.equal(
    creditDescriptionFrom(text),
    "Cessione pro soluto del credito IVA Valore nominale euro 20.163,23.",
  );
});

test("toIsoDateTime conserva l'ora quando presente", () => {
  assert.equal(toIsoDateTime("05/11/2026 13:00"), "2026-11-05T13:00");
  assert.equal(toIsoDateTime("06/11/2026"), "2026-11-06");
  assert.equal(toIsoDateTime("06/11/2026 ore 9.30"), "2026-11-06T09:30");
});

test("shortTitle accorcia la descrizione a fine parola", () => {
  assert.equal(shortTitle("Credito IVA"), "Credito IVA");
  const title = shortTitle("parola ".repeat(40));
  assert.ok(title.length <= 100);
  assert.ok(title.endsWith("parola…"));
  assert.equal(shortTitle(""), null);
});

test("pagina di dettaglio reale: tutti i campi", () => {
  assert.equal(publicationDateFrom(DETAIL_TEXT), "2026-10-03");
  assert.equal(saleDateFrom(DETAIL_TEXT), "2026-11-06T12:00");
  assert.equal(offerDeadlineFrom(DETAIL_TEXT), "2026-11-05T13:00");
  assert.equal(saleTypeFrom(DETAIL_TEXT), "Competitiva");
  assert.equal(baseAuctionPriceFrom(DETAIL_TEXT), "9.736,00 €");
  assert.equal(courtOrProcedureFrom(DETAIL_TEXT), "Tribunale di ROMA - 150/2017");
  const description = creditDescriptionFrom(DETAIL_TEXT);
  assert.ok(description.startsWith("Cessione pro soluto, in lotto unico, del credito IVA"));
  assert.ok(description.endsWith("all'avviso di vendita allegato."));
  assert.equal(
    shortTitle(description),
    "Cessione pro soluto, in lotto unico, del credito IVA del Fallimento Nugeco Immobiliare s.r.l. n.…",
  );
});

test("normalizeCreditDescription separa importi e frasi attaccati dal sito", () => {
  assert.equal(
    normalizeCreditDescription(
      "così composto:credito IVA già chiesto a rimborsoEuro 111.059,00credito IVA riportato",
    ),
    "così composto: credito IVA già chiesto a rimborso Euro 111.059,00 credito IVA riportato",
  );
  assert.equal(
    normalizeCreditDescription("IMPORTO CREDITO: € 3.151,50I CREDITI VENGONO"),
    "IMPORTO CREDITO: € 3.151,50 I CREDITI VENGONO",
  );
  assert.equal(
    normalizeCreditDescription("CREDITO IVA € 150.451,75.La documentazione"),
    "CREDITO IVA € 150.451,75. La documentazione",
  );
  assert.equal(normalizeCreditDescription("( R.G. n. 26/2018)"), "(R.G. n. 26/2018)");
});

test("i campi con '-' sono considerati vuoti", () => {
  const text = "N° Procedura\n26\nAnno Procedura\n2018\nTribunale\n-\nLotto nr.\nLOTTO UNICO";
  assert.equal(courtOrProcedureFrom(text), "26/2018");
});

test("extractJsonDetails usa solo il record dell'annuncio richiesto", () => {
  const payload = {
    content: [
      { idAnnuncio: 4639634, tribunale: "Tribunale di ROMA", prezzoBase: "9736" },
      { idAnnuncio: 4637201, tribunale: "Tribunale di MILANO", prezzoBase: "60000" },
    ],
  };
  const details = extractJsonDetails([payload], "4637201");
  assert.equal(details.court_or_procedure, "Tribunale di MILANO");
  assert.equal(details.base_auction_price, "60000");
});

test("courtOrProcedureFrom combina tribunale e numero procedura", () => {
  const text = "Tribunale: Tribunale di ROMA\nNumero procedura: 150\nAnno procedura: 2017";
  assert.equal(courtOrProcedureFrom(text), "Tribunale di ROMA - 150/2017");
});

test("URL degli annunci: riconoscimento e pulizia", () => {
  const url = "https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio=1&token=x#top";
  assert.equal(isAnnouncementUrl(url), true);
  assert.equal(isAnnouncementUrl("https://example.com/detail_annuncio?idAnnuncio=1"), false);
  assert.equal(
    sanitizeOfficialUrl(url),
    "https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio=1",
  );
});
