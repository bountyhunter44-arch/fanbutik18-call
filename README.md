# LexiVoice – kopi af live-frontend

## Business-ombygning

Den første Business-version ligger i [`business/`](business/README.md). Start med `npm run dev:business` og åbn http://127.0.0.1:5180. Den indeholder et lokalt arbejdsrum til virksomhedsopsætning, prøvehenvendelser, bookinganmodninger og omstilling samt en separat backend-adapter til Firebase og Twilio. Versionen er ikke deployet; telefoni, AI og produktionslogin er endnu ikke tilsluttet.

Hentet fra https://lexivoice.dk/ den 8. oktober 2026.

Live-versionen er **LexiVoice Health**, dansk/grønlandsk samtalestøtte med videosamtaler. Den er ikke den tidligere beskrevne Business-startpakke til en AI-receptionist.

## Hentede filer

- `index.html`: personalevisning.
- `patient.html`: patientvisning.
- `firebase-config.js`: den offentlige Firebase-klientkonfiguration.
- `core/`: de fire JavaScript-filer, som siderne henviser til.

Filerne er kopieret fra de offentlige webadresser uden ændringer. Tailwind og Firebase SDK indlæses fortsat fra eksterne CDN'er.

## Afhængigheder og afgrænsning

Frontend henviser til Firebase-projektet `lexivoice-27fc1`, Firestore og eksisterende Cloud Functions, herunder `healthConversationSupport`.

De oprindelige webfiler bruger fortsat den eksisterende backend, hvis de serveres direkte. Brug den lokale forhåndsvisning nedenfor til udvikling. Der er ikke udført login, samtaler eller produktionsfunktioner under hentningen.

`live-snapshot.json` dokumenterer kilde-URL'er, hentetidspunkt og SHA-256 for hver fil.

Der er ikke deployet noget eller ændret noget i det eksisterende EWCP-projekt.

## Genskabt backend

De deployede kildearkiver for alle syv aktive Python 3.13-funktioner er hentet via Firebase-adgangen. Alle arkiver indeholder identiske versioner af `main.py`, `audio_buffer.py` og `requirements.txt`, som ligger i `functions/`. `backend-snapshot.json` dokumenterer kilder, generationer og filhashes.

De aktive Firestore-regler ligger i `firestore.rules`. Kildearkiverne er bevaret lokalt i `.recovery/`, som ikke uploades til GitHub. Secrets er alene registreret ved navn: `OPENAI_API_KEY`, `TURN_DOMAIN`, `TURN_USERNAME` og `TURN_PASSWORD`. Der er ikke hentet secret-værdier eller produktionsdata.

`main.py` indeholder også `on_panic_alert_created`, som ikke er blandt de syv aktive funktioner. En samlet backend-deployment vil derfor kunne tilføje en funktion. Der er ikke tilføjet en deployment-konfiguration.

## Lokal forhåndsvisning

Med Node.js 22 eller nyere:

```sh
cd lexivoice
npm run dev
```

Åbn http://127.0.0.1:5178. Serveren kræver ingen npm-afhængigheder og serverer kun de syv hentede webfiler. De oprindelige filer ændres ikke: Firebase-konfiguration, funktionsadresser og patientlinks tilpasses i hukommelsen. Lokal Firestore bruger port 8088 og Functions port 5008 med projekt-ID `demo-lexivoice`. En Content Security Policy afskærer forbindelser til produktionsbackend.

Emulatorer og Python-afhængigheder startes ikke af denne kommando. Forhåndsvisningen viser brugerfladen; fulde samtaler og AI-oversættelse er endnu ikke lokalt funktionstestet. CDN-filer til Firebase og Tailwind kræver internetadgang.

## Konstaterede begrænsninger i den hentede live-version

- Personalelogin består af en kontrol med faste brugernavne og adgangskoder i browseren. Det etablerer ikke en Firebase Auth-identitet.
- Firestore-reglerne tillader offentlig læsning og skrivning af videosessioner samt deres ICE-kandidater, transskriptioner, samtykke og auditlog.

Disse forhold er bevaret som en del af kildegrundlaget. Næste produktionsarbejde bør etablere serververificeret login og adgang til hver session, før løsningen tages videre i brug.
