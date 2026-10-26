# Backend-adapter

`index.cjs` er en separat Node 22-kodebase til Firebase Functions. Den gamle Health-kodebase ændres ikke.

Kopiér `../core.mjs` til `core.mjs` i denne mappe før pakning/deployment. Dette udføres også af `../scripts/prepare-cloud.mjs`.

Der er ikke deployet noget. Hosting og login til Business-brugerfladen er endnu ikke koblet til denne adapter. Brug ikke den lokale server som en offentligt tilgængelig service.

## Serverkonfiguration

- `LEXIVOICE_TWILIO_AUTH_TOKEN` og `LEXIVOICE_OPENAI_API_KEY`: Firebase Secrets.
- `LEXIVOICE_TWILIO_ACCOUNT_SID`: den tilsluttede Twilio-konto.
- `LEXIVOICE_OPENAI_MODEL`: en model med Responses API og structured outputs.
- `LEXIVOICE_VOICE_PUBLIC_URL`: den direkte eksterne URL til `businessVoice`, uden afsluttende skråstreg. Eksempel: `https://europe-west1-PROJECT.cloudfunctions.net/businessVoice`.

Opret server-side dokumentet `businesses/COMPANY_ID` med `ownerUid` (Firebase Auth UID), `phoneNumber` (det Twilio-nummer der modtager opkaldet, E.164), og `config` (se defaultConfig i core.mjs). Telefonnummer og ejerskab kan ikke sættes af klienten. Omstillingsnummeret skal være forskelligt fra indgangsnummeret og må ikke viderestille tilbage til LexiVoice.

Twilio Voice webhook: POST til `LEXIVOICE_VOICE_PUBLIC_URL/inbound?business=COMPANY_ID`. Adapteren returnerer dansk tale, modtager én henvendelse og kan derefter give virksomhedsoplysninger, registrere et bookingønske eller forsøge omstilling. Den er ikke en fuld samtaleagent med løbende dialog endnu. Ved booking anvendes kundens oprindelige formulering; dato og navn er endnu ikke struktureret.

Adapteren validerer Twilios signatur med det officielle SDK, konto og modtagernummer. Opkald og bookingønsker skrives i Firestore. Gentagne callbacks med samme CallSid og henvendelse genbruger svaret. Omstillingsresultatet registreres separat. AI-fejl bliver til en gemt opfølgningsbesked. Der optages ikke lyd.

`businessApi/state?business=COMPANY_ID`, `/config` og `/resolve` kræver `Authorization: Bearer FIREBASE_ID_TOKEN`. Kun virksomhedens ejer har adgang. Konfiguration ændres server-side; direkte klientskrivninger afvises i reglerne.

`../firestore.rules` er et forslag til en dedikeret Business-database, ikke en erstatning for Health-projektets regler. Reglerne er ikke emulatorverificeret endnu. Afklar en separat database/projekt eller sammenlægning af regler før deployment.

## Telefonnummer fra en mobiltelefon

Et eksisterende mobilnummer kan bruges som kundernes indgang ved at viderestille til et tilsluttet telefoninummer. Den nuværende telefons SIM eller mobilabonnement er ikke direkte tilgængeligt for denne backend. Viderestilling skal opsættes hos teleselskabet. Ingen viderestilling eller telefonikøb er foretaget.

## Udgående WhatsApp-opkald

`businessOutbound` accepterer POST med JSON og en Firebase ID-token fra virksomhedens ejer. Eksempel på body:

```json
{
  "to": "+4523456789",
  "purpose": "Jeg ringer for at følge op på din forespørgsel om EWCP.",
  "requestId": "35db833e-a312-451c-a2a9-96d37c5f609e"
}
```

URL: `https://europe-west1-PROJECT.cloudfunctions.net/businessOutbound?business=COMPANY_ID`. Brug et nyt UUID v4 pr. ønsket opkald; gentag samme UUID ved netværksgenforsøg. Et UUID kan ikke bruges til en anden modtager eller et andet formål.

Serveradministratoren skal konfigurere `whatsappSender: "whatsapp:+..."` og `whatsappCallingEnabled: true` på virksomheden. Den tilhørende sender skal være registreret og have Voice aktiveret hos Twilio/Meta. Disse felter kan ikke ændres gennem `/config` eller af Firestore-klienten.

Opkaldets `From` og `To` bruger udelukkende `whatsapp:`-adresser. Præsentationen identificerer altid LexiVoice som AI-assistent og angiver virksomhedens navn før formålet. Derefter spørger den, om modtageren kan tale. Den eksisterende enkelt-henvendelsesbehandling anvendes derefter; dette er endnu ikke en fuld, løbende samtaleagent. WhatsApp-opkald omstilles ikke til almindelige telefonnumre.

Afgrænsning: højst 20 opkaldsforsøg pr. virksomhed pr. UTC-dag, mindst 30 sekunder mellem nye forsøg, højst fem forsøg til samme WhatsApp-modtager i et rullende døgn og højst tre minutters opkald. Twilio håndhæver desuden egne begrænsninger. Et usikkert API-resultat markeres `dispatch_unknown` og genafsendes ikke automatisk.

### Modtagerens godkendelse

Opret en Twilio Content-skabelon med `twilio/call-to-action` og den enkelte action `VOICE_CALL_REQUEST`, og send den til modtageren fra den registrerede WhatsApp-afsender. Der er ikke implementeret automatisk afsendelse af godkendelsesanmodninger.

Senderens Messaging-webhook skal pege på `LEXIVOICE_VOICE_PUBLIC_URL/whatsapp-permission?business=COMPANY_ID`. Backend kontrollerer Twilio-signaturen, konto og afsender, før den registrerer `ACCEPTED` eller `REJECTED`. Et modtagent MessageSid behandles kun én gang. Godkendelser gemmes server-side i `whatsappPermissions`; et klientfelt eller en afkrydsning i brugerfladen kan ikke godkende et opkald.

Den lokale kopi udløber en godkendelse efter syv dage fra webhook-modtagelsen. Twilio/Meta er den endelige kontrol af aktuel tilladelse, herunder tilbagekaldelser og permanente tilladelser. Lokal behandling har endnu ikke en separat synkronisering af tilladelser eller garantier for rækkefølgen af forskellige godkendelseswebhooks.

### Klargøring af kontoen

Twilio-kontoen viste den 8. oktober 2026, at Trial skal opgraderes for at registrere en WhatsApp-sender. Før tilslutning kræves en betalt konto, Meta-virksomhedsverifikation, en registreret WhatsApp-sender og aktiveret Calling. Twilios vejledning angiver desuden et Meta messaging limit på mindst 2.000 business-initiated conversations pr. rullende døgn for Calling-aktivering.

Efter kontoopsætning: konfigurér den separate Business-backend og dens secrets, provisionér virksomhedens ejer, indstil Voice- og Messaging-webhooks, og gennemfør et eksplicit aftalt testopkald med en modtager, der har godkendt opkaldet. Ingen af disse produktionshandlinger er udført.

Dokumentation: [Twilio WhatsApp Business Calling](https://www.twilio.com/docs/voice/whatsapp-business-calling), [Calls API](https://www.twilio.com/docs/voice/api/call-resource), [danske TTS-stemmer](https://www.twilio.com/docs/voice/twiml/say/text-speech).

Kilder: [Twilio webhook verification](https://www.twilio.com/docs/usage/webhooks/webhooks-security), [Gather](https://www.twilio.com/docs/voice/twiml/gather), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).
