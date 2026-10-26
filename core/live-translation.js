export class LiveTranslationEngine {
    constructor(options = {}) {
        this.sourceLanguage = options.sourceLanguage || "kl";
        this.targetLanguage = options.targetLanguage || "da";
        this.role = options.role || "patient"; // "doctor" or "patient"

        this.leftContainer = document.getElementById(options.leftContainerId || "sourceTranscript");
        this.rightContainer = document.getElementById(options.rightContainerId || "translatedTranscript");

        this.sessionId = options.sessionId || crypto.randomUUID();
        this.messages = [];
        this.latestEntry = null;
    }

    async handleIncomingPatientText({ text, sessionId, sourceLanguage = "kl-GL" }) {
        if (!text?.trim()) {
            console.warn("[translation] Empty text received, skipping");
            return null;
        }

        console.log("[translation] transcript received:", text.substring(0, 50) + "...");
        console.log("[translation] sending to healthConversationSupport");

        try {
            const result = await this.processTranscript({
                text,
                speakerRole: "patient",
                sourceLanguage: sourceLanguage.split("-")[0], // "kl-GL" -> "kl"
                targetLanguage: this.targetLanguage,
                consentToStore: false
            });

            console.log("[translation] result received");
            console.log("[translation] render updated");

            return result;
        } catch (error) {
            console.error("[translation] Failed to process incoming patient text:", error);
            
            const fallback = {
                id: crypto.randomUUID(),
                originalText: text,
                translatedText: "Oversættelse kunne ikke gennemføres",
                sourceLanguage,
                targetLanguage: this.targetLanguage,
                severity: "red",
                confidence: 0,
                speakerRole: "patient",
                analysis: null,
                createdAt: Date.now()
            };

            this.latestEntry = fallback;
            this.renderEntry(fallback);

            return fallback;
        }
    }

    async processTranscript({
        text,
        speakerRole = "patient",
        sourceLanguage = this.sourceLanguage,
        targetLanguage = this.targetLanguage,
        consentToStore = false
    }) {
        if (!text?.trim()) return null;

        const payload = {
            data: {
                text,
                sourceLanguage,
                targetLanguage,
                speakerRole,
                sessionId: this.sessionId,
                consentToStore
            }
        };

        try {
            const response = await fetch(
                "https://us-central1-lexivoice-27fc1.cloudfunctions.net/healthConversationSupport",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(payload)
                }
            );

            const json = await response.json();
            const result = json?.result || json?.data || json;
            const analysis = result?.analysis || result;

            if (!response.ok || result?.ok === false) {
                throw new Error(result?.error || json?.error?.message || "Translation request failed");
            }

            const translatedText = this.pickTranslation(analysis, targetLanguage);
            const confidence = Number(analysis?.confidence ?? 0.85);
            const severity = this.resolveSeverity(analysis, confidence);

            const entry = {
                id: crypto.randomUUID(),
                originalText: text,
                translatedText,
                sourceLanguage,
                targetLanguage,
                speakerRole,
                severity,
                confidence,
                analysis,
                createdAt: Date.now()
            };

            this.messages.push(entry);
            this.latestEntry = entry;
            this.renderEntry(entry);

            return entry;
        } catch (error) {
            console.error("[Lexivoice] translation failed", error);

            const fallback = {
                id: crypto.randomUUID(),
                originalText: text,
                translatedText: "Oversættelse fejlede",
                sourceLanguage,
                targetLanguage,
                severity: "red",
                confidence: 0,
                speakerRole,
                analysis: null,
                createdAt: Date.now()
            };

            this.latestEntry = fallback;
            this.renderEntry(fallback);

            return fallback;
        }
    }

    pickTranslation(analysis, targetLanguage) {
        if (targetLanguage === "da") {
            return analysis?.translated_da || analysis?.translated_text || "";
        }

        if (targetLanguage === "kl") {
            return analysis?.translated_kl || analysis?.translated_text || "";
        }

        return (
            analysis?.translatedText ||
            analysis?.translation ||
            analysis?.translated ||
            analysis?.translated_text ||
            ""
        );
    }

    resolveSeverity(analysis, confidence) {
        if (analysis?.urgent_assessment_needed) {
            return "red";
        }

        if (confidence < 0.7) {
            return "yellow";
        }

        return "green";
    }

    getLatestTranslation(language = "da") {
        const entry = this.latestEntry;
        if (!entry) {
            return "";
        }

        if (language === "da") {
            return entry.analysis?.translated_da || (entry.targetLanguage === "da" ? entry.translatedText : "") || "";
        }

        if (language === "kl") {
            return entry.analysis?.translated_kl || (entry.targetLanguage === "kl" ? entry.translatedText : "") || "";
        }

        return entry.translatedText || "";
    }

    renderEntry(entry) {
        if (!this.leftContainer || !this.rightContainer) {
            console.warn("[Lexivoice] containers missing");
            return;
        }

        const leftBubble = document.createElement("div");
        leftBubble.className = `lexi-bubble ${entry.severity}`;

        leftBubble.innerHTML = `
            <div class="lexi-role">
                ${entry.speakerRole === "patient" ? "Patient" : "Læge"}
            </div>

            <div class="lexi-language">
                ${entry.sourceLanguage.toUpperCase()}
            </div>

            <div class="lexi-text">
                ${this.escapeHtml(entry.originalText)}
            </div>
        `;

        const rightBubble = document.createElement("div");
        rightBubble.className = `lexi-bubble ${entry.severity}`;

        rightBubble.innerHTML = `
            <div class="lexi-role">
                Oversættelse
            </div>

            <div class="lexi-language">
                ${entry.targetLanguage.toUpperCase()}
            </div>

            <div class="lexi-text">
                ${this.escapeHtml(entry.translatedText)}
            </div>

            <div class="lexi-confidence">
                Sikkerhed: ${Math.round(entry.confidence * 100)}%
            </div>
        `;

        this.leftContainer.prepend(leftBubble);
        this.rightContainer.prepend(rightBubble);
    }

    clear() {
        this.messages = [];
        this.latestEntry = null;

        if (this.leftContainer) {
            this.leftContainer.innerHTML = "";
        }

        if (this.rightContainer) {
            this.rightContainer.innerHTML = "";
        }
    }

    renderDoctorTranscript({ originalText, translatedText, confidence, modelUsed }) {
        if (!this.leftContainer || !this.rightContainer) {
            console.warn("[Lexivoice] containers missing");
            return;
        }

        console.log("[Lexivoice] renderDoctorTranscript:", { originalText, translatedText, confidence });

        // For doctor view:
        // Left container = Greenlandic translation (to patient)
        // Right container = Danish original (from doctor)

        const severity = confidence >= 0.7 ? "green" : "yellow";

        // Left bubble - Greenlandic translation
        const leftBubble = document.createElement("div");
        leftBubble.className = `lexi-bubble ${severity}`;

        leftBubble.innerHTML = `
            <div class="lexi-role">
                Til patient
            </div>

            <div class="lexi-language">
                KL
            </div>

            <div class="lexi-text">
                ${this.escapeHtml(translatedText || "Oversættelse mangler")}
            </div>

            <div class="lexi-confidence">
                Sikkerhed: ${Math.round(confidence * 100)}% (${modelUsed})
            </div>
        `;

        // Right bubble - Danish original
        const rightBubble = document.createElement("div");
        rightBubble.className = `lexi-bubble ${severity}`;

        rightBubble.innerHTML = `
            <div class="lexi-role">
                Fra læge
            </div>

            <div class="lexi-language">
                DA
            </div>

            <div class="lexi-text">
                ${this.escapeHtml(originalText || "Ingen tale genkendt")}
            </div>
        `;

        this.leftContainer.prepend(leftBubble);
        this.rightContainer.prepend(rightBubble);
    }

    escapeHtml(text = "") {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}
