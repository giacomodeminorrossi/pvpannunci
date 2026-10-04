# PVP Annunci

Controllo automatico giornaliero degli annunci pubblicati nel Portale delle Vendite Pubbliche per la ricerca configurata relativa a **VALORI/CREDITI** entro un raggio di 25 km.

## Funzionamento

Il workflow GitHub Actions:

1. viene avviato alle **21:07 e 22:07 UTC**; un controllo iniziale lo esegue solo se a Parigi sono tra le 23:00 e le 06:59 (con orario estivo o invernale uno dei due trigger cade sempre alle 23:07 locali). Tra le 00:00 e le 06:59 controlla la data del giorno precedente; se quella data è già stata controllata con successo, il secondo trigger viene saltato;
2. installa Node.js, Playwright e Chromium;
3. apre la pagina PVP configurata con un browser reale in modalità headless;
4. segue la paginazione (ordinata per data di pubblicazione) fino alla prima pagina con soli annunci più vecchi e apre le pagine di dettaglio dei candidati;
5. conserva soltanto gli annunci la cui data di pubblicazione coincide con la data target;
6. rimuove i duplicati in base all'URL ufficiale;
7. aggiorna `data/latest.json` e ne salva una copia in `data/history/YYYY-MM-DD.json`;
8. apre una **issue** nel repository per gli annunci non ancora notificati (GitHub invia un'email a chi segue il repository) e li registra in `data/notified-ids.json`.

Pagina controllata:

<https://pvp.giustizia.it/pvp/it/lista_annunci.page?searchType=searchForm&page=0&size=48&sortProperty=dataPubblicazione,desc&sortAlpha=citta,asc&searchWith=Raggio%20d%27azione&codTipoLotto=VALORI/CREDITI&raggioAzione=25>

Se il sito è bloccato, indisponibile o non interpretabile, il file dati viene scritto con `status: "partial"` e il dettaglio in `errors`/`warnings`. Un errore non viene quindi confuso con l'assenza di annunci. In caso di errori bloccanti il workflow termina in errore, e GitHub lo segnala via email.

## Esecuzione manuale su GitHub

1. Aprire la scheda **Actions** del repository.
2. Selezionare **Controllo giornaliero PVP**.
3. Fare clic su **Run workflow**.
4. Lasciare vuota la data per controllare oggi in Europe/Paris oppure inserire una data nel formato `YYYY-MM-DD`.

L'esecuzione manuale serve anche a recuperare un giorno il cui controllo è fallito: basta indicarne la data.

Il workflow richiede i permessi di scrittura del `GITHUB_TOKEN` su contenuti e issue. Nel repository, verificare **Settings > Actions > General > Workflow permissions** se il commit automatico viene rifiutato.

## Esecuzione locale

Requisiti: Node.js 20 o successivo.

```bash
npm install
npx playwright install chromium
npm run scrape
```

Per controllare una data specifica:

```bash
TARGET_DATE=2026-10-03 npm run scrape
```

Il fuso orario usato per determinare la data predefinita è sempre `Europe/Paris`.

Test delle funzioni di interpretazione del testo (non richiedono Playwright):

```bash
npm test
```

## Formato dei dati

`data/latest.json` (e la copia in `data/history/`) contiene:

- `checked_at`: data e ora UTC del tentativo;
- `target_date`: data controllata in formato `YYYY-MM-DD`;
- `source_url`: pagina PVP configurata;
- `status`: `success` se la copertura è completa e senza avvisi, altrimenti `partial`;
- `error`: riepilogo del problema, oppure `null`;
- `errors`: errori bloccanti (codice e messaggio);
- `warnings`: avvisi non bloccanti, per esempio pagine o dettagli non verificati;
- `coverage`: pagine controllate, annunci visti, candidati trovati e verificati, motivo di arresto e se la copertura è `complete`. Contiene anche `pages` (per ogni pagina: numero di annunci, data più recente e più vecchia, annunci senza data, ordine decrescente rispettato), `site_newest_date` (annuncio più recente in prima pagina) e, se la prima pagina è stata ricaricata perché sospetta, `first_page_reloads`;
- `announcement_errors`: dettagli che non è stato possibile verificare, con il riferimento alla diagnostica salvata come artifact dell'esecuzione;
- `announcements`: annunci pubblicati nella data richiesta.

Per ogni annuncio vengono salvati, quando disponibili:

- `title`: inizio della descrizione (il PVP non espone un titolo vero e proprio);
- `credit_description`: campo "Descrizione" del lotto (il PVP può troncarlo);
- `asset_descriptions`: descrizioni della sezione "Beni inclusi nel lotto", spesso più complete;
- `court_or_procedure`;
- `publication_date`;
- `sale_type`: tipo di vendita, per esempio `Competitiva`;
- `sale_date`: data della vendita, con l'ora quando indicata (`YYYY-MM-DD` oppure `YYYY-MM-DDTHH:MM`);
- `offer_deadline`: termine per la presentazione delle offerte, nello stesso formato;
- `base_auction_price`;
- `official_url`;
- `detail_verified`: `false` se l'annuncio è stato conservato con i soli dati della lista risultati.

Un risultato `success` con `announcements: []` indica che il controllo è stato completato ma non sono stati trovati annunci pubblicati nella data richiesta.

### Controlli di coerenza

La ricerca si ferma alla prima pagina che contiene solo annunci più vecchi della data cercata, quindi dipende dall'ordine dei risultati. Per questo lo scraper:

- ricarica fino a due volte la prima pagina se contiene solo annunci più vecchi della data cercata, oppure se il suo annuncio più recente è più vecchio di quello visto nel controllo precedente (in un controllo di prova il PVP ha restituito una volta come pagina 1 il contenuto di una pagina successiva);
- segnala `first_page_older_than_previous_run` se l'anomalia persiste dopo i ricaricamenti;
- segnala `result_order_unexpected` se le date non sono in ordine decrescente, dentro una pagina o tra pagine consecutive.

In entrambi i casi lo stato è `partial`: un elenco vuoto non va letto come assenza di annunci.

## Risoluzione dei problemi

### Il workflow non riesce a eseguire il push

Verificare che GitHub Actions disponga del permesso **Read and write permissions**. Il workflow dichiara già `permissions: contents: write`.

### Il risultato ha stato `error`

Leggere il campo `error` e i log dell'esecuzione nella scheda **Actions**. Il portale potrebbe essere temporaneamente indisponibile, aver modificato la struttura HTML oppure aver limitato l'accesso automatizzato.

### Il portale mostra CAPTCHA o limitazioni

Lo scraper non tenta di aggirare CAPTCHA, controlli di accesso o altre restrizioni tecniche. In questi casi registra l'errore e termina l'esecuzione come non completata.

### La struttura del sito è cambiata

Aggiornare le etichette in `scripts/lib/parse.mjs` (con i relativi test in `test/`) o i selettori in `scripts/scrape-pvp.mjs`, quindi avviare manualmente il workflow e verificare `data/latest.json`.
