# PVP Annunci

Controllo automatico giornaliero degli annunci pubblicati nel Portale delle Vendite Pubbliche per la ricerca configurata relativa a **VALORI/CREDITI** entro un raggio di 25 km.

## Funzionamento

Il workflow GitHub Actions:

1. viene eseguito ogni giorno alle **16:45 UTC**;
2. installa Node.js, Playwright e Chromium;
3. apre la pagina PVP configurata con un browser reale in modalità headless;
4. segue la paginazione e apre le pagine di dettaglio;
5. conserva soltanto gli annunci la cui data di pubblicazione coincide esattamente con la data corrente in **Europe/Paris**;
6. rimuove i duplicati in base all'URL ufficiale;
7. aggiorna `data/latest.json`.

Pagina controllata:

<https://pvp.giustizia.it/pvp/it/lista_annunci.page?searchType=searchForm&page=0&size=48&sortProperty=dataPubblicazione,desc&sortAlpha=citta,asc&searchWith=Raggio%20d%27azione&codTipoLotto=VALORI/CREDITI&raggioAzione=25>

Se il sito è bloccato, indisponibile o non interpretabile, il file dati viene scritto con `status: "error"`. Un errore non viene quindi confuso con l'assenza di annunci.

## Esecuzione manuale su GitHub

1. Aprire la scheda **Actions** del repository.
2. Selezionare **Controllo giornaliero PVP**.
3. Fare clic su **Run workflow**.
4. Lasciare vuota la data per controllare oggi in Europe/Paris oppure inserire una data nel formato `YYYY-MM-DD`.

Il workflow richiede il permesso di scrittura del `GITHUB_TOKEN`. Nel repository, verificare **Settings > Actions > General > Workflow permissions** se il commit automatico viene rifiutato.

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

## Formato dei dati

`data/latest.json` contiene:

- `checked_at`: data e ora UTC del tentativo;
- `target_date`: data controllata in formato `YYYY-MM-DD`;
- `source_url`: pagina PVP configurata;
- `status`: `not_run_yet`, `success` oppure `error`;
- `error`: descrizione dell'errore, oppure `null`;
- `announcements`: annunci verificati per la data richiesta.

Per ogni annuncio vengono salvati, quando disponibili:

- `title`;
- `location`;
- `court_or_procedure`;
- `publication_date`;
- `sale_or_deadline_date`;
- `price_or_value`;
- `official_url`.

Un risultato `success` con `announcements: []` indica che il controllo è stato completato ma non sono stati trovati annunci pubblicati nella data richiesta.

## Risoluzione dei problemi

### Il workflow non riesce a eseguire il push

Verificare che GitHub Actions disponga del permesso **Read and write permissions**. Il workflow dichiara già `permissions: contents: write`.

### Il risultato ha stato `error`

Leggere il campo `error` e i log dell'esecuzione nella scheda **Actions**. Il portale potrebbe essere temporaneamente indisponibile, aver modificato la struttura HTML oppure aver limitato l'accesso automatizzato.

### Il portale mostra CAPTCHA o limitazioni

Lo scraper non tenta di aggirare CAPTCHA, controlli di accesso o altre restrizioni tecniche. In questi casi registra l'errore e termina l'esecuzione come non completata.

### La struttura del sito è cambiata

Aggiornare i selettori e le etichette in `scripts/scrape-pvp.mjs`, quindi avviare manualmente il workflow e verificare `data/latest.json`.
