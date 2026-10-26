/**
 * LexiVoice Browser Speech Recognition
 * 
 * Uses Chrome's built-in Speech Recognition API for real-time transcription.
 * Much faster than server-side processing - similar to Chrome Live Caption.
 * 
 * @module browser-speech-recognition
 */

class BrowserSpeechRecognition {
    constructor() {
        this.recognition = null;
        this.isRunning = false;
        this.sessionId = null;
        this.role = null;
        this.sourceLanguage = null;
        this.targetLanguage = null;
        this.db = null;
        
        // Callback for interim results
        this.onInterimResult = null;
        this.onFinalResult = null;
        
        // Sentence buffering with intelligent stabilization
        this.sentenceBuffer = [];
        this.pendingSentence = null; // Sentence waiting for stabilization
        this.lastFinalTime = Date.now();
        this.silenceTimer = null;
        this.stabilizeTimer = null;
        
        // Timing constants
        this.FINAL_STABILIZE_DELAY_MS = 700; // Wait for sentence to stabilize before sending
        this.JOIN_WINDOW_MS = 2000; // Window to merge related sentences
        this.MIN_SEND_LENGTH = 30; // Send after just a few words
        this.MAX_SEND_LENGTH = 120; // Don't wait for very long sentences
        
        // Continuation words that suggest sentence merging
        this.CONTINUATION_WORDS = [
            'og', 'eller', 'med', 'til', 'fra',
            'trykkende', 'brændende', 'stikkende',
            'men', 'som', 'der', 'når', 'hvis'
        ];
    }

    /**
     * Start speech recognition
     */
    async start({ sessionId, role, sourceLanguage, targetLanguage, db }) {
        if (this.isRunning) {
            console.warn("[browser-stt] Already running");
            return false;
        }

        // Check for browser support
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.error("[browser-stt] Speech Recognition not supported in this browser");
            alert("Speech Recognition ikke understøttet i denne browser. Brug Chrome.");
            return false;
        }

        this.sessionId = sessionId;
        this.role = role;
        this.sourceLanguage = sourceLanguage;
        this.targetLanguage = targetLanguage;
        this.db = db;

        // Create recognition instance
        this.recognition = new SpeechRecognition();
        
        // Configure recognition
        this.recognition.continuous = true;  // Keep listening
        this.recognition.interimResults = true;  // Get partial results
        this.recognition.lang = sourceLanguage === 'da-DK' ? 'da-DK' : 'en-US';  // Chrome doesn't support kl-GL
        this.recognition.maxAlternatives = 1;

        console.log("[browser-stt] Starting recognition for", this.recognition.lang);

        // Handle results
        this.recognition.onresult = async (event) => {
            const last = event.results.length - 1;
            const result = event.results[last];
            const transcript = result[0].transcript.trim();
            const isFinal = result.isFinal;
            const confidence = result[0].confidence;

            console.log(`[browser-stt] ${isFinal ? 'FINAL' : 'interim'}:`, transcript, `(${(confidence * 100).toFixed(0)}%)`);

            if (isFinal) {
                // Handle final transcript with intelligent merging
                if (transcript.length > 0) {
                    await this._handleFinalTranscript(transcript, confidence);
                }
            } else {
                // Show interim with buffer
                const bufferedText = this.sentenceBuffer.join(' ');
                const fullText = bufferedText + (bufferedText ? ' ' : '') + transcript;
                if (this.onInterimResult) {
                    this.onInterimResult(fullText + '...');
                }
            }
        };

        this.errorCount = 0;
        this.MAX_ERRORS = 3;

        this.recognition.onerror = (event) => {
            console.error("[browser-stt] Error:", event.error);
            if (event.error === 'no-speech') {
                console.log("[browser-stt] No speech detected, continuing...");
                this.errorCount = 0; // Reset on no-speech
            } else if (event.error === 'network') {
                this.errorCount++;
                console.error(`[browser-stt] Network error (${this.errorCount}/${this.MAX_ERRORS}) - Chrome Speech API unavailable`);
                if (this.errorCount >= this.MAX_ERRORS) {
                    console.error("[browser-stt] ❌ Too many network errors - stopping recognition");
                    this.isRunning = false;
                    alert("Chrome's talegenkendelse er ikke tilgængelig.\n\nBrug venligst manuel tekst indtil videre.");
                }
            }
        };

        this.recognition.onend = () => {
            console.log("[browser-stt] Recognition ended");
            if (this.isRunning && this.errorCount < this.MAX_ERRORS) {
                // Restart if we're supposed to be running and haven't hit error limit
                console.log("[browser-stt] Restarting recognition...");
                try {
                    this.recognition.start();
                } catch (e) {
                    console.error("[browser-stt] Failed to restart:", e);
                    this.isRunning = false;
                }
            }
        };

        // Start recognition
        try {
            this.recognition.start();
            this.isRunning = true;
            console.log("[browser-stt] ✓ Recognition started");
            return true;
        } catch (error) {
            console.error("[browser-stt] Failed to start:", error);
            return false;
        }
    }

    /**
     * Stop speech recognition
     */
    stop() {
        if (!this.isRunning) {
            return;
        }

        console.log("[browser-stt] Stopping recognition");
        this.isRunning = false;
        
        // Clear silence timer
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
        
        if (this.recognition) {
            this.recognition.stop();
            this.recognition = null;
        }
    }

    /**
     * Handle final transcript with intelligent merging
     */
    async _handleFinalTranscript(transcript, confidence) {
        const now = Date.now();
        
        // Check if this should be merged with pending sentence
        if (this.pendingSentence) {
            const timeSinceLastFinal = now - this.lastFinalTime;
            const shouldMerge = timeSinceLastFinal < this.JOIN_WINDOW_MS && 
                               this._shouldMergeSentences(this.pendingSentence, transcript);
            
            if (shouldMerge) {
                // Merge with pending sentence
                const merged = this._mergeSentences(this.pendingSentence, transcript);
                console.log(`[browser-stt] Merged with pending sentence: "${this.pendingSentence}" + "${transcript}" = "${merged}"`);
                this.pendingSentence = merged;
                
                // Clear existing stabilize timer
                if (this.stabilizeTimer) {
                    clearTimeout(this.stabilizeTimer);
                }
            } else {
                // Send pending sentence first, then handle new one
                console.log(`[browser-stt] Sending pending sentence before new one`);
                if (this.stabilizeTimer) {
                    clearTimeout(this.stabilizeTimer);
                }
                await this._sendStabilizedSentence(this.pendingSentence, confidence);
                this.pendingSentence = transcript;
            }
        } else {
            // No pending sentence, start new one
            this.pendingSentence = transcript;
        }
        
        this.lastFinalTime = now;
        
        // Show in UI immediately (before stabilization)
        if (this.onInterimResult) {
            this.onInterimResult(this.pendingSentence);
        }
        
        // Check if we should force send (too long)
        if (this.pendingSentence.length >= this.MAX_SEND_LENGTH) {
            console.log(`[browser-stt] Force sending - sentence reached ${this.pendingSentence.length} chars`);
            if (this.stabilizeTimer) {
                clearTimeout(this.stabilizeTimer);
            }
            await this._sendStabilizedSentence(this.pendingSentence, confidence);
            this.pendingSentence = null;
        } else {
            // Wait for stabilization before sending
            console.log(`[browser-stt] Waiting for stabilization (${this.FINAL_STABILIZE_DELAY_MS}ms)...`);
            this.stabilizeTimer = setTimeout(async () => {
                if (this.pendingSentence) {
                    console.log(`[browser-stt] Sending stabilized sentence: "${this.pendingSentence}"`);
                    await this._sendStabilizedSentence(this.pendingSentence, confidence);
                    this.pendingSentence = null;
                }
            }, this.FINAL_STABILIZE_DELAY_MS);
        }
    }
    
    /**
     * Check if two sentences should be merged
     */
    _shouldMergeSentences(previous, next) {
        const nextLower = next.toLowerCase();
        const firstWord = nextLower.split(' ')[0];
        
        // Check if next sentence starts with continuation word
        return this.CONTINUATION_WORDS.some(word => firstWord === word);
    }
    
    /**
     * Merge two sentences intelligently
     */
    _mergeSentences(previous, next) {
        const nextLower = next.toLowerCase();
        const firstWord = nextLower.split(' ')[0];
        
        // If next starts with continuation word, add comma before it
        if (this.CONTINUATION_WORDS.includes(firstWord)) {
            return `${previous}, ${next}`;
        }
        
        // Otherwise just join with space
        return `${previous} ${next}`;
    }
    
    /**
     * Send stabilized sentence for translation
     */
    async _sendStabilizedSentence(text, confidence) {
        if (!text || text.length === 0) return;
        
        console.log(`[browser-stt] 📤 Sending stabilized: "${text}"`);
        await this._translateAndSave(text, confidence);
    }

    /**
     * Send buffered sentences for translation (legacy - kept for compatibility)
     */
    async _sendBufferedSentences(confidence) {
        if (this.sentenceBuffer.length === 0) {
            return;
        }

        const fullText = this.sentenceBuffer.join(' ');
        console.log(`[browser-stt] Sending ${this.sentenceBuffer.length} buffered sentences:`, fullText);
        
        // Clear buffer
        this.sentenceBuffer = [];
        
        // Send for translation
        await this._translateAndSave(fullText, confidence);
    }

    /**
     * Translate text and save to Firestore
     */
    async _translateAndSave(text, confidence) {
        try {
            console.log("[browser-stt] 📤 Translating:", text);
            console.log("[browser-stt] Session:", this.sessionId);
            console.log("[browser-stt] Role:", this.role);
            console.log("[browser-stt] Lang:", this.sourceLanguage, "→", this.targetLanguage);

            // Call Firebase Function for translation
            const translateFunc = firebase.functions().httpsCallable('healthConversationSupport');
            const payload = {
                text: text,
                sourceLanguage: this.sourceLanguage === 'da-DK' ? 'da' : 'kl',
                targetLanguage: this.targetLanguage === 'kl-GL' ? 'kl' : 'da',
                speakerRole: this.role,
                sessionId: this.sessionId,
                consentToStore: false
            };
            console.log("[browser-stt] Calling function with:", payload);
            
            const result = await translateFunc(payload);
            console.log("[browser-stt] Function result:", result);
            console.log("[browser-stt] Result.data:", result.data);

            // Firebase callable functions return {data: {result: {...}}}
            if (result.data) {
                const data = result.data;
                let translatedText = "";
                
                // Try different response formats
                if (data.result && data.result.analysis) {
                    translatedText = data.result.analysis.translated_kl || data.result.analysis.translated_da;
                } else if (data.analysis) {
                    translatedText = data.analysis.translated_kl || data.analysis.translated_da;
                } else if (data.translatedText) {
                    translatedText = data.translatedText;
                }
                
                if (!translatedText) {
                    console.error("[browser-stt] Could not find translation in:", data);
                    translatedText = "Oversættelse fejlede";
                }
                
                console.log("[browser-stt] ✓ Translated:", translatedText);

                // Save to Firestore
                await this.db.collection("video_sessions")
                    .doc(this.sessionId)
                    .collection("transcripts")
                    .add({
                        originalText: text,
                        translatedText: translatedText,
                        role: this.role,
                        sourceLanguage: this.sourceLanguage,
                        targetLanguage: this.targetLanguage,
                        confidence: confidence || 0.9,
                        modelUsed: 'browser-speech-api',
                        inputMode: 'browser-stt',
                        status: 'final',
                        createdAt: firebase.firestore.FieldValue.serverTimestamp()
                    });

                console.log("[browser-stt] ✓ Saved to Firestore:", {
                    sessionId: this.sessionId,
                    role: this.role,
                    originalText: text,
                    translatedText: translatedText
                });

                if (this.onFinalResult) {
                    this.onFinalResult({
                        originalText: text,
                        translatedText: translatedText,
                        confidence: confidence
                    });
                }
            } else {
                console.error("[browser-stt] ❌ Invalid result format:", result);
            }
        } catch (error) {
            console.error("[browser-stt] ❌ Translation failed:", error);
            console.error("[browser-stt] Error details:", error.message, error.code);
        }
    }
}

// Export for use in other modules
window.BrowserSpeechRecognition = BrowserSpeechRecognition;
