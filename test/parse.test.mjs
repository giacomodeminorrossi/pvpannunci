import assert from "node:assert/strict";
import { test } from "node:test";
import {
  courtOrProcedureFrom,
  creditDescriptionFrom,
  isAnnouncementUrl,
  isValidIsoDate,
  matchLabel,
  normalizeCreditDescription,
  publicationDateFrom,
  readLabel,
  saleOrDeadlineDateFrom,
  sanitizeOfficialUrl,
  toIsoDate,
} from "../scripts/lib/parse.mjs";

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

test("publicationDateFrom e saleOrDeadlineDateFrom leggono le date etichettate", () => {
  const text = "Data di pubblicazione: 03/10/2026\nData vendita\n06/11/2026";
  assert.equal(publicationDateFrom(text), "2026-10-03");
  assert.equal(saleOrDeadlineDateFrom(text), "2026-11-06");
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
