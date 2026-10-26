/**
 * LexiVoice Audio Translation Stream - VPS WebSocket Version
 * 
 * Real-time binary audio streaming to VPS server via WebSocket.
 * Audio chunks are transient and must not be persisted without explicit consent.
 * 
 * Features:
 * - WebSocket binary audio streaming to wss://lexiws.madkontrollen.dk/ws/audio
 * - State machine for reliable recording
 * - Voice Activity Detection (VAD)
 * - Manual MediaRecorder flush for complete audio chunks
 * - Memory cleanup
 * - Firestore transcript sync
 * 
 * @module audio-translation-stream
 */

// State machine states
const StreamState = {
    IDLE: 'idle',
    STARTING: 'starting',
    RECORDING: 'recording',
    SENDING: 'sending',
    RECONNECTING: 'reconnecting',
    FAILED: 'failed',
    STOPPED: 'stopped'
};

class AudioTranslationStream {
    constructor() {
        this.mediaRecorder = null;
        this.state = StreamState.IDLE;
        this.sessionId = null;
        this.role = null;
        this.sourceLanguage = null;
        this.targetLanguage = null;
        this.stream = null;
        this.chunkInterval = 2000; // 2 seconds for faster response
        this.flushTimer = null; // Timer for manual chunk flushing
        this.db = null;
        
        // Statistics
        this.stats = {
            chunksProcessed: 0,
            chunksFailed: 0,
            chunksSkipped: 0,
            reconnectCount: 0,
            totalLatency: 0
        };
        
        // Voice Activity Detection
        this.audioContext = null;
        this.analyser = null;
        this.dataArray = null;
        this.vadThreshold = 0.02; // RMS threshold for voice detection (0-1) - higher to reduce noise
        this.silenceThreshold = 1000; // 1 second of silence triggers send - faster response
        this.lastVoiceTime = null;
        this.silenceTimer = null;
        this.audioBuffer = [];
        
        // Cleanup tracking
        this.objectUrls = [];
        
        // WebSocket connection for VPS audio streaming
        this.ws = null;
        this.wsUrl = "wss://lexiws.madkontrollen.dk/ws/audio";
        this.wsReady = false;
        this.pendingChunks = [];
        
        // Callback for transcript received
        this.onTranscriptReceived = null;
    }

    /**
     * Start audio translation stream
     * @param {Object} config
     * @param {string} config.sessionId - Firestore session ID
     * @param {string} config.role - "doctor" or "patient"
     * @param {string} config.sourceLanguage - "da-DK" or "kl-GL"
     * @param {string} config.targetLanguage - "kl-GL" or "da-DK"
     * @param {MediaStream} config.stream - Audio stream from getUserMedia
     * @param {Object} config.db - Firestore database instance
     */
    async start({ sessionId, role, sourceLanguage, targetLanguage, stream, db }) {
        if (this.state === StreamState.RECORDING || this.state === StreamState.STARTING) {
            console.warn("[audio-stream] Already recording, state:", this.state);
            return false;
        }

        if (!sessionId || !role || !sourceLanguage || !targetLanguage || !stream || !db) {
            console.error("[audio-stream] Missing required parameters");
            this.state = StreamState.FAILED;
            return false;
        }

        this.state = StreamState.STARTING;
        this.sessionId = sessionId;
        this.role = role;
        this.sourceLanguage = sourceLanguage;
        this.targetLanguage = targetLanguage;
        this.db = db;

        try {
            // Check for MediaRecorder support
            if (!window.MediaRecorder) {
                console.error("[audio-stream] MediaRecorder not supported");
                this.state = StreamState.FAILED;
                throw new Error("MediaRecorder not supported in this browser");
            }

            // Clone the stream to avoid conflicts with WebRTC peer connection
            const clonedStream = stream.clone();
            this.stream = clonedStream;
            console.log("[audio-stream] Audio stream cloned for MediaRecorder");

            // Determine supported MIME type
            const mimeType = this._getSupportedMimeType();
            console.log("[audio-stream] Using MIME type:", mimeType);

            // Setup Web Audio API for Voice Activity Detection
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = this.audioContext.createMediaStreamSource(clonedStream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 2048;
            this.analyser.smoothingTimeConstant = 0.8;
            source.connect(this.analyser);
            
            const bufferLength = this.analyser.frequencyBinCount;
            this.dataArray = new Uint8Array(bufferLength);
            
            console.log("[audio-stream] Voice Activity Detection enabled");
            
            this.mediaRecorder = new MediaRecorder(clonedStream, {
                mimeType: mimeType,
                audioBitsPerSecond: 16000 // 16kbps for speech
            });

            this.mediaRecorder.ondataavailable = async (event) => {
                if (!event.data || event.data.size < 1000) {
                    return;
                }
                
                // Voice activity detection
                const hasVoice = this._detectVoiceActivity();
                
                if (hasVoice) {
                    console.log("[audio-stream] Voice detected! Chunk size:", event.data.size);
                    this.lastVoiceTime = Date.now();
                    
                    // Clear any pending silence timer
                    if (this.silenceTimer) {
                        clearTimeout(this.silenceTimer);
                        this.silenceTimer = null;
                    }
                    
                    // Add to buffer
                    this.audioBuffer.push(event.data);
                    
                    // Start silence detection timer
                    this.silenceTimer = setTimeout(() => {
                        this._onSilenceDetected();
                    }, this.silenceThreshold);
                    
                } else {
                    console.log("[audio-stream] No voice detected, skipping chunk (size:", event.data.size, ")");
                    this.stats.chunksSkipped++;
                    return;
                }
                
                // Chunks are now buffered, will be sent on silence detection
            };

            this.mediaRecorder.onerror = (event) => {
                console.error("[audio-stream] MediaRecorder error:", event.error);
                this.state = StreamState.FAILED;
                this.stop();
            };

            this.mediaRecorder.onstart = () => {
                console.log("[audio-stream] Recorder started");
                this.state = StreamState.RECORDING;
                
                // Connect WebSocket
                this._connectWebSocket();
                
                // Start manual flush timer for complete audio chunks
                this.flushTimer = setInterval(() => {
                    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
                        console.log("[audio-stream] requestData flush");
                        this.mediaRecorder.requestData();
                    }
                }, this.chunkInterval);
                console.log("[audio-stream] Manual flush timer started, interval:", this.chunkInterval, "ms");
            };

            this.mediaRecorder.onstop = () => {
                console.log("[audio-stream] Recorder stopped");
                this.state = StreamState.STOPPED;
                
                // Clear flush timer
                if (this.flushTimer) {
                    clearInterval(this.flushTimer);
                    this.flushTimer = null;
                    console.log("[audio-stream] Manual flush timer cleared");
                }
            };

            // Start recording without time slices (manual flush via requestData)
            this.mediaRecorder.start();
            console.log("[audio-stream] Recording started for", role, sourceLanguage, "->", targetLanguage);
            console.log("[audio-stream] Using manual flush with interval:", this.chunkInterval, "ms");
            
            return true;

        } catch (error) {
            console.error("[audio-stream] Failed to start:", error);
            this.state = StreamState.FAILED;
            return false;
        }
    }

    /**
     * Stop audio translation stream with full cleanup
     */
    async stop() {
        console.log("[audio-stream] Stopping, state:", this.state);
        
        // Clear flush timer first
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
            console.log("[audio-stream] Flush timer cleared in stop()");
        }
        
        // Close WebSocket
        if (this.ws) {
            try {
                this.ws.close();
                console.log("[audio-stream] WebSocket closed");
            } catch (error) {
                console.error("[audio-stream] Error closing WebSocket:", error);
            }
            this.ws = null;
        }
        
        if (this.mediaRecorder && this.state === StreamState.RECORDING) {
            try {
                this.mediaRecorder.stop();
            } catch (error) {
                console.error("[audio-stream] Error stopping recorder:", error);
            }
        }

        // No more abort controllers needed for WebSocket

        // Close AudioContext
        if (this.audioContext) {
            try {
                this.audioContext.close();
                this.audioContext = null;
                this.analyser = null;
                this.dataArray = null;
            } catch (e) {
                console.error("[audio-stream] Error closing AudioContext:", e);
            }
        }

        // Revoke object URLs to prevent memory leaks
        this.objectUrls.forEach(url => {
            try {
                URL.revokeObjectURL(url);
            } catch (e) {
                // Ignore revoke errors
            }
        });
        this.objectUrls = [];

        // Log statistics
        console.log("[audio-stream] Statistics:", {
            processed: this.stats.chunksProcessed,
            failed: this.stats.chunksFailed,
            skipped: this.stats.chunksSkipped,
            reconnects: this.stats.reconnectCount,
            avgLatency: this.stats.chunksProcessed > 0 
                ? (this.stats.totalLatency / this.stats.chunksProcessed).toFixed(0) + 'ms'
                : 'N/A'
        });

        // Reset state
        this.mediaRecorder = null;
        this.state = StreamState.STOPPED;
        this.sessionId = null;
        this.role = null;
        this.sourceLanguage = null;
        this.targetLanguage = null;
        this.stream = null;
    }

    /**
     * Connect to VPS WebSocket server
     * @private
     */
    _connectWebSocket() {
        try {
            console.log("[audio-stream] Connecting to WebSocket:", this.wsUrl);
            
            this.ws = new WebSocket(this.wsUrl);
            this.ws.binaryType = "arraybuffer";
            
            this.ws.onopen = () => {
                console.log("[audio-stream] websocket connected");
                
                // Send session metadata
                const metadata = {
                    type: "metadata",
                    sessionId: this.sessionId,
                    role: this.role,
                    sourceLanguage: this.sourceLanguage,
                    targetLanguage: this.targetLanguage
                };
                this.ws.send(JSON.stringify(metadata));
                console.log("[audio-stream] sent metadata:", metadata);
                
                // Mark as ready after metadata sent
                this.wsReady = true;
                
                // Send any pending chunks
                if (this.pendingChunks.length > 0) {
                    console.log(`[audio-stream] Sending ${this.pendingChunks.length} pending chunks`);
                    this.pendingChunks.forEach(chunk => {
                        this.ws.send(chunk);
                    });
                    this.pendingChunks = [];
                }
            };
            
            this.ws.onmessage = (event) => {
                console.log("[audio-stream] websocket response", event.data);
                
                try {
                    const data = JSON.parse(event.data);
                    
                    if (data.originalText || data.translatedText) {
                        console.log("[audio-stream] transcript received", data);
                        
                        // Transcript is already written to Firestore by VPS server
                        // UI will update via Firestore listener
                        this.stats.chunksProcessed++;
                        
                        // Call callback if set
                        if (this.onTranscriptReceived) {
                            console.log("[audio-stream] calling onTranscriptReceived callback");
                            this.onTranscriptReceived(data);
                        }
                    }
                    
                } catch (err) {
                    console.error("[audio-stream] Failed to parse websocket message:", err);
                }
            };
            
            this.ws.onerror = (err) => {
                console.error("[audio-stream] websocket error", err);
                this.stats.chunksFailed++;
            };
            
            this.ws.onclose = () => {
                console.log("[audio-stream] websocket disconnected");
                this.ws = null;
                this.wsReady = false;
                this.pendingChunks = [];
            };
            
        } catch (error) {
            console.error("[audio-stream] Failed to connect WebSocket:", error);
        }
    }

    /**
     * Handle silence detection - send buffered audio
     * @private
     */
    async _onSilenceDetected() {
        console.log("[audio-stream] Silence detected after speech, sending buffered audio");
        
        if (this.audioBuffer.length === 0) {
            console.log("[audio-stream] No audio buffered, skipping");
            return;
        }
        
        try {
            // Combine all buffered chunks into one blob
            const combinedBlob = new Blob(this.audioBuffer, { type: this.mimeType });
            console.log(`[audio-stream] Sending ${this.audioBuffer.length} buffered chunks (${combinedBlob.size} bytes)`);
            
            // Send via WebSocket
            if (this.ws && this.ws.readyState === WebSocket.OPEN && this.wsReady) {
                this.ws.send(combinedBlob);
                console.log("[audio-stream] Buffered audio sent");
                this.stats.chunksProcessed++;
            } else {
                console.warn("[audio-stream] WebSocket not ready, buffering for later");
                this.pendingChunks.push(combinedBlob);
            }
            
            // Clear buffer
            this.audioBuffer = [];
            
        } catch (error) {
            console.error("[audio-stream] Failed to send buffered audio:", error);
        }
    }

    /**
     * Detect voice activity using RMS analysis
     * @private
     * @returns {boolean} True if voice detected
     */
    _detectVoiceActivity() {
        if (!this.analyser || !this.dataArray) {
            return true; // If VAD not available, assume voice
        }
        
        // Get time domain data
        this.analyser.getByteTimeDomainData(this.dataArray);
        
        // Calculate RMS (Root Mean Square) of audio signal
        let sum = 0;
        for (let i = 0; i < this.dataArray.length; i++) {
            const normalized = (this.dataArray[i] - 128) / 128; // Normalize to -1 to 1
            sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / this.dataArray.length);
        
        // Check if RMS exceeds threshold
        const hasVoice = rms > this.vadThreshold;
        
        if (hasVoice) {
            console.log("[audio-stream] VAD: Voice detected (RMS:", rms.toFixed(4), ")");
        }
        
        return hasVoice;
    }

    /**
     * Get supported MIME type for MediaRecorder
     * @private
     */
    _getSupportedMimeType() {
        // Priority order: webm with opus codec
        const types = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4'
        ];

        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                console.log("[audio-stream] Selected MIME type:", type);
                return type;
            }
        }

        console.warn("[audio-stream] No supported MIME type found, letting browser choose");
        return ''; // Let browser choose
    }

    // Firebase callable chunk upload removed - using WebSocket binary streaming to VPS

    /**
     * Write transcript to Firestore (deprecated - backend writes directly now)
     * @private
     */
    async _writeTranscript({ originalText, translatedText, confidence, status }) {
        try {
            await this.db.collection("video_sessions")
                .doc(this.sessionId)
                .collection("transcripts")
                .add({
                    role: this.role,
                    sourceLanguage: this.sourceLanguage,
                    targetLanguage: this.targetLanguage,
                    originalText: originalText,
                    translatedText: translatedText,
                    inputMode: "audio-chunk",
                    confidence: confidence,
                    status: status,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });

            console.log("[translation] Transcript written to Firestore");

        } catch (error) {
            console.error("[translation] Failed to write transcript:", error);
            throw error;
        }
    }

    /**
     * Get current statistics
     * @returns {Object} Statistics object
     */
    getStats() {
        return {
            ...this.stats,
            state: this.state,
            wsConnected: this.ws?.readyState === WebSocket.OPEN,
            avgLatency: this.stats.chunksProcessed > 0 
                ? Math.round(this.stats.totalLatency / this.stats.chunksProcessed)
                : 0
        };
    }

    /**
     * Get current state
     * @returns {string} Current state
     */
    getState() {
        return this.state;
    }
}

/**
 * Send manual translation
 * @param {Object} config
 * @param {string} config.sessionId
 * @param {string} config.role - "doctor" or "patient"
 * @param {string} config.sourceLanguage
 * @param {string} config.targetLanguage
 * @param {string} config.text
 * @param {Object} config.db - Firestore instance
 */
async function sendManualTranslation({ sessionId, role, sourceLanguage, targetLanguage, text, db }) {
    if (!sessionId || !role || !text || !db) {
        throw new Error("Missing required parameters");
    }

    console.log("[translation] Sending manual translation:", { role, sourceLanguage, targetLanguage });

    try {
        // Call translation backend
        const result = await translateText({
            sessionId,
            role,
            sourceLanguage,
            targetLanguage,
            text
        });

        // Write to Firestore
        await db.collection("video_sessions")
            .doc(sessionId)
            .collection("transcripts")
            .add({
                role: role,
                sourceLanguage: sourceLanguage,
                targetLanguage: targetLanguage,
                originalText: text,
                translatedText: result.translatedText || "",
                inputMode: "manual",
                confidence: result.confidence || null,
                status: "final",
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

        console.log("[translation] Manual transcript written");
        return result;

    } catch (error) {
        console.error("[translation] Manual translation failed:", error);
        throw error;
    }
}

/**
 * Translate text using backend
 * @private
 */
async function translateText({ sessionId, role, sourceLanguage, targetLanguage, text }) {
    try {
        // Map language codes
        const sourceLang = sourceLanguage === "da-DK" ? "da" : "kl";
        const targetLang = targetLanguage === "kl-GL" ? "kl" : "da";

        // Call existing healthConversationSupport function
        const response = await fetch('https://us-central1-lexivoice-27fc1.cloudfunctions.net/healthConversationSupport', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                data: {
                    text: text,
                    sourceLanguage: sourceLang,
                    targetLanguage: targetLang,
                    speakerRole: role,
                    sessionId: sessionId,
                    consentToStore: false
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Translation failed: ${response.status}`);
        }

        const result = await response.json();
        console.log("[translation] Backend result:", result);

        // Parse different response formats
        let translatedText = "";
        let confidence = null;

        if (result.result?.analysis) {
            // Format from healthConversationSupport
            if (targetLang === "kl") {
                translatedText = result.result.analysis.translated_kl || "";
            } else {
                translatedText = result.result.analysis.translated_da || "";
            }
            confidence = result.result.analysis.confidence || null;
        } else if (result.translatedText) {
            translatedText = result.translatedText;
        } else if (result.translation) {
            translatedText = result.translation;
        }

        return {
            originalText: text,
            translatedText: translatedText || "Oversættelse fejlede",
            confidence: confidence
        };

    } catch (error) {
        console.error("[translation] Translation request failed:", error);
        throw error;
    }
}

// Export for use in HTML
window.AudioTranslationStream = AudioTranslationStream;
window.StreamState = StreamState;
window.sendManualTranslation = sendManualTranslation;
