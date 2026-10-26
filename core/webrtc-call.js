console.log("[webrtc-call] module loaded");

/**
 * Get public patient base URL - always use production for patient links
 */
function getPublicPatientBaseUrl() {
    const host = window.location.hostname;
    
    // If doctor is on localhost/local IP, patient link should use production
    if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host.startsWith("192.168.") ||
        host.startsWith("10.") ||
        host.startsWith("172.")
    ) {
        return "https://lexivoice-27fc1.web.app";
    }
    
    // Otherwise use current origin (production or staging)
    return window.location.origin;
}

/**
 * Build patient URL with session ID
 */
function buildPatientUrl(sessionId) {
    const baseUrl = getPublicPatientBaseUrl();
    const url = `${baseUrl}/patient.html?session=${encodeURIComponent(sessionId)}`;
    console.log("[webrtc-call] Patient public URL:", url);
    return url;
}

export class WebRTCCall {
    constructor(options = {}) {
        this.db = options.firestore;
        this.localVideoElement = document.getElementById(options.localVideoId || "localVideo");
        this.remoteVideoElement = document.getElementById(options.remoteVideoId || "remoteVideo");
        this.statusElement = document.getElementById(options.statusId || "videoCallStatus");
        
        this.peerConnection = null;
        this.localStream = null;
        this.sessionId = null;
        this.isDoctor = options.isDoctor || false;
        this.onStatusChange = options.onStatusChange || null;
        this.onPatientJoined = options.onPatientJoined || null;
        this.onPatientLeft = options.onPatientLeft || null;
        
        // Reconnect handling
        this.WEBRTC_RECONNECT_GRACE_MS = 8000;
        this.WEBRTC_QUEUE_AFTER_MS = 180000; // 3 minutes
        this.reconnectTimer = null;
        this.queueTimer = null;
        this.lastCandidateType = null; // Track if using relay/host/srflx
        this.hasEverConnected = false;
        this.disconnectStartTime = null;
        
        // Default STUN-only config (will be replaced by TURN credentials)
        this.iceServers = {
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" }
            ]
        };
    }

    async fetchTurnCredentials() {
        try {
            console.log("[webrtc] Fetching TURN credentials from Cloud Function...");
            
            const getTurnCredentials = firebase.functions().httpsCallable('getTurnCredentials');
            const result = await getTurnCredentials();
            
            if (result.data && result.data.ok && result.data.iceServers) {
                this.iceServers = { iceServers: result.data.iceServers };
                
                const stunCount = this.iceServers.iceServers.filter(s => s.urls.includes('stun')).length;
                const turnCount = this.iceServers.iceServers.filter(s => s.urls.includes('turn')).length;
                
                console.log("[webrtc] ✓ TURN credentials fetched successfully");
                console.log("[webrtc] ICE servers:", stunCount, "STUN +", turnCount, "TURN");
                
                if (turnCount === 0) {
                    console.warn("[webrtc] ⚠ No TURN servers configured - may fail on restrictive networks");
                }
                
                return true;
            } else {
                console.warn("[webrtc] TURN credentials fetch returned invalid data, using STUN fallback");
                return false;
            }
        } catch (error) {
            console.error("[webrtc] Failed to fetch TURN credentials:", error);
            console.warn("[webrtc] Falling back to STUN-only configuration");
            return false;
        }
    }

    async createSession() {
        if (!this.db) {
            this.setStatus("Fejl: Firestore ikke initialiseret");
            console.error("[webrtc] Firestore not initialized");
            return null;
        }

        try {
            // Doctor side: audio + video sendrecv
            console.log("[protocol] getUserMedia support:", !!navigator.mediaDevices?.getUserMedia);
            console.log("[protocol] RTCPeerConnection support:", !!window.RTCPeerConnection);
            console.log("[doctor] Starting session - audio + video sendrecv");
            
            this.setStatus("Starter kamera og mikrofon...");

            // Get camera and microphone for two-way communication
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user" },
                audio: true
            });

            console.log("[doctor] Camera and microphone started");
            console.log("[protocol] Local tracks:", this.localStream.getTracks().map(t => ({
                kind: t.kind,
                enabled: t.enabled,
                readyState: t.readyState
            })));

            const sessionRef = await this.db.collection("video_sessions").add({
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                status: "waiting_for_patient",
                doctorOnline: true,
                patientOnline: false,
                consentRequired: true,
                consent: {
                    accepted: false,
                    acceptedAt: null,
                    patientName: "",
                    signatureText: "",
                    verificationMethod: "",
                    consentVersion: "",
                    text: ""
                },
                journal: {
                    status: "draft",
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    summary: "",
                    notes: "",
                    symptoms: [],
                    aiFlags: []
                }
            });

            this.sessionId = sessionRef.id;
            console.log("[webrtc doctor] sessionId:", this.sessionId);
            this.setStatus("Afventer patient");

            // Fetch TURN credentials before creating peer connection
            await this.fetchTurnCredentials();

            console.log("[protocol] RTCPeerConnection config:", this.iceServers);
            const stunServers = this.iceServers.iceServers.filter(s => s.urls.includes('stun'));
            const turnServers = this.iceServers.iceServers.filter(s => s.urls.includes('turn'));
            console.log("[protocol] STUN servers (", stunServers.length, "):", stunServers.map(s => s.urls));
            console.log("[protocol] TURN servers (", turnServers.length, "):", turnServers.map(s => s.urls));
            
            this.peerConnection = new RTCPeerConnection(this.iceServers);

            // Add audio and video tracks for two-way communication
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
                console.log("[doctor] Added local track:", track.kind);
            });

            console.log("[doctor] audio + video sendrecv configured");

            this.remoteStream = new MediaStream();
            let hasReceivedVideo = false;
            let hasReceivedAudio = false;
            
            this.peerConnection.ontrack = (event) => {
                console.log("[doctor] remote track received", event.track.kind, "readyState:", event.track.readyState);
                
                // Add track directly to remote stream
                this.remoteStream.addTrack(event.track);
                
                if (event.track.kind === "video") {
                    hasReceivedVideo = true;
                    console.log("[doctor] Video track added to remote stream");
                }
                
                if (event.track.kind === "audio") {
                    hasReceivedAudio = true;
                    console.log("[doctor] Audio track added to remote stream");
                }
                
                if (this.remoteVideoElement) {
                    this.remoteVideoElement.srcObject = this.remoteStream;
                    this.remoteVideoElement.play().catch(err => {
                        console.warn("[doctor] remote video play blocked", err);
                    });
                    
                    const videoTracks = this.remoteStream.getVideoTracks();
                    const audioTracks = this.remoteStream.getAudioTracks();
                    
                    console.log("[doctor] remote stream - video tracks:", videoTracks.length, "audio tracks:", audioTracks.length);
                    
                    if (event.track.kind === "video") {
                        this.setStatus("Patientens video modtaget");
                        if (this.onPatientJoined) {
                            this.onPatientJoined();
                        }
                    }
                }
            };
            
            // Check after 5 seconds if we only have audio
            setTimeout(() => {
                if (hasReceivedAudio && !hasReceivedVideo) {
                    this.setStatus("Patientens lyd er modtaget, men kameraet sender ikke video. Bed patienten slå kamera til.");
                    console.warn("[doctor] Only audio received after 5 seconds, no video track");
                }
            }, 5000);

            this.peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log("[webrtc] caller candidate added");
                    this.db.collection("video_sessions").doc(this.sessionId)
                        .collection("callerCandidates").add({
                            candidate: event.candidate.toJSON()
                        });
                }
            };

            this.peerConnection.onconnectionstatechange = async () => {
                console.log("[protocol] connectionState:", this.peerConnection.connectionState);
                
                if (this.peerConnection.connectionState === "failed" || 
                    this.peerConnection.connectionState === "disconnected") {
                    
                    // Track disconnect start time
                    if (!this.disconnectStartTime) {
                        this.disconnectStartTime = Date.now();
                        console.log("[webrtc] Disconnect started at:", new Date(this.disconnectStartTime).toISOString());
                    }
                    
                    // Clear any existing timers
                    if (this.reconnectTimer) {
                        clearTimeout(this.reconnectTimer);
                    }
                    
                    // Show unstable message instead of immediate failure
                    const statusMsg = this.hasEverConnected 
                        ? "Forbindelsen er ustabil – forsøger at genoprette..."
                        : "Forbinder...";
                    this.setStatus(statusMsg);
                    console.warn(`[webrtc] Connection ${this.peerConnection.connectionState} - starting grace period (${this.WEBRTC_RECONNECT_GRACE_MS}ms)`);
                    
                    // Start grace period timer (8 seconds)
                    this.reconnectTimer = setTimeout(() => {
                        // Check if still disconnected/failed after grace period
                        if (this.peerConnection.connectionState === "failed" || 
                            this.peerConnection.connectionState === "disconnected") {
                            
                            console.error("[webrtc] ❌ Connection failed after grace timeout");
                            this.setStatus("Forbindelsen er ustabil. Forsøger fortsat at genoprette...");
                        }
                    }, this.WEBRTC_RECONNECT_GRACE_MS);
                    
                    // Start queue timer (3 minutes) - only if not already started
                    if (!this.queueTimer && this.hasEverConnected) {
                        console.log(`[webrtc] Starting queue timer (${this.WEBRTC_QUEUE_AFTER_MS}ms)`);
                        this.queueTimer = setTimeout(async () => {
                            // Check if still disconnected after 3 minutes
                            if (this.peerConnection.connectionState === "failed" || 
                                this.peerConnection.connectionState === "disconnected") {
                                
                                console.error("[webrtc] ❌ Connection failed after queue timeout - moving to queue");
                                await this.moveToQueue();
                            }
                        }, this.WEBRTC_QUEUE_AFTER_MS);
                    }
                    
                } else if (this.peerConnection.connectionState === "connected") {
                    // Clear all timers if we reconnected
                    if (this.reconnectTimer) {
                        clearTimeout(this.reconnectTimer);
                        this.reconnectTimer = null;
                    }
                    if (this.queueTimer) {
                        clearTimeout(this.queueTimer);
                        this.queueTimer = null;
                    }
                    
                    // Log reconnect time if we were disconnected
                    if (this.disconnectStartTime) {
                        const disconnectDuration = Date.now() - this.disconnectStartTime;
                        console.log(`[webrtc] ✓ Reconnected after ${Math.round(disconnectDuration / 1000)}s`);
                        this.disconnectStartTime = null;
                        
                        // Update session status if it was queued
                        if (this.sessionId && this.db) {
                            try {
                                await this.db.collection("video_sessions").doc(this.sessionId).update({
                                    status: "connected",
                                    "queue.resolvedAt": firebase.firestore.FieldValue.serverTimestamp()
                                });
                                console.log("[webrtc] Session status updated to connected");
                            } catch (error) {
                                console.warn("[webrtc] Could not update session status:", error);
                            }
                        }
                    }
                    
                    this.hasEverConnected = true;
                    this.setStatus("Patient tilsluttet");
                    console.log("[webrtc] Connection established");
                    
                    // Log selected candidate pair to detect TURN relay usage
                    this.peerConnection.getStats().then(stats => {
                        stats.forEach(report => {
                            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                                console.log("[webrtc] ✓ Selected candidate pair:", report);
                                
                                // Check if using relay (TURN)
                                stats.forEach(candidate => {
                                    if (candidate.type === 'local-candidate' && candidate.id === report.localCandidateId) {
                                        this.lastCandidateType = candidate.candidateType;
                                        
                                        if (candidate.candidateType === 'relay') {
                                            console.log("[webrtc] 🔄 Using TURN RELAY for connection");
                                        } else if (candidate.candidateType === 'srflx') {
                                            console.log("[webrtc] 📡 Using STUN (srflx) connection");
                                        } else if (candidate.candidateType === 'host') {
                                            console.log("[webrtc] 📡 Using direct connection (host)");
                                        } else {
                                            console.log("[webrtc] 📡 Using connection type:", candidate.candidateType);
                                        }
                                    }
                                });
                            }
                        });
                    });
                    
                    if (this.onPatientJoined) {
                        this.onPatientJoined();
                    }
                }
            };
            
            this.peerConnection.oniceconnectionstatechange = () => {
                console.log("[protocol] iceConnectionState:", this.peerConnection.iceConnectionState);
            };
            
            this.peerConnection.onicegatheringstatechange = () => {
                console.log("[protocol] iceGatheringState:", this.peerConnection.iceGatheringState);
            };

            console.log("[webrtc doctor] Creating offer");
            const offer = await this.peerConnection.createOffer();
            console.log("[protocol] SDP offer created - type:", offer.type, "sdp length:", offer.sdp.length);
            
            await this.peerConnection.setLocalDescription(offer);
            console.log("[webrtc doctor] offer created");

            console.log("[protocol] Writing SDP offer to Firestore signaling");
            await this.db.collection("video_sessions").doc(this.sessionId).update({
                offer: {
                    type: offer.type,
                    sdp: offer.sdp
                }
            });
            console.log("[webrtc doctor] offer written to Firestore");
            console.log("[protocol] Signaling: SDP offer written to video_sessions/" + this.sessionId);

            this.listenForAnswer();
            this.listenForCalleeCandidates();

            const patientUrl = buildPatientUrl(this.sessionId);
            
            return {
                sessionId: this.sessionId,
                patientUrl: patientUrl
            };

        } catch (error) {
            console.error("[webrtc-call] Error creating session:", error);
            this.setStatus("Fejl: " + error.message);
            return null;
        }
    }

    async joinSession(sessionId) {
        if (!this.db) {
            this.setStatus("Fejl: Firestore ikke initialiseret");
            console.error("[webrtc] Firestore not initialized");
            return false;
        }

        this.sessionId = sessionId;
        console.log("[webrtc patient] sessionId:", sessionId);

        try {
            this.setStatus("Starter kamera...");
            console.log("[webrtc] Requesting camera/mic permission");
            
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user" },
                audio: true
            });

            console.log("[webrtc] Camera started");
            console.log("[patient] local tracks", this.localStream.getTracks().map(t => ({
                kind: t.kind,
                enabled: t.enabled,
                readyState: t.readyState
            })));
            this.setStatus("Kamera startet");

            if (this.localVideoElement) {
                this.localVideoElement.srcObject = this.localStream;
            }

            const sessionDoc = await this.db.collection("video_sessions").doc(sessionId).get();
            
            console.log("[webrtc patient] session doc exists:", sessionDoc.exists);
            
            if (!sessionDoc.exists) {
                this.setStatus("Fejl: Session ikke fundet");
                console.error("[webrtc patient] Session not found in Firestore");
                return false;
            }

            console.log("[webrtc patient] session doc exists - checking for offer");
            const initialData = sessionDoc.data();
            console.log("[webrtc patient] initial offer present:", !!initialData?.offer);
            this.setStatus("Session fundet - venter på læge...");

            await this.db.collection("video_sessions").doc(sessionId).update({
                patientOnline: true
            });

            // Fetch TURN credentials before creating peer connection
            await this.fetchTurnCredentials();

            let timeoutId = setTimeout(() => {
                this.setStatus("Lægen har ikke startet samtalen korrekt. Bed lægen oprette et nyt link.");
                console.error("[webrtc patient] Timeout waiting for offer (12 seconds)");
            }, 12000);

            return new Promise((resolve, reject) => {
                const unsubscribe = this.db.collection("video_sessions").doc(sessionId).onSnapshot(async (snapshot) => {
                    const sessionData = snapshot.data();
                    
                    if (!sessionData?.offer) {
                        console.log("[webrtc patient] Still waiting for offer...");
                        return;
                    }

                    clearTimeout(timeoutId);
                    console.log("[webrtc patient] offer received from Firestore");

                    try {
                        console.log("[webrtc-call] Offer received, setting up connection");
                        unsubscribe();

                        this.peerConnection = new RTCPeerConnection(this.iceServers);

                        console.log("[patient] Adding local tracks to peer connection");
                        this.localStream.getTracks().forEach(track => {
                            console.log("[patient] Adding track:", track.kind, "enabled:", track.enabled, "readyState:", track.readyState);
                            this.peerConnection.addTrack(track, this.localStream);
                        });
                        
                        const videoTracks = this.localStream.getVideoTracks();
                        const audioTracks = this.localStream.getAudioTracks();
                        console.log("[patient] Total tracks being sent - video:", videoTracks.length, "audio:", audioTracks.length);

                        this.remoteStream = new MediaStream();
                        
                        this.peerConnection.ontrack = (event) => {
                            console.log("[patient] remote track received", event.track.kind, "readyState:", event.track.readyState);
                            
                            // Add track to remote stream
                            this.remoteStream.addTrack(event.track);
                            
                            if (event.track.kind === "video") {
                                console.log("[patient] Doctor video track received");
                            }
                            
                            if (event.track.kind === "audio") {
                                console.log("[patient] Doctor audio track received");
                            }
                            
                            // Set remote video element
                            if (this.remoteVideoElement) {
                                this.remoteVideoElement.srcObject = this.remoteStream;
                                this.remoteVideoElement.play().catch(err => {
                                    console.warn("[patient] remote video play blocked", err);
                                });
                                console.log("[patient] Remote stream connected to video element");
                            }
                            
                            this.setStatus("Tilsluttet til læge");
                        };

                        this.peerConnection.onicecandidate = (event) => {
                            if (event.candidate) {
                                console.log("[webrtc] callee candidate added");
                                this.db.collection("video_sessions").doc(sessionId)
                                    .collection("calleeCandidates").add({
                                        candidate: event.candidate.toJSON()
                                    });
                            }
                        };

                        this.peerConnection.onconnectionstatechange = async () => {
                            console.log("[protocol] connectionState:", this.peerConnection.connectionState);
                            
                            if (this.peerConnection.connectionState === "failed" || 
                                this.peerConnection.connectionState === "disconnected") {
                                
                                // Track disconnect start time
                                if (!this.disconnectStartTime) {
                                    this.disconnectStartTime = Date.now();
                                    console.log("[webrtc] Disconnect started at:", new Date(this.disconnectStartTime).toISOString());
                                }
                                
                                // Clear any existing timers
                                if (this.reconnectTimer) {
                                    clearTimeout(this.reconnectTimer);
                                }
                                
                                // Show unstable message instead of immediate failure
                                const statusMsg = this.hasEverConnected 
                                    ? "Forbindelsen er ustabil – forsøger at genoprette..."
                                    : "Forbinder...";
                                this.setStatus(statusMsg);
                                console.warn(`[webrtc] Connection ${this.peerConnection.connectionState} - starting grace period (${this.WEBRTC_RECONNECT_GRACE_MS}ms)`);
                                
                                // Start grace period timer (8 seconds)
                                this.reconnectTimer = setTimeout(() => {
                                    // Check if still disconnected/failed after grace period
                                    if (this.peerConnection.connectionState === "failed" || 
                                        this.peerConnection.connectionState === "disconnected") {
                                        
                                        console.error("[webrtc] ❌ Connection failed after grace timeout");
                                        this.setStatus("Forbindelsen er ustabil. Forsøger fortsat at genoprette...");
                                    }
                                }, this.WEBRTC_RECONNECT_GRACE_MS);
                                
                                // Start queue timer (3 minutes) - only if not already started
                                if (!this.queueTimer && this.hasEverConnected) {
                                    console.log(`[webrtc] Starting queue timer (${this.WEBRTC_QUEUE_AFTER_MS}ms)`);
                                    this.queueTimer = setTimeout(async () => {
                                        // Check if still disconnected after 3 minutes
                                        if (this.peerConnection.connectionState === "failed" || 
                                            this.peerConnection.connectionState === "disconnected") {
                                            
                                            console.error("[webrtc] ❌ Connection failed after queue timeout - moving to queue");
                                            await this.moveToQueue();
                                        }
                                    }, this.WEBRTC_QUEUE_AFTER_MS);
                                }
                                
                            } else if (this.peerConnection.connectionState === "connected") {
                                // Clear all timers if we reconnected
                                if (this.reconnectTimer) {
                                    clearTimeout(this.reconnectTimer);
                                    this.reconnectTimer = null;
                                }
                                if (this.queueTimer) {
                                    clearTimeout(this.queueTimer);
                                    this.queueTimer = null;
                                }
                                
                                // Log reconnect time if we were disconnected
                                if (this.disconnectStartTime) {
                                    const disconnectDuration = Date.now() - this.disconnectStartTime;
                                    console.log(`[webrtc] ✓ Reconnected after ${Math.round(disconnectDuration / 1000)}s`);
                                    this.disconnectStartTime = null;
                                    
                                    // Update session status if it was queued
                                    if (this.sessionId && this.db) {
                                        try {
                                            await this.db.collection("video_sessions").doc(this.sessionId).update({
                                                status: "connected",
                                                "queue.resolvedAt": firebase.firestore.FieldValue.serverTimestamp()
                                            });
                                            console.log("[webrtc] Session status updated to connected");
                                        } catch (error) {
                                            console.warn("[webrtc] Could not update session status:", error);
                                        }
                                    }
                                }
                                
                                this.hasEverConnected = true;
                                this.setStatus("Forbindelse oprettet");
                                console.log("[webrtc] Connection established");
                                
                                // Log selected candidate pair
                                this.peerConnection.getStats().then(stats => {
                                    stats.forEach(report => {
                                        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                                            stats.forEach(candidate => {
                                                if (candidate.type === 'local-candidate' && candidate.id === report.localCandidateId) {
                                                    this.lastCandidateType = candidate.candidateType;
                                                    console.log("[webrtc] Using connection type:", candidate.candidateType);
                                                }
                                            });
                                        }
                                    });
                                });
                            }
                        };

                        this.setStatus("Modtager offer...");
                        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sessionData.offer));
                        console.log("[webrtc] Remote description set");

                        this.setStatus("Opretter svar...");
                        const answer = await this.peerConnection.createAnswer();
                        await this.peerConnection.setLocalDescription(answer);
                        console.log("[webrtc] Answer created");

                        this.setStatus("Sender svar til læge...");
                        await this.db.collection("video_sessions").doc(sessionId).update({
                            answer: {
                                type: answer.type,
                                sdp: answer.sdp
                            }
                        });
                        console.log("[webrtc patient] answer written to Firestore");

                        this.listenForCallerCandidates();

                        this.setStatus("Forbinder...");
                        console.log("[webrtc] Joined session", sessionId);
                        
                        resolve(true);
                    } catch (error) {
                        console.error("[webrtc-call] Error in snapshot handler:", error);
                        this.setStatus("Fejl: " + error.message);
                        reject(error);
                    }
                });
            });

        } catch (error) {
            console.error("[webrtc-call] Error joining session:", error);
            this.setStatus("Fejl: " + error.message);
            return false;
        }
    }

    listenForAnswer() {
        console.log("[webrtc doctor] Listening for answer from patient");
        console.log("[protocol] Signaling: Listening for SDP answer on video_sessions/" + this.sessionId);
        this.db.collection("video_sessions").doc(this.sessionId).onSnapshot(async (snapshot) => {
            const data = snapshot.data();
            if (data?.answer && !this.peerConnection.currentRemoteDescription) {
                console.log("[webrtc doctor] answer received from Firestore");
                console.log("[protocol] SDP answer received - type:", data.answer.type, "sdp length:", data.answer.sdp.length);
                const answerDescription = new RTCSessionDescription(data.answer);
                await this.peerConnection.setRemoteDescription(answerDescription);
                console.log("[webrtc doctor] Answer applied to peer connection");
                console.log("[protocol] Signaling: SDP answer applied");
            }
        });
    }

    listenForCallerCandidates() {
        console.log("[webrtc] Listening for caller candidates");
        console.log("[protocol] Signaling: Listening for ICE candidates on callerCandidates subcollection");
        this.db.collection("video_sessions").doc(this.sessionId)
            .collection("callerCandidates").onSnapshot((snapshot) => {
                snapshot.docChanges().forEach(async (change) => {
                    if (change.type === "added") {
                        const data = change.doc.data();
                        console.log("[webrtc] caller candidate applied");
                        console.log("[protocol] ICE candidate read from Firestore:", data.candidate.candidate?.substring(0, 50) + "...");
                        await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
                    }
                });
            });
    }

    listenForCalleeCandidates() {
        console.log("[webrtc] Listening for callee candidates");
        console.log("[protocol] Signaling: Listening for ICE candidates on calleeCandidates subcollection");
        this.db.collection("video_sessions").doc(this.sessionId)
            .collection("calleeCandidates").onSnapshot((snapshot) => {
                snapshot.docChanges().forEach(async (change) => {
                    if (change.type === "added") {
                        const data = change.doc.data();
                        console.log("[webrtc] callee candidate applied");
                        console.log("[protocol] ICE candidate read from Firestore:", data.candidate.candidate?.substring(0, 50) + "...");
                        await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
                    }
                });
            });
    }

    async moveToQueue() {
        console.log("[webrtc] Moving session to queue after prolonged disconnect");
        
        if (!this.sessionId || !this.db) {
            console.error("[webrtc] Cannot queue - no session ID or database");
            return;
        }
        
        try {
            const patientUrl = buildPatientUrl(this.sessionId);
            
            await this.db.collection("video_sessions").doc(this.sessionId).update({
                status: "queued_reconnect",
                "queue.reason": "network_disconnect",
                "queue.queuedAt": firebase.firestore.FieldValue.serverTimestamp(),
                "queue.keepSession": true,
                "queue.reconnectUrl": patientUrl,
                "queue.reconnectAttempts": firebase.firestore.FieldValue.increment(1)
            });
            
            console.log("[webrtc] Session moved to queue successfully");
            
            // Show appropriate message based on role
            if (this.isDoctor) {
                this.setStatus("Patienten er sat i kø til genopkobling. Samme link kan bruges igen.");
            } else {
                this.setStatus("Der er desværre opstået en teknisk afbrydelse i samtalen.\n\nDu mister ikke din plads. Vi har sat dig tilbage i køen til samme konsultation.\n\nBliv venligst på linjen. Vi forsøger automatisk at genoprette forbindelsen.\n\nHvis vi ikke kan fuldføre videosamtalen i dag, kontakter vi dig telefonisk.");
            }
            
            // Add audit log
            await this.db.collection("video_sessions").doc(this.sessionId).collection("audit").add({
                event: "session_queued",
                reason: "network_disconnect",
                role: this.isDoctor ? "doctor" : "patient",
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
            
        } catch (error) {
            console.error("[webrtc] Failed to move session to queue:", error);
        }
    }

    async endCall() {
        console.log("[webrtc-call] Ending call");
        
        // Clear all timers
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.queueTimer) {
            clearTimeout(this.queueTimer);
            this.queueTimer = null;
        }

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        if (this.localVideoElement) {
            this.localVideoElement.srcObject = null;
        }

        if (this.remoteVideoElement) {
            this.remoteVideoElement.srcObject = null;
        }

        if (this.sessionId && this.db) {
            try {
                if (this.isDoctor) {
                    await this.db.collection("video_sessions").doc(this.sessionId).delete();
                } else {
                    await this.db.collection("video_sessions").doc(this.sessionId).update({
                        patientOnline: false
                    });
                }
            } catch (error) {
                console.error("[webrtc-call] Error cleaning up session:", error);
            }
        }

        this.setStatus("Samtale afsluttet");
    }

    setStatus(message) {
        if (this.statusElement) {
            this.statusElement.textContent = message;
        }
        if (this.onStatusChange) {
            this.onStatusChange(message);
        }
        console.log("[webrtc-call] Status:", message);
    }
}
