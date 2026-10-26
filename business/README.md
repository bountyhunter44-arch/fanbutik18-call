# LexiVoice Business

Første lokale Business-version af LexiVoice: arbejdsrum, virksomhedsopsætning, henvendelser, bookinganmodninger og omstillingsforløb. Den eksisterende Health-version er bevaret.

Start fra projektroden med `npm run dev:business`, eller fra denne mappe med `npm run dev`. Åbn http://127.0.0.1:5180. Node 22+ kræves; lokale funktioner kræver ingen installerede pakker eller internetadgang.

## Det virker lokalt

- Gem virksomhedsnavn, velkomst, virksomhedsviden og et valideret omstillingsnummer.
- Afprøv henvendelser via tekst: booking, medarbejder, information og beskeder.
- Se henvendelser, filtrer booking og opfølgning, markér behandlet.
- Opsætning og de seneste 200 prøveopkald gemmes atomisk i `.local/state.json`. Denne mappe skal ikke deles eller uploades.
- Lokal simulering bruger regler, ingen AI eller rigtige telefonopkald. Omstilling udføres ikke lokalt. Booking er en anmodning, ingen kalenderreservation.
- WhatsApp-opkald: angiv modtager og formål, og se præsentationen: “Hej, jeg er LexiVoice, en AI-assistent, og jeg ringer på vegne af EWCP Virksomhedsplatform.” Dette er en forhåndsvisning, som ikke ringer til modtageren.

## Backend til rigtige opkald

Se [cloud/README.md](cloud/README.md): separat Firebase-kodebase til Twilio, AI-fortolkning, opkaldsjournal og ejerbaseret adgang. API-nøgler og telefoniforbindelse er ikke konfigureret. Adapteren er ikke deployet eller afprøvet mod eksterne tjenester. Login og produktionsfrontend mangler tilkobling.

Udgående opkald bruger WhatsApp Business Calling. Den almindelige Voice-forbindelse bruges fortsat til indgående telefonopkald. Backend kræver en aktiveret WhatsApp-afsender og en registreret godkendelse fra modtageren, før den forsøger at ringe. Opkaldsstatus og afsendelse med samme requestId håndteres, så genforsøg ikke automatisk skaber et nyt opkald.

Kontrollen af Twilio-kontoen den 8. oktober 2026 viste Trial-status og en besked om, at kontoen skal opgraderes for at registrere en WhatsApp-afsender. Der blev ikke foretaget opgradering, registrering, beskedafsendelse eller opkald.

For at klargøre kildepakken: `node scripts/prepare-cloud.mjs`. Installér cloud-afhængigheder i `cloud/` før deployment. En Firebase-deployment-konfiguration er bevidst endnu ikke tilføjet, da eksisterende Health-regler og -funktioner kræver særskilt afklaring.

## Kontrol

`npm test` tester intentioner, bookingstatus, omstillingsmål, XML-escaping og AI-format via en stub. Det erstatter ikke en rigtig test med telefoni, AI, Firebase Auth eller Firestore-emulatorer.
